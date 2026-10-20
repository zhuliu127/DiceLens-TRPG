/* ============================================================
 * audit_preset.js — 预设卡生成器全量审计（Node，纯逻辑）
 *   1. 连续生成 N 批 × 5 张，统计通过完整校验的比例
 *   2. 逐张核对：属性齐备 / 职业点未超 / 兴趣点未超 / 无技能超上限 /
 *      信用评级在范围内 / 背景与装备非空
 *   3. 顺带核对「母语不受上限设置限制」
 * 用法: node tools/audit_preset.js [批数]
 * ============================================================ */
'use strict';
var path = require('path');

var WEB = path.join(__dirname, '..', 'web');
global.window = global;

/* 最小 localStorage 桩 */
var mem = {};
global.localStorage = {
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
  setItem: function (k, v) { mem[k] = String(v); },
  removeItem: function (k) { delete mem[k]; }
};

['js/data/skills.js', 'js/data/occupations.js', 'js/data/weapons.js', 'js/data/armors.js',
 'js/data/vehicles.js', 'js/data/madness.js', 'js/data/spells.js', 'js/data/assets.js',
 'js/core/dice.js', 'js/core/rules-coc7.js', 'js/core/occupation.js', 'js/core/skillmodel.js',
 'js/core/engine.js', 'js/core/store.js', 'js/core/personas.js', 'js/core/avatar.js', 'js/core/preset.js'
].forEach(function (f) { require(path.join(WEB, f)); });

var batches = parseInt(process.argv[2], 10) || 12;
var total = 0, sound = 0, problems = {};
var nameSet = {};

function note(k) { problems[k] = (problems[k] || 0) + 1; }

for (var b = 0; b < batches; b++) {
  var list = global.PresetGen.generate(5);
  if (list.length !== 5) note('一批数量不足 5');
  list.forEach(function (c) {
    total++;
    nameSet[c.characterName] = (nameSet[c.characterName] || 0) + 1;

    var bad = global.Engine.checkList(c).filter(function (x) { return !x.ok; });
    if (!bad.length) sound++; else note('校验未通过：' + bad.map(function (x) { return x.label; }).join('/'));

    // 属性
    ['str', 'con', 'siz', 'dex', 'app', 'int', 'pow', 'edu', 'luck'].forEach(function (k) {
      var v = parseInt(c.attributes[k], 10);
      if (!v || v % 5 !== 0) note('属性 ' + k + ' 非法: ' + c.attributes[k]);
    });

    // 点数
    var occ = global.CocOccupation.occupationPoints(c);
    var it = global.CocOccupation.interestPoints(c);
    if (occ.used > occ.total) note('职业点超额 ' + occ.used + '/' + occ.total);
    if (it.used > it.total) note('兴趣点超额 ' + it.used + '/' + it.total);
    if (occ.used === 0) note('职业点一点没花');

    // 技能上限
    (c.skills || []).forEach(function (s) {
      var cap = global.SkillModel.capOf(c, s);
      if (s.total > cap) note('技能超上限 ' + s.name + ' ' + s.total + '>' + cap);
    });

    // 信用评级
    var o = global.CocOccupation.getById(c.occupationId);
    if (!o) note('没有职业');
    else {
      var cr = parseInt(c.assets.creditRating, 10) || 0;
      if (cr < o.creditMin || cr > o.creditMax) note('信用评级越界 ' + cr + ' 不在 ' + o.creditMin + '-' + o.creditMax);
      if (cr <= 0) note('信用评级为 0');
    }

    // 背景 / 装备 / 简历
    if (!c.background.description) note('背景描述为空');
    if (!c.background.traits) note('特点为空');
    if (!(c.history || []).length) note('没有经历');
    if (!(c.companions || []).length) note('没有伙伴');
    if (!(c.weapons || []).length) note('没有武器');
    if (!(c.armors || []).length) note('没有防具');
    if (!(c.items || []).length) note('没有物品');
    if (!c.assets.assetsDescription) note('资产描述为空');
    if (!c.playerName) note('玩家名为空');
  });
}

/* 母语上限豁免验证 */
var probe = global.Store.newCharacter('coc7');
probe.attributes = { str: 60, con: 60, siz: 60, dex: 60, app: 60, int: 60, pow: 60, edu: 80, luck: 50 };
probe.skillCapOcc = 50; probe.skillCapInterest = 40;
global.Engine.recalc(probe);
global.SkillModel.syncSkills(probe);
global.Engine.recalc(probe);
var own = probe.skills.filter(function (s) { return s.id === 'language_own'; })[0];
var dodge = probe.skills.filter(function (s) { return s.id === 'dodge'; })[0];
var ownCap = global.SkillModel.capOf(probe, own);
var dodgeCap = global.SkillModel.capOf(probe, dodge);
var ownAdd = global.SkillModel.canAdd(probe, own, 'int', 15);
console.log('=== 母语 / 闪避 上限豁免 ===');
console.log('母语 基础 ' + own.base + ' 上限 ' + ownCap + ' 加到 95 允许: ' + ownAdd.ok);
console.log('闪避 基础 ' + dodge.base + ' 上限 ' + dodgeCap + '（兴趣上限设置 40）');
var ownCapOk = ownCap === 99;
var dodgeCapOk = dodgeCap >= dodge.base;
console.log('母语固定 99:', ownCapOk, '| 闪避上限不低于基础值:', dodgeCapOk);

console.log('\n=== 预设卡审计（' + batches + ' 批 × 5 张） ===');
console.log('生成张数 ' + total + '，完整通过校验 ' + sound + '（' + Math.round(sound / total * 100) + '%）');
console.log('问题统计：', Object.keys(problems).length ? JSON.stringify(problems, null, 2) : '无');
console.log('同名卡：', Object.keys(nameSet).filter(function (k) { return nameSet[k] > 1; }).length);

var fail = total - sound;
console.log('\n结论：' + ((fail === 0 && ownCapOk && dodgeCapOk) ? 'PASS' : 'FAIL'));
process.exit((fail === 0 && ownCapOk && dodgeCapOk) ? 0 : 1);
