import { fetchAllowedHops } from '../../lib/security.js';
import { createParseLog } from '../../lib/parse-log.js';

// 被拉黑的 IP / 设备 / 指纹也不能下载（只查黑名单，不记）
const pl = createParseLog('tiktok');
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
  return pl.guard(context.request, context.env || {}, context, () => handleDl(context));
}
// Content-Disposition：filename 给 ASCII 兜底，filename* 给 UTF-8 原名（RFC 6266 / 5987）
function contentDisposition(type, name) {
  const raw = String(name || 'download').replace(/[\r\n"\\]/g, '').slice(0, 120) || 'download';
  const ascii = raw.replace(/[^\x20-\x7e]/g, '_').replace(/[;%]/g, '_') || 'download';
  const star = encodeURIComponent(raw).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return type + '; filename="' + ascii + '"; filename*=UTF-8\'\'' + star;
}

async function handleDl(context) {
  const req = context.request;
  const method = req.method;
  if (method !== 'GET' && method !== 'HEAD') return new Response('method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  const isHead = method === 'HEAD';
  const sp = new URL(req.url).searchParams;
  const target = sp.get('url') || '';
  const filename = (sp.get('filename') || 'tiktok.mp4').replace(/["\r\n]/g, '').slice(0, 80) || 'tiktok.mp4';
  const inline = sp.get('inline') === '1';

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
    const upHeaders = {
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      Referer: 'https://www.tiktok.com/',
    };
    // 转发客户端的 Range（拖进度条 / 断点 / 大小探测都靠它）；格式不对的 Range 直接忽略
    const range = req.headers.get('Range') || '';
    if (/^bytes=\d*-\d*(,\s*\d*-\d*)*$/.test(range)) upHeaders.Range = range;
    // 手动跟随跳转（最多 5 跳），每一跳都重新校验 https + 域名白名单
    const r = await fetchAllowedHops(u.toString(), {
      method: isHead ? 'HEAD' : 'GET',
      signal: ctrl.signal,
      headers: upHeaders,
    }, hostAllowed);
    if (!r) return new Response('host not allowed', { status: 403 });
    if (r.status === 416) {
      const h416 = new Headers({ 'Cache-Control': 'no-store' });
      const cr = r.headers.get('Content-Range');
      if (cr) h416.set('Content-Range', cr);
      return new Response(null, { status: 416, headers: h416 });
    }
    if (!r.ok || (!r.body && !isHead)) {
      // 记下媒体域名和上游状态码，方便在 Cloudflare 日志里看是哪一路给了不可用的直链
      try { console.log(JSON.stringify({ ev: 'tiktok_dl_fail', host: u.hostname, status: r.status })); } catch {}
      return new Response('upstream fetch failed: ' + r.status, { status: 502, headers: { 'X-Upstream-Status': String(r.status) } });
    }

    const h = new Headers();
    h.set('Content-Type', r.headers.get('Content-Type') || 'application/octet-stream');
    const len = r.headers.get('Content-Length');
    if (len) h.set('Content-Length', len);
    const ar = r.headers.get('Accept-Ranges');
    if (ar) h.set('Accept-Ranges', ar);
    let status = 200;
    if (r.status === 206) {
      status = 206;
      const cr = r.headers.get('Content-Range');
      if (cr) h.set('Content-Range', cr);
      h.set('Accept-Ranges', 'bytes');
    }
    h.set('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', filename));
    h.set('Cache-Control', 'no-store');
    h.set('X-Content-Type-Options', 'nosniff');
    if (isHead) { try { if (r.body) await r.body.cancel(); } catch {} }
    return new Response(isHead ? null : r.body, { status, headers: h });
  } catch (e) {
    return new Response('proxy error', { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
