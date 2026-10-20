/* 审计：年龄扣减的「平均分摊 + 单项下限 15」
 *
 * 检查两条：
 *   1) 任意年龄、任意属性组合下，力量/体质/敏捷的扣减量最多相差 1（在都还有余量时）
 *   2) 扣完之后的生效值不低于 15
 *   3) 三项都低于下限时，unapplied 要如实报告扣不掉的点数
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'web', 'js');
const sandbox = { console, Math, JSON, Date, Object, Array, String, Number, parseInt, parseFloat, isNaN };
sandbox.window = sandbox;
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'core', 'rules-coc7.js'), 'utf8'), sandbox, { filename: 'rules-coc7.js' });

const R = sandbox.COC7;
if (!R || !R.ageAdjust) { console.error('FAIL: 未取到 COC7.ageAdjust'); process.exit(1); }

let fail = 0;
const bad = (msg) => { console.log('  [FAIL] ' + msg); fail++; };

/* ---------- 用例 1：各年龄 × 多组属性，检查分摊与下限 ---------- */
console.log('== 年龄扣减：平均分摊 + 下限 15 ==');

const ages = [15, 17, 19, 25, 39, 45, 55, 62, 70, 75, 85, 88];
const attrSets = [
  { str: 80, con: 75, dex: 70, siz: 65, app: 70, int: 70, pow: 60, edu: 70, luck: 50 },
  { str: 50, con: 48, dex: 46, siz: 55, app: 60, int: 60, pow: 55, edu: 60, luck: 50 },
  { str: 20, con: 18, dex: 16, siz: 30, app: 40, int: 50, pow: 50, edu: 50, luck: 50 },
  { str: 15, con: 15, dex: 15, siz: 20, app: 30, int: 40, pow: 40, edu: 40, luck: 40 },
  { str: 90, con: 90, dex: 15, siz: 70, app: 85, int: 80, pow: 75, edu: 90, luck: 60 }
];

let checked = 0, floorHits = 0, unappliedSeen = 0, maxSpread = 0;
for (const age of ages) {
  for (const a of attrSets) {
    const adj = R.ageAdjust(Object.assign({ age }, a));
    checked++;
    const L = adj.loss;
    const eff = adj.eff;

    // 下限 15
    for (const k of ['str', 'con', 'dex', 'siz']) {
      if (eff[k] < 15) bad(`${age}岁 ${k} 生效值 ${eff[k]} < 15（raw ${a[k]}）`);
      if (eff[k] < 0) bad(`${age}岁 ${k} 生效值为负`);
    }

    if (age >= 20) {
      // 扣减量最多相差 1：只在「该项还有余量（未触底）」时比较
      const live = ['str', 'con', 'dex'].filter((k) => a[k] - L[k] > 15 || L[k] === 0 ? a[k] > 15 : true);
      const vals = ['str', 'con', 'dex'].map((k) => L[k]);
      const cap = (k) => Math.max(0, a[k] - 15);
      const notCapped = ['str', 'con', 'dex'].filter((k) => L[k] < cap(k));
      if (notCapped.length >= 2) {
        const sub = notCapped.map((k) => L[k]);
        const spread = Math.max(...sub) - Math.min(...sub);
        maxSpread = Math.max(maxSpread, spread);
        if (spread > 1) {
          bad(`${age}岁 分摊不均：str ${L.str} / con ${L.con} / dex ${L.dex}（差 ${spread}）`);
        }
      }
      // 扣满时应扣尽（除了全触底）
      const ruleLoss = R.ageRule(age).physLoss || 0;
      const totalCap = cap('str') + cap('con') + cap('dex');
      if (ruleLoss > totalCap) {
        unappliedSeen++;
        if (adj.unapplied !== ruleLoss - totalCap) {
          bad(`${age}岁 unapplied 报告 ${adj.unapplied}，应为 ${ruleLoss - totalCap}`);
        }
      } else if (adj.unapplied !== 0) {
        bad(`${age}岁 不应有扣不掉的点数，却报告 unapplied=${adj.unapplied}`);
      }
      // 实际扣减总量
      const actual = L.str + L.con + L.dex;
      if (actual !== Math.min(ruleLoss, totalCap)) {
        bad(`${age}岁 实际扣 ${actual}，应为 ${Math.min(ruleLoss, totalCap)}`);
      }
      if (actual > 0) floorHits++;
    }
  }
}

console.log(`  用例 ${checked} 组 · 触发扣减 ${floorHits} 组 · 出现下限拦截 ${unappliedSeen} 组`);
console.log(`  未触底三项的扣减量最大差值 = ${maxSpread}（要求 ≤ 1）`);

/* ---------- 用例 2：69 岁典型场景，人工核对 ---------- */
console.log('== 典型场景 ==');
function show(label, attrs) {
  const adj = R.ageAdjust(attrs);
  const L = adj.loss;
  const teen = adj.age <= 19;
  console.log(`  ${label}：年龄 ${adj.age} → 规则扣 ${adj.rule.physLoss}` +
              (teen ? '（少年：摊到 力量/体型）' : '（中老年：摊到 力量/体质/敏捷）'));
  console.log(`    扣减  力量 -${L.str}  体质 -${L.con}  敏捷 -${L.dex}  体型 -${L.siz}  外貌 -${L.app}`);
  console.log(`    生效  力量 ${adj.eff.str}  体质 ${adj.eff.con}  敏捷 ${adj.eff.dex}  体型 ${adj.eff.siz}  外貌 ${adj.eff.app}`);
  if (adj.unapplied) console.log(`    有 ${adj.unapplied} 点因触及下限 15 未能扣完`);
  return adj;
}

const a1 = show('典型中老年（70 岁，属性偏高）', { age: 70, str: 85, con: 80, dex: 75, siz: 70, app: 80, int: 75, pow: 70, edu: 75, luck: 55 });
if (!(a1.loss.str > 0 && a1.loss.con > 0 && a1.loss.dex > 0)) {
  bad('70 岁三项都应该被扣（不能只扣力量）');
}

const a2 = show('少年（17 岁）', { age: 17, str: 55, con: 50, dex: 60, siz: 45, app: 60, int: 70, pow: 55, edu: 60, luck: 60 });
if (a2.loss.str + a2.loss.siz !== 5) bad('17 岁合计应扣 5 点');
if (!(a2.loss.str > 0 && a2.loss.siz > 0)) bad('17 岁力量与体型应各摊到，不应只扣力量');

const a3 = show('三项都贴近下限（85 岁）', { age: 85, str: 16, con: 15, dex: 15, siz: 30, app: 50, int: 60, pow: 55, edu: 60, luck: 50 });
if (a3.eff.str < 15 || a3.eff.con < 15 || a3.eff.dex < 15) bad('85 岁生效值跌破 15');

const a4 = show('青年（25 岁，无扣减）', { age: 25, str: 70, con: 65, dex: 75, siz: 60, app: 70, int: 70, pow: 60, edu: 70, luck: 50 });
if (a4.totalLoss !== 0) bad('25 岁不该有属性扣减');

/* ---------- 结论 ---------- */
console.log('');
if (fail) { console.log(`RESULT: FAIL（${fail} 项）`); process.exit(1); }
console.log('RESULT: PASS');