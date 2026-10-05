// Cloudflare Pages Function: 解析代理
// 把浏览器请求转发给 TikWM 接口，解决部分地区直连被拦截的问题
export async function onRequest(context) {
  const target = new URL(context.request.url).searchParams.get('url');

  const json = (obj, status) =>
    new Response(JSON.stringify(obj), {
      status: status || 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    });

  if (!target) return json({ code: -1, msg: 'missing url param' }, 400);

  try {
    const r = await fetch('https://www.tikwm.com/api/?url=' + encodeURIComponent(target), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      },
    });
    const text = await r.text();
    // 确保上游返回的是 JSON，否则给出明确错误
    try {
      JSON.parse(text);
    } catch (e) {
      return json({ code: -1, msg: '上游接口返回异常（非 JSON），可能被拦截' }, 502);
    }
    return new Response(text, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return json({ code: -1, msg: '代理请求失败: ' + (e.message || e) }, 502);
  }
}
