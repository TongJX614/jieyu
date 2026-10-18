/* ==========================================================================
   视觉通道 Vision —— 消费者上传的皮肤照片 → 结构化「视觉观察」

   为什么不用「把图片丢给多模态大模型」当默认实现：
     · 演示现场经常没有 Key、也可能断网；而且当前默认模型（deepseek-chat）无视觉能力。
     · 所以默认实现是**可解释、可离线、可复现**的像素统计（泛红占比 / 明度 / 饱和度），
       产出的是结构化结论而不是一段描述 —— 结论直接进风险判定，链路可核对。
     · 真接多模态模型（通义千问-VL / GPT-4o 等）时，只需 Vision.register()，
       上层管线、界面、风险口径一行都不用改。

   分层（与 harness 的「引擎 / 阶段 / 提供者」同构）：
     statsFromPixels  纯函数：像素 → 统计量（Node 可测）
     observe          纯函数：统计量 → 视觉观察（分级 / 摘要 / 命中信号）
     analyzeFile      浏览器：File → dataURL + 统计 + 观察（画到小画布取像素）
     synth            浏览器：合成一张示例皮肤照（演示用，不需要外部素材）
     register         插槽：注册真实视觉分析器（多模态模型）
   ========================================================================== */

(function (factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Vision = api;
})(function () {
  'use strict';

  /* 影像自身的分级阈值（只用于「这张照片看起来红不红」，与风险等级口径无关） */
  var RED_HIGH = 0.24;      // 偏红像素占比 ≥ 24% → 明显泛红
  var RED_MID = 0.14;       // ≥ 14% → 轻度泛红
  var RED_PIXEL = 0.38;     // 单像素判为「偏红」的归一化红度阈值
  var MAX_EDGE = 180;       // 缩到长边 180px 再统计：够用且快

  var ANALYZERS = {};       // 视觉分析器注册表（真 VLM 的插槽）

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function r1(v) { return Math.round(v * 10) / 10; }

  /**
   * 像素统计（纯函数）
   * @param {Uint8ClampedArray|Array} data RGBA 连续数组
   * @param {number} w @param {number} h
   */
  function statsFromPixels(data, w, h) {
    var n = Math.max(1, w * h);
    var sumR = 0, sumG = 0, sumB = 0, redish = 0, satSum = 0, brightSum = 0, dark = 0;
    for (var i = 0; i < n; i++) {
      var r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      sumR += r; sumG += g; sumB += b;
      var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      var sat = mx ? (mx - mn) / mx : 0;
      var bright = (r + g + b) / 3;
      satSum += sat;
      brightSum += bright;
      if (bright < 60) dark++;
      /* 偏红判据：用**归一化红度** (r-g)/r 而不是绝对差值 ——
         正常肤色本身就是暖色（r-g 可达 38），绝对差会把整张脸判成泛红；
         归一化后肤色约 0.17、泛红斑块约 0.70，区分度足够。 */
      var rScore = (r - g) / Math.max(1, r);
      if (r > 80 && rScore >= RED_PIXEL) redish++;
    }
    return {
      n: n, w: w, h: h,
      r: sumR / n, g: sumG / n, b: sumB / n,
      redness: redish / n,
      sat: satSum / n,
      bright: brightSum / n,
      darkRatio: dark / n,
      warm: (sumR - sumB) / n,
    };
  }

  /* 皮肤状态 severity 取值：none / mild / moderate / severe / unknown */

  /**
   * 离线启发式：这张图「像不像皮肤自拍」。
   *
   * 判据必须是**正向证据**，不能是「排除掉不像的」：
   * 旧实现里 `bright∈(70,245) && sat>0.05` 单独一条就算皮肤 —— 那是几乎所有照片的
   * 共同特征，于是产品图、快递单截图也被标成 skin，下游话术跟着给出医疗建议。
   * 现在只有两种情况判皮肤：① 统计到偏红区域（这是可测量的事实）；
   * ② 明显暖调 **且** 明度/饱和度同时落在人脸常见区间。给不出证据就如实 unknown。
   */
  function heuristicKind(st) {
    if (st.redness >= RED_MID * 0.6) return 'skin';
    var warmish = st.warm >= 14;
    var faceRange = st.bright > 70 && st.bright < 235 && st.sat > 0.08 && st.sat < 0.55;
    return (warmish && faceRange) ? 'skin' : 'unknown';
  }

  /**
   * 皮肤状态 rubric（离线弱启发式）。
   * 只动像素统计量里已有的字段（redness / sat / bright / darkRatio），不引入新依赖；
   * 对「单张 2D 照片判不了」的项（肿胀）诚实标 unknown。
   *
   * kind !== 'skin' 时**整块降级为 unknown**：一张快递单截图的「饱和度低」
   * 是背景白，不是肤色暗沉。数值本身（偏红区域占比）是可测的事实，仍然给出来，
   * 但不再产生任何带医学含义的结论。
   */
  function skinCondition(st, kind) {
    var rednessPct = r1((st.redness || 0) * 100);

    if (kind !== 'skin') {
      var na = [
        { key: '泛红', severity: 'unknown', value: rednessPct + '%', note: '图片类型未确认，偏红占比只是像素事实，不构成皮肤结论' },
        { key: '暗沉', severity: 'unknown', value: '—', note: '需先确认为皮肤照片' },
        { key: '痘 / 色斑', severity: 'unknown', value: '—', note: '需先确认为皮肤照片' },
        { key: '肿胀', severity: 'unknown', value: '—', note: '单张 2D 照片难以判定肿胀，需结合顾客主诉 / 触感' },
      ];
      return {
        redness: rednessPct, dullness: null, spots: null,
        findings: na,
        summary: '图片类型未确认（离线像素统计不足以判定皮肤状态，需视觉模型 VLM）',
      };
    }

    var dull = clamp((1 - st.sat) * 0.7 + (st.bright < 100 ? 0.3 : 0), 0, 1);  // 暗沉指数 0-1
    var spotProxy = st.darkRatio;                              // 局部暗点占比 0-1（弱启发式）

    var findings = [];
    var rSev = st.redness >= RED_HIGH ? 'severe' : st.redness >= RED_MID ? 'moderate' : st.redness >= RED_MID * 0.6 ? 'mild' : 'none';
    findings.push({
      key: '泛红', severity: rSev, value: rednessPct + '%',
      note: rSev === 'none' ? '未见明显泛红' : '偏红区域占比 ' + rednessPct + '%，提示炎症 / 刺激可能',
    });
    var dSev = dull >= 0.55 ? 'moderate' : dull >= 0.35 ? 'mild' : 'none';
    findings.push({
      key: '暗沉', severity: dSev, value: r1(dull * 100),
      note: dSev === 'none' ? '肤色明亮度正常' : '明度 / 饱和度偏低，提示暗沉或曝光不足（需结合主诉）',
    });
    var sSev = spotProxy >= 0.10 ? 'moderate' : spotProxy >= 0.05 ? 'mild' : 'none';
    findings.push({
      key: '痘 / 色斑', severity: sSev, value: r1(spotProxy * 100),
      note: sSev === 'none' ? '未见明显局部暗点' : '检出局部暗点（离线弱启发式，需视觉模型确认）',
    });
    /* 肿胀：单张 2D 照片基本判不了，离线只给提示，不瞎判 */
    findings.push({
      key: '肿胀', severity: 'unknown', value: '—',
      note: '单张 2D 照片难以判定肿胀，需结合顾客主诉 / 触感',
    });

    var active = findings.filter(function (f) { return f.severity !== 'none' && f.severity !== 'unknown'; });
    var top = active.slice().sort(function (a, b) {
      var rank = { severe: 3, moderate: 2, mild: 1, none: 0, unknown: 0 };
      return rank[b.severity] - rank[a.severity];
    })[0];
    var summary = top
      ? '主要关注：' + top.key + '（' + top.severity + '）'
      : '未见明显皮肤异常（离线像素统计）';

    return {
      redness: rednessPct,
      dullness: r1(dull * 100),
      spots: r1(spotProxy * 100),
      findings: findings,
      summary: summary,
    };
  }

  /** 离线：识图不识别，明确告诉调用方「需 VLM」 */
  function heuristicObject() {
    return {
      name: '未识别',
      confidence: 0,
      note: '离线模式不识别物体 / 场景；启用视觉模型（VLM）后可识别「这是什么」',
    };
  }

  /** 离线：妆容不推荐，明确告诉调用方「需 VLM」 */
  function heuristicMakeup() {
    return {
      style: null, palette: [], products: [],
      note: '离线模式不推荐妆容；启用视觉模型（VLM）后可基于肤色 / 五官推荐合适妆容',
    };
  }

  /**
   * 图像类型的对人说法（唯一一份）。
   * 之前 app.js 与 harness/agent.js 各写了一份，未知类型都笼统说「图片」——
   * 而「离线判不出这是什么」和「判出来是图片」是两回事，界面上必须分开，
   * 否则坐席会以为系统认过图。
   */
  var KIND_LABELS = { skin: '皮肤照片', product: '已识别商品', look: '妆容参考' };
  function kindLabel(o) {
    if (!o) return '图片';
    return KIND_LABELS[o.kind] || '图片（类型未确认）';
  }

  /** 统计量 → 视觉观察（纯函数，向后兼容旧字段，并扩展统一 schema） */
  function observe(st) {
    if (!st || !st.n) return null;
    var level = st.redness >= RED_HIGH ? 'high' : st.redness >= RED_MID ? 'medium' : 'low';
    var tone = st.bright >= 178 ? '偏亮' : st.bright <= 104 ? '偏暗' : '正常';
    var warmTxt = st.warm >= 28 ? '明显偏暖' : st.warm >= 14 ? '略偏暖' : '中性';

    var kind = heuristicKind(st);
    var cond = skinCondition(st, kind);
    var object = heuristicObject();
    var makeup = heuristicMakeup();

    /* 影像信号进的是风险权重表（「影像可见皮肤异常」+18，能单独把等级抬上去），
       所以它的成立条件必须和「这是皮肤照片」绑在一起，而不是和「画面偏红」绑在一起：
       偏红占比是像素事实（level / summary 照旧给出），但只有判为皮肤才允许抬风险。
       离线时 kind 与 redness 同源，这条基本恒真；真正会用上的是 VLM 改写 kind 之后
       （见 parseVlm）——模型说「这是一张商品图」，就不该再挂着一条皮肤异常信号。 */
    var signals = (level === 'low' || kind !== 'skin') ? [] : ['影像可见皮肤异常'];

    var label = level === 'high' ? '泛红明显' : level === 'medium' ? '轻度泛红' : '未见明显泛红';
    var summary = label + '（偏红区域占比 ' + r1(st.redness * 100) + '%，画面明度 ' +
      Math.round(st.bright) + '，色温' + warmTxt + '）';

    return {
      /* —— 风险面向（旧字段，已对接 risk 与 UI，保持不动）—— */
      provider: 'offline',
      level: level,
      label: label,
      redness: r1(st.redness * 100),
      bright: Math.round(st.bright),
      sat: r1(st.sat * 100),
      tone: tone,
      warm: warmTxt,
      darkRatio: r1(st.darkRatio * 100),
      signals: signals,
      summary: summary,
      detail: [
        { key: '泛红区域占比', v: r1(st.redness * 100) + '%' },
        { key: '画面明度', v: Math.round(st.bright) + ' / 255' },
        { key: '整体色温', v: warmTxt },
        { key: '平均饱和度', v: r1(st.sat * 100) + '%' },
      ],
      /* —— 统一 schema 扩展：识图 / 皮肤状态 / 妆容（离线默认 unknown，VLM 填充）—— */
      kind: kind,
      object: object,
      condition: cond,
      makeup: makeup,
    };
  }

  /* ------------------------------------------------------------ 浏览器部分 */

  function hasDom() {
    return typeof document !== 'undefined' && typeof Image !== 'undefined';
  }

  function readAsDataURL(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(String(fr.result)); };
      fr.onerror = function () { rej(new Error('图片读取失败')); };
      fr.readAsDataURL(file);
    });
  }

  function loadImage(src) {
    return new Promise(function (res, rej) {
      var im = new Image();
      im.onload = function () { res(im); };
      im.onerror = function () { rej(new Error('图片解码失败（格式不支持？）')); };
      im.src = src;
    });
  }

  function statsFromImage(img) {
    var w = img.naturalWidth || img.width || 0;
    var h = img.naturalHeight || img.height || 0;
    if (!w || !h) throw new Error('图片尺寸为 0');
    var s = Math.min(1, MAX_EDGE / Math.max(w, h));
    var cw = Math.max(1, Math.round(w * s)), chh = Math.max(1, Math.round(h * s));
    var cv = document.createElement('canvas');
    cv.width = cw; cv.height = chh;
    var cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0, cw, chh);
    var d = cx.getImageData(0, 0, cw, chh).data;
    return statsFromPixels(d, cw, chh);
  }

  /** 浏览器：File → { dataUrl, stats, observation } */
  function analyzeFile(file) {
    if (!hasDom()) return Promise.reject(new Error('视觉分析需要浏览器环境'));
    return readAsDataURL(file)
      .then(function (url) {
        return loadImage(url).then(function (img) {
          var st = statsFromImage(img);
          return { dataUrl: url, name: file.name || 'photo', size: file.size || 0, stats: st, observation: observe(st) };
        });
      });
  }

  /**
   * 合成一张示例皮肤照片（演示用）。
   * 用的是与真实照片完全相同的分析链路 —— 只有素材是合成的，判定过程没有特权。
   * @param {string} kind 'mild' | 'severe'
   */
  function synth(kind) {
    if (!hasDom()) return null;
    var severe = kind === 'severe';
    var W = 320, H = 320;
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var cx = cv.getContext('2d');
    /* 底色：肤色 */
    var grd = cx.createLinearGradient(0, 0, W, H);
    grd.addColorStop(0, severe ? '#e9c1a6' : '#efd0ba');
    grd.addColorStop(1, severe ? '#dda88c' : '#e8c6ae');
    cx.fillStyle = grd; cx.fillRect(0, 0, W, H);
    /* 斑块：偏红区域。密度 / 半径 / 中心不透明度按两档标定，
       目标是让合成图稳定落在「medium ≈ 轻度泛红」「high ≈ 明显泛红」两档。 */
    var spots = severe ? 32 : 30;
    var rMin = severe ? 22 : 18;
    var rSpan = severe ? 28 : 24;
    var alpha = severe ? 0.92 : 0.78;
    for (var i = 0; i < spots; i++) {
      var x = 16 + Math.random() * (W - 32);
      var y = 16 + Math.random() * (H - 32);
      var r = rMin + Math.random() * rSpan;
      var g2 = cx.createRadialGradient(x, y, 0, x, y, r);
      g2.addColorStop(0, 'rgba(196,46,38,' + alpha + ')');
      g2.addColorStop(1, 'rgba(196,46,38,0)');
      cx.fillStyle = g2;
      cx.beginPath(); cx.arc(x, y, r, 0, Math.PI * 2); cx.fill();
    }
    /* 轻微噪点，避免纯色被当成色卡 */
    for (var k = 0; k < 900; k++) {
      cx.fillStyle = 'rgba(0,0,0,' + (Math.random() * 0.045).toFixed(3) + ')';
      cx.fillRect(Math.random() * W, Math.random() * H, 1.4, 1.4);
    }
    return cv.toDataURL('image/png');
  }

  /** 浏览器：合成图 → 同样的分析链路 */
  function analyzeSynth(kind) {
    if (!hasDom()) return Promise.reject(new Error('视觉分析需要浏览器环境'));
    var url = synth(kind);
    return loadImage(url).then(function (img) {
      var st = statsFromImage(img);
      return { dataUrl: url, name: 'synth-' + kind + '.png', size: 0, synthetic: true, stats: st, observation: observe(st) };
    });
  }

  /* ------------------------------------------------------- 真实 VLM 插槽 */

  /**
   * 注册一个视觉分析器（例如多模态模型）。
   * fn(asset, ctx) → Promise<observation>（与 observe() 同构即可）
   * 注册后可用 analyzeWith(name, asset) 调用；未注册时默认走本机像素统计。
   */
  function register(name, fn) {
    if (typeof fn !== 'function') throw new Error('视觉分析器必须是函数');
    ANALYZERS[name] = fn;
    return true;
  }

  function analyzers() { return Object.keys(ANALYZERS); }

  function analyzeWith(name, asset) {
    var fn = ANALYZERS[name];
    if (!fn) return Promise.reject(new Error('未注册的视觉分析器：' + name));
    return Promise.resolve(fn(asset)).then(function (obs) {
      if (!obs) throw new Error('视觉分析器未返回观察结果');
      /* 只有分析器没自己声明 provider 时才填（离线兜底会保留 provider='offline'，
         避免把「未授权降级」误标成 VLM 分析） */
      if (!obs.provider) obs.provider = name;
      return { dataUrl: asset && asset.dataUrl, name: (asset && asset.name) || '', stats: asset && asset.stats, observation: obs };
    });
  }

  /* --------------------------------------------------------- 多模态模型（VLM）适配器
     把「真看懂」接进既有的 register() 插槽：识图 / 妆容推荐 由这里补齐，
     皮肤状态 severity 也以 VLM 为准（离线只给弱启发式）。

     隐私闸门（与项目合规口径同源）：
       · cfg.consent=false 时，分析器**绝不把原图发往任何第三方**，
         直接降级回离线像素统计结论，原图不出浏览器。
       · cfg.key 从 localStorage / 服务端取，**禁止硬编码**（与 LLM 同约定）。
     默认按 OpenAI 兼容接口（GPT-4o / 通义千问-VL 等）发图 + 收 JSON；
     也可用 cfg.buildMessages / cfg.parse 自定义任意 VLM。 */

  /**
   * VLM 响应 → 视觉观察（纯函数，抽出来便于单测）。
   * 规则：模型说了什么以模型为准，没说的保留离线结论；provider 换成分析器名。
   *
   * 关键闸门：模型把图改判成「商品 / 妆容 / 未知」时，必须**同时撤掉离线那条皮肤信号**。
   * 否则「影像可见皮肤异常」(+18) / 「影像可见明显皮损」(+22, 等级下限 medium) 会留在
   * risk.signals 里 —— 一张偏红的商品主图就凭这条凭空信号升到「关注」档，
   * 而这时系统已经明确知道自己看的不是脸。
   */
  var SKIN_SIGNALS = ['影像可见皮肤异常', '影像可见明显皮损'];
  function parseVlm(j, asset, name) {
    var txt = (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || (j && j.output) || '';
    var a = String(txt).indexOf('{');
    var b = String(txt).lastIndexOf('}');
    var parsed = {};
    if (a !== -1 && b > a) { try { parsed = JSON.parse(String(txt).slice(a, b + 1)); } catch (e) { /* 解析失败则保留离线结论 */ } }
    var base = asset && asset.observation ? JSON.parse(JSON.stringify(asset.observation))
      : (asset && asset.stats ? observe(asset.stats) : null);
    if (!base) base = { provider: 'offline', signals: [], detail: [] };
    var o = base;
    o.provider = name;
    if (parsed.kind) o.kind = parsed.kind;
    if (parsed.object) o.object = parsed.object;
    if (parsed.makeup) o.makeup = parsed.makeup;
    if (parsed.condition && parsed.condition.findings) {
      o.condition = o.condition || {};
      o.condition.findings = parsed.condition.findings;
      o.condition.summary = parsed.condition.summary || o.condition.summary || '';
    }
    o.signals = o.signals || [];
    (parsed.signals || []).forEach(function (s) { if (o.signals.indexOf(s) === -1) o.signals.push(s); });
    if (parsed.summary) o.summary = parsed.summary;
    if (o.kind && o.kind !== 'skin') {
      o.signals = o.signals.filter(function (s) { return SKIN_SIGNALS.indexOf(s) === -1; });
    }
    return o;
  }

  function registerVLM(name, cfg) {
    if (!cfg || !cfg.endpoint) throw new Error('VLM 必须提供 endpoint');
    function defaultMessages(dataUrl) {
      return {
        model: cfg.model || 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: '你是美妆客服的视觉分析助手。用户上传一张图片，请只输出 JSON，字段：' +
              'kind(skin|product|look|unknown)、object{name,confidence}、' +
              'condition.findings[{key,severity(none|mild|moderate|severe|unknown)}]（关注 泛红/暗沉/痘色斑/肿胀）、' +
              'makeup{style,palette[]}、signals[](可含「影像可见明显皮损」)、summary。不要输出 JSON 以外的文字。',
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: '请分析这张顾客上传的图片（用于美妆客服，仅描述图像本身）。' },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      };
    }
    function analyzer(asset) {
      /* 未授权：绝不外发原图，降级回离线结论 */
      if (!cfg.consent) {
        var fb = asset && asset.observation ? JSON.parse(JSON.stringify(asset.observation)) : (asset && asset.stats ? observe(asset.stats) : null);
        if (fb) { fb.provider = 'offline'; fb._vlmSkipped = true; }
        return Promise.resolve(fb || { provider: 'offline', signals: [], summary: '未授权，离线分析', detail: [] });
      }
      var dataUrl = asset && asset.dataUrl;
      if (!dataUrl) return Promise.resolve({ provider: 'offline', signals: [], summary: '无图像数据', detail: [] });
      var body = (cfg.buildMessages || defaultMessages)(dataUrl);
      return fetch(cfg.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (cfg.key || '') },
        body: JSON.stringify(body),
      }).then(function (r) { return r.json(); }).then(function (j) {
        /* 自定义解析器签名保持 (j, asset)；默认解析器需要知道分析器名（写进 provider） */
        return (cfg.parse || function (jj, aa) { return parseVlm(jj, aa, name); })(j, asset);
      }).catch(function (e) {
        /* VLM 不可用：降级回离线像素统计，不阻塞主流程 */
        var fb = asset && asset.stats ? observe(asset.stats) : (asset && asset.observation) || null;
        if (fb) { fb.provider = 'offline'; fb._vlmError = String((e && e.message) || e); }
        return fb || { provider: 'offline', signals: [], summary: 'VLM 不可用，已降级离线', detail: [] };
      });
    }
    register(name, analyzer);
    return true;
  }

  return {
    RED_HIGH: RED_HIGH, RED_MID: RED_MID, RED_PIXEL: RED_PIXEL, MAX_EDGE: MAX_EDGE,
    statsFromPixels: statsFromPixels,
    observe: observe,
    skinCondition: skinCondition,
    heuristicKind: heuristicKind,
    heuristicObject: heuristicObject,
    heuristicMakeup: heuristicMakeup,
    kindLabel: kindLabel,
    parseVlm: parseVlm,
    analyzeFile: analyzeFile,
    synth: synth,
    analyzeSynth: analyzeSynth,
    register: register,
    registerVLM: registerVLM,
    analyzers: analyzers,
    analyzeWith: analyzeWith,
    available: hasDom,
    clamp: clamp,
  };
});
