import { isAdmin } from '../../lib/security.js';
// 解析者归属地分布（管理）：GET /api/geo-stats（需管理员登录 Cookie）
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!(await isAdmin(request, env)))
    return new Response(JSON.stringify({ ok: false, error: '无权访问' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  const byCountry = {};
  const bySite = { tiktok: {}, xhs: {}, douyin: {}, youtube: {}, bilibili: {}, kuaishou: {} };
  const kv = env.FEEDBACK_KV;
  if (kv) {
    try {
      const listed = await kv.list({ prefix: 'geoparse_' });
      for (const k of listed.keys) {
        const m = k.name.match(/^geoparse_(tiktok|xhs|douyin|youtube|bilibili|kuaishou)_([A-Z]{2})$/);
        if (!m) continue;
        const n = Number((await kv.get(k.name)) || 0);
        if (!n) continue;
        const site = m[1],
          cc = m[2];
        byCountry[cc] = (byCountry[cc] || 0) + n;
        bySite[site][cc] = (bySite[site][cc] || 0) + n;
      }
    } catch {}
  }
  return new Response(JSON.stringify({ ok: true, byCountry, bySite }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
