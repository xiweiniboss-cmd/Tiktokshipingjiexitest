import { serveAdminPage } from '../lib/security.js';
// 反馈管理后台：GET /admin（先在登录页输入管理密码，之后凭 HttpOnly Cookie 访问）
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>反馈管理</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,"PingFang SC",sans-serif;background:#0f0f12;color:#f1f1f2}
.wrap{max-width:640px;margin:0 auto;padding:16px 14px 60px}
h1{font-size:20px;margin:8px 0 4px}h1 span{font-size:13px;color:#9a9aa3;font-weight:400}
.fb{background:#1a1a20;border:1px solid #2a2a32;border-radius:12px;padding:12px 14px;margin-top:12px}
.fb .meta{font-size:12px;color:#9a9aa3;margin-bottom:6px}
.fb .site{font-size:11px;color:#25F4EE}
.fb .msg{font-size:14px;line-height:1.7;white-space:pre-wrap;word-break:break-word}
.fb button{margin-top:8px;background:#2a2a32;border:none;border-radius:8px;padding:8px 16px;font-size:13px;color:#ff8fa3}
.empty{text-align:center;color:#9a9aa3;margin-top:40px;font-size:14px}
</style></head>
<body><div class="wrap">
<h1>用户反馈 <span id="count"></span></h1>
<div style="margin:6px 0 4px"><a href="/dashboard" id="dashLink" style="font-size:13px;color:#FE2C55">📊 数据总览</a></div>
 <a href="#" id="logoutLink" style="font-size:13px;color:#999;margin-left:10px">退出登录</a>
<script>document.getElementById('logoutLink').onclick = function(e){ e.preventDefault(); fetch('/api/admin/logout', { method: 'POST' }).then(function(){ location.reload(); }); };</script>
<div id="list">加载中…</div>
</div><script>
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const COUNTRY_ZH = {CN:'中国',US:'美国',JP:'日本',KR:'韩国',HK:'香港',TW:'台湾',MO:'澳门',SG:'新加坡',GB:'英国',DE:'德国',FR:'法国',IT:'意大利',ES:'西班牙',CA:'加拿大',AU:'澳大利亚',NZ:'新西兰',RU:'俄罗斯',IN:'印度',BR:'巴西',MX:'墨西哥',AR:'阿根廷',KR:'韩国',TH:'泰国',MY:'马来西亚',ID:'印度尼西亚',PH:'菲律宾',VN:'越南',TR:'土耳其',AE:'阿联酋',SA:'沙特',EG:'埃及',ZA:'南非',NL:'荷兰',SE:'瑞典',NO:'挪威',FI:'芬兰',DK:'丹麦',PL:'波兰',UA:'乌克兰',CH:'瑞士',AT:'奥地利',BE:'比利时',IE:'爱尔兰',PT:'葡萄牙',GR:'希腊',CZ:'捷克',HU:'匈牙利',RO:'罗马尼亚',IL:'以色列',KZ:'哈萨克斯坦'};
function geoName(it){
  const g = it.geo || {};
  if(!g.country && !g.region && !g.city) return '';
  const c = COUNTRY_ZH[g.country] || g.country || '';
  return [c, g.region, g.city].filter(Boolean).join('·');
}
const siteName = (p) => {
  try {
    const h = new URL(p).hostname.toLowerCase();
    if (h.includes('tiktok')) return 'TikTok站';
    if (h.includes('xiaohongshu')) return '小红书站';
    if (h.includes('douyin')) return '抖音站';
    if (h.includes('youtube')) return 'YouTube站';
    if (h.includes('bilibili')) return 'B站站';
    if (h.includes('kuaishou')) return '快手站';
    if (h.includes('weibo')) return '微博站';
    if (h.includes('deepseek')) return 'DeepSeek站';
    return h;
  } catch { return ''; }
};
async function load() {
  const box = document.getElementById('list');
  try {
    const r = await fetch('/api/feedback/list');
    const j = await r.json();
    if (!j.ok) { box.innerHTML = '<div class="empty">加载失败：' + esc(j.error) + '</div>'; return; }
    document.getElementById('count').textContent = '共 ' + j.count + ' 条';
    if (!j.items.length) { box.innerHTML = '<div class="empty">暂无反馈</div>'; return; }
    box.innerHTML = '';
    for (const it of j.items) {
      const d = document.createElement('div');
      d.className = 'fb';
      const t = new Date(it.time).toLocaleString('zh-CN', { hour12: false });
      d.innerHTML = '<div class="meta"><span class="site">[' + esc(siteName(it.page)) + ']</span> ' + esc(t) +
        (it.contact ? ' · ' + esc(it.contact) : '') + (it.ip ? ' · IP: ' + esc(it.ip) : '') + (geoName(it) ? ' (' + esc(geoName(it)) + ')' : '') + '</div>' +
        (it.kind ? '<div class="kind" style="font-size:12px;color:#ff8a00;margin-bottom:4px">【' + esc(it.kind) + '】</div>' : '') +
        '<div class="msg">' + esc(it.message) + '</div>' +
        (it.link ? '<div class="link" style="font-size:12px;color:#888;margin-top:6px;white-space:pre-wrap;word-break:break-all">当前输入：' + esc(it.link) + '</div>' : '');
      const copyBtn = document.createElement('button');
      copyBtn.textContent = '📋 复制文本';
      copyBtn.style.cssText = 'margin-top:8px;background:#f0f0f2;border:none;border-radius:8px;padding:8px 16px;font-size:13px;color:#333;cursor:pointer';
      copyBtn.onclick = function(){
        const txt = it.message || '';
        const done = function(){ copyBtn.textContent = '✅ 已复制'; setTimeout(function(){ copyBtn.textContent = '📋 复制文本'; }, 1500); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(txt).then(done).catch(function(){ alert('复制失败'); });
        } else { alert('当前浏览器不支持一键复制'); }
      };
      d.appendChild(copyBtn);
      if (it.attachments && it.attachments.length) {
        const att = document.createElement('div');
        for (const a of it.attachments) {
          const src = '/api/fb-file?f=' + encodeURIComponent(a.key);
          const fname = esc(String(a.name || 'attachment'));
          if (String(a.type || '').startsWith('image/')) {
            att.innerHTML += '<img src="' + src + '" style="max-width:100%;border-radius:8px;margin-top:8px;display:block" loading="lazy">';
          } else {
            att.innerHTML += '<video src="' + src + '" controls playsinline style="max-width:100%;border-radius:8px;margin-top:8px;display:block"></video>';
          }
          att.innerHTML += '<a href="' + src + '" download="' + fname + '" style="display:inline-block;margin-top:6px;background:#f0f0f2;border-radius:8px;padding:8px 16px;font-size:13px;color:#333;text-decoration:none">⬇ 下载</a>';
        }
        d.appendChild(att);
      }
      const btn = document.createElement('button');
      btn.textContent = '删除';
      btn.onclick = async () => {
        if (!confirm('删除这条反馈？')) return;
        let r = null, j = null;
        try { r = await fetch('/api/feedback?id=' + encodeURIComponent(it.id), { method: 'DELETE' }); j = await r.json().catch(() => null); } catch (e) {}
        if (r && (r.status === 401 || r.status === 403)) { alert('登录已过期，请重新登录'); location.href = '/admin'; return; }
        if (!r || !r.ok || !j || !j.ok) { alert('删除失败：' + ((j && j.error) || (r ? 'HTTP ' + r.status : '网络错误'))); return; }
        load();
      };
      d.appendChild(btn);
      box.appendChild(d);
    }
  } catch (e) { box.innerHTML = '<div class="empty">网络错误</div>'; }
}
load();
<\/script></body></html>`;

export async function onRequestGet(context) {
  // 未登录给登录页；旧书签带的密码参数校验后换成 HttpOnly Cookie 并跳转去掉地址栏密码
  return serveAdminPage(context.request, context.env, ADMIN_HTML);
}
