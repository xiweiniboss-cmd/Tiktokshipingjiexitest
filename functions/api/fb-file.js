// 反馈附件查看（管理）：GET /api/fb-file?f=<key>&key=管理密码
// 附件类型白名单：浏览器传上来的 type 可被伪造，image/svg+xml 这类能带脚本的类型一律拒收
const SAFE_ATTACH_TYPE = /^(image\/(png|jpe?g|pjpeg|gif|webp|heic|heif|avif|bmp)|video\/[a-z0-9.+-]+)$/i;
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const adminKey = env.FEEDBACK_ADMIN_KEY || '';
  if (!adminKey || url.searchParams.get('key') !== adminKey)
    return new Response('无权访问', { status: 403 });
  if (!env.FEEDBACK_BUCKET) return new Response('未绑定存储', { status: 500 });
  const key = url.searchParams.get('f') || '';
  if (!key.startsWith('fb/') || key.includes('..'))
    return new Response('参数错误', { status: 400 });
  const obj = await env.FEEDBACK_BUCKET.get(key);
  if (!obj) return new Response('文件不存在', { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  // 附件是用户上传的：禁止嗅探、沙箱化；旧数据里不在白名单的类型（如 SVG）一律按附件下载，不在本站域名下渲染
  if (!SAFE_ATTACH_TYPE.test(headers.get('content-type') || '')) {
    headers.set('Content-Type', 'application/octet-stream');
    headers.set('Content-Disposition', 'attachment');
  }
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Cache-Control', 'private, max-age=3600');
  return new Response(obj.body, { headers });
}
