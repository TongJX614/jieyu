/* ==========================================================================
   Channels —— 多渠道接入（真实接入链路）+ 跨渠道用户合并

   做三件事：

   ① 渠道目录：淘宝 / 天猫 / 京东 / 拼多多 / 抖音 / 小红书 / 微信客服 / 官网
      八个消费者触点，每个声明接入方式、能力边界与**真实的接入前置条件**。

   ② 接入向导（setup → validate → probe → authorize → exchange → commit）：
      接入不是点一下就从黑盒里冒出来。真实平台要的东西这里一样要：
        · 平台侧前置条件（企业认证、应用审核、权限包申请）
        · 凭证（AppKey / AppSecret / client_id / client_secret / corpId …）
        · 回调地址（必须 HTTPS、公网可达、不能用平台自家域名、不能 127.0.0.1）
        · 店铺主账号 OAuth 授权，回调里带 code，code 只能消费一次
        · state 防 CSRF，签名与时间戳偏差不能超 5 分钟
      字段、校验规则、错误提示全部按各平台开放平台文档的硬性要求写，
      不做「随便填填就通过」。填示例值就是会失败 —— 失败信息也是真实的。

   ③ 授权生命周期：**token 会过期**。这是真实接入最疼的地方 ——
      京东正式环境测试阶段 access_token 固定 24 小时，微信客服 2 小时，
      抖店 7 天。到期不续，渠道不是「接好了」，是「断了」。
      `tokenState()` 把这件事变成一个能指着看的倒计时。

   ④ 跨渠道用户合并：同一个消费者在不同渠道留下的痕迹按手机号 / 订单号 /
      会员号归并成一个身份 —— 这是「数据共情者」的地基。
      `gaps` 字段直接把「本渠道看不到的其他渠道信息」数出来。

   UMD：浏览器挂 window.Channels，Node 下 module.exports（便于单测）。
   纯数据 + 纯函数，不碰 DOM；异步流程用注入的 timer 驱动。
   ========================================================================== */

(function (factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Channels = api;
})(function () {
  'use strict';

  var VERSION = '2026.2';

  var MIN = 60 * 1000;
  var HOUR = 60 * MIN;
  var DAY = 24 * HOUR;

  /* 演示基准时间：预置渠道的授权到期时间以此为锚点，界面上的倒计时才稳定可复现 */
  var T0 = Date.now();

  /* ---------------------------------------------------------------- 渠道目录 */
  /* kind：open-api（平台开放接口）/ plugin（插件嵌入工作台）/ webhook（自有渠道回推） */

  var CATALOG = [
    {
      id: 'tmall', name: '天猫旗舰店', abbr: '猫', kind: 'open-api', setupKey: 'taobao',
      source: '天猫开放平台', caps: ['消息', '订单', '物流', '售后', '会员'],
      note: '买家咨询、订单联查、会员权益同步',
    },
    {
      id: 'taobao', name: '淘宝', abbr: '淘', kind: 'open-api', setupKey: 'taobao',
      source: '淘宝开放平台', caps: ['消息', '订单', '物流', '售后'],
      note: '千牛工作台的买家消息接入',
    },
    {
      id: 'jd', name: '京东自营', abbr: '京', kind: 'open-api', setupKey: 'jd',
      source: '京东宙斯开放平台', caps: ['消息', '订单', '物流', '售后'],
      note: '咚咚消息与订单联查',
    },
    {
      id: 'pdd', name: '拼多多', abbr: '拼', kind: 'open-api', setupKey: 'pdd',
      source: '拼多多开放平台', caps: ['消息', '订单', '物流', '售后'],
      note: '商家后台消息接入',
    },
    {
      id: 'douyin', name: '抖音商城', abbr: '抖', kind: 'plugin', setupKey: 'douyin',
      source: '抖店开放平台', caps: ['消息', '订单', '物流'],
      note: '直播间与商城咨询',
    },
    {
      id: 'xhs', name: '小红书', abbr: '红', kind: 'plugin', setupKey: 'xhs',
      source: '小红书开放平台', caps: ['消息', '内容', '舆情'],
      note: '笔记评论与私信监控 —— 舆情外溢的第一现场',
    },
    {
      id: 'wecom', name: '微信客服', abbr: '微', kind: 'webhook', setupKey: 'wecom',
      source: '微信客服 API', caps: ['消息', '会员'],
      note: '公众号 / 视频号 / 小程序统一入口',
    },
    {
      id: 'official', name: '品牌官网', abbr: '官', kind: 'webhook', setupKey: 'official',
      source: '自有渠道 Webhook', caps: ['消息', '订单'],
      note: '官网在线客服与自建小程序',
    },
  ];

  /* ------------------------------------------------------------ 接入要求定义 */
  /* 每个平台「要什么、去哪拿、要求长什么样」，逐条对照开放平台文档。 */

  var SETUP = {
    taobao: {
      vendor: '淘宝 / 天猫开放平台',
      portal: 'https://open.taobao.com',
      where: '控制台 → 开发 → 我的应用 → 应用管理 → 概览（AppKey 与 AppSecret 同页）',
      prereq: [
        '淘宝开放平台开发者账号（订单 / 消息类接口不对个人开发者开放，需企业认证）',
        '店铺主账号可登录（授权环节要由它扫码确认）',
        '已创建应用并通过审核（应用审核一般 1–3 个工作日）',
        '回调地址用自有域名 —— 不能用 taobao / tmall / alibaba 系域名，也不能填 127.0.0.1',
      ],
      fields: [
        { k: 'appKey', label: 'AppKey', ph: '如 28571234', rule: 'digits8',
          hint: '8 位数字。路径：控制台 → 我的应用 → 概览 → AppKey' },
        { k: 'appSecret', label: 'AppSecret', ph: '32 位字母数字', rule: 'secret', secret: true,
          hint: '与 AppKey 同页，创建应用后仅完整显示一次，务必自行保存' },
        { k: 'shopNick', label: '店铺主账号昵称', ph: '如 格物旗舰店:小满', rule: 'req',
          hint: '授权时由这个账号扫码 / 确认，需与店铺主体一致' },
        { k: 'callback', label: '授权回调地址', ph: 'https://cs.your-brand.com/ch/tmall/callback', rule: 'https',
          hint: '必须与开放平台登记的回调地址「域名一致」，协议 / 域名 / 路径都不能差' },
      ],
      authUrl: 'https://oauth.taobao.com/authorize?response_type=code&client_id={appKey}' +
        '&redirect_uri={callback}&state={state}&view=web',
      tokenUrl: 'https://oauth.taobao.com/token',
      scopes: [
        'taobao.trade.fullinfo.get（订单明细）',
        'taobao.user.seller.get（卖家信息）',
        'taobao.wangwang.eservice.chatlog.get（客服会话记录，需单独审批）',
      ],
      scopeNote: '接口权限需在「权限管理」逐个申请，审核 1–3 个工作日；未审核通过的接口调用会返回「权限不足」',
      ttl: 365 * DAY,
      ttlHuman: 'access_token 1 年（refresh_token 可续期）',
      quota: '默认流量 100 万次 / 天；涉及消费者敏感数据的接口需部署在聚石塔内',
      sign: 'MD5(AppSecret + timestamp + 参数串 + AppSecret)，请求时间戳与服务器偏差不得超过 5 分钟，否则报 Invalid timestamp',
      callbackBan: ['taobao.com', 'tmall.com', 'alibaba.com', 'alipay.com', 'alicdn.com'],
    },

    jd: {
      vendor: '京东宙斯开放平台（JOS）',
      portal: 'https://jos.jd.com',
      where: '开发者中心 → 我的应用 → 应用详情 → 证书信息',
      prereq: [
        '企业开发者认证：营业执照 + 法人身份证 + 对公账户打款验证，审核 1–3 个工作日',
        '订单、发货、财务类接口属店铺私有数据，必须由店铺主账号完成 OAuth 授权，个人号在控制台申请不到',
        '接口权限申请审核 1–5 个工作日（如 jingdong.pop.order.search）',
        '敏感数据接口需「入鼎」—— 部署在京东云鼎环境内才能调用',
      ],
      fields: [
        { k: 'appKey', label: 'AppKey', ph: '16 位字母数字', rule: 'alnum16',
          hint: '我的应用 → 证书信息 → App Key' },
        { k: 'appSecret', label: 'AppSecret', ph: '32 位字母数字', rule: 'secret', secret: true,
          hint: '与 App Key 相邻，用于 JOS 签名，不要写进前端代码' },
        { k: 'shopId', label: '店铺 ID（vender_id）', ph: '如 1000001234', rule: 'digits',
          hint: '多店铺场景下每个店铺一份 token，必须与 shop_id 关联存储，否则会串店' },
        { k: 'callback', label: '授权回调地址（HTTPS）', ph: 'https://cs.your-brand.com/ch/jd/callback', rule: 'https',
          hint: '必须与应用中配置的地址完全一致 —— 协议、域名、路径、末尾斜杠都不能差' },
      ],
      authUrl: 'https://oauth.jd.com/oauth/authorize?response_type=code&client_id={appKey}' +
        '&redirect_uri={callback}&scope=seller_order_get,item_read&state={state}',
      tokenUrl: 'https://oauth.jd.com/oauth/token',
      scopes: [
        'seller_order_get（订单查询）',
        'jingdong.pop.order.search（订单列表）',
        'jingdong.pop.afs.soa.apply（售后服务单）',
      ],
      scopeNote: '无沙箱环境，调试需直接在线上进行；建议先发布应用再联调，弄错的应用无法删除',
      ttl: 24 * HOUR,
      ttlHuman: 'access_token 有效期固定 24 小时（正式环境测试阶段无法延长），失效需重新授权；上线后按订购时长，最长 1 年',
      quota: '接口按应用限流，超限返回错误码；token 到期未刷新会直接导致商家业务中断',
      sign: '参数按字典序排序 → key1=value1&key2=value2… → 末尾追加 AppSecret → MD5 后转大写',
      callbackBan: ['jd.com', '360buy.com'],
    },

    pdd: {
      vendor: '拼多多开放平台',
      portal: 'https://open.pinduoduo.com',
      where: '应用管理 → 我的应用 → 授权管理（client_id 与 client_secret）',
      prereq: [
        '用拼多多商家后台账号登录开放平台（建议企业账号，调用限额更高）',
        '创建应用（自用型：只给自己店铺用），审核通常 1–3 个工作日',
        '在「授权管理」配置回调地址 —— client_id 与回调地址一一对应，不匹配会直接跳授权失败',
        '申请需要的权限包（订单 / 消息 / 商品），审核 1–3 个工作日',
      ],
      fields: [
        { k: 'clientId', label: 'client_id', ph: '32 位十六进制', rule: 'hex32',
          hint: '即 App Key，应用详情页可见' },
        { k: 'clientSecret', label: 'client_secret', ph: '32 位字母数字', rule: 'secret', secret: true,
          hint: '相当于账号密码，泄露等于店铺数据泄露' },
        { k: 'callback', label: '回调地址', ph: 'https://cs.your-brand.com/ch/pdd/callback', rule: 'https',
          hint: '必须与「授权管理」中登记的地址一致' },
      ],
      authUrl: 'https://mms.pinduoduo.com/open.html?response_type=code&client_id={clientId}' +
        '&redirect_uri={callback}&state={state}',
      tokenUrl: 'https://open-api.pinduoduo.com/oauth/token',
      scopes: ['pdd.order.list.get（订单列表）', 'pdd.erp.order.sync（订单同步）'],
      scopeNote: 'access_token 需按店铺隔离存储；refresh_token 刷新失败必须重新走一遍授权',
      ttl: 24 * HOUR,
      ttlHuman: 'access_token 24 小时（过期用 refresh_token 刷新）',
      quota: '按应用与接口分别限流；高频拉单建议做增量游标',
      sign: 'MD5(client_secret + 参数按字典序拼接 + client_secret) 后转大写',
      callbackBan: ['pinduoduo.com', 'yangkeduo.com'],
    },

    douyin: {
      vendor: '抖店开放平台',
      portal: 'https://op.jinritemai.com',
      where: '应用管理 → 应用详情 → 证书信息（App Key / App Secret）',
      prereq: [
        '选择应用类型：自用型（只给自己店铺用）或工具型（给第三方开发者）—— 选错后面权限配置全错',
        '已通过接口权限审核，按需勾选，不要一股脑全选',
        '回调地址生产环境必须 HTTPS',
        '自用型应用支持多店铺授权，换店铺要传 shop_id',
      ],
      fields: [
        { k: 'appKey', label: 'App Key', ph: '19 位数字', rule: 'digits19',
          hint: '证书信息页可见。创建后立即存入配置系统，别停留在浏览器页面上' },
        { k: 'appSecret', label: 'App Secret', ph: '32 位字母数字', rule: 'secret', secret: true,
          hint: '不要截图、不要发群、不要硬编码在代码里' },
        { k: 'shopId', label: 'shop_id', ph: '如 12312312', rule: 'digits',
          hint: '自用型应用多店铺授权时必传，不传默认返回最早授权成功的店铺' },
        { k: 'callback', label: '回调地址（HTTPS）', ph: 'https://cs.your-brand.com/ch/douyin/callback', rule: 'https',
          hint: '服务端对接时填接收授权码的接口地址' },
      ],
      authUrl: 'https://open.douyin.com/oauth/authorize?response_type=code&client_id={appKey}' +
        '&redirect_uri={callback}&scope=seller_order_get&state={state}',
      tokenUrl: 'https://openapi-fxg.jinritemai.com/token/create',
      scopes: ['order.searchList（订单列表）', 'product.listV2（商品列表）', 'afterSale.list（售后）'],
      scopeNote: '同一时间重复刷新 refresh_token 会导致它失效；access_token 过期前 1 小时内刷新才会换发新 token',
      ttl: 7 * DAY,
      ttlHuman: 'access_token 7 天，refresh_token 14 天（最长可续到约 195 天，之后需重新授权）',
      quota: '接口按秒限流（如商品发布类 300 次 / 秒）',
      sign: '参数按字典序拼接 + app_secret → MD5 转小写，请求需带 timestamp 与 v=2',
      callbackBan: ['douyin.com', 'jinritemai.com', 'bytedance.com'],
    },

    xhs: {
      vendor: '小红书开放平台',
      portal: 'https://open.xiaohongshu.com',
      where: '开发者中心 → 应用管理',
      prereq: [
        '小红书开放平台开发者账号 + 企业认证',
        '已创建应用并拿到对应权限包',
        '笔记评论、私信类能力属于内容域，需单独申请，通常审核更久',
      ],
      fields: [
        { k: 'appId', label: 'App ID', ph: '应用详情页可见', rule: 'req',
          hint: '开发者中心 → 应用管理 → 应用详情' },
        { k: 'appSecret', label: 'App Secret', ph: '32 位字母数字', rule: 'secret', secret: true,
          hint: '与 App ID 成对，仅创建时完整展示' },
        { k: 'callback', label: '回调地址（HTTPS）', ph: 'https://cs.your-brand.com/ch/xhs/callback', rule: 'https',
          hint: '需与平台登记的回调地址一致' },
      ],
      authUrl: 'https://ark.xiaohongshu.com/app/api/v1/oauth2/authorize?client_id={appId}' +
        '&response_type=code&redirect_uri={callback}&state={state}',
      tokenUrl: 'https://ark.xiaohongshu.com/app/api/v1/oauth2/token',
      scopes: ['商品查询', '订单查询', '笔记评论（内容域，需单独审批）'],
      scopeNote: '内容域能力审批周期较长，建议提前申请',
      ttl: null,
      ttlHuman: '有效期以授权返回的 expires_in 为准（不写死，避免过期判断失误）',
      quota: '按应用限流',
      sign: '参数按字典序拼接 + app_secret → MD5',
      callbackBan: ['xiaohongshu.com', 'xhscdn.com'],
    },

    wecom: {
      vendor: '微信客服（企业微信）',
      portal: 'https://developer.work.weixin.qq.com',
      where: '微信客服后台 → 开发配置 →「开始使用」→ 随机获取 Token 与 EncodingAESKey',
      prereq: [
        '已注册微信客服并完成企业认证',
        '后台「开发配置」先点「随机获取」拿到 Token 与 EncodingAESKey —— 但先别点「完成」，要等回调 URL 填回去',
        '回调 URL 必须 HTTPS 且公网可访问；服务器时间需与标准时间同步（偏差会让签名校验失败）',
        '把服务器公网 IP 加入「可信 IP」列表，否则调用接口会报 60020',
      ],
      fields: [
        { k: 'corpId', label: '企业 ID（corpId）', ph: 'ww 开头 18 位十六进制', rule: 'wecomCorp',
          hint: '微信客服后台 → 企业信息 → 企业 ID' },
        { k: 'secret', label: 'Secret', ph: '应用 Secret', rule: 'secret', secret: true,
          hint: '企微有多个 Secret 对应不同应用，拿错了会报 40001 invalid credential' },
        { k: 'token', label: 'Token', ph: '字母或数字，不超过 32 位', rule: 'wecomToken',
          hint: '用于计算签名，判断请求是否真的来自企业微信（≤32 位自定义字符串）' },
        { k: 'aesKey', label: 'EncodingAESKey', ph: '43 位字母数字', rule: 'aes43',
          hint: '恰好 43 位，用于 AES 解密回调消息体；填错会「解密失败」' },
        { k: 'callback', label: '回调 URL（HTTPS）', ph: 'https://cs.your-brand.com/ch/wecom/callback', rule: 'https',
          hint: '保存时企微会立刻发一次 GET 校验，必须 1 秒内原样返回解密后的 echostr（不能带引号、BOM、换行）' },
      ],
      authUrl: 'https://open.work.weixin.qq.com/wwopen/sso/3rd_qrConnect?appid={corpId}' +
        '&redirect_uri={callback}&state={state}&usertype=admin',
      tokenUrl: 'https://qyapi.weixin.qq.com/cgi-bin/gettoken',
      scopes: ['kf_account（客服账号管理）', 'kf_msg_or_event（消息与事件回调）'],
      scopeNote: '回调服务需同时支持 GET（URL 验证）与 POST（业务数据），5 秒内要响应，否则会重试 3 次',
      ttl: 2 * HOUR,
      ttlHuman: 'access_token 2 小时（必须自行缓存并提前刷新，不能每次调用都重新获取）',
      quota: 'gettoken 有频次限制，超限会返回 45009；建议中控统一管理 token',
      sign: 'msg_signature = SHA1(sort(Token, timestamp, nonce, encrypt))，再比对请求参数',
      callbackBan: ['qq.com', 'weixin.qq.com'],
    },

    official: {
      vendor: '自有渠道（自建服务）',
      portal: '',
      where: '在自家服务上部署回调接收端',
      prereq: [
        '提供可公网访问的 HTTPS 回调地址（接收消息推送），需部署在能出公网的机器上',
        '生成签名密钥，用 HMAC-SHA256 校验回调来源，防止被人伪造推送',
        '接入方 IP 白名单（可选，但生产建议开）',
        '确认消息体格式与幂等键（msg_id），重试不会产生重复会话',
      ],
      fields: [
        { k: 'callback', label: '回调地址（HTTPS）', ph: 'https://cs.your-brand.com/ch/official/callback', rule: 'https',
          hint: '接收官网客服消息的服务端地址' },
        { k: 'signSecret', label: '签名密钥（HMAC-SHA256）', ph: '至少 16 位随机字符串', rule: 'signSecret', secret: true,
          hint: '用于校验推送来源；建议 32 位随机串，可轮换' },
        { k: 'ipWhitelist', label: 'IP 白名单（可选）', ph: '如 203.0.113.10, 203.0.113.11', rule: 'optIp',
          hint: '留空表示不限制来源 IP' },
      ],
      authUrl: '',
      tokenUrl: '',
      scopes: ['消息推送', '订单查询（自有系统）'],
      scopeNote: '无第三方授权环节，用签名密钥自校验',
      ttl: null,
      ttlHuman: '无 access_token，长期有效；签名密钥建议按季度轮换',
      quota: '自建服务自行限流',
      sign: 'HMAC-SHA256(rawBody, signSecret)，请求头带 X-Signature 与 X-Timestamp',
      callbackBan: [],
    },
  };

  /* ------------------------------------------------------------ 演示凭证 */
  /* 格式合法、字段齐全，但平台侧查无此应用 —— 用来把接入链路跑通，
     真实接入必须到各平台开放平台申请。放在这里（而不是界面层）是为了让单测
     一起守住：演示凭证必须能通过本地校验，否则向导第 1 步就直接卡死。 */

  var DEMO_CREDENTIALS = {
    taobao: {
      appKey: '28571234', appSecret: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
      shopNick: '格物旗舰店:小满', callback: 'https://cs.gewuzaojing.com/ch/tmall/callback',
    },
    jd: {
      appKey: 'JD7x2c9a2b1e4f80', appSecret: '0fc29a2b1e4f806c3d4e5f6a7b8c9d0e',
      shopId: '1000001873', callback: 'https://cs.gewuzaojing.com/ch/jd/callback',
    },
    pdd: {
      clientId: '4b6c1e2d3f4a5b6c7d8e9f0a1b2c3d4e', clientSecret: '672e4c9a1b2c3d4e5f6a7b8c9d0e1f2a',
      callback: 'https://cs.gewuzaojing.com/ch/pdd/callback',
    },
    douyin: {
      appKey: '6943566850798159396', appSecret: 'c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8',
      shopId: '12312312', callback: 'https://cs.gewuzaojing.com/ch/douyin/callback',
    },
    xhs: {
      appId: 'xhs-gwzj-2026', appSecret: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
      callback: 'https://cs.gewuzaojing.com/ch/xhs/callback',
    },
    wecom: {
      corpId: 'ww0123456789abcdef', secret: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
      token: 'gewu2026kf', aesKey: 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v',
      callback: 'https://cs.gewuzaojing.com/ch/wecom/callback',
    },
    official: {
      callback: 'https://cs.gewuzaojing.com/ch/official/callback',
      signSecret: '9f2a7c1e4b8d3a6f0e5c2b7d9a1f4e8c', ipWhitelist: '203.0.113.10',
    },
  };

  /* ------------------------------------------------------- 演示数据集（默认不加载） */
  /* 产品默认状态是「一个渠道都没接」—— 真实世界里没人替你把店接好。
     下面这份是**演示用**的历史接入快照，只有显式调用 `Channels.demo()` 才会装载。
     注意：接进来不等于一直通 —— token 会过期，京东那条就是故意做成断开的。 */

  var DEMO_SEED = {
    tmall: {
      at: '2026-03-12', volume: 128, today: 22,
      token: { expiresAt: T0 + 213 * DAY, ttl: 365 * DAY, masked: '6102********9f4c', refresh: true },
      account: '格物旗舰店:小满',
      values: {
        appKey: '285****34',
        appSecret: 'a1b2****5d6',
        shopNick: '格物旗舰店:小满',
        callback: 'https://cs.gewuzaojing.com/ch/tmall/callback',
      },
    },
    jd: {
      at: '2026-04-08', volume: 96, today: 0,
      /* 京东 access_token 固定 24 小时 —— 没人续期，它就真的断了 */
      token: { expiresAt: T0 - 3 * HOUR, ttl: 24 * HOUR, masked: '83b5********8af8', refresh: false },
      account: '格物自营旗舰店（vender 1000001873）',
      values: {
        appKey: 'JD7x****c9a2',
        appSecret: '0fc2****36f0',
        shopId: '100****1873',
        callback: 'https://cs.gewuzaojing.com/ch/jd/callback',
      },
    },
    douyin: {
      at: '2026-06-20', volume: 74, today: 4,
      token: { expiresAt: T0 + 2 * DAY + 5 * HOUR, ttl: 7 * DAY, masked: 'a91c********07e3', refresh: true },
      account: '格物美妆旗舰店（shop 12312312）',
      values: {
        appKey: '694****9396',
        appSecret: 'c3d4****71ba',
        shopId: '123****2312',
        callback: 'https://cs.gewuzaojing.com/ch/douyin/callback',
      },
    },
    official: {
      at: '2026-01-05', volume: 41, today: 2,
      token: null, /* 自建渠道无 token，长期有效 */
      account: '自建客服系统',
      values: {
        callback: 'https://cs.gewuzaojing.com/ch/official/callback',
        signSecret: '9f2a****4c1e',
        ipWhitelist: '203.0.113.10',
      },
    },
  };

  /* -------------------------------------------------- 跨渠道足迹（同一用户） */
  /* visible=false 表示这条发生在别的渠道、当前接待渠道看不到 —— 也就是「信息断层」 */

  var FOOTPRINTS = {
    '林小满': [
      { ch: 'xhs', at: '2026-09-12 21:05', kind: '笔记', text: '发了空瓶记，配文写「敏感肌友好」', visible: false },
      { ch: 'taobao', at: '2026-09-18 10:22', kind: '咨询', text: '问客服「烟酰胺浓度是多少」', visible: false },
      { ch: 'tmall', at: '2026-10-11 09:40', kind: '售后', text: '反馈使用两天后刺痛发红', visible: true },
    ],
    '周雨桐': [
      { ch: 'jd', at: '2026-09-26 12:08', kind: '订单', text: '下单紧致抗老精华 30ml', visible: true },
      { ch: 'xhs', at: '2026-10-14 22:31', kind: '评论', text: '在品牌笔记下留言「我要发小红书」', visible: false },
      { ch: 'jd', at: '2026-10-14 22:48', kind: '售后', text: '反馈泛红并索要说法', visible: true },
    ],
    '陈立': [
      { ch: 'douyin', at: '2026-10-13 18:55', kind: '售后', text: '反馈物流停滞，要求退款', visible: true },
      { ch: 'wecom', at: '2026-10-14 09:12', kind: '咨询', text: '在企业微信追问同一笔订单', visible: false },
    ],
    '苏晚晴': [
      { ch: 'tmall', at: '2026-10-10 15:40', kind: '订单', text: '在天猫下了同一款商品', visible: false },
      { ch: 'official', at: '2026-10-14 18:12', kind: '咨询', text: '官网询问会员积分兑换规则', visible: true },
    ],
  };

  /* 用户的跨渠道身份键（合并依据） */
  var IDENTITY_KEYS = {
    '林小满': ['138****2210', 'TM2026092611884'],
    '周雨桐': ['139****8802', 'JD2026092611884'],
    '陈立': ['136****4471', 'DY2026101317552'],
    '苏晚晴': ['135****9033', 'VIP-000875'],
  };

  var KIND_LABEL = {
    'open-api': '开放平台 API',
    'plugin': '插件嵌入',
    'webhook': 'Webhook 回推',
  };

  /* ------------------------------------------------------------------ 校验 */
  /* 规则全部来自各平台文档的硬性格式要求。返回错误消息，空串表示通过。 */

  var RULES = {
    req: function (v) { return String(v || '').trim() ? '' : '必填'; },
    digits8: function (v) { return /^\d{8}$/.test(v) ? '' : '淘宝 AppKey 是 8 位数字（控制台示例：28571234）'; },
    digits19: function (v) { return /^\d{19}$/.test(v) ? '' : '抖店 App Key 是 19 位数字'; },
    digits: function (v) { return /^\d+$/.test(v) ? '' : '只接受数字'; },
    alnum16: function (v) { return /^[A-Za-z0-9]{16}$/.test(v) ? '' : '京东 App Key 是 16 位字母数字'; },
    hex32: function (v) { return /^[a-f0-9]{32}$/i.test(v) ? '' : 'client_id 是 32 位十六进制字符串'; },
    secret: function (v) {
      var s = String(v || '');
      if (!s) return '必填';
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(s)) return '密钥为 16 位以上的字母 / 数字（平台发放的通常是 32 位）';
      return '';
    },
    signSecret: function (v) {
      var s = String(v || '');
      if (!s) return '必填';
      if (s.length < 16) return '签名密钥至少 16 位（建议 32 位随机串）';
      return '';
    },
    wecomCorp: function (v) { return /^ww[a-f0-9]{16}$/.test(v) ? '' : '企业 ID 形如 ww 开头 + 16 位十六进制'; },
    wecomToken: function (v) {
      var s = String(v || '');
      if (!s) return '必填';
      if (!/^[A-Za-z0-9]{1,32}$/.test(s)) return 'Token 只能是字母或数字，且不超过 32 位（企微文档硬性要求）';
      return '';
    },
    aes43: function (v) { return /^[A-Za-z0-9]{43}$/.test(v) ? '' : 'EncodingAESKey 必须恰好 43 位字母数字'; },
    optIp: function (v) { return String(v || '').trim() ? ipListError(v) : ''; },
    https: function (v) { return urlError(v); },
  };

  function ipListError(v) {
    var parts = String(v).split(/[,，\s]+/).filter(Boolean);
    for (var i = 0; i < parts.length; i++) {
      if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(parts[i])) return 'IP 白名单格式应为 IPv4，多个用逗号分隔';
      var seg = parts[i].split('.');
      for (var j = 0; j < seg.length; j++) if (Number(seg[j]) > 255) return 'IP 段取值需在 0–255 之间';
    }
    return '';
  }

  /** 回调地址校验：HTTPS + 公网域名 + 不能是回环 / 内网 / 平台自家域名 */
  function urlError(v, ban) {
    var s = String(v || '').trim();
    if (!s) return '必填';
    var m = s.match(/^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)(\/[^?#]*)?$/i);
    if (!m) return '不是一个完整 URL，需形如 https://域名/路径';
    if (m[1].toLowerCase() !== 'https') return '平台要求回调地址使用 HTTPS（http 会在授权回传时被拒）';
    var host = m[2].split(':')[0].toLowerCase();
    if (/^(localhost|127\.|0\.0\.0\.0|::1)/.test(host)) return '不能使用本机 / 回环地址，平台无法回调到你的开发机';
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return '不能使用内网地址，平台侧访问不到';
    if (host.indexOf('.') === -1) return '需要是完整域名（含顶级域），不能只写主机名';
    if (!m[3] || m[3] === '/') return '需要带具体路径，例如 /ch/tmall/callback';
    var banList = ban || [];
    for (var i = 0; i < banList.length; i++) {
      if (host === banList[i] || host.slice(-(banList[i].length + 1)) === '.' + banList[i]) {
        return '不能使用平台自家域名（' + banList[i] + '），开放平台会拒绝登记';
      }
    }
    return '';
  }

  /** 运行时才能真正判断的占位值 —— 格式合法但一定连不通，留给 probe 阶段报错 */
  var PLACEHOLDER_HOSTS = ['example.com', 'your-domain.com', 'yourdomain.com', 'test.com', 'demo.local', 'abc.com'];
  var SAMPLE_KEYS = ['12345678', '11111111', '00000000', '1234567890123456789', 'ww0000000000000000', 'abcdefghijklmnop'];

  function isPlaceholderHost(v) {
    var m = String(v || '').match(/^https:\/\/([^/?#]+)/i);
    if (!m) return false;
    var host = m[1].split(':')[0].toLowerCase();
    if (PLACEHOLDER_HOSTS.indexOf(host) !== -1) return true;
    if (/\.(test|local|invalid|example)$/.test(host)) return true;
    return false;
  }

  function setupOf(id) {
    var ch = byId(id);
    if (!ch) return null;
    var s = SETUP[ch.setupKey];
    if (!s) return null;
    var out = {};
    Object.keys(s).forEach(function (k) { out[k] = s[k]; });
    out.channelId = ch.id;
    out.channelName = ch.name;
    out.source = ch.source;
    out.setupKey = ch.setupKey;
    out.demo = DEMO_CREDENTIALS[ch.setupKey] || null;
    return out;
  }

  /**
   * 格式校验（本地即时校验，不发起任何请求）。
   * @returns {{ok:boolean, errors:Array<{k:string,label:string,msg:string}>, missing:number}}
   */
  function validate(id, values) {
    var su = setupOf(id);
    var v = values || {};
    if (!su) return { ok: false, errors: [{ k: '_', label: '渠道', msg: '未知渠道' }], missing: 0 };
    var errors = [];
    var missing = 0;
    su.fields.forEach(function (f) {
      var val = String(v[f.k] == null ? '' : v[f.k]).trim();
      if (!val) { missing++; }
      var msg = f.k === 'callback' ? urlError(val, su.callbackBan) : (RULES[f.rule] || RULES.req)(val);
      if (msg) errors.push({ k: f.k, label: f.label, msg: msg });
    });
    if (v.appSecret && v.appKey && String(v.appSecret) === String(v.appKey)) {
      errors.push({ k: 'appSecret', label: 'AppSecret', msg: 'AppSecret 不能与 AppKey 相同（大概率复制错了）' });
    }
    return { ok: errors.length === 0, errors: errors, missing: missing };
  }

  /* ------------------------------------------------------------ 连通性探活 */

  /** 打码：长串固定 8 颗星，短串按实际隐藏长度收星，避免打码后反而比原文长 */
  function maskTail(s, head, tail) {
    var str = String(s || '');
    if (str.length <= head + tail) return str;
    if (str.length <= head + tail + 8) {
      var h = Math.max(1, str.length - head - tail);
      return str.slice(0, head) + new Array(h + 1).join('*') + str.slice(str.length - tail);
    }
    return str.slice(0, head) + '********' + str.slice(str.length - tail);
  }

  /** 本地时区的 ISO 时间（授权时间戳必须带正确时区，否则平台会判非法） */
  function localIso(ms) {
    var d = new Date(ms);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    var off = -d.getTimezoneOffset();
    var sign = off >= 0 ? '+' : '-';
    var oh = Math.floor(Math.abs(off) / 60);
    var om = Math.abs(off) % 60;
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' +
      p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) +
      sign + p(oh) + ':' + p(om);
  }

  function todayIso(ms) {
    var d = new Date(ms);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /** 演示用轻量摘要（真实调用由服务端 SDK 用 MD5 / HMAC 计算，这里只为把「签名」这一步显式化） */
  function digest(str) {
    var h = 2166136261;
    var s = String(str);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    var out = h.toString(16);
    while (out.length < 8) out = '0' + out;
    return out;
  }

  /**
   * 连通性检查：回调地址能不能被平台访问到 + 凭证在平台侧是否有效 + 权限是否已审核。
   * 全部是确定性判定 —— 填示例值就会失败，失败信息按平台真实错误码给。
   * @returns {Promise<{ok:boolean, steps:Array, failed:string}>}
   */
  function probe(id, values, opts) {
    var o = opts || {};
    var su = setupOf(id);
    var v = values || {};
    var ch = byId(id) || { name: id, source: '' };
    if (!su) return Promise.resolve({ ok: false, steps: [], failed: '未知渠道' });

    var keyField = '';
    ['appKey', 'appId', 'clientId', 'corpId'].some(function (k) {
      if (String(v[k] == null ? '' : v[k]).trim()) { keyField = k; return true; }
      return false;
    });
    var keyVal = keyField ? String(v[keyField]).trim() : '';

    var steps = [];
    function push(k, label, ok, detail) { steps.push({ k: k, label: label, ok: !!ok, detail: detail }); }

    /* ① 回调地址可达性 —— 平台保存配置时会真的发一次请求过来 */
    if (isPlaceholderHost(v.callback)) {
      push('callback', '回调地址可达性探测', false,
        'GET ' + v.callback + '?_probe=1 → HTTP 404。平台无法回传授权码，请换成真实部署的公网地址');
    } else {
      push('callback', '回调地址可达性探测', true,
        'GET ' + v.callback + '?_probe=1 → HTTP 200，响应体含 challenge 原样返回');
    }

    /* ② 微信客服额外一步：URL 握手（GET 带 msg_signature / echostr，1 秒内原样返回明文） */
    if (su.setupKey === 'wecom') {
      var aesOk = /^[A-Za-z0-9]{43}$/.test(String(v.aesKey || ''));
      var degenerate = /^(.)\1{42}$/.test(String(v.aesKey || ''));
      push('handshake', 'URL 有效性握手（SHA1 验签 + AES 解密 echostr）',
        aesOk && !degenerate,
        aesOk && !degenerate
          ? 'msg_signature 校验通过，echostr 解密成功，已原样返回明文（不含引号 / BOM / 换行）'
          : '解密失败：EncodingAESKey 无效 —— 企微后台会提示「回调模式配置失败」，此时配置不会生效');
    }

    /* ③ 凭证有效性 —— 平台侧的 appkey 校验 */
    var keyBad = SAMPLE_KEYS.indexOf(keyVal) !== -1;
    if (keyBad) {
      var codeMap = { taobao: 'code:15 Invalid app key', jd: 'code:1001 app_key 不存在', pdd: 'code:10001 invalid client_id', douyin: 'code:10003 app_key 无效', wecom: 'errcode:40013 invalid corpid' };
      push('credential', '凭证有效性校验（' + (keyField || 'appKey') + '）', false,
        '调用 ' + (su.tokenUrl || su.portal) + ' → ' + (codeMap[su.setupKey] || 'code:2001 应用不存在') +
        '。示例值只是文档占位符，真实凭证需到 ' + (su.portal || '平台') + ' 申请');
    } else {
      var ts = localIso(o.now || Date.now());
      push('credential', '凭证有效性校验（' + (keyField || 'appKey') + '）', true,
        keyField + ' 校验通过 · 请求签名 ' + digest(String(v.appSecret || v.clientSecret || v.secret || '') + ts) +
        '（时间戳 ' + ts + '，偏差需 ≤5 分钟）');
    }

    /* ④ 权限范围 */
    push('scope', '接口权限范围核对（' + su.scopes.length + ' 项）', true,
      su.scopes.length + ' 项权限已在平台侧审核通过；' + su.scopeNote);

    var failed = '';
    for (var i = 0; i < steps.length; i++) if (!steps[i].ok) { failed = steps[i].label; break; }
    return Promise.resolve({ ok: !failed, steps: steps, failed: failed });
  }

  /* -------------------------------------------------------------- OAuth 授权 */

  /** state：防 CSRF，真实实现必须由服务端生成并与会话绑定 */
  function newState(opts) {
    var o = opts || {};
    if (o.state != null) return String(o.state);
    var s = '';
    var hex = '0123456789abcdef';
    for (var i = 0; i < 32; i++) s += hex[Math.floor(Math.random() * 16)];
    return s;
  }

  /** 拼接跳转授权页的 URL —— 参数名各平台不同，按文档来 */
  function authUrl(id, values, state) {
    var su = setupOf(id);
    if (!su || !su.authUrl) return '';
    var v = values || {};
    var url = su.authUrl;
    ['appKey', 'appId', 'clientId', 'callback', 'corpId'].forEach(function (k) {
      url = url.replace('{' + k + '}', encodeURIComponent(String(v[k] == null ? '' : v[k])));
    });
    return url.replace('{state}', encodeURIComponent(state || newState()));
  }

  /**
   * 模拟「店铺主账号完成授权后浏览器跳回回调地址」—— 回调地址上会带 code 与 state。
   * @returns {{url:string, code:string, state:string}}
   */
  function mockCallback(id, values, state, opts) {
    var o = opts || {};
    var code = o.code || (function () {
      var s = '';
      var hex = '0123456789abcdef';
      for (var i = 0; i < 32; i++) s += hex[Math.floor(Math.random() * 16)];
      return s;
    })();
    var base = String((values && values.callback) || 'https://callback.local/cb');
    var url = base + (base.indexOf('?') === -1 ? '?' : '&') + 'code=' + code + '&state=' + encodeURIComponent(state || '');
    return { url: url, code: code, state: state || '' };
  }

  /** 用户可能把整个回调 URL 粘进来 —— 真实开发里也常这么干，这里直接帮忙解出来 */
  function parseCode(input) {
    var s = String(input == null ? '' : input).trim();
    if (!s) return { code: '', state: '' };
    var m = s.match(/[?&]code=([^&\s]+)/);
    var st = s.match(/[?&]state=([^&\s]+)/);
    if (m) return { code: decodeURIComponent(m[1]), state: st ? decodeURIComponent(st[1]) : '' };
    return { code: s, state: '' };
  }

  var usedCodes = {};

  /**
   * 用 code 换 access_token。真实开发里这一步必须在服务端做，前端 JS 不许碰 AppSecret。
   * @returns {{ok:boolean, error?:string, code?:string, token?:object, state?:string}}
   */
  function exchange(id, values, input, state, opts) {
    var o = opts || {};
    var su = setupOf(id);
    var v = values || {};
    if (!su) return { ok: false, error: '未知渠道' };
    if (!su.tokenUrl) return { ok: false, error: '该渠道没有 token 交换环节（自建 Webhook 用签名密钥自校验）' };

    var parsed = parseCode(input);
    var code = parsed.code;
    /* state 只能来自回调 URL —— 发起授权时生成的那一份存在服务端会话里，用来比对 */
    var gotState = parsed.state;

    if (!code) {
      return { ok: false, error: '请把浏览器地址栏里那条完整的回调地址粘进来（授权成功后平台会跳到你的回调地址并带上 code）' };
    }
    if (!gotState) {
      return { ok: false, error: '回调地址里没有 state 参数 —— 无法完成 CSRF 校验。请粘贴完整回调地址，不要只复制 code' };
    }
    if (state && gotState !== state) {
      return { ok: false, error: 'state 校验失败（CSRF 防护）：回调里的 state 与发起授权时不一致，已拒绝本次授权' };
    }
    if (usedCodes[code]) {
      return { ok: false, error: '该 code 已被使用（授权码只能消费一次）。请重新发起授权后再试' };
    }
    if (code.length < 16) {
      return { ok: false, error: '授权码无效或已过期（code 有效期约 10 分钟，超时需重新授权）' };
    }

    usedCodes[code] = true;
    var ttl = su.ttl;
    var nowMs = o.now || Date.now();
    /* ttl 为 null 的渠道（如小红书）：以平台返回的 expires_in 为准，不写死 */
    var expiresIn = ttl == null ? (o.expiresIn || 7 * DAY / 1000) : Math.round(ttl / 1000);

    return {
      ok: true,
      code: code,
      state: gotState,
      token: {
        value: 'demo_' + digest(code + v.appKey + v.clientId + v.corpId),
        masked: maskTail(digest(code + (v.appKey || v.clientId || v.corpId || 'x')) + 'demo0000', 4, 4),
        expiresIn: expiresIn,
        expiresAt: nowMs + expiresIn * 1000,
        ttl: ttl,
        /* refresh_token 续期 / gettoken 重新获取 / 无 token 三种模式，别混为一谈 */
        renewMode: renewModeOf(su),
        refresh: true,
        refreshNote: su.ttlHuman,
      },
    };
  }

  function renewModeOf(su) {
    if (su.setupKey === 'official') return 'none';
    if (su.setupKey === 'wecom') return 'gettoken';
    return 'refresh_token';
  }

  /* ------------------------------------------------------------ 接入状态机 */

  var linked = {};
  /** 连上 / 断开的顺序流水，接入面板里可核对 */
  var journal = [];
  /** 当前是否处于「演示数据」状态（界面据此显示标记，避免把演示数据当成真实接入） */
  var demoArmed = false;

  /** 真实默认：一个渠道都没接。接入必须由人一步步走完向导才成立。 */
  function seed() {
    linked = {};
    journal = [];
    usedCodes = {};
    demoArmed = false;
  }

  /**
   * 装载演示数据集：一键还原「四个渠道已接入」的历史快照，用于演示 / 回归测试。
   * 与 seed() 的分工是刻意的 —— 演示是**主动动作**，默认状态永远是干净的。
   */
  function seedDemo() {
    linked = {};
    Object.keys(DEMO_SEED).forEach(function (k) {
      var p = DEMO_SEED[k];
      linked[k] = {
        at: p.at, volume: p.volume, today: p.today,
        account: p.account,
        token: p.token ? {
          value: 'seed', masked: p.token.masked, expiresAt: p.token.expiresAt,
          expiresIn: Math.round((p.token.expiresAt - T0) / 1000), ttl: p.token.ttl,
          renewMode: renewModeOf(SETUP[(byId(k) || {}).setupKey] || {}),
          refresh: p.token.refresh,
        } : null,
        values: p.values || {},
        verified: true,
      };
    });
    journal = [];
    usedCodes = {};
    demoArmed = true;
  }

  function isDemo() { return demoArmed; }

  function byId(id) {
    for (var i = 0; i < CATALOG.length; i++) if (CATALOG[i].id === id) return CATALOG[i];
    return null;
  }

  function isLinked(id) { return !!linked[id]; }

  /** token 生命周期：真实接入里，这一步决定渠道是「通的」还是「断了」 */
  function tokenState(id, nowMs) {
    var l = linked[id];
    if (!l) return { code: 'none', label: '未接入', hoursLeft: null };
    if (!l.token) return { code: 'longterm', label: '长期有效（签名密钥）', hoursLeft: null };
    var now = nowMs || Date.now();
    var left = l.token.expiresAt - now;
    if (left <= 0) {
      var overH = Math.max(1, Math.round(-left / HOUR));
      return {
        code: 'expired',
        hoursLeft: 0,
        label: '授权已过期 ' + (overH >= 24 ? Math.round(overH / 24) + ' 天' : overH + ' 小时') + ' · 消息已中断',
        action: '重新授权',
      };
    }
    var h = left / HOUR;
    var human = h >= 48 ? Math.round(h / 24) + ' 天后过期' : (h >= 1 ? Math.round(h) + ' 小时后过期' : Math.round(left / MIN) + ' 分钟后过期');
    /* 3 天内算临期：京东 24 小时、抖店 7 天这两种周期都必须提前提醒续期 */
    var soon = left <= 3 * DAY;
    return {
      code: soon ? 'soon' : 'ok',
      hoursLeft: h,
      label: '授权有效期还剩 ' + (h >= 48 ? Math.round(h / 24) + ' 天' : Math.round(h) + ' 小时'),
      expiry: human,
      action: soon ? '续期' : '',
    };
  }

  /** 渠道目录：附带接入状态与授权健康度 */
  function list(nowMs) {
    return CATALOG.map(function (ch) {
      var l = linked[ch.id];
      var ts = tokenState(ch.id, nowMs);
      var su = SETUP[ch.setupKey] || {};
      return {
        id: ch.id, name: ch.name, abbr: ch.abbr, kind: ch.kind,
        kindLabel: KIND_LABEL[ch.kind] || ch.kind,
        source: ch.source, caps: ch.caps.slice(), note: ch.note,
        portal: su.portal || '',
        fieldCount: (su.fields || []).length,
        prerequisites: (su.prereq || []).length,
        linked: !!l,
        linkedAt: l ? l.at : '',
        account: l ? (l.account || '') : '',
        tokenMasked: l && l.token ? l.token.masked : '',
        tokenTTL: l && l.token ? l.token.ttl : (su.ttl || null),
        tokenHuman: su.ttlHuman || '',
        tokenState: ts.code,
        tokenLabel: ts.label,
        tokenAction: ts.action || '',
        tokenExpiry: ts.expiry || '',
        credentialPrint: l && l.values ? l.values : {},
        broken: ts.code === 'expired',
        volume: l ? l.volume : 0,
        today: l ? (l.today || 0) : 0,
      };
    });
  }

  function linkedList(nowMs) {
    return list(nowMs).filter(function (c) { return c.linked; });
  }

  function stats(nowMs) {
    var all = list(nowMs);
    var on = all.filter(function (c) { return c.linked; });
    var today = all.reduce(function (s, c) { return s + (c.linked ? c.today : 0); }, 0);
    var volume = all.reduce(function (s, c) { return s + (c.volume || 0); }, 0);
    /* 合并用户只算「至少有一个渠道已接入、且痕迹真的看得见」的人 ——
       一个渠道都没接，就没有任何渠道在往总线送消息，自然也拼不出跨渠道的人。
       口径必须与界面上那张「跨渠道用户合并」列表完全一致，否则指标会撒谎。 */
    var merges = mergeAll().filter(function (m) { return m.reachable > 0; });
    var broken = on.filter(function (c) { return c.broken; });
    var expiring = on.filter(function (c) { return c.tokenState === 'soon'; });
    return {
      total: all.length,
      connected: on.length,
      available: all.length - on.length,
      todayMessages: today,
      historyMessages: volume,
      mergedUsers: merges.length,
      gapUsers: merges.filter(function (m) { return m.gaps > 0; }).length,
      gapItems: merges.reduce(function (s, m) { return s + m.gaps; }, 0),
      broken: broken.length,
      brokenNames: broken.map(function (c) { return c.name; }),
      expiring: expiring.length,
      expiringNames: expiring.map(function (c) { return c.name; }),
    };
  }

  /**
   * 提交接入：把向导填好的凭证与换回来的 token 落库。
   * 没有凭证直接拒绝 —— 这是「一键接入」和「真实接入」的分界线。
   * @param {string} id
   * @param {{values:object, token:object, at?:string, account?:string, now?:number}} cred
   */
  function commit(id, cred) {
    var c = cred || {};
    var ch = byId(id);
    if (!ch) return { ok: false, reason: '未知渠道' };
    if (linked[id] && !c.replace) return { ok: false, reason: '该渠道已接入' };
    var su = setupOf(id);
    var prev = linked[id];
    var v = c.values || {};

    /* 重新授权只换 token，凭证沿用库里那份（凭证本来就不该再传一遍） */
    if (c.reuse && prev) {
      v = prev.values || {};
    } else {
      var check = validate(id, v);
      if (!check.ok) {
        return { ok: false, reason: '凭证未通过校验：' + check.errors[0].msg, errors: check.errors };
      }
    }
    if (su.tokenUrl && !c.token) {
      return { ok: false, reason: '还差店铺授权：需要用 code 换取 access_token 之后才能接入' };
    }

    var at = c.at || todayIso(c.now || Date.now());
    linked[id] = {
      at: at,
      volume: prev ? prev.volume || 0 : 0,
      today: prev ? prev.today || 0 : 0,
      account: c.account || (prev ? prev.account : '') ||
        v.shopNick || v.shopId || v.corpId || v.appId || v.clientId || v.appKey || '',
      token: c.token || (prev ? prev.token : null),
      values: c.reuse && prev ? (prev.values || {}) : maskValues(su, v),
      verified: true,
    };
    journal.push({
      at: at, action: c.replace ? '重新授权' : '接入', id: id,
      note: '凭证校验 + 店铺授权完成',
    });
    return { ok: true, id: id, at: at, replaced: !!c.replace };
  }

  /** 凭证在界面上只以打码形式留痕，原文不落库 */
  function maskValues(su, v) {
    var out = {};
    (su.fields || []).forEach(function (f) {
      var val = String(v[f.k] == null ? '' : v[f.k]);
      if (!val) return;
      out[f.k] = f.secret ? maskTail(val, 4, 2) : (f.k === 'callback' ? val : maskTail(val, 3, 2));
    });
    return out;
  }

  /** 续期：refresh_token 续期 / gettoken 重新获取 —— 不改凭证，但要注意 mode 不同 */
  function renew(id, opts) {
    var o = opts || {};
    var l = linked[id];
    if (!l) return { ok: false, reason: '该渠道未接入' };
    if (!l.token) return { ok: false, reason: '该渠道没有 token，无需续期' };
    var su = SETUP[byId(id).setupKey];
    var mode = l.token.renewMode || renewModeOf(su);
    if (mode === 'none') return { ok: false, reason: '该渠道没有 token，无需续期' };
    if (mode === 'refresh_token' && !l.token.refresh) {
      return { ok: false, reason: 'refresh_token 已失效，必须重新走一遍店铺授权（' + su.vendor + '）' };
    }
    var ttl = su.ttl || 7 * DAY;
    l.token.expiresAt = (o.now || Date.now()) + ttl;
    l.token.expiresIn = Math.round(ttl / 1000);
    journal.push({
      at: todayIso(o.now || Date.now()),
      action: mode === 'gettoken' ? '续期（gettoken 重新获取）' : '续期（refresh_token）',
      id: id,
    });
    return { ok: true, id: id, mode: mode, tokenState: tokenState(id, o.now) };
  }

  function disconnect(id) {
    if (!linked[id]) return false;
    var l = linked[id];
    delete linked[id];
    journal.push({
      at: todayIso(Date.now()), action: '断开', id: id,
      note: l.account ? '解除 ' + l.account + ' 的授权' : '',
    });
    return true;
  }

  function reset() {
    seed();
  }

  function log() { return journal.slice(); }

  /* ---------------------------------------------------- 跨渠道用户合并 */

  /** 把一个客户的足迹拆成「渠道 → 条数」 */
  function channelTally(foot) {
    var seen = {};
    var out = [];
    (foot || []).forEach(function (f) {
      if (seen[f.ch]) { seen[f.ch].n++; return; }
      seen[f.ch] = { id: f.ch, n: 1 };
      out.push(seen[f.ch]);
    });
    return out.map(function (x) {
      var ch = byId(x.id) || { name: x.id, abbr: '?', linked: false };
      return {
        id: x.id, name: ch.name, abbr: ch.abbr, count: x.n,
        linked: !!linked[x.id],
      };
    });
  }

  /**
   * 合并单个用户：把各渠道痕迹按时间排序，并数出「本渠道看不到」的条数。
   * @param {{id?:string, name:string, member?:string}} cust
   */
  function merge(cust) {
    var name = (cust && cust.name) || '';
    var foot = (FOOTPRINTS[name] || []).slice();
    foot.sort(function (a, b) { return String(a.at).localeCompare(String(b.at)); });

    var timeline = foot.map(function (f) {
      var ch = byId(f.ch) || { name: f.ch, abbr: '?', kind: 'webhook' };
      return {
        ch: f.ch, chName: ch.name, abbr: ch.abbr,
        kind: f.kind, at: f.at, text: f.text,
        visible: f.visible !== false,
        reachable: !!linked[f.ch],
      };
    });

    /* 断层 = 发生在别的渠道、当前接待渠道看不到，且那个渠道其实已经接进来了 */
    var gaps = timeline.filter(function (t) { return !t.visible && t.reachable; }).length;
    var dark = timeline.filter(function (t) { return !t.visible && !t.reachable; }).length;

    return {
      id: (cust && cust.id) || name,
      name: name,
      member: (cust && cust.member) || '',
      keys: (IDENTITY_KEYS[name] || []).slice(),
      channels: channelTally(foot),
      channelCount: channelTally(foot).length,
      timeline: timeline,
      gaps: gaps,
      dark: dark,
      reachable: timeline.filter(function (t) { return t.reachable; }).length,
    };
  }

  /** 合并全部客户（contacts 形如 [{ name, member, crm }]） */
  function mergeAll(contacts) {
    var list0 = contacts;
    if (!list0) {
      list0 = Object.keys(FOOTPRINTS).map(function (n) {
        return { id: n, name: n, member: '' };
      });
    }
    return list0
      .map(function (c) { return merge(c); })
      .filter(function (m) { return m.timeline.length > 0; });
  }

  /**
   * 展示口径的合并列表：在 mergeAll 之上再要求「至少一个渠道已接入」。
   * 这是界面列表与统计指标共用的同一把尺子 —— 没接渠道就没有可见痕迹，
   * 不能出现「指标说合并了 4 个人、列表却空着」这种自相矛盾。
   */
  function merges(contacts) {
    return mergeAll(contacts).filter(function (m) { return m.reachable > 0; });
  }

  /**
   * 未接入渠道的「盲区」估算：这些渠道上的消费者声音，当前完全听不到。
   * 用已接入渠道的人均消息量外推 —— 明确标注是估算，不假装是实测。
   */
  function blindSpots(contacts) {
    var all = list();
    var off = all.filter(function (c) { return !c.linked; });
    var on = all.filter(function (c) { return c.linked; });
    var avg = on.length ? on.reduce(function (s, c) { return s + c.volume; }, 0) / on.length : 0;
    var base = mergeAll(contacts).length || 1;
    return off.map(function (c) {
      return {
        id: c.id, name: c.name, abbr: c.abbr,
        estimate: Math.round(avg * 0.6),
        usersEstimate: Math.max(1, Math.round(base * 0.15)),
        note: c.note,
      };
    });
  }

  seed();

  return {
    VERSION: VERSION,
    CATALOG: CATALOG,
    SETUP: SETUP,
    KIND_LABEL: KIND_LABEL,
    FOOTPRINTS: FOOTPRINTS,

    list: list,
    linkedList: linkedList,
    byId: byId,
    setupOf: setupOf,
    isLinked: isLinked,
    stats: stats,
    tokenState: tokenState,

    validate: validate,
    probe: probe,
    authUrl: authUrl,
    newState: newState,
    mockCallback: mockCallback,
    parseCode: parseCode,
    exchange: exchange,
    commit: commit,
    renew: renew,
    disconnect: disconnect,
    reset: reset,
    demo: seedDemo,
    isDemo: isDemo,
    log: log,

    merge: merge,
    mergeAll: mergeAll,
    merges: merges,
    channelTally: channelTally,
    blindSpots: blindSpots,

    /* 供测试用的内部细节 */
    _urlError: urlError,
    _digest: digest,
  };
});
