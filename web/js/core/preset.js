/* ============================================================
 * preset.js — 随机预设角色卡生成器
 *
 * 用途：向导第 0 步「快速开始」一次生成若干张**完整可用**的角色卡，
 *       玩家挑一张就能直接开团，不必走完整个车卡流程。
 *       也被「AI 车卡」复用：AI 只负责创意部分（是谁、想要什么职业、
 *       长什么样、有什么故事），数值部分仍由这里生成，卡才是合规的。
 *
 * 「完整」的定义：这张卡在规则上是通的 ——
 *   属性 9 项齐备（含幸运）、年龄调整与教育进步检定已掷、
 *   职业 + 本职技能选择已完成、职业点 / 兴趣点已分配完毕、
 *   信用评级在职业允许范围内且占用职业点、装备与背景全部填好。
 *   生成后会用 Engine.checkList 自检，有问题就重来。
 *
 * 世界设定（personas.js）决定「姓名 / 地点 / 时代 / 货币 / 装备口径 /
 * 职业口味」，保证一张卡内部文化自洽，同时把随机度铺开。
 * ============================================================ */
(function (global) {
  'use strict';

  var R = global.COC7;
  var OCC = global.CocOccupation;
  var SM = global.SkillModel;
  var Store = global.Store;
  var PER = global.CocPersonas;

  /* ---------- 背景心理症状（恐惧症 / 狂躁症 / 疯狂发作）出现概率 ----------
     v2.11.4（用户第 1 项）：随机角色卡**不再人手一条**疯狂症状。
       · 普通随机角色 + 名人彩蛋卡（eggKind='celeb'）→ 约 1/5 带一条；
       · 跑团成员彩蛋卡（eggKind='friend'）→ **一律不带**（用户明确要求：
         「所有跑团成员彩蛋卡都不要有疯狂症」）。
     改之前 backgroundText() 无条件返回一条症状 → 每张随机卡都带，
     用户实录「每个随机出来的角色都有疯狂症」。
     ⚠️ 只改**出现概率**，不动 backgroundText 内部：
        疯狂表「8/10 总结症状 + 各 1/10 恐惧 / 狂躁」是规则书口径，
        tools/ 下有真值表钉住，改它会让规则测试变红。 */
  var BG_MADNESS_RATE = 0.2;

  /* ---------- 随机小工具 ---------- */
  function rnd(n) { return Math.floor(Math.random() * n); }
  function pick(a) { return a[rnd(a.length)]; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function shuffle(a) { return PER.shuffle(a); }

  /* ---------- 同批去重游标 ----------
     一次生成 5 张卡时，把已经用过的文本项记下来，
     下一张优先挑没用过的 —— 这是「连着随机几张都长得差不多」的根治办法。 */
  function newCtx() { return { used: {} }; }

  function pickFrom(pool, ctx, key) {
    if (!pool || !pool.length) return null;
    if (!ctx) return pick(pool);
    var u = ctx.used[key] || (ctx.used[key] = {});
    var avail = [];
    for (var i = 0; i < pool.length; i++) if (!u[i]) avail.push(i);
    if (!avail.length) { u = ctx.used[key] = {}; avail = []; for (var j = 0; j < pool.length; j++) avail.push(j); }
    var idx = avail[rnd(avail.length)];
    u[idx] = true;
    return pool[idx];
  }

  /* ---------- 属性 ---------- */
  function rollAttributes() { return R.generators.random(); }

  /** 属性是否「能用」：不太极端，总和不至于算不出职业点 */
  function attrsUsable(a) {
    var keys = ['str', 'con', 'siz', 'dex', 'app', 'int', 'pow', 'edu'], sum = 0, i;
    for (i = 0; i < keys.length; i++) {
      var v = parseInt(a[keys[i]], 10) || 0;
      if (v < 25 || v > 90) return false;
      sum += v;
    }
    if (sum < 380 || sum > 640) return false;
    return true;
  }

  /** AI 给的属性：只要每项在合理区间、合计不离谱就收下（配合属性上限设置） */
  function attrsFromAI(a) {
    var keys = ['str', 'con', 'siz', 'dex', 'app', 'int', 'pow', 'edu', 'luck'], sum = 0, i;
    if (!(a && typeof a === 'object')) return false;
    for (i = 0; i < 8; i++) {
      var v = parseInt(a[keys[i]], 10) || 0;
      if (v < 15 || v > 99) return false;
      sum += v;
    }
    var lk = parseInt(a.luck, 10);
    if (isNaN(lk)) return false;
    return sum >= 200 && sum <= 720;
  }

  /* ============================================================
   * 房规数值上限（在「菜单 → 🤖 AI 设置 → 数值上限」里配）
   *
   * 三个变量存在 Store.settings：
   *   aiAttrCap / aiAttrCapWithLuck —— 属性总和上限（含/不含幸运）
   *   aiOccPtsCap                   —— 每项**本职技能最终值**的上限
   *   aiIntPtsCap                   —— 每项**兴趣技能最终值**的上限
   *
   * ⚠️ 这三个是**变量**，必须每次生成时现读 —— 玩家改完设置再点「换一批」
   *    就该按新上限来。写成启动时读一次的常量，改完设置要重开应用才生效。
   * ⚠️ 它们对**所有**走 build() 的卡生效：第 0 步的随机卡、彩蛋卡、AI 卡。
   *    这正是玩家的要求 —— 房规里定了属性总和与技能上限，就该一视同仁，
   *    不能只约束 AI 卡（那样随机卡反而是「超标的漏洞」）。
   *
   * AIGen.caps() 是权威实现；读不到时（只加载 preset.js 的测试环境）
   * 按同一套规则自己算一遍，保证两边结果永远一致。
   * ============================================================ */
  function activeCaps(opts) {
    if (opts && opts.caps) return opts.caps;
    /* 兼容旧的 ptsCap 写法（只给技能上限、不给属性上限）——
       审计脚本与老调用点还在用它。 */
    if (opts && opts.ptsCap) {
      return {
        attrCap: 0, withLuck: true,
        occCap: parseInt(opts.ptsCap.occ, 10) || 0,
        intCap: parseInt(opts.ptsCap.int, 10) || 0
      };
    }
    if (global.AIGen && typeof global.AIGen.caps === 'function') return global.AIGen.caps();
    var s = (Store && Store.getState && (Store.getState() || {}).settings) || {};
    var out = { attrCap: 0, withLuck: true, occCap: 0, intCap: 0 };
    var a = parseInt(s.aiAttrCap, 10);
    if (a > 0) {
      out.attrCap = a;
      out.withLuck = s.aiAttrCapWithLuck !== false;
    }
    var o = parseInt(s.aiOccPtsCap, 10);
    if (o > 0) out.occCap = o;
    var i = parseInt(s.aiIntPtsCap, 10);
    if (i > 0) out.intCap = i;
    return out;
  }

  /**
   * 把「属性总和上限」压到角色上。
   *
   * ⚠️ 复用 AIGen.applyAttrCap（等比压缩 + 最大余数法补齐 + 相邻倒置修复），
   *    而不是自己写一套「从最高项往下扣」—— 后者会把
   *    「力量 90、教育 45」压成「力量 45」，人物性格直接被改掉。
   *    随机卡与 AI 卡共用同一个压缩函数，形态才真的一致。
   *
   * @returns {boolean} 是否真的压过（没超限就是 false，属性原样保留）
   */
  function applyAttrCapToCard(c, caps) {
    if (!caps || !caps.attrCap) return false;
    var fn = global.AIGen && global.AIGen.applyAttrCap;
    if (typeof fn !== 'function') return false;
    var holder = { attributes: c.attributes };
    var moved = fn(holder, caps);
    if (moved) c.attributes = holder.attributes;
    return !!moved;
  }

  /* ---------- 年龄 / 教育进步检定 ---------- */
  function randomAge() {
    var r = Math.random();
    if (r < 0.42) return 21 + rnd(9);        // 21-29
    if (r < 0.72) return 30 + rnd(10);       // 30-39
    if (r < 0.92) return 40 + rnd(10);       // 40-49
    return 50 + rnd(11);                     // 50-60
  }

  /**
   * 教育进步检定：年龄带来的 EDU 增益不是白送的 ——
   * 每次掷 1D100，结果大于当前 EDU 才 +1D10。
   */
  function runEduChecks(c) {
    var need = R.ageProgressChecks(parseInt(c.basicInfo.age, 10) || 0);
    c.eduProgress = { base: null, done: 0, log: [], bonus: 0 };
    for (var i = 0; i < need; i++) {
      Engine.recalc(c);
      var before = parseInt(Engine.effAttrs(c).edu, 10) || 0;
      var r = R.eduImproveCheck(before);
      c.eduProgress.log.push({
        n: i + 1, roll: r.roll, before: before, gain: r.gain,
        after: Math.min(99, before + r.gain)
      });
    }
    c.eduProgress.bonus = c.eduProgress.log.reduce(function (t, x) { return t + (x.gain || 0); }, 0);
    c.eduProgress.done = c.eduProgress.log.length;
    Engine.recalc(c);
  }

  /* ============================================================
   * 职业：按世界设定做加权抽样
   *   命中 occPrefer 关键词 → 权重 ×4
   *   命中 occAvoid  关键词 → 权重 ×0.03（几乎不会出现，但不至于抽空池子）
   *   不是硬性黑白名单，避免设定过窄时一个职业都挑不出来。
   * ============================================================ */
  function candidateOccupations() {
    return OCC.listAll().filter(function (o) {
      if (!o || o.id === 'occ1') return false;                       // 排除「自定义职业」
      if (o.creditMin === null || o.creditMin === undefined) return false;
      if (!o.attrFormula) return false;
      return true;
    });
  }

  function occWeight(o, setting) {
    var n = String(o.name || ''), w = 1, i;
    if (setting && setting.occPrefer) {
      for (i = 0; i < setting.occPrefer.length; i++) {
        if (n.indexOf(setting.occPrefer[i]) >= 0) { w *= 4; break; }
      }
    }
    if (setting && setting.occAvoid) {
      for (i = 0; i < setting.occAvoid.length; i++) {
        if (n.indexOf(setting.occAvoid[i]) >= 0) { w *= 0.03; break; }
      }
    }
    return w;
  }

  /** 个别职业把属性门槛写在名字里（「相扑力士(SIZ>80,STR>70)」） */
  function nameAttrRequirements(o) {
    var m = String(o.name || '').match(/[（(]([^）)]*)[）)]/);
    if (!m) return null;
    var out = [];
    m[1].split(/[,，、]/).forEach(function (part) {
      var t = part.match(/([A-Za-z\u4e00-\u9fa5]{2,5})\s*([<>]=?)\s*(\d+)/);
      if (!t) return;
      var key = R.attrByName ? R.attrByName(t[1]) : null;
      if (!key) return;
      out.push({ key: key, op: t[2], val: parseInt(t[3], 10) });
    });
    return out.length ? out : null;
  }

  function meetsNameReqs(o, attrs) {
    var reqs = nameAttrRequirements(o);
    if (!reqs) return true;
    return reqs.every(function (r) {
      var v = parseInt(attrs[r.key], 10) || 0;
      if (r.op === '>') return v > r.val;
      if (r.op === '>=') return v >= r.val;
      if (r.op === '<') return v < r.val;
      return v <= r.val;
    });
  }

  /**
   * 按设定口味挑一个职业。要求：
   *   · 满足职业名自带的属性门槛
   *   · 属性算出来的职业点在 minPts-400 之间
   *     （下限太低说明属性正好压在公式短板上；默认 120）
   *
   * @param {number} [minPts] 职业点下限。房规把属性总和压到上限时，
   *   职业点公式算出来的池子会同步变小，沿用 120 会把职业全筛掉 ——
   *   调用方按压缩幅度放宽这个下限传进来。
   */
  function pickOccupation(c, setting, forceId, minPts) {
    var floor = (parseInt(minPts, 10) > 0) ? parseInt(minPts, 10) : 120;
    var eff = Engine.effAttrs(c);
    var available = candidateOccupations().filter(function (o) { return meetsNameReqs(o, eff); });

    if (forceId) {
      for (var f = 0; f < available.length; f++) if (available[f].id === forceId) return available[f];
      // 名字对得上也算（AI 更可能给名字）
      for (var f2 = 0; f2 < available.length; f2++) {
        if (available[f2].name === forceId) return available[f2];
      }
    }

    var weighted = available.map(function (o) { return { o: o, w: occWeight(o, setting) }; });
    for (var attempt = 0; attempt < 40; attempt++) {
      var total = weighted.reduce(function (a, x) { return a + x.w; }, 0);
      if (total <= 0) break;
      var r = Math.random() * total, hit = weighted[weighted.length - 1].o;
      for (var i = 0; i < weighted.length; i++) {
        r -= weighted[i].w;
        if (r <= 0) { hit = weighted[i].o; break; }
      }
      var pts = OCC.evalFormula(hit.attrFormula, eff);
      if (pts >= floor && pts <= 400) return hit;
    }
    // 兜底：按权重取一个能满足点数条件的
    var sorted = shuffle(available);
    for (var k = 0; k < sorted.length; k++) {
      var p = OCC.evalFormula(sorted[k].attrFormula, eff);
      if (p >= floor && p <= 400) return sorted[k];
    }
    return available[0] || null;
  }

  /** 按名字找职业（AI 返回职业名时用） */
  function occupationByName(name) {
    if (!name) return null;
    var target = String(name).trim();
    var all = OCC.listAll();
    var i;
    for (i = 0; i < all.length; i++) if (all[i].name === target) return all[i];
    for (i = 0; i < all.length; i++) if (all[i].name.indexOf(target) >= 0) return all[i];
    for (i = 0; i < all.length; i++) if (target.indexOf(all[i].name) >= 0 && all[i].id !== 'occ1') return all[i];
    return null;
  }

  /* ---------- 本职技能选择（自动替玩家选完） ---------- */
  var FREE_POOL = [
    '侦查', '聆听', '图书馆使用', '心理学', '说服', '话术', '恐吓', '取悦', '乔装',
    '潜行', '闪避', '攀爬', '跳跃', '游泳', '汽车驾驶', '急救', '医学', '法律',
    '历史', '神秘学', '会计', '博物学', '领航', '追踪', '妙手', '锁匠',
    '机械维修', '电气维修', '计算机使用', '电子学', '摄影', '人类学', '考古学',
    '估价', '驯兽', '骑术', '读唇', '精神分析', '催眠', '潜水', '投掷'
  ];

  function skillLabel(skillId, sub) {
    var d = OCC.skillById(skillId);
    var nm = d ? d.name : skillId;
    return sub ? nm + '（' + sub + '）' : nm;
  }

  function byKey(c, key) {
    for (var i = 0; i < c.skills.length; i++) if (c.skills[i].key === key) return c.skills[i];
    return null;
  }

  /** 把职业描述里的「任选 N 项」全部替玩家选好（choice / free 两类） */
  /**
   * 自动替玩家把「本职技能」选完。
   *
   * opts.customSkills：AI 在自定义职业时给的技能名数组（最多 8 项）。
   *   只作**建议**用 —— 名字解析不出来就退回随机池，宁可随机也不能选空。
   *
   * ⚠️ 自由项统一上限 8 项：自定义职业的规则书原文就是「不多于 8 个本职技能」，
   * 而且 8 项已经接近点数分配的极限（再多每项就只剩十几二十点，等于都没练过）。
   */
  /**
   * 组技能挑一个专攻。
   * 优先职业原文里点名的（「手艺（烹饪）」→ 烹饪），否则随机 ——
   * 与 occupation.js 的 groupSubFor 保持同一套偏好，两边才不会选出不同的专攻。
   */
  function pickGroupSub(c, def) {
    var subs = (def && def.subskills) || [];
    if (!subs.length) return '';
    var occ = OCC.getById(c.occupationId);
    var text = String(((occ && occ.skillText) || '') + '　' + ((occ && occ.desc) || ''));
    var hint = subs.filter(function (s) { return s.name && text.indexOf(s.name) >= 0; });
    var pool = hint.length ? hint : subs;
    return pool[rnd(pool.length)].name;
  }

  /** 保证这个专攻在技能表里有一条实例（非 flat 组不会自动展开） */
  function ensureSub(c, skillId, sub) {
    if (!skillId || !sub) return;
    if (byKey(c, skillId + '::' + sub)) return;
    if (SM.addSubSkill) SM.addSubSkill(c, skillId, sub);
  }

  function fillOccupationPicks(c, ctx, opts) {
    opts = opts || {};
    var reqs = OCC.getRequirements(c);
    c.occupationPicks = {};
    var used = {};
    reqs.forEach(function (r) {
      if (r.type === 'fixed') {
        /* 组技能但职业没点名专攻（「格斗」「技艺」「射击」）：
           替玩家落到**一个**专攻上，并保证技能表里有这条实例。
           不落下去的话，它既不出现在本职列表里、也吃不到职业点。 */
        var d0 = r.skill ? OCC.skillById(r.skill) : null;
        if (d0 && d0.special && !r.sub) {
          var sub0 = pickGroupSub(c, d0);
          ensureSub(c, r.skill, sub0);
          used[r.skill + '::' + sub0] = true;
          c.occupationPicks[r.id] = [{ skill: r.skill, sub: sub0, name: d0.name + '（' + sub0 + '）' }];
        }
      } else if (r.type === 'choice') {
        var pool = shuffle(r.pool || []).filter(function (p) {
          return !used[p.skill + '::' + (p.sub || '')];
        });
        var take = Math.min(r.count, pool.length);
        var arr = [];
        for (var i = 0; i < take; i++) {
          var p = pool[i];
          var psub = p.sub || '';
          var pdef = OCC.skillById(p.skill);
          if (pdef && pdef.special && !psub) {
            psub = pickGroupSub(c, pdef);
            ensureSub(c, p.skill, psub);
          }
          used[p.skill + '::' + psub] = true;
          arr.push({ skill: p.skill, sub: psub, name: p.name || skillLabel(p.skill, psub || p.sub) });
        }
        if (arr.length) c.occupationPicks[r.id] = arr;
      } else if (r.type === 'free') {
        var want = Math.min(8, r.count);
        var arr2 = [];

        // 先用 AI 指定的（自定义职业专用路径）
        (opts.customSkills || []).forEach(function (nm) {
          if (arr2.length >= want) return;
          var id = OCC.resolveSkillId(nm);
          if (!id) return;
          var def = OCC.skillById(id);
          if (!def) return;
          var sub = '';
          if (def.special) {
            // 组技能（如「射击」）必须落到某个专攻上
            if (!(def.subskills || []).length) return;
            sub = pickGroupSub(c, def);
          }
          if (used[id + '::' + sub]) return;
          used[id + '::' + sub] = true;
          ensureSub(c, id, sub);
          arr2.push({ skill: id, sub: sub, name: def.name + (sub ? '（' + sub + '）' : '') });
        });

        // 不够就用随机池补齐
        var names = shuffle(FREE_POOL);
        for (var k = 0; k < names.length && arr2.length < want; k++) {
          var id2 = OCC.resolveSkillId(names[k]);
          if (!id2 || used[id2 + '::']) continue;
          var def2 = OCC.skillById(id2);
          if (!def2 || def2.special) continue;
          used[id2 + '::'] = true;
          arr2.push({ skill: id2, sub: '', name: def2.name });
        }
        if (arr2.length) c.occupationPicks[r.id] = arr2;
      }
    });
    Engine.recalc(c);
  }

  /* ---------- 信用评级 ---------- */
  function pickCreditRating(o, totalPoints) {
    /* 自定义职业没有信用评级区间（creditMin/Max 为 null）——
       规则书里这一项是玩家自己定的，这里就留 0 让玩家去填。 */
    if (!o || o.creditMin === null || o.creditMin === undefined) return 0;
    var lo = Math.max(0, o.creditMin);
    var hi = Math.min(o.creditMax === null ? lo : o.creditMax, lo + 60);
    var mid = Math.round(((lo + hi) / 2) / 5) * 5;
    var jitter = pick([-10, -5, 0, 5, 10]);
    var cr = clamp(mid + jitter, lo, hi);
    /* 信用评级是从职业点里扣的：留至少 60 点给技能。
       ⚠️ 但这只是「尽量」—— 池子本来就小的时候（比如 EDU 很低、
       或自定义职业）要能让位给技能，否则评级一项就吃掉全部点数。
       规则书允许信用评级为 0（尚未分配），所以这里不会把池子扣成负数。*/
    if (cr > totalPoints - 60) cr = totalPoints - 60;
    cr = Math.max(0, cr);
    if (cr < lo) cr = Math.min(lo, totalPoints);
    cr = clamp(cr, Math.min(lo, totalPoints), hi);
    return cr;
  }

  /* ---------- 点数分配 ---------- */
  /**
   * 随机撒点（兴趣技能与本职的零散点数都用它）。
   *
   * opts.avoid：避免让某项的最终值**恰好落在**这个数上。
   *   本职分配会传 50 —— 玩家上一版最大的抱怨就是「一摞技能全卡在 50」，
   *   所以哪怕随机撒点，也别正好撒出一个 50 来（越过或退到 45 都行）。
   *   兴趣点不需要这个规避，不传即可。
   */
  function spendPoints(c, keys, budget, field, capFn, avoid) {
    var alive = keys.slice();
    var spent = 0, guard = 0;
    while (spent < budget && alive.length && guard++ < 6000) {
      var k = alive[rnd(alive.length)];
      var s = byKey(c, k);
      if (!s) { alive.splice(alive.indexOf(k), 1); continue; }
      var room = capFn(s) - s.total;
      if (room <= 0) { alive.splice(alive.indexOf(k), 1); continue; }
      var left = budget - spent;
      var step = Math.min(room, left, pick([5, 5, 5, 10, 10, 15, 20]));
      /* 落点正好是 avoid（本职是 50）→ 往上越过去；越不过就退 5 点；
         连退都退不动（只剩 5 点）就照原样加，别为了规避而卡住预算。 */
      if (avoid && s.total + step === avoid) {
        if (step + 5 <= Math.min(room, left)) step += 5;
        else if (step > 5) step -= 5;
      }
      if (step <= 0) { alive.splice(alive.indexOf(k), 1); continue; }
      s[field] = (s[field] || 0) + step;
      SM.recompute(s);
      spent += step;
    }
    return spent;
  }

  /** 取整到 5 的倍数（技能值习惯上是 5 的倍数，随机卡与 AI 卡都对得上） */
  function snap5(v) { return Math.round(v / 5) * 5; }

  /* 「支援层」的目标值基准。拔尖项之外的技能给一个中等目标 ——
     它**故意压在 50 上下而不是齐刷刷 50**：玩家要的是「几项拔尖 + 其余够用」，
     而不是一摞 50 排成墙。 */
  var OCC_MID_TARGET = 50;

  /* 拔尖项的软上限。默认上限是 99（等于「不限」），真把某项堆到 96
     反而像假数据；所以顶项按 90 封顶，上限本身更低（如用户设 80）时
     软上限就等于上限 —— 保证「接近上限」这件事真的成立。 */
  var OCC_SOFT_TOP = 90;

  /**
   * 本职技能分配：**拔尖优先**，把预算一分不剩地花完。
   *
   * ⚠️ 这一版把上一版的「广度优先」整个换掉了。旧逻辑是
   * 「把预算全用来让尽可能多的本职技能从 30 升到 50」，实测结果是
   * 一张卡上七八项技能齐刷刷停在 50 —— 谁都不突出，玩家要的不是这个。
   *
   * 新的三步：
   *   1) **选** 2-4 项拔尖技能（一半取基础值最高的 —— 那是这行的看家本事，
   *      推上去最自然也最省点；一半随机，避免每张卡都长一个样）；
   *   2) **堆** 按阶梯给拔尖项定目标值：顶项贴着软上限，往后逐级递减，
   *      形成明显的层次。按「离目标还差多少」从小到大推，同样的预算
   *      能让更多拔尖项真的站上去；
   *   3) **垫** 富余点数先给 2-3 项「支援技能」一个中等目标（≈50 上下），
   *      还多就**随机撒**到其余技能上 —— 随机步长才不会撒出一堵同值的墙。
   *
   * ⚠️ 两条不能省的约束：
   *   · **必须花完**。终止条件只能是「预算用完」或「所有技能都到上限」，
   *     不能是「差不多了」—— 否则玩家会看到「点数剩着但技能没动」。
   *   · **不能为了达标而摊平**。这是新旧两版最大的差别：点数是零和的，
   *     把钱摊到第 7 项让它从 30 到 50，就必然没有富余把某一项堆到 85。
   *     玩家明确允许「有不加技能点的职业技能、或者总值低于 50 的」，
   *     所以宁可让一部分技能停在基础值，也要保住那几项拔尖的。
   */
  function spendOccFocused(c, keys, budget, capFn) {
    if (!keys.length || budget <= 0) return 0;
    var i, s;

    /* 只看「还有空间」的技能实例 */
    var items = [];
    for (i = 0; i < keys.length; i++) {
      s = byKey(c, keys[i]);
      if (!s) continue;
      if (capFn(s) - s.total <= 0) continue;
      items.push(s);
    }
    if (!items.length) return 0;

    var spent = 0;

    /* ---- 1) 选拔尖项 ---- */
    var byBase = items.slice().sort(function (a, b) { return (b.base || 0) - (a.base || 0); });
    var nPeak = Math.min(items.length, 2 + rnd(3));        // 2 - 4 项
    var takeTop = Math.max(1, Math.ceil(nPeak / 2));       // 一半取基础值最高的
    var peaks = byBase.slice(0, takeTop);
    var restPool = shuffle(byBase.slice(takeTop));
    for (i = 0; peaks.length < nPeak && i < restPool.length; i++) peaks.push(restPool[i]);
    peaks.sort(function (a, b) { return (b.base || 0) - (a.base || 0); });

    /* ---- 2) 阶梯目标（按预算决定拔尖几项、推到多高） ----
     *
     * ⚠️ 顺序很关键：预算不够时，**先减项数、再降高度**。
     * 反过来的话（目标往下调、项数不动），属性差一点的卡会出现
     * 「三四项齐刷刷 60 出头」—— 又绕回玩家吐槽的那堵「同值的墙」。
     * 宁可只拔尖 2 项（90 / 85），把剩下的预算留给支援层。
     */
    var softTop = Math.min(capFn(peaks[0]), OCC_SOFT_TOP);
    /* 预算够时在顶端留点随机（85-90 之间跳）；上限本来就低（如用户设 80）
       就贴着上限 —— 抖了会掉下来，「接近上限」这条就假了。 */
    var jitterTop = softTop >= 80 ? softTop - pick([0, 0, 5]) : softTop;
    var step = pick([4, 5, 5, 6, 8]);
    var budgetForPeaks = Math.floor(budget * 0.7);

    /* 把前 k 项按阶梯（jitterTop, jitterTop-step, …）推高要花多少 */
    function costHigh(k) {
      var total = 0, j, tg;
      for (j = 0; j < k && j < peaks.length; j++) {
        tg = Math.min(snap5(jitterTop - j * step), capFn(peaks[j]));
        total += Math.max(0, tg - peaks[j].total);
      }
      return total;
    }
    /* 从多到少找「预算扛得住的最大项数」；至少要 2 项 ——
       只拔尖 1 项的话，其余又全趴在基础值上，「2-4 项到 50」同样落空。 */
    var useN = 0;
    for (var kk = peaks.length; kk >= 2; kk--) {
      if (costHigh(kk) <= budgetForPeaks) { useN = kk; break; }
    }

    var plan = [], plentiful = useN >= 2;
    if (plentiful) {
      peaks = peaks.slice(0, useN);
      for (i = 0; i < peaks.length; i++) {
        var t0 = snap5(jitterTop - i * step);
        var cap0 = capFn(peaks[i]);
        if (t0 > cap0) t0 = cap0;
        if (t0 < peaks[i].total) t0 = peaks[i].total;
        plan.push({ skill: peaks[i], need: Math.max(0, t0 - peaks[i].total) });
      }
      /* 便宜的项先到目标 —— 同样的预算能让更多拔尖项真的站上去。 */
      plan.sort(function (a, b) { return a.need - b.need; });
    } else {
      /* 预算紧（连 2 项都推不到高位）→ 走**低位阶梯**，顺序是「先垫底、再拔尖」：
       *
       *   ① 先把靠前的几项垫到 50 以上（55 / 50 这样的相邻两档，不重样），
       *      这一步保的是「2-4 项 ≥50」；
       *   ② 剩下的钱**全部**砸给第 1 项，能顶多高顶多高 —— 它是这张卡的门面。
       *
       * ⚠️ 顺序不能反过来。先砸第 1 项的话，剩下的钱常常连一项 50 都垫不起来，
       *    卡上就变成「一个高分 + 其余全趴在基础值」，「2-4 项 ≥50」直接落空。
       *
       * ⚠️ 有些卡的预算**真的**不够两项都到 50（比如 EDU 25 的记者，
       *    信用评级还要先扣走一截，池子只剩 60 出头）—— 这时不硬凑，
       *    把全部预算给第 1 项，至少让这张卡有一个真拔尖的门面。
       */
      var fNeed = [], j2;
      /* 垫底候选：**按「到 50 还差多少」从便宜到贵排**，不按拔尖项来。
         拔尖项里有一半是随机抽的（就是那个「每张卡长得不一样」的机制），
         抽到基础值 5 的技能时，把它垫到 50 要 45 点 —— 同样的钱够把
         另外两项（基础值 25 / 20）垫上去了。垫底这一步只看性价比。 */
      var fPool = items.filter(function (x) { return capFn(x) >= OCC_MID_TARGET; })
        .sort(function (a, b) {
          return (Math.max(0, OCC_MID_TARGET - Math.min(a.total, capFn(a))) -
                  Math.max(0, OCC_MID_TARGET - Math.min(b.total, capFn(b))));
        });
      for (j2 = 0; j2 < fPool.length; j2++) {
        fNeed.push(Math.max(0, Math.min(OCC_MID_TARGET, capFn(fPool[j2])) - fPool[j2].total));
      }
      /* 垫底能垫几项：从多往少试，每多垫一项要多 5 点的「阶梯余量」 */
      var floorN = 0, bump = 5;
      for (var kf = Math.min(fPool.length, 4); kf >= 2; kf--) {
        var sumF = 0;
        for (j2 = 0; j2 < kf; j2++) sumF += fNeed[j2];
        if (sumF + bump * (kf - 1) <= budget) { floorN = kf; break; }
      }
      if (!floorN && fPool.length >= 2 && fNeed[0] + fNeed[1] <= budget) {
        floorN = 2; bump = 0;               /* 刚好够两项都站上 50 */
      }
      for (j2 = 0; j2 < floorN; j2++) {
        var tgF = OCC_MID_TARGET + bump * (floorN - 1 - j2);
        plan.push({ skill: fPool[j2],
                    need: Math.max(0, Math.min(tgF, capFn(fPool[j2])) - fPool[j2].total) });
      }
      /* ② 余钱全给第 1 项（必须排在垫底项**之后**，先保底再拔尖） */
      var top0 = peaks[0];
      var tgt0 = Math.min(capFn(top0), OCC_SOFT_TOP);
      var have0 = top0.total;
      for (j2 = 0; j2 < plan.length; j2++) {
        if (plan[j2].skill === top0) have0 = Math.min(capFn(top0), top0.total + plan[j2].need);
      }
      var extra0 = Math.max(0, tgt0 - have0);
      if (extra0 > 0) plan.push({ skill: top0, need: extra0 });
    }
    for (i = 0; i < plan.length && spent < budget; i++) {
      var put = Math.min(plan[i].need, budget - spent,
                         capFn(plan[i].skill) - plan[i].skill.total);
      if (put <= 0) continue;
      plan[i].skill.occ = (plan[i].skill.occ || 0) + put;
      SM.recompute(plan[i].skill);
      spent += put;
    }

    /* ---- 3) 支援层：给一部分剩下技能一个中等目标 ----
     * 目标值**刻意避开 50**（取 35/40/45/55/60）：上一版就是所有技能齐刷刷
     * 停在 50，玩家明确说不要那样。支援层本来就该是「够用即可」的一档，
     * 落在 45 或 55 都不影响可用性，却能让整张卡的数值真正错开。 */
    var midPool = shuffle(items.filter(function (x) { return peaks.indexOf(x) < 0; }));
    var nMid = Math.min(midPool.length, 2 + rnd(2));       // 2 - 3 项
    /* 支援层的档位：**故意避开 50**，而且每项取不同的档（不用随机数而是
       打乱后按序取），保证同一张卡里的支援项不会撞到同一个整数上。 */
    var midOffsets = shuffle([-20, -15, -10, -5, 5, 10, 15]);
    for (i = 0; i < nMid && spent < budget; i++) {
      var m = midPool[i];
      var mCap = capFn(m);
      var mTarget = snap5(OCC_MID_TARGET + midOffsets[i % midOffsets.length]);
      if (mTarget > mCap) mTarget = mCap;
      if (mTarget < m.total) mTarget = m.total;
      var need2 = Math.min(mTarget - m.total, budget - spent);
      if (need2 <= 0) continue;
      m.occ = (m.occ || 0) + need2;
      SM.recompute(m);
      spent += need2;
    }

    /* ---- 4) 还有富余（拔尖层 + 支援层都吃完之后） ----
     * 4a. 撒到**拔尖项之外**的技能上，而且是**随机步长**（5/10/15/20）——
     *     这正是「不再出现一堵同值的墙」的关键：随机撒出来的值有高有低
     *     （28、37、52…），而「先补到 X 再补到 Y」一定会在某个整数上堆平。
     * 4b. 连软上限都铺满时才放开到真实上限（默认 99 时几乎走不到）。
     * 4c. 只有**所有技能都到顶**才会剩下点数 —— 那是规则使然
     *     （界面会写明「已到上限」，不会假装用完了）。
     *
     * ⚠️ 「软上限」= min(该项有效上限, 90)。默认上限 99 等于「不限」，
     * 但把起始调查员的技能堆到 96/99 反而像假数据；90 已经是「几近巅峰」。
     * 玩家自己把上限设成 80 时，软上限就等于 80 —— 「接近上限」照旧成立。 */
    if (spent < budget) {
      var softCap = function (x) { return Math.min(capFn(x), OCC_SOFT_TOP); };
      var restKeys = [];
      for (i = 0; i < items.length; i++) {
        if (peaks.indexOf(items[i]) >= 0) continue;      // 拔尖项已经推到目标了
        restKeys.push(items[i].key);
      }
      spent += spendPoints(c, restKeys, budget - spent, 'occ', softCap, OCC_MID_TARGET);

      if (spent < budget) {
        var ranked = items.slice().sort(function (a, b) { return b.total - a.total; });
        for (i = 0; i < ranked.length && spent < budget; i++) {
          var room = capFn(ranked[i]) - ranked[i].total;
          if (room <= 0) continue;
          var lump = Math.min(room, budget - spent);
          ranked[i].occ = (ranked[i].occ || 0) + lump;
          SM.recompute(ranked[i]);
          spent += lump;
        }
      }
    }

    return spent;
  }

  /**
   * 把职业点与兴趣点分完
   *
   * ⚠️ 「AI 设置」里的技能上限写进的是 `c.skillCapOcc` / `c.skillCapInterest`
   *（**每个技能最终值**的上限），点数池本身永远是规则算出的全额。
   * 所以这里预算就是 remain —— 上限低到所有技能都顶满时，
   * 剩余点数会真的用不完，那是规则使然（界面会如实说明「已到上限」）。
   */
  /** v2.11.9（用户第 6 项）：武器对应的战斗技能集合（命中 s.sub 或 s.id）。
   *  没有武器 → 只保底「斗殴」。用于让加点只投入用得上的战斗技能。 */
  function weaponCombatSet(c) {
    var want = {};
    ((c && c.weapons) || []).forEach(function (w) {
      var sk = String(w.skill || '').trim();
      if (!sk) return;
      want[sk] = 1;
      /* '步枪/霰弹枪' 这类合并名拆开逐段命中 —— 否则和角色卡里的
         「步枪」「霰弹枪」子技能对不上，枪卡的射击子技能既加不到点、又被误排。 */
      sk.split('/').forEach(function (part) { var p = part.trim(); if (p) want[p] = 1; });
    });
    if (!Object.keys(want).length) want['斗殴'] = 1;
    return want;
  }

  function distributePoints(c) {
    var set = OCC.occupationalSet(c);
    var capFn = function (s) { return SM.capOf(c, s); };

    /* v2.11.9（用户第 6 项）：先看武器 —— 只有武器对应的战斗技能才配拿点；
       没有武器就保底「斗殴」（空手也能打）。避免「拿了小刀却把点扔进
       射击(步枪)/格斗(绞索)」这种没有配套武器的浪费。 */
    var wantCombat = weaponCombatSet(c);
    function combatUsable(sk) {
      if (SM.categoryOf(sk.id) !== '战斗') return true;           // 非战斗技能不受限
      return !!(wantCombat[sk.sub] || wantCombat[sk.id]);         // 武器对应的战斗技能才留
    }

    var pool = [], i, s;
    for (i = 0; i < c.skills.length; i++) {
      s = c.skills[i];
      if (s.id === 'credit' || s.id === 'cthulhu' || R.isGrowthOnly(s.id)) continue;
      /* 母语这类「豁免上限」的技能不进加点池（先天能力，非练出来的专长）。 */
      if (R.capExempt(s.id)) continue;
      pool.push(s);
    }
    var occAll = pool.filter(function (sk) { return !!(set[sk.key] || set[sk.id]); });
    var intAll = pool.filter(function (sk) { return !(set[sk.key] || set[sk.id]); });
    /* 本职池剔除用不上的战斗技能；但若剔完本职池空了（极端职业全是战斗技），
       就保留原池，避免职业点花不玩导致自检不过。兴趣池直接剔。 */
    var occFiltered = occAll.filter(combatUsable);
    var occKeys = (occFiltered.length ? occFiltered : occAll).map(function (sk) { return sk.key; });
    var intKeys = intAll.filter(combatUsable).map(function (sk) { return sk.key; });

    /* v2.11.9 #6：武器对应战斗技能的 key 集合（保证它们进兴趣焦点、真拿到点） */
    var wantCombatKeys = {};
    (c.skills || []).forEach(function (sk) {
      if (SM.categoryOf(sk.id) === '战斗' && (wantCombat[sk.sub] || wantCombat[sk.id])) wantCombatKeys[sk.key] = 1;
    });
    /* 武器技能没能在卡里实例化（罕见武器如电锯/炮术/弓不是标准战斗技能实例）时，
       保底把「斗殴」拉回池子 —— 否则所有战斗技能被排掉、角色一门战斗技都不能打。
       呼应「斗殴最差也能肉搏攻击」。 */
    if (!Object.keys(wantCombatKeys).length) {
      (c.skills || []).forEach(function (sk) {
        if (sk.id === '斗殴' || sk.sub === '斗殴') wantCombatKeys[sk.key] = 1;
      });
    }

    var cr = parseInt(c.assets.creditRating, 10) || 0;
    /* 这里读到的 total 已经是压缩后的池子，信用评级也是按压缩后的总额算的
       （pickCreditRating 先算好了），所以不会出现负预算。 */
    var op = OCC.occupationPoints(c);
    var ip = OCC.interestPoints(c);
    /* ⚠️ 预算必须是「**还剩**多少」，不是总额。
       正常生成时技能上还没加点，两者相等；
       但「恢复全额点数」这种**二次调用**时，卡上已经有一批点了 ——
       拿总额当预算会再分一遍同样的点数，直接超额。
       用 remain 天然对两种情况都成立（也就让这个函数变成幂等的）。 */
    spendOccFocused(c, occKeys, Math.max(0, op.remain), capFn);

    /* 兴趣点：先集中投在 10 项以内。
       投 14 项的话每项只剩十几二十点 —— 摊得越平，卡越「什么都会一点但都不行」。
       ⚠️ 但玩家的要求是「点数必须全部用完」，所以这 10 项到顶之后
       要继续往其余兴趣技能上倒 —— 兴趣技能本来就不受「50 以上」那条约束。 */
    /* 武器对应战斗技能必须进「兴趣焦点」，保证角色使得动武器；其余再随机补足名额 */
    var wantInt = intKeys.filter(function (k) { return wantCombatKeys[k]; });
    var focusCap = Math.min(intKeys.length, 10, 7 + rnd(4));
    var restInt = shuffle(intKeys.filter(function (k) { return !wantCombatKeys[k]; }));
    var focus = wantInt.concat(restInt).slice(0, Math.max(focusCap, wantInt.length));
    var usedInt = spendPoints(c, focus, Math.max(0, ip.remain), 'int', capFn);
    if (usedInt < ip.remain) spendPoints(c, intKeys, ip.remain - usedInt, 'int', capFn);
  }

  /* ============================================================
   * 装备：按设定的年代口径从规则数据里挑
   * ============================================================ */
  var MELEE_SKILLS = { '斗殴': 1, '剑': 1, '斧': 1, '矛': 1, '鞭子': 1, '链枷': 1, '绞具': 1, '弓': 1, '投掷': 1 };
  var MODERN_GADGET = /电锯|通电导线|电棍|电击枪|燃烧瓶|炸药|雷管|手榴弹|地雷|管状炸弹|信号枪|催泪瓦斯|火焰喷射器|迫击炮|坦克炮|舰载炮|反坦克/;

  /* 古代口径下**允许**出现的火器，逐件列出。
   *
   * ⚠️ 这里为什么不能靠 `w.era` 字符串过滤：
   * 武器表的 era 字段混了两种语义 —— 「1920s / 现代」是年代，
   * 而「罕见」是**稀有度**。早先的写法是 `era.indexOf('罕见') >= 0` 就当古代武器，
   * 结果 .58 斯普林菲尔德步枪（1870 年代的栓动步枪）被判定成古代产物，
   * 于是「武则天」这种古代卡里会掏出一把 M1873 —— 规则上说不通。
   * 所以古代口径改成显式白名单，宁可少给也不能给错。
   * 规则书口径：燧发/转轮等早期火器极为罕见，且通常需要先有「火器」相关检定。
   * 白名单里只留真正够早的：遂发枪（15 世纪末的欧洲火器）。
   * .41 转轮手枪是 1870 年代的东西，年代上仍然太晚，不进古代卡。 */
  var ANCIENT_FIREARMS = {
    '遂发枪': 1
  };

  function weaponPools(setting) {
    var W = global.COC_WEAPONS || [];
    var melee = [], gun = [];
    W.forEach(function (w) {
      var skill = String(w.skill || '');
      var era = String(w.era || '');
      if (MELEE_SKILLS[skill]) {
        if (setting.weaponEra === 'ancient' && MODERN_GADGET.test(w.name)) return;
        melee.push(w);
        return;
      }
      if (setting.weaponEra === 'ancient') {
        // 古代：只认白名单里的早期火器
        if (ANCIENT_FIREARMS[w.name]) gun.push(w);
        return;
      }
      if (setting.weaponEra === '1920s') {
        if (era.indexOf('1920') >= 0) gun.push(w);
        return;
      }
      if (era.indexOf('现代') >= 0) gun.push(w);
    });
    return { melee: melee, gun: gun };
  }

  function armorPool(setting) {
    var A = global.COC_ARMORS || [];
    var out = A.filter(function (a) {
      var era = String(a.era || '');
      if (setting.weaponEra === 'modern') return era.indexOf('现代') >= 0 || era.indexOf('至今') >= 0;
      if (setting.weaponEra === '1920s') return era.indexOf('1920') >= 0 || era.indexOf('至今') >= 0;
      return era.indexOf('现代') < 0 && era.indexOf('1920') < 0;
    });
    return out.length ? out : A;
  }

  var ITEMS_MODERN = ['手电筒', '手机', '钱包', '打火机', '急救包', '相机', '笔记本与铅笔', '绳索',
    '瑞士军刀', '雨伞', '备用弹匣', '防风外套', '望远镜', '备用电池', '药盒', '充电宝',
    '湿纸巾', '口香糖', '便携充电线', '折叠水杯', '头灯', '录音笔'];
  var ITEMS_1920 = ['手电筒', '怀表', '烟盒与火柴', '皮质笔记本', '钢笔与墨水', '折叠小刀', '绳索',
    '水壶', '雨衣', '备用子弹', '相机', '折叠地图', '手帕', '随身酒壶', '报纸', '车票',
    '绷带卷', '手杖', '皮手套', '蜡封信纸'];
  var ITEMS_ANCIENT = ['火折子', '油纸伞', '毛笔与墨', '折扇', '布囊', '绳索', '水囊', '干粮',
    '一串铜钱', '药囊', '短匕', '竹简与刀笔', '灯笼', '斗笠', '玉佩', '香囊', '火镰',
    '算筹', '油布', '铁蒺藜'];

  function itemPool(setting) {
    if (setting.weaponEra === 'ancient') return ITEMS_ANCIENT;
    if (setting.weaponEra === '1920s') return ITEMS_1920;
    return ITEMS_MODERN;
  }

  function fillEquipment(c, setting, ctx) {
    var pools = weaponPools(setting);

    c.weapons = [];
    // 1 把近战武器；按设定概率再带一件远程
    var m = pickFrom(pools.melee, ctx, 'w_melee');
    if (m) c.weapons.push(Object.assign({}, m, { qty: 1 }));
    if (pools.gun.length && Math.random() < (setting.gunChance || 0)) {
      var g = pickFrom(pools.gun, ctx, 'w_gun');
      if (g) c.weapons.push(Object.assign({}, g, { qty: 1 }));
    }

    c.armors = [];
    var ap = armorPool(setting);
    var arm = pickFrom(ap, ctx, 'armor');
    if (arm) c.armors.push(Object.assign({}, arm));

    c.items = [];
    var ip = shuffle(itemPool(setting));
    ip.slice(0, 3 + rnd(3)).forEach(function (nm) {
      c.items.push({ name: nm, quantity: 1, description: '' });
    });
  }

  /* ---------- 资产数值 ---------- */
  function fillAssets(c, setting) {
    var A = global.COC_ASSETS;
    if (!A) return;
    var cr = parseInt(c.assets.creditRating, 10) || 0;
    var level = (A.livingLevels || []).filter(function (L) { return cr >= L.crMin && cr <= L.crMax; })[0] || A.livingLevels[0];
    c.assets.spendingLevel = level.level;

    /* 货币不再只按时代匹配：古代中国在数据里根本没有对应币种，
       所以每个世界设定显式指定「用哪张倍数表（moneyRef）+ 显示成什么单位」。 */
    var ref = (setting && setting.moneyRef) || { era: c.basicInfo.era, region: '' };
    var cur = (A.currencies || []).filter(function (x) {
      return x.era === ref.era && (!ref.region || x.region === ref.region);
    })[0];
    if (!cur) cur = (A.currencies || []).filter(function (x) { return x.era === ref.era; })[0];
    if (!cur) cur = A.currencies[1];
    if (!cur) return;

    c.assets.currency = (setting && setting.unit) || cur.unit;
    var row = cur.mul.filter(function (m) { return m[0] === level.level; })[0];
    if (row && cr > 0) {
      c.assets.cash = Math.round(row[1] > 100 ? row[1] : row[1] * cr);
      var asset = Math.round(row[2] > 1000 ? row[2] : row[2] * cr);
      c.assets.assetsDescription = '总价值约 ' + c.assets.currency + ' ' + asset +
        '（' + (setting ? setting.label : cur.era) + '，' + level.level + '水平）';
    } else {
      c.assets.cash = 0;
      c.assets.assetsDescription = level.level + '：' + level.desc;
    }
  }

  /* ---------- 背景 ---------- */
  function fillBackground(c, occ, setting, ctx, pf) {
    var P = PER.pools;
    var bg = c.background;
    /* AI 车卡时会把「长什么样 / 信什么 / 牵挂谁」一起带进来，
       这里的原则是：AI 给了就用 AI 的，没给才从池子里补 —— 但池子里的东西
       会尊重世界设定，所以补出来的部分不会和 AI 的描述打架。 */
    var inj = (pf && pf.background) || {};

    bg.description = inj.description || PER.buildLook(setting, ctx);
    bg.ideology = inj.ideology || pickFrom(P.beliefs, ctx, 'beliefs');
    bg.traits = inj.traits || shuffle(P.traits).slice(0, 3).join('、');
    bg.wounds = inj.wounds || pickFrom(P.wounds, ctx, 'wounds');
    bg.treasuredPossessions = inj.treasuredPossessions || pickFrom(P.treasure, ctx, 'treasure');

    // 重要之人：关系 × 经过 × 现状 三段组合，重复概率极低
    if (inj.significantPeople) {
      bg.significantPeople = inj.significantPeople;
    } else {
      var rel = pickFrom(P.peopleRel, ctx, 'peopleRel');
      bg.significantPeople = rel + '｜' + pick(P.peopleMid) + '｜' + pick(P.peopleEnd);
    }

    // 意义非凡之地：模板里嵌真实地名，地点与出身保持一致
    if (inj.meaningfulPlaces) {
      bg.meaningfulPlaces = inj.meaningfulPlaces;
    } else {
      var tpl = pickFrom(P.placeTpl, ctx, 'placeTpl');
      var site = pick(setting.sites || ['城外那处旧地方']);
      bg.meaningfulPlaces = tpl
        .replace(/\{city\}/g, c.basicInfo.residence || c.basicInfo.birthplace || '城里')
        .replace(/\{site\}/g, site);
    }

    if (inj.phobias) {
      bg.phobias = inj.phobias;
    } else if (pf && pf.eggKind === 'friend') {
      /* v2.11.4（用户第 1 项）：跑团成员彩蛋卡一律不带背景心理症状。
         名人彩蛋（eggKind='celeb'）与普通随机角色一样走下方 1/5 概率。 */
      bg.phobias = '暂无。';
    } else if (pf && pf.fromAI) {
      /* v2.11.4（用户第 3 项）：AI 车卡的背景疯狂症状由 **AI 根据人物描述自行决定**
         （提示词已要求它判断有没有，ai.js#toProfile 采信其返回值）。
         这里必须**跳过下方 1/5 随机闸门** —— 否则会出现「AI 判定没有、系统又掷一条」
         的双重决定，AI 的决定权就白给了。 */
      bg.phobias = '暂无。';
    } else if (Math.random() < BG_MADNESS_RATE) {
      /* v2.11.4：约 1/5 的概率带一条。内容仍走疯狂表新逻辑 ——
         CocMadness.backgroundText 按总结症状表掷骰：
         8/10 得到一条总结症状（文本标【疯狂发作】），各 1/10 得到恐惧症 / 狂躁症。 */
      bg.phobias = (global.CocMadness && global.CocMadness.backgroundText)
        ? global.CocMadness.backgroundText('（' + pick(P.phobiaLead) + '）')
        : '暂无。';
    } else {
      bg.phobias = '暂无。';
    }

    // 入行经历
    var treasureName = String(bg.treasuredPossessions).split('｜')[0];
    c.history = [{
      title: '入行：' + occ.name,
      date: '',
      description: inj.history || (pick(P.historyTpl).replace(/\{occ\}/g, occ.name) + '　' +
        pick(P.entryTail).replace(/\{treasure\}/g, treasureName)),
      skillChanges: '', itemsObtained: '', notes: '',
      sanChange: '', hpChange: '', moneyChange: ''
    }];

    // 一位关系人
    var p = String(bg.significantPeople).split('｜');
    c.companions = [{
      name: p[0] || '（未命名）',
      avatar: '',
      identity: '背景关系人',
      age: String(28 + rnd(25)),
      relationship: occ.name + '时期结识',
      description: (p[1] || '') + ((p[2] || '') ? '　' + p[2] : '')
    }];
  }

  /* ============================================================
   * 组装一张卡
   *   opts.setting   指定世界设定（不传则按权重随机）
   *   opts.ctx       同批去重游标
   *   opts.profile   外部注入的创意字段（AI 车卡用）
   * ============================================================ */
  function build(opts) {
    opts = opts || {};
    var pf = opts.profile || {};
    /* 房规数值上限：随机卡 / 彩蛋卡 / AI 卡走的是**同一份**设置，
       而且每次生成时现读（是变量）—— 改完设置再点「换一批」立刻生效。 */
    var caps = activeCaps(opts);
    // 设定来源优先级：显式传入 > 外部创意里描述的地区/年代 > 加权随机
    var setting = opts.setting || (pf.setting && PER.resolve(pf.setting)) || PER.pick();
    var ctx = opts.ctx || newCtx();
    var c = Store.newCharacter('coc7');

    /* 1) 基本信息：姓名与地点都取自同一个世界设定 */
    var gender = pf.gender === '男' || pf.gender === '女' ? pf.gender : (Math.random() < 0.5 ? '男' : '女');
    var age = parseInt(pf.age, 10) || randomAge();
    age = clamp(age, 15, 80);
    c.basicInfo.gender = gender;
    c.basicInfo.age = age;
    c.age = age;
    c.basicInfo.era = pf.era || setting.era;
    c.basicInfo.eraCustom = c.basicInfo.era === '自定义'
      ? (pf.eraCustom || setting.eraCustom || '自定义时代')
      : '';
    c.worldId = setting.id;

    var cities = setting.cities || [];
    /* 彩蛋人物的居住/籍贯直接用资料里的，不随机 ——
       「茶叶蛋 · 现居宿州」这种一致性正是彩蛋要的效果。 */
    var residence = pf.residence || pf.city || pickFrom(cities, ctx, 'residence') || '未知';
    c.basicInfo.residence = residence;
    var birth = pf.birthplace || pf.town;
    if (!birth) {
      var towns = (setting.towns || []).concat(cities);
      var tries = 0;
      do { birth = pickFrom(towns, ctx, 'birthplace'); tries++; }
      while (birth === residence && tries < 6);
    }
    c.basicInfo.birthplace = birth;
    c.characterName = pf.name || PER.nameFor(setting.nameKey, gender);
    c.playerName = pf.playerName || '预设调查员';

    /* 2) 属性：外部给了且合规就用，否则掷到一组不极端的。
       ⚠️ AI 给的走**宽松**口径（attrsFromAI）：AI 车卡允许设置「属性总和上限」，
       压完之后八项合计可能低于随机卡要求的 380，但那是玩家自己定的上限，
       不能因此把 AI 好不容易配出来的人物性格丢掉、退回随机掷骰。 */
    var attrs = null;
    if (pf.attributes && (pf.fromAI ? attrsFromAI(pf.attributes) : attrsUsable(pf.attributes))) {
      attrs = Object.assign({}, c.attributes, pf.attributes);
    } else {
      for (var t = 0; t < 60; t++) {
        attrs = rollAttributes();
        if (attrsUsable(attrs)) break;
      }
    }
    c.attributes = attrs;
    c.attributeMode = 'random';
    c.attributeHistory = [{
      at: Date.now(), mode: 'random',
      note: pf.fromAI ? 'AI 车卡自动生成' : '第 0 步预设卡自动掷骰',
      attrs: Object.assign({}, attrs)
    }];

    /* 2.5) 属性总和上限（房规）。掷完 / 采纳完属性立刻压一次 ——
       必须在这里、在算职业点之前：职业点多为「教育×4」之类的公式，
       压完属性池子自然按压缩后的数值算，两边不会打架。
       ⚠️ 彩蛋卡也走这条路径（它的属性是资料里给的固定值），
       所以彩蛋一样受房规约束 —— 等比压缩会保住「爱因斯坦的智力最高」
       这种相对关系，压完仍认得出是谁。 */
    if (caps.attrCap) {
      c.attrCapSetting = caps.attrCap;
      c.attrCapWithLuck = caps.withLuck;
      c.attrCapScaled = applyAttrCapToCard(c, caps);
    }

    Engine.recalc(c);

    /* 3) 年龄带来的教育进步检定（真掷） */
    runEduChecks(c);

    /* 4) 职业 + 本职技能 */
    /* 属性被压到上限后，职业点公式算出来的池子会同步变小 ——
       沿用原来的 120 下限会把职业全筛掉（表现为反复重掷后返回 null）。
       按压缩幅度放宽下限：480 = 八项属性的常规总和（8 × 60），作为基准。 */
    var minPts = 120;
    if (caps.attrCap) minPts = Math.max(60, Math.round(120 * caps.attrCap / 480));

    var occ = null;
    var customSkills = null;
    if (pf.occupationId) occ = pickOccupation(c, setting, pf.occupationId, minPts);
    if (!occ && pf.occupationName) {
      var byName = occupationByName(pf.occupationName);
      if (byName && byName.id === 'occ1') {
        /* 自定义职业：AI 明确要求时才用。
           规则书原文「不多于 8 个本职技能」由 fillOccupationPicks 兜住上限。 */
        occ = byName;
        customSkills = pf.occupationSkills || null;
      } else if (byName && byName.creditMin !== null && byName.creditMin !== undefined) {
        occ = meetsNameReqs(byName, Engine.effAttrs(c)) ? byName : null;
      }
    }
    if (!occ) occ = pickOccupation(c, setting, null, minPts);
    if (!occ) return null;
    c.occupationId = occ.id;
    c.basicInfo.occupationName = occ.name;
    c.occupationPicks = {};
    c.assets.creditMin = occ.creditMin;
    c.assets.creditMax = occ.creditMax;
    Engine.recalc(c);
    SM.syncSkills(c);
    Engine.recalc(c);
    fillOccupationPicks(c, ctx, { customSkills: customSkills });

    /* 5) 技能最终值上限 + 信用评级（占用职业点）
     *
     * 上限必须**先**写到角色上 —— 信用评级按 creditMin/creditMax 选值，
     * 而上限会影响「非信用技能」能吃多少点，顺序错了分配预算会算错。
     *
     * ⚠️ 「每项本职技能上限 / 每项兴趣技能上限」的语义是
     * **每个技能最终值最多到多少**，不是「压缩整个点数池」。
     * 例：本职上限 80 → 私家侦探的「侦查」最多点到 80；
     *     兴趣上限 60 → 非本职技能（如「会计」）最多点到 60。
     * 所以写进的是 skillCapOcc / skillCapInterest（与「技能分配」步骤里
     * 手动设置的那两个上限是同一个字段、同一套判定），
     * **点数池本身不压** —— 池子始终是规则算出的全额。
     * 点数真的用不完只可能是一种情况：所有技能都已经顶到上限（界面会说明）。
     *
     * 个人特长 / 时代特长等玩家自选的技能按「是否属于本职」分流：
     * 属于本职走本职上限，否则走兴趣上限 —— 与 canAdd 的判定完全一致。
     *
     * ⚠️ 这里对所有卡生效（随机卡、彩蛋卡、AI 卡），不只是 AI 卡 ——
     *    房规定的技能上限不该只约束一种车卡方式。
     */
    var occCap = Math.max(0, parseInt(caps.occCap, 10) || 0);
    var intCap = Math.max(0, parseInt(caps.intCap, 10) || 0);
    if (occCap > 0) c.skillCapOcc = occCap;
    if (intCap > 0) c.skillCapInterest = intCap;
    if (occCap > 0 || intCap > 0) c.pointCapSetting = { occ: occCap, interest: intCap };
    var occTotal = OCC.occupationPoints(c).total;
    var cr = pickCreditRating(occ, occTotal);
    c.assets.creditRating = cr;
    var creditSkill = c.skills.filter(function (s) { return s.id === 'credit'; })[0];
    if (creditSkill) { creditSkill.occ = cr; SM.recompute(creditSkill); }
    Engine.recalc(c);

    /* 6) 先定装备（v2.11.9 用户第 6 项：武器必须先于加点，
          好让战斗技能只加「武器用得上的那门」，不浪费在没配套武器的技能上） */
    fillEquipment(c, setting, ctx);

    /* 7) 分完职业点与兴趣点（战斗技能按武器对齐） */
    distributePoints(c);

    /* 8) 资产 / 背景 */
    fillAssets(c, setting);
    fillBackground(c, occ, setting, ctx, pf);

    /* 8) 没上传头像就自动配一张 */
    if (!c.avatar) {
      var warm = setting.weaponEra === 'ancient' || setting.id === 'us-1920' ||
        setting.id === 'cn-republic' || setting.id === 'uk-victorian' || setting.id === 'ru-19c';
      global.CocAvatar.ensure(c, warm ? 'warm' : '');
    }

    /* 9) 彩蛋标记。这里必须在 build() 里做，不能只放在 generate() 里 ——
       generateOne / buildFrom 也可能被外部直接调用（AI 车卡复用这条路径），
       标记只在 generate 里设的话，从别处进来的彩蛋卡就没有标记，
       第 0 步卡片上也就看不到 🥚 / 🎭 角标。 */
    if (pf.isEasterEgg) {
      c.isEasterEgg = true;
      c.eggKind = pf.eggKind || 'celeb';
    }

    Engine.recalc(c);
    return c;
  }

  /** 生成后自检：规则上不通就重来 */
  function isSound(c) {
    if (!c) return false;
    var bad = Engine.checkList(c).filter(function (x) { return !x.ok; });
    return bad.length === 0;
  }

  function generateOne(opts) {
    for (var i = 0; i < 8; i++) {
      var c = build(opts);
      if (c && isSound(c)) return c;
    }
    return build(opts);
  }

  /**
   * 生成 n 张预设卡。
   * 同一批里：世界设定不重复、姓名不重复、背景文本从池子里去重抽取 ——
   * 这样一次出 5 张不会「看起来像同一个人换了件衣服」。
   *
   * 彩蛋按「**整批**」抽签而不是按单张卡抽：
   * 玩家的操作单位是点一次出 5 张。按单卡算概率时，
   * 跑团成员（只有 7 个，摊到单卡）低到「点一次才 13%」，
   * 实际体感就是「这功能没生效」。改成批级抽签后，
   * 约 1/4 的批次里会出现一位跑团成员、约 1/4 会出现一位名人，
   * 且彩蛋固定落在批次的中间位置，不会连着出两张。
   */
  function generate(n, opts) {
    n = parseInt(n, 10) || 5;
    opts = opts || {};
    var ctx = newCtx();
    var out = [], usedName = {}, usedSetting = {}, guard = 0;
    var EGG = global.CocEasterEgg;
    /* 房规数值上限：**整批只读一次**，5 张卡用同一份上限 ——
       否则玩家改设置的瞬间正在生成，一批里会出现两种口径。 */
    var caps = activeCaps(opts);

    /* ---- 批级彩蛋计划：整批只抽一次，决定「这一批的第几张是彩蛋」 ---- */
    var eggAt = -1, egg = null;
    if (EGG && !opts.setting && !opts.profile && n > 0) {
      egg = EGG.rollBatch ? EGG.rollBatch(n) : null;
      eggAt = egg ? Math.floor(n / 2) : -1;   // 固定落在中间那张
    }

    var slotIdx = 0;
    while (out.length < n && guard++ < n * 10) {
      /* 用到这一张就是彩蛋；用掉即弃（eggAt 只匹配一次） */
      var thisEgg = (slotIdx === eggAt) ? egg : null;
      if (thisEgg) { eggAt = -1; egg = null; }
      slotIdx++;

      // 优先挑本批还没用过的世界设定，避免 5 张卡全挤在同一个地区
      var setting = opts.setting;
      if (!setting) {
        if (thisEgg) {
          setting = PER.resolve(thisEgg.data.setting) || PER.pick();
        } else {
          var fresh = PER.list.filter(function (s) { return !usedSetting[s.id]; });
          setting = PER.pick();   // 加权随机
          if (fresh.length > 1 && usedSetting[setting.id]) setting = fresh[rnd(fresh.length)];
        }
      }
      usedSetting[setting.id] = true;

      var c = generateOne({
        setting: setting,
        ctx: ctx,
        caps: caps,
        profile: thisEgg ? EGG.toProfile(thisEgg) : opts.profile
      });
      if (!c) continue;

      // 彩蛋角色的姓名不能被「重名就换名」的逻辑改掉
      if (!thisEgg && usedName[c.characterName]) {
        for (var k = 0; k < 12; k++) {
          var nm = PER.nameFor(setting.nameKey, c.basicInfo.gender);
          if (!usedName[nm]) { c.characterName = nm; break; }
        }
        if (usedName[c.characterName]) c.characterName = c.characterName + '·' + (out.length + 1);
        // 名字换了，头像也得跟着换
        c.avatar = '';
        global.CocAvatar.ensure(c);
      }
      if (thisEgg) {
        c.isEasterEgg = true;
        c.eggKind = thisEgg.kind;
        // 彩蛋必须严格用资料里的名字（AI/预设流程可能改写过）
        c.characterName = thisEgg.data.name;
        c.playerName = thisEgg.kind === 'friend' ? '茶叶蛋调查员协会' : '预设调查员';
        // 名人按自己的时代；朋友一律现代
        c.basicInfo.era = (thisEgg.kind === 'friend') ? '现代' : (thisEgg.data.era || setting.era);
        if (c.basicInfo.era === '自定义') c.basicInfo.eraCustom = thisEgg.data.eraCustom || '';
        c.avatar = '';
        global.CocAvatar.ensure(c);
      }
      usedName[c.characterName] = true;
      out.push(c);
    }
    return out;
  }

  /** 一张卡的摘要数据（供第 0 步列表展示） */
  function summaryOf(c) {
    Engine.recalc(c);
    var d = c.derivedStats || {};
    var occ = OCC.getById(c.occupationId) || {};
    var setting = (c.worldId && global.CocPersonas) ? global.CocPersonas.getById(c.worldId) : null;
    var set = OCC.occupationalSet(c);
    var top = (c.skills || []).filter(function (s) {
      return (s.occ || 0) + (s.int || 0) > 0;
    }).sort(function (a, b) { return b.total - a.total; }).slice(0, 6);
    var st = SM.stats(c);
    return {
      card: c,
      name: c.characterName,
      avatar: c.avatar,
      gender: c.basicInfo.gender,
      age: c.basicInfo.age,
      era: c.basicInfo.era === '自定义' ? c.basicInfo.eraCustom : c.basicInfo.era,
      world: setting ? setting.label : '',
      /* 彩蛋标记：🥚 名人 / 🎭 跑团成员 */
      egg: c.isEasterEgg ? (c.eggKind === 'friend' ? '🎭' : '🥚') : '',
      eggKind: c.eggKind || '',
      residence: c.basicInfo.residence,
      birthplace: c.basicInfo.birthplace,
      occupation: occ.name || '—',
      credit: c.assets.creditRating,
      currency: c.assets.currency,
      attrs: c.attributes,
      hp: d.maxHP, mp: d.maxMP, san: d.maxSAN, mov: d.mov, build: d.build, db: d.db,
      luck: c.status.currentLuck,
      occUsed: st.occ.used, occTotal: st.occ.total,
      intUsed: st.interest.used, intTotal: st.interest.total,
      /* 房规数值上限：**只有真正低于规则默认值（99 = 不限）时才算生效**。
         ⚠️ 旧写法直接抛 st.occCap —— 而随机卡身上 skillCapOcc 默认就是 99，
         于是每张随机卡都会误报「被上限压过（职业点上限 99）（兴趣点上限 99）」，
         玩家据此以为「点数被压坏了」。这是本次要修的病根：
         99 就是「不限」，不是「上限 99」。 */
      occCap: (st.occCap && st.occCap < R.defaultOccSkillCap) ? st.occCap : 0,
      intCap: (st.interestCap && st.interestCap < R.defaultInterestSkillCap) ? st.interestCap : 0,
      /* 属性总和上限：生成时确实按它压过才记在卡上，没设就是 0 */
      attrCap: c.attrCapSetting || 0,
      attrCapWithLuck: c.attrCapWithLuck !== false,
      attrCapScaled: !!c.attrCapScaled,
      eduChecks: (c.eduProgress.log || []).length,
      eduBonus: c.eduProgress.bonus || 0,
      occtSkills: Object.keys(set).length,
      topSkills: top.map(function (s) {
        return { name: s.name, total: s.total, occ: !!(set[s.key] || set[s.id]) };
      }),
      weapons: (c.weapons || []).map(function (w) { return w.name; }),
      armors: (c.armors || []).map(function (a) { return a.name; }),
      items: (c.items || []).map(function (i) { return i.name; }),
      look: c.background.description,
      belief: c.background.ideology,
      traits: c.background.traits,
      phobia: c.background.phobias,
      people: c.background.significantPeople,
      place: c.background.meaningfulPlaces,
      treasure: c.background.treasuredPossessions,
      wound: c.background.wounds,
      history: (c.history || []).map(function (h) { return h.title; })
    };
  }

  global.PresetGen = {
    generate: generate,
    generateOne: generateOne,
    /** 读一次当前生效的房规数值上限（界面展示与测试用，与 build 同源） */
    activeCaps: activeCaps,
    /**
     * 造一张卡并注入外部创意（AI 车卡入口）
     * @param {object} opts { caps:{attrCap,withLuck,occCap,intCap} } 可选数值上限
     *                      不传时按 Store 设置里的房规上限走
     */
    buildFrom: function (profile, settingId, opts) {
      var setting = settingId ? PER.resolve(settingId) : null;
      var o = { setting: setting || undefined, ctx: newCtx(), profile: profile };
      /* 兼容旧的 ptsCap 写法：只给技能上限、不给属性上限 */
      if (opts && opts.caps) o.caps = opts.caps;
      else if (opts && opts.ptsCap) {
        o.caps = { attrCap: 0, withLuck: true,
                   occCap: opts.ptsCap.occ || 0, intCap: opts.ptsCap.int || 0 };
      }
      return generateOne(o);
    },
    summaryOf: summaryOf,
    isSound: isSound,
    /**
     * 重新分配一次职业点与兴趣点。
     *
     * 改了 skillCapOcc / skillCapInterest 之后可以用它重排。
     * 预算是**剩余量remain**而不是总额，所以重复调用不会超支（幂等）——
     * 这一点由 audit_point_cap 守着。
     */
    redistributePoints: function (c) {
      if (!c) return;
      distributePoints(c);
      Engine.recalc(c);
    },
    meetsNameReqs: meetsNameReqs,
    occupationByName: occupationByName,
    weaponPools: weaponPools,
    settingOf: function (c) { return (c && c.worldId && PER.getById(c.worldId)) || null; }
  };
})(window);
