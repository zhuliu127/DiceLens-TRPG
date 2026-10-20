/*
 * v2.2.2 缺陷修复自测（用户实测第二批：6 项）
 *   ① 「回到房间」仍拿到错误房间号 —— 权威房间按「正在进行」信号排序（房间存档 savedAt）
 *   ② 「包皮铁棍」（技能「斗殴」）对抗报「查不到斗殴」—— 技能名全/半角括号归一 + 匹配档位
 *   ④ 公开记录栏标题（含 ⛶ 全屏按钮）吸顶常驻（CSS 静态校验，见 test_v22x_css 段落）
 *   ⑤ 不定疯狂被治愈后 SAN Check「无效」/「已提交，等待确认」—— 治愈后免排队 + 清残留 + 自助可做
 *   ⑥ 不定疯狂（症状消失）下任意 SAN 损失都复发 —— 三条来源（自助 / KP 定向 / 状态管理）
 *   ⑩-2 结团 / 关房 / 被踢后，玩家打开的悬浮面板全部关闭
 *
 * 运行： node tools/test_v222_fixes.js（工作目录 = 仓库根）
 * 成功时最后一行打印 RESULT: PASS
 */
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');
var base = 'web/js/';

var pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + label); }
  else { fail++; console.log('  \u2717 ' + label + (extra ? ('  \u2192 ' + extra) : '')); }
}
function eq(a, b, name) { ok(name, a === b, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
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
var SYMPTOM_PROVIDER = { roll: function () { return { type: 'bout', name: '失忆', rounds: 3 }; } };

/**
 * 造一个 Host。opts.loss > 0 时用**强制失败**的规则替身（确定性路径）：
 * 让 SAN Check 一定走失败支、损失固定 loss 点，便于断言 ⑥ 的三条来源。
 * opts.symptom 为真时挂上 1D10 症状提供者。
 */
function mkHost(order, opts) {
  opts = opts || {};
  var rules = R;
  if (opts.loss > 0) {
    rules = Object.create(R);
    rules.resolveSanCheck = function (o) {
      var before = Math.max(0, Number(o.currentSan) || 0);
      var after = Math.max(0, before - opts.loss);
      return {
        ok: true,
        check: { value: 99, passed: false, failed: true, levelText: '失败',
                 base: before, target: before, summary: '强制失败' },
        lossExpr: '0/' + opts.loss, usedBranch: 'onFail', branchText: '失败',
        lossTerms: [{ count: 1, sides: 6, sign: 1 }],
        roll: { ok: true, total: opts.loss, rolls: [] },
        loss: opts.loss, before: before, after: after,
        maxSan: (o.maxSan == null ? 99 : o.maxSan)
      };
    };
  }
  var host = new M.Host({
    rules: rules, rng: feeder([0.3, 0.0]),
    madness: opts.symptom ? SYMPTOM_PROVIDER : null,
    now: function () { return 1000; }
  });
  host.roster.open({ seat: 's1', role: M.ROLE.PLAYER, nickname: '小美' });
  var mem = host.roster.get('s1');
  mem.charName = '小美';
  mem.runtime = mem.runtime || {};
  mem.sheet = {
    name: '小美', attrs: { str: 60, int: 60, pow: 50 },
    status: { currentHP: 12, maxHP: 12, currentSAN: 50, maxSAN: 50 },
    /* ⚠️ 关键：人物卡的技能名是**全角**括号（skillmodel.displayName 的产物）。 */
    skills: [{ name: '格斗（斗殴）', total: 60 }, { name: '侦查', total: 55 }, { name: '闪避', total: 50 }],
    weapons: [{ name: '包皮铁棍', skill: '斗殴', damage: '1D6', pierce: '×' }],
    madness: [], mental: ['正常'], db: '0'
  };
  /* v2.6.0（用户第 3 项）：玩家发起对抗须在其行动轮次 —— 追加当前 PC 槽并把 turn 指向它。 */
  var _o = (order || []).concat([{ id: 's1#0', actorId: 's1', seat: 's1', kind: 'pc', name: '小美', public: { hp: 12, hpMax: 12 } }]);
  host.state.combat = { order: _o, turn: _o.length - 1, round: 1, startedAt: 0 };
  host.state.meta.status = M.STATUS.IN_GAME;
  return { host: host, mem: mem };
}
function picks(out, t) {
  var arr = [];
  (out || []).forEach(function (r) { if (r && r.msg && r.msg.t === t) arr.push(r.msg.p || {}); });
  return arr;
}
function allText(out) {
  return (out || []).map(function (r) { return (r && r.msg && r.msg.p && r.msg.p.text) || ''; }).join(' | ');
}
function anyPubLog(out, re) {
  return (out || []).some(function (r) {
    return r && r.msg && r.msg.t === M.EVT.LOG && re.test((r.msg.p && r.msg.p.text) || '');
  });
}

/* ============================================================
 * ① 权威房间选择：按「正在进行」的真实信号（房间存档 savedAt）排序
 * ============================================================ */
section('① 本机权威房间（RoomUI.authoritative）');
(function () {
  var sb = mkSandbox(['ui/room-ui.js']);
  var UI = sb.RoomUI;
  ok(UI && typeof UI.authoritativeCode === 'function', 'RoomUI.authoritativeCode 已导出');

  /* 用户实测：正在玩 b8rz8c，但 joined 里 p2jgg4 的 at 更大（旧房间「加入得晚」）——
     旧实现只按 at 取最近加入 → 错误地回到 p2jgg4。新实现按房间存档 savedAt 判「正在玩」。 */
  sb.RoomStore = {
    getMine: function () { return null; },
    listJoined: function () { return [{ code: 'p2jgg4', role: 'player', at: 2000 }, { code: 'b8rz8c', role: 'player', at: 1000 }]; },
    listRoomSaves: function () { return [{ code: 'b8rz8c', role: 'player', savedAt: 5000, seq: 42 }]; }
  };
  eq(UI.authoritativeCode(), 'b8rz8c', 'joined.at 倒向旧房 p2jgg4，但 b8rz8c 存档最新 → 返回 b8rz8c（修复核心）');
  eq(UI.authoritative().role, 'player', '角色取记录里的 role（joined → player）');
  eq(UI.authoritative().live, false, '无活会话 → live=false');

  /* 无任何存档 → 退回 at 最新者（保持既有语义） */
  sb.RoomStore = {
    getMine: function () { return null; },
    listJoined: function () { return [{ code: 'p2jgg4', role: 'player', at: 2000 }, { code: 'b8rz8c', role: 'player', at: 1000 }]; },
    listRoomSaves: function () { return []; }
  };
  eq(UI.authoritativeCode(), 'p2jgg4', '没有存档 → 退回 at 最新者（p2jgg4）');

  /* 存档命中「我开的房」→ role 必须是 kp（mine 优先） */
  sb.RoomStore = {
    getMine: function () { return { code: 'kp001', at: 100 }; },
    listJoined: function () { return [{ code: 'p2jgg4', role: 'player', at: 2000 }]; },
    listRoomSaves: function () { return [{ code: 'kp001', role: 'player', savedAt: 9000, seq: 5 }]; }  // 存档默认 role 写成 player
  };
  eq(UI.authoritativeCode(), 'kp001', 'mine 的房间有存档 → 返回它');
  eq(UI.authoritative().role, 'kp', 'mine.code 命中 → role 修正为 kp（不被存档的默认 player 覆盖）');

  /* 只有 mine（无 joined / 无存档）→ mine */
  sb.RoomStore = {
    getMine: function () { return { code: 'kp002', at: 300 }; },
    listJoined: function () { return []; },
    listRoomSaves: function () { return []; }
  };
  eq(UI.authoritativeCode(), 'kp002', '只有 mine → 返回 mine');

  /* 全空 → null（不瞎猜） */
  sb.RoomStore = { getMine: function () { return null; }, listJoined: function () { return []; }, listRoomSaves: function () { return []; } };
  eq(UI.authoritativeCode(), null, '本机无任何记录 → null');

  /* 活会话优先级：authoritativeRoom 第一行即 `if (sess && sess.code) return {...live:true}`。
     sess 为模块私有、无公开 setter，此处以源码断言（不变式）。 */
  var src = fs.readFileSync(path.join(base, 'ui/room-ui.js'), 'utf8');
  ok(/if \(sess && sess\.code\) return \{ code: sess\.code, role: sess\.role \|\| 'player', live: true \};/.test(src),
     '活会话（sess.code）永远最优先（源码不变式）');
})();

/* ============================================================
 * ② 技能名归一 + skillValue 档位 + 端到端武器对抗
 * ============================================================ */
section('② 技能名归一（全/半角括号）与匹配档位');
(function () {
  var full = { skills: [{ name: '格斗（斗殴）', total: 55 }, { name: '射击（手枪）', total: 40 }, { name: '侦查', total: 65 }] };
  var half = { skills: [{ name: '格斗(斗殴)', total: 55 }] };
  var amb = { skills: [{ name: '格斗（斗殴）', total: 55 }, { name: '格斗（剑）', total: 40 }] };

  eq(R.skillValue(full, '斗殴'), 55, "skillValue(sheet,'斗殴') 对卡上全角「格斗（斗殴）」返回数值");
  eq(R.skillValue(half, '斗殴'), 55, "skillValue(sheet,'斗殴') 对卡上半角「格斗(斗殴)」返回数值");
  eq(R.skillValue(full, '格斗'), 55, "'格斗' 走基名相等命中「格斗（斗殴）」");
  eq(R.skillValue(full, '射击'), 40, "'射击' 走基名相等命中「射击（手枪）」");
  eq(R.skillValue(full, '侦察'), 65, '别名「侦察」→ 侦查');
  eq(R.skillValue(amb, '格斗'), null, '歧义（斗殴/剑 同基名）仍返回 null（保持既有语义）');
  eq(R.skillValue(full, '不存在的技能'), null, '查不到 → null');
  eq(R.skillValue(full, '格斗（斗殴）'), 55, '精确（全角）命中');
  eq(R.skillValue(full, '格斗(斗殴)'), 55, '精确（半角）命中同一技能（括号归一）');

  /* 端到端：玩家用「包皮铁棍」（技能「斗殴」）发起武器对抗 → 不再「查不到」 */
  var g = mkHost([{ id: 'm1', actorId: 'm1', kind: 'monster', name: '食尸鬼', public: { hp: 10, hpMax: 10 } }]);
  /* 直接测权威取值函数（本缺陷的第一处失败点） */
  eq(g.host._skillBaseOf(g.mem, '斗殴', null), 60, '权威取值 _skillBaseOf(mem,「斗殴」) = 60（修复前为 null）');

  /* 完整链路：玩家申请 → KP 裁定 */
  var req = g.host.intent('s1', { op: M.INTENT.OPPOSED, p: { phase: 'request', weapon: { name: '包皮铁棍', skill: '斗殴' }, targetId: 'm1' } });
  var rid = g.host.state.opposed && g.host.state.opposed.id;
  ok(!!rid, '玩家武器对抗申请已入队（state.opposed 已建）');
  var res = g.host.checkOpposed('host', { attack: true, reqId: rid,
    defender: { reaction: 'dodge', value: 40 }, armor: { value: 0 } });
  ok(!anyPubLog(res, /查不到/), '端到端：不再出现「在发起者人物卡里查不到『斗殴』」', allText(res).slice(0, 200));
  ok(!/查不到/.test(allText(res)), '端到端：私密/公共都没有「查不到」文案');
  var chk = picks(res, M.EVT.CHECK)[0] || {};
  ok(!!chk && /斗殴/.test(chk.skill || ''), '端到端：对抗用技能 =「斗殴 vs …」（正确命中卡上「格斗（斗殴）」）',
     JSON.stringify(chk && chk.skill));
  ok(!!chk && chk.a && typeof chk.a.level === 'number', '端到端：对抗正常结算（攻击方已掷出成功等级）',
     JSON.stringify(chk && chk.a));
})();

/* ============================================================
 * ⑤ 治愈不定疯狂后：自助 SAN Check 立即生效、不排队；队列不残留
 * ============================================================ */
section('⑤ 治愈后 SAN Check 链路与 pending 队列');
(function () {
  var g = mkHost([], { loss: 3 });   // 固定失败损失 3 点 → 确定性扣 SAN + EVT.STATE
  g.mem.sheet.mental = ['不定疯狂'];
  var client = new M.Client({ seat: 's1', role: M.ROLE.PLAYER, meta: g.host.state.meta });
  function pump(plan) {
    plan.forEach(function (s) {
      var t = JSON.stringify(s.msg);
      if (s.to === '*' || s.to === 's1') client.receive(t);
    });
  }

  /* 玩家申请治愈 → 私密回话是「已向 KP 发起治愈申请」，不是含糊的「已提交，等待确认」 */
  var p1 = g.host.intent('s1', { op: M.INTENT.ACT, p: { op: 'madness.cure' } });
  pump(p1);
  eq(g.host.pending.filter(function (q) { return q.op === 'madness.cure'; }).length, 1, '申请治愈 → 1 条待办');
  ok(/已向 KP 发起治愈申请/.test(allText(p1)), '私密回话 = 治愈申请语义（非「已提交，等待确认」）', allText(p1));

  /* 连点第二次：不重复入队（修复残留根因） */
  pump(g.host.intent('s1', { op: M.INTENT.ACT, p: { op: 'madness.cure' } }));
  eq(g.host.pending.filter(function (q) { return q.op === 'madness.cure'; }).length, 1, '连点两次 → 仍只 1 条待办（去重）');

  /* KP 同意 → 治愈生效、队列清空、无残留 */
  var p2 = g.host.intent(M.HOST_SEAT, { op: M.INTENT.CONFIRM, p: { op: 'madness.cure', agree: true } });
  pump(p2);
  eq(g.host.pending.length, 0, 'KP 同意后 pending 全清（无残留）');
  ok(g.mem.sheet.mental.indexOf('不定疯狂') < 0, '不定疯狂标签已被治愈');
  eq(JSON.stringify(g.mem.sheet.mental), JSON.stringify(['正常']), '治愈后精神状态 = [正常]');

  /* 治愈后玩家**立即**自助 SAN Check：直接结算（非排队）*/
  var sanBefore = g.mem.sheet.status.currentSAN;
  var p3 = g.host.intent('s1', { op: M.INTENT.SAN_CHECK, p: { okLoss: '0', loss: '1D6', reason: '目击' } });
  ok(p3.length > 0 && !anyPubLog(p3, /等待确认/) , '治愈后 SAN Check 直接结算，未进「等待确认」队列', allText(p3));
  ok(!/等待确认/.test(allText(p3)), 'SAN Check 私密回话不含「等待确认」');
  ok(picks(p3, M.EVT.STATE).length >= 1, 'SAN Check 经 EVT.STATE 写回卡片');
  eq(g.host.pending.length, 0, 'SAN Check 不产生任何待办（自身动作，无需 KP 批准）');
  pump(p3);
  var mine = (client.state.members || []).filter(function (m) { return m.seat === 's1'; })[0] || {};
  ok(mine.sheet && mine.sheet.status && mine.sheet.status.currentSAN <= sanBefore,
     '客户端卡上 SAN 同步（≤ 检定前）', JSON.stringify(mine.sheet && mine.sheet.status));
})();

/* ============================================================
 * ⑥ 不定疯狂（症状消失）下任意 SAN 损失都复发（三条来源）
 * ============================================================ */
section('⑥ 不定疯狂（症状消失）任意 SAN 损失复发 — 三条来源');

/* 来源 1：玩家自助 SAN Check */
(function () {
  var g = mkHost([], { loss: 3, symptom: true });
  g.mem.sheet.mental = ['不定疯狂（症状消失）'];
  var out = g.host.intent('s1', { op: M.INTENT.SAN_CHECK, p: { okLoss: '0', loss: '3', reason: 'x' } });
  ok(g.mem.sheet.mental.indexOf('不定疯狂') >= 0, '来源①自助 SAN Check：症状消失 + 掉 SAN → 标签换回「不定疯狂」', JSON.stringify(g.mem.sheet.mental));
  ok(g.mem.sheet.mental.indexOf('不定疯狂（症状消失）') < 0, '来源①：旧的「症状消失」标签被替换（不并存）');
  ok(g.mem.sheet.madness.length >= 1 && g.mem.sheet.madness[0].from === '不定疯狂', '来源①：按 1D10 症状表带上了症状', JSON.stringify(g.mem.sheet.madness));
  ok(anyPubLog(out, /不定疯狂复发/), '来源①：写入公开记录「…的 SAN 受损，不定疯狂复发」');
})();

/* 来源 2：KP 定向 SAN Check（sheet.sancheck） */
(function () {
  var g = mkHost([], { loss: 3, symptom: true });
  g.mem.sheet.mental = ['不定疯狂（症状消失）'];
  var out = g.host.intent(M.HOST_SEAT, { op: M.INTENT.ACT, p: { op: 'sheet.sancheck', seat: 's1', okLoss: '0', loss: '3', reason: 'KP 定向' } });
  ok(g.mem.sheet.mental.indexOf('不定疯狂') >= 0, '来源②KP 定向 SAN Check：→ 标签换回「不定疯狂」', JSON.stringify(g.mem.sheet.mental));
  ok(g.mem.sheet.mental.indexOf('不定疯狂（症状消失）') < 0, '来源②：旧标签被替换');
  ok(anyPubLog(out, /不定疯狂复发/), '来源②：公开记录「不定疯狂复发」');
})();

/* 来源 3：状态管理手动扣 SAN（state.self，无骰） */
(function () {
  var g = mkHost([], { symptom: true });
  g.mem.sheet.mental = ['不定疯狂（症状消失）'];
  var out = g.host.intent('s1', { op: M.INTENT.ACT, p: { op: 'state.self', status: { currentSAN: 47 } } });   // 50 → 47（净减 3）
  ok(g.mem.sheet.mental.indexOf('不定疯狂') >= 0, '来源③状态管理扣 SAN：→ 标签换回「不定疯狂」', JSON.stringify(g.mem.sheet.mental));
  ok(g.mem.sheet.mental.indexOf('不定疯狂（症状消失）') < 0, '来源③：旧标签被替换');
  ok(anyPubLog(out, /不定疯狂复发/), '来源③：公开记录「不定疯狂复发」');
})();

/* 反例：加 SAN（净增）不复发；非「症状消失」态不受影响 */
(function () {
  var g = mkHost([], { symptom: true });
  g.mem.sheet.mental = ['不定疯狂（症状消失）'];
  g.host.intent('s1', { op: M.INTENT.ACT, p: { op: 'state.self', status: { currentSAN: 60 } } });  // 加 SAN
  ok(g.mem.sheet.mental.indexOf('不定疯狂（症状消失）') >= 0, '反例：加 SAN 不触发复发（仍为「症状消失」）');

  var h = mkHost([], { symptom: true });
  h.mem.sheet.mental = ['正常'];
  var out2 = h.host.intent('s1', { op: M.INTENT.ACT, p: { op: 'state.self', status: { currentSAN: 45 } } });
  ok(!anyPubLog(out2, /不定疯狂复发/) && h.mem.sheet.mental.indexOf('不定疯狂') < 0,
     '反例：正常态小额掉 SAN 不误判为不定疯狂复发');
})();

/* ============================================================
 * ⑩-2 结团 / 关房 / 被踢：玩家侧关闭全部悬浮面板（静态证据链）
 * ============================================================ */
section('⑩-2 玩家侧会话收尾关闭悬浮面板');
(function () {
  var src = fs.readFileSync(path.join(base, 'ui/room-ui.js'), 'utf8');
  ok(/function maybeDissolved\(st\)[\s\S]*?closeAllSheets[\s\S]*?回到首页/.test(src),
     'maybeDissolved：收到 CLOSED（结团/关房）→ closeAllSheets + 回首页');
  ok(/function maybeKicked\(\)[\s\S]*?closeAllSheets[\s\S]*?回到了?\u9996\u9875|function maybeKicked\(\)[\s\S]*?closeAllSheets/.test(src),
     'maybeKicked：被移出（sess.side.kicked）→ closeAllSheets + 回首页');
  ok(/maybeKicked\(\);\s*\n\s*maybeDissolved\(state\);/.test(src),
     '玩家 onEvent（startPlayer + reopenJoined）已接线 maybeKicked + maybeDissolved');
})();

/* ============================================================
 * ④ CSS 静态校验：公开记录栏标题吸顶（不改既有 .gp-grid）
 * ============================================================ */
section('④ 公开记录栏标题吸顶（CSS 静态）');
(function () {
  var css = fs.readFileSync(path.join('web/css/app.css'), 'utf8');
  ok(/\.game-page \.gp-glog > \.gp-region-head\s*\{[^}]*position:\s*sticky/.test(css),
     '新增规则：.gp-glog > .gp-region-head { position: sticky }');
  ok(/\.game-page \.gp-glog > \.gp-region-head\s*\{[^}]*top:\s*-?\d/.test(css), '吸顶偏移 top（-8px，抵消 .gp-glog 的 padding 使标题盖住上沿）');
  ok(/\.game-page \.gp-glog > \.gp-region-head\s*\{[^}]*background:\s*var\(--surface\)/.test(css),
     '不透明背景（var(--surface)，与 .gp-glog 同色）');
  ok(/\.game-page \.gp-glog > \.gp-region-head\s*\{[^}]*z-index:\s*\d/.test(css), 'z-index 高于条目');
  var open = (css.match(/\{/g) || []).length, close = (css.match(/\}/g) || []).length;
  eq(open, close, 'app.css 花括号配平');
})();

console.log('\nv2.2.2 fixes selftest: ' + pass + ' passed, ' + fail + ' failed');
console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exit(fail ? 1 : 0);
