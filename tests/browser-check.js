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
      return {
        metrics: cards.map(c => c.querySelector('.ev-k').textContent + '=' + c.querySelector('.ev-v').textContent),
        matrixCells: document.querySelectorAll('#evalBody .ev-matrix td').length,
        misses: miss,
        rows: document.querySelectorAll('#evalBody .ev-table tbody tr').length,
        meta: (document.getElementById('evalMeta') || {}).textContent || '',
      };
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
      return {
        metrics: [...document.querySelectorAll('#careMetrics .metric')].map(m => m.textContent.trim().replace(/\\s+/g, ' ')),
        cards: cards.length,
        finance: cards.map(c => (c.querySelector('.cc-name') || {}).textContent + ':' + c.querySelectorAll('.care-item').length),
        highItems: document.querySelectorAll('#careBody .care-item.lv-high').length,
        evidence: document.querySelectorAll('#careBody .ci-evidence span').length,
        watch: document.querySelectorAll('#careBody .cc-watch').length,
        notes: document.querySelectorAll('#careNotes .cn-row').length,
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
      await c.send('Page.navigate', { url: BASE + chk.url });
      await new Promise((r) => setTimeout(r, chk.wait || 2000));
      let probe = null, probeErr = null;
      try {
        const r = await c.send('Runtime.evaluate', {
          expression: chk.probe, returnByValue: true, awaitPromise: true,
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
