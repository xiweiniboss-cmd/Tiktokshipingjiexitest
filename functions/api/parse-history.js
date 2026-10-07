// 最近解析记录（管理）：GET /api/parse-history?key=管理密码
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const adminKey = env.FEEDBACK_ADMIN_KEY || '';
  if (!adminKey || url.searchParams.get('key') !== adminKey)
    return new Response(JSON.stringify({ ok: false, error: '无权访问' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  const siteNames = { tiktok: 'TikTok站', xhs: '小红书站', douyin: '抖音站', youtube: 'YouTube站', bilibili: 'B站站' };
  const kv = env.FEEDBACK_KV;
  const all = [];
  if (kv) {
    for (const site of Object.keys(siteNames)) {
      try {
        const raw = await kv.get('parsehist_' + site);
        const hist = raw ? JSON.parse(raw) : [];
        if (Array.isArray(hist)) for (const h of hist) all.push({ site: siteNames[site], ...h });
      } catch {}
    }
  }
  all.sort((a, b) => (b.t || 0) - (a.t || 0));
  return new Response(JSON.stringify({ ok: true, items: all.slice(0, 50) }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}
