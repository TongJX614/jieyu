/* 视觉通道 vision.js：像素统计 → 视觉观察（纯函数部分） */

'use strict';

const { load } = require('./sandbox');

/* 造一块 RGBA 像素：底色肤色 + 指定比例的强红像素 */
function makePixels(w, h, redRatio, base) {
  const b = base || [222, 184, 158];
  const n = w * h;
  const data = new Uint8ClampedArray(n * 4);
  const redCount = Math.round(n * redRatio);
  for (let i = 0; i < n; i++) {
    const red = i < redCount;
    const r = red ? 196 : b[0];
    const g = red ? 58 : b[1];
    const bl = red ? 52 : b[2];
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = bl; data[i * 4 + 3] = 255;
  }
  return data;
}

module.exports = function (t) {
  const S = load(['assets/vision.js']);
  const V = S.Vision;

  t.suite('vision · 像素统计');
  const clean = V.statsFromPixels(makePixels(60, 60, 0), 60, 60);
  t.near(clean.redness, 0, 0.001, '纯肤色画面泛红占比 ≈ 0');
  t.ok(clean.bright > 150, '肤色画面明度正常');
  const mild = V.statsFromPixels(makePixels(60, 60, 0.18), 60, 60);
  t.near(mild.redness, 0.18, 0.01, '18% 偏红像素被统计出来');
  const severe = V.statsFromPixels(makePixels(60, 60, 0.4), 60, 60);
  t.near(severe.redness, 0.4, 0.01, '40% 偏红像素被统计出来');
  t.eq(V.statsFromPixels(makePixels(10, 10, 0), 10, 10).n, 100, 'n = w × h');

  t.suite('vision · 观察分级');
  t.eq(V.observe(null), null, '无统计量返回 null');
  const lo = V.observe(clean);
  t.eq(lo.level, 'low', '无泛红 → low');
  t.eq(lo.signals.length, 0, 'low 不产生信号（避免误报）');
  const mi = V.observe(mild);
  t.eq(mi.level, 'medium', '18% 泛红 → medium');
  t.eq(mi.signals[0], '影像可见皮肤异常', '命中影像信号');
  const hi = V.observe(severe);
  t.eq(hi.level, 'high', '40% 泛红 → high');
  t.eq(hi.detail.length, 4, '观察明细 4 项');
  t.includes(hi.summary, '泛红', '摘要含结论文字');

  t.suite('vision · 注册插槽（真 VLM 的接入点）');
  t.eq(V.analyzers().length, 0, '默认未注册任何分析器（走本机像素统计）');
  V.register('vlm-stub', function (asset) {
    return { level: 'high', label: '模型判定', redness: 33, signals: ['影像可见皮肤异常'], summary: 'stub', detail: [] };
  });
  t.eq(V.analyzers().length, 1, '注册后出现在分析器列表');
  t.not(V.synth === undefined, true, 'synth 已导出（浏览器下才可用）');
  t.eq(typeof V.synth, 'function', 'synth 是函数');
  t.eq(V.available(), false, 'Node 环境判定为不可用（无 DOM）');
};
