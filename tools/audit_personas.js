/* ============================================================
 * audit_personas.js — 世界设定一致性审计（Node，纯逻辑）
 *
 * 针对「随机角色逻辑不自洽 / 老是重复」这组问题，逐张核对：
 *   1. 世界设定有效，且姓名取自该设定的姓名池（张冠不能李戴）
 *   2. 居住地 / 出生地都属于该设定的地点池，且两者不相同
 *   3. 武器 / 防具的年代口径与设定匹配（古代不会掏出格洛克）
 *   4. 货币单位与设定一致
 *   5. 每张卡都自动带了头像
 *   6. 多样度：设定分布、同名率、背景文本重复率
 * 用法: node tools/audit_personas.js [批数]
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

['js/data/skills.js', 'js/data/occupations.js', 'js/data/weapons.js', 'js/data/armors.js',
 'js/data/vehicles.js', 'js/data/madness.js', 'js/data/spells.js', 'js/data/assets.js',
 'js/core/dice.js', 'js/core/rules-coc7.js', 'js/core/occupation.js', 'js/core/skillmodel.js',
 'js/core/engine.js', 'js/core/store.js', 'js/core/personas.js', 'js/core/avatar.js', 'js/core/preset.js'
].forEach(function (f) { require(path.join(WEB, f)); });

var PER = global.CocPersonas;
var batches = parseInt(process.argv[2], 10) || 10;

var problems = {};
function note(k) { problems[k] = (problems[k] || 0) + 1; }

var stat = {
  total: 0,
  byWorld: {},
  names: {},
  looks: {}, beliefs: {}, treasure: {}, place: {}, people: {},
  noAvatar: 0, sameCity: 0
};

for (var b = 0; b < batches; b++) {
  var list = global.PresetGen.generate(5);
  list.forEach(function (c) {
    stat.total++;
    var setting = PER.getById(c.worldId);

    /* 1. 设定有效 + 姓名出自对应姓名池 */
    if (!setting || setting.id !== c.worldId) { note('世界设定无效'); return; }
    stat.byWorld[setting.label] = (stat.byWorld[setting.label] || 0) + 1;
    stat.names[c.characterName] = (stat.names[c.characterName] || 0) + 1;

    var pool = PER.namePools[setting.nameKey];
    var nm = c.characterName;
    if (pool.order === 'fs') {
      if (nm.indexOf('·') < 0) note('西文设定但姓名无间隔号：' + nm);
      else {
        var seg = nm.split('·');
        if (pool.s.indexOf(seg[seg.length - 1]) < 0) note('西文姓氏不在池内：' + nm);
      }
    } else {
      var hitSurname = pool.s.some(function (s) { return nm.indexOf(s) === 0; });
      if (!hitSurname) note('中文姓氏不在池内：' + nm);
    }

    /* 2. 地点属于设定且居/籍不同 */
    var places = (setting.cities || []).concat(setting.towns || []);
    if (places.indexOf(c.basicInfo.residence) < 0) note('居住地不属于该设定：' + setting.label + '/' + c.basicInfo.residence);
    if (places.indexOf(c.basicInfo.birthplace) < 0) note('出生地不属于该设定：' + setting.label + '/' + c.basicInfo.birthplace);
    if (c.basicInfo.residence === c.basicInfo.birthplace) { stat.sameCity++; note('居住地与出生地相同'); }

    /* 3. 装备年代口径 */
    var pools = global.PresetGen.weaponPools(setting);
    var legal = {};
    pools.melee.concat(pools.gun).forEach(function (w) { legal[w.name] = true; });
    (c.weapons || []).forEach(function (w) {
      if (!legal[w.name]) note('武器不符合该设定年代：' + setting.label + '/' + w.name);
    });

    /* 4. 货币单位 */
    if (c.assets.currency !== setting.unit) note('货币单位不符：' + setting.label + '/' + c.assets.currency);

    /* 5. 头像 */
    if (!c.avatar || String(c.avatar).indexOf('data:image/svg+xml') !== 0) { stat.noAvatar++; note('缺少自动头像'); }

    /* 6. 文本多样度采样 */
    var bg = c.background;
    stat.looks[bg.description] = 1;
    stat.beliefs[bg.ideology] = 1;
    stat.treasure[bg.treasuresPossessions || bg.treasuredPossessions] = 1;
    stat.place[bg.meaningfulPlaces] = 1;
    stat.people[bg.significantPeople] = 1;
  });
}

var uniqNames = Object.keys(stat.names).length;
var dupNames = Object.keys(stat.names).filter(function (k) { return stat.names[k] > 1; });

console.log('\n=== 世界设定一致性审计（' + batches + ' 批 × 5 张）===');
console.log('样本张数：' + stat.total);
console.log('问题统计：' + (Object.keys(problems).length ? '' : '无'));
Object.keys(problems).forEach(function (k) { console.log('  · ' + k + ' × ' + problems[k]); });

console.log('\n--- 世界设定分布 ---');
Object.keys(stat.byWorld).sort(function (a, b) { return stat.byWorld[b] - stat.byWorld[a]; })
  .forEach(function (k) { console.log('  ' + k + '：' + stat.byWorld[k] + ' 张'); });
console.log('  覆盖设定数：' + Object.keys(stat.byWorld).length + ' / ' + PER.list.length);

console.log('\n--- 多样度 ---');
console.log('  不同姓名：' + uniqNames + ' / ' + stat.total + (dupNames.length ? '（重名 ' + dupNames.length + ' 个）' : '（无重名）'));
console.log('  不同外貌：' + Object.keys(stat.looks).length + ' / ' + stat.total);
console.log('  不同信念：' + Object.keys(stat.beliefs).length + ' / ' + stat.total);
console.log('  不同宝贵之物：' + Object.keys(stat.treasure).length + ' / ' + stat.total);
console.log('  不同意义非凡之地：' + Object.keys(stat.place).length + ' / ' + stat.total);
console.log('  不同重要之人：' + Object.keys(stat.people).length + ' / ' + stat.total);
console.log('  自动头像缺失：' + stat.noAvatar);
console.log('  居/籍相同：' + stat.sameCity);

console.log('\n结论：' + (Object.keys(problems).length === 0 ? 'PASS' : 'FAIL'));
process.exit(Object.keys(problems).length === 0 ? 0 : 1);
