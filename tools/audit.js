#!/usr/bin/env node
/* ==========================================================================
   前端优化审计（CDP 驱动真实 Chrome，零依赖）
   —— 目的：把「哪里慢、哪里废、哪里不合规」变成可复现的客观数字，
      而不是靠肉眼看代码猜。所有指标都由浏览器自己报出来。

   采什么：
     1) 性能      Performance.getMetrics（DOM 节点数 / layout / styleRecalc / 堆）
                  + 长任务（PerformanceObserver longtask）
                  + 视图切换的同步渲染耗时（实测 click 前后 performance.now 差）
     2) 渲染churn  MutationObserver 统计「一次追加消息到底重建了多少节点」
                   —— 全量 innerHTML 重建的特征是 removed ≈ 会话总消息数
     3) CSS       CSS.startRuleUsageTracking 跨全部视图的规则命中 → 未使用字节占比
                   （不是单页采样：会把六个视图都走一遍再停表）
     4) 可访问性   自写检查：文字对比度(WCAG AA) / 可访问名 / 表单标签 /
                   图片 alt / 标题层级 / tabindex / 重复 id / 对话框 aria
     5) 传输体积   performance resource / navigation 计时：每屏总字节、其中「到 load 为止」
                  与「load 之后延后下载」各多少、立绘占多少、延后那波挤不挤
                  —— 三条场景各带一份预算，超标就退出 1（见 NET_SCENARIOS）

   用法：
     node tools/audit.js                 全量审计，报告落在 %TEMP%\cs-audit
     node tools/audit.js --out=D:\shots   指定报告目录
     node tools/audit.js --only=css      只跑某一段（perf|css|a11y|churn|interact|net）
     node tools/audit.js --only=net      只看资源预算（快，六秒级）

   退出码：0 = 跑通且资源预算全部达标；1 = 审计异常或预算超标。
   可访问性 / 未命中 CSS 不改变退出码 —— 它们是待办清单，不是断掉的闸门。

   前置：本机 Chrome；页面由 `npm start` 提供（http://localhost:5173）。
   ========================================================================== */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.CDP_PORT || 9334);
const BASE = process.env.BASE_URL || 'http://localhost:5173';
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6) ||
  path.join(os.tmpdir(), 'cs-audit');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });

const VIEWS = [
  { key: 'workbench', url: '/?s=1&nolive=1' },
  { key: 'dashboard', url: '/?view=dashboard&nolive=1' },
  { key: 'kb', url: '/?view=kb&nolive=1' },
  { key: 'eval', url: '/?view=eval&nolive=1' },
  { key: 'care', url: '/?view=care&nolive=1' },
  { key: 'channels', url: '/?view=channels&nolive=1' },
];

/* 资源预算：三条场景各司其职，每个数字都是实测 + 一点点余量。
   2026-10-19 起服务端静态资源走 gzip（js/css/html/json/svg，见 server.js 的 serveStatic），
   这里量的 transferSize 就是压缩后的传输字节 —— 同一份代码，未压实测
   gate 980.9KB / 关掉桌宠 913.8KB，压完掉到 390.4KB / 362.7KB。
   预算跟着重新标定，**不是把数字放宽**：桌宠那条 2.8MB 精灵图不参与压缩（PNG 已经自压缩），
   所以 pet-on 的总量只从 5688.7KB 降到 5137.5KB。
   余量刻意压得薄（6% 上下）—— 留 30% 的话，谁再往里塞一张 300KB 的图也不会响，
   那就不是闸门是装饰。
   spriteKB / minSpriteReqs 是一对：前者管「不该下的别下」，
   后者管「该下的不许悄悄不下」—— 只留前一条的话，把预载整个删掉也能全绿。
   settleMs 是给延后预热的：立绘走 requestIdleCallback 一张张放，等短了会把
   「还没下完」误读成「省下来了」。 */
const NET_SCENARIOS = [
  { key: 'gate', url: '/?nolive=1', settleMs: 3500,
    maxTotalKB: 415, maxLoadKB: 380, spriteKB: 0, minSpriteReqs: 0 },
  { key: 'workbench-pet-on', url: '/?s=1&nolive=1&gate=off', settleMs: 9000,
    maxTotalKB: 5400, maxLoadKB: 930, spriteKB: null, minSpriteReqs: 12 },
  { key: 'workbench-pet-off', url: '/?s=1&nolive=1&gate=off&pet=off', settleMs: 9000,
    maxTotalKB: 385, maxLoadKB: 385, spriteKB: 0, minSpriteReqs: 0 },
];

const want = (sec) => !ONLY.length || ONLY.indexOf(sec) !== -1;

/* ------------------------------------------------------- 页内可访问性探针 */

const A11Y_PROBE = String.raw`(() => {
  const issues = [];
  const seen = new Set();
  const add = (sev, rule, detail) => {
    const k = rule + '|' + detail;
    if (seen.has(k)) return;
    seen.add(k);
    issues.push({ sev: sev, rule: rule, detail: detail });
  };

  /* ---------- 颜色工具（含 alpha 合成，向上找到不透明背景） ---------- */
  function parseColor(s) {
    if (!s) return null;
    const m = /rgba?\(([^)]+)\)/.exec(s);
    if (!m) return null;
    const p = m[1].split(',').map(function (x) { return parseFloat(x); });
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function over(fg, bg) {
    const a = fg.a + bg.a * (1 - fg.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
      g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
      b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
      a: a,
    };
  }
  function lum(c) {
    const f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function ratio(a, b) {
    const l1 = Math.max(lum(a), lum(b)), l2 = Math.min(lum(a), lum(b));
    return (l1 + 0.05) / (l2 + 0.05);
  }
  function bgOf(el) {
    const stack = [];
    let node = el;
    while (node && node.nodeType === 1) {
      const c = parseColor(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0.001) { stack.push(c); if (c.a >= 0.999) break; }
      node = node.parentElement;
    }
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = stack.length - 1; i >= 0; i--) bg = over(stack[i], bg);
    return bg;
  }
  const hex = (c) => '#' + [c.r, c.g, c.b].map(function (v) {
    return Math.round(v).toString(16).padStart(2, '0');
  }).join('');

  function visible(el) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
    if (!el.getClientRects().length) return false;
    return true;
  }

  /* ---------- 1. 对比度 ---------- */
  const contrast = [];
  const all = document.querySelectorAll('body *');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (!visible(el)) continue;
    let hasText = false;
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && n.textContent.trim().length > 1) { hasText = true; break; }
    }
    if (!hasText) continue;
    const cs = getComputedStyle(el);
    const fg = parseColor(cs.color);
    if (!fg) continue;
    const bg = bgOf(el);
    const fgc = over(fg, bg);
    const r = ratio(fgc, bg);
    const size = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    if (r < need) {
      contrast.push({
        cls: (el.className && String(el.className).split(/\s+/)[0]) || el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().slice(0, 34),
        fg: hex(fgc), bg: hex(bg), ratio: Math.round(r * 100) / 100, need: need, size: size,
      });
    }
  }
  /* 同一配色只报一次，按对比度升序 */
  const cseen = new Set();
  const contrastUniq = [];
  contrast.sort((a, b) => a.ratio - b.ratio).forEach(function (c) {
    const k = c.cls + c.fg + c.bg + c.need;
    if (cseen.has(k)) return;
    cseen.add(k);
    contrastUniq.push(c);
  });
  contrastUniq.slice(0, 25).forEach(function (c) {
    add('high', 'contrast', c.cls + ' 文字' + c.fg + '/底' + c.bg + ' = ' + c.ratio + '（需 ' + c.need + '）「' + c.text + '」');
  });

  /* ---------- 2. 交互元素的可访问名 ---------- */
  const NEED_NAME = 'button,a[href],select,textarea,[role=button],[role=link],[role=tab],[role=switch],[role=checkbox],[role=menuitem]';
  const named = document.querySelectorAll(NEED_NAME);
  let noName = 0;
  for (let i = 0; i < named.length; i++) {
    const el = named[i];
    if (!visible(el)) continue;
    const txt = (el.getAttribute('aria-label') || '').trim() ||
      (function () {
        const lb = el.getAttribute('aria-labelledby');
        if (lb) {
          const t = lb.split(/\s+/).map(function (id) {
            const n = document.getElementById(id);
            return n ? n.textContent : '';
          }).join(' ').trim();
          if (t) return t;
        }
        const own = (el.textContent || '').trim();
        if (own) return own;
        const im = el.querySelector('img[alt]');
        if (im && im.getAttribute('alt').trim()) return im.getAttribute('alt').trim();
        return (el.getAttribute('title') || '').trim();
      })();
    if (!txt) {
      noName++;
      add('high', 'accname', (el.className || el.tagName.toLowerCase()) + ' 无可访问名（读屏读不出来）');
    }
  }

  /* ---------- 3. 表单控件标签 ---------- */
  const fields = document.querySelectorAll('input,select,textarea');
  let unlabeled = 0;
  for (let i = 0; i < fields.length; i++) {
    const el = fields[i];
    if (!visible(el)) continue;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'hidden') continue;
    const byFor = el.id && document.querySelector('label[for="' + el.id.replace(/"/g, '\\"') + '"]');
    const wrap = el.closest('label');
    const aria = (el.getAttribute('aria-label') || '').trim() || (el.getAttribute('aria-labelledby') || '').trim();
    if (byFor || wrap || aria) continue;
    unlabeled++;
    add(el.placeholder ? 'medium' : 'high', 'label',
      (el.id || el.className || el.tagName.toLowerCase()) + ' 无标签' + (el.placeholder ? '（只有 placeholder，输入后即消失）' : ''));
  }

  /* ---------- 4. 图片 alt ---------- */
  let imgNoAlt = 0;
  const imgs = document.querySelectorAll('img');
  for (let i = 0; i < imgs.length; i++) {
    if (imgs[i].getAttribute('alt') === null) {
      imgNoAlt++;
      add('high', 'img-alt', 'img 缺 alt：' + (imgs[i].src || '').slice(0, 48));
    }
  }

  /* ---------- 5. 结构 ---------- */
  if (!document.documentElement.getAttribute('lang')) add('medium', 'lang', 'html 缺 lang 属性');
  const ids = {};
  const dups = [];
  document.querySelectorAll('[id]').forEach(function (el) {
    if (ids[el.id]) { if (dups.indexOf(el.id) === -1) dups.push(el.id); } else ids[el.id] = 1;
  });
  dups.slice(0, 10).forEach(function (id) { add('medium', 'dup-id', '重复 id: ' + id); });

  let tabidx = 0;
  document.querySelectorAll('[tabindex]').forEach(function (el) {
    if (parseInt(el.getAttribute('tabindex'), 10) > 0) { tabidx++; add('medium', 'tabindex', 'tabindex>0 破坏自然 Tab 顺序：' + (el.className || el.tagName)); }
  });

  let lastLevel = 0, headingJumps = 0;
  document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(function (h) {
    if (!visible(h)) return;
    const lv = Number(h.tagName[1]);
    if (lastLevel && lv > lastLevel + 1) { headingJumps++; add('low', 'heading', '标题层级跳级 h' + lastLevel + ' → h' + lv + '：' + (h.textContent || '').trim().slice(0, 28)); }
    lastLevel = lv;
  });

  /* ---------- 6. 对话框 ---------- */
  const dialogs = document.querySelectorAll('[role=dialog],[aria-modal]');
  let dialogNoName = 0;
  dialogs.forEach(function (d) {
    const lb = d.getAttribute('aria-labelledby');
    const al = (d.getAttribute('aria-label') || '').trim();
    let ok = !!al;
    if (lb) { const n = document.getElementById(lb); ok = !!(n && n.textContent.trim()); }
    if (!ok) { dialogNoName++; add('medium', 'dialog-name', '对话框无 aria-label/labelledby'); }
    if (d.getAttribute('aria-modal') !== 'true' && !d.hidden) add('low', 'dialog-modal', '对话框未标 aria-modal=true');
  });

  /* ---------- 7. 动态播报 ---------- */
  const live = document.querySelectorAll('[aria-live],[role=status],[role=alert]');
  add(live.length ? 'info' : 'high', 'live-region',
    live.length ? '存在 ' + live.length + ' 个动态播报区域' : '页面没有任何 aria-live/role=status —— 读屏用户收不到 toast 提示');

  const sevRank = { high: 0, medium: 1, low: 2, info: 3 };
  issues.sort(function (a, b) { return sevRank[a.sev] - sevRank[b.sev]; });

  return {
    dom: {
      nodes: document.getElementsByTagName('*').length,
      depth: (function () {
        let max = 0;
        document.querySelectorAll('body *').forEach(function (el) {
          let d = 0, n = el;
          while (n && n !== document.body) { d++; n = n.parentElement; }
          if (d > max) max = d;
        });
        return max;
      })(),
      inlineStyles: document.querySelectorAll('[style]').length,
    },
    a11y: {
      interactive: named.length, noName: noName,
      fields: fields.length, unlabeled: unlabeled,
      images: imgs.length, imgNoAlt: imgNoAlt,
      tabindexPositive: tabidx, headingJumps: headingJumps,
      dialogs: dialogs.length, dialogNoName: dialogNoName,
      liveRegions: live.length,
      contrastFailures: contrastUniq.length,
    },
    issues: issues.slice(0, 60),
    issueTotal: issues.length,
    /* 完整对比度失败清单（不截断）：供上层按「配色组合」聚合，
       直接指向该改哪个令牌，而不是逐个元素去修。 */
    contrast: contrastUniq,
  };
})()`;

/* ---------------------------------------------------------- 渲染 churn 探针 */

const CHURN_PROBE = String.raw`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const list = document.getElementById('chatList');
  if (!list) return { error: 'no #chatList' };
  let batches = [], cur = null;
  let lastAt = 0;
  const mo = new MutationObserver(function (recs) {
    const now = performance.now();
    if (!cur || now - lastAt > 80) { cur = { at: Math.round(now), added: 0, removed: 0, records: 0 }; batches.push(cur); }
    lastAt = now;
    cur.records += recs.length;
    recs.forEach(function (r) { cur.added += r.addedNodes.length; cur.removed += r.removedNodes.length; });
  });
  mo.observe(list, { childList: true, subtree: true });
  await sleep(11000);
  mo.disconnect();
  const msgs = list.querySelectorAll('.msg').length;
  let worstRemoved = 0, worstAdded = 0, totalRemoved = 0, totalAdded = 0;
  batches.forEach(function (b) {
    if (b.removed > worstRemoved) worstRemoved = b.removed;
    if (b.added > worstAdded) worstAdded = b.added;
    totalRemoved += b.removed; totalAdded += b.added;
  });
  return {
    batches: batches.length,
    msgsAtEnd: msgs,
    worstRemoved: worstRemoved,
    worstAdded: worstAdded,
    totalRemoved: totalRemoved,
    totalAdded: totalAdded,
    /* 判定：若 worstRemoved >= worstAdded 且接近 msgsAtEnd ⇒ 一次追加触发了全量重建 */
    fullRebuildBatches: batches.filter(function (b) { return b.removed >= 3 && b.removed >= b.added - 1; }).length,
  };
})()`;

/* ------------------------------------------------------- 交互成本探针：拖拽 */

const DRAG_PROBE = String.raw`(async () => {
  const h = document.getElementById('spriteHandle');
  if (!h) return { error: 'no #spriteHandle' };
  const r = h.getBoundingClientRect();
  const x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
  const send = (type, x, y) => h.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y,
    pointerId: 1, pointerType: 'mouse', isPrimary: true,
  }));
  await new Promise((res) => requestAnimationFrame(res));
  const t0 = performance.now();
  send('pointerdown', x0, y0);
  for (let i = 1; i <= 180; i++) send('pointermove', x0 - i * 0.5, y0 - i * 0.3);
  send('pointerup', x0 - 90, y0 - 54);
  await new Promise((res) => requestAnimationFrame(res));
  await new Promise((res) => requestAnimationFrame(res));
  const dt = performance.now() - t0;
  return {
    moves: 180,
    elapsedMs: Math.round(dt * 100) / 100,
    perMoveMs: Math.round(dt / 180 * 1000) / 1000,
  };
})()`;

/* ------------------------------------------------- 交互成本探针：反复切视图找泄漏 */

const LEAK_PROBE = String.raw`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nav = [...document.querySelectorAll('#railNav .rail-btn')];
  const nodes = () => document.getElementsByTagName('*').length;
  async function cycles(n, off) {
    for (let i = 0; i < n; i++) { nav[(i + (off || 0)) % nav.length].click(); await sleep(45); }
  }
  /* 每次计数前都必须回到同一个视图：不同视图的节点数本来就不同，
     否则「增长」里混的其实是「最后停在哪一屏」，不是泄漏。 */
  const wb = document.querySelector('#railNav .rail-btn[data-view="workbench"]');
  async function settle() {
    if (wb) wb.click();
    await sleep(400);
    return nodes();
  }
  /* 按容器拆开计数 —— 只看总数的话，增长到底是「哪一屏在长」完全看不出来。 */
  const BOXES = ['viewWorkbench', 'viewDashboard', 'viewKb', 'viewEval', 'viewCare', 'viewChannels'];
  const boxCounts = () => {
    const o = {};
    BOXES.forEach(function (id) {
      const el = document.getElementById(id);
      o[id] = el ? el.getElementsByTagName('*').length : 0;
    });
    return o;
  };
  /* 预热：六个视图各走两轮再取基线。视图内容是首次进入时才铺的（懒构建），
     不预热的话「增长」里混的是「还有几屏从没建过」，而不是泄漏 —— 这会把
     一次性的首次绘制成本误报成持续泄漏。 */
  await cycles(nav.length * 2);
  const n1 = await settle();
  const b1 = boxCounts();
  await cycles(30);
  const n2 = await settle();
  const b2 = boxCounts();
  const perBox = {};
  BOXES.forEach(function (id) {
    perBox[id] = { before: b1[id], after: b2[id], delta: b2[id] - b1[id] };
  });
  return { nodesAfter3: n1, nodesAfter33: n2, growth: n2 - n1, warmed: nav.length * 2, perBox: perBox };
})()`;

/* --------------------------------------------------- 传输体积探针（资源预算） */

const NET_PROBE = String.raw`(() => {
  const es = performance.getEntriesByType('resource');
  const nav = performance.getEntriesByType('navigation')[0] || null;
  const ext = (u) => { const m = /\.([a-z0-9]{1,5})(\?|#|$)/i.exec(u); return m ? m[1].toLowerCase() : 'other'; };
  /* transferSize 含响应头，本地服务器没压缩时它≈文件大小；
     某些条目（缓存命中、已中断的 SSE）会是 0，退回 encodedBodySize。 */
  const bytes = (e) => e.transferSize || e.encodedBodySize || 0;
  const loadOk = !!(nav && nav.loadEventEnd);
  const loadEnd = loadOk ? nav.loadEventEnd : 0;
  const by = {};
  const late = {};
  const top = [];
  const firstOf = {};      /* URL → 首次下载的字节，预算只按这个算 */
  const dup = {};          /* URL → 重复下载的字节 */
  let total = 0, unique = 0, toLoad = 0, afterLoad = 0, lastEnd = 0, sprite = 0, spriteN = 0;
  const spriteNames = [];
  es.forEach(function (e) {
    const b = bytes(e);
    const k = ext(e.name);
    if (!by[k]) by[k] = { n: 0, bytes: 0 };
    by[k].n++; by[k].bytes += b;
    top.push({ name: e.name.replace(/^.*\//, ''), bytes: b, endMs: Math.round(e.responseEnd) });
    total += b;
    if (firstOf[e.name] == null) { firstOf[e.name] = b; unique += b; }
    else dup[e.name.replace(/^.*\//, '')] = (dup[e.name.replace(/^.*\//, '')] || 0) + b;
    /* load 计时拿不到时（导航条目还没刷出）一律算首屏 —— 宁可把预算判严，
       也不能让「没测到延后」被读成「延后是 0」。 */
    if (!loadOk || e.responseEnd <= loadEnd) toLoad += b;
    else {
      afterLoad += b;
      /* 「延后下载」不能等于「同一 tick 全发」：按 load 之后每 250ms 一格数一下载入。
         原来七个立绘挤在 boot 后 1.2 秒那一下，这里就显示成一格里 7 张。 */
      const bucket = Math.floor((e.responseEnd - loadEnd) / 250) * 250;
      late[bucket] = (late[bucket] || 0) + 1;
    }
    if (e.responseEnd > lastEnd) lastEnd = e.responseEnd;
    if (/\/sprite-[^/]+\.png$/.test(e.name)) {
      sprite += b; spriteN++;
      const f = e.name.replace(/^.*\//, '').replace(/\.png$/, '');
      if (spriteNames.indexOf(f) === -1) { spriteNames.push(f); }
    }
  });
  top.sort(function (a, b) { return b.bytes - a.bytes; });
  const doc = nav ? bytes({ transferSize: nav.transferSize, encodedBodySize: nav.encodedBodySize }) : 0;
  const maxBucket = Object.keys(late)
    .map(function (k) { return { at: Number(k), n: late[k] }; })
    .sort(function (a, b) { return b.n - a.n; })[0] || null;
  const dupBytes = total - unique;
  return {
    reqs: es.length, total: total, unique: unique, doc: doc, toLoad: toLoad, afterLoad: afterLoad,
    dup: dup, dupBytes: dupBytes,
    by: by, top: top.slice(0, 8), loadOk: loadOk,
    spriteBytes: sprite, spriteReqs: spriteN, spriteNames: spriteNames,
    lastEndMs: Math.round(lastEnd), loadMs: nav ? Math.round(nav.loadEventEnd) : 0,
    dclMs: nav ? Math.round(nav.domContentLoadedEventEnd) : 0,
    /* 「这一屏被脚本挡住了多久」的近似值：DOM 都已经 interactive 了，DCL 却还没响 ——
       这段差值就是解析期阻塞脚本占掉的时间。
       留着它是因为 H-1（给 22 个脚本加 defer）就是靠这个数判死的：实测差值只有几毫秒，
       而 701KB 的脚本是**彼此独立**的普通脚本，浏览器本来就会并行下载，
       defer 省不下可测的首屏时间，却会把 22 个脚本的执行顺序变成要小心的东西。
       没有这个数，下一轮还会有人凭感觉再提一次「上 defer」。 */
    blockingMs: nav ? Math.max(0, Math.round(nav.domContentLoadedEventStart - nav.domInteractive)) : 0,
    jsN: (by.js && by.js.n) || 0, jsBytes: (by.js && by.js.bytes) || 0,
    fcpMs: (() => { const p = performance.getEntriesByName('first-contentful-paint')[0]; return p ? Math.round(p.startTime) : 0; })(),
    lateWave: maxBucket,
    /* 桌面宠物到底在不在场，直接决定这屏该付多少立绘字节 —— 探针把它读回来，
       预算才好写「关掉助手时 sprite-* 必须是 0」这种硬话。 */
    petVisible: (() => { const s = document.getElementById('sprite'); return !!s && !s.hidden && getComputedStyle(s).display !== 'none'; })(),
  };
})()`;

/* ------------------------------------------------------------------ CDP */

function getJson(url) { return fetch(url).then((r) => r.json()); }

/* 裸 http 探一次传输压缩。不能用 fetch：undici 会自动解压并抹掉 content-encoding，
   拿它自检压缩就等于问「你压了吗」之前先把答案吃掉。 */
function gzipProbe(url) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let u;
    try { u = new URL(url); } catch (e) { return done({ ok: false, detail: 'URL 不合法：' + url }); }
    const req = http.request({
      host: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'Accept-Encoding': 'gzip' },
    }, (res) => {
      const ce = String(res.headers['content-encoding'] || '');
      const len = res.headers['content-length'];
      res.resume();
      try { res.destroy(); } catch (e) { /* 头部已经到手 */ }
      done({
        ok: /gzip/i.test(ce),
        detail: res.statusCode + ' content-encoding=' + (ce || '（无）') +
          (len ? ' content-length=' + len : ' 无 content-length（分块）'),
      });
    });
    req.on('error', (e) => done({ ok: false, detail: '请求失败：' + e.message }));
    req.end();
  });
}

async function waitForDevtools(retries = 60) {
  for (let i = 0; i < retries; i++) {
    try { return await getJson('http://127.0.0.1:' + PORT + '/json/list'); }
    catch (e) { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error('DevTools 端口未就绪');
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
    } else if (m.method) {
      listeners.forEach((fn) => fn(m));
    }
  });
  return {
    send(method, params) {
      const mid = ++id;
      return new Promise((resolve, reject) => {
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
      });
    },
    on(fn) { listeners.push(fn); },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- 主流程 */

(async function main() {
  if (!CHROME) { console.error('未找到 Chrome / Edge'); process.exit(2); }
  fs.mkdirSync(OUT, { recursive: true });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-audit-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars', '--mute-audio',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--window-size=1600,1000', 'about:blank',
  ], { stdio: 'ignore' });

  const report = {
    base: BASE, at: new Date().toISOString(),
    views: {}, perf: {}, css: {}, churn: {}, a11y: {}, contrast: [], net: {}, budgetFail: [],
    drag: null, leak: null,
  };
  const contrastAgg = new Map();   // "fg|bg|need" → 聚合
  const log = (...a) => console.log(...a);

  try {
    const list = await waitForDevtools();
    const page = (list.find((t) => t.type === 'page') || list[0]);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const c = cdp(ws);

    await c.send('Runtime.enable');
    await c.send('Page.enable');
    await c.send('DOM.enable');
    await c.send('Performance.enable');

    /* 长任务观察器：必须在文档开始执行前注入 */
    await c.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__longtasks=[];try{new PerformanceObserver(function(l){l.getEntries().forEach(function(e){window.__longtasks.push(Math.round(e.duration));});}).observe({entryTypes:["longtask"]});}catch(e){}',
    });

    const evalJs = async (expr, awaitPromise) => {
      const r = await c.send('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: awaitPromise !== false,
      });
      if (r.exceptionDetails) {
        throw new Error('页内异常: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
      }
      return r.result.value;
    };

    /* ============================ 1. 分视图性能 + 可访问性 ============================ */
    if (want('a11y') || want('perf')) {
      for (const v of VIEWS) {
       for (const theme of ['dark', 'light']) {
        const key = v.key + '@' + theme;
        /* 浅色主题必须和深色一样被审计：默认主题只有深色，光看默认态
           会漏掉整个浅色配色 —— 这是最容易长期失守的地方。 */
        const sep = v.url.indexOf('?') === -1 ? '?' : '&';
        await c.send('Page.navigate', { url: BASE + v.url + sep + 'theme=' + theme + '&gate=off' });
        await sleep(2600);
        const before = (await c.send('Performance.getMetrics')).metrics;
        const probe = await evalJs(A11Y_PROBE);
        const after = (await c.send('Performance.getMetrics')).metrics;
        const d = (k) => (byKey(after, k) || 0) - (byKey(before, k) || 0);
        /* 同步渲染耗时：切换视图的 click handler 是同步渲染，前后差即渲染成本 */
        const switchCost = await evalJs(`(() => {
          const out = {};
          const btns = [...document.querySelectorAll('#railNav .rail-btn')];
          const cur = document.querySelector('#railNav .rail-btn[aria-current="true"]');
          btns.forEach(b => {
            const t0 = performance.now();
            b.click();
            out[b.getAttribute('data-view')] = Math.round((performance.now() - t0) * 100) / 100;
          });
          if (cur) cur.click();
          return out;
        })()`);

        report.views[key] = { theme: theme, dom: probe.dom, a11y: probe.a11y, switchCost: switchCost };
        report.a11y[key] = { issues: probe.issues, total: probe.issueTotal };
        (probe.contrast || []).forEach((c) => {
          const k = c.fg + '|' + c.bg + '|' + c.need;
          if (!contrastAgg.has(k)) contrastAgg.set(k, { fg: c.fg, bg: c.bg, need: c.need, worst: c.ratio, cls: new Set(), views: new Set() });
          const e = contrastAgg.get(k);
          e.worst = Math.min(e.worst, c.ratio);
          e.cls.add(c.cls);
          e.views.add(key);
        });
        report.perf[key] = {
          layoutDelta: d('LayoutCount'),
          recalcDelta: d('RecalcStyleCount'),
          nodesDelta: d('Nodes'),
          heapMB: Math.round((byKey(after, 'JSHeapUsedSize') || 0) / 1048576 * 10) / 10,
          longTasks: await evalJs('(window.__longtasks||[]).length'),
          longTaskMaxMs: await evalJs('Math.max(0,...(window.__longtasks||[]))'),
          longTaskTotalMs: await evalJs('(window.__longtasks||[]).reduce((a,b)=>a+b,0)'),
        };
        if (want('a11y')) {
          log('[a11y] ' + key.padEnd(18) + ' 交互' + String(probe.a11y.interactive).padStart(4) +
            ' 无名' + String(probe.a11y.noName).padStart(3) +
            ' 无标签' + String(probe.a11y.unlabeled).padStart(3) +
            ' 对比度失败' + String(probe.a11y.contrastFailures).padStart(3) +
            ' 合计' + String(probe.issueTotal).padStart(4));
        }
        if (want('perf')) {
          const p = report.perf[key];
          log('[perf] ' + key.padEnd(18) + ' DOM' + String(probe.dom.nodes).padStart(5) +
            ' 深' + String(probe.dom.depth).padStart(3) +
            ' layout+' + String(d('LayoutCount')).padStart(5) +
            ' style+' + String(d('RecalcStyleCount')).padStart(6) +
            ' 长任务' + String(p.longTasks).padStart(3) + '(' + p.longTaskTotalMs + 'ms)');
        }
       }
      }
    }

    /* 对比度失败聚合：一个配色组合往往横跨多个视图 —— 改令牌一次，胜过逐个元素改 */
    report.contrast = [...contrastAgg.values()]
      .map((e) => ({ fg: e.fg, bg: e.bg, need: e.need, worst: e.worst, cls: [...e.cls].slice(0, 6), views: [...e.views] }))
      .sort((a, b) => a.worst - b.worst);
    if (report.contrast.length) {
      log('');
      log('[contrast] 不达 AA 的配色组合 ' + report.contrast.length + ' 组（按最差对比度升序）');
      report.contrast.slice(0, 22).forEach((c) => {
        log('   ' + String(c.worst).padStart(5) + ' 需' + c.need + '  ' + c.fg + ' on ' + c.bg +
          '  命中 ' + String(c.views.length).padStart(2) + ' 屏  ' + c.cls.slice(0, 3).join(','));
      });
    }

    /* ============================ 2. 渲染 churn ============================ */
    if (want('churn')) {
      await c.send('Page.navigate', { url: BASE + '/?s=1&play=1&nolive=1&gate=off' });
      await sleep(1500);
      report.churn = await evalJs(CHURN_PROBE);
      log('[churn] 演示期间重渲染批次 ' + report.churn.batches +
        ' · 最坏一次替换 ' + report.churn.worstRemoved + ' / 新增 ' + report.churn.worstAdded +
        ' 个节点 · 会话共 ' + report.churn.msgsAtEnd + ' 条消息' +
        ' · 疑似全量重建批次数 ' + report.churn.fullRebuildBatches);
    }

    /* ============================ 4. 交互成本（拖拽 / 泄漏） ============================ */
    if (want('interact')) {
      await c.send('Page.navigate', { url: BASE + '/?s=1&nolive=1&gate=off' });
      await sleep(2500);

      const b1 = (await c.send('Performance.getMetrics')).metrics;
      report.drag = await evalJs(DRAG_PROBE);
      const a1 = (await c.send('Performance.getMetrics')).metrics;
      if (report.drag && !report.drag.error) {
        report.drag.layoutDelta = (byKey(a1, 'LayoutCount') || 0) - (byKey(b1, 'LayoutCount') || 0);
        report.drag.recalcDelta = (byKey(a1, 'RecalcStyleCount') || 0) - (byKey(b1, 'RecalcStyleCount') || 0);
        log('[drag] 180 次 pointermove：' + report.drag.elapsedMs + 'ms（每次 ' + report.drag.perMoveMs +
          'ms）· 布局计算 +' + report.drag.layoutDelta + ' · 样式重算 +' + report.drag.recalcDelta);
      }

      const h1 = byKey((await c.send('Performance.getMetrics')).metrics, 'JSHeapUsedSize') || 0;
      report.leak = await evalJs(LEAK_PROBE);
      const h2 = byKey((await c.send('Performance.getMetrics')).metrics, 'JSHeapUsedSize') || 0;
      report.leak.heapBeforeMB = Math.round(h1 / 1048576 * 10) / 10;
      report.leak.heapAfterMB = Math.round(h2 / 1048576 * 10) / 10;
      report.leak.heapGrowthMB = Math.round((h2 - h1) / 1048576 * 10) / 10;
      log('[leak] 预热 ' + report.leak.warmed + ' 次 → ' + report.leak.nodesAfter3 + ' 节点；再切 30 次 → ' +
        report.leak.nodesAfter33 + ' 节点（增长 ' + report.leak.growth + '）· 堆增长 ' + report.leak.heapGrowthMB + 'MB');
      /* 增长的来源要指出来：只看总数会误判成「整页在泄漏」，实际常常只是某一屏。 */
      const grow = Object.keys(report.leak.perBox || {})
        .map((k) => ({ k: k, d: report.leak.perBox[k].delta }))
        .filter((x) => x.d !== 0)
        .sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
      if (grow.length) {
        log('       增长分解：' + grow.map((x) => x.k + ' ' + (x.d > 0 ? '+' : '') + x.d).join(' · '));
        report.leak.growByBox = grow;
      }
    }

    /* ============================ 3. CSS 覆盖率（跨全部视图） ============================ */
    if (want('css')) {
      const sheetsText = new Map();     // styleSheetId -> text
      const headerLen = new Map();      // styleSheetId -> url
      c.on((m) => {
        if (m.method === 'CSS.styleSheetAdded') {
          const h = m.params.header;
          if (h.isInline && !h.sourceURL) headerLen.set(h.styleSheetId, '(inline)');
          else headerLen.set(h.styleSheetId, h.sourceURL || '(unknown)');
        }
      });
      await c.send('CSS.enable');
      await c.send('CSS.startRuleUsageTracking');
      /* reload 必须发生在取文本之前：reload 后样式表会拿到**新的 styleSheetId**，
         若先取文本再 reload，usage 里的新 id 对不上旧文本 → 覆盖率恒为 100% 未使用。 */
      headerLen.clear(); sheetsText.clear();
      await c.send('Page.navigate', { url: BASE + '/?nolive=1&gate=off' });
      await sleep(2500);
      await c.send('Page.reload', { ignoreCache: true });
      await sleep(2500);
      /* 逐张样式表取文本（id 来自 reload 后的 CSS.styleSheetAdded 事件） */
      for (const [sid] of headerLen) {
        try { const t = await c.send('CSS.getStyleSheetText', { styleSheetId: sid }); sheetsText.set(sid, t.text); }
        catch (e) { /* 拿不到就跳过 */ }
      }
      /* 把六个视图全走一遍，取并集 —— 只有全视图都没命中的规则才算真死代码 */
      await evalJs(`(async () => {
        const nav = [...document.querySelectorAll('#railNav .rail-btn')];
        /* 深浅两套主题都要走：只走深色会把 [data-theme=light] 整段规则误判成死代码 */
        for (const theme of ['dark', 'light']) {
          document.documentElement.setAttribute('data-theme', theme);
          for (const b of nav) { b.click(); await new Promise(r => setTimeout(r, 350)); }
          const wb = document.querySelector('#railNav .rail-btn[data-view="workbench"]');
          if (wb) wb.click();
          await new Promise(r => setTimeout(r, 400));
        }
        return true;
      })()`);
      const usage = await c.send('CSS.stopRuleUsageTracking');

      const perSheet = new Map();
      (usage.ruleUsage || []).forEach((u) => {
        if (!perSheet.has(u.styleSheetId)) perSheet.set(u.styleSheetId, []);
        if (u.used) perSheet.get(u.styleSheetId).push([u.startOffset, u.endOffset]);
      });

      let totalBytes = 0, usedBytes = 0;
      const detail = [];
      for (const [sid, text] of sheetsText) {
        if (!text) continue;
        const ranges = (perSheet.get(sid) || []).slice().sort((a, b) => a[0] - b[0]);
        const merged = [];
        ranges.forEach((rg) => {
          const last = merged[merged.length - 1];
          if (last && rg[0] <= last[1]) last[1] = Math.max(last[1], rg[1]);
          else merged.push([rg[0], rg[1]]);
        });
        let used = 0;
        merged.forEach((rg) => { used += rg[1] - rg[0]; });
        const size = Buffer.byteLength(text, 'utf8');
        totalBytes += size; usedBytes += used;
        detail.push({
          url: headerLen.get(sid) || '(unknown)',
          bytes: size, usedBytes: used,
          unusedPct: size ? Math.round((1 - used / size) * 1000) / 10 : 0,
        });
      }
      report.css = {
        totalBytes: totalBytes, usedBytes: usedBytes,
        unusedBytes: totalBytes - usedBytes,
        unusedPct: totalBytes ? Math.round((1 - usedBytes / totalBytes) * 1000) / 10 : 0,
        sheets: detail.sort((a, b) => b.bytes - a.bytes),
      };
      log('[css]  样式总 ' + kb(totalBytes) + ' · 未命中 ' + kb(totalBytes - usedBytes) +
        '（' + report.css.unusedPct + '%）');
    }
    /* ============================ 5. 传输体积 / 资源预算 ============================ */
    if (want('net')) {
      await c.send('Network.enable');
      /* 缓存必须关掉：headless 用临时 profile，但同一轮里三个场景会复用连接，
         第二个场景若命中第一个的缓存，「字节」就变成「请求数」，预算再怎么也不会响。 */
      await c.send('Network.setCacheDisabled', { cacheDisabled: true });
      report.net = {};
      report.budgetFail = [];
      /* 预算数字是**压缩之后**的传输字节（NET_SCENARIOS 上面记着压实测与未压实测两组的差）。
         同一份页面指到一台跑老代码、不压缩的服务端上会量出 2.7 倍字节、三条预算一起红，
         现象看上去像「代码退化了」，其实是量错了对象 —— 所以先证明这台真的在压。
         证明不了就不比字节（比了也是假红），只报这一条硬失败。 */
      const gz = await gzipProbe(BASE + '/assets/app.js');
      const gzOk = gz.ok;
      if (!gzOk) {
        report.budgetFail.push('net：' + BASE + ' 没对 /assets/app.js 返回 gzip（' + gz.detail +
          '）—— 字节预算按压缩后算，量到没压缩的服务端等于量错对象；' +
          '把 BASE_URL 指到用当前代码起的那台（默认 5173 常年是遗留进程）');
      }
      log('[net]  传输压缩自检：' + gz.detail + (gzOk ? ' ✓' : ' ✗ 字节预算本轮不参与比较'));
      for (const sc of NET_SCENARIOS) {
        await c.send('Page.navigate', { url: BASE + sc.url });
        await sleep(sc.settleMs);
        const m = await evalJs(NET_PROBE);
        if (!m) { report.budgetFail.push(sc.key + '：资源探针没返回对象（这一屏等于没测）'); continue; }
        const types = Object.keys(m.by)
          .map((k) => ({ k: k, n: m.by[k].n, bytes: m.by[k].bytes }))
          .sort((a, b) => b.bytes - a.bytes);
        m.types = types;
        report.net[sc.key] = m;
        const fails = [];
        /* 预算一律按「去重后的唯一 URL 字节」算。这一屏刻意让预热线程和 CSS 引同一批图，
           而本段为了测出真实体积把缓存关了 —— 于是桌宠自己转个圈就会把已经下过的那张
           再下一遍。按总字节定预算的话，预算会随「它今天想做哪个动作」上下飘 600KB，
           闸门就成了掷骰子。重复字节单独看，不进预算。 */
        if (gzOk && m.unique > sc.maxTotalKB * 1024) {
          fails.push('去重后 ' + kb(m.unique) + ' 超预算 ' + sc.maxTotalKB + 'KB' +
            '（含重复下载共 ' + kb(m.total) + '）');
        }
        if (gzOk && m.toLoad > sc.maxLoadKB * 1024) {
          fails.push('到 load 为止 ' + kb(m.toLoad) + ' 超首屏预算 ' + sc.maxLoadKB + 'KB');
        }
        if (sc.spriteKB != null && m.spriteBytes > sc.spriteKB * 1024) {
          fails.push('桌宠不在场却下了 ' + kb(m.spriteBytes) + ' 立绘（预算 ' + sc.spriteKB + 'KB）' +
            ' —— 预热没受显隐控制');
        }
        if (m.spriteReqs < sc.minSpriteReqs) {
          fails.push('只下了 ' + m.spriteReqs + ' 张立绘，该下至少 ' + sc.minSpriteReqs +
            ' 张（' + (m.spriteNames || []).join(',') + '） —— 预载断了不会报错，只会拖的时候卡一下');
        }
        if (sc.key === 'gate' && m.petVisible) fails.push('门禁期间桌宠仍然可见（display:none 没生效）');
        if (sc.key === 'workbench-pet-on' && !m.petVisible) fails.push('桌宠本该在场却没渲染（?pet=off 泄漏进默认路径？）');
        fails.forEach((f) => report.budgetFail.push(sc.key + '：' + f));
        log('[net]  ' + sc.key.padEnd(18) + ' 请求' + String(m.reqs).padStart(3) +
          ' 去重' + kb(m.unique).padStart(9) +
          (m.dupBytes ? '(重复' + kb(m.dupBytes) + ')' : '        ') +
          ' 首屏' + kb(m.toLoad).padStart(8) +
          ' 延后' + kb(m.afterLoad).padStart(8) +
          ' 立绘' + String(m.spriteNames.length).padStart(2) + '张/' + kb(m.spriteBytes).padStart(8) +
          ' 末张' + String(m.lastEndMs).padStart(5) + 'ms' +
          (m.lateWave ? ' 延后最密一格 load+' + m.lateWave.at + 'ms ' + m.lateWave.n + '张' : '') +
          (m.loadOk ? '' : ' （拿不到 load 计时，全部记作首屏）') +
          '\n        脚本 ' + m.jsN + ' 块/' + kb(m.jsBytes) + ' 阻塞 ' + m.blockingMs + 'ms' +
          ' · DCL ' + m.dclMs + 'ms · 最贵 ' + (m.top || []).slice(0, 3).map((t) =>
            t.name + ' ' + kb(t.bytes) + '@' + t.endMs + 'ms').join(' · ') +
          (fails.length ? '\n        ✗ ' + fails.join('\n        ✗ ') : ''));
      }
    }
  } catch (e) {
    report.fatal = String(e && e.message || e);
    console.error('审计异常：', report.fatal);
  } finally {
    try { chrome.kill(); } catch (e) { /* ignore */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  const jf = path.join(OUT, 'report.json');
  fs.writeFileSync(jf, JSON.stringify(report, null, 2), 'utf8');
  log('');
  if (report.fatal) log('致命：' + report.fatal);
  if (report.budgetFail.length) {
    log('资源预算超标 ' + report.budgetFail.length + ' 项：');
    report.budgetFail.forEach((s) => log('   ✗ ' + s));
  } else if (Object.keys(report.net || {}).length) {
    log('资源预算：三个场景都在预算内');
  }
  log('报告：' + jf);
  /* 退出码原来恒为 0 —— 审计崩了和审计通过长得一模一样，
     而「没跑成」比「跑成红」更容易被忽略。现在异常与超预算都会退出 1；
     可访问性 / 未命中 CSS 仍然只是描述性输出（那些是待办清单，不是断掉的闸门）。 */
  process.exit(report.fatal || report.budgetFail.length ? 1 : 0);
})();

function byKey(metrics, k) {
  const m = (metrics || []).find((x) => x.name === k);
  return m ? m.value : 0;
}
function kb(n) { return (Math.round(n / 1024 * 10) / 10) + 'KB'; }
