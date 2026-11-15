// ==== pf-recorder v1 BEGIN ====
// 解析失败记录器（各解析站共用同一份代码：allfeedback/shared/pf-recorder.js 是原件，改动后用 shared/pf-sync.mjs 同步到各站）
// 解析失败时按「站点 + 北京日期」聚合写进 FEEDBACK_KV 的 pf_<site>_<YYYY-MM-DD>，35 天后自动过期。
// 值：{ v:1, site, day, n:失败总数, reasons:{原因代码:次数}, msgs:{报错原文:次数}(最多 20 种), last:[最近 30 条样本], w:当天已写入次数, upd }
// 样本：{ t, url:去掉疑似令牌参数的链接, code, msg, st:本站返回的状态码, up:上游 HTTP 状态码(能识别时) }
// 省 KV 写入（免费版全账号每天约 1000 次写，而且这个 KV 和其他功能共用）：
//   - 同一个 isolate、同一站点，两次写入至少隔 PF_MIN_GAP_MS；间隔内的失败先攒在内存里，到点一起合并写一次；
//   - 当天这个键已写满 PF_SOFT_CAP 次后，改成至少隔 PF_CAP_GAP_MS 才写一次（计数继续在内存里累加，下次写时合并）。
// 读-改-写不是原子的，多个 isolate 同时写可能互相覆盖、丢几条统计，这是统计数据，可以接受。
// 全部在 waitUntil 里跑、所有异常都吞掉：绝不拖慢、也绝不影响解析接口本身的响应。
// 不记录：4xx（输入不对、人机验证、频率限制、今日次数用完等）。
const PF_TTL = 35 * 86400;
const PF_MIN_GAP_MS = 25000;
const PF_SOFT_CAP = 30;
const PF_CAP_GAP_MS = 30 * 60000;
const PF_SAMPLES = 30;
const PF_MSGS = 20;
const PF_URL_MAX = 300;
const PF_MSG_MAX = 120;
// 链接里只保留能定位作品的参数，其余（xsec_token、share_token、sign、timestamp、uid…）一律去掉
const PF_KEEP_PARAMS = new Set(['v', 'p', 'id', 'vid', 'bvid', 'aid', 'aweme_id', 'modal_id', 'item_id', 'photoid', 'list', 'index']);
// 兜底：即使是 5xx / ok:false，报错文字属于这些情况也不算解析失败
const PF_SKIP_RE = /人机验证|解析太频繁|今日解析次数|请先粘贴|只支持|不像|不是.{0,6}链接|没找到有效的链接|没有找到链接/;

function pfDay(ms) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function pfCleanUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>]+/i);
  if (!m) return '';
  const raw = m[0].replace(/[),.;!?\]}>»」』】，。；：？！）、]+$/, '');
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
  return { code, up };
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
function pfEmpty(site, day) {
  return { v: 1, site, day, n: 0, reasons: {}, msgs: {}, last: [], w: 0, upd: 0 };
}
function pfMerge(rec, p) {
  rec.n = (Number(rec.n) || 0) + p.n;
  if (!rec.reasons || typeof rec.reasons !== 'object') rec.reasons = {};
  for (const [k, c] of Object.entries(p.reasons)) rec.reasons[k] = (Number(rec.reasons[k]) || 0) + c;
  if (!rec.msgs || typeof rec.msgs !== 'object') rec.msgs = {};
  for (const [k, c] of Object.entries(p.msgs)) {
    if (k in rec.msgs || Object.keys(rec.msgs).length < PF_MSGS) rec.msgs[k] = (Number(rec.msgs[k]) || 0) + c;
  }
  rec.last = p.last.concat(Array.isArray(rec.last) ? rec.last : []).sort((a, b) => b.t - a.t).slice(0, PF_SAMPLES);
  return rec;
}
function createPfRecorder(site, opts) {
  opts = opts || {};
  const now = opts.now || (() => Date.now());
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const st = { pending: {}, lastWrite: 0, busy: 0 };

  function add(s) {
    const day = pfDay(s.t);
    const p = (st.pending[day] = st.pending[day] || pfEmpty(site, day));
    p.n++;
    p.reasons[s.code] = (p.reasons[s.code] || 0) + 1;
    if (s.msg && (s.msg in p.msgs || Object.keys(p.msgs).length < PF_MSGS)) p.msgs[s.msg] = (p.msgs[s.msg] || 0) + 1;
    p.last.unshift(s);
    if (p.last.length > PF_SAMPLES) p.last.length = PF_SAMPLES;
  }
  async function flush(kv) {
    const days = st.pending;
    st.pending = {};
    for (const day of Object.keys(days)) {
      const p = days[day];
      const key = 'pf_' + site + '_' + day;
      let rec = null;
      try { rec = JSON.parse((await kv.get(key)) || 'null'); } catch {}
      if (!rec || typeof rec !== 'object' || rec.v !== 1) rec = pfEmpty(site, day);
      const t = now();
      if ((Number(rec.w) || 0) >= PF_SOFT_CAP && t - (Number(rec.upd) || 0) < PF_CAP_GAP_MS) {
        // 今天写得够多了：先放回内存，过一阵再合并写
        const back = (st.pending[day] = st.pending[day] || pfEmpty(site, day));
        pfMerge(back, p);
        continue;
      }
      pfMerge(rec, p);
      rec.w = (Number(rec.w) || 0) + 1;
      rec.upd = t;
      try {
        await kv.put(key, JSON.stringify(rec), { expirationTtl: PF_TTL });
      } catch {}
    }
    st.lastWrite = now();
  }
  function record(env, ctx, info) {
    const kv = env && env.FEEDBACK_KV;
    if (!kv) return null;
    const t = now();
    add({
      t,
      url: pfCleanUrl(info.input),
      code: info.code || 'other',
      msg: String(info.msg || '').replace(/\s+/g, ' ').trim().slice(0, PF_MSG_MAX),
      st: Number(info.st) || 0,
      up: Number(info.up) || 0,
    });
    // 已经排好一次写入（且没有卡死）：这条会跟着那次一起写
    if (st.busy && t - st.busy < 60000) return null;
    st.busy = t;
    const wait = Math.max(0, PF_MIN_GAP_MS - (t - st.lastWrite));
    const job = (async () => {
      try {
        if (wait) await sleep(wait);
        await flush(kv);
      } catch {} finally {
        st.busy = 0;
      }
    })();
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
    return job;
  }
  function inspect(resp, input, env, ctx) {
    if (!resp || !env || !env.FEEDBACK_KV) return null;
    const status = resp.status;
    if (status >= 300 && status < 500) return null;
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('json')) {
      return status >= 500 ? record(env, ctx, { input, code: 'other', msg: 'HTTP ' + status, st: status }) : null;
    }
    const clone = resp.clone();
    const job = (async () => {
      let body = null;
      try { body = await clone.json(); } catch {}
      const failed = status >= 500 || !!(body && (body.ok === false || (typeof body.code === 'number' && body.code !== 0)));
      if (!failed) return;
      const msg = body ? String(body.error || body.msg || body.message || '') : '';
      if (PF_SKIP_RE.test(msg)) return;
      const c = pfClassify(status, msg);
      await record(env, ctx, { input, code: c.code, up: c.up, msg, st: status });
    })().catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
    return job;
  }
  // 用法：return pf.wrap(request, env, ctx, () => handleParse(request, env));
  async function wrap(request, env, ctx, run) {
    let input = '';
    try { input = await pfInput(request); } catch {}
    let resp;
    try {
      resp = await run();
    } catch (e) {
      try { record(env, ctx, { input, code: 'exception', msg: (e && e.message) || String(e), st: 500 }); } catch {}
      throw e;
    }
    try { inspect(resp, input, env, ctx); } catch {}
    return resp;
  }
  return { wrap, record, inspect, flush, _state: st };
}
// ==== pf-recorder v1 END ====
export { createPfRecorder };
