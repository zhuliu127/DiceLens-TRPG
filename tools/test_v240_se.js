/*
 * v2.4.0 修复自测 · software-engineer 份额（用户第 ⑩⑪⑫ 项）
 *   ⑩ 奖惩骰 stepper：选项式重做（奖/惩分离、各自 0–5）
 *      · 单元：DOM shim 加载 room-panels.js，真实点击 diceBar 的 chips/± 键
 *        （上限提示文案随当前侧、0 以下静默夹 0、两侧独立、UI_STATE.d100Mod 落值）
 *      · 复现用户实录：「从 0 点 −」不得出现「奖励骰最多 5 个」错误文案、不得变负
 *   ⑪ 手绘板更新静默：boardSelf 不再发公开 LOG（无 feed 条目 ⇒ 不触发操作播报），
 *      数量/缩略同步与「正文只回本人」不回归
 *   ⑫ 场景检定：KP 推送弹层删「检定类型」下拉（静态）+ 玩家响应结果恒公开
 *      · 行为：EVT.SCENE_CHECK / 结算日志 vis=PUBLIC，另一名玩家的全量同步里
 *        能拿到场景检定结果（广播证明）；静态：场景掷骰不再继承暗骰开关
 *
 * 运行： node tools/test_v240_se.js（工作目录 = 仓库根）
 * 成功时最后一行打印 RESULT: PASS
 */
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');
var base = 'web/js/';

var pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? ('  → ' + extra) : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
function section(t) { console.log('\n== ' + t + ' =='); }
function feeder(seq) { var i = 0; return function () { return seq[i++ % seq.length]; }; }

/* ---------- 极简 DOM shim（只够 room-panels.js 的 h()/diceBar 用） ---------- */
function mkEl(tag) {
  return {
    tagName: String(tag || 'div').toUpperCase(), className: '', textContent: '', innerHTML: '',
    style: {}, children: [], listeners: {}, attrs: {}, disabled: false, value: '',
    appendChild: function (c) { this.children.push(c); return c; },
    addEventListener: function (t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    setAttribute: function (k, v) { this.attrs[k] = v; },
    fire: function (t) { (this.listeners[t] || []).forEach(function (fn) { fn({ target: this }); }, this); },
    querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    classList: { add: function () {}, remove: function () {}, contains: function () { return false; } },
    getBoundingClientRect: function () { return { left: 0, top: 0, width: 100, height: 100 }; }
  };
}
function walk(node, fn) {
  if (!node) return;
  fn(node);
  (node.children || []).forEach(function (c) { walk(c, fn); });
}
function byClass(root, cls) {
  var out = [];
  walk(root, function (n) {
    if (n.className && (' ' + n.className + ' ').indexOf(' ' + cls + ' ') >= 0) out.push(n);
  });
  return out;
}
function byText(root, txt) {
  var out = [];
  walk(root, function (n) { if (n.textContent === txt) out.push(n); });
  return out;
}

/* ---------- ⑩：加载 room-panels.js，单元测试 diceBar 的新奖惩骰控件 ---------- */
section('⑩ 奖惩骰 stepper（选项式：奖/惩分离，各自 0–5）');
var PANELS_SRC = fs.readFileSync(path.join(base, 'ui/room-panels.js'), 'utf8');

var toasts = [];
var sbP = {};
vm.createContext(sbP); sbP.window = sbP;
sbP.document = { createElement: mkEl, body: mkEl('body'), addEventListener: function () {} };
sbP.UI = {
  h: function (sel, props, kids) {
    var tag = 'div', cls = [], id = null;
    String(sel || 'div').split(/(?=[.#])/).forEach(function (p) {
      if (p[0] === '.') cls.push(p.slice(1));
      else if (p[0] === '#') id = p.slice(1);
      else tag = p;
    });
    var e = mkEl(tag);
    if (cls.length) e.className = cls.join(' ');
    if (id) e.attrs.id = id;
    if (props) Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'html') e.innerHTML = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'class') e.className += ' ' + v;
      else if (k in e && k !== 'list') { try { e[k] = v; } catch (err) { e.attrs[k] = v; } }
      else e.attrs[k] = v;
    });
    (function add(parent, children) {
      if (children === null || children === undefined || children === false) return;
      if (Array.isArray(children)) { children.forEach(function (c) { add(parent, c); }); return; }
      if (children && children.tagName) { parent.appendChild(children); return; }
      parent.appendChild({ tagName: '#text', textContent: String(children), children: [] });
    })(e, kids);
    return e;
  },
  esc: function (s) { return String(s == null ? '' : s); },
  toast: function (msg) { toasts.push(String(msg)); },
  clear: function () {}, sheet: function () { return { close: function () {} }; },
  confirm: function () { return { then: function () {} }; }
};
vm.runInContext(fs.readFileSync(path.join(base, 'ui/room-panels.js'), 'utf8'), sbP, { filename: 'room-panels.js' });
var RP = sbP.RoomPanels;
ok(!!RP && typeof RP.diceBar === 'function', 'room-panels.js 可在 DOM shim 下加载且导出 diceBar');

function mkBar(role) {
  var st = { meta: { status: 'in', mode: 'EXPLORE' }, members: [], combat: { order: [] }, scene: {} };
  var ctx = { st: st, role: role || 'kp', host: null, client: null, side: null,
              act: function () {}, intent: function () {}, paint: function () {}, refreshSheet: function () {} };
  return RP.diceBar(ctx);
}
function barParts() {
  var bar = mkBar('kp');
  var bonusChip = byClass(bar, 'bonus')[0], penaltyChip = byClass(bar, 'penalty')[0];
  var minus = byText(bar, '−')[0], plus = byText(bar, '+')[0];
  var cnt = byClass(bar, 'cnt')[0], eff = byClass(bar, 'eff')[0];
  return { bar: bar, bonusChip: bonusChip, penaltyChip: penaltyChip, minus: minus, plus: plus, cnt: cnt, eff: eff };
}

(function () {
  /* 初始态 */
  RP._state.d100Mod = { bonus: 0, penalty: 0 };
  var p = barParts();
  ok(!!p.bonusChip && !!p.penaltyChip && !!p.minus && !!p.plus && !!p.cnt && !!p.eff,
     '新控件结构：奖励骰/惩罚骰 chips + −/+ + 计数 + 生效说明');
  eq(p.cnt.textContent, '0', '初始计数为 0');
  eq(p.eff.textContent, '不修正', '初始生效说明为「不修正」');
  ok((' ' + p.bonusChip.className + ' ').indexOf(' on ') >= 0, '初始选中「奖励骰」侧');
  ok((' ' + p.penaltyChip.className + ' ').indexOf(' on ') < 0, '「惩罚骰」侧未选中');

  /* 加：0 → 3 */
  toasts = [];
  p.plus.fire('click'); p.plus.fire('click'); p.plus.fire('click');
  eq(RP._state.d100Mod.bonus, 3, '点 + 三次 → 奖励骰 = 3');
  eq(RP._state.d100Mod.penalty, 0, '惩罚骰不受影响（奖/惩分离）');
  eq(p.eff.textContent, '奖励骰 3', '生效说明显示「奖励骰 3」');
  eq(toasts.length, 0, '0→3 过程无提示骚扰');

  /* 上限：5 之后阻断 + 文案随当前侧 */
  p.plus.fire('click'); p.plus.fire('click');
  eq(RP._state.d100Mod.bonus, 5, '奖励骰上限 5');
  toasts = [];
  p.plus.fire('click');
  eq(RP._state.d100Mod.bonus, 5, '超过 5 被阻断（不静默无响应）');
  eq(toasts.length, 1, '越界时给出一次提示');
  eq(toasts[0], '奖励骰最多 5 个', '提示文案与当前侧一致（奖励骰）');

  /* 减到 0 后再点 −：不出现错误文案、不变负（用户实录复现点） */
  for (var i = 0; i < 5; i++) p.minus.fire('click');
  eq(RP._state.d100Mod.bonus, 0, '连点 − 回到 0');
  toasts = [];
  p.minus.fire('click');
  eq(RP._state.d100Mod.bonus, 0, '0 以下不允许：夹在 0');
  eq(toasts.length, 0, '从 0 点「−」不再误报「奖励骰最多 5 个」（用户实录 bug 已修）');

  /* 切到惩罚骰侧：同样的 ± 逻辑 */
  p.penaltyChip.fire('click');
  ok((' ' + p.penaltyChip.className + ' ').indexOf(' on ') >= 0, '点击 chip 切换到「惩罚骰」侧');
  toasts = [];
  p.plus.fire('click');
  eq(RP._state.d100Mod.penalty, 1, '惩罚侧 + → 惩罚骰 = 1');
  eq(p.eff.textContent, '惩罚骰 1', '生效说明显示「惩罚骰 1」');
  p.minus.fire('click');
  eq(RP._state.d100Mod.penalty, 0, '惩罚侧 − → 0');
  toasts = [];
  p.minus.fire('click');
  eq(RP._state.d100Mod.penalty, 0, '惩罚侧 0 以下同样夹 0');
  eq(toasts.length, 0, '惩罚侧从 0 点 − 也无错误文案');
  for (var j = 0; j < 5; j++) p.plus.fire('click');
  toasts = [];
  p.plus.fire('click');
  eq(toasts[0], '惩罚骰最多 5 个', '惩罚侧越界文案为「惩罚骰最多 5 个」');

  /* 两侧可同时设置（规则层会抵消），生效说明并列显示 */
  RP._state.d100Mod = { bonus: 0, penalty: 0 };
  p = barParts();
  p.bonusChip.fire('click'); p.plus.fire('click'); p.plus.fire('click');
  p.penaltyChip.fire('click'); p.plus.fire('click');
  eq(p.eff.textContent, '奖 2 · 惩 1', '两侧都有值时生效说明并列（奖 2 · 惩 1）');

  /* KP 与玩家两侧同一控件（行为一致） */
  var barPl = mkBar('player');
  var plChips = byClass(barPl, 'bonus').concat(byClass(barPl, 'penalty'));
  eq(plChips.length, 2, '玩家侧 diceBar 同样是选项式控件（KP/玩家一致）');
})();

/* 静态：旧「带符号单数（bonus − penalty）」显示与只增不减的 bump 已移除 */
(function () {
  /* 剥掉块注释/行注释再断言：修复说明里难免提到旧写法，不能算回归 */
  function strip(s) { return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1'); }
  var m = /function diceBar\([\s\S]*?\n  \}/.exec(PANELS_SRC);
  ok(!!m, '能取到 diceBar 函数源码');
  var src = m ? strip(m[0]) : '';
  ok(src.indexOf('bonus - penalty') < 0 && !/bonus\s*-\s*penalty/.test(src),
     '旧「bonus − penalty 带符号单数」显示已移除');
  ok(src.indexOf("text: '奖励骰'") >= 0 && src.indexOf("text: '惩罚骰'") >= 0,
     '新控件带「奖励骰 / 惩罚骰」两个模式 chip');
  ok(/最多 ' \+ MOD_MAX/.test(src), '上限提示随当前侧动态生成（不再写死奖励骰）');
  ok(src.indexOf('奖励/惩罚骰') < 0, '旧的「奖励/惩罚骰」混合标签已移除');
})();

/* ============================================================
 * ⑪ 手绘板更新静默
 * ============================================================ */
section('⑪ 手绘板更新静默（不写公开记录 / 不触发操作播报）');
var sbM = {};
vm.createContext(sbM); sbM.window = sbM;
['core/room-rules.js', 'core/room-model.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(base, f), 'utf8'), sbM, { filename: f });
});
var M = sbM.RoomModel, R = sbM.CocRules;

(function () {
  var host = new M.Host({ rules: R, rng: feeder([0.3]), madness: null, now: function () { return 1000; } });
  host.roster.open({ seat: 's1', role: M.ROLE.PLAYER, nickname: '小美' });
  host.roster.open({ seat: 's2', role: M.ROLE.PLAYER, nickname: '小红' });
  host.state.meta.status = M.STATUS.IN_GAME;

  var out = host.intent('s1', { op: M.INTENT.BOARD,
    p: { strokes: [{ color: '#00f', width: 1.4, pts: [{ x: 0.3, y: 0.3 }, { x: 0.4, y: 0.4 }] }] } });

  var logs = (out || []).filter(function (r) { return r.msg && r.msg.t === M.EVT.LOG; });
  eq(logs.length, 0, 'boardSelf 不再发任何 EVT.LOG（无 feed 条目 ⇒ 不触发 v2.3.0 操作播报）');
  var boards = (out || []).filter(function (r) { return r.msg && r.msg.t === M.EVT.BOARD; });
  eq(boards.length, 1, '仍发 EVT.BOARD（状态同步保留）');
  eq(boards[0].to, 's1', 'EVT.BOARD 仍只单发给本人（正文不外泄）');
  ok(boards[0].msg.p.self === true && (boards[0].msg.p.strokes || []).length === 1, '正文仍只回本人');

  eq((host.state.scene.boards['s1'] || {}).count, 1, '权威端 scene.boards 数量同步仍在');
  eq(host.warnings.length, 0, '无 SEAT 缺收件人之类警告');

  var sync2 = JSON.stringify(host.syncFor('s2'));
  ok(sync2.indexOf('更新了手绘板') < 0, '别人的全量同步里没有「更新了手绘板」记录');
  ok(sync2.indexOf('#00f') < 0 && sync2.indexOf('"pts"') < 0, '别人的同步里仍拿不到笔迹正文（隐私不回退）');
  var sync1 = JSON.stringify(host.syncFor('s1'));
  ok(sync1.indexOf('#00f') >= 0, '本人重连仍能拿回自己的板（功能不回归）');

  /* 静态：模型里不再有 kind:board 的公开日志（剥注释后断言） */
  var boardKindLog = "kind: 'board'";
  var modelSrc = fs.readFileSync(path.join(base, 'core/room-model.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  ok(modelSrc.indexOf(boardKindLog) < 0, '模型源码中不再存在 kind:board 的公开日志（代码，非注释）');
  var boardSelfFn = /Host\.prototype\.boardSelf = function[\s\S]*?\n  \};/.exec(modelSrc);
  ok(!!boardSelfFn && boardSelfFn[0].indexOf('EVT.LOG') < 0,
     'boardSelf 函数体内不再出现 EVT.LOG（公开记录零条目）');
})();

/* ============================================================
 * ⑫ 场景检定：删「检定类型」下拉 + 结果广播（vis=PUBLIC）
 * ============================================================ */
section('⑫ 场景检定：类型下拉已删 + 玩家结果广播公开');
(function () {
  /* 剥掉块注释/行注释再断言：修复说明里难免提到旧写法，不能算回归 */
  function strip(s) { return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1'); }

  /* ---- 静态：KP 推送弹层不再有「检定类型」 ---- */
  var fn = /function kpSceneCheckPanel\([\s\S]*?\n  \}/.exec(PANELS_SRC);
  ok(!!fn, '能取到 kpSceneCheckPanel 源码');
  var kpSrc = fn ? strip(fn[0]) : '';
  ok(kpSrc.indexOf('技能检定') < 0 && kpSrc.indexOf('属性检定') < 0,
     'KP 场景检定面板不再渲染「检定类型」下拉（技能/属性选项已删）');
  ok(kpSrc.indexOf('typeSel') < 0, 'typeSel（技能/属性选择）已移除');
  ok(kpSrc.indexOf("op: 'check.request'") >= 0, '快速推送仍走 check.request（协议不变）');
  ok(!/desc:\s*\(typeSel/.test(kpSrc), '推送载荷不再依赖类型下拉（desc 直接取技能名）');

  /* ---- 静态：场景检定掷骰不再继承暗骰开关 ---- */
  var fn2 = /function plSceneCheckPanel\([\s\S]*?\n  \}/.exec(PANELS_SRC);
  ok(!!fn2, '能取到 plSceneCheckPanel 源码');
  var plSrc = fn2 ? strip(fn2[0]) : '';
  /* 只截取「掷这次检定」按钮的 onclick 区域（同函数里还有玩家自主的「我要检定」
     卡片，那个仍尊重暗骰开关 —— 不能混在一起断言） */
  var rollFrom = plSrc.indexOf('掷这次检定');
  var rollTo = plSrc.indexOf('已掷出，结果进游戏记录', rollFrom);
  ok(rollFrom >= 0 && rollTo > rollFrom, '能定位场景检定掷骰按钮区域');
  var rollSrc = rollFrom >= 0 && rollTo > rollFrom ? plSrc.slice(rollFrom, rollTo) : '';
  ok(rollSrc.indexOf('secret: false') >= 0, '场景检定掷骰显式 secret:false（恒明骰）');
  ok(rollSrc.indexOf('UI_STATE.darkRoll') < 0,
     '场景检定掷骰不再继承暗骰开关（原「只有 KP 看得到」根因）');
  ok(/我要检定[\s\S]*secret: !!UI_STATE\.darkRoll/.test(plSrc),
     '玩家自主「我要检定」仍尊重暗骰开关（私密语义保留）');

  /* ---- 行为：EVT.SCENE_CHECK / 结算日志 vis=PUBLIC，且广播到其他玩家 ---- */
  var host = new M.Host({ rules: R, rng: feeder([0.42]), madness: null, now: function () { return 1000; } });
  host.roster.open({ seat: 's1', role: M.ROLE.PLAYER, nickname: '小美' });
  host.roster.open({ seat: 's2', role: M.ROLE.PLAYER, nickname: '小红' });
  var m1 = host.roster.get('s1');
  m1.charName = '小美';
  m1.sheet = { name: '小美', attrs: { dex: 55 }, status: { currentHP: 12, maxHP: 12, currentSAN: 50, maxSAN: 50 },
               skills: [{ name: '侦查', total: 55 }], weapons: [], madness: [], mental: ['正常'], db: '0' };
  host.state.meta.status = M.STATUS.IN_GAME;

  var push = host.intent('host', { op: M.INTENT.ACT, p: { op: 'scene.check.push', title: '摸尸体', desc: '', steps: [
    { id: 'st1', title: '侦查', skill: '侦查', targetSeat: 's1', difficulty: 'REGULAR',
      bonus: 0, penalty: 0, onSuccess: { note: '找到线索', damage: '' }, onFailure: { note: '', damage: '' } }
  ] } });
  var pushEvt = (host.log.items || []).filter(function (r) { return r.evt.t === M.EVT.SCENE_CHECK; }).pop();
  eq(pushEvt && pushEvt.evt.vis, M.VIS.PUBLIC, '推送场景检定：EVT.SCENE_CHECK vis=PUBLIC');

  /* 玩家响应（plSceneCheckPanel 改造后的载荷形状：direct + secret:false） */
  host.intent('s1', { op: M.INTENT.DICE, p: { expr: '1D100', direct: true, base: 55,
    difficulty: 'REGULAR', label: '侦查', bonus: 0, penalty: 0, secret: false } });
  var diceEvt = (host.log.items || []).filter(function (r) { return r.evt.t === M.EVT.DICE; }).pop();
  eq(diceEvt && diceEvt.evt.vis, M.VIS.PUBLIC, '玩家场景检定掷骰：EVT.DICE vis=PUBLIC（明骰广播）');

  /* KP 裁定 */
  host.intent('host', { op: M.INTENT.ACT, p: { op: 'scene.check.step', stepId: 'st1', seat: 's1', level: 2 } });
  var stepEvts = (host.log.items || []).filter(function (r) { return r.evt.t === M.EVT.SCENE_CHECK; });
  eq(stepEvts[stepEvts.length - 1].evt.vis, M.VIS.PUBLIC, '结算后 EVT.SCENE_CHECK vis=PUBLIC');
  var settleLog = (host.log.items || []).filter(function (r) {
    return r.evt.t === M.EVT.LOG && /场景检定/.test((r.evt.p || {}).text || '');
  }).pop();
  ok(!!settleLog, '结算写了公开记录（EVT.LOG）');
  eq(settleLog && settleLog.evt.vis, M.VIS.PUBLIC, '结算日志 vis=PUBLIC');
  ok(/成功/.test((settleLog && settleLog.evt.p.text) || ''), '结算文案含成功/失败等级');

  /* 广播证明：另一名玩家（非 KP、非掷骰者）的全量同步里能拿到结果 */
  var sync2 = JSON.stringify(host.syncFor('s2'));
  ok(sync2.indexOf('场景检定') >= 0, '另一名玩家的全量同步含场景检定结果（真的广播了）');
  ok(sync2.indexOf('找到线索') >= 0 || sync2.indexOf('成功') >= 0, '同步里含步骤结果文案');
})();

console.log('\nv2.4.0（⑩⑪⑫ · software-engineer）selftest: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) { console.log('RESULT: FAIL'); process.exit(1); }
console.log('RESULT: PASS');
