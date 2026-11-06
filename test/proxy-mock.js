// 模拟 Ollama 原生 /api/chat 上游（NDJSON），可编程行为，捕获请求供断言
'use strict';
const http = require('http');

function startMockOllama(port) {
  const captured = { lastNative: null, lastBody: null, aborted: [], models: [{ id: 'mock-model' }] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('aborted', () => captured.aborted.push(Date.now()));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      captured.lastBody = body;
      try { captured.lastNative = JSON.parse(body); } catch { captured.lastNative = null; }

      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: captured.models }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/chat') {
        const n = captured.lastNative || {};
        const allText = (n.messages || []).map(m => m.content || '').join(' ');
        const stream = n.stream !== false;
        let items;
        if (allText.includes('__FORCE_TOOL__')) {
          items = [
            { tool_calls: [{ id: 'mocktc1', function: { index: 0, name: 'mcp_knowledge_search', arguments: { query: 'HBM 是什么' } } }] },
            { done: true, eval: 35, prefill: 301 }
          ];
        } else if (allText.includes('__DELAY__')) {
          items = [{ delayMs: 500 }, { content: '慢' }, { done: true, eval: 9, prefill: 20 }];
        } else {
          items = [{ content: '你好' }, { done: true, eval: 5, prefill: 10 }];
        }
        if (!stream) {
          const last = items[items.length - 1];
          const msg = { role: 'assistant', content: '' };
          for (const it of items) { if (it.content) msg.content += it.content; if (it.tool_calls) msg.tool_calls = it.tool_calls; }
          res.writeHead(200, { 'content-type': 'application/json' });
          setTimeout(() => res.end(JSON.stringify({ message: msg, done: true, eval_count: last.eval || 5, prompt_eval_count: last.prefill || 10 })), items[0].delayMs || 0);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        let i = 0;
        const step = () => {
          if (i >= items.length) { res.end(); return; }
          const it = items[i++];
          setTimeout(() => {
            if (gone) return;
            const obj = { message: {} };
            if (it.content) obj.message.content = it.content;
            if (it.tool_calls) obj.message.tool_calls = it.tool_calls;
            if (it.done) { obj.done = true; obj.eval_count = it.eval || 5; obj.prompt_eval_count = it.prefill || 10; }
            res.write(JSON.stringify(obj) + '\n');
            step();
          }, it.delayMs || 0);
        };
        let gone = false;
        res.on('close', () => { gone = true; if (!res.writableEnded) captured.aborted.push(Date.now()); });
        step();
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ server, captured })));
}

module.exports = { startMockOllama };
