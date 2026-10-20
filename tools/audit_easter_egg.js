/* 审计：彩蛋角色卡（easter-egg.js）与疯狂状态（madness.js）
 *
 * 彩蛋部分验证：
 *   1) 用户点名的 8 位跑团成员全部存在、性别正确、时代为现代、属性偏高
 *   2) 名人卡覆盖古今中外，属性不越界
 *   3) 彩蛋走完整生成流程后能通过 Engine.checkList（合规可用）
 *   4) 命中率在预期区间
 *
 * 疯狂状态部分验证：
 *   1) 症状表非空，条目结构完整
 *   2) roll 出来的每条都带 1-10 轮
 *   3) advance 只让临时疯狂消退，永久疯狂不动
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'web', 'js');
let fail = 0;
const bad = (m) => { console.log('  [FAIL] ' + m); fail++; };

function makeSandbox() {
  const s = {
    console, Math, JSON, Date, Object, Array, String, Number,
    parseInt, parseFloat, isNaN, isFinite, Uint8Array, Int32Array
  };
  s.window = s; s.global = s; s.globalThis = s;
  vm.createContext(s);
  return s;
}

function load(s, rel) {
  vm.runInContext(fs.readFileSync(path.join(root, rel), 'utf8'), s, { filename: rel });
}

/* ============================================================
 * 一、疯狂状态
 * ============================================================ */
console.log('== 疯狂状态（COC_MADNESS → CocMadness）==');
{
  const s = makeSandbox();
  load(s, path.join('data', 'madness.js'));
  load(s, path.join('core', 'madness.js'));

  const M = s.CocMadness;
  const ph = s.COC_MADNESS.phobias || [];
  const mn = s.COC_MADNESS.manias || [];
  console.log(`  症状表：恐惧症 ${ph.length} 条 / 狂躁症 ${mn.length} 条 / 合计 ${M.size}`);
  if (ph.length < 50 || mn.length < 50) bad('症状表条数异常');

  // 结构完整性
  [].concat(ph, mn).forEach((x, i) => {
    if (!x.name || !x.desc) bad(`第 ${i + 1} 条症状缺 name/desc`);
  });
  console.log('  症状表结构完整（name + desc 均有）');

  // roll：每条都带 1-10 轮
  const fake = { madness: [] };
  let minR = 99, maxR = 0;
  for (let i = 0; i < 3000; i++) {
    const m = M.roll('any', false);
    if (!m) { bad('roll 返回 null'); break; }
    if (!(m.rounds >= 1 && m.rounds <= 10)) bad('轮数越界：' + m.rounds);
    if (m.permanent) bad('临时疯狂被标成了 permanent');
    /* v2.1.7：疯狂表 1D10 —— 1-8 是发作行为（bout），合法类型 */
    if (m.type !== 'phobia' && m.type !== 'mania' && m.type !== 'bout') bad('type 非法：' + m.type);
    minR = Math.min(minR, m.rounds); maxR = Math.max(maxR, m.rounds);
  }
  console.log(`  掷 3000 次临时疯狂：轮数区间 ${minR} - ${maxR}（要求 1-10）`);

  // 永久疯狂
  const p = M.roll('any', true);
  if (!p.permanent) bad('永久疯狂标记丢失');
  if (p.rounds !== 0) bad('永久疯狂不应有轮数');
  console.log('  永久疯狂标记正确（rounds = 0）');

  // 两种类型都能掷到
  const kinds = new Set();
  for (let i = 0; i < 500; i++) kinds.add(M.roll('any', false).type);
  if (!kinds.has('phobia') || !kinds.has('mania')) bad('两种症状类型未都能掷到');
  console.log(`  症状类型覆盖：${[...kinds].join(' / ')}`);

  // advance：只消退临时，永久保留
  const ch = { madness: [] };
  M.add(ch, M.make('phobia', M.phobias()[0], false, 2));   // 2 轮
  M.add(ch, M.make('mania', M.manias()[0], false, 5));     // 5 轮
  M.add(ch, M.make('phobia', M.phobias()[1], true));        // 永久
  if (ch.madness.length !== 3) bad('add 之后应有 3 条');

  let faded = M.advance(ch, 1);
  if (faded.length !== 0) bad('推进 1 轮不该有症状到期（2 轮→1、5 轮→4），实际消退 ' + faded.length + ' 条');
  if (ch.madness.length !== 3) bad('推进 1 轮后应仍是 3 条');
  const after1 = ch.madness.map((m) => m.rounds);
  if (!(after1[0] === 1 && after1[1] === 4)) bad('轮数倒计时不对：' + after1);
  console.log('  推进 1 轮：轮数 2→1、5→4，均未到期（符合预期）');

  // 再推进 1 轮：2 轮的那条到期消退
  faded = M.advance(ch, 1);
  if (faded.length !== 1) bad('再推进 1 轮应有 1 条到期，实际 ' + faded.length);
  if (ch.madness.length !== 2) bad('此时应剩 2 条');
  if (!ch.madness.some((m) => m.permanent)) bad('永久疯狂被误删');
  console.log('  再推进 1 轮：2 轮的那条到期消退，永久疯狂保留');

  // 一次推进 10 轮：5 轮的那条也到期
  faded = M.advance(ch, 10);
  if (faded.length !== 1) bad('推进 10 轮应再有 1 条到期，实际 ' + faded.length);
  if (ch.madness.length !== 1) bad('最终应只剩永久那 1 条');
  if (!ch.madness[0].permanent) bad('剩下的应是永久疯狂那条');
  console.log('  临时疯狂到点自动消退，永久疯狂始终保留');

  // remove
  const pid = ch.madness[0].id;
  M.remove(ch, pid);
  if (ch.madness.length !== 0) bad('remove 失败');
  console.log('  可手动删除单条疯狂状态');

  // summary
  const ch2 = { madness: [] };
  M.add(ch2, M.make('phobia', M.phobias()[0], false, 3));
  M.add(ch2, M.make('mania', M.manias()[0], true));
  const sm = M.summary(ch2);
  if (!/3 轮/.test(sm) || !/永久/.test(sm)) bad('summary 缺轮数或永久标记：' + sm);
  console.log('  摘要含轮数与永久标记：' + sm);
}

/* ============================================================
 * 二、彩蛋
 * ============================================================ */
console.log('\n== 彩蛋角色 ==');
{
  const s = makeSandbox();
  load(s, path.join('data', 'skills.js'));
  load(s, path.join('data', 'occupations.js'));
  load(s, path.join('data', 'weapons.js'));
  load(s, path.join('data', 'armors.js'));
  load(s, path.join('data', 'vehicles.js'));
  load(s, path.join('data', 'madness.js'));
  load(s, path.join('data', 'spells.js'));
  load(s, path.join('data', 'assets.js'));
  load(s, path.join('core', 'dice.js'));
  load(s, path.join('core', 'rules-coc7.js'));
  load(s, path.join('core', 'occupation.js'));
  load(s, path.join('core', 'skillmodel.js'));
  load(s, path.join('core', 'engine.js'));
  load(s, path.join('core', 'store.js'));
  load(s, path.join('core', 'madness.js'));
  load(s, path.join('core', 'personas.js'));
  load(s, path.join('core', 'avatar.js'));
  load(s, path.join('core', 'easter-egg.js'));
  load(s, path.join('core', 'preset.js'));

  const E = s.CocEasterEgg;
  console.log(`  彩蛋池：名人 ${E.celebrities.length} 位 + 跑团成员 ${E.friends.length} 位 = ${E.size}`);

  /* --- 1) 用户点名的 8 位跑团成员 --- */
  const want = [
    { name: '茶叶蛋', gender: '男' },
    { name: '秦九', gender: '女' },
    { name: '北北', gender: '女' },
    { name: '小张', gender: '男' },
    { name: '乌龟', gender: '男' },
    { name: '阿肆', gender: '女' },
    { name: '年年', gender: '男' },
    { name: 'R.B', gender: '男' }
  ];
  console.log('  -- 用户点名的跑团成员 --');
  want.forEach((w) => {
    const f = E.friends.find((x) => x.name === w.name);
    if (!f) { bad(`缺少跑团成员「${w.name}」`); return; }
    if (f.gender !== w.gender) bad(`${w.name} 性别应为 ${w.gender}，实际 ${f.gender}`);
    if (!f.era || f.era !== '现代') bad(`${w.name} 时代应为现代，实际 ${f.era}`);
    if (!f.occ) bad(`${w.name} 缺职业`);
    // 必须显式指定世界设定，否则 generate() 会回落到随机设定，
    // 出现过「阿肆 · 英国 · 维多利亚时代」这种明显不对的组合
    if (!f.setting) bad(`${w.name} 缺 setting（会被随机成别国/别的时代）`);
    else if (f.setting !== 'cn-modern') bad(`${w.name} 的 setting 应为 cn-modern，实际 ${f.setting}`);
    console.log(`    [OK] ${f.name}（${f.gender}）· ${f.occ} · ${f.era} · ${f.setting} · 年龄 ${f.age}`);
  });
  if (E.friends.length !== 8) bad(`跑团成员应为 8 位，实际 ${E.friends.length}`);

  // 属性要比普通随机卡「稍高」
  const avg = E.friends.reduce((t, f) => {
    const k = ['str', 'con', 'siz', 'dex', 'app', 'int', 'pow', 'edu', 'luck'];
    return t + k.reduce((x, kk) => x + Number(f.attrs[kk]), 0) / k.length;
  }, 0) / E.friends.length;
  console.log(`  跑团成员平均属性 ${avg.toFixed(1)}（规则书 3D6×5 均值 55，普通优秀卡约 55-70）`);
  if (avg < 60) bad(`跑团成员属性偏低（均值 ${avg.toFixed(1)}），应「稍微高点」`);

  /* --- 2) 名人覆盖古今中外 --- */
  console.log('  -- 名人卡 --');
  const eras = new Set();
  E.celebrities.forEach((c) => {
    eras.add(c.era);
    if (!c.gender) bad(`${c.name} 缺性别`);
    if (!c.name || !c.occ) bad(`${c.name} 字段不全`);
    const keys = ['str', 'con', 'siz', 'dex', 'app', 'int', 'pow', 'edu', 'luck'];
    keys.forEach((k) => {
      const v = c.attrs[k];
      if (!(v >= 15 && v <= 99)) bad(`${c.name} 的 ${k}=${v} 越界`);
    });
  });
  console.log(`    时代分布：${[...eras].join(' / ')}`);
  // 「特斯拉」重复名检查
  const dup = {};
  E.celebrities.forEach((c) => { dup[c.name] = (dup[c.name] || 0) + 1; });
  Object.keys(dup).forEach((n) => { if (dup[n] > 1) bad(`名人重名：${n}`); });
  console.log(`    名人 ${E.celebrities.length} 位，无重名，属性均在 15-99`);

  /* --- 3) 走完整生成流程，验证合规 --- */
  console.log('  -- 完整生成 + 完整性校验 --');
  let ok = 0, tried = 0, failList = [];
  for (const egg of E.all()) {
    const pf = E.toProfile(egg);
    let c = null;
    for (let t = 0; t < 4; t++) {
      c = s.PresetGen.generateOne({
        setting: s.CocPersonas.resolve(pf.setting) || undefined,
        ctx: { used: {} },
        profile: pf
      });
      if (c && s.PresetGen.isSound(c)) break;
    }
    tried++;
    if (!c) { failList.push(egg.data.name + '：生成失败'); continue; }
    const bads = s.Engine.checkList(c).filter((x) => !x.ok);
    if (bads.length) {
      failList.push(`${egg.data.name}：${bads.map((x) => x.label || x.text || JSON.stringify(x)).join('、')}`);
      continue;
    }
    /* 职业的 choice / free 选择块本身也要自洽：
       duplicatePicks 只在 free 块之间查重，若实现改成不分类型，
       就会把「两个 choice 块选到同一技能」误判成不合格 ——
       这条断言就是守这个边界的（曾把 12/29 张彩蛋卡判失败）。 */
    const occErrs = s.COC7.validators.occupationChoices(c, s.CocOccupation)
      .map((e) => e.text).filter((t) => /重复|已经/.test(t));
    if (occErrs.length) {
      failList.push(`${egg.data.name}：任选项去重误报 —— ${occErrs.join('、')}`);
      continue;
    }
    // 姓名必须是资料里的原名
    if (c.characterName !== egg.data.name) {
      failList.push(`${egg.data.name}：姓名被改成「${c.characterName}」`);
      continue;
    }
    /* 居住地：名人彩蛋与阿肆在资料里写了 city → 必须写死（彩蛋的意义就在这里，
       不能被随机掉）；跑团成员 v2.11.5 起**不写 city**，住所改为随机（用户要求），
       这里只要求「非空且不是『未知』」，随机性由下方 3b 专门验证。 */
    if (egg.data.city) {
      if (c.basicInfo.residence !== egg.data.city) {
        failList.push(`${egg.data.name}：居住地被改成「${c.basicInfo.residence}」（应为 ${egg.data.city}）`);
        continue;
      }
    } else if (!c.basicInfo.residence || c.basicInfo.residence === '未知') {
      failList.push(`${egg.data.name}：随机居住地为空或「未知」（${c.basicInfo.residence}）`);
      continue;
    }
    /* 籍贯一律写死（跑团成员 v2.11.5：除阿肆=六安外均为宿州） */
    if (c.basicInfo.birthplace !== egg.data.town) {
      failList.push(`${egg.data.name}：籍贯被改成「${c.basicInfo.birthplace}」（应为 ${egg.data.town}）`);
      continue;
    }
    // 世界设定必须跟着资料走（跑团成员必须是 cn-modern，不能是英国维多利亚）
    if (c.worldId !== egg.data.setting) {
      failList.push(`${egg.data.name}：世界设定被改成「${c.worldId}」（应为 ${egg.data.setting}）`);
      continue;
    }
    // 装备必须符合该设定的年代口径
    // （这条抓到过一个真 bug：武器表的 era 字段把「罕见」这种稀有度
    //   和年代混在一起，导致古代卡会掏出 .58 斯普林菲尔德步枪）
    const st = s.CocPersonas.getById(c.worldId);
    const pools = s.PresetGen.weaponPools(st);
    const legal = {};
    pools.melee.forEach((w) => { legal[w.name] = 1; });
    pools.gun.forEach((w) => { legal[w.name] = 1; });
    (c.weapons || []).forEach((w) => {
      if (!legal[w.name]) {
        failList.push(`${egg.data.name}：装备「${w.name}」不符合 ${st.label} 的年代口径`);
      }
    });
    if (!c.avatar) { failList.push(`${egg.data.name}：缺头像`); continue; }
    if (!c.isEasterEgg) { failList.push(`${egg.data.name}：isEasterEgg 未置位`); continue; }
    ok++;
  }
  console.log(`    ${ok} / ${tried} 张彩蛋卡通过完整性校验`);
  failList.forEach((x) => bad(x));

  /* --- 3b) 跑团成员住所随机性（v2.11.5 用户要求） ---
     需求原文：「所有跑团成员（除了阿肆），籍贯改为宿州，住所改为随机。
                阿肆籍贯改为六安，住所改为宿州。」
     上方 3) 只验证了「非空」，这里专门验证**真的在随机**：
       · 非阿肆成员：连跑多次必须出现 ≥2 种不同住所；
       · 阿肆：必须恒定宿州；
       · 籍贯：全员恒定（非阿肆=宿州，阿肆=六安）。 */
  console.log('  -- 跑团成员住所随机性 --');
  E.friends.forEach((f) => {
    const cities = {}, towns = {};
    for (let i = 0; i < 12; i++) {
      const c = s.PresetGen.generateOne({
        setting: s.CocPersonas.resolve(f.setting) || undefined,
        ctx: { used: {} },
        profile: E.toProfile({ kind: 'friend', data: f })
      });
      if (!c) { bad(`${f.name}：生成失败`); return; }
      cities[c.basicInfo.residence] = 1;
      towns[c.basicInfo.birthplace] = 1;
    }
    const n = Object.keys(cities).length;
    const wantTown = (f.name === '阿肆') ? '六安' : '宿州';
    if (Object.keys(towns).length !== 1 || !towns[wantTown]) {
      bad(`${f.name}：籍贯不恒定（${Object.keys(towns).join('/')}，应为 ${wantTown}）`);
    }
    if (f.name === '阿肆') {
      if (n !== 1 || !cities['宿州']) {
        bad(`阿肆：住所应固定宿州，实际 ${Object.keys(cities).join('/')}`);
      } else {
        console.log(`    阿肆：住所固定宿州、籍贯六安`);
      }
    } else {
      if (n < 2) {
        bad(`${f.name}：住所没有随机化（12 次全是 ${Object.keys(cities)[0]}）`);
      } else {
        console.log(`    ${f.name}：籍贯宿州，住所随机（${n} 种：${Object.keys(cities).slice(0, 4).join('、')}…）`);
      }
    }
  });

  /* --- 4) 命中率 --- */
  console.log('  -- 命中率 --');
  let hits = 0, friendHits = 0, celebHits = 0;
  for (let i = 0; i < 200000; i++) {
    const e = E.roll();
    if (!e) continue;
    hits++;
    if (e.kind === 'friend') friendHits++; else celebHits++;
  }
  const rate = (hits / 200000 * 100).toFixed(2);
  const fRate = (friendHits / 200000 * 100).toFixed(2);
  const cRate = (celebHits / 200000 * 100).toFixed(2);
  console.log(`    总命中 ${rate}%（名人 ${cRate}% / 朋友 ${fRate}%）`);
  if (hits / 200000 < 0.03 || hits / 200000 > 0.10) bad(`总命中率 ${rate}% 不在预期 4~8% 区间`);
  if (friendHits === 0) bad('朋友彩蛋从未命中');
  if (celebHits === 0) bad('名人彩蛋从未命中');
}

console.log('');
if (fail) { console.log(`RESULT: FAIL（${fail} 项）`); process.exit(1); }
console.log('RESULT: PASS');
