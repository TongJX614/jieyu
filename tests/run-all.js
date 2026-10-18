#!/usr/bin/env node
/* ==========================================================================
   npm test —— 跑仓库内全部测试套件（零依赖，node 直接执行）
   ========================================================================== */

'use strict';

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
  'bugfix.test.js',
  'domain.test.js',
  'propfit.test.js',
];

(async function () {
  for (const file of SUITES) {
    try {
      const suite = require('./' + file);
      await suite(t);
    } catch (e) {
      t.state.fail++;
      t.state.failures.push(file + ' › 套件加载/执行异常');
      process.stdout.write('\n■ ' + file + '\n   ✗ 套件异常：' + (e && e.message) + '\n');
      if (e && e.stack) process.stdout.write(e.stack.split('\n').slice(0, 4).join('\n') + '\n');
    }
  }
  const pass = t.summary('解语 Jieyu 测试套件');
  process.exit(pass ? 0 : 1);
})();
