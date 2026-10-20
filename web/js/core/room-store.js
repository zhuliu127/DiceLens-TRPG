/* ============================================================
 * room-store.js — 跑团房间的本地持久化
 * 对外命名：window.RoomStore
 *
 * 存三样东西，都是「不存就会有明确体感问题」的：
 *
 *   coc7.room.mine.v1    我开的房间（code + hostToken）
 *     → KP 刷新页面 / 手机切后台被杀，回来还能继续当房主；
 *       不存的话他就是「房间的陌生人」，只能关房重开。
 *
 *   coc7.room.joined.v1  我加入过的房间（code + mtoken + 服务地址）
 *     → 断线重连的前提。mtoken 是**座位**凭据，丢了就只能重新加入，
 *       而重新加入会拿到新的 seat —— 在权威端眼里就变成「来了个新人」，
 *       准备状态、绑定的角色卡、行动顺序全丢。
 *
 *   coc7.room.archive.v1 结团归档
 *     → 需求 §13「结团后本地归档」。归档是**本地**的，房间服务不落库
 *       （见 room_server.py 的数据留存策略）。
 *
 * 容量策略：房间记录最多 12 条（超过按时间淘汰），归档最多 30 条。
 * 归档只留摘要（成员、成员数、起止时间、日志尾部），不存全量事件 ——
 * 全量事件在长团里能到几 MB，localStorage 只有 5MB 左右，
 * 存满之后所有写入都会静默失败（包括角色卡）。
 * ============================================================ */
(function (global) {
  'use strict';

  var KEY_MINE = 'coc7.room.mine.v1';
  var KEY_JOINED = 'coc7.room.joined.v1';
  var KEY_ARCHIVE = 'coc7.room.archive.v1';
  /* v2.0.0：每个房间一份本地存档（KP 与玩家各存自己有权看到的那一份）。
     形如 coc7.room.save.<code> —— 沿用既有 key 命名风格。 */
  var KEY_SAVE_PREFIX = 'coc7.room.save.';
  /* v2.0.2：临时卡（游戏内角色卡）—— 按「房间 + 原卡 id」区分，多房/多卡不串。
     形如 coc7.room.tempcard.<roomCode>.<charId>。 */
  var KEY_TEMP_PREFIX = 'coc7.room.tempcard.';

  var MAX_JOINED = 12;
  var MAX_ARCHIVE = 30;
  var MAX_SAVES = 8;      // 本地存档最多 8 份（localStorage 只有 ~5MB，别堆爆）

  function read(key, dflt) {
    try {
      var raw = global.localStorage.getItem(key);
      if (!raw) return dflt;
      var v = JSON.parse(raw);
      return (v === null || v === undefined) ? dflt : v;
    } catch (e) { return dflt; }
  }

  /** 写失败（配额满 / 隐私模式）不要抛出去：房间功能不该因为存不下就崩 */
  function write(key, val) {
    try {
      global.localStorage.setItem(key, JSON.stringify(val));
      return true;
    } catch (e) { return false; }
  }

  function now() { return Date.now(); }

  function norm(u) { return String(u == null ? '' : u).trim().replace(/\/+$/, ''); }

  /* ============================================================
   * 我开的房间
   * ============================================================ */

  function getMine() {
    var m = read(KEY_MINE, null);
    // 超过 12 小时视为过期：房间服务上的房间早就被清理了，留着只会让界面
    // 一进来就尝试恢复一个不存在的房间
    if (!m || !m.code || !m.hostToken) return null;
    if (now() - (m.at || 0) > 12 * 3600 * 1000) return null;
    return m;
  }

  function setMine(rec) {
    if (!rec || !rec.code || !rec.hostToken) return false;
    return write(KEY_MINE, {
      code: rec.code,
      hostToken: rec.hostToken,
      serverBase: norm(rec.serverBase),
      name: rec.name || '',
      rules: rec.rules || 'coc7',
      /* v2.1.3（用户第 2 项 · 杀进程后无法重连）：
         `lan = 这间房是**本机内嵌服务**开的`。调用方一直在传它，但这里以前**没存**
         —— 于是续玩时无从判断「服务就在我自己手机里、需要我把它重新拉起来」，
         只能拿一个已经死掉的地址去连，表现为永远「正在重连」。
         这是「局域网房杀进程后回不去」的关键缺失信号，必须持久化。 */
      lan: rec.lan === true,
      at: now()
    });
  }

  function clearMine() {
    try { global.localStorage.removeItem(KEY_MINE); } catch (e) { /* 忽略 */ }
    return true;
  }

  /* ============================================================
   * 我加入过的房间
   * ============================================================ */

  function listJoined() {
    var arr = read(KEY_JOINED, []);
    if (!Array.isArray(arr)) return [];
    var cut = now() - 12 * 3600 * 1000;
    return arr.filter(function (r) { return r && r.code && r.mtoken && (r.at || 0) > cut; });
  }

  function getJoined(code) {
    if (!code) return null;
    var arr = listJoined();
    for (var i = 0; i < arr.length; i++) if (arr[i].code === code) return arr[i];
    return null;
  }

  /**
   * 记一条「我加入过」。同房间重复加入会更新（而不是堆两条），
   * 因为 mtoken 会变，旧的留着只会在重连时拿错凭据。
   */
  function setJoined(rec) {
    if (!rec || !rec.code || !rec.mtoken) return false;
    var arr = listJoined().filter(function (r) { return r.code !== rec.code; });
    arr.unshift({
      code: rec.code,
      mtoken: rec.mtoken,
      serverBase: norm(rec.serverBase),
      role: rec.role || 'player',
      nickname: rec.nickname || '',
      name: rec.name || '',
      kpName: rec.kpName || '',
      at: now()
    });
    if (arr.length > MAX_JOINED) arr = arr.slice(0, MAX_JOINED);
    return write(KEY_JOINED, arr);
  }

  function clearJoined(code) {
    if (!code) {
      try { global.localStorage.removeItem(KEY_JOINED); } catch (e) { /* 忽略 */ }
      return true;
    }
    return write(KEY_JOINED, listJoined().filter(function (r) { return r.code !== code; }));
  }

  /* ============================================================
   * 结团归档
   * ============================================================ */

  function listArchive() {
    var arr = read(KEY_ARCHIVE, []);
    return Array.isArray(arr) ? arr : [];
  }

  /**
   * 归档一次结团。只留摘要：
   *   · members 只留昵称 / 角色 / 结团时的在线状态（用于「这团有谁」）
   *   · logs 只留最后 40 条（回看「最后发生了什么」）
   *   · chats 不存（聊天记录在参与者各自的设备上有，归档里没必要再来一份）
   */
  function archive(state, extra) {
    if (!state || !state.meta) return null;
    var st = state;
    var rec = {
      id: 'ar' + now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
      code: st.meta.code || '',
      name: st.meta.name || '',
      rules: st.meta.rules || 'coc7',
      kpName: st.meta.kpName || '',
      endedAt: now(),
      startedAt: (extra && extra.startedAt) || 0,
      seq: st.seq || 0,
      members: (st.members || []).map(function (m) {
        /* charId / sheet 也留一份：结团后回看「当时谁带着什么疯狂状态」
           是跑团复盘最需要的信息。sheet 已经过权威端白名单化，不含私密内容。 */
        return { seat: m.seat, nickname: m.nickname, role: m.role, online: !!m.online,
                 ready: !!m.ready, charName: m.charName || '',
                 charId: m.charId || null,
                 sheet: m.sheet ? {
                   name: m.sheet.name || '',
                   madness: (m.sheet.madness || []).slice(0, 40),
                   mental: (m.sheet.mental || []).slice(),
                   sanLoss: m.sheet.sanLoss || 0,
                   maxSAN: m.sheet.maxSAN,
                   /* v2.10.0（身体状态模型）：「濒死 / 昏迷」升级为 status 上的布尔标记
                     （与 body 正交、可叠加），归档摘要也带上这两个键 —— 结团复盘时
                     看得到「当时谁濒死 / 昏迷」。与 applyToTempCard 同款透传口径
                     （取布尔、缺省 false；老存档没有 status 也不炸）。 */
                   dying: !!((m.sheet.status || {}).dying),
                   unconscious: !!((m.sheet.status || {}).unconscious)
                 } : null };
      }),
      /* v2.11.8（用户需求）：结团归档**保留全部**游戏记录，不再截断到最近 40 条。
         配合本机「游戏历史记录」详情页与导出功能，玩家可回看整局每一步操作。 */
      logs: (st.logs || []).slice(),
      dice: (st.dice || []).slice(-20),
      note: (extra && extra.note) || ''
    };
    var arr = listArchive();
    arr.unshift(rec);
    if (arr.length > MAX_ARCHIVE) arr = arr.slice(0, MAX_ARCHIVE);
    return write(KEY_ARCHIVE, arr) ? rec : null;
  }

  function getArchive(id) {
    var arr = listArchive();
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
    return null;
  }

  function removeArchive(id) {
    return write(KEY_ARCHIVE, listArchive().filter(function (r) { return r.id !== id; }));
  }

  function clearArchive() {
    try { global.localStorage.removeItem(KEY_ARCHIVE); } catch (e) { /* 忽略 */ }
    return true;
  }

  /* ============================================================
   * v2.0.0：每个房间的本地存档（实时存档 / 断线重连 / 改天续玩）
   *
   * KP 与玩家各存一份**自己有权看到**的存档（玩家那份已按身份裁剪过）。
   * 与服务器存档（room_server.py / LanServer）互为备份：
   *   · 断线重连：本地有 → 直接续；本地落后 → 从服务器拉
   *   · 改天续玩：从本机列表里挑一个未完结的团恢复
   * ============================================================ */

  function saveKey(code) { return KEY_SAVE_PREFIX + String(code || ''); }

  function listRoomSaves() {
    var out = [];
    try {
      var ls = global.localStorage;
      if (!ls) return out;
      for (var i = 0; i < ls.length; i++) {
        var k = ls.key(i);
        if (!k || k.indexOf(KEY_SAVE_PREFIX) !== 0) continue;
        var rec = read(k, null);
        if (rec && rec.code) out.push(rec);
      }
    } catch (e) { /* 忽略 */ }
    out.sort(function (a, b) { return (b.savedAt || 0) - (a.savedAt || 0); });
    return out;
  }

  function getRoomSave(code) {
    if (!code) return null;
    var rec = read(saveKey(code), null);
    return (rec && rec.code) ? rec : null;
  }

  /** 写一份房间存档。data: {role, seat, seq, state} */
  function saveRoom(code, data) {
    if (!code) return false;
    var rec = {
      code: String(code),
      role: (data && data.role) || 'player',
      seat: (data && data.seat) || '',
      seq: (data && data.seq) || 0,
      savedAt: now(),
      state: (data && data.state) || null
    };
    var ok = write(saveKey(code), rec);
    /* 超出上限 → 淘汰最旧的几份（避免 localStorage 被存满后所有写入静默失败） */
    var all = listRoomSaves();
    if (all.length > MAX_SAVES) {
      all.slice(MAX_SAVES).forEach(function (r) { clearRoomSave(r.code); });
    }
    return ok;
  }

  function clearRoomSave(code) {
    if (!code) return true;
    try { global.localStorage.removeItem(saveKey(code)); } catch (e) { /* 忽略 */ }
    return true;
  }

  /**
   * 本机**未完结**的团（续玩入口用）。
   * 汇总三处：我开的（mine）/ 我加入过的（joined）/ 有本地存档的（save）；
   * 已结团（archive 里有同 code）的排除掉。
   */
  function listUnfinished() {
    var archived = {};
    listArchive().forEach(function (a) { if (a && a.code) archived[a.code] = true; });
    var byCode = {};
    var mine = getMine();
    if (mine && mine.code) {
      byCode[mine.code] = { code: mine.code, role: 'kp', name: mine.name || '',
                            serverBase: mine.serverBase || '', at: mine.at || 0 };
    }
    listJoined().forEach(function (j) {
      if (!j || !j.code || byCode[j.code]) return;
      byCode[j.code] = { code: j.code, role: j.role || 'player', name: j.name || '',
                         serverBase: j.serverBase || '', at: j.at || 0 };
    });
    listRoomSaves().forEach(function (s) {
      if (!s || !s.code) return;
      var e = byCode[s.code] || (byCode[s.code] = { code: s.code, role: s.role || 'player',
                                                    name: '', serverBase: '', at: 0 });
      e.seq = s.seq || 0;
      e.savedAt = s.savedAt || 0;
      e.hasSave = true;
    });
    var out = [];
    Object.keys(byCode).forEach(function (c) {
      if (archived[c]) return;                 // 已结团的不算「未完结」
      out.push(byCode[c]);
    });
    out.sort(function (a, b) { return (b.savedAt || b.at || 0) - (a.savedAt || a.at || 0); });
    return out;
  }

  /* ============================================================
   * v2.0.2：临时卡（游戏内角色卡）
   *
   * 为什么需要它：跑团中权威端会不断把 HP/SAN/疯狂状态写回玩家的角色卡。
   * 若直接写**原卡**，玩家「随便进个团玩一局」就会污染他精心车好的卡；
   * 而且改天续玩时无法回退。所以：
   *   · 开局 → 深拷贝原卡为**临时卡**（本机、按房间+卡区分）；
   *   · 游戏中 → 状态写回只改**临时卡**（原卡纹丝不动）；
   *   · 玩家点「生效」（二次确认）→ 才用临时卡覆盖原卡。
   * 未点「生效」→ 原卡保持不动（安全设计）。
   *
   * 存 localStorage：须跨「离开房间」与刷新存活；不随云端存档跨设备迁移。
   * ============================================================ */

  function tempKey(roomCode, charId) {
    return KEY_TEMP_PREFIX + String(roomCode || '') + '.' + String(charId || '');
  }

  function deepClone(o) {
    try { return JSON.parse(JSON.stringify(o)); } catch (e) { return null; }
  }

  /** 原卡指纹：用于「生效」时判断原卡是否已被改动（变了就提示） */
  function fingerprint(obj) {
    var s = '';
    try { s = JSON.stringify(obj); } catch (e) { s = ''; }
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return 'fp' + (h >>> 0).toString(36) + ':' + s.length;
  }

  function getTempCard(roomCode, charId) {
    if (!roomCode || !charId) return null;
    var rec = read(tempKey(roomCode, charId), null);
    return (rec && rec.v === 1 && rec.card) ? rec : null;
  }

  /**
   * 开局复制：本房本卡还没有临时卡 → 深拷贝当前原卡建一张。
   * 原卡不存在（开局前没绑卡）→ 返回 null（不创建，状态写回自然 no-op）。
   * 已存在 → 只刷新 seat / updatedAt，**不覆盖**（否则会丢掉游戏中的改动）。
   */
  function ensureTempCard(roomCode, seat, charId) {
    if (!roomCode || !charId) return null;
    var ex = getTempCard(roomCode, charId);
    if (ex) {
      if (seat && ex.seat !== seat) { ex.seat = String(seat); ex.updatedAt = now(); write(tempKey(roomCode, charId), ex); }
      return ex;
    }
    var src = (global.Store && global.Store.getState) ? global.Store.getState().characters[charId] : null;
    if (!src) return null;
    var card = deepClone(src);
    if (!card) return null;
    var rec = {
      v: 1,
      roomCode: String(roomCode),
      charId: String(charId),
      seat: String(seat || ''),
      baseSnapshot: fingerprint(src),
      createdAt: now(),
      updatedAt: now(),
      committed: false,
      card: card
    };
    write(tempKey(roomCode, charId), rec);
    return rec;
  }

  /**
   * 状态写回落点：把权威端补丁写进**临时卡**（绝不碰原卡）。
   * 补丁形状与 RoomModel.applyStateToCard 一致：
   *   {status:{currentHP,...}, madness:[], mental:[], sanLoss}
   */
  function applyToTempCard(roomCode, charId, patch) {
    var rec = getTempCard(roomCode, charId);
    if (!rec || !rec.card) return false;
    var card = rec.card;
    if (!card.status) card.status = {};
    var st = (patch && patch.status) || {};
    ['currentHP', 'maxHP', 'currentMP', 'maxMP', 'currentSAN', 'maxSAN', 'currentLuck']
      .forEach(function (k) {
        if (st[k] !== undefined && st[k] !== null) card.status[k] = st[k];
      });
    /* v2.1.5（用户第 2/4 项）：身体状态也写进临时卡（「死亡」= 撕卡）。 */
    if (st.body !== undefined && st.body !== null) card.status.body = st.body;
    /* v2.10.0（身体状态模型）：「濒死 / 昏迷」改为布尔标记，也透传进临时卡。
       ⚠️ 键名（dying / unconscious，挂在 patch.status 下）必须与权威端
       room-model.js#applyStateToCard / stateApply 写的键名**逐字一致** ——
       少透传一个键，权威端与玩家本机临时卡就会漂移（房间看到濒死、本机卡看不到）。 */
    if (st.dying !== undefined && st.dying !== null) card.status.dying = st.dying;
    if (st.unconscious !== undefined && st.unconscious !== null) card.status.unconscious = st.unconscious;
    if (patch && Array.isArray(patch.madness)) {
      var md = deepClone(patch.madness); if (md) card.madness = md;
    }
    if (patch && Array.isArray(patch.mental)) {
      var ml = deepClone(patch.mental); if (ml) card.status.mental = ml;
    }
    if (patch && patch.sanLoss !== undefined) card.status.sanLoss = patch.sanLoss;
    /* v2.1.0 #11：KP 定向指令的临时状态 / 物品道具也要写进临时卡 ——
       否则「有临时卡时」这条旁路会丢掉这两个字段（玩家看不到 KP 给的物品/状态）。 */
    if (patch && Array.isArray(patch.tempStatus)) {
      var ts = deepClone(patch.tempStatus); if (ts) card.tempStatus = ts;
    }
    if (patch && Array.isArray(patch.items)) {
      var its = deepClone(patch.items); if (its) card.items = its;
    }
    /* v2.3.0（用户第 10 项）：武器「已损坏」标记也写进临时卡。 */
    if (patch && Array.isArray(patch.weapons)) {
      var wps = deepClone(patch.weapons); if (wps) card.weapons = wps;
    }
    rec.updatedAt = now();
    return write(tempKey(roomCode, charId), rec);
  }

  /** 「生效」：用临时卡覆盖原卡（二次确认由 UI 负责）→ 标记 committed */
  function commitTempCard(roomCode, charId) {
    var rec = getTempCard(roomCode, charId);
    if (!rec || !rec.card) return false;
    var ok = false;
    if (global.Store && typeof global.Store.upsertCharacter === 'function') {
      ok = global.Store.upsertCharacter(rec.card);
    }
    /* v2.1.4（用户第 2 项 ·「生效按钮点一次就变灰，但游戏还在进行、数值还会变」）：
       `committed` 只是「至少生效过一次」的标记；**允许反复生效**（游戏中的变动是持续的，
       每次把临时卡的最新值覆盖回原卡）。记一个次数与时间，界面据此说明状态。 */
    rec.committed = true;
    rec.commitCount = (rec.commitCount || 0) + 1;
    rec.committedAt = now();
    rec.updatedAt = now();
    write(tempKey(roomCode, charId), rec);
    return ok;
  }

  /** 本机所有临时卡（续玩入口 / 未生效提示用） */
  function listTempCards() {
    var out = [];
    try {
      var ls = global.localStorage;
      if (!ls) return out;
      for (var i = 0; i < ls.length; i++) {
        var k = ls.key(i);
        if (!k || k.indexOf(KEY_TEMP_PREFIX) !== 0) continue;
        var rec = read(k, null);
        if (rec && rec.v === 1 && rec.card) out.push(rec);
      }
    } catch (e) { /* 忽略 */ }
    out.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    return out;
  }

  function clearTempCard(roomCode, charId) {
    if (!roomCode || !charId) return true;
    try { global.localStorage.removeItem(tempKey(roomCode, charId)); } catch (e) { /* 忽略 */ }
    return true;
  }

  /** 估算占用的字节数（设置页显示用，提醒用户别把归档堆爆） */
  function usage() {
    var n = 0;
    [KEY_MINE, KEY_JOINED, KEY_ARCHIVE].forEach(function (k) {
      try { n += (global.localStorage.getItem(k) || '').length; } catch (e) { /* 忽略 */ }
    });
    try {
      var ls = global.localStorage;
      for (var i = 0; i < ls.length; i++) {
        var k = ls.key(i);
        if (k && k.indexOf(KEY_SAVE_PREFIX) === 0) n += (ls.getItem(k) || '').length;
      }
    } catch (e) { /* 忽略 */ }
    return n;
  }

  global.RoomStore = {
    KEY_MINE: KEY_MINE,
    KEY_JOINED: KEY_JOINED,
    KEY_ARCHIVE: KEY_ARCHIVE,
    KEY_SAVE_PREFIX: KEY_SAVE_PREFIX,
    MAX_JOINED: MAX_JOINED,
    MAX_ARCHIVE: MAX_ARCHIVE,
    MAX_SAVES: MAX_SAVES,

    getMine: getMine,
    setMine: setMine,
    clearMine: clearMine,

    listJoined: listJoined,
    getJoined: getJoined,
    setJoined: setJoined,
    clearJoined: clearJoined,

    listArchive: listArchive,
    archive: archive,
    getArchive: getArchive,
    removeArchive: removeArchive,
    clearArchive: clearArchive,

    /* v2.0.0：房间本地存档 + 未完结列表 */
    listRoomSaves: listRoomSaves,
    getRoomSave: getRoomSave,
    saveRoom: saveRoom,
    clearRoomSave: clearRoomSave,
    listUnfinished: listUnfinished,

    /* v2.0.2：临时卡（游戏内角色卡）生命周期 */
    KEY_TEMP_PREFIX: KEY_TEMP_PREFIX,
    getTempCard: getTempCard,
    ensureTempCard: ensureTempCard,
    applyToTempCard: applyToTempCard,
    commitTempCard: commitTempCard,
    listTempCards: listTempCards,
    clearTempCard: clearTempCard,

    usage: usage
  };
})(typeof window !== 'undefined' ? window : this);
