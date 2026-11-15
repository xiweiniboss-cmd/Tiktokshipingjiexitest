// ==== parse-log v2 BEGIN ====
// 解析记录 + 拉黑（各解析站共用同一份代码：allfeedback/shared/parse-log.js 是原件，改动后用 shared/pf-sync.mjs 同步）
// 存储：D1 数据库 parse_log（绑定名 PARSE_DB），表 parse_log / blocklist，建表语句见 allfeedback/shared/parse_log.sql。
// - 每次解析记一行：时间、站点、链接（去掉令牌类参数）、成功与否、状态码、失败原因（里面的链接也去令牌）、IP、归属地（request.cf）、
//   设备 ID、设备指纹、UA。失败行（ok=0）同时就是 allfeedback「解析失败」的数据来源，所以接了本模块的站不再需要 pf-recorder。
// - 只在「人机验证 + 频控都通过之后」才记：站点在 handleParse 里过了这两关时调用 plPass(request)，没调用的请求一律不记
//   （没过人机验证的刷接口请求不会写 D1，不会把每天的免费写入额度刷光）。
// - 只记「有效链接」：站点传入的 valid(input) 返回 false（空输入 / 不是本站链接 / 链接格式不对）就不记。
// - 设备 ID：前端首次访问在 localStorage 生成的随机 UUID，放在请求头 X-Device-Id；格式不对就当没有。
// - 设备指纹：前端用 canvas 渲染、屏幕尺寸/色深、时区、语言、CPU 核数、平台、UA 算 SHA-256 取前 32 位十六进制，
//   放在请求头 X-Device-Fp；尽力而为，格式不对就当没有。同型号同浏览器的设备常常算出同一个指纹。
// - 拉黑：最先查 blocklist（IP / IPv6 /64 / 设备 ID / 指纹）；命中返回 403「访问受限」，不调上游。
//   名单在每个 isolate 里缓存 60 秒；过期后先用旧名单放行/拦截，同时在后台（waitUntil）刷新，不让用户干等。
//   只有刚启动、手里还没有名单时才等一次（最多 1.5 秒）。D1 没绑定 / 查询出错 / 超时一律放行（fail open）。
//   被拉黑的请求按命中的名单项每分钟最多记一行（换设备头也不会多写）。
// - 下载 / 媒体代理用 pl.guard(...) 包一层：只查黑名单，不记。
// - 写入全部在 waitUntil 里、最多等 10 秒、出错吞掉，不影响解析响应。保留 30 天：由微博 Worker 的每日定时任务分批删除。
// - 开关：PARSE_LOG_OFF=1 时不写记录（黑名单照常检查）。
// - 预览部署（<分支或哈希>.<项目>.pages.dev）不提供解析：直接 403。确实要测，给预览环境加 PARSE_ON_PREVIEW=1。
const PL_BLOCK_TTL_MS = 60000;
const PL_BLOCK_RETRY_MS = 10000;
const PL_BLOCK_TIMEOUT_MS = 1500;
const PL_WRITE_TIMEOUT_MS = 10000;
const PL_RETENTION_MS = 30 * 86400 * 1000;
const PL_BLOCK_MSG = '访问受限';
const PL_FP_RE = /^[0-9a-f]{32}$/;
const PL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PL_KEEP_PARAMS = new Set(['v', 'p', 'id', 'vid', 'bvid', 'aid', 'aweme_id', 'modal_id', 'item_id', 'photoid', 'list', 'index']);
const PL_URL_RE = /https?:\/\/[^\s"'<>\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+/gi;
const PL_PASSED = new WeakSet();

// 站点在人机验证 + 频控都通过后调用：之后这次解析才会被记录
function plPass(request) {
  try { if (request && typeof request === 'object') PL_PASSED.add(request); } catch {}
}
function plDevice(request) {
  const v = String(request.headers.get('x-device-id') || '').trim().toLowerCase();
  return PL_UUID_RE.test(v) ? v : '';
}
function plFp(request) {
  const v = String(request.headers.get('x-device-fp') || '').trim().toLowerCase();
  return PL_FP_RE.test(v) ? v : '';
}
function plIp(request) {
  return String(request.headers.get('cf-connecting-ip') || '').trim().toLowerCase().slice(0, 64);
}
// IPv6 按 /64 归一（同一用户的 IPv6 后半段经常变）；IPv4 原样
function plIp64(ip) {
  ip = String(ip || '').trim().toLowerCase();
  if (!ip.includes(':')) return ip;
  let s = ip.split('%')[0];
  const v4 = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4 && /^::(ffff:)?[\d.]+$/.test(s)) return v4[1];
  if (v4) s = s.slice(0, -v4[1].length) + '0:0';
  const halves = s.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  let parts = head;
  if (halves.length > 1) {
    const tail = halves[1] ? halves[1].split(':') : [];
    parts = head.concat(Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), tail);
  }
  parts = parts.slice(0, 4).map((x) => (parseInt(x || '0', 16) || 0).toString(16));
  while (parts.length < 4) parts.push('0');
  return parts.join(':') + '::/64';
}
function plCleanOne(raw) {
  raw = String(raw || '').replace(/[),.;!?\]}>»」』】，。；：？！）、]+$/, '');
  let u;
  try { u = new URL(raw); } catch { return ''; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  u.username = '';
  u.password = '';
  u.hash = '';
  const keep = new URLSearchParams();
  for (const [k, v] of u.searchParams) if (PL_KEEP_PARAMS.has(k.toLowerCase()) && v.length <= 64) keep.append(k, v);
  const qs = keep.toString();
  u.search = qs ? '?' + qs : '';
  return u.toString().slice(0, 300);
}
function plCleanUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>]+/i);
  return m ? plCleanOne(m[0]) : '';
}
// 失败原因里出现的链接也去掉令牌（上游报错经常把请求地址连同令牌一起带出来）
function plScrub(text, max) {
  const s = String(text == null ? '' : text).replace(PL_URL_RE, (m) => {
    const tail = (m.match(/[),.;!?\]}>»」』】，。；：？！）、]+$/) || [''])[0];
    return (plCleanOne(m) || '[链接]') + tail;
  });
  return s.replace(/\s+/g, ' ').trim().slice(0, max || 160);
}
async function plInput(request) {
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
function plFlag(v) {
  return /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());
}
function plIsPreview(request, env) {
  if (env && plFlag(env.PARSE_ON_PREVIEW)) return false;
  let h = '';
  try { h = new URL(request.url).hostname.toLowerCase(); } catch { return false; }
  return /\.pages\.dev$/.test(h) && h.split('.').length > 3;
}
function plJson(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
function plPreviewResponse() {
  const msg = '预览环境不提供解析，请到正式站使用';
  return plJson({ ok: false, code: -1, error: msg, msg }, 403);
}
function plWithTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); })]).finally(() => clearTimeout(t));
}
function createParseLog(site, opts) {
  opts = opts || {};
  const now = opts.now || (() => Date.now());
  const valid = typeof opts.valid === 'function' ? opts.valid : null;
  const cache = { set: null, at: 0, pending: null };
  const blockLogged = new Map(); // 命中的名单项 → 上次记录时间（每分钟最多记一行）

  function refresh(db) {
    if (cache.pending) return cache.pending;
    cache.pending = (async () => {
      try {
        const r = await plWithTimeout(db.prepare('SELECT type, value FROM blocklist LIMIT 5000').all(), PL_BLOCK_TIMEOUT_MS);
        const set = new Set();
        for (const x of (r && r.results) || []) set.add(String(x.type) + ':' + String(x.value));
        cache.set = set;
        cache.at = now();
      } catch {
        // 读失败：放行，10 秒后再试；有旧名单就继续用旧的
        if (!cache.set) cache.set = new Set();
        cache.at = now() - PL_BLOCK_TTL_MS + PL_BLOCK_RETRY_MS;
      }
    })().finally(() => { cache.pending = null; });
    return cache.pending;
  }
  // 命中返回名单项（如 'ip:1.2.3.4'），没命中返回 ''
  async function blockedBy(env, ctx, ip, device, fp) {
    const db = env && env.PARSE_DB;
    if (!db || typeof db.prepare !== 'function') return '';
    if (!cache.set) await refresh(db); // 刚启动：等一次（最多 1.5 秒）
    else if (now() - cache.at >= PL_BLOCK_TTL_MS && !cache.pending) {
      const job = refresh(db); // 过期：先用旧名单，后台刷新
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
    }
    const s = cache.set;
    if (!s || !s.size) return '';
    if (ip && s.has('ip:' + ip)) return 'ip:' + ip;
    if (ip && ip.includes(':') && s.has('ip:' + plIp64(ip))) return 'ip:' + plIp64(ip);
    if (device && s.has('device:' + device)) return 'device:' + device;
    if (fp && s.has('fp:' + fp)) return 'fp:' + fp;
    return '';
  }
  async function isBlocked(env, ip, device, fp, ctx) {
    try { return !!(await blockedBy(env, ctx, ip, device, fp)); } catch { return false; }
  }
  function write(env, ctx, row) {
    const db = env && env.PARSE_DB;
    if (!db || typeof db.prepare !== 'function' || plFlag(env.PARSE_LOG_OFF)) return null;
    const job = (async () => {
      try {
        await plWithTimeout(
          db.prepare('INSERT INTO parse_log (ts, site, url, ok, status, reason, ip, country, region, city, device_id, fp, ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(row.ts, site, row.url, row.ok ? 1 : 0, row.status, row.reason, row.ip, row.country, row.region, row.city, row.device, row.fp, row.ua).run(),
          PL_WRITE_TIMEOUT_MS);
      } catch {}
    })();
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
    return job;
  }
  function baseRow(request, input) {
    const cf = request.cf || {};
    const s = (v, n) => String(v == null ? '' : v).slice(0, n);
    return {
      ts: now(), url: plCleanUrl(input), ip: plIp(request), device: plDevice(request), fp: plFp(request),
      country: s(cf.country, 8).toUpperCase().replace(/[^A-Z]/g, ''), region: s(cf.region, 60), city: s(cf.city, 60),
      ua: s(request.headers.get('user-agent'), 200),
    };
  }
  const blockedResponse = () => plJson({ ok: false, code: -1, error: PL_BLOCK_MSG, msg: PL_BLOCK_MSG }, 403);
  async function check(request, env, ctx) {
    let hit = '';
    try { hit = await blockedBy(env, ctx, plIp(request), plDevice(request), plFp(request)); } catch { hit = ''; }
    return hit;
  }
  // 下载 / 媒体代理：只查黑名单，不记
  async function guard(request, env, ctx, run) {
    if (await check(request, env, ctx)) return blockedResponse();
    return run();
  }
  // 用法：return pl.wrap(request, env, ctx, () => handleParse(request, env));  handleParse 里过了人机验证和频控后调 plPass(request)
  async function wrap(request, env, ctx, run) {
    if (plIsPreview(request, env)) return plPreviewResponse();
    let input = '';
    try { input = await plInput(request); } catch {}
    const hit = await check(request, env, ctx);
    if (hit) {
      try {
        const t = now();
        if (!(t - (blockLogged.get(hit) || 0) < 60000)) {
          if (blockLogged.size > 500) blockLogged.clear();
          blockLogged.set(hit, t);
          write(env, ctx, { ...baseRow(request, input), ok: false, status: 403, reason: '已拉黑，拒绝解析' });
        }
      } catch {}
      return blockedResponse();
    }
    // 无效链接（空 / 不是本站 / 格式不对）：照常交给站点处理（它会 400），但不记
    let record = !!(env && env.PARSE_DB) && !plFlag(env && env.PARSE_LOG_OFF);
    if (record && valid) { try { record = !!valid(input); } catch { record = false; } }
    if (!record) return run();
    let resp;
    try {
      resp = await run();
    } catch (e) {
      try { if (PL_PASSED.has(request)) write(env, ctx, { ...baseRow(request, input), ok: false, status: 500, reason: plScrub((e && e.message) || e) }); } catch {}
      throw e;
    }
    try {
      if (resp && PL_PASSED.has(request)) {
        const row = baseRow(request, input);
        const status = resp.status;
        const isJson = (resp.headers.get('content-type') || '').toLowerCase().includes('json');
        const clone = isJson ? resp.clone() : null;
        const job = (async () => {
          let body = null;
          if (clone) { try { body = await clone.json(); } catch {} }
          // 失败：非 2xx，或 ok:false，或 code 不是 0 / 200（TikTok 成功 code=0，微博成功 code=200）
          const failed = status >= 300 || !!(body && (body.ok === false || (typeof body.code === 'number' && body.code !== 0 && body.code !== 200)));
          const msg = failed ? plScrub((body && (body.error || body.msg || body.message)) || ('HTTP ' + status)) : '';
          await write(env, ctx, { ...row, ok: !failed, status, reason: msg });
        })().catch(() => {});
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
      }
    } catch {}
    return resp;
  }
  return { wrap, guard, isBlocked, write, _cache: cache };
}
// ==== parse-log v2 END ====
export { createParseLog, plPass };
