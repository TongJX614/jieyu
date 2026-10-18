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

/* 造一个「装了 fetch 桩」的沙箱：同源代理那条链路必须能数清
   ——到底发没发、发到哪、头上带没带密钥。桩返回什么由每条断言自己定。 */
function relayBox(responder) {
  const calls = [];
  const S = load(['assets/vision.js'], {
    fetch: function (url, opts) {
      calls.push({ url: url, opts: opts || {}, body: opts && opts.body });
      return Promise.resolve(responder(url, opts));
    },
  });
  return { V: S.Vision, calls: calls };
}

function vlmResponse(status, obj, rawText) {
  const body = rawText == null ? JSON.stringify(obj) : rawText;
  return {
    ok: status >= 200 && status < 300,
    status: status,
    json: function () { return Promise.resolve(obj); },
    text: function () { return Promise.resolve(body); },
  };
}

const RELAY_OK = {
  choices: [{ message: { content: '{"kind":"product","object":{"name":"红色面霜瓶身","confidence":0.88},"makeup":{"style":"无妆面（这是商品图）"},"summary":"这是一支护手霜，不是皮肤照片"}' } }],
};

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

  t.suite('vision · 缩略图（丢原图之后界面上还剩什么）');
  /* 必须写在下面那个 return 之前 —— 本文件只有一条返回链，
     return 之后的同步代码一行都不会执行（断言会静默消失，套件照样绿）。 */
  {
    /* Node 里没有 canvas。makeThumb 必须**如实返回 null**，而不是抛错或凭空造一张 ——
       调用方（app.js）拿 null 就当「只有原图」处理，编不出像素才是诚实的行为。 */
    t.eq(V.makeThumb(null), null, '没有图像对象 → null');
    t.eq(V.makeThumb({ naturalWidth: 200, naturalHeight: 100 }), null, '无 DOM：返回 null，不抛、不假造');
    t.eq(V.THUMB_EDGE, 96, '缩略图长边全项目只在这里定义（app 的「只是 96px 缩略图」那句话读的就是它）');
    t.eq(typeof V.analyzeFile, 'function', 'analyzeFile 仍在（缩略图挂在它的产物上）');
  }

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

    /* ---------- 同源代理适配器：密钥不进浏览器 + 逐张授权 ----------
       这一段只信一件事：fetch 桩被叫了几次、参数是什么。
       「没外发」是这产品对客户的承诺，承诺只能靠数调用次数来钉。 */
    t.suite('vision · 同源视觉代理（闸门关着就一次 fetch 都不发）');
    const A = relayBox(() => vlmResponse(200, RELAY_OK));
    A.V.registerVLM('vlm-relay', {
      endpoint: '/api/vlm',
      consent: function (asset) { return !!(asset && asset.consent); },
    });
    const baseObs = A.V.observe(clean);
    const silent = await A.V.analyzeWith('vlm-relay',
      { dataUrl: 'data:image/png;base64,AAA=', observation: JSON.parse(JSON.stringify(baseObs)) });
    t.eq(A.calls.length, 0, 'consent 函数判 false → 一次请求都没发（原图确实没出浏览器）');
    t.eq(silent.observation.provider, 'offline', '未授权时 provider 保持 offline');
    t.eq(silent.observation._vlmSkipped, true, '未授权标记区分「没授权」与「模型失败」');

    const granted = await A.V.analyzeWith('vlm-relay', {
      dataUrl: 'data:image/png;base64,AAA=', consent: true,
      observation: JSON.parse(JSON.stringify(baseObs)),
    });
    t.eq(A.calls.length, 1, '同一分析器、换一张勾了授权的图 → 就发了这一张');
    t.eq(A.calls[0].url, '/api/vlm', '打的是同源代理，不是第三方域名');
    t.eq(A.calls[0].opts.headers.Authorization, undefined, '同源代理不带 Authorization（密钥只在服务端）');
    t.eq('Authorization' in A.calls[0].opts.headers, false, '连空头 Bearer 都不发（空值会被网关判 401）');
    t.eq(A.calls[0].opts.headers['Content-Type'], 'application/json', '照常声明 JSON');
    const sentBody = JSON.parse(A.calls[0].body);
    t.eq(sentBody.messages.length, 2, '默认发 system + user 两条');
    t.includes(JSON.stringify(sentBody.messages[1].content), 'data:image/png;base64,AAA=', '待分析图作为 data URL 带在消息里');
    t.eq(granted.observation.provider, 'vlm-relay', '授权后模型结论覆盖离线结论');
    t.eq(granted.observation.object.name, '红色面霜瓶身', '识图结果来自模型');
    t.not(granted.observation._vlmUnparsed, '按 JSON 回答时不打「未解析」标记');

    t.suite('vision · 直连模式仍然带密钥（两种接法的区别钉住）');
    const B = relayBox(() => vlmResponse(200, RELAY_OK));
    B.V.registerVLM('vlm-direct', {
      endpoint: 'https://api.example.invalid/v1/chat/completions',
      key: 'sk-from-localstorage', consent: true,
    });
    await B.V.analyzeWith('vlm-direct', { dataUrl: 'data:image/png;base64,BBB=', observation: B.V.observe(clean) });
    t.eq(B.calls.length, 1, '直连模式确实把图发出去了（这是模式 B 的代价，界面上不许默认走这条）');
    t.eq(B.calls[0].opts.headers.Authorization, 'Bearer sk-from-localstorage', '模式 B 由客户端自己补密钥');

    t.suite('vision · 通道失败要说「没答上」，不许说「看不出来」');
    const C = relayBox(() => vlmResponse(503, {
      ok: false, reason: 'unconfigured',
      error: { message: '未配置视觉模型（VLM_BASE_URL / VLM_API_KEY），图片走本机像素统计的离线结论' },
    }));
    C.V.registerVLM('vlm-relay', { endpoint: '/api/vlm', consent: true });
    const cObs = C.V.observe(severe);
    const degraded = await C.V.analyzeWith('vlm-relay', { dataUrl: 'data:image/png;base64,CCC=', observation: cObs });
    t.eq(degraded.observation.provider, 'offline', '503 不当成模型结论（否则「没配通道」伪装成「图看不出来」）');
    t.includes(degraded.observation._vlmError, '503', '错误里带上 HTTP 状态，界面能区分限流与未配置');
    t.includes(degraded.observation._vlmError, '未配置视觉模型', '把服务端那句原因原样带回来，不自己编');
    t.eq(degraded.observation.kind, 'skin', '降级后保留离线判定，不静默改成 unknown');
    t.eq(degraded.observation.signals.length, 1, '降级不新增信号');

    const D = relayBox(() => vlmResponse(429, {
      ok: false, reason: 'rate_limited', error: { message: '视觉通道频率超限（每分钟 6 次），已改用离线像素统计' },
    }));
    D.V.registerVLM('vlm-relay', { endpoint: '/api/vlm', consent: true });
    const limited = await D.V.analyzeWith('vlm-relay', { dataUrl: 'data:image/png;base64,DDD=', observation: D.V.observe(severe) });
    t.includes(limited.observation._vlmError, '429', '超频也是失败，不当成结论');
    t.eq(limited.observation.provider, 'offline', '超频退回本机像素统计');

    const E = relayBox(() => { throw new Error('网络不通'); });
    E.V.registerVLM('vlm-relay', { endpoint: '/api/vlm', consent: true });
    const eObs = E.V.observe(severe);
    const netFail = await E.V.analyzeWith('vlm-relay', { dataUrl: 'data:image/png;base64,EEE=', observation: eObs });
    t.includes(netFail.observation._vlmError, '网络不通', 'fetch 同步抛错也降级，不许穿过 catch 把分析炸掉');
    t.eq(netFail.observation.provider, 'offline', '同步抛错同样退回本机结论');
    t.eq(eObs.provider, 'offline', '离线的原始观察不是来自模型');
    t.eq(eObs._vlmError, undefined, '降级不污染调用方那份观察（同一张图重跑要洗得掉）');

    const G = relayBox(() => vlmResponse(200, RELAY_OK));
    G.V.registerVLM('vlm-relay', {
      endpoint: '/api/vlm',
      consent: function () { throw new Error('授权读取失败'); },
    });
    const gateBroken = await G.V.analyzeWith('vlm-relay', { dataUrl: 'data:image/png;base64,GGG=', observation: G.V.observe(clean) });
    t.eq(G.calls.length, 0, 'consent 函数抛错 → 当作没授权（失败方向必须是不发）');
    t.eq(gateBroken.observation._vlmSkipped, true, '判不出授权时按未授权标注');

    t.suite('vision · HTTP 200 但没按格式回答（诚实标注的第三条路）');
    const F = relayBox(() => vlmResponse(200, { choices: [{ message: { content: '这张图我不太确定' } }] }));
    F.V.registerVLM('vlm-relay', { endpoint: '/api/vlm', consent: true });
    const unparsed = await F.V.analyzeWith('vlm-relay', { dataUrl: 'data:image/png;base64,FFF=', observation: F.V.observe(severe) });
    t.eq(unparsed.observation._vlmUnparsed, true, '没有 JSON → 打「未按格式回答」标记');
    t.eq(unparsed.observation.kind, 'skin', '结论仍是离线的（模型没给出任何字段）');
    t.eq(unparsed.observation._vlmError, undefined, '它不是失败：图确实发出去了，只是没答上格式');
  })();
};
