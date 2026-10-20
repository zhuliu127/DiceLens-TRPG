/* ============================================================
 * test_v2100_fixes.js —— v2.10.0「身体状态四态 + dying/unconscious 标记」独立回归
 *
 * ⚠️ 分工说明（本文件由多名工程师按小节 append 汇总，勿重写别人的小节）：
 *   · 本小节（第 1 节）由 software-engineer-3（寇豆码）负责：**单机车卡 App + 状态落库**
 *     —— store.js（新卡默认值 + 老卡迁移 + bodyForHp 判据）、
 *        app.js（身体状态复选 chips 编辑器 + commit 键列表）、
 *        sheet.js（bodyView 合成显示）、
 *        room-store.js（applyToTempCard 透传）。
 *   · 其他工程师的小节在本文件**末尾 append**；为避免「汇总早于追加的断言执行」，
 *     本文件汇总 / RESULT 走 process.on('exit')，任何后追加的代码都会先跑完再汇总。
 *
 * 覆盖点：
 *   A. store.js#normalize：老卡 body='濒死' → '重伤'+dying；body='昏迷' → unconscious+按 HP 归位；
 *      幂等（跑两遍不漂移）；newCharacter 默认带 dying:false/unconscious:false；
 *      bodyForHp 判据（满血→正常 / 半血→重伤 / 低血→轻伤 / maxHP 未知→轻伤）。
 *   B. app.js：身体状态编辑器为复选形态；正常/轻伤互斥且受伤时禁用；
 *      重伤/濒死/昏迷可叠加、已勾选不可自行取消；昏迷/濒死整行置灰仅死亡可点；
 *      点濒死自动勾重伤；commit 键列表含 dying/unconscious。
 *      （编辑器逻辑是模块级纯函数，测试**抽源 eval 真实代码**，不是复刻副本。）
 *   C. sheet.js：显示走 bodyView 合成（死亡 > dying > unconscious > body），叠加态列全。
 *   D. room-store.js#applyToTempCard：dying / unconscious 透传进临时卡；
 *      补丁缺键时不写 undefined（不污染已有值）。
 *
 * 运行： node tools/test_v2100_fixes.js（工作目录 = 仓库根）
 * 成功时最后一行打印 RESULT: PASS
 * ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');

var pass = 0, fail = 0, failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else {
    fail++;
    failures.push(label + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)));
    console.log('  ✗ ' + label + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)));
  }
}
function eq(a, b, name) { ok(a === b, name, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
function seq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name, 'got=' + JSON.stringify(a)); }
function section(t) { console.log('\n== ' + t + ' =='); }

/* ------------------------------------------------------------
 * 载入被测源码（与 test_status_madness.js 同款：global.window = global）
 * ------------------------------------------------------------ */
global.window = global;

/* localStorage 内存实现（store / room-store 都走它） */
function makeLS() {
  var m = {}, keys = [];
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem: function (k, v) { if (!Object.prototype.hasOwnProperty.call(m, k)) keys.push(k); m[k] = String(v); },
    removeItem: function (k) {
      if (Object.prototype.hasOwnProperty.call(m, k)) {
        delete m[k];
        keys = keys.filter(function (x) { return x !== k; });
      }
    },
    key: function (i) { return keys[i] === undefined ? null : keys[i]; },
    clear: function () { m = {}; keys = []; },
    get length() { return keys.length; }
  };
}
global.localStorage = makeLS();

/* 依赖顺序：症状数据 → 症状服务 → 规则枚举 → 引擎 → 存储 */
function load(rel) { eval(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
load('web/js/data/madness.js');
load('web/js/core/madness.js');
load('web/js/core/rules-coc7.js');
load('web/js/core/engine.js');
load('web/js/core/store.js');

var Store = global.Store;

/* ------------------------------------------------------------
 * 工具：从源码里按「函数名锚定」抽取真实函数段并 eval 成可调用的函数
 * （行号会漂，一切以函数名为锚；抽的是生产代码本体，不是测试复刻副本）
 * ------------------------------------------------------------ */
function extractBlock(src, startNeedle, endNeedle) {
  var i = src.indexOf(startNeedle);
  if (i < 0) throw new Error('extractBlock: start not found: ' + startNeedle);
  var j = src.indexOf(endNeedle, i);
  if (j < 0) throw new Error('extractBlock: end not found: ' + endNeedle);
  return src.slice(i, j);
}
function makeFns(block, names) {
  var src = block + '\nreturn {' + names.map(function (n) { return n + ': ' + n; }).join(', ') + '};';
  /* eslint-disable no-new-func */
  return (new Function(src))();
}

var appSrc = fs.readFileSync(path.join(ROOT, 'web/js/app.js'), 'utf8');
var sheetSrc = fs.readFileSync(path.join(ROOT, 'web/js/ui/sheet.js'), 'utf8');
var storeSrc = fs.readFileSync(path.join(ROOT, 'web/js/core/store.js'), 'utf8');
var roomStoreSrc = fs.readFileSync(path.join(ROOT, 'web/js/core/room-store.js'), 'utf8');

/* ============================================================
 * 第 1 节 · software-engineer-3（寇豆码）—— T03 单机车卡 App + 状态落库
 * ============================================================ */

/* ------------------------------------------------------------
 * A. store.js：新卡默认值 + 老卡迁移 + bodyForHp 判据
 * ------------------------------------------------------------ */
section('A. store.js#normalize 身体状态迁移（v2.10.0）');

/* A1. 新卡默认值：dying / unconscious 必须显式为 false */
(function () {
  var c = Store.newCharacter('coc7');
  eq(c.status.body, '正常', 'newCharacter 默认 body=正常');
  eq(c.status.dying, false, '★ newCharacter 默认 dying=false');
  eq(c.status.unconscious, false, '★ newCharacter 默认 unconscious=false');
})();

/* A2. 老卡 body='濒死' → body='重伤' + dying=true */
(function () {
  var c = Store.normalize({
    id: 'legacy-dying', characterName: '老卡', basicInfo: { age: 30 },
    status: { currentHP: 6, maxHP: 24, body: '濒死', mental: '正常' },
    background: {}, madness: []
  });
  eq(c.status.body, '重伤', "老卡 body='濒死' → body='重伤'");
  eq(c.status.dying, true, "老卡 body='濒死' → dying=true");
  eq(c.status.unconscious, false, "老卡 body='濒死' → unconscious 保持 false");
  /* 撕卡判据不变：濒死不撕卡 */
  eq(c.status.body === '死亡', false, '濒死迁移后不是「死亡」（撕卡判据仍只认死亡）');
})();

/* A3. 老卡 body='昏迷' → unconscious=true，body 按 HP 归位 */
(function () {
  function legacy(hp, maxHP) {
    return Store.normalize({
      id: 'legacy-unc', characterName: '老卡', basicInfo: { age: 30 },
      status: { currentHP: hp, maxHP: maxHP, body: '昏迷', mental: '正常' },
      background: {}, madness: []
    });
  }
  var full = legacy(24, 24);
  eq(full.status.body, '正常', "body='昏迷' 满血 → 归位「正常」");
  eq(full.status.unconscious, true, "body='昏迷' → unconscious=true");
  eq(full.status.dying, false, "body='昏迷' → dying 保持 false");

  var half = legacy(12, 24);
  eq(half.status.body, '重伤', "body='昏迷' 半血 → 归位「重伤」");
  eq(half.status.unconscious, true, "body='昏迷' 半血 → unconscious=true");

  var low = legacy(5, 24);
  eq(low.status.body, '轻伤', "body='昏迷' 低血 → 归位「轻伤」");
  eq(low.status.unconscious, true, "body='昏迷' 低血 → unconscious=true");

  var noHp = legacy(0, 0);
  eq(noHp.status.body, '轻伤', "body='昏迷' 且 maxHP 未知 → 兜底「轻伤」");
  eq(noHp.status.unconscious, true, "body='昏迷' 且 maxHP 未知 → unconscious=true");
})();

/* A4. 幂等：迁移跑两遍不漂移 */
(function () {
  var c = {
    id: 'legacy-idem', characterName: '老卡', basicInfo: { age: 30 },
    status: { currentHP: 6, maxHP: 24, body: '濒死', mental: '正常' },
    background: {}, madness: []
  };
  Store.normalize(c);
  var after1 = JSON.stringify(c);
  Store.normalize(c);
  var after2 = JSON.stringify(c);
  eq(after1, after2, '★ 迁移幂等：normalize 跑两遍结果逐字一致（不漂移）');
  eq(c.status.body, '重伤', '第二遍后 body 仍是「重伤」');
  eq(c.status.dying, true, '第二遍后 dying 仍为 true');

  var c2 = {
    id: 'legacy-idem2', characterName: '老卡', basicInfo: { age: 30 },
    status: { currentHP: 12, maxHP: 24, body: '昏迷', mental: '正常' },
    background: {}, madness: []
  };
  Store.normalize(c2);
  var b1 = JSON.stringify(c2);
  Store.normalize(c2);
  eq(b1, JSON.stringify(c2), '★ 昏迷迁移同样幂等（跑两遍不漂移）');
})();

/* A5. 新模型卡（body='重伤' + dying）过 normalize 不被误伤 */
(function () {
  var c = Store.normalize({
    id: 'new-model', characterName: '新卡', basicInfo: { age: 30 },
    status: { currentHP: 6, maxHP: 24, body: '重伤', dying: true, unconscious: true, mental: '正常' },
    background: {}, madness: []
  });
  eq(c.status.body, '重伤', "新模型卡 body='重伤' 原样保留");
  eq(c.status.dying, true, '新模型卡 dying=true 原样保留');
  eq(c.status.unconscious, true, '新模型卡 unconscious=true 原样保留');
})();

/* A6. 死亡卡不被迁移碰坏（撕卡终态） */
(function () {
  var c = Store.normalize({
    id: 'dead', characterName: '死者', basicInfo: { age: 30 },
    status: { currentHP: 0, maxHP: 24, body: '死亡', mental: '正常' },
    background: {}, madness: []
  });
  eq(c.status.body, '死亡', "body='死亡' 不被迁移改动");
  eq(c.status.dying, false, "body='死亡' 不补 dying");
})();

/* A7. 精神状态迁移不受影响（test_status_madness.js 的同款断言在这里兜一道） */
(function () {
  var c = Store.normalize({
    id: 'mental', characterName: '疯卡', basicInfo: { age: 30 },
    status: { body: '正常', mental: '临时疯狂' }, background: {}, madness: []
  });
  seq(c.status.mental, ['临时疯狂'], "mental 单选字符串 → 多选数组（迁移未碰坏）");
  var c2 = Store.normalize({
    id: 'mental2', characterName: '疯卡', basicInfo: { age: 30 },
    status: { body: '正常' }, background: {}, madness: []
  });
  seq(c2.status.mental, ['正常'], 'mental 缺字段 → [\'正常\']（迁移未碰坏）');
})();

/* A8. bodyForHp 判据（抽源 eval 真实函数，与房间侧判据一字不差） */
(function () {
  var F = makeFns(extractBlock(storeSrc, '  function bodyForHp(hp, maxHP) {', '  /** 修复/补全旧数据结构 */'), ['bodyForHp']);
  eq(F.bodyForHp(24, 24), '正常', 'bodyForHp：满血 → 正常');
  eq(F.bodyForHp(25, 24), '正常', 'bodyForHp：超过满血 → 正常');
  eq(F.bodyForHp(12, 24), '重伤', 'bodyForHp：恰好一半 → 重伤');
  eq(F.bodyForHp(13, 24), '重伤', 'bodyForHp：过半 → 重伤');
  eq(F.bodyForHp(11, 24), '轻伤', 'bodyForHp：不足一半 → 轻伤');
  eq(F.bodyForHp(0, 24), '轻伤', 'bodyForHp：0 血 → 轻伤');
  eq(F.bodyForHp(5, 0), '轻伤', 'bodyForHp：maxHP 未知 → 轻伤');
  eq(F.bodyForHp('', ''), '轻伤', 'bodyForHp：空值不炸 → 轻伤');
})();

/* ------------------------------------------------------------
 * B. app.js：身体状态复选 chips 编辑器（抽源 eval 真实纯函数）
 * ------------------------------------------------------------
 * app.js 是 DOM IIFE，整体没法在 Node 里跑；但编辑器逻辑是模块级纯函数
 * （bodyWounded / bodyLocked / bodyChipDisabled / bodyChipNext），
 * 这里按函数名锚定抽源、eval 真实代码执行，而不是在测试里复刻一份。 */
section('B. app.js 身体状态编辑器（复选 chips）');

var BODY_FNS = makeFns(extractBlock(appSrc, '  function bodyWounded(st) {', '  function statusSheet(c, onDone) {'),
  ['bodyWounded', 'bodyLocked', 'bodyChipDisabled', 'bodyChipNext']);

(function () {
  function fresh() { return { body: '正常', dying: false, unconscious: false }; }
  var ALL = ['正常', '轻伤', '重伤', '濒死', '昏迷', '死亡'];

  /* B1. 健康态：没有禁用项 */
  var s0 = fresh();
  eq(ALL.filter(function (o) { return BODY_FNS.bodyChipDisabled(s0, o); }).length, 0,
    '健康态（正常）下六个 chip 全部可点');

  /* B2. 正常/轻伤 单选互斥（点轻伤 → body=轻伤；再点正常 → body=正常） */
  var s1 = fresh();
  BODY_FNS.bodyChipNext(s1, '轻伤');
  eq(s1.body, '轻伤', '点「轻伤」→ body=轻伤');
  BODY_FNS.bodyChipNext(s1, '正常');
  eq(s1.body, '正常', '再点「正常」→ body=正常（互斥）');

  /* B3. 重伤/濒死/昏迷 可叠加 */
  var s2 = fresh();
  BODY_FNS.bodyChipNext(s2, '重伤');
  eq(s2.body, '重伤', '点「重伤」→ body=重伤');
  BODY_FNS.bodyChipNext(s2, '昏迷');
  eq(s2.unconscious, true, '再点「昏迷」→ unconscious=true（与重伤叠加）');
  BODY_FNS.bodyChipNext(s2, '濒死');
  eq(s2.dying, true, '再点「濒死」→ dying=true（与重伤+昏迷叠加）');
  eq(s2.body, '重伤', '叠加后 body 仍为「重伤」（濒死/昏迷是标记不是 body 值）');

  /* B4. 点「濒死」时若未勾「重伤」→ 自动勾上 */
  var s3 = fresh();
  BODY_FNS.bodyChipNext(s3, '濒死');
  eq(s3.dying, true, '从健康态直接点「濒死」→ dying=true');
  eq(s3.body, '重伤', '★ 点「濒死」自动勾上「重伤」');

  /* B5. 禁用矩阵：受伤组里 正常/轻伤 禁用 */
  var s4 = fresh();
  BODY_FNS.bodyChipNext(s4, '重伤');
  eq(BODY_FNS.bodyChipDisabled(s4, '正常'), true, '★ 重伤时「正常」禁用');
  eq(BODY_FNS.bodyChipDisabled(s4, '轻伤'), true, '★ 重伤时「轻伤」禁用');
  eq(BODY_FNS.bodyChipDisabled(s4, '重伤'), true, '★ 已勾选的「重伤」不可取消（自身禁用）');
  eq(BODY_FNS.bodyChipDisabled(s4, '濒死'), false, '重伤时「濒死」可点（复选可叠加）');
  eq(BODY_FNS.bodyChipDisabled(s4, '昏迷'), false, '重伤时「昏迷」可点（复选可叠加）');
  eq(BODY_FNS.bodyChipDisabled(s4, '死亡'), false, '任何状态下「死亡」都可点（两段式确认兜底）');

  /* B6. 昏迷/濒死时整行置灰，仅「死亡」可点 */
  var s5 = fresh();
  BODY_FNS.bodyChipNext(s5, '昏迷');
  ['正常', '轻伤', '重伤', '濒死', '昏迷'].forEach(function (o) {
    eq(BODY_FNS.bodyChipDisabled(s5, o), true, '★ 昏迷时「' + o + '」置灰（整行仅死亡可点）');
  });
  eq(BODY_FNS.bodyChipDisabled(s5, '死亡'), false, '昏迷时「死亡」仍可点');
  var s6 = fresh();
  BODY_FNS.bodyChipNext(s6, '濒死');
  ['正常', '轻伤', '重伤', '昏迷'].forEach(function (o) {
    eq(BODY_FNS.bodyChipDisabled(s6, o), true, '★ 濒死时「' + o + '」置灰');
  });
  eq(BODY_FNS.bodyChipDisabled(s6, '死亡'), false, '濒死时「死亡」仍可点');

  /* B7. 已勾选的重伤/濒死/昏迷不可自行取消（toast 说明） */
  var s7 = fresh();
  BODY_FNS.bodyChipNext(s7, '重伤');
  var r1 = BODY_FNS.bodyChipNext(s7, '重伤');
  ok(/不能自行取消/.test(r1.toast), '★ 再点已勾选的「重伤」→ toast「不能自行取消…」', r1.toast);
  ok(/治愈伤势或队友 \/ KP 施救/.test(r1.toast), 'toast 说明解除途径（治愈伤势或队友 / KP 施救）', r1.toast);
  eq(s7.body, '重伤', '取消被拒后 body 不变');

  var s8 = fresh();
  BODY_FNS.bodyChipNext(s8, '濒死');
  var r2 = BODY_FNS.bodyChipNext(s8, '濒死');
  ok(/不能自行取消/.test(r2.toast), '再点已勾选的「濒死」→ toast 拒绝', r2.toast);
  eq(s8.dying, true, '取消被拒后 dying 不变');

  var s9 = fresh();
  BODY_FNS.bodyChipNext(s9, '昏迷');
  var r3 = BODY_FNS.bodyChipNext(s9, '昏迷');
  ok(/不能自行取消/.test(r3.toast), '再点已勾选的「昏迷」→ toast 拒绝', r3.toast);
  eq(s9.unconscious, true, '取消被拒后 unconscious 不变');

  /* B8. 受伤组里改回 正常/轻伤 被拒（模型层兜底，UI 层还有禁用矩阵） */
  var s10 = fresh();
  BODY_FNS.bodyChipNext(s10, '重伤');
  var r4 = BODY_FNS.bodyChipNext(s10, '正常');
  ok(/不能改回/.test(r4.toast), '★ 重伤时改回「正常」被拒并 toast 说明', r4.toast);
  eq(s10.body, '重伤', '被拒后 body 不变');
  var r5 = BODY_FNS.bodyChipNext(s10, '轻伤');
  ok(/不能改回/.test(r5.toast), '重伤时改回「轻伤」同样被拒', r5.toast);

  /* B9. 健康态点 正常/轻伤 会清掉标记（防御性，正常路径下标记本就为 false） */
  var s11 = { body: '正常', dying: false, unconscious: false };
  BODY_FNS.bodyChipNext(s11, '正常');
  eq(s11.dying, false, '点「正常」后 dying=false');
  eq(s11.unconscious, false, '点「正常」后 unconscious=false');

  /* B10. 死亡是终态：任何身体状态 chip 都不再受理 */
  var s12 = { body: '死亡', dying: false, unconscious: false };
  var r6 = BODY_FNS.bodyChipNext(s12, '重伤');
  ok(/撕卡/.test(r6.toast), '★ 死亡后再点身体状态 chip → 拒绝（撕卡终态）', r6.toast);
  eq(s12.body, '死亡', '死亡终态不被改写');

  /* B11. 静态证据链：编辑器形态 / commit 键列表 / 死代码已清 */
  var bodySeg = extractBlock(appSrc, '    function bodySelect() {', '    /* 精神状态：**多选** —— 规则允许叠加。');
  ok(appSrc.indexOf('function statusSelect(') < 0, '★ 旧单选 statusSelect 已随改造移除（无死代码）');
  ok(bodySeg.indexOf("['正常', '轻伤', '重伤', '濒死', '昏迷', '死亡']") >= 0,
    'bodySelect 的 chips = 正常/轻伤/重伤/濒死/昏迷/死亡 六项');
  ok(bodySeg.indexOf('bodyChipDisabled(st, o)') >= 0, 'bodySelect 里套用禁用矩阵 bodyChipDisabled');
  ok(bodySeg.indexOf('bodyChipNext(st, o)') >= 0, 'bodySelect 里走纯迁移 bodyChipNext');
  ok(bodySeg.indexOf('⚠ 确认死亡？') >= 0, '「死亡」保留行内两段式确认（⚠ 确认死亡？）');
  ok(appSrc.indexOf("'body', 'dying', 'unconscious',") >= 0,
    '★ commit 的键列表含 dying / unconscious（保存状态时落库）');
  ok(/var opts = \['正常', '轻伤', '重伤', '濒死', '昏迷', '死亡'\];/.test(appSrc),
    'app.js 全文可定位 bodySelect 的 opts（函数名/唯一文本锚定，不依赖行号）');
})();

/* ------------------------------------------------------------
 * C. sheet.js：bodyView 合成显示（抽源 eval 真实纯函数）
 * ------------------------------------------------------------ */
section('C. sheet.js 身体状态显示合成');

var SHEET_FNS = makeFns(extractBlock(sheetSrc, '  function bodyViewOf(c) {', '  /** 本职技能是不是'),
  ['bodyViewOf', 'bodyDetailOf']);

(function () {
  /* C1. 视图优先级：死亡 > dying > unconscious > body */
  eq(SHEET_FNS.bodyViewOf({ status: { body: '正常', dying: false, unconscious: false } }), '正常', '健康态视图=正常');
  eq(SHEET_FNS.bodyViewOf({ status: { body: '轻伤', dying: false, unconscious: false } }), '轻伤', '轻伤视图=轻伤');
  eq(SHEET_FNS.bodyViewOf({ status: { body: '重伤', dying: false, unconscious: false } }), '重伤', '重伤视图=重伤');
  eq(SHEET_FNS.bodyViewOf({ status: { body: '重伤', dying: true, unconscious: false } }), '濒死', '重伤+濒死 → 视图=濒死');
  eq(SHEET_FNS.bodyViewOf({ status: { body: '重伤', dying: false, unconscious: true } }), '昏迷', '重伤+昏迷 → 视图=昏迷');
  eq(SHEET_FNS.bodyViewOf({ status: { body: '重伤', dying: true, unconscious: true } }), '濒死',
    '★ 重伤+濒死+昏迷 → 视图=濒死（dying 优先于 unconscious）');
  eq(SHEET_FNS.bodyViewOf({ status: { body: '死亡', dying: true, unconscious: true } }), '死亡',
    '★ 死亡优先级最高（盖过濒死/昏迷）');
  eq(SHEET_FNS.bodyViewOf({ status: {} }), '正常', 'status 缺字段 → 兜底「正常」');
  eq(SHEET_FNS.bodyViewOf(null), '正常', '卡对象为 null 也不炸 → 「正常」');

  /* C2. 叠加态列全 */
  eq(SHEET_FNS.bodyDetailOf({ status: { body: '重伤', dying: true, unconscious: true } }), '重伤 · 濒死 · 昏迷',
    '★ 叠加态列全：「重伤 · 濒死 · 昏迷」');
  eq(SHEET_FNS.bodyDetailOf({ status: { body: '正常', dying: false, unconscious: false } }), '正常', '健康态详情=正常');
  eq(SHEET_FNS.bodyDetailOf({ status: { body: '轻伤', dying: false, unconscious: false } }), '轻伤', '轻伤详情=轻伤');
  eq(SHEET_FNS.bodyDetailOf({ status: { body: '死亡' } }), '死亡', '死亡详情=死亡');
  eq(SHEET_FNS.bodyDetailOf({ status: { body: '重伤', dying: true, unconscious: false } }), '重伤 · 濒死', '重伤+濒死详情');

  /* C3. 静态：render 走合成，不再直接读 c.status.body */
  ok(sheetSrc.indexOf("text: '身体状态：' + bodyViewOf(c)") >= 0,
    '★ 状态行走 bodyViewOf(c) 合成');
  ok(sheetSrc.indexOf("叠加态：' + bodyDetailOf(c)") >= 0,
    '★ 叠加态行走 bodyDetailOf(c)（列全同时存在的状态）');
  ok(sheetSrc.indexOf("c.status.body || '正常'") < 0,
    '★ 旧的直接读 c.status.body 的写法已不存在');
})();

/* ------------------------------------------------------------
 * D. room-store.js#applyToTempCard：dying / unconscious 透传
 * ------------------------------------------------------------ */
section('D. room-store.js#applyToTempCard 透传');

(function () {
  /* room-store 的 Store 假实现（临时卡的源卡 / 生效落点）。
     ⚠️ 用完还原 global.Store —— 本文件后追加的小节可能还要用真 Store。 */
  var realStore = global.Store;
  var CHARS = {
    'c-1': { id: 'c-1', characterName: '甲', status: { currentHP: 6, maxHP: 24, body: '重伤' } }
  };
  global.Store = {
    getState: function () { return { characters: CHARS }; },
    upsertCharacter: function () { return true; }
  };
  eval(roomStoreSrc);
  var RS = global.RoomStore;

  /* D1. 建临时卡 + 透传两键 */
  RS.ensureTempCard('r2100', 'seat-1', 'c-1');
  var patch = { status: { currentHP: 6, maxHP: 24, body: '重伤', dying: true, unconscious: true } };
  eq(RS.applyToTempCard('r2100', 'c-1', patch), true, 'applyToTempCard 返回 true（写盘成功）');
  var card = RS.getTempCard('r2100', 'c-1').card;
  eq(card.status.dying, true, '★ patch.status.dying 透传进临时卡');
  eq(card.status.unconscious, true, '★ patch.status.unconscious 透传进临时卡');
  eq(card.status.body, '重伤', 'body 仍按原样透传（重伤）');

  /* D2. 补丁缺键时不写 undefined / null（不污染临时卡已有值） */
  eq(RS.applyToTempCard('r2100', 'c-1', { status: { body: '轻伤' } }), true, '第二次补丁（只含 body）写盘成功');
  var card2 = RS.getTempCard('r2100', 'c-1').card;
  eq(card2.status.dying, true, '补丁没有 dying 键 → 临时卡保留原值 true（不被 undefined 覆盖）');
  eq(card2.status.unconscious, true, '补丁没有 unconscious 键 → 临时卡保留原值 true');
  eq(card2.status.body, '轻伤', 'body 仍按补丁更新');

  /* D3. 显式 null 也不写（与 body 的既有口径一致） */
  eq(RS.applyToTempCard('r2100', 'c-1', { status: { dying: null, unconscious: null } }), true, 'null 值补丁写盘成功');
  var card3 = RS.getTempCard('r2100', 'c-1').card;
  eq(card3.status.dying, true, '补丁 dying=null → 不覆盖（保留 true）');
  eq(card3.status.unconscious, true, '补丁 unconscious=null → 不覆盖（保留 true）');

  /* D4. 键名与权威端逐字一致（静态证据链：room-model.js#applyStateToCard 同款写法）。
     ⚠️ 权威端（room-model.js）由另一位工程师并发修改（T01）：已落地 → 真断言；
        未落地 → 只打说明不算失败（避免拿别人中途态卡自己）。 */
  var modelSrc = fs.readFileSync(path.join(ROOT, 'web/js/core/room-model.js'), 'utf8');
  var authLanded = /card\.status\.dying = st\.dying;/.test(modelSrc) &&
                   /card\.status\.unconscious = st\.unconscious;/.test(modelSrc);
  if (authLanded) {
    ok(/if \(st\.dying !== undefined && st\.dying !== null\) card\.status\.dying = st\.dying;/.test(modelSrc),
      '★ 权威端 room-model.js#applyStateToCard 也写 card.status.dying（键名逐字一致）');
    ok(/if \(st\.unconscious !== undefined && st\.unconscious !== null\) card\.status\.unconscious = st\.unconscious;/.test(modelSrc),
      '★ 权威端 room-model.js#applyStateToCard 也写 card.status.unconscious（键名逐字一致）');
  } else {
    console.log('  · 权威端 room-model.js 的 dying/unconscious 落库尚未落地（等 T01），本条跳过');
  }
  global.Store = realStore;
})();

/* ============================================================
 * 第 2 节 · software-engineer-2（寇豆码）—— T02 房间 UI（R1 + R2a/R2b + R3）
 *   文件：web/js/ui/room-panels.js（疯狂 10 类 + 身体状态复选 chips + 点选即时生效）
 *         web/js/ui/room-ui.js（sheetSummary / reportSheet 透传 dying/unconscious）
 *         web/css/app.css（R3 竖屏「队友信息」折叠标题置顶）
 * ============================================================ */
var rpSrc = fs.readFileSync(path.join(ROOT, 'web/js/ui/room-panels.js'), 'utf8');
var ruiSrc = fs.readFileSync(path.join(ROOT, 'web/js/ui/room-ui.js'), 'utf8');
var cssSrc = fs.readFileSync(path.join(ROOT, 'web/css/app.css'), 'utf8');
function uiStrip(text) { return text.replace(/\/\*[\s\S]*?\*\//g, ''); }
/* 按函数名切段（剥注释后；行号会漂，一切以函数名为锚），避免跨函数误命中 */
function uiSeg(src, name) {
  var i = src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  var rest = src.slice(i + 1);
  var m = /\r?\n  function /.exec(rest);
  return rest.slice(0, m ? m.index : rest.length);
}
var rpClean = uiStrip(rpSrc);
var ssSeg = uiSeg(rpClean, 'selfStateSheet');

/* ------------------------------------------------------------
 * E0. 本地 bodyView 合成（抽源 eval 真实代码 —— 与模型侧同语义，不跨模块依赖）
 * ------------------------------------------------------------ */
section('E0. room-panels.js 本地 bodyViewOf 合成（死亡 > dying > unconscious > body）');

var BV_FNS = makeFns(extractBlock(rpSrc, '  function bodyViewOf(st) {',
  '  /** v2.6.0（用户第 5 项）：不能做 SAN 相关动作'), ['bodyViewOf', 'isMemberWounded', 'isMemberUnconscious']);

(function () {
  eq(BV_FNS.bodyViewOf({ body: '正常', dying: false, unconscious: false }), '正常', '健康态视图=正常');
  eq(BV_FNS.bodyViewOf({ body: '轻伤', dying: false, unconscious: false }), '轻伤', '轻伤视图=轻伤');
  eq(BV_FNS.bodyViewOf({ body: '重伤', dying: false, unconscious: false }), '重伤', '重伤视图=重伤');
  eq(BV_FNS.bodyViewOf({ body: '重伤', dying: true, unconscious: false }), '濒死', '重伤+dying → 视图=濒死');
  eq(BV_FNS.bodyViewOf({ body: '轻伤', dying: false, unconscious: true }), '昏迷', '轻伤+unconscious → 视图=昏迷');
  eq(BV_FNS.bodyViewOf({ body: '重伤', dying: true, unconscious: true }), '濒死',
    '★ dying 优先于 unconscious（重伤+濒死+昏迷 → 濒死）');
  eq(BV_FNS.bodyViewOf({ body: '死亡', dying: true, unconscious: true }), '死亡',
    '★ 死亡优先级最高（盖过濒死/昏迷）');
  eq(BV_FNS.bodyViewOf({}), '正常', '空对象 → 兜底「正常」');
  eq(BV_FNS.bodyViewOf(null), '正常', 'null 也不炸 → 「正常」');
  eq(BV_FNS.bodyViewOf({ body: '昏迷' }), '昏迷', '旧数据 body=昏迷 兼容退化（视图仍=昏迷）');
  /* 两个谓词改按视图合成判（否则「标记置起但 body 仍是正常」会被误判为无需治愈） */
  ok(/function isMemberWounded\(m\) \{\s*return WOUND_BODY\.indexOf\(bodyViewOf/.test(rpClean),
    '★ isMemberWounded 改按 bodyViewOf 视图合成判（dying/unconscious 标记算受重伤组）');
  ok(/function isMemberUnconscious\(m\) \{[\s\S]*?v === '昏迷' \|\| v === '濒死';/.test(rpClean),
    '★ isMemberUnconscious 判据与模型全局锁对称：昏迷**或濒死**都算行动受限（用户裁定①）');
  /* 行为级（抽源 eval 真实代码）：与模型 intent 锁（_isUnconscious || _isDying）对齐 */
  eq(BV_FNS.isMemberUnconscious({ sheet: { status: { body: '重伤', unconscious: true } } }), true, '昏迷态 → 行动受限');
  eq(BV_FNS.isMemberUnconscious({ sheet: { status: { body: '重伤', dying: true } } }), true,
    '★ 濒死态 → 行动受限（与模型全局锁对称，前端同款提示）');
  eq(BV_FNS.isMemberUnconscious({ sheet: { status: { body: '重伤' } } }), false, '纯重伤（未昏迷/濒死）→ 不受限');
  eq(BV_FNS.isMemberUnconscious({ sheet: { status: { body: '轻伤' } } }), false, '轻伤 → 不受限');
  eq(BV_FNS.isMemberWounded({ sheet: { status: { body: '重伤', dying: true } } }), true,
    '★ 濒死仍算受重伤组（isMemberWounded 视图合成）→ 治愈伤势自救出口可走');
  eq(BV_FNS.isMemberWounded({ sheet: { status: { body: '正常', unconscious: true } } }), true,
    '★ 昏迷标记（body 仍正常）也算受重伤组 → 自救出口可走');
  /* 前置提示口径：昏迷原文保留（v2.8.0 不回归）+ 新增濒死同款 */
  var scSeg = uiSeg(rpClean, 'sanCheckSheet');
  ok(scSeg.indexOf('你正处于昏迷，无法行动') >= 0, '昏迷态 SAN Check 前端 toast 保留（v2.8.0 口径不回归）');
  ok(scSeg.indexOf('你正处于濒死，无法行动') >= 0, '★ 新增濒死态 SAN Check 前端 toast（同款文案）');
  /* 自救出口不被该锁挡：治愈伤势按钮前置校验走 isMemberWounded（实时权威态） */
  ok(ssSeg.indexOf("op: 'sheet.healwound'") >= 0 && /if \(!isMemberWounded\(meNow\)\)/.test(ssSeg),
    '★ 治愈伤势按钮仍走 isMemberWounded 前置校验 → 昏迷/濒死玩家的自救出口不被锁挡');
})();

/* ------------------------------------------------------------
 * E1. R1：疯狂「追加一条」类型下拉 2 → 10 项（bout:1…8 + phobia + mania）
 * ------------------------------------------------------------ */
section('E1. R1 疯狂类型下拉 10 项与三态分流（数据同源 CocMadness.boutTable）');

(function () {
  /* 数据源同源：不另建表，直接消费 CocMadness.boutTable()（= 即时症状表 10 条） */
  var rows = global.CocMadness.boutTable();
  eq(rows.length, 10, 'boutTable() 返回即时症状表 10 条（UI 消费的同一数据源）');
  ok(rows.slice(0, 8).every(function (r) { return r && r.no >= 1 && r.no <= 8 && !!r.name; }),
    'no 1-8 均带症状名（bout:N 下拉 label 的数据来源）');

  /* 选项构造：bout:1…bout:8（label=症状名）+ phobia + mania = 10 项 */
  ok(/filter\(function \(r\) \{ return r && r\.no >= 1 && r\.no <= 8; \}\)/.test(rpClean),
    '即时症状表只取 no 1-8（第 9/10 项即 phobia/mania 两个 100 条选项，不上重复项）');
  ok(/map\(function \(r\) \{ return \{ value: 'bout:' \+ r\.no, label: r\.name \}; \}\)/.test(rpClean),
    'bout 项 value=bout:N、label=症状名');
  ok(/MAD_TYPE_OPTS\.push\(\{ value: 'phobia', label: '恐惧症' \}\);/.test(rpClean) &&
     /MAD_TYPE_OPTS\.push\(\{ value: 'mania', label: '躁狂' \}\);/.test(rpClean),
    '★ 追加 phobia / mania 两项（合计 10 项类型）');
  ok(/var typeSel = selectCtl\(MAD_TYPE_OPTS, 'phobia', null\);/.test(rpClean),
    '类型下拉默认仍是 phobia（默认态行为不变）');

  /* fillNames 三态分流 */
  ok(/if \(tv === 'mania'\) list = \(MAD && MAD\.manias && MAD\.manias\(\)\) \|\| \[\];/.test(rpClean),
    'mania → MAD.manias()（100 条）');
  ok(/else if \(tv === 'phobia'\) list = \(MAD && MAD\.phobias && MAD\.phobias\(\)\) \|\| \[\];/.test(rpClean),
    'phobia → MAD.phobias()（100 条）');
  ok(/function boutRowOf\(tv\) \{[\s\S]*?tv\.indexOf\('bout:'\) !== 0/.test(rpClean),
    'bout 前缀走 boutRowOf 分流（indexOf bout: 前缀判据）');
  ok(/if \(row\) \{ single = row; list = \[row\]; \}/.test(rpClean),
    '★ bout:N → 仅 1 项（该症状自身，自动选中）');
  ok(/if \(single\) \{[\s\S]*?inner\.appendChild\(el\('option', \{ value: single\.name,/.test(rpClean),
    'bout 单项直接渲染为唯一 option（自动选中）');

  /* v2.1.8 修过的 bug 不复发：phobia/mania 首项空选项「（不添加疯狂）」必须保留 */
  ok(rpClean.indexOf("text: '（不添加疯狂）'") >= 0,
    '★ 默认空选项「（不添加疯狂）」仍在（不选=不添加，不会「改 HP 就进疯狂」）');

  /* 提交处 type 透传，不再是硬编码二选一 */
  ok(/type: String\(selVal\(typeSel\)\)\.split\(':'\)\[0\],/.test(ssSeg),
    '★ 提交处 type 透传：bout:N → bout / phobia / mania（MAD_TYPES 白名单零改）');
  ok(ssSeg.indexOf("=== 'mania' ? 'mania' : 'phobia'") < 0,
    '★ 旧的硬编码二选一（mania/phobia）已移除');

  /* 「🎲 随机抽一个」按所选类型直抽（不改 1D10 表） */
  var iRand = rpClean.indexOf("text: '🎲 随机抽一个'");
  var randSeg = iRand >= 0 ? rpClean.slice(iRand, rpClean.indexOf("'抽到：'", iRand)) : '';
  ok(iRand >= 0, '定位「🎲 随机抽一个」按钮');
  ok(randSeg.indexOf('if (row) list = [row];') >= 0,
    '★ 随机抽取按类型分流：bout 单项恒中');
  ok(randSeg.indexOf("tv === 'mania'") >= 0 && randSeg.indexOf("tv === 'phobia'") >= 0,
    'phobia/mania 仍从各自 100 条表随机（toast 报结果）');
})();

/* ------------------------------------------------------------
 * E2. R2a/R2b：身体状态复选 chips + 点选即时生效 + 禁用矩阵
 * ------------------------------------------------------------ */
section('E2. R2a/R2b 身体状态复选 chips（立即生效 + 禁用矩阵）');

(function () {
  /* 形态：复选 chips（与精神状态多选同形态），BODY_OPTS 六态保持 */
  ok(/BODY_OPTS = \['正常', '轻伤', '重伤', '濒死', '昏迷', '死亡'\]/.test(ssSeg),
    'BODY_OPTS 六态保持（正常/轻伤/重伤/濒死/昏迷/死亡）');
  ok(/var b = el\('button\.chip' \+ \(bodyChecked\(o\) \? '\.on' : ''\)/.test(ssSeg),
    '★ chips 按 bodyChecked 实时勾选（复选形态，不再是单选 bodyVal === o）');
  ok(ssSeg.indexOf("'data-v': o,") >= 0, 'chip 带 data-v（与精神状态 chip 组同形态）');
  ok(/function bodyChecked\(o\) \{/.test(ssSeg) && /function paintBody\(\) \{/.test(ssSeg),
    '勾选态判定 bodyChecked + 整行重画 paintBody（点选后禁用矩阵随之变）');

  /* 正常/轻伤 单选互斥（点一个自动取消另一个 + 清两个标记） */
  ok(/if \(o === '正常' \|\| o === '轻伤'\) \{[\s\S]*?bodyVal = o; dyingVal = false; uncVal = false;/.test(ssSeg),
    '★ 正常/轻伤 单选互斥（本体归位 + dying/unconscious 清零）');

  /* 重伤/濒死/昏迷 可叠加 */
  ok(/\} else if \(o === '重伤'\) \{\s*bodyVal = '重伤';/.test(ssSeg),
    '点「重伤」→ 只写 body=重伤（不清其他态，可叠加）');
  ok(/\} else if \(o === '昏迷'\) \{\s*uncVal = true;/.test(ssSeg),
    '★ 点「昏迷」→ 只置 unconscious 标记（与重伤叠加，不清其他态）');
  ok(/sendBodyStatus\(\{ body: '重伤', dying: true \}, bodyText\(\)\);/.test(ssSeg),
    '★ 点「濒死」→ body=重伤 + dying=true（叠加加重）');
  ok(/if \(bodyVal !== '重伤'\) \{[\s\S]*?global\.UI\.toast\('濒死必然伴随重伤/.test(ssSeg),
    '★ 点「濒死」时未勾「重伤」→ 自动勾上 + toast 说明（规则因果链）');

  /* 禁用矩阵（Q5） */
  ok(/var bodyVal0 = bodyViewOf\(\{ body: bodyVal, dying: dyingVal, unconscious: uncVal \}\);/.test(ssSeg),
    '禁用矩阵按**当前**视图合成值判（bodyVal0 实时重算，非过期快照）');
  ok(/var globalLocked = \(bodyVal0 === '濒死' \|\| bodyVal0 === '昏迷'\);/.test(ssSeg),
    '昏迷/濒死 → 全局锁判据');
  ok(/var curBodyLocked = WOUND_BODY\.indexOf\(bodyVal0\) >= 0;/.test(ssSeg),
    '受重伤组判据（重伤/濒死/昏迷）');
  ok(/var locked = curBodyLocked && \(o !== '死亡'\);/.test(ssSeg),
    '受重伤组内除「死亡」外先置灰');
  ok(/if \(locked && !globalLocked && WOUND_BODY\.indexOf\(o\) >= 0 && !bodyChecked\(o\)\) locked = false;/.test(ssSeg),
    '★ 未勾选的重伤/濒死/昏迷 放行（叠加加重，模型侧放行）');
  ok(/style: locked \? \{ opacity: '0\.45', cursor: 'not-allowed'/.test(ssSeg),
    '置灰走内联样式 + .dim（零 CSS 回归；刻意不用原生 disabled —— 置灰项点击要弹引导 toast）');
  ok(/if \(locked\) \{[\s\S]*?return;/.test(ssSeg), 'onclick 内置灰兜底拦截（双保险）');
  ok(ssSeg.indexOf('不能自行取消该状态') >= 0 &&
     ssSeg.indexOf('🩹 治愈伤势（需 KP 同意）') >= 0 &&
     ssSeg.indexOf('或请 KP / 队友施救') >= 0,
    '★ 取消被拒 toast：「不能自行取消该状态 —— 请用「🩹 治愈伤势（需 KP 同意）」或请 KP / 队友施救」');
  ok(ssSeg.indexOf('角色昏迷/濒死中，无法自行操作身体状态；可申请治愈伤势或请队友施救') >= 0,
    '★ 全局锁 toast：「角色昏迷/濒死中，无法自行操作身体状态；可申请治愈伤势或请队友施救」');

  /* 点选立即发 op（不等保存） */
  ok(/function sendBodyStatus\(patch, note\) \{[\s\S]*?ctx\.intent\(M\.INTENT\.ACT, \{\s*op: 'state\.self', status: patch,\s*reason: '自行设置身体状态：' \+ note/.test(ssSeg),
    '★ 每次点选立即发 ctx.intent(ACT, {op:state.self, status, reason})（免 KP 同意）');
  ok(ssSeg.indexOf("global.UI.toast('已将身体状态设为：' + note, 'ok');") >= 0,
    '成功 toast「已将身体状态设为：X」（bodyView + 标记合成文案）');
  ok(ssSeg.indexOf("dying: true") >= 0 && ssSeg.indexOf("unconscious: true") >= 0,
    '★ payload 带 status.dying / status.unconscious（与 body 一并透传）');
  ok(ssSeg.indexOf("{ body: '死亡' }") >= 0 || ssSeg.indexOf("sendBodyStatus({ body: '死亡' }, '死亡');") >= 0,
    '「死亡」chip 保留撕卡二次确认 + 发 body=死亡');

  /* 「保存修改」彻底剥离 body/标记（Q3） */
  ok(ssSeg.indexOf('status.body = bodyVal') < 0,
    '★ 批量保存不再提交 status.body（约 3286 的传递已删）');
  ok(ssSeg.indexOf('changedBody') < 0,
    '★ changedBody 判据已删（约 3315）—— bodyVal0 快照过期问题从架构上消除');
  ok(rpSrc.indexOf('v2.10.0（R2a/Q3）') >= 0,
    'Q3 剥离处带 v2.10.0 注释锚');
  /* 批量保存仍带 HP/MP/SAN/mental/madness/tempStatus（不误伤） */
  ok(/take\(hpI, 'currentHP'\); take\(hpMaxI, 'maxHP'\);/.test(ssSeg) &&
     ssSeg.indexOf("payload.madness = {") >= 0 && ssSeg.indexOf('payload.tempStatus = ts;') >= 0,
    '批量保存仍带 HP/MP/SAN/madness/tempStatus（只剥离 body/标记）');
})();

/* ------------------------------------------------------------
 * E3. R3：app.css 竖屏「队友信息」高度纪律（只挂 :not(.gp-grid)）
 * ------------------------------------------------------------ */
section('E3. R3 app.css 竖屏队友信息折叠标题置顶');

(function () {
  var R1 = '.game-page:not(.gp-grid) .gp-region-pl-mates { display: flex; flex-direction: column; max-height: 46vh; }';
  var R2 = '.game-page:not(.gp-grid) .gp-region-pl-mates > *:not(.gp-region-fold) { flex: 1 1 auto; min-height: 0; overflow-y: auto; }';
  ok(cssSrc.indexOf(R1) >= 0, '★ R3 规则①存在（flex 列 + max-height:46vh）');
  ok(cssSrc.indexOf(R2) >= 0, '★ R3 规则②存在（非折叠标题子节点 flex:1 + 内部滚动）');
  ok(cssSrc.indexOf('v2.10.0（R3）') >= 0, 'R3 注释锚存在');

  /* 新增规则只挂 :not(.gp-grid) 前缀；两条规则文本里出现的 .gp-grid 只能是 :not() 否定
     （用剥注释后的 css 判，避免注释文案里提到的 .gp-grid 干扰） */
  var cssCode = uiStrip(cssSrc);
  var iR1 = cssCode.indexOf(R1), iR2 = cssCode.indexOf(R2, iR1);
  ok(iR1 >= 0 && iR2 > iR1, 'R3 两条规则可定位（剥注释后）');
  var ruleBlk = iR1 >= 0 ? cssCode.slice(iR1, iR2 + R2.length) : '';
  var badGrid = ruleBlk.split('.gp-grid').slice(1).some(function (part) {
    return part.trim().slice(0, 1) !== ')';   /* .gp-grid 后必须紧跟 :not( 的右括号 */
  });
  ok(ruleBlk.indexOf(':not(.gp-grid)') >= 0 && !badGrid,
    '★ 新规则只挂 :not(.gp-grid) 前缀（两条规则内无任何正向 .gp-grid 选择器）');
  ok(!/@media/.test(ruleBlk), 'R3 新增块不含 @media（不新增媒体查询承载结构）');

  /* 横屏网格零回归：受影响区域的既有 .gp-grid 规则原样在 */
  ok(cssSrc.indexOf('.game-page.gp-grid .gp-pl-row1 .gp-region-pl-mates') >= 0,
    '★ 既有网格态 mates 规则未被删改（.gp-grid 零回归）');
  ok(cssSrc.indexOf('.game-page.gp-grid .gp-fold-portrait') >= 0,
    '★ 既有「横屏隐藏折叠标题」规则未被删改');
  ok(cssSrc.indexOf('.game-page:not(.gp-grid) .gp-region-fold,') >= 0,
    '★ 竖屏折叠标题 flex:0 0 auto 仍在（标题置顶的前提）');

  /* 花括号配平 */
  var o = (cssSrc.match(/{/g) || []).length, c = (cssSrc.match(/}/g) || []).length;
  eq(o, c, 'app.css 花括号配平');
  ok((cssSrc.match(/\.gp-grid/g) || []).length > 0, 'app.css 既有 .gp-grid 规则仍在（未被清空）');
})();

/* ------------------------------------------------------------
 * E4. room-ui.js 两处透传（sheetSummary 上报 + reportSheet 权威端优先回填）
 * ------------------------------------------------------------ */
section('E4. room-ui.js 透传 dying / unconscious');

(function () {
  var sumSeg = uiSeg(uiStrip(ruiSrc), 'sheetSummary');
  ok(sumSeg.length > 0, '定位到 sheetSummary');
  ok(/dying: !!st\.dying,/.test(sumSeg) && /unconscious: !!st\.unconscious/.test(sumSeg),
    '★ sheetSummary 的 status 块补 dying/unconscious（重连补报/换卡上报不丢标记）');
  ok(/body: st\.body \|\| '正常'/.test(sumSeg), 'body 上报口径不变');

  var repSeg = uiSeg(uiStrip(ruiSrc), 'reportSheet');
  ok(repSeg.length > 0, '定位到 reportSheet');
  ok(/if \(mst\.dying != null\) sum\.status\.dying = !!mst\.dying;/.test(repSeg) &&
     /if \(mst\.unconscious != null\) sum\.status\.unconscious = !!mst\.unconscious;/.test(repSeg),
    '★ reportSheet 权威端优先回填 dying/unconscious（重连不被本机旧值覆盖）');
  ok(/if \(mst\.body != null\) sum\.status\.body = mst\.body;/.test(repSeg),
    'body 权威端优先回填的口径不变（两标记同款）');
})();

/* ------------------------------------------------------------
 * E5. 语法守卫：两个改动文件均可解析
 * ------------------------------------------------------------ */
section('E5. 语法守卫');

(function () {
  var vm = require('vm');
  ['web/js/ui/room-panels.js', 'web/js/ui/room-ui.js'].forEach(function (rel) {
    var parsed = true, err = '';
    try { new vm.Script(fs.readFileSync(path.join(ROOT, rel), 'utf8'), { filename: rel }); }
    catch (e) { parsed = false; err = e.message; }
    ok(parsed, rel + ' vm.Script 编译通过（语法正确）', err);
  });
})();

/* ------------------------------------------------------------
 * 收尾（process.on('exit')：后追加的小节也会先跑完再汇总）
 * ------------------------------------------------------------ */
process.on('exit', function () {
  console.log('\n----------------------------------------');
  if (fail) {
    console.log('失败用例：');
    failures.forEach(function (f) { console.log('  ✗ ' + f); });
  }
  console.log('PASS ' + pass + ' / ' + (pass + fail));
  console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS');
  process.exitCode = fail ? 1 : 0;
});

/* ============================================================
 * 第 3 节 · software-qa-engineer（严过关）—— T04 QA 独立行为验证
 * ============================================================
 * 与第 1 / 第 2 节的分工：那两节是工程师**各自模块**的回归；
 * 本小节是 QA 的**独立验收** —— 不复用他们的 fixture 思路，
 * 全部用全新的构造，真跑权威端 Host（intent → plan → deliver）
 * 证明 v2.10.0 六项需求的行为真的成立：
 *   F. R1 疯狂表同源（数据行为 + 提交落库）
 *   G. R2a「立即生效 + reason 留痕」
 *   H. R2b「不可自行取消」（重伤自发降级 / 濒死昏迷自发取消 / KP 放行 / 治愈施救不受影响）
 *   I. R5 老卡迁移（sanitizeStatus 出口 + adoptSave 出口 + 幂等 + 三态并存）
 *   J. R4 私密事件归属（host 不混入 KP 栏 / KP 定向仍进 / 玩家照常收到）
 *   K. R6 即死阈值一致（damageFlags 与 deriveBodyFromHp 都是 >）
 * ============================================================ */
load('web/js/core/room-rules.js');
load('web/js/core/room-model.js');

var QA4 = global.RoomModel;
var qa4Rules = global.CocRules;

/* ---- 迷你中继 + Host 工厂（与 test_room_model.js 同语义的内存版） ---- */
function qa4Fixed(v) { return function () { return v; }; }
function Qa4Relay() { this.clients = {}; this.log = []; }
Qa4Relay.prototype.add = function (c) { this.clients[c.seat] = c; };
Qa4Relay.prototype.mark = function () { return this.log.length; };
Qa4Relay.prototype.deliver = function (plan) {
  var got = {};
  (plan || []).forEach(function (step) {
    var text = JSON.stringify(step.msg);
    this.log.push({ to: step.to, text: text });
    if (step.to === '*') {
      for (var seat in this.clients) {
        got[seat] = got[seat] || [];
        got[seat].push(this.clients[seat].receive(text));
      }
    } else if (this.clients[step.to]) {
      got[step.to] = got[step.to] || [];
      got[step.to].push(this.clients[step.to].receive(text));
    }
  }, this);
  return got;
};
Qa4Relay.prototype.since = function (mark, seat) {
  return this.log.slice(mark)
    .filter(function (m) { return m.to === '*' || m.to === seat; })
    .map(function (m) { return m.text; });
};
function qa4NewHost(opts) {
  return new QA4.Host(Object.assign({
    meta: { code: 'qa04', name: 'QA验收团', kpName: 'KP老张', maxPlayers: 4 },
    now: qa4Fixed(1700000000000)
  }, opts || {}));
}
function qa4AddPlayer(host, relay, seat, nickname) {
  var res = host.attachPeer({ seat: seat, cid: 'c-' + seat, role: QA4.ROLE.PLAYER, nickname: nickname, at: 1 });
  relay.add(new QA4.Client({ seat: seat, role: QA4.ROLE.PLAYER, meta: host.state.meta }));
  relay.deliver(res.out);
  return res.member;
}
/** 绑卡（INTENT.CHAR 真实路径：sheet 过 sanitizeSheet 白名单 + 迁移） */
function qa4Bind(host, relay, seat, sheet) {
  relay.deliver(host.intent(seat, QA4.intentMsg(QA4.INTENT.CHAR,
    { id: 'c-' + seat, name: sheet.name || '调查员', sheet: sheet })));
}
function qa4Act(host, relay, seat, p) {
  return relay.deliver(host.intent(seat, QA4.intentMsg(QA4.INTENT.ACT, p)));
}
/** 取某 seat 在游标后收到的 PRIVATE 事件文本（拼接） */
function qa4Priv(relay, mark, seat) {
  return relay.since(mark, seat).filter(function (t) { return /"t":"private"/.test(t); }).join('');
}
/** 取某 seat 在游标后收到的公开 LOG（kind:'state'）文本（拼接） */
function qa4StateLog(relay, mark, seat) {
  return relay.since(mark, seat).filter(function (t) {
    return /"t":"log"/.test(t) && /"kind":"state"/.test(t);
  }).join('');
}

/* ------------------------------------------------------------
 * F. R1：疯狂「10 类同源」—— 数据行为 + 提交落库
 * ------------------------------------------------------------ */
section('F. R1 疯狂表 10 类同源（CocMadness.boutTable 行为级）');

(function () {
  /* F1. 即时症状表就是下拉的数据源：10 条，1-8 具名，9/10 链 100 表 */
  var rows = global.CocMadness.boutTable();
  eq(rows.length, 10, 'boutTable() = 即时症状表 10 条（R1 下拉消费的同一数据源）');
  ok(rows.slice(0, 8).every(function (r) { return r && r.no >= 1 && r.no <= 8 && !!r.name && !r.link; }),
    'no 1-8 均带症状名且无 link（bout 直选项）');
  ok(rows[8] && rows[8].link === 'phobia' && rows[9] && rows[9].link === 'mania',
    'no 9/10 分别链 phobia / mania 两个 100 条表');

  /* F2. 选项构造推演：只取 no 1-8（8 项）+ phobia/mania（2 项）= 10 项，
         与 UI 的 filter(no 1-8) + push×2 构造逐条对应（全新构造，不读 UI 变量）。 */
  var opts = rows.filter(function (r) { return r && r.no >= 1 && r.no <= 8; })
    .map(function (r) { return { value: 'bout:' + r.no, label: r.name }; });
  opts.push({ value: 'phobia', label: '恐惧症' });
  opts.push({ value: 'mania', label: '躁狂' });
  eq(opts.length, 10, '选项构造推演 = 8 bout + phobia + mania = 10 项');
  eq(opts[0].value, 'bout:1', '首项 value=bout:1');
  eq(opts[0].label, '失忆', '首项 label=症状名（no 1）');
  eq(opts[7].label, '歇斯底里', '第 8 项 label=症状名（no 8，即时症状表）');
  eq(opts[8].value, 'phobia', '第 9 项 = phobia');
  eq(opts[9].value, 'mania', '第 10 项 = mania');

  /* F3. v2.1.8 修过的 bug 不复发：默认空选项「（不添加疯狂）」仍在
     （独立重新读源码验证，不依赖第 2 节的变量）。 */
  var qaRp = fs.readFileSync(path.join(ROOT, 'web/js/ui/room-panels.js'), 'utf8');
  ok(qaRp.indexOf("text: '（不添加疯狂）'") >= 0,
    '★ 默认空选项「（不添加疯狂）」仍在（不选=不添加，不会「改 HP 就进疯狂」）');

  /* F3b. 排序纪律（v2.1.8 根因守卫的真正落点）：空选项必须**无条件 append 在最前**，
         且在 bout 单项分支之前 —— 只有它是第一个 option，`inner.value` 才默认取 ''，
         翻类型 / 打开面板都不会误带症状（否则就是「改 HP 就进疯狂」复发）。
         主理人裁定：bout:N 虽是单项，同样遵守该纪律（安全 > 便捷）。 */
  var qaRpClean = qaRp.replace(/\/\*[\s\S]*?\*\//g, '');
  var iEmpty = qaRpClean.indexOf("inner.appendChild(el('option', { value: '', text: '（不添加疯狂）' }));");
  var iSingle = iEmpty >= 0 ? qaRpClean.indexOf('if (single) {', iEmpty) : -1;
  ok(iEmpty >= 0 && iSingle > iEmpty,
    '★ 空选项 appendChild 位于 bout 单项分支之前（所有类型都以「（不添加疯狂）」为默认）');
  ok(/主理人裁定：安全 > 便捷/.test(qaRp),
    '★ bout:N 同样遵守空选项纪律（主理人裁定已落盘，注释在案）');

  /* F4. bout:9 / bout:10 走 phobia / mania 100 表（rollTable 分流，注入 rng 锁定） */
  var r1 = global.CocMadness.rollTable(function () { return 0.0; });   /* no=1 */
  eq(r1.kind, 'bout', 'rollTable no=1 → bout');
  eq(r1.src.name, '失忆', 'rollTable no=1 → 具名症状「失忆」');
  var r9 = global.CocMadness.rollTable(function () { return 0.85; });  /* no=9 */
  eq(r9.kind, 'phobia', 'rollTable no=9 → phobia（100 表）');
  ok(!!r9.src.name, 'rollTable no=9 抽到具名恐惧症：' + r9.src.name);
  var r10 = global.CocMadness.rollTable(function () { return 0.95; }); /* no=10 */
  eq(r10.kind, 'mania', 'rollTable no=10 → mania（100 表）');
  ok(!!r10.src.name, 'rollTable no=10 抽到具名躁狂症：' + r10.src.name);
  eq(global.CocMadness.phobias().length, 100, '恐惧症表 100 条');
  eq(global.CocMadness.manias().length, 100, '躁狂症表 100 条');

  /* F5. 提交落库：madness 条目 type ∈ {bout,phobia,mania}、name=具名条目、permanent:false
     （真跑 state.self，走权威端 MAD_TYPES 白名单）。 */
  var host = qa4NewHost(), relay = new Qa4Relay();
  qa4AddPlayer(host, relay, 's-a', '小明');
  qa4Bind(host, relay, 's-a', { name: '小明', status: { currentHP: 24, maxHP: 24, body: '正常' } });
  qa4Act(host, relay, 's-a', { op: 'state.self', madness: { type: 'bout', name: '失忆', rounds: 5 } });
  var md = host.roster.get('s-a').sheet.madness;
  eq(md.length, 1, '提交 bout 症状后 madness 有 1 条');
  eq(md[0].type, 'bout', '★ type=bout（三态之一，白名单收口）');
  eq(md[0].name, '失忆', 'name = 具名条目');
  eq(md[0].permanent, false, 'permanent:false（即时症状不永久）');
  qa4Act(host, relay, 's-a', { op: 'state.self', madness: { type: 'mania', name: '手术狂', permanent: true } });
  var md2 = host.roster.get('s-a').sheet.madness;
  eq(md2.length, 2, '再提交 mania 后共 2 条');
  eq(md2[1].type, 'mania', '第二条 type=mania');
  eq(md2[1].permanent, true, '显式 permanent:true 保留（背景永久症状）');
  /* 非法 type 归一（白名单不破） */
  qa4Act(host, relay, 's-a', { op: 'state.self', madness: { type: 'nonsense', name: '伪造' } });
  eq(host.roster.get('s-a').sheet.madness[2].type, 'phobia', '非法 type 归一到 phobia（白名单不被撑破）');
})();

/* ------------------------------------------------------------
 * G. R2a：身体状态点选**立即生效**（不等 KP）+ reason 留痕
 * ------------------------------------------------------------ */
section('G. R2a 立即生效 + reason 公开日志');

(function () {
  var host = qa4NewHost(), relay = new Qa4Relay();
  qa4AddPlayer(host, relay, 's-a', '小明');
  qa4AddPlayer(host, relay, 's-b', '小红');
  qa4Bind(host, relay, 's-a', { name: '小明', status: { currentHP: 24, maxHP: 24, body: '正常' } });

  /* G1. 玩家自带 reason（UI「点选身体状态」文案）→ 公开日志出现该原因 */
  var mark = relay.mark();
  qa4Act(host, relay, 's-a', {
    op: 'state.self', status: { body: '重伤' }, reason: '自行设置身体状态：重伤'
  });
  eq(host.roster.get('s-a').sheet.status.body, '重伤',
    '★ 玩家点选即时生效（无需 KP 同意，当场写进权威态）');
  var stateLog = qa4StateLog(relay, mark, 's-a');
  ok(/状态变化（自行设置身体状态：重伤）/.test(stateLog),
    '★ 公开「状态变化」日志带上 payload.reason（KP 复盘看得到为什么改）');
  ok(relay.since(mark, 's-b').some(function (t) { return /自行设置身体状态：重伤/.test(t); }),
    '该日志是公开的（其他玩家也看得到）');

  /* G2. 缺省 reason → 沿用旧文案（不刷空日志）
     ⚠️ 用例隔离：G1 已把 s-a 置成「重伤」，若接着改身体状态会被 R2b 正确拒绝
        （拿不到「状态变化」日志）—— 那是产品代码对，不是缺口。
        所以本条改用**全新 host + 健康角色**发一次纯 HP 变更（不碰 body/标记，
        与 R2b 判据正交），只验证 reason 缺省回落。 */
  var host2 = qa4NewHost(), relay2 = new Qa4Relay();
  qa4AddPlayer(host2, relay2, 's-c', '小刚');
  qa4Bind(host2, relay2, 's-c', { name: '小刚', status: { currentHP: 24, maxHP: 24, body: '正常' } });
  var mark2 = relay2.mark();
  qa4Act(host2, relay2, 's-c', { op: 'state.self', status: { currentHP: 20 } });
  ok(/状态变化（玩家自行修改状态）/.test(qa4StateLog(relay2, mark2, 's-c')),
    '缺省 reason → 回落「（玩家自行）修改状态」旧文案（用例隔离，不被 R2b 拦）');
})();

/* ------------------------------------------------------------
 * H. R2b：受伤状态**不可自行取消**（权威端机械拒绝，不靠客户端自律）
 * ------------------------------------------------------------ */
section('H. R2b 不可自行取消（模型侧拒绝 + KP 放行）');

(function () {
  /* H1. 重伤（清醒）玩家自发 body=正常 → 必须被拒 + 私密提示 */
  var host = qa4NewHost(), relay = new Qa4Relay();
  qa4AddPlayer(host, relay, 's-a', '小明');
  qa4Bind(host, relay, 's-a', { name: '小明', status: { currentHP: 6, maxHP: 24, body: '重伤' } });
  var mark = relay.mark();
  qa4Act(host, relay, 's-a', { op: 'state.self', status: { body: '正常' } });
  eq(host.roster.get('s-a').sheet.status.body, '重伤',
    '★ 重伤玩家自发 body=正常 → 被拒（权威态保持重伤）');
  var priv = qa4Priv(relay, mark, 's-a');
  ok(/不能自行取消|不能改回|无法自行|治愈伤势|施救/.test(priv),
    '★ 重伤玩家被拒时收到私密提示（引导走治愈伤势 / KP / 队友施救）', priv.slice(0, 160));

  /* H2. 重伤（清醒）玩家自发 body=轻伤（自降伤级）→ 同样被拒 */
  mark = relay.mark();
  qa4Act(host, relay, 's-a', { op: 'state.self', status: { body: '轻伤' } });
  eq(host.roster.get('s-a').sheet.status.body, '重伤',
    '★ 重伤玩家自发 body=轻伤 → 同样被拒（自降伤级也是自行取消）');
  ok(/不能自行取消|不能改回|无法自行|治愈伤势|施救/.test(qa4Priv(relay, mark, 's-a')),
    '★ 自降轻伤也被拒并收到私密提示');

  /* H3. 反向通道不误伤：轻伤玩家自发加重到重伤 → 放行（叠加加重，模型侧允许） */
  qa4Bind(host, relay, 's-a', { name: '小明', status: { currentHP: 10, maxHP: 24, body: '轻伤' } });
  qa4Act(host, relay, 's-a', { op: 'state.self', status: { body: '重伤' } });
  eq(host.roster.get('s-a').sheet.status.body, '重伤',
    '轻伤 → 自发加重「重伤」放行（R2b 只锁「取消」，不锁「加重」）');

  /* H4. HP 驱动路径不误伤：重伤回满血 → deriveBodyFromHp 判定归位「正常」（合法治愈） */
  qa4Bind(host, relay, 's-a', { name: '小明', status: { currentHP: 6, maxHP: 24, body: '重伤' } });
  qa4Act(host, relay, 's-a', { op: 'state.self', status: { currentHP: 24 } });
  eq(host.roster.get('s-a').sheet.status.body, '正常',
    '★ 重伤玩家把 HP 改回满血 → HP 驱动判定归位「正常」（R2b 不误伤回血路径）');

  /* H5. 濒死玩家自发 dying=false → 被全局操作锁挡下 + 私密提示 */
  var host2 = qa4NewHost(), relay2 = new Qa4Relay();
  qa4AddPlayer(host2, relay2, 's-a', '小明');
  qa4Bind(host2, relay2, 's-a', {
    name: '小明', status: { currentHP: 0, maxHP: 24, body: '重伤', dying: true }
  });
  var mark2 = relay2.mark();
  qa4Act(host2, relay2, 's-a', { op: 'state.self', status: { dying: false } });
  eq(host2.roster.get('s-a').sheet.status.dying, true,
    '★ 濒死玩家自发 dying=false → 被拒（dying 保持 true）');
  ok(/昏迷\/濒死/.test(qa4Priv(relay2, mark2, 's-a')),
    '★ 被拒时收到私密提示（昏迷/濒死无法操作，引导治愈伤势 / 队友施救）');

  /* H6. 昏迷玩家自发 unconscious=false → 同样被锁 + 私密提示 */
  var host3 = qa4NewHost(), relay3 = new Qa4Relay();
  qa4AddPlayer(host3, relay3, 's-a', '小明');
  qa4Bind(host3, relay3, 's-a', {
    name: '小明', status: { currentHP: 6, maxHP: 24, body: '重伤', unconscious: true }
  });
  var mark3 = relay3.mark();
  qa4Act(host3, relay3, 's-a', { op: 'state.self', status: { unconscious: false } });
  eq(host3.roster.get('s-a').sheet.status.unconscious, true,
    '★ 昏迷玩家自发 unconscious=false → 被拒（unconscious 保持 true）');
  ok(/昏迷\/濒死/.test(qa4Priv(relay3, mark3, 's-a')),
    '★ 昏迷取消被拒并收到私密提示');

  /* H7. KP（bySeat===HOST_SEAT）发同样内容 → 放行（R2b 只管玩家自助） */
  mark = relay.mark();
  qa4Act(host, relay, 'host', {
    op: 'state.self', seat: 's-a', status: { body: '正常' }
  });
  eq(host.roster.get('s-a').sheet.status.body, '正常',
    '★ KP 对重伤玩家发 body=正常 → 放行（KP 裁定通道不受 R2b 限制）');
  ok(/状态变化（KP修改状态）/.test(qa4StateLog(relay, mark, 's-a')),
    'KP 操作同样留公开日志（缺省 reason 回落 KP 文案）');
  /* KP 也能直接解除濒死标记 */
  qa4Bind(host, relay, 's-a', {
    name: '小明', status: { currentHP: 0, maxHP: 24, body: '重伤', dying: true }
  });
  qa4Act(host, relay, 'host', { op: 'state.self', seat: 's-a', status: { dying: false } });
  eq(host.roster.get('s-a').sheet.status.dying, false,
    '★ KP 可直接解除 dying 标记（放行）');
})();

/* ------------------------------------------------------------
 * H2x. R2b ⑤：治愈伤势 / 队友施救路径不受「不可自行取消」影响
 * ------------------------------------------------------------ */
section('H2x. 治愈伤势 / 队友施救路径不受 R2b 影响');

(function () {
  /* 治愈伤势（KP 直接生效）：重伤+濒死+昏迷 → body 归位 + 两标记显式解除 */
  var host = qa4NewHost(), relay = new Qa4Relay();
  qa4AddPlayer(host, relay, 's-a', '小明');
  qa4Bind(host, relay, 's-a', {
    name: '小明', status: { currentHP: 6, maxHP: 24, body: '重伤', dying: true, unconscious: true }
  });
  var mark = relay.mark();
  qa4Act(host, relay, 'host', { op: 'sheet.healwound', seat: 's-a' });
  var st = host.roster.get('s-a').sheet.status;
  eq(st.body, '轻伤', 'healwound：HP 6 < 上限 24 → body=轻伤（刻意不套重伤分支）');
  eq(st.dying, false, '★ healwound 显式解除 dying');
  eq(st.unconscious, false, '★ healwound 显式解除 unconscious');
  ok(relay.since(mark, 's-a').some(function (t) { return /伤势.*已被治愈|已被治愈/.test(t); }),
    'healwound 留公开「伤势已被治愈」日志');

  /* 队友施救（KP 代发，急救 90，rng 锁定 D100=55 → 成功）：
     濒死+昏迷目标 → 稳定为重伤（dying=false），**不碰 unconscious** */
  var host2 = qa4NewHost({ rng: function () { return 0.5; } }), relay2 = new Qa4Relay();
  qa4AddPlayer(host2, relay2, 's-a', '小明');
  qa4AddPlayer(host2, relay2, 's-b', '小红');
  qa4Bind(host2, relay2, 's-a', {
    name: '小明',
    status: { currentHP: 0, maxHP: 24, body: '重伤', dying: true, unconscious: true }, skills: []
  });
  qa4Bind(host2, relay2, 's-b', {
    name: '小红', status: { currentHP: 20, maxHP: 24, body: '正常' },
    skills: [{ name: '急救', total: 90 }]
  });
  qa4Act(host2, relay2, 'host', { op: 'aid.apply', seat: 's-b', targetSeat: 's-a', skill: '急救' });
  var st2 = host2.roster.get('s-a').sheet.status;
  eq(st2.dying, false, '★ aid.apply 稳定濒死 → dying=false');
  eq(st2.body, '重伤', 'aid.apply 稳定濒死 → body=重伤');
  eq(st2.unconscious, true, '★ aid.apply 稳定濒死**不碰 unconscious**（契约口径）');
  eq(st2.currentHP, 1, '急救成功 +1 HP（0 → 1）');

  /* 队友施救唤醒昏迷（仅昏迷、无濒死）：body 按 HP 归位，不碰 dying */
  var host3 = qa4NewHost({ rng: function () { return 0.5; } }), relay3 = new Qa4Relay();
  qa4AddPlayer(host3, relay3, 's-a', '小明');
  qa4AddPlayer(host3, relay3, 's-b', '小红');
  qa4Bind(host3, relay3, 's-a', {
    name: '小明', status: { currentHP: 0, maxHP: 24, body: '轻伤', unconscious: true }, skills: []
  });
  qa4Bind(host3, relay3, 's-b', {
    name: '小红', status: { currentHP: 20, maxHP: 24, body: '正常' },
    skills: [{ name: '急救', total: 90 }]
  });
  qa4Act(host3, relay3, 'host', { op: 'aid.apply', seat: 's-b', targetSeat: 's-a', skill: '急救' });
  var st3 = host3.roster.get('s-a').sheet.status;
  eq(st3.unconscious, false, '★ aid.apply 唤醒昏迷 → unconscious=false');
  eq(st3.body, '轻伤', '唤醒后 body 按 HP 归位（1 < 24 → 轻伤）');
  eq(st3.dying, false, '唤醒昏迷不碰 dying（本就没有）');
})();

/* ------------------------------------------------------------
 * I. R5：老卡迁移 + 三态并存（两个挂载点都生效 + 幂等）
 * ------------------------------------------------------------ */
section('I. R5 老卡迁移与三态并存（sanitizeStatus / adoptSave 双挂载）');

(function () {
  /* I1. sanitizeStatus 出口（经 sanitizeSheet 真实导出 API） */
  function mig(st) { return QA4.sanitizeSheet({ status: st }).status; }
  function brief(st) { return { body: st.body, dying: st.dying, unconscious: st.unconscious }; }
  var d1 = mig({ body: '濒死', currentHP: 6, maxHP: 24 });
  seq(brief(d1), { body: '重伤', dying: true, unconscious: false },
    "★ 老卡 body='濒死' → 迁移为 body='重伤' + dying=true");
  var d2 = mig({ body: '昏迷', currentHP: 24, maxHP: 24 });
  seq(brief(d2), { body: '正常', dying: false, unconscious: true },
    "★ 老卡 body='昏迷'（满血）→ unconscious=true + body 按 HP 归位「正常」");
  seq(brief(mig({ body: '昏迷', currentHP: 12, maxHP: 24 })),
    { body: '重伤', dying: false, unconscious: true }, "昏迷半血 → body=重伤 + unconscious");
  seq(brief(mig({ body: '昏迷', currentHP: 5, maxHP: 24 })),
    { body: '轻伤', dying: false, unconscious: true }, "昏迷低血 → body=轻伤 + unconscious");
  seq(brief(mig({ body: '昏迷', currentHP: 0, maxHP: 0 })),
    { body: '轻伤', dying: false, unconscious: true }, "昏迷且 maxHP 未知 → 兜底轻伤 + unconscious");

  /* I2. 幂等：迁移输出再喂一遍，逐字一致 */
  var once = JSON.stringify(brief(mig({ body: '濒死', currentHP: 6, maxHP: 24 })));
  var twice = JSON.stringify(brief(mig(mig({ body: '濒死', currentHP: 6, maxHP: 24 }))));
  eq(once, twice, '★ 濒死迁移幂等（跑两遍逐字一致）');
  eq(JSON.stringify(brief(mig({ body: '昏迷', currentHP: 12, maxHP: 24 }))),
     JSON.stringify(brief(mig(mig({ body: '昏迷', currentHP: 12, maxHP: 24 })))),
     '★ 昏迷迁移同样幂等');

  /* I3. 新模型卡不被误伤 + 死亡终态不碰 */
  seq(brief(mig({ body: '重伤', dying: true, unconscious: true, currentHP: 6, maxHP: 24 })),
    { body: '重伤', dying: true, unconscious: true }, '新模型三态并存原样保留（迁移不误伤）');
  seq(brief(mig({ body: '死亡', currentHP: 0, maxHP: 24 })),
    { body: '死亡', dying: false, unconscious: false }, "body='死亡' 不被迁移改动");

  /* I4. CHAR 上报挂载点（真实 intent 路径：老卡绑进房间即迁移） */
  var host = qa4NewHost(), relay = new Qa4Relay();
  qa4AddPlayer(host, relay, 's-a', '老卡玩家');
  qa4Bind(host, relay, 's-a', {
    name: '老卡', status: { currentHP: 6, maxHP: 24, body: '濒死', mental: '正常' }
  });
  var mst = host.roster.get('s-a').sheet.status;
  eq(mst.body, '重伤', '★ CHAR 挂载点：老卡「濒死」绑进房间 → body=重伤');
  eq(mst.dying, true, '★ CHAR 挂载点：dying=true');
  qa4Bind(host, relay, 's-a', {
    name: '老卡2', status: { currentHP: 12, maxHP: 24, body: '昏迷', mental: '正常' }
  });
  mst = host.roster.get('s-a').sheet.status;
  eq(mst.unconscious, true, '★ CHAR 挂载点：老卡「昏迷」→ unconscious=true');
  eq(mst.body, '重伤', '★ CHAR 挂载点：昏迷半血 → body=重伤');

  /* I5. adoptSave 挂载点（老存档续玩：直接 clone，不过 sanitize，必须显式迁移） */
  var host2 = qa4NewHost();
  host2.adoptSave({
    meta: { code: 'old01', name: '老团' },
    members: [
      { seat: 's-a', nickname: '濒死老卡', sheet: { status: { body: '濒死', currentHP: 6, maxHP: 24 } } },
      { seat: 's-b', nickname: '昏迷老卡', sheet: { status: { body: '昏迷', currentHP: 12, maxHP: 24 } } }
    ],
    seq: 9
  });
  var a1 = host2.roster.get('s-a').sheet.status;
  eq(a1.body, '重伤', '★ adoptSave 挂载点：濒死老存档 → body=重伤');
  eq(a1.dying, true, '★ adoptSave 挂载点：dying=true');
  var a2 = host2.roster.get('s-b').sheet.status;
  eq(a2.body, '重伤', '★ adoptSave 挂载点：昏迷老存档（半血）→ body=重伤');
  eq(a2.unconscious, true, '★ adoptSave 挂载点：unconscious=true');

  /* I6. 三态并存可表达 + bodyView 合成（死亡 > dying > unconscious > body） */
  eq(QA4.bodyView({ body: '重伤', dying: true, unconscious: true }), '濒死',
    '★ bodyView：重伤+濒死+昏迷 → 濒死（dying 优先于 unconscious）');
  eq(QA4.bodyView({ body: '死亡', dying: true, unconscious: true }), '死亡',
    '★ bodyView：死亡盖过濒死/昏迷');
  eq(QA4.bodyView({ body: '轻伤', dying: false, unconscious: true }), '昏迷',
    'bodyView：轻伤+昏迷 → 昏迷');
  eq(QA4.bodyView({ body: '昏迷' }), '昏迷', "老卡原始 '昏迷' 字符串透传（兼容）");
  eq(QA4.bodyView(null), '正常', 'bodyView(null) 不炸 → 正常');
  var host3 = qa4NewHost(), relay3 = new Qa4Relay();
  qa4AddPlayer(host3, relay3, 's-a', '小明');
  qa4Bind(host3, relay3, 's-a', { name: '小明', status: { currentHP: 6, maxHP: 24, body: '正常' } });
  qa4Act(host3, relay3, 's-a', {
    op: 'state.self', status: { body: '重伤', dying: true, unconscious: true }
  });
  var s3 = host3.roster.get('s-a').sheet.status;
  eq(s3.body, '重伤', '★ state.self 三键同传：body=重伤');
  eq(s3.dying, true, '★ state.self 三键同传：dying=true');
  eq(s3.unconscious, true, '★ state.self 三键同传：unconscious=true（叠加合法）');
  eq(QA4.bodyView(s3), '濒死', '★ 叠加态 bodyView=濒死（模型可表达）');
})();

/* ------------------------------------------------------------
 * J. R4：私密事件归属（KP 栏不混入玩家定向；玩家照常收到）
 * ------------------------------------------------------------ */
section('J. R4 私密事件归属（host 不混入 / KP 定向仍进 / 玩家照常收）');

(function () {
  var host = qa4NewHost(), relay = new Qa4Relay();
  qa4AddPlayer(host, relay, 's-a', '小明');
  var before = host.state.privates.length;

  /* J1. host emit **玩家定向**私密事件 → 不进 host.state.privates */
  var evt1 = host.emit(QA4.EVT.PRIVATE,
    { title: '线索', text: '只有你能看到', at: 1, kind: 'info' }, QA4.VIS.SEAT, 's-a');
  eq(host.state.privates.length, before,
    '★ 玩家定向私密事件不归约进 host.state.privates（不污染 KP 栏）');
  /* 但按收件人累积（重连 /sync 要恢复） */
  ok((host._privateBySeat['s-a'] || []).length === 1,
    '玩家定向私密仍按收件人累积（重连补拉不丢）');

  /* J2. host emit **KP 定向**（暗骰 to=HOST_SEAT）→ 仍进 host.state.privates */
  host.emit(QA4.EVT.PRIVATE,
    { title: '暗骰', text: 'KP 的秘密', at: 2, kind: 'info' }, QA4.VIS.SEAT, 'host');
  eq(host.state.privates.length, before + 1,
    '★ KP 定向私密（暗骰 / 秘密对抗）仍全文进 KP 栏');

  /* J3. client receive（不传 vis）→ 玩家照常收到自己的私密 */
  relay.deliver(host.plan(evt1));
  var cli = relay.clients['s-a'];
  ok(cli.state.privates.some(function (p) { return p.text === '只有你能看到'; }),
    '★ 玩家端照常收到玩家定向私密（R4 守卫不误伤收件人本人）');

  /* J4. 真实路径：越权提醒 _sysTo(玩家) 也不进 KP 栏 */
  before = host.state.privates.length;
  qa4Act(host, relay, 's-a', { op: 'state.self', seat: 's-b', status: { currentHP: 1 } });
  eq(host.state.privates.length, before,
    '★ 真实路径：_sysTo(玩家)（越权提醒）不进 host.state.privates');
  ok(/只能修改自己的状态/.test(qa4Priv(relay, relay.mark() - 2, 's-a')),
    '该私密提示玩家本人收到了');
})();

/* ------------------------------------------------------------
 * K. R6：即死判定阈值一致（damageFlags 与 deriveBodyFromHp 都是 >）
 * ------------------------------------------------------------ */
section('K. R6 即死阈值一致性（恰等于上限不即死）');

(function () {
  /* K1. room-rules.js#damageFlags：amount=maxHP → 不即死（重伤→濒死）；>maxHP → 即死 */
  var dfEq = qa4Rules.damageFlags({ damage: 24, maxHP: 24, currentHP: 24, majorWound: false });
  eq(dfEq.lethal, false, '★ damageFlags：单次伤害恰等于上限（24=24）→ 不即死');
  eq(dfEq.state, 'dying', 'damageFlags 恰等于上限 → HP 归零分流「濒死」（有重大伤口）');
  var dfGt = qa4Rules.damageFlags({ damage: 25, maxHP: 24, currentHP: 24, majorWound: false });
  eq(dfGt.lethal, true, '★ damageFlags：单次伤害超过上限（25>24）→ 即死');
  eq(dfGt.state, 'dead', 'damageFlags 超过上限 → 死亡');

  /* K2. deriveBodyFromHp（抽源 eval 真实函数）：同一阈值 */
  var modelSrc = fs.readFileSync(path.join(ROOT, 'web/js/core/room-model.js'), 'utf8');
  var numBlock = extractBlock(modelSrc, '  function num(v, dflt) {', '  /** 取第一个「已提供」');
  var deriveBlock = extractBlock(modelSrc,
    '  function deriveBodyFromHp(prevBody, amount, after, maxHP) {',
    '  function slotDown(slot) {');
  var DF = makeFns(numBlock + '\n' + deriveBlock, ['deriveBodyFromHp']);
  var jEq = DF.deriveBodyFromHp('正常', 24, 0, 24);
  eq(jEq.body, '重伤', '★ deriveBodyFromHp：amount=maxHP（24）→ 不即死，归重伤');
  eq(jEq.dying, true, 'deriveBodyFromHp：amount=maxHP 且 HP 归零 → dying=true（濒死）');
  var jGt = DF.deriveBodyFromHp('正常', 25, 0, 24);
  eq(jGt.body, '死亡', '★ deriveBodyFromHp：amount>maxHP（25>24）→ 死亡');
  eq(jGt.dying, false, 'deriveBodyFromHp：即死同时清 dying 标记');
  var jHalf = DF.deriveBodyFromHp('正常', 12, 12, 24);
  eq(jHalf.body, '重伤', 'deriveBodyFromHp：半血伤害（12）→ 重伤');
  eq(jHalf.needCon, true, 'deriveBodyFromHp：新受重伤 → 需要 CON 检定（避免昏迷）');

  /* K3. 两处阈值源码级一致（都是严格 >） */
  var rulesSrc = fs.readFileSync(path.join(ROOT, 'web/js/core/room-rules.js'), 'utf8');
  ok(/var lethal = dmg > maxHP;/.test(rulesSrc),
    '★ room-rules.js#damageFlags 即死阈值为 `dmg > maxHP`');
  ok(/if \(maxHP > 0 && amount > maxHP\) \{/.test(modelSrc),
    '★ room-model.js#deriveBodyFromHp 即死阈值为 `amount > maxHP`（两处一致）');

  /* K4. 集成（真跑 state.self）：恰等于上限不即死；同 patch 缩上限造即死 */
  var host = qa4NewHost(), relay = new Qa4Relay();
  qa4AddPlayer(host, relay, 's-a', '小明');
  qa4Bind(host, relay, 's-a', { name: '小明', status: { currentHP: 24, maxHP: 24, body: '正常' } });
  qa4Act(host, relay, 's-a', { op: 'state.self', status: { currentHP: 0 } });
  var st = host.roster.get('s-a').sheet.status;
  eq(st.body, '重伤', '★ 集成：HP 24→0（上限 24，恰等）→ 不即死，重伤');
  eq(st.dying, true, '★ 集成：恰等上限归零 → 濒死标记（重伤→濒死）');
  qa4Bind(host, relay, 's-a', { name: '小明', status: { currentHP: 24, maxHP: 24, body: '正常' } });
  qa4Act(host, relay, 's-a', { op: 'state.self', status: { currentHP: 0, maxHP: 10 } });
  st = host.roster.get('s-a').sheet.status;
  eq(st.body, '死亡', '★ 集成：净伤 24 > 新上限 10 → 即死');
  eq(st.dying, false, '集成：即死后 dying 标记被清');
})();

/* ------------------------------------------------------------
 * M. T04 两个低风险待办的落地守卫
 *    M1. rules-coc7.js#BODY_STATUS：只改注释、值零改动（历史快照声明在）
 *    M2. room-store.js#archive：dying / unconscious 透传进结团归档摘要
 * ------------------------------------------------------------ */
section('M. T04 低风险待办守卫（BODY_STATUS 注释 / archive 透传）');

(function () {
  /* M1. BODY_STATUS 值逐字未动 + 注释已标注历史快照口径 */
  var cocSrc = fs.readFileSync(path.join(ROOT, 'web/js/core/rules-coc7.js'), 'utf8');
  ok(cocSrc.indexOf("var BODY_STATUS = ['正常', '轻伤', '重伤', '濒死', '昏迷', '死亡'];") >= 0,
    '★ BODY_STATUS 值逐字未动（六态历史快照，既有断言不破）');
  ok(/历史六态快照/.test(cocSrc) && /勿在新代码引用/.test(cocSrc),
    '★ 注释已声明「历史六态快照 / 已被四态+标记模型取代 / 勿在新代码引用」');
  /* 注释改动不影响运行行为：COC7.bodyStatus 仍是六态数组 */
  var R = global.COC7;
  ok(R && R.bodyStatus && R.bodyStatus.length === 6 && R.bodyStatus.indexOf('死亡') >= 0,
    'COC7.bodyStatus 运行期仍是六态（含「死亡」）—— 注释改动零行为影响');

  /* M2. archive 透传：真实跑 RoomStore.archive → getArchive 读回 */
  var RS = global.RoomStore;
  ok(!!RS && typeof RS.archive === 'function', 'RoomStore 已加载（第 1 节 D 小节 eval 过）');
  var state = {
    meta: { code: 'qa04ar', name: '归档验收团', rules: 'coc7', kpName: 'KP老张' },
    seq: 12,
    members: [
      { seat: 's-a', nickname: '濒死君', role: 'player', online: true, ready: false, charName: '甲',
        sheet: { name: '甲', madness: [], mental: ['正常'], sanLoss: 0, maxSAN: 50,
                 status: { currentHP: 0, maxHP: 24, body: '重伤', dying: true, unconscious: true } } },
      { seat: 's-b', nickname: '健康君', role: 'player', online: false, ready: true, charName: '乙',
        sheet: { name: '乙', madness: [], mental: ['正常'], sanLoss: 0, maxSAN: 50,
                 status: { currentHP: 24, maxHP: 24, body: '正常', dying: false, unconscious: false } } },
      { seat: 's-c', nickname: '无卡君', role: 'player', online: false, ready: false }
    ],
    logs: [], dice: []
  };
  var rec = RS.archive(state, { startedAt: 1, note: 'QA 验收' });
  ok(!!rec, 'archive() 写入成功');
  var back = RS.getArchive(rec.id);
  eq(back.members[0].sheet.dying, true, '★ 归档摘要带 dying（结团复盘看得到濒死）');
  eq(back.members[0].sheet.unconscious, true, '★ 归档摘要带 unconscious（看得到昏迷）');
  eq(back.members[1].sheet.dying, false, '健康成员 dying=false（布尔归一，不是 undefined）');
  eq(back.members[1].sheet.unconscious, false, '健康成员 unconscious=false');
  eq(back.members[2].sheet, null, '无 sheet 成员仍是 null（不炸）');
  /* 老存档（没有 status）也不炸 → false */
  var rec2 = RS.archive({
    meta: { code: 'qa04ar2', name: '老归档团' }, seq: 1,
    members: [{ seat: 's-x', nickname: '老卡', role: 'player',
                sheet: { name: '老卡', madness: [], mental: ['正常'], sanLoss: 0, maxSAN: 50 } }],
    logs: [], dice: []
  }, {});
  var back2 = RS.getArchive(rec2.id);
  eq(back2.members[0].sheet.dying, false, '老存档（无 status）→ dying=false 兜底（不炸）');
  eq(back2.members[0].sheet.unconscious, false, '老存档（无 status）→ unconscious=false 兜底');
  /* 清理测试产生的归档，不污染本机数据 */
  RS.removeArchive(rec.id); RS.removeArchive(rec2.id);
  eq(RS.getArchive(rec.id), null, '测试归档已清理');
})();



/* ============================================================
 * 第 6 节 · software-engineer-2（寇豆码）—— T02 房间 UI 补缺
 *   N. R1「名字下拉空选项」纪律（bout:N 分支缺空选项 → 只改 HP 也被追加疯狂）
 *
 * 背景 / 裁定：bout:N 是即时症状**单项**，旧实现把它当「只有一条 → 直接选中」，
 *   于是玩家只改 HP 点保存，selVal(nameSel) 也会拿到症状名 → 被追加一条疯狂。
 *   主理人裁定：安全 > 便捷 —— **所有类型分支**的名字下拉首项必须是空选项，
 *   要加疯狂必须手动选，或点「🎲 随机抽一个」主动抽。
 *
 * 验证手法：与第 1 / 2 节同款 —— **抽源 eval 真实代码**
 *   （MAD_TYPE_OPTS 构造 / boutRowOf / fillNames / selVal / 提交块 / 随机按钮块），
 *   配一个模拟原生 <select>「value 默认取首个 option」语义的 MiniSel。
 *   生产代码改坏（空选项被删 / 挪到 single 分支之后 / 随机没写回 value）这里就会红。
 * ============================================================ */
section('N. R1 名字下拉空选项纪律（bout:N 分支不误带症状 / 随机才选中）');

(function () {
  var MADn = global.CocMadness;
  ok(!!MADn && typeof MADn.boutTable === 'function', 'CocMadness 已加载（第 1 节已 eval）');

  /* rpClean 已在第 2 节定义（剥注释后的 room-panels 源码）；这里再归一换行便于锚定 */
  var flat = rpClean.replace(/\r\n/g, '\n');
  var boutRows = MADn.boutTable();

  /* ---- 迷你 <select>：复刻原生 select 的三条关键语义 ----
     1) appendChild 第一个 option 时，value 自动取它（这是旧 bug 的根因所在）；
     2) innerHTML = '' → options 清空且 value 归 ''；
     3) value 只能被设成**已存在**的 option（设不存在的值无效）。 */
  function MiniSel() {
    var self = this;
    self.options = [];
    self._v = '';
    Object.defineProperty(self, 'innerHTML', {
      get: function () { return ''; },
      set: function () { self.options = []; self._v = ''; }
    });
    Object.defineProperty(self, 'value', {
      get: function () { return self._v; },
      set: function (v) {
        var hit = null;
        self.options.forEach(function (o) { if (o.value === v) hit = o; });
        if (hit) self._v = v;
      }
    });
  }
  MiniSel.prototype.appendChild = function (o) {
    this.options.push(o);
    if (this.options.length === 1) this._v = o.value;
  };
  MiniSel.prototype.pick = function (v) { this.value = v; return this._v; };
  function miniCtl(sel) {
    return { querySelector: function (s) { return s === 'select' ? sel : null; } };
  }
  function fakeEl(tag, attrs) {
    var o = { tag: tag };
    Object.keys(attrs || {}).forEach(function (k) { o[k] = attrs[k]; });
    return o;
  }

  /* ---- 抽源：boutRowOf + 类型下拉构造 + fillNames + selVal（按源码真实顺序切段，互不重叠） ---- */
  var bBout = extractBlock(flat, 'function boutRowOf(tv)', 'var MAD_TYPE_OPTS = boutRows');
  var bOpts = extractBlock(flat, 'var MAD_TYPE_OPTS = boutRows', 'var typeSel = selectCtl');
  var bFill = extractBlock(flat, 'function fillNames()', 'function selVal(ctl)');
  var bSel = extractBlock(flat, 'function selVal(ctl)', 'typeSel.addEventListener');

  var typeInner = new MiniSel(), nameInner = new MiniSel();
  var typeSel = miniCtl(typeInner), nameSel = miniCtl(nameInner);
  var fsrc = 'var MAD = __MAD, boutRows = __rows, typeSel = __ts, nameSel = __ns, el = __el;\n'
    + bBout + '\n' + bOpts + '\n' + bFill + '\n' + bSel + '\n'
    + 'return { MAD_TYPE_OPTS: MAD_TYPE_OPTS, boutRowOf: boutRowOf, fillNames: fillNames, selVal: selVal };';
  var F = (new Function('__MAD', '__rows', '__ts', '__ns', '__el', fsrc))(
    MADn, boutRows, typeSel, nameSel, fakeEl);

  /* N1. 类型下拉仍是 10 项（数据源没被这次改动带偏） */
  eq(F.MAD_TYPE_OPTS.length, 10, '★ 类型下拉 10 项 = bout:1-8 + 恐惧症 + 躁狂（抽源 eval 真实构造）');
  F.MAD_TYPE_OPTS.forEach(function (o) {
    typeInner.appendChild(fakeEl('option', { value: o.value, text: o.label }));
  });

  /* N2. 源码纪律：空选项 appendChild 必须在 `if (single) {` **之前** */
  var iEmpty = bFill.indexOf("value: '', text: '（不添加疯狂）'");
  var iSingle = bFill.indexOf('if (single) {');
  ok(iEmpty >= 0, "★ fillNames 里存在 value='' 的「（不添加疯狂）」空选项");
  ok(iSingle >= 0 && iEmpty < iSingle,
    '★ 空选项 appendChild 在 if (single) 分支**之前** → bout:N 单项也先落空选项',
    { iEmpty: iEmpty, iSingle: iSingle });

  /* N3. bout:N 分支行为：首项空值 + 默认空串（核心缺口） */
  var rows18 = boutRows.filter(function (r) { return r && r.no >= 1 && r.no <= 8; });
  eq(rows18.length, 8, 'boutTable 1-8 共 8 条即时症状（下拉 bout 分支数据源）');
  eq(typeInner.pick('bout:3'), 'bout:3', '类型切到 bout:3（暴力倾向）');
  F.fillNames();
  eq(nameInner.options.length, 2, '★ bout:3 症状下拉只有 2 项 = 空选项 + 该症状（不再自动选中）');
  eq(nameInner.options[0].value, '', '★ bout 分支下拉**首项是空值**');
  eq(nameInner.options[0].text, '（不添加疯狂）', '空选项文案是「（不添加疯狂）」');
  eq(nameInner.options[1].value, rows18[2].name, '第二项才是 bout:3 对应症状名（暴力倾向）');
  eq(F.selVal(nameSel), '', '★ 翻到 bout:N 后未手动选 → selVal(nameSel) 默认为空串');

  /* ---- 抽源：提交按钮里的「是否带 madness」块 ---- */
  var bSubmit = extractBlock(flat, 'var madName = selVal(nameSel);', 'var changedMental');
  function runSubmit(permChecked, roundsVal) {
    var payload = { op: 'state.self', status: { currentHP: 10 } };
    var toasts = [];
    var g = { UI: { toast: function (m) { toasts.push(String(m)); } } };
    var s2 = 'var selVal = __selVal, nameSel = __ns, typeSel = __ts,'
      + ' permI = __permI, roundsI = __ri, M = __M, paintMental = __pm,'
      + ' payload = __pl, global = __g;\nvar mentalVals = __m0;\n'
      + bSubmit + '\nreturn { payload: payload, mentalVals: mentalVals, toasts: __toasts };';
    return (new Function('__selVal', '__ns', '__ts', '__permI', '__ri', '__M', '__pm',
      '__pl', '__g', '__m0', '__toasts', s2))(
      F.selVal, nameSel, typeSel, { checked: !!permChecked }, { value: String(roundsVal) },
      { cleanText: function (v) { return String(v == null ? '' : v); } },
      function () {}, payload, g, ['正常'], toasts);
  }

  /* N4. 核心：未手动选症状 → 提交不产生 payload.madness */
  var r1 = runSubmit(false, '0');
  ok(r1.payload.madness === undefined,
    '★ 翻到 bout:3 未手动选症状 → 提交**不产生** payload.madness（本次缺口已补）');
  eq(r1.payload.mental, undefined, '未选症状 → 也不自动打「临时疯狂 / 疯狂症状」标签');
  seq(r1.mentalVals, ['正常'], '未选症状 → mentalVals 保持原样（不会被污染）');

  /* N5. 抽源：🎲 随机抽一个按钮块 —— 点了才选中症状名 */
  var iR = flat.indexOf('🎲 随机抽一个');
  var sR = flat.indexOf('onclick: function () {', iR);
  var eR = flat.indexOf('} }),', sR);
  ok(iR >= 0 && sR > iR && eR > sR, '定位到「🎲 随机抽一个」按钮 onclick 段（函数名为锚）');
  var rndBody = flat.slice(sR + 'onclick: function () {'.length, eR);
  var rnd = (new Function('selVal', 'typeSel', 'nameSel', 'MAD', 'boutRowOf', 'global', rndBody));
  var rndToasts = [];
  rnd(F.selVal, typeSel, nameSel, MADn, F.boutRowOf,
    { UI: { toast: function (m) { rndToasts.push(String(m)); } } });
  eq(F.selVal(nameSel), rows18[2].name, '★ 点「🎲 随机抽一个」后确实选中 bout:3 的症状名');
  ok(rndToasts.join('|').indexOf('抽到：') >= 0, '随机后有「抽到：X」提示（可感知）', rndToasts);

  var r2 = runSubmit(false, '0');
  ok(!!r2.payload.madness, '★ 随机选中症状后 → 提交确实带 payload.madness（便捷性未被砍）');
  eq(r2.payload.madness.type, 'bout', '★ type 透传为 bout（bout:N 取 split(":")[0]，不再硬编码二选一）');
  eq(r2.payload.madness.name, rows18[2].name, 'madness.name = 抽到的症状名');
  eq(r2.payload.madness.permanent, false, 'permanent 恒 false（真·永久由 SAN 归零判定）');
  ok(r2.payload.madness.rounds >= 1 && r2.payload.madness.rounds <= 10,
    'rounds 落在 1D10（1-10）', r2.payload.madness.rounds);
  ok(r2.payload.mental.indexOf('临时疯狂') >= 0, '追加症状后自动打「临时疯狂」标签');
  ok(r2.payload.mental.indexOf('疯狂症状') >= 0, '追加症状后自动打「疯狂症状」标签');

  /* N6. phobia / mania 分支同样守纪律（翻类型后 innerHTML 重建，默认仍空） */
  typeInner.pick('phobia');
  F.fillNames();
  eq(nameInner.options[0].value, '', '★ phobia 分支首项也是空值（翻类型重建后仍守纪律）');
  eq(F.selVal(nameSel), '', '★ phobia 分支默认也是空串（改 HP 不会被误加恐惧症）');
  var phList = (MADn.phobias && MADn.phobias()) || [];
  ok(phList.length >= 10, 'phobia 表有数据', phList.length);
  eq(nameInner.options.length, phList.length + 1, 'phobia 分支 = 全表 + 1 个空选项');

  typeInner.pick('mania');
  F.fillNames();
  eq(nameInner.options[0].value, '', '★ mania 分支首项也是空值');
  eq(F.selVal(nameSel), '', '★ mania 分支默认也是空串');

  /* N7. 来回翻类型（bout → phobia → mania → 回 bout）默认始终为空 */
  typeInner.pick('bout:1');
  F.fillNames();
  eq(F.selVal(nameSel), '', '★ 来回翻类型后回到 bout:N，默认仍为空（innerHTML 重置生效）');

  /* N8. 手动选症状仍照常提交（只削「默认带」，不削「手动加」） */
  eq(nameInner.pick(rows18[0].name), rows18[0].name, '手动选中 bout:1 症状（失忆）');
  var r3 = runSubmit(false, '0');
  ok(!!r3.payload.madness && r3.payload.madness.name === rows18[0].name,
    '★ 手动选症状 → 正常提交（裁定的「安全 > 便捷」只砍默认，不砍手动）');
  eq(r3.payload.madness.type, 'bout', '手动选 bout:1 → type 同样是 bout');
})();
