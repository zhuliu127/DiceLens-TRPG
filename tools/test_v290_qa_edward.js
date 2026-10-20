/*
 * QA 独立探针 —— Edward (software-qa-engineer)
 * v2.9.0 三项独立回归。**自带 harness**，不复用工程师 test_v290_fixes.js 的辅助函数，
 * 也不共享其 fixture / 计数 —— 目的是「证明代码真的工作」，而非确认工程师的断言存在。
 *
 * 覆盖：
 *   第 1 项 TEMP_COMMIT：_advanceRound 计划带 to（真广播）；round.next / 战斗整轮折返 触发；
 *           「下一个行动」不触发；room.start 不触发；_onTempCommit 房号隔离 / 无本房卡静默 /
 *           多张全交 / 先提交后重绘；不入 save()、非 SECRET；commitTempCard 幂等。
 *   第 2 项 KP 工具箱：六组顺序 + 每回调在 kpPanel 段内恰好 1 次；定向指令 9 项标签+顺序；
 *           文案微调（对抗检定→对抗、🧠→🌀）；邀请加入可达。
 *   第 3 项 回退删除：POLICY 摘 rollback.turn 保留 commit/round/round.next；
 *           伪造 rollback.turn ACT 被拒且房间不进入 state.rewind 投票态（真跑）。
 *   跨组契约：TEMP_COMMIT 五处名字逐字一致 + onTempCommit 参数/回调签名对上。
 *
 * 运行： node tools/test_v290_qa_edward.js（工作目录 = 仓库根）
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

/* ---- 载入被测源码（global.window = global，与仓库其它测试同款） ---- */
global.window = global;
function makeLS() {
  var m = {}, keys = [];
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem: function (k, v) { if (!Object.prototype.hasOwnProperty.call(m, k)) keys.push(k); m[k] = String(v); },
    removeItem: function (k) {
      if (Object.prototype.hasOwnProperty.call(m, k)) { delete m[k]; keys = keys.filter(function (x) { return x !== k; }); }
    },
    key: function (i) { return keys[i] === undefined ? null : keys[i]; },
    clear: function () { m = {}; keys = []; },
    get length() { return keys.length; }
  };
}
global.localStorage = makeLS();

/* Store 假实现：原卡 + upsert 追踪 */
var CHARS = {
  'c-1': { id: 'c-1', characterName: '甲', status: { currentHP: 4, maxHP: 10, currentSAN: 60 } },
  'c-2': { id: 'c-2', characterName: '乙', status: { currentHP: 8, maxHP: 12, currentSAN: 70 } }
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
var E = M.EVT;

function mkHost(code, at) {
  return new M.Host({ meta: { code: code, name: 'QA团', kpName: 'KP', maxPlayers: 4 }, now: function () { return at || 111; } });
}
function mkSide(code, onTempCommit, onEvent) {
  return new N.PlayerSide({
    client: new M.Client({ seat: 's1', role: 'player' }),
    room: { code: code, wsUrl: 'ws://x/ws?code=' + code + '&t=t1', mtoken: 't1' },
    onTempCommit: onTempCommit,
    onEvent: onEvent
  });
}
function tempCommitText(seq, round, at) {
  return JSON.stringify(M.evtMsg({ seq: seq, evt: { t: E.TEMP_COMMIT, p: { round: round, at: at } } }));
}

/* ============================================================
 * 第 1 项 · 模型层：_advanceRound 广播 TEMP_COMMIT（带 to = 真能发出去）
 * ============================================================ */
section('QA 第1项 · _advanceRound 广播 + 计划带 to（真广播）');
(function () {
  var h = mkHost('q1a', 222);
  var plan = h._advanceRound([], 3);
  var evs = plan.filter(function (p) { return p.msg && p.msg.t === E.TEMP_COMMIT; });
  eq(evs.length, 1, '★ _advanceRound 产出恰好 1 条 TEMP_COMMIT');
  ok(evs[0] && evs[0].to === '*', '★ 计划项带 to:"*"（入发送计划 = 真广播，非只 emit 丢弃）', evs[0] && evs[0].to);
  eq(evs[0].msg.p.round, 3, '载荷 round = 3');
  eq(evs[0].msg.p.at, 222, '载荷 at = now()');
})();

/* round.next 触发 */
(function () {
  var h = mkHost('q1b', 1);
  var plan = h.applyAction('host', { op: 'round.next' });
  ok(plan.some(function (p) { return p.msg && p.msg.t === E.TEMP_COMMIT; }), '★ 探索态 round.next → 触发 TEMP_COMMIT');
  eq(h.state.meta.round, 1, 'round.next 推进回合到 1');
})();

/* 战斗态：整轮折返触发 / 下一个行动不触发 */
(function () {
  var h = mkHost('q1c', 1);
  h.applyAction('host', { op: 'combat.set', combat: {
    order: [{ slot: 's-a', name: 'A', dex: 70, done: false }, { slot: 'n1#1', name: 'B', dex: 50, done: false }],
    turn: 0, round: 1
  } });
  var c1 = h.applyAction('host', { op: 'combat.next' });   // 换人（同轮）
  var c2 = h.applyAction('host', { op: 'combat.next' });   // 走完一圈 → 折返 round+1
  ok(!c1.some(function (p) { return p.msg && p.msg.t === E.TEMP_COMMIT; }), '战斗「下一个行动」（不折返）不触发 TEMP_COMMIT');
  ok(c2.some(function (p) { return p.msg && p.msg.t === E.TEMP_COMMIT; }), '★ 战斗「整轮折返」（round+1）触发 TEMP_COMMIT');
  eq(h.state.combat.round, 2, '折返后战斗轮次 = 2');
})();

/* room.start 不触发 */
(function () {
  var h = mkHost('q1d', 1);
  var plan = h.applyAction('host', { op: 'room.start' });
  ok(!plan.some(function (p) { return p.msg && p.msg.t === E.TEMP_COMMIT; }), '★ 开局 room.start 不触发 TEMP_COMMIT');
  ok(plan.some(function (p) { return p.msg && p.msg.t === E.ROUND; }), 'room.start 仍照常 emit ROUND（回合边界保留）');
})();

/* 不进存档 + 非保密字段 */
(function () {
  var h = mkHost('q1e', 1);
  h.applyAction('host', { op: 'round.next' });
  ok(JSON.stringify(h.save()).indexOf('tempcommit') < 0, '★ save() 不含 tempcommit（不进存档）');
  ok(M.SECRET_KEYS.indexOf('tempcommit') < 0, 'SECRET_KEYS 不含 tempcommit（载荷可公开）');
})();

/* ============================================================
 * 第 1 项 · 传输层：PlayerSide._onTempCommit 真跑
 * ============================================================ */
section('QA 第1项 · _onTempCommit 房号隔离 / 静默 / 多张 / 顺序（真跑）');

/* (a) 本房卡 → commitTempCard 被调，committed=1；先提交后重绘 */
(function () {
  global.localStorage.clear(); upserts.length = 0;
  RS.ensureTempCard('ab12cd', 's1', 'c-1');
  var seen = [], order = [];
  global.Store.upsertCharacter = function (rec) { order.push('commit'); upserts.push(rec); return true; };
  var side = mkSide('ab12cd', function (p, r) { seen.push({ p: p, r: r }); }, function () { order.push('repaint'); });
  side._onText(tempCommitText(1, 2, 999));
  eq(upserts.length, 1, '★ 本房临时卡被 commitTempCard（原卡被覆盖 1 次）');
  eq(seen.length, 1, 'onTempCommit 回调 1 次');
  eq(seen[0].r.committed, 1, '★ committed = 1');
  eq(seen[0].p.round, 2, '回调收到载荷 round');
  ok(order.indexOf('commit') >= 0 && order.indexOf('repaint') >= 0 && order.indexOf('commit') < order.indexOf('repaint'),
     '★ 先提交（落库）后重绘（与 EVT.STATE 同款顺序）', order);
  global.Store.upsertCharacter = function (rec) { upserts.push(rec); return true; };
})();

/* (b) 无本房卡 → 静默，committed=0，不报错、不 upsert */
(function () {
  global.localStorage.clear(); upserts.length = 0;
  var seen = [], threw = false;
  var side = mkSide('nocard', function (p, r) { seen.push(r); }, function () {});
  try { side._onText(tempCommitText(1, 3, 1)); } catch (e) { threw = true; }
  ok(!threw, '★ 无本房临时卡 → 不抛异常（静默）');
  eq(upserts.length, 0, '★ 无本房临时卡 → 不调用 commitTempCard / 不 upsert');
  eq(seen.length, 1, '仍回调 onTempCommit（让 UI 决定不打扰）');
  eq(seen[0].committed, 0, '★ committed = 0（UI 据此不弹 toast）');
})();

/* (c) roomCode 隔离（重点）：别房卡不被误提交 */
(function () {
  global.localStorage.clear(); upserts.length = 0;
  RS.ensureTempCard('ab12cd', 's1', 'c-1');   // 本房
  RS.ensureTempCard('zzz999', 's1', 'c-2');   // 别房（续玩/多开）
  var seen = [];
  var side = mkSide('ab12cd', function (p, r) { seen.push(r); }, function () {});
  side._onText(tempCommitText(1, 2, 1));
  eq(upserts.length, 1, '★ 只提交本房 1 张（别房不误伤）');
  eq(upserts[0] && upserts[0].characterName, '甲', '提交的是本房卡（甲），不是别房的乙');
  ok(RS.getTempCard('zzz999', 'c-2').committed !== true, '★ 别房临时卡未被提交（roomCode 隔离）');
  eq(seen[0].committed, 1, 'committed 只计本房');
})();

/* (d) 多张同房卡 → 全部提交 */
(function () {
  global.localStorage.clear(); upserts.length = 0;
  RS.ensureTempCard('multi', 's1', 'c-1');
  RS.ensureTempCard('multi', 's2', 'c-2');
  var seen = [];
  var side = mkSide('multi', function (p, r) { seen.push(r); }, function () {});
  side._onText(tempCommitText(1, 5, 1));
  eq(upserts.length, 2, '★ 本房多张临时卡全部提交');
  eq(seen[0].committed, 2, 'committed = 2（两张都生效）');
})();

/* (e) commitTempCard 幂等：重复收到 TEMP_COMMIT，commitCount 递增但原卡内容一致 */
(function () {
  global.localStorage.clear(); upserts.length = 0;
  RS.ensureTempCard('idem', 's1', 'c-1');
  var side = mkSide('idem', function () {}, function () {});
  side._onText(tempCommitText(1, 2, 1));
  var first = JSON.stringify(upserts[upserts.length - 1]);
  side._onText(tempCommitText(2, 3, 1));
  var second = JSON.stringify(upserts[upserts.length - 1]);
  var rec = RS.getTempCard('idem', 'c-1');
  eq(rec.commitCount, 2, '★ commitCount 递增到 2（允许反复生效）');
  eq(first, second, '★ 两次 upsert 的原卡内容逐字一致（幂等，无副作用漂移）');
})();

/* ============================================================
 * 第 3 项 · POLICY + 伪造 ACT 被拒（真跑，且不进入投票态）
 * ============================================================ */
section('QA 第3项 · rollback.turn 入口关闭（真跑）');
(function () {
  var R = M.ROLE;
  ok(!M.allowed(R.KP, 'rollback.turn'), '★ rollback.turn 不在 POLICY（allowed=false）');
  ok(M.POLICY['rollback.turn'] === undefined, 'POLICY 表无 rollback.turn 条目');
  ok(M.allowed(R.KP, 'rollback.commit'), 'rollback.commit 的 POLICY 休眠保留');
  ok(M.allowed(R.KP, 'rollback.round'), 'rollback.round 的 POLICY 保留');
  ok(M.allowed(R.KP, 'round.next'), '★ round.next（推进侧）保留');

  /* 休眠保留：方法 / 事件 / 枚举 / INTENT 仍在（旧存档回放兼容） */
  var h = mkHost('q3', 1);
  eq(typeof h.rollbackPropose, 'function', 'rollbackPropose 方法休眠保留');
  eq(typeof h.rollbackVote, 'function', 'rollbackVote 方法休眠保留');
  eq(typeof h.rollbackCommit, 'function', 'rollbackCommit 方法休眠保留');
  ok(E.REWIND === 'rewind', 'EVT.REWIND 保留');
  ok(M.REWIND && M.REWIND.VOTING === 'VOTING', 'REWIND.VOTING 枚举保留');
  ok(M.INTENT && M.INTENT.VOTE === 'vote', 'INTENT.VOTE 保留');

  /* 伪造 rollback.turn ACT 一律被拒 + 房间不进入投票态 */
  var out = h.intent('host', M.intentMsg(M.INTENT.ACT, { op: 'rollback.turn', turns: 1 }));
  ok(!h.rewind || h.rewind.state !== M.REWIND.VOTING, '★ 伪造 rollback.turn ACT 不进入 state.rewind 投票态');
  ok(out.some(function (r) { return r.to === 'host' && /没有权限/.test(JSON.stringify(r.msg)); }),
     '★ 伪造 rollback.turn ACT → 「没有权限」（被 needs/allowed 拦下）');
})();

/* ============================================================
 * 第 2 项 · KP 工具箱六组顺序 + 回调唯一性（源码段分析，仓库既定范式）
 * ============================================================ */
section('QA 第2项 · kpPanel 六组顺序 + 回调恰好 1 次 + 定向指令 9 项');
(function () {
  function strip(s) { return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1'); }
  var rp = strip(fs.readFileSync(path.join(ROOT, 'web/js/ui/room-panels.js'), 'utf8'));
  function segOf(name) {
    var i = rp.indexOf('function ' + name + '(');
    if (i < 0) return '';
    var rest = rp.slice(i + 1);
    var m = /\r?\n  function /.exec(rest);
    return rest.slice(0, m ? m.index : rest.length);
  }
  function cnt(hay, needle) { return hay.split(needle).length - 1; }
  var kp = segOf('kpPanel');
  ok(kp.length > 0, '能取到 kpPanel 源码段（函数名锚定）');

  /* 六组相对顺序（组④ 定向指令是独立卡 kpDirectivesCard(ctx) 调用点） */
  var orderTokens = [
    { g: '① 回合与时间', key: "text: '回合与时间'" },
    { g: '② 检定与骰子', key: "text: '检定与骰子'" },
    { g: '③ 战斗', key: "text: '战斗'" },
    { g: '④ 定向指令卡', key: 'kpDirectivesCard(ctx)' },
    { g: '⑤ 场景与素材', key: "text: '场景与素材'" },
    { g: '⑥ 房间管理', key: "text: '房间管理'" }
  ];
  var last = -1, mono = true;
  orderTokens.forEach(function (o) {
    var idx = kp.indexOf(o.key);
    if (idx < 0) { ok(false, '分组标题缺失：' + o.g); mono = false; return; }
    if (idx <= last) mono = false;
    last = idx;
  });
  ok(mono, '★ 六组相对顺序正确（①→⑥）');

  /* 每个按钮回调在 kpPanel 段内恰好 1 次（"未改功能"硬证据） */
  [['round.next', '⏭进入下一回合'], ['pushCheckSheet', '🎲要求检定'], ['roomRulesSheet', '⚖检定成败阈值'],
   ['opposedSheet', '⚔对抗'], ['clueSheet', '📩递线索'], ['inviteForRoom', '✉️邀请加入'],
   ['saveSlotsSheet', '💾保存本局'], ['endSession', '🏁结团']].forEach(function (pair) {
    eq(cnt(kp, pair[0]), 1, '回调 ' + pair[0] + '（' + pair[1] + '）在 kpPanel 内恰好 1 次');
  });

  /* 定向指令 9 项标签齐全且顺序不变 */
  var dir = segOf('kpDirectivesCard');
  var labels = ['💥 造成伤害', '🌫 临时状态', '🎒 给物品', '🧠 SAN Check', '🕶 暗骰',
                '🌀 追加理智损失', '💊 治愈疯狂', '🩹 治愈伤势', '🚑 急救 / 医学'];
  var dlast = -1, dmono = true;
  labels.forEach(function (lb) {
    var idx = dir.indexOf("'" + lb + "'");
    if (idx < 0) { ok(false, '定向指令标签缺失：' + lb); dmono = false; return; }
    if (idx <= dlast) dmono = false;
    dlast = idx;
  });
  ok(dmono, '★ 定向指令 9 项标签齐全且顺序不变');

  /* 文案/图标微调 */
  ok(rp.indexOf('⚔️ 对抗检定') < 0, '旧文案「⚔️ 对抗检定」已不存在');
  ok(kp.indexOf("'⚔ 对抗'") >= 0, '新文案「⚔ 对抗」存在');
  ok(dir.indexOf('🧠 追加理智损失') < 0, '旧图标「🧠 追加理智损失」已被替换');
  ok(dir.indexOf('🌀 追加理智损失') >= 0, '★ 新图标「🌀 追加理智损失」存在（避免与 🧠SAN Check 重图标）');

  /* ✉️ 邀请加入在 kpPanel 内可达（房间管理组） */
  ok(kp.indexOf('inviteForRoom') >= 0, '★ 「✉️ 邀请加入」在 kpPanel 内可达（补进房间管理组）');

  /* 死代码 kpQuickActions 全删 */
  ok(rp.indexOf('kpQuickActions') < 0, '★ 死代码 kpQuickActions 已从 room-panels.js 删除');
})();

/* ============================================================
 * 跨组契约：TEMP_COMMIT 五处名字逐字一致 + 回调签名对上
 * ============================================================ */
section('QA 跨组契约 · TEMP_COMMIT 五处一致 + onTempCommit 签名');
(function () {
  var model = fs.readFileSync(path.join(ROOT, 'web/js/core/room-model.js'), 'utf8');
  var net = fs.readFileSync(path.join(ROOT, 'web/js/core/room-net.js'), 'utf8');
  var ui = fs.readFileSync(path.join(ROOT, 'web/js/ui/room-ui.js'), 'utf8');

  ok(/TEMP_COMMIT:\s*'tempcommit'/.test(model), '① EVT 表：TEMP_COMMIT: \'tempcommit\'');
  ok(/emit\(EVT\.TEMP_COMMIT/.test(model), '② _advanceRound：emit(EVT.TEMP_COMMIT, …)');
  ok(/m\.t === MODEL\.EVT\.TEMP_COMMIT\) this\._onTempCommit/.test(net), '③ room-net _onText：MODEL.EVT.TEMP_COMMIT 分支');
  ok(/PlayerSide\.prototype\._onTempCommit = function/.test(net), '④ room-net：PlayerSide.prototype._onTempCommit 定义');
  ok(/onTempCommit: onTempCommitNotify\(gen\)/.test(ui) && ui.split('onTempCommit: onTempCommitNotify(gen)').length - 1 === 2,
     '⑤ room-ui：两处 PlayerSide 都接 onTempCommitNotify(gen)');

  /* 构造参数与回调签名对上 */
  ok(/this\.onTempCommit = opts\.onTempCommit \|\| null/.test(net), '构造读 opts.onTempCommit');
  ok(/this\.onTempCommit\(p \|\| \{\}, \{ committed: committed \}\)/.test(net), '回调签名 onTempCommit(p, {committed})');
  ok(/return function \(p, r\) \{[\s\S]*?var n = \(r && r\.committed\)/.test(ui), 'UI 侧 onTempCommitNotify 返回 (p,r) 读 r.committed（签名匹配）');
  ok(/if \(n > 0 && global\.UI && global\.UI\.toast\)/.test(ui), '★ committed>0 才 toast（committed=0 不打扰）');
  ok(/不可撤销/.test(ui), 'toast 文案含「不可撤销」覆盖提示');
})();

/* ---- 汇总 ---- */
process.on('exit', function () {
  console.log('\n' + '='.repeat(60));
  if (fail) {
    console.log('失败 ' + fail + ' 项：');
    failures.forEach(function (f) { console.log('  ✗ ' + f); });
  }
  console.log('v2.9.0 QA 独立探针（Edward）: ' + pass + ' passed, ' + fail + ' failed');
  console.log('RESULT: ' + (fail ? 'FAIL' : 'PASS'));
  process.exitCode = fail ? 1 : 0;
});
