/* ============================================================
 * test_v2119_combat_weapon.js —— v2.11.9 用户第 6 项
 *   战斗技能先随武器：只给「武器对应的战斗技能」加点；没武器保底斗殴。
 * 回答：
 *   1) 有没有「加了点、却没有对应武器」的战斗技能（应 0）？
 *   2) 卡是否仍然合规（isSound，点数该花的花完）？
 *   3) 大多数卡是否确实给武器对应战斗技能加到了点（匹配是否生效）？
 * 运行： node tools/test_v2119_combat_weapon.js
 * ============================================================ */
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');
var ROOT = path.join(__dirname, '..'), JS = path.join(ROOT, 'web', 'js');
function makeSandbox() {
  var s = { console: console, Math: Math, JSON: JSON, Date: Date, Object: Object,
    Array: Array, String: String, Number: Number, RegExp: RegExp,
    parseInt: parseInt, parseFloat: parseFloat, isNaN: isNaN, isFinite: isFinite };
  s.window = s; s.global = s; s.globalThis = s; vm.createContext(s); return s;
}
function loadAll(s) {
  ['data/skills', 'data/occupations', 'data/weapons', 'data/armors', 'data/vehicles',
   'data/madness', 'data/spells', 'data/assets', 'core/dice', 'core/rules-coc7',
   'core/occupation', 'core/skillmodel', 'core/engine', 'core/store', 'core/madness',
   'core/personas', 'core/avatar', 'core/easter-egg', 'core/preset'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(JS, f + '.js'), 'utf8'), s, { filename: f });
  });
}
var s = makeSandbox(); loadAll(s);
var G = s.PresetGen, SM = s.SkillModel;
var pass = 0, fail = 0, violations = 0, withWeapon = 0, noWeapon = 0, boosted = 0;
function ok(cond, label, extra) { if (cond) pass++; else { fail++; console.log('  [FAIL] ' + label + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); } }
var N = 80;
for (var i = 0; i < N; i++) {
  var arr = G.generate(1, {});
  var c = (arr && arr[0]) || G.generateOne({});
  var ws = {};
  (c.weapons || []).forEach(function (w) { var sk = String(w.skill || '').trim(); if (sk) ws[sk] = 1; });
  if (Object.keys(ws).length) withWeapon++; else { noWeapon++; ws = { '斗殴': 1 }; }
  var hit = 0;
  (c.skills || []).forEach(function (sk) {
    if (SM.categoryOf(sk.id) !== '战斗') return;
    var pts = (sk.occ || 0) + (sk.int || 0);
    if (pts > 0) {
      if (ws[sk.sub] || ws[sk.id]) hit = 1;
      else { violations++; ok(false, '无配套武器的战斗技能被加点', { char: c.characterName, weapons: Object.keys(ws), skill: sk.name, pts: pts }); }
    }
  });
  if (hit) boosted++;
  ok(G.isSound(c), '卡片合规 isSound', { char: c.characterName });
}
console.log('生成 ' + N + ' 张：有武器 ' + withWeapon + ' / 无武器(保底斗殴) ' + noWeapon +
            '；武器对应战斗技能被加点 ' + boosted + ' 张；违规 ' + violations + ' 处');
console.log('RESULT: ' + (fail === 0 ? 'PASS' : 'FAIL'));
