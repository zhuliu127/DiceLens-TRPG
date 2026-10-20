/* ============================================================
 * test_room_rules.js —— CoC 7e 规则服务单元测试（纯 Node，不需要浏览器）
 *
 * 对应需求文档 §16「验收标准 · 规则与战斗」那一节，逐条覆盖：
 *   · D100 的 00+0、01、奖励骰 / 惩罚骰 / 抵消
 *   · 普通 / 困难 / 极难阈值与向下取整
 *   · 大失败范围随「本次要求阈值」变化（96-100 vs 100）
 *   · 对抗检定的三级比较与平局重掷
 *   · 推动检定的适用范围
 *   · 幸运点的禁用范围与取整边界
 *   · SAN 成功 / 失败损失、单次 5 点与单日 1/5 提示
 *   · HP / 重大伤口 / 昏迷 / 濒死 / 致死
 *   · 战斗行动顺序与多行动怪物
 *
 * 用法：node tools/test_room_rules.js
 * 成功时最后一行打印 RESULT: PASS
 * ============================================================ */
'use strict';

global.window = global;
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
eval(fs.readFileSync(path.join(root, 'web/js/core/room-rules.js'), 'utf8'));

const R = global.CocRules;
const L = R.LEVEL;

/* ---------------- 迷你断言框架 ---------------- */
let pass = 0, fail = 0;
const failures = [];

function ok(cond, label, extra) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(label + (extra === undefined ? '' : '　→ 实际: ' + JSON.stringify(extra)));
}
function eq(actual, expected, label) {
  ok(actual === expected, label, actual);
}
/** 固定随机源：依次返回给定序列（循环），便于构造确定性骰面 */
function seq(values) {
  let i = 0;
  return function () { return values[i++ % values.length]; };
}
/** 固定返回同一个值（注意它是每次调用都返回，用于「同一面」的用例） */
function fixed(v) { return function () { return v; }; }
function section(title) { console.log('\n=== ' + title + ' ==='); }

/* ============================================================
 * 1. 百分骰组合
 * ============================================================ */
section('1. 百分骰组合（十位 + 个位）');
eq(R.combine(0, 0), 100, '00 与 0 组合为 100（不是 0）');
eq(R.combine(0, 5), 5, '00 与 5 组合为 5');
eq(R.combine(9, 9), 99, '90 与 9 组合为 99');
eq(R.combine(1, 0), 10, '10 与 0 组合为 10');

/* ============================================================
 * 2. 奖励骰 / 惩罚骰
 * ============================================================ */
section('2. 奖励骰 / 惩罚骰 / 抵消');
{
  // 无修正：单个十位骰
  const plain = R.rollD100({ ones: 0, forcedTens: [0] });
  eq(plain.value, 100, '无修正 + 十位 0 + 个位 0 → 100');
  eq(plain.tens.length, 1, '无修正只掷 1 个十位骰');

  /* ⭐ 关键回归：个位骰为 0 时，奖励骰必须取「更优的**结果**」而不是「更小的十位骰」。
     十位 {0,1} + 个位 0 → 组合为 100 与 10，奖励骰应得 10。
     早期 dice.js#d100Bonus 先取 min(十位) 再判 100，会得到 100，方向取反。 */
  const bonusEdge = R.rollD100({ bonus: 1, ones: 0, forcedTens: [0, 1] });
  eq(bonusEdge.value, 10, '奖励骰 + 十位{0,1} + 个位 0 → 取 10（不是 100）');
  eq(bonusEdge.pickedTens, 1, '奖励骰选中的十位骰是 1');

  const penaltyEdge = R.rollD100({ penalty: 1, ones: 0, forcedTens: [0, 1] });
  eq(penaltyEdge.value, 100, '惩罚骰 + 十位{0,1} + 个位 0 → 取 100（不是 10）');
  eq(penaltyEdge.pickedTens, 0, '惩罚骰选中的十位骰是 0');

  // 常规情况：十位 {3,7} 个位 5 → 35 / 75
  eq(R.rollD100({ bonus: 1, ones: 5, forcedTens: [3, 7] }).value, 35, '奖励骰取更低（35 / 75）');
  eq(R.rollD100({ penalty: 1, ones: 5, forcedTens: [3, 7] }).value, 75, '惩罚骰取更高（35 / 75）');

  // 2 个奖励骰
  const b2 = R.rollD100({ bonus: 2, ones: 4, forcedTens: [9, 2, 6] });
  eq(b2.tens.length, 3, '2 个奖励骰 = 原十位 + 2 个额外十位骰');
  eq(b2.value, 24, '3 个十位骰里取最低结果 24');

  // 抵消：1 奖励 + 1 惩罚 = 无修正（先抵消再掷，所以只有 1 个十位骰）
  const cancel = R.rollD100({ bonus: 1, penalty: 1, ones: 5, forcedTens: [7, 2] });
  eq(cancel.net, 0, '1 奖励 + 1 惩罚 → 净修正 0');
  eq(cancel.cancelled, 1, '记录被抵消掉的骰数');
  eq(cancel.tens.length, 1, '抵消后只掷 1 个十位骰');
  eq(cancel.value, 75, '抵消后结果就是单个十位骰的结果');

  // 2 奖励 + 1 惩罚 → 净 1 奖励
  const net = R.rollD100({ bonus: 2, penalty: 1, ones: 0, forcedTens: [8, 3] });
  eq(net.net, 1, '2 奖励 + 1 惩罚 → 净 1 奖励');
  eq(net.value, 30, '净奖励 1：十位 {8,3} + 个位 0 → 取 30');

  // 骰面全部记录（需求 §7.2：要让人看懂为什么选了这个结果）
  ok(bonusEdge.detail.indexOf('十位骰') >= 0 && bonusEdge.detail.indexOf('奖励骰') >= 0,
    '展示信息里带全部十位骰与选择理由', bonusEdge.detail);
}

/* ============================================================
 * 3. 阈值与成功等级
 * ============================================================ */
section('3. 阈值（向下取整）与成功等级');
{
  const t55 = R.thresholds(55);
  eq(t55.regular, 55, '55% 的常规阈值 = 55');
  eq(t55.hard, 27, '55% 的困难阈值 = 27（向下取整，不是 27.5）');
  eq(t55.extreme, 11, '55% 的极难阈值 = 11（向下取整）');
  eq(R.thresholds(7).hard, 3, '7% 的困难阈值 = 3（向下取整）');
  eq(R.thresholds(7).extreme, 1, '7% 的极难阈值 = 1');
  eq(R.thresholds(100).hard, 50, '100% 的困难阈值 = 50');

  eq(R.targetOf(55, 'hard'), 27, 'targetOf 困难');
  eq(R.targetOf(55, 'extreme'), 11, 'targetOf 极难');
  eq(R.targetOf(55, 'regular'), 55, 'targetOf 常规');
  eq(R.targetOf(55, '乱写的难度'), 55, '非法难度回落到常规');

  // 等级按技能值判定
  eq(R.levelOf(1, 50), L.CRITICAL, '01 永远是大成功');
  eq(R.levelOf(10, 50), L.EXTREME, '50% 掷 10 → 极难成功（≤ 10）');
  eq(R.levelOf(11, 50), L.HARD, '50% 掷 11 → 困难成功');
  eq(R.levelOf(25, 50), L.HARD, '50% 掷 25 → 困难成功（≤ 25）');
  eq(R.levelOf(26, 50), L.REGULAR, '50% 掷 26 → 常规成功');
  eq(R.levelOf(50, 50), L.REGULAR, '50% 掷 50 → 常规成功（含等于）');
  eq(R.levelOf(51, 50), L.FAIL, '50% 掷 51 → 失败');
  eq(R.levelOf(100, 50), L.FUMBLE, '50% 掷 100 → 大失败');
  /* 边界：阈值**正好** 50 时按「不低于 50」处理，只有 100 才是大失败。
     依据需求文档 §7.1：「所需成功阈值不低于 50 时掷出 100；低于 50 时 96-100」。
     这条与既有 dice.js#successLevel 的 `skill < 50` 口径一致。 */
  eq(R.levelOf(96, 50), L.FAIL, '50% 掷 96 → 只是失败（阈值 50 不低于 50）');
  eq(R.levelOf(100, 50), L.FUMBLE, '50% 掷 100 → 大失败');
  eq(R.levelOf(96, 49), L.FUMBLE, '49% 掷 96 → 大失败（阈值低于 50）');
}

/* ============================================================
 * 4. 大失败范围随「要求阈值」变化
 * ============================================================ */
section('4. 大失败范围取决于本次要求阈值（不是技能原值）');
{
  eq(R.fumbleRange(55).min, 100, '阈值 55（≥50）→ 只有 100 是大失败');
  eq(R.fumbleRange(27).min, 96, '阈值 27（<50）→ 96 起就是大失败');
  eq(R.fumbleRange(49).min, 96, '阈值 49 → 96 起就是大失败');
  eq(R.fumbleRange(50).min, 100, '阈值 50（不低于 50）→ 只有 100');

  /* 官方示例（规则书 Pg.91）：55% 的图书馆使用
       常规搜索 → 掷 96 只是失败
       烛光下做困难搜索（阈值 27）→ 掷 96 就是大失败 */
  const normalSearch = R.check({ base: 55, value: 96, kind: 'skill', label: '图书馆使用' });
  eq(normalSearch.level, L.FAIL, '55% 常规搜索掷 96 → 失败（不是大失败）');
  eq(normalSearch.fumble, false, '55% 常规搜索掷 96 不算大失败');

  const hardSearch = R.check({ base: 55, difficulty: 'hard', value: 96, kind: 'skill', label: '图书馆使用' });
  eq(hardSearch.target, 27, '困难搜索的要求阈值是 27');
  eq(hardSearch.level, L.FUMBLE, '55% 困难搜索（阈值 27）掷 96 → 大失败');
  eq(hardSearch.fumble, true, '困难搜索掷 96 算大失败');

  ok(hardSearch.summary.indexOf('大失败') >= 0 && hardSearch.summary.indexOf('27') >= 0,
    '结果说明里写清「为什么这次 96 是大失败」', hardSearch.summary);
}

/* ============================================================
 * 5. 检定：难度、通过与否、可推动性
 * ============================================================ */
section('5. 检定：难度要求与通过判定');
{
  // 80% 做困难检定（阈值 40）：掷 45 → 常规成功，但不够困难要求
  const c1 = R.check({ base: 80, difficulty: 'hard', value: 45, kind: 'skill' });
  eq(c1.level, L.REGULAR, '80% 掷 45 → 等级是常规成功');
  eq(c1.passed, false, '困难检定要求 45 ≤ 40，所以不算通过');

  const c2 = R.check({ base: 80, difficulty: 'hard', value: 40, kind: 'skill' });
  eq(c2.level, L.HARD, '80% 掷 40 → 困难成功');
  eq(c2.passed, true, '困难检定通过');

  const c3 = R.check({ base: 80, difficulty: 'extreme', value: 16, kind: 'skill' });
  eq(c3.level, L.EXTREME, '80% 掷 16 → 极难成功');
  eq(c3.passed, true, '极难检定通过');

  // 可推动性：成功的检定不该提示可推动
  eq(c3.canPush, false, '已通过的检定不能推动');
  const c4 = R.check({ base: 80, difficulty: 'hard', value: 45, kind: 'skill' });
  eq(c4.canPush, true, '失败的技能检定可以推动');
}

/* ============================================================
 * 6. 推动检定：适用范围
 * ============================================================ */
section('6. 推动检定只在允许的类型与失败结果上出现');
{
  const failedSkill = R.check({ base: 50, value: 70, kind: 'skill' });
  ok(failedSkill.canPush, '失败的技能检定可推动');

  const failedAttr = R.check({ base: 50, value: 70, kind: 'attribute' });
  ok(failedAttr.canPush, '失败的属性检定可推动');

  ['combat', 'san', 'opposed', 'luck', 'damage'].forEach(kind => {
    const r = R.check({ base: 50, value: 70, kind: kind });
    eq(R.canPush(r).ok, false, kind + ' 类型的失败检定不可推动');
    ok(R.canPush(r).reason.length > 0, kind + ' 不可推动时给出原因');
  });

  const fumble = R.check({ base: 50, value: 100, kind: 'skill' });
  eq(R.canPush(fumble).ok, false, '大失败不能被推动抹掉');

  const passed = R.check({ base: 50, value: 20, kind: 'skill' });
  eq(R.canPush(passed).ok, false, '成功的检定不需要推动');
}

/* ============================================================
 * 7. 幸运点
 * ============================================================ */
section('7. 幸运点：禁用范围与边界');
{
  const fail50 = R.check({ base: 50, value: 60, kind: 'skill' });
  const spent = R.spendLuck({ result: fail50, amount: 15, luckAvailable: 40 });
  ok(spent.ok, '失败的技能检定可以花幸运点');
  eq(spent.after, 45, '花 15 点 → 60 - 15 = 45');
  eq(spent.passed, true, '花完后达到常规成功');
  eq(spent.growthEligible, false, '花过幸运的检定不记技能成长（规则书 Pg.99）');

  const notEnough = R.spendLuck({ result: fail50, amount: 50, luckAvailable: 40 });
  eq(notEnough.ok, false, '幸运点不够时拒绝');
  ok(notEnough.reason.indexOf('不足') >= 0, '给出「点数不足」的原因');

  const onFumble = R.check({ base: 50, value: 100, kind: 'skill' });
  eq(R.spendLuck({ result: onFumble, amount: 10, luckAvailable: 99 }).ok, false, '大失败不能被幸运点抹掉');

  ['luck', 'san', 'damage'].forEach(kind => {
    const r = R.check({ base: 50, value: 70, kind: kind });
    const out = R.spendLuck({ result: r, amount: 10, luckAvailable: 99 });
    eq(out.ok, false, kind + ' 检定不能花幸运点');
    eq(r.canSpendLuck, false, kind + ' 检定的结果里也标记为不可花');
  });

  // 压到 01 的边界：多花的点数不予扣除
  const low = R.check({ base: 2, value: 3, kind: 'skill' });
  eq(low.level, L.FAIL, '技能 2% 掷 3 → 失败');
  const clamp = R.spendLuck({ result: low, amount: 10, luckAvailable: 40 });
  eq(clamp.after, 1, '结果最低只能压到 01');
  eq(clamp.spent, 2, '实际只扣 2 点（3 → 1）');
  eq(clamp.refund, 8, '多算的 8 点退回');
}

/* ============================================================
 * 8. 对抗检定
 * ============================================================ */
section('8. 对抗检定');
{
  const a = R.check({ base: 60, value: 20, kind: 'opposed' });   // 60% 掷 20 → 困难成功（困难阈值 30）
  const b = R.check({ base: 90, value: 60, kind: 'opposed' });   // 90% 掷 60 → 常规成功（困难阈值 45）
  eq(a.level, L.HARD, 'A 是困难成功');
  eq(b.level, L.REGULAR, 'B 是常规成功');
  const o1 = R.opposed(a, b);
  eq(o1.winner, 'a', '成功等级高者胜（困难 > 常规），与技能值无关');
  eq(o1.decidedBy, 'level', '由成功等级决定');

  /* ⚠️ opposed() 的返回值里 'a' / 'b' 指**第一个 / 第二个参数**，
     不是角色名字。下面这组特意让「技能值高的一方」当第二个参数，
     用来确认同名变量不会把断言写反。 */
  const lowSkill = R.check({ base: 30, value: 10, kind: 'opposed' });  // 30% → 困难阈值 15，掷 10 → 困难
  const highSkill = R.check({ base: 80, value: 30, kind: 'opposed' }); // 80% → 困难阈值 40，掷 30 → 困难
  eq(lowSkill.level, highSkill.level, '双方同级');
  const o2 = R.opposed(lowSkill, highSkill);
  eq(o2.winner, 'b', '同级时技能值更高者胜（80 > 30，高的一方是第二个参数）');
  eq(o2.decidedBy, 'value', '由技能值决定');

  // 同级同值 → 重掷
  const e = R.check({ base: 50, value: 20, kind: 'opposed' });
  const f = R.check({ base: 50, value: 25, kind: 'opposed' });
  const o3 = R.opposed(e, f);
  eq(o3.winner, null, '同级同值 → 无胜者');
  eq(o3.needsReroll, true, '需要重掷');
  eq(R.opposedReroll(30, 70).winner, 'a', '重掷骰值低者胜（30 < 70）');
  eq(R.opposedReroll(70, 30).winner, 'b', '重掷骰值低者胜（30 < 70，B 赢）');
  eq(R.opposedReroll(42, 42).needsReroll, true, '重掷又平局则继续重掷');
}

/* ============================================================
 * 9. 骰式解析与掷骰
 * ============================================================ */
section('9. 骰式解析（含上限校验）');
{
  ok(R.parseExpr('2D6+1').ok, '2D6+1 合法');
  ok(R.parseExpr('1D10').ok, '1D10 合法');
  ok(R.parseExpr('3').ok, '纯数字合法');
  ok(R.parseExpr('1D6+1D4+2').ok, '多个骰项合法');
  ok(R.parseExpr('1d6-1').ok, '小写与减号合法');
  eq(R.parseExpr('999D999').ok, false, '骰子数量超过 100 被拒');
  eq(R.parseExpr('1D1').ok, false, '骰面小于 2 被拒');
  eq(R.parseExpr('100D1001').ok, false, '骰面超过 1000 被拒');
  eq(R.parseExpr('').ok, false, '空骰式被拒');
  eq(R.parseExpr('abc').ok, false, '乱写的内容被拒');
  eq(R.parseExpr('2D6*3').ok, false, '不支持乘法（少一种语法少一个注入面）');

  eq(R.rollExpr('1D6', fixed(0.5)).total, 4, '1D6 固定随机源 0.5 → 4');
  eq(R.rollExpr('1D6', fixed(0)).total, 1, '随机源 0 → 最小 1');
  eq(R.rollExpr('1D6', fixed(0.9999)).total, 6, '随机源接近 1 → 最大 6');
  eq(R.rollExpr('2D6+1', fixed(0.5)).total, 9, '2D6+1 固定 0.5 → 4+4+1 = 9');
  eq(R.rollExpr('0', fixed(0.5)).total, 0, '常数 0 → 0');
  eq(R.rollExpr('999D999', fixed(0.5)).ok, false, '非法骰式掷骰时返回失败而不是静默给 0');

  eq(R.rollDamageBonus('+1D4', fixed(0)).total, 1, '伤害加值 +1D4 固定最小 → 1');
  eq(R.rollDamageBonus('0', fixed(0.5)).total, 0, '伤害加值 0 → 0');
  eq(R.rollDamageBonus('-2', fixed(0.5)).total, -2, '伤害加值可以为负');
}

/* ============================================================
 * 10. SAN 检定与疯狂提示
 * ============================================================ */
section('10. SAN 检定与疯狂提示');
{
  eq(R.parseSanLoss('0/1D6').ok, true, '0/1D6 合法');
  eq(R.parseSanLoss('1/1D4').ok, true, '1/1D4 合法');
  eq(R.parseSanLoss('1D3/1D10').ok, true, '1D3/1D10 合法');
  eq(R.parseSanLoss('0').ok, false, '缺少斜线被拒');
  eq(R.parseSanLoss('0/1D6/2').ok, false, '斜线多于一个被拒');
  eq(R.parseSanLoss('0/999D999').ok, false, '损失侧骰式超限被拒');

  // 成功分支：损失 0
  const okCase = R.resolveSanCheck({
    currentSan: 60, maxSan: 60, lossExpr: '0/1D6',
    checkResult: { passed: true, level: L.REGULAR, value: 30, kind: 'san' }
  });
  ok(okCase.ok, '成功分支结算成功');
  eq(okCase.usedBranch, 'onSuccess', '走「成功损失」分支');
  eq(okCase.loss, 0, '0/1D6 成功时损失 0');
  eq(okCase.after, 60, 'SAN 不变');

  // 失败分支：1D6，固定随机源
  const failCase = R.resolveSanCheck({
    currentSan: 60, maxSan: 60, lossExpr: '0/1D6', rng: fixed(0.5),
    checkResult: { passed: false, level: L.FAIL, value: 80, kind: 'san' }
  });
  eq(failCase.usedBranch, 'onFail', '走「失败损失」分支');
  eq(failCase.loss, 4, '1D6 固定随机源 0.5 → 损失 4');
  eq(failCase.after, 56, 'SAN 60 → 56');

  // 不能把 SAN 扣成负数
  const floorCase = R.resolveSanCheck({
    currentSan: 2, maxSan: 60, lossExpr: '0/2D6', rng: fixed(0.9999),
    checkResult: { passed: false, level: L.FAIL, value: 99, kind: 'san' }
  });
  eq(floorCase.after, 0, 'SAN 最低扣到 0，不会变成负数');

  // 损失为 0 的检定不该消耗 SAN
  const noLoss = R.resolveSanCheck({
    currentSan: 40, maxSan: 40, lossExpr: '0/0', rng: fixed(0.5),
    checkResult: { passed: false, level: L.FAIL, value: 90, kind: 'san' }
  });
  eq(noLoss.loss, 0, '0/0 的检定失败也不掉 SAN');

  // 疯狂提示
  const f1 = R.insanityFlags({ loss: 5, dayStartSan: 60, dayLossSoFar: 0 });
  eq(f1.temporary, true, '单次损失 5 点 → 提示 INT 检定（临时疯狂）');
  ok(f1.temporaryReason.indexOf('INT') >= 0, '提示里点明要做 INT 检定', f1.temporaryReason);
  eq(R.insanityFlags({ loss: 4, dayStartSan: 60 }).temporary, false, '单次损失 4 点不触发');

  const f2 = R.insanityFlags({ loss: 4, dayStartSan: 50, dayLossSoFar: 6 });
  eq(f2.dayTotal, 10, '当日累计 = 之前 6 + 本次 4');
  eq(f2.indefinite, true, '累计 10 点达到 50 的五分之一 → 提示不定性疯狂');
  eq(R.insanityFlags({ loss: 3, dayStartSan: 50, dayLossSoFar: 6 }).indefinite, false,
    '累计 9 点未达阈值 → 不提示');
  eq(R.insanityFlags({ loss: 1, dayStartSan: 0 }).indefinite, false, '当天开始 SAN 为 0 时不误报');
}

/* ============================================================
 * 11. HP / 伤势
 * ============================================================ */
section('11. HP、重大伤口、昏迷、濒死、致死');
{
  // 最大 HP 12，单次伤害 6 → 正好一半 → 重大伤口
  const w1 = R.damageFlags({ damage: 6, maxHP: 12, currentHP: 12 });
  eq(w1.majorWound, true, '单次伤害 6 = 最大 12 的一半 → 重大伤口');
  eq(w1.needsConCheck, true, '重大伤口需要 CON 检定');
  eq(w1.after, 6, 'HP 12 → 6');
  eq(w1.state, 'normal', '还有 HP，状态正常存活');

  eq(R.damageFlags({ damage: 5, maxHP: 12, currentHP: 12 }).majorWound, false,
    '单次伤害 5 < 一半 → 不构成重大伤口');

  // v2.8.0（HP 机制 · 口径变更）：单次伤害 **> 最大 HP** → 致死；恰等于上限 → 重伤 → 濒死
  const w2 = R.damageFlags({ damage: 12, maxHP: 12, currentHP: 12 });
  eq(w2.lethal, false, '单次伤害 12 = 最大 HP → 不再致死（阈值改为 >）');
  eq(w2.state, 'dying', '12 = 上限：HP 归零且有重大伤口 → 濒死');
  const w2b = R.damageFlags({ damage: 13, maxHP: 12, currentHP: 12 });
  eq(w2b.lethal, true, '单次伤害 13 > 最大 HP → 致死');
  eq(w2b.state, 'dead', '状态为死亡');

  // HP 归零但无重大伤口 → 昏迷
  const w3 = R.damageFlags({ damage: 5, maxHP: 12, currentHP: 5 });
  eq(w3.after, 0, 'HP 归零');
  eq(w3.majorWound, false, '本次伤害不构成重大伤口');
  eq(w3.state, 'unconscious', 'HP 归零且无重大伤口 → 昏迷');

  // HP 归零且有重大伤口 → 濒死
  const w4 = R.damageFlags({ damage: 5, maxHP: 12, currentHP: 5, majorWound: true });
  eq(w4.state, 'dying', 'HP 归零且处于重大伤口 → 濒死');
  eq(w4.requireFirstAid, true, '濒死需要急救处理');

  // 伤害是负数或非数字时不产生异常状态
  const w5 = R.damageFlags({ damage: -3, maxHP: 12, currentHP: 12 });
  eq(w5.damage, 0, '负伤害按 0 处理');
  eq(w5.state, 'normal', '负伤害不改变状态');

  // 说明文本要能解释来源（需求 §16：状态变化能在记录中解释来源）
  ok(w1.summary.indexOf('CON') >= 0 && w1.summary.indexOf('重大伤口') >= 0,
    '重大伤口的说明里写明原因与后续处理', w1.summary);
  ok(w2b.summary.indexOf('致死') >= 0, '致死的说明里写明来源', w2b.summary);

  // 濒死每轮 CON 检定：45 ≤ 50 → 稳定；55 > 50 → 死亡
  const stable = R.dyingRoundCheck(50, seq([0.5, 0.4]));
  eq(stable.check.value, 45, '濒死检定掷出 45');
  eq(stable.stable, true, 'CON 检定成功 → 本轮稳定');
  const die = R.dyingRoundCheck(50, seq([0.5, 0.6]));
  eq(die.check.value, 65, '濒死检定掷出 65');
  eq(die.dead, true, 'CON 检定失败 → 死亡');
}

/* ============================================================
 * 12. 战斗行动顺序
 * ============================================================ */
section('12. 战斗行动顺序与多行动怪物');
{
  const actors = [
    { id: 'pc1', name: '丁铭', dex: 60, readyFirearm: true },        // 已准备枪械 → 60+50 = 110
    { id: 'npc1', name: '深潜者', dex: 90 },
    { id: 'npc2', name: '修格斯', dex: 40, actionsPerRound: 3 }
  ];
  const o = R.initiativeOrder(actors);
  eq(o.order.length, 5, '队列长度 = 1 + 1 + 3（多行动怪物展开为多个行动槽）');
  eq(o.order[0].id, 'pc1', '已准备枪械按 DEX+50 先手');
  eq(o.order[0].effDex, 110, '生效 DEX = 60 + 50');
  eq(o.order[1].id, 'npc1', '其次按 DEX 90');
  eq(o.order[2].id, 'npc2', 'DEX 40 排最后');
  eq(o.order.filter(x => x.id === 'npc2').length, 3, '修格斯占 3 个行动槽');
  eq(o.order[4].slot, 3, '第三槽的序号是 3');
  eq(o.order[4].lastSlot, true, '第三槽是该角色本轮最后一次行动');
  eq(o.order[2].lastSlot, false, '第一槽不是最后一次行动');

  const noReady = R.initiativeOrder(actors, { useReadyFirearm: false });
  eq(noReady.order[0].id, 'npc1', '关闭「已准备枪械 +50」后由 DEX 最高的先手');

  // KP 手动调整：标为 manual，且排在手工序列里
  const manual = R.initiativeOrder([
    { id: 'a', name: 'A', dex: 90 },
    { id: 'b', name: 'B', dex: 10, manualOrder: 0 }
  ]);
  eq(manual.order[0].id, 'b', 'KP 手动指定的条目优先');
  eq(manual.order[0].manual, true, '手动条目必须带标记（界面要看得出来）');
  eq(manual.manualCount, 1, '统计手动条目数');
  eq(manual.order[1].manual, false, '其余条目仍按规则排序');

  // 多行动怪物不会因为「完成一次行动」消失：走完一轮回到队首，槽位仍在
  let idx = 0, round = 1;
  for (let i = 0; i < o.order.length; i++) {
    const adv = R.advanceTurn(idx, round, o.order.length);
    idx = adv.index; round = adv.round;
  }
  eq(idx, 0, '走完一轮回到队首');
  eq(round, 2, '回合号 +1');
  eq(o.order.filter(x => x.id === 'npc2').length, 3, '下一轮修格斯仍有 3 次行动');

  const mid = R.advanceTurn(0, 1, 5);
  eq(mid.index, 1, '推进到下一个行动项');
  eq(mid.roundWrapped, false, '未换轮');
  eq(R.advanceTurn(4, 3, 5).roundWrapped, true, '最后一个行动项推进后换轮');
  ok(o.summary.indexOf('修格斯') >= 0 && o.summary.indexOf('第 1/3 次行动') >= 0,
    '展示文本里写明多行动槽', o.summary);
}

/* ============================================================
 * 13. 战斗结算 resolveAttack（契约 §4.1）
 * ------------------------------------------------------------
 * 全部用确定性 rng（seq），并依赖 resolveAttack 的 rng 消耗顺序：
 *   ① 攻击方检定 2 次（个位骰、十位骰）
 *   ② 防御方检定 2 次（mode ≠ 'none'）
 *   ③ 伤害主掷（每骰 1 次） ④ 伤害加值 ⑤ 贯穿追加骰 ⑥ 平局重掷（每轮 4 次）
 * die10 取值映射：0.05→0 0.15→1 0.25→2 0.35→3 0.45→4 0.55→5 0.65→6 0.75→7 0.85→8 0.95→9
 * ============================================================ */
section('13. 战斗结算 resolveAttack');
{
  /* 大成功（01）命中：攻击方检定掷 01，mode='none' → 纯命中 */
  const crit = R.resolveAttack({
    attack: { name: '格斗(斗殴)', value: 50 },
    defense: { mode: 'none' },
    damage: { expr: '1D6', db: '0' },
    rng: seq([0.15, 0.05, 0.85])            // 个位 1 / 十位 0 → 01；伤害 1D6 → 6
  });
  eq(crit.attack.level, L.CRITICAL, '攻击掷 01 → 大成功');
  eq(crit.outcome, 'hit', '无人防御 → 纯命中');
  eq(crit.level, 'critical', 'level 归一为 critical');
  eq(crit.damage.raw, 6, '1D6 固定 0.85 → 6');
  eq(crit.defense, null, 'mode=none 时没有防御检定结果');

  /* 大失败（100）落空：攻击方检定掷 100 → 不掷伤害骰 */
  const fumble = R.resolveAttack({
    attack: { name: '格斗(斗殴)', value: 50 },
    defense: { mode: 'none' },
    damage: { expr: '1D6', db: '0' },
    rng: seq([0.05, 0.05])                  // 个位 0 / 十位 0 → 100
  });
  eq(fumble.attack.level, L.FUMBLE, '攻击掷 100 → 大失败');
  eq(fumble.outcome, 'miss', '大失败 → 落空');
  eq(fumble.level, 'fumble', 'level 归一为 fumble');
  eq(fumble.damage.raw, 0, '落空不掷伤害骰，伤害为 0');

  /* 贯穿：极难成功时取最大值 + 追加一次伤害骰（1D8 → 8 + 1D8） */
  const impale = R.resolveAttack({
    attack: { name: '矛', value: 60 },
    defense: { mode: 'none' },
    damage: { expr: '1D8', db: '0' },
    impale: true,
    rng: seq([0.05, 0.15, 0.05, 0.99])      // 攻击 10（≤12 极难）；主掷 1；追加 8
  });
  eq(impale.attack.level, L.EXTREME, '攻击掷 10（≤12）→ 极难成功');
  eq(impale.damage.impale, true, '贯穿生效');
  eq(impale.damage.raw, 16, '取最大值 8 + 追加 8 = 16');

  /* 贯穿不触发：常规成功只掷一次伤害骰 */
  const noImpale = R.resolveAttack({
    attack: { name: '矛', value: 60 },
    defense: { mode: 'none' },
    damage: { expr: '1D8', db: '0' },
    impale: true,
    rng: seq([0.05, 0.45, 0.05])            // 攻击 40（常规）；主掷 1
  });
  eq(noImpale.attack.level, L.REGULAR, '攻击掷 40 → 常规成功');
  eq(noImpale.damage.impale, false, '常规成功不触发贯穿');
  eq(noImpale.damage.raw, 1, '只掷一次 1D8 → 1');

  /* 护甲吃满：减免后为 0（不为负） */
  const armorFull = R.resolveAttack({
    attack: { name: '拳', value: 50 },
    defense: { mode: 'none' },
    damage: { expr: '1D4', db: '0' },
    armor: { value: 5 },
    rng: seq([0.05, 0.35, 0.05])            // 攻击 30；伤害 1D4 → 1
  });
  eq(armorFull.damage.raw, 1, '伤害骰 1');
  eq(armorFull.damage.armor, 5, '护甲 5 点');
  eq(armorFull.damage.applied, 0, '护甲吃满 → 实际伤害 0（不为负）');

  /* 护甲部分减免 */
  const armorPart = R.resolveAttack({
    attack: { name: '拳', value: 50 },
    defense: { mode: 'none' },
    damage: { expr: '1D6', db: '0' },
    armor: { value: 2, type: '皮甲' },
    rng: seq([0.05, 0.35, 0.85])            // 攻击 30；伤害 1D6 → 6
  });
  eq(armorPart.damage.applied, 4, '6 - 2 = 4');

  /* 反击胜：防御方等级更高 → 由防御方造成伤害 */
  const fbWin = R.resolveAttack({
    attack: { name: '小刀', value: 50 },
    defense: { name: '斗殴', value: 80, mode: 'fightback' },
    damage: { expr: '1D6', db: '0' },
    rng: seq([0.05, 0.35, 0.05, 0.15, 0.85]) // 攻击 30（常规）；防御 10（极难）；伤害 6
  });
  eq(fbWin.attack.level, L.REGULAR, '攻击方常规成功');
  eq(fbWin.defense.level, L.EXTREME, '防御方极难成功');
  eq(fbWin.outcome, 'defender_wins', '反击方胜出');
  eq(fbWin.damageBy, 'defender', '伤害由防御方造成');
  eq(fbWin.damage.applied, 6, '反击造成 6 点伤害');

  /* 反击负：攻击方等级更高 → 攻击方命中 */
  const fbLose = R.resolveAttack({
    attack: { name: '小刀', value: 50 },
    defense: { name: '斗殴', value: 50, mode: 'fightback' },
    damage: { expr: '1D6', db: '0' },
    rng: seq([0.05, 0.25, 0.05, 0.45, 0.85]) // 攻击 20（困难）；防御 40（常规）；伤害 6
  });
  eq(fbLose.attack.level, L.HARD, '攻击方困难成功');
  eq(fbLose.defense.level, L.REGULAR, '防御方常规成功');
  eq(fbLose.outcome, 'attacker_wins', '攻击方等级更高 → 命中');
  eq(fbLose.damageBy, 'attacker', '伤害由攻击方造成');
  eq(fbLose.damage.applied, 6, '攻击造成 6 点伤害');

  /* 闪避成功免伤 */
  const dodged = R.resolveAttack({
    attack: { name: '小刀', value: 50 },
    defense: { name: '闪避', value: 80, mode: 'dodge' },
    damage: { expr: '1D6', db: '0' },
    rng: seq([0.05, 0.45, 0.05, 0.15])       // 攻击 40（常规）；防御 10（极难）
  });
  eq(dodged.outcome, 'miss', '闪避胜出 → 攻击落空');
  eq(dodged.damage.raw, 0, '被闪避 → 未造成伤害');
  ok(dodged.summary.indexOf('闪避') >= 0, '结论里说明是闪避成功', dodged.summary);

  /* 远程不可反击：fightback 被降级为 dodge，不产生反击伤害 */
  const ranged = R.resolveAttack({
    attack: { name: '手枪', value: 50 },
    defense: { name: '斗殴', value: 80, mode: 'fightback' },
    ranged: true,
    damage: { expr: '1D10', db: '0' },
    rng: seq([0.05, 0.35, 0.05, 0.15])       // 攻击 30（常规）；防御 10（极难）
  });
  eq(ranged.mode, 'dodge', '远程把反击降级为闪避');
  eq(ranged.coercedFromFightback, true, '记录被降级');
  eq(ranged.outcome, 'miss', '作为闪避处理 → 落空，不产生反击伤害');
  eq(ranged.damage.raw, 0, '远程不可反击 → 无伤害');

  /* 闪避同级：v2.2.0 新语义 —— 双方成功等级相同 → 闪避方**直接胜**（不再比技能值、不重掷） */
  const dodgeSameLvl = R.resolveAttack({
    attack: { name: '格斗', value: 60 },
    defense: { name: '闪避', value: 90, mode: 'dodge' },
    damage: { expr: '1D6', db: '0' },
    rng: seq([0.05, 0.25, 0.05, 0.35])       // 攻击 20（困难）；防御 30（困难）→ 同级
  });
  eq(dodgeSameLvl.attack.level, L.HARD, '攻击方困难成功');
  eq(dodgeSameLvl.defense.level, L.HARD, '防御方困难成功');
  eq(dodgeSameLvl.compare.decidedBy, 'mode_dodge_tie', '闪避同级 → 模式判定（不再比技能值）');
  eq(dodgeSameLvl.compare.winner, 'b', '闪避同级 → 防守方胜');
  eq(dodgeSameLvl.outcome, 'miss', '闪避胜出 → 落空');
  eq(dodgeSameLvl.damage.applied, 0, '免伤：applied=0');

  /* 闪避同级同值：v2.2.0 新语义 —— 不重掷（此前的通用重掷已按模式短路） */
  const dodgeTie = R.resolveAttack({
    attack: { name: '格斗', value: 50 },
    defense: { name: '闪避', value: 50, mode: 'dodge' },
    damage: { expr: '1D4', db: '0' },
    rng: seq([0.05, 0.35, 0.05, 0.35])       // 双方 30（同级同值）
  });
  eq(dodgeTie.compare.decidedBy, 'mode_dodge_tie', '闪避同级同值 → 模式判定');
  eq(dodgeTie.compare.winner, 'b', '闪避同级同值 → 防守方胜');
  eq((dodgeTie.compare.rounds || []).length, 0, '闪避同级不重掷（rounds 为空）');
  eq(dodgeTie.outcome, 'miss', '闪避胜出 → 落空');
  eq(dodgeTie.damage.applied, 0, '免伤：applied=0');

  /* 反击同级：v2.2.0 新语义 —— 攻击方**直接胜**（不重掷），伤害照常结算 */
  const counterTie = R.resolveAttack({
    attack: { name: '格斗', value: 50 },
    defense: { name: '反击', value: 50, mode: 'fightback' },
    damage: { expr: '1D4', db: '0' },
    rng: seq([0.05, 0.35, 0.05, 0.35, 0.05]) // 双方 30 同级；伤害 1D4 → 1
  });
  eq(counterTie.compare.decidedBy, 'mode_fightback_tie', '反击同级 → 模式判定（不重掷）');
  eq(counterTie.compare.winner, 'a', '反击同级 → 攻击方胜');
  eq(counterTie.outcome, 'attacker_wins', '攻击方命中');
  eq(counterTie.damage.applied, 1, '1D4 固定 0.05 → 1 点伤害');

  /* 通用对抗（mode none）同级同值：仍按规则**逐轮重掷**（≤10 轮兜底）——
     这条覆盖 opposedAttack 的通用分支（resolveAttack 的 none 分支不经过它）。 */
  const genA = R.check({ base: 50, value: 30 });
  const genB = R.check({ base: 50, value: 30 });
  const genVerdict = R.opposedAttack(genA, genB, { mode: 'none', rng: seq([0.05, 0.45, 0.05, 0.65]) });
  eq(genVerdict.decidedBy, 'reroll', '通用同级同值 → 重掷');
  eq(genVerdict.winner, 'a', '重掷低者（40 < 60）胜');
  eq(genVerdict.rounds.length, 1, '记录了一次重掷');
  eq(genVerdict.rounds[0].aRoll, 40, '攻击方重掷 40');
  eq(genVerdict.rounds[0].bRoll, 60, '防御方重掷 60');

  /* flags 复用 damageFlags（给了目标 HP） */
  const flagged = R.resolveAttack({
    attack: { name: '斧', value: 50 },
    defense: { mode: 'none' },
    damage: { expr: '1D8', db: '0' },
    maxHP: 12, currentHP: 12,
    rng: seq([0.05, 0.35, 0.99])             // 攻击 30；伤害 1D8 → 8
  });
  eq(flagged.damage.applied, 8, '造成 8 点伤害');
  eq(flagged.flags.majorWound, true, '8 ≥ 12 的一半 → 重大伤口');
  eq(flagged.flags.dead, false, '未致死');

  /* 未给目标 HP → flags 带 unknown 标记（不抛异常） */
  const noHP = R.resolveAttack({
    attack: { name: 'x', value: 50 }, defense: { mode: 'none' },
    damage: { expr: '0', db: '0' }, rng: seq([0.05, 0.35])
  });
  eq(noHP.flags.unknown, true, '未给目标 HP → flags 带 unknown 标记');
}

/* ============================================================
 * 14. 角色卡取值 skillValue / attrValue（契约 §4.2 / §6.1）
 * ============================================================ */
section('14. 角色卡取值（skillValue / attrValue）');
{
  const sheet = {
    attrs: { str: 60, con: 55, siz: 65, dex: 70, app: 45, int: 80, pow: 50, edu: 75, luck: 40 },
    skills: [
      { name: '侦查', total: 65 },
      { name: '格斗(斗殴)', total: 55 },
      { name: '图书馆使用', total: 70 }
    ]
  };
  eq(R.skillValue(sheet, '侦查'), 65, '精确命中技能');
  eq(R.skillValue(sheet, '格斗'), 55, '模糊命中：格斗 → 格斗(斗殴)');
  eq(R.skillValue(sheet, '斗殴'), 55, '别名命中：斗殴 → 格斗(斗殴)');
  eq(R.skillValue(sheet, '不存在的技能'), null, '查不到返回 null');
  eq(R.skillValue(null, '格斗'), null, 'sheet 为 null 返回 null（不抛异常）');
  eq(R.skillValue({}, '格斗'), null, 'sheet 无 skills 返回 null');

  // 歧义：两个同基名技能 → 保守返回 null
  const ambiguous = { skills: [{ name: '格斗(斗殴)', total: 55 }, { name: '格斗(剑)', total: 40 }] };
  eq(R.skillValue(ambiguous, '格斗'), null, '基名歧义（斗殴/剑）→ 返回 null');

  eq(R.attrValue(sheet, '力量'), 60, '中文属性名');
  eq(R.attrValue(sheet, 'str'), 60, 'key 小写');
  eq(R.attrValue(sheet, 'STR'), 60, 'key 大写');
  eq(R.attrValue(sheet, '敏捷'), 70, '中文敏捷');
  eq(R.attrValue(sheet, '不存在'), null, '查不到返回 null');
  eq(R.attrValue(null, '力量'), null, 'sheet 为 null 返回 null');
  eq(R.attrValue({}, '力量'), null, 'sheet 无 attrs 返回 null');
}

/* ============================================================
 * 15. 场景检定步骤 sceneStepPlan / sceneStepResolve（契约 §4.3）
 * ============================================================ */
section('15. 场景检定步骤（sceneStepPlan / sceneStepResolve）');
{
  const step = {
    id: 's1', title: '撬锁', desc: '尝试撬开抽屉',
    targetSeat: 2, skill: '锁匠', difficulty: 'regular', bonus: 1, penalty: 0,
    onSuccess: { note: '抽屉开了', next: 's2' },
    onFailure: { damage: '1D3', note: '锁针扎手' }
  };
  const plan = R.sceneStepPlan(step);
  eq(plan.targetSeat, 2, '计划里带目标座位');
  eq(plan.skill, '锁匠', '计划里带技能');
  eq(plan.difficulty, 'regular', '计划里带难度');
  eq(plan.bonus, 1, '计划里带奖励骰');
  eq(plan.branches.success.note, '抽屉开了', '成功分支的备注');
  eq(plan.branches.failure.damage, '1D3', '失败分支的伤害式');

  const okStep = R.sceneStepResolve(step, L.REGULAR);
  eq(okStep.success, true, '常规成功走成功分支');
  eq(okStep.branch, 'success', '分支名 success');
  eq(okStep.next, 's2', '成功分支跳转到 s2');
  eq(okStep.done, false, '有下一步 → 未结束');

  const failStep = R.sceneStepResolve(step, L.FAIL);
  eq(failStep.success, false, '失败走失败分支');
  eq(failStep.branch, 'failure', '分支名 failure');
  eq(failStep.damage, '1D3', '失败分支带伤害式');
  eq(failStep.done, true, '无跳转 → 该步结束');

  // 最后一步：成功分支没有 next → done
  const last = { id: 's2', targetSeat: 1, skill: '侦查', onSuccess: { note: '结束' } };
  const lastRes = R.sceneStepResolve(last, L.REGULAR);
  eq(lastRes.done, true, '最后一步 → done');
  eq(lastRes.next, null, '没有跳转时 next 为 null');
  eq(lastRes.note, '结束', '带备注');

  // 困难难度：常规成功不算通过，困难成功才算
  const hardStep = { id: 's3', targetSeat: 1, skill: '侦查', difficulty: 'hard',
    onSuccess: { note: 'A' }, onFailure: { note: 'B' } };
  eq(R.sceneStepResolve(hardStep, L.REGULAR).success, false, '困难步骤：常规成功不算通过');
  eq(R.sceneStepResolve(hardStep, L.HARD).success, true, '困难步骤：困难成功算通过');

  // 终止符 'end'（E 线约定 next==='end' 表示结束）：next 原样回传且 done 为真
  const endStep = { id: 's4', targetSeat: 1, skill: '侦查', onSuccess: { next: 'end', note: '完结' } };
  const endRes = R.sceneStepResolve(endStep, L.REGULAR);
  eq(endRes.next, 'end', "终止符 'end' 原样回传（兼容 E 线约定）");
  eq(endRes.done, true, "next==='end' 时 done 为真");
  eq(R.sceneStepResolve({ id: 's5', targetSeat: 1, skill: '侦查', onSuccess: { next: 's6' } }, L.REGULAR).done,
    false, 'next 为具体 stepId 时 done 为假（继续跳转）');
}

/* ============================================================
 * 汇总
 * ============================================================ */
console.log('\n' + '='.repeat(60));
if (fail === 0) {
  console.log('全部通过：' + pass + ' 项断言');
  console.log('RESULT: PASS');
} else {
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项：');
  failures.forEach(f => console.log('  ✗ ' + f));
  console.log('RESULT: FAIL');
  process.exitCode = 1;
}
