/* ============================================================
 * test_v2114_egg_occupation.js —— v2.11.5 彩蛋卡职业精确落位 + 跑团成员籍贯/住所 + AI 卡疯狂症状归属
 *
 * 需求一（名人彩蛋职业匹配）：
 *   「随机角色里面，名人彩蛋，我发现名人和职业不是特别匹配，
     改成让职业和名人更符合，比如李时珍是医生职业。」
 *
 * 需求二（跑团成员职业 + 籍贯/住所，v2.11.5）：
 *   「所有跑团成员（除了阿肆），籍贯改为宿州，住所改为随机。阿肆籍贯改为六安，住所改为宿州。
     茶叶蛋和R.B实际职业为公务员，亲九为奶茶总部运营，北北为画师，小张为羽毛球教练，
     年年为银行职员，乌龟为设计院职工，阿肆为保安公司运营。使彩蛋-跑团成员角色卡职业更匹配实际情况」
 *
 * 根因（职业）：彩蛋数据里的 occ 大量**不在 224 个职业表里**，preset 的
 *   occupationByName() 精确匹配失败后走**子串模糊匹配**或直接**回退随机职业** ——
 *   实测改前 22 位名人里 17 位落错职业、8 位跑团成员里 3 位落错。
 *
 * 需求三（AI 车卡疯狂症状）：
 *   「ai车卡别改疯狂概率论，就用描述之后让ai决定有没有疯狂症吧」
 *   → ai.js 不再代替系统掷骰，采信 AI 返回值；preset 对 fromAI 的卡**跳过**
 *     1/5 随机闸门（否则会出现「AI 说了无、系统又掷一条」的双重决定）。
 *
 * 运行： node tools/test_v2114_egg_occupation.js   （工作目录 = 仓库根）
 * ============================================================ */
'use strict';
var fs = require('fs'), path = require('path');
var vm = require('vm');

var ROOT = path.join(__dirname, '..');
var JS = path.join(ROOT, 'web', 'js');

/* ---------------- vm 沙箱 ---------------- */
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
    'core/preset', 'core/ai'].forEach(function (f) {
      vm.runInContext(fs.readFileSync(path.join(JS, f + '.js'), 'utf8'), s, { filename: f });
    });
}

var s = makeSandbox();
loadAll(s);
var E = s.CocEasterEgg;
var G = s.PresetGen;
var AI = s.AIGen;

/* ---------------- 断言工具 ---------------- */
var pass = 0, fail = 0, failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  [PASS] ' + label); }
  else {
    fail++; failures.push(label);
    console.log('  [FAIL] ' + label + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra)));
  }
}

/* 职业表里真实存在的职业名集合 */
var OCC_NAMES = {};
s.CocOccupation.listAll().forEach(function (o) { OCC_NAMES[o.name] = 1; });
function occExists(name) { return !!OCC_NAMES[String(name)]; }

/* ============================================================
 * 1. 彩蛋数据的 occ 必须是职业表里的**精确**职业名
 * ============================================================ */
console.log('== 1. 彩蛋 occ 均为职业表中的精确职业名 ==');
(function () {
  var bad = [];
  E.celebrities.forEach(function (c) { if (!occExists(c.occ)) bad.push(c.name + ' → ' + c.occ); });
  E.friends.forEach(function (c) { if (!occExists(c.occ)) bad.push(c.name + ' → ' + c.occ); });
  ok(bad.length === 0, '★ 22 位名人 + 8 位跑团成员的 occ 全部精确存在于职业表', bad);
  console.log('  职业表共 ' + Object.keys(OCC_NAMES).length + ' 个职业');
})();

/* ============================================================
 * 2. 真生成：卡上的职业必须等于声明的 occ（连跑 3 轮防随机回退）
 * ============================================================ */
console.log('\n== 2. 生成出的卡，职业精确等于声明值（连跑 3 轮） ==');
(function () {
  var ROUNDS = 3, bad = [], invalid = 0, tot = 0;
  for (var r = 0; r < ROUNDS; r++) {
    E.all().forEach(function (e) {
      tot++;
      var card = G.buildFrom(E.toProfile(e));
      var got = card.basicInfo.occupationName;
      if (got !== e.data.occ) bad.push(e.data.name + '：声明 ' + e.data.occ + ' / 实得 ' + got);
      if (s.Engine.checkList(card).filter(function (x) { return !x.ok; }).length) invalid++;
    });
  }
  console.log('  共生成 ' + tot + ' 张彩蛋卡（' + (tot / 30) + ' 轮 × 30 位）');
  ok(bad.length === 0, '★ 每张彩蛋卡的职业都精确落位（无模糊匹配、无随机回退）', bad.slice(0, 8));
  ok(invalid === 0, '★ 全部通过 Engine.checkList（合规性未回归）', invalid);
})();

/* ============================================================
 * 3. 关键抽查：用户点名的李时珍 = 医生
 * ============================================================ */
console.log('\n== 3. 用户点名抽查 ==');
(function () {
  var want = { '李时珍': '医生', '扁鹊': '医生', '诸葛亮': '军官', '苏轼': '政府官员' };
  Object.keys(want).forEach(function (nm) {
    var src = E.all().filter(function (x) { return x.data.name === nm; })[0];
    ok(!!src && src.data.occ === want[nm], '★ ' + nm + ' 的职业 = ' + want[nm],
      src ? src.data.occ : '找不到该彩蛋');
    if (src) {
      var card = G.buildFrom(E.toProfile(src));
      ok(card.basicInfo.occupationName === want[nm],
        '★ ' + nm + ' 生成出的卡职业 = ' + want[nm], card.basicInfo.occupationName);
    }
  });
})();

/* ============================================================
 * 3b. 跑团成员：真实职业 + 籍贯宿州（阿肆=六安）+ 住所随机（阿肆固定宿州）
 * ============================================================ */
console.log('\n== 3b. 跑团成员职业 / 籍贯 / 住所 ==');
(function () {
  /* 真实职业 → app 职业表精确名（表里没有「教练/银行职员/画师」等叫法，取最接近的） */
  var REAL_OCC = {
    '茶叶蛋': '政府官员',                  // 公务员
    '秦九': '白领工人-中高层管理人员',        // 奶茶总部运营
    '北北': '艺术家',                      // 画师
    '小张': '运动员（网球）',               // 羽毛球教练（表中最接近的持拍类）
    '乌龟': '设计师',                      // 设计院职工
    '阿肆': '小企业家',                    // 保安公司运营
    '年年': '白领工人-职员、主管',           // 银行职员
    'R.B': '政府官员'                       // 公务员
  };
  var REAL_TOWN = { '阿肆': '六安' };       // 其余一律宿州
  E.friends.forEach(function (f) {
    ok(occExists(f.occ), '★ ' + f.name + ' 的职业「' + f.occ + '」在职业表中精确存在');
    ok(f.occ === REAL_OCC[f.name], '★ ' + f.name + ' 职业对应真实职业（' + REAL_OCC[f.name] + '）', f.occ);
    /* 连跑多次：职业必须恒定、籍贯必须恒定、住所必须随机（阿肆除外） */
    var towns = {}, occs = {}, cities = {};
    for (var i = 0; i < 12; i++) {
      var c = G.buildFrom(E.toProfile({ kind: 'friend', data: f }));
      towns[c.basicInfo.birthplace] = 1;
      occs[c.basicInfo.occupationName] = 1;
      cities[c.basicInfo.residence] = 1;
      if (s.Engine.checkList(c).filter(function (x) { return !x.ok; }).length) {
        ok(false, '★ ' + f.name + ' 生成的卡通过 Engine.checkList');
      }
    }
    var wantTown = REAL_TOWN[f.name] || '宿州';
    ok(Object.keys(towns).length === 1 && towns[wantTown],
      '★ ' + f.name + ' 籍贯恒为「' + wantTown + '」', Object.keys(towns));
    ok(Object.keys(occs).length === 1 && occs[f.occ],
      '★ ' + f.name + ' 职业恒定落位（无随机回退）', Object.keys(occs));
    if (f.name === '阿肆') {
      ok(Object.keys(cities).length === 1 && cities['宿州'],
        '★ 阿肆住所固定为宿州', Object.keys(cities));
    } else {
      ok(Object.keys(cities).length > 1,
        '★ ' + f.name + ' 住所随机（' + Object.keys(cities).length + ' 种不同城市）',
        Object.keys(cities).slice(0, 5));
    }
  });
})();

/* ============================================================
 * 4. AI 车卡：疯狂症状由 AI 决定（不再由系统代掷，也不吃 1/5 闸门）
 * ============================================================ */
console.log('\n== 4. AI 车卡疯狂症状归属 ==');
(function () {
  /* 4.1 toProfile 采信 AI 的返回值（含「无。」） */
  var withSym = AI.toProfile({ background: { phobias: '【恐惧症】恐高：站在高处就头晕。' } });
  ok(withSym && withSym.background && withSym.background.phobias === '【恐惧症】恐高：站在高处就头晕。',
    '★ AI 给了症状文本 → 原样采信（AI 决定权）',
    withSym && withSym.background && withSym.background.phobias);
  var withNone = AI.toProfile({ background: { phobias: '无。' } });
  ok(withNone && withNone.background && withNone.background.phobias === '无。',
    '★ AI 写「无。」→ 采信为「没有」', withNone && withNone.background && withNone.background.phobias);

  /* 4.2 决定性证据：把随机源钳成「必定命中 1/5」，AI 卡仍必须**没有**症状
         （证明 preset 对 fromAI 跳过了随机闸门 —— 不是概率巧合） */
  var orig = Math.random;
  function withRandom(v, fn) {
    Math.random = function () { return v; };
    try { return fn(); } finally { Math.random = orig; }
  }
  var aiCard = withRandom(0.0, function () {
    /* fromAI + 无 phobias：AI 没给 → 按 AI 的决定（没有），**不掷闸门** */
    return G.buildFrom({ fromAI: true, background: null });
  });
  ok(!(aiCard.background.phobias && aiCard.background.phobias.indexOf('【') === 0),
    '★ 随机源钳成必定命中时，AI 卡仍无疯狂症状（fromAI 跳过 1/5 闸门）',
    aiCard.background.phobias);
  var aiCard2 = withRandom(0.0, function () {
    return G.buildFrom({ fromAI: true, background: { phobias: '无。' } });
  });
  ok(aiCard2.background.phobias === '无。',
    '★ AI 明确写「无。」→ 卡上就是「无。」（不被系统覆盖）', aiCard2.background.phobias);

  /* 4.3 对照组：非 AI 的随机卡在同样钳定下**必须**有症状（闸门对随机卡仍生效） */
  var randCard = withRandom(0.0, function () {
    return G.buildFrom({});
  });
  ok(randCard.background.phobias && randCard.background.phobias.indexOf('【') === 0,
    '★ 对照组：同一随机源下，普通随机卡仍有症状（1/5 闸门未误伤随机卡）',
    randCard.background.phobias);
})();

/* ============================================================
 * 5. 回归护栏：提示词确实在让 AI 自己判断
 * ============================================================ */
console.log('\n== 5. AI 提示词护栏 ==');
(function () {
  var src = fs.readFileSync(path.join(JS, 'core/ai.js'), 'utf8');
  ok(/phobias.*根据这个人物的性格与经历/.test(src) || /根据这个人物的性格与经历/.test(src),
    '★ 提示词要求 AI 依据人物描述判断有无背景疯狂症状');
  ok(src.indexOf('背景疯狂症状由系统按疯狂表掷骰决定，你不要自行编造') < 0,
    '★ 旧的「写无。+ 不要自行编造」指令已移除');
  /* toProfile 里不得再有无条件代掷 */
  ok(!/bg\.phobias\s*=\s*global\.CocMadness\.backgroundText\(\)/.test(src),
    '★ toProfile 不再无条件代替系统掷骰');
})();

/* ---------------- 汇总 ---------------- */
console.log('\n' + '='.repeat(58));
if (fail) { console.log('失败项：'); failures.forEach(function (f) { console.log('  [FAIL] ' + f); }); }
console.log('test_v2114_egg_occupation: ' + pass + ' passed, ' + fail + ' failed');
console.log('RESULT: ' + (fail ? 'FAIL' : 'PASS'));
process.exitCode = fail ? 1 : 0;
