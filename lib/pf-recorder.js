// ==== pf-recorder v2 BEGIN ====
// 解析失败记录器（各解析站共用同一份代码：allfeedback/shared/pf-recorder.js 是原件，改动后用 shared/pf-sync.mjs 同步到各站）
// v2：不再写共用的 FEEDBACK_KV（那个 KV 还存着 DeepSeek 的账号和聊天，额度不能被它吃掉），
//     改为每次失败往 D1 数据库 parse_log（绑定名 PARSE_DB，建表见 allfeedback/shared/parse_log.sql）插一行 ok=0 的记录；
//     allfeedback「解析失败」视图直接对 parse_log 做 GROUP BY 统计。不记 IP、设备（这些列留空）。
// - 只记真正的失败：5xx，或 2xx 但返回里写着失败（ok:false / code 不是 0、200）。4xx（输入不对、人机验证、频控、
//   次数用完）不记；报错文字属于这些情况的也兜底跳过。
// - 链接和报错文字里出现的链接都只留能定位作品的参数（去掉 xsec_token、share_token、sign 等令牌）。
// - 写入在 waitUntil 里跑、最多等 10 秒、所有异常吞掉：绝不拖慢、也绝不影响解析接口本身的响应。没绑 D1 就什么都不做。
// - 开关：环境变量 PARSE_LOG_OFF=1 时完全不写。
// - 预览部署（<分支或哈希>.<项目>.pages.dev）不提供解析：直接返回 403，免得预览地址变成没有人机验证的公开解析接口。
//   确实要在预览里测解析，给预览环境加变量 PARSE_ON_PREVIEW=1。
const PF_WRITE_TIMEOUT_MS = 10000;
const PF_URL_MAX = 300;
const PF_MSG_MAX = 160;
// 链接里只保留能定位作品的参数，其余（xsec_token、share_token、sign、timestamp、uid…）一律去掉
const PF_KEEP_PARAMS = new Set(['v', 'p', 'id', 'vid', 'bvid', 'aid', 'aweme_id', 'modal_id', 'item_id', 'photoid', 'list', 'index']);
// 兜底：即使是 5xx / ok:false，报错文字属于这些情况也不算解析失败
const PF_SKIP_RE = /人机验证|解析太频繁|操作太频繁|今日解析次数|今天的解析次数|请先粘贴|只支持|不像|不是.{0,6}链接|没找到有效的链接|没有找到链接|访问受限|预览环境/;
const PF_URL_RE = /https?:\/\/[^\s"'<>\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+/gi;

function pfDay(ms) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function pfCleanOne(raw) {
  raw = String(raw || '').replace(/[),.;!?\]}>»」』】，。；：？！）、]+$/, '');
  let u;
  try { u = new URL(raw); } catch { return ''; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  u.username = '';
  u.password = '';
  u.hash = '';
  const keep = new URLSearchParams();
  for (const [k, v] of u.searchParams) if (PF_KEEP_PARAMS.has(k.toLowerCase()) && v.length <= 64) keep.append(k, v);
  const qs = keep.toString();
  u.search = qs ? '?' + qs : '';
  return u.toString().slice(0, PF_URL_MAX);
}
// 文字里的第一个链接，清理后返回；没有就返回空串
function pfCleanUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>]+/i);
  return m ? pfCleanOne(m[0]) : '';
}
// 报错文字里出现的所有链接都清理一遍（上游报错经常把请求地址连同令牌一起带出来），再压空白、限长
function pfScrub(text, max) {
  const s = String(text == null ? '' : text).replace(PF_URL_RE, (m) => {
    const tail = (m.match(/[),.;!?\]}>»」』】，。；：？！）、]+$/) || [''])[0];
    const c = pfCleanOne(m);
    return (c || '[链接]') + tail;
  });
  return s.replace(/\s+/g, ' ').trim().slice(0, max || PF_MSG_MAX);
}
function pfClassify(status, msg) {
  const m = String(msg || '');
  const hm = m.match(/(?:HTTP|状态码|status)\s*[:：=]?\s*(\d{3})(?!\d)/i);
  const up = hm ? Number(hm[1]) : 0;
  let code = 'other';
  if (/未配置|not configured/i.test(m)) code = 'config';
  else if (status === 504 || /超时|timed? ?out|timeout|abort/i.test(m)) code = 'timeout';
  else if (up === 429 || up === 402 || /额度|积分|余额|quota|rate.?limit|too many requests|credit|balance/i.test(m)) code = 'upstream_quota';
  else if (up === 404 || /未找到|没找到|找不到|不存在|已删除|私密|无法获取|没有(?:找到)?(?:可下载的?)?(?:视频|图片|作品|内容|媒体)|no (?:video|media)|not found|unavailable|private/i.test(m)) code = 'no_media';
  else if (up) code = 'upstream_http';
  else if (/fetch failed|network|网络|连接|ECONN|DNS|TLS|SSL|socket/i.test(m)) code = 'network';
  else if (/JSON|Unexpected token|格式异常|返回异常|结构/i.test(m)) code = 'bad_upstream';
  else if (/^(?:Error|TypeError|ReferenceError|RangeError|SyntaxError)\b|is not a function|is not defined|of undefined|of null/.test(m)) code = 'exception';
  return { code, up };
}
// 返回里写着失败吗（TikTok 成功 code=0，微博成功 code=200）
function pfBodyFailed(status, body) {
  return status >= 300 || !!(body && typeof body === 'object' && (body.ok === false || (typeof body.code === 'number' && body.code !== 0 && body.code !== 200)));
}
async function pfInput(request) {
  const u = new URL(request.url);
  let s = u.searchParams.get('url') || u.searchParams.get('text') || '';
  if (!s && request.method === 'POST' && Number(request.headers.get('content-length') || 0) <= 65536) {
    try {
      const b = await request.clone().json();
      if (b && typeof b === 'object') s = String(b.url || b.link || b.text || '');
    } catch {}
  }
  return String(s).slice(0, 2000);
}
function pfFlag(v) {
  return /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());
}
// 预览部署：Pages 的 <哈希或分支>.<项目>.pages.dev（生产是 <项目>.pages.dev 或自定义域名）
function pfIsPreview(request, env) {
  if (env && pfFlag(env.PARSE_ON_PREVIEW)) return false;
  let h = '';
  try { h = new URL(request.url).hostname.toLowerCase(); } catch { return false; }
  return /\.pages\.dev$/.test(h) && h.split('.').length > 3;
}
function pfPreviewResponse() {
  const msg = '预览环境不提供解析，请到正式站使用';
  return new Response(JSON.stringify({ ok: false, code: -1, error: msg, msg }), {
    status: 403, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
function pfWithTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); })]).finally(() => clearTimeout(t));
}
function createPfRecorder(site, opts) {
  opts = opts || {};
  const now = opts.now || (() => Date.now());
  function record(env, ctx, info) {
    const db = env && env.PARSE_DB;
    if (!db || typeof db.prepare !== 'function' || pfFlag(env.PARSE_LOG_OFF)) return null;
    const job = (async () => {
      try {
        await pfWithTimeout(
          db.prepare('INSERT INTO parse_log (ts, site, url, ok, status, reason) VALUES (?, ?, ?, 0, ?, ?)')
            .bind(now(), site, pfCleanUrl(info.input), Number(info.st) || 0, pfScrub(info.msg || ('HTTP ' + (Number(info.st) || 0)))).run(),
          PF_WRITE_TIMEOUT_MS);
      } catch {}
    })();
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
    return job;
  }
  function inspect(resp, input, env, ctx) {
    if (!resp || !env || !env.PARSE_DB || pfFlag(env.PARSE_LOG_OFF)) return null;
    const status = resp.status;
    if (status >= 300 && status < 500) return null;
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('json')) {
      return status >= 500 ? record(env, ctx, { input, msg: 'HTTP ' + status, st: status }) : null;
    }
    const clone = resp.clone();
    const job = (async () => {
      let body = null;
      try { body = await clone.json(); } catch {}
      if (!pfBodyFailed(status, body)) return;
      const msg = body ? String(body.error || body.msg || body.message || '') : '';
      if (PF_SKIP_RE.test(msg)) return;
      await record(env, ctx, { input, msg: msg || ('HTTP ' + status), st: status });
    })().catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
    return job;
  }
  // 用法：return pf.wrap(request, env, ctx, () => handleParse(request, env));
  async function wrap(request, env, ctx, run) {
    if (pfIsPreview(request, env)) return pfPreviewResponse();
    let input = '';
    try { input = await pfInput(request); } catch {}
    let resp;
    try {
      resp = await run();
    } catch (e) {
      try { record(env, ctx, { input, msg: (e && e.message) || String(e), st: 500 }); } catch {}
      throw e;
    }
    try { inspect(resp, input, env, ctx); } catch {}
    return resp;
  }
  return { wrap, record, inspect };
}
// ==== pf-recorder v2 END ====
export { createPfRecorder };
