/*
 * v2.6.0 独立回归（Engineer · 寇豆码）—— 本文件由多名工程师按小节 append 汇总。
 *
 *   本小节由 software-engineer（寇豆码）负责：**第 1 / 2 / 4 / 5 项**
 *     · 第 1 项 asset.cover：KP 指定「已公开」素材为中央底图（模型行为 + UI 静态证据链）
 *     · 第 2 项 中央底图只认已公开素材（mapBackground 删除 KP 私库兜底）
 *     · 第 4 项 rulesSheet 大成功/大失败口径随房规动态生成
 *     · 第 5 项 死亡 / 永久疯狂角色不能做 SAN Check / 追加理智损失
 *     · 第 3 / 6 项（software-engineer-2 · 寇豆码）：玩家只能在自己的行动轮次发起战斗对抗；
 *       状态管理 HP/SAN 判定在「玩家自助」与「KP 请求 consent」两条入口统一；当前 HP/SAN 以角色上限夹紧。
 *
 *   ⚠️ 另一位工程师（负责第 3 / 6 项）会在本文件**末尾 append** 自己的小节；
 *     为避免「汇总早于追加的断言执行」，本文件的汇总/ RESULT 走 process.on('exit')，
 *     任何后追加的代码都会先跑完再汇总。
 *
 * 运行： node tools/test_v260_fixes.js（工作目录 = 仓库根）
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

function feeder(seq) { var i = 0; return function () { return seq[i++ % seq.length]; }; }
function readSrc(rel) { return fs.readFileSync(path.join(base, rel), 'utf8'); }
function stripComments(text) { return text.replace(/\/\*[\s\S]*?\*\//g, ''); }
var rpClean = stripComments(readSrc('ui/room-panels.js'));

/* 计划里所有文本（含公共日志 / 系统提示 / 事件载荷）拼成的可检索串 */
function planText(o) { return JSON.stringify(o || []); }
function hasEvt(o, t) { return (o || []).some(function (r) { return r.msg && r.msg.t === t; }); }

/** 造一个最小 Host（素材相关方法只依赖 state.scene / localAssets，无需玩家） */
function mkAssetHost() {
  return new M.Host({ rules: R, rng: feeder([0.3, 0.0]), madness: null, now: function () { return 1000; } });
}

/* 按函数名切出函数体（剥注释后），避免跨函数误命中 */
function segOf(name) {
  var i = rpClean.indexOf('function ' + name + '(');
  if (i < 0) return '';
  var rest = rpClean.slice(i + 1);
  var m = /\r?\n  function /.exec(rest);
  return rest.slice(0, m ? m.index : rest.length);
}

/* ============================================================
 * 第 1 项 · asset.cover：KP 指定「已公开」素材为中央底图（模型行为）
 * ============================================================ */
section('第 1 项 asset.cover —— 权限');
(function () {
  ok(M.allowed(M.ROLE.KP, 'asset.cover') === true, "POLICY 允许 KP：asset.cover");
  ok(M.allowed(M.ROLE.PLAYER, 'asset.cover') === false, "POLICY 拒绝玩家：asset.cover");
  eq(M.needs(M.ROLE.KP, 'asset.cover').confirm, null, 'asset.cover 无需二次确认（KP 点击即生效）');
})();

section('第 1 项 asset.cover —— 只能选「已公开」素材 / 空 id 清除 / 清理悬空引用');
(function () {
  var host = mkAssetHost();

  /* 上传一张（未公开）—— 此时 scene.image 仍为空 */
  host.addAsset({ kind: 'map', name: '洋馆一层', data: 'data:image/png;base64,AAA' });
  var idA = host.localAssets[host.localAssets.length - 1].id;

  /* (1) 未公开素材 → 拒绝，且不改 image、不发 EVT.SCENE */
  var outReject = host.coverAsset(idA);
  eq((host.state.scene || {}).image || '', '', '未公开素材被拒 → scene.image 不变');
  ok(!hasEvt(outReject, M.EVT.SCENE), '未公开素材被拒 → 不广播 EVT.SCENE');
  ok(/只能把「已公开」的素材设为底图/.test(planText(outReject)),
     '未公开素材被拒 → 明确提示「只能把『已公开』的素材设为底图」', planText(outReject));

  /* (2) 公开后再设为底图 → 成功，image=id，广播 SCENE，写公开日志 */
  host.revealAsset(idA, true);
  var outOk = host.coverAsset(idA);
  eq(host.state.scene.image, idA, '已公开素材 → scene.image 命中该 id');
  ok(hasEvt(outOk, M.EVT.SCENE), '设为底图 → 广播 EVT.SCENE 同步全员');
  ok(/KP 把底图换成了「洋馆一层」/.test(planText(outOk)),
     '设为底图 → 写一条公开记录解释底图变化', planText(outOk));

  /* (3) 隐藏当前底图 → 悬空 image 被清掉（否则 mapBackground 会「跳」到另一张） */
  var outHide = host.revealAsset(idA, false);
  eq(host.state.scene.image || '', '', '隐藏当前底图 → scene.image 被清空（不留悬空引用）');
  ok(hasEvt(outHide, M.EVT.SCENE), '隐藏当前底图 → 额外广播 SCENE 同步「底图已清」');
  ok(!host.state.scene.assets.some(function (x) { return x.id === idA; }),
     '隐藏后该素材已不在公共 scene.assets');

  /* (4) 删除当前底图 → 同样清掉悬空 image */
  host.revealAsset(idA, true);
  host.coverAsset(idA);
  eq(host.state.scene.image, idA, '（重建）重新公开并设为底图');
  var outDel = host.delAsset(idA);
  eq(host.state.scene.image || '', '', '删除当前底图 → scene.image 被清空');
  ok(/scene/.test(planText(outDel)) && hasEvt(outDel, M.EVT.SCENE),
     '删除当前底图 → 广播 SCENE 让全员同步底图消失');

  /* (5) 空 id → 清除底图（回落第一张已公开图片的兜底） */
  host.addAsset({ kind: 'map', name: '密室', data: 'data:image/png;base64,BBB' });
  var idB = host.localAssets[host.localAssets.length - 1].id;
  host.revealAsset(idB, true);
  host.coverAsset(idB);
  eq(host.state.scene.image, idB, '（重建）idB 成为底图');
  var outClear = host.coverAsset('');
  eq(host.state.scene.image || '', '', '空 id → 清除底图（回落「第一张已公开图片」兜底）');
  ok(/KP 清除了中央底图/.test(planText(outClear)), '清除底图 → 写一条公开记录');
})();

/* ============================================================
 * 第 2 项 · 中央底图只认已公开素材（去掉 KP 私库兜底）—— UI 静态证据链
 * ============================================================ */
section('第 2 项 mapBackground 只认已公开素材（静态证据链 + 变异防护）');
(function () {
  var bg = segOf('mapBackground');
  ok(bg.length > 0, '从 room-panels.js 抠出 mapBackground 源码', bg.slice(0, 80));
  ok(/scene\.image/.test(bg), 'mapBackground 优先读 scene.image（KP 显式指定的底图）');
  ok(!/localAssets/.test(bg),
     '★ mapBackground 里不再有 KP 私库(localAssets)兜底 → KP 与玩家看到的底图一致');
  ok(/scene\.(assets)/.test(bg), 'mapBackground 仍从 scene.assets（仅含已公开素材）取图');

  /* 私库列表本身保留 —— 供 KP 管理「未公开素材」（公开/隐藏/删除） */
  ok(/localAssets/.test(segOf('collectAssets')),
     'collectAssets 仍并列 KP 私库（保留「KP 管理未公开素材」的职责）');
})();

/* ============================================================
 * 第 4 项 · rulesSheet 大成功/大失败口径随房规动态生成 —— UI 静态证据链
 * ============================================================ */
section('第 4 项 rulesSheet 动态房规（静态证据链）');
(function () {
  var rs = segOf('rulesSheet');
  ok(rs.length > 0, '从 room-panels.js 抠出 rulesSheet 源码', rs.slice(0, 80));
  ok(!/01（或检定成功且 ≤ 5）/.test(rs),
     '★ rulesSheet 不再含硬编码死文案「01（或检定成功且 ≤ 5）」');
  ok(!/01（或检定成功且 ≤ 5）/.test(rpClean), '（全量）该硬编码死文案在 room-panels 全文件已消失');
  ok(/critThreshold/.test(rs), 'rulesSheet 读 meta.critThreshold');
  ok(/fumbleThreshold/.test(rs), 'rulesSheet 读 meta.fumbleThreshold');
  ok(/规则书默认/.test(rs), '缺字段时显示规则书默认口径并标注「默认」');
  ok(/房规自定义/.test(rs), '自定义时显示房规值');
  ok(/critLine \+ fumLine/.test(rs), '两段文案拼进同一条说明（结构与原样一致）');
})();

/* ============================================================
 * 第 5 项 · 死亡 / 永久疯狂不能 SAN Check / 追加理智损失 —— UI 静态证据链
 * ============================================================ */
section('第 5 项 撕卡（死亡/永久疯狂）拦截（静态证据链 + 变异防护）');
(function () {
  var rip = segOf('isMemberRippedU');
  ok(rip.length > 0, '定义了 isMemberRippedU');
  ok(/body === '死亡'/.test(rip), "isMemberRippedU 判死只认 body === '死亡'");
  ok(/indexOf\('永久疯狂'\)/.test(rip), "isMemberRippedU 也判「永久疯狂」");
  ok(!/hp\s*<=?\s*0/.test(rip) && !/currentHP\s*<=?\s*0/.test(rip),
     '★ 绝不用 hp<=0 判死（hp:0 在没登记血量的单位上不代表死亡）');

  var sb = segOf('sanBlocked');
  ok(/isMemberMadActive\(m\)/.test(sb) && /isMemberRippedU\(m\)/.test(sb),
     'sanBlocked = 疯狂发作中 或 已撕卡');

  ok(/skip: sanBlocked/.test(segOf('sanForPlayer')),
     'SAN Check：选人列表跳过「疯狂发作中 或 已撕卡」的玩家');
  ok(/skip: sanBlocked/.test(segOf('sanLossForPlayer')),
     '追加理智损失：选人列表跳过「疯狂发作中 或 已撕卡」的玩家');

  ok(/if \(isMemberRippedU\(m\)\)/.test(segOf('sanForPlayer')),
     'SAN Check 选中后兜底：补了「已撕卡」分支');
  ok(/if \(isMemberRippedU\(m\)\)/.test(segOf('sanLossForPlayer')),
     '追加理智损失选中后兜底：补了「已撕卡」分支');
  ok(/已撕卡（死亡\/永久疯狂），不能做 SAN Check/.test(segOf('sanForPlayer')),
     '死亡分支提示与「疯狂发作」分支区分（明确说「已撕卡」）');
  ok(/已撕卡（死亡\/永久疯狂），不能追加理智损失/.test(segOf('sanLossForPlayer')),
     '死亡分支提示与「疯狂发作」分支区分（明确说「已撕卡」）');

  var st = segOf('saneTargets');
  ok(/isMemberRippedU/.test(st),
     'saneTargets（* 全量分支）也排除已撕卡角色');
  ok(/名已撕卡/.test(st), 'saneTargets 汇报被跳过的「已撕卡」人数');
})();

/* ============================================================
 * 汇总 —— 在进程退出时打印，方便另一位工程师在其后 append 自己的小节
 * ============================================================ */
process.on('exit', function () {
  console.log('\nv2.6.0 fixes regression: ' + pass + ' passed, ' + fail + ' failed');
  console.log('RESULT: ' + (fail ? 'FAIL' : 'PASS'));
  if (fail) process.exitCode = 1;
});


/* ============================================================
 * 第 3 / 6 项 · software-engineer-2（寇豆码）append 小节
 *   · 第 3 项：玩家只能在自己的行动轮次发起战斗对抗（UI + 模型双层）
 *   · 第 6 项：状态管理 HP/SAN 判定（玩家自助 / KP 请求 consent 统一）
 *               + 当前 HP/SAN 以角色上限 maxHP/maxSAN 夹紧
 * ============================================================ */
section('第 3 项 玩家只能在自己的行动轮次发起战斗对抗');

/* —— 工具：造 Host（s1=小美 / s2=小刚，均带卡；可选战斗行动序） —— */
function mkCombatHost(order, turn) {
  var host = new M.Host({ rules: R, rng: feeder([0.3, 0.0]), madness: null, now: function () { return 1000; } });
  host.roster.open({ seat: 's1', role: M.ROLE.PLAYER, nickname: '小美' });
  host.roster.open({ seat: 's2', role: M.ROLE.PLAYER, nickname: '小刚' });
  function sheet(name) {
    return { name: name, attrs: { str: 60, con: 50, int: 50, pow: 50 },
             status: { currentHP: 12, maxHP: 12, currentSAN: 50, maxSAN: 50 },
             skills: [{ name: '格斗（斗殴）', total: 60 }, { name: '闪避', total: 50 }],
             weapons: [{ name: '匕首', skill: '斗殴', damage: '1D4', pierce: '\u00d7' }],
             madness: [], mental: ['正常'], db: '0' };
  }
  var m1 = host.roster.get('s1'), m2 = host.roster.get('s2');
  m1.charName = '小美'; m1.sheet = sheet('小美');
  m2.charName = '小刚'; m2.sheet = sheet('小刚');
  host.state.combat = { order: (order || []), turn: (turn == null ? 0 : turn), round: 1, startedAt: 0 };
  host.state.meta.status = M.STATUS.IN_GAME;
  host.state.meta.mode = M.MODE.COMBAT;
  return host;
}
function pcSlot(seat, name) {
  return { id: seat + '#0', actorId: seat, seat: seat, kind: 'pc', name: name, public: { hp: 12, hpMax: 12 } };
}
var PC_A = { id: 's1#0', actorId: 's1', seat: 's1', kind: 'pc', name: '小美', public: { hp: 12, hpMax: 12 } };
var PC_B = { id: 's2#0', actorId: 's2', seat: 's2', kind: 'pc', name: '小刚', public: { hp: 12, hpMax: 12 } };
var MON1 = { id: 'a1', actorId: 'm1', kind: 'monster', name: '食尸鬼', public: { hp: 10, hpMax: 10 } };
function picksOf(out, t) {
  return (out || []).filter(function (r) { return r && r.msg && r.msg.t === t; })
    .map(function (r) { return r.msg.p || {}; });
}
function anyText(out, re) {
  return (out || []).some(function (r) {
    return r && r.msg && (r.msg.t === M.EVT.PRIVATE || r.msg.t === M.EVT.LOG) &&
      re.test((r.msg.p && (r.msg.p.text || r.msg.p.summary)) || '');
  });
}
var REQ = { phase: 'request', weapon: { name: '匕首' }, targetId: 'm1', targetName: '食尸鬼', shots: 1 };

(function () {
  /* ① 非本人轮次（轮到别人）→ 模型拒绝，不建待办 */
  var h = mkCombatHost([PC_B, MON1], 0);            // 当前轮到 s2
  var out = h.intent('s1', { op: M.INTENT.OPPOSED, p: REQ });
  ok(h.state.opposed === null, '① 非本人轮次（轮到别人）→ 不建待办（state.opposed=null）');
  ok(anyText(out, /只能在你的行动轮次发起战斗对抗/),
     '① 非本人轮次 → 明确提示「只能在你的行动轮次发起战斗对抗」', JSON.stringify(picksOf(out, M.EVT.PRIVATE)));
  ok(picksOf(out, M.EVT.OPPOSED).length === 0, '① 非本人轮次 → 不向 KP 发 EVT.OPPOSED');

  /* ② 怪物轮次 → 玩家发起被拒 */
  var h2 = mkCombatHost([MON1, PC_A], 0);           // 当前轮到怪物
  var out2 = h2.intent('s1', { op: M.INTENT.OPPOSED, p: REQ });
  ok(h2.state.opposed === null, '② 怪物行动轮次 → 玩家发起被拒（不建待办）');
  ok(anyText(out2, /只能在你的行动轮次发起战斗对抗/), '② 怪物轮次 → 同一条拒绝提示');

  /* ③ 本人轮次 → 正常通过（建待办 await_kp + 通知 KP） */
  var h3 = mkCombatHost([PC_A, MON1], 0);           // 当前轮到 s1
  var out3 = h3.intent('s1', { op: M.INTENT.OPPOSED, p: REQ });
  ok(h3.state.opposed && h3.state.opposed.phase === 'await_kp',
     '③ 本人轮次 → 正常受理（await_kp）', JSON.stringify(h3.state.opposed && h3.state.opposed.phase));
  ok(picksOf(out3, M.EVT.OPPOSED).length >= 1, '③ 本人轮次 → 向 KP 发出 EVT.OPPOSED');

  /* ③b 同一 pc 的多个行动槽：轮到该 pc 的任一槽都算「本人轮次」 */
  var PC_A2 = { id: 's1#1', actorId: 's1', seat: 's1', kind: 'pc', name: '小美', public: { hp: 12, hpMax: 12 } };
  var h3b = mkCombatHost([MON1, PC_A2], 1);
  var out3b = h3b.intent('s1', { op: M.INTENT.OPPOSED, p: REQ });
  ok(h3b.state.opposed && h3b.state.opposed.phase === 'await_kp', '③b 轮到该 pc 的第 2 个行动槽 → 同样放行');

  /* ④ 防误伤回归：KP 发起的 check.opposed（被攻击时的反击 / 闪避）不受影响 */
  var h4 = mkCombatHost([MON1, PC_A, PC_B], 0);     // 当前轮到怪物（不是玩家轮次）
  var out4 = h4.checkOpposed('host', { attack: true,
    attacker: { side: 'monster', actorId: 'm1', name: '食尸鬼', skill: '爪击', value: 55 },
    defender: { side: 'pc', seat: 's1', skill: '闪避', reaction: 'dodge' },
    weapon: { name: '爪', damage: '1D6', pierce: '\u00d7', db: '0' }, armor: { value: 0 } });
  ok(picksOf(out4, M.EVT.CHECK).length >= 1,
     '④ KP 发起 check.opposed（反击/闪避）在非玩家轮次仍正常结算出结果卡');
  ok(!anyText(out4, /只能在你的行动轮次/), '④ check.opposed 不出现「只能在你的行动轮次」误伤提示');

  /* ⑤ 防误伤回归：胜后「选目标」阶段不属「发起」，不受轮次门禁 */
  var MONS = [{ id: 'm1', actorId: 'm1', kind: 'monster', name: '食尸鬼', public: { hp: 9, hpMax: 9 } },
              { id: 'm2', actorId: 'm2', kind: 'monster', name: '深潜者', public: { hp: 8, hpMax: 8 } }];
  var h5 = mkCombatHost([PC_A, MONS[0], MONS[1]], 0);
  h5.intent('s1', { op: M.INTENT.OPPOSED, p: { phase: 'request', weapon: { name: '匕首' }, targetId: 'm1' } });
  var rid = h5.state.opposed && h5.state.opposed.id;
  h5.checkOpposed('host', { attack: true, reqId: rid, defender: { reaction: 'counter', value: 60 }, armor: { value: 0 } });
  ok(h5.state.opposed && h5.state.opposed.phase === 'await_target', '⑤（前置）玩家胜 → 进入 await_target');
  h5.state.combat.turn = 1;   // 把当前行动轮挪到怪物（模拟 KP 已推进）
  var before = h5.state.combat.order[2].public.hp;
  h5.intent('s1', { op: M.INTENT.OPPOSED, p: { phase: 'target', targetId: 'm2' } });
  ok(h5.state.combat.order[2].public.hp < before,
     '⑤ 选目标阶段（非当前轮次）仍可结算伤害（只拦「发起」，不拦「收尾」）',
     before + '→' + h5.state.combat.order[2].public.hp);

  /* ⑥ UI 静态证据链：按钮 disabled 与打开面板时的二次校验 */
  var rpSrc = readSrc('ui/room-panels.js');
  ok(/disabled:\s*!_myTurnNow/.test(rpSrc),
     '⑥ UI：opposedBtn.disabled 依据「当前轮次是否本人」（!_myTurnNow）');
  ok(/_myTurnNow\s*=\s*inCombat\s*&&\s*isMyTurn\(ctx,\s*_combatCur\)/.test(rpSrc),
     '⑥ UI：_myTurnNow = inCombat && isMyTurn(ctx, combat.order[combat.turn])（与模型同口径）');
  ok(/现在不是你的行动轮次/.test(rpSrc),
     '⑥ UI：禁用时的提示文案明确说明「现在不是你的行动轮次」');
  ok(/function playerOpposedSheet\(ctx\)/.test(rpSrc) &&
     /if \(!c \|\| !isMyTurn\(ctx, cur\)\)/.test(segOf3('playerOpposedSheet')),
     '⑥ UI：playerOpposedSheet 打开时再校验一次轮次（防按钮状态过期）');
})();

/* 按函数名抠函数体（本文件顶部 segOf 用 rpClean；这里多给一个别名便于阅读） */
function segOf3(name) { return segOf(name); }

/* ============================================================
 * 第 6 项 · 状态管理 HP/SAN 判定统一（stateSelf ⇄ consent）+ 上限夹紧
 * ============================================================ */
section('第 6a/6b 项 状态管理判定 + 上限夹紧');

/* —— 工具：玩家的 KP 状态请求 → 玩家同意 —— */
function requestAndConsent(host, seat, change, reason) {
  host.intent('host', { op: M.INTENT.ACT, p: { op: 'state.request', seat: seat, change: change, reason: reason || '测试' } });
  var rec = (host._requestsBySeat[seat] || []);
  var id = rec.length ? rec[rec.length - 1].id : null;
  return host.intent(seat, { op: M.INTENT.CONSENT, p: { id: id, agree: true } });
}

(function () {
  /* 6a-① KP 请求改 HP→0（consent）→ 触发濒死/死亡判定（修复「KP 改 0 不被判死」缺口） */
  var h = mkCombatHost([], 0);
  var m = h.roster.get('s1');
  var out = requestAndConsent(h, 's1', { hp: 0 }, '被诅咒');
  eq(m.runtime.hp, 0, '6a-① consent：m.runtime.hp 写为 0');
  eq(m.sheet.status.currentHP, 0, '6a-① consent：写回 m.sheet.status.currentHP=0（原来连状态都不写）');
  // v2.10.0（R5）：'濒死' 从 body 白名单移除，改为 dying 标记 —— body='重伤' + dying=true 合成视图 '濒死'
  ok(m.sheet.status.body === '死亡' || m.sheet.status.body === '重伤',
     '6a-① consent 改 HP→0 → 出现死亡/濒死判定（R5：重伤+dying 或死亡）', m.sheet.status.body);
  ok(m.sheet.status.body === '重伤' && m.sheet.status.dying === true,
     '6a-① consent 改 HP→0（有重伤）→ 濒死（R5：body=重伤 + dying=true；归零当刻不再掷 CON，故无 DICE）');

  /* 6a-② KP 请求改 SAN→0（consent）→ 永久疯狂 */
  var h2 = mkCombatHost([], 0);
  var m2 = h2.roster.get('s1');
  requestAndConsent(h2, 's1', { san: 0 }, '看到不可名状之物');
  eq(m2.sheet.status.currentSAN, 0, '6a-② consent：SAN 写为 0');
  ok((m2.sheet.mental || []).indexOf('永久疯狂') >= 0, '6a-② consent 改 SAN→0 → 永久疯狂');

  /* 6a-③ KP 请求净减 SAN（仍 > 0）→ 复用 _afterSanLoss（临时/不定疯狂判定） */
  var h3 = mkCombatHost([], 0);
  var m3 = h3.roster.get('s1');
  var spy = [];
  var origAfter = h3._afterSanLoss;
  h3._afterSanLoss = function (mm, loss, bySeat) { spy.push(loss); return origAfter.apply(this, arguments); };
  requestAndConsent(h3, 's1', { san: 45 }, '理智受创');
  eq(m3.sheet.status.currentSAN, 45, '6a-③ consent：SAN 50→45');
  ok(spy.length === 1 && spy[0] === 5, '6a-③ consent 净减 SAN 5 → 调用 _afterSanLoss(5)（与 stateSelf 同口径）', JSON.stringify(spy));

  /* 6a-④ 玩家自助 stateSelf 行为保持不变：净减 SAN 仍触发 _afterSanLoss */
  var h4 = mkCombatHost([], 0);
  var m4 = h4.roster.get('s1');
  var spy2 = [];
  var origAfter2 = h4._afterSanLoss;
  h4._afterSanLoss = function (mm, loss, bySeat) { spy2.push(loss); return origAfter2.apply(this, arguments); };
  h4.intent('s1', { op: M.INTENT.ACT, p: { op: 'state.self', status: { currentSAN: 46 } } });
  ok(spy2.length === 1 && spy2[0] === 4, '6a-④ stateSelf 净减 SAN 4 → 调用 _afterSanLoss(4)（行为不变）', JSON.stringify(spy2));

  /* 6b-① 玩家自助 stateSelf：currentHP/currentSAN 夹到角色上限 */
  var h5 = mkCombatHost([], 0);
  var m5 = h5.roster.get('s1');
  h5.intent('s1', { op: M.INTENT.ACT, p: { op: 'state.self', status: { currentHP: 999, currentSAN: 999 } } });
  eq(m5.sheet.status.currentHP, 12, '6b-① stateSelf：currentHP 999 → 夹到 maxHP 12');
  eq(m5.sheet.status.currentSAN, 50, '6b-① stateSelf：currentSAN 999 → 夹到 maxSAN 50');

  /* 6b-② KP 请求 consent：currentHP/currentSAN 同样夹到角色上限 */
  var h6 = mkCombatHost([], 0);
  var m6 = h6.roster.get('s1');
  requestAndConsent(h6, 's1', { hp: 999, san: 999 }, '越界');
  eq(m6.sheet.status.currentHP, 12, '6b-② consent：currentHP 999 → 夹到 maxHP 12');
  eq(m6.sheet.status.currentSAN, 50, '6b-② consent：currentSAN 999 → 夹到 maxSAN 50');

  /* 6b-③ 硬守卫 max=0：上限未登记（0）时**不夹到 0**（否则正常角色被清零） */
  var h7 = mkCombatHost([], 0);
  var m7 = h7.roster.get('s1');
  m7.sheet.status = { currentHP: 5, maxHP: 0, currentSAN: 30, maxSAN: 0 };
  h7.intent('s1', { op: M.INTENT.ACT, p: { op: 'state.self', status: { currentHP: 7, currentSAN: 33 } } });
  eq(m7.sheet.status.currentHP, 7, '6b-③ maxHP=0（未登记）→ currentHP 7 不被夹到 0');
  eq(m7.sheet.status.currentSAN, 33, '6b-③ maxSAN=0（未登记）→ currentSAN 33 不被夹到 0');

  /* 6b-④ 同一次请求同时改 max 与 current：以「新上限」夹现值 */
  var h8 = mkCombatHost([], 0);
  var m8 = h8.roster.get('s1');
  h8.intent('s1', { op: M.INTENT.ACT, p: { op: 'state.self', status: { currentHP: 9, maxHP: 4 } } });
  eq(m8.sheet.status.currentHP, 4, '6b-④ 同一请求 maxHP 4 + currentHP 9 → 现值夹到新上限 4');
  eq(m8.sheet.status.maxHP, 4, '6b-④ maxHP 写为 4');
})();

/* ============================================================
 * QA 独立复核小节（software-qa-engineer · 严过关）append
 *
 * 目标：**用怀疑的眼光**独立复跑 v2.6.0 六项 —— 不信任工程师的描述，
 *       自己构造场景真跑（抠出源码真函数执行 / 抠出 UI 函数喂桩执行），
 *       重点覆盖「新门禁是否误伤合法场景」「改动是否真生效」。
 *   ⚠️ 本小节只 append，不改动任何既有断言。
 * ============================================================ */

/* 从 room-panels.js 抠出**完整**函数体（含 `function` 关键字，供 eval 用）。
   注意：本文件顶部 segOf 用 slice(i+1)（丢首字母 'f'），只适合正则检索；
   凡是需要真跑的函数一律用 funcSrc。 */
function funcSrc(name) {
  var i = rpClean.indexOf('function ' + name + '(');
  if (i < 0) return '';
  var rest = rpClean.slice(i);
  var m = /\r?\n  function /.exec(rest);
  return rest.slice(0, m ? m.index : rest.length);
}
function allOut(out) { return JSON.stringify(out || []); }

/* ------------------------------------------------------------
 * QA-1 · clampToMax 真值表（把源码里的真函数抠到沙箱里跑）
 * ------------------------------------------------------------ */
section('QA-1 clampToMax 真值表（含 null/undefined/负数/字符串降级）');
(function () {
  var src = fs.readFileSync(path.join(base, 'core/room-model.js'), 'utf8');
  var m = /function clampToMax\(v, max\) \{[\s\S]*?\n  \}/.exec(src);
  ok(!!m, '从 room-model.js 抠出 clampToMax 真函数');
  if (!m) return;
  var sb = {}; vm.createContext(sb);
  vm.runInContext(m[0] + '\n; this.__c = clampToMax;', sb);
  var c = sb.__c;
  eq(c(5, 3), 3, 'clampToMax(5,3)=3（只夹上界）');
  eq(c(5, 10), 5, 'clampToMax(5,10)=5（不抬升）');
  eq(c(5, 0), 5, 'max=0 → 不夹（硬守卫）');
  eq(c(5, null), 5, 'max=null → 不夹');
  eq(c(5, undefined), 5, 'max=undefined → 不夹');
  eq(c(5, -1), 5, 'max=-1（非法）→ 不夹');
  eq(c(5, NaN), 5, 'max=NaN → 不夹');
  eq(c(5, 'abc'), 5, "max='abc'（Number=NaN）→ 不夹");
  eq(c(5, '10'), 5, "max='10' → 视为 10，5 不夹");
  eq(c(15, '10'), 10, "max='10' → 15 夹到 10");
  eq(c('abc', 3), 'abc', "v='abc'（非数值）→ 原值返回，不制造 NaN");
  eq(c(-3, 3), -3, 'v<0 且 max>0 → 不抬升（下界交 clampNumber）');
})();

/* ------------------------------------------------------------
 * QA-2 · isMemberRippedU / sanBlocked 真值表（抠出 UI 真函数跑）
 * ------------------------------------------------------------ */
section('QA-2 isMemberRippedU / sanBlocked 真值表（防「hp<=0 误判死亡」）');
(function () {
  var rip = funcSrc('isMemberRippedU');
  ok(/function isMemberRippedU\(/.test(rip), '抠出 isMemberRippedU 真函数');
  if (!rip) return;
  var sb = {}; vm.createContext(sb);
  vm.runInContext(rip + '\n; this.__rip = isMemberRippedU;', sb);
  var ripFn = sb.__rip;
  ok(ripFn({ sheet: { status: { body: '死亡' }, mental: [] } }) === true, "body='死亡' → true");
  ok(ripFn({ sheet: { status: { body: '正常' }, mental: ['永久疯狂'] } }) === true, 'mental 含永久疯狂 → true');
  ok(ripFn({ sheet: { status: { body: '正常', currentHP: 0, maxHP: 0 }, mental: ['正常'] } }) === false,
     '★ hp=0 / hpMax=0 但 body 正常 → false（绝不用 hp<=0 判死）');
  ok(ripFn({ sheet: { status: { body: '濒死' }, mental: ['正常'] } }) === false, "body='濒死' → false（未撕卡）");
  ok(ripFn(null) === false, 'null → false');
  ok(ripFn({}) === false, '空对象 → false');
  ok(ripFn({ sheet: {} }) === false, 'sheet 无 status/mental → false（不抛异常）');

  var sbs = funcSrc('sanBlocked');
  var sb2 = {}; vm.createContext(sb2);
  sb2.isMemberRippedU = ripFn;
  sb2.isMemberMadActive = function (mm) { return !!(mm && mm.__mad); };
  vm.runInContext(sbs + '\n; this.__sb = sanBlocked;', sb2);
  var sbFn = sb2.__sb;
  ok(sbFn({ __mad: true, sheet: {} }) === true, '疯狂发作中 → blocked');
  ok(sbFn({ sheet: { status: { body: '死亡' } } }) === true, '死亡 → blocked');
  ok(sbFn({ sheet: { status: { body: '正常' }, mental: ['永久疯狂'] } }) === true, '永久疯狂 → blocked');
  ok(sbFn({ sheet: { status: { body: '正常' }, mental: ['正常'] } }) === false, '正常角色 → 不 block');
})();

/* ------------------------------------------------------------
 * QA-3 · rulesSheet 真跑（抠出 UI 函数，喂 el/global/M 桩执行，查生成文案）
 * ------------------------------------------------------------ */
section('QA-3 rulesSheet 真跑（自定义 / 缺省 / 边界 三种 meta）');
function runRulesSheet(meta) {
  var src = funcSrc('rulesSheet');
  var sb = {}; vm.createContext(sb);
  var captured = [];
  sb.el = function (tag, opts, kids) { return { tag: tag, opts: opts || {}, kids: kids || null }; };
  sb.global = { UI: { sheet: function (o) { captured.push(o); }, toast: function () {} } };
  sb.M = { cleanText: function (x) { return x; } };   // truthy → 跳过 boot()
  sb.boot = function () {};
  vm.runInContext(src + '\n; this.__rs = rulesSheet;', sb);
  sb.__rs({ st: { meta: meta } });
  var s = '';
  function walk(n) { if (!n) return; if (n.opts && n.opts.html) s += n.opts.html; (n.kids || []).forEach(walk); }
  ((captured[0] && captured[0].body && captured[0].body.kids) || []).forEach(walk);
  return s;
}
(function () {
  var custom = runRulesSheet({ critThreshold: 3, fumbleThreshold: 95 });
  ok(/大成功：掷出 ≤ 3/.test(custom), '自定义 crit=3 → 文案含「大成功：掷出 ≤ 3」');
  ok(/大失败：掷出 ≥ 95/.test(custom), '自定义 fumble=95 → 文案含「大失败：掷出 ≥ 95」');
  ok(/房规自定义/.test(custom), '自定义 → 标注「房规自定义」');

  var def = runRulesSheet(undefined);
  ok(/01，或检定成功且 ≤ 5/.test(def), '缺省 → 规则书默认「01，或检定成功且 ≤ 5」');
  ok(/（规则书默认）/.test(def), '缺省 → 标注「（规则书默认）」');
  ok(/大失败：100，低技能值时 96-100/.test(def), '缺省 → 大失败「100，低技能值时 96-100」');
  ok(!/大失败：100（规则书默认）/.test(def), '★ 不把「未自定义」误导成「大失败 = 100」');

  var c100 = runRulesSheet({ critThreshold: 100, fumbleThreshold: 100 });
  ok(/01，或检定成功且 ≤ 5/.test(c100), 'crit=100（不生效）→ 回落规则书默认');
  ok(/大失败：100，低技能值时 96-100/.test(c100), 'fumble=100（=未自定义）→ 回落规则书默认');

  var edge = runRulesSheet({ critThreshold: 99, fumbleThreshold: 1 });
  ok(/大成功：掷出 ≤ 99/.test(edge), 'crit=99（上边界∈[1,99]）→ 自定义');
  ok(/大失败：掷出 ≥ 1/.test(edge), 'fumble=1（下边界∈[1,99]）→ 自定义');
})();

/* ------------------------------------------------------------
 * QA-4 · coverAsset 权限 + 边界（非 KP / 不存在 id / undefined）
 * ------------------------------------------------------------ */
section('QA-4 coverAsset 权限 + 边界');
(function () {
  var host = new M.Host({ rules: R, rng: feeder([0.3, 0.0]), madness: null, now: function () { return 1000; } });
  host.roster.open({ seat: 's1', role: M.ROLE.PLAYER, nickname: '小美' });
  host.roster.get('s1').sheet = { name: '小美', status: { currentHP: 10, maxHP: 10, currentSAN: 50, maxSAN: 50 }, skills: [], weapons: [], madness: [], mental: ['正常'] };
  host.addAsset({ kind: 'map', name: '图1', data: 'data:image/png;base64,AAA' });
  var id = host.localAssets[host.localAssets.length - 1].id;
  host.revealAsset(id, true);

  var outP = host.intent('s1', { op: M.INTENT.ACT, p: { op: 'asset.cover', id: id } });
  eq((host.state.scene || {}).image || '', '', '非 KP 调 asset.cover → scene.image 不变');
  ok(allOut(outP).indexOf('权限') >= 0, '非 KP → 有权限拒绝提示（未静默）');

  var outN = host.coverAsset('no-such-id');
  eq((host.state.scene || {}).image || '', '', 'coverAsset(不存在 id) → image 不变');
  ok(allOut(outN).indexOf('只能把') >= 0, 'coverAsset(不存在 id) → 同一条「只能把已公开素材设底图」拒绝');

  host.coverAsset(id);
  eq(host.state.scene.image, id, '前置：已公开素材设底图成功');
  var outU = host.coverAsset(undefined);
  eq(host.state.scene.image || '', '', 'coverAsset(undefined) → 清底图');
  ok(allOut(outU).indexOf('清除') >= 0, 'coverAsset(undefined) → 写「清除底图」日志');
  eq(host.coverAsset(null).length >= 1, true, 'coverAsset(null) → 也走清除分支（不抛）');

  /* 悬空引用清理（独立复跑）：隐藏 / 删除「当前底图」素材 → image 必被清 */
  host.coverAsset(id);
  eq(host.state.scene.image, id, '前置①：重新设为底图');
  var outHide = host.revealAsset(id, false);
  eq(host.state.scene.image || '', '', '★ 隐藏当前底图素材 → scene.image 被清（不留悬空）');
  ok(outHide.some(function (r) { return r && r.msg && r.msg.t === M.EVT.SCENE; }),
     '★ 隐藏当前底图 → 额外广播 EVT.SCENE 同步「底图已清」');
  host.revealAsset(id, true);
  host.coverAsset(id);
  eq(host.state.scene.image, id, '前置②：重新公开并设为底图');
  var outDel = host.delAsset(id);
  eq(host.state.scene.image || '', '', '★ 删除当前底图素材 → scene.image 被清');
  ok(outDel.some(function (r) { return r && r.msg && r.msg.t === M.EVT.SCENE; }),
     '★ 删除当前底图 → 广播 EVT.SCENE 同步底图消失');
})();

/* ------------------------------------------------------------
 * QA-5 · 第 3 项门禁全景（重点：是否误伤合法场景）
 * ------------------------------------------------------------ */
section('QA-5 第 3 项门禁全景（防误伤）');
(function () {
  /* ① 探索态（无战斗序）→ 不拦，回落原报错 */
  var hA = mkCombatHost([], 0); hA.state.combat = null;
  var oA = hA.intent('s1', { op: M.INTENT.OPPOSED, p: REQ });
  ok(allOut(oA).indexOf('只能在你的行动轮次') < 0, '探索态（combat=null）→ 不触发轮次门禁');
  ok(allOut(oA).indexOf('没有可选的怪物') >= 0, '探索态 → 回落「没有可选的怪物」（原行为不变）');

  /* ② 战斗序存在但 order 空 → 不拦 */
  var hB = mkCombatHost([], 0);
  ok(allOut(hB.intent('s1', { op: M.INTENT.OPPOSED, p: REQ })).indexOf('只能在你的行动轮次') < 0,
     'order 为空 → 不拦（回落旧报错）');

  /* ③ 别人轮次 / 怪物轮次 → 拦；本人轮次 / 第 2 槽 → 放行 */
  ok(mkCombatHost([PC_B, MON1], 0)._isMyActionTurn('s1') === false, '轮到别人 → _isMyActionTurn=false');
  ok(mkCombatHost([MON1, PC_A], 0)._isMyActionTurn('s1') === false, '怪物轮次 → false');
  ok(mkCombatHost([PC_A, MON1], 0)._isMyActionTurn('s1') === true, '本人轮次 → true');
  var PC_A2 = pcSlot('s1', '小美'); PC_A2.id = 's1#1';
  ok(mkCombatHost([MON1, PC_A2], 1)._isMyActionTurn('s1') === true, '同一 pc 第 2 槽 → true（不误伤）');

  /* ④ turn 越界 / undefined：模型与 UI order[turn] 同口径 */
  ok(mkCombatHost([PC_A], 5)._isMyActionTurn('s1') === false, 'turn 越界（无当前槽）→ false');
  var hT = mkCombatHost([PC_A], 0); hT.state.combat.turn = undefined;
  eq(hT._isMyActionTurn('s1'), false, 'turn=undefined → false（与 UI order[undefined] 同口径）');

  /* ⑤ 防误伤：KP 的 checkOpposed（被攻击反击/闪避）在非玩家轮次仍结算 */
  var hC = mkCombatHost([MON1, PC_A], 0);
  var oC = hC.checkOpposed('host', { attack: true,
    attacker: { side: 'monster', actorId: 'm1', name: '食尸鬼', skill: '爪击', value: 55 },
    defender: { side: 'pc', seat: 's1', skill: '闪避', reaction: 'dodge' },
    weapon: { name: '爪', damage: '1D6', pierce: '\u00d7', db: '0' }, armor: { value: 0 } });
  ok(allOut(oC).indexOf('只能在你的行动轮次') < 0, '★ checkOpposed 在怪物轮次不被门禁误伤');
  ok(picksOf(oC, M.EVT.CHECK).length >= 1, '★ checkOpposed 仍产出结果卡');

  /* ⑥ 防误伤：胜后「选目标」阶段（phase=target）不受轮次门禁 */
  var MONS = [{ id: 'm1', actorId: 'm1', kind: 'monster', name: '食尸鬼', public: { hp: 9, hpMax: 9 } },
              { id: 'm2', actorId: 'm2', kind: 'monster', name: '深潜者', public: { hp: 8, hpMax: 8 } }];
  var hD = mkCombatHost([PC_A, MONS[0], MONS[1]], 0);
  hD.intent('s1', { op: M.INTENT.OPPOSED, p: { phase: 'request', weapon: { name: '匕首' }, targetId: 'm1' } });
  var ridD = hD.state.opposed && hD.state.opposed.id;
  hD.checkOpposed('host', { attack: true, reqId: ridD, defender: { reaction: 'counter', value: 60 }, armor: { value: 0 } });
  hD.state.combat.turn = 1;   // 把当前轮挪到怪物（模拟 KP 已推进）
  var beforeD = hD.state.combat.order[2].public.hp;
  var oD = hD.intent('s1', { op: M.INTENT.OPPOSED, p: { phase: 'target', targetId: 'm2' } });
  ok(allOut(oD).indexOf('只能在你的行动轮次') < 0, '★ phase=target（选目标）不经过轮次门禁');
  ok(hD.state.combat.order[2].public.hp < beforeD, '★ phase=target 在非当前轮次仍结算伤害（只拦发起）');

  /* ⑦ combatEnd 后 state.combat 被清（emit→reduce）→ 门禁放行 */
  var hE = mkCombatHost([MON1, PC_A], 0);
  hE.combatEnd();
  eq(hE.state.combat, null, 'combatEnd → host.state.combat=null');
  ok(hE._isMyActionTurn('s1') === true, 'combatEnd 后 → 门禁放行');
})();

/* ------------------------------------------------------------
 * QA-6 · 第 6 项 stateApply「max 提前到 current」+ clamp 边界
 * ------------------------------------------------------------ */
section('QA-6 stateApply max 提前 + clamp 边界');
(function () {
  var h = mkCombatHost([], 0);
  var m = h.roster.get('s1');
  h.stateApply('s1', { status: { maxHP: 4, currentHP: 9 } }, {});
  eq(m.sheet.status.maxHP, 4, 'stateApply：maxHP 写为 4');
  eq(m.sheet.status.currentHP, 4, '★ 同一请求 maxHP 4 + currentHP 9 → 用「新上限」夹到 4（顺序真的生效）');

  var h2 = mkCombatHost([], 0);
  var m2 = h2.roster.get('s1');
  m2.sheet.status.maxHP = -5;                     // 非法上限
  h2.stateApply('s1', { status: { currentHP: 9 } }, {});
  eq(m2.sheet.status.currentHP, 9, 'maxHP 负/非法 → 不把 currentHP 夹到 0（守卫）');

  var h3 = mkCombatHost([], 0);
  var m3 = h3.roster.get('s1');
  m3.sheet.status.maxSAN = 0;
  h3.stateApply('s1', { status: { currentSAN: 33 } }, {});
  eq(m3.sheet.status.currentSAN, 33, 'maxSAN=0（未登记）→ 不夹 currentSAN');
})();

/* ------------------------------------------------------------
 * QA-7 · 跨组静态契约（两人分头改最容易脱节）
 * ------------------------------------------------------------ */
section('QA-7 跨组静态契约（asset.cover 三处齐备 / 无重复实现 / 两入口共用判定）');
(function () {
  var msrc = readSrc('core/room-model.js');
  ok(/['"]asset\.cover['"]\s*:\s*\{/.test(msrc), "POLICY 权限表含 'asset.cover'");
  ok(/op === 'asset\.cover'/.test(msrc), "applyAction 分发含 op==='asset.cover'");
  ok(/Host\.prototype\.coverAsset = function/.test(msrc), 'coverAsset 处理函数存在');
  ok(/op:\s*'asset\.cover',\s*id:/.test(rpClean), "UI 发 {op:'asset.cover', id:...}（字段名 id）");
  ok(/this\.coverAsset\(p\.id\)/.test(msrc), 'applyAction 以 p.id 调用 coverAsset（字段名两端一致）');

  eq((msrc.match(/function clampToMax\b/g) || []).length, 1, 'clampToMax 唯一定义');
  eq((msrc.match(/Host\.prototype\._isMyActionTurn =/g) || []).length, 1, '_isMyActionTurn 唯一定义');
  eq((msrc.match(/Host\.prototype\.applyStatusJudgment =/g) || []).length, 1, 'applyStatusJudgment 唯一定义');
  eq((rpClean.match(/function sanBlocked\b/g) || []).length, 1, 'sanBlocked 唯一定义');
  eq((rpClean.match(/function isMemberRippedU\b/g) || []).length, 1, 'isMemberRippedU 唯一定义');

  // v2.10.0（R5）：applyStatusJudgment 入参新增 flagsBefore（dying/unconscious 改前标记）—— 正则放行该可选键
  ok(/this\.applyStatusJudgment\(m, change, bySeat,\s*\{ sanBefore: sanBeforeHand, hpBefore: hpBeforeHand, bodyBefore: bodyBeforeHand(,\s*flagsBefore: flagsBeforeHand)? \}\)/.test(msrc),
     'stateSelf 调用 applyStatusJudgment（自助入口共用判定）');
  ok(/this\.applyStatusJudgment\(m, change, seat,\s*\{ sanBefore: sanBeforeConsent, hpBefore: hpBeforeConsent, bodyBefore: bodyBeforeConsent(,\s*flagsBefore: flagsBeforeConsent)? \}\)/.test(msrc),
     'consent 调用 applyStatusJudgment（KP 请求入口共用判定）');
  var selfSeg = /Host\.prototype\.stateSelf = function[\s\S]*?\n  \};/.exec(msrc)[0];
  ok(!/dyingRoundCheck/.test(selfSeg), 'stateSelf 不再内联 dyingRoundCheck（判定确已抽出，无两套口径）');
})();

/* ------------------------------------------------------------
 * QA-8 · CSS 守卫（.thumb.cover/.thumb-pin 新增 + .gp-grid 零改动）
 * ------------------------------------------------------------ */
section('QA-8 CSS 守卫（新增样式不碰 .gp-grid）');
(function () {
  var css = fs.readFileSync(path.join(base, '../css/app.css'), 'utf8');
  ok(/\.thumb\.cover\b/.test(css), 'CSS 含 .thumb.cover（当前底图高亮）');
  ok(/\.thumb-pin\b/.test(css), 'CSS 含 .thumb-pin');
  ok(/\.thumb-pin\.on\b/.test(css), 'CSS 含 .thumb-pin.on');
  var o = (css.match(/\{/g) || []).length, c = (css.match(/\}/g) || []).length;
  eq(o, c, 'app.css 花括号配平（' + o + ' vs ' + c + '）');
  var seg = css.slice(css.indexOf('.thumb.cover'), css.indexOf('.thumb-pin.on') + 40);
  ok(seg.indexOf('gp-grid') < 0, '★ .thumb.cover / .thumb-pin 段不含任何 .gp-grid 规则（横屏网格零回归）');
})();

/* ============================================================
 * 追加（software-engineer-2 · 寇豆码）：**预存在缺陷**修复 ——
 * `applyAction` 的 `scene.mode` 分支曾把「计划数组」当「事件记录」传给 `_push`
 * （`this._push(out, this._modeChanged(p.mode))`）。`_modeChanged` 返回 `this.plan(...)`
 * = `[{to,msg}]`（计划数组），而 `_push(out, rec)` 会 `plan(rec)` → 读 `rec.evt`
 * → undefined → `evt.vis` 抛 TypeError。已改为 `out = out.concat(this._modeChanged(...))`。
 * ============================================================ */
section('预存在缺陷修复 · scene.mode 分支 _push 误用');
(function () {
  /* ① 真跑该 op：不再抛 TypeError，且换模式事件被正确合并进计划数组 */
  var host = mkAssetHost();
  var threw = null, out = null;
  try {
    out = host.applyAction(M.HOST_SEAT, { op: 'scene.mode', mode: M.MODE.COMBAT });
  } catch (e) { threw = e; }
  ok(threw === null, '① applyAction({op:scene.mode, mode:COMBAT}) 不再抛异常',
     threw && (threw.name + ': ' + threw.message));
  ok(Array.isArray(out), '① 返回的是计划数组', out && Object.prototype.toString.call(out));
  ok(hasEvt(out, M.EVT.STATUS), '① 计划数组含「换模式」EVT.STATUS 计划项（事件真出门，未被吞）');
  eq(host.state.meta.mode, M.MODE.COMBAT, '① meta.mode 已切到 COMBAT');

  /* 再切回探索态：同一条路径同样不再抛，且事件照发 */
  var out2 = host.applyAction(M.HOST_SEAT, { op: 'scene.mode', mode: M.MODE.EXPLORATION });
  eq(host.state.meta.mode, M.MODE.EXPLORATION, '① 再切回 EXPLORATION 生效');
  ok(hasEvt(out2, M.EVT.STATUS), '① 切回探索态同样产出 EVT.STATUS 计划项');

  /* ② 守卫断言（变异防护）：`_modeChanged` 的返回值必须是**计划数组**（不是事件记录）——
        将来若又被 `_push` 包一层，就是本缺陷根因复现。 */
  var plan = host._modeChanged(M.MODE.COMBAT);
  ok(Array.isArray(plan), '② _modeChanged 返回计划数组（Array.isArray）',
     Object.prototype.toString.call(plan));
  ok(plan.length >= 1 && plan[0] && plan[0].msg && plan[0].msg.t === M.EVT.STATUS,
     '② 计划项形如 {to, msg:{k,t,p}}（**不是** {evt,seq} 事件记录）',
     JSON.stringify(plan).slice(0, 140));
  host.state.meta.mode = M.MODE.EXPLORATION;   /* 收尾，避免影响后续读取者 */

  /* ③ 静态证据链：scene.mode 分支必须合并返回，绝不能再 _push 包一层 */
  var src = readSrc('core/room-model.js');
  ok(/out = out\.concat\(this\._modeChanged\(p\.mode\)\);/.test(src),
     '③ 源码：scene.mode 分支 = out = out.concat(this._modeChanged(p.mode))');
  ok(!/_push\(out, this\._modeChanged/.test(src),
     '③ 源码：全文件不再有 _push(out, this._modeChanged(...)) 误用');
})();
