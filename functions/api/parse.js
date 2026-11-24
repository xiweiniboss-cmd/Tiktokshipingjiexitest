import { ipLimitKey } from '../../lib/security.js';
import { rateTake, turnstileDisabled } from '../../lib/rate-limit.js';
import { createParseLog, plPass, plMeta } from '../../lib/parse-log.js';

// 解析记录 + 拉黑（D1 parse_log，绑定名 PARSE_DB，allfeedback 后台「解析记录」「黑名单」「解析失败」里看）；预览部署不提供解析
// 只记有效链接：和 handleParse 开头的本地校验同一套判断（空 / 没链接 / 不是 TikTok → 400，不记）
const pl = createParseLog('tiktok', { valid: (t) => { const l = String(t).trim() && extractFirstLink(t); return !!l && isTikTokUrl(l); } });
// Cloudflare Pages Function: 解析代理（三通道）
// 通道1: RapidAPI tiktok-api23（独立额度，需配置 RAPIDAPI_KEY 环境变量）
// 通道2: TikWM 公开接口（双域名+重试）
// 通道3: 直抓 TikTok 页面（备用）
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const RAPID_HOST = 'tiktok-api23.p.rapidapi.com';

// 只认 TikTok 自家域名（解析 hostname 后精确后缀匹配）
const TIKTOK_PAGE_HOSTS = ['tiktok.com', 'tiktokv.com'];
function isTikTokUrl(u) {
  try {
    const x = new URL(u);
    const h = x.hostname.toLowerCase().replace(/\.$/, '');
    return (x.protocol === 'https:' || x.protocol === 'http:') && TIKTOK_PAGE_HOSTS.some((d) => h === d || h.endsWith('.' + d));
  } catch {
    return false;
  }
}
// 从整段分享文字里抽出第一条 http(s) 链接（和其他站一致），去掉结尾的中英文标点
function extractFirstLink(text) {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>]+/i);
  if (!m) return '';
  return m[0].replace(/[),.;!?\]}>»」』】，。；：？！）、]+$/, '');
}
async function verifyTurnstile(token, secret, ip) {
  try {
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: ip || '' }),
    });
    const j = await resp.json();
    return j && j.success === true;
  } catch {
    return false;
  }
}

export async function onRequest(context) {
  const env = context.env || {};
  return pl.wrap(context.request, env, context, () => handleParse(context));
}

async function handleParse(context) {
  const rawInput = new URL(context.request.url).searchParams.get('url') || '';
  // 用户常贴整段分享文字：先抽第一条链接，再走域名白名单
  const target = extractFirstLink(rawInput);
  const env = context.env || {};

  const json = (obj, status) =>
    new Response(JSON.stringify(obj), {
      status: status || 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });

  if (!rawInput.trim()) return json({ code: -1, msg: '请先粘贴 TikTok 分享链接' }, 400);
  if (!target) return json({ code: -1, msg: '没有找到链接，请粘贴完整的 TikTok 分享链接' }, 400);
  if (!isTikTokUrl(target)) {
    return json({ code: -1, msg: '链接看起来不像 TikTok 分享链接' }, 400);
  }

  // 人机验证：配了 TURNSTILE_SECRET_KEY 才校验
  const tsSecret = String(env.TURNSTILE_SECRET_KEY || '').trim();
  if (!tsSecret && !turnstileDisabled(env)) return json({ code: -1, msg: '人机验证未配置，暂停解析' }, 503);
  if (tsSecret) {
    const tsToken = new URL(context.request.url).searchParams.get('turnstile') || '';
    if (!tsToken) return json({ code: -1, msg: '请先完成人机验证' }, 400);
    const ok = await verifyTurnstile(tsToken, tsSecret, context.request.headers.get('cf-connecting-ip') || '');
    if (!ok) return json({ code: -1, msg: '人机验证未通过，请重试' }, 403);
  }

  // 频控：冷却 60 秒 + 每 IP 每天 20 次。解析前原子占坑（D1），并发打不穿，失败也算一次
  const parseIp = context.request.headers.get('cf-connecting-ip') || '';
  const kv = env.FEEDBACK_KV;
  const deviceId = new URL(context.request.url).searchParams.get('deviceId') || '';
  const rl = await rateTake(env, 'tiktok', parseIp);
  if (!rl.ok) return json({ code: -1, msg: rl.msg }, rl.status);
  plPass(context.request); // 人机验证 + 冷却 + 每日次数都过了：这次解析才记进 D1 parse_log
  const succeed = async (obj) => {
    // 预览卡片（allfeedback「解析记录」）：封面 / 标题 / 类型（TikWM 偶尔给 /video/cover/… 相对路径，补成 tikwm.com 绝对地址）
    try {
      const d = (obj && obj.data) || {};
      let cover = String(d.cover || d.origin_cover || d.ai_dynamic_cover || '');
      if (/^\/[^/]/.test(cover) && d._source === 'tikwm') cover = 'https://www.tikwm.com' + cover;
      const imgs = Array.isArray(d.images) ? d.images : [];
      if (!cover && typeof imgs[0] === 'string') cover = imgs[0];
      plMeta(context.request, { cover, title: d.title, media: imgs.length ? (imgs.length > 1 ? 'images' : 'image') : 'video' });
    } catch {}
    // 本站解析次数统计（仅成功计数）
    if (kv) {
      try {
        const cur = Number((await kv.get('stats_parse_tiktok')) || 0);
        await kv.put('stats_parse_tiktok', String(cur + 1));
      } catch {}
    }
    // 解析者归属地分布（按站点+国家聚合）
    if (kv) {
      try {
        const cf = context.request.cf || {};
        const cc = String(cf.country || 'XX').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) || 'XX';
        const gk = 'geoparse_tiktok_' + cc;
        const gc = Number((await kv.get(gk)) || 0);
        await kv.put(gk, String(gc + 1));
      } catch {}
    }
    // 最近解析记录（保留最近 20 条）
    if (kv) {
      try {
        const cf2 = context.request.cf || {};
        let hist = [];
        try { hist = JSON.parse((await kv.get('parsehist_tiktok')) || '[]'); } catch {}
        if (!Array.isArray(hist)) hist = [];
        hist.unshift({
          t: Date.now(),
          ip: parseIp,
          dev: deviceId || '',
          cc: String(cf2.country || 'XX').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) || 'XX',
          region: cf2.region || '',
          city: cf2.city || '',
        });
        await kv.put('parsehist_tiktok', JSON.stringify(hist.slice(0, 20)));
      } catch {}
    }
    return json(obj);
  };

  // 「解析成功」不再等于「拿到地址」：视频帖先用小范围 GET 验证候选直链能读到视频数据，
  // 同一通道的地址都读不到就换下一个通道；所有通道都没验证通过时返回 code -2（不算成功、不进成功统计）。
  let unverified = false;
  const accept = async (data, source) => {
    data._source = source;
    const ok = await verifyPlayable(data, source);
    if (ok) return succeed({ code: 0, msg: 'success', data });
    unverified = true;
    return null;
  };

  // —— 通道1: RapidAPI（独立额度，最优先） ——
  if (env.RAPIDAPI_KEY) {
    try {
      const videoId = await resolveVideoId(target);
      if (videoId) {
        const data = await fetchRapidApi(env.RAPIDAPI_KEY, videoId);
        if (data) {
          const r = await accept(data, 'rapidapi');
          if (r) return r;
        }
      }
    } catch (e) {
      // 继续通道2
    }
  }

  // —— 通道2: TikWM（双域名 + 重试） ——
  const tikwmHosts = ['https://www.tikwm.com/api/', 'https://tikwm.com/api/'];
  tikwm: for (const host of tikwmHosts) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const tw = await fetchTikwm(host, target);
        if (tw && tw.code === 0 && tw.data) {
          const d = tw.data;
          // TikWM 自家的 /video/media/play/<id>.mp4 会 302 到新签发的 CDN 直链，放进备选。
          // 不放 wmplay：那是带水印的，页面承诺的是无水印下载。
          if (d.id && !d.images) {
            d.play_alts = [...new Set([...(d.play_alts || []), d.hdplay, 'https://www.tikwm.com/video/media/play/' + encodeURIComponent(String(d.id)) + '.mp4'].filter((u) => u && u !== d.play && u !== d.wmplay))];
          }
          const r = await accept(d, 'tikwm');
          if (r) return r;
          break tikwm; // 拿到了数据但直链读不到：换通道3，不再重复打 TikWM
        }
        if (tw && /parsing is failed|invalid/i.test(tw.msg || '')) {
          if (unverified) break tikwm;
          // 不再原样透传上游 msg（上游文本不可信），给固定中文提示
          return json({ code: -1, msg: '解析失败：链接无效，或视频已删除/设为私密' });
        }
      } catch (e) {}
      if (attempt === 0) await new Promise((r) => setTimeout(r, 800));
    }
  }

  // —— 通道3: 直抓 TikTok 页面 ——
  try {
    const scraped = await scrapeTikTok(target);
    if (scraped) {
      const r = await accept(scraped, 'scrape');
      if (r) return r;
    }
  } catch (e) {}

  if (unverified) {
    // 拿到了视频信息，但没有一个下载地址能读到数据：明确报错，别让调用方拿着坏链接去下载
    return json({ code: -2, msg: '找到了视频，但下载地址暂时都不可用，请稍后重新解析' });
  }
  return json({
    code: -1,
    msg: '解析服务暂时不可用，请稍后再试',
  });
}

// 允许验证 / 代理的媒体域名（与 /api/dl 保持一致）
const MEDIA_HOSTS = ['tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com', 'tiktokv.com', 'tiktokv.us', 'tiktokv.eu', 'tiktok.com', 'tikwm.com', 'byteoversea.com', 'ibytedtos.com', 'ibyteimg.com'];
function mediaHostAllowed(host) {
  host = String(host || '').toLowerCase().replace(/\.$/, '');
  if (MEDIA_HOSTS.some((d) => host === d || host.endsWith('.' + d))) return true;
  return /^v\d+[a-z0-9-]*\.akamaized\.net$/.test(host);
}

// 小范围 GET（只要前 1KB）：2xx 且不是 HTML/JSON 才算能下载。返回 { ok, status, host }
async function probeMedia(url, timeoutMs = 8000) {
  let host = '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(500, Math.min(8000, timeoutMs)));
  try {
    let cur = String(url);
    for (let hop = 0; hop <= 5; hop++) {
      const u = new URL(cur);
      host = u.hostname;
      if (u.protocol !== 'https:' || !mediaHostAllowed(host)) return { ok: false, status: 'host', host };
      const r = await fetch(u.toString(), {
        headers: { 'User-Agent': MOBILE_UA, Referer: 'https://www.tiktok.com/', Range: 'bytes=0-1023' },
        redirect: 'manual',
        signal: ctrl.signal,
      });
      const loc = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc) {
        try { if (r.body) await r.body.cancel(); } catch {}
        cur = new URL(loc, u).toString();
        continue;
      }
      try { if (r.body) await r.body.cancel(); } catch {}
      const ct = String(r.headers.get('content-type') || '');
      const ok = (r.status === 200 || r.status === 206) && !/html|json|text\//i.test(ct);
      return { ok, status: r.status, host };
    }
    return { ok: false, status: 'hops', host };
  } catch (e) {
    return { ok: false, status: e && e.name === 'AbortError' ? 'timeout' : 'error', host };
  } finally {
    clearTimeout(timer);
  }
}

// 每条通道的验证总时限：超了就直接换下一条通道，不让用户一直转圈
const PROBE_BUDGET_MS = 15000;
// 视频帖：依次验证 play + play_alts，第一个能读到数据的放到 play，其余能用的留在 play_alts；图集不验证
async function verifyPlayable(data, source) {
  if (Array.isArray(data.images) && data.images.length) return true;
  const cands = [...new Set([data.play, ...(data.play_alts || [])].filter((u) => typeof u === 'string' && /^https?:/i.test(u)))];
  const good = [];
  const log = [];
  const deadline = Date.now() + PROBE_BUDGET_MS;
  for (const u of cands) {
    const left = deadline - Date.now();
    if (left < 500) { log.push('budget'); break; }
    const p = await probeMedia(u, left);
    log.push(p.host + ':' + p.status);
    if (p.ok) {
      good.push(u);
      break; // 有一个能用就够了，剩下的不再逐个打（省时间），原样留作备选
    }
  }
  try { console.log(JSON.stringify({ ev: 'tiktok_probe', source, ok: good.length > 0, tries: log })); } catch {}
  if (!good.length) return false;
  const rest = cands.filter((u) => u !== good[0]);
  data.play = good[0];
  data.play_alts = rest;
  data._verified = true;
  return true;
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
    if (loc && !isTikTokUrl(new URL(loc, shareUrl).toString())) return null;
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
