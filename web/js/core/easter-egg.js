/* ============================================================
 * easter-egg.js — 彩蛋角色卡
 *
 * 两类彩蛋：
 *   1) CELEBRITIES —— 古今中外的名人，作为「世界设定」参与随机生成。
 *      他们有自己的时代、所在地与身份，走的是和其他角色完全一样的生成流程
 *      （同一套职业/技能/装备/背景规则引擎），所以卡片一定是合规可用的。
 *      例如：爱因斯坦、诸葛亮、莎士比亚、李白、摩根·弗里丹、弗洛伊德…
 *      命中率刻意压得很低（约 4%），命中时卡片上带一个 🥚 标记。
 *
 *   2) FRIENDS —— 作者本人与跑团成员（茶叶蛋、秦九、北北、小张、乌龟、阿肆、年年、R.B）。
 *      全部固定属性、全部「现代」时代。命中时整张卡就是那个人，
 *      属性稍微高一点（跑团团宠体质），并带一个 🎭 标记。
 *
 * 抽签规则：每次 generate() 调用只在「没有显式指定设定」时抽一次彩蛋，
 * 抽中就把该彩蛋作为 profile 注入 preset.build()，让本地规则引擎接手数值。
 * 这样既保证「能被抽到」，又不会让彩蛋绕过规则自检。
 * ============================================================ */
(function (global) {
  'use strict';

  /* ============================================================
   * 一、古今中外名人
   * attrs 是「大致范围」，preset 会做合法化处理；
   * occ 优先用中文名，匹配不到就由 occPrefer 随机挑。
   * ============================================================ */
  var CELEBRITIES = [
    /* ---- 中国 · 古代 ---- */
    { name: '诸葛亮', gender: '男', era: '自定义', eraCustom: '三国 · 蜀汉', country: '中国',
      city: '成都', town: '琅琊', setting: 'cn-ancient', occ: '军官', age: 27,
      attrs: { str: 45, con: 60, siz: 62, dex: 75, app: 70, int: 95, pow: 90, edu: 95, luck: 75 },
      idea: '鞠躬尽瘁，死而后已。', trait: '冷静、缜密、过于自责' },
    { name: '李白', gender: '男', era: '自定义', eraCustom: '唐 · 开元', country: '中国',
      city: '长安', town: '碎叶', setting: 'cn-ancient', occ: '作家', age: 32,
      attrs: { str: 55, con: 55, siz: 60, dex: 80, app: 92, int: 88, pow: 78, edu: 75, luck: 82 },
      idea: '天生我材必有用。', trait: '狂放、浪漫、刀子嘴豆腐心' },
    { name: '苏轼', gender: '男', era: '自定义', eraCustom: '北宋', country: '中国',
      city: '杭州', town: '眉州', setting: 'cn-ancient', occ: '政府官员', age: 40,
      attrs: { str: 58, con: 66, siz: 63, dex: 72, app: 74, int: 92, pow: 85, edu: 90, luck: 66 },
      idea: '此心安处是吾乡。', trait: '豁达、幽默、吃货' },
    { name: '扁鹊', gender: '男', era: '自定义', eraCustom: '春秋战国', country: '中国',
      city: '邯郸', town: '渤海', setting: 'cn-ancient', occ: '医生', age: 50,
      attrs: { str: 50, con: 68, siz: 64, dex: 80, app: 68, int: 90, pow: 75, edu: 88, luck: 60 },
      idea: '上医医未病之病。', trait: '冷静、直言、不讨人喜欢' },
    { name: '戚继光', gender: '男', era: '自定义', eraCustom: '明 · 抗倭', country: '中国',
      city: '福州', town: '义乌', setting: 'cn-ancient', occ: '军官', age: 34,
      attrs: { str: 82, con: 78, siz: 76, dex: 84, app: 70, int: 80, pow: 84, edu: 76, luck: 70 },
      idea: '封侯非我意，但愿海波平。', trait: '务实、狠得下心、护短' },

    /* ---- 中国 · 近代 / 现代 ---- */
    { name: '张骞', gender: '男', era: '自定义', eraCustom: '西汉', country: '中国',
      city: '长安', town: '成皋', setting: 'cn-ancient', occ: '探险家（古典）', age: 38,
      attrs: { str: 60, con: 70, siz: 65, dex: 72, app: 66, int: 86, pow: 88, edu: 82, luck: 52 },
      idea: '凿空。', trait: '坚韧、执着、认死理' },
    { name: '宋慈', gender: '男', era: '自定义', eraCustom: '南宋', country: '中国',
      city: '建阳', town: '闽县', setting: 'cn-ancient', occ: '法医', age: 45,
      attrs: { str: 58, con: 66, siz: 64, dex: 74, app: 64, int: 90, pow: 80, edu: 92, luck: 62 },
      idea: '洗冤骨者，众善之归。', trait: '严谨、不通人情、认证据不认人' },
    { name: '沈括', gender: '男', era: '自定义', eraCustom: '北宋', country: '中国',
      city: '杭州', town: '钱塘', setting: 'cn-ancient', occ: '教授/学者', age: 45,
      attrs: { str: 52, con: 64, siz: 62, dex: 70, app: 66, int: 94, pow: 76, edu: 96, luck: 64 },
      idea: '百工皆可究。', trait: '博闻、专注、记性过分好' },
    { name: '李时珍', gender: '男', era: '自定义', eraCustom: '明 · 医药', country: '中国',
      city: '蕲州', town: '黄冈', setting: 'cn-ancient', occ: '医生', age: 52,
      attrs: { str: 55, con: 70, siz: 66, dex: 68, app: 66, int: 92, pow: 84, edu: 90, luck: 58 },
      idea: '身如逆流船，心比铁石坚。', trait: '耐性极好、偏执于事' },

    /* ---- 西方 ---- */
    { name: '爱因斯坦', gender: '男', era: '1920年代', country: '德国',
      city: '柏林', town: '乌尔姆', setting: 'eu-modern', occ: '教授/学者', age: 40,
      attrs: { str: 42, con: 58, siz: 60, dex: 66, app: 62, int: 97, pow: 82, edu: 98, luck: 78 },
      idea: '上帝不掷骰子。', trait: '健忘、固执、只讲自己在意的事' },
    { name: '摩根·弗里丹', gender: '女', era: '1920年代', country: '美国',
      city: '纽约', town: '波士顿', setting: 'us-1920', occ: '证券经纪人', age: 36,
      attrs: { str: 48, con: 64, siz: 60, dex: 74, app: 72, int: 94, pow: 90, edu: 90, luck: 80 },
      idea: '投资未来。', trait: '强硬、精准、绝不认输' },
    { name: '西格蒙德·弗洛伊德', gender: '男', era: '1920年代', country: '奥地利',
      city: '维也纳', town: '弗赖堡', setting: 'uk-victorian', occ: '精神病学家', age: 52,
      attrs: { str: 44, con: 56, siz: 62, dex: 58, app: 60, int: 92, pow: 78, edu: 95, luck: 48 },
      idea: '.Id 就是一切。', trait: '偏执、爱下判断、烟斗不离手' },
    { name: '尼古拉·特斯拉', gender: '男', era: '1920年代', country: '塞尔维亚',
      city: '纽约', town: '利皮卡', setting: 'us-1920', occ: '工程师', age: 44,
      attrs: { str: 50, con: 62, siz: 66, dex: 78, app: 68, int: 96, pow: 80, edu: 90, luck: 58 },
      idea: '未来属于电。', trait: '孤僻、完美主义、怕被人碰' },
    { name: '玛丽·居里', gender: '女', era: '1920年代', country: '波兰',
      city: '巴黎', town: '华沙', setting: 'uk-victorian', occ: '科学家', age: 38,
      attrs: { str: 42, con: 60, siz: 58, dex: 70, app: 66, int: 95, pow: 88, edu: 93, luck: 60 },
      idea: '没有什么能阻挡 Curie。', trait: '沉默、极勤、不管闲事' },
    { name: '阿尔弗雷德·贝恩', gender: '男', era: '1920年代', country: '英国',
      city: '伦敦', town: '贝尔法斯特', setting: 'uk-victorian', occ: '心理学家、精神分析学家', age: 30,
      attrs: { str: 46, con: 58, siz: 64, dex: 72, app: 70, int: 90, pow: 84, edu: 86, luck: 66 },
      idea: '大多数精神病只是不合群。', trait: '傲慢、清醒、敢当面说' },
    { name: '弗兰肯斯坦', gender: '男', era: '维多利亚时代', country: '英国',
      city: '日内瓦', town: '斯特拉斯堡', setting: 'uk-victorian', occ: '科学家', age: 28,
      attrs: { str: 72, con: 70, siz: 76, dex: 66, app: 62, int: 86, pow: 74, edu: 88, luck: 34 },
      idea: '我不要奴隶，我要有自由。', trait: '孤独、执念、不知收敛' },

    /* ---- 日本 / 俄国 / 其他 ---- */
    { name: '宫崎骏', gender: '男', era: '现代', country: '日本',
      city: '东京', town: '东京', setting: 'jp-modern', occ: '艺术家', age: 56,
      attrs: { str: 50, con: 70, siz: 62, dex: 66, app: 64, int: 90, pow: 86, edu: 85, luck: 76 },
      idea: '画不出来的东西就画到能画为止。', trait: '温和、固执、熬夜' },
    { name: '陀思妥耶夫斯基', gender: '男', era: '19世纪', country: '俄国',
      city: '圣彼得堡', town: '莫斯科', setting: 'ru-19c', occ: '作家', age: 47,
      attrs: { str: 52, con: 64, siz: 66, dex: 70, app: 64, int: 92, pow: 88, edu: 84, luck: 42 },
      idea: '我只担心一个问题：人会不会受苦。', trait: '极端、赌徒、反复自我审判' },
    { name: '夏洛克·福尔摩斯', gender: '男', era: '维多利亚时代', country: '英国',
      city: '伦敦', town: '纽卡斯尔', setting: 'uk-victorian', occ: '咨询侦探', age: 42,
      attrs: { str: 62, con: 70, siz: 70, dex: 84, app: 72, int: 96, pow: 80, edu: 90, luck: 72 },
      idea: '排除掉不可能，剩下的再离奇也是真的。', trait: '刻薄、专注、对推理上瘾' },
    { name: '爱伦·坡', gender: '男', era: '维多利亚时代', country: '美国',
      city: '巴尔的摩', town: '波士顿', setting: 'us-1920', occ: '作家', age: 38,
      attrs: { str: 48, con: 56, siz: 60, dex: 66, app: 66, int: 90, pow: 72, edu: 84, luck: 44 },
      idea: '疯了才会看见真相。', trait: '阴郁、酗酒、对死亡过分熟悉' },
    { name: '海明威', gender: '男', era: '1920年代', country: '美国',
      city: '巴黎', town: '橡树公园', setting: 'us-1920', occ: '作家', age: 45,
      attrs: { str: 66, con: 78, siz: 70, dex: 74, app: 76, int: 86, pow: 82, edu: 80, luck: 70 },
      idea: '一个人可以被毁灭，但不能被打败。', trait: '硬汉、酗酒、怕软' },
    { name: '李小龙', gender: '男', era: '近未来', country: '中国香港',
      city: '香港', town: '旧金山', setting: 'nearfuture', occ: '演员-电影演员', age: 32,
      attrs: { str: 76, con: 80, siz: 72, dex: 88, app: 84, int: 80, pow: 88, edu: 62, luck: 70 },
      idea: '我不是一个传统的中国人。', trait: '暴烈、自律、不肯解释自己' }
  ];

  /* ============================================================
   * 二、作者与跑团成员（固定卡，属性稍高）
   *
   * v2.11.5（用户要求）：
   *   · occ 改为各成员的**真实职业**，并对应到 app 职业表里的**精确职业名**
   *     （表里没有「教练 / 银行职员 / 画师」这些叫法，取最接近的真实职业，
   *      否则 occupationByName 匹配不到 → 静默回退随机职业）；
   *   · 籍贯（town）：除阿肆 = 六安外，一律**宿州**；
   *   · 住所（city）：除阿肆 = 宿校外**不写该字段** —— toProfile 里
   *     `residence: d.city`，d.city 为空即走 preset 的「从世界设定城市里随机」分支。
   * ============================================================ */
  var FRIENDS = [
    { key: 'chadan', name: '茶叶蛋', gender: '男', age: 30, era: '现代', setting: 'cn-modern', occ: '政府官员',
      town: '宿州', attrs: { str: 68, con: 72, siz: 70, dex: 76, app: 70, int: 80, pow: 82, edu: 78, luck: 72 },
      idea: '先查清楚，再动手。', trait: '嘴上没正形、关键时刻靠得住、爱记录' },
    { key: 'qinjiu', name: '秦九', gender: '女', age: 27, era: '现代', setting: 'cn-modern', occ: '白领工人-中高层管理人员',
      town: '宿州', attrs: { str: 55, con: 64, siz: 60, dex: 78, app: 76, int: 86, pow: 78, edu: 84, luck: 70 },
      idea: '真相值得跑一趟。', trait: '好奇、追着线索不放、嘴上不饶人' },
    { key: 'beibei', name: '北北', gender: '女', age: 26, era: '现代', setting: 'cn-modern', occ: '艺术家',
      town: '宿州', attrs: { str: 52, con: 70, siz: 58, dex: 70, app: 72, int: 78, pow: 84, edu: 80, luck: 74 },
      idea: '人活着总有办法。', trait: '稳、细心、照顾所有人' },
    { key: 'xiaozhang', name: '小张', gender: '男', age: 29, era: '现代', setting: 'cn-modern', occ: '运动员（网球）',
      town: '宿州', attrs: { str: 58, con: 62, siz: 64, dex: 74, app: 66, int: 90, pow: 70, edu: 88, luck: 68 },
      idea: '先跑起来再修。', trait: '话少、反应快、认死理' },
    { key: 'wugui', name: '乌龟', gender: '男', age: 31, era: '现代', setting: 'cn-modern', occ: '设计师',
      town: '宿州', attrs: { str: 66, con: 76, siz: 72, dex: 62, app: 68, int: 84, pow: 78, edu: 82, luck: 76 },
      idea: '急的人买不到好东西。', trait: '慢条斯理、眼里有活、记性极好' },
    { key: 'asi', name: '阿肆', gender: '女', age: 28, era: '现代', setting: 'cn-modern', occ: '小企业家',
      city: '宿州', town: '六安', attrs: { str: 58, con: 66, siz: 60, dex: 76, app: 70, int: 88, pow: 80, edu: 86, luck: 66 },
      idea: '伤口会说话。', trait: '冷静、逻辑洁癖、见不得含糊结论' },
    { key: 'niannian', name: '年年', gender: '男', age: 30, era: '现代', setting: 'cn-modern', occ: '白领工人-职员、主管',
      town: '宿州', attrs: { str: 70, con: 74, siz: 70, dex: 72, app: 70, int: 78, pow: 86, edu: 76, luck: 80 },
      idea: '人齐了就开始。', trait: '罩得住场、记着每个人的名字' },
    { key: 'rb', name: 'R.B', gender: '男', age: 32, era: '现代', setting: 'cn-modern', occ: '政府官员',
      town: '宿州', attrs: { str: 72, con: 76, siz: 70, dex: 74, app: 68, int: 76, pow: 80, edu: 72, luck: 74 },
      idea: '能站着就别坐着。', trait: '能扛、话不多、认死理' }
  ];

  /* ---------- 抽签 ---------- */
  function pickOne(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  /* ---------- 抽签 ----------
   *
   * ⚠️ 概率是按「单张卡」算的，但玩家的实际操作单位是**一次出 5 张**。
   * 早先定成 friendRate=1.2% / celebRate=4%，听着像 5.2%，
   * 实测「点一次生成随机角色」只有 **23.5%** 的批次能出彩蛋、
   * 只有 **5.8%** 能碰到任意一位跑团成员 —— 相当于要点 17 次，
   * 玩家实际感受就是「这功能好像没生效」。
   *
   * 现在按「一次生成（5 张）」反推单卡概率，让体感概率落在这里：
   *   一次出 5 张，约 40% 的批次里能看到彩蛋；其中约一半是跑团成员。
   *   换算成单张卡：朋友 ~2.6%、名人 ~6.6%。
   *   （一次出 5 张至少中一个 = 1-(1-0.092)^5 ≈ 38.5%）
   */
  var DEFAULT_FRIEND_RATE = 0.026;   // 单张卡 ~2.6%（roll() 兜底用）
  var DEFAULT_CELEB_RATE  = 0.066;   // 单张卡 ~6.6%

  /* 批级概率（一整批只抽一次）—— preset.generate() 走这条 */
  var BATCH_FRIEND_RATE = 0.25;      // 25% 的批次有一位跑团成员
  var BATCH_CELEB_RATE  = 0.25;      // 25% 的批次有一位名人

  /**
   * 抽一个彩蛋。
   * @param {object} opt { rate 名人命中率, friendRate 朋友命中率 }
   * @returns {object|null} { kind:'celeb'|'friend', data:{...} }
   */
  function roll(opt) {
    opt = opt || {};
    var friendRate = opt.friendRate === undefined ? DEFAULT_FRIEND_RATE : opt.friendRate;
    var celebRate = opt.rate === undefined ? DEFAULT_CELEB_RATE : opt.rate;
    var r = Math.random();
    if (r < friendRate) {
      return { kind: 'friend', data: pickOne(FRIENDS) };
    }
    if (r < friendRate + celebRate) {
      return { kind: 'celeb', data: pickOne(CELEBRITIES) };
    }
    return null;
  }

  /**
   * **批级**抽签 —— 这是 preset.generate() 实际调用的入口。
   *
   * 玩家的操作单位是「点一次，出 5 张」。按单卡算概率时，
   * 跑团成员只有 7 个，摊到单张卡上低到「点一次才 13%」，
   * 体感就是「这功能没生效」。所以这里改成整批只抽一次：
   *   · 约 1/4 的批次安排一位跑团成员（🎭）
   *   · 约 1/4 的批次安排一位名人（🥚）
   *   · 其余 1/2 批次全是普通随机卡
   * 一批最多一个彩蛋，且 preset 会把它固定放在中间那张。
   *
   * @param {number} n 这一批要出几张（不传按 5）
   * @returns {object|null} { kind, data }
   */
  function rollBatch(n) {
    n = parseInt(n, 10) || 5;
    var r = Math.random();
    if (r < BATCH_FRIEND_RATE) {
      return { kind: 'friend', data: pickOne(FRIENDS) };
    }
    if (r < BATCH_FRIEND_RATE + BATCH_CELEB_RATE) {
      return { kind: 'celeb', data: pickOne(CELEBRITIES) };
    }
    return null;
  }

  /** 彩蛋注入 preset.build() 的 profile */
  function toProfile(egg) {
    if (!egg) return null;
    var d = egg.data;
    var pf = {
      name: d.name,
      gender: d.gender,
      age: d.age,
      era: d.era,
      eraCustom: d.eraCustom,
      setting: d.setting,
      occupationName: d.occ,
      attributes: Object.assign({}, d.attrs),
      /* v2.11.5：居住地 / 籍贯的语义 —— town=籍贯（固定），city=住所。
         · 跑团成员：籍贯一律宿州（阿肆=六安）；**除阿肆外不写 city**，
           住所由 preset 从世界设定城市里随机取（用户要求「住所改为随机」）。
         · 名人彩蛋：两者都写，保持「茶叶蛋·现居宿州」这类彩蛋一致性。
         注意 preset 侧 `residence = pf.residence || pf.city || 随机城市`，
         city 缺省即走随机分支，不需要在这里兜底。 */
      residence: d.city,
      birthplace: d.town,
      playerName: egg.kind === 'friend' ? '茶叶蛋调查员协会' : '预设调查员',
      /* 这两个字段会被 preset 的背景生成器采纳 */
      ideology: d.idea,
      traits: d.trait,
      /* v2.1.9（用户第 3 项）：彩蛋卡的背景**心理症状**不在此处指定 ——
         交给 preset.build() 走 CocMadness.backgroundText 的新疯狂表逻辑
         （8/10 总结症状、各 1/10 恐惧症 / 狂躁症），与随机角色池 / AI 卡一致。 */
      isEasterEgg: true,
      eggKind: egg.kind
    };
    return pf;
  }

  global.CocEasterEgg = {
    celebrities: CELEBRITIES,
    friends: FRIENDS,
    roll: roll,
    /* 批级抽签：preset.generate() 用这个，一批最多一个彩蛋 */
    rollBatch: rollBatch,
    /* 概率常量对外暴露，审计脚本直接读它核对文档与实现是否一致 */
    rates: {
      batchFriend: BATCH_FRIEND_RATE,
      batchCeleb: BATCH_CELEB_RATE,
      cardFriend: DEFAULT_FRIEND_RATE,
      cardCeleb: DEFAULT_CELEB_RATE
    },
    toProfile: toProfile,
    /* 审计 / 测试用：不带随机性 */
    all: function () {
      return CELEBRITIES.map(function (c) { return { kind: 'celeb', data: c }; })
        .concat(FRIENDS.map(function (f) { return { kind: 'friend', data: f }; }));
    },
    size: CELEBRITIES.length + FRIENDS.length
  };
})(window);
