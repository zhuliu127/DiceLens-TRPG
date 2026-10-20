/* ============================================================
 * room-rules.js — COC 第七版 检定 / 状态 / 行动顺序 规则服务
 * 对外命名：window.CocRules
 *
 * 为什么单独一个模块（需求文档 §0 硬要求）：
 *   「所有规则阈值、伤害、SAN、状态和行动顺序都应在明确的数据模型 /
 *     规则服务中计算，不要散落在按钮事件里。」
 * 所以这里是跑团房间里**唯一**做规则判定的地方 —— 界面拿到结果只负责显示，
 * 不得再自己算一遍，否则一定出现「掷骰页说成功、记录里写失败」这种对不上的情况。
 *
 * 三条设计约束：
 *   1) 纯函数：不碰 DOM、不发请求、不读全局状态（不依赖 Store / Engine）。
 *   2) 随机源可注入：每个掷骰入口都收 opts.rng，这样单元测试才能构造
 *      确定性的边界用例（01、100、00+0、十位骰取哪个…），否则这些边界
 *      只能靠运气跑出来，等于没测。
 *   3) 掷骰结果可以外部传入（opts.value / opts.ones / opts.forcedTens），
 *      重放历史记录、校验别人的骰子时不用重新掷。
 *
 * 与 dice.js 的分工：
 *   dice.js 只有最原始的掷骰与骰式解析（车卡阶段在用）。
 *   本模块才是检定的唯一出口。dice.js 里的 d100Bonus / successLevel 是车卡
 *   阶段留下的**零调用**预留（全项目搜不到调用点），本模块不复用它们 ——
 *   其中 d100Bonus 在「个位骰为 0」时会把奖励骰的结果取反（见 rollD100 注释），
 *   属于必须绕开的既有缺陷。
 * ============================================================ */
(function (global) {
  'use strict';

  /* ============================================================
   * 常量
   * ============================================================ */

  /** 成功等级。数值可比大小，比较成功等级时直接比数字即可。 */
  var LEVEL = {
    CRITICAL: 5,     // 大成功（01）
    EXTREME: 4,      // 极难成功（≤ 五分之一）
    HARD: 3,         // 困难成功（≤ 一半）
    REGULAR: 2,      // 常规成功（≤ 技能值）
    FAIL: 0,         // 失败
    FUMBLE: -1       // 大失败
  };

  var LEVEL_TEXT = {
    '5': '大成功', '4': '极难成功', '3': '困难成功',
    '2': '常规成功', '0': '失败', '-1': '大失败'
  };

  /** 稳定的 ASCII 键，给事件 payload / 测试断言用（中文文案以后改了不影响协议） */
  var LEVEL_KEY = {
    '5': 'critical', '4': 'extreme', '3': 'hard',
    '2': 'regular', '0': 'fail', '-1': 'fumble'
  };

  var DIFFICULTY = {
    regular: { required: LEVEL.REGULAR, text: '常规', div: 1 },
    hard: { required: LEVEL.HARD, text: '困难', div: 2 },
    extreme: { required: LEVEL.EXTREME, text: '极难', div: 5 }
  };

  /* ---- 检定类型白名单 ---- */
  /** 可以推动的检定类型。战斗 / SAN / 对抗 / 幸运 / 伤害一律不可推动。 */
  var PUSHABLE = { skill: true, attribute: true, characteristic: true };
  var PUSH_REASON = {
    combat: '战斗检定不能推动（规则书：战斗、SAN、对抗检定都不可推动）',
    san: '理智检定不能推动',
    sanity: '理智检定不能推动',
    opposed: '对抗检定不能推动',
    luck: '幸运检定不能推动',
    damage: '伤害骰不能推动',
    sanloss: '理智损失骰不能推动'
  };

  /** 不能花费幸运点的检定类型。 */
  var LUCK_FORBIDDEN = {
    luck: '幸运点不能用来改幸运检定',
    san: '幸运点不能用来改理智检定',
    sanity: '幸运点不能用来改理智检定',
    sanloss: '幸运点不能用来改理智损失',
    damage: '幸运点不能用来改伤害骰'
  };

  /* ============================================================
   * 小工具
   * ============================================================ */
  function num(v) { var n = parseInt(v, 10); return isNaN(n) ? 0 : n; }
  function defRng() { return Math.random(); }
  function pickRng(rng) { return typeof rng === 'function' ? rng : defRng; }

  /** 0-9，用于「十位骰 / 个位骰」这类十面骰面值（0 表示 00 / 0）。 */
  function die10(rng) {
    return clampDie10(Math.floor(pickRng(rng)() * 10));
  }
  /** 兜住 rng 返回 1 的自定义测试源，以及测试里直接传进来的骰面 */
  function clampDie10(v) {
    var n = Math.floor(num(v));
    return n < 0 ? 0 : (n > 9 ? 9 : n);
  }

  /** 十位骰与个位骰组合成百分骰：00 与 0 → 100，其余正常解释为 1-99。 */
  function combine(tens, ones) {
    var v = tens * 10 + ones;
    return v === 0 ? 100 : v;
  }
  function clampValue(v) {
    var n = num(v);
    if (n < 1) return 1;
    if (n > 100) return 100;
    return n;
  }

  /* ============================================================
   * 1. 阈值与成功等级
   * ============================================================ */

  /**
   * 三个阈值：常规 = 技能值；困难 = 技能值 ÷ 2；极难 = 技能值 ÷ 5。
   * 规则书（Pg.82-83）明确「二分之一与五分之一**向下取整**」，
   * 所以 55% 的困难阈值是 27、极难阈值是 11，不是 27.5 / 11。
   */
  function thresholds(base) {
    var b = Math.max(0, num(base));
    return { base: b, regular: b, hard: Math.floor(b / 2), extreme: Math.floor(b / 5) };
  }
  function normDifficulty(d) { return Object.prototype.hasOwnProperty.call(DIFFICULTY, d) ? d : 'regular'; }
  function targetOf(base, difficulty) {
    return thresholds(base)[normDifficulty(difficulty)];
  }

  /**
   * 大失败范围 —— ⚠️ 取决于「本次检定**实际要求**的成功阈值」，不是角色技能原值。
   *
   * 规则书 Pg.91：技能大于 50% 时只有掷出 100 才是大失败，否则 96-100 都是。
   * 而困难 / 极难检定里，「技能值」指的还是**被折半、取五分之一之后的那个数**。
   * 官方示例：55% 的图书馆使用，常规搜索只有 100 算大失败；在烛光下做
   * 困难搜索（阈值 27）时，掷 96 就已经是大失败。
   *
   * 需求文档 §7.1 的表述与此一致（「需要根据实际要求成功的阈值判定，
   * 而不只是看角色技能原值」）。所以这里收的是 target，不是 base。
   */
  /* ---- v2.3.0（用户第 7 项）：可自定义的大成功 / 大失败阈值 ----
     语义（建房表单 / KP 工具一一对应）：
       · critMax   —— 掷出值 ≤ critMax  → 大成功；默认 1（即只有 01）。
       · fumbleMin —— 掷出值 ≥ fumbleMin → 大失败；**未设置（0 / 空 / ≤0）→ 走动态规则**：
                      本次要求阈值 < 50 时 96-100，否则仅 100。
     ⚠️ 不传 / 传 undefined → 两个阈值都与「改动前」**逐字节一致**（回归保护的硬要求）。 */
  function critThresholdOf(opts) {
    var c = parseInt(opts && opts.critMax, 10);
    if (isNaN(c) || c < 1) return 1;                 // 默认：仅 01 大成功
    if (c > 100) return 100;
    return c;
  }
  function fumbleThresholdOf(opts) {
    var f = parseInt(opts && opts.fumbleMin, 10);
    if (isNaN(f) || f <= 0) return 0;                // 0 = 未设置 → 动态规则
    if (f > 100) return 100;
    return f;
  }
  function fumbleRange(target, opts) {
    var fm = fumbleThresholdOf(opts);
    if (fm > 0) return { min: fm, max: 100 };        // 自定义：掷出值 ≥ fumbleMin 即大失败
    return num(target) < 50 ? { min: 96, max: 100 } : { min: 100, max: 100 };
  }
  function isFumble(value, target, opts) {
    if (value === 100) return true;                 // 100 永远是敌人
    var r = fumbleRange(target, opts);
    return value >= r.min && value <= r.max;
  }

  /**
   * 成功等级。
   *
   * ⚠️ 成功等级看的是**技能值**的三档阈值，而「算不算大失败」看的是
   * 本次检定的**要求阈值** —— 这两件事用的是不同分母，别合并成一个参数。
   * 规则书原话：五分之一 / 一半 / 全额「不是成功的等级」，难度只决定
   * 「这次需要达到哪一档」。对抗检定要靠等级比较，所以等级必须按技能值算。
   *
   * @param value 掷出的百分骰结果（1-100）
   * @param base  技能 / 属性值
   * @param target 本次要求阈值；省略时等于 base（常规检定）
   */
  function levelOf(value, base, target, opts) {
    var v = clampValue(value);
    var t = thresholds(base);
    var req = (target === undefined || target === null) ? t.regular : num(target);
    /* v2.3.0（用户第 7 项）：大成功阈值可自定义 —— 默认 critThresholdOf()=1，与 `v===1` 等价。 */
    if (v <= critThresholdOf(opts)) return LEVEL.CRITICAL;
    if (isFumble(v, req, opts)) return LEVEL.FUMBLE;
    if (v <= t.extreme) return LEVEL.EXTREME;
    if (v <= t.hard) return LEVEL.HARD;
    if (v <= t.regular) return LEVEL.REGULAR;
    return LEVEL.FAIL;
  }

  /* ============================================================
   * 2. 掷骰（含奖励骰 / 惩罚骰）
   * ============================================================ */

  /**
   * 百分骰，支持奖励骰与惩罚骰。
   *
   * 规则书（Pg.91）：
   *   · 奖励骰 —— 每 1 个额外掷 **1 个十位骰**，与**同一个**个位骰分别组合，
   *     在若干组合结果里取**更低**的百分数；
   *   · 惩罚骰 —— 同理，取**更高**的百分数；
   *   · 1 个奖励骰与 1 个惩罚骰**相互抵消**（先抵消，再决定额外掷几个）；
   *   · 这不是「给 D100 加减若干点」。
   *
   * ⚠️ 实现顺序必须是「先把每个十位骰组合成百分数、再比大小」。
   * 十位骰 {0,1} + 个位骰 0 时，两组组合是 00+0 → **100** 与 10。
   * 奖励骰该给 10（更优）。但如果先对十位骰取 min 得到 0、再判「是不是 100」，
   * 就会返回 100 —— 结果完全取反。惩罚骰同理反向出错。
   * dice.js 里那个没人调用的 d100Bonus 就是这么写的，所以本模块另建实现。
   *
   * @param opts.bonus       奖励骰个数
   * @param opts.penalty     惩罚骰个数
   * @param opts.rng         随机源
   * @param opts.ones        指定个位骰（0-9），测试用
   * @param opts.forcedTens  指定全部十位骰，测试用
   */
  function rollD100(opts) {
    opts = opts || {};
    var rng = opts.rng;
    var bonus = Math.max(0, num(opts.bonus));
    var penalty = Math.max(0, num(opts.penalty));
    var cancelled = Math.min(bonus, penalty);
    var net = bonus - penalty;                    // >0 净奖励；<0 净惩罚；=0 无效果
    var extra = Math.abs(net);

    var ones = (opts.ones === undefined || opts.ones === null) ? die10(rng) : clampDie10(opts.ones);
    var tens;
    if (Array.isArray(opts.forcedTens) && opts.forcedTens.length) {
      tens = opts.forcedTens.slice(0, 1 + extra);
      while (tens.length < 1 + extra) tens.push(tens[tens.length - 1]);   // 不足则补足，保证数量与净骰数一致
    } else {
      tens = [die10(rng)];
      for (var i = 0; i < extra; i++) tens.push(die10(rng));
    }

    var combos = tens.map(function (t) { return combine(t, ones); });
    var picked = 0;
    for (var j = 1; j < combos.length; j++) {
      if (net > 0) { if (combos[j] < combos[picked]) picked = j; }        // 奖励取更低
      else if (net < 0) { if (combos[j] > combos[picked]) picked = j; }   // 惩罚取更高
    }

    return {
      tens: tens, ones: ones, combos: combos,
      pickedTens: tens[picked], pickedIndex: picked,
      value: combos[picked],
      bonus: bonus, penalty: penalty, cancelled: cancelled, net: net,
      /** 给界面显示的一句话：「10 位骰 3/0，个位 5 → 取 05」 */
      detail: describeDice(tens, ones, combos, picked, net)
    };
  }

  function describeDice(tens, ones, combos, picked, net) {
    var pad = function (v) { return ('0' + v).slice(-2); };
    var all = combos.map(function (c, i) { return pad(tens[i]) + '+' + ones + '=' + c; }).join('　');
    var head = '个位骰 ' + ones + '；十位骰 ' + tens.join('/');
    if (tens.length === 1) return head + ' → ' + combos[0];
    return head + '　（' + all + '）　' +
      (net > 0 ? '奖励骰取更低' : '惩罚骰取更高') + ' → ' + combos[picked];
  }

  /* ============================================================
   * 3. 检定
   * ============================================================ */

  /**
   * 一次技能 / 属性检定。
   *
   * @param opts.base       技能或属性值
   * @param opts.difficulty 'regular' | 'hard' | 'extreme'
   * @param opts.bonus      奖励骰个数
   * @param opts.penalty    惩罚骰个数
   * @param opts.rng        随机源（可注入）
   * @param opts.kind       'skill' | 'attribute' | 'combat' | 'san' | 'luck' | 'opposed' | 'damage'
   * @param opts.value      直接指定掷骰结果（重放 / 校验别人的骰子）
   * @param opts.label      显示名（如「侦查」），只用于回显
   * @param opts.secret     秘密检定（只发给 KP）
   */
  function check(opts) {
    opts = opts || {};
    var kind = opts.kind || 'skill';
    var difficulty = normDifficulty(opts.difficulty);
    var base = Math.max(0, num(opts.base));
    var target = targetOf(base, difficulty);
    var t = thresholds(base);

    var dice = rollD100({ bonus: opts.bonus, penalty: opts.penalty, rng: opts.rng,
                          ones: opts.ones, forcedTens: opts.forcedTens });
    var value = (opts.value === undefined || opts.value === null) ? dice.value : clampValue(opts.value);
    /* v2.3.0（用户第 7 项）：把自定义阈值透传给 levelOf / fumbleRange。 */
    var level = levelOf(value, base, target, { critMax: opts.critMax, fumbleMin: opts.fumbleMin });
    var required = DIFFICULTY[difficulty].required;

    var passed = level >= required;
    var fumble = level === LEVEL.FUMBLE;
    var critical = level === LEVEL.CRITICAL;

    var result = {
      v: 1,
      kind: kind,
      label: opts.label || '',
      secret: !!opts.secret,
      // ---- 输入 ----
      base: base, difficulty: difficulty, difficultyText: DIFFICULTY[difficulty].text,
      bonus: dice.bonus, penalty: dice.penalty,
      // ---- 判定 ----
      target: target, required: required, thresholds: t,
      value: value, dice: dice,
      level: level, levelKey: LEVEL_KEY[String(level)], levelText: LEVEL_TEXT[String(level)],
      passed: passed, failed: !passed, critical: critical, fumble: fumble,
      fumbleRange: fumbleRange(target, { fumbleMin: opts.fumbleMin }),
      /* v2.3.0（用户第 7 项）：本次判定实际采用的大成功 / 大失败阈值
         （critMax 默认 1；fumbleMin=0 表示「动态规则」）。界面与审查表据此显示。 */
      critMax: critThresholdOf(opts), fumbleMin: fumbleThresholdOf(opts)
    };
    /* 后续可用动作要在 result 成形之后再算 ——
       canPush 需要看到 passed / fumble 才能判对，先传半成品进去会把
       「已经成功的检定」也算成可以推动。 */
    var push = canPush(result, kind);
    var luck = luckAllowed(kind);
    result.canPush = push.ok;
    result.pushBlockReason = push.reason;
    result.canSpendLuck = (level === LEVEL.FAIL) && luck.ok && value > 1;
    result.luckBlockReason = luck.reason;
    result.summary = describeCheck(result);
    return result;
  }

  function describeCheck(r) {
    var parts = [];
    if (r.label) parts.push(r.label);
    parts.push('目标 ' + r.base + '%');
    if (r.difficulty !== 'regular') parts.push(r.difficultyText + '（需 ≤ ' + r.target + '）');
    parts.push('掷出 ' + r.value);
    parts.push(r.levelText);
    if (r.fumble) parts.push('（大失败范围 ' + r.fumbleRange.min + '-' + r.fumbleRange.max + '，因要求阈值 ' + r.target + (r.target < 50 ? ' < 50' : ' ≥ 50') + '）');
    return parts.join('　·　');
  }

  /* ============================================================
   * 4. 推动检定
   * ============================================================ */

  /**
   * 能不能推动。
   *   规则：只有**失败的技能 / 属性检定**可以推动；推动时玩家必须说明新的做法；
   *   战斗检定、SAN 检定、对抗检定、幸运检定都不可推动；
   *   大失败立即生效、不能被推动抹掉。
   */
  function canPush(result, kind) {
    var k = kind || (result && result.kind) || 'skill';
    if (!PUSHABLE[k]) {
      return { ok: false, reason: PUSH_REASON[k] || ('「' + k + '」类型的检定不能推动') };
    }
    if (!result) return { ok: false, reason: '没有可推动的检定结果' };
    if (result.passed) return { ok: false, reason: '检定已经成功，不需要推动' };
    if (result.fumble) return { ok: false, reason: '大失败立即生效，不能被推动抹掉' };
    return { ok: true, reason: '' };
  }

  /* ============================================================
   * 5. 幸运点
   * ============================================================ */

  /**
   * 该类型检定能否花幸运点。
   * 规则书 Pg.99：幸运点可 1:1 调整技能/属性检定；**不能**用于幸运检定、
   * 伤害骰、SAN 检定与 SAN 损失量；不能防止大成功/大失败；推动与花幸运二选一。
   */
  function luckAllowed(kind) {
    if (Object.prototype.hasOwnProperty.call(LUCK_FORBIDDEN, kind)) {
      return { ok: false, reason: LUCK_FORBIDDEN[kind] };
    }
    return { ok: true, reason: '' };
  }

  /**
   * 花幸运点改结果（**原子性由调用方保证**，这里只算，不改任何状态）。
   *
   * @param opts.result        原始检定结果
   * @param opts.amount        本次想花的点数
   * @param opts.luckAvailable 角色当前幸运值
   */
  function spendLuck(opts) {
    opts = opts || {};
    var r = opts.result;
    if (!r) return { ok: false, reason: '没有检定结果' };
    var allowed = luckAllowed(r.kind);
    if (!allowed.ok) return { ok: false, reason: allowed.reason };
    if (r.fumble) return { ok: false, reason: '大失败不能被幸运点抹掉' };
    if (r.critical) return { ok: false, reason: '已经是大成功，无需花费幸运点' };

    var amount = num(opts.amount);
    if (amount <= 0) return { ok: false, reason: '花费点数必须是正整数' };
    var avail = Math.max(0, num(opts.luckAvailable));
    if (amount > avail) return { ok: false, reason: '幸运点不足（现有 ' + avail + ' 点）' };

    var before = r.value;
    var after = Math.max(1, before - amount);       // 最低只能压到 1（01 依然是大成功）
    var spent = before - after;
    /* v2.3.0（用户第 7 项）：重算成功等级时沿用原检定的自定义阈值（缺省时与旧行为一致）。 */
    var level = levelOf(after, r.base, r.target, { critMax: r.critMax, fumbleMin: r.fumbleMin });
    var required = DIFFICULTY[r.difficulty].required;

    return {
      ok: true,
      amount: amount, spent: spent, refund: amount - spent,
      before: before, after: after,
      beforeLevel: r.level, afterLevel: level,
      afterLevelText: LEVEL_TEXT[String(level)],
      passed: level >= required,
      /** ⚠️ 花过幸运的检定**不得记技能成长勾选**（规则书 Pg.99） */
      growthEligible: false,
      note: spent < amount
        ? '结果已压到 01 的边界，多花的 ' + (amount - spent) + ' 点不予扣除'
        : ''
    };
  }

  /* ============================================================
   * 6. 对抗检定
   * ============================================================ */

  /**
   * 比较两方。
   *   规则：成功等级高者胜；同级则**对应技能值更高**者胜；
   *   数值也相同 → 双方各重掷 1D100，**低者**胜。
   *   （注意：掷出的骰值越低越好，所以重掷时是「低者胜」。）
   *
   * @param a,b 检定结果（check() 的返回值）
   */
  function opposed(a, b) {
    if (!a || !b) return { ok: false, reason: '对抗检定需要两方的检定结果' };
    var base = {
      ok: true, aLevel: a.level, bLevel: b.level,
      aLevelText: a.levelText, bLevelText: b.levelText
    };
    if (a.level > b.level) {
      return Object.assign(base, { winner: 'a', decidedBy: 'level',
        reason: '成功等级更高（' + a.levelText + ' > ' + b.levelText + '）' });
    }
    if (b.level > a.level) {
      return Object.assign(base, { winner: 'b', decidedBy: 'level',
        reason: '成功等级更高（' + b.levelText + ' > ' + a.levelText + '）' });
    }
    if (a.base > b.base) {
      return Object.assign(base, { winner: 'a', decidedBy: 'value',
        reason: '成功等级相同，技能值更高（' + a.base + ' > ' + b.base + '）' });
    }
    if (b.base > a.base) {
      return Object.assign(base, { winner: 'b', decidedBy: 'value',
        reason: '成功等级相同，技能值更高（' + b.base + ' > ' + a.base + '）' });
    }
    return Object.assign(base, { winner: null, tie: true, needsReroll: true, decidedBy: 'reroll',
      reason: '成功等级与技能值都相同，双方重掷 1D100，骰值**较低**者胜' });
  }

  /** 平局重掷的裁决：低者胜。掷出相同时继续重掷。 */
  function opposedReroll(aRoll, bRoll) {
    var a = clampValue(aRoll), b = clampValue(bRoll);
    if (a === b) return { winner: null, tie: true, needsReroll: true, aRoll: a, bRoll: b,
      reason: '双方都掷出 ' + a + '，继续重掷' };
    return { winner: a < b ? 'a' : 'b', tie: false, needsReroll: false, aRoll: a, bRoll: b,
      reason: '骰值较低者胜（' + a + ' vs ' + b + '）' };
  }

  /**
   * 攻击对抗的**模式敏感**裁定（v2.2.0 需求3 新增）。
   *
   * 规则（CoC 7e 战斗对抗）：
   *   · 成功等级高者胜；等级相同 → 不再比技能值，直接按**防守方式**裁定：
   *       'fightback'（反击）→ 攻击方胜（"反击同级，攻击方胜"）；
   *       'dodge'    （闪避）→ 被攻击方胜（"闪避同级，攻击方败（被躲开、免伤）"）；
   *   · 其余（通用 / mode='none'）→ 比技能值；仍相同 → 双方逐轮重掷 D100，
   *     **骰值较低者胜**，最多 rerollMax（默认 10）轮；
   *     达到上限仍未分出 → 判**发起方（a）胜**并置 fallback:true。
   *
   * ⚠️ 与 opposed() 的区别：opposed() 同级同值会 needsReroll 交给调用方循环，
   *    本函数**自己**跑完重掷循环并把逐轮明细写进 rounds[]，调用方无需再循环。
   *    这样「反击/闪避同级短路、不重掷」的规则才不会被调用方的通用重掷循环抹掉。
   *
   * @param a 攻击（发起）方检定结果(check())  @param b 防守方检定结果
   * @param o { mode:'fightback'|'dodge'|'none', rng, rerollMax=10 }
   * @returns { winner:'a'|'b'|null, decidedBy, reason, rounds:[{round,aRoll,bRoll,winner}], fallback:bool }
   */
  function opposedAttack(a, b, o) {
    o = o || {};
    var rec = [];
    var max = Math.max(1, num(o.rerollMax) || 10);
    if (!a || !b) return { winner: null, decidedBy: 'none', rounds: rec,
      reason: '对抗需要两方的检定结果' };
    if (a.level > b.level) {
      return { winner: 'a', decidedBy: 'level', rounds: rec,
        reason: '成功等级更高（' + a.levelText + ' > ' + b.levelText + '）' };
    }
    if (b.level > a.level) {
      return { winner: 'b', decidedBy: 'level', rounds: rec,
        reason: '成功等级更高（' + b.levelText + ' > ' + a.levelText + '）' };
    }
    var mode = normMode(o.mode);
    if (mode === 'fightback') {
      return { winner: 'a', decidedBy: 'mode_fightback_tie', rounds: rec,
        reason: '反击：双方成功等级相同 → 攻击方（发起方）胜' };
    }
    if (mode === 'dodge') {
      return { winner: 'b', decidedBy: 'mode_dodge_tie', rounds: rec,
        reason: '闪避：双方成功等级相同 → 攻击方败（被躲开、免伤）' };
    }
    if (a.base > b.base) {
      return { winner: 'a', decidedBy: 'value', rounds: rec,
        reason: '成功等级相同，技能值更高（' + a.base + ' > ' + b.base + '）' };
    }
    if (b.base > a.base) {
      return { winner: 'b', decidedBy: 'value', rounds: rec,
        reason: '成功等级相同，技能值更高（' + b.base + ' > ' + a.base + '）' };
    }
    for (var i = 0; i < max; i++) {
      var ar = rollD100Value(o.rng), br = rollD100Value(o.rng);
      var w = (ar === br) ? null : (ar < br ? 'a' : 'b');
      rec.push({ round: i + 1, aRoll: ar, bRoll: br, winner: w });
      if (w) {
        return { winner: w, decidedBy: 'reroll', rounds: rec,
          reason: '重掷：骰值较低者胜（' + ar + ' vs ' + br + '）' };
      }
    }
    return { winner: 'a', decidedBy: 'reroll_fallback', fallback: true, rounds: rec,
      reason: '达到重掷上限，按规则兜底判发起方胜' };
  }

  /** 通用对抗（技能/属性）：等价于 opposedAttack 的「无模式」分支（比等级 → 比数值 → 重掷）。 */
  function opposedFull(a, b, o) {
    o = o || {};
    return opposedAttack(a, b, { mode: 'none', rng: o.rng, rerollMax: o.rerollMax || 10 });
  }

  /* ============================================================
   * 7. 骰式与伤害
   * ============================================================ */

  var MAX_DICE = 100;          // 单次最多 100 颗（防「999D999」这种输入）
  var MAX_SIDES = 1000;

  /**
   * 解析并校验骰式。支持 `NdM`、纯数字、以及它们的加减组合（如 `1D6+1`、`2D10-1`）。
   * 不支持乘除与括号 —— 本项目用不到，少支持一种语法就少一个注入面。
   *
   * 为什么要自己解析而不复用 dice.js#parse：
   *   ① parse 内部直接调用 Math.random，测试无法注入随机源；
   *   ② parse 会静默吞掉不认识的内容（返回 0），校验场景需要明确报错。
   */
  function parseExpr(expr) {
    var raw = String(expr === undefined || expr === null ? '' : expr).trim();
    if (!raw) return { ok: false, reason: '骰式为空', expr: '' };
    var s = raw.replace(/\s+/g, '').toUpperCase();
    var tokens = s.match(/[+-]?[^+-]+/g);
    if (!tokens) return { ok: false, reason: '骰式无法解析：' + raw, expr: raw };

    var terms = [];
    for (var i = 0; i < tokens.length; i++) {
      var tk = tokens[i];
      var sign = 1;
      if (tk[0] === '+') tk = tk.slice(1);
      else if (tk[0] === '-') { sign = -1; tk = tk.slice(1); }
      var m = tk.match(/^(\d*)[D](\d+)$/);
      if (m) {
        var count = m[1] === '' ? 1 : parseInt(m[1], 10);
        var sides = parseInt(m[2], 10);
        if (count < 1 || count > MAX_DICE) return { ok: false, reason: '骰子数量需在 1-' + MAX_DICE + ' 之间', expr: raw };
        if (sides < 2 || sides > MAX_SIDES) return { ok: false, reason: '骰子面数需在 2-' + MAX_SIDES + ' 之间', expr: raw };
        terms.push({ sign: sign, count: count, sides: sides });
      } else if (/^\d+$/.test(tk)) {
        var c = parseInt(tk, 10);
        if (c > 10000) return { ok: false, reason: '常数值过大', expr: raw };
        terms.push({ sign: sign, count: 0, sides: 0, constant: c });
      } else {
        return { ok: false, reason: '骰式里有无法识别的片段「' + tk + '」', expr: raw };
      }
    }
    if (!terms.length) return { ok: false, reason: '骰式无法解析：' + raw, expr: raw };
    return { ok: true, expr: raw, terms: terms };
  }

  /** 按解析结果掷骰，返回 {ok, total, rolls:[...], detail} */
  function rollExpr(expr, rng) {
    var p = (typeof expr === 'string' || typeof expr === 'number') ? parseExpr(expr) : expr;
    if (!p || !p.ok) return { ok: false, reason: (p && p.reason) || '骰式不合法', total: 0, rolls: [] };
    var total = 0, rolls = [], detail = [];
    p.terms.forEach(function (t) {
      if (!t.count) {
        total += t.sign * t.constant;
        detail.push((t.sign < 0 ? '-' : '+') + t.constant);
        return;
      }
      var dice = [];
      for (var i = 0; i < t.count; i++) {
        var v = 1 + Math.floor(pickRng(rng)() * t.sides);
        if (v < 1) v = 1; if (v > t.sides) v = t.sides;
        dice.push(v);
        total += t.sign * v;
      }
      rolls.push({ count: t.count, sides: t.sides, sign: t.sign, dice: dice });
      detail.push((t.sign < 0 ? '-' : '+') + t.count + 'D' + t.sides + '[' + dice.join(',') + ']');
    });
    return { ok: true, expr: p.expr, total: total, rolls: rolls, detail: detail.join('') || '0' };
  }

  /** 伤害加值字符串（如 '+1D4'、'-2'、'0'）→ 掷骰结果 */
  function rollDamageBonus(dbStr, rng) {
    var s = String(dbStr === undefined || dbStr === null ? '' : dbStr).trim();
    if (!s || s === '0') return { ok: true, total: 0, detail: '0（无伤害加值）', rolls: [] };
    if (s[0] !== '+' && s[0] !== '-') s = '+' + s;
    return rollExpr(s, rng);
  }

  /* ============================================================
   * 8. 理智（SAN）
   * ============================================================ */

  /**
   * 解析 SAN 损失格式 `成功损失/失败损失`，例如 `0/1D6`、`1/1D4`、`1D3/1D10`。
   * 两侧都按骰式校验，所以 `0/999D999` 会被拒。
   */
  function parseSanLoss(expr) {
    var raw = String(expr === undefined || expr === null ? '' : expr).trim();
    if (!raw) return { ok: false, reason: '理智损失格式为空（应形如 0/1D6）' };
    var parts = raw.split('/');
    if (parts.length !== 2) {
      return { ok: false, reason: '理智损失需要写成「成功损失/失败损失」，例如 0/1D6', expr: raw };
    }
    var onOk = parseExpr(parts[0]);
    var onFail = parseExpr(parts[1]);
    if (!onOk.ok) return { ok: false, reason: '成功损失不合法：' + onOk.reason, expr: raw };
    if (!onFail.ok) return { ok: false, reason: '失败损失不合法：' + onFail.reason, expr: raw };
    return { ok: true, expr: raw, onSuccess: onOk, onFail: onFail };
  }

  /**
   * 结算一次 SAN 检定。
   *   成功 → 用斜线**前**的损失；失败 → 用斜线**后**的损失。
   *   大失败按失败处理（更狠的具体后果由 KP 裁定，不由程序编）。
   *
   * @param opts.currentSan  检定前当前 SAN
   * @param opts.maxSan      理智上限（当前 SAN 不超过它）
   * @param opts.lossExpr    '0/1D6'
   * @param opts.rng         随机源
   * @param opts.checkResult  已经掷好的检定结果（可选，省得掷两次）
   */
  function resolveSanCheck(opts) {
    opts = opts || {};
    var parsed = parseSanLoss(opts.lossExpr);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };

    var chk = opts.checkResult || check({
      base: num(opts.currentSan), difficulty: 'regular', kind: 'san',
      label: '理智检定', rng: opts.rng,
      /* v2.3.0（用户第 7 项）：SAN 检定同样接受自定义大成功 / 大失败阈值。 */
      critMax: opts.critMax, fumbleMin: opts.fumbleMin
    });
    var branch = chk.passed ? parsed.onSuccess : parsed.onFail;
    var rolled = rollExpr(branch, opts.rng);
    if (!rolled.ok) return { ok: false, reason: rolled.reason };

    var before = Math.max(0, num(opts.currentSan));
    var maxSan = (opts.maxSan === undefined || opts.maxSan === null) ? 99 : Math.max(0, num(opts.maxSan));
    var after = Math.max(0, before - rolled.total);
    if (after > maxSan) after = maxSan;      // 只做上限约束，不清空、不编造后果

    return {
      ok: true,
      check: chk,
      lossExpr: parsed.expr,
      usedBranch: chk.passed ? 'onSuccess' : 'onFail',
      branchText: chk.passed ? '成功' : '失败',
      lossTerms: parsed[chk.passed ? 'onSuccess' : 'onFail'],
      roll: rolled,
      loss: rolled.total,
      before: before, after: after, maxSan: maxSan
    };
  }

  /**
   * 疯狂提示。**只提示，不自动编剧情后果**（需求 §7.5）。
   *
   *   ① 单次 SAN 损失 ≥ 5 → 提示 KC 让角色做 INT 检定（临时疯狂）
   *   ② 一天内累计损失 ≥ 当天开始 SAN 的五分之一 → 提示不定性疯狂
   *
   * 第 ② 条用「累计 × 5 ≥ 当日开始 SAN」比较，不做除法取整 ——
   * 取整会让 1/5 的边界在奇数上忽左忽右，玩家会认为系统算错了。
   */
  function insanityFlags(opts) {
    opts = opts || {};
    var loss = Math.max(0, num(opts.loss));                    // 本次损失
    var dayStart = Math.max(0, num(opts.dayStartSan));         // 当天开始时的 SAN
    var dayTotal = Math.max(0, num(opts.dayLossSoFar)) + loss; // 当天累计（含本次）

    var flags = {
      loss: loss, dayStartSan: dayStart, dayTotal: dayTotal,
      temporary: loss >= 5,
      temporaryReason: loss >= 5
        ? '单次理智损失 ' + loss + ' 点（≥ 5），按规则应进行 INT 检定判定临时疯狂' : '',
      indefinite: dayStart > 0 && dayTotal * 5 >= dayStart,
      indefiniteReason: '',
      threshold: dayStart > 0 ? Math.ceil(dayStart / 5) : 0
    };
    if (flags.indefinite) {
      flags.indefiniteReason = '当天累计理智损失 ' + dayTotal +
        ' 点，达到当天开始理智（' + dayStart + '）的五分之一（' + flags.threshold + ' 点），应判定不定性疯狂';
    }
    return flags;
  }

  /* ============================================================
   * 9. 生命值与伤势
   * ============================================================ */

  /**
   * 单次伤害结算。**只算状态与提示，不改角色对象**（由调用方落库）。
   *
   * 规则书（Pg.119-120）：
   *   · 单次伤害 ≥ 最大 HP 的一半 → 重大伤口，需做 CON 检定
   *   · 单次伤害 **> 最大 HP** → 致死（v2.8.0 口径：恰等于上限 → 重伤 → 濒死）
   *   · HP 归零且**有**重大伤口 → 濒死（每轮 CON 检定）
   *   · HP 归零且**没有**重大伤口 → 昏迷
   */
  function damageFlags(opts) {
    opts = opts || {};
    var dmg = Math.max(0, num(opts.damage));
    var maxHP = Math.max(1, num(opts.maxHP));
    var before = Math.max(0, num(opts.currentHP));
    var hadMajor = !!opts.majorWound;

    var majorWound = dmg * 2 >= maxHP;
    var hasMajor = hadMajor || majorWound;
    /* v2.8.0（HP 机制 · 用户口径）：即死阈值由 `>=` 改为 `>` —— 恰等于最大 HP 归入
       「重伤 → HP 归零 → 濒死」，与 room-model#settleWounds 完全一致。 */
    var lethal = dmg > maxHP;
    var after = Math.max(0, before - dmg);

    var state = 'normal';
    if (lethal) state = 'dead';
    else if (after === 0) state = hasMajor ? 'dying' : 'unconscious';

    var STATE_TEXT = { normal: '存活', unconscious: '昏迷', dying: '濒死', dead: '死亡' };
    return {
      damage: dmg, before: before, after: after, maxHP: maxHP,
      majorWound: majorWound,            // 本次伤害是否构成重大伤口
      hasMajorWound: hasMajor,           // 结算后角色是否处于重大伤口状态
      lethal: lethal,
      needsConCheck: majorWound && !lethal,
      state: state, stateText: STATE_TEXT[state],
      requireFirstAid: state === 'dying' || state === 'unconscious',
      summary: buildDamageSummary(dmg, before, after, maxHP, majorWound, lethal, STATE_TEXT[state])
    };
  }

  function buildDamageSummary(dmg, before, after, maxHP, major, lethal, stateText) {
    var s = '受到 ' + dmg + ' 点伤害，HP ' + before + ' → ' + after + '（上限 ' + maxHP + '）';
    if (lethal) s += '　·　单次伤害达到最大生命值，触发致死结算';
    else if (major) s += '　·　单次伤害达到最大生命值的一半，构成重大伤口，需做 CON 检定';
    s += '　·　当前状态：' + stateText;
    return s;
  }

  /**
   * 濒死角色的每轮 CON 检定解读。
   *   成功 → 本轮稳定，继续濒死；失败 → 死亡。
   *   （规则书：濒死时每轮 CON 检定，失败即死亡；急救 / 医术按规则处理。）
   */
  function dyingRoundCheck(con, rng) {
    var r = check({ base: con, difficulty: 'regular', kind: 'combat', label: '濒死 CON 检定', rng: rng });
    return {
      check: r,
      stable: r.passed,
      dead: !r.passed,
      summary: r.passed
        ? 'CON 检定成功，本轮伤势稳定，仍处于濒死'
        : 'CON 检定失败 —— 死亡'
    };
  }

  /**
   * 临时疯狂发作判定（CoC 7e，单次 SAN 损失 ≥ 5 时触发）。
   *
   * 规则（Keeper Rulebook, Sanity 章节）：
   *   损失达到阈值后，角色做一次 INT 检定——
   *   · 成功 → 角色「理解」了眼前发生的事 → 立即进入疯狂发作（bout of madness），
   *     掷一个疯狂症状（恐惧症 / 狂躁症），持续 1D10 轮；
   *   · 失败 → 角色压抑了这份理解 → 暂不发作（可能延后，由 KP 裁定）。
   *
   * 这里只做 INT 检定与「是否理解」的判定 —— **症状表抽取**由调用方（持有
   * 症状数据表的权威端）负责，规则服务保持纯函数、不依赖数据。
   *
   * @param intValue  角色的智力 INT（属性值，如 65）
   * @param rng       随机源（可注入）
   * @returns {{check, understood, summary}}
   */
  function temporaryInsanityCheck(intValue, rng) {
    var chk = check({ base: num(intValue), difficulty: 'regular', kind: 'attribute',
                      label: '临时疯狂 INT 检定', rng: rng });
    return {
      check: chk,
      understood: chk.passed,
      summary: chk.passed
        ? 'INT 检定成功（掷 ' + chk.value + ' ≤ ' + chk.base + '）—— 理解了眼前的事，进入疯狂发作'
        : 'INT 检定失败（掷 ' + chk.value + ' > ' + chk.base + '）—— 未能理解，暂时压抑'
    };
  }

  /** 疯狂发作的持续轮数：规则书 1D10。 */
  function boutRounds(rng) {
    return 1 + Math.floor(pickRng(rng)() * 10);
  }

  /* ============================================================
   * 10. 战斗行动顺序
   * ============================================================ */

  /**
   * 默认行动顺序（需求 §8.1）。
   *
   *   规则：按 DEX 从高到低；已**准备好**的枪械按 DEX+50 计算。
   *   KP 可以手动调整，此时相应条目要标成「手动」——
   *   界面上必须让玩家看得出这一条不是规则算出来的。
   *
   *   每轮多次行动的怪物 / Boss **必须展开成多个行动槽**，
   *   不能完成一次行动就永久从队列消失（需求 §8.1 明确点名）。
   *
   * @param actors [{id,name,dex,readyFirearm,actionsPerRound,manualOrder}]
   * @param opts.useReadyFirearm 是否启用「已准备枪械 DEX+50」（默认启用）
   */
  function initiativeOrder(actors, opts) {
    opts = opts || {};
    var useReady = opts.useReadyFirearm !== false;
    var list = (actors || []).map(function (a) {
      var dex = num(a.dex);
      var ready = !!a.readyFirearm;
      var effDex = (useReady && ready) ? dex + 50 : dex;
      var actions = Math.max(1, num(a.actionsPerRound) || 1);
      // manualOrder 越小越靠前；未指定的排在手工项之后，内部仍按 DEX 排
      var manual = (a.manualOrder === undefined || a.manualOrder === null || a.manualOrder === '')
        ? null : num(a.manualOrder);
      return {
        id: a.id, name: a.name || '', dex: dex, readyFirearm: ready,
        effDex: effDex, actionsPerRound: actions, manualOrder: manual,
        manual: manual !== null,
        note: (useReady && ready) ? '已准备枪械：按 DEX+50 行动' : ''
      };
    });

    list.sort(function (x, y) {
      if (x.manual && y.manual) return x.manualOrder - y.manualOrder;
      if (x.manual) return -1;
      if (y.manual) return 1;
      if (y.effDex !== x.effDex) return y.effDex - x.effDex;
      if (y.dex !== x.dex) return y.dex - x.dex;
      return String(x.name).localeCompare(String(y.name));
    });

    var queue = [];
    list.forEach(function (a) {
      for (var i = 0; i < a.actionsPerRound; i++) {
        queue.push(Object.assign({}, a, {
          slot: i + 1, totalSlots: a.actionsPerRound,
          /** 是否该角色本轮的最后一次行动 —— 界面据此决定要不要提示「该角色已行动完」 */
          lastSlot: i + 1 === a.actionsPerRound
        }));
      }
    });
    return {
      order: queue,
      /** 按角色去重的一份，用于展示与统计 */
      actors: list,
      manualCount: list.filter(function (a) { return a.manual; }).length,
      summary: queue.map(function (q, i) {
        return (i + 1) + '. ' + (q.name || q.id) + '（DEX ' + q.dex +
          (q.totalSlots > 1 ? '，第 ' + q.slot + '/' + q.totalSlots + ' 次行动' : '') + '）';
      }).join('　')
    };
  }

  /**
   * 推进到下一个行动项。一轮走完回到队首、回合号 +1。
   * 返回新的 (index, round)。**不删任何条目** ——
   * 多行动的怪物走完自己的槽位后，下一轮自然还会出现在队列里。
   */
  function advanceTurn(index, round, queueLength) {
    var n = Math.max(1, num(queueLength));
    var i = num(index);
    var r = Math.max(1, num(round) || 1);
    i++;
    var wrapped = false;
    if (i >= n) { i = 0; r++; wrapped = true; }
    return { index: i, round: r, roundWrapped: wrapped };
  }

  /* ============================================================
   * 11. 战斗结算（契约 §4.1）
   * ============================================================ */

  /** 攻击结算的结局枚举（契约 §4.1）。 */
  var OUTCOME = {
    HIT: 'hit',                     // 无对抗（defense.mode='none'）下的纯命中
    MISS: 'miss',                   // 攻击落空（攻击方失败 / 被闪避）
    ATTACKER_WINS: 'attacker_wins', // 对抗中攻击方胜出 → 命中
    DEFENDER_WINS: 'defender_wins'  // 对抗中防御方胜出（反击）→ 由防御方造成伤害
  };

  /** 契约 §4.1 要求的 level 取值：常规成功写作 'success'（区别于 LEVEL_KEY 的 'regular'）。 */
  var ATTACK_LEVEL_KEY = {
    '5': 'critical', '4': 'extreme', '3': 'hard', '2': 'success', '0': 'fail', '-1': 'fumble'
  };

  /** 归一化防御方式：只有 'dodge' / 'fightback' 是有效防御，其余一律视为 'none'。 */
  function normMode(mode) {
    var m = String(mode === undefined || mode === null ? '' : mode).trim().toLowerCase();
    if (m === 'dodge' || m === '闪避') return 'dodge';
    if (m === 'fightback' || m === 'fight_back' || m === 'fight back' || m === '反击') return 'fightback';
    return 'none';
  }

  /** 骰式的理论最大值（贯穿武器「极难成功取最大值」用）。非法骰式返回 0。 */
  function maxOfExpr(expr) {
    var p = parseExpr(expr);
    if (!p.ok) return 0;
    var total = 0;
    p.terms.forEach(function (t) {
      if (!t.count) total += t.sign * t.constant;
      else total += t.sign * t.count * t.sides;
    });
    return total;
  }

  /**
   * v2.3.0（用户第 9 项）：伤害加值（DB）字符串的**理论最大值**。
   * 与 rollDamageBonus 同一套归一（缺符号补 '+'、'0'/空 → 0），但取最大而非掷骰。
   * '+1D4' → 4；'-2' → -2；'0' → 0；非法 → 0。
   */
  function maxOfDamageBonus(dbStr) {
    var s = String(dbStr === undefined || dbStr === null ? '' : dbStr).trim();
    if (!s || s === '0') return 0;
    if (s[0] !== '+' && s[0] !== '-') s = '+' + s;
    return maxOfExpr(s);
  }

  /**
   * v2.3.0（用户第 9 项）：**贯穿伤害**的统一实现（room-rules#resolveAttack 与
   * room-model#_opposedPlayerTarget 两处共用，杜绝「两套公式」）。
   *
   * 用户口径公式（CoC 7e 贯穿）：**武器伤害理论最大值 + 最大伤害加值 + 再投一次武器伤害骰**。
   *   ⚠️ 旧实现用的是「实际掷出的 DB」；这里改为**取 DB 最大值**（maxOfDamageBonus）。
   *   ⚠️ 传入的 expr 必须是**已剥掉 DB / 半DB 记号**的武器伤害式
   *      （见 room-model#weaponDamageExpr）—— 否则会把 DB 计两遍。
   *
   * @param {string} expr 武器伤害式（可掷）
   * @param {string} db   伤害加值（如 '+1D4' / '-2' / '0'）
   * @param {Function} rng 随机源（可注入）
   * @returns {{ok, raw, base, dbMax, extra}}
   */
  function impaleDamage(expr, db, rng) {
    var extra = rollExpr(expr, rng);
    if (!extra || !extra.ok) return { ok: false, reason: (extra && extra.reason) || '伤害式不合法' };
    var base = maxOfExpr(expr);
    var dbMax = maxOfDamageBonus(db);
    return { ok: true, extra: extra, base: base, dbMax: dbMax, raw: base + extra.total + dbMax };
  }

  /** 掷一个百分骰并只取结果值（平局重掷用）。 */
  function rollD100Value(rng) { return rollD100({ rng: rng }).value; }

  /**
   * 结算一次攻击（契约 §4.1）。
   *
   * 规则依据（CoC 7e）：
   *   · 攻击方先做战斗检定；**没成功**一律落空。
   *   · 攻击方成功后，防御方按 mode 响应：
   *       - 'none'      → 纯命中（无人防御）
   *       - 'dodge'     → 按成功等级比较，防御方胜出则攻击被躲开（免伤）
   *       - 'fightback' → 按成功等级比较，防御方胜出则**由防御方造成伤害**
   *     等级比较沿用 opposed()：高者胜 → 同级比技能值 → 仍相同则双方重掷 D100、低者胜。
   *   · 远程（ranged）目标**不能反击**，fightback 会被降级为 dodge。
   *   · 贯穿（impale）：攻击方极难 / 大成功时，伤害取骰式最大值并**追加一次伤害骰**。
   *   · 护甲在应用前扣除，最低 0。
   *   · 大成功 / 大失败沿用 check() 的判定，不另写一套。
   *
   * ⚠️ 契约 §4.1 的输入里没有「目标 HP」，但 flags 需要它才能算濒死 / 昏迷 / 死亡，
   *    因此额外支持可选的 o.target / o.maxHP / o.currentHP；缺省时 flags 全 false 且带 unknown:true。
   *    同时额外支持 o.ranged（或 o.attack.ranged）区分远近战、o.attack.roll / o.defense.roll 直接指定
   *    骰值（重放用）—— 这两项是**契约的加法扩展**，不改变任何既有字段语义。
   *
   * rng 消耗顺序（测试构造确定性骰源时依赖此顺序）：
   *   ① 攻击方检定 2 次（个位骰、十位骰）
   *   ② 防御方检定 2 次（mode ≠ 'none' 时）
   *   ③ 伤害主掷（每个骰 1 次）
   *   ④ 伤害加值（db 为 '0' / 空时不消耗）
   *   ⑤ 贯穿追加骰（仅贯穿生效时，每个骰 1 次）
   *   ⑥ 平局重掷（通用对抗同级同值时才发生；每轮 4 次：双方各 2 次），最多 10 轮
   */
  function resolveAttack(o) {
    o = o || {};
    var attackSpec = o.attack || {};
    var defenseSpec = o.defense || {};
    var rng = o.rng;

    /* ① 攻击方检定 —— kind:'combat'（战斗检定：不可推动、不可花幸运）。 */
    var attack = check({
      base: num(attackSpec.value),
      difficulty: o.difficulty,
      bonus: o.bonus,
      penalty: o.penalty,
      kind: 'combat',
      label: attackSpec.name || '攻击',
      secret: !!o.secret,
      value: attackSpec.roll,
      rng: rng,
      /* v2.3.0（用户第 7 项）：攻击检定接受自定义大成功 / 大失败阈值。 */
      critMax: o.critMax, fumbleMin: o.fumbleMin
    });

    /* 远程目标不能反击：把 fightback 降级为 dodge。 */
    var ranged = o.ranged === true || attackSpec.ranged === true;
    var requestedMode = normMode(defenseSpec.mode);
    var mode = requestedMode;
    var coercedFromFightback = false;
    if (ranged && mode === 'fightback') { mode = 'dodge'; coercedFromFightback = true; }

    /* ② 防御方检定（闪避 / 反击都按常规难度；规则不允许对防御选难度）。 */
    var defense = null;
    if (mode !== 'none') {
      defense = check({
        base: num(defenseSpec.value),
        difficulty: 'regular',
        kind: 'combat',
        label: defenseSpec.name || (mode === 'dodge' ? '闪避' : '反击'),
        value: defenseSpec.roll,
        rng: rng,
        critMax: o.critMax, fumbleMin: o.fumbleMin
      });
    }

    /* 结局判定。v2.2.0（用户第 3 项）：改用模式敏感的 opposedAttack ——
       反击同级 → 攻方胜；闪避同级 → 攻方败（免伤）；通用同级同值 → 逐轮重掷（≤10 轮兜底）。
       ⚠️ opposedAttack 自己跑完重掷循环并把逐轮明细写进 compare.rounds，
          这里不再需要 needsReroll 循环（那会把「反击/闪避同级短路」的规则抹掉）。 */
    var outcome, compare = null, rerolls = [];
    if (!attack.passed) {
      outcome = OUTCOME.MISS;                       // 攻击方没成功 → 落空（无需比较）
    } else if (mode === 'none') {
      outcome = OUTCOME.HIT;                        // 无人防御 → 纯命中
    } else {
      compare = opposedAttack(attack, defense, { mode: mode, rng: rng });
      rerolls = compare.rounds || [];
      if (compare.winner === 'a') outcome = OUTCOME.ATTACKER_WINS;
      else if (mode === 'dodge') outcome = OUTCOME.MISS;            // 闪避胜出 → 免伤
      else outcome = OUTCOME.DEFENDER_WINS;                         // 反击胜出 → 反击方造成伤害
    }

    var attackerDeals = (outcome === OUTCOME.HIT || outcome === OUTCOME.ATTACKER_WINS);
    var defenderDeals = (outcome === OUTCOME.DEFENDER_WINS);
    var damageBy = attackerDeals ? 'attacker' : (defenderDeals ? 'defender' : null);

    /* ③④⑤ 伤害结算。反击时优先用防御方自己的伤害式（o.defense.damage），否则沿用 o.damage。 */
    var dmgSpec = (defenderDeals && defenseSpec.damage) ? defenseSpec.damage : (o.damage || {});
    var exprRaw = dmgSpec.expr;
    var expr = (exprRaw === undefined || exprRaw === null || String(exprRaw).trim() === '') ? '0' : String(exprRaw);
    var db = dmgSpec.db;
    var armorValue = Math.max(0, num(o.armor && o.armor.value));
    var impaleApplies = attackerDeals && !!o.impale &&
      (attack.level === LEVEL.EXTREME || attack.level === LEVEL.CRITICAL);

    var damage = { raw: 0, expr: expr, dbDice: null, impale: false, armor: armorValue, applied: 0 };
    if (attackerDeals || defenderDeals) {
      var main = rollExpr(expr, rng);
      var dbRoll = rollDamageBonus(db, rng);
      damage.main = main;
      damage.dbDice = dbRoll;
      var raw = main.total + dbRoll.total;
      if (impaleApplies) {
        /* v2.3.0（用户第 9 项）：贯穿 = 武器伤害**最大值** + **最大 DB** + 追加一次伤害骰。
           统一走 impaleDamage（与 room-model#_opposedPlayerTarget 共用同一实现，杜绝两套公式）。 */
        var imp = impaleDamage(expr, db, rng);
        if (imp.ok) {
          damage.extra = imp.extra;
          damage.impale = true;
          damage.impaleDbMax = imp.dbMax;
          raw = imp.raw;
        }
      }
      damage.raw = raw;
      damage.applied = Math.max(0, raw - armorValue);          // 护甲应用前扣除，最低 0
    }

    /* flags 复用 damageFlags（需要目标 HP；缺省时给出 unknown 占位）。 */
    var target = o.target || {};
    var maxHP = num(o.maxHP !== undefined ? o.maxHP : target.maxHP);
    var currentHP = num(o.currentHP !== undefined ? o.currentHP : target.currentHP);
    var flags;
    if (maxHP > 0) {
      var df = damageFlags({
        damage: damage.applied, maxHP: maxHP, currentHP: currentHP,
        majorWound: !!target.majorWound
      });
      flags = {
        majorWound: df.hasMajorWound, dying: df.state === 'dying',
        unconscious: df.state === 'unconscious', dead: df.state === 'dead',
        state: df.state, stateText: df.stateText,
        needsConCheck: df.needsConCheck, lethal: df.lethal, detail: df
      };
    } else {
      flags = { majorWound: false, dying: false, unconscious: false, dead: false, unknown: true };
    }

    var level = ATTACK_LEVEL_KEY[String(attack.level)] || 'fail';

    var result = {
      attack: attack, defense: defense, outcome: outcome,
      damage: damage, level: level, flags: flags,
      /* 以下为便于界面 / 日志使用的附加信息 */
      mode: mode, ranged: ranged, coercedFromFightback: coercedFromFightback,
      compare: compare, rerolls: rerolls, damageBy: damageBy
    };
    result.summary = buildAttackSummary(result);
    return result;
  }

  /** 组装一句人类可读的攻击结论（界面直接显示）。 */
  function buildAttackSummary(r) {
    var s = [];
    s.push('攻击方「' + (r.attack.label || '攻击') + '」' + r.attack.levelText +
      '（掷 ' + r.attack.value + '，本次要求 ≤ ' + r.attack.target + '）');
    if (r.coercedFromFightback) s.push('远程攻击：目标不能反击，按闪避处理');
    if (r.mode === 'none') s.push('目标未做防御');
    else if (r.defense) s.push('防御方「' + r.defense.label + '」' + r.defense.levelText + '（掷 ' + r.defense.value + '）');

    var absorbed = Math.min(r.damage.armor, r.damage.raw);
    if (r.outcome === OUTCOME.HIT || r.outcome === OUTCOME.ATTACKER_WINS) {
      var t = '→ 命中，造成 ' + r.damage.applied + ' 点伤害（伤害骰 ' + r.damage.raw +
        '，护甲 ' + r.damage.armor + ' 点，实际减免 ' + absorbed + '）';
      if (r.damage.impale) t += '，贯穿：伤害取最大值并追加一次伤害骰';
      s.push(t);
    } else if (r.outcome === OUTCOME.DEFENDER_WINS) {
      s.push('→ 反击成功，由防御方造成 ' + r.damage.applied + ' 点伤害（伤害骰 ' + r.damage.raw +
        '，护甲 ' + r.damage.armor + ' 点，实际减免 ' + absorbed + '）');
    } else if (r.mode === 'dodge' && r.defense && r.defense.passed) {
      s.push('→ 闪避成功，攻击被躲开，未造成伤害');
    } else {
      s.push('→ 攻击落空，未造成伤害');
    }
    if (r.flags && r.flags.state && r.flags.state !== 'normal') s.push('目标状态：' + r.flags.stateText);
    return s.join('　·　');
  }

  /* ============================================================
   * 12. 角色卡取值（契约 §4.2 / §6.1）
   * ============================================================ */

  /** 属性中文名 / 缩写 → key（与 rules-coc7.js 的 CN2KEY 同口径，本模块自带一份以保持纯函数）。 */
  var ATTR_CN2KEY = {
    '力量': 'str', 'str': 'str', 'STR': 'str',
    '体质': 'con', 'con': 'con', 'CON': 'con',
    '体型': 'siz', 'siz': 'siz', 'SIZ': 'siz',
    '敏捷': 'dex', 'dex': 'dex', 'DEX': 'dex',
    '外貌': 'app', 'app': 'app', 'APP': 'app',
    '智力': 'int', '灵感': 'int', 'int': 'int', 'INT': 'int',
    '意志': 'pow', 'pow': 'pow', 'POW': 'pow',
    '教育': 'edu', 'edu': 'edu', 'EDU': 'edu',
    '幸运': 'luck', '运气': 'luck', 'luck': 'luck', 'LUCK': 'luck'
  };

  /**
   * 技能别名白名单（保守）。模糊匹配走「别名 → 基名相等 → 子类名相等」，
   * 命中多个同名技能即视为歧义 → 返回 null（宁缺勿错，让上层兜底）。
   *
   * v2.2.2（用户第 2 项）：补齐常见组技能的「短名 → 组技能全名」别名；别名**值**
   * 一律用半角括号书写即可 —— 匹配前会归一括号宽度（见 normSkillName），
   * 因此无论人物卡里写的是「格斗（斗殴）」（全角）还是「格斗(斗殴)」（半角）都能命中。
   */
  var SKILL_ALIAS = {
    '斗殴': '格斗(斗殴)',
    '擒抱': '格斗(擒抱)',
    '踢击': '格斗(踢)',
    '踢': '格斗(踢)',
    '射击': '射击(手枪)',
    '手枪': '射击(手枪)',
    '步枪': '射击(步枪)',
    '霰弹枪': '射击(霰弹枪)',
    '冲锋枪': '射击(冲锋枪)',
    '机枪': '射击(机枪)',
    '弓': '射击(弓)',
    '弩': '射击(弩)',
    '侦察': '侦查',
    '图书馆': '图书馆使用',
    '计算机': '计算机使用',
    '开锁': '锁匠'
  };

  /**
   * v2.2.2（用户第 2 项）：技能名归一 —— 把**全角/半角括号、方括号、花括号、角括号**
   * 统一成半角 `()`，去掉所有空白与首尾分隔标点，大小写统一。
   *
   * 旧实现只去空格 + 小写、**不归一括号宽度**：人物卡里的技能名由
   * `skillmodel.js#displayName()` 组成的是**全角**「格斗（斗殴）」，而
   * `SKILL_ALIAS['斗殴'] = '格斗(斗殴)'` 用的是**半角**括号 —— 精确命中、别名命中、
   * 基名匹配（`skillBase('斗殴')='斗殴'` vs 卡上 `'格斗'`）三重措辞全部落空 → 返回 null
   * → 玩家用「包皮铁棍」（技能「斗殴」）发起武器对抗时被报「在发起者人物卡里查不到『斗殴』」。
   * 归一后两种括号宽度等价，且别名、基名、子类名三个匹配档位都能正确命中。
   */
  function normSkillName(s) {
    var str = String(s === undefined || s === null ? '' : s);
    str = str
      .replace(/[（【〔〖［｛]/g, '(')          // 各类左括号 → '('
      .replace(/[）】〕〗］｝]/g, ')')          // 各类右括号 → ')'
      .replace(/\[/g, '(')                     // 半角方括号左 → '('
      .replace(/\]/g, ')');                    // 半角方括号右 → ')'
    str = str.replace(/[\s\u3000]/g, '');                        // 去所有空白（含全角空格）
    str = str.replace(/^[·.．、,，;；:：\-—_/｜|]+/, '')          // 去首部标点
             .replace(/[·.．、,，;；:：\-—_/｜|]+$/, '');         // 去尾部标点
    return str.toLowerCase();
  }
  /** 技能名的「基名」：去掉括号（中/英/方/花）及其内容，或用 ｜ 分隔的开头片段。'格斗(斗殴)' → '格斗' */
  function skillBase(s) {
    var n = String(s === undefined || s === null ? '' : s).trim();
    var i = n.search(/[（(【〔〖［｛\[]|[｜|]/);
    return (i < 0 ? n : n.slice(0, i)).trim();
  }
  /**
   * v2.2.2（用户第 2 项）：拆出技能名的**子类名**（括号里的内容，可能有多个，
   * 用 `/ ｜ | ／ 、 , ，` 分隔）。'格斗（斗殴）' → ['斗殴']。
   * @returns {string[]}
   */
  function skillSpecs(s) {
    var raw = String(s === undefined || s === null ? '' : s);
    var specs = [];
    var re = /[（(【〔〖［｛\[]([^）)】〕〗］｝\]]*)[）)】〕〗］｝\]]/g;
    var m;
    while ((m = re.exec(raw)) !== null) {
      String(m[1]).split(/[｜|／\/、,，]/).forEach(function (x) {
        var t = x.trim();
        if (t) specs.push(t);
      });
    }
    return specs;
  }
  function totalOfSkill(s) {
    if (!s) return null;
    var v = (s.total === undefined || s.total === null) ? s.value : s.total;
    if (v === undefined || v === null) return null;
    var n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  }

  /**
   * 从角色卡 sheet 按技能名取值（契约 §4.2）。查不到返回 null。
   *
   * v2.2.2（用户第 2 项）：匹配档位（依次，命中多个即判为歧义 → 返回 null）：
   *   ① 精确名（归一括号宽度 / 空白 / 大小写后相等）
   *   ② 别名（如 '斗殴' → '格斗(斗殴)'；键值均按归一比较）
   *   ③ 基名相等（如 '格斗' → '格斗(斗殴)'）
   *   ④ 子类名相等（查询名 == 卡上技能括号里的子类名，如 '斗殴' → '格斗（斗殴）'）
   * 这样无论人物卡把技能写成全角「格斗（斗殴）」还是半角「格斗(斗殴)」都能命中，
   * 修复「玩家用『包皮铁棍』（技能「斗殴」）发起对抗时报查不到『斗殴』」。
   */
  function skillValue(sheet, skillName) {
    if (!sheet || typeof sheet !== 'object') return null;
    var skills = sheet.skills;
    if (!Array.isArray(skills) || !skills.length) return null;
    var q = normSkillName(skillName);
    if (!q) return null;

    // ① 精确名（忽略括号宽度、空白与大小写）
    var exact = skills.filter(function (s) { return s && normSkillName(s.name) === q; });
    if (exact.length === 1) return totalOfSkill(exact[0]);
    if (exact.length > 1) return null;

    // ② 别名（键先按原样、再按归一命中；别名值按归一比较 → 全/半角括号等价）
    var aliasKey = String(skillName === undefined || skillName === null ? '' : skillName).trim();
    var alias = SKILL_ALIAS[aliasKey] || SKILL_ALIAS[q];
    if (alias) {
      var byAlias = skills.filter(function (s) { return s && normSkillName(s.name) === normSkillName(alias); });
      if (byAlias.length === 1) return totalOfSkill(byAlias[0]);
      if (byAlias.length > 1) return null;
    }

    // ③ 基名相等 / ④ 子类名相等（并集；唯一命中才算，歧义仍返回 null）
    var qBase = normSkillName(skillBase(skillName));
    var cands = skills.filter(function (s) {
      if (!s) return false;
      var sBase = normSkillName(skillBase(s.name));
      if (qBase && sBase && sBase === qBase) return true;        // ③ 基名相等
      var specs = skillSpecs(s.name);
      for (var i = 0; i < specs.length; i++) {
        if (normSkillName(specs[i]) === q) return true;          // ④ 查询名 == 卡上子类名
      }
      return false;
    });
    if (cands.length === 1) return totalOfSkill(cands[0]);
    return null;
  }

  /**
   * 从角色卡 sheet 按属性名取值（契约 §4.2）。name 支持中文（'力量'）或 key（'str'）。
   * 查不到返回 null。
   */
  function attrValue(sheet, name) {
    if (!sheet || typeof sheet !== 'object') return null;
    var attrs = sheet.attrs;
    if (!attrs || typeof attrs !== 'object') return null;
    var raw = String(name === undefined || name === null ? '' : name).trim();
    if (!raw) return null;
    var key = ATTR_CN2KEY[raw] || ATTR_CN2KEY[raw.toUpperCase()] || null;
    if (!key) {
      // 也允许直接传 attrs 里真实存在的 key（含大小写变体）
      if (Object.prototype.hasOwnProperty.call(attrs, raw)) key = raw;
      else if (Object.prototype.hasOwnProperty.call(attrs, raw.toLowerCase())) key = raw.toLowerCase();
      else if (Object.prototype.hasOwnProperty.call(attrs, raw.toUpperCase())) key = raw.toUpperCase();
    }
    if (!key || !Object.prototype.hasOwnProperty.call(attrs, key)) return null;
    var v = attrs[key];
    if (v === undefined || v === null) return null;
    var n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  }

  /* ============================================================
   * 13. 场景检定步骤（契约 §4.3）
   * ============================================================ */

  /** 归一化一个分支（onSuccess / onFailure）。 */
  function normBranch(b) {
    b = b || {};
    var next = b.next;
    var hasNext = !(next === undefined || next === null || String(next).trim() === '');
    /* 'end' / 'done' / '结束' 视为终止符：兼容 E 线「next==='end' 表示结束」的约定 ——
       仍**原样回传** next（E 可继续用 next==='end' 判断），同时把 done 置真。 */
    var isEnd = hasNext && /^(end|done|结束)$/i.test(String(next).trim());
    return {
      damage: (b.damage === undefined || b.damage === null || String(b.damage).trim() === '') ? null : String(b.damage),
      note: (b.note === undefined || b.note === null) ? '' : String(b.note),
      next: hasNext ? next : null,
      done: !hasNext || isEnd
    };
  }

  /**
   * 求值一个场景检定步骤的执行计划（契约 §4.3）：只决定「该谁掷、掷什么」，不掷骰。
   * @returns {{targetSeat, skill, difficulty, bonus, penalty, branches:{success, failure}}}
   */
  function sceneStepPlan(step) {
    step = step || {};
    return {
      id: (step.id === undefined || step.id === null) ? null : step.id,
      title: step.title || '',
      desc: step.desc || '',
      targetSeat: (step.targetSeat === undefined || step.targetSeat === null) ? null : step.targetSeat,
      skill: step.skill || '',
      difficulty: normDifficulty(step.difficulty),
      bonus: Math.max(0, num(step.bonus)),
      penalty: Math.max(0, num(step.penalty)),
      branches: { success: normBranch(step.onSuccess), failure: normBranch(step.onFailure) }
    };
  }

  /** 把 check() 的成功等级（数字）或字符串键归一成 LEVEL 数字。 */
  function toLevelNumber(level) {
    if (typeof level === 'number') return level;
    if (level === undefined || level === null) return LEVEL.FAIL;
    var k = String(level).trim().toUpperCase();
    if (Object.prototype.hasOwnProperty.call(LEVEL, k)) return LEVEL[k];
    var lower = String(level).trim().toLowerCase();
    for (var key in LEVEL_KEY) {
      if (LEVEL_KEY[key] === lower) return parseInt(key, 10);
    }
    return LEVEL.FAIL;
  }

  /**
   * 按成功等级挑分支并给出后续动作（契约 §4.3）。
   * @param step  步骤定义
   * @param level check() 的成功等级（数字，见 LEVEL；也接受 'hard' 之类字符串键）
   * @returns {{damage, note, next, done, ...}}
   */
  function sceneStepResolve(step, level) {
    var plan = sceneStepPlan(step);
    var required = DIFFICULTY[plan.difficulty].required;
    var lvl = toLevelNumber(level);
    var success = lvl >= required;
    var branch = success ? plan.branches.success : plan.branches.failure;
    return {
      stepId: plan.id,
      level: lvl,
      required: required,
      success: success,
      branch: success ? 'success' : 'failure',
      /* v2.3.0（用户第 7 项）：显式识别大成功 / 大失败（level 5 / -1），供界面标注与 KP 裁定。 */
      critical: lvl === LEVEL.CRITICAL,
      fumble: lvl === LEVEL.FUMBLE,
      levelText: LEVEL_TEXT[String(lvl)] || '',
      damage: branch.damage,
      note: branch.note,
      next: branch.next,
      done: branch.done
    };
  }

  /* ============================================================
   * 14. 连发与武器故障（v2.3.0 · 用户第 8 / 10 项）
   * ============================================================ */

  /**
   * 单次攻击最多发射数（连发上限）解析。规则（需求 §8）：
   *   · `1(3)` / `1(2)`（括号内是连发数）→ 括号里的数
   *   · `1 or 2` / `1或2` → or 后面的数（2）
   *   · `N连射`（如 `1or3连射`）→ N
   *   · 含「全自动」→ 视为 ≥3
   *   · `1/4` / `1/2`（每 N 轮 1 发）→ 1（不算连发）
   *   · 单个纯数字（`1` / `2`）→ 该数字
   *   · 其它（`N/A` / `一次使用` / `布置` / 空）→ 1
   *  恒 ≥ 1。
   */
  function burstMaxOf(perRound) {
    var s = String(perRound === undefined || perRound === null ? '' : perRound).trim();
    if (!s) return 1;
    var max = 1;
    var paren = s.match(/[（(]\s*(\d+)\s*[)）]/);      // 1(3) → 3
    if (paren) max = Math.max(max, parseInt(paren[1], 10));
    var burst = s.match(/(\d+)\s*连射/);               // 3连射 → 3
    if (burst) max = Math.max(max, parseInt(burst[1], 10));
    var orN = s.match(/(?:or|或)\s*(\d+)/);            // 1 or 2 → 2
    if (orN) max = Math.max(max, parseInt(orN[1], 10));
    if (/全自动/.test(s)) max = Math.max(max, 3);      // 全自动 → ≥3
    if (/^\d+$/.test(s)) max = Math.max(max, parseInt(s, 10));   // 纯数字（1 / 2）
    if (!isFinite(max) || max < 1) max = 1;
    return max;
  }

  /** 该武器是否「连发类」（每轮可发射数 > 1）。 */
  function isBurstWeapon(perRound) { return burstMaxOf(perRound) > 1; }

  /** 有效故障阈值（1-100）。空 / `——` / 非法 → 0（表示**永不故障**）。 */
  function malfunctionThresholdOf(weapon) {
    var raw = weapon && weapon.malfunction;
    var s = String(raw === undefined || raw === null ? '' : raw).trim();
    if (!s) return 0;
    if (/^[-—–~～\s]+$/.test(s)) return 0;             // '——' 等破折号 → 无故障
    if (!/^\d+$/.test(s)) return 0;                    // 'N/A' / '一次性' 等非法 → 永不故障
    var n = parseInt(s, 10);
    if (!(n >= 1 && n <= 100)) return 0;
    return n;
  }

  /**
   * 武器故障判定（纯函数）。
   *   规则：大成功不故障；`malfunction` 空 / `——` / 非法 → 永不故障；
   *   否则「本次攻击掷值 ≥ 阈值」即故障。
   * @returns {{jammed:boolean, threshold:number}}
   */
  function malfunctionOf(weapon, rollValue, opts) {
    opts = opts || {};
    var th = malfunctionThresholdOf(weapon);
    if (!th) return { jammed: false, threshold: 0 };
    if (opts.critical) return { jammed: false, threshold: th };   // 大成功不故障
    var v = num(rollValue);
    return { jammed: v >= th, threshold: th };
  }

  /* 四种常见故障（KP 可在弹层指定，缺省按武器类型自动选）。 */
  var JAM_TYPES = { jam: 1, feed: 1, dud: 1, burst: 1 };

  /** 该武器是否左轮 / 转轮（哑火时「浪费 1 回合重新扣扳机」）。 */
  function isRevolver(weapon) {
    var s = String((weapon && weapon.name) || '');
    return /左轮|转轮|revolver/i.test(s);
  }

  /**
   * 缺省故障类型（按武器类型自动选一种最常见故障）：
   *   · 左轮 / 转轮 → 哑火（重新扣扳机）
   *   · 连发 / 全自动 → 供弹故障（手动退弹）
   *   · 其它 → 卡弹
   */
  function defaultMalfunctionType(weapon) {
    if (isRevolver(weapon)) return 'dud';
    if (isBurstWeapon(weapon && weapon.perRound)) return 'feed';
    return 'jam';
  }

  /** 炸膛自伤（1D3−1，最低 0）。单独函数便于复用与测试。 */
  function burstSelfDamage(rng) {
    var r = rollExpr('1D3-1', rng);
    return (r && r.ok) ? Math.max(0, r.total) : 0;
  }

  /**
   * 故障效果结算（纯函数，骰子走注入的 rng）。
   *   · 卡弹（jam）：需 **1D6** 轮清除；
   *   · 供弹故障（feed）：需 **1D4+2** 轮；
   *   · 哑火（dud）：左轮需 1 回合重新扣扳机；自动武器按手动退弹（1 回合）；
   *   · 炸膛（burst）：射手受 **1D3−1** 伤害且武器彻底损坏。
   * @returns {{type,label,clearRounds,damage,destroyed,clearText,summary}}
   */
  function malfunctionEffect(weapon, type, rng) {
    var t = JAM_TYPES[type] ? type : defaultMalfunctionType(weapon);
    if (t === 'dud') {
      var rev = isRevolver(weapon);
      return {
        type: 'dud', label: '哑火',
        clearRounds: 1, damage: 0, destroyed: false,
        clearText: rev ? '（需浪费 1 回合重新扣扳机）' : '（自动武器需手动退弹，约 1 回合）',
        summary: '哑火' + (rev ? '：浪费 1 回合重新扣扳机' : '：需手动退弹')
      };
    }
    if (t === 'burst') {
      var dmg = burstSelfDamage(rng);
      return {
        type: 'burst', label: '炸膛',
        clearRounds: 0, damage: dmg, destroyed: true,
        clearText: '（武器彻底损坏）',
        summary: '炸膛：武器彻底损坏，射手受 ' + dmg + ' 点伤害（1D3−1）'
      };
    }
    if (t === 'feed') {
      var f = rollExpr('1D4+2', rng);
      var fr = (f && f.ok) ? Math.max(0, f.total) : 3;
      return {
        type: 'feed', label: '供弹故障',
        clearRounds: fr, damage: 0, destroyed: false,
        clearText: '（需 ' + fr + ' 轮清除：1D4+2）',
        summary: '供弹故障：需 ' + fr + ' 轮清除'
      };
    }
    var j = rollExpr('1D6', rng);
    var jr = (j && j.ok) ? Math.max(0, j.total) : 1;
    return {
      type: 'jam', label: '卡弹',
      clearRounds: jr, damage: 0, destroyed: false,
      clearText: '（需 ' + jr + ' 轮清除：1D6）',
      summary: '卡弹：需 ' + jr + ' 轮清除'
    };
  }

  /* ============================================================
   * 对外 API
   * ============================================================ */
  global.CocRules = {
    version: 1,
    LEVEL: LEVEL, LEVEL_TEXT: LEVEL_TEXT, LEVEL_KEY: LEVEL_KEY, DIFFICULTY: DIFFICULTY,

    thresholds: thresholds, targetOf: targetOf, normDifficulty: normDifficulty,
    fumbleRange: fumbleRange, isFumble: isFumble, levelOf: levelOf,
    /* v2.3.0（用户第 7 项）：自定义大成功 / 大失败阈值 */
    critThresholdOf: critThresholdOf, fumbleThresholdOf: fumbleThresholdOf,

    rollD100: rollD100, combine: combine,
    check: check, describeCheck: describeCheck,

    canPush: canPush,
    luckAllowed: luckAllowed, spendLuck: spendLuck,

    opposed: opposed, opposedReroll: opposedReroll,
    /* v2.2.0（用户第 3 项）：攻击对抗模式敏感裁定 + 通用对抗（10 轮重掷兜底） */
    opposedAttack: opposedAttack, opposedFull: opposedFull,

    parseExpr: parseExpr, rollExpr: rollExpr, rollDamageBonus: rollDamageBonus,

    parseSanLoss: parseSanLoss, resolveSanCheck: resolveSanCheck, insanityFlags: insanityFlags,

    damageFlags: damageFlags, dyingRoundCheck: dyingRoundCheck,
    /* v2.1.5：临时疯狂 INT 检定 + 1D10 发作轮次（见 temporaryInsanityCheck） */
    temporaryInsanityCheck: temporaryInsanityCheck, boutRounds: boutRounds,

    initiativeOrder: initiativeOrder, advanceTurn: advanceTurn,

    /* ---- v2.0.0 新增（契约 §4）---- */
    resolveAttack: resolveAttack,
    skillValue: skillValue, attrValue: attrValue,
    sceneStepPlan: sceneStepPlan, sceneStepResolve: sceneStepResolve,
    maxOfExpr: maxOfExpr, OUTCOME: OUTCOME,

    /* ---- v2.3.0（用户第 8 / 9 / 10 项）：连发 / 贯穿 / 武器故障 ---- */
    maxOfDamageBonus: maxOfDamageBonus, impaleDamage: impaleDamage,
    burstMaxOf: burstMaxOf, isBurstWeapon: isBurstWeapon,
    malfunctionThresholdOf: malfunctionThresholdOf, malfunctionOf: malfunctionOf,
    defaultMalfunctionType: defaultMalfunctionType, malfunctionEffect: malfunctionEffect,
    JAM_TYPES: JAM_TYPES,

    /* 上限常量暴露出来，测试与界面提示要引用同一份数字 */
    limits: { MAX_DICE: MAX_DICE, MAX_SIDES: MAX_SIDES }
  };
})(typeof window !== 'undefined' ? window : this);
