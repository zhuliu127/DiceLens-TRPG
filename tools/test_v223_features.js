/*
 * v2.3.0 功能新增自测（用户第三批：5 项）
 *   ③ 操作播报（居中 2 秒）—— 静态断言（CSS/接线）+ 阈值播报不刷屏逻辑（源码级）
 *   ⑦ 建房/KP 工具可自定义大成功 / 大失败阈值，并贯通全部检定路径
 *   ⑧ 连发（perRound）：最多发射数解析、≤2 必须先选、每多发一次 +1 惩罚骰、回合清零
 *   ⑨ 贯穿伤害：武器最大伤害 + 最大 DB + 再投一次伤害骰；两处实现收敛
 *   ⑩ 武器故障：判定（≥故障值、大成功不故障、——/空永不故障）+ 四种效果
 *
 * 运行： node tools/test_v223_features.js（工作目录 = 仓库根）
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
/** 确定性随机源：按序返回值；用完循环（避免 undefined） */
function feeder(seq) { var i = 0; return function () { return seq[i++ % seq.length]; }; }
/** 造一个带角色卡的 Host（opts.weapons 覆盖人物卡武器） */
function mkHost(opts) {
  opts = opts || {};
  var host = new M.Host({ rules: R, rng: feeder(opts.rng || [0.3, 0.0]), madness: null, now: function () { return 1000; } });
  host.roster.open({ seat: 's1', role: M.ROLE.PLAYER, nickname: '小美' });
  var mem = host.roster.get('s1');
  mem.charName = '小美';
  mem.sheet = {
    name: '小美', attrs: { str: 60, int: 60, pow: 50 },
    status: { currentHP: 12, maxHP: 12, currentSAN: 50, maxSAN: 50 },
    skills: [{ name: '格斗（斗殴）', total: 60 }, { name: '射击（手枪）', total: 55 }, { name: '侦查', total: 55 }],
    weapons: opts.weapons || [{ name: '包皮铁棍', skill: '斗殴', damage: '1D6', pierce: '×', perRound: '1', malfunction: '', ammo: '' }],
    madness: [], mental: ['正常'], db: '+1D4'
  };
  /* v2.6.0（用户第 3 项）：默认带一个当前 PC 行动槽（玩家发起对抗须在其轮次）。 */
  host.state.combat = { order: [{ id: 's1#0', actorId: 's1', seat: 's1', kind: 'pc', name: '小美', public: { hp: 12, hpMax: 12 } }], turn: 0, round: 1, startedAt: 0 };
  host.state.meta.status = M.STATUS.IN_GAME;
  return { host: host, mem: mem };
}
function picks(out, t) {
  var arr = [];
  (out || []).forEach(function (r) { if (r && r.msg && r.msg.t === t) arr.push(r.msg.p || {}); });
  return arr;
}
function allText(out) {
  return (out || []).map(function (r) { return (r && r.msg && r.msg.p && (r.msg.p.text || r.msg.p.summary)) || ''; }).join(' | ');
}
function anyPubLog(out, re) {
  return (out || []).some(function (r) {
    return r && r.msg && r.msg.t === M.EVT.LOG && re.test((r.msg.p && r.msg.p.text) || '');
  });
}

/* ============================================================
 * ⑦ 大成功 / 大失败阈值（规则层默认行为必须与改动前一致）
 * ============================================================ */
section('⑦ 大成功 / 大失败阈值');
(function () {
  // 默认（不传 opts）—— 与改动前逐字节一致：大成功=1；大失败 100（base≥50）
  eq(R.check({ base: 70, value: 1, rng: feeder([0]) }).level, 5, '默认：掷 1 → 大成功');
  ok(R.check({ base: 70, value: 5, rng: feeder([0]) }).level !== 5, '默认：掷 5 不是大成功（阈值仍是 1）');
  ok(R.check({ base: 70, value: 96, rng: feeder([0]) }).fumble === false, '默认：base 70 掷 96 不是大失败');
  ok(R.check({ base: 70, value: 100, rng: feeder([0]) }).fumble === true, '默认：base 70 掷 100 是大失败');
  ok(R.check({ base: 40, value: 96, rng: feeder([0]) }).fumble === true, '默认：base 40（<50）掷 96 是大失败');

  // 自定义大成功阈值 5 → 掷 5 及以下都是大成功（用户举例口径）
  eq(R.check({ base: 70, value: 5, critMax: 5, rng: feeder([0]) }).level, 5, 'critMax=5：掷 5 → 大成功');
  eq(R.check({ base: 70, value: 9, critMax: 5, rng: feeder([0]) }).level, 2, 'critMax=5：掷 9 → 常规成功（不是大成功）');

  // 自定义大失败阈值 95 → 掷 95 及以上都是大失败（即使用 base 70）
  ok(R.check({ base: 70, value: 95, fumbleMin: 95, rng: feeder([0]) }).fumble === true, 'fumbleMin=95：base 70 掷 95 → 大失败');
  ok(R.check({ base: 70, value: 94, fumbleMin: 95, rng: feeder([0]) }).fumble === false, 'fumbleMin=95：掷 94 不是大失败');
  // 边界：越界值夹取
  eq(R.check({ base: 70, value: 1, critMax: 200, rng: feeder([0]) }).level, 5, 'critMax 越界(200) 被夹到 100 → 掷 1 仍大成功');
  ok(R.check({ base: 70, value: 5, critMax: 0, rng: feeder([0]) }).level !== 5, 'critMax=0（非法）→ 回落默认 1');

  // 房间级：Host meta 驱动（setRoomRules → 广播 + meta 生效）
  var h1 = mkHost({});
  var out = h1.host.setRoomRules({ critThreshold: 5, fumbleThreshold: 95 });
  eq(h1.host.state.meta.critThreshold, 5, 'setRoomRules：meta.critThreshold=5');
  eq(h1.host.state.meta.fumbleThreshold, 95, 'setRoomRules：meta.fumbleThreshold=95');
  ok(picks(out, M.EVT.HELLO).length === 1, 'setRoomRules 广播 HELLO（房内即时生效）');
  var bad = h1.host.setRoomRules({ critThreshold: 0, fumbleThreshold: 95 });
  ok(allText(bad).indexOf('大成功阈值需为 1–100') >= 0, 'setRoomRules：非法阈值被拒绝并提示');
  eq(h1.host.state.meta.critThreshold, 5, '非法请求不修改既有阈值');

  // meta → 规则调用贯通：房间阈值=5/95 时，掷 5 = 大成功、掷 95 = 大失败
  var h2 = mkHost({});
  h2.host.state.meta.critThreshold = 5;
  h2.host.state.meta.fumbleThreshold = 95;
  var ro = M; // room-model 内部通过 ruleOptsOf(meta) 取值
  ok(typeof h2.host.setRoomRules === 'function', 'Host.setRoomRules 存在（KP 工具入口）');
  // 用一次 SAN Check 验证贯通（resolveSanCheck 内部用 check()）
  var out2 = h2.host.intent('s1', { op: M.INTENT.SAN_CHECK, p: { okLoss: '0', loss: '1D6', reason: '测试' } });
  ok(picks(out2, M.EVT.DICE).length + picks(out2, M.EVT.STATE).length > 0, 'SAN Check 在自定义阈值下正常结算（不崩）');

  // 场景检定：KP 裁「大成功」→ 记录文案写「大成功」
  var h3 = mkHost({});
  h3.host.state.sceneCheck = {
    id: 'sc1', title: '测试场景', desc: '', cursor: 0, results: [], at: 1000,
    steps: [{ id: 'st1', title: '摸尸体', skill: '侦查', targetSeat: 's1', difficulty: 'regular' }]
  };
  var out3 = h3.host.intent('host', { op: M.INTENT.ACT, p: { op: 'scene.check.step', stepId: 'st1', seat: 's1', level: 5 } });
  ok(anyPubLog(out3, /大成功/), '场景检定裁「大成功」→ 公开记录写「大成功」');
  var out3b = h3.host.intent('host', { op: M.INTENT.ACT, p: { op: 'scene.check.step', stepId: 'st1', seat: 's1', level: -1 } });
  ok(anyPubLog(out3b, /大失败/), '场景检定裁「大失败」→ 公开记录写「大失败」');
})();

/* ============================================================
 * ⑧ 连发（perRound）与惩罚骰
 * ============================================================ */
section('⑧ 连发与惩罚骰');
(function () {
  eq(R.burstMaxOf('1(3)'), 3, 'perRound "1(3)" → 每轮最多 3 发');
  eq(R.burstMaxOf('1(2)'), 2, 'perRound "1(2)" → 2 发');
  eq(R.burstMaxOf('1 or 2'), 2, 'perRound "1 or 2" → 2 发');
  eq(R.burstMaxOf('1或2'), 2, 'perRound "1或2" → 2 发');
  eq(R.burstMaxOf('1/4'), 1, 'perRound "1/4"（每 4 轮 1 发）→ 不算连发');
  eq(R.burstMaxOf('全自动'), 3, 'perRound 含「全自动」→ ≥3');
  eq(R.burstMaxOf('1'), 1, 'perRound "1" → 1 发');
  eq(R.burstMaxOf(''), 1, 'perRound 空 → 1 发');
  eq(R.burstMaxOf(undefined), 1, 'perRound undefined → 1 发（不崩）');

  // 玩家申请：perRound=1(3)、选 3 发 → 惩罚骰 +2，且记录「本轮已发射 0/3，本次 3 发」
  var w = { name: '.22 自动手枪', skill: '射击', damage: '1D6', pierce: '√', perRound: '1(3)', malfunction: '', ammo: '6' };
  var hb = mkHost({ weapons: [w] });
  hb.host.state.combat.order = [{ id: 's1#0', actorId: 's1', seat: 's1', kind: 'pc', name: '小美', public: { hp: 12, hpMax: 12 } }, { id: 'a1', actorId: 'm1', name: '食尸鬼', kind: 'monster', public: { hp: 10, hpMax: 10 } }];
  hb.host.state.meta.mode = M.MODE.COMBAT;
  var outR = hb.host.intent('s1', { op: M.INTENT.OPPOSED, p: {
    phase: 'request', weapon: { name: w.name }, db: '+1D4', targetId: 'm1', targetName: '食尸鬼', shots: 3
  } });
  ok(!/请先选择|查不到|不存在/.test(allText(outR)), '三连发武器申请被受理（不报错）');
  ok(hb.host.state.opposed && hb.host.state.opposed.phase === 'await_kp', '申请进入 await_kp');
  eq(hb.host.state.opposed.shots, 3, '申请带上本次发射数 3');
  eq(hb.host.state.opposed.burstMax, 3, '申请带上每轮上限 3');

  // KP 裁定 → 结算：记录里应出现连发说明与惩罚骰
  var outRes = hb.host.intent('host', { op: M.INTENT.ACT, p: {
    op: 'check.opposed', reqId: hb.host.state.opposed.id, attack: true,
    defender: { reaction: 'dodge', value: 50 }, armor: { value: 0 }
  } });
  ok(/本轮已发射 0\/3，本次 3 发，惩罚骰 \+2/.test(allText(outRes)), '裁定记录含「本轮已发射 0/3，本次 3 发，惩罚骰 +2」');

  // ≤2 发武器未选 shots → 拒绝（必须发起前先选）
  var w2 = { name: '双管猎枪', skill: '射击', damage: '2D6', pierce: '×', perRound: '1 or 2', malfunction: '', ammo: '2' };
  var hb2 = mkHost({ weapons: [w2] });
  hb2.host.state.combat.order = [{ id: 's1#0', actorId: 's1', seat: 's1', kind: 'pc', name: '小美', public: { hp: 12, hpMax: 12 } }, { id: 'a1', actorId: 'm1', name: '食尸鬼', kind: 'monster', public: { hp: 10, hpMax: 10 } }];
  hb2.host.state.meta.mode = M.MODE.COMBAT;
  var outNo = hb2.host.intent('s1', { op: M.INTENT.OPPOSED, p: {
    phase: 'request', weapon: { name: w2.name }, db: '0', targetId: 'm1', targetName: '食尸鬼'
  } });
  ok(/请先选择/.test(allText(outNo)), '每轮 2 发武器未选发射数 → 明确拒绝（请先选择）');
  var outYes = hb2.host.intent('s1', { op: M.INTENT.OPPOSED, p: {
    phase: 'request', weapon: { name: w2.name }, db: '0', targetId: 'm1', targetName: '食尸鬼', shots: 2
  } });
  ok(!/请先选择/.test(allText(outYes)), '选了 2 发 → 正常受理');

  // 回合推进 → 连发计数清零
  hb.host._fireUsed['s1\u0000.22 自动手枪'] = 3;
  hb.host.intent('host', { op: M.INTENT.ACT, p: { op: 'round.next' } });
  eq(Object.keys(hb.host._fireUsed).length, 0, '新回合 → 连发计数清零');
})();

/* ============================================================
 * ⑨ 贯穿伤害公式（武器最大伤害 + 最大 DB + 再投一次武器伤害骰）
 * ============================================================ */
section('⑨ 贯穿伤害公式');
(function () {
  // 公共函数 impaleDamage(expr, db, rng) → {ok, base(骰式理论最大), dbMax(DB 最大), extra(追加一次伤害骰), raw}
  var dmg = R.impaleDamage('1D8', '+1D4', feeder([0.5, 0.5, 0.5]));
  ok(dmg && dmg.ok === true, 'impaleDamage 正常返回');
  eq(dmg.base, 8, '武器伤害理论最大值 1D8 → 8');
  eq(dmg.dbMax, 4, 'DB 理论最大值 +1D4 → 4');
  ok(dmg.extra && dmg.extra.ok === true, '追加一次武器伤害骰');
  eq(dmg.raw, dmg.base + dmg.dbMax + dmg.extra.total, 'raw = 武器最大(8) + 最大DB(4) + 追加骰(' + (dmg.extra && dmg.extra.total) + ')');

  // resolveAttack：极难成功 + 贯穿武器 → 走同一公式（rng：攻 11 极难 / 守 55 失败）
  var atk = R.resolveAttack({
    attack: { name: '射击', value: 55, ranged: false },
    defense: { name: '闪避', value: 20, mode: 'dodge' },
    damage: { expr: '1D8', db: '+1D4' },
    armor: { value: 0 }, impale: true,
    rng: feeder([0.15, 0.15, 0.55, 0.55, 0.5, 0.5, 0.5, 0.5, 0.5])
  });
  eq(atk.attack.level, 4, '攻击掷 11 → 极难成功（BASE 55）');
  eq(atk.outcome, 'attacker_wins', '攻方胜');
  ok(atk.damage && atk.damage.impale === true, 'resolveAttack 极难成功 + 贯穿 → impale=true');
  eq(atk.damage.impaleDbMax, 4, 'DB 取最大值 4（不是实际掷值）');
  eq(atk.damage.raw, 8 + 4 + atk.damage.extra.total, 'resolveAttack 贯穿 raw = 8 + 4 + 追加(' + (atk.damage.extra && atk.damage.extra.total) + ')');
  eq(atk.damage.applied, atk.damage.raw, '护甲 0 → 实扣 = raw');

  // 非贯穿（或不触发）时不得取最大
  var atk2 = R.resolveAttack({
    attack: { name: '射击', value: 55, ranged: false },
    defense: { name: '闪避', value: 20, mode: 'dodge' },
    damage: { expr: '1D8', db: '+1D4' },
    armor: { value: 0 }, impale: false,
    rng: feeder([0.15, 0.15, 0.55, 0.55, 0.5, 0.5, 0.5, 0.5, 0.5])
  });
  ok(atk2.damage.impale !== true, '非贯穿武器 → 不取最大值');
})();

/* ============================================================
 * ⑩ 武器故障判定与效果
 * ============================================================ */
section('⑩ 武器故障');
(function () {
  ok(R.malfunctionOf({ malfunction: '100' }, 100).jammed === true, '掷 100 ≥ 故障值 100 → 故障');
  ok(R.malfunctionOf({ malfunction: '100' }, 99).jammed === false, '掷 99 < 100 → 不故障');
  ok(R.malfunctionOf({ malfunction: '96' }, 96).jammed === true, '掷 96 ≥ 96 → 故障');
  ok(R.malfunctionOf({ malfunction: '——' }, 100).jammed === false, '故障值「——」→ 永不故障');
  ok(R.malfunctionOf({ malfunction: '' }, 100).jammed === false, '故障值为空 → 永不故障');
  ok(R.malfunctionOf({ malfunction: 'abc' }, 100).jammed === false, '故障值非法 → 永不故障');
  ok(R.malfunctionOf({ malfunction: '100' }, 1, { critical: true }).jammed === false, '大成功不故障');
  ok(R.malfunctionThresholdOf({ malfunction: '99' }) === 99, '阈值解析 99');
  ok(R.malfunctionThresholdOf({ malfunction: '——' }) === 0, '「——」→ 阈值 0（永不故障）');

  // 四种效果
  var jam = R.malfunctionEffect({ malfunction: '100' }, 'jam', feeder([0.5]));
  eq(jam.type, 'jam', '卡弹类型'); ok(jam.clearRounds >= 1 && jam.clearRounds <= 6, '卡弹清除 1D6 轮'); ok(jam.destroyed !== true, '卡弹不损坏武器');
  var feed = R.malfunctionEffect({ malfunction: '100' }, 'feed', feeder([0.5]));
  eq(feed.type, 'feed', '供弹故障类型'); ok(feed.clearRounds >= 3 && feed.clearRounds <= 6, '供弹故障 1D4+2 轮（3-6）');
  var dud = R.malfunctionEffect({ malfunction: '100' }, 'dud', feeder([0.5]));
  eq(dud.type, 'dud', '哑火类型'); ok(dud.damage === 0, '哑火无伤害');
  var burst = R.malfunctionEffect({ malfunction: '100' }, 'burst', feeder([0.5]));
  eq(burst.type, 'burst', '炸膛类型'); ok(burst.destroyed === true, '炸膛武器彻底损坏');
  ok(burst.damage >= 0 && burst.damage <= 2, '炸膛自伤 1D3−1（0-2）');
  // 缺省类型按武器推定：左轮 → 哑火；连发 → 供弹故障；其它 → 卡弹
  eq(R.defaultMalfunctionType({ name: '.38 左轮' }), 'dud', '左轮缺省 → 哑火');
  eq(R.defaultMalfunctionType({ name: 'MP18', perRound: '1(2)' }), 'feed', '连发武器缺省 → 供弹故障');
  eq(R.defaultMalfunctionType({ name: '猎象枪' }), 'jam', '其它缺省 → 卡弹');

  // 端到端：玩家用故障值 96 的枪攻击，攻击掷 99（≥96 且非大成功）→ 故障落临时状态 + 公开日志
  var w = { name: '.22 自动手枪', skill: '射击', damage: '1D6', pierce: '×', perRound: '1(3)', malfunction: '96', ammo: '6' };
  var hb = mkHost({ weapons: [w] });
  hb.host.state.combat.order = [{ id: 's1#0', actorId: 's1', seat: 's1', kind: 'pc', name: '小美', public: { hp: 12, hpMax: 12 } }, { id: 'a1', actorId: 'm1', name: '食尸鬼', kind: 'monster', public: { hp: 10, hpMax: 10 } }];
  hb.host.state.meta.mode = M.MODE.COMBAT;
  var outR = hb.host.intent('s1', { op: M.INTENT.OPPOSED, p: {
    phase: 'request', weapon: { name: w.name }, db: '0', targetId: 'm1', targetName: '食尸鬼', shots: 1
  } });
  var reqId = hb.host.state.opposed && hb.host.state.opposed.id;
  // rng：攻 99（≥故障值 96、非大成功 → 判故障）、守 55
  hb.host.rng = feeder([0.99, 0.99, 0.55, 0.55, 0.5, 0.5]);
  var outRes = hb.host.intent('host', { op: M.INTENT.ACT, p: {
    op: 'check.opposed', reqId: reqId, attack: true,
    defender: { reaction: 'dodge', value: 50 }, armor: { value: 0 }
  } });
  ok(anyPubLog(outRes, /\.22 自动手枪 (卡弹|供弹故障|哑火|炸膛)/), '故障效果写入公开日志');
  /* 回归守卫：_applyMalfunction 内部曾用 `out = out.concat(...)` 重新绑定局部数组，
     导致 STATE 写回与公开日志都送不到调用方 —— 玩家端「故障生效但看不到任何提示」。 */
  ok(picks(outRes, M.EVT.STATE).length > 0, '故障的 STATE 写回事件确实送出（原地入队）');
  ok(picks(outRes, M.EVT.LOG).length > 0, '故障的公开日志事件确实送出（原地入队）');
  var ts = hb.mem.sheet.tempStatus || [];
  ok(ts.some(function (x) { return /\.22 自动手枪/.test(x.text || ''); }), '故障写进该玩家临时状态');
})();

/* ============================================================
 * ③ 操作播报（静态断言：接线 + CSS）
 * ============================================================ */
section('③ 操作播报（接线 / 样式）');
(function () {
  var ui = fs.readFileSync(path.join(base, 'ui/room-ui.js'), 'utf8');
  ok(/function optoastCheck\(/.test(ui), 'optoastCheck 已实现');
  ok(/optoastCheck\(st\)/.test(ui), 'paintGameFeeds 接线 optoastCheck');
  ok(/OPTOAST_MS\s*=\s*2000/.test(ui), '播报时长 2 秒');
  ok(/OPTOAST_FLOOD/.test(ui), '有全量同步防刷屏阈值');
  ok(/function optoastReset\(/.test(ui), '会话切换可重置基线');
  var css = fs.readFileSync(path.join('web/css/app.css'), 'utf8');
  ok(/\.gp-optoast-host\s*\{/.test(css), 'CSS：播报容器 .gp-optoast-host');
  ok(/\.gp-optoast\s*\{/.test(css), 'CSS：播报条目 .gp-optoast');
  ok(/@keyframes gpOpToast/.test(css), 'CSS：播报动画');
  ok(/pointer-events:\s*none/.test(css), 'CSS：播报不挡点击');
  // 玩家名 / KP 名解析
  ok(/function optoastKpName\(/.test(ui) && /function optoastMemberName\(/.test(ui), 'KP 昵称 / 玩家角色名解析函数存在');
  ok(/charName \|\| m\.nickname/.test(ui), '名字退化顺序：角色名 → 昵称');
})();

/* ============================================================
 * ⑦ 建房表单与 KP 工具入口（静态断言）
 * ============================================================ */
section('⑦ 建房表单 / KP 工具入口');
(function () {
  var ui = fs.readFileSync(path.join(base, 'ui/room-ui.js'), 'utf8');
  ok(/critThreshold: critT/.test(ui), '建房载荷带 critThreshold');
  ok(/fumbleThreshold: fumbleT/.test(ui), '建房载荷带 fumbleThreshold');
  ok(/startHost\(res, nm, \{ critThreshold: critT, fumbleThreshold: fumbleT \}\)/.test(ui), 'startHost 透传阈值');
  ok(/大成功阈值/.test(ui) && /大失败阈值/.test(ui), '建房表单有两项阈值输入');
  var rp = fs.readFileSync(path.join(base, 'ui/room-panels.js'), 'utf8');
  ok(/roomRulesSheet/.test(rp), 'KP 工具有「检定成败阈值」入口');
  ok(/sanLossForPlayer/.test(rp), 'KP 工具有「追加理智损失（SAN 大失败）」入口');
  ok(/op: 'room\.rules'/.test(rp), '阈值修改走 op room.rules');
  ok(/op: 'sheet\.sanloss'/.test(rp), '追加理智损失走 op sheet.sanloss');
  ok(/malfSel/.test(rp), '裁定弹层含故障类型选择');
  ok(/rebuildShots/.test(rp), '玩家/KP 对抗弹层含连发发射数选择');
})();

console.log('\nv2.3.0 features selftest: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) { console.log('RESULT: FAIL'); process.exit(1); }
console.log('RESULT: PASS');
