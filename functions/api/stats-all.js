import { isAdmin } from '../../lib/security.js';
// 全站解析统计（管理）：GET /api/stats-all（需管理员登录 Cookie）
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!(await isAdmin(request, env)))
    return new Response(JSON.stringify({ ok: false, error: '无权访问' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  const sites = [
    { key: 'stats_parse_tiktok', name: 'TikTok站' },
    { key: 'stats_parse_xhs', name: '小红书站' },
    { key: 'stats_parse_douyin', name: '抖音站' },
    { key: 'stats_parse_youtube', name: 'YouTube站' },
    { key: 'stats_parse_bilibili', name: 'B站站' },
    { key: 'stats_parse_kuaishou', name: '快手站' },
  ];
  const kv = env.FEEDBACK_KV;
  const result = [];
  for (const s of sites) {
    let n = 0;
    if (kv) {
      try {
        n = Number((await kv.get(s.key)) || 0);
      } catch {}
    }
    result.push({ name: s.name, count: n });
  }
  return new Response(JSON.stringify({ ok: true, sites: result }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
