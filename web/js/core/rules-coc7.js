/* ============================================================
 * rules-coc7.js — COC 7th 规则系统 (RuleSystem)
 *
 * 本项目最重要的架构约束：
 *   所有规则计算集中在此，UI 层不得硬编码任何公式。
 *   新增规则系统只需新增一个同类模块并注册到 RuleRegistry。
 * ============================================================ */
(function (global) {
  'use strict';

  var D = global.COCDice;

  /* ---------- 属性定义 ---------- */
  var ATTRIBUTES = [
    { key: 'str',  abbr: 'STR',  name: '力量', desc: '肌肉能力的量化。决定近战伤害加值。' },
    { key: 'con',  abbr: 'CON',  name: '体质', desc: '健康、生气和活力。' },
    { key: 'siz',  abbr: 'SIZ',  name: '体型', desc: '身高和体重整合成的数字。' },
    { key: 'dex',  abbr: 'DEX',  name: '敏捷', desc: '迅捷灵敏程度，决定闪避初始值。' },
    { key: 'app',  abbr: 'APP',  name: '外貌', desc: '肉体吸引力和人格魅力。' },
    { key: 'int',  abbr: 'INT',  name: '智力', desc: '学习力、理解力、信息分析力。决定兴趣技能点。' },
    { key: 'pow',  abbr: 'POW',  name: '意志', desc: '心意的力量。决定初始理智与魔法值。' },
    { key: 'edu',  abbr: 'EDU',  name: '教育', desc: '受教育的程度。决定母语初始值。' },
    { key: 'luck', abbr: 'LUCK', name: '幸运', desc: '运气。初始值之后不再起作用，上限永远是 99。', optional: true }
  ];

  var ATTR_MAP = {};
  ATTRIBUTES.forEach(function (a) { ATTR_MAP[a.key] = a; });

  var CN2KEY = {
    '力量': 'str', 'STR': 'str', 'str': 'str',
    '体质': 'con', 'CON': 'con', 'con': 'con',
    '体型': 'siz', 'SIZ': 'siz', 'siz': 'siz',
    '敏捷': 'dex', 'DEX': 'dex', 'dex': 'dex',
    '外貌': 'app', 'APP': 'app', 'app': 'app',
    '智力': 'int', '灵感': 'int', 'INT': 'int', 'int': 'int',
    '意志': 'pow', 'POW': 'pow', 'pow': 'pow',
    '教育': 'edu', 'EDU': 'edu', 'edu': 'edu',
    '幸运': 'luck', '运气': 'luck', 'LUCK': 'luck', 'luck': 'luck'
  };

  /* ---------- 属性生成规则 ---------- */
  var GEN = {
    min: 15, max: 90, step: 5,
    /** 随机掷骰方案 (COC 7e 标准) */
    randomDice: {
      str: [3, 6, 0], con: [3, 6, 0], dex: [3, 6, 0],
      app: [3, 6, 0], pow: [3, 6, 0], luck: [3, 6, 0],
      siz: [2, 6, 6], int: [2, 6, 6], edu: [2, 6, 6]
    }
  };

  /* ---------- 年龄调整表 ----------
     physLoss 是「力量/体质/敏捷三项合计」要扣的总量，由本引擎平均分摊
     （见 spreadLoss），单项最低扣到 15 为止，不会把某一项扣穿。 */
  var AGE_TABLE = [
    { max: 19, physLoss: 5,   appLoss: 0,  movLoss: 0, eduChecks: 0, note: '力量与体型合计 −5（平均分摊），之后骰 2 次幸运取较大值' },
    { max: 39, physLoss: 0,   appLoss: 0,  movLoss: 0, eduChecks: 1, note: '无属性扣减，教育进步检定 1 次' },
    { max: 49, physLoss: 5,   appLoss: 5,  movLoss: 1, eduChecks: 2, note: '力量/体质/敏捷合计 −5（三项平均分摊），外貌 −5，移动 −1，教育进步检定 2 次' },
    { max: 59, physLoss: 10,  appLoss: 10, movLoss: 2, eduChecks: 3, note: '力量/体质/敏捷合计 −10（三项平均分摊），外貌 −10，移动 −2，教育进步检定 3 次' },
    { max: 69, physLoss: 20,  appLoss: 15, movLoss: 3, eduChecks: 4, note: '力量/体质/敏捷合计 −20（三项平均分摊），外貌 −15，移动 −3，教育进步检定 4 次' },
    { max: 79, physLoss: 40,  appLoss: 20, movLoss: 4, eduChecks: 4, note: '力量/体质/敏捷合计 −40（三项平均分摊），外貌 −20，移动 −4，教育进步检定 4 次' },
    { max: 89, physLoss: 80,  appLoss: 25, movLoss: 5, eduChecks: 4, note: '力量/体质/敏捷合计 −80（三项平均分摊），外貌 −25，移动 −5，教育进步检定 4 次' },
    { max: 999, physLoss: 80, appLoss: 25, movLoss: 5, eduChecks: 4, note: '力量/体质/敏捷合计 −80（三项平均分摊），外貌 −25，移动 −5，教育进步检定 4 次' }
  ];

  function ageRule(age) {
    for (var i = 0; i < AGE_TABLE.length; i++) {
      if (age <= AGE_TABLE[i].max) return AGE_TABLE[i];
    }
    return AGE_TABLE[AGE_TABLE.length - 1];
  }

  /* ---------- 年龄调整（真正生效，而不是只写一句提示） ----------
   * 规则书：年龄区间要扣减 力量/体质/敏捷（合计值，由玩家自行分配）与 外貌，
   *         并降低移动力；20 岁以上还有若干次教育进步检定。
   *
   * 设计取舍：**不改写玩家输入的原始属性**。
   *   直接改会被三件事污染且不可逆 —— 掷骰结果、购点上限校验、来回改年龄时的叠加扣减。
   *   所以这里额外算出一份「生效属性 eff」，派生属性、技能基础值（母语=EDU、闪避=DEX/2）
   *   与角色卡展示全部走这份数值；界面上把「原始 → 生效」并排显示，玩家一眼看懂扣在哪。
   */

  /* 物理扣减的单项下限。
     3D6×5 的理论最低值是 15 —— 扣到这个数就不再往下扣。
     没有这条下限时，高龄角色的力量会被一路扣成个位数，
     而体质、敏捷纹丝不动，属性表一眼就畸形。 */
  var PHYS_FLOOR = 15;

  /**
   * 把 total 点扣减**平均**摊到 keys 指定的属性上。
   *
   * 早先的写法是「按固定顺序填满一个再填下一个」，于是 69 岁的角色
   * 会把力量扣穿、体质敏捷几乎不动。改成逐点轮转：每个属性各扣一点，
   * 再回到第一个，直到点数用完或全部触底 —— 三项的扣减量最多相差 1。
   *
   * 逐点轮转（而不是一次性除以份数）是为了同时满足「尽量平均」与
   * 「单项不低于下限」：某个属性触底后，剩余点数自动流向还有余量的属性。
   *
   * @param total 要扣的总点数
   * @param keys  参与分摊的属性 key（顺序固定 → 结果可复现，不会因刷新而变）
   * @param caps  每个属性最多能扣多少（通常是 raw − 下限）
   * @returns {{loss: Object, remain: number}} remain > 0 表示点数多到全部触底都用不完
   */
  function spreadLoss(total, keys, caps) {
    var loss = {}, i;
    for (i = 0; i < keys.length; i++) loss[keys[i]] = 0;
    var remain = Math.max(0, num(total) || 0);
    while (remain > 0) {
      var moved = false;
      for (i = 0; i < keys.length && remain > 0; i++) {
        var k = keys[i];
        var cap = Math.max(0, num(caps[k]) || 0);
        if (loss[k] < cap) { loss[k]++; remain--; moved = true; }
      }
      if (!moved) break;      // 全部触底，剩下的点数无处可扣
    }
    return { loss: loss, remain: remain };
  }

  /** 某个属性最多能被扣掉多少（扣到下限为止） */
  function lossCapOf(value, floor) {
    return Math.max(0, (num(value) || 0) - floor);
  }

  function ageAdjust(attrs) {
    var a = attrs || {};
    var age = num(a.age) || 25;
    var rule = ageRule(age);

    var raw = {
      str: num(a.str), con: num(a.con), siz: num(a.siz), dex: num(a.dex),
      app: num(a.app), int: num(a.int), pow: num(a.pow), edu: num(a.edu), luck: num(a.luck)
    };
    var loss = { str: 0, con: 0, siz: 0, dex: 0, app: 0 };
    /* 因为触底而没能扣掉的点数。规则给的扣减量是固定的，
       属性本身太低时会扣不满 —— 这个值必须暴露出去，
       否则界面上「合计 −20」与实际生效的差值会变成一个说不清的谜。 */
    var unapplied = 0;

    if (age <= 19) {
      // 少年（15-19）：力量与体型合计 −5，同样平均摊
      var rT = spreadLoss(rule.physLoss || 5, ['str', 'siz'], {
        str: lossCapOf(raw.str, PHYS_FLOOR),
        siz: lossCapOf(raw.siz, PHYS_FLOOR)
      });
      loss.str += rT.loss.str;
      loss.siz += rT.loss.siz;
      unapplied += rT.remain;
    } else {
      // 中老年：力量/体质/敏捷合计扣减，三项平均分摊
      var rP = spreadLoss(rule.physLoss || 0, ['str', 'con', 'dex'], {
        str: lossCapOf(raw.str, PHYS_FLOOR),
        con: lossCapOf(raw.con, PHYS_FLOOR),
        dex: lossCapOf(raw.dex, PHYS_FLOOR)
      });
      loss.str += rP.loss.str;
      loss.con += rP.loss.con;
      loss.dex += rP.loss.dex;
      unapplied += rP.remain;
    }
    loss.app = Math.min(raw.app, rule.appLoss || 0);

    // 教育进步检定带来的增益（a.eduBonus）：同样不进 raw，只作用于生效值。
    // 这样购点上限校验仍然看玩家购买的原始 EDU，不会被检定结果污染。
    var eduBonus = num(a.eduBonus);

    var eff = {};
    Object.keys(raw).forEach(function (k) {
      eff[k] = Math.max(0, raw[k] - (loss[k] || 0));
    });
    if (eduBonus > 0) eff.edu = Math.min(99, eff.edu + eduBonus);

    var totalLoss = 0;
    Object.keys(loss).forEach(function (k) { totalLoss += loss[k]; });

    return {
      age: age, rule: rule, raw: raw, eff: eff, loss: loss,
      totalLoss: totalLoss,
      physLoss: loss.str + loss.con + loss.dex + loss.siz,
      appLoss: loss.app,
      movLoss: rule.movLoss || 0,
      eduChecks: rule.eduChecks || 0,
      eduBonus: eduBonus,
      /** 应扣但被 15 下限挡住、最终没扣成的点数 */
      unapplied: unapplied,
      /** 物理扣减的单项下限，界面提示会引用它 */
      floor: PHYS_FLOOR,
      /** 是否有任何实际生效的调整 */
      active: totalLoss > 0 || (rule.movLoss || 0) > 0 || eduBonus > 0
    };
  }

  /** 取角色当前生效属性（含年龄调整 + 教育进步检定增益），供技能基础值等下游使用 */
  function effectiveAttrs(character) {
    var c = character || {};
    var a = Object.assign({}, c.attributes || {});
    a.age = (c.basicInfo || {}).age;
    a.eduBonus = eduBonusOf(c);
    return ageAdjust(a).eff;
  }

  /** 教育进步检定累计增益 */
  function eduBonusOf(character) {
    var p = (character || {}).eduProgress;
    if (!p) return 0;
    if (p.bonus !== undefined && p.bonus !== null && p.bonus !== '') return num(p.bonus);
    // 兼容：早期只写了 log 的数据
    return (Array.isArray(p.log) ? p.log : []).reduce(function (t, r) { return t + (num(r && r.gain) || 0); }, 0);
  }

  /* ============================================================
   * 「任选 X 项」的去重校验
   *
   * 规则书要求任选的技能必须是**尚未拥有**的：
   *   ① 同一个任选块里不能重复选同一个技能（选两次「游泳」= 白占一个名额）
   *   ② 不能与已经获得的本职技能重复（「历史」既是本职又当特长 = 重复）
   *   ③ 组技能的不同专攻算不同技能，但同一个专攻不能选两次
   *
   * 界面上已经做了过滤（steps-b.js 的 pickFree），这里是数据层的兜底：
   * 老存档里可能已经存在重复项，界面绕过去也能查出来。
   * ============================================================ */
  function duplicatePicks(c, occModel) {
    var errs = [];
    var picks = c.occupationPicks || {};
    var reqs = (occModel && occModel.getRequirements) ? occModel.getRequirements(c) : [];

    /* ⚠️ 只在「任选（free）」类型的块之间查重。
       c.occupationPicks 这一个字典里同时存着两类内容：
         · choice 择一项（用户或 preset 选中的那一个）
         · free   任选 N 项  ← 只有这一类之间才需要「不能重复」
       preset.fillOccupationPicks() 会把两类一起写进这个字典，
       早先的校验不分类型，于是两个 choice 块选到同一个技能就判成不合格，
       把 12 张彩蛋卡判成「职业限定技能选择完成」不合格。 */
    var freeIds = {};
    reqs.forEach(function (r) { if (r.type === 'free') freeIds[r.id] = 1; });
    /* 没有任何 free 块时无从检查，直接放过 —— 避免误伤正常卡 */
    if (!Object.keys(freeIds).length) return errs;

    /* 「职业规则直接给定」的本职技能：fixed 全部 + choice/alt 里已选中的那一个 */
    var granted = {};
    reqs.forEach(function (r) {
      if (r.type === 'fixed') markOnce(granted, r.skill, r.sub);
      else if (r.type === 'choice') (r.picked || []).forEach(function (p) { markOnce(granted, p.skill, p.sub); });
      else if (r.type === 'alt') (r.picked || []).forEach(function (p) { markOnce(granted, p.skill, p.sub); });
    });

    var seen = {};
    Object.keys(freeIds).forEach(function (rid) {
      var arr = picks[rid] || [];
      var inBlock = {};
      arr.forEach(function (p) {
        var key = (p.skill || '') + '|' + (p.sub || '');
        var label = p.name || p.skill || '未知技能';

        if (inBlock[key]) {
          addErr(rid, '「' + label + '」被重复选择了 —— 每个技能在该职业里只能选一次');
        }
        inBlock[key] = 1;

        if (seen[key]) {
          addErr(rid, '「' + label + '」与其他已选特长重复（' + seen[key] + '），不能重复占用名额');
        }
        seen[key] = label;

        // 与「职业规则直接给定的」本职技能冲突
        if (granted[key]) {
          addErr(rid, '「' + label + '」已经是本职技能，不能再作为个人或时代特长');
        }
      });
    });
    return errs;

    /* 同一条消息可能被多条路径触发（例如既是本职又重复），去重后返回，
       免得界面上同一句话冒出来两遍 */
    function addErr(rid, text) {
      var target = 'occ_' + rid;
      for (var i = 0; i < errs.length; i++) {
        if (errs[i].text === text && errs[i].target === target) return;
      }
      errs.push({ step: 2, target: target, text: text });
    }

    /* 组技能（如「格斗」开放了「格斗（斗殴）」）要算进已拥有集合 */
    function markOnce(map, skill, sub) {
      if (!skill) return;
      map[(skill || '') + '|' + (sub || '')] = 1;
      var def = occModel && occModel.skillById ? occModel.skillById(skill) : null;
      if (def && def.special && !sub) {
        (def.subskills || []).forEach(function (s) { map[skill + '|' + s.name] = 1; });
      }
    }
  }

  /* ---------- 教育进步检定 ----------   * 规则书：年龄区间带来的「教育进步检定」不是直接把 EDU 加上去，
   * 而是每一次都掷 1D100：结果 > 当前 EDU 才算进步，EDU +1D10（上限 99）。
   * 所以这里提供真正的掷骰函数，由界面显式调用 —— 不静默改写玩家的属性。
   */
  function eduImproveCheck(currentEdu) {
    var cur = num(currentEdu);
    var roll = D.roll(1, 100);
    if (roll <= cur) return { roll: roll, edu: cur, gain: 0, success: false };
    var gain = D.roll(1, 10);
    var next = Math.min(99, cur + gain);
    return { roll: roll, edu: next, gain: next - cur, success: true };
  }

  /* ---------- 伤害加值 / 体格表 ---------- */
  var DB_TABLE = [
    { min: 2,   max: 64,  db: '-2',   build: -2 },
    { min: 65,  max: 84,  db: '-1',   build: -1 },
    { min: 85,  max: 124, db: '0',    build: 0 },
    { min: 125, max: 164, db: '+1D4', build: 1 },
    { min: 165, max: 204, db: '+1D6', build: 2 },
    { min: 205, max: 284, db: '+2D6', build: 3 },
    { min: 285, max: 364, db: '+3D6', build: 4 },
    { min: 365, max: 444, db: '+4D6', build: 5 }
  ];

  function dbBuild(strSiz) {
    if (strSiz < 2) strSiz = 2;
    for (var i = 0; i < DB_TABLE.length; i++) {
      if (strSiz >= DB_TABLE[i].min && strSiz <= DB_TABLE[i].max) {
        return { db: DB_TABLE[i].db, build: DB_TABLE[i].build };
      }
    }
    // 超过 444：每再超过 80 点，+1D6 伤害加值与 +1 体格
    var extra = Math.floor((strSiz - 445) / 80) + 1;
    return { db: '+' + (4 + extra) + 'D6', build: 5 + extra };
  }

  /* ============================================================
   * 派生属性计算
   * ============================================================ */
  function derived(attrs) {
    // 全部基于「年龄调整后」的生效属性来算：
    // 属性被扣了，HP / 移动力 / 伤害加值 / 体格 / 闪避基础值都要跟着变。
    var adj = ageAdjust(attrs);
    var a = adj.eff;
    var hp = Math.floor((num(a.con) + num(a.siz)) / 10);
    var mp = Math.floor(num(a.pow) / 5);
    // 理智上限 = 意志（POW）。POW 若因释放法术等原因变化，上限跟着变。
    // 注意：当前理智可以暂时超过这个上限（界面不再把当前值夹到上限）。
    var san = num(a.pow);

    // 移动力: 基础 8，STR/DEX 均小于 SIZ → 7；均大于等于 → 9
    var mov = 8;
    var str = num(a.str), dex = num(a.dex), siz = num(a.siz);
    if (str < siz && dex < siz) mov = 7;
    else if (str > siz && dex > siz) mov = 9;
    // 年龄修正
    mov -= adj.movLoss;
    if (mov < 1) mov = 1;

    var dbb = dbBuild(str + siz);

    return {
      hp: hp, maxHP: hp,
      mp: mp, maxMP: mp,
      san: san, maxSAN: san,
      mov: mov,
      build: dbb.build,
      db: dbb.db,
      // 闪避初始值 = DEX / 2（同样取调整后的 DEX）
      dodgeBase: Math.floor(dex / 2),
      // 年龄调整摘要，供界面与角色卡展示
      ageLoss: adj.loss,
      ageLossTotal: adj.totalLoss
    };
  }

  /** 理智上限 = 99 - 克苏鲁神话成功率 */
  function maxSan(cthulhuSkill) {
    return 99 - (num(cthulhuSkill) || 0);
  }

  /* ---------- 车卡期不允许加点的技能 ----------
   * 克苏鲁神话：规则书明确「车卡时不可加点」，只能靠实际遭遇神话事件获得，
   * 因此职业点与兴趣点都不该能加到它身上（成长可以）。
   *
   * 信用评级：同样按「车卡时不可加点」处理。
   * 它不是一根普通技能 —— 规则书里它是**用职业点买来的资产**，
   * 数值由职业决定的区间（creditMin-creditMax）约束，
   * 所以在「技能分配」那一步不给它加点的入口：
   * 要改请去「资产与信用评级」步骤（那里的区间校验更严格）。
   * 放在这里标成「仅成长」是为了跟克苏鲁神话一致 ——
   * 车卡时不能靠技能点 / 兴趣点堆它。
   */
  var GROWTH_ONLY = { cthulhu: true, credit: true };
  function isGrowthOnly(skillId) { return !!GROWTH_ONLY[skillId]; }

  /* ---------- 技能最终值上限（两类） ----------
   * 本职技能 → 本职技能上限；非本职技能 → 兴趣技能上限。
   * 兼容早期只有一个 skillCap 的数据：没有分项值时回落到它。
   *
   * 两个例外 —— 它们由规则决定，不受用户设定的上限约束：
   *   1) 母语：基础值就等于「教育 EDU」，天生可能高于自定义上限
   *      （EDU 80 而上限被设成 60）。规则书只给了 99% 的硬顶，
   *      所以母语一律按 99 计，加点也最多加到 99。
   *   2) 其余技能：上限同样不会低于该技能自身的「基础值」。
   *      基础值不是用点数买来的，把它算成「超过上限」属于误报
   *      （例如闪避基础 = 敏捷÷2 = 45，而兴趣上限被设成 40）。
   */
  function skillCapOf(character, skill, occSet) {
    var c = character || {};
    /* 母语与信用评级：规则决定的上限，只受 99硬顶 */
    if (skill && (skill.id === 'language_own' || skill.id === 'credit')) return 99;
    var shared = num(c.skillCap) || 0;
    var isOcc = false;
    if (occSet && skill) isOcc = !!occSet[skill.key] || !!occSet[skill.id];
    var cap = isOcc
      ? (num(c.skillCapOcc) || shared || COC7.defaultOccSkillCap)
      : (num(c.skillCapInterest) || shared || COC7.defaultInterestSkillCap);
    var base = num(skill && skill.base);
    if (base > cap) cap = Math.min(base, 99);
    return cap;
  }

  /** 该技能的上限是否被规则豁免（不受「上限设置」约束，只受 99 硬顶） */
  function capExempt(skillId) {
    var id = String(skillId);
    /* 信用评级与母语一样：数值由规则（职业区间 / 教育值）决定，
       不该被用户设的「技能上限」压住 ——
       否则上限一改，规则书允许的信用评级就变成「超上限」的非法值。 */
    return id === 'language_own' || id === 'credit';
  }

  function num(v) {
    var n = parseInt(v, 10);
    return isNaN(n) ? 0 : n;
  }

  /* ============================================================
   * 属性生成器
   * ============================================================ */
  var generators = {
    /** 模式一: 随机生成 */
    random: function () {
      var out = {};
      Object.keys(GEN.randomDice).forEach(function (k) {
        var r = GEN.randomDice[k];
        out[k] = (D.roll(r[0], r[1]) + r[2]) * 5;
      });
      return out;
    },

    /** 单属性随机 (用于幸运栏等) */
    randomOne: function (key) {
      var r = GEN.randomDice[key] || [3, 6, 0];
      return (D.roll(r[0], r[1]) + r[2]) * 5;
    },

    /** 模式二: 购点 — 校验
     *  includeLuck=false 时，「属性总和」只累加 8 项（幸运不参与购点，也就不该计入）。 */
    validatePointBuy: function (attrs, totalCap, includeLuck) {
      var errors = [];
      var sum = 0;
      var cap = num(totalCap);
      var keys = includeLuck ? ATTRIBUTES.map(function (a) { return a.key; })
                             : ATTRIBUTES.filter(function (a) { return !a.optional; }).map(function (a) { return a.key; });
      keys.forEach(function (k) {
        var v = attrs[k];
        if (v === '' || v === null || v === undefined) return;
        var n = num(v);
        if (n < GEN.min || n > GEN.max) {
          errors.push({ text: ATT_MAP[k].name + ' 必须在 ' + GEN.min + '-' + GEN.max + ' 之间' });
        }
        if (n % GEN.step !== 0) {
          errors.push({ text: ATT_MAP[k].name + ' 必须是 5 的倍数' });
        }
        sum += n;
      });
      // cap 为 0 表示还没设定，此时只做数值合法性检查，避免提示「超出上限 0」
      var over = cap > 0 && sum > cap;
      if (over) {
        errors.push({ text: '属性总和 ' + sum + ' 超出上限 ' + cap + '，请减少 ' + (sum - cap) + ' 点' });
      }
      return {
        ok: errors.length === 0, errors: errors,
        sum: sum, cap: cap, remain: cap - sum,
        counted: keys.length,          // 本次计入的属性项数（8 或 9）
        over: over, overBy: over ? sum - cap : 0
      };
    },

    /** 模式三: 预设方案 (预留) */
    arrays: {
      A: { str: 80, con: 70, siz: 60, dex: 60, app: 50, int: 70, pow: 60, edu: 70, luck: 50 },
      B: { str: 60, con: 60, siz: 60, dex: 70, app: 60, int: 80, pow: 70, edu: 60, luck: 50 },
      C: { str: 50, con: 70, siz: 70, dex: 60, app: 70, int: 60, pow: 80, edu: 60, luck: 50 }
    }
  };

  /* ============================================================
   * 校验器 (供"完成角色卡"时统一调用)
   * ============================================================ */
  var validators = {
    /** 属性是否合法 */
    attributes: function (c) {
      var errs = [];
      ATTRIBUTES.forEach(function (a) {
        var v = num(c.attributes[a.key]);
        if (!c.attributes[a.key] && c.attributes[a.key] !== 0) {
          errs.push({ step: 1, target: 'attr_' + a.key, text: a.name + ' 未填写' });
        } else if (v < 1 || v > 999) {
          errs.push({ step: 1, target: 'attr_' + a.key, text: a.name + ' 数值不合法' });
        }
      });
      return errs;
    },

    /** 职业限定技能选择是否完成 */
    occupationChoices: function (c, occModel) {
      var errs = [];
      if (!c.occupationId) return errs;
      var req = occModel.getRequirements(c);
      req.forEach(function (r) {
        if (r.type === 'choice' && r.picked.length < r.count) {
          errs.push({ step: 2, target: 'occ_' + r.id,
            text: r.label + ' 还需选择 ' + (r.count - r.picked.length) + ' 项' });
        }
        if (r.type === 'free' && r.picked.length < r.count) {
          errs.push({ step: 2, target: 'occ_' + r.id,
            text: r.label + ' 还需指定 ' + (r.count - r.picked.length) + ' 项' });
        }
      });
      errs = errs.concat(duplicatePicks(c, occModel));
      return errs;
    },

    /** 技能点是否超额 */
    skillPoints: function (c, occModel) {
      var errs = [];
      var occ = occModel.occupationPoints(c);
      var itr = occModel.interestPoints(c);
      if (occ.used > occ.total) {
        errs.push({ step: 4, target: 'occPoints',
          text: '职业技能点超出 ' + (occ.used - occ.total) + ' 点（已用 ' + occ.used + '/' + occ.total + '）' });
      }
      if (itr.used > itr.total) {
        errs.push({ step: 4, target: 'interestPoints',
          text: '兴趣技能点超出 ' + (itr.used - itr.total) + ' 点（已用 ' + itr.used + '/' + itr.total + '）' });
      }
      return errs;
    },

    /** 技能是否超过上限（本职走本职上限，非本职走兴趣上限） */
    skillCap: function (c) {
      var errs = [];
      var OCC = global.CocOccupation;
      var occSet = OCC ? OCC.occupationalSet(c) : null;
      (c.skills || []).forEach(function (s) {
        var cap = skillCapOf(c, s, occSet);
        if (s.total > cap) {
          var isOcc = !!(occSet && (occSet[s.key] || occSet[s.id]));
          errs.push({ step: 4, target: 'skill_' + s.key,
            text: '技能「' + s.name + '」达到 ' + s.total + '，超过' + (isOcc ? '本职' : '兴趣') + '技能上限 ' + cap + '%' });
        }
      });
      return errs;
    },

    /** 信用评级是否已分配且在职业允许范围内，且其占用的职业点未超额 */
    creditRating: function (c, occModel) {
      var errs = [];
      if (!c.occupationId) return errs;
      var occ = occModel.getById(c.occupationId);
      if (!occ || occ.creditMin === null || occ.creditMax === null) return errs;
      var cr = num(c.assets && c.assets.creditRating);
      if (!cr) {
        errs.push({ step: 3, target: 'creditRating',
          text: '尚未分配信用评级（该职业允许 ' + occ.creditMin + '-' + occ.creditMax + '）' });
        return errs;
      }
      if (cr < occ.creditMin || cr > occ.creditMax) {
        errs.push({ step: 3, target: 'creditRating',
          text: '信用评级 ' + cr + ' 超出该职业允许范围 ' + occ.creditMin + '-' + occ.creditMax });
        return errs;
      }
      // 信用评级由职业点数购买，需保证职业点总量未被突破
      var pts = occModel.occupationPoints(c);
      if (pts.used > pts.total) {
        errs.push({ step: 4, target: 'occPoints',
          text: '职业技能点超出 ' + (pts.used - pts.total) + ' 点（信用评级也占用职业点数）' });
      }
      return errs;
    },

    /** 基本信息 */
    basicInfo: function (c) {
      var errs = [];
      if (!c.characterName || !String(c.characterName).trim()) {
        errs.push({ step: 0, target: 'characterName', text: '角色姓名未填写' });
      }
      if (!c.playerName || !String(c.playerName).trim()) {
        errs.push({ step: 0, target: 'playerName', text: '玩家名称未填写' });
      }
      var age = num(c.age);
      if (!age || age < 1 || age > 200) {
        errs.push({ step: 0, target: 'age', text: '年龄必须填写为 1-200 的整数' });
      }
      return errs;
    },

    occupationSelected: function (c) {
      if (!c.occupationId) {
        return [{ step: 2, target: 'occupationPicker', text: '尚未选择职业' }];
      }
      return [];
    }
  };

  /* ============================================================
   * 身体/精神状态枚举
   *
   * ⚠️ v2.10.0 起 **body 状态模型已换代**，下面的 BODY_STATUS 只是
   *    **历史六态快照**，勿被它的形状误导：
   *      · 旧模型（v2.10.0 前）：body 单选六态 —— 正常/轻伤/重伤/濒死/昏迷/死亡，
   *        即 BODY_STATUS 的值；
   *      · 新模型（v2.10.0，见 docs/跑团房间-v2.10.0-增量设计.md）：
   *        sheet.status.body ∈ {正常, 轻伤, 重伤, 死亡} **四态单选**；
   *        「濒死」「昏迷」升级为独立布尔标记 sheet.status.dying /
   *        sheet.status.unconscious，可与 body **叠加**
   *        （如 {body:'重伤', dying:true, unconscious:true} 合法）；
   *        显示 / 判定一律读视图合成 bodyView（死亡 > dying > unconscious > body）。
   *
   *    BODY_STATUS 保留仅为**旧存档 / 历史数据兼容**（老卡的 '濒死'/'昏迷'
   *    字符串会先经 store.js#normalize、room-model.js#migrateBodyStatus 迁移），
   *    **勿在新代码引用**；新代码一律走「body 四态 + dying/unconscious 标记」。
   *    ⚠️ 绝对不要改它的值（tools/test_status_madness.js 等既有断言依赖）。
   *
   * mental **多选**（规则允许同时存在：背景自带永久疯狂，
   *          游戏里又叠加临时疯狂 / 不定疯狂）—— 这个没变，别一起改。
   * 「正常」在多选里表示「没有任何异常」——不能和别的项同时存在，
   * 这个互斥由 UI 处理（选「正常」时清空其余，选其余时摘掉「正常」）。
   * ============================================================ */
  var BODY_STATUS = ['正常', '轻伤', '重伤', '濒死', '昏迷', '死亡'];
  /* v2.1.5（用户第 1/4 项）：精神状态增加「疯狂症状」—— 表示角色**持有具体症状**
     （恐惧症 / 狂躁症）。它是多选里的一项，与「临时/不定/永久疯狂」并列：
     「疯狂症状」回答的是「有没有具体症状」，「临时/不定/永久」回答的是「多严重、会不会好」。
     「永久疯狂」改为**互斥项**（类似「正常」）：选了它就不能同时是别的精神状态。 */
  var MENTAL_STATUS = ['正常', '临时疯狂', '不定疯狂', '疯狂症状', '永久疯狂', '昏迷', '其他'];
  var MENTAL_NORMAL = '正常';
  var MENTAL_SYMPTOM = '疯狂症状';
  var MENTAL_PERMANENT = '永久疯狂';

  /* ============================================================
   * 技能分类 → 雷达图维度
   * ============================================================ */
  var RADAR_DIMS = [
    { key: '战斗', label: '战斗能力', color: '#e05a4f' },
    { key: '探索', label: '探索能力', color: '#4f8fe0' },
    { key: '知识', label: '知识能力', color: '#8a6fd8' },
    { key: '交流', label: '交流能力', color: '#e0a24f' },
    { key: '生存', label: '生存能力', color: '#4fb98a' }
  ];

  /**
   * 计算雷达图各维度得分。
   *   · value —— 原语义：该分类下技能最终值的**平均值**（保留，不改）。
   *   · v2.2.0（用户第 4 项）新增：
   *       sum  = 该类下技能最终值之**和**（类别得分）；
   *       pct  = 该类得分 / 五类得分之和 × 100（占比 %）；
   *       norm = pct / 五类中最大 pct × 100（归一化 0–100，最大占比 = 100）。
   *     界面已改用占比口径绘制（radarChart 优先读 norm）。
   */
  function radar(skills, skillDefs) {
    var catMap = {};
    skillDefs.forEach(function (d) { catMap[d.id] = d.category; });
    var sums = {}, counts = {};
    RADAR_DIMS.forEach(function (d) { sums[d.key] = 0; counts[d.key] = 0; });
    (skills || []).forEach(function (s) {
      var cat = catMap[s.id];
      if (!cat || sums[cat] === undefined) return;
      var v = s.total || 0;
      if (s.base !== undefined && v < s.base) v = s.base;
      sums[cat] += Math.min(v, 100);
      counts[cat] += 1;
    });
    /* 五类得分之和与最大类得分 —— 供 pct / norm 用。 */
    var totalSum = 0, maxSum = 0;
    RADAR_DIMS.forEach(function (d) {
      totalSum += sums[d.key];
      if (sums[d.key] > maxSum) maxSum = sums[d.key];
    });
    return RADAR_DIMS.map(function (d) {
      var c = counts[d.key] || 1;
      var sum = sums[d.key];
      var pct = totalSum > 0 ? (sum / totalSum * 100) : 0;
      var norm = maxSum > 0 ? (sum / maxSum * 100) : 0;
      return {
        key: d.key, label: d.label, color: d.color,
        value: Math.round(sum / c),          // 原语义：类别平均（保留）
        sum: sum,                            // 新增：类别技能值之和
        pct: Math.round(pct * 10) / 10,      // 新增：占比（%，一位小数）
        norm: Math.round(norm * 10) / 10     // 新增：归一化 0–100（最大占比 = 100）
      };
    });
  }

  function ageProgressChecks(age) {
    return ageRule(age).eduChecks;
  }

  function attrByName(name) {
    return CN2KEY[String(name).trim()] || null;
  }

  /* ============================================================
   * 规则系统注册
   * ============================================================ */
  var COC7 = {
    id: 'coc7',
    name: '克苏鲁的呼唤 第七版',
    shortName: 'COC 7th',
    available: true,
    description: '调查员在诡秘的克苏鲁神话世界中探索真相，理智与生命随时可能被吞噬。',
    version: '7th',
    rulebook: '克苏鲁的呼唤 第七版规则书',
    attributes: ATTRIBUTES,
    attrMap: ATTR_MAP,
    cn2key: CN2KEY,
    gen: GEN,
    generators: generators,
    derived: derived,
    dbBuild: dbBuild,
    ageRule: ageRule,
    ageAdjust: ageAdjust,
    spreadLoss: spreadLoss,
    physFloor: PHYS_FLOOR,
    effectiveAttrs: effectiveAttrs,
    ageProgressChecks: ageProgressChecks,
    eduImproveCheck: eduImproveCheck,
    eduBonusOf: eduBonusOf,
    isGrowthOnly: isGrowthOnly,
    skillCapOf: skillCapOf,
    capExempt: capExempt,
    maxSan: maxSan,
    validators: validators,
    bodyStatus: BODY_STATUS,
    mentalStatus: MENTAL_STATUS,
    mentalNormal: MENTAL_NORMAL,
    mentalSymptom: MENTAL_SYMPTOM,
    mentalPermanent: MENTAL_PERMANENT,
    radarDims: RADAR_DIMS,
    radar: radar,
    attrByName: attrByName,
    /** 技能值上限（用户可自定义覆盖）
     *  分成两类：本职技能的最终值上限 / 非本职（兴趣）技能的最终值上限。
     *  规则书默认都是 99%（只有克苏鲁神话另有约束）。 */
    defaultSkillCap: 99,
    defaultOccSkillCap: 99,
    defaultInterestSkillCap: 99,
    /** 购点模式的标准属性点上限（不含幸运 / 含幸运） */
    pointBuyCap: { noLuck: 460, withLuck: 540, fallback: 480 },
    defaultInterestFormula: { type: 'int', mult: 2 },
    skillCategories: ['战斗', '探索', '交流', '知识', '生存', '其他', '自定义']
  };

  global.COC7 = COC7;

  /* 规则注册表：未来新增 DND 5E / 自定义规则只需在此登记 */
  global.RuleRegistry = global.RuleRegistry || {};
  global.RuleRegistry['coc7'] = COC7;
  /* 首页「未来预留」列表。COC 6th 已按用户要求移除（不再使用第六版规则）。 */
  global.RuleRegistry.placeholders = [
    { id: 'dnd5e', name: '龙与地下城 第五版', shortName: 'DND 5E', available: false },
    { id: 'custom', name: '自定义规则', shortName: '自定义', available: false }
  ];
})(window);
