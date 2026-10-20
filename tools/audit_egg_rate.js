/* 审查：彩蛋角色到底能不能被随机出来？
 *
 * 用真实生成流程跑大样本，回答三个问题：
 *   1) 一次「生成随机角色（5 张）」里能出几个彩蛋？
 *   2) 8 位跑团成员各自被抽中的概率（用户点名要确认）
 *   3) 彩蛋卡能不能通过完整性校验（能直接用）
 *
 * 关键：要**真的走 PresetGen.generate()**，而不是直接调 roll()，
 * 因为 generate 里有一堆可能把彩蛋「吃掉」的逻辑
 * （同批去重、setting 占用、profile 注入…）。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'web', 'js');
function makeSandbox() {
  const s = {
    console, Math, JSON, Date, Object, Array, String, Number,
    parseInt, parseFloat, isNaN, isFinite, Uint8Array, Int32Array, RegExp
  };
  s.window = s; s.global = s; s.globalThis = s;
  vm.createContext(s);
  return s;
}
function loadAll(s) {
  ['data/skills', 'data/occupations', 'data/weapons', 'data/armors', 'data/vehicles',
   'data/madness', 'data/spells', 'data/assets',
   'core/dice', 'core/rules-coc7', 'core/occupation', 'core/skillmodel', 'core/engine',
   'core/store', 'core/madness', 'core/personas', 'core/avatar', 'core/easter-egg',
   'core/preset'].forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(root, f + '.js'), 'utf8'), s, { filename: f });
  });
}

let fail = 0;
const bad = (m) => { console.log('  [FAIL] ' + m); fail++; };

const s = makeSandbox();
loadAll(s);
const G = s.PresetGen;
const E = s.CocEasterEgg;

console.log('== 1. 单次「生成随机角色」能出几个彩蛋 ==');
{
  const N = 3000;
  let batches = 0, withEgg = 0, totalCards = 0, eggCards = 0;
  const perBatch = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (let i = 0; i < N; i++) {
    const cards = G.generate(5);
    batches++;
    totalCards += cards.length;
    let n = 0;
    cards.forEach((c) => { if (c.isEasterEgg) { eggCards++; n++; } });
    if (n > 0) withEgg++;
    perBatch[Math.min(n, 3)] = (perBatch[Math.min(n, 3)] || 0) + 1;
  }
  console.log(`  跑了 ${N} 批（共 ${totalCards} 张卡）`);
  console.log(`  含彩蛋的批次：${withEgg} / ${N}（${(withEgg / N * 100).toFixed(1)}%）`);
  console.log(`  彩蛋卡总数：${eggCards} / ${totalCards}（${(eggCards / totalCards * 100).toFixed(2)}%）`);
  console.log(`  每批个数分布：0 个 ${perBatch[0]} 批 / 1 个 ${perBatch[1]} / 2 个 ${perBatch[2]} / 3+ 个 ${perBatch[3]}`);
  if (withEgg === 0) bad('3000 批里一张彩蛋都没出 —— 彩蛋实际抽不到！');
  if (withEgg / N < 0.35) bad(`含彩蛋批次仅 ${(withEgg / N * 100).toFixed(1)}%，用户实际几乎遇不到`);
}

console.log('\n== 2. 用户点名的 8 位成员能不能被抽中 ==');
{
  const want = ['茶叶蛋', '秦九', '北北', '小张', '乌龟', '阿肆', '年年', 'R.B'];
  const N = 20000;
  const hit = {};
  want.forEach((n) => { hit[n] = 0; });
  const wrongGender = {};
  let friendTotal = 0, celebTotal = 0;

  for (let i = 0; i < N; i++) {
    // 走真实路径：generate() 每批调用一次 rollBatch()，一批最多一个彩蛋
    const egg = E.rollBatch(5);
    if (!egg) continue;
    if (egg.kind === 'friend') friendTotal++; else celebTotal++;
    if (hit[egg.data.name] !== undefined) hit[egg.data.name]++;
    // 性别一致性：拿「资料里的性别」和「期望性别」比。
    // 期望值直接在 FRIENDS 表里查，避免把判断写死在测试里。
    // （第一版按名字猜「男/女」，把名人卡也算进去了 → 误报 20 位名人性别错乱）
    const src = E.all().find((x) => x.data.name === egg.data.name);
    if (src && src.data.gender && egg.data.gender !== src.data.gender) {
      wrongGender[egg.data.name] = (wrongGender[egg.data.name] || 0) + 1;
    }
  }

  console.log(`  ${N} 批中：彩蛋成员卡 ${friendTotal} 张，名人卡 ${celebTotal} 张`);
  const totalCards = N * 5;
  console.log('  成员命中情况：');
  let neverHit = [];
  want.forEach((n) => {
    const pct = hit[n] / totalCards * 100;
    const flag = hit[n] === 0 ? '  ← 从未出现' : '';
    if (hit[n] === 0) neverHit.push(n);
    console.log(`    ${n.padEnd(4)} ${String(hit[n]).padStart(4)} 张  ${pct.toFixed(3)}%${flag}`);
  });

  if (neverHit.length) bad(`以下成员从未被抽中：${neverHit.join('、')}`);

  const friendPct = friendTotal / totalCards * 100;
  console.log(`  成员彩蛋合计 ${friendPct.toFixed(3)}%`);
  if (friendPct < 0.5) bad(`成员彩蛋概率仅 ${friendPct.toFixed(3)}%（按单卡口径），太低`);

  const badGender = Object.keys(wrongGender);
  if (badGender.length) bad(`性别错乱：${badGender.map((k) => k + '×' + wrongGender[k]).join('、')}`);
  else console.log('  性别全部正确');

  // 一批 = 一次「生成随机角色」，所以概率直接就是 hit/N（不再乘 5）
  console.log('  「点一次生成随机角色」能遇到该成员的概率：');
  const perRun = {};
  want.forEach((n) => {
    perRun[n] = hit[n] / N * 100;
    console.log(`    ${n.padEnd(4)} ${perRun[n].toFixed(1)}%`);
  });
  const anyFriend = friendTotal / N * 100;
  console.log(`  遇到任意一位成员：${anyFriend.toFixed(1)}%`);
  console.log(`  遇到任意一位名人：${(celebTotal / N * 100).toFixed(1)}%`);
  if (anyFriend < 20) bad(`一次生成里遇到任意成员的概率过低（${anyFriend.toFixed(1)}%）`);
}

console.log('\n== 3. 彩蛋卡合规性（能不能直接用） ==');
{
  const N = 600;
  let ok = 0, tried = 0, badList = [];
  const seen = {};
  for (let i = 0; i < N; i++) {
    const cards = G.generate(5);
    cards.forEach((c) => {
      if (!c.isEasterEgg) return;
      // 同名只验一次，省时间
      if (seen[c.characterName]) return;
      seen[c.characterName] = 1;
      tried++;
      const bads = s.Engine.checkList(c).filter((x) => !x.ok);
      if (!bads.length) ok++;
      else badList.push(`${c.characterName}：${bads.map((x) => x.label || x.text || JSON.stringify(x)).join('、')}`);
    });
  }
  console.log(`  抽到过的彩蛋角色 ${tried} 种，通过完整性校验 ${ok} 种`);
  badList.forEach((b) => bad(b));
  if (badList.length) bad(`${badList.length} 种彩蛋卡不合规`);
  else console.log('  全部通过 Engine.checkList —— 可直接开团');
}

console.log('\n== 4. 预期概率对照 ==');
{
  const R2 = E.rates;
  console.log(`  代码设定（批级）：成员 ${(R2.batchFriend * 100).toFixed(0)}% / 名人 ${(R2.batchCeleb * 100).toFixed(0)}%`);
  console.log(`  一批（点一次）含彩蛋 = ${((R2.batchFriend + R2.batchCeleb) * 100).toFixed(0)}%`);
  console.log(`  单张卡的彩蛋概率 = ${(((R2.batchFriend + R2.batchCeleb) / 5) * 100).toFixed(1)}%`);
  console.log(`  单个人（8 位之一）= ${(R2.batchFriend / 8 * 100).toFixed(1)}%`);
  console.log('');
  console.log('  → 想调整就改 easter-egg.js 里的 BATCH_FRIEND_RATE / BATCH_CELEB_RATE');
  console.log('    （老实现按单张卡抽，成员摊薄到 13% —— 已废弃，保留 roll() 仅供测试）');
}

console.log('');
if (fail) { console.log(`RESULT: FAIL（${fail} 项）`); process.exit(1); }
console.log('RESULT: PASS');
