import { isAdmin, ipLimitKey } from '../../lib/security.js';
// 附件类型白名单：浏览器传上来的 type 可被伪造，image/svg+xml 这类能带脚本的类型一律拒收
const SAFE_ATTACH_TYPE = /^(image\/(png|jpe?g|pjpeg|gif|webp|heic|heif|avif|bmp)|video\/[a-z0-9.+-]+)$/i;
// 反馈提交（POST）+ 删除（DELETE）
// 存储：KV（FEEDBACK_KV），附件：R2（FEEDBACK_BUCKET）
// 与小红书站共用同一 KV/R2，管理后台任选一边查看即可
const json = (obj, status) =>
  new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });

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


// 反馈字段长度：message 只算用户自己写的；问题类型 kind、当前输入 link 单独存
const FB_MSG_MAX = 2000;
const FB_LEGACY_MAX = 3000; // 兼容旧前端把类型和链接拼进 message
const FB_KIND_MAX = 20;
const FB_LINK_MAX = 800;
const FB_FILE_MAX = 20 * 1024 * 1024;
// page 只收 http/https 地址，其他（javascript: 等）直接丢掉
function fbSafePage(p) {
  p = String(p || '').trim().slice(0, 200);
  try {
    const u = new URL(p);
    return u.protocol === 'https:' || u.protocol === 'http:' ? p : '';
  } catch {
    return '';
  }
}
export async function onRequestPost(context) {
  return handleFeedbackSubmit(context.request, context.env);
}
async function handleFeedbackSubmit(request, env) {
  if (!env.FEEDBACK_KV) return json({ ok: false, error: '反馈功能暂未启用' }, 500);
  const ct = request.headers.get('content-type') || '';
  let message = '',
    contact = '',
    page = '',
    kind = '',
    link = '',
    tsToken = '',
    files = [];
  const pick = (get) => {
    message = String(get('message') || '').trim();
    contact = String(get('contact') || '').trim().slice(0, 120);
    page = String(get('page') || '');
    kind = String(get('kind') || '').replace(/[\r\n]+/g, ' ').trim().slice(0, FB_KIND_MAX);
    link = String(get('link') || '').trim().slice(0, FB_LINK_MAX);
  };
  if (ct.includes('multipart/form-data')) {
    let form;
    try {
      form = await request.formData();
    } catch {
      return json({ ok: false, error: '请求格式错误' }, 400);
    }
    pick((k) => form.get(k));
    tsToken = String(form.get('cf-turnstile-response') || '');
    files = form.getAll('files').filter((f) => f && typeof f !== 'string' && f.size > 0);
  } else {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: '请求格式错误' }, 400);
    }
    if (!body || typeof body !== 'object') return json({ ok: false, error: '请求格式错误' }, 400);
    pick((k) => body[k]);
    tsToken = String(body['cf-turnstile-response'] || body.tsToken || '');
  }
  page = fbSafePage(page);
  if (!message && kind) message = '（未写具体描述）';
  if (!message) return json({ ok: false, error: '请填写反馈内容' }, 400);
  // 2000 字只算用户自己写的内容；旧前端会把问题类型和链接拼进 message，没带 kind/link 时放宽到 3000
  const msgMax = kind || link ? FB_MSG_MAX : FB_LEGACY_MAX;
  if (message.length > msgMax) return json({ ok: false, error: '内容太长，请精简到 2000 字以内' }, 400);
  // 附件先全部校验（数量 / 类型 / 大小），一个不合格就整单拒绝，不会先传一半
  if (files.length > 3) return json({ ok: false, error: '最多上传 3 个附件' }, 400);
  for (const f of files) {
    if (!SAFE_ATTACH_TYPE.test(f.type || '')) return json({ ok: false, error: '只支持图片和视频附件' }, 400);
    if (f.size > FB_FILE_MAX) return json({ ok: false, error: '单个附件不能超过 20MB' }, 400);
  }

  const tsSecret = String(env.TURNSTILE_SECRET_KEY || '').trim();
  if (tsSecret) {
    if (!tsToken) return json({ ok: false, error: '请先完成人机验证' }, 400);
    const tsOk = await verifyTurnstile(tsToken, tsSecret, request.headers.get('cf-connecting-ip') || '');
    if (!tsOk) return json({ ok: false, error: '人机验证未通过，请重试' }, 403);
  }

  const COOLDOWN_SECS = 600;
  const clientIp = request.headers.get('cf-connecting-ip') || '';
  const coolKey = clientIp ? 'cool_tiktok_' + ipLimitKey(clientIp) : '';
  if (coolKey) {
    let lastTs = null;
    try { lastTs = await env.FEEDBACK_KV.get(coolKey); } catch {} // KV 读失败不挡用户
    if (lastTs) {
      const remain = COOLDOWN_SECS - Math.floor((Date.now() - Number(lastTs)) / 1000);
      if (remain > 0)
        return json(
          { ok: false, error: `提交太频繁，请 ${Math.max(1, Math.ceil(remain / 60))} 分钟后再试` },
          429
        );
    }
  }

  const id = 'fb_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const attachments = [];
  const uploaded = [];
  // 任何一步存储失败：把这次已经传上去的附件删掉，返回 JSON 错误（不再抛异常变成 Cloudflare 错误页）
  const cleanup = async () => {
    for (const k of uploaded) {
      try { await env.FEEDBACK_BUCKET.delete(k); } catch {}
    }
  };
  const storageFail = () => json({ ok: false, code: 'STORAGE_FAILED', error: '存储失败，请稍后重试' }, 500);
  if (files.length) {
    if (!env.FEEDBACK_BUCKET) return json({ ok: false, error: '附件功能暂未启用' }, 500);
    try {
      for (const f of files) {
        const type = f.type || '';
        const ext =
          (String(f.name || '').split('.').pop() || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) ||
          'bin';
        const key = `fb/${id}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
        await env.FEEDBACK_BUCKET.put(key, f.stream(), {
          httpMetadata: { contentType: type },
        });
        uploaded.push(key);
        attachments.push({ key, type, name: String(f.name || '').slice(0, 80), size: f.size });
      }
    } catch {
      await cleanup();
      return storageFail();
    }
  }

  const record = {
    id,
    message: message.slice(0, msgMax),
    kind,
    link,
    contact,
    page,
    attachments,
    ua: (request.headers.get('user-agent') || '').slice(0, 200),
    ip: clientIp,
    geo: {
      country: (request.cf && request.cf.country) || '',
      region: (request.cf && request.cf.region) || '',
      city: (request.cf && request.cf.city) || '',
    },
    time: new Date().toISOString(),
  };
  try {
    await env.FEEDBACK_KV.put(id, JSON.stringify(record));
  } catch {
    await cleanup();
    return storageFail();
  }
  if (coolKey) {
    try {
      await env.FEEDBACK_KV.put(coolKey, String(Date.now()), { expirationTtl: COOLDOWN_SECS });
    } catch {}
  }
  return json({ ok: true });
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!(await isAdmin(request, env))) return json({ ok: false, error: '无权访问' }, 403);
  if (!env.FEEDBACK_KV) return json({ ok: false, error: '未绑定 KV' }, 500);
  const id = url.searchParams.get('id') || '';
  if (!/^fb_[a-z0-9_]+$/i.test(id)) return json({ ok: false, error: '参数错误' }, 400);
  try {
    const v = (await env.FEEDBACK_KV.get(id)) || (await env.FEEDBACK_KV.get('feedback_' + id));
    if (v) {
      const rec = JSON.parse(v);
      if (env.FEEDBACK_BUCKET && Array.isArray(rec.attachments)) {
        for (const a of rec.attachments) {
          try {
            await env.FEEDBACK_BUCKET.delete(a.key);
          } catch {
            /* ignore */
          }
        }
      }
    }
  } catch {
    /* ignore */
  }
  await env.FEEDBACK_KV.delete(id);
  await env.FEEDBACK_KV.delete('feedback_' + id); // 快手旧版记录
  return json({ ok: true });
}
