/* ============================================================
 * dice.js — 骰子工具
 * ============================================================ */
(function (global) {
  'use strict';

  function roll(n, sides) {
    var sum = 0;
    for (var i = 0; i < n; i++) sum += 1 + Math.floor(Math.random() * sides);
    return sum;
  }

  /** 掷骰表达式: "3D6" "2D6+6" "1D10+1D4+2" "4D6/3码" */
  function parse(expr) {
    if (!expr) return 0;
    var clean = String(expr).replace(/[（(].*?[)）]/g, '').replace(/[A-Za-z\u4e00-\u9fa5/码米步].*$/, '');
    var m = clean.match(/-?\d*[Dd]\d+|\d+/g);
    if (!m) return 0;
    var total = 0;
    m.forEach(function (tok) {
      if (/[Dd]/.test(tok)) {
        var p = tok.toLowerCase().split('d');
        var n = p[0] === '' || p[0] === '-' ? 1 : parseInt(p[0], 10);
        total += roll(Math.abs(n), parseInt(p[1], 10));
      } else {
        total += parseInt(tok, 10);
      }
    });
    return total;
  }

  function d(sides) { return roll(1, sides); }
  function d100() { return roll(1, 100); }

  /** COC 奖励骰/惩罚骰: 十位骰多掷 n 次取最优/最劣 */
  function d100Bonus(bonus) {
    var ones = d(10) - 1;          // 0-9 个位
    var tens = [d(10) - 1];
    var n = Math.abs(bonus);
    for (var i = 0; i < n; i++) tens.push(d(10) - 1);
    var t = bonus > 0 ? Math.min.apply(null, tens) : Math.max.apply(null, tens);
    var v = t * 10 + ones;
    return v === 0 ? 100 : v;
  }

  /** 成功等级判定 */
  function successLevel(rollVal, skill) {
    if (rollVal === 1) return 5;                       // 大成功
    if (rollVal === 100 || (skill < 50 && rollVal >= 96)) return -1; // 大失败
    if (rollVal <= Math.floor(skill / 5)) return 4;    // 极难成功
    if (rollVal <= Math.floor(skill / 2)) return 3;    // 困难成功
    if (rollVal <= skill) return 2;                    // 常规成功
    return 0;                                          // 失败
  }

  var LEVEL_TEXT = { 5: '大成功', 4: '极难成功', 3: '困难成功', 2: '成功', 0: '失败', '-1': '大失败' };

  global.COCDice = {
    roll: roll, d: d, d100: d100, parse: parse,
    d100Bonus: d100Bonus, successLevel: successLevel, LEVEL_TEXT: LEVEL_TEXT
  };
})(window);
