// 代理核心单元测试（mock 上游，全量协议断言）
'use strict';
const assert = require('assert');
const http = require('http');
const { startMockOllama } = require('./proxy-mock');
const { createProxy } = require('../lib/proxy-core');

const MOCK_PORT = 19114, PROXY_PORT = 19081;
const KEY = 'sk-hub-test-key';
const cfg = () => ({
  apiKey: KEY,
  keepaliveMs: 80, // 测试用短保活
  backends: [{ name: 'mock', type: 'ollama', host: '127.0.0.1', port: MOCK_PORT, numCtx: 4096, model: 'mock-model' }],
  defaultBackend: 'mock', modelRoutes: {}
});

function req(port, path, { method = 'POST', key, body, timeoutMs = 8000, signal } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: ctrl.signal
  }).then(async res => {
    clearTimeout(timer);
    return { status: res.status, headers: Object.fromEntries(res.headers), text: await res.text() };
  }).catch(e => { clearTimeout(timer); throw e; });
}

// 收集 SSE data 行为对象数组
function sseLines(text) {
  return text.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).filter(l => l !== '[DONE]').map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
}

async function main() {
  const mock = await startMockOllama(MOCK_PORT);
  const proxy = createProxy(cfg(), { logger: () => {} });
  await new Promise(r => proxy.listen(PROXY_PORT, '127.0.0.1', r));
  const P = (p, opts) => req(PROXY_PORT, p, opts);
  let failed = 0;
  const tests = [];
  const T = (name, fn) => tests.push({ name, fn });

  // 1. 鉴权
  T('无Key返回401', async () => {
    const r = await P('/v1/chat/completions', { key: null, body: { messages: [{ role: 'user', content: 'x' }] } });
    assert.strictEqual(r.status, 401);
  });
  T('错误Key返回401', async () => {
    const r = await P('/v1/chat/completions', { key: 'sk-wrong', body: { messages: [{ role: 'user', content: 'x' }] } });
    assert.strictEqual(r.status, 401);
  });

  // 2. 探测秒回（非流式）
  T('探测请求(小体非流式)秒回canned', async () => {
    const r = await P('/v1/chat/completions', { key: KEY, body: { model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 } });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.text);
    assert.strictEqual(j.choices[0].message.content, 'ok');
    assert.strictEqual(j.object, 'chat.completion');
  });
  // 2b. 探测（流式）
  T('探测请求(小体流式)秒回canned SSE', async () => {
    const r = await P('/v1/chat/completions', { key: KEY, body: { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 } });
    assert.strictEqual(r.status, 200);
    const lines = sseLines(r.text);
    assert.ok(r.text.trim().endsWith('data: [DONE]'), '应以[DONE]结尾');
    assert.strictEqual(lines[lines.length - 1].choices[0].finish_reason, 'stop');
    assert.ok(lines.some(l => (l.choices[0] || {}).delta && l.choices[0].delta.content === 'ok'));
  });

  // 3. 真实聊天流式（内容 + usage + finish）
  T('大请求流式: content delta + finish stop + usage', async () => {
    const big = '背景知识。'.repeat(200); // >600B
    const r = await P('/v1/chat/completions', { key: KEY, timeoutMs: 15000, body: {
      model: 'mock-model', stream: true, stream_options: { include_usage: true }, max_completion_tokens: 100,
      messages: [{ role: 'system', content: big }, { role: 'user', content: '问' }] } });
    assert.strictEqual(r.status, 200);
    const lines = sseLines(r.text);
    const first = lines[0].choices[0];
    assert.strictEqual(first.delta.role, 'assistant', '首块应为role delta');
    const contents = lines.map(l => ((l.choices[0] || {}).delta || {}).content || '').join('');
    assert.strictEqual(contents, '你好');
    const finish = lines.filter(l => l.choices.length && l.choices[0].finish_reason).pop();
    assert.strictEqual(finish.choices[0].finish_reason, 'stop');
    const usageLine = lines.find(l => l.usage);
    assert.ok(usageLine && usageLine.usage.total_tokens > 0, '应包含usage块');
    // 断言上游收到的是原生协议转换结果
    assert.strictEqual(mock.captured.lastNative.stream, true);
    assert.strictEqual(mock.captured.lastNative.think, false);
    assert.strictEqual(mock.captured.lastNative.options.num_predict, 100);
    assert.strictEqual(mock.captured.lastNative.options.num_ctx, 4096);
  });

  // 4. 工具调用翻译（流出方向）
  T('工具调用: delta.tool_calls + finish_reason=tool_calls + arguments为字符串', async () => {
    mock.captured.lastNative = null;
    const big = 'x'.repeat(700);
    const scriptMsgs = [{ role: 'user', content: big + ' toolcall' }];
    // 注入剧本：上游直接回 tool_calls（通过 messages 里夹带 _script 会被 toNativeMessages 丢弃，故用环境：此处用第二条路径——见下）
    // 做法：先发一个大请求，mock 上游默认剧本不含工具；这里通过 tools + mock 特判 messages[0].content 含 'toolcall' 时回工具调用
    // —— 简化：直接重写 mock 行为
    const r = await P('/v1/chat/completions', { key: KEY, timeoutMs: 15000, body: {
      model: 'mock-model', stream: true,
      tools: [{ type: 'function', function: { name: 'mcp_knowledge_search', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }],
      messages: [{ role: 'user', content: big + ' __FORCE_TOOL__' }] } });
    assert.strictEqual(r.status, 200);
    const lines = sseLines(r.text);
    const tcLine = lines.find(l => ((l.choices[0] || {}).delta || {}).tool_calls);
    assert.ok(tcLine, '应包含tool_calls delta');
    const tc = tcLine.choices[0].delta.tool_calls[0];
    assert.strictEqual(tc.type, 'function');
    assert.strictEqual(tc.function.name, 'mcp_knowledge_search');
    assert.strictEqual(typeof tc.function.arguments, 'string');
    const parsed = JSON.parse(tc.function.arguments);
    assert.strictEqual(parsed.query, 'HBM 是什么');
    const finish = lines.filter(l => l.choices.length && l.choices[0].finish_reason).pop();
    assert.strictEqual(finish.choices[0].finish_reason, 'tool_calls');
    assert.strictEqual(mock.captured.lastNative.tools[0].function.name, 'mcp_knowledge_search', 'tools应透传给上游');
  });

  // 5. 历史消息 tool_calls 转换（入向：OpenAI字符串args -> 原生对象）
  T('历史assistant.tool_calls参数转对象传入上游', async () => {
    mock.captured.lastNative = null;
    const big = 'y'.repeat(700);
    const r = await P('/v1/chat/completions', { key: KEY, timeoutMs: 15000, body: {
      model: 'mock-model', stream: true,
      messages: [
        { role: 'user', content: big },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{"a":1}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: '结果' },
        { role: 'user', content: '继续' }] } });
    assert.strictEqual(r.status, 200);
    const native = mock.captured.lastNative;
    assert.strictEqual(native.messages[1].tool_calls[0].function.arguments.a, 1, 'arguments应为对象');
    assert.strictEqual(native.messages[2].role, 'tool');
  });

  // 6. 保活心跳（上游延迟期间应有空delta心跳）
  T('保活: 上游延迟时发出心跳空delta', async () => {
    const big = 'z'.repeat(700) + ' __DELAY__';
    const t0 = Date.now();
    const r = await P('/v1/chat/completions', { key: KEY, timeoutMs: 15000, body: { model: 'mock-model', stream: true, messages: [{ role: 'user', content: big }] } });
    const lines = sseLines(r.text);
    const kaCount = lines.filter(l => l.choices.length && l.choices[0].delta && Object.keys(l.choices[0].delta).length === 0).length;
    assert.ok(kaCount >= 3, `延迟期间应≥3个心跳块(keepalive 80ms, 实得${kaCount})`);
    assert.ok(Date.now() - t0 >= 400);
  });

  // 7. 断开即中止
  T('客户端断开 -> 上游连接被中止', async () => {
    mock.captured.aborted = [];
    const big = 'w'.repeat(700) + ' __DELAY__';
    const signal = AbortSignal.timeout(100000); // 仅用于持有引用
    const ctrl = new AbortController();
    const p = fetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: 'mock-model', stream: true, messages: [{ role: 'user', content: big }] }),
      signal: ctrl.signal
    }).then(r => r.text()).catch(() => 'aborted');
    await new Promise(r2 => setTimeout(r2, 250));
    ctrl.abort();
    await p;
    await new Promise(r2 => setTimeout(r2, 400));
    assert.ok(mock.captured.aborted.length > 0, '上游应感知到中止');
  });

  // 8. GET /v1/models 透传
  T('GET /v1/models 透传上游列表', async () => {
    const r = await P('/v1/models', { key: KEY, method: 'GET' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(JSON.parse(r.text).data[0].id, 'mock-model');
  });

  // 9. 4MB 上限
  T('超限请求413', async () => {
    const huge = 'a'.repeat(5 * 1024 * 1024);
    const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: huge }] })
    }).then(res => ({ status: res.status })).catch(e => ({ status: 0, err: e.message }));
    assert.ok(r.status === 413 || r.status === 0, `期望413或传输中断, 实得${r.status}`);
  });

  for (const { name, fn } of tests) {
    try { await fn(); console.log('✓', name); }
    catch (e) { console.log('✗', name, '-', e.message); failed++; }
  }
  proxy.close(); mock.server.close();
  if (failed) throw new Error(`${failed} 个测试失败`);
}

if (require.main === module) main().then(() => { console.log('\nALL PROXY TESTS PASSED'); process.exit(0); }).catch(e => { console.error(e.message); process.exit(1); });
module.exports = { main };
