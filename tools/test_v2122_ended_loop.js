/* ============================================================
 * test_v2122_ended_loop.js —— 「房间已结束」链路 + 重连死循环修复
 *
 * 背景（用户实测的两个 bug）：
 *   ① 局域网网页版顶栏一直「已离线，重连中…」，房间页却还在；
 *   ② KP 点结团后，掉线的一方只离线，永远收不到「房间已结束」——
 *      不离开房间、不回写角色卡。
 * 根因：KP 结团/关房后中继只把房间行标 CLOSED（不踢人），此后任何一次
 *   掉线的 WS 升级都只拿到 HTTP 410 → 浏览器报 1006 → 传输层判「非致命」
 *   → 退避重连 → 再 410……无限循环，客户端永远学不到房间已没了。
 * 修法（v2.12.2，room-net.js）：掉线后重连前先用 probe 预检「房间还在吗」，
 *   确实没了（CLOSED / 404）→ 'ended' 终态 + onEnded 回调；还在或探不通
 *   → 按原行为退避重试（绝不能因一次网络抖动踢人出房）。
 *
 * 本测试覆盖：
 *   T1 KP act(session.end) 确实往线上发了 hub.broadcast(ended)
 *   T2 玩家侧收到该广播 → meta.ended + status=CLOSED（既有链路没坏）
 *   T3 掉线后 probe 说 CLOSED → 'ended' 终态、onEnded 触发、且不再重连
 *   T4 掉线后 probe 说房间还活着 → 照旧退避重连（不误踢）
 *   T5 probe 网络失败（fetch reject）→ 照旧重连（不误踢）
 *   T6 probe 404 not_found → 'ended' 终态
 * 用法：node tools/test_v2122_ended_loop.js
 * ============================================================ */
'use strict';

global.window = global;
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
eval(fs.readFileSync(path.join(root, 'web/js/core/room-model.js'), 'utf8'));
eval(fs.readFileSync(path.join(root, 'web/js/core/room-net.js'), 'utf8'));

const M = global.RoomModel;
const N = global.RoomNet;

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); return; }
  fail++;
  failures.push(label + (extra === undefined ? '' : '　→ 实际: ' + JSON.stringify(extra)));
  console.log('  ✗ ' + label + (extra === undefined ? '' : '　→ 实际: ' + JSON.stringify(extra)));
}
function section(n) { console.log('\n=== ' + n + ' ==='); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------------- 假 WebSocket ---------------- */
const socks = [];
class FakeWS {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWS.last = this;
    socks.push(this);
  }
  send(t) { this.sent.push(t); }
  close(code, reason) {
    this.readyState = 3;
    if (this.onclose) this.onclose({ code: code || 1000, reason: reason || '' });
  }
  fireOpen() { this.readyState = 1; if (this.onopen) this.onopen({}); }
  inject(obj) {
    if (this.onmessage) this.onmessage({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) });
  }
}
global.WebSocket = FakeWS;

/* ---------------- 环境：注入一个测试基址 ---------------- */
global.location = { search: '' };
global.ROOM_SERVER_BASE = 'http://relay.test';
global.Store = undefined;
global.BuildConfig = { roomBase: '' };

/* ---------------- fetch 桩 ----------------
   probeRoom 走 POST /api/rooms/<code>/probe；按 scenario 返回不同响应。 */
let fetchScenario = { kind: 'ok' };       // ok | closed | gone | netfail
let fetchLog = [];
global.fetch = function (url, opt) {
  fetchLog.push(String(url));
  var s = fetchScenario;
  if (s.kind === 'netfail') return Promise.reject(new TypeError('Failed to fetch'));
  var body;
  if (/\/probe$/.test(url)) {
    if (s.kind === 'closed') body = { ok: false, status: 'CLOSED', code: 'tst1', reason: 'room_closed' };
    else if (s.kind === 'gone') body = { ok: false, error: 'not_found' };
    else body = { ok: true, status: 'RECRUITING', code: 'tst1' };
  } else {
    body = { ok: true };
  }
  var status = (s.kind === 'gone' && /\/probe$/.test(url)) ? 404 : 200;
  return Promise.resolve({
    ok: status === 200,
    status: status,
    text: function () { return Promise.resolve(JSON.stringify(body)); }
  });
};

const noop = function () {};

function makeHostSide(code) {
  var host = new M.Host({
    meta: { code: code, name: '测试房', rules: 'coc7', kpName: 'KP',
            maxPlayers: 4, allowSpectate: true, status: M.STATUS.RECRUITING }
  });
  return new N.HostSide({
    host: host,
    room: { code: code, wsUrl: 'ws://relay.test/ws?code=' + code + '&t=htok', hostToken: 'htok' },
    onState: noop, onError: noop, onPeer: noop, onCounts: noop, onSave: noop
  });
}

function makePlayerSide(code, hooks) {
  var client = new M.Client({ seat: '', role: 'player' });
  return new N.PlayerSide(Object.assign({
    client: client,
    room: { code: code, wsUrl: 'ws://relay.test/ws?code=' + code + '&t=mtok', mtoken: 'mtok', role: 'player' },
    onState: noop, onEvent: noop, onError: noop
  }, hooks || {}));
}

(async function () {

/* ============================================================
 * T1 + T2：结团的线上广播与玩家终态（既有链路回归）
 * ============================================================ */
section('T1/T2 KP 结团 → 线上广播 → 玩家终态');
{
  var side = makeHostSide('tst1');
  side.open();
  FakeWS.last.fireOpen();
  side.act({ op: 'session.end' });
  var sent = FakeWS.last.sent.map(function (t) { try { return JSON.parse(t); } catch (e) { return {}; } });
  var bcs = sent.filter(function (m) { return m.k === 'hub.broadcast'; });
  ok(bcs.length >= 1, '结团发出了 hub.broadcast', sent);
  var evt = null;
  try { evt = JSON.parse(bcs[0].text); } catch (e) { /* ignore */ }
  ok(!!evt && evt.t === M.EVT.ENDED, '广播载荷是 ENDED 事件', evt && evt.t);

  var ps = makePlayerSide('tst1');
  ps._onText(bcs[0].text);
  ok(ps.client.state.meta.ended === true, '玩家侧状态 meta.ended=true');
  ok(ps.client.state.meta.status === M.STATUS.CLOSED, '玩家侧状态 status=CLOSED');
}

/* ============================================================
 * T3：掉线 + probe 说 CLOSED → ended 终态，不再重连（修复本体）
 * ============================================================ */
section('T3 掉线后预检发现房间已关 → ended 终态且不再重连');
{
  fetchScenario = { kind: 'closed' };
  var states = [], endedReason = null;
  var ps = makePlayerSide('tst1', {
    onState: function (s) { states.push(s); },
    onEnded: function (r) { endedReason = r; }
  });
  ps.open();
  FakeWS.last.fireOpen();
  ok(states.indexOf('online') >= 0, '先连上（online）');
  var before = socks.length;
  FakeWS.last.onclose({ code: 1006, reason: '' });     // 模拟 410 循环的那次掉线
  await sleep(80);                                       // 等预检 Promise 落地
  ok(states.indexOf('offline') >= 0, '先进入 offline（保留原行为）');
  ok(states.indexOf('ended') >= 0, '预检判定房间已关 → 进入 ended 终态', states);
  ok(endedReason === 'closed', 'onEnded 回调收到原因 closed', endedReason);
  await sleep(1400);                                     // 跨过最长首个退避窗口
  ok(socks.length === before, '没有发起任何新连接（死循环已断）', socks.length - before);
  ok(ps.link.ended === true, 'link.ended 标志已置位');
}

/* ============================================================
 * T4：probe 说房间还活着 → 照旧退避重连（不误踢）
 * ============================================================ */
section('T4 预检说房间还活着 → 照旧重连');
{
  fetchScenario = { kind: 'ok' };
  var states = [], endedFired = false;
  var ps = makePlayerSide('tst1', {
    onState: function (s) { states.push(s); },
    onEnded: function () { endedFired = true; }
  });
  ps.open();
  FakeWS.last.fireOpen();
  var before = socks.length;
  FakeWS.last.onclose({ code: 1006, reason: '' });
  await sleep(1400);
  ok(socks.length === before + 1, '发起了一次重连', socks.length - before);
  ok(states.indexOf('ended') < 0, '没有误入 ended 终态', states);
  ok(!endedFired, 'onEnded 未误触发');
  ok(ps.link.ended === false, 'link.ended 未置位');
}

/* ============================================================
 * T5：probe 网络失败 → 照旧重连（绝不能因抖动踢人）
 * ============================================================ */
section('T5 预检本身网络失败 → 照旧重连');
{
  fetchScenario = { kind: 'netfail' };
  var states = [], endedFired = false;
  var ps = makePlayerSide('tst1', {
    onState: function (s) { states.push(s); },
    onEnded: function () { endedFired = true; }
  });
  ps.open();
  FakeWS.last.fireOpen();
  var before = socks.length;
  FakeWS.last.onclose({ code: 1006, reason: '' });
  await sleep(1400);
  ok(socks.length === before + 1, '网络失败也重连（不误踢）', socks.length - before);
  ok(!endedFired, 'onEnded 未触发');
}

/* ============================================================
 * T6：probe 404 not_found（房间行被清理）→ ended 终态
 * ============================================================ */
section('T6 预检 404（房间记录没了）→ ended 终态');
{
  fetchScenario = { kind: 'gone' };
  var states = [], endedReason = null;
  var ps = makePlayerSide('tst1', {
    onState: function (s) { states.push(s); },
    onEnded: function (r) { endedReason = r; }
  });
  ps.open();
  FakeWS.last.fireOpen();
  var before = socks.length;
  FakeWS.last.onclose({ code: 1006, reason: '' });
  await sleep(120);
  ok(states.indexOf('ended') >= 0, '404 也进 ended 终态', states);
  ok(endedReason === 'gone', 'onEnded 原因 gone', endedReason);
  await sleep(1400);
  ok(socks.length === before, '同样不再重连');
}

/* ============================================================
 * T7：服务端主动关（1000/4000+）仍走原 closed 分支，不被预检改道
 * ============================================================ */
section('T7 服务端主动关闭（4001 takeover 等）行为不变');
{
  fetchScenario = { kind: 'ok' };
  var states = [];
  var ps = makePlayerSide('tst1', { onState: function (s) { states.push(s); } });
  ps.open();
  FakeWS.last.fireOpen();
  var before = socks.length;
  FakeWS.last.onclose({ code: 4001, reason: '已在别处重新连接' });
  await sleep(1400);
  ok(states.indexOf('closed') >= 0 && states.indexOf('ended') < 0,
     '4001 仍走 closed（fatal）分支，不进预检', states);
  ok(socks.length === before, '4001 不重连（与原行为一致）');
}

console.log('\n========================================');
console.log('RESULT: ' + (fail === 0 ? 'PASS' : 'FAIL') + '　(pass=' + pass + ' fail=' + fail + ')');
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }

})().catch(e => { console.error('测试执行异常:', e); process.exit(1); });
