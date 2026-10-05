// Cloudflare Pages Function: 下载代理
// 中转 TikTok CDN 文件并加上 Content-Disposition，iPhone 上会弹出下载提示
// 仅允许 TikTok 相关域名，防止被当成公开代理滥用
const ALLOWED_HOST_KEYWORDS = [
  'tiktokcdn',
  'tiktokv',
  'tikwm',
  'tiktok.com',
  'byteoversea',
  'akamaized',
];

export async function onRequest(context) {
  const sp = new URL(context.request.url).searchParams;
  const target = sp.get('url') || '';
  const filename = (sp.get('filename') || 'tiktok.mp4').replace(/["\r\n]/g, '');

  let u;
  try {
    u = new URL(target);
  } catch (e) {
    return new Response('bad url', { status: 400 });
  }
  if (!/^https?:$/.test(u.protocol)) return new Response('bad protocol', { status: 400 });

  const host = u.hostname.toLowerCase();
  if (!ALLOWED_HOST_KEYWORDS.some((k) => host.includes(k))) {
    return new Response('host not allowed', { status: 403 });
  }

  try {
    const r = await fetch(target, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        Referer: 'https://www.tiktok.com/',
      },
    });
    if (!r.ok || !r.body) return new Response('upstream fetch failed: ' + r.status, { status: 502 });

    const ct = r.headers.get('Content-Type') || 'application/octet-stream';
    return new Response(r.body, {
      headers: {
        'Content-Type': ct,
        'Content-Disposition': 'attachment; filename="' + filename + '"',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return new Response('proxy error: ' + (e.message || e), { status: 502 });
  }
}
