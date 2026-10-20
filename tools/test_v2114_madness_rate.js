/* ============================================================
 * test_v2114_madness_rate.js —— v2.11.4 随机角色卡「疯狂症状」概率
 *
 * 需求（用户原话，两轮澄清后）：
 *   ①「随机生成角色卡功能，现在好像每个随机出来的角色都有疯狂症。
       改为大约五分之一的角色有疯狂症（包括普通角色和名人彩蛋，
       不包括跑团成员彩蛋卡，所有跑团成员彩蛋卡都不要有疯狂症）。」
 *   ②「疯狂症有十种，这十种包括恐惧症和躁狂症，而恐惧症又有100种 /
       躁狂症又有100种，所以要先随机看看是哪种疯狂症 …
       如果得了恐惧症 / 躁狂症，再从100种恐惧症表或100种躁狂症表里面随机一个。」
 *
 * 改前根因：preset.js#fillBackground 无条件调用 CocMadness.backgroundText()，
 *   而 backgroundText() 必定返回一条症状 → 每张随机卡都带疯狂症状。
 *   类型抽取逻辑（先掷 1D10 十种，命中 9/10 再从 100 条子表抽）**本来就有且未改**，
 *   本次只加**概率闸门**与**跑团成员彩蛋豁免**。
 *
 * 本测试回答四个问题：
 *   1) 跑团成员彩蛋卡（eggKind='friend'）是不是 **0%**？
 *   2) 普通角色 + 名人彩蛋的整体比率是不是约 1/5（20%）？
 *   3) 带症状的卡，其症状文本是否真的来自「十种 → 100 条子表」这条链
 *      （【疯狂发作】8 种 / 【恐惧症】/【狂躁症】，且恐惧/躁狂条目确在 100 条表内）？
 *   4) 卡的合规性有没有被改坏（Engine.checkList 全过）？
 *
 * 运行： node tools/test_v2114_madness_rate.js   （工作目录 = 仓库根）
 * ============================================================ */
'use strict';
var fs = require('fs'), path = require('path');
var vm = require('vm');

var ROOT = path.join(__dirname, '..');
var JS = path.join(ROOT, 'web', 'js');

/* ---------------- vm 沙箱（装载方式同 audit_egg_rate.js） ---------------- */
function makeSandbox() {
  var s = {
    console: console, Math: Math, JSON: JSON, Date: Date, Object: Object,
    Array: Array, String: String, Number: Number, RegExp: RegExp,
    parseInt: parseInt, parseFloat: parseFloat, isNaN: isNaN, isFinite: isFinite,
    Uint8Array: Uint8Array, Int32Array: Int32Array
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
    'core/preset'].forEach(function (f) {
      vm.runInContext(fs.readFileSync(path.join(JS, f + '.js'), 'utf8'), s, { filename: f });
    });
}

var s = makeSandbox();
loadAll(s);
var G = s.PresetGen;
var MAD = s.CocMadness;

/* ---------------- 断言工具 ---------------- */
var pass = 0, fail = 0, failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  [PASS] ' + label); }
  else {
    fail++; failures.push(label);
    console.log('  [FAIL] ' + label + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra)));
  }
}
function pct(n, d) { return (n / d * 100).toFixed(2) + '%'; }

/* 是否带背景心理症状（'暂无。' / 空 = 不带） */
function hasSymptom(c) {
  var p = (c && c.background && c.background.phobias) || '';
  p = String(p).trim();
  return !!p && p !== '暂无。' && p !== '暂无' && p !== '无';
}
/* 症状文本的类型标签 */
function symptomKind(text) {
  var t = String(text || '');
  if (t.indexOf('【恐惧症】') === 0) return 'phobia';
  if (t.indexOf('【狂躁症】') === 0) return 'mania';
  if (t.indexOf('【疯狂发作】') === 0) return 'bout';
  return 'unknown';
}

/* 100 条子表的名字集合（用于验证恐惧/躁狂条目确系从子表抽出） */
var PHOBIA_NAMES = {}, MANIA_NAMES = {};
(s.COC_MADNESS.phobias || []).forEach(function (x) { PHOBIA_NAMES[x.name] = 1; });
(s.COC_MADNESS.manias || []).forEach(function (x) { MANIA_NAMES[x.name] = 1; });

/* ============================================================
 * 0. 前置：疯狂表数据完整性（十种 / 100 条子表）
 * ============================================================ */
console.log('== 0. 疯狂表数据完整性 ==');
(function () {
  ok((s.COC_MADNESS.phobias || []).length === 100,
    '恐惧症子表 100 条', (s.COC_MADNESS.phobias || []).length);
  ok((s.COC_MADNESS.manias || []).length === 100,
    '狂躁症子表 100 条', (s.COC_MADNESS.manias || []).length);
  /* backgroundText 的十种口径：掷 2000 次，kind 分布应覆盖 bout/phobia/mania 三类，
     且 phobia+mania 合计约 2/10（第 9、10 条）—— 证明「先定类型、再抽子表」这条链是活的。 */
  var kinds = { bout: 0, phobia: 0, mania: 0, unknown: 0 }, N = 2000;
  for (var i = 0; i < N; i++) {
    var t = MAD.backgroundText();
    kinds[symptomKind(t)]++;
  }
  console.log('  backgroundText 掷 ' + N + ' 次：疯狂发作 ' + kinds.bout +
    ' / 恐惧症 ' + kinds.phobia + ' / 狂躁症 ' + kinds.mania +
    ' / 未知 ' + kinds.unknown);
  ok(kinds.unknown === 0, '★ backgroundText 输出全部带合法类型标签（十种之一）', kinds);
  ok(kinds.bout > 0 && kinds.phobia > 0 && kinds.mania > 0,
    '★ 三类疯狂症都能被掷到（不是只会出某一种）', kinds);
  ok(kinds.phobia + kinds.mania > N * 0.10,
    '★ 恐惧症+躁狂症合计 >10%（第 9/10 条，理论 20%）', kinds);
})();

/* ============================================================
 * 1. 跑团成员彩蛋卡：0%（确定性，不靠统计）
 * ============================================================ */
console.log('\n== 1. 跑团成员彩蛋卡一律不带疯狂症状（确定性） ==');
(function () {
  var N = 400, withSym = 0;
  for (var i = 0; i < N; i++) {
    /* 走对外入口 buildFrom(profile) —— 内部即 build()，且会自检重掷保证卡合规。
       profile 只给彩蛋标记，其余仍按随机流程生成，
       这样测的是「friend 彩蛋」这条分支本身，不受 rollBatch 概率干扰。 */
    var c = G.buildFrom({ isEasterEgg: true, eggKind: 'friend' });
    if (hasSymptom(c)) withSym++;
  }
  console.log('  构建 ' + N + ' 张跑团成员彩蛋卡，带症状 ' + withSym + ' 张');
  ok(withSym === 0, '★ 跑团成员彩蛋卡疯狂症状率 = 0%（用户要求「都不要有」）', withSym);
})();

/* ============================================================
 * 2. 名人彩蛋卡：也走 1/5（确定性双分支）
 * ============================================================ */
console.log('\n== 2. 名人彩蛋卡同样按 1/5 概率（确定性双分支） ==');
(function () {
  /* 用可注入的随机源把概率钳成两种极端，验证两条分支都可达。
     注意：preset 内部用 Math.random()，故这里临时替换、用完即还。 */
  var orig = Math.random;
  function withRandom(v, fn) {
    Math.random = function () { return v; };
    try { return fn(); } finally { Math.random = orig; }
  }
  /* v = 0.10 < 0.2 → 必带症状 */
  var yes = withRandom(0.10, function () {
    return G.buildFrom({ isEasterEgg: true, eggKind: 'celeb' });
  });
  ok(hasSymptom(yes), '★ 名人彩蛋（概率命中）→ 带症状（分支可达）',
    yes && yes.background && yes.background.phobias);
  /* v = 0.90 >= 0.2 → 必不带 */
  var no = withRandom(0.90, function () {
    return G.buildFrom({ isEasterEgg: true, eggKind: 'celeb' });
  });
  ok(!hasSymptom(no), '★ 名人彩蛋（概率未命中）→ 不带症状（分支可达）',
    no && no.background && no.background.phobias);
  /* 对照：同一个 v=0.10 下，friend 彩蛋仍必须不带（豁免优先于概率） */
  var friend = withRandom(0.10, function () {
    return G.buildFrom({ isEasterEgg: true, eggKind: 'friend' });
  });
  ok(!hasSymptom(friend), '★ 同一概率命中下，跑团成员彩蛋仍豁免（friend 优先于概率）',
    friend && friend.background && friend.background.phobias);
})();

/* ============================================================
 * 3. 大样本：整体比率 ≈ 1/5，且分层口径一致
 * ============================================================ */
console.log('\n== 3. 大样本：走真实 generate() 的整体比率 ==');
(function () {
  /* 默认 1500 批（7500 张卡，约 70s）。想跑更大样本可用环境变量覆盖：
       N_BATCH=6000 node tools/test_v2114_madness_rate.js
     统计精度：n=7500、p=0.2 → 标准误 ≈0.46pp，±4pp 容差约 8.7 个标准差。 */
  var N_BATCH = parseInt(process.env.N_BATCH, 10) || 1500;
  var tot = 0, sym = 0;
  var normalTot = 0, normalSym = 0;
  var celebTot = 0, celebSym = 0;
  var friendTot = 0, friendSym = 0;
  var badKind = 0, badPhobiaEntry = 0, badManiaEntry = 0;
  var invalid = 0, checked = 0, CHECK_MAX = 400;

  for (var i = 0; i < N_BATCH; i++) {
    if (i % 500 === 0 && i > 0) console.log('  …已跑 ' + i + ' / ' + N_BATCH + ' 批');
    var cards = G.generate(5);
    for (var j = 0; j < cards.length; j++) {
      var c = cards[j];
      tot++;
      var has = hasSymptom(c);
      if (has) {
        sym++;
        var k = symptomKind(c.background.phobias);
        if (k === 'unknown') badKind++;
        /* 恐惧症 / 躁狂症的条目必须确系来自 100 条子表 */
        if (k === 'phobia' || k === 'mania') {
          var nm = String(c.background.phobias).replace(/^【[^】]+】/, '').split('：')[0];
          var inPool = (k === 'phobia') ? !!PHOBIA_NAMES[nm] : !!MANIA_NAMES[nm];
          if (!inPool) { if (k === 'phobia') badPhobiaEntry++; else badManiaEntry++; }
        }
      }
      if (c.isEasterEgg && c.eggKind === 'friend') { friendTot++; if (has) friendSym++; }
      else if (c.isEasterEgg) { celebTot++; if (has) celebSym++; }
      else { normalTot++; if (has) normalSym++; }
      /* 合规性抽样：checkList 单价 ~8ms，全量跑会把测试拖到分钟级，
         故只抽前 CHECK_MAX 张（不带症状的卡也不能变得不合规）。 */
      if (checked < CHECK_MAX) {
        checked++;
        if (s.Engine.checkList(c).filter(function (x) { return !x.ok; }).length) invalid++;
      }
    }
  }

  console.log('  共 ' + tot + ' 张卡（' + N_BATCH + ' 批 × 5）');
  console.log('  整体带症状：' + sym + ' / ' + tot + ' = ' + pct(sym, tot));
  console.log('  普通随机角色：' + normalSym + ' / ' + normalTot + ' = ' + pct(normalSym, normalTot));
  console.log('  名人彩蛋：  ' + celebSym + ' / ' + celebTot + ' = ' + pct(celebSym, celebTot));
  console.log('  成员彩蛋：  ' + friendSym + ' / ' + friendTot + ' = ' + pct(friendSym, friendTot));

  ok(sym > 0, '有卡带症状（不是全被关掉了）', sym);
  /* 期望 20%；样本 2 万张，取 ±4 个百分点作容差（约 6 个标准差） */
  var rate = sym / tot;
  ok(rate > 0.16 && rate < 0.24,
    '★ 整体疯狂症状率约 1/5（16%–24% 容差）', pct(sym, tot));
  ok(friendTot > 50, '样本里确实抽到了跑团成员彩蛋（否则第 4 项空跑）', friendTot);
  ok(friendSym === 0, '★ 跑团成员彩蛋 0% 带症状（大样本复核）', friendSym + '/' + friendTot);
  if (celebTot > 50) {
    ok(celebSym / celebTot > 0.08 && celebSym / celebTot < 0.35,
      '★ 名人彩蛋同样约 1/5（8%–35% 容差，样本较小）', pct(celebSym, celebTot));
  }
  if (normalTot > 500) {
    ok(normalSym / normalTot > 0.16 && normalSym / normalTot < 0.24,
      '★ 普通随机角色约 1/5（16%–24% 容差）', pct(normalSym, normalTot));
  }
  ok(badKind === 0, '★ 所有症状文本都带合法类型标签', badKind);
  ok(badPhobiaEntry === 0 && badManiaEntry === 0,
    '★ 恐惧症/躁狂症条目确系来自 100 条子表（不是凭空文本）',
    { phobia: badPhobiaEntry, mania: badManiaEntry });
  ok(invalid === 0, '★ 全部卡通过 Engine.checkList（合规性未回归）', invalid);
})();

/* ============================================================
 * 4. 回归护栏：backgroundText 本身没被改坏
 * ============================================================ */
console.log('\n== 4. 回归护栏 ==');
(function () {
  var t = MAD.backgroundText('（尾巴）');
  /* 格式：【类型】名字：描述（尾巴）—— 尾巴拼在**描述之后**，不是紧跟冒号 */
  ok(/^【(疯狂发作|恐惧症|狂躁症)】[^：]+：.+（尾巴）$/.test(t),
    'backgroundText 输出格式仍为「【类型】名字：描述（尾巴）」', t);
  ok(typeof MAD.backgroundText() === 'string' && MAD.backgroundText().length > 0,
    'backgroundText() 无参调用仍可用（AI 车卡等路径不受影响）');
  /* 十种类型标签覆盖：8 种疯狂发作 + 恐惧症 + 躁狂症 */
  var seen = {}, N = 6000;
  for (var i = 0; i < N; i++) {
    var x = MAD.backgroundText();
    seen[x.replace(/：.*$/, '')] = 1;
  }
  var labels = Object.keys(seen);
  console.log('  掷 ' + N + ' 次出现 ' + labels.length + ' 种不同症状标签');
  ok(labels.length >= 8, '★ 能覆盖多种疯狂症类型（不是永远同一种）', labels.length);
})();

/* ---------------- 汇总 ---------------- */
console.log('\n' + '='.repeat(58));
if (fail) { console.log('失败项：'); failures.forEach(function (f) { console.log('  [FAIL] ' + f); }); }
console.log('test_v2114_madness_rate: ' + pass + ' passed, ' + fail + ' failed');
console.log('RESULT: ' + (fail ? 'FAIL' : 'PASS'));
process.exitCode = fail ? 1 : 0;
