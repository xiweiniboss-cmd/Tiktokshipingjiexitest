// 每日解析配额查询：GET /api/parse-quota
export async function onRequestGet(context) {
  const { request, env } = context;
  const DAILY_LIMIT = 20;
  const ip = request.headers.get('cf-connecting-ip') || '';
  const bjDate = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  let used = 0;
  const kv = env.FEEDBACK_KV;
  if (ip && kv) {
    try {
      used = Number((await kv.get('dlimit_tiktok_' + ip + '_' + bjDate)) || 0);
    } catch {}
  }
  return new Response(
    JSON.stringify({ ok: true, limit: DAILY_LIMIT, used, remaining: Math.max(0, DAILY_LIMIT - used) }),
    {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    }
  );
}
