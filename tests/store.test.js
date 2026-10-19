/* ==========================================================================
   db.json 跨进程合并（tests/store.test.js）

   为什么单独成一个套件，而不是塞进 server.test.js：
     `server.test.js` 里每台被 spawn 的服务都**故意**各用各的 DATA_DIR（测试不许碰真档案）。
     而这条缺陷恰恰只在「两台共用同一个文件」时才存在 —— 那个共享目录必须在这里造。
     两种隔离目标不一样，混在一个文件里迟早会互相「顺手」改掉。

   集成部分**不靠撞运气**：不用 Promise.all 赌交错真的发生了，
   而是把顺序钉死 —— A 写完并确认落盘 → 再让 B 写。
   这样 B 那次读盘必然看见 A 的记录，而那记录不在 B 的 base 里，
   「别人新建」这条分支是**必然走到**的，不是偶尔走到。
   （原来那次「两台并发 POST」的写法我先跑过：它会绿，但绿得没有信息量 ——
     两次写完全可能一先一后错开，合并按钮压根没被按到。）
   ========================================================================== */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const Store = require('../server/store-merge.js');

const ROOT = path.resolve(__dirname, '..');
const BASE_PORT = Number(process.env.SERVER_TEST_PORT || 5399);
const PORT_A = BASE_PORT + 10;
const PORT_B = BASE_PORT + 11;
const URL_A = 'http://127.0.0.1:' + PORT_A;
const URL_B = 'http://127.0.0.1:' + PORT_B;
const DEMO_PIN = '1234';
const SEED_AGENT = 'CS013';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (r) => { try { return JSON.parse(r.text); } catch (e) { return null; } };

function requestAt(base, method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(base + p, { method, headers: headers || {} }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
    });
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

async function waitHealth(timeoutMs, base) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await requestAt(base, 'GET', '/api/health');
      if (r.status === 200) return json(r);
    } catch (e) { /* 还没起来 */ }
    await sleep(120);
  }
  return null;
}

/* 磁盘上那份文件才是两台实例**共同承认**的事实，所以断言一律读文件，
   不读某一台的内存 —— 读某一台的内存会漏掉「它自己不知道、但确实被写坏了」的情况。 */
function readDisk(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')); } catch (e) { return null; }
}

async function waitDiskHas(dir, pred, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 8000);
  let last = null;
  while (Date.now() < deadline) {
    last = readDisk(dir);
    if (last && pred(last)) return last;
    await sleep(60);
  }
  return null;
}

const idsOf = (db, key) => (Array.isArray(db && db[key]) ? db[key].map((x) => x.id) : []);
const has = (list, id) => list.indexOf(id) !== -1;

module.exports = async function (t) {
  /* ================================================== 纯函数语义 */

  t.suite('store · 三方合并的四种情形');
  const A1 = { id: 'CS013', name: '佟佳鑫', status: 'online' };
  const K1 = { id: 'kb-1', text: '老话术', at: '2026-10-01T00:00:00.000Z' };
  const K2 = { id: 'kb-2', text: 'A 建的', at: '2026-10-02T00:00:00.000Z' };
  const K3 = { id: 'kb-3', text: 'B 建的', at: '2026-10-02T00:00:00.001Z' };
  const base = { agents: [A1], kb: [K1], nextKb: 5 };

  /* 真实交错：两边都从 nextKb=5 起步，各建一条，各自落盘一次。
     B 落盘时 disk 上是 A 的结果。 */
  const both = Store.mergeSnapshots({
    disk: { agents: [A1], kb: [K2, K1], nextKb: 6 },
    ours: { agents: [A1], kb: [K3, K1], nextKb: 6 },
    base,
  });
  t.eq(has(idsOf(both.db, 'kb'), 'kb-2'), true, 'A 新建的那条被 B 收下（原来就是这条被整份覆盖掉）');
  t.eq(has(idsOf(both.db, 'kb'), 'kb-3'), true, 'B 自己新建的那条没丢');
  t.eq(has(idsOf(both.db, 'kb'), 'kb-1'), true, '两边都没动的老记录还在');
  t.eq(both.stats.keptFromDisk, 1, '「别人新建」恰好记了一次，不是蒙对的');
  t.eq(idsOf(both.db, 'kb').length, 3, '合并结果不多不少三条');

  const mine = Store.mergeSnapshots({ disk: { agents: [A1], kb: [K1], nextKb: 5 }, ours: { agents: [A1], kb: [], nextKb: 5 }, base });
  t.eq(mine.db.kb.length, 0, '我删的不会被盘上那份新鲜的复活');
  t.eq(mine.stats.honoredDelete, 1, '「我删的」这一分支记的是 honor，不是 keep');

  const theirs = Store.mergeSnapshots({ disk: { agents: [A1], kb: [], nextKb: 5 }, ours: { agents: [A1], kb: [K1], nextKb: 5 }, base });
  t.eq(theirs.db.kb.length, 0, '对方删的同样不复活（这条方向反了就会变成僵尸记录）');

  const fresh = Store.mergeSnapshots({ disk: { agents: [A1], kb: [K2], nextKb: 9 }, ours: { agents: [A1], kb: [], nextKb: 1 }, base: null });
  t.eq(has(idsOf(fresh.db, 'kb'), 'kb-2'), true, '没有 base（本进程还没落过盘）时绝不覆盖盘上已有的东西');
  t.eq(fresh.db.nextKb, 9, '发号器只许往上走：取两边的最大值');

  const back = Store.mergeSnapshots({ disk: { agents: [], kb: [], nextKb: 80 }, ours: { agents: [], kb: [], nextKb: 3 }, base: { agents: [], kb: [], nextKb: 2 } });
  t.eq(back.db.nextKb, 80, 'nextKb 被对方推到 80 时，本进程的 3 不许把它拽回去');
  t.eq(back.stats.scalarRaised, 1, '抬号这件事要记账（health 里看得见）');

  const edited = Store.mergeSnapshots({
    disk: { agents: [Object.assign({}, A1, { status: 'away', updAt: '2026-10-19T00:30:00.000Z' })], kb: [], nextKb: 5 },
    ours: { agents: [Object.assign({}, A1, { status: 'busy', updAt: '2026-10-19T01:00:00.000Z' })], kb: [], nextKb: 5 },
    base,
  });
  t.eq(edited.db.agents[0].status, 'busy', '同一条记录两边都改：时间戳新的那份赢');

  const legacy = Store.mergeSnapshots({
    disk: { agents: [A1], kb: [], nextKb: 5 },
    ours: { agents: [Object.assign({}, A1, { status: 'offline-ish' })], kb: [], nextKb: 5 },
    base,
  });
  t.eq(legacy.db.agents[0].status, 'offline-ish', '两边都没有时间戳（老库里的坐席就是这种）时，靠 base 认出「是谁改的」');

  const unkeyed = Store.mergeSnapshots({
    disk: { agents: [{ name: '没有 id 的盘上记录' }], kb: [], nextKb: 5 },
    ours: { agents: [{ name: '没有 id 的内存记录' }], kb: [], nextKb: 5 },
    base,
  });
  t.eq(unkeyed.db.agents.length, 2, '认不出 id 的记录两边都留（只留一边就等于允许整表覆盖回来）');
  t.eq(unkeyed.stats.unkeyed, 2, '没法定位的条数要能被数出来');

  const extra = Store.mergeSnapshots({ disk: { notes: '盘上独有', agents: [], kb: [], nextKb: 5 }, ours: { agents: [], kb: [], nextKb: 5 }, base });
  t.eq(extra.db.notes, '盘上独有', '以后新加一张表但忘了登记时，合并不许把它吃掉');

  const noDisk = Store.mergeSnapshots({ disk: null, ours: { agents: [A1], kb: [K1], nextKb: 5 }, base: null });
  t.eq(noDisk.db.kb.length, 1, '盘上没有文件（首次落盘）时按内存原样写，不该报错');
  t.eq(noDisk.stats.merged, false, '没有可合并对象这件事要说得出口');

  t.suite('store · 回写内存必须保住对象与数组的身份');
  const live = { agents: [Object.assign({}, A1, { status: 'online' })], kb: [], nextKb: 5 };
  const heldAgent = live.agents[0];
  const heldArr = live.agents;
  const m = Store.mergeSnapshots({
    disk: { agents: [Object.assign({}, A1, { status: 'away', updAt: '2026-10-19T02:00:00.000Z' }), { id: 'CS099', name: '对方新建' }], kb: [], nextKb: 7 },
    ours: live,
    base,
  });
  const rec = Store.reconcileInto(live, m.db);
  t.eq(live.agents, heldArr, '数组对象没被换掉（`agentOf()` 之前就取过 db.agents 的引用）');
  t.eq(live.agents[0], heldAgent, '已有记录沿用同一个对象，不是新建一个内容相同的');
  t.eq(live.agents[0].status, 'away', '字段照样更新到赢下来的那份');
  t.eq(idsOf(live, 'agents').indexOf('CS099') !== -1, true, '对方新建的坐席进了内存');
  t.eq(live.nextKb, 7, '标量也落回内存');
  t.eq(rec.reused, 1, '复用计数与新建计数分开：reused 1');
  t.eq(rec.adopted, 1, 'adopted 1（收下对方那条 CS099）');

  const orphanCheck = { agents: [Object.assign({}, A1)], kb: [], nextKb: 1 };
  const before = orphanCheck.agents[0];
  Store.reconcileInto(orphanCheck, { agents: [], kb: [], nextKb: 1 });
  t.eq(orphanCheck.agents.length, 0, '全表被清空时，原数组对象仍在但内容清零');
  t.eq(before.id, 'CS013', '被清掉的记录对象本身不受影响（只是不再被引用）');
  const nothing = Store.reconcileInto(null, null);
  t.eq(nothing.reused, 0, '两份都不是对象时安全返回，不抛也不改任何东西');

  /* ================================================== 两台实例共用一个文件 */

  const DIR = path.join(os.tmpdir(), 'beauty-cs-storetest-' + process.pid);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* 新的就好 */ }
  fs.mkdirSync(DIR, { recursive: true });

  const children = [];
  async function launch(port, base) {
    const child = spawn(process.execPath, [path.join('server', 'server.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(port), DATA_DIR: DIR, DEEPSEEK_API_KEY: '', LLM_API_KEY: '',
      }),
      stdio: 'ignore',
    });
    children.push(child);
    const h = await waitHealth(12000, base);
    return { child, health: h };
  }

  try {
    const a = await launch(PORT_A, URL_A);
    const b = await launch(PORT_B, URL_B);

    t.suite('store · 两台实例共用一个 db.json');
    t.ok(a.health && b.health, '两台都在 12s 内起来');
    if (!a.health || !b.health) return;
    /* 老规矩：回答我的必须是我 spawn 的那台。端口被上一轮遗留进程占着时，
       这一整套「两台并发写」的断言会跑在一真一假的两台老代码上，而终端照样全绿。 */
    t.eq(a.health.pid, a.child.pid, 'A 台回答 /api/health 的就是本次 spawn 的子进程');
    t.eq(b.health.pid, b.child.pid, 'B 台回答 /api/health 的就是本次 spawn 的子进程');
    t.eq(a.health.pid !== b.health.pid, true, '两台确实是两个进程');

    const login = async (base) => {
      const r = json(await requestAt(base, 'POST', '/api/auth/login', { agentId: SEED_AGENT, pin: DEMO_PIN }));
      return r && r.token ? r.token : '';
    };
    const tokA = await login(URL_A);
    const tokB = await login(URL_B);
    t.ok(tokA && tokB, '两台都能用同一个种子工号登录（共享账号库）');
    if (!tokA || !tokB) return;

    const stamp = Date.now().toString(36);
    /* 顺序钉死：A 写完并确认落盘 → B 再写。B 那次读盘必然看见 A 的记录，
       而它不在 B 的 base 里 —— 「别人新建」这条分支必然被走到。 */
    let seq = 0;
    const created = [];
    for (let round = 0; round < 3; round++) {
      const idA = 'kb-a' + stamp + '-' + (seq++);
      const idB = 'kb-b' + stamp + '-' + (seq++);
      const rA = json(await requestAt(URL_A, 'POST', '/api/kb',
        { text: idA + ' · A 台话术', cat: '合并测试' }, { Authorization: 'Bearer ' + tokA, 'Content-Type': 'application/json' }));
      if (!rA || !rA.item) { t.ok(false, 'A 台第 ' + round + ' 轮没能建话术'); break; }
      created.push([rA.item.id, 'A']);
      const seenA = await waitDiskHas(DIR, (db) => has(idsOf(db, 'kb'), rA.item.id), 8000);
      if (!seenA) { t.ok(false, 'A 台第 ' + round + ' 轮的记录没落到盘上'); break; }

      const rB = json(await requestAt(URL_B, 'POST', '/api/kb',
        { text: idB + ' · B 台话术', cat: '合并测试' }, { Authorization: 'Bearer ' + tokB, 'Content-Type': 'application/json' }));
      if (!rB || !rB.item) { t.ok(false, 'B 台第 ' + round + ' 轮没能建话术'); break; }
      created.push([rB.item.id, 'B']);
      const seenB = await waitDiskHas(DIR, (db) => has(idsOf(db, 'kb'), rB.item.id), 8000);
      if (!seenB) { t.ok(false, 'B 台第 ' + round + ' 轮的记录没落到盘上'); break; }

      /* 这一轮的核心断言：B 落盘之后，A 那条**还在**。
         原来的整份覆盖写法下，B 的快照里没有 A 这条，rename 之后就消失。 */
      const diskNow = readDisk(DIR);
      const lost = created.filter(([id]) => !has(idsOf(diskNow, 'kb'), id));
      t.eq(lost.length, 0, '第 ' + round + ' 轮之后盘上仍然有全部 ' + created.length + ' 条（一条都没被盖掉）');
    }
    t.ok(created.length >= 1, '至少跑完一轮写入（跑了 ' + created.length + ' 条）');
    if (!created.length) return;

    const finalDisk = readDisk(DIR);
    if (!finalDisk) { t.ok(false, '跑完三轮之后 db.json 应该存在'); return; }
    const allIds = idsOf(finalDisk, 'kb');
    t.eq(allIds.length, new Set(allIds).size, '盘上没有重复 id（发号器没被两台拽回同一个值）');
    /* 起始 nextKb=1，六条各推进一格 → 应该是 7。
       这一条比「不重复」更硬：它证明发号之前真的看过盘。
       原来这里只写「取两边的最大值」，实测跑出来是 4 —— 两台各自从自己那份内存里 ++，
       号是重过的，只是 id 里的时间戳前缀把它们错开了。靠时间戳不同意不是设计。 */
    t.eq(finalDisk.nextKb, created.length + 1,
      'nextKb 是两台共享的高水位（发 ' + created.length + ' 条之后应为 ' + (created.length + 1) + '，实际 ' + finalDisk.nextKb + '）');

    const hb = json(await requestAt(URL_B, 'GET', '/api/health'));
    if (!hb || !hb.store) { t.ok(false, 'B 台 health 没自述 store 这一格'); return; }
    t.eq(typeof hb.store.keptFromDisk, 'number', 'B 台 health 自述 keptFromDisk（合并真的按下去了）');
    t.ok(hb.store.keptFromDisk >= 1,
      'B 台至少收下过 ' + hb.store.keptFromDisk + ' 条「对方新建」的记录 —— 没有这条，测试绿了也不知道是修好了还是没撞上');
    t.eq(hb.store.errors, 0, 'B 台写盘错误计数为 0');
    t.eq(hb.store.lockTimeouts, 0, 'B 台没有等不到锁就放弃的写入');
    t.eq(hb.store.stalled, false, 'B 台此刻不欠落盘');
    const ha = json(await requestAt(URL_A, 'GET', '/api/health'));
    t.eq(ha.store.errors, 0, 'A 台写盘错误计数为 0');

    /* 方向反过来也要成立：A 删掉一条，B 下一次写不许把它从「B 内存里那份旧副本」捞回来。 */
    const victim = created[0][0];
    const del = await requestAt(URL_A, 'DELETE', '/api/kb/' + victim, null, { Authorization: 'Bearer ' + tokA });
    t.eq(del.status, 200, 'A 台删掉了 ' + victim);
    await waitDiskHas(DIR, (db) => !has(idsOf(db, 'kb'), victim), 8000);
    const rAfter = json(await requestAt(URL_B, 'POST', '/api/kb',
      { text: '删除之后的又一次写', cat: '合并测试' }, { Authorization: 'Bearer ' + tokB, 'Content-Type': 'application/json' }));
    const afterId = rAfter && rAfter.item ? rAfter.item.id : '';
    t.ok(!!afterId, 'B 台在 A 删除之后又建了一条');
    t.ok(!!await waitDiskHas(DIR, (db) => has(idsOf(db, 'kb'), afterId), 8000), 'B 台那次写落了盘（写没有停摆）');
    t.eq(has(idsOf(readDisk(DIR), 'kb'), victim), false, '被 A 删掉的那条没有从 B 的旧副本里复活');

    const hb2 = json(await requestAt(URL_B, 'GET', '/api/health'));
    t.ok(hb2.store.honoredDeletes >= 1, 'B 台「尊重了对方的删除」至少记了一次（实际 ' + hb2.store.honoredDeletes + '）');

    /* 在线状态：两台都在改同一个坐席，落盘的必须是较新那次，而不是较晚**整个文件**那次 */
    await requestAt(URL_A, 'POST', '/api/presence', { status: 'busy' }, { Authorization: 'Bearer ' + tokA, 'Content-Type': 'application/json' });
    const sawBusy = await waitDiskHas(DIR, (db) => {
      const x = (db.agents || []).filter((y) => y.id === SEED_AGENT)[0];
      return x && x.status === 'busy';
    }, 8000);
    t.ok(sawBusy, 'A 台把在线状态改成 busy 落了盘');
    await requestAt(URL_B, 'POST', '/api/presence', { status: 'away' }, { Authorization: 'Bearer ' + tokB, 'Content-Type': 'application/json' });
    const sawAway = await waitDiskHas(DIR, (db) => {
      const x = (db.agents || []).filter((y) => y.id === SEED_AGENT)[0];
      return x && x.status === 'away';
    }, 8000);
    t.ok(sawAway, 'B 台改 away 之后，盘上那条**记录**跟着变，而盘上其它记录一条没少');
    const stillAll = readDisk(DIR);
    t.ok(!!stillAll && stillAll.kb.length >= created.length,
      '改状态这一次写，没有把前面的话术写没了（实际 ' + (stillAll ? stillAll.kb.length : -1) + ' 条，应不少于 ' + created.length + '）');
  } finally {
    children.forEach((c) => { try { c.kill(); } catch (e) { /* 已经死了 */ } });
    await sleep(300);
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* 留给系统清 */ }
  }
};
