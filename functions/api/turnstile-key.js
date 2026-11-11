// Turnstile 公开 site key 下发（Pages 变量 TURNSTILE_SITE_KEY；没配就返回空，前端据此跳过人机验证）
export async function onRequestGet(context) {
  const env = context.env || {};
  return new Response(
    JSON.stringify({ ok: true, siteKey: String(env.TURNSTILE_SITE_KEY || '').trim(), required: !!String(env.TURNSTILE_SECRET_KEY || '').trim() }),
    { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }
  );
}
