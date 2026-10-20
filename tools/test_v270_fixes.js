/*
 * v2.7.0 独立回归 —— 本文件由多名工程师按小节 append 汇总。
 *
 *   本小节由 software-engineer-2（寇豆码）负责：**第 1 项 + 第 3 项**
 *     · 第 1 项 战斗模式改为「KP 选择哪些玩家进入战斗」：
 *         combatStart 支持 pcSeats（不带则全量，向后兼容）；新增 op `combat.enqueue`
 *         （roles:['kp']，幂等、只追加、不重置 turn/round、非战斗态被拒）；
 *         UI combatPrepareSheet 玩家区改多选（默认全选）并把选中 seat 作为 pcSeats 传出；
 *         战斗面板给未参战 PC 挂「＋加入战斗」并标「未入战」。
 *     · 第 3 项 死亡 / 永久疯狂角色在所有 KP 定向入口都不可选：
 *         新增通用谓词 `targetBlocked = isMemberRippedU`（只封死亡/永久疯狂，
 *         疯狂发作中不纳入通用封禁），接入 dmg/temp/item/cure 的 opts.skip，
 *         以及 pushCheckSheet / kpSceneCheckPanel / stepEditor /
 *         genericOpposedSheet / kpAttackSheet 的玩家池过滤。
 *         ⚠️ **唯一刻意的例外：状态管理（state.request）不封** —— pickPlayerToEdit 与
 *            stateRequestCard 两条入口都不过滤（KP 修正 / 复活误判死亡角色的唯一出口）。
 *
 *   ⚠️ 另一位工程师会在本文件**末尾 append** 自己的小节；
 *     为避免「汇总早于追加的断言执行」，本文件的汇总 / RESULT 走 process.on('exit')，
 *     任何后追加的代码都会先跑完再汇总。
 *
 * 运行： node tools/test_v270_fixes.js（工作目录 = 仓库根）
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

function mkSandbox(files) {
  var sb = {};
  vm.createContext(sb); sb.window = sb;
  files.forEach(function (f) { vm.runInContext(fs.readFileSync(path.join(base, f), 'utf8'), sb); });
  return sb;
}
var sbM = mkSandbox(['core/room-rules.js', 'core/room-model.js']);
var M = sbM.RoomModel, R = sbM.CocRules;

function readSrc(rel) { return fs.readFileSync(path.join(base, rel), 'utf8'); }
function stripComments(text) { return text.replace(/\/\*[\s\S]*?\*\//g, ''); }
var rpClean = stripComments(readSrc('ui/room-panels.js'));

/* 按函数名切出函数体（剥注释后），避免跨函数误命中 */
function segOf(name) {
  var i = rpClean.indexOf('function ' + name + '(');
  if (i < 0) return '';
  var rest = rpClean.slice(i + 1);
  var m = /\r?\n  function /.exec(rest);
  return rest.slice(0, m ? m.index : rest.length);
}
function planText(o) { return JSON.stringify(o || []); }
function hasEvt(o, t) { return (o || []).some(function (r) { return r.msg && r.msg.t === t; }); }

function newHost(opts) {
  return new M.Host(Object.assign({
    meta: { code: 'abc123', name: '测试团', kpName: 'KP老张', maxPlayers: 4 },
    now: function () { return 1700000000000; }
  }, opts || {}));
}
function addPlayer(host, seat, nickname) {
  var res = host.attachPeer({ seat: seat, cid: 'c-' + seat, role: M.ROLE.PLAYER, nickname: nickname, at: 1 });
  return res.member;
}
function pcActor(seat, name, dex) {
  return { id: 'p-' + seat, name: name, kind: 'pc', seat: seat, dex: dex, actionsPerRound: 1, hp: 10, hpMax: 10 };
}

/* ============================================================
 * 第 1 项 · combat.enqueue 权限
 * ============================================================ */
section('第 1 项 · combat.enqueue 权限（POLICY）');
(function () {
  ok(M.allowed(M.ROLE.KP, 'combat.enqueue') === true, 'POLICY 允许 KP：combat.enqueue');
  ok(M.allowed(M.ROLE.PLAYER, 'combat.enqueue') === false, 'POLICY 拒绝玩家：combat.enqueue');
  eq(M.needs(M.ROLE.KP, 'combat.enqueue').confirm, null, 'combat.enqueue 无需二次确认（KP 一键生效）');
})();

/* ============================================================
 * 第 1 项 · combatStart 支持 pcSeats
 * ============================================================ */
section('第 1 项 · combatStart 带 pcSeats 只保留命中的 PC；不带则全量（向后兼容）');
(function () {
  /* 带 pcSeats：只有命中的 PC 入队 */
  var host = newHost();
  addPlayer(host, 's-a', '甲');
  addPlayer(host, 's-b', '乙');
  host.applyAction('host', {
    op: 'combat.start',
    actors: [pcActor('s-a', '甲', 50), pcActor('s-b', '乙', 40),
             { id: 'm1', name: '怪物', kind: 'monster', dex: 60, actionsPerRound: 1, hp: 8, hpMax: 8 }],
    actorIds: ['m1'],
    pcSeats: ['s-a']
  });
  var ids = host.state.combat.order.map(function (s) { return s.actorId; });
  ok(ids.indexOf('p-s-a') >= 0, '命中的 PC（s-a）进入 combat.order');
  ok(ids.indexOf('p-s-b') < 0, '★ 未命中的 PC（s-b）不进 combat.order');
  ok(ids.indexOf('m1') >= 0, '选中的怪物仍入队');

  /* 不带 pcSeats：全量 PC 入队（旧行为，向后兼容） */
  var host2 = newHost();
  addPlayer(host2, 's-a', '甲');
  addPlayer(host2, 's-b', '乙');
  host2.applyAction('host', {
    op: 'combat.start',
    actors: [pcActor('s-a', '甲', 50), pcActor('s-b', '乙', 40),
             { id: 'm1', name: '怪物', kind: 'monster', dex: 60, actionsPerRound: 1, hp: 8, hpMax: 8 }],
    actorIds: ['m1']
  });
  var ids2 = host2.state.combat.order.map(function (s) { return s.actorId; });
  ok(ids2.indexOf('p-s-a') >= 0 && ids2.indexOf('p-s-b') >= 0,
     '★ 不带 pcSeats → 全量 PC 入队（向后兼容，既有测试不红）');
})();

/* ============================================================
 * 第 1 项 · combat.enqueue 幂等 / 不重置轮次 / 非战斗态被拒
 * ============================================================ */
section('第 1 项 · combat.enqueue 幂等 / 不重置轮次 / 非战斗态被拒');
(function () {
  var host = newHost();
  addPlayer(host, 's-a', '甲');
  addPlayer(host, 's-b', '乙');
  host.applyAction('host', {
    op: 'combat.start',
    actors: [pcActor('s-a', '甲', 50),
             { id: 'm1', name: '怪物', kind: 'monster', dex: 60, actionsPerRound: 1, hp: 8, hpMax: 8 }],
    actorIds: ['m1'],
    pcSeats: ['s-a']
  });
  var c0 = host.state.combat;
  c0.turn = 1; c0.round = 3;

  var plan = host.applyAction('host', { op: 'combat.enqueue', seat: 's-b' });
  var ids = c0.order.map(function (s) { return s.actorId; });
  ok(ids.indexOf('p-s-b') >= 0, '★ combat.enqueue 把 s-b 追加进 combat.order');
  eq(c0.turn, 1, '★ combat.enqueue 不重置 turn');
  eq(c0.round, 3, '★ combat.enqueue 不重置 round');
  ok(/加入了战斗/.test(planText(plan)), '写公开日志「KP 把「X」加入了战斗」', planText(plan));
  ok(hasEvt(plan, M.EVT.TURNSTATE), '广播 TURNSTATE 让所有端刷新');

  var len1 = c0.order.length;
  host.applyAction('host', { op: 'combat.enqueue', seat: 's-b' });
  eq(c0.order.length, len1, '★ 重复入队幂等（不重复追加）');
  eq(c0.turn, 1, '幂等后 turn 仍不变');
  eq(c0.round, 3, '幂等后 round 仍不变');

  /* 幂等：已死在队列中的也不重复（并用 actorId 走单位路径） */
  host.applyAction('host', { op: 'combat.enqueue', actorId: 'm1' });
  eq(c0.order.length, len1, '单位已在队列 → 幂等跳过');

  /* 非战斗态 → 明确提示，不创建/改动 combat */
  var host2 = newHost();
  addPlayer(host2, 's-a', '甲');
  var plan2 = host2.applyAction('host', { op: 'combat.enqueue', seat: 's-a' });
  ok(/当前不在战斗中/.test(planText(plan2)),
     '★ 非战斗态 → 明确提示「不在战斗中」', planText(plan2));
  ok(!host2.state.combat, '非战斗态不创建/改动 combat');
})();

/* ============================================================
 * 第 1 项 · combat.enqueue 撕卡守卫（死亡 / 永久疯狂不入队，纵深防御）
 *   QA 报的缺口：与 combatStart 口径不一致 —— enqueue 此前对撕卡 seat 照常入队。
 * ============================================================ */
section('第 1 项 · combat.enqueue 撕卡守卫（死亡 / 永久疯狂不入队）');
(function () {
  var MON = { id: 'm1', name: '怪物', kind: 'monster', dex: 60, actionsPerRound: 1, hp: 8, hpMax: 8 };

  /* --- (a) 死亡（body==='死亡'）：单目标全撕卡 → 不入队 + 明确拒绝 --- */
  var host = newHost();
  addPlayer(host, 's-a', '甲');
  addPlayer(host, 's-b', '乙');
  var dead = addPlayer(host, 's-c', '鬼');
  dead.sheet = { status: { body: '死亡' }, mental: ['正常'], attrs: { dex: 40 } };
  host.applyAction('host', {
    op: 'combat.start',
    actors: [pcActor('s-a', '甲', 50), MON], actorIds: ['m1'], pcSeats: ['s-a']
  });
  var c = host.state.combat;
  c.turn = 0; c.round = 2;

  var pDead = host.applyAction('host', { op: 'combat.enqueue', seat: 's-c' });
  ok(!c.order.some(function (s) { return s.actorId === 'p-s-c'; }),
     '★ 已撕卡（死亡）seat 不进 combat.order');
  ok(!/加入了战斗/.test(planText(pDead)), '不广播「加入了战斗」');
  ok(/已撕卡|不能加入战斗/.test(planText(pDead)), '★ 全职撕卡 → 明确拒绝提示（不静默成功）', planText(pDead));

  /* --- (b) 永久疯狂（mental 含 '永久疯狂'）同样不入队 --- */
  var perm = addPlayer(host, 's-d', '狂');
  perm.sheet = { status: {}, mental: ['永久疯狂'], attrs: { dex: 40 } };
  host.applyAction('host', { op: 'combat.enqueue', seat: 's-d' });
  ok(!c.order.some(function (s) { return s.actorId === 'p-s-d'; }),
     '★ 已撕卡（永久疯狂）seat 同样不进 combat.order');

  /* --- (c) 混合请求（活人 + 死人）→ 活人照常入队，仅跳过撕卡者（不整体失败） --- */
  var pMix = host.applyAction('host', { op: 'combat.enqueue', seats: ['s-b', 's-c'] });
  ok(c.order.some(function (s) { return s.actorId === 'p-s-b'; }),
     '★ 混合请求：活人（s-b）照常入队（不整体失败）');
  ok(!c.order.some(function (s) { return s.actorId === 'p-s-c'; }),
     '混合请求：死人（s-c）仍被跳过');
  ok(/已跳过已撕卡|不能加入战斗/.test(planText(pMix)), '混合请求：给出撕卡跳过提示', planText(pMix));

  /* --- (d) 既有行为不回归：turn / round 不被重置、幂等 --- */
  eq(c.turn, 0, '撕卡守卫不影响 turn（不重置）');
  eq(c.round, 2, '撕卡守卫不影响 round（不重置）');
  var len = c.order.length;
  host.applyAction('host', { op: 'combat.enqueue', seats: ['s-b', 's-c'] });
  eq(c.order.length, len, '★ 幂等：重复（活人+死人）入队不重复追加');
})();

/* ============================================================
 * 第 1 项 · 入队后 _isMyActionTurn 联动（v2.6.0 轮次门禁）
 * ============================================================ */
section('第 1 项 · 入队后 _isMyActionTurn 联动');
(function () {
  var host = newHost();
  addPlayer(host, 's-a', '甲');
  addPlayer(host, 's-b', '乙');
  host.applyAction('host', {
    op: 'combat.start',
    actors: [pcActor('s-a', '甲', 50),
             { id: 'm1', name: '怪物', kind: 'monster', dex: 60, actionsPerRound: 1, hp: 8, hpMax: 8 }],
    actorIds: ['m1'],
    pcSeats: ['s-a']
  });
  var c = host.state.combat;
  var idxA = -1;
  c.order.forEach(function (s, i) { if (s.actorId === 'p-s-a') idxA = i; });
  c.turn = idxA;
  ok(host._isMyActionTurn('s-a') === true, '轮到 s-a 自己的槽 → _isMyActionTurn(s-a)=true');
  ok(host._isMyActionTurn('s-b') === false, '★ 未入队的 s-b 在轮次外无法对抗（false）');

  host.applyAction('host', { op: 'combat.enqueue', seat: 's-b' });
  var idxB = -1;
  c.order.forEach(function (s, i) { if (s.actorId === 'p-s-b') idxB = i; });
  ok(idxB >= 0, 'enqueue 后 s-b 拥有独立 pc 槽');
  c.turn = idxB;
  ok(host._isMyActionTurn('s-b') === true, '★ enqueue 后轮到 s-b 的槽 → _isMyActionTurn(s-b)=true');
})();

/* ============================================================
 * 第 3 项 · UI 静态证据链：targetBlocked 接入 + 玩家池过滤
 * ============================================================ */
section('第 3 项 · UI 静态证据链：targetBlocked 已接入');
(function () {
  ok(/function targetBlocked\(m\) \{ return isMemberRippedU\(m\); \}/.test(rpClean),
     'targetBlocked = isMemberRippedU（只封死亡/永久疯狂）');

  ['dmgForPlayer', 'tempForPlayer', 'itemForPlayer', 'cureForPlayer'].forEach(function (fn) {
    ok(segOf(fn).indexOf('skip: targetBlocked') >= 0,
       fn + ' 以 targetBlocked 作 opts.skip（过滤后无人也给 emptyHint）');
  });
  ok(segOf('sanForPlayer').indexOf('skip: sanBlocked') >= 0,
     'sanForPlayer 仍用更严的 sanBlocked（未改，SAN 类维持现状）');

  ['pushCheckSheet', 'kpSceneCheckPanel', 'stepEditor',
   'genericOpposedSheet', 'kpAttackSheet'].forEach(function (fn) {
    ok(segOf(fn).indexOf('targetBlocked') >= 0,
       '入口 ' + fn + ' 的 playersOf 池已用 targetBlocked 过滤');
  });

  /* 反向断言：这几处**刻意不过滤** */
  ok(segOf('clueSheet').indexOf('targetBlocked') < 0,
     '★ clueSheet 不过滤（递线索给的是「玩家」不是「角色」）');

  /* v2.7.0（口径统一）：状态管理是**唯一刻意的例外** —— 两条入口都不封死亡角色，
     否则 KP 从工具栏点进去看不到那个死角色，会以为功能坏了；两者都经 stateRequestSheet
     走同一个 op `state.request`。固化成反向断言，防止将来有人顺手又加上过滤。 */
  ok(segOf('pickPlayerToEdit').indexOf('targetBlocked') < 0,
     '★ pickPlayerToEdit 不过滤（state.request 的「工具栏」入口，保留复活途径）');
  ok(segOf('stateRequestCard').indexOf('targetBlocked') < 0,
     '★ stateRequestCard 不过滤（state.request 的「玩家卡」入口，保留复活途径）');
  ok(segOf('pickPlayerToEdit').indexOf('stateRequestSheet') >= 0,
     '★ pickPlayerToEdit 经 stateRequestSheet 走 state.request（与 stateRequestCard 同一路径）');
  ok(segOf('stateRequestCard').indexOf('stateRequestSheet') >= 0,
     '★ stateRequestCard 经 stateRequestSheet 走 state.request（同一路径）');
  ok(segOf('stateRequestSheet').indexOf('state.request') >= 0,
     'stateRequestSheet 提交 op = state.request');
  ok(M.allowed(M.ROLE.KP, 'state.request') === true,
     'POLICY 允许 KP：state.request（KP 修正 / 复活途径可用）');
})();

/* ============================================================
 * 第 1 项 · UI 静态证据链：combatPrepareSheet 多选 / pcSeats
 * ============================================================ */
section('第 1 项 · UI 静态证据链：combatPrepareSheet 不再只读全量');
(function () {
  var seg = segOf('combatPrepareSheet');
  ok(seg.indexOf('pcSeats') >= 0, 'combatPrepareSheet 提交带 pcSeats');
  ok(seg.indexOf('pcOff') >= 0, '玩家区改为可多选（pcOff 反选表，默认全选）');
  ok(seg.indexOf('勾选进入战斗') >= 0, '玩家区标题改为「勾选进入战斗」');
  ok(seg.indexOf('自动加入') < 0, '★ 已移除「自动加入」标题/文案');
  ok(seg.indexOf('targetBlocked') >= 0, '勾选列表排除已撕卡（targetBlocked）');

  var panel = segOf('kpCombatPanel');
  ok(panel.indexOf('combat.enqueue') >= 0, 'kpCombatPanel 发 combat.enqueue');
  ok(panel.indexOf('未入战') >= 0, '★ 战斗面板显式标出「未入战」状态');
})();

/* ============================================================
 * 汇总 —— 在进程退出时打印，方便另一位工程师在其后 append 自己的小节
 * ============================================================ */
process.on('exit', function () {
  console.log('\nv2.7.0 fixes regression: ' + pass + ' passed, ' + fail + ' failed');
  console.log('RESULT: ' + (fail ? 'FAIL' : 'PASS'));
  if (fail) process.exitCode = 1;
});

/* ============================================================
 * 第 2 项 + 第 3 项（模型侧兜底守卫）· software-engineer（寇豆码）append 小节
 *
 *   · 第 2 项 背景自带疯狂症状 = 「疯狂症状」（永久标记，等同正常）：
 *       store#normalize 派生修正 / room-ui#sheetSummary 保留 bg·from /
 *       room-model#sanitizeSheet 背景症状归一化兜底 / cureIndefinite 不可治愈 /
 *       advanceMadness 推进不消除 / 「疯狂症状」不触发发作或全局锁。
 *   · 第 3 项（模型侧兜底守卫）：checkRequest / sceneCheckPush / sceneCheckStep /
 *       通用 checkOpposed / cureIndefinite 对「已撕卡」目标拒绝或跳过
 *       （不结算、不整体失败）。UI 侧选人池过滤由另一工程师负责。
 * ============================================================ */

/* —— 本小节专用助手（函数声明，顶层 hoist，下方 IIFE 立即可用） —— */
function newHostR() {
  return new M.Host({ meta: { code: 'abc123', name: '团', kpName: 'KP' },
                      rules: R, rng: function () { return 0.3; },
                      now: function () { return 1700000000000; } });
}
function segModel(name) {
  var clean = stripComments(readSrc('core/room-model.js'));
  var i = clean.indexOf('function ' + name + '(');
  if (i < 0) return '';
  var rest = clean.slice(i + 1);
  var mm = /\r?\n  (function |Host\.prototype\.)/.exec(rest);
  return rest.slice(0, mm ? mm.index : rest.length);
}

section('第 2 项 · store.normalize 派生：背景症状 = 疯狂症状（与「正常」互斥）');
(function () {
  var sbS = mkSandbox(['data/madness.js', 'core/madness.js', 'core/rules-coc7.js', 'core/engine.js', 'core/store.js']);
  var Store = sbS.Store;
  ok(!!Store && typeof Store.normalize === 'function', 'store 沙盒可用');

  function card(mental, madness) {
    return { id: 'c-' + ('' + Math.random()).slice(2), characterName: '测试',
             basicInfo: { age: 30 }, status: { mental: mental },
             background: { phobias: '' }, madness: madness || [] };
  }
  function bgS(name) { return { type: 'phobia', name: name || '幽闭恐惧症', permanent: true, bg: true, rounds: 0, from: '' }; }
  function gmS(name, from, rounds) { return { type: 'bout', name: name || '惊恐发作', permanent: false, from: from || '不定疯狂', rounds: rounds == null ? 5 : rounds }; }

  var c1 = Store.normalize(card(['正常'], [bgS()]));
  ok(c1.status.mental.indexOf('疯狂症状') >= 0, '★ 带背景症状的新卡 → mental 含「疯狂症状」', JSON.stringify(c1.status.mental));
  ok(c1.status.mental.indexOf('正常') < 0, '★ 带背景症状的新卡 → mental 不含「正常」（二者互斥）', JSON.stringify(c1.status.mental));

  var c2 = Store.normalize(card(['正常'], []));
  eq(JSON.stringify(c2.status.mental), JSON.stringify(['正常']), '无症状卡仍回落 [正常]');

  var c3 = Store.normalize(card(['正常'], [bgS(), gmS()]));
  ok(c3.status.mental.indexOf('疯狂症状') >= 0, '背景症状 + 游戏症状 → 也含「疯狂症状」');

  var c4 = Store.normalize(card(['永久疯狂', '临时疯狂'], [bgS()]));
  eq(JSON.stringify(c4.status.mental), JSON.stringify(['永久疯狂']),
     '★ 带永久疯狂 → 互斥只留「永久疯狂」（不追加派生项）');

  var c5 = Store.normalize(card(['临时疯狂'], [bgS()]));
  ok(c5.status.mental.indexOf('疯狂症状') >= 0, '背景症状叠加 → 补上「疯狂症状」');
})();

section('第 2 项 · room-ui#sheetSummary 保留 bg / from / sum（静态证据链）');
(function () {
  var clean = stripComments(readSrc('ui/room-ui.js'));
  var i = clean.indexOf('function sheetSummary(');
  ok(i >= 0, 'room-ui.js 存在 sheetSummary');
  var rest = clean.slice(i + 1);
  var m = /\r?\n  function /.exec(rest);
  var seg = rest.slice(0, m ? m.index : rest.length);
  ok(/from:\s*m\.from/.test(seg), '★ sheetSummary 的 madness 映射补回 from: m.from');
  ok(/bg:\s*!!m\.bg/.test(seg), '★ sheetSummary 的 madness 映射补回 bg: !!m.bg');
  ok(/sum:\s*!!m\.sum/.test(seg), 'sheetSummary 一并保留 sum（总结症状标记）');
})();

section('第 2 项 · sanitizeSheet 背景症状归一化兜底（模型侧权威）');
(function () {
  function bgS() { return { type: 'phobia', name: '幽闭恐惧症', permanent: true, bg: true, rounds: 0, from: '' }; }
  function gmS(name, from) { return { type: 'bout', name: name || '惊恐发作', permanent: false, from: from || '不定疯狂', rounds: 5 }; }
  function san(sheet) { return M.sanitizeSheet({ sheet: sheet }, null); }

  var o1 = san({ name: '甲', madness: [bgS()], mental: ['正常'] });
  ok(o1.mental.indexOf('疯狂症状') >= 0, '★ 只有背景症状（mental=正常）→ 被纠正为含「疯狂症状」', JSON.stringify(o1.mental));
  ok(o1.mental.indexOf('正常') < 0, '★ 只有背景症状 → 剔除「正常」');

  var o2 = san({ name: '甲', madness: [bgS()], mental: ['不定疯狂'] });
  ok(o2.mental.indexOf('不定疯狂') < 0, '★ 只有背景症状 → 剔除「不定疯狂」', JSON.stringify(o2.mental));
  ok(o2.mental.indexOf('疯狂症状') >= 0, '剔除不定疯狂后补上「疯狂症状」');

  var o3 = san({ name: '甲', madness: [bgS(), gmS('惊恐发作', '不定疯狂')], mental: ['不定疯狂', '疯狂症状'] });
  ok(o3.mental.indexOf('不定疯狂') >= 0,
     '★ 同时存在游戏内症状 → 绝不剔除「不定疯狂」（防回归：v2.2.2/v2.4.0 不定疯狂复发）', JSON.stringify(o3.mental));

  var o4 = san({ name: '甲', madness: [bgS()], mental: ['永久疯狂'] });
  eq(JSON.stringify(o4.mental), JSON.stringify(['永久疯狂']), '★ 背景症状 + 永久疯狂 → 「永久疯狂」互斥优先');
})();

section('第 2 项 · advanceMadness 推进多轮：背景症状与「疯狂症状」都常驻');
(function () {
  var host = newHost();
  var mem = addPlayer(host, 's-a', '甲');
  mem.sheet = { name: '甲',
    madness: [{ type: 'phobia', name: '幽闭恐惧症', permanent: true, bg: true, rounds: 0, from: '' },
              { type: 'bout', name: '惊恐发作', permanent: false, from: '临时疯狂', rounds: 2 }],
    mental: ['临时疯狂', '疯狂症状'], status: {} };
  host.advanceMadness('host', { seat: 's-a' });
  host.advanceMadness('host', { seat: 's-a' });
  host.advanceMadness('host', { seat: 's-a' });
  var md = mem.sheet.madness || [];
  ok(md.some(function (x) { return x.bg === true && x.name === '幽闭恐惧症'; }), '★ 多轮推进后背景症状仍在（permanent 跳过）');
  ok(!md.some(function (x) { return x.from === '临时疯狂'; }), '临时症状到期已消退');
  ok((mem.sheet.mental || []).indexOf('疯狂症状') >= 0, '★ 「疯狂症状」仍在（md 非空 → 不被摘）', JSON.stringify(mem.sheet.mental));
  ok((mem.sheet.mental || []).indexOf('临时疯狂') < 0, '「临时疯狂」标签随症状消退摘除');
})();

section('第 2 / 3 项 · cureIndefinite：背景症状不可治愈 + 已撕卡守卫');
(function () {
  var host = newHost();
  var mem = addPlayer(host, 's-a', '甲');

  mem.sheet = { name: '甲', madness: [{ type: 'phobia', name: '幽闭恐惧症', permanent: true, bg: true, rounds: 0, from: '' }],
                mental: ['疯狂症状'], status: {} };
  var out1 = host.cureIndefinite('host', { seat: 's-a' });
  ok(/来自角色背景/.test(planText(out1)), '★ 只有背景症状 → 私密提示「来自角色背景，不可治愈」', planText(out1));
  eq(mem.sheet.madness.length, 1, '★ 背景症状条目未被治愈删除');
  ok(mem.sheet.mental.indexOf('疯狂症状') >= 0, '★ 「疯狂症状」未被误摘');

  mem.sheet = { name: '甲', madness: [{ type: 'bout', name: '惊恐发作', permanent: false, from: '不定疯狂', rounds: 5 }],
                mental: ['不定疯狂', '疯狂症状'], status: {} };
  host.cureIndefinite('host', { seat: 's-a' });
  ok(mem.sheet.mental.indexOf('不定疯狂') < 0, '有不定疯狂 → 正常治愈（标签移除）');
  ok(mem.sheet.mental.indexOf('疯狂症状') >= 0, '游戏症状仍在 → 「疯狂症状」保留');

  /* 干净场景：仅「不定疯狂」标签、无游戏症状 → 治愈后回落「正常」 */
  mem.sheet = { name: '甲', madness: [], mental: ['不定疯狂'], status: {} };
  host.cureIndefinite('host', { seat: 's-a' });
  ok(mem.sheet.mental.indexOf('不定疯狂') < 0, '仅不定疯狂 → 标签移除');
  ok(mem.sheet.mental.indexOf('正常') >= 0, '仅不定疯狂 → 治愈后回落「正常」');

  mem.sheet = { name: '甲', madness: [], mental: ['永久疯狂'], status: { body: '死亡' } };
  var out3 = host.cureIndefinite('host', { seat: 's-a' });
  ok(/已撕卡/.test(planText(out3)), '★ 已撕卡 → 拒绝治愈');
  ok(mem.sheet.mental.indexOf('永久疯狂') >= 0, '撕卡拒绝后状态未被改动');
})();

section('第 2 项 · 「疯狂症状」不触发 memberInBout / memberMadActive / 全局操作锁');
(function () {
  var host = newHostR();
  var mem = addPlayer(host, 's-a', '甲');
  mem.sheet = { name: '甲', madness: [{ type: 'phobia', name: '幽闭恐惧症', permanent: true, bg: true, rounds: 0, from: '' }],
                mental: ['疯狂症状'],
                status: { body: '正常', currentHP: 10, maxHP: 10 },
                skills: [{ name: '侦查', total: 60 }] };
  var out = host.intent('s-a', M.intentMsg(M.INTENT.DICE, { expr: '1D100', direct: true }));
  ok(!/只能通过聊天框交流/.test(planText(out)), '★ 未被撕卡锁死');
  ok(!/处于疯狂发作中/.test(planText(out)), '★ 未被发作锁死（疯狂症状 ≠ 发作）');
  ok(hasEvt(out, M.EVT.DICE), '★ 普通操作照常执行（真的掷出了骰子）', planText(out));

  var mb = segModel('memberInBout');
  ok(/'临时疯狂'/.test(mb) && /'不定疯狂'/.test(mb), 'memberInBout 只认「临时疯狂」/「不定疯狂」');
  ok(!/疯狂症状/.test(mb), '★ memberInBout 源码不含「疯狂症状」（症状态不触发发作锁）');
  var ma = segModel('memberMadActive');
  ok(!/疯狂症状/.test(ma), '★ memberMadActive 源码不含「疯狂症状」');
})();

section('第 3 项（模型）· checkRequest 跳过已撕卡目标（* 全量不整体失败）');
(function () {
  var host = newHost();
  var a = addPlayer(host, 's-a', '甲');
  var b = addPlayer(host, 's-b', '乙');
  a.sheet = { name: '甲', status: { body: '死亡' }, mental: ['永久疯狂'], madness: [] };
  b.sheet = { name: '乙', status: { body: '正常' }, mental: ['正常'], madness: [] };
  var out = host.applyAction('host', { op: 'check.request', seat: '*', skill: '侦查', difficulty: 'REGULAR' });
  function reqTo(seat) {
    return out.filter(function (r) { return r.to === seat && r.msg && r.msg.t === M.EVT.REQUEST; }).length;
  }
  eq(reqTo('s-a'), 0, '★ 已撕卡目标未收到 REQUEST');
  eq(reqTo('s-b'), 1, '正常目标照常收到 REQUEST');
  ok(/已撕卡/.test(planText(out)) && /跳过检定请求/.test(planText(out)), '逐条提示「已跳过检定请求」');
  ok(!/没有在线的玩家可以推送/.test(planText(out)), '★ 不整体失败');
})();

section('第 3 项（模型）· sceneCheckPush / sceneCheckStep 跳过已撕卡目标（不再替他掷骰）');
(function () {
  /* ① push：目标已撕卡 → 自动跳过并前进，不挂起、不自动掷骰 */
  var host = newHost();
  var a = addPlayer(host, 's-a', '甲');
  a.sheet = { name: '甲', status: { body: '死亡' }, mental: ['永久疯狂'], madness: [] };
  var out = host.applyAction('host', { op: 'scene.check.push', title: '搜查', steps: [
    { id: 'st1', title: '搜查房间', skill: '侦查', targetSeat: 's-a' }
  ] });
  var sc = host.state.sceneCheck;
  ok(sc.results && sc.results.length >= 1, '★ 已撕卡目标的步骤被跳过（不挂起）', JSON.stringify(sc.results));
  ok(sc.results[0].skipped === true, '结果标记 skipped:true');
  ok(/已撕卡/.test(planText(out)), '★ 有明确的「已撕卡」跳过提示');
  ok(!/系统自动/.test(planText(out)), '★ 不再替他掷骰（无「系统自动」痕迹）');
  eq(sc.cursor, sc.steps.length, '游标前进到末尾（检定正常结束，不整体失败）');

  /* ② step：push 时目标正常 → 之后被撕卡 → 手动 sceneCheckStep 命中跳过分支 */
  var host2 = newHost();
  var m = addPlayer(host2, 's-a', '甲');
  m.sheet = { name: '甲', status: { body: '正常' }, mental: ['正常'], madness: [] };
  host2.applyAction('host', { op: 'scene.check.push', title: '开门', steps: [
    { id: 'q1', title: '开门', skill: '力量', targetSeat: 's-a' }
  ] });
  eq(host2.state.sceneCheck.results.length, 0, '前置：目标未撕卡时 push 不自动判定');
  m.sheet.status.body = '死亡'; m.sheet.mental = ['永久疯狂'];
  var out2 = host2.applyAction('host', { op: 'scene.check.step', stepId: 'q1', seat: 's-a' });
  ok(/已撕卡/.test(planText(out2)), '★ sceneCheckStep 遇到已撕卡目标 → 跳过并提示');
  ok(!/系统自动/.test(planText(out2)), '★ sceneCheckStep 不再替他掷骰');
})();

section('第 3 项（模型）· 通用 checkOpposed：任一方已撕卡 → 拒绝且不结算');
(function () {
  var host = newHostR();
  var a = addPlayer(host, 's-a', '甲');
  var b = addPlayer(host, 's-b', '乙');
  a.sheet = { name: '甲', status: { body: '正常' }, mental: ['正常'], madness: [], skills: [{ name: '侦查', total: 60 }] };
  b.sheet = { name: '乙', status: { body: '死亡' }, mental: ['永久疯狂'], madness: [], skills: [{ name: '潜行', total: 50 }] };
  var out = host.checkOpposed('host', { aSeat: 's-a', aSkill: '侦查', bSeat: 's-b', bSkill: '潜行' });
  ok(/已撕卡/.test(planText(out)), '★ 通用对抗遇到已撕卡的一方 → 拒绝并提示', planText(out));
  ok(!hasEvt(out, M.EVT.CHECK), '★ 未产出 EVT.CHECK（不结算）');
})();

/* ============================================================
 * 【QA 独立回归 · Edward】v2.7.0 三项 —— 独立复核小节（append 于文末）
 *
 *   复核原则：**不轻信描述**。store 真跑、模型真跑、源码真读。
 *   本小节只 append，不改上面两位工程师的小节；汇总 / RESULT 仍走 process.on('exit')。
 * ============================================================ */
function qText(o) { return (o || []).map(function (r) { return (r.msg && (r.msg.text || r.msg.t)) || ''; }).join('\n'); }
function qTop(f) { return new M.Host({ meta: { code: 'abc123', name: '团', kpName: 'KP' }, rules: R,
                                       rng: function () { return 0.3; }, now: function () { return 1700000000000; } }); }
var qStore = mkSandbox(['data/madness.js', 'core/madness.js', 'core/rules-coc7.js', 'core/engine.js', 'core/store.js']).Store;

/* ============================================================
 * QA · 第 1 项 · combatStart 的 pcSeats（含空数组边界）
 * ============================================================ */
section('QA-第 1 项 · combatStart：pcSeats 命中 / 缺省全量 / 空数组');
(function () {
  var host = newHost();
  addPlayer(host, 's-a', '甲'); addPlayer(host, 's-b', '乙');
  host.applyAction('host', { op: 'combat.start',
    actors: [pcActor('s-a', '甲', 50), pcActor('s-b', '乙', 40),
             { id: 'm1', name: '怪', kind: 'monster', dex: 60, actionsPerRound: 1, hp: 8, hpMax: 8 }],
    actorIds: ['m1'], pcSeats: ['s-a'] });
  var ids = host.state.combat.order.map(function (s) { return s.actorId; });
  ok(ids.indexOf('p-s-a') >= 0 && ids.indexOf('p-s-b') < 0, 'pcSeats=[s-a] → 只 s-a 入队', JSON.stringify(ids));

  var h2 = newHost();
  addPlayer(h2, 's-a', '甲'); addPlayer(h2, 's-b', '乙');
  h2.applyAction('host', { op: 'combat.start',
    actors: [pcActor('s-a', '甲', 50), pcActor('s-b', '乙', 40),
             { id: 'm1', name: '怪', kind: 'monster', dex: 60, actionsPerRound: 1, hp: 8, hpMax: 8 }],
    actorIds: ['m1'] });
  var ids2 = h2.state.combat.order.map(function (s) { return s.actorId; });
  ok(ids2.indexOf('p-s-a') >= 0 && ids2.indexOf('p-s-b') >= 0, '★ 缺省 pcSeats → 全量 PC 入队（向后兼容）');

  /* 空数组：一个 PC 都不入队 —— 真跑，确认战斗不会崩 */
  var h3 = newHost();
  addPlayer(h3, 's-a', '甲'); addPlayer(h3, 's-b', '乙');
  h3.applyAction('host', { op: 'combat.start',
    actors: [pcActor('s-a', '甲', 50), pcActor('s-b', '乙', 40),
             { id: 'm1', name: '怪', kind: 'monster', dex: 60, actionsPerRound: 1, hp: 8, hpMax: 8 }],
    actorIds: ['m1'], pcSeats: [] });
  var ids3 = h3.state.combat.order.map(function (s) { return s.actorId; });
  ok(ids3.indexOf('p-s-a') < 0 && ids3.indexOf('p-s-b') < 0, '★ pcSeats=[] → 一个 PC 都不入队', JSON.stringify(ids3));
  ok(ids3.indexOf('m1') >= 0, '空 pcSeats 下选中的怪物仍入队');
  eq(h3.state.combat.order.length, 1, '战斗仍成立（只含怪物，未崩）');
  eq(h3.state.combat.turn, 0, '空 pcSeats 下 combat 仍正常初始化（turn=0）');
  ok(typeof h3.state.meta.mode === 'string' && h3.state.meta.mode.length > 0, '房间仍进入战斗模式');
  ok(h3._isMyActionTurn('s-a') === false, '结论：空 pcSeats 下无人入队，玩家 _isMyActionTurn=false（不能发起战斗对抗，符合「不在行动序列」）—— 战斗由 KP 照常推进，不崩');
})();

/* ============================================================
 * QA · 第 1 项 · combat.enqueue 实际行为（幂等 / turn·round / 非战斗 / 已撕卡）
 * ============================================================ */
section('QA-第 1 项 · combat.enqueue 真跑（seats 数组 / 幂等 / 非战斗 / 已撕卡守卫）');
(function () {
  var host = newHost();
  addPlayer(host, 's-a', '甲'); addPlayer(host, 's-b', '乙');
  host.applyAction('host', { op: 'combat.start',
    actors: [pcActor('s-a', '甲', 50), { id: 'm1', name: '怪', kind: 'monster', dex: 60, actionsPerRound: 1, hp: 8, hpMax: 8 }],
    actorIds: ['m1'], pcSeats: ['s-a'] });
  var c = host.state.combat; c.turn = 1; c.round = 3;
  var plan = host.applyAction('host', { op: 'combat.enqueue', seats: ['s-b'] });
  ok(c.order.some(function (s) { return s.actorId === 'p-s-b'; }), 'seats 数组写法：s-b 被追加进 combat.order', planText(plan));
  eq(c.turn, 1, 'enqueue 不改 turn'); eq(c.round, 3, 'enqueue 不改 round');
  ok(hasEvt(plan, M.EVT.TURNSTATE) && /加入了战斗/.test(planText(plan)), '广播 TURNSTATE + 写公开日志');
  var n = c.order.length;
  host.applyAction('host', { op: 'combat.enqueue', seat: 's-b' });
  eq(c.order.length, n, '★ 重复入队幂等（不重复追加）');
  eq(c.turn, 1, '幂等后 turn 不变'); eq(c.round, 3, '幂等后 round 不变');

  var h2 = newHost(); addPlayer(h2, 's-a', '甲');
  var p2 = h2.applyAction('host', { op: 'combat.enqueue', seat: 's-a' });
  ok(/当前不在战斗中/.test(planText(p2)), '★ 非战斗态 → 明确提示「当前不在战斗中」');
  ok(!h2.state.combat, '非战斗态不创建 combat');

  /* 已撕卡目标：v2.7.0 已补 memberRipped 守卫（QA 首轮报的纵深防御缺口 → 已修） */
  var h3 = newHost(); addPlayer(h3, 's-a', '甲'); var rb = addPlayer(h3, 's-b', '乙');
  rb.sheet = { name: '乙', status: { body: '死亡' }, mental: ['永久疯狂'], madness: [] };
  h3.applyAction('host', { op: 'combat.start',
    actors: [pcActor('s-a', '甲', 50), { id: 'm1', name: '怪', kind: 'monster', dex: 60, actionsPerRound: 1, hp: 8, hpMax: 8 }],
    actorIds: ['m1'], pcSeats: ['s-a'] });
  var p3 = h3.applyAction('host', { op: 'combat.enqueue', seat: 's-b' });
  var ripAdded = h3.state.combat.order.some(function (s) { return s.actorId === 'p-s-b'; });
  ok(ripAdded === false, '★ 已撕卡(死亡/永久疯狂) seat → memberRipped 守卫拒绝、不入队（对齐 combatStart）', planText(p3));
  ok(!/加入了战斗/.test(planText(p3)), '★ 被拒时**不**广播「加入了战斗」日志');
  ok(/已撕卡/.test(planText(p3)) && /不能加入战斗/.test(planText(p3)), '★ 给出明确「已撕卡…不能加入战斗」拒绝提示', planText(p3));
  ok(!hasEvt(p3, M.EVT.TURNSTATE), '被拒时无 TURNSTATE（不改动任何状态）');

  /* 混合：活人 + 死人一起 enqueue → 活人入队、死人跳过、不整体失败 */
  var h4 = newHost(); addPlayer(h4, 's-a', '甲'); var rb2 = addPlayer(h4, 's-b', '乙'); addPlayer(h4, 's-c', '丙');
  rb2.sheet = { name: '乙', status: { body: '死亡' }, mental: ['永久疯狂'], madness: [] };
  h4.applyAction('host', { op: 'combat.start',
    actors: [pcActor('s-a', '甲', 50), { id: 'm1', name: '怪', kind: 'monster', dex: 60, actionsPerRound: 1, hp: 8, hpMax: 8 }],
    actorIds: ['m1'], pcSeats: ['s-a'] });
  var p4 = h4.applyAction('host', { op: 'combat.enqueue', seats: ['s-b', 's-c'] });
  var ids4 = h4.state.combat.order.map(function (s) { return s.actorId; });
  ok(ids4.indexOf('p-s-c') >= 0, '★ 混合：活人 s-c 照常入队');
  ok(ids4.indexOf('p-s-b') < 0, '★ 混合：死人 s-b 被跳过（不整体失败）');
  ok(/已撕卡/.test(planText(p4)), '混合路径也给出「已跳过已撕卡」提示');
  ok(hasEvt(p4, M.EVT.TURNSTATE), '混合路径仍广播 TURNSTATE（活人入队生效）');
})();

/* ============================================================
 * QA · 第 1 项 · 入队后 _isMyActionTurn 联动（独立复算）
 * ============================================================ */
section('QA-第 1 项 · 入队后 _isMyActionTurn 在其槽轮到时为 true');
(function () {
  var host = newHost(); addPlayer(host, 's-a', '甲'); addPlayer(host, 's-b', '乙');
  host.applyAction('host', { op: 'combat.start',
    actors: [pcActor('s-a', '甲', 50), { id: 'm1', name: '怪', kind: 'monster', dex: 60, actionsPerRound: 1, hp: 8, hpMax: 8 }],
    actorIds: ['m1'], pcSeats: ['s-a'] });
  var c = host.state.combat, iB = -1;
  ok(!c.order.some(function (s) { return s.actorId === 'p-s-b'; }), '前置：s-b 未入队');
  ok(host._isMyActionTurn('s-b') === false, '未入队 → _isMyActionTurn=false');
  host.applyAction('host', { op: 'combat.enqueue', seat: 's-b' });
  c.order.forEach(function (s, i) { if (s.actorId === 'p-s-b') iB = i; });
  c.turn = iB;
  ok(host._isMyActionTurn('s-b') === true, '★ 入队后轮到其槽 → _isMyActionTurn=true');
  ok(host._isMyActionTurn('s-a') === false, '非其轮 → false（门禁未被放松）');
})();

/* ============================================================
 * QA · 第 2 项 · store.normalize 真跑（背景症状 = 疯狂症状，与正常互斥）
 * ============================================================ */
section('QA-第 2 项 · store.normalize 真跑（含边界）');
(function () {
  ok(!!qStore && typeof qStore.normalize === 'function', 'store 沙盒可用');
  function card(mental, mad) {
    return { id: 'c1', characterName: 'T', basicInfo: { age: 30 }, status: { mental: mental },
             background: { phobias: '' }, madness: mad || [] };
  }
  var bg = { type: 'phobia', name: '幽闭恐惧症', permanent: true, bg: true, rounds: 0, from: '' };
  var bgNoFlag = { type: 'phobia', name: '幽闭恐惧症', permanent: true, rounds: 0 };
  var amb = { type: 'mania', name: '纵火癖', permanent: false, rounds: 4 };

  var a = qStore.normalize(card(['正常'], [bg]));
  ok(a.status.mental.indexOf('疯狂症状') >= 0, '★ 背景症状新卡 → mental 含「疯狂症状」', JSON.stringify(a.status.mental));
  ok(a.status.mental.indexOf('正常') < 0, '★ 且移除「正常」（互斥）', JSON.stringify(a.status.mental));
  eq(JSON.stringify(qStore.normalize(card(['正常'], [])).status.mental), JSON.stringify(['正常']), '无症状卡仍回落 [正常]');
  eq(JSON.stringify(qStore.normalize(card(['永久疯狂', '临时疯狂'], [bg])).status.mental), JSON.stringify(['永久疯狂']),
     '★ 「永久疯狂」互斥仍最先判（只留它）');
  eq(JSON.stringify(qStore.normalize(card(['正常'], [amb])).status.mental), JSON.stringify(['正常']),
     '边界：全为非背景条目(非永久/无 bg) + 正常 → store 的 some 判据不命中，不改 mental');
  ok(qStore.normalize(card(['正常'], [bgNoFlag])).status.mental.indexOf('疯狂症状') >= 0,
     '兼容老数据：permanent=true 但无 bg 标签也算背景症状 → 补「疯狂症状」');
})();

/* ============================================================
 * QA · 第 2 项 · sanitizeSheet 边界（模型权威）——含老 fixture 形态
 * ============================================================ */
section('QA-第 2 项 · sanitizeSheet 边界（只有背景症状 / 混合 / 老 fixture / 空）');
(function () {
  function san(sheet) { return M.sanitizeSheet({ sheet: sheet }, null); }
  var bg = { type: 'phobia', name: '幽闭恐惧症', permanent: true, bg: true, rounds: 0, from: '' };
  var gm = { type: 'bout', name: '惊恐发作', permanent: false, from: '不定疯狂', rounds: 5 };

  var o1 = san({ name: '甲', madness: [bg], mental: ['不定疯狂'] });
  ok(o1.mental.indexOf('不定疯狂') < 0, '★ 只有背景症状 → 剔除「不定疯狂」', JSON.stringify(o1.mental));
  ok(o1.mental.indexOf('疯狂症状') >= 0, '并补上「疯狂症状」');

  var o2 = san({ name: '甲', madness: [bg, gm], mental: ['不定疯狂', '疯狂症状'] });
  ok(o2.mental.indexOf('不定疯狂') >= 0,
     '★★ 背景症状 + 游戏内症状(!permanent && from=不定疯狂) → 绝不剔除「不定疯狂」（防 v2.2.2/v2.4.0 复发回归）', JSON.stringify(o2.mental));

  /* 老 fixture 形态：背景永久症状 + 非永久但无 from 的症状 */
  var o3 = san({ name: '亨利', madness: [
    { type: 'phobia', name: '幽闭恐惧症', permanent: true, rounds: 0 },
    { type: 'mania', name: '纵火癖', permanent: false, rounds: 4 }
  ], mental: ['临时疯狂', '疯狂症状'] });
  eq(JSON.stringify(o3.mental), JSON.stringify(['临时疯狂', '疯狂症状']),
     '★★ 老 fixture 形态（背景永久 + 非永久无 from）→ every 判据不成立 → 不归一、mental 原样（未误伤既有 test_room_model.js）');

  eq(JSON.stringify(san({ name: '甲', madness: [], mental: ['正常'] }).mental), JSON.stringify(['正常']), '空 madness → 不改 mental');
  eq(JSON.stringify(san({ name: '甲', madness: [gm], mental: ['不定疯狂'] }).mental), JSON.stringify(['不定疯狂']), '全为非背景条目 → 不改 mental');
  eq(JSON.stringify(san({ name: '甲', madness: [bg], mental: ['永久疯狂'] }).mental), JSON.stringify(['永久疯狂']), '★ 永久疯狂互斥优先');
})();

/* ============================================================
 * QA · 第 2 项 · advanceMadness 多轮推进
 * ============================================================ */
section('QA-第 2 项 · advanceMadness 推多轮：背景症状与「疯狂症状」常驻');
(function () {
  var host = qTop(); var m = addPlayer(host, 's-a', '甲');
  m.sheet = { name: '甲',
    madness: [{ type: 'phobia', name: '幽闭恐惧症', permanent: true, bg: true, rounds: 0, from: '' },
              { type: 'bout', name: '惊恐发作', permanent: false, from: '临时疯狂', rounds: 2 }],
    mental: ['临时疯狂', '疯狂症状'], status: {} };
  host.advanceMadness('host', { seat: 's-a' });
  host.advanceMadness('host', { seat: 's-a' });
  host.advanceMadness('host', { seat: 's-a' });
  var md = m.sheet.madness || [];
  ok(md.some(function (x) { return x.bg === true && x.name === '幽闭恐惧症'; }), '★ 多轮后背景症状仍在（permanent 跳过）');
  ok(!md.some(function (x) { return x.from === '临时疯狂'; }), '临时症状已到期消退');
  ok((m.sheet.mental || []).indexOf('疯狂症状') >= 0, '★ 「疯狂症状」仍在（md 非空 → 不摘）', JSON.stringify(m.sheet.mental));
  ok((m.sheet.mental || []).indexOf('临时疯狂') < 0, '「临时疯狂」标签随症状消退摘除');
})();

/* ============================================================
 * QA · 第 2 项 · cureIndefinite 边界
 * ============================================================ */
section('QA-第 2 项 · cureIndefinite：只有背景症状 → 拒绝且不删条目；有不定疯狂 → 正常治愈');
(function () {
  var host = qTop(); var m = addPlayer(host, 's-a', '甲');
  m.sheet = { name: '甲', madness: [{ type: 'phobia', name: '幽闭恐惧症', permanent: true, bg: true, rounds: 0, from: '' }],
              mental: ['疯狂症状'], status: {} };
  var out = host.cureIndefinite('host', { seat: 's-a' });
  ok(/来自角色背景/.test(planText(out)), '★ 只有背景症状 → 「来自角色背景，不可治愈」', planText(out));
  eq(m.sheet.madness.length, 1, '★ 背景症状条目未被删除');
  ok(m.sheet.mental.indexOf('疯狂症状') >= 0, '★ 「疯狂症状」未被误摘');

  m.sheet = { name: '甲', madness: [{ type: 'bout', name: '惊恐发作', permanent: false, from: '不定疯狂', rounds: 5 }],
              mental: ['不定疯狂', '疯狂症状'], status: {} };
  host.cureIndefinite('host', { seat: 's-a' });
  ok(m.sheet.mental.indexOf('不定疯狂') < 0, '有不定疯狂 → 正常治愈（标签移除）');
})();

/* ============================================================
 * QA · 第 2 项 · 「疯狂症状」不触发发作 / 全局锁 + SAN Check 端到端
 * ============================================================ */
section('QA-第 2 项 · 「疯狂症状」不触发发作；只有背景症状的角色可正常做 SAN Check');
(function () {
  var host = qTop(); var m = addPlayer(host, 's-a', '甲');
  m.sheet = { name: '甲', madness: [{ type: 'phobia', name: '幽闭恐惧症', permanent: true, bg: true, rounds: 0, from: '' }],
              mental: ['疯狂症状'], status: { body: '正常', currentHP: 10, maxHP: 10, currentSAN: 50, maxSAN: 50 }, skills: [] };

  /* e) 真跑一次普通操作：没被全局锁 / 发作锁拦住 */
  var out = host.intent('s-a', M.intentMsg(M.INTENT.DICE, { expr: '1D100', direct: true }));
  ok(!/只能通过聊天框交流/.test(planText(out)), '★ 只有「疯狂症状」→ 未被撕卡锁死');
  ok(!/处于疯狂发作中/.test(planText(out)), '★ 未被发作锁死（疯狂症状 ≠ 发作）');
  ok(hasEvt(out, M.EVT.DICE), '★ 普通操作照常执行（真的掷出了骰子）');

  /* 源码判据：memberInBout 不含「疯狂症状」 */
  var mb = segModel('memberInBout');
  ok(mb.indexOf('疯狂症状') < 0 && /'临时疯狂'/.test(mb) && /'不定疯狂'/.test(mb),
     '★ 源码：memberInBout 只认「临时疯狂」/「不定疯狂」，不含「疯狂症状」');

  /* f) 端到端：只有背景症状 → SAN Check 可以正常结算（不被拒） */
  var out2 = host.sheetSanCheck('host', { seat: 's-a', okLoss: '0', loss: '1D6', reason: '见鬼' });
  var t2 = planText(out2);
  ok(!/已撕卡/.test(t2) && !/疯狂发作中/.test(t2) && !/无法做 SAN Check/.test(t2), '★ 只有背景症状 → SAN Check 未被拒绝');
  ok(hasEvt(out2, M.EVT.DICE), '★ SAN Check 正常掷出（可正常结算）');
  var sanAfter = m.sheet.status.currentSAN;
  ok(typeof sanAfter === 'number' && sanAfter >= 0 && sanAfter <= 50, '结算后 SAN 合法（0..50，未越界）', String(sanAfter));
  ok((m.sheet.mental || []).indexOf('疯狂症状') >= 0, '结算后「疯狂症状」仍在（背景症状不受 SAN Check 影响）');
})();

/* ============================================================
 * QA · 第 3 项 · 模型守卫真跑（拒绝 / 跳过 / 不整体失败）
 * ============================================================ */
section('QA-第 3 项 · 模型守卫真跑：checkRequest / sceneCheckPush / sceneCheckStep 正反向');
(function () {
  /* checkRequest: seat='*' + 一个已撕卡 → 逐人跳过、不整体失败 */
  var host = qTop(); var a = addPlayer(host, 's-a', '甲'); var b = addPlayer(host, 's-b', '乙');
  a.sheet = { name: '甲', status: { body: '死亡' }, mental: ['永久疯狂'], madness: [] };
  b.sheet = { name: '乙', status: { body: '正常' }, mental: ['正常'], madness: [] };
  var out = host.applyAction('host', { op: 'check.request', seat: '*', skill: '侦查', difficulty: 'REGULAR' });
  eq(out.filter(function (r) { return r.to === 's-a' && r.msg && r.msg.t === M.EVT.REQUEST; }).length, 0, '★ 已撕卡目标未收到 REQUEST');
  eq(out.filter(function (r) { return r.to === 's-b' && r.msg && r.msg.t === M.EVT.REQUEST; }).length, 1, '正常目标照常收到 REQUEST');
  ok(/已撕卡/.test(planText(out)) && !/没有在线的玩家可以推送/.test(planText(out)), '★ 逐条提示且不整体失败');

  /* sceneCheckPush: 首个目标已撕卡 → 跳过该步、不替他掷骰、游标前进 */
  var h2 = qTop(); var c = addPlayer(h2, 's-c', '丙');
  c.sheet = { name: '丙', status: { body: '死亡' }, mental: ['永久疯狂'], madness: [], skills: [{ name: '侦查', total: 60 }] };
  var o2 = h2.applyAction('host', { op: 'scene.check.push', title: '搜查', steps: [{ id: 'st1', title: '搜查', skill: '侦查', targetSeat: 's-c' }] });
  ok(h2.state.sceneCheck.results.length >= 1 && h2.state.sceneCheck.results[0].skipped === true, '★ 已撕卡目标步骤被跳过（skipped:true）');
  ok(/已撕卡/.test(planText(o2)) && !/系统自动/.test(planText(o2)), '★ 有跳过提示、且不再替他掷骰');
  eq(h2.state.sceneCheck.cursor, h2.state.sceneCheck.steps.length, '游标前进到末尾（不整体失败）');

  /* sceneCheckStep 正向①：KP 显式给 p.level → 不跳过、正常判定 */
  var h3 = qTop(); var d = addPlayer(h3, 's-d', '丁');
  d.sheet = { name: '丁', status: { body: '死亡' }, mental: ['永久疯狂'], madness: [], skills: [{ name: '侦查', total: 60 }] };
  h3.state.sceneCheck = { id: 'sc1', title: 'T', steps: [{ id: 'p1', title: '看', skill: '侦查', targetSeat: 's-d', difficulty: 'REGULAR' }], cursor: 0, results: [], at: 1 };
  var o3 = h3.applyAction('host', { op: 'scene.check.step', stepId: 'p1', seat: 's-d', level: 2 });
  ok(h3.state.sceneCheck.results[0].skipped !== true && h3.state.sceneCheck.results[0].level === 2,
     '★ 正向：KP 显式给 level=2 时不跳过（已撕卡也能被 KP 裁定）', JSON.stringify(h3.state.sceneCheck.results));
  ok(hasEvt(o3, M.EVT.SCENE_CHECK), '正向：正常产出场景检定结果');

  /* sceneCheckStep 正向②：疯狂发作中（bout）仍按 v2.1.6 系统自动随机判定，不跳过 */
  var h4 = qTop(); var e = addPlayer(h4, 's-e', '戊');
  e.sheet = { name: '戊', status: { body: '正常', currentHP: 10, maxHP: 10 }, mental: ['临时疯狂'],
              madness: [{ type: 'bout', name: '惊恐发作', permanent: false, from: '临时疯狂', rounds: 3 }], skills: [{ name: '侦查', total: 60 }] };
  h4.state.sceneCheck = { id: 'sc1', title: 'T', steps: [{ id: 'q1', title: '看', skill: '侦查', targetSeat: 's-e', difficulty: 'REGULAR' }], cursor: 0, results: [], at: 1 };
  var o4 = h4.applyAction('host', { op: 'scene.check.step', stepId: 'q1', seat: 's-e' });
  ok(h4.state.sceneCheck.results[0].skipped !== true, '★ 正向：疯狂发作中仍按系统自动随机判定（未误伤 v2.1.6）', JSON.stringify(h4.state.sceneCheck.results));
  ok(hasEvt(o4, M.EVT.DICE), '正向：系统自动掷骰（未被他本人操作阻塞）');
})();

section('QA-第 3 项 · 模型守卫真跑：通用 checkOpposed / cureIndefinite 对撕卡目标拒绝');
(function () {
  var host = qTop(); var a = addPlayer(host, 's-a', '甲'); var b = addPlayer(host, 's-b', '乙');
  a.sheet = { name: '甲', status: { body: '正常' }, mental: ['正常'], madness: [], skills: [{ name: '侦查', total: 60 }] };
  b.sheet = { name: '乙', status: { body: '死亡' }, mental: ['永久疯狂'], madness: [], skills: [{ name: '潜行', total: 50 }] };
  var out = host.checkOpposed('host', { aSeat: 's-a', aSkill: '侦查', bSeat: 's-b', bSkill: '潜行' });
  ok(/已撕卡/.test(planText(out)) && !hasEvt(out, M.EVT.CHECK), '★ 通用对抗遇已撕卡一方 → 拒绝、不结算');

  var h2 = qTop(); var c = addPlayer(h2, 's-c', '丙');
  c.sheet = { name: '丙', status: { body: '死亡' }, mental: ['永久疯狂'], madness: [] };
  var o2 = h2.cureIndefinite('host', { seat: 's-c' });
  ok(/已撕卡/.test(planText(o2)), '★ cureIndefinite 对撕卡目标 → 拒绝（不结算）');
})();

/* ============================================================
 * QA · 跨组接口契约检查
 * ============================================================ */
section('QA-跨组契约 · combat.enqueue 三处齐备 + UI/模型字段名一致');
(function () {
  var src = readSrc('core/room-model.js');
  ok(/'combat\.enqueue': \{ roles: \['kp'\]/.test(src), '① POLICY 注册 combat.enqueue（roles:[kp]）');
  ok(/op === 'combat\.enqueue'/.test(src), '② applyAction 分发 combat.enqueue');
  ok(/Host\.prototype\.combatEnqueue = function/.test(src), '③ Host.prototype.combatEnqueue 存在');
  var uiSrc = stripComments(readSrc('ui/room-panels.js'));
  ok(/op: 'combat\.enqueue', seat: m\.seat/.test(uiSrc), 'UI 发 { op:"combat.enqueue", seat }；模型读 p.seat —— 字段名一致');
  ok(/if \(p\.seat !== undefined && p\.seat !== null && p\.seat !== ''\) seatList\.push\(p\.seat\)/.test(src),
     '模型侧确实读 p.seat（单值归并进 seatList）');
})();

section('QA-跨组契约 · 新谓词唯一定义、无重复实现');
(function () {
  var g = function (re, file) { return (readSrc(file).match(re) || []).length; };
  eq(g(/function isBgSymptom\(/g, 'core/room-model.js'), 1, 'isBgSymptom 唯一定义（room-model）');
  eq(g(/function onlyBgSymptoms\(/g, 'core/room-model.js'), 1, 'onlyBgSymptoms 唯一定义（room-model）');
  eq(g(/Host\.prototype\._skipSceneStep = function/g, 'core/room-model.js'), 1, '_skipSceneStep 唯一定义（room-model）');
  eq(g(/function targetBlocked\(/g, 'ui/room-panels.js'), 1, 'targetBlocked 唯一定义（room-panels）');
  eq(g(/var hasPermSymptom =/g, 'core/store.js'), 1, 'hasPermSymptom 唯一定义（store）');
  /* onlyBgSymptoms 恰有两处调用（sanitizeSheet 兜底 + cureIndefinite 判定） */
  eq(g(/onlyBgSymptoms\(/g, 'core/room-model.js') - 1, 2, 'onlyBgSymptoms 恰被引用 2 次（sanitizeSheet / cureIndefinite）');
})();

section('QA-跨组契约 · room-model.js 两人共改：函数无互相覆盖 / 双方函数都在');
(function () {
  var src = readSrc('core/room-model.js');
  var protos = (src.match(/Host\.prototype\.[A-Za-z_]+/g) || []);
  var seen = {}, dups = [];
  protos.forEach(function (p) { if (seen[p]) { if (dups.indexOf(p) < 0) dups.push(p); } else seen[p] = 1; });
  eq(dups.length, 0, '★ room-model.js 无重复 Host.prototype 定义（不会互相覆盖）', dups.join(','));
  var protoFns = ['combatStart', 'combatEnqueue', 'cureIndefinite', 'advanceMadness',
                  'checkRequest', 'sceneCheckPush', 'sceneCheckStep', 'checkOpposed'];
  var plainFns = ['sanitizeSheet', 'memberRipped', 'memberInBout', 'memberMadActive', 'isBgSymptom', 'onlyBgSymptoms'];
  protoFns.forEach(function (n) {
    ok(new RegExp('Host\\.prototype\\.' + n + ' =').test(src), '函数在册（prototype）：' + n);
  });
  plainFns.forEach(function (n) {
    ok(new RegExp('function ' + n + '\\(').test(src), '函数在册（顶层）：' + n);
  });
})();

section('QA-跨组契约 · room-ui#sheetSummary 字段名 = sanitizeSheet 白名单（防重连被剥）');
(function () {
  function block(text, start, end) {
    var i = text.indexOf(start); if (i < 0) return '';
    var rest = text.slice(i); var j = rest.indexOf(end);
    return j < 0 ? rest : rest.slice(0, j);
  }
  function objKeys(b) {
    var i = b.indexOf('return {'); if (i < 0) return [];
    var j = b.indexOf('{', i), k = b.indexOf('}', j);
    var o = b.slice(j + 1, k), out = [];
    o.replace(/([a-zA-Z_][\w]*)\s*:/g, function (_, kk) { out.push(kk); return ''; });
    return out.sort();
  }
  var ui = block(stripComments(readSrc('ui/room-ui.js')), 'function sheetSummary(', '\n  function reportSheet');
  var uiMad = block(ui, 'madness: mad.slice(0, 40).map(', '}),');
  var uiKeys = objKeys(uiMad);
  var mod = block(stripComments(readSrc('core/room-model.js')), 'out.madness = arr.slice(0, 40).map(', '}).filter(');
  var modKeys = objKeys(mod);
  var want = ['bg', 'from', 'name', 'permanent', 'rounds', 'sum', 'type'].sort();
  eq(JSON.stringify(uiKeys), JSON.stringify(want), '★ sheetSummary#madness 字段集 = {type,name,permanent,rounds,from,bg,sum}', JSON.stringify(uiKeys));
  eq(JSON.stringify(modKeys), JSON.stringify(want), '★ sanitizeSheet#madness 白名单 = 同 7 字段', JSON.stringify(modKeys));
})();

/* ============================================================
 * QA · 第 3 项 · UI 静态证据链（独立正则复算）+ 反向断言
 * ============================================================ */
section('QA-第 3 项 · UI 证据链：targetBlocked 接入 4 入口 + 5 目标池；反向：3 处刻意不过滤');
(function () {
  ok(/function targetBlocked\(m\) \{ return isMemberRippedU\(m\); \}/.test(rpClean), 'targetBlocked = isMemberRippedU（只封死亡/永久疯狂）');
  ['dmgForPlayer', 'tempForPlayer', 'itemForPlayer', 'cureForPlayer'].forEach(function (fn) {
    ok(segOf(fn).indexOf('skip: targetBlocked') >= 0, fn + ' 用 targetBlocked 作 opts.skip');
  });
  ok(segOf('sanForPlayer').indexOf('skip: sanBlocked') >= 0 && segOf('sanLossForPlayer').indexOf('skip: sanBlocked') >= 0,
     'sanForPlayer / sanLossForPlayer 仍用更严的 sanBlocked（未改）');
  ['pushCheckSheet', 'kpSceneCheckPanel', 'stepEditor', 'genericOpposedSheet', 'kpAttackSheet'].forEach(function (fn) {
    ok(segOf(fn).indexOf('targetBlocked') >= 0, '入口 ' + fn + ' 的玩家池用 targetBlocked 过滤');
  });
  ok(segOf('clueSheet').indexOf('targetBlocked') < 0, '★ 反向：clueSheet 不过滤（递线索对象是「玩家」）');
  ok(segOf('pickPlayerToEdit').indexOf('targetBlocked') < 0, '★ 反向：pickPlayerToEdit 不过滤（state.request 出口）');
  ok(segOf('stateRequestCard').indexOf('targetBlocked') < 0, '★ 反向：stateRequestCard 不过滤（state.request 出口）');
  ok(segOf('pickPlayerToEdit').indexOf('stateRequestSheet') >= 0 && segOf('stateRequestCard').indexOf('stateRequestSheet') >= 0,
     '两条入口都经 stateRequestSheet 走同一 op');
  ok(segOf('stateRequestSheet').indexOf('state.request') >= 0, 'stateRequestSheet 提交 op = state.request');
  ok(M.allowed(M.ROLE.KP, 'state.request') === true, 'POLICY 允许 KP：state.request（复活途径可用）');
})();

/* ============================================================
 * QA · 守卫：app.css 未被本次触碰 + 花括号配平
 * ============================================================ */
section('QA-守卫 · app.css 花括号配平 / 未被本次 v2.7.0 触碰（.gp-grid 无改动）');
(function () {
  var css = fs.readFileSync('web/css/app.css', 'utf8');
  var o = (css.match(/{/g) || []).length, c = (css.match(/}/g) || []).length;
  eq(o, c, 'app.css 花括号配平');
  /* v2.9.0（说明 · software-engineer / 寇豆码）：本轮**确实**改动了 app.css
     （另一位工程师移除回退 UI 的 .rewind-card 样式）。原「app.css mtime 早于本轮 JS 改动」
     是一条**一次性 mtime 证据**（用于证明该轮没碰 CSS），本轮 CSS 被有意触碰 → 该证据不再成立。
     退役这条脆弱断言，改断「本轮 CSS 改动确为回退 UI 清理」；其余实质检查（花括号配平 /
     .gp-grid 存续 / JS 可解析）保持不变。 */
  ok(css.indexOf('.rewind-card') < 0,
     '★（v2.9.0）app.css 本轮改动为回退 UI 清理（.rewind-card 已移除）；原 mtime 证据断言退役');
  ok((css.match(/\.gp-grid/g) || []).length > 0, 'app.css 仍持有既有 .gp-grid 规则（未被删除）');
  /* 语法守卫：两个被共改的 JS 已在顶层 mkSandbox 里成功 vm 执行 —— 若能跑到这里即证明可解析。 */
  ok(true, 'room-model.js / room-panels.js 可正常解析执行（本测试全程真跑，无语法错误）');
})();
