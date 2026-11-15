import { rateUsed, RL_DAILY_LIMIT } from '../../lib/rate-limit.js';
// 每日解析配额查询：GET /api/parse-quota（和解析接口同一个 D1 计数）
export async function onRequestGet(context) {
  const { request, env } = context;
  const DAILY_LIMIT = RL_DAILY_LIMIT;
  const used = await rateUsed(env, 'tiktok', request.headers.get('cf-connecting-ip') || '');
  return new Response(
    JSON.stringify({ ok: true, limit: DAILY_LIMIT, used, remaining: Math.max(0, DAILY_LIMIT - used) }),
    { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }
  );
}
