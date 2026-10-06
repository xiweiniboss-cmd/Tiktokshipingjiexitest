// 解析者归属地分布（管理）：GET /api/geo-stats?key=管理密码
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const adminKey = env.FEEDBACK_ADMIN_KEY || '';
  if (!adminKey || url.searchParams.get('key') !== adminKey)
    return new Response(JSON.stringify({ ok: false, error: '无权访问' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  const byCountry = {};
  const bySite = { tiktok: {}, xhs: {}, douyin: {}, youtube: {} };
  const kv = env.FEEDBACK_KV;
  if (kv) {
    try {
      const listed = await kv.list({ prefix: 'geoparse_' });
      for (const k of listed.keys) {
        const m = k.name.match(/^geoparse_(tiktok|xhs|douyin|youtube)_([A-Z]{2})$/);
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
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}
