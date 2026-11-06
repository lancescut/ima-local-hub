'use strict';
let ST = null;                 // /api/status 快照
let remoteBackends = [];       // 用户在 UI 添加的远程后端
let chosenModel = '';
const $ = id => document.getElementById(id);

async function api(p, opt) { const r = await fetch(p, opt); return r.json(); }

async function refresh() {
  try { ST = await api('/api/status'); render(); } catch {}
}

function render() {
  $('ver').textContent = ST.version || '';
  renderHero(); renderAlerts(); renderDetect(); renderEntrances(); renderModels();
  renderInstall(); renderImaCard(); renderHealth();
}

function renderHero() {
  const h = ST.health || {};
  const items = [];
  const tsOn = ST.installed && (ST.imaCard?.urls || []).some(u => u.includes('.ts.net'));
  const cfOn = ST.installed && (ST.imaCard?.urls || []).some(u => u.includes('trycloudflare'));
  items.push(pill('服务', ST.installed ? 'on' : 'warn', ST.installed ? '运行中' : '待安装'));
  if (tsOn) items.push(pill('Tailscale 入口', h.tailscale?.ok ? 'on' : 'off', h.tailscale?.ok ? '正常' : `异常 ${h.tailscale?.reason || ''}`));
  if (cfOn) items.push(pill('Cloudflare 入口', h.cloudflared?.ok ? 'on' : 'off', h.cloudflared?.ok ? '正常' : `异常 ${h.cloudflared?.reason || ''}`));
  if (ST.verify?.verifiedAt) items.push(pill('ima', 'on', '已接通'));
  $('heroStatus').innerHTML = items.join('');
}
const pill = (name, cls, txt) => `<span class="pill"><span class="dot ${cls}"></span>${name} · ${txt}</span>`;

function renderAlerts() {
  const box = $('alertBox');
  const items = (ST.alerts || []).slice(0, 2);
  if (!items.length) { box.innerHTML = ''; return; }
  box.innerHTML = items.map(a => `<div class="banner ${a.type === 'verify-ok' ? 'ok' : 'warn'}">${a.type === 'verify-ok' ? '✅' : '⚠️'} ${esc(a.msg)}<button class="x" onclick="this.parentNode.remove()">×</button></div>`).join('');
}

function renderDetect() {
  const d = ST.detect; if (!d) return;
  const chips = [];
  const ts = d.tailscale || {};
  chips.push(chip('Tailscale', ts.installed ? (ts.logged ? `<span class="st-ok">已登录</span>` : `<span class="st-warn">未登录</span>`) : '<span class="st-bad">未安装</span>', ts.installed ? '点击「登录」见高级项' : '官网下载安装'));
  chips.push(chip('cloudflared', d.cloudflared?.installed ? `<span class="st-ok">已安装</span>` : '<span class="st-bad">未安装</span>', d.cloudflared?.version || '可选入口'));
  const om = (d.ollama?.models || []).map(m => m.name).join('、');
  chips.push(chip('本机 Ollama', d.ollama?.running ? `<span class="st-ok">运行中</span>` : (d.ollama?.installed ? '<span class="st-warn">未运行</span>' : '<span class="st-bad">未安装</span>'), om || '—'));
  chips.push(chip('GPU', '', (d.hardware?.gpu || []).slice(0, 2).join(', ') || d.hardware?.summary || 'CPU 推理'));
  $('detectChips').innerHTML = chips.join('');
}
const chip = (name, st, val) => `<div class="chip"><div class="name"><span>${name}</span><span>${st}</span></div><div class="val">${esc(val)}</div></div>`;

function renderEntrances() {
  const d = ST.detect; if (!d) return;
  const box = $('entranceOpts');
  if (box.dataset.built !== '1') {
    box.innerHTML = `
      <label class="opt on" id="optTs"><input type="checkbox" checked onchange="this.parentNode.classList.toggle('on',this.checked)">
        <div><div class="t">Tailscale Funnel <span class="tag">推荐 · 永久地址</span></div>
        <div class="d">地址永久不变，重启/断网自动恢复，需已登录 Tailscale</div></div></label>
      <label class="opt ${d.cloudflared?.installed ? 'on' : 'dis'}" id="optCf">
        <input type="checkbox" ${d.cloudflared?.installed ? 'checked' : 'disabled'} ${d.cloudflared?.installed ? '' : 'disabled'} onchange="this.parentNode.classList.toggle('on',this.checked)">
        <div><div class="t">Cloudflare 隧道 <span class="tag">备用入口</span></div>
        <div class="d">${d.cloudflared?.installed ? '免费临时地址（变更时自动提醒）' : '未安装 cloudflared，可从 Cloudflare 官网下载'}</div></div></label>`;
    box.dataset.built = '1';
  }
  $('optTs').classList.toggle('dis', !d.tailscale.installed);
  $('optTs').querySelector('input').disabled = !d.tailscale.installed;
}

function renderModels() {
  const sel = $('modelSel'); if (!sel) return;
  const d = ST.detect;
  const models = [];
  if (d?.ollama?.running) models.push(...(d.ollama.models || []).map(m => m.name));
  for (const b of (ST.backends || [])) models.push(...(b.models || []));
  for (const r of remoteBackends) models.push(r.model);
  const uniq = [...new Set(models)];
  if (uniq.length && ![...sel.options].some(o => uniq.includes(o.value))) {
    sel.innerHTML = uniq.map(m => `<option ${m === chosenModel ? 'selected' : ''}>${esc(m)}</option>`).join('');
    if (!chosenModel && uniq.length) chosenModel = uniq[0];
  }
}

function renderInstall() {
  const done = ST.install && ST.install.done;
  $('setupCard').classList.toggle('hidden', !!ST.installed);
  const st = $('steps');
  if (ST.install) {
    st.classList.remove('hidden');
    st.innerHTML = ST.install.steps.map(s =>
      `<div class="step ${s.status}"><span class="ic">${s.status === 'done' ? '✓' : s.status === 'error' ? '!' : ''}</span>${esc(s.name)}<span class="detail">${esc(s.detail || '')}</span></div>`).join('');
  }
  if (ST.install && !done) { $('installBtn').disabled = true; $('installBtn').innerHTML = '<span class="spin"></span> 安装中…'; }
  else { $('installBtn').disabled = false; $('installBtn').textContent = ST.installed ? '重新安装 / 更新' : '一键安装'; }
}

function renderImaCard() {
  const c = ST.imaCard;
  const show = ST.installed && c && c.urls.length;
  $('imaCardBox').classList.toggle('hidden', !show);
  if (!show) return;
  $('vUrl').textContent = c.urls[0];
  $('vKey').textContent = c.apiKey;
  $('vModel').textContent = chosenModel || (c.models[0] || '');
  if (ST.verify?.verifiedAt) { $('verifiedBanner').classList.remove('hidden'); $('verifyBtn').disabled = true; $('verifyMsg').textContent = '已验证'; }
}

function renderHealth() {
  const h = ST.health || {}; const chips = [];
  if (h.tailscale) chips.push(chip('Tailscale 入口', h.tailscale.ok ? '<span class="st-ok">可达</span>' : `<span class="st-bad">${h.tailscale.reason}</span>`, h.tailscale.url || ''));
  if (h.cloudflared) chips.push(chip('Cloudflare 入口', h.cloudflared.ok ? '<span class="st-ok">可达</span>' : `<span class="st-bad">${h.cloudflared.reason}</span>`, h.cloudflared.url || ''));
  chips.push(chip('代理请求数', '', String(ST.stats?.proxyRequests ?? 0)));
  if (!chips.length) chips.push(chip('等待安装', '', '安装后开始巡检'));
  $('healthChips').innerHTML = chips.join('');
}

// ---------- 动作 ----------
async function redetect() { await api('/api/detect', { method: 'POST' }); refresh(); }
function toggleRemote() { $('remoteForm').classList.toggle('hidden'); }
async function addRemote() {
  const url = $('rUrl').value.trim(), model = $('rModel').value.trim(), key = $('rKey').value.trim();
  if (!/^https?:\/\/.+/.test(url) || !model) { $('rMsg').textContent = '请填写地址和模型名'; return; }
  $('rMsg').textContent = '测试连通中…';
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/v1/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    $('rMsg').textContent = '✓ 连通正常，已加入';
    remoteBackends.push({ url, model, key });
    chosenModel = model;
  } catch (e) { $('rMsg').textContent = `连接失败：${e.message}（仍会加入，安装后再试）`; remoteBackends.push({ url, model, key }); }
  renderModels();
}
async function install() {
  const entrances = {
    tailscale: $('optTs').classList.contains('on') && $('optTs').querySelector('input').checked,
    cloudflared: $('optCf').querySelector('input').checked && $('optCf').querySelector('input').disabled === false
  };
  const backends = remoteBackends.map(r => ({ name: 'remote-' + r.model, type: 'openai', url: r.url, apiKey: r.key || undefined, models: [r.model], path: '/v1/chat/completions' }));
  if (ST.detect?.ollama?.running) backends.unshift({ name: 'local-ollama', type: 'ollama', host: '127.0.0.1', port: 11434, numCtx: 16384, models: (ST.detect.ollama.models || []).map(m => m.name) });
  if (!backends.length) { alert('没有可用后端：请先运行 Ollama 并拉取模型，或添加远程后端'); return; }
  chosenModel = $('modelSel').value || chosenModel;
  await api('/api/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entrances, backends, defaultModel: chosenModel }) });
  $('installHint').textContent = '正在安装…页面会实时显示进度';
  refresh();
}
async function armVerify() {
  await api('/api/verify/arm', { method: 'POST' });
  $('verifyBtn').disabled = true; $('verifyBtn').innerHTML = '<span class="spin"></span> 等待 ima 请求…';
  $('verifyMsg').textContent = '现在去 ima 里随便问一句话（等首字可能 1–3 分钟）';
}
async function restartEntrance(w) { await api('/api/entrance/restart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ which: w }) }); refresh(); }
async function rotateKey() { if (confirm('轮换后需在 ima 中更新 API Key，确定？')) { await api('/api/key/rotate', { method: 'POST' }); refresh(); } }
function cp(id) {
  const t = $(id).textContent;
  navigator.clipboard.writeText(t).then(() => {
    const b = $('kvUrl'); const m = document.createElement('div'); m.textContent = '已复制'; m.style.cssText = 'color:var(--ok);font-size:12px;flex:none';
    event.target.parentNode.appendChild(m); setTimeout(() => m.remove(), 1200);
  });
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 日志折叠面板展开时加载
document.querySelector('details.adv').addEventListener('toggle', async e => {
  if (e.target.open) { const r = await api('/api/logs'); $('logs').textContent = (r.lines || []).join('\n'); }
});

refresh();
setInterval(refresh, 2000);
