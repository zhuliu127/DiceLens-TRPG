/* ============================================================
 * test_room_lan.js —— 局域网直连网页侧门面（RoomLan）单元测试
 *
 * 为什么值得单测：这一层看起来只是「调一下安卓桥」，但它决定了
 * **地址从哪来** —— 也就是「局域网还是公网」这个选择落到实处的唯一地方。
 * 出错的表现全都是「静默连错」：
 *   · 桥返回的地址没写进 ROOM_SERVER_BASE → 局域网开出来的房，
 *     成员却被引导去连公网地址，谁都进不去，且不报错
 *   · 浏览器里假装 available() === true → 用户点了「开房」才发现不行
 *     （需求 §2.3 明令禁止「看着能点、点了没反应」）
 *   · 离开房间不停服务 → 端口被自己占着，下次开房「启动失败」
 *   · 发现回调永远不来 → 界面一直转圈
 *
 * 用法：node tools/test_room_lan.js
 * 成功时最后一行打印 RESULT: PASS
 * ============================================================ */
'use strict';

global.window = global;
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
eval(fs.readFileSync(path.join(root, 'web/js/core/room-model.js'), 'utf8'));
eval(fs.readFileSync(path.join(root, 'web/js/core/room-net.js'), 'utf8'));
eval(fs.readFileSync(path.join(root, 'web/js/core/room-lan.js'), 'utf8'));

const N = global.RoomNet;
const L = global.RoomLan;

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(label + (extra === undefined ? '' : '　→ 实际: ' + JSON.stringify(extra)));
}
function eq(a, b, label) { ok(a === b, label, a); }
function section(n) { console.log('\n=== ' + n + ' ==='); }

/* 假的安卓桥：只有测试真正用到的几个方法 */
function fakeBridge(opts) {
  opts = opts || {};
  const calls = { start: 0, stop: 0, discover: 0, lastTimeout: null };
  return {
    calls,
    lanAvailable() { return opts.available !== false; },
    lanIp() { return opts.ip || '192.168.1.7'; },
    lanRunning() { return !!opts.running; },
    lanStart() {
      calls.start++;
      if (opts.startFail) return JSON.stringify({ ok: false, error: '端口被占用' });
      return JSON.stringify({
        ok: true, port: 4211, ip: opts.ip || '192.168.1.7',
        base: 'http://' + (opts.ip || '192.168.1.7') + ':4211'
      });
    },
    lanStop() { calls.stop++; },
    lanDiscover(ms) {
      calls.discover++;
      calls.lastTimeout = ms;
      if (opts.discoverSync) opts.discoverSync(global.__cocLanFound);
    }
  };
}

/* ---------------- 1. 没有外壳时如实回答「不可用」 ---------------- */
section('1. 浏览器环境：不假装能开房');
delete global.AndroidBridge;
eq(L.available(), false, '没有桥时 available() 为 false');
eq(L.isApp(), false, '没有桥时 isApp() 为 false');
eq(L.ip(), '', '没有桥时 ip() 返回空串');
eq(L.running(), false, '没有桥时 running() 为 false');
{
  const r = L.start();
  eq(r.ok, false, '没有桥时 start() 失败而不是抛异常');
  eq(r.error, 'NO_BRIDGE', 'start() 明确回报 NO_BRIDGE');
}

/* ---------------- 2. 有外壳：开房会把地址注入传输层 ---------------- */
section('2. 有外壳：start() 把地址注入 ROOM_SERVER_BASE');
global.AndroidBridge = fakeBridge({ ip: '10.0.0.5' });
eq(L.isApp(), true, '有桥时 isApp() 为 true');
eq(L.available(), true, '有桥且有局域网时 available() 为 true');
eq(L.ip(), '10.0.0.5', 'ip() 透传外壳给的地址');

global.ROOM_SERVER_BASE = '';
{
  const r = L.start();
  eq(r.ok, true, 'start() 成功');
  eq(r.base, 'http://10.0.0.5:4211', 'start() 回报 base');
  eq(global.ROOM_SERVER_BASE, 'http://10.0.0.5:4211',
     '★ 外壳的地址被写进 ROOM_SERVER_BASE（传输层立刻可用）');
  eq(N.base(), 'http://10.0.0.5:4211', '★ RoomNet.base() 随后就指向本机（端到端）');
  eq(N.isPrivateHost(), true, '该地址被判定为局域网地址');
  eq(N.wsBase(), 'ws://10.0.0.5:4211', 'ws 地址由同一份 base 推导，无分叉');
  eq(global.AndroidBridge.calls.start, 1, '确实调了一次外壳');
}

/* ---------------- 3. 启动失败要说清原因，不能污染地址 ---------------- */
section('3. start() 失败：不污染已有地址');
global.AndroidBridge = fakeBridge({ startFail: true });
global.ROOM_SERVER_BASE = 'http://old.example:1234';
{
  const r = L.start();
  eq(r.ok, false, '启动失败时 ok 为 false');
  eq(r.error, '端口被占用', '把外壳给的原因原样带出来（用户要知道为什么）');
  eq(global.ROOM_SERVER_BASE, 'http://old.example:1234',
     '★ 失败时不动已有地址（免得把好好的公网配置清掉）');
}

/* ---------------- 4. stop() 停服务并清地址 ---------------- */
section('4. stop()：停服务 + 清掉注入的地址');
global.AndroidBridge = fakeBridge({ ip: '10.0.0.5', running: true });
global.ROOM_SERVER_BASE = 'http://10.0.0.5:4211';
{
  L.stop();
  eq(global.AndroidBridge.calls.stop, 1, '确实调了外壳的 lanStop');
  eq(global.ROOM_SERVER_BASE, '',
     '★ 地址被清掉：否则界面还会显示「已连接」，其实服务器已经停了');
}
eq(L.running(), true, 'running() 透传外壳状态（这里外壳仍报 true）');

/* ---------------- 5 & 6. 发现 ---------------- */
(async function () {
  section('5. discover()：收广播结果');
  global.AndroidBridge = fakeBridge({
    discoverSync(fire) {
      fire([
        { svc: 'cocroom', port: 4211, code: 'ab12cd', name: '面具', kp: '老张',
          needPwd: false, players: 1, spectators: 0, maxPlayers: 4, status: 'RECRUITING',
          base: 'http://192.168.1.7:4211' }
      ]);
    }
  });
  const list = await L.discover(500);
  ok(list.length === 1, '★ 收到 1 个房间', list.length);
  const e = L.asRoomEntry(list[0]);
  eq(e.code, 'ab12cd', 'asRoomEntry 保留房间号');
  eq(e.name, '面具', 'asRoomEntry 保留房间名');
  eq(e.kpName, '老张', 'kp 字段名对齐目录接口（kpName）');
  eq(e.lanBase, 'http://192.168.1.7:4211', '★ 保留了加入时要用的服务地址');
  eq(e.lan, true, '标记为局域网来源');
  eq(e.maxPlayers, 4, 'maxPlayers 透传');
  eq(e.needPwd, false, 'needPwd 透传');
  eq(global.AndroidBridge.calls.lastTimeout, 500, '超时参数传给了外壳');

  section('6. discover()：外壳不回话时必须自己超时，不能一直转圈');
  global.AndroidBridge = fakeBridge({});     // 永远不回调
  const t0 = Date.now();
  const empty = await L.discover(120);
  ok(Array.isArray(empty) && empty.length === 0, '超时后返回空列表而不是挂住');
  ok(Date.now() - t0 < 3000, '在合理时间内返回（不会卡死界面）', Date.now() - t0);

  /* ---------------- 结果 ---------------- */
  console.log('\n' + '='.repeat(60));
  if (fail) {
    console.log('失败项：');
    failures.forEach(f => console.log('  [!!] ' + f));
    console.log('RESULT: FAIL  (' + pass + ' passed, ' + fail + ' failed)');
    process.exit(1);
  }
  console.log('全部通过：' + pass + ' 项断言');
  console.log('RESULT: PASS');
})();

