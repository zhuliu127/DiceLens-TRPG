/* ============================================================
 * store.js — 角色数据模型 + 本地持久化 + 自动保存
 * 复杂数据以结构化 JSON 存储；索引字段（姓名/职业/时间）单独记录便于搜索
 * ============================================================ */
(function (global) {
  'use strict';

  var KEY_CHARS = 'coc7.characters.v1';
  var KEY_DRAFT = 'coc7.draft.v1';
  var KEY_SETTINGS = 'coc7.settings.v1';
  /* 编辑已保存角色时的「中转区」。自动保存往这里写，不碰角色卡本身 ——
     用户明确要求：编辑已创建的角色必须手动保存，误改不能悄悄覆盖原数据。
     留着它的实际价值是「手机被系统杀掉 / 误触返回」时还能把修改捞回来。 */
  var KEY_EDIT = 'coc7.edit.v1';

  /* 精神状态的「正常」项。**多选**里它是个特殊的互斥项：
     选了它就代表「没有任何异常」，不能和别的项并存。
     值必须与 rules-coc7.js#MENTAL_STATUS 里的字面量一致。 */
  var MENTAL_NORMAL = '正常';

  var listeners = [];

  function uid() {
    var s = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var out = '';
    for (var i = 0; i < 8; i++) out += s[Math.floor(Math.random() * s.length)];
    return out;
  }

  /* ---------- 默认设置 ---------- */
  function defaultSettings() {
    /* shareBase：角色卡云分享的服务地址。
       留空表示未配置 —— 未配置时界面不提供上传入口，只引导用户去填。
       打包预置的地址不写在这里，见 js/core/build-config.js。

       aiBase / aiModel / aiKey：第 0 步「AI 车卡」用的大模型接入信息。
       只保存在本机 localStorage，不会上传到任何地方（请求直接发给用户填的接口）。 */
    /* roomBase：跑团房间中继的服务地址（公网开团用）。
       和 shareBase 一样留空表示未配置 —— 未配置时界面引导用户去填，
       或者走局域网直连（那条路地址由邀请链接自带，不需要这个设置）。
       打包预置的地址同样不写在这里，见 js/core/build-config.js。 */
    return {
      skillCap: 99,
      theme: 'light',
      autoSave: true,
      lastRuleSystem: null,
      shareBase: '',
      roomBase: '',
      aiBase: 'https://api.deepseek.com/v1',
      aiModel: 'deepseek-flash',
      aiKey: '',
      /* ---- AI 车卡的数值上限（可选）----
         0 / 空 表示不限制。设置后 AI 生成的卡会被**本地二次校准**，
         即使模型没照做也一定不会超标 —— 提示词只是第一道，这里是兜底。 */
      aiAttrCap: 0,            // 属性总和上限
      aiAttrCapWithLuck: true, // true=含幸运，false=不含幸运
      aiOccPtsCap: 0,          // 职业技能点数上限
      aiIntPtsCap: 0           // 兴趣技能点数上限
    };
  }

  /* ---------- 新角色模型 ---------- */
  /** 全新的空白角色卡。新建时必须走这里，绝不能复用上一张卡的数据。 */
  function newCharacter(ruleSystemId) {
    var now = Date.now();
    return {
      id: uid(),
      userId: 'local',
      ruleSystemId: ruleSystemId || 'coc7',

      /* 基本信息 */
      characterName: '',
      playerName: '',
      avatar: '',
      basicInfo: {
        era: '现代', eraCustom: '',
        age: '',            // 空着，让玩家自己填，避免误以为是系统给的默认年龄
        gender: '男', genderCustom: '',
        residence: '',
        birthplace: '',
        occupationName: ''
      },
      /* 兼容顶层访问 */
      age: '',

      occupationId: '',
      occupationPicks: {},
      customOccupation: null,

      attributes: { str: '', con: '', siz: '', dex: '', app: '', int: '', pow: '', edu: '', luck: '' },
      attributeMode: 'random',
      attributeHistory: [],
      /* 手动购点：属性点上限必须有真实初值。
         早期版本只在输入框里显示 480、却从没写进数据，
         于是 c.pbCap 是 undefined，校验按 0 算，页面会显示「超出上限 0」。 */
      pbCap: 480,
      pbIncludeLuck: true,
      /* 「天命 N 选一」：一次性掷出 N 组属性（2-10 组），玩家从中挑一组。
         掷出后不再重掷 —— 这是模式的设计约束，只有新建角色卡才能换一批天命。
         options 存的是完整 9 项属性组，picked 记录选中的下标（-1 = 还没选）。 */
      fate: { n: 5, rolled: false, options: [], picked: -1, rolledAt: 0 },
      /* 教育进步检定（年龄调整的一部分）：
         记录起始 EDU、每次掷骰结果与累计增益 bonus。
         bonus 只作用于「生效属性」，不改写玩家输入的原始 EDU。 */
      eduProgress: { base: null, done: 0, log: [], bonus: 0 },

      derivedStats: {},
      status: {
        currentHP: 0, maxHP: 0,
        currentMP: 0, maxMP: 0,
        currentSAN: 0, maxSAN: 99,
        currentLuck: 0,
        /* v2.10.0（身体状态模型）：body 收敛为四态单值 {正常, 轻伤, 重伤, 死亡}；
           「濒死 / 昏迷」改为布尔标记 dying / unconscious，可与「重伤」叠加。
           单机车卡与跑团房间共用同一张卡 schema、同语义（房间侧权威形状见
           room-model.js#sanitizeStatus / applyStateToCard，勿在此处发明新键名）。 */
        body: '正常', mental: '正常',
        dying: false,
        unconscious: false
      },

      /* 疯狂状态列表（跑团中逐条掷出来的）。
         每条：{ id, type:'phobia'|'mania', name, en, desc, rounds, permanent, at }
           · type       恐惧症 / 狂躁症
           · rounds     持续轮数（临时疯狂）；permanent 为真时表示永久
           · permanent  永久疯狂 —— 不随轮次消失，只能手动删
         存成数组而不是塞进 background.phobias 文本，是因为要能逐条管理：
         列表里看得到、能单独删、能显示剩余轮数。 */
      madness: [],

      /* 理智上限的永久减损（施放神话法术、与克苏鲁接触都可能 -1D5、-1D10）。
         baseMaxSAN 记录「未被减损时的上限」（= 意志），
         sanLoss 是累计减损量，界面上算作 maxSAN = baseMaxSAN − sanLoss。
         没有这两项就无法表达「上限被永久削掉了」这件事 ——
         规则书里 5%/10% 的 SAN 损失正是这个意思。 */
      baseMaxSAN: null, sanLoss: 0,

      skills: [],           // 完整技能实例
      weapons: [],
      armors: [],
      vehicles: [],
      items: [],

      assets: {
        creditRating: 0, cash: 0, spendingLevel: '标准',
        assetsDescription: '', assets: [], currency: '$'
      },

      background: {
        description: '', ideology: '', significantPeople: '', meaningfulPlaces: '',
        treasuredPossessions: '', traits: '', wounds: '', phobias: ''
      },
      history: [],
      companions: [],
      mythos: { skill: 0, knowledge: '', entries: [], spells: [] },

      skillCap: 99,              // 兼容旧数据：单一上限
      skillCapOcc: 99,           // 本职技能最终值上限
      skillCapInterest: 99,      // 非本职（兴趣）技能最终值上限
      shareVisibility: 'link',   // public | private | link
      shareId: '',
      version: 'v1.0',
      changeLog: [{ version: 'v1.0', note: '创建角色', at: now }],
      createdAt: now,
      updatedAt: now
    };
  }

  /* ---------- 存储层 ---------- */
  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function write(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) { console.warn('存储失败', e); return false; }
  }

  var state = {
    characters: read(KEY_CHARS, {}),
    /* 未完成的草稿。语义收紧为「正在创作、尚未完成的这张卡」。
       判断某张卡是不是草稿，用 state.current === state.draft 这个同一性判断，
       不额外维护布尔标记 —— 标记一旦漏改就会出现「首页挂着草稿 / 新建卡继承旧数据」。 */
    draft: read(KEY_DRAFT, null),
    /* 编辑会话：{ id, baseUpdatedAt, snapshot, restored }。
       非 null 表示「正在编辑一张**已保存**的角色卡」。
       此时 state.current 是一份**副本**，与 state.characters[id] 不共享引用 ——
       这是「误改不会自动写回」的关键：存储里的对象从头到尾没被碰过。 */
    edit: null,
    settings: Object.assign(defaultSettings(), read(KEY_SETTINGS, {})),
    current: null,
    saveState: 'idle'       // idle | saving | saved | buffered | error
  };

  /* ---------- 订阅 ---------- */
  function subscribe(fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; }
  function emit(type) { listeners.forEach(function (f) { try { f(type, state); } catch (e) { console.error(e); } }); }

  /* ---------- 自动保存 (debounce) ---------- */
  var timer = null;
  function scheduleSave() {
    if (!state.settings.autoSave) return;
    state.saveState = 'saving';
    emit('saving');
    if (timer) clearTimeout(timer);
    timer = setTimeout(doSave, 500);
  }

  function doSave() {
    if (!state.current) return;
    var c = state.current;

    /* 编辑已保存的角色：自动保存只落到「编辑中转区」，绝不写回角色卡。
       用户要求「必须是手动保存才保存到已创建的角色卡里」——
       所以这里连 updatedAt 都不改（改了会影响缓冲过期判断，
       也会让首页按「最近更新」排序时把没保存的改动算进去）。 */
    if (state.edit) {
      var okBuf = writeEditBuffer({
        id: state.edit.id,
        baseUpdatedAt: state.edit.baseUpdatedAt,
        data: c
      });
      state.saveState = okBuf ? 'buffered' : 'error';
      emit('buffered');
      return;
    }

    c.updatedAt = Date.now();
    state.characters[c.id] = c;
    var ok = write(KEY_CHARS, state.characters);
    // 只有「当前正在编辑的就是草稿」时才回写草稿槽。
    // 完成角色卡 / 打开已保存卡之后 draft 为 null 或指向别的卡，写不进草稿槽。
    if (state.draft && state.draft.id === c.id) ok = write(KEY_DRAFT, c) && ok;
    state.saveState = ok ? 'saved' : 'error';
    emit('saved');
    if (ok) setTimeout(function () { if (state.saveState === 'saved') { state.saveState = 'idle'; emit('idle'); } }, 1500);
  }

  function saveNow() { if (timer) clearTimeout(timer); doSave(); }

  /* ============================================================
   * 编辑会话 —— 「编辑已保存的角色，必须手动保存」
   *
   * 早先的实现是 loadCharacter(id) 之后直接改：state.current 与
   * state.characters[id] 是**同一个对象**，而界面里到处都在调
   * scheduleSave()，于是随便点几下就把原数据覆盖了 ——
   * 误改一下，原来的角色卡就没了。
   *
   * 现在改成会话式：
   *   beginEdit(id)   → 存储对象深拷贝一份出来当工作副本，原对象冻结不动
   *   编辑期间        → 自动保存只写「中转区」，角色卡一个字都不改
   *   commitEdit()    → 显式保存，这时才把副本写回角色卡
   *   cancelEdit()    → 丢弃副本，角色卡保持进入编辑前的样子
   * ============================================================ */

  /** 深拷贝。角色数据是纯 JSON（字符串/数字/数组/对象），JSON 往返即可 */
  function clone(v) { return v === null || v === undefined ? v : JSON.parse(JSON.stringify(v)); }

  function readEditBuffer() {
    var e = read(KEY_EDIT, null);
    return (e && e.id && e.data) ? e : null;
  }
  function writeEditBuffer(entry) { return write(KEY_EDIT, entry); }
  function clearEditBuffer() {
    try { localStorage.removeItem(KEY_EDIT); } catch (e) { /* 忽略 */ }
  }

  /** 是否正在编辑一张已保存的角色卡 */
  function isEditing() { return !!state.edit; }
  /** 正在编辑的角色 id（不在编辑态返回 null） */
  function editingId() { return state.edit ? state.edit.id : null; }
  /** 是否已经有实际改动（用于「还没保存就离开」的拦截） */
  function isEditDirty() {
    if (!state.edit || !state.current) return false;
    try {
      return fingerprint(state.current) !== fingerprint(state.edit.snapshot);
    } catch (e) { return true; }   // 比不出来就按「有改动」处理，宁可多问一句
  }
  /** 给编辑会话的只读摘要 */
  function editInfo() {
    if (!state.edit) return null;
    return { id: state.edit.id, restored: !!state.edit.restored, dirty: isEditDirty() };
  }

  /**
   * 指纹：先按同一条流水线（normalize + recalc）处理再序列化。
   * 直接 JSON.stringify 比较会因为一边算过派生值、另一边没算而不等，
   * 于是「什么都没改」也会被判定成有改动。
   */
  function fingerprint(c) {
    var x = clone(c);
    normalize(x);
    if (global.Engine && global.Engine.recalc) {
      try { global.Engine.recalc(x); } catch (e) { /* 数据不全时忽略 */ }
    }
    return JSON.stringify(x);
  }

  /**
   * 进入编辑。返回可编辑的工作副本。
   * 若中转区里存着**同一张卡、且基于同一版本**的未保存修改，直接恢复它
   * （手机被杀掉 / 误退出后还能接着改）；版本对不上就丢弃，避免把
   * 过期的数据盖回去（例如编辑期间在角色卡页改过 HP）。
   */
  function beginEdit(id) {
    var stored = state.characters[id];
    if (!stored) return null;
    normalize(stored);

    var snapshot = normalize(clone(stored));   // 进入编辑时的样子，「放弃」用
    var working = normalize(clone(stored));    // 工作副本
    var restored = false;

    var buf = readEditBuffer();
    if (buf && buf.id === id && buf.baseUpdatedAt === stored.updatedAt && buf.data) {
      working = normalize(buf.data);
      restored = true;
    } else if (buf) {
      clearEditBuffer();   // 过期缓冲，清掉，免得下次又被捞起来
    }

    // 把存储对象里可能存在的派生字段补全后写回，保证 snapshot / working
    // 与 stored 三者在结构上完全一致
    state.characters[id] = normalize(stored);

    state.edit = {
      id: id,
      baseUpdatedAt: state.characters[id].updatedAt,
      snapshot: snapshot,
      restored: restored
    };
    state.current = working;
    emit('edit-begin');
    return state.current;
  }

  /**
   * 手动保存：把工作副本写回角色卡，并结束编辑会话。
   * 不在编辑态时退回到 finalize()，让调用方不必分情况。
   */
  function commitEdit(note) {
    if (!state.edit) return finalize();
    var e = state.edit;
    var c = state.current;
    if (!c || c.id !== e.id) return null;     // 数据错位就不写，宁可不保存也不能写坏

    normalize(c);
    if (global.Engine && global.Engine.recalc) global.Engine.recalc(c);
    c.shareId = c.shareId || uid();
    c.version = c.version || 'v1.0';
    c.updatedAt = Date.now();
    if (!Array.isArray(c.changeLog)) c.changeLog = [];
    c.changeLog.push({ version: c.version, note: note || '编辑角色', at: c.updatedAt });

    state.characters[e.id] = c;
    var ok = write(KEY_CHARS, state.characters);
    clearEditBuffer();
    state.edit = null;
    state.current = c;
    state.saveState = ok ? 'saved' : 'error';
    emit('edit-committed');
    return c;
  }

  /**
   * 放弃修改。存储里的角色卡在编辑期间没被碰过，所以「放弃」本质上
   * 只是丢掉副本；snapshot 仅作兜底（万一有别的路径写脏了存储）。
   */
  function cancelEdit() {
    var e = state.edit;
    if (!e) return null;
    if (e.snapshot) {
      state.characters[e.id] = normalize(e.snapshot);
      write(KEY_CHARS, state.characters);
    }
    clearEditBuffer();
    state.edit = null;
    state.current = null;
    state.saveState = 'idle';
    emit('edit-cancelled');
    return state.characters[e.id] || null;
  }

  /** 结束编辑会话但**保留**中转区里的未保存修改（例如临时去看别的卡） */
  function suspendEdit() {
    if (!state.edit) return;
    state.edit = null;
    state.current = null;
    emit('edit-suspended');
  }

  /* ---------- 角色操作 ---------- */

  /** 是否存在「未完成」的草稿（已完成/已删除的不算） */
  function isDraftActive() {
    return !!state.draft;
  }

  function clearDraft(id) {
    if (id && state.draft && state.draft.id !== id) return;
    state.draft = null;
    try { localStorage.removeItem(KEY_DRAFT); } catch (e) { /* 忽略 */ }
  }

  /**
   * 继续编辑草稿；没有草稿就新建一张空白卡。
   */
  function startDraft(ruleSystemId) {
    if (state.draft && state.draft.ruleSystemId === ruleSystemId) {
      state.current = normalize(state.draft);
      state.draft = state.current;
      emit('draft-resumed');
      return state.current;
    }
    return newDraft(ruleSystemId);
  }

  /**
   * 强制新建一张**空白**角色卡。
   * 关键：这里是「新建」的唯一入口，永远从 newCharacter 起步。
   * 之前复用 startDraft，只要 ruleSystemId 相同就会把上一张卡整份返回，
   * 于是「新建角色卡」套用了上一个人物的属性、技能、装备。
   * 若已有未完成草稿且填过内容，先归档进「我的角色」，避免静默丢失。
   */
  function newDraft(ruleSystemId) {
    archiveDraft();
    state.current = newCharacter(ruleSystemId);
    state.draft = state.current;
    write(KEY_DRAFT, state.current);
    emit('draft-new');
    return state.current;
  }

  /** 把有价值的草稿归档到角色列表（没有名字也没加过技能的空草稿直接丢弃） */
  function archiveDraft() {
    var d = state.draft;
    if (!d) return null;
    if (!d.characterName && !(d.skills || []).length) { clearDraft(); return null; }
    d.updatedAt = d.updatedAt || Date.now();
    state.characters[d.id] = d;
    write(KEY_CHARS, state.characters);
    clearDraft();
    return d;
  }

  function hasDraftFor(ruleSystemId) {
    return !!(state.draft && state.draft.ruleSystemId === ruleSystemId);
  }

  /**
   * 只读地「打开」一张卡（查看 / 生成图片用）。
   *
   * ⚠️ 这里返回的 state.current 与 state.characters[id] 是**同一个对象**，
   * 任何改动都会直接落到存储上 —— 所以它只适合查看场景。
   * 要改数据请走 beginEdit()，那条路给的是副本。
   */
  function loadCharacter(id) {
    var c = state.characters[id];
    if (!c) return null;
    // 正在编辑同一张卡：别把存储对象塞回 current，否则编辑副本白拷了
    if (state.edit && state.edit.id === id) {
      emit('loaded');
      return state.current;
    }
    // 正在编辑别的卡：结束会话但保留中转区，回来还能接着改
    if (state.edit) suspendEdit();
    state.current = normalize(c);
    // 已保存的角色不是草稿：不动 draft 槽，也不往草稿槽里写，
    // 这样「编辑已保存角色」不会把别人正在写的草稿顶掉。
    emit('loaded');
    return state.current;
  }

  function deleteCharacter(id) {
    delete state.characters[id];
    write(KEY_CHARS, state.characters);
    if (state.draft && state.draft.id === id) clearDraft(id);
    emit('deleted');
  }

  function listCharacters() {
    return Object.keys(state.characters).map(function (k) {
      var c = state.characters[k];
      // 列表是用来展示的（首页「最近的调查员」/「我的角色」），
      // 顺手补全旧字段并重算派生值，避免卡片上还挂着旧公式算出的数字。
      try {
        normalize(c);
        if (global.Engine && global.Engine.recalc) global.Engine.recalc(c);
      } catch (e) { /* 单条数据坏掉不影响其他角色 */ }
      return c;
    }).sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
  }

  function finalize() {
    // 编辑已保存的角色时，「完成」的语义就是「保存修改」——
    // 走 commitEdit 才会写回原卡；直接往下走会把卡当成新卡重新落库。
    if (state.edit) return commitEdit('编辑角色');
    var c = state.current;
    /* v2.1.6（用户第 5 项审查）：手动车卡完成时也要过 normalize ——
       「背景选了恐惧症/狂躁症 → 派生『疯狂症状』精神状态」等规则在 normalize 里，
       随机/AI 卡（savePreset）与编辑保存（commitEdit）都过，唯独手动 finalize 漏了。 */
    c = normalize(c);
    c.shareId = c.shareId || uid();
    c.version = c.version || 'v1.0';
    state.characters[c.id] = c;
    write(KEY_CHARS, state.characters);
    // 角色卡已完成 → 草稿收工，首页不会再挂着「未完成的草稿」
    if (state.draft && state.draft.id === c.id) clearDraft(c.id);
    emit('finalized');
    return c;
  }

  /**
   * 直接保存一张「已经生成好的」角色卡（第零步的随机预设卡用）。
   * 与 finalize() 的区别：不认 state.current，也不写草稿槽 ——
   * 预设卡是凭空造出来的新卡，不该顶掉玩家正在写的那张。
   * 顺手把「刚新建、还什么都没填」的空草稿清掉，
   * 免得首页老是挂着一条「发现未完成的草稿」。
   */
  function savePreset(c) {
    if (!c) return null;
    // 采用一张全新生成的卡 = 主动结束编辑会话（旧卡保持进入编辑前的样子）。
    // 界面上的入口都已经拦过「有未保存修改」，这里只是兜底，
    // 免得留下 current 被清空、edit.id 还挂着的半残状态。
    if (state.edit) suspendEdit();
    c = normalize(c);
    if (global.Engine && global.Engine.recalc) global.Engine.recalc(c);
    c.shareId = c.shareId || uid();
    c.version = c.version || 'v1.0';
    c.updatedAt = Date.now();
    state.characters[c.id] = c;
    write(KEY_CHARS, state.characters);
    var d = state.draft;
    if (d && d.id !== c.id && !d.characterName && !(d.skills || []).length) {
      state.draft = null;
      try { localStorage.removeItem(KEY_DRAFT); } catch (e) { /* 忽略 */ }
    }
    state.current = null;
    emit('finalized');
    return c;
  }

    /* v2.10.0（身体状态模型）：HP → 身体状态的**归位判据**（纯函数，仅用于老卡迁移）。
       ⚠️ 房间侧 room-model.js#bodyForHp 为**老卡迁移专用**；治愈伤势 healWound / 队友
       施救 aidApply 另用 v2.8.0 F3 冻结的 2 值判据（hp>=maxHP ? '正常' : '轻伤'），勿混用。
       这里是单机车卡侧的独立实现，与房间侧语义一致（本侧多一层 parseInt/isFinite 强制化）：
         · maxHP > 0 且 hp >= maxHP     → '正常'（满血）
         · maxHP > 0 且 hp * 2 >= maxHP → '重伤'（至多一半血）
         · 其余（含 maxHP 未知 / 为 0） → '轻伤' */
  function bodyForHp(hp, maxHP) {
    var h = parseInt(hp, 10);
    var m = parseInt(maxHP, 10);
    if (!isFinite(h)) h = 0;
    if (!isFinite(m)) m = 0;
    if (m > 0 && h >= m) return '正常';
    if (m > 0 && h * 2 >= m) return '重伤';
    return '轻伤';
  }

  /** 修复/补全旧数据结构 */
  function normalize(c) {
    var base = newCharacter(c.ruleSystemId);

    /* 迁移要放在「补默认值」之前做，否则会被 base 的 99 覆盖掉。
       旧版本只有一个 skillCap，现在拆成本职 / 兴趣两类。 */
    var legacyCap = parseInt(c.skillCap, 10);
    var hasSplit = (c.skillCapOcc !== undefined && c.skillCapOcc !== null) ||
                   (c.skillCapInterest !== undefined && c.skillCapInterest !== null);
    if (!hasSplit && legacyCap > 0) {
      c.skillCapOcc = legacyCap;
      c.skillCapInterest = legacyCap;
    }
    // 购点上限从没写过值的老卡：补一个真实初值，别让校验按 0 算
    if (c.pbCap === undefined || c.pbCap === null || c.pbCap === '') c.pbCap = 480;

    Object.keys(base).forEach(function (k) {
      if (c[k] === undefined || c[k] === null) c[k] = base[k];
    });
    if (!c.eduProgress || typeof c.eduProgress !== 'object') c.eduProgress = { base: null, done: 0, log: [], bonus: 0 };
    if (!Array.isArray(c.eduProgress.log)) c.eduProgress.log = [];
    if (c.eduProgress.bonus === undefined || c.eduProgress.bonus === null) {
      // 兼容只有 log 的老数据
      c.eduProgress.bonus = c.eduProgress.log.reduce(function (t, r) { return t + (parseInt(r && r.gain, 10) || 0); }, 0);
    }
    c.eduProgress.done = c.eduProgress.log.length;

    // 天命 N 选一：老数据没有这个字段，补一份空状态（不能是 undefined，
    // 否则「已掷出」判定和 options 遍历都会炸）
    if (!c.fate || typeof c.fate !== 'object') c.fate = { n: 5, rolled: false, options: [], picked: -1, rolledAt: 0 };
    if (!Array.isArray(c.fate.options)) c.fate.options = [];
    var fn = parseInt(c.fate.n, 10);
    c.fate.n = (fn >= 2 && fn <= 10) ? fn : 5;
    var fp = parseInt(c.fate.picked, 10);
    c.fate.picked = (fp >= 0 && fp < c.fate.options.length) ? fp : -1;
    c.fate.rolled = !!c.fate.rolled && c.fate.options.length > 0;
    ['basicInfo', 'attributes', 'status', 'assets', 'background', 'mythos'].forEach(function (k) {
      c[k] = Object.assign({}, base[k], c[k] || {});
    });
    ['skills', 'weapons', 'armors', 'vehicles', 'items', 'history', 'companions', 'changeLog'].forEach(function (k) {
      if (!Array.isArray(c[k])) c[k] = [];
    });
    if (!c.occupationPicks) c.occupationPicks = {};
    // 已保存过的角色：状态值必须锁定，不能因为缺少标记而重新初始化
    var anyStatus = c.status.currentHP || c.status.currentMP || c.status.currentSAN || c.status.currentLuck;
    if (anyStatus || (c.derivedStats && c.derivedStats.maxHP > 0)) {
      c.status._inited = true;
      // 幸运跟随标记：历史数据没有该标记时视为未手动改过
      if (c.status._luckTouched === undefined) c.status._luckTouched = false;
    }
    // 同步 age
    c.age = c.basicInfo.age;

    /* 精神状态：老卡是**单选字符串**（'正常' / '临时疯狂'…），
       现在改成**多选数组**（一个人可以同时有永久疯狂 + 临时疯狂）。
       这里做一次性迁移：字符串 → [字符串]；空 → ['正常']。
       必须幂等 —— 已经是数组就不再动。 */
    var ms = c.status.mental;
    if (ms === undefined || ms === null || ms === '') {
      c.status.mental = [MENTAL_NORMAL];
    } else if (!Array.isArray(ms)) {
      c.status.mental = [String(ms)];
    } else {
      c.status.mental = ms.filter(function (x) { return x !== undefined && x !== null && x !== ''; });
      /* v2.1.5（用户第 1 项）：「永久疯狂」互斥 —— 类似「正常」，选了只留它一项。
         在数据层也守一道，防止直接写数据绕过 UI 互斥。 */
      if (c.status.mental.indexOf('永久疯狂') >= 0) c.status.mental = ['永久疯狂'];
      if (!c.status.mental.length) c.status.mental = [MENTAL_NORMAL];
    }

    /* v2.10.0（身体状态模型）：老卡身体状态迁移（幂等）。
       旧模型里「濒死 / 昏迷」是 body 的单选值；新模型把二者改为布尔标记：
         · body='濒死' → body='重伤' + dying=true
         · body='昏迷' → unconscious=true，body 按 HP 归位（bodyForHp）
       迁移后 body 只可能是 {正常, 轻伤, 重伤, 死亡}，第二遍跑不再命中 → 不漂移。
       ⚠️ 撕卡判据不变：仍只认 body === '死亡'（app.js#isRippedCard）。 */
    if (c.status.body === '濒死') {
      c.status.body = '重伤';
      c.status.dying = true;
    } else if (c.status.body === '昏迷') {
      c.status.unconscious = true;
      c.status.body = bodyForHp(c.status.currentHP, c.status.maxHP);
    }
    /* 标记位一律收敛为布尔：缺键时上面 Object.assign 已补 false，
       显式写成 undefined / null 的脏数据也在这里兜底（UI 读出来不能是 undefined）。 */
    c.status.dying = !!c.status.dying;
    c.status.unconscious = !!c.status.unconscious;

    /* 背景里的「恐惧症 / 狂躁症」老卡只有文本、没有结构化数组，
       这里做一次性迁移把它们补进 madness（永久疯狂）。幂等，重复跑不会重复加。
       放在最后：此时 background / madness 都已补过默认值。 */
    if (global.CocMadness && global.CocMadness.fromBackground) {
      global.CocMadness.fromBackground(c);
    }

    /* v2.1.5（用户第 1 项）：「疯狂症状」精神状态的**派生同步**。
       持有具体症状（madness 数组非空）→ 自动勾选「疯狂症状」；
       没有症状 → 自动摘掉。这样「车卡保存后同步到状态管理」「跑团选卡时应用」
       都能拿到一致的结果，不依赖玩家手点。
       ⚠️ 「正常」与「永久疯狂」是互斥项，此时不加派生项。

       v2.7.0（用户第 2 项）：**背景自带的疯狂症状**（恐惧症 / 狂躁症）本身就是
       「疯狂症状」—— 它是永久标记（permanent / bg），理应与「正常」互斥。原逻辑里
       「新卡默认 mental=['正常']」会让 isExclusive=true → 走 else 把派生**短路**，
       卡上于是呈现「精神状态=正常 + 一条背景症状」的自相矛盾。这里分开处理：
         · 角色持有**背景 / 永久症状**（madness 里有 bg===true 或 permanent===true 的条目）
           → 强制勾选「疯狂症状」，并**移除**「正常」（二者互斥）；
         · 既有的「永久疯狂」互斥规则**优先**（有永久疯狂时仍只留它一项）；
         · 其余行为保持不变（无任何症状时仍回落 ['正常']）。 */
    if (global.CocMadness && typeof global.CocMadness.list === 'function') {
      var SYM = '疯狂症状';
      var madList = global.CocMadness.list(c);
      var hasSymptom = madList.length > 0;
      var hasPermanent = c.status.mental.indexOf('永久疯狂') >= 0;
      /* 背景 / 永久症状：带 bg 标记，或 permanent（兼容更老的数据，见 madness.js#make） */
      var hasPermSymptom = hasSymptom && madList.some(function (x) {
        return x && (x.bg === true || x.permanent === true);
      });
      if (hasPermanent) {
        /* 「永久疯狂」是撕卡级互斥项：保持只留它一项，不加派生项。 */
        c.status.mental = ['永久疯狂'];
      } else if (hasPermSymptom) {
        /* 背景 / 永久症状 → 一定是「疯狂症状」，且与「正常」互斥。 */
        var kept = c.status.mental.filter(function (x) { return x !== '正常' && x !== SYM; });
        kept.push(SYM);
        c.status.mental = kept;
      } else if (hasSymptom && c.status.mental.indexOf('正常') < 0) {
        if (c.status.mental.indexOf(SYM) < 0) c.status.mental.push(SYM);
      } else {
        var without = c.status.mental.filter(function (x) { return x !== SYM; });
        c.status.mental = without.length ? without : [MENTAL_NORMAL];
      }
    }
    return c;
  }

  function setSettings(patch) {
    Object.assign(state.settings, patch);
    write(KEY_SETTINGS, state.settings);
    emit('settings');
  }

  /* ---------- 导入/导出 ---------- */
  function exportCharacter(id) {
    /* 编辑中的卡：导出眼前这一版（用户看到什么就导出什么）。
       否则导出的会是存储里那份「还没被改过」的，跟屏幕对不上。 */
    var c = (state.edit && state.edit.id === id && state.current)
      ? state.current
      : (state.characters[id] || (state.current && state.current.id === id ? state.current : null));
    if (!c) return null;
    return JSON.stringify({ format: 'coc7-card', version: 1, data: c }, null, 2);
  }

  function importCharacter(jsonText) {
    try {
      var obj = JSON.parse(jsonText);
      var c = obj.data || obj;
      if (!c.characterName && !c.id) throw new Error('格式不正确');
      c.id = uid();
      c = normalize(c);
      state.characters[c.id] = c;
      write(KEY_CHARS, state.characters);
      emit('imported');
      return c;
    } catch (e) { return null; }
  }

  function getState() { return state; }

  /**
   * v2.0.2：覆盖写一张卡（用于房间临时卡的「生效」）。
   * 与 savePreset / finalize 的区别：不认 state.current、不写草稿槽，
   * 只按 id 覆盖已存在（或新建）的那张卡 —— 「生效」的语义就是「把这张卡的内容换掉」。
   * @returns {boolean} 写盘是否成功
   */
  function upsertCharacter(card) {
    if (!card || !card.id) return false;
    state.characters[card.id] = normalize(card);
    var ok = write(KEY_CHARS, state.characters);
    emit('saved');
    return ok;
  }

  global.Store = {
    uid: uid,
    newCharacter: newCharacter,
    getState: getState,
    subscribe: subscribe,
    startDraft: startDraft,
    newDraft: newDraft,
    isDraftActive: isDraftActive,
    clearDraft: clearDraft,
    archiveDraft: archiveDraft,
    hasDraftFor: hasDraftFor,
    loadCharacter: loadCharacter,
    deleteCharacter: deleteCharacter,
    listCharacters: listCharacters,
    finalize: finalize,
    savePreset: savePreset,
    /* v2.0.2：覆盖写一张卡（房间临时卡「生效」用） */
    upsertCharacter: upsertCharacter,
    /* 编辑会话：改已保存的角色必须先 beginEdit，改完 commitEdit 才落库 */
    beginEdit: beginEdit,
    commitEdit: commitEdit,
    cancelEdit: cancelEdit,
    suspendEdit: suspendEdit,
    isEditing: isEditing,
    editingId: editingId,
    isEditDirty: isEditDirty,
    editInfo: editInfo,
    normalize: normalize,
    scheduleSave: scheduleSave,
    saveNow: saveNow,
    setSettings: setSettings,
    exportCharacter: exportCharacter,
    importCharacter: importCharacter,
    /* 精神状态的读写助手（多选数组）。放在 Store 上是因为
       「字符串 → 数组」的兼容规则只有一处，别让每个调用方各写一遍。 */
    MENTAL_NORMAL: MENTAL_NORMAL,
    mentalList: function (c) {
      var m = c && c.status && c.status.mental;
      if (Array.isArray(m)) return m.filter(Boolean);
      if (m === undefined || m === null || m === '') return [MENTAL_NORMAL];
      return [String(m)];
    },
    mentalText: function (c) {
      var l = global.Store.mentalList(c);
      return l.length ? l.join('　') : MENTAL_NORMAL;
    }
  };
})(window);
