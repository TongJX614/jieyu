/* ==========================================================================
   话术效果回执（tests/effect.test.js）

   这条链路分三段，每段要证的东西不一样，所以断言也分三组：

     ① `server/effect-stats.js` 的算术 —— 纯函数，最容易也最该钉死：
        均值的分母到底是谁、嫌疑记录算不算进回落率、上限淘汰了要能看见。
        这些一旦算错，界面上那个「风险回落 58%」就是编的，而没人能看出来。
     ② 同源闸门的真 HTTP 语义 —— 鉴权、必填、字段白名单、频控、盖章。
        `sanitize()` 在服务端算的是**第二层**（第一层在前端只组结构化字段），
        两层都得有人证：前端那一层由 `tests/browser-check.js` 的 effect-view 用
        fetch 探针抓 POST 正文来证（见那里），这里证服务端这一层。
     ③ 顾客原文永远不许落盘 —— 这是这张表存在的唯一前提。
        断言直接读磁盘上那份 JSON，不读接口返回：接口可以撒谎，文件不会。

   端口与数据目录照 `store.test.js` 的老规矩：各起各的 DATA_DIR，
   并且**核对 /api/health 报的 pid 就是本次 spawn 的子进程** —— 端口被上一轮
   遗留进程占着时，整套断言会跑在过期代码上而终端全绿（实测撞过）。
   ========================================================================== */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ES = require('../server/effect-stats.js');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.SERVER_TEST_PORT || 5399) + 20;
const BASE = 'http://127.0.0.1:' + PORT;
const DEMO_PIN = '1234';
const SEED_AGENT = 'CS013';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (r) => { try { return JSON.parse(r.text); } catch (e) { return null; } };

function requestAt(method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(BASE + p, { method, headers: headers || {} }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

async function waitHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await requestAt('GET', '/api/health');
      if (r.status === 200) return json(r);
    } catch (e) { /* 还没起来 */ }
    await sleep(120);
  }
  return null;
}

/* 落盘是异步的：POST 返回 200 只代表内存改完了。
   要断言「盘上有什么」就得等它，否则这条用例会随时序抖成假红。
   `want` 是要等到至少几条 —— 突发写那段等的是十条，写死 2 会一早就返回、把断言读成假绿。 */
async function waitDisk(dir, want, timeoutMs) {
  const f = path.join(dir, 'db.json');
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try { last = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { last = null; }
    if (last && Array.isArray(last.effect) && last.effect.length >= want) return last;
    await sleep(60);
  }
  return last || { effect: [] };
}

/* 一条结构完整的记录：默认是「发出去之后风险从高危掉到关注」这种最有用的形状 */
const rec = (over) => Object.assign({
  source: 'suggestion', kbId: '', turn: 3,
  delta: 'improved', levelBefore: 'high', levelAfter: 'medium',
  scoreBefore: 90, scoreAfter: 40, emoBefore: 80, emoAfter: 55,
  sess: 'deadbeef',
}, over || {});

const keysOf = (o) => Object.keys(o).sort().join(',');

module.exports = async function (t) {
  /* ================================================== ① 纯函数：清洗 */

  t.suite('effect · sanitize 只收结构化事实');
  const clean = ES.sanitize(rec(), { agent: 'CS013', at: '2026-10-19T08:00:00.000Z' });
  t.eq(clean.missing.length, 0, '一条完整的回执不该报任何缺失，实为 ' + clean.missing.join('/'));
  t.eq(clean.suspect, false, '等级降、分数也降 = 自洽，不是嫌疑');
  t.eq(clean.rec.agent, 'CS013', '坐席归属由服务端盖章');
  t.eq(clean.rec.at, '2026-10-19T08:00:00.000Z', '时间戳由服务端盖章');
  t.eq(clean.droppedKeys, 0, '白名单内没有多余键，不该有剥离计数');
  t.eq(keysOf(clean.rec), 'agent,at,delta,emoAfter,emoBefore,kbId,levelAfter,levelBefore,scoreAfter,scoreBefore,sess,source,suspect,turn',
    '一条记录恰好就是这些列，实为 ' + keysOf(clean.rec));

  const dirty = ES.sanitize(Object.assign(rec(), {
    text: '我用了两天脸上开始刺痛发红',
    customerMessage: '退款投诉',
    photo: 'data:image/png;base64,' + 'A'.repeat(4096),
    agent: 'HACKER', at: '1999-01-01T00:00:00.000Z', phone: '13800000000',
    consent: true, id: 'ef-forged',
  }), { agent: 'CS013', at: '2026-10-19T08:01:00.000Z' });
  t.ok(dirty.droppedKeys >= 7, '白名单之外的一律剥离并计数，实为 ' + dirty.droppedKeys);
  t.eq(dirty.rec.agent, 'CS013', '客户端自称是谁不算数：盖章的是令牌里的工号');
  t.eq(dirty.rec.at, '2026-10-19T08:01:00.000Z', '伪造时间戳被盖掉');
  t.eq('id' in dirty.rec, false, '客户端自造的 id 不进记录（id 由服务端发）');
  t.eq(JSON.stringify(dirty.rec).indexOf('刺痛'), -1, '顾客原文没跟着任何字段混进来');
  t.eq(JSON.stringify(dirty.rec).indexOf('13800000000'), -1, '手机号没混进来');
  t.eq(JSON.stringify(dirty.rec).indexOf('base64'), -1, '图片没混进来');
  t.eq('consent' in dirty.rec, false, '授权位不属于这张表（它是照片那条链路的账）');

  const bad = ES.sanitize({ source: 'sms', delta: 'maybe', levelBefore: 'HIGH', levelAfter: 'ok', turn: -2 }, {});
  t.includes(bad.missing.join(','), 'source', '来源不在三种之内要报出来');
  t.includes(bad.missing.join(','), 'delta', 'delta 不认识要报出来');
  t.includes(bad.missing.join(','), 'levelBefore', '等级写成大写要报出来（尺子只认小写枚举）');
  t.includes(bad.missing.join(','), 'levelAfter', '等级写成 ok 同样要报出来');
  t.includes(bad.missing.join(','), 'turn', '轮号是负数要报出来');
  t.eq(ES.REQUIRED.filter((k) => bad.missing.indexOf(k) >= 0).length, 5, 'REQUIRED 五条全缺 —— 这条必被拒收');

  const emptyish = ES.sanitize(null, {});
  t.eq(emptyish.missing.length, 7, '请求体不是对象时不抛异常，且七格必填位都报缺失，实为 ' + emptyish.missing.join('/'));
  t.eq(keysOf(emptyish.rec), 'agent,at,emoAfter,emoBefore,kbId,sess,suspect',
    '缺失的格子干脆不入库，而不是补一个假值：' + keysOf(emptyish.rec));
  /* 情绪指数的「没有」有两种，只有一种算缺失：
     null / undefined / 空串 = 模型这轮没给读数，那是允许的正常态，收下来是 null；
     给了值却不像数字 = 上报端坏了，记缺失（但依旧不构成拒收）。 */
  const emoNull = ES.sanitize(rec({ emoBefore: null, emoAfter: undefined }), {});
  t.eq(emoNull.rec.emoBefore, null, '情绪读数允许是 null（模型那一轮没给指数）');
  t.eq(emoNull.rec.emoAfter, null, '键压根没给同样落成 null，不报缺失');
  t.eq(emoNull.missing.length, 0, '「没给情绪读数」不该记成缺失 —— 否则每一次模型路径都在喊缺字段');
  const emoJunk = ES.sanitize(rec({ emoAfter: 'very unhappy' }), {});
  t.includes(emoJunk.missing.join(','), 'emoAfter', '给了但不像数字才记为缺失');
  t.eq(ES.REQUIRED.filter((k) => emoJunk.missing.indexOf(k) >= 0).length, 0, '缺情绪指数不构成拒收');
  const clamped = ES.sanitize(rec({ scoreBefore: 99999, scoreAfter: -50, emoBefore: 400 }), {});
  t.eq(clamped.rec.scoreBefore, 400, '分数越界先夹住再入库（400 是这份模块给阈值抬高留的余量）');
  t.eq(clamped.rec.scoreAfter, 0, '负分夹到 0');
  t.eq(clamped.rec.emoBefore, 100, '情绪指数是 0..100 的整数，不是 -1..1');

  const susUp = ES.sanitize(rec({ delta: 'improved', scoreBefore: 10, scoreAfter: 80 }), {});
  t.eq(susUp.suspect, true, '嘴上说降了而分数涨回去 = 嫌疑记录');
  const susDown = ES.sanitize(rec({ delta: 'worse', scoreBefore: 80, scoreAfter: 10 }), {});
  t.eq(susDown.suspect, true, '反向自相矛盾同样算嫌疑');
  t.eq(ES.sanitize(rec({ kbId: 'kb-ALLERGY-1', sess: 'DEADBEEF' }), {}).rec.kbId, 'kb-ALLERGY-1',
    'id 形状合格就原样收 —— 大小写归一是发号那一侧的事，这里改了就会跟库里的真 id 对不上');
  t.eq(ES.sanitize(rec({ kbId: 'kb-ALLERGY-1', sess: 'DEADBEEF' }), {}).rec.sess, 'deadbeef',
    '指纹统一小写（它将来要当分组键）');
  t.eq(ES.sanitize(rec({ kbId: '../../db.json', sess: 'zz' }), {}).rec.kbId, '', '不像 id 的一律置空而不是照收');
  t.eq(ES.sanitize(rec({ kbId: '../../db.json', sess: 'zz' }), {}).rec.sess, '', '会话指纹要 8 位十六进制');

  /* ================================================== ① 纯函数：上限与算术 */

  t.suite('effect · 环形上限淘汰可见');
  const ring = [];
  for (let i = 0; i < 5; i++) ring.push(rec({ turn: i }));
  t.eq(ES.pushRecord(ring, rec({ turn: 5 }), 6), 0, '没挤到上限时淘汰 0 条');
  t.eq(ES.pushRecord(ring, rec({ turn: 6 }), 6), 1, '第 7 条把最老那条挤出去，而且要报出来');
  t.eq(ring.length, 6, '表长停在上限');
  t.eq(ring[0].turn, 1, '被淘汰的是最老的那条（turn 0 已经不在了）');
  t.eq(ES.pushRecord(ring, rec({ turn: 7 }), 0), 0, 'limit 传 0 时退回默认上限，不该把表清空的');

  t.suite('effect · aggregate 的分母到底是谁');
  const rows = [
    rec({ source: 'suggestion', delta: 'improved', scoreBefore: 90, scoreAfter: 40, emoBefore: 80, emoAfter: 55 }),
    rec({ source: 'kb', kbId: 'kb-1', delta: 'flat', scoreBefore: 40, scoreAfter: 40, emoBefore: 50, emoAfter: 50 }),
    rec({ source: 'kb', kbId: 'kb-1', delta: 'worse', scoreBefore: 20, scoreAfter: 70, emoBefore: 30, emoAfter: 70 }),
    rec({ source: 'care', delta: 'improved', scoreBefore: 10, scoreAfter: 80, emoBefore: null, emoAfter: null, suspect: true }),
  ];
  const ag = ES.aggregate(rows, { limit: 1000, droppedOld: 3 });
  t.eq(ag.n, 4, '总数');
  t.eq(ag.improved, 2, '回落 2 条');
  t.eq(ag.worse, 1, '上升 1 条');
  t.eq(ag.flat, 1, '持平 1 条');
  t.eq(ag.suspect, 1, '嫌疑只数那条自相矛盾的');
  t.eq(ag.scoredN, 4, '四条都有两端分数 → 分母就是 4');
  t.eq(ag.avgScoreDelta, 70 / 4, '均分 = (-50+0+50+70)/4 = 17.5，实为 ' + ag.avgScoreDelta);
  t.eq(ag.improveRate, 50, '回落率的分母是「两个分数都齐的条数」，不是「库里所有条数」');
  t.eq(ag.avgEmoDelta, 5, '情绪均值只按「两端读数都在」的三条算：(-25+0+40)/3 = 5，实为 ' + ag.avgEmoDelta);
  t.eq(ag.bySource.kb.n, 2, '按来源分桶：kb 两条');
  t.eq(ag.bySource.suggestion.improved, 1, '按来源分桶各算各的回落');
  t.eq(ag.bySource.unknown, undefined, '来源合法时不该冒出 unknown 桶');
  t.eq(ag.top.length, 1, '只有带 kbId 的进「用得最多的话术」');
  t.eq(ag.top[0].kbId, 'kb-1', '那条就是 kb-1');
  t.eq(ag.top[0].n, 2, '它被用了 2 次');
  t.eq(ag.top[0].avgScoreDelta, 25, '本条均分 (0+50)/2 = 25');
  t.eq(ag.kept, 4, 'kept 报的是传进来的条数');
  t.eq(ag.limit, 1000, '上限自述');
  t.eq(ag.droppedOld, 3, '淘汰条数由调用方交进来，聚合原样透出来（不藏）');
  t.eq(typeof ag.since, 'string', '没有 at 时 since 是空串而不是 undefined');

  const missingScore = ES.aggregate([rec({ scoreBefore: undefined, scoreAfter: undefined })], {});
  t.eq(missingScore.n, 1, '一条没有分数的记录照样计数');
  t.eq(missingScore.scoredN, 0, '但不进均分分母');
  t.eq(missingScore.avgScoreDelta, null, '没有可比对的就报 null，不许报 0（0 会被读成「没变化」）');
  t.eq(missingScore.improveRate, null, '回落率在没有任何可比对样本时是 null');
  t.eq(ES.aggregate([], {}).n, 0, '空表聚合成 0 条，不抛');
  t.eq(ES.aggregate(null).n, 0, '传 null 也不抛');
  const junkRows = ES.aggregate([null, {}, rec({ delta: 'nope' })], {});
  t.eq(junkRows.n, 2, 'null 那条压根不进计数，剩下的两条各占一格');
  t.eq(junkRows.suspect, 2, 'delta 认不出来的两条都归进嫌疑，也不污染三个正常桶（improved/worse/flat 全为 0）');
  t.eq(junkRows.improved + junkRows.worse + junkRows.flat, 0, '一个正常桶都不该加过');

  const floaty = ES.aggregate([
    rec({ scoreBefore: 1, scoreAfter: 2, emoBefore: 10, emoAfter: 20.3 }),
    rec({ scoreBefore: 1, scoreAfter: 2, emoBefore: 10, emoAfter: 20.3 }),
    rec({ scoreBefore: 1, scoreAfter: 2, emoBefore: 10, emoAfter: 20.3 }),
  ], {});
  t.eq(String(floaty.avgEmoDelta).indexOf('000000') === -1, true,
    '浮点尾巴要在聚合这里收掉，实为 ' + floaty.avgEmoDelta);
  t.eq(String(floaty.bySource.suggestion.emoDelta).indexOf('000000') === -1, true,
    '分桶同样收口（不然接口调试页看到的还是脏的）');

  /* ================================================== ②③ 真 HTTP */

  const DIR = path.join(os.tmpdir(), 'beauty-cs-effecttest-' + process.pid);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* 新的就好 */ }
  fs.mkdirSync(DIR, { recursive: true });

  const child = spawn(process.execPath, [path.join('server', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR: DIR, DEEPSEEK_API_KEY: '', LLM_API_KEY: '',
    }),
    stdio: 'ignore',
  });

  try {
    const health = await waitHealth(12000);
    t.suite('effect · 真 HTTP：闸门顺序与落盘');
    t.ok(!!health, '服务在 12s 内起来');
    if (!health) return;
    t.eq(health.pid, child.pid, '回答我的是本次 spawn 的子进程（不是上一轮遗留的那台）');

    const noAuth = await requestAt('GET', '/api/effect');
    t.eq(noAuth.status, 401, '未登录读不到聚合');
    const noAuthPost = await requestAt('POST', '/api/effect', rec(), { 'Content-Type': 'application/json' });
    t.eq(noAuthPost.status, 401, '未登录也不许写 —— 这张表按坐席归属记账，匿名写入等于把账本涂了');

    const lr = json(await requestAt('POST', '/api/auth/login', { agentId: SEED_AGENT, pin: DEMO_PIN }));
    const tok = lr && lr.token ? lr.token : '';
    t.ok(!!tok, '种子工号登录成功');
    if (!tok) return;
    const auth = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' };

    /* 405 这条排在登录之后：闸门的顺序是「先认人再认方法」，
       拿匿名 PUT 去断言 405 只会得到 401 —— 那不是 bug，是设计。 */
    const badMethod = await requestAt('PUT', '/api/effect', '{}', auth);
    t.eq(badMethod.status, 405, '这张口只认 GET / POST，别的方法明说 405，不许静默当成 GET');

    const empty0 = json(await requestAt('GET', '/api/effect', null, auth));
    t.eq(empty0.stats.n, 0, '新数据目录里一条回执都没有');
    t.eq(empty0.stats.improveRate, null, '没有样本时回落率是 null，不是 0%');

    const okPost = await requestAt('POST', '/api/effect', rec(), auth);
    t.eq(okPost.status, 200, '一条完整回执被收下');
    const okJson = json(okPost);
    t.eq(okJson.n, 1, '响应报回库里现在有几条');
    t.eq(okJson.suspect, false, '这条自洽，不该被标嫌疑');

    const incomplete = await requestAt('POST', '/api/effect', { source: 'kb', turn: 2 }, auth);
    t.eq(incomplete.status, 400, '缺 REQUIRED 的一律拒收，不存半截记录');
    const incJson = json(incomplete);
    t.eq(incJson.missing.indexOf('delta') >= 0, true, '400 里要点名缺了哪一格，坐席才知道改什么');
    t.eq(incJson.missing.indexOf('levelBefore') >= 0, true, '等级两端都缺，两条都要报');

    const notJson = await requestAt('POST', '/api/effect', '这不是 JSON{{{', auth);
    t.eq(notJson.status, 400, '请求体不是合法 JSON 时 400，而不是让进程抛穿');

    /* 第二条故意做成「风险升上去」：两个桶都要在真 HTTP 这条路上被走到，
       否则聚合只验了一半（库里两条全 improves 时，worse 桶算错了也看不出来）。
       分数跟着往上（100→130）所以它自洽，不该被标成嫌疑。 */
    const junk = await requestAt('POST', '/api/effect', rec({
      delta: 'worse', levelBefore: 'medium', levelAfter: 'high', scoreBefore: 100, scoreAfter: 130,
      text: '我脸烂了要投诉到市场监管局',
    }), auth);
    t.eq(junk.status, 200, '多余字段不构成拒收（前端已经只组结构化字段，这里是第二层）');
    const junkJson = json(junk);
    t.eq(junkJson.n, 2, '库里两条：一条完整 + 一条带脏字段');

    const disk = await waitDisk(DIR, 2, 8000);
    const diskRaw = JSON.stringify(disk);
    t.eq(Array.isArray(disk.effect), true, 'effect 这张表在盘上存在（批次 G 的合并认它）');
    t.eq(disk.effect.length, 2, '盘上就是两条，不多不少');
    t.eq(diskRaw.indexOf('我脸烂了'), -1, '顾客原文没有落盘 —— 这条表存在的前提');
    t.eq(diskRaw.indexOf('投诉到市场监管局'), -1, '脏字段整串都没落盘');
    t.eq(keysOf(disk.effect[0]), 'agent,at,delta,emoAfter,emoBefore,id,kbId,levelAfter,levelBefore,scoreAfter,scoreBefore,sess,source,suspect,turn',
      '入库的列就是白名单那一组，实为 ' + keysOf(disk.effect[0]));
    t.eq(disk.effect[0].agent, SEED_AGENT, '落盘那条的归属是令牌里的工号，不是客户端自报');
    t.eq(/^ef-/.test(disk.effect[0].id), true, 'id 由服务端发');

    const agg = json(await requestAt('GET', '/api/effect', null, auth)).stats;
    t.eq(agg.n, 2, '聚合读到两条');
    t.eq(agg.improved, 1, '一条回落');
    t.eq(agg.worse, 1, '一条上升（就是那条带脏字段的）');
    t.eq(agg.suspect, 0, '两条都自洽：说升分数也升、说降分数也降');
    t.eq(agg.avgScoreDelta, ((40 - 90) + (130 - 100)) / 2, '均分由库里那两条算出来，实为 ' + agg.avgScoreDelta);
    t.eq(agg.scoredN, 2, '两条都有分数');
    t.eq(agg.improveRate, 50, '回落率 1/2 = 50%');

    const hb = json(await requestAt('GET', '/api/health'));
    t.eq(typeof hb.effect, 'object', 'health 自述 effect 这一格');
    t.eq(hb.effect.accepted, 2, 'accepted 记了两次成功入库');
    t.eq(hb.effect.rejected, 2, 'rejected 记两次：必填缺失 + 请求体不是合法 JSON（实为 ' + hb.effect.rejected + '）');
    t.ok(hb.effect.stripped >= 1, 'strip 掉白名单外的键要能看见，实为 ' + hb.effect.stripped);
    t.eq(hb.effect.kept, 2, 'kept 与库里条数一致');
    t.eq(hb.effect.limit, ES.LIMIT, '上限自述与模块里的常量同源');
    /* 这四格是批次 H 那个丢记录 bug 的哨兵：单进程从头到尾没有任何人删过东西，
       所以「收下对方」和「尊重删除」都必须是 0。老写法（写完盘再从**内存**抓 base）
       会把落在 writeFile/rename 那两个 await 之间的新记录记进祖先里，
       下一次合并就把它读成「对方删掉了它」——实测稳定报 honoredDelete 1、少一条记录。 */
    t.eq(hb.store.honoredDeletes, 0, '单进程写回执期间「尊重删除」必须是 0：这里没人删过任何东西');
    t.eq(hb.store.keptFromDisk, 0, '单进程不可能从盘上收下别人的记录（收到了就说明读的那份不是自己写的）');
    t.eq(hb.store.errors, 0, '写盘错误计数为 0');
    t.eq(hb.store.stalled, false, '此刻不欠落盘');

    /* 突发写：上面两条 SENTINEL 只在「记录恰好落在那次写的两个 await 之间」时才有信息量，
       而单条顺序写撞不撞得到全看启动那次落盘的运气（我先跑过：两轮里一轮红一轮绿）。
       这里不赌交错 —— 十条一起发出去，落盘的循环必然有几次是在内存已经变了的情况下收尾的。
       判据看总数：accepted、health 自述的 kept、盘上条数三者必须一起涨到同一个数，
       而 honoredDeletes 仍然是 0（单进程从头到尾没人删过东西，它一旦非 0，
       就说明 base 里躺着一条盘上从没见过的 id —— 批次 H 那个丢记录 bug 的形状）。 */
    const BURST = 10;
    const TOTAL = 2 + BURST;
    const responses = await Promise.all(
      Array.from({ length: BURST }, (_, i) => requestAt('POST', '/api/effect', rec({ turn: 20 + i }), auth))
    );
    t.ok(responses.every((r) => r.status === 200), '十条并发回执全部 200（实为 ' +
      responses.filter((r) => r.status === 200).length + ' 条）');
    const diskB = await waitDisk(DIR, TOTAL, 10000);
    t.eq(diskB.effect.length, TOTAL, '盘上一条都没被盖掉，实为 ' + diskB.effect.length + ' / 应为 ' + TOTAL);
    t.eq(new Set(diskB.effect.map((r) => r.id)).size, TOTAL, '盘上 id 不重复（并发写没发出同一个号）');
    const hbB = json(await requestAt('GET', '/api/health'));
    t.eq(hbB.effect.accepted, TOTAL, 'accepted 涨到了 ' + TOTAL + '，实为 ' + hbB.effect.accepted);
    t.eq(hbB.effect.kept, TOTAL, 'health 自述的库内条数与盘上一致（少了就是内存也被合并抹掉过）');
    t.eq(hbB.store.honoredDeletes, 0, '突发写之后「尊重删除」依然是 0');
    t.eq(hbB.store.errors, 0, '突发写没有把任何一次落盘写失败');
    t.eq(hbB.store.stalled, false, '突发写之后不欠落盘');
    const aggB = json(await requestAt('GET', '/api/effect', null, auth)).stats;
    t.eq(aggB.n, TOTAL, '聚合读到的条数与盘上相等（读的是同一份事实）');

    /* 频控：这条口花的是坐席自己的会话，窗口打满之后必须挡住。
       放在最后 —— 打满之后同一台服务在 60s 内的任何 effect 请求都会 429，
       先跑它会把上面的断言全带沟里。这里用「缺字段的 400」去填窗口：
       闸门在解析之前，所以 400 照样消耗额度，而它一次盘都不写，121 次很快。
       额度已经被前面十二条用掉一点，所以这里数的是「本轮之内出现 429」，不是第 121 次。 */
    let got429 = 0, got400 = 0;
    for (let i = 0; i < 130; i++) {
      const r = await requestAt('POST', '/api/effect', { source: 'kb' }, auth);
      if (r.status === 429) got429++;
      else if (r.status === 400) got400++;
    }
    t.ok(got429 > 0, '窗口打满之后开始 429，实为 ' + got429 + ' 次');
    t.ok(got400 > 0, '429 之前先是一串 400（说明额度是逐个消耗掉的，不是随机拒绝）');
    const hb2 = json(await requestAt('GET', '/api/health'));
    t.eq(hb2.effect.accepted, TOTAL, '频控之后 accepted 没有偷偷涨：库里还是那 ' + TOTAL + ' 条');
    const disk2 = await waitDisk(DIR, TOTAL, 1500);
    t.eq(disk2.effect.length, TOTAL, '被拒的那一百多次一个字节都没落盘');
  } finally {
    try { child.kill(); } catch (e) { /* 已经死了 */ }
    await sleep(300);
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* 留给系统清 */ }
  }
};
