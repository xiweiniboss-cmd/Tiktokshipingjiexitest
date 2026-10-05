// Cloudflare Pages Function: 解析代理（三通道）
// 通道1: RapidAPI tiktok-api23（独立额度，需配置 RAPIDAPI_KEY 环境变量）
// 通道2: TikWM 公开接口（双域名+重试）
// 通道3: 直抓 TikTok 页面（备用）
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const RAPID_HOST = 'tiktok-api23.p.rapidapi.com';

export async function onRequest(context) {
  const target = new URL(context.request.url).searchParams.get('url');
  const env = context.env || {};

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

  // —— 通道1: RapidAPI（独立额度，最优先） ——
  if (env.RAPIDAPI_KEY) {
    try {
      const videoId = await resolveVideoId(target);
      if (videoId) {
        const data = await fetchRapidApi(env.RAPIDAPI_KEY, videoId);
        if (data) {
          data._source = 'rapidapi';
          return json({ code: 0, msg: 'success', data });
        }
      }
    } catch (e) {
      // 继续通道2
    }
  }

  // —— 通道2: TikWM（双域名 + 重试） ——
  const tikwmHosts = ['https://www.tikwm.com/api/', 'https://tikwm.com/api/'];
  for (const host of tikwmHosts) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const tw = await fetchTikwm(host, target);
        if (tw && tw.code === 0 && tw.data) {
          tw.data._source = 'tikwm';
          return json(tw);
        }
        if (tw && /parsing is failed|invalid/i.test(tw.msg || '')) {
          return json(tw);
        }
      } catch (e) {}
      if (attempt === 0) await new Promise((r) => setTimeout(r, 800));
    }
  }

  // —— 通道3: 直抓 TikTok 页面 ——
  try {
    const scraped = await scrapeTikTok(target);
    if (scraped) {
      return json({ code: 0, msg: 'success', data: scraped });
    }
  } catch (e) {}

  return json({
    code: -1,
    msg: '解析服务暂时不可用，请稍后再试',
  });
}

// 从分享链接提取视频 ID（完整链接直接正则，短链取跳转 Location）
async function resolveVideoId(shareUrl) {
  // 完整链接：/video/123 或 /photo/123
  let m = shareUrl.match(/\/(video|photo)\/(\d+)/);
  if (m) return m[2];

  // 短链：手动跟随一次跳转，读 Location 头
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(shareUrl, {
      headers: { 'User-Agent': MOBILE_UA },
      redirect: 'manual',
      signal: ctrl.signal,
    });
    const loc = r.headers.get('location') || r.headers.get('Location') || '';
    m = loc.match(/\/(video|photo)\/(\d+)/);
    if (m) return m[2];
    // 有些短链返回 200 + JS 跳转，尝试从 body 找
    if (r.ok) {
      const text = await r.text();
      m = text.match(/\/(video|photo)\/(\d+)/);
      if (m) return m[2];
    }
  } catch (e) {
  } finally {
    clearTimeout(timer);
  }
  return null;
}

async function fetchRapidApi(apiKey, videoId) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(
      `https://${RAPID_HOST}/api/post/detail?videoId=${encodeURIComponent(videoId)}`,
      {
        headers: {
          'x-rapidapi-key': apiKey,
          'x-rapidapi-host': RAPID_HOST,
        },
        signal: ctrl.signal,
      }
    );
    const j = await r.json();
    const item = j?.itemInfo?.itemStruct;
    if (!item) return null;

    const video = item.video || {};
    const author = item.author || {};
    const music = item.music || {};
    const base = {
      id: String(item.id || videoId),
      title: item.desc || 'TikTok 视频',
      cover: video.cover || '',
      origin_cover: video.originCover || '',
      author: { nickname: author.nickname || '', unique_id: author.uniqueId || '' },
      duration: video.duration || 0,
      music: music.playUrl || '',
      _source: 'rapidapi',
    };

    // 图集帖
    const postImages = item.imagePost?.images;
    if (postImages && postImages.length) {
      const images = postImages.map((img) => img?.imageURL?.urlList?.[0]).filter(Boolean);
      if (images.length) return { ...base, images };
    }

    // 视频帖：preview 用 CDN 直链（<video> 标签可直接播放），
    // 下载时再依次尝试 aweme 官方地址和其他 CDN 备用地址
    const urlList = video.PlayAddrStruct?.UrlList || [];
    const awemeUrl = urlList.find((u) => u.includes('/aweme/v1/play/'));
    const cdnUrls = [...new Set([video.playAddr, ...urlList.filter((u) => !u.includes('/aweme/v1/play/'))].filter(Boolean))];
    if (!cdnUrls.length) return null;
    return {
      ...base,
      play: cdnUrls[0],
      play_alts: [awemeUrl, ...cdnUrls.slice(1)].filter(Boolean),
      wmplay: video.downloadAddr || '',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTikwm(host, shareUrl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(host + '?url=' + encodeURIComponent(shareUrl), {
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

    const postImages = item.imagePost?.images;
    if (postImages && postImages.length) {
      const images = postImages
        .map((img) => img?.imageURL?.urlList?.[0])
        .filter(Boolean);
      if (images.length) return { ...base, images };
    }

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
