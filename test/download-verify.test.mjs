// 下载直链验证：TikWM 给的直链读不到（403）时，换 TikWM 自家 /video/media/play/<id>.mp4，验证通过才算解析成功
import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/parse.js';
import { sqliteD1 } from './helpers/d1.mjs';

async function parseWith(d1, handler) {
  const jobs = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => handler(String(u && u.url ? u.url : u));
  try {
    const request = new Request('https://x.pages.dev/api/parse?url=' + encodeURIComponent('https://www.tiktok.com/@a/video/7123'), { headers: { 'cf-connecting-ip': '198.51.100.' + Math.floor(Math.random() * 200 + 2) } });
    const r = await onRequest({ request, env: { TURNSTILE_DISABLED: '1', PARSE_DB: d1 }, waitUntil: (p) => jobs.push(p) });
    while (jobs.length) await jobs.shift();
    return r.json();
  } finally { globalThis.fetch = orig; }
}

test('所有下载地址都读不到：返回 code -2，不算成功；带水印的 wmplay 不会被拿来顶替', async () => {
  const d1 = sqliteD1();
  const seen = [];
  const j = await parseWith(d1, (u) => {
    seen.push(u);
    if (u.includes('tikwm.com/api/')) return new Response(JSON.stringify({ code: 0, msg: 'success', data: { id: '7123', title: 't', play: 'https://v16m.tiktokcdn.com/dead.mp4', wmplay: 'https://v16m.tiktokcdn.com/wm.mp4' } }));
    if (u.includes('wm.mp4')) return new Response(new Uint8Array(1024), { status: 206, headers: { 'content-type': 'video/mp4' } });
    return new Response('nope', { status: 403, headers: { 'content-type': 'text/html' } });
  });
  assert.equal(j.code, -2);
  assert.ok(!seen.some((u) => u.includes('wm.mp4')), 'wmplay 不应被验证或返回');
  const row = d1.db.prepare('SELECT ok FROM parse_log').get();
  assert.equal(row.ok, 0);
});

test('首个直链 403：自动换到能读到视频数据的备选地址', async () => {
  const d1 = sqliteD1();
  const jobs = [];
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (u, init) => {
    u = String(u && u.url ? u.url : u);
    seen.push(u);
    if (u.includes('tikwm.com/api/')) return new Response(JSON.stringify({ code: 0, msg: 'success', data: { id: '7123', title: 't', play: 'https://v16m.tiktokcdn.com/dead.mp4' } }));
    if (u.includes('dead.mp4')) return new Response('forbidden', { status: 403, headers: { 'content-type': 'text/html' } });
    if (u.includes('tikwm.com/video/media/play/7123.mp4')) return new Response(null, { status: 302, headers: { location: 'https://v19.tiktokcdn-us.com/good.mp4' } });
    if (u.includes('good.mp4')) return new Response(new Uint8Array(1024), { status: 206, headers: { 'content-type': 'video/mp4' } });
    return new Response('', { status: 404 });
  };
  try {
    const request = new Request('https://x.pages.dev/api/parse?url=' + encodeURIComponent('https://www.tiktok.com/@a/video/7123'), { headers: { 'cf-connecting-ip': '198.51.100.99' } });
    const r = await onRequest({ request, env: { TURNSTILE_DISABLED: '1', PARSE_DB: d1 }, waitUntil: (p) => jobs.push(p) });
    while (jobs.length) await jobs.shift();
    const j = await r.json();
    assert.equal(j.code, 0);
    assert.equal(j.data.play, 'https://www.tikwm.com/video/media/play/7123.mp4');
    assert.equal(j.data._verified, true);
    assert.ok(j.data.play_alts.includes('https://v16m.tiktokcdn.com/dead.mp4'));
  } finally { globalThis.fetch = orig; }
});
