'use strict';
// 测试汇总入口
// 用法:
//   node test/run-all.js            -> 单元测试（mock 上游，秒级，无外部依赖）
//   node test/run-all.js --e2e      -> 单元 + E2E（需要 hub 已运行在 18080 且本机有 Ollama/Tailscale）
const { spawn } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
const withE2e = args.includes('--e2e');

function run(name, file) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
    p.on('exit', code => { console.log(`\n[${name}] ${code === 0 ? 'PASSED' : 'FAILED'}\n`); resolve(code === 0); });
  });
}

(async () => {
  const results = [];
  results.push(['单元测试(代理核心)', await run('unit', 'test-proxy.js')]);
  if (withE2e) {
    results.push(['E2E(真实安装+公网链路)', await run('e2e', 'e2e-driver.js')]);
  }
  console.log('════════ 测试汇总 ════════');
  for (const [n, ok] of results) console.log(`${ok ? '✓' : '✗'} ${n}`);
  const all = results.every(r => r[1]);
  console.log(all ? 'ALL PASSED' : 'SOME FAILED');
  process.exit(all ? 0 : 1);
})();
