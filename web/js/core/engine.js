/* ============================================================
 * engine.js — 角色数据重算调度
 *   任何原始数据变化后调用 recalc()，保证派生数据始终一致
 * ============================================================ */
(function (global) {
  'use strict';

  var R = global.COC7;
  var SM = global.SkillModel;

  /* 缓存指纹用的「规则版本」。开发期规则一改就 +1，
     改了 ageAdjust 的算法却忘了清缓存时，这个数字会兜住。 */
  var COC7_RULE_SIG = 4;   // 4: 原始 EDU 变化时作废旧的教育进步检定

  function recalc(character) {
    var a = character.attributes || {};

    // 同步基本信息顶层字段
    character.age = character.basicInfo.age;

    /* ---------- 教育进步检定的基准守卫 ----------
     * 检定的前提是「掷数 ≤ 当时的 EDU」。原始教育一旦变了，
     * 之前那几次检定的判定条件就不成立了，旧的增益必须作废 ——
     * 否则 eduBonus 会继续加在**新**教育上，生效教育被旧增益抬着，
     * 表现为「改了教育还是套用之前的检定结果」。
     *
     * ⚠️ 这段必须放在 recalc 里（数据层），不能只放在界面层：
     * 改属性的路径太多（手动输入 / 随机接受 / 天命选定 / 预设方案 /
     * 外部直接赋值），界面上逐个补总会漏 —— 之前两版就是漏在
     * 「随机接受」和「天命选定」这两条不走 commit() 的路径上。
     * recalc 是所有变更的唯一必经之地，守在这里就一次都不会漏。 */
    dropStaleEduChecks(character);

    // 0) 年龄调整：算出「生效属性」，后续派生属性 / 技能基础值 / 界面全部用它。
    //    原始属性保持玩家输入值不变（购点校验、掷骰结果都依赖它）。
    //    教育进步检定的增益（eduBonus）也只落在生效值上。
    var adj = R.ageAdjust({
      str: a.str, con: a.con, siz: a.siz, dex: a.dex,
      app: a.app, int: a.int, pow: a.pow, edu: a.edu, luck: a.luck,
      age: character.basicInfo.age,
      eduBonus: R.eduBonusOf(character)
    });
    character.ageAdj = adj;
    character.effAttributes = adj.eff;
    /* 同步缓存指纹：否则 effAttrs/ageAdjustOf 会因为「指纹对不上」
       而重新算一遍（结果一样，只是白费一次），更重要的是保证
       之后任何一侧改数据都能被正确判定为失效。 */
    var sig = attrSig(character);
    character._effSig = sig;
    character._adjSig = sig;

    // 1) 派生属性（内部同样按调整后的属性计算）
    var d = R.derived({
      str: a.str, con: a.con, siz: a.siz, dex: a.dex,
      app: a.app, int: a.int, pow: a.pow, edu: a.edu,
      age: character.basicInfo.age
    });
    character.derivedStats = d;

    // 2) 技能基础值随属性变化（母语=EDU，闪避=DEX/2）
    (character.skills || []).forEach(function (s) {
      if (s.custom) return;
      var nb = SM.baseValue(character, s.id, s.sub);
      if (s.base !== nb) { s.base = nb; SM.recompute(s); }
    });

    // 3) 理智上限 = 意志（POW，取自生效属性）。
    //    另外单独记下「99 − 克苏鲁神话」的硬性削减值：它只作为提示信息，
    //    不再用来夹当前理智 —— 当前理智允许暂时高于上限。
    var cth = (character.skills || []).filter(function (s) { return s.id === 'cthulhu'; })[0];
    var cthVal = cth ? cth.total : 0;
    var mSan = R.maxSan(cthVal);
    character.sanMythosCap = mSan;

    // 4) 状态值：属性齐备后才做首次初始化；之前不锁定，避免把空属性当基准
    var st = character.status;

    /* 理智上限 = 意志（POW）− 累计的永久减损。
       施放神话法术、与克苏鲁神话生物接触都可能让调查员「永久失去一部分 SAN 上限」
       （规则书里是 -1D5 / -1D10）。这个减损必须与「当前 SAN」分开存：
         baseMaxSAN —— 未减损时的上限（跟着意志走）
         sanLoss    —— 累计减损，玩家在状态管理里手动加/减
       maxSAN 只是这两者的差，是**展示用**的派生值。 */
    if (character.baseMaxSAN === null || character.baseMaxSAN === undefined) {
      character.baseMaxSAN = d.maxSAN;
    }
    if (!character.sanLoss) character.sanLoss = 0;
    var sanLoss = clamp(character.sanLoss, 0, 99);
    character.sanLoss = sanLoss;
    var effMaxSAN = Math.max(0, d.maxSAN - sanLoss);

    st.maxHP = d.maxHP; st.maxMP = d.maxMP;
    st.maxSAN = effMaxSAN;              // 生效上限 = 意志 − 永久减损
    st.baseMaxSAN = d.maxSAN;           // 减损前的上限，界面上要一起显示
    st.sanLoss = sanLoss;

    var ready = d.maxHP > 0 && d.maxMP > 0;
    if (ready && !st._inited) {
      // 首次有效初始化：HP/MP 取满值，SAN 初始值 = POW（规则书：意志=初始理智）
      st.currentHP = d.maxHP;
      st.currentMP = d.maxMP;
      st.currentSAN = d.san;
      st.currentLuck = parseInt(a.luck, 10) || 0;
      st._inited = true;
    } else if (!ready) {
      // 属性尚未填好，仅清空占位，不标记已初始化
      st.currentHP = st.currentHP || 0;
      st.currentMP = st.currentMP || 0;
      st.currentSAN = st.currentSAN || 0;
    } else {
      st.currentHP = clamp(st.currentHP, 0, d.maxHP);
      st.currentMP = clamp(st.currentMP, 0, d.maxMP);
      /* v2.1.5（用户第 1 项）：当前理智**不得超过上限**（意志 − 永久减损）。
         旧实现只夹 0-99（允许突破上限），于是出现「SAN 60/59」这类当前值高于
         上限的矛盾显示。上限归零时当前 SAN 也随之归零。 */
      st.currentSAN = clamp(st.currentSAN, 0, effMaxSAN);
      st.currentLuck = clamp(st.currentLuck, 0, 99);
    }

    // 幸运：只要玩家没有在状态栏手动改过，就跟随幸运属性
    if (!st._luckTouched) {
      st.currentLuck = clamp(parseInt(a.luck, 10) || 0, 0, 99);
    }
    // 属性后填的情况：补一次初始化（未手动改动过才补）
    if (ready && st.currentHP === 0 && !st._hpTouched) st.currentHP = d.maxHP;
    if (ready && st.currentMP === 0 && !st._mpTouched) st.currentMP = d.maxMP;
    if (ready && st.currentSAN === 0 && !st._sanTouched) st.currentSAN = d.san;

    return character;
  }

  function clamp(v, lo, hi) {
    v = parseInt(v, 10);
    if (isNaN(v)) v = lo;
    return Math.max(lo, Math.min(hi, v));
  }

  /** 所有属性是否已填写 */
  function attrsReady(character) {
    var a = character.attributes || {};
    return ['str', 'con', 'siz', 'dex', 'app', 'int', 'pow', 'edu'].every(function (k) {
      var v = parseInt(a[k], 10);
      return !isNaN(v) && v > 0;
    });
  }

  /**
   * 取角色当前「生效属性」（已含年龄调整）。
   *
   * ⚠️ 缓存必须带「失效标记」而不是无条件短路。
   * 早先写成 `if (character.effAttributes) return character.effAttributes;`，
   * 只要算过一次就永远返回旧值 —— 于是：
   *   · 改了原始属性但没跑 recalc 时，界面显示的还是上一轮的数字
   *   · 清掉 eduProgress.bonus（教育进步检定作废）之后，
   *     Engine.effAttrs() 仍然返回带旧增益的结果，
   *     表现为「改了教育还是套用之前的检定结果」。
   * 现在改成：只要检测到「缓存是旧输入算出来的」就重算。
   * 输入很便宜（一次 ageAdjust），换来的是永远拿最新值，不会再有幽灵缓存。
   */
  function effAttrs(character) {
    var sig = attrSig(character);
    if (character._effSig !== undefined && character._effSig === sig && character.effAttributes) {
      return character.effAttributes;
    }
    var a = Object.assign({}, character.attributes || {});
    a.age = (character.basicInfo || {}).age;
    a.eduBonus = R.eduBonusOf(character);
    var eff = R.ageAdjust(a).eff;
    character._effSig = sig;
    return eff;
  }

  /** 缓存指纹：原始属性 + 年龄 + 教育增益 + 规则版本 */
  function attrSig(character) {
    var at = character.attributes || {};
    var bi = character.basicInfo || {};
    return [at.str, at.con, at.siz, at.dex, at.app, at.int, at.pow, at.edu, at.luck,
            bi.age, R.eduBonusOf(character), COC7_RULE_SIG].join('|');
  }

  /**
   * 原始 EDU 变了就把旧的教育进步检定**彻底作废**。
   * 由 recalc 调用，所以无论从哪条路径改属性都会走到这里。
   * @returns {boolean} 是否真的作废过（界面据此显示一次提示）
   */
  function dropStaleEduChecks(character) {
    var p = character.eduProgress;
    if (!p || !Array.isArray(p.log) || !p.log.length) return false;
    var rawEdu = parseInt((character.attributes || {}).edu, 10) || 0;

    /* 从来没有基准记录（老存档 / 外部构造的数据）：
       这不是「教育值变了导致检定过期」，而是「没记基准」。
       此时只补记基准、保留检定结果 —— 否则会误清掉合法的历史数据。
       判据是「log 里第一条记录的 before 就是当前 EDU」，说明它本来就是按这个值掷的。 */
    if (p.baseEdu === undefined || p.baseEdu === null) {
      var firstBefore = parseInt((p.log[0] || {}).before, 10);
      if (!isNaN(firstBefore) && firstBefore === rawEdu) {
        p.baseEdu = rawEdu;      // 补记基准，不作废
        return false;
      }
      /* 兜底：基准与首条记录都对不上 → 确实无法判定，按过期处理 */
    } else if (p.baseEdu === rawEdu) {
      return false;
    }

    p.log = [];
    p.bonus = 0;
    p.done = 0;
    p.staleFromEdu = (p.baseEdu === undefined || p.baseEdu === null) ? null : p.baseEdu;
    p.baseEdu = rawEdu;
    p.resetAt = Date.now();   // 供界面显示一次「检定已清空」的说明
    return true;
  }

  /** 取年龄调整摘要（同样带指纹校验） */
  function ageAdjustOf(character) {
    var sig = attrSig(character);
    if (character._adjSig !== undefined && character._adjSig === sig && character.ageAdj) {
      return character.ageAdj;
    }
    var a = Object.assign({}, character.attributes || {});
    a.age = (character.basicInfo || {}).age;
    a.eduBonus = R.eduBonusOf(character);
    var adj = R.ageAdjust(a);
    character._adjSig = sig;
    return adj;
  }

  /** 属性原始值之和（9 项）；includeLuck=false 时不计幸运 */
  function attrSum(character, includeLuck) {
    var a = character.attributes || {};
    var keys = ['str', 'con', 'siz', 'dex', 'app', 'int', 'pow', 'edu'];
    if (includeLuck !== false) keys.push('luck');
    return keys.reduce(function (t, k) { return t + (parseInt(a[k], 10) || 0); }, 0);
  }

  /** 属性生效值之和（9 项，含年龄调整）；includeLuck=false 时不计幸运 */
  function attrSumEff(character, includeLuck) {
    var e = effAttrs(character);
    var keys = ['str', 'con', 'siz', 'dex', 'app', 'int', 'pow', 'edu'];
    if (includeLuck !== false) keys.push('luck');
    return keys.reduce(function (t, k) { return t + (parseInt(e[k], 10) || 0); }, 0);
  }

  /** 统一校验：返回问题列表 */
  function validate(character) {
    var R2 = R, OCC = global.CocOccupation;
    var errs = [];
    errs = errs.concat(R.validators.basicInfo(character));
    errs = errs.concat(R.validators.occupationSelected(character));
    if (attrsReady(character)) {
      errs = errs.concat(R.validators.attributes(character));
      errs = errs.concat(R.validators.occupationChoices(character, OCC));
      errs = errs.concat(R.validators.skillPoints(character, OCC));
      errs = errs.concat(R.validators.skillCap(character));
      errs = errs.concat(R.validators.creditRating(character, OCC));
    }
    return errs;
  }

  /** 校验项清单（含通过项，用于"完成角色卡"检查页） */
  function checkList(character) {
    var OCC = global.CocOccupation;
    var out = [];
    function add(label, errs, step) {
      out.push({ label: label, ok: errs.length === 0, step: step, detail: errs.length ? errs[0].text : '', errors: errs });
    }
    add('角色姓名已填写', R.validators.basicInfo(character).filter(function (e) { return e.target === 'characterName'; }), 0);
    add('玩家名称已填写', R.validators.basicInfo(character).filter(function (e) { return e.target === 'playerName'; }), 0);
    add('年龄合法', R.validators.basicInfo(character).filter(function (e) { return e.target === 'age'; }), 0);
    add('属性合法（15-90 且为 5 的倍数）', R.validators.attributes(character), 1);
    add('已选择职业', R.validators.occupationSelected(character), 2);
    add('职业限定技能选择完成', R.validators.occupationChoices(character, OCC), 2);
    add('信用评级在职业范围内', R.validators.creditRating(character, OCC), 3);
    add('职业技能点未超额', R.validators.skillPoints(character, OCC).filter(function (e) { return e.target === 'occPoints'; }), 4);
    add('兴趣技能点未超额', R.validators.skillPoints(character, OCC).filter(function (e) { return e.target === 'interestPoints'; }), 4);
    add('技能未超过上限', R.validators.skillCap(character), 4);
    return out;
  }

  global.Engine = {
    recalc: recalc, attrsReady: attrsReady, validate: validate, checkList: checkList, clamp: clamp,
    effAttrs: effAttrs, ageAdjustOf: ageAdjustOf, attrSum: attrSum, attrSumEff: attrSumEff,
    /* 界面层用的同一个守卫（数据层在 recalc 里，这里暴露出来便于界面按需触发） */
    dropStaleEduChecks: dropStaleEduChecks
  };
})(window);
