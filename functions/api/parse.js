// Cloudflare Pages Function: 解析代理（双通道）
// 通道1: TikWM 公开接口（额度充足时最快，元数据最全）
// 通道2: 直抓 TikTok 视频页面内置 JSON（备用，不依赖第三方额度）
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

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
  if (!/tiktok\.com|vt\.tiktok|vm\.tiktok|tiktokv\.com/i.test(target)) {
    return json({ code: -1, msg: '链接看起来不像 TikTok 分享链接' }, 400);
  }

  // —— 通道1: TikWM ——
  try {
    const tw = await fetchTikwm(target);
    if (tw && tw.code === 0 && tw.data) {
      tw.data._source = 'tikwm';
      return json(tw);
    }
    // tikwm 返回了明确的"链接无效"时，直接返回，不再走备用通道浪费时间
    if (tw && /parsing is failed|invalid/i.test(tw.msg || '')) {
      return json(tw);
    }
    // 其他情况（额度用完、网络异常）继续走通道2
  } catch (e) {
    // 继续通道2
  }

  // —— 通道2: 直抓 TikTok 页面 ——
  try {
    const scraped = await scrapeTikTok(target);
    if (scraped) {
      return json({ code: 0, msg: 'success', data: scraped });
    }
  } catch (e) {
    // fall through
  }

  return json({
    code: -1,
    msg: '解析服务暂时不可用（主接口额度用完且备用通道失败），请稍后再试',
  });
}

async function fetchTikwm(shareUrl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch('https://www.tikwm.com/api/?url=' + encodeURIComponent(shareUrl), {
      headers: { 'User-Agent': MOBILE_UA },
      signal: ctrl.signal,
    });
    const text = await r.text();
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

async function scrapeTikTok(shareUrl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    // 直接请求分享链接，自动跟随短链跳转到完整视频页
    const r = await fetch(shareUrl, {
      headers: { 'User-Agent': MOBILE_UA, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error('tiktok page status ' + r.status);
    const html = await r.text();

    const m = html.match(
      /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/
    );
    if (!m) throw new Error('no rehydration data');

    const data = JSON.parse(m[1]);
    const detail = data?.__DEFAULT_SCOPE__?.['webapp.reflow.video.detail'];
    const item = detail?.itemInfo?.itemStruct;
    if (!item) throw new Error('no itemStruct');

    const video = item.video || {};
    const author = item.author || {};
    const music = item.music || {};
    const base = {
      id: String(item.id || ''),
      title: item.desc || 'TikTok 视频',
      cover: video.cover || '',
      origin_cover: video.originCover || '',
      author: { nickname: author.nickname || '', unique_id: author.uniqueId || '' },
      duration: video.duration || 0,
      music: music.playUrl || '',
      _source: 'scrape',
    };

    // 图集帖
    const postImages = item.imagePost?.images;
    if (postImages && postImages.length) {
      const images = postImages
        .map((img) => img?.imageURL?.urlList?.[0])
        .filter(Boolean);
      if (images.length) return { ...base, images };
    }

    // 视频帖：playAddr 即无水印地址
    if (!video.playAddr) throw new Error('no playAddr');
    return {
      ...base,
      play: video.playAddr,
      wmplay: video.downloadAddr || '',
    };
  } finally {
    clearTimeout(timer);
  }
}
