/* ============================================================
 * test_status_madness.js —— 状态管理改动的单元测试（纯 Node）
 *
 * 覆盖本次四个改动里的前三个（第 4 个「房间读取」在 test_room_model.js）：
 *
 *   A. 背景的恐惧症/狂躁症 → 结构化「永久疯狂」
 *      · 带【恐惧症】标记的行能认出来
 *      · 不带标记、但名字在症状表里的行也认
 *      · 名字不在表里的自由文字**不能**被硬塞进数组
 *      · 幂等：反复跑不会重复添加
 *      · 老卡（只有文本、madness 为空）进 normalize 后自动补齐
 *
 *   B. 精神状态：单选字符串 → 多选数组
 *      · 老卡 '临时疯狂' → ['临时疯狂']
 *      · 老卡 '' / 缺失 → ['正常']
 *      · 已是数组则原样保留（幂等）
 *      · mentalList / mentalText 的兜底
 *
 *   C. 精神状态枚举里有「永久疯狂」
 *
 * 用法：node tools/test_status_madness.js
 * 成功时最后一行打印 RESULT: PASS
 * ============================================================ */
'use strict';

global.window = global;
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
function load(rel) {
  eval(fs.readFileSync(path.join(root, rel), 'utf8'));
}

/* 依赖顺序：症状数据 → 症状服务 → 规则枚举 → 引擎 → 存储 */
load('web/js/data/madness.js');
load('web/js/core/madness.js');
load('web/js/core/rules-coc7.js');
load('web/js/core/engine.js');
load('web/js/core/store.js');

const COC_MADNESS = global.CocMadness;
const Store = global.Store;
const R = global.COC7;

/* ---------------- 迷你断言框架 ---------------- */
let pass = 0, fail = 0;
const failures = [];

function ok(cond, label, extra) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(label + (extra === undefined ? '' : '　→ 实际: ' + JSON.stringify(extra)));
}
function eq(actual, expected, label) { ok(actual === expected, label, actual); }
function seq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label, actual);
}
function section(name) { console.log('\n=== ' + name + ' ==='); }

/** 造一张最小的「老卡」：只有 background 文本，madness 缺失 */
function legacyCard(text, mental) {
  return {
    id: 'test-1',
    characterName: '测试角色',
    basicInfo: { age: 30 },
    status: { mental: mental },
    background: { phobias: text },
    madness: [],
    skills: []
  };
}

/* ============================================================
 * A. 背景 → 永久疯狂
 * ============================================================ */
section('A. 背景的恐惧症/狂躁症 → 结构化「永久疯狂」');

/* 先确认症状表确实加载了（否则下面的用例会因为表为空而「假通过」） */
ok(COC_MADNESS.size > 100, '症状表已加载（phobia + mania 共 >100 条）', COC_MADNESS.size);

/* A1. 带标记的格式（steps-d.js 写出来的就是这种）。
   注意：症状名必须**从表里取**，不能自己编 —— 编的名字 lookup 不到，
   会被正确地忽略掉，用例就会假失败。 */
const samplePhobia = COC_MADNESS.phobias()[0];
const sampleMania = COC_MADNESS.manias()[0];
const p1 = COC_MADNESS.parseBackground(
  '【恐惧症】' + samplePhobia.name + '：描述一\n' +
  '【狂躁症】' + sampleMania.name + '：描述二');
ok(p1.length >= 2, '带【恐惧症】/【狂躁症】标记的行能被解析出来', p1.map(function (h) { return h.src && h.src.name; }));
ok(p1.every(function (h) { return h.src && h.src.name; }), '解析结果都命中了症状表条目');
ok(p1.some(function (h) { return h.type === 'phobia'; }) &&
   p1.some(function (h) { return h.type === 'mania'; }), '两种症状类型都能识别');

/* A1b. 标记写反了也不会错认：名字在狂躁症池里的，标着【恐惧症】时按名字纠正 */
const wrongTag = COC_MADNESS.parseBackground('【狂躁症】' + samplePhobia.name + '：x');
ok(wrongTag.length === 0 || wrongTag[0].type === 'phobia',
  '标记与名字冲突时以症状表为准（标记不硬套）', wrongTag.map(function (h) { return h.type; }));

/* A2. 找到一个真实存在的症状名，验证「无标记也能认」 */
const anyPhobia = COC_MADNESS.phobias()[0];
const p2 = COC_MADNESS.parseBackground(anyPhobia.name + '：随便写的描述');
eq(p2.length, 1, '不带标记、但名字在表里的行也能识别');
eq(p2[0].src.name, anyPhobia.name, '识别出的名字与表里一致');
eq(p2[0].type, 'phobia', '识别出的类型是恐惧症');

/* A3. 自由文字不能被硬塞 */
const p3 = COC_MADNESS.parseBackground('小时候在老家被狗追过\n喜欢收集旧钥匙');
eq(p3.length, 0, '症状表里查不到的自由文字一律忽略（不硬塞）');

/* A4. fromBackground 把文本补进数组，且是 permanent */
const c1 = legacyCard('【恐惧症】' + samplePhobia.name + '：描述');
const n1 = COC_MADNESS.fromBackground(c1);
ok(n1 >= 1, 'fromBackground 至少补进 1 条', n1);
ok(c1.madness.length === n1, 'madness 数组长度 == 新增条数');
ok(c1.madness.every(function (m) { return m.permanent === true; }),
  '从背景补进来的都是**永久疯狂**（permanent: true）');

/* A5. 幂等：再跑一次不加新的 */
const before = c1.madness.length;
const n2 = COC_MADNESS.fromBackground(c1);
eq(n2, 0, '重复跑 fromBackground 不新增（幂等）');
eq(c1.madness.length, before, 'madness 条数不变');

/* A6. 老卡进 Store.normalize 后自动补齐 */
const c2 = legacyCard('【恐惧症】' + samplePhobia.name + '：描述', '临时疯狂');
const norm = Store.normalize(c2);
ok(norm.madness.length >= 1, '老卡 normalize 后 madness 被自动补齐', norm.madness);
ok(norm.madness[0].permanent === true, '补齐的是永久疯狂');
/* 再 normalize 一次，仍然幂等 */
const norm2 = Store.normalize(c2);
eq(norm2.madness.length, norm.madness.length, 'normalize 反复跑不会越迁越多');

/* A7. fromPicked：背景点选时同步写数组 */
const c3 = { id: 'p', madness: [], background: { phobias: '' } };
const np = COC_MADNESS.fromPicked(c3, [{ kind: '恐惧症', name: anyPhobia.name, desc: '' }]);
eq(np, 1, 'fromPicked 新增 1 条');
eq(c3.madness[0].name, anyPhobia.name, '写入的名字正确');
eq(c3.madness[0].permanent, true, 'fromPicked 写的也是永久疯狂');
eq(COC_MADNESS.fromPicked(c3, [{ kind: '恐惧症', name: anyPhobia.name }]), 0,
  'fromPicked 重复点同一症状不重复添加');

/* ============================================================
 * B. 精神状态：单选 → 多选
 * ============================================================ */
section('B. 精神状态：单选字符串 → 多选数组');

const b1 = Store.normalize(legacyCard('', '临时疯狂'));
seq(b1.status.mental, ['临时疯狂'], "老卡 '临时疯狂' → ['临时疯狂']");

const b2 = Store.normalize(legacyCard('', ''));
seq(b2.status.mental, ['正常'], "老卡 '' → ['正常']");

const b3 = Store.normalize(legacyCard('', undefined));
seq(b3.status.mental, ['正常'], '老卡缺字段 → [\'正常\']');

const b4 = Store.normalize({ id: 'x', basicInfo: { age: 1 }, status: { mental: ['永久疯狂', '临时疯狂'] }, background: {}, madness: [] });
seq(b4.status.mental, ['永久疯狂'], '已是数组但含永久疯狂 → v2.1.5 互斥只留永久疯狂');

const b5 = Store.normalize({ id: 'x', basicInfo: { age: 1 }, status: { mental: [''] }, background: {}, madness: [] });
seq(b5.status.mental, ['正常'], '数组里全是空串 → 退回 [\'正常\']');

/* 读助手兜底（没经过 normalize 的裸对象也要能读） */
seq(Store.mentalList({ status: { mental: '不定疯狂' } }), ['不定疯狂'], 'mentalList 兜底：字符串也能读');
seq(Store.mentalList({}), ['正常'], 'mentalList 兜底：缺失读作 [\'正常\']');
eq(Store.mentalText({ status: { mental: ['永久疯狂', '临时疯狂'] } }),
  '永久疯狂　临时疯狂', 'mentalText 用全角空格拼接');

/* ============================================================
 * C. 枚举里有「永久疯狂」
 * ============================================================ */
section('C. 精神状态枚举');

ok(R.mentalStatus.indexOf('永久疯狂') >= 0, "MENTAL_STATUS 里含「永久疯狂」", R.mentalStatus);
eq(R.mentalNormal, '正常', 'mentalNormal == 正常');
ok(R.bodyStatus.indexOf('死亡') >= 0, '身体状态枚举不受影响', R.bodyStatus);

/* ---------------- 收尾 ---------------- */
console.log('\n----------------------------------------');
if (fail) {
  console.log('失败用例：');
  failures.forEach(function (f) { console.log('  ✗ ' + f); });
}
console.log('PASS ' + pass + ' / ' + (pass + fail));
console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exit(fail ? 1 : 0);
