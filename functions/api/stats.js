// 本站解析次数
export async function onRequestGet(context) {
  const kv = (context.env || {}).FEEDBACK_KV;
  let body;
  if (!kv) body = { ok: true, bound: false, parseCount: null, error: '未绑定 KV' };
  else {
    let n = null;
    try {
      n = Number((await kv.get('stats_parse_tiktok')) || 0);
    } catch {}
    body = { ok: true, bound: true, parseCount: n };
  }
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}
