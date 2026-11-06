'use strict';
// cloudflared 变更检测演练：启用 cf 入口 → 杀进程 → 30s 内自动重启 → 检测 URL 变更 → alert
const assert = require('assert');
const { execFile } = require('child_process');
const UI = 'http://127.0.0.1:18080';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const j = async (p, opt) => (await fetch(UI + p, opt)).json();

function findCfPids() {
  return new Promise(resolve => {
    const cmd = `Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object { $_.CommandLine -match 'tunnel --url' } | Select-Object -ExpandProperty ProcessId`;
    execFile('powershell', ['-NoProfile', '-Command', cmd], { timeout: 15000 }, (e, out) => resolve(out.trim().split('\n').map(s => parseInt(s.trim())).filter(Boolean)));
  });
}

(async () => {
  console.log('== cloudflared 变更检测演练 ==');
  // 1. 重新安装以启用 cloudflared 入口（沿用已装的 tailscale 配置）
  const det = await j('/api/status');
  const models = det.detect.ollama.models.map(m => m.name);
  await j('/api/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    entrances: { tailscale: true, cloudflared: true },
    backends: [{ name: 'local-ollama', type: 'ollama', host: '127.0.0.1', port: 11434, numCtx: 16384, models }],
    defaultModel: models[0] }) });
  for (let i = 0; i < 90; i++) { await sleep(1000); const st = await j('/api/status'); if (st.install?.done) { assert.ok(!st.install.error, '安装错误: ' + st.install.error); break; } }
  let st = await j('/api/status');
  const url1 = st.imaCard.urls.find(u => u.includes('trycloudflare'));
  assert.ok(url1, '应有 trycloudflare URL: ' + JSON.stringify(st.imaCard.urls));
  console.log('✓ cloudflared 入口已启用:', url1);

  // 2. 杀掉 cloudflared 进程
  const pids = await findCfPids();
  assert.ok(pids.length, '应找到 cloudflared 进程');
  for (const pid of pids) { try { process.kill(pid); console.log('  已杀 PID', pid); } catch {} }

  // 3. 等待健康巡检自动重启（30s 周期 + 启动 30s 超时）
  console.log('  等待自动恢复（最长 75s）…');
  let newUrl = null, alerted = false;
  for (let i = 0; i < 75; i++) {
    await sleep(1000);
    st = await j('/api/status');
    const u = st.imaCard.urls.find(x => x.includes('trycloudflare'));
    if (u && u !== url1) newUrl = u;
    if (st.alerts.some(a => a.type === 'url-changed' && a.msg.includes('Cloudflare'))) alerted = true;
    if (newUrl && alerted) break;
  }
  assert.ok(newUrl, 'URL 应已变更并更新配置');
  assert.ok(alerted, '应产生 url-changed 告警');
  console.log('✓ 变更检测通过:', url1, '->', newUrl);

  // 4. 新 URL 可达性（隧道边缘就绪需数秒，带重试）
  const KEY = st.imaCard.apiKey;
  let ok = false, last = '';
  for (let i = 0; i < 10 && !ok; i++) {
    await sleep(5000);
    try { const r = await fetch(`${new URL(newUrl).origin}/v1/models`, { headers: { authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(12000) }); last = 'HTTP ' + r.status; ok = r.status === 200; } catch (e) { last = e.message; }
  }
  assert.ok(ok, '新入口应可达（重试后仍失败: ' + last + '）');
  console.log('✓ 新入口公网可达');
  console.log('\nCF-CHANGE DRILL PASSED');
  process.exit(0);
})().catch(e => { console.error('✗', e.message); process.exit(1); });
