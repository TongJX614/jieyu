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

  /** 统计量 → 视觉观察（纯函数） */
  function observe(st) {
    if (!st || !st.n) return null;
    var level = st.redness >= RED_HIGH ? 'high' : st.redness >= RED_MID ? 'medium' : 'low';
    var tone = st.bright >= 178 ? '偏亮' : st.bright <= 104 ? '偏暗' : '正常';
    var warmTxt = st.warm >= 28 ? '明显偏暖' : st.warm >= 14 ? '略偏暖' : '中性';
    var signals = level === 'low' ? [] : ['影像可见皮肤异常'];

    var label = level === 'high' ? '泛红明显' : level === 'medium' ? '轻度泛红' : '未见明显泛红';
    var summary = label + '（偏红区域占比 ' + r1(st.redness * 100) + '%，画面明度 ' +
      Math.round(st.bright) + '，色温' + warmTxt + '）';

    return {
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
      obs.provider = name;
      return { dataUrl: asset && asset.dataUrl, name: (asset && asset.name) || '', stats: asset && asset.stats, observation: obs };
    });
  }

  return {
    RED_HIGH: RED_HIGH, RED_MID: RED_MID, RED_PIXEL: RED_PIXEL, MAX_EDGE: MAX_EDGE,
    statsFromPixels: statsFromPixels,
    observe: observe,
    analyzeFile: analyzeFile,
    synth: synth,
    analyzeSynth: analyzeSynth,
    register: register,
    analyzers: analyzers,
    analyzeWith: analyzeWith,
    available: hasDom,
    clamp: clamp,
  };
});
