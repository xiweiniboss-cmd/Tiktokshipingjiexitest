// Pages Functions 共用的安全辅助（由 functions/* 引入；不含任何密钥）
/* ================= 安全辅助（Round 2）：IP 归一 / CORS 白名单 / 管理员 Cookie 登录 / 跳转逐跳校验 ================= */
// 限流用的 IP 键：IPv4 原样；IPv6 归一到 /64（同一用户通常独占一个 /64，换后 64 位就能拿新配额）
export function ipLimitKey(ip) {
  ip = String(ip || '').trim().toLowerCase();
  if (!ip.includes(':')) return ip;
  let s = ip.split('%')[0];
  const v4 = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4 && /^::(ffff:)?[\d.]+$/.test(s)) return v4[1]; // IPv4-mapped，按 IPv4 算
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
export function clientIpKey(request) {
  return ipLimitKey(request.headers.get('cf-connecting-ip') || '');
}

// CORS：只给本站来源回显 Origin（同源、站点 pages.dev 域名及其预览子域、环境变量 ALLOWED_ORIGINS 里的自定义域名）
export const SITE_ORIGINS = ["https://tiktokshipingjiexi.pages.dev"];
export function originAllowed(origin, request, env) {
  if (!origin) return false;
  let o;
  try { o = new URL(origin); } catch { return false; }
  if (origin === new URL(request.url).origin) return true;
  const extra = String((env && env.ALLOWED_ORIGINS) || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  if (SITE_ORIGINS.includes(origin) || extra.includes(origin)) return true;
  return o.protocol === 'https:' && SITE_ORIGINS.some((s) => o.hostname.endsWith('.' + new URL(s).hostname));
}
export function applyCors(request, env, resp) {
  if (!resp || !new URL(request.url).pathname.startsWith('/api/')) return resp;
  const origin = request.headers.get('Origin') || '';
  const r = new Response(resp.body, resp);
  r.headers.delete('Access-Control-Allow-Origin');
  if (originAllowed(origin, request, env)) r.headers.set('Access-Control-Allow-Origin', origin);
  r.headers.append('Vary', 'Origin');
  return r;
}

// 代理抓取：手动跟随跳转（最多 maxHops 次），每一跳都只允许 https + 白名单域名，否则返回 null
export async function fetchAllowedHops(url, init, isAllowed, maxHops = 5) {
  let cur = String(url);
  for (let hop = 0; hop <= maxHops; hop++) {
    let u;
    try { u = new URL(cur); } catch { return null; }
    if (u.protocol !== 'https:' || !isAllowed(u.hostname)) return null;
    const resp = await fetch(u.toString(), { ...init, redirect: 'manual' });
    const loc = resp.headers.get('location');
    if (resp.status >= 300 && resp.status < 400 && loc) {
      try { if (resp.body) await resp.body.cancel(); } catch {}
      try { cur = new URL(loc, u).toString(); } catch { return null; }
      continue;
    }
    return resp;
  }
  return null;
}

// 管理员登录：POST /api/admin/login 校验 FEEDBACK_ADMIN_KEY 后下发 HttpOnly Cookie（HMAC 签名，12 小时有效）；
// 管理接口不再接受地址栏 ?key=，也不接受 Authorization: Bearer（没有任何调用方，且绕过了输错锁定），只认登录后下发的 Cookie。
export const ADMIN_COOKIE = 'jx_admin';
export const ADMIN_SESSION_SECS = 12 * 3600;
export const ADMIN_FAIL_MAX = 10; // 同一 IP（IPv6 /64）15 分钟内最多输错 10 次
export function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
export async function adminSig(secret, exp) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode('jx-admin|' + exp)));
  let s = '';
  for (const b of sig) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function adminCookieValue(request) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === ADMIN_COOKIE) return part.slice(i + 1).trim();
  }
  return '';
}
export async function isAdmin(request, env) {
  const secret = String((env && env.FEEDBACK_ADMIN_KEY) || '');
  if (!secret) return false;
  const m = adminCookieValue(request).match(/^(\d{9,11})\.([A-Za-z0-9_-]{20,})$/);
  if (!m || Number(m[1]) < Math.floor(Date.now() / 1000)) return false;
  return safeEqual(m[2], await adminSig(secret, m[1]));
}
export async function adminSetCookie(env) {
  const exp = Math.floor(Date.now() / 1000) + ADMIN_SESSION_SECS;
  return ADMIN_COOKIE + '=' + exp + '.' + (await adminSig(String(env.FEEDBACK_ADMIN_KEY), exp)) +
    '; Path=/; Max-Age=' + ADMIN_SESSION_SECS + '; HttpOnly; Secure; SameSite=Strict';
}
export function adminClearCookie() {
  return ADMIN_COOKIE + '=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict';
}
// 校验登录密码（带失败次数限制）：返回 { ok } 或 { ok:false, status, error }
export async function adminCheckPassword(request, env, key) {
  const secret = String((env && env.FEEDBACK_ADMIN_KEY) || '');
  if (!secret) return { ok: false, status: 500, error: '未配置管理密码 FEEDBACK_ADMIN_KEY' };
  const kv = env.FEEDBACK_KV;
  const ipk = clientIpKey(request);
  // 失败计数按站点分开：一个站被锁不影响其他站（所有站共用一个 KV）
  const fk = 'admfail_' + new URL(request.url).hostname + '_' + ipk;
  let fails = 0;
  if (kv && ipk) {
    try { fails = Number((await kv.get(fk)) || 0); } catch {}
    if (fails >= ADMIN_FAIL_MAX) return { ok: false, status: 429, error: '密码错误次数过多，请 15 分钟后再试' };
  }
  if (!safeEqual(String(key || ''), secret)) {
    if (kv && ipk) { try { await kv.put(fk, String(fails + 1), { expirationTtl: 900 }); } catch {} }
    return { ok: false, status: 403, error: '密码错误' };
  }
  return { ok: true };
}
// 同源判断：有 Sec-Fetch-Site 就必须是 same-origin；有 Origin 就必须等于本站（脚本 / curl 两个头都没有时放行，靠 JSON 限制挡表单）
export function adminSameOrigin(request) {
  const sfs = request.headers.get('Sec-Fetch-Site');
  if (sfs && sfs !== 'same-origin') return false;
  const o = request.headers.get('Origin');
  if (o && o !== new URL(request.url).origin) return false;
  return true;
}
export function adminJson(data, status, cookie) {
  const h = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  if (cookie) h.append('Set-Cookie', cookie);
  return new Response(JSON.stringify(data), { status: status || 200, headers: h });
}
export async function handleAdminLogin(request, env) {
  if (request.method !== 'POST') return adminJson({ ok: false, error: '方法不支持' }, 405);
  // 只收 JSON（跨站表单发不了 application/json），并拒绝跨站来源：防止别的网页替管理员乱输密码把 IP 锁住
  const ct = request.headers.get('content-type') || '';
  if (!ct.toLowerCase().includes('application/json')) return adminJson({ ok: false, error: '请求格式错误' }, 415);
  if (!adminSameOrigin(request)) return adminJson({ ok: false, error: '禁止跨站登录' }, 403);
  let key = '';
  try { key = String(((await request.json()) || {}).key || ''); } catch {}
  const r = await adminCheckPassword(request, env, key);
  if (!r.ok) return adminJson({ ok: false, error: r.error }, r.status);
  return adminJson({ ok: true }, 200, await adminSetCookie(env));
}
export function handleAdminLogout(request) {
  if (request.method !== 'POST') return adminJson({ ok: false, error: '方法不支持' }, 405);
  return adminJson({ ok: true }, 200, adminClearCookie());
}
export const ADMIN_PAGE_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
export const ADMIN_LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>管理登录</title>
<style>body{margin:0;font-family:-apple-system,"PingFang SC",sans-serif;background:#0f0f13;color:#f1f1f3;display:flex;min-height:100vh;align-items:center;justify-content:center}
form{background:#1a1a21;border-radius:16px;padding:24px 20px;width:min(320px,90vw)}h1{font-size:18px;margin:0 0 14px}
input{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #2a2a34;background:#0f0f13;color:#f1f1f3;font-size:15px}
button{margin-top:12px;width:100%;padding:12px;border:none;border-radius:10px;background:#FE2C55;color:#fff;font-size:15px}
#err{color:#ff8ba0;font-size:13px;min-height:18px;margin-top:8px}</style></head>
<body><form id="f"><h1>管理后台登录</h1><input type="password" id="k" autocomplete="current-password" placeholder="管理密码" required>
<button type="submit">登录</button><div id="err"></div></form>
<script>
(function(){
  var q = new URLSearchParams(location.search).get('err');
  var M = { wrong: '密码错误', locked: '密码错误次数过多，请 15 分钟后再试', nokey: '本站未配置管理密码', cross: '请直接打开本站后台再登录' };
  if (q) document.getElementById('err').textContent = M[q] || '登录失败';
})();
document.getElementById('f').onsubmit = async function(e){
  e.preventDefault();
  var err = document.getElementById('err'); err.textContent = '';
  try {
    var r = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: document.getElementById('k').value }), credentials: 'same-origin' });
    var j = await r.json();
    if (j.ok) location.replace(location.pathname); else err.textContent = j.error || '登录失败';
  } catch (x) { err.textContent = '网络错误'; }
};
<\/script></body></html>`;
// /admin、/dashboard：已登录给页面；未登录给登录页。旧书签 ?key=密码 仍可用一次：校验通过换成 Cookie 并跳转去掉地址栏里的密码
export async function serveAdminPage(request, env, html) {
  const url = new URL(request.url);
  const legacy = url.searchParams.get('key');
  if (legacy !== null) {
    // 跨站带过来的 ?key= 不校验（不计失败次数），防止别的网页替管理员乱试把 IP 锁住
    let err = '';
    let cookie = '';
    if ((request.headers.get('Sec-Fetch-Site') || '') === 'cross-site') err = 'cross';
    else {
      const r = await adminCheckPassword(request, env, legacy);
      if (r.ok) cookie = await adminSetCookie(env);
      else err = r.status === 429 ? 'locked' : r.status === 500 ? 'nokey' : 'wrong';
    }
    const h = new Headers({ Location: url.pathname + (err ? '?err=' + err : ''), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    if (cookie) h.append('Set-Cookie', cookie);
    return new Response(null, { status: 302, headers: h });
  }
  if (!(await isAdmin(request, env))) return new Response(ADMIN_LOGIN_HTML, { status: 401, headers: ADMIN_PAGE_HEADERS });
  return new Response(html, { headers: ADMIN_PAGE_HEADERS });
}
/* ================= 安全辅助结束 ================= */
