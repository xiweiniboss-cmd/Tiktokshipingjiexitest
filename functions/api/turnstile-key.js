// Turnstile 公开 site key 下发（site key 本就是公开的，前端渲染验证组件用）
export async function onRequestGet(context) {
  const siteKey = ((context.env || {}).TURNSTILE_SITE_KEY || '').trim();
  return new Response(JSON.stringify({ ok: true, siteKey }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}
