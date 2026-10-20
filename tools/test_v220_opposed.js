/*
 * v2.2.0 T05 集成自测：玩家武器对抗 → KP 裁定 → 胜选怪 → 结算伤害 + 幂等/异常。
 * 运行： node tools/test_v220_opposed.js（工作目录 = 仓库根）
 * 用确定性 rng 驱动真实 Host（room-model.js + room-rules.js）。
 * ⚠️ Host.intent()/checkOpposed() 返回 [{to, msg}]，msg 形状为 {k:'evt', seq, t, p}。
 */
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');
var base = 'web/js/';
var sb = {};
vm.createContext(sb); sb.window = sb;
['core/room-rules.js', 'core/room-model.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(base, f), 'utf8'), sb);
});
var M = sb.RoomModel, R = sb.CocRules;

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? ('  \u2192 ' + extra) : '')); }
}
function feeder(seq) { var i = 0; return function () { return seq[i++ % seq.length]; }; }
var rng30 = feeder([0.3, 0.0]);   // D100 掷 30 → 常规成功（≤60）

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

function mkHost() {
  var host = new M.Host({ rules: R, rng: rng30, now: function () { return 1000; } });
  host.roster.open({ seat: 's1', role: M.ROLE.PLAYER, nickname: '小美' });
  var mem = host.roster.get('s1');
  mem.charName = '小美';
  mem.sheet = {
    name: '小美', attrs: { str: 60 }, status: { currentHP: 12, maxHP: 12 },
    skills: [{ name: '格斗', total: 60 }, { name: '闪避', total: 50 }],
    weapons: [{ name: '匕首', skill: '格斗', damage: '1D4', pierce: '\u00d7' }],
    db: '0'
  };
  host.state.combat = {
    order: [
      { id: 'm1', actorId: 'm1', kind: 'monster', name: '食尸鬼', public: { hp: 10, hpMax: 10 } },
      { id: 'm2', actorId: 'm2', kind: 'monster', name: '深潜者', public: { hp: 8, hpMax: 8 } },
      /* v2.6.0（用户第 3 项）：玩家发起对抗须在其行动轮次 —— 补当前 PC 槽，turn 指向它。 */
      { id: 's1#0', actorId: 's1', seat: 's1', kind: 'pc', name: '小美', public: { hp: 12, hpMax: 12 } }
    ],
    turn: 2, round: 1, startedAt: 0
  };
  return { host: host, mem: mem };
}

/* ① 玩家发起武器对抗 → 建待办 await_kp */
var a = mkHost();
var out1 = a.host.intent('s1', { op: M.INTENT.OPPOSED, p: {
  phase: 'request', weapon: { name: '匕首' }, db: '0', targetId: 'm1', note: ''
} });
ok('① 发起申请 → 建待办 await_kp', a.host.state.opposed && a.host.state.opposed.phase === 'await_kp',
  JSON.stringify(a.host.state.opposed));
ok('① 待办含武器/目标', a.host.state.opposed.weapon.name === '匕首' && a.host.state.opposed.targetId === 'm1');
var oppEvts1 = picks(out1, M.EVT.OPPOSED);
ok('① 发出 EVT.OPPOSED(await_kp) 给 KP', oppEvts1.length >= 1 && oppEvts1[0].phase === 'await_kp', JSON.stringify(oppEvts1));

/* ② 重复申请 → 拒绝（幂等） */
var out1b = a.host.intent('s1', { op: M.INTENT.OPPOSED, p: { phase: 'request', weapon: { name: '匕首' }, targetId: 'm1' } });
ok('② 重复申请 → 拒绝并提示', anySys(out1b, /已有.*待处理/));
ok('② 待办未被覆盖', a.host.state.opposed.phase === 'await_kp');

/* ③ KP 裁定：越界先报错；闪避同级 → 攻方败（免伤） */
var reqId = a.host.state.opposed.id;
var outBad = a.host.checkOpposed('host', { attack: true, reqId: reqId, defender: { reaction: 'dodge', value: 0 }, armor: { value: 0 } });
ok('③ 怪对抗值越界 → 报错且不核销', anySys(outBad, /1\u2013100/) && a.host.state.opposed && a.host.state.opposed.phase === 'await_kp');

var out2 = a.host.checkOpposed('host', { attack: true, reqId: reqId, defender: { reaction: 'dodge', value: 60 }, armor: { value: 0 } });
var chks2 = picks(out2, M.EVT.CHECK);
var chk2 = chks2[0] || null;
ok('③ 闪避同级 → outcome miss（免伤）', chk2 && /落空|被躲开/.test(chk2.summary || ''), chk2 && chk2.summary);
ok('③ 失败无伤害行（damage=null）', chk2 && chk2.damage === null);
ok('③ 结算后清空待办（幂等）', a.host.state.opposed === null);
var out2b = a.host.checkOpposed('host', { attack: true, reqId: reqId, defender: { reaction: 'dodge', value: 60 } });
ok('③ 已核销 reqId 再点 → 拒绝并提示', anySys(out2b, /已处理或不存在/));

/* ④ 玩家胜 + 多怪 → await_target → 选怪 → 结算伤害 */
var b = mkHost();
b.host.intent('s1', { op: M.INTENT.OPPOSED, p: { phase: 'request', weapon: { name: '匕首' }, targetId: 'm1' } });
var rid = b.host.state.opposed.id;
var out3 = b.host.checkOpposed('host', { attack: true, reqId: rid, defender: { reaction: 'counter', value: 60 }, armor: { value: 0 } });
ok('④ 反击同级 → 攻方胜且多怪 → await_target', b.host.state.opposed && b.host.state.opposed.phase === 'await_target',
  JSON.stringify(b.host.state.opposed && b.host.state.opposed.phase));
var chks3 = picks(out3, M.EVT.CHECK);
var chk3 = chks3[0] || null;
ok('④ 先落一条「待选目标」结果（damage=null）', chk3 && chk3.damage === null && /待选择伤害目标/.test(chk3.summary || ''));
ok('④ await_target EVT 回玩家', picks(out3, M.EVT.OPPOSED).some(function (p) { return p.phase === 'await_target'; }));
ok('④ 待办保留武器/伤害式（供选怪后结算）', !!b.host.state.opposed.dmgExpr, b.host.state.opposed.dmgExpr);

var before = b.host.state.combat.order[1].public.hp;
var out4 = b.host.intent('s1', { op: M.INTENT.OPPOSED, p: { phase: 'target', targetId: 'm2' } });
var after = b.host.state.combat.order[1].public.hp;
ok('④ 选怪后扣血（武器伤害>0）', after < before, 'before=' + before + ' after=' + after);
ok('④ 选怪后清空待办', b.host.state.opposed === null);
ok('④ 选怪后发出 resolved（核销玩家端待办）', picks(out4, M.EVT.OPPOSED).some(function (p) { return p.phase === 'resolved'; }));
var out4b = b.host.intent('s1', { op: M.INTENT.OPPOSED, p: { phase: 'target', targetId: 'm2' } });
ok('④ 重复选怪 → 拒绝提示（幂等）', anySys(out4b, /没有待选择的对抗目标/));

/* ⑤ 异常：空怪物清单 → 拒绝 */
var c = mkHost();
c.host.state.combat = null;
var out5 = c.host.intent('s1', { op: M.INTENT.OPPOSED, p: { phase: 'request', weapon: { name: '匕首' }, targetId: 'm1' } });
ok('⑤ 空怪物清单 → 拒绝提示', anySys(out5, /没有可选的怪物/));

/* ⑥ 异常：目标已死亡 → 拒绝 */
var d = mkHost();
d.host.state.combat.order[0].public = { hp: 0, down: true, state: 'dead' };
var out6 = d.host.intent('s1', { op: M.INTENT.OPPOSED, p: { phase: 'request', weapon: { name: '匕首' }, targetId: 'm1' } });
ok('⑥ 目标已死亡 → 拒绝提示', anySys(out6, /不存在或已死亡/));

/* ⑦ 异常：武器不在卡里 → 拒绝 */
var e = mkHost();
var out7 = e.host.intent('s1', { op: M.INTENT.OPPOSED, p: { phase: 'request', weapon: { name: '不存在的刀' }, targetId: 'm1' } });
ok('⑦ 武器不在卡里 → 拒绝提示', anySys(out7, /没有这把武器/));

/* ⑧ 撕卡玩家 → 拒绝（不在 passSelf 白名单） */
var f = mkHost();
f.mem.sheet.status.body = '死亡';
var out8 = f.host.intent('s1', { op: M.INTENT.OPPOSED, p: { phase: 'request', weapon: { name: '匕首' }, targetId: 'm1' } });
ok('⑧ 撕卡玩家 → 拒绝（不在 passSelf 白名单）', anySys(out8, /撕卡|死亡或永久疯狂/));

/* ⑨ KP 直接发起攻击对抗（怪物 vs 玩家，玩家读取人物卡） */
var g = mkHost();
var out9 = g.host.checkOpposed('host', { attack: true,
  attacker: { side: 'monster', actorId: 'm1', name: '食尸鬼', skill: '爪击', value: 55 },
  defender: { side: 'pc', seat: 's1', skill: '闪避', reaction: 'dodge' },
  weapon: { name: '爪', damage: '1D6', pierce: '\u00d7', db: '0' }, armor: { value: 0 } });
var chk9 = picks(out9, M.EVT.CHECK)[0] || null;
ok('⑨ KP 发起攻击对抗 → 有结果卡', !!chk9 && !!chk9.summary, chk9 && chk9.summary);
ok('⑨ 玩家侧读人物卡（未因查不到技能报错）', !anySys(out9, /查不到/));

/* ⑩ 客户端 reduce：await_target 存待办 / resolved 清空 */
var cs = M.emptyState({});
M.reduce(cs, { t: M.EVT.OPPOSED, seq: 1, p: { id: 'op1', by: 's1', phase: 'await_target', monsters: [{ id: 'm1', name: 'A' }, { id: 'm2', name: 'B' }] } });
ok('⑩ 客户端 reduce：await_target 存待办', cs.opposed && cs.opposed.phase === 'await_target' && cs.opposed.monsters.length === 2);
M.reduce(cs, { t: M.EVT.OPPOSED, seq: 2, p: { id: 'op1', by: 's1', phase: 'resolved' } });
ok('⑩ 客户端 reduce：resolved 清空待办', cs.opposed === null);
M.reduce(cs, { t: M.EVT.CHECK, seq: 3, p: { kind: 'opposed', summary: 'x', at: 1, a: { name: 'A', value: 30 }, b: { name: 'B', value: 40 }, winner: 'b', reaction: 'dodge', rounds: [{ round: 1, aRoll: 30, bRoll: 40 }], damage: null } });
var lastLog = cs.logs[cs.logs.length - 1];
ok('⑩ 对抗结果进日志且带结构化 opp', lastLog && lastLog.kind === 'check' && lastLog.opp && lastLog.opp.winner === 'b' && (lastLog.opp.rounds || []).length === 1);

console.log('\nT05 (v2.2.0) selftest: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
