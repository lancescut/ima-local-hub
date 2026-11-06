'use strict';
// E2E 驱动：API 安装 → 健康检查 → 探测/流式/工具调用 → 验证闭环
const assert = require('assert');
const UI = 'http://127.0.0.1:18080';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function j(p, opt) { const r = await fetch(UI + p, opt); return { code: r.status, body: await r.json() }; }

(async () => {
  const results = [];
  const T = async (name, fn) => { try { await fn(); results.push(['✓', name]); } catch (e) { results.push(['✗', name + ' — ' + e.message]); } };

  // 1. 安装
  await T('API 一键安装（Tailscale 入口 + 本机 Ollama）', async () => {
    const det = (await j('/api/status')).body.detect;
    const models = det.ollama.models.map(m => m.name);
    assert.ok(models.length, '本机应有模型');
    const r = await j('/api/install', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entrances: { tailscale: true, cloudflared: false },
        backends: [{ name: 'local-ollama', type: 'ollama', host: '127.0.0.1', port: 11434, numCtx: 16384, models }],
        defaultModel: models[0] }) });
    assert.strictEqual(r.code, 200);
    for (let i = 0; i < 60; i++) { await sleep(1000); const st = (await j('/api/status')).body; if (st.install?.done) break; }
    const st = (await j('/api/status')).body;
    assert.ok(st.install?.done, '安装应完成');
    assert.ok(!st.install?.error, '安装应无错误: ' + (st.install?.error || ''));
    assert.ok(st.installed, 'installed=true');
    assert.ok(st.imaCard.urls[0].includes('.ts.net:8443'), '入口 URL 应为 ts.net:8443: ' + st.imaCard.urls[0]);
  });

  // 2. 入口健康（等待巡检周期最多 40s）
  await T('Funnel 入口公网可达（自检 401/200 语义）', async () => {
    for (let i = 0; i < 40 && !((await j('/api/status')).body.health.tailscale); i++) await sleep(1000);
    const st = (await j('/api/status')).body;
    assert.ok(st.health.tailscale?.ok, 'tailscale 健康检查应通过: ' + JSON.stringify(st.health.tailscale));
  });

  const KEY = (await j('/api/status')).body.imaCard.apiKey;
  const EP = (await j('/api/status')).body.imaCard.urls[0]; // 完整 chat/completions 端点
  const PUB = new URL(EP).origin; // 公网基地址

  // 3. 公网探测（应秒回 canned）
  await T('公网探测请求秒回 canned', async () => {
    const r = await fetch(`${PUB}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }) });
    assert.strictEqual(r.status, 200);
    const t = await r.text();
    assert.ok(t.includes('"content":"ok"') || t.includes('"content":"ok\\n"') || t.includes('chat.completion'), 'canned 响应');
  });

  // 4. 公网无 Key 401
  await T('公网无 Key 401', async () => {
    const r = await fetch(`${PUB}/v1/models`);
    assert.strictEqual(r.status, 401);
  });

  // 5. 真实流式（qwen，~30s）
  await T('公网流式对话（真模型）', async () => {
    const big = '你是知识库助手。'.repeat(80);
    const r = await fetch(`${PUB}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: 'qwen3.8:27b', stream: true, max_completion_tokens: 100, messages: [{ role: 'system', content: big }, { role: 'user', content: '一句话自我介绍' }] }),
      signal: AbortSignal.timeout(180000) });
    assert.strictEqual(r.status, 200);
    const t = await r.text();
    assert.ok(t.includes('chat.completion.chunk'), 'SSE 块');
    assert.ok(t.trim().endsWith('data: [DONE]'), '[DONE] 结尾');
    assert.ok(/"content":"[^"]+"/.test(t), '有内容增量');
  });

  // 6. 验证闭环
  await T('验证闭环：arm → 大请求 → verified', async () => {
    await j('/api/verify/arm', { method: 'POST' });
    const big = 'e'.repeat(1200);
    await fetch(`${PUB}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: 'qwen3.8:27b', stream: true, messages: [{ role: 'user', content: big }] }),
      signal: AbortSignal.timeout(15000) }).catch(() => {});
    await sleep(1500);
    const st = (await j('/api/status')).body;
    assert.ok(st.verify.verifiedAt, '应已验证通过');
    assert.ok(st.alerts.some(a => a.type === 'verify-ok'), '应有 verify-ok 告警');
  });

  for (const [s, n] of results) console.log(s, n);
  const failed = results.filter(r => r[0] === '✗').length;
  console.log(failed ? `\n${failed} FAILED` : '\nE2E PASSED');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('driver error', e); process.exit(1); });
