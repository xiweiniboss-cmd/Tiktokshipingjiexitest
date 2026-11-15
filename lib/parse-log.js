// ==== parse-log v1 BEGIN ====
// 解析记录 + 拉黑（各解析站共用同一份代码：allfeedback/shared/parse-log.js 是原件，改动后用 shared/pf-sync.mjs 同步）
// 存储：D1 数据库 parse_log（绑定名 PARSE_DB），表 parse_log / blocklist，建表语句见 allfeedback/shared/parse_log.sql。
// - 每次调用 /api/parse 记一行：时间、站点、链接（去掉令牌类参数）、成功与否、状态码、失败原因、IP、归属地（request.cf）、设备 ID、UA。
// - 设备 ID：前端首次访问在 localStorage 生成的随机 UUID，放在请求头 X-Device-Id；格式不对就当没有。不做任何指纹采集。
// - 拉黑：解析前先查 blocklist（每个 isolate 缓存 60 秒）；命中返回 403「访问受限」。
//   D1 没绑定 / 查询出错 / 超时一律放行（fail open），出错时沿用上一次成功读到的名单。
// - 写入全部在 waitUntil 里，出错吞掉，不影响解析响应。约 1% 的写入顺手删掉 30 天前的记录。
const PL_BLOCK_TTL_MS = 60000;
const PL_BLOCK_RETRY_MS = 10000;
const PL_BLOCK_TIMEOUT_MS = 1500;
const PL_RETENTION_MS = 30 * 86400 * 1000;
const PL_PRUNE_RATE = 0.01;
const PL_BLOCK_MSG = '访问受限';
const PL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PL_KEEP_PARAMS = new Set(['v', 'p', 'id', 'vid', 'bvid', 'aid', 'aweme_id', 'modal_id', 'item_id', 'photoid', 'list', 'index']);

function plDevice(request) {
  const v = String(request.headers.get('x-device-id') || '').trim().toLowerCase();
  return PL_UUID_RE.test(v) ? v : '';
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
function plCleanUrl(text) {
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
  for (const [k, v] of u.searchParams) if (PL_KEEP_PARAMS.has(k.toLowerCase()) && v.length <= 64) keep.append(k, v);
  const qs = keep.toString();
  u.search = qs ? '?' + qs : '';
  return u.toString().slice(0, 300);
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
function plWithTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); })]).finally(() => clearTimeout(t));
}
function createParseLog(site, opts) {
  opts = opts || {};
  const now = opts.now || (() => Date.now());
  const rand = opts.random || Math.random;
  const cache = { set: null, at: 0, pending: null };
  const blockLogged = new Map(); // 被拉黑的请求：同一 IP / 设备每分钟最多记一行

  async function loadBlocklist(db) {
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
  }
  async function isBlocked(env, ip, device) {
    const db = env && env.PARSE_DB;
    if (!db || typeof db.prepare !== 'function') return false;
    if (!cache.set || now() - cache.at >= PL_BLOCK_TTL_MS) {
      if (!cache.pending) cache.pending = loadBlocklist(db).finally(() => { cache.pending = null; });
      await cache.pending;
    }
    const s = cache.set;
    if (!s || !s.size) return false;
    if (ip && (s.has('ip:' + ip) || s.has('ip:' + plIp64(ip)))) return true;
    if (device && s.has('device:' + device)) return true;
    return false;
  }
  function write(env, ctx, row) {
    const db = env && env.PARSE_DB;
    if (!db || typeof db.prepare !== 'function') return null;
    const job = (async () => {
      try {
        await db.prepare('INSERT INTO parse_log (ts, site, url, ok, status, reason, ip, country, region, city, device_id, ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(row.ts, site, row.url, row.ok ? 1 : 0, row.status, row.reason, row.ip, row.country, row.region, row.city, row.device, row.ua).run();
        if (rand() < PL_PRUNE_RATE) await db.prepare('DELETE FROM parse_log WHERE ts < ?').bind(now() - PL_RETENTION_MS).run();
      } catch {}
    })();
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
    return job;
  }
  function baseRow(request, input) {
    const cf = request.cf || {};
    const s = (v, n) => String(v == null ? '' : v).slice(0, n);
    return {
      ts: now(), url: plCleanUrl(input), ip: plIp(request), device: plDevice(request),
      country: s(cf.country, 8).toUpperCase().replace(/[^A-Z]/g, ''), region: s(cf.region, 60), city: s(cf.city, 60),
      ua: s(request.headers.get('user-agent'), 200),
    };
  }
  const blockedResponse = () => new Response(JSON.stringify({ ok: false, code: -1, error: PL_BLOCK_MSG, msg: PL_BLOCK_MSG }), {
    status: 403, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
  // 用法：return pl.wrap(request, env, ctx, () => handleParse(request, env));
  async function wrap(request, env, ctx, run) {
    let input = '';
    try { input = await plInput(request); } catch {}
    const ip = plIp(request), device = plDevice(request);
    let blocked = false;
    try { blocked = await isBlocked(env, ip, device); } catch { blocked = false; }
    if (blocked) {
      try {
        const k = ip + '|' + device, t = now();
        if (!(t - (blockLogged.get(k) || 0) < 60000)) {
          if (blockLogged.size > 500) blockLogged.clear();
          blockLogged.set(k, t);
          write(env, ctx, { ...baseRow(request, input), ok: false, status: 403, reason: '已拉黑，拒绝解析' });
        }
      } catch {}
      return blockedResponse();
    }
    let resp;
    try {
      resp = await run();
    } catch (e) {
      try { write(env, ctx, { ...baseRow(request, input), ok: false, status: 500, reason: String((e && e.message) || e).slice(0, 160) }); } catch {}
      throw e;
    }
    try {
      if (resp && env && env.PARSE_DB) {
        const row = baseRow(request, input);
        const status = resp.status;
        const isJson = (resp.headers.get('content-type') || '').toLowerCase().includes('json');
        const clone = isJson ? resp.clone() : null;
        const job = (async () => {
          let body = null;
          if (clone) { try { body = await clone.json(); } catch {} }
          // 失败：非 2xx，或 ok:false，或 code 不是 0 / 200（TikTok 成功 code=0，微博成功 code=200）
          const failed = status >= 300 || !!(body && (body.ok === false || (typeof body.code === 'number' && body.code !== 0 && body.code !== 200)));
          const msg = failed ? String((body && (body.error || body.msg || body.message)) || ('HTTP ' + status)).replace(/\s+/g, ' ').trim().slice(0, 160) : '';
          await write(env, ctx, { ...row, ok: !failed, status, reason: msg });
        })().catch(() => {});
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
      }
    } catch {}
    return resp;
  }
  return { wrap, isBlocked, write, _cache: cache };
}
// ==== parse-log v1 END ====
export { createParseLog };
