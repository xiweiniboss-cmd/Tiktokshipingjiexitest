// Cloudflare Pages Function: 下载代理
// 中转 TikTok CDN 文件并加上 Content-Disposition，iPhone 上会弹出下载提示
// 仅允许 TikTok 相关域名，防止被当成公开代理滥用。
// 精确后缀匹配：host 等于某个域名，或以「.域名」结尾（以前用 includes 关键字，tiktok.com.evil.com 也能过）
const ALLOWED_HOSTS = [
  'tiktokcdn.com',
  'tiktokcdn-us.com',
  'tiktokcdn-eu.com',
  'tiktokv.com',
  'tiktokv.us',
  'tiktokv.eu',
  'tiktok.com',
  'tikwm.com',
  'byteoversea.com',
  'ibytedtos.com',
  'ibyteimg.com',
];
function hostAllowed(host) {
  host = String(host || '').toLowerCase().replace(/\.$/, '');
  if (ALLOWED_HOSTS.some((d) => host === d || host.endsWith('.' + d))) return true;
  // TikTok 部分视频走 Akamai，域名形如 v16m-default.akamaized.net / v19-webapp.akamaized.net：只放行这种 v<数字> 开头的
  return /^v\d+[a-z0-9-]*\.akamaized\.net$/.test(host);
}

export async function onRequest(context) {
  const sp = new URL(context.request.url).searchParams;
  const target = sp.get('url') || '';
  const filename = (sp.get('filename') || 'tiktok.mp4').replace(/["\r\n]/g, '').slice(0, 80) || 'tiktok.mp4';

  let u;
  try {
    u = new URL(target);
  } catch (e) {
    return new Response('bad url', { status: 400 });
  }
  if (!/^https?:$/.test(u.protocol)) return new Response('bad protocol', { status: 400 });
  if (!hostAllowed(u.hostname)) return new Response('host not allowed', { status: 403 });
  if (u.protocol === 'http:') u.protocol = 'https:';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const r = await fetch(u.toString(), {
      signal: ctrl.signal,
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
    return new Response('proxy error', { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
