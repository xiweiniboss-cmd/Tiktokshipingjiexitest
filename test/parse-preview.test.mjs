// 解析记录预览卡片（parse-log v3）：成功解析把封面 / 标题 / 类型写进 D1；线上库没迁移时照样能写
import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/parse.js';
import { sqliteD1 } from './helpers/d1.mjs';

let ipN = 20;
async function run(d1, data) {
  const jobs = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => String(u && u.url ? u.url : u).includes('tikwm.com/api/') ? new Response(JSON.stringify({ code: 0, msg: 'success', data })) : new Response('', { status: 404 });
  try {
    const request = new Request('https://tiktokshipingjiexitest.pages.dev/api/parse?url=' + encodeURIComponent('https://www.tiktok.com/@a/video/7123456789012345678'), { headers: { 'cf-connecting-ip': '198.51.100.' + (ipN++) } });
    const r = await onRequest({ request, env: { TURNSTILE_DISABLED: '1', PARSE_DB: d1 }, waitUntil: (p) => jobs.push(p) });
    while (jobs.length) await jobs.shift();
    return r;
  } finally { globalThis.fetch = orig; }
}
const migrate = (d1) => d1.db.exec("ALTER TABLE parse_log ADD COLUMN cover TEXT DEFAULT ''; ALTER TABLE parse_log ADD COLUMN title TEXT DEFAULT ''; ALTER TABLE parse_log ADD COLUMN media TEXT DEFAULT '';");

test('TikWM 视频：相对路径封面补成 tikwm.com 绝对地址，标题 + video', async () => {
  const d1 = sqliteD1(); migrate(d1);
  const r = await run(d1, { title: 'TikTok 标题', cover: '/video/cover/7123.webp', play: 'https://v16m.tiktokcdn.com/a.mp4' });
  assert.equal((await r.json()).code, 0);
  const row = d1.db.prepare('SELECT ok, cover, title, media FROM parse_log').get();
  assert.deepEqual({ ...row }, { ok: 1, cover: 'https://www.tikwm.com/video/cover/7123.webp', title: 'TikTok 标题', media: 'video' });
});

test('图集：类型 images', async () => {
  const d1 = sqliteD1(); migrate(d1);
  await run(d1, { title: '图', cover: 'https://p16-sign.tiktokcdn.com/c.jpg', images: ['https://p16.tiktokcdn.com/1.jpg', 'https://p16.tiktokcdn.com/2.jpg'] });
  const row = d1.db.prepare('SELECT cover, media FROM parse_log').get();
  assert.deepEqual({ ...row }, { cover: 'https://p16-sign.tiktokcdn.com/c.jpg', media: 'images' });
});

test('线上库还没迁移：照样记一行（退回旧列），解析响应不受影响', async () => {
  const d1 = sqliteD1();
  const r = await run(d1, { title: 't', cover: 'https://p16-sign.tiktokcdn.com/c.jpg', play: 'https://v16m.tiktokcdn.com/a.mp4' });
  assert.equal((await r.json()).code, 0);
  const rows = d1.db.prepare('SELECT ok FROM parse_log').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ok, 1);
});
