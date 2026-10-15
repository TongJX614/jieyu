/* ==========================================================================
   测试用沙箱加载器
   —— 浏览器脚本（window.XXX = ...）放进 vm 上下文里跑，window 即上下文全局，
      于是可以在 Node 里直接单测 policy / engine / orderctx / guard / bus / vision。
   —— harness/core.js、harness/stages.js、vision.js、eval/kit.js 本身是 UMD，
      直接 require 即可，不必进沙箱。
   ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

/**
 * @param {string[]} files 相对项目根的脚本路径（按依赖顺序）
 * @param {object} [extra] 额外的沙箱全局（例如 localStorage 桩）
 */
function load(files, extra) {
  const sandbox = Object.assign({}, extra || {});
  sandbox.window = sandbox;
  sandbox.console = console;
  vm.createContext(sandbox);
  for (const rel of files) {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    vm.runInContext(code, sandbox, { filename: rel });
  }
  return sandbox;
}

/** 极简 localStorage 桩（bus.js / casefile.js 会用到） */
function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    key: (i) => Array.from(m.keys())[i] || null,
    get length() { return m.size; },
  };
}

module.exports = { load, memoryStorage, ROOT };
