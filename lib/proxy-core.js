// 代理核心：公网入口 -> 鉴权 -> 探测秒回 -> 按后端类型翻译转发（Ollama原生/OpenAI透传）
// 能力: Bearer鉴权 / <阈值探测canned / 工具调用双向翻译 / think:false / num_ctx / SSE保活 / 断开即中止 / 请求日志
'use strict';
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROBE_THRESHOLD = 600;      // 小于此体积视为腾讯校验探测
const KEEPALIVE_MS = 15000;
const MAX_BODY = 4 * 1024 * 1024; // 4MB 上限
const AUTH_FAIL_LIMIT = 30;       // 每窗口 401 次数上限（防公网暴破/刷噪）
const AUTH_FAIL_WINDOW_MS = 60_000;

function createProxy(cfg, hooks = {}) {
  const log = hooks.logger || (() => {});
  const onRequest = hooks.onRequest || null;   // (info) => void  验证闭环/统计
  const KA_MS = cfg.keepaliveMs || KEEPALIVE_MS;
  const state = { lastRealRequestAt: 0, requestCount: 0 };

  // 常数时间密钥比较（防时序侧信道）
  const expected = Buffer.from(`Bearer ${cfg.apiKey}`, 'utf8');
  function authOk(authHeader) {
    const got = Buffer.from(authHeader || '', 'utf8');
    if (got.length !== expected.length) return false;
    return crypto.timingSafeEqual(got, expected);
  }
  // 401 全局限流（隧道下来源IP恒为本机回环，per-IP 无意义，故用全局窗口）
  let failCount = 0, failWindowStart = Date.now();
  function tooManyFails() {
    const nowMs = Date.now();
    if (nowMs - failWindowStart > AUTH_FAIL_WINDOW_MS) { failWindowStart = nowMs; failCount = 0; }
    return failCount >= AUTH_FAIL_LIMIT;
  }

  const server = http.createServer((req, res) => {
    const t0 = Date.now();
    const chunks = []; let size = 0; let overLimit = false;
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { overLimit = true; } else chunks.push(c); });
    req.on('end', () => {
      if (overLimit) { res.writeHead(413, { 'content-type': 'application/json' }); res.end('{"error":{"message":"payload too large"}}'); return; }
      const body = Buffer.concat(chunks);
      const ok = authOk(req.headers['authorization']);
      state.requestCount++;
      log(`${req.method} ${req.url} ${body.length}B auth=${ok ? 'OK' : 'BAD'}`);
      if (onRequest) try { onRequest({ method: req.method, url: req.url, authOk: ok, size: body.length, t0 }); } catch {}

      if (!ok) {
        failCount++;
        if (tooManyFails()) {
          log(`AUTH rate-limited (${failCount} fails/window)`);
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
          res.end(JSON.stringify({ error: { message: 'Too many failed attempts', type: 'rate_limit' } }));
          return;
        }
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' } }));
        return;
      }
      if (req.method === 'GET' && req.url.includes('/models')) { backendListModels(cfg, res, log); return; }
      if (req.url.includes('/chat/completions') && req.method === 'POST') {
        if (body.length > 0 && body.length < PROBE_THRESHOLD) return sendCanned(res, body, log);
        return forwardChat(cfg, req, res, body, log, state);
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"not found"}}');
    });
  });
  server.state = state;
  return server;
}

// ---------- 后端选择 ----------
function pickBackend(cfg, model) {
  const name = cfg.modelRoutes && cfg.modelRoutes[model];
  const list = cfg.backends || [];
  return list.find(b => b.name === name) || list.find(b => b.name === cfg.defaultBackend) || list[0] || null;
}

function backendListModels(cfg, res, log) {
  const b = pickBackend(cfg, null);
  if (!b) { res.writeHead(502); res.end('{"error":{"message":"no backend"}}'); return; }
  const up = upstreamReq(b, '/v1/models', 'GET', null, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', e => { log(`models upstream error ${e.message}`); res.writeHead(502); res.end(); });
  up.end();
}

// ---------- 探测秒回 ----------
function sendCanned(res, body, log) {
  let model = 'proxy', stream = false;
  try { const j = JSON.parse(body.toString('utf8')); model = j.model || model; stream = !!j.stream; } catch {}
  const cb = base(model);
  if (stream) {
    res.writeHead(200, sseHeaders());
    sse(res, { ...cb, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    sse(res, { ...cb, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] });
    sse(res, { ...cb, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n'); res.end();
  } else {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'chatcmpl-hub', object: 'chat.completion', created: now(), model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  }
  log(`canned probe stream=${stream}`);
}

// ---------- 真实聊天 ----------
function forwardChat(cfg, req, res, body, log, state) {
  let j; try { j = JSON.parse(body.toString('utf8')); } catch { res.writeHead(400); res.end('{"error":{"message":"bad json"}}'); return; }
  const model = j.model || '';
  const b = pickBackend(cfg, model);
  if (!b) { res.writeHead(502); res.end('{"error":{"message":"no backend configured"}}'); return; }
  const stream = !!j.stream;
  const wantUsage = !!(j.stream_options && j.stream_options.include_usage);
  const maxTok = j.max_tokens || j.max_completion_tokens;

  const t0 = Date.now();
  const KA_MS = cfg.keepaliveMs || KEEPALIVE_MS;
  const modelName = model || 'model';
  let payload, upPath, upHeaders;
  if (b.type === 'ollama') {
    const native = { model: b.model || model || 'default', stream, think: b.think === true, keep_alive: b.keepAlive || '60m',
      messages: toNativeMessages(j.messages), options: { num_ctx: b.numCtx || 16384 } };
    if (maxTok) native.options.num_predict = maxTok;
    if (j.temperature != null) native.options.temperature = j.temperature;
    if (Array.isArray(j.tools) && j.tools.length) native.tools = j.tools;
    payload = Buffer.from(JSON.stringify(native));
    upPath = '/api/chat'; upHeaders = { 'content-type': 'application/json' };
  } else { // openai 透传：忠实转发（上游快，无需保活，也不提前提交响应头）
    payload = body;
    upPath = (b.path || '/v1/chat/completions');
    upHeaders = { 'content-type': 'application/json' };
    if (b.apiKey) upHeaders['authorization'] = `Bearer ${b.apiKey}`;
  }

  const isOllama = b.type === 'ollama';
  let ka = null, gotPayload = false, toolCallSeen = false, gone = false, usage = null, upReq = null;

  if (isOllama) { // 慢预填充场景：立即回响应头+role块，prefill 期间心跳防中间层掐线
    res.writeHead(200, sseHeaders());
    sse(res, { ...base(modelName), choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    ka = setInterval(() => { if (!res.writableEnded) sse(res, { ...base(modelName), choices: [{ index: 0, delta: {}, finish_reason: null }] }); }, KA_MS);
  }
  const stopKA = () => { if (ka) { clearInterval(ka); ka = null; } };
  const onGone = () => {
    if (res.writableEnded) return; // 正常完成后触发的一次 close 不是断开
    gone = true; stopKA();
    try { upReq && upReq.destroy(); } catch {}
    log(`client disconnected at +${((Date.now() - t0) / 1000).toFixed(1)}s -> upstream aborted`);
  };
  res.on('close', onGone); req.on('aborted', onGone);

  upReq = upstreamReq(b, upPath, 'POST', upHeaders, upRes => {
    if (!isOllama) { res.writeHead(upRes.statusCode, upRes.headers); upRes.pipe(res); log(`openai passthrough ${upRes.statusCode}`); return; }

    if (upRes.statusCode !== 200) {
      stopKA();
      const err = [];
      upRes.on('data', c => err.push(c));
      upRes.on('end', () => {
        log(`upstream ${upRes.statusCode}: ${Buffer.concat(err).toString('utf8').slice(0, 200)}`);
        if (!res.writableEnded) {
          sse(res, { ...base(modelName), choices: [{ index: 0, delta: { content: `[ImaLocalHub] 上游错误 ${upRes.statusCode}` }, finish_reason: null }] });
          sse(res, { ...base(modelName), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          res.write('data: [DONE]\n\n'); res.end();
        }
      });
      return;
    }

    // Ollama 原生 NDJSON -> OpenAI SSE
    let buf = '';
    upRes.on('data', c => {
      buf += c.toString('utf8'); let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line) continue;
        let r; try { r = JSON.parse(line); } catch { continue; }
        const m = r.message || {};
        if (r.prompt_eval_count != null || r.eval_count != null) usage = { prompt_tokens: r.prompt_eval_count || 0, completion_tokens: r.eval_count || 0, total_tokens: (r.prompt_eval_count || 0) + (r.eval_count || 0) };
        if (m.content) {
          if (!gotPayload) { gotPayload = true; stopKA(); state.lastRealRequestAt = Date.now(); }
          sse(res, { ...base(modelName), choices: [{ index: 0, delta: { content: m.content }, finish_reason: null }] });
        }
        if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
          if (!gotPayload) { gotPayload = true; stopKA(); state.lastRealRequestAt = Date.now(); log(`tool_call: ${(m.tool_calls[0].function || {}).name}`); }
          toolCallSeen = true;
          sse(res, { ...base(modelName), choices: [{ index: 0, delta: { tool_calls: toOpenAIToolCalls(m.tool_calls) }, finish_reason: null }] });
        }
        if (r.done) finish(toolCallSeen ? 'tool_calls' : 'stop', usage);
      }
    });
    upRes.on('end', () => { if (!gone && !res.writableEnded) finish(toolCallSeen ? 'tool_calls' : 'stop', usage); });
    upRes.on('error', () => { stopKA(); if (!res.writableEnded) finish('stop', usage); });

    function finish(fr, u) {
      stopKA();
      sse(res, { ...base(modelName), choices: [{ index: 0, delta: {}, finish_reason: fr }] });
      if (wantUsage && u) sse(res, { ...base(modelName), choices: [], usage: u });
      res.write('data: [DONE]\n\n'); res.end();
      log(`done finish=${fr} out=${u ? u.completion_tokens : '?'} prefill=${u ? u.prompt_tokens : '?'}`);
    }
  });
  upReq.on('error', e => {
    stopKA();
    if (!res.writableEnded) { sse(res, { ...base(modelName), choices: [{ index: 0, delta: { content: `[ImaLocalHub] 上游连接失败: ${e.message}` }, finish_reason: null }] }); res.write('data: [DONE]\n\n'); res.end(); }
    log(`upstream error ${e.message}`);
  });
  upReq.end(payload);
}

// ---------- OpenAI <-> Ollama 消息互转 ----------
function toNativeMessages(msgs) {
  return (msgs || []).map(m => {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      return { role: 'assistant', content: m.content || '',
        tool_calls: m.tool_calls.map(tc => ({ id: tc.id || 'call_' + crypto.randomBytes(6).toString('hex'),
          function: { name: tc.function && tc.function.name,
            arguments: parseArgs(tc.function && tc.function.arguments) } })) };
    }
    if (m.role === 'tool') return { role: 'tool', content: str(m.content) };
    return { role: m.role, content: str(m.content) };
  });
}
function parseArgs(a) {
  if (typeof a === 'string') { try { return JSON.parse(a || '{}'); } catch { return {}; } }
  return a || {};
}
function toOpenAIToolCalls(tcs) {
  return (tcs || []).map((tc, i) => ({ index: (tc.function && tc.function.index) != null ? tc.function.index : i,
    id: tc.id || 'call_' + crypto.randomBytes(8).toString('hex'), type: 'function',
    function: { name: tc.function && tc.function.name, arguments: JSON.stringify((tc.function && tc.function.arguments) || {}) } }));
}

// ---------- 工具 ----------
function upstreamReq(b, upPath, method, headers, cb) {
  const mod = (b.url || '').startsWith('https') ? https : http;
  if (b.type === 'ollama') {
    const r = http.request({ host: b.host || '127.0.0.1', port: b.port || 11434, method, path: upPath, headers: headers || {}, timeout: 300000 }, cb);
    r.on('timeout', () => r.destroy(new Error('upstream idle timeout(300s)')));
    return r;
  }
  const u = new URL((b.url || '').replace(/\/$/, '') + upPath);
  const opt = { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), method, path: u.pathname + u.search, headers: headers || {}, timeout: b.timeoutMs || 300000 };
  const r = mod.request(opt, cb);
  r.on('timeout', () => r.destroy(new Error('upstream idle timeout')));
  return r;
}
const sseHeaders = () => ({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
const sse = (res, obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
const base = model => ({ id: 'chatcmpl-hub-' + crypto.randomBytes(5).toString('hex'), object: 'chat.completion.chunk', created: now(), model });
const now = () => Math.floor(Date.now() / 1000);
const str = c => typeof c === 'string' ? c : JSON.stringify(c);

module.exports = { createProxy, PROBE_THRESHOLD, toOpenAIToolCalls, toNativeMessages };
