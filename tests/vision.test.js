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
  t.not(V.synth === undefined, 'synth 已导出（浏览器下才可用）');
  t.eq(typeof V.synth, 'function', 'synth 是函数');
  t.eq(V.available(), false, 'Node 环境判定为不可用（无 DOM）');

  t.suite('vision · 统一 schema（识图 / 皮肤状态 / 妆容）');
  const obs = V.observe(clean);
  t.eq(obs.provider, 'offline', '离线观察 provider=offline');
  t.eq(obs.kind, 'skin', '肤色画面被识别为 skin 类');
  t.eq(obs.object.name, '未识别', '离线不识别物体（诚实 unknown）');
  t.ok(/VLM/.test(obs.object.note), '识图备注指向需 VLM');
  t.ok(Array.isArray(obs.condition.findings), 'condition 含 findings');
  t.eq(obs.condition.findings.length, 4, 'condition 覆盖 泛红/暗沉/痘斑/肿胀 四项');
  const redFinding = obs.condition.findings.filter(function (f) { return f.key === '泛红'; })[0];
  t.eq(redFinding.severity, 'none', '纯肤色画面泛红 none');
  t.eq(obs.condition.findings.filter(function (f) { return f.key === '肿胀'; })[0].severity, 'unknown', '肿胀离线标 unknown（不瞎判）');
  t.eq(obs.makeup.style, null, '离线不推荐妆容（诚实 unknown）');
  t.ok(/VLM/.test(obs.makeup.note), '妆容备注指向需 VLM');

  t.suite('vision · 皮肤状态 rubric 随泛红升级');
  const condSev = V.observe(severe).condition.findings.filter(function (f) { return f.key === '泛红'; })[0];
  t.eq(condSev.severity, 'severe', '40% 泛红 → 泛红 severe');
  t.eq(V.observe(mild).condition.findings.filter(function (f) { return f.key === '泛红'; })[0].severity, 'moderate', '18% 泛红 → 泛红 moderate');

  /* ---------- 类型闸门：离线不许把任意图片说成皮肤 ----------
     旧判据是「排除掉不像的」，白底截图 / 商品主图也被标成 skin，
     下游于是给出「停用功效型产品 / 去皮肤科」这种医疗建议。 */
  t.suite('vision · 类型闸门（离线不把任意图片当皮肤自拍）');
  const paper = V.observe(V.statsFromPixels(makePixels(60, 60, 0, [250, 250, 250]), 60, 60));
  t.eq(paper.kind, 'unknown', '白底截图不再被标成 skin');
  t.eq(paper.condition.findings.filter(function (f) { return f.severity !== 'unknown'; }).length, 0,
    '类型未确认 → 四项皮肤结论全部 unknown');
  t.eq(paper.condition.dullness, null, '不输出凭空的暗沉数值');
  t.eq(paper.condition.spots, null, '不输出凭空的暗点数值');
  t.includes(paper.condition.summary, '未确认', '摘要如实说明「类型未确认」');
  const gray = V.observe(V.statsFromPixels(makePixels(60, 60, 0, [128, 130, 132]), 60, 60));
  t.eq(gray.kind, 'unknown', '冷灰调商品图同样 unknown');

  /* 带红色 Logo 的截图：离线像素统计确实分不出「红的是脸还是包装」——这是已知局限，
     不假装能分。能分的是 VLM，所以闸门做在改判处：模型说不是皮肤，就必须连带撤掉皮肤信号。 */
  t.suite('vision · VLM 改判类型时撤掉皮肤信号（parseVlm）');
  const skinObs = V.observe(severe);
  t.eq(skinObs.signals[0], '影像可见皮肤异常', '重度泛红照片产出影像信号');
  const asProduct = V.parseVlm(
    { choices: [{ message: { content: '{"kind":"product","object":{"name":"红色面霜包装","confidence":0.83}}' } }] },
    { stats: severe, observation: skinObs }, 'vlm-x');
  t.eq(asProduct.kind, 'product', 'VLM 的 kind 覆盖离线判定');
  t.eq(asProduct.signals.length, 0, '改判为商品后不再保留皮肤信号（否则 +18 分凭空抬等级）');
  t.eq(asProduct.provider, 'vlm-x', 'provider 写成分析器名');
  t.eq(asProduct.object.name, '红色面霜包装', 'VLM 的识图结果并入');
  t.eq(skinObs.signals.length, 1, '不就地改写入参（原离线观察保持不动）');
  const asSkin = V.parseVlm(
    { choices: [{ message: { content: '{"kind":"skin","signals":["影像可见明显皮损"]}' } }] },
    { stats: severe, observation: V.observe(clean) }, 'vlm-y');
  t.eq(asSkin.signals.indexOf('影像可见明显皮损') !== -1, true, '判为皮肤时保留 VLM 给出的皮损信号');
  const noJson = V.parseVlm(
    { choices: [{ message: { content: '这轮模型没按 JSON 输出' } }] },
    { stats: severe, observation: V.observe(severe) }, 'vlm-z');
  t.eq(noJson.kind, 'skin', '解析失败时保留离线结论（不静默变成 unknown）');
  t.eq(noJson.signals.length, 1, '解析失败不新增信号');

  t.eq(V.observe(clean).kind, 'skin', '暖调 + 明度/饱和度落在人脸区间 → 判为皮肤（正向证据）');
  t.eq(V.observe(mild).kind, 'skin', '统计到偏红区域 → 判为皮肤');
  t.eq(V.observe(severe).signals[0], '影像可见皮肤异常', '皮肤照片的偏红仍然并入风险');

  t.suite('vision · 图像类型说法（唯一一份 kindLabel）');
  t.eq(typeof V.kindLabel, 'function', 'kindLabel 已导出');
  t.eq(V.kindLabel(paper), '图片（类型未确认）', '未知类型不与「真认过图」混为一谈');
  t.eq(V.kindLabel(V.observe(clean)), '皮肤照片', '皮肤图有明确标签');
  t.eq(V.kindLabel({ kind: 'product' }), '已识别商品', 'VLM 识别出的商品有明确标签');
  t.eq(V.kindLabel(null), '图片', '无观察时退化为中性说法');

  t.suite('vision · 注册 VLM 可返回完整 schema');
  V.register('vlm-full', function (asset) {
    const o = V.observe(asset.stats);
    o.provider = 'vlm-full';
    o.kind = 'product';
    o.object = { name: '某品牌精华液', confidence: 0.91, note: 'VLM 识别' };
    o.condition = { findings: [{ key: '泛红', severity: 'mild', value: '6%', note: '轻度' }], summary: '轻度泛红' };
    o.makeup = { style: '清透伪素颜', palette: ['裸粉', '豆沙'], products: ['隔离', '腮红'], note: '基于肤色推荐' };
    return o;
  });

  /* 两段异步（VLM 完整输出 / VLM 授权闸门）合并进同一个返回的 promise 链，
     避免两个 return 让后一段变成死代码 */
  return (async function () {
    const res = await V.analyzeWith('vlm-full', { dataUrl: '', stats: clean });
    t.eq(res.observation.provider, 'vlm-full', 'analyzeWith 写入 provider');
    t.eq(res.observation.kind, 'product', 'VLM 可改写 kind 为 product（识图）');
    t.eq(res.observation.object.name, '某品牌精华液', 'VLM 填充 object.name');
    t.eq(res.observation.makeup.style, '清透伪素颜', 'VLM 填充 makeup.style（妆容推荐）');

    t.suite('vision · VLM 适配器（授权闸门 + 降级）');
    V.registerVLM('vlm-gate', { endpoint: 'https://example.invalid/vlm', consent: false });
    t.eq(V.analyzers().indexOf('vlm-gate') !== -1, true, 'registerVLM 注册进分析器表');
    const g = await V.analyzeWith('vlm-gate', { dataUrl: 'data:image/png;base64,xx', observation: V.observe(clean) });
    t.eq(g.observation.provider, 'offline', '未授权时 VLM 不覆盖 provider（原图不出浏览器）');
    t.eq(g.observation._vlmSkipped, true, '未授权标记已置位');
    t.eq(g.observation.kind, 'skin', '未授权仍回退到离线观察（保留 skin 判定）');
  })();
};
