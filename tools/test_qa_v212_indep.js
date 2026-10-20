/* ============================================================
 * test_qa_v212_indep.js —— QA（严过关）v2.1.1 三项修复的**独立**验收测试
 *
 * 目的：不复述开发同学的用例，用**新鲜视角**重新证明三项修复真的работает。
 * 重点挑开发同学用例**没覆盖**的边界：
 *   任务A  —— '*' 是否「只作用于在线玩家」（离线玩家不能收）、每人是否拿到
 *             自己的 EVT.STATE（各自独立的 seq）、HP 扣到 0 不为负、未选人不退化。
 *   任务B  —— 给了本机不存在的 charId 时**绝不能**写到 current（修复前会把别人
 *             的卡改坏）；给了正确 charId 时不动 current；无 store / 无卡的分支。
 *   任务C  —— 成功支=0 时**不发 EVT.STATE**、扣到 0 不为负、夹到 maxSAN、
 *             大失败按失败、非法骰式被拒、同 seq 幂等、旁观者被拒、'*' 各判各的。
 *
 * 用法：node tools/test_qa_v212_indep.js
 * 成功时最后一行打印 RESULT: PASS
 * ============================================================ */
'use strict';

global.window = global;
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
eval(fs.readFileSync(path.join(root, 'web/js/core/room-model.js'), 'utf8'));

let CocRules = null;
try {
  eval(fs.readFileSync(path.join(root, 'web/js/core/room-rules.js'), 'utf8'));
  CocRules = global.CocRules;
} catch (e) { CocRules = null; }
console.log('规则服务：' + (CocRules ? '已加载（CocRules）' : '未加载'));

const M = global.RoomModel;
const R = M.ROLE;
const E = M.EVT;

/* ---------------- 迷你断言框架（与既有套件同风格） ---------------- */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(label + (extra === undefined ? '' : '　→ 实际: ' + JSON.stringify(extra)));
}
function eq(a, b, label) { ok(a === b, label, a); }
function section(name) { console.log('\n=== ' + name + ' ==='); }
function fixed(v) { return function () { return v; }; }

/* ---------------- 迷你中继（与 test_room_model.js 同语义） ---------------- */
function Relay() { this.clients = {}; this.log = []; }
Relay.prototype.add = function (c) { this.clients[c.seat] = c; };
Relay.prototype.mark = function () { return this.log.length; };
Relay.prototype.deliver = function (plan) {
  const got = {};
  for (const step of plan) {
    const text = JSON.stringify(step.msg);
    this.log.push({ to: step.to, text: text });
    if (step.to === '*') {
      for (const seat of Object.keys(this.clients)) {
        got[seat] = got[seat] || [];
        got[seat].push(this.clients[seat].receive(text));
      }
    } else {
      got[step.to] = got[step.to] || [];
      if (this.clients[step.to]) got[step.to].push(this.clients[step.to].receive(text));
    }
  }
  return got;
};
Relay.prototype.since = function (mark, seat) {
  return this.log.slice(mark).filter(m => m.to === '*' || m.to === seat).map(m => m.text);
};
/** 某游标之后发给**某个精确 seat**（不含群发）的原始字节 */
Relay.prototype.toSeat = function (mark, seat) {
  return this.log.slice(mark).filter(m => m.to === seat).map(m => m.text);
};

function newHost(meta, now, opts) {
  return new M.Host(Object.assign({
    meta: Object.assign({ code: 'abc123', name: '测试团', kpName: 'KP', maxPlayers: 6 }, meta || {}),
    now: now || fixed(1700000000000)
  }, opts || {}));
}
function addPlayer(host, relay, seat, nickname) {
  const res = host.attachPeer({ seat: seat, cid: 'c-' + seat, role: R.PLAYER, nickname: nickname, at: 1 });
  const client = new M.Client({ seat: seat, role: R.PLAYER, meta: host.state.meta });
  relay.add(client);
  relay.deliver(res.out);
  return { member: res.member, client: client };
}
function addSpec(host, relay, seat, nickname) {
  const res = host.attachPeer({ seat: seat, cid: 'c-' + seat, role: R.SPECTATOR, nickname: nickname || '围观者' });
  const client = new M.Client({ seat: seat, role: R.SPECTATOR, meta: host.state.meta });
  relay.add(client);
  relay.deliver(res.out);
  return { member: res.member, client: client };
}
/** 玩家上报角色卡（走真实 INTENT.CHAR 通道） */
function bindCard(host, relay, seat, id, status) {
  relay.deliver(host.intent(seat, M.intentMsg(M.INTENT.CHAR,
    { id: id, name: seat, sheet: { name: seat, status: status } })));
}

/** 可控随机源：按队列取值，队列耗尽后固定返回 0.5 */
function qrng(seq) {
  let i = 0;
  return function () { const v = seq[i++]; return (v === undefined) ? 0.5 : v; };
}

/** 读成员当前 HP：优先 runtime.hp，回落 sheet.status.currentHP（离线成员无 runtime） */
function hpOf(m) {
  const r = (m && m.runtime) || {};
  if (r.hp != null) return r.hp;
  const st = (m && m.sheet && m.sheet.status) || {};
  return (st.currentHP != null) ? st.currentHP : null;
}

/* ============================================================
 * 1. 任务A：'*' = 全部**在线**玩家（离线不能收 / 各自独立 / 边界）
 * ============================================================ */
section('任务A：seat = "*" 语义（独立复核）');

(function () {
  const host = newHost();
  const relay = new Relay();
  addPlayer(host, relay, 's-a', 'A');
  addPlayer(host, relay, 's-b', 'B');
  addPlayer(host, relay, 's-c', 'C');
  bindCard(host, relay, 's-a', 'ca', { currentHP: 12, currentSAN: 60 });
  bindCard(host, relay, 's-b', 'cb', { currentHP: 10, currentSAN: 70 });
  bindCard(host, relay, 's-c', 'cc', { currentHP: 8, currentSAN: 80 });

  /* 把 C 置为离线 */
  host.roster.markOffline('s-c');

  /* A1：'*' 伤害只作用于在线的 A、B，离线的 C 纹丝不动 */
  let mark = relay.mark();
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'sheet.damage', seat: '*', amount: 4, kind: '毒气' })));
  eq(hpOf(host.roster.get('s-a')), 8, 'A1 在线 A 扣血 12→8');
  eq(hpOf(host.roster.get('s-b')), 6, 'A1 在线 B 扣血 10→6');
  eq(hpOf(host.roster.get('s-c')), 8, '★ A1 **离线** C **不**受影响（仍 8）');
  ok(relay.since(mark, 's-c').every(t => !t.includes('"t":"state"')),
     '★ A1 离线 C 一条 EVT.STATE 都没收到');
  ok(relay.since(mark, M.HOST_SEAT).some(t => t.includes('已作用于 2 名在线玩家')),
     '★ A1 公共日志写明只作用于 2 名（不是 3 名）在线玩家');

  /* A2：每个目标拿到**自己的** EVT.STATE（seq 各不相同） */
  const stateA = relay.toSeat(mark, 's-a').filter(t => t.includes('"t":"state"'));
  const stateB = relay.toSeat(mark, 's-b').filter(t => t.includes('"t":"state"'));
  ok(stateA.length === 1 && stateB.length === 1, '★ A2 A、B 各自收到一条 EVT.STATE',
     { A: stateA.length, B: stateB.length });
  const seqA = stateA.length ? JSON.parse(stateA[0]).p.seq : null;
  const seqB = stateB.length ? JSON.parse(stateB[0]).p.seq : null;
  ok(seqA !== null && seqB !== null && seqA !== seqB,
     '★ A2 两名玩家的 EVT.STATE **seq 不同**（独立结算，不是同一条群发）', { seqA, seqB });

  /* A3：未选目标（空 seat）→ 谁都不动，只回 KP */
  mark = relay.mark();
  const before = { a: hpOf(host.roster.get('s-a')), b: hpOf(host.roster.get('s-b')) };
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'sheet.damage', seat: '', amount: 9 })));
  eq(hpOf(host.roster.get('s-a')), before.a, 'A3 空 seat：A 未变');
  eq(hpOf(host.roster.get('s-b')), before.b, 'A3 空 seat：B 未变');
  ok(relay.since(mark, M.HOST_SEAT).some(t => t.includes('请先选择生效目标')),
     'A3 空 seat → 回 KP 提示，不退化自改');

  /* A4：HP 扣到 0 不为负 */
  mark = relay.mark();
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'sheet.damage', seat: 's-a', amount: 999 })));
  eq(hpOf(host.roster.get('s-a')), 0, '★ A4 超大伤害：HP 夹到 0（不为负）');

  /* A5：'*' 临时状态 / 物品 → 每个**可接收**的在线玩家各一条（离线 C 不收）。
     ⚠️ v2.5.0 口径修正：A4 用 999 点伤害已经把 s-a 打死（body='死亡' → 撕卡），
        而 v2.1.7（用户 bug 反馈）起「撕卡角色不再接受定向指令」是**既定正确行为** ——
        所以这里不能再期望 A 收到，否则等于要求模型给一具尸体发物品。
        扇出语义本身没坏：B 收到、离线的 C 不收、KP 还收到一条「A 已撕卡」提示。 */
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'sheet.tempstatus', seat: '*', text: '中毒' })));
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'sheet.item', seat: '*', name: '手电筒', qty: 2 })));
  eq((host.roster.get('s-a').sheet.tempStatus || []).length, 0,
     '★ A5 已撕卡的 A 收不到临时状态（v2.1.7 定向指令拦截）');
  eq((host.roster.get('s-b').sheet.tempStatus || []).length, 1,
     'A5 在线 B 追加 1 条临时状态');
  eq((host.roster.get('s-c').sheet.tempStatus || []).length, 0,
     '★ A5 离线 C 未追加临时状态');
  ok((host.roster.get('s-a').sheet.items || []).length === 0 &&
     (host.roster.get('s-b').sheet.items || []).length === 1 &&
     (host.roster.get('s-c').sheet.items || []).length === 0,
     '★ A5 物品只发给在线且未撕卡的玩家（A 撕卡 / C 离线都收不到）');

  /* A6：0 在线玩家 → 只回 KP，不发状态、不产生「已作用于」公共日志 */
  const h0 = newHost();
  const r0 = new Relay();
  addPlayer(h0, r0, 's-x', 'X');
  h0.roster.markOffline('s-x');
  const m0 = r0.mark();
  r0.deliver(h0.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'sheet.damage', seat: '*', amount: 5 })));
  ok(r0.since(m0, M.HOST_SEAT).some(t => t.includes('没有在线玩家')),
     '★ A6 0 在线 → 回 KP「没有在线玩家」');
  ok(!r0.since(m0, '*').some(t => t.includes('"t":"state"')),
     '★ A6 0 在线 → 不发任何 EVT.STATE');
  ok(!r0.since(m0, '*').some(t => t.includes('已作用于')),
     '★ A6 0 在线 → 不产生「已作用于」日志');
})();

/* ============================================================
 * 2. 任务B：applyStateToCard 结构化结果 + **安全属性**（不误写别人卡）
 * ============================================================ */
section('任务B：applyStateToCard 落点安全（独立复核）');

(function () {
  /* 关键场景：Store 里 current 是「我」的卡，但权威端给了一个本机不存在的 charId。
     修复前会退写到 current（把「我」的卡改成别人的状态）—— 现在必须拒绝。 */
  function store() {
    return {
      _st: {
        characters: { mine: { id: 'mine', status: { currentHP: 12, currentSAN: 50 } } },
        current: { id: 'mine', status: { currentHP: 12, currentSAN: 50 } }
      },
      getState: function () { return this._st; },
      saveNow: function () { this._saved = (this._saved || 0) + 1; }
    };
  }

  /* B1：给了**本机不存在**的 charId → 拒绝，且绝不写 current */
  let s = store();
  let res = M.applyStateToCard(s, 'ghost-card-xyz', { status: { currentHP: 1, currentSAN: 3 } });
  ok(res && res.ok === false && res.reason === 'card_not_found',
     '★ B1 未知 charId → {ok:false, reason:card_not_found}', res);
  eq(s._st.current.status.currentHP, 12, '★ B1 **current 的 HP 未被改写**（仍是 12，这是修复前会踩坏别人的隐患）');
  eq(s._st.current.status.currentSAN, 50, '★ B1 current 的 SAN 未被改写（仍是 50）');
  eq(s._saved, undefined, 'B1 拒绝时不触发 saveNow（没写就不存）');

  /* B2：给了正确 charId → 只改那张；current 若指向别的卡则不动 */
  s = store();
  s._st.characters.other = { id: 'other', status: { currentHP: 99 } };
  s._st.current = { id: 'other', status: { currentHP: 99 } };   // current 是另一张
  res = M.applyStateToCard(s, 'mine', { status: { currentHP: 4 } });
  ok(res && res.ok === true && res.cardId === 'mine' && res.source === 'characters',
     '★ B2 命中 charId=mine → {ok:true, source:characters}', res);
  eq(s._st.characters.mine.status.currentHP, 4, 'B2 目标卡被更新 12→4');
  eq(s._st.current.status.currentHP, 99, '★ B2 current（别的卡）未被误改（仍 99）');

  /* B3：charId 恰好等于 current.id（未在 characters 里）→ 允许写 current（同 id 就是同一张） */
  s = { _st: { characters: {}, current: { id: 'cur1', status: { currentHP: 7 } } },
        getState: function () { return this._st; }, saveNow: function () {} };
  res = M.applyStateToCard(s, 'cur1', { status: { currentHP: 2 } });
  ok(res && res.ok === true && res.cardId === 'cur1', '★ B3 charId === current.id → 安全写 current', res);
  eq(s._st.current.status.currentHP, 2, 'B3 current 被更新 7→2');

  /* B4：未给 charId（旧路径）→ 退到 current 且标 source=current */
  s = store();
  res = M.applyStateToCard(s, null, { status: { currentHP: 3 } });
  ok(res && res.ok === true && res.source === 'current', '★ B4 无 charId → 退 current，source=current', res);
  eq(s._st.current.status.currentHP, 3, 'B4 current 被更新 12→3');

  /* B5：没有 store → no_store（不抛异常） */
  res = M.applyStateToCard(null, 'x', { status: { currentHP: 1 } });
  ok(res && res.ok === false && res.reason === 'no_store', '★ B5 无 store → {ok:false, reason:no_store}', res);

  /* B6：无 charId 且无 current → no_card（不抛异常） */
  s = { _st: { characters: {}, current: null }, getState: function () { return this._st; }, saveNow: function () {} };
  res = M.applyStateToCard(s, undefined, { status: { currentHP: 1 } });
  ok(res && res.ok === false && res.reason === 'no_card', '★ B6 无卡可写 → {ok:false, reason:no_card}', res);

  /* B7：applyToCard 同时写入 tempStatus / items（任务B 关联的任务A 数据） */
  s = store();
  res = M.applyStateToCard(s, 'mine', { tempStatus: [{ text: '流血', by: 'kp' }], items: [{ name: '火把', qty: 1 }] });
  ok(res.ok === true && (s._st.characters.mine.tempStatus || []).length === 1 &&
     (s._st.characters.mine.items || []).length === 1,
     'B7 临时状态 / 物品也落到目标卡');
})();

/* ============================================================
 * 3. 任务C：SAN Check 按规则书结算 + 自动扣 SAN（独立复核）
 * ============================================================ */
section('任务C：SAN Check 规则书结算（独立复核）');

(function () {
  if (!CocRules) {
    console.log('（跳过：CocRules 未加载）');
    ok(false, 'CocRules 必须加载（否则无法验证规则书路径）');
    return;
  }

  /* 包一层：只替换 rng（不改规则逻辑），从而锁定分支 */
  function rulesWith(seq) {
    const rng = qrng(seq);
    const o = Object.create(CocRules);
    o.resolveSanCheck = function (opts) {
      return CocRules.resolveSanCheck(Object.assign({}, opts, { rng: rng }));
    };
    return o;
  }
  /* ⚠️ rng 消耗规则（据 room-rules.js 实现，QA 亲验）：
       · 一次 D100 要 **2 次** rng：[个位骰, 十位骰]，各为 floor(r*10) 取 0-9。
         组合 combine(tens,ones)：00 与 0 → **100**，其余 = tens*10+ones。
         故 d100=11 → [0.1,0.1]；d100=96 → [0.6,0.9]；d100=100 → [0,0]。
       · 一次 1D6 要 **1 次** rng：1+floor(r*6)。6 → 0.99；1 → 0。
       · 常量损失（'0'/'2'/'5'）不消耗 rng。 */
  const D100 = { ok: [0.1, 0.1], fail: [0.6, 0.9], fumble: [0, 0] };

  /* ---- C1 成功支：D100=11 ≤ 60 成功 → 扣成功损失 2 ---- */
  (function () {
    const host = newHost(null, null, { rules: rulesWith(D100.ok) });
    const relay = new Relay();
    addPlayer(host, relay, 's-a', 'A');
    bindCard(host, relay, 's-a', 'ca', { currentHP: 12, currentSAN: 60, maxSAN: 60 });
    const mark = relay.mark();
    relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
      { op: 'sheet.sancheck', seat: 's-a', okLoss: '2', loss: '1D6' })));
    eq(host.roster.get('s-a').sheet.status.currentSAN, 58, '★ C1 成功支：扣成功损失 2 → 60→58');
    ok(relay.since(mark, 's-a').some(t => t.includes('成功支')),
       '★ C1 日志写明「成功支」');
  })();

  /* ---- C2 成功支且 okLoss=0 → 不扣、**不发 EVT.STATE** ---- */
  (function () {
    const host = newHost(null, null, { rules: rulesWith(D100.ok) });
    const relay = new Relay();
    addPlayer(host, relay, 's-a', 'A');
    bindCard(host, relay, 's-a', 'ca', { currentHP: 12, currentSAN: 60, maxSAN: 60 });
    const mark = relay.mark();
    relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
      { op: 'sheet.sancheck', seat: 's-a', okLoss: '0', loss: '1D6' })));
    eq(host.roster.get('s-a').sheet.status.currentSAN, 60, '★ C2 成功支 0 损失：SAN 不变');
    ok(!relay.since(mark, 's-a').some(t => t.includes('"t":"state"')),
       '★ C2 0 损失 → 不发 EVT.STATE（不做无意义的写回）');
    ok(relay.since(mark, 's-a').some(t => t.includes('无理智损失') && t.includes('SAN 保持不变')),
       '★ C2 0 损失 → 日志写「无理智损失（SAN 保持不变）」（不再输出 a→b 的撒谎差值）');
  })();

  /* ---- C3 失败支：D100=96 > 60 失败 → 1D6(=6) ---- */
  (function () {
    const host = newHost(null, null, { rules: rulesWith(D100.fail.concat([0.99])) });
    const relay = new Relay();
    addPlayer(host, relay, 's-a', 'A');
    bindCard(host, relay, 's-a', 'ca', { currentHP: 12, currentSAN: 60, maxSAN: 60 });
    const mark = relay.mark();
    relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
      { op: 'sheet.sancheck', seat: 's-a', okLoss: '0', loss: '1D6' })));
    eq(host.roster.get('s-a').sheet.status.currentSAN, 54, '★ C3 失败支：扣 1D6(=6) → 60→54');
    ok(relay.since(mark, 's-a').some(t => t.includes('失败支') && t.includes('理智损失 6')),
       '★ C3 日志写明「失败支 … 理智损失 6」');
  })();

  /* ---- C4 扣到 0 不为负：SAN=3，失败损失 1D6=6 → 0 ---- */
  (function () {
    const host = newHost(null, null, { rules: rulesWith(D100.fail.concat([0.99])) });
    const relay = new Relay();
    addPlayer(host, relay, 's-a', 'A');
    bindCard(host, relay, 's-a', 'ca', { currentHP: 12, currentSAN: 3, maxSAN: 60 });
    const mark = relay.mark();
    relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
      { op: 'sheet.sancheck', seat: 's-a', okLoss: '0', loss: '1D6' })));
    eq(host.roster.get('s-a').sheet.status.currentSAN, 0, '★ C4 扣到 0（不为负）');
    ok(relay.since(mark, 's-a').some(t => t.includes('SAN 3 → 0')),
       '★ C4 日志「SAN 3 → 0」');
  })();

  /* ---- C5 maxSAN 异常（<=0）与「上界不得把 SAN 压到低于检定前值」（v2.1.2 工程师修复口径）
     修复前：maxSanVal=clampNumber(maxSan,0,99,99) 对 maxSAN=0 原样返回 0 → after=min(0, san-loss)
     → 失败支一次把 SAN 清零、成功支 0 损失也把 SAN 夹到 0（撒谎日志）。
     修复后：maxSAN<=0 视为「不设上界」；上界只在 maxSanVal>=检定前 SAN 时才做「不得超过」收敛。 ---- */
  (function () {
    /* (a) maxSAN=0 且成功支 0 损失 → SAN **保持不变**（不得被夹到 0） */
    let host = newHost(null, null, { rules: rulesWith(D100.ok) });
    let relay = new Relay();
    addPlayer(host, relay, 's-a', 'A');
    bindCard(host, relay, 's-a', 'ca', { currentHP: 12, currentSAN: 55, maxSAN: 0 });
    let mark = relay.mark();
    relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
      { op: 'sheet.sancheck', seat: 's-a', okLoss: '0', loss: '1D6' })));
    eq(host.roster.get('s-a').sheet.status.currentSAN, 55,
       '★ C5a maxSAN=0 + 成功 0 损失 → SAN **不被夹到 0**（仍 55）');
    ok(relay.since(mark, 's-a').some(t => t.includes('无理智损失') && t.includes('SAN 保持不变')),
       '★ C5a 日志写「无理智损失（SAN 保持不变）」，不再输出撒谎的 a→b');
    ok(!relay.since(mark, 's-a').some(t => /SAN 55 → 0/.test(t)),
       '★ C5a 日志**绝不**出现「SAN 55 → 0」');

    /* (b) maxSAN=0 且失败支 loss=6 → 只扣 6 → 49（不得一次清零） */
    host = newHost(null, null, { rules: rulesWith(D100.fail.concat([0.99])) });
    relay = new Relay();
    addPlayer(host, relay, 's-a', 'A');
    bindCard(host, relay, 's-a', 'ca', { currentHP: 12, currentSAN: 55, maxSAN: 0 });
    relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
      { op: 'sheet.sancheck', seat: 's-a', okLoss: '0', loss: '1D6' })));
    eq(host.roster.get('s-a').sheet.status.currentSAN, 49,
       '★ C5b maxSAN=0 + 失败损失 6 → 55→49（**不被一次清零**）');

    /* (c) v2.6.0（用户第 6 项）行为变更：当前 SAN 的**上界 = 角色上限 maxSAN**（不再是固定 999）。
       检定前 SAN(90) 已超上限(60)：扣 5 得 85，再被夹到上限 60。
       ⚠️ 这是「历史可超限」行为的**有意变更**（工程师 v2.6.0 报告已列明），与 v2.1.2
       「检定本身不主动把 SAN 压到上限」在「已超上限」这一角落上不再并存 —— 现在统一以 maxSAN 收口。 */
    host = newHost(null, null, { rules: rulesWith(D100.fail) });
    relay = new Relay();
    addPlayer(host, relay, 's-a', 'A');
    bindCard(host, relay, 's-a', 'ca', { currentHP: 12, currentSAN: 90, maxSAN: 60 });
    relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
      { op: 'sheet.sancheck', seat: 's-a', okLoss: '0', loss: '5' })));
    eq(host.roster.get('s-a').sheet.status.currentSAN, 60,
       '★ C5c【v2.6.0 更新】当前 SAN 以角色上限 maxSAN(60) 夹紧 → 90-5=85 被夹到 60');
  })();

  /* ---- C6 大失败（D100=100）：目标 60 ≥ 50 → 100 是大失败，按失败处理 ---- */
  (function () {
    const host = newHost(null, null, { rules: rulesWith(D100.fumble.concat([0])) });
    const relay = new Relay();
    addPlayer(host, relay, 's-a', 'A');
    bindCard(host, relay, 's-a', 'ca', { currentHP: 12, currentSAN: 60, maxSAN: 60 });
    const mark = relay.mark();
    relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
      { op: 'sheet.sancheck', seat: 's-a', okLoss: '0', loss: '1D6' })));
    ok(relay.since(mark, 's-a').some(t => t.includes('大失败')),
       '★ C6 掷 100 → 日志含成功等级「大失败」');
    eq(host.roster.get('s-a').sheet.status.currentSAN, 59, '★ C6 大失败走失败支：1D6(=1) → 60→59');
  })();

  /* ---- C7 非法损失式 → 拒绝，不发 EVT.STATE ---- */
  (function () {
    const host = newHost(null, null, { rules: rulesWith(D100.ok) });
    const relay = new Relay();
    addPlayer(host, relay, 's-a', 'A');
    bindCard(host, relay, 's-a', 'ca', { currentHP: 12, currentSAN: 60, maxSAN: 60 });
    const mark = relay.mark();
    relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
      { op: 'sheet.sancheck', seat: 's-a', okLoss: 'abc', loss: '1D6' })));
    ok(relay.since(mark, M.HOST_SEAT).some(t => t.includes('不合法')),
       '★ C7 非法骰式 → 回 KP「格式不合法」');
    ok(!relay.since(mark, 's-a').some(t => t.includes('"t":"state"')),
       '★ C7 拒绝时不发 EVT.STATE');
    eq(host.roster.get('s-a').sheet.status.currentSAN, 60, 'C7 SAN 未变');
  })();

  /* ---- C8 幂等：同一 seq 的 EVT.STATE 应用两次只扣一次 ---- */
  (function () {
    const host = newHost(null, null, { rules: rulesWith(D100.fail.concat([0.99])) });
    const relay = new Relay();
    const p = addPlayer(host, relay, 's-a', 'A');
    bindCard(host, relay, 's-a', 'ca', { currentHP: 12, currentSAN: 60, maxSAN: 60 });
    const mark = relay.mark();
    relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
      { op: 'sheet.sancheck', seat: 's-a', okLoss: '0', loss: '1D6' })));
    eq(host.roster.get('s-a').sheet.status.currentSAN, 54, 'C8 权威端结算一次 → 54');
    const msgs = relay.toSeat(mark, 's-a').filter(t => t.includes('"t":"state"'));
    ok(msgs.length === 1, 'C8 只发了 1 条 EVT.STATE');
    const r1 = p.client.receive(msgs[0]);
    ok(r1 && r1.dup === true, '★ C8 同 seq 重放被判 dup（不会重复扣 SAN）', r1);
    eq(host.roster.get('s-a').sheet.status.currentSAN, 54, '★ C8 权威端 SAN 仍是 54（未二次扣）');
  })();

  /* ---- C9 玩家自助 SAN_CHECK 工作；旁观者被拒 ---- */
  (function () {
    const host = newHost(null, null, { rules: rulesWith(D100.fail.concat([0.99])) });
    const relay = new Relay();
    addPlayer(host, relay, 's-p', 'P');
    bindCard(host, relay, 's-p', 'cp', { currentHP: 9, currentSAN: 40, maxSAN: 40 });
    relay.deliver(host.intent('s-p', M.intentMsg(M.INTENT.SAN_CHECK,
      { okLoss: '0', loss: '1D6', reason: '自助' })));
    eq(host.roster.get('s-p').sheet.status.currentSAN, 34, '★ C9 玩家自助 SAN Check：权威端扣 40→34');

    addSpec(host, relay, 's-sp', '旁观');
    const mark = relay.mark();
    relay.deliver(host.intent('s-sp', M.intentMsg(M.INTENT.SAN_CHECK, { okLoss: '0', loss: '1D6' })));
    ok(relay.since(mark, 's-sp').some(t => t.includes('只有玩家可以做 SAN Check')),
       '★ C9 旁观者自助被拒');
    ok(!relay.since(mark, 's-sp').some(t => t.includes('"t":"state"')),
       '★ C9 旁观者被拒时不发 EVT.STATE');
  })();

  /* ---- C10 '*' SAN：各按**自己的** SAN 判定（同一次掷骰，A 成功 B 失败） ---- */
  (function () {
    /* 消耗顺序：A 检定(2) + A 成功0损失(0) + B 检定(2) + B 1D6(1) */
    const host = newHost(null, null, { rules: rulesWith(D100.fail.concat(D100.fail, [0.99])) });
    const relay = new Relay();
    addPlayer(host, relay, 's-a', 'A');
    addPlayer(host, relay, 's-b', 'B');
    bindCard(host, relay, 's-a', 'ca', { currentHP: 12, currentSAN: 99, maxSAN: 99 }); // 96 ≤ 99 → 成功
    bindCard(host, relay, 's-b', 'cb', { currentHP: 10, currentSAN: 60, maxSAN: 60 }); // 96 > 60 → 失败
    relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
      { op: 'sheet.sancheck', seat: '*', okLoss: '0', loss: '1D6', reason: '群体' })));
    eq(host.roster.get('s-a').sheet.status.currentSAN, 99, '★ C10 A(99)：同一次 D100=96 成功 → 不扣');
    eq(host.roster.get('s-b').sheet.status.currentSAN, 54, '★ C10 B(60)：同一次 D100=96 失败 → 扣 6 → 54');
  })();
})();

/* ============================================================
 * 4. 反向验证挂钩：DEBUG 环境变量下把断言反过来（人工改源码后应全红）
 *    这里只打印提醒 —— 真正的反向验证在 QA 流程里手工做。
 * ============================================================ */
if (process.env.QA_EXPECT_RED) {
  console.log('\n[反向验证模式] 期望本套件变红（源码被临时改回旧行为）');
}

/* ============================================================
 * 汇总
 * ============================================================ */
console.log('\n' + '='.repeat(60));
if (fail) {
  console.log('失败 ' + fail + ' 项：');
  failures.forEach(f => console.log('  ✗ ' + f));
  console.log('RESULT: FAIL');
  process.exit(1);
}
console.log('全部通过：' + pass + ' 项断言');
console.log('RESULT: PASS');
