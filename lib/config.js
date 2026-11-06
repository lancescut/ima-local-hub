// 配置管理：跨平台路径、默认值、原子写入
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

function dataDir() {
  if (process.env.HUB_ENV === 'dev') return path.join(__dirname, '..', 'devdata');
  if (IS_WIN) {
    const pd = process.env.ProgramData || 'C:\\ProgramData';
    return path.join(pd, 'ImaLocalHub');
  }
  if (IS_MAC) return path.join(os.homedir(), 'Library', 'Application Support', 'ImaLocalHub');
  return path.join(os.homedir(), '.config', 'ima-local-hub');
}

function genKey() { return 'sk-hub-' + crypto.randomBytes(16).toString('hex'); }

function defaultConfig() {
  return {
    version: 1,
    installedAt: null,
    apiKey: genKey(),
    ports: { ui: 18080, proxy: 18081 },
    entrances: {
      // tailscale: { enabled, url }  cloudflared: { enabled, mode:'quick'|'named', url, tunnelName? }
      tailscale: { enabled: false, url: '' },
      cloudflared: { enabled: false, mode: 'quick', url: '', tunnelName: '' }
    },
    backends: [
      // { name:'local-ollama', type:'ollama', host:'127.0.0.1', port:11434, numCtx:16384, think:false }
      // { name:'remote', type:'openai', url:'http://192.168.1.10:8000', apiKey:'...', model:'x' }
    ],
    defaultBackend: 'local-ollama',
    modelRoutes: {}, // ima模型名 -> backend name（未命中走 defaultBackend）
    verify: { armed: false, armedAt: null, verifiedAt: null },
    logs: { keepDays: 7 }
  };
}

function load() {
  const dir = dataDir();
  const file = path.join(dir, 'config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Object.assign(defaultConfig(), raw, {
      entrances: Object.assign(defaultConfig().entrances, raw.entrances || {}),
      ports: Object.assign(defaultConfig().ports, raw.ports || {}),
      verify: Object.assign(defaultConfig().verify, raw.verify || {})
    });
  } catch { return defaultConfig(); }
}

function save(cfg) {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  const file = path.join(dir, 'config.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  // 仅生产目录收紧 ACL（dev 跳过；授予当前用户/管理员/SYSTEM，其余用户只读不可见由目录默认承担）
  if (IS_WIN && process.env.HUB_ENV !== 'dev') {
    const u = process.env.USERNAME || '';
    try { require('child_process').execSync(`icacls "${dir}" /inheritance:r /grant:r "${u}:(OI)(CI)F" /grant:r "Administrators:(OI)(CI)F" /grant:r "SYSTEM:(OI)(CI)F"`, { stdio: 'ignore' }); } catch {}
  }
  return cfg;
}

module.exports = { load, save, defaultConfig, dataDir, genKey, IS_WIN, IS_MAC };
