/*
 * v2.5.0 独立回归（QA · Edward）—— 覆盖本批 11 项。
 *
 *  ① 全屏信息流停在最底部           —— 静态证据链（DOM/滚动容器，无头环境）
 *  ② KP 不能对疯狂发作中角色做 SAN  —— 行为（sheetSanCheck / sheetSanLoss 真跑）
 *  ③ 战斗轮次跳过已死亡单位          —— 行为（slotDown + nextTurn 真跑，含全员阵亡）
 *  ④ 地图绘画/清空不进游戏记录       —— 行为（mapClear / mapStrokesSet 真跑）
 *  ⑤ 对抗-通用检定（探索态可用）     —— 行为（_findActorSlot / normBase / 存档往返）
 *  ⑥ 橡皮擦滑动实时擦除             —— 静态证据链 + 参数/签名契约
 *  ⑦ 补齐横幅不消失                 —— 行为（Client.receive / PlayerSide._onText 真跑）
 *  ⑧ KP 点手绘板全屏查看            —— 静态证据链
 *  ⑨ 放置单位落点击位置             —— 静态证据链
 *  ⑩ 竖屏记录框固定高度             —— CSS 静态（含 .gp-grid 零回归）
 *  ⑪ 限流提示自动消失               —— 行为（setBanner 提取后真跑计时器）
 *
 * 运行： node tools/test_v250_fixes.js（工作目录 = 仓库根）
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
var sbN = mkSandbox(['core/room-rules.js', 'core/room-model.js', 'core/room-net.js']);
var N = sbN.RoomNet;

function feeder(seq) { var i = 0; return function () { return seq[i++ % seq.length]; }; }

/**
 * 强制失败损失的规则替身（照抄 test_v240_fixes.js#lossyRules）。
 * 为什么必须用它：真实 CocRules 的 D100 走 Host 的 rng 流，rng 消费顺序一变
 * （换 Sheet、多跑一条 immediately 路径）掷值就变 —— 断言会漂。这里钉死「必失败 + 固定损失」，
 * 「该被拦 vs 该放行」的判据才站得住。
 */
function lossyRules(loss) {
  var rules = Object.create(R);
  rules.resolveSanCheck = function (o) {
    var before = Math.max(0, Number(o.currentSan) || 0);
    var after = Math.max(0, before - loss);
    return {
      ok: true,
      check: { value: 99, passed: false, failed: true, levelText: '失败',
               base: before, target: before, summary: '强制失败' },
      lossExpr: '0/' + loss, usedBranch: 'onFail', branchText: '失败',
      lossTerms: [{ count: 1, sides: 6, sign: 1 }],
      roll: { ok: true, total: loss, rolls: [] },
      loss: loss, before: before, after: after,
      maxSan: (o.maxSan == null ? 99 : o.maxSan)
    };
  };
  return rules;
}

/** 造 Host（成员履约表里有 s1=小美，带人物卡）。opts.lossy>0 → 用强制失败的规则替身。 */
function mkHost(opts) {
  opts = opts || {};
  var host = new M.Host({
    rules: opts.lossy > 0 ? lossyRules(opts.lossy) : R, rng: feeder(opts.rng || [0.3, 0.0]),
    madness: null, now: function () { return 1000; }
  });
  host.roster.open({ seat: 's1', role: M.ROLE.PLAYER, nickname: '小美' });
  var mem = host.roster.get('s1');
  mem.charName = '小美';
  mem.sheet = {
    name: '小美', attrs: { str: 60, int: 60, pow: 50 },
    status: { currentHP: 12, maxHP: 12, currentSAN: 50, maxSAN: 50 },
    skills: [{ name: '格斗（斗殴）', total: 60 }, { name: '闪避', total: 50 },
             { name: '觉察', total: 55 }],
    weapons: [], madness: [], mental: opts.mental || ['正常'], db: '0'
  };
  host.state.combat = { order: opts.order || [], turn: 0, round: 1, startedAt: 0 };
  host.state.meta.status = M.STATUS.IN_GAME;
  return { host: host, mem: mem };
}

function types(o) {
  return (o || []).map(function (r) { return r.msg.t; }).join(',');
}
function texts(o) {
  return (o || []).map(function (r) { return (r.msg && r.msg.p && r.msg.p.text) || ''; }).join(' | ');
}
function pubLogs(o) {
  return (o || []).filter(function (r) { return r.msg && r.msg.t === M.EVT.LOG; })
    .map(function (r) { return (r.msg.p && r.msg.p.text) || ''; });
}
function hasTo(o, t) {
  return (o || []).some(function (r) { return r.msg && r.msg.t === t; });
}
function sanOf(m) { return ((m.sheet && m.sheet.status) || {}).currentSAN; }
function readSrc(rel) { return fs.readFileSync(path.join(base, rel), 'utf8'); }

/** 剥掉注释后的源码 —— 静态断言一律用它，避免被注释里的说明误导（⑪/⑨ 都踩过这个坑）。 */
function stripComments(text) { return text.replace(/\/\*[\s\S]*?\*\//g, ''); }
var rpClean = stripComments(readSrc('ui/room-panels.js'));

/* ============================================================
 * ② KP 不能对疯狂发作中角色做 SAN Check / 追加理智损失
 * ============================================================ */
section('② 疯狂发作中不接受 KP 定向 SAN 指令（行为）');
(function () {
  var blockedAndUnaffected = function (call) {
    return function (mental) {
      var g = mkHost({ mental: [mental], lossy: 2 });   /* 强制失败 -2 SAN */
      var before = sanOf(g.mem);
      var out = call(g);
      return { before: before, after: sanOf(g.mem), out: out, txt: texts(out), g: g };
    };
  };

  var doCheck = function (g) {
    return g.host.sheetSanCheck('host', { seat: 's1', okLoss: '0', loss: '1D6', reason: 'QA' });
  };
  var doLoss = function (g) {
    return g.host.sheetSanLoss('host', { seat: 's1' });
  };

  /* —— 应当被拦：临时疯狂 / 不定疯狂 —— */
  ['临时疯狂', '不定疯狂'].forEach(function (mind) {
    var c = blockedAndUnaffected(doCheck)(mind);
    ok(c.after === c.before, 'SAN Check · ' + mind + ' → SAN 未被改动（' + c.before + '）',
       JSON.stringify(c));
    ok(/正处于疯狂发作中，不能做 SAN Check/.test(c.txt),
       'SAN Check · ' + mind + ' → 明确提示「正处于疯狂发作中，不能做 SAN Check」', c.txt);
    ok(!hasTo(c.out, M.EVT.DICE), 'SAN Check · ' + mind + ' → 没有掷骰（指令未被结算）', types(c.out));

    var l = blockedAndUnaffected(doLoss)(mind);
    ok(l.after === l.before, 'SAN 追加 · ' + mind + ' → SAN 未被改动（' + l.before + '）',
       JSON.stringify(l));
    ok(/正处于疯狂发作中，不能追加理智损失/.test(l.txt),
       'SAN 追加 · ' + mind + ' → 明确提示「不能追加理智损失」', l.txt);
    ok(!hasTo(l.out, M.EVT.DICE), 'SAN 追加 · ' + mind + ' → 没有掷骰（指令未被结算）', types(l.out));
  });

  /* —— 不应被拦（主理人已拍板口径）：「不定疯狂（症状消失）」必须仍能复发 ——
     理由：v2.2.2 用户第 6 项 + v2.4.0 交付了「该状态掉 SAN 必须复发」，
     而 KP 定向 SAN Check 是三条复发来源之一。 */
  ['正常', '不定疯狂（症状消失）'].forEach(function (mind) {
    var c = blockedAndUnaffected(doCheck)(mind);
    ok(c.after < c.before, 'SAN Check · ' + mind + ' → 正常结算（SAN ' + c.before + ' → ' + c.after + '）',
       c.txt);
    ok(hasTo(c.out, M.EVT.DICE), 'SAN Check · ' + mind + ' → 真的掷了骰', types(c.out));
    var l = blockedAndUnaffected(doLoss)(mind);
    ok(l.after < l.before, 'SAN 追加 · ' + mind + ' → 正常结算（SAN ' + l.before + ' → ' + l.after + '）',
       l.txt);
  });
  /* ⚠️ 复发需要「这次 SAN 真的掉了且没归零」：lossy 替身固定 -2，SAN 起始 40 → 38。
     SAN 归零会直接转永久疯狂（撕卡），那就看不到「复发」这条支路了。 */
  (function () {
    var g = mkHost({ mental: ['不定疯狂（症状消失）'], lossy: 2 });
    g.mem.sheet.status.currentSAN = 40;
    g.mem.sheet.status.maxSAN = 99;
    var before = sanOf(g.mem);
    var out = g.host.sheetSanCheck('host', { seat: 's1', okLoss: '0', loss: '1', reason: 'QA' });
    var after = sanOf(g.mem);
    ok(after < before, '「症状消失」态：SAN 仍可被扣走（' + before + ' → ' + after + '）', texts(out));
    ok(/不定疯狂复发/.test(texts(out)),
       '「不定疯狂（症状消失）」仍会复发（未被误封，保住已交付功能）', texts(out));
    ok(g.mem.sheet.mental.indexOf('不定疯狂（症状消失）') < 0,
       '复发后旧标签「症状消失」被替换掉（不并存）', JSON.stringify(g.mem.sheet.mental));
  })();

  /* —— 提示必须发给 KP 本人，不该污染公开记录 —— */
  var g = mkHost({ mental: ['临时疯狂'] });
  var out = g.host.sheetSanCheck('host', { seat: 's1', okLoss: '0', loss: '1D6' });
  ok((out || []).some(function (r) { return r.to === 'host' && r.msg.t === M.EVT.PRIVATE; }),
     '拦截提示是私密回给 KP（不进公开记录）', JSON.stringify(out.map(function (r) { return { t: r.msg.t, to: r.to }; })));
  ok(pubLogs(out).length === 0, '拦截时公开记录零新增', JSON.stringify(pubLogs(out)));
})();


/* ------------------------------------------------------------
 * ②-b v2.5.1（用户第 2 项·补强）：疯狂发作中的角色**连选都选不到**
 *   v2.5.0 只在「选中之后」toast 拒绝（+ 模型层兜底），KP 的体感仍是
 *   「能选到、能开表单」。这里锁定「选人列表就过滤掉」这个更强的约束。
 * ------------------------------------------------------------ */
section('②-b SAN 选人列表过滤疯狂发作中的角色（静态证据链 + 变异防护）');
(function () {
  ok(/function pickTargetPlayer\(ctx, title, onPick, opts\)/.test(rpClean),
     'pickTargetPlayer 新增第 4 参 opts（向后兼容：老调用不带参）');
  ok(/opts = opts \|\| \{\}/.test(rpClean), 'opts 缺省归一为空对象，老调用不受影响');
  ok(/if \(opts\.skip\) players = players\.filter\(function \(m\) \{ return !opts\.skip\(m\); \}\)/.test(rpClean),
     'opts.skip(m) 为真 → 该玩家从选人列表剔除（不是置灰可选）');
  ok(/opts\.emptyHint \|\| '房间里还没有玩家'/.test(rpClean),
     '过滤后无人时给出专属提示文案（不是复用「房间里还没有玩家」）');

  /* 按函数名切出函数体，避免跨函数误命中 */
  function segOf(name) {
    var i = rpClean.indexOf('function ' + name + '(');
    if (i < 0) return '';
    var rest = rpClean.slice(i + 1);
    var m = /\r?\n  function /.exec(rest);
    return rest.slice(0, m ? m.index : rest.length);
  }
  /* v2.6.0（用户第 5 项）：skip 谓词由 isMemberMadActive 扩为 sanBlocked（疯狂发作中 或 已撕卡）。
     断言口径不变（选人列表必须过滤掉不可施法者），仅同步谓词名/文案，故此处更新。 */
  ok(/skip: sanBlocked/.test(segOf('sanForPlayer')),
     'SAN Check：选人列表跳过「疯狂发作中 或 已撕卡」的玩家', segOf('sanForPlayer').slice(0, 160));
  ok(/skip: sanBlocked/.test(segOf('sanLossForPlayer')),
     '追加理智损失：选人列表跳过「疯狂发作中 或 已撕卡」的玩家', segOf('sanLossForPlayer').slice(0, 160));
  /* 这两个入口仍然保留选中后的兜底拦截（模型层还有第三道），不能被"列表已过滤"顶掉 */
  ok(/if \(isMemberMadActive\(m\)\)/.test(segOf('sanForPlayer')) &&
     /if \(isMemberMadActive\(m\)\)/.test(segOf('sanLossForPlayer')),
     '两个入口仍保留选中后的兜底拦截（列表过滤 + UI 拦截 + 模型拒绝，三道防线并存）');

  /* 口径锚：临时疯狂 / 不定疯狂 拦，「不定疯狂（症状消失）」不拦（用户 2026-10-14 明确确认） */
  ok(/isMemberMadActive[\s\S]{0,200}?mental\.indexOf\('临时疯狂'\) >= 0 \|\| mental\.indexOf\('不定疯狂'\) >= 0/.test(rpClean),
     'UI 判据与模型侧 memberMadActive 同为「临时疯狂 / 不定疯狂」');
  ok(!/skip:.*症状消失/.test(segOf('sanForPlayer') + segOf('sanLossForPlayer')),
     '「不定疯狂（症状消失）」不在过滤名单内（仍可 SAN Check 并触发复发）');
})();

/* ============================================================
 * ③ 战斗轮次跳过已死亡单位
 * ============================================================ */
section('③ 战斗轮次跳过死亡单位（行为）');
(function () {
  function slot(id, name, pub, dex) {
    return { actorId: id, id: id, name: name, kind: 'monster',
             public: pub, dex: dex, totalSlots: 1, slot: 1 };
  }
  function run(order) {
    var g = mkHost({ order: order });
    g.host.state.combat.turn = 0;
    var out = g.host.nextTurn();
    return { out: out, txt: texts(out), t: types(out), c: g.host.state.combat, vis: out };
  }

  /* A：中间那槽死了 → 必须跳过它轮到活人 */
  var A = run([slot('a1', '战士', { hp: 10, hpMax: 10 }, 50),
               slot('a2', '死者怪', { hp: 0, hpMax: 8, down: true }, 60),
               slot('a3', '法师', { hp: 7, hpMax: 7 }, 40)]);
  ok(/轮到 法师/.test(A.txt), 'A：跳过中间那具尸体 → 轮到法师（不是死者的下一槽）', A.txt);
  ok(A.c.turn === 2, 'A：turn 落在 index 2（法师）', String(A.c.turn));
  ok(hasTo(A.vis, M.EVT.TURNSTATE) && hasTo(A.vis, M.EVT.TURN_ALERT), 'A：正常发出 TURNSTATE / TURN_ALERT', A.t);

  /* B：全员阵亡 → 明确提示 + 不发 TURNSTATE/TURN_ALERT + 不死循环 */
  var B = run([slot('b1', '死A', { hp: 0, hpMax: 5, down: true }, 10),
               slot('b2', '死B', { hp: 0, hpMax: 6, state: 'dead' }, 9)]);
  ok(/没有可行动的单位了/.test(B.txt), 'B：全员阵亡 → 提示「没有可行动的单位了…」', B.txt);
  ok(!hasTo(B.vis, M.EVT.TURNSTATE), 'B：全员阵亡 → 不发 TURNSTATE', B.t);
  ok(!hasTo(B.vis, M.EVT.TURN_ALERT), 'B：全员阵亡 → 不发 TURN_ALERT（不会轮到尸体）', B.t);
  ok(B.c.round === 1, 'B：轮次没有被推到一个虚空的新回合', String(B.c.round));

  /* C：边界 —— combatStart 给没填 HP 的单位写 hp:0,hpMax:0，**不能**误判成阵亡 */
  var C = run([slot('c1', '无HP1', { hp: 0, hpMax: 0 }, 10),
               slot('c2', '无HP2', { hp: 0, hpMax: 0 }, 9)]);
  ok(/轮到 无HP2/.test(C.txt), 'C：hp=0 且 hpMax=0（未登记血量）不算阵亡 → 正常轮到', C.txt);
  ok(hasTo(C.vis, M.EVT.TURNSTATE), 'C：未登记血量的单位照常排轮', C.t);

  /* D：state==='dead' 判据 */
  var D = run([slot('d1', '活着', { hp: 3, hpMax: 5 }, 10),
               slot('d2', '已死', { hp: 5, hpMax: 5, state: 'dead' }, 9)]);
  ok(/轮到 活着/.test(D.txt), 'D：public.state==="dead" 的单位被跳过', D.txt);

  /* E：hp<=0 && hpMax>0（没有 down / state 标记）也算阵亡 */
  var E = run([slot('e1', '活着2', { hp: 3, hpMax: 5 }, 10),
               slot('e2', '血量0', { hp: 0, hpMax: 5 }, 9)]);
  ok(/轮到 活着2/.test(E.txt), 'E：hp<=0 且 hpMax>0 → 判为阵亡并跳过', E.txt);

  /* F：合同出口 —— 没战斗时要明确提示，不许崩、不许 silent return */
  var gF = mkHost({ order: [] });
  var oF = gF.host.nextTurn();
  ok(/当前没有战斗/.test(texts(oF)), 'F：无战斗order → 明确提示而不是静默返回', texts(oF));

  /* G：真的连推 6 次 —— 全程只轮到活人、轮次合法递增、不抛异常 */
  var gH = mkHost({ order: [slot('h1', '活人', { hp: 5, hpMax: 5 }, 10),
                             slot('h2', '尸体', { hp: 0, hpMax: 5, down: true }, 9)] });
  gH.host.state.combat.turn = 0;
  var allLive = true, err = null, rounds = [];
  try {
    for (var i = 0; i < 6; i++) {
      var oi = gH.host.nextTurn();
      var s = texts(oi);
      if (!/轮到 活人/.test(s)) allLive = false;
      rounds.push(gH.host.state.combat.round);
      gH.host.state.combat.turn = 0;   /* 归一，让下一轮重新找 */
    }
  } catch (e) { err = e && e.message; }
  ok(!err, 'H：连推 6 次无异常', err || '');
  ok(allLive, 'H：连推 6 次始终只轮到活人，从不轮到尸体');
  ok(rounds.every(function (r) { return typeof r === 'number' && r >= 1; }),
     'H：轮次是合法递增整数（无 NaN / 无失控）', JSON.stringify(rounds));
})();

/* ============================================================
 * ④ 地图绘画 / 清空不进游戏记录
 * ============================================================ */
section('④ 地图绘画与清空不写游戏记录（行为）');
(function () {
  /* map.clear：不得再出现「KP 清空了地图上的绘画」 */
  var g = mkHost({});
  g.host.state.scene = {
    strokes: [{ id: 'p1', color: '#000', width: 3, pts: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] }],
    marks: [{ id: 'mk1', x: 0.5, y: 0.5, label: '线索' }]
  };
  var o1 = g.host.mapClear({ strokesOnly: true });
  ok(pubLogs(o1).length === 0, 'map.clear(strokesOnly) → 公开记录零新增', JSON.stringify(pubLogs(o1)));
  ok(!types(o1).split(',').some(function (t) { return t === M.EVT.LOG; }),
     'map.clear → 事件里没有 EVT.LOG', types(o1));
  ok(hasTo(o1, M.EVT.SCENE), 'map.clear → 仍发 EVT.SCENE（状态同步不丢）', types(o1));
  ok(g.host.state.scene.strokes.length === 0, 'map.clear → 笔迹清空');
  ok(g.host.state.scene.marks.length === 1, 'map.clear(strokesOnly) → 标记保留');

  /* ⚠️ 用**剥注释后**的源码判：注释里刻意保留了「旧实现会写『KP 清空了地图上的绘画』」
     这段说明，text-only indexOf 会被注释命中（这是好的文档，不该报错）。 */
  var src = stripComments(readSrc('core/room-model.js'));
  ok(src.indexOf('KP 清空了地图上的绘画') < 0,
     '★ 可执行代码里已无「KP 清空了地图上的绘画」文案（注释里的说明保留即可）');
  var mapClearSrc = src.slice(src.indexOf('Host.prototype.mapClear = function'),
                              src.indexOf('Host.prototype.mapClear = function') + 600);
  ok(M.EVT.LOG && mapClearSrc.indexOf('EVT.LOG') < 0, 'mapClear 函数体内不出现 EVT.LOG', mapClearSrc);

  /* map.strokes.set：整集替换 + 保留 marks + 不写 LOG */
  var g2 = mkHost({});
  g2.host.state.scene = { strokes: [{ id: 'old', color: '#111', width: 2, pts: [{ x: 0.9, y: 0.9 }] }],
                          marks: [{ id: 'mk9', x: 0.3, y: 0.3 }] };
  var o2 = g2.host.mapStrokesSet({ strokes: [{ id: 'q', color: '#f00', width: 2,
                                              pts: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.3 }] }] });
  ok(pubLogs(o2).length === 0, 'map.strokes.set → 公开记录零新增（单次擦除不刷屏）', JSON.stringify(pubLogs(o2)));
  ok(hasTo(o2, M.EVT.SCENE), 'map.strokes.set → 发 EVT.SCENE', types(o2));
  eq(g2.host.state.scene.strokes.length, 1, 'map.strokes.set → 笔迹整集替换（旧的被换掉）');
  eq(g2.host.state.scene.strokes[0].id, 'q', 'map.strokes.set → 新笔迹就位');
  eq(g2.host.state.scene.marks.length, 1, 'map.strokes.set → **保留 marks**（与 UI commitMapStrokes 承诺一致）');

  /* 脏数据边界：null / 空点集 / 越界坐标 */
  var g3 = mkHost({});
  g3.host.state.scene = { strokes: [], marks: [] };
  g3.host.mapStrokesSet({ strokes: [null, { id: 'a', pts: [] }, { id: 'b', pts: [{ x: 5, y: -3 }] }] });
  eq(g3.host.state.scene.strokes.length, 1, '脏数据：null 与空点集被丢弃，只留 1 条');
  eq(JSON.stringify(g3.host.state.scene.strokes[0].pts), JSON.stringify([{ x: 1, y: 0 }]),
     '脏数据：坐标被 clamp 到 0–1');
  var g3b = mkHost({});
  g3b.host.state.scene = { strokes: [], marks: [] };
  g3b.host.mapStrokesSet({});
  eq(g3b.host.state.scene.strokes.length, 0, 'payload 缺 strokes → 退化为空集，不崩');
})();

/* ============================================================
 * ⑤ 对抗-通用检定（探索态可用）
 * ============================================================ */
section('⑤ 对抗通用检定 — 探索态候选池 + 手输值归一化（行为）');
(function () {
  /* —— 权限表 / 分发 / 处理函数 三处齐备 —— */
  eq(JSON.stringify(M.POLICY['map.strokes.set']), JSON.stringify({ roles: ['kp'], confirm: null }),
     '契约：map.strokes.set 在 POLICY 权限表里（KP 专属、无需确认）');
  eq(JSON.stringify(M.POLICY['combat.pool.set']), JSON.stringify({ roles: ['kp'], confirm: null }),
     '契约：combat.pool.set 在 POLICY 权限表里');
  var srcModel = readSrc('core/room-model.js');
  ok(/} else if \(op === 'map\.strokes\.set'\) \{/.test(srcModel),
     '契约：map.strokes.set 有 op 分发分支');
  ok(/Host\.prototype\.mapStrokesSet = function/.test(srcModel),
     '契约：map.strokes.set 有处理函数');
  ok(/} else if \(op === 'combat\.pool\.set'\) \{/.test(srcModel),
     '契约：combat.pool.set 有 op 分发分支');

  /* —— _findActorSlot：探索态 localActors 也能被查到 —— */
  var g = mkHost({ order: [] });
  g.host.addLocalActor({ id: 'm1', name: '哥布林', kind: 'monster', dex: 60, hp: 10, hpMax: 10 });
  var f1 = g.host._findActorSlot('m1');
  ok(!!f1 && f1.id === 'm1', '_findActorSlot：探索态（order 为空）能查到 localActors 里的单位',
     JSON.stringify(f1));
  ok(!!f1 && f1.name === '哥布林', '_findActorSlot：候选池单位带回名字（不泄漏 id 当名字）');
  /* 前缀放宽 */
  var r1 = g.host._resolveActorSkill('a:m1', '觉察', 70);
  ok(r1 && r1.ok === true && r1.value === 70, '前缀 a:  + 手输 70 → 命中localActors并按手输值结算', JSON.stringify(r1));
  var r2 = g.host._resolveActorSkill('mo:m1', '觉察', 70);
  ok(r2 && r2.ok === true && r2.value === 70, '前缀 mo: 放宽支持（与 UI 注释口径一致）', JSON.stringify(r2));
  var r3 = g.host._resolveActorSkill('m1', '觉察', 70);
  ok(r3 && r3.ok === true && r3.value === 70, '无前缀也能命中 localActors（旧存档/其它调用方兼容）', JSON.stringify(r3));
  var r4 = g.host._resolveActorSkill('p:s1', '觉察', null);
  ok(r4 && r4.ok === true && r4.value === 55, '玩家前缀 p: 仍从人物卡取值（觉察 55）', JSON.stringify(r4));

  /* —— combat.order 优先于 localActors —— */
  var g2 = mkHost({ order: [{ actorId: 'k1', id: 'k1', name: '槽里的怪', kind: 'monster',
                              public: { hp: 3, hpMax: 5 }, skills: { 觉察: 80 } }] });
  g2.host.addLocalActor({ id: 'k1', name: '候选池里的怪', kind: 'monster' });
  var f2 = g2.host._findActorSlot('k1');
  ok(!!f2 && f2.name === '槽里的怪', '_findActorSlot：combat.order 优先于 localActors', JSON.stringify(f2));

  /* —— addLocalActor 去重 / setActorPool 过滤 —— */
  var g3 = mkHost({ order: [] });
  eq(g3.host.addLocalActor({ id: 'x1', name: 'A', kind: 'monster' }), true, 'addLocalActor：首次加入 → true');
  eq(g3.host.addLocalActor({ id: 'x1', name: 'A2', kind: 'monster' }), false, 'addLocalActor：同 id 去重 → false');
  eq(g3.host.localActors.length, 1, 'addLocalActor：去重后仍只有 1 条');
  g3.host.setActorPool({ actors: [{ id: 'p1', name: '怪', kind: 'monster' },
                                  { id: 'p2', name: '玩家奴 → 拒', kind: 'pc' },
                                  { id: 'p3', name: '未知类 → 拒', kind: 'ufo' },
                                  { id: '', name: '无 id → 拒', kind: 'npc' }] });
  eq(g3.host.localActors.length, 1, 'setActorPool：只收 monster / npc（pc、未知类、无 id 全拒）');
  eq(g3.host.localActors[0].id, 'p1', 'setActorPool：留下的就是合法那条');

  /* —— 存档往返（savePayload / adoptSave）—— */
  var save = JSON.parse(g3.host.savePayload());
  ok(Array.isArray(save.localActors), '存档：savePayload 含 localActors 数组');
  eq(save.localActors.length, 1, '存档：localActors 条数正确');
  var g4 = mkHost({ order: [] });
  g4.host.adoptSave(save);
  eq(g4.host.localActors.length, 1, '存档：adoptSave 复原 localActors');
  ok(!!g4.host._findActorSlot('p1'), '存档：复原后的候选池单位仍可被查到（断线重连不丢怪）');

  /* —— normBase 降级：通过整条链路观测 —— */
  var gm = mkHost({ order: [] });
  gm.host.addLocalActor({ id: 'nm1', name: '无卡怪', kind: 'monster' });
  function resolveAsBase(v) { return gm.host._resolveActorSkill('nm1', '觉察', v); }
  ok(resolveAsBase('60').value === 60, 'normBase：字符串 "60" → 归一成数字 60', JSON.stringify(resolveAsBase('60')));
  ok(resolveAsBase(60).value === 60, 'normBase：数字 60 → 保持 60');
  ok(resolveAsBase('').value === 0, 'normBase：空串 → undefined → 走旧 0 兜底（向后兼容）');
  ok(resolveAsBase('abc').value === 0, 'normBase：非法字符串 → undefined（不是 NaN）→ 走旧 0 兜底');
  ok(resolveAsBase(null).value === 0, 'normBase：null → undefined → 旧 0 兜底');
  ok(resolveAsBase(101).ok === false, 'normBase/业务：手输 101（越界）→ **报错**而非静默截断', JSON.stringify(resolveAsBase(101)));
  ok(resolveAsBase(0).ok === false, 'normBase/业务：手输 0（非法）→ **报错**而非静默按 0 结算', JSON.stringify(resolveAsBase(0)));
  ok(resolveAsBase(42.5).ok === false, 'normBase/业务：手输 42.5（非整数）→ 报错', JSON.stringify(resolveAsBase(42.5)));

  /* —— 端到端：探索态不接受非法手输值，也不出结果卡 —— */
  var ge = mkHost({ order: [] });
  ge.host.addLocalActor({ id: 'e1', name: '探索怪', kind: 'monster' });
  var oe = ge.host.checkOpposed('host', { aSeat: 'p:s1', aSkill: '格斗',
                                          bSeat: 'a:e1', bSkill: '觉察', bBase: 300 });
  ok(/乙方无效/.test(texts(oe)), '端到端：bBase=300 → 「乙方无效」明确报错', texts(oe));
  var gotChecks = (oe || []).filter(function (r) { return r.msg && r.msg.t === M.EVT.CHECK; });
  eq(gotChecks.length, 0, '端到端：非法手输值不产生结果卡（没有半截结算落库）');

  /* —— 端到端：探索态**成功**发起（旧行为：必报「找不到对抗单位」）—— */
  var gs = mkHost({ order: [] });
  gs.host.addLocalActor({ id: 's9', name: '探索怪', kind: 'monster' });
  var os = gs.host.checkOpposed('host', { aSeat: 'p:s1', aSkill: '格斗',
                                          bSeat: 'a:s9', bSkill: '觉察', bBase: 55 });
  ok(!/找不到对抗单位/.test(texts(os)), '端到端：探索态(localActors)不再报「找不到对抗单位」', texts(os));
  ok(!/乙方无效/.test(texts(os)), '端到端：探索态 + 合法手输值 → 不报错', texts(os));
  ok(os.some(function (r) { return r.msg && r.msg.t === M.EVT.CHECK; }),
     '端到端：探索态发起成功并出了结果卡', types(os));
  var cards = (os || []).filter(function (r) { return r.msg && r.msg.t === M.EVT.CHECK; });
  var cardJson = JSON.stringify(cards.map(function (r) { return r.msg.p; }));
  ok(/探索怪/.test(cardJson), '端到端：结果卡用单位名，不泄漏内部 id', cardJson);
  ok(/小美/.test(cardJson), '端到端：玩家侧用角色名（不是 seat）', cardJson);
  /* ⚠️ `targets:["p:s1","a:s9"]` 是 v2.2.x 就存在的内部路由字段（非本批引入），
     这里只对**面向人看的字段**做断言，避免把存量设计当成 v2.5.0 回归误报。 */
  ok(/小美·格斗/.test(cardJson) && /探索怪·觉察/.test(cardJson),
     '端到端：面对人看的 name / skill 都不含带前缀的 id', cardJson);
  ok(/⚔ 对抗｜小美·格斗.*vs 探索怪·觉察/.test(cardJson),
     '端到端：摘要文案也用名字（单位名不见 id 泄漏）', cardJson);
})();

/* ============================================================
 * ⑦ 补齐横幅不消失
 * ============================================================ */
section('⑦ 补齐横幅不消失（行为）');
(function () {
  function mkClient() {
    return new M.Client({ seat: 's1', role: 'player' });
  }
  function evt(seq, t) { return M.evtMsg({ seq: seq, evt: { t: t || M.EVT.LOG, p: { text: 'e' + seq } } }); }

  /* —— 正常连续：不产生缺口，filled 恒 false —— */
  var c1 = mkClient();
  var r0 = c1.receive(M.syncMsg(1, { meta: {}, members: [], chats: [], logs: [], dice: [] }));
  ok(r0.kind === 'sync', 'receive：sync 就位');
  var r1 = c1.receive(evt(2));
  ok(r1.filled !== true, 'receive：连续事件不误报 filled', JSON.stringify(r1));
  eq(c1.gapFrom, 0, 'receive：连续事件后 gapFrom=0');

  /* —— 跳号 → gap —— */
  var c2 = mkClient();
  c2.receive(M.syncMsg(1, { meta: {}, members: [], chats: [], logs: [], dice: [] }));
  var g = c2.receive(evt(5));
  ok(!!g.gap, 'receive：跳号 → kind/dup/gap 里报 gap', JSON.stringify(g));
  ok(c2.gapFrom > 0, 'receive：gap 后 gapFrom 被记下', String(c2.gapFrom));

  /* —— 补齐：补上缺口里的第一条 evt → filled=true 且 gapFrom 归零 —— */
  var gapStart = c2.gapFrom;
  var f1 = c2.receive(evt(2));
  ok(f1.filled === true, 'receive：补拉回来的第一条（连续）→ filled=true', JSON.stringify(f1));
  eq(c2.gapFrom, 0, 'receive：补齐后 gapFrom 归零（横幅该清了）');
  ok(c2.lastSeq > gapStart, 'receive：lastSeq 已越过缺口起点');

  /* —— 补齐流第一条是**水位标记**（skip）也要能报 filled ——
     这是本批的核心 bug：以前 skip 分支静默 return，横幅永远挂着。 */
  var c3 = mkClient();
  c3.receive(M.syncMsg(1, { meta: {}, members: [], chats: [], logs: [], dice: [] }));
  c3.receive(evt(4));                       // gap, gapFrom=1
  var f2 = c3.receive(M.skipMsg(2));
  ok(f2.filled === true, 'receive：缺口后的**水位标记(skip)**也回填 filled（旧实现这里直接丢了）',
     JSON.stringify(f2));

  /* —— resyncIntent 记账 —— */
  var c4 = mkClient();
  c4.receive(M.syncMsg(3, { meta: {}, members: [], chats: [], logs: [], dice: [] }));
  c4.receive(evt(9));                       // gap: gapFrom=3, lastSeq=3
  var it1 = JSON.parse(JSON.stringify(c4.resyncIntent()));
  eq(it1.p.lastSeq, 3, 'resyncIntent：以缺口起点作为补拉起点', JSON.stringify(it1));
  eq(c4.resyncDiag().count, 1, 'resyncDiag：count 记到 1 次');
  c4.resyncIntent();
  eq(c4.resyncDiag().count, 2, 'resyncDiag：重复补拉计数累加（能量化「补拉循环」）');

  /* —— resyncDiag 字段 —— */
  var d = c4.resyncDiag();
  ok(typeof d.from === 'number' && typeof d.last === 'number' &&
     typeof d.filled === 'number' && typeof d.holes === 'number' && typeof d.count === 'number',
     'resyncDiag：五个字段都是数字（from/last/filled/holes/count）', JSON.stringify(d));
  eq(d.holes, 1, 'resyncDiag：当前仍挂着缺口 → holes=1', JSON.stringify(d));
  var c4last = c4.resyncDiag().last;
  c4.receive(evt(4));
  var d4 = c4.resyncDiag();
  eq(d4.holes, 0, 'resyncDiag：补齐后 holes=0', JSON.stringify(d4));
  ok(d4.filled > 0 && d4.last > c4last,
     'resyncDiag：补齐后 filled>0 且 lastSeq 前移（确实补到了内容）', JSON.stringify(d4));

  /* —— PlayerSide._onText：gap → gap-filled 必须真的回调 —— */
  function mkSide() {
    var client = mkClient();
    var events = [];
    var sent = [];
    var side = new N.PlayerSide({
      client: client,
      room: { code: 'ab12cd', wsUrl: 'ws://x/ws?code=ab12cd&t=t1', mtoken: 't1' },
      onEvent: function (st, info) { events.push(info); }
    });
    side.link = { send: function (s) { sent.push(s); }, close: function () {}, state: 'online' };
    return { side: side, client: client, events: events, sent: sent };
  }
  var S = mkSide();
  S.client.receive(M.syncMsg(1, { meta: {}, members: [], chats: [], logs: [], dice: [] }));
  S.side._onText(JSON.stringify(evt(5)));          // gap
  ok(S.events.some(function (e) { return e.kind === 'gap'; }), '_onText：跳号 → 回调 {kind:"gap"}');
  ok(S.sent.length === 1 && /"resync"|SYNC/i.test(S.sent[0]), '_onText：缺口会主动补拉（发了 resync）',
     JSON.stringify(S.sent));
  ok(S.side._gapWasOpen === true, '_onText：记下 _gapWasOpen=true');
  /* 补齐：头一条就是水位标记 —— 旧实现在这里静默 return，横幅永不消失 */
  S.side._onText(JSON.stringify(M.skipMsg(2)));
  var filled = S.events.filter(function (e) { return e.kind === 'gap-filled'; });
  eq(filled.length, 1, '_onText：skip 作为补齐第一条 → 回调且仅回调一次 {kind:"gap-filled"}');
  ok(filled.length === 1 && filled[0].from === 1,
     '_onText：gap-filled 带上补拉起点 from', JSON.stringify(filled));
  ok(S.side._gapWasOpen === false, '_onText：补齐后 _gapWasOpen 复位（不会重复回调）');

  /* 补齐后再来重复包（dup）不该二次回调 gap-filled */
  S.side._onText(JSON.stringify(evt(2)));
  eq(S.events.filter(function (e) { return e.kind === 'gap-filled'; }).length, 1,
     '_onText：已补齐后再收重复包 → 不重复发 gap-filled');

  /* —— 静态：4s 兜底 —— */
  var rui = readSrc('ui/room-ui.js');
  ok(/function armGapBannerTimeout\(s\)/.test(rui), 'room-ui 有 armGapBannerTimeout');
  ok(/function clearGapBannerTimeout\(s\)/.test(rui), 'room-ui 有 clearGapBannerTimeout');
  ok(/armGapBannerTimeout\(sess\)/.test(rui), 'gap 分支挂上了 armGapBannerTimeout');
  ok(/clearGapBannerTimeout\(sess\)/.test(rui), '补齐完成时撤掉计时器');
  ok(/}, 4000\);/.test(rui.slice(rui.indexOf('function armGapBannerTimeout'))),
     '兜底时长是 4 秒');
  ok(/记录可能未完全补齐/.test(rui), '超时文案给出出口（不无限挂着）');
  ok(/if \(!s\._gapFilling\) return;/.test(rui), '超时回调先判 _gapFilling（补齐了就什么都不做）');
  var netSrc = readSrc('core/room-net.js');
  ok(/k === 'error'/.test(netSrc.slice(netSrc.indexOf('PlayerSide.prototype._onRelay'))),
     '契约：PlayerSide._onRelay 有 error 分支（见 ⑪）');
})();

/* ============================================================
 * ⑪ 限流提示自动消失
 * ============================================================ */
section('⑪ 限流提示自动消失（beat：setBanner 真跑计时器）');
(function () {
  /* 把 setBanner 从 IIFE 里抽出来（花括号配对扫描），用一个假时钟真跑它的计时逻辑。 */
  var src = readSrc('ui/room-ui.js');
  var head = src.indexOf('function setBanner(s, text, kind, ms) {');
  ok(head > 0, '定位到 setBanner 源码');
  var i = src.indexOf('{', head), depth = 0, close = -1;
  for (var j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { close = j; break; } }
  }
  ok(close > 0, 'setBanner 花括号配对成功（源码结构完整）');
  var body = src.slice(head, close + 1);

  var harness = vm.runInNewContext([
    '(function () {',
    '  var clock = { now: 0, seq: 1, q: [] };',
    '  function setTimeout(fn, ms) { var id = clock.seq++; clock.q.push({ id: id, fn: fn, at: clock.now + ms }); return id; }',
    '  function clearTimeout(id) { clock.q = clock.q.filter(function (e) { return e.id !== id; }); }',
    '  var box = { kids: [], appendChild: function (n) { box.kids = [n]; } };',
    '  var pageRefs = { bannerEl: box };',
    '  var sess = null;',
    '  var global = { UI: { clear: function (b) { b.kids = []; } } };',
    '  function banner(text, kind) { return { text: text, kind: kind }; }',
    '  ' + body,
    '  return {',
    '    setBanner: setBanner, box: box, clock: clock,',
    '    setSess: function (s) { sess = s; },',
    '    tick: function (ms) {',
    '      clock.now += ms;',
    '      var due = clock.q.filter(function (e) { return e.at <= clock.now; });',
    '      clock.q = clock.q.filter(function (e) { return e.at > clock.now; });',
    '      due.forEach(function (e) { e.fn(); });',
    '      return due.length;',
    '    },',
    '    /* 每个场景前清空挂起队列：上一段用例遗留的旧会话计时器不该污染计数 */',
    '    purge: function () { clock.q = []; },',
    '    /* 只统计**当前会话**自己挂的计时器（精确到 id） */',
    '    timersOf: function (s) {',
    '      var ids = Object.keys(s || {}).filter(function (k) { return k === "_bannerT"; });',
    '      return clock.q.filter(function (e) {',
    '        return ids.some(function (k) { return s[k] === e.id; });',
    '      }).length;',
    '    },',
    '    pending: function () { return clock.q.length; }',
    '  };',
    '})()'
  ].join('\n'), vm.createContext({}));

  var H = harness;

  /* 每个场景前清空队列 + 用一个干净会话：避免上一段遗留计时器污染计数 */
  function scene() { H.purge(); var s = {}; H.setSess(s); return s; }

  /* err 默认 6000ms */
  var sess1 = scene();
  H.setBanner(sess1, '消息发送过于频繁，请稍后再试', 'err');
  eq(H.box.kids.length, 1, 'setBanner：横幅显示出来了');
  eq(H.timersOf(sess1), 1, 'setBanner(err)：err 类默认挂了一个自动清除计时器');
  H.tick(5999);
  eq(H.box.kids.length, 1, 'setBanner(err)：5999ms 时横幅还在');
  H.tick(2);
  eq(H.box.kids.length, 0, 'setBanner(err)：6000ms 后横幅自动消失（限流提示不再永久挂着）');

  /* warn 默认常驻（0ms） */
  var sess2 = scene();
  H.setBanner(sess2, '连接断开，正在重连…', 'warn');
  eq(H.box.kids.length, 1, 'setBanner(warn)：横幅显示');
  eq(H.timersOf(sess2), 0, 'setBanner(warn)：warn 默认常驻（不自动消失，向后兼容）');
  H.tick(60000);
  eq(H.box.kids.length, 1, 'setBanner(warn)：长时间后仍在（重连提示不该自动消失）');

  /* 显式 ms */
  var sess3 = scene();
  H.setBanner(sess3, '一次性', 'warn', 1500);
  eq(H.timersOf(sess3), 1, 'setBanner(warn, 1500)：显式时长也会挂计时器');
  H.tick(1501);
  eq(H.box.kids.length, 0, 'setBanner(warn, 1500)：1500ms 后消失');

  /* 向后兼容：三参调用语义不变（只是 err 会 6s 自杀） */
  var sess4 = scene();
  H.setBanner(sess4, 'A', 'err');
  eq(H.box.kids.length, 1, '三参调用：横幅正常显示');
  eq(H.timersOf(sess4), 1, '三参调用：err 仍走 6s 自动清除路径');

  /* 连续两条横幅：旧计时器不能把新横幅清掉 */
  var sess5 = scene();
  H.setBanner(sess5, '限流提示', 'err');            // 6s
  H.setBanner(sess5, '重连提示', 'warn');           // 常驻，且应先撤掉上一枚计时器
  eq(H.timersOf(sess5), 0, '连续设置：重设横幅时先撤掉上一枚计时器（不会误清新横幅）');
  H.tick(10000);
  eq(H.box.kids.length, 1, '连续设置：旧计时器不会把新横幅清掉', JSON.stringify(H.box.kids));
  eq(H.box.kids[0] && H.box.kids[0].text, '重连提示', '连续设置：留下的是新那条横幅');

  /* 会话代次保护：切了会话后旧计时器不得动新横幅 */
  var sessA = scene();
  H.setBanner(sessA, '旧会话的限流提示', 'err');
  var sessB = {};
  H.setSess(sessB);                                  // 切会话
  H.setBanner(sessB, '新会话的重连提示', 'warn');
  H.tick(10000);
  eq(H.box.kids.length, 1, '代次保护：旧会话计时器到点后不误清新会话横幅');
  eq(H.box.kids[0] && H.box.kids[0].text, '新会话的重连提示', '代次保护：留下的是新会话那条');

  /* 静态证据链：net 侧 error 分支 + UI 侧接线 */
  var net = readSrc('core/room-net.js');
  var relayTail = net.slice(net.indexOf('PlayerSide.prototype._onRelay'));
  ok(/k === 'error'/.test(relayTail), 'PlayerSide._onRelay 有 error 分支');
  ok(/this\.onError\(m\.message \|\| '房间服务返回错误'\)/.test(relayTail),
     'error 分支把服务端文案透传给 onError');
  var ui = readSrc('ui/room-ui.js');
  ok(/function setBanner\(s, text, kind, ms\)/.test(ui), 'setBanner 签名带可选第 4 参 ms');
  ok(/if \(s && s\._bannerT\) \{ clearTimeout\(s\._bannerT\); s\._bannerT = 0; \}/.test(ui),
     '每次设置前先撤掉旧计时器');
  ok(/if \(sess && sess !== s\) return;/.test(ui), '计时器回调里做会话代次保护（换会话不动新横幅）');
  ok(/var life = \(ms === undefined \|\| ms === null\) \? \(kind === 'err' \? 6000 : 0\) : \(Number\(ms\) \|\| 0\);/.test(ui),
     '缺省时长规则：err=6000ms，其它=0（常驻）');
  ok(/onError: function \(msg\) \{ if \(isStaleSession\(gen\)\) return; setBanner\(sess, msg, 'err'\); \}/.test(ui),
     'onError 接到 setBanner(sess, msg, "err") → 走 6s 自动消失路径');
})();

/* ============================================================
 * ① ⑥ ⑧ ⑨ 静态证据链（UI / CSS，无头环境）
 * ============================================================ */
section('① 全屏信息流停在最底部（静态）');
(function () {
  var ui = readSrc('ui/room-ui.js');
  ok(/function scrollFeedToBottom\(kind\)/.test(ui), 'scrollFeedToBottom 存在');
  var fn = ui.slice(ui.indexOf('function scrollFeedToBottom'), ui.indexOf('function scrollFeedToBottom') + 400);
  ok(/kind === 'chat'\) \? pageRefs\.chatListEl : pageRefs\.logEl/.test(fn),
     'chat 滚的是 **chatListEl**（不是 .gp-chat 自身）；log 滚 logEl', fn);
  ok(/target\.scrollTop = target\.scrollHeight/.test(fn), '实现 = scrollTop ← scrollHeight');
  ok(/if \(!target\) return;/.test(fn), '目标缺失时空转不崩');

  /* 三处调用点 */
  var fs_ = ui.slice(ui.indexOf('function fullscreenFeed'), ui.indexOf('function paintGameFeeds'));
  ok(/document\.body\.appendChild\(ov\);[\s\S]*?requestAnimationFrame\(function \(\) \{ scrollFeedToBottom\(kind\); \}\);/.test(fs_),
     '进入全屏：插 DOM 之后用 rAF 延到下一帧再滚（刚插入时 scrollHeight 还是 0）');
  ok(/scrollFeedToBottom\(kind\);\s*\}[\s\S]{0,80}\}/.test(fs_) &&
     /还原后也要滚回底部|scrollFeedToBottom\(kind\)/.test(fs_),
     'restore() 末尾也补一次（搬回原处同样会重置 scrollTop）');
  var pf = ui.slice(ui.indexOf('function paintGameFeeds'));
  ok(/if \(scrollBottom\) scrollFeedToBottom\('log'\);/.test(pf), 'paintGameFeeds：log 走 scrollFeedToBottom');
  ok(/scrollFeedToBottom\('chat'\);/.test(pf), 'paintGameFeeds：chat 走 scrollFeedToBottom');
  ok(pf.indexOf("scrollTop = scrollHeight") < 0 || !/\.gp-chat\b[\s\S]{0,200}scrollTop = scrollHeight/.test(ui),
     'paintGameFeeds 里散落的手写 scrollTop 已换成统一函数');
})();

section('⑥ 橡皮擦滑动实时擦除（静态）');
(function () {
  var rp = readSrc('ui/room-panels.js');
  ok(/var ERASE_TOL_DRAG_PX = 10;/.test(rp), '新增 ERASE_TOL_DRAG_PX = 10（滑动容差 ≈ 指腹）');
  ok(/var ERASE_STEP_PX = 4;/.test(rp), '新增 ERASE_STEP_PX = 4（插值步长，防虚线状残留）');
  ok(/var ERASE_TOL_PX = 2;/.test(rp), 'ERASE_TOL_PX = 2 保留（单点轻点缺省，行为不变）');
  ok(/function eraseStrokeSegments\(strokes, px, py, rect, tolPx\)/.test(rp),
     'eraseStrokeSegments 加了容差入参');
  ok(/var tol = \(typeof tolPx === 'number' && tolPx > 0\) \? tolPx : ERASE_TOL_PX;/.test(rp),
     '容差缺省回落到 ERASE_TOL_PX（向后兼容）');
  ok(/function bindErase\(hostEl, onMove, onEnd\)/.test(rp), 'bindErase 存在');
  ok(/function bindEraseStage\(stage, base, commit\)/.test(rp), 'bindEraseStage 存在');

  var bes = rp.slice(rp.indexOf('function bindEraseStage'), rp.indexOf('function bindEraseStage') + 1800);
  ok(/working = eraseStrokeSegments\(working, x, y, r, ERASE_TOL_DRAG_PX\);/.test(bes),
     'move 里用**滑动专用**容差 10px（不是 2px）', bes);
  ok(bes.indexOf('ctx.act') < 0, 'bindEraseStage 的 move 回调里**不出现 ctx.act**（不在滑动中上报）');
  ok(/if \(isLast\) paintLive\(\);/.test(bes), 'move 只整批处理一次重绘（不逐点重建 SVG）');
  ok(/if \(live && live\.parentNode\) live\.parentNode\.removeChild\(live\);[\s\S]*?commit\(working, base\);/.test(bes),
     '抬手(done)才收尾本地层并一次性提交');
  ok(/var steps = Math\.ceil\(dist \/ ERASE_STEP_PX\);/.test(rp), 'bindErase 按 ERASE_STEP_PX 插值补点');
  ok(/if \(steps > 240\) steps = 240;/.test(rp), '插值有上限防御（切后台回来的超大位移不暴走）');

  /* 三处入口全部 bindTap → bindEraseStage，无残留旧签名 */
  eq((rp.match(/bindEraseStage\(/g) || []).length, 4,
     'bindEraseStage：1 处定义 + 3 处调用（KP 地图 / 手绘板 / 玩家独立板）');
  eq((rpClean.match(/eraseAt\(/g) || []).length, 2, 'eraseAt：1 处定义 + 1 处调用');
  eq((rpClean.match(/eraseBoardAt\(/g) || []).length, 3, 'eraseBoardAt：1 处定义 + 2 处调用');
  ok(!/eraseAt\(ctx, hostEl, x, y\)|eraseBoardAt\(ctx, hostEl, x, y\)/.test(rpClean),
     '✱契约：全仓无旧签名 (ctx, hostEl, x, y) 的残留声明/调用');
  /* 每个调用点都必须紧跟在 bindEraseStage(stage, …, function (keep, base) { 之后 */
  var callWindows = [];
  (rpClean.match(/function \(keep, base\) \{[\s\S]{0,120}?erase(?:Board)?At\(ctx, keep, base\)/g) || [])
    .forEach(function (w) { callWindows.push(w.replace(/\s+/g, ' ')); });
  eq(callWindows.length, 3,
     '✱契约：3 个调用点全部是 `function (keep, base) { …eraseXxxAt(ctx, keep, base)` 形态',
     JSON.stringify(callWindows));
  /* 反向：不存在任何「bindTap 直接调擦除」的旧接线 */
  ok(!/bindTap\([\s\S]{0,400}?erase(?:Board)?At\(/.test(rpClean),
     '✱契约：无 bindTap→eraseAt/eraseBoardAt 的旧接线残留');

  /* strokesSvg：4 处调用点，无残留重复实现 */
  eq((rp.match(/strokesSvg\(/g) || []).length, 6,
     'strokesSvg：1 处定义 + 5 处调用（含 4 处笔迹渲染点）');
  ok(!/appendChild\(svgEl\('svg'/.test(rp), '✱契约：room-panels 内无残留的重复 svg 构造');

  /* commitMapStrokes 与模型侧字段一致 */
  ok(/function commitMapStrokes\(ctx, keep\)/.test(rp), 'commitMapStrokes 存在');
  var cms = rp.slice(rp.indexOf('function commitMapStrokes'), rp.indexOf('function commitMapStrokes') + 500);
  ok(/if \(M && M\.POLICY && M\.POLICY\['map\.strokes\.set'\]\) \{/.test(cms),
     'commitMapStrokes 用 M.POLICY 做能力探测');
  ok(/ctx\.act\(\{ op: 'map\.strokes\.set', strokes: keep \}\);/.test(cms),
     '✱契约：UI payload 字段名 `strokes` == 模型侧 mapStrokesSet(p) 读的 p.strokes');
  ok(/if \(!ctx \|\| !Array\.isArray\(keep\)\) return;/.test(cms), '非数组防御');
})();

section('⑧ KP 点手绘板全屏查看（静态）');
(function () {
  var rp = readSrc('ui/room-panels.js');
  var vb = rp.slice(rp.indexOf('function viewBoardSheet'), rp.indexOf('function viewBoardSheet') + 2600);
  ok(/var strokes = \(rec && rec\.strokes\) \|\| \[\];/.test(vb), '取正文 strokes（缺省回落空集）');
  ok(/info\.count \? \('共 ' \+ info\.count \+ ' 笔'\) : '这位玩家还没画过'/.test(vb),
     '取不到正文 → 回落「共 N 笔」/「还没画过」提示');
  ok(/var ov = el\('div\.gp-fs\.gp-fs--board'\);/.test(vb), '全屏覆盖层用 div.gp-fs.gp-fs--board');
  ok(/'🎨 ' \+ who \+ ' 的手绘板'/.test(vb), '头部标题「🎨 X 的手绘板」');
  ok(/'← 返回'/.test(vb), '头部有「← 返回」，可退出');
  ok(/if \(ev\.target === ov \|\| ev\.target === bodyEl\) close\(\);/.test(vb), '点空白也关');
  ok(/ctx\.host\._boardBySeat\[seat\]/.test(vb), '正文读 ctx.host._boardBySeat[seat].strokes（协议零改动）');
  ok(vb.indexOf('bindDraw') < 0 && vb.indexOf('bindErase') < 0 && vb.indexOf('ctx.act') < 0,
     '只读：不挂绘制/擦除手势、不发任何 act');
  ok(/只读（正文只回本人，KP 看的是本机权威副本）/.test(vb), '明确标注只读语义');
  var css = fs.readFileSync(path.join('web/css/app.css'), 'utf8');
  ok(/\.gp-fs\.gp-fs--board \{/.test(css), 'CSS：.gp-fs--board 规则存在');
  ok(/\.gp-fs--board \.gp-fs-body \.board-stage \{/.test(css), 'CSS：board-stage 版面规则存在');
  var model = readSrc('core/room-model.js');
  ok(/this\._boardBySeat = \{\};/.test(model), '模型侧 Host 确实有 _boardBySeat 容器（UI 读的不是空气）');
  ok(/this\._boardBySeat\[seat\] = rec;/.test(model), 'boardSelf 会写回 _boardBySeat');
})();

section('⑨ 放置单位落点击位置（静态）');
(function () {
  var rp = readSrc('ui/room-panels.js');
  /* ⚠️ 必须在**剥掉注释**后检查：注释里特意留了「旧实现硬编码 x:0.5」的说明。 */
  var pa = rpClean.slice(rpClean.indexOf('function placeActorSheet'),
                         rpClean.indexOf('function placeActorSheet') + 1400);
  ok(!/0\.5/.test(pa),
     '✱契约：placeActorSheet 代码里已无 0.5 硬编码（旧实现永远落在地图正中心）', pa);
  ok(/UI_STATE\.tool = \{ mode: 'mark', icon: '👹'/.test(pa), '改为切换到 mark 工具态');
  ok(/actorName: nm/.test(pa), '工具态记下 actorName（待落点的单位名）');
  ok(/playerName: ''/.test(pa), '互斥：同时把 playerName 清空');
  ok(/toast\('现在去图上点一下，放置「' \+ nm \+ '」'/.test(pa), '给出「去图上点一下」的引导 toast');
  ok(/api\.close\(\);/.test(pa) && /rerender\(ctx\);/.test(pa), '关闭弹层并重绘（让工具态生效）');
  /* mark 分支对称处理 actorName */
  var mark = rp.slice(rp.indexOf("var plName = UI_STATE.tool.playerName;"),
                      rp.indexOf("var plName = UI_STATE.tool.playerName;") + 700);
  ok(/var acName = UI_STATE\.tool\.actorName;/.test(mark), 'mapStage 的 mark 分支读 actorName');
  ok(/acName \? \('👹 ' \+ acName\)/.test(mark), '单位标记标签前缀 👹（与 👤 玩家对称）');
  ok(/UI_STATE\.tool\.actorName = '';/.test(mark), '落完即清空 actorName（不会一直重复放）');
  ok(/toast\('已放置单位：' \+ acName/.test(mark), '落点后有「已放置单位」回执');
})();

section('⑩ 竖屏记录框固定高度 + .gp-grid 零回归（CSS）');
(function () {
  var s = fs.readFileSync(path.join('web/css/app.css'), 'utf8');
  var opened = s.split('{').length - 1, closed = s.split('}').length - 1;
  eq(opened, closed, '★ app.css 花括号配平（' + opened + ' 对）');

  var block = s.slice(s.indexOf('没有 .gp-grid 前缀'));
  ok(/:not\(\.gp-grid\) \.gp-region-pl-feeds \{ flex: 0 0 auto; \}/.test(s),
     '⑩ 规则1：竖屏 .gp-region-pl-feeds 固定为 auto（不再被拉满屏）');
  ok(/:not\(\.gp-grid\) \.gp-region-pl-feeds \.gp-glog,[\s\S]{0,120}:not\(\.gp-grid\) \.gp-info \.gp-glog \{ max-height: 34vh; \}/.test(s),
     '⑩ 规则2：竖屏 .gp-glog 限高 34vh + 内部滚动');

  /* —— .gp-grid 零回归 ——
     ⚠️ 为什么不用「改动前文件」做 diff：仓库里唯一可当基线的副本
     （android/app/src/main/assets/css/app.css）会被同组同事的构建同步覆盖
     （本次 QA 期间就被覆盖过一次），基线不可靠。改用**不依赖历史版本**的不变量：
       ① 本次新增的规则必须全部带 :not(.gp-grid)；
       ② 任何**正向** .gp-grid 选拔器（`.game-page.gp-grid …`）都不得声明
          本次⑩涉及的两条属性（.gp-region-pl-feeds 的 flex / .gp-glog 的 max-height:34vh）；
       ③ .gp-grid 正向选拔器总数稳定在 76 条（新增即为回归信号）。
  */
  function selectorLines(text) {
    var stripped = text.replace(/\/\*[\s\S]*?\*\//g, '');
    var lines = [];
    stripped.split('\n').forEach(function (l) {
      if (l.indexOf('gp-grid') >= 0 && l.indexOf('{') >= 0) lines.push(l.trim());
    });
    return lines;
  }
  var all = selectorLines(s);
  var positive = all.filter(function (l) { return l.indexOf(':not(') < 0; });
  var negated = all.filter(function (l) { return l.indexOf(':not(') >= 0; });

  eq(positive.length, 76, '★ .gp-grid **正向**选拔器总数稳定在 76 条（新增即为横屏回归）');
  ok(!positive.some(function (l) { return /gp-region-pl-feeds/.test(l) && /flex/.test(l); }),
     '★ 无正向 .gp-grid 规则改 .gp-region-pl-feeds 的 flex（横屏排布不动）');
  ok(!positive.some(function (l) { return /gp-glog/.test(l) && /34vh/.test(l); }),
     '★ 无正向 .gp-grid 规则给 .gp-glog 设 34vh（横屏仍是自适应撑满）');
  ok(positive.every(function (l) { return /^\.game-page(\.[\w-]+)*\.gp-grid[.\s{]/.test(l); }),
     '★ 所有正向选拔器都是 .game-page 变体 + .gp-grid 写法统一（没人另起炉灶）',
     JSON.stringify(positive.filter(function (l) { return !/^\.game-page(\.[\w-]+)*\.gp-grid[.\s{]/.test(l); })));
  ok(negated.every(function (l) { return l.indexOf(':not(.gp-grid)') >= 0; }),
     '★ 所有反向选拔器一律用 :not(.gp-grid)（不用 @media 承载结构）');
  ok(/\.game-page:not\(\.gp-grid\) \.gp-region-pl-feeds \{ flex: 0 0 auto; \}/.test(s),
     '★ ⑩只新增了这两条 :not(.gp-grid) 规则（之一）');
  ok(/\.game-page:not\(\.gp-grid\) \.gp-info \.gp-glog \{ max-height: 34vh; \}/.test(s),
     '★ ⑩只新增了这两条 :not(.gp-grid) 规则（之二）');
  ok(/\.gp-region-pl-feeds \.gp-glog \{ flex: 1 1 auto; min-height: 48px; max-height: none; overflow-y: auto; \}/.test(s),
     '根因那行（无前缀的 max-height:none）未被改动（⑩选择绕开而非修改它）');
})();

/* ============================================================
 * 跨组接口契约汇总（两位工程师分头改，最容易在这里脱节）
 * ============================================================ */
section('✱ 跨组接口契约专项');
(function () {
  var model = readSrc('core/room-model.js');
  var panels = readSrc('ui/room-panels.js');
  var net = readSrc('core/room-net.js');

  /* (1) map.strokes.set：权限表 + 分发 + 处理函数 + UI 字段名，四处对齐 */
  ok(/'map\.strokes\.set': \{ roles: \['kp'\], confirm: null \}/.test(model), '① POLICY 登记');
  ok(/} else if \(op === 'map\.strokes\.set'\) \{/.test(model), '② op 分发分支');
  ok(/out = out\.concat\(this\.mapStrokesSet\(p\)\);/.test(model), '③ 处理函数被调用');
  ok(/Host\.prototype\.mapStrokesSet = function \(p\) \{/.test(model), '④ 处理函数存在');
  ok(/ctx\.act\(\{ op: 'map\.strokes\.set', strokes: keep \}\);/.test(panels), '⑤ UI payload = {strokes}');
  ok(/var list = Array\.isArray\(p && p\.strokes\) \? p\.strokes : \[\];/.test(model),
     '⑥ 模型侧读 p.strokes（字段名与 UI 一致）');

  /* (2) aBase / bBase 全链路字段名一致 */
  ok(/op: 'check\.opposed',[\s\S]{0,300}aBase: av,[\s\S]{0,300}bBase: bv/.test(panels) ||
     /aSeat: aSel\.value, aSkill: M\.cleanText\(aSkill\.value, 20\), aBase: av,[\s\S]{0,200}bBase: bv/.test(panels),
     'UI：genericOpposedSheet 提交带 aBase / bBase');
  ok(/var aBase = normBase\(p\.aBase\);/.test(model) && /var bBase = normBase\(p\.bBase\);/.test(model),
     'checkOpposed 读 p.aBase / p.bBase');
  ok(/this\._resolveActorSkill\(p\.aSeat, p\.aSkill, aBase\)/.test(model) &&
     /this\._resolveActorSkill\(p\.bSeat, p\.bSkill, bBase\)/.test(model),
     '归一化后透传给 _resolveActorSkill 当 fallback');
  ok(/if \(a && a\.ok === false\)/.test(model) && /if \(b && b\.ok === false\)/.test(model),
     '任一方报错就整体拒绝（不出半截结果卡）');

  /* (3) 本地候选池：模型字段 vs UI 读取 */
  ok(/this\.localActors = \[\];/.test(model), 'Host 构造里初始化 localActors');
  ok(/if \(ctx\.host && ctx\.host\.localActors\) \(ctx\.host\.localActors \|\| \[\]\)\.forEach\(add\);/.test(panels),
     'UI actorPool 会读 ctx.host.localActors（探索态候选池）');
  ok(/typeof ctx\.host\.addLocalActor === 'function'/.test(panels),
     'UI 优先走 host.addLocalActor（带去重）');
  ok(/localActors: clone\(this\.localActors\)/.test(model) && /this\.localActors = clone\(save\.localActors \|\| \[\]\);/.test(model),
     'localActors 双向进存档（save / adoptSave）');

  /* (4) 补拉链路的东西两侧接线 */
  ok(/kind: 'gap-filled'/.test(net), 'net 侧会发 gap-filled 事件');
  ok(/info && info\.kind === 'gap'/.test(readSrc('ui/room-ui.js')), 'ui 侧接住了 gap 事件');
  ok(/_gapWasOpen/.test(net) && /_boardBySeat/.test(panels), '两侧内部状态各自落地');

  /* (5) 不该出现的东西 */
  ok(model.indexOf(' KP 清空了地图上的绘画') < 0, '模型里再无「KP 清空了地图上的绘画」文案');
  ok(!/bindTap\([\s\S]{0,400}?erase(?:Board)?At\(/.test(rpClean),
     '✱契约：无 bindTap 调擦除的旧接线残留（三入口已全部换成 bindEraseStage）');
})();

/* ============================================================
 * ✱ 判活口径跨层对齐（QA 回发 · software-engineer-2 修复复验）
 *
 * 背景：我曾报
 *   「UI 判活比模型严格 —— 缺 hpMax>0 守卫；KP 把添加怪物的默认 HP 清空留白后，
 *    该单位战斗轮次照常轮到它（模型 slotDown 认为活着），却在 ⚔ 对抗下拉里消失
 *    （UI 认为死了）」。
 * 修复：room-panels 新增 unitDown(pub) 并对齐 room-model#slotDown；
 *       同语义的 isDown(slot) 改为委托 unitDown（消除第二份判据）。
 *
 * 这里的重点不是「函数存在」，而是**把两侧真实实现抠出来跑真值表比对** ——
 * 只要任一侧以后再改判据而另一侧没跟，这条就会红。
 * ============================================================ */
section('✱ 判活口径 UI↔模型 对齐（真值表比对）');
(function () {
  var panels = readSrc('ui/room-panels.js');
  var model = stripComments(readSrc('core/room-model.js'));

  /* —— ① 结构与接线（静态） —— */
  ok(/function unitDown\(pub\)/.test(panels), 'UI 有与模型 slotDown 对齐的判活 helper：unitDown');
  ok(/if \(p\.hp !== undefined && p\.hp !== null && Number\(p\.hpMax \|\| 0\) > 0 && Number\(p\.hp\) <= 0\) return true;/.test(panels),
     'hp 判死必须同时满足 hpMax > 0（没登记血量不算死）');
  ok(/必须与 `room-model\.js#slotDown` 保持同一口径/.test(panels),
     '注释写明「必须与 room-model#slotDown 同口径」（漂移时有据可查）');
  ok(/if \(unitDown\(s\.public\)\) return false;/.test(panels), 'monsterList 走 unitDown');
  ok(/return !unitDown\(s\.public\);/.test(panels), 'aliveUnits.isAlive 走 unitDown');
  ok(/function isDown\(slot\) \{\s*\n\s*return unitDown\(\(slot && slot\.public\) \|\| \{\}\);/.test(panels),
     '★ isDown 委托 unitDown（UI 内不再并存第二份判活逻辑）');
  eq((panels.match(/isDown\(/g) || []).length, 5, 'isDown：1 处定义 + 4 处调用，全部经委托');
  var allUi = stripComments(readSrc('ui/room-panels.js')) + '\n' +
              stripComments(readSrc('ui/room-ui.js'));
  ok(!/Number\(pub\.hp\) <= 0/.test(allUi) && !/pub\.hp <= 0/.test(allUi),
     '★ 全 UI 层无「裸 hp<=0」判活的残留（原 bug 的两个发散点已收敛）');

  /* —— ② 把两侧真实实现抠出来 —— */
  function numLike(v, dflt) { var n = Number(v); return isFinite(n) ? n : dflt; }
  function extractFn(src, name) {
    var head = src.indexOf('function ' + name + '(');
    if (head < 0) return null;
    var i = src.indexOf('{', head), depth = 0, close = -1;
    for (var j = i; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) { close = j; break; } }
    }
    return close > 0 ? src.slice(head, close + 1) : null;
  }
  var slotDownSrc = extractFn(model, 'slotDown');
  var unitDownSrc = extractFn(panels, 'unitDown');
  ok(!!slotDownSrc, '从 room-model.js 抠出 slotDown 源码');
  ok(!!unitDownSrc, '从 room-panels.js 抠出 unitDown 源码');

  function wrapFn(body, extraLib) {
    return vm.runInNewContext('(function(){' + (extraLib || '') + ';' + body +
      '; return ' + /function (\w+)/.exec(body)[1] + ';})()', vm.createContext({}));
  }
  /* 模型侧的 num(v,dflt) 内部助手 */
  var slotDown = wrapFn(slotDownSrc, 'function num(v,d){var n=Number(v);return isFinite(n)?n:d;}');
  var unitDown = wrapFn(unitDownSrc, '');

  /* —— ③ 真值表：逐个 public 形态比对，必须零漂移 —— */
  var cases = [
    { name: '空气（无 public 字段）',            pub: {},                       want: false },
    { name: 'down:true（被打死）',                pub: { down: true },           want: true  },
    { name: 'state:"dead"（被打死）',             pub: { state: 'dead' },        want: true  },
    { name: '★ hp:0,hpMax:0（没登记血量）',       pub: { hp: 0, hpMax: 0 },      want: false },
    { name: '★ hp:0,hpMax:12（血条空了）',        pub: { hp: 0, hpMax: 12 },     want: true  },
    { name: 'hp:5,hpMax:12（活着）',              pub: { hp: 5, hpMax: 12 },     want: false },
    { name: 'hp:-3,hpMax:12（溢出负血）',         pub: { hp: -3, hpMax: 12 },    want: true  },
    { name: 'hp:12,hpMax:0（有血无上限）',        pub: { hp: 12, hpMax: 0 },     want: false },
    { name: 'hp 缺失（undefined）',               pub: { hpMax: 12 },            want: false },
    { name: 'hp:null',                            pub: { hp: null, hpMax: 12 },  want: false },
    { name: 'hpMax 缺失',                         pub: { hp: 0 },                want: false },
    { name: '字符串数字 hp:"0",hpMax:"12"',       pub: { hp: '0', hpMax: '12' }, want: true  },
    { name: 'down:false + 空 state + 有血',       pub: { down: false, state: '', hp: 3, hpMax: 9 }, want: false },
    { name: 'down:false 但血条空了',              pub: { down: false, hp: 0, hpMax: 9 }, want: true }
  ];
  var drift = [];
  cases.forEach(function (c) {
    var a = slotDown({ public: c.pub });
    var b = unitDown(c.pub);
    if (a !== b) drift.push(c.name + ' model=' + a + ' ui=' + b);
    if (a !== c.want) drift.push(c.name + ' 期望=' + c.want + ' 实际(model)=' + a);
  });
  eq(drift.length, 0,
     '★ slotDown vs unitDown：' + cases.length + ' 例真值表逐例比对零漂移', JSON.stringify(drift));

  /* 原 bug 的两个关键例，单独再钉一次（防止被上面的表稀释） */
  eq(slotDown({ public: { hp: 0, hpMax: 0 } }), false, '原 bug 例①：模型 —— 没登记血量不算阵亡');
  eq(unitDown({ hp: 0, hpMax: 0 }), false, '原 bug 例①：UI —— 没登记血量不算阵亡（修复点）');
  eq(slotDown({ public: { hp: 0, hpMax: 12 } }), true, '原 bug 例②：模型 —— 血条空了才算阵亡');
  eq(unitDown({ hp: 0, hpMax: 12 }), true, '原 bug 例②：UI —— 血条空了才算阵亡（未误伤）');

  /* —— ④ 探索态路径：不在战斗槽里（slots[id] 不存在）→ 视为存活 —— */
  var uiAliveSrc = extractFn(panels, 'aliveUnits');
  ok(/if \(!s\) return true;/.test(uiAliveSrc || ''),
     'aliveUnits：不在战斗槽（探索态）→ 视为存活（没填 HP 的候选池单位照常列出）');

  /* —— ⑤ 残留理论差异：非数值 hp 的降级口径 ——
     模型 num(hp,0) 把垃圾值降级成 0 → 判死；UI Number(hp)<=0 得到 NaN → 不判死。
     只要 public.hp 恒为数值就不可达，下面证明写入路径都做了强转。 */
  var writes = [
    /hp: num\(a\.hp, 0\),/,
    /hpMax: num\(a\.hpMax, 0\),/,
    /pub\.hp = Math\.max\(0, beforeHp - dmg\);/,
    /pub\.hp = Math\.max\(0, victimHpBefore - applied\);/,
    /* v2.8.0（HP 机制）：以下两条为「扣血入口收口到 applyHpChange」后调整的新写法
       （原 `pub.hp = Math.max(0, num(pub.hp,0)-amount)` / `...-applied` 已改写），随口径变更同步更新。 */
    /if \(hpNow != null\) pub\.hp = Math\.max\(0, hpNow\);/, 
    /if \(!isFinite\(Number\(pub\.hp\)\)\) pub\.hp = num\(pub\.hpMax, 0\);/
  ];
  ok(writes.every(function (re) { return re.test(model); }),
     '所有写入 public.hp / hpMax 的路径都经 num()/Math.max 强转 → 「非数值 hp」不可达',
     JSON.stringify(writes.filter(function (re) { return !re.test(model); }).map(String)));
  var junk = { hp: 'abc', hpMax: 12 };
  ok(slotDown({ public: junk }) === true && unitDown(junk) === false,
     '（已知理论差异）非数值 hp：模型降级成 0 判死 / UI NaN 不判死 —— 因上述不可达，接受现状');
})();

console.log('\nv2.5.0 fixes QA-regression: ' + pass + ' passed, ' + fail + ' failed');
console.log('RESULT: ' + (fail ? 'FAIL' : 'PASS'));
process.exit(fail ? 1 : 0);
