/* ============================================================
 * audit_search.js — 技能 / 职业搜索漏检全量审计（Node，纯逻辑）
 *
 * 背景：搜索框曾经只比对「技能本身的名字」，
 *   组技能（格斗、射击、科学、技艺、驾驶、生存、学识、其他语言）的子类名
 *   完全不在索引里 —— 搜「斗殴」搜不到「格斗（斗殴）」。
 *
 * 本脚本逐条验证：
 *   1. 每个组技能的每一个子类名，都能命中该组技能（skillMatches）
 *   2. 「指定技能」选择器里，每个子类的实例文本都包含它自己的名字（instanceSearchText）
 *   3. 每条职业数据里出现的每个技能名 / 子类名，都能搜到该职业（search）
 *   4. 别名反向覆盖：职业数据写的旧译（魅惑）与技能库正式名（取悦）互相都能搜到
 * 用法: node tools/audit_search.js
 * ============================================================ */
'use strict';
var path = require('path');

var WEB = path.join(__dirname, '..', 'web');
global.window = global;
var mem = {};
global.localStorage = {
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
  setItem: function (k, v) { mem[k] = String(v); },
  removeItem: function (k) { delete mem[k]; }
};
['js/data/skills.js', 'js/data/occupations.js', 'js/core/dice.js', 'js/core/rules-coc7.js',
 'js/core/occupation.js'].forEach(function (f) { require(path.join(WEB, f)); });

var OCC = global.CocOccupation;
var SKILLS = global.COC_SKILLS;

var fails = [];
function bad(msg) { fails.push(msg); }

/* ---------- 1) 组技能子类名必须能命中 ---------- */
var subChecked = 0;
SKILLS.filter(function (s) { return s.special; }).forEach(function (g) {
  (g.subskills || []).forEach(function (sub) {
    subChecked++;
    if (!OCC.skillMatches(g, sub.name)) bad('[组] 搜「' + sub.name + '」搜不到组技能「' + g.name + '」');
    var inst = OCC.instanceSearchText(g.id, sub.name);
    if (inst.indexOf(sub.name.toLowerCase()) < 0) bad('[实例] 搜「' + sub.name + '」不在实例索引里（' + g.name + '）');
    if (!OCC.instanceMatches(g.id, sub.name, sub.name)) bad('[实例] instanceMatches 未命中「' + sub.name + '」');
    var hit = OCC.matchedSubs(g, sub.name);
    if (hit && hit.length && !hit.some(function (x) { return x.name === sub.name; })) {
      bad('[命中] 搜「' + sub.name + '」的命中集合里没有它自己');
    }
  });
  // 组名本身必须能命中，且命中时应列出全组
  if (!OCC.skillMatches(g, g.name)) bad('[组名] 搜「' + g.name + '」搜不到该组');
  if (OCC.matchedSubs(g, g.name) !== null) bad('[组名] 搜组名「' + g.name + '」应返回 null（列全组）');
});

/* ---------- 2) 非组技能的技能名必须能命中 ---------- */
SKILLS.filter(function (s) { return !s.special; }).forEach(function (s) {
  if (!OCC.skillMatches(s, s.name)) bad('[技能] 搜「' + s.name + '」搜不到技能本身');
  if (!OCC.instanceMatches(s.id, '', s.name)) bad('[技能-实例] 搜「' + s.name + '」未命中');
});

/* ---------- 3) 职业：数据里出现的技能名都要能搜到该职业 ---------- */
var occChecked = 0, termChecked = 0;
var NAME_TERMS = Object.keys(OCC.name2id);
OCC.listAll().forEach(function (o) {
  occChecked++;
  if (!OCC.search(o.name).some(function (x) { return x.id === o.id; })) {
    bad('[职业] 搜职业名「' + o.name + '」搜不到自己');
  }
  // 原文里出现的每个技能词
  var raw = o.skillText || '';
  NAME_TERMS.forEach(function (term) {
    if (raw.indexOf(term) < 0) return;
    termChecked++;
    if (!OCC.search(term).some(function (x) { return x.id === o.id; })) {
      bad('[职业] 「' + o.name + '」原文含「' + term + '」，但搜「' + term + '」搜不到它');
    }
  });
  // 解析出的子类名
  try {
    OCC.parseSkillText(raw).forEach(function (r) {
      (function walk(node) {
        if (!node) return;
        if (node.sub) {
          termChecked++;
          if (!OCC.search(node.sub).some(function (x) { return x.id === o.id; })) {
            bad('[职业] 「' + o.name + '」需要「' + node.sub + '」，但搜不到它');
          }
        }
        (node.pool || []).forEach(function (p) {
          if (!p.sub) return;
          termChecked++;
          if (!OCC.search(p.sub).some(function (x) { return x.id === o.id; })) {
            bad('[职业] 「' + o.name + '」池含「' + p.sub + '」，但搜不到它');
          }
        });
        (node.options || []).forEach(walk);
      })(r);
    });
  } catch (e) { bad('[职业] 「' + o.name + '」解析异常：' + e.message); }
});

/* ---------- 4) 别名互搜 ---------- */
var ALIAS_PROBE = [
  ['魅惑', '取悦'], ['取悦', '魅惑'],
  ['斗殴', '格斗'], ['步枪', '射击'], ['拉丁语', '其他语言'],
  ['图书馆', '图书馆使用'], ['电子学', '电气维修'], ['驾驶（船）', '船']
];
var aliasFails = [];
ALIAS_PROBE.forEach(function (p) {
  var hits = SKILLS.filter(function (s) { return OCC.skillMatches(s, p[0]); });
  if (!hits.length) aliasFails.push('搜「' + p[0] + '」什么都搜不到');
});
var charmHits = SKILLS.filter(function (s) { return OCC.skillMatches(s, '魅惑'); })
  .map(function (s) { return s.id; });
if (charmHits.indexOf('charm') < 0) aliasFails.push('搜「魅惑」没有命中取悦(charm)');

console.log('=== 搜索审计 ===');
console.log('组技能子类名检查 ' + subChecked + ' 项');
console.log('职业 ' + occChecked + ' 条，原文技能词检查 ' + termChecked + ' 处');
console.log('别名探测 ' + ALIAS_PROBE.length + ' 组 → 失败 ' + aliasFails.length);
aliasFails.forEach(function (x) { console.log('  ✗ ' + x); });
console.log('失败项 ' + fails.length);
fails.slice(0, 40).forEach(function (x) { console.log('  ✗ ' + x); });
if (fails.length > 40) console.log('  … 还有 ' + (fails.length - 40) + ' 项');
console.log('\n结论：' + ((fails.length === 0 && aliasFails.length === 0) ? 'PASS' : 'FAIL'));
process.exit((fails.length === 0 && aliasFails.length === 0) ? 0 : 1);
