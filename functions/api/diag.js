// 诊断接口：一次性测试各通道在 Cloudflare 网络下的真实状态
// 访问 /api/diag?url=<tiktok分享链接> 查看 JSON 诊断结果
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

async function timedFetch(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
  const t0 = Date.now();
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await r.text();
    return {
      ok: r.ok,
      status: r.status,
      finalUrl: r.url,
      ms: Date.now() - t0,
      size: text.length,
      head: text.slice(0, 200).replace(/\s+/g, ' '),
      hasRehydration: text.includes('__UNIVERSAL_DATA_FOR_REHYDRATION__'),
      hasPlayAddr: text.includes('playAddr'),
      isJson: text.trim().startsWith('{'),
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e), ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

export async function onRequest(context) {
  const target = new URL(context.request.url).searchParams.get('url') || '';
  const H = {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  };

  const out = { target, time: new Date().toISOString(), tests: {} };

  // 1. tikwm 主接口
  try {
    const tw = await timedFetch(
      'https://www.tikwm.com/api/?url=' + encodeURIComponent(target),
      { headers: { 'User-Agent': MOBILE_UA } },
      15000
    );
    out.tests.tikwm = {
      ok: tw.ok,
      status: tw.status,
      ms: tw.ms,
      size: tw.size,
      head: (tw.head || '').slice(0, 120),
      isJson: tw.isJson,
      error: tw.error,
    };
    // 尝试解析完整 JSON 的 code/msg
    try {
      const full = await (
        await fetch('https://www.tikwm.com/api/?url=' + encodeURIComponent(target), {
          headers: { 'User-Agent': MOBILE_UA },
        })
      ).text();
      const j = JSON.parse(full);
      out.tests.tikwm.code = j.code;
      out.tests.tikwm.msg = j.msg;
      out.tests.tikwm.hasData = !!j.data;
    } catch (e) {
      out.tests.tikwm.parseError = String(e.message || e);
    }
  } catch (e) {
    out.tests.tikwm = { error: String(e.message || e) };
  }

  // 1b. tikwm 不带 www 域名（可能是独立额度池）
  try {
    const full = await (
      await fetch('https://tikwm.com/api/?url=' + encodeURIComponent(target), {
        headers: { 'User-Agent': MOBILE_UA },
      })
    ).text();
    const j = JSON.parse(full);
    out.tests.tikwm_nowww = {
      ok: true,
      code: j.code,
      msg: j.msg,
      hasData: !!j.data,
      head: full.slice(0, 120),
    };
  } catch (e) {
    out.tests.tikwm_nowww = { ok: false, error: String(e.message || e) };
  }

  // 2a. 直抓 www.tiktok.com（短链自动跳转）
  out.tests.scrape_www = await timedFetch(
    target,
    { headers: { 'User-Agent': MOBILE_UA, Accept: 'text/html,application/xhtml+xml' }, redirect: 'follow' },
    20000
  );

  // 2b. 直抓 m.tiktok.com（移动端站点，防护可能不同）
  // 先解析出视频ID
  const idMatch = (out.tests.scrape_www.finalUrl || target).match(/\/(video|photo)\/(\d+)/);
  if (idMatch) {
    out.tests.scrape_m = await timedFetch(
      'https://m.tiktok.com/v/' + idMatch[2] + '.html',
      { headers: { 'User-Agent': MOBILE_UA, Accept: 'text/html,application/xhtml+xml' }, redirect: 'follow' },
      20000
    );
  } else {
    out.tests.scrape_m = { skipped: 'no video id resolved' };
  }

  // 3. oEmbed（看元数据通道是否通）
  out.tests.oembed = await timedFetch(
    'https://www.tiktok.com/oembed?url=' + encodeURIComponent(target),
    { headers: { 'User-Agent': MOBILE_UA } },
    15000
  );

  return new Response(JSON.stringify(out, null, 2), H);
}
