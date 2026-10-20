/*
 * v2.11.0 增量修复独立回归（R1 / R2 / R3 模型逻辑）
 *
 *   R1 · 玩家视角「推进 1 轮」只推进疯狂倒计时（身体恢复仍由 KP 的 round.next 处理），
 *       故日志文案去掉「没有疯狂发作到期」—— 无事发生时只显示「X 推进 1 轮」。
 *   R2 · 昏迷 / 濒死 / 已撕卡 / 疯狂发作中 玩家：一切操作锁死，唯一例外是「推进 1 轮」
 *       （模型 intent 白名单放行 madness.advance）；状态管理（state.self）被拒。
 *   R3 · 玩家自助「🩺 急救 / 医疗 / 精神分析」走 KP 审批：
 *        · POLICY aid.apply / aid.psycho 玩家可发起、KP 确认；
 *        · psychoAnalyze 成功 → 治愈临时疯狂 + 不定疯狂（含症状消失）+ 清除本次发作的疯狂症状 + 回 1D3 SAN（不超 maxSAN）、记 5 回合冷却；
 *        · 角色卡自带背景/永久疯狂症（from 为空）保留，不误删角色设定（v2.11.1 扩展）；
 *        · psychoAnalyze 失败 → 目标失 1D6 SAN；已疯狂则只失 SAN、不新增加疯狂症；
 *        · 5 回合内同一目标再分析 → 拒绝（冷却）；
 *        · 急救 / 医学 回血经 applyHpChange 收口，绝不超 maxHP（用户审查确认）。
 *
 * 运行： node tools/test_v2110_fixes.js（工作目录 = 仓库根）
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
    failures.push(label + (extra === undefined ? '' : '　→ 实际: ' + JSON.stringify(extra)));
    console.log('  ✗ ' + label + (extra === undefined ? '' : '　→ 实际: ' + JSON.stringify(extra)));
  }
}
function eq(a, b, label) { ok(a === b, label, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
function section(t) { console.log('\n== ' + t + ' =='); }

/* 载入被测源码（同 test_room_model / test_v290_fixes） */
global.window = global;
eval(fs.readFileSync(path.join(ROOT, 'web/js/core/room-rules.js'), 'utf8'));
eval(fs.readFileSync(path.join(ROOT, 'web/js/core/room-model.js'), 'utf8'));

var M = global.RoomModel, R = M.ROLE, E = M.EVT;

/* ------------------------------------------------------------
 * 可控规则替身：skillValue 读角色卡；check 由 checkPass 决定；rollExpr 固定。
 * ------------------------------------------------------------ */
function mkRules(checkPass, d6, d3) {
  return {
    skillValue: function (sheet, name) {
      var skills = (sheet && sheet.skills) || [];
      for (var i = 0; i < skills.length; i++) if (skills[i].name === name) return skills[i].total;
      return null;
    },
    attrValue: function () { return null; },
    check: function (o) {
      return {
        ok: true, passed: checkPass, value: checkPass ? 30 : 95,
        levelText: checkPass ? '常规成功' : '常规失败',
        base: o.base, difficulty: o.difficulty, kind: o.kind, label: o.label
      };
    },
    rollExpr: function (expr, rng) {
      var total = (expr === '1D6') ? d6 : (expr === '1D3' ? d3 : 1);
      return { ok: true, total: total, expr: expr, rolls: [] };
    }
  };
}

function newHost(checkPass, d6, d3) {
  return new M.Host({
    meta: { code: 'v211', name: '测试团', kpName: 'KP', maxPlayers: 6 },
    rules: mkRules(checkPass, d6, d3),
    rng: function () { return 0.3; },
    now: function () { return 1000; }
  });
}
/** 在线玩家 + 角色卡（直接写 sheet，等价于真实绑定） */
function addPlayer(host, seat, nickname, sheet) {
  host.roster.open({ seat: seat, role: R.PLAYER, nickname: nickname });
  var mem = host.roster.get(seat);
  mem.charName = nickname;
  mem.sheet = sheet;
  return mem;
}
function baseSheet(over) {
  var s = {
    name: 'x', attrs: { pow: 50 },
    status: { currentHP: 10, maxHP: 12, currentSAN: 50, maxSAN: 80 },
    skills: [], madness: [], mental: ['正常']
  };
  for (var k in (over || {})) if (Object.prototype.hasOwnProperty.call(over, k)) s[k] = over[k];
  return s;
}
function publicLogTexts(out) {
  return (out || []).filter(function (r) {
    return r && r.to === '*' && r.msg && r.msg.t === E.LOG && r.msg.p && typeof r.msg.p.text === 'string';
  }).map(function (r) { return r.msg.p.text; });
}
function madnessSig(m) {
  return JSON.stringify(m.sheet.madness || []) + '|' + (m.sheet.mental || []).join(',');
}

/* ============================================================
 * 契约：POLICY（R3 入口存在 + 玩家可发起 / KP 确认）
 * ============================================================ */
section('契约 · POLICY aid.apply / aid.psycho');
(function () {
  ok(!!M.POLICY['aid.apply'], '★ POLICY 含 aid.apply');
  eq(M.POLICY['aid.apply'].confirm, 'kp', 'aid.apply 需 KP 确认');
  ok(M.allowed(R.PLAYER, 'aid.apply'), '★ 玩家可发起 aid.apply');

  ok(!!M.POLICY['aid.psycho'], '★ POLICY 含 aid.psycho（v2.11.0 新增）');
  eq(M.POLICY['aid.psycho'].confirm, 'kp', 'aid.psycho 需 KP 确认');
  ok(M.allowed(R.PLAYER, 'aid.psycho'), '★ 玩家可发起 aid.psycho');
})();

/* ============================================================
 * R1 · 推进 1 轮日志文案（去掉「没有疯狂发作到期」）
 * ============================================================ */
section('R1 · 推进 1 轮日志文案');
(function () {
  var host = newHost(true, 1, 1);
  addPlayer(host, 's-p', '玩家甲', baseSheet({
    madness: [{ from: '临时疯狂', name: '尖叫', rounds: 3 }],
    mental: ['临时疯狂']
  }));
  // 玩家自助推进 1 轮（白名单放行，无需 KP）
  var out = host.intent('s-p', M.intentMsg(M.INTENT.ACT, { op: 'madness.advance' }));
  var logs = publicLogTexts(out);
  ok(logs.length >= 1, '★ 推进 1 轮产出公开日志', logs);
  ok(logs.every(function (t) { return t.indexOf('没有疯狂发作到期') < 0; }),
     '★ 所有公开日志均不含「没有疯狂发作到期」', logs);
  ok(logs.indexOf('玩家甲 推进 1 轮') >= 0,
     '★ 无事发生时文案含「玩家甲 推进 1 轮」', logs);
})();

/* ============================================================
 * R2 · 昏迷玩家操作锁（模型 intent 白名单）
 * ============================================================ */
section('R2 · 昏迷玩家锁死（模型 intent）');
(function () {
  var host = newHost(true, 1, 1);
  addPlayer(host, 's-c', '昏迷者', baseSheet({
    status: { currentHP: 4, maxHP: 12, currentSAN: 50, maxSAN: 80, unconscious: true },
    mental: ['正常']
  }));
  var before = host.roster.get('s-c').sheet.status.currentHP;

  /* 状态管理（state.self）应被拒（精确匹配模型拒绝文案，避免误伤状态同步里的「昏迷」字样） */
  var outSelf = host.intent('s-c', M.intentMsg(M.INTENT.ACT, { op: 'state.self', status: { currentHP: 1 } }));
  var rejSelf = outSelf.some(function (r) {
    return r.to === 's-c' && r.msg && r.msg.p && /无法进行该操作|正处于昏迷|正处于濒死|只能「推进 1 轮」/.test(JSON.stringify(r.msg.p));
  });
  ok(rejSelf, '★ 昏迷玩家点「状态管理」被模型拒绝（提示昏迷/濒死）');
  eq(host.roster.get('s-c').sheet.status.currentHP, before, '★ 状态未被改动（锁生效）');

  /* 推进 1 轮（madness.advance）应放行 */
  var outAdv = host.intent('s-c', M.intentMsg(M.INTENT.ACT, { op: 'madness.advance' }));
  var rejAdv = outAdv.some(function (r) {
    return r.to === 's-c' && r.msg && r.msg.p && /无法进行该操作|正处于昏迷|正处于濒死|只能「推进 1 轮」/.test(JSON.stringify(r.msg.p));
  });
  ok(!rejAdv, '★ 昏迷玩家点「推进 1 轮」不被锁（白名单放行）');
  ok(publicLogTexts(outAdv).some(function (t) { return /推进 1 轮/.test(t); }),
     '★ 昏迷玩家成功推进 1 轮（产出公开日志）');
})();

/* ============================================================
 * R3 · psychoAnalyze 成功分支（治愈不定疯狂 + 回 1D3 SAN + 冷却）
 * ============================================================ */
section('R3 · 精神分析 成功（治愈不定疯狂 + 回 SAN + 冷却）');
(function () {
  var host = newHost(true, 1, 3); // checkPass=true；1D3=3
  host.state.meta.round = 0;
  if (!host.state.meta.psychoRound || typeof host.state.meta.psychoRound !== 'object') host.state.meta.psychoRound = {};
  addPlayer(host, 's-src', '医师', baseSheet({ skills: [{ name: '精神分析', total: 70 }] }));
  addPlayer(host, 's-tgt', '病友', baseSheet({
    status: { currentHP: 10, maxHP: 12, currentSAN: 50, maxSAN: 80 },
    madness: [{ from: '不定疯狂', name: '疑神疑鬼', rounds: 2 }],
    mental: ['不定疯狂']
  }));

  var out = host.applyAction('host', { op: 'aid.psycho', seat: 's-src', targetSeat: 's-tgt' });
  var tgt = host.roster.get('s-tgt');

  ok(tgt.sheet.mental.indexOf('不定疯狂') < 0, '★ 治愈后「不定疯狂」标签被摘掉', tgt.sheet.mental);
  ok(tgt.sheet.mental.indexOf('正常') >= 0, '★ 治愈后精神状态回退到「正常」', tgt.sheet.mental);
  eq(tgt.sheet.status.currentSAN, 53, '★ 回 1D3(=3) SAN：50 → 53', tgt.sheet.status.currentSAN);
  eq(host.state.meta.psychoRound['s-tgt'], 0, '★ 记录精神治疗冷却（psychoRound[s-tgt]=当前回合 0）');

  /* 5 回合内再分析 → 拒绝 */
  var out2 = host.applyAction('host', { op: 'aid.psycho', seat: 's-src', targetSeat: 's-tgt' });
  ok(out2.some(function (r) {
    return r.to === 'host' && r.msg && r.msg.p && /冷却/.test(JSON.stringify(r.msg.p));
  }), '★ 同一目标 5 回合内再分析被拒（冷却）');

  /* 跨过 5 回合后放行 */
  host.state.meta.round = 5;
  var out3 = host.applyAction('host', { op: 'aid.psycho', seat: 's-src', targetSeat: 's-tgt' });
  ok(!out3.some(function (r) {
    return r.to === 'host' && r.msg && r.msg.p && /冷却/.test(JSON.stringify(r.msg.p));
  }), '★ 跨过 5 回合后再次分析放行', publicLogTexts(out3));
  eq(host.state.meta.psychoRound['s-tgt'], 5, '★ 冷却记录刷新为第 5 回合');
})();

/* ============================================================
 * R3 · psychoAnalyze 失败分支（失 1D6 SAN；已疯狂只失 SAN 不新增疯狂）
 * ============================================================ */
section('R3 · 精神分析 失败（失 SAN；已疯狂不新增疯狂症）');
(function () {
  /* (a) 目标已处于疯狂 → 失败只失 SAN，_afterSanLoss 不调用（疯狂签名不变） */
  var hostA = newHost(false, 4, 1); // checkPass=false；1D6=4
  addPlayer(hostA, 's-src', '医师', baseSheet({ skills: [{ name: '精神分析', total: 70 }] }));
  addPlayer(hostA, 's-tgt', '已疯', baseSheet({
    status: { currentHP: 10, maxHP: 12, currentSAN: 50, maxSAN: 80 },
    madness: [{ from: '临时疯狂', name: '尖叫', rounds: 2 }],
    mental: ['临时疯狂']
  }));
  var sigBefore = madnessSig(hostA.roster.get('s-tgt'));
  hostA.applyAction('host', { op: 'aid.psycho', seat: 's-src', targetSeat: 's-tgt' });
  var tgtA = hostA.roster.get('s-tgt');
  eq(tgtA.sheet.status.currentSAN, 46, '★ 已疯目标失败失 1D6(=4) SAN：50 → 46', tgtA.sheet.status.currentSAN);
  eq(madnessSig(tgtA), sigBefore, '★ 已疯目标失败未新增加疯狂症（签名不变）', madnessSig(tgtA));

  /* (b) 目标未疯狂 → 失败失 SAN，_afterSanLoss 走正常规则路径（不报错） */
  var hostB = newHost(false, 2, 1); // 1D6=2
  addPlayer(hostB, 's-src', '医师', baseSheet({ skills: [{ name: '精神分析', total: 70 }] }));
  addPlayer(hostB, 's-tgt', '清醒', baseSheet({
    status: { currentHP: 10, maxHP: 12, currentSAN: 60, maxSAN: 80 },
    madness: [], mental: ['正常']
  }));
  hostB.applyAction('host', { op: 'aid.psycho', seat: 's-src', targetSeat: 's-tgt' });
  var tgtB = hostB.roster.get('s-tgt');
  eq(tgtB.sheet.status.currentSAN, 58, '★ 清醒目标失败失 1D6(=2) SAN：60 → 58', tgtB.sheet.status.currentSAN);
})();

/* ============================================================
 * R3 · 急救 / 医学 回血不超 maxHP（用户审查项）
 * ============================================================ */
section('R3 · 急救/医学 回血不超 maxHP');
(function () {
  /* 医学 +1D3(=3)，目标 currentHP=11/maxHP=12 → 应钳到 12（不溢出到 14） */
  var host = newHost(true, 1, 3);
  addPlayer(host, 's-src', '医师', baseSheet({ skills: [{ name: '医学', total: 80 }] }));
  addPlayer(host, 's-tgt', '伤患', baseSheet({
    status: { currentHP: 11, maxHP: 12, currentSAN: 50, maxSAN: 80 },
    madness: [], mental: ['正常']
  }));
  host.applyAction('host', { op: 'aid.apply', seat: 's-src', targetSeat: 's-tgt', skill: '医学' });
  eq(host.roster.get('s-tgt').sheet.status.currentHP, 12, '★ 医学回血被 maxHP 钳制：11 + 1D3(=3) → 12（不超上限）',
     host.roster.get('s-tgt').sheet.status.currentHP);

  /* 急救 +1，目标 currentHP=12/maxHP=12 → 维持 12（不溢出） */
  var host2 = newHost(true, 1, 1);
  addPlayer(host2, 's-src', '医师', baseSheet({ skills: [{ name: '急救', total: 80 }] }));
  addPlayer(host2, 's-tgt', '满血', baseSheet({
    status: { currentHP: 12, maxHP: 12, currentSAN: 50, maxSAN: 80 },
    madness: [], mental: ['正常']
  }));
  host2.applyAction('host', { op: 'aid.apply', seat: 's-src', targetSeat: 's-tgt', skill: '急救' });
  eq(host2.roster.get('s-tgt').sheet.status.currentHP, 12, '★ 急救回血不超 maxHP：满血维持 12',
     host2.roster.get('s-tgt').sheet.status.currentHP);
})();

/* ============================================================
 * R3 · v2.11.1 扩展治愈（临时疯狂 + 本次发作症状 + 背景保留 + 无发作路径）
 * ============================================================ */
section('R3 · v2.11.1 扩展治愈（临时疯狂 + 发作症状 + 背景保留）');
(function () {
  /* (a) 临时疯狂 + 本次发作症状(from='临时疯狂') + 背景症状(permanent,from='') */
  var host = newHost(true, 1, 2); // checkPass=true；1D3=2（SAN 50→52）
  host.state.meta.round = 0;
  host.state.meta.psychoRound = {};
  addPlayer(host, 's-src', '医师', baseSheet({ skills: [{ name: '精神分析', total: 70 }] }));
  addPlayer(host, 's-tgt', '病友', baseSheet({
    status: { currentHP: 10, maxHP: 12, currentSAN: 50, maxSAN: 80 },
    madness: [
      { from: '临时疯狂', name: '尖叫', rounds: 2, permanent: false },
      { from: '', name: '幽闭恐惧', permanent: true }
    ],
    mental: ['临时疯狂', '疯狂症状']
  }));
  host.applyAction('host', { op: 'aid.psycho', seat: 's-src', targetSeat: 's-tgt' });
  var tgt = host.roster.get('s-tgt');
  ok(tgt.sheet.mental.indexOf('临时疯狂') < 0, '★ 治愈后「临时疯狂」标签被摘掉', tgt.sheet.mental);
  eq(tgt.sheet.madness.length, 1, '★ 只清除本次发作症状，背景症状保留（剩 1 条）', tgt.sheet.madness);
  eq(tgt.sheet.madness[0].name, '幽闭恐惧', '★ 背景症状「幽闭恐惧」仍在', tgt.sheet.madness);
  ok(tgt.sheet.mental.indexOf('疯狂症状') >= 0, '★ 背景症状在 → 仍保留「疯狂症状」标签', tgt.sheet.mental);
  eq(tgt.sheet.status.currentSAN, 52, '★ 回 1D3(=2) SAN：50 → 52', tgt.sheet.status.currentSAN);

  /* (b) 仅不定疯狂标签（无发作症状条目）→ 标签治愈、不误删 */
  var host2 = newHost(true, 1, 1);
  host2.state.meta.round = 0; host2.state.meta.psychoRound = {};
  addPlayer(host2, 's-src', '医师', baseSheet({ skills: [{ name: '精神分析', total: 70 }] }));
  addPlayer(host2, 's-tgt', '病友2', baseSheet({
    status: { currentHP: 10, maxHP: 12, currentSAN: 40, maxSAN: 80 },
    madness: [], mental: ['不定疯狂']
  }));
  host2.applyAction('host', { op: 'aid.psycho', seat: 's-src', targetSeat: 's-tgt' });
  var tgt2 = host2.roster.get('s-tgt');
  ok(tgt2.sheet.mental.indexOf('不定疯狂') < 0 && tgt2.sheet.mental.indexOf('正常') >= 0,
     '★ 仅「不定疯狂」标签被治愈', tgt2.sheet.mental);

  /* (c) 无任何可治愈发作（正常目标）→ 私密提示「未产生治愈效果」，仍回 SAN */
  var host3 = newHost(true, 1, 1);
  host3.state.meta.round = 0; host3.state.meta.psychoRound = {};
  addPlayer(host3, 's-src', '医师', baseSheet({ skills: [{ name: '精神分析', total: 70 }] }));
  addPlayer(host3, 's-tgt', '正常人', baseSheet({
    status: { currentHP: 10, maxHP: 12, currentSAN: 60, maxSAN: 80 },
    madness: [], mental: ['正常']
  }));
  var out3 = host3.applyAction('host', { op: 'aid.psycho', seat: 's-src', targetSeat: 's-tgt' });
  var tgt3 = host3.roster.get('s-tgt');
  eq(tgt3.sheet.status.currentSAN, 61, '★ 无发作可治愈仍回 1D3(=1) SAN：60 → 61', tgt3.sheet.status.currentSAN);
  ok(out3.some(function (r) {
    return r.to === 'host' && r.msg && r.msg.p && /未产生治愈效果/.test(JSON.stringify(r.msg.p));
  }), '★ 无发作可治愈时私密提示「未产生治愈效果」');
})();

/* ============================================================
 * 汇总
 * ============================================================ */
process.on('exit', function () {
  console.log('\n' + '='.repeat(60));
  if (fail) {
    console.log('失败 ' + fail + ' 项：');
    failures.forEach(function (f) { console.log('  ✗ ' + f); });
    console.log('v2.11.0 fixes selftest: ' + pass + ' passed, ' + fail + ' failed');
    console.log('RESULT: FAIL');
  } else {
    console.log('v2.11.0 fixes selftest: ' + pass + ' passed, ' + fail + ' failed');
    console.log('RESULT: PASS');
  }
  process.exitCode = fail ? 1 : 0;
});
