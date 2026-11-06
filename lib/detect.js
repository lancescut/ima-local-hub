// 环境检测：tailscale / cloudflared / ollama / OpenAI兼容后端 / GPU / 端口（Win + macOS）
'use strict';
const { execFile } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const IS_WIN = process.platform === 'win32';

function run(cmd, args, timeoutMs = 8000) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || '') + (stderr || ''), err: err ? String(err.message) : null });
    });
  });
}
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

// ---------- Tailscale ----------
function tailscalePaths() {
  return IS_WIN
    ? ['C:\\Program Files\\Tailscale\\tailscale.exe', 'C:\\Program Files (x86)\\Tailscale\\tailscale.exe']
    : ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/usr/bin/tailscale'];
}
async function findTailscale() {
  for (const p of tailscalePaths()) if (exists(p)) return p;
  const w = await run(IS_WIN ? 'where' : 'which', ['tailscale']);
  return w.ok ? w.out.trim().split('\n')[0] : null;
}
async function detectTailscale() {
  const path = await findTailscale();
  const r = { installed: !!path, path, logged: false, dnsName: '', funnels: [] };
  if (!path) return r;
  const st = await run(path, ['status', '--json'], 12000);
  if (!st.ok) return r;
  try {
    const j = JSON.parse(st.out);
    r.logged = !!(j.Self && (j.Self.Online !== false) && j.Self.DNSName);
    r.dnsName = (j.Self && j.Self.DNSName || '').replace(/\.$/, '');
  } catch {}
  const fs2 = await run(path, ['funnel', 'status', '--json'], 8000);
  if (fs2.ok) { try { r.funnels = JSON.parse(fs2.out) || []; } catch {} }
  return r;
}

// ---------- cloudflared ----------
async function findCloudflared() {
  const w = await run(IS_WIN ? 'where' : 'which', ['cloudflared']);
  if (w.ok) return w.out.trim().split('\n')[0];
  const exe = IS_WIN ? 'cloudflared.exe' : 'cloudflared';
  const appRoot = path.join(__dirname, '..');
  const cands = IS_WIN
    ? [path.join(appRoot, 'bin', exe), path.join(appRoot, exe), 'C:\\Program Files\\cloudflared\\cloudflared.exe', 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe']
    : [path.join(appRoot, 'bin', exe), '/usr/local/bin/cloudflared', '/opt/homebrew/bin/cloudflared', '/usr/bin/cloudflared'];
  for (const p of cands) if (exists(p)) return p;
  return null;
}
async function detectCloudflared() {
  const path = await findCloudflared();
  const r = { installed: !!path, path, version: '' };
  if (path) { const v = await run(path, ['--version']); if (v.ok) r.version = (v.out.match(/version (\S+)/) || [])[1] || ''; }
  return r;
}

// ---------- Ollama ----------
function httpJson(port, path_, timeoutMs = 3000) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: path_, timeout: timeoutMs }, res => {
      const c = []; res.on('data', d => c.push(d));
      res.on('end', () => { try { resolve({ code: res.statusCode, json: JSON.parse(Buffer.concat(c).toString('utf8')) }); } catch { resolve({ code: res.statusCode, json: null }); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}
async function detectOllama() {
  const w = await run(IS_WIN ? 'where' : 'which', ['ollama']);
  const r = { installed: !!w.ok, path: w.ok ? w.out.trim().split('\n')[0] : null, running: false, port: 11434, models: [] };
  const tags = await httpJson(11434, '/api/tags');
  if (tags && tags.code === 200 && tags.json) {
    r.running = true;
    r.models = (tags.json.models || []).map(m => ({ name: m.name, sizeGB: +(m.size / 1e9).toFixed(1) }));
  }
  return r;
}

// ---------- 其他 OpenAI 兼容后端探测（常见端口） ----------
async function detectOpenAIServers() {
  const ports = [1234, 8000, 8001, 9997, 5001, 8080];
  const found = [];
  await Promise.all(ports.map(async p => {
    const r = await httpJson(p, '/v1/models', 1500);
    if (r && r.code === 200 && r.json && Array.isArray(r.json.data)) {
      found.push({ port: p, url: `http://127.0.0.1:${p}`, models: r.json.data.map(m => m.id) });
    }
  }));
  return found;
}

// ---------- GPU / 芯片 ----------
async function detectHardware() {
  const r = { gpu: [], appleSilicon: false, summary: '' };
  if (IS_WIN) {
    const w = await run('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name']);
    if (w.ok) r.gpu = w.out.trim().split('\n').map(s => s.trim()).filter(Boolean);
    const nv = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], 5000);
    r.hasNvidia = nv.ok;
    if (nv.ok) r.gpu.push(...nv.out.trim().split('\n').map(s => s.trim()));
  } else {
    const c = await run('sysctl', ['-n', 'machdep.cpu.brand_string']);
    r.summary = c.ok ? c.out.trim() : '';
    r.appleSilicon = process.arch === 'arm64';
  }
  return r;
}

// ---------- 端口占用 ----------
function portFree(port) {
  return new Promise(resolve => {
    const s = require('net').createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

async function detectAll() {
  const [tailscale, cloudflared, ollama, openaiServers, hardware] = await Promise.all([
    detectTailscale(), detectCloudflared(), detectOllama(), detectOpenAIServers(), detectHardware()
  ]);
  const [uiFree, proxyFree] = await Promise.all([portFree(18080), portFree(18081)]);
  return { tailscale, cloudflared, ollama, openaiServers, hardware, ports: { uiFree, proxyFree }, at: Date.now() };
}

module.exports = { detectAll, detectTailscale, detectOllama, httpJson, portFree, run, findTailscale, findCloudflared, tailscalePaths };
