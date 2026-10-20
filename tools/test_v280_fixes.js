/*
 * v2.8.0 独立回归 —— 本文件由多名工程师按小节 append 汇总。
 *
 *   本小节由 software-engineer-2（寇豆码）负责：**UI 层（第 1 / 2 / 3 / 4 / 5 / 6 项）**
 *     · 第 1 项 玩家状态管理：当前处于「重伤 / 濒死 / 昏迷」时，与之互斥的身体状态选项
 *         （正常 / 轻伤 / 重伤 / 濒死 / 昏迷）一律置灰不可点（disabled + 拦截 onclick），
 *         仅保留「死亡」（独立撕卡动作）。
 *     · 第 2 项 玩家自助「🩹 治愈伤势（需 KP 同意）」→ ctx.intent(ACT, {op:'sheet.healwound'})
 *         （昏迷时也可点 —— 昏迷玩家的唯一自救出口）。
 *     · 第 3 项 KP 工具箱「🩹 治愈伤势」→ ctx.act({op:'sheet.healwound', seat})，
 *         选人器复用 pickTargetPlayer + targetBlocked（已撕卡不可选）。
 *     · 第 4 项 KP 工具箱「🚑 急救 / 医学」→ ctx.act({op:'aid.apply',
 *         seat, targetSeat, skill:'急救'|'医学'})（表单内两个下拉：施救者 / 目标 + 技能）。
 *     · 第 5 项 KP 视角玩家信息栏补「当前 SAN / 最大 SAN」数值显示。
 *     · 第 6 项 昏迷角色前端同款前置提示（与「疯狂发作中」并列）。
 *
 *   ⚠️ 另一位工程师（模型层）会在本文件**末尾 append** 自己的小节；
 *     为避免「汇总早于追加的断言执行」，本文件的汇总 / RESULT 走 process.on('exit')，
 *     任何后追加的代码都会先跑完再汇总。
 *
 * 运行： node tools/test_v280_fixes.js（工作目录 = 仓库根）
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

/* ============================================================
 * UI 小节 · software-engineer-2（寇豆码）—— 第 1 / 2 / 3 / 4 / 5 / 6 项（静态证据链）
 * ============================================================ */
section('UI-第 1 项 · 玩家状态管理：重伤/濒死/昏迷 时身体选项置灰不可点');
(function () {
  var ss = segOf('selfStateSheet');
  ok(ss.length > 0, '定位到 selfStateSheet');
  ok(/BODY_OPTS = \['正常', '轻伤', '重伤', '濒死', '昏迷', '死亡'\]/.test(ss),
     'BODY_OPTS 六态保持');
  ok(/WOUND_BODY = \['重伤', '濒死', '昏迷'\]/.test(rpClean),
     '模块级 WOUND_BODY = 重伤/濒死/昏迷');
  ok(/var curBodyLocked = WOUND_BODY\.indexOf\(bodyVal0\) >= 0;/.test(ss),
     '当前态属于受重伤组 → curBodyLocked');
  ok(/var locked = curBodyLocked && \(o !== '死亡'\)/.test(ss),
     '★ 禁用矩阵：curBodyLocked 时，除「死亡」外的全部身体选项（正常/轻伤/重伤/濒死/昏迷）均 locked');
  // v2.10.0（R2a）：身体状态改「复选 chips」形态后，置灰**刻意不用原生 disabled**
  //   （置灰项点击要弹引导 toast，见 room-panels.js 内联注释）—— 改判 .dim 类 + 内联样式。
  ok(/button\.chip' \+ \(bodyChecked\(o\) \? '\.on' : ''\) \+ \(locked \? '\.dim' : ''\)/.test(ss),
     '★（R2a）chips 勾选/置灰形态：.chip +（勾选）.on +（置灰）.dim');
  ok(/style: locked \? \{ opacity: '0\.45', cursor: 'not-allowed', filter: 'grayscale\(\.35\)' \} : null/.test(ss),
     '★（R2a）置灰走内联样式（刻意不用原生 disabled —— 保留点击弹引导 toast）');
  ok(/if \(locked\) \{[\s\S]*?return;/.test(ss), 'onclick 内亦有 locked 兜底拦截（双保险）');
  ok(/当前处于「' \+ bodyVal0 \+ '」：需 KP 治愈或队友施救/.test(ss),
     '给出说明文案（当前处于「X」，需 KP 治愈或队友施救）');
})();

section('UI-第 2 项 · 玩家自助「🩹 治愈伤势（需 KP 同意）」');
(function () {
  var ss = segOf('selfStateSheet');
  var iMad = ss.indexOf("text: '💊 治愈不定疯狂（需 KP 同意）'");
  var iWnd = ss.indexOf("text: '🩹 治愈伤势（需 KP 同意）'");
  ok(iWnd > 0, '玩家端存在按钮「🩹 治愈伤势（需 KP 同意）」');
  ok(iMad >= 0 && iWnd > iMad, '★ 该按钮位于「💊 治愈不定疯狂（需 KP 同意）」之后');
  ok(ss.indexOf("op: 'sheet.healwound'") >= 0, '玩家端发 op = sheet.healwound');
  ok(/ctx\.intent\(M\.INTENT\.ACT, \{ op: 'sheet\.healwound' \}\)/.test(ss),
     '经 ctx.intent(ACT, {op:sheet.healwound}) 发起（KP 同意流程）');
  ok(/if \(!isMemberWounded\(meNow\)\)/.test(ss),
     '前置校验读权威端实时 body：不在重伤组 → 拦截');
  ok(ss.indexOf('当前没有需要治愈的伤势') >= 0,
     '拦截文案 = 「当前没有需要治愈的伤势」，不发请求');
})();

section('UI-第 3 项 · KP 工具箱「🩹 治愈伤势」');
(function () {
  var cw = segOf('cureWoundForPlayer');
  ok(cw.length > 0, 'KP 端存在 cureWoundForPlayer');
  ok(/skip: targetBlocked/.test(cw), 'cureWoundForPlayer 用 targetBlocked 过滤（已撕卡不可选）');
  ok(cw.indexOf("op: 'sheet.healwound'") >= 0, 'cureWoundForPlayer 发 op = sheet.healwound');
  ok(/该角色当前没有需要治愈的伤势/.test(cw), '目标不在重伤组 → toast 拦截');
  ok(segOf('kpDirectivesCard').indexOf('🩹 治愈伤势') >= 0,
     'KP 定向指令卡出现「🩹 治愈伤势」按钮（模板 = 治愈疯狂）');
})();

section('UI-第 4 项 · KP 工具箱「🚑 急救 / 医学」（aid.apply）');
(function () {
  var aid = segOf('aidForPlayer');
  ok(aid.length > 0, 'KP 端存在 aidForPlayer');
  ok(aid.indexOf("op: 'aid.apply'") >= 0, 'aidForPlayer 发 op = aid.apply');
  ok(/seat:\s*hv/.test(aid), '提交体字段 seat = 施救者 seat');
  ok(/targetSeat:\s*tv/.test(aid), '提交体字段 targetSeat = 目标玩家 seat');
  ok(/skill:\s*skill\b/.test(aid), '提交体字段 skill');
  ok(/var skill = String\(skillSel\.value \|\| '急救'\)/.test(aid), '技能默认「急救」');
  ok(/skill !== '急救' && skill !== '医学'/.test(aid),
     '★ 技能取值只可能是「急救」/「医学」（越界拦截）');
  ok((aid.match(/value: '(急救|医学)'/g) || []).length === 2,
     '技能下拉恰为「急救」「医学」两项');
  ok(aid.indexOf('targetBlocked') >= 0, '施救者 / 目标池均剔除已撕卡（targetBlocked）');
  ok(aid.indexOf('aliveUnits') < 0 && aid.indexOf("value: 'a:'") < 0,
     '★ 目标池已收敛为纯玩家（不含单位 / NPC / 怪物；契约：targetSeat 只认玩家 seat）');
  ok(segOf('kpDirectivesCard').indexOf('🚑 急救 / 医学') >= 0,
     'KP 定向指令卡出现「🚑 急救 / 医学」按钮');
})();

section('UI-第 5 项 · KP 视角玩家信息栏 SAN 数值显示');
(function () {
  var list = segOf('kpPlayerList');
  ok(list.indexOf("statBar('SAN', s.san, s.sanMax, 'san')") >= 0,
     '★ kpPlayerList 出现 SAN 数值条（用 s.san / s.sanMax）');
  ok(list.indexOf("statBar('HP', s.hp, s.hpMax, 'hp')") >= 0 &&
     list.indexOf("statBar('MP', s.mp, s.mpMax, 'mp')") >= 0,
     '既有 HP / MP 数值条保持（SAN 追加在它们之后）');
  var iHp = list.indexOf("statBar('HP'");
  var iSan = list.indexOf("statBar('SAN'");
  ok(iSan > iHp, 'SAN 条位于 HP 条之后（列表行内顺序正确）');
})();

section('UI-第 6 项 · 昏迷角色前端同款前置提示');
(function () {
  ok(/function isMemberUnconscious\(m\) \{/.test(rpClean), '定义 isMemberUnconscious 谓词');
  ok(/isMemberUnconscious\(me0\)/.test(segOf('sanCheckSheet')) ||
     /isMemberUnconscious\(me0\)/.test(rpClean),
     '★ SAN Check 入口对「昏迷」给出前端前置提示（与「疯狂发作中」并列）');
  ok(/你正处于昏迷，无法行动/.test(rpClean), '昏迷提示文案存在');
})();

section('UI-守卫 · room-panels.js 语法可解析 + app.css 未被触碰（无新增 .gp-grid 风险）');
(function () {
  var parsed = true, err = '';
  try { new vm.Script(fs.readFileSync(path.join(base, 'ui/room-panels.js'), 'utf8'), { filename: 'room-panels.js' }); }
  catch (e) { parsed = false; err = e.message; }
  ok(parsed, 'room-panels.js vm.Script 编译通过（语法正确）', err);

  /* 置灰走内联样式（不改 app.css）→ 本次不新增任何 CSS 规则，
     因此天然不存在「新增 .gp-grid 规则」的风险；app.css 既有 .gp-grid 规则须原样保留。 */
  var css = fs.readFileSync('web/css/app.css', 'utf8');
  ok(css.indexOf('v2.8.0') < 0, '★ app.css 无 v2.8.0 新增块；本次未触碰 CSS → 不存在新增 .gp-grid 的风险');
  ok((css.match(/\.gp-grid/g) || []).length > 0, 'app.css 既有 .gp-grid 规则仍在（未被删除 / 改动）');
  var o = (css.match(/{/g) || []).length, c = (css.match(/}/g) || []).length;
  eq(o, c, 'app.css 花括号配平');

  /* 第 1 项禁用态：走内联 style（opacity + cursor），不依赖任何新增 CSS 类。 */
  var ss = segOf('selfStateSheet');
  ok(/style: locked \? \{ opacity: '0\.45', cursor: 'not-allowed'/.test(ss),
     '★ 置灰走内联样式（opacity / cursor），零 CSS 改动');
})();

/* ============================================================
 * 汇总 —— 在进程退出时打印，方便另一位工程师（模型层）在其后 append 自己的小节
 * ============================================================ */
process.on('exit', function () {
  console.log('\nv2.8.0 fixes regression: ' + pass + ' passed, ' + fail + ' failed');
  console.log('RESULT: ' + (fail ? 'FAIL' : 'PASS'));
  if (fail) process.exitCode = 1;
});


/* ============================================================
 * 模型层小节 · software-engineer（寇豆码）—— HP 机制 v2.8.0（第 1~6 块）
 *
 *   第 1 块 HP 变动唯一收口 applyHpChange(m, delta, reason, opts) + 修复唯一漏判入口
 *          （sceneCheckStep 场景检定失败扣血）；
 *   第 2 块 settleWounds 判定口径（即死 `>`、归零分流、重伤瞬间 CON、解除重伤）；
 *   第 3 块 身体状态口径（轻伤 = HP<上限且未重伤；prone 用战斗槽 down 表达，不新增字段）；
 *   第 4 块 天/周恢复（1 回合=1 天 / 3 回合=1 周）+ 统一回合出口 _advanceRound（探索态也生效）；
 *   第 5 块 昏迷全局锁（intent）+ 战斗轮次自动跳过昏迷 PC（_syncBodyToCombatSlot）；
 *   第 6 块 两个新 op：sheet.healwound（治愈伤势）/ aid.apply（队友施救·急救/医学）。
 * ============================================================ */
function feeder2(seqAt) {
  var i = 0;
  return function () { return seqAt[Math.min(i++, seqAt.length - 1)]; };
}
function mkRules2(o) {
  o = o || {};
  return {
    LEVEL: { CRITICAL: 5, EXTREME: 4, HARD: 3, REGULAR: 2, FAIL: 1, FUMBLE: -1 },
    dyingRoundCheck: function (con) {
      var dead = !!o.conDead;
      return { check: { value: dead ? 100 : 1, base: con, passed: !dead, level: dead ? 1 : 2 },
               dead: dead, stable: !dead, summary: dead ? 'CON 失败' : 'CON 成功' };
    },
    check: function (a) {
      a = a || {};
      var res = (o.check ? o.check(a) : null) || { passed: true, level: 2, value: 1 };
      return { value: (res.value != null ? res.value : 1), base: a.base,
               passed: !!res.passed, level: (res.level != null ? res.level : 2),
               levelText: (res.passed === false ? '失败' : '成功') };
    },
    rollExpr: function (expr) {
      var n = Number(expr);
      return { ok: true, total: (isFinite(n) ? n : (o.d3 != null ? o.d3 : 1)), rolls: [] };
    },
    skillValue: function (sheet, name) { return (o.skills && o.skills[name] != null) ? o.skills[name] : null; },
    sceneStepResolve: function (step, level) {
      return { damage: (Number(level) >= 2 ? '' : (o.sceneDamage || '20')), note: '', next: null, done: true };
    }
  };
}
function mkH2(o) {
  o = o || {};
  return new M.Host({ rules: o.rules || mkRules2(), rng: o.rng || feeder2([0.5]),
    meta: { code: 'abc123', name: 't', kpName: 'KP' }, now: function () { return 1700000000000; } });
}
function addP2(h, seat, name, hp, maxHP, extra) {
  var m = h.attachPeer({ seat: seat, cid: 'c-' + seat, role: M.ROLE.PLAYER, nickname: name, at: 1 }).member;
  m.charName = name;
  m.sheet = Object.assign({
    name: name, attrs: { con: 50, int: 50 },
    status: { currentHP: hp, maxHP: maxHP, currentSAN: 50, maxSAN: 50, body: '正常' },
    skills: [{ name: '急救', total: 60 }, { name: '医学', total: 70 }],
    madness: [], mental: ['正常']
  }, extra || {});
  return m;
}
function planText2(o) { return JSON.stringify(o || []); }
function hasEvt2(o, t) { return (o || []).some(function (r) { return r.msg && r.msg.t === t; }); }

section('模型-第 2 块 · settleWounds 三档伤害（正常 / 重伤 / 即死 + 边界）');
(function () {
  var h1 = mkH2({ rules: mkRules2({ conDead: false }) });
  var m1 = addP2(h1, 's-a', '甲', 12, 12);
  h1.applyHpChange(m1, -5, 't');
  eq(m1.sheet.status.currentHP, 7, '正常伤害：HP 12 → 7');
  eq(m1.sheet.status.body, '轻伤', '正常伤害（未重伤）→ 轻伤（HP<上限）');

  var h2 = mkH2({ rules: mkRules2({ conDead: false }) });
  var m2 = addP2(h2, 's-a', '甲', 12, 12);
  h2.applyHpChange(m2, -6, 't');
  eq(m2.sheet.status.body, '重伤', '★ 单次伤害 = 半血（6×2=12）→ 重伤');

  var h3 = mkH2({ rules: mkRules2({ conDead: false }) });
  var m3 = addP2(h3, 's-a', '甲', 12, 12);
  h3.applyHpChange(m3, -12, 't');
  eq(m3.sheet.status.currentHP, 0, '恰等于上限：HP 归零');
  // v2.10.0（R5）：'濒死' 从 body 白名单移除，改为 dying 标记 —— body='重伤' + dying=true 合成视图 '濒死'。
  //   反面例仍在（守的是即死阈值 `>`）：恰等于上限不是即死，走「重伤→濒死」。
  eq(m3.sheet.status.body, '重伤', '★ 单次伤害 = 上限（非 >）→ 有重伤 → 濒死（不是即死）；R5：body=重伤 + dying=true');
  eq(m3.sheet.status.dying, true, '★（R5）dying 标记置位');
  eq(M.bodyView(m3.sheet.status), '濒死', '★（R5）bodyView 合成 = 濒死');

  var h4 = mkH2({ rules: mkRules2({ conDead: false }) });
  var m4 = addP2(h4, 's-a', '甲', 12, 12);
  h4.applyHpChange(m4, -13, 't');
  eq(m4.sheet.status.body, '死亡', '★ 单次伤害 13 > 上限 12 → 立即死亡');
})();

section('模型-第 2 块 · HP 归零分流（无重伤→昏迷 / 有重伤→濒死；归零当刻不再掷 CON）');
(function () {
  var h1 = mkH2({ rules: mkRules2({ conDead: false }) });
  var m1 = addP2(h1, 's-a', '甲', 3, 12);
  var o1 = h1.applyHpChange(m1, -3, 't');            // 3 < 半血 6 → 非重伤
  // v2.10.0（R5）：无重伤归零 → unconscious 标记（body 保持改前伤级），视图合成 '昏迷'
  eq(m1.sheet.status.unconscious, true, '★ 小伤害归零（无重伤）→ 昏迷（unconscious 标记）');
  eq(m1.sheet.status.body, '正常', '★（R5）body 保持改前伤级（正常）');
  eq(M.bodyView(m1.sheet.status), '昏迷', '★（R5）bodyView 合成 = 昏迷');
  ok(!hasEvt2(o1, M.EVT.DICE), '归零当刻不再掷 CON 检定（无 DICE）');

  var h2 = mkH2({ rules: mkRules2({ conDead: false }) });
  var m2 = addP2(h2, 's-a', '甲', 6, 12);
  h2.applyHpChange(m2, -6, 't');                     // 6 ≥ 半血 → 重伤 → 归零 → 濒死
  // v2.10.0（R5）：有重伤归零 → body='重伤' + dying=true，视图合成 '濒死'
  eq(m2.sheet.status.body, '重伤', '★ 重伤后归零 → 濒死（R5：body=重伤 + dying=true）');
  eq(m2.sheet.status.dying, true, '★（R5）dying 标记置位');
  eq(M.bodyView(m2.sheet.status), '濒死', '★（R5）bodyView 合成 = 濒死');
})();

section('模型-第 2 块 · 重伤瞬间 CON 检定（失败 → 立即昏迷）');
(function () {
  var h = mkH2({ rules: mkRules2({ conDead: true }) });
  var m = addP2(h, 's-a', '甲', 12, 12);
  var o = h.applyHpChange(m, -6, 't');
  // v2.10.0（R5）：CON 失败置 unconscious 标记（body 保持 '重伤'），视图合成 '昏迷'
  eq(m.sheet.status.unconscious, true, '★ 重伤瞬间 CON 失败 → 立即昏迷（unconscious 标记）');
  eq(m.sheet.status.body, '重伤', '★（R5）body 保持重伤伤级');
  eq(M.bodyView(m.sheet.status), '昏迷', '★（R5）bodyView 合成 = 昏迷');
  ok(hasEvt2(o, M.EVT.DICE), '重伤瞬间做了一次 CON 检定（有 DICE）');
})();

section('模型-第 2 块 · 解除重伤（HP 恢复到 ≥ 半血）');
(function () {
  var h = mkH2({ rules: mkRules2({ conDead: false }) });
  var m = addP2(h, 's-a', '甲', 3, 12, { status: { currentHP: 3, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤' } });
  h.applyHpChange(m, 4, 't');                        // 3 → 7 ≥ 半血 6
  eq(m.sheet.status.currentHP, 7, '重伤角色回血 3 → 7');
  eq(m.sheet.status.body, '轻伤', '★ HP 恢复到 ≥ 半血 → 自动解除重伤（→ 轻伤）');
})();

section('模型-第 4 块 · 天/周：未重伤每回合 +1HP；探索态 round.next 也触发');
(function () {
  var h = mkH2({});
  var m = addP2(h, 's-a', '甲', 8, 12, { status: { currentHP: 8, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '轻伤' } });
  h.applyAction('host', { op: 'round.next' });
  eq(m.sheet.status.currentHP, 9, '★ 探索态 round.next → 轻伤角色 +1 HP（8→9）');
  h.applyAction('host', { op: 'round.next' });
  eq(m.sheet.status.currentHP, 10, '再推进一回合 → 10');

  var h2 = mkH2({ rules: mkRules2({ conDead: true }) });
  // v2.10.0（R5）：濒死改由 dying 标记表达（body='重伤' + dying=true）
  var m2 = addP2(h2, 's-a', '甲', 0, 12, { status: { currentHP: 0, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤', dying: true } });
  h2.applyAction('host', { op: 'round.next' });
  eq(m2.sheet.status.body, '死亡', '★ 探索态 round.next 触发「濒死每轮 CON」→ 失败死亡（旧实现探索态漏触发）');
  eq(m2.sheet.status.dying, false, '★（R5）死亡补丁同时清 dying 标记');
})();

section('模型-第 4 块 · 天/周：重伤每 3 回合 CON（成功 / 极难 / 失败三分支）');
(function () {
  function wounded(h) {
    return addP2(h, 's-a', '甲', 3, 12, { status: { currentHP: 3, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤' } });
  }
  var h1 = mkH2({ rules: mkRules2({ d3: 2, check: function () { return { passed: true, level: 2, value: 10 }; } }) });
  var m1 = wounded(h1);
  h1.state.meta.round = 3; h1.state.meta.hpWeek['s-a'] = 0;
  h1._onDayWeekTick();
  eq(m1.sheet.status.currentHP, 5, '★ 重伤每周 CON 成功 → +1D3（3→5）');
  eq(m1.sheet.status.body, '重伤', '未达半血 → 仍重伤');
  eq(h1.state.meta.hpWeek['s-a'], 3, '周检基准被重置为当前回合');

  var h2 = mkH2({ rules: mkRules2({ d3: 2, check: function () { return { passed: true, level: 4, value: 1 }; } }) });
  var m2 = wounded(h2);
  h2.state.meta.round = 3; h2.state.meta.hpWeek['s-a'] = 0;
  h2._onDayWeekTick();
  eq(m2.sheet.status.body, '轻伤', '★ 重伤每周 CON 极难成功 → 清除重伤（→ 轻伤）');

  var h3 = mkH2({ rules: mkRules2({ d3: 2, check: function () { return { passed: false, level: 1, value: 99 }; } }) });
  var m3 = wounded(h3);
  h3.state.meta.round = 3; h3.state.meta.hpWeek['s-a'] = 0;
  h3._onDayWeekTick();
  eq(m3.sheet.status.currentHP, 3, '★ 重伤每周 CON 失败 → 无恢复（HP 不动）');
  eq(m3.sheet.status.body, '重伤', '失败仍重伤');

  var h4 = mkH2({ rules: mkRules2({ d3: 2, check: function () { return { passed: true, level: 2 }; } }) });
  var m4 = wounded(h4);
  h4.state.meta.round = 2; h4.state.meta.hpWeek['s-a'] = 0;
  h4._onDayWeekTick();
  eq(m4.sheet.status.currentHP, 3, '★ 未满 3 回合（2）→ 重伤不检定、不恢复');
})();

section('模型-第 4 块 · meta.hpWeek 随存档 / 恢复携带');
(function () {
  var h = mkH2({});
  addP2(h, 's-a', '甲', 8, 12);
  h.state.meta.hpWeek = { 's-a': 7 };
  var save = M.parseSave(h.savePayload());
  eq(save.meta.hpWeek['s-a'], 7, '★ savePayload 携带 meta.hpWeek');
  var h2 = M.restoreHost(h.savePayload());
  eq(h2.state.meta.hpWeek['s-a'], 7, '★ restoreHost/adoptSave 恢复 meta.hpWeek');
})();

section('模型-第 5 块 · 昏迷全局操作锁 + 例外白名单');
(function () {
  var h = mkH2({});
  // v2.10.0（R5）：昏迷改由 unconscious 标记表达（body 保持伤级）
  addP2(h, 's-a', '甲', 5, 12, { status: { currentHP: 5, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '正常', unconscious: true } });
  var out1 = h.intent('s-a', M.intentMsg(M.INTENT.DICE, { expr: '1D100', direct: true }));
  ok(/昏迷/.test(planText2(out1)) && !hasEvt2(out1, M.EVT.DICE), '★ 昏迷玩家普通操作（掷骰）被拦', planText2(out1));

  var out2 = h.intent('s-a', M.intentMsg(M.INTENT.CHAT, { text: '救我' }));
  ok(hasEvt2(out2, M.EVT.CHAT), '★ 例外：聊天放行');

  var out3 = h.intent('s-a', M.intentMsg(M.INTENT.ACT, { op: 'sheet.healwound' }));
  ok(!/无法进行该操作/.test(planText2(out3)) && /等待确认/.test(planText2(out3)),
     '★ 例外：申请治愈伤势放行（进 KP 同意队列）', planText2(out3));

  var out4 = h.intent('s-a', M.intentMsg(M.INTENT.ACT, { op: 'aid.apply', seat: 's-a', targetSeat: 's-a', skill: '急救' }));
  ok(/昏迷/.test(planText2(out4)), '★ 反向：aid.apply 不在白名单（昏迷者被拦）', planText2(out4));

  ok(M.allowed(M.ROLE.PLAYER, 'sheet.healwound') === true &&
     M.needs(M.ROLE.PLAYER, 'sheet.healwound').confirm === 'kp', 'POLICY：sheet.healwound 允许玩家且需 KP 同意');
  ok(M.allowed(M.ROLE.PLAYER, 'aid.apply') === true &&
     M.needs(M.ROLE.PLAYER, 'aid.apply').confirm === 'kp', 'POLICY：aid.apply 允许玩家且需 KP 同意');
})();

section('模型-第 5 块 · 战斗轮次自动跳过昏迷 PC（state.self 变昏迷 → 同步战斗槽）');
(function () {
  var h = mkH2({});
  addP2(h, 's-a', '甲', 5, 12);
  addP2(h, 's-b', '乙', 12, 12);
  addP2(h, 's-c', '丙', 12, 12);
  h.state.combat = { turn: 0, round: 1, startedAt: 0, order: [
    { id: 's-b#0', actorId: 's-b', seat: 's-b', kind: 'pc', name: '乙', public: { hp: 12, hpMax: 12 } },
    { id: 's-a#0', actorId: 's-a', seat: 's-a', kind: 'pc', name: '甲', public: { hp: 5, hpMax: 12 } },
    { id: 's-c#0', actorId: 's-c', seat: 's-c', kind: 'pc', name: '丙', public: { hp: 12, hpMax: 12 } }
  ] };
  // v2.10.0（R5）：state.self 传 unconscious 标记（body 白名单已收敛为 4 值）
  h.intent('s-a', M.intentMsg(M.INTENT.ACT, { op: 'state.self', status: { unconscious: true } }));
  var slotA = h.state.combat.order.filter(function (s) { return s.id === 's-a#0'; })[0];
  eq(slotA.public.down, true, '★ 经 state.self 变昏迷 → 战斗槽 pub.down 同步为 true');
  h.applyAction('host', { op: 'combat.next' });
  eq(h.state.combat.turn, 2, '★ 昏迷的 PC（槽 1）被自动跳过 → 轮到槽 2');
})();

section('模型-第 6 块 · sheet.healwound（KP 直接 / 玩家申请经 KP / 拒绝 / 无需治愈 / HP≤0→1）');
(function () {
  var h = mkH2({});
  var m = addP2(h, 's-a', '甲', 3, 12, { status: { currentHP: 3, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤' } });
  h.applyAction('host', { op: 'sheet.healwound', seat: 's-a' });
  eq(m.sheet.status.body, '轻伤', '★ KP 治愈伤势（直接生效）→ 重伤清除（HP<上限 → 轻伤）');

  // v2.10.0（R5）：昏迷改由 unconscious 标记表达
  var h2 = mkH2({});
  var m2 = addP2(h2, 's-a', '甲', 0, 12, { status: { currentHP: 0, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '正常', unconscious: true } });
  h2.applyAction('host', { op: 'sheet.healwound', seat: 's-a' });
  eq(m2.sheet.status.currentHP, 1, '★ HP ≤ 0 → 置为 1');
  eq(m2.sheet.status.body, '轻伤', '治愈后 body = 轻伤（HP<上限）');
  eq(m2.sheet.status.unconscious, false, '★（R5）治愈补丁显式清 unconscious 标记');

  var h3 = mkH2({});
  // v2.10.0（R5）：濒死改由 dying 标记表达（body='重伤' + dying=true）
  var m3 = addP2(h3, 's-a', '甲', 2, 12, { status: { currentHP: 2, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤', dying: true } });
  var p3 = h3.intent('s-a', M.intentMsg(M.INTENT.ACT, { op: 'sheet.healwound' }));
  ok(/等待确认/.test(planText2(p3)), '玩家申请治愈伤势 → 进 KP 待办');
  eq(m3.sheet.status.body, '重伤', '未同意前状态不变（R5：濒死=重伤+dying）');
  eq(m3.sheet.status.dying, true, '★（R5）未同意前 dying 标记仍在');
  h3.intent('host', M.intentMsg(M.INTENT.CONFIRM, { op: 'sheet.healwound', agree: true }));
  ok(m3.sheet.status.body === '轻伤' || m3.sheet.status.body === '正常', '★ KP 同意 → 治愈生效', m3.sheet.status.body);

  var h4 = mkH2({});
  addP2(h4, 's-a', '甲', 0, 12, { status: { currentHP: 0, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '死亡' } });
  var p4 = h4.applyAction('host', { op: 'sheet.healwound', seat: 's-a' });
  ok(/已撕卡/.test(planText2(p4)), '★ 死亡（撕卡）目标 → 拒绝治愈', planText2(p4));

  var h5 = mkH2({});
  addP2(h5, 's-a', '甲', 12, 12);
  var p5 = h5.applyAction('host', { op: 'sheet.healwound', seat: 's-a' });
  ok(/无需治愈/.test(planText2(p5)), '★ 无伤势 → 明确提示「无需治愈」（不静默成功）', planText2(p5));
})();

section('模型-第 6 块 · aid.apply（急救 +1HP / 医学 +1D3 / 濒死→重伤 / 失败无效果 / 非法 seat）');
(function () {
  function pair(h) {
    addP2(h, 's-b', '医者', 12, 12);
    // v2.10.0（R5）：濒死改由 dying 标记表达（body='重伤' + dying=true）
    return addP2(h, 's-a', '伤者', 0, 12, { status: { currentHP: 0, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤', dying: true } });
  }
  var h1 = mkH2({ rules: mkRules2({ skills: { '急救': 60, '医学': 70 }, check: function () { return { passed: true, level: 2, value: 10 }; } }) });
  var t1 = pair(h1);
  h1.applyAction('host', { op: 'aid.apply', seat: 's-b', targetSeat: 's-a', skill: '急救' });
  eq(t1.sheet.status.currentHP, 1, '★ 急救成功 → 目标 +1 HP');
  eq(t1.sheet.status.body, '重伤', '★ 急救成功且目标濒死 → 稳定为重伤');

  var h2 = mkH2({ rules: mkRules2({ d3: 3, skills: { '急救': 60, '医学': 70 }, check: function () { return { passed: true, level: 2, value: 10 }; } }) });
  var t2 = pair(h2);
  h2.applyAction('host', { op: 'aid.apply', seat: 's-b', targetSeat: 's-a', skill: '医学' });
  eq(t2.sheet.status.currentHP, 3, '★ 医学成功 → 目标 +1D3 HP');
  eq(t2.sheet.status.body, '重伤', '★ 医学成功且目标濒死 → 脱离濒死（回到重伤）');

  var h3 = mkH2({ rules: mkRules2({ skills: { '急救': 60 }, check: function () { return { passed: false, level: 1, value: 99 }; } }) });
  var t3 = pair(h3);
  var p3 = h3.applyAction('host', { op: 'aid.apply', seat: 's-b', targetSeat: 's-a', skill: '急救' });
  eq(t3.sheet.status.currentHP, 0, '★ 急救失败 → 无效果（HP 不变）');
  // v2.10.0（R5）：失败 → 状态不变（body=重伤 + dying=true，视图仍 '濒死'）
  eq(t3.sheet.status.body, '重伤', '急救失败 → 状态不变（R5：濒死=重伤+dying）');
  eq(t3.sheet.status.dying, true, '★（R5）失败后 dying 标记仍在');
  ok(/没有效果/.test(planText2(p3)), '失败给出明确提示「没有效果」');

  var h4 = mkH2({ rules: mkRules2({ skills: { '急救': 60 } }) });
  addP2(h4, 's-a', '甲', 5, 12);
  ok(/找不到施救者/.test(planText2(h4.applyAction('host', { op: 'aid.apply', seat: 'ghost', targetSeat: 's-a', skill: '急救' }))),
     '★ 非法施救者 seat → 明确拒绝');
  ok(/找不到施救目标/.test(planText2(h4.applyAction('host', { op: 'aid.apply', seat: 's-a', targetSeat: 'nobody', skill: '急救' }))),
     '★ 非法目标 seat → 明确拒绝');
  ok(/只能/.test(planText2(h4.applyAction('host', { op: 'aid.apply', seat: 's-a', targetSeat: 's-a', skill: '射击' }))),
     '★ 非法技能 → 明确拒绝');
})();

section('模型-第 1 块 · sceneCheckStep 现在走 HP 判定（唯一漏判入口修复）');
(function () {
  var h = mkH2({ rules: mkRules2({ sceneDamage: '20' }) });
  var m = addP2(h, 's-a', '甲', 12, 12);
  h.state.sceneCheck = { id: 'sc1', title: '陷阱', cursor: 0, results: [], at: 1,
    steps: [{ id: 'st1', title: '陷阱', skill: '侦查', targetSeat: 's-a', difficulty: 'regular' }] };
  h.applyAction('host', { op: 'scene.check.step', stepId: 'st1', seat: 's-a', level: 1 });
  eq(m.sheet.status.body, '死亡', '★ 场景检定失败造成 20 伤害（> 上限 12）→ 死亡（旧实现只扣 HP 不判死）');
})();

section('模型-R2 · F2：状态管理(state.self / state.request) 与战斗伤害走同一判定口径');
(function () {
  /* state.self 非零下降达半血 → 重伤（旧实现只在 HP→0 判定） */
  var h1 = mkH2({ rules: mkRules2({ conDead: false }) });
  var m1 = addP2(h1, 's-a', '甲', 12, 12);
  h1.intent('s-a', M.intentMsg(M.INTENT.ACT, { op: 'state.self', status: { currentHP: 6 } }));
  eq(m1.sheet.status.currentHP, 6, 'state.self 12→6');
  eq(m1.sheet.status.body, '重伤', '★ F2：state.self 非零下降达半血 → 重伤');

  /* state.self 重伤回血到 ≥ 半血 → 解除重伤 */
  var h2 = mkH2({ rules: mkRules2({ conDead: false }) });
  var m2 = addP2(h2, 's-a', '甲', 3, 12, { status: { currentHP: 3, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤' } });
  h2.intent('s-a', M.intentMsg(M.INTENT.ACT, { op: 'state.self', status: { currentHP: 8 } }));
  eq(m2.sheet.status.body, '轻伤', '★ F2：state.self 重伤 3→8（≥半血）→ 解除重伤');

  /* state.self 构成重伤且 CON 失败 → 昏迷（避免昏迷检定，与 settleWounds 同款） */
  var h3 = mkH2({ rules: mkRules2({ conDead: true }) });
  var m3 = addP2(h3, 's-a', '甲', 12, 12);
  h3.intent('s-a', M.intentMsg(M.INTENT.ACT, { op: 'state.self', status: { currentHP: 6 } }));
  // v2.10.0（R5）：CON 失败置 unconscious 标记（body 保持 '重伤'），视图合成 '昏迷'
  eq(m3.sheet.status.unconscious, true, '★ F2：state.self 构成重伤且 CON 失败 → 昏迷（unconscious 标记）');
  eq(m3.sheet.status.body, '重伤', '★（R5）body 保持重伤伤级');
  eq(M.bodyView(m3.sheet.status), '昏迷', '★（R5）bodyView 合成 = 昏迷');

  /* state.self 小改动归零（无重伤）→ 昏迷 */
  var h4 = mkH2({ rules: mkRules2({ conDead: false }) });
  var m4 = addP2(h4, 's-a', '甲', 3, 12);
  h4.intent('s-a', M.intentMsg(M.INTENT.ACT, { op: 'state.self', status: { currentHP: 0 } }));
  // v2.10.0（R5）：无重伤归零 → unconscious 标记（body 保持改前伤级）
  eq(m4.sheet.status.unconscious, true, 'F2：state.self 小改动归零（无重伤）→ 昏迷（unconscious 标记）');
  eq(M.bodyView(m4.sheet.status), '昏迷', '★（R5）bodyView 合成 = 昏迷');

  /* state.request（consent）同样两条 */
  var h5 = mkH2({ rules: mkRules2({ conDead: false }) });
  var m5 = addP2(h5, 's-a', '甲', 12, 12);
  h5.intent(M.HOST_SEAT, { op: M.INTENT.ACT, p: { op: 'state.request', seat: 's-a', change: { hp: 6 }, reason: 'x' } });
  var rid = (h5._requestsBySeat['s-a'] || []).slice(-1)[0].id;
  h5.intent('s-a', { op: M.INTENT.CONSENT, p: { id: rid, agree: true } });
  eq(m5.sheet.status.body, '重伤', '★ F2：state.request 非零下降达半血 → 重伤');

  var h6 = mkH2({ rules: mkRules2({ conDead: false }) });
  var m6 = addP2(h6, 's-a', '甲', 3, 12, { status: { currentHP: 3, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤' } });
  h6.intent(M.HOST_SEAT, { op: M.INTENT.ACT, p: { op: 'state.request', seat: 's-a', change: { hp: 8 }, reason: 'x' } });
  var rid2 = (h6._requestsBySeat['s-a'] || []).slice(-1)[0].id;
  h6.intent('s-a', { op: M.INTENT.CONSENT, p: { id: rid2, agree: true } });
  eq(m6.sheet.status.body, '轻伤', '★ F2：state.request 重伤回血 ≥半血 → 解除');
})();

section('模型-R2 · F3：aid.apply 成功一并唤醒「昏迷」');
(function () {
  function pair(h) {
    addP2(h, 's-b', '医者', 12, 12);
    // v2.10.0（R5）：昏迷改由 unconscious 标记表达
    return addP2(h, 's-a', '昏者', 0, 12, { status: { currentHP: 0, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '正常', unconscious: true } });
  }
  var h1 = mkH2({ rules: mkRules2({ skills: { '急救': 60 }, check: function () { return { passed: true, level: 2, value: 10 }; } }) });
  var t1 = pair(h1);
  h1.applyAction('host', { op: 'aid.apply', seat: 's-b', targetSeat: 's-a', skill: '急救' });
  eq(t1.sheet.status.currentHP, 1, '★ F3：昏迷且 HP≤0 → 急救先置 1');
  eq(t1.sheet.status.body, '轻伤', '★ F3：急救成功唤醒昏迷（body 归位轻伤）');

  var h2 = mkH2({ rules: mkRules2({ d3: 3, skills: { '医学': 70 }, check: function () { return { passed: true, level: 2, value: 10 }; } }) });
  var t2 = pair(h2);
  h2.applyAction('host', { op: 'aid.apply', seat: 's-b', targetSeat: 's-a', skill: '医学' });
  eq(t2.sheet.status.body, '轻伤', '★ F3：医学成功唤醒昏迷');

  var h3 = mkH2({ rules: mkRules2({ skills: { '急救': 60 }, check: function () { return { passed: false, level: 1, value: 99 }; } }) });
  var t3 = pair(h3);
  h3.applyAction('host', { op: 'aid.apply', seat: 's-b', targetSeat: 's-a', skill: '急救' });
  // v2.10.0（R5）：失败 → 不唤醒（unconscious 标记仍在，body 保持改前伤级）
  eq(t3.sheet.status.unconscious, true, '★ F3 反例：检定失败 → 不唤醒（仍昏迷）');
  eq(t3.sheet.status.body, '正常', '★（R5）body 保持改前伤级（正常）');
})();

section('模型-R2 · F1：战斗前已昏迷/濒死 PC 入队即同步战斗槽');
(function () {
  var h = mkH2({});
  // v2.10.0（R5）：昏迷改由 unconscious 标记表达
  addP2(h, 's-a', '甲', 5, 12, { status: { currentHP: 5, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '正常', unconscious: true } });
  addP2(h, 's-b', '乙', 12, 12);
  h.applyAction('host', { op: 'combat.start', actors: [
    { id: 'pc1', name: '甲', kind: 'pc', seat: 's-a', dex: 60, hp: 5, hpMax: 12 },
    { id: 'pc2', name: '乙', kind: 'pc', seat: 's-b', dex: 50, hp: 12, hpMax: 12 }
  ] });
  var slotA = h.state.combat.order.filter(function (s) { return s.seat === 's-a'; })[0];
  eq(slotA.public.down, true, '★ F1：combat.start 含已昏迷 PC → 槽 down=true');
  h.applyAction('host', { op: 'combat.next' });
  var cur = h.state.combat.order[h.state.combat.turn];
  ok(cur && cur.seat !== 's-a', '★ F1：nextTurn 跳过已昏迷 PC（当前轮到非昏迷者）', cur && cur.name);

  var h2 = mkH2({});
  // v2.10.0（R5）：濒死改由 dying 标记表达（body='重伤' + dying=true）
  addP2(h2, 's-a', '甲', 3, 12, { status: { currentHP: 3, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤', dying: true } });
  addP2(h2, 's-b', '乙', 12, 12);
  h2.applyAction('host', { op: 'combat.start', actors: [{ id: 'pc2', name: '乙', kind: 'pc', seat: 's-b', dex: 50, hp: 12, hpMax: 12 }] });
  h2.applyAction('host', { op: 'combat.enqueue', seat: 's-a' });
  var slotA2 = h2.state.combat.order.filter(function (s) { return s.seat === 's-a'; })[0];
  ok(slotA2 && slotA2.public.down === true, '★ F1：combat.enqueue 加入已濒死 PC → 槽 down=true');
})();

section('模型-R2 · 结构：唯一判定口径 deriveBodyFromHp + 入队同步 helper');
(function () {
  var model = readSrc('core/room-model.js');
  var clean = stripComments(model);
  function cnt(re) { return (clean.match(re) || []).length; }
  eq(cnt(/function deriveBodyFromHp\(/g), 1, '★ deriveBodyFromHp 唯一定义（HP→body 唯一口径）');
  eq(cnt(/Host\.prototype\._stampSlotBody = function/g), 1, '_stampSlotBody 唯一定义');
  eq(cnt(/Host\.prototype\._stampAllPcSlots = function/g), 1, '_stampAllPcSlots 唯一定义');
  eq((model.match(/this\._stampAllPcSlots\(\);/g) || []).length, 2, '★ combatStart / combatEnqueue 均调用 _stampAllPcSlots');
  ok(/deriveBodyFromHp\(prevBody, amount, after, maxHP\)/.test(clean), 'settleWounds 走 deriveBodyFromHp');
  ok(/deriveBodyFromHp\(prevBody, 0, after, maxHP\)/.test(clean), 'applyHpChange 走 deriveBodyFromHp');
  ok(/deriveBodyFromHp\(prevBodyJ, amountNow/.test(clean), 'applyStatusJudgment 走 deriveBodyFromHp');
  eq(cnt(/this\.settleWounds\(/g), 1, '扣血仍未绕过 applyHpChange（settleWounds 仅 1 处调用）');
})();

section('模型-跨块 · 收口唯一性 / 结构守卫');
(function () {
  var model = readSrc('core/room-model.js');
  var clean = stripComments(model);
  function cnt(re) { return (clean.match(re) || []).length; }
  eq(cnt(/Host\.prototype\.applyHpChange = function/g), 1, '★ applyHpChange 唯一定义（HP 变动唯一收口）');
  eq(cnt(/Host\.prototype\._syncBodyToCombatSlot = function/g), 1, '_syncBodyToCombatSlot 唯一定义');
  eq(cnt(/Host\.prototype\._isUnconscious = function/g), 1, '_isUnconscious 唯一定义');
  eq(cnt(/Host\.prototype\.healWound = function/g), 1, 'healWound 唯一定义');
  eq(cnt(/Host\.prototype\.aidApply = function/g), 1, 'aidApply 唯一定义');
  eq(cnt(/Host\.prototype\._advanceRound = function/g), 1, '_advanceRound 唯一定义');
  eq(cnt(/Host\.prototype\._onDayWeekTick = function/g), 1, '_onDayWeekTick 唯一定义');
  ok(/'sheet\.healwound': \{ roles: \['player', 'kp'\], confirm: 'kp' \}/.test(model), 'POLICY 注册 sheet.healwound');
  ok(/'aid\.apply': \{ roles: \['player', 'kp'\], confirm: 'kp' \}/.test(model), 'POLICY 注册 aid.apply');
  ok(/this\.healWound\(seat, p\)/.test(model), 'applyAction 分发 sheet.healwound');
  ok(/this\.aidApply\(seat, p\)/.test(model), 'applyAction 分发 aid.apply');
  eq(cnt(/this\.settleWounds\(/g), 1, '★ 仅 applyHpChange 内部保留一处 settleWounds 调用（其余扣血入口全部收口）');
  ok(/amount > maxHP/.test(clean), '★ settleWounds 即死阈值用 >（不再是 >=）');
  ok(/_advanceRound\(out, nextRound\)/.test(model), '★ 探索态 round.next 走统一回合出口');
  ok(/_advanceRound\(out, round\)/.test(model), '★ 战斗态 nextTurn 走统一回合出口');
  var protos = (model.match(/Host\.prototype\.[A-Za-z_]+/g) || []);
  var seen = {}, dups = [];
  protos.forEach(function (p) { if (seen[p]) { if (dups.indexOf(p) < 0) dups.push(p); } else seen[p] = 1; });
  eq(dups.length, 0, '★ room-model.js 无重复 Host.prototype 定义（不会互相覆盖）', dups.join(','));
})();


/* ============================================================
 * ★ QA 独立回归 · Edward（严过关）—— 以「怀疑」复核 v2.8.0
 *
 *   断言依据**原始用户文档**独立重写（docs/hp-mechanics-extract.md + 用户原件
 *   D:\60965\Downloads\HP变动机制.doc 原文：即死 = 单次伤害 **>** 最大 HP；
 *   重伤 = 单次伤害 ≥ 最大 HP 的一半；濒死 = 重伤 + HP 归零；
 *   昏迷 = 重伤后 CON 失败，解除方式「成功急救/医学可唤醒 / KP 裁定」）。
 *   不复制任何既有实现的写法，独立构造边界与反例。
 * ============================================================ */
function qaFnSrc(src, name) {
  var head = src.indexOf('function ' + name + '(');
  if (head < 0) return '';
  var i = src.indexOf('{', head), depth = 0, close = -1;
  for (var j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { close = j; break; } }
  }
  return close > 0 ? src.slice(head, close + 1) : '';
}

section('QA-① 三档伤害边界（恰半血 / 半血-1 / 恰上限 / 上限+1）');
(function () {
  var h = mkH2({ rules: mkRules2({ conDead: false }) });
  var a = addP2(h, 's-a', '甲', 12, 12);
  h.applyHpChange(a, -6, 't');
  eq(a.sheet.status.currentHP, 6, 'HP 12 → 6');
  eq(a.sheet.status.body, '重伤', '恰等于半血(6) → 重伤');

  var h2 = mkH2({ rules: mkRules2({ conDead: false }) });
  var b = addP2(h2, 's-b', '乙', 12, 12);
  h2.applyHpChange(b, -5, 't');
  eq(b.sheet.status.currentHP, 7, 'HP 12 → 7');
  eq(b.sheet.status.body, '轻伤', '半血-1(5) → 普通伤害 → 轻伤');

  var h3 = mkH2({ rules: mkRules2({ conDead: false }) });
  var c = addP2(h3, 's-c', '丙', 12, 12);
  var o3 = h3.applyHpChange(c, -12, 't');
  // v2.10.0（R5）：有重伤归零 → body='重伤' + dying=true，视图合成 '濒死'
  eq(c.sheet.status.body, '重伤', '★ 恰等于上限(12) → 非即死，重伤归零 → 濒死（R5：body=重伤 + dying=true）');
  eq(c.sheet.status.dying, true, '★（R5）dying 标记置位');
  eq(M.bodyView(c.sheet.status), '濒死', '★（R5）bodyView 合成 = 濒死');
  ok(!hasEvt2(o3, M.EVT.DICE), '恰等于上限归零当刻不掷 CON');

  var h4 = mkH2({ rules: mkRules2({ conDead: false }) });
  var d = addP2(h4, 's-d', '丁', 12, 12);
  h4.applyHpChange(d, -13, 't');
  eq(d.sheet.status.body, '死亡', '★ 上限+1(13) → 即死');
})();

section('QA-② HP 归零分流（无重伤→昏迷 / 有重伤→濒死；二者皆无 DICE）');
(function () {
  var h = mkH2({ rules: mkRules2({ conDead: false }) });
  var m = addP2(h, 's-a', '甲', 3, 12);
  var o = h.applyHpChange(m, -3, 't');
  // v2.10.0（R5）：无重伤归零 → unconscious 标记，视图合成 '昏迷'
  eq(m.sheet.status.unconscious, true, '小数伤害归零（无重伤）→ 昏迷（unconscious 标记）');
  eq(M.bodyView(m.sheet.status), '昏迷', '★（R5）bodyView 合成 = 昏迷');
  ok(!hasEvt2(o, M.EVT.DICE), '归零当刻无 CON（无 DICE）');

  var h2 = mkH2({ rules: mkRules2({ conDead: false }) });
  var m2 = addP2(h2, 's-a', '甲', 6, 12);
  var o2 = h2.applyHpChange(m2, -6, 't');
  // v2.10.0（R5）：有重伤归零 → body='重伤' + dying=true，视图合成 '濒死'
  eq(m2.sheet.status.body, '重伤', '单次重伤(6)归零 → 濒死（R5：body=重伤 + dying=true）');
  eq(m2.sheet.status.dying, true, '★（R5）dying 标记置位');
  eq(M.bodyView(m2.sheet.status), '濒死', '★（R5）bodyView 合成 = 濒死');
  ok(!hasEvt2(o2, M.EVT.DICE), '有重伤归零亦不掷 CON');
})();

section('QA-③ 重伤瞬间 CON（失败→昏迷 / 成功→重伤）');
(function () {
  var hF = mkH2({ rules: mkRules2({ conDead: true }) });
  var mf = addP2(hF, 's-a', '甲', 12, 12);
  var of = hF.applyHpChange(mf, -6, 't');
  // v2.10.0（R5）：CON 失败置 unconscious 标记（body 保持 '重伤'），视图合成 '昏迷'
  eq(mf.sheet.status.unconscious, true, '重伤瞬间 CON 失败 → 立即昏迷（unconscious 标记）');
  eq(mf.sheet.status.body, '重伤', '★（R5）body 保持重伤伤级');
  eq(M.bodyView(mf.sheet.status), '昏迷', '★（R5）bodyView 合成 = 昏迷');
  ok(hasEvt2(of, M.EVT.DICE), '重伤瞬间确实掷了一次 CON');

  var hO = mkH2({ rules: mkRules2({ conDead: false }) });
  var mo = addP2(hO, 's-a', '甲', 12, 12);
  var oo = hO.applyHpChange(mo, -6, 't');
  eq(mo.sheet.status.body, '重伤', '★ 重伤瞬间 CON 成功 → 保持重伤（不昏迷）');
  ok(hasEvt2(oo, M.EVT.DICE), 'CON 成功亦留骰点记录');
})();

section('QA-④ 解除重伤的 prevBody 门（改前是重伤→解除；改前非重伤→不受该规则影响）');
(function () {
  var h = mkH2({ rules: mkRules2({ conDead: false }) });
  var m = addP2(h, 's-a', '甲', 3, 12, { status: { currentHP: 3, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤' } });
  h.applyHpChange(m, 4, 't');
  eq(m.sheet.status.currentHP, 7, '重伤角色 3 → 7');
  eq(m.sheet.status.body, '轻伤', '★ 改前=重伤，恢复到 ≥半血(6) → 解除重伤');

  var h1 = mkH2({ rules: mkRules2({ conDead: false }) });
  var m1 = addP2(h1, 's-a', '甲', 2, 12, { status: { currentHP: 2, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤' } });
  h1.applyHpChange(m1, 10, 't');
  eq(m1.sheet.status.body, '正常', '★ 改前=重伤，恢复到满血 → 正常');

  var h2 = mkH2({ rules: mkRules2({ conDead: false }) });
  var m2 = addP2(h2, 's-a', '甲', 5, 12, { status: { currentHP: 5, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '轻伤' } });
  h2.applyHpChange(m2, 1, 't');
  eq(m2.sheet.status.currentHP, 6, '轻伤角色 5 → 6（恰半血）');
  ok(m2.sheet.status.body !== '重伤', '★ 改前非重伤 → 解除规则不触发，body 不得变重伤', m2.sheet.status.body);
  eq(m2.sheet.status.body, '轻伤', '恰半血仍为轻伤');

  var h3 = mkH2({ rules: mkRules2({ conDead: false }) });
  var m3 = addP2(h3, 's-a', '甲', 12, 12);
  h3.applyHpChange(m3, -6, 't');
  eq(m3.sheet.status.body, '重伤', '★ settleWounds 侧：单次打到恰半血 → 重伤（prevBody 门挡住「立即解除」）');
})();

section('QA-⑤ 天/周（1回合=1天 / 3回合=1周）：上限 / 三分支 / 探索态 / madness.advance 反例 / 存档往返');
(function () {
  var h = mkH2({});
  var m = addP2(h, 's-a', '甲', 11, 12, { status: { currentHP: 11, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '轻伤' } });
  var out0 = h.applyAction(M.HOST_SEAT, { op: 'round.next' });
  eq(m.sheet.status.currentHP, 12, '轻伤 11 → 12（每日 +1）');
  ok(hasEvt2(out0, M.EVT.ROUND), '★ round.next 发显式 ROUND 事件');
  h.applyAction(M.HOST_SEAT, { op: 'round.next' });
  eq(m.sheet.status.currentHP, 12, '★ 已满 → 不再 +1（不超上限）');

  // 反例：madness.advance 不得触发天/周
  var h2 = mkH2({});
  var m2 = addP2(h2, 's-a', '甲', 8, 12, { status: { currentHP: 8, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '轻伤' } });
  var outA = h2.advanceMadness('s-a', { op: 'madness.advance' });
  eq(m2.sheet.status.currentHP, 8, '★ madness.advance（推进1轮）不触发每日恢复（HP 不变）');
  ok(!hasEvt2(outA, M.EVT.ROUND), '★ madness.advance 不发 ROUND 事件');

  function wounded(hh) {
    return addP2(hh, 's-a', '甲', 3, 12, { status: { currentHP: 3, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤' } });
  }
  var hA = mkH2({ rules: mkRules2({ d3: 2, check: function () { return { passed: true, level: 2, value: 10 }; } }) });
  var mA = wounded(hA); hA.state.meta.round = 3; hA.state.meta.hpWeek = { 's-a': 0 };
  hA._onDayWeekTick();
  eq(mA.sheet.status.currentHP, 5, '每周 CON 成功 → +1D3(2)');
  eq(mA.sheet.status.body, '重伤', '未达半血仍重伤');
  eq(hA.state.meta.hpWeek['s-a'], 3, '周检后基准重置为当前回合');

  var hB = mkH2({ rules: mkRules2({ d3: 2, check: function () { return { passed: true, level: 4, value: 1 }; } }) });
  var mB = wounded(hB); hB.state.meta.round = 3; hB.state.meta.hpWeek = { 's-a': 0 };
  hB._onDayWeekTick();
  eq(mB.sheet.status.body, '轻伤', '每周 CON 极难成功 → 清除重伤');

  var hC = mkH2({ rules: mkRules2({ d3: 2, check: function () { return { passed: false, level: 1, value: 99 }; } }) });
  var mC = wounded(hC); hC.state.meta.round = 3; hC.state.meta.hpWeek = { 's-a': 0 };
  hC._onDayWeekTick();
  eq(mC.sheet.status.currentHP, 3, '每周 CON 失败 → 无恢复');

  var hD = mkH2({ rules: mkRules2({ d3: 2, check: function () { return { passed: true, level: 2 }; } }) });
  var mD = wounded(hD); hD.state.meta.round = 2; hD.state.meta.hpWeek = { 's-a': 0 };
  hD._onDayWeekTick();
  eq(mD.sheet.status.currentHP, 3, '未满 3 回合 → 不检定不恢复');

  var hE = mkH2({ rules: mkRules2({ d3: 2, check: function () { return { passed: true, level: 2 }; } }) });
  var mE = wounded(hE); hE.state.meta.round = 2; hE.state.meta.hpWeek = { 's-a': 10 };
  hE._onDayWeekTick();
  eq(mE.sheet.status.currentHP, 3, '基准(10)>当前回合(2) → 重新计时、不检定');
  eq(hE.state.meta.hpWeek['s-a'], 2, '基准被重置为当前回合');

  var hS = mkH2({});
  addP2(hS, 's-a', '甲', 8, 12);
  hS.state.meta.hpWeek = { 's-a': 7 };
  var save = M.parseSave(hS.savePayload());
  eq(save.meta.hpWeek['s-a'], 7, 'savePayload 携带 meta.hpWeek');
  var hS2 = M.restoreHost(hS.savePayload());
  eq(hS2.state.meta.hpWeek['s-a'], 7, 'restoreHost 恢复 meta.hpWeek');
})();

section('QA-⑥ 昏迷三入口（state.self / state.request / sheet.damage）→ 战斗槽同步 → nextTurn 跳过');
(function () {
  function combat3(hh) {
    hh.state.combat = { turn: 0, round: 1, startedAt: 0, order: [
      { id: 's-b#0', actorId: 's-b', seat: 's-b', kind: 'pc', name: '乙', public: { hp: 12, hpMax: 12 } },
      { id: 's-a#0', actorId: 's-a', seat: 's-a', kind: 'pc', name: '甲', public: { hp: 3, hpMax: 12 } },
      { id: 's-c#0', actorId: 's-c', seat: 's-c', kind: 'pc', name: '丙', public: { hp: 12, hpMax: 12 } }
    ] };
  }
  function slotA(hh) { return hh.state.combat.order.filter(function (s) { return s.id === 's-a#0'; })[0]; }

  var h1 = mkH2({});
  addP2(h1, 's-a', '甲', 3, 12); addP2(h1, 's-b', '乙', 12, 12); addP2(h1, 's-c', '丙', 12, 12);
  combat3(h1);
  // v2.10.0（R5）：state.self 传 unconscious 标记（body 白名单已收敛为 4 值）
  h1.intent('s-a', M.intentMsg(M.INTENT.ACT, { op: 'state.self', status: { unconscious: true } }));
  eq(slotA(h1).public.down, true, '① state.self 变昏迷 → 槽 pub.down=true');
  h1.applyAction(M.HOST_SEAT, { op: 'combat.next' });
  eq(h1.state.combat.turn, 2, '① nextTurn 跳过昏迷的 s-a → 槽 2');

  var h2 = mkH2({ rules: mkRules2({ conDead: false }) });
  addP2(h2, 's-a', '甲', 3, 12); addP2(h2, 's-b', '乙', 12, 12); addP2(h2, 's-c', '丙', 12, 12);
  combat3(h2);
  h2.applyAction(M.HOST_SEAT, { op: 'state.request', seat: 's-a', change: { hp: 0 }, reason: '测试' });
  var rid = (h2._requestsBySeat['s-a'] || []).slice(-1)[0].id;
  h2.intent('s-a', M.intentMsg(M.INTENT.CONSENT, { id: rid, agree: true }));
  // v2.10.0（R5）：无重伤归零 → unconscious 标记，视图合成 '昏迷'
  eq(h2.roster.get('s-a').sheet.status.unconscious, true, '② consent HP→0（无重伤）→ 昏迷（unconscious 标记）');
  eq(M.bodyView(h2.roster.get('s-a').sheet.status), '昏迷', '★（R5）bodyView 合成 = 昏迷');
  eq(slotA(h2).public.down, true, '② 槽 pub.down 同步');
  h2.applyAction(M.HOST_SEAT, { op: 'combat.next' });
  eq(h2.state.combat.turn, 2, '② nextTurn 跳过');

  var h3 = mkH2({ rules: mkRules2({ conDead: false }) });
  addP2(h3, 's-a', '甲', 3, 12); addP2(h3, 's-b', '乙', 12, 12); addP2(h3, 's-c', '丙', 12, 12);
  combat3(h3);
  h3.applyAction(M.HOST_SEAT, { op: 'sheet.damage', seat: 's-a', amount: 3 });
  // v2.10.0（R5）：无重伤归零 → unconscious 标记，视图合成 '昏迷'
  eq(h3.roster.get('s-a').sheet.status.unconscious, true, '③ sheet.damage 归零（无重伤）→ 昏迷（unconscious 标记）');
  eq(M.bodyView(h3.roster.get('s-a').sheet.status), '昏迷', '★（R5）bodyView 合成 = 昏迷');
  eq(slotA(h3).public.down, true, '③ 槽 pub.down 同步');
  h3.applyAction(M.HOST_SEAT, { op: 'combat.next' });
  eq(h3.state.combat.turn, 2, '③ nextTurn 跳过');
})();

section('QA-⑦ sheet.healwound：玩家自助不带 seat 解析自身 / KP 直接 / 归位 / HP≤0→1 / 拒绝');
(function () {
  var h = mkH2({});
  var m = addP2(h, 's-a', '甲', 3, 12, { status: { currentHP: 3, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤' } });
  var out = h.intent('s-a', M.intentMsg(M.INTENT.ACT, { op: 'sheet.healwound' }));
  ok(/等待确认/.test(planText2(out)), '玩家自助（不带 seat）→ 进 KP 待办');
  eq(m.sheet.status.body, '重伤', '未同意前状态不变');
  h.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.CONFIRM, { op: 'sheet.healwound', agree: true }));
  eq(m.sheet.status.body, '轻伤', '★ KP 同意 → 正确解析出「自己」并治愈（HP<上限→轻伤）');

  var h2 = mkH2({});
  var m2 = addP2(h2, 's-a', '甲', 12, 12, { status: { currentHP: 12, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤' } });
  h2.applyAction(M.HOST_SEAT, { op: 'sheet.healwound', seat: 's-a' });
  eq(m2.sheet.status.body, '正常', 'KP 直接治愈：HP 满 → 正常');

  // v2.10.0（R5）：濒死改由 dying 标记表达（body='重伤' + dying=true）
  var h3 = mkH2({});
  var m3 = addP2(h3, 's-a', '甲', 0, 12, { status: { currentHP: 0, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤', dying: true } });
  h3.applyAction(M.HOST_SEAT, { op: 'sheet.healwound', seat: 's-a' });
  eq(m3.sheet.status.currentHP, 1, 'HP≤0 → 置 1');
  eq(m3.sheet.status.body, '轻伤', 'body → 轻伤（HP<上限）');
  eq(m3.sheet.status.dying, false, '★（R5）治愈补丁显式清 dying 标记');

  var h4 = mkH2({});
  addP2(h4, 's-a', '甲', 3, 12, { status: { currentHP: 3, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤' } });
  addP2(h4, 's-b', '乙', 3, 12, { status: { currentHP: 3, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤' } });
  var p4 = h4.applyAction('s-a', { op: 'sheet.healwound', seat: 's-b' });
  ok(/只能申请治愈自己/.test(planText2(p4)), '玩家指定他人 → 拒绝（只能治愈自己）');

  var h5 = mkH2({});
  addP2(h5, 's-a', '甲', 0, 12, { status: { currentHP: 0, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '死亡' } });
  var p5 = h5.applyAction(M.HOST_SEAT, { op: 'sheet.healwound', seat: 's-a' });
  ok(/已撕卡/.test(planText2(p5)), '死亡（撕卡）目标 → 拒绝');

  var h6 = mkH2({});
  addP2(h6, 's-a', '甲', 12, 12);
  var p6 = h6.applyAction(M.HOST_SEAT, { op: 'sheet.healwound', seat: 's-a' });
  ok(/无需治愈/.test(planText2(p6)), '无伤势 → 明确「无需治愈」');
})();

section('QA-⑧ aid.apply：检定施救者技能（非目标 CON）/ 急救医学效果 / 失败无效果 / 非法入参');
(function () {
  function rules(skillBase) {
    return mkRules2({
      d3: 3, skills: { '急救': skillBase, '医学': skillBase },
      check: function (a) { return { passed: a.base >= 50, level: a.base >= 50 ? 2 : 1, value: 10 }; }
    });
  }
  var h1 = mkH2({ rules: rules(70) });
  addP2(h1, 's-b', '医者', 12, 12, { attrs: { con: 90, int: 50 } });
  // v2.10.0（R5）：濒死改由 dying 标记表达（body='重伤' + dying=true）
  var t1 = addP2(h1, 's-a', '伤者', 0, 12, { status: { currentHP: 0, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤', dying: true }, attrs: { con: 5, int: 50 } });
  h1.applyAction(M.HOST_SEAT, { op: 'aid.apply', seat: 's-b', targetSeat: 's-a', skill: '急救' });
  eq(t1.sheet.status.currentHP, 1, '★ 施救者技能 70（目标 CON=5）→ 急救成功 +1 HP');
  eq(t1.sheet.status.body, '重伤', '★ 濒死 → 稳定为重伤');

  var h2 = mkH2({ rules: rules(30) });
  addP2(h2, 's-b', '医者', 12, 12, { attrs: { con: 90, int: 50 } });
  // v2.10.0（R5）：濒死改由 dying 标记表达（body='重伤' + dying=true）
  var t2 = addP2(h2, 's-a', '伤者', 0, 12, { status: { currentHP: 0, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤', dying: true }, attrs: { con: 90, int: 50 } });
  var o2 = h2.applyAction(M.HOST_SEAT, { op: 'aid.apply', seat: 's-b', targetSeat: 's-a', skill: '急救' });
  eq(t2.sheet.status.currentHP, 0, '★ 施救者技能 30（目标 CON=90）→ 失败，HP 不变');
  ok(/没有效果/.test(planText2(o2)), '失败给明确提示「没有效果」');

  var h3 = mkH2({ rules: rules(70) });
  addP2(h3, 's-b', '医者', 12, 12);
  // v2.10.0（R5）：濒死改由 dying 标记表达（body='重伤' + dying=true）
  var t3 = addP2(h3, 's-a', '伤者', 0, 12, { status: { currentHP: 0, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤', dying: true } });
  h3.applyAction(M.HOST_SEAT, { op: 'aid.apply', seat: 's-b', targetSeat: 's-a', skill: '医学' });
  eq(t3.sheet.status.currentHP, 3, '医学成功 → +1D3(3)');
  eq(t3.sheet.status.body, '重伤', '医学成功且濒死 → 脱离濒死（重伤）');

  /* ---- F3（team-lead 裁定）· QA Edward 口径：急救/医学成功一并唤醒「昏迷」 ---- */
  // ① 昏迷 且 HP=0 + 急救成功 → 先置 1、body 轻伤、战斗槽 down 复位（恢复行动）
  var h4 = mkH2({ rules: rules(70) });
  addP2(h4, 's-b', '医者', 12, 12);
  // v2.10.0（R5）：昏迷改由 unconscious 标记表达
  var t4 = addP2(h4, 's-a', '昏者', 0, 12, { status: { currentHP: 0, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '正常', unconscious: true } });
  h4.state.combat = { turn: 0, round: 1, startedAt: 0, order: [
    { id: 's-a#0', actorId: 's-a', seat: 's-a', kind: 'pc', name: '昏者', public: { hp: 0, hpMax: 12, down: true, state: 'unconscious' } }
  ] };
  h4.applyAction(M.HOST_SEAT, { op: 'aid.apply', seat: 's-b', targetSeat: 's-a', skill: '急救' });
  eq(t4.sheet.status.currentHP, 1, '★ F3：昏迷且 HP≤0 → 急救先置 1');
  eq(t4.sheet.status.body, '轻伤', '★ F3：急救成功唤醒昏迷（HP<上限 → 轻伤）');
  eq(h4.state.combat.order[0].public.down, false, '★ F3：唤醒后战斗槽 down 复位（恢复行动）');

  // ② 昏迷 且 HP>0 + 医学成功 → +1D3 且唤醒
  var h4b = mkH2({ rules: rules(70) });
  addP2(h4b, 's-b', '医者', 12, 12);
  // v2.10.0（R5）：昏迷改由 unconscious 标记表达
  var t4b = addP2(h4b, 's-a', '昏者', 3, 12, { status: { currentHP: 3, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '正常', unconscious: true } });
  h4b.applyAction(M.HOST_SEAT, { op: 'aid.apply', seat: 's-b', targetSeat: 's-a', skill: '医学' });
  eq(t4b.sheet.status.currentHP, 6, '★ F3：昏迷 HP>0 → 医学 +1D3(3)');
  eq(t4b.sheet.status.body, '轻伤', '★ F3：医学成功唤醒昏迷');

  // ③ 唤醒后 HP ≥ 上限 → body 正常
  var h4c = mkH2({ rules: rules(70) });
  addP2(h4c, 's-b', '医者', 12, 12);
  // v2.10.0（R5）：昏迷改由 unconscious 标记表达
  var t4c = addP2(h4c, 's-a', '昏者', 2, 3, { status: { currentHP: 2, maxHP: 3, currentSAN: 50, maxSAN: 50, body: '正常', unconscious: true } });
  h4c.applyAction(M.HOST_SEAT, { op: 'aid.apply', seat: 's-b', targetSeat: 's-a', skill: '医学' });
  eq(t4c.sheet.status.currentHP, 3, 'F3：唤醒并回满 HP');
  eq(t4c.sheet.status.body, '正常', '★ F3：唤醒后 HP≥上限 → 正常');

  // ④ 反例：检定失败 → 不唤醒、不置 HP
  var h4d = mkH2({ rules: rules(30) });
  addP2(h4d, 's-b', '医者', 12, 12);
  // v2.10.0（R5）：昏迷改由 unconscious 标记表达
  var t4d = addP2(h4d, 's-a', '昏者', 0, 12, { status: { currentHP: 0, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '正常', unconscious: true } });
  h4d.applyAction(M.HOST_SEAT, { op: 'aid.apply', seat: 's-b', targetSeat: 's-a', skill: '急救' });
  // v2.10.0（R5）：失败 → 不唤醒（unconscious 标记仍在，body 保持改前伤级）
  eq(t4d.sheet.status.unconscious, true, '★ F3 反例：检定失败 → 不唤醒（仍昏迷）');
  eq(t4d.sheet.status.body, '正常', '★（R5）body 保持改前伤级（正常）');
  eq(t4d.sheet.status.currentHP, 0, '★ F3 反例：失败不置 HP');

  var h5 = mkH2({ rules: rules(70) });
  addP2(h5, 's-a', '甲', 5, 12);
  ok(/找不到施救者/.test(planText2(h5.applyAction(M.HOST_SEAT, { op: 'aid.apply', seat: 'ghost', targetSeat: 's-a', skill: '急救' }))), '非法施救者 → 拒绝');
  ok(/找不到施救目标/.test(planText2(h5.applyAction(M.HOST_SEAT, { op: 'aid.apply', seat: 's-a', targetSeat: 'nobody', skill: '急救' }))), '非法目标 → 拒绝');
  ok(/急救|医学/.test(planText2(h5.applyAction(M.HOST_SEAT, { op: 'aid.apply', seat: 's-a', targetSeat: 's-a', skill: '射击' }))), '非法技能 → 拒绝');
})();

section('QA-⑨ sceneCheckStep 收口：非致命重伤伤害也走完整判定（不是只扣数字）');
(function () {
  var h = mkH2({ rules: mkRules2({ conDead: false, sceneDamage: '6' }) });
  var m = addP2(h, 's-a', '甲', 12, 12);
  h.state.sceneCheck = { id: 'sc1', title: '陷阱', cursor: 0, results: [], at: 1,
    steps: [{ id: 'st1', title: '陷阱', skill: '侦查', targetSeat: 's-a', difficulty: 'regular' }] };
  h.applyAction(M.HOST_SEAT, { op: 'scene.check.step', stepId: 'st1', seat: 's-a', level: 1 });
  eq(m.sheet.status.currentHP, 6, '场景检定失败扣 6 HP（12→6）');
  eq(m.sheet.status.body, '重伤', '★ 恰半血伤害 → 重伤（走完整判定，而非仅扣数字）');
})();

section('QA-⑩ _advanceRound 生成的计划确实带发送目标（不是只进日志）');
(function () {
  var h = mkH2({});
  addP2(h, 's-a', '甲', 8, 12, { status: { currentHP: 8, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '轻伤' } });
  var out = h._advanceRound([], 5);
  ok(out.length > 0, '_advanceRound 返回非空计划');
  ok(out.every(function (x) { return x && x.to !== undefined && x.msg !== undefined; }),
     '★ 每一条都是 {to, msg} 发送计划（不是裸事件记录）', JSON.stringify(out.slice(0, 1)));
  ok(out.some(function (x) { return x.msg.t === M.EVT.ROUND; }), '★ 含 ROUND 事件且带发送目标');
  ok(out.some(function (x) { return x.msg.t === M.EVT.STATE; }), '★ 每日 +1HP 的 STATE 事件也进了计划（可发到玩家端）');
})();

section('QA-⑪ 结构守卫：新方法唯一 / 既有函数共存 / slotDown 未被改 / app.css 零改动证据');
(function () {
  var model = readSrc('core/room-model.js');
  var clean = stripComments(model);
  function cnt(re) { return (clean.match(re) || []).length; }
  ['applyHpChange', 'settleWounds', '_syncBodyToCombatSlot', '_isUnconscious', 'healWound', 'aidApply', '_advanceRound', '_onDayWeekTick'].forEach(function (fn) {
    eq(cnt(new RegExp('Host\\.prototype\\.' + fn + ' = function', 'g')), 1, '新方法 ' + fn + ' 唯一定义');
  });
  ['nextTurn', 'sceneCheckStep', 'stateApply', 'advanceMadness', 'stateSelf', 'stateRequest'].forEach(function (fn) {
    eq(cnt(new RegExp('Host\\.prototype\\.' + fn + ' = function', 'g')), 1, '既有函数 ' + fn + ' 仍在且唯一（防互相覆盖）');
  });
  var sd = qaFnSrc(clean, 'slotDown');
  ok(/function slotDown\(slot\)/.test(sd), 'slotDown 签名 = (slot) 未变');
  ok(sd.indexOf('body') < 0 && sd.indexOf('status') < 0, '★ slotDown 仍只读战斗槽（未引入 body/status 判据，真值表签名未破）');

  var css = fs.readFileSync('web/css/app.css', 'utf8');
  ok(css.indexOf('v2.8.0') < 0, 'app.css 无 v2.8.0 新增块');
  eq((css.match(/{/g) || []).length, (css.match(/}/g) || []).length, 'app.css 花括号配平');
  ok((css.match(/\.gp-grid/g) || []).length > 0, 'app.css 既有 .gp-grid 规则仍在');
  /* v2.9.0（说明 · software-engineer / 寇豆码）：本轮**确实**改动了 app.css（回退 UI 的
     .rewind-card 被移除）→ 原「本轮未触碰 CSS」的一次性 mtime 证据断言退役，改断该清理已落地。 */
  ok(css.indexOf('.rewind-card') < 0, '★（v2.9.0）app.css 已移除回退 UI 的 .rewind-card（mtime 证据断言退役）');
})();


/* ============================================================
 * ★ QA Round-2 独立复核 · Edward —— 复核 F1 / F2 / F3 三处修复
 *   （以我自己的口径独立重写，不复用工程师 R2 小节的写法）
 * ============================================================ */

section('QA-⑫ F2 · 状态管理改 HP 现走统一口径（重伤 / 解除 / 归零 / 濒死回血 / 同改 maxHP）');
(function () {
  var h1 = mkH2({ rules: mkRules2({ conDead: false }) });
  var m1 = addP2(h1, 's-a', '甲', 12, 12);
  var o1 = h1.applyAction(M.HOST_SEAT, { op: 'state.self', seat: 's-a', status: { currentHP: 6 } });
  eq(m1.sheet.status.body, '重伤', '★ state.self 12→6（恰半血）→ 重伤');
  ok(hasEvt2(o1, M.EVT.DICE), '★ 重伤瞬间掷了「避免昏迷」CON');

  var h1b = mkH2({ rules: mkRules2({ conDead: true }) });
  var m1b = addP2(h1b, 's-a', '甲', 12, 12);
  h1b.applyAction(M.HOST_SEAT, { op: 'state.self', seat: 's-a', status: { currentHP: 6 } });
  // v2.10.0（R5）：CON 失败置 unconscious 标记（body 保持 '重伤'），视图合成 '昏迷'
  eq(m1b.sheet.status.unconscious, true, '★ state.self 打成重伤且 CON 失败 → 昏迷（unconscious 标记）');
  eq(m1b.sheet.status.body, '重伤', '★（R5）body 保持重伤伤级');
  eq(M.bodyView(m1b.sheet.status), '昏迷', '★（R5）bodyView 合成 = 昏迷');

  var h1c = mkH2({ rules: mkRules2({ conDead: false }) });
  var m1c = addP2(h1c, 's-a', '甲', 12, 12);
  h1c.applyAction(M.HOST_SEAT, { op: 'state.self', seat: 's-a', status: { currentHP: 8 } });
  eq(m1c.sheet.status.body, '轻伤', 'state.self 12→8（未达半血）→ 轻伤');

  var h1d = mkH2({ rules: mkRules2({ conDead: false }) });
  var m1d = addP2(h1d, 's-a', '甲', 3, 12, { status: { currentHP: 3, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤' } });
  h1d.applyAction(M.HOST_SEAT, { op: 'state.self', seat: 's-a', status: { currentHP: 8 } });
  eq(m1d.sheet.status.body, '轻伤', '★ state.self 重伤 3→8（≥半血）→ 解除重伤');

  // v2.10.0（R5）：昏迷改由 unconscious 标记表达
  var h1e = mkH2({ rules: mkRules2({ conDead: false }) });
  var m1e = addP2(h1e, 's-a', '甲', 0, 12, { status: { currentHP: 0, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '正常', unconscious: true } });
  h1e.applyAction(M.HOST_SEAT, { op: 'state.self', seat: 's-a', status: { currentHP: 5 } });
  // v2.10.0（R5）：回血不唤醒（unconscious 标记仍在，body 保持改前伤级）
  eq(m1e.sheet.status.unconscious, true, '★ 昏迷回血 → 仍昏迷（唤醒由急救/治愈负责）');
  eq(m1e.sheet.status.body, '正常', '★（R5）body 保持改前伤级（正常）');
  eq(M.bodyView(m1e.sheet.status), '昏迷', '★（R5）bodyView 合成 = 昏迷');

  // v2.10.0（R5）：濒死改由 dying 标记表达（body='重伤' + dying=true）
  var h1f = mkH2({ rules: mkRules2({ conDead: false }) });
  var m1f = addP2(h1f, 's-a', '甲', 0, 12, { status: { currentHP: 0, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤', dying: true } });
  h1f.applyAction(M.HOST_SEAT, { op: 'state.self', seat: 's-a', status: { currentHP: 4 } });
  eq(m1f.sheet.status.body, '重伤', '★ 濒死 0→4（未达半血）→ 回到重伤');

  var h1g = mkH2({ rules: mkRules2({ conDead: false }) });
  var m1g = addP2(h1g, 's-a', '甲', 12, 12);
  h1g.applyAction(M.HOST_SEAT, { op: 'state.self', seat: 's-a', status: { body: '轻伤' } });
  eq(m1g.sheet.status.body, '轻伤', '★ 仅改 body（HP 不变）→ 不被 HP 判定覆盖（显式选择保留）');
  eq(m1g.sheet.status.currentHP, 12, 'HP 不变');

  var h1h = mkH2({ rules: mkRules2({ conDead: false }) });
  var m1h = addP2(h1h, 's-a', '甲', 12, 12);
  h1h.applyAction(M.HOST_SEAT, { op: 'state.self', seat: 's-a', status: { currentHP: 6, maxHP: 10 } });
  eq(m1h.sheet.status.body, '重伤', '★ 同改 maxHP(→10)：6×2=12 ≥ 10 → 用改后有效上限判重伤');

  var h2 = mkH2({ rules: mkRules2({ conDead: false }) });
  var m2 = addP2(h2, 's-a', '甲', 12, 12);
  h2.applyAction(M.HOST_SEAT, { op: 'state.request', seat: 's-a', change: { hp: 6 }, reason: '测试' });
  var rid = (h2._requestsBySeat['s-a'] || []).slice(-1)[0].id;
  h2.intent('s-a', M.intentMsg(M.INTENT.CONSENT, { id: rid, agree: true }));
  eq(m2.sheet.status.body, '重伤', '★ state.request 12→6（KP 请求 + 玩家同意）→ 重伤');

  var h3 = mkH2({ rules: mkRules2({ conDead: false }) });
  var m3 = addP2(h3, 's-a', '甲', 3, 12);
  h3.applyAction(M.HOST_SEAT, { op: 'state.self', seat: 's-a', status: { currentHP: 0 } });
  // v2.10.0（R5）：无重伤归零 → unconscious 标记，视图合成 '昏迷'
  eq(m3.sheet.status.unconscious, true, '回归：state.self HP→0（无重伤）→ 昏迷（unconscious 标记）');
  eq(M.bodyView(m3.sheet.status), '昏迷', '★（R5）bodyView 合成 = 昏迷');
  var h3b = mkH2({ rules: mkRules2({ conDead: false }) });
  var m3b = addP2(h3b, 's-a', '甲', 6, 12);
  h3b.applyAction(M.HOST_SEAT, { op: 'state.self', seat: 's-a', status: { currentHP: 0 } });
  // v2.10.0（R5）：有重伤归零 → body='重伤' + dying=true，视图合成 '濒死'
  eq(m3b.sheet.status.body, '重伤', '回归：state.self HP→0（有重伤）→ 濒死（R5：body=重伤 + dying=true）');
  eq(m3b.sheet.status.dying, true, '★（R5）dying 标记置位');
  eq(M.bodyView(m3b.sheet.status), '濒死', '★（R5）bodyView 合成 = 濒死');

  // state.request 同两条（KP 请求 + 玩家同意）：重伤回血≥半血 → 解除
  var h4 = mkH2({ rules: mkRules2({ conDead: false }) });
  var m4 = addP2(h4, 's-a', '甲', 3, 12, { status: { currentHP: 3, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤' } });
  h4.applyAction(M.HOST_SEAT, { op: 'state.request', seat: 's-a', change: { hp: 8 }, reason: '治疗' });
  var rid4 = (h4._requestsBySeat['s-a'] || []).slice(-1)[0].id;
  h4.intent('s-a', M.intentMsg(M.INTENT.CONSENT, { id: rid4, agree: true }));
  eq(m4.sheet.status.body, '轻伤', '★ state.request 重伤 3→8（≥半血）→ 解除重伤');
})();

section('QA-⑬ F1 · 战斗开始前已昏迷/濒死的 PC 一入队即被跳过（combatStart / combatEnqueue）');
(function () {
  var h = mkH2({});
  // v2.10.0（R5）：昏迷改由 unconscious 标记表达
  addP2(h, 's-a', '甲', 0, 12, { status: { currentHP: 0, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '正常', unconscious: true } });
  addP2(h, 's-b', '乙', 12, 12);
  addP2(h, 's-c', '丙', 12, 12);
  h.applyAction(M.HOST_SEAT, { op: 'combat.start', actors: [
    { id: 'p1', name: '甲', kind: 'pc', seat: 's-a', dex: 60, hp: 0, hpMax: 12 },
    { id: 'p2', name: '乙', kind: 'pc', seat: 's-b', dex: 50, hp: 12, hpMax: 12 },
    { id: 'p3', name: '丙', kind: 'pc', seat: 's-c', dex: 40, hp: 12, hpMax: 12 }
  ] });
  var a = (h.state.combat.order || []).filter(function (s) { return s.seat === 's-a'; })[0];
  eq(a.public.down, true, '★ combatStart：战斗前昏迷的 PC 入队即 down=true');
  eq(a.public.state, 'unconscious', '★ 槽 state 标为 unconscious');
  h.state.combat.turn = h.state.combat.order.length - 1;
  h.applyAction(M.HOST_SEAT, { op: 'combat.next' });
  var cur = h.state.combat.order[h.state.combat.turn];
  ok(!cur || cur.seat !== 's-a', '★ nextTurn 不停在昏迷 PC 上', cur && cur.seat);

  var h2 = mkH2({});
  // v2.10.0（R5）：濒死改由 dying 标记表达（body='重伤' + dying=true）
  addP2(h2, 's-a', '甲', 0, 12, { status: { currentHP: 0, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤', dying: true } });
  addP2(h2, 's-b', '乙', 12, 12);
  h2.state.combat = { turn: 0, round: 1, startedAt: 0, order: [
    { id: 'p-s-b', actorId: 'p-s-b', seat: 's-b', kind: 'pc', name: '乙', public: { hp: 12, hpMax: 12, down: false } }
  ] };
  h2.applyAction(M.HOST_SEAT, { op: 'combat.enqueue', seat: 's-a' });
  var b = (h2.state.combat.order || []).filter(function (s) { return s.seat === 's-a'; })[0];
  ok(!!b, 'combatEnqueue 把 s-a 加入了行动序');
  eq(b.public.down, true, '★ combatEnqueue：濒死的 PC 入队即 down=true');
})();

section('QA-⑭ R2 结构守卫 · deriveBodyFromHp 唯一口径 + 新 helper 唯一 + 无重复定义');
(function () {
  var model = readSrc('core/room-model.js');
  var clean = stripComments(model);
  function cnt(re) { return (clean.match(re) || []).length; }
  eq(cnt(/function deriveBodyFromHp\(/g), 1, 'deriveBodyFromHp 唯一定义（模块级）');
  eq(cnt(/deriveBodyFromHp\(/g), 4, '★ deriveBodyFromHp 恰 1 定义 + 3 调用（settleWounds/applyHpChange/applyStatusJudgment 共用）');
  eq(cnt(/Host\.prototype\._stampSlotBody = function/g), 1, '_stampSlotBody 唯一定义');
  eq(cnt(/Host\.prototype\._stampAllPcSlots = function/g), 1, '_stampAllPcSlots 唯一定义');
  eq(cnt(/_stampAllPcSlots\(\)/g), 2, '★ _stampAllPcSlots 调用 2 处（combatStart / combatEnqueue）');
  ['applyHpChange', 'settleWounds', '_syncBodyToCombatSlot', '_isUnconscious', 'healWound', 'aidApply', '_advanceRound', '_onDayWeekTick'].forEach(function (fn) {
    eq(cnt(new RegExp('Host\\.prototype\\.' + fn + ' = function', 'g')), 1, fn + ' 仍唯一定义（R2 未引入重复）');
  });
  var sd = qaFnSrc(clean, 'slotDown');
  ok(sd.indexOf('body') < 0 && sd.indexOf('status') < 0, '★ R2 后 slotDown 仍只读战斗槽（判活真值表签名未破）');
})();

section('QA-⑮ R2 不变量与降级防护（濒死/昏迷不被降级 + 唤醒后能被重新轮到 + 无自相矛盾状态）');
(function () {
  // A) 已濒死/已昏迷 不被「非重伤伤害」降级（settleWounds）
  // v2.10.0（R5）：濒死改由 dying 标记表达（body='重伤' + dying=true）
  var hA = mkH2({ rules: mkRules2({ conDead: false }) });
  var mA = addP2(hA, 's-a', '甲', 0, 12, { status: { currentHP: 0, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤', dying: true } });
  hA.applyHpChange(mA, -2, '小伤');
  // v2.10.0（R5）：不降级 = body 仍 '重伤' + dying 仍在（视图仍 '濒死'）
  eq(mA.sheet.status.body, '重伤', '★ 已濒死 + 非重伤伤害 → 仍濒死（不降级；R5：body=重伤 + dying=true）');
  eq(mA.sheet.status.dying, true, '★（R5）dying 标记仍在');
  eq(M.bodyView(mA.sheet.status), '濒死', '★（R5）bodyView 合成 = 濒死');

  // v2.10.0（R5）：昏迷改由 unconscious 标记表达
  var hB = mkH2({ rules: mkRules2({ conDead: false }) });
  var mB = addP2(hB, 's-a', '甲', 0, 12, { status: { currentHP: 0, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '正常', unconscious: true } });
  hB.applyHpChange(mB, -2, '小伤');
  // v2.10.0（R5）：不降级 = unconscious 标记仍在（视图仍 '昏迷'）
  eq(mB.sheet.status.unconscious, true, '★ 已昏迷 + 非重伤伤害 → 仍昏迷（不降级）');
  eq(M.bodyView(mB.sheet.status), '昏迷', '★（R5）bodyView 合成 = 昏迷');

  // B) F3 唤醒后 nextTurn 能重新轮到该 PC（真正做到「恢复行动」）
  var hC = mkH2({ rules: mkRules2({ d3: 3, skills: { '急救': 70, '医学': 70 }, check: function () { return { passed: true, level: 2, value: 10 }; } }) });
  addP2(hC, 's-b', '医者', 12, 12);
  // v2.10.0（R5）：昏迷改由 unconscious 标记表达
  var tC = addP2(hC, 's-a', '昏者', 0, 12, { status: { currentHP: 0, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '正常', unconscious: true } });
  hC.state.combat = { turn: 1, round: 1, startedAt: 0, order: [
    { id: 'p-s-a', actorId: 'p-s-a', seat: 's-a', kind: 'pc', name: '昏者', public: { hp: 0, hpMax: 12, down: true, state: 'unconscious' } },
    { id: 'p-s-b', actorId: 'p-s-b', seat: 's-b', kind: 'pc', name: '医者', public: { hp: 12, hpMax: 12, down: false } }
  ] };
  hC.applyAction(M.HOST_SEAT, { op: 'aid.apply', seat: 's-b', targetSeat: 's-a', skill: '急救' });
  // v2.10.0（R5）：唤醒 = unconscious 标记清除 + body 按 HP 归位
  eq(tC.sheet.status.unconscious, false, '前置：昏迷已被急救唤醒（unconscious 标记已清）');
  eq(tC.sheet.status.body, '轻伤', '前置：body 归位轻伤');
  var slotA = (hC.state.combat.order || []).filter(function (s) { return s.seat === 's-a'; })[0];
  eq(slotA.public.down, false, '唤醒后槽 down=false');
  hC.applyAction(M.HOST_SEAT, { op: 'combat.next' });
  var curC = hC.state.combat.order[hC.state.combat.turn];
  eq(curC && curC.seat, 's-a', '★ 唤醒后 nextTurn 能重新轮到该 PC（不再被跳过）');

  // C) F2 状态管理各路径：状态结果正确 + 无「醒着却昏迷」「正常却 HP≤0」自相矛盾
  // v2.10.0（R5）：wantBody 改为**合成视图**期望（bodyView：死亡 > dying > unconscious > body）；
  //   body 只表伤级（4 值），昏迷/濒死由标记表达，不变量判据同步改读视图。
  var cases = [
    { from: 12, set: 6, wantView: '重伤' },
    { from: 12, set: 8, wantView: '轻伤' },
    { from: 3, set: 0, wantView: '昏迷' },
    { from: 12, set: 0, wantView: '濒死' }
  ];
  cases.forEach(function (c) {
    var hh = mkH2({ rules: mkRules2({ conDead: false }) });
    var mm = addP2(hh, 's-a', '甲', c.from, 12, { status: { currentHP: c.from, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '正常' } });
    hh.applyAction(M.HOST_SEAT, { op: 'state.self', seat: 's-a', status: { currentHP: c.set } });
    eq(M.bodyView(mm.sheet.status), c.wantView, 'state.self ' + c.from + '→' + c.set + ' → ' + c.wantView);
    var hp = mm.sheet.status.currentHP, vw = M.bodyView(mm.sheet.status);
    ok(!(vw === '昏迷' && hp > 0) && !(vw === '正常' && hp <= 0),
       '★ 不变量：无「醒着却昏迷」/「正常却 HP≤0」(' + vw + '/' + hp + ')');
  });
})();


/* ============================================================
 * v2.10.0（R5 / R4）新增小节（模型层）—— software-engineer（寇豆码）
 *   R5：身体状态三键模型（body 4 值 + dying/unconscious 布尔 + bodyView 视图合成）
 *   R4：私密事件不再泄漏进 KP 栏目（reduce 的 EVT.PRIVATE 守卫）
 * ============================================================ */

section('模型-R5 · 老卡一次性迁移（migrateBodyStatus：濒死/昏迷 → 三键模型；幂等；两挂载点）');
(function () {
  /* ① body='濒死' → body='重伤' + dying=true（幂等：跑两遍不漂移） */
  var st1 = M.migrateBodyStatus({ body: '濒死', currentHP: 2, maxHP: 12 });
  eq(st1.body, '重伤', '老卡 body=濒死 → body=重伤');
  eq(st1.dying, true, '老卡 body=濒死 → dying=true');
  eq(M.bodyView(st1), '濒死', '迁移后 bodyView = 濒死');
  var st1b = M.migrateBodyStatus(st1);
  eq(st1b.body, '重伤', '★ 迁移跑两遍不漂移（body 仍重伤）');
  eq(st1b.dying, true, '★ 迁移跑两遍不漂移（dying 仍 true）');
  eq(M.bodyView(st1b), '濒死', '★ 幂等：视图仍濒死');

  /* ② body='昏迷' → unconscious=true + body 按 HP 归位（bodyForHp） */
  var st2 = M.migrateBodyStatus({ body: '昏迷', currentHP: 7, maxHP: 12 });
  eq(st2.unconscious, true, '老卡 body=昏迷 → unconscious=true');
  eq(st2.body, '重伤', 'HP 7 ≥ 半血 6 → bodyForHp 保守落重伤');
  eq(M.bodyView(st2), '昏迷', '迁移后 bodyView = 昏迷');
  var st2b = M.migrateBodyStatus({ body: '昏迷', currentHP: 1, maxHP: 12 });
  eq(st2b.body, '轻伤', 'HP 1 < 半血 → 轻伤');
  var st2c = M.migrateBodyStatus({ body: '昏迷' });
  eq(st2c.body, '轻伤', '★ 取不到 HP 时保守落轻伤');
  var st2d = M.migrateBodyStatus({ body: '昏迷', currentHP: 12, maxHP: 12 });
  eq(st2d.body, '正常', 'HP 满 → 正常');
  var st2e = M.migrateBodyStatus(st2);
  eq(st2e.unconscious, true, '★ 昏迷迁移亦幂等（unconscious 仍 true）');

  /* ③ 新模型取值原样返回（不动）+ null 安全 */
  var st3 = M.migrateBodyStatus({ body: '轻伤', dying: false, unconscious: false });
  eq(st3.body, '轻伤', '新模型取值原样返回');
  eq(M.migrateBodyStatus(null), null, 'null 安全');

  /* ④ 挂载点 1：sanitizeStatus 出口（覆盖 INTENT.CHAR 上报） */
  var h = mkH2({});
  addP2(h, 's-a', '甲', 3, 12, { status: { currentHP: 3, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '正常' } });
  h.intent('s-a', M.intentMsg(M.INTENT.CHAR, {
    id: 'c-s-a', name: '甲',
    sheet: { status: { currentHP: 3, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '濒死' }, attrs: { con: 50, int: 50 } }
  }));
  var mem = h.roster.get('s-a');
  eq(mem.sheet.status.body, '重伤', 'CHAR 上报老卡 body=濒死 → sanitizeStatus 迁移为重伤');
  eq(mem.sheet.status.dying, true, 'CHAR 上报迁移后 dying=true');
  eq(M.bodyView(mem.sheet.status), '濒死', '★ 上报后 bodyView = 濒死（伤势不丢）');

  /* ⑤ 挂载点 2：adoptSave 老存档续玩（该循环不经过 sanitizeSheet，必须显式迁移） */
  var h2 = mkH2({});
  addP2(h2, 's-a', '甲', 0, 12, { status: { currentHP: 0, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '正常', unconscious: true } });
  var save = M.parseSave(h2.savePayload());
  save.members.forEach(function (m) {
    if (m.sheet && m.sheet.status) { m.sheet.status.body = '濒死'; delete m.sheet.status.dying; }
  });
  var h3 = M.restoreHost(JSON.stringify(save));
  var m3 = h3.roster.get('s-a');
  eq(m3.sheet.status.body, '重伤', 'adoptSave 老存档 body=濒死 → 重伤');
  eq(m3.sheet.status.dying, true, 'adoptSave 老存档迁移后 dying=true');
  eq(M.bodyView(m3.sheet.status), '濒死', '★ 老存档续玩 bodyView = 濒死');
})();

section('模型-R5 · 三态并存与 bodyView 优先级（死亡 > dying > unconscious > body）');
(function () {
  eq(M.bodyView({ body: '重伤', dying: true, unconscious: true }), '濒死',
     '★ 三态并存 {body:重伤,dying,unconscious} → 濒死（dying 优先于 unconscious）');
  eq(M.bodyView({ body: '轻伤', unconscious: true }), '昏迷', '轻伤 + unconscious → 昏迷');
  eq(M.bodyView({ body: '重伤', dying: true }), '濒死', '重伤 + dying → 濒死');
  eq(M.bodyView({ body: '死亡', dying: true, unconscious: true }), '死亡', '★ 死亡优先于一切标记');
  eq(M.bodyView({ body: '重伤' }), '重伤', '纯重伤 → 重伤');
  eq(M.bodyView({ body: '轻伤' }), '轻伤', '纯轻伤 → 轻伤');
  eq(M.bodyView({}), '正常', '空 status → 正常（兜底）');
  eq(M.bodyView(null), '正常', 'null → 正常（兜底）');
  eq(M.bodyView({ body: '濒死' }), '濒死', '老卡原始值透传（兼容，见 migrateBodyStatus）');
  eq(M.bodyView({ body: '昏迷' }), '昏迷', '老卡原始值透传（兼容）');
  /* 真实流：重伤 + 昏迷 再受重伤 → #2 分支，unconscious 保持改前值（仍昏迷） */
  var h = mkH2({ rules: mkRules2({ conDead: false }) });
  var m = addP2(h, 's-a', '甲', 12, 12, { status: { currentHP: 12, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤', unconscious: true } });
  h.applyHpChange(m, -6, 't');
  eq(m.sheet.status.body, '重伤', '★ 重伤+昏迷 再受重伤 → body 仍重伤');
  eq(m.sheet.status.unconscious, true, '★ unconscious 保持改前值（仍昏迷）');
  eq(M.bodyView(m.sheet.status), '昏迷', '★ 视图仍昏迷');
})();

section('模型-R5 · deriveBodyFromHp 七条判定语义 #1~#7（经 applyHpChange 行为级逐条验证）');
(function () {
  /* #1 即死：amount > maxHP → {body:死亡, dying:false, unconscious:false} */
  var h1 = mkH2({ rules: mkRules2({ conDead: true }) });
  var m1 = addP2(h1, 's-a', '甲', 12, 12, { status: { currentHP: 12, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤', dying: true, unconscious: true } });
  h1.applyHpChange(m1, -13, 't');
  eq(m1.sheet.status.body, '死亡', '★ #1 即死（13 > 上限 12）→ body=死亡');
  eq(m1.sheet.status.dying, false, '★ #1 死亡同时清 dying');
  eq(m1.sheet.status.unconscious, false, '★ #1 死亡同时清 unconscious');
  eq(M.bodyView(m1.sheet.status), '死亡', '★ #1 视图 = 死亡');

  /* #2 重伤：amount*2>=maxHP 且 after>0 → body=重伤；unconscious 保持改前值 */
  var h2 = mkH2({ rules: mkRules2({ conDead: false }) });
  var m2 = addP2(h2, 's-a', '甲', 12, 12, { status: { currentHP: 12, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤', unconscious: true } });
  h2.applyHpChange(m2, -6, 't');
  eq(m2.sheet.status.body, '重伤', '★ #2 再受重伤（after=6>0）→ body 仍重伤');
  eq(m2.sheet.status.dying, false, '★ #2 dying=false');
  eq(m2.sheet.status.unconscious, true, '★ #2 unconscious 保持改前值（重伤致昏后再受重伤仍昏迷）');
  eq(M.bodyView(m2.sheet.status), '昏迷', '★ #2 视图仍昏迷');

  /* #3 归零分流：有重伤（本次或改前）→ 重伤+dying；无重伤 → unconscious（body 保持改前伤级） */
  var h3 = mkH2({ rules: mkRules2({ conDead: false }) });
  var m3 = addP2(h3, 's-a', '甲', 6, 12);
  h3.applyHpChange(m3, -6, 't');
  eq(m3.sheet.status.body, '重伤', '★ #3 本次构成重伤且归零 → body=重伤');
  eq(m3.sheet.status.dying, true, '★ #3 → dying=true');
  ok(!m3.sheet.status.unconscious, '★ #3 未掷 CON → unconscious 不动');
  var h3b = mkH2({ rules: mkRules2({ conDead: false }) });
  var m3b = addP2(h3b, 's-a', '甲', 3, 12);
  h3b.applyHpChange(m3b, -3, 't');
  eq(m3b.sheet.status.unconscious, true, '★ #3 无重伤归零 → unconscious=true');
  eq(m3b.sheet.status.body, '正常', '★ #3 body 保持改前伤级（正常）');
  var h3c = mkH2({ rules: mkRules2({ conDead: false }) });
  var m3c = addP2(h3c, 's-a', '甲', 1, 12, { status: { currentHP: 1, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤' } });
  h3c.applyHpChange(m3c, -1, 't');
  eq(m3c.sheet.status.dying, true, '★ #3 改前重伤 + 非重伤伤害归零 → dying=true（改前重伤也算）');
  eq(m3c.sheet.status.body, '重伤', '★ #3 改前重伤归零 → body=重伤');

  /* #4 重伤瞬间 CON 失败 → 调用方置 unconscious=true（body 仍重伤） */
  var h4 = mkH2({ rules: mkRules2({ conDead: true }) });
  var m4 = addP2(h4, 's-a', '甲', 12, 12);
  h4.applyHpChange(m4, -6, 't');
  eq(m4.sheet.status.unconscious, true, '★ #4 重伤瞬间 CON 失败 → unconscious=true');
  eq(m4.sheet.status.body, '重伤', '★ #4 body 保持重伤（不再写成 body=昏迷）');

  /* #5 改前濒死 且 after>0 → dying=false；body 按 HP 归位 */
  var h5 = mkH2({ rules: mkRules2({ conDead: false }) });
  var m5 = addP2(h5, 's-a', '甲', 0, 12, { status: { currentHP: 0, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤', dying: true } });
  h5.applyHpChange(m5, 4, 't');
  eq(m5.sheet.status.dying, false, '★ #5 脱离濒死 → dying=false');
  eq(m5.sheet.status.body, '重伤', '★ #5 after=4 < 半血 → body=重伤');
  var h5b = mkH2({ rules: mkRules2({ conDead: false }) });
  var m5b = addP2(h5b, 's-a', '甲', 0, 12, { status: { currentHP: 0, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤', dying: true } });
  h5b.applyHpChange(m5b, 7, 't');
  eq(m5b.sheet.status.body, '轻伤', '★ #5 after=7 ≥ 半血 → 轻伤');
  var h5c = mkH2({ rules: mkRules2({ conDead: false }) });
  var m5c = addP2(h5c, 's-a', '甲', 0, 12, { status: { currentHP: 0, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤', dying: true } });
  h5c.applyHpChange(m5c, 12, 't');
  eq(m5c.sheet.status.body, '正常', '★ #5 回满 → 正常');

  /* #6 改前重伤 且 after≥半血 → body=正常/轻伤，dying=false，unconscious 不动 */
  var h6 = mkH2({ rules: mkRules2({ conDead: false }) });
  var m6 = addP2(h6, 's-a', '甲', 3, 12, { status: { currentHP: 3, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤' } });
  h6.applyHpChange(m6, 4, 't');
  eq(m6.sheet.status.body, '轻伤', '★ #6 解除重伤 → 轻伤');
  eq(m6.sheet.status.dying, false, '★ #6 dying=false');
  ok(!m6.sheet.status.unconscious, '★ #6 unconscious 不动（无人被唤醒）');
  /* #6 与昏迷叠加（视图=昏迷）时落 #7 全保持：body 仍重伤、unconscious 不动（唤醒靠急救/治愈） */
  var h6b = mkH2({ rules: mkRules2({ conDead: false }) });
  var m6b = addP2(h6b, 's-a', '甲', 3, 12, { status: { currentHP: 3, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤', unconscious: true } });
  h6b.applyHpChange(m6b, 4, 't');
  eq(m6b.sheet.status.body, '重伤', '★ #6+#7 重伤+昏迷 回血到 ≥半血 → body 仍重伤（全保持，不擅自解除）');
  eq(m6b.sheet.status.unconscious, true, '★ #6 unconscious 不动（唤醒靠急救/治愈）');
  eq(M.bodyView(m6b.sheet.status), '昏迷', '★ #6 视图仍昏迷');

  /* #7 改前重伤/昏迷 且非重伤伤害 → 全保持（body/dying/unconscious 均不动） */
  var h7 = mkH2({ rules: mkRules2({ conDead: false }) });
  var m7 = addP2(h7, 's-a', '甲', 5, 12, { status: { currentHP: 5, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤' } });
  h7.applyHpChange(m7, -1, 't');
  eq(m7.sheet.status.body, '重伤', '★ #7 改前重伤 + 非重伤小伤害 → 仍重伤（不降级）');
  var h7b = mkH2({ rules: mkRules2({ conDead: false }) });
  var m7b = addP2(h7b, 's-a', '甲', 2, 12, { status: { currentHP: 2, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '轻伤', unconscious: true } });
  h7b.applyHpChange(m7b, -1, 't');
  eq(m7b.sheet.status.unconscious, true, '★ #7 改前昏迷 + 非重伤伤害 → 仍昏迷（不降级）');
  eq(m7b.sheet.status.body, '轻伤', '★ #7 body 也不动（轻伤）');
  eq(M.bodyView(m7b.sheet.status), '昏迷', '★ #7 视图仍昏迷');

  /* 其余（正常/轻伤 + 非重伤伤害）：HP<上限 → 轻伤；HP≥上限 → 正常 */
  var h8 = mkH2({ rules: mkRules2({ conDead: false }) });
  var m8 = addP2(h8, 's-a', '甲', 12, 12);
  h8.applyHpChange(m8, -5, 't');
  eq(m8.sheet.status.body, '轻伤', '★ 其余：正常受非重伤伤害 → 轻伤');
  h8.applyHpChange(m8, 5, 't');
  eq(m8.sheet.status.body, '正常', '★ 其余：HP 回满 → 正常');
})();

section('模型-R4 · 私密事件不再泄漏进 KP 栏目（host state.privates 守卫；暗骰不丢；玩家照常收）');
(function () {
  /* ① 玩家定向私密（scene.clue → VIS.SEAT + to=玩家）不进 host state.privates */
  var h = mkH2({});
  addP2(h, 's-a', '甲', 12, 12);
  addP2(h, 's-b', '乙', 12, 12);
  h.applyAction('host', { op: 'scene.clue', seat: 's-a', title: '线索', text: '密室在东侧' });
  eq(h.state.privates.length, 0, '★ 玩家定向私密（scene.clue to=s-a）不进 host state.privates');

  /* 玩家定向系统提示（_sysTo 玩家，如越权提醒）同样不进 */
  var p = h.intent('s-a', M.intentMsg(M.INTENT.ACT, { op: 'state.self', seat: 's-b', status: { currentHP: 5 } }));
  ok(/只能修改自己的状态/.test(planText2(p)), '前置：产生了一条玩家定向提示');
  eq(h.state.privates.length, 0, '★ 玩家定向系统提示（_sysTo 玩家）不进 host state.privates');

  /* ② 反面：KP 定向（暗骰 to=HOST_SEAT）仍进 —— 暗骰不能被修丢 */
  var h2 = mkH2({});
  addP2(h2, 's-a', '甲', 12, 12);
  h2.applyAction('host', { op: 'dice.dark', sides: 100, count: 1, bonus: 0, reason: '试探' });
  ok((h2.state.privates || []).some(function (x) { return x.kind === 'dark'; }),
     '★ 反面：KP 定向暗骰（to=HOST_SEAT）仍进 host state.privates');
  eq(h2.state.privates.length, 1, '★ 反面：暗骰全文仍在 KP 栏目');

  /* ③ client receive 不传 vis → 守卫不触发，玩家照常收到自己的私密 */
  var h3 = mkH2({});
  var cli = new M.Client({ seat: 's-a', role: M.ROLE.PLAYER });
  var plan = h3.applyAction('host', { op: 'scene.clue', seat: 's-a', title: '线索', text: '只给甲看' });
  plan.forEach(function (r) { cli.receive(JSON.stringify(r.msg)); });
  eq(cli.state.privates.length, 1, '★ 玩家端照常收到自己的私密（client receive 无 vis → 守卫不触发）');
  eq(cli.state.privates[0].text, '只给甲看', '玩家端私密内容正确');
  eq(cli.state.privates[0].kind, 'info', '玩家端私密 kind 兜底为 info');
})();

section('模型-R5 · 濒死（dying）并入全局操作锁（Q6）+ _isDying / _isUnconscious 判据');
(function () {
  var h = mkH2({});
  // v2.10.0（R5）：濒死 = body='重伤' + dying=true
  addP2(h, 's-a', '甲', 0, 12, { status: { currentHP: 0, maxHP: 12, currentSAN: 50, maxSAN: 50, body: '重伤', dying: true } });
  var out1 = h.intent('s-a', M.intentMsg(M.INTENT.DICE, { expr: '1D100', direct: true }));
  ok(/昏迷\/濒死/.test(planText2(out1)) && !hasEvt2(out1, M.EVT.DICE),
     '★ 濒死玩家普通操作（掷骰）被拦', planText2(out1));
  var out2 = h.intent('s-a', M.intentMsg(M.INTENT.CHAT, { text: '救我' }));
  ok(hasEvt2(out2, M.EVT.CHAT), '★ 例外：聊天放行');
  var out3 = h.intent('s-a', M.intentMsg(M.INTENT.ACT, { op: 'sheet.healwound' }));
  ok(!/无法进行该操作/.test(planText2(out3)) && /等待确认/.test(planText2(out3)),
     '★ 例外：申请治愈伤势放行（进 KP 同意队列）', planText2(out3));
  var out4 = h.intent('s-a', M.intentMsg(M.INTENT.ACT, { op: 'aid.apply', seat: 's-a', targetSeat: 's-a', skill: '急救' }));
  ok(/昏迷\/濒死/.test(planText2(out4)), '★ 反向：aid.apply 不在白名单（濒死者被拦）', planText2(out4));
  ok(h._isDying(h.roster.get('s-a')) === true, '_isDying 判据 = status.dying');
  ok(h._isUnconscious(h.roster.get('s-a')) === false, '_isUnconscious 不误判（dying 不等于 unconscious）');
  ok(h._isDying(null) === false && h._isUnconscious(null) === false, '两判据对空成员安全返回 false');
})();

section('模型-R2a · state.self 的 reason 消费（点选身体状态 → 公开「状态变化」日志带原因）');
(function () {
  /* R2a 验收标准：「点选身体状态**并写游戏记录**」—— 权威端必须留下是谁、为什么改的。 */
  var h = mkH2({});
  addP2(h, 's-a', '甲', 12, 12);
  h.intent('s-a', M.intentMsg(M.INTENT.ACT, {
    op: 'state.self', status: { body: '重伤', dying: true }, reason: '自行设置身体状态：重伤 + 濒死'
  }));
  var logs = h.state.logs || [];
  ok(logs.some(function (l) { return /自行设置身体状态：重伤 \+ 濒死/.test(l.text || ''); }),
     '★ state.self 带 reason → 公开日志「状态变化」带原因（KP 复盘可见）', JSON.stringify(logs.slice(-1)));
  ok(logs.some(function (l) { return l.kind === 'state'; }),
     '日志 kind 仍为 state（沿用既有 EVT.LOG kind:state 格式）');
  /* 标记本身也确已落账（reason 不顶替判定） */
  eq(h.roster.get('s-a').sheet.status.body, '重伤', 'reason 不影响落账：body=重伤');
  eq(h.roster.get('s-a').sheet.status.dying, true, 'reason 不影响落账：dying=true');

  /* 缺省 reason → 沿用旧口径（不静默丢原因也不报错） */
  var h2 = mkH2({});
  addP2(h2, 's-a', '甲', 12, 12);
  h2.intent('s-a', M.intentMsg(M.INTENT.ACT, { op: 'state.self', status: { body: '轻伤' } }));
  ok((h2.state.logs || []).some(function (l) { return /状态变化（玩家自行修改状态）/.test(l.text || ''); }),
     '缺省 reason → 沿用「玩家自行修改状态」旧口径');
  var h2b = mkH2({});
  addP2(h2b, 's-a', '甲', 12, 12);
  h2b.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, { op: 'state.self', seat: 's-a', status: { body: '轻伤' } }));
  ok((h2b.state.logs || []).some(function (l) { return /状态变化（KP修改状态）/.test(l.text || ''); }),
     'KP 入口缺省 reason → 沿用「KP修改状态」旧口径');

  /* 超长 reason 被 cleanText 截断（≤80，防刷屏） */
  var h3 = mkH2({});
  addP2(h3, 's-a', '甲', 12, 12);
  h3.intent('s-a', M.intentMsg(M.INTENT.ACT, {
    op: 'state.self', status: { body: '轻伤' }, reason: 'x'.repeat(200)
  }));
  var last = (h3.state.logs || []).slice(-1)[0];
  ok(!!last && last.text.indexOf('x'.repeat(200)) < 0 && last.text.length < 200,
     '★ 超长 reason 被截断（cleanText 80）', last && last.text.length);
})();
