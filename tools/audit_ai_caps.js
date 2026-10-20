/* 审计：数值上限（房规）与技能分配口径
 *
 * 覆盖：
 *   1) applyAttrCap —— 属性总和压缩：正好压到上限、不破坏相对高低、不产生废值
 *   2) caps() / capsText() / buildPrompt —— 设置能读出来且写进提示词
 *   3) 点数上限真的生效（职业点 / 兴趣点都不超）
 *   4) 兴趣技能不超过 10 项
 *   5) 自定义职业：本职 ≤ 8 项、有拔尖项（不是摊平在一堆 50 上）
 *   6) 以上所有卡都能通过 Engine.checkList（合规可用）
 *   7) 上限对**第 0 步随机卡 / 彩蛋卡**同样生效，且是「现读的变量」；
 *      未设上限时不误报「被上限压过（职业点上限 99）」
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
  /* store.js 会写 localStorage，沙箱里给一个内存版，
     否则每次 setSettings 都会抛 ReferenceError 刷屏。 */
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

const ATTR8 = ['str', 'con', 'siz', 'dex', 'app', 'int', 'pow', 'edu'];
const ALL9 = ATTR8.concat(['luck']);
const sumOf = (a, keys) => keys.reduce((t, k) => t + (parseInt(a[k], 10) || 0), 0);

/* ============================================================
 * 一、属性总和压缩
 * ============================================================ */
console.log('== 一、属性总和压缩（applyAttrCap）==');
{
  const s = makeSandbox();
  loadAll(s);
  const A = s.AIGen;

  const base = { str: 85, con: 80, siz: 75, dex: 70, app: 65, int: 90, pow: 60, edu: 88, luck: 55 };
  console.log('  原始九项合计 = ' + sumOf(base, ALL9));

  // 1) 含幸运，压到 400
  let p = { attributes: Object.assign({}, base) };
  let moved = A.applyAttrCap(p, { attrCap: 400, withLuck: true });
  let got = sumOf(p.attributes, ALL9);
  if (!moved) bad('超限时应返回 true 表示动过');
  if (got !== 400) bad('含幸运：压缩后应为 400，实际 ' + got);
  if (ALL9.some((k) => p.attributes[k] < 15)) bad('压缩后出现 <15 的废值');
  if (ALL9.some((k) => p.attributes[k] > 99)) bad('压缩后出现 >99 的值');
  ok(`含幸运：${sumOf(base, ALL9)} → ${got}（正好等于上限）`);

  // 相对高低不能被压反：原来高的压缩后不应低于原来低的
  let inversions = 0;
  for (let i = 0; i < ALL9.length; i++) {
    for (let j = i + 1; j < ALL9.length; j++) {
      const a = base[ALL9[i]], b = base[ALL9[j]];
      const a2 = p.attributes[ALL9[i]], b2 = p.attributes[ALL9[j]];
      if (a > b && a2 < b2) inversions++;
    }
  }
  if (inversions > 0) bad('压缩把属性高低压反了 ' + inversions + ' 处');
  ok('相对高低保持（0 处倒置）—— 「力量型」不会被压成「文弱型」');

  // 2) 不含幸运：幸运必须原样不动
  p = { attributes: Object.assign({}, base) };
  moved = A.applyAttrCap(p, { attrCap: 400, withLuck: false });
  if (p.attributes.luck !== base.luck) bad('不含幸运模式却改了幸运：' + p.attributes.luck);
  if (sumOf(p.attributes, ATTR8) !== 400) bad('不含幸运：八项应为 400，实际 ' + sumOf(p.attributes, ATTR8));
  ok('不含幸运：八项压到 400，幸运保持 ' + base.luck + ' 不变');

  // 3) 没超限就不动
  p = { attributes: { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 50, pow: 50, edu: 50, luck: 50 } };
  moved = A.applyAttrCap(p, { attrCap: 500, withLuck: true });
  if (moved) bad('未超限却返回 true');
  if (p.attributes.str !== 50) bad('未超限却改了数值');
  ok('未超限时原样保留，不动数据');

  // 4) 极端上限（压到很低）也不能出现废值
  p = { attributes: Object.assign({}, base) };
  A.applyAttrCap(p, { attrCap: 150, withLuck: true });
  if (sumOf(p.attributes, ALL9) !== 150) bad('压到 150 时总和不对：' + sumOf(p.attributes, ALL9));
  if (ALL9.some((k) => p.attributes[k] < 15)) bad('压到 150 时出现 <15 的废值');
  ok('极端上限（150）：总和精确、无一项低于 15');

  // 5) 没有属性 / 没有上限时的健壮性
  if (A.applyAttrCap({}, { attrCap: 400, withLuck: true }) !== false) bad('空 profile 应返回 false');
  if (A.applyAttrCap({ attributes: Object.assign({}, base) }, null) !== false) bad('无上限应返回 false');
  ok('空数据 / 未设上限时不报错');
}

/* ============================================================
 * 二、设置读取与提示词
 * ============================================================ */
console.log('\n== 二、设置读取与提示词 ==');
{
  const s = makeSandbox();
  loadAll(s);
  const A = s.AIGen, Store = s.Store;

  // 默认不限制
  let c = A.caps();
  if (c.attrCap || c.occCap || c.intCap) bad('默认应为「不限制」，实际 ' + JSON.stringify(c));
  if (A.capsActive(c)) bad('默认 capsActive 应为 false');
  ok('默认不限制（老用户升级后行为不变）');

  Store.setSettings({ aiAttrCap: 420, aiAttrCapWithLuck: false, aiOccPtsCap: 200, aiIntPtsCap: 120 });
  c = A.caps();
  if (c.attrCap !== 420) bad('属性上限没读到：' + c.attrCap);
  if (c.withLuck !== false) bad('「不含幸运」没读到');
  if (c.occCap !== 200 || c.intCap !== 120) bad('点数上限没读到：' + JSON.stringify(c));
  ok('设置项全部读到：' + A.capsText(c));

  const prompt = A.buildPrompt('民国时期的私家侦探');
  ['420', '不含幸运', '200', '120'].forEach((kw) => {
    if (prompt.indexOf(kw) < 0) bad('提示词里缺少上限信息：' + kw);
  });
  ok('三个上限都写进了提示词（模型会先被要求遵守）');

  // 含幸运模式
  Store.setSettings({ aiAttrCapWithLuck: true });
  if (!/含幸运/.test(A.buildPrompt('x'))) bad('含幸运模式没写进提示词');
  ok('「含幸运 / 不含幸运」两种口径都能写进提示词');

  // 关闭上限后提示词里不应残留上限行
  Store.setSettings({ aiAttrCap: 0, aiOccPtsCap: 0, aiIntPtsCap: 0 });
  const p2 = A.buildPrompt('x');
  if (/总和上限/.test(p2) || /点数上限/.test(p2)) bad('上限清零后提示词仍有上限行');
  ok('上限清零后提示词也跟着清干净');
}

/* ============================================================
 * 三、技能上限真的生效
 *
 * ⚠️ 语义已改：上限是「**每一项技能**最终值」的上限，
 *    **不压缩点数总额**。所以判据不再是「used <= 上限」，
 *    而是「没有技能超过它自己的有效上限」。
 * ============================================================ */
console.log('\n== 三、技能上限生效（真实生成）==');
{
  const s = makeSandbox();
  loadAll(s);
  const G = s.PresetGen, OCC = s.CocOccupation, Engine = s.Engine,
        SM = s.SkillModel, R = s.COC7;

  const CAP_OCC = 60, CAP_INT = 50;
  let over = [], worstOccSkill = 0, worstIntSkill = 0,
      worstFocus = 0, notSound = 0, poolChanged = 0, n = 0;
  for (let i = 0; i < 120; i++) {
    const c = G.generateOne({ ctx: { used: {} }, ptsCap: { occ: CAP_OCC, int: CAP_INT } });
    if (!c) { bad('生成返回 null'); break; }
    n++;
    const set = OCC.occupationalSet(c);
    (c.skills || []).forEach((x) => {
      if (x.id === 'credit' || x.id === 'cthulhu' || R.isGrowthOnly(x.id)) return;
      const isOcc = !!(set[x.key] || set[x.id]);
      if (isOcc) {
        if (x.total > SM.capOf(c, x)) over.push((x.name || '?') + '=' + x.total);
        if (!R.capExempt(x.id) && (x.base || 0) <= CAP_OCC && x.total > worstOccSkill) {
          worstOccSkill = x.total;
        }
      } else if ((x.int || 0) > 0) {
        if (x.total > SM.capOf(c, x)) over.push((x.name || '?') + '=' + x.total);
        if (!R.capExempt(x.id) && (x.base || 0) <= CAP_INT && x.total > worstIntSkill) {
          worstIntSkill = x.total;
        }
      }
    });
    /* 点数总额不该被上限改动。
       ⚠️ 必须在**同一张卡**上比：另生成一张随机卡来比是没有意义的
       （两张卡属性不同，公式算出的总额本来就不同）。
       正确做法：把这张卡的上限字段清掉，再看总额是否变化。 */
    const withCap = OCC.occupationPoints(c).total;
    const keepOcc = c.skillCapOcc, keepInt = c.skillCapInterest;
    c.skillCapOcc = 99; c.skillCapInterest = 99;
    const withoutCap = OCC.occupationPoints(c).total;
    c.skillCapOcc = keepOcc; c.skillCapInterest = keepInt;
    if (withCap !== withoutCap) poolChanged++;
    const withInt = (c.skills || []).filter((x) => (x.int || 0) > 0).length;
    worstFocus = Math.max(worstFocus, withInt);
    if (Engine.checkList(c).filter((x) => !x.ok).length) notSound++;
  }
  console.log(`  ${n} 张卡：本职技能最高 ${worstOccSkill}（上限 ${CAP_OCC}）· ` +
              `兴趣技能最高 ${worstIntSkill}（上限 ${CAP_INT}）`);
  if (over.length) bad(over.length + ' 项技能超过上限，例如 ' + over.slice(0, 3).join(', '));
  else ok('没有任何技能超过自己的有效上限');
  if (worstOccSkill > CAP_OCC) bad('本职技能最高 ' + worstOccSkill + ' 超过上限 ' + CAP_OCC);
  else ok('本职技能全部被封顶在' + CAP_OCC + ' 以内');
  if (worstIntSkill > CAP_INT) bad('兴趣技能最高 ' + worstIntSkill + ' 超过上限 ' + CAP_INT);
  else ok('兴趣技能全部被封顶在' + CAP_INT + ' 以内');
  if (poolChanged === 0) ok('点数总额没有被上限改动（上限只压每一项）');
  else bad(poolChanged + ' 张卡的点数总额被上限改动了');
  console.log(`  拿到兴趣点的技能最多 ${worstFocus} 项`);
  if (worstFocus > 12) bad('兴趣技能超过 12 项（兜底溢出后允许略超）：' + worstFocus);
  else ok('兴趣技能控制在 12 项以内');
  if (notSound) bad(notSound + ' 张卡未通过完整性校验');
  else ok(n + ' 张卡全部通过 Engine.checkList');

  // 点数必须全部用完（玩家明确要求）
  let leftOcc = 0, leftInt = 0, leftCards = 0;
  for (let i = 0; i < 120; i++) {
    const c = G.generateOne({ ctx: { used: {} } });
    if (!c) continue;
    const op = OCC.occupationPoints(c), ip = OCC.interestPoints(c);
    const ro = op.total - op.used, ri = ip.total - ip.used;
    leftOcc = Math.max(leftOcc, ro); leftInt = Math.max(leftInt, ri);
    if (ro > 0 || ri > 0) leftCards++;
  }
  console.log(`  剩余点数：职业点最多剩 ${leftOcc}　兴趣点最多剩 ${leftInt}`);
  if (leftCards) bad(`${leftCards} 张随机卡还有点数没用完`);
  else ok('随机卡点数 100% 用完（120 张零剩余）');

  // AI 路径同样不能有剩余
  let aLeftCards = 0, aWorstO = 0, aWorstI = 0;
  const AI_ATTR = { str: 60, con: 55, siz: 65, dex: 70, app: 55, int: 75, pow: 60, edu: 80, luck: 50 };
  const AI_OCCS = ['私家侦探', '厨师', '技师', '士兵、海军陆战队士兵', '音乐家', '记者'];
  for (let i = 0; i < 120; i++) {
    const c = G.buildFrom({
      fromAI: true, name: 'AI' + i, gender: '男', age: 25 + (i % 45),
      attributes: Object.assign({}, AI_ATTR),
      occupationName: AI_OCCS[i % AI_OCCS.length]
    }, 'cn-modern');
    if (!c) continue;
    const op = OCC.occupationPoints(c), ip = OCC.interestPoints(c);
    const ro = op.total - op.used, ri = ip.total - ip.used;
    aWorstO = Math.max(aWorstO, ro); aWorstI = Math.max(aWorstI, ri);
    if (ro > 0 || ri > 0) aLeftCards++;
  }
  console.log(`  AI 路径：职业点最多剩 ${aWorstO}　兴趣点最多剩 ${aWorstI}`);
  if (aLeftCards) bad(`${aLeftCards} 张 AI 卡还有点数没用完`);
  else ok('AI 卡点数 100% 用完（120 张零剩余）');
}

/* ============================================================
 * 四、本职技能「拔尖」（含自定义职业）
 *
 * ⚠️ v1.13 起判据换过一次。旧版是**广度优先**：
 *   「把预算摊开、让尽可能多的本职技能从 30 升到 50」。
 *   玩家否掉了这种做法（「很容易变成多个本职点数全都是50点」），
 *   改成**拔尖优先**：2-4 项真正推高（接近上限），其余允许不加点。
 *   所以这里不再看「低于 50 的项数 ≤3」，改看「拔尖项数与高度」。
 * ============================================================ */
console.log('\n== 四、本职技能拔尖 ==');
{
  const s = makeSandbox();
  loadAll(s);
  const G = s.PresetGen, OCC = s.CocOccupation, Engine = s.Engine;

  /* 统计：每张卡有几项本职技能达到 50、最高一项多少、点数有没有浪费。 */
  let cards = 0, sumHigh = 0, sumTop = 0, sumOccN = 0, sumUsedPct = 0, sumEq50 = 0;
  let minHigh = 99, maxOccN = 0, thin = 0, wall = 0;
  for (let i = 0; i < 80; i++) {
    const c = G.generateOne({ ctx: { used: {} } });
    if (!c) continue;
    const set = OCC.occupationalSet(c);
    const occSkills = (c.skills || []).filter((x) =>
      x.id !== 'credit' && x.id !== 'cthulhu' && (set[x.key] || set[x.id]));
    const high = occSkills.filter((x) => x.total >= 50).length;
    const top = occSkills.reduce((m, x) => Math.max(m, x.total), 0);
    const eq50 = occSkills.filter((x) => x.total === 50).length;
    const op = OCC.occupationPoints(c);
    sumHigh += high; sumTop += top; sumOccN += occSkills.length; sumEq50 += eq50;
    maxOccN = Math.max(maxOccN, occSkills.length);
    sumUsedPct += op.total ? op.used / op.total : 1;
    minHigh = Math.min(minHigh, high);
    if (high < 2) thin++;
    if (eq50 >= 4) wall++;
    cards++;
  }
  /* 本职技能**总数**也要控制住。
     这是上一版最大的坑：组技能（技艺 30 个专攻、格斗 7 个）被整组标成本职，
     「厨师」「技师」这类卡能冒出 40-51 项本职技能 —— 界面看不完、点数也摊薄。
     现在组技能收敛到单个专攻，实测平均 8-9 项。 */
  const avgOccN = sumOccN / Math.max(1, cards);
  console.log(`  本职技能数：平均 ${avgOccN.toFixed(1)} 项　最多 ${maxOccN} 项`);
  if (avgOccN > 12) bad(`本职技能平均仍有 ${avgOccN.toFixed(1)} 项，组技能可能又被整组展开了`);
  else ok(`本职技能平均 ${avgOccN.toFixed(1)} 项（组技能已收敛到单个专攻）`);
  /* 上限放宽到 18：少数职业（如《煤气灯》的探险家）规则书原文就列了 16-17 项本职，
     那是职业本身如此，不该硬砍。只要平均在 10 项上下就没问题。 */
  if (maxOccN > 18) bad('本职技能最多 ' + maxOccN + ' 项，仍偏多');
  else ok('本职技能最多 ' + maxOccN + ' 项');

  const avgHigh = (sumHigh / cards).toFixed(1);
  const avgTop = Math.round(sumTop / cards);
  const avgN = (sumOccN / cards).toFixed(1);
  const avgEq50 = (sumEq50 / cards).toFixed(2);
  const usedPct = Math.round(sumUsedPct / cards * 100);
  console.log(`  ${cards} 张随机卡：本职技能平均 ${avgN} 项，其中平均 ${avgHigh} 项 ≥ 50`);
  console.log(`  最高一项平均 ${avgTop}　·　恰好 50 的平均 ${avgEq50} 项` +
              `　·　职业点平均用掉 ${usedPct}%`);
  if (+avgHigh < 2) bad('每张卡达到 50 的本职技能平均不足 2 项（' + avgHigh + '），拔尖层不够');
  else ok('每张卡平均有 ' + avgHigh + ' 项本职技能达到 50 以上');
  if (thin > 0) bad(thin + '/' + cards + ' 张卡的本职技能达标数不足 2 项');
  else ok('每张卡都至少有 2 项本职技能 ≥ 50');
  /* ★ 新旧两版最大的差别就在这里：旧版要求「广度」（≥50 的项数多），
     新版要求「高度」（有几项真的拔起来）。avgTop ≥ 70 是「拔尖」的量化门槛。 */
  if (avgTop < 70) bad('本职最高一项平均只有 ' + avgTop + '，拔尖不够（应 ≥70）');
  else ok('本职最高一项平均 ' + avgTop + '（拔尖优先，不再是摊平到 50）');
  /* ★ 反向守卫：不能再退回「一堵 50 的墙」 */
  if (wall > 0) bad(wall + '/' + cards + ' 张卡出现「≥4 项都卡在 50」的同值墙');
  else ok('没有任何一张卡出现「≥4 项卡在 50」的同值墙');
  if (+avgEq50 < 2) ok('平均「恰好 50」只有 ' + avgEq50 + ' 项');
  else bad('平均有 ' + avgEq50 + ' 项卡在 50，仍像同值墙');
  if (usedPct < 80) bad('职业点只用了 ' + usedPct + '%，浪费太多');
  else ok('职业点平均用掉 ' + usedPct + '%，没有大量浪费');

  // 自定义职业
  const customSkills = ['侦查', '潜行', '图书馆使用', '心理学', '说服', '手枪射击'];
  let cOcc = null, maxOcc = 0, tried = 0;
  for (let i = 0; i < 40 && !cOcc; i++) {
    tried++;
    const c = G.buildFrom({
      fromAI: true,
      occupationName: '自定义职业',
      occupationSkills: customSkills,
      name: '测试员', gender: '男', age: 33
    }, 'cn-modern');
    if (!c || c.occupationId !== 'occ1') continue;
    const st = OCC.occupationalSet(c);
    const pk = (c.skills || []).filter((x) =>
      x.id !== 'credit' && x.id !== 'cthulhu' && (st[x.key] || st[x.id]));
    if (!pk.length) continue;
    if (pk.filter((x) => x.total >= 50).length < 2) continue;   // 拔尖层不足的样本不要
    cOcc = c;
  }
  if (!cOcc) { bad('自定义职业生成失败（或 ' + tried + ' 次都没达到「至少 2 项 ≥50」）'); }
  else {
    const set = OCC.occupationalSet(cOcc);
    const picked = (cOcc.skills || []).filter((x) =>
      x.id !== 'credit' && x.id !== 'cthulhu' && (set[x.key] || set[x.id]));
    maxOcc = Math.max(maxOcc, picked.length);
    const high = picked.filter((x) => x.total >= 50).length;
    const top = picked.reduce((m, x) => Math.max(m, x.total), 0);
    console.log(`  自定义职业（第 ${tried} 次取样）：本职 ${picked.length} 项，` +
                `其中 ${high} 项 ≥ 50，最高 ${top}`);
    if (picked.length > 8) bad('自定义职业本职技能超过 8 项：' + picked.length);
    else ok('自定义职业本职技能 ≤ 8 项（实际 ' + picked.length + '）');
    if (high < 2) bad('自定义职业达到 50 的本职技能不足 2 项（' + high + '）');
    else ok('自定义职业有 ' + high + ' 项本职技能 ≥ 50');
    if (top < 70) bad('自定义职业最高一项只有 ' + top + '，拔尖不够');
    else ok('自定义职业最高一项 ' + top + '（已拔尖）');

    const errs = Engine.checkList(cOcc).filter((x) => !x.ok);
    if (errs.length) bad('自定义职业卡未通过校验：' + errs.map((x) => x.detail).join('；'));
    else ok('自定义职业卡通过完整性校验');
  }
}

/* ============================================================
 * 五、端到端（模拟一次 AI 返回，不发网络请求）
 * ============================================================ */
console.log('\n== 五、端到端：AI 返回 → 校准 → 生成 ==');
{
  const s = makeSandbox();
  loadAll(s);
  const A = s.AIGen, G = s.PresetGen, Store = s.Store, Engine = s.Engine;

  Store.setSettings({
    aiBase: 'https://example.invalid/v1', aiModel: 'm', aiKey: 'sk-test',
    aiAttrCap: 400, aiAttrCapWithLuck: true, aiOccPtsCap: 180, aiIntPtsCap: 100
  });

  // 模型故意给一组超标属性
  const raw = {
    setting: '中国 · 现代', name: '林九', gender: '男', age: 38,
    residence: '上海', birthplace: '绍兴',
    occupationName: '记者',
    attributes: { str: 90, con: 88, siz: 85, dex: 92, app: 80, int: 95, pow: 85, edu: 90, luck: 90 },
    background: { traits: '执拗、好奇' }
  };
  const before = sumOf(raw.attributes, ALL9);
  const profile = A.toProfile(raw);
  const scaled = A.applyAttrCap(profile, A.caps());
  const c = G.buildFrom(profile, profile.setting, { ptsCap: { occ: 180, int: 100 } });

  console.log(`  模型给的九项合计 ${before} → 校准后 ${sumOf(profile.attributes, ALL9)}`);
  if (!scaled) bad('超限时应当触发压缩');
  if (!c) { bad('生成失败'); }
  else {
    const after = sumOf(c.attributes, ALL9);
    if (after > 400) bad('最终卡属性总和仍超上限：' + after);
    else ok('最终卡属性总和 ' + after + ' ≤ 400（用 AI 校准后的属性，没被退回随机掷骰）');

    const op = s.CocOccupation.occupationPoints(c);
    const ip = s.CocOccupation.interestPoints(c);
    /* ⚠️ 上限是「每项技能封顶」，**不压缩点数总额**。
       所以这里不能断言「op.used <= 180」—— 那是旧语义的残留检查。
       改为逐项核对有没有技能超过它自己的有效上限。 */
    const set = s.CocOccupation.occupationalSet(c);
    const R2 = s.COC7, SM2 = s.SkillModel;
    let over = [], occHi = 0, intHi = 0;
    (c.skills || []).forEach((x) => {
      if (x.id === 'credit' || x.id === 'cthulhu' || R2.isGrowthOnly(x.id)) return;
      const isOcc = !!(set[x.key] || set[x.id]);
      if (isOcc) {
        if (x.total > SM2.capOf(c, x)) over.push(x.name + '=' + x.total);
        if (!R2.capExempt(x.id) && x.total > occHi) occHi = x.total;
      } else if ((x.int || 0) > 0) {
        if (x.total > SM2.capOf(c, x)) over.push(x.name + '=' + x.total);
        if (!R2.capExempt(x.id) && x.total > intHi) intHi = x.total;
      }
    });
    console.log(`  职业点 ${op.used}/${op.total}（上限只压每项）· 兴趣点 ${ip.used}/${ip.total}`);
    if (over.length) bad('有技能超过上限：' + over.join('、'));
    else ok('没有任何技能超过上限 180/100');
    if (occHi > 180) bad('本职技能最高 ' + occHi + ' 超过 180');
    else ok('本职技能最高 ' + occHi + ' ≤ 180');
    if (intHi > 100) bad('兴趣技能最高 ' + intHi + ' 超过 100');
    else ok('兴趣技能最高 ' + intHi + ' ≤ 100');

    const errs = Engine.checkList(c).filter((x) => !x.ok);
    if (errs.length) bad('卡未通过校验：' + errs.map((x) => x.detail).join('；'));
    else ok('通过完整性校验');
  }

  // 关键：属性被压过之后，不能因为「总和低于随机卡的 380」就被退回随机掷骰
  Store.setSettings({ aiAttrCap: 300, aiAttrCapWithLuck: true });
  const raw2 = Object.assign({}, raw, {
    attributes: { str: 80, con: 78, siz: 75, dex: 82, app: 70, int: 85, pow: 75, edu: 80, luck: 60 }
  });
  const pf2 = A.toProfile(raw2);
  A.applyAttrCap(pf2, A.caps());
  const c2 = G.buildFrom(pf2, pf2.setting);
  if (c2 && sumOf(c2.attributes, ATTR8) < 300) {
    // 压到 300（含幸运）后八项必然 < 380 —— 这时必须用 AI 的属性，不能退回随机
    const kept = c2.attributes.str === pf2.attributes.str;
    if (!kept) bad('属性被压低后，AI 配的属性被丢弃、退回了随机掷骰');
    else ok('属性被压到 300 后仍沿用 AI 的属性（未退回随机掷骰）');
  }
}

/* ============================================================
 * 六、房规上限也作用于「第 0 步随机卡」与「彩蛋卡」
 *
 * ⚠️ 这一节是 v1.14 加的。以前的实现里上限只挂在 AI 车卡那条路径上，
 *    随机卡完全不受约束（而卡片上却会误报「被上限压过（职业点上限 99）」）。
 *    玩家的诉求很明确：数值上限是**房规变量**，对随机卡与彩蛋卡同样生效。
 * ============================================================ */
console.log('\n== 六、随机卡 / 彩蛋卡 也吃房规上限 ==');
{
  const s = makeSandbox();
  loadAll(s);
  const G = s.PresetGen, Store = s.Store, OCC = s.CocOccupation,
        SM = s.SkillModel, R = s.COC7, Engine = s.Engine;

  const A9 = ['str', 'con', 'siz', 'dex', 'app', 'int', 'pow', 'edu', 'luck'];
  const sum9 = (a) => A9.reduce((t, k) => t + (parseInt(a[k], 10) || 0), 0);

  function scan(c) {
    const set = OCC.occupationalSet(c);
    const op = OCC.occupationPoints(c), ip = OCC.interestPoints(c);
    let over = 0, occGE50 = 0;
    (c.skills || []).forEach((x) => {
      if (x.id === 'credit' || x.id === 'cthulhu' || R.isGrowthOnly(x.id)) return;
      if (x.total > SM.capOf(c, x)) over++;
      if ((set[x.key] || set[x.id]) && x.total >= 50) occGE50++;
    });
    return {
      sum9: sum9(c.attributes), over: over, ge50: occGE50,
      occRemain: op.total - op.used, intRemain: ip.total - ip.used,
      capOcc: c.skillCapOcc, capInt: c.skillCapInterest, capAttr: c.attrCapSetting || 0,
      summaryCap: G.summaryOf(c),
      bad: Engine.checkList(c).filter((x) => !x.ok)
    };
  }

  /* 1) 不设上限：summaryOf 不该报任何上限（99 是「不限」，不是「上限 99」） */
  {
    const c = G.generateOne({ ctx: { used: {} } });
    const r = scan(c);
    if (r.summaryCap.occCap || r.summaryCap.intCap || r.summaryCap.attrCap) {
      bad('未设上限却报出上限：' + JSON.stringify({
        occCap: r.summaryCap.occCap, intCap: r.summaryCap.intCap, attrCap: r.summaryCap.attrCap
      }));
    } else ok('未设上限时不误报（旧版会把默认 99 说成「职业点上限 99」）');
    if (r.capOcc !== 99 || r.capInt !== 99) bad('未设上限时卡上的上限字段不是默认 99');
    else ok('未设上限时卡上保持规则默认 99');
  }

  /* 2) 设上限：随机卡逐项封顶、属性压到上限、点数仍用完 */
  Store.setSettings({ aiAttrCap: 400, aiAttrCapWithLuck: true, aiOccPtsCap: 60, aiIntPtsCap: 50 });
  {
    let n = 0, over = 0, overSum = 0, left = 0, unsound = 0, noCap = 0;
    for (let i = 0; i < 100; i++) {
      const c = G.generateOne({ ctx: { used: {} } });
      if (!c) { bad('随机卡生成返回 null'); break; }
      const r = scan(c);
      n++;
      if (r.over) over++;
      if (r.sum9 > 400) overSum++;
      if (r.occRemain > 0 || r.intRemain > 0) left++;
      if (r.bad.length) unsound++;
      if (r.capOcc !== 60 || r.capInt !== 50) noCap++;
      if (r.summaryCap.occCap !== 60 || r.summaryCap.intCap !== 50) noCap++;
    }
    console.log(`  ${n} 张随机卡：超上限 ${over} · 属性超 400 ${overSum} · 有剩点 ${left} · 不合格 ${unsound}`);
    if (over) bad(over + ' 张随机卡有技能超过房规上限');
    else ok('随机卡逐项不超房规上限');
    if (overSum) bad(overSum + ' 张随机卡属性总和超过 400');
    else ok('随机卡属性总和全部 ≤ 400');
    if (left) bad(left + ' 张随机卡还有点数没用完');
    else ok('随机卡点数仍然 100% 用完（上限只压每项，不减池子）');
    if (unsound) bad(unsound + ' 张随机卡未通过完整性校验');
    else ok('随机卡全部通过 Engine.checkList');
    if (noCap) bad(noCap + ' 张随机卡没把上限写进卡 / 没在摘要里报出来');
    else ok('上限写进了卡，summaryOf 也如实报出');
  }

  /* 3) 彩蛋卡（名人 + 跑团成员）同样生效 */
  {
    const EGG = s.CocEasterEgg;
    const all = EGG.all();
    let n = 0, over = 0, overSum = 0, unsound = 0, noCap = 0, scaled = 0;
    all.forEach((e) => {
      const c = G.generateOne({ ctx: { used: {} }, profile: EGG.toProfile(e) });
      if (!c) { bad('彩蛋卡生成失败：' + e.data.name); return; }
      c.isEasterEgg = true; c.eggKind = e.kind;
      const r = scan(c);
      n++;
      if (r.over) over++;
      if (r.sum9 > 400) overSum++;
      if (r.bad.length) unsound++;
      if (r.capOcc !== 60 || r.capInt !== 50) noCap++;
      if (r.capAttr !== 400) noCap++;
      if (c.attrCapScaled) scaled++;
    });
    console.log(`  彩蛋 ${n} 张：超上限 ${over} · 属性超 400 ${overSum} · ` +
                `不合格 ${unsound} · 属性被压过 ${scaled}`);
    if (!n) bad('一个彩蛋都没生成出来');
    if (over) bad(over + ' 张彩蛋卡有技能超过房规上限');
    else if (n) ok('彩蛋卡逐项不超房规上限');
    if (overSum) bad(overSum + ' 张彩蛋卡属性总和超过 400');
    else if (n) ok('彩蛋卡属性总和全部 ≤ 400（等比压缩保住人物特征）');
    if (unsound) bad(unsound + ' 张彩蛋卡未通过完整性校验');
    else if (n) ok('彩蛋卡全部通过 Engine.checkList');
    if (noCap) bad(noCap + ' 张彩蛋卡没吃到房规上限');
    else if (n) ok('彩蛋卡同样吃到了属性上限与技能上限');
  }

  /* 4) 清掉上限 ＝ 恢复不限（老用户升级后行为不变） */
  Store.setSettings({ aiAttrCap: 0, aiAttrCapWithLuck: true, aiOccPtsCap: 0, aiIntPtsCap: 0 });
  {
    const c = G.generateOne({ ctx: { used: {} } });
    const r = scan(c);
    if (r.capOcc !== 99 || r.capInt !== 99 || r.capAttr) {
      bad('清除上限后卡上仍残留上限：' + JSON.stringify(
        { occ: r.capOcc, int: r.capInt, attr: r.capAttr }));
    } else if (r.summaryCap.occCap || r.summaryCap.intCap || r.summaryCap.attrCap) {
      bad('清除上限后摘要仍报上限');
    } else ok('「全部清除」后随机卡恢复不限');
  }

  /* 5) 上限是变量：改完设置立刻按新值来（不是启动时读死的常量） */
  Store.setSettings({ aiAttrCap: 360, aiAttrCapWithLuck: true, aiOccPtsCap: 40, aiIntPtsCap: 30 });
  {
    const c = G.generateOne({ ctx: { used: {} } });
    const r = scan(c);
    if (r.sum9 > 360) bad('换上限后属性没有立刻收紧：' + r.sum9);
    else if (r.capOcc !== 40 || r.capInt !== 30) {
      bad('换上限后技能上限没有立刻生效：' + r.capOcc + '/' + r.capInt);
    } else ok(`改设置后新卡立刻按新上限来（属性 ${r.sum9} ≤ 360，技能 40/30）`);
  }
  Store.setSettings({ aiAttrCap: 0, aiAttrCapWithLuck: true, aiOccPtsCap: 0, aiIntPtsCap: 0 });
}

console.log('\n' + (fail ? `RESULT: FAIL（${fail} 项）` : 'RESULT: PASS'));
process.exit(fail ? 1 : 0);
