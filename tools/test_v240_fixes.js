/*
 * v2.4.0 用户实测第四批修复自测（13 项中与本批相关的可测部分）
 *   ① 加入房间后展示房规摘要（大成功/大失败阈值）          —— 静态（probe meta 无字段，只能加入后展示）
 *   ② 手绘板实时绘制 + 橡皮擦段级删除                      —— 静态（pointer/DOM 交互，无头环境推演兜底）
 *   ③ 锁屏开屏重连竞态（陈旧 socket 事件过滤 + 主动换线）   —— 静态
 *   ④ KP 通用对抗：NPC/怪物缺属性/技能可手输检定值（1–100） —— 行为（_resolveActorSkill / checkOpposed）
 *   ⑤ 不定疯狂回合判定细化（FADED 武装/disarm/累计/治愈清零）—— 行为（三条来源 + 回合推进 + 治愈）
 *   ⑥ 战斗行动轮玩家 HP 同步（_opposedDamagePlayer → 战斗槽 public.hp）—— 行为
 *   ⑦ 结团时临时卡状态回写本机已保存角色卡                  —— 静态（Store 落库，无头推演兜底）
 *   ⑧ KP 裁定弹层「无法反抗」（跳过对抗判定，自动命中）      —— 行为
 *   ⑨ 连发改逐发串行判定（第 k 发 k-1 个惩罚骰；失败中断）   —— 行为
 *   ⑩ 奖惩骰 stepper 修复（选项式：奖/惩分离、各自 0–5）    —— 静态
 *   ⑫ 场景检定删「检定类型」下拉 + 结果广播 PUBLIC          —— 静态 + 行为（emit 可见性）
 *   ⑬ KP 视角删「物品道具」入口                            —— 静态
 *
 * 运行： node tools/test_v240_fixes.js（工作目录 = 仓库根）
 * 成功时最后一行打印 RESULT: PASS
 */
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');
var base = 'web/js/';

var pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? ('  → ' + extra) : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
function section(t) { console.log('\n== ' + t + ' =='); }

function mkSandbox(files) {
  var sb = {};
  vm.createContext(sb); sb.window = sb;
  files.forEach(function (f) { vm.runInContext(fs.readFileSync(path.join(base, f), 'utf8'), sb); });
  return sb;
}
var sbM = mkSandbox(['core/room-rules.js', 'core/room-model.js']);
var M = sbM.RoomModel, R = sbM.CocRules;
function feeder(seq) { var i = 0; return function () { return seq[i++ % seq.length]; }; }
var SYMPTOM_PROVIDER = { roll: function () { return { type: 'bout', name: '失忆', rounds: 3 }; } };

/** 强制失败损失的规则替身（⑤ 用：确定性扣 SAN + 走 _afterSanLoss 全链路） */
function lossyRules(loss) {
  var rules = Object.create(R);
  rules.resolveSanCheck = function (o) {
    var before = Math.max(0, Number(o.currentSan) || 0);
    var after = Math.max(0, before - loss);
    return {
      ok: true,
      check: { value: 99, passed: false, failed: true, levelText: '失败',
               base: before, target: before, summary: '强制失败' },
      lossExpr: '0/' + loss, usedBranch: 'onFail', branchText: '失败',
      lossTerms: [{ count: 1, sides: 6, sign: 1 }],
      roll: { ok: true, total: loss, rolls: [] },
      loss: loss, before: before, after: after,
      maxSan: (o.maxSan == null ? 99 : o.maxSan)
    };
  };
  return rules;
}

/** 造 Host（通用）。opts.order 战斗槽；opts.weapons 人物卡武器；opts.loss 强制 SAN 损失。 */
function mkHost(opts) {
  opts = opts || {};
  var host = new M.Host({
    rules: opts.loss > 0 ? lossyRules(opts.loss) : R,
    rng: feeder(opts.rng || [0.3, 0.0]),
    madness: opts.symptom ? SYMPTOM_PROVIDER : null,
    now: function () { return 1000; }
  });
  host.roster.open({ seat: 's1', role: M.ROLE.PLAYER, nickname: '小美' });
  var mem = host.roster.get('s1');
  mem.charName = '小美';
  mem.sheet = {
    name: '小美', attrs: { str: 60, int: 60, pow: 50 },
    status: { currentHP: 12, maxHP: 12, currentSAN: 50, maxSAN: 50 },
    skills: [{ name: '格斗（斗殴）', total: 60 }, { name: '射击（手枪）', total: 55 },
             { name: '闪避', total: 50 }, { name: '觉察', total: 55 }],
    weapons: opts.weapons || [{ name: '匕首', skill: '斗殴', damage: '1D4', pierce: '×', perRound: '1' }],
    madness: [], mental: ['正常'], db: opts.db || '0'
  };
  host.state.combat = { order: opts.order || [], turn: 0, round: 1, startedAt: 0 };
  host.state.meta.status = M.STATUS.IN_GAME;
  return { host: host, mem: mem };
}

/** 脚本化 resolveAttack 替身（⑥⑧⑨ 用：逐发脚本 + 记录调用参数） */
function scriptRules(script) {
  var rules = Object.create(R);
  var calls = [];
  rules.resolveAttack = function (o) {
    var i = calls.length;
    calls.push({ penalty: o.penalty, bonus: o.bonus, mode: o.defense && o.defense.mode });
    var s = script[i] || { outcome: 'miss' };
    var winner = (s.outcome === 'defender_wins') ? 'b'
      : ((s.outcome === 'attacker_wins' || s.outcome === 'hit') ? 'a' : null);
    return {
      attack: { value: 30, level: 2, levelText: '常规成功', critical: false,
                passed: s.outcome !== 'miss', target: 50, label: '攻击' },
      defense: s.defense || null,
      outcome: s.outcome,
      damage: s.damage || { raw: 0, expr: '1D6', armor: 0, applied: 0, impale: false },
      compare: s.compare || { winner: winner, decidedBy: 'level', rounds: [] },
      level: 'regular', flags: {}, mode: o.defense && o.defense.mode,
      ranged: false, rerolls: [], damageBy: null, coercedFromFightback: false
    };
  };
  return { rules: rules, calls: calls };
}

function picks(out, t) {
  var arr = [];
  (out || []).forEach(function (r) { if (r && r.msg && r.msg.t === t) arr.push(r.msg.p || {}); });
  return arr;
}
function allText(out) {
  return (out || []).map(function (r) {
    return (r && r.msg && r.msg.p && (r.msg.p.text || r.msg.p.summary)) || '';
  }).join(' | ');
}
function anyPubLog(out, re) {
  return (out || []).some(function (r) {
    return r && r.msg && r.msg.t === M.EVT.LOG && re.test((r.msg.p && r.msg.p.text) || '');
  });
}
function hasPublicStep(out, t) {
  return (out || []).some(function (r) {
    return r && r.to === '*' && r.msg && r.msg.t === t;
  });
}
function readSrc(rel) { return fs.readFileSync(path.join(base, rel), 'utf8'); }

/* ============================================================
 * ④ KP 通用对抗：NPC/怪物缺属性/技能 → KP 手输检定值（1–100）
 * ============================================================ */
section('④ 通用对抗手输检定值');
(function () {
  var h = mkHost({ order: [{ id: 'a1', actorId: 'm1', name: '食尸鬼', kind: 'monster',
                             public: { hp: 10, hpMax: 10 } }] });
  /* 模型侧直测：怪物无 skills 表 + KP 手输 42 → ok 且按 42 结算 */
  var ra = h.host._resolveActorSkill('a:m1', '觉察', 42);
  ok(!!ra && ra.ok === true && ra.value === 42, '怪物无技能值 + 手输 42 → ok:true, value=42',
     JSON.stringify(ra));
  ok(!!ra && /食尸鬼/.test(ra.name || ''), '单位名用怪物名（不泄漏 actorId）', ra && ra.name);

  /* 手输了值但非法 → 明确报错（不静默按 0/截断） */
  var rb = h.host._resolveActorSkill('a:m1', '觉察', 42.5);
  ok(!!rb && rb.ok === false && /1–100 的整数/.test(rb.reason || ''), '手输 42.5（非整数）→ ok:false 报错',
     JSON.stringify(rb));
  var rc = h.host._resolveActorSkill('a:m1', '觉察', 101);
  ok(!!rc && rc.ok === false, '手输 101（越界）→ ok:false 报错', JSON.stringify(rc));
  var rd = h.host._resolveActorSkill('a:m1', '觉察', 0);
  ok(!!rd && rd.ok === false, '手输 0（非法）→ ok:false 报错', JSON.stringify(rd));

  /* 完全没手输 → 旧 0 兜底（兼容 v2.2.1 测试 ②2a：怪物无 skills 无 bBase） */
  var re = h.host._resolveActorSkill('a:m1', '觉察');
  ok(!!re && re.ok === true && re.value === 0, '未手输 → 旧 0 兜底（向后兼容）', JSON.stringify(re));

  /* 单位不存在 / 空 ref → 明确报错 */
  var rf = h.host._resolveActorSkill('ghost', '格斗', null);
  ok(!!rf && rf.ok === false && /找不到对抗单位/.test(rf.reason || ''), '单位不存在 → ok:false 报错',
     JSON.stringify(rf));
  var rg = h.host._resolveActorSkill('', '格斗', null);
  ok(!!rg && rg.ok === false, 'ref 为空 → ok:false 报错', JSON.stringify(rg));

  /* 玩家侧仍读人物卡 */
  var rh = h.host._resolveActorSkill('p:s1', '格斗', null);
  ok(!!rh && rh.ok === true && rh.value === 60, '玩家侧仍从人物卡取值（格斗 60）', JSON.stringify(rh));

  /* 端到端：非法手输值走 checkOpposed → 「乙方无效」且不出结果卡 */
  var r1 = h.host.checkOpposed('host', { aSeat: 'p:s1', aSkill: '格斗',
                                         bSeat: 'a:m1', bSkill: '觉察', bBase: 42.5 });
  ok(/乙方无效/.test(allText(r1)) && picks(r1, M.EVT.CHECK).length === 0,
     '端到端：手输 42.5 → 「乙方无效」且不出结果卡');
  var r1b = h.host.checkOpposed('host', { aSeat: 'p:s1', aSkill: '格斗',
                                          bSeat: 'a:m1', bSkill: '觉察', bBase: 42 });
  var chk1b = picks(r1b, M.EVT.CHECK)[0] || {};
  ok(!!chk1b && /食尸鬼/.test(chk1b.b.name || '') && !/无效/.test(allText(r1b)),
     '端到端：手输 42 → 正常出卡，记录用怪物名', chk1b.b && chk1b.b.name);
  var r1c = h.host.checkOpposed('host', { aSeat: 'ghost', aSkill: '格斗', bSeat: 'p:s1', bSkill: '闪避' });
  ok(/甲方无效/.test(allText(r1c)) && picks(r1c, M.EVT.CHECK).length === 0,
     '端到端：甲方单位不存在 → 「甲方无效」且不出结果卡');

  /* 兼容：怪物无技能值且无手输值 → 旧 0 兜底不报错（v2.2.1 ②2a 口径） */
  var r7 = h.host.checkOpposed('host', { aSeat: 'p:s1', aSkill: '格斗', bSeat: 'a:m1', bSkill: '觉察' });
  ok(picks(r7, M.EVT.CHECK).length >= 1 && !/无效/.test(allText(r7)),
     '端到端：无手输值 → 旧 0 兜底（不报错、不回归 v2.2.1 测试）');
})();

/* ============================================================
 * ⑤ 不定疯狂回合判定细化
 * ============================================================ */
section('⑤ 不定疯狂回合判定细化');
(function () {
  /* (a) FADED + 本回合任意损失 → 复发（缺省武装：旧存档/直接置态也按此口径） */
  var g = mkHost({ loss: 3, symptom: true });
  g.mem.sheet.mental = ['不定疯狂（症状消失）'];
  var outA = g.host.intent('s1', { op: M.INTENT.SAN_CHECK, p: { okLoss: '0', loss: '3', reason: 'x' } });
  ok(g.mem.sheet.mental.indexOf('不定疯狂') >= 0, '(a) FADED + 掉 3 SAN → 复发（标签换回「不定疯狂」）',
     JSON.stringify(g.mem.sheet.mental));
  ok(g.mem.sheet.mental.indexOf('不定疯狂（症状消失）') < 0, '(a) 旧「症状消失」标签被替换');
  ok(anyPubLog(outA, /不定疯狂复发/), '(a) 公开记录「不定疯狂复发」');
})();

(function () {
  /* (b) KP 推进回合 → FADED disarm：小额损失不复发；本回合累计 ≥ ceil(maxSAN/5)=10 才复发 */
  var g = mkHost({ symptom: true });
  g.mem.sheet.mental = ['不定疯狂（症状消失）'];
  g.host.intent('host', { op: M.INTENT.ACT, p: { op: 'round.next' } });
  eq(g.host._fadedArm['s1'], false, '(b) 回合推进 → FADED 座位显式 disarm（_fadedArm=false）');
  var out1 = g.host.intent('s1', { op: M.INTENT.ACT, p: { op: 'state.self', status: { currentSAN: 47 } } });
  ok(g.mem.sheet.mental.indexOf('不定疯狂（症状消失）') >= 0 && !anyPubLog(out1, /复发|不定性疯狂/),
     '(b) disarm 后掉 3 SAN（<10）→ 不复发', JSON.stringify(g.mem.sheet.mental));
  var out2 = g.host.intent('s1', { op: M.INTENT.ACT, p: { op: 'state.self', status: { currentSAN: 37 } } });
  ok(g.mem.sheet.mental.indexOf('不定疯狂') >= 0, '(b) 本回合累计 13 ≥ ceil(50/5)=10 → 复发',
     JSON.stringify(g.mem.sheet.mental));
  ok(anyPubLog(out2, /不定疯狂复发/), '(b) 累计达标 → 公开记录「不定疯狂复发」');

  /* (b2) 再推进一回合同样 disarm（每回合都收回特权） */
  var g2 = mkHost({ symptom: true });
  g2.mem.sheet.mental = ['不定疯狂（症状消失）'];
  g2.host.intent('host', { op: M.INTENT.ACT, p: { op: 'round.next' } });
  g2.host.intent('host', { op: M.INTENT.ACT, p: { op: 'round.next' } });
  eq(g2.host._fadedArm['s1'], false, '(b2) 多次推进回合 → 仍保持 disarm');
})();

(function () {
  /* (c) 治愈 → 累计清零，从零重新累计（旧实现不清零会残留误判）。
     ⚠️ 步进都取 <5 的单次损失，避开「单次 ≥5 → 临时疯狂」分支，隔离测试目标。 */
  var g = mkHost({ symptom: true });
  g.mem.sheet.mental = ['不定疯狂（症状消失）'];
  g.host.intent('host', { op: M.INTENT.ACT, p: { op: 'round.next' } });   // disarm
  g.host.intent('s1', { op: M.INTENT.ACT, p: { op: 'state.self', status: { currentSAN: 47 } } });  // +3
  g.host.intent('s1', { op: M.INTENT.ACT, p: { op: 'state.self', status: { currentSAN: 44 } } });  // +3 → 累计 6
  g.host.intent('s1', { op: M.INTENT.ACT, p: { op: 'state.self', status: { currentSAN: 42 } } });  // +2 → 累计 8
  ok(g.mem.sheet.mental.indexOf('不定疯狂（症状消失）') >= 0, '(c) 累计 8（<10）→ 未复发（前置）');
  /* 治愈（玩家申请 → KP 同意） */
  g.host.intent('s1', { op: M.INTENT.ACT, p: { op: 'madness.cure' } });
  g.host.intent(M.HOST_SEAT, { op: M.INTENT.CONFIRM, p: { op: 'madness.cure', agree: true } });
  eq(JSON.stringify(g.mem.sheet.mental), JSON.stringify(['正常']), '(c) 治愈 → 精神状态回「正常」');
  eq(g.host._sanLostThisRound['s1'], 0, '(c) 治愈 → 本回合累计计数器清零');
  var outC = g.host.intent('s1', { op: M.INTENT.ACT, p: { op: 'state.self', status: { currentSAN: 39 } } });
  ok(g.mem.sheet.mental.indexOf('不定疯狂') < 0 && !anyPubLog(outC, /不定疯狂/),
     '(c) 治愈后再掉 3 SAN → 从零累计（3<10）不误判复发', JSON.stringify(g.mem.sheet.mental));
})();

(function () {
  /* (d) 三条来源统一判定（FADED 武装态）：自助 SAN Check / KP 定向 / 状态管理 */
  var g1 = mkHost({ loss: 3, symptom: true });
  g1.mem.sheet.mental = ['不定疯狂（症状消失）'];
  g1.host.intent('s1', { op: M.INTENT.SAN_CHECK, p: { okLoss: '0', loss: '3', reason: 'x' } });
  ok(g1.mem.sheet.mental.indexOf('不定疯狂') >= 0, '(d) 来源①自助 SAN Check → 复发');

  var g2 = mkHost({ loss: 3, symptom: true });
  g2.mem.sheet.mental = ['不定疯狂（症状消失）'];
  g2.host.intent(M.HOST_SEAT, { op: M.INTENT.ACT, p: { op: 'sheet.sancheck', seat: 's1', okLoss: '0', loss: '3', reason: 'KP' } });
  ok(g2.mem.sheet.mental.indexOf('不定疯狂') >= 0, '(d) 来源②KP 定向 SAN Check → 复发');

  var g3 = mkHost({ symptom: true });
  g3.mem.sheet.mental = ['不定疯狂（症状消失）'];
  g3.host.intent('s1', { op: M.INTENT.ACT, p: { op: 'state.self', status: { currentSAN: 47 } } });
  ok(g3.mem.sheet.mental.indexOf('不定疯狂') >= 0, '(d) 来源③状态管理扣 SAN → 复发');

  /* 反例：加 SAN 不复发 */
  var g4 = mkHost({ symptom: true });
  g4.mem.sheet.mental = ['不定疯狂（症状消失）'];
  g4.host.intent('s1', { op: M.INTENT.ACT, p: { op: 'state.self', status: { currentSAN: 60 } } });
  ok(g4.mem.sheet.mental.indexOf('不定疯狂（症状消失）') >= 0, '(d) 反例：加 SAN 不复发');
})();

/* ============================================================
 * ⑥ 战斗行动轮玩家 HP 同步（反击命中 → 战斗槽 public.hp）
 * ============================================================ */
section('⑥ 战斗槽 HP 同步');
(function () {
  var stub = scriptRules([{
    outcome: 'defender_wins',
    defense: { value: 60, level: 2, levelText: '常规成功' },
    damage: { raw: 3, expr: '1D4', armor: 0, applied: 3, impale: false },
    compare: { winner: 'b', decidedBy: 'level', rounds: [] }
  }]);
  var order = [
    { id: 'pc1', actorId: 's1', seat: 's1', kind: 'pc', name: '小美', public: { hp: 12, hpMax: 12 } },
    { id: 'a1', actorId: 'm1', name: '食尸鬼', kind: 'monster', public: { hp: 20, hpMax: 20 } }
  ];
  var host = new M.Host({ rules: stub.rules, rng: feeder([0.3, 0.0]), now: function () { return 1000; } });
  host.roster.open({ seat: 's1', role: M.ROLE.PLAYER, nickname: '小美' });
  var mem = host.roster.get('s1');
  mem.charName = '小美';
  mem.sheet = {
    name: '小美', attrs: { str: 60 }, status: { currentHP: 12, maxHP: 12, currentSAN: 50, maxSAN: 50 },
    skills: [{ name: '格斗（斗殴）', total: 60 }],
    weapons: [{ name: '匕首', skill: '斗殴', damage: '1D4', pierce: '×', perRound: '1' }],
    madness: [], mental: ['正常'], db: '0'
  };
  host.state.combat = { order: order, turn: 0, round: 1, startedAt: 0 };
  /* v2.6.0（用户第 3 项）：玩家发起武器对抗需在其行动轮次。以下是引导测试 fixture，有的只放了怪物槽 —— 若当前行动槽不是 s1 的 PC 槽，补一个并把 turn 指向它。 */
  var _cur = host.state.combat.order[host.state.combat.turn];
  if (!_cur || _cur.kind !== 'pc' || _cur.seat !== 's1') {
    host.state.combat.order.push({ id: 's1#0', actorId: 's1', seat: 's1', kind: 'pc', name: '小美', public: { hp: 12, hpMax: 12 } });
    host.state.combat.turn = host.state.combat.order.length - 1;
  }
  host.state.meta.status = M.STATUS.IN_GAME;
  host.state.meta.mode = M.MODE.COMBAT;

  host.intent('s1', { op: M.INTENT.OPPOSED, p: {
    phase: 'request', weapon: { name: '匕首' }, db: '0', targetId: 'm1', targetName: '食尸鬼', shots: 1
  } });
  var out = host.checkOpposed('host', { attack: true, reqId: host.state.opposed.id,
    defender: { reaction: 'counter', value: 60 }, armor: { value: 0 } });
  var pc = order[0];
  eq(pc.public.hp, 9, '⑥ 反击命中 3 点 → 战斗槽 public.hp 12→9（修复前不同步）');
  eq(mem.sheet.status.currentHP, 9, '⑥ 人物卡 currentHP 同步为 9');
  ok((out || []).some(function (r) { return r && r.msg && r.msg.t === M.EVT.TURNSTATE; }),
     '⑥ 发出 EVT.TURNSTATE（战斗轮状态广播）');
  ok((out || []).some(function (r) { return r && r.msg && r.msg.t === M.EVT.ACTOR; }),
     '⑥ 发出 EVT.ACTOR（战斗单位快照）');

  /* 打死：伤害 ≥ HP → 槽标记 dead/down */
  var stub2 = scriptRules([{
    outcome: 'defender_wins',
    defense: { value: 60, level: 2, levelText: '常规成功' },
    damage: { raw: 99, expr: '1D4', armor: 0, applied: 99, impale: false },
    compare: { winner: 'b', decidedBy: 'level', rounds: [] }
  }]);
  var order2 = [
    { id: 'pc1', actorId: 's1', seat: 's1', kind: 'pc', name: '小美', public: { hp: 12, hpMax: 12 } },
    { id: 'a1', actorId: 'm1', name: '食尸鬼', kind: 'monster', public: { hp: 20, hpMax: 20 } }
  ];
  var host2 = new M.Host({ rules: stub2.rules, rng: feeder([0.3, 0.0]), now: function () { return 1000; } });
  host2.roster.open({ seat: 's1', role: M.ROLE.PLAYER, nickname: '小美' });
  var mem2 = host2.roster.get('s1');
  mem2.charName = '小美';
  mem2.sheet = {
    name: '小美', attrs: { str: 60 }, status: { currentHP: 12, maxHP: 12, currentSAN: 50, maxSAN: 50 },
    skills: [{ name: '格斗（斗殴）', total: 60 }],
    weapons: [{ name: '匕首', skill: '斗殴', damage: '1D4', pierce: '×', perRound: '1' }],
    madness: [], mental: ['正常'], db: '0'
  };
  host2.state.combat = { order: order2, turn: 0, round: 1, startedAt: 0 };
  /* v2.6.0（用户第 3 项）：玩家发起武器对抗需在其行动轮次。以下是引导测试 fixture，有的只放了怪物槽 —— 若当前行动槽不是 s1 的 PC 槽，补一个并把 turn 指向它。 */
  var _cur = host2.state.combat.order[host2.state.combat.turn];
  if (!_cur || _cur.kind !== 'pc' || _cur.seat !== 's1') {
    host2.state.combat.order.push({ id: 's1#0', actorId: 's1', seat: 's1', kind: 'pc', name: '小美', public: { hp: 12, hpMax: 12 } });
    host2.state.combat.turn = host2.state.combat.order.length - 1;
  }
  host2.state.meta.status = M.STATUS.IN_GAME;
  host2.state.meta.mode = M.MODE.COMBAT;
  host2.intent('s1', { op: M.INTENT.OPPOSED, p: {
    phase: 'request', weapon: { name: '匕首' }, db: '0', targetId: 'm1', targetName: '食尸鬼', shots: 1
  } });
  host2.checkOpposed('host', { attack: true, reqId: host2.state.opposed.id,
    defender: { reaction: 'counter', value: 60 }, armor: { value: 0 } });
  eq(order2[0].public.hp, 0, '⑥ 致死伤害 → 战斗槽 hp 夹到 0');
  eq(order2[0].public.state, 'dead', '⑥ 致死伤害 → 槽状态标记 dead');
  eq(order2[0].public.down, true, '⑥ 致死伤害 → 槽 down=true');
})();

/* ============================================================
 * ⑧ KP 裁定「无法反抗」（跳过对抗判定，自动命中）
 * ============================================================ */
section('⑧ 无法反抗（自动命中）');
(function () {
  /* 攻击检定成功路径：mode='none' 直接 HIT，记录写明「无法反抗，自动命中」 */
  var stub = scriptRules([{
    outcome: 'attacker_wins',
    damage: { raw: 4, expr: '1D4', armor: 0, applied: 4, impale: false },
    compare: { winner: 'a', decidedBy: 'level', rounds: [] }
  }]);
  var order = [{ id: 'a1', actorId: 'm1', name: '食尸鬼', kind: 'monster', public: { hp: 20, hpMax: 20 } }];
  var host = new M.Host({ rules: stub.rules, rng: feeder([0.3, 0.0]), now: function () { return 1000; } });
  host.roster.open({ seat: 's1', role: M.ROLE.PLAYER, nickname: '小美' });
  var mem = host.roster.get('s1');
  mem.charName = '小美';
  mem.sheet = {
    name: '小美', attrs: { str: 60 }, status: { currentHP: 12, maxHP: 12, currentSAN: 50, maxSAN: 50 },
    skills: [{ name: '格斗（斗殴）', total: 60 }],
    weapons: [{ name: '匕首', skill: '斗殴', damage: '1D4', pierce: '×', perRound: '1' }],
    madness: [], mental: ['正常'], db: '0'
  };
  host.state.combat = { order: order, turn: 0, round: 1, startedAt: 0 };
  /* v2.6.0（用户第 3 项）：玩家发起武器对抗需在其行动轮次。以下是引导测试 fixture，有的只放了怪物槽 —— 若当前行动槽不是 s1 的 PC 槽，补一个并把 turn 指向它。 */
  var _cur = host.state.combat.order[host.state.combat.turn];
  if (!_cur || _cur.kind !== 'pc' || _cur.seat !== 's1') {
    host.state.combat.order.push({ id: 's1#0', actorId: 's1', seat: 's1', kind: 'pc', name: '小美', public: { hp: 12, hpMax: 12 } });
    host.state.combat.turn = host.state.combat.order.length - 1;
  }
  host.state.meta.status = M.STATUS.IN_GAME;
  host.state.meta.mode = M.MODE.COMBAT;
  host.intent('s1', { op: M.INTENT.OPPOSED, p: {
    phase: 'request', weapon: { name: '匕首' }, db: '0', targetId: 'm1', targetName: '食尸鬼', shots: 1
  } });
  /* noDefense + 对抗值 0（UI 勾选后不要求填值）→ 不应报「请为…输入 1–100」 */
  var out = host.checkOpposed('host', { attack: true, reqId: host.state.opposed.id,
    noDefense: true, defender: { reaction: 'none', value: 0 }, armor: { value: 0 } });
  eq(stub.calls.length, 1, '⑧ 只跑一次攻击结算（无防守掷骰）');
  eq(stub.calls[0].mode, 'none', '⑧ 防守 mode=none（跳过对抗判定）');
  var chk = picks(out, M.EVT.CHECK)[0] || {};
  ok(/无法反抗/.test(chk.summary || ''), '⑧ 公开记录含「无法反抗」', (chk.summary || '').slice(0, 80));
  ok(/自动命中/.test(chk.summary || ''), '⑧ 公开记录含「自动命中」');
  ok(!/请为.*输入 1–100/.test(allText(out)), '⑧ 勾选无法反抗 → 不再要求填怪物对抗值');
  eq(order[0].public.hp, 16, '⑧ 自动命中 → 怪物扣 4 点血（20→16）');
  ok(!/未分 胜/.test(chk.summary || ''), '⑧ 结论不是「未分 胜」（winner 已补）');

  /* 攻击检定失败路径：_forceAutoHit 补掷伤害，仍自动命中 */
  var stub2 = scriptRules([{ outcome: 'miss', damage: { raw: 0, expr: '1D4', armor: 0, applied: 0 } }]);
  var order2 = [{ id: 'a1', actorId: 'm1', name: '食尸鬼', kind: 'monster', public: { hp: 20, hpMax: 20 } }];
  var host2 = new M.Host({ rules: stub2.rules, rng: feeder([0.3, 0.0]), now: function () { return 1000; } });
  host2.roster.open({ seat: 's1', role: M.ROLE.PLAYER, nickname: '小美' });
  var mem2 = host2.roster.get('s1');
  mem2.charName = '小美';
  mem2.sheet = {
    name: '小美', attrs: { str: 60 }, status: { currentHP: 12, maxHP: 12, currentSAN: 50, maxSAN: 50 },
    skills: [{ name: '格斗（斗殴）', total: 60 }],
    weapons: [{ name: '匕首', skill: '斗殴', damage: '1D4', pierce: '×', perRound: '1' }],
    madness: [], mental: ['正常'], db: '0'
  };
  host2.state.combat = { order: order2, turn: 0, round: 1, startedAt: 0 };
  /* v2.6.0（用户第 3 项）：玩家发起武器对抗需在其行动轮次。以下是引导测试 fixture，有的只放了怪物槽 —— 若当前行动槽不是 s1 的 PC 槽，补一个并把 turn 指向它。 */
  var _cur = host2.state.combat.order[host2.state.combat.turn];
  if (!_cur || _cur.kind !== 'pc' || _cur.seat !== 's1') {
    host2.state.combat.order.push({ id: 's1#0', actorId: 's1', seat: 's1', kind: 'pc', name: '小美', public: { hp: 12, hpMax: 12 } });
    host2.state.combat.turn = host2.state.combat.order.length - 1;
  }
  host2.state.meta.status = M.STATUS.IN_GAME;
  host2.state.meta.mode = M.MODE.COMBAT;
  host2.intent('s1', { op: M.INTENT.OPPOSED, p: {
    phase: 'request', weapon: { name: '匕首' }, db: '0', targetId: 'm1', targetName: '食尸鬼', shots: 1
  } });
  var out2 = host2.checkOpposed('host', { attack: true, reqId: host2.state.opposed.id,
    noDefense: true, defender: { reaction: 'none', value: 0 }, armor: { value: 0 } });
  var chk2 = picks(out2, M.EVT.CHECK)[0] || {};
  ok(/自动命中/.test(chk2.summary || ''), '⑧ 攻击掷骰失败也记「自动命中」');
  ok(order2[0].public.hp < 20, '⑧ 攻击失败仍补掷伤害并扣血（hp=' + order2[0].public.hp + '）');
  var dmg2 = chk2.damage || {};
  ok(dmg2.applied > 0, '⑧ 补掷伤害 applied>0', JSON.stringify(dmg2));
})();

/* ============================================================
 * ⑨ 连发逐发串行判定
 * ============================================================ */
section('⑨ 连发逐发串行');
(function () {
  /* 第 1 发命中掉血；第 2 发命中但 0 伤害（护甲吸收）→ 中断，第 3 发不再判 */
  var stub = scriptRules([
    { outcome: 'attacker_wins', damage: { raw: 5, expr: '1D8', armor: 0, applied: 5, impale: false },
      compare: { winner: 'a', decidedBy: 'level', rounds: [] } },
    { outcome: 'attacker_wins', damage: { raw: 1, expr: '1D8', armor: 2, applied: 0, impale: false },
      compare: { winner: 'a', decidedBy: 'level', rounds: [] } },
    { outcome: 'attacker_wins', damage: { raw: 5, expr: '1D8', armor: 0, applied: 5, impale: false },
      compare: { winner: 'a', decidedBy: 'level', rounds: [] } }
  ]);
  var order = [{ id: 'a1', actorId: 'm1', name: '食尸鬼', kind: 'monster', public: { hp: 20, hpMax: 20 } }];
  var host = new M.Host({ rules: stub.rules, rng: feeder([0.3, 0.0]), now: function () { return 1000; } });
  host.roster.open({ seat: 's1', role: M.ROLE.PLAYER, nickname: '小美' });
  var mem = host.roster.get('s1');
  mem.charName = '小美';
  mem.sheet = {
    name: '小美', attrs: { str: 60 }, status: { currentHP: 12, maxHP: 12, currentSAN: 50, maxSAN: 50 },
    skills: [{ name: '射击（手枪）', total: 55 }],
    weapons: [{ name: 'MP18', skill: '射击', damage: '1D8', pierce: '', perRound: '1(3)',
                malfunction: '', ammo: '20' }],
    madness: [], mental: ['正常'], db: '0'
  };
  host.state.combat = { order: order, turn: 0, round: 1, startedAt: 0 };
  /* v2.6.0（用户第 3 项）：玩家发起武器对抗需在其行动轮次。以下是引导测试 fixture，有的只放了怪物槽 —— 若当前行动槽不是 s1 的 PC 槽，补一个并把 turn 指向它。 */
  var _cur = host.state.combat.order[host.state.combat.turn];
  if (!_cur || _cur.kind !== 'pc' || _cur.seat !== 's1') {
    host.state.combat.order.push({ id: 's1#0', actorId: 's1', seat: 's1', kind: 'pc', name: '小美', public: { hp: 12, hpMax: 12 } });
    host.state.combat.turn = host.state.combat.order.length - 1;
  }
  host.state.meta.status = M.STATUS.IN_GAME;
  host.state.meta.mode = M.MODE.COMBAT;
  host.intent('s1', { op: M.INTENT.OPPOSED, p: {
    phase: 'request', weapon: { name: 'MP18' }, db: '0', targetId: 'm1', targetName: '食尸鬼', shots: 3
  } });
  var out = host.checkOpposed('host', { attack: true, reqId: host.state.opposed.id,
    defender: { reaction: 'dodge', value: 50 }, armor: { value: 0 } });
  eq(stub.calls.length, 2, '⑨ 逐发串行：第 2 发 0 伤害即中断（不判第 3 发）');
  eq(stub.calls[0].penalty, 0, '⑨ 第 1 发惩罚骰 +0');
  eq(stub.calls[1].penalty, 1, '⑨ 第 2 发惩罚骰 +1（k-1）');
  var chks = picks(out, M.EVT.CHECK);
  eq(chks.length, 2, '⑨ 每发逐条公开记录（2 条 CHECK）');
  ok(/本轮已发射 0\/3，本次 3 发，惩罚骰 \+2/.test(chks[0].summary || ''),
     '⑨ 首条记录含连发总览（兼容 v2.3.0 文案）', (chks[0].summary || '').slice(0, 120));
  ok(/第 1\/3 发/.test(chks[0].summary || ''), '⑨ 首条记录标「第 1/3 发」');
  ok(/第 2\/3 发/.test(chks[1].summary || ''), '⑨ 第二条记录标「第 2/3 发」');
  ok(anyPubLog(out, /第 2 发未造成伤害，连发中断（共打出 2\/3 发）/),
     '⑨ 中断原因写公开记录（第 2 发未造成伤害，共打出 2/3）');
  eq(order[0].public.hp, 15, '⑨ 只结算实际打出的 2 发中第 1 发的 5 点伤害（20→15）');
  eq(host._fireUsed['s1\u0000MP18'], 2, '⑨ _fireUsed 按实际打出数记账（2，非计划 3）');
  eq(host.state.opposed, null, '⑨ 结算后待办清空');

  /* 惩罚骰上限 MOD_CAP=5：本轮已发射 4，再打 3 发 → +4/+5/+5 */
  var stub2 = scriptRules([
    { outcome: 'attacker_wins', damage: { raw: 5, expr: '1D8', armor: 0, applied: 5, impale: false },
      compare: { winner: 'a', decidedBy: 'level', rounds: [] } },
    { outcome: 'attacker_wins', damage: { raw: 5, expr: '1D8', armor: 0, applied: 5, impale: false },
      compare: { winner: 'a', decidedBy: 'level', rounds: [] } },
    { outcome: 'attacker_wins', damage: { raw: 5, expr: '1D8', armor: 0, applied: 5, impale: false },
      compare: { winner: 'a', decidedBy: 'level', rounds: [] } }
  ]);
  var order2 = [{ id: 'a1', actorId: 'm1', name: '食尸鬼', kind: 'monster', public: { hp: 40, hpMax: 40 } }];
  var host2 = new M.Host({ rules: stub2.rules, rng: feeder([0.3, 0.0]), now: function () { return 1000; } });
  host2.roster.open({ seat: 's1', role: M.ROLE.PLAYER, nickname: '小美' });
  var mem2 = host2.roster.get('s1');
  mem2.charName = '小美';
  mem2.sheet = {
    name: '小美', attrs: { str: 60 }, status: { currentHP: 12, maxHP: 12, currentSAN: 50, maxSAN: 50 },
    skills: [{ name: '射击（手枪）', total: 55 }],
    weapons: [{ name: 'MP18', skill: '射击', damage: '1D8', pierce: '', perRound: '1(3)',
                malfunction: '', ammo: '20' }],
    madness: [], mental: ['正常'], db: '0'
  };
  host2.state.combat = { order: order2, turn: 0, round: 1, startedAt: 0 };
  /* v2.6.0（用户第 3 项）：玩家发起武器对抗需在其行动轮次。以下是引导测试 fixture，有的只放了怪物槽 —— 若当前行动槽不是 s1 的 PC 槽，补一个并把 turn 指向它。 */
  var _cur = host2.state.combat.order[host2.state.combat.turn];
  if (!_cur || _cur.kind !== 'pc' || _cur.seat !== 's1') {
    host2.state.combat.order.push({ id: 's1#0', actorId: 's1', seat: 's1', kind: 'pc', name: '小美', public: { hp: 12, hpMax: 12 } });
    host2.state.combat.turn = host2.state.combat.order.length - 1;
  }
  host2.state.meta.status = M.STATUS.IN_GAME;
  host2.state.meta.mode = M.MODE.COMBAT;
  host2._fireUsed['s1\u0000MP18'] = 4;    // 本轮已发射 4
  host2.intent('s1', { op: M.INTENT.OPPOSED, p: {
    phase: 'request', weapon: { name: 'MP18' }, db: '0', targetId: 'm1', targetName: '食尸鬼', shots: 3
  } });
  host2.checkOpposed('host', { attack: true, reqId: host2.state.opposed.id,
    defender: { reaction: 'dodge', value: 50 }, armor: { value: 0 } });
  eq(stub2.calls.length, 3, '⑨ 上限用例：3 发全部打出（每发都造成伤害）');
  eq(stub2.calls.map(function (c) { return c.penalty; }).join(','), '4,5,5',
     '⑨ 惩罚骰 = (k-1)+已发射，上限 MOD_CAP=5 → +4/+5/+5');
  eq(host2._fireUsed['s1\u0000MP18'], 7, '⑨ 记账 4+3=7');

  /* 第 1 发就未命中 → 立即中断 */
  var stub3 = scriptRules([{ outcome: 'miss', damage: { raw: 0, expr: '1D8', armor: 0, applied: 0 } }]);
  var order3 = [{ id: 'a1', actorId: 'm1', name: '食尸鬼', kind: 'monster', public: { hp: 20, hpMax: 20 } }];
  var host3 = new M.Host({ rules: stub3.rules, rng: feeder([0.3, 0.0]), now: function () { return 1000; } });
  host3.roster.open({ seat: 's1', role: M.ROLE.PLAYER, nickname: '小美' });
  var mem3 = host3.roster.get('s1');
  mem3.charName = '小美';
  mem3.sheet = {
    name: '小美', attrs: { str: 60 }, status: { currentHP: 12, maxHP: 12, currentSAN: 50, maxSAN: 50 },
    skills: [{ name: '射击（手枪）', total: 55 }],
    weapons: [{ name: 'MP18', skill: '射击', damage: '1D8', pierce: '', perRound: '1(3)',
                malfunction: '', ammo: '20' }],
    madness: [], mental: ['正常'], db: '0'
  };
  host3.state.combat = { order: order3, turn: 0, round: 1, startedAt: 0 };
  /* v2.6.0（用户第 3 项）：玩家发起武器对抗需在其行动轮次。以下是引导测试 fixture，有的只放了怪物槽 —— 若当前行动槽不是 s1 的 PC 槽，补一个并把 turn 指向它。 */
  var _cur = host3.state.combat.order[host3.state.combat.turn];
  if (!_cur || _cur.kind !== 'pc' || _cur.seat !== 's1') {
    host3.state.combat.order.push({ id: 's1#0', actorId: 's1', seat: 's1', kind: 'pc', name: '小美', public: { hp: 12, hpMax: 12 } });
    host3.state.combat.turn = host3.state.combat.order.length - 1;
  }
  host3.state.meta.status = M.STATUS.IN_GAME;
  host3.state.meta.mode = M.MODE.COMBAT;
  host3.intent('s1', { op: M.INTENT.OPPOSED, p: {
    phase: 'request', weapon: { name: 'MP18' }, db: '0', targetId: 'm1', targetName: '食尸鬼', shots: 3
  } });
  var out3 = host3.checkOpposed('host', { attack: true, reqId: host3.state.opposed.id,
    defender: { reaction: 'dodge', value: 50 }, armor: { value: 0 } });
  eq(stub3.calls.length, 1, '⑨ 第 1 发未命中 → 立即中断（只判 1 发）');
  ok(anyPubLog(out3, /第 1 发未命中，连发中断（共打出 1\/3 发）/), '⑨ 中断原因公开记录');
  eq(order3[0].public.hp, 20, '⑨ 未命中 → 怪物不掉血');
})();

/* ============================================================
 * ⑦ 结团回写本机临时卡（静态证据链）
 * ============================================================ */
section('⑦ 结团回写临时卡（静态）');
(function () {
  var rp = readSrc('ui/room-panels.js');
  var rui = readSrc('ui/room-ui.js');
  ok(/function commitRoomTempCards\(roomCode\)/.test(rp), 'room-panels：commitRoomTempCards 助手存在');
  ok(/RS\.commitTempCard\(rec\.roomCode, rec\.charId\)/.test(rp), '回写走 RoomStore.commitTempCard（upsert 覆盖原卡）');
  ok(/rec\.roomCode !== String\(roomCode\)/.test(rp), '只结「本房间」的临时卡（roomCode 精确匹配）');
  var endSessionSrc = (rp.match(/function endSession\(ctx\) \{[\s\S]*?\n  \}/) || [''])[0];
  ok(endSessionSrc.indexOf('commitRoomTempCards') >= 0 &&
     endSessionSrc.indexOf('commitRoomTempCards') < endSessionSrc.indexOf("session.end"),
     'endSession：回写发生在 session.end（房间关闭）之前');
  ok(/commitRoomTempCards: commitRoomTempCards/.test(rp), 'commitRoomTempCards 已导出（RoomPanels）');
  ok(/var tc = \(RP && RP\.commitRoomTempCards\) \? RP\.commitRoomTempCards\(sess\.code\)/.test(rui),
     'maybeDissolved：玩家收到结团广播 → 回首页前回写本机临时卡');
  ok(/var tc = \(RP && RP\.commitRoomTempCards\) \? RP\.commitRoomTempCards\(sess\.code\)[\s\S]{0,400}?S\.archive/.test(rui),
     'closeRoomConfirm：KP 关房 → 归档前回写本机临时卡');
})();

/* ============================================================
 * ② 手绘板：实时绘制 + 橡皮擦段级删除（静态证据链）
 * ============================================================ */
section('② 手绘板实时绘制 / 段级擦除（静态）');
(function () {
  var rp = readSrc('ui/room-panels.js');
  ok(/function bindDraw\(hostEl, onDone, live\)/.test(rp), 'bindDraw 支持实时预览参数（live）');
  ok(/vector-effect': 'non-scaling-stroke'/.test(rp), '实时预览 path 用 non-scaling-stroke（线宽不随 viewBox 缩放）');
  ok(/function liveMove\(p\) \{[\s\S]*?liveD \+= ' M'/.test(rp), 'pointermove 增量补线段（liveMove）');
  ok(/liveEnd\(\);[\s\S]*?var out = pts\.slice\(0, 400\)/.test(rp), '收尾时移除预览叠加层再提交');
  ok(/var ERASE_TOL_PX = 2;/.test(rp), '擦除容差 2px');
  ok(/var ERASE_MIN_PX = 3;/.test(rp), '累积 <3px 子笔丢弃阈值');
  /* v2.5.0（用户第 6 项）：容差改为**入参**（缺省仍是 ERASE_TOL_PX，单点轻点行为不变），
     连续擦除手势传 ERASE_TOL_DRAG_PX=10 —— 2px 套不住 pointermove 的稀疏采样点。 */
  ok(/function eraseStrokeSegments\(strokes, px, py, rect, tolPx\)/.test(rp), '段级拆分 helper（eraseStrokeSegments，含容差入参）');
  ok(/var tol = \(typeof tolPx === 'number' && tolPx > 0\) \? tolPx : ERASE_TOL_PX;/.test(rp),
     '容差入参缺省回落到 ERASE_TOL_PX（单点行为不回归）');
  ok(/if \(distSegPx\(px, py, a\.x, a\.y, b\.x, b\.y\) <= tol\) \{ flush\(\); continue; \}/.test(rp),
     '命中段断开（只删被命中的线段，两侧保留）');
  ok(/runLen >= ERASE_MIN_PX/.test(rp), '保留条件含累积长度 ≥ 3px');
  /* v2.5.0（用户第 6 项）：eraseAt / eraseBoardAt 由「擦一个点」升级为
     「一次划过手势结束时的整集提交」——手势期间只改本地 working 副本 + 本地重绘，
     绝不在 move 里 ctx.act（刷屏 + 撞限流）。 */
  ok(/function eraseAt\(ctx, keep, strokes\)/.test(rp) && /function eraseBoardAt\(ctx, keep, strokes\)/.test(rp),
     'eraseAt / eraseBoardAt 改为手势末尾整集提交（keep / strokes 双参）');
  ok(/if \(strokesEqual\(keep, strokes\)\) return;/.test(rp), '没擦到 → 不上报（避免无谓广播）');
  ok(/ctx\.intent\(M\.INTENT\.BOARD, \{ strokes: keep \}\)/.test(rp), '玩家板：笔画集合整体替换上报');
  ok(/\}, \{ color: UI_STATE\.tool\.color, width: 1\.4 \}\);/.test(rp), 'KP 地图 bindDraw 传入实时预览配色');
})();

/* ============================================================
 * ③ 锁屏开屏重连竞态（静态证据链）
 * ============================================================ */
section('③ 重连竞态防护（静态）');
(function () {
  var rn = readSrc('core/room-net.js');
  var rui = readSrc('ui/room-ui.js');
  ok(/connSeq: 0/.test(rn), 'room-net：link 增加连接代号 connSeq');
  ok(/var myConn = \+\+link\.connSeq;/.test(rn), '每次 open() 生成本连接代号');
  ok(/sock\.onclose = function \(ev\) \{[\s\S]{0,220}?if \(myConn !== link\.connSeq\) return;/.test(rn),
     '陈旧连接的迟到 onclose 被忽略（不误杀新连接）');
  ok(/sock\.onopen = function \(\) \{[\s\S]{0,240}?if \(myConn !== link\.connSeq\)/.test(rn),
     '陈旧 socket 迟到打开 → 静默退场');
  ok(/link\.refresh = function \(\) \{[\s\S]*?link\.connSeq \+= 1;[\s\S]*?old\.close\(1000, 'refresh'\)/.test(rn),
     'link.refresh：主动换线（先废旧代号再关旧开新）');
  ok(/var _hiddenAt = 0;/.test(rui) && /away > 10000/.test(rui),
     'room-ui：visibilitychange 记录停流时长，>10s 才主动换线');
  ok(/lk && lk\.refresh/.test(rui), 'room-ui：回前台调 link.refresh（锁屏场景）');
  ok(/sess\._hostGone = true;/.test(rui) && /if \(sess && sess\._hostGone\) \{ sess\._hostGone = false; setBanner\(sess, ''\); \}/.test(rui),
     'room-ui：host-gone 后收到任何流量 → 清「等待房主重连」横幅');
})();

/* ============================================================
 * ⑩ 奖惩骰 stepper 选项式（静态证据链）
 * ============================================================ */
section('⑩ 奖惩骰选项式 stepper（静态）');
(function () {
  var rp = readSrc('ui/room-panels.js');
  var diceBarSrc = (rp.match(/function diceBar\(ctx\) \{[\s\S]*?\n  \}/) || [''])[0];
  ok(/var MOD_MAX = 5;/.test(diceBarSrc), '奖惩骰上限常量 MOD_MAX=5');
  ok(/chip\.bonus/.test(diceBarSrc) && /奖励骰/.test(diceBarSrc), '「奖励骰」独立chip（奖/惩分离）');
  ok(/chip\.penalty/.test(diceBarSrc) && /惩罚骰/.test(diceBarSrc), '「惩罚骰」独立chip');
  ok(/if \(next < 0\) next = 0;/.test(diceBarSrc), '0 以下不允许：静默夹到 0');
  ok(/最多 ' \+ MOD_MAX \+ ' 个/.test(diceBarSrc), '超上限 toast 提示（随当前侧文案）');
  ok(/var mode = \(bonus <= 0 && penalty > 0\) \? 'penalty' : 'bonus';/.test(diceBarSrc),
     '初始落在有值的那一侧（不复用旧的正负同一颗数）');
  ok(!/bonusBtn|penaltyBtn/.test(diceBarSrc), '旧「各自只增不减的计数器」实现已移除');
})();

/* ============================================================
 * ⑫ 场景检定：删「检定类型」下拉 + 结果广播 PUBLIC
 * ============================================================ */
section('⑫ 场景检定删下拉 + PUBLIC 广播');
(function () {
  var rp = readSrc('ui/room-panels.js');
  var hits = (rp.match(/检定类型/g) || []).length;
  eq(hits, 2, 'room-panels 中「检定类型」只剩两处注释说明（下拉已删）');
  ok(/secret: false\s*\n/.test(rp), '场景检定掷骰恒为明骰（secret:false，不继承暗骰开关）');

  /* 行为：sceneCheckStep 的裁定记录走 VIS.PUBLIC（to='*' 广播） */
  var h = mkHost({});
  h.host.state.sceneCheck = {
    id: 'sc1', title: '测试场景', desc: '', cursor: 0, results: [], at: 1000,
    steps: [{ id: 'st1', title: '摸尸体', skill: '侦查', targetSeat: 's1', difficulty: 'regular' }]
  };
  var out = h.host.intent('host', { op: M.INTENT.ACT, p: {
    op: 'scene.check.step', stepId: 'st1', seat: 's1', level: 2
  } });
  ok(picks(out, M.EVT.SCENE_CHECK).length >= 1, 'sceneCheckStep 发出 EVT.SCENE_CHECK');
  ok(hasPublicStep(out, M.EVT.SCENE_CHECK) || hasPublicStep(out, M.EVT.LOG),
     '场景检定结果为公开广播（to=*，VIS.PUBLIC）');
})();

/* ============================================================
 * ⑬ KP 视角删「物品道具」入口（静态）
 * ============================================================ */
section('⑬ KP 删物品道具入口（静态）');
(function () {
  var rp = readSrc('ui/room-panels.js');
  ok(/\['🎒 物品道具', function \(\) \{ itemsSheet\(ctx\); \}, 'pl'\]/.test(rp),
     'diceBar 扩展组「物品道具」标记为仅玩家（pl）');
  ok(/if \(p\[2\] === 'pl' && ctx\.role !== 'player'\) return;/.test(rp),
     '渲染时按角色过滤（KP 看不到该按钮）');
  ok(/toolBtn\('🎒 给物品'/.test(rp), 'KP 发放入口「🎒 给物品」保留（KP→玩家指令，不受影响）');
  ok(/\['🎒 物品道具', function \(\) \{ itemsSheet\(ctx\); \}\]/.test(rp),
     '玩家底部工具条（plBottomBar）保留物品道具');
})();

/* ============================================================
 * ① 加入房间后展示房规摘要（静态证据链）
 * ============================================================ */
section('① 房规摘要（静态）');
(function () {
  var rui = readSrc('ui/room-ui.js');
  ok(/function roomRulesSummaryText\(meta\)/.test(rui), 'roomRulesSummaryText 助手存在');
  ok(/大成功 ' \+ critTxt/.test(rui) && /大失败 ' \+ fumTxt/.test(rui), '摘要含大成功/大失败阈值');
  ok(/≤ 1（默认）/.test(rui) && /≥ 100（默认）/.test(rui), 'meta 缺字段 → 显示默认口径');
  ok(/sess\._rulesShown = true;/.test(rui) && /roomRulesSummaryText\(metaNow\)/.test(rui),
     '加入后首次 online 时 toast 房规摘要（每会话一次）');
  ok(/if \(sess\.role !== 'kp' && !sess\._rulesShown\)/.test(rui), '仅加入方弹（KP 自己是定规人）');
})();

console.log('\nv2.4.0 fixes selftest: ' + pass + ' passed, ' + fail + ' failed');
console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exit(fail ? 1 : 0);
