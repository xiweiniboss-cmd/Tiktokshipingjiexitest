import { isAdmin } from '../../../lib/security.js';
// 反馈列表（管理）：GET /api/feedback/list（需管理员登录 Cookie）
const json = (obj, status) =>
  new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!(await isAdmin(request, env)))
    return json({ ok: false, error: '无权访问' }, 403);
  if (!env.FEEDBACK_KV) return json({ ok: false, error: '未绑定 KV' }, 500);
  const items = [];
  for (const prefix of ['fb_', 'feedback_']) {
    const listed = await env.FEEDBACK_KV.list({ prefix });
    for (const k of listed.keys) {
      try {
        const v = await env.FEEDBACK_KV.get(k.name);
        if (!v) continue;
        const it = JSON.parse(v);
        // 快手站旧版记录：key 是 feedback_<id>，时间字段叫 ts，没有 page
        if (prefix === 'feedback_') {
          if (!it.time && it.ts) it.time = new Date(Number(it.ts)).toISOString();
          if (!it.page || !/^https?:/.test(String(it.page))) it.page = 'https://kuaishoujiexi.pages.dev/';
          it.id = String(it.id || k.name.slice('feedback_'.length));
        }
        items.push(it);
      } catch {}
    }
  }
  items.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
  return json({ ok: true, count: items.length, items });
}
