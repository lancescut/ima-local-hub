// 隧道管理：Tailscale Funnel（永久域名）+ cloudflared 快隧道（URL 捕获/变更检测）
'use strict';
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { run, findTailscale, findCloudflared } = require('./detect');

// ============ Tailscale Funnel ============
const ts = () => findTailscale();

async function funnelSet(localPort, publicPort = 8443) {
  const exe = await ts(); if (!exe) throw new Error('未安装 Tailscale');
  const r = await run(exe, ['funnel', '--bg', `--https=${publicPort}`, String(localPort)], 20000);
  if (!r.ok) throw new Error(`funnel 配置失败: ${r.out.slice(0, 300) || r.err}`);
  return funnelUrl();
}
async function funnelUrl(publicPort = 8443) {
  const exe = await ts(); if (!exe) return '';
  const st = await run(exe, ['status', '--json'], 10000);
  try {
    const dns = JSON.parse(st.out).Self.DNSName.replace(/\.$/, '');
    return dns ? `https://${dns}${publicPort === 443 ? '' : ':' + publicPort}` : '';
  } catch { return ''; }
}
async function funnelHealthCheck(url, apiKey, timeoutMs = 12000) {
  if (!url) return { ok: false, reason: 'no-url' };
  try {
    const res = await fetch(`${url}/v1/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.status === 200, reason: `http-${res.status}` };
  } catch (e) { return { ok: false, reason: e.name === 'TimeoutError' ? 'timeout' : e.message }; }
}

// ============ cloudflared 快隧道 ============
class CloudflaredQuick {
  constructor() { this.proc = null; this.url = ''; this.log = []; this.exe = null; }
  async start(localPort) {
    this.exe = this.exe || await findCloudflared();
    if (!this.exe) throw new Error('未找到 cloudflared');
    await this.stop();
    return new Promise((resolve, reject) => {
      const args = ['tunnel', '--url', `http://127.0.0.1:${localPort}`, '--no-autoupdate', '--protocol', 'http2'];
      this.proc = spawn(this.exe, args, { windowsHide: true });
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('30 秒内未捕获到隧道 URL')); } }, 30000);
      this.proc.stdout.on('data', d => this._feed(d));
      this.proc.stderr.on('data', d => {
        const got = this._feed(d);
        if (got && !settled) { settled = true; clearTimeout(timer); resolve(got); }
      });
      this.proc.on('exit', (code) => { this.log.push(`[cloudflared] exited code=${code}`); this.proc = null; });
    });
  }
  _feed(buf) {
    const text = buf.toString('utf8');
    for (const line of text.split('\n').slice(-8)) this.log.push(line.trim());
    if (this.log.length > 200) this.log = this.log.slice(-100);
    const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/) || text.match(/https:\/\/[a-z0-9.-]+\.ts\.net/) ;
    if (m && m[0] !== this.url) { this.url = m[0]; return this.url; }
    if (m) return this.url;
    return null;
  }
  async stop() {
    if (this.proc) { try { this.proc.kill(); } catch {} this.proc = null; }
    this.url = '';
  }
  alive() { return !!this.proc; }
}

// 检测系统已有 Node（供安装脚本判断）
async function nodeVersion() {
  const r = await run(process.execPath, ['--version']);
  return r.ok ? r.out.trim() : '';
}

module.exports = { funnelSet, funnelUrl, funnelHealthCheck, CloudflaredQuick, nodeVersion };
