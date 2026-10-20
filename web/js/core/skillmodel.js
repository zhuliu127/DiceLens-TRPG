/* ============================================================
 * skillmodel.js — 角色技能实例模型
 *   负责：技能列表构建、基础值动态计算、加点、校验、分类统计
 *   所有 COC 规则数值来自 COC7 / CocOccupation，此处不硬编码公式
 * ============================================================ */
(function (global) {
  'use strict';

  var R = global.COC7;
  var DB = global.COC_SKILLS;
  var OCC = global.CocOccupation;

  function keyOf(id, sub) { return sub ? id + '::' + sub : id; }

  /**
   * 动态基础值：母语 = EDU，闪避 = DEX/2，其余取数据库基础值。
   * 注意取的是「年龄调整后的生效属性」——60 岁的人力量和敏捷被扣了，
   * 闪避基础值自然要跟着降，否则年龄调整就等于没生效。
   */
  function baseValue(character, id, sub) {
    var a = R.effectiveAttrs(character);
    var def = OCC.skillById(id);
    if (def && def.dyn === 'edu') return parseInt(a.edu, 10) || 0;
    if (def && def.dyn === 'dex2') return Math.floor((parseInt(a.dex, 10) || 0) / 2);
    // 兜底（防止数据未标注 dyn）
    if (id === 'language_own') return parseInt(a.edu, 10) || 0;
    if (id === 'dodge') return Math.floor((parseInt(a.dex, 10) || 0) / 2);
    if (def && def.special && sub) {
      for (var i = 0; i < def.subskills.length; i++) {
        if (def.subskills[i].name === sub) return def.subskills[i].base;
      }
    }
    return def ? def.base : 0;
  }

  function displayName(id, sub) {
    var def = OCC.skillById(id);
    var nm = def ? def.name : id;
    return sub ? nm + '（' + sub + '）' : nm;
  }

  function categoryOf(id) {
    var def = OCC.skillById(id);
    return def ? def.category : '自定义';
  }

  /** 生成一个技能实例 */
  function makeSkill(character, id, sub, custom) {
    var inst = {
      key: keyOf(id, sub),
      id: id,
      name: displayName(id, sub),
      sub: sub || '',
      base: baseValue(character, id, sub),
      growth: 0,
      occ: 0,
      int: 0,
      total: 0,
      custom: !!custom,
      desc: ''
    };
    if (custom) {
      inst.name = custom.name || '自定义技能';
      inst.base = parseInt(custom.base, 10) || 0;
      inst.desc = custom.desc || '';
      inst.key = 'custom::' + (custom.name || Math.random().toString(36).slice(2, 8));
      inst.id = 'custom';
    }
    recompute(inst);
    return inst;
  }

  function recompute(s) {
    s.total = (s.base || 0) + (s.growth || 0) + (s.occ || 0) + (s.int || 0);
    return s.total;
  }

  /** 需要出现在列表中的技能：数据库全量基础技能（组技能展开为可选） */
  function defaultSkillList() {
    var out = [];
    DB.forEach(function (d) {
      if (d.special) return; // 组技能由子类承担
      out.push({ id: d.id, sub: '' });
    });
    return out;
  }

  /**
   * 同步技能列表：保证数据库基础技能存在，且不丢用户已有数据与自定义技能
   */
  function syncSkills(character) {
    var existing = {};
    (character.skills || []).forEach(function (s) { existing[s.key] = s; });

    var list = [];
    var seen = {};

    // 1) 数据库基础技能（非组）+ 已被使用/通用的组子类
    DB.forEach(function (d) {
      if (!d.special) {
        var k = keyOf(d.id, '');
        var s = existing[k] || makeSkill(character, d.id, '');
        s.base = baseValue(character, d.id, '');
        s.name = displayName(d.id, '');
        recompute(s);
        list.push(s); seen[k] = true;
      } else {
        // 组技能（格斗/射击/科学/技艺…）：
        //   flat 组的所有专攻默认就进列表，保证「斗殴」「射击（手枪）」等不会看不见；
        //   非 flat 组仅在已有实例时保留。
        d.subskills.forEach(function (sub) {
          var k2 = keyOf(d.id, sub.name);
          if (!existing[k2] && !d.flat) return;
          var s2 = existing[k2] || makeSkill(character, d.id, sub.name);
          s2.base = baseValue(character, d.id, sub.name);
          s2.name = displayName(d.id, sub.name);
          recompute(s2);
          list.push(s2); seen[k2] = true;
        });
      }
    });

    // 2) 用户自定义技能
    (character.skills || []).forEach(function (s) {
      if (seen[s.key]) return;
      if (s.custom || s.id === 'custom') { s.base = s.base || 0; recompute(s); list.push(s); seen[s.key] = true; }
      else if (s.id) { var ns = makeSkill(character, s.id, s.sub); ns.occ = s.occ || 0; ns.int = s.int || 0; ns.growth = s.growth || 0; recompute(ns); list.push(ns); seen[ns.key] = true; }
    });

    character.skills = list;
    return list;
  }

  /** 新增组技能子类（如 技艺（摄影）、射击（手枪）） */
  function addSubSkill(character, groupId, subName) {
    var s = character.skills.filter(function (x) { return x.key === keyOf(groupId, subName); })[0];
    if (s) return s;
    s = makeSkill(character, groupId, subName);
    character.skills.push(s);
    return s;
  }

  function addCustomSkill(character, def) {
    var s = makeSkill(character, 'custom', '', def);
    character.skills.push(s);
    return s;
  }

  function removeSkill(character, key) {
    character.skills = character.skills.filter(function (s) { return s.key !== key; });
  }

  function find(character, key) {
    return character.skills.filter(function (s) { return s.key === key; })[0] || null;
  }

  /** 某技能是否属于本职（职业开放）技能 */
  function isOccupational(character, skill) {
    var set = OCC.occupationalSet(character);
    if (set[skill.key] || set[skill.id]) return true;
    // 自由选择的职业技能（用户已指定）
    return false;
  }

  /**
   * 该技能的最终值上限：本职技能走「本职技能上限」，非本职走「兴趣技能上限」。
   * 判定依据与界面一致 —— 用 occupationalSet 判断是否本职。
   */
  function capOf(character, skill) {
    var set = OCC.occupationalSet(character);
    return R.skillCapOf(character, skill, set);
  }

  /** 该技能是否属于本职（职业开放）技能 */
  function isOccSkill(character, skill) {
    var set = OCC.occupationalSet(character);
    return !!(set[skill.key] || set[skill.id]);
  }

  /**
   * 加点约束
   *   1) 不能为负
   *   2) 最终值不得超过该技能对应的上限（本职 / 兴趣 两类）
   *   3) 职业点 / 兴趣点各自不能透支
   *   4) 克苏鲁神话等「只能靠成长」的技能，职业点与兴趣点都不给加
   */
  function canAdd(character, skill, field, delta) {
    var cap = capOf(character, skill);
    var cur = skill[field] || 0;
    var next = cur + delta;
    if (next < 0) return { ok: false, reason: '该项不能为负数' };
    if (delta > 0 && R.isGrowthOnly(skill.id) && field !== 'growth') {
      return { ok: false, reason: '「' + skill.name + '」车卡时不能加点',
               detail: '只能通过「成长」栏增加（遭遇神话事件后）' };
    }
    if (delta > 0 && skill.total + delta > cap) {
      var kind = isOccSkill(character, skill) ? '本职' : '兴趣';
      return { ok: false, reason: '技能「' + skill.name + '」最多到 ' + cap + '%（' + kind + '技能上限）',
               detail: '当前 ' + skill.total + '，加 ' + delta + ' 会超出上限' };
    }
    if (delta > 0) {
      if (field === 'occ') {
        var p = OCC.occupationPoints(character);
        if (p.used + delta > p.total) {
          return { ok: false, reason: '职业技能点不足',
                   detail: '剩余 ' + (p.total - p.used) + ' 点，需要 ' + delta + ' 点' };
        }
      }
      if (field === 'int') {
        var it = OCC.interestPoints(character);
        if (it.used + delta > it.total) {
          return { ok: false, reason: '兴趣技能点不足',
                   detail: '剩余 ' + (it.total - it.used) + ' 点，需要 ' + delta + ' 点' };
        }
      }
    }
    return { ok: true };
  }

  function applyPoint(character, skill, field, delta) {
    var chk = canAdd(character, skill, field, delta);
    if (!chk.ok) return chk;
    skill[field] = Math.max(0, (skill[field] || 0) + delta);
    recompute(skill);
    return { ok: true };
  }

  /** 职业点是否可以加到该技能：组技能需已选定子类 */
  function canUseOcc(skill) {
    if (skill.custom) return false;
    return true; // 具体限制由 UI 依据 occupationalSet 提示
  }

  /** 汇总统计：分别统计超出本职上限与超出兴趣上限的技能 */
  function stats(character) {
    var occ = OCC.occupationPoints(character);
    var it = OCC.interestPoints(character);
    var occCap = num(character.skillCapOcc) || num(character.skillCap) || R.defaultOccSkillCap;
    var intCap = num(character.skillCapInterest) || num(character.skillCap) || R.defaultInterestSkillCap;
    var over = (character.skills || []).filter(function (s) {
      return s.total > capOf(character, s);
    });
    return {
      occ: occ, interest: it, overCap: over,
      cap: occCap,
      occCap: occCap, interestCap: intCap,
      // 兼容旧字段：单一的 cap 现在等同本职上限
      caps: { occ: occCap, interest: intCap }
    };
  }

  function num(v) { var n = parseInt(v, 10); return isNaN(n) ? 0 : n; }

  global.SkillModel = {
    keyOf: keyOf,
    baseValue: baseValue,
    displayName: displayName,
    categoryOf: categoryOf,
    makeSkill: makeSkill,
    recompute: recompute,
    syncSkills: syncSkills,
    addSubSkill: addSubSkill,
    addCustomSkill: addCustomSkill,
    removeSkill: removeSkill,
    find: find,
    isOccupational: isOccupational,
    isOccSkill: isOccSkill,
    capOf: capOf,
    canAdd: canAdd,
    applyPoint: applyPoint,
    stats: stats
  };
})(window);
