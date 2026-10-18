#!/usr/bin/env node
/* ==========================================================================
   真实浏览器验证（CDP 驱动）
   —— 为什么不用 `chrome --headless --virtual-time-budget`：
      本项目工作台常驻一条 SSE 长连接，虚拟时钟会一直等网络、永远推进不到预算，
      spawnSync 被超时杀掉、截图为空。改用真实时钟 + CDP 手动驱动即可。

   用法：
     node tests/browser-check.js                      跑内置检查项
     node tests/browser-check.js --url=... --probe=... 自定义
     node tests/browser-check.js --out=D:\shots        指定截图目录

   依赖：本机 Chrome；页面由 `npm start` 提供（http://localhost:5173）。
   ========================================================================== */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.CDP_PORT || 9333);
const BASE = process.env.BASE_URL || 'http://localhost:5173';
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6) ||
  path.join(os.tmpdir(), 'beauty-cs-shots');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });

/* 检查项：url + 探针（返回对象即视为通过，字段会打进汇总） */
const CHECKS = [
  {
    name: 'workbench-allergy',
    url: '/?s=1&play=1&nolive=1',
    wait: 16000,
    screenshot: true,
    probe: `(() => {
      const S = window.__app || null;
      const sb = document.getElementById('spriteBody');
      const q = (s) => document.querySelector(s);
      return {
        chatMsgs: document.querySelectorAll('#chatList .msg').length,
        riskChip: (q('#bandStrip .risk-badge') || {}).textContent || '',
        spriteReplies: sb ? sb.querySelectorAll('.ra').length : 0,
        orderBar: sb ? !!sb.querySelector('.sb-order') : false,
        alerts: document.querySelectorAll('#alertSlot .alert-bar').length,
      };
    })()`,
  },
  {
    name: 'vision-analysis',
    url: '/?nolive=1',
    wait: 2000,
    screenshot: false,
    probe: `(async () => {
      const V = window.Vision;
      const mild = await V.analyzeSynth('mild');
      const severe = await V.analyzeSynth('severe');
      return {
        mild: mild.observation.level + ' · ' + mild.observation.redness + '%',
        severe: severe.observation.level + ' · ' + severe.observation.redness + '%',
        severeSignals: severe.observation.signals.join('/'),
      };
    })()`,
  },
  {
    name: 'vision-send',
    url: '/?s=1&nolive=1',
    wait: 3000,
    screenshot: true,
    probe: `(async () => {
      document.getElementById('btnComposerMode').click();
      await new Promise(r => setTimeout(r, 200));
      document.getElementById('btnSynthSevere').click();
      await new Promise(r => setTimeout(r, 600));
      const lv = document.querySelector('#composerAttach .ca-lv');
      const previewLv = lv ? lv.textContent : null;
      document.getElementById('composerInput').value = '我用了两天脸上开始刺痛发红';
      document.getElementById('btnSend').click();
      await new Promise(r => setTimeout(r, 7000));
      const sb = document.getElementById('spriteBody');
      return {
        previewLevel: previewLv,
        hasImageBubble: !!document.querySelector('#chatList .msg-img img'),
        imageTag: (document.querySelector('#chatList .mi-tag') || {}).textContent || '',
        spriteVisionBar: sb ? !!sb.querySelector('.sb-vision') : false,
        bandVision: (document.querySelector('#bandStrip .bs-vision') || {}).textContent || '',
        riskChip: (document.querySelector('#bandStrip .risk-badge') || {}).textContent || '',
      };
    })()`,
  },
  {
    name: 'eval-view',
    url: '/?view=eval&nolive=1',
    wait: 3000,
    screenshot: true,
    probe: `(async () => {
      await new Promise(r => setTimeout(r, 600));
      const cards = [...document.querySelectorAll('#evalBody .ev-card')];
      const miss = document.querySelectorAll('#evalBody .ev-misses li').length;
      const out = {
        metrics: cards.map(c => c.querySelector('.ev-k').textContent + '=' + c.querySelector('.ev-v').textContent),
        matrixCells: document.querySelectorAll('#evalBody .ev-matrix td').length,
        misses: miss,
        rows: document.querySelectorAll('#evalBody .ev-table tbody tr').length,
        meta: (document.getElementById('evalMeta') || {}).textContent || '',
        /* 这页被说过「看不懂」：把「出题 → AI 答 → 对答案」三步和一条示范都钉住，
           免得以后又被改回一屏百分比 */
        question: ((document.querySelector('.ev-q') || {}).textContent || '').trim(),
        steps: document.querySelectorAll('#evalBody .ev-step').length,
        sample: !!document.querySelector('#evalBody .ev-sample'),
        sampleFlag: ((document.querySelector('.evs-flag') || {}).textContent || '').trim(),
      };
      const bad = [];
      const want = (c, l) => { if (!c) bad.push(l); };
      want(out.metrics.length === 4, '评测应有四项指标，实为 ' + out.metrics.length);
      want(out.matrixCells === 9, '风险 3×3 对照表应有 9 格，实为 ' + out.matrixCells);
      want(out.rows > 0, '逐条用例应有明细行');
      want(/判得准不准/.test(out.question), '首行应直接把这一页的问题讲出来，实为「' + out.question + '」');
      want(out.steps === 3, '「出题 / AI 答 / 对答案」三步应齐全，实为 ' + out.steps);
      want(out.sample === true, '应有一条示范用例（AI 判 vs 人工标）');
      want(/判对|判错/.test(out.sampleFlag), '示范用例应给出判对 / 判错结论，实为「' + out.sampleFlag + '」');
      if (bad.length) throw new Error('评测页断言失败：' + bad.join(' | '));
      return out;
    })()`,
  },
  {
    name: 'care-view',
    url: '/?view=care&nolive=1&today=2026-10-14',
    wait: 2500,
    screenshot: true,
    probe: `(() => {
      const q = (s) => document.querySelector(s);
      const txt = (s) => (q(s) || {}).textContent || '';
      const cards = [...document.querySelectorAll('#careBody .care-card')];
      const lay = document.querySelector('.care-layout');
      const items = document.querySelector('.care-items');
      const vc = document.getElementById('viewCare');
      return {
        metrics: [...document.querySelectorAll('#careMetrics .metric')].map(m => m.textContent.trim().replace(/\\s+/g, ' ')),
        cards: cards.length,
        /* 改版后索引卡自带等级计数（高危 3 / 关注 2），明细只渲染选中客户，
           所以不能再靠「数卡片里的条目」来统计每位客户的条数。 */
        cardPills: cards.map(c => (c.querySelector('.cc-name') || {}).textContent + ' ' +
          [...c.querySelectorAll('.cc-pill')].map(p => p.textContent.trim()).join('/')),
        filters: [...document.querySelectorAll('#careBody [data-care-f]')].map(b => b.textContent.trim().replace(/\\s+/g, ' ')),
        selected: ((document.querySelector('#careBody .care-card.on') || {}).textContent || '').replace(/\\s+/g, ' ').trim(),
        items: document.querySelectorAll('#careBody .care-item').length,
        highItems: document.querySelectorAll('#careBody .care-item.lv-high').length,
        evidence: document.querySelectorAll('#careBody .ci-evidence span').length,
        notes: document.querySelectorAll('#careNotes .cn-row').length,
        layoutCols: lay ? getComputedStyle(lay).gridTemplateColumns : null,
        /* 关键不变量：整页不滚动，长列表只落在明细区内部 */
        viewOver: vc ? vc.scrollHeight - vc.clientHeight : null,
        detailScroll: items ? { sh: items.scrollHeight, ch: items.clientHeight } : null,
        now: txt('#careNow'), cover: txt('#careCover'), ver: txt('#careVer'),
        badge: txt('#navCareBadge'),
      };
    })()`,
  },
  {
    name: 'recap-drawer',
    url: '/?s=1&play=1&nolive=1',
    wait: 16000,
    screenshot: true,
    probe: `(async () => {
      document.getElementById('btnRecap').click();
      await new Promise(r => setTimeout(r, 400));
      const q = (s) => document.querySelector(s);
      const headline = (q('#recapBody .rc-headline') || {}).textContent || '';
      const openItems = document.querySelectorAll('#recapBody .rc-open').length;
      const commits = document.querySelectorAll('#recapBody .rc-commit').length;
      const chips = document.querySelectorAll('#recapBody .rc-chips .chip').length;
      const next = document.querySelectorAll('#recapBody .rc-next li').length;
      const handover = (document.getElementById('recapText') || {}).textContent || '';
      document.getElementById('btnCloseRecap').click();
      await new Promise(r => setTimeout(r, 200));
      return {
        headline: headline.slice(0, 60),
        openItems, commits, chips, next,
        handoverLines: handover.split('\\n').length,
        handoverHasNext: handover.indexOf('下一步') !== -1,
        closedAfter: document.getElementById('recapRoot').hidden,
      };
    })()`,
  },
  {
    name: 'privacy-audit',
    url: '/?s=1&play=1&nolive=1',
    wait: 12000,
    screenshot: false,
    probe: `(() => {
      const P = window.Privacy, BUS = window.MessageBus;
      if (!P || !BUS) return { loaded: false };
      const hist = BUS.history();
      const bundle = P.exportBundle({ messages: hist, risks: [], stats: BUS.report().stats });
      const raw = JSON.stringify(bundle);
      return {
        loaded: true,
        msgs: hist.length,
        masked: bundle.masked,
        logLen: bundle.messageLog.length,
        noRawPhone: raw.indexOf('13812342210') === -1,
        maskWorks: P.maskText('联系电话 13812342210').indexOf('138****10') !== -1,
        nameOk: /^beauty-cs-audit-\\d{8}-\\d{6}\\.json$/.test(P.exportName()),
      };
    })()`,
  },
  {
    name: 'workbench-indicator',
    url: '/?s=1&nolive=1',
    wait: 3000,
    screenshot: false,
    probe: `(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const qa = (s) => [...document.querySelectorAll(s)];
      const out = { samples: 0, sawIndicator: false, avatarText: '', metaText: '', wrongOwner: 0,
        settled: false, totalMs: 0, residualTyping: 0, chatMsgs: 0 };

      /* 手动驱动一条顾客消息（不跑自动演示）——
         分析只有一轮，指示器该出现、也该干净收尾，可以确定性断言。 */
      document.getElementById('composerInput').value = '我用了两天脸上开始刺痛发红，想退货退款';
      document.getElementById('btnSend').click();

      /* 采样间隔 20ms：本地引擎一轮分析只有百来毫秒，间隔大了会漏采 */
      let lastSeen = -1;
      for (let i = 0; i < 900; i++) {
        const bars = qa('#chatList .bubble.typing');
        if (bars.length) {
          lastSeen = i;
          out.sawIndicator = true;
          out.samples++;
          bars.forEach((b) => {
            const box = b.closest('.msg');
            const av = box ? box.querySelector('.avatar') : null;
            const meta = box ? box.querySelector('.meta') : null;
            out.avatarText = av ? av.textContent.trim() : '';
            out.metaText = meta ? meta.textContent.trim() : '';
            /* 指示器属于 AI 侧：挂顾客头像会被误读成「顾客正在输入」。 */
            if (!box || !box.classList.contains('sys')) out.wrongOwner++;
            if (out.avatarText !== 'AI') out.wrongOwner++;
            if (out.metaText.indexOf('AI') === -1) out.wrongOwner++;
          });
        }
        /* 见过指示器后连续 800ms 干净 = 这一轮真的收尾了（没有卡死） */
        if (out.sawIndicator && lastSeen >= 0 && (i - lastSeen) * 20 >= 800) {
          out.settled = true;
          out.totalMs = i * 20;
          break;
        }
        await sleep(20);
      }

      out.residualTyping = qa('#chatList .bubble.typing').length;
      out.chatMsgs = qa('#chatList .msg').length;

      const bad = [];
      const want = (cond, label) => { if (!cond) bad.push(label); };
      want(out.sawIndicator === true, '分析期间必须出现「AI 正在读这条消息」指示器');
      want(out.wrongOwner === 0,
        '指示器必须挂在系统侧，头像与文案都标 AI，越界 ' + out.wrongOwner + ' 次（头像「' + out.avatarText + '」文案「' + out.metaText + '」）');
      want(out.settled === true, '分析必须在 18 秒内收尾，指示器不许卡死；残留 ' + out.residualTyping);
      want(out.residualTyping === 0, '收尾后不许残留指示器，实为 ' + out.residualTyping);
      want(out.chatMsgs > 0, '发送后应有消息落地');
      if (bad.length) throw new Error('工作台指示器断言失败 ' + bad.length + ' 项：' + bad.join(' | '));
      return out;
    })()`,
  },
  {
    /* 坐席「抢跑」：还没等分析收尾就手工回复。
       sendAgent 那一刻已把 awaitingReply 置 false 并预约了剧本推进；而分析是异步的，
       它随后收尾时若再把该标记置回 true，推进循环会认为「顾客还在等坐席回复」，
       直接返回且不再重试 —— 会话永久停在原地：顾客的话明明已经答了，
       却再也不来下一句（界面上就是「一直停在 2 条」）。
       这条只在真界面里、按「分析进行中」这一瞬间抢跑才暴露，单测碰不到：
       它依赖的是「异步回写 vs 用户点击」的先后，属于端到端的时序缺陷。 */
    name: 'workbench-early-reply',
    url: '/?s=1&nolive=1',
    /* 必须尽早开始轮询：本地引擎一轮分析只有几百毫秒，等太久会整轮错过窗口
       （整套跑时缓存已热、启动更快，400ms 就已经晚了）。 */
    wait: 30,
    screenshot: true,
    probe: `(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      /* 注意：这里一律现查现取，绝不缓存节点引用 —— 探针可能在「上一页」的文档里开始执行，
         缓存了旧 #chatList 就会一直盯着一个已经不再更新的节点。 */
      const typing = () => document.querySelectorAll('#chatList .bubble.typing').length;
      /* 只数真实消息：打字指示器本身也是一个 .msg，混进来会把「没推进」误判成「已推进」 */
      const realMsgs = () => document.querySelectorAll('#chatList .msg:not([data-typing])').length;
      const out = {};

      /* 等指示器真的出现再抢跑 —— 不然测的不是「分析进行中」。
         抓不到窗口就如实报错，而不是静默返回一个空结果装作通过：
         「没测到」和「测过且通过」是两件事。 */
      for (let i = 0; i < 1600; i++) {
        if (typing() > 0 && document.getElementById('composerInput')) { out.sawTyping = true; break; }
        await sleep(5);
      }
      if (!out.sawTyping) {
        throw new Error('没抓到「分析进行中」的窗口（首轮分析在探针启动前就收尾了）：' +
          '本轮未验证抢跑场景，请确认本地引擎耗时是否异常偏短');
      }

      const input = document.getElementById('composerInput');
      const mode = document.getElementById('btnComposerMode');
      if (mode.classList.contains('on')) mode.click();     // 切回坐席回复模式
      input.value = '我马上帮您核实';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('btnSend').click();
      out.typingAtSend = typing();
      out.afterSend = realMsgs();

      /* 顾客 + 坐席 + 下一条顾客 = 3 条真实消息，才算剧本真的续上了 */
      for (let i = 0; i < 600; i++) {
        await sleep(20);
        if (realMsgs() >= 3) { out.advanced = true; out.advancedMs = i * 20; break; }
      }
      out.msgs = realMsgs();
      out.residualTyping = typing();
      const nodes = [...document.querySelectorAll('#chatList .msg:not([data-typing])')];
      const last = nodes[nodes.length - 1];
      out.lastMeta = last && last.querySelector('.meta') ? last.querySelector('.meta').textContent.trim().slice(0, 30) : '';
      out.lastText = last ? last.textContent.trim().slice(0, 20) : '';

      const bad = [];
      const want = (cond, label) => { if (!cond) bad.push(label); };
      want(out.typingAtSend > 0, '抢跑必须发生在分析进行中（此刻指示器应在），实为 ' + out.typingAtSend);
      want(out.afterSend === 2, '抢跑后应是「顾客 + 坐席」两条消息，实为 ' + out.afterSend);
      want(out.advanced === true,
        '坐席已回复，分析收尾后剧本必须继续推进，不许把下一条顾客消息永久扣住（最终停在 ' + out.msgs + ' 条）');
      want(out.msgs >= 3, '推进后至少应有 3 条真实消息，实为 ' + out.msgs);
      want(out.lastMeta.indexOf('坐席') === -1,
        '推进后最后一条应是顾客消息，实为「' + out.lastMeta + '」');
      /* 注：这里不断言「无残留指示器」——推进后新到的顾客消息会立刻触发下一轮分析，
         指示器本来就该再次出现（它是「正在读这条消息」）。指示器是否排在末位另有专条守。 */
      if (bad.length) throw new Error('抢跑回复断言失败 ' + bad.length + ' 项：' + bad.join(' | '));
      return out;
    })()`,
  },
  {
    name: 'channel-wizard',
    url: '/?view=channels&nolive=1',
    wait: 2500,
    screenshot: true,
    probe: `(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const q = (s) => document.querySelector(s);
      const qa = (s) => [...document.querySelectorAll(s)];
      const click = (s) => { const el = q(s); if (el) el.click(); return !!el; };
      const clickText = (sel, txt) => {
        const el = qa(sel).find(x => x.textContent.indexOf(txt) !== -1);
        if (el) el.click();
        return !!el;
      };
      /* 读某张指标卡的值：指标口径和列表口径必须一致，所以这里直接断言数字 */
      const metricVal = (label) => {
        const m = qa('#chBody .metrics .metric').find((x) => {
          const k = x.querySelector('.k');
          return k && k.textContent.trim() === label;
        });
        const v = m ? m.querySelector('.v') : null;
        return v ? v.textContent.trim() : '';
      };
      const out = {};

      /* 默认必须是「一个都没接」—— 渠道不会自己接上 */
      out.coldMeta = (document.getElementById('chMeta') || {}).textContent || '';
      out.coldCards = qa('#chBody .ch-card').length;
      out.coldTokenBars = qa('#chBody .ch-tk').length;
      out.coldNotice = qa('#chBody .ch-notice').length;
      out.coldBrokenBanner = qa('#chBody .ch-broken').length;
      out.coldDemoBanner = qa('#chBody .ch-demo').length;
      out.coldDemoBtn = (document.getElementById('btnChDemo') || {}).textContent || '';
      out.coldMerged = metricVal('合并用户');

      /* 主动装载演示数据 */
      out.demoClicked = click('#btnChDemo');
      await sleep(400);
      out.demoMeta = (document.getElementById('chMeta') || {}).textContent || '';
      out.demoBanner = qa('#chBody .ch-demo').length;
      out.demoBtn = (document.getElementById('btnChDemo') || {}).textContent || '';
      out.demoMerged = metricVal('合并用户');
      out.demoMergeRows = qa('#chBody .cm-list .cm-user').length;

      out.cards = qa('#chBody .ch-card').length;
      out.brokenCards = qa('#chBody .ch-card.is-broken').length;
      out.tokenBars = qa('#chBody .ch-tk').length;
      out.brokenBanner = qa('#chBody .ch-broken').length;
      out.metrics = qa('#chBody .metrics .metric').length;

      out.opened = click('[data-connect="taobao"]');
      await sleep(350);
      out.wizVisible = !document.getElementById('chWiz').hidden;
      out.trackSteps = qa('#wzTrack li').length;
      out.preItems = qa('#wzBody .wz-pre li').length;
      out.nextLockedFirst = !!(q('#wzFoot [data-wz="next"]') || {}).disabled;

      for (let k = 0; k < 8; k++) {
        const li = q('#wzBody .wz-pre li:not(.on)');
        if (!li) break;
        li.click();
        await sleep(50);
      }
      await sleep(150);
      out.nextUnlocked = !(q('#wzFoot [data-wz="next"]') || {}).disabled;

      click('#wzFoot [data-wz="next"]');
      await sleep(200);
      out.fieldKeys = qa('#wzBody .wz-in').map(i => i.getAttribute('data-f'));
      out.secretMasked = qa('#wzBody .wz-in').filter(i => i.type === 'password').length;

      click('#wzFoot [data-wz="check"]');
      await sleep(250);
      out.blockedEmpty = qa('#wzBody .wz-f.is-bad').length;

      clickText('#wzBody .wz-tools button', '填入演示凭证');
      await sleep(200);
      out.demoAppKey = (q('#wzBody .wz-in[data-f="appKey"]') || {}).value || '';
      click('#wzFoot [data-wz="check"]');
      await sleep(300);
      out.badAfterDemo = qa('#wzBody .wz-f.is-bad').length;

      await sleep(700);
      out.probeChecks = qa('#wzBody .wz-checks li').map(li =>
        (li.className.indexOf('ok') !== -1 ? 'OK ' : 'FAIL ') + li.querySelector('b').textContent);

      click('#wzFoot [data-wz="next"]');
      await sleep(300);
      const urls = qa('#wzBody .wz-url');
      out.authUrlHead = urls.length ? urls[0].textContent.slice(0, 52) : '';
      out.hasStateInUrl = urls.length ? urls[0].textContent.indexOf('state=') !== -1 : false;

      click('#wzBody [data-wz="mock-auth"]');
      await sleep(300);
      const cb2 = qa('#wzBody .wz-url')[1];
      out.cbHasCode = !!(cb2 && cb2.textContent.indexOf('code=') !== -1);
      out.cbHasState = !!(cb2 && cb2.textContent.indexOf('state=') !== -1);

      click('#wzFoot [data-wz="exchange"]');
      await sleep(400);
      out.tokenLine = (q('#wzBody .wz-token .wz-cd') || {}).textContent || '';

      click('#wzFoot [data-wz="next"]');
      await sleep(250);
      click('#wzFoot [data-wz="pull"]');
      await sleep(2600);
      out.pullLines = qa('#wzBody .wz-checks li').length;
      out.pullAllOk = qa('#wzBody .wz-checks li.bad').length === 0;

      click('#wzFoot [data-wz="next"]');
      await sleep(300);
      out.doneRows = qa('#wzBody .wz-row').length;
      out.doneText = (q('#wzBody .wz-lead') || {}).textContent || '';

      click('#wzFoot [data-wz="finish"]');
      await sleep(350);
      out.wizClosed = document.getElementById('chWiz').hidden;
      out.taobaoLinked = !!q('#chBody .ch-card[data-ch="taobao"].is-on');
      out.badge = (document.getElementById('navChannelBadge') || {}).textContent || '';
      out.meta = (document.getElementById('chMeta') || {}).textContent || '';

      /* 断言：默认没接 / 演示可装载 / 向导拦人 / 走完才落库 */
      const bad = [];
      const want = (cond, label) => { if (!cond) bad.push(label); };
      want(out.coldMeta.indexOf('0 / 8') !== -1, '默认 catalog 应为 0/8：' + out.coldMeta);
      want(out.coldCards === 8, '默认应渲染 8 张卡片，实为 ' + out.coldCards);
      want(out.coldTokenBars === 0, '默认不应有 token 健康条，实为 ' + out.coldTokenBars);
      want(out.coldDemoBanner === 0, '默认不该出现演示横幅');
      want(out.coldNotice === 1, '冷启动应给出中性说明横幅，实为 ' + out.coldNotice);
      want(out.coldBrokenBanner === 0, '冷启动不是故障，不该是红色故障横幅，实为 ' + out.coldBrokenBanner);
      want(out.coldMerged.indexOf('0') === 0, '0 接入时「合并用户」应为 0，实为「' + out.coldMerged + '」');
      want(out.demoMerged.indexOf('4') === 0, '演示态「合并用户」应为 4，实为「' + out.demoMerged + '」');
      want(out.demoMergeRows === 4, '演示态合并列表应渲染 4 行（与指标一致），实为 ' + out.demoMergeRows);
      want(out.coldDemoBtn.indexOf('载入') !== -1, '默认按钮文案应为「载入演示数据」：' + out.coldDemoBtn);
      want(out.demoBanner === 1, '装载演示数据后应出现演示横幅');
      want(out.demoMeta.indexOf('4 / 8') !== -1, '演示态应为 4/8：' + out.demoMeta);
      want(out.demoBtn.indexOf('清除') !== -1, '演示态按钮应变为「清除演示数据」：' + out.demoBtn);
      want(out.brokenCards === 1, '演示数据里应有 1 张断线卡片，实为 ' + out.brokenCards);
      want(out.brokenBanner >= 1, '应有授权过期横幅');
      want(out.nextLockedFirst === true, '前置条件没勾完时「下一步」必须锁住');
      want(out.nextUnlocked === true, '勾完后「下一步」应解锁');
      want(out.blockedEmpty === 4, '空凭证应拦下 4 个字段，实为 ' + out.blockedEmpty);
      want(out.badAfterDemo === 0, '填入演示凭证后格式校验应全过');
      want(out.hasStateInUrl === true, '授权地址必须带 state（CSRF）');
      want(out.cbHasCode === true && out.cbHasState === true, '回调地址必须同时带 code 与 state');
      want(!!out.tokenLine, '换 token 后应给出 token 摘要');
      want(out.pullAllOk === true, '冷启动拉取应全部成功');
      want(out.wizClosed === true, '完成后向导应关闭');
      want(out.taobaoLinked === true, '走完全流程后淘宝卡片应变为已接入');
      want(out.badge.indexOf('5/8') !== -1, '角标应为 5/8：' + out.badge);
      if (bad.length) throw new Error('渠道向导断言失败 ' + bad.length + ' 项：' + bad.join(' | '));
      return out;
    })()`,
  },
  {
    name: 'channel-guard',
    url: '/?view=channels&nolive=1',
    wait: 2500,
    screenshot: true,
    probe: `(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const q = (s) => document.querySelector(s);
      const qa = (s) => [...document.querySelectorAll(s)];
      const setIn = (k, v) => {
        const el = q('#wzBody .wz-in[data-f="' + k + '"]');
        if (!el) return false;
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      };
      const out = {};
      q('[data-connect="pdd"]').click();
      await sleep(300);
      for (let k = 0; k < 8; k++) {
        const li = q('#wzBody .wz-pre li:not(.on)');
        if (!li) break;
        li.click();
        await sleep(50);
      }
      await sleep(120);
      q('#wzFoot [data-wz="next"]').click();
      await sleep(200);

      // 一处不合规的回调地址：http + 平台自家域名 + 回环，三种都试
      setIn('clientId', '4b6c1e2d3f4a5b6c7d8e9f0a1b2c3d4e');
      setIn('clientSecret', '672e4c9a1b2c3d4e5f6a7b8c9d0e1f2a');
      setIn('callback', '');
      q('#wzFoot [data-wz="check"]').click();
      await sleep(220);
      out.errEmptyCb = (q('#wzBody .wz-f.is-bad .wz-fh') || {}).textContent || '';
      setIn('callback', 'http://cb.pinduoduo.com/ch/pdd/notify');
      q('#wzFoot [data-wz="check"]').click();
      await sleep(220);
      out.errHttpBan = (q('#wzBody .wz-f.is-bad .wz-fh') || {}).textContent || '';
      setIn('callback', 'https://cb.pinduoduo.com/ch/pdd/notify');
      q('#wzFoot [data-wz="check"]').click();
      await sleep(220);
      out.errSelfDomain = (q('#wzBody .wz-f.is-bad .wz-fh') || {}).textContent || '';
      setIn('callback', 'https://127.0.0.1:5173/ch/pdd/notify');
      q('#wzFoot [data-wz="check"]').click();
      await sleep(220);
      out.errLoopback = (q('#wzBody .wz-f.is-bad .wz-fh') || {}).textContent || '';

      // 换成格式合法但不可达的地址（文档示例域名）→ 平台侧回调必然失败
      setIn('callback', 'https://example.com/ch/pdd/notify');
      q('#wzFoot [data-wz="check"]').click();
      await sleep(900);
      out.probeFailed = qa('#wzBody .wz-checks li.bad').length;
      out.probeDetail = (q('#wzBody .wz-checks li.bad .wz-cd') || {}).textContent || '';
      out.warnText = ((q('#wzBody .wz-warn') || {}).textContent || '').slice(0, 72);
      out.blocked = !!q('#wzBody .wz-warn');
      out.nextDisabledWhenFailed = !!(q('#wzFoot [data-wz="next"]') || {}).disabled;
      out.footButtons = qa('#wzFoot button').map(b => b.textContent.trim() + (b.disabled ? '(禁用)' : ''));

      const bad = [];
      const want = (cond, label) => { if (!cond) bad.push(label); };
      want(/必填|填写/.test(out.errEmptyCb), '空的回调地址应提示必填：' + out.errEmptyCb);
      want(out.errHttpBan.indexOf('HTTPS') !== -1, 'http 回调应被 HTTPS 规则拦下：' + out.errHttpBan);
      want(out.errSelfDomain.indexOf('平台') !== -1, '平台自家域名应被拒绝：' + out.errSelfDomain);
      want(out.errLoopback.indexOf('本机') !== -1 || out.errLoopback.indexOf('内网') !== -1,
        '回环地址应被拒绝：' + out.errLoopback);
      want(out.probeFailed >= 1, '不可达回调必须在连通性校验里失败，实为 ' + out.probeFailed);
      want(out.blocked === true, '探活失败必须给出阻断提示');
      want(out.nextDisabledWhenFailed === true, '探活失败时「下一步」必须禁用');
      if (bad.length) throw new Error('渠道凭证拦截断言失败 ' + bad.length + ' 项：' + bad.join(' | '));
      return out;
    })()`,
  },
  {
    name: 'dashboard-cases',
    url: '/?view=dashboard&nolive=1',
    wait: 2500,
    screenshot: true,
    probe: `(() => ({
      metrics: document.querySelectorAll('#dashMetrics .metric').length,
      riskRows: document.querySelectorAll('#riskTableWrap tbody tr.risk-row').length,
      caseDist: (document.getElementById('caseDist') || {}).textContent ? 1 : 0,
    }))()`,
  },
  {
    /* 责任人 ≠ 通知对象。
       recordRisk 把「推送给谁」写进了 owner 字段，而 medium 级直接填的是渠道名
       （c.channel）。闭环模块又把同一个字段当责任人用，于是：
         · 责任人一栏显示「抖音商城」——一个渠道被当成了人；
         · 责任人下拉把渠道名 unshift 进候选并预选中；
         · 「接管必须指定责任人」的守卫因 c.owner 恒非空而永不触发。
       单测能守住 casefile 的逻辑，但下拉默认值与列表渲染只存在于浏览器里，
       所以这条必须端到端走一遍真界面。 */
    name: 'dashboard-case-owner',
    url: '/?s=1&nolive=1',
    wait: 3000,
    screenshot: true,
    probe: `(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const out = {};
      const bad = [];
      const want = (cond, label) => { if (!cond) bad.push(label); };
      const CHANNELS = ['天猫旗舰店', '京东自营', '抖音商城', '品牌官网'];

      /* ① 先造一条「关注级」实时风险：它的 owner 会被 recordRisk 填成渠道名 */
      const list = document.getElementById('chatList');
      const input = document.getElementById('composerInput');
      const msgs = () => list.querySelectorAll('.msg').length;
      const cycle = async (atLeast) => {
        let seen = 0;
        for (let i = 0; i < 900; i++) {
          if (list.querySelector('.bubble.typing')) seen++;
          else if (seen > 0 && msgs() >= atLeast) return true;
          await sleep(15);
        }
        return false;
      };
      const send = (t) => {
        const b = document.getElementById('btnComposerMode');
        if (!b.classList.contains('on')) b.click();
        input.value = t;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('btnSend').click();
      };
      const n0 = msgs();
      send('我要发小红书曝光你们家');
      out.settled = await cycle(n0 + 1);

      /* ② 不刷页面切到看板 —— 实时风险存在内存里，导航一次就没了 */
      const dash = document.querySelector('#railNav .rail-btn[data-view="dashboard"]');
      dash.click();
      await sleep(700);

      const rows = () => [...document.querySelectorAll('#riskTableWrap tbody tr.risk-row')];
      out.rows = rows().length;
      want(out.rows >= 5, '看板应含 4 条历史沉淀 + 至少 1 条实时检出，实为 ' + out.rows);

      /* 责任人一栏绝不能出现渠道名 —— 这就是原 bug 的直接形态 */
      const ownerCells = rows().map((r) => (r.querySelector('.case-owner') || {}).textContent || '');
      const channelAsOwner = ownerCells.filter((v) => CHANNELS.indexOf(v.trim()) !== -1);
      out.ownerCells = ownerCells;
      out.channelAsOwner = channelAsOwner;
      want(channelAsOwner.length === 0,
        '责任人一栏不得出现渠道名（实为：' + channelAsOwner.join('、') + '）');

      /* ③ 找一条尚未指派的工单：责任人栏为「—」 */
      const row = rows().find((r) => ((r.querySelector('.case-owner') || {}).textContent || '').trim() === '—');
      out.hasUnassigned = !!row;
      want(out.hasUnassigned, '应存在一条尚未指派责任人的工单（责任人栏为「—」）');

      if (row) {
        const id = row.getAttribute('data-case');
        row.click();
        await sleep(350);

        const sel = document.querySelector('select[data-owner="' + id + '"]');
        out.hasSelect = !!sel;
        want(out.hasSelect, '展开后应有责任人下拉');
        if (sel) {
          const opts = [...sel.options].map((o) => o.value);
          out.selectValue = sel.value;
          out.optTexts = [...sel.options].map((o) => o.textContent);
          want(sel.value === '', '未指派时下拉应停在占位项（实为「' + sel.value + '」）');
          want(opts.filter((v) => CHANNELS.indexOf(v) !== -1).length === 0,
            '责任人候选里不得混入渠道名（实为：' + opts.join('、') + '）');

          /* ④ 不选人就点接管：必须被拒并说清原因，状态不许变 */
          const before = (document.querySelector('.cd-head .case-chip') || {}).textContent || '';
          document.querySelector('.cd-btn[data-act="ack"][data-case="' + id + '"]').click();
          await sleep(300);
          const toastTxt = [...document.querySelectorAll('#toastWrap .t-msg')]
            .map((x) => x.textContent).join(' | ');
          out.rejectToast = toastTxt;
          out.stateBefore = before;
          out.stateAfter = (document.querySelector('.cd-head .case-chip') || {}).textContent || '';
          want(toastTxt.indexOf('需要指定责任人') !== -1,
            '未选责任人点接管应提示「需要指定责任人」，实为「' + toastTxt + '」');
          want(out.stateAfter === before,
            '被拒后状态不应改变（' + before + ' → ' + out.stateAfter + '）');

          /* ⑤ 选了人再接管：状态推进，责任人栏落到人头上 */
          const pick = [...sel.options].find((o) => o.value && CHANNELS.indexOf(o.value) === -1);
          sel.value = pick.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(350);
          document.querySelector('.cd-btn[data-act="ack"][data-case="' + id + '"]').click();
          await sleep(400);
          out.stateFinal = (document.querySelector('.cd-head .case-chip') || {}).textContent || '';
          want(out.stateFinal === '处理中', '选好责任人后接管应进入「处理中」，实为「' + out.stateFinal + '」');

          const cell = document.querySelector('#riskTableWrap tbody tr[data-case="' + id + '"] .case-owner');
          out.ownerAfter = cell ? cell.textContent.trim() : '';
          want(out.ownerAfter === pick.value,
            '接管后责任人栏应显示所选的人（期望 ' + pick.value + '，实为 ' + out.ownerAfter + '）');
        }
      }

      if (bad.length) throw new Error('责任人断言失败 ' + bad.length + ' 项：' + bad.join(' | '));
      return out;
    })()`,
  },
  {
    /* 浮层可访问性：这三个浮层以前都不拦 Tab、关了不还焦点，向导更是完全不在 Esc 链里。
       这类退化肉眼看不出来（鼠标用户毫无感觉），只有按键断言能守住。 */
    name: 'shell-a11y-focus',
    url: '/?view=channels&nolive=1',
    wait: 2500,
    screenshot: true,
    probe: `(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
        'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
      const tab = (shift) => document.activeElement.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', shiftKey: !!shift, bubbles: true, cancelable: true }));
      const esc = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const out = {};

      /* ① 设置抽屉：焦点陷阱 + Esc 关闭 + 焦点归还 */
      const trig = document.getElementById('btnSettings');
      const droot = document.getElementById('drawerRoot');
      trig.focus();
      trig.click();
      await sleep(320);
      out.drawerOpen = !droot.hidden;
      out.drawerFocusInside = droot.contains(document.activeElement);

      const items = [...droot.querySelectorAll(FOCUSABLE)].filter(e => e.offsetWidth > 0 || e.offsetHeight > 0);
      out.drawerFocusables = items.length;
      if (items.length) {
        items[items.length - 1].focus();
        tab(false);
        await sleep(30);
        out.tabWrapsForward = document.activeElement === items[0];
        items[0].focus();
        tab(true);
        await sleep(30);
        out.tabWrapsBackward = document.activeElement === items[items.length - 1];
      }
      esc();
      await sleep(280);
      out.drawerClosedByEsc = droot.hidden;
      out.drawerFocusRestored = document.activeElement === trig;

      /* ② 接入向导：Esc 关闭 + 焦点归还 */
      const chTrig = document.querySelector('#chBody [data-connect="taobao"]');
      out.hasChannelTrigger = !!chTrig;
      if (chTrig) {
        chTrig.focus();
        chTrig.click();
        await sleep(450);
        out.wizOpen = !document.getElementById('chWiz').hidden;
        out.wizFocusInside = document.getElementById('chWiz').contains(document.activeElement);
        esc();
        await sleep(320);
        out.wizClosedByEsc = document.getElementById('chWiz').hidden;
        out.wizFocusRestored = document.activeElement === chTrig;
      }

      /* ③ 动态播报区与对话框语义：读屏用户唯一的信息来源 */
      const tw = document.getElementById('toastWrap');
      out.toastLive = tw ? tw.getAttribute('aria-live') : null;
      out.chatListLive = document.getElementById('chatList').getAttribute('aria-live');
      out.dialogs = [...document.querySelectorAll('[role="dialog"]')].map(d => d.getAttribute('aria-modal'));

      const bad = [];
      const want = (cond, label) => { if (!cond) bad.push(label); };
      want(out.drawerOpen === true, '设置抽屉应能打开');
      want(out.drawerFocusInside === true, '抽屉打开后焦点应落进抽屉');
      want(out.drawerFocusables > 0, '抽屉内应有可聚焦元素');
      want(out.tabWrapsForward === true, 'Tab 到末尾应环绕回第一个（否则焦点会溜到背后页面）');
      want(out.tabWrapsBackward === true, 'Shift+Tab 到开头应环绕到最后一个');
      want(out.drawerClosedByEsc === true, 'Esc 应关闭设置抽屉');
      want(out.drawerFocusRestored === true, '关闭抽屉后焦点应归还给触发按钮');
      want(out.hasChannelTrigger === true, '渠道页应有接入触发按钮');
      want(out.wizOpen === true, '接入向导应能打开');
      want(out.wizFocusInside === true, '向导打开后焦点应落进向导');
      want(out.wizClosedByEsc === true, 'Esc 应关闭接入向导');
      want(out.wizFocusRestored === true, '关闭向导后焦点应归还给触发按钮');
      want(out.toastLive === 'polite', 'toast 容器应有 aria-live=polite，实为 ' + out.toastLive);
      want(out.chatListLive === 'polite', '会话流应有 aria-live=polite');
      want(out.dialogs.length >= 3, '三个浮层都应有 role=dialog，实为 ' + out.dialogs.length);
      want(out.dialogs.every(v => v === 'true'), 'role=dialog 都应带 aria-modal=true');
      if (bad.length) throw new Error('浮层可访问性断言失败 ' + bad.length + ' 项：' + bad.join(' | '));
      return out;
    })()`,
  },
  {
    /* 渲染增量性：会话流曾经整块 innerHTML 重建 —— 每来一条消息就把全部气泡（含 dataURL 图）
       重新解析解码一遍。用「旧节点的引用必须还在」来守，因为整块重建必然会换掉引用。 */
    name: 'workbench-incremental-render',
    url: '/?s=1&nolive=1',
    wait: 3000,
    screenshot: false,
    probe: `(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const list = document.getElementById('chatList');
      const input = document.getElementById('composerInput');
      const msgs = () => list.querySelectorAll('.msg').length;
      /* 必须走「模拟顾客」模式：默认是坐席回复模式，那条路径只会追加一条客服消息，
         要靠剧本自己往下走来间接触发分析 —— 剧本一用尽就再也不会有分析，
         断言会静默变成空转。这里直接以顾客身份发，分析是确定性触发的。 */
      const send = (t) => {
        const b = document.getElementById('btnComposerMode');
        if (!b.classList.contains('on')) b.click();
        input.value = t;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('btnSend').click();
      };
      /* 等到本轮分析真的走完：先见到指示器「出现」，再见到它「消失」。
         只等消息数的写法会撞上「顾客消息已落地、但 busy 还没置位」的空档秒退，
         那样采样窗口等于零，指示器一次都采不到。 */
      const cycle = async (atLeast) => {
        let seen = 0;
        for (let i = 0; i < 900; i++) {
          if (list.querySelector('.bubble.typing')) seen++;
          else if (seen > 0 && msgs() >= atLeast) return true;
          await sleep(15);
        }
        return false;
      };
      const out = {};

      /* 采样器全程运行：既数「指示器出现过没有」，也数「有没有跟在最后一条之后」 */
      let typingSamples = 0, typingNotLast = 0;
      const sampler = setInterval(() => {
        const t = list.querySelector('.bubble.typing');
        if (!t) return;
        typingSamples++;
        if (t.closest('.msg') !== list.lastElementChild) typingNotLast++;
      }, 15);

      const base = msgs();
      send('第一条：用了两天脸上开始刺痛发红');
      out.firstSettled = await cycle(base + 1);
      out.msgs1 = msgs();
      const firstNode = list.querySelector('.msg');
      out.firstText = firstNode ? firstNode.textContent.slice(0, 12) : '';

      send('第二条：想退货退款');
      out.secondSettled = await cycle(out.msgs1 + 1);
      clearInterval(sampler);
      out.msgs2 = msgs();

      out.firstNodeKept = list.contains(firstNode);
      out.firstStillFirst = list.querySelector('.msg') === firstNode;
      out.typingSamples = typingSamples;
      out.typingNotLast = typingNotLast;

      const bad = [];
      const want = (cond, label) => { if (!cond) bad.push(label); };
      want(out.firstSettled === true, '第一条消息应在 18 秒内分析完');
      want(out.secondSettled === true, '第二条消息应在 18 秒内分析完');
      want(out.msgs2 > out.msgs1, '第二条消息后会话应增长：' + out.msgs1 + ' → ' + out.msgs2);
      want(out.firstNodeKept === true, '追加消息后原有气泡的 DOM 节点必须保留（不许整块 innerHTML 重建）');
      want(out.firstStillFirst === true, '原有消息应仍在列表首位（插入顺序不许乱）');
      want(out.typingSamples > 0, '分析期间应能采到打字指示器（否则下一条断言无意义）');
      want(out.typingNotLast === 0, '打字指示器必须始终排在最后一条消息之后，越界 ' + out.typingNotLast + ' 次');
      if (bad.length) throw new Error('渲染增量性断言失败 ' + bad.length + ' 项：' + bad.join(' | '));
      return out;
    })()`,
  },
  {
    /* 滚动跟随策略：坐席正在往上翻历史时被硬拽回底部，是很具体、很招人烦的体验损失。
       两条策略都要守：翻历史时不跟随、本就在底部时跟随。 */
    name: 'workbench-scroll-stick',
    url: '/?s=1&nolive=1',
    wait: 3000,
    screenshot: false,
    probe: `(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const list = document.getElementById('chatList');
      const input = document.getElementById('composerInput');
      const msgs = () => list.querySelectorAll('.msg').length;
      /* 以顾客身份发 —— 默认的坐席回复模式不触发分析（详见 workbench-incremental-render 的说明） */
      const send = (t) => {
        const b = document.getElementById('btnComposerMode');
        if (!b.classList.contains('on')) b.click();
        input.value = t;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('btnSend').click();
      };
      /* 一轮分析 = 指示器先出现、再消失。返回结构化结果，失败时能说清卡在哪一步：
         是发送压根没落地，还是指示器一直不出现，还是它出现了但永远不消失。 */
      const cycle = async (atLeast) => {
        const before = msgs();
        let seen = 0;
        for (let i = 0; i < 900; i++) {
          if (list.querySelector('.bubble.typing')) seen++;
          else if (seen > 0 && msgs() >= atLeast) return { ok: true, seen: seen, grew: msgs() - before };
          await sleep(15);
        }
        return { ok: false, seen: seen, grew: msgs() - before };
      };
      const why = (r, target) => {
        if (r.seen === 0) return '指示器从未出现（这条消息压根没进入分析）';
        if (r.grew === 0) return '消息数没变（发送没落地）';
        return '指示器出现过 ' + r.seen + ' 次但未按预期收尾（目标 ' + target + ' 条）';
      };
      const out = {};
      const bad = [];
      const want = (cond, label) => { if (!cond) bad.push(label); };

      /* 手动把会话铺到真的溢出为止 —— 内容没溢出时「滚不滚动」这件事根本不成立，
         断言会变成空转。（不用自动演示铺场：演示收尾后发送会被挡住。）

         余量必须远大于 96px 的「贴底」阈值：只溢出 40px 的话，把 scrollTop 拉到 0
         距底部也才 40px，策略判定「用户就在底部附近，跟随」反而是对的 ——
         那样测的不是「翻历史不被拽走」这条策略，而是阈值边界。 */
      const NEED_OVERFLOW = 240;
      let topUp = 0, topUpWhy = '';
      for (;;) {
        out.scrollable = list.scrollHeight > list.clientHeight + NEED_OVERFLOW;
        if (out.scrollable || topUp >= 14) break;
        topUp++;
        const n = msgs();
        send('补充第 ' + topUp + ' 条：还想问问运费和赠品，麻烦一起看看');
        const r = await cycle(n + 1);
        if (!r.ok) { topUpWhy = why(r, n + 1); break; }
      }
      out.toppedUp = topUp;
      out.topUpWhy = topUpWhy;
      out.msgs = msgs();
      out.scrollHeight = list.scrollHeight;
      out.clientHeight = list.clientHeight;
      /* break 之后必须重算 —— 否则「已经补到能滚了但恰好那一轮超时」会被误判成不可滚 */
      out.scrollable = list.scrollHeight > list.clientHeight + NEED_OVERFLOW;

      if (out.scrollable) {
        /* ① 停在历史位置：新消息不许把视口拽回底部 */
        list.scrollTop = 0;
        await sleep(60);
        const before = list.scrollTop;
        out.beforeScrollTop = Math.round(before);
        out.gapBeforeSend = Math.round(list.scrollHeight - list.scrollTop - list.clientHeight);
        let n = msgs();
        send('我在翻上面几条，先别把我拉下去');
        let r1 = await cycle(n + 1);
        out.historySettled = r1.ok;
        out.historyWhy = r1.ok ? '' : why(r1, n + 1);
        out.scrollTopAfterHistorySend = Math.round(list.scrollTop);
        out.stickRespected = list.scrollTop <= before + 40;

        /* ② 本来就在底部：新消息应当自动跟随 */
        list.scrollTop = list.scrollHeight;
        await sleep(80);
        n = msgs();
        send('这条应该自动跟到底部');
        let r2 = await cycle(n + 1);
        out.bottomSettled = r2.ok;
        out.bottomWhy = r2.ok ? '' : why(r2, n + 1);
        out.gapFromBottom = Math.round(list.scrollHeight - list.scrollTop - list.clientHeight);
        out.followedBottom = out.gapFromBottom < 40;
      }

      want(out.scrollable === true, '会话溢出高度应超过 ' + NEED_OVERFLOW + 'px（远大于 96px 贴底阈值），' +
        '否则滚动策略无从验证（scrollHeight ' + out.scrollHeight + ' / clientHeight ' + out.clientHeight +
        '，补发 ' + out.toppedUp + ' 条' + (out.topUpWhy ? '，卡在：' + out.topUpWhy : '') + '）');
      if (out.scrollable) {
        want(out.historySettled === true, '翻历史时那条消息应完成一轮分析：' + out.historyWhy);
        want(out.stickRespected === true, '坐席停在历史位置时不许把视口拽到底部：发送前 scrollTop ' +
          out.beforeScrollTop + '（距底 ' + out.gapBeforeSend + 'px，已在 96px 阈值之外），发送后实为 ' +
          out.scrollTopAfterHistorySend);
        want(out.bottomSettled === true, '停在底部时那条消息应完成一轮分析：' + out.bottomWhy);
        want(out.followedBottom === true, '坐席本就在底部时新消息应自动跟随，距底 ' + out.gapFromBottom + 'px');
      }
      if (bad.length) throw new Error('滚动跟随策略断言失败 ' + bad.length + ' 项：' + bad.join(' | '));
      return out;
    })()`,
  },
  {
    /* 手上那件：品类判定来自订单 / 顾客原话，落地是 data-prop + 三个 CSS 变量。
       这条链路有三处会「静默坏掉」，肉眼都不容易发现：
         · 变量指向不存在的图 → 浏览器不报错，只是什么都不画，看起来像桌宠空手
         · CSS 选择器没命中 → 变量设了却没人用（只有 computedStyle 能抓到）
         · 只在切会话时算一次 → 顾客接着说「这个眼影盘」时手上还举着口红
       所以既看 data-prop，也看计算后的 backgroundImage，还要真的发一条消息。 */
    name: 'sprite-prop',
    url: '/?s=1&nolive=1',
    wait: 3200,
    screenshot: true,
    probe: `(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const out = {};
      const bad = [];
      const want = (cond, label) => { if (!cond) bad.push(label); };
      const sprite = document.getElementById('sprite');
      const pet = sprite.querySelector('.sprite-pet');
      const prop = () => sprite.getAttribute('data-prop') || '';
      const bg = () => (getComputedStyle(pet).backgroundImage || '');

      /* ① 首屏会话（林小满）主订单是玻色因紧致精华 → 手上拿精华 */
      out.init = prop();
      out.initBg = bg();
      want(out.init === 'serum', '首屏应按主订单拿起精华，实为「' + out.init + '」');
      want(bg().indexOf('sprite-hold-serum.png') >= 0,
        '精华持物帧应真的被 CSS 用上（computed backgroundImage = ' + bg() + '）');

      /* ② 那张图必须真的能加载 —— 文件名写错时浏览器不会报错 */
      const loaded = await new Promise((res) => {
        const url = (bg().match(/url\\("?(.+?)"?\\)/) || [])[1];
        if (!url) return res({ ok: false, why: 'backgroundImage 里取不到 url' });
        const img = new Image();
        img.onload = () => res({ ok: img.naturalWidth > 0, w: img.naturalWidth });
        img.onerror = () => res({ ok: false, why: '404 ' + url });
        img.src = url;
      });
      out.img = loaded;
      want(loaded.ok, '持物序列帧应能真正加载：' + (loaded.why || ''));

      /* ③ 切到彩妆会话（沈知微）：订单里最近一单是口红 */
      const row = [...document.querySelectorAll('#contactsList .contact')]
        .find((n) => n.textContent.indexOf('沈知微') >= 0);
      out.hasColorContact = !!row;
      want(!!row, '左列应有彩妆会话（沈知微）');
      if (row) { row.click(); await sleep(1200); }
      out.afterSwitch = prop();
      want(out.afterSwitch === 'lipstick', '切到彩妆会话应换成口红，实为「' + out.afterSwitch + '」');

      /* ④ 顾客接着说眼影盘 → 手上就得换眼影盘。
         这是「按原话提炼品类」唯一能自证的一步：同一个人、同一通会话里换过一次 */
      const b = document.getElementById('btnComposerMode');
      if (!b.classList.contains('on')) b.click();
      const input = document.getElementById('composerInput');
      input.value = '那这个眼影盘飞粉吗？我眼皮容易出油';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('btnSend').click();

      let seen = '';
      for (let i = 0; i < 500; i++) {
        if (prop() === 'palette') { seen = 'palette'; break; }
        await sleep(15);
      }
      /* 换品类会先播 300ms 的「拿出来」，那期间 background-image 指向 pin-*。
         不等它播完就取 computedStyle，测到的是过渡态而不是终态 */
      await sleep(420);
      out.afterMessage = prop();
      out.afterMessageBg = bg();
      want(seen === 'palette', '顾客提到眼影盘后应换成眼影盘，实为「' + out.afterMessage + '」');
      want(bg().indexOf('sprite-hold-palette.png') >= 0,
        '换成眼影盘后 computed backgroundImage 应指向 palette（实为 ' + bg() + '）');

      /* ⑤ 拖起来必须真的在跑。持物时的走路是 sprite-prun-*（侧身抱物跑）。
         这个缺陷的形态很有欺骗性：CSS 全对、变量全对、拖动位置也真的在移动，
         唯独帧还是那张「站着抱东西」的 —— 看起来就是被拖着滑。
         顺带钉帧数：CSS 写 steps(12)，序列帧若只有 8 格，画面里会露出半个人。 */
      const handle = document.getElementById('spriteHandle');
      const r0 = handle.getBoundingClientRect();
      const hx = Math.round(r0.left + r0.width / 2), hy = Math.round(r0.top + r0.height / 2);
      const pe = (t, x, btn) => handle.dispatchEvent(new PointerEvent(t, {
        bubbles: true, cancelable: true, pointerId: 3, pointerType: 'mouse',
        isPrimary: true, clientX: x, clientY: hy, button: 0, buttons: btn,
      }));
      pe('pointerdown', hx, 1);
      for (let i = 1; i <= 10; i++) { pe('pointermove', hx - i * 26, 1); await sleep(16); }
      const wcs = getComputedStyle(pet);
      out.walkClass = sprite.className;
      out.walkBg = wcs.backgroundImage;
      out.walkAnim = wcs.animationName;
      want(/walk-[lr]/.test(sprite.className), '拖动时应挂上 walk-l/walk-r（实为「' + sprite.className + '」）');
      want(wcs.backgroundImage.indexOf('sprite-prun-palette.png') >= 0,
        '持物拖动应播 sprite-prun-*，而不是站着那张持物帧（实为 ' + wcs.backgroundImage + '）');
      want(wcs.animationName.indexOf('pet-prun') >= 0, '持物拖动应播 pet-prun（实为 ' + wcs.animationName + '）');
      /* 往左拖必须真的朝左。镜像不能用 transform 写：拖动时指针压在把手上，hover 恒成立，
         dragging:hover 那条 transform:none 的特异性更高，会把镜像整条清掉 ——
         表现是「往左拖也朝右跑」。所以镜像用独立的 scale 属性，这里直接钉住它。 */
      out.walkScale = wcs.scale || '';
      want(String(wcs.scale).indexOf('-1') === 0,
        '往左拖必须镜像（scale 应为 -1 1，实为「' + wcs.scale + '」）');

      const sheet = await new Promise((res) => {
        const url = (wcs.backgroundImage.match(/url\\("?(.+?)"?\\)/) || [])[1];
        if (!url) return res({ w: 0, h: 0 });
        const img = new Image();
        img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => res({ w: 0, h: 0 });
        img.src = url;
      });
      out.sheet = sheet;
      want(sheet.h > 0 && Math.round(sheet.w / sheet.h) === 24,
        '抱物跑序列帧应为 24 帧（实为 ' + sheet.w + '×' + sheet.h + '）');
      pe('pointerup', hx - 260, 0);

      /* ⑥ 拿着东西时的自主动作：点头 / 挥手 / 转圈 各有一张持物版。
         少了这几张，道具就会在「自主动作」的那两秒里凭空消失 —— 而这恰好发生在
         没人操作、最容易被看见的时候。缺陷形态是 CSS 里的变量没被写上（var() 空值
         = background-image: none，画面直接空一片），所以这里必须钉 computed 值，
         而不是钉 class 或变量名。顺带把帧数与 CSS 的 steps() 对上。 */
      const acts = [
        ['act-nod', 'sprite-pnod-palette.png', 20],
        ['act-wave', 'sprite-pwave-palette.png', 28],
        ['act-spin', 'sprite-pspin-palette.png', 28],
      ];
      out.acts = [];
      for (let i = 0; i < acts.length; i++) {
        const cls = acts[i][0], file = acts[i][1], n = acts[i][2];
        sprite.classList.remove('act-nod', 'act-wave', 'act-spin', 'act-bob');
        void sprite.offsetWidth;
        sprite.classList.add(cls);
        const st = getComputedStyle(pet);
        const bgNow = st.backgroundImage || '';
        const urlNow = (bgNow.match(/url\\("?(.+?)"?\\)/) || [])[1] || '';
        const sh = await new Promise((res) => {
          if (!urlNow) return res({ w: 0, h: 0 });
          const img = new Image();
          img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
          img.onerror = () => res({ w: 0, h: 0 });
          img.src = urlNow;
        });
        out.acts.push({ cls: cls, file: urlNow.split('/').pop(), anim: st.animationName,
                        frames: sh.h ? Math.round(sh.w / sh.h) : 0 });
        want(urlNow.split('/').pop() === file,
          '持物 ' + cls + ' 应播 ' + file + '（实为「' + (urlNow.split('/').pop() || '空') + '」）');
        want(sh.h > 0 && Math.round(sh.w / sh.h) === n,
          '持物 ' + cls + ' 序列帧应为 ' + n + ' 格（实为 ' + sh.w + '×' + sh.h + '）');
        sprite.classList.remove(cls);
      }

      if (bad.length) throw new Error('持物断言失败 ' + bad.length + ' 项：' + bad.join(' | '));
      return out;
    })()`,
  },
  {
    /* 帧率是「看起来卡不卡」的唯一硬指标：fps = 帧数 / 循环时长。
       steps(N) 写大了会在格子尽头露出半个人，写小了动作整体变慢 ——
       所以两个都要钉：图上的格子数，以及实测的帧切换频率。
       上一版 idle 是 10 格 / 6.8s ≈ 1.5fps、跑步 12 格 / 0.87s ≈ 13.8fps，肉眼就是抽帧。 */
    name: 'sprite-frames',
    url: '/?s=1&nolive=1',
    wait: 3000,
    probe: () => `(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const out = {}, bad = [];
      const want = (cond, label) => { if (!cond) bad.push(label); };
      const pet = document.querySelector('.sprite-pet');
      const sprite = document.getElementById('sprite');
      const info = () => {
        const cs = getComputedStyle(pet);
        const url = (cs.backgroundImage.match(/url\\("?(.+?)"?\\)/) || [])[1] || '';
        return { url, file: url.split('/').pop(), size: cs.backgroundSize,
                 anim: cs.animationName, dur: parseFloat(cs.animationDuration) };
      };
      const frames = (url) => new Promise((res) => {
        const img = new Image();
        img.onload = () => res(Math.round(img.naturalWidth / Math.max(1, img.naturalHeight)));
        img.onerror = () => res(0);
        img.src = url;
      });
      /* 每换一格 computed backgroundPosition 就变一次 —— 这就是实际帧率 */
      const fps = (ms) => new Promise((res) => {
        const t0 = performance.now();
        let last = '', n = 0;
        const loop = () => {
          const v = getComputedStyle(pet).backgroundPosition;
          if (v !== last) { n++; last = v; }
          if (performance.now() - t0 < ms) requestAnimationFrame(loop);
          else res(+(n / ((performance.now() - t0) / 1000)).toFixed(1));
        };
        requestAnimationFrame(loop);
      });

      /* 先等它从「分析中」的歪头帧回到待机 —— 那套是 16 格，会污染下面的断言 */
      for (let i = 0; i < 120 && /pet-(think|pin)/.test(info().anim); i++) await sleep(150);

      /* 这个检查量的是「空手那套底片」。但首屏这通会话在聊精华，桌宠一进页面就
         拿着一件道具 —— 那时 idle 播的是 pet-hold（20 格），不摘掉的话下面
         每一条「pet-idle / 28 格」都会莫名其妙地差 8 格，看起来像图渲坏了。
         持物那条路径由 sprite-prop 单独钉，这里先显式还原成空手。 */
      out.bootProp = sprite.getAttribute('data-prop') || '';
      if (out.bootProp) {
        sprite.removeAttribute('data-prop');
        sprite.classList.remove('act-nod', 'act-wave', 'act-spin', 'act-bob');
        void sprite.offsetWidth;
      }
      await sleep(120);

      /* ① 待机：28 格 / 5.2s ≈ 5.4fps */
      const idle = info();
      out.idle = idle;
      out.idleFrames = await frames(idle.url);
      out.idleFps = await fps(2400);
      want(/pet-idle/.test(idle.anim), '待机应播 pet-idle（实为 ' + idle.anim + '）');
      want(out.idleFrames === 28, '待机序列帧应为 28 格（实为 ' + out.idleFrames + '）');
      want(out.idleFps >= 4, '待机帧切换频率至少 4fps，否则读作「一顿一顿地喘」（实测 ' + out.idleFps + '）');

      /* ② 转圈：没人动它时会自己转 —— 先卸掉 data-prop，否则持物那条规则特异性相同、
         写在后面，会把 act-spin 的 background-image 盖回去 */
      out.spinFrames = await frames(location.origin + '/assets/img/sprite-spin.png');
      want(out.spinFrames === 28, '转圈序列帧应为 28 格（实为 ' + out.spinFrames + '）');
      sprite.removeAttribute('data-prop');
      sprite.classList.remove('act-jump', 'act-nod', 'act-wave', 'act-spin', 'act-bob');
      void sprite.offsetWidth;
      sprite.classList.add('act-spin');
      const sp = info();
      out.spinAnim = sp.anim;
      out.spinFile = sp.file;
      want(sp.anim.indexOf('pet-spin') >= 0, '挂 act-spin 后应播 pet-spin（实为 ' + sp.anim + '）');
      want(sp.file === 'sprite-spin.png', 'act-spin 应取 sprite-spin.png（实为 ' + sp.file + '）');
      sprite.classList.remove('act-spin');

      /* ③ 拖动：24 格，切换频率必须上 20fps */
      const handle = document.getElementById('spriteHandle');
      const r0 = handle.getBoundingClientRect();
      const hx = Math.round(r0.left + r0.width / 2), hy = Math.round(r0.top + r0.height / 2);
      const pe = (t, x, btn) => handle.dispatchEvent(new PointerEvent(t, {
        bubbles: true, cancelable: true, pointerId: 9, pointerType: 'mouse',
        isPrimary: true, clientX: x, clientY: hy, button: 0, buttons: btn,
      }));
      pe('pointerdown', hx, 1);
      let x = hx, dir = -1;
      const pump = setInterval(() => {
        x += dir * 18;
        if (x < 260 || x > window.innerWidth - 140) dir *= -1;
        pe('pointermove', x, 1);
      }, 16);
      await sleep(260);
      const run = info();
      out.run = run;
      out.runFrames = await frames(run.url);
      out.runFps = await fps(1200);
      clearInterval(pump);
      want(/pet-run|pet-prun/.test(run.anim), '拖动应播奔跑帧（实为 ' + run.anim + '）');
      want(out.runFrames === 24, '奔跑序列帧应为 24 格（实为 ' + out.runFrames + '）');
      want(out.runFps >= 20, '奔跑帧切换频率至少 20fps（实测 ' + out.runFps + '）');
      pe('pointerup', x, 0);

      if (bad.length) throw new Error('帧率断言失败 ' + bad.length + ' 项：' + bad.join(' | '));
      return out;
    })()`,
  },
  {
    /* 风险看板：分布卡去掉进度横条、分级标准提到同一行之后，整页不许再滚。
       横条把一张卡撑到近两倍高，挤得下面要滚动 —— 这是纯布局问题，
       只有真浏览器的 scrollHeight / clientHeight 量得出来。 */
    name: 'dashboard-layout',
    url: '/?view=dashboard&nolive=1',
    wait: 2500,
    screenshot: true,
    probe: `(() => {
      const q = (s) => document.querySelector(s);
      const out = {};
      out.distTracks = document.querySelectorAll('.dist-track').length;
      out.srows = document.querySelectorAll('.srow').length;
      out.stdRows = document.querySelectorAll('.std-row').length;
      const row = q('.dash-row');
      out.cols = row
        ? getComputedStyle(row).gridTemplateColumns.split(' ').map(v => Math.round(parseFloat(v) || 0))
        : null;
      out.docOver = document.documentElement.scrollHeight - document.documentElement.clientHeight;
      const bad = [];
      const want = (c, l) => { if (!c) bad.push(l); };
      want(out.distTracks === 0, '分布卡不该再有进度横条，实为 ' + out.distTracks);
      want(out.srows > 0, '分布应渲染成「名称 + 次数」行');
      want(out.stdRows === 3, '分级标准应压成三档并与分布同行，实为 ' + out.stdRows);
      want(!!out.cols && out.cols.length === 4, '看板第一行应为四列，实为 ' + ((out.cols || []).length));
      want(out.docOver <= 0, '看板整页不应滚动，溢出 ' + out.docOver + 'px');
      if (bad.length) throw new Error('看板布局断言失败：' + bad.join(' | '));
      return out;
    })()`,
  },
  {
    /* 账号抽屉：身份卡点开回答「我是谁、什么状态、换谁值班」。
       登录不在这里 —— 登录是独立一页，所以抽屉里只该有一条退出入口，
       没登录时给「去登录」，不该再摆一套工号口令输入框。 */
    name: 'account-drawer',
    url: '/?view=workbench&nolive=1',
    wait: 2400,
    screenshot: true,
    probe: `(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const q = (s) => document.querySelector(s);
      const out = {};
      await sleep(1300);
      q('#meCard').focus();
      q('#meCard').click();
      await sleep(420);
      out.opened = !document.getElementById('accountRoot').hidden;
      out.rows = document.querySelectorAll('#acctList .acct-row').length;
      out.noLoginForm = !document.getElementById('acctId') && !document.getElementById('btnLogin');
      out.presenceDisabled = [...document.querySelectorAll('#acctPresence button')].every(b => b.disabled);
      out.goLogin = !q('#btnGoLogin').hidden;
      out.logoutHidden = q('#btnLogout').hidden;
      q('#btnCloseAccount').click();
      await sleep(260);
      out.focusBack = document.activeElement ? document.activeElement.id : '';
      const bad = [];
      const want = (c, l) => { if (!c) bad.push(l); };
      want(out.opened === true, '点身份卡应打开账号面板');
      want(out.rows === 3, '坐席名单应有 3 人，实为 ' + out.rows);
      want(out.noLoginForm === true, '账号面板里不该再有登录表单（登录是独立一页）');
      want(out.presenceDisabled === true, '未登录时在线状态应不可改');
      want(out.goLogin === true, '未登录时账号面板应给「去登录」入口');
      want(out.logoutHidden === true, '未登录时不该出现「退出登录」');
      want(out.focusBack === 'meCard', '关闭后焦点应还给身份卡，实为 ' + out.focusBack);
      if (bad.length) throw new Error('账号面板断言失败：' + bad.join(' | '));
      return out;
    })()`,
  },
  {
    /* 话术库：Agent 的建议与手工填写都能进库。
       钉四件事 —— 弹窗打得开、空正文不许落库、自建条目带标记、删除真的生效。 */
    name: 'kb-manual',
    url: '/?view=kb&nolive=1',
    wait: 2600,
    screenshot: true,
    probe: `(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const q = (s) => document.querySelector(s);
      const rows = () => document.querySelectorAll('.kb-row').length;
      const txt = (s) => ((q(s) || {}).textContent || '').replace(/\\s+/g, ' ').trim();
      const out = {};
      await sleep(1500);
      out.rows0 = rows();
      q('#btnKbNew').click();
      await sleep(320);
      out.editorOpen = !document.getElementById('kbEditor').hidden;
      out.focusIn = document.activeElement ? document.activeElement.id : '';
      q('#kbeText').value = '';
      q('[data-kbe="save"]').click();
      await sleep(260);
      out.err = txt('#kbeErr');
      out.rowsAfterEmpty = rows();
      out.stillOpen = !document.getElementById('kbEditor').hidden;
      q('#kbeText').value = '探针话术 CDP 手工入库验证';
      q('#kbeText').dispatchEvent(new Event('input', { bubbles: true }));
      q('[data-kbe="save"]').click();
      await sleep(900);
      out.closed = document.getElementById('kbEditor').hidden;
      out.rowsAfterAdd = rows();
      out.custom = document.querySelectorAll('.kb-row.is-custom').length;
      const hit = [...document.querySelectorAll('.kb-row')].filter(r => r.textContent.indexOf('探针话术 CDP') !== -1)[0];
      out.hasProbe = !!hit;
      const del = hit ? hit.querySelector('[data-kb-del]') : null;
      out.hasDelBtn = !!del;
      if (del) { del.click(); await sleep(900); }
      out.rowsAfterDel = rows();
      out.probeGone = ![...document.querySelectorAll('.kb-row')].some(r => r.textContent.indexOf('探针话术 CDP') !== -1);
      out.focusAfterClose = document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : '';
      const bad = [];
      const want = (c, l) => { if (!c) bad.push(l); };
      want(out.editorOpen === true, '点「新增话术」应打开录入弹窗');
      want(out.err !== '', '空正文应给出可读报错');
      want(out.rowsAfterEmpty === out.rows0, '空正文不许落库');
      want(out.stillOpen === true, '校验不通过时弹窗不该关');
      want(out.rowsAfterAdd === out.rows0 + 1, '保存后应多出一条，实为 ' + out.rowsAfterAdd);
      want(out.custom >= 1, '自建条目应带「自建」标记');
      want(out.hasDelBtn === true, '自建条目应可删除');
      want(out.probeGone === true, '删除后该条应真的消失');
      want(out.focusAfterClose === 'btnKbNew',
        '关闭后焦点应还给「新增话术」，实为 ' + out.focusAfterClose);
      if (bad.length) throw new Error('话术库断言失败：' + bad.join(' | '));
      return out;
    })()`,
  },
  {
    /* 关怀页搜索客户：一百位客户时索引列唯一的用法。
       三件事必须成立 —— 输入即筛、命中数说实话、清空能回到全量；
       另外输入框不在被重绘的那棵子树里，否则每敲一个字就丢焦点。 */
    name: 'care-search',
    url: '/?view=care&nolive=1&today=2026-10-14',
    wait: 2600,
    screenshot: true,
    probe: `(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const q = (s) => document.querySelector(s);
      const out = {};
      await sleep(1200);
      const box = q('#careSearch');
      const names = () => [...document.querySelectorAll('#careBody .care-card .cc-name')].map(n => n.textContent);
      out.all = names();
      out.total = out.all.length;

      box.focus();
      box.value = '苏';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(220);
      out.hitNames = names();
      out.hitText = (q('#careHit') || {}).textContent || '';
      out.hitShown = !q('#careHit').hidden;
      out.clearShown = !q('#btnCareSearchClear').hidden;
      out.focusKept = document.activeElement === box;

      /* 搜一个必然没有的词：空态要说清是「搜不到」，而不是「没有关怀条件」 */
      box.value = 'zzz不存在';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(200);
      out.emptyText = ((q('#careBody .care-empty') || {}).textContent || '').replace(/\\s+/g, ' ').trim();

      q('#btnCareSearchClear').click();
      await sleep(220);
      out.backNames = names();
      out.hitHiddenAfter = q('#careHit').hidden;

      const bad = [];
      const want = (c, l) => { if (!c) bad.push(l); };
      want(out.total >= 3, '关怀页应有至少 3 位客户，实为 ' + out.total);
      want(out.hitNames.length === 1 && out.hitNames[0] === '苏晚晴',
        '搜「苏」应只剩苏晚晴，实为 ' + JSON.stringify(out.hitNames));
      want(/命中 1 \\/ \\d+ 位/.test(out.hitText), '命中数应写成「命中 1 / N 位」，实为 ' + out.hitText);
      want(out.clearShown === true, '有搜索词时应出现清空按钮');
      want(out.focusKept === true, '筛列表时焦点不能丢，实为 ' + (document.activeElement && document.activeElement.id));
      want(/没有匹配/.test(out.emptyText), '搜不到时应说明是搜不到，实为 ' + out.emptyText);
      want(out.backNames.length === out.total, '清空后应回到全量 ' + out.total + ' 位，实为 ' + out.backNames.length);
      want(out.hitHiddenAfter === true, '清空后命中数应隐藏');
      if (bad.length) throw new Error('关怀搜索断言失败：' + bad.join(' | '));
      return out;
    })()`,
  },
  {
    /* 侧栏收起：演示与投屏要能把导航整块让出去，且必须留一条回路。
       外壳铺满窗口也在这里一起钉住 —— 曾经 max-width:1920 + margin:auto
       让宽窗口下整块应用浮在中间，侧栏不再是「最左」。 */
    name: 'rail-toggle',
    url: '/?view=channels&nolive=1',
    wait: 2400,
    screenshot: true,
    probe: `(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const q = (s) => document.querySelector(s);
      const rect = (el) => { const b = el.getBoundingClientRect(); return Math.round(b.x) + ',' + Math.round(b.width); };
      const out = {};
      await sleep(1100);
      const app = q('#app');
      const rail = q('.rail');
      out.fill = { appX: Math.round(app.getBoundingClientRect().x), appW: Math.round(app.getBoundingClientRect().width), win: window.innerWidth };
      out.railBefore = rect(rail);

      /* 用键盘路径进入：先聚焦再点。按钮不会消失，焦点就该原地不动 ——
         这是「收一半」相对「全收」真正的收益（全收时必须手动搬家） */
      q('#btnRailHide').focus();
      q('#btnRailHide').click();
      await sleep(280);
      out.attrOff = app.getAttribute('data-rail');
      out.railDisplay = getComputedStyle(rail).display;
      out.railOffRect = rect(rail);
      out.labelHidden = getComputedStyle(q('.rail-nav .rail-btn .rl')).display;
      out.markShown = getComputedStyle(q('.rail-brand .brand-mark')).display;
      out.icCollapse = getComputedStyle(q('#btnRailHide .ic-collapse')).display;
      out.icExpand = getComputedStyle(q('#btnRailHide .ic-expand')).display;
      out.ariaOff = q('#btnRailHide').getAttribute('aria-expanded');
      out.titleOff = q('#btnRailHide').title;
      /* 图标轨里文字是 display:none，可访问名必须显式挂上，否则读屏只报「按钮」 */
      out.toggleLabel = q('#btnRailHide').getAttribute('aria-label') || '';
      out.navLabel = q('.rail-nav .rail-btn[data-view="care"]').getAttribute('aria-label') || '';
      out.focusAfterHide = document.activeElement && document.activeElement.id;
      out.prefsOff = JSON.parse(localStorage.getItem('beauty-cs-prefs') || '{}').rail;

      q('#btnRailHide').click();
      await sleep(280);
      out.attrOn = app.getAttribute('data-rail');
      out.railAfter = rect(rail);
      out.labelShown = getComputedStyle(q('.rail-nav .rail-btn .rl')).display;
      out.ariaOn = q('#btnRailHide').getAttribute('aria-expanded');
      out.navLabelOn = q('.rail-nav .rail-btn[data-view="care"]').getAttribute('aria-label');
      out.focusAfterShow = document.activeElement && document.activeElement.id;

      /* 设置抽屉里那个「左侧导航」必须改的是同一个状态 */
      q('#btnSettings').click();
      await sleep(260);
      q('#prefRail [data-rail-opt="off"]').click();
      await sleep(240);
      out.attrFromPrefs = app.getAttribute('data-rail');
      out.railFromPrefs = rect(rail);
      q('#prefRail [data-rail-opt="on"]').click();
      await sleep(200);
      q('#btnClosePrefs').click();

      const bad = [];
      const want = (c, l) => { if (!c) bad.push(l); };
      want(out.fill.appX === 0, '外壳应贴窗口最左，实为 x=' + out.fill.appX);
      want(out.fill.appW === out.fill.win, '外壳应铺满窗口（' + out.fill.win + '），实为 ' + out.fill.appW);
      want(out.attrOff === 'off', '收起应写 data-rail=off，实为 ' + out.attrOff);
      want(out.railDisplay !== 'none', '收起应只收一半：导航不能整块退场');
      want(Math.round(parseFloat(out.railOffRect.split(',')[1])) === 64, '收起后导航应收到 64px，实为 ' + out.railOffRect);
      want(out.labelHidden === 'none', '收起后文字标签应收起，实为 ' + out.labelHidden);
      want(out.markShown !== 'none', '收起后应换成 JY 单体标志，实为 ' + out.markShown);
      want(out.icCollapse === 'none' && out.icExpand !== 'none', '收起后图标应换成「展开」箭头');
      want(out.ariaOff === 'false', '收起后 aria-expanded 应为 false，实为 ' + out.ariaOff);
      want(out.titleOff.indexOf('展开') >= 0, '收起后 title 应改成「展开」，实为 ' + out.titleOff);
      want(out.toggleLabel.indexOf('展开') >= 0, '收起后按钮要有可访问名（含「展开」），实为「' + out.toggleLabel + '」');
      want(out.navLabel.length > 0, '图标轨里导航项要有可访问名，实为「' + out.navLabel + '」');
      want(out.navLabelOn === null, '展开后导航项应回到「用文字当名字」，实为「' + out.navLabelOn + '」');
      want(out.focusAfterHide === 'btnRailHide', '按钮没有消失，焦点应留在它身上，实为 ' + out.focusAfterHide);
      want(out.prefsOff === 'off', '收起状态应写进偏好');
      want(out.attrOn === 'on' && Math.round(parseFloat(out.railAfter.split(',')[1])) === 176, '展开后导航应回到 176px，实为 ' + out.railAfter);
      want(out.labelShown !== 'none', '展开后文字标签应回来，实为 ' + out.labelShown);
      want(out.ariaOn === 'true', '展开后 aria-expanded 应为 true，实为 ' + out.ariaOn);
      want(out.attrFromPrefs === 'off', '设置里的开关应改同一处状态，实为 ' + out.attrFromPrefs);
      want(Math.round(parseFloat(out.railFromPrefs.split(',')[1])) === 64, '设置里切「只留图标」也要真的收到 64px，实为 ' + out.railFromPrefs);
      if (bad.length) throw new Error('侧栏断言失败：' + bad.join(' | '));
      return out;
    })()`,
  },
  {
    /* 网站设置：分组要真的存在、开关要真的生效、恢复默认要真的还原。
       设置抽屉里最容易出现「写了一个好看的开关但没人接」——
       所以每一项都点一遍，读的是 documentElement 上的实际属性。 */
    name: 'prefs-panel',
    url: '/?view=workbench&nolive=1',
    wait: 2400,
    screenshot: true,
    probe: `(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const q = (s) => document.querySelector(s);
      const out = {};
      await sleep(1200);
      q('#btnSettings').click();
      await sleep(300);
      out.groups = [...document.querySelectorAll('#drawerRoot .form-block > label')]
        .map(l => l.textContent.trim()).filter(t => t && t.length < 12);
      out.kbdRows = document.querySelectorAll('.kbd-row').length;

      q('#prefDensity [data-density-opt="compact"]').click();
      await sleep(150);
      out.density = document.documentElement.getAttribute('data-density');
      out.cellPad = getComputedStyle(q('.contact')).paddingTop;

      q('#prefSendKey [data-send-opt="ctrl"]').click();
      await sleep(120);
      out.sendKey = JSON.parse(localStorage.getItem('beauty-cs-prefs') || '{}').sendKey;

      q('#btnPrefReset').click();
      await sleep(260);
      const p = JSON.parse(localStorage.getItem('beauty-cs-prefs') || '{}');
      out.afterReset = { density: p.density, rail: p.rail, sendKey: p.sendKey, theme: p.theme };
      out.densityAfterReset = document.documentElement.getAttribute('data-density');
      q('#btnClosePrefs').click();

      const bad = [];
      const want = (c, l) => { if (!c) bad.push(l); };
      ['外观', '界面密度', '左侧导航', '打开时先看哪一屏', '回复框的发送键', '数据与隐私', '快捷键'].forEach((t) => {
        want(out.groups.indexOf(t) >= 0, '设置里应有「' + t + '」一组');
      });
      want(out.kbdRows >= 4, '快捷键表至少 4 行，实为 ' + out.kbdRows);
      want(out.density === 'compact', '选紧凑后应写进 data-density，实为 ' + out.density);
      want(parseFloat(out.cellPad) <= 9, '紧凑档应把会话行内边距压到 8px，实为 ' + out.cellPad);
      want(out.sendKey === 'ctrl', '发送键选择应落盘，实为 ' + out.sendKey);
      want(out.afterReset.density === 'std' && out.afterReset.rail === 'on' &&
        out.afterReset.sendKey === 'enter' && out.afterReset.theme === 'light',
        '恢复默认应还原四项，实为 ' + JSON.stringify(out.afterReset));
      want(out.densityAfterReset === 'std', '恢复默认后界面密度应回到标准，实为 ' + out.densityAfterReset);
      if (bad.length) throw new Error('设置面板断言失败：' + bad.join(' | '));
      return out;
    })()`,
  },
  {
    /* 登录门禁：没登录就不该看见内容。
       钉四件事 —— 进门时应用不可见、坐席名单来自服务端、错口令有话说、退出口令后重新关上。 */
    name: 'login-gate',
    url: '/',
    gate: true,
    wait: 2800,
    screenshot: true,
    probe: `(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const q = (s) => document.querySelector(s);
      const out = {};
      await sleep(1200);
      out.gated = document.body.getAttribute('data-gate') === '1';
      out.appHidden = getComputedStyle(document.getElementById('app')).visibility === 'hidden';
      out.gateShown = getComputedStyle(document.getElementById('gate')).display !== 'none';
      out.agents = document.querySelectorAll('#gateAgents .gate-agent').length;

      /* 点一位坐席应把工号填进去：登录页只该让人做两件事 */
      const chip = q('#gateAgents .gate-agent');
      out.chipFill = '';
      if (chip) { chip.click(); await sleep(160); out.chipFill = q('#gateId').value; }

      q('#gatePin').value = '0000';
      q('#btnGateLogin').click();
      await sleep(1000);
      out.errWrongPin = (q('#gateErr').textContent || '').trim();
      out.stillGated = document.body.getAttribute('data-gate') === '1';

      q('#gateId').value = 'CS013';
      q('#gatePin').value = '1234';
      q('#btnGateLogin').click();
      await sleep(1800);
      out.gateAfter = document.body.getAttribute('data-gate');
      out.meName = ((q('#meName') || {}).textContent || '').trim();
      out.token = !!localStorage.getItem('beauty-cs-token');

      /* 退出必须重新关上，并把令牌清干净 */
      q('#btnLogout').click();
      await sleep(1200);
      out.gatedAgain = document.body.getAttribute('data-gate') === '1';
      out.tokenAfter = !!localStorage.getItem('beauty-cs-token');
      try { localStorage.removeItem('beauty-cs-token'); } catch (e) { /* ignore */ }

      const bad = [];
      const want = (c, l) => { if (!c) bad.push(l); };
      want(out.gated === true, '未登录时页面应处于门禁态');
      want(out.appHidden === true, '未登录时应用内容必须不可见');
      want(out.gateShown === true, '门禁页应可见');
      want(out.agents === 3, '登录页应列出 3 位坐席，实为 ' + out.agents);
      want(out.chipFill === 'CS013', '点坐席应把工号填进输入框，实为「' + out.chipFill + '」');
      want(out.errWrongPin !== '', '口令错误应给出可读提示');
      want(out.stillGated === true, '口令错误时必须仍停在门禁页');
      want(out.gateAfter === null, '登录成功后应摘掉门禁');
      want(out.meName === '佟佳鑫', '登录后身份卡应显示坐席姓名，实为「' + out.meName + '」');
      want(out.token === true, '登录应把令牌写进本机');
      want(out.gatedAgain === true, '退出登录后应重新回到门禁');
      want(out.tokenAfter === false, '退出后本机令牌应清空');
      if (bad.length) throw new Error('登录门禁断言失败：' + bad.join(' | '));
      return out;
    })()`,
  },
  {
    /* 注册：登录页的第二条岔路。跑完必须把自己建的工号收走 ——
       这条用例每跑一次就往账号库里塞一个人，「本店坐席」列表会越跑越脏，
       所以结尾调 /api/auth/unregister（只能注销令牌对应的自己）。 */
    name: 'register-gate',
    url: '/',
    gate: true,
    wait: 2800,
    probe: `(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const q = (s) => document.querySelector(s);
      const post = (path, body, tk) => fetch(path, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, tk ? { Authorization: 'Bearer ' + tk } : {}),
        body: body ? JSON.stringify(body) : undefined,
      });
      const out = {};

      /* 上一次跑到一半崩了会留下这个试号：先登录再注销，保证起点干净 */
      out.purge = 'absent';
      const pre = await post('/api/auth/login', { agentId: 'QA900', pin: '1234' });
      if (pre.status === 200) {
        const pj = await pre.json();
        const pr = await post('/api/auth/unregister', null, pj.token);
        out.purge = 'purged:' + pr.status;
      }

      await sleep(1200);
      out.gated = document.body.getAttribute('data-gate') === '1';

      /* 切到注册：同一张卡里换字段，登录区必须整块隐藏 */
      q('#tabGateReg').click();
      await sleep(150);
      out.regShown = !q('#gateRegPane').hidden;
      out.loginHidden = q('#gateLoginPane').hidden === true;
      out.tabRegSelected = q('#tabGateReg').getAttribute('aria-selected');
      out.focusOnReg = document.activeElement && document.activeElement.id;

      /* 客户端校验：工号格式 / 两次口令不一致 —— 不该发请求，也不该放行 */
      q('#regId').value = 'AB';
      q('#regName').value = '测试坐席';
      q('#regPin').value = '1234';
      q('#regPin2').value = '1234';
      q('#btnGateReg').click();
      await sleep(220);
      out.errBadId = (q('#regErr').textContent || '').trim();
      out.stillGatedBadId = document.body.getAttribute('data-gate') === '1';

      q('#regId').value = 'QA900';
      q('#regPin2').value = '9999';
      q('#btnGateReg').click();
      await sleep(220);
      out.errMismatch = (q('#regErr').textContent || '').trim();

      /* 正路：建号即登录，不用再输一遍口令 */
      q('#regPin2').value = '1234';
      q('#btnGateReg').click();
      await sleep(2200);
      out.gateAfter = document.body.getAttribute('data-gate');
      out.meName = ((q('#meName') || {}).textContent || '').trim();
      out.token = !!localStorage.getItem('beauty-cs-token');
      const list = await (await fetch('/api/agents')).json();
      const mine = (list.agents || []).filter((a) => a.id === 'QA900')[0];
      out.created = mine ? mine.name + '/' + mine.role + '/' + mine.level : null;
      out.noSecret = mine ? !('pinHash' in mine) && !('salt' in mine) : false;

      /* 重复注册必须被服务端挡住（前端校验不能当判据） */
      const dup = await post('/api/auth/register', { agentId: 'QA900', name: '另一个', role: '客服', pin: '1234' });
      out.dupStatus = dup.status;

      /* 收尾：注销自己 + 清本机令牌，账号库回到 3 个人 */
      const tk = localStorage.getItem('beauty-cs-token');
      const del = await post('/api/auth/unregister', null, tk);
      out.cleanup = del.status;
      const after = await (await fetch('/api/agents')).json();
      out.agentsAfter = (after.agents || []).length;
      out.sessionAfter = (await fetch('/api/auth/session', { headers: { Authorization: 'Bearer ' + tk } })).status;
      try { localStorage.removeItem('beauty-cs-token'); } catch (e) { /* ignore */ }

      const bad = [];
      const want = (c, l) => { if (!c) bad.push(l); };
      want(out.gated === true, '未登录时应停在门禁页');
      want(out.regShown === true, '点「注册」应显示注册表单');
      want(out.loginHidden === true, '切到注册后登录区要整块隐藏');
      want(out.tabRegSelected === 'true', '注册 tab 的 aria-selected 应为 true');
      want(out.focusOnReg === 'regId', '切到注册后焦点应落在工号框，实为 ' + out.focusOnReg);
      want(out.errBadId.indexOf('工号') >= 0, '工号格式不对应给出可读提示，实为「' + out.errBadId + '」');
      want(out.stillGatedBadId === true, '格式错误时不能放行');
      want(out.errMismatch.indexOf('不一样') >= 0, '两次口令不一致应提示，实为「' + out.errMismatch + '」');
      want(out.gateAfter === null, '注册成功应直接进门禁，实为 ' + out.gateAfter);
      want(out.meName === '测试坐席', '进门后身份卡应显示新坐席，实为「' + out.meName + '」');
      want(out.token === true, '注册成功应拿到令牌');
      want(out.created === '测试坐席/客服/L1', '账号库应有新工号且从 L1 起，实为 ' + out.created);
      want(out.noSecret === true, '坐席列表不能带出 salt / pinHash');
      want(out.dupStatus === 409, '重复工号应返回 409，实为 ' + out.dupStatus);
      want(out.cleanup === 200, '测试工号应能注销自己，实为 ' + out.cleanup);
      want(out.agentsAfter === 3, '注销后账号库应回到 3 人，实为 ' + out.agentsAfter);
      want(out.sessionAfter === 401, '注销后旧令牌应立即失效，实为 ' + out.sessionAfter);
      if (bad.length) throw new Error('注册断言失败：' + bad.join(' | '));
      return out;
    })()`,
  },
  {
    /* 风险对账闸必须要在**真实浏览器**里成立一次：
       单测证明阶段函数算得对，这条证明页面真的把它装配进了管线（脚本清单、
       加载顺序、window 挂载任何一处断了，界面上的分数就会退回模型自报的数）。
       不依赖模型 —— 直接在页面上拿真 RiskPolicy 跑一次阶段的真实调用。 */
    name: 'riskfloor-gate',
    url: '/?nolive=1',
    wait: 2000,
    screenshot: false,
    probe: `(() => {
      const H = window.AnalysisHarness, S = window.HarnessStages, RP = window.RiskPolicy;
      const stages = H.stageNames();
      const risk = { level: 'low', score: 10, signals: ['皮肤刺激', '投诉倾向'], advice: '安抚一下就好' };
      const facts = {}, decisions = [];
      const ctx = { deps: { RiskPolicy: RP }, set: (k, v) => { facts[k] = v; }, decide: (tt) => { decisions.push(tt); } };
      S.riskfloor({ provider: 'llm', job: { message: '我脸过敏烂脸了，你们这是要毁容，我要投诉12315' }, result: { risk: risk } }, ctx);
      const out = {
        order: stages.join('>'),
        gates: H.fatalStages().join('>'),
        declared: (S.FATAL || []).join('>'),
        score: risk.score,
        level: risk.level,
        alias: (risk.recheck.alias || []).map((p) => p.from + '→' + p.to).join(','),
        unknown: (risk.recheck.unknown || []).join(','),
        hasAction: risk.advice.indexOf('立即升级资深客服') !== -1,
        traceScoreFact: facts.riskScore,
        trace: decisions[0] || '',
      };
      const bad = [];
      const want = (c, l) => { if (!c) bad.push(l); };
      want(stages.indexOf('riskfloor') === stages.indexOf('generate') + 1, '浏览器里的管线没装配 riskfloor：' + out.order);
      /* 声明了 FATAL 但组装漏标 fatal，页面不报错、结果照样出，只是闸退回「跳过并继续」：
         静态正则在 ST21 里比的是源码文本，这一条比的是**真实加载后的装配结果**。 */
      want(out.gates === out.declared, '真实装配的闸名单与 stages.FATAL 不一致：装配 ' + (out.gates || '(空)') + ' vs 声明 ' + out.declared);
      want(out.declared === 'riskfloor', 'stages.FATAL 不是只有 riskfloor：' + out.declared);
      want(out.score === 80, '低报没被词典抬回，分数是 ' + out.score);
      want(out.level === 'high', '等级没抬到高危，实为 ' + out.level);
      want(out.alias.indexOf('皮肤刺激→皮肤不良反应') !== -1, '非标准信号名没被归一：' + out.alias);
      want(out.unknown === '投诉倾向', '兜不住的名字没被记录：' + out.unknown);
      want(out.hasAction === true, '处置文案没按新等级重算');
      want(out.traceScoreFact === 80, 'trace 里记录的分数不是过闸后的：' + out.traceScoreFact);
      if (bad.length) throw new Error('风险对账闸断言失败 ' + bad.length + ' 项：' + bad.join(' | '));
      return out;
    })()`,
  },
  {
    /* 「队列按会话分桶」+「预算按轮」在单测里各自绿，但装配层断了界面**不会报错**：
       · jobqueue.js 没进 index.html → app.js 抛「JobQueue 未加载」（这条会崩，算好事）
       · 脚本顺序错 / 预算回潮成 LLMClient 身上那一格全局 deadline → 静默退化：
         界面又变回「一条串行队列 + 一份全局预算」，读数看着全都正常，只是并发时互相覆盖。
       所以在真页面里钉五处：加载顺序、真实 window.JobQueue 的调度语义（FIFO / 并行 / 上限 /
       失败隔离）、真实 LLMClient 的按轮口径、Agent 子预算的上限、真实管线（组装根 create）
       守本轮预算且不写全局。 */
    name: 'queue-buckets',
    url: '/?nolive=1',
    wait: 2200,
    screenshot: false,
    probe: `(async () => {
      const bad = [];
      const want = (c, l) => { if (!c) bad.push(l); };
      const JQ = window.JobQueue, H = window.AnalysisHarness, AG = window.HarnessAgent, LLM = window.LLMClient;
      const tick = () => new Promise((r) => setTimeout(r, 0));
      const out = {};

      /* ---- ① 装载顺序：jobqueue 必须早于 app（app 一上来就要 create 队列） ---- */
      const srcs = Array.prototype.slice.call(document.scripts).map((s) => s.getAttribute('src') || '');
      const iJob = srcs.indexOf('assets/jobqueue.js');
      const iApp = srcs.indexOf('assets/app.js');
      out.scriptPos = iJob + '/' + iApp;
      want(iJob !== -1 && iApp !== -1, 'index.html 里找不到 jobqueue.js 或 app.js');
      want(iJob !== -1 && iJob < iApp, 'jobqueue.js 没排在 app.js 之前');
      want(typeof JQ.create === 'function' && JQ.DEFAULT_MAX_CONCURRENT === 2,
        'window.JobQueue 没挂上，或默认并发上限不再是 2');

      /* ---- ② 真实 window 上的调度语义：桶内 FIFO / 桶间并行 / 全局上限 ---- */
      const d = {};
      const gate = (id) => {
        let res, rej;
        const p = new Promise((a, b) => { res = a; rej = b; });
        d[id] = { p, res, rej };
      };
      const order1 = [];
      let live = 0, peak = 0;
      const q1 = JQ.create({
        maxConcurrent: 2,
        keyOf: (j) => j.k,
        run: (j) => {
          order1.push(j.id);
          live++;
          if (live > peak) peak = live;
          return d[j.id].p.then(() => { live--; }, () => { live--; });
        },
      });
      ['A1', 'A2', 'A3', 'B1'].forEach(gate);
      const depths = [
        q1.enqueue({ id: 'A1', k: 'A' }),
        q1.enqueue({ id: 'A2', k: 'A' }),
        q1.enqueue({ id: 'A3', k: 'A' }),
        q1.enqueue({ id: 'B1', k: 'B' }),
      ];
      out.started = order1.join(',');
      out.depths = depths.join(',');
      out.reads = q1.running() + '/' + q1.waiting() + '/' + q1.buckets();
      want(out.started === 'A1,B1', '同会话要排队、跨会话要并行，实际起跑 ' + out.started);
      want(out.depths === '0,1,2,0', '入队返回值应是该会话此刻的排队深度（联系人上的「排队 N」用它），实际 ' + out.depths);
      want(q1.waitingFor('A') === 2 && q1.busyFor('A') === true && q1.busyFor('C') === false,
        '按会话读排队深度 / 忙不忙读错了');
      d.A1.res(); await tick(); await tick();
      want(order1.join(',') === 'A1,B1,A2', 'A 桶没按到达顺序补位：' + order1.join(','));
      want(q1.running() === 2 && q1.waiting() === 1, '补位后并发读数说谎：' + q1.running() + '/' + q1.waiting());
      d.A2.res(); await tick(); await tick();
      d.A3.res(); d.B1.res(); await tick(); await tick();
      out.peak = peak;
      want(peak <= q1.maxConcurrent(), '并发峰值 ' + peak + ' 超过上限 ' + q1.maxConcurrent() + '，上游配额保护失效');
      want(q1.stats().done === 4 && q1.stats().failed === 0, '全部完成后计数不对：' + JSON.stringify(q1.stats()));

      /* ---- ③ 一条失败（含同步抛错）不阻断后续，也不混进别的账 ---- */
      const errSeen = [];
      const order2 = [];
      const q2 = JQ.create({
        maxConcurrent: 1,
        keyOf: (j) => j.k,
        run: (j) => {
          if (j.boom) return Promise.reject(new Error('故意失败'));
          if (j.sync) throw new Error('故意同步抛错');
          order2.push(j.id);
          return Promise.resolve();
        },
        onError: (j, e) => { errSeen.push(j.id + ':' + e.message); },
      });
      q2.enqueue({ id: 'X1', k: 'X', boom: true });
      q2.enqueue({ id: 'X2', k: 'X', sync: true });
      q2.enqueue({ id: 'X3', k: 'Y' });
      q2.enqueue({ id: 'X4', k: 'Y' });
      await tick(); await tick();
      out.errSeen = errSeen.join(',');
      out.afterFail = order2.join(',');
      want(out.errSeen === 'X1:故意失败,X2:故意同步抛错',
        '失败原因没原样交回调用方（坐席侧的 ack / 提示靠它）：' + out.errSeen);
      want(out.afterFail === 'X3,X4', '一条失败后同桶与别的会话没继续跑：' + out.afterFail);
      const s2 = q2.stats();
      want(s2.failed === 2 && s2.done === 2 && s2.callbackErrors === 0,
        '失败 / 完成 / 回调异常分开计数说谎：' + JSON.stringify(s2));

      /* ---- ④ 真 LLMClient 的按轮口径（全局那一格取更紧者，用完立即复位） ---- */
      want(typeof LLM.remainingFor === 'function', '页面上的 LLMClient 没有 remainingFor（按轮预算没装进来）');
      out.noDeadlineIsInfinity = LLM.remainingFor(0) === Infinity;
      LLM.setDeadline(Date.now() + 900);
      const underGlobal = LLM.remainingFor(Date.now() + 60000);
      LLM.setDeadline(0);
      const roundOnly = LLM.remainingFor(Date.now() + 5000);
      out.underGlobal = Math.round(underGlobal);
      out.roundOnly = Math.round(roundOnly);
      out.globalRestored = LLM.remainingMs() === Infinity;
      want(out.noDeadlineIsInfinity === true, '没设全局闸门时 remainingFor(0) 应是不限');
      want(underGlobal > 0 && underGlobal <= 900, '全局闸门更紧时没取更紧者：' + out.underGlobal + 'ms');
      want(roundOnly > 4000 && roundOnly <= 5000, '按轮截止没被单独算出来：' + out.roundOnly + 'ms');
      want(out.globalRestored === true, '探针没能把全局 deadline 复位（后面几条检查会被误伤）');
      want(H.MIN_CALL_MS === 2000 && AG.MIN_STEP_MS === 3000,
        '单次请求 / 单步的预算下限被改动，界面上的降级文案就对不上：' + H.MIN_CALL_MS + '/' + AG.MIN_STEP_MS);
      const roomy = AG.subBudgetUntil({ deadlineAt: Date.now() + 60000 }, LLM);
      out.agentSubMs = Math.round(roomy - Date.now());
      want(out.agentSubMs > 0 && out.agentSubMs <= AG.SUB_BUDGET_CAP_MS + 60,
        'Agent 子预算没被上限截住，一轮可能被它独占：' + out.agentSubMs + 'ms');
      want(AG.subBudgetUntil({}, LLM) === 0, '没有按轮预算时子预算应返回 0（不限）');

      /* 步数上限由子预算给。这里专门用**真实子预算的读数**去算步数：
         浏览器里时钟是活的，subBudgetUntil 落到 8999ms 这类值时，
         如果 stepAllowance 没有 STEP_SLACK_MS，就会在 2 步 / 3 步之间随机抖 ——
         Node 单测用 stub 时间，永远照不出这种红绿灯，只能在这里照。 */
      want(typeof AG.stepAllowance === 'function', 'agent.js 未导出 stepAllowance（步数上限没按预算给）');
      out.agentSteps = AG.stepAllowance(roomy - Date.now());
      want(out.agentSteps === 3, '满子预算应给 3 步，实际 ' + out.agentSteps + ' 步（读数 ' + Math.round(roomy - Date.now()) + 'ms）');
      want(AG.stepAllowance(Infinity) === AG.MAX_STEPS, '不限预算时步数上限应回落到 MAX_STEPS：' + AG.stepAllowance(Infinity));
      want(AG.stepAllowance(6000) === 2 && AG.stepAllowance(2999) === 1,
        '剩余时间换算步数不对：6000→' + AG.stepAllowance(6000) + '，2999→' + AG.stepAllowance(2999));
      want(AG.stepAllowance(NaN) === 1 && AG.stepAllowance(0) === 1,
        '读数坏掉时必须保守（宁少走一步，不多放行）：' + AG.stepAllowance(NaN) + '/' + AG.stepAllowance(0));

      /* ---- ⑤ 真实组装根：守本轮预算，且不回潮去写全局那一格 ---- */
      const calls = [];
      let globalWrites = 0;
      const stub = {
        readConfig: () => ({ mode: 'auto', budgetMs: 15000, model: 'browser-stub', maxCalls: 100 }),
        remainingFor: (u) => (Number(u) > 0 ? Math.max(0, Number(u) - Date.now()) : Infinity),
        remainingMs: () => Infinity,
        setDeadline: () => { globalWrites++; },
        analyze: (input, opts) => {
          calls.push((opts && opts.deadlineAt) || 0);
          return Promise.resolve({
            engine: 'llm', emotion: { score: 55 },
            intents: [{ name: '常规咨询', tone: 'muted', confidence: 0.6 }],
            risk: { level: 'low', score: 5, signals: [], advice: '' },
            replies: [{ text: '模型的话术', confidence: 0.9 }],
          });
        },
      };
      const hb = H.create({ name: 'browser-budget', providerChain: ['llm', 'local'] });
      const deps = Object.assign({}, H.deps(), { LLMClient: stub });
      const spent = { message: '我的面霜用了两天脸上刺痛发红', series: [], ctx: {}, customerId: 'probe' };
      spent.deadlineAt = Date.now() - 1;
      const rSpent = await hb.run(spent, deps);
      const callsAfterSpent = calls.length;
      const liveJob = { message: '我的面霜用了两天脸上刺痛发红', series: [], ctx: {}, customerId: 'probe' };
      liveJob.deadlineAt = Date.now() + 9000;
      const rLive = await hb.run(liveJob, deps);
      out.spent = rSpent.provider + '/' + callsAfterSpent + '/' + rSpent.trace.facts.llmSkippedForBudget + '/' + (rSpent.degraded || 'none');
      out.live = rLive.provider + '/' + calls.length + '/' + (rLive.trace.facts.budgetLeftMs || 0);
      want(callsAfterSpent === 0, '预算耗尽那一轮一次模型都不该发，实际发了 ' + callsAfterSpent);
      want(calls.length === 1, '有预算的那一轮应正好发一次模型请求，两轮合计 ' + calls.length);
      want(rSpent.provider === 'local', '预算耗尽没落到本地引擎：' + rSpent.provider);
      want(rSpent.trace.decisions.join(' ｜ ').indexOf('本轮模型预算仅剩') !== -1,
        '轨迹里没写明「是本轮预算不够」，坐席只会看到一次莫名的本地降级');
      want(rSpent.degraded === '', '预算不足被记成了模型故障：' + rSpent.degraded);
      want(rSpent.trace.facts.llmSkippedForBudget === true && rLive.trace.facts.llmSkippedForBudget === false,
        '「因预算跳过」这个事实读数没说真话（管线上要显示它）');
      want(calls[0] === liveJob.deadlineAt, '调用模型时没带上本轮的绝对截止时刻，实际 ' + calls[0]);
      want(globalWrites === 0, '管线又去写 LLMClient 的全局 deadline 了 —— 两轮重叠时会互相覆盖');

      if (bad.length) throw new Error('队列与预算断言失败 ' + bad.length + ' 项：' + bad.join(' | '));
      return out;
    })()`,
  },
];

/* ------------------------------------------------------------------ CDP */

function getJson(url) {
  return fetch(url).then((r) => r.json());
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

(async function main() {
  if (!CHROME) { console.error('未找到 Chrome / Edge'); process.exit(2); }
  fs.mkdirSync(OUT, { recursive: true });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cdp-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars', '--mute-audio',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--window-size=1600,1000', 'about:blank',
  ], { stdio: 'ignore' });

  const summary = { chrome: CHROME, base: BASE, out: OUT, checks: [], errors: [] };

  try {
    const list = await waitForDevtools();
    const page = (list.find((t) => t.type === 'page') || list[0]);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const c = cdp(ws);

    let pageErrors = [];
    let consoleErrors = [];
    c.on((m) => {
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails || {};
        pageErrors.push((d.exception && d.exception.description) || d.text || 'unknown');
      }
      if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
        consoleErrors.push(m.params.type + ': ' + (m.params.args || []).map((a) => a.value || a.description || '').join(' '));
      }
    });
    await c.send('Runtime.enable');
    await c.send('Page.enable');

    for (const chk of CHECKS) {
      if (ONLY && chk.name.indexOf(ONLY) === -1) continue;
      pageErrors = []; consoleErrors = [];
      /* 门禁默认关闭：除 login-gate 外，所有检查都从「已进入」的状态起跑，
         否则每条断言都会撞在登录页上，测不到任何业务行为 */
      const nav = chk.gate ? chk.url : chk.url + (chk.url.indexOf('?') === -1 ? '?' : '&') + 'gate=off';
      await c.send('Page.navigate', { url: BASE + nav });
      await new Promise((r) => setTimeout(r, chk.wait || 2000));
      let probe = null, probeErr = null;
      try {
        /* probe 可以是模板字符串，也可以是个返回字符串的函数（要按参数拼源码的用后者）。
           直接把它塞进 expression 时，函数会被 JSON 序列化丢掉字段 → CDP 回一句
           「Invalid parameters」，看起来像浏览器出了问题，其实是探针没生成。
           所以这里显式求值，并且把「探针不是非空字符串」本身判成失败。 */
        const src = typeof chk.probe === 'function' ? chk.probe() : chk.probe;
        if (typeof src !== 'string' || !src.trim()) {
          throw new Error('探针源码为空（probe 返回了 ' + Object.prototype.toString.call(src) + '）');
        }
        const r = await c.send('Runtime.evaluate', {
          expression: src, returnByValue: true, awaitPromise: true,
        });
        if (r.exceptionDetails) probeErr = (r.exceptionDetails.exception || {}).description || r.exceptionDetails.text;
        else probe = r.result.value;
      } catch (e) { probeErr = e.message; }

      let shot = null;
      if (chk.screenshot) {
        try {
          const s = await c.send('Page.captureScreenshot', { format: 'png' });
          shot = path.join(OUT, chk.name + '.png');
          fs.writeFileSync(shot, Buffer.from(s.data, 'base64'));
        } catch (e) { shot = null; }
      }
      summary.checks.push({ name: chk.name, url: chk.url, probe, probeErr, screenshot: shot, pageErrors: pageErrors.slice(), consoleErrors: consoleErrors.slice() });
      /* 探针里的断言失败同样是失败 —— 只收页面异常会漏掉整条断言语义 */
      if (probeErr) summary.errors.push(chk.name + ' 探针断言失败: ' + String(probeErr).split('\n')[0]);
      if (pageErrors.length) summary.errors.push(chk.name + ': ' + pageErrors[0]);
    }

    ws.close();
  } catch (e) {
    summary.errors.push(String(e.message || e));
  } finally {
    try { chrome.kill(); } catch (e) { /* ignore */ }
  }

  const lines = [];
  lines.push('浏览器：' + summary.chrome);
  lines.push('截图目录：' + summary.out);
  summary.checks.forEach((c) => {
    lines.push('');
    lines.push('■ ' + c.name + '  ' + c.url);
    lines.push('  probe: ' + JSON.stringify(c.probe));
    if (c.probeErr) lines.push('  probe 异常: ' + c.probeErr);
    lines.push('  PAGE-ERRORS: ' + (c.pageErrors.length ? c.pageErrors.join(' | ') : 'none'));
    if (c.consoleErrors.length) lines.push('  console: ' + c.consoleErrors.slice(0, 3).join(' | '));
    if (c.screenshot) lines.push('  screenshot: ' + c.screenshot);
  });
  lines.push('');
  lines.push('==> ' + (summary.errors.length ? 'FAIL: ' + summary.errors.join(' | ') : 'PASS（无页面异常）'));
  console.log(lines.join('\n'));
  process.exit(summary.errors.length ? 1 : 0);
})();
