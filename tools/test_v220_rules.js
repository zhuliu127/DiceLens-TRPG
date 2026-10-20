/*
 * v2.2.0 T01 自测：对抗规则底座（opposedAttack / opposedFull / resolveAttack 模式敏感）
 * 运行： node tools/test_v220_rules.js（工作目录 = 仓库根）
 * 用确定性 rng，断言全部可复现。
 */
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');
var base = 'web/js/';
var sb = {};
vm.createContext(sb); sb.window = sb;
['core/room-rules.js', 'core/rules-coc7.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(base, f), 'utf8'), sb);
});
var R = sb.CocRules, C7 = sb.COC7;
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? ('  \u2192 ' + extra) : '')); }
}
function feeder(seq) { var i = 0; return function () { return seq[i++ % seq.length]; }; }

/* die10 顺序：先个位 ones，再十位 tens。值 43 → ones .3 / tens .4；71 → ones .1 / tens .7 */
var rng43_71 = feeder([0.3, 0.4, 0.1, 0.7]);
var rngAlways0 = feeder([0.0]);

var a = R.check({ base: 50, value: 30 });   // 常规成功
var b = R.check({ base: 50, value: 40 });   // 常规成功，同 base=50
ok('a/b 均常规成功', a.levelText === '常规成功' && b.levelText === '常规成功', a.levelText + '/' + b.levelText);

var v1 = R.opposedAttack(a, b, { mode: 'fightback' });
ok('反击·同级 → 攻方(a)胜', v1.winner === 'a' && v1.decidedBy === 'mode_fightback_tie', JSON.stringify(v1.decidedBy));
ok('反击·同级 不重掷', (v1.rounds || []).length === 0);

var v2 = R.opposedAttack(a, b, { mode: 'dodge' });
ok('闪避·同级 → 攻方败(b)胜', v2.winner === 'b' && v2.decidedBy === 'mode_dodge_tie', JSON.stringify(v2.decidedBy));

var v3 = R.opposedAttack(a, b, { mode: 'none', rng: rng43_71 });
ok('通用·同级同值 → 重掷取低者(a)', v3.winner === 'a' && v3.decidedBy === 'reroll', JSON.stringify(v3));
ok('通用·重掷明细含 1 轮', (v3.rounds || []).length === 1 && v3.rounds[0].aRoll === 43 && v3.rounds[0].bRoll === 71, JSON.stringify(v3.rounds));

var v4 = R.opposedAttack(a, b, { mode: 'none', rng: rngAlways0, rerollMax: 10 });
ok('通用·10 轮兜底 → 发起方(a)胜 + fallback', v4.winner === 'a' && v4.fallback === true && v4.decidedBy === 'reroll_fallback', JSON.stringify({ w: v4.winner, f: v4.fallback, n: v4.rounds.length }));
ok('通用·兜底明细恰 10 轮', v4.rounds.length === 10, String(v4.rounds.length));

var v5 = R.opposedFull(a, b, { rng: rng43_71 });
ok('opposedFull 通用 → 重掷 a 胜', v5.winner === 'a' && v5.decidedBy === 'reroll', JSON.stringify(v5.decidedBy));

var hi = R.check({ base: 50, value: 10 });   // 极难成功 (<=10)
var lo = R.check({ base: 50, value: 40 });
var v6 = R.opposedAttack(hi, lo, { mode: 'dodge' });
ok('等级高者胜（极难 > 常规）', v6.winner === 'a' && v6.decidedBy === 'level', JSON.stringify(v6.decidedBy));

var ra = R.resolveAttack({
  attack: { name: '射击', value: 90, ranged: true },
  defense: { name: '反击', value: 90, mode: 'fightback' },
  damage: { expr: '1D10', db: '0' }, armor: { value: 0 }, ranged: true,
  rng: feeder([0.3, 0.4, 0.1, 0.7, 0.5])
});
ok('resolveAttack 远程 fightback → 降级 dodge', ra.mode === 'dodge' && ra.coercedFromFightback === true, ra.mode);

var ra2 = R.resolveAttack({
  attack: { name: '格斗', value: 50, roll: 30 },
  defense: { name: '闪避', value: 50, mode: 'dodge', roll: 40 },
  damage: { expr: '1D3', db: '0' }, armor: { value: 0 }
});
ok('resolveAttack 闪避同级 → miss 且 damage.applied=0', ra2.outcome === 'miss' && ra2.damage.applied === 0, ra2.outcome + '/' + ra2.damage.applied);

var ra3 = R.resolveAttack({
  attack: { name: '格斗', value: 50, roll: 30 },
  defense: { name: '反击', value: 50, mode: 'fightback', roll: 40 },
  damage: { expr: '1D3', db: '0' }, armor: { value: 0 }, rng: feeder([0.5])
});
ok('resolveAttack 反击同级 → attacker_wins 且伤害>0', ra3.outcome === 'attacker_wins' && ra3.damage.applied > 0, ra3.outcome + '/' + ra3.damage.applied);

/* 雷达图占比（v2.2.0 用户第 4 项）：value 语义不变 + sum/pct/norm 正确 */
var dims = (C7 && C7.radar) ? C7.radar(
  [ { id: 'fist', total: 60 }, { id: 'gun', total: 40 }, { id: 'spot', total: 50 } ],
  [ { id: 'fist', category: '战斗' }, { id: 'gun', category: '战斗' }, { id: 'spot', category: '探索' } ]
) : null;
if (dims && dims.length) {
  var battle = null;
  dims.forEach(function (d) { if (d.key === '战斗') battle = d; });
  ok('雷达图：类别分 = 类内技能值之和（战斗=100）', !!battle && battle.sum === 100, battle && JSON.stringify(battle));
  if (battle) {
    ok('雷达图：pct = 类分/五类总分（100/150≈66.7）', Math.abs(battle.pct - 66.7) < 0.2, String(battle.pct));
    ok('雷达图：norm = pct/最大pct → 最大类=100', battle.norm === 100, String(battle.norm));
    ok('雷达图：value 仍为类内均值（战斗=(60+40)/2=50）', battle.value === 50, String(battle.value));
    var explore = null;
    dims.forEach(function (d) { if (d.key === '探索') explore = d; });
    ok('雷达图：探索 norm < 100（非最大类）', explore && explore.norm < 100 && explore.norm > 0, explore && String(explore.norm));
  }
} else {
  ok('雷达图 dims 存在', false, 'COC7.radar 不可用');
}

console.log('\nT01 (v2.2.0) selftest: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
