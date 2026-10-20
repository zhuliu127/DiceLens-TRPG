/* ============================================================
 * qa_v2110_dicebar.js —— QA 独立渲染探针（v2.11.0 + v2.11.2 回归）
 *
 * 目的：**证明它能工作**（不是确认改动存在）。真跑 RoomPanels.diceBar(ctx) /
 *       RoomPanels.kpPanel(ctx)，断言：
 *         F · v2.11.0 🩺 急救/医疗/精神分析 按钮：玩家含 / KP 不含 / 锁定玩家 disabled
 *         G · v2.11.2 🎯 技能检定 入口补进**真实**工具栏 diceBar
 *         H · v2.11.2 奖惩骰**互斥**：切到一侧即清空另一侧（点已选中侧不清空）
 *         I · v2.11.2 KP「待你确认」队列文案中文化（不再裸显示 aid.psycho 等代码）
 *
 * 说明：环境无 jsdom（已探测 NOT INSTALLED），故自带**最小 DOM shim**
 *       （严格镜像 web/js/ui/components.js#h 的契约：选择器解析 / props 语义 /
 *        null-false 跳过 / text→textContent / disabled→属性 / on*→addEventListener）。
 *       只读加载业务源码，不改动源码。
 *
 * 运行： node tools/qa_v2110_dicebar.js   （工作目录 = 仓库根）
 * ============================================================ */
'use strict';
var fs = require('fs'), path = require('path');
var ROOT = path.join(__dirname, '..');

/* ---------------- 最小 DOM shim ---------------- */
function TextNode(s) { this.__text = String(s); this.nodeType = 3; }
function DomNode(tag) {
  this.nodeType = 1;
  this.tagName = String(tag || 'div').toUpperCase();
  this.className = '';
  this.id = '';
  this.childNodes = [];
  this.style = {};
  this.disabled = false;
  this.title = '';
  this._text = '';
  this._attrs = {};
  this._listeners = {};
}
Object.defineProperty(DomNode.prototype, 'textContent', {
  get: function () {
    var s = this._text;
    for (var i = 0; i < this.childNodes.length; i++) {
      var c = this.childNodes[i];
      s += (c instanceof TextNode) ? c.__text : c.textContent;
    }
    return s;
  },
  set: function (v) { this._text = (v == null ? '' : String(v)); this.childNodes = []; }
});
DomNode.prototype.appendChild = function (c) { this.childNodes.push(c); return c; };
DomNode.prototype.removeChild = function (c) {
  var i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); return c;
};
DomNode.prototype.addEventListener = function (t, f) { (this._listeners[t] = this._listeners[t] || []).push(f); };
DomNode.prototype.setAttribute = function (k, v) { this._attrs[k] = v; if (k === 'class') this.className = v; };
DomNode.prototype.getAttribute = function (k) { return this._attrs[k]; };
DomNode.prototype.querySelector = function () { return null; };
DomNode.prototype.querySelectorAll = function () { return []; };

global.Node = DomNode;
global.Text = TextNode;
global.document = {
  createElement: function (t) { return new DomNode(t); },
  createTextNode: function (s) { return new TextNode(s); },
  body: new DomNode('body'),
  documentElement: new DomNode('html')
};
global.window = global;

/* ---- UI.h —— 逐行镜像 components.js#h（选择器/props/append 语义） ---- */
function h(sel, props, children) {
  var tag = 'div', cls = [], id = null;
  sel = sel || 'div';
  sel.split(/(?=[.#])/).forEach(function (p) {
    if (p[0] === '.') cls.push(p.slice(1));
    else if (p[0] === '#') id = p.slice(1);
    else tag = p;
  });
  var el = document.createElement(tag);
  if (cls.length) el.className = cls.join(' ');
  if (id) el.id = id;
  if (props) {
    Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className += ' ' + v;
      else if (k in el && k !== 'list') { try { el[k] = v; } catch (e) { el.setAttribute(k, v); } }
      else el.setAttribute(k, v);
    });
  }
  append(el, children);
  return el;
}
function append(parent, children) {
  if (children === null || children === undefined || children === false) return;
  if (Array.isArray(children)) { children.forEach(function (c) { append(parent, c); }); return; }
  if (children instanceof DomNode || children instanceof TextNode) { parent.appendChild(children); return; }
  parent.appendChild(document.createTextNode(String(children)));
}

global.UI = {
  h: h,
  esc: function (s) { return String(s == null ? '' : s); },
  toast: function () {},
  sheet: function () { return {}; },
  select: function () { return new DomNode('div'); }
};

/* ---------------- 加载被测源码（只读） ---------------- */
eval(fs.readFileSync(path.join(ROOT, 'web/js/core/room-model.js'), 'utf8'));
eval(fs.readFileSync(path.join(ROOT, 'web/js/ui/room-panels.js'), 'utf8'));
var RP = global.RoomPanels;

/* ---------------- 断言工具 ---------------- */
var pass = 0, fail = 0, failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  [PASS] ' + label); }
  else { fail++; failures.push(label); console.log('  [FAIL] ' + label + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra))); }
}

/* 递归收集所有 <button> 节点 */
function collectButtons(node, out) {
  out = out || [];
  if (node && node.nodeType === 1) {
    if (node.tagName === 'BUTTON') out.push(node);
    for (var i = 0; i < node.childNodes.length; i++) collectButtons(node.childNodes[i], out);
  }
  return out;
}
var AID = '🩺 急救/医疗/精神分析';
var SKILL = '🎯 技能检定';
function findAid(root) {
  var bs = collectButtons(root);
  for (var i = 0; i < bs.length; i++) if (bs[i].textContent === AID) return bs[i];
  return null;
}
function findBtnByText(root, t) {
  var bs = collectButtons(root);
  for (var i = 0; i < bs.length; i++) if (bs[i].textContent === t) return bs[i];
  return null;
}
/* 按 class 收集节点 */
function findByClass(root, cls) {
  var out = [];
  (function walk(n) {
    if (!n || n.nodeType !== 1) return;
    if ((' ' + (n.className || '') + ' ').indexOf(' ' + cls + ' ') >= 0) out.push(n);
    (n.childNodes || []).forEach(walk);
  })(root);
  return out;
}
/* 触发 click（shim 的 addEventListener 只存不派发） */
function clickNode(n) {
  if (!n) return;
  (n._listeners['click'] || []).forEach(function (f) { f(); });
}
/* 汇总所有「直接文本」，用于 indexOf 校验（不重复聚合子孙） */
function allText(root) {
  var parts = [];
  (function walk(n) {
    if (!n) return;
    if (n.nodeType === 3) { parts.push(n.__text); return; }
    if (n.nodeType !== 1) return;
    if (n._text) parts.push(n._text);
    (n.childNodes || []).forEach(walk);
  })(root);
  return parts.join('\n');
}

/* ---------------- ctx 工厂 ---------------- */
function mkPlayerCtx(over) {
  over = over || {};
  var me = {
    seat: 's1', role: 'player', name: '甲',
    sheet: { status: over.status || {}, mental: over.mental || [], attrs: { dex: 60 } }
  };
  return {
    role: 'player',
    client: { seat: 's1' },
    st: { members: [me], meta: over.meta || { mode: 'EXPLORATION' } },
    intent: function () {}, paint: function () {}
  };
}
function mkKpCtx() {
  return {
    role: 'kp',
    client: null,
    st: { members: [{ seat: 'kp', role: 'kp', name: 'KP' }], meta: { mode: 'EXPLORATION' } },
    act: function () {}, paint: function () {}
  };
}
function mkSpecCtx() {
  return { role: 'spectator', client: { seat: 'x' }, st: { members: [], meta: {} }, paint: function () {} };
}
/* KP + 待确认队列（host.pending 的项结构与 room-model.js:1652 一致：
   { by, op, p, need, at }） */
function mkKpPendingCtx(pending) {
  return {
    role: 'kp',
    client: null,
    host: { pending: pending },
    st: {
      members: [
        { seat: 's1', role: 'player', charName: '调查员甲', nickname: '甲', sheet: { status: {} } },
        { seat: 's2', role: 'player', charName: '调查员乙', nickname: '乙', sheet: { status: {} } }
      ],
      meta: { mode: 'EXPLORATION' }
    },
    side: { confirmAct: function () {} },
    act: function () {}, intent: function () {}, paint: function () {}
  };
}

/* ============================================================
 * F · v2.11.0 🩺 急救/医疗/精神分析 + 玩家操作锁
 * ============================================================ */
console.log('\n=== F1 · 玩家（正常态）：含新按钮 且 enabled ===');
(function () {
  var bar = RP.diceBar(mkPlayerCtx());
  var aid = findAid(bar);
  ok(!!aid, '★ 玩家 diceBar 渲染出「' + AID + '」按钮');
  ok(aid && aid.disabled === false, '★ 正常玩家：新按钮 disabled === false（可点）');
})();

console.log('\n=== F2 · KP：不含新按钮（p[2]="pl" 门控） ===');
(function () {
  var bar = RP.diceBar(mkKpCtx());
  var aid = findAid(bar);
  ok(!aid, '★ KP diceBar 不含「' + AID + '」按钮（正确被 pl 门控挡下）');
  var cust = findBtnByText(bar, '🎲 自定义骰子');
  ok(!!cust, 'KP 仍渲染出「🎲 自定义骰子」（非空渲染，门控未误伤全部）');
})();

console.log('\n=== F3 · 锁定玩家（昏迷 / 濒死 / 已撕卡 / 疯狂发作中）：新按钮 disabled ===');
[
  { label: '昏迷（unconscious 标记）', over: { status: { unconscious: true } } },
  { label: '濒死（dying 标记）', over: { status: { dying: true } } },
  { label: '已撕卡（body=死亡）', over: { status: { body: '死亡' } } },
  { label: '已撕卡（永久疯狂）', over: { mental: ['永久疯狂'] } },
  { label: '疯狂发作中（临时疯狂）', over: { mental: ['临时疯狂'] } }
].forEach(function (c) {
  var bar = RP.diceBar(mkPlayerCtx(c.over));
  var aid = findAid(bar);
  ok(!!aid, c.label + '：按钮仍渲染（能看见，只是置灰）');
  ok(aid && aid.disabled === true, '★ ' + c.label + '：新按钮 disabled === true');
  var d100 = findBtnByText(bar, 'D100');
  ok(d100 && d100.disabled === true, c.label + '：D100 同步 disabled（opLocked 贯通）');
});

console.log('\n=== F4 · 未锁定对照组：按钮与 D100 均可点 ===');
(function () {
  var bar = RP.diceBar(mkPlayerCtx({ mental: ['不定疯狂（症状消失）'] }));
  var aid = findAid(bar);
  ok(aid && aid.disabled === false, '★ 「不定疯狂（症状消失）」不算锁：新按钮 enabled');
  var d100 = findBtnByText(bar, 'D100');
  ok(d100 && d100.disabled === false, '「不定疯狂（症状消失）」：D100 enabled');
})();

console.log('\n=== F5 · 旁观者(spectator)：role!=player → 不渲染新按钮 ===');
(function () {
  var bar = RP.diceBar(mkSpecCtx());
  ok(!findAid(bar), '旁观者 diceBar 不含新按钮（role!=player 被门控）');
})();

/* ============================================================
 * G · v2.11.2 🎯 技能检定 补进真实工具栏 diceBar
 *    （此前只活在死代码 plBottomBar 里，玩家从未见过）
 * ============================================================ */
console.log('\n=== G1 · 玩家：diceBar 含「' + SKILL + '」且 enabled ===');
(function () {
  var bar = RP.diceBar(mkPlayerCtx());
  var sk = findBtnByText(bar, SKILL);
  ok(!!sk, '★ 玩家 diceBar 渲染出「' + SKILL + '」按钮（入口已补回真实工具栏）');
  ok(sk && sk.disabled === false, '★ 正常玩家：技能检定 disabled === false（可点）');
})();

console.log('\n=== G2 · KP：也有「' + SKILL + '」（未加 pl 门控，KP 可给 NPC 掷） ===');
(function () {
  var bar = RP.diceBar(mkKpCtx());
  ok(!!findBtnByText(bar, SKILL), 'KP diceBar 含「' + SKILL + '」（skillCheckSheet 对手动输入降级可用）');
})();

console.log('\n=== G3 · 锁定玩家：技能检定同步 disabled（操作锁贯通） ===');
[
  { label: '昏迷', over: { status: { unconscious: true } } },
  { label: '濒死', over: { status: { dying: true } } },
  { label: '已撕卡', over: { status: { body: '死亡' } } },
  { label: '疯狂发作中', over: { mental: ['临时疯狂'] } }
].forEach(function (c) {
  var bar = RP.diceBar(mkPlayerCtx(c.over));
  var sk = findBtnByText(bar, SKILL);
  ok(!!sk && sk.disabled === true, '★ ' + c.label + '：技能检定 disabled === true');
});

console.log('\n=== G4 · 单一事实来源：diceBar 是唯一挂载该按钮的地方 ===');
(function () {
  var src = fs.readFileSync(path.join(ROOT, 'web/js/ui/room-panels.js'), 'utf8');
  var inDice = /var extra = el\('div\.dice-extra'\);[\s\S]*?\['🎯 技能检定'/.test(src);
  ok(inDice, '★ 「🎯 技能检定」条目位于 diceBar 的 extra 数组内');
  /* plBottomBar 是死代码：不得再持有该按钮（v2.11.2 已摘除）。
     ⚠️ 只查**按钮条目**，不查裸字符串 —— 那里留有「已摘除」的说明注释，含「技能检定」四字是正常的。 */
  var plBody = src.slice(src.indexOf('function plBottomBar('), src.indexOf('/** D100 修正面板'));
  ok(plBody.indexOf("['🎯 技能检定'") < 0, '★ 死代码 plBottomBar 内不再含「技能检定」**按钮条目**（无双事实来源）');
  ok(plBody.indexOf("['⚔️ 战斗检定'") < 0, '★ 死代码 plBottomBar 内不再含「战斗检定」**按钮条目**');
})();

/* ============================================================
 * H · v2.11.2 奖惩骰互斥
 *    Bug：旧实现点「奖励骰/惩罚骰」只切 mode、不清另一侧数值
 *         → 「N 奖励 + M 惩罚」可并存，玩家不易察觉、易误判检定结果
 *    期望：切到一侧即把另一侧清 0；点「已选中」的那一侧不清空
 * ============================================================ */
console.log('\n=== H · 奖惩骰互斥（真点 chip / + 按钮，观察 eff 文案） ===');
(function () {
  var bar = RP.diceBar(mkPlayerCtx());
  var bonusChip = findBtnByText(bar, '奖励骰');
  var penaltyChip = findBtnByText(bar, '惩罚骰');
  var plusBtn = findBtnByText(bar, '+');
  var eff = findByClass(bar, 'eff')[0];
  ok(!!bonusChip && !!penaltyChip && !!plusBtn && !!eff,
     'H0 找到 奖励骰/惩罚骰/+ 按钮与 eff 展示位',
     { bonus: !!bonusChip, penalty: !!penaltyChip, plus: !!plusBtn, eff: !!eff });
  if (!eff) return;

  function effText() { return eff.textContent; }
  function bump(n) { for (var i = 0; i < n; i++) clickNode(plusBtn); }

  ok(effText() === '不修正', 'H1 初始无修正', effText());

  /* 奖励骰 +3 */
  clickNode(bonusChip); bump(3);
  ok(effText() === '奖励骰 3', 'H2 奖励骰 +3 → eff = 「奖励骰 3」', effText());

  /* 切到惩罚骰 → 奖励骰必须被清空（Bug 修复点） */
  clickNode(penaltyChip);
  ok(effText() === '不修正', '★ H3 切到惩罚骰 → 之前的 3 个奖励骰被自动清空', effText());

  /* 惩罚骰 +2 */
  bump(2);
  ok(effText() === '惩罚骰 2', 'H4 惩罚骰 +2 → eff = 「惩罚骰 2」', effText());

  /* 切回奖励骰 → 惩罚骰必须被清空 */
  clickNode(bonusChip);
  ok(effText() === '不修正', '★ H5 切回奖励骰 → 之前的 2 个惩罚骰被自动清空', effText());

  /* 点「已选中」的一侧 → 不清空（那不是切换） */
  bump(2);
  ok(effText() === '奖励骰 2', 'H6 奖励骰 +2', effText());
  clickNode(bonusChip);
  ok(effText() === '奖励骰 2', '★ H7 再点已选中的「奖励骰」→ 数值保留（不误清空）', effText());

  /* 不变量：任何时点都不出现「奖 X · 惩 Y」并存 */
  clickNode(penaltyChip); bump(1);
  ok(effText() === '惩罚骰 1', 'H8 切到惩罚骰并 +1', effText());
  ok(!/ · .*惩/.test(effText()), '★ H9 eff 永不呈现「奖 X · 惩 Y」并存', effText());
})();

/* ============================================================
 * I · v2.11.2 KP「待你确认」队列文案中文化
 *    Bug：OP_LABEL 只登记 3 条，其余走 `OP_LABEL[op] || op`
 *         → 玩家申请精神分析后，KP 只看到一行代码「aid.psycho」
 * ============================================================ */
console.log('\n=== I · KP 待确认队列文案中文化 + 富详情 ===');
[
  {
    label: '精神分析（aid.psycho）',
    q: { by: 's1', op: 'aid.psycho', p: { seat: 's1', targetSeat: 's2' }, need: 'kp', at: 0 },
    must: ['精神分析', '调查员甲', '调查员乙', '进行精神分析'],
    forbid: ['aid.psycho']
  },
  {
    label: '队友施救·医学（aid.apply）',
    q: { by: 's1', op: 'aid.apply', p: { seat: 's1', targetSeat: 's2', skill: '医学' }, need: 'kp', at: 0 },
    must: ['队友施救', '使用「医学」', '调查员甲', '调查员乙'],
    forbid: ['aid.apply']
  },
  {
    label: '队友施救·急救（aid.apply 默认技能）',
    q: { by: 's1', op: 'aid.apply', p: { seat: 's1', targetSeat: 's2', skill: '急救' }, need: 'kp', at: 0 },
    must: ['队友施救', '使用「急救」'],
    forbid: ['aid.apply']
  },
  {
    label: '治愈伤势（sheet.healwound）',
    q: { by: 's2', op: 'sheet.healwound', p: {}, need: 'kp', at: 0 },
    must: ['治愈伤势', '调查员乙'],
    forbid: ['sheet.healwound']
  },
  {
    label: '治愈不定疯狂（madness.cure）',
    q: { by: 's1', op: 'madness.cure', p: {}, need: 'kp', at: 0 },
    must: ['治愈不定疯狂', '调查员甲'],
    forbid: ['madness.cure']
  },
  {
    label: '修改自己状态（state.edit.self）',
    q: { by: 's2', op: 'state.edit.self', p: { hp: 3 }, need: 'kp', at: 0 },
    must: ['修改自己的状态'],
    forbid: ['state.edit.self']
  },
  {
    label: '未登记 op（兜底不再裸奔，且能定位到发起者）',
    q: { by: 's1', op: 'some.unknown.op', p: {}, need: 'twice', at: 0 },
    must: ['待确认操作（some.unknown.op）', '发起者：调查员甲'],
    forbid: []
  },
  {
    label: '未登记 op 且无发起者信息（回退高危提示）',
    q: { by: '', op: 'some.unknown.op', p: {}, need: 'twice', at: 0 },
    must: ['待确认操作（some.unknown.op）', '高危操作，需二次确认'],
    forbid: []
  }
].forEach(function (c) {
  var panel = RP.kpPanel(mkKpPendingCtx([c.q]));
  var txt = allText(panel);
  c.must.forEach(function (m) { ok(txt.indexOf(m) >= 0, '★ [' + c.label + '] 含中文说明「' + m + '」'); });
  c.forbid.forEach(function (f) {
    ok(txt.indexOf(f) < 0, '★ [' + c.label + '] 不再裸显示代码「' + f + '」');
  });
});

/* ---------------- 汇总 ---------------- */
console.log('\n' + '='.repeat(58));
if (fail) { console.log('失败项：'); failures.forEach(function (f) { console.log('  [FAIL] ' + f); }); }
console.log('qa_v2110_dicebar: ' + pass + ' passed, ' + fail + ' failed');
console.log('RESULT: ' + (fail ? 'FAIL' : 'PASS'));
process.exitCode = fail ? 1 : 0;
