// ImaLocalHub 守护进程：UI(18080) + 代理(18081) + 健康巡检 + 变更检测 + 验证闭环
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./lib/config');
const { createProxy } = require('./lib/proxy-core');
const detect = require('./lib/detect');
const tunnels = require('./lib/tunnels');
const { execFile } = require('child_process');

const cfg = config.load();
const LOG_LINES = [];
const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; LOG_LINES.push(l); if (LOG_LINES.length > 500) LOG_LINES.shift(); console.log(l); };

// ---------- 状态 ----------
const S = {
  detectCache: null,            // 环境检测缓存
  cf: new tunnels.CloudflaredQuick(),
  health: { tailscale: null, cloudflared: null, at: 0 },
  alerts: [],                   // {at, type, msg}
  install: null,                // 安装作业 {steps, done, error, startedAt}
  stats: { proxyRequests: 0, lastRealAt: 0 }
};
function alert(type, msg) {
  S.alerts.unshift({ at: Date.now(), type, msg });
  if (S.alerts.length > 20) S.alerts.pop();
  log(`[ALERT:${type}] ${msg}`);
  notify('ImaLocalHub', msg);
}

// ---------- 通知（尽力而为） ----------
function notify(title, msg) {
  if (process.platform !== 'win32') return;
  const clean = s => String(s).replace(/[^a-zA-Z0-9 .,:;()\-_/\\\u4e00-\u9fff]/g, '').slice(0, 180); // 白名单字符，防注入
  const ps = `Add-Type -AssemblyName System.Windows.Forms; $n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Information; $n.Visible=$true; $n.ShowBalloonTip(8000,'${clean(title)}','${clean(msg)}', 'Info'); Start-Sleep 6; $n.Dispose()`;
  try { execFile('powershell', ['-NoProfile', '-Command', ps], { timeout: 15000, windowsHide: true }, () => {}); } catch {}
}

// ---------- 代理 ----------
const proxyServer = createProxy(cfg, {
  logger: m => log(`[proxy] ${m}`),
  onRequest: (info) => {
    S.stats.proxyRequests++;
    if (info.authOk && info.size >= 1000) S.stats.lastRealAt = Date.now();
    if (cfg.verify.armed && info.authOk && info.url.includes('/chat/completions') && info.size >= 1000) {
      cfg.verify.armed = false; cfg.verify.verifiedAt = Date.now();
      config.save(cfg);
      alert('verify-ok', 'ima 已成功接通本地模型（收到真实对话请求）');
    }
  }
});

// ---------- 验证闭环 ----------
function armVerify() { cfg.verify.armed = true; cfg.verify.armedAt = Date.now(); cfg.verify.verifiedAt = null; config.save(cfg); }

// ---------- ima 配置卡 ----------
function imaCard() {
  const urls = [];
  if (cfg.entrances.tailscale.enabled && cfg.entrances.tailscale.url) urls.push(cfg.entrances.tailscale.url + '/v1/chat/completions');
  if (cfg.entrances.cloudflared.enabled && cfg.entrances.cloudflared.url) urls.push(cfg.entrances.cloudflared.url + '/v1/chat/completions');
  const models = [];
  for (const b of cfg.backends) {
    if (b.type === 'ollama') models.push(...(b.models || []).map(m => typeof m === 'string' ? m : m.name));
    if (b.type === 'openai' && b.models) models.push(...b.models);
  }
  return { urls, apiKey: cfg.apiKey, models, verifiedAt: cfg.verify.verifiedAt };
}

// ---------- 健康巡检 ----------
async function healthLoop() {
  try {
    if (cfg.entrances.tailscale.enabled) {
      const url = await tunnels.funnelUrl(cfg.entrances.tailscale.publicPort || 8443);
      const h = await tunnels.funnelHealthCheck(url, cfg.apiKey);
      S.health.tailscale = { ...h, url, at: Date.now() };
      if (!h.ok && cfg.installedAt) alert('funnel-down', `Tailscale 入口不可达（${h.reason}），尝试自动恢复`);
    }
    if (cfg.entrances.cloudflared.enabled) {
      if (!S.cf.alive() && cfg.installedAt) {
        log('[cloudflared] 进程已退出，自动重启');
        const url = await S.cf.start(cfg.ports.proxy);
        if (url && url !== cfg.entrances.cloudflared.url) {
          const old = cfg.entrances.cloudflared.url;
          cfg.entrances.cloudflared.url = url; config.save(cfg);
          alert('url-changed', `Cloudflare 入口地址已变更（${old} → ${url}），请在 ima 中更新接口地址`);
        }
      }
      const h = S.cf.url ? await tunnels.funnelHealthCheck(S.cf.url, cfg.apiKey) : { ok: false, reason: 'no-url' };
      S.health.cloudflared = { ...h, url: S.cf.url, at: Date.now() };
    }
    S.health.at = Date.now();
  } catch (e) { log(`[health] ${e.message}`); }
}

// ---------- 一键安装作业 ----------
async function runInstall(input) {
  const steps = [];
  const step = (name) => { const s = { name, status: 'running', detail: '' }; steps.push(s); return s; };
  const finish = (s, detail, ok = true) => { s.status = ok ? 'done' : 'error'; s.detail = detail || ''; log(`[install] ${s.name}: ${s.status} ${s.detail}`); };

  S.install = { steps, done: false, error: null, startedAt: Date.now() };
  try {
    // 1. 检测
    let s = step('环境检测'); const det = await detect.detectAll(); S.detectCache = det;
    finish(s, `tailscale:${det.tailscale.installed ? '✓' : '✗'} ollama:${det.ollama.installed ? '✓' : '✗'}`);

    // 2. API Key
    s = step('生成访问密钥');
    if (input.apiKey && /^sk-[\w-]{8,}$/.test(input.apiKey)) cfg.apiKey = input.apiKey;
    finish(s, '已配置');

    // 3. 后端
    s = step('配置模型后端');
    cfg.backends = [];
    if (input.backends && input.backends.length) {
      for (const b of input.backends) cfg.backends.push(b);
    } else if (det.ollama.running && det.ollama.models.length) {
      cfg.backends.push({ name: 'local-ollama', type: 'ollama', host: '127.0.0.1', port: 11434, numCtx: 16384, models: det.ollama.models.map(m => m.name) });
    } else {
      finish(s, '未找到可用模型后端（本机 Ollama 未运行或无模型，且未添加远程后端）', false);
      throw new Error('无可用后端');
    }
    cfg.defaultBackend = cfg.backends[0].name;
    cfg.modelRoutes = {};
    if (input.defaultModel) cfg.modelRoutes[input.defaultModel] = cfg.defaultBackend;
    finish(s, cfg.backends.map(b => b.name).join(', '));

    // 4. Tailscale Funnel
    if (input.entrances && input.entrances.tailscale) {
      s = step('配置 Tailscale Funnel');
      if (!det.tailscale.installed) { finish(s, '未安装 Tailscale，请先安装（官网下载）', false); throw new Error('tailscale 未安装'); }
      if (!det.tailscale.logged) { finish(s, 'Tailscale 未登录，请点击页面中的「登录 Tailscale」后重试', false); throw new Error('tailscale 未登录'); }
      const url = await tunnels.funnelSet(cfg.ports.proxy, input.publicPort || 8443);
      if (!url) { finish(s, '未能获取 ts.net 域名', false); throw new Error('no dns name'); }
      const h = await tunnels.funnelHealthCheck(url, cfg.apiKey);
      if (!h.ok) { finish(s, `Funnel 公网自检失败: ${h.reason}`, false); throw new Error('funnel unhealthy'); }
      cfg.entrances.tailscale = { enabled: true, url, publicPort: input.publicPort || 8443 };
      finish(s, url);
    } else cfg.entrances.tailscale.enabled = false;

    // 5. cloudflared
    if (input.entrances && input.entrances.cloudflared) {
      s = step('启动 Cloudflare 隧道');
      if (!det.cloudflared.installed) {
        finish(s, '未安装 cloudflared；已给出下载指引', false); throw new Error('cloudflared 未安装');
      }
      const url = await S.cf.start(cfg.ports.proxy);
      const h = await tunnels.funnelHealthCheck(url, cfg.apiKey);
      cfg.entrances.cloudflared = { enabled: true, mode: 'quick', url };
      finish(s, h.ok ? url : `${url}（自检异常 ${h.reason}，仍已保存）`);
    } else { cfg.entrances.cloudflared.enabled = false; await S.cf.stop(); }

    // 6. 落盘
    s = step('保存配置并生效');
    cfg.installedAt = Date.now();
    config.save(cfg);
    finish(s, '完成');
    S.install.done = true; S.install.error = null;
  } catch (e) {
    if (S.install) { S.install.done = true; S.install.error = e.message; }
  }
}

// ---------- UI HTTP 服务 ----------
const ui = http.createServer(async (req, res) => {
  try { await handleUi(req, res); }
  catch (e) {
    log(`[ui-error] ${req.method} ${req.url}: ${e.message}`);
    if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }); }
    try { res.end(JSON.stringify({ error: e.message })); } catch {}
  }
});

async function handleUi(req, res) {
  const u = new URL(req.url, 'http://x');
  const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };

  // ---- 本地管理接口防护：Host 白名单（防 DNS rebinding）+ 浏览器来源校验（防 CSRF）----
  const allowedHosts = new Set([`127.0.0.1:${cfg.ports.ui}`, `localhost:${cfg.ports.ui}`, `[::1]:${cfg.ports.ui}`]);
  const host = (req.headers.host || '').toLowerCase();
  if (!allowedHosts.has(host)) {
    log(`[ui-block] 非法 Host: ${host || '(空)'}`);
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'forbidden host' }));
    return;
  }
  const secFetchSite = req.headers['sec-fetch-site'];
  const origin = req.headers['origin'];
  if (secFetchSite === 'cross-site' || (origin && !origin.startsWith(`http://127.0.0.1:${cfg.ports.ui}`) && !origin.startsWith(`http://localhost:${cfg.ports.ui}`))) {
    log(`[ui-block] 跨站请求被拒: origin=${origin || '-'} sfs=${secFetchSite || '-'}`);
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'cross-site request blocked' }));
    return;
  }
  if (req.method !== 'GET' && !String(req.headers['content-type'] || '').includes('application/json')) {
    res.writeHead(415, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'content-type must be application/json' }));
    return;
  }

  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    return;
  }
  if (u.pathname === '/app.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(fs.readFileSync(path.join(__dirname, 'public', 'app.js'))); return; }
  if (u.pathname === '/style.css') { res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' }); res.end(fs.readFileSync(path.join(__dirname, 'public', 'style.css'))); return; }
  const imageType = { '/logo.png': 'image/png', '/favicon.ico': 'image/x-icon' }[u.pathname];
  if (imageType) {
    res.writeHead(200, { 'content-type': imageType });
    res.end(fs.readFileSync(path.join(__dirname, 'public', u.pathname.slice(1))));
    return;
  }

  if (u.pathname === '/api/status' && req.method === 'GET') {
    json(200, {
      installed: !!cfg.installedAt,
      detect: S.detectCache,
      health: S.health,
      alerts: S.alerts.slice(0, 5),
      verify: { armed: cfg.verify.armed, verifiedAt: cfg.verify.verifiedAt },
      imaCard: imaCard(),
      stats: S.stats,
      install: S.install,
      backends: cfg.backends.map(b => ({ name: b.name, type: b.type, models: b.models || [] })),
      version: require('./package.json').version
    });
    return;
  }
  if (u.pathname === '/api/detect' && req.method === 'POST') {
    S.detectCache = await detect.detectAll();
    json(200, S.detectCache);
    return;
  }
  if (u.pathname === '/api/install' && req.method === 'POST') {
    const body = await readBody(req);
    let input; try { input = JSON.parse(body); } catch { json(400, { error: 'bad json' }); return; }
    // 后端白名单校验（防任意后端注入：type 受限、ollama 仅本机、openai 必须 http(s)）
    const errs = [];
    if (Array.isArray(input.backends)) {
      input.backends = input.backends.filter(b => b && typeof b === 'object');
      for (const b of input.backends) {
        if (b.type === 'ollama') {
          if (b.host && b.host !== '127.0.0.1' && b.host !== 'localhost') errs.push(`ollama 后端仅允许本机（收到 ${b.host}）`);
        } else if (b.type === 'openai') {
          if (!/^https?:\/\/[^\s]+$/.test(b.url || '')) errs.push(`openai 后端 url 非法: ${b.url}`);
          if (b.path && !/^\/[\w\-./]*$/.test(b.path)) errs.push('openai 后端 path 非法');
        } else errs.push(`未知后端类型: ${b.type}`);
        if (b.name && !/^[\w\-.]{1,64}$/.test(b.name)) errs.push(`后端名非法: ${b.name}`);
      }
    } else input.backends = [];
    if (errs.length) { json(400, { error: 'backends invalid', details: errs }); return; }
    if (S.install && !S.install.done) { json(409, { error: '安装进行中' }); return; }
    runInstall(input);
    json(200, { started: true });
    return;
  }
  if (u.pathname === '/api/verify/arm' && req.method === 'POST') { armVerify(); json(200, { ok: true }); return; }
  if (u.pathname === '/api/key/rotate' && req.method === 'POST') {
    cfg.apiKey = config.genKey(); config.save(cfg);
    alert('key-rotated', 'API Key 已轮换，请在 ima 中更新 API Key');
    json(200, { apiKey: cfg.apiKey });
    return;
  }
  if (u.pathname === '/api/logs' && req.method === 'GET') { json(200, { lines: LOG_LINES.slice(-200) }); return; }
  if (u.pathname === '/api/ts-login' && req.method === 'POST') {
    const exe = await detect.findTailscale();
    if (!exe) { json(400, { error: 'tailscale 未安装' }); return; }
    const r = await new Promise(resolve => execFile(exe, ['login'], { timeout: 10000, windowsHide: true }, (e, so, se) => resolve({ url: (so + se).match(/https:\/\/\S+/)?.[0] || '' })));
    json(200, { url: r.url });
    return;
  }
  if (u.pathname === '/api/entrance/restart' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    if (body.which === 'cloudflared') {
      const url = await S.cf.start(cfg.ports.proxy);
      if (url !== cfg.entrances.cloudflared.url) { cfg.entrances.cloudflared.url = url; config.save(cfg); }
      json(200, { url });
    } else if (body.which === 'tailscale') {
      const url = await tunnels.funnelSet(cfg.ports.proxy, cfg.entrances.tailscale.publicPort || 8443);
      cfg.entrances.tailscale.url = url; config.save(cfg); json(200, { url });
    } else json(400, { error: 'which?' });
    return;
  }
  res.writeHead(404); res.end('not found');
}

function readBody(req) {
  return new Promise(resolve => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => resolve(Buffer.concat(c).toString('utf8'))); });
}

// ---------- 启动 ----------
(async function main() {
  await new Promise(r => proxyServer.listen(cfg.ports.proxy, '127.0.0.1', r));
  log(`代理已启动 127.0.0.1:${cfg.ports.proxy}`);
  await new Promise(r => ui.listen(cfg.ports.ui, '127.0.0.1', r));
  log(`管理页 http://127.0.0.1:${cfg.ports.ui}`);

  S.detectCache = await detect.detectAll();

  if (cfg.installedAt) { // 已安装：恢复运行态
    if (cfg.entrances.cloudflared.enabled) {
      try { const url = await S.cf.start(cfg.ports.proxy); if (url && url !== cfg.entrances.cloudflared.url) { cfg.entrances.cloudflared.url = url; config.save(cfg); alert('url-changed', `Cloudflare 入口已变更为 ${url}，请在 ima 中更新`); } } catch (e) { log(`cloudflared 恢复失败: ${e.message}`); }
    }
    log('已恢复安装配置');
  }
  setInterval(healthLoop, 30000); healthLoop();
})();

process.on('uncaughtException', e => log(`[uncaught] ${e.stack}`));
