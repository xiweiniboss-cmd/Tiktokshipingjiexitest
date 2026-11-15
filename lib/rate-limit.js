import { ipLimitKey } from './security.js';
// ================= 原子频控（D1 rate_counter，和微博站共用同一张表） =================
// 冷却 60 秒 + 每 IP（IPv6 按 /64）每天（北京时间）20 次。解析之前用一条 UPSERT 原子地「判断 + 占坑」：
//   并发一批请求只有第一个能占到坑；失败的解析也算一次（不能拿坏链接无限刷上游接口）。
// 没绑 PARSE_DB / D1 出错：退回 KV，同样先占坑再解析（KV 非原子，只是兜底）。
const RL_COOLDOWN_SECS = 60;
export const RL_DAILY_LIMIT = 20;
const RL_TIMEOUT_MS = 2000;
function rlDate() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function rlWithTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); })]).finally(() => clearTimeout(t));
}
function rlDeny(now, last, used) {
  if (last && now - last < RL_COOLDOWN_SECS * 1000) {
    const wait = Math.ceil((RL_COOLDOWN_SECS * 1000 - (now - last)) / 1000);
    return { ok: false, status: 429, msg: '解析太频繁，请 ' + wait + ' 秒后再试' };
  }
  if (used >= RL_DAILY_LIMIT) return { ok: false, status: 429, msg: '今日解析次数已用完（' + RL_DAILY_LIMIT + ' 次），明天再来吧' };
  return null;
}
export async function rateTake(env, site, rawIp) {
  const ip = ipLimitKey(rawIp);
  if (!ip) return { ok: true };
  const now = Date.now();
  const k = site + ':' + ip + ':' + rlDate();
  const db = env && env.PARSE_DB;
  if (db && typeof db.prepare === 'function') {
    try {
      const got = await rlWithTimeout(db.prepare(
        'INSERT INTO rate_counter (k, n, last, exp) VALUES (?, 1, ?, ?) ON CONFLICT(k) DO UPDATE SET n = n + 1, last = excluded.last ' +
        'WHERE rate_counter.last <= ? AND rate_counter.n < ? RETURNING n'
      ).bind(k, now, now + 2 * 86400000, now - RL_COOLDOWN_SECS * 1000, RL_DAILY_LIMIT).first(), RL_TIMEOUT_MS);
      if (got) return { ok: true };
      const cur = await rlWithTimeout(db.prepare('SELECT n, last FROM rate_counter WHERE k = ?').bind(k).first(), RL_TIMEOUT_MS);
      return rlDeny(now, Number(cur && cur.last) || 0, Number(cur && cur.n) || 0) || { ok: false, status: 429, msg: '解析太频繁，请稍后再试' };
    } catch (e) { /* D1 出错：退回 KV */ }
  }
  const kv = env && env.FEEDBACK_KV;
  if (kv) {
    try {
      const ck = 'pcool_' + site + '_' + ip, qk = 'dlimit_' + site + '_' + ip + '_' + rlDate();
      const [lastTs, usedRaw] = await Promise.all([kv.get(ck), kv.get(qk)]);
      const used = Number(usedRaw) || 0;
      const deny = rlDeny(now, Number(lastTs) || 0, used);
      if (deny) return deny;
      await Promise.all([
        kv.put(ck, String(now), { expirationTtl: RL_COOLDOWN_SECS }),
        kv.put(qk, String(used + 1), { expirationTtl: 172800 }),
      ]);
    } catch {}
  }
  return { ok: true };
}
export async function rateUsed(env, site, rawIp) {
  const ip = ipLimitKey(rawIp);
  if (!ip) return 0;
  const db = env && env.PARSE_DB;
  if (db && typeof db.prepare === 'function') {
    try {
      const cur = await rlWithTimeout(db.prepare('SELECT n FROM rate_counter WHERE k = ?').bind(site + ':' + ip + ':' + rlDate()).first(), RL_TIMEOUT_MS);
      return Number(cur && cur.n) || 0;
    } catch {}
  }
  try { return Number((await env.FEEDBACK_KV.get('dlimit_' + site + '_' + ip + '_' + rlDate())) || 0); } catch { return 0; }
}
// 人机验证 fail-closed：没配 TURNSTILE_SECRET_KEY 就拒绝解析，除非明确设了 TURNSTILE_DISABLED=1
export function turnstileDisabled(env) {
  return /^(1|true|yes|on)$/i.test(String((env && env.TURNSTILE_DISABLED) || '').trim());
}
// ================= 原子频控 end =================
