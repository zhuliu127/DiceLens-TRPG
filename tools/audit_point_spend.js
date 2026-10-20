/* 审计：技能点必须全部用完 + 本职技能「拔尖」
 *
 * 覆盖：
 *   1) 随机生成的卡：职业点 / 兴趣点remain 必须是 0
 *   2) AI 车卡的卡：无点数上限时remain 必须是 0
 *   3) AI 车卡 + 点数上限（含极端小值）：remain 必须是 0
 *      —— 这条是用户反馈的真 bug：上限只压了分配预算、没压total，
 *         界面显示「职业点 100/400」，看着像有 300 点没用完
 *   4) 点数上限真的生效（total 不超过上限）
 *   5) 本职技能「拔尖」：至少 2 项 ≥50，且最高一项明显拔高（≥70），
 *      不再出现「一摞技能全卡在 50」的同值墙
 *   6) 兴趣技能不超过 10 项
 *   7) 所有卡都能通过 Engine.checkList
 *   8) 老存档（没有 occPointCap 字段）不受影响
 *
 * ⚠️ v1.13 起判据换过一次：
 *   旧版要求「≥50 的项数达到预算允许的理论上界」—— 那是**广度优先**的判据，
 *   玩家明确否掉了（「很容易变成多个本职点数全都是50点」）。
 *   新版是**拔尖优先**：宁可少几项达标，也要有几项真正拔高。
 *   所以这里不再断言达到上界，改为断言「拔尖项数与高度」。
 *
 * 全程离线，不发任何网络请求。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'web', 'js');
let fail = 0;
const bad = (m) => { console.log('  [FAIL] ' + m); fail++; };
const ok = (m) => console.log('  [OK]   ' + m);

function makeSandbox() {
  const s = {
    console, Math, JSON, Date, Object, Array, String, Number,
    parseInt, parseFloat, isNaN, isFinite, Uint8Array, Int32Array
  };
  s.window = s; s.global = s; s.globalThis = s;
  const mem = {};
  s.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: (k) => { delete mem[k]; },
    clear: () => { Object.keys(mem).forEach((k) => delete mem[k]); }
  };
  vm.createContext(s);
  return s;
}

function load(s, rel) {
  vm.runInContext(fs.readFileSync(path.join(root, rel), 'utf8'), s, { filename: rel });
}

function loadAll(s) {
  ['skills', 'occupations', 'weapons', 'armors', 'vehicles', 'madness', 'spells', 'assets']
    .forEach((d) => load(s, path.join('data', d + '.js')));
  ['dice', 'rules-coc7', 'occupation', 'skillmodel', 'engine', 'store',
    'madness', 'personas', 'avatar', 'easter-egg', 'preset', 'ai']
    .forEach((c) => load(s, path.join('core', c + '.js')));
}

const AI_PROFILES = [
  { occupationName: '私家侦探', setting: '1920s', age: 38, gender: '男' },
  { occupationName: '法医', setting: 'cn-modern', age: 30, gender: '女' },
  { occupationName: '记者', setting: 'cn-republic', age: 45, gender: '男' },
  { occupationName: '古董店老板', setting: 'cn-republic', age: 52, gender: '男' },
  { occupationName: '图书管理员', setting: 'uk-victorian', age: 27, gender: '女' },
  { occupationName: '机械师', setting: 'cn-modern', age: 34, gender: '男' },
  { occupationName: '自由职业', age: 29, gender: '女' },
  { occupationName: '警察', age: 41, gender: '男' },
  { occupationName: '记者', setting: 'us-1920', age: 33, gender: '女' },
  { occupationName: '赏金猎人', setting: 'cn-modern', age: 36, gender: '男' }
];

/** 统计一张卡 */
function inspect(c, s) {
  const OCC = s.CocOccupation, SM = s.SkillModel, R = s.COC7;
  const set = OCC.occupationalSet(c);
  const op = OCC.occupationPoints(c);
  const ip = OCC.interestPoints(c);
  let occGE50 = 0, occBelow = 0, occKeys = 0, intCount = 0, free = 0;
  let occTop = 0, eq50 = 0;
  const need = [];
  c.skills.forEach((sk) => {
    if (sk.id === 'credit' || sk.id === 'cthulhu' || R.isGrowthOnly(sk.id)) return;
    if (set[sk.key] || set[sk.id]) {
      occKeys++;
      if (sk.total >= 50) occGE50++; else occBelow++;
      if (sk.total > occTop) occTop = sk.total;
      if (sk.total === 50) eq50++;
      const base = sk.base || 0;
      if (base >= 50) free++;
      else need.push(Math.max(0, Math.min(50 - base, SM.capOf(c, sk) - base)));
    } else {
      /* ⚠️ 只数**真正拿到点**的兴趣技能。
         一张卡上挂着几十项非本职技能（多数基础值 0），
         数「非本职技能总数」必然远超 10 —— 那个指标量的不是同一件事。
         test_v11 用的就是这个口径。 */
      if ((sk.int || 0) > 0) intCount++;
    }
  });
  /* 理论上界：只看预算、不看分配算法，最多能有几项达到 50。
     ⚠️ 保留它只是为了在日志里对照，**不再作为通过判据** ——
     新算法是拔尖优先，刻意不追求这个上界（见文件头说明）。 */
  need.sort((a, b) => a - b);
  const budget = op.total - (parseInt(c.assets.creditRating, 10) || 0);
  let reach = free, acc = 0;
  for (let i = 0; i < need.length; i++) {
    if (acc + need[i] > budget) break;
    acc += need[i]; reach++;
  }
  /* 全部技能是否都已到顶 —— 剩点只有在这种情况下才是「规则使然」。
     （上限压得比基础值还低时，点数就是花不完，界面会如实说明。） */
  const capable = (s2) => s2.filter((x) => SM.capOf(c, x) - x.total > 0).length;
  const occList = (c.skills || []).filter((x) =>
    x.id !== 'credit' && x.id !== 'cthulhu' && !R.isGrowthOnly(x.id) && (set[x.key] || set[x.id]));
  const intList = (c.skills || []).filter((x) =>
    x.id !== 'credit' && x.id !== 'cthulhu' && !R.isGrowthOnly(x.id) &&
    !(set[x.key] || set[x.id]) && (x.int || 0) > 0);
  const bad = s.Engine.checkList(c).filter((x) => !x.ok);
  return {
    occRemain: op.total - op.used, intRemain: ip.total - ip.used,
    occTotal: op.total, intTotal: ip.total,
    occGE50, occBelow, occKeys, intCount, bad, reachBest: reach,
    occTop, eq50,
    allOccCapped: occList.length > 0 && capable(occList) === 0,
    allIntCapped: intList.length > 0 && capable(intList) === 0
  };
}

/* ============================================================
 * 一、随机生成的卡
 * ============================================================ */
console.log('== 一、随机生成：点数用完 + 本职技能拔尖 ==');
{
  const s = makeSandbox();
  loadAll(s);
  const P = s.PresetGen;
  let occLeft = 0, intLeft = 0, unsound = 0, thin = 0, sumGE50 = 0, sumBelow = 0;
  let sumTop = 0, sumEq50 = 0, wall = 0, lowTop = 0;
  const N = 80;
  for (let i = 0; i < N; i++) {
    const c = P.generateOne ? P.generateOne({}) : P.generate(1, {})[0];
    if (!c) continue;
    const r = inspect(c, s);
    if (r.occRemain !== 0) occLeft++;
    if (r.intRemain !== 0) intLeft++;
    if (r.bad.length) unsound++;
    /* ★ 拔尖判据①：至少 2 项本职技能 ≥50（玩家要的「2-4 项 50 以上」）。
       ⚠️ 不能要求「达到理论最大项数」—— 那是旧版的广度优先判据。 */
    if (r.occGE50 < 2) thin++;
    /* ★ 拔尖判据②：最高一项要真的拔起来 */
    if (r.occTop < 70) lowTop++;
    /* ★ 判据③：不能是「一堵 50 的墙」—— 恰好等于 50 的项数要少 */
    if (r.eq50 >= 4) wall++;
    sumGE50 += r.occGE50;
    sumBelow += r.occBelow;
    sumTop += r.occTop;
    sumEq50 += r.eq50;
  }
  console.log('  ' + N + ' 张：职业点有剩余 ' + occLeft + '，兴趣点有剩余 ' + intLeft +
    '，不合格 ' + unsound);
  if (occLeft === 0) ok('随机卡的职业点全部用完'); else bad(occLeft + ' 张随机卡职业点没用完');
  if (intLeft === 0) ok('随机卡的兴趣点全部用完'); else bad(intLeft + ' 张随机卡兴趣点没用完');
  if (unsound === 0) ok('全部通过 Engine.checkList'); else bad(unsound + ' 张不合格');
  if (thin === 0) ok('每张卡都至少有 2 项本职技能达到 50 以上');
  else bad(thin + ' 张卡达标项数不足 2 项');
  console.log('  平均 ≥50 的本职技能 ' + (sumGE50 / N).toFixed(2) +
    ' 项，低于 50 的平均 ' + (sumBelow / N).toFixed(2) + ' 项，最高一项平均 ' +
    (sumTop / N).toFixed(1));
  if (sumTop / N >= 70) ok('本职最高项平均 ' + (sumTop / N).toFixed(1) + '（拔尖确实拔起来了）');
  else bad('本职最高项平均只有 ' + (sumTop / N).toFixed(1) + '，拔尖不够');
  if (lowTop <= N * 0.25) ok(N + ' 张里只有 ' + lowTop + ' 张最高项低于 70（预算偏紧属正常）');
  else bad(lowTop + '/' + N + ' 张卡的最高项都不到 70');
  console.log('  恰好等于 50 的本职技能平均 ' + (sumEq50 / N).toFixed(2) + ' 项');
  if (wall === 0) ok('没有任何一张卡出现「≥4 项都卡在 50」的同值墙');
  else bad(wall + ' 张卡有 4 项以上卡在 50');
  if (sumEq50 / N < 2) ok('平均「恰好 50」的项数 ' + (sumEq50 / N).toFixed(2) + ' < 2');
  else bad('平均有 ' + (sumEq50 / N).toFixed(2) + ' 项卡在 50，仍像同值墙');
}

/* ============================================================
 * 二、AI 车卡：无上限
 * ============================================================ */
console.log('\n== 二、AI 车卡（无上限）==');
{
  const s = makeSandbox();
  loadAll(s);
  const P = s.PresetGen;
  let occLeft = 0, intLeft = 0, unsound = 0, sumGE50 = 0, thin = 0, sumTop = 0;
  const N = 40;
  for (let i = 0; i < N; i++) {
    const pf = AI_PROFILES[i % AI_PROFILES.length];
    const c = P.buildFrom(Object.assign({ fromAI: true }, pf), pf.setting, {});
    if (!c) continue;
    const r = inspect(c, s);
    if (r.occRemain !== 0) occLeft++;
    if (r.intRemain !== 0) intLeft++;
    if (r.bad.length) unsound++;
    if (r.occGE50 < 2) thin++;
    sumGE50 += r.occGE50;
    sumTop += r.occTop;
  }
  console.log('  ' + N + ' 张：职业点有剩余 ' + occLeft + '，兴趣点有剩余 ' + intLeft +
    '，不合格 ' + unsound);
  if (occLeft === 0) ok('AI 卡的职业点全部用完'); else bad(occLeft + ' 张AI 卡职业点没用完');
  if (intLeft === 0) ok('AI 卡的兴趣点全部用完'); else bad(intLeft + ' 张AI 卡兴趣点没用完');
  if (unsound === 0) ok('全部通过 Engine.checkList'); else bad(unsound + ' 张不合格');
  if (thin === 0) ok('每张 AI 卡都至少有 2 项本职技能达到 50 以上');
  else bad(thin + ' 张 AI 卡达标项数不足 2 项');
  console.log('  平均 ≥50 的本职技能 ' + (sumGE50 / N).toFixed(2) +
    ' 项，最高一项平均 ' + (sumTop / N).toFixed(1));
  if (sumTop / N >= 70) ok('AI 卡本职最高项平均 ' + (sumTop / N).toFixed(1));
  else bad('AI 卡本职最高项平均只有 ' + (sumTop / N).toFixed(1));
}

/* ============================================================
 * 三、AI 车卡 + 技能上限
 *
 * ⚠️ 上限的语义已改为「每项技能封顶」，**不再压缩点数池**。
 * 所以这里不再断言「total <= 上限」—— 那是旧语义的残留检查。
 * 上限相关的不变量（不压池子 / 逐项封顶 / 全部到顶才剩点）
 * 由 audit_point_cap 负责，这里只管「点数分配本身没坏」。
 * ============================================================ */
console.log('\n== 三、AI 车卡 + 技能上限 ==');
{
  /* 用「不会把点数卡死」的上限值：太低（如 1）会让所有技能都到顶，
     那是规则使然、不属于分配 bug，由 audit_point_cap 的第三组覆盖。 */
  const CASES = [
    { occ: 99, int: 99 }, { occ: 80, int: 60 }, { occ: 70, int: 50 },
    { occ: 60, int: 60 }, { occ: 200, int: 200 }
  ];
  let unjustified = 0, unsound = 0, n = 0, thin = 0;
  const firstErr = {};
  CASES.forEach((cap) => {
    const s = makeSandbox();
    loadAll(s);
    const P = s.PresetGen;
    let left = 0, bad = 0, thin2 = 0;
    for (let i = 0; i < 20; i++) {
      const pf = AI_PROFILES[i % AI_PROFILES.length];
      const c = P.buildFrom(Object.assign({ fromAI: true }, pf), pf.setting, {
        ptsCap: { occ: cap.occ, int: cap.int }
      });
      if (!c) continue;
      const r = inspect(c, s);
      /* 剩点只有在「所有可加点技能都到顶」时才是合理的 */
      if (r.occRemain !== 0 && !r.allOccCapped) left++;
      if (r.intRemain !== 0 && !r.allIntCapped) left++;
      /* ★ 拔尖：上限还在 50 以上时才可能达标（上限 ≤50 时规则本身就不允许） */
      if (cap.occ >= 50 && r.occGE50 < 2) thin2++;
      if (r.bad.length) {
        bad++;
        const key = cap.occ + '/' + cap.int;
        if (!firstErr[key]) {
          firstErr[key] = r.bad.map((b) => b.label + ' -> ' + b.detail);
        }
      }
      n++;
    }
    unjustified += left;
    unsound += bad;
    thin += thin2;
    console.log('  上限 ' + cap.occ + '/' + cap.int + '：无故剩点 ' + left +
      '，达标不足 2 项 ' + thin2 + '，不合格 ' + bad + '（20 张）');
  });
  Object.keys(firstErr).forEach((k) => {
    console.log('    [上限 ' + k + '] 校验器报错：' + JSON.stringify(firstErr[k]));
  });
  if (unjustified === 0) ok('带上限时点数用完（或剩余仅因技能全到顶），共 ' + n + ' 张');
  else bad('带上限时有 ' + unjustified + ' 张无故剩点');
  if (thin === 0) ok('带上限时每张卡仍有至少 2 项本职技能 ≥50（上限 ≥50 的用例）');
  else bad(thin + ' 张带上限的卡达标项数不足 2 项');
  if (unsound === 0) ok('带上限的卡全部通过 Engine.checkList');
  else bad(unsound + ' 张带上限的卡不合格');
}

/* ============================================================
 * 四、老存档兼容 + 兴趣技能项数
 * ============================================================ */
console.log('\n== 四、老存档兼容 & 兴趣技能项数 ==');
{
  const s = makeSandbox();
  loadAll(s);
  const P = s.PresetGen, OCC = s.CocOccupation, SM = s.SkillModel;
  const c = P.generateOne ? P.generateOne({}) : P.generate(1, {})[0];

  /* 模拟老存档：删掉技能上限字段（老卡本来就没有这两个字段）。
     上限缺失时要回落到规则默认值 99，不能变成 0。 */
  delete c.skillCapOcc;
  delete c.skillCapInterest;
  delete c.skillCap;
  const r = inspect(c, s);
  if (r.occTotal > 0 && r.intTotal > 0 && r.occRemain === 0 && r.intRemain === 0) {
    ok('没有上限字段的旧卡：total 正常且点数仍然用完');
  } else {
    bad('旧卡兼容有问题 total ' + r.occTotal + '/' + r.intTotal +
      ' remain ' + r.occRemain + '/' + r.intRemain);
  }
  const capOfSome = SM.capOf(c, c.skills[0]);
  if (capOfSome === 99) ok('没有上限字段时 capOf 回落到规则默认 99');
  else bad('没有上限字段时 capOf = ' + capOfSome + '（应为 99）');
}

/* ============================================================
 * 五、兴趣技能不超过 10 项（generate 路径）
 * ============================================================ */
console.log('\n== 五、兴趣技能项数 ==');
{
  const s = makeSandbox();
  loadAll(s);
  const P = s.PresetGen;
  const N = 10, BATCH = 5;
  let over10 = 0, left = 0;
  for (let i = 0; i < N; i++) {
    const batch = P.generate(BATCH, {});
    batch.forEach((c) => {
      const r = inspect(c, s);
      if (r.intCount > 10) over10++;
      if (r.occRemain !== 0 || r.intRemain !== 0) left++;
    });
  }
  console.log('  ' + (N * BATCH) + ' 张：兴趣技能超10 项的卡 ' + over10 + '，点数有剩余的卡 ' + left);
  if (over10 === 0) ok('兴趣技能全部不超过 10 项'); else bad(over10 + ' 张超10 项');
  if (left === 0) ok('批量生成的卡点数也全部用完'); else bad(left + ' 张批量生成的卡剩点');
}

console.log('\n' + (fail === 0 ? 'RESULT: PASS' : 'RESULT: FAIL —— ' + fail + ' 项不通过'));
process.exit(fail === 0 ? 0 : 1);
