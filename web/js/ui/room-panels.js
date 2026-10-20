/* ============================================================
 * room-panels.js — 跑团房间的**面板层**（v2.0.0 · 契约 §8 的 F2 实现）
 * 对外命名：window.RoomPanels
 *
 * 分工（需求 §0「规则不得散落在按钮事件里」，本文件开头 :6-7 是既有契约）：
 *   本文件只做两件事：把 state 画出来 / 把用户操作变成 intent。
 *   一切「能不能做」「算出来是多少」都问 RoomModel / CocRules，
 *   界面里**禁止**自己复算一遍（否则必然和权威端算出不一样的结果）。
 *
 * v2.0.0 的边界（契约 §8.4）：
 *   · F1（room-ui.js）负责**页面骨架 / 区域容器 / 横屏 / 双指缩放**；
 *   · F2（本文件）负责**每个区域的内容与交互**。
 *   · 本文件**不得**建页面级容器、不得改路由。
 *   · 面板需要刷新时走 ctx.paint() / ctx.refreshSheet()，**不要自己 setInterval**。
 *
 * 面板契约（F1 调用）：
 *   RoomPanels.<name>(ctx) → 一个 DOM 节点
 *   ctx = { st, role, host, client, side, act, intent, mode, paint, refreshSheet }
 *     st      当前权威状态（KP 用 host.state，玩家用 client.state）
 *     role    'kp' | 'player' | 'spectator'
 *     host    KP 的 RoomModel.Host（玩家为 null）
 *     client  玩家的 RoomModel.Client（KP 为 null）
 *     side    传输侧（HostSide / PlayerSide），提供 act/request/confirmAct/intent
 *     act(action)        KP：执行一个动作（已过权限+二次确认）
 *     intent(op, p)      玩家：发一条意图
 *     paint()            重画整个房间页
 *     refreshSheet()     刷新最上层「可刷新」弹层
 *
 * ⚠️ 布局约定（给 F1）：每个可滚动区域我都套了 `.panel-scroll` 并在**内部**滚动，
 *   页面本身不整体滚动（上一轮踩过「固定高度之和 > 视口导致底部点不到」）。
 *   我新加的 CSS 钩子类名见回执，需要 F1 在 app.css 里定高度。
 * ============================================================ */
(function (global) {
  'use strict';

  var M = null, R = null;
  function boot() {
    M = global.RoomModel;
    R = global.CocRules;      // 规则服务对外叫 CocRules（room-rules.js）
  }
  function T() { return M; }

  function el(sel, props, kids) { return global.UI.h(sel, props, kids); }
  function esc(s) { return global.UI.esc(s == null ? '' : String(s)); }

  var DRAW_COLORS = ['#e0605a', '#d4a94a', '#46b9a8', '#8a7de0', '#e8eef7'];
  var ATTR_LABELS = { str: '力量', con: '体质', siz: '体型', dex: '敏捷', app: '外貌',
                      int: '智力', pow: '意志', edu: '教育', luck: '幸运' };

  /** 面板内部的轻量重绘：不重画整页，避免滚动位置和输入框内容丢失 */
  function rerender(ctx) { if (ctx && ctx.paint) ctx.paint(); }

  /* ============================================================
   * 模块级 UI 状态（只存活于本设备本次会话；不参与同步）
   * 说明：这些是**纯界面状态**（当前 tab / 画笔颜色 / 缩放 / 待部署怪物缓存 …），
   *       不属于房间权威状态，因此不进 RoomModel。刷新走 ctx.paint()。
   * ============================================================ */
  var UI_STATE = {
    leftTab: 'map',          // kpLeftColumn：地图 / NPC·怪物 / 素材
    combatTab: 'list',       // kpCombatPanel：战斗列表 / 怪物信息
    logTab: 'all',           // kpGameLog：全部 / 主持人 / 玩家
    feedTab: 'log',          // plFeeds：游戏记录 / 聊天
    charTab: 'status',       // 遗留字段（v2.13.9 起 plCharacterCard 不再用页签，默认直接渲染人物状态）
    boardPage: 0,            // plTeammates：我的手绘板翻页
    boardMode: 'draw',       // v2.1.0：玩家手绘板工具 —— 'draw' 画笔 / 'erase' 橡皮
    darkRoll: false,         // v2.1.0 #11：骰子行「暗骰」开关态（开 → 任何投掷都走 dice.dark）
    tool: { mode: 'mark', icon: '📍', color: DRAW_COLORS[0],
            playerName: '', actorName: '' },   // v2.1.4 放置玩家 / v2.5.0 放置单位：待落点的名字
    zoom: 1,
    /* v2.13.2（用户需求）：公开素材放大后的平移量（CSS px）+ 它属于哪张底图。
       换图 / 回到 100% 即归零；只存活于本机界面状态，不进房间模型、不同步。 */
    pan: { x: 0, y: 0 },
    panFor: '',
    /* v2.13.4（用户第 1 项）：队友栏是否展开（纯界面状态，不进房间模型）。
       矮屏（手机横屏 <470px 高）默认收起 —— 那一档右列高度不够同时放
       「场景检定 + 队友 + 私密信息」，先保证场景检定完整。 */
    matesOpen: (typeof global.innerHeight === 'number' ? global.innerHeight : 800) > 470,
    d100Draft: { bonus: 0, penalty: 0 },   // 正在编辑的修正（plBottomBar）
    d100Mod: { bonus: 0, penalty: 0 },     // 已「应用」的修正
    pendingActors: [],                     // KP 本地「待部署怪物/NPC」兜底缓存
    sceneCheckDraft: null,                 // 场景检定编辑器草稿
    lastTurnKey: '',                       // 轮次强提醒去重
    lastBeepAt: 0
  };

  /* ============================================================
   * 通用小工具
   * ============================================================ */

  /** UI.select 返回包装 div；包一层让调用方可以像原生控件一样读 .value */
  function selectCtl(options, value, onchange) {
    var wrap = global.UI.select(options, value, onchange);
    var inner = wrap.querySelector('select');
    Object.defineProperty(wrap, 'value', {
      get: function () { return inner.value; },
      set: function (v) { inner.value = v; }
    });
    return wrap;
  }

  /** 既有的「工具卡」交互模式：<div class="tool">（⚠️ 不是 <button>，测试要按文本子串点 div） */
  function toolBtn(t, d, fn) {
    return el('div.tool', { onclick: fn }, [
      el('div.t', { text: t }),
      d ? el('div.d', { text: d }) : null
    ]);
  }

  /** tab 条（含 .on 高亮），onPick 收到 key */
  function panelTabs(tabs, active, onPick) {
    var bar = el('div.panel-tabs');
    tabs.forEach(function (t) {
      bar.appendChild(el('div.panel-tab' + (t.key === active ? '.on' : ''), {
        text: t.label,
        onclick: function () { onPick(t.key); }
      }));
    });
    return bar;
  }

  /** 内部滚动容器（各自滚动，页面不整体滚动 —— 契约 §8.4） */
  function scrollBox(cls, kids) {
    return el('div.panel-scroll' + (cls ? '.' + cls : ''), {
      style: { overflowY: 'auto', overflowX: 'hidden', minHeight: 0 }
    }, kids);
  }

  function svgEl(tag, attrs) {
    var n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
    return n;
  }

  /**
   * 笔画集合 → SVG 覆盖层（viewBox 0 0 100 100，归一化坐标 ×100）。
   *
   * v2.5.0（用户第 8 项）：此前 mapStage / miniBoard / 玩家独立手绘板卡各自手抄一遍
   * path 生成逻辑（3 份重复），KP 全屏查看手绘板还要再抄第 4 份 —— 抽出来共用。
   * 带 `class="strokes-svg"`：擦除手势靠它定位「当前那张笔迹层」并暂时隐藏，
   * 换成实时 working 层（见 bindEraseStage）。
   *
   * @param {Array} strokes 笔画（{pts:[{x,y}], color, width}）
   * @param {string} [styleStr] 追加到 svg 的 inline style（绝对定位铺满 / 只读预览等）
   * @return {SVGElement}
   */
  function strokesSvg(strokes, styleStr) {
    var svg = svgEl('svg', { viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'class': 'strokes-svg' });
    if (styleStr) svg.setAttribute('style', styleStr);
    (strokes || []).forEach(function (s) {
      var d = (s.pts || []).map(function (p, i) {
        return (i ? 'L' : 'M') + (p.x * 100).toFixed(2) + ' ' + (p.y * 100).toFixed(2);
      }).join(' ');
      if (!d) return;
      svg.appendChild(svgEl('path', {
        d: d, fill: 'none', stroke: s.color || '#e0605a',
        'stroke-width': s.width || s.w || 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
      }));
    });
    return svg;
  }

  function findMember(st, seat) {
    var ms = (st && st.members) || [];
    for (var i = 0; i < ms.length; i++) if (ms[i].seat === seat) return ms[i];
    return null;
  }

  function mySeatOf(ctx) {
    if (ctx.role === 'kp') return M.HOST_SEAT;
    return ctx.client ? (ctx.client.seat || '') : '';
  }

  /** 我在成员表里的那条（KP / 旁观者为 null） */
  function findMe(ctx) {
    if (ctx.role !== 'player') return null;
    return findMember(ctx.st, mySeatOf(ctx));
  }

  function playersOf(ctx) {
    return (ctx.st.members || []).filter(function (m) { return m.role === M.ROLE.PLAYER; });
  }

  function isCombat(ctx) {
    return (((ctx.st.meta || {}).mode) || 'EXPLORATION') === 'COMBAT';
  }

  /** 从成员读 HP/MP/SAN（兼容 sheet.status 与 runtime 两套来源） */
  function memberStats(m) {
    var rt = (m && m.runtime) || {}, sh = (m && m.sheet) || {}, stt = sh.status || {};
    function pick(a, b, c) { return a != null ? a : (b != null ? b : (c != null ? c : null)); }
    return {
      hp: pick(rt.hp, stt.currentHP, sh.hp),
      hpMax: pick(rt.hpMax, stt.maxHP, null),
      mp: pick(rt.mp, stt.currentMP, sh.mp),
      mpMax: pick(rt.mpMax, stt.maxMP, null),
      san: pick(rt.san, stt.currentSAN, sh.san),
      sanMax: pick(rt.sanMax, stt.maxSAN, sh.maxSAN)
    };
  }

  /**
   * v2.0.2 修复A：成员的战斗用敏捷 —— **唯一权威来源 = sheet.attrs**。
   * 经 CocRules.attrValue 兼容中文/缩写（内部走 ATTR_CN2KEY['敏捷']='dex'）；
   * 规则服务缺失时退回 sheet.attrs.dex。取不到返回 null（显示为 —）。
   * ⚠️ 不再读 m.runtime.dex —— runtime 只写过 hp/san/mp，从来没有 dex。
   */
  function memberDex(m) {
    var R = global.CocRules;
    var v = (R && typeof R.attrValue === 'function') ? R.attrValue(m && m.sheet, '敏捷') : null;
    if (v == null) v = (m && m.sheet && m.sheet.attrs) ? m.sheet.attrs.dex : null;
    return (v == null || v === '') ? null : Number(v);
  }

  /** 一条 HP/MP/SAN 状态条。
   *  v2.0.1 缺陷B：加 `.row` 修饰类 —— 这条是「标签 + 条 + 数值」的整行结构，
   *  必须走整行样式，不能被旧的裸 `.stat-bar{height:6px;overflow:hidden}` 裁成一条。
   *  用显式类而非 CSS `:has()`，兼容较旧的安卓 WebView。 */
  function statBar(label, cur, max, cls) {
    var c = (cur == null || cur === '') ? null : Number(cur);
    var m = (max == null || max === '') ? null : Number(max);
    var ratio = (c != null && m) ? Math.max(0, Math.min(1, c / m)) : 0;
    return el('div.stat-bar.row' + (cls ? '.' + cls : ''), null, [
      el('span.k', { text: label }),
      el('div.bar', null, [el('i', { style: { width: (ratio * 100) + '%' } })]),
      el('span.num', { text: (c == null ? '—' : c) + (m != null ? ' / ' + m : '') })
    ]);
  }

  function avatarEl(m, size) {
    var sh = (m && m.sheet) || {};
    var url = sh.avatar || sh.avatarUrl;
    /* 修复：原写法 el('div' + cls) 在 cls='avatar.mini' 时拼成 'divavatar.mini'，
       UI.h 会把 'divavatar' 当成标签名（见 components.js#h 的 (?=[.#]) 切分），
       渲染成 <divavatar class="mini"> —— 既丢了 .avatar 圆形样式，img 也不显示。
       正确应为 'div.avatar.mini'（tag=div，class=avatar mini）。 */
    var cls = 'avatar' + (size ? '.' + size : '');
    if (url) return el('div.' + cls, null, [el('img', { src: url, alt: '' })]);
    var initial = ((m && (m.charName || m.nickname)) || '?').slice(0, 1);
    return el('div.' + cls, { text: initial });
  }

  /** 时间戳 → HH:MM */
  function timeText(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  /** 轮次强提醒的提示音：WebAudio 生成短促 beep（**不引入音频文件**） */
  function beep() {
    var now = Date.now();
    if (now - UI_STATE.lastBeepAt < 1200) return;   // 防叠响
    UI_STATE.lastBeepAt = now;
    try {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return;
      if (!beep._ctx) beep._ctx = new AC();
      var actx = beep._ctx;
      if (actx.state === 'suspended' && actx.resume) actx.resume();
      var o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine'; o.frequency.value = 880;
      o.connect(g); g.connect(actx.destination);
      var t = actx.currentTime;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.14, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
      o.start(t); o.stop(t + 0.36);
    } catch (e) { /* 无音频环境忽略 */ }
  }

  /* ============================================================
   * 通用：模式切换条（v2.0.0 起「战斗」按钮走选怪流程）
   * ⚠️ 历史 bug：本组件过去只在招募页 render() 里被调用，游戏页不渲染它，
   *    所以 KP「看不到切换战斗模式按钮」。现在它仍可被 F1 放在 KP 顶栏，
   *    且「战斗」按钮改为打开 combatPrepareSheet（选怪→部署完毕）。
   * ============================================================ */
  function modeSwitch(ctx) {
    if (ctx.role !== 'kp') return null;      // 只有 KP 能切换模式
    var cur = (ctx.st.meta || {}).mode || 'EXPLORATION';
    function btn(label, mode, cls) {
      return el('button' + (cur === mode ? '.on' : '') + (cls ? '.' + cls : ''), {
        text: label,
        onclick: function () {
          if (cur === mode) return;
          if (mode === 'COMBAT') { combatPrepareSheet(ctx); return; }   // 必须先选怪
          if (cur === 'COMBAT') {
            global.UI.confirm('回到探索模式？会结束当前战斗。', { okText: '结束战斗' })
              .then(function (ok) { if (ok) ctx.act({ op: 'combat.end' }); });
            return;
          }
          ctx.act({ op: 'scene.mode', mode: mode });
        }
      });
    }
    return el('div.mode-switch', null, [
      btn('🧭 探索', 'EXPLORATION'),
      btn('⚔️ 战斗', 'COMBAT', 'combat')
    ]);
  }

  /* ============================================================
   * 战斗：公共读取
   * ============================================================ */

  function combatOf(ctx) { return ctx.st.combat || null; }

  function curSlot(ctx) {
    var c = combatOf(ctx);
    if (!c || !c.order || !c.order.length) return null;
    return c.order[c.turn || 0] || null;
  }

  /**
   * v2.5.0（QA 回发·判活口径对齐）：单位是否已阵亡 / 倒地。
   *
   * ⚠️ **必须与 `room-model.js#slotDown` 保持同一口径** —— 那里是权威判据
   * （战斗轮次是否跳过该单位由它决定），UI 一旦漂移就会出现「同一个单位两种死活」。
   *
   * 关键守卫 `hpMax > 0`：
   *   `Host.combatStart` 对**没填 HP** 的单位会写成 `public.hp = 0, public.hpMax = 0`
   *   （`hp: num(a.hp, 0)`；`addActorSheet` 里 `+hpI.value || 0`，KP 把默认 HP 清空
   *   留白就是 0）。那不是「死了」，而是**没登记血量**。所以只有「确有血量上限」
   *   时才把 `hp <= 0` 判为阵亡。
   *   真正被打死的单位一定带 `public.down` 或 `public.state === 'dead'`
   *   （combatDamage / _opposedDamageMonster / _opposedDamagePlayer 都会打其一）。
   *
   * @param {object} pub 单位的 public 段（即 slot.public）
   * @return {boolean} true = 已阵亡 / 倒地，应从「可选单位」里排除
   */
  function unitDown(pub) {
    var p = pub || {};
    if (p.down || p.state === 'dead') return true;
    /* 与模型一致：hp 判死必须同时满足 hpMax > 0（否则是「没登记血量」，不是死）。 */
    if (p.hp !== undefined && p.hp !== null && Number(p.hpMax || 0) > 0 && Number(p.hp) <= 0) return true;
    return false;
  }

  /**
   * 战斗槽是否倒地 —— 直接委托 `unitDown`，避免在 UI 里长出第二份判活逻辑
   * （两份判据各自漂移正是这次出 bug 的原因）。
   */
  function isDown(slot) {
    return unitDown((slot && slot.public) || {});
  }

  function isMyTurn(ctx, cur) {
    if (!cur || !ctx.client) return false;
    if (cur.kind !== 'pc') return false;
    return cur.seat && ctx.client.seat && cur.seat === ctx.client.seat;
  }

  /** HP 条：只有公开 HP 才画数字；怪物只画「状态」 */
  function hpBar(slot) {
    var pub = (slot && slot.public) || {};
    if (pub.hp === undefined || pub.hpMax === undefined) {
      return el('div.hp-hidden', { text: pub.state || (isDown(slot) ? '已倒下' : '状态未知') });
    }
    var max = pub.hpMax || 1, ratio = Math.max(0, Math.min(1, pub.hp / max));
    var lvl = ratio <= 0.25 ? '.low' : (ratio <= 0.5 ? '.mid' : '');
    return el('div', null, [
      el('div.hp-bar' + lvl, null, [el('i', { style: { width: (ratio * 100) + '%' } })]),
      el('div.hp-num', { text: pub.hp + ' / ' + pub.hpMax })
    ]);
  }

  function chipFor(pub) {
    if (pub && pub.state) return el('span.chip.sm', { text: pub.state });
    return el('span');
  }

  /** 行动顺序条（KP 与 PL 共用；战斗时叠加在地图上方） */
  function initiativeBar(ctx) {
    notifyTurn(ctx);
    var c = combatOf(ctx);
    var wrap = el('div.init-wrap');
    if (!c || !c.order || !c.order.length) return wrap;
    var curIdx = c.turn || 0;
    var cur = c.order[curIdx] || {};
    wrap.appendChild(el('div.combat-turn-note', {
      html: '第 <b>' + (c.round || 1) + '</b> 轮 · 当前行动：<b>' + esc(cur.name || '—') + '</b>' +
        (cur.totalSlots > 1 ? '（第 ' + cur.slot + '/' + cur.totalSlots + ' 次行动）' : '')
    }));
    if (isMyTurn(ctx, cur)) {
      wrap.appendChild(el('div.turn-hint', null, [el('span', { text: '🎯 轮到你行动了' })]));
    }
    var bar = el('div.init-bar');
    c.order.forEach(function (slot, i) {
      var cls = '.init-slot' + (i === curIdx ? '.cur' : '') +
                (slot.done && i !== curIdx ? '.done' : '') +
                (isDown(slot) ? '.down' : '');
      bar.appendChild(el('div' + cls, null, [
        slot.totalSlots > 1 ? el('span.slot-no', { text: slot.slot + '/' + slot.totalSlots }) : null,
        el('div.nm', { text: slot.name || '—' }),
        el('div.sub', { text: slot.kind === 'pc' ? 'PC' : (slot.kind === 'monster' ? '怪物' : 'NPC') }),
        hpBar(slot)
      ]));
    });
    wrap.appendChild(bar);
    return wrap;
  }

  /**
   * 「轮到谁行动」的强提醒。
   * 主来源：模型层 `EVT.TURN_ALERT` → `state.alert`（{kind,round,turn,name,seat,at}），
   *   E 线在 `nextTurn` 时发；本函数按 `at|round|turn` 去重，每条只提醒一次。
   *   · 轮到**本人**（seat 匹配）→ beep + toast + 高亮（initiativeBar 的 .cur）。
   *   · KP 侧轮到 NPC/怪物 → toast 可见提示。
   * 兜底：旧模型 / 无 alert 时，退化为监听「当前行动者变化（round|turn|actorId）」。
   */
  function notifyTurn(ctx) {
    /* 优先用模型层的 TURN_ALERT（EVT.TURN_ALERT → state.alert）。
       载荷：{kind,round,turn,name,seat,at}（见 room-model.js 的 reduce）。 */
    var alert = ctx.st.alert;
    if (alert && (alert.at || alert.turn !== undefined || alert.name)) {
      var akey = 'a|' + (alert.at || 0) + '|' + (alert.round || 1) + '|' + (alert.turn || 0);
      if (akey === UI_STATE.lastTurnKey) return;     // 同一条提醒不重复
      var afirst = (UI_STATE.lastTurnKey === '');
      UI_STATE.lastTurnKey = akey;
      if (afirst) return;                            // 首次渲染（刚进战斗）不响
      var mineA = (ctx.role !== 'kp' && alert.seat && alert.seat === mySeatOf(ctx));
      if (mineA) {
        beep();
        global.UI.toast('🎯 轮到你了：' + (alert.name || '你'), 'ok', 2800);
      } else if (ctx.role === 'kp') {
        global.UI.toast('▶ 轮到 ' + (alert.name || '—') + ' 行动', 'ok', 2200);
      }
      return;
    }
    /* 兜底：旧模型 / 无 TURN_ALERT 时，用「当前行动者变化」推断 */
    var c = combatOf(ctx);
    if (!c || !c.order || !c.order.length) { UI_STATE.lastTurnKey = ''; return; }
    var idx = c.turn || 0;
    var s = c.order[idx] || {};
    var key = (c.round || 1) + '|' + idx + '|' + (s.actorId || '');
    if (key === UI_STATE.lastTurnKey) return;       // 同一行动者不重复提醒
    var first = (UI_STATE.lastTurnKey === '');
    UI_STATE.lastTurnKey = key;
    if (first) return;                              // 首次渲染（刚进战斗）不提醒
    var mine = (s.kind === 'pc' && s.seat && s.seat === mySeatOf(ctx));
    if (mine) {
      beep();
      global.UI.toast('🎯 轮到你了：' + (s.name || '你'), 'ok', 2800);
    } else if (ctx.role === 'kp') {
      global.UI.toast('▶ 轮到 ' + (s.name || '—') + ' 行动', 'ok', 2200);
    }
  }

  /* ============================================================
   * 地图舞台（KP 可标可画 / 玩家只读；含缩放）
   * ============================================================ */

  function mapBackground(ctx) {
    /* v2.6.0（用户第 1 项）：中央底图只认「已公开」素材。
       ① 优先 KP 显式指定的 scene.image（其值只能来自 asset.cover 校验过的已公开 id）；
       ② 命中不到再回落「第一张已公开图片」。
       v2.6.0（用户第 2 项）：**删除**旧的 KP 私库(localAssets)兜底 —— 那段不看 revealed、
       恒取私库第一张，导致「KP 点公开/隐藏对底图毫无反应」且 KP 与玩家看到的底图不一致。
       现在 KP 与玩家统一只认 scene.assets + scene.image。 */
    var scene = ctx.st.scene || {};
    var assets = scene.assets || [];        /* 模型侧保证：此数组只含已公开素材 */
    var wantId = scene.image;
    var bg = null;
    for (var i = 0; i < assets.length; i++) {
      if (wantId && assets[i].id === wantId && /^data:image\//.test(assets[i].data || '')) { bg = assets[i]; break; }
    }
    if (!bg) {
      for (var j = 0; j < assets.length; j++) {
        if (/^data:image\//.test(assets[j].data || '')) { bg = assets[j]; break; }
      }
    }
    return bg;
  }

  /**
   * 构建地图舞台。
   * @param {object} ctx
   * @param {boolean} editable KP=true 绑定标记/画笔/橡皮；false 只读
   */
  function mapStage(ctx, editable) {
    var scene = ctx.st.scene || {};
    var bg = mapBackground(ctx);
    var stage = el('div.map-stage');
    if (bg) stage.appendChild(el('img', { src: bg.data, alt: bg.name || 'map' }));
    else stage.appendChild(el('div.map-empty', { text: '还没有底图。KP 可在左侧「地图」tab 上传一张。' }));

    /* 标记（相对坐标 0..1） */
    (scene.marks || []).forEach(function (mk) {
      stage.appendChild(el('div.mk', { style: { left: (mk.x * 100) + '%', top: (mk.y * 100) + '%' } }, [
        el('span.dot' + (mk.color === 'teal' ? '.teal' : '')),
        mk.label ? el('span.tag', { text: mk.label }) : null
      ]));
    });

    /* 自由笔迹（SVG，viewBox 0..100）—— 必须用 svgEl（createElementNS）
       v2.5.0（用户第 8 项）：path 生成统一走 strokesSvg（与手绘板/全屏查看共用）。 */
    if ((scene.strokes || []).length) {
      stage.appendChild(strokesSvg(scene.strokes));
    }

    /* 缩放 + 平移（纯前端 transform；v2.13.2 起放大后可以拖动看边缘） */
    var bgKey = bg ? (bg.id || bg.name || '') : '';
    if (UI_STATE.panFor !== bgKey) {          /* 换了一张底图 → 平移量归零 */
      UI_STATE.panFor = bgKey;
      UI_STATE.pan = { x: 0, y: 0 };
    }
    applyMapTransform(stage);

    /* KP 交互绑定（v2.1.1：移除「锁定拖动」后，只读时完全不绑即可 —— 本模型标记本就不支持拖动） */
    if (editable) {
      stage.classList.add('touch-stage');
      stage.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      var mode = UI_STATE.tool.mode;
      if (mode === 'draw') {
        stage.classList.add('sketch');
        /* v2.4.0（用户第 ② 项）：实时绘制 —— 落笔即见笔迹 */
        bindDraw(stage, function (pts) {
          ctx.act({ op: 'map.stroke', color: UI_STATE.tool.color, width: 1.4, pts: pts });
        }, { color: UI_STATE.tool.color, width: 1.4 });
      } else if (mode === 'erase') {
        stage.style.cursor = 'cell';
        /* v2.5.0（用户第 6 项）：点击 → 划过实时擦除（旧实现走 bindTap，拖动被丢弃，
           只能「点一下擦一点」）。手势末尾一次性整集替换，保留 marks。 */
        bindEraseStage(stage, (scene.strokes || []).slice(), function (keep, base) {
          eraseAt(ctx, keep, base);
        });
      } else {
        stage.style.cursor = 'crosshair';
        bindTap(stage, function (x, y) {
          /* v2.1.4（用户第 6 项 ·「放置玩家」）：若处于「放置玩家」态，落点标签用玩家名，
             落完即清掉这个态，回到普通标记。
             v2.5.0（用户第 9 项 ·「放置单位」）：与 playerName **对称**地支持
             actorName（放置单位态），落完同样清空并提示。二者互斥，玩家优先。 */
          var plName = UI_STATE.tool.playerName;
          var acName = UI_STATE.tool.actorName;
          var label = plName ? ('👤 ' + plName)
                    : (acName ? ('👹 ' + acName) : UI_STATE.tool.icon);
          ctx.act({ op: 'map.mark', x: x, y: y, kind: 'dot', label: label, revealed: true });
          if (plName) {
            UI_STATE.tool.playerName = '';
            global.UI.toast('已放置玩家：' + plName, 'ok');
          } else if (acName) {
            UI_STATE.tool.actorName = '';
            global.UI.toast('已放置单位：' + acName, 'ok');
          }
        });
      }
    }

    /* v2.13.2（用户需求）：放大后拖动查看边缘细节。
       · 只读舞台（玩家 / 旁观者）恒可拖；
       · KP 在「标记」模式下可拖 ——「画笔 / 橡皮」下拖动属于作画/擦除，不抢手势；
       · 平移范围被夹进素材框（见 clampMapPan），不会露白、也不会顶到下面的缩放条。 */
    var panMode = !editable ||
      (UI_STATE.tool.mode !== 'draw' && UI_STATE.tool.mode !== 'erase');
    if (panMode && (UI_STATE.zoom || 1) > 1.0001) bindMapPan(stage);

    /* 首次绘制后按「真实框尺寸」把平移量夹一次（rAF 里做，等布局稳定） */
    if ((UI_STATE.zoom || 1) > 1.0001 && global.requestAnimationFrame) {
      global.requestAnimationFrame(function () {
        if (!stage.parentNode) return;
        clampMapPan(stage, mapPanMetrics(stage));
        applyMapTransform(stage);
      });
    }
    return stage;
  }

  /* ============================================================
   * v2.13.2（用户需求）：公开素材「放大后可拖动」
   * ------------------------------------------------------------
   * 约束（用户原话）：图片只能显示在公开素材框内，不能越界挡到别的栏目。
   *   · 裁剪：.map-stage-wrap{overflow:hidden} 既有规则负责（v2.1.4 为挡缩放溢出加的），
   *     本段不动它 —— 平移只改 transform，溢出部分天然被裁在框内。
   *   · 夹取：clampMapPan 把平移量限制成「放大后的舞台始终盖住整个框」——
   *     于是既能一路拖到四条边的边缘细节，又不会拖出白边。
   *   · 单位：translate 写在 scale 之前，所以位移是**屏幕像素**；而框/舞台的
   *     getBoundingClientRect 还含页面缩放（.gp-zoom）的倍率 k，
   *     故内部统一换算：panCss = panScreen / k。手指移 1px 画面跟 1px。
   * ============================================================ */

  /** 当前平移量（懒初始化，兼容旧状态对象）。 */
  function mapPan() {
    if (!UI_STATE.pan) UI_STATE.pan = { x: 0, y: 0 };
    return UI_STATE.pan;
  }

  /** 把 translate+scale 写到舞台上。
   *  ⚠️ 顺序必须是 translate(...) scale(...)：先写的在外层坐标系生效 →
   *     translate 的 px 不受自身缩放影响，拖动才「跟手」。 */
  function applyMapTransform(stage) {
    if (!stage || !stage.style) return;
    var z = UI_STATE.zoom || 1;
    var pan = mapPan();
    stage.style.transformOrigin = 'center center';
    if (Math.abs(z - 1) < 1e-4 && !pan.x && !pan.y) {
      stage.style.transform = '';
    } else {
      stage.style.transform = 'translate(' + (Math.round(pan.x * 100) / 100) + 'px,' +
        (Math.round(pan.y * 100) / 100) + 'px) scale(' + z + ')';
    }
    if (stage.classList) stage.classList.toggle('map-pannable', z > 1.0001);
  }

  /** 量一次「无 transform 时」舞台与素材框的位置/尺寸（屏幕坐标）。
   *  只在按下瞬间与 rAF 收尾时调用 —— 拖动过程中复用缓存，避免每帧强制排版。 */
  function mapPanMetrics(stage) {
    var wrap = stage && stage.parentNode;
    if (!wrap || !stage.getBoundingClientRect) return null;
    var keep = stage.style.transform;
    stage.style.transform = 'none';           /* 量的是「未缩放」的真实布局框 */
    var sr = stage.getBoundingClientRect();
    var wr = wrap.getBoundingClientRect();
    stage.style.transform = keep;
    if (!sr.width || !sr.height || !wr.width || !wr.height) return null;
    /* k = 祖先（页面缩放 .gp-zoom）造成的屏幕倍率；用于 css px ↔ 屏幕 px 换算 */
    var k = stage.offsetWidth ? (sr.width / stage.offsetWidth) : 1;
    return {
      cx: sr.left + sr.width / 2, cy: sr.top + sr.height / 2,
      w: sr.width, h: sr.height, k: k || 1,
      l: wr.left, t: wr.top, r: wr.right, b: wr.bottom
    };
  }

  /** 把平移量夹进「不露白」的范围：放大后的舞台必须始终盖住素材框。
   *  某轴上舞台比框还小（如超宽屏留黑边）→ 该轴锁 0，保持居中不动。 */
  function clampMapPan(stage, m) {
    var z = UI_STATE.zoom || 1;
    var pan = mapPan();
    if (z <= 1.0001) { pan.x = 0; pan.y = 0; return pan; }
    m = m || mapPanMetrics(stage);
    if (!m) return pan;
    var hw = m.w * z / 2, hh = m.h * z / 2;
    /* 舞台左/右边缘能贴到框边时的平移量（屏幕 px） */
    var loX = m.r - m.cx - hw, hiX = m.l - m.cx + hw;
    var loY = m.b - m.cy - hh, hiY = m.t - m.cy + hh;
    var px = pan.x * m.k, py = pan.y * m.k;
    px = (loX <= hiX) ? Math.min(hiX, Math.max(loX, px)) : 0;
    py = (loY <= hiY) ? Math.min(hiY, Math.max(loY, py)) : 0;
    pan.x = px / m.k;
    pan.y = py / m.k;
    return pan;
  }

  /** 绑定拖动：指针移动 → 改平移量 → 夹取 → 重写 transform。 */
  function bindMapPan(stage) {
    var pan = mapPan();
    var pid = null, sx = 0, sy = 0, ox = 0, oy = 0, m = null, dragging = false;
    if (stage.classList) stage.classList.add('map-pannable');

    stage.addEventListener('pointerdown', function (e) {
      if (e.isPrimary === false) return;
      if (typeof e.button === 'number' && e.button !== 0) return;
      m = mapPanMetrics(stage);
      if (!m) return;
      clampMapPan(stage, m);                 /* 尺寸/缩放变了也能从合法位置起拖 */
      applyMapTransform(stage);
      dragging = true;
      pid = e.pointerId;
      sx = e.clientX; sy = e.clientY;
      ox = pan.x; oy = pan.y;
      stage.__panMoved = false;              /* 让 bindTap 知道「这次是拖动不是点击」 */
      try { if (stage.setPointerCapture) stage.setPointerCapture(pid); } catch (err) {}
    });

    stage.addEventListener('pointermove', function (e) {
      if (!dragging || e.pointerId !== pid || !m) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        stage.__panMoved = true;
        if (stage.classList) stage.classList.add('map-panning');
      }
      pan.x = ox + dx / m.k;
      pan.y = oy + dy / m.k;
      clampMapPan(stage, m);
      applyMapTransform(stage);
      if (e.preventDefault) e.preventDefault();
    });

    function end(e) {
      if (!dragging) return;
      dragging = false;
      if (stage.classList) stage.classList.remove('map-panning');
      if (e && e.pointerId === pid) {
        try { if (stage.releasePointerCapture) stage.releasePointerCapture(pid); } catch (err) {}
      }
      /* 松手后再夹一次：拖到一半时可能被 clamp 拉回边界，这里确保最终位置合法 */
      clampMapPan(stage, m);
      applyMapTransform(stage);
      pid = null;
    }
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
  }

  /** 点到线段的最短距离**的平方**（避免开方，命中判定用）。
   *  线段 AB，点 P：把 P 投影到 AB 上，t 夹在 [0,1] 之间取线段上最近点。 */
  function distSegSq(px, py, ax, ay, bx, by) {
    var vx = bx - ax, vy = by - ay;
    var wx = px - ax, wy = py - ay;
    var len2 = vx * vx + vy * vy;
    var t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    var dx = px - (ax + t * vx), dy = py - (ay + t * vy);
    return dx * dx + dy * dy;
  }

  /**
   * 橡皮擦命中判定：返回「离点击点最近、且距离在阈值内」的笔迹下标；没命中返回 -1。
   *
   * v2.1.0 缺陷4修复：此前只看**采样点**（相邻采样点之间的空白会漏擦，用户抱怨
   * 「指到画上也擦不掉」）。现在对每一笔的**每一条线段**求「点到线段距离」——
   * 只要点落在笔迹线条附近就算命中，指哪擦哪。
   *
   * @param {Array}  strokes 笔迹数组，每笔形如 {pts:[{x,y}], color, width}
   * @param {number} x  归一化点击 X（0..1）
   * @param {number} y  归一化点击 Y（0..1）
   * @param {number} radius 命中半径（归一化，默认 0.035 ≈ 指腹大小）
   * @returns {number} 命中的笔迹下标，或 -1
   */
  function hitStrokeIndex(strokes, x, y, radius) {
    var r = (radius == null) ? 0.035 : radius;
    var r2 = r * r;
    var best = -1, bestD = Infinity;
    (strokes || []).forEach(function (s, i) {
      var pts = (s && s.pts) || [];
      if (!pts.length) return;
      if (pts.length === 1) {
        var d0 = (pts[0].x - x) * (pts[0].x - x) + (pts[0].y - y) * (pts[0].y - y);
        if (d0 <= r2 && d0 < bestD) { bestD = d0; best = i; }
        return;
      }
      for (var j = 0; j + 1 < pts.length; j++) {
        var d = distSegSq(x, y, pts[j].x, pts[j].y, pts[j + 1].x, pts[j + 1].y);
        if (d <= r2 && d < bestD) { bestD = d; best = i; }
      }
    });
    return best;
  }

  /* ============================================================
   * v2.4.0（用户第 ② 项）：橡皮擦**段级删除**
   *
   * 旧实现「命中即整笔删」太粗（一笔画了整条走廊，点一下全没）。新口径：
   *   · 命中判定：擦除点到笔迹**线段**的距离 ≤ 容差（2px，按舞台实际像素换算）；
   *   · 删除粒度：只删**被命中的段** —— 命中段两侧的笔迹拆成若干子笔保留；
   *   · 累积长度 < 3px 的子笔一律丢弃（擦除处不留碎点/碎线）；
   *   · 结果以「笔画集合整体替换」上报：
   *       KP 地图 → map.clear{strokesOnly} + 逐笔重画（保留标记/底图）；
   *       玩家板  → INTENT.BOARD 全量替换。
   * 全程在**像素空间**判定（归一化坐标按舞台 rect 换算），容差/最小长度单位即 px。
   * ============================================================ */
  var ERASE_TOL_PX = 2;        // 擦除容差 2px（单点轻点：精度优先）
  var ERASE_MIN_PX = 3;        // 累积长度 <3px 的子笔丢弃
  /* v2.5.0（用户第 6 项）：手指**划过**连续擦除的两个新参数。
     · ERASE_TOL_DRAG_PX：滑动容差。原 2px 是给「精确轻点」定的，pointermove 的
       采样点间距动辄十几 px，2px 的容差圈根本套不住线段 → 划过一大片却什么都没擦掉。
       放大到 10px（≈指腹）后，采样点之间的笔迹也能被判定命中。
     · ERASE_STEP_PX：插值步长。手指快速划过时两个 pointermove 之间可能跨 30px+，
       只按原始采样点擦会在笔迹上留下「一段擦掉、一段还在」的虚线状残留；
       按 4px 步长补点即可连成一条完整的擦除轨迹。 */
  var ERASE_TOL_DRAG_PX = 10;
  var ERASE_STEP_PX = 4;

  /** 像素空间：点 P 到线段 AB 的距离（A==B 时退化为点距）。 */
  function distSegPx(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    var t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    var cx = ax + t * dx, cy = ay + t * dy;
    return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
  }

  /** 两套笔画是否等价（按 颜色/线宽/点位 逐一比较，用于「没擦到就不上报」）。
   *  归一化口径：color/width 缺省视作「无」（重建时也不补默认值，保证未命中的笔
   *  重建后与输入逐字节一致 → 不会触发无谓的「清空+重画」广播）。 */
  function strokesEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    function sig(s) {
      var pts = (s && s.pts) || [];
      return JSON.stringify({
        c: (s && s.color) || '', w: (s && (s.width || s.w)) || 0,
        p: pts.map(function (q) { return [+Number(q.x).toFixed(4), +Number(q.y).toFixed(4)]; })
      });
    }
    for (var i = 0; i < a.length; i++) {
      if (sig(a[i]) !== sig(b[i])) return false;
    }
    return true;
  }

  /**
   * 按擦除点（像素坐标）把笔画集合拆成「保留的子笔集合」。
   * @param {Array}  strokes 原笔画（归一化 pts）
   * @param {number} px, py  擦除点（相对于舞台元素的像素坐标）
   * @param {{width:number,height:number}} rect 舞台尺寸（归一化↔像素换算）
   * @param {number} [tolPx] 容差（px）；缺省 ERASE_TOL_PX。
   *        v2.5.0（用户第 6 项）：连续擦除手势传 ERASE_TOL_DRAG_PX（10px）。
   * @returns {Array} 保留子笔（归一化 pts，继承原笔 color/width）
   */
  function eraseStrokeSegments(strokes, px, py, rect, tolPx) {
    var rw = rect.width || 1, rh = rect.height || 1;
    /* v2.5.0（用户第 6 项）：容差改为入参（缺省仍是 ERASE_TOL_PX，单点轻点行为不变）。 */
    var tol = (typeof tolPx === 'number' && tolPx > 0) ? tolPx : ERASE_TOL_PX;
    function toPx(p) { return { x: p.x * rw, y: p.y * rh }; }
    function toNorm(p) { return { x: +(p.x / rw).toFixed(4), y: +(p.y / rh).toFixed(4) }; }
    var out = [];
    (strokes || []).forEach(function (s) {
      var pts = (s && s.pts) || [];
      if (!pts.length) return;
      /* 继承原笔样式；缺省就不补默认值（保证未命中的笔重建后与输入一致） */
      var base = {};
      if (s && s.color) base.color = s.color;
      var w = s && (s.width || s.w);
      if (w) base.width = w;
      if (pts.length === 1) {
        /* 点笔（只有一个采样点）：落在容差内 → 整点消失；否则原样保留 */
        var q = toPx(pts[0]);
        if (distSegPx(px, py, q.x, q.y, q.x, q.y) > tol) {
          out.push({ color: base.color, width: base.width, pts: pts.slice() });
        }
        return;
      }
      var P = pts.map(toPx);
      var run = [], runLen = 0;
      function flush() {
        /* 累积长度 < ERASE_MIN_PX 的碎段一律丢弃 */
        if (run.length >= 2 && runLen >= ERASE_MIN_PX) {
          out.push({ color: base.color, width: base.width, pts: run.map(toNorm) });
        }
        run = []; runLen = 0;
      }
      for (var i = 0; i + 1 < P.length; i++) {
        var a = P[i], b = P[i + 1];
        var segLen = Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y));
        if (distSegPx(px, py, a.x, a.y, b.x, b.y) <= tol) { flush(); continue; }
        if (!run.length) run = [a];
        run.push(b);
        runLen += segLen;
      }
      flush();
    });
    return out;
  }

  /**
   * 地图笔画集合整集替换（v2.5.0（用户第 6 项）新增）。
   *
   * 优先走一次性 op `map.strokes.set{strokes}` —— 一条消息换整集、**保留 marks**、
   * **不写任何公开 LOG**（一次擦除手势只该产生一条同步消息，不该刷屏）。
   * 模型侧尚未落地该 op 时回落到旧的 `map.clear{strokesOnly} + 逐笔 map.stroke`
   * （结果等价，只是消息条数多），保证 UI 不依赖模型改动就能跑。
   *
   * @param {object} ctx
   * @param {Array} keep 擦除后应保留的完整笔画集合
   */
  function commitMapStrokes(ctx, keep) {
    if (!ctx || !Array.isArray(keep)) return;
    if (M && M.POLICY && M.POLICY['map.strokes.set']) {
      ctx.act({ op: 'map.strokes.set', strokes: keep });
      return;
    }
    ctx.act({ op: 'map.clear', strokesOnly: true });
    keep.forEach(function (s) {
      ctx.act({ op: 'map.stroke', color: s.color, width: s.width, pts: s.pts });
    });
  }

  /**
   * KP 地图橡皮擦：一次「划过」手势**结束时**的整集提交。
   *
   * v2.5.0（用户第 6 项）：语义从「擦一个点」升级为「一次手势擦完后的整集提交」——
   * 手势过程中只在本地 working 副本上改 + 本地重绘，**不在 move 里 ctx.act**
   * （每个 move 都上报会刷屏 + 撞服务端限流）。
   *
   * @param {object} ctx
   * @param {Array} keep    擦除后保留的笔画集合
   * @param {Array} strokes 手势开始前的笔画集合（用于「没擦到就不上报」短路）
   */
  function eraseAt(ctx, keep, strokes) {
    if (!ctx || !Array.isArray(keep)) return;
    if (strokesEqual(keep, strokes)) return;    // 没擦到任何线段：不动（避免无谓广播）
    commitMapStrokes(ctx, keep);
  }

  /**
   * 玩家手绘板橡皮擦（v2.1.0 缺陷4b新增）：一次手势结束后的整集提交，
   * 通过 INTENT.BOARD 整体替换回写权威端（模型里 boardSelf 整板替换该 seat）。
   * v2.4.0（用户第 ② 项）：由「命中即整笔删」升级为段级删除（见 eraseStrokeSegments）。
   * v2.5.0（用户第 6 项）：与 eraseAt 同步改为「手势末尾一次性提交」。
   */
  function eraseBoardAt(ctx, keep, strokes) {
    if (!ctx || !Array.isArray(keep)) return;
    if (strokesEqual(keep, strokes)) return;
    ctx.intent(M.INTENT.BOARD, { strokes: keep });
  }

  /** 缩放控件（v2.13.2：放大后追加「可拖动」提示） */
  function zoomCtrl(ctx) {
    function setZ(v) {
      UI_STATE.zoom = Math.max(0.5, Math.min(3, v));
      /* 回到 100%（及以下）时平移量归零 —— 否则会残留一个偏移，看着像图歪了 */
      if (UI_STATE.zoom <= 1.0001) UI_STATE.pan = { x: 0, y: 0 };
      rerender(ctx);
    }
    var z = UI_STATE.zoom || 1;
    var kids = [
      el('button.btn.sm.ghost', { text: '－', onclick: function () { setZ((UI_STATE.zoom || 1) - 0.25); } }),
      el('span.zoom-val', { text: Math.round((UI_STATE.zoom || 1) * 100) + '%' }),
      el('button.btn.sm.ghost', { text: '＋', onclick: function () { setZ((UI_STATE.zoom || 1) + 0.25); } }),
      el('button.btn.sm.ghost', { text: '重置', onclick: function () { setZ(1); } })
    ];
    if (z > 1.0001) {
      kids.push(el('span.zoom-hint', { text: '可拖动查看边缘' }));
    }
    return el('div.zoom-ctrl', null, kids);
  }

  function openFullscreen(ctx) {
    var bg = mapBackground(ctx);
    var ov = el('div.gp-fs', null, [
      bg ? el('img', { src: bg.data, alt: bg.name || '' })
         : el('div.tiny.dim', { text: '当前没有展示图。' }),
      el('button.btn.primary', { text: '← 返回', onclick: function () { if (ov.parentNode) ov.parentNode.removeChild(ov); } })
    ]);
    document.body.appendChild(ov);
  }

  /** 全屏查看**指定**素材（玩家点公开素材格子用）。 */
  function openFullscreenSrc(src, name) {
    var ov = el('div.gp-fs', null, [
      src ? el('img', { src: src, alt: name || '' })
          : el('div.tiny.dim', { text: '这张素材没有图。' }),
      el('button.btn.primary', { text: '← 返回', onclick: function () { if (ov.parentNode) ov.parentNode.removeChild(ov); } })
    ]);
    document.body.appendChild(ov);
  }

  /**
   * 玩家/旁观者的「公开素材」区（v2.1.1 · 用户第 1 项）。
   *
   * 此前玩家端**没有任何地方**列出公开素材 —— 只有「恰好被选作中央底图的那一张」
   * 才看得到（`mapBackground` 只取第一张 data:image）。于是 KP 公开两张以上时，
   * 除第一张外玩家**一律看不到**，正是用户说的「素材已公开但玩家看不到图」。
   *
   * 这里只读渲染 `scene.assets`（该数组在模型里**只含已公开素材**），
   * 点格子全屏查看。玩家不可公开/隐藏（那是 KP 的 `asset.reveal`）。
   */
  function publicAssets(ctx) {
    var pub = ((ctx.st.scene || {}).assets) || [];
    if (!pub.length) return null;
    var box = el('div.pub-assets');
    box.appendChild(el('div.card-title', { text: '公开素材（' + pub.length + '）' }));
    var grid = el('div.asset-grid');
    pub.forEach(function (a) {
      var isImg = /^data:image\//.test(a.data || '');
      grid.appendChild(el('div.asset-cell.pub', {
        title: a.name || '素材',
        onclick: function () { openFullscreenSrc(a.data, a.name); }
      }, [
        isImg ? el('img', { src: a.data, alt: a.name }) : el('div.ph', { text: '🖼' }),
        el('div.cap', { text: a.name || '素材' })
      ]));
    });
    box.appendChild(grid);
    return box;
  }

  /**
   * 单击手势：pointerup 里判「没怎么移动」才算一次点击。
   * （不用 click：pointerdown 里 preventDefault 抑制系统长按会压掉 click。）
   *
   * v2.1.1（用户第 4 项）：真机加固 ——
   *   ① 内联 `touch-action:none`：即便 app.css 未加载 / 选择器不命中，父容器也无法
   *      抢走手势（真机上「橡皮点不动」最常见的原因就是滚动容器把 touch 吃了）。
   *   ② 处理 `pointercancel`：系统抢走手势时（滚动/长按/来电）必须复位，避免
   *      `moved` 残留导致下一次点击被误判为拖动而落空。
   */
  function bindTap(hostEl, onTap) {
    var sx = 0, sy = 0, moved = false;
    if (hostEl.style) hostEl.style.touchAction = 'none';
    function reset() { moved = false; }
    hostEl.addEventListener('pointerdown', function (e) {
      sx = e.clientX; sy = e.clientY; moved = false;
      if (e.preventDefault) e.preventDefault();
    });
    hostEl.addEventListener('pointermove', function (e) {
      if (Math.abs(e.clientX - sx) > 12 || Math.abs(e.clientY - sy) > 12) moved = true;
    });
    hostEl.addEventListener('pointerup', function (e) {
      /* v2.13.2：素材舞台放大后，拖动 = 平移画面，不能再被当成「落一个标记」的点击 */
      if (moved || hostEl.__panMoved) return;
      var r = hostEl.getBoundingClientRect();
      if (!r.width || !r.height) return;
      var x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      var y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      onTap(x, y);
    });
    hostEl.addEventListener('pointercancel', reset);
  }

  /**
   * 在元素上绑定「按下-移动-抬起」得到归一化坐标序列。
   *
   * v2.4.0（用户第 ② 项）：**实时绘制** —— 落笔后每次 pointermove 立即在舞台顶部
   * 叠加层（SVG path，viewBox 0 0 1 1 + non-scaling-stroke）上**增量补线段**，
   * 手指不用抬起就能看到笔迹（旧实现只有抬起后才提交，画的时候屏幕空白）。
   * `live` 缺省 → 维持旧的「只提交不预览」行为（不影响其他调用方）。
   *
   * @param {HTMLElement} hostEl 舞台元素（.map-stage，CSS 已 position:relative）
   * @param {Function} onDone 收尾回调（pts 归一化数组，≥2 点才调）
   * @param {{color?: string, width?: number}} [live] 实时预览的配色/线宽
   */
  function bindDraw(hostEl, onDone, live) {
    var pts = [], drawing = false, pid = null;
    /* v2.1.1（用户第 4 项）：内联 touch-action:none —— 不依赖 app.css，
       真机上父滚动容器永远无法把这次触摸抢去滚动 → 落笔不再被中断。 */
    if (hostEl.style) hostEl.style.touchAction = 'none';
    /* ---- v2.4.0（用户第 ② 项）：实时预览叠加层 ---- */
    var overlay = null, livePath = null, liveD = '';
    function liveStart(p0) {
      if (!live) return;
      liveD = 'M' + p0.x + ' ' + p0.y;
      overlay = svgEl('svg', { viewBox: '0 0 1 1', preserveAspectRatio: 'none',
        style: 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:6' });
      livePath = svgEl('path', { d: liveD, fill: 'none', stroke: live.color || '#e0605a',
        'stroke-width': live.width || 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        'vector-effect': 'non-scaling-stroke' });
      overlay.appendChild(livePath);
      hostEl.appendChild(overlay);
    }
    function liveMove(p) {
      if (!live || !livePath) return;
      /* 增量线段：每来一个点补一段 M(上一点) L(新点) */
      liveD += ' M' + pts[pts.length - 2].x + ' ' + pts[pts.length - 2].y +
               ' L' + p.x + ' ' + p.y;
      livePath.setAttribute('d', liveD);
    }
    function liveEnd() {
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      overlay = null; livePath = null; liveD = '';
    }
    function norm(e) {
      var r = hostEl.getBoundingClientRect();
      var x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      var y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      return { x: +x.toFixed(4), y: +y.toFixed(4) };
    }
    function detach() {
      global.removeEventListener('pointerup', finish);
      global.removeEventListener('pointercancel', finish);
    }
    /** 收尾：把已画出的部分提交给 onDone，并清状态（up / cancel 共用）。 */
    function finish(e) {
      if (!drawing) return;
      if (pid != null && e && e.pointerId != null && e.pointerId !== pid) return;
      drawing = false;
      detach();
      try { if (pid != null && hostEl.releasePointerCapture) hostEl.releasePointerCapture(pid); } catch (err) {}
      pid = null;
      liveEnd();
      var out = pts.slice(0, 400);
      pts = [];
      if (out.length >= 2) onDone(out);
    }
    function down(e) {
      if (drawing) return;                       // 第二根手指 / 重复按下：忽略
      drawing = true;
      pid = (e.pointerId != null ? e.pointerId : null);
      pts = [norm(e)];
      /* 指针捕获：手指滑出舞台 / 滑过子节点（svg、缩略图）时 pointermove 仍回到本元素 */
      try { if (pid != null && hostEl.setPointerCapture) hostEl.setPointerCapture(pid); } catch (err) {}
      liveStart(pts[0]);
      /* 监听挂在 window：无论是否捕获成功都能收到 up/cancel；且**每次落笔才挂、
         收尾即摘** —— 不会像旧实现那样在 window 上无限累积监听器。 */
      global.addEventListener('pointerup', finish);
      global.addEventListener('pointercancel', finish);
      if (e.preventDefault) e.preventDefault();
    }
    function move(e) {
      if (!drawing) return;
      if (pid != null && e.pointerId != null && e.pointerId !== pid) return;
      pts.push(norm(e));
      liveMove(pts[pts.length - 1]);
    }
    hostEl.addEventListener('pointerdown', down);
    hostEl.addEventListener('pointermove', move);
  }

  /* ============================================================
   * v2.5.0（用户第 6 项）：橡皮擦「手指划过实时擦除」
   *
   * 旧实现的三个死穴：
   *   ① 三处入口都走 bindTap —— 而 bindTap 是**显式丢弃一切拖动**的（pointermove
   *      位移 >12px 就置 moved=true，pointerup 里 `if (moved) return;`），
   *      所以橡皮只能「点一下擦一点」，划过去没有任何反应。
   *   ② 擦除入口 eraseAt/eraseBoardAt 是**单点**语义，一次只喂一个 (px,py)；
   *      pointermove 采样稀疏（间距十几 px）+ 容差只有 2px → 划过也套不中线段。
   *   ③ 对照 bindDraw 已在 v2.4.0 做成「落笔即见笔迹」的实时预览，橡皮没跟上。
   *
   * 新口径（骨架照抄 bindDraw，行为对齐）：
   *   · pointerdown 起手势 → pointermove **按 ERASE_STEP_PX(4px) 插值**逐点段级擦除
   *     → pointerup / pointercancel 收尾**一次性提交**（一次手势一条消息）。
   *   · 手势期间只改本地 working 副本 + 本地重绘，**绝不**在 move 里 ctx.act。
   * ============================================================ */

  /**
   * 擦除手势绑定（骨架与 bindDraw 同构：pointerdown / move / up + setPointerCapture
   * + touch-action:none + window 监听「每次落笔才挂、收尾即摘」）。
   *
   * @param {HTMLElement} hostEl 舞台元素（.map-stage）
   * @param {Function} onMove 每个插值采样点回调 `(x, y, prevX, prevY, isLast)`，
   *        坐标为**相对 hostEl 左上角的像素**；`isLast` 表示该次 pointermove 的
   *        最后一个采样点（调用方据此做一次本地重绘，避免每点都重建 SVG）。
   * @param {Function} [onEnd] 手势结束（up / cancel）回调 —— 在这里做一次性提交。
   */
  function bindErase(hostEl, onMove, onEnd) {
    var erasing = false, pid = null, last = null;
    /* 与 bindDraw 同款：不依赖 app.css，真机上父滚动容器抢不走这次触摸。 */
    if (hostEl.style) hostEl.style.touchAction = 'none';
    /** 当前指针相对舞台左上角的像素坐标（含舞台尺寸，供容差换算）。 */
    function at(e) {
      var r = hostEl.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    function detach() {
      global.removeEventListener('pointerup', finish);
      global.removeEventListener('pointercancel', finish);
    }
    /** 收尾：复位状态 + 通知提交（up / cancel 共用，与 bindDraw.finish 对称）。 */
    function finish(e) {
      if (!erasing) return;
      if (pid != null && e && e.pointerId != null && e.pointerId !== pid) return;
      erasing = false;
      detach();
      try { if (pid != null && hostEl.releasePointerCapture) hostEl.releasePointerCapture(pid); } catch (err) {}
      pid = null; last = null;
      if (onEnd) onEnd();
    }
    function down(e) {
      if (erasing) return;                       // 第二根手指 / 重复按下：忽略
      var p = at(e);
      if (!p) return;
      erasing = true;
      pid = (e.pointerId != null ? e.pointerId : null);
      try { if (pid != null && hostEl.setPointerCapture) hostEl.setPointerCapture(pid); } catch (err) {}
      global.addEventListener('pointerup', finish);
      global.addEventListener('pointercancel', finish);
      last = p;
      /* 落点也算一次擦除（纯轻点不移动 = 旧的单点擦除，行为不回归）。 */
      onMove(p.x, p.y, p.x, p.y, true);
      if (e.preventDefault) e.preventDefault();
    }
    function move(e) {
      if (!erasing) return;
      if (pid != null && e.pointerId != null && e.pointerId !== pid) return;
      var p = at(e);
      if (!p || !last) return;
      /* 插值：把「上一点 → 当前点」按 ERASE_STEP_PX 切成若干采样点，
         否则手指快速划过时笔迹会被擦成「一段没了一段还在」的虚线状残留。 */
      var dx = p.x - last.x, dy = p.y - last.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var steps = Math.ceil(dist / ERASE_STEP_PX);
      if (!isFinite(steps) || steps < 1) steps = 1;
      if (steps > 240) steps = 240;              // 防御：切后台回来的超大位移不暴走
      var cx = last.x, cy = last.y;
      for (var i = 1; i <= steps; i++) {
        var nx = last.x + dx * (i / steps), ny = last.y + dy * (i / steps);
        onMove(nx, ny, cx, cy, i === steps);
        cx = nx; cy = ny;
      }
      last = p;
    }
    hostEl.addEventListener('pointerdown', down);
    hostEl.addEventListener('pointermove', move);
  }

  /**
   * 把「划过实时擦除」接到某个具体舞台上（维护 working 副本 + 本地即时重绘）。
   *
   * 本地重绘的做法：手势开始时**隐藏**原笔迹层（`svg.strokes-svg`），改为叠加一张
   * 由 working 副本生成的同款 SVG；手势结束摘掉临时层、恢复原层可见性，
   * 然后一次性提交（提交后状态回流会重画整块，原层的显隐即使没还原也无所谓）。
   *
   * @param {HTMLElement} stage 舞台元素
   * @param {Array} base 手势开始前的笔画集合（快照，用于「没擦到就不上报」）
   * @param {Function} commit `(keep, base)` 手势结束时的提交回调
   */
  function bindEraseStage(stage, base, commit) {
    if (!stage || !Array.isArray(base) || !base.length) return;   // 没内容可擦：不绑
    var working = base.slice();
    var orig = stage.querySelector('svg.strokes-svg');
    var live = null;
    var LIVE_STYLE = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:6';
    function paintLive() {
      if (live && live.parentNode) live.parentNode.removeChild(live);
      live = strokesSvg(working, LIVE_STYLE);
      stage.appendChild(live);
    }
    function begin() {
      if (orig) orig.style.display = 'none';     // 藏原层 → 让 working 层成为唯一可见笔迹
      paintLive();
    }
    function done() {
      if (live && live.parentNode) live.parentNode.removeChild(live);
      live = null;
      if (orig) orig.style.display = '';
      commit(working, base);
    }
    bindErase(stage, function (x, y, prevX, prevY, isLast) {
      var r = stage.getBoundingClientRect();
      if (!r.width || !r.height) return;
      /* 段级擦除，容差用**滑动专用**的 ERASE_TOL_DRAG_PX（10px ≈ 指腹）。 */
      working = eraseStrokeSegments(working, x, y, r, ERASE_TOL_DRAG_PX);
      if (isLast) paintLive();                   // 每个 move 事件只重绘一次，不逐点重建
    }, done);
    begin();
  }

  /* ============================================================
   * KP 页 · 左窄栏（地图 / NPC·怪物 / 素材）
   * ============================================================ */

  function collectAssets(ctx, mapsOnly) {
    var scene = ctx.st.scene || {};
    var pub = scene.assets || [];
    var mine = (ctx.role === 'kp' && ctx.host && ctx.host.localAssets) ? ctx.host.localAssets : [];
    var list = [], seen = {};
    if (ctx.role === 'kp') {
      mine.forEach(function (a) { if (a && a.id && !seen[a.id]) { seen[a.id] = 1; list.push({ a: a, secret: !a.revealed, own: true }); } });
    }
    pub.forEach(function (a) { if (a && a.id && !seen[a.id]) { seen[a.id] = 1; list.push({ a: a, secret: false, own: false }); } });
    if (mapsOnly) list = list.filter(function (it) { return it.a.kind === 'map' || /map|地图/i.test(it.a.name || ''); });
    return list;
  }

  function assetUpload(ctx, kind, onDone) {
    var files = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    files.addEventListener('change', function () {
      var f = files.files && files.files[0];
      if (!f) return;
      if (f.size > 2 * 1024 * 1024) { global.UI.toast('图片请小于 2MB', 'err'); files.value = ''; return; }
      var rd = new FileReader();
      rd.onload = function () {
        ctx.act({ op: 'asset.add', asset: { kind: kind || 'map', name: f.name.replace(/\.[^.]+$/, ''), data: String(rd.result) } });
        global.UI.toast('已加入素材库（尚未公开）', 'ok');
        if (onDone) onDone();
      };
      rd.readAsDataURL(f);
      files.value = '';
    });
    return files;
  }

  function leftAssetsList(ctx, mapsOnly) {
    var box = el('div.left-assets');
    var list = collectAssets(ctx, mapsOnly);
    if (ctx.role === 'kp') {
      var files = assetUpload(ctx, mapsOnly ? 'map' : 'image');
      box.appendChild(files);
      box.appendChild(el('button.btn.sm.ghost.block', {
        text: '＋ 上传图片', style: { marginBottom: '8px' },
        onclick: function () { files.click(); }
      }));
    }
    if (!list.length) {
      box.appendChild(el('div.tiny.dim', {
        text: ctx.role === 'kp' ? '还没有素材。上传后点一下即公开给玩家。' : 'KP 还没有公开素材。'
      }));
      return box;
    }
    var grid = el('div.thumb-grid');
    /* v2.6.0（用户第 1 项）：当前中央底图高亮；已公开图片可一键设为底图。 */
    var coverId = (ctx.st.scene || {}).image || '';
    list.forEach(function (it) {
      var a = it.a;
      var isImg = /^data:image\//.test(a.data || '');
      var isCover = !!(coverId && a.id === coverId);
      var thumb = el('div.thumb' + (it.secret ? '.secret' : '') + (isCover ? '.cover' : ''), {
        title: (a.name || '素材') + (it.secret ? '（未公开）' : ''),
        onclick: function () {
          if (ctx.role !== 'kp') return;
          ctx.act({ op: 'asset.reveal', id: a.id, revealed: !!it.secret });
        }
      }, [
        isImg ? el('img', { src: a.data, alt: a.name }) : el('div.ph', { text: '🖼' }),
        el('div.cap', { text: a.name || '素材' })
      ]);
      /* v2.6.0（用户第 1 项）：已公开的图片 → 一键设为中央底图；当前底图点击取消。 */
      if (ctx.role === 'kp' && !it.secret && isImg) {
        thumb.appendChild(el('button.thumb-pin' + (isCover ? '.on' : ''), {
          text: isCover ? '📌 当前底图' : '📌 设为底图',
          title: isCover ? '点击取消底图（回落第一张已公开图片）' : '设为中央 16:9 底图',
          onclick: function (ev) {
            if (ev && ev.stopPropagation) ev.stopPropagation();
            ctx.act({ op: 'asset.cover', id: isCover ? '' : a.id });
          }
        }));
      }
      /* v2.1.3（用户第 5 项 · KP 素材可删）：右上角小 ✕。
         必须 stopPropagation —— 缩略图本身的点击是「公开/隐藏」，不能顺手把素材删了。 */
      if (ctx.role === 'kp') {
        thumb.appendChild(el('button.thumb-del', {
          text: '✕', title: '删除该素材',
          onclick: function (ev) {
            if (ev && ev.stopPropagation) ev.stopPropagation();
            global.UI.confirm('删除素材「' + (a.name || '素材') +
              '」？若已公开，会同时从所有人的画面上撤下。', { danger: true, okText: '删除' })
              .then(function (ok) {
                if (!ok) return;
                ctx.act({ op: 'asset.del', id: a.id });
                global.UI.toast('已删除该素材', 'ok');
              });
          }
        }));
      }
      grid.appendChild(thumb);
    });
    box.appendChild(grid);
    if (ctx.role === 'kp') {
      box.appendChild(el('div.tiny.dim', { style: { marginTop: '8px' },
        text: '未公开的素材只有你能看到；点一下公开给所有人。' }));
    }
    return box;
  }

  /**
   * 开战前的「怪物/NPC 候选池」。
   * 数据来源（按优先级，全部兜底，避免依赖单一来源）：
   *   ① ctx.host.localActors（若 E 线提供 KP 本地候选池）
   *   ② 本模块 UI_STATE.pendingActors（本地兜底缓存）
   *   ③ st.combat.order 里已有的 monster/npc（复用旧战斗单位）
   */
  function actorPool(ctx) {
    var pool = [], seen = {};
    function add(a) {
      if (!a || !a.id || seen[a.id]) return;
      if (a.kind !== 'monster' && a.kind !== 'npc') return;
      seen[a.id] = 1; pool.push(a);
    }
    if (ctx.host && ctx.host.localActors) (ctx.host.localActors || []).forEach(add);
    (UI_STATE.pendingActors || []).forEach(add);
    var c = ctx.st.combat;
    if (c && c.order) {
      var uniq = {};
      c.order.forEach(function (s) {
        if (uniq[s.actorId]) return; uniq[s.actorId] = 1;
        add({ id: s.actorId, name: s.name, kind: s.kind, dex: (s.public || {}).dex,
              hp: (s.public || {}).hp, hpMax: (s.public || {}).hpMax,
              actionsPerRound: s.totalSlots });
      });
    }
    return pool;
  }

  /**
   * 往「候选池」追加一个单位。
   *
   * v2.5.0（用户第 5 项）：优先级 ——
   *   ① `ctx.host.addLocalActor(actor)`：模型侧 v2.5.0 新增，**带同 id 去重**，
   *      且写进 `savePayload` 跟着存档走（此前 `localActors` 从未被赋值，
   *      这里只能直 push，重复添加会在池里留脏数据）；
   *   ② 直 push `ctx.host.localActors`（模型侧还没该方法时的兼容路径）；
   *   ③ 本模块兜底缓存 `UI_STATE.pendingActors`。
   */
  function addPendingActor(ctx, actor) {
    if (ctx.host && typeof ctx.host.addLocalActor === 'function') {
      ctx.host.addLocalActor(actor);
      return;
    }
    /* 优先写模型侧候选池；没有就写本模块兜底缓存 */
    if (ctx.host && Array.isArray(ctx.host.localActors)) { ctx.host.localActors.push(actor); return; }
    UI_STATE.pendingActors.push(actor);
  }

  function leftActorsList(ctx) {
    var box = el('div.left-actors');
    if (ctx.role === 'kp') {
      box.appendChild(el('button.btn.sm.ghost.block', {
        text: '＋ 添加怪物 / NPC', style: { marginBottom: '8px' },
        onclick: function () { addActorSheet(ctx, { preCombat: true }); }
      }));
    }
    var pool = actorPool(ctx);
    if (!pool.length) {
      box.appendChild(el('div.tiny.dim', { text: ctx.role === 'kp' ? '还没有怪物/NPC。点上面添加。' : 'KP 还没有放置单位。' }));
      return box;
    }
    pool.forEach(function (a) {
      box.appendChild(el('div.actor-line' + (a.kind === 'monster' ? '.monster' : ''), null, [
        el('div.grow', null, [
          el('div.nm', { text: a.name || '—' }),
          el('div.tiny.dim', { text: (a.kind === 'monster' ? '怪物' : 'NPC') + ' · DEX ' + (a.dex != null ? a.dex : '—') })
        ])
      ]));
    });
    return box;
  }

  /** KP 左窄栏：三 tab（地图 / NPC·怪物 / 素材） */
  function kpLeftColumn(ctx) {
    if (!M) boot();
    var wrap = el('div.kp-left-col');
    wrap.appendChild(panelTabs([
      { key: 'map', label: '🗺 地图' },
      { key: 'actors', label: '👹 NPC·怪物' },
      { key: 'assets', label: '🖼 素材' }
    ], UI_STATE.leftTab, function (k) { UI_STATE.leftTab = k; rerender(ctx); }));
    var body = scrollBox(null, []);
    if (UI_STATE.leftTab === 'actors') body.appendChild(leftActorsList(ctx));
    else if (UI_STATE.leftTab === 'assets') body.appendChild(leftAssetsList(ctx, false));
    else body.appendChild(leftAssetsList(ctx, true));
    wrap.appendChild(body);
    return wrap;
  }

  /* ============================================================
   * KP 页 · 工具窄栏（标记 / 画笔 / 橡皮 / 颜色 / 清除 / 锁定 / 放置）
   * ============================================================ */

  function kpToolColumn(ctx) {
    if (!M) boot();
    var t = UI_STATE.tool;
    var wrap = el('div.kp-tool-col');

    wrap.appendChild(el('div.sec-title', { text: '标记图标' }));
    var ICONS = ['📍', '🔥', '🚪', '🗝️', '⚠️', '👤', '💀', '⭐', '🩸', '📌', '🚩', '❓'];
    var grid = el('div.icon-grid');
    ICONS.forEach(function (ic) {
      grid.appendChild(el('div.icon-cell' + (t.mode === 'mark' && t.icon === ic ? '.on' : ''), {
        text: ic,
        onclick: function () { t.mode = 'mark'; t.icon = ic; rerender(ctx); }
      }));
    });
    wrap.appendChild(grid);

    wrap.appendChild(el('div.btn-col', { style: { marginTop: '8px' } }, [
      el('button.btn.sm' + (t.mode === 'draw' ? '.primary' : '.ghost'), {
        text: '✏️ 画笔', onclick: function () { t.mode = 'draw'; rerender(ctx); } }),
      el('button.btn.sm' + (t.mode === 'erase' ? '.primary' : '.ghost'), {
        text: '🧽 橡皮擦', onclick: function () { t.mode = 'erase'; rerender(ctx); } }),
      el('button.btn.sm' + (t.mode === 'place' ? '.primary' : '.ghost'), {
        text: '👹 放置单位', onclick: function () { placeActorSheet(ctx); } }),
      /* v2.1.4（用户第 6 项）：把**玩家**摆到公开素材图上（站位，供事件/战斗判定）。
         选人后进入「放置玩家」态，再在地图上点一下即落点（相对坐标，跨设备一致）。 */
      el('button.btn.sm.ghost', {
        text: '👤 放置玩家', onclick: function () { placePlayerSheet(ctx); } })
    ]));

    var sw = el('div.color-row', { style: { marginTop: '8px' } });
    DRAW_COLORS.forEach(function (c) {
      sw.appendChild(el('div.swatch' + (t.color === c ? '.on' : ''), {
        style: { background: c }, onclick: function () { t.color = c; rerender(ctx); }
      }));
    });
    wrap.appendChild(sw);

    /* v2.1.1（用户第三轮反馈 · 删冗余）：
       · 移除「💾 保存本局」—— 底部工具栏已有常驻入口（room-ui.js .gp-save-btn）
         且「🧰 KP 工具」弹层里也有，左栏这一个是重复的。
       · 移除「🔒 锁定拖动」—— 本模型标记**不支持拖动**（见 placeActorSheet 注释），
         该按钮唯一效果是禁用整块地图交互，属误导性冗余（用户明确要求删除）。
       只保留「🗑 清除地图」。 */
    wrap.appendChild(el('div.btn-col', { style: { marginTop: '8px' } }, [
      el('button.btn.sm.ghost', {
        text: '🗑 清除地图', onclick: function () {
          global.UI.confirm('清空地图上的所有标记与笔迹？', { danger: true, okText: '清空' })
            .then(function (ok) { if (ok) ctx.act({ op: 'map.clear' }); });
        }
      })
    ]));
    return wrap;
  }

  /** 放置 NPC/怪物：从候选池里选一个「作为标记放到地图上」 */
  /** v2.1.4（用户第 6 项）：放置玩家 —— 选一个玩家，再在地图上点一下落点。 */
  function placePlayerSheet(ctx) {
    var players = playersOf(ctx);
    var body = el('div', null, [
      el('div.tiny.dim', { text: '选一个玩家，然后在**公开素材图上点一下**放置他的站位。' })
    ]);
    if (!players.length) {
      body.appendChild(el('div.tiny.dim', { style: { marginTop: '8px' }, text: '房间里还没有玩家。' }));
      global.UI.sheet({ title: '放置玩家', body: body });
      return;
    }
    var api = global.UI.sheet({ title: '放置玩家', body: body });
    players.forEach(function (m) {
      body.appendChild(el('div.actor-line', {
        onclick: function () {
          var nm = m.charName || m.nickname || '玩家';
          UI_STATE.tool = { mode: 'mark', icon: '👤', color: UI_STATE.tool.color, playerName: nm };
          api.close();
          rerender(ctx);
          global.UI.toast('现在去公开素材图上点一下，放置「' + nm + '」', 'ok');
        }
      }, [
        el('div.grow', null, [el('div.nm', { text: m.charName || m.nickname || '玩家' })])
      ]));
    });
  }

  function placeActorSheet(ctx) {
    var pool = actorPool(ctx);
    var body = el('div', null, [
      el('div.tiny.dim', { text: '选一个单位，然后在**地图上点一下**放置（当前版本以标记形式落点）。' })
    ]);
    if (!pool.length) {
      body.appendChild(el('div.tiny.dim', { style: { marginTop: '8px' }, text: '候选池是空的。先到左侧「NPC·怪物」tab 添加。' }));
      global.UI.sheet({ title: '放置单位', body: body });
      return;
    }
    var api = global.UI.sheet({ title: '放置单位', body: body });
    pool.forEach(function (a) {
      body.appendChild(el('div.actor-line', {
        onclick: function () {
          /* v2.5.0（用户第 9 项 ·「放置单位应落在我点击的位置」）：
             旧实现**硬编码** x:0.5 / y:0.5 —— 不管选谁都落在地图正中心，
             用户点「放置单位」是想放到自己点的位置。改为与 placePlayerSheet 一致：
             选完只**切换工具态**（记下单位名），真正的落点由用户在图上点一下决定。 */
          var nm = a.name || '单位';
          UI_STATE.tool = { mode: 'mark', icon: '👹', color: UI_STATE.tool.color,
                            playerName: '', actorName: nm };
          api.close();
          rerender(ctx);
          global.UI.toast('现在去图上点一下，放置「' + nm + '」', 'ok');
        }
      }, [
        el('div.grow', null, [el('div.nm', { text: a.name || '—' }),
          el('div.tiny.dim', { text: (a.kind === 'monster' ? '怪物' : 'NPC') + ' · DEX ' + (a.dex != null ? a.dex : '—') })])
      ]));
    });
  }

  /* ============================================================
   * KP 页 · 中央地图区（战斗时叠加行动顺序条）
   * ============================================================ */

  function kpMapArea(ctx) {
    if (!M) boot();
    var wrap = el('div.kp-map-area');
    if (isCombat(ctx)) wrap.appendChild(initiativeBar(ctx));
    var stageWrap = el('div.map-stage-wrap');
    stageWrap.appendChild(mapStage(ctx, ctx.role === 'kp'));
    wrap.appendChild(stageWrap);
    wrap.appendChild(zoomCtrl(ctx));
    return wrap;
  }

  /* ============================================================
   * KP 页 · 游戏记录（全部 / 主持人 / 玩家）
   * ============================================================ */

  function seatRole(ctx, seat) {
    if (!seat) return 'sys';
    if (seat === M.HOST_SEAT) return 'kp';
    var m = findMember(ctx.st, seat);
    return m ? m.role : 'player';
  }

  /** 按 seat 找成员（拿头像用）；KP 没有成员记录 → 给个假身份让头像退成首字母 */
  function memberOfSeat(ctx, seat) {
    if (!seat) return null;
    var ms = ((ctx && ctx.st) ? ctx.st.members : null) || [];
    for (var i = 0; i < ms.length; i++) if (ms[i] && ms[i].seat === seat) return ms[i];
    if (seat === M.HOST_SEAT) return { nickname: 'KP', charName: '' };
    return null;
  }

  /** 条目最左的角色头像（缩略图；没有上传过头像 → 名字首字） */
  function feedAvatar(ctx, seat, label) {
    var m = memberOfSeat(ctx, seat);
    if (!m && !label) return null;
    if (!m) m = { nickname: label || 'KP' };
    return el('div.feed-av', null, [avatarEl(m, 'mini')]);
  }

  function feedNode(it, mySeat, ctx) {
    if (it.kind === 'chat') {
      return el('div.log-chat' + (it.seat === mySeat ? '.mine' : ''), null, [
        feedAvatar(ctx, it.seat, it.nickname),
        el('div.feed-body', null, [
          el('div.tiny.dim', { text: (it.nickname || '匿名') + ' · ' + timeText(it.at) }),
          el('div', { text: it.text })
        ])
      ]);
    }
    if (it.kind === 'dice') {
      var d = it.dice || {};
      return el('div.log-dice', null, [
        feedAvatar(ctx, it.seat, it.nickname),
        el('div.feed-body', null, [
          el('div', null, [
            el('b', { text: '🎲 ' + (it.nickname || '') + ' · ' + (d.expr || '1D100') }),
            el('span', { style: { marginLeft: '6px' }, text: '＝ ' + d.total })
          ]),
          d.levelText ? el('div.tiny.dim', { text: d.levelText + (d.label ? (' · ' + d.label) : '') }) : null
        ].filter(Boolean))
      ]);
    }
    return el('div.log-sys', null, [
      el('span', { text: it.text }),
      el('span.tiny.dim', { style: { marginLeft: '6px' }, text: timeText(it.at) })
    ]);
  }

  /** 汇总 logs + dice 成一条时间序（可选 filter） */
  function collectFeeds(ctx, filter) {
    var st = ctx.st;
    var items = [];
    (st.logs || []).forEach(function (l) {
      items.push({ at: l.at || 0, kind: 'sys', seat: l.seat, text: l.text });
    });
    (st.dice || []).forEach(function (d) {
      items.push({ at: d.at || 0, kind: 'dice', seat: d.seat, nickname: d.nickname, dice: d });
    });
    items.sort(function (a, b) { return a.at - b.at; });
    if (filter) items = items.filter(filter);
    return items.slice(-120);
  }

  function renderLogItems(ctx, container, filter) {
    var items = collectFeeds(ctx, filter);
    if (!items.length) { container.appendChild(el('div.room-log-empty', { text: '暂无记录。' })); return; }
    var mySeat = mySeatOf(ctx);
    items.forEach(function (it) { container.appendChild(feedNode(it, mySeat, ctx)); });
  }

  function renderChatItems(ctx, container) {
    var chats = (ctx.st.chats || []).slice(-80);
    var mySeat = mySeatOf(ctx);
    if (!chats.length) { container.appendChild(el('div.room-log-empty', { text: '还没有人说话。' })); return; }
    chats.forEach(function (c) {
      container.appendChild(feedNode({ kind: 'chat', seat: c.seat, nickname: c.nickname, text: c.text, at: c.at }, mySeat, ctx));
    });
  }

  function kpGameLog(ctx) {
    if (!M) boot();
    var wrap = el('div.kp-glog');
    wrap.appendChild(panelTabs([
      { key: 'all', label: '全部' },
      { key: 'kp', label: '主持人' },
      { key: 'player', label: '玩家' }
    ], UI_STATE.logTab, function (k) { UI_STATE.logTab = k; rerender(ctx); }));
    var body = scrollBox('room-log', []);
    var tab = UI_STATE.logTab;
    renderLogItems(ctx, body, function (it) {
      var r = seatRole(ctx, it.seat);
      if (tab === 'kp') return r === 'kp' || r === 'sys';
      if (tab === 'player') return r === 'player';
      return true;
    });
    wrap.appendChild(body);
    return wrap;
  }

  /* ============================================================
   * KP 页 · 聊天
   * ============================================================ */

  function chatInput(ctx) {
    var isSpec = ctx.role === 'spectator';
    var input = el('input.input', { type: 'text', placeholder: '说点什么…', maxlength: 600, disabled: isSpec });
    function send() {
      var text = M.cleanText(input.value, 600);
      if (!text) return;
      ctx.intent(M.INTENT.CHAT, { text: text });
      input.value = '';
    }
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); send(); } });
    return el('div.chat-input-row', null, [
      input,
      el('button.btn.primary', { text: '发送', disabled: isSpec, onclick: send })
    ]);
  }

  function kpChat(ctx) {
    if (!M) boot();
    var wrap = el('div.kp-chat');
    wrap.appendChild(el('div.card-title', { text: '聊天' }));
    var list = scrollBox('chat-list', []);
    renderChatItems(ctx, list);
    wrap.appendChild(list);
    wrap.appendChild(chatInput(ctx));
    return wrap;
  }

  /* ============================================================
   * KP 页 · 战斗模式面板（战斗列表 / 怪物信息 两 tab + 添加怪物）
   * 列为：顺序 · 名称 · 类型 · HP · 状态 · 行动
   * ============================================================ */

  function kpCombatPanel(ctx) {
    if (!M) boot();
    var wrap = el('div.kp-combat-panel');
    wrap.appendChild(panelTabs([
      { key: 'list', label: '战斗列表' },
      { key: 'info', label: '怪物信息' }
    ], UI_STATE.combatTab, function (k) { UI_STATE.combatTab = k; rerender(ctx); }));

    var c = combatOf(ctx);
    if (!c || !c.order || !c.order.length) {
      var empty = scrollBox(null, []);
      /* v2.1.8（用户第 5 项前半）：删掉这里的「⚔️ 战斗模式」按钮 —— KP 工具栏
         （已含「🛡 战斗模式」入口）再放一个纯属重复；
         文案改为指向工具栏那个按钮，不再指向一个已被删掉的按钮。 */
      empty.appendChild(el('div.tiny.dim', { text: '尚未开始战斗。请在 KP 工具栏点「🛡 战斗模式」选怪后部署。' }));
      wrap.appendChild(empty);
      return wrap;
    }

    var cur = c.order[c.turn || 0] || {};

    if (UI_STATE.combatTab === 'info') {
      var info = scrollBox(null, []);
      var byActor = {}, order = [];
      c.order.forEach(function (s) { if (!byActor[s.actorId]) { byActor[s.actorId] = s; order.push(s.actorId); } });
      order.forEach(function (id) {
        var s = byActor[id], pub = s.public || {};
        info.appendChild(el('div.actor-line' + (s.kind === 'monster' ? '.monster' : ''), null, [
          el('div.grow', null, [
            el('div.nm', { text: s.name || '—' }),
            el('div.tiny.dim', { text: (s.kind === 'pc' ? '玩家角色' : (s.kind === 'monster' ? '怪物' : 'NPC')) +
              (s.totalSlots > 1 ? ' · 每轮 ' + s.totalSlots + ' 次行动' : '') + ' · DEX ' + (pub.dex != null ? pub.dex : '—') }),
            hpBar(s)
          ]),
          el('div', null, [chipFor(pub)])
        ]));
      });
      wrap.appendChild(info);
      return wrap;
    }

    /* 战斗列表（表格：顺序·名称·类型·HP·状态·行动） */
    var list = scrollBox(null, []);
    var table = el('div.table-list');
    table.appendChild(el('div.table-row.head', null, [
      el('div.c.order', { text: '顺序' }),
      el('div.c.nm', { text: '名称' }),
      el('div.c.ty', { text: '类型' }),
      el('div.c.hp', { text: 'HP' }),
      el('div.c.st', { text: '状态' }),
      el('div.c.ac', { text: '行动' })
    ]));
    c.order.forEach(function (slot, i) {
      var pub = slot.public || {};
      var isCur = i === (c.turn || 0);
      table.appendChild(el('div.table-row' + (isCur ? '.cur' : '') + (isDown(slot) ? '.down' : ''), null, [
        el('div.c.order', { text: String(i + 1) + (slot.totalSlots > 1 ? (' (' + slot.slot + '/' + slot.totalSlots + ')') : '') }),
        el('div.c.nm', { text: slot.name || '—' }),
        el('div.c.ty', { text: slot.kind === 'pc' ? 'PC' : (slot.kind === 'monster' ? '怪物' : 'NPC') }),
        el('div.c.hp', { text: pub.hp != null ? (pub.hp + '/' + (pub.hpMax != null ? pub.hpMax : '?')) : '隐藏' }),
        el('div.c.st', { text: isDown(slot) ? '已倒下' : (pub.state || '—') }),
        el('div.c.ac', null, [
          el('button.btn.sm' + (isCur ? '.primary' : '.ghost'), {
            text: '▶', title: '推进到下一个行动',
            onclick: function () { ctx.act({ op: 'combat.next' }); }
          }),
          el('button.btn.sm.ghost', {
            text: '💥', title: '结算伤害',
            onclick: function () { damageSheet(ctx, slot); }
          })
        ])
      ]));
    });
    list.appendChild(table);
    wrap.appendChild(list);

    /* v2.7.0（用户第 1 项）：未参战玩家可一键加入战斗 ——
       v2.6.0 轮次门禁要求玩家有自己的 pc 槽才可发起战斗对抗，没被排进 combat.order
       的玩家将无法对抗；这里让 KP 随时把玩家拉进来，并显式标出「未入战」。 */
    var inCombat = {};
    c.order.forEach(function (s) { if (s && s.kind === 'pc' && s.seat) inCombat[s.seat] = true; });
    var notInCombat = playersOf(ctx).filter(function (m) { return !targetBlocked(m) && !inCombat[m.seat]; });
    if (notInCombat.length) {
      var joinCard = el('div.card', null, [el('div.card-title', { text: '未参战玩家（可加入战斗）' })]);
      notInCombat.forEach(function (m) {
        joinCard.appendChild(el('div.pending-row', null, [
          el('div.grow', null, [
            el('div', { text: (m.charName || m.nickname || '玩家') }),
            el('div.tiny.dim', { text: '未入战 · 不在行动序列中，暂不能发起战斗对抗' })
          ]),
          el('button.btn.sm.primary', {
            text: '＋加入战斗',
            onclick: function () { ctx.act({ op: 'combat.enqueue', seat: m.seat }); }
          })
        ]));
      });
      wrap.appendChild(joinCard);
    }

    /* 底部操作 */
    wrap.appendChild(el('div.btn-group', { style: { marginTop: '8px' } }, [
      el('button.btn.sm.primary.grow', { text: '下一个行动 ▶', onclick: function () { ctx.act({ op: 'combat.next' }); } }),
      el('button.btn.sm.ghost.grow', { text: '＋ 加单位', onclick: function () { addActorSheet(ctx); } }),
      el('button.btn.sm.ghost.grow', {
        text: '结束战斗', onclick: function () {
          global.UI.confirm('结束当前战斗？会回到探索模式。', { okText: '结束战斗' })
            .then(function (ok) { if (ok) ctx.act({ op: 'combat.end' }); });
        }
      })
    ]));
    return wrap;
  }

  /* ============================================================
   * KP 页 · 场景检定面板（+ 自定义检定 / 难度 / 推送给玩家）
   * v2.4.0（用户第 ⑫ 项）：原「检定类型」下拉已删（选项无意义，见下）。
   * ============================================================ */

  function sceneCheckOf(ctx) {
    /* E 线落地后会把场景检定挂在 state 上；这里两种命名都兜底 */
    return ctx.st.sceneCheck || ctx.st.scenecheck || null;
  }

  function kpSceneCheckPanel(ctx) {
    if (!M) boot();
    var wrap = el('div.kp-scene-panel');

    var cur = sceneCheckOf(ctx);
    if (cur) {
      wrap.appendChild(el('div.card-title', { text: '场景检定：' + (cur.title || '') }));
      if (cur.desc) wrap.appendChild(el('div.tiny.dim', { text: cur.desc }));
      var list = scrollBox(null, []);
      var results = cur.results || [];
      (cur.steps || []).forEach(function (s, i) {
        var done = i < (cur.cursor || 0);
        var active = i === (cur.cursor || 0);
        var r = null;
        for (var k = 0; k < results.length; k++) if (results[k].stepId === s.id) r = results[k];
        var mem = s.targetSeat && s.targetSeat !== '*' ? findMember(ctx.st, s.targetSeat) : null;
        var who = s.targetSeat === '*' ? '全体' : (mem ? (mem.charName || mem.nickname) : (s.targetSeat || '—'));
        list.appendChild(el('div.scene-step' + (done ? '.done' : '') + (active ? '.active' : ''), null, [
          el('div.st-title', { text: (i + 1) + '. ' + (s.title || s.skill || '步骤') }),
          el('div.tiny.dim', { text: (s.skill || '') + (s.difficulty ? (' · ' + s.difficulty) : '') + ' · 目标 ' + who }),
          r ? el('div.tiny', { text: (r.ok ? '✅ 成功' : '❌ 失败') +
                (r.damage ? (' · 伤害 ' + r.damage) : '') + (r.note ? (' · ' + r.note) : '') }) : null
        ]));
      });
      wrap.appendChild(list);

      /* 结算当前步：KP 裁定成功等级 → scene.check.step{stepId,seat,level}
         （level 0-4，≥2 成功；前一步结算完 cursor 才推进到下一步） */
      var sidx = cur.cursor || 0;
      var step = (cur.steps || [])[sidx];
      if (step) {
        var box = el('div.card.scene-resolve', null, [
          el('div.card-title', { text: '结算当前步：' + (step.title || step.skill || ('步骤 ' + (sidx + 1))) }),
          el('div.tiny.dim', { text: '由 KP 裁定结果（level 0-4，≥2 成功）。前一步结算完才轮到下一步。' })
        ]);
        var row = el('div.btn-group', { style: { marginTop: '8px', flexWrap: 'wrap' } });
        /* v2.3.0（用户第 7 项）：补「大成功」档，并把「大失败」改发 LEVEL.FUMBLE(-1)
           （此前 0 会被 sceneStepResolve 归一成 FAIL，规则书语义缺失）。 */
        [['🌟 大成功', 5], ['💀 大失败', -1], ['❌ 失败', 0], ['✅ 成功', 2], ['⭐ 困难成功', 3], ['🌟 极难成功', 4]].forEach(function (p) {
          row.appendChild(el('button.btn.sm.ghost.grow', {
            text: p[0], onclick: function () {
              ctx.act({ op: 'scene.check.step', stepId: step.id, seat: step.targetSeat || '', level: p[1] });
            }
          }));
        });
        box.appendChild(row);
        wrap.appendChild(box);
      } else if ((cur.steps || []).length) {
        wrap.appendChild(el('div.tiny.dim', { text: '✅ 场景检定已完成。' }));
      }
    } else {
      wrap.appendChild(el('div.card-title', { text: '场景检定' }));
      wrap.appendChild(el('div.tiny.dim', { text: '还没有进行中的场景检定。' }));
    }

    /* 自定义检定（快速推送） */
    /* v2.7.0（用户第 3 项）：快速检定目标不列出已撕卡（死亡 / 永久疯狂）的角色。 */
    var players = playersOf(ctx).filter(function (m) { return !targetBlocked(m); });
    var targetSel = selectCtl(
      [{ value: '*', label: '全体玩家' }].concat(players.map(function (m) {
        return { value: m.seat, label: m.charName || m.nickname || '玩家' };
      })), '*', null);
    var skillI = el('input.input', { type: 'text', placeholder: '技能 / 属性，如：侦查 / 敏捷', maxlength: 20 });
    /* v2.4.0（用户第 ⑫ 项）：删掉「检定类型」下拉（技能检定 / 属性检定）——
       用户实测「无论选哪个都能让玩家正确检定，选项无意义」：该下拉只影响
       desc 前缀文案，协议里没有 type 字段（check.request 只带 skill/difficulty），
       删掉不破坏 sceneCheckStep / sceneStepResolve（步骤数据本就无 type）。 */
    var diffSel = selectCtl([
      { value: 'REGULAR', label: '常规' },
      { value: 'HARD', label: '困难（÷2）' },
      { value: 'EXTREME', label: '极难（÷5）' }
    ], 'REGULAR', null);

    var quick = el('div.card', null, [
      el('div.card-title', { text: '自定义检定' }),
      el('div.field', null, [el('label', { text: '目标' }), targetSel]),
      el('div.field', null, [el('label', { text: '检定内容' }), skillI]),
      el('div.field', null, [el('label', { text: '难度' }), diffSel]),
      el('button.btn.primary.block', {
        text: '推送给玩家', style: { marginTop: '10px' },
        onclick: function () {
          var skill = M.cleanText(skillI.value, 20);
          if (!skill) { global.UI.toast('请填写技能/属性', 'err'); return; }
          ctx.act({ op: 'check.request', seat: targetSel.value, skill: skill,
                    difficulty: diffSel.value, desc: skill });
          global.UI.toast('已推送检定', 'ok');
        }
      })
    ]);
    wrap.appendChild(quick);

    wrap.appendChild(el('button.btn.ghost.block', {
      text: '🧩 打开场景检定编辑器（多步骤 / 分支）', style: { marginTop: '8px' },
      onclick: function () { sceneCheckSheet(ctx); }
    }));
    return wrap;
  }

  /* ============================================================
   * KP 页 · 右侧玩家列表（头像 / 名字 / HP / MP / 手绘板）
   * ============================================================ */

  function boardInfo(ctx, seat) {
    var boards = ((ctx.st.scene || {}).boards) || {};
    return boards[seat] || {};
  }

  function kpPlayerList(ctx) {
    if (!M) boot();
    var wrap = el('div.kp-player-list');
    wrap.appendChild(el('div.card-title', { text: '玩家' }));
    var players = playersOf(ctx);
    if (!players.length) {
      wrap.appendChild(el('div.tiny.dim', { text: '还没有玩家加入。' }));
      return wrap;
    }
    var list = scrollBox(null, []);
    players.forEach(function (m) {
      var s = memberStats(m);
      var bi = boardInfo(ctx, m.seat);
      list.appendChild(el('div.player-row' + (m.online ? '' : '.off'), null, [
        avatarEl(m),
        el('div.grow', null, [
          el('div.nm', { text: m.charName || m.nickname || '玩家' }),
          statBar('HP', s.hp, s.hpMax, 'hp'),
          statBar('MP', s.mp, s.mpMax, 'mp'),
          /* v2.8.0（用户第 5 项）：KP 视角玩家信息栏补「当前 SAN / 最大 SAN」显示（形如 SAN 40 / 60）。
             复用 memberStats 的 s.san / s.sanMax 与既有 statBar.san 配色（.stat-bar.row.san）。 */
          statBar('SAN', s.san, s.sanMax, 'san')
        ]),
        el('div.board-cell', null, [
          bi.thumb ? el('img.mini-thumb', { src: bi.thumb, alt: '' })
                   : el('div.mini-thumb.ph', { text: '🎨' }),
          el('button.btn.sm.ghost', {
            text: '手绘板',
            onclick: function () { viewBoardSheet(ctx, m); }
          })
        ])
      ]));
    });
    wrap.appendChild(list);
    return wrap;
  }

  /**
   * v2.5.0（用户第 8 项）：KP 点玩家状态面板旁的「手绘板」→ **全屏只读查看**该玩家手绘板。
   *
   * 旧实现（`UI.sheet` 里塞缩略图）为什么永远看不到内容：
   *   它渲染的是 `boards[seat].thumb`，而 **thumb 从来没人产出过** ——
   *   `Host.boardSelf`（room-model.js）emit 的载荷是 `{seat, self:true, strokes, at}`，
   *   没有 thumb；reduce 里给别人存 `{at, count, thumb: p.thumb||''}` → thumb 恒为空串
   *   → KP 永远只看到 🎨 占位 + 笔数。
   *
   * 真正的正文在**权威端本地** `host._boardBySeat[seat].strokes`。按「正文只回本人」
   * 的既有约定它**不下发给其他玩家**，但 **KP 就是本机权威端**，直接读即可 ——
   * **协议零改动**，也不破坏「玩家之间互相看不到手绘板内容」。
   *
   * 读不到（玩家没画过 / 本局不是本机开的 / 权威端副本为空）→ 回落到「共 N 笔」提示。
   * 只读：不挂任何绘制/擦除手势。
   *
   * @param {object} ctx 面板上下文（ctx.host 为权威端实例）
   * @param {object} m   成员（playersOf 里的一条）
   */
  function viewBoardSheet(ctx, m) {
    var seat = (m && m.seat) || '';
    var who = (m && (m.charName || m.nickname)) || '玩家';
    var rec = (ctx.host && ctx.host._boardBySeat) ? (ctx.host._boardBySeat[seat] || null) : null;
    var strokes = (rec && rec.strokes) || [];
    var info = boardInfo(ctx, seat);

    var ov = el('div.gp-fs.gp-fs--board');
    /** 退出全屏：点「← 返回」或点覆盖层空白处（与全屏信息流交互一致）。 */
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    var head = el('div.gp-fs-head', null, [
      el('span.gp-region-head-t', { text: '🎨 ' + who + ' 的手绘板' }),
      el('button.btn.primary', { text: '← 返回', onclick: function () { close(); } })
    ]);
    var bodyEl = el('div.gp-fs-body');
    if (strokes.length) {
      var stage = el('div.map-stage.board-stage');
      stage.appendChild(strokesSvg(strokes, 'position:absolute;inset:0;width:100%;height:100%'));
      bodyEl.appendChild(stage);
      bodyEl.appendChild(el('div.tiny.dim', { style: { marginTop: '6px' },
        text: '共 ' + strokes.length + ' 笔 · 只读（正文只回本人，KP 看的是本机权威副本）' }));
    } else {
      bodyEl.appendChild(el('div.tiny.dim', {
        text: (info.count ? ('共 ' + info.count + ' 笔') : '这位玩家还没画过') +
              ' · 本机没有这份手绘板的正文（玩家还没提交，或本局不是本机开的）。'
      }));
    }
    ov.appendChild(head);
    ov.appendChild(bodyEl);
    ov.addEventListener('click', function (ev) {
      if (ev.target === ov || ev.target === bodyEl) close();
    });
    document.body.appendChild(ov);
  }

  /* v2.9.0（用户第 3 项）：删除死代码「KP 快捷操作行」面板（经复核：全仓仅存在于 export，
     无任何调用点；android 壳为独立副本、不在本仓同步范围）。
     其唯一有价值的入口「✉️ 邀请加入」已补进 kpPanel 工具面板（inviteForRoom 保留复用）；
     「🩹 修改状态」由 kpPanel 的 stateRequestCard / stateRequestSheet 承载。 */

  function pickPlayerToEdit(ctx) {
    /* v2.7.0（用户第 3 项）：**唯一刻意的不封入口 —— 状态管理**。
       pickPlayerToEdit 与 stateRequestCard 最终都走 op `state.request`；它是 KP
       「修正 / 复活被误判死亡角色」的唯一出口，故已撕卡（死亡 / 永久疯狂）的角色
       在此**仍然列出、可选**。除状态管理外，其余 KP 定向指令一律不可选死亡角色。 */
    var players = playersOf(ctx);
    if (!players.length) { global.UI.toast('还没有玩家', 'err'); return; }
    var body = el('div');
    var api = global.UI.sheet({ title: '修改玩家状态', body: body });
    players.forEach(function (m) {
      body.appendChild(el('div.actor-line', { onclick: function () { api.close(); stateRequestSheet(ctx, m); } }, [
        el('div.grow', null, [el('div.nm', { text: m.charName || m.nickname || '玩家' })])
      ]));
    });
  }

  /* ============================================================
   * v2.1.0 #11：KP 定向指令（指定玩家 + 直接推送 + 无需玩家同意）
   *   冻结接口（team-lead）：op 名与 payload 字段名不得改。
   *   ⚠️ 必须**强制选人**：用户明确「KP 没有角色参与到游戏」，这些是给玩家的变化，
   *      不是 KP 自己检定 —— 未选人时只提示，绝不退化成自掷 / 自改。
   * ============================================================ */

  /** 目标显示名（seat === '*' 表示「全部在线玩家」）。 */
  function targetName(m) {
    if (!m) return '玩家';
    if (m.seat === '*') return '全部在线玩家';
    return m.charName || m.nickname || '玩家';
  }

  /** 校验 SAN 损失的一侧（纯数字或骰式）；非法返回 false。
   *  只做「能不能解析」的判断，真正的骰式语义仍交给规则服务（UI 不复算）。 */
  function validLossSide(s) {
    var t = String(s == null ? '' : s).trim();
    if (!t) return false;
    if (/^\d+$/.test(t)) return true;
    if (!R) boot();
    if (R && typeof R.parseExpr === 'function') return !!R.parseExpr(t).ok;
    return /^\d*[dD]\d+$/.test(t);
  }

  /** 选一个目标玩家（强制）；无玩家 → 只提示，不产生任何 intent。
   *  v2.1.1：顶部新增「👥 全部玩家」—— 选它则对**全部在线玩家**生效；
   *  四种指令（伤害 / SAN / 临时状态 / 物品）都支持，且每个目标**各自独立结算**。 */
  function pickTargetPlayer(ctx, title, onPick, opts) {
    opts = opts || {};
    var players = playersOf(ctx);
    /* v2.5.1（用户第 2 项·补强）：opts.skip(m) 为真的玩家**直接从选人列表里剔除**。
       首次实现是「选完才 toast 拒绝」，KP 的体感仍是「能选到、能开表单」；
       改为不列出后才真正符合「不能对疯狂发作中的角色做 SAN 检定」。 */
    if (opts.skip) players = players.filter(function (m) { return !opts.skip(m); });
    if (!players.length) { global.UI.toast(opts.emptyHint || '房间里还没有玩家', 'err'); return; }
    var body = el('div');
    var api = global.UI.sheet({ title: title, body: body });
    body.appendChild(el('div.tiny.dim', {
      text: '选一个生效目标（必须选，不会默认作用于自己）。「全部玩家」对全部在线玩家生效。'
    }));
    /* 「全部玩家」置顶，和具体玩家在视觉上区分开（带 👥 图标） */
    body.appendChild(el('div.actor-line', {
      onclick: function () { api.close(); onPick({ seat: '*', all: true }); }
    }, [
      el('div.grow', null, [
        el('div.nm', { text: '👥 全部玩家' }),
        el('div.tiny.dim', { text: '对全部在线玩家生效（每人各自独立结算）' })
      ])
    ]));
    players.forEach(function (m) {
      body.appendChild(el('div.actor-line', { onclick: function () { api.close(); onPick(m); } }, [
        el('div.grow', null, [
          el('div.nm', { text: m.charName || m.nickname || '玩家' }),
          el('div.tiny.dim', { text: 'HP ' + memberHpText(m) + ' · SAN ' + memberSanText(m) })
        ])
      ]));
    });
  }

  function memberSanText(m) {
    var r = (m && m.runtime) || {}, s = (m && m.sheet && m.sheet.status) || {};
    var v = (r.san != null) ? r.san : (s.currentSAN != null ? s.currentSAN : null);
    return (v == null) ? '—' : String(v);
  }
  function memberHpText(m) {
    var r = (m && m.runtime) || {}, s = (m && m.sheet && m.sheet.status) || {};
    var v = (r.hp != null) ? r.hp : (s.currentHP != null ? s.currentHP : null);
    return (v == null) ? '—' : String(v);
  }

  /** KP 定向：造成伤害 → sheet.damage { seat, amount, kind }
   *  seat === '*' → 对全部在线玩家各自独立扣血（模型侧展开）。 */
  function dmgForPlayer(ctx) {
    pickTargetPlayer(ctx, '造成伤害 — 选择玩家', function (m) {
      var all = (m.seat === '*');
      var amtI = el('input.input', { type: 'text', placeholder: '伤害值，如 3', value: '1', maxlength: 5 });
      var kindI = el('input.input', { type: 'text', placeholder: '类型（可空），如 物理 / 火焰', maxlength: 20 });
      var body = el('div', null, [
        el('div.tiny.dim', { text: '目标：' + targetName(m) + (all ? '（将对全部在线玩家生效）' : '') }),
        el('div.field', { style: { marginTop: '8px' } }, [el('label', { text: '伤害值' }), amtI]),
        el('div.field', { style: { marginTop: '8px' } }, [el('label', { text: '类型' }), kindI]),
        el('button.btn.primary.block', {
          text: all ? '确定对全部玩家扣血' : '确定扣血', style: { marginTop: '12px' },
          onclick: function () {
            var amt = parseInt(amtI.value, 10) || 0;
            if (amt <= 0) { global.UI.toast('伤害值必须大于 0', 'err'); return; }
            ctx.act({ op: 'sheet.damage', seat: m.seat,
                      amount: amt,
                      kind: M.cleanText(kindI.value, 20) });
            api.close();
          }
        })
      ]);
      var api = global.UI.sheet({ title: '造成伤害', body: body });
    }, { skip: targetBlocked,
         emptyHint: '没有可造成伤害的玩家（已死亡/永久疯狂的角色不列出）' });
  }

  /** KP 定向：临时状态 → sheet.tempstatus { seat, text }
   *  seat === '*' → 对全部在线玩家各自追加（模型侧展开）。 */
  function tempForPlayer(ctx) {
    pickTargetPlayer(ctx, '临时状态 — 选择玩家', function (m) {
      var all = (m.seat === '*');
      var tI = el('input.input', { type: 'text', placeholder: '如：中毒 3 轮 / 流血', maxlength: 60 });
      var body = el('div', null, [
        el('div.tiny.dim', { text: '目标：' + targetName(m) + (all ? '（将对全部在线玩家生效）' : '') }),
        el('div.field', { style: { marginTop: '8px' } }, [el('label', { text: '状态' }), tI]),
        el('button.btn.primary.block', {
          text: all ? '推送给全部玩家' : '推送给该玩家', style: { marginTop: '12px' },
          onclick: function () {
            var t = M.cleanText(tI.value, 60);
            if (!t) { global.UI.toast('请填写状态', 'err'); return; }
            ctx.act({ op: 'sheet.tempstatus', seat: m.seat, text: t });
            api.close();
          }
        })
      ]);
      var api = global.UI.sheet({ title: '临时状态', body: body });
    }, { skip: targetBlocked,
         emptyHint: '没有可施加临时状态的玩家（已死亡/永久疯狂的角色不列出）' });
  }

  /** KP 定向：给物品 → sheet.item { seat, name, qty, note }
   *  seat === '*' → 对全部在线玩家各自追加（模型侧展开）。 */
  function itemForPlayer(ctx) {
    pickTargetPlayer(ctx, '给物品 — 选择玩家', function (m) {
      var all = (m.seat === '*');
      var nI = el('input.input', { type: 'text', placeholder: '物品名，如 手电筒', maxlength: 40 });
      var qI = el('input.input', { type: 'text', placeholder: '数量，如 1', value: '1', maxlength: 5 });
      var noteI = el('input.input', { type: 'text', placeholder: '备注（可空）', maxlength: 60 });
      var body = el('div', null, [
        el('div.tiny.dim', { text: '目标：' + targetName(m) + (all ? '（将对全部在线玩家生效）' : '') }),
        el('div.field', { style: { marginTop: '8px' } }, [el('label', { text: '名称' }), nI]),
        el('div.field', { style: { marginTop: '8px' } }, [el('label', { text: '数量' }), qI]),
        el('div.field', { style: { marginTop: '8px' } }, [el('label', { text: '备注' }), noteI]),
        el('button.btn.primary.block', {
          text: all ? '给全部玩家' : '给该玩家', style: { marginTop: '12px' },
          onclick: function () {
            var nm = M.cleanText(nI.value, 40);
            if (!nm) { global.UI.toast('请填写物品名', 'err'); return; }
            ctx.act({ op: 'sheet.item', seat: m.seat, name: nm,
                      qty: Math.max(1, parseInt(qI.value, 10) || 1),
                      note: M.cleanText(noteI.value, 60) });
            api.close();
          }
        })
      ]);
      var api = global.UI.sheet({ title: '给物品', body: body });
    }, { skip: targetBlocked,
         emptyHint: '没有可给物品的玩家（已死亡/永久疯狂的角色不列出）' });
  }

  /**
   * v2.5.0（用户第 2 项）：成员是否处于「疯狂发作中」。
   *   与模型侧 room-model#memberMadActive **同一判据**：临时疯狂 / 不定疯狂。
   *   玩家自助版 sanCheckSheet 早就有这条拦截，KP 定向版（sanForPlayer /
   *   sanLossForPlayer）是漏做的 —— 补上后「填完表单才被服务端拒」的问题消失。
   * @param {object} m 成员记录
   * @returns {boolean}
   */
  function isMemberMadActive(m) {
    var mental = (m && m.sheet && m.sheet.mental) || [];
    if (!mental.length) return false;
    /* 「不定疯狂（症状消失）」不算发作中 —— 与模型侧 memberMadActive 同口径：
       它是「症状消退、可正常操作」，且掉 SAN 必须复发（v2.2.2 用户第 6 项），
       拦掉会让复发功能失效。 */
    return mental.indexOf('临时疯狂') >= 0 || mental.indexOf('不定疯狂') >= 0;
  }

  /**
   * v2.6.0（用户第 5 项）：成员是否「已撕卡」—— 死亡 或 永久疯狂。
   *   与模型侧 room-model#memberRipped **同一判据**（sheetSanCheck / sheetSanLoss 开头
   *   就靠它拒绝，故模型层无需改）；缺口在 UI：此前只拦疯狂、漏了死亡。
   *   ⚠️ 判死**只认 `body === '死亡'`**，绝不用 `hp <= 0` —— `hp:0` 在没登记血量的
   *   单位上并不代表死亡（v2.5.0 已踩过这个坑）。
   * @param {object} m 成员记录
   * @returns {boolean}
   */
  function isMemberRippedU(m) {
    var body = (m && m.sheet && m.sheet.status && m.sheet.status.body) || '';
    var mental = (m && m.sheet && m.sheet.mental) || [];
    return body === '死亡' || mental.indexOf('永久疯狂') >= 0;
  }

  /**
   * v2.10.0（R2a）：**身体状态视图合成**（本地等价实现，与模型侧 `bodyView` 同语义）——
   *   `sheet.status.body` 是单值 ∈ {正常, 轻伤, 重伤, 死亡}；「濒死 / 昏迷」是
   *   **独立布尔标记** `dying` / `unconscious`（可叠加，如「重伤 + 昏迷」）。
   *   视图优先级：死亡 > dying(濒死) > unconscious(昏迷) > body 原值。
   *   ⚠️ 不跨模块依赖（先例：本地 `WOUND_BODY`）—— 模型字段名以冻结契约为准；
   *      旧数据（body='昏迷'/'濒死'）自然落到 body 原值分支，兼容退化。
   * @param {object} st sheet.status（可空）
   * @returns {string} 「正常」/「轻伤」/「重伤」/「濒死」/「昏迷」/「死亡」
   */
  function bodyViewOf(st) {
    var s = st || {};
    var b = s.body || '正常';
    if (b === '死亡') return '死亡';
    if (s.dying) return '濒死';
    if (s.unconscious) return '昏迷';
    return b;
  }

  /**
   * v2.8.0（用户第 1 / 2 / 3 项）：**「受重伤组」身体状态** —— 重伤 / 濒死 / 昏迷。
   *   这三个态是一组「不能自行改写/取消」的状态：必须经 KP 治愈（`sheet.healwound`）
   *   或队友施救（`aid.apply`）解除。玩家端状态管理里与之互斥的选项一律置灰，
   *   模型侧 `applyHpChange` / `state.self` 另有一层拒绝兜底（两层都要在）。
   *   v2.10.0（R2a）：改按**视图合成**判（`dying`/`unconscious` 标记也算受重伤组）——
   *   否则「标记置起但 body 仍是正常/轻伤」的角色会被误判为无需治愈。
   * @param {object} m 成员记录
   * @returns {boolean}
   */
  var WOUND_BODY = ['重伤', '濒死', '昏迷'];
  function isMemberWounded(m) {
    return WOUND_BODY.indexOf(bodyViewOf(m && m.sheet && m.sheet.status)) >= 0;
  }

  /**
   * v2.8.0（用户第 6 项）：成员是否处于「昏迷」—— 行动受限（含战斗中跳过其行动轮）。
   *   与「疯狂发作中」的前端前置提示并列：玩家点受限按钮时先给同款 toast 提醒，
   *   权威端另有私密提示兜底。⚠️ 自救（「🩹 治愈伤势」）是被昏迷全局锁刻意放行的例外。
   *   v2.10.0（R2a）：改按**视图合成**判（`unconscious` 标记 = 昏迷；旧数据 body='昏迷' 兼容）。
   *   v2.10.0（用户裁定①）：判据与模型全局锁**对称** —— 昏迷**或濒死**都算行动受限
   *   （模型侧 intent 锁 = `_isUnconscious || _isDying`）—— 否则濒死玩家点受限入口
   *   只会拿到模型私密拒绝、没有前端同款提示。⚠️ 本谓词只驱动**前置提示**，
   *   不挡「🩹 治愈伤势」自救出口（那条走 isMemberWounded，见 selfStateSheet）。
   * @param {object} m 成员记录
   * @returns {boolean}
   */
  function isMemberUnconscious(m) {
    var v = bodyViewOf(m && m.sheet && m.sheet.status);
    return v === '昏迷' || v === '濒死';
  }

  /** v2.6.0（用户第 5 项）：不能做 SAN 相关动作的成员 —— 疯狂发作中 **或** 已撕卡。 */
  function sanBlocked(m) { return isMemberMadActive(m) || isMemberRippedU(m); }

  /**
   * v2.7.0（用户第 3 项）：KP 定向入口的**通用封禁谓词** —— 只封「已撕卡」（死亡 / 永久疯狂）。
   *   与 SAN 类专用的 `sanBlocked` 不同：**疯狂发作中（临时 / 不定）不纳入通用封禁** ——
   *   KP 仍可对发作中的角色施加伤害 / 给物品（剧情需要）；SAN 类动作继续沿用更严的 sanBlocked。
   *   判死只认 `body === '死亡'`（见 isMemberRippedU），绝不用 `hp <= 0`。
   *   ⚠️ **唯一刻意的例外：状态管理（state.request）不封** —— pickPlayerToEdit /
   *   stateRequestCard 两条入口都不过滤（KP 修正 / 复活误判死亡角色的唯一出口）；
   *   其余 KP 定向指令一律不可选已撕卡角色。
   * @param {object} m 成员记录
   * @returns {boolean}
   */
  function targetBlocked(m) { return isMemberRippedU(m); }

  /**
   * v2.11.0（用户第 2 项）：玩家**整体操作锁** —— 与模型全局 intent 锁**同判据**：
   *   昏迷 / 濒死（isMemberUnconscious）**或** 已撕卡（isMemberRippedU）**或**
   *   疯狂发作中（isMemberMadActive）。锁住后玩家不能操作任何东西，
   *   唯一例外是「⏩ 推进 1 轮」（模型 intent 白名单放行 madness.advance）。
   *   昏迷角色点受限按钮时前端先给同款 toast 提醒，权威端另有私密拒绝兜底。
   * @param {object} m 成员记录
   * @returns {boolean}
   */
  function playerOperationLocked(m) {
    return isMemberUnconscious(m) || isMemberRippedU(m) || isMemberMadActive(m);
  }

  /**
   * 从「全部在线玩家」里挑出可施法（未疯狂发作、未撕卡）的人，并汇报被跳过的人数。
   * v2.6.0（用户第 5 项）：同时排除「已撕卡（死亡 / 永久疯狂）」。
   */
  function saneTargets(ctx, what) {
    var pool = playersOf(ctx);
    var mad = pool.filter(isMemberMadActive).length;
    var ripped = pool.filter(function (x) { return !isMemberMadActive(x) && isMemberRippedU(x); }).length;
    if (mad || ripped) {
      var parts = [];
      if (mad) parts.push(mad + ' 名疯狂发作中');
      if (ripped) parts.push(ripped + ' 名已撕卡');
      global.UI.toast('已跳过 ' + parts.join('、') + '的玩家', 'err', 3200);
    }
    var rest = pool.filter(function (x) { return !sanBlocked(x); });
    if (!rest.length && pool.length) {
      global.UI.toast('全部在线玩家都无法' + what + '（疯狂发作中或已撕卡）', 'err', 3600);
    }
    return rest;
  }

  /** KP 定向：SAN Check → sheet.sancheck { seat, okLoss, loss, reason }
   *  目标值 = 该玩家当前 SAN；成功/失败两段损失都由模型侧按规则书解析结算。
   *  seat === '*' → 对全部在线玩家各自独立结算（每人掷自己的 D100）。
   *  okLoss/loss 为新增可选字段，原 loss 字段语义保留（= 失败损失），不破坏冻结接口。 */
  function sanForPlayer(ctx) {
    pickTargetPlayer(ctx, 'SAN Check — 选择玩家', function (m) {
      var all = (m.seat === '*');
      /* v2.5.0（用户第 2 项）：疯狂发作中的角色不能做 SAN Check。
         `seat === '*'` 时不整体失败 —— 跳过发作中的人（模型侧会逐人提示），
         只有「全员都在发作中」时才直接拦下来。 */
      if (all) {
        if (!saneTargets(ctx, '做 SAN Check').length) return;
      } else if (isMemberMadActive(m)) {
        global.UI.toast('「' + targetName(m) + '」正处于疯狂发作中，不能做 SAN Check', 'err', 3600);
        return;
      } else if (isMemberRippedU(m)) {
        /* v2.6.0（用户第 5 项）：已撕卡（死亡 / 永久疯狂）同样不能做 SAN Check。 */
        global.UI.toast('「' + targetName(m) + '」已撕卡（死亡/永久疯狂），不能做 SAN Check', 'err', 3600);
        return;
      }
      var okI = el('input.input', { type: 'text', placeholder: '成功损失，常为 0', value: '0', maxlength: 12 });
      var failI = el('input.input', { type: 'text', placeholder: '失败损失，如 1 或 1D6', value: '1D6', maxlength: 12 });
      var reasonI = el('input.input', { type: 'text', placeholder: '原因（可空）', maxlength: 40 });
      var body = el('div', null, [
        el('div.tiny.dim', { text: '目标：' + targetName(m) + (all ? '（将对全部在线玩家各自独立结算）' : '') +
          (all ? '' : ' · 当前 SAN ' + memberSanText(m) + '（按此值判定，不是 KP 的）') }),
        el('div.field', { style: { marginTop: '8px' } }, [el('label', { text: '成功损失' }), okI]),
        el('div.field', { style: { marginTop: '8px' } }, [el('label', { text: '失败损失' }), failI]),
        el('div.field', { style: { marginTop: '8px' } }, [el('label', { text: '原因' }), reasonI]),
        el('button.btn.primary.block', {
          text: '开掷（权威端）', style: { marginTop: '12px' },
          onclick: function () {
            var ok = M.cleanText(okI.value, 12) || '0';
            var fail = M.cleanText(failI.value, 12) || '1D6';
            if (!validLossSide(ok)) { global.UI.toast('成功损失格式不对（纯数字或骰式，如 0 / 1D3）', 'err'); return; }
            if (!validLossSide(fail)) { global.UI.toast('失败损失格式不对（纯数字或骰式，如 1 / 1D6）', 'err'); return; }
            ctx.act({ op: 'sheet.sancheck', seat: m.seat,
                      okLoss: ok, loss: fail,
                      reason: M.cleanText(reasonI.value, 40) });
            api.close();
          }
        })
      ]);
      var api = global.UI.sheet({ title: 'SAN Check', body: body });
    }, { skip: sanBlocked,
         emptyHint: '没有可做 SAN Check 的玩家（疯狂发作中 / 已撕卡的角色不列出）' });
  }

  /** KP 暗骰（骰子行「暗骰」开关之外的显式入口）→ dice.dark { sides, count, bonus, reason } */
  function darkRollSheet(ctx) {
    var exprI = el('input.input', { type: 'text', placeholder: '骰式，如 1D100 / 2D6', value: '1D100', maxlength: 20 });
    var reasonI = el('input.input', { type: 'text', placeholder: '用途（可空），如 暗投聆听', maxlength: 40 });
    var body = el('div', null, [
      el('div.tiny.dim', { text: '结果只进你的「只给你看的信息」；公共记录只写「KP 暗骰了一次」。' }),
      el('div.field', { style: { marginTop: '8px' } }, [el('label', { text: '骰式' }), exprI]),
      el('div.field', { style: { marginTop: '8px' } }, [el('label', { text: '用途' }), reasonI]),
      el('button.btn.primary.block', {
        text: '掷暗骰', style: { marginTop: '12px' },
        onclick: function () {
          var spec = parseDiceExpr(M.cleanText(exprI.value, 20) || '1D100');
          if (!spec) { global.UI.toast('暗骰暂只支持 NDM 骰式（如 1D100 / 2D6）', 'err'); return; }
          ctx.act({ op: 'dice.dark', sides: spec.sides, count: spec.count, bonus: 0,
                    reason: M.cleanText(reasonI.value, 40) });
          api.close();
        }
      })
    ]);
    var api = global.UI.sheet({ title: '暗骰', body: body });
  }

  /** 定向指令卡（kpPanel 使用；原共用方已于 v2.9.0 删除） */
  function kpDirectivesCard(ctx) {
    var card = el('div.card', null, [el('div.card-title', { text: '定向指令（指定玩家 · 直接生效 · 无需同意）' })]);
    var grid = el('div.tool-grid');
    grid.appendChild(toolBtn('💥 造成伤害', '扣指定玩家的 HP', function () { dmgForPlayer(ctx); }));
    grid.appendChild(toolBtn('🌫 临时状态', '给指定玩家加一条临时状态', function () { tempForPlayer(ctx); }));
    grid.appendChild(toolBtn('🎒 给物品', '给指定玩家一个物品道具', function () { itemForPlayer(ctx); }));
    grid.appendChild(toolBtn('🧠 SAN Check', '按目标当前 SAN 掷 D100', function () { sanForPlayer(ctx); }));
    grid.appendChild(toolBtn('🕶 暗骰', '结果只你看得到（骰子行也有开关）', function () { darkRollSheet(ctx); }));
    /* v2.3.0（用户第 7 项）：SAN 大失败 → 按规则书追加理智损失（KP 一键入口，掷 1D10）。 */
    grid.appendChild(toolBtn('🌀 追加理智损失', 'SAN 大失败后按规则书追加（掷 1D10）', function () { sanLossForPlayer(ctx); }));
    /* v2.1.7（用户第 4 项）：KP 工具「治愈疯狂」—— 指定玩家直接解除其
       「不定疯狂」/「不定疯狂（症状消失）」，无需玩家申请、无需二次确认。
       权威端对 KP 发起的 kp-confirm 动作直接执行（见 room-model _act）。 */
    grid.appendChild(toolBtn('💊 治愈疯狂', '直接解除指定玩家的不定疯狂', function () { cureForPlayer(ctx); }));
    /* v2.8.0（用户第 3 项）：KP 工具「治愈伤势」—— 指定玩家直接解除其「重伤 / 濒死 / 昏迷」，
       与「💊 治愈疯狂」同口径：KP 直接生效、无二次确认。 */
    grid.appendChild(toolBtn('🩹 治愈伤势', '直接解除指定玩家的重伤 / 濒死 / 昏迷', function () { cureWoundForPlayer(ctx); }));
    /* v2.8.0（用户第 4 项）：KP 工具「🚑 急救 / 医学」—— 队友施救入口：
       选施救者 + 选目标（在线玩家 / NPC / 怪物）+ 选技能（急救 / 医学），提交 op `aid.apply`。 */
    grid.appendChild(toolBtn('🚑 急救 / 医学', '队友施救：选施救者/目标/技能，掷急救或医学', function () { aidForPlayer(ctx); }));
    card.appendChild(grid);
    return card;
  }

  /** v2.1.7：KP 治愈指定玩家的不定疯狂（直接生效，无需玩家确认） */
  function cureForPlayer(ctx) {
    pickTargetPlayer(ctx, '治愈疯狂 — 选择玩家', function (m) {
      if (m.all) {
        var players = playersOf(ctx);
        if (!players.length) { global.UI.toast('房间里没有在线玩家', 'err'); return; }
        players.forEach(function (mm) {
          ctx.act({ op: 'madness.cure', seat: mm.seat });
        });
        global.UI.toast('已对全部在线玩家执行治愈（没有该状态的会收到提示）', 'ok', 2800);
        return;
      }
      ctx.act({ op: 'madness.cure', seat: m.seat });
      global.UI.toast('已治愈「' + (m.charName || m.nickname || '玩家') + '」的疯狂状态', 'ok', 2800);
    }, { skip: targetBlocked,
         emptyHint: '没有可治愈疯狂的玩家（已死亡/永久疯狂的角色不列出）' });
  }

  /** v2.8.0（用户第 3 项）：KP 治愈指定玩家的「重伤 / 濒死 / 昏迷」（直接生效，无二次确认）。
   *  模板 = 上方 cureForPlayer：选人器复用 pickTargetPlayer，已撕卡（死亡 / 永久疯狂）不可选。 */
  function cureWoundForPlayer(ctx) {
    pickTargetPlayer(ctx, '治愈伤势 — 选择玩家', function (m) {
      if (m.all) {
        var players = playersOf(ctx).filter(function (x) { return !targetBlocked(x); });
        if (!players.length) { global.UI.toast('房间里没有可救治的在线玩家', 'err'); return; }
        players.forEach(function (mm) { ctx.act({ op: 'sheet.healwound', seat: mm.seat }); });
        global.UI.toast('已对全部在线玩家执行治愈伤势（没有该状态的会收到提示）', 'ok', 2800);
        return;
      }
      if (!isMemberWounded(m)) {
        global.UI.toast('该角色当前没有需要治愈的伤势', 'err'); return;
      }
      ctx.act({ op: 'sheet.healwound', seat: m.seat });
      global.UI.toast('已治愈「' + (m.charName || m.nickname || '玩家') + '」的伤势', 'ok', 2800);
    }, { skip: targetBlocked,
         emptyHint: '没有可治愈伤势的玩家（已死亡/永久疯狂的角色不列出）' });
  }

  /** v2.8.0（用户第 4 项）：KP 工具「🚑 急救 / 医学」—— 队友施救入口。
   *  ✅ payload 冻结：{ op:'aid.apply', seat: 施救者seat, targetSeat, skill: '急救'|'医学' }。
   *  交互取舍：KP 侧「两个选人器串行」太重，改为**表单内两个下拉**（同 genericOpposedSheet 的甲/乙写法）。
   *  ⚠️ 契约收敛（与模型层确认）：`seat` / `targetSeat` **都只能是玩家 seat** —— 模型
   *     aid.apply 用 `roster.get(targetSeat)` 只查成员表，**不吃单位 id**；怪物只有战斗槽 hp、
   *     没有 body / 濒死，急救 / 医学对其无意义（规则口径本就是「队友（其他玩家）施救」）。
   *     故施救者 / 目标池 = 在线玩家 + 未撕卡，均为**纯玩家**。
   *  玩家发起走 ctx.intent（KP 同意流程），KP 发起走 ctx.act（直接生效）。 */
  function aidForPlayer(ctx) {
    if (!M) boot();
    var healers = playersOf(ctx).filter(function (m) { return !targetBlocked(m); });
    if (!healers.length) { global.UI.toast('房间里还没有可施救的玩家', 'err'); return; }
    var healerOpts = healers.map(function (m) {
      return { value: m.seat, label: (m.charName || m.nickname || '玩家') + '（玩家）' };
    });
    /* 目标池 = 纯玩家（在线 + 未撕卡）；value 直接是玩家 seat（模型 roster 只认 seat）。 */
    var targetOpts = healers.map(function (m) {
      return { value: m.seat, label: (m.charName || m.nickname || '玩家') + '（玩家）' };
    });
    var healerSel = selectCtl(healerOpts, healerOpts[0].value, null);
    var targetSel = selectCtl(targetOpts, targetOpts[0].value, null);
    var skillSel = selectCtl([
      { value: '急救', label: '急救（稳定伤势 + 1 点临时 HP）' },
      { value: '医学', label: '医学（脱离濒死 + 1D3 HP）' }
    ], '急救', null);
    var body = el('div', null, [
      el('div.tiny.dim', { text: '施救者掷一次「急救」或「医学」；成功由权威端结算并对目标生效（KP 直接生效，无二次确认）。目标只能是玩家角色。' }),
      el('div.field', { style: { marginTop: '8px' } }, [el('label', { text: '施救者（在线玩家）' }), healerSel]),
      el('div.field', { style: { marginTop: '8px' } }, [el('label', { text: '施救目标（在线玩家）' }), targetSel]),
      el('div.field', { style: { marginTop: '8px' } }, [el('label', { text: '技能' }), skillSel]),
      el('button.btn.primary.block', {
        text: '发起施救', style: { marginTop: '12px' },
        onclick: function () {
          var hv = String(healerSel.value || '');
          var tv = String(targetSel.value || '');
          if (!hv || !tv) { global.UI.toast('请选择施救者与目标', 'err'); return; }
          var skill = String(skillSel.value || '急救');
          if (skill !== '急救' && skill !== '医学') { global.UI.toast('技能只能是「急救」或「医学」', 'err'); return; }
          ctx.act({ op: 'aid.apply', seat: hv, targetSeat: tv, skill: skill });
          global.UI.toast('已发起施救（' + skill + '）', 'ok');
          api.close();
        }
      })
    ]);
    var api = global.UI.sheet({ title: '🚑 急救 / 医学', body: body });
    return api;
  }

  /**
   * v2.11.0（用户第 3 项）：玩家自助「🩺 急救 / 医疗 / 精神分析」入口（底部工具栏）。
   *  · 发起者 = 当前玩家（me.seat）；技能等级走模型权威取值（角色没技能取基础值，
   *    故「没加医疗 / 精神分析」也有基础等级可掷）。
   *  · 确定后**走 KP 审批**（与 aid.apply 现有结构一致）：ctx.intent(ACT, {...})，
   *    并非直接自动生效（用户裁定②）。
   *  · 昏迷 / 濒死 / 疯狂发作中 / 已撕卡 的玩家：按钮本身禁用（playerOperationLocked），进不来。
   *  · 目标池 = 在线玩家剔除「已撕卡」；精神分析**另剔除处于冷却（state.meta.psychoRound
   *    未满 5 回合）** 的角色，可对自己使用（me.seat 始终在池内）。
   *  · UI「医疗」→ 模型技能值「医学」（模型 aid.apply 只认 '急救' / '医学'）。
   */
  function aidPlayerSheet(ctx) {
    if (!M) boot();
    var me = findMe(ctx);
    if (!me) { global.UI.toast('你是旁观者，没有角色卡', 'err'); return; }
    if (playerOperationLocked(me)) {
      global.UI.toast('你当前处于受限状态（昏迷/濒死/疯狂发作中），不能发起施救', 'err', 3600);
      return;
    }
    var meta = (ctx.st && ctx.st.meta) || {};
    var psychoRound = meta.psychoRound || {};
    var curRound = meta.round || 0;

    /* 技能下拉；切换时重建目标池（精神分析要剔除冷却中角色）。 */
    var skillSel = selectCtl([
      { value: '急救', label: '急救（稳定伤势 + 1 点临时 HP）' },
      { value: '医疗', label: '医疗（脱离濒死 + 1D3 HP）' },
      { value: '精神分析', label: '精神分析（治愈临时/不定疯狂 + 清除发作症状 + 回 SAN）' }
    ], '急救', function () { renderTargets(); });

    var targetWrap = el('div.field', { style: { marginTop: '8px' } });
    var targetSel = null;
    function renderTargets() {
      var skill = String(skillSel.value || '急救');
      var pool = playersOf(ctx).filter(function (m) { return !isMemberRippedU(m); });
      if (skill === '精神分析') {
        pool = pool.filter(function (m) {
          var last = psychoRound[m.seat];
          return last == null || (curRound - last) >= 5;
        });
      }
      var opts = pool.map(function (m) {
        return { value: m.seat, label: (m.charName || m.nickname || '玩家') + (m.seat === me.seat ? '（我）' : '') };
      });
      targetWrap.innerHTML = '';
      targetWrap.appendChild(el('label', { text: '施救目标（在线玩家）' }));
      if (!opts.length) {
        targetSel = null;
        targetWrap.appendChild(el('div.tiny.dim', { text: '当前没有符合条件的目标' }));
        return;
      }
      targetSel = selectCtl(opts, opts[0].value, null);
      targetWrap.appendChild(targetSel);
    }
    renderTargets();

    var body = el('div', null, [
      el('div.tiny.dim', { text: '由你（' + (me.charName || me.nickname || '玩家') + '）发起，掷一次对应技能；成功后由 KP 审批并对目标生效。目标只能是在线玩家（含你自己）。精神分析同一目标每 5 回合限一次；检定成功可治愈目标的临时疯狂、不定疯狂，并清除本次发作产生的疯狂症状、恢复 1D3 SAN（角色卡自带的背景/永久疯狂症保留）。' }),
      el('div.field', { style: { marginTop: '8px' } }, [el('label', { text: '技能' }), skillSel]),
      targetWrap,
      el('button.btn.primary.block', {
        text: '提交申请（等 KP 同意）', style: { marginTop: '12px' },
        onclick: function () {
          if (!targetSel) { global.UI.toast('当前没有符合条件的目标', 'err'); return; }
          var tv = String(targetSel.value || '');
          if (!tv) { global.UI.toast('请选择施救目标', 'err'); return; }
          var skill = String(skillSel.value || '急救');
          if (skill === '精神分析') {
            ctx.intent(M.INTENT.ACT, { op: 'aid.psycho', seat: me.seat, targetSeat: tv });
            global.UI.toast('已提交精神分析申请（等 KP 同意）', 'ok');
          } else {
            var modelSkill = (skill === '医疗') ? '医学' : '急救';
            ctx.intent(M.INTENT.ACT, { op: 'aid.apply', seat: me.seat, targetSeat: tv, skill: modelSkill });
            global.UI.toast('已提交' + skill + '施救申请（等 KP 同意）', 'ok');
          }
          api.close();
        }
      })
    ]);
    var api = global.UI.sheet({ title: '🩺 急救 / 医疗 / 精神分析', key: 'aid', body: body });
    return api;
  }

  /** v2.3.0（用户第 7 项）：SAN 大失败 → 按规则书追加理智损失（KP 一键入口，掷 1D10）。 */
  function sanLossForPlayer(ctx) {
    pickTargetPlayer(ctx, '追加理智损失 — 选择玩家', function (m) {
      /* v2.5.0（用户第 2 项）：疯狂发作中的角色不能追加理智损失。
         全量时也**只给**没发作的人发指令（模型侧另有逐人提示兜底）。 */
      if (m.all) {
        var players = saneTargets(ctx, '追加理智损失');
        if (!players.length) { global.UI.toast('房间里没有在线玩家', 'err'); return; }
        players.forEach(function (mm) { ctx.act({ op: 'sheet.sanloss', seat: mm.seat }); });
        global.UI.toast('已对全部在线玩家追加理智损失', 'ok', 2800);
        return;
      }
      if (isMemberMadActive(m)) {
        global.UI.toast('「' + targetName(m) + '」正处于疯狂发作中，不能追加理智损失', 'err', 3600);
        return;
      }
      if (isMemberRippedU(m)) {
        /* v2.6.0（用户第 5 项）：已撕卡（死亡 / 永久疯狂）不能追加理智损失。 */
        global.UI.toast('「' + targetName(m) + '」已撕卡（死亡/永久疯狂），不能追加理智损失', 'err', 3600);
        return;
      }
      ctx.act({ op: 'sheet.sanloss', seat: m.seat });
      global.UI.toast('已对「' + (m.charName || m.nickname || '玩家') + '」追加理智损失（1D10）', 'ok', 2800);
    }, { skip: sanBlocked,
         emptyHint: '没有可追加理智损失的玩家（疯狂发作中 / 已撕卡的角色不列出）' });
  }

  /** v2.3.0（用户第 7 项）：修改房间的检定成败阈值（op=`room.rules`）。
   *  · 大成功：掷出值 ≤ 该值 → 大成功（默认 1）；
   *  · 大失败：掷出值 ≥ 该值 → 大失败（默认 100 = 走规则书动态规则）。 */
  function roomRulesSheet(ctx) {
    if (!M) boot();
    var meta = (ctx.st && ctx.st.meta) || {};
    var critI = el('input.input', { type: 'number', value: (meta.critThreshold == null ? 1 : meta.critThreshold), min: '1', max: '100' });
    var fumI = el('input.input', { type: 'number', value: (meta.fumbleThreshold == null ? 100 : meta.fumbleThreshold), min: '1', max: '100' });
    var body = el('div', null, [
      el('div.tiny.dim', { text: '大成功：掷出值 ≤ 该值即大成功（默认 1，即只有 01）。大失败：掷出值 ≥ 该值即大失败（默认 100；此时低技能值仍按规则书走 96-100）。' }),
      el('div.field', null, [el('label', { text: '大成功阈值（掷出 ≤）' }), critI]),
      el('div.field', null, [el('label', { text: '大失败阈值（掷出 ≥）' }), fumI]),
      el('div.tiny.dim', { text: '改完立即广播，房间内所有检定（掷骰 / 技能 / 属性 / 场景 / 对抗 / SAN / 战斗攻击）当场生效。' }),
      el('button.btn.primary.block', {
        text: '保存并广播', style: { marginTop: '12px' },
        onclick: function () {
          var c = intIn(critI.value, 1, 100);
          if (c === null) { global.UI.toast('大成功阈值需为 1–100 的整数', 'err'); return; }
          var fRaw = String(fumI.value == null ? '' : fumI.value).trim();
          var f = (fRaw === '') ? 100 : intIn(fRaw, 1, 100);
          if (f === null) { global.UI.toast('大失败阈值需为 1–100 的整数', 'err'); return; }
          ctx.act({ op: 'room.rules', critThreshold: c, fumbleThreshold: f });
          global.UI.toast('已更新检定成败阈值', 'ok');
          api.close();
        }
      })
    ]);
    var api = global.UI.sheet({ title: '⚖ 检定成败阈值', body: body });
    return api;
  }

  function inviteForRoom(ctx) {
    var code = (ctx.st.meta || {}).code || '';
    var link = '';
    try {
      if (global.RoomNet && global.RoomNet.base) link = M.inviteLink(global.location.href.split('?')[0], code, global.RoomNet.base());
    } catch (e) { link = code; }
    if (global.Share && global.Share.copy) global.Share.copy(link || code);
    else global.UI.toast('邀请链接：' + (link || code), 'ok', 3000);
  }

  /* ============================================================
   * PL 页 · 左角色卡（头像 / 名字 / 职业 / HP·MP·SAN / 四 tab）
   * ============================================================ */

  function charSheetOf(ctx) {
    var me = findMe(ctx);
    return (me && me.sheet) || {};
  }

  /* ============================================================
   * v2.0.2 临时卡（游戏内角色卡）UI 入口
   *
   * 生命周期见 room-store.js。这里只做两件事：
   *   ① 游戏页 PL 角色卡区：提示「本局角色卡（未生效）」+ 「生效到原卡」按钮（二次确认）；
   *   ② 续玩/入口列表：列出本机有临时卡未生效的团，各带一个「生效」按钮。
   * 「生效」= 用临时卡覆盖原卡（原卡不动是默认安全态，必须显式确认）。
   * ============================================================ */

  /** 生效按钮（二次确认 → 覆盖原卡 → 刷新）。供两处入口复用。 */
  function tempCardCommitButton(rec, onDone) {
    /* v2.1.4（用户第 2 项）：**不再永久置灰** —— 游戏还在进行，临时卡上的数值还会继续变，
       玩家随时可以把最新值覆盖回原卡。已生效过就显示「再次生效」。 */
    return el('button.btn.sm' + (rec.committed ? '.ghost' : '.primary'), {
      text: rec.committed ? '再次生效到原卡' : '生效到原卡',
      onclick: function () {
        var RS = global.RoomStore;
        global.UI.confirm(
          '把本局角色卡的改动覆盖到你的原角色卡？\n（原卡会被替换，此操作不可撤销）',
          { okText: '生效', cancelText: '取消' }
        ).then(function (ok) {
          if (!ok) return;                       // 取消 → 原卡不动
          var done = RS && RS.commitTempCard ? RS.commitTempCard(rec.roomCode, rec.charId) : false;
          global.UI.toast(done ? '已生效到原角色卡' : '生效失败', done ? 'ok' : 'err');
          if (onDone) onDone(done);
        });
      }
    });
  }

  /**
   * v2.4.0（用户第 ⑦ 项）：结团时把本机「本房间」的临时卡状态**回写已保存角色卡**。
   *
   * 背景：v2.0.2 起，游戏中的 HP/SAN/疯狂改动只写临时卡、不碰原卡（防污染），
   * 玩家需手动点「生效」。但**结团 = 本局结束**，此时若不再回写，整局的数值变化
   * （掉血、SAN 损失、疯狂、KP 给的物品/临时状态）就随房间一起蒸发 —— 用户实测
   * 明确要求「结团时回写本机已保存角色卡（房间关闭前完成）」。
   *
   * 口径：只结**本房间**的临时卡（roomCode 精确匹配）；本机没有临时卡时全 0（no-op）。
   * 回写用 RoomStore.commitTempCard（upsert 覆盖原卡，幂等可重复）。
   * @returns {{ok: number, fail: number, total: number}}
   */
  function commitRoomTempCards(roomCode) {
    var RS = global.RoomStore;
    var out = { ok: 0, fail: 0, total: 0 };
    if (!RS || typeof RS.listTempCards !== 'function' || !roomCode) return out;
    var recs = [];
    try { recs = RS.listTempCards() || []; } catch (e) { return out; }
    recs.forEach(function (rec) {
      if (!rec || rec.roomCode !== String(roomCode) || !rec.charId) return;
      out.total++;
      var done = false;
      try { done = !!RS.commitTempCard(rec.roomCode, rec.charId); } catch (e) { done = false; }
      if (done) out.ok++; else out.fail++;
    });
    return out;
  }

  /** 游戏页 PL 角色卡区的「本局临时卡」条（存在才显示） */
  function tempCardBar(ctx) {
    var RS = global.RoomStore;
    if (!RS || typeof RS.getTempCard !== 'function') return null;
    var me = findMe(ctx);
    var code = (ctx.st && ctx.st.meta) ? ctx.st.meta.code : '';
    var charId = me && me.charId;
    if (!code || !charId) return null;
    var rec = RS.getTempCard(code, charId);
    if (!rec) return null;
    var s = (rec.card && rec.card.status) || {};
    return el('div.tempcard-bar', null, [
      el('div.sec-title', { text: '本局角色卡（未生效）' }),
      el('div.tiny.dim', { text: '本局对战中的 HP / SAN / 疯狂等改动只记在这张临时卡上；点「生效」才会覆盖你的原角色卡。' }),
      el('div.tiny.dim', { text: 'HP ' + (s.currentHP != null ? s.currentHP : '—') +
                               '　·　SAN ' + (s.currentSAN != null ? s.currentSAN : '—') +
                               '　·　MP ' + (s.currentMP != null ? s.currentMP : '—') }),
      tempCardCommitButton(rec, function () { rerender(ctx); }),
      rec.committed ? el('div.tiny.dim', { style: { marginTop: '4px' },
        text: '已生效 ' + (rec.commitCount || 1) + ' 次' +
              (rec.committedAt ? ('，最近一次：' + timeText(rec.committedAt)) : '') +
              '。游戏中的数值如有变化，可以再点一次覆盖。' }) : null
    ]);
  }

  /** 入口/续玩列表用的「待生效临时卡」区（无则返回 null） */
  function tempCardsSection() {
    var RS = global.RoomStore;
    if (!RS || typeof RS.listTempCards !== 'function') return null;
    var cards = [];
    try { cards = RS.listTempCards() || []; } catch (e) { cards = []; }
    cards = cards.filter(function (r) { return r && !r.committed; });
    if (!cards.length) return null;
    var box = el('div');
    box.appendChild(el('div.sec-title', { text: '本局角色卡待生效（' + cards.length + '）' }));
    cards.forEach(function (rec) {
      var nm = (rec.card && (rec.card.characterName || rec.card.name)) || '角色卡';
      box.appendChild(el('div.actor-line', null, [
        el('div.grow', null, [
          el('div.nm', { text: nm }),
          el('div.tiny.dim', { text: '房间 ' + rec.roomCode +
            (rec.updatedAt ? (' · ' + timeText(rec.updatedAt)) : '') })
        ]),
        tempCardCommitButton(rec, function () { rerender(ctx); })
      ]));
    });
    return box;
  }

  /* v2.13.12（用户需求）：「推进 1 轮」防连点全局锁。
     放在模块作用域：paint 每次重绘都会重建按钮节点，逐节点标记会被重绘冲掉，
     必须用跨重绘持久的模块级标志，才能在「连续点击」时把一次爆发的多条 intent 节流。
     语义 = 冷却时间：点击后置位，_ADVANCE_COOLDOWN ms 内一律拦截重复点击
     （不论其间重绘几次、是否收到权威端回包），把爆发期 N 条 intent 节流成至多 1 次/冷却。 */
  var _advanceBusy = false;
  var _ADVANCE_COOLDOWN = 400;

  function plCharacterCard(ctx) {
    if (!M) boot();
    var wrap = el('div.pl-char-card');
    var me = findMe(ctx);
    if (!me) {
      wrap.appendChild(el('div.tiny.dim', { text: '你是旁观者，没有角色卡。' }));
      return wrap;
    }
    var sh = me.sheet || {};
    var s = memberStats(me);
    /* v2.11.0（用户第 2 项）：整体操作锁 —— 昏迷/濒死/已撕卡/疯狂发作中 禁用一切操作
       （「⏩ 推进 1 轮」除外，模型 intent 白名单放行 madness.advance）。 */
    var opLocked = playerOperationLocked(me);

    wrap.appendChild(el('div.char-head', null, [
      avatarEl(me, 'lg'),
      el('div.grow', null, [
        el('div.char-name', { text: sh.name || me.charName || me.nickname || '调查员' }),
        el('div.tiny.dim', { text: sh.occupation || sh.job || '职业未填' })
      ])
    ]));
    wrap.appendChild(el('div.char-bars', null, [
      statBar('HP', s.hp, s.hpMax, 'hp'),
      statBar('MP', s.mp, s.mpMax, 'mp'),
      statBar('SAN', s.san, s.sanMax, 'san')
    ]));

    /* v2.1.4（用户第 2 项）：**状态管理** —— 玩家自己改 HP/MP/SAN/临时状态/疯狂，
       不需要 KP 同意（用户明确要求）。放在信息卡正下方。
       v2.11.0（用户第 2 项）：昏迷/濒死/已撕卡/疯狂发作中 禁用（整体操作锁，推进 1 轮除外）。 */
    wrap.appendChild(el('button.btn.sm.ghost.block', {
      text: '📝 状态管理（自行修改）', style: { marginTop: '6px' },
      disabled: opLocked,
      onclick: function () {
        if (opLocked) { global.UI.toast('你当前处于受限状态（昏迷/濒死/疯狂发作中），不能修改状态', 'err', 3600); return; }
        selfStateSheet(ctx);
      }
    }));

    /* v2.1.5（用户第 3 项）：推进 1 轮 —— 消除临时/不定疯狂（无需 KP 同意）。
       v2.11.0（用户第 1 项）：文案去掉「（疯狂倒计时）」—— 玩家视角的「推进 1 轮」
       只推进疯狂倒计时（身体恢复仍由 KP 的「推进回合」处理），文案需与实际作用一致。
       v2.11.0（用户第 2 项）：该按钮**不受整体操作锁限制**（昏迷角色也能点，类似疯狂角色判定）。 */
    /* v2.13.12（用户需求）：连续点击「推进 1 轮」会瞬间发出大量 intent、
       触发整面板重绘风暴，在移动端 WebView 上表现为「卡住 / 按钮失灵」。
       加防连点：用模块级 _advanceBusy（跨重绘持久）+ 冷却时间拦截爆发期重复点击，
       冷却期内一律忽略，把一次爆发的 N 条 intent 节流成至多 1 次/冷却。
       disabled 跟随 _advanceBusy（重绘后若仍在冷却则保持禁用，给明确反馈）；
       冷却结束主动解禁当前显示按钮（disabled 是创建期写入的属性，不会自动回弹）。 */
    var advBtn = el('button.btn.sm.ghost.block', {
      text: '⏩ 推进 1 轮', style: { marginTop: '6px' },
      disabled: _advanceBusy,
      onclick: function () {
        if (_advanceBusy) return;
        _advanceBusy = true;
        ctx.intent(M.INTENT.ACT, { op: 'madness.advance' });
        global.UI.toast('已推进 1 轮', 'ok');
        setTimeout(function () {
          _advanceBusy = false;
          var bs = document.querySelectorAll('button');
          for (var i = 0; i < bs.length; i++) {
            if ((bs[i].textContent || '').indexOf('⏩ 推进 1 轮') >= 0) { bs[i].disabled = false; break; }
          }
        }, _ADVANCE_COOLDOWN);
      }
    });
    wrap.appendChild(advBtn);

    /* v2.1.5（用户第 2 项）：撕卡提示 —— 死亡 / 永久疯狂后只能聊天。 */
    var stBody = (sh.status && sh.status.body) || '';
    var mental = sh.mental || [];
    if (stBody === '死亡' || mental.indexOf('永久疯狂') >= 0) {
      wrap.appendChild(el('div.tiny.dim', {
        style: { marginTop: '6px', color: '#c0392b', fontWeight: '600', lineHeight: '1.5' },
        text: '☠ 该角色已' + (stBody === '死亡' ? '死亡' : '永久疯狂') + '（撕卡），只能通过聊天框交流。'
      }));
    }

    /* v2.0.2：本局临时卡（存在才显示）—— 提示改动只在临时卡上，需显式「生效」 */
    var tcBar = tempCardBar(ctx);
    if (tcBar) wrap.appendChild(tcBar);

    /* v2.13.11（用户需求）：删除「人物状态」（属性九宫格 + 主要技能 + 临时状态）
       与「主要技能」内联区块；改为在左栏显示「角色状态」——
       身体状态（bodyViewOf）/ 精神状态（sh.mental）/ 疯狂症状（sh.madness，仅疯狂时显示，含剩余轮数）。
       完整人物卡（技能 / 物品 / 人物卡）仍由工具栏「📋 人物卡」查看。 */
    wrap.appendChild(el('div.sec-title', { style: { marginTop: '8px' }, text: '角色状态' }));
    wrap.appendChild(charVitals(sh));
    return wrap;
  }

  function attrListOf(sh) {
    var attrs = sh.attrs || {};
    return ['str', 'con', 'siz', 'dex', 'app', 'int', 'pow', 'edu', 'luck'].map(function (k) {
      var v = attrs[k];
      return { key: k, label: ATTR_LABELS[k], value: (v == null ? null : Number(v)) };
    });
  }

  function charStatus(sh) {
    var box = el('div.char-status');
    var attrs = attrListOf(sh);
    var hasAttr = attrs.some(function (a) { return a.value != null; });
    if (!hasAttr) {
      box.appendChild(el('div.tiny.dim', { text: '角色卡还没有属性数据（等待角色卡同步）。' }));
    } else {
      attrs.forEach(function (a) {
        var pct = a.value == null ? 0 : (a.key === 'luck' ? a.value : a.value * 5);
        box.appendChild(el('div.attr-row', null, [
          el('span.k', { text: a.label }),
          el('span.val', { text: a.value == null ? '—' : String(a.value) }),
          el('div.bar', null, [el('i', { style: { width: Math.max(0, Math.min(100, pct)) + '%' } })]),
          el('span.pct', { text: (a.value == null ? '—' : (pct + '%')) })
        ]));
      });
    }
    /* 主要技能（前 8 条） */
    var skills = (sh.skills || []).slice(0, 8);
    if (skills.length) {
      box.appendChild(el('div.sec-title', { style: { marginTop: '10px' }, text: '主要技能' }));
      skills.forEach(function (sk) {
        box.appendChild(el('div.skill-row', null, [
          el('span.nm', { text: sk.name }),
          el('span.val', { text: String(sk.total != null ? sk.total : '—') })
        ]));
      });
    }
    /* v2.1.0 #11（用户第 11 项「玩家的角色状态要能应用 KP 的指令」）：KP 定向写入的
       「临时状态」必须**在玩家卡上看得见**（数据对了但界面没跟上 = 功能等于没做）。
       仅在有内容时渲染 —— 空时不留空壳。 */
    var ts = Array.isArray(sh.tempStatus) ? sh.tempStatus : [];
    if (ts.length) {
      box.appendChild(el('div.sec-title', { style: { marginTop: '10px' }, text: '临时状态' }));
      ts.forEach(function (t) {
        var text = (typeof t === 'string') ? t : ((t && t.text) || '');
        var by = (t && t.by) ? (t.by === 'kp' ? 'KP' : String(t.by)) : '';
        var at = (t && t.at) ? timeText(t.at) : '';
        box.appendChild(el('div.tempstatus-row', null, [
          el('div.grow', null, [
            el('div.ts-text', { text: text }),
            (by || at) ? el('div.tiny.dim', { text: [by, at].filter(Boolean).join(' · ') }) : null
          ])
        ]));
      });
    }
    return box;
  }

  /* v2.13.11（用户需求）：玩家左栏「我的角色卡」显示「角色状态」——
     身体状态 / 精神状态 / 疯狂症状（仅在疯狂时显示，含剩余轮数）。
     取代原先的「人物状态」（属性九宫格 + 主要技能 + 临时状态）。 */
  function charVitals(sh) {
    var box = el('div.char-vitals');
    sh = sh || {};

    /* 身体状态：bodyViewOf(sh.status) 返回人类可读字符串；sh.status 结构异常时用 try 兜底。 */
    var bodyView;
    try { bodyView = bodyViewOf(sh.status || {}); } catch (e) { bodyView = ''; }
    if (!bodyView) bodyView = '正常';
    box.appendChild(el('div.profile-row', null, [
      el('span.k', { text: '身体状态' }),
      el('span.v', { text: bodyView })
    ]));

    /* 精神状态：空数组/不存时按「正常」处理。 */
    var mental = (sh.mental && sh.mental.length) ? sh.mental.join('、') : '正常';
    box.appendChild(el('div.profile-row', null, [
      el('span.k', { text: '精神状态' }),
      el('span.v', { text: mental })
    ]));

    /* 疯狂症状：仅在有症状时渲染（满足"疯狂时显示"）。 */
    var madness = Array.isArray(sh.madness) ? sh.madness : [];
    if (madness.length) {
      box.appendChild(el('div.sec-title', { style: { marginTop: '8px' }, text: '疯狂症状' }));
      var mbox = el('div', null);
      madness.forEach(function (x) {
        var label = (x && x.name ? x.name : '未知症状') +
          (x && x.permanent ? '（永久）' : '（还剩 ' + (x && x.rounds || 0) + ' 轮）');
        mbox.appendChild(el('div.tempstatus-row', null, [
          el('span.nm', { text: label })
        ]));
      });
      box.appendChild(mbox);
    }
    return box;
  }

  function charSkills(sh) {
    var box = el('div.char-skills');
    var skills = (sh.skills || []);
    if (!skills.length) { box.appendChild(el('div.tiny.dim', { text: '角色卡还没有技能数据。' })); return box; }
    skills.slice().sort(function (a, b) { return (b.total || 0) - (a.total || 0); }).forEach(function (sk) {
      box.appendChild(el('div.skill-row', null, [
        el('span.nm', { text: sk.name }),
        el('span.val', { text: String(sk.total != null ? sk.total : '—') })
      ]));
    });
    return box;
  }

  function charItems(sh) {
    var box = el('div.char-items');
    /* v2.1.0 #11：`sheet.items` = **KP 定向指令给的物资**（冻结接口 {name, qty, note}），
       与角色卡自带物品**分开**渲染（自带物品在本机 Store 卡上，房间不同步）。 */
    var kpItems = Array.isArray(sh.items) ? sh.items : [];
    var own = localOwnItems();
    if (!kpItems.length && !own.length) {
      box.appendChild(el('div.tiny.dim', { text: '背包里还没有物品。' }));
      return box;
    }
    function rows(list, withNote) {
      list.forEach(function (it) {
        var name = (typeof it === 'string') ? it : ((it && it.name) || '物品');
        var qty = (it && (it.qty != null ? it.qty : it.count));
        var note = (withNote && it && it.note) ? String(it.note) : '';
        box.appendChild(el('div.item-row', null, [
          el('span.nm', { text: name }),
          qty != null ? el('span.qty', { text: '×' + qty }) : null,
          note ? el('span.tiny.dim', { style: { marginLeft: '6px' }, text: note }) : null
        ]));
      });
    }
    if (kpItems.length) {
      box.appendChild(el('div.sec-title', { text: 'KP 给予的物资' }));
      rows(kpItems, true);
    }
    if (own.length) {
      box.appendChild(el('div.sec-title', { style: { marginTop: '10px' }, text: '角色卡自带' }));
      rows(own, false);
    }
    return box;
  }

  /** 本机 Store 卡的自带物品（房间不同步它；取不到就空数组）。 */
  function localOwnItems() {
    try {
      var RU = global.RoomUI;
      var s = (RU && typeof RU._session === 'function') ? RU._session() : null;
      var cid = s && s.boundCharId;
      var c = (cid && global.Store && global.Store.getState) ? global.Store.getState().characters[cid] : null;
      return (c && Array.isArray(c.items)) ? c.items : [];
    } catch (e) { return []; }
  }

  function charProfile(sh) {
    var box = el('div.char-profile');
    var rows = [
      ['姓名', sh.name], ['职业', sh.occupation || sh.job], ['年龄', sh.age],
      ['性别', sh.gender], ['出生地', sh.birthplace], ['居住地', sh.residence]
    ];
    rows.forEach(function (r) {
      if (r[1] == null || r[1] === '') return;
      box.appendChild(el('div.profile-row', null, [el('span.k', { text: r[0] }), el('span.v', { text: String(r[1]) })]));
    });
    if (sh.madness && sh.madness.length) {
      /* v2.1.6（用户第 6 项）：症状带**剩余轮次** —— 「幽闭恐惧症（3 轮）/（永久）」 */
      box.appendChild(el('div.profile-row', null, [el('span.k', { text: '疯狂症状' }),
        el('span.v', { text: sh.madness.map(function (x) {
          /* v2.1.7：背景来源标「（背景症状）」，不再误标「（永久）」 */
          return x.name + (x.permanent ? (x.bg ? '（背景症状）' : '（永久）')
                                        : '（' + (x.rounds || 0) + ' 轮）');
        }).join('、') })]));
    }
    if (sh.mental && sh.mental.length) {
      box.appendChild(el('div.profile-row', null, [el('span.k', { text: '精神状态' }), el('span.v', { text: sh.mental.join('、') })]));
    }
    if (!box.childNodes.length) box.appendChild(el('div.tiny.dim', { text: '还没有人物卡资料。' }));
    return box;
  }

  /* ============================================================
   * PL 页 · 中央地图
   * ============================================================ */

  function plMapArea(ctx) {
    if (!M) boot();
    var wrap = el('div.pl-map-area');
    if (isCombat(ctx)) wrap.appendChild(initiativeBar(ctx));
    var stageWrap = el('div.map-stage-wrap');
    stageWrap.appendChild(mapStage(ctx, false));
    wrap.appendChild(stageWrap);
    var ctrls = el('div.map-ctrls', null, [zoomCtrl(ctx)]);
    ctrls.appendChild(el('button.btn.sm.ghost', { text: '⛶ 全屏', onclick: function () { openFullscreen(ctx); } }));
    wrap.appendChild(ctrls);
    /* v2.1.1（用户第 1 项）：玩家端公开素材区 —— 列出 KP 已公开的全部素材。 */
    var pa = publicAssets(ctx);
    if (pa) wrap.appendChild(pa);
    return wrap;
  }

  /* ============================================================
   * PL 页 · 游戏记录 / 聊天（两 tab 合一）
   * ============================================================ */

  function plFeeds(ctx) {
    if (!M) boot();
    var wrap = el('div.pl-feeds');
    wrap.appendChild(panelTabs([
      { key: 'log', label: '游戏记录' },
      { key: 'chat', label: '聊天' }
    ], UI_STATE.feedTab, function (k) { UI_STATE.feedTab = k; rerender(ctx); }));
    var body = scrollBox('room-log', []);
    if (UI_STATE.feedTab === 'chat') renderChatItems(ctx, body);
    else renderLogItems(ctx, body, null);
    wrap.appendChild(body);
    if (UI_STATE.feedTab === 'chat') wrap.appendChild(chatInput(ctx));
    return wrap;
  }

  /* ============================================================
   * PL 页 · 右队友列表 + 我的手绘板（1/1 翻页）
   * ============================================================ */

  function plTeammates(ctx) {
    if (!M) boot();
    var wrap = el('div.pl-teammates');
    var me = findMe(ctx);
    var players = playersOf(ctx).filter(function (m) { return !me || m.seat !== me.seat; });
    /* v2.13.4（用户第 1/2 项）：队友栏回到右列顶部、紧贴场景检定，且**可收起**。
       旧版空列表时整块隐藏（上一版为给场景检定让高度），玩家带队时就「队友栏不见了」；
       现在永远留一条可收起的标题条，人多了列表内部滚动，不抢场景检定的高度。 */
    var open = (UI_STATE.matesOpen !== false);
    var head = el('button.strip-head', {
      type: 'button',
      title: open ? '点击收起队友栏' : '点击展开队友栏',
      onclick: function () {
        UI_STATE.matesOpen = !open;
        rerender(ctx);
      }
    }, [
      el('span.strip-t', { text: '👥 队友（' + players.length + '）' }),
      el('span.strip-chev', { text: open ? '▾' : '▸' })
    ]);
    wrap.appendChild(head);
    if (!open) {
      /* 收起态只保留标题条；手绘板仍要渲染（它会被 splitSketchIntoOwnBlock 挪去独立块） */
      wrap.appendChild(el('div.card-title', { style: { display: 'none' }, text: '我的手绘板' }));
      wrap.appendChild(miniBoard(ctx));
      return wrap;
    }

    var list = scrollBox('teammate-list', []);
    if (!players.length) {
      list.appendChild(el('div.tiny.dim', { text: '还没有其他队友。' }));
    } else {
      players.forEach(function (m) {
        var s = memberStats(m);
        var bi = boardInfo(ctx, m.seat);
        var sh = m.sheet || {};
        var stt = sh.status || {};
        /* 身体状态用与状态管理同一套合成口径（死亡 > 濒死 > 昏迷 > 重伤/轻伤/正常） */
        var bodyText = bodyViewOf(stt);
        var mental = Array.isArray(sh.mental) ? sh.mental.filter(function (x) { return x && x !== '正常'; }) : [];
        var mentalText = mental.length ? mental.join(' / ') : '正常';
        var bad = bodyText === '死亡' || bodyText === '濒死' || bodyText === '昏迷' ||
                  bodyText === '重伤' || mentalText !== '正常';
        list.appendChild(el('div.player-row.mate-row' + (m.online ? '' : '.off'), null, [
          avatarEl(m),
          el('div.grow', null, [
            /* 用户第 2 项：HP + 当前 SAN（不再显示 MP），身体状态 / 精神状态放名字右边 ——
               一条 104px 高的条里，四行（名字/HP/SAN/标签）放不下，改成三行。 */
            el('div.nm-row', null, [
              el('span.nm', { text: m.charName || m.nickname || '玩家' }),
              el('div.mate-tags' + (bad ? '.bad' : ''), null, [
                el('span.mate-tag', { text: '体 ' + bodyText }),
                el('span.mate-tag', { text: '精 ' + mentalText })
              ])
            ]),
            statBar('HP', s.hp, s.hpMax, 'hp'),
            statBar('SAN', s.san, s.sanMax, 'san')
          ]),
          bi.thumb ? el('img.mini-thumb', { src: bi.thumb, alt: '' })
                   : el('div.mini-thumb.ph', { text: '🎨' })
        ]));
      });
    }
    wrap.appendChild(list);

    /* 我的手绘板（紧凑 + 1/1 翻页） */
    wrap.appendChild(el('div.card-title', { style: { marginTop: '8px' }, text: '我的手绘板' }));
    wrap.appendChild(miniBoard(ctx));
    return wrap;
  }

  function miniBoard(ctx) {
    var box = el('div.mini-board');
    var mine = ((ctx.st.board && ctx.st.board.strokes) || []);
    var color = UI_STATE.tool.color;
    var stage = el('div.map-stage.board-stage');
    stage.appendChild(el('div.map-empty', { text: '按住拖动即可落笔。' }));
    if (mine.length) {
      /* v2.5.0（用户第 8 项）：path 生成统一走 strokesSvg。 */
      stage.appendChild(strokesSvg(mine,
        'position:absolute;inset:0;width:100%;height:100%'));
    }
    stage.classList.add('sketch');
    stage.classList.add('touch-stage');
    /* v2.1.0 缺陷4b：玩家手绘板加橡皮擦 —— boardMode==='erase' 时点击即擦，
       否则照旧拖动落笔。v2.4.0（用户第 ② 项）起与 KP 地图共用 eraseStrokeSegments
       （段级删除：点到线段距离 ≤容差 的段删掉，两侧保留，<3px 碎段丢弃）。
       v2.5.0（用户第 6 项）：改为**划过实时擦除**（bindEraseStage），
       手势末尾一次性走 INTENT.BOARD 整集替换。 */
    if (UI_STATE.boardMode === 'erase') {
      bindEraseStage(stage, mine.slice(), function (keep, base) {
        eraseBoardAt(ctx, keep, base);
      });
    } else {
      /* v2.4.0（用户第 ② 项）：实时绘制 —— 落笔即见笔迹 */
      bindDraw(stage, function (pts) {
        var strokes = mine.slice();
        strokes.push({ color: color, width: 1.4, pts: pts });
        ctx.intent(M.INTENT.BOARD, { strokes: strokes });
      }, { color: color, width: 1.4 });
    }
    box.appendChild(stage);
    box.appendChild(el('div.board-pager', null, [
      el('button.btn.sm.ghost', { text: '‹', onclick: function () { UI_STATE.boardPage = Math.max(0, UI_STATE.boardPage - 1); rerender(ctx); } }),
      el('span.page-no', { text: (UI_STATE.boardPage + 1) + ' / 1' }),
      el('button.btn.sm.ghost', { text: '›', onclick: function () { UI_STATE.boardPage = Math.min(0, UI_STATE.boardPage + 1); rerender(ctx); } }),
      el('button.btn.sm' + (UI_STATE.boardMode === 'erase' ? '.primary' : '.ghost'), {
        text: UI_STATE.boardMode === 'erase' ? '🧽 橡皮' : '✏️ 画笔',
        style: { marginLeft: 'auto' },
        onclick: function () {
          UI_STATE.boardMode = (UI_STATE.boardMode === 'erase' ? 'draw' : 'erase');
          rerender(ctx);
        }
      }),
      el('button.btn.sm.ghost', { text: '清空', onclick: function () {
        global.UI.confirm('清空手绘板上的所有笔迹？', { danger: true, okText: '清空' })
          .then(function (ok) { if (ok) ctx.intent(M.INTENT.BOARD, { strokes: [] }); });
      } })
    ]));
    return box;
  }

  /* ============================================================
   * PL 页 · 底部工具条
   * 人物卡查看 | 大 D100 | D4 D6 D8 D10 | D100修正 | 检定按钮组
   * ============================================================ */

  function plBottomBar(ctx) {
    if (!M) boot();
    var wrap = el('div.pl-bottom-bar');
    var isSpec = ctx.role === 'spectator';
    /* v2.11.0（用户第 2 项）：整体操作锁 —— 昏迷/濒死/已撕卡/疯狂发作中 禁用底部一切操作
       （「⏩ 推进 1 轮」按钮在玩家卡上，不受此锁影响）。 */
    var me0 = findMe(ctx);
    var opLocked = me0 ? playerOperationLocked(me0) : false;

    wrap.appendChild(el('div.bottom-row', null, [
      el('button.btn.sm.ghost', { text: '📋 人物卡', onclick: function () { openCharSheet(ctx); } }),
      el('button.dice-d100', { text: 'D100', disabled: (isSpec || opLocked), onclick: function () { rollPlayerD100(ctx); } }),
      el('div.dice-smalls', null, ['D4', 'D6', 'D8', 'D10'].map(function (d) {
        return el('button.dice-small', { text: d, disabled: (isSpec || opLocked), onclick: function () { doRollExpr(ctx, '1' + d); } });
      }))
    ]));

    wrap.appendChild(d100ModPanel(ctx));

    var tools = el('div.bottom-tools');
    var inCombat = (((ctx.st || {}).meta || {}).mode === 'COMBAT');
    [
      ['🎲 自定义骰子', function () { customDiceSheet(ctx); }],
      /* v2.2.1（用户第 3 项）：战斗对抗 —— 位置「自定义骰子之后、SAN Check 之前」；
         此函数当前未被游戏页挂载（真实入口见 diceBar），这里保持一致文案与战斗门控。 */
      ['⚔ 战斗对抗', function () { playerOpposedSheet(ctx); }, true],
      ['🧠 SAN Check', function () { sanCheckSheet(ctx); }],
      ['🩹 临时状态', function () { tempStateSheet(ctx); }],
      ['🎒 物品道具', function () { itemsSheet(ctx); }],
      ['📖 规则参考', function () { rulesSheet(ctx); }],
      ['🎵 音乐控制台', function () { musicSheet(ctx); }]
      /* v2.11.0：本 plBottomBar 为遗留死代码（0 调用方，真实玩家工具栏见 diceBar）。
         上一版误加的「🩺 急救/医疗/精神分析」按钮已移除，单一事实来源归到 diceBar。
         v2.11.2：再把「⚔️ 战斗检定 / 🎯 技能检定」从这里摘掉 —— 同样只活在死代码里、
         玩家从未见过；「🎯 技能检定」已补进 diceBar 扩展组（见该处注释）。 */
    ].forEach(function (p) {
      var onlyCombat = p[2] === true;
      var disabled = (onlyCombat && !inCombat) || opLocked;
      var onClick;
      if (opLocked) {
        onClick = function () { global.UI.toast('你当前处于受限状态（昏迷/濒死/疯狂发作中），不能操作', 'err', 3600); };
      } else if (onlyCombat && !inCombat) {
        onClick = function () { global.UI.toast('战斗对抗仅在战斗模式可用（请让 KP 先进入战斗）', 'err'); };
      } else {
        onClick = p[1];
      }
      tools.appendChild(el('div.tool' + (disabled ? '.dim' : ''), {
        onclick: onClick
      }, [el('div.t', { text: p[0] })]));
    });
    wrap.appendChild(tools);
    return wrap;
  }

  /** D100 修正面板：奖励骰 −/+ 数值、惩罚骰 −/+ 数值、应用 */
  function d100ModPanel(ctx) {
    var d = UI_STATE.d100Draft;
    var panel = el('div.d100-mod');
    panel.appendChild(el('div.mod-title', { text: 'D100 修正' }));

    function modRow(label, key) {
      var val = el('span.val', { text: String(d[key]) });
      function set(v) { d[key] = Math.max(0, Math.min(5, v)); val.textContent = String(d[key]); }
      return el('div.mod-row', null, [
        el('span.k', { text: label }),
        el('button.sbtn', { text: '−', onclick: function () { set(d[key] - 1); } }),
        val,
        el('button.sbtn', { text: '+', onclick: function () { set(d[key] + 1); } })
      ]);
    }
    panel.appendChild(modRow('奖励骰', 'bonus'));
    panel.appendChild(modRow('惩罚骰', 'penalty'));
    panel.appendChild(el('button.btn.sm.primary', {
      text: '应用',
      onclick: function () {
        UI_STATE.d100Mod = { bonus: d.bonus, penalty: d.penalty };
        global.UI.toast('已应用：奖励 ' + d.bonus + ' / 惩罚 ' + d.penalty, 'ok');
        rerender(ctx);
      }
    }));
    panel.appendChild(el('div.tiny.dim', {
      text: '当前生效：奖励 ' + UI_STATE.d100Mod.bonus + ' / 惩罚 ' + UI_STATE.d100Mod.penalty
    }));
    return panel;
  }

  function rollPlayerD100(ctx) {
    var mod = UI_STATE.d100Mod;
    if (ctx.role === 'kp') { doRoll(ctx, mod.bonus, mod.penalty); return; }
    ctx.intent(M.INTENT.DICE, { expr: '1D100', direct: true, bonus: mod.bonus, penalty: mod.penalty });
    global.UI.toast('掷骰中…', 'ok');
  }

  function openCharSheet(ctx) {
    var me = findMe(ctx);
    var sh = (me && me.sheet) || {};
    var body = el('div', null, [
      charProfile(sh),
      el('div.sec-title', { style: { marginTop: '12px' }, text: '人物状态' }),
      charStatus(sh),
      el('div.sec-title', { style: { marginTop: '12px' }, text: '技能' }),
      charSkills(sh),
      el('div.sec-title', { style: { marginTop: '12px' }, text: '物品' }),
      charItems(sh)
    ]);
    global.UI.sheet({ title: '人物卡', body: body });
  }

  /** 技能检定 / 战斗检定：从角色卡技能里选一个发起检定 */
  function skillCheckSheet(ctx, kind) {
    var me = findMe(ctx);
    var skills = ((me && me.sheet && me.sheet.skills) || []).map(function (s) {
      return { name: s.name, total: s.total };
    });
    var entries = skills.slice();
    if (kind === 'combat') {
      var combatNames = ['格斗', '斗殴', '射击', '闪避', '武术', '刀剑', '枪械', '斧', '矛', '鞭'];
      var filtered = entries.filter(function (e) {
        return combatNames.some(function (n) { return (e.name || '').indexOf(n) >= 0; });
      });
      if (filtered.length) entries = filtered;
    }

    var body = el('div');
    body.appendChild(el('div.tiny.dim', {
      text: kind === 'combat' ? '选择用于战斗的技能（按角色卡技能值检定）。' : '选择技能发起检定（按角色卡技能值检定）。'
    }));
    var api;
    var listWrap = scrollBox(null, []);
    listWrap.style.maxHeight = '46vh';

    if (!entries.length) {
      listWrap.appendChild(el('div.tiny.dim', { text: '角色卡里没有技能数据，可手动输入技能名与目标值。' }));
      var nameI = el('input.input', { type: 'text', placeholder: '技能名' });
      var baseI = el('input.input', { type: 'number', placeholder: '目标值', value: '50' });
      listWrap.appendChild(el('div.field', null, [el('label', { text: '技能' }), nameI]));
      listWrap.appendChild(el('div.field', null, [el('label', { text: '目标值' }), baseI]));
      body.appendChild(listWrap);
      body.appendChild(el('button.btn.primary.block', {
        text: '掷检定', style: { marginTop: '10px' },
        onclick: function () { rollSkill(ctx, nameI.value, +baseI.value || 0); if (api) api.close(); }
      }));
    } else {
      entries.sort(function (a, b) { return (b.total || 0) - (a.total || 0); });
      entries.forEach(function (e) {
        listWrap.appendChild(el('div.skill-row', {
          onclick: function () { rollSkill(ctx, e.name, e.total); if (api) api.close(); }
        }, [el('span.nm', { text: e.name }), el('span.val', { text: String(e.total != null ? e.total : '—') })]));
      });
      body.appendChild(listWrap);
    }
    api = global.UI.sheet({ title: kind === 'combat' ? '战斗检定' : '技能检定',
                            key: kind === 'combat' ? 'combat-check' : 'skill-check', body: body });
    return api;
  }

  function rollSkill(ctx, name, base) {
    var mod = UI_STATE.d100Mod;
    if (ctx.role === 'kp') {
      if (!R) boot();
      var res = R.check({ kind: 'skill', base: base, bonus: mod.bonus, penalty: mod.penalty, label: name });
      ctx.act({ op: 'dice.roll', expr: '1D100', label: name, result: res });
      return;
    }
    ctx.intent(M.INTENT.DICE, { expr: '1D100', direct: true, base: base,
                                bonus: mod.bonus, penalty: mod.penalty, label: name });
    global.UI.toast('掷 ' + (name || '检定') + '…', 'ok');
  }

  /** 玩家自助 SAN Check（v2.1.1 改）：
   *  只发 `INTENT.SAN_CHECK`，**由权威端按规则书结算 + 自动扣 SAN + 经 EVT.STATE 写回卡片**。
   *  ⚠️ 客户端**绝不**自行扣 SAN / 写卡（本地改权威状态 = 与 KP 端不一致，重连就露馅）。
   *  · 成功/失败两段损失都由玩家声明，权威端按掷骰支路取其一（默认 0/1D6）。
   *  · KP 走同一入口时改走「定向 SAN Check」—— KP 自身没有角色卡，让 KP 选目标玩家。 */
  function sanCheckSheet(ctx) {
    if (ctx.role === 'kp') { sanForPlayer(ctx); return; }
    var me0 = findMe(ctx);
    /* v2.1.6（用户疯狂规则 6）：临时/不定疯狂发作中**不能 SAN check** ——
       按钮形同失效：点了只给提醒，不弹表单。 */
    var mMental0 = (me0 && me0.sheet && me0.sheet.mental) || [];
    if (mMental0.indexOf('临时疯狂') >= 0 || mMental0.indexOf('不定疯狂') >= 0) {
      global.UI.toast('疯狂发作中（临时/不定疯狂）不能做 SAN Check —— 先用「推进 1 轮」或治愈', 'err', 3600);
      return;
    }
    /* v2.8.0（用户第 6 项）：昏迷角色行动受限 —— 前端同款前置提示（与上方「疯狂发作中」并列）。
       权威端另有一层私密提示兜底；唯独「🩹 治愈伤势」自救入口不受此限（昏迷锁的刻意例外）。
       v2.10.0（用户裁定①）：判据与模型全局锁对称 —— 昏迷**或濒死**都拦（模型侧 intent 锁 =
       `_isUnconscious || _isDying`），toast 按实际态给同款文案（昏迷原文保留，不回归）。 */
    if (isMemberUnconscious(me0)) {
      global.UI.toast(bodyViewOf(me0 && me0.sheet && me0.sheet.status) === '濒死'
        ? '你正处于濒死，无法行动（需队友急救 / 医学或 KP 治愈伤势）'
        : '你正处于昏迷，无法行动（需队友急救 / 医学或 KP 治愈伤势）', 'err', 3600);
      return;
    }
    var me = findMe(ctx);
    var s = me ? memberStats(me) : { san: null };
    var san = (s.san != null) ? s.san : null;
    var okI = el('input.input', { type: 'text', placeholder: '成功损失，常为 0', value: '0', maxlength: 12 });
    var failI = el('input.input', { type: 'text', placeholder: '失败损失，如 1 或 1D6', value: '1D6', maxlength: 12 });
    var reasonI = el('input.input', { type: 'text', placeholder: '原因（可空），如 目击血腥场面', maxlength: 40 });
    /* v2.13.8（用户报「短时间内多次 SAN Check 卡死」）：提交即禁用按钮。
       慢设备上连点两下会发出两条 intent（权威端各结算一次，还会连锁触发
       疯狂判定）；禁用 + 层即将关闭，双保险防重复提交。 */
    var rollBtn = el('button.btn.primary.block', {
      text: '掷 SAN Check', style: { marginTop: '12px' },
      onclick: function () {
        rollBtn.disabled = true;
        var ok = M.cleanText(okI.value, 12) || '0';
        var fail = M.cleanText(failI.value, 12) || '1D6';
        if (!validLossSide(ok)) { global.UI.toast('成功损失格式不对（纯数字或骰式，如 0 / 1D3）', 'err'); return; }
        if (!validLossSide(fail)) { global.UI.toast('失败损失格式不对（纯数字或骰式，如 1 / 1D6）', 'err'); return; }
        ctx.intent(M.INTENT.SAN_CHECK, { okLoss: ok, loss: fail,
                                          reason: M.cleanText(reasonI.value, 40) });
        global.UI.toast('已提交 SAN Check，等待权威端结算…', 'ok');
        api.close();
      }
    });
    var body = el('div', null, [
      el('div.tiny.dim', {
        text: '按你当前的 SAN（' + (san == null ? '未上报，将交由权威端兜底判定' : san) +
          '）掷 D100 做理智检定。成功/失败各按下面损失，**由权威端结算并自动扣 SAN**。'
      }),
      el('div.field', { style: { marginTop: '8px' } }, [el('label', { text: '成功损失' }), okI]),
      el('div.field', { style: { marginTop: '8px' } }, [el('label', { text: '失败损失' }), failI]),
      el('div.field', { style: { marginTop: '8px' } }, [el('label', { text: '原因' }), reasonI]),
      rollBtn
    ]);
    /* v2.13.8：同名弹层单例（见 components.js sheet 的 key 去重）——
       连点骰子行的「SAN Check」不再叠出一模一样的模态（关掉一层又露出一层，
       用户视角就是卡住）。 */
    var api = global.UI.sheet({ title: 'SAN Check', key: 'san-check', body: body });
    return api;
  }

  function customDiceSheet(ctx) {
    var exprI = el('input.input', { type: 'text', placeholder: '骰式，如 2D6+1D4', maxlength: 40 });
    var body = el('div', null, [
      el('div.field', null, [el('label', { text: '自定义骰子' }), exprI]),
      el('button.btn.primary.block', {
        text: '掷', style: { marginTop: '12px' },
        onclick: function () { doRollExpr(ctx, M.cleanText(exprI.value, 40) || '1D100'); api.close(); }
      })
    ]);
    var api = global.UI.sheet({ title: '自定义骰子', key: 'custom-dice', body: body });
    return api;
  }

  /** 临时状态：以一条聊天提示记录（模型暂无 self 状态编辑动作，避免假入口） */
  function tempStateSheet(ctx) {
    var noteI = el('input.input', { type: 'text', placeholder: '如：中毒 3 轮 / 流血', maxlength: 60 });
    var body = el('div', null, [
      el('div.tiny.dim', { text: '记录一条临时状态（发到聊天，KP 与全桌可见）。' }),
      el('div.field', { style: { marginTop: '8px' } }, [el('label', { text: '状态' }), noteI]),
      el('button.btn.primary.block', {
        text: '记录', style: { marginTop: '12px' },
        onclick: function () {
          var t = M.cleanText(noteI.value, 60);
          if (!t) { global.UI.toast('请填写状态', 'err'); return; }
          ctx.intent(M.INTENT.CHAT, { text: '【临时状态】' + t });
          api.close();
        }
      })
    ]);
    var api = global.UI.sheet({ title: '临时状态', key: 'temp-status', body: body });
    return api;
  }

  /**
   * v2.1.4（用户第 2 项）：**玩家自助状态管理**。
   * 可改：HP / MP / SAN（含上限）、临时状态、疯狂（从车卡系统的疯狂表选，或随机）。
   * 走 op `state.self` —— 免 KP 同意，但只能改自己；结果进游戏记录并同步到本机角色卡。
   */
  function selfStateSheet(ctx) {
    var me = findMe(ctx);
    if (!me) { global.UI.toast('你是旁观者，没有角色卡', 'err'); return; }
    var shSt0 = (me.sheet && me.sheet.status) || {};
    var shMental0 = (me.sheet && me.sheet.mental) || [];
    /* v2.1.6（用户第 7 项）：撕卡 / 疯狂发作中 → 只能「推进 1 轮」，不能改状态 */
    if (shSt0.body === '死亡' || shMental0.indexOf('永久疯狂') >= 0) {
      global.UI.toast('你的角色已撕卡（死亡/永久疯狂），不能再修改状态', 'err'); return;
    }
    if (shMental0.indexOf('临时疯狂') >= 0 || shMental0.indexOf('不定疯狂') >= 0) {
      global.UI.toast('疯狂发作中：只能点「推进 1 轮」倒计时，不能修改状态', 'err'); return;
    }
    var s = memberStats(me);

    function numI(label, v) {
      return el('input.input', { type: 'text', inputmode: 'numeric',
        value: (v == null ? '' : String(v)), placeholder: '不变', maxlength: '6' });
    }
    var hpI = numI('HP', s.hp), hpMaxI = numI('HP上限', s.hpMax);
    var mpI = numI('MP', s.mp), mpMaxI = numI('MP上限', s.mpMax);
    var sanI = numI('SAN', s.san), sanMaxI = numI('SAN上限', s.sanMax);
    var tsI = el('input.input', { type: 'text', placeholder: '如：中毒 3 轮 / 流血', maxlength: '60' });

    /* ---- v2.10.0（R2a）：身体状态（**复选 chips**；点选**立即生效**，不等「保存修改」）----
       形态（与精神状态多选 chip 组同形态）：
         · 正常 / 轻伤 —— 单选互斥（点一个自动取消另一个）；
         · 重伤 / 濒死 / 昏迷 —— 复选可叠加（如「重伤 + 昏迷」）；
         · 死亡 —— 独立 chip + 撕卡二次确认（memberRipped 仍只认 body==='死亡'）。
       模型契约（冻结）：status.body 单值 ∈ {正常,轻伤,重伤,死亡}；dying/unconscious
       为独立布尔标记；视图合成 bodyView = 死亡 > dying > unconscious > body。
       禁用矩阵（Q5）：
         · 处于受重伤组（bodyView ∈ 重伤/濒死/昏迷）：正常/轻伤 禁用；**已勾选**的
           重伤/濒死/昏迷 不可取消勾（模型侧 R2b 同款拒绝）；未勾的可勾（叠加加重）。
         · 昏迷/濒死（全局锁）：整行置灰，仅「死亡」可点。
       每次点选立即发 `state.self`（免 KP 同意）；批量保存不再携带 body/标记（Q3）。 */
    var BODY_OPTS = ['正常', '轻伤', '重伤', '濒死', '昏迷', '死亡'];
    var bodyVal = (me.sheet && me.sheet.status && me.sheet.status.body) || '正常';
    var dyingVal = !!(me.sheet && me.sheet.status && me.sheet.status.dying);
    var uncVal = !!(me.sheet && me.sheet.status && me.sheet.status.unconscious);
    var bodyRow = el('div.btn-group', { style: { flexWrap: 'wrap', gap: '4px' } });
    var bodyHint = el('div.tiny', { style: { marginTop: '4px' } });
    /* 某个 chip 当前是否处于「勾选」态（按本地状态实时判） */
    function bodyChecked(o) {
      if (o === '正常') return bodyVal === '正常' && !dyingVal && !uncVal;
      if (o === '轻伤') return bodyVal === '轻伤' && !dyingVal && !uncVal;
      if (o === '重伤') return bodyVal === '重伤';
      if (o === '濒死') return dyingVal;
      if (o === '昏迷') return uncVal;
      return bodyVal === '死亡';
    }
    /* 合成文案：「重伤 + 昏迷」—— toast / reason 共用 */
    function bodyText() {
      if (bodyVal === '死亡') return '死亡';
      var parts = [];
      if (bodyVal === '重伤') parts.push('重伤');
      if (dyingVal) parts.push('濒死');
      if (uncVal) parts.push('昏迷');
      return parts.length ? parts.join(' + ') : bodyVal;
    }
    /* v2.10.0（R2a）：每次点选**立即发 op**（不等保存）—— 成功即生效；
       被拒时玩家会收到权威端私密提示（A 修 R4 后只进自己栏目）。 */
    function sendBodyStatus(patch, note) {
      ctx.intent(M.INTENT.ACT, {
        op: 'state.self', status: patch,
        reason: '自行设置身体状态：' + note
      });
      global.UI.toast('已将身体状态设为：' + note, 'ok');
    }
    /* 重画整行 chips（点选后本地状态会变 → 禁用矩阵随之变，必须重建） */
    function paintBody() {
      /* bodyVal0 = **当前**视图合成值（死亡 > dying > unconscious > body） */
      var bodyVal0 = bodyViewOf({ body: bodyVal, dying: dyingVal, unconscious: uncVal });
      var globalLocked = (bodyVal0 === '濒死' || bodyVal0 === '昏迷');
      var curBodyLocked = WOUND_BODY.indexOf(bodyVal0) >= 0;
      bodyRow.innerHTML = '';
      BODY_OPTS.forEach(function (o) {
        var locked = curBodyLocked && (o !== '死亡');
        /* 受重伤组里**未勾选**的重伤/濒死/昏迷 允许「叠加加重」→ 放行；
           （全局锁下不放行 —— 整行置灰，仅「死亡」可点。） */
        if (locked && !globalLocked && WOUND_BODY.indexOf(o) >= 0 && !bodyChecked(o)) locked = false;
        var b = el('button.chip' + (bodyChecked(o) ? '.on' : '') + (locked ? '.dim' : ''), {
          text: o, 'data-v': o,
          /* 置灰走内联样式（不改 app.css）+ 复用既有的 .dim 类，零 CSS 回归。
             ⚠️ 刻意不用原生 disabled：置灰项点击要能弹引导 toast（Q5 禁用矩阵）。 */
          style: locked ? { opacity: '0.45', cursor: 'not-allowed', filter: 'grayscale(.35)' } : null,
          title: locked ? ('当前处于「' + bodyVal0 + '」，不能自行改写身体状态') : '',
          onclick: function () {
            if (locked) {
              global.UI.toast(globalLocked
                ? '角色昏迷/濒死中，无法自行操作身体状态；可申请治愈伤势或请队友施救'
                : ('当前处于「' + bodyVal0 + '」，不能自行取消该状态 —— 请用「🩹 治愈伤势（需 KP 同意）」或请 KP / 队友施救'),
                'warn', 3600);
              return;
            }
            function apply() {
              if (o === '正常' || o === '轻伤') {
                /* 单选互斥：本体归位 + 两个标记清零 */
                bodyVal = o; dyingVal = false; uncVal = false;
                sendBodyStatus({ body: o }, bodyText());
              } else if (o === '重伤') {
                bodyVal = '重伤';
                sendBodyStatus({ body: '重伤' }, bodyText());
              } else if (o === '濒死') {
                dyingVal = true;
                /* 规则因果链：濒死必然伴随重伤 —— 未勾则自动勾上 */
                if (bodyVal !== '重伤') {
                  bodyVal = '重伤';
                  global.UI.toast('濒死必然伴随重伤，已自动勾上「重伤」', 'ok', 2600);
                }
                sendBodyStatus({ body: '重伤', dying: true }, bodyText());
              } else if (o === '昏迷') {
                uncVal = true;
                sendBodyStatus({ unconscious: true }, bodyText());
              } else if (o === '死亡') {
                bodyVal = '死亡'; dyingVal = false; uncVal = false;
                sendBodyStatus({ body: '死亡' }, '死亡');
              }
              paintBody();
              if (o === '死亡') global.UI.closeAllSheets();
            }
            if (o === '死亡') {
              global.UI.confirm('⚠️ 标记「死亡」后，你的角色会被**撕卡**（不可再用，只能聊天）。\n确认标记为死亡？',
                { danger: true, okText: '确认' }).then(function (ok) { if (ok) apply(); });
            } else { apply(); }
          }
        });
        bodyRow.appendChild(b);
      });
      /* v2.8.0（用户第 1 项）：锁死时给一条明确说明（玩家一眼知道为什么点不动 + 怎么解除）。 */
      bodyHint.textContent = curBodyLocked
        ? ('当前处于「' + bodyVal0 + '」：需 KP 治愈或队友施救，不能自行改写 / 取消身体状态。')
        : '';
    }
    paintBody();
    var bodyField = el('div.field', { style: { marginTop: '8px' } },
      [el('label', { text: '身体状态' }), bodyRow, bodyHint]);

    /* ---- v2.1.5（用户第 4 项）：精神状态（多选；「永久疯狂」互斥 + 撕卡需二次确认） ---- */
    /* v2.1.7：「不定疯狂（症状消失）」—— 发作症状随推进轮次消退后由权威端
       自动切换；可正常操作，但状态只能通过「治愈」取消。 */
    var MENTAL_OPTS = ['正常', '临时疯狂', '不定疯狂', '不定疯狂（症状消失）', '疯狂症状', '永久疯狂'];
    var mentalVals = (me.sheet && Array.isArray(me.sheet.mental)) ? me.sheet.mental.slice() : ['正常'];
    var mentalRow = el('div.btn-group', { style: { flexWrap: 'wrap', gap: '4px' } });
    function paintMental() {
      Array.prototype.forEach.call(mentalRow.children, function (c) {
        var t = c.getAttribute && c.getAttribute('data-v');
        if (t != null) { if (mentalVals.indexOf(t) >= 0) c.classList.add('on'); else c.classList.remove('on'); }
      });
    }
    MENTAL_OPTS.forEach(function (o) {
      var b = el('button.chip', {
        text: o, 'data-v': o, onclick: function () {
          function commitMental(list) { mentalVals = list; paintMental(); }
          if (o === '正常') {
            commitMental(['正常']);
          } else if (o === '永久疯狂') {
            if (mentalVals.indexOf('永久疯狂') >= 0) {
              var rest = mentalVals.filter(function (x) { return x !== '永久疯狂'; });
              commitMental(rest.length ? rest : ['正常']);
            } else {
              global.UI.confirm('⚠️ 标记「永久疯狂」后，你的角色会被**撕卡**（不可再用，只能聊天）。\n确认标记为永久疯狂？',
                { danger: true, okText: '确认' }).then(function (ok) {
                if (ok) commitMental(['永久疯狂']);
              });
            }
          } else {
            var list = mentalVals.filter(function (x) { return x !== '正常' && x !== '永久疯狂'; });
            if (list.indexOf(o) >= 0) {
              /* v2.1.6（用户第 2 项）：不定疯狂**不可直接取消** —— 只能走「治愈不定疯狂」（KP 同意） */
              /* v2.1.7：两种不定疯狂标签都不可直接取消 —— 只能走治愈（KP 同意） */
              if (o === '不定疯狂' || o === '不定疯狂（症状消失）') {
                global.UI.toast('「' + o + '」不能直接取消 —— 请用下方「💊 治愈不定疯狂」按钮（需 KP 同意）', 'warn', 3600);
                return;
              }
              list = list.filter(function (x) { return x !== o; });
            } else {
              list.push(o);
            }
            commitMental(list.length ? list : ['正常']);
          }
        }
      });
      mentalRow.appendChild(b);
    });
    paintMental();
    var mentalField = el('div.field', { style: { marginTop: '8px' } }, [el('label', { text: '精神状态' }), mentalRow]);


    /* ---- 疯狂：从车卡系统的疯狂表选，或随机 ---- */
    var MAD = global.CocMadness;
    /* v2.10.0（R1）：类型下拉 2 → 10 项 —— 即时症状表 1-8（bout:1…bout:8，label=症状名）
       + 恐惧症（phobia）+ 躁狂症（mania）。数据**同源**（CocMadness.boutTable() = BOUT_TABLE），
       不另建表；即时症状表第 9/10 项即下方两个 100 条选项，故只上 1-8（不含总结症状表）。 */
    var boutRows = (MAD && MAD.boutTable && MAD.boutTable()) || [];
    function boutRowOf(tv) {
      if (tv.indexOf('bout:') !== 0) return null;
      var no = parseInt(tv.split(':')[1], 10);
      return boutRows.filter(function (r) { return r && r.no === no; })[0] || null;
    }
    var MAD_TYPE_OPTS = boutRows
      .filter(function (r) { return r && r.no >= 1 && r.no <= 8; })
      .map(function (r) { return { value: 'bout:' + r.no, label: r.name }; });
    MAD_TYPE_OPTS.push({ value: 'phobia', label: '恐惧症' });
    MAD_TYPE_OPTS.push({ value: 'mania', label: '躁狂' });
    var typeSel = selectCtl(MAD_TYPE_OPTS, 'phobia', null);
    var nameSel = selectCtl([], '', null);
    function fillNames() {
      var tv = selVal(typeSel);
      var list = [], single = null;
      try {
        if (tv === 'mania') list = (MAD && MAD.manias && MAD.manias()) || [];
        else if (tv === 'phobia') list = (MAD && MAD.phobias && MAD.phobias()) || [];
        else {
          var row = boutRowOf(tv);
          if (row) { single = row; list = [row]; }
        }
      } catch (e) { list = []; single = null; }
      var inner = nameSel.querySelector ? nameSel.querySelector('select') : null;
      if (!inner) return;
      inner.innerHTML = '';
      /* v2.1.8（用户第 2 项，根因）：**所有类型**的名字下拉都必须有空选项（value='' = 不添加）——
         玩家只改 HP/SAN 就点保存时，若下拉默认选中某症状，selVal(nameSel) 拿到症状名 →
         提交逻辑据此追加疯狂 + 标记精神状态 → 表现为「改 HP 就进疯狂」。
         v2.10.0（R1）：bout:N 虽是即时症状**单项**，同样遵守该纪律（主理人裁定：安全 > 便捷），
         默认落在「（不添加疯狂）」；要加就手动选，或点「🎲 随机抽一个」主动抽。
         ⚠️ 空选项必须 appendChild 在**最前** —— 只有它是第一个 option，inner.value 才
         默认取 ''（翻类型 / 打开面板都不会误带症状）。 */
      inner.appendChild(el('option', { value: '', text: '（不添加疯狂）' }));
      if (single) {
        inner.appendChild(el('option', { value: single.name,
          text: single.name + (single.en ? ('（' + single.en + '）') : '') }));
        return;
      }
      if (!list.length) {
        inner.appendChild(el('option', { value: '', text: '（本机没有疯狂表数据）' }));
        return;
      }
      list.forEach(function (m) {
        inner.appendChild(el('option', { value: m.name, text: m.name + (m.en ? ('（' + m.en + '）') : '') }));
      });
    }
    /* selectCtl 是「包装过的控件」，值要通过内部 select 读；给个安全取值器 */
    function selVal(ctl) {
      var inner = ctl.querySelector ? ctl.querySelector('select') : null;
      return inner ? inner.value : '';
    }
    typeSel.addEventListener('change', function () { fillNames(); });
    fillNames();
    /* v2.1.6（用户第 2 项）：原「永久」选项改为「不定」—— 真·永久疯狂由
       SAN 归零自动判定（会撕卡），手动勾「永久」是概念错误。
       勾「不定」= 该症状属于不定性疯狂发作（症状持续 N 轮，「不定疯狂」状态需治愈才解除）。 */
    var permI = el('input', { type: 'checkbox' });
    var roundsI = el('input.input', { type: 'text', inputmode: 'numeric', value: '0', maxlength: '3' });

    var body = el('div', null, [
      el('div.tiny.dim', { text: '改的是**你自己**。不需要 KP 同意；改动会写进游戏记录，并同步到你的本机角色卡。' }),
      el('div.field', { style: { marginTop: '8px' } }, [el('label', { text: 'HP / 上限' }),
        el('div.btn-group', null, [hpI, hpMaxI])]),
      el('div.field', { style: { marginTop: '8px' } }, [el('label', { text: 'MP / 上限' }),
        el('div.btn-group', null, [mpI, mpMaxI])]),
      el('div.field', { style: { marginTop: '8px' } }, [el('label', { text: 'SAN / 上限' }),
        el('div.btn-group', null, [sanI, sanMaxI])]),
      el('div.field', { style: { marginTop: '8px' } }, [el('label', { text: '临时状态（追加一条）' }), tsI]),
      bodyField,
      mentalField,

      el('div.sec-title', { style: { marginTop: '10px' }, text: '疯狂状态（追加一条）' }),
      el('div.field', null, [el('label', { text: '类型' }), typeSel]),
      el('div.field', null, [el('label', { text: '症状' }), nameSel]),
      el('div.btn-group', { style: { marginTop: '6px' } }, [
        el('button.btn.sm.ghost.grow', { text: '🎲 随机抽一个', onclick: function () {
          /* v2.10.0（R1）：维持「按所选类型直抽」（不改 1D10 表）——
             bout:N 单项恒中；phobia/mania 从 100 条表随机抽一条。 */
          var tv = selVal(typeSel);
          var list = [];
          try {
            if (tv === 'mania') list = (MAD && MAD.manias && MAD.manias()) || [];
            else if (tv === 'phobia') list = (MAD && MAD.phobias && MAD.phobias()) || [];
            else {
              var row = boutRowOf(tv);
              if (row) list = [row];
            }
          } catch (e) { list = []; }
          if (!list.length) { global.UI.toast('本机没有疯狂表数据', 'err'); return; }
          var pick = list[Math.floor(Math.random() * list.length)];
          var inner = nameSel.querySelector ? nameSel.querySelector('select') : null;
          if (inner) inner.value = pick.name;
          global.UI.toast('抽到：' + pick.name, 'ok');
        } }),
        el('label', { style: { display: 'flex', alignItems: 'center', gap: '4px' } }, [permI, el('span.small', { text: '不定' })]),
        roundsI, el('span.tiny.dim', { text: '轮' })
      ]),
      /* v2.1.6：治愈不定疯狂 —— 只在不定疯狂状态下可点；点击后需 KP 同意才生效 */
      el('button.btn.sm.ghost.block', {
        text: '💊 治愈不定疯狂（需 KP 同意）',
        style: { marginTop: '6px' },
        onclick: function () {
          /* v2.1.7：以**权威端实时状态**为准（弹层里的快照可能已过期）；
             「不定疯狂」与「不定疯狂（症状消失）」都可申请治愈。 */
          var meNow = findMe(ctx);
          var mentalNow = (meNow && meNow.sheet && meNow.sheet.mental) || [];
          if (mentalNow.indexOf('不定疯狂') < 0 && mentalNow.indexOf('不定疯狂（症状消失）') < 0) {
            global.UI.toast('当前没有「不定疯狂」状态', 'err'); return;
          }
          global.UI.confirm('向 KP 申请治愈你的不定疯狂？\nKP 同意后「不定疯狂」状态才会解除。',
            { okText: '申请治愈' }).then(function (ok) {
            if (!ok) return;
            ctx.intent(M.INTENT.ACT, { op: 'madness.cure' });
            global.UI.toast('已向 KP 发起治愈申请，等待同意', 'ok');
            global.UI.closeAllSheets();
          });
        }
      }),

      /* v2.8.0（用户第 2 项）：玩家自助申请「治愈伤势（需 KP 同意）」——
         写法照抄上方「治愈不定疯狂」：前置校验读**权威端实时 body**（弹层快照可能已过期），
         再走 UI.confirm → ctx.intent(ACT, {op:'sheet.healwound'})，KP 同意后生效。
         ⚠️ 该按钮在**昏迷时也必须可点**（昏迷玩家唯一的自救出口，是被昏迷全局锁刻意放行的例外）。 */
      el('button.btn.sm.ghost.block', {
        text: '🩹 治愈伤势（需 KP 同意）',
        style: { marginTop: '6px' },
        onclick: function () {
          var meNow = findMe(ctx);
          if (!isMemberWounded(meNow)) {
            global.UI.toast('当前没有需要治愈的伤势', 'err'); return;
          }
          global.UI.confirm('向 KP 申请治愈你的伤势？\nKP 同意后「重伤 / 濒死 / 昏迷」状态才会解除。',
            { okText: '申请治愈' }).then(function (ok) {
            if (!ok) return;
            ctx.intent(M.INTENT.ACT, { op: 'sheet.healwound' });
            global.UI.toast('已向 KP 发起治愈伤势申请，等待同意', 'ok');
            global.UI.closeAllSheets();
          });
        }
      }),

      el('button.btn.primary.block', {
        text: '保存修改', style: { marginTop: '12px' },
        onclick: function () {
          var status = {};
          function take(inp, key) {
            var v = String(inp.value == null ? '' : inp.value).trim();
            if (v === '') return;
            var n = parseInt(v, 10);
            if (!isFinite(n)) { global.UI.toast(key + ' 必须是数字', 'err'); return; }
            status[key] = n;
          }
          take(hpI, 'currentHP'); take(hpMaxI, 'maxHP');
          take(mpI, 'currentMP'); take(mpMaxI, 'maxMP');
          take(sanI, 'currentSAN'); take(sanMaxI, 'maxSAN');
          /* v2.10.0（R2a/Q3）：身体状态（含 重伤/濒死/昏迷/死亡）已改为**点选即时生效**
             （每次点击直接发 state.self），批量保存**彻底剥离** body/标记 ——
             既从架构上消除 bodyVal0 快照过期问题，也避免批量改 HP 时夹带过期 body
             覆盖权威值。批量只带 HP/MP/SAN/mental/madness/tempStatus。 */
          var payload = { op: 'state.self', status: status };
          if (mentalVals && mentalVals.length) payload.mental = mentalVals;
          var ts = M.cleanText(tsI.value, 60);
          if (ts) payload.tempStatus = ts;
          var madName = selVal(nameSel);
          if (madName) {
            var isIndef = !!permI.checked;
            /* v2.1.6（用户疯狂规则梳理）：症状恒为**临时**（1D10 轮）——
               「不定疯狂」是状态标签（需治愈），症状本身随轮次消退。
               追加症状后自动设精神状态：未勾不定 → 「临时疯狂」；勾了 → 「不定疯狂」。 */
            payload.madness = {
              /* v2.10.0（R1）：type 透传 —— 'bout:N'.split(':')[0] → bout/phobia/mania
                 （MAD_TYPES 白名单已含三者，模型侧零改）；不再是硬编码二选一。 */
              type: String(selVal(typeSel)).split(':')[0],
              name: madName,
              permanent: false,
              rounds: parseInt(roundsI.value, 10) || (1 + Math.floor(Math.random() * 10))
            };
            var wantTag = isIndef ? '不定疯狂' : '临时疯狂';
            var mv = (mentalVals || []).filter(function (x) {
              return x !== '正常' && x !== '永久疯狂' && x !== '临时疯狂' && x !== '不定疯狂';
            });
            if (mv.indexOf(wantTag) < 0) mv.push(wantTag);
            if (mv.indexOf('疯狂症状') < 0) mv.push('疯狂症状');
            mentalVals = mv;
            payload.mental = mentalVals;
            paintMental();
          }
          var changedMental = (mentalVals && mentalVals.length &&
            JSON.stringify(mentalVals) !== JSON.stringify((me.sheet && me.sheet.mental) || ['正常']));
          /* v2.10.0（R2a/Q3）：body/标记不再走批量保存（点选即时生效）→ 无 changedBody 判据。 */
          if (!Object.keys(status).length && !ts && !madName && !changedMental) {
            global.UI.toast('没有要修改的内容', 'err'); return;
          }
          ctx.intent(M.INTENT.ACT, payload);
          global.UI.toast('已提交修改', 'ok');
          global.UI.closeAllSheets();
        }
      })
    ]);
    global.UI.sheet({ title: '状态管理', body: body });
  }

  /**
   * v2.1.6（用户布局图）：**笔记栏** —— 玩家个人笔记。
   * 输入框打字 → 保存 → 显示在列表；每条可删除；列表可上下滚动。
   * 存本机 localStorage（按房间+座位隔离），不上传、KP 不可见 —— 这是玩家自己的小抄。
   */
  function notesPanel(ctx) {
    var code = (ctx.st && ctx.st.meta) ? (ctx.st.meta.code || '') : '';
    var seat = mySeatOf(ctx) || 'me';
    var KEY = 'coc7_notes_' + code + '_' + seat;
    function load() {
      try { return JSON.parse(global.localStorage.getItem(KEY) || '[]') || []; }
      catch (e) { return []; }
    }
    function save(list) {
      try { global.localStorage.setItem(KEY, JSON.stringify(list.slice(0, 200))); } catch (e2) {}
    }
    var input = el('input.input', {
      type: 'text', placeholder: '记点什么…（线索、怀疑、待办）', maxlength: '200'
    });
    var listBox = el('div.notes-list', { style: { maxHeight: '34vh', overflowY: 'auto', marginTop: '6px' } });
    function paint() {
      listBox.innerHTML = '';
      var list = load();
      if (!list.length) {
        listBox.appendChild(el('div.tiny.dim', { text: '还没有笔记。' }));
        return;
      }
      list.slice().reverse().forEach(function (n) {
        var row = el('div.item-row', null, [
          el('span.nm', { style: { whiteSpace: 'normal', lineHeight: '1.4' }, text: n.text }),
          el('span.qty', { style: { flexShrink: '0' }, text: timeText(n.at) })
        ]);
        row.appendChild(el('button.btn.sm.ghost.item-del', {
          text: '✕', title: '删除这条笔记',
          onclick: function () {
            var cur = load().filter(function (x) { return x.at !== n.at || x.text !== n.text; });
            save(cur); paint();
          }
        }));
        listBox.appendChild(row);
      });
    }
    var wrap = el('div.notes-panel', null, [
      el('div.card-title', { text: '📝 笔记栏（仅本机可见）' }),
      el('div.btn-group', { style: { marginTop: '6px' } }, [
        el('button.btn.sm.primary.grow', {
          text: '＋ 保存笔记',
          onclick: function () {
            var t = M.cleanText(input.value, 200);
            if (!t) { global.UI.toast('先写点内容再保存', 'err'); return; }
            var list = load();
            list.push({ text: t, at: Date.now() });
            save(list);
            input.value = '';
            paint();
            global.UI.toast('已保存笔记', 'ok', 1600);
          }
        })
      ]),
      input,
      listBox
    ]);
    paint();
    return wrap;
  }

  function itemsSheet(ctx) {
    var me = findMe(ctx);
    var items = (me && me.sheet && me.sheet.items) || [];
    var body = el('div');
    if (!items.length) {
      body.appendChild(el('div.tiny.dim', { text: '背包里还没有物品。' }));
    } else {
      var list = scrollBox(null, []);
      items.forEach(function (it) {
        var name = (typeof it === 'string') ? it : (it && it.name) || '物品';
        /* ⚠️ 服务端的字段是 qty（sanitizeSheet 白名单），旧渲染读 count → 永远显示不出数量。
           两个都认，避免又出现「有数量却不显示」。 */
        var qty = (it && (it.qty != null ? it.qty : it.count)) ;
        if (qty == null) qty = null;
        var row = el('div.item-row', null, [
          el('span.nm', { text: name }),
          qty != null ? el('span.qty', { text: '×' + qty }) : null
        ]);
        /* v2.1.3（用户第 4 项 · 玩家可自行删除物品/道具）：
           只在有稳定 id 时给删除按钮 —— 按 id 删才是幂等的（见模型 delItem）。 */
        if (it && it.id) {
          row.appendChild(el('button.btn.sm.ghost.item-del', {
            text: '删除', title: '删除这件物品',
            onclick: function () {
              global.UI.confirm('删除「' + name + '」？此操作会记入游戏记录。',
                { danger: true, okText: '删除' }).then(function (ok) {
                if (!ok) return;
                ctx.intent(M.INTENT.ACT, { op: 'item.del', id: it.id });
                global.UI.toast('已删除「' + name + '」', 'ok');
                /* 关掉再打开：等权威端 EVT.STATE 回来后这张表才是新的 */
                global.UI.closeAllSheets();
              });
            }
          }));
        }
        list.appendChild(row);
      });
      body.appendChild(list);
    }
    global.UI.sheet({ title: '物品道具', key: 'items', body: body });
  }

  function rulesSheet(ctx) {
    if (!M) boot();
    /* v2.6.0（用户第 4 项）：大成功 / 大失败口径随房规动态生成 —— 此前是硬编码死文案，
       KP 与玩家共用本表，房规改了这里也不动。
       判据与模型侧 room-model#_rulesOpts 完全一致：
         · critThreshold ∈ [1,99] 才算「自定义」（100 不生效，回落默认 1＝仅 01）；
         · fumbleThreshold ∈ [1,99] 才算「自定义」；缺省 100 的语义是「未自定义」
           → 走规则书动态规则（本次要求阈值 < 50 时 96-100，否则仅 100）。
       缺字段时显示**规则书默认口径**并标注「默认」，不把「未自定义」误导成「大失败 = 100」。 */
    var meta = (ctx.st && ctx.st.meta) || {};
    var cRaw = meta.critThreshold, fRaw = meta.fumbleThreshold;
    var critLine = (cRaw >= 1 && cRaw <= 99)
      ? ('· 大成功：掷出 ≤ ' + cRaw + '（房规自定义）<br>')
      : '· 大成功：01，或检定成功且 ≤ 5（规则书默认）<br>';
    var fumLine = (fRaw >= 1 && fRaw <= 99)
      ? ('· 大失败：掷出 ≥ ' + fRaw + '（房规自定义）')
      : '· 大失败：100，低技能值时 96-100（规则书默认）';
    var body = el('div', null, [
      el('div.small', { html: '<b>克苏鲁的呼唤 第七版 · 速查</b>' }),
      el('div.small', { style: { marginTop: '8px' }, html:
        '检定：掷 1D100 ≤ 目标值即成功。<br>' +
        '· 常规：≤ 技能值<br>· 困难：≤ 技能值 ÷ 2<br>· 极难：≤ 技能值 ÷ 5<br>' +
        critLine + fumLine }),
      el('div.small', { style: { marginTop: '8px' }, html:
        '奖惩骰：奖励骰额外掷十位骰取更小；惩罚骰取更大。<br>' +
        '对抗检定：双方各掷，成功等级高者胜；同级比技能值；相同重掷。' }),
      el('div.small', { style: { marginTop: '8px' }, html:
        '伤害：近战伤害骰 + 伤害加值 − 护甲；极难/贯穿取最大并追加一次伤害骰。' })
    ]);
    global.UI.sheet({ title: '规则参考', key: 'rules', body: body });
  }

  /** 音乐控制台：本地 BGM（不打包音频文件；由用户本机选文件，仅本地播放） */
  function musicSheet(ctx) {
    var files = el('input', { type: 'file', accept: 'audio/*', style: { display: 'none' } });
    var audio = null;
    var status = el('div.tiny.dim', { text: '未播放' });
    files.addEventListener('change', function () {
      var f = files.files && files.files[0];
      if (!f) return;
      try {
        if (audio) { audio.pause(); }
        audio = new Audio(URL.createObjectURL(f));
        status.textContent = '已选择：' + f.name;
      } catch (e) { global.UI.toast('无法播放该文件', 'err'); }
    });
    var body = el('div', null, [
      el('div.tiny.dim', { text: '本地 BGM：仅在你本机播放，不同步给其他设备（不打包任何音频文件）。' }),
      files, status,
      el('div.btn-group', { style: { marginTop: '10px' } }, [
        el('button.btn.grow', { text: '选择音频', onclick: function () { files.click(); } }),
        el('button.btn.grow', { text: '▶ 播放', onclick: function () { if (audio) { audio.play().catch(function () {}); status.textContent = '播放中'; } } }),
        el('button.btn.grow', { text: '⏸ 暂停', onclick: function () { if (audio) { audio.pause(); status.textContent = '已暂停'; } } })
      ])
    ]);
    global.UI.sheet({ title: '音乐控制台', body: body });
  }

  /* ============================================================
   * 新增弹层 · 战斗准备（选怪 → 战斗部署完毕）
   * ============================================================ */

  /**
   * v2.0.2 修复C：把**在场 PC** 编译成战斗单位（提交 combat.start 时与怪物一起送进 actors）。
   * DEX 取 memberDex（= sheet.attrs，权威值）；HP 取 memberStats。
   * id 用 'p-<seat>' 前缀，与旧 F1 兜底路径一致（避免与怪物池 id 冲突）。
   */
  function pcActors(ctx) {
    return playersOf(ctx).map(function (m) {
      var stt = memberStats(m);
      return { id: 'p-' + m.seat, name: (m.charName || m.nickname || '玩家'), kind: 'pc',
               seat: m.seat, dex: (memberDex(m) != null ? memberDex(m) : 0),
               actionsPerRound: 1,
               hp: (stt.hp != null ? stt.hp : 0),
               hpMax: (stt.hpMax != null ? stt.hpMax : (stt.hp || 0)) };
    });
  }

  /**
   * 选怪流程（用户明确要求）：
   *   KP 点「战斗模式」→ 本弹层多选怪物/NPC（至少 1 个）→ 点「⚔️ 战斗部署完毕」
   *   → 提交 combat.start{actorIds}（E 线内部调用 CocRules.initiativeOrder 自动排序）。
   */
  function combatPrepareSheet(ctx) {
    if (!M) boot();
    if (ctx.role !== 'kp') { global.UI.toast('只有 KP 能开始战斗', 'err'); return; }
    var selected = {};   // actorId -> true
    /* v2.7.0（用户第 1 项）：玩家区改为**可多选**（默认全选）。用「反选表」pcOff：
       key 不存在 = 默认选中；true = KP 手动取消勾选。默认全选 = 保持旧「自动加入」的体感。 */
    var pcOff = {};      // seat -> true 表示「未勾选」

    var body = el('div');
    var listWrap = scrollBox(null, []);
    listWrap.style.maxHeight = '52vh';

    var api;
    function render() {
      global.UI.clear(listWrap);
      /* v2.7.0（用户第 1 项）：玩家改为**可多选勾选**（默认全选）。已撕卡（死亡/永久疯狂）不列出。 */
      var players = playersOf(ctx).filter(function (m) { return !targetBlocked(m); });
      if (players.length) {
        listWrap.appendChild(el('div.sec-title', { text: '玩家（勾选进入战斗）' }));
        players.forEach(function (m) {
          var on = !pcOff[m.seat];
          listWrap.appendChild(el('div.actor-line' + (on ? '.on' : ''), {
            onclick: function () { pcOff[m.seat] = !pcOff[m.seat]; render(); syncDeploy(); }
          }, [
            el('div.chk', { text: on ? '☑' : '☐' }),
            el('div.grow', null, [
              el('div.nm', { text: (m.charName || m.nickname || '玩家') }),
              el('div.tiny.dim', { text: 'PC · DEX ' + (memberDex(m) != null ? memberDex(m) : '—') })
            ])
          ]));
        });
      }
      listWrap.appendChild(el('div.sec-title', { text: '怪物 / NPC（勾选进入战斗）' }));
      var pool = actorPool(ctx);
      if (!pool.length) {
        listWrap.appendChild(el('div.tiny.dim', { text: '候选池是空的。点下面「＋ 新增怪物」先添加。' }));
      }
      pool.forEach(function (a) {
        var on = !!selected[a.id];
        listWrap.appendChild(el('div.actor-line' + (on ? '.on' : ''), {
          onclick: function () { selected[a.id] = !on; render(); syncDeploy(); }
        }, [
          el('div.chk', { text: on ? '☑' : '☐' }),
          el('div.grow', null, [
            el('div.nm', { text: a.name || '—' }),
            el('div.tiny.dim', { text: (a.kind === 'monster' ? '怪物' : 'NPC') +
              ' · DEX ' + (a.dex != null ? a.dex : '—') +
              (a.actionsPerRound > 1 ? (' · 每轮 ' + a.actionsPerRound + ' 次') : '') })
          ])
        ]));
      });
    }

    var deployBtn = el('button.btn.primary.block', {
      text: '⚔️ 战斗部署完毕', style: { marginTop: '12px' },
      onclick: function () {
        var ids = Object.keys(selected).filter(function (k) { return selected[k]; });
        if (!ids.length) { global.UI.toast('至少选择 1 个怪物/NPC', 'err'); return; }
        var monsterActors = actorPool(ctx).filter(function (a) { return ids.indexOf(a.id) >= 0; }).map(function (a) {
          return { id: a.id, name: a.name, kind: a.kind, dex: a.dex, hp: a.hp, hpMax: a.hpMax,
                   actionsPerRound: a.actionsPerRound || 1 };
        });
        /* v2.0.2 修复C：把 PC 一起送进 actors（actorIds 仍只列怪物 —— PC 由模型
           combatStart 自动加入，见 room-model.js 修复C'）。旧行为只送怪物 → 真实
           对局里战斗队列完全没有 PC 槽。 */
        var actors = pcActors(ctx).concat(monsterActors);
        /* v2.7.0（用户第 1 项）：把 KP 勾选的玩家座位作为 pcSeats 传出（默认全选，保持旧体感）。
           已撕卡（死亡/永久疯狂）的 PC 不列出、也不会进 pcSeats。 */
        var pcSeats = playersOf(ctx).filter(function (m) { return !targetBlocked(m); })
          .filter(function (m) { return !pcOff[m.seat]; })
          .map(function (m) { return m.seat; });
        /* 同时发 actorIds（E 线新接口）与 actors（旧接口兜底），保证未改完也能跑 */
        ctx.act({ op: 'combat.start', actorIds: ids, actors: actors, pcSeats: pcSeats });
        global.UI.toast('战斗部署完毕，已按 DEX 自动排序', 'ok');
        api.close();
      }
    });
    function syncDeploy() {
      var n = Object.keys(selected).filter(function (k) { return selected[k]; }).length;
      var pcn = playersOf(ctx).filter(function (m) { return !targetBlocked(m) && !pcOff[m.seat]; }).length;
      deployBtn.disabled = n === 0;
      deployBtn.textContent = n ? ('⚔️ 战斗部署完毕（怪物 ' + n + ' · 玩家 ' + pcn + '）') : '⚔️ 战斗部署完毕';
    }

    render();
    syncDeploy();

    body.appendChild(el('div.tiny.dim', { text: '勾选要进入战斗的玩家与怪物/NPC（玩家默认全选）。系统按 CoC 7th 规则自动排行动顺序。' }));
    body.appendChild(listWrap);
    body.appendChild(el('button.btn.sm.ghost.block', {
      text: '＋ 新增怪物 / NPC', style: { marginTop: '8px' },
      onclick: function () { addActorSheet(ctx, { preCombat: true, onAdded: function () { render(); syncDeploy(); } }); }
    }));
    body.appendChild(deployBtn);

    api = global.UI.sheet({ title: '战斗模式 · 选择参战单位', body: body });
    return api;
  }

  /* ============================================================
   * 新增弹层 · 场景检定编辑器
   * 步骤：标题 / 说明 / 目标玩家 / 技能或属性 / 难度 / 奖惩骰 /
   *       成功分支 / 失败分支（分支可含伤害表达式与提示文字）
   * ============================================================ */

  function newSceneStep() {
    return {
      id: 's' + Date.now() + Math.floor(Math.random() * 1000),
      title: '', desc: '', targetMode: 'all', targetSeats: [],
      skill: '', difficulty: 'REGULAR', bonus: 0, penalty: 0,
      onSuccess: { note: '', damage: '' },
      onFailure: { note: '', damage: '' }
    };
  }

  function sceneCheckDraft() {
    if (!UI_STATE.sceneCheckDraft) {
      UI_STATE.sceneCheckDraft = { title: '场景检定', desc: '', steps: [newSceneStep()] };
    }
    return UI_STATE.sceneCheckDraft;
  }

  /**
   * v2.1.4（用户第 3 项）：**玩家视角的场景检定面板**。
   *
   * 真因：玩家侧那块区域原来挂的是 `kpSceneCheckPanel` —— 那是 KP 的**编辑器**，
   * 里面有「自定义检定」表单和「推送给玩家」按钮。玩家点下去发的是 KP 专属操作，
   * 权威端静默拒绝（"你没有权限执行该操作"），可界面照样 toast「推送成功」——
   * 用户看到的就是「显示推送成功，但没有任何检定信息」。
   *
   * 玩家要的是两件事：
   *   ① 看到 KP 正在推的场景检定（标题/说明/步骤 + 轮到我没有）；
   *   ② **自己**主动做一次检定（需求原话："在探索一个房间时需要用侦查判定能否找到线索"）。
   */
  function plSceneCheckPanel(ctx) {
    if (!M) boot();
    var wrap = el('div.pl-scene-panel');

    /* ---- ① KP 推来的进行中检定（只读） ---- */
    var cur = sceneCheckOf(ctx);
    if (cur) {
      wrap.appendChild(el('div.card-title', { text: '场景检定：' + (cur.title || '') }));
      if (cur.desc) wrap.appendChild(el('div.tiny.dim', { text: cur.desc }));
      var me = findMe(ctx);
      var mySeat = me && me.seat;
      var list = scrollBox(null, []);
      var results = cur.results || [];
      (cur.steps || []).forEach(function (s, i) {
        var r = null;
        for (var k = 0; k < results.length; k++) if (results[k].stepId === s.id) r = results[k];
        var forMe = (s.targetSeat === '*' || s.targetSeat === mySeat);
        var active = i === (cur.cursor || 0);
        list.appendChild(el('div.scene-step' + (r ? '.done' : '') + (active ? '.active' : ''), null, [
          el('div.st-title', { text: (i + 1) + '. ' + (s.title || s.skill || '步骤') + (forMe ? '（你）' : '') }),
          el('div.tiny.dim', { text: (s.skill || '') + (s.difficulty ? (' · ' + s.difficulty) : '') }),
          r ? el('div.tiny', { text: (r.ok ? '✅ 成功' : '❌ 失败') }) : null
        ].filter(Boolean)));
      });
      wrap.appendChild(list);
      var curs = cur.cursor || 0;
      var step = (cur.steps || [])[curs];
      if (step && !results.some(function (x) { return x.stepId === step.id; })) {
        var mine = (step.targetSeat === '*' || step.targetSeat === mySeat);
        if (mine) {
          wrap.appendChild(el('button.btn.primary.block', {
            text: '🎲 掷这次检定（' + (step.skill || '检定') + '）',
            style: { marginTop: '8px' },
            onclick: function () {
              var found = findLocalSkill(step.skill);
              /* v2.4.0（用户第 ⑫ 项）：KP 发起、玩家响应的场景检定结果属**公开信息** —
                 — 不再继承骰子条的「暗骰」开关（secret）。原实现带 `secret: !!UI_STATE.darkRoll`，
                 玩家一旦开着暗骰开关，场景检定结果就只进「本人 + KP」，公开记录只剩一句
                 「暗骰了一次」—— 用户实录「结果只有 KP 看得到 / 不广播」。
                 现在恒为明骰：EVT.DICE 走 VIS.PUBLIC 广播全员，与 sceneCheckStep 的
                 公开裁定日志（EVT.LOG / EVT.SCENE_CHECK 均 VIS.PUBLIC）口径一致。
                 想要私密掷骰的场合（玩家自主加戏）用「我要检定」卡片，那里仍尊重暗骰开关。 */
              ctx.intent(M.INTENT.DICE, {
                expr: '1D100', direct: true,
                base: found ? found.total : undefined,
                difficulty: step.difficulty || 'REGULAR',
                label: (step.skill || '检定'),
                bonus: UI_STATE.d100Mod.bonus || 0, penalty: UI_STATE.d100Mod.penalty || 0,
                secret: false
              });
              global.UI.toast('已掷出，结果进游戏记录（由 KP 裁定）', 'ok');
            }
          }));
          wrap.appendChild(el('div.tiny.dim', { style: { marginTop: '4px' },
            text: '掷完由 KP 在「场景检定」里裁定成功/失败。' }));
        } else {
          wrap.appendChild(el('div.tiny.dim', { style: { marginTop: '4px' }, text: '当前步骤不是你来掷。' }));
        }
      } else if (cur.cursor >= (cur.steps || []).length) {
        wrap.appendChild(el('div.tiny.dim', { text: '✅ 场景检定已完成。' }));
      }
    } else {
      /* v2.13.3（用户第 2 项）：没有进行中的检定时只占一行 —— 旧版标题 + 说明两行占 43px */
      wrap.appendChild(el('div.pl-scene-none', null, [
        el('b', { text: '场景检定' }),
        el('span.tiny.dim', { text: ' · KP 未推送' })
      ]));
    }

    /* ---- ② 玩家主动检定（v2.1.6 用户第 8 项）：
       一级选「属性 / 技能」；属性按九项固定序（不排序）、技能按总值降序
       （含**未学习**的技能，取 COC_SKILLS 基础值）—— 因为属性检定也是常见需求。 ---- */
    var me2 = findMe(ctx);
    var sh2 = (me2 && me2.sheet) || {};
    var ATTR_DEFS = [
      { key: 'str', name: '力量' }, { key: 'con', name: '体质' }, { key: 'siz', name: '体型' },
      { key: 'dex', name: '敏捷' }, { key: 'app', name: '外貌' }, { key: 'int', name: '智力' },
      { key: 'pow', name: '意志' }, { key: 'edu', name: '教育' }, { key: 'luck', name: '幸运' }
    ];
    function attrOpts2() {
      return ATTR_DEFS.map(function (a) {
        var v = (sh2.attrs && sh2.attrs[a.key] != null) ? Number(sh2.attrs[a.key]) : null;
        return { value: 'A:' + a.name, text: a.name + '（' + (v == null ? '—' : v) + '）', base: (v == null ? 50 : v), nm: a.name };
      });
    }
    function skillOpts2() {
      var learned = {};
      var out = [];
      (sh2.skills || []).forEach(function (sk) {
        if (!sk || !sk.name) return;
        var t = (sk.total != null) ? Number(sk.total) : Number(sk.value);
        if (!isFinite(t)) t = 0;
        learned[String(sk.name)] = t;
        out.push({ value: 'S:' + sk.name, text: sk.name + '（' + t + '）', base: t, nm: sk.name });
      });
      var ALL = (typeof window !== 'undefined' && window.COC_SKILLS) || [];
      ALL.forEach(function (d) {
        if (!d || !d.name || learned[String(d.name)] != null) return;
        /* v2.13.3（用户要求）：信用评级也要能检定（雇人、行贿、撑场面都用它）——
           只保留「克苏鲁神话」不进自由检定（它不是可主动使用的能力）。 */
        if (d.id === 'cthulhu') return;
        var b = Number(d.base) || 0;
        out.push({ value: 'S:' + d.name, text: d.name + '（未学 ' + b + '）', base: b, nm: d.name });
      });
      out.sort(function (a, b) { return b.base - a.base; });   // 总值降序，方便玩家挑
      return out;
    }
    var kindAttr2 = true;
    var kindRow2 = el('div.btn-group', { style: { flexWrap: 'wrap', gap: '4px' } });
    var attrBtn2 = el('button.chip.on', { text: '属性' });
    var skillBtn2 = el('button.chip', { text: '技能' });
    kindRow2.appendChild(attrBtn2); kindRow2.appendChild(skillBtn2);
    var secondSel2 = selectCtl([{ value: '', text: '…' }], '', null);
    function fillSecond2() {
      var opts = kindAttr2 ? attrOpts2() : skillOpts2();
      var inner = secondSel2.querySelector ? secondSel2.querySelector('select') : null;
      if (!inner) return;
      inner.innerHTML = '';
      if (!opts.length) { inner.appendChild(el('option', { value: '', text: '（无可选项）' })); return; }
      opts.forEach(function (o) { inner.appendChild(el('option', { value: o.value, text: o.text })); });
    }
    attrBtn2.addEventListener('click', function () {
      kindAttr2 = true; attrBtn2.classList.add('on'); skillBtn2.classList.remove('on'); fillSecond2();
    });
    skillBtn2.addEventListener('click', function () {
      kindAttr2 = false; skillBtn2.classList.add('on'); attrBtn2.classList.remove('on'); fillSecond2();
    });
    fillSecond2();
    function selVal2(ctl) {
      var inner = ctl.querySelector ? ctl.querySelector('select') : null;
      return inner ? inner.value : '';
    }
    var diffSel = selectCtl([
      { value: 'REGULAR', label: '常规' },
      { value: 'HARD', label: '困难（÷2）' },
      { value: 'EXTREME', label: '极难（÷5）' }
    ], 'REGULAR', null);

    /* v2.13.3（用户第 2 项）：加 .pl-check-card，CSS 据此把「类型/项目/难度」压成两列紧凑布局 */
    wrap.appendChild(el('div.card.pl-check-card', { style: { marginTop: '8px' } }, [
      el('div.card-title', { text: '我要检定' }),
      el('div.field', null, [el('label', { text: '类型' }), kindRow2]),
      el('div.field', null, [el('label', { text: '项目' }), secondSel2]),
      el('div.field', null, [el('label', { text: '难度' }), diffSel]),
      el('button.btn.primary.block', {
        text: '掷检定', style: { marginTop: '8px' },
        onclick: function () {
          var v = selVal2(secondSel2);
          if (!v) { global.UI.toast('没有可检定的项目（本机未绑定角色卡？）', 'err'); return; }
          var pool = (v.charAt(0) === 'A') ? attrOpts2() : skillOpts2();
          var hit = null;
          for (var i = 0; i < pool.length; i++) if (pool[i].value === v) { hit = pool[i]; break; }
          if (!hit) { global.UI.toast('找不到该项目', 'err'); return; }
          ctx.intent(M.INTENT.DICE, {
            expr: '1D100', direct: true, base: hit.base,
            difficulty: diffSel.value, label: hit.nm,
            bonus: UI_STATE.d100Mod.bonus || 0, penalty: UI_STATE.d100Mod.penalty || 0,
            secret: !!UI_STATE.darkRoll
          });
          global.UI.toast('掷 ' + hit.nm + '（对 ' + hit.base + '）…', 'ok');
        }
      }),
      /* v2.13.3（用户第 2 项）：这句原来占 3 行（48px），压成一行 —— 栏内要「不用拖动看全」 */
      el('div.tiny.dim', { style: { marginTop: '4px' }, text: '结果进游戏记录，由 KP 裁定。' })
    ]));
    return wrap;
  }

  /** 本机绑定角色卡的技能列表（按总值降序；取不到的返回空数组） */
  function localSkills() {
    try {
      var id = global.RoomUI && global.RoomUI._session ? (global.RoomUI._session() || {}).boundCharId : '';
      if (!global.Store || !global.Store.getState) return [];
      var stt = global.Store.getState();
      var c = (id && stt.characters && stt.characters[id]) || stt.current || null;
      if (!c || !Array.isArray(c.skills)) return [];
      return c.skills
        .filter(function (s) { return s && s.name && s.total != null; })
        .map(function (s) { return { name: String(s.name), total: Number(s.total) || 0 }; })
        .sort(function (a, b) { return b.total - a.total; })
        .slice(0, 60);
    } catch (e) { return []; }
  }

  /** 在本机角色卡里按名字找一个技能（精确 → 包含） */
  function findLocalSkill(name) {
    var list = localSkills();
    var q = String(name || '').toLowerCase();
    if (!q) return null;
    var hit = null;
    for (var i = 0; i < list.length; i++) if (list[i].name.toLowerCase() === q) { hit = list[i]; break; }
    if (!hit) {
      for (var j = 0; j < list.length; j++) {
        var n = list[j].name.toLowerCase();
        if (n.indexOf(q) >= 0 || q.indexOf(n) >= 0) { hit = list[j]; break; }
      }
    }
    return hit;
  }

  function sceneCheckSheet(ctx) {
    if (!M) boot();
    if (ctx.role !== 'kp') { global.UI.toast('只有 KP 能编辑场景检定', 'err'); return; }
    var draft = sceneCheckDraft();
    var api;

    function refresh() { if (api) api.refresh(); }

    function build() {
      var box = el('div');
      box.appendChild(el('div.field', null, [
        el('label', { text: '标题' }),
        el('input.input', { type: 'text', value: draft.title || '', maxlength: 40,
          onchange: function (e) { draft.title = e.target.value; } })
      ]));
      box.appendChild(el('div.field', null, [
        el('label', { text: '说明' }),
        el('textarea.textarea', { rows: '2', value: draft.desc || '', maxlength: 200,
          onchange: function (e) { draft.desc = e.target.value; } })
      ]));

      var stepList = el('div');
      (draft.steps || []).forEach(function (step, idx) {
        stepList.appendChild(stepEditor(ctx, draft, step, idx, refresh));
      });
      box.appendChild(stepList);

      box.appendChild(el('button.btn.sm.ghost.block', {
        text: '＋ 添加步骤', style: { marginTop: '8px' },
        onclick: function () { draft.steps.push(newSceneStep()); refresh(); }
      }));

      box.appendChild(el('div.btn-group', { style: { marginTop: '12px' } }, [
        el('button.btn.ghost.grow', { text: '清空草稿', onclick: function () {
          UI_STATE.sceneCheckDraft = null; refresh();
        } }),
        el('button.btn.primary.grow', { text: '推送给玩家', onclick: function () { pushSceneCheck(ctx, api); } })
      ]));
      box.appendChild(el('div.tiny.dim', { style: { marginTop: '8px' },
        text: '目标为「多人」时，推送时会按所选顺序展开为多个步骤，逐个结算。' }));
      return box;
    }

    api = global.UI.sheet({ title: '场景检定编辑器', body: build });
    return api;
  }

  function stepEditor(ctx, draft, step, idx, refresh) {
    var box = el('div.card.scene-step-edit', { style: { marginTop: '8px' } });
    box.appendChild(el('div.card-head', null, [
      el('h3', { text: '步骤 ' + (idx + 1) }),
      el('button.btn.sm.ghost', { text: '删除', onclick: function () {
        draft.steps.splice(idx, 1);
        if (!draft.steps.length) draft.steps.push(newSceneStep());
        refresh();
      } })
    ]));

    function field(label, control) { return el('div.field', null, [el('label', { text: label }), control]); }

    box.appendChild(field('标题', el('input.input', { type: 'text', value: step.title || '', maxlength: 40,
      onchange: function (e) { step.title = e.target.value; } })));
    box.appendChild(field('说明', el('textarea.textarea', { rows: '2', value: step.desc || '', maxlength: 200,
      onchange: function (e) { step.desc = e.target.value; } })));

    /* v2.7.0（用户第 3 项）：场景检定步骤目标不列出已撕卡（死亡 / 永久疯狂）的角色。 */
    var players = playersOf(ctx).filter(function (m) { return !targetBlocked(m); });
    var modeSel = selectCtl([
      { value: 'all', label: '全部玩家' },
      { value: 'one', label: '指定一名玩家' },
      { value: 'many', label: '指定多名玩家（按序）' }
    ], step.targetMode || 'all', function (v) { step.targetMode = v; refresh(); });
    box.appendChild(field('目标玩家', modeSel));

    if (step.targetMode === 'one') {
      box.appendChild(field('玩家', selectCtl(players.map(function (m) {
        return { value: m.seat, label: m.charName || m.nickname || '玩家' };
      }), (step.targetSeats || [])[0] || (players[0] && players[0].seat) || '', function (v) {
        step.targetSeats = [v];
      })));
    } else if (step.targetMode === 'many') {
      var manyWrap = el('div.multi-pick');
      players.forEach(function (m) {
        var on = (step.targetSeats || []).indexOf(m.seat) >= 0;
        manyWrap.appendChild(el('div.pick' + (on ? '.on' : ''), {
          text: (on ? '☑ ' : '☐ ') + (m.charName || m.nickname || '玩家'),
          onclick: function () {
            var i = (step.targetSeats || []).indexOf(m.seat);
            if (i >= 0) step.targetSeats.splice(i, 1); else (step.targetSeats = step.targetSeats || []).push(m.seat);
            refresh();
          }
        }));
      });
      box.appendChild(field('玩家（按序）', manyWrap));
    }

    box.appendChild(field('技能 / 属性', el('input.input', { type: 'text', value: step.skill || '',
      placeholder: '如：敏捷 / 侦查', maxlength: 20, onchange: function (e) { step.skill = e.target.value; } })));
    box.appendChild(field('难度', selectCtl([
      { value: 'REGULAR', label: '常规' },
      { value: 'HARD', label: '困难（÷2）' },
      { value: 'EXTREME', label: '极难（÷5）' }
    ], step.difficulty || 'REGULAR', function (v) { step.difficulty = v; })));

    function numRow(label, key) {
      var val = el('span.val', { text: String(step[key] || 0) });
      function set(v) { step[key] = Math.max(0, Math.min(5, v)); val.textContent = String(step[key]); }
      return el('div.mod-row', null, [
        el('span.k', { text: label }),
        el('button.sbtn', { text: '−', onclick: function () { set((step[key] || 0) - 1); } }),
        val,
        el('button.sbtn', { text: '+', onclick: function () { set((step[key] || 0) + 1); } })
      ]);
    }
    box.appendChild(field('奖励 / 惩罚骰', el('div', null, [numRow('奖励骰', 'bonus'), numRow('惩罚骰', 'penalty')])));

    function branch(title, obj) {
      return el('div.branch', null, [
        el('div.sec-title', { text: title }),
        el('div.field', null, [el('label', { text: '提示文字' }),
          el('input.input', { type: 'text', value: obj.note || '', maxlength: 80,
            onchange: function (e) { obj.note = e.target.value; } })]),
        el('div.field', null, [el('label', { text: '伤害表达式' }),
          el('input.input', { type: 'text', value: obj.damage || '', placeholder: '如 1D6（可空）', maxlength: 20,
            onchange: function (e) { obj.damage = e.target.value; } })])
      ]);
    }
    box.appendChild(branch('✅ 成功分支', step.onSuccess || (step.onSuccess = { note: '', damage: '' })));
    box.appendChild(branch('❌ 失败分支', step.onFailure || (step.onFailure = { note: '', damage: '' })));
    return box;
  }

  /** 把编辑器草稿展开成 steps（多人 → 按序展开成多步），提交 scene.check.push */
  function pushSceneCheck(ctx, api) {
    var draft = sceneCheckDraft();
    if (!draft.steps || !draft.steps.length) { global.UI.toast('至少要有 1 个步骤', 'err'); return; }
    var steps = [];
    draft.steps.forEach(function (s) {
      var seats;
      if (s.targetMode === 'one') seats = [(s.targetSeats || [])[0] || ''];
      else if (s.targetMode === 'many') seats = (s.targetSeats || []).slice();
      else seats = ['*'];
      if (!seats.length) seats = ['*'];
      seats.forEach(function (seat) {
        steps.push({
          id: s.id + '-' + seat,
          title: s.title || s.skill || '步骤',
          desc: s.desc || '',
          targetSeat: seat,
          skill: s.skill || '',
          difficulty: s.difficulty || 'REGULAR',
          bonus: s.bonus || 0,
          penalty: s.penalty || 0,
          onSuccess: { damage: (s.onSuccess || {}).damage || '', note: (s.onSuccess || {}).note || '' },
          onFailure: { damage: (s.onFailure || {}).damage || '', note: (s.onFailure || {}).note || '' }
        });
      });
    });
    ctx.act({ op: 'scene.check.push', title: draft.title || '场景检定', desc: draft.desc || '', steps: steps });
    global.UI.toast('已推送场景检定（共 ' + steps.length + ' 步）', 'ok');
    if (api) api.close();
  }

  /* ============================================================
   * 新增弹层 · 对抗检定
   * ============================================================ */

  /* ============================================================
   * v2.2.0（用户第 3 项）：对抗全链路 UI
   *   · KP：二级菜单「⚔ 对抗」→ 通用对抗 / 攻击对抗；待处理申请卡 + 裁定弹层。
   *   · 玩家：底部工具栏「⚔ 对抗」→ 选武器 + 选怪 → 推送 KP；胜后多怪时选怪。
   *   · 结果卡由 room-ui.js#appendFeed 渲染（含反击/闪避、逐轮重掷、伤害）。
   * 对外导出名（opposedSheet）保持不变 —— 仅内部改为二级菜单。
   * ============================================================ */

  /** 整数区间校验（越界 / 非整数返回 null）。 */
  function intIn(v, lo, hi) {
    var n = parseInt(v, 10);
    return (isFinite(n) && String(n) === String(v) && n >= lo && n <= hi) ? n : null;
  }

  /** 存活怪物清单（战斗槽 kind==='monster' 且未死 / 未离场）。 */
  function monsterList(ctx) {
    var c = ctx && ctx.st && ctx.st.combat;
    if (!c || !Array.isArray(c.order)) return [];
    return c.order.filter(function (s) {
      if (!s || s.kind !== 'monster') return false;
      /* v2.5.0（QA 回发·判活口径对齐）：改用 unitDown（与模型 slotDown 同口径），
         不再单看 hp<=0 —— 没登记血量（hp:0,hpMax:0）的怪物不能被判死。 */
      if (unitDown(s.public)) return false;
      return true;
    }).map(function (s) { return { id: s.actorId || s.id, name: s.name || '怪物', slot: s }; });
  }

  /**
   * v2.5.0（用户第 5 项）：对抗检定的「存活单位」清单 —— **探索态也要能列出来**。
   *
   * 旧 `genericOpposedSheet` 直接用 `actorPool`（不判活）+ 战斗态才有意义；而
   * `monsterList` 只认 `combat.order`（探索态 order 为空 → 一个单位都列不出来），
   * 于是探索模式根本没法发起对抗检定。
   *
   * 口径：以 `actorPool(ctx)`（KP 本地候选池 + UI 兜底缓存 + 战斗槽归并）为全集，
   * 再用 `unitDown`（与模型 `slotDown` 同口径）剔除已阵亡的；
   * 不在战斗槽里的（探索态单位）视为存活。最后并入 monsterList 做兜底去重。
   *
   * v2.5.0（QA 回发·判活口径对齐）：判活必须带 `hpMax > 0` 守卫 —— 否则
   * 「没登记血量」（hp:0,hpMax:0）的候选池单位会被误判为死，探索态照样选不到。
   *
   * @param {object} ctx
   * @return {Array<{id:string, name:string, kind:string}>}
   */
  function aliveUnits(ctx) {
    var out = [], seen = {};
    var slots = {};   // actorId → 战斗槽（判活用）
    var c = (ctx && ctx.st && ctx.st.combat) || null;
    if (c && Array.isArray(c.order)) {
      c.order.forEach(function (s) {
        if (s && (s.actorId || s.id)) slots[s.actorId || s.id] = s;
      });
    }
    /** 沿用 unitDown 判活口径（与模型 slotDown 一致）；不在战斗槽（探索态）→ 视为存活。 */
    function isAlive(id) {
      var s = slots[id];
      if (!s) return true;
      return !unitDown(s.public);
    }
    actorPool(ctx).forEach(function (a) {
      if (!a || !a.id || seen[a.id] || !isAlive(a.id)) return;
      seen[a.id] = 1;
      out.push({ id: a.id, name: a.name || '单位', kind: a.kind || 'npc' });
    });
    /* 兜底：战斗槽里有、但 actorPool 没归并进来的（actorId 缺失等极端情况）。 */
    monsterList(ctx).forEach(function (a) {
      if (!a || !a.id || seen[a.id]) return;
      seen[a.id] = 1;
      out.push({ id: a.id, name: a.name || '怪物', kind: 'monster' });
    });
    return out;
  }

  /** 「⚔ 对抗」二级菜单（KP）：通用对抗 / 攻击对抗。 */
  function opposedSheet(ctx) {
    if (!M) boot();
    if (ctx.role !== 'kp') { global.UI.toast('只有 KP 能发起对抗检定', 'err'); return; }
    var grid = el('div.tool-grid');
    grid.appendChild(toolBtn('🎯 通用对抗', '双方各出一技能/属性比高低（同级同值逐轮重掷）', function () {
      api.close(); genericOpposedSheet(ctx);
    }));
    grid.appendChild(toolBtn('⚔ 攻击对抗', '攻击方 vs 防守方（反击/闪避）+ 自动伤害结算', function () {
      api.close(); kpAttackSheet(ctx);
    }));
    var body = el('div', null, [
      el('div.tiny.dim', { text: '通用对抗 = 技能/属性比高低；攻击对抗 = 战斗攻击 + 反击/闪避 + 伤害。' }),
      grid
    ]);
    var api = global.UI.sheet({ title: '⚔ 对抗', body: body });
    return api;
  }

  /**
   * 通用对抗表单（原 opposedSheet 主体，字段名兼容保留）。
   *
   * v2.5.0（用户第 5 项）：
   *   · 攻/防下拉 =「玩家 + **存活单位（含探索态）**」—— 改用 aliveUnits()，
   *     探索模式也能发起对抗检定（旧实现只能靠 combat.order，探索态列不出单位）；
   *   · 新增两个 1–100 的**对抗值手输框**（aBase / bBase），提交时一并带上 ——
   *     单位没有人物卡（无技能值），没有手输值模型侧只能按 0 兜底；
   *   · 通用检定**不含武器字段**（现状本就没有，保持）。
   *
   * ⚠️ 下拉 value 的前缀语义（模型侧 `_resolveActorSkill` 会剥前缀分派，
   *    并对无前缀做宽松回退，改这里前先看 room-model.js）：
   *   · `p:<seat>`   → 玩家座位（roster 查成员，技能值从人物卡读）
   *   · `a:<id>`     → **本表单**用的单位前缀（NPC / 怪物；无卡 → 用 aBase/bBase）
   *   · `mo:<id>`    → kpAttackSheet（攻击对抗）用的怪物前缀，模型侧同样宽松解析
   *   · `pc:<seat>`  → kpAttackSheet（攻击对抗）用的玩家前缀
   *   · 无前缀       → 先按座位试、再按单位 id 试（兼容旧存档 / 其它调用方）
   */
  function genericOpposedSheet(ctx) {
    if (!M) boot();
    /* v2.7.0（用户第 3 项）：甲/乙方下拉的**玩家侧**不列出已撕卡（死亡 / 永久疯狂）的角色；
       单位侧仍走 aliveUnits（存活单位）过滤，不受本次改动影响。 */
    var players = playersOf(ctx).filter(function (m) { return !targetBlocked(m); });
    var pool = aliveUnits(ctx);
    var opts = players.map(function (m) {
      return { value: 'p:' + m.seat, label: (m.charName || m.nickname || '玩家') + '（玩家）', isUnit: false };
    }).concat(pool.map(function (a) {
      return { value: 'a:' + a.id, label: (a.name || '—') + (a.kind === 'monster' ? '（怪物）' : '（NPC）'), isUnit: true };
    }));
    if (opts.length < 2) { global.UI.toast('对抗检定需要双方（至少一个玩家 + 一个单位）', 'err'); return; }

    var aSel = selectCtl(opts, opts[0].value, null);
    var bSel = selectCtl(opts, opts[opts.length - 1].value, null);
    var aSkill = el('input.input', { type: 'text', value: '格斗', maxlength: 20 });
    var bSkill = el('input.input', { type: 'text', value: '闪避', maxlength: 20 });
    /* v2.5.0（用户第 5 项）：对抗值手输（1–100）。单位没有人物卡 → 必填。 */
    var aBase = el('input.input', { type: 'number', min: '1', max: '100', step: '1',
                                    placeholder: '1-100，单位必填' });
    var bBase = el('input.input', { type: 'number', min: '1', max: '100', step: '1',
                                    placeholder: '1-100，单位必填' });
    var secretChk = el('input', { type: 'checkbox' });
    /** 选中的是不是单位（单位无人物卡 → 必须手输对抗值）。 */
    function isUnit(sel) { return String(sel.value || '').slice(0, 2) === 'a:'; }

    var body = el('div', null, [
      el('div.field', null, [el('label', { text: '甲方' }), aSel]),
      el('div.field', null, [el('label', { text: '甲方技能/属性' }), aSkill]),
      el('div.field', null, [el('label', { text: '甲方对抗值（1-100，单位无卡时必填）' }), aBase]),
      el('div.field', null, [el('label', { text: '乙方' }), bSel]),
      el('div.field', null, [el('label', { text: '乙方技能/属性' }), bSkill]),
      el('div.field', null, [el('label', { text: '乙方对抗值（1-100，单位无卡时必填）' }), bBase]),
      el('div.field', null, [el('label', { text: '秘密对抗（仅 KP 可见结果）' }), secretChk]),
      el('div.tiny.dim', { style: { marginTop: '6px' },
        text: '玩家有卡时对抗值可留空（从人物卡读）；单位没有卡，必须手输 1-100。' }),
      el('button.btn.primary.block', {
        text: '发起对抗检定', style: { marginTop: '12px' },
        onclick: function () {
          var av = intIn(aBase.value, 1, 100);
          var bv = intIn(bBase.value, 1, 100);
          /* 单位侧缺手输值 → 明确拦下（模型侧会按 0 兜底，等于白掷一次）。 */
          if (isUnit(aSel) && av === null) { global.UI.toast('甲方是单位：请填 1-100 的对抗值', 'err'); return; }
          if (isUnit(bSel) && bv === null) { global.UI.toast('乙方是单位：请填 1-100 的对抗值', 'err'); return; }
          /* 填了但不在 1-100 → 也拦下（模型侧对非法手输值是明确报错，不静默截断）。 */
          if (aBase.value !== '' && av === null) { global.UI.toast('甲方对抗值必须是 1-100 的整数', 'err'); return; }
          if (bBase.value !== '' && bv === null) { global.UI.toast('乙方对抗值必须是 1-100 的整数', 'err'); return; }
          ctx.act({ op: 'check.opposed',
                    aSeat: aSel.value, aSkill: M.cleanText(aSkill.value, 20), aBase: av,
                    bSeat: bSel.value, bSkill: M.cleanText(bSkill.value, 20), bBase: bv,
                    secret: !!secretChk.checked });
          global.UI.toast('已发起对抗检定', 'ok');
          api.close();
        }
      })
    ]);
    var api = global.UI.sheet({ title: '通用对抗', body: body });
    return api;
  }

  /** KP 发起攻击对抗（含反击/闪避、武器/伤害式、护甲）。 */
  function kpAttackSheet(ctx) {
    if (!M) boot();
    /* v2.7.0（用户第 3 项）：攻/防方下拉的**玩家侧**不列出已撕卡（死亡 / 永久疯狂）的角色；
       怪物侧仍走 monsterList（存活过滤），不受本次改动影响。 */
    var players = playersOf(ctx).filter(function (m) { return !targetBlocked(m); });
    var monsters = monsterList(ctx);
    if (!players.length && !monsters.length) { global.UI.toast('没有可用的对抗单位', 'err'); return; }

    var attPool = players.map(function (m) {
      return { value: 'pc:' + m.seat, label: (m.charName || m.nickname || '玩家') + '（玩家）', side: 'pc', mem: m };
    }).concat(monsters.map(function (a) {
      return { value: 'mo:' + a.id, label: a.name + '（怪物）', side: 'monster', mon: a };
    }));
    /* 防守方默认优先怪物（KP 常让玩家打怪） */
    var defPool = monsters.map(function (a) {
      return { value: 'mo:' + a.id, label: a.name + '（怪物）', side: 'monster', mon: a };
    }).concat(players.map(function (m) {
      return { value: 'pc:' + m.seat, label: (m.charName || m.nickname || '玩家') + '（玩家）', side: 'pc', mem: m };
    }));

    var aSel = selectCtl(attPool, attPool[0].value, onAttackerChange);
    var dSel = selectCtl(defPool, defPool[0].value, null);
    var aSkill = el('input.input', { type: 'text', value: '格斗', maxlength: 20 });
    var aVal = el('input.input', { type: 'number', value: '50', placeholder: '1-100（怪物必填）' });
    var dSkill = el('input.input', { type: 'text', value: '闪避', maxlength: 20 });
    var reactionSel = selectCtl([
      { value: 'counter', label: '反击（同级攻方胜）' },
      { value: 'dodge', label: '闪避（同级攻方败/免伤）' },
      { value: 'none', label: '不防御' }
    ], 'dodge', null);
    var dVal = el('input.input', { type: 'number', value: '50', placeholder: '1-100（怪物必填）' });
    var dmgI = el('input.input', { type: 'text', value: '1D3', maxlength: 30 });
    var pierceChk = el('input', { type: 'checkbox' });
    var dbI = el('input.input', { type: 'text', value: '0', maxlength: 10 });
    var armorI = el('input.input', { type: 'number', value: '0' });
    var secretChk = el('input', { type: 'checkbox' });
    var hint = el('div.tiny.dim');
    /* 武器下拉：随攻击方变化重建 —— 用容器 + 追踪控件，避免嵌套包装导致 .value 失效。 */
    var wepBox = el('div');
    var wepSel = null;

    function optOf(pool, v) { for (var i = 0; i < pool.length; i++) if (pool[i].value === v) return pool[i]; return pool[0]; }

    function applyWeapon(name) {
      var o = optOf(attPool, aSel.value);
      if (o.side !== 'pc' || !o.mem) return;
      var ws = (o.mem.sheet && o.mem.sheet.weapons) || [];
      var w = null;
      for (var i = 0; i < ws.length; i++) if (ws[i].name === name) w = ws[i];
      if (w) {
        dmgI.value = w.damage || '1D3';
        pierceChk.checked = (w.pierce === '√');
        if (w.skill) aSkill.value = w.skill;
      }
      rebuildShots(w);
    }
    /* v2.3.0（用户第 8 项）：连发武器 → 选择本次发射数（每轮上限由 perRound 解析）。 */
    var shotsBox = el('div');
    var shotsSel = null;
    function rebuildShots(w) {
      global.UI.clear(shotsBox);
      shotsSel = null;
      var max = (w && R && typeof R.burstMaxOf === 'function') ? R.burstMaxOf(w.perRound) : 1;
      if (!w || max <= 1) { shotsBox.style.display = 'none'; return; }
      shotsBox.style.display = '';
      var opts = [];
      for (var n = 1; n <= max; n++) opts.push({ value: String(n), label: '打 ' + n + ' 发' });
      shotsSel = selectCtl(opts, '1', null);
      shotsBox.appendChild(shotsSel);
      shotsBox.appendChild(el('div.tiny.dim', { text: '每轮最多 ' + max + ' 发；每多发一次 +1 惩罚骰。' }));
    }
    function rebuildWeapons() {
      var o = optOf(attPool, aSel.value);
      var opts = [{ value: '', label: '（手动填写伤害）' }];
      if (o.side === 'pc' && o.mem) {
        ((o.mem.sheet && o.mem.sheet.weapons) || []).forEach(function (w) {
          opts.push({ value: w.name, label: w.name + '（' + (w.damage || '') + (w.pierce === '√' ? ' 贯穿' : '') + '）' });
        });
      }
      global.UI.clear(wepBox);
      wepSel = selectCtl(opts, '', function (v) { applyWeapon(v); });
      wepBox.appendChild(wepSel);
    }
    function onAttackerChange() {
      var o = optOf(attPool, aSel.value);
      hint.textContent = o.side === 'pc'
        ? '玩家攻击方：对抗值由权威端读人物卡（下方数值作兜底）。'
        : '怪物攻击方：请手输 1–100 的对抗值。';
      rebuildWeapons();
      if (o.side === 'pc' && o.mem && o.mem.sheet && o.mem.sheet.db) dbI.value = o.mem.sheet.db;
    }
    rebuildWeapons();
    onAttackerChange();

    var body = el('div', null, [
      el('div.sec-title', { text: '攻击方' }),
      el('div.field', null, [el('label', { text: '谁发起' }), aSel]),
      el('div.field', null, [el('label', { text: '攻击技能' }), aSkill]),
      el('div.field', null, [el('label', { text: '攻击方对抗值' }), aVal]),
      hint,
      el('div.sec-title', { text: '防守方' }),
      el('div.field', null, [el('label', { text: '谁防守' }), dSel]),
      el('div.field', null, [el('label', { text: '防守方式' }), reactionSel]),
      el('div.field', null, [el('label', { text: '防守方对抗值' }), dVal]),
      el('div.sec-title', { text: '武器 / 护甲' }),
      el('div.field', null, [el('label', { text: '武器（选填，自动带伤害）' }), wepBox]),
      el('div.field', { style: { marginTop: '8px' } }, [el('label', { text: '本次发射数（连发武器）' }), shotsBox]),
      el('div.field', null, [el('label', { text: '伤害式' }), dmgI]),
      el('div.field', null, [el('label', { text: '贯穿（√）' }), pierceChk]),
      el('div.field', null, [el('label', { text: '伤害加值 DB' }), dbI]),
      el('div.field', null, [el('label', { text: '目标护甲' }), armorI]),
      el('div.field', null, [el('label', { text: '秘密对抗（仅 KP 可见）' }), secretChk]),
      el('button.btn.primary.block', {
        text: '⚔ 发起攻击对抗', style: { marginTop: '12px' },
        onclick: function () {
          var ao = optOf(attPool, aSel.value);
          var dobj = optOf(defPool, dSel.value);
          if (ao.side === 'monster' && intIn(aVal.value, 1, 100) === null) {
            global.UI.toast('攻击方（怪物）对抗值需为 1–100 的整数', 'err'); return;
          }
          if (dobj.side === 'monster' && intIn(dVal.value, 1, 100) === null) {
            global.UI.toast('防守方（怪物）对抗值需为 1–100 的整数', 'err'); return;
          }
          ctx.act({
            op: 'check.opposed', attack: true,
            attacker: {
              side: ao.side, seat: ao.side === 'pc' ? ao.mem.seat : '',
              actorId: ao.side === 'monster' ? ao.mon.id : '',
              name: ao.side === 'pc' ? (ao.mem.charName || ao.mem.nickname || '玩家') : ao.mon.name,
              skill: M.cleanText(aSkill.value, 20) || '格斗',
              value: ao.side === 'monster' ? intIn(aVal.value, 1, 100) : undefined, ranged: false
            },
            defender: {
              side: dobj.side, seat: dobj.side === 'pc' ? dobj.mem.seat : '',
              actorId: dobj.side === 'monster' ? dobj.mon.id : '',
              name: dobj.side === 'pc' ? (dobj.mem.charName || dobj.mem.nickname || '玩家') : dobj.mon.name,
              skill: M.cleanText(dSkill.value, 20) || '闪避',
              value: dobj.side === 'monster' ? intIn(dVal.value, 1, 100) : undefined,
              reaction: reactionSel.value
            },
            weapon: { name: (wepSel && wepSel.value) || '武器', damage: M.cleanText(dmgI.value, 30) || '1D3',
                      pierce: pierceChk.checked ? '√' : '×', db: M.cleanText(dbI.value, 10) || '0' },
            shots: shotsSel ? parseInt(shotsSel.value, 10) : 1,
            armor: { value: Math.max(0, parseInt(armorI.value, 10) || 0) },
            secret: !!secretChk.checked
          });
          global.UI.toast('已发起攻击对抗', 'ok');
          api.close();
        }
      })
    ]);
    var api = global.UI.sheet({ title: '攻击对抗', body: body });
    return api;
  }

  /* ---------------- 玩家侧：武器对抗 ---------------- */

  /** 玩家发起武器对抗（选武器 + 选怪 → 推送 KP）。 */
  function playerOpposedSheet(ctx) {
    if (!M) boot();
    if (ctx.role !== 'player') { global.UI.toast('只有玩家能发起武器对抗', 'err'); return; }
    /* v2.6.0（用户第 3 项）：打开面板时**再校验一次轮次** —— 防止按钮状态过期
       （例如面板打开期间 KP 已推进到别人的回合）。与 isMyTurn 同一口径。 */
    var c = combatOf(ctx);
    var cur = (c && c.order) ? c.order[c.turn] : null;
    if (!c || !isMyTurn(ctx, cur)) {
      global.UI.toast('现在不是你的行动轮次，只能在轮到你时发起战斗对抗', 'err');
      return;
    }
    var me = findMe(ctx);
    var ws = (me && me.sheet && Array.isArray(me.sheet.weapons)) ? me.sheet.weapons : [];
    if (!ws.length) { global.UI.toast('你的角色卡里还没有武器（请先在车卡里添加）', 'err'); return; }
    var monsters = monsterList(ctx);
    if (!monsters.length) { global.UI.toast('没有可选的怪物（请让 KP 先设置怪物并进入战斗）', 'err'); return; }

    /* v2.3.0（用户第 8 项）：连发武器 —— 每轮最多发射数 >1 时选择本次打几发。
       · ≤2 发：**必须选**（权威端会拒绝未选择的申请）；
       · ≥3 发：可任选 1..max（同一轮每多发一次 +1 惩罚骰，由权威端累计）。 */
    function burstMaxOfSel() {
      var w = null;
      for (var i = 0; i < ws.length; i++) if (ws[i].name === wSel.value) w = ws[i];
      if (!w) return 1;
      return (R && typeof R.burstMaxOf === 'function') ? R.burstMaxOf(w.perRound) : 1;
    }
    var shotsBox = el('div');
    var shotsSel = null;
    function rebuildShots() {
      var max = burstMaxOfSel();
      global.UI.clear(shotsBox);
      shotsSel = null;
      if (max <= 1) { shotsBox.style.display = 'none'; return; }
      shotsBox.style.display = '';
      var opts = [];
      for (var n = 1; n <= max; n++) opts.push({ value: String(n), label: '打 ' + n + ' 发' });
      shotsSel = selectCtl(opts, '1', null);
      shotsBox.appendChild(shotsSel);
      shotsBox.appendChild(el('div.tiny.dim', {
        text: '每轮最多 ' + max + ' 发；同一轮每多发一次 +1 惩罚骰。'
      }));
    }
    var wSel = selectCtl(ws.map(function (w) {
      return { value: w.name, label: w.name + '（' + (w.damage || '') + (w.pierce === '√' ? ' 贯穿' : '') + '）' };
    }), ws[0].name, function () { rebuildShots(); });
    rebuildShots();
    var tSel = selectCtl(monsters.map(function (a) { return { value: a.id, label: a.name }; }), monsters[0].id, null);
    var noteI = el('input.input', { type: 'text', placeholder: '备注（可空）', maxlength: 80 });

    var body = el('div', null, [
      el('div.tiny.dim', { text: '选择武器与目标，发送后由 KP 处理（KP 会为其选反击/闪避并输入对抗值）。' }),
      el('div.field', null, [el('label', { text: '武器' }), wSel]),
      el('div.field', null, [el('label', { text: '目标怪物' }), tSel]),
      el('div.field', { style: { marginTop: '8px' } }, [el('label', { text: '本次发射数' }), shotsBox]),
      el('div.field', null, [el('label', { text: '备注' }), noteI]),
      el('button.btn.primary.block', {
        text: '⚔ 发送对抗申请', style: { marginTop: '12px' },
        onclick: function () {
          var w = null;
          for (var i = 0; i < ws.length; i++) if (ws[i].name === wSel.value) w = ws[i];
          var target = null;
          for (var j = 0; j < monsters.length; j++) if (monsters[j].id === tSel.value) target = monsters[j];
          if (!w || !target) { global.UI.toast('请选择武器与目标', 'err'); return; }
          var bmax = (R && typeof R.burstMaxOf === 'function') ? R.burstMaxOf(w.perRound) : 1;
          var shots = shotsSel ? parseInt(shotsSel.value, 10) : 1;
          if (bmax === 2 && shots !== 1 && shots !== 2) {
            global.UI.toast('该武器每轮最多 2 发，请先选择打 1 发 / 打 2 发', 'err'); return;
          }
          if (!(shots >= 1 && shots <= Math.max(1, bmax))) shots = 1;
          ctx.intent(M.INTENT.OPPOSED, {
            phase: 'request',
            weapon: { name: w.name, skill: w.skill, damage: w.damage, pierce: w.pierce },
            db: (me.sheet && me.sheet.db) || '0',
            targetId: target.id, targetName: target.name,
            shots: shots,
            note: M.cleanText(noteI.value, 80)
          });
          global.UI.toast('已发送对抗申请，等待 KP 处理', 'ok');
          api.close();
        }
      })
    ]);
    var api = global.UI.sheet({ title: '⚔ 武器对抗', key: 'opposed', body: body });
    return api;
  }

  /** KP 裁定玩家申请：选反击/闪避 + 输入怪物对抗值（1–100）+ 护甲 → 提交。 */
  function opposedResolveSheet(ctx, req) {
    if (!M) boot();
    req = req || (ctx.st && ctx.st.opposed);
    if (!req || req.phase !== 'await_kp') { global.UI.toast('没有待处理的对抗申请', 'err'); return; }
    var reactionSel = selectCtl([
      { value: 'counter', label: '反击（同级：攻击方胜）' },
      { value: 'dodge', label: '闪避（同级：攻击方败/被躲开）' }
    ], 'counter', null);
    var valI = el('input.input', { type: 'number', value: '50', placeholder: '1-100' });
    var armorI = el('input.input', { type: 'number', value: '0' });
    var secretChk = el('input', { type: 'checkbox' });
    /* v2.4.0（用户第 ⑧ 项）：「无法反抗」—— 勾选后跳过对抗判定（怪物不掷防守骰），
       玩家武器对抗自动成功并直接进入伤害判定；此时不需要（也不能）填怪物对抗值。 */
    var noDefChk = el('input', { type: 'checkbox' });
    noDefChk.onchange = function () {
      var nd = !!noDefChk.checked;
      reactionSel.disabled = nd;
      valI.disabled = nd;
      if (nd) { valI.value = ''; valI.placeholder = '无法反抗：无需对抗值'; }
      else { valI.placeholder = '1-100'; if (!valI.value) valI.value = '50'; }
    };
    var w = req.weapon || {};

    /* v2.3.0（用户第 8 项）：连发信息 —— 本次发射数 / 每轮上限 / 本次惩罚骰。 */
    var burstMax = (R && typeof R.burstMaxOf === 'function') ? R.burstMaxOf(w.perRound) : 1;
    var shots = (req.shots >= 1) ? req.shots : 1;
    var burstInfo = (burstMax > 1)
      ? ('连发：本次 ' + shots + ' 发 / 每轮最多 ' + burstMax + ' 发；同一轮每多发一次 +1 惩罚骰（权威端累计）。')
      : '';
    /* v2.3.0（用户第 10 项）：枪械故障 —— 掷出值 ≥ 故障值判故障；KP 可在此指定故障类型
       （不指定则按武器类型自动：左轮→哑火、连发→供弹故障、其它→卡弹）。 */
    var malfTh = (R && typeof R.malfunctionThresholdOf === 'function') ? R.malfunctionThresholdOf(w) : 0;
    var malfSel = null;
    if (malfTh > 0) {
      malfSel = selectCtl([
        { value: '', label: '按武器类型自动（推荐）' },
        { value: 'jam', label: '卡弹（1D6 轮清除）' },
        { value: 'feed', label: '供弹故障（1D4+2 轮）' },
        { value: 'dud', label: '哑火（浪费 1 回合）' },
        { value: 'burst', label: '炸膛（1D3−1 伤害 + 武器报废）' }
      ], '', null);
    }

    var body = el('div', null, [
      el('div.tiny.dim', { text: (req.byName || '玩家') + ' 用「' + (w.name || '武器') +
        '」对抗 ' + (req.targetName || '怪物') + '（伤害式 ' + (w.damage || '—') + ' · DB ' + (req.db || '0') + '）' }),
      burstInfo ? el('div.tiny.dim', { text: burstInfo }) : null,
      malfTh > 0 ? el('div.tiny.dim', { text: '该武器故障值 ' + malfTh + '：攻击掷出值 ≥ 该值即判故障。' }) : null,
      el('div.field', null, [el('label', { text: '怪物的防守方式' }), reactionSel]),
      el('div.field', null, [el('label', { text: '怪物对抗值（1-100）' }), valI]),
      el('div.field', null, [el('label', { text: '无法反抗（跳过对抗判定，自动命中）' }), noDefChk]),
      el('div.field', null, [el('label', { text: '怪物护甲' }), armorI]),
      malfSel ? el('div.field', null, [el('label', { text: '若发生故障，指定故障类型' }), malfSel]) : null,
      el('div.field', null, [el('label', { text: '秘密对抗（仅 KP 可见结果）' }), secretChk]),
      el('button.btn.primary.block', {
        text: '同意并裁定', style: { marginTop: '12px' },
        onclick: function () {
          var noDef = !!noDefChk.checked;
          var v = 0;
          if (!noDef) {
            v = intIn(valI.value, 1, 100);
            if (v === null) { global.UI.toast('对抗值需为 1–100 的整数', 'err'); return; }
          }
          ctx.act({ op: 'check.opposed', reqId: req.id, attack: true,
                    noDefense: noDef,
                    defender: { reaction: noDef ? 'none' : reactionSel.value, value: v },
                    armor: { value: Math.max(0, parseInt(armorI.value, 10) || 0) },
                    malfType: malfSel ? malfSel.value : '',
                    secret: !!secretChk.checked });
          global.UI.toast(noDef ? '已裁定（怪物无法反抗，自动命中）' : '已裁定', 'ok');
          api.close();
        }
      })
    ]);
    var api = global.UI.sheet({ title: '裁定对抗申请', body: body });
    return api;
  }

  /** 玩家胜后选怪（多怪时）→ 结算武器伤害。 */
  function playerTargetSheet(ctx) {
    if (!M) boot();
    var op = ctx.st && ctx.st.opposed;
    if (!op || op.phase !== 'await_target') { global.UI.toast('当前没有待选择的对抗目标', 'err'); return; }
    var list = (Array.isArray(op.monsters) && op.monsters.length) ? op.monsters : monsterList(ctx);
    if (!list.length) { global.UI.toast('没有可选的怪物', 'err'); return; }
    var body = el('div');
    body.appendChild(el('div.tiny.dim', { text: '对抗胜利！请选择要造成伤害的目标：' }));
    var api;
    list.forEach(function (a) {
      body.appendChild(el('div.actor-line.monster', {
        onclick: function () { ctx.intent(M.INTENT.OPPOSED, { phase: 'target', targetId: a.id }); if (api) api.close(); }
      }, [el('div.grow', null, [el('div.nm', { text: a.name || '怪物' })])]));
    });
    api = global.UI.sheet({ title: '⚔ 选择伤害目标', body: body });
    return api;
  }

  /** KP 待处理对抗申请卡（kpPanel 顶部显示）。 */
  function kpOpposedPendingCard(ctx, op) {
    var card = el('div.card', null, [
      el('div.card-head', null, [el('h3', { text: '待处理对抗申请' }), el('span.hint', { text: '1 项' })])
    ]);
    card.appendChild(el('div.pending-row', null, [
      el('div.grow', null, [
        el('div', { text: (op.byName || '玩家') + ' 用「' + ((op.weapon && op.weapon.name) || '武器') + '」对抗 ' + (op.targetName || '怪物') }),
        el('div.tiny.dim', { text: '伤害式 ' + ((op.weapon && op.weapon.damage) || '—') + ' · DB ' + (op.db || '0') + (op.note ? (' · ' + op.note) : '') })
      ]),
      el('button.btn.sm.primary', { text: '同意并裁定', onclick: function () { opposedResolveSheet(ctx, op); } }),
      el('button.btn.sm.ghost', {
        text: '拒绝',
        onclick: function () { ctx.act({ op: 'check.opposed', reqId: op.id, cancel: true }); rerender(ctx); }
      })
    ]));
    return card;
  }


  /* ============================================================
   * 新增弹层 · 续玩入口（列出本机未完结的团 → 恢复）
   * ⚠️ 真正的「恢复」需要走房间入口的连接流程（F1 的 room-ui.js）。
   *    这里优先调用 F1 暴露的 RoomUI.resumeRoom(code)；没有则退回 ctx.act。
   * ============================================================ */

  function resumeSheet(ctx) {
    if (!M) boot();
    var RS = global.RoomStore;
    var unfinished = [];
    try { if (RS && RS.listUnfinished) unfinished = RS.listUnfinished() || []; }
    catch (e) { unfinished = []; }
    var archives = [];
    try { if (RS && RS.listArchive) archives = RS.listArchive() || []; }
    catch (e) { archives = []; }
    var mine = (RS && RS.getMine) ? RS.getMine() : null;

    var body = el('div');
    /* v2.0.2：本机有「未生效」临时卡时，先列出并允许「生效」（入口页/续玩列表复用同款样式） */
    var tcSec = tempCardsSection();
    if (tcSec) body.appendChild(tcSec);

    function goResume(code, saveId, btn) {
      /* #10（用户报）：点「继续」→ 真正连上之间，按钮要有明确等待态（原来只有通用连接文案，
         用户注意不到）。连上后由 RoomUI 的横幅与顶栏连接态接管。 */
      if (btn) { try { btn.textContent = '正在连接…'; btn.disabled = true; } catch (e) { /* 忽略 */ } }
      if (global.RoomUI && typeof global.RoomUI.resumeRoom === 'function') {
        global.RoomUI.resumeRoom(code, saveId);
        api.close();
        return;
      }
      if (!saveId && ctx && ctx.act) { ctx.act({ op: 'room.resume', code: code }); api.close(); return; }
      global.UI.toast('无法恢复：缺少入口', 'err');
    }

    /* ① v2.0.2 T5：本机「未完结的团」（本地存档接线）—— 点「继续」走真正的恢复流程 */
    if (unfinished.length) {
      body.appendChild(el('div.sec-title', { text: '未完结的团（' + unfinished.length + '）' }));
      var ul = scrollBox(null, []);
      unfinished.forEach(function (r) {
        var code = r.code || '';
        ul.appendChild(el('div.actor-line', null, [
          el('div.grow', null, [
            el('div.nm', { text: r.name || ('房间 ' + code) }),
            el('div.tiny.dim', {
              text: (r.role === 'kp' ? 'KP' : (r.role === 'spectator' ? '旁观' : '玩家')) +
                    ' · 房间号 ' + code + (r.hasSave ? (' · seq ' + (r.seq || 0)) : '')
            })
          ]),
          el('button.btn.sm.primary', {
            text: '继续', onclick: function (e) { goResume(code, undefined, e && e.target); }
          })
        ]));
      });
      body.appendChild(ul);
    }

    /* ② v2.0.2 T5：KP 本房在服务端的「命名存档槽」（改天凑齐人再开）—— 需联网，失败降级 */
    if (mine && mine.code && global.RoomNet && global.RoomNet.listSaves) {
      var savesBox = el('div');
      savesBox.appendChild(el('div.sec-title', { text: '云端存档槽 · ' + (mine.name || mine.code) }));
      /* v2.0.2 T5 补漏：这里原先只能「列出 + 载入」，没有任何创建入口
         （createSave 零调用）→ KP 其实存不了。补一个保存按钮。 */
      savesBox.appendChild(el('button.btn.sm.block', {
        text: '💾 保存本局（新建存档槽）',
        onclick: function () { saveSlotsSheet(ctx); }
      }));
      var savesList = el('div');
      savesList.appendChild(el('div.tiny.dim', { text: '正在读取…' }));
      savesBox.appendChild(savesList);
      body.appendChild(savesBox);
      global.RoomNet.listSaves(mine.code, mine.hostToken).then(function (j) {
        global.UI.clear(savesList);
        var saves = (j && j.saves) || [];
        if (!saves.length) {
          savesList.appendChild(el('div.tiny.dim', { text: '还没有云端存档槽。' }));
          return;
        }
        saves.forEach(function (s) {
          savesList.appendChild(el('div.actor-line', null, [
            el('div.grow', null, [
              el('div.nm', { text: s.name || ('存档 ' + s.saveId) }),
              el('div.tiny.dim', {
                text: 'seq ' + (s.seq || 0) +
                      (s.updatedAt ? (' · ' + timeText(s.updatedAt * 1000)) : '')
              })
            ]),
            el('button.btn.sm.primary', {
              text: '载入并续玩', onclick: function (e) { goResume(mine.code, s.saveId, e && e.target); }
            })
          ]));
        });
      }, function () {
        global.UI.clear(savesList);
        savesList.appendChild(el('div.tiny.dim', {
          text: '读取云端存档失败（网络不可用 / 未配置服务）。本机存档仍可用。'
        }));
      });
    }

    /* ③ 归档（只读回看） */
    if (archives.length) {
      body.appendChild(el('div.sec-title', { text: '已结团归档（' + archives.length + '）' }));
      var list = scrollBox(null, []);
      archives.forEach(function (rec) {
        var code = rec.code || '';
        list.appendChild(el('div.actor-line', null, [
          el('div.grow', null, [
            el('div.nm', { text: rec.name || ('房间 ' + code) }),
            el('div.tiny.dim', { text: '房间号 ' + code + (rec.endedAt ? (' · ' + timeText(rec.endedAt)) : '') })
          ]),
          el('button.btn.sm', {
            text: '回看', onclick: function () {
              if (global.RoomUI && typeof global.RoomUI.resumeRoom === 'function') {
                global.RoomUI.resumeRoom(code);
                api.close();
                return;
              }
              if (ctx && ctx.act) { ctx.act({ op: 'room.resume', code: code }); api.close(); return; }
              global.UI.toast('无法恢复：缺少入口', 'err');
            }
          })
        ]));
      });
      body.appendChild(list);
    }

    if (!tcSec && !unfinished.length && !archives.length && !(mine && mine.code)) {
      body.appendChild(el('div.tiny.dim', { text: '本机没有可续玩的团。' }));
    }
    var api = global.UI.sheet({ title: '续玩', body: body });
    return api;
  }

  /* ============================================================
   * 战斗：辅助弹层（加单位 / 结算伤害）
   * ============================================================ */

  /**
   * 加入战斗单位。
   * @param {object} opts
   *   opts.preCombat  true=开战前（写入候选池，不产生事件）；false/省略=战斗中（combat.actor）
   *   opts.onAdded    添加完成回调（用于刷新外层弹层）
   */
  function addActorSheet(ctx, opts) {
    opts = opts || {};
    var nameI = el('input.input', { type: 'text', value: '新单位', maxlength: 24 });
    var dexI = el('input.input', { type: 'number', value: '50' });
    var hpI = el('input.input', { type: 'number', value: '10' });
    var actI = el('input.input', { type: 'number', value: '1' });
    var kindSel = selectCtl([
      { value: 'monster', label: '怪物（血量隐藏）' },
      { value: 'npc', label: 'NPC' }
    ], 'monster', null);
    var body = el('div', null, [
      el('div.field', null, [el('label', { text: '名称' }), nameI]),
      el('div.field', null, [el('label', { text: '类型' }), kindSel]),
      el('div.field', null, [el('label', { text: 'DEX' }), dexI]),
      el('div.field', null, [el('label', { text: 'HP' }), hpI]),
      el('div.field', null, [el('label', { text: '每轮行动次数' }), actI]),
      el('button.btn.primary.block', {
        text: opts.preCombat ? '加入候选池' : '加入战斗', style: { marginTop: '12px' },
        onclick: function () {
          var actor = {
            id: 'x' + Date.now() + Math.floor(Math.random() * 1000),
            name: M.cleanText(nameI.value, 24) || '单位',
            kind: kindSel.value, dex: +dexI.value || 0,
            hp: +hpI.value || 0, hpMax: +hpI.value || 0,
            actionsPerRound: Math.max(1, +actI.value || 1)
          };
          if (opts.preCombat) {
            addPendingActor(ctx, actor);
            global.UI.toast('已加入候选池', 'ok');
          } else {
            ctx.act({ op: 'combat.actor', actor: actor });
          }
          api.close();
          if (opts.onAdded) opts.onAdded();
        }
      })
    ]);
    var api = global.UI.sheet({ title: opts.preCombat ? '新增怪物 / NPC' : '加入战斗单位', body: body });
    return api;
  }

  function damageSheet(ctx, slot) {
    var dmgI = el('input.input', { type: 'number', value: '1', min: '0' });
    var sumI = el('input.input', { type: 'text', placeholder: '如：爪击', maxlength: 30 });
    var body = el('div', null, [
      el('div.tiny.dim', { text: '目标：' + (slot.name || '') }),
      el('div.field', null, [el('label', { text: '伤害值' }), dmgI]),
      el('div.field', null, [el('label', { text: '说明（可选）' }), sumI]),
      el('button.btn.danger.block', {
        text: '结算', style: { marginTop: '12px' },
        onclick: function () {
          ctx.act({ op: 'combat.damage', slotId: slot.id, damage: +dmgI.value || 0, summary: M.cleanText(sumI.value, 30) });
          api.close();
        }
      })
    ]);
    var api = global.UI.sheet({ title: '结算伤害', body: body });
    return api;
  }

  /* ============================================================
   * 掷骰工具条（D100 突出 + 奖惩骰；KP 用）
   * ============================================================ */

  function diceBar(ctx) {
    if (!M) boot();
    var isSpec = ctx.role === 'spectator';
    /* v2.11.0（用户第 2 项）：玩家整体操作锁 —— 昏迷/濒死/已撕卡/疯狂发作中 禁用工具栏按钮；
       与模型全局 intent 锁同判据（playerOperationLocked）。KP 无角色卡，findMe 返回 null，不参与此锁。
       「⏩ 推进 1 轮」在玩家信息卡 plCharacterCard() 里，不受此锁影响。 */
    var me = findMe(ctx);
    var opLocked = me ? playerOperationLocked(me) : false;
    var bonus = UI_STATE.d100Mod.bonus || 0, penalty = UI_STATE.d100Mod.penalty || 0;

    var d100 = el('button.dice-d100', {
      text: 'D100', disabled: (isSpec || opLocked),
      onclick: function () { doRoll(ctx, bonus, penalty); }
    });
    /* v2.4.0（用户第 ⑩ 项）：奖惩骰控件重做为「选项式」—— 先选「奖励骰 / 惩罚骰」，
       再用 −/+ 调该侧数量（0–5；0 以下不允许，静默夹到 0）。
       旧实现是「一颗带符号的数（bonus−penalty）+ 两个各自只增不减的计数器」：
       · 从 0 点「−」数字变负，再点「+」是给**奖励骰**计数而非回到 0
         （用户实录：「从 0 点 − 提示奖励骰最多 5 个」「点到 5 之后只能减不能加」）；
       · 正负同一颗数表示奖/惩，语义本身容易出问题（用户建议一并去掉）。
       新控件与场景检定推送里的奖惩骰选择器（用户确认正常）口径一致：奖/惩分离、
       各自 0–5、上限提示文案随当前侧变化。KP 与玩家共用同一控件（diceBar 两处挂载），
       普通 D100 与推送检定看到的行为一致。 */
    var MOD_MAX = 5;
    var mode = (bonus <= 0 && penalty > 0) ? 'penalty' : 'bonus';   // 初始落在有值的那一侧
    /* v2.11.2（用户报 Bug）：奖惩骰**互斥**不变量兜底 —— 若 UI_STATE 里两侧都有值
       （旧状态残留 / 其他写入路径），按当前 mode 只保留一侧，杜绝「奖惩并存」进入投掷。 */
    if (mode === 'bonus') { if (penalty > 0) penalty = 0; } else { if (bonus > 0) bonus = 0; }
    var bonusChip = el('button.chip.bonus' + (mode === 'bonus' ? '.on' : ''), {
      text: '奖励骰', title: '选中后，用 −/+ 调整奖励骰数量（0–5）'
    });
    var penaltyChip = el('button.chip.penalty' + (mode === 'penalty' ? '.on' : ''), {
      text: '惩罚骰', title: '选中后，用 −/+ 调整惩罚骰数量（0–5）'
    });
    var minusBtn = el('button', { text: '−', title: '当前侧减 1 个（不小于 0）' });
    var plusBtn = el('button', { text: '+', title: '当前侧加 1 个（最多 5 个）' });
    var cnt = el('span.cnt', { text: String(mode === 'bonus' ? bonus : penalty) });
    var eff = el('span.eff', { text: '' });
    function effText() {
      if (bonus > 0 && penalty > 0) return '奖 ' + bonus + ' · 惩 ' + penalty;
      if (bonus > 0) return '奖励骰 ' + bonus;
      if (penalty > 0) return '惩罚骰 ' + penalty;
      return '不修正';
    }
    function sync() {
      cnt.textContent = String(mode === 'bonus' ? bonus : penalty);
      bonusChip.className = 'chip bonus' + (mode === 'bonus' ? ' on' : '');
      penaltyChip.className = 'chip penalty' + (mode === 'penalty' ? ' on' : '');
      eff.textContent = effText();
      UI_STATE.d100Mod = { bonus: bonus, penalty: penalty };
    }
    function bump(delta) {
      var next = (mode === 'bonus' ? bonus : penalty) + delta;
      if (next > MOD_MAX) {
        global.UI.toast((mode === 'bonus' ? '奖励骰' : '惩罚骰') + '最多 ' + MOD_MAX + ' 个', 'err');
        return;
      }
      if (next < 0) next = 0;    // 0 以下不允许：静默夹到 0（与场景检定推送控件一致）
      if (mode === 'bonus') bonus = next; else penalty = next;
      sync();
    }
    /* v2.11.2（用户报 Bug）：切到一侧就**清空另一侧** —— 旧实现只切 mode、不动数值，
       「N 奖励 + M 惩罚」可同时存在，玩家不易察觉（模型侧虽会先抵消，但展示与意图
       对不上，极易让人误判检定结果）。点「已选中」的那一侧不触发清空（那不是切换）。 */
    function pickSide(next) {
      if (mode !== next) {
        if (next === 'bonus') penalty = 0; else bonus = 0;
        mode = next;
      }
      sync();
    }
    bonusChip.addEventListener('click', function () { pickSide('bonus'); });
    penaltyChip.addEventListener('click', function () { pickSide('penalty'); });
    minusBtn.addEventListener('click', function () { bump(-1); });
    plusBtn.addEventListener('click', function () { bump(1); });
    sync();

    /* #11（用户原话「常用骰子和自定义骰子增加暗骰功能」）：这里不是加一个孤立按钮，而是给
       骰子行一个**开关态** —— 开态下**任何**投掷（D100 / D4-D10 / 自定义骰式）都走 dice.dark。 */
    var darkBtn = el('button.dice-small' + (UI_STATE.darkRoll ? '.on' : ''), {
      text: '🕶 暗骰' + (UI_STATE.darkRoll ? '：开' : '：关'),
      disabled: (isSpec || opLocked),
      title: '开启后：投掷结果只进你的「只给你看的信息」，公开记录只写「KP 暗骰了一次」',
      onclick: function () { UI_STATE.darkRoll = !UI_STATE.darkRoll; rerender(ctx); }
    });

    var bar = el('div.dice-bar', null, [
      d100,
      el('div.bp', null, [bonusChip, penaltyChip, minusBtn, cnt, plusBtn, eff]),
      el('span.k', { text: '（点 D100 掷一次）' }),
      darkBtn
    ]);

    ['D4', 'D6', 'D8', 'D10'].forEach(function (d) {
      bar.appendChild(el('button.dice-small', {
        text: d, disabled: (isSpec || opLocked),
        onclick: function () { doRollExpr(ctx, '1' + d); }
      }));
    });

    /* 扩展按钮：技能检定 / 自定义骰子 / 战斗对抗 / SAN Check / 临时状态 / 施救 / 物品道具 / 规则参考 */
    var extra = el('div.dice-extra');
    var inCombat = (((ctx.st || {}).meta || {}).mode === 'COMBAT');
    var isPlayer = (ctx.role === 'player');
    /* v2.2.1（用户第 3 项）：玩家「战斗对抗」入口 —— 位置固定在
       「自定义骰子之后、SAN Check 之前」；**仅玩家可见**且**仅战斗模式可用**
       （探索态禁用 + 悬停提示）。KP 走 KP 工具里的「⚔ 对抗」二级菜单，不重复。 */
    /* v2.6.0（用户第 3 项）：**只在玩家自己的行动轮次**可用 —— 与模型侧
       `_isMyActionTurn` / room-panels.js#isMyTurn 同一口径（当前行动槽须为本人 pc 槽）。
       ⚠️ 只拦「发起」；被攻击时的反击/闪避走 KP 的 check.opposed，与此无关。 */
    var _combatCur = (ctx.st && ctx.st.combat) ? (((ctx.st.combat.order) || [])[ctx.st.combat.turn]) : null;
    var _myTurnNow = inCombat && isMyTurn(ctx, _combatCur);
    var opposedBtn = el('button.dice-small' + (_myTurnNow ? '' : '.dim'), {
      text: '⚔ 战斗对抗',
      disabled: !_myTurnNow || opLocked,
      title: !inCombat ? '战斗对抗仅在战斗模式可用：请让 KP 先进入战斗'
                       : (!_myTurnNow ? '现在不是你的行动轮次，只能在轮到你时发起战斗对抗'
                                      : '选择武器与目标，发起武器对抗（需 KP 裁定）'),
      onclick: function () { playerOpposedSheet(ctx); }
    });
    [
      /* v2.11.2（用户报「技能检定入口不见了，我记得有啊」）：把「🎯 技能检定」补回**真实**工具栏。
         ⚠️ 历史教训（v2.11.2 同轮修 🩺 按钮时挖出）：该按钮此前只存在于遗留死代码
         `plBottomBar()`（全仓 0 调用方、从未挂载）里，玩家**从未真正见过它** ——
         这次直接落在 diceBar（room-ui.js:3969/3996 两处挂载的那个），补票上车。
         复用既有 `skillCheckSheet(ctx,'skill')`：从绑定角色卡的技能里选一个掷 D100
         （按技能值判定）；没有技能数据时降级为「手动输技能名 + 目标值」；KP 亦可用来给 NPC 掷。
         战斗侧**不重复**入口 —— diceBar 已有「⚔ 战斗对抗」（武器对抗，限自己行动轮次），
         与原 plBottomBar 里的「⚔️ 战斗检定」是两套不同流程，后者不再单列，避免入口冗余。 */
      ['🎯 技能检定', function () { skillCheckSheet(ctx, 'skill'); }],
      ['🎲 自定义骰子', function () { customDiceSheet(ctx); }],
      null,                                              // 占位：插入「战斗对抗」（仅玩家，见下）
      ['🧠 SAN Check', function () { sanCheckSheet(ctx); }],
      ['🩹 临时状态', function () { tempStateSheet(ctx); }],
      /* v2.11.0（用户第 3 项）：玩家自助「🩺 急救/医疗/精神分析」入口 —— 内部走 KP 审批
         （aidPlayerSheet 内 ctx.intent(ACT, {op:'aid.apply'|'aid.psycho'})）。
         p[2]='pl' → **仅玩家可见**：KP 已有自己的「🚑 急救/医疗」（KP 工具），此处不重复。 */
      ['🩺 急救/医疗/精神分析', function () { aidPlayerSheet(ctx); }, 'pl'],
      /* v2.4.0（用户第 ⑬ 项）：KP 视角删「物品道具」入口 —— 该面板是玩家侧
         「查看 / 使用 KP 发放的物品」；KP 的发放入口在 KP 工具「🎒 给物品」，
         不在这里重复（用户实测要求）。p[2]='pl' → 仅玩家可见。 */
      ['🎒 物品道具', function () { itemsSheet(ctx); }, 'pl'],
      ['📖 规则参考', function () { rulesSheet(ctx); }]
    ].forEach(function (p) {
      if (p === null) { if (isPlayer) extra.appendChild(opposedBtn); return; }
      if (p[2] === 'pl' && ctx.role !== 'player') return;
      extra.appendChild(el('button.dice-small', { text: p[0], disabled: isSpec || opLocked, onclick: p[1] }));
    });
    bar.appendChild(extra);
    return bar;
  }

  /** 直接掷一个普通骰式（1D6 等），走玩家直投通道（权威端掷） */
  /** 解析 NDM 骰式 → { count, sides }（暗骰的**冻结 payload** 需要 count/sides，不是 expr）。 */
  function parseDiceExpr(expr) {
    var m = /^\s*(\d*)\s*[dD]\s*(\d+)\s*$/.exec(String(expr || ''));
    if (!m) return null;
    var count = m[1] ? parseInt(m[1], 10) : 1;
    var sides = parseInt(m[2], 10);
    if (!(count >= 1 && count <= 20) || !(sides >= 2 && sides <= 1000)) return null;
    return { count: count, sides: sides };
  }

  function doRollExpr(ctx, expr) {
    /* #11：暗骰开关态下，自定义骰式也走 dice.dark（payload 用 count/sides）。 */
    if (ctx.role === 'kp' && UI_STATE.darkRoll) {
      var spec = parseDiceExpr(expr);
      if (!spec) { global.UI.toast('暗骰暂只支持 NDM 骰式（如 1D100 / 2D6）', 'err'); return; }
      ctx.act({ op: 'dice.dark', sides: spec.sides, count: spec.count, bonus: 0, reason: '' });
      return;
    }
    if (ctx.role === 'kp') {
      if (!R) boot();
      var rr = R.rollExpr(expr);
      if (!rr || !rr.ok) { global.UI.toast((rr && rr.reason) || '骰式不合法', 'err'); return; }
      ctx.act({ op: 'dice.roll', expr: expr, label: '', result: { rolls: rr.rolls, value: rr.total } });
      return;
    }
    /* v2.1.4（用户第 4 项 ·「玩家的暗骰开关没生效」）：
       以前暗骰只对 KP 生效（下面两处判断都写了 role==='kp'），玩家打开开关后
       掷出来照样是明骰、直接进公共记录 —— 开关对玩家形同不存在。
       现在玩家的直投意图带上 secret，由权威端把结果只发给「本人 + KP」，
       公共记录只留一句「XX 暗骰了一次」。 */
    ctx.intent(M.INTENT.DICE, { expr: expr, direct: true, secret: !!UI_STATE.darkRoll });
    global.UI.toast(UI_STATE.darkRoll ? ('暗骰 ' + expr + '…（只有你与 KP 看得到）')
                                      : ('掷 ' + expr + '…'), 'ok');
  }

  function doRoll(ctx, bonus, penalty) {
    if (!R) boot();
    /* #11：暗骰开关态 —— KP 的 D100 也走 dice.dark（结果只进 KP 私密，不公开）。 */
    if (ctx.role === 'kp' && UI_STATE.darkRoll) {
      ctx.act({ op: 'dice.dark', sides: 100, count: 1,
                bonus: (bonus || 0) - (penalty || 0), reason: '' });
      return null;
    }
    /* 骰子仍然**只在权威端掷**（需求 §0）。 */
    if (ctx.role === 'kp') {
      var res = R.check({ kind: 'skill', base: 100, bonus: bonus, penalty: penalty, label: '' });
      ctx.act({ op: 'dice.roll', expr: '1D100', label: '', result: res });
      return res;
    }
    /* 玩家直投；开着暗骰开关 → secret（结果只给本人与 KP，见 diceDirect） */
    ctx.intent(M.INTENT.DICE, { expr: '1D100', direct: true, bonus: bonus, penalty: penalty,
                                secret: !!UI_STATE.darkRoll });
    global.UI.toast(UI_STATE.darkRoll ? '暗骰中…（只有你与 KP 看得到）' : '掷骰中…', 'ok');
    return null;
  }

  /* ============================================================
   * 兼容层：旧的整块面板 / 复用组件（保留，F1 旧代码不破）
   * ============================================================ */

  function explorationPanel(ctx) {
    if (!M) boot();
    var st = ctx.st;
    var scene = st.scene || {};
    var wrap = el('div');
    if (ctx.role === 'kp') {
      var titleInput = el('input.input', {
        type: 'text', value: scene.title || '', placeholder: '场景名（如：洋馆一层）', maxlength: 40
      });
      titleInput.addEventListener('change', function () {
        ctx.act({ op: 'scene.set', scene: Object.assign({}, scene, { title: titleInput.value }) });
      });
      wrap.appendChild(el('div.card', null, [el('div.card-title', { text: '场景' }), titleInput]));
    }
    wrap.appendChild(assetCard(ctx));
    wrap.appendChild(mapCard(ctx));
    if (ctx.role !== 'kp') wrap.appendChild(playerBoardCard(ctx));
    return wrap;
  }

  function assetCard(ctx) {
    if (!M) boot();
    var list = collectAssets(ctx, false);
    var card = el('div.card', null, [
      el('div.card-head', null, [
        el('h3', { text: '素材' }),
        el('span.hint', { text: ctx.role === 'kp' ? (list.length + ' 个（点击公开/隐藏）') : (list.length + ' 个可见') })
      ])
    ]);
    if (ctx.role === 'kp') {
      var files = assetUpload(ctx, 'map');
      card.appendChild(files);
      card.appendChild(el('button.btn.ghost.block', {
        text: '＋ 上传图片', style: { marginBottom: '10px' }, onclick: function () { files.click(); }
      }));
    }
    if (!list.length) {
      card.appendChild(el('div.tiny.dim', {
        text: ctx.role === 'kp' ? '还没有素材。上传的图默认不公开，点一下才给玩家看。' : 'KP 还没有公开任何素材。'
      }));
      return card;
    }
    var grid = el('div.asset-grid');
    list.forEach(function (item) {
      var a = item.a;
      var isImg = /^data:image\//.test(a.data || '');
      grid.appendChild(el('div.asset-cell' + (item.secret ? '.secret' : ''), {
        title: a.name + (item.secret ? '（未公开）' : ''),
        onclick: function () { if (ctx.role !== 'kp') return; ctx.act({ op: 'asset.reveal', id: a.id, revealed: !!item.secret }); }
      }, [
        isImg ? el('img', { src: a.data, alt: a.name }) : el('div.ph', { text: '🖼' }),
        el('div.cap', { text: a.name || '素材' })
      ]));
    });
    card.appendChild(grid);
    return card;
  }

  function mapCard(ctx) {
    if (!M) boot();
    var card = el('div.card', null, [el('div.card-title', { text: '地图 / 手绘板' })]);
    var stage = mapStage(ctx, ctx.role === 'kp');
    card.appendChild(stage);
    if (ctx.role !== 'kp') {
      card.appendChild(el('div.tiny.dim', { style: { marginTop: '6px' },
        text: '中央地图由 KP 控制（只可查看）。你的私人手绘板在下面那张卡。' }));
    }
    return card;
  }

  function playerBoardCard(ctx) {
    if (!M) boot();
    var mine = (ctx.st.board && ctx.st.board.strokes) || [];
    var color = UI_STATE.tool.color;
    var card = el('div.card', null, [
      el('div.card-head', null, [
        el('h3', { text: '✏️ 我的手绘板' }),
        el('span.hint', { text: '笔迹只有你自己看得到' })
      ])
    ]);
    var stage = el('div.map-stage.board-stage');
    stage.appendChild(el('div.map-empty', { text: '在这里画：按住拖动即可落笔。' }));
    if ((mine || []).length) {
      /* v2.5.0（用户第 8 项）：path 生成统一走 strokesSvg。 */
      stage.appendChild(strokesSvg(mine,
        'position:absolute;inset:0;width:100%;height:100%'));
    }
    stage.classList.add('sketch');
    stage.classList.add('touch-stage');
    /* v2.1.0 缺陷4b：玩家手绘板加橡皮擦 —— boardMode==='erase' 时点击即擦。
       v2.5.0（用户第 6 项）：改为**划过实时擦除**（bindEraseStage），
       手势末尾一次性走 INTENT.BOARD 整集替换。 */
    if (UI_STATE.boardMode === 'erase') {
      bindEraseStage(stage, (mine || []).slice(), function (keep, base) {
        eraseBoardAt(ctx, keep, base);
      });
    } else {
      /* v2.4.0（用户第 ② 项）：实时绘制 —— 落笔即见笔迹 */
      bindDraw(stage, function (pts) {
        var strokes = mine.slice();
        strokes.push({ color: color, width: 1.4, pts: pts });
        ctx.intent(M.INTENT.BOARD, { strokes: strokes });
      }, { color: color, width: 1.4 });
    }
    card.appendChild(stage);

    var bar = el('div.draw-tools');
    DRAW_COLORS.forEach(function (c) {
      bar.appendChild(el('div.swatch' + (color === c ? '.on' : ''), {
        style: { background: c }, onclick: function () { UI_STATE.tool.color = c; rerender(ctx); }
      }));
    });
    bar.appendChild(el('span.tiny.dim', { text: mine.length + ' 笔', style: { marginLeft: '8px' } }));
    bar.appendChild(el('button.btn.sm' + (UI_STATE.boardMode === 'erase' ? '.primary' : '.ghost'), {
      text: UI_STATE.boardMode === 'erase' ? '🧽 橡皮' : '✏️ 画笔',
      style: { marginLeft: 'auto' },
      onclick: function () {
        UI_STATE.boardMode = (UI_STATE.boardMode === 'erase' ? 'draw' : 'erase');
        rerender(ctx);
      }
    }));
    if (mine.length) {
      bar.appendChild(el('button.btn.sm.ghost', {
        text: '清空',
        onclick: function () {
          global.UI.confirm('清空手绘板上的所有笔迹？', { danger: true, okText: '清空' })
            .then(function (ok) { if (ok) { ctx.intent(M.INTENT.BOARD, { strokes: [] }); rerender(ctx); } });
        }
      }));
    }
    card.appendChild(bar);
    return card;
  }

  /* ============================================================
   * 兼容层：KP 工具面板（待确认 / 状态请求 / 回退 / 工具）
   * ============================================================ */

  function kpPanel(ctx) {
    if (!M) boot();
    if (ctx.role !== 'kp') return spectatorHint();
    var wrap = el('div');

    var pendings = (ctx.host && ctx.host.pending) ? ctx.host.pending : [];
    var conf = pendings.filter(function (q) { return q.need === 'twice' || q.need === 'kp'; });
    if (conf.length) {
      var pc = el('div.card', null, [
        el('div.card-head', null, [el('h3', { text: '待你确认' }), el('span.hint', { text: conf.length + ' 项' })])
      ]);
      conf.forEach(function (q) {
        var who = seatLabel(ctx, q.by);
        pc.appendChild(el('div.pending-row', null, [
          el('div.grow', null, [
            el('div', { text: opLabel(q.op) + (who ? ' · ' + who : '') }),
            el('div.tiny.dim', {
              text: pendingDetail(ctx, q) ||
                (q.need === 'twice' ? '高危操作，需二次确认' : '玩家发起，需你同意后生效')
            })
          ]),
          el('button.btn.sm.primary', { text: '确认', onclick: function () { ctx.side.confirmAct(q.op, true); rerender(ctx); } }),
          el('button.btn.sm.ghost', { text: '取消', onclick: function () { ctx.side.confirmAct(q.op, false); rerender(ctx); } })
        ]));
      });
      wrap.appendChild(pc);
    }

    /* v2.2.0（用户第 3 项）：待处理的对抗申请（玩家推送 → KP 裁定）置顶。 */
    var op = ctx.st && ctx.st.opposed;
    if (op && op.phase === 'await_kp') wrap.appendChild(kpOpposedPendingCard(ctx, op));

    wrap.appendChild(stateRequestCard(ctx));

    /* v2.9.0（用户第 2 项）：KP 工具按钮重新分类 —— 按用途分组 + 加小标题。
       ⚠️ 只调整分组 / 顺序 / 标题 / 图标，**绝不改任何按钮的 op、回调、二次确认逻辑**。 */
    var tools = el('div.card', null, [el('div.card-title', { text: '工具' })]);

    /* 组① */
    tools.appendChild(el('div.sec-title', { text: '回合与时间' }));
    var gridRound = el('div.tool-grid');
    gridRound.appendChild(toolBtn('⏭ 进入下一回合', '标记新回合开始（时间流逝：触发每日/每周恢复，并自动把各玩家临时卡生效到原卡）', function () { ctx.act({ op: 'round.next' }); }));
    tools.appendChild(gridRound);

    /* 组② */
    tools.appendChild(el('div.sec-title', { style: { marginTop: '10px' }, text: '检定与骰子' }));
    var gridCheck = el('div.tool-grid');
    gridCheck.appendChild(toolBtn('🎲 要求检定', '让全体或某人做一次检定', function () { pushCheckSheet(ctx); }));
    /* v2.3.0（用户第 7 项）：游戏中改「大成功 / 大失败」阈值 —— 改完立即广播、房内全部检定生效。 */
    gridCheck.appendChild(toolBtn('⚖ 检定成败阈值', '自定义大成功 / 大失败的掷值范围', function () { roomRulesSheet(ctx); }));
    tools.appendChild(gridCheck);

    /* 组③ */
    tools.appendChild(el('div.sec-title', { style: { marginTop: '10px' }, text: '战斗' }));
    var gridCombat = el('div.tool-grid');
    /* v2.2.0（用户第 3 项）：KP 工具二级菜单「⚔ 对抗」入口。 */
    gridCombat.appendChild(toolBtn('⚔ 对抗', '通用对抗 / 攻击对抗（含伤害结算）', function () { opposedSheet(ctx); }));
    tools.appendChild(gridCombat);
    wrap.appendChild(tools);

    /* 组④ 定向指令（指定玩家 · 直接生效 · 无需同意）—— 保留独立卡，9 项顺序不变。 */
    wrap.appendChild(kpDirectivesCard(ctx));

    /* 组⑤ · 组⑥ */
    var toolsExtra = el('div.card');
    toolsExtra.appendChild(el('div.sec-title', { text: '场景与素材' }));
    var gridScene = el('div.tool-grid');
    gridScene.appendChild(toolBtn('📩 递线索', '只给某个玩家的私密信息', function () { clueSheet(ctx); }));
    toolsExtra.appendChild(gridScene);

    toolsExtra.appendChild(el('div.sec-title', { style: { marginTop: '10px' }, text: '房间管理' }));
    var gridRoom = el('div.tool-grid');
    /* v2.9.0（用户第 2 项）：把原先只在死代码面板里的「✉️ 邀请加入」补进 KP 工具面板使其可达。 */
    gridRoom.appendChild(toolBtn('✉️ 邀请加入', '复制邀请链接给同伴', function () { inviteForRoom(ctx); }));
    /* #9（用户报）：KP 工具面板补「保存本局」入口（此前整个面板没有任何保存入口）。 */
    gridRoom.appendChild(toolBtn('💾 保存本局', '把整局进度存到云端存档槽', function () { saveSlotsSheet(ctx); }));
    gridRoom.appendChild(toolBtn('🏁 结团', '归档本次团并关闭房间', function () { endSession(ctx); }));
    toolsExtra.appendChild(gridRoom);
    wrap.appendChild(toolsExtra);

    return wrap;
  }

  function spectatorHint() {
    return el('div.card', null, [
      el('div.card-title', { text: '旁观' }),
      el('div.tiny.dim', { text: '你是旁观者，不能操作房间。' })
    ]);
  }

  var OP_LABEL = {
    'session.end': '结团（归档并关房）',
    'room.close': '关闭房间',
    'room.end': '结团',
    'state.edit.self': '玩家申请修改自己的状态',
    'madness.cure': '玩家申请治愈不定疯狂',
    'sheet.healwound': '玩家申请治愈伤势',
    'aid.apply': '队友施救（急救 / 医学）',
    'aid.psycho': '精神分析'
  };
  function opLabel(op) { return OP_LABEL[op] || ('待确认操作（' + op + '）'); }

  /**
   * v2.11.2（用户报 Bug）：KP「待你确认」队列文案中文化 + 富详情。
   *
   * Bug 由来：OP_LABEL 原先只登记 3 条（session.end / room.close / room.end），
   * 其余 op 走 `OP_LABEL[op] || op` **裸显示成代码** —— 玩家申请精神分析后，
   * KP 的待确认卡片上只有一行「aid.psycho」，完全看不出是谁对谁、做了什么。
   * 现在三管齐下：
   *   ① OP_LABEL 补齐所有会进 confirm:'kp' / 'twice' 队列的 op（对齐 POLICY 表）；
   *   ② 带 payload 的（aid.apply / aid.psycho）进一步显示「谁 → 谁 · 技能」；
   *   ③ 未登记 op 不再裸奔，回退「待确认操作（op）」保住可追溯性。
   * 已全仓审查：这是**唯一**一处把 op 直接渲染给用户的地方 ——
   * room-ui.js 的 consentCard / checkReqCard / buildConfirmText 均已是中文。
   */
  /** 座位 → 显示名（角色名优先，取不到回退座位号，绝不返回空串） */
  function seatLabel(ctx, seat) {
    if (!seat) return '';
    var ms = playersOf(ctx) || [];
    for (var i = 0; i < ms.length; i++) {
      if (ms[i].seat === seat) return ms[i].charName || ms[i].nickname || seat;
    }
    return seat;
  }

  /** 队列项的富中文说明：带 payload 的 op 显示「谁 → 谁 · 技能」 */
  function pendingDetail(ctx, q) {
    var p = q.p || {};
    var from = seatLabel(ctx, p.seat) || seatLabel(ctx, q.by);
    if (q.op === 'aid.apply') {
      var sk = (p.skill === '医学') ? '医学' : '急救';
      return from + ' 对 ' + seatLabel(ctx, p.targetSeat) + ' 使用「' + sk + '」';
    }
    if (q.op === 'aid.psycho') {
      return from + ' 对 ' + seatLabel(ctx, p.targetSeat) + ' 进行精神分析';
    }
    if (from) return '发起者：' + from;
    return '';
  }

  function stateRequestCard(ctx) {
    var players = playersOf(ctx);
    var card = el('div.card', null, [
      el('div.card-head', null, [el('h3', { text: '调整玩家状态' }), el('span.hint', { text: '需对方同意' })])
    ]);
    if (!players.length) { card.appendChild(el('div.tiny.dim', { text: '还没有玩家。' })); return card; }
    card.appendChild(el('div.tiny.dim', { text: '玩家必须点「同意」后才会生效 —— 权威端不会替他们改。' }));
    players.forEach(function (m) {
      /* v2.1.0 缺陷1修复：改用**带兜底**的 memberStats(m)（148-158）。
         此前直接读 m.runtime.hp/san —— 而 runtime 只在「状态请求被同意」或
         「authoritative stateApply」时才被赋值，玩家**刚绑定角色卡**时永远为空，
         于是 KP「玩家状态」卡恒显示 HP：— san：—。
         memberStats 依次回落到 sheet.status.currentHP/currentSAN 与顶层 hp/san，
         这条链在 INTENT.CHAR 上报后立刻有值。 */
      var s = memberStats(m);
      card.appendChild(el('div.pending-row', null, [
        el('div.grow', null, [
          el('div', { text: m.charName || m.nickname || '玩家' }),
          el('div.tiny.dim', { text: 'HP ' + (s.hp != null ? s.hp : '—') + ' · SAN ' + (s.san != null ? s.san : '—') })
        ]),
        el('button.btn.sm.ghost', { text: '改状态', onclick: function () { stateRequestSheet(ctx, m); } })
      ]));
    });
    return card;
  }

  function stateRequestSheet(ctx, member) {
    /* v2.1.0 缺陷1修复：输入框初值同样带 sheet 兜底 —— 否则「改状态」弹层
       打开时 HP/SAN 输入框是空的，KP 以为玩家没数据（其实是读错了字段）。 */
    var s = memberStats(member);
    var hpI = el('input.input', { type: 'number', value: String(s.hp != null ? s.hp : ''), placeholder: '不变' });
    var sanI = el('input.input', { type: 'number', value: String(s.san != null ? s.san : ''), placeholder: '不变' });
    var reasonI = el('input.input', { type: 'text', placeholder: '理由（如：被诅咒）', maxlength: 60 });
    var body = el('div', null, [
      el('div.tiny.dim', { text: '目标：' + (member.charName || member.nickname || '玩家') }),
      el('div.field', null, [el('label', { text: 'HP' }), hpI]),
      el('div.field', null, [el('label', { text: 'SAN' }), sanI]),
      el('div.field', null, [el('label', { text: '理由' }), reasonI]),
      el('button.btn.primary.block', {
        text: '发送请求', style: { marginTop: '12px' },
        onclick: function () {
          var change = {};
          if (hpI.value !== '') change.hp = +hpI.value;
          if (sanI.value !== '') change.san = +sanI.value;
          ctx.act({ op: 'state.request', seat: member.seat, reason: M.cleanText(reasonI.value, 60), change: change });
          global.UI.toast('已发送，等待玩家确认', 'ok');
          api.close();
        }
      })
    ]);
    var api = global.UI.sheet({ title: '请求修改状态', body: body });
    return api;
  }

  /* v2.9.0（用户第 3 项）：删除回退卡片与回退弹层
     —— 回退功能整体移除（UI 侧不再有任何回退入口）。 */

  function pushCheckSheet(ctx) {
    /* v2.7.0（用户第 3 项）：要求检定的目标不列出已撕卡（死亡 / 永久疯狂）的角色。 */
    var players = playersOf(ctx).filter(function (m) { return !targetBlocked(m); });
    var targetSel = selectCtl([{ value: '*', label: '全体玩家' }].concat(
      players.map(function (m) { return { value: m.seat, label: m.charName || m.nickname || '玩家' }; })
    ), '*', null);
    var skillI = el('input.input', { type: 'text', placeholder: '如：侦查 / 聆听', maxlength: 20 });
    var descI = el('textarea.textarea', { rows: '2', maxlength: '200', placeholder: '场景说明（可选）：如「天花板开始坍塌，敏捷检定成功则躲开」' });
    var diffSel = selectCtl([
      { value: 'REGULAR', label: '常规（无修正）' },
      { value: 'HARD', label: '困难（÷2）' },
      { value: 'EXTREME', label: '极难（÷5）' }
    ], 'REGULAR', null);
    var body = el('div', null, [
      el('div.field', null, [el('label', { text: '对象' }), targetSel]),
      el('div.field', null, [el('label', { text: '检定技能' }), skillI]),
      el('div.field', null, [el('label', { text: '场景说明' }), descI]),
      el('div.field', null, [el('label', { text: '难度' }), diffSel]),
      el('button.btn.primary.block', {
        text: '推送检定', style: { marginTop: '12px' },
        onclick: function () {
          ctx.act({ op: 'check.request', seat: targetSel.value, skill: M.cleanText(skillI.value, 20),
                    difficulty: diffSel.value, desc: M.cleanText(descI.value, 200) });
          global.UI.toast('已推送检定', 'ok');
          api.close();
        }
      })
    ]);
    var api = global.UI.sheet({ title: '要求检定', body: body });
    return api;
  }

  function clueSheet(ctx) {
    var players = playersOf(ctx);
    if (!players.length) { global.UI.toast('还没有玩家', 'err'); return; }
    var targetSel = selectCtl([{ value: '*', label: '全体玩家' }].concat(players.map(function (m) { return { value: m.seat, label: m.charName || m.nickname || '玩家' }; })), players[0].seat, null);
    var titleI = el('input.input', { type: 'text', value: '线索', maxlength: 20 });
    var textI = el('textarea.textarea', { rows: '4', placeholder: '只有该玩家能看到的内容' });
    var body = el('div', null, [
      el('div.field', null, [el('label', { text: '给谁' }), targetSel]),
      el('div.field', null, [el('label', { text: '标题' }), titleI]),
      el('div.field', null, [el('label', { text: '内容' }), textI]),
      el('button.btn.primary.block', {
        text: '递出线索', style: { marginTop: '12px' },
        onclick: function () {
          ctx.act({ op: 'scene.clue', seat: targetSel.value, title: M.cleanText(titleI.value, 20), text: M.cleanText(textI.value, 800) });
          global.UI.toast('线索已递出', 'ok');
          api.close();
        }
      })
    ]);
    var api = global.UI.sheet({ title: '递线索', body: body });
    return api;
  }

  function endSession(ctx) {
    global.UI.confirm('结团？本次记录会归档到本机，房间将关闭，所有人断开。', { danger: true, okText: '结团' })
      .then(function (ok) {
        if (!ok) return;
        /* v2.2.1（用户第 7 项）：结团确认后**关闭所有弹层** —— 否则 KP 工具面板
           （结团入口所在弹层）会残留：房间页已切走、浮层还在，用户以为没反应。 */
        try { if (global.UI && global.UI.closeAllSheets) global.UI.closeAllSheets(); } catch (e) { /* 忽略 */ }
        /* v2.4.0（用户第 ⑦ 项）：结团 → 房间关闭前，把本机临时卡状态回写已保存角色卡
           （KP 自己本机绑的卡；其他玩家的卡在他们各自机器上由 maybeDissolved 回写）。 */
        var tc = commitRoomTempCards((ctx.st && ctx.st.meta || {}).code);
        /* v2.1.6（用户第 4 项）：上面的 UI.confirm 弹窗**本身就是二次确认**；
           原来再走 request→pending→confirmAct 一圈，残留的「待你确认」卡片
           让用户以为确认没生效。直接 act（跳过 pending 队列）一步到位。 */
        /* v2.13.6：结团走 request + confirmAct（模型侧 pending + 2 分钟过期闸门），
           不再直接 act() —— 直通路径没有任何二次确认保护。 */
        ctx.side.request({ op: 'session.end' });
        ctx.side.confirmAct('session.end', true);
        try {
          if (global.RoomStore && ctx.host) global.RoomStore.archive(ctx.host.state, { startedAt: ctx.startedAt });
        } catch (e) { /* 归档失败不影响结团 */ }
        global.UI.toast('已结团，记录已归档' +
          (tc.ok ? ('，' + tc.ok + ' 张角色卡状态已回写') : ''), 'ok');
        /* v2.13.5（用户报 Bug）：结团后**结束本地会话**，否则回到房间页时
           authoritativeRoom() 仍把这局当「正在进行」→ 最上方又出现「回到游戏」。
           归档之后就清（归档是这一步之前做的，历史记录不受影响）。 */
        try { if (global.RoomUI && global.RoomUI.endLocalSession) global.RoomUI.endLocalSession(); } catch (e) { /* 忽略 */ }
        if (global.App && global.App.go) global.App.go('#/room');
        else rerender(ctx);
      });
  }

  /* ============================================================
   * 侧栏入口：根据 meta.mode 决定默认展示哪个面板（招募页兼容）
   * ============================================================ */

  function render(ctx) {
    if (!M) boot();
    var wrap = el('div');
    var ms = modeSwitch(ctx);
    if (ms) wrap.appendChild(ms);

    var mode = (ctx.st.meta || {}).mode || 'EXPLORATION';
    if (mode === 'COMBAT') wrap.appendChild(kpCombatPanel(ctx));
    else wrap.appendChild(explorationPanel(ctx));

    if (ctx.role === 'kp') wrap.appendChild(kpPanel(ctx));
    return wrap;
  }

  /* ============================================================
   * v2.0.2 T5 补漏 · 存档面板（KP 手动「保存本局」）
   *
   * ⚠️ 此前 createSave 只有定义 + 导出，**全仓没有任何界面调用它** ——
   *    结果 KP 能列出存档槽、也能「载入并续玩」，却**无从创建**，
   *    「保存整局游戏、改天凑齐人再开」这条需求实际不可用。
   *    本面板补上创建入口（以及删除入口，deleteSave 同样零调用）。
   * ============================================================ */

  /** 默认存档名：房间名 + 当前日期时间（省得用户自己想，也避免重名） */
  function defaultSaveName(mine) {
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return (mine && mine.name ? mine.name : '跑团') +
           ' · ' + (d.getMonth() + 1) + '/' + d.getDate() +
           ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /**
   * 存档槽面板：保存本局 / 列出 / 载入续玩 / 删除。
   * 身份取自本机 `RoomStore.getMine()`（房主记录，含 hostToken）—— 与服务端
   * `/saves*` 的鉴权口径一致（这些端点是 hostToken 专属）。
   */
  function saveSlotsSheet(ctx) {
    if (!M) boot();
    var RS = global.RoomStore;
    var mine = (RS && RS.getMine) ? RS.getMine() : null;
    if (!mine || !mine.code || !mine.hostToken) {
      global.UI.toast('只有房主可以存档（本机没有你开房的记录）', 'err');
      return;
    }
    if (!global.RoomNet || typeof global.RoomNet.createSave !== 'function') {
      global.UI.toast('当前版本不支持云存档', 'err');
      return;
    }

    var nameInput = global.UI.input({
      placeholder: '存档名（例如：第一次团）',
      value: defaultSaveName(mine)
    });
    var listBox = el('div');
    var api = null;

    function refresh() {
      global.UI.clear(listBox);
      listBox.appendChild(el('div.tiny.dim', { text: '正在读取…' }));
      global.RoomNet.listSaves(mine.code, mine.hostToken).then(function (j) {
        global.UI.clear(listBox);
        var saves = (j && j.saves) || [];
        if (!saves.length) {
          listBox.appendChild(el('div.tiny.dim', {
            text: '还没有存档。填个名字，点上面的「保存本局」即可。'
          }));
          return;
        }
        saves.forEach(function (s) {
          listBox.appendChild(el('div.actor-line', null, [
            el('div.grow', null, [
              el('div.nm', { text: s.name || ('存档 ' + s.saveId) }),
              el('div.tiny.dim', {
                text: '进度 seq ' + (s.seq || 0) +
                      (s.updatedAt ? (' · ' + timeText(s.updatedAt * 1000)) : '')
              })
            ]),
            el('button.btn.sm.primary', {
              text: '载入并续玩',
              onclick: function () {
                if (global.RoomUI && typeof global.RoomUI.resumeRoom === 'function') {
                  if (api) api.close();
                  global.RoomUI.resumeRoom(mine.code, s.saveId);
                } else {
                  global.UI.toast('无法续玩：入口缺失', 'err');
                }
              }
            }),
            el('button.btn.sm.ghost', {
              text: '删除',
              onclick: function () {
                global.UI.confirm(
                  '删除存档「' + (s.name || s.saveId) + '」？此操作不可撤销。',
                  { danger: true, okText: '删除' }
                ).then(function (ok) {
                  if (!ok) return;
                  global.RoomNet.deleteSave(mine.code, mine.hostToken, s.saveId).then(
                    function () { global.UI.toast('已删除', 'ok'); refresh(); },
                    function (e) {
                      global.UI.toast('删除失败：' + ((e && e.message) || e), 'err');
                    });
                });
              }
            })
          ]));
        });
      }, function () {
        global.UI.clear(listBox);
        listBox.appendChild(el('div.tiny.dim', {
          text: '读取失败（网络不可用 / 未配置房间服务）。本机存档不受影响。'
        }));
      });
    }

    var body = el('div', null, [
      el('div.tiny.dim', {
        html: '把<b>当前进度</b>存成一个存档槽。改天凑齐人时，在「续玩」里点「载入并续玩」，' +
              '相同配置的玩家加入后即从存档位置继续。'
      }),
      el('div.field', { style: { marginTop: '10px' } }, [nameInput]),
      el('button.btn.primary.block', {
        text: '💾 保存本局',
        onclick: function () {
          var nm = String(nameInput.value || '').trim() || defaultSaveName(mine);
          var btn = this;
          btn.disabled = true; btn.textContent = '保存中…';
          global.RoomNet.createSave(mine.code, mine.hostToken, nm).then(function (j) {
            global.UI.toast('已保存：' + ((j && j.name) || nm), 'ok');
            nameInput.value = defaultSaveName(mine);
            refresh();
          }, function (e) {
            global.UI.toast('保存失败：' + ((e && e.message) || e), 'err');
          }).then(function () {
            btn.disabled = false; btn.textContent = '💾 保存本局';
          });
        }
      }),
      el('div.sec-title', { style: { marginTop: '14px' }, text: '已有存档' }),
      listBox
    ]);

    api = global.UI.sheet({ title: '存档', body: body });
    refresh();
    return api;
  }

  function renderKp(ctx) { if (!M) boot(); return kpPanel(ctx); }
  function renderCombat(ctx) { if (!M) boot(); return kpCombatPanel(ctx); }
  function renderExplore(ctx) { if (!M) boot(); return explorationPanel(ctx); }

  global.RoomPanels = {
    boot: boot,

    /* v2.4.0（用户第 ⑦ 项）：结团回写本机临时卡（room-ui.js 玩家侧复用） */
    commitRoomTempCards: commitRoomTempCards,

    /* ---- 旧导出（F1 旧代码兼容，保留） ---- */
    render: render,
    renderKp: renderKp,
    renderCombat: renderCombat,
    renderExplore: renderExplore,
    modeSwitch: modeSwitch,
    diceBar: diceBar,
    doRoll: doRoll,
    mapCard: mapCard,
    playerBoardCard: playerBoardCard,
    explorationPanel: explorationPanel,
    kpPanel: kpPanel,
    plSceneCheckPanel: plSceneCheckPanel,
    notesPanel: notesPanel,

    /* ---- §8.1 KP 游戏页 ---- */
    kpLeftColumn: kpLeftColumn,
    kpToolColumn: kpToolColumn,
    kpMapArea: kpMapArea,
    kpGameLog: kpGameLog,
    kpChat: kpChat,
    kpCombatPanel: kpCombatPanel,
    kpSceneCheckPanel: kpSceneCheckPanel,
    kpPlayerList: kpPlayerList,

    /* ---- §8.2 PL 游戏页 ---- */
    plCharacterCard: plCharacterCard,
    plMapArea: plMapArea,
    plFeeds: plFeeds,
    plTeammates: plTeammates,
    plBottomBar: plBottomBar,

    /* ---- §8.3 新增弹层 ---- */
    combatPrepareSheet: combatPrepareSheet,
    sceneCheckSheet: sceneCheckSheet,
    opposedSheet: opposedSheet,
    /* v2.2.0（用户第 3 项）：对抗全链路 UI —— 二级菜单 + KP 攻击对抗 + 玩家申请/裁定/选怪。 */
    genericOpposedSheet: genericOpposedSheet,
    kpAttackSheet: kpAttackSheet,
    playerOpposedSheet: playerOpposedSheet,
    opposedResolveSheet: opposedResolveSheet,
    playerTargetSheet: playerTargetSheet,
    monsterList: monsterList,
    resumeSheet: resumeSheet,
    saveSlotsSheet: saveSlotsSheet,

    /* ---- 供 F1 / 其它模块复用的辅助入口 ---- */
    addActorSheet: addActorSheet,
    notifyTurn: notifyTurn,
    /* v2.13.7（用户需求）：房间聊天/记录条目最左的角色头像渲染器，
       供 room-ui.js#appendFeed 复用（避免两处各写一份头像回退逻辑）。 */
    avatarEl: avatarEl,
    _state: UI_STATE,
    /* v2.1.0：橡皮擦命中判定（纯函数）—— 暴露给探针做回归，避免「命中逻辑回归」时无人发现 */
    _hitStrokeIndex: hitStrokeIndex
  };
})(typeof window !== 'undefined' ? window : this);
