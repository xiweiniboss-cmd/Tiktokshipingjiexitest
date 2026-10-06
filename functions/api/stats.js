// 本站解析次数
export async function onRequestGet(context) {
  let n = 0;
  const kv = (context.env || {}).FEEDBACK_KV;
  if (kv) {
    try {
      n = Number((await kv.get('stats_parse_tiktok')) || 0);
    } catch {}
  }
  return new Response(JSON.stringify({ ok: true, parseCount: n }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}
