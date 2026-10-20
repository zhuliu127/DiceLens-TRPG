/**
 * v2.13.2（用户需求）：公开素材「放大后可拖动」——静态守护测试。
 *
 * 为什么用静态断言：这套平移是纯前端手势 + 布局计算，跑不了 node（没有布局引擎）。
 * 真正的行为验证在 Playwright 端到端脚本里（.workbuddy/tmp/map_pan_test.py，20 项断言）；
 * 这里只守住「关键实现别被后来的改动删掉/写反」，以及那条布局守护不变式。
 *
 * 运行：node tools/test_v2132_map_pan.js
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var PANELS = path.join(ROOT, 'web', 'js', 'ui', 'room-panels.js');
var CSS = path.join(ROOT, 'web', 'css', 'app.css');

var src = fs.readFileSync(PANELS, 'utf8');
var css = fs.readFileSync(CSS, 'utf8');

var pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

console.log('test_v2132_map_pan');

/* ---- 1. 状态 ---- */
ok(/pan:\s*\{\s*x:\s*0,\s*y:\s*0\s*\}/.test(src), 'UI_STATE 里有 pan 平移量');
ok(/panFor:/.test(src), 'UI_STATE 里有 panFor（记住平移属于哪张底图）');

/* ---- 2. 变换顺序：translate 必须在 scale 之前（否则拖动会被缩放放大，不跟手） ---- */
ok(/function applyMapTransform/.test(src), '存在 applyMapTransform()');
var fnBody = (src.match(/function applyMapTransform[\s\S]*?\n  \}/) || [''])[0];
var iTr = fnBody.indexOf("'translate('");
var iSc = fnBody.indexOf(' scale(');
ok(iTr >= 0 && iSc > iTr, 'applyMapTransform 里 translate 写在 scale 之前（顺序正确）');
ok(/translate\(' \+ \(Math\.round\(pan\.x/.test(fnBody), '平移量按 px 写入 translate（屏幕像素，1:1 跟手）');
ok(!/stage\.style\.transform\s*=\s*'scale\(/.test(src), '不再有「只有 scale」的旧写法');

/* ---- 3. 边界夹取 ---- */
ok(/function clampMapPan/.test(src), '存在 clampMapPan()（把平移夹进素材框）');
ok(/m\.r\s*-\s*m\.cx\s*-\s*hw/.test(src) && /m\.l\s*-\s*m\.cx\s*\+\s*hw/.test(src),
   '夹取区间由「框边 - 舞台中心」推出（不露白）');
ok(/loX\s*<=\s*hiX/.test(src), '某轴上放大后仍小于框时锁 0（不留白）');
ok(/m\.k/.test(src), '换算页面缩放倍率 k（.gp-zoom 下拖动仍 1:1 跟手）');

/* ---- 4. 手势 ---- */
ok(/function bindMapPan/.test(src), '存在 bindMapPan()');
ok(/setPointerCapture/.test(src), '拖动时捕获指针（手指滑出画面也不丢手势）');
ok(/map-panning/.test(src), '拖动中有 .map-panning 状态类');
ok(/__panMoved/.test(src), '拖动会标记 __panMoved');

/* ---- 5. 与「点击落标记」互斥 ---- */
ok(/if \(moved \|\| hostEl\.__panMoved\) return;/.test(src),
   'bindTap 遇到拖动不再落标记（KP 平移不会顺手多点一个点）');

/* ---- 6. 谁能拖 ---- */
ok(/var panMode = !editable \|\|/.test(src), '只读舞台（玩家）恒可拖');
ok(/UI_STATE\.tool\.mode !== 'draw' && UI_STATE\.tool\.mode !== 'erase'/.test(src),
   'KP 的画笔/橡皮模式不抢手势（拖动仍是作画/擦除）');
ok(/UI_STATE\.zoom \|\| 1\) > 1\.0001\) bindMapPan/.test(src), '只有放大后才绑定拖动');

/* ---- 7. 归零 ---- */
ok(/UI_STATE\.pan = \{ x: 0, y: 0 \};/.test(src), '换图 / 回到 100% 时平移归零');
ok(/panFor !== bgKey/.test(src), '换底图即重置平移');

/* ---- 8. UI ---- */
ok(/可拖动查看边缘/.test(src), '放大后出现「可拖动查看边缘」提示');

/* ---- 9. CSS ---- */
ok(/\.map-stage\.map-pannable\s*\{[^}]*touch-action:\s*none/.test(css),
   'CSS：.map-pannable 设 touch-action:none（拖动不滚页面）');
ok(/cursor:\s*grab/.test(css), 'CSS：可拖时光标为 grab');
ok(/\.map-stage-wrap\s*\{\s*overflow:\s*hidden;?\s*\}/.test(css),
   'CSS：素材框仍是 overflow:hidden（放大/拖动都不会溢出到别的栏目）');

/* ---- 10. 布局守护：.gp-grid 正向选择器仍须为 76 条（v2.5.0 的横屏不变式） ---- */
/* 口径与 test_v250_fixes 一致：去注释后逐行取「含 gp-grid 且含 {」，:not(...) 不算正向 */
function selectorLines(text) {
  var stripped = text.replace(/\/\*[\s\S]*?\*\//g, '');
  var out = [];
  stripped.split('\n').forEach(function (l) {
    if (l.indexOf('gp-grid') >= 0 && l.indexOf('{') >= 0) out.push(l.trim());
  });
  return out;
}
var positive = selectorLines(css).filter(function (l) { return l.indexOf(':not(') < 0; });
ok(positive.length === 76, '★ .gp-grid 正向选择器仍为 76 条（实测 ' + positive.length + '）');

console.log('\n最终结果：pass=' + pass + ' fail=' + fail);
process.exit(fail ? 1 : 0);
