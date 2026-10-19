/* ==========================================================================
   资产运行时（Asset Runtime）—— 在 Node 里加载浏览器脚本

   为什么需要这一层：
     本项目的判定真源是 `assets/*.js` 那一套**浏览器脚本**（零构建、UMD 或
     `window.X = …`）。要把「同一条管线搬到服务端跑」，只有两条路：
       ① 在服务端另写一份判定逻辑 —— 那就出现第二套标准，正是全项目一直在防的事
          （`riskfloor`、`ST19`、统一标准 policy.js 存在的理由都是它）；
       ② 让服务端加载**同一份文件** —— 本模块就是这条路。
     所以这里不复制任何业务逻辑，只负责「把浏览器脚本放进一个有 `window` 的
     上下文里执行」，加载完把挂上去的模块交回调用方。

   为什么放在 `server/` 而不是 `tests/`：
     测试早就在用这套加载方式（`tests/sandbox.js`），但生产代码不该依赖测试目录。
     现在实现搬到这里，`tests/sandbox.js` 只是转出去 —— **两边跑的是同一份加载器**，
     不会出现「测试里能加载、服务里加载不出来」这种分裂。

   边界（故意不做的事）：
     · 不给 DOM。加载了需要 document 的脚本会当场抛错，而不是静默半可用 ——
       `app.js` / `llm.js` / `vision.js` 这些带界面与网络的模块本来就不该进服务端。
     · `localStorage` 只在调用方显式要的时候给一个内存桩（`memoryStorage()`）。
       服务端默认**不给**：谁依赖它谁就会立刻发现「服务端没有浏览器存储」。
   ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

/**
 * 按依赖顺序把浏览器脚本加载进一个干净上下文。
 * @param {string[]} files 相对项目根的脚本路径
 * @param {object} [extra] 额外的沙箱全局（例如 localStorage 桩）
 * @returns {object} 沙箱本身：`window` 指向它自己，模块挂在 `sandbox.X` 上
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

/**
 * 缺失检查：加载完先证明要用的模块真挂上了，再交给调用方。
 * 少了这一步，后面拿到的是 `undefined`，报错会发生在某条消息的分析途中，
 * 而不是启动时 —— 那种错误定位成本极高。
 */
function requireNames(sandbox, names) {
  const missing = (names || []).filter((n) => !sandbox || !sandbox[n]);
  if (missing.length) {
    throw new Error('资产运行时缺少模块：' + missing.join('、') +
      '（检查 server/asset-runtime.js 的加载清单）');
  }
  return sandbox;
}

/** 内存版 localStorage 桩：只给确实需要它的单测用 */
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

module.exports = { load, requireNames, memoryStorage, ROOT };
