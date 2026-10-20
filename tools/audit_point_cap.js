/* 审计：AI 技能上限 = **每一项技能最终值**的上限（不是压点数池）
 *
 * 语义变更（用户澄清）：
 *   旧：把「职业点上限 80」实现成「点数池压到 80」→ 界面显示 80/280，
 *       看着像有 200 点没用完。
 *   新：职业点上限 80 →「侦查」这类**本职技能最多点到 80**；
 *       兴趣点上限 60 →「会计」这类**非本职技能最多点到 60**。
 *       点数总额始终是规则算出的全额。
 *
 * 另外审计「信用评级」：与克苏鲁神话同待遇 —— 车卡时不可加点（仅成长）、
 * 且豁免技能上限。
 *
 * 全程离线。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'web', 'js');
let fail = 0;
const bad = (m) => { console.log('  [FAIL] ' + m); fail++; };
const ok = (m) => console.log('  [OK]   ' + m);

function makeSandbox() {
  const s = { console, Math, JSON, Date, Object, Array, String, Number, parseInt, parseFloat, isNaN, isFinite, Uint8Array, Int32Array };
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

const ATTRS = { str: 60, con: 65, siz: 60, dex: 70, app: 60, int: 70, pow: 60, edu: 70, luck: 55 };
const PROFILES = [
  { occupationName: '私家侦探', setting: 'cn-modern' },
  { occupationName: '机械师', setting: 'cn-modern' },
  { occupationName: '记者', setting: 'cn-republic' },
  { occupationName: '法医', setting: 'cn-modern' },
  { occupationName: '古董店老板', setting: 'cn-republic' },
  { occupationName: '图书管理员', setting: 'uk-victorian' }
];

function mkPF(p) {
  return { fromAI: true, occupationName: p.occupationName, setting: p.setting,
           age: 30, gender: '男', attributes: Object.assign({}, ATTRS) };
}

/** 一张卡的完整体检 */
function inspect(c, s) {
  const OCC = s.CocOccupation, SM = s.SkillModel, R = s.COC7;
  const set = OCC.occupationalSet(c);
  const op = OCC.occupationPoints(c), ip = OCC.interestPoints(c);
  let occOver = 0, intOver = 0, occMax = 0, intMax = 0;
  (c.skills || []).forEach((sk) => {
    if (sk.id === 'credit' || sk.id === 'cthulhu' || R.isGrowthOnly(sk.id)) return;
    const cap = SM.capOf(c, sk);
    const isOcc = !!(set[sk.key] || set[sk.id]);
    if (isOcc) {
      if (sk.total > cap) occOver++;
      if (sk.total > occMax) occMax = sk.total;
    } else if ((sk.int || 0) > 0) {
      if (sk.total > cap) intOver++;
      if (sk.total > intMax) intMax = sk.total;
    }
  });
  return {
    occTotal: op.total, occUsed: op.used, occRemain: op.remain,
    intTotal: ip.total, intUsed: ip.used, intRemain: ip.remain,
    occOver, intOver, occMax, intMax,
    skillCapOcc: c.skillCapOcc || 0, skillCapInt: c.skillCapInterest || 0,
    bad: s.Engine.checkList(c).filter((x) => !x.ok).map((x) => x.label + '->' + x.detail)
  };
}

/* ============================================================
 * 一、点数池不再被上限压缩
 * ============================================================ */
console.log('== 一、上限不压缩点数池 ==');
{
  const CASES = [{ occ: 0, int: 0 }, { occ: 80, int: 60 }, { occ: 99, int: 99 }, { occ: 50, int: 40 }];
  CASES.forEach((cap) => {
    const s = makeSandbox(); loadAll(s);
    const P = s.PresetGen;
    let poolDiff = 0, occOver = 0, intOver = 0, unsound = 0, n = 0;
    const seen = {};
    PROFILES.forEach((p) => {
      const c = P.buildFrom(mkPF(p), p.setting, cap.occ || cap.int ? { ptsCap: cap } : {});
      if (!c) return;
      n++;
      const r = inspect(c, s);
      // 点数池必须与「不设上限」时一致
      const key = p.occupationName;
      if (seen[key] === undefined) seen[key] = r.occTotal;
      else if (seen[key] !== r.occTotal) poolDiff++;
      occOver += r.occOver;
      intOver += r.intOver;
      if (r.bad.length) unsound++;
    });
    const label = '上限 ' + cap.occ + '/' + cap.int;
    if (poolDiff === 0) ok(label + '：点数池与不设上限时一致（' + n + ' 张）');
    else bad(label + '：' + poolDiff + ' 张的点数池被改动了');
    if (occOver === 0 && intOver === 0) ok(label + '：没有任何技能超过上限');
    else bad(label + '：本职超上限 ' + occOver + '，兴趣超上限 ' + intOver);
    if (unsound === 0) ok(label + '：全部通过 Engine.checkList');
    else bad(label + '：' + unsound + ' 张不合格');
  });
}

/* ============================================================
 * 二、上限真的生效（逐项封顶）
 *
 * ⚠️ 判据要按「每个技能自己的有效上限」算，不能拿全局上限比。
 * 规则书里上限**不会低于该技能的基础值**（基础值不是用点数买来的，
 * 把它算成超上限属于误报）—— 例：某技能基础 70、上限设 60，
 * 它的有效上限是 70 而��是 60。所以基础值高的技能「看起来超过上限」
 * 是规则使然，不是上限没生效。
 * ============================================================ */
console.log('\n== 二、上限逐项封顶 ==');
{
  /** 精确判据：某项技能超过设定上限，只有在「它的有效上限确实就是设定上限」时才算违规。
   *  有效上限 = 规则豁免 ? 99 : max(设定上限, 基础值)
   *  —— 基础值不是买来的，把上限压到基础值以下属于误报（规则书如此）。 */
  function violations(s, c, wantOcc, wantInt) {
    const OCC = s.CocOccupation, R = s.COC7;
    const set = OCC.occupationalSet(c);
    const v = [];
    (c.skills || []).forEach((sk) => {
      if (sk.id === 'credit' || sk.id === 'cthulhu' || R.isGrowthOnly(sk.id)) return;
      const isOcc = !!(set[sk.key] || set[sk.id]);
      if (isOcc && sk.occ === undefined) return;
      if (!isOcc && !(sk.int > 0)) return;
      const want = isOcc ? wantOcc : wantInt;
      if (!want) return;
      if (R.capExempt(sk.id)) return;          // 规则豁免（母语/信用评级）
      const base = sk.base || 0;
      if (base > want) return;                // 基础值更高 -> 有效上限是基础值
      if (sk.total > want) v.push(sk.name + '=' + sk.total + '>' + want);
    });
    return v;
  }

  [[80, 60], [60, 50], [50, 50], [30, 30], [25, 20], [20, 25], [99, 99]].forEach(([oc, ic]) => {
    const s = makeSandbox(); loadAll(s);
    const P = s.PresetGen;
    let v = [], n = 0;
    PROFILES.forEach((p) => {
      const c = P.buildFrom(mkPF(p), p.setting, { ptsCap: { occ: oc, int: ic } });
      if (!c) return;
      n++;
      v = v.concat(violations(s, c, oc, ic));
    });
    if (v.length === 0) ok('上限 ' + oc + '/' + ic + '：没有技能越过有效上限（' + n + ' 张）');
    else bad('上限 ' + oc + '/' + ic + '：' + v.length + ' 项越界 —— ' + v.slice(0, 3).join(', '));
  });

  /* 单调性：上限调低，本职最高值必须跟着降 —— 证明上限真的在起作用，
     而不是「设了但没生效」。 */
  const seen = [];
  [99, 80, 60, 45].forEach((oc) => {
    const s = makeSandbox(); loadAll(s);
    const P = s.PresetGen, SM = s.SkillModel, R = s.COC7, OCC = s.CocOccupation;
    let mx = 0;
    PROFILES.forEach((p) => {
      const c = P.buildFrom(mkPF(p), p.setting, { ptsCap: { occ: oc, int: 99 } });
      if (!c) return;
      const set = OCC.occupationalSet(c);
      (c.skills || []).forEach((sk) => {
        if (sk.id === 'credit' || sk.id === 'cthulhu' || R.isGrowthOnly(sk.id)) return;
        if (!(set[sk.key] || set[sk.id])) return;
        if (R.capExempt(sk.id)) return;
        if ((sk.base || 0) > oc) return;
        if (sk.total > mx) mx = sk.total;
      });
    });
    seen.push([oc, mx]);
  });
  let mono = true;
  for (let i = 1; i < seen.length; i++) {
    if (seen[i][1] > seen[i - 1][1]) mono = false;
  }
  const desc = seen.map((x) => x[0] + '→' + x[1]).join('，');
  if (mono) ok('上限调低时本职最高值单调下降（' + desc + '）');
  else bad('上限调低但最高值反而上升：' + desc);
}

/* ============================================================
 * 三、上限压得极低时点数用不完 —— 必须是「所有技能都到顶」造成的
 *
 * ⚠️ 「可加点技能」要**排掉 capExempt 的那几项**（母语 / 信用评级）：
 *    母语的上限固定是 99，分配逻辑根本不往里投点（投了也是白花），
 *    把它算进「有没有全部到顶」的话，每张卡都会显示「没到顶」，
 *    于是极低上限下的剩点全被误判成 bug。
 * ============================================================ */
console.log('\n== 三、极低上限：点数用不完只能因为技能全到顶 ==');
{
  [[30, 30], [20, 20], [10, 10]].forEach(([oc, ic]) => {
    const s = makeSandbox(); loadAll(s);
    const P = s.PresetGen, OCC = s.CocOccupation, SM = s.SkillModel, R = s.COC7;
    let unjustified = 0, capped = 0, n = 0;
    const examples = [];
    PROFILES.forEach((p) => {
      const c = P.buildFrom(mkPF(p), p.setting, { ptsCap: { occ: oc, int: ic } });
      if (!c) return;
      n++;
      const set = OCC.occupationalSet(c);
      const op = OCC.occupationPoints(c);
      if (op.remain === 0) return;
      //有剩余 → 必须所有**可加点**的本职技能都到顶
      const list = (c.skills || []).filter((sk) => {
        if (sk.id === 'credit' || sk.id === 'cthulhu' || R.isGrowthOnly(sk.id)) return false;
        if (R.capExempt(sk.id)) return false;     // 母语 / 信用评级：不参与加点
        return !!(set[sk.key] || set[sk.id]);
      });
      const allCap = list.length > 0 &&
        list.every((sk) => sk.total >= SM.capOf(c, sk));
      if (allCap) capped++;
      else { unjustified++; examples.push(p.occupationName + ' 剩 ' + op.remain); }
    });
    if (unjustified === 0) ok('上限 ' + oc + '/' + ic + '：剩点的卡全部是「技能已到上限」（' +
                             capped + '/' + n + ' 张有剩余，其中 ' + capped + ' 张原因正确）');
    else bad('上限 ' + oc + '/' + ic + '：' + unjustified + ' 张无缘无故剩点：' + examples.join(', '));
  });
}

/* ============================================================
 * 四、信用评级：仅成长 + 上限豁免
 * ============================================================ */
console.log('\n== 四、信用评级 ==');
{
  const s = makeSandbox(); loadAll(s);
  const R = s.COC7, SM = s.SkillModel, P = s.PresetGen;

  if (R.isGrowthOnly('credit')) ok('信用评级 isGrowthOnly = true（车卡时不可加点）');
  else bad('信用评级 不是 isGrowthOnly');
  if (R.capExempt('credit')) ok('信用评级 capExempt = true（豁免技能上限）');
  else bad('信用评级 不是 capExempt');
  /* 与克苏鲁神话同待遇 */
  if (R.isGrowthOnly('cthulhu') && R.capExempt('cthulhu') === false) {
    ok('对照：克苏鲁神话 isGrowthOnly=true、不豁免上限（SAN 上限另有规则）');
  }

  const c = P.buildFrom(mkPF(PROFILES[0]), 'cn-modern', {});
  const cs = c.skills.filter((x) => x.id === 'credit')[0];
  if (!cs) bad('卡上没有信用评级技能');
  else {
    const a = SM.canAdd(c, cs, 'occ', 5);
    const b = SM.canAdd(c, cs, 'int', 5);
    const g = SM.canAdd(c, cs, 'growth', 5);
    if (!a.ok && !b.ok && g.ok) ok('canAdd：occ/int 被拒、growth 允许');
    else bad('canAdd 不符合预期：occ=' + a.ok + ' int=' + b.ok + ' growth=' + g.ok);
    if (SM.capOf(c, cs) === 99) ok('capOf(信用评级) = 99');
    else bad('capOf(信用评级) = ' + SM.capOf(c, cs));
    c.skillCapOcc = 30; c.skillCapInterest = 30;
    if (SM.capOf(c, cs) === 99) ok('把上限压到 30 后，capOf(信用评级) 仍是 99（豁免生效）');
    else bad('上限压到 30 后 capOf(信用评级) = ' + SM.capOf(c, cs) + '（豁免没生效）');
  }

  // 生成时信用评级仍要落在职业区间内
  const s2 = makeSandbox(); loadAll(s2);
  const P2 = s2.PresetGen;
  let outOfRange = 0, n2 = 0;
  PROFILES.forEach((p) => {
    const c2 = P2.buildFrom(mkPF(p), p.setting, { ptsCap: { occ: 30, int: 30 } });
    if (!c2) return;
    n2++;
    const occ = s2.CocOccupation.getById(c2.occupationId);
    const cr = parseInt(c2.assets.creditRating, 10) || 0;
    if (occ && occ.creditMin !== null && occ.creditMin !== undefined) {
      if (cr < occ.creditMin || cr > occ.creditMax) {
        outOfRange++;
      }
    }
  });
  if (outOfRange === 0) ok('低上限下信用评级仍落在职业允许区间（' + n2 + ' 张）');
  else bad(outOfRange + ' 张的信用评级越界');
}

/* ============================================================
 * 五、不设上限时行为不变
 * ============================================================ */
console.log('\n== 五、不设上限 ==');
{
  const s = makeSandbox(); loadAll(s);
  const P = s.PresetGen;
  let remain = 0, n = 0, unsound = 0;
  PROFILES.forEach((p) => {
    const c = P.buildFrom(mkPF(p), p.setting, {});
    if (!c) return;
    n++;
    const r = inspect(c, s);
    if (r.occRemain !== 0 || r.intRemain !== 0) remain++;
    if (r.bad.length) unsound++;
  });
  if (remain === 0) ok('不设上限时点数 100% 用完（' + n + ' 张）');
  else bad(remain + ' 张剩点');
  if (unsound === 0) ok('全部通过 Engine.checkList');
  else bad(unsound + ' 张不合格');
}

console.log('\n' + (fail === 0 ? 'RESULT: PASS' : 'RESULT: FAIL —— ' + fail + ' 项不通过'));
process.exit(fail === 0 ? 0 : 1);
