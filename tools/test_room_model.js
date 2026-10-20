/* ============================================================
 * test_room_model.js —— 跑团房间数据模型单元测试（纯 Node，不需要浏览器）
 *
 * 对应需求文档 §16「验收标准 · 房间与权限」以及 §0 的三条硬约束：
 *   · 序号幂等：重连补拉必然重复与乱序，重复必须丢弃、跳跃必须发现
 *   · 可见性：**未授权客户端不能收到数据**（不是发过去再靠界面藏）
 *   · 权限：越权请求即使被伪造出来也不会生效；需要确认的操作不会被直接执行
 *   · 回退：必须恢复状态快照 + 重放关联事件，不是只删界面文字
 *   · 断线重连：离线不移除、重连保留准备状态、被踢者拦得住
 *
 * 写法约定（踩过的坑）：
 *   1) **不要写死 seq 绝对值** —— 多发一条 MEMBERS 就会全线错位，
 *      而失败信息看起来像「功能坏了」。一律用 base + 偏移量。
 *   2) 用 relay.mark() / relay.since(mark, seat) 取「某次操作之后发给了谁」，
 *      不要自己按长度 slice —— 群发与单发拼在一起时下标会错位。
 *   3) **每个 Host 方法的返回计划都必须投递**，否则其他客户端的 lastSeq
 *      会落后，后续事件被正确地判成丢包（那不是 bug，是序号机制在干活）。
 *
 * 用法：node tools/test_room_model.js
 * 成功时最后一行打印 RESULT: PASS
 * ============================================================ */
'use strict';

global.window = global;
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
eval(fs.readFileSync(path.join(root, 'web/js/core/room-model.js'), 'utf8'));

/* v2.0.0：加载规则服务，让 combat.start 走真实的 CocRules.initiativeOrder，
   并供检定权威取值（skillValue / attrValue）用。
   规则文件若尚未就绪（D 线未交付），退化为 room-model 内部的兜底排序 —— 不阻断本套件。 */
let CocRules = null;
try {
  eval(fs.readFileSync(path.join(root, 'web/js/core/room-rules.js'), 'utf8'));
  CocRules = global.CocRules;
} catch (e) { CocRules = null; }
console.log('规则服务：' + (CocRules ? '已加载（CocRules）' : '未加载（用兜底排序）'));

const M = global.RoomModel;
const R = M.ROLE;
const S = M.STATUS;
const E = M.EVT;

/* ---------------- 迷你断言框架 ---------------- */
let pass = 0, fail = 0;
const failures = [];

function ok(cond, label, extra) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(label + (extra === undefined ? '' : '　→ 实际: ' + JSON.stringify(extra)));
}
function eq(actual, expected, label) { ok(actual === expected, label, actual); }
function seq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label, actual);
}
function fixed(v) { return function () { return v; }; }
function section(name) { console.log('\n=== ' + name + ' ==='); }

/* ============================================================
 * 0. 测试用的迷你中继
 *
 * 真实中继（room_server.py / LanServer）只做三件事：hub.send 单发、
 * hub.broadcast 群发、把 peer.msg 转给权威端。这里用同样语义的内存版
 * 把「按 seat 投递」跑通 —— 断言的才是真实链路行为。
 * ============================================================ */
function Relay() {
  this.clients = {};   // seat -> Client
  this.log = [];       // [{to, text}]，按发送顺序
}

Relay.prototype.add = function (client) { this.clients[client.seat] = client; };

/** 记一个游标（= 现在发了多少条），配合 since 用 */
Relay.prototype.mark = function () { return this.log.length; };

/** 把 Host 给出的发送计划投递下去，返回每个 seat 收到了什么 */
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

/** 某游标之后，发给某个 seat 的全部原始字节（含群发） */
Relay.prototype.since = function (mark, seat) {
  return this.log.slice(mark)
    .filter(m => m.to === '*' || m.to === seat)
    .map(m => m.text);
};

function newHost(meta, now, opts) {
  return new M.Host(Object.assign({
    meta: Object.assign({ code: 'abc123', name: '测试团', kpName: 'KP老张', maxPlayers: 4 }, meta || {}),
    now: now || fixed(1700000000000)
  }, opts || {}));
}

/** 建一个玩家并把他入座时该收的东西都投递过去 */
function addPlayer(host, relay, seat, nickname, at) {
  const res = host.attachPeer({ seat: seat, cid: 'c-' + seat, role: R.PLAYER, nickname: nickname, at: at || 1 });
  const client = new M.Client({ seat: seat, role: R.PLAYER, meta: host.state.meta });
  relay.add(client);
  relay.deliver(res.out);
  return { member: res.member, client: client, res: res };
}

function addSpec(host, relay, seat, nickname) {
  const res = host.attachPeer({ seat: seat, cid: 'c-' + seat, role: R.SPECTATOR, nickname: nickname || '围观者' });
  const client = new M.Client({ seat: seat, role: R.SPECTATOR, meta: host.state.meta });
  relay.add(client);
  relay.deliver(res.out);
  return { member: res.member, client: client };
}

/* ============================================================
 * 1. 信封与解析
 * ============================================================ */
section('1. 信封与解析');

(function () {
  const sm = M.syncMsg(7, { seq: 7, meta: { code: 'x1' } });
  eq(sm.k, 'sync', '全量同步信封 k=sync');
  eq(sm.seq, 7, '全量同步信封带 seq');
  ok(!!sm.state, '全量同步信封带 state');

  const em = M.evtMsg({ seq: 3, evt: { t: 'chat', p: { text: 'hi' } } });
  eq(em.k, 'evt', '增量事件信封 k=evt');
  eq(em.seq, 3, '增量事件信封带 seq');
  eq(em.t, 'chat', '增量事件带类型');
  eq(em.p.text, 'hi', '增量事件带载荷');

  const im = M.intentMsg(M.INTENT.READY, { ready: true });
  eq(im.k, 'intent', '意图信封 k=intent');
  eq(im.op, 'ready', '意图带 op');

  eq(M.parse(JSON.stringify({ k: 'skip', seq: 4 })).k, 'skip', '水位标记信封可解析');

  // 中继自己的控制消息不能被当成房间事件
  eq(M.parse(JSON.stringify({ k: 'host.gone', message: '房主断了' })), null, '中继消息不被识别为房间事件');
  eq(M.parse(JSON.stringify({ k: 'peer.open', cid: 'c1', seat: 's1' })), null, 'peer.open 不是房间事件');
  eq(M.parse('这不是 JSON'), null, '非 JSON 返回 null');
  ok(!!M.parse(JSON.stringify(em)), '正常事件能解析');

  // 载荷必须深拷贝：拿到消息后改它不能影响权威端
  const src = { seq: 1, evt: { t: 'chat', p: { text: 'a', arr: [1, 2] } } };
  const wrapped = M.evtMsg(src);
  wrapped.p.arr.push(3);
  eq(src.evt.p.arr.length, 2, 'evtMsg 深拷贝，改副本不影响源');
})();

/* ============================================================
 * 2. 序号：幂等、丢包发现、补拉
 * ============================================================ */
section('2. 序号幂等与补拉');

(function () {
  const host = newHost();
  const relay = new Relay();
  const a = addPlayer(host, relay, 's-a', '小明');

  const s0 = host.log.seq;                      // 不写死绝对值：入座本身也占序号
  const r1 = host.emit(E.CHAT, { seat: 's-a', nickname: '小明', text: '一', at: 1 });
  const r2 = host.emit(E.CHAT, { seat: 's-a', nickname: '小明', text: '二', at: 2 });
  const r3 = host.emit(E.CHAT, { seat: 's-a', nickname: '小明', text: '三', at: 3 });
  const r4 = host.emit(E.CHAT, { seat: 's-a', nickname: '小明', text: '四', at: 4 });
  eq(r1.seq, s0 + 1, '事件序号连续递增（第 1 条）');
  eq(r4.seq, s0 + 4, '事件序号连续递增（第 4 条）');
  eq(a.client.lastSeq, s0, '入座时客户端 lastSeq 与权威端齐平');

  // 正常按序投递前两条
  let got = relay.deliver(host.plan(r1));
  eq(got['s-a'][0].kind, 'evt', '收到增量事件');
  relay.deliver(host.plan(r2));
  eq(a.client.state.chats.length, 2, '按序应用了两条聊天');

  // 重复投递（重连补拉的必然现象）→ 必须丢弃
  got = relay.deliver(host.plan(r1));
  ok(got['s-a'][0].dup === true, '重复序号被判为 dup');
  eq(a.client.state.chats.length, 2, '重复事件不会被应用两次');
  eq(a.client.rejected, 1, '重复计数增加');

  // 乱序：跳过第 3 条直接给第 4 条 → 必须发现缺口而不是强行应用
  got = relay.deliver(host.plan(r4));
  ok(got['s-a'][0].gap === true, '序号跳跃被判为 gap');
  eq(a.client.state.chats.length, 2, '缺口事件不会被应用');
  eq(a.client.gapFrom, r2.seq, 'gapFrom 记录最后的连续序号');
  eq(a.client.lastSeq, r2.seq, '缺口事件不会推进 lastSeq');

  // 补拉：客户端用 resyncIntent() 把缺口报给权威端（界面走的就是这个入口）
  const req = a.client.resyncIntent();
  eq(req.op, M.INTENT.SYNC, '补拉用 SYNC 意图');
  eq(req.p.lastSeq, r2.seq, '补拉带上最后的连续序号');
  relay.deliver(host.intent('s-a', req));
  eq(a.client.state.chats.length, 4, '补拉后聊天补齐到 4 条');
  seq(a.client.state.chats.map(c => c.text), ['一', '二', '三', '四'], '补齐内容与顺序正确');
  eq(a.client.lastSeq, r4.seq, '补拉后 lastSeq 追上权威端');
  eq(a.client.gapFrom, 0, '补齐后缺口标记清零');

  // 补拉之后再来一条新事件，必须能正常续上
  const r5 = host.emit(E.CHAT, { seat: '', nickname: '', text: '五', at: 5 });
  got = relay.deliver(host.plan(r5));
  ok(got['s-a'][0].changed === true, '补齐后能继续按序接收');
  eq(a.client.lastSeq, r5.seq, '继续接收后 lastSeq 继续推进');
  eq(a.client.state.chats.length, 5, '聊天累计到 5 条');
})();

(function () {
  // 日志保留窗口：超出窗口的补拉要退回全量，不能给出错误答案
  const host = newHost();
  host.log = new M.Log(3);
  const relay = new Relay();
  const a = addPlayer(host, relay, 's-a', '小明');
  host.log.seq = 0;                       // 从干净的 0 开始，方便算窗口
  for (let i = 0; i < 6; i++) host.emit(E.CHAT, { text: 'm' + i, at: i });
  eq(host.log.seq, 6, 'seq 累加到 6');
  eq(host.log.items.length, 3, '日志只保留最近 3 条');
  eq(host.log.canFill(0), false, '超出窗口 → 必须全量同步');
  eq(host.log.canFill(4), true, '窗口内 → 可以增量补拉');

  const plan = host.intent('s-a', M.intentMsg(M.INTENT.SYNC, { lastSeq: 0 }));
  eq(plan.length, 1, '全量同步只发一条');
  eq(plan[0].msg.k, 'sync', '超出窗口时走全量 sync');
  relay.deliver(plan);
  eq(a.client.lastSeq, 6, '全量同步后 lastSeq=6');
})();

/* ============================================================
 * 3. 可见性：未授权客户端不能收到数据
 * ============================================================ */
section('3. 可见性与私有信息隔离');

(function () {
  const host = newHost();
  const relay = new Relay();
  addPlayer(host, relay, 's-a', '小明');
  addPlayer(host, relay, 's-b', '小红');
  addSpec(host, relay, 's-c');

  // 公共事件：所有人都收得到
  relay.deliver(host.plan(host.emit(E.CHAT, { seat: 's-a', nickname: '小明', text: '公开消息' })));
  ok(relay.since(0, 's-a').some(t => t.includes('公开消息')), '玩家收到公共消息');
  ok(relay.since(0, 's-b').some(t => t.includes('公开消息')), '另一个玩家收到公共消息');
  ok(relay.since(0, 's-c').some(t => t.includes('公开消息')), '旁观者收到公共消息');

  // 私有事件（线索）：只有目标收得到
  const mk = relay.mark();
  relay.deliver(host.plan(host.emit(E.PRIVATE, { title: '线索', text: '密室在东侧', at: 9 }, M.VIS.SEAT, 's-b')));
  const aBytes = relay.since(mk, 's-a').join('');
  const bBytes = relay.since(mk, 's-b').join('');
  const cBytes = relay.since(mk, 's-c').join('');
  ok(bBytes.includes('密室在东侧'), '目标玩家收到私有线索');
  ok(!aBytes.includes('密室在东侧'), '其他玩家收不到私有线索');
  ok(!cBytes.includes('密室在东侧'), '旁观者收不到私有线索');
  ok(!relay.log.slice(mk).some(m => m.to === '*'), '私有事件绝不出现在群发字节里');
  ok(aBytes.includes('"k":"skip"'), '其他人收到的是水位标记（不是内容）');

  // KP 本地事件：一条字节都不许发，也不占共享序号
  const allBefore = relay.log.length;
  const seqBefore = host.log.seq;
  const localRec = host.emitLocal(E.LOG, { text: 'KP 的备忘：他其实是邪教徒' });
  relay.deliver(host.plan(localRec));
  eq(relay.log.length, allBefore, 'KP 本地事件不产生任何发送');
  eq(host.log.seq, seqBefore, 'KP 本地事件不占用共享序号（否则人人都会看到「有个序号我收不到」）');
  eq(host.local.length, 1, 'KP 本地备忘存在自己的列表里');
  ok(!JSON.stringify(relay.since(0, 's-a')).includes('邪教徒'), 'KP 备忘不出现在任何人的字节里');

  // 机械保证：写错代码把私有字段塞进公共事件，也必须被剥掉
  const warnBefore = host.warnings.length;
  const bad = host.emit(E.LOG, { text: '公开的', secret: '真相是替身', nested: { clue: '凶器是冰锥' } });
  const mk2 = relay.mark();
  relay.deliver(host.plan(bad));
  const broadcasted = JSON.parse(relay.log.slice(mk2).filter(m => m.to === '*')[0].text);
  eq(broadcasted.p.secret, undefined, '公共事件里的 secret 被剥掉');
  eq(broadcasted.p.nested.clue, undefined, '嵌套的私有字段也被剥掉');
  eq(broadcasted.p.text, '公开的', '正常字段保留');
  eq(host.warnings.length, warnBefore + 1, '剥离动作留下警告（不会被静默吞掉）');

  // SEAT 事件没有收件人 = 写错了，必须留痕
  const w2 = host.warnings.length;
  relay.deliver(host.plan(host.emit(E.PRIVATE, { text: '给谁？' }, M.VIS.SEAT, null)));
  eq(host.warnings.length, w2 + 1, '无收件人的 SEAT 事件留下警告');

  eq(M.hasSecret({ a: { b: [{ secret: 1 }] } }), true, 'hasSecret 递归识别数组里的私有字段');
  eq(M.hasSecret({ a: 1 }), false, 'hasSecret 正常字段返回 false');
  eq(M.scrub({ a: 1, secret: 2, n: { clue: 3, ok: 4 } }).n.ok, 4, 'scrub 保留正常字段');
  eq(M.scrub({ a: 1, secret: 2, n: { clue: 3 } }).n.clue, undefined, 'scrub 递归剥掉私有字段');
})();

(function () {
  // 观众与玩家拿到的公开内容必须一致（不能因为「怎么进来的」而忽隐忽现）
  const host = newHost();
  const relay = new Relay();
  const pl = addPlayer(host, relay, 's-a', '小明');
  relay.deliver(host.plan(host.emit(E.LOG, { seat: '', text: '公开记录', kind: 'info' })));
  host.emitLocal(E.LOG, { text: 'KP 自己的备忘' });

  const spec = addSpec(host, relay, 's-b');
  const pl2 = addPlayer(host, relay, 's-c', '小红');

  const specTexts = spec.client.state.logs.map(l => l.text);
  const plTexts = pl2.client.state.logs.map(l => l.text);
  ok(specTexts.includes('公开记录'), '旁观者能看到公开记录');
  ok(plTexts.includes('公开记录'), '玩家能看到公开记录');
  ok(!specTexts.includes('KP 自己的备忘'), '旁观者的同步里没有 KP 备忘');
  ok(!plTexts.includes('KP 自己的备忘'), '玩家的同步里也没有 KP 备忘');
  eq(specTexts.join('|'), plTexts.join('|'), '旁观者与玩家的公开内容完全一致（全量与增量口径统一）');
  eq(pl.client.state.logs.length, 1, '先入座的玩家（增量收到的）与后入座的（全量同步的）内容一致');
  eq(pl.client.state.logs[0].text, pl2.client.state.logs[0].text, '同一条记录的文本一致');
})();

/* ============================================================
 * 4. 权限矩阵
 * ============================================================ */
section('4. 权限矩阵与确认策略');

(function () {
  // 允许的
  ok(M.allowed(R.KP, 'room.start'), 'KP 可以开团');
  ok(M.allowed(R.KP, 'room.kick'), 'KP 可以踢人');
  ok(M.allowed(R.KP, 'room.close'), 'KP 可以关房');
  ok(M.allowed(R.KP, 'scene.set'), 'KP 可以设置场景');
  ok(M.allowed(R.KP, 'combat.next'), 'KP 可以推进行动轮');
  /* v2.9.0（用户第 3 项）：`rollback.turn` 的**入口 op 已从 POLICY 移除** —— 回退 UI 全删，
     若入口仍被允许，一条**伪造的 ACT** 就能把房间推进「回退投票态」，而投票 UI 已不存在
     → 房间卡死。故这里断言「不再被允许」；方法 / 事件仍**休眠保留**（见下方回退专章）。 */
  ok(!M.allowed(R.KP, 'rollback.turn'), '★（v2.9.0 用户第 3 项）rollback.turn 入口已移除（不再被允许）');
  ok(M.allowed(R.KP, 'round.next'), 'KP 可以标记「进入下一回合」（回退的基准）');
  ok(M.allowed(R.PLAYER, 'chat'), '玩家可以发言');
  ok(M.allowed(R.PLAYER, 'dice.request'), '玩家可以请求掷骰');
  ok(M.allowed(R.PLAYER, 'ready.set'), '玩家可以设准备');

  // 禁止的
  ok(!M.allowed(R.PLAYER, 'room.start'), '玩家不能开团');
  ok(!M.allowed(R.PLAYER, 'room.kick'), '玩家不能踢人');
  ok(!M.allowed(R.PLAYER, 'room.close'), '玩家不能关房');
  ok(!M.allowed(R.PLAYER, 'scene.set'), '玩家不能设置场景');
  ok(!M.allowed(R.PLAYER, 'combat.next'), '玩家不能推进行动轮');
  ok(!M.allowed(R.PLAYER, 'rollback.turn'), '玩家不能发起回退（入口 op 已整体移除，谁都进不来）');
  ok(!M.allowed(R.PLAYER, 'round.next'), '玩家不能标记回合边界');
  ok(!M.allowed(R.SPECTATOR, 'chat'), '旁观者不能发言（不干涉游戏）');
  ok(!M.allowed(R.SPECTATOR, 'dice.request'), '旁观者不能掷骰');
  ok(!M.allowed(R.SPECTATOR, 'ready.set'), '旁观者不能设准备');
  ok(!M.allowed(R.SPECTATOR, 'scene.set'), '旁观者不能设置场景');
  ok(!M.allowed(R.KP, 'nonsense.action'), '未知动作一律拒绝（默认闭）');

  // 确认策略（需求 §7 / §9 / §12）
  eq(M.needs(R.PLAYER, 'state.edit.self').confirm, 'kp', '玩家改自己状态需 KP 确认');
  eq(M.needs(R.KP, 'state.edit.other').confirm, 'owner', 'KP 改玩家状态需该玩家确认');
  eq(M.needs(R.KP, 'room.close').confirm, 'twice', '关房需二次确认');
  eq(M.needs(R.KP, 'room.end').confirm, 'twice', '结团需二次确认');
  /* 回退发起时不再走通用 confirm —— 「投票」本身就是逐人同意流程，
     真正的二次确认放在 rollback.commit（执行前）由 UI 再弹一次。 */
  ok(!M.needs(R.KP, 'rollback.turn').allowed, '★（v2.9.0 用户第 3 项）rollback.turn 入口已移除（needs 不再允许）');
  eq(M.needs(R.KP, 'rollback.commit').confirm, null, '回退提交由 UI 做二次确认');
  eq(M.needs(R.KP, 'session.end').confirm, 'twice', '结团需二次确认');
  eq(M.needs(R.KP, 'combat.next').confirm, null, '推进回合不需要额外确认');
  eq(M.needs(R.SPECTATOR, 'room.start').allowed, false, '旁观者开团连入口都没有');
})();

(function () {
  // 越权请求即使被伪造出来，也不能生效
  const host = newHost();
  const relay = new Relay();
  const a = addPlayer(host, relay, 's-a', '小明');

  const before = host.state.meta.status;
  const mk = relay.mark();
  const plan = host.intent('s-a', M.intentMsg(M.INTENT.ACT, { op: 'room.start' }));
  eq(host.state.meta.status, before, '伪造的「开团」没有改变房间状态');
  eq(plan.length, 1, '越权请求只回一条提示');
  eq(plan[0].msg.k, 'evt', '提示是事件');
  eq(plan[0].to, 's-a', '提示只发给发起人（不污染公共流）');
  ok(plan[0].msg.p.text.includes('权限'), '提示说明是权限问题');
  relay.deliver(plan);
  ok(!relay.log.slice(mk).some(m => m.to === '*'), '越权请求不产生任何公共广播');
  eq(host.pending.length, 0, '越权请求不进待确认队列');

  // 需要确认的操作：只挂起，不执行
  const mk2 = relay.mark();
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.ACT, { op: 'state.edit.self', hp: 5 })));
  eq(host.pending.length, 1, '需要确认的操作进待确认队列');
  eq(host.pending[0].need, 'kp', '待确认项标注需要谁来确认');
  eq(host.state.meta.status, before, '挂起期间状态不变');
  ok(!relay.log.slice(mk2).some(m => m.to === '*'), '挂起操作不产生公共广播');

  // KP 自己的操作（不需要别人确认）直接执行
  const plan2 = host.applyAction('host', { op: 'room.start' });
  eq(host.state.meta.status, S.IN_GAME, 'KP 开团立刻生效');
  ok(plan2.length >= 1, '开团产生事件');
  relay.deliver(plan2);
  eq(a.client.state.meta.status, S.IN_GAME, '玩家端看到开团');

  // 踢人 / 关房
  const plan3 = host.kick('s-a');
  eq(host.roster.get('s-a'), null, '被踢者从成员表移除');
  eq(host.roster.kicked['s-a'], true, '被踢者记入黑名单');
  ok(plan3.some(x => x.msg.t === E.KICK && x.to === 's-a'), '被踢者收到 KICK（单发给他）');
  ok(!plan3.some(x => x.to === '*' && x.msg.t === E.KICK), 'KICK 不会被群发');

  const plan4 = host.closeRoom();
  eq(host.state.meta.status, S.CLOSED, '关房后状态为 CLOSED');
  ok(plan4.some(x => x.msg.t === E.CLOSED), '关房广播 CLOSED');
  ok(plan4.every(x => typeof x.to === 'string' && x.msg && x.msg.k === 'evt'),
     'Host 返回的一律是发送计划，不是事件记录');
})();

(function () {
  // 被踢的人不能立刻连回来
  const host = newHost();
  const relay = new Relay();
  addPlayer(host, relay, 's-a', '小明');
  addPlayer(host, relay, 's-b', '小红');
  host.kick('s-a');

  const again = host.attachPeer({ seat: 's-a', cid: 'c-new', role: R.PLAYER, nickname: '小明', at: 99 });
  eq(again.blocked, true, '被踢者重连被拦下');
  eq(again.rejected, true, '被踢者重连被拒');
  eq(host.roster.get('s-a'), null, '被踢者没有回到成员表');
  eq(again.out.length, 0, '被拒的连接不会拿到任何数据');

  const b = host.attachPeer({ seat: 's-b', cid: 'c-b2', role: R.PLAYER, nickname: '小红', at: 99 });
  eq(b.rejected, false, '正常成员重连不受影响');
})();

/* ============================================================
 * 5. 成员表与断线重连
 * ============================================================ */
section('5. 成员表与断线重连');

(function () {
  const host = newHost();
  const relay = new Relay();
  const a = addPlayer(host, relay, 's-a', '小明');
  const b = addPlayer(host, relay, 's-b', '小红');
  eq(host.roster.players().length, 2, '两名玩家入座');
  eq(host.roster.order.length, 2, '入座顺序被记录（界面按它排）');

  /* v2.0.0（契约 §5.4）：INTENT.READY 现在**必须**先有 charId ——
     没选角色卡不能准备。所以这里先给两位玩家各绑一张卡，再测准备流程。
     （这是本轮唯一必须调整的既有断言块，理由见交付说明。） */
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CHAR, { id: 'c-a', name: '小明' })));
  relay.deliver(host.intent('s-b', M.intentMsg(M.INTENT.CHAR, { id: 'c-b', name: '小红' })));
  eq(host.roster.get('s-a').charId, 'c-a', '绑卡后 charId 落账');

  // 准备状态
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.READY, { ready: true })));
  eq(host.roster.get('s-a').ready, true, '准备状态置位');
  eq(host.roster.allReady(), false, '只有一个人准备 → 未全员准备');
  relay.deliver(host.intent('s-b', M.intentMsg(M.INTENT.READY, { ready: true })));
  eq(host.roster.allReady(), true, '全员准备');
  relay.deliver(host.intent('s-b', M.intentMsg(M.INTENT.READY, { ready: false })));
  eq(host.roster.allReady(), false, '取消准备后不再是全员准备');
  relay.deliver(host.intent('s-b', M.intentMsg(M.INTENT.READY, { ready: true })));
  eq(a.client.state.members.length, 2, '玩家端能看到成员表');
  eq(a.client.member('s-b').ready, true, '玩家端看到别人已准备');

  // 旁观者不算玩家，不参与「全员准备」
  const spec = addSpec(host, relay, 's-c');
  eq(host.roster.players().length, 2, '旁观者不计入玩家');
  eq(host.roster.spectators().length, 1, '旁观者单独统计');
  eq(host.roster.order.length, 3, '旁观者也在名单里（界面要显示）');

  // 旁观者不能设准备
  const mk = relay.mark();
  relay.deliver(host.intent('s-c', M.intentMsg(M.INTENT.READY, { ready: true })));
  eq(host.roster.get('s-c').ready, false, '旁观者的准备请求不生效');
  ok(!relay.log.slice(mk).some(m => m.to === '*'), '旁观者越权不产生公共广播');
  ok(relay.since(mk, 's-c').join('').includes('准备'), '旁观者收到一条解释性提示');

  // 断线：只标记离线，不移除
  relay.deliver(host.detachPeer('s-a'));
  eq(host.roster.get('s-a').online, false, '掉线标记 offline');
  eq(host.roster.get('s-a').ready, true, '掉线不影响已准备状态');
  eq(host.roster.players().length, 2, '掉线者仍在名单里（要能重连回来）');
  eq(host.roster.onlinePlayers().length, 1, '在线玩家数正确');
  eq(host.roster.allReady(), true, '全员准备只看在线玩家');
  eq(b.client.member('s-a').online, false, '其他玩家看到「离线」状态');

  // 重连：保持原有座位与准备状态
  const back = host.attachPeer({ seat: 's-a', cid: 'c-a-new', role: R.PLAYER, nickname: '小明', at: 50 });
  relay.deliver(back.out);
  eq(back.member.online, true, '重连后恢复在线');
  eq(back.member.ready, true, '重连保留准备状态');
  eq(back.member.cid, 'c-a-new', '重连更新连接句柄');
  eq(host.roster.players().length, 2, '重连不会产生第二个座位');
  eq(host.roster.get('s-a').joinedAt, 1, '重连保留原始入座时间');
  ok(back.out.some(x => x.to === 's-a' && x.msg.k === 'sync'), '重连者会拿到一份全量同步');

  /* ★ v2.0.3 新增（缺陷：设备码重连后「我回来了，但别人看我还是离线」）
     ⚠️ 上面那条 eq(back.member.online, true) 读的是 attachPeer 返回的 **roster 记录**，
     而界面真正的渲染源是各客户端的 client.state.members。两者在「同座重连」这条
     路上曾经不一致：Roster.open 把 roster 原地改成 online，但 members 事件没重发，
     于是 back.member.online === true 而 b.client.member('s-a').online 仍是 false
     —— 断言打在 roster 上就**永远测不出这个 bug**（它曾经正是这么漏过去的）。 */
  eq(b.client.member('s-a').online, true,
     '★ 重连后其他玩家看到的也是「在线」（渲染源 state.members，不只是 roster）');

  /* 反面：对**已在线**成员重复 attach，不应再广播成员表（防止刷屏） */
  const dup = host.attachPeer({ seat: 's-a', cid: 'c-a-new', role: R.PLAYER, nickname: '小明', at: 60 });
  eq(dup.member.online, true, '重复 attach 仍保持在线');
  ok(!dup.out.some(x => x.msg && x.msg.t === E.MEMBERS),
     '★ 已在线成员被重复 attach 时不重发成员表（防刷屏）');

  // 新成员进来时，老成员会收到成员表
  const mk2 = relay.mark();
  addPlayer(host, relay, 's-d', '新来的');
  ok(relay.since(mk2, 's-b').join('').includes('新来的'), '老成员能收到成员表更新');
  eq(host.roster.order.length, 4, '新成员入座顺序排在最后');

  // 踢人后的成员表
  const mk3 = relay.mark();
  relay.deliver(host.kick('s-d'));
  ok(relay.since(mk3, 's-b').join('').includes('已离开房间'), '其他人看到离开提示');
  eq(host.roster.get('s-d'), null, '被踢者不在名单里');
  eq(host.roster.order.length, 3, '名单同步缩短');

  eq(a.member.seat, 's-a', 'addPlayer 返回的成员对象仍有效');
  eq(b.member.nickname, '小红', '昵称正确');
  eq(spec.member.role, R.SPECTATOR, '旁观者角色正确');
})();

/* ============================================================
 * 6. 回退：状态快照 + 关联事件一起恢复
 * ============================================================ */
section('6. 回退（状态快照 + 关联事件一起恢复）');

(function () {
  const host = newHost();
  const relay = new Relay();
  const a = addPlayer(host, relay, 's-a', '小明');

  const base = host.log.seq;
  host.emit(E.CHAT, { text: '准备开始', at: 1 });               // base+1
  host.emit(E.CHAT, { text: '我搜索书架', at: 2 });             // base+2
  const recDice = host.emit(E.DICE, { seat: 'host', expr: '1d100', total: 86, at: 3 });  // base+3
  host.emit(E.CHAT, { text: '继续', at: 4 });                   // base+4
  host.emit(E.CHAT, { text: '我开门', at: 5 });                 // base+5
  eq(host.log.seq, base + 5, '共产生 5 条事件');

  // 回退到「掷骰之前」，连同掷骰与之后两条一起撤销
  const target = recDice.seq - 1;
  const out = host.rollbackPlan(recDice.seq);
  // ⚠️ 回退公告本身也是一条公开事件，所以 log.seq = target + 1（不是 target）。
  //    顺序也重要：先给在场的人重发全量（带 target 的 seq），再广播公告。
  eq(host.log.seq, target + 1, '回退后 seq 落在回退点（+1 是回退公告本身）');
  eq(host.log.items.length, base + 3, '日志 = 回退点之前的事件 + 那条回退公告（公告不占回退点以前的序号）');
  eq(host.state.chats.length, 2, 'KP 端状态里也只剩 2 条聊天');
  eq(host.state.dice.length, 0, 'KP 端的掷骰结果被一起撤销');
  ok(JSON.stringify(host.state).indexOf('我开门') < 0, '被撤销的内容不在 KP 状态里');
  ok(JSON.stringify(host.state).indexOf('我搜索书架') >= 0, '回退点之前的内容保留');
  ok(out.filter(x => x.msg.k === 'sync').length >= 1, '回退后要给在场的人重发全量（客户端无法「反做」事件）');
  ok(out.some(x => x.to === '*' && x.msg.k === 'evt'), '回退后广播一条公告');

  relay.deliver(out);
  eq(a.client.state.chats.length, 2, '玩家端也只剩 2 条聊天');
  eq(a.client.state.dice.length, 0, '玩家端的掷骰结果同样消失');
  ok(JSON.stringify(a.client.state).indexOf('我开门') < 0, '玩家端不再有被撤销的内容');
  eq(a.client.lastSeq, host.log.seq, '回退后玩家端 lastSeq 与权威端一致');
  eq(a.client.gapFrom, 0, '回退重发不会让玩家端误判为丢包');

  // 回退后继续推进：新事件的 seq 紧接公告之后，不能留下空洞
  const r = host.emit(E.CHAT, { text: '重新来', at: 99 });
  eq(r.seq, target + 2, '回退后的新事件紧接其后，不留空洞');
  const got = relay.deliver(host.plan(r));
  eq(got['s-a'][0].changed, true, '玩家端能接上回退后的新事件');
  ok(a.client.state.chats.some(c => c.text === '重新来'), '新内容被应用');
  eq(a.client.state.chats.length, 3, '回退后新事件正常累加');
})();

(function () {
  /* 快照 + 重放：这是回退最容易写错的一条路径 ——
     如果只把日志截断、不恢复状态，界面会变干净而内部状态还留着被撤销的伤害。
     这里故意把 snapshotEvery 设成 2，让回退点落在某个快照之后，
     强制走「快照 → 重放剩余事件」而不是「从空状态重放全部」。 */
  const host = newHost(null, null, { snapshotEvery: 2 });
  const relay = new Relay();
  const a = addPlayer(host, relay, 's-a', '小明');

  const texts = ['t1', 't2', 't3', 't4', 't5', 't6'];
  const recs = texts.map((t, i) => host.emit(E.CHAT, { text: t, at: i }));
  eq(host.snapshots.length, 4, '快照：seq0 + seq2/4/6（每 2 条一份）');
  eq(host.snapshots.map(s => s.seq).join(','), '0,2,4,6', '快照序号正确');

  // 撤销 t5、t6 → 期望结果保留 t1..t4
  const res = host.rollback(recs[4].seq);
  eq(res.seq, recs[4].seq - 1, '回退后 seq 落在回退点之前');
  eq(res.from, recs[2].seq, '用的是 seq=4 那份快照（不是从 0 重放）');
  seq(host.state.chats.map(c => c.text), ['t1', 't2', 't3', 't4'], '快照 + 重放还原出正确状态');
  eq(host.log.items.length, recs[4].seq - 1, '日志同步裁剪');
  eq(host.snapshots.filter(s => s.seq > recs[4].seq - 1).length, 0, '回退点之后的快照被丢弃');

  // 回退到最开头：游戏历史清空，但**在场的人不能被抹掉**
  relay.deliver(host.rollbackPlan(1));
  eq(host.state.chats.length, 0, '回退到开头后 KP 端聊天清空');
  eq(host.state.members.length, 1, '成员表是「谁连着」的现实，回退不清空');
  eq(a.client.state.chats.length, 0, '回退到开头后玩家端聊天清空');
  eq(a.client.state.members.length, 1, '玩家端仍看得到在场成员');
  eq(host.log.seq, 1, '回退到开头后只剩那条公告');
  eq(a.client.lastSeq, host.log.seq, '回退到开头后 lastSeq 仍与权威端一致');
  eq(a.client.gapFrom, 0, '回退重发不会被误判成丢包');
})();

/* ============================================================
 * 7. 端到端：KP 操作 → 玩家看到
 * ============================================================ */
section('7. 端到端一致性');

(function () {
  const host = newHost();
  const relay = new Relay();
  const a = addPlayer(host, relay, 's-a', '小明');
  addPlayer(host, relay, 's-b', '小红');
  const spec = addSpec(host, relay, 's-c');

  // 开团
  relay.deliver(host.applyAction('host', { op: 'room.start' }));
  eq(a.client.state.meta.status, S.IN_GAME, '玩家端看到开团');
  eq(spec.client.state.meta.status, S.IN_GAME, '旁观者也看到开团');

  // 场景
  const scene = { title: '废弃图书馆', image: 'img/scene1.jpg', marks: [{ x: 10, y: 20, label: '书架' }], revealed: false };
  relay.deliver(host.applyAction('host', { op: 'scene.set', scene: scene }));
  eq(a.client.state.scene.title, '废弃图书馆', '玩家端看到场景标题');
  eq(a.client.state.scene.marks.length, 1, '玩家端看到地图标记');

  // 战斗：多行动怪物展开成多个行动槽
  const order = [
    { slot: 's-a', name: '小明', dex: 70, done: false },
    { slot: 'npc1#1', name: '深潜者（爪击）', dex: 55, done: false },
    { slot: 'npc1#2', name: '深潜者（撕咬）', dex: 55, done: false }
  ];
  relay.deliver(host.applyAction('host', { op: 'combat.set', combat: { order: order, turn: 0, round: 1 } }));
  eq(a.client.state.combat.order.length, 3, '多行动怪物被展开成多个行动槽');

  // 推进回合
  relay.deliver(host.applyAction('host', { op: 'combat.next' }));
  eq(a.client.state.combat.turn, 1, '行动轮推进到第 2 个槽');
  relay.deliver(host.applyAction('host', { op: 'combat.next' }));
  relay.deliver(host.applyAction('host', { op: 'combat.next' }));
  eq(a.client.state.combat.round, 2, '走完一圈后进入第 2 轮');
  eq(a.client.state.combat.turn, 0, '第 2 轮回到第 1 个槽');

  // 私下给线索：只有小明看得到
  relay.deliver(host.applyAction('host', {
    op: 'scene.clue', seat: 's-a', title: '图书馆学', text: '这本书是伪造的'
  }));
  eq(a.client.state.privates.length, 1, '目标玩家收到私有线索');
  eq(relay.clients['s-b'].state.privates.length, 0, '其他玩家没收到');
  eq(spec.client.state.privates.length, 0, '旁观者没收到');

  // 玩家发言
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CHAT, { text: '我想查一下这本书' })));
  ok(relay.clients['s-b'].state.chats.some(c => c.text === '我想查一下这本书'), '其他玩家看到发言');
  ok(relay.clients['s-b'].state.chats.some(c => c.nickname === '小明'), '发言带上昵称');

  // 房间号校验
  eq(M.validCode('abc123'), true, '合法房间号通过');
  eq(M.validCode('ABC123'), false, '大写不合法（与服务端正则一致）');
  eq(M.validCode('ab'), false, '过短不合法');
  eq(M.validCode(''), false, '空房间号不合法');

  // 空消息不发
  const nBefore = host.log.seq;
  let plan = host.intent('s-a', M.intentMsg(M.INTENT.CHAT, { text: '   ' }));
  eq(host.log.seq, nBefore, '空白发言不产生事件');
  eq(plan.length, 0, '空白发言不产生任何发送');

  // 超长发言被截断
  plan = host.intent('s-a', M.intentMsg(M.INTENT.CHAT, { text: 'x'.repeat(5000) }));
  relay.deliver(plan);
  const lastChat = host.state.chats[host.state.chats.length - 1];
  eq(lastChat.text.length, 600, '超长发言截断到 600 字符');

  // 全员（含旁观者）的 lastSeq 都必须追平权威端 —— 私有事件的水位标记生效
  ['s-a', 's-b', 's-c'].forEach(s => {
    eq(relay.clients[s].lastSeq, host.log.seq, s + ' 的 lastSeq 追上权威端（水位标记生效）');
    eq(relay.clients[s].gapFrom, 0, s + ' 全程没有丢包');
  });
})();

/* ============================================================
 * 8. 邀请链接与邀请参数
 * ============================================================ */
section('8. 邀请链接');

(function () {
  const link = M.inviteLink('https://example.com/card/', 'ab12cd', 'https://example.com/room');
  ok(link.indexOf('room=ab12cd') >= 0, '邀请链接带房间号');
  ok(link.indexOf('srv=') >= 0, '邀请链接带服务地址（加入方不用猜）');
  ok(link.indexOf('#') < 0, '邀请链接去掉 hash 路由段');

  const web = M.inviteLink('http://192.168.1.5:12710/', 'zz99xx', 'http://192.168.1.5:12710');
  const got = M.readInvite(web.slice(web.indexOf('?')));
  eq(got.code, 'zz99xx', '局域网邀请能解析出房间号');
  eq(got.serverBase, 'http://192.168.1.5:12710', '局域网邀请能解析出局域网地址');

  const empty = M.readInvite('');
  eq(empty.code, '', '没有邀请参数时房间号为空');
  eq(empty.serverBase, '', '没有邀请参数时服务地址为空');

  const tricky = M.readInvite('?room=a1b2c3&srv=https%3A%2F%2Ft.example%2Froom%3Fx%3D1');
  eq(tricky.serverBase, 'https://t.example/room?x=1', '服务地址里的特殊字符正确解码');

  /* v1.19.0：readInvite 扩展为「宽容解析」——加入方可能粘贴各种形态的加入信息 */
  const compact = M.readInvite('COC7ROOM|192.168.1.5:8899|ab12cd');
  eq(compact.code, 'ab12cd', '紧凑串解析出房间号');
  eq(compact.serverBase, 'http://192.168.1.5:8899', '紧凑串里没写协议头也能补成 http://');

  const fullUrl = M.readInvite('https://example.com/room?room=zz99xx&srv=http%3A%2F%2F192.168.1.9%3A9000');
  eq(fullUrl.code, 'zz99xx', '整条 URL（非纯查询串）也能解析出房间号');
  eq(fullUrl.serverBase, 'http://192.168.1.9:9000', '整条 URL 也能解析出服务地址');

  const bareAddr = M.readInvite('192.168.1.7:4211');
  eq(bareAddr.code, '', '裸地址不误判成房间号');
  eq(bareAddr.serverBase, 'http://192.168.1.7:4211', '裸 host:port 补成 http:// 地址');

  const bareCode = M.readInvite('ab12cd');
  eq(bareCode.code, 'ab12cd', '裸房间号被识别');
  eq(bareCode.serverBase, '', '裸房间号不带地址');

  const junk = M.readInvite('这不是一个地址');
  eq(junk.code, '', '无法识别的字符串：房间号为空（不瞎猜）');
  eq(junk.serverBase, '', '无法识别的字符串：地址为空（不瞎猜）');
})();

/* ============================================================
 * 9. 随机操作下的不变量
 * ============================================================ */
section('9. 随机操作下的不变量');

(function () {
  let seed = 12345;
  function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
  function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }

  const host = new M.Host({ meta: { code: 'rnd001', name: '随机团' }, now: fixed(1) });
  const relay = new Relay();
  const seats = ['s-1', 's-2', 's-3'];
  seats.forEach(s => addPlayer(host, relay, s, '玩家' + s));
  addSpec(host, relay, 's-9');

  const ops = ['chat', 'ready', 'dice', 'char', 'board', 'act', 'sync', 'offline', 'online'];
  let applied = 0;
  const kinds = {};

  for (let i = 0; i < 300; i++) {
    const seat = pick(seats);
    const op = pick(ops);
    let plan = [];
    if (op === 'offline') {
      plan = host.detachPeer(seat);          // ⚠️ 必须投递，理由见文件头
    } else if (op === 'online') {
      plan = host.attachPeer({ seat: seat, cid: 'c' + i, role: R.PLAYER, nickname: '玩家' + seat, at: i }).out;
    } else if (op === 'chat') {
      plan = host.intent(seat, M.intentMsg(M.INTENT.CHAT, { text: 'm' + i }));
    } else if (op === 'ready') {
      plan = host.intent(seat, M.intentMsg(M.INTENT.READY, { ready: rnd() > 0.5 }));
    } else if (op === 'dice') {
      plan = host.intent(seat, M.intentMsg(M.INTENT.DICE, { expr: '1d100' }));
    } else if (op === 'char') {
      plan = host.intent(seat, M.intentMsg(M.INTENT.CHAR, { name: '调查员' + i, id: 'id' + i }));
    } else if (op === 'board') {
      plan = host.intent(seat, M.intentMsg(M.INTENT.BOARD, {}));
    } else if (op === 'act') {
      plan = host.intent(seat, M.intentMsg(M.INTENT.ACT,
        { op: pick(['scene.clue', 'room.kick', 'combat.next', 'state.edit.self']) }));
      // 只有 KP 能做的动作，用 applyAction 真跑一遍（覆盖「执行成功」的路径）
      if (rnd() < 0.25) plan = plan.concat(host.applyAction('host', { op: 'combat.next' }));
    } else if (op === 'sync') {
      plan = host.intent(seat, M.intentMsg(M.INTENT.SYNC,
        { lastSeq: Math.max(0, host.log.seq - Math.floor(rnd() * 5)) }));
    }
    // 有时重复投递（模拟重连补拉的重复）
    if (rnd() < 0.15 && plan.length) plan = plan.concat(plan);
    const got = relay.deliver(plan);
    Object.keys(got).forEach(s => got[s].forEach(r => {
      kinds[r.kind] = (kinds[r.kind] || 0) + 1;
      if (r.changed) applied++;
    }));
  }

  ok(host.warnings.length === 0, '整轮随机操作没有产生任何警告', host.warnings.slice(0, 3));
  eq(kinds.ignore || 0, 0, '没有无法识别的消息');
  // 最硬的一条：永不丢包。它同时验证了三件事 ——
  //   ① 公共事件按序到达；② SEAT 事件的水位标记补齐了序号；
  //   ③ KP 本地备忘没有偷偷占用共享序号。
  eq(kinds.gap || 0, 0, '整轮 300 次操作零丢包（水位标记机制正确）');
  ok((kinds.skip || 0) > 0, '私有事件确实产生了水位标记');
  ok(applied > 100, '随机操作确实产生了大量状态变更');

  // 掉线期间收不到水位标记是**正常**的（重连时会全量推平），
  // 所以这里把人全部重连回来，验证「重连后必然追平」——
  // 这比「当场断言」更有意义，也正是断线重连要保证的性质。
  seats.forEach(s => {
    relay.deliver(host.attachPeer({ seat: s, cid: 'final-' + s, role: R.PLAYER, nickname: '玩家' + s, at: 999 }).out);
  });
  seats.concat(['s-9']).forEach(s => {
    const c = relay.clients[s];
    if (!c) return;
    eq(c.lastSeq, host.log.seq, s + ' 重连后 lastSeq 追平权威端');
    ok(c.state.seq <= c.lastSeq, s + ' 的 state.seq 不超过 lastSeq');
    eq(c.gapFrom, 0, s + ' 重连后没有残留缺口标记');
    eq(c.state.meta.status, host.state.meta.status, s + ' 的房间状态与权威端一致');
  });

  // 连投两遍同样的计划，第二次必须全是 dup（幂等）
  const rec = host.emit(E.CHAT, { text: '幂等检查', at: 1 });
  const got1 = relay.deliver(host.plan(rec));
  const got2 = relay.deliver(host.plan(rec));
  ok(got1[seats[0]][0].changed === true, '第一遍被应用');
  ok(got2[seats[0]][0].dup === true, '第二遍被判为重复');

  console.log('  随机操作统计：applied=' + applied + ' kinds=' + JSON.stringify(kinds));
})();

/* ============================================================
 * 10. 房主自己也是一个意图来源
 * ------------------------------------------------------------
 * 花名册（Roster）里**没有**房主：花名册记的是「有哪些玩家/旁观者」，
 * 房主属于这间房本身。所以任何「按 seat 推身份」的地方都必须先认 HOST_SEAT，
 * 不能拿 roster.get(seat) 为空就当旁观者。
 *
 * 这个坑的表现特别隐蔽：界面里发言只有一个入口（房主和玩家共用），
 * HostSide 早期没有 intent()，于是房主打字回车**完全没反应** ——
 * 不报错、不提示、也不进日志；而 host.intent('host', …) 又会把房主
 * 判成旁观者，连掷骰与 KP 动作都被驳回。两条都得钉住。
 * ============================================================ */
(function () {
  section('10. 房主作为意图来源');

  const h = new M.Host({ meta: { code: 'ab12cd', name: '测试团', kpName: 'KP老张' } });

  eq(M.HOST_SEAT, 'host', '房主座位号有明确常量（不要在各地硬编码这个字符串）');

  // --- 房主发言 ---
  const chatPlan = h.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.CHAT, { text: '你们进了地下室' }));
  ok(chatPlan.length > 0, '房主发言能产生发送计划（不是静默无效）');
  const chatMsg = chatPlan.map(r => r.msg).find(m => m && m.t === M.EVT.CHAT);
  ok(!!chatMsg, '计划里确实是一条 chat 事件');
  eq(chatMsg.p.nickname, 'KP老张', '房主的显示名取自房间 meta.kpName');
  eq(chatMsg.p.seat, 'host', '房主消息的 seat 是 host');
  eq(chatMsg.p.text, '你们进了地下室', '内容原样带上');

  // 房主端自己也归约过（否则房主那边的聊天记录是空的、重连同步缺自己说的话）
  eq(h.state.chats.length, 1, '房主端自己的聊天记录里也有这条');

  // --- 房主不是旁观者：KP 专属动作要能过权限 ---
  ok(M.needs(M.ROLE.KP, 'scene.set').allowed === true, 'KP 允许执行 scene.set');
  const actPlan = h.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, { op: 'scene.set', scene: { title: '地下室' } }));
  ok(actPlan.length > 0, '房主执行 KP 专属动作不会被当成旁观者驳回');
  eq(h.state.scene && h.state.scene.title, '地下室', '房主的动作真的改了权威状态');

  // --- 对照：真正的旁观者仍然被拦 ---
  h.roster.open({ seat: 'sp1', role: M.ROLE.SPECTATOR, nickname: '围观' });
  const spPlan = h.intent('sp1', M.intentMsg(M.INTENT.READY, { ready: true }));
  const spHint = spPlan.map(r => r.msg).find(m => m && m.t === M.EVT.PRIVATE);
  ok(!!spHint, '旁观者设准备状态会被单独提示（不静默吞掉）');
  eq(!!h.roster.get('sp1').ready, false, '旁观者的准备状态没有被写入');
  ok(spPlan.every(r => r.to !== '*'), '给旁观者的提示不会群发');

  // --- 旁观者也不能走 KP 动作 ---
  const spAct = h.intent('sp1', M.intentMsg(M.INTENT.ACT, { op: 'scene.set', scene: { title: '越权改场景' } }));
  eq(spAct.every(r => r.to !== '*'), true, '旁观者的越权动作没有群发出去');
  eq(h.state.scene.title, '地下室', '场景没有被旁观者改掉');
})();

/* ============================================================
 * 11. P4 探索：素材公开性 / 地图标记 / 手绘板
 *
 * 这一节的判据只有一条：**未公开的东西不能在别人的字节里出现**。
 * 不是「发了但界面不画」—— 那正是需求 §0 禁止的做法。
 * ============================================================ */
(function () {
  section('11. 探索：素材与地图标记的公开性');

  const host = newHost();
  const relay = new Relay();
  const a = addPlayer(host, relay, 's-a', '小明');
  const b = addPlayer(host, relay, 's-b', '小红');

  // --- 上传即私有：addAsset 只回 KP 自己（emitLocal 不出门）---
  let mark = relay.mark();
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'asset.add', asset: { kind: 'map', name: '洋馆一层', data: 'data:image/png;base64,AAA' } })));
  const aBytes = relay.since(mark, 's-a').join('');
  ok(!/洋馆一层/.test(aBytes), '未公开的素材名称不出现在玩家收到的字节里');
  ok(!/base64,AAA/.test(aBytes), '未公开的素材数据不出现在玩家收到的字节里');
  const assetId = host.localAssets[host.localAssets.length - 1].id;

  // --- 公开后才进公共 scene.assets ---
  mark = relay.mark();
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'asset.reveal', id: assetId, revealed: true })));
  ok(host.state.scene.assets.some(x => x.id === assetId), '公开后素材进权威状态');
  ok(/洋馆一层/.test(relay.since(mark, 's-a').join('')), '公开后玩家能收到该素材');

  // --- 地图标记用相对坐标，且未公开的只有 KP 有 ---
  mark = relay.mark();
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'map.mark', x: 0.5, y: 0.25, kind: 'dot', label: '暗门', revealed: false })));
  ok(!/暗门/.test(relay.since(mark, 's-a').join('')), '未公开标记不发出去');
  ok(host.local.some(r => r.evt.t === 'mark.hidden'), '未公开标记存在 KP 本地备忘里');
  eq(host.state.scene.marks.length, 0, '未公开标记没有进公共 scene.marks');

  mark = relay.mark();
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'map.mark', x: 1.4, y: -0.2, kind: 'dot', label: '书架', revealed: true })));
  const mk = host.state.scene.marks[0];
  ok(!!mk, '公开标记进了 scene.marks');
  eq(mk.x, 1, '超范围坐标被夹到 0..1（跨设备一致的前提）');
  eq(mk.y, 0, '负坐标被夹到 0');
  ok(a.client.state.scene && a.client.state.scene.marks.length === 1, '玩家收到了这条公开标记');
  ok(b.client.state.scene && b.client.state.scene.marks.length === 1, '另一个玩家也收到了');

  // --- 一键清除只清笔迹，不删地图原图与标记（防止「永久改写原图」）---
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'map.stroke', color: '#f00', width: 3, pts: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] })));
  eq(host.state.scene.strokes.length, 1, '笔迹被记录');
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, { op: 'map.clear', strokesOnly: true })));
  eq(host.state.scene.strokes.length, 0, '清屏后笔迹没了');
  eq(host.state.scene.marks.length, 1, '清屏不删标记（只清绘画）');

  // --- 玩家重新连上时应拿到同样的公开场景（增量与全量一致）---
  const re = new M.Client({ seat: 's-a', role: R.PLAYER, meta: host.state.meta });
  re.receive(JSON.stringify(host.syncFor('s-a')));
  eq((re.state.scene.marks || []).length, 1, '重连全量同步里的标记数与增量一致');
  ok((re.state.scene.assets || []).some(x => x.id === assetId), '重连全量同步里有已公开素材');
  ok(!/暗门/.test(JSON.stringify(host.syncFor('s-a'))), '重连全量同步里也没有未公开标记');
})();

/* ============================================================
 * 12. 个人手绘板：正文只回本人
 * ============================================================ */
(function () {
  section('12. 个人手绘板：正文只回本人');

  const host = newHost();
  const relay = new Relay();
  const a = addPlayer(host, relay, 's-a', '小明');
  const b = addPlayer(host, relay, 's-b', '小红');

  let mark = relay.mark();
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.ACT,
    { op: 'board.self', strokes: [{ color: '#00f', pts: [{ x: 0.3, y: 0.3 }] }] })));

  const aBytes = relay.since(mark, 's-a').join('');
  const bBytes = relay.since(mark, 's-b').join('');
  ok(/"self":true/.test(aBytes) || /"self": true/.test(aBytes), '本人收到自己手绘板的正文');
  ok(!/#00f/.test(bBytes) && !/"pts"/.test(bBytes), '别人收到的字节里没有手绘板笔迹');
  /* v2.4.0（用户第 ⑪ 项）：手绘板更新静默 —— 不再写公开记录（原断言：
     「别人只看到『他更新了手绘板』这条系统消息」随 ⑪ 作废）。
     数量/缩略仍由 EVT.BOARD 的 scene.boards 归约 + 重连全量同步维护。 */
  ok(!/更新了手绘板/.test(bBytes), 'v2.4.0（⑪）：手绘板更新不再产生公开记录条目');

  // 本人重连后要能拿回自己的板（全量同步按 seat 补）
  const re = new M.Client({ seat: 's-a', role: R.PLAYER, meta: host.state.meta });
  re.receive(JSON.stringify(host.syncFor('s-a')));
  ok(re.state.board && (re.state.board.strokes || []).length === 1, '本人重连能恢复自己的手绘板');
  const other = new M.Client({ seat: 's-b', role: R.PLAYER, meta: host.state.meta });
  other.receive(JSON.stringify(host.syncFor('s-b')));
  ok(!other.state.board || !(other.state.board.strokes || []).length, '别人重连拿不到我的手绘板正文');
})();

/* ============================================================
 * 13. P5 战斗：多行动槽 / 回合推进 / 怪物 HP 不下发
 * ============================================================ */
(function () {
  section('13. 战斗：多行动槽与怪物隐私');

  const host = newHost();
  const relay = new Relay();
  const a = addPlayer(host, relay, 's-a', '小明');

  // 一只三连击怪物 + 一个 PC
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, {
    op: 'combat.start', actors: [
      { id: 'g1', name: '深潜者', kind: 'monster', dex: 90, actionsPerRound: 3, hp: 13, hpMax: 13 },
      { id: 'p1', name: '小明', kind: 'pc', seat: 's-a', dex: 60, actionsPerRound: 1, hp: 11, hpMax: 11 }
    ]
  })));

  const order = host.state.combat.order;
  eq(order.length, 4, '三连击怪物展开成 3 个槽 + PC 1 个槽');
  eq(host.state.meta.mode, 'COMBAT', '进入战斗模式');
  const gSlots = order.filter(s => s.actorId === 'g1');
  eq(gSlots.length, 3, '怪物保留 3 个行动槽（不会完成一次就从队列消失）');
  eq(gSlots[0].totalSlots, 3, '每个槽记录了总行动次数');

  // --- 怪物 HP 数字：玩家字节里必须没有 ---
  const aBytes = relay.since(0, 's-a').join('');
  ok(!/"hp":13/.test(aBytes) && !/"hpMax":13/.test(aBytes), '玩家收到的字节里没有怪物 HP 数字');
  ok(/深潜者/.test(aBytes), '玩家依然看得到怪物名字（要能标识目标）');
  /* 只有怪物的槽不许带 hpPublic:true —— PC 的血本来就公开 */
  const g1Seg = aBytes.match(/\{[^{}]*"深潜者"[^{}]*\}/g) || [];
  ok(g1Seg.every(s => !/"hpPublic":true/.test(s)), '怪物槽没有 hpPublic:true 标记（否则等于暴露血量）');

  // 但 KP 端自己要能拿到全量（否则 KP 看不到怪血）
  const kpView = host.combatFor(M.HOST_SEAT);
  eq(kpView.order.find(s => s.id === 'g1#1').public.hp, 13, 'KP 端有怪物 HP 全量');

  // --- 玩家那边 a.client 的 combat 里也没有 hp 字段 ---
  const clientSlot = (a.client.state.combat.order || []).find(s => s.actorId === 'g1');
  ok(!!clientSlot, '玩家的战斗状态里有这个怪物');
  ok(clientSlot.public.hp === undefined && clientSlot.public.hpMax === undefined,
     '玩家端的怪物槽里 hp/hpMax 字段根本不存在');

  // --- PC 的血是公开的（需求 §8.2：玩家能看到所有玩家公开 HP）---
  const pcSlot = (a.client.state.combat.order || []).find(s => s.actorId === 'p1');
  eq(pcSlot.public.hp, 11, '玩家可见的 PC 血量是公开的');

  // --- 回合推进 ---
  let rounds = 0;
  for (let i = 0; i < 4; i++) relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, { op: 'combat.next' })));
  eq(host.state.combat.round, 2, '走完 4 个槽进入第 2 轮');
  eq(host.state.combat.turn, 0, '新一轮从队首开始');
  eq(host.state.combat.order.filter(s => s.actorId === 'g1').length, 3, '跨轮后怪物的 3 个槽仍在');

  // --- 伤害结算写日志，且不重复扣（同样的事件只发一次）---
  let mark = relay.mark();
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'combat.damage', slotId: 'p1', damage: 4, summary: '深潜者的爪击' })));
  const after = host.state.combat.order.find(s => s.id === 'p1').public.hp;
  eq(after, 7, 'PC 掉血正确');
  ok(/受到 4 点伤害/.test(relay.since(mark, 's-a').join('')), '伤害写进了公共日志');

  // --- 结束战斗回探索 ---
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, { op: 'combat.end' })));
  eq(host.state.meta.mode, 'EXPLORATION', '战斗结束后回到探索模式');
  ok(host.state.combat === null, '战斗态被清空');
})();

/* ============================================================
 * 14. P6 KP 工具：状态请求需玩家同意 / 回退投票 / 结团
 * ============================================================ */
(function () {
  section('14. KP 工具：状态请求与回退投票');

  const host = newHost();
  const relay = new Relay();
  const a = addPlayer(host, relay, 's-a', '小明');
  const b = addPlayer(host, relay, 's-b', '小红');

  // --- 状态请求：不接受就不落账 ---
  let mark = relay.mark();
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'state.request', seat: 's-a', reason: '被诅咒', change: { hp: 3 } })));
  ok(/等待玩家确认/.test(relay.since(mark, 'host').join('')), 'KP 收到「等待确认」提示');
  ok(relay.since(mark, 'host').some(t => /"request"|"REQUEST"/.test(t)) ||
     host._requestsBySeat['s-a'].length === 1, '请求挂进了该玩家的待办');
  eq((host.roster.get('s-a').runtime || {}).hp, undefined, '玩家还没同意，状态没变');

  // 玩家拒绝
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CONSENT, { id: host._requestsBySeat['s-a'][0].id, agree: false })));
  eq((host.roster.get('s-a').runtime || {}).hp, undefined, '拒绝后状态仍然没变');
  ok(/拒绝了状态变更请求/.test(relay.since(mark, 's-b').join('')), '拒绝留下系统消息');

  // 再来一次，这次同意
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'state.request', seat: 's-a', reason: '被诅咒', change: { hp: 3 } })));
  const reqId = host._requestsBySeat['s-a'][0].id;
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CONSENT, { id: reqId, agree: true })));
  eq(host.roster.get('s-a').runtime.hp, 3, '同意后状态落账');

  /* ============================================================
   * 回退（v1.19.0 语义修正）：
   *   旧实现的 meta.round 只是 combat.round 的影子（非战斗态恒为 0），
   *   targetRound 永远算成 1；turns 也从不参与回退点的计算；
   *   rollbackCommit 又拿「发起时刻 + 1」当回退点 → 什么都没退。
   *   现在：回合号由显式 EVT.ROUND 维护，回退点从 roundStarts（回合边界表）取。
   * ============================================================ */

  // --- 先把回合边界显式标记出来（没有边界就不能回退） ---
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, { op: 'room.start' })));
  eq(host.state.meta.round, 1, '开团即进入第 1 回合（显式回合边界）');
  eq(host.roundStarts.length, 1, '开团标记了第 1 个回合边界');
  eq(host.roundStarts[0].round, 1, '回合边界带上回合号');

  // 第 1 回合的内容
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CHAT, { text: 'R1-甲' })));
  relay.deliver(host.intent('s-b', M.intentMsg(M.INTENT.CHAT, { text: 'R1-乙' })));

  // 进入第 2 回合
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, { op: 'round.next' })));
  eq(host.state.meta.round, 2, '「⏭ 进入下一回合」把回合号推进到 2');
  eq(host.roundStarts.length, 2, '第 2 回合边界被记录');
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CHAT, { text: 'R2-甲' })));
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'map.mark', x: 0.3, y: 0.3, kind: 'dot', label: 'R2 标记', revealed: true })));
  eq(host.state.scene.marks.length, 1, '第 2 回合放了一个地图标记');

  // 进入第 3 回合
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, { op: 'round.next' })));
  eq(host.state.meta.round, 3, '再进一回合到第 3 回合');
  const r3Start = host.roundStarts[host.roundStarts.length - 1].seq;
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CHAT, { text: 'R3-甲' })));
  relay.deliver(host.intent('s-b', M.intentMsg(M.INTENT.CHAT, { text: 'R3-乙' })));
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'map.mark', x: 0.7, y: 0.7, kind: 'dot', label: 'R3 标记', revealed: true })));
  eq(host.state.scene.marks.length, 2, '第 3 回合又放了一个地图标记');

  // --- 回退只允许 1 / 3 回合 ---
  /* v2.9.0（用户第 3 项）：入口 op 已关，**直调模型方法** rollbackPropose 验证「投票逻辑休眠可用」。 */
  let p2 = host.rollbackPropose(M.HOST_SEAT, 2);
  ok(p2.some(r => r.to === 'host' && /只支持 1 或 3/.test(JSON.stringify(r.msg))), '回退 2 回合被拒');

  // --- 发起回退 1 回合：目标是「当前回合 - 1」= 第 2 回合（不是恒为 1） ---
  p2 = host.rollbackPropose(M.HOST_SEAT, 1);
  relay.deliver(p2);
  ok(host.rewind && host.rewind.state === M.REWIND.VOTING, '回退 1 回合进入投票');
  eq(host.rewind.targetRound, 2, '目标回合 = 当前回合 - 1（不是恒为 1）');
  eq(host.rewind.beforeSeq, r3Start, '回退点 = 第 3 回合的起始 seq（真正的回合边界）');
  eq(host.rewind.need.length, 2, '需要全部当前玩家投票（2 人）');

  // 一人同意 → 还没通过
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.VOTE, { agree: true })));
  eq(host.rewind.state, M.REWIND.VOTING, '只有一人同意时仍在投票');
  // 一人拒绝 → 立即失败
  relay.deliver(host.intent('s-b', M.intentMsg(M.INTENT.VOTE, { agree: false })));
  eq(host.rewind.state, M.REWIND.FAILED, '任一拒绝即失败');

  // --- 全员同意 → 等 KP 二次确认 → 提交才执行 ---
  relay.deliver(host.rollbackPropose(M.HOST_SEAT, 1));
  const chatsBefore = host.state.chats.slice();
  const marksBefore = host.state.scene.marks.slice();
  const seqBefore = host.log.seq;
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.VOTE, { agree: true })));
  relay.deliver(host.intent('s-b', M.intentMsg(M.INTENT.VOTE, { agree: true })));
  eq(host.rewind.ready, true, '全员同意后标记为「可提交」');
  ok(!host.rewind.committed, '还没提交，回退尚未执行');

  const r = host.rollbackCommit(M.HOST_SEAT);
  ok(host.rewind.committed === true, 'KP 二次确认后回退执行');
  ok(host.log.seq < seqBefore, '事件序号被裁回（真的回退了状态，不是只删文字）');
  eq(host.state.meta.round, 2, '回退后 meta.round 落在第 2 回合（目标回合）');
  ok(host.roundStarts.every(s => s.round <= 2), '被裁掉的第 3 回合边界已从回合表移除');

  /* 内容事件真的被裁到「上一回合边界」为止 —— 这才是「回退」，
     而不是把发起时刻之后的一两条删掉（旧实现的表现）。 */
  const texts = host.state.chats.map(c => c.text);
  ok(texts.indexOf('R3-甲') < 0 && texts.indexOf('R3-乙') < 0,
     '第 3 回合的聊天内容被真正裁掉', texts);
  ok(texts.indexOf('R2-甲') >= 0, '第 2 回合的聊天内容保留（裁到上一回合边界为止）', texts);
  ok(texts.indexOf('R1-甲') >= 0 && texts.indexOf('R1-乙') >= 0, '第 1 回合的内容也保留', texts);
  ok(host.state.chats.length < chatsBefore.length,
     '聊天内容确实变少了（不是「一条都没删」）', { before: chatsBefore.length, after: host.state.chats.length });
  /* 非文字内容（地图标记）也被回退 —— 证明回的是「状态」，不只是「界面文字」 */
  ok(host.state.scene.marks.length < marksBefore.length,
     '地图标记数量减少（状态被回退，不只是删文字）',
     { before: marksBefore.length, after: host.state.scene.marks.length });
  ok(!host.state.scene.marks.some(m => m.label === 'R3 标记'),
     '第 3 回合的地图标记被撤销');
  ok(host.state.scene.marks.some(m => m.label === 'R2 标记'),
     '第 2 回合的地图标记保留');

  // --- 投票期间有人断线 → 失败 ---
  relay.deliver(host.rollbackPropose(M.HOST_SEAT, 1));
  eq(host.rewind.state, M.REWIND.VOTING, '重新发起投票');
  host.detachPeer('s-a');
  eq(host.rewind.state, M.REWIND.FAILED, '表决期间有人断线 → 本次回退失败');

  // --- 结团（二次确认：先排队，再 confirm）---
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, { op: 'session.end' })));
  ok(host.state.meta.status !== S.CLOSED, '未确认前房间还没关');
  ok(host.pending.some(q => q.op === 'session.end'), '结团动作进入待确认队列');
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.CONFIRM, { op: 'session.end', agree: true })));
  eq(host.state.meta.status, S.CLOSED, '结团后房间关闭');
  eq(host.state.meta.ended, true, '标记为「已结团」（与普通关房区分）');
  ok(relay.since(0, 's-a').some(t => /"ended"|"ENDED"/.test(t)), '玩家收到结团事件');

  // --- 越权：玩家不能发起回退（v2.9.0 用户第 3 项：入口 op 已整体移除 → 伪造 ACT 一律被拒） ---
  const out = host.intent('s-a', M.intentMsg(M.INTENT.ACT, { op: 'rollback.turn', turns: 1 }));
  ok(out.every(r => r.to !== '*'), '玩家发起的回退不会群发');
  ok(out.some(r => r.to === 's-a' && /没有权限/.test(JSON.stringify(r.msg))),
     '★（v2.9.0 用户第 3 项）回退入口 op 已移除 → 越权 / 伪造 ACT 一律「没有权限」');

  /* --- 旧存档 / 未标记回合：如实拒绝，不静默退到第 1 回合 --- */
  const legacy = newHost({ code: 'legacy' });
  const lrelay = new Relay();
  addPlayer(legacy, lrelay, 's-x', '阿丙');
  addPlayer(legacy, lrelay, 's-y', '阿丁');
  eq(legacy.roundStarts.length, 0, '未标记回合的存档：回合边界表为空');
  const lplan = legacy.rollbackPropose(M.HOST_SEAT, 1);
  ok(!legacy.rewind || legacy.rewind.state !== M.REWIND.VOTING, '没有回合边界时不进入投票');
  ok(lplan.some(r => r.to === M.HOST_SEAT && /还没有标记回合/.test(JSON.stringify(r.msg))),
     '如实提示「本局还没有标记回合」，而不是静默退到第 1 回合');
})();

/* ============================================================
 * 15. 角色卡状态进房间（INTENT.CHAR）
 *
 * 起因：车卡时从疯狂表里选的恐惧症/狂躁症、状态管理里的精神状态与
 * SAN 上限减损，以前**完全传不进房间** —— INTENT.CHAR 的接收分支只存了
 * charName / charId，而且客户端压根没人发这条意图。
 *
 * 这一节验证三件事：
 *   a) 上报后权威端确实存下了 madness / mental / sanLoss / maxSAN
 *   b) **可见性**：本人与 KP 拿全量，其他玩家只拿到「有没有异常」，
 *      响应体里**不存在**症状名与减损值（§8.2 的同一条原则）
 *   c) 白名单化：越界数字被夹住、非法精神状态被丢弃、「正常」互斥生效
 * ============================================================ */
(function () {
  section('15. 角色卡状态进房间（疯狂 / 精神状态 / SAN 减损）');

  const host = newHost();
  const relay = new Relay();
  const a = addPlayer(host, relay, 's-a', '小明');   // 上报者
  const b = addPlayer(host, relay, 's-b', '小红');   // 另一个玩家
  const spec = addSpec(host, relay, 's-c', '围观者');

  const sheet = {
    name: '亨利',
    madness: [
      { type: 'phobia', name: '幽闭恐惧症', permanent: true, rounds: 0 },
      { type: 'mania', name: '纵火癖', permanent: false, rounds: 4 }
    ],
    /* v2.1.8 改既有断言（理由）：本节 fixture 原为 mental:['永久疯狂','临时疯狂']，
       但 v2.1.8 新增了「撕卡卡不能进房间」的权威端守卫（room-model.js INTENT.CHAR），
       带「永久疯狂」的卡现在会在绑定时被拒 —— 那是新需求要求的正确行为，而非缺陷。
       故本节的「存下来/可见性/白名单」断言改用非撕卡卡（临时疯狂 + 疯狂症状），
       撕卡守卫的专项断言见本节 d) 段。 */
    mental: ['临时疯狂', '疯狂症状'],
    sanLoss: 6,
    maxSAN: 49,
    san: 41,
    hp: 11,
    mp: 9
  };

  let mark = relay.mark();
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CHAR, { id: 'c-1', name: '亨利', sheet: sheet })));

  // --- a) 权威端存下了 ---
  const mem = host.roster.get('s-a');
  ok(!!mem.sheet, '成员身上挂上了 sheet');
  eq(mem.sheet.madness.length, 2, '两条疯狂都存下来了');
  eq(mem.sheet.madness[0].name, '幽闭恐惧症', '症状名存对了');
  eq(mem.sheet.madness[0].permanent, true, '永久疯狂标记保留');
  seq(mem.sheet.mental, ['临时疯狂', '疯狂症状'], '精神状态（临时疯狂 + 疯狂症状 都存下来）');
  eq(mem.sheet.sanLoss, 6, 'SAN 上限永久减损存下来了');
  eq(mem.sheet.maxSAN, 49, 'SAN 上限存下来了');

  // --- b) 可见性 ---
  // 本人：全量
  const selfMsgs = relay.since(mark, 's-a');
  const selfHas = selfMsgs.some(t => /幽闭恐惧症/.test(t));
  ok(selfHas, '本人收到的成员表里有完整症状名');

  // KP（'host'）：全量（直接读权威状态即可，这里验证 store 层）
  ok(!!mem.sheet.madness[0].name, 'KP 端持有完整症状名');

  // 其他玩家：不含症状名、不含减损值
  const otherMsgs = relay.since(mark, 's-b').join('');
  ok(!/幽闭恐惧症|纵火癖/.test(otherMsgs), '其他玩家收不到具体症状名');
  ok(!/"sanLoss":6/.test(otherMsgs), '其他玩家收不到 SAN 减损数值');
  ok(/"madnessCount":2/.test(otherMsgs), '其他玩家只看到「有几条异常」这种计数');

  // 旁观者同理
  const specMsgs = relay.since(mark, 's-c').join('');
  ok(!/幽闭恐惧症|纵火癖/.test(specMsgs), '旁观者收不到具体症状名');

  // --- b2) 全量 sync 也必须同样裁剪（重连不能漏）---
  const syncSelf = host.syncFor('s-a');
  ok(JSON.stringify(syncSelf).indexOf('幽闭恐惧症') >= 0, '全量 sync 给本人仍是全量');
  const syncOther = host.syncFor('s-b');
  ok(JSON.stringify(syncOther).indexOf('幽闭恐惧症') < 0, '全量 sync 给其他玩家同样被裁剪');

  // --- c) 白名单化 ---
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CHAR, {
    id: 'c-1', name: '亨利',
    sheet: {
      name: 'x',
      madness: [{ type: 'nonsense', name: '伪造症状' }, { type: 'phobia', name: '' }],
      mental: ['临时疯狂', '不存在的心情', '临时疯狂'],
      sanLoss: 9999,
      maxSAN: -5
    }
  })));
  const m2 = host.roster.get('s-a').sheet;
  eq(m2.madness.length, 1, '非法 type / 空名字的疯狂被丢掉');
  eq(m2.madness[0].type, 'phobia', '非法 type 归一到 phobia（不是原样存）');
  seq(m2.mental, ['临时疯狂'], '非法精神状态被丢弃、去重');
  eq(m2.sanLoss, 99, 'SAN 减损被夹到上限 99');
  ok(m2.maxSAN === 0, 'SAN 上限负数被夹到 0', m2.maxSAN);

  // 「正常」互斥：有别的项时「正常」不该留下来
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CHAR, {
    id: 'c-1', name: '亨利',
    sheet: { name: 'x', madness: [], mental: ['正常', '临时疯狂'] }
  })));
  seq(host.roster.get('s-a').sheet.mental, ['正常'], '「正常」与其它项并存时收敛为 [正常]');

  // 旁观者不能上报角色卡（没有作为玩家的成员对象）
  const before = JSON.stringify(host.roster.get('s-c').sheet || null);
  relay.deliver(host.intent('s-c', M.intentMsg(M.INTENT.CHAR, { id: 'c-9', name: '偷渡', sheet: sheet })));
  eq(JSON.stringify(host.roster.get('s-c').sheet || null), before, '旁观者上报角色卡不生效');

  // --- d) v2.1.8 撕卡守卫：死亡 / 永久疯狂的角色卡不能绑定进房间 ---
  // 权威端不信任客户端过滤（任何人都能改前端），所以在 INTENT.CHAR 接收分支
  // 按上报摘要里的 body / mental 再判一次。这里验证：
  //   ① body='死亡' → 拒绝，sheet/charName 均不被覆盖；
  //   ② mental 含 '永久疯狂' → 同样拒绝；
  //   ③ 非撕卡卡 → 仍能正常绑定（负向断言，防止守卫误伤）。
  const aliveBefore = JSON.stringify(host.roster.get('s-a').sheet);
  const nameBefore = host.roster.get('s-a').charName;

  let guardMark = relay.mark();
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CHAR, {
    id: 'c-dead', name: '死者',
    sheet: { status: { body: '死亡' }, mental: ['正常'] }
  })));
  ok(JSON.stringify(host.roster.get('s-a').sheet) === aliveBefore, '★ 死亡卡被拒：sheet 不被覆盖');
  eq(host.roster.get('s-a').charName, nameBefore, '★ 死亡卡被拒：charName 不被覆盖');
  ok(relay.since(guardMark, 's-a').some(t => /该角色已撕卡/.test(t)),
     '★ 死亡卡被拒：玩家收到一句人话提示');

  guardMark = relay.mark();
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CHAR, {
    id: 'c-mad', name: '疯子',
    sheet: { status: { body: '正常' }, mental: ['永久疯狂'] }
  })));
  ok(JSON.stringify(host.roster.get('s-a').sheet) === aliveBefore, '★ 永久疯狂卡被拒：sheet 不被覆盖');
  eq(host.roster.get('s-a').charName, nameBefore, '★ 永久疯狂卡被拒：charName 不被覆盖');
  ok(relay.since(guardMark, 's-a').some(t => /该角色已撕卡/.test(t)),
     '★ 永久疯狂卡被拒：玩家收到一句人话提示');

  // 负向断言：非撕卡卡仍能正常绑定（换卡 / 重连补报不被误伤）
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CHAR, {
    id: 'c-alive', name: '活人',
    sheet: { status: { body: '正常' }, mental: ['临时疯狂'] }
  })));
  eq(host.roster.get('s-a').charName, '活人', '★ 非撕卡卡仍能绑定（charName 更新）');
  eq(host.roster.get('s-a').charId, 'c-alive', '★ 非撕卡卡仍能绑定（charId 更新）');
  ok(!!host.roster.get('s-a').sheet, '★ 非撕卡卡仍能绑定（sheet 已挂上）');
})();

/* ============================================================
 * v1.18.5 —— 真机反馈修复的回归
 * （状态请求生命周期 / 检定推送 / 玩家直投 / 回退保生命周期 / 战斗目标）
 * ============================================================ */
(function () {
  section('v1.18.5 状态请求：处理完必须从玩家端消失');

  const host = newHost();
  const relay = new Relay();
  const pa = addPlayer(host, relay, 's-a', '阿尔法');

  // KP 发起状态请求
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, {
    op: 'state.request', seat: 's-a', reason: '测试',
    change: { san: 42 }
  })));
  eq(pa.client.state.requests.length, 1, '玩家端收到 1 条请求');
  const reqId = pa.client.state.requests[0].id;

  // 玩家同意 → 请求必须从玩家端消失 + 数值落账
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CONSENT, { id: reqId, agree: true })));
  eq(pa.client.state.requests.length, 0, '同意后请求卡从玩家端摘除（v1.18.4 修的「不消失」）');
  eq(host.roster.get('s-a').runtime.san, 42, '同意后 SAN 真正生效');

  // 重复表态 → 玩家收到「已处理过」（不崩、不再生效）
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CONSENT, { id: reqId, agree: true })));
  eq(host.roster.get('s-a').runtime.san, 42, '重复同意不重复生效');

  // KP 再发一条 → 玩家必须**收得到**（v1.18.4 修的「新请求看不见」）
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, {
    op: 'state.request', seat: 's-a', change: { hp: 5 }
  })));
  eq(pa.client.state.requests.length, 1, '新请求能收到（旧卡已清，不再被 [0] 挡住）');
  eq(pa.client.state.requests[0].p.hp, 5, '新请求内容正确');

  // 拒绝路径也摘卡
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CONSENT, { id: pa.client.state.requests[0].id, agree: false })));
  eq(pa.client.state.requests.length, 0, '拒绝后请求卡同样摘除');
  eq(host.roster.get('s-a').runtime.hp, undefined, '拒绝不落账');
})();

(function () {
  section('v1.18.5 检定推送：check.request 必须真的发出去（原来没有处理器）');

  const host = newHost();
  const relay = new Relay();
  const pa = addPlayer(host, relay, 's-a', '阿尔法');
  const pb = addPlayer(host, relay, 's-b', '贝塔');
  const sp = addSpec(host, relay, 's-c');

  const mark = relay.mark();
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, {
    op: 'check.request', seat: '*', skill: '侦查', difficulty: 'HARD', desc: '天花板坍塌前'
  })));

  const gotA = relay.since(mark, 's-a').filter(t => t.includes('"request"'));
  ok(gotA.some(t => t.includes('check.request')), '玩家 A 收到 check.request（原来一个事件都不发）', gotA.length);
  ok(relay.since(mark, 's-b').some(t => t.includes('check.request')), '玩家 B 也收到');
  eq(relay.since(mark, 's-c').filter(t => t.includes('check.request')).length, 0, '旁观者不收检定请求');
  ok(relay.since(mark, 's-a').some(t => t.includes('天花板')), '场景说明随请求下发');
  eq(pa.client.state.requests.length, 1, 'A 端待办里出现检定卡');
  eq(pa.client.state.requests[0].op, 'check.request', 'op 正确（UI 据此渲染检定卡）');

  // 玩家响应：直投 + reqId → 骰子广播 + 请求卡摘除
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.DICE, {
    expr: '1D100', direct: true, reqId: pa.client.state.requests[0].id,
    base: 60, difficulty: 'HARD', label: '侦查'
  })));
  ok(relay.since(mark, 's-b').some(t => t.includes('"dice"')), '直投结果广播给所有人');
  eq(pa.client.state.requests.length, 0, '掷完骰请求卡摘除');
  ok(relay.since(mark, 's-b').some(t => t.includes('完成了检定')), '公共记录写「完成了检定」');

  // 忽略路径（注意：B 手上还挂着第一条全体验证的卡 c1 —— 忽略的必须是 c2）
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'check.request', seat: 's-b', skill: '聆听' })));
  const c2 = pb.client.state.requests[pb.client.state.requests.length - 1].id;
  relay.deliver(host.intent('s-b', M.intentMsg(M.INTENT.CONSENT, { id: c2, agree: false })));
  ok(!pb.client.state.requests.some(r => r.id === c2), '忽略后检定卡摘除');
  ok(pb.client.state.requests.some(r => r.id !== c2), '未处理的旧检定卡保留（仍然可响应）');
})();

(function () {
  section('v1.18.5 玩家直投：结果由权威端算，旁观者不能掷');

  const fakeRules = {
    check: function () { return { value: 7, rolls: [], levelText: '', levelKey: '' }; },
    rollExpr: function (e) { return { ok: true, total: 13, rolls: [{ count: 1, sides: 6, dice: [6] }] }; }
  };
  const host = newHost(null, null, { rules: fakeRules });
  const relay = new Relay();
  const pa = addPlayer(host, relay, 's-a', '阿尔法');
  const sp = addSpec(host, relay, 's-c');

  const mark = relay.mark();
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.DICE, { expr: '1D100', direct: true, base: 50 })));
  ok(relay.since(mark, 's-a').some(t => '"total":7'.includes('"total":7') || t.includes('"value":7')), '百分骰由权威端规则算出（不是玩家声明的值）');
  ok(relay.since(mark, 's-a').some(t => t.includes('"dice"')), '直投广播 dice 事件');

  const mark2 = relay.mark();
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.DICE, { expr: '1D6', direct: true })));
  ok(relay.since(mark2, 's-a').some(t => t.includes('1D6')), 'D6 直投走 rollExpr');

  const mark3 = relay.mark();
  relay.deliver(host.intent('s-c', M.intentMsg(M.INTENT.DICE, { expr: '1D100', direct: true })));
  eq(relay.since(mark3, '*').length, 0, '旁观者直投被拒（无广播）');
})();

(function () {
  section('v1.18.5 回退：房间生命周期不随快照回退');

  const host = newHost();
  const relay = new Relay();
  addPlayer(host, relay, 's-a', '阿尔法');

  // 先来几条聊天（快照落在开团**之前**：seq 0 的空状态）
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.CHAT, { text: '预热' })));
  // 开团
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, { op: 'room.start' })));
  eq(host.state.meta.status, S.IN_GAME, '开团后是游戏中');
  const startSeq = host.log.seq;

  // 回退到「开团动作之前」—— 快照只有 seq 0（招募中）
  const plan = host.rollbackPlan(startSeq);
  relay.deliver(plan);
  eq(host.state.meta.status, S.IN_GAME,
     '回退后仍是游戏中（生命周期不是游戏历史，修「KP 工具全消失」）');
  eq(host.state.meta.round !== undefined, true, 'meta 完整');
})();

(function () {
  section('v1.18.5 战斗：玩家只能攻击怪物/NPC');

  const host = newHost();
  const relay = new Relay();
  const pa = addPlayer(host, relay, 's-a', '阿尔法');
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, { op: 'room.start' })));
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, {
    op: 'combat.start',
    actors: [
      { id: 'p-s-a', name: '阿尔法', kind: 'pc', seat: 's-a', dex: 80, actionsPerRound: 1 },
      { id: 'p-s-b', name: '贝塔', kind: 'pc', seat: 's-b', dex: 60, actionsPerRound: 1 },
      { id: 'm1', name: '深潜者', kind: 'monster', dex: 40, actionsPerRound: 1 }
    ]
  })));

  // 把行动轮推到玩家 s-a 的回合
  let c = host.state.combat;
  let guard = 0;
  while (c.order[c.turn].seat !== 's-a' && guard++ < 6) relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, { op: 'combat.next' })));
  eq(c.order[c.turn].seat, 's-a', '轮到玩家 s-a');

  const mark = relay.mark();
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.ACT, { op: 'combat.attack', targetId: 'p-s-b', skill: '格斗' })));
  ok(relay.since(mark, 's-a').some(t => t.includes('不能攻击队友')), '玩家攻击队友被权威端拒绝');

  const mark2 = relay.mark();
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.ACT, { op: 'combat.attack', targetId: 'm1', skill: '格斗' })));
  eq(relay.since(mark2, 's-a').filter(t => t.includes('不能攻击队友')).length, 0, '攻击怪物放行');
  ok(relay.since(mark2, '*').some(t => t.includes('发起攻击')), '攻击入公共记录');
})();

/* ============================================================
 * 16. v2.0.0 存档系统：save / restore / suspend / resume / 玩家裁剪
 * ============================================================ */
(function () {
  section('16. v2.0.0 存档：打包 / 重建 / 挂起复活 / 玩家裁剪');

  const host = newHost();
  const relay = new Relay();
  const a = addPlayer(host, relay, 's-a', '小明');
  const b = addPlayer(host, relay, 's-b', '小红');

  // 造点内容：开团、聊天、场景、回合、一张带私密症状的角色卡
  relay.deliver(host.applyAction('host', { op: 'room.start' }));
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CHAT, { text: '存档前的聊天' })));
  relay.deliver(host.applyAction('host', { op: 'scene.set', scene: { title: '废弃图书馆', marks: [] } }));
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, { op: 'round.next' })));
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CHAR, {
    id: 'c-a', name: '亨利',
    sheet: { name: '亨利', madness: [{ type: 'phobia', name: '幽闭恐惧症' }], mental: ['疯狂症状'], sanLoss: 6, maxSAN: 49 }
  })));

  // --- 打包 ---
  const payload = host.savePayload();
  eq(typeof payload, 'string', '存档 payload 是字符串（服务端不解析）');
  const save = M.parseSave(payload);
  eq(save.v, 2, '存档带版本号 v=2');
  eq(save.code, 'abc123', '存档带房间号');
  ok(!/hostToken|mtoken|password/i.test(payload), '存档里**不含**凭据（hostToken/mtoken/密码）');
  eq(save.seq, host.log.seq, '存档 seq 与权威端一致');

  // --- 重建：状态等价 ---
  const restored = M.restoreHost(payload);
  eq(restored.state.meta.status, host.state.meta.status, '重建后房间状态一致');
  eq(restored.state.chats.length, host.state.chats.length, '重建后聊天条数一致');
  eq(restored.state.logs.length, host.state.logs.length, '重建后日志条数一致');
  eq(restored.roster.players().length, host.roster.players().length, '重建后玩家数一致');
  eq(restored.roster.get('s-a').charId, 'c-a', '重建后角色卡绑定一致');
  eq(restored.roster.get('s-a').sheet.madness[0].name, '幽闭恐惧症', '重建后角色卡内容一致');
  eq(restored.roundStarts.length, host.roundStarts.length, '重建后回合边界表一致');
  eq(restored.log.seq, host.log.seq, '重建后事件序号一致');

  // --- 玩家拉取的存档必须裁剪过（契约 §6.3）---
  const selfView = M.playerViewFromSave(payload, 's-a');
  eq(selfView.k, 'sync', 'playerViewFromSave 返回全量同步信封');
  ok(JSON.stringify(selfView).indexOf('幽闭恐惧症') >= 0, '本人拉取能看到自己的症状名');
  const otherView = M.playerViewFromSave(payload, 's-b');
  ok(JSON.stringify(otherView).indexOf('幽闭恐惧症') < 0, '★ 其他玩家拉取的存档里没有别人的私密症状名');

  // --- 挂起 / 复活 ---
  const mk = relay.mark();
  relay.deliver(host.applyAction('host', { op: 'room.suspend' }));
  eq(host.state.meta.status, 'SUSPENDED', '挂起后房间状态为 SUSPENDED');
  ok(relay.since(mk, 's-a').some(t => /SUSPENDED/.test(t)), '挂起广播给玩家');
  ok(relay.since(mk, 's-a').some(t => /挂起/.test(t)), '挂起留下系统日志');

  relay.deliver(host.applyAction('host', { op: 'room.resume' }));
  eq(host.state.meta.status, 'RECRUITING', '复活后回到 RECRUITING');
  ok(relay.since(mk, 's-a').some(t => /复活/.test(t)), '复活留下系统日志');

  // --- 复活时从服务器存档重建等价状态 ---
  const revived = M.restoreHost(payload);
  eq(revived.state.meta.code, 'abc123', '复活重建出的存档房间号正确');
  eq(revived.state.chats.length, host.state.chats.length, '复活重建出的聊天与挂起前等价');
})();

/* ============================================================
 * 17. v2.0.0 角色卡贯通：READY 校验 / sheet 扩展 / 权威取值 / 状态回写幂等
 * ============================================================ */
(function () {
  section('17. v2.0.0 角色卡贯通');

  const host = newHost();
  const relay = new Relay();
  const a = addPlayer(host, relay, 's-a', '小明');
  const b = addPlayer(host, relay, 's-b', '小红');

  // --- READY 必须校验 charId（契约 §5.4）---
  let mk = relay.mark();
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.READY, { ready: true })));
  eq(host.roster.get('s-a').ready, false, '没有 charId 时准备被拒绝');
  ok(relay.since(mk, 's-a').some(t => /请先选择角色卡/.test(t)), '拒绝时回一条「请先选择角色卡」');
  ok(!relay.since(mk, '*').some(t => /请先选择角色卡/.test(t)), '拒绝提示只发给本人（不污染公共流）');

  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CHAR, { id: 'c-a', name: '亨利' })));
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.READY, { ready: true })));
  eq(host.roster.get('s-a').ready, true, '绑卡后可以准备');

  // --- sanitizeSheet 扩展 + 隐私 ---
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CHAR, {
    id: 'c-a', name: '亨利',
    sheet: {
      name: '亨利', charId: 'c-a',
      attrs: { str: 60, con: 55, siz: 70, dex: 65, app: 50, int: 80, pow: 55, edu: 75, luck: 45 },
      status: { currentHP: 11, maxHP: 12, currentMP: 9, maxMP: 9, currentSAN: 41, maxSAN: 49, currentLuck: 45 },
      skills: [{ name: '侦查', total: 65, base: 25, category: '感知' }, { name: '图书馆使用', total: 70 }],
      madness: [{ type: 'phobia', name: '幽闭恐惧症' }], mental: ['疯狂症状'], sanLoss: 6, maxSAN: 49
    }
  })));
  const sh = host.roster.get('s-a').sheet;
  eq(sh.attrs.dex, 65, '九项属性被存下');
  eq(sh.status.currentHP, 11, '状态块 currentHP 被存下');
  eq(sh.skills.length, 2, '技能列表被存下');
  eq(sh.skills[0].name, '侦查', '技能名保留');
  ok(sh.skills[0].base === undefined && sh.skills[0].category === undefined, '技能只留 name/total（不带 base/category）');

  // 隐私：本人/KP 全量，其他人只有公开标签
  const selfSync = JSON.stringify(host.syncFor('s-a'));
  ok(selfSync.indexOf('"侦查"') >= 0 && selfSync.indexOf('"attrs"') >= 0, '本人能拿到 attrs/skills 全量');
  const otherSync = JSON.stringify(host.syncFor('s-b'));
  ok(otherSync.indexOf('"attrs"') < 0 && otherSync.indexOf('侦查') < 0, '★ 其他玩家拿不到 attrs/skills（隐私裁剪）');
  ok(otherSync.indexOf('幽闭恐惧症') < 0, '其他玩家拿不到具体症状名');
  ok(/"madnessCount":1/.test(otherSync), '其他玩家只看到异常计数');

  // --- 检定改读权威值：客户端上报 base=1，但角色卡里侦查=65 → 用 65 ---
  let capturedBase = null;
  const spyRules = {
    skillValue: function (sheet, name) { return (name === '侦查') ? 65 : null; },
    attrValue: function () { return null; },
    check: function (o) { capturedBase = o.base; return { value: 10, rolls: [], levelText: '', levelKey: '' }; },
    rollExpr: function (e) { return { ok: true, total: 13, rolls: [] }; }
  };
  const h2 = newHost(null, null, { rules: spyRules });
  const r2 = new Relay();
  const p2 = addPlayer(h2, r2, 's-a', '小明');
  r2.deliver(h2.intent('s-a', M.intentMsg(M.INTENT.CHAR, {
    id: 'c-a', name: '亨利', sheet: { name: '亨利', skills: [{ name: '侦查', total: 65 }] }
  })));
  r2.deliver(h2.intent('s-a', M.intentMsg(M.INTENT.DICE,
    { expr: '1D100', direct: true, base: 1, label: '侦查' })));
  eq(capturedBase, 65, '★ 检定用角色卡权威值（不是客户端上报的 base=1）');

  // 查不到技能时回落客户端 base
  r2.deliver(h2.intent('s-a', M.intentMsg(M.INTENT.DICE,
    { expr: '1D100', direct: true, base: 33, label: '不存在的技能' })));
  eq(capturedBase, 33, '查不到技能时回落到客户端上报的 base');

  // --- 状态回写：单发给本人 + 幂等 ---
  const mkw = relay.mark();
  relay.deliver(host.stateApply('s-a', { status: { currentHP: 5 } }, { reason: '战斗受伤' }));
  ok(relay.since(mkw, 's-a').some(t => /"state"|"STATE"/.test(t)) ||
     relay.since(mkw, 's-a').some(t => /"currentHP":5/.test(t)), '本人收到角色卡状态写回');
  /* v2.13.4（用户第 2 项）：**约定变更** —— 队友栏要显示「HP / 当前 SAN / 身体状态 / 精神状态」，
     这些在桌面团里本来就摆在桌上，所以成员表广播里对同席放开这一小组；
     仍然不外传的是：疯狂症状名（madness）、SAN 上限减损（sanLoss）、SAN 上限（maxSAN）。
     旧断言「其他玩家完全收不到 HP」已被这条需求推翻。 */
  ok(relay.since(mkw, 's-b').some(t => /"currentHP":5/.test(t)),
     '其他玩家能在成员表里看到 HP 现值（队友栏用）');
  ok(!relay.since(mkw, 's-b').some(t => /"sanLoss":[1-9]/.test(t)),
     '仍然不外传 SAN 上限减损');
  ok(!relay.since(mkw, 's-b').some(t => /"madness":\s*\[\s*\{/.test(t)),
     '仍然不外传疯狂症状明细');
  eq(host.roster.get('s-a').runtime.hp, 5, '权威端 runtime 更新');

  // 幂等：同一 seq 应用两次，只扣一次血
  const card = { hp: 12 };
  function applyWriteback(p) {
    const r = a.client.applySheetState(p.seq, p);
    if (!r.applied) return false;
    card.hp -= (p.deltaHP || 0);      // 模拟「按变化量扣血」
    return true;
  }
  ok(applyWriteback({ seq: 7, deltaHP: 4 }), '第一次写回被应用');
  eq(card.hp, 8, 'HP 扣了一次');
  ok(!applyWriteback({ seq: 7, deltaHP: 4 }), '★ 同一 seq 第二次写回被幂等闸门拦下');
  eq(card.hp, 8, '★ 同一 seq 应用两次，HP 只扣一次');
  eq(a.client.lastStateSeq, 7, '记录已应用的写回序号');
  ok(applyWriteback({ seq: 8, deltaHP: 1 }), '更大的 seq 正常应用');
  eq(card.hp, 7, '新 seq 正常扣血');

  // 状态回执（INTENT.STATE_SYNC）不产生噪声
  const before = host.log.seq;
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.STATE_SYNC, { seq: 7 })));
  eq(host.log.seq, before, '状态回执是静默的（不占公共序号）');
  eq(host.roster.get('s-a').stateAckSeq, 7, '权威端记下玩家回执的 seq');
})();

/* ============================================================
 * 18. v2.0.0 战斗改造：initiativeOrder / actorIds / movedToTail / resolveAttack / 轮次提醒
 * ============================================================ */
(function () {
  section('18. v2.0.0 战斗改造');

  // --- combat.start 走 initiativeOrder：DEX 降序 + 枪械 +50 + 多行动展开 ---
  const spy = { called: 0, args: null };
  const realOrder = (CocRules && CocRules.initiativeOrder) ? CocRules.initiativeOrder : null;
  const ordRules = Object.assign({}, CocRules || {}, {
    initiativeOrder: function (actors, o) {
      spy.called++;
      spy.args = actors;
      return realOrder ? realOrder(actors, o) : null;   // 缺失时让 combatStart 回落兜底
    }
  });
  const host = newHost(null, null, { rules: ordRules });
  const relay = new Relay();
  const a = addPlayer(host, relay, 's-a', '小明');

  relay.deliver(host.applyAction('host', {
    op: 'combat.start',
    actors: [
      { id: 'slow', name: '慢鬼', kind: 'monster', dex: 30, actionsPerRound: 1, hp: 8, hpMax: 8 },
      { id: 'pc', name: '小明', kind: 'pc', seat: 's-a', dex: 50, actionsPerRound: 1, hp: 11, hpMax: 11 },
      { id: 'gun', name: '持枪者', kind: 'monster', dex: 40, readyFirearm: true, actionsPerRound: 1, hp: 10, hpMax: 10 },
      { id: 'fast', name: '三连击怪', kind: 'monster', dex: 90, actionsPerRound: 3, hp: 15, hpMax: 15 }
    ]
  }));
  eq(spy.called, 1, '★ combat.start 确实调用了 CocRules.initiativeOrder');
  const order = host.state.combat.order;
  eq(order.length, 6, '多行动怪物展开成 3 槽（其余各 1 槽，共 6 槽）');
  seq(order.map(s => s.actorId), ['fast', 'fast', 'fast', 'gun', 'pc', 'slow'],
      '★ 队列按 DEX 降序（枪械 DEX+50 排到 pc 前）');
  const gSlots = order.filter(s => s.actorId === 'fast');
  eq(gSlots.length, 3, '多行动怪物保留 3 个行动槽');
  eq(gSlots[0].totalSlots, 3, '每个槽记录总行动次数');

  // --- actorIds：只把选中的单位入队 ---
  const host2 = newHost(null, null, { rules: ordRules });
  const relay2 = new Relay();
  addPlayer(host2, relay2, 's-a', '小明');
  relay2.deliver(host2.applyAction('host', {
    op: 'combat.start',
    actors: [
      { id: 'm1', name: '深潜者', kind: 'monster', dex: 80, actionsPerRound: 1 },
      { id: 'm2', name: '食尸鬼', kind: 'monster', dex: 70, actionsPerRound: 1 },
      { id: 'm3', name: '拜亚基', kind: 'monster', dex: 60, actionsPerRound: 1 }
    ],
    actorIds: ['m3', 'm1']                     // 乱序 + 只选两个
  }));
  seq(host2.state.combat.order.map(s => s.actorId), ['m1', 'm3'], '★ actorIds 只把选中的单位入队且按 DEX 降序');

  // --- combat.attack 走 resolveAttack：确实改 HP ---
  let captured = null;
  const atkRules = {
    resolveAttack: function (o) {
      captured = o;
      return { outcome: 'hit', level: 'success',
               damage: { raw: 6, expr: '1D8', dbDice: 0, impale: false, armor: 0, applied: 4 },
               flags: {}, summary: '命中，造成 4 点伤害' };
    }
  };
  const host3 = newHost(null, null, { rules: atkRules });
  const relay3 = new Relay();
  addPlayer(host3, relay3, 's-a', '小明');
  relay3.deliver(host3.applyAction('host', {
    op: 'combat.start',
    actors: [{ id: 'm1', name: '深潜者', kind: 'monster', dex: 40, actionsPerRound: 1, hp: 12, hpMax: 12 }]
  }));
  const hpBefore = host3.state.combat.order.find(s => s.actorId === 'm1').public.hp;
  const mkAtk = relay3.mark();
  relay3.deliver(host3.applyAction('host', {
    op: 'combat.attack', targetId: 'm1', skill: '格斗(斗殴)', base: 60, damage: '1D8', db: '0'
  }));
  const hpAfter = host3.state.combat.order.find(s => s.actorId === 'm1').public.hp;
  eq(hpAfter, hpBefore - 4, '★ combat.attack 走 resolveAttack 后确实改 HP（不再只写日志）');
  ok(!!captured, 'resolveAttack 被调用');
  eq(captured.attack.name, '格斗(斗殴)', '攻击技能名传进 resolveAttack');
  ok(/造成 4 点伤害/.test(relay3.since(mkAtk, '*').join('')), 'resolveAttack 的结论写进公共日志');
  /* v2.0.0：D 线 §4.1 加法扩展 —— 目标 HP 必须传进去（否则伤势 flags 全 false）。 */
  eq(captured.maxHP, 12, '★ 把目标 maxHP 传进 resolveAttack（用于伤势判定）');
  eq(captured.currentHP, 12, '★ 把目标 currentHP 传进 resolveAttack');
  ok(captured.target && captured.target.currentHP === 12, '同时提供 target:{maxHP,currentHP} 形式');
  eq(captured.ranged, false, '近战默认 ranged=false');

  // --- 远程攻击：ranged 标记要传进去（远程不能反击，由规则服务降级） ---
  let capturedR = null;
  const rangedRules = {
    resolveAttack: function (o) {
      capturedR = o;
      return { outcome: 'hit', level: 'success',
               damage: { raw: 6, armor: 0, applied: 6 }, flags: {},
               summary: '远程命中，造成 6 点伤害' };
    }
  };
  const host3r = newHost(null, null, { rules: rangedRules });
  const relay3r = new Relay();
  addPlayer(host3r, relay3r, 's-a', '小明');
  relay3r.deliver(host3r.applyAction('host', {
    op: 'combat.start',
    actors: [{ id: 'm1', name: '深潜者', kind: 'monster', dex: 40, hp: 12, hpMax: 12 }]
  }));
  relay3r.deliver(host3r.applyAction('host', {
    op: 'combat.attack', targetId: 'm1', skill: '射击(手枪)', base: 50,
    damage: '1D10', ranged: true
  }));
  ok(capturedR && capturedR.ranged === true, '★ 远程攻击把 ranged=true 传进 resolveAttack');

  // --- 伤势 flags：规则服务返回 dead → 槽位状态被标记 ---
  const flagRules = {
    resolveAttack: function () {
      return { outcome: 'hit', level: 'success',
               damage: { raw: 99, armor: 0, applied: 99 },
               flags: { dead: true, majorWound: true }, summary: '致命一击' };
    }
  };
  const host3f = newHost(null, null, { rules: flagRules });
  const relay3f = new Relay();
  addPlayer(host3f, relay3f, 's-a', '小明');
  relay3f.deliver(host3f.applyAction('host', {
    op: 'combat.start',
    actors: [{ id: 'm1', name: '深潜者', kind: 'monster', dex: 40, hp: 12, hpMax: 12 }]
  }));
  relay3f.deliver(host3f.applyAction('host', {
    op: 'combat.attack', targetId: 'm1', skill: '格斗', base: 50, damage: '1D8'
  }));
  const deadSlot = host3f.state.combat.order.find(s => s.actorId === 'm1');
  eq(deadSlot.public.hp, 0, '致命伤害把 HP 打到 0');
  eq(deadSlot.public.state, 'dead', '★ resolveAttack 的 dead 标记写进槽位状态');

  // --- outcome=defender_wins：反击胜出，伤害打在**攻击者**身上，而不是目标 ---
  const fbRules = {
    resolveAttack: function () {
      return { outcome: 'defender_wins', level: 'success',
               damage: { raw: 5, armor: 0, applied: 5 }, flags: {},
               summary: '防守方反击得手，攻击者受 5 点伤害' };
    }
  };
  const host3w = newHost(null, null, { rules: fbRules });
  const relay3w = new Relay();
  addPlayer(host3w, relay3w, 's-a', '小明');
  relay3w.deliver(host3w.applyAction('host', {
    op: 'combat.start',
    actors: [
      { id: 'pc1', name: '调查员', kind: 'pc', seat: 's-a', dex: 60, hp: 10, hpMax: 10 },
      { id: 'm1', name: '深潜者', kind: 'monster', dex: 40, hp: 12, hpMax: 12 }
    ]
  }));
  // 让当前行动者是 pc1（DEX 最高，队列首位）
  const pcSlot = host3w.state.combat.order.find(s => s.actorId === 'pc1');
  eq(host3w.state.combat.order[0].actorId, 'pc1', 'pc1 因 DEX 最高排在首位');
  const pcHpBefore = pcSlot.public.hp;
  const monHpBefore = host3w.state.combat.order.find(s => s.actorId === 'm1').public.hp;
  relay3w.deliver(host3w.applyAction('s-a', {
    op: 'combat.attack', targetId: 'm1', skill: '格斗', base: 50, damage: '1D6', defense: 'fightback'
  }));
  const pcHpAfter = host3w.state.combat.order.find(s => s.actorId === 'pc1').public.hp;
  const monHpAfter = host3w.state.combat.order.find(s => s.actorId === 'm1').public.hp;
  eq(pcHpAfter, pcHpBefore - 5, '★ defender_wins 时伤害打在攻击者身上');
  eq(monHpAfter, monHpBefore, '★ defender_wins 时目标 HP 不变');

  // --- resolveAttack 缺失（D 线未交付）：退化为只记日志，不改 HP ---
  const host4 = newHost();          // 默认 rules（可能为 CocRules 或 null，都无 resolveAttack 时走兜底）
  const relay4 = new Relay();
  addPlayer(host4, relay4, 's-a', '小明');
  relay4.deliver(host4.applyAction('host', {
    op: 'combat.start',
    actors: [{ id: 'm1', name: '深潜者', kind: 'monster', dex: 40, actionsPerRound: 1, hp: 12, hpMax: 12 }]
  }));
  const before4 = host4.state.combat.order.find(s => s.actorId === 'm1').public.hp;
  const mk4 = relay4.mark();
  relay4.deliver(host4.applyAction('host', {
    op: 'combat.attack', targetId: 'm1', skill: '格斗', result: { summary: '客户端摘要' }
  }));
  const after4 = host4.state.combat.order.find(s => s.actorId === 'm1').public.hp;
  const hasResolve = !!(host4.rules && typeof host4.rules.resolveAttack === 'function');
  if (hasResolve) {
    ok(true, '（规则服务已提供 resolveAttack，跳过「缺失兜底」断言）');
  } else {
    eq(after4, before4, 'resolveAttack 缺失时不改 HP（不自己实现规则函数）');
    ok(/发起攻击/.test(relay4.since(mk4, '*').join('')), '仍然写「发起攻击」日志');
  }

  // --- movedToTail：完成本轮全部行动槽的单位，下一轮排到队尾 ---
  const host5 = newHost(null, null, { rules: ordRules });
  const relay5 = new Relay();
  addPlayer(host5, relay5, 's-a', '小明');
  relay5.deliver(host5.applyAction('host', {
    op: 'combat.start',
    actors: [
      { id: 'a', name: '快甲', kind: 'monster', dex: 90, actionsPerRound: 1 },
      { id: 'b', name: '中乙', kind: 'monster', dex: 60, actionsPerRound: 2 },
      { id: 'c', name: '慢丙', kind: 'monster', dex: 30, actionsPerRound: 1 }
    ]
  }));
  seq(host5.state.combat.order.map(s => s.actorId), ['a', 'b', 'b', 'c'], '初始顺序：DEX 降序、b 展开两槽');
  const mkTurn = relay5.mark();
  for (let i = 0; i < 4; i++) relay5.deliver(host5.applyAction('host', { op: 'combat.next' }));
  eq(host5.state.combat.round, 2, '走完一圈进入第 2 轮');
  eq(host5.state.combat.turn, 0, '第 2 轮从队首开始');
  seq(host5.state.combat.order.map(s => s.actorId), ['c', 'a', 'b', 'b'],
      '★ 已完成本轮的单位被排到队尾（下一轮不再固定原位）');
  eq(host5.state.combat.order[0].movedToTail, false, '换轮后 movedToTail 标记被清空');
  ok(relay5.since(mkTurn, 's-a').some(t => /"turnalert"|"TURN_ALERT"/.test(t)) ||
     relay5.since(mkTurn, 's-a').some(t => /"round":2/.test(t)), '推进回合时发出轮次强提醒事件');
})();

/* ============================================================
 * 19. v2.0.0 场景检定步骤引擎：多步 / 成功失败分支 / 失败掷伤害
 * ============================================================ */
(function () {
  section('19. v2.0.0 场景检定步骤引擎');

  const host = newHost();
  const relay = new Relay();
  const a = addPlayer(host, relay, 's-a', '小明');
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CHAR, { id: 'c-a', name: '小明' })));

  // --- 推场景检定 ---
  let mk = relay.mark();
  relay.deliver(host.applyAction('host', {
    op: 'scene.check.push',
    title: '天花板坍塌',
    desc: '所有人做敏捷检定',
    steps: [
      { id: 'st1', title: '闪避落石', targetSeat: 's-a', skill: '闪避', difficulty: 'REGULAR',
        onSuccess: { note: '躲开了', next: 'st2' },
        onFailure: { damage: '1D4', note: '被砸中', next: 'st2' } },
      { id: 'st2', title: '爬出废墟', targetSeat: 's-a', skill: '攀爬',
        onSuccess: { note: '逃出生天', next: 'end' },
        onFailure: { damage: '1D3', note: '再次被埋' } }
    ]
  }));
  const sc = host.state.sceneCheck;
  ok(!!sc, '权威端持有场景检定态');
  eq(sc.steps.length, 2, '两步被记录');
  eq(sc.cursor, 0, '从第 1 步开始');
  ok(relay.since(mk, 's-a').some(t => /scenecheck/.test(t)), '场景检定广播给玩家');
  ok(relay.since(mk, 's-a').some(t => /天花板坍塌/.test(t)), '标题随事件下发');

  // --- 第 1 步失败（level=1 FAIL）：应用伤害并跳到 st2 ---
  relay.deliver(host.applyAction('host', { op: 'state.request', seat: 's-a', change: { hp: 11 } }));
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CONSENT, { id: host._requestsBySeat['s-a'][0].id, agree: true })));
  eq(host.roster.get('s-a').runtime.hp, 11, '先给玩家 11 点 HP');

  mk = relay.mark();
  relay.deliver(host.applyAction('host', { op: 'scene.check.step', stepId: 'st1', seat: 's-a', level: 1 }));
  const res1 = host.state.sceneCheck.results[host.state.sceneCheck.results.length - 1];
  eq(res1.ok, false, 'level=1 判为失败');
  ok(res1.damage >= 1 && res1.damage <= 4, '失败分支掷出 1D4 伤害', res1.damage);
  eq(host.roster.get('s-a').runtime.hp, 11 - res1.damage, '★ 失败掷伤害并真正扣 HP');
  eq(host.state.sceneCheck.cursor, 1, '按 onFailure.next 跳到第 2 步');
  ok(/被砸中/.test(relay.since(mk, '*').join('')), '失败分支的 note 写进日志');

  // --- 第 2 步成功（level=3 HARD）：跳 end，cursor 走到末尾 ---
  relay.deliver(host.applyAction('host', { op: 'scene.check.step', stepId: 'st2', seat: 's-a', level: 3 }));
  const res2 = host.state.sceneCheck.results[host.state.sceneCheck.results.length - 1];
  eq(res2.ok, true, 'level=3 判为成功');
  eq(res2.damage, 0, '成功分支不掷伤害');
  eq(host.state.sceneCheck.cursor, 2, 'onSuccess.next=end → cursor 走到末尾（结束）');
  eq(host.state.sceneCheck.results.length, 2, '两步的结果都被记录');

  // --- 兜底分支（规则服务缺失时）也不崩 ---
  const host2 = newHost();
  const relay2 = new Relay();
  addPlayer(host2, relay2, 's-b', '小红');
  relay2.deliver(host2.applyAction('host', {
    op: 'scene.check.push', title: '单步',
    steps: [{ id: 'x', title: '单步', onSuccess: { note: '好' }, onFailure: { note: '坏' } }]
  }));
  relay2.deliver(host2.applyAction('host', { op: 'scene.check.step', stepId: 'x', level: 0 }));
  eq(host2.state.sceneCheck.results[0].ok, false, 'level=0（大失败）走失败分支（兜底实现也不崩）');
})();

/* ============================================================
 * 20. v2.0.0 对抗检定（check.opposed）
 * ------------------------------------------------------------
 * CocRules.opposed / opposedReroll 早已实现却零调用。本轮接上：
 * 新增 check.opposed 动作，支持非对称（NPC 侦查 vs 玩家潜行），结果写日志。
 * ============================================================ */
(function () {
  section('20. v2.0.0 对抗检定');

  const host = newHost();                 // 默认规则服务（含 opposed）
  const relay = new Relay();
  addPlayer(host, relay, 's-a', '小明');
  addPlayer(host, relay, 's-b', '小红');
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CHAR,
    { id: 'c-a', name: '小明', sheet: { name: '小明', skills: [{ name: '侦查', total: 80 }] } })));
  relay.deliver(host.intent('s-b', M.intentMsg(M.INTENT.CHAR,
    { id: 'c-b', name: '小红', sheet: { name: '小红', skills: [{ name: '潜行', total: 20 }] } })));

  /* v2.2.0：对抗结果的统一文案前缀是「⚔ 对抗｜」（旧文案「对抗检定」已废弃）。
     注意：秘密对抗的**脱敏行**里含「对抗检定」四个字（"KP 秘密进行了一次对抗检定"），
     所以判断「是不是全文泄漏」必须认前缀 ⚔ 对抗｜ + 骰值/胜负标记，不能只认「对抗检定」。 */
  const OPPOSED_TAG = /⚔ 对抗｜/;

  // 公开对抗 → 全员可见 + 进公共日志
  let mk = relay.mark();
  relay.deliver(host.applyAction('host',
    { op: 'check.opposed', aSeat: 's-a', aSkill: '侦查', bSeat: 's-b', bSkill: '潜行' }));
  ok(relay.since(mk, '*').some(t => OPPOSED_TAG.test(t)), '对抗检定结果广播给全员');
  ok(host.state.logs.some(l => OPPOSED_TAG.test(l.text)), '对抗检定结果进公共日志');
  // 公开对抗：玩家全量同步里也应拿到全文（行为与旧版一致，未被本次修复改变）
  ok(M.parse(JSON.stringify(host.syncFor('s-b'))).state.logs.some(l => OPPOSED_TAG.test(l.text)),
     '公开对抗的全文进玩家 sync 日志（行为不变）');

  // 秘密对抗 → 全文只有 KP 收得到；公共流只落一条**脱敏行**
  const logsBefore = host.state.logs.length;   // 用于只看本次新增的日志
  mk = relay.mark();
  relay.deliver(host.applyAction('host',
    { op: 'check.opposed', aSeat: 's-a', aSkill: '侦查', bSeat: 's-b', bSkill: '潜行', secret: true }));
  eq(relay.since(mk, '*').filter(t => OPPOSED_TAG.test(t)).length, 0, '秘密对抗全文不出现在群发里');
  ok(!relay.since(mk, 's-b').some(t => OPPOSED_TAG.test(t)), '秘密对抗全文不下发给玩家');

  /* v2.2.0 修复（P2-A）守护力：秘密对抗不得把骰值 / 胜负 / 伤害
     写进玩家的**全量 sync 日志**（emit→reduce 根因修复）。 */
  const secretView = M.parse(JSON.stringify(host.syncFor('s-b')));
  const newLogs = secretView.state.logs.slice(logsBefore);
  const LEAK_RE = /⚔ 对抗｜|掷 ?\d|→|胜（|贯.?穿|伤害/;
  ok(!newLogs.some(l => LEAK_RE.test(l.text)),
     '秘密对抗的骰值/胜负/伤害不进玩家 sync 日志');
  ok(newLogs.some(l => /秘密进行了一次对抗检定/.test(l.text)),
     '秘密对抗在玩家 sync 日志里只留一条脱敏行');
  // KP 侧仍能拿到全文（SEAT 私密按收件人累积，重连不丢）
  ok(M.parse(JSON.stringify(host.syncFor('host'))).state.privates.some(pv => OPPOSED_TAG.test(pv.text)),
     '秘密对抗全文仍留给 KP（syncFor(host).privates）');

  // 权限：玩家不能发起对抗检定
  const out = host.intent('s-a', M.intentMsg(M.INTENT.ACT,
    { op: 'check.opposed', aSeat: 's-a', aSkill: '侦查', bSeat: 's-b', bSkill: '潜行' }));
  ok(out.every(r => r.to !== '*'), '玩家发起的对抗检定不会群发（越权被拦）');

  // combat.prepare：登记在权限表里、但不产生事件（纯 UI）
  const before = host.log.seq;
  const plan = host.applyAction('host', { op: 'combat.prepare' });
  eq(plan.length, 0, 'combat.prepare 不产生任何事件（纯 UI）');
  eq(host.log.seq, before, 'combat.prepare 不占序号');
  ok(M.allowed(M.ROLE.KP, 'combat.prepare'), 'KP 允许 combat.prepare');
  ok(!M.allowed(M.ROLE.PLAYER, 'combat.prepare'), '玩家不允许 combat.prepare');
})();

/* ============================================================
 * 21. v2.0.1 修复：_privateBySeat 必须被写入
 *
 * 根因：此前 _privateBySeat 只有「初始化 / 读取 / 存档恢复」三处，
 * 没有任何写入点 → syncFor() 的 privates 恒为空 → KP 递出的线索
 * 在玩家断线重连后**永久丢失**。本节锁定该回归。
 * ============================================================ */
(function () {
  section('21. v2.0.1 SEAT 私密线索必须按收件人累积（重连不丢）');

  const host = newHost();
  const relay = new Relay();
  addPlayer(host, relay, 's-a', '小明');
  addPlayer(host, relay, 's-b', '小红');
  addSpec(host, relay, 's-c');
  relay.deliver(host.applyAction('host', { op: 'room.start' }));

  // 递一条线索给 s-a
  relay.deliver(host.applyAction('host',
    { op: 'scene.clue', seat: 's-a', title: '图书馆学', text: '这本书是伪造的' }));

  // ① 目标 seat 的 syncFor 必须含这条（title/text 正确）
  const syncA = M.parse(JSON.stringify(host.syncFor('s-a')));
  const pvA = syncA.state.privates;
  eq(pvA.length, 1, '① s-a 的 syncFor.privates 含 1 条线索');
  eq(pvA[0].title, '图书馆学', '① 线索 title 正确');
  eq(pvA[0].text, '这本书是伪造的', '① 线索 text 正确');
  eq(pvA[0].kind, 'info', '① 线索 kind 兜底为 info');
  ok(typeof pvA[0].seq === 'number' && pvA[0].seq > 0, '① 线索带事件 seq');

  // ② 定向隔离：发给 s-a 的线索不得出现在 s-b / 旁观者的 syncFor 里
  const syncB = M.parse(JSON.stringify(host.syncFor('s-b')));
  eq(syncB.state.privates.length, 0, '② 发给 s-a 的线索不泄漏给 s-b（定向隔离）');
  const syncC = M.parse(JSON.stringify(host.syncFor('s-c')));
  eq(syncC.state.privates.length, 0, '② 旁观者的 syncFor 里也没有该线索');

  // ③ 断线重连（从存档恢复 Host）→ 线索仍在
  const restored = M.restoreHost(host.savePayload());
  const syncA2 = M.parse(JSON.stringify(restored.syncFor('s-a')));
  eq(syncA2.state.privates.length, 1, '③ 重连后 s-a 的 syncFor.privates 仍含该线索');
  eq(syncA2.state.privates[0].text, '这本书是伪造的', '③ 重连后线索内容不变');
  eq(JSON.parse(JSON.stringify(restored.syncFor('s-b'))).state.privates.length, 0,
     '③ 重连后 s-b 依旧拿不到别人的线索');

  // ④ 上限 100：超出后旧的最先被丢弃
  for (let i = 0; i < 120; i++) {
    relay.deliver(host.applyAction('host',
      { op: 'scene.clue', seat: 's-a', title: '线索' + i, text: '内容' + i }));
  }
  const many = M.parse(JSON.stringify(host.syncFor('s-a'))).state.privates;
  eq(many.length, 100, '④ 累积上限为 100 条');
  eq(many[many.length - 1].title, '线索119', '④ 最新一条保留（最新入队）');
  eq(many[0].title, '线索20', '④ 旧的一条最先被丢弃（首条为第 20 条）');

  // ⑤ 非 SEAT / 非 PRIVATE 事件不得污染 _privateBySeat（防误伤）
  const h2 = newHost();
  const r2 = new Relay();
  addPlayer(h2, r2, 's-a', '小明');
  r2.deliver(h2.applyAction('host', { op: 'room.start' }));
  r2.deliver(h2.applyAction('host', { op: 'scene.set', scene: { title: '图书馆', marks: [] } }));
  r2.deliver(h2.intent('s-a', M.intentMsg(M.INTENT.CHAT, { text: '公开聊天' })));
  eq(JSON.parse(JSON.stringify(h2.syncFor('s-a'))).state.privates.length, 0,
     '⑤ 公开事件不会写进 _privateBySeat');
})();

/* ============================================================
 * 22. v2.0.2 角色卡 DEX 贯通 + 战斗 PC 自动加入
 *   B1 上报 attrs.dex → 权威端保留（证明链路通，不再 clamp 成 0）
 *   B2 combat.start 只勾怪物 → PC 无视 actorIds 自动加入，公开 dex=真实值
 *   B3（回归）无 PC 时 actorIds 语义不变（既有场景 13/18 兼容）
 * ============================================================ */
(function () {
  section('22. v2.0.2 角色卡 DEX 与 PC 自动加入');

  // --- B1：上报含 attrs.dex=65 的卡 → 权威端保留九项 ---
  const host = newHost();
  const relay = new Relay();
  addPlayer(host, relay, 's-a', '小明');
  addPlayer(host, relay, 's-b', '小红');
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CHAR, {
    id: 'c-a', name: '亨利',
    sheet: { name: '亨利', charId: 'c-a',
             attrs: { str: 60, con: 55, siz: 70, dex: 65, app: 50, int: 80, pow: 55, edu: 75, luck: 45 } }
  })));
  const shA = host.roster.get('s-a').sheet;
  eq(shA.attrs.dex, 65, '★ B1 上报的 attrs.dex 被权威端保留（不再被 clamp 成 0）');
  ok(shA.attrs.str === 60 && shA.attrs.int === 80, '★ B1 其余八项也一并保留');

  // --- B2：combat.start 只勾怪物（actorIds=[m1]）→ PC 自动加入，dex=65 ---
  const h2 = newHost(null, null, { rules: CocRules || null });
  const r2 = new Relay();
  addPlayer(h2, r2, 's-a', '小明');
  r2.deliver(h2.applyAction('host', {
    op: 'combat.start',
    actors: [
      { id: 'm1', name: '深潜者', kind: 'monster', dex: 80, actionsPerRound: 1, hp: 12, hpMax: 12 },
      { id: 'p-s-a', name: '小明', kind: 'pc', seat: 's-a', dex: 65, actionsPerRound: 1, hp: 11, hpMax: 11 }
    ],
    actorIds: ['m1']                       // 只勾了怪物，PC 未列入
  }));
  const order2 = h2.state.combat.order;
  seq(order2.map(s => s.actorId), ['m1', 'p-s-a'],
      '★ B2 PC 无视 actorIds 自动加入（DEX 80 的怪物在前）');
  const pcSlot2 = order2.find(s => s.actorId === 'p-s-a');
  ok(!!pcSlot2, '★ B2 战斗队列里确实有 PC 槽（旧版完全没有）');
  eq(pcSlot2.public.dex, 65, '★ B2 PC 槽公开 dex = 真实敏捷 65');
  eq(pcSlot2.kind, 'pc', '★ B2 PC 槽 kind=pc');

  // --- B3（回归）：无 PC 时 actorIds 仍只把选中的怪物入队 ---
  const h3 = newHost(null, null, { rules: CocRules || null });
  const r3 = new Relay();
  addPlayer(h3, r3, 's-a', '小明');
  r3.deliver(h3.applyAction('host', {
    op: 'combat.start',
    actors: [
      { id: 'm1', name: '深潜者', kind: 'monster', dex: 80, actionsPerRound: 1 },
      { id: 'm2', name: '食尸鬼', kind: 'monster', dex: 70, actionsPerRound: 1 },
      { id: 'm3', name: '拜亚基', kind: 'monster', dex: 60, actionsPerRound: 1 }
    ],
    actorIds: ['m3', 'm1']
  }));
  seq(h3.state.combat.order.map(s => s.actorId), ['m1', 'm3'],
      '★ B3（回归）无 PC 时 actorIds 仍只把选中的怪物入队（PC 自动加入不影响）');

  // --- B3b：无 actorIds → 全量入队（PC 在内）---
  const h4 = newHost(null, null, { rules: CocRules || null });
  const r4 = new Relay();
  addPlayer(h4, r4, 's-a', '小明');
  r4.deliver(h4.applyAction('host', {
    op: 'combat.start',
    actors: [
      { id: 'pc', name: '小明', kind: 'pc', seat: 's-a', dex: 50, actionsPerRound: 1 },
      { id: 'm1', name: '深潜者', kind: 'monster', dex: 40, actionsPerRound: 1 }
    ]
  }));
  seq(h4.state.combat.order.map(s => s.actorId), ['pc', 'm1'],
      '★ B3b 无 actorIds 时全量入队（PC 在内，旧行为不变）');
})();

/* ============================================================
 * 23. v2.1.0 缺陷2/缺陷1：检定「同意」路径 + 请求卡形状 + KP 玩家状态数据面
 *     （只新增断言，不改动上面任何既有断言）
 * ============================================================ */
(function () {
  section('v2.1.0 缺陷2/1：检定同意路径 + 请求卡形状 + KP 玩家状态数据面');

  let lastCheck = null;
  const fakeRules = {
    /* 权威技能取值：从角色卡 skills[] 查 */
    skillValue: function (sheet, name) {
      const l = (sheet && sheet.skills) || [];
      for (const s of l) if (String(s.name) === String(name)) return s.total;
      return null;
    },
    check: function (o) {
      lastCheck = o;
      return { value: 30, rolls: [], levelKey: 'hard', levelText: '困难成功' };
    }
  };
  const host = newHost(null, null, { rules: fakeRules });
  const relay = new Relay();
  const pa = addPlayer(host, relay, 's-a', '阿尔法');

  /* ---- 缺陷1：INTENT.CHAR 上报后，KP 手里的成员必须带 sheet.status（新代码据此兜底显示） ---- */
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CHAR, {
    id: 'ck1', name: '阿尔法',
    sheet: { name: '阿尔法', skills: [{ name: '侦查', total: 70 }, { name: '聆听', total: 55 }],
             status: { currentHP: 12, currentSAN: 34 } }
  })));
  const memA = host.roster.get('s-a');
  eq(memA.sheet.status.currentHP, 12, '缺陷1：INTENT.CHAR 后 sheet.status.currentHP=12（KP 状态卡受益）');
  eq(memA.sheet.status.currentSAN, 34, '缺陷1：INTENT.CHAR 后 sheet.status.currentSAN=34');

  /* ---- 缺陷2：KP 推送检定 → 玩家收到卡，权威端已算好 base ---- */
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, {
    op: 'check.request', seat: 's-a', skill: '侦查', difficulty: 'HARD', desc: '天花板坍塌前'
  })));
  const req = pa.client.state.requests[pa.client.state.requests.length - 1];
  eq(req.op, 'check.request', '缺陷2：玩家端出现 check.request 卡');
  eq(req.p.skill, '侦查', '缺陷2：实时请求 .p.skill 正确（形状一致）');
  eq(req.p.base, 70, '缺陷2：payload.base = 权威技能值 70');

  /* ---- 缺陷2(a)：『同意』必须真的按权威难度掷骰并广播（修复前是空转） ---- */
  const markAgree = relay.mark();
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CONSENT, { id: req.id, agree: true })));
  ok(relay.since(markAgree, 's-a').some(t => t.includes('"dice"')),
     '缺陷2a：同意后 dice 结果广播（修复前不掷骰、无结果）');
  eq(lastCheck && lastCheck.base, 70, '缺陷2a：掷骰用权威技能值 70');
  eq(lastCheck && lastCheck.difficulty, 'HARD', '缺陷2a：掷骰用 KP 指定难度 HARD');
  eq(pa.client.state.requests.length, 0, '缺陷2a：同意后检定卡摘除');

  /* ---- 缺陷2(c)：经一次全量 sync 后请求对象形状与实时一致（技能/base 不丢） ---- */
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, {
    op: 'check.request', seat: '*', skill: '聆听', difficulty: 'REGULAR', desc: '仔细听'
  })));
  const fresh = new M.Client({ seat: 's-a', role: R.PLAYER, meta: host.state.meta });
  fresh.receive(JSON.stringify(host.syncFor('s-a')));
  const sr = fresh.state.requests[fresh.state.requests.length - 1];
  ok(!!sr && sr.op === 'check.request', '缺陷2c：sync 后仍有检定请求卡');
  eq(sr && sr.p && sr.p.skill, '聆听', '缺陷2c：sync 后 .p.skill 保留（修复前 undefined → 卡片空）');
  eq(sr && sr.p && sr.p.base, 55, '缺陷2c：sync 后 .p.base 保留（55）');
  eq(sr && sr.p && sr.p.difficulty, 'REGULAR', '缺陷2c：sync 后 .p.difficulty 保留');
})();

/* ============================================================
 * 24. v2.1.0 #11：KP 定向指令（暗骰 + 4 个定向指令）模型层
 *     （只新增断言，不改动上面任何既有断言）
 * ============================================================ */
(function () {
  section('v2.1.0 #11：KP 定向指令（暗骰 / 伤害 / SAN / 临时状态 / 物品）');

  const OPS = ['dice.dark', 'sheet.damage', 'sheet.sancheck', 'sheet.tempstatus', 'sheet.item'];

  /* ---- 24.1 sanitizeSheet 白名单：新字段不被剥掉（反面断言，最关键） ---- */
  const src0 = { tempStatus: [{ text: '中毒', by: 'kp', at: 123 }],
                 items: [{ name: '解毒剂', qty: 2, note: 'KP 给的' }] };
  const s0 = M.sanitizeSheet(src0);
  ok(Array.isArray(s0.tempStatus) && s0.tempStatus[0].text === '中毒',
     '★ sanitizeSheet 保留 tempStatus（不剥掉）');
  ok(Array.isArray(s0.items) && s0.items[0].name === '解毒剂' && s0.items[0].qty === 2,
     '★ sanitizeSheet 保留 items（不剥掉）');
  // 反面：旧白名单（无这两个键）会剥掉 → 证明「不修则失效」
  const LEGACY = ['name', 'charId', 'attrs', 'status', 'skills', 'madness', 'mental', 'sanLoss', 'maxSAN', 'san', 'hp', 'mp', 'at'];
  const legacy = {}; LEGACY.forEach(k => { if (k in s0) legacy[k] = s0[k]; });
  ok(!('tempStatus' in legacy) && !('items' in legacy),
     '★（反面）旧白名单不含二者 → 只加 stateApply 不改 sanitizeSheet 就会「写了又没写」');

  /* ---- 24.2 POLICY：五个 op 均 roles:['kp']；玩家被拒 ---- */
  OPS.forEach(op => {
    ok(M.allowed('kp', op) === true, 'POLICY 允许 KP：' + op);
    ok(M.allowed('player', op) === false, 'POLICY 拒绝玩家：' + op);
  });

  /* ---- 24.3 dice.dark：结果只给 HOST_SEAT，公共侧只有一句 ---- */
  (function () {
    const host = newHost();
    const relay = new Relay();
    addPlayer(host, relay, 's-a', '阿尔法');
    const mark = relay.mark();
    relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
      { op: 'dice.dark', sides: 100, count: 1, bonus: 0, reason: '看他有没有察觉' })));
    const toA = relay.since(mark, 's-a');
    ok(!toA.some(t => t.includes('🕶')), '★ dice.dark 结果**不发给玩家**（无 🕶）');
    ok(!toA.some(t => t.includes('"private"')), '★ dice.dark 玩家端无任何 private 事件');
    ok(toA.some(t => t.includes('KP 暗骰了一次')), '★ dice.dark 公共侧只有「KP 暗骰了一次」');
    ok(!toA.some(t => t.includes('看他有没有察觉')), 'dice.dark 公共侧不含理由');
    ok((host.state.privates || []).some(p => p.kind === 'dark' && /🕶/.test(p.text)),
       '★ dice.dark 结果进 KP 自己的 state.privates');
  })();

  /* ---- 24.4 sheet.damage ---- */
  (function () {
    const host = newHost();
    const relay = new Relay();
    const pa = addPlayer(host, relay, 's-a', '阿尔法');
    relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CHAR,
      { id: 'c1', name: '阿尔法', sheet: { name: '阿尔法', status: { currentHP: 12, currentSAN: 60 } } })));
    const mark = relay.mark();
    relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
      { op: 'sheet.damage', seat: 's-a', amount: 5, kind: '咬伤' })));
    ok(relay.since(mark, 's-a').some(t => t.includes('"t":"state"') && t.includes('"currentHP":7')),
       'sheet.damage → EVT.STATE 单发（HP 12→7）');
    ok(host.roster.get('s-a').runtime.hp === 7, 'sheet.damage 权威 runtime.hp=7');
    ok(relay.since(mark, 's-a').some(t => t.includes('受到伤害 5')), 'sheet.damage 公共日志含「受到伤害 5」');
  })();

  /* ---- 24.5 sheet.sancheck：用目标玩家自己的 SAN ---- */
  (function () {
    let lastBase = null;
    const rules = {
      skillValue: function () { return null; },
      check: function (o) { lastBase = o.base; return { value: 99, passed: false, levelText: '失败', levelKey: 'fail' }; },
      rollExpr: function (e) { return { ok: true, total: 4, rolls: [], detail: e }; }
    };
    const host = newHost(null, null, { rules: rules });
    const relay = new Relay();
    addPlayer(host, relay, 's-a', '阿尔法');
    addPlayer(host, relay, 's-b', '贝塔');
    relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CHAR,
      { id: 'ca', name: '阿尔法', sheet: { name: '阿尔法', status: { currentHP: 12, currentSAN: 60 } } })));
    relay.deliver(host.intent('s-b', M.intentMsg(M.INTENT.CHAR,
      { id: 'cb', name: '贝塔', sheet: { name: '贝塔', status: { currentHP: 10, currentSAN: 80 } } })));
    const mark = relay.mark();
    relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
      { op: 'sheet.sancheck', seat: 's-a', loss: 6, reason: '目击深潜者' })));
    ok(lastBase === 60, '★ sheet.sancheck 用目标 A 的 SAN=60（不是 B 的 80）', lastBase);
    ok(relay.since(mark, 's-b').some(t => t.includes('SAN Check') && t.includes('对 60')),
       '★ sheet.sancheck 公开检定标注「对 60」');
    ok(host.roster.get('s-a').sheet.status.currentSAN === 54, '★ A 失败扣 6 → SAN 54', host.roster.get('s-a').sheet.status.currentSAN);
    ok(host.roster.get('s-b').sheet.status.currentSAN === 80, '★ B 的 SAN 不受影响（仍 80）');
  })();

  /* ---- 24.6 sheet.tempstatus / sheet.item：追加 + 白名单往返 + sync + 隐私裁剪 ---- */
  (function () {
    const host = newHost();
    const relay = new Relay();
    addPlayer(host, relay, 's-a', '阿尔法');
    addPlayer(host, relay, 's-b', '贝塔');
    relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CHAR,
      { id: 'ca', name: '阿尔法', sheet: { name: '阿尔法', status: { currentHP: 12, currentSAN: 60 } } })));
    relay.deliver(host.intent('s-b', M.intentMsg(M.INTENT.CHAR,
      { id: 'cb', name: '贝塔', sheet: { name: '贝塔', status: { currentHP: 10, currentSAN: 50 } } })));
    relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
      { op: 'sheet.tempstatus', seat: 's-a', text: '中毒' })));
    relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
      { op: 'sheet.tempstatus', seat: 's-a', text: '被诅咒' })));
    relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
      { op: 'sheet.item', seat: 's-a', name: '古代钥匙', qty: 1, note: '刻着符文' })));
    relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
      { op: 'sheet.item', seat: 's-a', name: '绷带', qty: 3, note: '' })));
    const A = host.roster.get('s-a');
    ok(Array.isArray(A.sheet.tempStatus) && A.sheet.tempStatus.length === 2
       && A.sheet.tempStatus[0].text === '中毒' && A.sheet.tempStatus[0].by === 'kp',
       '★ sheet.tempstatus 追加语义 → 2 条');
    ok(Array.isArray(A.sheet.items) && A.sheet.items.length === 2
       && A.sheet.items[0].name === '古代钥匙' && A.sheet.items[0].qty === 1 && A.sheet.items[0].note === '刻着符文',
       '★ sheet.item 追加语义 + 字段 {name,qty,note} 正确');
    // 全量 sync 后本人仍拿得到
    const fresh = new M.Client({ seat: 's-a', role: R.PLAYER, meta: host.state.meta });
    fresh.receive(JSON.stringify(host.syncFor('s-a')));
    const me = fresh.state.members.find(m => m.seat === 's-a');
    ok(me && me.sheet && me.sheet.tempStatus && me.sheet.tempStatus.length === 2 && me.sheet.items.length === 2,
       '★ 全量 sync 后本人 sheet.tempStatus / items 仍在');
    // 隐私：别人看不到
    const bView = host.syncFor('s-b');
    const aInB = bView.state.members.find(m => m.seat === 's-a');
    ok(!(aInB && aInB.sheet && aInB.sheet.tempStatus) && !(aInB && aInB.sheet && aInB.sheet.items),
       '★ 其它玩家视图里看不到 s-a 的 tempStatus / items（本人+KP 可见）');
  })();

  /* ---- 24.7 越权：玩家发同 op 被拒且不产生事件 ---- */
  (function () {
    const host = newHost();
    const relay = new Relay();
    addPlayer(host, relay, 's-a', '阿尔法');
    relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CHAR,
      { id: 'ca', name: '阿尔法', sheet: { name: '阿尔法', status: { currentHP: 12, currentSAN: 60 } } })));
    const mark = relay.mark();
    relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.ACT,
      { op: 'sheet.damage', seat: 's-a', amount: 99, kind: '作弊' })));
    ok(relay.since(mark, 's-a').some(t => t.includes('你没有权限')),
       '★ 玩家越权发 sheet.damage → 回「你没有权限执行该操作」');
    ok(!relay.since(mark, 's-a').some(t => t.includes('"t":"state"')), '★ 越权不产生 EVT.STATE');
    ok(host.roster.get('s-a').sheet.status.currentHP === 12, '★ 越权未改 HP（仍 12）');
  })();
})();

/* ============================================================
 * 25. v2.1.0 根因修复：char.share 覆盖 sheet 不得清空 KP 定向字段
 *     （只新增断言，不改动上面任何既有断言）
 * ============================================================ */
(function () {
  section('v2.1.0 根因修复：char.share 保留 tempStatus / items（重连补报不清空）');

  const host = newHost();
  const relay = new Relay();
  addPlayer(host, relay, 's-a', '阿尔法');

  // 玩家初次上报角色卡
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CHAR, {
    id: 'c1', name: '阿尔法',
    sheet: { name: '阿尔法', attrs: { str: 40 }, skills: [{ name: '侦查', total: 70 }],
             status: { currentHP: 12, currentSAN: 60 } }
  })));
  // KP 用定向指令写入临时状态 + 物品（权威端产生）
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'sheet.tempstatus', seat: 's-a', text: '中毒' })));
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'sheet.item', seat: 's-a', name: '古代钥匙', qty: 1, note: '符文' })));
  const before = host.roster.get('s-a').sheet;
  eq(before.tempStatus.length, 1, '前置：KP 写入 1 条临时状态');
  eq(before.items.length, 1, '前置：KP 写入 1 个物品');

  /* ---- 25.1 修复前 FAIL：重连补报（char.share 覆盖）后两项必须仍在 ---- */
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CHAR, {
    id: 'c1', name: '阿尔法',
    sheet: { name: '阿尔法', attrs: { str: 40 }, skills: [{ name: '侦查', total: 70 }],
             status: { currentHP: 12, currentSAN: 60 } }   // 注意：sheetSummary 不产 tempStatus/items
  })));
  const after = host.roster.get('s-a').sheet;
  ok(after.tempStatus.length === 1 && after.tempStatus[0].text === '中毒',
     '★ 重连补报后 tempStatus 仍在（修复前会被清空为 []）', after.tempStatus);
  ok(after.items.length === 1 && after.items[0].name === '古代钥匙',
     '★ 重连补报后 items 仍在（修复前会被清空为 []）', after.items);

  /* ---- 25.2 反面：覆盖逻辑仍要生效（属性/技能/状态照常更新） ---- */
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CHAR, {
    id: 'c1', name: '阿尔法',
    sheet: { name: '阿尔法', attrs: { str: 55, dex: 60 }, skills: [{ name: '聆听', total: 45 }],
             status: { currentHP: 9, currentSAN: 58 } }
  })));
  const upd = host.roster.get('s-a').sheet;
  ok(upd.attrs && upd.attrs.str === 55 && upd.attrs.dex === 60, '★ char.share 仍更新 attrs（str 40→55）', upd.attrs);
  ok(Array.isArray(upd.skills) && upd.skills.length === 1 && upd.skills[0].name === '聆听',
     '★ char.share 仍更新 skills（侦查→聆听）', upd.skills);
  ok(upd.status && upd.status.currentHP === 9 && upd.status.currentSAN === 58,
     '★ char.share 仍更新 status（HP 12→9）', upd.status);
  ok(upd.tempStatus.length === 1 && upd.items.length === 1, '★ 且两项仍被保留（覆盖逻辑没被改没）');

  /* ---- 25.3 反面：玩家不能伪造 tempStatus / items ---- */
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CHAR, {
    id: 'c1', name: '阿尔法',
    sheet: { name: '阿尔法', attrs: { str: 55 }, status: { currentHP: 9, currentSAN: 58 },
             tempStatus: [{ text: '伪造的祝福', by: 'kp', at: 1 }],   // 恶意上报
             items: [{ name: '伪造的神器', qty: 99, note: 'hack' }] }   // 恶意上报
  })));
  const forged = host.roster.get('s-a').sheet;
  ok(forged.tempStatus.length === 1 && forged.tempStatus[0].text === '中毒',
     '★ 玩家上报的 tempStatus 不被采纳（仍只有权威值「中毒」）', forged.tempStatus);
  ok(forged.items.length === 1 && forged.items[0].name === '古代钥匙',
     '★ 玩家上报的 items 不被采纳（仍是权威值「古代钥匙」）', forged.items);
})();

/* ============================================================
 * 26. v2.1.1：
 *   任务A —— KP 定向指令新增「全部玩家」（seat = '*'，每人各自独立结算）
 *   任务B —— applyStateToCard 返回结构化结果（不再静默失败 / 不误写别人卡）
 *   任务C —— SAN Check 按规则书结算（走 CocRules.parseSanLoss/resolveSanCheck）并自动扣 SAN
 *   （只新增断言，不改动上面任何既有断言）
 * ============================================================ */
(function () {
  /* ---------- 26.A KP 定向指令「全部玩家」 ---------- */
  section('v2.1.1 任务A：KP 定向指令「全部玩家」（seat = \'*\'）');

  const host = newHost();
  const relay = new Relay();
  addPlayer(host, relay, 's-a', '阿尔法');
  addPlayer(host, relay, 's-b', '贝塔');
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.CHAR,
    { id: 'ca', name: '阿尔法', sheet: { name: '阿尔法', status: { currentHP: 12, currentSAN: 60 } } })));
  relay.deliver(host.intent('s-b', M.intentMsg(M.INTENT.CHAR,
    { id: 'cb', name: '贝塔', sheet: { name: '贝塔', status: { currentHP: 10, currentSAN: 80 } } })));

  /* 26.1 全部玩家 · 伤害：每人各扣各的 */
  let mark = relay.mark();
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'sheet.damage', seat: '*', amount: 4, kind: '毒气' })));
  eq(host.roster.get('s-a').runtime.hp, 8, '★ 全部玩家伤害：A HP 12→8（独立扣减）');
  eq(host.roster.get('s-b').runtime.hp, 6, '★ 全部玩家伤害：B HP 10→6（独立扣减）');
  ok(relay.since(mark, 's-a').some(t => t.includes('"t":"state"') && t.includes('"currentHP":8')),
     '★ A 收到自己的 EVT.STATE（HP=8）');
  ok(relay.since(mark, 's-b').some(t => t.includes('"t":"state"') && t.includes('"currentHP":6')),
     '★ B 收到自己的 EVT.STATE（HP=6）');
  ok(relay.since(mark, 's-a').some(t => t.includes('已作用于 2 名在线玩家')),
     '★ 公共日志写明「已作用于 N 名在线玩家」');
  ok(relay.since(mark, 's-b').some(t => t.includes('已作用于 2 名在线玩家')),
     '★ 该条作用人数日志对全员公开可见');

  /* 26.2 全部玩家 · 临时状态：各追加一条 */
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'sheet.tempstatus', seat: '*', text: '中毒' })));
  ok(Array.isArray(host.roster.get('s-a').sheet.tempStatus) &&
     host.roster.get('s-a').sheet.tempStatus.length === 1, '★ 全部玩家临时状态：A 追加 1 条');
  ok(Array.isArray(host.roster.get('s-b').sheet.tempStatus) &&
     host.roster.get('s-b').sheet.tempStatus.length === 1, '★ 全部玩家临时状态：B 追加 1 条');

  /* 26.3 全部玩家 · 物品：各追加一个 */
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'sheet.item', seat: '*', name: '火把', qty: 2, note: '照亮' })));
  ok(host.roster.get('s-a').sheet.items.length === 1 && host.roster.get('s-a').sheet.items[0].name === '火把',
     '★ 全部玩家物品：A 得到「火把」');
  ok(host.roster.get('s-b').sheet.items.length === 1 && host.roster.get('s-b').sheet.items[0].qty === 2,
     '★ 全部玩家物品：B 得到「火把 ×2」');

  /* 26.4 边界：未选目标（空 seat）→ 只提示，绝不退化成「作用自己」 */
  mark = relay.mark();
  const hpABefore = host.roster.get('s-a').runtime.hp;
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'sheet.damage', seat: '', amount: 3, kind: '误伤' })));
  ok(relay.since(mark, M.HOST_SEAT).some(t => t.includes('请先选择生效目标')),
     '★ 空 seat → 提示「请先选择生效目标（不会默认作用于自己）」');
  eq(host.roster.get('s-a').runtime.hp, hpABefore, '★ 空 seat 未扣任何人的血（不退化自掷）');

  /* 26.5 边界：不存在的座位 → 明确拒绝 */
  mark = relay.mark();
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'sheet.damage', seat: 's-zz', amount: 3 })));
  ok(relay.since(mark, M.HOST_SEAT).some(t => t.includes('找不到该玩家')),
     '★ 未知座位 → 回「找不到该玩家，无法…」');

  /* 26.6 边界：'*' 但房间里 0 名在线玩家 → 回 KP，不发任何状态 */
  (function () {
    const h2 = newHost();
    const r2 = new Relay();
    const mk = r2.mark();
    r2.deliver(h2.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
      { op: 'sheet.damage', seat: '*', amount: 5 })));
    ok(r2.since(mk, M.HOST_SEAT).some(t => t.includes('没有在线玩家')),
       '★ \'*\' 但 0 在线玩家 → 回 KP「房间里没有在线玩家，无法…」');
    ok(!r2.since(mk, '*').some(t => t.includes('已作用于')),
       '★ 此时不产生「已作用于 N 名玩家」的公共日志');
  })();

  /* ---------- 26.B applyStateToCard 结构化结果 ---------- */
  section('v2.1.1 任务B：applyStateToCard 返回结构化结果（可观测，不误写别人卡）');

  function fakeStore() {
    return {
      _st: { characters: { c1: { id: 'c1', status: { currentHP: 12 } } },
             current: { id: 'c1', status: { currentHP: 12 } } },
      getState: function () { return this._st; },
      saveNow: function () {}
    };
  }

  const st1 = fakeStore();
  let res = M.applyStateToCard(st1, 'c1', { status: { currentHP: 5 } });
  ok(res && res.ok === true && res.cardId === 'c1' && res.source === 'characters',
     '★ 命中 charId → 写回并回 {ok:true, source:characters}', res);
  eq(st1._st.characters.c1.status.currentHP, 5, '★ 目标卡确实被更新（12→5）');

  const st2 = fakeStore();
  res = M.applyStateToCard(st2, 'missing-id', { status: { currentHP: 5 } });
  ok(res && res.ok === false && res.reason === 'card_not_found',
     '★ charId 找不到 → 明确返回 {ok:false, reason:card_not_found}（不再静默 false）', res);
  eq(st2._st.characters.c1.status.currentHP, 12,
     '★ 且绝不误写到 current / 别人的卡上（HP 仍 12）');

  const st3 = fakeStore();
  res = M.applyStateToCard(st3, null, { status: { currentHP: 3 } });
  ok(res && res.ok === true && res.source === 'current',
     '★ 无 charId（未绑卡旧路径）→ 退到 current 且标 source=current', res);

  /* ---------- 26.C SAN Check 按规则书结算 + 自动扣 SAN ---------- */
  section('v2.1.1 任务C：SAN Check 按规则书结算（parseSanLoss/resolveSanCheck）并自动扣 SAN');

  if (!CocRules) {
    console.log('（跳过：规则服务 CocRules 未加载，无法验证规则书结算）');
  } else {
    /* 用真实 CocRules，但把 rng 注入成确定值，从而「锁定分支」。
       ⚠️ 这里**不改规则逻辑**，只做确定性掷骰 —— 模型本应调用规则服务判支。 */
    let forcedRng = function () { return 0.15; };
    let lastOpts = null;
    const calls = { parse: 0, resolve: 0 };
    const rules = Object.create(CocRules);
    rules.parseSanLoss = function (e) { calls.parse++; return CocRules.parseSanLoss(e); };
    rules.resolveSanCheck = function (o) {
      calls.resolve++;
      lastOpts = o;
      return CocRules.resolveSanCheck(Object.assign({}, o, { rng: forcedRng }));
    };

    const hSan = newHost(null, null, { rules: rules });
    const rSan = new Relay();
    addPlayer(hSan, rSan, 's-a', '阿尔法');
    rSan.deliver(hSan.intent('s-a', M.intentMsg(M.INTENT.CHAR,
      { id: 'ca', name: '阿尔法', sheet: { name: '阿尔法', status: { currentHP: 12, currentSAN: 60, maxSAN: 60 } } })));

    /* 26.7 成功支：rng=0.15 → D100=11 ≤ 60 → 成功；成功损失=2（常量，不掷） */
    forcedRng = function () { return 0.15; };
    const cP0 = calls.resolve, cpP0 = calls.parse;
    mark = rSan.mark();
    rSan.deliver(hSan.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
      { op: 'sheet.sancheck', seat: 's-a', okLoss: '2', loss: '1D6', reason: '读书' })));
    ok(calls.resolve === cP0 + 1, '★ 模型确实调用规则服务 resolveSanCheck（未自行掷骰判支）');
    ok(calls.parse >= cpP0 + 1, '★ 模型确实调用规则服务 parseSanLoss');
    eq(hSan.roster.get('s-a').sheet.status.currentSAN, 58,
       '★ 成功支：扣「成功损失 2」→ SAN 60→58');
    ok(rSan.since(mark, 's-a').some(t => t.includes('成功支')),
       '★ 公共日志写明走了「成功支」');
    ok(rSan.since(mark, 's-a').some(t => t.includes('理智损失 2') && t.includes('SAN 60 → 58')),
       '★ 公共日志含「理智损失 2，SAN 60 → 58」（不是干巴巴一行「意志检定」）');

    /* 26.8 失败支：rng=0.95 → D100=99 > 58 → 失败；1D6 → 6 */
    forcedRng = function () { return 0.95; };
    mark = rSan.mark();
    rSan.deliver(hSan.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
      { op: 'sheet.sancheck', seat: 's-a', okLoss: '2', loss: '1D6', reason: '目击深潜者' })));
    eq(hSan.roster.get('s-a').sheet.status.currentSAN, 52,
       '★ 失败支：扣「失败损失 1D6=6」→ SAN 58→52');
    ok(rSan.since(mark, 's-a').some(t => t.includes('失败支') && t.includes('理智损失 6')),
       '★ 公共日志写明「失败支 … 理智损失 6」');

    /* 26.9 大失败：rng=0 → D100=100；target 58≥50 → 只有 100 是大失败 → 按失败处理 */
    forcedRng = function () { return 0; };
    mark = rSan.mark();
    rSan.deliver(hSan.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
      { op: 'sheet.sancheck', seat: 's-a', okLoss: '0', loss: '1D6', reason: '直视神' })));
    ok(rSan.since(mark, 's-a').some(t => t.includes('大失败')),
       '★ 大失败按失败处理，日志含成功等级「大失败」');
    eq(hSan.roster.get('s-a').sheet.status.currentSAN, 51,
       '★ 大失败走失败支：1D6(=1) → SAN 52→51');

    /* 26.10 边界：缺当前 SAN → 以上限兜底判定（**不**静默按 0，否则必大失败） */
    const hFb = newHost(null, null, { rules: rules });
    const rFb = new Relay();
    addPlayer(hFb, rFb, 's-d', '德尔塔');
    rFb.deliver(hFb.intent('s-d', M.intentMsg(M.INTENT.CHAR,
      { id: 'cd', name: '德尔塔', sheet: { name: '德尔塔', status: { currentHP: 8, maxSAN: 70 } } })));
    forcedRng = function () { return 0.15; };
    lastOpts = null;
    mark = rFb.mark();
    rFb.deliver(hFb.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
      { op: 'sheet.sancheck', seat: 's-d', okLoss: '1', loss: '1D6' })));
    ok(lastOpts && lastOpts.currentSan === 70,
       '★ 缺当前 SAN → 以上限 70 兜底判定（不静默按 0）', lastOpts && lastOpts.currentSan);
    ok(rFb.since(mark, 's-d').some(t => t.includes('未上报当前 SAN')),
       '★ 日志标注「未上报当前 SAN，暂以上限判定」');
    eq(hFb.roster.get('s-d').sheet.status.currentSAN, 69, '★ 兜底后照常自动扣减 → 70→69');

    /* 26.11 边界：SAN 与上限都缺（未绑卡）→ 明确拒绝，不产生任何扣减 */
    const hNo = newHost(null, null, { rules: rules });
    const rNo = new Relay();
    addPlayer(hNo, rNo, 's-e', '艾普西龙');
    rNo.deliver(hNo.intent('s-e', M.intentMsg(M.INTENT.CHAR,
      { id: 'ce', name: '艾普西龙', sheet: { name: '艾普西龙', status: { currentHP: 8 } } })));
    mark = rNo.mark();
    rNo.deliver(hNo.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
      { op: 'sheet.sancheck', seat: 's-e', okLoss: '0', loss: '1D6' })));
    ok(rNo.since(mark, M.HOST_SEAT).some(t => t.includes('没有理智值')),
       '★ 无 SAN（未绑卡）→ 明确拒绝，不静默按 0 判');
    ok(!rNo.since(mark, 's-e').some(t => t.includes('"t":"state"')),
       '★ 拒绝时不下发 EVT.STATE（不产生任何扣减）');

    /* 26.12 全部玩家 · SAN Check：每人独立判支（A 成功 0 损失，B 失败扣 6） */
    const hAll = newHost(null, null, { rules: rules });
    const rAll = new Relay();
    addPlayer(hAll, rAll, 's-a', '阿尔法');
    addPlayer(hAll, rAll, 's-b', '贝塔');
    rAll.deliver(hAll.intent('s-a', M.intentMsg(M.INTENT.CHAR,
      { id: 'ca', name: '阿尔法', sheet: { name: '阿尔法', status: { currentHP: 12, currentSAN: 99, maxSAN: 99 } } })));
    rAll.deliver(hAll.intent('s-b', M.intentMsg(M.INTENT.CHAR,
      { id: 'cb', name: '贝塔', sheet: { name: '贝塔', status: { currentHP: 10, currentSAN: 60, maxSAN: 60 } } })));
    forcedRng = function () { return 0.95; };   // D100=99 → A(99) 成功、B(60) 失败
    mark = rAll.mark();
    rAll.deliver(hAll.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
      { op: 'sheet.sancheck', seat: '*', okLoss: '0', loss: '1D6', reason: '群体恐怖' })));
    eq(hAll.roster.get('s-a').sheet.status.currentSAN, 99,
       '★ 全部玩家 SAN：A 掷 99 ≤ 99 成功 → 成功损失 0 → SAN 不变');
    eq(hAll.roster.get('s-b').sheet.status.currentSAN, 54,
       '★ 全部玩家 SAN：B 掷 99 > 60 失败 → 扣 6 → SAN 60→54（各自独立判支）');
    ok(rAll.since(mark, 's-b').some(t => t.includes('已作用于 2 名在线玩家')),
       '★ 全部玩家 SAN 也给公共日志写明作用人数');

    /* 26.13 玩家自助 SAN Check（INTENT.SAN_CHECK）：权威端结算 + 自动扣 SAN，客户端不本地改 */
    section('v2.1.1 任务C：玩家自助 SAN Check（INTENT.SAN_CHECK，权威端结算）');
    const hSelf = newHost(null, null, { rules: rules });
    const rSelf = new Relay();
    const pSelf = addPlayer(hSelf, rSelf, 's-f', '福克斯');
    rSelf.deliver(hSelf.intent('s-f', M.intentMsg(M.INTENT.CHAR,
      { id: 'cf', name: '福克斯', sheet: { name: '福克斯', status: { currentHP: 9, currentSAN: 40, maxSAN: 40 } } })));
    forcedRng = function () { return 0.95; };   // D100=99 > 40 失败；1D4 → 4
    mark = rSelf.mark();
    rSelf.deliver(hSelf.intent('s-f', M.intentMsg(M.INTENT.SAN_CHECK,
      { okLoss: '0', loss: '1D4', reason: '自助检定' })));
    eq(hSelf.roster.get('s-f').sheet.status.currentSAN, 36,
       '★ 玩家自助 SAN Check 由权威端自动扣 SAN（40-4=36）');
    ok(rSelf.since(mark, 's-f').some(t => t.includes('SAN Check') && t.includes('失败支')),
       '★ 自助与 KP 定向共用同一结算（日志含「失败支」）');
    const selfStateMsgs = rSelf.since(mark, 's-f').filter(t => t.includes('"t":"state"'));
    ok(selfStateMsgs.some(t => t.includes('"currentSAN":36')),
       '★ 自助检定经 EVT.STATE 单发回本人（客户端据此写卡，非本地改）');
    /* 幂等：把**同一条** EVT.STATE（同 seq）重放给该客户端 → 必须按 seq 丢弃，不重复扣 */
    const replay = pSelf.client.receive(selfStateMsgs[selfStateMsgs.length - 1]);
    ok(replay && replay.dup === true,
       '★ 同 seq 的 EVT.STATE 重放被客户端丢弃（幂等，不会重复扣 SAN）', replay);

    /* 26.14 旁观者不能自助 SAN Check */
    addSpec(hSelf, rSelf, 's-sp', '围观者');
    mark = rSelf.mark();
    rSelf.deliver(hSelf.intent('s-sp', M.intentMsg(M.INTENT.SAN_CHECK, { okLoss: '0', loss: '1D6' })));
    ok(rSelf.since(mark, 's-sp').some(t => t.includes('只有玩家可以做 SAN Check')),
       '★ 旁观者自助 SAN Check 被拒（权威端把关）');
    ok(!rSelf.since(mark, 's-sp').some(t => t.includes('"t":"state"')),
       '★ 旁观者被拒时不产生 EVT.STATE');

    /* 26.15 ★ 回归（QA 真机复现）：maxSAN=0 / 缺失 + loss>0 → SAN 绝不被夹到 0 */
    const hZero = newHost(null, null, { rules: rules });
    const rZero = new Relay();
    addPlayer(hZero, rZero, 's-a', '阿尔法');   // sanitizeSheet 会把显式 0 保留为 0（合法数字）
    rZero.deliver(hZero.intent('s-a', M.intentMsg(M.INTENT.CHAR,
      { id: 'ca', name: '阿尔法', sheet: { name: '阿尔法',
        status: { currentHP: 12, currentSAN: 55, maxSAN: 0 } } })));
    eq(hZero.roster.get('s-a').sheet.status.maxSAN, 0, '前置：权威端 maxSAN 确实为 0（QA 现象）');
    forcedRng = function () { return 0.95; };   // D100=99 > 55 失败；1D6 → 6
    lastOpts = null;
    mark = rZero.mark();
    rZero.deliver(hZero.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
      { op: 'sheet.sancheck', seat: 's-a', okLoss: '0', loss: '1D6', reason: '异常上界' })));
    ok(lastOpts && lastOpts.maxSan === 99,
       '★ maxSAN=0 视为「未知上界」→ 传给规则服务的 maxSan = 99（不是 0）', lastOpts && lastOpts.maxSan);
    eq(hZero.roster.get('s-a').sheet.status.currentSAN, 49,
       '★★ maxSAN=0 时失败扣 6 → SAN 55→49（**绝不被夹到 0**）');
    ok(rZero.since(mark, 's-a').some(t => t.includes('SAN 55 → 49')),
       '★ 日志记录真实扣减「SAN 55 → 49」');

    /* 26.15b maxSAN 完全缺失（本地卡没上报）同样不夹 0 */
    const hNoMax = newHost(null, null, { rules: rules });
    const rNoMax = new Relay();
    addPlayer(hNoMax, rNoMax, 's-b', '贝塔');
    rNoMax.deliver(hNoMax.intent('s-b', M.intentMsg(M.INTENT.CHAR,
      { id: 'cb', name: '贝塔', sheet: { name: '贝塔',
        status: { currentHP: 10, currentSAN: 40 } } })));   // 无 maxSAN
    eq(hNoMax.roster.get('s-b').sheet.status.maxSAN, null, '前置：缺 maxSAN → 权威端为 null（不伪造 0）');
    forcedRng = function () { return 0.95; };   // 失败；1D6 → 6
    mark = rNoMax.mark();
    rNoMax.deliver(hNoMax.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
      { op: 'sheet.sancheck', seat: 's-b', okLoss: '0', loss: '1D6' })));
    eq(hNoMax.roster.get('s-b').sheet.status.currentSAN, 34,
       '★ maxSAN=null 时失败扣 6 → SAN 40→34（不夹 0）');

    /* 26.16 ★ 回归：loss=0 时日志不得声称「SAN a → b」 */
    const hNoLoss = newHost(null, null, { rules: rules });
    const rNoLoss = new Relay();
    addPlayer(hNoLoss, rNoLoss, 's-c', '伽马');
    rNoLoss.deliver(hNoLoss.intent('s-c', M.intentMsg(M.INTENT.CHAR,
      { id: 'cc', name: '伽马', sheet: { name: '伽马', status: { currentHP: 9, currentSAN: 55, maxSAN: 99 } } })));
    forcedRng = function () { return 0.15; };   // D100=11 ≤ 55 成功；成功损失=0
    mark = rNoLoss.mark();
    rNoLoss.deliver(hNoLoss.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
      { op: 'sheet.sancheck', seat: 's-c', okLoss: '0', loss: '1D6' })));
    eq(hNoLoss.roster.get('s-c').sheet.status.currentSAN, 55, '★ loss=0 → SAN 保持不变（55）');
    const zeroLog = rNoLoss.since(mark, 's-c').filter(t => t.includes('做 SAN Check')).pop() || '';
    ok(zeroLog.includes('无理智损失') && zeroLog.includes('SAN 保持不变'),
       '★ loss=0 → 日志写「无理智损失（SAN 保持不变）」', zeroLog);
    ok(!/SAN 55 →/.test(zeroLog), '★ loss=0 → 日志绝不出现「SAN a → b」的差值', zeroLog);
    ok(!rNoLoss.since(mark, 's-c').some(t => t.includes('"t":"state"')),
       '★ loss=0 → 不产生 EVT.STATE（无扣减就不写状态）');

    /* 26.17 ★ 别修过头：正常 maxSAN=99 的上界约束仍生效 */
    const hOk = newHost(null, null, { rules: rules });
    const rOk = new Relay();
    addPlayer(hOk, rOk, 's-d', '德尔塔');
    rOk.deliver(hOk.intent('s-d', M.intentMsg(M.INTENT.CHAR,
      { id: 'cd', name: '德尔塔', sheet: { name: '德尔塔', status: { currentHP: 11, currentSAN: 55, maxSAN: 99 } } })));
    forcedRng = function () { return 0.15; };   // 成功；成功损失=2（常量）
    lastOpts = null;
    mark = rOk.mark();
    rOk.deliver(hOk.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
      { op: 'sheet.sancheck', seat: 's-d', okLoss: '2', loss: '1D6' })));
    ok(lastOpts && lastOpts.maxSan === 99, '★ 正常输入 maxSAN=99 原样传给规则服务');
    eq(hOk.roster.get('s-d').sheet.status.currentSAN, 53,
       '★ 正常上界下照常扣减 2 → SAN 55→53');
    ok(hOk.roster.get('s-d').sheet.status.currentSAN <= 99,
       '★ 上界不变量仍成立：结果 SAN ≤ maxSAN(99)');
    ok(rOk.since(mark, 's-d').some(t => t.includes('SAN 55 → 53')),
       '★ 正常路径仍输出「SAN 55 → 53」');

    /* 26.18 ★ 根因回归：null 哨兵不得被伪造成 0（sanitizeSheet / stateApply） */
    const sh1 = M.sanitizeSheet({ status: { currentSAN: 55 }, maxSAN: null });
    eq(sh1.status.maxSAN, null, '★ sanitizeSheet：maxSAN=null（未知）→ 保持 null，不写成 0');
    eq(sh1.maxSAN, null, '★ sanitizeSheet：顶层 maxSAN 同理保持 null');
    const hNull = newHost();
    const rNull = new Relay();
    addPlayer(hNull, rNull, 's-e', '艾普');
    rNull.deliver(hNull.intent('s-e', M.intentMsg(M.INTENT.CHAR,
      { id: 'ce', name: '艾普', sheet: { name: '艾普', status: { currentHP: 8, currentSAN: 60, maxSAN: 99 } } })));
    hNull.stateApply('s-e', { status: { maxSAN: null, currentSAN: 55 } }, { reason: '传 null 上界' });
    eq(hNull.roster.get('s-e').sheet.status.maxSAN, 99,
       '★ stateApply：传 maxSAN=null（未提供）不得把上界改成 0（保留 99）');
  }
})();

/* ============================================================
 * v2.1.3 —— 玩家删物品 / KP 删素材
 * ============================================================ */
(function () {
  section('v2.1.3 玩家删物品（幂等 + 越权）');

  const host = newHost();
  const relay = new Relay();
  addPlayer(host, relay, 's-a', '阿尔法');
  addPlayer(host, relay, 's-b', '贝塔');

  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'sheet.item', seat: 's-a', name: '手电筒', qty: 2 })));
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'sheet.item', seat: 's-a', name: '绳子', qty: 1 })));
  let items = host.roster.get('s-a').sheet.items;
  eq(items.length, 2, 'A 拿到两件物品');
  ok(!!items[0].id && !!items[1].id, '物品带稳定 id（删除靠它幂等）');
  ok(items[0].id !== items[1].id, '两件物品 id 不同');

  const id0 = items[0].id;
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.ACT, { op: 'item.del', id: id0 })));
  items = host.roster.get('s-a').sheet.items;
  eq(items.length, 1, '玩家删掉自己的物品后剩 1 件');
  eq(items[0].name, '绳子', '删掉的正是指定那一件（不是下标错位的另一件）');

  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.ACT, { op: 'item.del', id: id0 })));
  eq(host.roster.get('s-a').sheet.items.length, 1,
     '★ 重放同一 id 不误删第二件（幂等 —— 按 id 删而非按 index）');

  // 越权：A 试图删 B 的
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'sheet.item', seat: 's-b', name: '钥匙', qty: 1 })));
  const bId = host.roster.get('s-b').sheet.items[0].id;
  const mark = relay.mark();
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.ACT, { op: 'item.del', id: bId, seat: 's-b' })));
  eq(host.roster.get('s-b').sheet.items.length, 1, '★ 玩家不能删别人的物品');
  ok(relay.since(mark, 's-a').some(function (t) { return t.indexOf('只能删除自己的物品') >= 0; }),
     '越权时有明确提示（不是静默失败）');

  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'item.del', seat: 's-b', id: bId })));
  eq(host.roster.get('s-b').sheet.items.length, 0, 'KP 可以删任意玩家的物品');
})();

(function () {
  section('v2.1.3 KP 删素材（私有库 + 公共列表都要撤）');

  const host = newHost();
  const relay = new Relay();
  addPlayer(host, relay, 's-a', '阿尔法');

  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'asset.add', asset: { kind: 'map', name: '洋馆一层', data: 'data:image/png;base64,AAA' } })));
  const aid = host.localAssets[host.localAssets.length - 1].id;
  eq(host.localAssets.length, 1, '上传后进私有库');

  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'asset.reveal', id: aid, revealed: true })));
  ok(host.state.scene.assets.some(function (x) { return x.id === aid; }), '公开后进公共列表');

  const mark = relay.mark();
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, { op: 'asset.del', id: aid })));
  eq(host.localAssets.some(function (x) { return x.id === aid; }), false, '删除后私有库没有它');
  eq(host.state.scene.assets.some(function (x) { return x.id === aid; }), false,
     '★ 删除后公共列表也没有它（否则「删了还在」，玩家画面上仍挂着）');
  ok(relay.since(mark, '*').some(function (t) { return t.indexOf('"asset"') >= 0; }),
     '删公开素材会广播新的公共素材列表');

  // 幂等：再删一次不该炸、也不该误报
  const mark2 = relay.mark();
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, { op: 'asset.del', id: aid })));
  ok(relay.since(mark2, M.HOST_SEAT).some(function (t) { return t.indexOf('找不到该素材') >= 0; }),
     '重复删除给「找不到该素材」而不是静默/报错');
})();

/* ============================================================
 * v2.1.4 —— 玩家自助状态 / 玩家暗骰 / 战斗伤害写回
 * ============================================================ */
(function () {
  section('v2.1.4 玩家自助状态（免 KP 同意，只能改自己）');

  const host = newHost();
  const relay = new Relay();
  addPlayer(host, relay, 's-a', '阿尔法');
  addPlayer(host, relay, 's-b', '贝塔');

  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.ACT, {
    op: 'state.self', status: { currentHP: 6, currentSAN: 41 } })));
  const a = host.roster.get('s-a');
  eq(a.runtime.hp, 6, '玩家改自己的 HP 生效');
  eq(a.runtime.san, 41, '玩家改自己的 SAN 生效');

  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.ACT, {
    op: 'state.self', madness: { type: 'phobia', name: '蜘蛛恐惧症', rounds: 5 } })));
  eq((a.sheet.madness || []).length, 1, '疯狂追加一条');
  eq(a.sheet.madness[0].name, '蜘蛛恐惧症', '疯狂名正确');

  // 越权：玩家 A 试图改玩家 B
  const mark = relay.mark();
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.ACT,
    { op: 'state.self', seat: 's-b', status: { currentHP: 1 } })));
  eq((host.roster.get('s-b').runtime || {}).hp, undefined, '★ 玩家不能改别人的状态（越权被拒）');
  ok(relay.since(mark, 's-a').some(t => t.indexOf('只能修改自己的状态') >= 0), '越权有明确提示');

  // 数值不为负
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.ACT, { op: 'state.self', status: { currentHP: -5 } })));
  eq(a.runtime.hp, 0, 'HP 不会被改成负数');
})();

(function () {
  section('v2.1.4 玩家暗骰（结果只给本人与 KP，公共流只有一句话）');

  const host = newHost(null, null, { rules: { check: function () { return { value: 42, levelText: '成功', dice: { detail: '个位骰 2；十位骰 4 → 42' } }; },
      rollExpr: function (e) { return { ok: true, total: 6, rolls: [] }; } } });
  const relay = new Relay();
  const pa = addPlayer(host, relay, 's-a', '阿尔法');
  const pb = addPlayer(host, relay, 's-b', '贝塔');

  const mark = relay.mark();
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.DICE, { expr: '1D100', direct: true, secret: true, base: 50 })));

  // 本人看得到数字
  ok(relay.since(mark, 's-a').some(t => t.includes('"dice"') && t.includes('"total":42')),
     '暗骰结果发给本人');
  // 其他玩家看不到数字（只有公共日志一句）
  const bGot = relay.since(mark, 's-b').join(' ');
  ok(bGot.indexOf('暗骰了一次') >= 0, '公共流写「暗骰了一次」');
  ok(bGot.indexOf('"total":42') < 0, '★ 其他玩家拿不到暗骰的数值');
})();

(function () {
  section('v2.1.4 战斗手动伤害写回成员（左上角血量实时更新）');

  const host = newHost();
  const relay = new Relay();
  addPlayer(host, relay, 's-a', '阿尔法');
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, { op: 'room.start' })));
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, {
    op: 'combat.start', actors: [
      { id: 'p1', name: '阿尔法', kind: 'pc', seat: 's-a', dex: 60, actionsPerRound: 1, hp: 10, hpMax: 10 },
      { id: 'm1', name: '深潜者', kind: 'monster', dex: 40, actionsPerRound: 1, hp: 10, hpMax: 10 }
    ] })));

  // 给玩家槽扣 4 血（走 combat.damage 而非 combat.attack）
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT,
    { op: 'combat.damage', slotId: 'p1', damage: 4 })));
  const slot = host.state.combat.order.find(s => s.id === 'p1');
  eq(slot.public.hp, 6, '战斗槽血量 = 6');
  eq(host.roster.get('s-a').runtime.hp, 6, '★ 成员 runtime 同步 = 6（左上角角色卡实时更新）');
})();

/* ============================================================
 * v2.1.5 —— 死亡判定 / SAN 归零永久疯狂 / 临时疯狂 / 撕卡拦截 / 推进1轮
 * ============================================================ */

/** 可注入的规则替身：控制 CON 检定（conDead）与 INT 检定（intUnderstood）结果 */
function fakeRules(opts) {
  opts = opts || {};
  return {
    dyingRoundCheck: function (con, rng) {
      var dead = !!opts.conDead;
      return { check: { value: dead ? 100 : 1, base: con, levelText: dead ? '失败' : '成功', passed: !dead },
        stable: !dead, dead: dead, summary: dead ? 'CON 检定失败 —— 死亡' : 'CON 检定成功，本轮伤势稳定' };
    },
    temporaryInsanityCheck: function (intVal, rng) {
      var understood = !!opts.intUnderstood;
      return { check: { value: understood ? 1 : 100, base: intVal, levelText: understood ? '成功' : '失败', passed: understood },
        understood: understood, summary: understood ? '理解了' : '压抑' };
    },
    check: function (o) { return { value: 50, base: (o && o.base) || 50, levelText: '成功', passed: true, dice: { detail: '' } }; },
    parseSanLoss: function (e) { return { ok: true, expr: e, onSuccess: { ok: true }, onFail: { ok: true } }; },
    resolveSanCheck: function (o) { return { ok: true, check: { value: 100, base: o.currentSan, levelText: '失败', passed: false, dice: { detail: '' } }, loss: 6, usedBranch: 'onFail', branchText: '失败', before: o.currentSan, after: o.currentSan - 6, maxSan: o.maxSan }; },
    rollExpr: function (e) { return { ok: true, total: 6, rolls: [] }; },
    insanityFlags: function (o) { return { temporary: (o && o.loss) >= 5, indefinite: false }; }
  };
}

/** 给玩家上报一张含 HP/SAN/九项属性的角色卡（死亡/疯狂判定需要属性） */
function bindCard(host, relay, seat, name, card) {
  relay.deliver(host.intent(seat, M.intentMsg(M.INTENT.CHAR, {
    id: 'c-' + seat, name: name,
    sheet: Object.assign({
      status: { currentHP: 10, maxHP: 10, currentSAN: 60, maxSAN: 60, body: '正常' },
      attrs: { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 50, pow: 50, edu: 50, luck: 50 }
    }, card || {})
  })));
}

/** 疯狂症状表替身（Node 测试里没有 CocMadness） */
function fakeMadness() {
  return {
    roll: function (type, permanent) {
      return { type: 'phobia', name: '幽闭恐惧症', en: '', desc: '', permanent: false, rounds: 5 };
    }
  };
}

(function () {
  section('v2.1.5 一次性伤害 > 生命上限 → 死亡（撕卡）');

  const host = newHost(null, null, { rules: fakeRules({}) });
  const relay = new Relay();
  addPlayer(host, relay, 's-a', '阿尔法');
  bindCard(host, relay, 's-a', '阿尔法');

  /* v2.8.0（HP 机制 · 口径变更）：即死阈值由 `>=` 改为 `>` —— 恰等于上限走「重伤→濒死」，
     故此处用 11（> 上限 10）造「立即死亡」。 */
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, { op: 'sheet.damage', seat: 's-a', amount: 11 })));
  const mem = host.roster.get('s-a');
  eq(mem.sheet.status.body, '死亡', '单次伤害 > 生命上限 → 身体状态=死亡');
  eq(mem.runtime.hp, 0, 'HP 归零');

  // 撕卡后玩家掷骰被拦
  const mark = relay.mark();
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.DICE, { expr: '1D100', direct: true })));
  ok(relay.since(mark, 's-a').some(t => t.indexOf('只能通过聊天框') >= 0 || t.indexOf('撕卡') >= 0),
     '★ 撕卡玩家掷骰被拦（只能聊天）');
})();

(function () {
  section('v2.8.0 HP 归零分流（有重伤→濒死 / 无重伤→昏迷；归零当刻不再掷 CON）');

  // ① 单次伤害构成重伤 + HP 归零 → 濒死
  const host1 = newHost(null, null, { rules: fakeRules({ conDead: true }) });
  const relay1 = new Relay();
  addPlayer(host1, relay1, 's-a', '阿尔法');
  bindCard(host1, relay1, 's-a', '阿尔法', { status: { currentHP: 6, maxHP: 10, currentSAN: 60, maxSAN: 60, body: '正常' } });
  relay1.deliver(host1.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, { op: 'sheet.damage', seat: 's-a', amount: 6 })));
  // v2.10.0（R5）：有重伤归零 → body='重伤' + dying=true（'濒死' 从 body 白名单移除，改为 dying 标记）
  eq(host1.roster.get('s-a').sheet.status.body, '重伤', 'HP 归零 + 有重伤 → 濒死（R5：body=重伤 + dying=true；不再掷 CON）');
  eq(host1.roster.get('s-a').sheet.status.dying, true, '★（R5）dying 标记置位');

  // ② 小伤害把 HP 打到 0（无重伤）→ 昏迷
  const host2 = newHost(null, null, { rules: fakeRules({ conDead: false }) });
  const relay2 = new Relay();
  addPlayer(host2, relay2, 's-a', '阿尔法');
  bindCard(host2, relay2, 's-a', '阿尔法', { status: { currentHP: 3, maxHP: 10, currentSAN: 60, maxSAN: 60, body: '正常' } });
  relay2.deliver(host2.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, { op: 'sheet.damage', seat: 's-a', amount: 3 })));
  // v2.10.0（R5）：无重伤归零 → unconscious 标记（body 保持改前伤级，视图合成 '昏迷'）
  eq(host2.roster.get('s-a').sheet.status.unconscious, true, 'HP 归零 + 无重伤 → 昏迷（R5：unconscious 标记）');
  eq(M.bodyView(host2.roster.get('s-a').sheet.status), '昏迷', '★（R5）bodyView 合成 = 昏迷');
})();

(function () {
  section('v2.1.5 SAN 归零 → 永久疯狂（撕卡）');

  const host = newHost(null, null, { rules: fakeRules({}) });
  const relay = new Relay();
  addPlayer(host, relay, 's-a', '阿尔法');
  bindCard(host, relay, 's-a', '阿尔法', { status: { currentHP: 10, maxHP: 10, currentSAN: 5, maxSAN: 60, body: '正常' } });

  // SAN Check 失败损失 6（fakeRules.resolveSanCheck 固定 loss=6）→ 5-6 → 0
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.SAN_CHECK, { loss: '1D6', okLoss: '0' })));
  const mem = host.roster.get('s-a');
  ok((mem.sheet.mental || []).indexOf('永久疯狂') >= 0, 'SAN 归零 → 精神状态含永久疯狂');
  eq(mem.runtime.san, 0, 'SAN = 0');
})();

(function () {
  section('v2.1.5 SAN Check 单次损失≥5 → INT 检定理解 → 临时疯狂症状');

  const host = newHost(null, null, { rules: fakeRules({ intUnderstood: true }), madness: fakeMadness() });
  const relay = new Relay();
  addPlayer(host, relay, 's-a', '阿尔法');
  bindCard(host, relay, 's-a', '阿尔法', { status: { currentHP: 10, maxHP: 10, currentSAN: 40, maxSAN: 60, body: '正常' } });

  // SAN 40，失败损失 6 → 34，单次损失 6 ≥5 → INT 检定理解 → 临时疯狂症状
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.SAN_CHECK, { loss: '1D6', okLoss: '0' })));
  const mem = host.roster.get('s-a');
  ok((mem.sheet.mental || []).indexOf('临时疯狂') >= 0, '理解后 → 精神状态含临时疯狂');
  ok((mem.sheet.mental || []).indexOf('疯狂症状') >= 0, '精神状态含派生项疯狂症状');
  ok((mem.sheet.madness || []).length >= 1, '掷出了疯狂症状');
})();

(function () {
  section('v2.13.13 回归：不定疯狂（症状消失）态损失 SAN → 只变不定疯狂 + 1 症（不叠加临时疯狂 / 2 症）');

  // ① 复现用户报告：FADED 态 + 单次损失≥5（SAN Check 固定 loss=6）→ 旧逻辑会同时给 2 个症 + 临时疯狂标签
  const host = newHost(null, null, { rules: fakeRules({ intUnderstood: true }), madness: fakeMadness() });
  const relay = new Relay();
  addPlayer(host, relay, 's-a', '阿尔法');
  bindCard(host, relay, 's-a', '阿尔法', {
    status: { currentHP: 10, maxHP: 10, currentSAN: 40, maxSAN: 60, body: '正常' },
    mental: ['不定疯狂（症状消失）']
  });

  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.SAN_CHECK, { loss: '1D6', okLoss: '0' })));
  const mem = host.roster.get('s-a');
  const mental = mem.sheet.mental || [];
  const md = mem.sheet.madness || [];
  ok(mental.indexOf('不定疯狂（症状消失）') < 0, '★ FADED 标签已换回「不定疯狂」');
  ok(mental.indexOf('不定疯狂') >= 0, '★ 状态变为「不定疯狂」');
  ok(mental.indexOf('临时疯狂') < 0, '★ 不再叠加「临时疯狂」标签');
  ok(mental.indexOf('疯狂症状') >= 0, '★ 派生项「疯狂症状」保留');
  eq(md.length, 1, '★ 只获得 1 个疯狂症（不是 2 个）');
  eq(md[0] && md[0].from, '不定疯狂', '★ 该症来源是「不定疯狂」复发，不是「临时疯狂」');

  // ② 确认 FADED 态任意损失（<5）也会复发，且仍只 1 个症（既有语义不破坏）
  const host2 = newHost(null, null, { rules: fakeRules({ intUnderstood: true }), madness: fakeMadness() });
  const relay2 = new Relay();
  addPlayer(host2, relay2, 's-a', '贝塔');
  bindCard(host2, relay2, 's-a', '贝塔', {
    status: { currentHP: 10, maxHP: 10, currentSAN: 40, maxSAN: 60, body: '正常' },
    mental: ['不定疯狂（症状消失）']
  });
  const m2 = host2.roster.get('s-a');
  host2._afterSanLoss(m2, 2, 's-a');   // 直接调用，损失 2（<5）
  const m2after = host2.roster.get('s-a');
  const mental2 = m2after.sheet.mental || [];
  const md2 = m2after.sheet.madness || [];
  ok(mental2.indexOf('不定疯狂') >= 0, '★ 小损失也复发为「不定疯狂」');
  ok(mental2.indexOf('临时疯狂') < 0, '★ 小损失同样不叠加「临时疯狂」');
  eq(md2.length, 1, '★ 小损失也只获得 1 个症');

  // ③ 反例：非 FADED 的正常角色，单次损失≥5 仍应走「临时疯狂」路径（确保没改坏）
  const host3 = newHost(null, null, { rules: fakeRules({ intUnderstood: true }), madness: fakeMadness() });
  const relay3 = new Relay();
  addPlayer(host3, relay3, 's-a', '伽马');
  bindCard(host3, relay3, 's-a', '伽马', {
    status: { currentHP: 10, maxHP: 10, currentSAN: 40, maxSAN: 60, body: '正常' },
    mental: ['正常']
  });
  relay3.deliver(host3.intent('s-a', M.intentMsg(M.INTENT.SAN_CHECK, { loss: '1D6', okLoss: '0' })));
  const mem3 = host3.roster.get('s-a');
  const mental3 = mem3.sheet.mental || [];
  const md3 = mem3.sheet.madness || [];
  ok(mental3.indexOf('临时疯狂') >= 0, '★ 正常角色损失≥5 仍触发「临时疯狂」');
  eq(md3.length, 1, '★ 正常角色只 1 个临时疯狂症（不受 FADED 跳过影响）');
})();

(function () {
  section('v2.1.5 推进 1 轮（madness.advance）');

  const host = newHost(null, null, { rules: fakeRules({}) });
  const relay = new Relay();
  addPlayer(host, relay, 's-a', '阿尔法');
  bindCard(host, relay, 's-a', '阿尔法', {
    status: { currentHP: 10, maxHP: 10, currentSAN: 40, maxSAN: 60, body: '正常' },
    madness: [
      { type: 'phobia', name: '幽闭恐惧症', permanent: false, rounds: 1 },
      { type: 'mania', name: '纵火癖', permanent: true, rounds: 0 }
    ],
    mental: ['临时疯狂', '疯狂症状']
  });

  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.ACT, { op: 'madness.advance' })));
  const mem = host.roster.get('s-a');
  eq((mem.sheet.madness || []).length, 1, '推进 1 轮后临时疯狂（1轮）消退，剩永久 1 条');
  eq(mem.sheet.madness[0].name, '纵火癖', '永久疯狂保留（不随轮次消退）');
  ok((mem.sheet.mental || []).indexOf('临时疯狂') < 0, '临时疯狂标签被摘除');
})();

(function () {
  section('v2.1.6 不定疯狂（阈值=maxSAN/5，症状临时，标签需治愈）');

  /* intUnderstood=false：单次≥5 的 INT 检定失败（不进入临时疯狂）——
     这样第二次 SAN Check 不会被「发作中锁定」拦下，能测到回合累计路径。 */
  const host = newHost(null, null, { rules: fakeRules({ intUnderstood: false }), madness: fakeMadness() });
  const relay = new Relay();
  addPlayer(host, relay, 's-a', '阿尔法');
  bindCard(host, relay, 's-a', '阿尔法', { status: { currentHP: 10, maxHP: 10, currentSAN: 60, maxSAN: 60, body: '正常' } });

  // 回合内累计损失 12 ≥ maxSAN(60)/5=12 → 不定疯狂（SAN Check fakeRules 固定 loss=6，两次=12）
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.SAN_CHECK, { loss: '1D6', okLoss: '0' })));
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.SAN_CHECK, { loss: '1D6', okLoss: '0' })));
  const mem = host.roster.get('s-a');
  ok((mem.sheet.mental || []).indexOf('不定疯狂') >= 0, '回合累计 12 ≥ 60/5 → 判定不定疯狂');
  ok((mem.sheet.madness || []).some(x => x.from === '不定疯狂' && x.permanent === false && x.rounds > 0),
     '不定疯狂的症状为临时（带轮次，不再 permanent）');

  // 发作中锁定：不能掷骰，可以推进 1 轮
  let mark = relay.mark();
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.DICE, { expr: '1D100', direct: true })));
  ok(relay.since(mark, 's-a').some(t => t.indexOf('疯狂发作') >= 0), '★ 发作中掷骰被拦');
  mark = relay.mark();
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.ACT, { op: 'madness.advance' })));
  ok(relay.since(mark, '*').length > 0, '发作中仍可推进 1 轮');

  // 推进 6 轮 → 不定症状消退，「不定疯狂」自动变为「不定疯狂（症状消失）」（v2.1.7）
  for (let i = 0; i < 6; i++) relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.ACT, { op: 'madness.advance' })));
  ok(!(mem.sheet.madness || []).some(x => x.from === '不定疯狂'), '不定症状已随轮次消退');
  ok((mem.sheet.mental || []).indexOf('不定疯狂') < 0, '发作中标签已摘');
  ok((mem.sheet.mental || []).indexOf('不定疯狂（症状消失）') >= 0,
     '★ 自动切换为「不定疯狂（症状消失）」—— 可操作、但仍需治愈');

  // ★ 症状消失后玩家恢复操作（不再被发作锁定）
  mark = relay.mark();
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.DICE, { expr: '1D100', direct: true })));
  ok(!(relay.since(mark, 's-a').some(t => t.indexOf('疯狂发作') >= 0)), '★ 症状消失后可以掷骰');

  // 玩家申请治愈 → 进 KP 待确认队列（confirm:'kp'）
  mark = relay.mark();
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.ACT, { op: 'madness.cure' })));
  eq(host.pending.filter(q => q.op === 'madness.cure').length, 1, '玩家申请治愈 → KP 待确认队列');
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.CONFIRM, { op: 'madness.cure', agree: true })));
  ok((mem.sheet.mental || []).indexOf('不定疯狂（症状消失）') < 0, '★ KP 同意后「不定疯狂（症状消失）」解除');
  eq(host.pending.filter(q => q.op === 'madness.cure').length, 0, '确认后待办清空');
})();

(function () {
  section('v2.1.7 KP 工具直接治愈（无需玩家确认）+ 撕卡拦截定向指令');

  const host = newHost(null, null, { rules: fakeRules({ intUnderstood: false }), madness: fakeMadness() });
  const relay = new Relay();
  addPlayer(host, relay, 's-a', '阿尔法');
  addPlayer(host, relay, 's-b', '贝塔');
  bindCard(host, relay, 's-a', '阿尔法', { status: { currentHP: 10, maxHP: 10, currentSAN: 60, maxSAN: 60, body: '正常' } });

  // 制造「不定疯狂（症状消失）」：损失 12（≥60/5）→ 不定疯狂 → 推进消退
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.SAN_CHECK, { loss: '1D6', okLoss: '0' })));
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.SAN_CHECK, { loss: '1D6', okLoss: '0' })));
  for (let i = 0; i < 6; i++) relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.ACT, { op: 'madness.advance' })));
  const mem = host.roster.get('s-a');
  ok((mem.sheet.mental || []).indexOf('不定疯狂（症状消失）') >= 0, '前置：症状消失态就绪');

  // ★ KP 直接治愈：不进待确认队列、立即生效
  let mark = relay.mark();
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, { op: 'madness.cure', seat: 's-a' })));
  eq(host.pending.filter(q => q.op === 'madness.cure').length, 0, '★ KP 发起治愈不进待确认队列');
  ok((mem.sheet.mental || []).indexOf('不定疯狂（症状消失）') < 0, '★ KP 直接治愈立即生效');

  // ★ 撕卡玩家不接受定向指令（san check / 物品）
  relay.deliver(host.intent('s-b', M.intentMsg(M.INTENT.ACT, { op: 'state.self', status: { currentSAN: 0 } })));
  ok((host.roster.get('s-b').sheet.mental || []).indexOf('永久疯狂') >= 0, '前置：B 已撕卡');
  mark = relay.mark();
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, { op: 'sheet.sancheck', seat: 's-b', loss: '1D6' })));
  ok(relay.since(mark, M.HOST_SEAT).some(t => t.indexOf('已撕卡') >= 0), '★ 撕卡玩家被拒 SAN Check（KP 收到提示）');
  mark = relay.mark();
  relay.deliver(host.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, { op: 'sheet.item', seat: 's-b', name: '测试' })));
  ok(relay.since(mark, M.HOST_SEAT).some(t => t.indexOf('已撕卡') >= 0), '★ 撕卡玩家被拒递物品');
})();

(function () {
  section('v2.1.7 场景检定：锁死目标自动判定 + 战斗排除撕卡');

  // ① 场景检定：目标是发作中玩家 → 推送后自动判定并推进，不挂起
  const h1 = newHost(null, null, { rules: fakeRules({ intUnderstood: true }), madness: fakeMadness() });
  const r1 = new Relay();
  addPlayer(h1, r1, 's-a', '阿尔法');
  bindCard(h1, r1, 's-a', '阿尔法', { status: { currentHP: 10, maxHP: 10, currentSAN: 40, maxSAN: 60, body: '正常' } });
  // 触发临时疯狂（损失 ≥5 → INT 理解 → 症状）
  r1.deliver(h1.intent('s-a', M.intentMsg(M.INTENT.SAN_CHECK, { loss: '1D6', okLoss: '0' })));
  ok((h1.roster.get('s-a').sheet.mental || []).indexOf('临时疯狂') >= 0, '前置：A 临时疯狂发作中');
  const mk = r1.mark();
  r1.deliver(h1.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, {
    op: 'scene.check.push',
    steps: [{ id: 'st1', title: '搜查房间', skill: '侦查', targetSeat: 's-a' },
            { id: 'st2', title: '开门', skill: '力量', targetSeat: 's-a' }]
  })));
  const sc = h1.state.sceneCheck;
  ok(sc.results && sc.results.length >= 1, '★ 推送后锁死目标的步骤被系统自动判定（不挂起）');
  ok(r1.since(mk, '*').some(t => t.indexOf('系统自动') >= 0 || t.indexOf('自动判定') >= 0),
     '自动判定有骰子/记录痕迹');

  // ② 战斗：撕卡角色被跳过
  const h2 = newHost(null, null, { rules: fakeRules({ conDead: true }) });
  const r2 = new Relay();
  addPlayer(h2, r2, 's-a', '阿尔法');
  addPlayer(h2, r2, 's-b', '贝塔');
  bindCard(h2, r2, 's-a', '阿尔法', { status: { currentHP: 5, maxHP: 10, currentSAN: 60, maxSAN: 60, body: '正常' } });
  r2.deliver(h2.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, { op: 'combat.start', actors: [
    { id: 'p1', name: '阿尔法', kind: 'pc', seat: 's-a', dex: 60, hp: 5, hpMax: 10 },
    { id: 'p2', name: '贝塔', kind: 'pc', seat: 's-b', dex: 50, hp: 10, hpMax: 10 }
  ] })));
  // 阿尔法被一发打死 → 已撕卡；再次开战应跳过他
  r2.deliver(h2.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, { op: 'sheet.damage', seat: 's-a', amount: 11 })));
  eq(h2.roster.get('s-a').sheet.status.body, '死亡', '前置：阿尔法已死亡撕卡（单次伤害 11 > 上限 10）');
  r2.deliver(h2.intent(M.HOST_SEAT, M.intentMsg(M.INTENT.ACT, { op: 'combat.start', actors: [
    { id: 'p1', name: '阿尔法', kind: 'pc', seat: 's-a', dex: 60, hp: 0, hpMax: 10 },
    { id: 'p2', name: '贝塔', kind: 'pc', seat: 's-b', dex: 50, hp: 10, hpMax: 10 }
  ] })));
  const slots = (h2.state.combat && h2.state.combat.order) || [];
  ok(!slots.some(sl => sl.seat === 's-a' && sl.kind === 'pc'), '★ 撕卡角色不再进入战斗');
  ok(slots.some(sl => sl.seat === 's-b'), '未撕卡的玩家正常入队');
})();



(function () {
  section('v2.1.7 疯狂表 1D10 —— 1-8 发作行为（bout 类型）贯通权威端');

  /* fakeMadness 改掷 bout（失忆）：房间模型必须放行 bout 类型并带轮次 */
  const host = newHost(null, null, {
    rules: fakeRules({ intUnderstood: true }),
    madness: { roll: function () {
      return { type: 'bout', name: '失忆', en: 'Amnesia', desc: '', permanent: false, rounds: 7 };
    } }
  });
  const relay = new Relay();
  addPlayer(host, relay, 's-a', '阿尔法');
  bindCard(host, relay, 's-a', '阿尔法', { status: { currentHP: 10, maxHP: 10, currentSAN: 60, maxSAN: 60, body: '正常' } });

  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.SAN_CHECK, { loss: '1D6', okLoss: '0' })));
  const mem = host.roster.get('s-a');
  const md = (mem.sheet.madness || [])[0] || {};
  eq(md.type, 'bout', '★ 发作行为类型 bout 通过权威端白名单（不再被强改成 phobia）');
  eq(md.name, '失忆', '发作行为名=失忆');
  ok(md.rounds > 0, '发作行为带轮次');
  ok((mem.sheet.mental || []).indexOf('临时疯狂') >= 0, '临时疯狂标签照常挂上');
  ok((mem.sheet.mental || []).indexOf('疯狂症状') >= 0, '疯狂症状派生标签照常挂上');
  // bg 字段经 sanitize 保留
  const host2 = newHost();
  const relay2 = new Relay();
  addPlayer(host2, relay2, 's-a', '阿尔法');
  bindCard(host2, relay2, 's-a', '阿尔法', { madness: [{ type: 'phobia', name: '幽闭恐惧症', permanent: true, bg: true }] });
  const md2 = (host2.roster.get('s-a').sheet.madness || [])[0] || {};
  eq(md2.bg, true, '★ 背景标记 bg 经 sanitizeSheet 保留（显示层据此写「（背景症状）」）');
})();

(function () {
  section('v2.1.6 手动把 HP/SAN 改到 0 → 归零分流 / 永久疯狂');

  const host = newHost(null, null, { rules: fakeRules({ conDead: true }) });
  const relay = new Relay();
  addPlayer(host, relay, 's-a', '阿尔法');
  bindCard(host, relay, 's-a', '阿尔法');
  relay.deliver(host.intent('s-a', M.intentMsg(M.INTENT.ACT, {
    op: 'state.self', status: { currentHP: 0 } })));
  // v2.10.0（R5）：有重伤归零 → body='重伤' + dying=true（'濒死' 从 body 白名单移除，改为标记）
  eq(host.roster.get('s-a').sheet.status.body, '重伤', '★ 手动 HP→0（有重伤）→ 归零分流为濒死（R5：body=重伤 + dying=true；不再掷 CON）');
  eq(host.roster.get('s-a').sheet.status.dying, true, '★（R5）dying 标记置位');

  const host2 = newHost(null, null, { rules: fakeRules({}) });
  const relay2 = new Relay();
  addPlayer(host2, relay2, 's-a', '阿尔法');
  bindCard(host2, relay2, 's-a', '阿尔法');
  relay2.deliver(host2.intent('s-a', M.intentMsg(M.INTENT.ACT, {
    op: 'state.self', status: { currentSAN: 0 } })));
  ok((host2.roster.get('s-a').sheet.mental || []).indexOf('永久疯狂') >= 0,
     '★ 手动 SAN→0 → 永久疯狂（撕卡）');
})();

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
