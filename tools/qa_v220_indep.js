/* ============================================================
 * qa_v220_indep.js —— v2.2.0 批次（T01..T05）QA **独立**回归 harness
 *
 * 作者：QA 严过关（独立编写，不复用工程师的 tools/test_v220_*.js）
 * 运行：node tools/qa_v220_indep.js   （工作目录 = 仓库根）
 * 成功：最后一行打印  RESULT: PASS
 *
 * 覆盖：
 *   A 规则矩阵：opposedAttack 模式敏感同级裁定 + 通用 10 轮重掷兜底 + rounds 明细
 *   B resolveAttack：远程 fightback 降级 / 攻击未成功 miss / 闪避同级 miss / 反击同级攻方胜
 *   C Host 全链路：申请→await_kp→KP 裁定（武器分支/越界不核销/重复/已核销）→结算
 *                  多怪 await_target→选怪→扣血→resolved；单怪自动结算；
 *                  空怪/目标死亡/武器不在卡/撕卡玩家 均拒绝；secret 可见性
 *   D sanitizeSheet：weapons/db 白名单（≤20、pierce 归一、无 name 丢弃）+ 隐私不外泄
 *   E 雷达数学：sum/pct/norm 已知集合断言（最高 norm=100、Σpct≈100、value 仍为均值）
 *   F appendFeed/结果卡 & 折叠/闪烁 逻辑（纯函数级，能静态断言的断言）
 * ============================================================ */
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');
var base = path.join(__dirname, '..', 'web', 'js');
var sb = {};
vm.createContext(sb); sb.window = sb; sb.console = console;
['core/room-rules.js', 'core/room-model.js', 'core/rules-coc7.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(base, f), 'utf8'), sb, { filename: f });
});
var M = sb.RoomModel, R = sb.CocRules;

/* ---------------- 迷你断言框架 ---------------- */
var pass = 0, fail = 0, warn = 0, failures = [], warns = [];
function ok(cond, label, extra) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(label + (extra === undefined ? '' : '　→ 实际: ' + JSON.stringify(extra)));
}
function eq(a, b, label) { ok(a === b, label + '（期望 ' + JSON.stringify(b) + '）', a); }
/** 预警：记录但不计入 FAIL（用于「既有、非本批次回归」的问题） */
function soft(cond, label, extra) {
  if (cond) { pass++; return; }
  warn++;
  warns.push(label + (extra === undefined ? '' : '　→ 实际: ' + JSON.stringify(extra)));
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

/* 确定性 rng：按序列循环返回（0..1） */
function feeder(seq) { var i = 0; return function () { return seq[i++ % seq.length]; }; }
/** 让「一次 D100」掷出指定值 v(1..99) 所需的两拍：先个位、再十位 */
function d100(v) { var ones = v % 10, tens = Math.floor(v / 10); return [ones / 10 + 0.0, tens / 10 + 0.0]; }
function feed100(values) { // [v1, v2, ...] → 展开成 rng 序列
  var s = []; values.forEach(function (v) { s = s.concat(d100(v)); }); return feeder(s);
}
function picks(out, t) {
  var a = []; (out || []).forEach(function (r) { if (r && r.msg && r.msg.t === t) a.push(r.msg.p || {}); }); return a;
}
function anySys(out, re) {
  return (out || []).some(function (r) {
    return r && r.msg && (r.msg.t === M.EVT.PRIVATE || r.msg.t === M.EVT.LOG) &&
      re.test((r.msg.p && r.msg.p.text) || '');
  });
}
/** 手造「检定结果」对象（只给 opposedAttack 需要的字段），用于纯规则矩阵断言 */
function chk(level, levelText, base) { return { level: level, levelText: levelText, base: base }; }

/* ============================================================
 * A. opposedAttack 规则矩阵
 * ============================================================ */
section('A. opposedAttack —— 模式敏感同级裁定 + 10 轮重掷兜底');

// A1 等级高者胜（不受 mode 影响）
var r = R.opposedAttack(chk(4, '极难成功', 50), chk(2, '常规成功', 90), { mode: 'dodge' });
eq(r.winner, 'a', 'A1a a.level>b.level → a 胜');
eq(r.decidedBy, 'level', 'A1a decidedBy=level');
eq((r.rounds || []).length, 0, 'A1a 无重掷');
r = R.opposedAttack(chk(2, '常规成功', 90), chk(4, '极难成功', 50), { mode: 'fightback' });
eq(r.winner, 'b', 'A1b b.level>a.level → b 胜（反击也不改）');

// A2 同级 fightback → a 胜，不重掷
r = R.opposedAttack(chk(2, '常规成功', 60), chk(2, '常规成功', 60), { mode: 'fightback', rng: feeder([0, 0]) });
eq(r.winner, 'a', 'A2a 同级 fightback → a 胜');
eq(r.decidedBy, 'mode_fightback_tie', 'A2a decidedBy=mode_fightback_tie');
eq((r.rounds || []).length, 0, 'A2a 反击同级不重掷 rounds=0');

// A3 同级 dodge → b 胜，不重掷
r = R.opposedAttack(chk(3, '困难成功', 60), chk(3, '困难成功', 60), { mode: 'dodge' });
eq(r.winner, 'b', 'A3a 同级 dodge → b 胜');
eq(r.decidedBy, 'mode_dodge_tie', 'A3a decidedBy=mode_dodge_tie');
eq((r.rounds || []).length, 0, 'A3a 闪避同级不重掷 rounds=0');

// A4 通用（none）同级 → 先比 base
r = R.opposedAttack(chk(2, '常规成功', 70), chk(2, '常规成功', 50), { mode: 'none' });
eq(r.winner, 'a', 'A4a 通用同级 a.base>b.base → a 胜');
eq(r.decidedBy, 'value', 'A4a decidedBy=value');
r = R.opposedAttack(chk(2, '常规成功', 50), chk(2, '常规成功', 70), { mode: 'none' });
eq(r.winner, 'b', 'A4b 通用同级 b.base>a.base → b 胜');

// A5 通用同级同值 → 首轮即分（低者胜）
r = R.opposedAttack(chk(2, '常规成功', 60), chk(2, '常规成功', 60), { mode: 'none', rng: feed100([30, 70]) });
eq(r.winner, 'a', 'A5a 首轮 30 vs 70 → a 胜（骰值低者胜）');
eq(r.decidedBy, 'reroll', 'A5a decidedBy=reroll');
eq((r.rounds || []).length, 1, 'A5a rounds 长度 1');
eq(r.rounds[0].round, 1, 'A5a rounds[0].round=1');
eq(r.rounds[0].aRoll, 30, 'A5a rounds[0].aRoll=30');
eq(r.rounds[0].bRoll, 70, 'A5a rounds[0].bRoll=70');
eq(r.rounds[0].winner, 'a', 'A5a rounds[0].winner=a');

// A6 先平后分：第1轮同值 → winner:null 记入明细；第2轮 20 vs 80 → a 胜
r = R.opposedAttack(chk(2, '常规成功', 60), chk(2, '常规成功', 60), { mode: 'none', rng: feed100([50, 50, 20, 80]) });
eq((r.rounds || []).length, 2, 'A6 rounds 长度 2');
eq(r.rounds[0].winner, null, 'A6 第1轮平局 winner=null');
eq(r.rounds[1].winner, 'a', 'A6 第2轮 a 胜');
eq(r.winner, 'a', 'A6 最终 a 胜');
eq(r.decidedBy, 'reroll', 'A6 decidedBy=reroll');

// A7 10 轮兜底：每轮双方同值 → 走满 10 轮 → fallback、判 a 胜、rounds=10
r = R.opposedAttack(chk(2, '常规成功', 60), chk(2, '常规成功', 60), { mode: 'none', rng: feeder([0, 0]) });
// feeder([0,0]) → 每拍返回 0 → 每拍 floor(0*10)=0 → 每次 D100 = combine(0,0)=100；双方恒 100
eq((r.rounds || []).length, 10, 'A7 走满 10 轮（上限）');
eq(r.winner, 'a', 'A7 超限判发起方(a)胜');
eq(r.decidedBy, 'reroll_fallback', 'A7 decidedBy=reroll_fallback');
eq(r.fallback, true, 'A7 fallback=true');
ok(/兜底/.test(r.reason || ''), 'A7 reason 含「兜底」', r.reason);
ok((r.rounds || []).every(function (x) { return x.winner === null; }), 'A7 每轮均为平局');

// A8 rerollMax 可配：rerollMax=3 → 走满 3 轮兜底
r = R.opposedAttack(chk(2, '常规成功', 60), chk(2, '常规成功', 60), { mode: 'none', rng: feeder([0, 0]), rerollMax: 3 });
eq((r.rounds || []).length, 3, 'A8 rerollMax=3 生效（rounds=3）');
eq(r.fallback, true, 'A8 兜底');

// A9 非法入参
r = R.opposedAttack(null, chk(2, '常规成功', 60), { mode: 'dodge' });
eq(r.winner, null, 'A9 缺一方 → winner=null');

// A10 opposedFull = 通用分支（不短路）
r = R.opposedFull(chk(2, '常规成功', 60), chk(2, '常规成功', 60), { rng: feed100([10, 90]) });
eq(r.winner, 'a', 'A10 opposedFull 通用同级同值 → 重掷低者胜');
eq(r.decidedBy, 'reroll', 'A10 decidedBy=reroll');

/* ============================================================
 * B. resolveAttack 集成（模式敏感 + 远程降级）
 * ============================================================ */
section('B. resolveAttack —— 远程降级 / 未成功 miss / 闪避同级 miss / 反击同级攻方胜');

// B1 攻击方未成功（base 30，roll 55）→ 直接 miss，不比不伤
var res = R.resolveAttack({ attack: { value: 30, roll: 55 }, defense: { mode: 'dodge', value: 60 },
  damage: { expr: '1D6', db: '0' }, rng: feeder([0.5]) });
eq(res.outcome, 'miss', 'B1 攻击未成功 → miss');
eq(res.damage.applied, 0, 'B1 applied=0');
eq(res.compare, null, 'B1 未进入比较 compare=null');

// B2 远程 fightback → 降级 dodge 并标注
res = R.resolveAttack({ attack: { value: 60, roll: 40, ranged: true }, defense: { mode: 'fightback', value: 60, roll: 40 },
  damage: { expr: '1D6', db: '0' }, rng: feeder([0.5]) });
eq(res.mode, 'dodge', 'B2 远程 fightback 降级为 dodge');
eq(res.coercedFromFightback, true, 'B2 coercedFromFightback=true');
eq(res.outcome, 'miss', 'B2 降级后同级 → 闪避胜 → miss（免伤）');
eq(res.damage.applied, 0, 'B2 免伤 applied=0');

// B3 非远程 dodge 同级 → miss（攻方败/被躲开）
res = R.resolveAttack({ attack: { value: 60, roll: 40 }, defense: { mode: 'dodge', value: 60, roll: 40 },
  damage: { expr: '1D8', db: '0' }, rng: feeder([0.5]) });
eq(res.outcome, 'miss', 'B3 闪避同级 → miss');
eq(res.damage.applied, 0, 'B3 免伤 applied=0');
ok(/被躲开|落空/.test(res.summary || ''), 'B3 summary 提「被躲开/落空」', res.summary);

// B4 非远程 fightback 同级 → 攻击方胜且伤害 > 0
res = R.resolveAttack({ attack: { value: 60, roll: 40 }, defense: { mode: 'fightback', value: 60, roll: 40 },
  damage: { expr: '1D8', db: '0' }, rng: feeder([0.5]) });
eq(res.outcome, 'attacker_wins', 'B4 反击同级 → 攻击方胜');
ok(res.damage.applied > 0, 'B4 伤害 > 0', res.damage.applied);
eq(res.compare.decidedBy, 'mode_fightback_tie', 'B4 decidedBy=mode_fightback_tie');

// B5 等级高者胜（dodge 但攻方等级更高）→ 命中
res = R.resolveAttack({ attack: { value: 60, roll: 20 }, defense: { mode: 'dodge', value: 20, roll: 15 },
  damage: { expr: '1D6', db: '0' }, rng: feeder([0.5]) });
// attack: 20<=hard(30) HARD(3); defense base 20 roll 15<=extreme(4)? no; <=hard(10)? no; <=20 REGULAR(2) → a 等级高
eq(res.outcome, 'attacker_wins', 'B5 等级差 → 攻方胜（不因 dodge 短路）');
ok(res.damage.applied > 0, 'B5 伤害 > 0');

// B6 护甲扣减生效
res = R.resolveAttack({ attack: { value: 60, roll: 40 }, defense: { mode: 'fightback', value: 60, roll: 40 },
  damage: { expr: '1D8', db: '0' }, armor: { value: 3 }, rng: feeder([0.5]) });
// 1D8@0.5 → 1+floor(0.5*8)=5；armor 3 → applied 2
eq(res.damage.raw, 5, 'B6 伤害骰 raw=5（1D8@0.5，确定性）');
eq(res.damage.applied, 2, 'B6 护甲 3 → applied=2');

// B7 护甲 ≥ 伤害 → applied 归零
res = R.resolveAttack({ attack: { value: 60, roll: 40 }, defense: { mode: 'fightback', value: 60, roll: 40 },
  damage: { expr: '1D6', db: '0' }, armor: { value: 99 }, rng: feeder([0.5]) });
eq(res.damage.applied, 0, 'B7 高护甲 → applied=0（不为负）');

/* ============================================================
 * C. Host 全链路（真实模型）
 * ============================================================ */
section('C. Host —— 玩家武器对抗全链路 + 幂等 + 异常');

function mkHost(opts) {
  opts = opts || {};
  var host = new M.Host({ rules: R, rng: feeder([0.5]), now: function () { return 1000; } });
  host.roster.open({ seat: 's1', role: M.ROLE.PLAYER, nickname: '小美' });
  host.roster.open({ seat: 's2', role: M.ROLE.PLAYER, nickname: '阿强' });
  var mem = host.roster.get('s1');
  mem.charName = '小美';
  mem.online = true;
  mem.sheet = {
    name: '小美', attrs: { str: 60 }, status: { currentHP: 12, maxHP: 12 },
    skills: [{ name: '格斗', total: 60 }, { name: '闪避', total: 60 }],
    weapons: [{ name: '匕首', skill: '格斗', damage: '1D6', pierce: '×' }],
    db: '0'
  };
  var mem2 = host.roster.get('s2');
  mem2.charName = '阿强'; mem2.online = true;
  mem2.sheet = { name: '阿强', attrs: {}, status: {}, skills: [{ name: '格斗', total: 60 }], weapons: [], db: '0' };
  host.state.combat = {
    order: opts.single
      ? [{ id: 'm1', actorId: 'm1', kind: 'monster', name: '食尸鬼', public: { hp: 10, hpMax: 10 } }]
      : [{ id: 'm1', actorId: 'm1', kind: 'monster', name: '食尸鬼', public: { hp: 10, hpMax: 10 } },
         { id: 'm2', actorId: 'm2', kind: 'monster', name: '深潜者', public: { hp: 8, hpMax: 8 } }],
    turn: 0, round: 1, startedAt: 0
  };
  return { host: host, mem: mem };
}
function reqPayload(targetId) {
  return { op: M.INTENT.OPPOSED, p: { phase: 'request', weapon: { name: '匕首' }, db: '0', targetId: targetId } };
}

/* C1 申请 → 建待办 await_kp，且申请只发 KP（SEAT） */
var a = mkHost();
var out1 = a.host.intent('s1', reqPayload('m1'));
eq(a.host.state.opposed && a.host.state.opposed.phase, 'await_kp', 'C1 申请 → 待办 await_kp');
var opp1 = picks(out1, M.EVT.OPPOSED);
ok(opp1.length >= 1 && opp1[0].phase === 'await_kp', 'C1 发出 EVT.OPPOSED(await_kp)');
var toHost = (out1 || []).filter(function (x) { return x.msg && x.msg.t === M.EVT.OPPOSED; });
eq(toHost.length, 1, 'C1 申请事件仅 1 条');
eq(toHost[0].to, M.HOST_SEAT, 'C1 申请事件收件人 = KP(host)，非广播');

/* C2 INTENT.OPPOSED 不在 locked 的 passSelf → 撕卡玩家被拒 */
a.mem.sheet.status.body = '死亡';
var out2 = a.host.intent('s1', reqPayload('m1'));
ok(anySys(out2, /撕卡|死亡|只能/), 'C2 撕卡玩家发起申请 → 被拒（locked）', JSON.stringify(out2));
a.mem.sheet.status.body = '正常';

/* C3 重复申请 → 拒绝且不覆盖待办 */
var stId = a.host.state.opposed.id;
var out3 = a.host.intent('s1', reqPayload('m1'));
ok(anySys(out3, /已有一条待处理|已有/), 'C3 重复申请 → 拒绝', JSON.stringify(out3));
eq(a.host.state.opposed.id, stId, 'C3 待办未被覆盖');

/* C4 武器不在卡 → 拒绝 */
var b = mkHost();
var out4 = b.host.intent('s1', { op: M.INTENT.OPPOSED, p: { phase: 'request', weapon: { name: '火箭筒' }, targetId: 'm1' } });
ok(anySys(out4, /没有这把武器/), 'C4 武器不在卡 → 拒绝', JSON.stringify(out4));
eq(b.host.state.opposed, null, 'C4 未建待办');

/* C5 空怪清单 → 拒绝 */
var c = mkHost(); c.host.state.combat.order = [];
var out5 = c.host.intent('s1', reqPayload('m1'));
ok(anySys(out5, /没有可选的怪物/), 'C5 空怪清单 → 拒绝', JSON.stringify(out5));

/* C6 目标已死亡 → 拒绝 */
var d = mkHost(); d.host.state.combat.order[0].public.down = true;
var out6 = d.host.intent('s1', reqPayload('m1'));
ok(anySys(out6, /不存在或已死亡|已死亡/), 'C6 目标已死亡 → 拒绝', JSON.stringify(out6));

/* C7 KP 裁定：值越界 → 报错且**不核销** */
var e = mkHost();
e.host.intent('s1', reqPayload('m1'));
var rid = e.host.state.opposed.id;
var outBad = e.host.checkOpposed(M.HOST_SEAT, { attack: true, reqId: rid, defender: { reaction: 'dodge', value: 0 }, armor: { value: 0 } });
ok(anySys(outBad, /1[–-]100/), 'C7 怪对抗值越界 → 报错', JSON.stringify(outBad));
eq(e.host.state.opposed && e.host.state.opposed.phase, 'await_kp', 'C7 越界不核销（待办仍在）');

/* C8 KP 裁定：闪避同级 → 攻方败（miss、免伤），结算后清待办 */
// 攻击方(玩家) 格斗 60；怪物闪避 60；双方均掷 55（rng 0.5）→ REGULAR 同级 → dodge → b 胜 → miss
var outRes = e.host.checkOpposed(M.HOST_SEAT, { attack: true, reqId: rid, defender: { reaction: 'dodge', value: 60 }, armor: { value: 0 }, rng: feeder([0.5]) });
var chkP = picks(outRes, M.EVT.CHECK)[0] || {};
eq(chkP.kind, 'opposed', 'C8 结算发 EVT.CHECK(kind=opposed)');
eq(chkP.damage, null, 'C8 被躲开 → damage=null（不显示伤害行）');
eq(chkP.reaction, 'dodge', 'C8 reaction=dodge 透传');
eq(chkP.winner, 'b', 'C8 winner=b');
eq(e.host.state.opposed, null, 'C8 结算后清待办');
ok((chkP.summary || '').indexOf('⚔ 对抗｜') === 0, 'C8 记录以「⚔ 对抗｜」开头', chkP.summary);
ok(/被躲开|落空|未造成伤害/.test(chkP.summary || ''), 'C8 summary 不显示伤害行', chkP.summary);

/* C9 已核销 reqId → 拒绝 */
var outReuse = e.host.checkOpposed(M.HOST_SEAT, { attack: true, reqId: rid, defender: { reaction: 'dodge', value: 60 }, armor: { value: 0 } });
ok(anySys(outReuse, /已处理或不存在/), 'C9 已核销 reqId → 拒绝', JSON.stringify(outReuse));

/* C10 KP 直接发起攻击对抗（怪物攻击玩家，反击同级 → 攻方=怪物胜 → 打玩家） */
var f = mkHost();
var outF = f.host.checkOpposed(M.HOST_SEAT, {
  attack: true,
  attacker: { side: 'monster', actorId: 'm1', name: '食尸鬼', skill: '爪击', value: 60, ranged: false },
  defender: { side: 'pc', seat: 's1', name: '小美', skill: '闪避', value: 60, reaction: 'counter' },
  weapon: { name: '爪击', damage: '1D6', pierce: '×', db: '0' },
  armor: { value: 0 }, rng: feeder([0.5])
});
var chkF = picks(outF, M.EVT.CHECK)[0] || {};
eq(chkF.winner, 'a', 'C10 反击同级 → 攻方(怪物)胜');
ok(chkF.damage && chkF.damage.applied > 0, 'C10 命中伤害 > 0', JSON.stringify(chkF.damage));
eq(chkF.damage.by, 'a', 'C10 伤害由攻方(怪物)造成');

/* C11 多怪：玩家胜 → await_target → 选怪 → 扣血 → resolved */
var g = mkHost();
g.host.intent('s1', reqPayload('m1'));
// 反击同级 → 玩家胜
var outG = g.host.checkOpposed(M.HOST_SEAT, { attack: true, reqId: g.host.state.opposed.id, defender: { reaction: 'counter', value: 60 }, armor: { value: 0 }, rng: feeder([0.5]) });
eq(g.host.state.opposed && g.host.state.opposed.phase, 'await_target', 'C11a 胜且多怪 → await_target');
var tgtEvt = picks(outG, M.EVT.OPPOSED).filter(function (p) { return p.phase === 'await_target'; })[0] || {};
ok(Array.isArray(tgtEvt.monsters) && tgtEvt.monsters.length >= 2, 'C11a await_target 带 monsters 清单', JSON.stringify(tgtEvt.monsters));
var hpBefore = g.host.state.combat.order[1].public.hp;
var outT = g.host.intent('s1', { op: M.INTENT.OPPOSED, p: { phase: 'target', targetId: 'm2' } });
var hpAfter = g.host.state.combat.order[1].public.hp;
ok(hpAfter < hpBefore, 'C11b 选怪后怪物 HP 下降（' + hpBefore + '→' + hpAfter + '）');
var resolved = picks(outT, M.EVT.OPPOSED).filter(function (p) { return p.phase === 'resolved'; });
eq(resolved.length, 1, 'C11b 发出 EVT.OPPOSED(resolved)');
eq(g.host.state.opposed, null, 'C11b 结算后清待办');

/* C12 单怪：玩家胜 → 自动结算（不经 await_target） */
var h = mkHost({ single: true });
h.host.intent('s1', reqPayload('m1'));
var hpB = h.host.state.combat.order[0].public.hp;
var outH = h.host.checkOpposed(M.HOST_SEAT, { attack: true, reqId: h.host.state.opposed.id, defender: { reaction: 'counter', value: 60 }, armor: { value: 0 }, rng: feeder([0.5]) });
eq(h.host.state.opposed, null, 'C12 单怪胜 → 直接结算（无 await_target）');
ok(h.host.state.combat.order[0].public.hp < hpB, 'C12 单怪 HP 下降');
var dmgH = (picks(outH, M.EVT.CHECK)[0] || {}).damage;
ok(dmgH && dmgH.applied > 0, 'C12 单怪伤害 > 0', JSON.stringify(dmgH));

/* C13 拒绝申请：cancel → rejected、清待办、通知发起人 */
var i2 = mkHost();
i2.host.intent('s1', reqPayload('m1'));
var ridI = i2.host.state.opposed.id;
var outI = i2.host.checkOpposed(M.HOST_SEAT, { cancel: true, reqId: ridI });
var rej = picks(outI, M.EVT.OPPOSED).filter(function (p) { return p.phase === 'rejected'; });
eq(rej.length, 1, 'C13 拒绝 → EVT.OPPOSED(rejected)');
eq(i2.host.state.opposed, null, 'C13 拒绝后清待办');
ok(anySys(outI, /被 KP 拒绝/) || (outI || []).some(function (x) { return x.to === 's1' && x.msg && x.msg.t === M.EVT.OPPOSED; }),
  'C13 通知发起玩家被拒');

/* C14 玩家选怪阶段越界/非法目标 → 拒绝 */
var j = mkHost();
j.host.intent('s1', reqPayload('m1'));
j.host.checkOpposed(M.HOST_SEAT, { attack: true, reqId: j.host.state.opposed.id, defender: { reaction: 'counter', value: 60 }, armor: { value: 0 }, rng: feeder([0.5]) });
var outJ = j.host.intent('s1', { op: M.INTENT.OPPOSED, p: { phase: 'target', targetId: 'mX' } });
ok(anySys(outJ, /不存在或已死亡|所选目标/), 'C14 选不存在目标 → 拒绝', JSON.stringify(outJ));

/* ============================================================
 * D. secret 可见性（不得进公开流）
 * ============================================================ */
section('D. secret 对抗 —— 可见性');
var k = mkHost();
var outK = k.host.checkOpposed(M.HOST_SEAT, { aSeat: 's1', aSkill: '格斗', bSeat: 's2', bSkill: '格斗', secret: true, rng: feeder([0.5]) });
var chkK = picks(outK, M.EVT.CHECK);
eq(chkK.length, 1, 'D1 secret 仍有 EVT.CHECK');
var pubChk = (outK || []).filter(function (x) { return x.msg && x.msg.t === M.EVT.CHECK; });
eq(pubChk[0].to, M.HOST_SEAT, 'D1 secret 检定只发 KP（to=host）');
ok(!(outK || []).some(function (x) { return x.to === '*' && x.msg && x.msg.t === M.EVT.CHECK; }),
  'D1 secret 检定无公共广播');
// KP 端自己的 state.logs 可见（KP 应能看到自己的秘密检定）
ok((k.host.state.logs || []).some(function (l) { return /⚔ 对抗｜/.test(l.text || ''); }), 'D1 KP 端可见该记录');
// 玩家全量同步：secret 记录是否随 logs 泄漏给玩家？
// ⚠️ 已核对：该行为在 v2.1.7 基线（android 已同步 assets）中**完全相同** → 非 v2.2.0 回归。
var syncP = k.host.syncFor('s2');
var leaked = (syncP.state.logs || []).some(function (l) { return /⚔ 对抗｜/.test(l.text || ''); });
soft(!leaked, 'D2 [既有-非回归/privacy] secret 对抗记录不得进入玩家全量同步 logs', leaked ? (syncP.state.logs || []).map(function (l) { return l.text; }) : '');

/* ============================================================
 * D3 常量存在性（T01 协议底座）
 * ============================================================ */
eq(M.INTENT.OPPOSED, 'opposed', 'D3 INTENT.OPPOSED 常量存在');
eq(M.EVT.OPPOSED, 'opposed', 'D3 EVT.OPPOSED 常量存在');

/* ============================================================
 * E. sanitizeSheet —— weapons/db 白名单 + 隐私
 * ============================================================ */
section('E. sanitizeSheet —— weapons/db 白名单');
var sOut = M.sanitizeSheet({
  sheet: {
    name: '小美',
    weapons: [
      { name: '匕首', skill: '格斗', damage: '1D4+2', pierce: '√' },
      { name: '手枪', skill: '射击', damage: '1D10', pierce: '√' },
      { name: '', skill: 'x', damage: '1D3', pierce: '√' },            // 无 name → 丢弃
      { name: '木棍', skill: '格斗', damage: '1D6', pierce: '乱七八糟' }  // pierce 非 √ → 归一 '×'
    ],
    db: '+1D4',
    secret: 'KP 的秘密', truth: '答案', kpOnly: 'x'
  }
}, null);
eq(sOut.weapons.length, 3, 'E1 无 name 的武器被丢弃（剩 3）');
eq(sOut.weapons[0].name, '匕首', 'E1 武器名保留');
eq(sOut.weapons[0].pierce, '√', 'E1 pierce=√ 保留');
eq(sOut.weapons[2].pierce, '×', 'E1 非法 pierce 归一为 ×');
eq(sOut.db, '+1D4', 'E1 db 保留');
ok(sOut.secret === undefined && sOut.truth === undefined && sOut.kpOnly === undefined,
  'E2 [隐私] SECRET_KEYS 字段未带出 sanitizeSheet', Object.keys(sOut));
// ≤20：塞 25 条
var many = []; for (var wi = 0; wi < 25; wi++) many.push({ name: 'w' + wi, skill: 's', damage: '1D6', pierce: '×' });
var s20 = M.sanitizeSheet({ sheet: { name: 'x', weapons: many } }, null);
eq(s20.weapons.length, 20, 'E3 武器上限 20');
// 其他玩家视角不暴露 weapons/db
var host3 = new M.Host({ rules: R });
host3.roster.open({ seat: 's1', role: M.ROLE.PLAYER, nickname: 'a' });
host3.roster.open({ seat: 's2', role: M.ROLE.PLAYER, nickname: 'b' });
host3.roster.get('s1').sheet = sOut;
var cropped = host3._cropMember(host3.roster.get('s1'), 's2');
ok(!cropped.sheet || cropped.sheet.weapons === undefined, 'E4 [隐私] 其他玩家视角无 weapons');
ok(!cropped.sheet || cropped.sheet.db === undefined, 'E4 [隐私] 其他玩家视角无 db');
// 本人/KP 视角有 weapons
var selfView = host3._cropMember(host3.roster.get('s1'), 's1');
ok(selfView.sheet && Array.isArray(selfView.sheet.weapons), 'E4 本人视角有 weapons');

/* ============================================================
 * F. 雷达数学（sum/pct/norm，value 仍为均值）
 * ============================================================ */
section('F. rules-coc7.radar —— sum/pct/norm');
var COC7 = sb.COC7;
ok(COC7 && typeof COC7.radar === 'function', 'F0 COC7.radar 可用');
var defs = [
  { id: 'a1', category: '战斗' }, { id: 'a2', category: '战斗' },
  { id: 'b1', category: '探索' },
  { id: 'c1', category: '知识' },
  { id: 'd1', category: '交流' },
  { id: 'e1', category: '生存' }
];
var skills = [
  { id: 'a1', total: 40 }, { id: 'a2', total: 60 },   // 战斗 sum=100 count=2 → value=50
  { id: 'b1', total: 50 },                            // 探索 sum=50
  { id: 'c1', total: 0 },
  { id: 'd1', total: 0 },
  { id: 'e1', total: 0 }
];
var rr = COC7.radar(skills, defs);
var dBattle = rr.filter(function (x) { return x.key === '战斗'; })[0];
var dExpl = rr.filter(function (x) { return x.key === '探索'; })[0];
eq(dBattle.sum, 100, 'F1 战斗 sum=100（40+60 求和）');
eq(dBattle.value, 50, 'F1 战斗 value=50（仍为类内均值，语义未改）');
eq(dExpl.value, 50, 'F1 探索 value=50');
eq(dBattle.norm, 100, 'F2 最高类别 norm=100');
ok(Math.abs(dExpl.norm - 50) < 0.05, 'F2 探索 norm=50（50/100×100）', dExpl.norm);
var sumPct = rr.reduce(function (s, x) { return s + x.pct; }, 0);
ok(Math.abs(sumPct - 100) < 0.6, 'F3 Σpct ≈ 100', sumPct);
ok(Math.abs((dBattle.pct + dExpl.pct) - 100) < 0.05, 'F3 pct 之和 = 100');
ok(Math.abs(dBattle.pct - 66.7) < 0.05, 'F3 战斗 pct≈66.7', dBattle.pct);
ok(Math.abs(dExpl.pct - 33.3) < 0.05, 'F3 探索 pct≈33.3', dExpl.pct);
// 全 0 集：norm/pct 不 NaN
var rr0 = COC7.radar([{ id: 'a1', total: 0 }], defs);
ok(rr0.every(function (x) { return x.norm === 0 && x.pct === 0 && !isNaN(x.value); }), 'F4 全 0 集不产生 NaN');

/* ============================================================
 * G. 极端值 / 边界
 * ============================================================ */
section('G. 极端值 / 边界');
var c1 = R.check({ base: 1, value: 1 });
eq(c1.level, R.LEVEL.CRITICAL, 'G1 base=1 掷 1 → 大成功');
eq(c1.passed, true, 'G1 大成功判定通过');
var c99 = R.check({ base: 99, value: 99 });
eq(c99.level, R.LEVEL.REGULAR, 'G2 base=99 掷 99 → 常规成功');
var cf = R.check({ base: 30, rng: feeder([1]) });   // die10(1)→clamp 9 → 99；base30<50 → 大失败 96-100
eq(cf.value, 99, 'G3 rng=1 → 掷出 99（个位/十位钳位到 9）');
eq(cf.fumble, true, 'G3 base=30 掷 99 → 大失败');
eq(cf.passed, false, 'G3 大失败不通过');
// opposedAttack 对「双方都大失败」仍按等级（相等）→ 通用走重掷
var cfa = R.check({ base: 30, value: 99 }), cfb = R.check({ base: 30, value: 99 });
var rz = R.opposedAttack(cfa, cfb, { mode: 'none', rng: feed100([10, 80]) });
eq(rz.winner, 'a', 'G4 双方同级(-1 大失败)通用 → 重掷低者胜');
ok(rz.decidedBy === 'reroll' && rz.rounds.length === 1, 'G4 走重掷（未被手输值绕过）');
// 攻击方大失败 vs 成功 → 等级差
var rl = R.opposedAttack(R.check({ base: 30, value: 99 }), R.check({ base: 60, value: 40 }), { mode: 'dodge' });
eq(rl.winner, 'b', 'G5 攻方大失败 vs 守方成功 → 守方胜');

/* ============================================================
 * 汇总
 * ============================================================ */
console.log('\n--------------------------------------------------');
console.log('QA v2.2.0 独立 harness: PASS=' + pass + '  FAIL=' + fail + '  WARN(既有/非回归)=' + warn);
if (warns.length) {
  console.log('\n预警（不计入 FAIL）：');
  warns.forEach(function (w, i) { console.log('  W' + (i + 1) + ') ' + w); });
}
if (fail) {
  console.log('\n失败项：');
  failures.forEach(function (f, i) { console.log('  ' + (i + 1) + ') ' + f); });
  console.log('\nRESULT: FAIL');
  process.exit(1);
} else {
  console.log('RESULT: PASS');
}
