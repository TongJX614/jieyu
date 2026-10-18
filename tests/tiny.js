/* ==========================================================================
   极简测试运行器（零依赖）
   —— 项目是零构建的，所以测试也不引入 jest/mocha：
       node tests/run-all.js 即可跑完全部用例。
   ========================================================================== */

'use strict';

const state = { pass: 0, fail: 0, failures: [], current: '(root)', suites: [] };

/* 每次进入一个套件都登记一次名字。run-all.js 用它核对
   「源码里声明了几个 suite」与「实际跑到了几个 suite」——
   断言静默消失（写在顶层 return 之后、或前置异常把后半段带走）时，
   套件数会少掉，而 FAIL 依然是 0：那才是最难发现的假绿。 */
function suite(name) {
  state.current = name;
  state.suites.push(name);
  process.stdout.write('\n■ ' + name + '\n');
}

function record(okFlag, label, detail) {
  if (okFlag) {
    state.pass++;
    process.stdout.write('   ✓ ' + label + '\n');
  } else {
    state.fail++;
    state.failures.push(state.current + ' › ' + label + (detail ? '  →  ' + detail : ''));
    process.stdout.write('   ✗ ' + label + (detail ? '  →  ' + detail : '') + '\n');
  }
}

function show(v) {
  if (typeof v === 'string') return JSON.stringify(v.length > 90 ? v.slice(0, 90) + '…' : v);
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

function eq(actual, expected, label) {
  record(actual === expected, label, actual === expected ? '' : '期望 ' + show(expected) + '，实际 ' + show(actual));
}

function near(actual, expected, tol, label) {
  const d = Math.abs(Number(actual) - Number(expected));
  record(d <= tol, label, d <= tol ? '' : '期望 ' + expected + '±' + tol + '，实际 ' + actual);
}

function ok(value, label) { record(!!value, label, value ? '' : '值为假：' + show(value)); }

function not(value, label) { record(!value, label, !value ? '' : '值为真：' + show(value)); }

function includes(hay, needle, label) {
  const h = String(hay == null ? '' : hay);
  record(h.indexOf(needle) !== -1, label, h.indexOf(needle) !== -1 ? '' : '未找到 ' + show(needle) + ' in ' + show(h));
}

function throws(fn, label) {
  let t = false;
  try { fn(); } catch (e) { t = true; }
  record(t, label, t ? '' : '未抛出异常');
}

function summary(fileLabel) {
  process.stdout.write('\n────────────────────────────────────────\n');
  process.stdout.write((fileLabel || '测试') + '：PASS ' + state.pass + ' / FAIL ' + state.fail + '\n');
  if (state.fail) {
    process.stdout.write('\n失败用例：\n');
    state.failures.forEach((f) => process.stdout.write('  · ' + f + '\n'));
  }
  return state.fail === 0;
}

module.exports = { suite, eq, near, ok, not, includes, throws, summary, state };
