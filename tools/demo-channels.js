#!/usr/bin/env node
/* ==========================================================================
   渠道接入 · 演示数据装载脚本

   为什么单独做一个脚本：
     产品默认状态是「0 个已接入」—— 真实世界里没人替你把店铺接好。
     所以演示数据不能内置，必须由人**主动**加载。浏览器里对应右上角
     「载入演示数据」按钮；这里是等价的命令行入口，用于快速核对 / 截图 / 回归。

   用法：
     node tools/demo-channels.js            # 打印演示态摘要
     node tools/demo-channels.js --json     # 输出机器可读的完整快照
     node tools/demo-channels.js --cold     # 打印默认（一个都没接）的状态
   ========================================================================== */

'use strict';

const path = require('path');
const CH = require(path.join(__dirname, '..', 'assets', 'channels.js'));

const asJson = process.argv.includes('--json');
const cold = process.argv.includes('--cold');

if (cold) CH.reset(); else CH.demo();

const st = CH.stats();
const list = CH.list();
const merges = CH.mergeAll();

if (asJson) {
  process.stdout.write(JSON.stringify({
    demo: CH.isDemo(),
    stats: st,
    channels: list.map((c) => ({
      id: c.id, name: c.name, linked: c.linked, account: c.account,
      tokenState: c.tokenState, tokenLabel: c.tokenLabel,
      tokenAction: c.tokenAction, today: c.today,
      credentialPrint: c.credentialPrint,
    })),
    merges: merges.map((m) => ({
      name: m.name, channels: m.channelCount, gaps: m.gaps, dark: m.dark,
    })),
  }, null, 2) + '\n');
  process.exit(0);
}

const lines = [];
lines.push('渠道接入 · ' + (CH.isDemo() ? '演示数据（主动装载）' : '默认状态（未接入任何渠道）'));
lines.push('='.repeat(72));
lines.push('已接入 ' + st.connected + ' / ' + st.total +
  ' · 今日消息 ' + st.todayMessages + ' 条 · 累计 ' + st.historyMessages + ' 条');
lines.push('授权健康度：' + (!st.connected ? '—（尚未接入任何渠道）'
  : (st.broken ? st.broken + ' 个已中断（' + st.brokenNames.join(' / ') + '）'
    : (st.expiring ? st.expiring + ' 个临期（' + st.expiringNames.join(' / ') + '）' : '正常'))));
lines.push('渠道间信息断层 ' + st.gapItems + ' 处 · 可归并用户 ' + st.mergedUsers + ' 人');
lines.push('');
lines.push('渠道                状态        授权              今日  账户');
lines.push('-'.repeat(72));
list.forEach((c) => {
  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
  lines.push(
    pad(c.name, 20) +
    pad(c.linked ? '已接入' : '未接入', 12) +
    pad(c.linked ? (c.tokenLabel || '—') : (c.prerequisites + ' 项前置 / ' + c.fieldCount + ' 个字段'), 18) +
    pad(String(c.today), 6) +
    (c.account || '')
  );
});
lines.push('');
if (!st.connected) {
  lines.push('跨渠道身份合并：尚未接入任何渠道，没有渠道在往总线送消息，也就拼不出跨渠道的人。');
} else {
  lines.push('跨渠道身份合并：');
  merges.forEach((m) => {
    lines.push('  ' + m.name + ' · 横跨 ' + m.channelCount + ' 个渠道 · 断层 ' + m.gaps + ' 处 · 盲区 ' + m.dark + ' 条');
  });
}
lines.push('');
lines.push('浏览器里点右上角「载入演示数据 / 清除演示数据」可随时切换。');

process.stdout.write(lines.join('\n') + '\n');
