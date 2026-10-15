/* ==========================================================================
   多渠道接入 channels.js
   —— 目录 / 统计 / 合并 / 接入要求 / 凭证校验 / 连通性 / OAuth / token 生命周期
   ========================================================================== */

'use strict';

const { load } = require('./sandbox');

module.exports = async function (t) {
  const S = load(['assets/channels.js']);
  const CH = S.Channels;

  /* -------------------------------------------------- 默认状态（真实初始态） */

  t.suite('channels · 默认状态是「一个都没接」');
  const cold = CH.list();
  t.eq(cold.length, 8, '登记了八个渠道');
  t.eq(cold.filter((c) => c.linked).length, 0, '默认 0 个已接入 —— 渠道不会被「一键」接上');
  t.eq(CH.stats().connected, 0, '统计口径同样为 0');
  t.eq(CH.stats().todayMessages, 0, '没有接入就没有消息汇入');
  t.eq(CH.stats().broken, 0, '没有接入就没有授权中断');
  t.eq(CH.isDemo(), false, '默认不处于演示态');
  t.ok(cold.every((c) => c.prerequisites >= 3 && c.fieldCount >= 2),
    '每个未接入渠道都已声明前置条件数与凭证字段数（这些才是接入的门槛）');
  t.eq(CH.channelTally(CH.FOOTPRINTS['周雨桐']).every((x) => x.linked === false), true,
    '未接入时所有渠道都标为不可达');

  /* 装载演示数据集（等价于点界面上的「载入演示数据」），后续断言基于这份快照 */

  CH.demo();
  t.suite('channels · 演示数据装载');
  t.eq(CH.isDemo(), true, 'demo() 后进入演示态');
  t.eq(CH.stats().connected, 4, '演示数据恢复 4 个已接入渠道');
  t.eq(CH.stats().broken, 1, '演示数据里带一个授权已中断的渠道（京东）');
  CH.reset();
  t.eq(CH.stats().connected, 0, 'reset() 清空演示数据，回到真实初始态');
  CH.demo();

  /* ------------------------------------------------------------ 渠道目录 */

  t.suite('channels · 渠道目录');
  const all = CH.list();
  t.eq(all.length, 8, '登记了八个渠道');
  t.eq(all.filter((c) => c.linked).length, 4, '演示数据里有 4 个已接入');
  t.ok(all.every((c) => c.abbr && c.source && c.note), '每个渠道都有缩写 / 来源 / 说明');
  t.ok(all.every((c) => c.caps.length >= 2), '每个渠道都声明了能力边界');
  t.ok(all.map((c) => c.kind).indexOf('open-api') !== -1, '包含开放平台接入方式');
  t.ok(all.map((c) => c.kind).indexOf('plugin') !== -1, '包含插件嵌入方式');
  t.ok(all.map((c) => c.kind).indexOf('webhook') !== -1, '包含 Webhook 方式');

  t.suite('channels · 接入要求定义');
  const suTmall = CH.setupOf('tmall');
  t.eq(suTmall.fields.map((f) => f.k).join(','), 'appKey,appSecret,shopNick,callback', '天猫要 AppKey / AppSecret / 店铺昵称 / 回调地址');
  t.eq(suTmall.fields.filter((f) => f.secret).length, 1, 'AppSecret 标记为敏感字段');
  t.ok(suTmall.prereq.length >= 4, '天猫列出至少 4 项平台侧前置条件');
  t.ok(suTmall.scopes.length >= 3, '天猫声明接口权限范围');
  t.ok(/oauth\.taobao\.com\/authorize/.test(suTmall.authUrl), '授权地址指向淘宝 OAuth');
  t.ok(/oauth\.taobao\.com\/token/.test(suTmall.tokenUrl), 'token 交换地址指向淘宝');
  t.ok(suTmall.sign.indexOf('MD5') !== -1, '签名机制写明 MD5 与时间戳偏差要求');

  const suJd = CH.setupOf('jd');
  t.ok(/24 小时/.test(suJd.ttlHuman), '京东 token 有效期写明 24 小时（文档硬性）');
  t.eq(suJd.ttl, 24 * 3600 * 1000, '京东 ttl 换算为 24 小时毫秒数');

  const suWx = CH.setupOf('wecom');
  t.ok(suWx.fields.map((f) => f.k).indexOf('aesKey') !== -1, '微信客服要 EncodingAESKey');
  t.ok(suWx.fields.map((f) => f.k).indexOf('token') !== -1, '微信客服要 Token');
  t.eq(suWx.ttl, 2 * 3600 * 1000, '微信客服 access_token 2 小时');

  const suXhs = CH.setupOf('xhs');
  t.eq(suXhs.ttl, null, '小红书不写死有效期（以平台返回为准）');

  const suOff = CH.setupOf('official');
  t.eq(suOff.authUrl, '', '自有渠道无第三方授权地址');
  t.ok(suOff.sign.indexOf('HMAC-SHA256') !== -1, '自有渠道用 HMAC-SHA256 校验来源');

  /* ------------------------------------------------------------ 凭证校验 */

  t.suite('channels · 凭证格式校验');
  t.eq(CH.setupOf('nope'), null, '未知渠道没有接入定义');

  /* 演示凭证必须能通过本地校验 —— 否则向导第 1 步（填凭证 → 校验）会直接卡住 */
  t.suite('channels · 演示凭证可用性');
  let demoAllOk = true;
  const demoBad = [];
  CH.CATALOG.forEach((c) => {
    const su = CH.setupOf(c.id);
    if (!su.demo) { demoAllOk = false; demoBad.push(c.id + '(缺演示凭证)'); return; }
    const keys = su.fields.map((f) => f.k);
    const miss = keys.filter((k) => su.demo[k] == null);
    if (miss.length) { demoAllOk = false; demoBad.push(c.id + '(缺 ' + miss.join('/') + ')'); return; }
    const v = CH.validate(c.id, su.demo);
    if (!v.ok) { demoAllOk = false; demoBad.push(c.id + '(' + v.errors[0].msg + ')'); }
  });
  t.ok(demoAllOk, '8 个渠道的演示凭证都能通过本地校验' + (demoBad.length ? ' —— 问题：' + demoBad.join('; ') : ''));
  t.eq(CH.setupOf('jd').demo.appKey.length, 16, '京东演示 AppKey 是 16 位（位数写错会当场卡住）');
  t.eq(CH.setupOf('wecom').demo.aesKey.length, 43, '微信客服演示 EncodingAESKey 是 43 位');
  t.eq(CH.setupOf('douyin').demo.appKey.length, 19, '抖店演示 App Key 是 19 位');

  const empty = CH.validate('tmall', {});
  t.eq(empty.ok, false, '空表单不通过');
  t.eq(empty.errors.length, 4, '四个字段都报错');
  t.ok(empty.errors[0].msg.indexOf('8 位数字') !== -1, 'AppKey 提示具体位数');

  const okVals = {
    appKey: '28571234', appSecret: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
    shopNick: '格物旗舰店:小满', callback: 'https://cs.gewuzaojing.com/ch/tmall/callback',
  };
  t.eq(CH.validate('tmall', okVals).ok, true, '合法凭证通过校验');

  t.eq(CH.validate('tmall', Object.assign({}, okVals, { appKey: '285712' })).ok, false, 'AppKey 位数不对被拦');
  t.eq(CH.validate('tmall', Object.assign({}, okVals, { appSecret: 'short' })).ok, false, '过短的密钥被拦');
  t.eq(CH.validate('tmall', Object.assign({}, okVals, { appSecret: okVals.appKey })).ok, false, '密钥与 AppKey 相同被拦');
  t.eq(CH.validate('jd', Object.assign({}, okVals, { appKey: 'JD7x2c9a2b1e4f80', shopId: '1000001873' })).ok, true, '京东 16 位 AppKey 通过');
  t.eq(CH.validate('pdd', { clientId: '4b6c1e2d3f4a5b6c7d8e9f0a1b2c3d4e', clientSecret: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', callback: 'https://cs.gewuzaojing.com/cb' }).ok, true, '拼多多 32 位十六进制 client_id 通过');

  /* 回调地址：各平台文档的硬性约束，逐条守 */
  t.suite('channels · 回调地址的真实约束');
  const U = (u) => CH._urlError(u, suTmall.callbackBan);
  t.ok(U('http://cs.gewu.com/cb').indexOf('HTTPS') !== -1, 'http 被拦（平台要求 HTTPS）');
  t.ok(U('https://127.0.0.1:8080/cb').indexOf('回环') !== -1, '127.0.0.1 被拦');
  t.ok(U('https://localhost/cb').indexOf('回环') !== -1, 'localhost 被拦');
  t.ok(U('https://192.168.1.10/cb').indexOf('内网') !== -1, '内网地址被拦');
  t.ok(U('https://cs.taobao.com/cb').indexOf('平台自家域名') !== -1, '淘宝自家域名被拦（文档明确）');
  t.ok(U('https://cs.tmall.com/cb').indexOf('平台自家域名') !== -1, '天猫子域同属被拦');
  t.ok(U('https://cs.gewu.com').indexOf('路径') !== -1, '缺路径被拦');
  t.ok(U('https://cs').indexOf('完整域名') !== -1, '无顶级域被拦');
  t.eq(U('https://cs.gewuzaojing.com/ch/tmall/callback'), '', '合规地址放行');
  t.eq(CH._urlError('https://cs.gewu.com/cb', []), '', '无禁用域名单的渠道不误伤');

  t.suite('channels · 微信客服的硬格式');
  const wxBase = {
    corpId: 'ww0123456789abcdef', secret: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
    token: 'gewu2026kf', callback: 'https://cs.gewuzaojing.com/ch/wecom/callback',
  };
  const wxErr = (over) => CH.validate('wecom', Object.assign({}, wxBase, over));
  t.eq(wxErr({ aesKey: 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v' }).ok, true, '43 位 EncodingAESKey 通过');
  t.ok(wxErr({ aesKey: 'x'.repeat(42) }).errors.some((e) => e.k === 'aesKey'), '42 位被拦（文档要求恰好 43 位）');
  t.ok(wxErr({ aesKey: 'x'.repeat(44) }).errors.some((e) => e.k === 'aesKey'), '44 位被拦');
  t.ok(wxErr({ token: 'x'.repeat(33) }).errors.some((e) => e.k === 'token'), 'Token 超 32 位被拦');
  t.ok(wxErr({ token: 'has space' }).errors.some((e) => e.k === 'token'), 'Token 含空格被拦');
  t.ok(wxErr({ corpId: 'ww123' }).errors.some((e) => e.k === 'corpId'), 'corpId 格式不对被拦');

  /* ------------------------------------------------------------ 连通性探活 */

  t.suite('channels · 连通性探活');
  const bad = await CH.probe('tmall', {
    appKey: '12345678', appSecret: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
    shopNick: 'x', callback: 'https://example.com/cb',
  });
  t.eq(bad.ok, false, '示例值 + 占位域名 → 探活失败');
  t.eq(bad.failed, '回调地址可达性探测', '第一处失败是回调地址');
  t.ok(bad.steps[0].detail.indexOf('404') !== -1, '回调地址说明里带真实 HTTP 状态');
  t.ok(bad.steps[1].detail.indexOf('Invalid app key') !== -1, '凭证失败给出平台错误码');
  t.ok(bad.steps[1].detail.indexOf('open.taobao.com') !== -1, '凭证失败指出去哪申请');

  const good = await CH.probe('tmall', okVals);
  t.eq(good.ok, true, '合法凭证 + 真实域名 → 探活通过');
  t.eq(good.steps.length, 3, '天猫探活 3 项（回调 / 凭证 / 权限）');
  t.ok(/\+08:00|\+0\d:00/.test(good.steps[1].detail), '凭证校验带本地时区时间戳');

  const wxProbe = await CH.probe('wecom', Object.assign({}, wxBase, { aesKey: 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v' }));
  t.eq(wxProbe.ok, true, '微信客服探活通过');
  t.eq(wxProbe.steps.length, 4, '微信客服多一步 URL 握手');
  t.ok(wxProbe.steps[1].label.indexOf('握手') !== -1, '握手步骤显式列出');
  const wxProbeBad = await CH.probe('wecom', Object.assign({}, wxBase, { aesKey: 'A'.repeat(43) }));
  t.eq(wxProbeBad.ok, false, '退化 aesKey（全同一字符）握手失败');

  /* ------------------------------------------------------------ OAuth 授权 */

  t.suite('channels · OAuth 授权链路');
  const state = CH.newState({ state: 'st-test-0001' });
  t.eq(state, 'st-test-0001', 'state 可注入（测试确定性）');
  t.eq(CH.newState().length, 32, '默认 state 32 位（防 CSRF）');
  t.ok(CH.newState() !== CH.newState(), '两次生成的 state 不同');

  const au = CH.authUrl('tmall', okVals, state);
  t.ok(au.indexOf('client_id=28571234') !== -1, '授权 URL 带上 AppKey');
  t.ok(au.indexOf('state=st-test-0001') !== -1, '授权 URL 带上 state');
  t.ok(au.indexOf(encodeURIComponent(okVals.callback)) !== -1, '授权 URL 带上回调地址');
  t.eq(CH.authUrl('official', {}, state), '', '自有渠道没有授权 URL');

  const cb = CH.mockCallback('tmall', okVals, state);
  t.ok(cb.url.indexOf('code=') !== -1 && cb.url.indexOf('state=') !== -1, '模拟回调带回 code 与 state');
  t.eq(CH.parseCode(cb.url).code, cb.code, '能从回调 URL 里解出 code');
  t.eq(CH.parseCode(cb.url).state, state, '能从回调 URL 里解出 state');
  t.eq(CH.parseCode('raw-code-123').code, 'raw-code-123', '裸 code 也能解析');

  const ex1 = CH.exchange('tmall', okVals, '', state);
  t.eq(ex1.ok, false, '空输入被拒');
  const ex2 = CH.exchange('tmall', okVals, 'x'.repeat(32), state);
  t.eq(ex2.ok, false, '只给裸 code 被拒（缺 state 无法校验 CSRF）');
  t.ok(ex2.error.indexOf('state') !== -1, '错误信息说明缺 state');
  const ex3 = CH.exchange('tmall', okVals, cb.url.replace(state, 'st-forged'), state);
  t.eq(ex3.ok, false, 'state 被篡改被拒');
  t.ok(ex3.error.indexOf('CSRF') !== -1, '明确指出 CSRF 防护');
  const ex4 = CH.exchange('tmall', okVals, cb.url, state);
  t.eq(ex4.ok, true, '完整回调换 token 成功');
  t.eq(ex4.token.renewMode, 'refresh_token', '淘宝用 refresh_token 续期');
  t.eq(ex4.token.expiresIn, 365 * 24 * 3600, '淘宝 token 有效期 1 年');
  t.ok(/\*/.test(ex4.token.masked), 'token 以打码形式返回');
  const ex5 = CH.exchange('tmall', okVals, cb.url, state);
  t.eq(ex5.ok, false, '同一 code 二次消费被拒');
  t.ok(ex5.error.indexOf('只能消费一次') !== -1, '说明授权码一次性');
  const exWx = CH.exchange('wecom', Object.assign({}, wxBase, { aesKey: 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v' }),
    CH.mockCallback('wecom', wxBase, state).url, state);
  t.eq(exWx.token.renewMode, 'gettoken', '微信客服靠 gettoken 重新获取，不走 refresh_token');
  const exOff = CH.exchange('official', {}, 'anything');
  t.eq(exOff.ok, false, '自有渠道没有 token 交换环节');

  /* ------------------------------------------------------------ 提交接入 */

  t.suite('channels · 提交接入（要凭证才能落库）');
  CH.disconnect('taobao');
  const c1 = CH.commit('taobao', { values: okVals });
  t.eq(c1.ok, false, '没有换到 token 不允许接入');
  t.ok(c1.reason.indexOf('店铺授权') !== -1, '提示还差店铺授权');
  const c2 = CH.commit('taobao', { values: {} , token: ex4.token });
  t.eq(c2.ok, false, '凭证为空不允许接入');
  const c3 = CH.commit('taobao', { values: okVals, token: ex4.token });
  t.eq(c3.ok, true, '凭证 + token 齐备才允许接入');
  t.eq(CH.isLinked('taobao'), true, '接入后进入已接入列表');
  t.eq(CH.commit('taobao', { values: okVals, token: ex4.token }).ok, false, '重复接入被拒');
  t.ok(Object.keys(CH.list().filter((c) => c.id === 'taobao')[0].credentialPrint).length > 0, '凭证以打码指纹留痕');
  t.ok(!JSON.stringify(CH.list()).includes(okVals.appSecret), '完整密钥不出现在目录里');

  /* ------------------------------------------------------------ token 生命周期 */

  t.suite('channels · token 生命周期与续期');
  const byId = (id) => CH.list().filter((c) => c.id === id)[0];
  t.eq(byId('jd').tokenState, 'expired', '京东 token 已过期');
  t.eq(byId('jd').broken, true, '过期渠道标记为已中断');
  t.eq(byId('jd').today, 0, '中断渠道今日消息为 0（不再汇入）');
  t.ok(byId('jd').tokenLabel.indexOf('已中断') !== -1, '状态文案说明消息已中断');
  t.eq(byId('tmall').tokenState, 'ok', '天猫 token 健康');
  t.eq(byId('douyin').tokenState, 'soon', '抖店 token 临期（3 天内）');
  t.eq(byId('official').tokenState, 'longterm', '自有渠道无 token，长期有效');
  t.eq(byId('tmall').tokenAction, '', '健康渠道不给续期按钮');
  t.eq(byId('douyin').tokenAction, '续期', '临期渠道给续期入口');
  t.eq(byId('jd').tokenAction, '重新授权', '过期渠道只能重新授权');

  const rJd = CH.renew('jd');
  t.eq(rJd.ok, false, 'refresh_token 失效时续期失败');
  t.ok(rJd.reason.indexOf('重新走一遍店铺授权') !== -1, '说明必须重新授权');
  const rDy = CH.renew('douyin');
  t.eq(rDy.ok, true, '抖店可正常续期');
  t.eq(rDy.tokenState.code, 'ok', '续期后回到健康状态');
  t.eq(rDy.mode, 'refresh_token', '续期方式为 refresh_token');
  t.eq(CH.renew('xhs').ok, false, '未接入渠道不能续期');
  t.ok(CH.log().some((l) => l.action.indexOf('续期') !== -1), '续期写进流水');

  const stHealth = CH.stats();
  t.eq(stHealth.broken, 1, '统计暴露 1 个已中断渠道');
  t.eq(stHealth.brokenNames.join(''), '京东自营', '并给出渠道名');
  t.eq(stHealth.expiring, 0, '抖音续期后不再是临期');
  t.eq(stHealth.todayMessages, 28, '今日消息只统计仍在有效期的渠道（京东中断后不计）');

  /* ------------------------------------------------------------ 统计与合并 */

  t.suite('channels · 统计口径');
  CH.demo();
  const st = CH.stats();
  t.eq(st.total, 8, '渠道总数');
  t.eq(st.connected, 4, '已接入数');
  t.eq(st.available, 4, '待接入数');
  t.eq(st.connected + st.available, st.total, '已接入 + 待接入 = 总数');
  t.eq(st.todayMessages, 28, '今日跨渠道消息只算有效渠道（京东授权过期不计入）');
  t.eq(st.mergedUsers, 4, '四个客户都有跨渠道痕迹');
  t.eq(st.broken, 1, '演示数据里仍有一个中断渠道');

  /* 冷启动态：一个渠道都没接，就不该报出「合并了 N 个用户」——
     指标与列表必须同时为空，否则界面会自相矛盾。 */
  CH.reset();
  const coldStats = CH.stats();
  t.eq(coldStats.mergedUsers, 0, '0 个渠道已接入时合并用户数为 0');
  t.eq(CH.merges().length, 0, '0 个渠道已接入时合并列表为空');
  t.eq(coldStats.gapItems, 0, '0 个渠道已接入时信息断层为 0');
  CH.demo();
  t.eq(CH.merges().length, 4, '演示态下合并列表恢复 4 人');
  t.eq(CH.merges().length, CH.stats().mergedUsers, '指标口径与列表口径一致');

  t.suite('channels · 跨渠道用户合并');
  const merges = CH.mergeAll();
  t.eq(merges.length, 4, '合并出四位用户');
  const zhou = merges.filter((m) => m.name === '周雨桐')[0];
  t.ok(!!zhou, '能找到周雨桐');
  t.eq(zhou.channelCount, 2, '周雨桐横跨两个渠道');
  t.eq(zhou.timeline.length, 3, '三条痕迹');
  t.ok(zhou.timeline[0].at <= zhou.timeline[2].at, '时间线按时间升序');
  t.ok(zhou.keys.length > 0, '带出合并身份键（手机号 / 订单号）');
  t.eq(zhou.gaps, 0, '小红书未接入 → 算盲区而非断层');
  t.eq(zhou.dark, 1, '一条痕迹落在未接入渠道');
  const su2 = merges.filter((m) => m.name === '苏晚晴')[0];
  t.eq(su2.gaps, 1, '苏晚晴有一处真断层（天猫已接入却看不到）');
  t.eq(st.gapItems, 1, '全局断层数与明细一致');

  t.suite('channels · 盲区估算');
  const bs = CH.blindSpots();
  t.eq(bs.length, 4, '四个未接入渠道都给出盲区估算');
  t.ok(bs.every((b) => b.estimate > 0 && b.usersEstimate >= 1), '每项都有消息量与人数估算');

  /* ------------------------------------------------------------ 状态机与边界 */

  t.suite('channels · 接入状态机');
  const before = CH.stats().connected;
  t.eq(CH.disconnect('jd'), true, '断开已接入渠道返回 true');
  t.eq(CH.stats().connected, before - 1, '断开后已接入数 -1');
  t.eq(CH.isLinked('jd'), false, 'jd 已不在接入列表');
  t.eq(CH.disconnect('jd'), false, '重复断开返回 false');
  t.ok(CH.log().length > 0, '断开动作写进流水');
  CH.demo();
  t.eq(CH.stats().connected, 4, 'demo() 重新装载回 4 个');
  t.eq(CH.isLinked('jd'), true, 'demo() 后 jd 恢复接入');
  t.eq(CH.stats().broken, 1, '演示数据里的授权过期状态也一并恢复');
  t.eq(CH.isDemo(), true, 'demo() 会置位演示态标记');

  t.suite('channels · 边界');
  t.eq(CH.byId('nope'), null, '未知渠道 id 返回 null');
  t.eq(CH.isLinked('taobao'), false, '淘宝未接入，不能续期也不能读取');
  const emptyM = CH.merge({ name: '查无此人' });
  t.eq(emptyM.timeline.length, 0, '无痕迹用户返回空时间线');
  t.eq(emptyM.gaps, 0, '空时间线断层为 0');
  t.eq(CH.channelTally([]).length, 0, '空足迹的渠道路径为空');
  t.eq(CH.channelTally(CH.FOOTPRINTS['周雨桐'])[0].count, 2, '同一渠道的多条痕迹被合并计数');
  t.eq(CH.commit('nope', { values: {} }).ok, false, '未知渠道不能提交接入');
  t.eq(CH.exchange('nope', {}, 'x').ok, false, '未知渠道不能换 token');
  t.eq(CH.renew('nope').ok, false, '未知渠道不能续期');
  t.eq((await CH.probe('nope', {})).ok, false, '未知渠道探活返回失败而不是抛异常');
};
