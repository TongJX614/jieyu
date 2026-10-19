#!/usr/bin/env node
/* ==========================================================================
   npm test —— 跑仓库内全部测试套件（零依赖，node 直接执行）
   ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');
const t = require('./tiny');

const SUITES = [
  'policy.test.js',
  'eval.test.js',
  'vision.test.js',
  'careradar.test.js',
  'recap.test.js',
  'privacy.test.js',
  'channels.test.js',
  'bus.test.js',
  'jobqueue.test.js',
  'harness.test.js',
  'llm.test.js',
  'server.test.js',
  'store.test.js',
  'effect.test.js',
  'bugfix.test.js',
  'memory.test.js',
  'domain.test.js',
  'propfit.test.js',
];

/* 源码里写了几个 t.suite(...) —— 注释里的字样先剥掉，免得把说明当成用例 */
function declaredSuites(file) {
  const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  return (code.match(/\bt\.suite\(/g) || []).length;
}

(async function () {
  for (const file of SUITES) {
    const declared = declaredSuites(file);
    const before = t.state.suites.length;
    try {
      const suite = require('./' + file);
      await suite(t);
    } catch (e) {
      t.state.fail++;
      t.state.failures.push(file + ' › 套件加载/执行异常');
      process.stdout.write('\n■ ' + file + '\n   ✗ 套件异常：' + (e && e.message) + '\n');
      if (e && e.stack) process.stdout.write(e.stack.split('\n').slice(0, 4).join('\n') + '\n');
    }
    /* 声明数 ≠ 执行数 = 有测试代码根本没跑到。
       最常见的一种：写在 module.exports 顶层 return 之后的 suite ——
       函数已经返回，后面整段是死代码，断言一条都不会执行，
       而 FAIL 仍然是 0。没有这条核对，「测试变绿」和「测试变少」长得一模一样。 */
    const ran = t.state.suites.length - before;
    if (ran !== declared) {
      t.state.fail++;
      t.state.failures.push(file + ' › 套件未全部执行：声明 ' + declared + ' 个，实跑 ' + ran + ' 个');
      process.stdout.write('\n■ ' + file + '\n   ✗ 声明 ' + declared + ' 个 suite，只跑到 ' + ran +
        ' 个 —— 有测试代码没被执行（检查顶层 return 之后的死代码）\n');
    }
  }
  const pass = t.summary('解语 Jieyu 测试套件');
  process.exit(pass ? 0 : 1);
})();
