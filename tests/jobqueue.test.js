/* ==========================================================================
   分析任务调度 assets/jobqueue.js
   —— 覆盖三条会被「顺手改坏」的语义：
       ① 同一会话严格 FIFO（结果要按到达顺序回写会话状态）
       ② 不同会话并行、且全局并发有上限（保护上游配额）
       ③ 单条任务失败既不阻断后续，也要如实交回调用方记账（原来 drain 的 catch）
      另外测轮询公平性、空桶回收、同步 run、以及读数（waiting/busyFor/stats）。

   这里的 run 全是手工放行的 Promise：调度对不对只能靠「什么时候被放行」来观察，
   不能靠 sleep —— 用时长短会随机器波动，断言就会变成随机红绿灯。
   ========================================================================== */

'use strict';

const { load } = require('./sandbox');

module.exports = async function (t) {
  const JQ = load(['assets/jobqueue.js']).JobQueue;

  const tick = () => new Promise((r) => setTimeout(r, 0));

  /** 手工放行的 runner：记录起跑顺序，release(tag) 才让这一条结束 */
  function gated() {
    const started = [];
    const finished = [];
    const waiters = {};
    const run = (job) => new Promise((resolve) => {
      started.push(job.tag);
      waiters[job.tag] = () => { finished.push(job.tag); resolve(); };
    });
    return { started, finished, run, release: (tag) => { const w = waiters[tag]; if (w) w(); } };
  }

  t.suite('jobqueue · 模块形态');
  t.eq(typeof JQ.create, 'function', '提供 create 工厂');
  t.eq(JQ.DEFAULT_MAX_CONCURRENT, 2, '默认并发上限 2（不是越多越好：目的是守住上游配额）');

  /* ------------------------------------------------ ① 同会话严格 FIFO */

  t.suite('jobqueue · 同一会话严格 FIFO');
  {
    const g = gated();
    const q = JQ.create({ maxConcurrent: 4, keyOf: (j) => j.idx, run: g.run });
    t.eq(q.enqueue({ idx: 0, tag: 'a1' }), 0, '第一条立刻开跑（返回 0 = 不必排队）');
    t.eq(q.enqueue({ idx: 0, tag: 'a2' }), 1, '第二条开始排队（返回排队深度）');
    t.eq(q.enqueue({ idx: 0, tag: 'a3' }), 2, '第三条排在第二条之后');
    t.eq(g.started.join(','), 'a1', '同会话同一时刻只有一条在跑');
    t.eq(q.waiting(), 2, 'waiting 只数未起跑的');
    t.eq(q.waitingFor(0), 2, 'waitingFor 按会话给深度');
    t.ok(q.busyFor(0), '该会话处于「有活」状态');
    t.not(q.busyFor(1), '别的会话没有活');

    g.release('a1');
    await tick();
    t.eq(g.started.join(','), 'a1,a2', 'a1 结束后 a2 才起跑（严格 FIFO，不插队）');
    g.release('a2');
    await tick();
    t.eq(g.started.join(','), 'a1,a2,a3', 'a3 在 a2 之后');
    g.release('a3');
    await tick();
    t.eq(q.stats().done, 3, '三条全部完成');
    t.eq(q.buckets(), 0, '空桶已回收（跑过 8 个会话后不会留下 8 个空桶）');
    t.not(q.busy(), '全部跑完后队列空闲');
  }

  /* ------------------------------------------------ ② 跨会话并行 + 上限 */

  t.suite('jobqueue · 不同会话并行、并发有上限');
  {
    const g = gated();
    const q = JQ.create({ maxConcurrent: 2, keyOf: (j) => j.idx, run: g.run });
    q.enqueue({ idx: 0, tag: 'a1' });
    q.enqueue({ idx: 1, tag: 'b1' });
    q.enqueue({ idx: 2, tag: 'c1' });
    t.eq(g.started.join(','), 'a1,b1', '两个并发额度立刻被两个会话占满');
    t.eq(q.running(), 2, 'running 反映正在执行的任务数');
    t.eq(q.waitingFor(2), 1, '第三个会话只能排队（上限就是上限）');
    t.ok(q.busyFor(2), '排队中的会话也算「有活」');

    g.release('a1');
    await tick();
    t.eq(g.started.indexOf('c1'), 2, 'a1 让出额度后 c1 补上');
    t.eq(q.running(), 2, '并发始终不超过上限');
    g.release('b1');
    g.release('c1');
    await tick();
    t.eq(q.stats().done, 3, '三条完成');
  }

  /* 桶内 FIFO 与跨桶公平：排队顺序按到达先后补位 */
  t.suite('jobqueue · 补位按到达顺序，不会让某个会话饿死');
  {
    const g = gated();
    const q = JQ.create({ maxConcurrent: 1, keyOf: (j) => j.idx, run: g.run });
    q.enqueue({ idx: 0, tag: 'a1' });
    q.enqueue({ idx: 1, tag: 'b1' });   // 排队：此刻额度被 a1 占着
    q.enqueue({ idx: 1, tag: 'b2' });
    g.release('a1');
    await tick();
    t.eq(g.started.join(','), 'a1,b1', 'a1 之后先跑 b1（同会话内仍按到达顺序）');
    g.release('b1');
    await tick();
    t.eq(g.started.join(','), 'a1,b1,b2', 'b1 之后才跑同会话的 b2');
  }

  /* ------------------------------------------------ ③ 失败不阻断 */

  t.suite('jobqueue · 单条失败不阻断后续，且如实交回调用方');
  {
    const errs = [];
    const started = [];
    const q = JQ.create({
      maxConcurrent: 1,
      keyOf: (j) => j.idx,
      run: (job) => {
        started.push(job.tag);
        if (job.bad) return Promise.reject(new Error('分析炸了：' + job.tag));
        return Promise.resolve();
      },
      onError: (job, e) => errs.push(job.tag + ':' + e.message),
    });
    q.enqueue({ idx: 0, tag: 'x1', bad: true });
    await tick();
    q.enqueue({ idx: 0, tag: 'x2' });
    await tick();
    q.enqueue({ idx: 1, tag: 'y1', bad: true });
    await tick();
    t.eq(errs.join(','), 'x1:分析炸了：x1,y1:分析炸了：y1', '两条失败都回调了 onError（消息仍要被 ack）');
    t.eq(started.join(','), 'x1,x2,y1', '失败之后同会话继续、别的会话也继续');
    t.eq(q.stats().failed, 2, '失败计数进 stats');
    t.eq(q.stats().done, 1, '成功计数只算真成功的');
  }

  t.suite('jobqueue · 同步抛错与同步完成的 run');
  {
    const errs = [];
    const q = JQ.create({
      maxConcurrent: 1,
      keyOf: (j) => j.idx,
      run: (job) => { if (job.boom) throw new Error('同步炸'); },   // 返回 undefined = 同步完成
      onError: (job, e) => errs.push(job.tag + ':' + e.message),
    });
    q.enqueue({ idx: 0, tag: 's1', boom: true });
    t.eq(errs.join(','), 's1:同步炸', 'run 同步抛错也被记账，不会把调用栈炸穿队列');
    q.enqueue({ idx: 0, tag: 's2' });
    t.eq(q.stats().done, 1, '同步完成的本地引擎路径照常计入 done');
    t.eq(q.stats().failed, 1, '同步抛错计入 failed');
  }

  t.suite('jobqueue · onError 自己抛错不能带走调度器');
  {
    const started = [];
    const q = JQ.create({
      maxConcurrent: 1,
      keyOf: (j) => j.idx,
      run: (job) => { started.push(job.tag); if (job.bad) return Promise.reject(new Error('炸')); },
      onError: () => { throw new Error('记账的记账炸了'); },
    });
    q.enqueue({ idx: 0, tag: 'k1', bad: true });
    await tick();
    q.enqueue({ idx: 0, tag: 'k2' });
    await tick();
    t.eq(started.join(','), 'k1,k2', 'onError 抛错也继续推进（它是记账，不是流程）');
    const ks = q.stats();
    t.eq(ks.failed, 1, 'failed 只数真正失败的那一条任务');
    t.eq(ks.callbackErrors, 1, '记账回调的异常单独计数（混进 failed 会让两个数都说谎）');
    t.eq(ks.done, 1, 'k2 正常完成');
  }

  /* ------------------------------------------------ 配置与读数 */

  t.suite('jobqueue · 参数兜底与状态读数');
  {
    const seen = [];
    const q = JQ.create({ maxConcurrent: 0, run: (j) => { seen.push(j.tag); } });   // 非法值
    t.eq(q.maxConcurrent(), JQ.DEFAULT_MAX_CONCURRENT,
      '并发上限为 0 时回落到默认值（0 会变成「永远不出活」，比报错更难查）');
    q.enqueue({ tag: 'z1' });
    q.enqueue({ tag: 'z2' });
    t.eq(seen.join(','), 'z1,z2', '没有 key 的任务都归到同一个默认桶 → 严格串行');
    const st = q.stats();
    t.eq(st.pushed, 2, 'pushed 数入队次数');
    t.eq(st.started, 2, 'started 数真正起跑的次数（排队的不算）');
    t.eq(st.done, 2, '同步 run 完成后 done 计数');
    t.eq(st.failed, 0, '没有失败');
    t.eq(st.maxConcurrent, 2, 'stats 里带上上限，界面显示的「并发 2」才有出处');
  }

  t.suite('jobqueue · clear 只清排队，不打断在跑的');
  {
    const g = gated();
    const q = JQ.create({ maxConcurrent: 1, keyOf: (j) => j.idx, run: g.run });
    q.enqueue({ idx: 3, tag: 'c1' });
    q.enqueue({ idx: 3, tag: 'c2' });
    q.enqueue({ idx: 4, tag: 'c3' });
    t.eq(q.waiting(), 2, 'c1 在跑，c2/c3 排队');
    q.clear();
    t.eq(q.waiting(), 0, '排队的两条被清掉');
    t.eq(q.running(), 1, '正在跑的那条不受影响');
    t.ok(q.busy(), '还有任务在跑 → 队列仍算忙');
    g.release('c1');
    await tick();
    t.eq(g.started.join(','), 'c1', '被 clear 掉的不会又冒出来');
    t.not(q.busy(), '跑完即空闲');
    t.eq(q.stats().done, 1, '只有 c1 完成');
  }
};
