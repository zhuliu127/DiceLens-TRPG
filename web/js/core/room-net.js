/* ============================================================
 * room-net.js — 跑团房间的传输层
 * 对外命名：window.RoomNet
 *
 * 三件事：
 *   ① 服务地址从哪来（局域网 / 公网），见 base()
 *   ② HTTP：房间目录、建房、加入预检、加入、关房
 *   ③ WebSocket：带自动重连、发送队列、断线补拉的连接；并把
 *      RoomModel.Host / RoomModel.Client 接到中继的两层协议上
 *
 * ── 局域网与公网为什么能共用一套 ─────────────────────────────
 *   两者对前端而言只是「一个 WS 地址 + 一个 HTTP 地址」的差别：
 *     局域网：地址 = KP 那台手机上内嵌服务自己的地址（邀请链接里带来）
 *     公网  ：地址 = 你自己服务器上的房间服务（设置里填 / 打包预置）
 *   协议完全相同（hub.* / peer.* + 应用层信封），所以本文件没有一处
 *   「如果是局域网就…」的分支 —— 一出现那种分支，两边就一定会分叉。
 *
 * ⚠️ 安卓 WebView 里不要再自己实现一套：外壳只需要把地址与 mtoken 传进来，
 *    传输层仍然是这一份（WebSocket 在 WebView 里是可用的）。
 * ============================================================ */
(function (global) {
  'use strict';

  var MODEL = (typeof global.RoomModel !== 'undefined') ? global.RoomModel : null;

  /* ============================================================
   * 服务地址解析
   * ============================================================ */

  function normalizeBase(u) {
    return String(u == null ? '' : u).trim().replace(/\/+$/, '');
  }

  /** 从当前页面地址里读邀请参数（加入方打开邀请链接时用） */
  function inviteParams() {
    if (!MODEL) return { code: '', serverBase: '' };
    try {
      return MODEL.readInvite(global.location && global.location.search);
    } catch (e) { return { code: '', serverBase: '' }; }
  }

  /** 邀请链接里带的地址 —— 加入方永远优先用它，
   *  因为它就是「刚才那个房间」所在的服务（局域网时是 KP 的手机地址） */
  function inviteBase() {
    var v = inviteParams().serverBase;
    return /^https?:\/\//i.test(v) ? normalizeBase(v) : '';
  }

  /** 由宿主环境注入的地址（安卓局域网外壳 / 内嵌页把它写在 window 上） */
  function injectedBase() {
    var v = global.ROOM_SERVER_BASE;
    return /^https?:\/\//i.test(String(v || '')) ? normalizeBase(v) : '';
  }

  /** 用户在「设置」里填的地址 */
  function userBase() {
    try {
      var st = global.Store && global.Store.getState && global.Store.getState().settings;
      return normalizeBase(st && st.roomBase);
    } catch (e) { return ''; }
  }

  /** 打包时预置的地址（开源版为空，自用版可预置自己的服务器） */
  function presetBase() {
    return normalizeBase(global.BuildConfig && global.BuildConfig.roomBase);
  }

  /**
   * 把一个来源的字符串切成候选地址列表。
   *
   * 为什么要支持多个：房间服务现在只有**一个**域名，而它挂在 Cloudflare 上、
   * 边缘节点在海外。国内手机走蜂窝时，这个域名完全可能连不上（跨境链路被限速 /
   * 被拦截 / DNS 被污染）。那时「服务是好的」毫无意义 —— 用户就是开不了房。
   * 允许填多个（逗号分隔），任一可达即可用，把「单点域名不通」降级成「慢一点」。
   *
   * 写法：`https://a.example/room,https://b.example/room`
   */
  function splitBases(v) {
    return String(v == null ? '' : v)
      .split(/[\s,;]+/)
      .map(normalizeBase)
      .filter(function (x) { return /^https?:\/\//i.test(x); });
  }

  /**
   * 当前生效的地址；空串表示「还没配置」，界面应引导用户去填写。
   * 顺序：邀请链接 > 宿主注入 > 用户设置 > 打包预置。
   */
  function base() {
    return baseList()[0] || '';
  }

  /**
   * **按优先级排好的全部候选地址**（去重）。
   * 邀请链接与宿主注入是「就这一个」的强指定 —— 它们一旦存在，
   * 说明「刚才那个房间就在这台服务器上」，不该再退到别的地址去，
   * 否则会连到一个不相干的服务器、报出莫名其妙的错。
   */
  function baseList() {
    var inv = inviteBase();
    if (inv) return [inv];
    var inj = injectedBase();
    if (inj) return [inj];
    var out = splitBases(userBase()).concat(splitBases(presetBase()));
    var seen = {};
    out = out.filter(function (x) {
      if (seen[x]) return false;
      seen[x] = 1;
      return true;
    });
    /* v2.11.8（局域网一体服）：什么都没配、且打包时开了 sameOriginRoom →
       用「当前网页所在的源」当中继（网页与中继同源，最常见就是局域网一体服：
       一台机器同源serve网页+中继）。仅在显式开 flag 时生效；
       公网/开源版（预置或自填了地址）永不走这条。 */
    if (!out.length && global.BuildConfig && global.BuildConfig.sameOriginRoom) {
      var o = global.location && global.location.origin;
      if (o && /^https?:\/\//i.test(o)) out = [normalizeBase(o)];
    }
    return out;
  }

  /**
   * 生效地址 + **它是从哪来的**。
   *
   * 界面必须知道来源，否则会掉进一个非常难查的坑：
   * 「用本机开房」会把局域网地址注入到 window.ROOM_SERVER_BASE，而注入的优先级
   * 高于用户在设置里填的地址 —— 于是用户在设置里填了公网地址、点「检测连通性」，
   * 实际测的却是局域网地址，报「连不上」。同一句「连不上」在两种模式下无法区分，
   * 用户和我们都没法判断是哪条链路断了。把来源写在卡片上，就不用猜了。
   *
   * source: 'invite' | 'injected' | 'user' | 'preset' | 'none'
   */
  function resolve() {
    var inv = inviteBase();
    if (inv) return { base: inv, source: 'invite' };
    var inj = injectedBase();
    if (inj) return { base: inj, source: 'injected' };
    var usr = userBase();
    if (usr) return { base: usr, source: 'user' };
    var pre = presetBase();
    if (pre) return { base: pre, source: 'preset' };
    /* v2.11.9（用户第 8 项）：同源回退也给出 source='origin'，界面据此显示
       「局域网（本机同源）」—— 局域网一体服上「创建房间」即在局域网中继开团。 */
    if (global.BuildConfig && global.BuildConfig.sameOriginRoom) {
      var so = global.location && global.location.origin;
      if (so && /^https?:\/\//i.test(so)) return { base: normalizeBase(so), source: 'origin' };
    }
    return { base: '', source: 'none' };
  }

  /** 候选地址个数（界面用来提示「配了 N 个备用地址」） */
  function baseCount() { return baseList().length; }

  /**
   * 最近一次成功请求实际用的基址（没成功过则回落到主地址）。
   * 用途只有一个：**让 WS 与 HTTP 走同一条路**（见 wsUrlFor）。
   */
  function activeBase() {
    var a = normalizeBase(lastOkBase);
    if (!a) return base();
    /* 只在它仍然是当前候选之一时才认 —— 用户可能刚改了地址，
       这时旧的成功记录必须作废，否则 WS 会连到一个已经不相关的服务器。 */
    var list = baseList();
    for (var i = 0; i < list.length; i++) if (list[i] === a) return a;
    return base();
  }

  /* ============================================================
   * 网络自检（界面「网络自检」按钮用）
   *
   * 为什么要有它：用户报的是「开房连不上」，而「连不上」至少有四种
   * 完全不同的成因（域名解析不了 / 服务没起 / 被墙或被限速 / 地址配错），
   * 我们在自己这边**无法复现**（服务器从桌面测是 200、CORS 正常）。
   * 与其让用户来回试，不如把判断放到他的手机上跑一遍，给出可截图的结论。
   *
   * 每一步都独立超时、独立成败，绝不因为上一步失败就跳过 ——
   * 「DNS 通但 /health 不通」和「DNS 都不通」的修法完全不同，必须分开看到。
   * ============================================================ */

  /** 单地址的连通性粗测：用 GET /health 打一发，把结果归类返回 */
  function pingBase(b, ms) {
    var t0 = Date.now();
    return reqOnce(b, 'GET', '/health', null, ms || 6000)
      .then(function (j) { return { base: b, ok: true, ms: Date.now() - t0, health: j }; },
            function (e) {
              var code = (e && e.code) || 'network';
              var msg = (e && e.message) || String(e);
              /* HTTP 层错误的消息来自服务端（如「Not Found」），未必带状态码。
                 而状态码恰恰是用户唯一能拿去搜的东西，所以补上。 */
              if (code === 'http' && e && e.status && msg.indexOf(String(e.status)) < 0) {
                msg += '（HTTP ' + e.status + '）';
              }
              return { base: b, ok: false, ms: Date.now() - t0, code: code, status: (e && e.status) || 0, message: msg };
            });
  }

  /** 探测浏览器能否解析该域名（WebView 里没有 dns API，用 fetch 时序近似） */
  function selfCheck() {
    var list = baseList();
    var res = { bases: list, source: resolve().source, steps: [], ok: false };
    if (!list.length) {
      res.steps.push({ name: '地址配置', ok: false, text: '还没有配置房间服务地址' });
      return Promise.resolve(res);
    }
    res.steps.push({ name: '地址配置', ok: true, text: list.join(' , ') });

    /* 逐个地址 ping。用串行而不是并发：候选地址本来就不多，
       并发时几个都超时会同时卡住 12 秒，用户以为卡死了。 */
    var first = null;
    function step(i) {
      if (i >= list.length) return Promise.resolve();
      return pingBase(list[i], 8000).then(function (r) {
        res.steps.push({
          name: '连通 ' + r.base,
          ok: r.ok,
          ms: r.ms,
          text: r.ok
            ? ('正常 · ' + r.ms + 'ms · ' + ((r.health && r.health.service) || 'coc-room'))
            : (r.message + '（' + r.ms + 'ms）'),
          code: r.code
        });
        if (r.ok && !first) first = r;
        return step(i + 1);
      });
    }

    return step(0).then(function () {
      res.ok = !!first;
      if (!first) return res;

      /* 再验一次「真的能建房吗」：/health 是只读探针，
         有些反代只放行 GET，POST 会被挡 —— 那正是「检测连通性正常、开房却失败」。 */
      var t0 = Date.now();
      return reqOnce(first.base, 'POST', '/api/rooms', {
        name: '自检房间', kpName: '自检', rules: 'coc7', maxPlayers: 1, allowSpectate: false,
        _selfcheck: true
      }, 15000).then(function (j) {
        var code = (j && j.code) || '';
        var tok = (j && j.hostToken) || '';
        res.steps.push({
          name: '建房能力', ok: true, ms: Date.now() - t0,
          text: '可以创建房间（试建 ' + code + '）'
        });
        /* ⚠️ 自检建出来的房间必须**当场、并且等它真的关掉**才能收工。
           早先这里是 fire-and-forget（.catch 吞掉不 await），结果是：
           只要调用方在自检返回后立刻退出（Node 探针的 process.exit、
           用户关掉弹层、App 切后台），关房请求就发不出去 ——
           房间永远留在目录里，玩家的「房间列表」被自检垃圾塞满。
           所以：await 它，并把关房成败如实写进结论。 */
        if (!code) { res.steps[res.steps.length - 1].text += '（服务端没回房间号，无法确认是否已清理）'; return res; }
        return closeRoom(code, tok).then(function () {
          res.steps[res.steps.length - 1].text += '，已立刻关闭';
          return res;
        }, function (e) {
          /* 关不掉要如实说，不能假装干净 —— 用户会看到多出来的房间。 */
          res.steps[res.steps.length - 1].text +=
            '，但未能关闭（' + ((e && e.message) || e) + '）';
          res.cleanupFailed = code;
          return res;
        });
      }, function (e) {
        res.steps.push({
          name: '建房能力', ok: false, ms: Date.now() - t0,
          text: '服务能连，但拒绝建房：' + ((e && e.message) || e) +
                (e && e.status ? '（HTTP ' + e.status + '）' : '')
        });
        return res;
      });
    });
  }

  function configured() { return !!base(); }

  function looksValid(u) {
    return /^https?:\/\/[^\s/]+/i.test(normalizeBase(u));
  }

  /** http(s) 地址 → ws(s) 地址 */
  function wsBase(b) {
    var v = normalizeBase(b || base());
    if (/^https:/i.test(v)) return v.replace(/^https:/i, 'wss:');
    if (/^http:/i.test(v)) return v.replace(/^http:/i, 'ws:');
    return v;
  }

  /**
   * 拼出 WebSocket 地址。
   *
   * ⚠️ 为什么**不能**用服务端回给我们的 `wsBase`（这条踩过一次大坑）：
   * 建房接口返回的 `wsBase` 是**服务端按自己配置的对外域名**写死的，例如
   * `wss://你的域名/room`。可那个域名挂在 Cloudflare 上、
   * 边缘节点在海外；而请求**实际**是从哪条路进去的，只有客户端知道。
   *
   * 于是会出现一种极其难查的错配：
   *   HTTP 走「国内源站直连 IP」进去（36ms、快、稳），
   *   服务端却让我们用「跨境域名」连 WS  →
   *   WS 那条路不通，界面一直「重连中」，用户看到的结论是「建不了房」。
   *
   * 正确做法：**HTTP 和 WS 必须走同一条路**。既然刚才那条 HTTP 已经把房间
   * 建出来了，说明它在当前网络下是通的 —— WS 就沿着同一条路回去，
   * 只把协议从 http→ws、https→wss，主机与端口照抄。
   *
   * @param {string} usedBase   刚才**实际成功**用的那个地址（不是服务端推荐的）
   * @param {object} res        服务端返回体（只在 usedBase 缺失时才退回它的 wsBase）
   */
  /**
   * v2.0.2 T1：本机设备标识（惰性取）。DeviceId 模块缺失 / 取不到 → 返回 ''，
   * 调用方据此**不追加参数**，保持与 v2.0.1 完全一致的行为（老客户端/降级不退化）。
   */
  function deviceId() {
    try {
      if (global.DeviceId && typeof global.DeviceId.get === 'function') {
        return String(global.DeviceId.get() || '');
      }
    } catch (e) { /* 忽略：设备码是增强，取不到不影响连接 */ }
    return '';
  }

  function wsUrlFor(usedBase, code, token, res) {
    var b = normalizeBase(usedBase);
    if (!b && res && res.wsBase) b = normalizeBase(res.wsBase);
    if (!b) return '';
    var q = '/ws?code=' + encodeURIComponent(code || '') +
            (token ? '&t=' + encodeURIComponent(token) : '');
    /* v2.0.2 T1：带上设备标识 d=<deviceId>（服务端据此做「设备即身份」的断线回座）。
       无 DeviceId 模块时 d 为空 → 不追加，保持既有 WS URL 形状不变（test_room_net 兼容）。 */
    var d = deviceId();
    if (d) q += '&d=' + encodeURIComponent(d);
    /* 服务端给的 wsBase 末尾可能已经带了路径（/room），直接接 /ws 即可 */
    return wsBase(b) + q;
  }

  /** 局域网地址是否只在本网段可见（界面用来提示「同一 WiFi 才能连」） */
  function isPrivateHost(b) {
    var v = normalizeBase(b || base());
    var m = /^https?:\/\/([^/:]+)/i.exec(v);
    if (!m) return false;
    var h = m[1].toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1') return true;
    if (/^10\./.test(h) || /^192\.168\./.test(h)) return true;
    var c = /^172\.(\d+)\./.exec(h);
    if (c && Number(c[1]) >= 16 && Number(c[1]) <= 31) return true;
    return false;
  }

  /** 把 http://192.168.x.y:4211 里的主机换掉，端口与协议保持 —— 换回环自测要用 */
  function swapHost(b, host) {
    return normalizeBase(b).replace(/^(https?:\/\/)[^/:]+/i, '$1' + host);
  }

  /* ============================================================
   * 局域网自检（界面「局域网自检」按钮用）
   *
   * 为什么单独的、跟 selfCheck 分开的一套：
   * selfCheck 是给**公网域名**用的（比 /health、比建房），而局域网的问题
   * 永远是这三个之一，且它们的修法互不相同：
   *
   *   ① 本机服务根本没起来（点「用本机开房」时 lanStart 就失败了）
   *   ② 服务起来了，但**明文流量被安卓系统拦了**
   *      —— 页面跑在 https://appassets… 虚拟源下，fetch http://192.168.x.x
   *         属混合内容 + 明文，会被 network security config 掐断。
   *         这时 fetch 抛 TypeError，JS 层**无法**与「网络不通」区分。
   *   ③ 服务在本机是好的，但同伴（或本机）连不上这个 IP
   *      —— 不在同一 WiFi / 路由器 AP 隔离。
   *
   * 区分办法是**改探回环**：
   *   · 127.0.0.1 通、局域网 IP 不通 → 服务是活的，问题在②或③的网络路径
   *   · 两个都不通                    → 服务很可能压根没起来（①）
   *   · 两个都通                      → 房主自测没问题，让同伴去试③
   *
   * ⚠️ 回环这一探有一个已知局限：部分安卓 ROM 会把 127.0.0.1 的明文请求
   *    也按同一套策略拦掉。所以「回环也不通」**不能**直接断定服务没起来，
   *    文案里必须保留这个歧义 —— 给用户一个「看着像确诊、其实可能误诊」的
   *    结论，比不给结论更糟（需求 §2.3：不做假承诺）。
   * ============================================================ */

  /**
   * 「混合内容被拦」哨兵：判断这一次局域网探测失败是不是**明文被 WebView 拦掉**。
   *
   * 为什么需要它：页面跑在 https 虚拟源（appassets）下，向 http://192.168.x.x
   * 发请求属「混合内容 + 明文」。若安装包还没放开明文，WebView 会在**本地瞬间**
   * 把请求掐断（fetch 抛 TypeError → code='network'），耗时通常只有几毫秒；
   * 这与「VPN 劫持 / 不在同一 WiFi / 路由器 AP 隔离」在网络层失败**长得一模一样**，
   * 从 JS 侧无法直接区分。这里用三个可判定的特征做**回归哨兵**：
   *   · 页面来源是 https:（才有混合内容限制）
   *   · 目标是 http: 的局域网地址（回环除外 —— 127.0.0.1/localhost 被视为可信来源，
   *     不受混合内容限制，所以它们能通、局域网 IP 不能通，恰好是这一类的指纹）
   *   · 第一次探测**瞬时失败**（code==='network' 且 ms<150）
   *
   * 一旦命中，就能给用户一句确定的话（升级安装包），而不是「三种可能」的模糊结论。
   *
   * @param {string} b - 被探测的局域网基址
   * @param {Object} r - pingBase 的返回（第一次探测）
   * @returns {boolean}
   */
  function isMixedContentBlocked(b, r) {
    var pageHttps = false;
    try { pageHttps = String((global.location && global.location.protocol) || '') === 'https:'; }
    catch (e) { pageHttps = false; }
    if (!pageHttps) return false;
    if (!/^http:\/\//i.test(normalizeBase(b))) return false;   // 目标必须是明文 http
    if (!isPrivateHost(b)) return false;                        // 且是局域网/本机地址
    var m = /^http:\/\/([^/:]+)/i.exec(normalizeBase(b));
    var h = m ? m[1].toLowerCase() : '';
    if (h === 'localhost' || h === '127.0.0.1') return false;   // 回环不受混合内容限制
    if (!r || r.ok) return false;
    if (r.code !== 'network') return false;
    if (typeof r.ms === 'number' && r.ms >= 150) return false;  // 只认「瞬时」失败
    return true;
  }

  /**
   * 局域网三选一诊断。返回 {ok, steps, verdict, hint} 形状与 selfCheck 一致，
   * 界面可以复用同一段渲染。
   *
   * @param {string} lanBase 房主本站的局域网地址（RoomLan.start() 回的那个 base）
   */
  function lanDiagnose(lanBase) {
    var b = normalizeBase(lanBase || injectedBase() || '');
    var res = { bases: b ? [b] : [], source: 'injected', steps: [], ok: false, lan: true };
    if (!b) {
      res.steps.push({ name: '局域网地址', ok: false, text: '本机还没启动局域网服务（先点「用本机开房」）' });
      res.verdict = 'lan-down';
      return Promise.resolve(res);
    }

    res.steps.push({ name: '局域网地址', ok: true, text: b });

    var loop = /^https:/i.test(b) ? swapHost(b, '127.0.0.1') : swapHost(b, '127.0.0.1');

    /* 两探串行：先打局域网 IP（这是同伴真正要用的地址），再打回环。
       串行而不是并发，是为了让「第一个就失败」能尽快给出第二步的对照。 */
    return pingBase(b, 5000).then(function (r) {
      res.steps.push({
        name: '本机局域网地址 ' + b, ok: r.ok, ms: r.ms, code: r.code,
        text: r.ok
          ? ('正常 · ' + r.ms + 'ms · ' + ((r.health && r.health.service) || 'coc-room'))
          : (r.message + '（' + r.ms + 'ms）')
      });
      res.lanOk = r.ok;
      /* 混合内容哨兵：命中则给确定结论（见 isMixedContentBlocked 注释） */
      res.mixedBlocked = isMixedContentBlocked(b, r);

      return pingBase(loop, 5000).then(function (r2) {
        res.steps.push({
          name: '回环地址 ' + loop, ok: r2.ok, ms: r2.ms, code: r2.code,
          text: r2.ok
            ? ('正常 · ' + r2.ms + 'ms · ' + ((r2.health && r2.health.service) || 'coc-room'))
            : (r2.message + '（' + r2.ms + 'ms）')
        });
        res.loopOk = r2.ok;

        /* 判读：这是本功能的核心价值 —— 把「连不上」拆成几个可行动的原因 */
        if (r.ok) {
          res.ok = true;
          res.verdict = 'lan-ok';
        } else if (res.mixedBlocked) {
          /* 页面 https、目标 http 局域网、且瞬时失败 —— 明文被 WebView 拦。
             优先于 lan-blocked：回环能通正是它的指纹，不能被误判成「VPN 劫持」。 */
          res.verdict = 'lan-mixed-blocked';
        } else if (r2.ok) {
          res.verdict = 'lan-blocked';   // 服务活着，但这个 IP 走不通
        } else if (r.code === 'timeout' || r2.code === 'timeout') {
          res.verdict = 'lan-timeout';
        } else {
          res.verdict = 'lan-dead';      // 两探全废：服务没起 or 明文被系统拦
        }
        return res;
      });
    });
  }

  /* ============================================================
   * HTTP
   * ============================================================ */

  /**
   * 一次请求，**会依次尝试全部候选地址**（见 baseList）。
   *
   * 规则：
   *   · 「服务答了但拒绝」（HTTP 4xx/5xx）→ **立刻返回**，不再换地址。
   *     服务是活的，换机器也没用，而且会把「密码错」这类真错误掩盖成「连不上」。
   *   · 网络层失败（超时 / fetch 抛错）→ 换下一个候选地址。
   *     这就是多地址的意义：主域名在这个网络下不通时自动走备用。
   *   · `retries` 只在**幂等**的 GET 上用 —— POST /api/rooms 是建房，
   *     自动重试会建出两个房间，绝不能重试。（换地址也不算重试：
   *     那台服务器上并没有建成房，副作用只发生在**成功**的那一次。）
   *
   * ⚠️ 重试是**跨整份候选列表**做的，不是每个地址各试 `retries+1` 次。
   *    每地址重试会让「配了两个地址、第一个不通」变成 4 次请求、耗时翻倍，
   *    而备用的意义恰恰是「主地址不可用」—— 死地址上再来一次毫无价值。
   *    只在**所有**地址都失败后才整轮重来一次。
   *
   * ⚠️ 超时给得比以前宽（见 DEFAULT_TIMEOUTS）：手机走蜂窝、又要跨境连
   * Cloudflare 时，首包 >5 秒是常事。以前 health 卡 5 秒，用户看到的就是
   * 「连接超时（5 秒内没有响应）」—— 而那往往只是**第一次握手慢**，
   * 不是服务不在。宁可多等几秒，也不要误报「连不上」。
   */
  var DEFAULT_TIMEOUTS = { health: 12000, get: 12000, post: 20000 };

  /* 最近一次**成功**请求用的是哪个基址。
     这是给「HTTP 与 WS 必须走同一条路」用的：候选地址可能主备切换
     （比如国内直连 IP 被挡、自动回退到域名），那么 WS 也必须跟着走那条
     成功的路。只靠 N.base() 会拿到「永远是主地址」，于是在备用上建好的房
     却用死掉的主地址去连 WS —— 表现就是「房建出来了、但一直重连中」。
     见 wsUrlFor()。 */
  var lastOkBase = '';

  function req(method, path, body, timeoutMs, retries) {
    var ms = timeoutMs || (body ? DEFAULT_TIMEOUTS.post : DEFAULT_TIMEOUTS.get);
    var list = baseList();
    if (!list.length) return Promise.reject(new Error('UNCONFIGURED'));

    /* 一轮 = 把候选地址从主到备走一遍 */
    function round(left) {
      function attempt(i) {
        return reqOnce(list[i], method, path, body, ms)
          .then(function (j) {
            lastOkBase = list[i];      // 记住赢家，WS 要沿同一条路回去
            return j;
          }, function (e) {
            /* 服务端明确回应过 → 这就是最终答案，别换地址。
               注意：**服务端答了**也算这条地址是活的（能问出话来），
               所以同样记成 winner —— 否则「密码错」之后 WS 会连到别的地址上。 */
            if (e && e.status) {
              lastOkBase = list[i];
              throw e;
            }
            if (i + 1 < list.length) return attempt(i + 1);
            /* 这一轮的地址都用完了。重试整轮**只在失败看起来是偶发的时候**做：
               · e.code === 'timeout' → 我们已经把预算等满了（12 秒）。
                 再来一轮就是让用户再干等 12 秒，而结果极可能一样 ——
                 正是这个「等两轮」把手机上的等待拉到 ~24 秒，太长了。
               · e.code === 'network' → 立刻失败，通常是 DNS 冷启动 / 刚切网 /
                 TLS 首连没起来。这种「秒失败」重来一次命中率很高，且几乎没有等待成本。
               所以：秒失败 → 值得重试；等满超时 → 不重试。 */
            if (left > 0 && (!e || e.code !== 'timeout')) {
              return new Promise(function (resolve) {
                global.setTimeout(function () { resolve(round(left - 1)); }, 400);
              });
            }
            /* 全部候选 + 全部重试都用光了。
               把「试过哪些地址」和「先查哪个」带上 —— 只报「连不上」，
               用户说不清是哪个域名的锅，我们也没法定位。 */
            if (e) {
              e.triedAll = list.slice();
              /* base 归位到**主地址**：那是用户最先该去查、也最可能是配置错的那个。
                 留着最后一次的备用地址，会把注意力引到错的地方。 */
              if (!e.primaryBase) e.primaryBase = list[0];
              e.base = list[0];
            }
            throw e;
          });
      }
      return attempt(0);
    }
    return round(retries || 0);
  }

  function reqOnce(b, method, path, body, ms) {
    var opt = { method: method, headers: {} };
    if (body !== undefined && body !== null) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    /* 房间服务是公网上的裸端点，可能没人应答 —— 必须自己设超时，
       否则界面会一直转圈（fetch 默认没有超时）。 */
    var ctl = null;
    if (global.AbortController) {
      ctl = new global.AbortController();
      opt.signal = ctl.signal;
    }
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms);

    return global.fetch(b + path, opt).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = JSON.parse(t); } catch (e) { /* 非 JSON */ }
        if (!r.ok) {
          var msg = (j && (j.message || j.error)) || ('服务器返回 ' + r.status);
          var err = new Error(msg);
          err.status = r.status;
          err.reason = j && j.reason;
          err.body = j;
          err.base = b;          // 让界面能说出「是哪个地址返回的 403」
          err.code = 'http';
          throw err;
        }
        return j;
      });
    }).then(function (j) {
      clearTimeout(timer);
      return j;
    }, function (e) {
      clearTimeout(timer);
      /* HTTP 层错误原样往上抛（带 status / reason，界面要按它分支）。
         HTTP 错误是「服务答了但拒绝」，重试没有意义 —— 除了 5xx（服务端临时故障）。 */
      if (e && e.status) throw e;

      /* 网络层错误必须分类 + 带上试的是哪个地址。
         浏览器对这两类的 Error.message 分别是 "Failed to fetch" 与空串，
         直接透给用户就是「连不上 failed to fetch」——既看不懂、也定位不了。
         重试/换地址的编排在 req() 里，这里只负责把这一次失败说清楚。

         ⚠️ 文案必须**按地址类型分开写**（这条踩过坑）：
         局域网地址是形如 http://192.168.x.y:4211 的**裸 IP**，
         根本不存在可解析的域名。旧文案不分青红皂白地说
         「域名解析失败 / 不在同一网络 / 服务未启动」，把用户直接引向
         「去查 DNS」这条错误路径，而真正的原因是「不在同一 WiFi」或
         「明文流量被系统拦了」。三选一的模糊提示等于没提示。 */
      var err;
      if (e && e.name === 'AbortError') {
        err = new Error('连接超时（' + (ms / 1000) + ' 秒内没有响应）');
        err.code = 'timeout';
      } else if (isPrivateHost(b)) {
        err = new Error('连不上这台局域网服务器（不在同一 WiFi / 路由器开了 AP 隔离 / 本机服务没起来）');
        err.code = 'network';
        err.lan = true;
      } else {
        err = new Error('无法连接（域名解析失败 / 服务未启动）');
        err.code = 'network';
      }
      err.base = b;
      err.cause = String((e && e.message) || e || '');
      throw err;
    });
  }

  /* GET 是幂等的 → 允许静默重试 1 次（首连握手失败很常见，重来一次往往就好了）。
     POST 一律不重试：建房/加入/关房重试会产生副作用。 */
  function health() { return req('GET', '/health', null, DEFAULT_TIMEOUTS.health, 1); }
  function list() { return req('GET', '/api/rooms', null, DEFAULT_TIMEOUTS.get, 1); }
  /* v2.1.1：预检也带上 deviceId —— 服务端据此回 joinKind（'reconnect'|'new'），
     界面在点「加入」之前就能提示「正在重连…」/「加入中…」。 */
  function probe(code, role) {
    var body = { role: role || 'player' };
    var d = deviceId();
    if (d) body.deviceId = d;
    return req('POST', '/api/rooms/' + code + '/probe', body);
  }

  /* v2.12.2：掉线重连前的「房间还在吗」预检（见 connect#onclose 长注释）。
     只有在服务端**明确**说房间没了时才判 alive:false：
       · probe 200 但 ok:false 且 status=CLOSED（KP 结团 / 关房）
       · 404 not_found（房间行被清理 / 从来没存在过）
       · 410（个别老服务端在升级位拒绝关房请求时的同义信号）
     网络不通 / 超时 → alive:null（未知）；挂起(SUSPENDED 可续玩) / 满员 /
     要密码 → alive:true。后两种都**不能**把人踢出房间，继续退避重连。 */
  function probeAlive(code) {
    return probe(code, 'player').then(function (j) {
      if (j && j.ok === true) return { alive: true };
      if (j && String(j.status || '') === 'CLOSED') return { alive: false, reason: 'closed' };
      return { alive: true };
    }, function (e) {
      var st = e && e.status;
      var body = e && e.body;
      if (st === 404 || (body && body.error === 'not_found')) return { alive: false, reason: 'gone' };
      if (st === 410) return { alive: false, reason: 'closed' };
      return { alive: null };        // 网络层失败：未知 → 继续重连
    });
  }
  function create(opts) { return req('POST', '/api/rooms', opts || {}); }
  /* v2.0.2 T1：加入房间时带上 deviceId（服务端做设备↔seat 绑定，供断线回座）。
     调用方显式传了 deviceId 则不覆盖；无 DeviceId 模块时不加（保持既有 body 形状）。
     v2.1.1（用户第三轮反馈）：服务端按机器码判定这次是「重连」还是「新加入」，
     结果放在 joinKind —— 界面据此提示「正在重连…」/「加入中…」。老服务端无该字段时
     兜底为 'new'，保证界面永远拿到确定值。**两种情况都会返回 ok=true**（都能进）。 */
  function join(code, opts) {
    var body = Object.assign({}, opts || {});
    if (!body.deviceId) {
      var d = deviceId();
      if (d) body.deviceId = d;
    }
    return req('POST', '/api/rooms/' + code + '/join', body).then(function (res) {
      if (res && typeof res === 'object' && !res.joinKind) res.joinKind = 'new';
      return res;
    });
  }
  function closeRoom(code, hostToken) {
    return req('POST', '/api/rooms/' + code + '/close', { hostToken: hostToken });
  }

  /* ---- v2.0.0：存档 / 挂起 / 复活（契约 §2.1）----
     payload 是**不透明字符串**，服务端不解析（与中继层约定一致）。 */

  /** 推全量存档到服务器。seq 单调递增，服务端只在 seq > 已存 seq 时覆盖。 */
  function saveState(code, hostToken, seq, payload) {
    return req('POST', '/api/rooms/' + code + '/state',
      { hostToken: hostToken, seq: seq, payload: payload });
  }

  /** 从服务器拉存档。token 是 hostToken 或任一有效成员 mtoken。
      无存档 → 404 {ok:false,error:'no_state'}（调用方要优雅降级）。

      `retries` 可显式指定（默认 1，与旧行为一致）：
      前台主动「续玩」值得重试；但**后台重连时的补拉要传 0** ——
      那种补拉是尽力而为、失败就等房主重推，若带 400ms 延后重试，
      会把一次已经结束的拉取拖到之后，污染后续的网络调用时序。 */
  function getState(code, token, retries) {
    var n = (retries === undefined) ? 1 : retries;
    var qs = '?token=' + encodeURIComponent(token || '');
    /* v2.0.2 T4：带上设备标识 d=<deviceId>。进程重启后 mtoken 失效时，服务端可据此
       走「设备码通道」放行拉存档。无 DeviceId 模块时不追加（保持既有 URL 形状）。 */
    var d = deviceId();
    if (d) qs += '&d=' + encodeURIComponent(d);
    return req('GET', '/api/rooms/' + code + '/state' + qs, null, DEFAULT_TIMEOUTS.get, n);
  }

  /** 挂起房间（存档保留 30 天，可续玩） */
  function suspendRoom(code, hostToken) {
    return req('POST', '/api/rooms/' + code + '/suspend', { hostToken: hostToken });
  }

  /** 复活挂起房间，服务端回传已存 seq 与 payload */
  function resumeRoom(code, hostToken) {
    return req('POST', '/api/rooms/' + code + '/resume', { hostToken: hostToken });
  }

  /* ---- v2.0.2 T4：解绑本机设备身份（只解绑自己）----
     凭据 = 本机 deviceId；服务端只删 (房间, 该 deviceId) 那一行。 */
  function unbind(code, dev) {
    var d = dev || deviceId();
    return req('POST', '/api/rooms/' + code + '/unbind', { deviceId: d || '' });
  }

  /* ---- v2.0.2 T5：可命名存档槽（/saves*）---- */

  /** 用当前状态快照建一个命名存档槽。需 hostToken。 */
  function createSave(code, hostToken, name) {
    return req('POST', '/api/rooms/' + code + '/saves',
               { hostToken: hostToken, name: name || '' });
  }

  /** 列出存档槽。需 hostToken。 */
  function listSaves(code, hostToken) {
    return req('GET', '/api/rooms/' + code + '/saves?token=' +
               encodeURIComponent(hostToken || ''), null, DEFAULT_TIMEOUTS.get, 1);
  }

  /** 读取某存档槽。token 需是 hostToken（或本机 deviceId 命中绑定）。 */
  function getSave(code, hostToken, saveId) {
    var qs = '?token=' + encodeURIComponent(hostToken || '');
    var d = deviceId();
    if (d) qs += '&d=' + encodeURIComponent(d);
    return req('GET', '/api/rooms/' + code + '/saves/' + encodeURIComponent(saveId) + qs,
               null, DEFAULT_TIMEOUTS.get, 1);
  }

  /** 载入某存档槽（服务端把 room_state 置为该存档并把房间置 RECRUITING）。需 hostToken。 */
  function loadSave(code, hostToken, saveId) {
    return req('POST', '/api/rooms/' + code + '/saves/' + encodeURIComponent(saveId) + '/load',
               { hostToken: hostToken });
  }

  /** 删除某存档槽。需 hostToken。 */
  function deleteSave(code, hostToken, saveId) {
    return req('DELETE', '/api/rooms/' + code + '/saves/' + encodeURIComponent(saveId),
               { hostToken: hostToken });
  }

  /* ============================================================
   * WebSocket 连接（自动重连 + 发送队列）
   * ============================================================ */

  var RECONNECT_DELAYS = [800, 1600, 3000, 5000, 8000, 12000];

  /**
   * @param url    ws:// 或 wss:// 完整地址
   * @param hooks  {onOpen, onText, onState, onFatal}
   *               onState(state, info)：connecting / online / offline / closed
   */
  function connect(url, hooks) {
    hooks = hooks || {};
    var link = {
      url: url,
      state: 'connecting',
      sock: null,
      queue: [],
      tries: 0,
      manual: false,
      lastError: '',
      sent: 0,
      recv: 0,
      /* v2.4.0（用户第 ③ 项）：连接代号 —— 每次 open() +1；socket 的事件回调
         里先比对代号，**陈旧连接的迟到事件一律忽略**。根因：服务端 takeover
         踢掉旧连接时发的 4001「已在别处重新连接」，其 onclose 常**晚于**新连接
         建立到达；旧实现无条件执行 `link.sock = null` + `setState('closed',
         {fatal:true})`，把刚建好的新连接误杀、并误报「连接已断开」——
         用户实测「锁屏再开屏后重连失败，只能后退重进」正是这条竞态。 */
      connSeq: 0,
      /* v2.12.2：预检确认房间已没了 → 终态。置位后一切重连/换线都不再动作，
         否则待发的退避定时器会又把连接拉起来（410 循环就是这么来的）。 */
      ended: false,
      retryTimer: null
    };

    function setState(s, info) {
      if (link.state === s && !info) return;
      link.state = s;
      if (hooks.onState) hooks.onState(s, info || {});
    }

    function open() {
      if (link.manual) return;
      setState('connecting');
      var sock;
      try {
        sock = new global.WebSocket(url);
      } catch (e) {
        link.lastError = String(e && e.message || e);
        scheduleRetry();
        return;
      }
      var myConn = ++link.connSeq;   // v2.4.0（用户第 ③ 项）：本连接的代号
      link.sock = sock;

      sock.onopen = function () {
        /* v2.4.0（用户第 ③ 项）：陈旧 socket 迟到打开 → 静默退场，不抢状态 */
        if (myConn !== link.connSeq) {
          try { sock.close(1000, 'stale'); } catch (e) { /* 忽略 */ }
          return;
        }
        link.tries = 0;
        setState('online');
        // 断线期间攒下的消息按原顺序补发
        var q = link.queue.splice(0, link.queue.length);
        for (var i = 0; i < q.length; i++) rawSend(q[i]);
        if (hooks.onOpen) hooks.onOpen();
      };

      sock.onmessage = function (ev) {
        link.recv += 1;
        var text = typeof ev.data === 'string' ? ev.data : '';
        if (!text) return;
        if (hooks.onText) hooks.onText(text);
      };

      sock.onerror = function () {
        // onerror 之后一定会跟一个 onclose，重连逻辑放在 onclose 里，避免重连两次
      };

      sock.onclose = function (ev) {
        /* v2.4.0（用户第 ③ 项）：陈旧连接的迟到 close（尤其是 takeover 的
           4001「已在别处重新连接」）→ 直接忽略。绝不能拿它清 link.sock /
           改状态 —— 那会误杀刚建好的新连接并误报「连接已断开」。 */
        if (myConn !== link.connSeq) return;
        link.sock = null;
        if (link.manual) { setState('closed'); return; }
        var reason = (ev && ev.reason) || '';
        /* 服务端主动关（1000 正常 / 4000+ 业务原因）不该无限重连：
           例如「凭据过期」「已被移出房间」，重连一百次也还是被拒。
           这里把它们当成终止条件，交给上层决定要不要重新加入。 */
        if (ev && (ev.code === 1000 || ev.code >= 4000)) {
          setState('closed', { code: ev.code, reason: reason, fatal: true });
          if (hooks.onFatal) hooks.onFatal(reason, ev.code);
          return;
        }
        setState('offline', { code: ev && ev.code, reason: reason });
        /* v2.12.2（用户实测的两个 bug，一起修）：
           ① 顶栏一直「已离线，重连中…」但房间页还在；
           ② KP 结团后，掉线的一方只离线、永远收不到「房间已结束」，
              不会离开房间、不会回写角色卡。
           根因：KP 结团/关房后，中继只把房间行标 CLOSED、**不踢人**。
           此时任何一次掉线后的 WS 升级都只会拿到 HTTP 410 —— 浏览器对
           失败的升级统一报 1006，上面判「非致命」→ 退避重连 → 再 410
           → 无限循环。客户端从这条路上永远学不到「房间已经没了」。
           修法：重连之前先用 probe 问一句「房间还在吗」—— 确实没了
           （CLOSED / 行被清理）→ 进 'ended' 终态交给上层收尾；还在或
           探不通 → 按原行为退避重试（绝不能因一次网络抖动就踢人出房）。 */
        if (hooks.checkAlive) {
          Promise.resolve().then(function () { return hooks.checkAlive(); })
            .then(function (r) {
              if (r && r.alive === false) {
                link.ended = true;
                if (link.retryTimer) { clearTimeout(link.retryTimer); link.retryTimer = null; }
                setState('ended', { reason: r.reason || '房间已结束' });
                if (hooks.onEnded) hooks.onEnded(r.reason || '房间已结束');
                return;
              }
              scheduleRetry();
            }, function () { scheduleRetry(); });
          return;
        }
        scheduleRetry();
      };
    }

    function scheduleRetry() {
      if (link.manual || link.ended) return;
      var d = RECONNECT_DELAYS[Math.min(link.tries, RECONNECT_DELAYS.length - 1)];
      link.tries += 1;
      // 抖动：一堆人同时掉线时不要在同一毫秒一起回来
      var jitter = Math.floor(Math.random() * 200);
      link.retryTimer = setTimeout(function () {
        link.retryTimer = null;
        if (!link.manual && !link.ended && link.state !== 'online') open();
      }, d + jitter);
    }

    function rawSend(text) {
      if (!link.sock || link.sock.readyState !== 1) return false;
      try {
        link.sock.send(text);
        link.sent += 1;
        return true;
      } catch (e) {
        link.lastError = String(e && e.message || e);
        return false;
      }
    }

    /** 发一条：没连上就先排队（上限 200 条，超出丢最老的） */
    link.send = function (text) {
      if (rawSend(text)) return true;
      link.queue.push(text);
      if (link.queue.length > 200) link.queue.shift();
      return false;
    };

    link.sendObj = function (obj) { return link.send(JSON.stringify(obj)); };

    link.close = function () {
      link.manual = true;
      link.queue.length = 0;
      if (link.sock) {
        try { link.sock.close(1000, 'bye'); } catch (e) { /* 忽略 */ }
      }
      link.sock = null;
      setState('closed');
    };

    /**
     * v2.0.2 T4：立刻重连一次（不等退避定时器）。
     * 用途：App 从后台回到前台（visibilitychange）时，若连接已断，用户不希望
     * 再等 3~12 秒的退避 —— 网络很可能已经恢复了，直接试一把。
     * 只在「已断开（offline/closed）」时动作，避免与正在进行的连接重复。
     */
    link.retryNow = function () {
      if (link.manual || link.ended) return;
      if (link.state === 'online' || link.state === 'connecting') return;
      link.tries = 0;
      open();
    };

    /**
     * v2.4.0（用户第 ③ 项）：立刻换一条新连接（主动换线，不等退避）。
     *
     * 锁屏 / 切后台回来时，旧 socket 可能已被服务端按心跳超时半杀死（本地还没
     * 收到 close），也可能下一秒就收到 takeover 踢包的 4001「已在别处重新连接」。
     * 主动换线后：新连接立即接管 link.sock，旧连接的代号失效 —— 它迟到的
     * onclose 被连接代号过滤掉，永远不会误杀新连接 / 误报「连接已断开」。
     * online / connecting 时也允许（先关旧再开新）；manual 后不动作。
     */
    link.refresh = function () {
      if (link.manual || link.ended) return;
      var old = link.sock;
      link.sock = null;
      link.connSeq += 1;               // 立即使旧连接的一切后续事件失效
      link.tries = 0;
      if (old) { try { old.close(1000, 'refresh'); } catch (e) { /* 忽略 */ } }
      open();
    };

    open();
    return link;
  }

  /* ============================================================
   * 权威端（KP）侧：把 RoomModel.Host 接到中继的 hub.* 协议上
   * ============================================================ */

  function HostSide(opts) {
    this.host = opts.host;                  // RoomModel.Host
    this.link = null;
    this.room = opts.room || {};            // {code, wsUrl, hostToken, meta}
    this.onState = opts.onState || function () {};
    this.onError = opts.onError || function () {};
    this.onPeer = opts.onPeer || function () {};
    this.onCounts = opts.onCounts || function () {};
    this.onSave = opts.onSave || function () {};   // (ok, seq, savedAt)
    /* v2.12.2：重连预检发现房间已没了（结团/关房/被清理）→ 终态回调 */
    this.onEnded = opts.onEnded || function () {};
    this.selfCid = '';
    this.reportedStatus = '';
    this.hostGone = false;
    /* v2.0.0：实时存档的节流合并窗口（默认 800ms） */
    this.saveWindow = opts.saveWindow || 800;
    /* 自动存档开关：默认开。单元测试可关掉，避免定时器污染其它用例。 */
    this.autoSave = opts.autoSave !== false;
    this._saveTimer = null;
    this._savedSeq = -1;
    this._saving = false;
  }

  HostSide.prototype.open = function () {
    var self = this;
    this.link = connect(this.room.wsUrl, {
      onState: function (s, info) { self.onState(s, info); },
      onText: function (t) { self._onText(t); },
      onOpen: function () { self._afterOpen(); },
      onFatal: function (reason) { self.onError(reason || '房间连接已终止'); },
      /* v2.12.2：掉线后重连前先问「房间还在吗」，没了就进终态、不再死循环 */
      checkAlive: function () { return probeAlive(self.room.code); },
      onEnded: function (reason) { self.onEnded(reason); }
    });
    return this.link;
  };

  HostSide.prototype._afterOpen = function () {
    /* 权威端连上之后要做的事只有一件：把房间状态重新报给中继。
       名册与全量同步由服务端在 host.ok 之后逐个 peer.open 通知我们，
       见下面 _handlePeerOpen —— 不要在这里自作聪明地自己发一遍。 */
    this.hostGone = false;
    this._reportMeta();
    /* v2.0.0：上线后把当前存档推一次（服务端可能还没有 / 落后）。 */
    this._scheduleStateSave();
  };

  HostSide.prototype._onText = function (text) {
    var m;
    try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    var k = m.k;
    if (k === 'ready') {
      this.selfCid = m.cid || '';
      this.host.selfSeat = m.seat || 'host';
      return;
    }
    if (k === 'host.ok') {
      if (m.meta) {
        for (var key in m.meta) {
          if (Object.prototype.hasOwnProperty.call(m.meta, key)) this.host.state.meta[key] = m.meta[key];
        }
        this.reportedStatus = m.meta.status || '';
      }
      if (m.counts) this.onCounts(m.counts);
      return;
    }
    if (k === 'peer.open') { this._handlePeerOpen(m); return; }
    if (k === 'peer.msg') { this._handlePeerMsg(m); return; }
    if (k === 'peer.close') { this._handlePeerClose(m); return; }
    if (k === 'error') { this.onError(m.message || '房间服务返回错误'); return; }
    // 其余（含中继自己的协议）一律忽略
  };

  HostSide.prototype._handlePeerOpen = function (m) {
    var res = this.host.attachPeer({
      seat: m.seat, cid: m.cid, role: m.role, nickname: m.nickname, at: Date.now()
    });
    if (res.blocked) {
      // 被踢过的人又连上来了：直接让中继断开他（房间状态里已经没有他）
      this.link.sendObj({ k: 'hub.close', cid: m.cid, text: '你已被移出房间' });
      return;
    }
    this._dispatch(res.out);
    this.onPeer('open', res.member, m);
  };

  HostSide.prototype._handlePeerMsg = function (m) {
    var seat = this._seatOfCid(m.cid);
    if (!seat) return;                       // 不认识的连接：忽略（不要猜）
    var msg = MODEL ? MODEL.parse(String(m.text || '')) : null;
    if (!msg || msg.k !== 'intent') return;  // 中继层消息不会从 peer.msg 来
    this._dispatch(this.host.intent(seat, msg));
    /* ⚠️ 必须通知界面重画。玩家「准备好了」「发了言」「掷了骰」都会改权威端状态，
       但房主那台设备不会自己知道 —— 早期只把 onPeer 挂在 open/close 上，
       于是房主的页面停在「等待全员准备」，按钮永远是灰的（玩家那边却已经准备了）。
       这是「状态对了、界面没跟上」的典型表现，只靠状态断言测不出来。 */
    this.onPeer('msg', this.host.roster.get(seat), m);
  };

  HostSide.prototype._handlePeerClose = function (m) {
    var seat = m.seat || this._seatOfCid(m.cid);
    if (!seat) return;
    /* ⚠️ 重连接管时服务端会先发新的 peer.open 再发旧的 peer.close（顺序不定）。
       如果不比对 cid，就会把「刚回来的那个人」又标成离线 ——
       表现是玩家莫名其妙被显示成掉线，而他其实好好地连着。 */
    var mem = this.host.roster.get(seat);
    if (mem && m.cid && mem.cid && mem.cid !== m.cid) return;
    this._dispatch(this.host.detachPeer(seat));
    this.onPeer('close', mem, m);
  };

  HostSide.prototype._seatOfCid = function (cid) {
    if (!cid) return '';
    var list = this.host.roster.list();
    for (var i = 0; i < list.length; i++) if (list[i].cid === cid) return list[i].seat;
    return '';
  };

  /**
   * 房主自己发出的意图（发言、掷骰、请求…）。
   *
   * 必须存在这个方法：界面里「发言」只有一个入口 sendIntent()，
   * 它对房主和玩家是同一份代码。若 HostSide 没有 intent()，
   * 房主打字回车就**静默无效** —— 不报错、不提示，只是没反应。
   * 走 Host.intent(HOST_SEAT, …) 是为了让 KP 与玩家共用同一条事件通路。
   */
  HostSide.prototype.intent = function (op, p) {
    var plan = this.host.intent(
      (MODEL && MODEL.HOST_SEAT) || 'host',
      { k: 'intent', op: op, p: p });
    // 重画由 _dispatch 统一负责（见上面的注释），这里不再重复调
    this._dispatch(plan);
    return plan;
  };

  /**
   * 把 RoomModel 的发送计划翻译成中继的 hub.broadcast / hub.send。
   *
   * ⚠️ 这里是**所有**房主侧状态变更的唯一出口：act / request / confirmAct / intent
   *    最终都落到这里。所以「重画界面」必须挂在这个出口上，而不是靠每个调用点
   *    自己记得调 paint()。漏一次的表现是：模型已经变了、界面还是旧的 ——
   *    比如开战后 KP 面板还停在探索页，玩家看不到「下一个行动」。
   */
  HostSide.prototype._dispatch = function (plan) {
    var meaningful = false;
    for (var i = 0; i < plan.length; i++) {
      var step = plan[i];
      var text = JSON.stringify(step.msg);
      /* 只有「内容类」事件才算存档变更 —— ARCHIVE 是存档自己的回执，
         把它也算进去会形成「推送→回执→再推送」的死循环。 */
      if (step.msg && step.msg.k === 'evt' && step.msg.t !== MODEL.EVT.ARCHIVE) meaningful = true;
      if (step.to === '*') {
        this.link.sendObj({ k: 'hub.broadcast', text: text });
      } else {
        var cid = this._cidOfSeat(step.to);
        // 不在线就没有 cid，直接跳过：硬发一个空 cid 会被中继当垃圾丢掉
        if (cid) this.link.sendObj({ k: 'hub.send', cid: cid, text: text });
      }
    }
    this._reportMeta();
    // 自己的状态变了，同样要让界面重画（用 'self' 与「有人进出」区分开）
    this.onPeer('self', null, null);
    /* v2.0.0：内容变了 → 节流合并后把全量存档推给服务器 */
    if (meaningful) this._scheduleStateSave();
  };

  /* ============================================================
   * v2.0.0：实时存档（节流合并 → POST /state）
   * ============================================================ */

  /** 节流：800ms 合并窗口内多次变更只推一次全量存档。 */
  HostSide.prototype._scheduleStateSave = function () {
    var self = this;
    if (!this.autoSave) return;               // 测试环境可关闭
    if (this._saveTimer) return;              // 已有待发窗口 → 合并
    this._saveTimer = setTimeout(function () {
      self._saveTimer = null;
      self._pushState();
    }, this.saveWindow);
  };

  /**
   * v2.13.6（用户报「KP 锁屏解锁后玩家被结团」）：从服务端**拉回存档并 adoptSave**，
   * 但**绝不改房间状态**。
   *
   * 为什么单独开一个方法：以前 KP 续玩只有 `resume()` 一条路，它会
   * POST /resume → 中继把房间刷成 RECRUITING → 安卓锁屏后 WebView 重载
   * （renderRoom 路径③）走的是裸 resumeMine，**连存档都不拉**，于是一个空 Host
   * 上线：成员表没技能、房间状态被刷回招募中，整局数据对玩家全丢。
   * 真正的「复活挂起房」仍走 resume()（那里本来就要改状态）。
   */
  HostSide.prototype.adoptServerState = function () {
    var self = this;
    if (!this.room || !this.room.code || !this.room.hostToken) {
      return Promise.resolve(false);
    }
    return getState(this.room.code, this.room.hostToken, 1).then(function (j) {
      if (!j || !j.payload) return false;
      var save = MODEL.parseSave ? MODEL.parseSave(j.payload) : null;
      if (!save) return false;
      self.host.adoptSave(save);
      return true;
    }, function () { return false; });
  };

  /** 立即推一次全量存档（供 open / 挂起 / 复活 / 测试显式调用）。 */
  HostSide.prototype._pushState = function () {
    var self = this;
    if (!this.room || !this.room.code || !this.room.hostToken) return Promise.resolve(null);
    if (!this.link || this.link.state !== 'online') return Promise.resolve(null);
    var seq = this.host.log.seq;
    if (seq === this._savedSeq) return Promise.resolve(null);   // 无变化不重发
    var payload = this.host.savePayload();
    this._saving = true;
    return saveState(this.room.code, this.room.hostToken, seq, payload).then(function (j) {
      self._saving = false;
      self._savedSeq = seq;
      var savedAt = (j && j.savedAt) || Date.now();
      self._emitArchive(seq, savedAt, true);
      if (self.onSave) self.onSave(true, seq, savedAt);
      return j;
    }, function (e) {
      self._saving = false;
      self._emitArchive(seq, 0, false);
      if (self.onSave) self.onSave(false, seq, 0);
      if (self.onError) self.onError('存档推送失败：' + ((e && e.message) || e));
      return null;
    });
  };

  /** 把存档结果通知 KP 端（VIS.SEAT 到 host；其他人收到水位标记，序号不断档） */
  HostSide.prototype._emitArchive = function (seq, savedAt, ok) {
    var rec = this.host.emit(MODEL.EVT.ARCHIVE,
      { seq: seq, savedAt: savedAt, ok: ok }, MODEL.VIS.SEAT, MODEL.HOST_SEAT);
    this._dispatch(this.host.plan(rec));
  };

  /* ---- 挂起 / 复活（模型发事件，传输层发 HTTP）---- */

  /** 挂起房间：先落状态与事件，再推存档、调 POST /suspend */
  HostSide.prototype.suspend = function () {
    var plan = this.host.applyAction(MODEL.HOST_SEAT, { op: 'room.suspend' });
    this._dispatch(plan);
    var self = this;
    /* 先把最新存档推上去，再挂起 —— 否则服务器上的存档可能落后一步。 */
    Promise.resolve(this._pushState()).then(function () {
      return suspendRoom(self.room.code, self.room.hostToken);
    }).then(function () {
      self.reportedStatus = 'SUSPENDED';
      self.link.sendObj({ k: 'hub.meta', meta: { status: 'SUSPENDED' } });
    }, function (e) {
      if (self.onError) self.onError('挂起房间失败：' + ((e && e.message) || e));
    });
    return plan;
  };

  /** 复活挂起房间：从服务器拉回存档 → 重建 Host → 广播全量。返回 Promise。 */
  HostSide.prototype.resume = function () {
    var self = this;
    return resumeRoom(this.room.code, this.room.hostToken).then(function (j) {
      if (j && j.payload) {
        var save = MODEL.parseSave(j.payload);
        if (save) self.host.adoptSave(save);
      }
      var plan = self.host.applyAction(MODEL.HOST_SEAT, { op: 'room.resume' });
      self._dispatch(plan);
      self.reportedStatus = '';
      self._savedSeq = -1;                    // 强制重推一次存档
      self._scheduleStateSave();
      return plan;
    }, function (e) {
      if (self.onError) self.onError('复活房间失败：' + ((e && e.message) || e));
      return [];
    });
  };

  HostSide.prototype._cidOfSeat = function (seat) {
    var m = this.host.roster.get(seat);
    return (m && m.online && m.cid) ? m.cid : '';
  };

  /** 房间状态（招募中 / 游戏中）上报给中继，目录里才能显示对 */
  HostSide.prototype._reportMeta = function () {
    var st = this.host.state.meta.status;
    if (!st || st === this.reportedStatus) return;
    this.reportedStatus = st;
    this.link.sendObj({ k: 'hub.meta', meta: { status: st } });
  };

  /** 房主主动关房：先让中继把房间标记关闭，再断开自己 */
  HostSide.prototype.closeRoom = function () {
    this._dispatch(this.host.closeRoom());
    this.reportedStatus = 'CLOSED';
    this.link.sendObj({ k: 'hub.meta', meta: { status: 'CLOSED' } });
    return closeRoom(this.room.code, this.room.hostToken).catch(function () { return null; });
  };

  /**
   * 权威端执行一个 KP 动作，并把结果计划发出去。
   * 界面不该直接调 _dispatch（私有），也不该自己判「这个动作该不该发」——
   * 权限由 RoomModel.needs() 判、事件由 Host.applyAction() 产，这里只负责送出去。
   * 动作的**目标**（踢谁、线索给谁）写在 action 里（如 {op:'room.kick', seat}），
   * 不要另开一个参数：发信人和收信人混成一个位置参数，第一个读代码的人就会传错。
   */
  HostSide.prototype.act = function (action) {
    action = action || {};
    /* v2.13.6（用户报「KP 锁屏解锁后玩家被结团」）：结团 / 关房**只能**走
       request + confirmAct（那里有 pending 队列 + 2 分钟过期闸门）。
       直接 act() 会把二次确认整个绕开 —— 安卓上页面重载 / 迟到回调
       复放一条旧 action 就可能把全桌人结团掉。 */
    if (action.op === 'session.end' || action.op === 'room.close') {
      if (this.onError) this.onError('结团/关房需要二次确认，请用「结团」按钮');
      return [];
    }
    /* v2.0.0：挂起 / 复活有**网络副作用**（POST /suspend、/resume），
       必须在传输层触发，room-model 保持纯逻辑。 */
    if (action.op === 'room.suspend') return this.suspend();
    if (action.op === 'room.resume') return this.resume();
    var plan = this.host.applyAction('host', action);
    this._dispatch(plan);
    return plan;
  };

  /**
   * 走**权限表**的 KP 动作入口：先 needs() 判能不能做、要不要二次确认。
   * - 不在权限表 → 直接返回空计划（界面不该能点出来，但伪造也拦得住）
   * - confirm === 'twice'/'kp' → 挂进 pending，返回「已排队」；等 UI 弹完确认再调 confirmAct
   * - 其它 → 等价于 act()
   * ⚠️ 界面**必须**用这个而不是 act()，否则「结团」这类高危动作会绕过二次确认。
   */
  HostSide.prototype.request = function (action) {
    action = action || {};
    /* 挂起 / 复活：走专门的传输层入口（要发 HTTP），不走通用排队 */
    if (action.op === 'room.suspend') return this.suspend();
    if (action.op === 'room.resume') return this.resume();
    var verdict = MODEL.needs(MODEL.ROLE.KP, action.op);
    if (!verdict.allowed) return [];
    if (verdict.confirm === 'twice' || verdict.confirm === 'kp') {
      // 复用 Host.intent 的排队逻辑；它会落一条 pending 并回一条「等待确认」
      var plan = this.host.intent(MODEL.HOST_SEAT,
        MODEL.intentMsg(MODEL.INTENT.ACT, action));
      this._dispatch(plan);
      return plan;
    }
    return this.act(action);
  };

  /** KP 对已排队的高危动作做二次确认（agree=false 就是取消） */
  HostSide.prototype.confirmAct = function (op, agree) {
    var plan = this.host.intent(MODEL.HOST_SEAT,
      MODEL.intentMsg(MODEL.INTENT.CONFIRM, { op: op, agree: agree !== false }));
    this._dispatch(plan);
    // 结团/关房成功后房间状态会变成 CLOSED，需要上报给中继
    if (agree !== false) this._reportMeta();
    return plan;
  };

  /** v2.0.2 T4：前台恢复时立刻重连（不等退避）。 */
  HostSide.prototype.retryNow = function () {
    if (this.link && this.link.retryNow) this.link.retryNow();
  };

  HostSide.prototype.destroy = function () {
    if (this.link) this.link.close();
  };

  /* ============================================================
   * 玩家 / 旁观者侧：把 RoomModel.Client 接到 WebSocket 上
   * ============================================================ */

  function PlayerSide(opts) {
    this.client = opts.client;              // RoomModel.Client
    this.room = opts.room || {};            // {code, wsUrl, mtoken, role}
    this.onState = opts.onState || function () {};
    this.onEvent = opts.onEvent || function () {};     // (state, evtInfo)
    this.onError = opts.onError || function () {};
    /* v2.12.2：重连预检发现房间已没了（结团/关房/被清理）→ 终态回调 */
    this.onEnded = opts.onEnded || function () {};
    /* v2.0.0：权威端把角色卡状态写回本机时的回调（UI 可自定义落库；缺省落 Store） */
    this.onSheetState = opts.onSheetState || null;
    /* v2.5.0（回归修复 · v2.1.1 任务B）：角色卡写回**结果**的回调与留痕。
       之前 room-ui.js 一直在传 `onSheetApply: onSheetApplyDiag(gen)`，但传输层
       **从未**把它接进来（`this.onSheetApply` 根本不存在），写回失败时诊断为 0 条 ——
       表现就是「KP 发了伤害 / 物品，玩家卡上毫无变化，也不报错」。 */
    this.onSheetApply = opts.onSheetApply || null;
    /* v2.9.0（用户第 1 项）：KP 点「推进一回合」→ 本机把本房「临时卡」自动「生效到原卡」
       （EVT.TEMP_COMMIT 到达时触发）。回调签名 (p, {committed})，committed = 本次真正生效
       的临时卡张数（0 = 本机无本房临时卡，已静默跳过）。null 表示 UI 不处理。 */
    this.onTempCommit = opts.onTempCommit || null;
    this.lastSheetApply = null;
    this.link = null;
    this.kicked = null;
    this.closedByHost = false;
    /* v2.5.0（用户第 7 项）：断线补齐状态 —— 是否还挂着缺口 / 本次补拉的起点序号 */
    this._gapWasOpen = false;
    this._resyncFromSeq = 0;
  }

  PlayerSide.prototype.open = function () {
    var self = this;
    this.link = connect(this.room.wsUrl, {
      onState: function (s, info) { self.onState(s, info); },
      onText: function (t) { self._onText(t); },
      onOpen: function () { self._afterOpen(); },
      onFatal: function (reason) { self.onError(reason || '连接已终止'); },
      /* v2.12.2：掉线后重连前先问「房间还在吗」，没了就进终态、不再死循环 */
      checkAlive: function () { return probeAlive(self.room.code); },
      onEnded: function (reason) { self.onEnded(reason); }
    });
    return this.link;
  };

  PlayerSide.prototype._afterOpen = function () {
    /* 每次（重）连上都要报一次「我在哪」：带 lastSeq，权威端据此决定
       是补发断线期间的事件还是给一份全量。这是断线重连的全部秘密。 */
    this._send(MODEL.INTENT.SYNC, { lastSeq: this.client.lastSeq });
    /* v2.0.0：再补一条「从服务器存档同步」的路径 ——
       当本地没有可用状态、或本地 seq 落后于服务器存档时，
       直接拉服务器上的存档（房主那台设备可能已经不在线）。 */
    this._pullServerState();
  };

  /**
   * 从服务器拉存档并裁剪后应用。
   * ⚠️ 契约 §2.1：**进程重启后玩家 token 会失效**（服务端成员表只在内存），
   *    所以拉取失败要**优雅降级**为「等待房主重推」，绝不卡死、不报错弹窗。
   */
  PlayerSide.prototype._pullServerState = function () {
    var self = this;
    if (!this.room || !this.room.code || !this.room.mtoken) return;
    if (!MODEL.playerViewFromSave) return;
    /* 尽力而为的后台补拉：**不重试**（retries=0）。
       失败就静默降级等房主重推，绝不延后重试、绝不卡死、绝不弹窗。 */
    var p;
    try {
      p = getState(this.room.code, this.room.mtoken, 0);
    } catch (e) {
      return;                                             // 网络层不可用 → 静默降级
    }
    if (!p || typeof p.then !== 'function') return;
    p.then(function (j) {
      if (!j || !j.payload) return;                       // no_state → 等房主重推
      var seq = Number(j.seq) || 0;
      if (seq <= self.client.lastSeq) return;             // 本地不落后，无需拉
      var view = MODEL.playerViewFromSave(j.payload, self.client.seat);
      if (!view) return;
      var r = self.client.receive(view);
      if (r && (r.changed || r.kind === 'sync')) {
        self.onEvent(self.client.state, { kind: 'server-state', seq: seq });
      }
    }, function () {
      /* 拉不到（no_state / bad_token / 网络）→ 静默降级：房主会重推全量 */
    });
  };

  /** 权威端写回角色卡状态：幂等应用 + 落 Store + 回执 */
  PlayerSide.prototype._onSheetState = function (p) {
    var r = this.client.applySheetState(p.seq, p);
    if (!r.applied) return;                               // 同一 seq 已应用过 → 丢弃
    if (this.onSheetState) this.onSheetState(p, r);
    else this._applySheetStateDefault(p);
    this._send(MODEL.INTENT.STATE_SYNC, { seq: p.seq });
  };

  /**
   * v2.0.2 T3：状态写回的默认落点。
   *   · 本房本卡**有临时卡** → 只写临时卡（原卡纹丝不动；玩家点「生效」才覆盖原卡）；
   *   · 没有临时卡（未开局绑卡 / 老路径）→ 退回旧的「写原卡」行为（功能不退化）。
   */
  PlayerSide.prototype._applySheetStateDefault = function (p) {
    var code = this.room && this.room.code;
    var RS = global.RoomStore;
    try {
      if (code && p && p.charId && RS && typeof RS.getTempCard === 'function' &&
          RS.getTempCard(code, p.charId) && typeof RS.applyToTempCard === 'function') {
        RS.applyToTempCard(code, p.charId, p);
        /* v2.5.0（回归修复）：记下落点 —— 命中临时卡的写回也算成功，但要能看出来 */
        this.lastSheetApply = { ok: true, via: 'tempCard', reason: '', cardId: p.charId };
        return;
      }
    } catch (e) { /* 临时卡写入失败 → 退回写原卡 */ }
    this.lastSheetApply = MODEL.applyStateToCard(global.Store, p.charId, p) ||
      { ok: false, reason: 'unknown', cardId: p.charId };
    /* v2.5.0（回归修复）：写回失败**必须**有出口，不能静默吞掉 ——
       否则玩家看到的是「KP 发了伤害，我的卡毫无变化，也不报错」。 */
    if (this.lastSheetApply.ok === false && this.onSheetApply) {
      this.onSheetApply({
        ok: false, reason: this.lastSheetApply.reason || 'unknown',
        cardId: this.lastSheetApply.cardId || '', seat: (p && p.seat) || '',
        via: 'store'
      });
    }
  };

  /**
   * v2.9.0（用户第 1 项）：KP 点「推进一回合」→ 本机「本房」临时卡自动「生效到原卡」。
   *
   * 背景：临时卡存在**每个玩家本机** localStorage（key = KEY_TEMP_PREFIX + roomCode +
   *   '.' + charId），**不跨设备**。KP 写不了别人的存储，故策略是「KP 广播
   *   EVT.TEMP_COMMIT → 各玩家客户端自己执行 commitTempCard」。生效 = 用临时卡覆盖
   *   原卡（幂等，可重复）。
   *
   * ⚠️ roomCode 隔离：只提交**本房**的临时卡 —— 本机可能同时留有多间房的临时卡
   *   （续玩 / 多开），绝不能误伤别房。
   * ⚠️ 本机没有本房临时卡 → 静默跳过（不报错、不提示、不阻断收包）。
   * ⚠️ 生效是**不可撤销地覆盖原卡**（用户明示「无需玩家同意」的代价），由 UI 负责告知。
   *
   * @param {object} p 载荷 { round, at }
   */
  PlayerSide.prototype._onTempCommit = function (p) {
    var code = this.room && this.room.code;
    var RS = global.RoomStore;
    var committed = 0;
    if (code && RS && typeof RS.listTempCards === 'function' &&
        typeof RS.commitTempCard === 'function') {
      var cards = [];
      try { cards = RS.listTempCards() || []; } catch (e) { cards = []; }
      for (var i = 0; i < cards.length; i++) {
        var c = cards[i];
        /* roomCode 隔离：只提交本房；别房（续玩 / 多开）的临时卡绝不误伤 */
        if (!c || c.roomCode !== String(code) || !c.charId) continue;
        try { if (RS.commitTempCard(code, c.charId)) committed += 1; }
        catch (e) { /* 单张失败不阻断其余 */ }
      }
    }
    if (this.onTempCommit) this.onTempCommit(p || {}, { committed: committed });
  };

  PlayerSide.prototype._send = function (op, p) {
    if (!this.link) return;
    this.link.send(JSON.stringify(MODEL.intentMsg(op, p)));
  };

  PlayerSide.prototype.intent = function (op, p) { this._send(op, p); };

  PlayerSide.prototype._onText = function (text) {
    var m = MODEL.parse(text);
    if (!m) {
      // 中继层的通知（不是应用层消息）
      this._onRelay(text);
      return;
    }
    var r = this.client.receive(m);
    /* v2.5.0（用户第 7 项·a/b）：只要这次通过闸门、且 gapFrom 已归零，就说明缺口补上了。
       以前 dup / skip 分支直接 return、永不回调 onEvent —— 而 host 补拉回来的头几条
       常常就是水位标记（SEAT 事件给其他人只发 skipMsg；EVT.ARCHIVE 占共享序号但玩家
       只收到 skip），于是「补齐已完成」这条事实根本传不到界面，
       「正在补齐断线期间的记录…」横幅就永远挂着。 */
    if (r.kind !== 'ignore' && !r.gap && this._gapWasOpen && this.client.gapFrom === 0) {
      this._gapWasOpen = false;
      this.onEvent(this.client.state, { kind: 'gap-filled', from: this._resyncFromSeq || 0, to: this.client.lastSeq || 0 });
    }
    if (r.gap) {
      this._gapWasOpen = true;
      this._resyncFromSeq = r.from || this.client.lastSeq || 0;
      // 丢包了：主动补拉，而不是等下一次（否则中间的内容永久缺失）
      if (this.link) this.link.send(JSON.stringify(this.client.resyncIntent()));
      this.onEvent(this.client.state, { kind: 'gap', from: r.from, got: r.got });
      return;
    }
    if (r.dup) return;
    if (r.kind === 'skip') return;
    /* v2.0.0：角色卡状态写回（幂等应用 + 落本机 Store + 回执）
       v2.5.0（回归修复 · v2.1.1 任务B）：**先写回、后重绘** —— onEvent 会让界面
       重绘并读本机 Store，写回若排在它后面，这一帧读到的还是旧血量
       （「界面滞后一帧」）。状态事件必须先把事实落到卡上，再通知界面。 */
    if (m.t === MODEL.EVT.STATE) this._onSheetState(m.p || {});
    /* v2.9.0（用户第 1 项）：KP 推进回合 → 本机临时卡自动「生效到原卡」。
       与 EVT.STATE 同款：**先落库、后重绘**（onEvent 会让界面重绘并读本机卡）。 */
    if (m.t === MODEL.EVT.TEMP_COMMIT) this._onTempCommit(m.p || {});
    this.onEvent(this.client.state, r);
    if (m.t === MODEL.EVT.KICK) this.kicked = (m.p && m.p.reason) || '你已被移出房间';
    if (m.t === MODEL.EVT.CLOSED) this.closedByHost = true;
  };

  PlayerSide.prototype._onRelay = function (text) {
    var m;
    try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;

    if (m.k === 'ready') {
      /* 握手完成：把自己的 seat 记下来。
         seat 是「认人」的身份（同一份凭据重连也不变），界面靠它才能把自己
         从成员表里认出来 —— 没有它，「我准备好了」永远是灰的、
         自己发的聊天也不会靠右。cid 只用来收信，界面不需要它。 */
      this.selfCid = m.cid || '';
      this.client.seat = m.seat || '';
      /* v2.0.2 T4：服务端在「设备码回座」时会**补发一枚新 mtoken**（进程重启后原
         mtoken 已失效）。记下来并持久化到 RoomStore，否则下次重连又用失效凭据。 */
      if (m.mtoken && this.room) {
        this.room.mtoken = m.mtoken;
        try {
          var RS = global.RoomStore;
          var rec = (RS && RS.getJoined) ? RS.getJoined(this.room.code) : null;
          if (rec && RS.setJoined) {
            RS.setJoined({ code: this.room.code, mtoken: m.mtoken,
                           serverBase: rec.serverBase, role: rec.role, nickname: rec.nickname,
                           name: rec.name, kpName: rec.kpName });
          }
        } catch (e) { /* 持久化失败不影响本次连接 */ }
      }
      this.onEvent(this.client.state, { kind: 'ready', seat: this.client.seat });
      return;
    }

    /* v2.5.0（用户第 11 项）：玩家侧以前**完全没有** error 分支 —— 服务端限流
       （RATE_MSGS 超限 → {"k":"error","message":"消息发送过于频繁，请稍后再试"}）
       推下来后玩家得不到任何反馈，只能干等。这里对齐 HostSide#_onRelay。 */
    if (m.k === 'error') {
      this.onError(m.message || '房间服务返回错误');
      return;
    }
    if (m.k !== 'host.gone') return;
    /* 房主断线：房间不自动转移（需求 §14），界面上要把状态说清楚，
       否则玩家会以为「卡住了」。 */
    this.onEvent(this.client.state, { kind: 'host-gone', message: m.message || '房主已断开' });
  };

  /** v2.0.2 T4：前台恢复时立刻重连（不等退避）。 */
  PlayerSide.prototype.retryNow = function () {
    if (this.link && this.link.retryNow) this.link.retryNow();
  };

  PlayerSide.prototype.destroy = function () {
    if (this.link) this.link.close();
  };

  /* ============================================================
   * 对外 API
   * ============================================================ */
  global.RoomNet = {
    /* 地址 */
    normalizeBase: normalizeBase,
    base: base,
    baseList: baseList,
    baseCount: baseCount,
    activeBase: activeBase,
    splitBases: splitBases,
    resolve: resolve,
    wsBase: wsBase,
    wsUrlFor: wsUrlFor,
    configured: configured,
    looksValid: looksValid,
    isPrivateHost: isPrivateHost,
    inviteBase: inviteBase,
    injectedBase: injectedBase,
    userBase: userBase,
    presetBase: presetBase,
    inviteParams: inviteParams,

    /* HTTP */
    health: health,
    list: list,
    probe: probe,
    create: create,
    join: join,
    closeRoom: closeRoom,
    req: req,
    /* v2.0.2 T1：设备标识（惰性取；无模块时返回 ''） */
    deviceId: deviceId,
    /* v2.0.0：存档 / 挂起 / 复活 */
    saveState: saveState,
    getState: getState,
    suspendRoom: suspendRoom,
    resumeRoom: resumeRoom,
    /* v2.0.2：解绑本机设备身份 / 可命名存档槽 */
    unbind: unbind,
    createSave: createSave,
    listSaves: listSaves,
    getSave: getSave,
    loadSave: loadSave,
    deleteSave: deleteSave,

    /* 自检 */
    pingBase: pingBase,
    selfCheck: selfCheck,
    lanDiagnose: lanDiagnose,
    swapHost: swapHost,
    DEFAULT_TIMEOUTS: DEFAULT_TIMEOUTS,

    /* WebSocket */
    connect: connect,
    RECONNECT_DELAYS: RECONNECT_DELAYS,
    HostSide: HostSide,
    PlayerSide: PlayerSide
  };
})(typeof window !== 'undefined' ? window : this);
