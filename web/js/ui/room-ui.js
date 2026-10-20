/* ============================================================
 * room-ui.js — 跑团房间的界面
 * 对外命名：window.RoomUI
 *
 * 分工（需求 §0「不得把规则散落在按钮事件里」的同一条原则）：
 *   RoomModel  = 唯一状态机（房间状态、成员、事件、权限）
 *   RoomNet    = 唯一传输口（HTTP + WebSocket）
 *   RoomStore  = 唯一持久化口
 *   本文件     = 只做两件事：把 state 画出来 / 把用户操作变成 intent
 *               界面里**不许**出现「自己算一遍能不能开始游戏」这类逻辑，
 *               一律问 RoomModel.allowed()。
 *
 * 页面结构（都是普通路由页，不是弹层）：
 *   #/room        入口：规则选择、创建、加入、局域网说明、最近房间
 *   #/room/<code> 房间：成员 / 准备 / 聊天 / KP 工具 / 邀请
 * ============================================================ */
(function (global) {
  'use strict';

  var M = null, N = null, S = null;      // RoomModel / RoomNet / RoomStore（boot 时取）

  /** 当前会话。一个页面同时只会有一个房间会话。 */
  var sess = null;
  /* sess = {
       role: 'kp' | 'player' | 'spectator',
       code, host, client, side, meta, chatEl, membersEl, bannerEl,
       roomName, invite, unsub,
     } */

  /* ============================================================
   * v2.0.3 缺陷2：会话代号（generation）。
   *
   * 症状：resumeRoom 之后 sess.linkState 误报 'closed'，而此刻
   *   WS.readyState === 1、sess.side.link.state === 'online'
   *   —— 顶栏一直显示「连接已断开」，玩家以为什么都没恢复。
   *
   * 根因（见 tools/_probe_v203_linkstate.py 差分复现）：
   *   resumeRoom 会新建一个 side，但**不关闭**上一个 side（renderEntry 只把
   *   sess 置空）。续玩复用同一 hostToken/mtoken → 服务端 takeover 踢掉旧连接
   *   → 旧 side 迟到的 onState('closed') 回调闭包引用的却是**模块级 sess**，
   *   于是把新会话的 linkState 覆盖成了 'closed'。
   *   A（不刷新，旧 side 仍在）：linkState=closed / sideLink=online / 旧 side 收到 ['closed']
   *   B（刷新，无旧 side）    ：linkState=online                     ← 对照组，坐实根因
   *
   * 修法：每次新建会话自增代号；回调带着出生时的代号回来，凡不是「当前会话」
   *   一律丢弃（generation 计数法）。这样旧 side 的任何迟到回调（closed/error/事件）
   *   都无法再污染新会话。⚠️ 不能靠「取消防抖定时器」等间接手段 —— 根因是回调
   *   闭包捕获了模块级 sess，必须显式按代丢弃。
   * ============================================================ */
  var sessGen = 0;

  /** 代际回调是否已过期（旧 side 残留回调）。未带代号（如测试驱动）视为当前。 */
  function isStaleSession(gen) { return gen !== undefined && gen !== sessGen; }

  function boot() {
    M = global.RoomModel; N = global.RoomNet; S = global.RoomStore;
    installLifecycleHooks();
  }

  /* ============================================================
   * v2.0.2 T4：前台恢复 → 立刻重连（不等退避定时器）
   *
   * 手机切后台再回来时，WebSocket 往往已被系统/网络回收，而退避定时器可能
   * 还要等好几秒。用户不希望「回到前台还看到『正在重连』」。所以在
   * visibilitychange→visible 时，若连接已断，立刻试一次（见 room-net 的 link.retryNow）。
   * ============================================================ */
  var _lifecycleInstalled = false;

  /* v2.1.4（用户第 3 项 ·「收起输入法后界面回到最上面」）：
     安卓 WebView 在输入法弹起时会把固定定位的 .game-page 高度压矮、并自动滚动
     到聚焦输入框；输入法收起后高度回弹，但滚动位置被留在/重置到顶部。
     这里在 focusin 时记下 .game-page 的 scrollTop，focusout（输入法收起）后
     分两拍还原（键盘收起是异步动画）。 */
  var _kbGuardOn = false;
  function installKbScrollGuard() {
    if (_kbGuardOn) return;
    _kbGuardOn = true;
    function isInput(t) { return !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')); }
    var saved = null;
    document.addEventListener('focusin', function (e) {
      if (!isInput(e.target)) return;
      if (!pageRefs || !pageRefs.root) return;
      saved = { top: pageRefs.root.scrollTop };
    }, true);
    document.addEventListener('focusout', function (e) {
      if (!isInput(e.target)) return;
      if (saved == null || !pageRefs || !pageRefs.root) return;
      var top = saved.top;
      var restore = function () { try { pageRefs.root.scrollTop = top; } catch (err) {} };
      setTimeout(restore, 60);
      setTimeout(restore, 260);
    }, true);
  }

  /* v2.4.0（用户第 ③ 项）：记录「切后台（锁屏）时刻」，回前台时按停流时长
     决定「主动换线」还是「维持旧的重试行为」。 */
  var _hiddenAt = 0;

  function installLifecycleHooks() {
    if (_lifecycleInstalled) return;
    _lifecycleInstalled = true;
    installKbScrollGuard();
    try {
      global.document.addEventListener('visibilitychange', function () {
        if (!sess || !sess.side) return;
        if (global.document && global.document.hidden) {
          _hiddenAt = Date.now();     // v2.4.0（用户第 ③ 项）：记下藏起时刻
          return;                     // 只在「回到前台」时动作
        }
        /* v2.4.0（用户第 ③ 项）：锁屏/后台超过 10 秒 → 主动换线（link.refresh）。
           旧 socket 随时可能被服务端心跳超时 / takeover 关掉，其迟到 onclose
           （「已在别处重新连接」4001）在旧实现里会误杀新连接并误报「连接已断开」，
           表现为「锁屏开屏后重连失败，只能后退重进」。换线 + 连接代号过滤后
           这条竞态不存在。短时切走（<10s）维持旧的 retryNow 行为。 */
        var away = Date.now() - (_hiddenAt || 0);
        if (away > 10000) {
          var lk = sess.side.link;
          if (lk && lk.refresh) { lk.refresh(); return; }
        }
        if (sess.linkState === 'offline' || sess.linkState === 'closed') {
          if (sess.side.retryNow) sess.side.retryNow();
        }
      });
    } catch (e) { /* 无 document（部分测试环境）→ 跳过 */ }
  }

  function T() { return {
    ROLE: M.ROLE, STATUS: M.STATUS, STATUS_TEXT: M.STATUS_TEXT,
    EVT: M.EVT, INTENT: M.INTENT, MODE: M.MODE, REWIND: M.REWIND
  }; }

  /* ============================================================
   * 小工具
   * ============================================================ */

  function el(sel, props, kids) { return global.UI.h(sel, props, kids); }

  function timeText(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  function roleText(r) {
    return r === 'kp' ? 'KP' : (r === 'spectator' ? '旁观' : '玩家');
  }

  /**
   * v2.4.0（用户第 ① 项）：房规摘要（大成功 / 大失败阈值）。
   *
   * 加入房间时用户希望**在加入界面就看到房规**——但服务端 probe/join 的 meta
   * （row_to_meta）不带 critThreshold/fumbleThreshold 两个字段，拿不到；
   * 因此退而求其次：连上房间、拿到全量状态后立刻 toast 一条摘要（每会话一次）。
   * 字段缺失（老房间 / 默认口径）时显示默认值并标注「默认」。
   */
  function roomRulesSummaryText(meta) {
    var m = meta || {};
    var crit = m.critThreshold, fum = m.fumbleThreshold;
    var critTxt = (crit >= 1 && crit <= 100) ? ('≤ ' + crit) : '≤ 1（默认）';
    var fumTxt = (fum >= 1 && fum <= 100) ? ('≥ ' + fum) : '≥ 100（默认）';
    return '房规摘要：大成功 ' + critTxt + '　·　大失败 ' + fumTxt;
  }

  /** 状态胶囊（在线 / 离线 / KP / 旁观） */
  function chip(text, kind) {
    return el('span.chip.sm' + (kind ? '.' + kind : ''), { text: text });
  }

  /** 页面顶部的连接状态条。房间功能的「出问题了」几乎都表现在这里， */
  /*  所以它必须常驻、而且要说清「现在能不能收到消息」。 */
  var LINK_TEXT = {
    connecting: '正在连接房间…',
    online: '已连接',
    offline: '连接已断开，正在重连…',
    closed: '连接已结束'
  };

  function banner(text, kind) {
    return el('div.notice' + (kind ? '.' + kind : ''), null, [el('span', { text: text })]);
  }

  /**
   * 顶部横幅。
   *
   * v2.5.0（用户第 11 项）：新增**可选**第 4 参 `ms`（自动消失时长，毫秒）。
   *   · 向后兼容：现有三参调用语义完全不变（只是 err 类默认 6s 自动清空）；
   *   · `ms` 显式传 0 → 常驻（与旧行为一致）；传 null / undefined → 按 kind 取默认值
   *     （err = 6000ms 自动消失，其余常驻）；
   *   · 每次设置**先 clearTimeout 旧计时器** —— 否则上一条横幅的计时器会把新
   *     横幅清掉（典型的「提示一闪就没了」）。
   *   这修的是「消息发送过于频繁，请稍后再试」这类**可恢复**错误：它是服务端限流
   *   推送（tools/room_server.py 的 RATE_MSGS），此前横幅没有任何消失机制，会一直
   *   挂在房间页顶部。
   * @param {object} s 会话对象（可为 null → 用 pageRefs）
   * @param {string} text 为空表示清掉横幅
   * @param {string} kind 样式（'err' / 'warn' / …）
   * @param {number} [ms] 自动消失时长；0 = 常驻
   */
  function setBanner(s, text, kind, ms) {
    /* v2.1.0 #10：sess 上其实**从未**挂过 bannerEl（只有 pageRefs 有）→ 此前所有
       `setBanner(sess, …)` 都是空操作，横幅从不显示（重连/掉线/房主离开提示用户都看不到）。
       这里回落到 pageRefs.bannerEl，让既有调用全部生效。 */
    var box = (s && s.bannerEl) || (pageRefs && pageRefs.bannerEl);
    /* v2.5.0（用户第 11 项）：先撤掉上一条横幅的计时器，避免它把新横幅清掉 */
    if (s && s._bannerT) { clearTimeout(s._bannerT); s._bannerT = 0; }
    if (!box) return;
    global.UI.clear(box);
    if (!text) return;
    box.appendChild(banner(text, kind));

    var life = (ms === undefined || ms === null) ? (kind === 'err' ? 6000 : 0) : (Number(ms) || 0);
    if (life > 0 && s) {
      s._bannerT = setTimeout(function () {
        s._bannerT = 0;
        // 会话已经换过了就别动新会话的横幅（与 v2.0.3 的代次保护同理）
        if (sess && sess !== s) return;
        setBanner(s, '');
      }, life);
    }
  }

  /** v2.1.1（任务B）：权威端「写回角色卡」失败的**可观测信号**。
   *  applyStateToCard / _applySheetStateDefault 以前静默失败 —— 表现就是
   *  「KP 发了伤害 / 临时状态 / 物品，玩家人物卡毫无变化，也不报错」。
   *  现在把失败原因翻成人话，用横幅明确提示玩家（写没写成一眼可见）。 */
  function onSheetApplyDiag(gen) {
    return function (diag) {
      if (isStaleSession(gen) || !sess) return;
      var d = diag || {};
      var text;
      switch (d.reason) {
        case 'card_not_found':
          text = '收到的状态更新指向一张本机不存在的角色卡（' + (d.cardId || '未知名') +
                 '），已忽略，未误写到别的卡上。请确认你当前绑定的角色卡。';
          break;
        case 'no_card':
          text = '你还没有在本机绑定角色卡，权威端发来的状态更新无法写回。请先绑定一张人物卡。';
          break;
        case 'temp_write_failed':
          text = '本房间临时卡写入失败，状态更新可能未落到卡上。请重进房间或重开本局。';
          break;
        case 'no_store':
          text = '本机存档不可用（Store 未就绪），状态更新无法写回角色卡。';
          break;
        case 'exception':
          text = '写回角色卡时发生异常：' + (d.error || '未知错误');
          break;
        default:
          text = '状态更新未能写回角色卡（' + (d.reason || '未知原因') + '）。';
      }
      setBanner(sess, text, 'warn');
    };
  }

  /**
   * v2.9.0（用户第 1 项）：KP 点「推进一回合」→ 本机「本局临时卡」已自动「生效到原卡」。
   *
   * 生效是**不可撤销地覆盖原卡**（用户明示「无需玩家同意」的代价），所以必须**明确
   * 告知**玩家这是覆盖操作 —— 否则他会以为原卡被写坏了。无本房临时卡时（committed=0）
   * 不打扰（本机无该房临时卡 → 静默跳过）。
   * 提示条沿用既有 tempCardBar（显示「已生效 N 次」），此处只弹 toast + 重绘。
   */
  function onTempCommitNotify(gen) {
    return function (p, r) {
      if (isStaleSession(gen) || !sess) return;
      var n = (r && r.committed) || 0;
      if (n > 0 && global.UI && global.UI.toast) {
        global.UI.toast('KP 推进了回合，你本局角色卡的改动已自动生效到原卡'
          + '（已覆盖你的原角色卡，不可撤销）', 'ok', 5000);
      }
      paint();
    };
  }

  /**
   * UI.select 返回的是**包装 div**（真正的 <select> 是它的第一个子节点），
   * 直接拿它当控件用会踩两个坑：`.value` 恒为 undefined、绑在它身上的 change 事件不触发。
   * 这里包一层，让调用方可以像原生控件一样读 `.value` 与传 onchange。
   */
  function selectCtl(options, value, onchange) {
    var wrap = global.UI.select(options, value, onchange);
    var inner = wrap.querySelector('select');
    Object.defineProperty(wrap, 'value', {
      get: function () { return inner.value; },
      set: function (v) { inner.value = v; }
    });
    return wrap;
  }

  /* ============================================================
   * 入口页 #/room
   * ============================================================ */

  /**
   * v2.2.1（用户第 8 项）：本机**权威**「正在进行的房间」—— 统一所有
   * `#/room/<code>` 入口 / 纠正提示的房间号来源，避免各写各的导致号不一致。
   *
   * v2.2.2（用户第 1 项）：修正排序依据 —— **按「正在进行」的真实信号排序**，
   * 而不是「加入时间」。旧实现只按 `mine.at` / `joined.at` 取「最近加入」，而
   * `at` 只在 `setJoined` 时写一次；玩家用 mtoken **重连 / 续玩**不会刷新 `at`，
   * 于是「最近加入但没在玩」的旧房间反而胜出 —— 实测正在玩 b8rz8c 却回到 p2jgg4。
   *
   * 优先级：
   *   ① 活会话 `sess.code`（正在玩的，最权威）；
   *   ② 有**房间存档**的候选里 `savedAt` 最新者 —— 房间存档在游戏过程中随 seq 变化
   *      持续更新（见 persistLocalSave），`savedAt` 才是「正在玩」的权威信号；
   *   ③ 以上都没有时，再退回 `mine` / `joined` 的 `at` 最新者。
   * 返回 { code, role, live } 或 null。role 取记录/存档里的 role（mine 命中时为 kp）。
   */
  function authoritativeRoom() {
    if (sess && sess.code) return { code: sess.code, role: sess.role || 'player', live: true };
    var RS = global.RoomStore || {};
    /* 角色 / 加入时间：以 code 为键汇总（mine 优先标 kp，joined 取较新 at）。 */
    var roleByCode = {};
    var atByCode = {};
    var mine = (RS.getMine && RS.getMine()) || null;
    if (mine && mine.code) { roleByCode[mine.code] = 'kp'; atByCode[mine.code] = mine.at || 0; }
    var joined = (RS.listJoined && RS.listJoined()) || [];
    joined.forEach(function (j) {
      if (!j || !j.code) return;
      if (roleByCode[j.code] === undefined) roleByCode[j.code] = j.role || 'player';
      atByCode[j.code] = Math.max(atByCode[j.code] || 0, j.at || 0);
    });
    /* v2.13.5（用户报 Bug）：**已结团的房间不再进「回到游戏」**。
       根因：本机存档 / mine / joined 记录在结团后仍然留着（它们也是「游戏历史记录」的数据源），
       而这里没有像 listUnfinished() 那样排除归档过的 code → 正常结团回到房间页，
       最上方还挂着「回到游戏」按钮，点下去当然进不去。
       口径与 listUnfinished 保持一致：以归档表（archive）里的 code 为准。 */
    var archived = {};
    ((RS.listArchive && RS.listArchive()) || []).forEach(function (a) {
      if (a && a.code) archived[a.code] = true;
    });

    /* ② 有房间存档的候选里 savedAt 最新者（跳过已结团的） */
    var saves = (RS.listRoomSaves && RS.listRoomSaves()) || [];
    var bestSave = null;
    saves.forEach(function (s) {
      if (!s || !s.code || archived[s.code]) return;
      if (!bestSave || (s.savedAt || 0) > (bestSave.savedAt || 0)) bestSave = s;
    });
    if (bestSave) {
      return {
        code: bestSave.code,
        role: roleByCode[bestSave.code] || bestSave.role || 'player',
        live: false
      };
    }
    /* ③ 没有存档 → 退回 mine / joined 里 at 最新者 */
    var bestAt = -1, bestCode = null;
    Object.keys(atByCode).forEach(function (c) {
      if (archived[c]) return;                  /* 已结团 → 不算「可回到的游戏」 */
      if (atByCode[c] > bestAt) { bestAt = atByCode[c]; bestCode = c; }
    });
    if (!bestCode) return null;
    return { code: bestCode, role: roleByCode[bestCode] || 'player', live: false };
  }

  /**
   * v2.2.2（用户第 1 项）：进入 / 重连房间时**刷新本机 joined 记录的时间戳**，
   * 让 `at` 语义恢复为「最近一次真正进入本房」（而不是「首次加入」）。
   * 幂等：读出现有记录原样回写（setJoined 会覆盖同 code 记录并更新 at）。
   */
  function touchJoinedCode(code) {
    try {
      var RS = global.RoomStore;
      if (!RS || !code || typeof RS.getJoined !== 'function' || typeof RS.setJoined !== 'function') return;
      var rec = RS.getJoined(code);
      if (!rec) return;
      RS.setJoined({
        code: rec.code, mtoken: rec.mtoken, serverBase: rec.serverBase,
        role: rec.role, nickname: rec.nickname, name: rec.name, kpName: rec.kpName
      });
    } catch (e) { /* 存不下不影响对局 */ }
  }

  function renderEntry() {
    if (!sess) sess = null;
    /* v2.0.0（需求 §3）：离开游戏页 → 恢复竖屏（浏览器无桥时静默跳过） */
    restoreOrientation();
    var inv = N.inviteParams();

    /* v2.13.0：入口页挂一个纯样式钩子 room-skin —— 让「克苏鲁手账」主题
       也能覆盖这一屏（它跑在 App 外壳里，没有 .room-page 包裹）。
       只加类名，不改任何结构/文案/交互。 */
    var wrap = el('div.room-skin');
    wrap.appendChild(el('div.room-hero', null, [
      el('h2', { text: '跑团房间' }),
      el('p', { text: '和你的调查员一起开团：招募、聊天、掷骰、场景与战斗' })
    ]));

    /* v2.2.1（用户第 8 项）：**统一「回到游戏」入口** —— 房间号一律取自本机权威记录
       （活会话优先，其次本机记录里最近活动的房间），不再依赖地址栏 / 邀请参数里的号，
       从根上杜绝「点『回到游戏』却带着不一致的房间号、连不上」。
       被邀请进**新**房间（?room=）时不显示，避免抢走加入新房的入口。 */
    var auth = authoritativeRoom();
    if (auth && auth.code && auth.code !== inv.code) {
      wrap.appendChild(el('div.card.gp-rejoin', null, [
        el('div.card-head', null, [el('h3', { text: '回到游戏' })]),
        el('div.small.dim', {
          text: '本机记录里' + (auth.live ? '正在' : '有') + '进行的房间 ' + auth.code +
                '（' + (auth.role === 'kp' ? 'KP' : (auth.role === 'spectator' ? '旁观' : '玩家')) +
                '）。点下面一键回到房间，座位不变。'
        }),
        el('button.btn.primary.block', {
          text: '回到游戏（' + auth.code + '）', style: { marginTop: '10px' },
          onclick: function () { resumeRoomImpl(auth.code); }
        })
      ]));
    }

    // 被邀请进来的：先把「加入这个房间」放在最上面，别让人自己去找
    if (inv.code) {
      wrap.appendChild(inviteCard(inv));
    }

    wrap.appendChild(ruleCard());
    wrap.appendChild(lanCard());

    /* v2.11.9（用户第 8 项）：显示当前联机服务器是公网还是局域网，
       并说明「创建房间」会开在哪。浏览器不能自建服务，联机必走一台中继；
       局域网一体服（同源serve网页+中继）上，这里会显示「局域网」，
       「创建房间」即在局域网中继开团，同 WiFi 朋友打开这个地址即可进。 */
    var rs = (global.RoomNet && global.RoomNet.resolve) ? global.RoomNet.resolve() : { base: '', source: 'none' };
    var srvLabel = rs.source === 'origin'
      ? '🏠 局域网（本机同源）：' + rs.base
      : (rs.base ? '🌐 公网服务器：' + rs.base : '⚠️ 尚未配置联机服务器（设置里填一个）');
    /* v2.13.4（用户第 5 项）：原「房间服务」与「开始」两张卡**合并**成一张「公网房间」——
       上面是服务器（地址 / 检测 / 修改），下面就是在这台服务器上开房。去掉「开始」标题。 */
    var actions = el('div.card', null, [
      el('div.card-head', null, [
        el('h3', { text: '公网房间' }),
        el('span.hint', {
          text: rs.base
            ? (rs.source === 'injected'
                ? SOURCE_TEXT.injected
                : (SOURCE_TEXT[rs.source] + ' · ' + (N.isPrivateHost(rs.base) ? '局域网' : '公网')))
            : SOURCE_TEXT.none
        })
      ])
    ]);
    global.UI.append(actions, serviceCardBody());
    actions.appendChild(el('div.btn-group', { style: { marginTop: '12px' } }, [
      el('button.btn.primary.grow', { text: '创建房间（当 KP）', onclick: function () { createSheet(false); } }),
      el('button.btn.grow', { text: '加入房间', onclick: function () { joinSheet(inv.code, ''); } })
    ]));
    actions.appendChild(el('div.small', { style: { marginTop: '10px', fontWeight: 600 }, text: srvLabel }));
    actions.appendChild(el('div.tiny.dim', {
      style: { marginTop: '6px' },
      html: '「创建房间」会开在上面这台服务器。' +
            (rs.source === 'origin'
              ? '当前是<b>局域网模式</b>：朋友连同一 WiFi、用这个地址打开即可进你开的房，不走外网。'
              : '浏览器不能自己开局域网房，联机走上面这台服务器；想在纯局域网开团，用「局域网一体服」那台机器打开即可（见部署说明）。')
    }));
    wrap.appendChild(actions);

    var mine = S.getMine();
    if (mine) wrap.appendChild(resumeMineCard(mine));

    var joined = S.listJoined();
    if (joined.length) wrap.appendChild(recentCard(joined));

    /* v2.0.2：未完结的团（本地存档接线）+ 本机身份解绑入口 */
    wrap.appendChild(unfinishedCard());
    if (joined.length) wrap.appendChild(identityCard(joined));
    /* v2.11.8（用户需求）：「游戏历史记录」移到最下方，放在「未完结的团」下面 */
    wrap.appendChild(resumeArchiveCard());

    return wrap;
  }

  /**
   * v2.0.0（需求 §6「改天续玩」）：本机归档要有入口。
   *
   * RoomStore 早就把结团 / 挂起归档在本地了（listArchive），但**零调用** ——
   * 用户「上次那团还能回看吗」无处可点。v2.11.8 起此区块改名为「游戏历史记录」：
   * 它**只读回看**（成员 / 完整游戏记录 / 导出文档），不含续玩功能；
   * 续玩请走下方「未完结的团」。
   */
  function resumeArchiveCard() {
    var list = (S.listArchive && S.listArchive()) || [];
    if (!list.length) return el('div');   // 没有归档就不占位
    var card = el('div.card.gp-resume', null, [
      el('div.card-head', null, [
        el('h3', { text: '游戏历史记录' }),
        el('span.hint', { text: list.length + ' 个归档' })
      ]),
      el('div.tiny.dim', { text: '本机保存的跑团记录，点开可回看完整游戏记录，并支持导出为文档。' })
    ]);
    list.slice(0, 5).forEach(function (a) {
      card.appendChild(el('div.occ-item', null, [
        el('div.grow', null, [
          el('div.nm', { text: a.name || ('房间 ' + a.code) }),
          el('div.meta', { text: (a.kpName ? 'KP ' + a.kpName + ' · ' : '') +
            ((a.members || []).length) + ' 人 · ' + timeText(a.endedAt) })
        ]),
        el('button.btn.sm.ghost', {
          text: '详情', onclick: function () { archiveDetailSheet(a); }
        })
      ]));
    });
    return card;
  }

  /** 游戏记录时间戳：YYYY-MM-DD HH:MM:SS（导出/展示用，比 timeText 的 HH:MM 更完整） */
  function archiveLogTime(ts) {
    var d = new Date(ts || 0);
    function p(n) { return ('0' + n).slice(-2); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /** 一条游戏记录的执行者显示名：seat → 成员名 / KP / 系统 */
  function archiveLogActor(l, a) {
    var seat = l.seat || '';
    if (!seat) {
      if (l.kind === 'check' && l.redacted) return 'KP（暗骰）';
      if (l.kind === 'sys') return '系统';
      return '系统';
    }
    if (seat === 'host') return (a.kpName || 'KP');
    var map = {};
    (a.members || []).forEach(function (m) {
      if (m && m.seat) map[m.seat] = (m.nickname || '') || (m.charName || '') || ('座位' + m.seat);
    });
    return map[seat] || ('座位' + seat);
  }

  /** 把一条游戏记录格式化成「[时间] 执行者：内容」 */
  function archiveLogText(l, a) {
    var t = l.at ? archiveLogTime(l.at) : '';
    return (t ? ('[' + t + '] ') : '') + archiveLogActor(l, a) + '：' + (l.text || '');
  }

  /** v2.11.8（用户需求）：把一局的完整游戏记录导出为 txt 文档（含每条操作的执行者） */
  function exportArchiveText(a) {
    var logs = (a.logs || []);
    var lines = [];
    lines.push('跑团游戏历史记录');
    lines.push('================================');
    lines.push('房间：' + (a.name || ('房间 ' + a.code)) + '（房间号 ' + a.code + '）');
    lines.push('KP：' + (a.kpName || '—'));
    lines.push('结束时间：' + (a.endedAt ? archiveLogTime(a.endedAt) : '—'));
    lines.push('成员：' + ((a.members || []).map(function (m) {
      return (m.nickname || '?') + (m.charName ? '（' + m.charName + '）' : '');
    }).join('、') || '无'));
    lines.push('');
    lines.push('游戏记录（共 ' + logs.length + ' 条）');
    lines.push('--------------------------------');
    if (!logs.length) {
      lines.push('（该团没有游戏记录）');
    } else {
      logs.forEach(function (l, i) {
        lines.push((i + 1) + '. [' + (l.at ? archiveLogTime(l.at) : '') + '] ' +
          archiveLogActor(l, a) + '：' + (l.text || ''));
      });
    }
    var text = lines.join('\n');
    var safeName = (a.name || ('房间' + a.code)).replace(/[\\/:*?"<>|]/g, '_');
    var fname = '游戏历史记录-' + safeName + '-' + a.code + '.txt';
    var ok = global.UI.saveFile(fname, text, 'text');
    if (ok) global.UI.toast('已导出 ' + logs.length + ' 条记录', 'ok');
  }

  /** 归档详情：只读回看（成员 / 完整游戏记录 / 导出） */
  function archiveDetailSheet(a) {
    var logs = (a.logs || []);
    var body = el('div', null, [
      el('div.card-title', { text: a.name || ('房间 ' + a.code) }),
      el('div.tiny.dim', { text: '房间号 ' + a.code + ' · KP ' + (a.kpName || '—') +
        ' · 结束于 ' + timeText(a.endedAt) }),
      el('div.small', { style: { marginTop: '8px' },
        text: '成员：' + ((a.members || []).map(function (m) {
          return (m.nickname || '?') + (m.charName ? '（' + m.charName + '）' : '');
        }).join('、') || '无') })
    ]);
    /* v2.11.8（用户需求）：顶部操作条 —— 记录条数 + 导出文档按钮 */
    body.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px',
      marginTop: '10px', marginBottom: '4px' } }, [
      el('span.hint', { text: '游戏记录 ' + logs.length + ' 条' }),
      el('button.btn.sm.primary', { text: '⬇ 导出文档', onclick: function () { exportArchiveText(a); } })
    ]));
    body.appendChild(el('div.tiny.dim', { text: '完整记录如下（含每条操作的执行者）：' }));
    if (!logs.length) {
      body.appendChild(el('div.room-log-empty', { text: '（该团没有游戏记录）' }));
    } else {
      logs.forEach(function (l) {
        body.appendChild(el('div.small', { style: { marginTop: '4px' },
          text: '· ' + archiveLogText(l, a) }));
      });
    }
    global.UI.sheet({ title: (a.name || ('房间 ' + a.code)) + ' · 游戏历史记录', body: body });
  }

  /**
   * v2.0.2 T5（断点3接线）：本机「未完结的团」入口。
   * RoomStore.listUnfinished() 早就写好了但**零调用** —— 用户「上次那团还能接着玩吗」
   * 无处可点。这里给一个可点进去继续的列表：KP 走 hostToken 续玩；玩家走本机凭据重连。
   */
  function unfinishedCard() {
    var list = (S.listUnfinished && S.listUnfinished()) || [];
    if (!list.length) return el('div');
    var card = el('div.card.gp-unfinished', null, [
      el('div.card-head', null, [
        el('h3', { text: '未完结的团' }),
        el('span.hint', { text: list.length + ' 个' })
      ]),
      el('div.tiny.dim', {
        text: '本机记录里还没结团的房间，点「继续」回到房间（游戏进行中会直接回到游戏页）。'
      })
    ]);
    list.slice(0, 5).forEach(function (r) {
      card.appendChild(el('div.occ-item', null, [
        el('div.grow', null, [
          el('div.nm', { text: r.name || ('房间 ' + r.code) }),
          el('div.meta', { text: (r.role === 'kp' ? 'KP' : (r.role === 'spectator' ? '旁观' : '玩家')) +
            (r.hasSave ? (' · 存档 seq ' + (r.seq || 0)) : '') })
        ]),
        el('button.btn.sm.primary', {
          text: '继续', onclick: function () { resumeRoomImpl(r.code); }
        })
      ]));
    });
    return card;
  }

  /**
   * v2.0.2 T4（用户明确要求的「解绑入口」）：本机设备身份解绑。
   * 「设备码即身份」是设计取舍 —— 同设备换人会被当成同一个座位。因此必须给一个
   * 显式的「解绑本机身份」入口：清除后本机被当作新玩家，下次加入会分配新座位。
   * 二次确认（不可撤销 + 会丢掉当前座位 / 准备状态 / 角色卡绑定）。
   */
  function identityCard(joined) {
    var card = el('div.card.gp-identity', null, [
      el('div.card-head', null, [el('h3', { text: '本机身份绑定' })]),
      el('div.tiny.dim', {
        text: '本机在下面的房间里已绑定为一个座位（同一台设备会被认作同一个人）。' +
              '换人用同一台设备时，可在此解绑。'
      })
    ]);
    joined.slice(0, 5).forEach(function (r) {
      card.appendChild(el('div.occ-item', null, [
        el('div.grow', null, [el('div.nm', { text: r.name || ('房间 ' + r.code) })]),
        el('button.btn.sm.ghost', {
          text: '解绑本机身份',
          onclick: function () { unbindDevice(r.code); }
        })
      ]));
    });
    return card;
  }

  /** 解绑二次确认：文案必须让用户明白后果（与设计 §1.3.2 / 用户要求一致）。 */
  function unbindDevice(code) {
    global.UI.confirm(
      '解绑本机在这个房间的身份？\n清除后本机将被视为新玩家，下次加入会分配新座位' +
      '（当前的准备状态与角色卡绑定不会保留）。',
      { danger: true, okText: '解绑', cancelText: '取消' }
    ).then(function (ok) {
      if (!ok) return;
      N.unbind(code).then(function () {
        global.UI.toast('已解绑本机身份', 'ok');
      }, function (e) {
        global.UI.toast('解绑失败：' + ((e && e.message) || e), 'err');
      });
    });
  }

  /**
   * v2.0.2 T5（断点4修复）：真正的「续玩」实现。
   * room-panels.js#resumeSheet 早就在调 RoomUI.resumeRoom(code)，但导出块里**没有**它
   * （一直是死引用 → 退化成 ctx.act({op:'room.resume'})）。按本机记录判身份：
   *   · 我开的房（有 hostToken）→ 可选先载入指定存档槽，再以房主身份重连并 resume()；
   *   · 我加入过的房（有 mtoken）→ reopenJoined（连上后 SYNC 自动补齐）。
   */
  function resumeRoomImpl(code, saveId) {
    if (!code) return;
    var mine = S.getMine();
    if (mine && mine.code === code) {
      var start = function () {
        resumeMine(mine);
        /* v2.13.6：以房主身份重连后，从服务端**拉回存档**（adoptSave → 广播全量），
           否则空的 Host 会把服务端的好存档覆盖掉（v2.0.0 既有路径）。
           ⚠️ 不再无脑调 side.resume()：那个会 POST /resume 把房间刷成 RECRUITING，
           进行中的局被重置成招募中。只有存档里确实是「已挂起」才需要复活它。 */
        var side = sess && sess.side;
        if (!side || !side.adoptServerState) return;
        side.adoptServerState().then(function (ok) {
          var meta = (side.host && side.host.state && side.host.state.meta) || {};
          if (ok && meta.status === T2.STATUS.SUSPENDED && side.resume) side.resume();
          if (sess) paint(true);
        });
      };
      if (saveId) {
        N.loadSave(code, mine.hostToken, saveId).then(start, function (e) {
          global.UI.toast('载入存档失败：' + ((e && e.message) || e), 'err');
          start();
        });
      } else {
        start();
      }
      return;
    }
    var rec = S.getJoined(code);
    if (rec) { reopenJoined(rec); return; }
    /* v2.2.1（用户第 8 项）：拿到的号在本机既不是「我开的」也不是「我加入过的」——
       但本机记录里确实有一个正在进行的房间时，**以本机权威记录为准**再去续玩一次，
       而不是直接报「无法续玩」（这正是「回到游戏」拿错号就断的根因）。 */
    var auth = authoritativeRoom();
    if (auth && auth.code && auth.code !== code) { resumeRoomImpl(auth.code); return; }
    global.UI.toast('本机没有这个房间的记录，无法续玩', 'err');
  }

  function inviteCard(inv) {
    var nick = el('input.input', { type: 'text', placeholder: '你的名字（例如：小明）', value: '' });
    return el('div.card.invite-card', null, [
      el('div.card-title', { text: '有人邀请你加入房间' }),
      el('div.room-code.big', { text: inv.code }),
      inv.serverBase
        ? el('div.tiny.dim', { text: '房间服务：' + inv.serverBase })
        : el('div.tiny.dim', { text: '未指定房间服务地址，将使用你设置里的地址' }),
      el('div.field', { style: { marginTop: '10px' } }, [nick]),
      el('button.btn.primary.block', {
        text: '加入这个房间',
        onclick: function () {
          joinSheet(inv.code, nick.value);
        }
      })
    ]);
  }

  function ruleCard() {
    var card = el('div.card', null, [el('div.card-head', null, [el('h3', { text: '选择规则系统' })])]);
    card.appendChild(el('button.rule-card.on', {
      onclick: function () { global.UI.toast('当前房间仅支持克苏鲁的呼唤第七版', 'ok'); },
      html: '<div class="ic">🦑</div><div class="grow"><div class="t">克苏鲁的呼唤 第七版</div>' +
            '<div class="d">COC 7th · 已开放</div></div><div style="color:var(--gold);font-size:18px">→</div>'
    }));
    // 需求：本期只开放 CoC 7e，其余一律置灰（不许「看着能点、点了不能用」）
    el('div.tiny.muted', { text: '未来预留', style: { margin: '12px 0 7px', letterSpacing: '.08em' } });
    card.appendChild(el('div', null, (global.RuleRegistry.placeholders || []).map(function (p) {
      return el('button.rule-card.off', {
        disabled: true,
        html: '<div class="ic">🔒</div><div class="grow"><div class="t">' + global.UI.esc(p.name) + '</div>' +
              '<div class="d">' + global.UI.esc(p.shortName) + ' · 尚未开放</div></div>'
      });
    })));
    return card;
  }

  /* ---------- 房间服务 ---------- */

  /**
   * 生效地址的来源说法。写在卡片上，省得用户猜「为什么我填的地址没生效」。
   * 注意 'injected' 有两个来源：本机开的服务，或刚加入的局域网房间 ——
   * 两者都是「临时地址」，措辞要能同时覆盖，不能写成「本机服务器」（会误导）。
   */
  var SOURCE_TEXT = {
    invite: '来自邀请链接',
    injected: '局域网直连',
    user: '你设置的服务器',
    preset: 'App 预置',
    /* v2.11.9 加了 origin 源（局域网一体服同源）却漏了这张表 →
       大厅显示「undefined · 局域网」。v2.12.2 补上。 */
    origin: '本机同源（局域网一体服）',
    none: '未配置'
  };

  /**
   * 连不上时给一句「下一步该做什么」。
   *
   * 目的：把「连不上」变成可行动的信息。三种原因（地址不对 / 超时 / 网络不通）
   * 的修法完全不同，只报一句「连不上」用户说不清、我们也定位不了 ——
   * 这个 bug 就是这么来的：设置里填了公网地址，实际测的却是局域网地址。
   */
  function probeHint(e, r) {
    var code = (e && e.code) || '';
    var isLan = N.isPrivateHost((e && e.base) || r.base);
    if (code === 'timeout') {
      return isLan
        ? '局域网地址没响应：确认房主的手机还开着房间、你们连的是同一个 WiFi。'
        : '公网地址超时：确认服务已启动、域名能解析（换手机流量再试一次即可区分是不是网络问题）。';
    }
    if (code === 'network') {
      return isLan
        ? '连不到这个局域网地址。三种可能，点下面的「局域网自检」能直接查出是哪一种：' +
          '① 你和房主不在同一个 WiFi；② 路由器开了「AP 隔离」（同一 WiFi 也互相看不见）；' +
          '③ 房主手机上服务没起来。'
        : '连不到这个域名：先在手机浏览器里打开 &lt;该地址&gt;/health 试一下。';
    }
    if (e && e.status) return '服务能连上，但它拒绝了这次请求（HTTP ' + e.status + '）。';
    return '';
  }

  /* 地址来源 → 一句人话。和 serviceCard 的表同源，但那边还要拼「局域网/公网」后缀。 */
  function sourceText(src) {
    return SOURCE_TEXT[src] || SOURCE_TEXT.none;
  }

  /**
   * 开房/加入失败时，弹一个**带诊断信息**的层，而不是一句 toast 了事。
   *
   * 为什么必须这样：用户报的是「连不上 https://…/room：连接超时（5 秒内没有响应）」
   * 和「无法连接(域名解析失败/不在同一网络/服务未启动)」—— 两句话来自同一个 catch，
   * 却指向完全不同的两件事（一个公网 DNS/TLS/防火墙，一个局域网 AP 隔离/不同网段）。
   * 光看现象分不出来，是因为界面从没告诉用户「刚才其实连的是哪个地址」。
   *
   * 这里把三件事一次说清：
   *   ① 试的是哪个地址 ② 该地址是「邀请链接/局域网注入/你填的/打包预置」哪来的
   *   ③ 下一步怎么办（含「停用局域网直连」这个逃生入口）
   */
  function showConnectError(e, r, lan) {
    var tried = (e && e.base) || r.base || '(未配置)';
    var isLan = N.isPrivateHost(tried);
    var hint = probeHint(e, r);
    var usr = N.userBase();

    var rows = [
      el('div.small', {
        html: '试的是 <code>' + global.UI.esc(tried) + '</code>' +
              '（' + global.UI.esc(sourceText(r.source)) + ' · ' +
              (isLan ? '局域网地址' : '公网地址') + '）'
      })
    ];
    /* 局域网目标：先亮出「我自己的 IP / 网段」，不同网段当场点名
       （用户实测最大的困惑就是「我到底连没连上房主的 WiFi」）。 */
    if (isLan) rows.push(ownIpLine(tried));

    /* 配了多个候选地址时，把「一共试过哪些」摊开。
       只报主地址会让用户以为程序没试备用地址，而去反复改主地址。 */
    var triedAll = (e && e.triedAll) || [];
    if (triedAll.length > 1) {
      rows.push(el('div.small.dim', {
        style: { marginTop: '6px' },
        html: '备用地址也试过了：' +
              triedAll.map(function (b) { return '<code>' + global.UI.esc(b) + '</code>'; }).join('、')
      }));
    }

    if (lan && r.source !== 'injected') {
      /* 「用本机开房」却没走到注入地址上 —— 说明内嵌服务没起来。
         这是最常见的局域网失败原因，且明确可查。 */
      rows.push(el('div.notice.warn', { style: { marginTop: '10px' } }, [
        el('span', {
          html: '你以为在走局域网，但当前生效的不是本机地址。<br>' +
                '多半是内嵌房间服务没启动成功（没连 WiFi？端口被占？）。'
        })
      ]));
    }

    /* 局域网失败**必须**给「局域网自检」，而不是公网的「网络自检」。
       公网自检会去比 /health、比建房 —— 对一个 192.168.x.x 地址毫无意义
       （localhost 上没有那个域名要解析、也没有跨境链路），只会再输出一遍
       「解析/连接失败」，把用户绕回原点。 */
    if (isLan || r.source === 'injected') {
      rows.push(el('button.btn.primary.sm.block', {
        style: { marginTop: '10px' },
        text: '🔎 局域网自检（查清同伴为什么连不上）',
        onclick: function () { sheet.close(); lanCheckSheet(); }
      }));
    }

    /* 注入的局域网地址盖过用户设置的公网地址 —— 这是设计如此（见 room-net.js#base），
       但用户必须能看到、并且能一键切回去，否则就成了「填了公网地址也没用」。 */
    if (r.source === 'injected' && usr) {
      rows.push(el('div.notice.warn', { style: { marginTop: '10px' } }, [
        el('span', {
          html: '当前生效的是<b>局域网直连地址</b>，它盖过了你设置的 <code>' +
                global.UI.esc(usr) + '</code>。'
        })
      ]));
      rows.push(el('button.btn.sm.block', {
        text: '⏹ 停用局域网直连（改用你设置的服务器）',
        onclick: function () { sheet.close(); stopLanNow(); }
      }));
    }

    if (hint) {
      rows.push(el('div.tiny.dim', { style: { marginTop: '10px' }, text: hint }));
    }

    rows.push(el('div.btn-group', { style: { marginTop: '12px' } }, [
      el('button.btn.grow', {
        /* 局域网地址上「网络自检」是无效的（它探的是公网域名的路径与跨境链路），
           所以这里按地址类型换成对应那一套。 */
        text: isLan ? '局域网自检' : '网络自检',
        onclick: function () {
          sheet.close();
          if (isLan) lanCheckSheet(); else selfCheckSheet();
        }
      }),
      el('button.btn.grow', {
        text: isLan ? '关闭服务器' : '修改地址',
        onclick: function () { sheet.close(); if (isLan) stopLanNow(); else roomBaseSheet(); }
      })
    ]));

    var sheet = global.UI.sheet({
      title: '连不上房间服务',
      body: el('div', null, rows)
    });
  }

  /**
   * 「网络自检」：在**用户自己的手机上**把整条链路跑一遍，并给出可截图的结论。
   *
   * 为什么非做不可：用户报「公网开房连不上」，而我们这边从桌面测
   * `/health` 200、CORS 预检 204、`POST /api/rooms` 真的建出了房间 ——
   * 服务器、证书、CORS 全是好的。唯一能看到的异常是 Cloudflare 的边缘节点在海外
   * （`cf-ray: …-AMS`），对国内手机来说这条跨境链路本身就可能不通或被限速。
   * 这个我们**在本地无法复现**，只能把探测点移到用户的手机上。
   *
   * 自检依次回答四个问题（全部答完，不因上一步失败就跳过）：
   *   ① 地址配的是什么、从哪来
   *   ② 每个候选地址的 /health 能不能通、多少毫秒
   *   ③ 能不能真的建出一个房间（GET 通、POST 被反代挡住是常见坑）
   *   ④ 结论 + 下一步
   */
  function selfCheckSheet() {
    var body = el('div', null, [
      el('div.tiny.dim', { text: '正在你当前的网络下检测房间服务…' })
    ]);
    var foot = el('div.btn-group', { style: { marginTop: '12px' } });
    body.appendChild(foot);
    var s = global.UI.sheet({ title: '网络自检', body: body });

    function line(ok, name, text) {
      return el('div.small', { style: { marginTop: '8px' } }, [
        el('span', {
          style: { color: ok ? 'var(--ok)' : 'var(--err)', fontWeight: '600' },
          text: ok ? '✓ ' : '✗ '
        }),
        el('span', { text: name }),
        el('div.tiny.dim', { style: { marginTop: '2px' }, text: text || '' })
      ]);
    }

    N.selfCheck().then(function (res) {
      /* ⚠️ clear(body) 会把之前挂进去的 foot 一起清掉。
         所以 foot 必须**在 clear 之后**重新挂回来 —— 否则按钮永远不出现，
         而这个按钮正是「把结论发给我们」的唯一入口（§2.3 不许假入口）。 */
      global.UI.clear(body);
      res.steps.forEach(function (st) {
        body.appendChild(line(st.ok, st.name, st.text));
      });

      var verdictEl = el('div.notice' + (res.ok ? '.ok' : '.warn'), { style: { marginTop: '12px' } });
      verdictEl.appendChild(el('span', { html: verdictText(res) }));
      body.appendChild(verdictEl);

      global.UI.clear(foot);
      foot.appendChild(el('button.btn.grow', {
        text: '复制结论', onclick: function () {
          var txt = res.steps.map(function (st) {
            return (st.ok ? '[OK] ' : '[FAIL] ') + st.name + ' — ' + st.text;
          }).join('\n');
          /* 复用分享模块的 copy：它已经处理了安卓桥 / navigator.clipboard /
             execCommand 三条路径，也自带提示，不要再写第二份。 */
          if (global.Share && global.Share.copy) global.Share.copy(txt);
          else global.UI.toast('请截图这一页发给我们', 'ok');
        }
      }));
      foot.appendChild(el('button.btn.ghost.grow', {
        text: '关闭', onclick: function () { s.close(); }
      }));
      body.appendChild(foot);        // clear(body) 之后必须重新挂回来，见上面的注释
    }, function (e) {
      global.UI.clear(body);
      body.appendChild(banner('自检异常：' + ((e && e.message) || e), 'err'));
    });
  }

  /** 把自检结果翻译成一句「你该做什么」 */
  function verdictText(res) {
    if (!res.ok) {
      /* 三种失败必须分开说 —— 它们的修法完全不同，混成一句话就是在骗用户：
         · timeout     → 链路可能是通的，只是慢/被限速（跨境常见）
         · http 4xx/5xx→ 服务**答了**，只是这一层不满意（路径写错 / 服务端故障）
         · network     → 连都没连上（域名解析不了 / 服务没起 / 完全不通）
         以前这里只分「超时」和「其它」，于是 404 会被说成
         「域名可能解析不了」—— 而 404 恰恰证明域名解析**是**成功的。 */
      var probes = res.steps.filter(function (st) {
        return st.name && st.name.indexOf('连通 ') === 0;
      });
      function allCode(c) {
        return probes.length > 0 && probes.every(function (st) { return st.ok || st.code === c; });
      }
      var t = '全部地址都连不上。<br>';

      if (allCode('timeout')) {
        t += '每个地址都是<b>超时</b>——服务器是活的（我们这边测得到），' +
             '所以问题在<b>你这台手机到这个域名之间的链路</b>：' +
             '多半是跨境被限速/拦截，或者你当前用的流量运营商把这台服务器挡了。<br>' +
             '👉 换一个 WiFi（或换成手机流量）再自检一次，结果会不同。<br>' +
             '👉 如果两种网络都不通，需要在<b>国内能直连的服务器</b>上再部署一份房间服务，' +
             '把地址填进「设置 → 房间服务地址」。';
      } else if (allCode('http')) {
        t += '服务<b>答了</b>，但回的是错误码 —— 也就是说<b>域名和网络是通的</b>，' +
             '问题在地址路径或服务端本身。<br>' +
             '👉 检查地址是否多写/少写了 <code>/room</code> 这一段。' +
             '例如服务装在 <code>https://x.example/room</code>，' +
             '填 <code>https://x.example</code> 就会 404。<br>' +
             '👉 路径确认无误就把上面的结论发我们，需要看服务端日志。';
      } else {
        t += '每个地址都是<b>解析/连接失败</b>——域名可能解析不了，或者服务没在跑。<br>' +
             '👉 先在手机浏览器里直接打开 <code>该地址/health</code>：' +
             '能看到一段 JSON 就说明浏览器能通（那是 App 的问题）；打不开就是网络/服务的问题。';
      }
      return t;
    }
    var post = res.steps.filter(function (st) { return st.name === '建房能力'; })[0];
    if (post && !post.ok) {
      /* ⚠️ 这一支是「GET 通了、POST 没通」，**绝大多数情况不是网络问题**。
         最典型的两种：
           · 直连源站是明文 http，被安卓的明文策略掐断（POST 和 GET 一样会被掐，
             但如果只挡了某一条路径，就会出现这种「一半通」的怪象）；
           · 反向代理只放行了 GET，把 POST 挡在外面。
         所以文案必须先把「网络是通的」这件事说清楚，别让用户继续折腾 DNS。 */
      return '服务<b>能连上</b>（/health 通过了），但<b>创建房间没成功</b>。<br>' +
             '这说明<b>域名解析和网络都是好的</b> —— 问题在服务端这一环，' +
             '或者被某个中间层（反向代理 / 明文策略）单挡了 POST。<br>' +
             '👉 把上面的结论发给我们，需要看服务端日志；' +
             '如果是自建的服务器，先确认反向代理允许 POST。<br>' +
             '👉 同时可以点「局域网自检」用局域网先开团（那条路不经过服务器）。';
    }
    return '链路完全正常：能连上、也能创建房间。<br>' +
           (res.cleanupFailed
             ? '（自检试建的房间没关掉，房间号 <code>' + global.UI.esc(res.cleanupFailed) +
               '</code>，过一阵会自动过期。）<br>'
             : '') +
           '如果这时开房还失败，问题不在网络，请把上面的结论发给我们。';
  }

  /**
   * 「局域网自检」：只在房主这台手机上跑，回答「同伴为什么连不上我」。
   *
   * 和「网络自检」分开，是因为两种链路的问题**完全不同**：
   *   · 网络自检问的是「我能不能连上那台公网服务器」（域名 / 跨境 / TLS）
   *   · 局域网自检问的是「我这台手机上服务活着吗、同伴能不能走过来」（WiFi / AP 隔离）
   * 把它们合成一个按钮，用户会拿着公网的结论去排查局域网，永远排不出来。
   */
  /**
   * 本机 IP 信息行（v1.18.5）：自检与报错弹层里都要亮出「我自己的 IP」。
   *
   * 为什么必须有：玩家侧 7ms 秒失败时，最大的疑问是「我和房主在不在同一个网」
   * —— 而旧的自检只报目标地址，不报自己的，用户根本无从判断。
   * 用安卓桥的 lanIp()（枚举网卡，不需要服务在跑）；不在 App 里就拿不到，
   * 如实说明。网段和目标不一致时直接点名。
   */
  function ownIpLine(targetBase) {
    var L = global.RoomLan;
    var ip = (L && L.ip) ? L.ip() : '';
    if (!ip) {
      return el('div.tiny.dim', { style: { marginBottom: '6px' },
        text: '本机 IP：拿不到（只在安卓 App 里可读；若手机用的是流量，这里也会是空的）' });
    }
    var tSub = subnetOf(targetBase);
    var mSub = subnetOf(ip);
    var same = tSub && mSub && tSub === mSub;
    if (tSub && !same) {
      return el('div.notice.warn', { style: { marginBottom: '8px' } }, [
        el('span', { html: '本机 IP 是 <b>' + global.UI.esc(ip) + '</b>，和目标 <b>' +
          global.UI.esc(tSub) + '.x</b> <b>不在同一个网段</b> —— 多半是没连上房主的 WiFi' +
          '（或手机在用流量）。先连同一个 WiFi 再试。' })
      ]);
    }
    return el('div.tiny.dim', { style: { marginBottom: '6px' },
      text: '本机 IP：' + ip + (same ? '（与目标同网段 ✓）' : '') });
  }

  /** 取点分十进制 IP 的前三段（网段近似）；不是 IP 形态就返回空串。
      ⚠️ 入参可能是「http://192.168.x.y:4211」也可能是裸的「192.168.x.y」
      （lanIp() 返回的就是裸 IP）—— 先剥协议再匹配，否则裸 IP 永远取不到
      网段，对比恒为「不在同一网段」（测试当场抓住的）。 */
  function subnetOf(base) {
    var v = String(base || '').replace(/^https?:\/\//i, '');
    var m = /^(\d+\.\d+\.\d+)\.\d+(?::\d+)?$/.exec(v);
    return m ? m[1] : '';
  }

  function lanCheckSheet() {
    var L = global.RoomLan;
    var inj = L && L.injected ? L.injected() : '';
    var body = el('div', null, [
      ownIpLine(inj),
      el('div.tiny.dim', { text: '正在你本机上检测局域网服务…' })
    ]);
    var foot = el('div.btn-group', { style: { marginTop: '12px' } });
    body.appendChild(foot);
    var s = global.UI.sheet({ title: '局域网自检', body: body });

    function line(ok, name, text) {
      return el('div.small', { style: { marginTop: '8px' } }, [
        el('span', {
          style: { color: ok ? 'var(--ok)' : 'var(--err)', fontWeight: '600' },
          text: ok ? '✓ ' : '✗ '
        }),
        el('span', { text: name }),
        el('div.tiny.dim', { style: { marginTop: '2px' }, text: text || '' })
      ]);
    }

    N.lanDiagnose(inj).then(function (res) {
      global.UI.clear(body);
      res.steps.forEach(function (st) { body.appendChild(line(st.ok, st.name, st.text)); });

      var verdictEl = el('div.notice' + (res.ok ? '.ok' : '.warn'), { style: { marginTop: '12px' } });
      verdictEl.appendChild(el('span', { html: lanVerdictText(res) }));
      body.appendChild(verdictEl);

      global.UI.clear(foot);
      foot.appendChild(el('button.btn.grow', {
        text: '复制结论', onclick: function () {
          var txt = '【局域网自检】\n' + res.steps.map(function (st) {
            return (st.ok ? '[OK] ' : '[FAIL] ') + st.name + ' — ' + st.text;
          }).join('\n') + '\n判读：' + (res.verdict || '?');
          if (global.Share && global.Share.copy) global.Share.copy(txt);
          else global.UI.toast('请截图这一页发给我们', 'ok');
        }
      }));
      foot.appendChild(el('button.btn.ghost.grow', {
        text: '关闭', onclick: function () { s.close(); }
      }));
      body.appendChild(foot);      // 同 selfCheckSheet：clear(body) 后必须重挂
    }, function (e) {
      global.UI.clear(body);
      body.appendChild(banner('自检异常：' + ((e && e.message) || e), 'err'));
    });
  }

  /** 局域网自检 → 一句「你该做什么」。每种判读各自对应一个确定动作。 */
  function lanVerdictText(res) {
    /* 诚实兜底：网络层不通时，应用**无法**绕过，别给用户假承诺。 */
    var NET_HONEST = '<br>⚠️ 若两台设备在网络层就不通（例如路由器开了 <b>AP 隔离</b>），' +
                     '应用<b>无法绕过</b>——建议改用<b>公网开房</b>（走服务器，不要求同 WiFi）。';
    if (res.verdict === 'lan-ok') {
      return '本机服务是好的，这个地址也连得上 —— <b>你这边没问题</b>。<br>' +
             '👉 让同伴也连同一个 WiFi，用「搜索周围房间」进；' +
             '如果同伴还是连不上，问题在他那边的网络（见下）。';
    }
    if (res.verdict === 'lan-mixed-blocked') {
      /* 回归哨兵：命中即给确定结论，不再让用户去猜「三种可能」。
         详见 room-net.js#isMixedContentBlocked。 */
      return '当前安装包的 WebView <b>仍在拦截明文请求</b>' +
             '（页面是 https，向 http 局域网地址的请求在本地被瞬时掐断）。<br>' +
             '这不是你的网络问题。<br>' +
             '👉 <b>请升级到最新版本</b>（新版已放开局域网明文）。';
    }
    if (res.verdict === 'lan-blocked') {
      /* 最有价值的一条：服务活着，但这个局域网 IP 走不通。
         回环通而 IP 不通 → 不是「服务没起」，是「这条路被挡了」。 */
      /* v1.18.4：这一支的成因变了，文案必须跟着改。
         旧文案说「网段不在放行白名单里」—— 那是因为 v1.18.3 的
         network_security_config 用 `<domain>` 列 IP 段，而 `<domain>`
         只做主机名匹配、根本匹配不到 192.168.x.y，于是被系统掐断。
         现在改为全局放开明文，那一类拦截**已经不存在了**。
         还留着旧文案的话，用户会去查「我的网段在不在名单里」，
         而这个问题现在没有意义 —— 等于指错路（需求 §2.3）。 */
      return '本机服务<b>是活着的</b>（回环地址能通），但<b>这个局域网地址走不通</b>。<br>' +
             '明文拦截这一类已经在 v1.18.4 修掉了，所以现在只剩两种可能：<br>' +
             '① <b>手机开着 VPN / 代理</b>，把局域网流量也劫走了 —— 关掉 VPN 再点一次「用本机开房」；<br>' +
             '② 这个地址<b>不是本机当前的 IP</b>（比如刚换过 WiFi / 热点重连过）' +
             ' —— 点「⏹ 关闭服务器」再重新「用本机开房」，让它重新取一次地址。' +
             NET_HONEST;
    }
    if (res.verdict === 'lan-timeout') {
      return '探测<b>超时</b>了。<br>' +
             '👉 先点「⏹ 关闭服务器」再重新「用本机开房」一次（端口 4211 可能被别的应用占着）。<br>' +
             '👉 还是超时就关掉 VPN、换一个 WiFi 再试。' + NET_HONEST;
    }
    if (res.verdict === 'lan-down') {
      return '本机局域网服务<b>还没启动</b>。<br>👉 先点「📡 用本机开房」把服务跑起来，再回来自检。';
    }
    /* lan-dead：两探全废。必须如实说出歧义 —— 见 room-net.js#lanDiagnose 的注释。 */
    return '两个地址都连不上。<br>' +
           '这一条有<b>两种可能，从手机内部无法区分</b>：<br>' +
           '① 服务其实没起来（点「用本机开房」时静默失败了）；<br>' +
           '② 服务活着，但这个地址<b>从本机就走不通</b>（VPN 劫持 / 换过 WiFi 地址已失效）。<br>' +
           '明文被系统拦截这一类已在 v1.18.4 修掉，不用再查白名单。<br>' +
           '👉 先点「⏹ 关闭服务器」再重新「用本机开房」；' +
           '仍然如此，请把上面的结论发我们，需要看系统日志确认是哪一种。' + NET_HONEST;
  }

  /**
   * v2.13.4（用户第 5 项）：原「房间服务」卡的内容，抽成一个**节点数组**，
   * 由首页合并卡（标题「公网房间」）直接拼进去 —— 服务器配置和开房入口本就是一件事，
   * 拆成两张卡反而让人以为「开始」跟上面那台服务器无关。
   */
  function serviceCardBody() {
    var r = N.resolve();
    var base = r.base;
    var kids = [];

    if (!base) {
      kids.push(el('div.tiny.dim', {
        html: '还没有配置房间服务地址。<br>' +
              '· <b>局域网开团</b>：由房主的手机创建房间，邀请链接里会自动带上地址，谁都不用配；<br>' +
              '· <b>公网开团</b>：把你的房间服务地址填进来（或者直接点别人发来的邀请链接）。'
      }));
      kids.push(el('button.btn.sm.block', { text: '填写房间服务地址', onclick: roomBaseSheet }));
      return kids;
    }

    kids.push(el('div.small.dim', { text: base }));
    if (N.baseCount && N.baseCount() > 1) {
      kids.push(el('div.tiny.dim', {
        text: '已配置 ' + N.baseCount() + ' 个候选地址，主地址不通会自动换下一个。'
      }));
    }

    /* 探测结果写在卡片里，而不是只弹一个 toast：
       toast 一消失就没人记得「刚才测的到底是哪个地址」，而这正是这次问题的关键。 */
    var probeEl = el('div');
    kids.push(probeEl);

    kids.push(el('div.btn-group', { style: { marginTop: '10px' } }, [
      el('button.btn.sm.grow', {
        text: '检测连通性',
        onclick: function () {
          var btn = this;
          btn.disabled = true; btn.textContent = '检测中…';
          global.UI.clear(probeEl);
          N.health().then(function (j) {
            global.UI.clear(probeEl);
            probeEl.appendChild(banner('服务正常（' + (j.service || 'coc-room') + '）· ' + base, 'ok'));
          }, function (e) {
            global.UI.clear(probeEl);
            probeEl.appendChild(banner(
              '连不上 ' + ((e && e.base) || base) + '：' + ((e && e.message) || e), 'err'));
            var hint = probeHint(e, r);
            if (hint) {
              probeEl.appendChild(el('div.tiny.dim', { style: { marginTop: '6px' }, text: hint }));
            }
          }).then(function () { btn.disabled = false; btn.textContent = '检测连通性'; });
        }
      }),
      el('button.btn.sm.grow', { text: '网络自检', onclick: selfCheckSheet }),
      el('button.btn.sm.grow', { text: '修改地址', onclick: roomBaseSheet })
    ]));

    /* ⚠️ 这一段是本次修复的核心。
       本机局域网服务器运行时，它注入的地址**盖过**用户在设置里填的地址。
       以前界面对此一字不提，于是「设置里填了公网地址 → 检测连通性却测的是局域网地址」
       看起来就是「填了没用 / 连不上」，而且没有任何入口能切回去。 */
    if (r.source === 'injected') {
      var usr = N.userBase();
      kids.push(el('div.notice.warn', { style: { marginTop: '10px' } }, [
        el('span', {
          html: '现在生效的是<b>局域网直连地址</b>（本机开的服务器，或你刚加入的局域网房间）。' +
                '它会盖过设置里的服务器地址' +
                (usr ? ('，所以你设置的 <code>' + global.UI.esc(usr) + '</code> 暂时<b>不生效</b>。')
                     : '。你还没有设置公网服务器地址。')
        })
      ]));
      kids.push(el('button.btn.sm.block', {
        text: '⏹ 停用局域网直连' + (usr ? '（改用你设置的服务器）' : ''),
        onclick: stopLanNow
      }));
    } else if (N.isPrivateHost(base)) {
      kids.push(el('div.tiny.dim', {
        style: { marginTop: '8px' },
        html: '这是<b>局域网地址</b>：只有和房主连同一个 WiFi 的人才能加入。'
      }));
    }
    return kids;
  }

  /** 兼容旧调用（当前首页已改用合并卡，保留函数避免外部引用断掉）。 */
  function serviceCard() {
    var r = N.resolve();
    var base = r.base;
    var card = el('div.card', null, [
      el('div.card-head', null, [
        el('h3', { text: '公网房间' }),
        el('span.hint', {
          text: base
            ? (r.source === 'injected'
                ? SOURCE_TEXT.injected
                : (SOURCE_TEXT[r.source] + ' · ' + (N.isPrivateHost(base) ? '局域网' : '公网')))
            : SOURCE_TEXT.none
        })
      ])
    ]);
    global.UI.append(card, serviceCardBody());
    return card;
  }

  /* ---------- 局域网直连 ----------
   *
   * 这一块和「公网开团」共用同一套创建/加入/传输代码，区别只有两点：
   *   · 开房前先让外壳把内嵌房间服务跑起来（RoomLan.start）
   *   · 地址不是用户填的，而是本机 IP（会自动写进邀请链接）
   * 刻意不复制一份「局域网版创建流程」—— 那正是需求 §11.1 要避免的分叉。
   */

  /**
   * 局域网直连卡片（仅 App）+ **手动填地址加入**入口（浏览器里也有）。
   *
   * 手动填地址加入为什么要放在这里：加入方不一定能收到邀请链接 ——
   * 房主可能只报了一串地址 / 房间号（口头、截图、手抄）。没有这个入口，
   * 浏览器里（没有局域网外壳）就**完全没有**办法连一个指定地址。
   */
  function lanCard() {
    var card = lanCardInner();
    card.appendChild(manualJoinCard());
    return card;
  }

  function lanCardInner() {
    var L = global.RoomLan;
    if (!L || !L.isApp()) return el('div');         // 浏览器里没有局域网这块

    var on = L.available();
    var inj = L.injected();
    var up = L.running();
    var stale = !up && !!inj;   // 地址还留着但服务没在跑（上次异常退出）
    var card = el('div.card', null, [
      el('div.card-head', null, [
        el('h3', { text: '局域网直连' }),
        el('span.hint', { text: up ? '服务器运行中' : (on ? ('本机 ' + L.ip()) : '未连接 WiFi') })
      ])
    ]);

    if (!on) {
      card.appendChild(el('div.tiny.dim', {
        html: '没有检测到局域网地址：请先连上 WiFi，或者打开手机热点让别人连你。<br>' +
              '（连上之后再回到这个页面即可。）'
      }));
      return card;
    }

    card.appendChild(el('div.tiny.dim', {
      style: { marginBottom: '10px' },
      html: '你的手机就是服务器。同伴连同一个 WiFi 就能直接进房 —— <b>不经过任何外部服务器</b>。'
    }));

    /* 运行中要显式给出状态与关闭入口。
       以前只有「用本机开房」一个按钮，服务一旦起来就**没有任何界面能关掉它** ——
       而它会一直盖住设置里填的服务器地址，于是「切不回公网开房」。
       另外「地址还在、服务没了」这种残留状态也要能一键清掉（否则同样切不回去）。 */
    if (up) {
      card.appendChild(banner('本机服务器已启动：' + inj, 'ok'));
      card.appendChild(el('div.btn-group', null, [
        el('button.btn.primary.grow', {
          text: '继续开房', onclick: function () { createSheet(true); }
        }),
        el('button.btn.ghost.grow', { text: '⏹ 关闭服务器', onclick: stopLanNow })
      ]));
      /* 服务在跑但同伴连不上 → 先在房主自己手机上把两探跑一遍。
         这一条踩过的坑最多：服务起着、地址也对，同伴却报「无法连接」，
         而真正的原因可能是「明文被安卓拦」「不在同一 WiFi」「路由器 AP 隔离」，
         三者从外部**看起来完全一样**。
         文案里带上用途说明（而不只是「局域网自检」），是因为用户在这里
         真正想问的是「同伴为什么连不上我」。 */
      card.appendChild(el('button.btn.sm.block', {
        style: { marginTop: '8px' },
        text: '🔎 局域网自检（同伴连不上时点这里）',
        onclick: function () { lanCheckSheet(); }
      }));
      return card;
    }
    if (stale) {
      card.appendChild(banner('上次的局域网地址还留着，但本机服务器已经不在跑了。\n' +
                              '它现在会盖住你设置的服务器地址。', 'warn'));
      card.appendChild(el('button.btn.sm.block', { text: '清除残留地址', onclick: stopLanNow }));
      return card;
    }

    card.appendChild(el('div.btn-group', null, [
      el('button.btn.primary.grow', { text: '📡 用本机开房', onclick: lanCreate }),
      el('button.btn.grow', { text: '🔍 搜索周围房间', onclick: lanFind })
    ]));
    return card;
  }

  /**
   * 「手动填地址加入」入口卡片 —— **浏览器里也要有**（不依赖局域网外壳）。
   *
   * 用途：房主只给了你一串地址或房间号（不是链接）时，能手动连过去。
   * 支持粘贴整段加入信息（COC7ROOM|地址|房间号 / 邀请链接 / 裸地址 / 裸房间号），
   * 由 M.readInvite 做宽容解析。
   */
  function manualJoinCard() {
    return el('div.card', null, [
      el('div.card-head', null, [
        el('h3', { text: '🔗 手动填地址加入' }),
        el('span.hint', { text: '浏览器 / App 通用' })
      ]),
      el('div.tiny.dim', {
        html: '房主只给了你一串地址或房间号（不是链接）？点下面手动连过去。<br>' +
              '支持粘贴：<code>COC7ROOM|地址|房间号</code>、邀请链接、纯地址、或只填房间号。'
      }),
      el('button.btn.primary.block', {
        style: { marginTop: '10px' },
        text: '🔗 手动填地址加入',
        onclick: function () { manualJoinSheet(); }
      })
    ]);
  }

  /**
   * 手动填地址加入弹层。
   *
   * 流程刻意与 joinSheet 完全一致（probe → join → startPlayer），只是多了一个
   * 「服务器地址」输入，并在提交前把它写进 global.ROOM_SERVER_BASE ——
   * 这样 N.probe / N.join 会走「注入地址」这条路（与 lanFind 加入同一机制）。
   */
  function manualJoinSheet() {
    var pasteInput = el('input.input', {
      type: 'text', placeholder: '粘贴加入信息 / 邀请链接（可选）', autocapitalize: 'none'
    });
    var addrInput = el('input.input', {
      type: 'text', placeholder: '服务器地址，如 192.168.x.y:8899 或 https://your-domain/room',
      value: '', autocapitalize: 'none'
    });
    var codeInput = el('input.input', {
      type: 'text', placeholder: '6 位房间号，例如 ab12cd', value: '', autocapitalize: 'none'
    });
    var nick = el('input.input', { type: 'text', placeholder: '你的名字', value: '' });
    var pwd = el('input.input', { type: 'text', placeholder: '房间密码（KP 设了才填）', value: '', autocapitalize: 'none' });
    var hint = el('div.tiny.dim');

    /** 把整段字符串解析成地址 + 房间号，填进输入框；返回解析结果 */
    function applyParsed(str) {
      var inv = M.readInvite(str);
      if (inv.serverBase) addrInput.value = inv.serverBase;
      if (inv.code) codeInput.value = inv.code;
      return inv;
    }

    function probeNow() {
      var c = M.cleanText(codeInput.value, 12).toLowerCase();
      if (!M.validCode(c)) { global.UI.clear(hint); return; }
      var addr = M.readInvite(addrInput.value).serverBase || addrInput.value.trim();
      /* 探测前先把它设为「注入地址」——否则会去打设置里的公网地址 */
      if (addr) global.ROOM_SERVER_BASE = addr;
      N.probe(c, roleSel.value).then(function (j) {
        global.UI.clear(hint);
        if (j.ok) {
          hint.appendChild(el('span.probe-ok', {
            text: '房间「' + (j.name || c) + '」' + (j.needPwd ? '（需要密码）' : '') +
                  ' · 玩家 ' + j.players + '/' + j.maxPlayers
          }));
        } else {
          hint.appendChild(el('span.probe-err', { text: j.message || '现在进不去' }));
        }
      }, function (e) {
        global.UI.clear(hint);
        hint.appendChild(el('span.probe-err', { text: (e && e.message) || '查询失败' }));
      });
    }

    var roleSel = selectCtl([{ value: 'player', label: '作为玩家加入' },
                             { value: 'spectator', label: '旁观' }], 'player', probeNow);

    /* 粘贴整段加入信息 → 自动拆出地址与房间号（在 input 事件上实时解析，
       这样即使用户是一段一段粘贴进来的也能认出来） */
    function onPasteParse() {
      var inv = applyParsed(pasteInput.value);
      if (inv.code || inv.serverBase) { global.UI.clear(hint); }
      if (inv.code) probeNow();
    }
    pasteInput.addEventListener('input', onPasteParse);
    pasteInput.addEventListener('change', onPasteParse);
    codeInput.addEventListener('change', probeNow);
    if (M.validCode(M.cleanText(codeInput.value, 12).toLowerCase())) probeNow();

    var s = global.UI.sheet({
      title: '手动填地址加入',
      body: el('div', null, [
        global.UI.field('粘贴加入信息（可选）', pasteInput, {
          help: '把房主给你的整段内容粘进来，自动拆出地址与房间号'
        }),
        global.UI.field('服务器地址', addrInput, {
          required: true,
          help: '没写 http:// 也行；局域网地址例如 192.168.x.y:8899'
        }),
        global.UI.field('房间号', codeInput, { required: true }),
        hint,
        global.UI.field('你的名字', nick, { required: true }),
        global.UI.field('房间密码', pwd, { help: 'KP 开房时设了密码才需要填' }),
        global.UI.field('身份', roleSel, { help: '旁观者只能看和聊天' }),
        el('button.btn.primary.block', {
          text: '加入',
          onclick: function () {
            var c = M.cleanText(codeInput.value, 12).toLowerCase();
            var nk = M.cleanText(nick.value, 20);
            /* 地址可能是「裸 host:port」，用 readInvite 规范化后再写进注入位 */
            var addr = M.readInvite(addrInput.value).serverBase || addrInput.value.trim();
            if (!addr) { global.UI.toast('请填写服务器地址', 'err'); return; }
            if (!M.validCode(c)) { global.UI.toast('房间号是 4-12 位小写字母或数字', 'err'); return; }
            if (!nk) { global.UI.toast('请填写你的名字', 'err'); return; }
            var btn = this;
            btn.disabled = true; btn.textContent = '加入中…';
            /* ⚠️ 必须先写注入地址：它优先级最高，能盖过设置里的公网地址，
               保证 probe/join/WS 都打到用户手填的这台服务器。 */
            global.ROOM_SERVER_BASE = addr;
            N.join(c, {
              nickname: nk, password: pwd.value, role: roleSel.value
            }).then(function (res) {
              s.close();
              var joined = res.code || c;
              S.setJoined({
                code: joined, mtoken: res.mtoken, serverBase: N.base(),
                role: res.role, nickname: nk, name: (res.meta || {}).name || '',
                kpName: (res.meta || {}).kpName || ''
              });
              startPlayer(res, nk, joined);
            }, function (e) {
              btn.disabled = false; btn.textContent = '加入';
              global.UI.toast(e && e.message || '加入失败', 'err');
              showConnectError(e, N.resolve(), false);
            });
          }
        })
      ])
    });
  }

  /**
   * 关掉本机局域网服务器 —— 关掉之后，设置里填的服务器地址立刻重新生效。
   *
   * 幂等：没在跑也只是把注入的地址清掉，不会报错。刻意**不**问「确定吗」：
   * 这是一个可逆动作（再点一次「用本机开房」就回来了），
   * 而它现在的用途恰恰是「我要切走」——中间再插一次确认只会挡路。
   */
  function stopLanNow() {
    var L = global.RoomLan;
    if (L) L.stop();
    rerender();
    global.UI.toast('已停用局域网直连，改用你设置的服务器', 'ok');
  }

  /**
   * 没连 WiFi / 没开热点时的拦截弹层（v1.18.4）。
   *
   * 为什么必须拦在这：此时外壳拿不到私有网段地址，base 会退化成
   * http://127.0.0.1 —— 房间能建、自己也能进，但**邀请链接对同伴是死路**。
   * 直接放行的话用户要拿两台手机试半天，最后只看到一句误导性的「连不上」。
   * 需求 §2.3 禁止「看着能点、点了没反应」，建房前就说清楚才是对的。
   */
  function noWifiSheet(res) {
    var body = el('div', null, [
      el('div.notice.warn', null, [
        el('span', { html: '本机服务器起来了，但<b>没有拿到局域网地址</b>。<br>' +
          '现在这个房间只有<b>你自己</b>能进，同伴扫到的地址连不上。' })
      ]),
      el('div.small', { style: { marginTop: '10px' }, html:
        '浏览器地址栏里看到的会是 <b>http://127.0.0.1' + (res.port ? ':' + res.port : '') +
        '</b> —— 这是「本机」的意思，别的手机连它只会连到它们自己。' }),
      el('div.small', { style: { marginTop: '10px' }, html: '<b>怎么解决：</b>' }),
      el('div.tiny.dim', { style: { marginTop: '6px' }, html:
        '① 让两台手机连上<b>同一个 WiFi</b>（连同一个路由器）；<br>' +
        '② 或者由一台手机<b>开热点</b>、另一台连上来；<br>' +
        '③ 连好后回到这里重新点「用本机开房」。<br>' +
        '④ 如果确实没法同网，就用<b>公网开房</b>（走服务器，不要求同 WiFi）。' })
    ]);
    var s = global.UI.sheet({ title: '还没连上 WiFi', body: body });
    var foot = el('div.btn-group', { style: { marginTop: '12px' } }, [
      el('button.btn.grow', {
        text: '知道了',
        onclick: function () { s.close(); }
      }),
      el('button.btn.grow', {
        text: '关掉本机服务器',
        onclick: function () { s.close(); stopLanNow(); }
      })
    ]);
    body.appendChild(foot);
  }

  /** 用本机当服务器开房：先把服务跑起来，再走和公网一样的创建流程 */
  function lanCreate() {
    var L = global.RoomLan;
    if (!L || !L.available()) { global.UI.toast('当前没有可用的局域网', 'err'); return; }
    if (L.running()) { createSheet(true); return; }    // 已经开着：直接建房间
    /* 地址还留着、服务却没在跑（上次异常退出）→ 先清掉，
       否则会拿着一个死地址去建房，报出来的错完全不知所云。 */
    if (L.injected()) L.stop();
    global.UI.toast('正在启动本机服务器…', 'ok');
    var res = L.start();
    if (!res.ok) {
      global.UI.toast(res.error === 'NO_BRIDGE'
        ? '只有安卓 App 里才能当服务器' : ('启动失败：' + (res.error || '')), 'err');
      return;
    }
    /* v1.18.4：没连 WiFi / 没开热点时，外壳拿不到私有网段地址，
       base 会退化成 http://127.0.0.1 —— 那间房**只有自己能进**。
       必须在建房之前说清楚，否则用户会拿着一个对同伴无效的邀请链接
       试半天，最后只会看到一句误导性的「连不上」。 */
    if (res.wifi === false) {
      noWifiSheet(res);
      return;
    }
    global.UI.toast('本机服务器已就绪（' + (res.base || '') + '）', 'ok');
    /* ⚠️ 必须重画入口页：服务一起来，它注入的地址就把设置里的服务器地址顶掉了。
       不重画的话「房间服务」卡片还写着「你设置的服务器」、局域网卡片还显示
       「📡 用本机开房」—— 用户取消创建弹层后就再也看不到「关闭服务器」入口，
       也就切不回公网开房（这正是用户报的那个问题）。 */
    rerender();
    createSheet(true);
  }

  /** 搜索同一网段里开着的房间（UDP 广播） */
  function lanFind() {
    var L = global.RoomLan;
    if (!L || !L.isApp()) { global.UI.toast('只有安卓 App 里才能搜索局域网房间', 'err'); return; }
    var body = el('div', null, [el('div.tiny.dim', { text: '正在搜索同一 WiFi 下的房间…' })]);
    var s = global.UI.sheet({ title: '附近的房间', body: body });
    L.discover(1800).then(function (list) {
      global.UI.clear(body);
      if (!list || !list.length) {
        body.appendChild(el('div.tiny.dim', {
          html: '没搜到房间。<br>· 确认对方的房间已经开好；<br>· 确认你们连的是同一个 WiFi（不是各自的流量）。'
        }));
        return;
      }
      list.forEach(function (f) {
        var e = L.asRoomEntry(f);
        body.appendChild(el('div.actor-line', { style: { cursor: 'pointer' } }, [
          el('div.grow', null, [
            el('div.nm', { text: e.name || '未命名房间' }),
            el('div.tiny.dim', {
              text: 'KP ' + (e.kpName || '?') + ' · 房间号 ' + e.code +
                    ' · 玩家 ' + e.players + '/' + e.maxPlayers +
                    (e.needPwd ? ' · 需要密码' : '')
            })
          ]),
          el('button.btn.sm.primary', {
            text: '加入',
            onclick: function () {
              s.close();
              /* ⚠️ 加入前必须把「那台服务器」的地址写进全局 —— 否则会去连
                 自己设置里的公网地址。这正是邀请链接里带地址的同一个道理。 */
              global.ROOM_SERVER_BASE = e.lanBase || '';
              joinSheet(e.code, '');
            }
          })
        ]));
      });
    });
  }

  function resumeMineCard(mine) {    return el('div.card', null, [
      el('div.card-head', null, [el('h3', { text: '我开的房间还没关' })]),
      el('div.small.dim', { text: (mine.name || '未命名') + ' · 房间号 ' + mine.code }),
      el('div.btn-group', { style: { marginTop: '10px' } }, [
        el('button.btn.primary.grow', {
          text: '回到房间', onclick: function () { resumeMine(mine); }
        }),
        el('button.btn.ghost.grow', {
          text: '结束它', onclick: function () {
            global.UI.confirm('结束这个房间？房间里的其他人会被断开。', { danger: true, okText: '结束房间' })
              .then(function (ok) {
                if (!ok) return;
                N.closeRoom(mine.code, mine.hostToken).catch(function () { return null; })
                  .then(function () {
                    // 这个房间当初可能就是本机开的：一并把内嵌服务停掉，
                    // 否则它注入的地址会继续盖着设置里的服务器地址
                    stopLanIfHost();
                    S.clearMine(); global.UI.toast('房间已结束', 'ok'); rerender();
                  });
              });
          }
        })
      ])
    ]);
  }

  function recentCard(joined) {
    var list = el('div.card', null, [el('div.card-head', null, [el('h3', { text: '最近加入的房间' })]),
                                     el('span.hint', { text: joined.length + ' 个' })]);
    joined.slice(0, 5).forEach(function (r) {
      var row = el('div.pending-row', { style: { alignItems: 'center' } });
      row.appendChild(el('button.char-card.grow', {
        style: { margin: '0' },
        onclick: function () { reopenJoined(r); },
        html: '<div class="ic">🎲</div><div class="grow"><div class="t">' +
              global.UI.esc(r.name || ('房间 ' + r.code)) + '</div>' +
              '<div class="d">' + global.UI.esc(r.code) + ' · ' +
              (r.role === 'spectator' ? '旁观' : '玩家') + ' · ' +
              global.UI.esc(r.nickname || '') + '</div></div>'
      }));
      /* v1.18.5（用户需求）：最近加入的房间必须能删。
         旧版整行只有「进入」一个动作，离开过的死房间会永远挂在列表里。 */
      row.appendChild(el('button.btn.sm.ghost', {
        text: '✕', title: '从列表移除',
        style: { flexShrink: '0' },
        onclick: function (ev) {
          if (ev && ev.stopPropagation) ev.stopPropagation();
          S.clearJoined(r.code);
          global.UI.toast('已从列表移除', 'ok');
          rerender();
        }
      }));
      list.appendChild(row);
    });
    if (!joined.length) {
      list.appendChild(el('div.tiny.dim', { text: '还没有加入过房间。' }));
    }
    return list;
  }

  /* ---------- 服务地址设置 ---------- */

  function roomBaseSheet() {
    var input = el('input.input', {
      type: 'text', placeholder: 'https://你的域名/room',
      value: N.userBase() || ''
    });
    var L = global.RoomLan;
    var lanOn = !!(L && (L.running() || L.injected()));

    var body = el('div', null, [
      el('div.small.dim', {
        html: '公网开团时填这里。它必须是一个跑着房间服务的地址，例如：<br>' +
              '<code>https://your-domain.example/room</code><br><br>' +
              '局域网开团<b>不用填</b>：房主手机创建房间后，邀请链接里会自带地址。<br><br>' +
              '💡 可以填<b>多个</b>地址（用逗号隔开）。主地址连不上时会自动换下一个：' +
              '服务器在境外、手机走流量时特别有用。<br>' +
              '<code>https://a.example/room, https://b.example/room</code>'
      })
    ]);

    /* 局域网服务器开着的时候，这个输入框填了也**不会立刻生效** ——
       必须在这里就说清楚，否则用户会以为「保存了没用」。 */
    if (lanOn) {
      body.appendChild(el('div.notice.warn', { style: { marginTop: '10px' } }, [
        el('span', {
          html: '本机局域网服务器正在运行，它<b>盖过</b>这里填的地址。' +
                '保存时可以选择顺便把它关掉。'
        })
      ]));
    }

    body.appendChild(el('div.field', { style: { marginTop: '12px' } }, [input]));
    body.appendChild(el('div.btn-group', null, [
      el('button.btn.ghost.grow', {
        text: '清空', onclick: function () {
          global.Store.setSettings({ roomBase: '' });
          global.UI.toast('已清空', 'ok');
          s.close(); rerender();
        }
      }),
      el('button.btn.primary.grow', {
        text: '保存', onclick: function () {
          var v = N.normalizeBase(input.value);
          if (v && !N.looksValid(v)) { global.UI.toast('地址要以 http:// 或 https:// 开头', 'err'); return; }

          function finish() {
            global.Store.setSettings({ roomBase: v });
            global.UI.toast(v ? '已保存' : '已清空', 'ok');
            s.close(); rerender();
          }

          /* 填了地址、而本机服务器还开着 → 问一句「要不要顺便关掉」。
             这是用户「切回服务器开房」的最直接路径：
             他填公网地址的意图本来就是不想用本机当服务器了。 */
          if (lanOn && v) {
            global.UI.confirm(
              '本机局域网服务器还开着，它会盖过你刚填的地址。\n要顺便关掉它、改用这个服务器吗？',
              { okText: '关闭并保存', cancelText: '只保存' }
            ).then(function (yes) {
              if (yes && L) L.stop();
              finish();
            });
            return;
          }
          finish();
        }
      })
    ]));

    var s = global.UI.sheet({ title: '房间服务地址', body: body });
  }

  /* ---------- 创建房间 ---------- */

  function createSheet(lan) {
    // 这个函数同时被 onclick 直接引用（把 MouseEvent 当第一个实参传进来），
    // 所以必须**显式**判定布尔值 —— 否则事件对象是 truthy，会误走局域网分支。
    lan = lan === true;
    if (!N.base()) {
      global.UI.toast(lan ? '本机服务器还没起来' : '请先配置房间服务地址', 'err');
      if (!lan) roomBaseSheet();
      return;
    }
    var name = el('input.input', { type: 'text', placeholder: '例如：奈亚拉托提普的面具', value: '' });
    var kpInput = el('input.input', { type: 'text', placeholder: '你在团里的名字', value: '' });
    var maxSel = selectCtl(
      [2, 3, 4, 5, 6, 7, 8].map(function (n) { return { value: n, label: n + ' 人' }; }), 4);
    var pwd = el('input.input', { type: 'text', placeholder: '留空则不设密码', value: '' });
    var specSel = selectCtl([{ value: '1', label: '允许旁观' }, { value: '0', label: '不允许旁观' }], '1');
    /* v2.3.0（用户第 7 项）：可自定义的大成功 / 大失败阈值。
       标签必须写明**比较方向**；游戏中还可在 KP 工具 → 🎯 检定成败阈值 里改。 */
    var critInput = el('input.input', {
      type: 'number', min: '1', max: '100', value: '1', inputmode: 'numeric', placeholder: '1'
    });
    var fumbleInput = el('input.input', {
      type: 'number', min: '1', max: '100', value: '100', inputmode: 'numeric', placeholder: '100'
    });

    var head = [];
    if (lan) {
      head.push(el('div.tiny.dim', {
        style: { marginBottom: '12px' },
        html: '🔗 <b>局域网模式</b>：房间开在你这台手机上（' + global.UI.esc(N.base()) + '），' +
              '邀请链接会自动带上这个地址。'
      }));
    }

    var s = global.UI.sheet({
      title: lan ? '创建房间（局域网）' : '创建房间',
      body: el('div', null, head.concat([
        global.UI.field('房间名', name, { required: true }),
        global.UI.field('KP 名字', kpInput, { help: '玩家在成员列表里看到的名字' }),
        global.UI.field('玩家人数上限', maxSel, { help: '含你自己以外的玩家席位' }),
        global.UI.field('房间密码', pwd, { help: '留空则任何人拿到房间号都能进' }),
        global.UI.field('旁观', specSel, { help: '旁观者只能看和聊天，不能掷骰或改状态' }),
        /* v2.3.0（用户第 7 项）：两个阈值（标签写明比较方向）。 */
        global.UI.field('大成功阈值', critInput, { help: '掷出值 ≤ 该值 → 大成功（默认 1）' }),
        global.UI.field('大失败阈值', fumbleInput, { help: '掷出值 ≥ 该值 → 大失败；填 100 或留空 / 填 0 → 按规则书动态判定（要求阈值 < 50 时 96-100，否则仅 100）' }),
        el('button.btn.primary.block', {
          text: '创建',
          onclick: function () {
            var nm = M.cleanText(name.value, 30);
            if (!nm) { global.UI.toast('请填写房间名', 'err'); return; }
            /* v2.3.0（用户第 7 项）：夹取两个阈值，随建房载荷一起提交。 */
            var critT = parseInt(critInput.value, 10); if (!(critT >= 1 && critT <= 100)) critT = 1;
            var fumbleT = parseInt(fumbleInput.value, 10);
            if (!(fumbleT >= 1 && fumbleT <= 100)) fumbleT = 100;   // 空 / 0 / 非法 → 100（= 动态规则）
            var btn = this;
            btn.disabled = true; btn.textContent = '创建中…';
            N.create({
              name: nm,
              kpName: M.cleanText(kpInput.value, 20) || 'KP',
              rules: 'coc7',
              maxPlayers: Number(maxSel.value),
              password: M.cleanText(pwd.value, 40) || '',
              allowSpectate: specSel.value === '1',
              /* v2.3.0（用户第 7 项）：大成功 / 大失败阈值随建房载荷提交 */
              critThreshold: critT,
              fumbleThreshold: fumbleT
            }).then(function (res) {
              s.close();
              S.setMine({
                code: res.code, hostToken: res.hostToken,
                serverBase: N.base(), name: nm, rules: 'coc7', lan: !!lan
              });
              startHost(res, nm, { critThreshold: critT, fumbleThreshold: fumbleT });
            }, function (e) {
              btn.disabled = false; btn.textContent = '创建';
              var r = N.resolve();
              global.UI.toast(e && e.message || '创建失败', 'err');
              /* ⚠️ 只说「创建失败」是查不出问题的：同一个 toast 文案可能来自
                 ①地址填错 ②公网超时 ③本机局域网服务没起来 ④被残留的局域网地址盖住。
                 而这四种的修法完全不同。所以把「连的是哪个地址、这地址从哪来」直接摊开，
                 并就地给一个能切回公网的按钮（§2.3：不许出现点了没反应的假入口）。 */
              showConnectError(e, r, lan);
            });
          }
        })
      ]))
    });
  }

  /* ---------- 加入房间 ---------- */

  function joinSheet(code, nickname) {
    var codeInput = el('input.input', {
      type: 'text', placeholder: '6 位房间号，例如 ab12cd',
      value: (code || '').toLowerCase(), autocapitalize: 'none'
    });
    var nick = el('input.input', { type: 'text', placeholder: '你的名字', value: nickname || '' });
    var pwd = el('input.input', { type: 'text', placeholder: '房间密码（没设就留空）', value: '' });
    var hint = el('div.tiny.dim');

    /* v2.1.1：记住最近一次预检的 joinKind —— 点「加入」时按钮文案据此区分
       「正在重连…」（机器码命中已有绑定）/「加入中…」（全新机器码）。 */
    var lastJoinKind = '';
    function probeNow() {
      var c = M.cleanText(codeInput.value, 12).toLowerCase();
      if (!M.validCode(c)) { hint.textContent = ''; return; }
      N.probe(c, roleSel.value).then(function (j) {
        global.UI.clear(hint);
        lastJoinKind = (j && j.joinKind) || '';
        if (j.ok) {
          /* v2.1.1（用户第三轮反馈）：IN_GAME 房现在**可加入**（服务端不再拦），
             这里明确标成「可加入（进行中）」，不再显示"游戏已经开始"那类误导文案。 */
          var inGame = String(j.status || '').toUpperCase() === 'IN_GAME';
          hint.appendChild(el('span.probe-ok', {
            text: '房间「' + (j.name || c) + '」' + (j.needPwd ? '（需要密码）' : '') +
                  ' · 玩家 ' + j.players + '/' + j.maxPlayers +
                  (inGame ? ' · 可加入（进行中）' : '')
          }));
        } else {
          hint.appendChild(el('span.probe-err', { text: j.message || '现在进不去' }));
        }
      }, function (e) {
        global.UI.clear(hint);
        hint.appendChild(el('span.probe-err', { text: (e && e.message) || '查询失败' }));
      });
    }

    var roleSel = selectCtl([{ value: 'player', label: '作为玩家加入' },
                             { value: 'spectator', label: '旁观' }], 'player', probeNow);
    codeInput.addEventListener('change', probeNow);
    if (M.validCode(M.cleanText(codeInput.value, 12).toLowerCase())) probeNow();

    /* v2.0.0（用户要求 + 契约 §5.4）：加入房间时要能选一张已保存的角色卡。
       未绑角色卡的人不能「准备」—— 所以把选卡放进加入流程，一步到位。
       这里**不强制**：也可以先加入、进房间后再绑定（准备按钮会置灰并说明原因）。 */
    var charPick = charPicker();

    var s = global.UI.sheet({
      title: '加入房间',
      body: el('div', null, [
        global.UI.field('房间号', codeInput, { required: true }),
        hint,
        global.UI.field('你的名字', nick, { required: true }),
        global.UI.field('身份', roleSel, { help: '旁观者只能看和聊天' }),
        global.UI.field('角色卡', charPick.el, {
          help: charPick.chars.length ? '选择要带进房间的角色卡（不选则进房间后再绑定）'
                                      : '没有可带入的角色卡（已撕卡的在首页「英灵殿」），可先加入、稍后绑定'
        }),
        global.UI.field('密码', pwd, { help: '房间没设密码就留空' }),
        el('button.btn.primary.block', {
          text: '加入',
          onclick: function () {
            var c = M.cleanText(codeInput.value, 12).toLowerCase();
            var nk = M.cleanText(nick.value, 20);
            if (!M.validCode(c)) { global.UI.toast('房间号是 4-12 位小写字母或数字', 'err'); return; }
            if (!nk) { global.UI.toast('请填写你的名字', 'err'); return; }
            var btn = this;
            btn.disabled = true;
            /* v2.1.1：按 joinKind 给不同的等待文案（预检已知「重连 / 新加入」）。 */
            btn.textContent = (lastJoinKind === 'reconnect') ? '正在重连…' : '加入中…';
            N.join(c, {
              nickname: nk, password: M.cleanText(pwd.value, 40) || '',
              role: roleSel.value
            }).then(function (res) {
              s.close();
              // 服务端会回 code；万一对面是旧版服务，就用刚填的那个，别让它变成 undefined
              var joined = res.code || c;
              S.setJoined({
                code: joined, mtoken: res.mtoken, serverBase: N.base(),
                role: res.role, nickname: nk, name: (res.meta || {}).name || '',
                kpName: (res.meta || {}).kpName || ''
              });
              startPlayer(res, nk, joined, charPick.chosen());
            }, function (e) {
              btn.disabled = false; btn.textContent = '加入';
              global.UI.toast(e && e.message || '加入失败', 'err');
              showConnectError(e, N.resolve(), false);
            });
          }
        })
      ])
    });
  }

  /**
   * v2.1.9（用户第 1 项）：撕卡判定提升为**模块级共享 helper** ——
   * 「加入房间」的选卡控件（charPicker）与房间内绑定列表（bindSheetSheet）都要
   * 过滤掉已撕卡的角色（死亡 / 永久疯狂）。判定口径与 app.js 的 isRippedCard 一致。
   * @param {object} c 角色卡
   * @returns {boolean} true = 已撕卡（死亡 或 永久疯狂）
   */
  function isRippedCard(c) {
    var st = (c && c.status) || {};
    var mental = (global.Store && global.Store.mentalList) ? global.Store.mentalList(c) : [];
    return st.body === '死亡' || mental.indexOf('永久疯狂') >= 0;
  }

  /**
   * 角色卡选择控件（加入房间时用）。返回 { el, chars, chosen() }。
   * 复用 occ-item 列表样式；点一下切换选中（单选）。不选也能加入。
   * v2.1.9（用户第 1 项）：只列**未撕卡**的角色 —— 已撕卡的（英灵殿）不能带入房间，
   * 否则开局角色就是死的、什么都干不了；chosen() 返回的也是过滤后的 id。
   */
  function charPicker() {
    var all = (global.Store && global.Store.listCharacters) ? global.Store.listCharacters() : [];
    var chars = all.filter(function (c) { return !isRippedCard(c); });
    var cur = { id: '' };
    var box = el('div.gp-charpick');
    if (!chars.length) {
      box.appendChild(el('div.tiny.dim', {
        text: all.length
          ? '没有可带入的角色卡：已撕卡的角色在首页「英灵殿」，不能带入房间。'
          : '本机还没有保存的角色卡。加入后可在房间里绑定。'
      }));
    } else {
      chars.forEach(function (c) {
        var item = el('div.occ-item', {
          onclick: function () {
            cur.id = (cur.id === c.id) ? '' : c.id;
            Array.prototype.forEach.call(box.children, function (n) {
              if (n !== item) n.classList.remove('sel');
            });
            if (cur.id === c.id) item.classList.add('sel'); else item.classList.remove('sel');
          }
        }, [
          el('div.grow', null, [
            el('div.nm', { text: c.characterName || '（无名）' }),
            el('div.meta', { text: 'SAN ' +
              (((c.status || {}).currentSAN != null) ? c.status.currentSAN : '—') })
          ])
        ]);
        box.appendChild(item);
      });
    }
    return { el: box, chars: chars, chosen: function () { return cur.id; } };
  }

  /* ============================================================
   * 建立会话
   * ============================================================ */

  function startHost(res, roomName, roomOpts) {
    var T2 = T();
    /* v2.3.0（用户第 7 项）：建房时选定的大成功 / 大失败阈值（游戏中可经 KP 工具改）。 */
    roomOpts = roomOpts || {};
    var critT = parseInt(roomOpts.critThreshold, 10); if (!(critT >= 1 && critT <= 100)) critT = 1;
    var fumbleT = parseInt(roomOpts.fumbleThreshold, 10); if (!(fumbleT >= 1 && fumbleT <= 100)) fumbleT = 100;
    var host = new M.Host({
      meta: {
        code: res.code, name: roomName || ((res.meta || {}).name || ''),
        rules: 'coc7', kpName: (res.meta || {}).kpName || 'KP',
        maxPlayers: (res.meta || {}).maxPlayers || 4,
        allowSpectate: (res.meta || {}).allowSpectate !== false,
        status: T2.STATUS.RECRUITING,
        critThreshold: critT,
        fumbleThreshold: fumbleT
      }
    });
    var gen = ++sessGen;   // v2.0.3 缺陷2：本会话代号（旧 side 回调按代丢弃）
    var side = new N.HostSide({
      host: host,
      /* ⚠️ 用「刚才建房成功的那条路」拼 WS，而不是服务端推荐的 wsBase。
         服务端的 wsBase 写死的是它自己的对外域名（跨境 Cloudflare）；
         如果建房是走国内源站直连进来的，WS 也必须沿同一条路回去，
         否则 HTTP 通了、WS 却连不上，界面上就是「建不了房」。见 room-net#wsUrlFor。 */
      room: { code: res.code, wsUrl: N.wsUrlFor(N.activeBase(), res.code, res.hostToken, res),
              hostToken: res.hostToken },
      onState: function (st, info) { onLinkState('kp', st, info, gen); },
      onError: function (msg) { if (isStaleSession(gen)) return; setBanner(sess, msg, 'err'); },
      onDiag: onLinkDiag(gen),
      onPeer: function () { if (isStaleSession(gen)) return; paint(); },
      /* v2.12.2：房间已没了（重连预检判定）→ 收尾回首页 */
      onEnded: function (reason) { if (isStaleSession(gen)) return; dissolveFromLink(reason); }
    });
    sess = {
      role: T2.ROLE.KP, code: res.code, host: host, client: null, side: side,
      meta: host.state.meta, startedAt: Date.now(), roomName: host.state.meta.name
    };
    side.open();
    global.App.go('#/room/' + res.code);
    paint(true);
  }

  /**
   * v2.5.0（用户第 7 项·c）：「正在补齐断线期间的记录」横幅的**超时兜底**。
   *
   * 根因：横幅的清理条件原本是「gap 之后再来一条正常消息」，房间一安静就永远等不到；
   * 更糟的情况是补拉本身有洞 → _gate 持续返回 gap → 界面反复重设横幅 + 重复发
   * resyncIntent，形成「长期挂横幅的补拉循环」。给 4 秒超时，到点就把文案改成
   * 「可能没补完」并给出出口，**绝不无限挂着**。
   * @param {object} s 会话对象
   */
  function armGapBannerTimeout(s) {
    if (!s) return;
    if (s._gapBannerT) clearTimeout(s._gapBannerT);
    s._gapBannerT = setTimeout(function () {
      s._gapBannerT = 0;
      if (!s._gapFilling) return;
      s._gapFilling = false;
      setBanner(s, '记录可能未完全补齐，可退出房间重新加入以拉取完整记录', 'warn');
    }, 4000);
  }

  /** v2.5.0（用户第 7 项·c）：补齐完成 / 会话切换时撤掉超时兜底计时器。 */
  function clearGapBannerTimeout(s) {
    if (!s || !s._gapBannerT) return;
    clearTimeout(s._gapBannerT);
    s._gapBannerT = 0;
  }

  function startPlayer(res, nickname, code, charId) {
    var T2 = T();
    code = code || res.code || ((res.meta || {}).code) || '';
    var client = new M.Client({ seat: '', role: res.role || 'player' });
    function onEvent(state, info) {
      if (isStaleSession(gen)) return;   // v2.0.3 缺陷2：旧会话的事件不得回灌新 sess
      if (info && info.kind === 'host-gone') {
        sess._hostGone = true;           // v2.4.0（用户第 ③ 项）：记下「等房主」态
        setBanner(sess, '房主已断开连接，正在等待他重连…', 'warn');
        return;
      }
      /* v2.4.0（用户第 ③ 项）：host-gone 之后收到**任何**正常流量 → 房主已回来，
         清掉「等待房主重连」横幅（旧实现只有 gap 补齐才清，房主回来了横幅也挂着）。 */
      if (sess && sess._hostGone) { sess._hostGone = false; setBanner(sess, ''); }
      if (info && info.kind === 'gap') {
        sess._gapFilling = true;
        setBanner(sess, '正在补齐断线期间的记录…', 'warn');
        armGapBannerTimeout(sess);   /* v2.5.0（用户第 7 项·c）：4s 兜底，别无限挂 */
        return;
      }
      /* v2.1.6（用户第 1 项）：补齐完成（gap 后第一条正常事件到达）→ 清掉横幅，
         否则「正在补齐断线期间的记录…」永远挂着，玩家不知道到底补没补上。 */
      if (sess && sess._gapFilling) { sess._gapFilling = false; clearGapBannerTimeout(sess); setBanner(sess, ''); }
      maybeKicked();
      maybeDissolved(state);
      paint();
    }
    var gen = ++sessGen;   // v2.0.3 缺陷2：本会话代号（旧 side 回调按代丢弃）
    var side = new N.PlayerSide({
      client: client,
      /* ⚠️ 不用服务端回的 res.wsUrl：那是它按对外域名（跨境）写死的。
         加入时 HTTP 是从哪条路进去的，WS 就走哪条路 —— 同 startHost。
         这个坑的表现是「房间号能查到、能加入，但一直重连中」。 */
      room: { code: code, wsUrl: N.wsUrlFor(N.activeBase(), code, res.mtoken, res),
              mtoken: res.mtoken, role: res.role },
      onState: function (st, info) { onLinkState('player', st, info, gen); },
      onEvent: onEvent,
      onSheetApply: onSheetApplyDiag(gen),
      /* v2.9.0（用户第 1 项）：KP 推进回合 → 本机临时卡自动生效到原卡时的提示 */
      onTempCommit: onTempCommitNotify(gen),
      onDiag: onLinkDiag(gen),
      onError: function (msg) { if (isStaleSession(gen)) return; setBanner(sess, msg, 'err'); },
      /* v2.12.2：房间已没了（重连预检判定）→ 离开房间并回写角色卡 */
      onEnded: function (reason) { if (isStaleSession(gen)) return; dissolveFromLink(reason); }
    });
    sess = {
      role: res.role || T2.ROLE.PLAYER, code: code, host: null, client: client, side: side,
      meta: client.state.meta, startedAt: Date.now(), nickname: nickname,
      pendingCharId: charId || '',
      /* v2.1.1：进房等待态 —— 复用 #10 的 sess.resuming 那套（连上后 600ms 清横幅）。
         joinKind 决定横幅文案：'reconnect' → 「正在重连…」/ 'new' → 「加入中…」。 */
      resuming: true, joinKind: (res && res.joinKind) || ''
    };
    /* v2.2.2（用户第 1 项）：玩家落地进房即刷新本机 joined 记录时间戳。 */
    touchJoinedCode(code);
    side.open();
    global.App.go('#/room/' + code);
    paint(true);
  }

  /**
   * v2.1.3（用户第 2 项）：把断线诊断翻成**可行动**的横幅。
   *
   * room-net 的 detectFailure 会在连续失败 diagAfter(4) 次后主动探一次 /probe，
   * 返回一句人话（"连不上房主那台设备的房间服务…" / "房间不存在或已过期…"）。
   * 但这条链路以前只实现到 `hooks.onDiag` —— 两处 connect() 都没传 role/onDiag，
   * 上层也没有回调，于是诊断结果**无处可去**，用户只看到沉默的「正在重连」。
   *
   * 局域网房再补一句针对性提示：那间房的服务就跑在房主手机里，杀进程即服务消失 ——
   * 这对玩家来说是最难自己想到的一条。
   */
  function onLinkDiag(gen) {
    return function (d) {
      if (isStaleSession(gen) || !d || !sess) return;
      var extra = '';
      if (!sess.lanHost && isLanBase(N.base())) {
        extra = '　⚠️ 这间房是**房主手机**开的局域网房：房主必须保持本 App 在运行' +
                '（他一旦杀掉 App，房间服务就随之停止）。请让房主重新打开 App 并「回到房间」。';
      }
      setBanner(sess, String(d) + extra, 'warn');
    };
  }

  /** 这个地址看起来是不是「局域网/本机」地址（决定要不要加那句房主提示） */
  function isLanBase(base) {
    var v = String(base || '').replace(/^wss?:\/\//i, '').replace(/^https?:\/\//i, '');
    var host = v.split('/')[0].split(':')[0];
    return /^(10\.|192\.168\.|127\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
           host === 'localhost';
  }

  function onLinkState(who, st, info, gen) {
    /* v2.0.3 缺陷2：旧 side 的迟到回调（尤其一条 'closed'）必须丢弃，
       否则会把新会话的 linkState 覆盖成 'closed'（顶栏误报「连接已断开」）。 */
    if (isStaleSession(gen)) return;
    if (!sess) return;
    var wasOffline = (sess.linkState === 'offline' || sess.linkState === 'closed');
    sess.linkState = st;
    if (st === 'closed' && info && info.fatal) {
      setBanner(sess, '连接已被房间服务终止：' + (info.reason || '') +
        (sess.role === 'kp' ? '' : '（凭据可能已过期，请重新加入）'), 'err');
    } else if (st === 'ended') {
      /* v2.12.2：重连预检确认房间已没了（KP 结团/关房，或房间行被清理）——
         走与「收到结团广播」完全相同的收尾（回写角色卡、关面板、回首页），
         而不是像以前那样永远停在「已离线，重连中…」。 */
      dissolveFromLink(info && info.reason);
    } else if (st === 'offline') {
      setBanner(sess, '连接断开，正在重连…（房间里的其他人看不到你，但不会丢座位）', 'warn');
    } else if (st === 'online') {
      /* #10（用户报）：续玩等待态的横幅**至少停留 600ms**再清空 —— 否则本地服务连得太快，
        横幅一闪而过（<50ms），用户根本看不到「正在回到房间…」。
        ⚠️ 其余情况仍即时清空（v2.0.1-C1 断言「online 后 banner 已清空」须保持）。 */
      if (sess.resuming) {
        sess.resuming = false;
        if (sess._resumeBannerT) clearTimeout(sess._resumeBannerT);
        sess._resumeBannerT = setTimeout(function () { if (sess) setBanner(sess, ''); }, 600);
      } else {
        setBanner(sess, '');
      }
      /* 重连成功：把绑定的角色卡状态补报一次。
         房间可能已经换了权威端（KP 重开房），不补报的话那边看到的
         疯狂/SAN 减损是我们断线前那一版。 */
      if (wasOffline) {
        resendBoundSheet();
        /* v2.0.1 根因⑤(d)：重连成功要有**可见反馈**，否则用户不知道恢复了 */
        if (pageRefs && pageRefs.isGame && global.UI && global.UI.toast) {
          global.UI.toast('已重新连接', 'ok');
        }
      }
      /* 加入房间时选了角色卡 → 连上之后立刻绑定（此刻才有传输口） */
      bindPendingChar();
      /* v2.4.0（用户第 ① 项）：加入房间后展示房规摘要（大成功/大失败阈值）。
         服务端 probe/join 的 meta 不带这两个字段（row_to_meta 未含），只能在
         拿到房间全量状态后展示；KP 自己就是定规的人，不弹。每会话只弹一次。 */
      if (sess.role !== 'kp' && !sess._rulesShown) {
        var metaNow = (sess.client && sess.client.state && sess.client.state.meta) || sess.meta || {};
        if (metaNow && (metaNow.critThreshold != null || metaNow.fumbleThreshold != null || metaNow.code)) {
          sess._rulesShown = true;
          if (global.UI && global.UI.toast) global.UI.toast(roomRulesSummaryText(metaNow), 'ok');
        }
      }
    }
    /* v2.0.1 根因⑤：游戏页顶栏的连接指示必须跟着状态走 */
    paintLinkChip();
    paint();
  }

  /**
   * v2.12.2：重连预检发现房间已没了（KP 结团 / 关房 / 房间行被清理）时的收尾。
   *
   * 为什么单走一条：以前掉线后 WS 升级只会拿到 HTTP 410，浏览器报 1006，
   * 传输层判「非致命」一直退避重连 —— 界面永远停在「已离线，重连中…」，
   * 玩家永远等不到「房间已结束」，不离开房间、不回写角色卡（用户实测）。
   * 现在传输层探明房间没了会送 'ended' 状态到这里，走与 maybeDissolved
   * **完全相同**的收尾流程（玩家侧合成终态复用它，保证行为一致）。
   */
  function dissolveFromLink(reason) {
    if (!sess || sess.dissolveDone) return;
    try { if (global.UI && global.UI.closeAllSheets) global.UI.closeAllSheets(); } catch (e) { /* 忽略 */ }
    if (sess.role === 'kp') {
      /* KP 侧：房间没了（比如从别处关的、或被清理）→ 提示后回首页 */
      try { if (sess.side && sess.side.close) sess.side.close(); } catch (e) { /* 已断 */ }
      global.UI.toast(reason === 'gone' ? '房间记录已被清理' : '房间已结束', 'ok');
      stopLanIfHost();
      restoreOrientation();
      global.App.go('#/home');
      rerender();
      return;
    }
    /* 玩家侧：合成 CLOSED+ended 终态，复用 maybeDissolved 的全流程
       （回写临时卡 → 关面板 → 确认 → 回首页）。dissolveDone 防重入。 */
    try {
      if (sess.client && sess.client.state && sess.client.state.meta) {
        sess.client.state.meta.status = T().STATUS.CLOSED;
        sess.client.state.meta.ended = true;
      }
    } catch (e) { /* 忽略 */ }
    maybeDissolved(sess.client ? sess.client.state : null);
  }

  /**
   * KP 解散 / 结团后：玩家收到提示并退回首页（v1.18.5，用户需求）。
   *
   * 旧行为只是把状态标成 CLOSED，玩家停在房间页看着一块横幅
   * 「本次团已经结束」—— 像是「退到了未开游戏的状态」，不知道该干什么。
   * 需求 §9 结团一节：确认后把所有客户端带回 APP 首页。
   *
   * KP 自己不走这条（他知道自己刚点了结团）。
   */
  function maybeDissolved(st) {
    if (!sess || sess.role === 'kp' || sess.dissolveDone) return;
    if (!st || !st.meta || st.meta.status !== T().STATUS.CLOSED) return;
    sess.dissolveDone = true;
    /* v2.13.5（用户报 Bug）：结团后房间页最上方还挂着「回到游戏」。
       根因：玩家侧从来没有写过归档，也没清掉「未完结」标记 —— 本机 joined / 房间存档
       一直留着这个已结束的 code。这里补三件事：
         ① 玩家侧也写一份归档（顺带进「游戏历史记录」，结团后能回看）；
         ② 清掉这一局的房间存档（否则断线重连还会拿它去续）；
         ③ 若这局是自己开的，清掉 mine 记录。 */
    try {
      var RS0 = global.RoomStore || {};
      var c0 = ((st.meta && st.meta.code) || (sess && sess.code) || '').trim();
      if (c0) {
        var hasAr = (RS0.listArchive ? RS0.listArchive() : []).some(function (a) { return a && a.code === c0; });
        if (!hasAr && RS0.archive) RS0.archive(st, {});
      }
    } catch (e) { /* 归档/清理失败不拦回首页 */ }

    var msg = st.meta.ended ? 'KP 已解散房间，本次团到此结束。'
                            : '房间已被 KP 关闭。';
    /* v2.4.0（用户第 ⑦ 项）：结团 → 回首页前，把本机临时卡状态回写已保存角色卡
       （不拦回首页流程：回写失败只少一次 toast）。 */
    try {
      var RP = global.RoomPanels;
      var tc = (RP && RP.commitRoomTempCards) ? RP.commitRoomTempCards(sess.code) : null;
      if (tc && tc.ok) global.UI.toast(tc.ok + ' 张角色卡状态已回写', 'ok');
    } catch (e) { /* 忽略 */ }
    /* v2.2.2（用户第 10-2 项）：结团/关房时把玩家打开的**所有悬浮面板**一并关掉。
       此前只弹一个「回到首页」确认框，底层还压着玩家开着的角色卡 / 状态管理 / 素材
       等面板（它们是 append 到 body 的遮罩，切路由不会自动移除）→ 表现为「结团后
       面板不消失」。上批已修 KP 侧（room-panels.js#endSession）；这里补玩家侧。 */
    try { if (global.UI && global.UI.closeAllSheets) global.UI.closeAllSheets(); } catch (e) { /* 忽略 */ }
    try { if (sess.side && sess.side.close) sess.side.close(); } catch (e) { /* 已断就算了 */ }
    global.UI.confirm(msg, { okText: '回到首页', hideCancel: true }).then(function () {
      stopLanIfHost();
      /* v2.13.5：**确认之后再清**一次「未完结」标记 —— 结团瞬间客户端还在按周期写
         房间存档，清早了会被下一拍写回来（实测：清了还在）。此时连接已关，不会再有回写。 */
      try {
        var RS1 = global.RoomStore || {};
        var c1 = ((st.meta && st.meta.code) || (sess && sess.code) || '').trim();
        if (c1) {
          if (RS1.clearRoomSave) RS1.clearRoomSave(c1);
          var mine1 = RS1.getMine ? RS1.getMine() : null;
          if (mine1 && mine1.code === c1 && RS1.clearMine) RS1.clearMine();
          /* joined 里也把这个 code 剔掉（否则「回到游戏」还会从 joined 里冒出来） */
          if (RS1.listJoined && RS1.clearJoined && RS1.setJoined) {
            var keep = RS1.listJoined().filter(function (j) { return j && j.code && j.code !== c1; });
            RS1.clearJoined();
            keep.forEach(function (j) { RS1.setJoined(j); });
          }
        }
      } catch (e) { /* 忽略 */ }
      restoreOrientation();          // 离开游戏页 → 恢复竖屏（需求 §3）
      /* v2.13.5：清掉 sess —— 否则大厅仍认为这局「正在进行」，「回到游戏」又冒出来 */
      try { global.RoomUI.endLocalSession(); } catch (e) { /* 忽略 */ }
      global.App.go('#/home');
      rerender();
    });
  }

  /**
   * v2.2.2（用户第 10-2 项）：玩家被**移出房间**时的收尾。
   * room-net 收到 EVT.KICK 会把 sess.side.kicked 置成原因文案；此前客户端**从不消费**
   * 这个信号 —— 被踢的玩家仍停在房间页、开着的面板也不消失。这里补上：
   * 关闭全部悬浮面板 + 提示 + 回首页。
   */
  function maybeKicked() {
    if (!sess || sess.role === 'kp' || sess.kickDone) return;
    var reason = sess.side && sess.side.kicked;
    if (!reason) return;
    sess.kickDone = true;
    try { if (global.UI && global.UI.closeAllSheets) global.UI.closeAllSheets(); } catch (e) { /* 忽略 */ }
    try { if (sess.side && sess.side.close) sess.side.close(); } catch (e) { /* 忽略 */ }
    global.UI.confirm(String(reason) || '你已被移出房间', { okText: '回到首页', hideCancel: true }).then(function () {
      stopLanIfHost();
      restoreOrientation();
      global.App.go('#/home');
      rerender();
    });
  }

  /** 从本机记录恢复房主身份 */
  function resumeMine(mine) {
    /* v2.1.3（用户第 2 项 · KP 杀进程后回不到房间）：
       **本机内嵌服务开的房，服务本身就跑在这个进程里** —— 杀掉 App 等于把服务器
       也杀了，而续玩路径以前只是「拿存的地址去连」，于是永远连一个没人监听的端口
       （KP 与玩家同时卡在「正在重连」，玩家连的正是这台已死的服务）。
       所以：续玩前必须先把内嵌服务重新拉起来，并用**新返回的 base**（IP 可能已变，
       存的地址可能过期）。只有 `lan` 标记为真的房间才这么做 —— 公网房的服务在云端，
       不需要也不该在本机起服务。 */
    var L = global.RoomLan;
    var useBase = mine.serverBase;
    if (mine.lan && L && L.isApp()) {
      var r = L.start();
      if (!r.ok) {
        /* 拉不起来就**明确拦住**，不要带着一个死地址进房间 ——
           那正是用户看到的「一直正在重连」。这是阻塞性失败，用弹层而不是 toast。 */
        global.UI.confirm('本机房间服务没能启动（' + (r.error || '未知原因') +
          '），所以暂时回不到这间房。\n\n' +
          '请确认：① 手机已开「无线局域网」下本 App 的权限；② 本机有可用 WiFi 或热点。' +
          '若一直不行，可让房主用公网模式重开。',
          { okText: '知道了', hideCancel: true });
        return;
      }
      useBase = r.base || useBase;          // 用新地址：旧 IP 可能已被 DHCP 换掉
      if (r.wifi === false) {
        global.UI.toast('没连上 WiFi，同伴仍连不进这间房', 'err');
      }
    }
    sess = { resuming: true, role: 'kp', code: mine.code };
    // 用 hostToken 直接重连，不需要重新建房
    var T2 = T();
    var host = new M.Host({
      meta: { code: mine.code, name: mine.name, rules: 'coc7', status: T2.STATUS.RECRUITING }
    });
    var gen = ++sessGen;   // v2.0.3 缺陷2：本会话代号（旧 side 回调按代丢弃）
    var side = new N.HostSide({
      host: host,
      /* 同 startHost：WS 必须沿「上次成功那条路」回去，不用服务端推荐的域名 */
      room: { code: mine.code, wsUrl: N.wsUrlFor(useBase || N.activeBase(), mine.code, mine.hostToken),
              hostToken: mine.hostToken },
      onState: function (st, info) { onLinkState('kp', st, info, gen); },
      onError: function (msg) { if (isStaleSession(gen)) return; setBanner(sess, msg, 'err'); },
      /* v2.1.3：接线断线诊断（room-net 早就实现，但两处 connect() 从没传过 role/onDiag，
         结果诊断结果无处可去、用户只看到沉默的「正在重连」）。 */
      onDiag: onLinkDiag(gen),
      onPeer: function () { if (isStaleSession(gen)) return; paint(); }
    });
    sess = {
      role: T2.ROLE.KP, code: mine.code, host: host, client: null, side: side,
      meta: host.state.meta, startedAt: Date.now(), roomName: mine.name,
      lanHost: !!mine.lan,     /* 记住本房是本机开的，离开/收尾时才知道要不要停服务 */
      resuming: true          /* #10：KP 续玩等待态（同 reopenJoined） */
    };
    /* v2.2.2（用户第 1 项）：KP 续玩即刷新「我开的房」记录时间戳（at = 本次进入）。 */
    try { if (S && typeof S.setMine === 'function') S.setMine(mine); } catch (e) { /* 忽略 */ }
    side.open();
    global.App.go('#/room/' + mine.code);
    paint(true);
  }

  /** 重新进入最近加入过的房间（用本机存的 mtoken，座位不变） */
  function reopenJoined(rec) {
    var savedBase = N.base();
    // 该房间当初用的服务地址优先（他可能换了设置里的地址）
    var useBase = rec.serverBase || savedBase;
    if (!useBase) { global.UI.toast('缺少房间服务地址', 'err'); return; }
    global.ROOM_SERVER_BASE = useBase;   // 临时生效，让 wsBase 算出正确的地址
    /* v2.0.2 换座 Bug 修复：改走与「首次加入」同一条路径 N.wsUrlFor —— 它会带上
       &d=<deviceId>（设备码通道）。此前手拼 URL 漏了 d，服务端无法按设备认回原
       seat，重连时被当成新人发新座位（换座 Bug）。reopenJoined 是所有玩家续玩
       入口（入口页「继续」/云端存档「载入并续玩」/房内续玩）的公共汇聚点。 */
    var ws = N.wsUrlFor(useBase, rec.code, rec.mtoken);
    global.ROOM_SERVER_BASE = undefined;

    var T2 = T();
    var client = new M.Client({ seat: '', role: rec.role });
    var gen = ++sessGen;   // v2.0.3 缺陷2：本会话代号（旧 side 回调按代丢弃）
    var side = new N.PlayerSide({
      client: client,
      room: { code: rec.code, wsUrl: ws, mtoken: rec.mtoken, role: rec.role },
      onState: function (st, info) { onLinkState('player', st, info, gen); },
      onEvent: function (state, info) {
        if (isStaleSession(gen)) return;   // v2.0.3 缺陷2：旧会话的事件不得回灌新 sess
        if (info && info.kind === 'gap') {
          sess._gapFilling = true;
          setBanner(sess, '正在补齐记录…', 'warn');
          armGapBannerTimeout(sess);   /* v2.5.0（用户第 7 项·c）：4s 兜底，别无限挂 */
          return;
        }
        if (sess && sess._gapFilling) { sess._gapFilling = false; clearGapBannerTimeout(sess); setBanner(sess, ''); }
        maybeKicked();                     // v2.2.2（用户第 10-2 项）：被移出 → 关面板 + 回首页
        maybeDissolved(state);             // v2.2.2：结团/关房 → 关面板 + 回首页
        paint();
      },
      onSheetApply: onSheetApplyDiag(gen),
      /* v2.9.0（用户第 1 项）：续玩 / 重连路径同样接线（KP 推进回合时的自动生效提示） */
      onTempCommit: onTempCommitNotify(gen),
      onDiag: onLinkDiag(gen),
      onError: function (msg) { if (isStaleSession(gen)) return; setBanner(sess, msg, 'err'); },
      /* v2.12.2：续玩进了一间已结束的房间 → 走收尾，不卡在重连循环 */
      onEnded: function (reason) { if (isStaleSession(gen)) return; dissolveFromLink(reason); }
    });
    sess = {
      role: rec.role, code: rec.code, host: null, client: client, side: side,
      meta: client.state.meta, startedAt: Date.now(), nickname: rec.nickname,
      resuming: true          /* #10：续玩等待态（渲染时显示「正在回到房间…」，online 后清） */
    };
    /* v2.2.2（用户第 1 项）：重连/续玩即刷新本机记录时间戳，使 at = 「最近一次真正进入」。 */
    touchJoinedCode(rec.code);
    side.open();
    global.App.go('#/room/' + rec.code);
    paint(true);
  }

  /* ============================================================
   * 房间页 #/room/<code>
   * ============================================================ */

  var pageRefs = null;

  function renderRoom(code) {
    if (!sess || sess.code !== code) {
      /* ============================================================
       * v2.1.10（用户第 2 项）：**房间号不一致**导致杀进程 / 掉线后回不去。
       *
       * 旧行为：只要 `sess.code !== code` 就无条件 `sess = null` 并把页面
       *   变成「还没有加入这个房间 → 加入房间」。而杀进程重启后地址栏里的
       *   房间号常常是**上一个房间 / 旧邀请链接**的号，于是玩家拿着错号去
       *   重新加入：要么连不上，要么被当成新人换座 —— 而「未完结的团 → 继续」
       *   走的是本机记录里的正确房间号，所以那条路一直是好的。
       *
       * 新行为（按可靠性从高到低找房间，只有全都对不上才让人手动加入）：
       *   ① 已有活会话且号不符 → 以**会话**为准，把路由纠正回正在玩的房间；
       *   ② 本机有该号的座位凭据（joined）→ 直接用 mtoken 重连，座位不变；
       *   ③ 该号就是我开的房（mine）→ 用 hostToken 续玩；
       *   ④ 都对不上 → 保持「加入房间」入口，但把本机**未完结的团**列出来，
       *      让用户一眼看到「你机器上正在进行的其实是 XXXX」。
       * ============================================================ */
      if (sess && sess.code && sess.code !== code) {
        global.UI.toast('已回到你正在进行的房间 ' + sess.code, 'warn', 3200);
        global.App.go('#/room/' + sess.code);
        return el('div');
      }

      var RS = global.RoomStore || {};
      var joinedRec = (RS.getJoined && RS.getJoined(code)) || null;
      if (joinedRec && joinedRec.mtoken) {
        /* ② 本机有座位凭据：自动重连（不发新座、不要求重新输名字） */
        setTimeout(function () { reopenJoined(joinedRec); }, 0);
        return el('div.card', null, [
          el('div.card-title', { text: '正在回到房间 ' + code }),
          el('div.small.dim', { text: '用本机保存的座位凭据重连中…（无需重新加入）' })
        ]);
      }
      var mineRec = (RS.getMine && RS.getMine()) || null;
      if (mineRec && mineRec.code === code) {
        /* ③ 这是我自己开的房：以房主身份续玩。
           v2.13.6（用户报「KP 锁屏解锁后玩家被结团」）：必须走 resumeRoomImpl
           —— 它会额外「拉服务端存档 → adoptSave」。以前这里只调 resumeMine，
           造出一个**空 Host**：成员表没有技能、房间状态被刷回招募中，
           玩家那边的 HP/SAN/角色卡全丢（安卓锁屏后 WebView 重载正是这条路）。 */
        setTimeout(function () { resumeRoomImpl(code); }, 0);
        return el('div.card', null, [
          el('div.card-title', { text: '正在回到房间 ' + code }),
          el('div.small.dim', { text: '以房主身份续玩中…（正在恢复本局进度）' })
        ]);
      }

      /* ④ 确实没有这个房间的记录 → 保留手动加入，并把本机在玩的房间列出来对照 */
      sess = null; pageRefs = null; detachGridListeners();
      var unfinished = (RS.listUnfinished && RS.listUnfinished()) || [];
      var wrap = el('div');
      /* v2.2.1（用户第 8 项）：先给一个**权威纠偏**入口 —— 本机记录里正在进行的房间号
         才是准的；地址栏里的号常常是旧邀请 / 上次的房间。一键回到正确的房。 */
      var authMiss = authoritativeRoom();
      if (authMiss && authMiss.code && authMiss.code !== code) {
        wrap.appendChild(el('div.card.gp-rejoin', null, [
          el('div.card-head', null, [el('h3', { text: '回到游戏' })]),
          el('div.small.dim', {
            text: '地址里的房间号（' + code + '）不是本机正在进行的房间。' +
                  '本机记录里在进行的是 ' + authMiss.code + '（' +
                  (authMiss.role === 'kp' ? 'KP' : (authMiss.role === 'spectator' ? '旁观' : '玩家')) + '）。'
          }),
          el('button.btn.primary.block', {
            text: '回到游戏（' + authMiss.code + '）', style: { marginTop: '10px' },
            onclick: function () { resumeRoomImpl(authMiss.code); }
          })
        ]));
      }
      if (unfinished.length) {
        var other = el('div.card', null, [
          el('div.card-title', { text: '房间号不一致？' }),
          el('div.tiny.dim', {
            text: '地址里的房间号（' + code + '）不在本机记录中。以下是本机记录里还没结团的房间：'
          })
        ]);
        unfinished.slice(0, 5).forEach(function (r) {
          other.appendChild(el('div.occ-item', null, [
            el('div.grow', null, [
              el('div.nm', { text: r.name || ('房间 ' + r.code) }),
              el('div.meta', { text: (r.role === 'kp' ? 'KP' : (r.role === 'spectator' ? '旁观' : '玩家')) +
                ' · 房间号 ' + r.code })
            ]),
            el('button.btn.sm.primary', {
              text: '回到这个房间',
              onclick: function () { resumeRoomImpl(r.code); }
            })
          ]));
        });
        wrap.appendChild(other);
      }
      wrap.appendChild(el('div.card', null, [
        el('div.card-title', { text: '房间 ' + code }),
        el('div.small.dim', { text: '还没有加入这个房间。点下面输入名字即可加入。' }),
        el('button.btn.primary.block', {
          text: '加入房间', onclick: function () { joinSheet(code, ''); }
        }),
        el('button.btn.ghost.block', {
          text: '返回', style: { marginTop: '8px' }, onclick: function () { global.App.goHome(); }
        })
      ]));
      return wrap;
    }

    var T2 = T();
    var st = currentState();
    var inGame = !!(st && st.meta && st.meta.status === T2.STATUS.IN_GAME);

    /* v1.18.5（用户需求 + 需求 §5）：正式开团后切换到**独立的游戏界面**
       （平铺布局），不再是「房间页下面多出一些信息条」。招募页保持原样。 */
    if (inGame) return renderGamePage(st);
    /* 非游戏页（招募中 / 已结束）→ 恢复竖屏（需求 §3） */
    restoreOrientation();

    var bannerEl = el('div.room-banner');
    pageRefs = {
      root: el('div.room-page'),
      isGame: false,
      bannerEl: bannerEl,
      headEl: el('div'),
      membersEl: el('div'),
      panelEl: el('div'),          // P4-P6：探索 / 战斗 / KP 工具
      diceEl: el('div'),           // 掷骰工具条
      logEl: el('div.room-log'),
      statusEl: el('div')
    };

    pageRefs.root.appendChild(pageRefs.headEl);
    pageRefs.root.appendChild(bannerEl);
    pageRefs.root.appendChild(pageRefs.membersEl);
    pageRefs.root.appendChild(pageRefs.panelEl);
    pageRefs.root.appendChild(pageRefs.diceEl);
    pageRefs.root.appendChild(pageRefs.statusEl);
    pageRefs.root.appendChild(pageRefs.logEl);
    pageRefs.root.appendChild(chatBar());

    paint(true);
    /* #10：续玩等待态 —— 在**本页渲染时**设，才能写到新页的横幅元素上（导航是异步的，
       resumeRoom 里同步 setBanner 会写到旧页）。连上后由 onLinkState('online') 清掉。 */
    if (sess && sess.resuming && sess.linkState !== 'online') {
      setBanner(sess, resumeBannerText(), 'warn');
    }
    if (st && st.meta.status === T2.STATUS.CLOSED) {
      setBanner(sess, '本次团已经结束（房间已关闭）', 'warn');
    }
    return pageRefs.root;
  }

  /**
   * 游戏界面（v2.0.0：按身份拆成 KP / PL 两套固定分区骨架，见
   * buildKpSkeleton / buildPlSkeleton；下面这段是旧版单列布局的备忘）：
   *
   *   ┌──────────────────────────────┐
   *   │ ① KP 栏（身份突出 · 模式 · 👁旁观 · 离开）│
   *   ├──────────────────────────────┤
   *   │ ② 玩家栏横排（HP/SAN · 手绘板笔数 · 点开详情）│
   *   ├──────────────────────────────┤
   *   │ ③ 中央大图（地图/场景，KP 可标可画）      │
   *   ├──────────────────────────────┤
   *   │ ④ 游戏记录（检定/伤害/状态/场景，独立滚动）│
   *   ├──────────────────────────────┤
   *   │ ⑤ 聊天（与记录分开）+ 待办请求卡        │
   *   ├──────────────────────────────┤
   *   │ ⑥ 常驻工具栏（D100 突出 + D4/6/8/10 + 工具）│
   *   └──────────────────────────────┘
   *
   * 小屏用 flex 纵排、各区域内部滚动（响应式降级：本质上和 §5 的
   * 「两侧玩家栏」在窄屏上合并为横排条 —— 硬要左右两列会把中央图
   * 挤到不可用，§5 自己也要求「小屏不能把核心按钮挤出可视区域」）。
   */
  function renderGamePage(st) {
    var T2 = T();
    var isKp = !!(sess && sess.role === T2.ROLE.KP);
    /* v2.1.1（用户第三轮反馈）：**取消**「进入游戏页强制横屏」—— 游戏页改为
       跟随系统旋转，不再向原生请求 landscape（详见 applyOrientation 注释）。 */

    /* v2.0.1 根因④：上一次游戏页可能挂了 resize/orientationchange 监听，
       重建前先摘掉，避免多实例泄漏（R4）。 */
    detachGridListeners();

    var bannerEl = el('div.room-banner');
    var root = el('div.game-page' + (isKp ? '.gp-kp' : '.gp-pl'));
    var zoomEl = el('div.gp-zoom');
    var privEl = el('div.gp-priv');
    pageRefs = {
      root: root, isGame: true, skel: isKp ? 'kp' : 'pl',
      bannerEl: bannerEl, zoomEl: zoomEl, privEl: privEl, panelEl: el('div')
    };

    if (isKp) buildKpSkeleton(pageRefs, zoomEl);
    else buildPlSkeleton(pageRefs, zoomEl);

    root.appendChild(zoomEl);
    /* v2.0.10（用户第 1 项后半）：工具栏**移出** .gp-zoom —— transform:scale() 会生成
       containing block，使其中 position:sticky 失效（放大后底栏随内容漂走 / 点不到）。
       挂到 .game-page（缩放容器之外）后，--gp-zoom≠1 时底栏仍贴视口底、位置不变。 */
    if (pageRefs.diceEl) root.appendChild(pageRefs.diceEl);
    bindPinchZoom(root);
    /* v2.1.7：恢复用户保存的缩放偏好；没有偏好时才走自动缩放（手机横屏 82%） */
    var savedZoom = null;
    try { savedZoom = parseFloat(localStorage.getItem('coc7_ui_zoom')); } catch (e) { savedZoom = null; }
    /* v2.1.7：存了「≠100%」才算用户偏好（100% 与无偏好同等对待，自动缩放仍可用） */
    if (isFinite(savedZoom) && savedZoom > 0 && Math.abs(savedZoom - 1) > 1e-6) {
      zoomState.autoApplied = true;   // 用户明确设置过 → 不再自动改
      setZoom(savedZoom);
    } else {
      setZoom(1);
    }
    attachGridListeners();
    maybeAutoZoom();

    paint(true);
    /* #10：续玩等待态（渲染时设，写到本页横幅；online 后清）。
       v2.1.1：文案按 sess.joinKind 区分「正在重连…」/「加入中…」。 */
    if (sess && sess.resuming && sess.linkState !== 'online') {
      setBanner(sess, resumeBannerText(), 'warn');
    }
    return root;
  }

  /* ============================================================
   * v2.0.1 T14：网格模式开关 —— **唯一阈值来源**
   *
   * 架构师复核发现：修复初期「网格结构」同时依赖 CSS 主 @media(520/820)
   * 和 CSS 降级 @media(520–599/max-h 339) 与这里，靠三者阈值恰好互补才自洽，
   * 任何一条单独改动都会退化成「display:grid 列宽 + height:auto」的爆炸态。
   * 现已收敛：**app.css 里网格规则不再挂 @media**，全部改挂 `.game-page.gp-grid`；
   * 所以「网格 / 单列」由这里的 applyGridClass() **独家决定**，CSS 不再二次判定。
   *
   * 判定（与设计 §1.9 方案 A 一致）：
   *   grid = 横屏且够宽(或竖屏超宽) 且 宽∉[520,599] 且 高≥290
   *        = (landscape && w>=520) || w>=820
   *          且 !(w>=520 && w<=599) 且 h>=290
   *   （v2.1.3：高下限 340→290，让手机横屏也能进网格；矮屏行高由
   *     app.css 的 @media(max-height:360) 收紧，避免子区域溢出）
   * ⚠️ 前提：`.gp-grid` 在 = 网格；不在 = 单列兜底。二者互斥。
   * 改这里的任一个数字都必须同步 tools/test_room_ui.py §3.5 的 E1–E4。
   * ============================================================ */
  var GP_GRID_MIN_W = 520;        /* 横屏网格最小宽 */
  var GP_GRID_SINGLE_MAX_W = 599; /* 520–599：太窄塞不下 → 单列 */
  var GP_GRID_WIDE_W = 820;       /* 竖屏超宽（如平板竖屏）也给网格 */
  /* v2.1.3（用户第 1 项 · 手机横屏「横不过来」）：
     原值 340 把**手机横屏**整类挡在网格之外 —— 手机横屏扣掉状态栏/导航栏后
     可用高常为 300–330（探针实测 780×320 / 640×300 / 700×330 全部判为单列），
     于是「手机转横屏了，布局还是竖屏一样」。
     降到 290（配合 CSS 里 @media(max-height:360) 的矮屏行高收紧，见 app.css）
     —— 探针 `tools/_probe_layout.py` 实测：290 起手机横屏全部进网格，
     且矮屏行高收紧后 main 不再溢出（340 档下 h=300 会溢出 12px）。
     ⚠️ 改这个数必须同步 tools/test_room_ui.py 的 E3/E4 与那句内联阈值。 */
  /* v2.1.7（用户第 5 项）：手机横屏**重新进网格**（和平板横屏同一套布局），
     挤的问题改由「UI 缩放百分比设置」解决（见 setZoom / openZoomSheet）——
     用户可把整页 UI 缩到 60–90%，让三/五栏都能完整显示，而不是退回单列。
     v2.1.6 曾把 MIN_H 提到 500（回退单列），用户实测后要求改回网格方案。 */
  var GP_GRID_MIN_H = 290;        /* 高 < 290（极矮横屏）→ 单列 */
  var GP_GRID_COMPACT_H = 360;    /* 高 ≤ 360：网格行高下限收紧（手机横屏档） */

  function applyGridClass() {
    if (!pageRefs || !pageRefs.isGame || !pageRefs.root) return;
    var w = global.innerWidth || 0, h = global.innerHeight || 0;
    var landscape = w > h;
    var wideEnough = (landscape && w >= GP_GRID_MIN_W) || (w >= GP_GRID_WIDE_W);
    var tooNarrow = (w >= GP_GRID_MIN_W && w <= GP_GRID_SINGLE_MAX_W);
    var on = wideEnough && !tooNarrow && (h >= GP_GRID_MIN_H);
    pageRefs.root.classList.toggle('gp-grid', on);
    /* v2.1.3：矮横屏（手机横屏）额外收紧行高下限，否则 96+48 的旧下限会把 .gp-main 顶破。
       用**类**而不是 @media —— 结构判定必须只有一个真相源（见 app.css 同处注释）。 */
    pageRefs.root.classList.toggle('gp-compact', on && h <= GP_GRID_COMPACT_H);
    syncToolbarReserve();
  }

  var _gridResizeHandler = null;
  function attachGridListeners() {
    if (_gridResizeHandler) return;
    _gridResizeHandler = function () { applyGridClass(); };
    applyGridClass();
    global.addEventListener('resize', _gridResizeHandler);
    global.addEventListener('orientationchange', _gridResizeHandler);
  }
  function detachGridListeners() {
    if (!_gridResizeHandler) return;
    global.removeEventListener('resize', _gridResizeHandler);
    global.removeEventListener('orientationchange', _gridResizeHandler);
    _gridResizeHandler = null;
  }

  /* ============================================================
   * 两套分区骨架（契约 §8.1 / §8.2）
   *
   * F1 只负责「建容器 + 按身份挂载 + 调用 F2 的函数」。
   * ⚠️ 保留 .gp-kpbar / .gp-center / .gp-glog / .gp-chat / .gp-players /
   *    .gp-status / .gp-toolbar / .room-chatbar 这些既有类名 —— 旧断言依赖它们。
   * ⚠️ 聊天输入行只建一次（需求 §5.9：全屏查看 / 来回切换不能丢正在输入的话）。
   * ============================================================ */

  /* ============================================================
   * v2.1.1（用户定稿线框）：右列两块「可折叠」小盒子的状态。
   * v2.2.0（用户第 2 项）：**泛化为任意 region key** —— 竖屏各栏目都可收起。
   *
   * 状态存进 RoomPanels._state（room-panels.js 已冻结、不可改，但 `_state`
   * 就是它内部 UI_STATE 的**同一个对象引用**）—— 满足「持久化在 UI_STATE 里」，
   * 跨 paint 保持；无 RoomPanels 时退回本模块的兜底对象（不影响渲染）。
   * 默认全部展开（undefined 视作 false），用户收起后本会话保持（不落盘）。
   * ============================================================ */
  var _foldFallback = {};

  /* v2.2.1（用户第 1 项）：全屏查看信息流期间的冻结态。
     非 null 表示当前正有一个信息流处于全屏：{ kind, key, title, wasFolded, inlineEl, prevInline }。
     作用：① 全屏期间**冻结**该栏目的折叠开关（点不动、也不写回会话折叠态）；
           ② 退出全屏时**还原**进入前的折叠态（不把临时展开写回用户会话）；
           ③ 同一时刻只允许一个全屏（防「套娃」覆盖层）。 */
  var _fs = null;

  /* v2.13.8（用户需求）：「只给你看的信息」全屏查看态。
     非 null 表示私密卡正整体搬在 .gp-fs--priv 覆盖层里：{ card, placeholder, ov }。
     与 _fs（聊天/记录全屏）互相独立但**同一时刻只允许一个**（各自入口都会检查对方）。 */
  var _fsPriv = null;

  function foldState() {
    var s = (global.RoomPanels && global.RoomPanels._state) || null;
    return s || _foldFallback;
  }
  function isFolded(key) { return !!foldState()[key]; }
  function toggleFold(key) {
    /* v2.2.1（用户第 1 项）：全屏查看中的栏目**冻结**折叠 —— 避免「全屏里还能收起，
       收起后内容消失、只剩标题、退不出全屏」的连环坑。 */
    if (_fs && _fs.key === key) return;
    var s = foldState(); s[key] = !s[key]; paint(false);
  }

  /** 折叠盒的标题栏（点击 → 收起 / 展开）。`extra` 可传 'gp-fold-portrait' 等修饰类。 */
  function foldHeader(title, key, extra) {
    return el('button.gp-region-fold.tiny' + (extra ? ('.' + extra) : ''), {
      text: (isFolded(key) ? '▸ ' : '▾ ') + title,
      title: '点击收起 / 展开',
      onclick: function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); toggleFold(key); }
    });
  }

  /** 每次 paint 同步折叠盒的类名与标题文案（骨架只建一次，状态可能已被点开）。 */
  function syncFoldRegion(regionEl, key, base) {
    if (!regionEl) return;
    var f = isFolded(key);
    regionEl.classList.toggle('folded', f);
    var h = regionEl.querySelector('.gp-region-fold');
    if (h) h.textContent = (f ? '▸ ' : '▾ ') + base;
    /* v2.2.0：聊天 / 记录栏的折叠开关内嵌在标题栏里（见 attachFoldHeaders）。 */
    var ib = regionEl.querySelector('.gp-region-fold--inline');
    if (ib) ib.textContent = f ? '▸' : '▾';
  }

  /** v2.2.0：在已有「标题栏」（.gp-region-head）里注入一个内嵌折叠开关（幂等）。 */
  function ensureInlineFold(head, key) {
    if (!head || head.querySelector('.gp-region-fold--inline')) return;
    var btn = el('button.gp-region-fold--inline.gp-fold-portrait', {
      text: isFolded(key) ? '▸' : '▾', title: '收起 / 展开',
      onclick: function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); toggleFold(key); }
    });
    head.insertBefore(btn, head.firstChild);
  }

  /** v2.2.0：给竖屏栏目补一个独立折叠标题（幂等；每次 paint 因 mountPanel 清空而重建）。 */
  function ensureFoldHeader(region, key, title) {
    if (!region) return;
    if (region.querySelector('.gp-region-fold')) return;      // 已有（combat/players 骨架自带）
    region.insertBefore(foldHeader(title, key, 'gp-fold-portrait'), region.firstChild);
  }

  /**
   * v2.2.0（用户第 2 项）：为竖屏各栏目注入折叠标题（骨架建一次 / 每次 paint 幂等校准）。
   * ⚠️ 折叠标题带 `gp-fold-portrait` 修饰类 → 横屏网格态由 CSS 隐藏，保证 .gp-grid 零回归。
   */
  function attachFoldHeaders() {
    if (!pageRefs) return;
    var isKp = pageRefs.skel === 'kp';
    var rows = isKp ? [
      { r: pageRefs.centerEl,  k: 'foldMap',    t: '🗺 公开素材' },
      { r: pageRefs.sceneEl,   k: 'foldScene',  t: '🎬 场景检定' },
      { r: pageRefs.combatEl,  k: 'foldCombat', t: '⚔️ 战斗列表 · 怪物信息' },
      { r: pageRefs.playersEl, k: 'foldPlayers', t: '👥 玩家信息' },
      { r: pageRefs.chatEl,    k: 'foldChat',   t: '💬 聊天',     head: pageRefs.chatHeadEl },
      { r: pageRefs.logEl,     k: 'foldLog',    t: '📜 游戏记录', head: pageRefs.logHeadEl }
    ] : [
      { r: pageRefs.cardEl,   k: 'foldCard',   t: '🧑 我的角色卡' },
      { r: pageRefs.centerEl, k: 'foldMap',    t: '🗺 公开素材' },
      { r: pageRefs.combatEl, k: 'foldCombat', t: '⚔️ 战斗列表' },
      { r: pageRefs.matesEl,  k: 'foldMates',  t: '👥 队友信息' },
      { r: pageRefs.sceneEl,  k: 'foldScene',  t: '🎬 场景检定' },
      { r: pageRefs.chatEl,   k: 'foldChat',   t: '💬 聊天',     head: pageRefs.chatHeadEl },
      { r: pageRefs.logEl,    k: 'foldLog',    t: '📜 游戏记录', head: pageRefs.logHeadEl },
      { r: pageRefs.notesEl,  k: 'foldNotes',  t: '📝 笔记栏' },
      { r: pageRefs.sketchEl, k: 'foldSketch', t: '✏️ 我的手绘板' }
    ];
    rows.forEach(function (row) {
      if (!row.r) return;
      if (row.head) ensureInlineFold(row.head, row.k);
      else ensureFoldHeader(row.r, row.k, row.t);
      syncFoldRegion(row.r, row.k, row.t);
    });
  }

  /**
   * KP 骨架（v2.1.1 用户定稿线框 · 12 块）。
   *
   *   块1 .gp-topbar（全宽）
   *   ┌ .gp-main-kp（4 列 × 2 行）
   *   │  行1：块2 left(≈55) | 块3 tools(≈80) | 块4 map(16:9，中心) | 右列
   *   │  行2：块8 chat | 块9 log（等宽两栏，只占左+中）              | 右列
   *   └ 右列 .gp-region-kp-right（跨两行）：
   *        块5 scene(上) → 块6 combat(可折叠)｜块7 players(可折叠)（中，并排）
   *        → 空档(gp-right-foot) → 块10 priv（绝对定位底图，上沿伸到 6/7 之下）
   *   块11 .gp-toolbar（全宽，由 renderGamePage 挂到 .game-page —— 缩放容器之外）
   *
   * ⚠️ 保留旧类名（.gp-region-kp-* / .gp-status 等）—— 旧断言依赖。
   * ⚠️ 每块是**独立** DOM 容器，绝不把 5/6/7/8/9/10 合并成一个节点。
   */
  function buildKpSkeleton(refs, host) {
    refs.headEl = el('div.gp-topbar.gp-kpbar');                      // 块1

    /* 块2 / 块3：**两个独立窄列**（用户线框 ≈55px / ≈80px） */
    refs.leftEl = el('div.gp-region.gp-region-kp-left');
    refs.leftIconsEl = el('div.gp-left-icons');
    refs.leftEl.appendChild(refs.leftIconsEl);

    refs.toolsEl = el('div.gp-region.gp-region-kp-tools');
    refs.toolsBodyEl = el('div.gp-region-body');
    refs.toolsEl.appendChild(refs.toolsBodyEl);

    /* 块4：中心 —— 公开素材（16:9）+ 战斗轮次信息（仅战斗模式，由 F2 的 kpMapArea 输出） */
    refs.centerEl = el('div.gp-region.gp-region-kp-map.gp-center');

    /* 右列容器（跨两行）：块5 / 块6 / 块7 / 块10 */
    refs.rightEl = el('div.gp-region.gp-region-kp-right');

    refs.sceneEl = el('div.gp-region.gp-region-kp-scene');           // 块5（右列上部）
    refs.sceneBodyEl = el('div.gp-region-body');
    refs.sceneEl.appendChild(refs.sceneBodyEl);

    refs.rightMidEl = el('div.gp-right-mid');                        // 块6｜块7（并排）
    refs.combatEl = el('div.gp-region.gp-region-kp-combat');         // 块6（可折叠）
    refs.combatBodyEl = el('div.gp-region-body');
    refs.combatEl.appendChild(foldHeader('⚔️ 战斗列表 · 怪物信息', 'foldCombat'));
    refs.combatEl.appendChild(refs.combatBodyEl);

    refs.playersEl = el('div.gp-region.gp-region-kp-players.gp-players'); // 块7（可折叠）
    refs.playersBodyEl = el('div.gp-region-body');
    refs.playersEl.appendChild(foldHeader('👥 玩家信息', 'foldPlayers'));
    refs.playersEl.appendChild(refs.playersBodyEl);

    refs.rightMidEl.appendChild(refs.combatEl);
    refs.rightMidEl.appendChild(refs.playersEl);

    refs.rightFootEl = el('div.gp-right-foot');                      // 空档：露出块10 可见带
    refs.rightEl.appendChild(refs.sceneEl);
    refs.rightEl.appendChild(refs.rightMidEl);
    refs.rightEl.appendChild(refs.rightFootEl);
    /* 块10：只给你看的信息 —— 绝对定位、底对齐、z-index 最低（上沿伸到 6/7 之下）。
       v2.0.1 根因⑥(b)：线索常驻游戏页；v2.1.1 由全宽条改为右列底图层。 */
    if (refs.privEl) refs.rightEl.appendChild(refs.privEl);

    /* 块8 + 块9：底部一行（等宽两栏，只占左+中宽度） */
    refs.infoEl = el('div.gp-info');
    refs.chatEl = el('div.gp-region.gp-region-kp-chat.gp-chat');
    refs.chatListEl = el('div.gp-chat-list');
    refs.logEl = el('div.gp-region.gp-region-kp-log.gp-glog');
    /* v2.2.0（用户第 1 项）：两块各挂一个标题栏（含全屏按钮）。 */
    refs.chatHeadEl = feedHead('💬 聊天', 'chat');
    refs.logHeadEl = feedHead('📜 游戏记录', 'log');
    refs.infoEl.appendChild(refs.chatEl);
    refs.infoEl.appendChild(refs.logEl);

    refs.statusEl = el('div.gp-status');
    refs.diceEl = el('div.gp-toolbar');                              // 块11
    /* 兼容占位：旧版「探索模式全宽细条」已废弃 → 空 → CSS 隐藏（旧断言仍能取到节点）。 */
    refs.combatStripEl = el('div.gp-combat-strip');

    var main = el('div.gp-main.gp-main-kp');
    [refs.leftEl, refs.toolsEl, refs.centerEl, refs.rightEl, refs.infoEl]
      .forEach(function (n) { main.appendChild(n); });

    host.appendChild(refs.headEl);
    host.appendChild(refs.bannerEl);
    host.appendChild(refs.combatStripEl);
    host.appendChild(main);
    host.appendChild(refs.statusEl);
    /* 注：refs.diceEl（工具栏）由 renderGamePage 挂到 root —— 缩放容器之外 */

    refs.chatEl.appendChild(refs.chatHeadEl);
    refs.chatEl.appendChild(refs.chatListEl);
    refs.chatEl.appendChild(chatBar());
  }

  /** PL 骨架（v2.0.10）：与 KP **同构**（同 4 栏 + 3 栏结构），差异只在「栏内放什么」。
        左栏=我的角色卡 / 公开素材 / 战斗列表(玩家视角) / 队友列表；.gp-info 3 栏同 KP。
      ⚠️ 保留旧类名（.gp-region-pl-card/-map/-feeds/-mates/-bottom、.gp-glog、.gp-chat）*/
  function buildPlSkeleton(refs, host) {
    refs.headEl = el('div.gp-topbar.gp-kpbar');

    refs.cardEl = el('div.gp-region.gp-region-pl-card');              // 我的角色卡（左列）
    refs.centerEl = el('div.gp-region.gp-region-pl-map.gp-center');   // 公开素材（16:9）
    refs.combatEl = el('div.gp-region.gp-region-pl-combat');          // 战斗列表（战斗模式显示）
    refs.matesEl = el('div.gp-region.gp-region-pl-mates.gp-players'); // 队友列表（含手绘板翻页）

    /* ============================================================
     * v2.1.6（用户布局图重排）玩家网格三列：
     *   左列 = 角色信息面板
     *   中列 = 公开素材(16:9)+战斗轮次条 / 聊天|游戏公开记录 并排 / 只给你看的信息
     *   右列 = 场景检定|队友信息 并排 / 笔记栏
     * 「只给你看的信息」移进 main：网格时占中列底行；单列时 order:-1 置顶
     *   （保持竖屏「顶部常驻线索条」的既有体验）。
     * ============================================================ */
    refs.mapWrapEl = el('div.gp-pl-mapwrap');          // 素材 + 战斗轮次条
    refs.infoEl = el('div.gp-info.gp-pl-inforow');     // 聊天 | 记录（并排；旧类名 .gp-info 保留给断言）
    refs.chatEl = el('div.gp-region.gp-region-pl-chat.gp-chat');
    refs.chatListEl = el('div.gp-chat-list');
    refs.feedsEl = el('div.gp-region.gp-region-pl-feeds');
    refs.logEl = el('div.gp-region.gp-region-pl-log.gp-glog');
    refs.sceneEl = el('div.gp-region.gp-region-pl-scene');
    /* v2.2.0（用户第 1 项）：两块各挂一个标题栏（含全屏按钮）。 */
    refs.chatHeadEl = feedHead('💬 聊天', 'chat');
    refs.logHeadEl = feedHead('📜 游戏记录', 'log');
    refs.feedsEl.appendChild(refs.logEl);
    refs.infoEl.appendChild(refs.chatEl);
    refs.infoEl.appendChild(refs.feedsEl);
    refs.chatEl.appendChild(refs.chatHeadEl);
    refs.chatEl.appendChild(refs.chatListEl);
    refs.chatEl.appendChild(chatBar());

    /* v2.13.4（用户第 1/3 项）：右列改成一条竖队 ——
         场景检定 → 队友栏（可收起）→ 只给你看的信息（同尺寸）→ 手绘板 → 笔记栏
       row1 现在只装场景检定（历史类名 .gp-pl-row1 保留，避免动 .gp-grid 规则计数）。 */
    refs.row1El = el('div.gp-pl-row1');
    refs.row1El.appendChild(refs.sceneEl);
    /* ============================================================
     * v2.1.8（用户玩家线框 12 块）：右列块序 = 场景检定|队友信息（并排）
     *   → 手绘板（独立块）→ 笔记栏。
     * 「手绘板」此前是 plTeammates 面板（room-panels.js 已冻结）输出里的
     * 一段（标题「我的手绘板」+ .mini-board），没有独立容器 —— 这里在骨架层
     * 给它**独立 DOM 块**，paintPlRegions 再把那段 DOM 移进来（见
     * splitSketchIntoOwnBlock：只挪节点，不改冻结文件）。
     * ============================================================ */
    refs.sketchEl = el('div.gp-region.gp-pl-sketch');  // v2.1.8 新增：手绘板（独立块）
    refs.sketchBodyEl = el('div.gp-region-body');
    refs.sketchEl.appendChild(refs.sketchBodyEl);
    refs.notesEl = el('div.gp-region.gp-pl-notes');    // v2.1.6 新增：笔记栏
    refs.rightColEl = el('div.gp-pl-right');
    refs.rightColEl.appendChild(refs.combatEl);
    refs.rightColEl.appendChild(refs.row1El);      // 场景检定
    refs.rightColEl.appendChild(refs.matesEl);     // 队友栏：紧贴场景检定栏
    if (refs.privEl) refs.rightColEl.appendChild(refs.privEl);  // 只给你看的信息：紧贴队友栏
    /* v2.13.8（用户需求）：玩家右列的私密条带标题栏 + ⛶ 全屏按钮（见 paintPrivates /
       fullscreenPriv）。KP 视角不置位 → 保持旧的「一张自带标题的卡」形态，零回归。 */
    refs.privWithFs = true;
    refs.rightColEl.appendChild(refs.sketchEl);
    refs.rightColEl.appendChild(refs.notesEl);

    refs.statusEl = el('div.gp-status');
    /* 底栏 = 工具栏（挂到 root，缩放容器之外）；保留 .gp-region-pl-bottom 旧类名 */
    refs.bottomEl = el('div.gp-region.gp-region-pl-bottom.gp-toolbar');
    refs.diceEl = refs.bottomEl;          // 兼容旧引用（骰子条挂在底栏）
    /* v2.0.10（第 8 项）：探索模式下战斗列表收进这条全宽细条（贴合 KP 同构）。 */
    refs.combatStripEl = el('div.gp-combat-strip');

    refs.mapWrapEl.appendChild(refs.centerEl);
    refs.mapWrapEl.appendChild(refs.combatStripEl);

    var main = el('div.gp-main.gp-main-pl');
    main.appendChild(refs.cardEl);
    main.appendChild(refs.mapWrapEl);
    main.appendChild(refs.infoEl);
    /* v2.13.4（用户第 3 项）：「只给你看的信息」不再挂在中列底，改为右列里
       队友栏正下方的一块同等大小的条（见上面 rightColEl 的挂载顺序）。
       竖屏（单列）下仍由 CSS 把它提前到顶部常驻 —— 选择器见 app.css。 */
    main.appendChild(refs.rightColEl);

    host.appendChild(refs.headEl);
    host.appendChild(refs.bannerEl);
    host.appendChild(main);
    host.appendChild(refs.statusEl);
    /* 注：refs.diceEl（底栏/工具栏）由 renderGamePage 挂到 root */
  }

  /* ---------------- 分区渲染：优先用 F2 的面板函数，缺失时退回既有面板 ---------------- */

  /**
   * 把某个区域交给 F2 的函数渲染；函数不存在或抛错时退回 fallback(box)。
   * 这样 F2 尚未就绪时页面依然可渲染，F2 就绪后自动接管。
   */
  function mountPanel(name, box, ctx, fallback) {
    if (!box) return false;
    global.UI.clear(box);
    var P = global.RoomPanels;
    var fn = P && P[name];
    if (typeof fn === 'function') {
      try {
        var node = fn(ctx);
        if (node) { box.appendChild(node); return true; }
      } catch (e) { /* 面板抛错 → 退回，不让整页挂掉 */ }
      global.UI.clear(box);
    }
    try { fallback(box); }
    catch (e2) { box.appendChild(el('div.tiny.dim', { text: '该区域暂时不可用' })); }
    return false;
  }

  /** v2.1.1（用户定稿线框）：战斗面板渲染。
      块6（.gp-region-kp-combat）**始终存在**于右列（由标题栏折叠控制显隐），
      探索 / 战斗的差异只体现在：① 块4 的「战斗轮次信息」（F2 的 kpMapArea 按 meta.mode 输出）；
      ② 保留 .gp-explore / .gp-combat 类（PL 侧仍据此隐藏战斗列）。
      ⚠️ 门控必须在这里：room-panels.js 的战斗面板恒渲染、不读 meta.mode。 */
  function paintCombatRegion(st, ctx) {
    var mode = ((st && st.meta) || {}).mode;
    var exploring = mode !== 'COMBAT';
    if (pageRefs.root) {
      pageRefs.root.classList.toggle('gp-explore', exploring);
      pageRefs.root.classList.toggle('gp-combat', !exploring);
    }
    var strip = pageRefs.combatStripEl;
    if (strip) global.UI.clear(strip);
    var box = pageRefs.combatBodyEl || pageRefs.combatEl;
    if (box) global.UI.clear(box);
    var fullFallback = function (b) {
      if (global.RoomPanels.renderCombat) b.appendChild(global.RoomPanels.renderCombat(ctx));
      else b.appendChild(el('div.gp-region-hint.tiny.dim', { text: '战斗模式面板（战斗开始时显示）' }));
    };
    if (box) mountPanel('kpCombatPanel', box, ctx, fullFallback);
  }

  function paintKpRegions() {
    var st = currentState();
    var ctx = panelCtx(st);
    /* 折叠盒：骨架只建一次 → 每次 paint 校准 .folded 类与标题文案。 */
    syncFoldRegion(pageRefs.combatEl, 'foldCombat', '⚔️ 战斗列表 · 怪物信息');
    syncFoldRegion(pageRefs.playersEl, 'foldPlayers', '👥 玩家信息');
    mountPanel('kpLeftColumn', pageRefs.leftIconsEl, ctx, function (box) {
      /* 退回：素材库（含上传 / 公开），旧的「素材与地图」弹层仍在工具栏 */
      box.appendChild(global.RoomPanels.explorationPanel(ctx));
    });
    mountPanel('kpToolColumn', pageRefs.toolsBodyEl || pageRefs.toolsEl, ctx, function (box) {
      box.appendChild(el('div.gp-region-hint.tiny.dim', { text: '标记 / 画笔 / 橡皮擦' }));
    });
    mountPanel('kpMapArea', pageRefs.centerEl, ctx, function (box) { paintCenterInto(box); });
    paintCombatRegion(st, ctx);
    mountPanel('kpSceneCheckPanel', pageRefs.sceneBodyEl || pageRefs.sceneEl, ctx, function (box) {
      box.appendChild(el('div.gp-region-hint.tiny.dim', { text: '场景检定' }));
    });
    mountPanel('kpPlayerList', pageRefs.playersBodyEl || pageRefs.playersEl, ctx, function (box) { paintPlayersInto(box); });
    /* v2.2.0（用户第 2 项）：竖屏栏目折叠标题（横屏由 CSS 隐藏 → .gp-grid 零回归）。 */
    attachFoldHeaders();
  }

  /**
   * v2.1.8（用户玩家线框 12 块）：把 plTeammates 面板输出里的「我的手绘板」段
   * （标题 card-title「我的手绘板」+ 其后的 .mini-board 等兄弟节点）**移动**到
   * 右列独立块 .gp-pl-sketch 的 body 里。
   *
   * 为什么在 UI 层挪：plTeammates 在 room-panels.js（已冻结）里把「队友列表 +
   * 我的手绘板」渲染成同一个 .pl-teammates 节点，无法在面板层拆分；线框要求
   * 手绘板是右列里场景检定|队友之下、笔记栏之上的**独立一块**。
   * 面板缺失 / 结构变化（找不到标题）时退回提示文案，不吞异常、不造功能。
   */
  function splitSketchIntoOwnBlock() {
    var body = pageRefs.sketchBodyEl;
    if (!body) return;
    global.UI.clear(body);
    var wrap = pageRefs.matesEl ? pageRefs.matesEl.querySelector('.pl-teammates') : null;
    var kids = wrap ? Array.prototype.slice.call(wrap.childNodes) : [];
    var at = -1;
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n.nodeType === 1 && /\bcard-title\b/.test(n.className || '') &&
          (n.textContent || '').indexOf('我的手绘板') === 0) { at = i; break; }
    }
    if (at < 0) {
      body.appendChild(el('div.gp-region-hint.tiny.dim', { text: '手绘板' }));
      return;
    }
    /* appendChild 会把节点从原父节点**移走**（不是复制）→ 队友块里不再残留 */
    for (var j = at; j < kids.length; j++) body.appendChild(kids[j]);
  }

  function paintPlRegions() {
    var st = currentState();
    var ctx = panelCtx(st);
    mountPanel('plCharacterCard', pageRefs.cardEl, ctx, function (box) {
      var me = st.members ? findMe(st.members) : null;
      if (me && me.sheet && me.sheet.name) box.appendChild(mySheetCard(me));
      else box.appendChild(el('div.gp-region-hint.tiny.dim', { text: '角色卡（绑定后显示）' }));
    });
    mountPanel('plMapArea', pageRefs.centerEl, ctx, function (box) { paintCenterInto(box); });
    /* 战斗列表（玩家视角）：无专用面板 → 复用通用战斗面板；同样受探索模式门控 */
    paintCombatRegion(st, ctx);
    mountPanel('plTeammates', pageRefs.matesEl, ctx, function (box) { paintPlayersInto(box); });
    /* v2.1.8（用户玩家线框）：「我的手绘板」拆出为右列独立块（见
       buildPlSkeleton 的 refs.sketchEl 注释 —— 只挪 DOM 节点，不改冻结面板）。 */
    splitSketchIntoOwnBlock();
    /* v2.1.4（用户第 3 项）：玩家侧这里原来挂的是 **KP 的场景检定编辑器**
       （kpSceneCheckPanel 里有「自定义检定」表单 + 「推送给玩家」按钮）——
       玩家点下去发的是 KP 专属操作，权威端静默拒绝，界面却照旧弹「推送成功」。
       现在换成玩家自己的面板：只读展示 KP 推来的检定 + 用**自己角色卡技能**主动检定。 */
    mountPanel('plSceneCheckPanel', pageRefs.sceneEl, ctx, function (box) {
      if (global.RoomPanels.plSceneCheckPanel) box.appendChild(global.RoomPanels.plSceneCheckPanel(ctx));
      else box.appendChild(el('div.gp-region-hint.tiny.dim', { text: '场景检定' }));
    });
    /* v2.1.6（用户布局图）：笔记栏 —— 玩家个人笔记（本机保存，不上传） */
    mountPanel('plNotes', pageRefs.notesEl, ctx, function (box) {
      if (global.RoomPanels.notesPanel) box.appendChild(global.RoomPanels.notesPanel(ctx));
      else box.appendChild(el('div.gp-region-hint.tiny.dim', { text: '笔记栏' }));
    });
    /* v2.2.0（用户第 2 项）：竖屏栏目折叠标题（横屏由 CSS 隐藏 → .gp-grid 零回归）。 */
    attachFoldHeaders();
  }

  /* ============================================================
   * 方向桥（契约 §3；v2.1.1 变更）
   *
   * v2.0.0：进入游戏页**强制横屏**（→ landscape），离开恢复。
   * v2.1.1（用户第三轮反馈）：**取消强制横屏** —— 游戏页改为跟随系统旋转。
   *   → 调用方无论传什么，一律只发 'auto'（= 跟随系统），不再向原生请求横屏。
   *   保留本函数 + 桥方法只为**向后兼容**（旧前端缓存调用时也不会锁死方向）。
   * 必须 try/catch：浏览器 / 非 App 环境没有 AndroidBridge。
   * ============================================================ */
  var orientState = null;

  function applyOrientation() {
    /* v2.1.1：忽略入参（历史调用点仍会传 'landscape'），恒定「跟随系统」。 */
    var mode = 'auto';
    if (orientState === mode) return;
    orientState = mode;
    try {
      var B = global.AndroidBridge;
      if (B && typeof B.setGameOrientation === 'function') B.setGameOrientation(mode);
    } catch (e) { /* 浏览器无桥，忽略 */ }
  }

  function restoreOrientation() { applyOrientation('auto'); }

  /* ============================================================
   * v2.1.1（用户第三轮反馈）：进房等待态文案按 joinKind 区分。
   *   机器码命中已有绑定 → 'reconnect' → 「正在重连…」
   *   全新机器码        → 'new'       → 「加入中…」
   *   其它（续玩 / 无 joinKind）     → 「正在回到房间…」（沿用 #10 文案）
   * 前提：sess.joinKind 由 startPlayer 写入（来源 N.join() 返回的 joinKind）。
   * ============================================================ */
  function resumeBannerText() {
    if (sess && sess.joinKind === 'reconnect') return '正在重连…（连接中）';
    if (sess && sess.joinKind === 'new') return '加入中…（连接中）';
    return '正在回到房间…（连接中）';
  }

  /* ============================================================
   * 双指捏合缩放（整个游戏界面）
   *
   * 缩放对象 = .game-page 里的 .gp-zoom 容器（文字 / 按钮 / 面板一起缩放）。
   * 单指仍是画画 / 放标记（room-panels.js 的 pointer 手势）；只有双指才缩放。
   * 缩放状态不跨页保留：renderGamePage 每次进来都 setZoom(1)。
   *
   * v2.0.2 问题1：**纯视觉缩放**。布局只按设备自然宽度算一次（app.css 里
   * .gp-zoom width:100%，不再有 calc(100%/zoom) 重排补偿），这里只改
   * --gp-zoom → transform: scale()。放大后内容溢出 → 原生滚动充当平移；
   * 另补「双指中点位移 → scrollLeft/Top 平移」（仅双指，绝不与单指画画冲突）。
   * ============================================================ */
  var zoomState = { scale: 1 };
  var ZOOM_MIN = 0.5, ZOOM_MAX = 2.5;

  /**
   * v2.1.4（用户第 1 项 ·「手机横屏太挤」）：手机横屏时**自动缩小整页**，
   * 让挤在一起的内容能显示完全（用户有全局缩放/双指捏合，之后仍可手动再调）。
   *
   * 判定「手机横屏」：网格已开启 + 视口又矮又窄（手机横屏，非平板）。
   * 只在**首次**进入时自动设一次（zoomState.autoApplied 防重复）——
   * 用户之后的双指捏合/重置优先级更高，不强行覆盖。
   */
  function maybeAutoZoom() {
    if (!pageRefs || !pageRefs.root) return;
    /* v2.1.7：用户保存过缩放偏好（或本次已自动设过）→ 不强改 */
    if (zoomState.autoApplied) return;
    /* 「偏好 = 100%」视作无偏好（初始化 setZoom(1) 也会写存储，不能因此跳过自动缩放） */
    var hasPref = false;
    try {
      var v = parseFloat(localStorage.getItem('coc7_ui_zoom'));
      hasPref = isFinite(v) && v > 0 && Math.abs(v - 1) > 1e-6;
    } catch (e) { hasPref = false; }
    if (hasPref) return;
    var w = global.innerWidth || 0, h = global.innerHeight || 0;
    var isPhoneLandscape = pageRefs.root.classList.contains('gp-grid') &&
                           w > h && w < 920 && h < 480;
    if (!isPhoneLandscape) return;
    zoomState.autoApplied = true;
    /* 缩小到 82%：给「挤到一块」的内容腾出视觉空间；仍 ≥ ZOOM_MIN 可继续手动缩 */
    setZoom(0.82);
    if (pageRefs.zoomLabel) pageRefs.zoomLabel.textContent = '82%';
  }

  function setZoom(s) {
    s = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, s || 1));
    zoomState.scale = s;
    /* v2.1.7（用户第 5 项）：缩放偏好持久化 —— 下次进房自动应用
       （「UI 缩放设置」与双指捏合共用这一份）。 */
    try { localStorage.setItem('coc7_ui_zoom', String(s)); } catch (e) { /* 隐私模式忽略 */ }
    if (!pageRefs || !pageRefs.root) return;
    pageRefs.root.style.setProperty('--gp-zoom', String(s));
    /* scale 恰好为 1 时移除 transform —— 否则会形成 containing block，
       让底部工具栏的 position:sticky 失效（小屏上就点不到底栏了）。
       v2.0.2：s==1 时行为与 v2.0.1 完全一致（sticky 正常，测试不回归）；
       s≠1 时接受「工具栏随整页一起缩放 / 需平移查看」（即「整页等比缩放」语义）。 */
    pageRefs.root.classList.toggle('gp-noscale', Math.abs(s - 1) < 1e-6);
    /* v2.1.7：缩小（<100%）时启用「倒数布局框」重排补偿（见 app.css 同处注释）；
       放大保持旧语义。 */
    pageRefs.root.classList.toggle('gp-zoomout', s < 1 - 1e-6);
    if (pageRefs.zoomLabel) pageRefs.zoomLabel.textContent = Math.round(s * 100) + '%';
  }

  function resetZoom() {
    try { localStorage.removeItem('coc7_ui_zoom'); } catch (e) { /* 忽略 */ }
    setZoom(1);
  }

  /**
   * v2.1.7（用户第 5 项）：**UI 缩放设置** —— 用百分比把整页 UI（文字/按钮/栏位内
   * 元素）一起缩放，让手机横屏也能完整显示三列网格的全部内容，不挤成一团。
   * 入口：底栏缩放百分比标签（点击打开）。档位即点即用、持久化（见 setZoom）。
   */
  function openZoomSheet() {
    var PCT = [60, 70, 80, 90, 100, 110, 125, 150];
    var body = el('div', null, [
      el('div.tiny.dim', { text:
        '按百分比缩放整个游戏界面（文字、按钮、栏位元素一起缩）。' +
        '手机横屏建议 70–90%；也可以随时双指捏合微调。设置会记住，下次进房自动应用。' }),
      el('div.btn-group', { style: { flexWrap: 'wrap', gap: '6px', marginTop: '10px' } },
        PCT.map(function (p) {
          return el('button.btn.sm' + (Math.abs(zoomState.scale * 100 - p) < 1 ? '.primary' : '.ghost'), {
            text: p + '%',
            onclick: function () {
              setZoom(p / 100);
              global.UI.closeAllSheets();
              global.UI.toast('UI 缩放已设为 ' + p + '%', 'ok', 1800);
            }
          });
        }))
    ]);
    global.UI.sheet({ title: 'UI 缩放设置', body: body });
  }

  function pinchDist(t) {
    var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** 在最外层容器上绑定双指捏合（不吞单指事件） */
  function bindPinchZoom(hostEl) {
    var startDist = 0, startScale = 1, active = false, midX = 0, midY = 0;
    function mid(t) { return [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2]; }
    hostEl.addEventListener('touchstart', function (e) {
      if (e.touches && e.touches.length === 2) {
        active = true; startDist = pinchDist(e.touches); startScale = zoomState.scale;
        var m = mid(e.touches); midX = m[0]; midY = m[1];
      }
    }, { passive: true });
    hostEl.addEventListener('touchmove', function (e) {
      if (!active || !e.touches || e.touches.length !== 2) return;
      if (e.cancelable) e.preventDefault();      // 阻止原生滚动 / 原生缩放
      var d = pinchDist(e.touches);
      if (startDist > 4) setZoom(startScale * (d / startDist));
      /* v2.0.2：双指中点位移 → 平移（仅双指，绝不与单指画画冲突）。
         scrollLeft/Top 天然被夹在合法范围内；s==1 时内容不溢出，自然无效。 */
      var m = mid(e.touches);
      hostEl.scrollLeft -= (m[0] - midX);
      hostEl.scrollTop -= (m[1] - midY);
      midX = m[0]; midY = m[1];
    }, { passive: false });
    hostEl.addEventListener('touchend', function (e) {
      if (!e.touches || e.touches.length < 2) active = false;
    });
    hostEl.addEventListener('touchcancel', function () { active = false; });
  }

  /** v2.0.2 修复A'：成员战斗用敏捷 = sheet.attrs（经 CocRules.attrValue 兼容），取不到 null。
      与 room-panels.js#memberDex 同源，避免两条路径取值不一致。 */
  function memberDex(m) {
    var R = global.CocRules;
    var v = (R && typeof R.attrValue === 'function') ? R.attrValue(m && m.sheet, '敏捷') : null;
    if (v == null) v = (m && m.sheet && m.sheet.attrs) ? m.sheet.attrs.dex : null;
    return (v == null || v === '') ? null : Number(v);
  }

  /** 战斗模式入口（契约 §8.3：优先用 F2 的 combatPrepareSheet） */
  function openCombatPrepare(ctx) {
    var P = global.RoomPanels;
    if (P && typeof P.combatPrepareSheet === 'function') { P.combatPrepareSheet(ctx); return; }
    /* 退回（F2 尚未就绪）：按当前在场玩家 + 一个占位怪物，选完提交 combat.start */
    var st = ctx.st;
    var players = (st.members || []).filter(function (m) {
      return m.role === T().ROLE.PLAYER && m.online;
    });
    var draft = players.map(function (m) {
      var rt = m.runtime || {};
      return { id: 'p-' + m.seat, name: (m.charName || m.nickname || '玩家'), kind: 'pc',
               seat: m.seat, dex: (memberDex(m) != null ? memberDex(m) : 0), actionsPerRound: 1,
               hp: rt.hp || 10, hpMax: rt.hpMax || rt.hp || 10 };
    });
    var extra = { id: 'm' + Date.now(), name: '怪物', kind: 'monster', dex: 50,
                  actionsPerRound: 1, hp: 10, hpMax: 10 };
    draft.push(extra);
    var picks = {};
    draft.forEach(function (a) { picks[a.id] = true; });

    var list = el('div');
    function renderList() {
      global.UI.clear(list);
      draft.forEach(function (a) {
        list.appendChild(el('div.occ-item', null, [
          el('span.chk', { text: picks[a.id] ? '✓' : '' }),
          el('div.grow', null, [
            el('div.nm', { text: a.name }),
            el('div.meta', { text: (a.kind === 'pc' ? '玩家角色' : '怪物') + ' · DEX ' + a.dex })
          ]),
          el('button.btn.sm' + (picks[a.id] ? '.ghost' : '.primary'), {
            text: picks[a.id] ? '取消' : '选入',
            onclick: function () { picks[a.id] = !picks[a.id]; renderList(); }
          })
        ]));
      });
    }
    renderList();
    var body = el('div', null, [
      el('div.tiny.dim', { text: '勾选要进入战斗的玩家角色与怪物 / NPC，然后点下面的按钮。' }),
      list
    ]);
    var api = global.UI.sheet({ title: '战斗模式 · 选择参战单位', body: body });
    body.appendChild(el('button.btn.primary.block', {
      style: { marginTop: '12px' },
      text: '⚔️ 战斗部署完毕',
      onclick: function () {
        var chosen = draft.filter(function (a) { return picks[a.id]; });
        if (!chosen.length) { global.UI.toast('至少选一个单位', 'err'); return; }
        /* 同时带 actors 与 actorIds：兼容 E 线改造前后两种签名 */
        ctx.act({ op: 'combat.start', actors: chosen,
                  actorIds: chosen.map(function (a) { return a.id; }) });
        api.close();
      }
    }));
  }

  /** 当前权威状态：KP 用自己的 Host.state，玩家用 Client.state */
  function currentState() {
    if (!sess) return null;
    return sess.host ? sess.host.state : (sess.client ? sess.client.state : null);
  }

  /* v2.0.2 T5（断点3接线）：把本机有权看到的存档落进 RoomStore。
     saveRoom/listUnfinished 早就写好了但**零调用** —— 本地存档从未发生。
     这里在每次重画时按 seq 去重地落一份（seq 没变就不重复写盘）。 */
  var _lastLocalSaveSeq = -1;
  function persistLocalSave() {
    if (!sess || !sess.code || !S || typeof S.saveRoom !== 'function') return;
    var st = currentState();
    if (!st) return;
    var seq = st.seq || 0;
    if (seq === _lastLocalSaveSeq) return;
    _lastLocalSaveSeq = seq;
    try {
      S.saveRoom(sess.code, {
        role: sess.role,
        seat: (sess.client && sess.client.seat) || (sess.role === 'kp' ? 'host' : ''),
        seq: seq,
        state: st
      });
    } catch (e) { /* 存不下（配额/隐私模式）不影响对局 */ }
  }

  function paint(scrollBottom) {
    if (!sess || !pageRefs) return;
    var st = currentState();
    var inGame = !!(st && st.meta && st.meta.status === T().STATUS.IN_GAME);
    /* v2.0.2 T5：状态每次变化都尽量落一份本地存档（按 seq 去重） */
    persistLocalSave();
    /* 状态翻转（开团 / 测试期回退）→ 整页结构不同，必须重建而不是补画 */
    if (pageRefs.isGame !== inGame) { rerenderRoom(); return; }

    if (pageRefs.isGame) {
      var isKp = sess.role === T().ROLE.KP;
      var skel = isKp ? 'kp' : 'pl';
      /* 身份切换（KP 转让 / 旁观变玩家等）→ 骨架不同，整页重建 */
      if (pageRefs.skel && pageRefs.skel !== skel) { rerenderRoom(); return; }
      paintGameHead();
      if (isKp) paintKpRegions(); else paintPlRegions();
      paintGameFeeds(scrollBottom !== false);
      paintPrivates();
      paintStatus();
      paintGameToolbar();
      /* v2.2.0（用户第 3 项）：对抗待办主动提示（玩家选怪 / KP 裁定），按 opp.id 去重。 */
      checkOpposedPrompt(st, isKp);
    } else {
      paintHead();
      paintMembers();
      paintPanels();
      paintStatus();
      paintLog(scrollBottom !== false);
    }
    /* 底层页重画完，再刷新最上层那个「可刷新 sheet」。
       否则会出现「状态已经变了，但打开着的 KP 工具 / 素材与地图 / 手绘板
       还停在打开那一刻」的假死现象（D5：KP 上传素材后弹层里看不到）。 */
    if (global.UI && global.UI.refreshTopSheet) global.UI.refreshTopSheet();
  }

  /* ============================================================
   * 游戏界面（需求 §5 平铺布局）的各个区域
   * ============================================================ */

  /** ① 顶栏：标题 / 身份 / 当前场景 / 模式 / 观众数 / 离开（KP 与 PL 共用一套） */
  function paintGameHead() {
    var T2 = T();
    var st = currentState();
    var meta = (st && st.meta) || {};
    var isKp = sess.role === T2.ROLE.KP;
    var specs = (st.members || []).filter(function (m) { return m.role === T2.ROLE.SPECTATOR; });
    global.UI.clear(pageRefs.headEl);

    var modeChip = el('span.chip.sm' + (meta.mode === 'COMBAT' ? '.on' : ''), {
      text: meta.mode === 'COMBAT' ? '⚔️ 战斗' : '🔍 探索'
    });
    var specChip = el('span.chip.sm.dim', {
      text: '👁 ' + specs.length,
      style: { cursor: 'pointer' },
      onclick: function () {
        var names = specs.map(function (m) { return m.nickname || '旁观者'; });
        global.UI.sheet({
          title: '观众（' + names.length + '）',
          body: el('div', null, names.length
            ? names.map(function (n) { return el('div.small', { style: { padding: '6px 0' }, text: '👤 ' + n }); })
            : [el('div.tiny.dim', { text: '当前没有观众。' })])
        });
      }
    });
    var sceneName = (st.scene && st.scene.title) || '未命名场景';
    var whoLine = isKp
      ? ('👑 ' + (meta.kpName || 'KP') + ' · KP 主持')
      : ('🎭 当前玩家：' + (sess.nickname || '玩家'));

    /* v2.0.1 根因⑤：游戏页顶栏常驻连接状态指示。
       .game-page 是全屏 fixed（z-index:5），房间页的 .room-banner 会被完全遮住，
       所以掉线必须在这里给出**始终可见**的信号。 */
    var linkChip = el('span.chip.sm.gp-link', { title: '连接状态' });
    pageRefs.linkChipEl = linkChip;

    pageRefs.headEl.appendChild(el('div.gp-topbar-inner', null, [
      el('div.grow', null, [
        el('div.gp-title', { text: '克苏鲁的呼唤 7th' }),
        /* v2.1.2：房间号**放在最前** —— 窄横屏下本行 nowrap+ellipsis 截尾，
           房间号在最前才永不被截断（v2.1.1 定的「房间号不能丢」）。 */
        el('div.tiny.dim', { text: '房间号 ' + sess.code + ' · ' + whoLine +
          ' · ' + (meta.name || ('房间 ' + sess.code)) }),
        /* 房主：把服务地址显眼地摆出来，并提供「复制地址 / 复制加入信息」——
           同伴网络层不通时，光有房间号没用，必须能直接拿到并转发这个地址。 */
        isKp ? hostAddrBlock() : null
      ]),
      el('span.chip.sm', { text: '当前场景：' + sceneName }),
      linkChip,
      roleChip(sess.role),
      modeChip,
      specChip,
      el('button.btn.sm.ghost', { text: isKp ? '离开' : '退出', onclick: leaveConfirm })
    ]));
    paintLinkChip();
  }

  /** v2.0.1 根因⑤：把 sess.linkState 三态渲染到顶栏的 .gp-link 上。
      由 onLinkState 与 paintGameHead 调用（房间页没有这个节点，静默跳过）。 */
  function paintLinkChip() {
    var c = pageRefs && pageRefs.linkChipEl;
    if (!c || !sess) return;
    var map = {
      online:     { cls: '',       txt: '🟢 已连接' },
      connecting: { cls: ' warn',  txt: '🟡 连接中…' },
      offline:    { cls: ' danger', txt: '🔴 已离线，重连中…' },
      closed:     { cls: ' danger', txt: '⛔ 连接已断开' },
      ended:      { cls: ' danger', txt: '⛔ 房间已结束' }
    };
    var m = map[sess.linkState] || map.connecting;
    c.className = 'chip sm gp-link' + m.cls;
    global.UI.clear(c);
    c.appendChild(document.createTextNode(m.txt));
  }

  /** 自己的身份胶囊（§5.1 KP 栏：身份突出；旁观者要知道自己是只读） */
  function roleChip(role) {
    var T2 = T();
    if (role === T2.ROLE.KP) return el('span.chip.sm.on', { text: '你是 KP' });
    if (role === T2.ROLE.SPECTATOR) return el('span.chip.sm.dim', { text: '旁观中（不能发言/掷骰）' });
    return el('span.chip.sm', { text: '你是玩家' });
  }

  /** ② 玩家列表：点击展开「对当前用户可见」的状态详情（需求 §5.2）。
      把内容画进指定容器（KP 右栏 / PL 队友栏共用同一实现）。 */
  function paintPlayersInto(container) {
    var T2 = T();
    var st = currentState();
    if (!container) return;
    global.UI.clear(container);
    var players = (st.members || []).filter(function (m) { return m.role === T2.ROLE.PLAYER; });
    if (!players.length) {
      container.appendChild(el('div.tiny.dim', { style: { padding: '6px 2px' }, text: '还没有玩家加入。' }));
      return;
    }
    players.forEach(function (m) {
      var rt = m.runtime || {};
      var sh = m.sheet || {};
      var boardInfo = ((st.scene || {}).boards || {})[m.seat] || {};
      var chips = [];
      if (rt.hp != null || sh.hp != null) chips.push('HP ' + (rt.hp != null ? rt.hp : sh.hp));
      if (rt.san != null || sh.san != null) chips.push('SAN ' + (rt.san != null ? rt.san : sh.san));
      container.appendChild(el('button.gp-player' + (m.online ? '' : '.off'), {
        onclick: function () { memberDetailSheet(m); },
        html: '<div class="nm">' + global.UI.esc(m.charName || m.nickname || '玩家') + '</div>' +
              '<div class="d">' + (chips.length ? global.UI.esc(chips.join(' · ')) : '—') + '</div>' +
              '<div class="b">🎨 ' + (boardInfo.count || 0) + '</div>'
      }));
    });
  }

  /** 兼容旧调用点（游戏页玩家栏横排） */
  function paintPlayersStrip() { paintPlayersInto(pageRefs.playersEl || pageRefs.membersEl); }

  /** 玩家栏点开：状态详情（KP 看全量；本人看全量；其他人只看公开的 ——
      数据本身已由权威端裁剪过，这里不做二次发放） */
  function memberDetailSheet(m) {
    var rt = m.runtime || {};
    var sh = m.sheet || {};
    var body = el('div', null, [
      el('div.card-title', { text: m.charName || m.nickname || '玩家' }),
      el('div.small', { text: 'HP ' + (rt.hp != null ? rt.hp : (sh.hp != null ? sh.hp : '—')) +
        ' · SAN ' + (rt.san != null ? rt.san : (sh.san != null ? sh.san : '—')) +
        ' · MP ' + (rt.mp != null ? rt.mp : (sh.mp != null ? sh.mp : '—')) })
    ]);
    /* 本人或 KP：看完整卡（症状、精神状态、SAN 减损） */
    var me = sess.client ? findMe(currentState().members) : null;
    var isSelf = me && m.seat === me.seat;
    var isKp = sess.role === 'kp';
    if ((isSelf || isKp) && sh.name) {
      var mad = (sh.madness || []);
      body.appendChild(el('div.small', { style: { marginTop: '8px' },
        text: '疯狂症状：' + (mad.length ? mad.map(function (x) { return x.name; }).join('、') : '无') }));
      body.appendChild(el('div.small', {
        text: '精神状态：' + ((sh.mental || []).join('、') || '正常') }));
      if (sh.sanLoss) body.appendChild(el('div.tiny.dim', { text: 'SAN 上限永久减损 ' + sh.sanLoss }));
    } else if (sh.name) {
      body.appendChild(el('div.tiny.dim', { style: { marginTop: '8px' },
        text: '疯狂：' + (sh.madnessCount ? '有（' + sh.madnessCount + ' 条）' : '无') }));
      body.appendChild(el('div.tiny.dim', {
        text: '该玩家允许公开的信息。完整卡只有本人与 KP 能看。' }));
    }
    global.UI.sheet({ title: '角色状态', body: body });
  }

  /**
   * v2.13.3（用户第 5 项）：玩家「📋 人物卡查看」改成**车卡系统生成的那张完整信息图**。
   *
   * 旧实现弹 memberDetailSheet —— 只有昵称 + HP/SAN/MP + 疯狂几行，玩家看到的
   * 信息量远少于角色卡本身（用户原话：「里面只有很少的信息」）。
   * 现在直接调用 SheetView.renderImage() 画**与「🖼 生成图片 / 分享人物卡」完全同一张**
   * PNG，点在图上可全屏放大看细节，也可一键保存。
   * 找不到本机卡（换设备 / 卡被删）时退回旧的摘要浮层，保证始终有东西可看。
   */
  function cardImageSheet(m) {
    var id = (m && m.charId) || (sess && sess.boundCharId) || '';
    var stt = (global.Store && global.Store.getState) ? global.Store.getState() : {};
    var card = (id && stt.characters && stt.characters[id]) || null;
    if (!card && stt.current && (!id || stt.current.id === id)) card = stt.current;
    var canRender = card && global.SheetView && typeof global.SheetView.renderImage === 'function';
    if (!canRender) { memberDetailSheet(m || { nickname: (sess && sess.nickname) || '' }); return; }

    var url = '';
    try { url = global.SheetView.renderImage(card) || ''; } catch (e) { url = ''; }
    if (!url) { memberDetailSheet(m || { nickname: (sess && sess.nickname) || '' }); return; }

    var img = el('img.cardimg', {
      src: url, alt: (card.characterName || '角色卡'),
      onclick: function () {
        /* 点图 → 全屏看细节（复用 .gp-fs 覆盖层；点空白或「返回」关闭） */
        var ov = el('div.gp-fs.gp-fs--card', null, [
          el('img', { src: url, alt: '' }),
          el('button.btn.primary', { text: '← 返回', onclick: function () { if (ov.parentNode) ov.parentNode.removeChild(ov); } })
        ]);
        ov.addEventListener('click', function (ev) {
          if (ev.target === ov && ov.parentNode) ov.parentNode.removeChild(ov);
        });
        document.body.appendChild(ov);
      }
    });
    var body = el('div', null, [
      img,
      el('div.tiny.dim', { style: { marginTop: '7px' }, text: '点图片可放大查看细节。' }),
      el('button.btn.sm.teal.block', {
        text: '⬇ 保存这张图片', style: { marginTop: '7px' },
        onclick: function () {
          global.UI.saveFile((card.characterName || '角色卡') + '.png', url, 'image');
          if (!global.UI.isAndroid()) global.UI.toast('图片已保存', 'ok');
        }
      })
    ]);
    global.UI.sheet({ title: '人物卡', body: body });
  }

  /** ③ 中央大图：地图/场景（KP 可标可画；所有人点图全屏，§5.4/§5.9）。
      战斗模式时按 §8.2 在地图上方叠加**行动顺序栏**（共用主场景框架）。 */
  function paintCenterInto(container) {
    var st = currentState();
    global.UI.clear(container);
    var ctx = panelCtx(st);
    if ((st.meta || {}).mode === 'COMBAT' && global.RoomPanels.renderCombat) {
      container.appendChild(global.RoomPanels.renderCombat(ctx));
    }
    var card = global.RoomPanels.mapCard(ctx);
    /* 点图全屏：玩家端舞台没有手势绑定，安全；KP 端有长按/画线，
       给他一个 ⛶ 按钮，避免和地图手势打架 */
    var isKp = sess.role === 'kp';
    if (!isKp) {
      var stage = card.querySelector ? card.querySelector('.map-stage') : null;
      if (stage) stage.addEventListener('click', function () { fullscreenScene(); });
    }
    container.appendChild(card);
  }

  /** 兼容旧调用点 */
  function paintGameCenter() { paintCenterInto(pageRefs.centerEl); }

  /** 全屏查看中央图（§5.4/§5.9：有明显的返回，不丢输入） */
  function fullscreenScene() {
    var st = currentState();
    var scene = (st && st.scene) || {};
    var bg = null;
    (scene.assets || []).forEach(function (a) { if (!bg && /^data:image\//.test(a.data || '')) bg = a; });
    var ov = el('div.gp-fs', null, [
      bg ? el('img', { src: bg.data, alt: bg.name || '' })
         : el('div.tiny.dim', { text: '当前没有展示图。' }),
      el('button.btn.primary', { text: '← 返回游戏', onclick: function () { document.body.removeChild(ov); } })
    ]);
    document.body.appendChild(ov);
  }

  /* ============================================================
   * v2.2.0（用户第 1 项）：信息流的「新消息闪烁」+「全屏查看」
   *
   * 闪烁：只在**新消息到达**时触发（按 seq 变化判定 —— 重绘不变 seq 不触发；
   *      自己发的消息忽略）；连续消息节流（正在闪时只延长、不重启动画）；
   *      3 秒后移除 class。
   * 全屏：复用 .gp-fs 覆盖层。做法是**把原节点整体搬进覆盖层再搬回**——
   *      聊天输入行随之一起搬 → 正在输入的草稿天然不丢（需求硬要求）。
   * ============================================================ */
  var _feedFlash = { init: false, chatSeq: 0, logSeq: 0, tChat: 0, tLog: 0 };

  /** 触发一次闪烁（加 class，3 秒后移除；正在闪则只延长计时，不重启动画）。 */
  function triggerFeedFlash(elm, key) {
    if (!elm) return;
    elm.classList.add('gp-flash');
    var tKey = (key === 'chat') ? 'tChat' : 'tLog';
    if (_feedFlash[tKey]) clearTimeout(_feedFlash[tKey]);
    _feedFlash[tKey] = setTimeout(function () {
      elm.classList.remove('gp-flash');
      _feedFlash[tKey] = 0;
    }, 3000);
  }

  /** 检测新消息 → 闪烁对应信息流（首次绘制只登记基线，不闪）。 */
  function feedFlashCheck(st, mySeat) {
    if (!st) return;
    var chats = st.chats || [], logs = st.logs || [];
    var lastChat = chats.length ? chats[chats.length - 1] : null;
    var lastLog = logs.length ? logs[logs.length - 1] : null;
    var chatSeq = lastChat ? (lastChat.seq || 0) : 0;
    var logSeq = lastLog ? (lastLog.seq || 0) : 0;
    if (!_feedFlash.init) {          // 首次绘制：登记基线，不闪（历史消息不算「新」）
      _feedFlash.init = true;
      _feedFlash.chatSeq = chatSeq; _feedFlash.logSeq = logSeq;
      return;
    }
    if (chatSeq > _feedFlash.chatSeq) {
      _feedFlash.chatSeq = chatSeq;
      if (!lastChat || lastChat.seat !== mySeat) triggerFeedFlash(pageRefs.chatEl, 'chat');
    }
    if (logSeq > _feedFlash.logSeq) {
      _feedFlash.logSeq = logSeq;
      if (!lastLog || lastLog.seat !== mySeat) triggerFeedFlash(pageRefs.logEl, 'log');
    }
  }

  /* ============================================================
   * v2.3.0（用户第 3 项）：操作播报（居中 2 秒）
   *   · 所有会进「游戏公开记录」的动作（掷骰 / 检定 / 对抗 / 伤害 / SAN / 状态变化）
   *     产生**新条目**时，在 KP 与所有玩家屏幕**居中显示 2 秒**一条提示：
   *     内容 = 做出动作者的 KP 昵称 / 玩家角色名 + 简要信息。
   *   · 复用「按 seq 增长检测新消息」的同源 diff（与 feedFlashCheck 一致）；
   *   · 首次绘制（基线）与断线重连全量同步**不刷屏**；
   *   · 同设备自己产生的动作**也要弹**（让所有人知道刚有人做了操作）。
   * ============================================================ */
  var OPTOAST_MS = 2000;      // 每条展示 2 秒
  var OPTOAST_MAX = 3;        // 同屏最多错峰堆叠 3 条
  var OPTOAST_FLOOD = 6;      // 一次涌入 > 6 条 → 视为重连全量同步，不刷屏
  var _optoast = { init: false, lastSeq: 0, pending: [], live: 0, host: null };

  /** 会话切换时重置基线（新房间首次绘制不弹历史）。 */
  function optoastReset() {
    _optoast.init = false; _optoast.lastSeq = 0;
    _optoast.pending = []; _optoast.live = 0;
    if (_optoast.host && _optoast.host.parentNode) _optoast.host.parentNode.removeChild(_optoast.host);
    _optoast.host = null;
  }

  function optoastHost() {
    if (_optoast.host && _optoast.host.parentNode) return _optoast.host;
    var h = el('div.gp-optoast-host');
    document.body.appendChild(h);
    _optoast.host = h;
    return h;
  }

  function optoastShow(text) {
    var host = optoastHost();
    var node = el('div.gp-optoast', { text: text });
    host.appendChild(node);
    _optoast.live++;
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
      _optoast.live = Math.max(0, _optoast.live - 1);
      if (_optoast.pending.length) { optoastShow(_optoast.pending.shift()); }
      else if (_optoast.host && !_optoast.host.childNodes.length && _optoast.host.parentNode) {
        _optoast.host.parentNode.removeChild(_optoast.host); _optoast.host = null;
      }
    }, OPTOAST_MS);
  }

  function optoastEnqueue(text) {
    if (!text) return;
    if (_optoast.live >= OPTOAST_MAX) {
      _optoast.pending.push(text);
      if (_optoast.pending.length > 20) _optoast.pending.shift();
      return;
    }
    optoastShow(text);
  }

  /** 文案：复用既有 feed 文本并截断（≤40 字），不另造第二套文案。 */
  function optoastTrim(s) {
    var t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > 40 ? (t.slice(0, 39) + '…') : t;
  }
  function optoastKpName(st) {
    return (st && st.meta && st.meta.kpName) || 'KP';
  }
  function optoastMemberName(st, seat) {
    if (!seat) return '';
    var m = (st.members || []).filter(function (x) { return x.seat === seat; })[0];
    if (!m) return '';
    return m.charName || m.nickname || '';
  }
  /** 单条 feed → 播报文案（日志直接取其既有文本；骰子按 feed 口径拼）。 */
  function optoastText(it, st) {
    if (it.kind === 'dice') {
      var d = it.dice || {};
      var who = (it.seat === 'host') ? optoastKpName(st)
        : (optoastMemberName(st, it.seat) || it.nickname || '未知调查员');
      var info = '掷 ' + (d.label || d.expr || '1D100') + (d.total !== undefined && d.total !== null ? ('＝' + d.total) : '');
      if (d.levelText) info += '　' + d.levelText;
      return optoastTrim(who + ' ' + info);
    }
    /* 公开日志：文本本身已含动作者名（room-model 组装时即写入），直接复用。 */
    var txt = String(it.text || '').trim();
    if (!txt) return '';
    if (it.seat && it.seat !== 'host' && !optoastMemberName(st, it.seat) && /^\S+\s/.test(txt) === false) {
      /* 极少数无名字的条目：不强加前缀（避免出现「未知调查员 xx」这种噪音） */
    }
    return optoastTrim(txt);
  }

  /** 检测「公开记录新增条目」→ 逐个入队播报（首次绘制 / 重连全量同步不刷屏）。 */
  function optoastCheck(st) {
    if (!st) return;
    var items = [];
    (st.logs || []).forEach(function (l) {
      items.push({ seq: l.seq || 0, seat: l.seat, kind: 'log', text: l.text });
    });
    (st.dice || []).forEach(function (d) {
      items.push({ seq: d.seq || 0, seat: d.seat, kind: 'dice', nickname: d.nickname, dice: d });
    });
    var maxSeq = 0;
    items.forEach(function (it) { if (it.seq > maxSeq) maxSeq = it.seq; });
    if (!_optoast.init) { _optoast.init = true; _optoast.lastSeq = maxSeq; return; }   // 基线：不弹历史
    if (maxSeq <= _optoast.lastSeq) return;                                            // 无新增
    var from = _optoast.lastSeq;
    _optoast.lastSeq = maxSeq;
    var fresh = items.filter(function (it) { return it.seq > from; });
    if (fresh.length > OPTOAST_FLOOD) return;   // 断线重连全量同步：一次涌入大量 → 不刷屏
    fresh.sort(function (a, b) { return a.seq - b.seq; });
    fresh.forEach(function (it) { optoastEnqueue(optoastText(it, st)); });
  }

  /* ============================================================
   * v2.2.0（用户第 3 项）：对抗待办 → 主动提示
   *   · 玩家：state.opposed.phase === 'await_target'（胜后多怪选目标）→ 自动弹选怪弹层（按 id 去重）。
   *   · KP：state.opposed.phase === 'await_kp'（玩家申请待裁定）→ toast 提示去 KP 工具处理。
   *   去重：用 opp.id + phase 记录已提示过的键，避免每帧重绘反复弹。
   * ============================================================ */
  var _opposedPrompt = { key: '' };

  function checkOpposedPrompt(st, isKp) {
    if (!st) return;
    var op = st.opposed;
    if (!op || !op.id) { _opposedPrompt.key = ''; return; }
    var key = op.id + ':' + op.phase;
    if (key === _opposedPrompt.key) return;         // 同一待办只提示一次
    if (op.phase === 'await_target' && !isKp) {
      _opposedPrompt.key = key;
      if (global.RoomPanels && typeof global.RoomPanels.playerTargetSheet === 'function') {
        global.RoomPanels.playerTargetSheet(panelCtx(st));
      }
    } else if (op.phase === 'await_kp' && isKp) {
      _opposedPrompt.key = key;
      global.UI.toast('收到对抗申请：请在 KP 工具 → ⚔ 对抗 处理', 'info', 4000);
    }
  }

  /** 信息流标题栏（点标题或 ⛶ 进全屏）。 */
  function feedHead(title, kind) {
    var btn = el('button.gp-region-fs-btn', {
      text: '⛶', title: '全屏查看',
      onclick: function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); fullscreenFeed(kind); }
    });
    var head = el('div.gp-region-head', null, [el('span.gp-region-head-t', { text: title }), btn]);
    head.addEventListener('click', function (ev) { if (ev && ev.target === btn) return; fullscreenFeed(kind); });
    return head;
  }

  /**
   * v2.5.0（用户第 1 项）：把信息流滚到**最底部（最新消息）**。
   *
   * 三处共用：① 进全屏 ② 退出全屏还原 ③ 日常重绘（paintGameFeeds）。
   *
   * ⚠️ **滚动容器不一定是那个「信息流节点」本身**，两侧不一样：
   *   · chat → src 是 `.gp-chat`（flex 列，**自身不滚动**），真正滚动的是
   *     `pageRefs.chatListEl`（`.gp-chat-list{overflow-y:auto}`，app.css:1233）；
   *     对它父节点设 scrollTop 是无效的（scrollHeight === clientHeight）。
   *   · log  → `pageRefs.logEl` 自身就是滚动容器（`.gp-glog{overflow-y:auto}`）。
   *
   * 为什么要抽这个函数：`fullscreenFeed` 把原节点整体搬进覆盖层（body.appendChild），
   * **DOM 搬移会重新布局并把 scrollTop 归零**，而函数体里原本一句「滚到底」都没有 ——
   * 于是进全屏看到的是最旧的几条（用户原话：「打开后要直接显示在最新消息位置」）。
   *
   * @param {string} kind 'chat' | 'log'
   */
  function scrollFeedToBottom(kind) {
    if (!pageRefs) return;
    var target = (kind === 'chat') ? pageRefs.chatListEl : pageRefs.logEl;
    if (!target) return;
    target.scrollTop = target.scrollHeight;
  }

  /** 全屏查看聊天 / 游戏记录：把原节点整体搬进覆盖层，点返回或点空白处还原。
   *  v2.2.1（用户第 1 项）修复：
   *    · 进入即**强制展开**并隐藏内嵌折叠开关（全屏里不再能收起）；
   *    · 退出时**还原**进入前的折叠态（全屏临时展开不写回用户会话）；
   *    · 同一时刻只允许一个全屏（再次点标题 / ⛶ 不再套娃覆盖层）；
   *    · 「← 返回」常驻头部、始终可点（内容不再会被折叠掉）。 */
  function fullscreenFeed(kind) {
    if (_fs || _fsPriv) return;             // 已在全屏中：忽略重复触发（防嵌套覆盖层）
    var src = (kind === 'chat') ? pageRefs.chatEl : pageRefs.logEl;
    if (!src || !src.parentNode) return;
    var key = (kind === 'chat') ? 'foldChat' : 'foldLog';
    var title = (kind === 'chat') ? '💬 聊天' : '📜 游戏记录';
    var wasFolded = isFolded(key);
    /* ① 强制展开：清掉该栏目的临时折叠态（真正的用户折叠态在 restore 时还原）。 */
    foldState()[key] = false;
    syncFoldRegion(src, key, title);
    /* ② 隐藏内嵌折叠开关（保留节点本身，避免被 ensureInlineFold 重新注入）。 */
    var inlineEl = src.querySelector('.gp-region-fold--inline');
    var prevInline = inlineEl ? inlineEl.style.display : '';
    if (inlineEl) inlineEl.style.display = 'none';
    _fs = { kind: kind, key: key, title: title, wasFolded: wasFolded,
            inlineEl: inlineEl, prevInline: prevInline };

    var ov = el('div.gp-fs.gp-fs--feeds');
    var head = el('div.gp-fs-head', null, [
      el('span.gp-region-head-t', { text: title }),
      el('button.btn.primary', { text: '← 返回', onclick: function () { restore(); } })
    ]);
    var body = el('div.gp-fs-body');
    ov.appendChild(head);
    ov.appendChild(body);
    /* 占位注释：搬回时按它定位（保持原顺序）。 */
    var placeholder = document.createComment('feed-fs');
    src.parentNode.insertBefore(placeholder, src);
    body.appendChild(src);
    ov.addEventListener('click', function (ev) {
      /* 点覆盖层空白（非内容、非按钮）也还原 —— 与「全屏内再点」一致的直觉。 */
      if (ev.target === ov || ev.target === body) restore();
    });
    function restore() {
      if (placeholder.parentNode) {
        placeholder.parentNode.insertBefore(src, placeholder);
        placeholder.parentNode.removeChild(placeholder);
      }
      if (ov.parentNode) ov.parentNode.removeChild(ov);
      /* ③ 还原进入全屏前的折叠态（全屏临时展开不写回用户会话折叠状态）。 */
      foldState()[key] = wasFolded;
      if (inlineEl && inlineEl.parentNode) inlineEl.style.display = prevInline;
      syncFoldRegion(src, key, title);
      _fs = null;
      /* v2.5.0（用户第 1 项）：搬回原处同样会重置 scrollTop → 还原后也要滚回底部，
         否则退出全屏那一刻视野又跳回最旧的几条。 */
      scrollFeedToBottom(kind);
    }
    document.body.appendChild(ov);
    /* v2.5.0（用户第 1 项）：覆盖层刚插入时目标还没参与布局（scrollHeight 可能为 0），
       必须等下一帧布局生效后再滚 —— 直接在这里同步滚是滚不动的。 */
    requestAnimationFrame(function () { scrollFeedToBottom(kind); });
  }

  /** ④⑤ 游戏记录与聊天分开渲染（§5.5/§5.6） */
  function paintGameFeeds(scrollBottom) {
    var st = currentState();
    if (!st) return;
    var mySeat = sess.client ? sess.client.seat : 'host';

    /* —— 游戏记录：logs + dice（不含聊天） —— */
    global.UI.clear(pageRefs.logEl);
    /* v2.2.0（用户第 1 项）：标题栏（含全屏按钮）随每次重绘重新挂上（logEl 会被 clear）。 */
    if (pageRefs.logHeadEl) pageRefs.logEl.appendChild(pageRefs.logHeadEl);
    var feeds = [];
    (st.logs || []).forEach(function (l) {
      /* v2.2.0（用户第 3 项）：对抗结果卡需要结构化数据（反击/闪避、逐轮重掷、伤害）——
         把 opp 一并带进 feed，供 appendFeed 渲染（旧日志无 opp → 走原 log-check）。 */
      feeds.push({ at: l.at || 0, kind: 'sys', seat: l.seat, text: l.text, sub: l.kind, opp: l.opp || null });
    });
    (st.dice || []).forEach(function (d) {
      feeds.push({ at: d.at || 0, kind: 'dice', seat: d.seat, nickname: d.nickname, dice: d });
    });
    feeds.sort(function (a, b) { return a.at - b.at; });
    if (!feeds.length) {
      pageRefs.logEl.appendChild(el('div.room-log-empty', { text: '游戏记录会出现在这里：检定、伤害、状态变化、场景切换。' }));
    }
    (feeds.slice(-120)).forEach(function (it) { appendFeed(pageRefs.logEl, it, mySeat, st); });
    /* v2.5.0（用户第 1 项）：统一走 scrollFeedToBottom（滚 logEl 自身）。 */
    if (scrollBottom) scrollFeedToBottom('log');

    /* —— 聊天：只渲染列表；输入行在建页时已挂好，不重建（不丢正在输入的
       消息，需求 §5.9） —— */
    global.UI.clear(pageRefs.chatListEl);
    (st.chats || []).slice(-60).forEach(function (c) {
      appendFeed(pageRefs.chatListEl, { at: c.at || 0, kind: 'chat', seat: c.seat, nickname: c.nickname, text: c.text }, mySeat, st);
    });
    /* v2.5.0（用户第 1 项）：统一走 scrollFeedToBottom（滚 .gp-chat-list，不是 .gp-chat）。 */
    scrollFeedToBottom('chat');

    /* v2.2.0（用户第 1 项）：新消息到达 → 闪烁对应信息流（重绘不触发、自己发的不触发、节流）。 */
    feedFlashCheck(st, mySeat);
    /* v2.3.0（用户第 3 项）：操作播报 —— 公开记录新增条目 → 居中 2 秒提示（自己做的也弹）。 */
    optoastCheck(st);
  }

  /**
   * v2.2.0（用户第 3 项）：对抗结果卡。
   * 展示：攻/守双方（名 + 掷值 + 成功等级）、反击/闪避、逐轮重掷明细、兜底说明、伤害段。
   * 规则：失败 / 被躲开（damage=null）不显示伤害行。
   * @param {{opp:Object, at:number}} it feed 条目（opp 为 room-model 组装的结构化数据）
   * @return {HTMLElement} 结果卡节点
   */
  function opposedResultCard(it) {
    var op = it.opp || {};
    var a = op.a || {}, b = op.b || {};
    var winner = op.winner;                       // 'a' | 'b' | null
    var reaction = op.reaction || '';
    var reactionText = reaction === 'counter' ? '反击' : (reaction === 'dodge' ? '闪避' : '不防御');

    var card = el('div.log-opposed');
    /* 标题行 */
    var title = '⚔ 对抗';
    if (winner === 'a') title = '⚔ 对抗 · ' + (a.name || '攻方') + ' 胜';
    else if (winner === 'b') title = '⚔ 对抗 · ' + (b.name || '守方') + ' 胜';
    else if (op.tie) title = '⚔ 对抗 · 未分';
    card.appendChild(el('div.log-opposed-head', null, [
      el('b', { text: title }),
      el('span.tiny.dim', { style: { marginLeft: '6px' }, text: timeText(it.at) })
    ]));

    /* 双方对比行 */
    function side(cls, label, o, mine) {
      return el('div.log-opposed-side' + (cls ? ('.' + cls) : '') + (mine ? '.win' : ''), null, [
        el('span.log-opposed-tag', { text: label }),
        el('span.log-opposed-nm', { text: (o.name || '—') }),
        el('span.log-opposed-val', { text: (o.value === undefined || o.value === null || o.value === '') ? '' : ('掷 ' + o.value) }),
        el('span.tiny.dim', { text: (o.levelText || '') })
      ]);
    }
    card.appendChild(el('div.log-opposed-row', null, [
      side('a', '攻', a, winner === 'a'),
      side('b', reactionText, b, winner === 'b')
    ]));

    /* 逐轮重掷明细（同级同值才可能有 rounds） */
    var rounds = op.rounds || [];
    if (rounds.length) {
      var lines = rounds.map(function (r) {
        return '第 ' + r.round + ' 轮：' + (a.name || 'A') + ' ' + r.aRoll + ' vs ' + (b.name || 'B') + ' ' + r.bRoll;
      });
      card.appendChild(el('div.log-opposed-rounds', { text: lines.join('；') }));
    }
    if (op.fallback) {
      card.appendChild(el('div.tiny.dim', { text: '（达到重掷上限，按规则兜底判发起方胜）' }));
    }

    /* 伤害段：damage=null（失败 / 被躲开）不显示 */
    var dmg = op.damage;
    if (dmg && typeof dmg === 'object') {
      var dtxt;
      if (dmg.by === 'a') {
        dtxt = '命中：伤害 ' + (dmg.expr || '0') + '+' + (dmg.db || '0') + '＝' + dmg.raw +
               '，护甲 ' + dmg.armor + '，实扣 ' + dmg.applied +
               (dmg.impale ? '（贯穿：取最大值并追加伤害骰）' : '');
      } else {
        dtxt = '反击命中：由 ' + (b.name || '守方') + ' 造成 ' + dmg.applied + ' 点伤害（伤害骰 ' + dmg.raw +
               '，护甲 ' + dmg.armor + '）';
      }
      card.appendChild(el('div.log-opposed-dmg', { text: '💥 ' + dtxt }));
    } else if (winner) {
      card.appendChild(el('div.tiny.dim', { text: '未造成伤害' }));
    }
    return card;
  }

  /** v2.13.7（用户需求）：按 seat 找成员（拿头像用）；KP 没有成员记录 → 给个假身份让头像退成首字母。 */
  function feedAvatarForSeat(st, seat) {
    if (!seat) return null;
    if (seat === M.HOST_SEAT) return { nickname: 'KP', charName: '' };
    var ms = (st && st.members) || [];
    for (var i = 0; i < ms.length; i++) if (ms[i] && ms[i].seat === seat) return ms[i];
    return null;
  }

  function appendFeed(box, it, mySeat, st) {
    if (it.kind === 'chat') {
      var mChat = feedAvatarForSeat(st, it.seat);
      box.appendChild(el('div.log-chat' + (it.seat === mySeat ? '.mine' : ''), null, [
        mChat ? el('div.feed-av', null, [global.RoomPanels.avatarEl(mChat, 'mini')]) : null,
        el('div.feed-body', null, [
          el('div.tiny.dim', { text: (it.nickname || '匿名') + ' · ' + timeText(it.at) }),
          el('div', { text: it.text })
        ])
      ].filter(Boolean)));
    } else if (it.kind === 'dice') {
      var d = it.dice || {};
      var mDice = feedAvatarForSeat(st, it.seat);
      box.appendChild(el('div.log-dice', null, [
        mDice ? el('div.feed-av', null, [global.RoomPanels.avatarEl(mDice, 'mini')]) : null,
        el('div.feed-body', null, [
          el('div', null, [
            el('b', { text: '🎲 ' + (it.nickname || '') + ' · ' + (d.expr || '1D100') }),
            el('span', { style: { marginLeft: '6px' }, text: '＝ ' + d.total })
          ]),
          d.levelText ? el('div.tiny.dim', { text: d.levelText + (d.label ? (' · ' + d.label) : '') }) : null,
          /* v2.1.4：骰面明细（奖励/惩罚骰取哪一颗）—— 让「加了奖励骰」这件事可以被看见 */
          d.detail ? el('div.tiny.dim', { text: d.detail }) : null
        ].filter(Boolean))
      ].filter(Boolean)));
    } else if (it.sub === 'check' && it.opp) {
      /* v2.2.0（用户第 3 项）：对抗结果卡 —— 展示双方、反击/闪避、逐轮重掷、伤害段。
         失败 / 被躲开（damage=null）不显示伤害行。 */
      box.appendChild(opposedResultCard(it));
    } else if (it.sub === 'check') {
      /* v2.0.1 根因⑥：检定 / 对抗检定结果单独成卡（原来是灰扑扑的 log-sys，
         玩家容易漏掉「对抗检定：你 vs 他 → 结果」）。 */
      box.appendChild(el('div.log-check', null, [
        el('div', null, [el('b', { text: '🎯 ' + (it.text || '检定') })]),
        el('span.tiny.dim', { text: timeText(it.at) })
      ]));
    } else {
      box.appendChild(el('div.log-sys', null, [
        el('span', { text: it.text }),
        el('span.tiny.dim', { style: { marginLeft: '6px' }, text: timeText(it.at) })
      ]));
    }
  }

  /**
   * v2.2.1（用户第 5 项）：KP「待你确认」队列数（need === 'kp' | 'twice'，
   * 口径与 room-panels#kpPanel 一致）。数据源：权威端 Host.pending（KP 端 sess.host）。
   */
  function kpQueueCount() {
    var n = 0;
    var host = sess && sess.host;
    if (host && Array.isArray(host.pending)) {
      host.pending.forEach(function (q) {
        if (q && (q.need === 'kp' || q.need === 'twice')) n += 1;
      });
    }
    return n;
  }

  /**
   * v2.2.1（用户第 5 项）：KP「待处理」总数 = 对抗申请（await_kp）+ 需 KP 确认的队列项。
   */
  function kpPendingCount(st) {
    var n = 0;
    if (st && st.opposed && st.opposed.phase === 'await_kp') n += 1;
    n += kpQueueCount();
    return n;
  }

  /* 上一次 KP「待确认队列」数（用于新增时的 toast 提醒；null = 尚未初始化）。
     对抗申请的到来自带 checkOpposedPrompt 的专用 toast，故这里只盯队列，避免重复提示。 */
  var _kpQueueSeen = null;

  /** ⑥ 常驻工具栏（右下）：快捷操作行 + 缩放重置 + 骰子条 */
  function paintGameToolbar() {
    var st = currentState();
    global.UI.clear(pageRefs.diceEl);
    var ctx = panelCtx(st);
    var isKp = sess.role === 'kp';

    /* —— 快捷操作行 ——
       F2 的 plBottomBar 就绪后由它接管具体按钮；
       未就绪时这里给出最小可用的入口（战斗模式 / KP 工具 / 素材 / 手绘板）。 */
    var quick = el('div.gp-quick');
    if (isKp) {
      quick.appendChild(el('button.btn.sm' + (((st.meta || {}).mode === 'COMBAT') ? '.primary' : '.ghost'), {
        text: '⚔️ 战斗模式',
        onclick: function () { openCombatPrepare(ctx); }
      }));
      /* v2.2.1（用户第 5 项）：KP 工具按钮 + 未读角标（待处理对抗申请 / 需确认队列）。
         需求：「玩家发起申请后 KP 看不到提示，必须打开 KP 工具才看得到」——
         现在按钮上直接显示计数、有新增时脉冲 + toast，无需先点开。 */
      var pend = kpPendingCount(st);
      var queueN = kpQueueCount();
      var awaitOpposed = !!(st && st.opposed && st.opposed.phase === 'await_kp');
      var kpBtn = el('button.btn.sm.ghost' + (pend > 0 ? '.has-pending' : ''), {
        text: '🧰 KP 工具',
        onclick: function () {
          /* body 传 render 函数 → 可刷新：底层状态变化后弹层跟着重画 */
          global.UI.sheet({ title: 'KP 工具', body: function () { return global.RoomPanels.renderKp(panelCtx(currentState())); } });
        }
      });
      if (pend > 0) {
        kpBtn.appendChild(el('span.gp-badge' + (awaitOpposed ? '.pulse' : ''), { text: String(pend) }));
      }
      /* 队列有新增（如玩家申请治愈）→ toast 提醒；对抗申请另有专用 toast，不重复。 */
      if (_kpQueueSeen !== null && queueN > _kpQueueSeen) {
        global.UI.toast('有 ' + pend + ' 项待你处理：请打开「KP 工具」', 'info', 4000);
      }
      _kpQueueSeen = queueN;
      quick.appendChild(kpBtn);
      quick.appendChild(el('button.btn.sm.ghost', {
        text: '🗺 素材与地图',
        onclick: function () {
          global.UI.sheet({ title: '素材与地图', body: function () { return global.RoomPanels.explorationPanel(panelCtx(currentState())); } });
        }
      }));
      /* #9（用户报）：工具栏常驻「保存本局」入口 —— 不用先钻进弹层也能存整局。 */
      quick.appendChild(el('button.btn.sm.ghost.gp-save-btn', {
        text: '💾 保存本局',
        onclick: function () { global.RoomPanels.saveSlotsSheet(panelCtx(currentState())); }
      }));
    } else {
      quick.appendChild(el('button.btn.sm.ghost', {
        text: '📋 人物卡查看',
        /* v2.13.3（用户第 5 项）：看「车卡系统生成的完整信息图」，不再是几行摘要 */
        onclick: function () {
          var me = findMe(st.members);
          cardImageSheet(me || { nickname: sess.nickname });
        }
      }));
      quick.appendChild(el('button.btn.sm.ghost', {
        text: '✏️ 我的手绘板',
        onclick: function () {
          global.UI.sheet({ title: '我的手绘板', body: function () { return global.RoomPanels.playerBoardCard(panelCtx(currentState())); } });
        }
      }));
      /* v2.2.1（用户第 3 项）：玩家「⚔ 对抗」入口**移出**本快捷行 ——
         统一放到骰子条的扩展组（自定义骰子之后、SAN Check 之前），文案「战斗对抗」，
         且仅在战斗模式可用（见 room-panels.js#diceBar）。 */
    }
    /* 缩放重置入口（用户要求：缩放必须有还原入口） */
    quick.appendChild(el('button.btn.sm.ghost.gp-zoom-reset', {
      text: '⤢ 重置缩放', onclick: function () { resetZoom(); }
    }));
    pageRefs.zoomLabel = el('span.gp-zoom-pct', { text: Math.round(zoomState.scale * 100) + '%' });
    /* v2.1.7：点百分比 → 打开「UI 缩放设置」（预设档位，见 openZoomSheet） */
    pageRefs.zoomLabel.style.cursor = 'pointer';
    pageRefs.zoomLabel.title = '点击设置 UI 缩放';
    pageRefs.zoomLabel.addEventListener('click', function () { openZoomSheet(); });
    quick.appendChild(pageRefs.zoomLabel);

    pageRefs.diceEl.appendChild(quick);
    pageRefs.diceEl.appendChild(global.RoomPanels.diceBar(ctx));
    /* v2.0.10：工具栏在 .gp-zoom 之外 → 把实高写进 --gp-toolbar-h，供 .gp-zoom 扣除
       （否则 zoom 撑满 100% 再把 toolbar 挤出去 → .game-page 纵向溢出，A3 回归）。 */
    syncToolbarReserve();
  }

  /** v2.0.10：把工具栏实高写进 --gp-toolbar-h（.gp-zoom 高度扣除它，避免纵向溢出）。 */
  function syncToolbarReserve() {
    if (!pageRefs || !pageRefs.root || !pageRefs.diceEl) return;
    var h = Math.round(pageRefs.diceEl.getBoundingClientRect().height) || 0;
    if (h > 0) pageRefs.root.style.setProperty('--gp-toolbar-h', h + 'px');
  }

  /** P4-P6：探索 / 战斗 / KP 工具 + 掷骰条。
      所有面板都只读 state、只发 intent —— 不许在这里算规则。 */
  function paintPanels() {
    if (!pageRefs.panelEl || !global.RoomPanels) return;
    var st = currentState();
    if (!st) return;
    /* 开团前（招募中）不显示战斗/工具面板：那是「游戏里」的东西 */
    var started = (st.meta || {}).status === T().STATUS.IN_GAME;
    global.UI.clear(pageRefs.panelEl);
    global.UI.clear(pageRefs.diceEl);
    if (!started) return;

    var ctx = panelCtx(st);
    pageRefs.panelEl.appendChild(global.RoomPanels.render(ctx));
    pageRefs.diceEl.appendChild(global.RoomPanels.diceBar(ctx));
  }

  /** 面板上下文：把「当前会话」翻译成面板能用的几个口子 */
  function panelCtx(st) {
    return {
      st: st,
      role: sess.role,
      host: sess.host || null,
      client: sess.client || null,
      side: sess.side,
      startedAt: sess.startedAt,
      act: function (action) { hostAction(action); },
      intent: function (op, p) { sendIntent(op, p); },
      paint: function () { paint(false); },
      /* 主动刷新最上层可刷新 sheet：面板内部操作（如上传素材、点格子发布）
         之后可以立刻调它，不等下一帧 paint。 */
      refreshSheet: function () {
        if (global.UI && global.UI.refreshTopSheet) global.UI.refreshTopSheet();
      }
    };
  }

  function paintHead() {
    var T2 = T();
    var st = currentState();
    var meta = (st && st.meta) || {};
    global.UI.clear(pageRefs.headEl);
    pageRefs.headEl.appendChild(el('div.card.room-head', null, [
      el('div.card-head', null, [
        el('h3', { text: meta.name || ('房间 ' + sess.code) }),
        el('span.chip.sm', { text: T2.STATUS_TEXT[meta.status] || meta.status || '' }),
        el('span.chip.sm' + (sess.linkState === 'online' ? '.on' : ''), {
          text: LINK_TEXT[sess.linkState] || ''
        })
      ]),
      el('div.room-code', { text: sess.code }),
      el('div.tiny.dim', { text: '规则：COC 7th · 你是 ' + roleText(sess.role) }),
      /* 房主：把服务地址显眼地摆出来（同 paintGameHead），并提供复制入口 */
      sess.role === T2.ROLE.KP ? hostAddrBlock() : null,
      el('div.btn-group', { style: { marginTop: '10px' } }, [
        el('button.btn.sm.grow', { text: '复制邀请链接', onclick: copyInvite }),
        el('button.btn.sm.grow', { text: '离开', onclick: leaveConfirm })
      ])
    ]));
  }

  function paintMembers() {
    var T2 = T();
    var st = currentState();
    if (!st) return;
    var members = (st.members || []).slice();
    global.UI.clear(pageRefs.membersEl);

    var card = el('div.card', null, [
      el('div.card-head', null, [
        el('h3', { text: '成员' }),
        el('span.hint', { text: readyText(members) })
      ])
    ]);

    if (!members.length) {
      // KP 自己是「房主」，不在成员表里 —— 空列表要说清楚为什么
      card.appendChild(el('div.tiny.dim', {
        text: sess.role === T2.ROLE.KP
          ? '你是房主（KP）。把邀请链接发出去，玩家会出现在这里。'
          : '还没有成员信息，正在同步…'
      }));
    }

    members.forEach(function (m) {
      card.appendChild(memberRow(m));
    });

    // KP 的操作区
    if (sess.role === T2.ROLE.KP) {
      var allReady = members.filter(function (m) { return m.role === T2.ROLE.PLAYER && m.online; });
      var ready = allReady.length > 0 && allReady.every(function (m) { return m.ready; });
      var inGame = (st.meta || {}).status === T2.STATUS.IN_GAME;
      card.appendChild(el('div.btn-group', { style: { marginTop: '12px' } }, [
        // ⚠️ 不要写 'button.btn' + (ready ? '.primary' : '.') + '.grow' ——
        // 未准备时会拼出 'button.btn..grow'，多一个空类名
        el('button.btn.grow' + (ready ? '.primary' : ''), {
          text: inGame ? '已开团' : (ready ? '开始游戏' : '等待全员准备'),
          disabled: inGame || !ready,
          onclick: function () { hostAction({ op: 'room.start' }); }
        }),
        el('button.btn.ghost.grow', { text: '结束房间', onclick: closeRoomConfirm })
      ]));
      if (!inGame && allReady.length && !ready) {
        card.appendChild(el('div.tiny.dim', {
          style: { marginTop: '8px' },
          text: '还有 ' + allReady.filter(function (m) { return !m.ready; }).length + ' 位玩家没有准备'
        }));
      }
    } else {
      // 玩家：准备 / 取消准备
      var me = st.members ? findMe(st.members) : null;
      var isSpec = sess.role === T2.ROLE.SPECTATOR;
      var started = (st.meta || {}).status === T2.STATUS.IN_GAME;
      /* v2.0.0（用户要求 + 契约 §5.4）：必须绑定了角色卡才能准备。
         E 线在权威端也会校验 charId，这里先做 UI 前置约束。 */
      var bound = !!(me && me.charName);
      var needCard = !isSpec && !started && !bound;
      /* 开团之后还留着「我准备好了」是误导：那一步已经过去了。
         这里保留按钮位置但置灰改文案，玩家一眼能看出「已经开始了」。 */
      var pLabel = isSpec ? '旁观中（不能准备）'
                   : started ? '团已开始'
                   : (me && me.ready ? '取消准备' : '我准备好了');
      card.appendChild(el('button.btn' +
        (!isSpec && !started && !(me && me.ready) && !needCard ? '.primary' : '.ghost') + '.block', {
        style: { marginTop: '12px' },
        text: pLabel,
        disabled: isSpec || started || needCard,
        onclick: function () {
          sendIntent(T2.INTENT.READY, {
            ready: !(me && me.ready),
            charId: (me && me.charId) || sess.boundCharId || ''
          });
        }
      }));
      if (needCard) {
        card.appendChild(el('div.tiny.dim', {
          style: { marginTop: '6px', color: 'var(--warn)' },
          text: '请先绑定角色卡才能准备（点下面的「绑定角色卡」）。'
        }));
      }

      /* ---------- 绑定 / 更换角色卡 ----------
         这一块以前**整个不存在** —— 房间从来不知道玩家用的是哪张卡，
         于是卡上的疯狂症状、精神状态、SAN 上限减损在房间里全都读不到。
         绑定之后会把这张卡的「跑团摘要」上报给权威端（INTENT.CHAR），
         玩家自己与 KP 立刻能看到。 */
      if (!isSpec) {
        var bound = me && me.charName;
        card.appendChild(el('div.btn-group', { style: { marginTop: '8px' } }, [
          el('button.btn.sm.ghost.grow', {
            text: bound ? '更换角色卡' : '绑定角色卡',
            onclick: function () { bindSheetSheet(me); }
          })
        ]));
        if (bound) {
          card.appendChild(el('div.tiny.dim', {
            style: { marginTop: '6px' },
            text: '当前角色：' + bound + '（状态已同步给 KP）'
          }));
        } else {
          card.appendChild(el('div.tiny.dim', {
            style: { marginTop: '6px' },
            text: '还没绑定角色卡：绑定后你的 HP / SAN / 疯狂状态才会同步进来。'
          }));
        }
      }
    }

    pageRefs.membersEl.appendChild(card);
  }

  /* ============================================================
   * 角色卡绑定：把本地保存的人物卡「跑团摘要」上报给权威端
   *
   * 为什么需要这一步：房间只知道一个 nickname（谁在说话），并不知道
   * 谁是什么角色、有什么状态。以前 charName 永远是空的 —— 因为**客户端
   * 从来没发过 INTENT.CHAR**（接收分支写了，但没有发送方）。
   *
   * 这里只上报「跑团时真正会用到的摘要」，**不是整张卡**：
   *   · 症状名与永久/临时标记、精神状态（多选）、SAN 上限永久减损、
   *     SAN 上限与当前值、HP/MP 当前值。
   * 技能、装备、背景正文这些不进房间（体积大、房间里也不用）。
   * ============================================================ */

  /** 从一张本地人物卡抽出跑团摘要（结构见 room-model.js#sanitizeSheet）
   *
   *  v2.0.2 修复B：**必须上报 attrs / skills / status**。
   *  旧版没有 attrs → 服务端 sanitizeAttrs(undefined) 把九项全 clamp 成 0
   *  → 战斗队列里 PC 的 DEX 永远是 0（"dex 为空"的根因之一）。
   *  本机卡上属性容器是 c.attributes（store.js#newCharacter，字段名 str/con/siz/dex/…）。 */
  function sheetSummary(c) {
    var st = (c && c.status) || {};
    var mad = (global.CocMadness && global.CocMadness.list(c)) || [];
    return {
      name: (c && c.characterName) || '',
      attrs: (c && c.attributes) ? {
        str: c.attributes.str, con: c.attributes.con, siz: c.attributes.siz, dex: c.attributes.dex,
        app: c.attributes.app, int: c.attributes.int, pow: c.attributes.pow, edu: c.attributes.edu,
        luck: c.attributes.luck
      } : {},
      skills: (c && Array.isArray(c.skills)) ? c.skills.map(function (s) {
        return { name: s.name, total: (s.total != null ? s.total : s.value) };
      }) : [],
      status: {
        currentHP: st.currentHP, maxHP: st.maxHP, currentMP: st.currentMP, maxMP: st.maxMP,
        currentSAN: st.currentSAN, maxSAN: st.maxSAN, currentLuck: st.currentLuck,
        /* v2.1.5（用户第 2/4 项）：身体状态也上报（「死亡」= 撕卡，进房间即不可用）。 */
        body: st.body || '正常',
        /* v2.10.0（R2a）：濒死 / 昏迷改为独立布尔标记（可叠加，如「重伤 + 昏迷」）——
           一并透传，保证重连补报 / 换卡上报不丢标记（sanitizeSheet 白名单认这两个字段）。 */
        dying: !!st.dying,
        unconscious: !!st.unconscious
      },
      madness: mad.slice(0, 40).map(function (m) {
        /* v2.7.0（用户第 2 项）：补回 from / bg / sum —— 旧实现只保留 type/name/permanent/rounds，
           把来源标记丢了；重连补报或换卡上报后，房间里就再也分不清「背景症状」与
           「游戏中掷出的症状」（room-model#sanitizeSheet 的白名单本就认这三个字段，
           只要上游不丢即可）。 */
        return { type: m.type, name: m.name, permanent: !!m.permanent, rounds: m.rounds || 0,
                 from: m.from || '', bg: !!m.bg, sum: !!m.sum };
      }),
      mental: global.Store.mentalList(c),
      sanLoss: c && c.sanLoss ? c.sanLoss : 0,
      /* v2.2.0（用户第 3 项）：上报**武器清单 + 伤害加值 DB**，供权威端结算武器对抗。
         v2.3.0（用户第 8 / 10 项）：一并上报 perRound（连发）/ ammo（装弹）/ malfunction（故障），
         供权威端做连发惩罚骰与故障判定；白名单见 room-model#sanitizeSheet。 */
      weapons: (c && Array.isArray(c.weapons)) ? c.weapons.slice(0, 20).map(function (w) {
        return { name: w && w.name, skill: w && w.skill, damage: w && w.damage, pierce: w && w.pierce,
                 perRound: w && w.perRound, ammo: w && w.ammo, malfunction: w && w.malfunction };
      }) : [],
      db: (c && c.derivedStats && c.derivedStats.db) ? c.derivedStats.db : '0',
      maxSAN: st.maxSAN != null ? st.maxSAN : null,
      san: st.currentSAN != null ? st.currentSAN : null,
      hp: st.currentHP != null ? st.currentHP : null,
      mp: st.currentMP != null ? st.currentMP : null
    };
  }

  /**
   * v2.13.7（用户需求）：把角色卡头像压成 **64px 正方形缩略图**（居中裁剪）。
   *
   * 为什么必须缩：车卡第一步上传的头像是原图 dataURL（手机拍照经常 1-3MB），
   * 而它要随成员表广播给全桌 —— 原图进去会把 WS 帧撑爆、每个人重连都重传一遍。
   * 缩到 64px JPEG(0.72) 约 2-4KB，聊天/记录条目里当缩略图正好够用。
   * 失败/非图片 → 回调空串（调用方据此不上报 avatar，界面退回首字母头像）。
   */
  function avatarThumbDataUrl(url, size, cb) {
    cb = cb || function () {};
    if (!url || !/^data:image\//.test(url)) { cb(''); return; }
    var img = new Image();
    img.onload = function () {
      try {
        var n = size || 64;
        var cv = document.createElement('canvas');
        cv.width = n; cv.height = n;
        var cx = cv.getContext('2d');
        var side = Math.min(img.width, img.height) || n;
        var sx = (img.width - side) / 2, sy = (img.height - side) / 2;
        cx.drawImage(img, sx, sy, side, side, 0, 0, n, n);
        cb(cv.toDataURL('image/jpeg', 0.72));
      } catch (e) { cb(''); }
    };
    img.onerror = function () { cb(''); };
    img.src = url;
  }

  /** 上报（绑定 / 刷新状态都用它） */
  function reportSheet(c) {
    var sum = sheetSummary(c);
    /* v2.1.0 #11：权威端 `char.share` 是**整体覆盖** mem.sheet（room-model.js 的
       `mem.sheet = sanitizeSheet(p, mem)`），而本机 sheetSummary 不产 items/tempStatus →
       断线重连的补报（resendBoundSheet）会把 KP 定向指令写入的这两项抹成 []。
       这里把「权威端已下发给我」的这两项回填进上报表，保证幂等、重连不丢字段。
       （值本就来自权威端，回填不是「客户端自造数据」。） */
    try {
      if (sess && sess.client && sess.client.seat && sess.client.state) {
        var me = (sess.client.state.members || []).filter(function (m) {
          return m.seat === sess.client.seat;
        })[0];
        var msh = me && me.sheet;
        if (msh) {
          if (Array.isArray(msh.tempStatus)) sum.tempStatus = msh.tempStatus;
          if (Array.isArray(msh.items)) sum.items = msh.items;
          /* v2.1.6（用户验收）：body / mental 以**权威端**为准回填 ——
             断线重连补报时若用本机旧值，会把权威端已判定的「死亡/永久疯狂」
             覆盖回「正常」（用户实测：确认撕卡后重连，状态被重置）。 */
          var mst = msh.status || {};
          if (mst.body != null) sum.status.body = mst.body;
          /* v2.10.0（R2a）：权威端优先回填 dying / unconscious（与 body 同理由：
             断线重连补报时若用本机旧值，会把权威端已判定的濒死/昏迷覆盖掉）。 */
          if (mst.dying != null) sum.status.dying = !!mst.dying;
          if (mst.unconscious != null) sum.status.unconscious = !!mst.unconscious;
          if (Array.isArray(msh.mental)) sum.mental = msh.mental;
        }
      }
    } catch (e) { /* best-effort：拿不到就不回填 */ }
    /* v2.13.7：头像缩略图化后再随 sheet 上报（见 avatarThumbDataUrl 的体积说明）。
       缩略图生成要等图片解码，故把「发送 + 后续簿记」整段挪进回调，
       保证上报里的 avatar 一定是缩裁后的版本。 */
    var afterThumb = function (thumb) {
      if (thumb) sum.avatar = thumb;
      else delete sum.avatar;                 // 没有头像 → 不占广播体积
      sendIntent(T2_INTENT().CHAR, { id: (c && c.id) || '', name: sum.name, sheet: sum });
      /* 记到最后绑定的卡上：断线重连要自动补报一次，
         否则重连后权威端那边的 sheet 就旧了。 */
      if (sess) sess.boundCharId = (c && c.id) || '';
      /* v2.0.2：绑卡即为本房本卡建「临时卡」（幂等）—— 此后状态写回只改临时卡，不动原卡。 */
      ensureTempCardForSession(c);
      /* v2.13.8：绑定成功的提示挪到这里 —— reportSheet 自 v2.13.7 起改异步
         （等头像缩略图解码），函数不再返回 sum，调用方读 sum.name 会崩
         （QA 实测：绑卡后控制台报 Cannot read properties of undefined）。 */
      global.UI.toast('已绑定「' + (sum.name || '角色') + '」' +
        (Array.isArray(sum.madness) && sum.madness.length
          ? ('（含 ' + sum.madness.length + ' 条疯狂状态）') : ''), 'ok', 3000);
    };
    if (c && c.avatar && /^data:image\//.test(c.avatar)) {
      avatarThumbDataUrl(c.avatar, 64, function (t) { afterThumb(t || ''); });
    } else {
      afterThumb('');
    }
    return;
    /* 记到最后绑定的卡上：断线重连要自动补报一次，
       否则重连后权威端那边的 sheet 就旧了。 */
    if (sess) sess.boundCharId = (c && c.id) || '';
    /* v2.0.2：绑卡即为本房本卡建「临时卡」（幂等）—— 此后状态写回只改临时卡，不动原卡。 */
    ensureTempCardForSession(c);
    return sum;
  }
  function T2_INTENT() { return T().INTENT; }

  /**
   * v2.0.2：为当前会话建/刷新临时卡（幂等，best-effort）。
   * 只在「玩家 + 已知房间号 + 已知原卡」时创建；KP / 旁观者不建。
   */
  function ensureTempCardForSession(c) {
    if (!sess || sess.role === 'kp') return;
    var RS = global.RoomStore;
    if (!RS || typeof RS.ensureTempCard !== 'function') return;
    var code = sess.code;
    var seat = (sess.client && sess.client.seat) || '';
    var charId = (c && c.id) || sess.boundCharId || '';
    if (!code || !charId) return;
    try { RS.ensureTempCard(code, seat, charId); } catch (e) { /* 存不下也不影响对局 */ }
  }

  /** 重连 / 首次进入后：如果本机记着绑过的卡，自动补报一次 */
  function resendBoundSheet() {
    if (!sess || sess.role === 'kp' || !sess.boundCharId) return;
    if (!global.Store || !global.Store.getState) return;
    var c = global.Store.getState().characters[sess.boundCharId];
    if (c) reportSheet(c);
  }

  /** 加入房间时选中的角色卡：连上之后补一次绑定（INTENT.CHAR） */
  function bindPendingChar() {
    if (!sess || !sess.pendingCharId) return;
    var id = sess.pendingCharId;
    sess.pendingCharId = '';
    var c = (global.Store && global.Store.getState) ? global.Store.getState().characters[id] : null;
    if (c) reportSheet(c);
  }

  /** 选卡弹层：列出本机保存的人物卡 */
  function bindSheetSheet(me) {
    var all = (global.Store && global.Store.listCharacters) ? global.Store.listCharacters() : [];
    /* v2.1.8（用户第 4 项）：「英灵殿」的撕卡（死亡 / 永久疯狂）**不能带进房间** ——
       否则开局角色就是死的，什么都操作不了。绑定列表只列未撕卡的卡；
       已绑定的卡若后来被撕，保留一条「重新同步」入口（权威端守卫会兜底拒绝）。
       v2.1.9（用户第 1 项）：撕卡判定与「加入房间」的 charPicker 共用模块级 isRippedCard。 */
    var cur = sess && sess.boundCharId;
    var chars = all.filter(function (c) { return !isRippedCard(c) || c.id === cur; });
    var body = el('div');
    body.appendChild(el('div.tiny.dim', {
      text: '选择要带进这个房间的角色卡。绑定后，卡上的 HP / SAN / 疯狂状态会同步给 KP。已撕卡的卡（英灵殿）不能带进房间。'
    }));

    if (!chars.length) {
      body.appendChild(global.UI.emptyState('🕯', '没有可带入的角色卡',
        all.length ? '所有角色卡都已撕卡（在首页「英灵殿」里）——先去车一张新卡吧' : '先去「我的角色」车一张卡'));
      global.UI.sheet({ title: '绑定角色卡', body: body });
      return;
    }

    var list = el('div');
    chars.forEach(function (c) {
      var mad = (global.CocMadness && global.CocMadness.list(c)) || [];
      var mental = global.Store.mentalList(c);
      var meta = [];
      meta.push('SAN ' + ((c.status || {}).currentSAN != null ? c.status.currentSAN : '—') +
        '/' + ((c.status || {}).maxSAN != null ? c.status.maxSAN : '—'));
      if (c.sanLoss) meta.push('永久减损 ' + c.sanLoss);
      if (mad.length) meta.push('疯狂 ' + mad.length + ' 条');
      var abnormal = mental.filter(function (x) { return x !== '正常'; });
      if (abnormal.length) meta.push(abnormal.join('/'));
      if (isRippedCard(c)) meta.push('☠ 已撕卡（仅可重新同步）');

      list.appendChild(el('div.occ-item', null, [
        el('div.grow', null, [
          el('div.nm', { text: (c.characterName || '（无名）') + (c.id === cur ? '　✓ 当前' : '') }),
          el('div.meta', { text: meta.join('　·　') })
        ]),
        el('button.btn.sm' + (c.id === cur ? '.ghost' : '.primary'), {
          text: c.id === cur ? '重新同步' : '绑定',
          onclick: function () {
            /* v2.13.8：reportSheet 自 v2.13.7 起为异步（等头像缩略图），
               不再返回值 —— 绑定提示已挪进它内部的 afterThumb。 */
            reportSheet(c);
            api.close();
          }
        })
      ]));
    });
    body.appendChild(list);

    if (cur) {
      body.appendChild(el('button.btn.ghost.block', {
        style: { marginTop: '10px' },
        text: '解绑（清空房间里的角色信息）',
        onclick: function () {
          sendIntent(T().INTENT.CHAR, { id: '', name: '', sheet: { name: '', madness: [], mental: ['正常'] } });
          sess.boundCharId = '';
          api.close();
          global.UI.toast('已解绑', 'ok');
        }
      }));
    }

    var api = global.UI.sheet({ title: '绑定角色卡', body: body });
    return api;
  }

  function readyText(members) {    var T2 = T();
    var ps = members.filter(function (m) { return m.role === T2.ROLE.PLAYER; });
    if (!ps.length) return '';
    return ps.filter(function (m) { return m.ready; }).length + '/' + ps.length + ' 已准备';
  }

  function findMe(members) {
    if (sess.role === 'kp') return null;
    var seat = sess.client ? sess.client.seat : '';
    for (var i = 0; i < members.length; i++) {
      if (members[i].seat === seat) return members[i];
    }
    // client.seat 在收到 ready（含自己的 seat）之后才有值，退化用 cid 兜底
    return null;
  }

  function memberRow(m) {
    var T2 = T();
    var tags = [];
    if (m.role === T2.ROLE.KP) tags.push(chip('KP', 'gold'));
    if (m.role === T2.ROLE.SPECTATOR) tags.push(chip('旁观'));
    if (!m.online) tags.push(chip('离线', 'off'));
    else if (m.ready) tags.push(chip('已准备', 'on'));

    var info = [];
    if (m.charName) info.push('角色：' + m.charName);
    /* KP 看玩家的异常状况：症状名对 KP 是可见的（他要据此推进剧情），
       但对其他玩家，权威端已经在响应里把症状名裁掉了（见 _cropMember），
       这里拿到的就是「有几条」这种计数。 */
    if (m.sheet) {
      var ab = (m.sheet.mental || []).filter(function (x) { return x !== '正常' && x !== '异常'; });
      if (ab.length) info.push(ab.join('/'));
      if (m.sheet.madnessCount) info.push('疯狂 ' + m.sheet.madnessCount + ' 条');
      if (m.sheet.sanLoss) info.push('SAN 减损 ' + m.sheet.sanLoss);
    }

    var row = el('div.member-row' + (m.online ? '' : '.off'), null, [
      el('div.grow', null, [
        el('div.member-name', { text: m.nickname || '（无名）' }),
        info.length ? el('div.tiny.dim', { text: info.join(' · ') }) : null
      ]),
      el('div.member-tags', null, tags)
    ]);

    if (sess.role === T2.ROLE.KP && m.role !== T2.ROLE.KP) {
      row.appendChild(el('button.icon-btn.sm', {
        text: '✕', title: '移出房间',
        onclick: function () {
          global.UI.confirm('把「' + (m.nickname || '') + '」移出房间？他需要重新加入才能回来。',
            { danger: true, okText: '移出' }).then(function (ok) {
            if (ok) hostAction({ op: 'room.kick', seat: m.seat });
          });
        }
      }));
    }
    return row;
  }

  /**
   * v2.0.1 根因⑥(b)：游戏页常驻线索条。
   *
   * 旧实现把线索画进 `.gp-status`，而 PL 骨架的 `.gp-status` 排在 `.gp-main`
   * **之后** —— 单列布局下被顶到页面最底部，用户根本看不到（「KP 递的线索收不到」）。
   * 这里把线索**补画**到顶栏下方、`main` 之前的 `.gp-priv`，不用滚就看到；
   * `.gp-status` 里原有的私有卡**保留**（房间页仍要靠它）。
   */
  function paintPrivates() {
    var elm = pageRefs && pageRefs.privEl;
    if (!elm) return;
    /* v2.13.8（用户需求）：全屏查看期间，私密卡整体搬进了 .gp-fs--priv 覆盖层 ——
       此时**只刷新覆盖层里的那张卡**，绝不 clear(privEl)（会把正在全屏显示的节点
       清没，用户视角就是「全屏突然空了/退回半截」）。无新线索时 fillPrivCard 自重绘。 */
    if (_fsPriv) { fillPrivCard(_fsPriv.card, currentState(), false); return; }
    /* v2.1.8（用户第 3 项）：重画**前**先记录用户是否停在底部附近。
       手动上滚看旧线索时（距底 > 28px），重画后**不**强行拉回底部 —— 只把
       scrollTop 夹回合法范围（保持用户视角）；停在底部附近才自动跟随最新一条。 */
    var follow = true, prevTop = 0;
    try {
      prevTop = elm.scrollTop || 0;
      follow = (elm.scrollHeight - prevTop - elm.clientHeight) < 28;
    } catch (e) { follow = true; }
    global.UI.clear(elm);
    var st = currentState();
    if (!st || !st.privates || !st.privates.length) return;
    /* v2.13.8（用户需求）：玩家右列的私密条加一个标题栏（含 ⛶ 全屏按钮，与聊天 /
       游戏记录同款），线索列表收进内部滚动容器 —— 标题栏吸顶不随线索滚走。
       KP 视角（privWithFs 未置位）保持原样：一张自带标题的 .priv-card，无回归。 */
    var withFs = !!pageRefs.privWithFs;
    var host = elm;
    if (withFs) {
      elm.appendChild(privHeadBar());
      var scroller = el('div.priv-scroll');
      elm.appendChild(scroller);
      host = scroller;
    }
    var card = el('div.card.priv-card');
    fillPrivCard(card, st, !withFs);
    host.appendChild(card);
    /* v2.1.8（用户第 3 项）：智能滚底 —— 用户停在底部附近（或首次渲染）才
       scrollTop = scrollHeight（最新一条始终可见）；用户上滚看旧线索时不拉回，
       只把 scrollTop 夹在合法范围内保持视角。容器高度由 CSS 固定
       （网格 104px 行 / 单列 30vh），消息再多也不顶开别的栏位。 */
    try {
      if (follow) host.scrollTop = host.scrollHeight;
      else host.scrollTop = Math.min(prevTop, Math.max(0, host.scrollHeight - host.clientHeight));
    } catch (e) { /* 非滚动容器：忽略 */ }
  }

  /**
   * v2.13.8（用户需求）：把私密线索填进一张 .priv-card。
   * 三处共用：① 右列内嵌条 ② 全屏覆盖层里的同一张卡（节点搬移，内容刷新）③ KP 视角原路径。
   * @param {Element} card 目标卡片（.priv-card）
   * @param {object} st 当前状态
   * @param {boolean} withTitle 是否画卡片自带标题（内嵌条已有标题栏时不画，避免重复）
   */
  function fillPrivCard(card, st, withTitle) {
    global.UI.clear(card);
    if (withTitle) card.appendChild(el('div.card-title', { text: '📩 只给你看的信息' }));
    if (!st || !st.privates || !st.privates.length) return;
    /* v2.1.1（用户定稿线框 三）：三处信息流统一「最新在最下」——
       按时间**正序**渲染（老 → 新，最新在底部）。 */
    var items = st.privates.slice(-12);
    /* 有**新到的**线索（seq 大于上次画过的最大值）→ 高亮，提醒用户注意 */
    var lastSeq = 0;
    st.privates.forEach(function (p) { if ((p.seq || 0) > lastSeq) lastSeq = p.seq || 0; });
    var isNew = lastSeq > (pageRefs._privSeenSeq || 0) && !!pageRefs._privSeenSeq;
    if (isNew) card.classList.add('new');
    items.forEach(function (p) {
      card.appendChild(el('div.priv-line', null, [
        el('div.tiny.dim', { text: (p.title || '线索') + ' · ' + timeText(p.at) }),
        el('div.small.priv-text', {
          text: p.text || '',
          title: '点开查看完整内容',
          onclick: function () {
            global.UI.sheet({
              title: (p.title || '线索'),
              body: el('div', null, [
                el('div.small', { text: p.text || '' }),
                el('div.tiny.dim', { style: { marginTop: '8px' }, text: '收到时间 ' + timeText(p.at) })
              ])
            });
          }
        })
      ]));
    });
    pageRefs._privSeenSeq = lastSeq;
  }

  /** v2.13.8（用户需求）：私密条标题栏（点标题或 ⛶ 进全屏）—— 与 feedHead 同款结构。 */
  function privHeadBar() {
    var btn = el('button.gp-region-fs-btn', {
      text: '⛶', title: '全屏查看',
      onclick: function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); fullscreenPriv(); }
    });
    var head = el('div.gp-region-head', null, [
      el('span.gp-region-head-t', { text: '📩 只给你看的信息' }), btn
    ]);
    head.addEventListener('click', function (ev) { if (ev && ev.target === btn) return; fullscreenPriv(); });
    return head;
  }

  /**
   * v2.13.8（用户需求）：「只给你看的信息」全屏查看。
   * 做法与 fullscreenFeed 一致：把 .priv-card 整体搬进 .gp-fs--priv 覆盖层
   * （注释占位保持原顺序），点「← 返回」或覆盖层空白还原。
   * ⚠️ 同一时刻只允许一个全屏：_fs（聊天/记录）在时会直接忽略，防套娃。
   */
  function fullscreenPriv() {
    if (_fsPriv || _fs) return;
    var elm = pageRefs && pageRefs.privEl;
    var card = elm ? elm.querySelector('.priv-card') : null;
    if (!card || !card.parentNode) return;
    var ov = el('div.gp-fs.gp-fs--priv');
    var head = el('div.gp-fs-head', null, [
      el('span.gp-region-head-t', { text: '📩 只给你看的信息' }),
      el('button.btn.primary', { text: '← 返回', onclick: function () { restorePrivFs(); } })
    ]);
    var body = el('div.gp-fs-body');
    ov.appendChild(head);
    ov.appendChild(body);
    /* 占位注释：搬回时按它定位（保持原顺序）。 */
    var placeholder = document.createComment('priv-fs');
    card.parentNode.insertBefore(placeholder, card);
    body.appendChild(card);
    ov.addEventListener('click', function (ev) {
      /* 点覆盖层空白（非内容、非按钮）也还原 —— 与其它全屏查看器一致的直觉。 */
      if (ev.target === ov || ev.target === body) restorePrivFs();
    });
    document.body.appendChild(ov);
    _fsPriv = { card: card, placeholder: placeholder, ov: ov };
  }

  /** 退出私密信息全屏：节点搬回原位 + 重画（保证原位内容与全屏里看到的一致）。 */
  function restorePrivFs() {
    if (!_fsPriv) return;
    var f = _fsPriv;
    _fsPriv = null;
    if (f.placeholder.parentNode) {
      f.placeholder.parentNode.insertBefore(f.card, f.placeholder);
      f.placeholder.parentNode.removeChild(f.placeholder);
    }
    if (f.ov.parentNode) f.ov.parentNode.removeChild(f.ov);
    paintPrivates();
  }

  function paintStatus() {
    var T2 = T();
    var st = currentState();
    global.UI.clear(pageRefs.statusEl);
    if (!st) return;
    var out = [];

    /* 需要我处理的：KP 改我状态的请求（必须我同意才生效）。
       这是「玩家主权」的界面体现 —— 权威端不许替玩家改。
       ⚠️ 必须渲染**全部**待办：旧代码只画 requests[0]，一旦有一条卡住
       （v1.18.4 之前已处理的请求不会从列表摘除），后面来的新请求全部看不见。 */
    if (sess.role !== T2.ROLE.KP && st.requests && st.requests.length) {
      st.requests.forEach(function (rq) {
        out.push(rq.op === 'check.request' ? checkReqCard(rq) : consentCard(rq));
      });
    }

    /* v2.9.0（用户第 3 项）：删除回退投票入口 —— 回退功能整体移除，玩家侧不再出现投票卡。 */

    // 只给自己的私有信息（线索、提示）：单独一张卡，不混进公共聊天
    /* v2.0.10（用户第 4 项）：**游戏页**已有常驻 `.gp-priv` 承载线索，这里不再重复画
       —— 否则游戏页会出现两处「只给你看的信息」（重复）。房间页没有 .gp-priv，
       房间页仍需此卡（见上方 paintPrivates 注释），故仅对游戏页跳过。 */
    if (st.privates && st.privates.length && !pageRefs.isGame) {
      var pc = el('div.card.private-card', null, [el('div.card-title', { text: '只给你看的信息' })]);
      /* v2.1.1（用户定稿线框 三）：与 .gp-priv 一致 —— 正序渲染（老→新，最新在底部）。 */
      st.privates.slice(-5).forEach(function (p) {
        pc.appendChild(el('div.private-item', null, [
          el('div.tiny.dim', { text: (p.title || '') + ' · ' + timeText(p.at) }),
          el('div.small', { text: p.text })
        ]));
      });
      out.push(pc);
    }

    /* 我自己的角色状态（HP / SAN / 疯狂 / 精神状态）。
       ⚠️ 用**权威端回给我的**那份（member.sheet），而不是直接读本地人物卡 ——
       这样玩家和 KP 看到的是同一份数据；本地卡改了但没上报时会提示不同步。
       游戏页（平铺布局）不在这里放完整卡 —— 入口在玩家栏点开与工具栏，
       这一列只放「需要我处理」的卡片，保持 §5 的区域分工。 */
    if (sess.role !== T2.ROLE.KP && !pageRefs.isGame) {
      var me2 = st.members ? findMe(st.members) : null;
      if (me2 && me2.sheet && me2.sheet.name) out.push(mySheetCard(me2));
    }

    out.forEach(function (n) { pageRefs.statusEl.appendChild(n); });
  }

  /** 玩家在房间里看到的「我的角色状态」卡 */
  function mySheetCard(m) {
    var T2 = T();
    var sh = m.sheet;
    var rt = m.runtime || {};

    var vitals = [];
    if (rt.hp != null || sh.hp != null) vitals.push('HP ' + (rt.hp != null ? rt.hp : sh.hp));
    if (rt.san != null || sh.san != null) {
      vitals.push('SAN ' + (rt.san != null ? rt.san : sh.san) +
        (sh.maxSAN != null ? ' / ' + sh.maxSAN : ''));
    }
    if (rt.mp != null || sh.mp != null) vitals.push('MP ' + (rt.mp != null ? rt.mp : sh.mp));
    if (sh.sanLoss) vitals.push('SAN 上限永久减损 ' + sh.sanLoss);

    var mental = (sh.mental || []).filter(function (x) { return x !== '正常'; });

    var card = el('div.card', null, [
      el('div.card-head', null, [
        el('h3', { text: '我的角色 · ' + sh.name }),
        el('span.hint', { text: '已同步给 KP' })
      ]),
      el('div.tiny.dim', { text: vitals.join('　·　') }),
      mental.length ? el('div.tiny', { style: { marginTop: '4px' },
        text: '精神状态：' + mental.join('　') }) : null
    ]);

    /* 疯狂状态：症状名 + 永久/剩余轮数。这是玩家自己看自己的，
       权威端对本人是全量下发的。 */
    var mad = sh.madness || [];
    if (mad.length) {
      var wrap = el('div.row.wrap', { style: { gap: '5px', marginTop: '7px' } });
      mad.forEach(function (x) {
        wrap.appendChild(el('span.tag' + (x.permanent ? '.danger' : '.arcane'), {
          text: (x.type === 'mania' ? '狂躁症 ' : '恐惧症 ') + x.name +
            (x.permanent ? '（永久）' : '（' + x.rounds + ' 轮）')
        }));
      });
      card.appendChild(wrap);
    }

    /* 本地卡与房间里的不一致时给个提示 —— 玩家改了卡但没点「重新同步」。 */
    var local = localSheetFor(m);
    if (local && local.madnessCount !== mad.length) {
      card.appendChild(el('div.tiny.dim', { style: { marginTop: '7px', color: 'var(--warn)' },
        text: '本地角色卡的疯狂状态与房间不同步，点「更换角色卡 → 重新同步」更新。' }));
    }
    return card;
  }

  /** 本机保存的同一张卡（用来对账），找不到返回 null */
  function localSheetFor(m) {
    if (!global.Store || !global.Store.getState || !m.charId) return null;
    var c = global.Store.getState().characters[m.charId];
    if (!c) return null;
    var mad = (global.CocMadness && global.CocMadness.list(c)) || [];
    return { madnessCount: mad.length, mental: global.Store.mentalList(c) };
  }

  /** 玩家侧：KP 请求改我的状态 —— 同意 / 拒绝 */
  function consentCard(req) {
    var T2 = T();
    var changes = [];
    var pl = req.p || {};
    if (pl.hp !== undefined) changes.push('HP → ' + pl.hp);
    if (pl.san !== undefined) changes.push('SAN → ' + pl.san);
    if (pl.mp !== undefined) changes.push('MP → ' + pl.mp);
    return el('div.card', { style: { borderColor: 'rgba(212,169,74,.45)' } }, [
      el('div.card-title', { text: 'KP 想调整你的状态' }),
      el('div.small', { text: '变更：' + (changes.join('、') || '（无）') }),
      req.reason ? el('div.tiny.dim', { text: '理由：' + req.reason }) : null,
      el('div.tiny.dim', { text: '只有你点「同意」才会生效。' }),
      el('div.btn-group', { style: { marginTop: '10px' } }, [
        el('button.btn.ghost.grow', {
          text: '拒绝', onclick: function () {
            sendIntent(T2.INTENT.CONSENT, { id: req.id, agree: false });
            paint(false);
          }
        }),
        el('button.btn.primary.grow', {
          text: '同意', onclick: function () {
            sendIntent(T2.INTENT.CONSENT, { id: req.id, agree: true });
            paint(false);
          }
        })
      ])
    ]);
  }

  /**
   * 玩家侧：KP 推送的检定请求卡（v1.18.5 修「收不到提示」）。
   * 点「掷骰」直接出结果（权威端算），不再「请 KP 投掷」。
   * 目标值从本机绑定的人物卡里查（模糊匹配）；查不到就裸掷 D100 让 KP 裁定。
   */
  function checkReqCard(req) {
    var T2 = T();
    var pl = req.p || {};
    var skill = pl.skill || '检定';
    var diffText = { HARD: '困难', EXTREME: '极难' }[pl.difficulty] || '常规';
    var local = findLocalSkill(skill);
    /* v2.1.0 缺陷2（用户第 6 项）：本机没加点 / 没绑卡时，用 KP 侧**权威**算出的 base（pl.base）兜底 ——
       否则卡片上技能名与基础值都空（用户报「没有链接到没有加点的技能」）。 */
    var found = local || (pl.base != null ? { name: skill, total: pl.base } : null);
    var bp = 0;   // 奖励(+)/惩罚(−) 骰数，卡片内的小计数器

    var bpLabel = el('span.cnt', { text: '0' });
    function syncBp() { bpLabel.textContent = (bp > 0 ? '+' + bp + ' 奖励' : bp < 0 ? bp + ' 惩罚' : '0'); }
    syncBp();

    var rows = [
      el('div.card-title', { text: '🎲 KP 要求检定：' + skill + '（' + diffText + '）' }),
      req.reason ? el('div.small', { text: '场景：' + req.reason }) : null,
      el('div.tiny.dim', {
        text: local ? ('你的「' + local.name + '」=' + local.total + '，将按这个值判定成功等级。')
            : (found ? ('本机卡未加点「' + skill + '」，按 KP 侧权威值 ' + found.total + ' 判定。')
                     : '本机人物卡里没找到这个技能，将掷普通 D100，由 KP 按结果裁定。')
      }),
      el('div.btn-group', { style: { marginTop: '6px' } }, [
        el('button.btn.sm.ghost', { text: '−', onclick: function () { bp = Math.max(-2, bp - 1); syncBp(); } }),
        el('span', { style: { alignSelf: 'center' } }, [bpLabel]),
        el('button.btn.sm.ghost', { text: '+', onclick: function () { bp = Math.min(2, bp + 1); syncBp(); } })
      ]),
      el('div.btn-group', { style: { marginTop: '10px' } }, [
        el('button.btn.ghost.grow', {
          text: '忽略', onclick: function () {
            sendIntent(T2.INTENT.CONSENT, { id: req.id, agree: false });
            paint(false);
          }
        }),
        el('button.btn.ghost.grow', {
          text: '🎲 掷骰', onclick: function () {
            sendIntent(T2.INTENT.DICE, {
              direct: true, reqId: req.id,
              base: found ? found.total : undefined,
              difficulty: pl.difficulty || 'REGULAR',
              bonus: bp > 0 ? bp : 0,
              penalty: bp < 0 ? -bp : 0,
              label: skill
            });
            paint(false);
          }
        }),
        /* v2.1.0 缺陷2（用户第 6 项）：**同意** = 授权权威端按「权威目标值 + KP 指定难度」替该玩家
           掷一次 D100、广播结果并摘卡（模型 Host.consent agree=true → _rollCheckRequest）。 */
        el('button.btn.primary.grow', {
          text: '✅ 同意', onclick: function () {
            sendIntent(T2.INTENT.CONSENT, { id: req.id, agree: true });
            paint(false);
          }
        })
      ])
    ];
    return el('div.card', { style: { borderColor: 'rgba(90,159,212,.45)' } }, rows.filter(Boolean));
  }

  /** 在本机绑定的角色卡里找一个技能值（精确名 → 包含名） */
  function findLocalSkill(name) {
    try {
      if (!global.Store || !global.Store.getState || !sess || !sess.boundCharId) return null;
      var c = global.Store.getState().characters[sess.boundCharId];
      var list = (c && c.skills) || [];
      var lower = String(name || '').toLowerCase();
      var hit = null;
      for (var i = 0; i < list.length; i++) {
        var n = String(list[i].name || '').toLowerCase();
        if (n === lower) { hit = list[i]; break; }
      }
      if (!hit) {
        for (var j = 0; j < list.length; j++) {
          var n2 = String(list[j].name || '').toLowerCase();
          if (n2 && (n2.indexOf(lower) >= 0 || lower.indexOf(n2) >= 0)) { hit = list[j]; break; }
        }
      }
      return hit ? { name: hit.name, total: hit.total } : null;
    } catch (e) { return null; }
  }

  /* v2.9.0（用户第 3 项）：删除回退投票卡 —— 回退功能整体移除，玩家侧不再有投票入口。 */

  function paintLog(scrollBottom) {
    var T2 = T();
    var st = currentState();
    if (!st) return;
    var log = pageRefs.logEl;
    global.UI.clear(log);

    var items = [];
    (st.logs || []).forEach(function (l) {
      items.push({ at: l.at || 0, kind: 'sys', seat: l.seat, text: l.text, sub: l.kind });
    });
    (st.chats || []).forEach(function (c) {
      items.push({ at: c.at || 0, kind: 'chat', seat: c.seat, nickname: c.nickname, text: c.text });
    });
    /* 权威掷骰结果：单独一种气泡，看得见「谁掷了什么、什么成功等级」 */
    (st.dice || []).forEach(function (d) {
      items.push({ at: d.at || 0, kind: 'dice', seat: d.seat, nickname: d.nickname, dice: d });
    });
    items.sort(function (a, b) { return a.at - b.at; });

    if (!items.length) {
      log.appendChild(el('div.room-log-empty', {
        text: '还没有消息。说点什么开始吧。'
      }));
      return;
    }

    var mySeat = sess.client ? sess.client.seat : 'host';
    items.slice(-200).forEach(function (it) {
      if (it.kind === 'sys') {
        log.appendChild(el('div.log-sys', null, [
          el('span.log-time', { text: timeText(it.at) }),
          el('span', { text: it.text })
        ]));
        return;
      }
      if (it.kind === 'dice') {
        log.appendChild(diceBubble(it));
        return;
      }
      var mine = it.seat === mySeat;
      log.appendChild(el('div.msg' + (mine ? '.mine' : ''), null, [
        el('div.msg-meta', null, [
          el('span.msg-name', { text: it.nickname || '某人' }),
          el('span.log-time', { text: timeText(it.at) })
        ]),
        el('div.msg-bubble', { text: it.text })
      ]));
    });

    if (scrollBottom) log.scrollTop = log.scrollHeight;
  }

  /** 掷骰结果气泡：把规则服务给的成功等级原样显示（界面不自己算等级） */
  function diceBubble(it) {
    var d = it.dice || {};
    var lvKey = (d.level || '').toLowerCase();
    var lvText = d.levelText || d.level || '';
    return el('div.dice-result', null, [
      el('div', null, [
        el('span.roll', { text: String(d.total === undefined ? '—' : d.total) }),
        lvText ? el('span.lv.lv-' + lvKey, { text: ' ' + lvText }) : null
      ]),
      el('div.expr', { text: (it.nickname || '某人') + ' 掷 ' + (d.expr || '1D100') +
        (d.label ? ('（' + d.label + '）') : '') + ' · ' + timeText(it.at) }),
      /* v2.1.4：骰面明细（奖励/惩罚骰取哪一颗）—— 否则只看到一个数字，
         无法判断奖励骰到底有没有生效（用户实测「加 2 个奖励骰还是 81」）。 */
      d.detail ? el('div.tiny.dim', { style: { marginTop: '2px' }, text: d.detail }) : null
    ].filter(Boolean));
  }

  function chatBar() {
    var T2 = T();
    var input = el('input.input', { type: 'text', placeholder: '说点什么…', maxlength: 600 });
    function send() {
      var text = M.cleanText(input.value, 600);
      if (!text) return;
      sendIntent(T2.INTENT.CHAT, { text: text });
      input.value = '';
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); send(); }
    });
    /* v2.13.6（用户需求）：点一下输入框 → 全屏编辑。
       单行输入框写长了只能看到光标附近那一行，回头改前半段几乎不可能；
       全屏后整段可见、可整段编辑。内容只**填回**聊天框，不会自动发送。 */
    input.addEventListener('click', function () { openChatEditor(input); });
    var isSpec = sess && sess.role === T2.ROLE.SPECTATOR;
    pageRefs.sendBtn = el('button.btn.primary', {
      text: '发送', disabled: isSpec, onclick: send
    });
    /* v2.13.5（用户需求）：AI RP —— 把「我想做什么」写成一端入戏的 RP 文本，
       只填进输入框（可改），不自动发送。KP / 玩家两个视角都有（同一个 chatBar）。 */
    var aiBtn = el('button.btn.sm.ghost.rp-ai-btn', {
      text: '✨ AI RP',
      title: '让 AI 把你想做的事写成一段入戏的 RP 文字（只填入输入框，不会自动发送）',
      disabled: isSpec,
      onclick: function () { aiRpSheet(input); }
    });
    return el('div.room-chatbar', null, [input, aiBtn, pageRefs.sendBtn]);
  }

  /* ============================================================
   * v2.13.5（用户需求）：AI RP
   * ------------------------------------------------------------
   * 场景：KP / 玩家不想干巴巴地「我撬锁」，想让 AI 把动作写成一段入戏的描写。
   * 流程：点「✨ AI RP」→ 输入一句自己的想法 → 「生成 RP 内容」→
   *       调「AI 设置」里那套 OpenAI 兼容接口 → 结果**填进聊天输入框**（不发送）。
   * 刻意不做的事：不自动发送、不改游戏状态、不替 KP 宣布规则结果。
   * ============================================================ */

  /**
   * v2.13.6（用户需求）：聊天输入框的**全屏编辑器**。
   *
   * 为什么：单行 input 写长文只能显示一行，想回看/修改前面写了什么基本靠猜。
   * 现在点一下输入框就铺满全屏，整段可见、可编辑；
   * 「确定」只把文字填回聊天框（不自动发送，玩家还能再改），「取消」丢弃改动。
   */
  function openChatEditor(input) {
    if (!input || input._editing) return;
    input._editing = true;
    var draft = String(input.value || '');

    var ta = el('textarea.textarea.chat-edit-area', { rows: '6', maxlength: '600' });
    ta.value = draft;
    var hint = el('div.tiny.dim', { text: '最多 600 字。「确定」只填回聊天框，不会自动发送。' });

    var ov = el('div.gp-fs.gp-fs--chat');
    var head = el('div.chat-edit-head', null, [
      el('span.gp-region-head-t', { text: '✍️ 聊天内容' }),
      el('button.btn.sm.ghost', { text: '取消', onclick: function () { close(false); } })
    ]);
    var foot = el('div.chat-edit-foot', null, [
      hint,
      el('button.btn.primary', {
        text: '确定（填入聊天框）',
        onclick: function () { close(true); }
      })
    ]);
    ov.appendChild(head);
    ov.appendChild(ta);
    ov.appendChild(foot);
    document.body.appendChild(ov);

    var done = false;
    function close(apply) {
      if (done) return;
      done = true;
      var text = String(ta.value || '');
      if (ov.parentNode) ov.parentNode.removeChild(ov);
      input._editing = false;
      if (apply) {
        input.value = text;
        try { input.focus(); } catch (e) { /* 忽略 */ }
      }
    }
    /* 点遮罩空白 = 取消（与其它全屏查看器一致） */
    ov.addEventListener('click', function (ev) { if (ev.target === ov) close(false); });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      /* Enter 直接送出（与单行框一致）；Shift+Enter 换行 */
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); close(true); }
      e.stopPropagation();
    });
    try { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) { /* 忽略 */ }
  }

  /** 剥掉模型偶尔会加的引号 / 「RP：」前缀 / 解释性开场 */
  function cleanRpText(t) {
    var x = String(t || '').trim();
    x = x.replace(/^\s*(RP|rp|角色扮演)\s*[:：]\s*/, '');
    x = x.replace(/^```[\s\S]*?\n/, '').replace(/```$/, '');
    var pairs = [['「', '」'], ['“', '”'], ['"', '"'], ["'", "'"]];
    for (var i = 0; i < pairs.length; i++) {
      var a = pairs[i][0], b = pairs[i][1];
      if (x.length > 2 && x.charAt(0) === a && x.charAt(x.length - 1) === b) {
        x = x.slice(1, -1).trim();
      }
    }
    return x.trim();
  }

  /** 组装提示词：角色底稿 + 场景 + 最近桌上记录，交给模型写成 RP */
  function buildRpMessages(isKp, me, st, idea) {
    var sh = (me && me.sheet) || {};
    var sc = (st && st.scene) || {};
    var lines = [];
    if (sh.name) lines.push('角色姓名：' + sh.name + (sh.occupation ? '（' + sh.occupation + '）' : ''));
    var stt = sh.status || {};
    if (stt.currentHP != null || stt.currentSAN != null) {
      lines.push('当前状态：HP ' + (stt.currentHP != null ? stt.currentHP : '?') +
        (stt.maxHP != null ? '/' + stt.maxHP : '') +
        '，SAN ' + (stt.currentSAN != null ? stt.currentSAN : '?') +
        (stt.body && stt.body !== '正常' ? '，身体：' + stt.body : ''));
    }
    if (Array.isArray(sh.mental) && sh.mental.length) lines.push('精神状态：' + sh.mental.join('、'));
    if (sc.title) lines.push('当前场景：' + sc.title);
    if (sc.desc) lines.push('场景说明：' + String(sc.desc).slice(0, 200));
    var logs = ((st && st.logs) || []).slice(-5).map(function (l) { return '· ' + (l.text || ''); })
      .filter(function (x) { return x.length > 2; });
    if (logs.length) lines.push('最近的桌上记录：\n' + logs.join('\n'));

    var sys = '你是一位资深《克苏鲁的呼唤》第 7 版守秘人，也是一名擅长角色扮演的写手。\n' +
      '任务：把玩家给出的「想法」改写成一段符合角色设定与世界观的简体中文 RP 文本。\n' +
      '要求：\n' +
      '1) 用角色的口吻说话、行动、思考，体现其性格、职业与时代感，绝不跳出角色；\n' +
      '2) 60–180 字，1–3 句话，克制、有画面感，避免堆砌形容词；\n' +
      '3) 不写掷骰、数值、规则术语，不替守秘人宣布「成功/失败」的裁定；\n' +
      '4) 只输出这段 RP 文字本身：不要解释、不要加引号、不要写「好的」「以下是」这类开场。';

    var usr = (isKp
      ? '我是守秘人（KP）：请写成场景描写 / NPC 的台词与反应（也可以是某次检定的叙事化结果）。\n'
      : '我是玩家：请以我的调查员身份行动与发言。\n') +
      (lines.length ? lines.join('\n') + '\n' : '') +
      '我的想法：' + idea;

    return [{ role: 'system', content: sys }, { role: 'user', content: usr }];
  }

  function aiRpSheet(targetInput) {
    var st = currentState() || {};
    var me = (st.members ? findMe(st.members) : null);
    var isKp = !!(sess && sess.role === 'kp');

    var ta = el('textarea.textarea', {
      rows: '3',
      placeholder: isKp
        ? '想描写什么？例如：玩家撬锁失败，我要写一下门后传来的动静'
        : '简单说说你想做什么，例如：我想先听听门后有没有动静，再慢慢推开'
    });
    var status = el('div.tiny.dim', { style: { marginTop: '6px', minHeight: '15px' }, text: '' });
    var genBtn = el('button.btn.primary.block', { text: '生成 RP 内容', style: { marginTop: '10px' } });
    var api = null;

    genBtn.addEventListener('click', function () {
      var idea = String(ta.value || '').trim();
      if (!idea) { global.UI.toast('先写一句你想做的事', 'err'); return; }
      if (!global.AIClient || typeof global.AIClient.chat !== 'function') {
        global.UI.toast('AI 模块未加载', 'err'); return;
      }
      if (!global.AIClient.configured()) {
        status.textContent = '';
        global.UI.toast('还没配置 AI：请到「AI 设置」里填写接口地址 / 模型 / Key', 'err', 4200);
        return;
      }
      genBtn.disabled = true;
      genBtn.textContent = '生成中…';
      status.textContent = '正在让 AI 写…（模型较慢时可能要十几秒）';
      global.AIClient.chat(buildRpMessages(isKp, me, st, idea), {
        temperature: 0.85, maxTokens: 1200, timeout: 60000
      }).then(function (text) {
        var out = cleanRpText(text);
        if (!out) throw new Error('模型返回了空内容，请再试一次');
        targetInput.value = out;
        try { targetInput.focus(); targetInput.setSelectionRange(out.length, out.length); } catch (e) { /* 忽略 */ }
        if (api && api.close) api.close();
        global.UI.toast('已填入聊天框，改完再点「发送」', 'ok', 3200);
      }, function (e) {
        status.textContent = '';
        global.UI.toast((e && e.message) || '生成失败，请检查 AI 设置', 'err', 4600);
      }).then(function () {
        genBtn.disabled = false;
        genBtn.textContent = '生成 RP 内容';
      });
    });

    var body = el('div', null, [
      el('div.tiny.dim', { style: { lineHeight: '1.65' },
        text: isKp
          ? '以守秘人的身份：描写场景、NPC 的回应，或把一次检定结果写成叙事。'
          : '以你扮演的调查员的身份：说话、行动、思考（不是以玩家本人视角下指令）。' }),
      el('div.field', { style: { marginTop: '8px' } }, [el('label', { text: '你想做什么 / 说什么' }), ta]),
      genBtn,
      status,
      el('div.tiny.dim', { style: { marginTop: '8px', lineHeight: '1.6' },
        text: '生成结果只会填进聊天输入框，不会自动发送 —— 你可以改完再点「发送」。' })
    ]);
    api = global.UI.sheet({ title: '✨ AI RP', body: body });
    return api;
  }

  /* ---------- 动作 ---------- */

  /** 玩家侧：所有操作都变成 intent，不直接改 state */
  function sendIntent(op, p) {
    if (!sess || !sess.side || !sess.side.intent) return;
    sess.side.intent(op, p);
  }

  /** 权威端：动作走 RoomModel.Host，由它判权限并产出事件计划 */
  function hostAction(action) {
    if (!sess || !sess.host) return;
    var verdict = M.needs(M.ROLE.KP, action.op);
    if (!verdict.allowed) { global.UI.toast('你没有权限执行该操作', 'err'); return; }
    var proceed = function () {
      /* 走 side.request：普通动作直接执行；confirm=twice 的动作会被排进
         pending 待你二次确认（模型侧也有一层拦截，不靠界面自觉）。
         不用在这里 paint()：_dispatch 是所有变更的唯一出口，它会回调 onPeer → 重画。 */
      if (sess.side.request) sess.side.request(action);
      else sess.side.act(action);
      if (action.op === 'room.kick') global.UI.toast('已移出', 'ok');
      if (action.op === 'room.start') global.UI.toast('开团！', 'ok');
    };
    if (verdict.confirm === 'twice') {
      global.UI.confirm(buildConfirmText(action.op),
        { danger: true, okText: '确定' }).then(function (ok) {
        if (!ok) return;
        /* UI 这一层是「防误触」；模型那一层是「防伪造」，两层都要过 */
        sess.side.request(action);
        if (sess.side.confirmAct) sess.side.confirmAct(action.op, true);
      });
    } else {
      proceed();
    }
  }

  /** 高危动作的确认文案：说清「会影响到谁」，别只写「确定吗」 */
  function buildConfirmText(op) {
    if (op === 'session.end' || op === 'room.end') {
      return '结团？本次记录会归档到本机，房间将关闭，所有人断开。';
    }
    if (op === 'room.close') return '关闭房间？房间里的其他人会被断开。';
    return '确定要执行这个操作吗？它会影响到房间里的所有人。';
  }

  function copyInvite() {
    if (!sess) return;
    var link = M.inviteLink(global.location.href.split('?')[0], sess.code, N.base());
    // 复制能力复用分享模块：它已经处理了安卓桥 / clipboard / 兜底三种路径，也自带提示
    if (global.CocShare && global.CocShare.copy) { global.CocShare.copy(link); return; }
    global.UI.toast(link, 'ok');
  }

  /** 房主侧：复制「服务器地址」——同伴网络层不通时，需要直接看到/发送这个地址 */
  function copyServerAddr() {
    var b = N.base();
    if (!b) { global.UI.toast('当前还没有可用的服务器地址', 'err'); return; }
    if (global.CocShare && global.CocShare.copy) { global.CocShare.copy(b); return; }
    global.UI.toast(b, 'ok');
  }

  /**
   * 房主侧：复制「加入信息」紧凑串 `COC7ROOM|<地址>|<房间号>`。
   *
   * 比邀请链接更抗粘贴（不含路由、不会被聊天软件截断成半条 URL），
   * 加入方在「手动填地址加入」里整段粘进来即可（由 M.readInvite 解析）。
   */
  function copyJoinInfo() {
    if (!sess) return;
    var info = 'COC7ROOM|' + (N.base() || '') + '|' + sess.code;
    if (global.CocShare && global.CocShare.copy) { global.CocShare.copy(info); return; }
    global.UI.toast(info, 'ok');
  }

  /** 房主栏里的「服务地址 + 复制」小块（没有地址时返回 null，不占位）。
   *  外层加稳定类 `.gp-hostaddr` —— 供 app.css 窄屏压平用（替代 attribute 选择器
   *  `div[style*="margin-top"]`，后者脆且不可读）。 */
  function hostAddrBlock() {
    var b = N.base();
    if (!b) return null;
    return el('div.gp-hostaddr', { style: { marginTop: '6px' } }, [
      el('div.tiny.dim', { text: '🌐 服务地址：' + b }),
      el('div.btn-group', { style: { marginTop: '4px' } }, [
        el('button.btn.sm.grow', { text: '📋 复制地址', onclick: copyServerAddr }),
        el('button.btn.sm.grow', { text: '📨 复制加入信息', onclick: copyJoinInfo })
      ])
    ]);
  }

  function closeRoomConfirm() {
    if (!sess || !sess.host) return;
    global.UI.confirm(
      '结束房间？所有成员会被断开，房间号作废。\n' +
      '本次记录会归档到本机（「归档」里可以回看）。',
      { danger: true, okText: '结束房间' }
    ).then(function (ok) {
      if (!ok) return;
      /* v2.4.0（用户第 ⑦ 项）：关房同样意味着本局结束 → 关闭前回写本机临时卡 */
      try {
        var RP = global.RoomPanels;
        var tc = (RP && RP.commitRoomTempCards) ? RP.commitRoomTempCards(sess.code) : null;
        if (tc && tc.ok) global.UI.toast(tc.ok + ' 张角色卡状态已回写', 'ok');
      } catch (e) { /* 忽略 */ }
      // 归档必须发生在关房之前：关房会重置状态
      try { S.archive(sess.host.state, { startedAt: sess.startedAt }); } catch (e) { /* 忽略 */ }
      var code = sess.code;
      sess.side.closeRoom().then(function () { /* 服务端可能已经超时清理，忽略 */ });
      S.clearMine();
      S.clearJoined(code);
      sess.side.destroy();
      stopLanIfHost();
      detachGridListeners();
      sess = null; pageRefs = null;
      global.UI.toast('房间已结束，记录已归档', 'ok');
      restoreOrientation();          // 离开游戏页 → 恢复竖屏（需求 §3）
      global.App.go('#/room');
    });
  }

  function leaveConfirm() {
    if (!sess) return;
    var isKp = sess.role === T().ROLE.KP;
    global.UI.confirm(
      isKp ? '离开房间？你是房主，离开后房间会进入「等待房主重连」，玩家看不到新消息。'
           : '离开房间？你可以用「最近加入的房间」重新回来，座位和准备状态都还在。',
      { okText: '离开' }
    ).then(function (ok) {
      if (!ok) return;
      stopLanIfHost();
      if (sess.side) sess.side.destroy();
      detachGridListeners();
      sess = null; pageRefs = null;
      restoreOrientation();          // 离开游戏页 → 恢复竖屏（需求 §3）
      global.App.go('#/room');
    });
  }

  /**
   * 如果本机会话正是「局域网房主」，就把内嵌服务器停掉。
   *
   * 为什么必须显式停：这个服务监听在一个固定端口上，不停就会一直占着；
   * 下次开房时端口被自己占用，界面表现为「启动失败」。
   * 只对房主停 —— 玩家端本来就没起服务，误调一次也无害，但语义上不该由他停。
   */
  /**
   * 离开 / 结束房间时，把内嵌的局域网服务器一并停掉。
   *
   * 为什么必须显式停：这个服务监听在一个固定端口上，不停就会一直占着；
   * 下次开房时端口被自己占用，界面表现为「启动失败」。
   *
   * ⚠️ 为什么**不**再判「是不是房主」：以前的条件是
   * `if (!sess || sess.role !== KP) return;`，于是
   * 「点了用本机开房 → 创建弹层里点了取消」这条路上 sess 始终是 null，
   * 服务永远不会被停 —— 而它注入的地址会一直盖住设置里的服务器地址，
   * 用户看到的就是「填了公网地址也没用、连不上」。
   * 停一个没在跑的服务是幂等的，误停的代价远小于漏停。
   */
  function stopLanIfHost() {
    var L = global.RoomLan;
    if (!L || !L.isApp()) return;
    if (L.running() || L.injected()) L.stop();
  }

  /* ============================================================
   * 路由与返回键
   * ============================================================ */

  function rerender() { global.App.go('#/room'); }
  /** 重建**当前房间**的页面（rerender() 走的是 #/room 入口页！）。
      开团 → 游戏页的整页切换必须用这条，否则会把人踢回入口页。 */
  function rerenderRoom() {
    if (sess && sess.code) global.App.go('#/room/' + sess.code);
    else rerender();
  }

  function handleBack() {
    if (pageRefs) {
      // 在房间页：返回 = 回入口页（连接保留，所以「离开」是显式动作）
      global.App.go('#/room');
      return true;
    }
    return false;
  }

  global.RoomUI = {
    boot: boot,
    /** 由 app.js 调用：返回要挂进主视图的节点 */
    render: function (code) {
      if (!M) boot();
      return code ? renderRoom(code.toLowerCase()) : renderEntry();
    },
    routeName: function (code) { return code ? 'room' : 'room-entry'; },
    handleBack: handleBack,
    hasSession: function () { return !!sess; },
    /* v2.13.5（用户报 Bug）：结团/关房后**就地结束本地会话**。
       之前 KP 结团只 go('#/room')、玩家结团只 go('#/home')，都没有清 sess，
       于是大厅里的 authoritativeRoom() 把这一局当成「正在进行的房间」，
       最上方又冒出「回到游戏」（点下去当然进不去）。 */
    endLocalSession: function (keepRecords) {
      try { if (sess && sess.side && sess.side.destroy) sess.side.destroy(); } catch (e) { /* 已断 */ }
      try { detachGridListeners(); } catch (e) { /* 忽略 */ }
      sess = null; pageRefs = null;
      if (!keepRecords) {
        try {
          var RS = global.RoomStore || {};
          var c = (authoritativeRoom() || {}).code || '';
          if (c) {
            if (RS.listArchive && !(RS.listArchive() || []).some(function (a) { return a && a.code === c; }) && RS.archive) { /* 交给调用方归档 */ }
            if (RS.clearRoomSave) RS.clearRoomSave(c);
            if (RS.getMine && RS.getMine() && RS.getMine().code === c && RS.clearMine) RS.clearMine();
          }
        } catch (e) { /* 忽略 */ }
      }
    },
    /* v2.0.2 T5（断点4）：resumeSheet 一直在调它，之前从未导出（死引用）。 */
    resumeRoom: function (code, saveId) { resumeRoomImpl(code, saveId); },
    /* v2.2.1（用户第 8 项）：导出本机权威房间号解析（供测试与路由纠正复用）。 */
    authoritativeCode: function () { var a = authoritativeRoom(); return a ? a.code : null; },
    /* v2.2.2（用户第 1 项）：导出完整的 { code, role, live } 解析（供测试断言角色/活会话）。 */
    authoritative: function () { return authoritativeRoom(); },
    /* 测试用：把当前会话暴露出去（Playwright 里断言房间状态用） */
    _session: function () { return sess; },
    /* v2.0.1 测试用：驱动真实的连接状态流转（走 onLinkState →
       paintLinkChip + banner + 重连 toast），供掉线提示断言使用。
       不伪造 DOM，只喂状态，保证断言测的是真实渲染路径。 */
    _setLinkState: function (who, st, info) { onLinkState(who || (sess && sess.role) || 'player', st, info); }
  };
})(typeof window !== 'undefined' ? window : this);
