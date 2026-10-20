/*
 * v2.2.1 缺陷修复自测（用户实测 8 项中可自动化的部分）
 *   ②2a 对抗记录用昵称/角色名/怪物名（不泄漏 seat/actorId）
 *   ②2b 对抗裁定失败 → 公共记录非空（不静默）
 *   ②2c 怪物真实掉血（actorId 缺省 / 多怪选目标 / 无 public.hp 三种路径）
 *   ⑥   治愈只治不定疯狂；临时疯狂自动随症状消退
 *   ⑧   本机权威房间号解析（RoomUI.authoritativeCode）
 *   P2-1 advanceMadness 兼容字符串 mental（旧存档不崩，语义与数组路径一致）
 *
 * 运行： node tools/test_v221_fixes.js（工作目录 = 仓库根）
 */
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');
var base = 'web/js/';

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? ('  \u2192 ' + extra) : '')); }
}
function eq(a, b, name) { ok(name, a === b, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }

function mkSandbox(files) {
  var sb = {};
  vm.createContext(sb); sb.window = sb;
  files.forEach(function (f) { vm.runInContext(fs.readFileSync(path.join(base, f), 'utf8'), sb); });
  return sb;
}

/* ============================================================
 * 模型侧：②2a / ②2b / ②2c / ⑥
 * ============================================================ */
var sbM = mkSandbox(['core/room-rules.js', 'core/room-model.js']);
var M = sbM.RoomModel, R = sbM.CocRules;
function feeder(seq) { var i = 0; return function () { return seq[i++ % seq.length]; }; }
var rng30 = feeder([0.3, 0.0]);

function mkHost(order) {
  var host = new M.Host({ rules: R, rng: rng30, now: function () { return 1000; } });
  host.roster.open({ seat: 's1', role: M.ROLE.PLAYER, nickname: '小美' });
  var mem = host.roster.get('s1');
  mem.charName = '小美';
  mem.runtime = mem.runtime || {};
  mem.sheet = {
    name: '小美', attrs: { str: 60 }, status: { currentHP: 12, maxHP: 12, currentSAN: 50, maxSAN: 50 },
    skills: [{ name: '格斗', total: 60 }, { name: '侦查', total: 55 }, { name: '闪避', total: 50 }],
    weapons: [{ name: '匕首', skill: '格斗', damage: '1D4', pierce: '\u00d7' }],
    madness: [], mental: ['正常'], db: '0'
  };
  /* v2.6.0（用户第 3 项）：玩家发起对抗须在其行动轮次 —— 追加当前 PC 槽并把 turn 指向它。 */
  var _o = (order || []).concat([{ id: 's1#0', actorId: 's1', seat: 's1', kind: 'pc', name: '小美', public: { hp: 12, hpMax: 12 } }]);
  host.state.combat = { order: _o, turn: _o.length - 1, round: 1, startedAt: 0 };
  return { host: host, mem: mem };
}
function picks(out, t) {
  var arr = [];
  (out || []).forEach(function (r) { if (r && r.msg && r.msg.t === t) arr.push(r.msg.p || {}); });
  return arr;
}
function anySys(out, re) {
  return (out || []).some(function (r) {
    return r && r.msg && (r.msg.t === M.EVT.PRIVATE || r.msg.t === M.EVT.LOG) &&
           re.test((r.msg.p && r.msg.p.text) || '');
  });
}

console.log('\n== ②2a 对抗记录用名字（UI 复合值 p:/a: 不得泄漏到记录）==');
(function () {
  var g = mkHost([{ id: 'm1', actorId: 'm1', kind: 'monster', name: '食尸鬼', public: { hp: 10, hpMax: 10 } }]);
  var out = g.host.checkOpposed('host', { aSeat: 'p:s1', aSkill: '格斗', bSeat: 'a:m1', bSkill: '觉察' });
  var chk = picks(out, M.EVT.CHECK)[0] || {};
  eq(chk.a && chk.a.name, '小美·格斗', '甲方名字=角色名·技能（无 p: 前缀）');
  eq(chk.b && chk.b.name, '食尸鬼·觉察', '乙方名字=怪物名·技能（无 a: 前缀）');
  ok(!/p:|a:m1/.test(chk.summary || ''), 'summary 不含内部 id 前缀', chk.summary);
})();

console.log('\n== ②2a _nick 退化：无昵称时用角色名 ==');
(function () {
  var h = mkHost([]);
  h.mem.nickname = '';
  h.mem.charName = '阿强';
  eq(h.host._nick(h.mem, 's1'), '阿强', '无昵称 → 角色名');
  h.mem.nickname = '';
  h.mem.charName = '';
  eq(h.host._nick(h.mem, 's1'), '某人', '都空 → 兜底「某人」');
})();

console.log('\n== ②2b 裁定失败 → 公共记录非空（不静默）==');
(function () {
  var c = mkHost([{ id: 'm1', actorId: 'm1', kind: 'monster', name: '食尸鬼', public: { hp: 10, hpMax: 10 } }]);
  c.host.intent('s1', { op: M.INTENT.OPPOSED, p: { phase: 'request', weapon: { name: '匕首' }, targetId: 'm1' } });
  var rid = c.host.state.opposed.id;
  c.host.state.combat.order = [];   // 目标从战斗里消失
  var out = c.host.checkOpposed('host', { attack: true, reqId: rid, defender: { reaction: 'dodge', value: 60 }, armor: { value: 0 } });
  var pub = (out || []).filter(function (r) {
    return r && r.msg && r.msg.t === M.EVT.LOG && /⚔ 对抗｜（未结算）/.test((r.msg.p && r.msg.p.text) || '');
  });
  ok(pub.length >= 1, '失败写入公共记录（⚔ 对抗｜（未结算）…）', JSON.stringify(pub));
  ok((out || []).some(function (r) { return r && r.to === 's1' && r.msg && r.msg.t === M.EVT.PRIVATE; }),
     '失败也私密提示了发起玩家');
  ok(c.host.state.opposed === null, '待办已核销（不再卡住）');
})();

console.log('\n== ②2c 怪物真实掉血 ==');
(function () {
  // D1：KP 直接发起，怪物 actorId 缺省（旧客户端/手填）→ 按名字回填
  var d = mkHost([{ id: 'm1', actorId: 'm1', kind: 'monster', name: '食尸鬼', public: { hp: 10, hpMax: 10 } }]);
  d.host.checkOpposed('host', { attack: true,
    attacker: { side: 'pc', seat: 's1', skill: '格斗' },
    defender: { side: 'monster', name: '食尸鬼', skill: '闪避', value: 20, reaction: 'counter' },
    weapon: { name: '匕首', damage: '1D4', pierce: '\u00d7', db: '0' }, armor: { value: 0 } });
  ok(d.host.state.combat.order[0].public.hp < 10, 'D1 actorId 缺省 → 怪物掉血', d.host.state.combat.order[0].public.hp);

  // D2：玩家胜 + 多怪 → 选目标 → 掉血
  var m = mkHost([
    { id: 'm1', actorId: 'm1', kind: 'monster', name: '食尸鬼', public: { hp: 10, hpMax: 10 } },
    { id: 'm2', actorId: 'm2', kind: 'monster', name: '深潜者', public: { hp: 8, hpMax: 8 } }
  ]);
  m.host.intent('s1', { op: M.INTENT.OPPOSED, p: { phase: 'request', weapon: { name: '匕首' }, targetId: 'm1' } });
  m.host.checkOpposed('host', { attack: true, reqId: m.host.state.opposed.id, defender: { reaction: 'counter', value: 60 }, armor: { value: 0 } });
  ok(m.host.state.opposed && m.host.state.opposed.phase === 'await_target', '多怪 → 等选目标');
  var before = m.host.state.combat.order[1].public.hp;
  m.host.intent('s1', { op: M.INTENT.OPPOSED, p: { phase: 'target', targetId: 'm2' } });
  ok(m.host.state.combat.order[1].public.hp < before, 'D2 选怪后 m2 掉血', before + '→' + m.host.state.combat.order[1].public.hp);

  // D3：怪物槽缺 public.hp → 用 hpMax 兜底初始化后扣血
  var e = mkHost([{ id: 'm1', actorId: 'm1', kind: 'monster', name: '食尸鬼', public: { hpMax: 10 } }]);
  e.host.intent('s1', { op: M.INTENT.OPPOSED, p: { phase: 'request', weapon: { name: '匕首' }, targetId: 'm1' } });
  e.host.checkOpposed('host', { attack: true, reqId: e.host.state.opposed.id, defender: { reaction: 'counter', value: 60 }, armor: { value: 0 } });
  ok(e.host.state.combat.order[0].public.hp < 10 && e.host.state.combat.order[0].public.hp > 0,
     'D3 缺 public.hp → 用 hpMax 兜底扣血', e.host.state.combat.order[0].public.hp);

  // D4：找不到目标槽 → 明确提示（不再静默）
  var f = mkHost([{ id: 'm1', actorId: 'm1', kind: 'monster', name: '食尸鬼', public: { hp: 10, hpMax: 10 } }]);
  var outF = f.host._opposedDamageMonster('不存在', 5);
  ok(anySys(outF, /找不到目标战斗单位/), 'D4 目标槽找不到 → 给 KP 明确提示');
})();

console.log('\n== ⑥ 治愈只治不定疯狂；临时疯狂自动消退 ==');
(function () {
  var h = mkHost([]);
  // 只有临时疯狂 → 明确说明，不误报「没有不定疯狂」
  h.mem.sheet.mental = ['临时疯狂', '疯狂症状'];
  var out1 = h.host.cureIndefinite('host', { seat: 's1' });
  ok(anySys(out1, /临时疯狂不需要治愈/), '只有临时疯狂 → 明确文案', JSON.stringify(picks(out1, M.EVT.PRIVATE)));
  ok(h.mem.sheet.mental.indexOf('临时疯狂') >= 0, '临时疯狂标签未被误删');

  // 不定疯狂 → 可治愈
  h.mem.sheet.mental = ['不定疯狂'];
  var out2 = h.host.cureIndefinite('host', { seat: 's1' });
  ok(h.mem.sheet.mental.indexOf('不定疯狂') < 0, '不定疯狂被治愈（标签移除）');
  ok(h.mem.sheet.mental.indexOf('正常') >= 0, '治愈后回到「正常」');

  // 推进 1 轮：临时症状到期 → 临时疯狂标签自动消失
  var h2 = mkHost([]);
  h2.mem.sheet.madness = [{ name: '惊恐发作', rounds: 1, permanent: false, from: '临时疯狂' }];
  h2.mem.sheet.mental = ['临时疯狂', '疯狂症状'];
  h2.host.advanceMadness('host', { seat: 's1' });
  ok(h2.mem.sheet.madness.length === 0, '临时症状到期被移除');
  ok(h2.mem.sheet.mental.indexOf('临时疯狂') < 0, '临时疯狂标签自动消失');
  ok(h2.mem.sheet.mental.indexOf('疯狂症状') < 0, '派生项「疯狂症状」一并摘掉');
})();

console.log('\n== QA P2-1 加固：advanceMadness 兼容字符串 mental（旧存档）==');
(function () {
  // 字符串 mental='正常'：不崩，且归一后结果与数组一致
  var s = mkHost([]);
  s.mem.sheet.mental = '正常';
  var threw1 = false;
  try { s.host.advanceMadness('host', { seat: 's1' }); } catch (e) { threw1 = true; }
  ok(!threw1, '字符串 mental="正常" 不抛异常（不再 .filter 崩溃）');
  eq(JSON.stringify(s.mem.sheet.mental), JSON.stringify(['正常']), '字符串 → 归一后结果 = [正常]');

  // 字符串 mental='临时疯狂' + 到期症状：语义必须与数组路径完全一致
  var s2 = mkHost([]);
  s2.mem.sheet.madness = [{ name: '惊恐发作', rounds: 1, permanent: false, from: '临时疯狂' }];
  s2.mem.sheet.mental = '临时疯狂';
  s2.host.advanceMadness('host', { seat: 's1' });
  var a2 = mkHost([]);
  a2.mem.sheet.madness = [{ name: '惊恐发作', rounds: 1, permanent: false, from: '临时疯狂' }];
  a2.mem.sheet.mental = ['临时疯狂'];
  a2.host.advanceMadness('host', { seat: 's1' });
  eq(JSON.stringify(s2.mem.sheet.mental), JSON.stringify(a2.mem.sheet.mental),
     '字符串 mental 与数组路径结果一致（临时疯狂随症状消退）');

  // null / undefined → 默认值，不崩
  var s3 = mkHost([]);
  s3.mem.sheet.mental = null;
  var threw3 = false;
  try { s3.host.advanceMadness('host', { seat: 's1' }); } catch (e) { threw3 = true; }
  ok(!threw3, 'null mental 不抛异常');
  eq(JSON.stringify(s3.mem.sheet.mental), JSON.stringify(['正常']), 'null → 归默认后为 [正常]');
})();

/* ============================================================
 * UI 侧：⑧ 本机权威房间号
 * ============================================================ */
console.log('\n== ⑧ 本机权威房间号（RoomUI.authoritativeCode）==');
(function () {
  var sb = mkSandbox(['ui/room-ui.js']);
  var UI = sb.RoomUI;
  ok(UI && typeof UI.authoritativeCode === 'function', 'RoomUI.authoritativeCode 已导出');

  sb.RoomStore = { getMine: function () { return null; },
                   listJoined: function () { return [{ code: 'roomB', role: 'player', at: 200 }]; },
                   listUnfinished: function () { return []; } };
  eq(UI.authoritativeCode(), 'roomB', '仅 joined → 用 joined 的 code');

  sb.RoomStore = { getMine: function () { return { code: 'roomA', at: 300 }; },
                   listJoined: function () { return [{ code: 'roomB', role: 'player', at: 200 }]; },
                   listUnfinished: function () { return []; } };
  eq(UI.authoritativeCode(), 'roomA', 'mine 更新（at 更大）→ 用 mine 的 code');

  sb.RoomStore = { getMine: function () { return { code: 'roomA', at: 100 }; },
                   listJoined: function () { return [{ code: 'roomB', role: 'player', at: 500 }]; },
                   listUnfinished: function () { return []; } };
  eq(UI.authoritativeCode(), 'roomB', 'joined 更新（at 更大）→ 用 joined 的 code');

  sb.RoomStore = { getMine: function () { return null; },
                   listJoined: function () { return []; },
                   listUnfinished: function () { return []; } };
  eq(UI.authoritativeCode(), null, '本机无任何记录 → null（不瞎猜）');
})();

console.log('\nv2.2.1 fixes selftest: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
