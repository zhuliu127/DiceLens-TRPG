/* ============================================================
 * room-lan.js — 局域网直连的网页侧门面
 * 对外命名：window.RoomLan
 *
 * 网页层做不了两件事，所以这两件事全部委托给安卓外壳（AndroidBridge）：
 *   · 监听端口跑房间服务   → lanStart() / lanStop()
 *   · 发 UDP 广播问「谁开着房」→ lanDiscover()
 *
 * 这个文件存在的意义，是把这两件「原生才知道的事」包装成网页层好用的形态：
 *
 *   1. 把外壳返回的 {ok, base, ip, port} 直接写进 window.ROOM_SERVER_BASE，
 *      于是 room-net.js 的 base() 立刻就能用 —— 传输层一行都不用改。
 *      这正是需求 §11.1「局域网与公网共用同一套」的落地方式：
 *      局域网不是「另一条链路」，只是「地址从哪来的问题」。
 *
 *   2. 在没有安卓外壳的环境（浏览器 / 桌面调试）里，如实回答
 *      available() === false，而不是假装能开房 —— 界面据此隐藏入口，
 *      比点了没反应要好（需求 §2.3）。
 *
 * ⚠️ 刻意不做的事：不在这里判断「要不要开服务」。那是流程问题，
 *    属于 room-ui.js。本文件只提供能力，不做决策。
 * ============================================================ */
(function (global) {
  'use strict';

  var N = global.RoomNet;

  /** 安卓外壳的桥对象；浏览器里为 undefined */
  function bridge() {
    var b = global.AndroidBridge;
    return (b && typeof b.lanStart === 'function') ? b : null;
  }

  /** 本环境能不能开局域网房（有外壳 + 有局域网地址） */
  function available() {
    var b = bridge();
    if (!b) return false;
    try { return b.lanAvailable() === true; } catch (e) { return false; }
  }

  /** 是不是跑在安卓外壳里（跟前一条不同：这里只问「有没有桥」） */
  function isApp() { return !!bridge(); }

  /** 本机局域网 IP（拿不到返回空串） */
  function ip() {
    var b = bridge();
    if (!b) return '';
    try { return String(b.lanIp() || ''); } catch (e) { return ''; }
  }

  /**
   * 开房：启动内嵌服务，并把地址注入给传输层。
   * 返回 {ok, base, ip, port} 或 {ok:false, error}。
   */
  function start() {
    var b = bridge();
    if (!b) return { ok: false, error: 'NO_BRIDGE' };
    var res;
    try {
      res = JSON.parse(b.lanStart() || '{}');
    } catch (e) {
      return { ok: false, error: 'BAD_REPLY' };
    }
    if (!res || res.ok !== true) {
      return { ok: false, error: (res && res.error) || '启动失败' };
    }
    /* 关键的一行：把地址交给传输层。
       它是全局的、临时的（不清 localStorage），因为「这台手机现在就是服务器」
       只在本次会话成立；下次重开要重新注入，否则会指向上次那个 IP。 */
    global.ROOM_SERVER_BASE = res.base || '';
    /* v1.18.4：把「有没有真正的 WiFi 地址」透出来。
       没连 WiFi 时外壳会把 base 退化成 http://127.0.0.1:4211 ——
       那间房只有自己能进，邀请链接对同伴是死路。
       界面必须据此在建房**之前**就提示，而不是等用户拿两台手机试半天。 */
    return {
      ok: true, base: res.base, ip: res.ip, port: res.port,
      wifi: res.wifi !== false
    };
  }

  /** 关房：停掉内嵌服务，并清掉注入的地址（免得界面还显示「已连接」） */
  function stop() {
    var b = bridge();
    if (b) { try { b.lanStop(); } catch (e) { /* 忽略 */ } }
    global.ROOM_SERVER_BASE = '';
    return true;
  }

  /**
   * 当前注入给传输层的地址（空串 = 没注入，也就是「不在局域网模式」）。
   *
   * 这个查询必须存在：注入的地址会**盖过**用户在设置里填的服务器地址，
   * 所以界面要能回答「我现在到底是本机在当服务器，还是用你填的那台」。
   * 光看 RoomLan.running() 不够 —— 桥可能说没跑、地址却还留着（上次异常退出）。
   */
  function injected() {
    var v = String(global.ROOM_SERVER_BASE || '');
    return /^https?:\/\//i.test(v) ? v : '';
  }

  function running() {
    var b = bridge();
    if (!b || typeof b.lanRunning !== 'function') return false;
    try { return b.lanRunning() === true; } catch (e) { return false; }
  }

  /**
   * 搜索同一网段里开着的房间（UDP 广播）。
   *
   * 超时要自己兜底：外壳那边虽然有 SoTimeout，但桥调用本身若因为权限被拒
   * 而静默失败，回调就永远不来 —— 那样界面会一直转圈。
   * 所以这里再套一层定时器，到点就以当前已发现的为准 resolve。
   */
  function discover(timeoutMs) {
    var b = bridge();
    var ms = timeoutMs || 1600;
    if (!b || typeof b.lanDiscover !== 'function') {
      return Promise.resolve([]);
    }
    return new Promise(function (resolve) {
      var done = false;
      function finish(list) {
        if (done) return;
        done = true;
        if (global.__cocLanFound) { try { delete global.__cocLanFound; } catch (e) { global.__cocLanFound = null; } }
        resolve(list || []);
      }
      global.__cocLanFound = function (list) { finish(list || []); };
      try {
        b.lanDiscover(ms);
      } catch (e) {
        finish([]);
        return;
      }
      // 兜底：比外壳窗口多留 600ms，正常情况走不到这里
      global.setTimeout(function () { finish([]); }, ms + 600);
    });
  }

  /** 把被发现的房间转成「房间目录」同一种形状，界面才能复用同一段渲染 */
  function asRoomEntry(found) {
    var f = found || {};
    return {
      code: f.code || '',
      name: f.name || '',
      kpName: f.kp || '',
      needPwd: !!f.needPwd,
      players: f.players || 0,
      spectators: f.spectators || 0,
      maxPlayers: f.maxPlayers || 4,
      status: f.status || 'RECRUITING',
      allowSpectate: true,
      /* 额外字段：局域网专有 —— 界面用它来拼「加入」时的服务地址 */
      lanBase: f.base || '',
      lan: true
    };
  }

  global.RoomLan = {
    available: available,
    isApp: isApp,
    ip: ip,
    start: start,
    stop: stop,
    injected: injected,
    running: running,
    discover: discover,
    asRoomEntry: asRoomEntry,
    DISCOVER_PORT: 4210
  };
})(typeof window !== 'undefined' ? window : this);
