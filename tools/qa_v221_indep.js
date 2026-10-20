/*
 * qa_v221_indep.js —— QA 严过关对 v2.2.1 八项修复的【独立】验证（不复用 test_v221_fixes.js）
 *
 * 设计：用**真实 Host 模型**（core/room-rules.js + core/room-model.js）构造场景，
 *       断言由本文件独立编写；关键项附带「证伪」尝试。
 * 覆盖：②2a / ②2b / ②2c / ⑥ / ⑧ / ⑤（⑤ 用注入式白盒钩子读真实闭包函数）。
 * 约定：ok(cond, name) 计分；obs(cond, name) 证伪观察，单独列出、不计入 PASS/FAIL。
 *
 * 运行： node tools/qa_v221_indep.js   （工作目录 = 仓库根）
 */
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');
var base = 'web/js/';
var pass = 0, fail = 0, FAILS = [];
var OBS = [];

function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; FAILS.push(name + (extra ? ('  -> ' + extra) : '')); console.log('  \u2717 ' + name + (extra ? ('  -> ' + extra) : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
function obs(cond, name, extra) {
  OBS.push({ name: name, ok: !!cond, detail: extra || '' });
  console.log('  [OBS] ' + (cond ? 'ok ' : 'XX ') + name + (extra ? ('  -> ' + extra) : ''));
}
function section(t) { console.log('\n== ' + t + ' =='); }

function mkSandbox(files) {
  var sb = {}; vm.createContext(sb); sb.window = sb;
  files.forEach(function (f) { vm.runInContext(fs.readFileSync(path.join(base, f), 'utf8'), sb); });
  return sb;
}

/* ---------------- 模型 sandbox ---------------- */
var sbM = mkSandbox(['core/room-rules.js', 'core/room-model.js']);
var M = sbM.RoomModel, R = sbM.CocRules;

function feeder(seq) { var i = 0; return function () { return seq[i++ % seq.length]; }; }
/* 恒定 0.1 → 所有检定掷 11：攻方 60 极难成功、守方 5 失败 → 攻方必胜且伤害可算。 */
var RNG_WIN = feeder([0.1]);

function mkHost(order, rngFn, memberOverride) {
  var host = new M.Host({ rules: R, rng: rngFn || RNG_WIN, now: function () { return 1000; } });
  host.roster.open({ seat: 's1', role: M.ROLE.PLAYER, nickname: '美美' });
  var mem = host.roster.get('s1');
  mem.charName = '小美';
  mem.runtime = mem.runtime || {};
  mem.sheet = {
    name: '小美', attrs: { str: 60 }, status: { currentHP: 12, maxHP: 12, currentSAN: 50, maxSAN: 50 },
    skills: [{ name: '格斗', total: 60 }, { name: '侦查', total: 55 }, { name: '闪避', total: 50 }],
    weapons: [{ name: '匕首', skill: '格斗', damage: '1D4', pierce: '\u00d7' }],
    madness: [], mental: ['正常'], db: '0'
  };
  if (memberOverride) memberOverride(host, mem);
  host.state.combat = { order: order || [], turn: 0, round: 1, startedAt: 0 };
  return { host: host, mem: mem };
}
function checks(out) {
  return (out || []).filter(function (r) { return r && r.msg && r.msg.t === 'check'; })
                    .map(function (r) { return r.msg.p; });
}
function logs(out) {
  return (out || []).filter(function (r) { return r && r.msg && r.msg.t === 'log'; })
                    .map(function (r) { return r.msg.p || {}; });
}
function privTo(out, seat) {
  return (out || []).filter(function (r) { return r && r.to === seat && r.msg && r.msg.t === 'private'; })
                    .map(function (r) { return r.msg.p || {}; });
}
function statesTo(out, seat) {
  return (out || []).filter(function (r) { return r && r.to === seat && r.msg && r.msg.t === 'state'; })
                    .map(function (r) { return r.msg.p || {}; });
}
function MON(name, extra) {
  extra = extra || {};
  var pub = extra.public !== undefined ? extra.public : { hp: 10, hpMax: 10 };
  return { id: extra.id || 'm1', actorId: extra.hasOwnProperty('actorId') ? extra.actorId : (extra.id || 'm1'),
           kind: 'monster', name: name, public: pub };
}

/* ============================================================
 * ②2a 对抗记录用角色名/昵称/怪物名（通用对抗入口剥前缀）
 * ============================================================ */
section('②2a 通用对抗：p:/a: 复合值不得退化成 id（名字侧）');
(function () {
  var g = mkHost([MON('食尸鬼')]);
  var out = g.host.checkOpposed('host', { aSeat: 'p:s1', aSkill: '格斗', bSeat: 'a:m1', bSkill: '觉察' });
  var chk = checks(out)[0] || {};
  eq(chk.a && chk.a.name, '小美·格斗', 'A 侧名字 = 角色名·技能（优先 charName）');
  eq(chk.b && chk.b.name, '食尸鬼·觉察', 'B 侧名字 = 怪物名·技能');
  ok(!/p:s1|a:m1/.test(chk.summary || ''), 'summary 不含复合前缀', chk.summary);
  ok(/小美·格斗/.test(chk.summary || '') && /食尸鬼·觉察/.test(chk.summary || ''), 'summary 用的是真名');
  /* 无昵称时退到 charName；都空退「未知单位」 */
  var h2 = mkHost([MON('食尸鬼')]);
  h2.mem.nickname = ''; h2.mem.charName = '';
  eq(h2.host._unitName(h2.mem, 's1'), '未知单位', 'charName 与 nickname 都空 → 未知单位');
  h2.mem.charName = '阿强'; h2.mem.nickname = '强强';
  eq(h2.host._unitName(h2.mem, 's1'), '阿强', 'charName 优先于 nickname');
  /* 证伪：查不到的 ref → 不得把 ref 当名字 */
  var u = h2.host._resolveActorSkill('a:不存在的怪', '格斗', 30);
  eq(u.name, '未知单位·格斗', '查不到的复合 ref → 未知单位（不把 id 当名字）');
  /* 无前缀向后兼容（旧调用方直接传 seat / actorId） */
  eq(g.host._resolveActorSkill('s1', '格斗', null).name, '小美·格斗', '无前缀 seat 仍可解析（向后兼容）');
  eq(g.host._resolveActorSkill('m1', '觉察', null).name, '食尸鬼·觉察', '无前缀 actorId 仍可解析（向后兼容）');
  /* 观察：载荷的 targets/ref 字段是否仍含复合值 */
  var raw = JSON.stringify(out);
  obs(!/p:s1|a:m1/.test(raw), '载荷全文不含复合值 p:s1/a:m1',
      /p:s1|a:m1/.test(raw) ? ('仍含: targets=' + JSON.stringify(chk.targets) +
        ' a.ref=' + JSON.stringify(chk.a && chk.a.ref) + ' b.ref=' + JSON.stringify(chk.b && chk.b.ref)) : 'clean');
})();

/* ============================================================
 * ②2b 裁定失败 → 公共记录必须新增「未结算」行 + 双向私密提示
 * ============================================================ */
section('②2b 裁定失败 → 公共记录不静默');
(function () {
  function mkRequest(reqFn) {
    var g = mkHost([MON('食尸鬼')]);
    g.host.intent('s1', { op: M.INTENT.OPPOSED, p: { phase: 'request', weapon: { name: '匕首' }, targetId: 'm1' } });
    var rid = g.host.state.opposed && g.host.state.opposed.id;
    reqFn(g);
    return { g: g, rid: rid };
  }
  /* 分支1：目标从战斗中消失 */
  var c1 = mkRequest(function (g) { g.host.state.combat.order = []; });
  var out1 = c1.g.host.checkOpposed('host', { attack: true, reqId: c1.rid, defender: { reaction: 'dodge', value: 60 }, armor: { value: 0 } });
  var pub1 = logs(out1).filter(function (p) { return /⚔ 对抗｜（未结算）/.test(p.text || ''); });
  eq(pub1.length, 1, '分支1(目标不在战斗) → 公共记录恰好 1 条未结算');
  ok(/不在战斗中/.test((pub1[0] || {}).text || ''), '未结算行含原因「不在战斗中」', (pub1[0] || {}).text);
  ok(privTo(out1, 'host').length >= 1, '分支1 → KP 收到私密提示');
  ok(privTo(out1, 's1').length >= 1, '分支1 → 发起玩家收到私密提示');
  eq(c1.g.host.state.opposed, null, '分支1 → 待办已核销');

  /* 分支2：目标已死亡 */
  var c2 = mkRequest(function (g) { g.host.state.combat.order[0].public.hp = 0; });
  var out2 = c2.g.host.checkOpposed('host', { attack: true, reqId: c2.rid, defender: { reaction: 'dodge', value: 60 }, armor: { value: 0 } });
  ok(logs(out2).some(function (p) { return /⚔ 对抗｜（未结算）/.test(p.text || '') && /死亡|离场/.test(p.text || ''); }),
     '分支2(目标已死亡) → 公共未结算行含「死亡/离场」');
  ok(privTo(out2, 's1').length >= 1, '分支2 → 发起玩家收到私密提示');

  /* 分支3：发起者人物卡里查不到武器技能 */
  var c3 = mkRequest(function (g) { g.mem.sheet.weapons = [{ name: '匕首', skill: '神秘武术', damage: '1D4' }]; });
  var out3 = c3.g.host.checkOpposed('host', { attack: true, reqId: c3.rid, defender: { reaction: 'dodge', value: 60 }, armor: { value: 0 } });
  ok(logs(out3).some(function (p) { return /⚔ 对抗｜（未结算）/.test(p.text || ''); }),
     '分支3(发起者技能查不到) → 公共未结算行');
  ok(privTo(out3, 's1').length >= 1, '分支3 → 发起玩家收到私密提示');

  ok(!privTo(out1, 's2').length, '未结算私密提示不得发给无关座位');

  /* 反例：合法值域外的守方值 → 只提示 KP、**不核销**（允许修正重试），不写「未结算」 */
  var c4 = mkRequest(function () {});
  var out4 = c4.g.host.checkOpposed('host', { attack: true, reqId: c4.rid, defender: { reaction: 'dodge', value: 999 }, armor: { value: 0 } });
  ok(privTo(out4, 'host').some(function (p) { return /1–100|1-100/.test(p.text || ''); }), '守方越界 → 私密提示 KP 输入 1–100');
  ok(c4.g.host.state.opposed !== null, '守方越界 → 待办**保留**（可修正重试，不误核销）');
})();

/* ============================================================
 * ②2c 怪物真实掉血（三条路径 + 名字回填 + hp 兜底 + 不静默）
 * ============================================================ */
section('②2c 怪物真实掉血');
(function () {
  /* 路径1：玩家申请 → KP 裁定 → 单怪自动结算 */
  var p1 = mkHost([MON('食尸鬼')]);
  p1.host.intent('s1', { op: M.INTENT.OPPOSED, p: { phase: 'request', weapon: { name: '匕首' }, targetId: 'm1' } });
  var before1 = p1.host.state.combat.order[0].public.hp;
  var out1 = p1.host.checkOpposed('host', { attack: true, reqId: p1.host.state.opposed.id, defender: { reaction: 'dodge', value: 5 }, armor: { value: 0 } });
  var after1 = p1.host.state.combat.order[0].public.hp;
  ok(after1 < before1, '路径1(申请→裁定→单怪自动结算) 怪物 HP 下降', before1 + '→' + after1);
  var chk1 = checks(out1).slice(-1)[0] || {};
  ok(chk1.damage && chk1.damage.applied > 0, '路径1 记录含 damage.applied>0', JSON.stringify(chk1.damage));
  ok(/实扣\s*\d+/.test(chk1.summary || ''), '路径1 summary 含实扣值', chk1.summary);

  /* 路径2：玩家申请 → 胜 → 多怪选目标 → 结算 */
  var p2 = mkHost([MON('食尸鬼', { id: 'm1' }), MON('深潜者', { id: 'm2', public: { hp: 8, hpMax: 8 } })]);
  p2.host.intent('s1', { op: M.INTENT.OPPOSED, p: { phase: 'request', weapon: { name: '匕首' }, targetId: 'm1' } });
  p2.host.checkOpposed('host', { attack: true, reqId: p2.host.state.opposed.id, defender: { reaction: 'dodge', value: 5 }, armor: { value: 0 } });
  ok(p2.host.state.opposed && p2.host.state.opposed.phase === 'await_target', '路径2 多怪 → 进入选目标');
  var b2 = p2.host.state.combat.order[1].public.hp;
  var out2 = p2.host.intent('s1', { op: M.INTENT.OPPOSED, p: { phase: 'target', targetId: 'm2' } });
  var a2 = p2.host.state.combat.order[1].public.hp;
  ok(a2 < b2, '路径2 选怪后 m2 掉血', b2 + '→' + a2);
  var chk2 = checks(out2).slice(-1)[0] || {};
  ok(/实扣\s*\d+/.test(chk2.summary || ''), '路径2 summary 含实扣值', chk2.summary);

  /* 路径3：KP 直接发起（attacker=pc, defender=monster，带 actorId） */
  var p3 = mkHost([MON('食尸鬼')]);
  var b3 = p3.host.state.combat.order[0].public.hp;
  p3.host.checkOpposed('host', { attack: true,
    attacker: { side: 'pc', seat: 's1', skill: '格斗' },
    defender: { side: 'monster', name: '食尸鬼', skill: '闪避', value: 5, reaction: 'dodge', actorId: 'm1' },
    weapon: { name: '匕首', damage: '1D4', pierce: '\u00d7', db: '0' }, armor: { value: 0 } });
  var a3 = p3.host.state.combat.order[0].public.hp;
  ok(a3 < b3, '路径3(KP 直接发起) 怪物 HP 下降', b3 + '→' + a3);

  /* 路径3b：monster 缺 actorId 但有名字 → 按名字回填槽位 → 仍掉血 */
  var p3b = mkHost([MON('食尸鬼', { actorId: undefined })]);
  var b3b = p3b.host.state.combat.order[0].public.hp;
  var side = p3b.host._resolveOpposedSide({ side: 'monster', name: '食尸鬼', value: 5, reaction: 'dodge' }, {});
  ok(side.ok && side.actorId === 'm1', '缺 actorId 的怪物按名字回填 actorId', JSON.stringify(side));
  p3b.host.checkOpposed('host', { attack: true,
    attacker: { side: 'pc', seat: 's1', skill: '格斗' },
    defender: { side: 'monster', name: '食尸鬼', skill: '闪避', value: 5, reaction: 'dodge' },
    weapon: { name: '匕首', damage: '1D4', pierce: '\u00d7', db: '0' }, armor: { value: 0 } });
  ok(p3b.host.state.combat.order[0].public.hp < b3b, '缺 actorId 路径 → 按名字命中并掉血', b3b + '→' + p3b.host.state.combat.order[0].public.hp);

  /* public.hp 缺失 → 用 hpMax 兜底初始化后扣血 */
  var p4 = mkHost([MON('食尸鬼', { public: { hpMax: 10 } })]);
  var out4 = p4.host._opposedDamageMonster('m1', 3);
  eq(p4.host.state.combat.order[0].public.hp, 7, '缺 public.hp → 用 hpMax(10) 初始化后扣 3 = 7');
  ok(out4.some(function (r) { return r.msg && r.msg.t === 'actor'; }), '扣血同时广播 EVT.ACTOR');

  /* 找不到槽位 → 明确提示（不再静默） */
  var p5 = mkHost([MON('食尸鬼')]);
  var out5 = p5.host._opposedDamageMonster('不存在', 5);
  ok(privTo(out5, 'host').some(function (p) { return /找不到目标战斗单位/.test(p.text || ''); }),
     '找不到目标槽 → 给 KP 明确提示（不静默）');
  eq(p5.host.state.combat.order[0].public.hp, 10, '找不到槽时其它怪不受影响');

  /* HP 归零 → down/dead */
  var p6 = mkHost([MON('食尸鬼')]);
  p6.host._opposedDamageMonster('m1', 99);
  ok(p6.host.state.combat.order[0].public.hp === 0 && p6.host.state.combat.order[0].public.down === true &&
     p6.host.state.combat.order[0].public.state === 'dead', 'HP 归零 → down=true / state=dead');

  /* _findCombatSlotByName 正/负样本 */
  ok(!!p6.host._findCombatSlotByName('食尸鬼'), '_findCombatSlotByName 命中');
  eq(p6.host._findCombatSlotByName('查无此怪'), null, '_findCombatSlotByName 未命中返回 null');
})();

/* ============================================================
 * ⑥ 治愈只治不定疯狂；临时疯狂随症状消退自动摘标签并经 EVT.STATE 写回
 * ============================================================ */
section('⑥ 治愈只治「不定疯狂」；临时疯狂自动消退');
(function () {
  /* (a) 临时 + 不定 → 治愈后只剩临时 */
  var h = mkHost([]);
  h.mem.sheet.mental = ['临时疯狂', '不定疯狂', '疯狂症状'];
  h.mem.sheet.madness = [
    { name: '惊恐发作', rounds: 3, permanent: false, from: '临时疯狂' },
    { name: '长期偏执', rounds: 0, permanent: true, from: '不定疯狂' }
  ];
  var outC = h.host.cureIndefinite('host', { seat: 's1' });
  ok(h.mem.sheet.mental.indexOf('不定疯狂') < 0, '治愈后「不定疯狂」标签移除');
  ok(h.mem.sheet.mental.indexOf('不定疯狂（症状消失）') < 0, '治愈后「不定疯狂（症状消失）」也移除');
  ok(h.mem.sheet.mental.indexOf('临时疯狂') >= 0, '治愈后「临时疯狂」标签**保留**');
  ok(statesTo(outC, 's1').length >= 1, '治愈经 EVT.STATE 写回玩家卡');

  /* (b) 临时症状全部消退 → 临时疯狂标签自动消失 + EVT.STATE 写回 */
  var h2 = mkHost([]);
  h2.mem.sheet.mental = ['临时疯狂', '疯狂症状'];
  h2.mem.sheet.madness = [{ name: '惊恐发作', rounds: 1, permanent: false, from: '临时疯狂' }];
  var outA = h2.host.advanceMadness('host', { seat: 's1' });
  eq(h2.mem.sheet.madness.length, 0, '推进 1 轮 → 临时症状到期移除');
  ok(h2.mem.sheet.mental.indexOf('临时疯狂') < 0, '临时症状清空 → 「临时疯狂」标签自动消失');
  ok(h2.mem.sheet.mental.indexOf('疯狂症状') < 0, '派生项「疯狂症状」一并摘掉');
  var stA = statesTo(outA, 's1');
  ok(stA.length >= 1 && stA[0].mental && stA[0].mental.indexOf('临时疯狂') < 0,
     'EVT.STATE 已把「无临时疯狂」的 mental 写回', JSON.stringify(stA[0] && stA[0].mental));

  /* (c) 只有临时疯狂 → 请求治愈被明确拒绝（不误报、不误删） */
  var h3 = mkHost([]);
  h3.mem.sheet.mental = ['临时疯狂', '疯狂症状'];
  var outR = h3.host.cureIndefinite('host', { seat: 's1' });
  ok(privTo(outR, 'host').some(function (p) { return /临时疯狂不需要治愈/.test(p.text || ''); }),
     '只有临时疯狂 → 明确文案「临时疯狂不需要治愈」');
  ok(h3.mem.sheet.mental.indexOf('临时疯狂') >= 0, '只有临时疯狂 → 不误删标签');

  /* (d) 不定疯狂症状消退 → 只摘症状、保留「不定疯狂（症状消失）」 */
  var h4 = mkHost([]);
  h4.mem.sheet.mental = ['不定疯狂', '疯狂症状'];
  h4.mem.sheet.madness = [{ name: '幻觉', rounds: 1, permanent: false, from: '不定疯狂' }];
  h4.host.advanceMadness('host', { seat: 's1' });
  ok(h4.mem.sheet.mental.indexOf('不定疯狂（症状消失）') >= 0,
     '不定疯狂症状消退 → 标签变「不定疯狂（症状消失）」（保留待治愈）', JSON.stringify(h4.mem.sheet.mental));

  /* 证伪 A：cureIndefinite 遇 mental=字符串 是否崩溃（团队指定项） */
  var h5 = mkHost([]);
  h5.mem.sheet.mental = '不定疯狂';
  try {
    var o5 = h5.host.cureIndefinite('host', { seat: 's1' });
    ok(true, '【证伪A】cureIndefinite 遇 mental=字符串 不崩溃（安全退化）');
    ok(privTo(o5, 'host').some(function (p) { return /没有「不定疯狂」/.test(p.text || ''); }),
       '【证伪A】mental=字符串 → 视作无不定疯狂并给提示');
  } catch (e) { ok(false, '【证伪A】cureIndefinite 遇 mental=字符串 崩溃', String(e && e.message)); }

  /* 证伪 B：advanceMadness 遇 mental=字符串 / null（旧数据）—— P2-1 修复后应不崩溃 */
  var h6 = mkHost([]);
  h6.mem.sheet.mental = '正常';
  h6.mem.sheet.madness = [{ name: 'x', rounds: 1, permanent: false, from: '临时疯狂' }];
  var crashedB = null;
  try { h6.host.advanceMadness('host', { seat: 's1' }); } catch (e) { crashedB = String(e && e.message); }
  ok(!crashedB, '【P2-1】advanceMadness 遇 mental=字符串 不崩溃', crashedB || 'no crash');
  ok(h6.mem.sheet.madness.length === 0 && h6.mem.sheet.mental.indexOf('临时疯狂') < 0,
     '【P2-1】字符串 mental + 临时症状到期 → 症状清空、无「临时疯狂」',
     JSON.stringify({ md: h6.mem.sheet.madness.length, mental: h6.mem.sheet.mental }));
  /* 字符串 '临时疯狂' + 症状到期 → 归一后照常摘标签 */
  var h7 = mkHost([]);
  h7.mem.sheet.mental = '临时疯狂';
  h7.mem.sheet.madness = [{ name: 'y', rounds: 1, permanent: false, from: '临时疯狂' }];
  var crashedC = null;
  try { h7.host.advanceMadness('host', { seat: 's1' }); } catch (e) { crashedC = String(e && e.message); }
  ok(!crashedC && h7.mem.sheet.mental.indexOf('临时疯狂') < 0,
     '【P2-1】字符串 mental="临时疯狂" → 归一后照常摘标签', JSON.stringify(h7.mem.sheet.mental));
  /* null → 归 [] 不崩溃 */
  var h8 = mkHost([]);
  h8.mem.sheet.mental = null;
  h8.mem.sheet.madness = [{ name: 'z', rounds: 1, permanent: false, from: '临时疯狂' }];
  var crashedD = null;
  try { h8.host.advanceMadness('host', { seat: 's1' }); } catch (e) { crashedD = String(e && e.message); }
  ok(!crashedD, '【P2-1】mental=null → 不崩溃（归 []）', crashedD || 'no crash');
  /* 数组路径语义回归：rounds=2 → 症状保留、临时疯狂标签保留 */
  var h9 = mkHost([]);
  h9.mem.sheet.mental = ['临时疯狂', '疯狂症状'];
  h9.mem.sheet.madness = [{ name: 'w', rounds: 2, permanent: false, from: '临时疯狂' }];
  h9.host.advanceMadness('host', { seat: 's1' });
  ok(h9.mem.sheet.madness.length === 1 && h9.mem.sheet.mental.indexOf('临时疯狂') >= 0,
     '【P2-1 回归】数组路径语义未变：rounds=2 → 症状与标签均保留',
     JSON.stringify({ md: h9.mem.sheet.madness.length, mental: h9.mem.sheet.mental }));
})();

/* ============================================================
 * ⑧ 本机权威房间号 authoritativeCode / authoritativeRoom
 * ============================================================ */
section('⑧ 本机权威房间号');
(function () {
  var sb = mkSandbox(['ui/room-ui.js']);
  var UI = sb.RoomUI;
  ok(UI && typeof UI.authoritativeCode === 'function', 'RoomUI.authoritativeCode 已导出');
  function setRS(mine, joined) {
    sb.RoomStore = { getMine: function () { return mine; }, listJoined: function () { return joined || []; },
                     listUnfinished: function () { return []; } };
  }
  setRS(null, [{ code: 'roomB', role: 'player', at: 200 }]);
  eq(UI.authoritativeCode(), 'roomB', '仅 joined → 取 joined.code');
  setRS({ code: 'roomA', at: 300 }, [{ code: 'roomB', role: 'player', at: 200 }]);
  eq(UI.authoritativeCode(), 'roomA', 'mine.at 更大 → 取 mine.code');
  setRS({ code: 'roomA', at: 100 }, [{ code: 'roomB', role: 'player', at: 500 }]);
  eq(UI.authoritativeCode(), 'roomB', 'joined.at 更大 → 取 joined.code');
  setRS(null, []);
  eq(UI.authoritativeCode(), null, '本机无记录 → null');
  /* 证伪：地址栏旧号必须被本机权威号覆盖（authoritativeCode 不看地址，只认本机/sess） */
  setRS({ code: 'roomNew', at: 900 }, []);
  eq(UI.authoritativeCode(), 'roomNew', '本机新记录优先（地址里旧号被覆盖）');
})();

/* ============================================================
 * ⑤ KP 待处理计数（注入式白盒钩子：读真实闭包函数）
 * ============================================================ */
section('⑤ KP 未读角标计数 kpPendingCount / kpQueueCount');
(function () {
  var src = fs.readFileSync(path.join(base, 'ui/room-ui.js'), 'utf8');
  var marker = '})(typeof window !== \'undefined\' ? window : this);';
  if (src.indexOf(marker) < 0) { ok(false, '⑤ 未能定位 room-ui.js IIFE 收尾（无法注入钩子）'); return; }
  var hook = '  global.__qaHook = {\n' +
    '    kpPendingCount: kpPendingCount, kpQueueCount: kpQueueCount,\n' +
    '    setSess: function (s) { sess = s; }\n' +
    '  };\n';
  var instrumented = src.replace(marker, hook + marker);
  var sb = {}; vm.createContext(sb); sb.window = sb;
  try { vm.runInContext(instrumented, sb); } catch (e) { ok(false, '⑤ 注入后沙箱加载失败', String(e && e.message)); return; }
  var H = sb.__qaHook;
  ok(H && typeof H.kpPendingCount === 'function' && typeof H.kpQueueCount === 'function', '⑤ 钩子取到真实闭包函数');
  H.setSess({ role: 'kp', host: { pending: [] } });
  eq(H.kpQueueCount(), 0, '空队列 → kpQueueCount=0');
  eq(H.kpPendingCount({ opposed: null }), 0, '无对抗无队列 → kpPendingCount=0');
  eq(H.kpPendingCount({ opposed: { phase: 'await_kp' } }), 1, 'await_kp 对抗申请 → 计 1');
  H.setSess({ role: 'kp', host: { pending: [{ need: 'kp' }, { need: 'twice' }, { need: 'owner' }, { need: 'all' }] } });
  eq(H.kpQueueCount(), 2, '队列 need=kp|twice 计 2，其余不计');
  eq(H.kpPendingCount({ opposed: { phase: 'await_kp' } }), 3, 'await_kp(1)+队列(2) → 3');
  H.setSess({ role: 'kp', host: { pending: [] } });
  eq(H.kpPendingCount({ opposed: { phase: 'resolved' } }), 0, '清空后（phase 非 await_kp）→ 0');
})();

/* ============================================================
 * E 证伪：对抗并发（同 reqId 二次裁定）只结算一次
 * ============================================================ */
section('E 证伪：同 reqId 二次裁定 → 只结算一次');
(function () {
  var g = mkHost([MON('食尸鬼')]);
  g.host.intent('s1', { op: M.INTENT.OPPOSED, p: { phase: 'request', weapon: { name: '匕首' }, targetId: 'm1' } });
  var rid = g.host.state.opposed.id;
  g.host.checkOpposed('host', { attack: true, reqId: rid, defender: { reaction: 'dodge', value: 5 }, armor: { value: 0 } });
  var hpAfter1 = g.host.state.combat.order[0].public.hp;
  var out2 = g.host.checkOpposed('host', { attack: true, reqId: rid, defender: { reaction: 'dodge', value: 5 }, armor: { value: 0 } });
  var hpAfter2 = g.host.state.combat.order[0].public.hp;
  eq(hpAfter2, hpAfter1, '二次裁定同一 reqId → HP 不再变化（幂等）');
  ok(privTo(out2, 'host').some(function (p) { return /已处理或不存在/.test(p.text || ''); }),
     '二次裁定 → 提示「已处理或不存在」');
})();

console.log('\n----------------------------------------');
console.log('qa_v221_indep.js: ' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('FAILED:'); FAILS.forEach(function (f) { console.log('  - ' + f); }); }
console.log('OBSERVATIONS (falsification, 不计入 PASS/FAIL):');
OBS.forEach(function (o) { console.log('  ' + (o.ok ? '[ok]' : '[XX]') + ' ' + o.name + (o.detail ? ('  -> ' + o.detail) : '')); });
process.exit(fail ? 1 : 0);
