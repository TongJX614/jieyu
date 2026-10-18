/* 消息总线 bus.js：唯一入口 / 幂等 / 序号 / 图片附件透传 */

'use strict';

const { load, memoryStorage } = require('./sandbox');

module.exports = function (t) {
  const S = load(['assets/bus.js'], { localStorage: memoryStorage() });
  const BUS = S.MessageBus;

  t.suite('bus · 接收与幂等');
  let got = [];
  BUS.subscribe((m) => got.push(m), 'test');

  const r1 = BUS.ingest({ id: 'm-1', customerId: 'allergy', text: '脸上刺痛发红' });
  t.eq(r1.accepted, true, '正常消息被接收');
  t.eq(r1.seq, 1, '首条序号为 1');
  const r2 = BUS.ingest({ id: 'm-1', customerId: 'allergy', text: '重复投递' });
  t.eq(r2.reason, 'duplicate', '同 id 重推被幂等拦截');
  t.eq(BUS.report().stats.duplicate, 1, '重复计数 +1');

  t.suite('bus · 空消息与图片消息');
  const r3 = BUS.ingest({ id: 'm-2', customerId: 'allergy', text: '   ' });
  t.eq(r3.reason, 'empty', '空文本被拦截');
  const img = { dataUrl: 'data:image/png;base64,AAAA', observation: { level: 'high', signals: ['影像可见皮肤异常'], summary: '泛红' } };
  const r4 = BUS.ingest({ id: 'm-3', customerId: 'allergy', text: '', image: img });
  t.eq(r4.accepted, true, '只有图片、没有文字的消息可以接收');
  t.eq(got.length, 2, '订阅者只收到被接收的两条');

  t.suite('bus · 图片字段随消息流转');
  const withImg = got[got.length - 1];
  t.ok(withImg.image, '订阅者拿到的消息带 image');
  t.eq(withImg.image.observation.level, 'high', '视觉观察原样透传（未被 normalize 丢掉）');
  const noImg = got[0];
  t.eq(noImg.image, null, '无图消息 image 为 null');

  t.suite('bus · 可核对性统计');
  const rep = BUS.report();
  t.eq(rep.stats.accepted, 2, '已接收 2 条');
  t.eq(rep.gaps, 0, '序号无空洞');
  BUS.ack('m-1');
  t.eq(BUS.report().pendingAck, 1, 'ack 后未分析数减 1');
  t.eq(BUS.history('allergy').length, 2, '审计日志可按客户回溯（被拦截的不入册）');

  /* ---------- 落盘瘦身：像素绝不进 localStorage ----------
     这一条原本是被「图片附件随消息流转」那套便利写法顺手实现的：
     persist() 直接 JSON.stringify 整条消息，于是顾客照片的 base64
     被永久写进本机磁盘（授权之外、跨刷新），而且一条照片就能把配额顶爆。 */
  t.suite('bus · 落盘不写图片像素');
  {
    const store = memoryStorage();
    const B = load(['assets/bus.js'], { localStorage: store }).MessageBus;
    B.ingest({
      id: 'p-1', customerId: 'allergy', text: '看照片',
      image: { dataUrl: 'data:image/png;base64,QUFD', thumb: 'data:image/jpeg;base64,/9j/',
        fp: 'abcd1234', name: ' cheek.png', size: 1234, observation: { level: 'high', summary: '泛红' } },
    });
    const raw = store.getItem(B.LOG_KEY) || '';
    t.ok(raw.length > 0, '确实落盘了（不是靠没写来通过）');
    t.eq(raw.indexOf('data:image') === -1, true, '磁盘那一份里一个像素字节都没有');
    t.eq(raw.indexOf('QUFD') === -1, true, '原图内容不可复原');
    t.eq(raw.indexOf('cheek.png') === -1, true, '连文件名都不落盘（相册带出来的名字能指认人）');
    const back = JSON.parse(raw)[0];
    t.eq(back.image.pixels, false, '落盘的条目标明「像素没存」，界面据此说话');
    t.eq(back.image.fp, 'abcd1234', '指纹保留（能把留痕和这张图对上）');
    t.eq(back.image.observation.level, 'high', '视觉结论保留（审计要的是判断，不是照片）');
    t.eq(back.image.size, 1234, '体积留着：能算出「这张图本来多大」');
    t.eq(B.history()[0].image.dataUrl, 'data:image/png;base64,QUFD', '内存里那条照旧带原图（分析链路要用）');
    B.ack('p-1');
    t.eq((store.getItem(B.LOG_KEY) || '').indexOf('data:image') === -1, true, 'ack 再写一次也不会漏出像素');
  }

  t.suite('bus · 开机要把旧日志里的像素清掉');
  {
    /* 修 forDisk 之前，顾客原图是整条消息一起 stringify 进 localStorage 的。
       只洗干净「新写入的那一份」不够：用户打开页面什么也不做，磁盘上那份历史残留
       就没有任何机会被覆盖，而「本机不落图片像素」这句已经是过去式了。
       所以 restore 必须照同一套规则重写一遍，并且**如实报数**。 */
    const store = memoryStorage();
    const legacy = [{
      id: 'old-1', seq: 7, customerId: 'allergy', text: '很久以前发过照片',
      analyzedAt: '2026-10-18T01:00:00.000Z',
      image: { dataUrl: 'data:image/png;base64,TkVWZXI=', thumb: 'data:image/jpeg;base64,/9j/',
        fp: 'ff00ff00', name: 'old.png', observation: { level: 'medium', summary: '泛红' } },
    }];
    store.setItem('beauty-cs-msglog', JSON.stringify(legacy));
    const B = load(['assets/bus.js'], { localStorage: store }).MessageBus;
    const raw = store.getItem(B.LOG_KEY) || '';
    t.ok(raw.indexOf('TkVWZXI=') === -1, '恢复时立刻回写：旧条目里的像素一个字节都不留');
    t.ok(raw.indexOf('"thumb"') === -1, '旧条目里的缩略图同样不落');
    t.eq(B.report().stats.legacyPurged, 1, '清掉了几条带像素的历史条目要能读出来，不许静默改写');
    const back = JSON.parse(raw)[0];
    t.eq(back.image.pixels, false, '重写后的条目按新格式声明「没有像素」');
    t.eq(back.image.fp, 'ff00ff00', '指纹与结论照旧留着（清理不是删账）');
    t.eq(back.seq, 7, '序号照旧恢复（幂等表依赖它，别在瘦身时丢掉）');
    t.eq(B.pending(), 0, 'analyzedAt 一并回填：恢复出来的旧消息不该被算成「未分析」');

    /* 干净日志不该每次开机都多写一次盘 —— 那是纯粹的浪费 */
    const clean = memoryStorage();
    const B2 = load(['assets/bus.js'], { localStorage: clean }).MessageBus;
    t.eq(B2.report().stats.legacyPurged, 0, '磁盘本来就是干净的：不报清理数');
  }

  t.suite('bus · forDisk 的边界');
  {
    const B = load(['assets/bus.js'], { localStorage: memoryStorage() }).MessageBus;
    const plain = { id: 'x', text: 'hi' };
    t.eq(B.forDisk(plain), plain, '没有图片的消息原样返回（不复制、不改写）');
    const noFp = B.forDisk({ id: 'y', image: { dataUrl: 'data:image/png;base64,ZZZ' } });
    t.eq(noFp.image.fp, null, '没指纹就写 null，不硬造一个');
    t.eq(noFp.image.originalDropped, true, '没标过丢弃状态的图片按「已丢」记账：落盘这一份本来就没有像素');
    t.eq(noFp.id, 'y', '其余字段照抄');
  }

  t.suite('bus · 落盘失败必须留下计数');
  {
    /* 配额炸了 / 隐私模式：不能阻主流程，但也不能装作一切正常 ——
       以前 catch 里一句注释，「审计还在落盘」这句话就只是愿望。 */
    const boom = {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => {}, clear: () => {},
    };
    const B = load(['assets/bus.js'], { localStorage: boom }).MessageBus;
    const r = B.ingest({ id: 'q-1', customerId: 'allergy', text: '还在收' });
    t.eq(r.accepted, true, '落盘失败不影响消息被接收');
    t.eq(B.report().stats.persistErrors, 1, '失败次数可查（界面与审计包都要说出来）');
    B.ingest({ id: 'q-2', customerId: 'allergy', text: '继续收' });
    t.eq(B.report().stats.persistErrors, 2, '每次失败都累加，不是只记第一次');
  }
};
