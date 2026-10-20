/*
 * v2.9.0 独立回归 —— 本文件由多名工程师按小节 append 汇总。
 *
 *   本小节由 software-engineer（寇豆码）负责：**模型层 + 传输层**
 *     · 第 1 项 KP 点「推进一回合」→ 玩家本机临时卡自动「生效到原卡」：
 *         - room-model.js 新增 EVT.TEMP_COMMIT（PUBLIC）；_advanceRound 末尾 _push 广播
 *           （覆盖「探索态 round.next」与「战斗整轮折返」两条路径；开局 room.start 不触发）。
 *         - room-net.js PlayerSide._onText 新增分支 → _onTempCommit(p)：遍历本机**本房**
 *           临时卡逐张 commitTempCard；无本卡静默跳过；roomCode 隔离；先提交后重绘；
 *           完成后经回调 onTempCommit(p, {committed}) 通知 UI。
 *         - room-ui.js 接 onTempCommit → 弹 toast（不可撤销覆盖提示）+ 重绘。
 *     · 第 3 项（之一）关闭回退入口 op：room-model.js POLICY 摘掉 `rollback.turn`
 *       （方法 / 事件 / 枚举 / reduce 分支**休眠保留**，供旧存档回放兼容）。
 *
 *   ⚠️ 另一位工程师（software-engineer-2）会在本文件**末尾 append** UI 小节；
 *     为避免「汇总早于追加的断言执行」，本文件汇总 / RESULT 走 process.on('exit')，
 *     任何后追加的代码都会先跑完再汇总。
 *
 * 运行： node tools/test_v290_fixes.js（工作目录 = 仓库根）
 * 成功时最后一行打印 RESULT: PASS
 */
'use strict';
var fs = require('fs'), path = require('path');
var ROOT = path.join(__dirname, '..');

var pass = 0, fail = 0, failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else {
    fail++;
    failures.push(label + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)));
    console.log('  ✗ ' + label + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)));
  }
}
function eq(a, b, name) { ok(a === b, name, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
function section(t) { console.log('\n== ' + t + ' =='); }

/* ------------------------------------------------------------
 * 载入被测源码（与 test_room_model / test_room_net 同款：global.window = global）
 * ------------------------------------------------------------ */
global.window = global;

/* localStorage 内存实现（room-store 依赖它） */
function makeLS() {
  var m = {}, keys = [];
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem: function (k, v) { if (!Object.prototype.hasOwnProperty.call(m, k)) keys.push(k); m[k] = String(v); },
    removeItem: function (k) {
      if (Object.prototype.hasOwnProperty.call(m, k)) {
        delete m[k];
        keys = keys.filter(function (x) { return x !== k; });
      }
    },
    key: function (i) { return keys[i] === undefined ? null : keys[i]; },
    clear: function () { m = {}; keys = []; },
    get length() { return keys.length; }
  };
}
global.localStorage = makeLS();

/* Store 假实现（临时卡的源卡 / 生效落点） */
var CHARS = {
  'c-1': { id: 'c-1', characterName: '甲' },
  'c-2': { id: 'c-2', characterName: '乙' }
};
var upserts = [];
global.Store = {
  getState: function () { return { characters: CHARS }; },
  upsertCharacter: function (rec) { upserts.push(rec); return true; }
};

eval(fs.readFileSync(path.join(ROOT, 'web/js/core/room-rules.js'), 'utf8'));
eval(fs.readFileSync(path.join(ROOT, 'web/js/core/room-model.js'), 'utf8'));
eval(fs.readFileSync(path.join(ROOT, 'web/js/core/room-store.js'), 'utf8'));
eval(fs.readFileSync(path.join(ROOT, 'web/js/core/room-net.js'), 'utf8'));

var M = global.RoomModel, N = global.RoomNet, RS = global.RoomStore;
var E = M.EVT, R = M.ROLE;

/* ============================================================
 * 小节 1 · software-engineer（寇豆码）—— 第 1 项（模型层：EVT.TEMP_COMMIT 广播）
 * ============================================================ */
section('SE 第 1 项 · _advanceRound 广播 TEMP_COMMIT（模型）');

function mkV290Host(code, at) {
  return new M.Host({
    meta: { code: code || 'r0', name: '测试团', kpName: 'KP', maxPlayers: 4 },
    now: function () { return at || 111; }
  });
}

(function () {
  var host = mkV290Host('rc1', 111);
  var plan = host._advanceRound([], 2);
  var evs = plan.filter(function (p) { return p.msg && p.msg.t === E.TEMP_COMMIT; });
  eq(evs.length, 1, '★ _advanceRound 产出 1 条 TEMP_COMMIT');
  eq(evs[0].to, '*', '★ TEMP_COMMIT 通过发送计划广播（to:"*"，证明真发得出去）');
  eq(evs[0].msg.p.round, 2, '★ 载荷含 round');
  eq(evs[0].msg.p.at, 111, '★ 载荷含 at（= this.now()）');
})();

(function () {
  /* 探索态 round.next 路径 */
  var h2 = mkV290Host('rc2', 1);
  var p2 = h2.applyAction('host', { op: 'round.next' });
  ok(p2.some(function (p) { return p.msg && p.msg.t === E.TEMP_COMMIT; }),
     '★ 探索态 round.next → 触发 TEMP_COMMIT');
  eq(h2.state.meta.round, 1, 'round 被推进到 1（首个回合）');
})();

(function () {
  /* 开局反例：room.start 直接 emit ROUND，不走 _advanceRound */
  var h3 = mkV290Host('rc3', 1);
  var p3 = h3.applyAction('host', { op: 'room.start' });
  ok(!p3.some(function (p) { return p.msg && p.msg.t === E.TEMP_COMMIT; }),
     '★ 开局 room.start **不**触发 TEMP_COMMIT');
  ok(p3.some(function (p) { return p.msg && p.msg.t === E.ROUND; }), '但照常 emit ROUND（回合边界）');
})();

(function () {
  /* 战斗态：只有「整轮折返」才触发 */
  var h4 = mkV290Host('rc4', 1);
  h4.applyAction('host', {
    op: 'combat.set',
    combat: {
      order: [
        { slot: 's-a', name: 'A', dex: 70, done: false },
        { slot: 'npc1#1', name: 'B', dex: 50, done: false }
      ], turn: 0, round: 1
    }
  });
  var c1 = h4.applyAction('host', { op: 'combat.next' });   // 换人（同一轮）
  var c2 = h4.applyAction('host', { op: 'combat.next' });   // 走完一圈 → 折返，round+1
  ok(!c1.some(function (p) { return p.msg && p.msg.t === E.TEMP_COMMIT; }),
     '战斗「下一个行动」（不折返）不触发 TEMP_COMMIT');
  ok(c2.some(function (p) { return p.msg && p.msg.t === E.TEMP_COMMIT; }),
     '★ 战斗「整轮折返」（round+1）触发 TEMP_COMMIT');
  eq(h4.state.combat.round, 2, '折返后战斗轮次 = 2');
})();

(function () {
  /* 不进存档 + 非保密字段 */
  var h2 = mkV290Host('rc5', 1);
  h2.applyAction('host', { op: 'round.next' });
  ok(JSON.stringify(h2.save()).indexOf('tempcommit') < 0, '★ save() 不含 TEMP_COMMIT（不进存档）');
  ok(M.SECRET_KEYS.indexOf('tempcommit') < 0, 'SECRET_KEYS 不含 tempcommit（载荷可公开）');
})();

/* ============================================================
 * 小节 1 · software-engineer（寇豆码）—— 第 3 项之一（关闭回退入口 op）
 * ============================================================ */
section('SE 第 3 项 · rollback.turn 入口关闭（模型）');

(function () {
  ok(!M.allowed(R.KP, 'rollback.turn'), '★ rollback.turn 已不在 POLICY（allowed=false）');
  ok(M.POLICY['rollback.turn'] === undefined, '★ POLICY 表里确实没有 rollback.turn 这一条');
  ok(M.allowed(R.KP, 'rollback.commit'), 'rollback.commit 的 POLICY 休眠保留');
  ok(M.allowed(R.KP, 'rollback.round'), 'rollback.round（推进同义别名）的 POLICY 保留');
  ok(M.allowed(R.KP, 'round.next'), '★ round.next（推进侧）必须保留');

  /* 方法 / 事件 / 枚举休眠保留（旧存档回放兼容） */
  var h = mkV290Host('rc6', 1);
  eq(typeof h.rollbackPropose, 'function', 'rollbackPropose 方法休眠保留');
  eq(typeof h.rollbackVote, 'function', 'rollbackVote 方法休眠保留');
  eq(typeof h.rollbackCommit, 'function', 'rollbackCommit 方法休眠保留');
  ok(E.REWIND === 'rewind', 'EVT.REWIND 保留（旧存档 reduce 走得到分支）');
  ok(M.REWIND && M.REWIND.VOTING === 'VOTING', 'REWIND 枚举保留');
  ok(M.INTENT && M.INTENT.VOTE === 'vote', 'INTENT.VOTE 保留');

  /* 伪造 ACT 一律被拒（入口关的直接目的） */
  var out = h.intent('host', M.intentMsg(M.INTENT.ACT, { op: 'rollback.turn', turns: 1 }));
  ok(!h.rewind || h.rewind.state !== M.REWIND.VOTING, '★ 伪造 rollback.turn ACT 不会进入投票态');
  ok(out.some(function (r) { return r.to === 'host' && /没有权限/.test(JSON.stringify(r.msg)); }),
     '★ 伪造 rollback.turn ACT → 「没有权限」（被 needs 拦下）');
})();

/* ============================================================
 * 小节 1 · software-engineer（寇豆码）—— 第 1 项（传输层：_onTempCommit 真跑）
 * ============================================================ */
section('SE 第 1 项 · PlayerSide._onTempCommit（传输层，真跑）');

function mkSide(code, onTempCommit, onEvent) {
  var side = new N.PlayerSide({
    client: new M.Client({ seat: 's1', role: 'player' }),
    room: { code: code, wsUrl: 'ws://x/ws?code=' + code + '&t=t1', mtoken: 't1' },
    onTempCommit: onTempCommit,
    onEvent: onEvent
  });
  return side;
}

(function () {
  /* (1) 有本房临时卡 → 真调 commitTempCard，committed = 1 */
  global.localStorage.clear(); upserts.length = 0;
  RS.ensureTempCard('ab12cd', 's1', 'c-1');
  ok(!!RS.getTempCard('ab12cd', 'c-1'), '前置：本房临时卡已建（卡上 HP=undefined）');

  var seen = [];
  var order = [];
  global.Store.upsertCharacter = function (rec) { order.push('commit'); upserts.push(rec); return true; };
  var side = mkSide('ab12cd',
    function (p, r) { seen.push({ p: p, r: r }); },
    function () { order.push('repaint'); });

  side._onText(JSON.stringify(M.evtMsg({ seq: 1, evt: { t: E.TEMP_COMMIT, p: { round: 2, at: 999 } } })));
  eq(upserts.length, 1, '★ 本房临时卡被 commitTempCard（原卡被覆盖 1 次）');
  eq(seen.length, 1, '★ 回调 onTempCommit 被调用 1 次');
  eq(seen[0].r.committed, 1, '★ committed = 1（本次真正生效的张数）');
  eq(seen[0].p.round, 2, '回调收到载荷 round');
  eq(RS.getTempCard('ab12cd', 'c-1').committed, true, '临时卡被标记 committed（tempCardBar 将显示「已生效 N 次」）');
  ok(order.indexOf('commit') >= 0 && order.indexOf('repaint') >= 0 &&
     order.indexOf('commit') < order.indexOf('repaint'),
     '★ 先提交（落库）后重绘（与 EVT.STATE 同款顺序）', order);
})();

(function () {
  /* (2) 本机无本房临时卡 → 静默跳过（不报错、不提示），committed = 0 */
  global.localStorage.clear(); upserts.length = 0;
  var seen = [];
  var side = mkSide('nocard',
    function (p, r) { seen.push(r); },
    function () {});
  side._onText(JSON.stringify(M.evtMsg({ seq: 1, evt: { t: E.TEMP_COMMIT, p: { round: 3, at: 1 } } })));
  eq(upserts.length, 0, '★ 无本房临时卡 → 不调用 commitTempCard');
  eq(seen.length, 1, '仍回调 onTempCommit（committed=0，UI 据此不打扰）');
  eq(seen[0].committed, 0, '★ committed = 0');
})();

(function () {
  /* (3) roomCode 隔离：别房临时卡不被误提交 */
  global.localStorage.clear(); upserts.length = 0;
  RS.ensureTempCard('ab12cd', 's1', 'c-1');   // 本房
  RS.ensureTempCard('zzz999', 's1', 'c-2');   // 别房（续玩 / 多开）
  var seen = [];
  var side = mkSide('ab12cd',
    function (p, r) { seen.push(r); },
    function () {});
  side._onText(JSON.stringify(M.evtMsg({ seq: 1, evt: { t: E.TEMP_COMMIT, p: { round: 2, at: 1 } } })));
  eq(upserts.length, 1, '★ 只提交本房 1 张（别房不误伤）');
  eq(upserts[0] && upserts[0].characterName, '甲', '提交的是本房卡（甲），不是别房的乙');
  eq(RS.getTempCard('ab12cd', 'c-1').committed, true, '本房临时卡已生效');
  ok(RS.getTempCard('zzz999', 'c-2').committed !== true, '★ 别房临时卡未被提交（roomCode 隔离）');
  eq(seen[0].committed, 1, 'committed 只计本房');
})();

(function () {
  /* 静态接线：_onText 里确实有 TEMP_COMMIT 分支（且放在 onEvent 之前） */
  var src = fs.readFileSync(path.join(ROOT, 'web/js/core/room-net.js'), 'utf8');
  var iBranch = src.indexOf('if (m.t === MODEL.EVT.TEMP_COMMIT) this._onTempCommit(m.p || {});');
  var iEvent = src.indexOf('this.onEvent(this.client.state, r);');
  ok(iBranch >= 0, 'room-net.js _onText 有 TEMP_COMMIT 分支');
  ok(iBranch >= 0 && iEvent > iBranch, '★ 分支位于 onEvent 之前（先落库后重绘）');
  /* room-ui 接线 */
  var rui = fs.readFileSync(path.join(ROOT, 'web/js/ui/room-ui.js'), 'utf8');
  ok(/function onTempCommitNotify\(gen\)/.test(rui), 'room-ui.js 定义了 onTempCommitNotify 助手');
  ok(/onTempCommit: onTempCommitNotify\(gen\)/.test(rui), 'room-ui.js 已把 onTempCommit 接到 PlayerSide');
})();

/* ============================================================
 * 汇总（走 process.on('exit')，允许其他工程师在本文件末尾 append 后再统一汇总）
 * ============================================================ */
process.on('exit', function () {
  console.log('\n' + '='.repeat(60));
  if (fail) {
    console.log('失败 ' + fail + ' 项：');
    failures.forEach(function (f) { console.log('  ✗ ' + f); });
    console.log('v2.9.0 fixes selftest: ' + pass + ' passed, ' + fail + ' failed');
    console.log('RESULT: FAIL');
  } else {
    console.log('v2.9.0 fixes selftest: ' + pass + ' passed, ' + fail + ' failed');
    console.log('RESULT: PASS');
  }
  /* 退出码：让「从仓库根跑全量 tools/test_*.js」的runner 能据退出码判定 */
  process.exitCode = fail ? 1 : 0;
});
/* ============================================================
 * 小节 2 · software-engineer-2（寇豆码）—— 第 2 项（KP 工具箱按钮重分类）+ 第 3 项（回退 UI 全删）
 *
 *   · 第 2 项：room-panels.js#kpPanel 工具按钮按用途分组并加 div.sec-title 小标题
 *     （回合与时间 / 检定与骰子 / 战斗 / 定向指令[独立卡] / 场景与素材 / 房间管理）；
 *     「✉️ 邀请加入」补进 KP 工具面板（原只在死代码面板里、不可达）；
 *     文案/图标微调：对抗统一为「⚔ 对抗」、追加理智损失图标 🧠→🌀。
 *     ⚠️ 只改分组 / 顺序 / 标题 / 图标，**任何按钮的 op / 回调均未变**。
 *   · 第 3 项：删光回退 UI —— room-panels.js 的回退卡片 / 回退弹层 / 死代码快捷面板 及其 export；
 *     room-ui.js 的 paintStatus 回退分支 + 回退投票卡；app.css 的回退专用样式。
 * ============================================================ */
section('SE2 第 2 项 · kpPanel 分组顺序 + 按钮 op 未变（静态证据链）');
(function () {
  function strip(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }
  var rpRaw = fs.readFileSync(path.join(ROOT, 'web/js/ui/room-panels.js'), 'utf8');
  var rp = strip(rpRaw);
  function segOf(name) {
    var i = rp.indexOf('function ' + name + '(');
    if (i < 0) return '';
    var rest = rp.slice(i + 1);
    var m = /\r?\n  function /.exec(rest);
    return rest.slice(0, m ? m.index : rest.length);
  }
  function cnt(hay, needle) { return hay.split(needle).length - 1; }

  var kp = segOf('kpPanel');
  ok(kp.length > 0, '能取到 kpPanel 源码段（函数名锚定，不依赖行号）');

  /* ---- 1) 五个分组小标题（复用既有 div.sec-title，不新造样式类） ---- */
  ['回合与时间', '检定与骰子', '战斗', '场景与素材', '房间管理'].forEach(function (g) {
    ok(kp.indexOf("text: '" + g + "'") >= 0,
       'kpPanel 含分组小标题「' + g + '」（div.sec-title 复用）');
    ok(kp.indexOf("el('div.sec-title'") >= 0, '分组标题用的就是既有 div.sec-title 元素');
  });

  /* ---- 2) 分组顺序 ---- */
  var order = ['回合与时间', '检定与骰子', '战斗', 'kpDirectivesCard(ctx)', '场景与素材', '房间管理'];
  var idx = order.map(function (t) { return kp.indexOf(t); });
  ok(idx.every(function (x) { return x >= 0; }), '五组 + 定向指令卡均可定位', JSON.stringify(idx));
  var inc = true;
  for (var i = 1; i < idx.length; i++) { if (!(idx[i - 1] < idx[i])) inc = false; }
  ok(inc, '★ 分组顺序 = 回合与时间 → 检定与骰子 → 战斗 → 定向指令[独立卡] → 场景与素材 → 房间管理',
     JSON.stringify(idx));

  /* ---- 3) 工具按钮相对次序 ---- */
  var btn = ['⏭ 进入下一回合', '🎲 要求检定', '⚖ 检定成败阈值', '⚔ 对抗', '📩 递线索', '✉️ 邀请加入', '💾 保存本局', '🏁 结团'];
  var bidx = btn.map(function (t) { return kp.indexOf("'" + t + "'"); });
  ok(bidx.every(function (x) { return x >= 0; }), 'kpPanel 含全部 8 个工具按钮', JSON.stringify(bidx));
  var binc = true;
  for (var j = 1; j < bidx.length; j++) { if (!(bidx[j - 1] < bidx[j])) binc = false; }
  ok(binc, '★ 工具按钮次序 = 回合 → 检定 → 阈值 → 对抗 → 线索 → 邀请 → 保存 → 结团', JSON.stringify(bidx));

  /* ---- 4) 回调逐个未变（「不改功能」硬证据：每个回调在 kpPanel 段内恰 1 次） ---- */
  ['pushCheckSheet(ctx)', 'roomRulesSheet(ctx)', 'opposedSheet(ctx)', 'clueSheet(ctx)',
   'inviteForRoom(ctx)', 'saveSlotsSheet(ctx)', 'endSession(ctx)'].forEach(function (call) {
    ok(cnt(kp, call) === 1, '回调 ' + call + ' 在 kpPanel 内恰好 1 次（未改 / 未重复）');
  });
  ok(cnt(kp, "op: 'round.next'") === 1, "op 'round.next' 在 kpPanel 内恰好 1 次（未改）");

  /* ---- 5) 「✉️ 邀请加入」在 kpPanel 内可达 ---- */
  ok(kp.indexOf("'✉️ 邀请加入'") >= 0 && kp.indexOf('inviteForRoom(ctx)') >= 0,
     '★ 「✉️ 邀请加入」在 kpPanel 内可达（真接 inviteForRoom）');
  ok(/function inviteForRoom\(ctx\)/.test(rpRaw), 'inviteForRoom 函数保留');

  /* ---- 6) 定向指令 9 项（独立卡）顺序不变、各恰 1 次 ---- */
  var kd = segOf('kpDirectivesCard');
  var dir = ['💥 造成伤害', '🌫 临时状态', '🎒 给物品', '🧠 SAN Check', '🕶 暗骰', '🌀 追加理智损失',
             '💊 治愈疯狂', '🩹 治愈伤势', '🚑 急救 / 医学'];
  var didx = dir.map(function (t) { return kd.indexOf("'" + t + "'"); });
  ok(didx.every(function (x) { return x >= 0; }), '★ 定向指令 9 项标签齐全（含 🌀 追加理智损失）', JSON.stringify(didx));
  var dinc = true;
  for (var k = 1; k < didx.length; k++) { if (!(didx[k - 1] < didx[k])) dinc = false; }
  ok(dinc, '★ 定向指令 9 项顺序未变', JSON.stringify(didx));
  dir.forEach(function (t) {
    ok(cnt(kd, "'" + t + "'") === 1, '定向指令「' + t + '」恰 1 次（未重复 / 未丢）');
  });

  /* ---- 7) 文案 / 图标 ---- */
  ok(rpRaw.indexOf('⚔️ 对抗检定') < 0, '★ 旧文案「⚔️ 对抗检定」已不存在（随死代码一并消失）');
  ok(rpRaw.indexOf("'⚔ 对抗'") >= 0, '★ 已统一为「⚔ 对抗」');
  ok(rpRaw.indexOf('🧠 追加理智损失') < 0, '★ 旧图标「🧠 追加理智损失」已改');
  ok(rpRaw.indexOf('🌀 追加理智损失') >= 0, '★ 已改为「🌀 追加理智损失」（避免与 🧠 SAN Check 撞图标）');

  /* ---- 8) 协议 op 仍在（关键入口未被误删） ---- */
  /* 说明：check.request / check.opposed / session.end 在本文件里被**多个流程**复用
     （场景检定 / 对抗裁定 / OP_LABEL 等），故只断言「仍在」；与 KP 单一按钮一一对应的
     round.next / scene.clue / room.rules 断言**恰好 1 次**。 */
  ok(cnt(rp, "op: 'round.next'") === 1, "op 'round.next' 恰 1 次");
  ok(cnt(rp, 'check.request') >= 1, 'op check.request 仍在', 'n=' + cnt(rp, 'check.request'));
  ok(cnt(rp, 'check.opposed') >= 1, 'op check.opposed 仍在', 'n=' + cnt(rp, 'check.opposed'));
  ok(cnt(rp, 'scene.clue') === 1, 'op scene.clue 恰 1 次');
  ok(cnt(rp, 'room.rules') === 1, 'op room.rules 恰 1 次');
  ok(cnt(rp, 'session.end') >= 1, 'op session.end 仍在', 'n=' + cnt(rp, 'session.end'));

  /* ---- 9) 反向断言：回退 UI 彻底消失（room-panels.js / room-ui.js 全文） ---- */
  var uiRaw = fs.readFileSync(path.join(ROOT, 'web/js/ui/room-ui.js'), 'utf8');
  ['rewindSheet', 'rewindCard', 'rollback.turn', 'pl_vote', '.rewind-card', 'voteCard', 'kpQuickActions'].forEach(function (tok) {
    ok(rpRaw.indexOf(tok) < 0, '★ 反向：room-panels.js 不含「' + tok + '」');
    ok(uiRaw.indexOf(tok) < 0, '★ 反向：room-ui.js 不含「' + tok + '」');
  });

  /* ---- 10) CSS：只删回退专用样式，且未触碰任何 .gp-grid 规则 ---- */
  var css = fs.readFileSync(path.join(ROOT, 'web/css/app.css'), 'utf8');
  ok(css.indexOf('.rewind-card') < 0 && css.indexOf('.vote-dots') < 0, '★ app.css 的回退专用样式已删');
  var vMark = css.indexOf('/* v2.9.0');
  ok(vMark >= 0, 'app.css 有 v2.9.0 删除标注');
  var win = vMark >= 0 ? css.slice(vMark, vMark + 400) : '';
  ok(win.indexOf('.gp-grid') < 0, '★ 新增 CSS（v2.9.0 标注处 400 字窗口）不含 .gp-grid');
  eq((css.match(/{/g) || []).length, (css.match(/}/g) || []).length, 'app.css 花括号配平');
})();
