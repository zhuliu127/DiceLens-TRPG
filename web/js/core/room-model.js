/* ============================================================
 * room-model.js — 跑团房间的数据模型 / 事件协议 / 权限矩阵
 * 对外命名：window.RoomModel
 *
 * 需求文档 §0 硬要求：
 *   ·「不得把 KP 隐藏信息先广播、再靠 UI 隐藏」—— 未授权客户端**不能收到**数据
 *   ·「回退必须恢复状态快照与关联事件，不能只删界面文字」
 *   ·「房间事件协议、权限规则在局域网与公网共用同一套」
 *
 * 所以这个模块是房间的**唯一权威状态机**：
 *   KP 端（Host）持有真相并按序广播；玩家端（Client）是它的确定性回放。
 *   界面只做「把 state 画出来」和「把用户操作变成 intent」，不许自己改 state。
 *
 * 三条设计约束（与 room-rules.js 一致）：
 *   1) 纯逻辑：不碰 DOM、不发请求、不读 localStorage（持久化在 room-store.js）。
 *   2) 时间可注入（opts.now）、随机可注入（opts.rng）—— 否则测试只能靠运气。
 *   3) 没有「隐式副作用」：所有状态变更都经过 apply(evt) 一个口，
 *      这样回退 = 重放日志到某个 seq，天然与「关联事件」一起回滚。
 *
 * ── 两层协议，别混 ────────────────────────────────────────────
 *   中继层（server / 局域网外壳 ↔ 权威端）：hub.* / peer.*（见 room_server.py）
 *   应用层（KP ↔ 玩家，经中继**原样透传**）：本模块的 {k:'sync'|'evt'|'intent'}
 *   中继不认识应用层的任何字段，因此加新事件类型永远不用改服务端。
 * ============================================================ */
(function (global) {
  'use strict';

  /* ============================================================
   * 常量
   * ============================================================ */

  var ROLE = { KP: 'kp', PLAYER: 'player', SPECTATOR: 'spectator' };

  /* 房主的固定座位号。花名册（Roster）里**没有**房主 ——
     花名册记的是「有哪些玩家/旁观者」，房主是这间房本身。
     所以凡是要「从座位推身份」的地方都必须先认这个常量，
     不能拿 roster.get(seat) 拿到 undefined 就当旁观者（那样房主自己就发不了言）。 */
  var HOST_SEAT = 'host';

  /* v2.0.0：新增 SUSPENDED（已挂起，可续玩）。
     ⚠️ 不要改 CLOSED 的语义 —— 旧客户端把 CLOSED 当终止，改它会破坏兼容。 */
  var STATUS = { RECRUITING: 'RECRUITING', IN_GAME: 'IN_GAME', CLOSED: 'CLOSED', SUSPENDED: 'SUSPENDED' };

  var STATUS_TEXT = {
    RECRUITING: '招募中',
    IN_GAME: '游戏中',
    CLOSED: '已结束',
    SUSPENDED: '已挂起（可续玩）'
  };

  /** 应用层事件类型（KP → 玩家） */
  var EVT = {
    HELLO: 'hello',        // 全员：房间元信息
    MEMBERS: 'members',    // 全员：成员表全量（增删改都用它，省得diff）
    CHAT: 'chat',          // 全员：聊天 / 系统消息
    DICE: 'dice',          // 全员：骰点结果（权威掷骰）
    LOG: 'log',            // 全员：公共事件流（检定、场景推进…）
    SCENE: 'scene',        // 全员：探索场景（图片、标记、揭示状态）
    COMBAT: 'combat',      // 全员：战斗态（行动顺序、当前行动者）
    TURN: 'turn',          // 全员：行动轮推进
    STATUS: 'status',      // 全员：房间状态机切换
    KICK: 'kick',          // 针对某 seat：你被移出
    CLOSED: 'closed',      // 全员：关房 / 结团
    PRIVATE: 'private',    // 针对某 seat：只有他能收到的信息（线索、SAN 结果…）
    /* ---- P4 探索 ---- */
    BOARD: 'board',        // 针对某 seat：他的个人手绘板（别人只看缩略/公开）
    ASSET: 'asset',        // 全员：素材库（已公开的那些）；KP 的未公开素材走 local
    /* ---- P5 战斗 ---- */
    ACTOR: 'actor',        // 全员：一个战斗参与者的公开状态（HP 数字按可见性裁剪）
    TURNSTATE: 'turnstate',// 全员：当前行动者 / 剩余行动次数 / 回合号
    CHECK: 'check',        // 全员（或 SEAT）：一次检定的公开结果 / 指定人收到
    /* ---- P6 KP 工具 ---- */
    REQUEST: 'request',    // 针对某 seat：KP 请求改你的状态，等你同意
    REWIND: 'rewind',      // 全员：回退投票的状态（发起/某人投票/结果）
    /* 回合边界（v1.19.0）：显式标记「一个新回合从这里开始」。
       ⚠️ 为什么必须有它：本模型原先**根本没有「游戏回合」这个概念** ——
       meta.round 只是战斗轮（combat.round）的影子，探索态恒为 0，
       于是「回退 N 回合」既显示成第 1 回合、又算不出真正的回退点。
       现在由这条事件（而不是命令式赋值）写 state.meta.round，
       快照 / 重放 / 全量同步就都能带上正确的回合号。 */
    ROUND: 'round',
    /* v2.9.0（用户第 1 项）：KP 点「推进一回合」→ 各玩家本机把「本局临时卡」自动
       「生效到原卡」（覆盖）。
       PUBLIC：房间内所有人都会收到，但只有**各自本机持有本房临时卡**的客户端才会
       真正执行 —— 临时卡存在每个玩家本机 localStorage（不跨设备），KP 写不了别人的
       存储，故「KP 广播 → 各玩家客户端自行落库」。
       ⚠️ 该事件**不进存档**：reduce 无对应分支（只落 KP 内存日志），save() 亦不含它。 */
    TEMP_COMMIT: 'tempcommit',
    ENDED: 'ended',        // 全员：结团（与 CLOSED 不同：结团会归档并回首页）
    /* ---- v2.0.0 存档 / 角色卡 / 战斗提醒 / 场景检定 ---- */
    ARCHIVE: 'archive',        // 仅 KP（SEAT 到 host）：存档推送结果 {seq, savedAt, ok}
    SCENE_CHECK: 'scenecheck', // 全员：场景检定步骤引擎 {id,title,desc,steps,cursor,results}
    /* 针对某 seat：权威端把角色卡状态写回玩家本机。
       载荷带 seq 做**幂等**（同一 seq 应用两次只扣一次血）。 */
    STATE: 'state',
    /* 全员：轮次强提醒（界面据此弹窗 / 响铃）。
       ⚠️ 与检定用的 EVT.CHECK 分开：CHECK 是检定结果，别混用。 */
    TURN_ALERT: 'turnalert',
    /* v2.2.0（用户第 3 项）：对抗申请 / 状态。
       phase='await_kp'（玩家申请，SEAT→KP）/ 'await_target'（玩家胜后选怪，SEAT→玩家）
       / 'rejected'、'resolved'（核销待办）。载荷：{id, by, phase, weapon, db, targetId, targetName, at}。 */
    OPPOSED: 'opposed'
  };

  /** 玩家意图（玩家 → KP），KP 校验权限后翻译成事件 */
  var INTENT = {
    SYNC: 'sync',          // 我上线了（带 lastSeq），KP 回 sync 或补拉
    READY: 'ready',        // 准备 / 取消准备
    CHAT: 'chat',
    DICE: 'dice',          // 请求掷骰（由 KP 权威掷，避免各掷各的）
    CHAR: 'char',          // 上报自己的角色卡摘要
    ACT: 'act',            // 通用动作：{op, ...}
    BOARD: 'board',        // 个人手绘板 / 标记
    VOTE: 'vote',          // 回退投票：同意 / 拒绝
    CONSENT: 'consent',    // 对 KP 改我状态的请求：同意 / 拒绝
    CONFIRM: 'confirm',    // KP 对已排队的高危动作（twice/kp）做二次确认
    /* v2.0.0：玩家确认已把状态写入本机角色卡（幂等回执）。载荷 {seq} */
    STATE_SYNC: 'statesync',
    /* v2.1.1：玩家**自助 SAN 检定**。客户端不得自行改权威状态 —— 只声明「我要做
       SAN 检定 + 成功/失败损失表达式」，由权威端用**该玩家当前 SAN** 结算后
       经 EVT.STATE 写回，落其人物卡（幂等）。载荷 { okLoss, loss, reason }。 */
    SAN_CHECK: 'sancheck',
    /* v2.2.0（用户第 3 项）：玩家发起**武器对抗**。
       phase='request'（选武器 + 选目标怪物 → 推送 KP）/ 'target'（胜后多怪时选怪结算伤害）。 */
    OPPOSED: 'opposed'
  };

  /** 游戏模式（需求 §2.4：与房间生命周期状态分开，不要混成一个字段） */
  var MODE = { EXPLORATION: 'EXPLORATION', COMBAT: 'COMBAT' };

  /** 回退投票状态 */
  var REWIND = { IDLE: 'IDLE', VOTING: 'VOTING', DONE: 'DONE', FAILED: 'FAILED' };

  /**
   * 可见性。**这是安全边界，不是显示开关。**
   *   PUBLIC  → 房间内所有人（含旁观者）
   *   KP      → 只有 KP 端持有，根本不会出现在发给别人的字节里
   *   SEAT    → 只有指定 seat 收得到（逐人单发，绝不广播）
   */
  var VIS = { PUBLIC: 'public', KP: 'kp', SEAT: 'seat' };

  /**
   * 私有字段名。命中这些键的载荷**只允许**随 vis=SEAT 下发，
   * 否则在 dispatch 阶段直接剥掉并记警告（见 scrub()）。
   * 这一层是「不许先广播再隐藏」的机械保证：写错代码也漏不出去。
   */
  /* v2.1.4（用户第 3 项）：奖励/惩罚骰个数上限。规则书常规上限是 2，
     但「可依据规则和 KP 裁定配置多个奖惩骰」（需求 §7.2）—— 界面上给到 5，
     模型侧必须与界面同值，否则界面加得上、模型又夹回 2（用户实测「点 + 没反应」）。 */
  var MOD_CAP = 5;

  var SECRET_KEYS = ['secret', 'hidden', 'kpOnly', 'truth', 'clue', 'spoiler', 'answer'];

  /* ============================================================
   * 权限与确认策略
   *
   * confirm 的语义（需求 §7 / §9 / §12）：
   *   null     → 直接执行
   *   'twice'  → 二次确认（关房、结团这类不可逆的）
   *   'kp'     → 该操作由玩家发起，需 KP 确认
   *   'owner'  → 该操作由 KP 发起，需**被改的玩家**确认
   *   'all'    → 需在场玩家逐个同意（回退回合）
   * ============================================================ */
  var POLICY = {
    'chat': { roles: ['kp', 'player'], confirm: null },
    'dice.request': { roles: ['kp', 'player'], confirm: null },
    'ready.set': { roles: ['player'], confirm: null },
    'char.share': { roles: ['player'], confirm: null },
    'board.self': { roles: ['kp', 'player'], confirm: null },
    'state.edit.self': { roles: ['player'], confirm: 'kp' },
    'state.edit.other': { roles: ['kp'], confirm: 'owner' },
    'room.start': { roles: ['kp'], confirm: null },
    'room.kick': { roles: ['kp'], confirm: null },
    'room.close': { roles: ['kp'], confirm: 'twice' },
    'room.end': { roles: ['kp'], confirm: 'twice' },
    'scene.set': { roles: ['kp'], confirm: null },
    'scene.reveal': { roles: ['kp'], confirm: null },
    'scene.clue': { roles: ['kp'], confirm: null },
    'scene.mode': { roles: ['kp'], confirm: null },         // 切探索 / 战斗模式
    /* KP 请求改玩家状态：真正生效靠玩家的 CONSENT 意图（见 stateRequest / consent） */
    'state.request': { roles: ['kp'], confirm: null },
    /* P4 补充：素材、地图标记、绘画、清屏、个人手绘板 */
    'asset.add': { roles: ['kp'], confirm: null },
    'asset.reveal': { roles: ['kp'], confirm: null },
    /* v2.6.0（用户第 1 项）：KP 指定中央底图（只能选「已公开」素材；传空 id 清除底图） */
    'asset.cover': { roles: ['kp'], confirm: null },
    /* v2.1.3（用户第 5 项）：KP 删素材（同时从私有库与已公开列表撤下） */
    'asset.del': { roles: ['kp'], confirm: null },
    /* v2.1.3（用户第 4 项）：玩家删**自己的**物品（跨玩家删由处理函数拒绝） */
    'item.del': { roles: ['kp', 'player'], confirm: null },
    /* v2.1.4（用户第 2 项 ·「增加状态管理按钮…不需要 kp 同意（可以直接修改）」）：
       `state.edit.self`（玩家改自己）要求 KP 二次确认；这里是一条**免确认**通道，
       玩家改自己的 HP/MP/SAN/临时状态/疯狂即可生效。跨玩家仍被拒绝（见 stateSelf）。 */
    'state.self': { roles: ['player', 'kp'], confirm: null },
    /* v2.1.5（用户第 3 项）：推进 1 轮（消除临时/不定疯狂），无需 KP 同意。 */
    'madness.advance': { roles: ['player', 'kp'], confirm: null },
    /* v2.1.6：治愈不定疯狂 —— 玩家发起需 KP 同意（confirm:'kp' 进待确认队列）。 */
    'madness.cure': { roles: ['player', 'kp'], confirm: 'kp' },
    'map.mark': { roles: ['kp'], confirm: null },
    'map.stroke': { roles: ['kp'], confirm: null },
    'map.clear': { roles: ['kp'], confirm: null },
    /* v2.5.0（用户第 4 项）：整集替换地图笔迹（实时橡皮擦）—— 保留 marks、不写公开记录 */
    'map.strokes.set': { roles: ['kp'], confirm: null },
    'board.self': { roles: ['kp', 'player'], confirm: null },
    /* P5 战斗 */
    'combat.set': { roles: ['kp'], confirm: null },
    'combat.start': { roles: ['kp'], confirm: null },
    'combat.next': { roles: ['kp'], confirm: null },
    'combat.actor': { roles: ['kp'], confirm: null },       // 新增/改怪物 NPC
    /* v2.7.0（用户第 1 项）：KP 把玩家 / 单位**追加**进正在进行的战斗（幂等，不重置轮次） */
    'combat.enqueue': { roles: ['kp'], confirm: null },
    /* v2.5.0（用户第 5 项）：开战前的「怪物 / NPC 候选池」（探索态也能选到怪） */
    'combat.pool.set': { roles: ['kp'], confirm: null },
    'combat.attack': { roles: ['kp', 'player'], confirm: null }, // 玩家仅在自己行动窗口
    'combat.damage': { roles: ['kp'], confirm: null },
    'combat.end': { roles: ['kp'], confirm: null },
    'combat.roll': { roles: ['kp', 'player'], confirm: null },
    /* 权威掷骰：由 KP 端规则服务算出结果后带上，避免各掷各的（需求 §10） */
    'dice.roll': { roles: ['kp'], confirm: null },
    /* P6 KP 工具 */
    'check.request': { roles: ['kp'], confirm: null },      // 发起检定（普通/对抗/场景）
    'check.push': { roles: ['kp'], confirm: null },         // 允许推动
    /* ---- v2.1.0 #11：KP 定向指令（对指定玩家直接推送，无需玩家同意）----
       「KP 没有角色参与到游戏」：这些按钮是给玩家一个变化，不是 KP 自己检定。
       一律 roles:['kp'] —— 玩家端发同 op 必须被拒。 */
    'dice.dark': { roles: ['kp'], confirm: null },          // 暗骰（结果只进 KP 自己的 .gp-priv）
    'sheet.damage': { roles: ['kp'], confirm: null },       // 指定玩家扣 HP
    'sheet.sancheck': { roles: ['kp'], confirm: null },     // 指定玩家做 SAN Check
    'sheet.tempstatus': { roles: ['kp'], confirm: null },   // 给指定玩家加临时状态
    'sheet.item': { roles: ['kp'], confirm: null },         // 给指定玩家一个物品
    /* v2.9.0（用户第 3 项）：`rollback.turn` 的**入口 op 已从 POLICY 移除** ——
       回退功能的所有 UI 入口已被删除。若入口 op 仍被允许，一条**伪造的 ACT** 就能把
       房间推进「回退投票态」，而投票 UI 已不存在 → 房间可能被卡死。故摘掉它
       （`needs()` 默认闭 → 伪造 ACT 一律「没有权限执行该操作」）。
       ⚠️ 取舍：**只摘 POLICY 这一条**，绝不删方法 / 事件 / 枚举 / reduce 分支 ——
       rollbackPropose / rollbackVote / rollbackCommit / EVT.REWIND / INTENT.VOTE /
       REWIND / `case EVT.REWIND` / `state.rewind` 全部**休眠保留**，用于**旧存档回放
       兼容**（删了会让老存档 reduce 走空分支、历史回退状态丢失）。
       下面这一条（rollback.commit 的 POLICY）同样**休眠保留**。 */
    'rollback.commit': { roles: ['kp'], confirm: null },
    /* v1.19.0：探索态「⏭ 进入下一回合」—— 显式回合边界（时间流逝：每日/每周恢复、
       各玩家临时卡自动生效）。v2.9.0：原「回退 N 回合」入口已移除，本项只关「回退」。
       （rollback.round 为同义别名，兼容架构文档里的命名。）
       ⚠️ `round.next` 与别名 `rollback.round` 属**推进侧**，这两条必须保留
          （推进回合要照常可用）。 */
    'round.next': { roles: ['kp'], confirm: null },
    'rollback.round': { roles: ['kp'], confirm: null },
    'session.end': { roles: ['kp'], confirm: 'twice' },
    /* ---- v2.0.0 新增动作（契约 §5.3）---- */
    /* 选怪流程：纯 UI，不产生事件；实际提交走 combat.start。
       仍登记在权限表里，这样 needs() 能覆盖、伪造的 ACT 也进不来。 */
    'combat.prepare': { roles: ['kp'], confirm: null },
    /* 场景检定步骤引擎（契约 §5.1 EVT.SCENE_CHECK / §4.3） */
    'scene.check.push': { roles: ['kp'], confirm: null },
    'scene.check.step': { roles: ['kp'], confirm: null },
    /* 对抗检定（支持非对称：NPC 侦查 vs 玩家潜行） */
    'check.opposed': { roles: ['kp'], confirm: null },
    /* 挂起 / 复活房间（存档保留 30 天，可续玩）。
       ⚠️ suspend/resume 的**网络副作用**由传输层（HostSide）触发：
       room-model 是纯逻辑，不发请求。 */
    'room.suspend': { roles: ['kp'], confirm: null },
    'room.resume': { roles: ['kp'], confirm: null },
    /* v2.3.0（用户第 7 项）：游戏中修改检定成败阈值（大成功 / 大失败），仅 KP，改完立即广播。 */
    'room.rules': { roles: ['kp'], confirm: null },
    /* v2.3.0（用户第 7 项）：SAN 大失败后按规则书追加 1D10 理智损失（KP 一键入口，不自动扣）。 */
    'sheet.sanloss': { roles: ['kp'], confirm: null },
    /* v2.8.0（HP 机制 · 用户第 3/4 项）：治愈伤势 —— 清除重伤/濒死/昏迷；KP 直接生效，
       玩家发起需 KP 同意（与「治愈不定疯狂」同款结构）。 */
    'sheet.healwound': { roles: ['player', 'kp'], confirm: 'kp' },
    /* v2.8.0（HP 机制 · 用户第 2 项）：队友施救（急救 / 医学）—— 玩家发起需 KP 同意。 */
    'aid.apply': { roles: ['player', 'kp'], confirm: 'kp' },
    /* v2.11.0（用户第 3 项）：玩家「精神分析」—— 治愈队友精神状态（不定疯狂）+ 回 SAN；
       玩家发起需 KP 同意（与 aid.apply 同款结构）；失败则目标失 SAN。 */
    'aid.psycho': { roles: ['player', 'kp'], confirm: 'kp' }
  };

  /** 需要「玩家同意」的确认类型（'owner' 由被改的玩家同意；'all' 由全员投票） */
  var CONFIRM = { NONE: null, TWICE: 'twice', KP: 'kp', OWNER: 'owner', ALL: 'all' };

  /** 是否允许 role 做 action */
  function allowed(role, action) {
    var p = POLICY[action];
    if (!p) return false;
    return p.roles.indexOf(role) >= 0;
  }

  /** 返回 {allowed, confirm}；confirm 见 POLICY 注释 */
  function needs(role, action) {
    var p = POLICY[action];
    if (!p || p.roles.indexOf(role) < 0) return { allowed: false, confirm: null };
    return { allowed: true, confirm: p.confirm || null };
  }

  /**
   * v2.3.0（用户第 7 项）：把房间 meta 里的大成功 / 大失败阈值翻成 CocRules.check
   * 需要的可选项 { critMax, fumbleMin }。
   *
   * ⚠️ 语义铁律（保证「默认行为与改动前逐字节一致」）：
   *   · 只有**落在 1–99** 的自定义值才下发；其余（100 / 0 / 空 / 非法）一律**不下发**
   *     → 规则层走默认（大成功 = 01；大失败 = 动态 96-100 或仅 100）。
   *   所以 meta.fumbleThreshold 的默认值 100 等价于「未自定义」，不会破坏低技能值的 96-100。
   */
  function ruleOptsOf(meta) {
    var o = {};
    var c = parseInt(meta && meta.critThreshold, 10);
    if (!isNaN(c) && c >= 1 && c <= 99) o.critMax = c;
    var f = parseInt(meta && meta.fumbleThreshold, 10);
    if (!isNaN(f) && f >= 1 && f <= 99) o.fumbleMin = f;
    return o;
  }

  /* ============================================================
   * 小工具
   * ============================================================ */

  function isObj(x) { return x !== null && typeof x === 'object'; }

  function clone(x) {
    if (x === null || typeof x !== 'object') return x;
    if (Array.isArray(x)) return x.map(clone);
    var o = {};
    for (var k in x) if (Object.prototype.hasOwnProperty.call(x, k)) o[k] = clone(x[k]);
    return o;
  }

  /** 载荷里是否含私有字段（递归） */
  function hasSecret(p) {
    if (!isObj(p)) return false;
    if (Array.isArray(p)) {
      for (var i = 0; i < p.length; i++) if (hasSecret(p[i])) return true;
      return false;
    }
    for (var k in p) {
      if (!Object.prototype.hasOwnProperty.call(p, k)) continue;
      if (SECRET_KEYS.indexOf(k) >= 0) return true;
      if (hasSecret(p[k])) return true;
    }
    return false;
  }

  /** 剥掉私有字段（返回副本） */
  function scrub(p) {
    if (!isObj(p)) return p;
    if (Array.isArray(p)) return p.map(scrub);
    var o = {};
    for (var k in p) {
      if (!Object.prototype.hasOwnProperty.call(p, k)) continue;
      if (SECRET_KEYS.indexOf(k) >= 0) continue;
      o[k] = scrub(p[k]);
    }
    return o;
  }

  /* ============================================================
   * 事件日志：序号 + 幂等 + 补拉 + 回退
   *
   * 序号为什么必须存在：
   *   WebSocket 断了会重连，补拉时一定会出现重复与乱序。
   *   没有序号就只能「收到就应用」，重放一次聊天就变成两条。
   * ============================================================ */

  function Log(cap) {
    this.cap = cap || 400;
    this.seq = 0;
    this.items = [];      // [{seq, evt}] 只保留最近 cap 条
    this.truncated = 0;   // 被丢弃的条数（补拉时据此判断「补不全了」）
  }

  /** 追加一条事件，返回它的记录 {seq, evt} */
  Log.prototype.push = function (evt) {
    this.seq += 1;
    var rec = { seq: this.seq, evt: evt };
    this.items.push(rec);
    while (this.items.length > this.cap) {
      this.items.shift();
      this.truncated += 1;
    }
    return rec;
  };

  /** 补拉：fromSeq 之后的全部（如果已经超出保留窗口，调用方要用全量同步兜底） */
  Log.prototype.since = function (fromSeq) {
    var out = [];
    for (var i = 0; i < this.items.length; i++) {
      if (this.items[i].seq > fromSeq) out.push(this.items[i]);
    }
    return out;
  };

  /** 能否用增量补齐（false 表示必须发全量 sync） */
  Log.prototype.canFill = function (fromSeq) {
    if (fromSeq >= this.seq) return true;
    if (!this.items.length) return false;
    return this.items[0].seq <= fromSeq + 1;
  };

  /**
   * 回退到 beforeSeq：**丢弃事件本身**，由调用方用「重放到 beforeSeq-1 的快照」替换状态。
   * 这里只负责裁剪日志 —— 需求 §12 明确「回退必须恢复状态快照与关联事件」，
   * 只删界面文字不算回退。
   */
  Log.prototype.rollbackBefore = function (beforeSeq) {
    var kept = [];
    for (var i = 0; i < this.items.length; i++) {
      if (this.items[i].seq < beforeSeq) kept.push(this.items[i]);
    }
    var dropped = this.items.length - kept.length;
    this.items = kept;
    this.seq = beforeSeq - 1;
    return dropped;
  };

  /* ============================================================
   * 成员表
   * ============================================================ */

  function Roster() {
    this.bySeat = {};     // seat -> member
    this.order = [];      // seat[]，稳定顺序（= 入座顺序，界面就按它排）
    /** 被踢过的 seat。为什么要有：踢人之后他的 mtoken 仍然有效，
        不记住就变成「踢了立刻又回来」，房主会觉得踢不掉。 */
    this.kicked = {};
  }

  /**
   * peer.open：有人上线。seat 是权威端认人的依据（重连不变）。
   * rejoin=true 表示「我断线期间他就在」——由房主重连时的名册补发而来，
   * 此时**不能**清掉他的准备状态与角色卡（他本人什么都没做）。
   */
  Roster.prototype.open = function (m) {
    m = m || {};
    var seat = m.seat || m.cid;
    if (!seat) return null;
    var old = this.bySeat[seat];
    var mem = old || {
      seat: seat,
      role: m.role || ROLE.PLAYER,
      nickname: m.nickname || '',
      online: true,
      ready: false,
      charId: null,
      charName: '',
      spec: false,
      joinedAt: 0
    };
    mem.cid = m.cid || mem.cid || '';
    mem.online = true;
    if (m.nickname) mem.nickname = m.nickname;
    if (m.role) mem.role = m.role;
    mem.spec = (mem.role === ROLE.SPECTATOR);
    if (!old) {
      mem.joinedAt = m.at || 0;
      this.bySeat[seat] = mem;
      this.order.push(seat);
    }
    return mem;
  };

  /** peer.close：连接断了。**不移除成员**，只标记离线（要能重连回来） */
  Roster.prototype.markOffline = function (seat) {
    var m = this.bySeat[seat];
    if (m) m.online = false;
    return m || null;
  };

  /** 真的移出（踢人 / 玩家主动离开） */
  Roster.prototype.remove = function (seat) {
    var m = this.bySeat[seat] || null;
    if (!m) return null;
    delete this.bySeat[seat];
    var i = this.order.indexOf(seat);
    if (i >= 0) this.order.splice(i, 1);
    if (this.kicked) this.kicked[seat] = true;
    return m;
  };

  Roster.prototype.get = function (seat) { return this.bySeat[seat] || null; };

  Roster.prototype.list = function () {
    var self = this;
    return this.order.map(function (s) { return self.bySeat[s]; }).filter(Boolean);
  };

  Roster.prototype.players = function () {
    return this.list().filter(function (m) { return m.role === ROLE.PLAYER; });
  };

  Roster.prototype.spectators = function () {
    return this.list().filter(function (m) { return m.role === ROLE.SPECTATOR; });
  };

  Roster.prototype.onlinePlayers = function () {
    return this.players().filter(function (m) { return m.online; });
  };

  Roster.prototype.allReady = function () {
    var ps = this.onlinePlayers();
    if (!ps.length) return false;
    return ps.every(function (m) { return m.ready; });
  };

  /** 给客户端用的快照（不含任何隐藏信息） */
  Roster.prototype.dump = function () {
    return this.list().map(function (m) { return clone(m); });
  };

  /* ============================================================
   * 房间状态
   * ============================================================ */

  function emptyState(meta) {
    return {
      meta: {
        code: (meta && meta.code) || '',
        name: (meta && meta.name) || '',
        rules: (meta && meta.rules) || 'coc7',
        kpName: (meta && meta.kpName) || '',
        maxPlayers: (meta && meta.maxPlayers) || 4,
        allowSpectate: meta ? !!meta.allowSpectate : true,
        status: (meta && meta.status) || STATUS.RECRUITING,
        /* 游戏模式与房间生命周期分开（需求 §2.4）。默认探索。 */
        mode: (meta && meta.mode) || MODE.EXPLORATION,
        round: (meta && meta.round) || 0,
        /* v2.3.0（用户第 7 项）：可自定义的大成功 / 大失败阈值。
           critThreshold 默认 1（仅 01 大成功）；fumbleThreshold 默认 100
           （= 未自定义 → 走动态规则：要求阈值 <50 时 96-100，否则仅 100）。 */
        critThreshold: (meta && meta.critThreshold !== undefined && meta.critThreshold !== null)
          ? num(meta.critThreshold, 1) : 1,
        fumbleThreshold: (meta && meta.fumbleThreshold !== undefined && meta.fumbleThreshold !== null)
          ? num(meta.fumbleThreshold, 100) : 100,
        /* v2.8.0（HP 机制 · 用户第 4 项）：每周（3 回合）重伤恢复判定的**座位基准表**。
           {seat: 上次周检定的回合号}。放进 meta → 随快照 / save/adoptSave 携带，
           回退 / 重连后不会错（见 _onDayWeekTick）。 */
        hpWeek: (meta && meta.hpWeek && typeof meta.hpWeek === 'object') ? clone(meta.hpWeek) : {},
        /* v2.11.0（用户第 3 项）：精神治疗冷却基准表 {seat: 上次接受精神治疗的回合号}。
           放进 meta → 随快照 / save / adoptSave 携带（与 hpWeek 同款生命周期）。 */
        psychoRound: (meta && meta.psychoRound && typeof meta.psychoRound === 'object') ? clone(meta.psychoRound) : {}
      },
      members: [],
      chats: [],          // {seq?, seat, nickname, text, at, kind}
      logs: [],           // {seq, seat, text, at, kind}
      dice: [],           // {seq, seat, expr, rolls, total, level, at}
      /* P4 探索场景：
         scene = {
           title, image,            // 当前中央展示图（已公开）
           assets: [...],           // 已公开素材 {id,kind,name,data,at}
           marks: [...],            // 已公开标记 {id,x,y,kind,label,assetId,at}
           strokes: [...],          // KP 地图笔迹 {id,color,width,pts:[{x,y}]}
           boardCount               // 手绘板数量（缩略走 BOARD 事件，正文单独取）
         }
         未公开的素材/标记/KP 备注**不进这个结构**，只在 KP 端 local 里。 */
      scene: null,
      /* P5 战斗：{ order:[{id,name,seat?,actorId,slot,totalSlots,done,public:{dex,state,hp?,hpMax?}}],
                    turn, round, startedAt }
         怪物 HP 数值是否出现由 scrub / actorOf 决定，不在这里自动带上。 */
      combat: null,
      privates: [],       // 只有本 seat 看得到的信息
      rewind: null,       // 回退投票：{id, by, turns, beforeSeq, votes:{seat:bool}, need, state, at}
      requests: [],       // 只有本 seat：KP 请求改状态的待办（客户端用）
      board: null,        // 只有本 seat：自己的手绘板 {strokes, at}
      /* v2.0.0 新增：
         sceneCheck 场景检定步骤引擎 {id,title,desc,steps,cursor,results}
         archive    最近一次存档推送结果（仅 KP 关心）
         lastState  最近一次角色卡状态写回（KP 端显示用）
         alert      最近一次轮次强提醒（界面弹窗/响铃的触发源） */
      sceneCheck: null,
      archive: null,
      lastState: null,
      alert: null,
      /* v2.2.0（用户第 3 项）：待处理的对抗申请 / 胜后选怪状态。{id,by,phase,weapon,db,targetId,targetName,at} */
      opposed: null,
      seq: 0,
      version: 1
    };
  }

  /* ============================================================
   * 状态归约：**所有**状态变更都走这里
   * 这样「回退 = 重放日志」才成立（需求 §12）
   * ============================================================ */

  function reduce(state, evt) {
    var p = evt.p || {};
    switch (evt.t) {
      case EVT.HELLO:
        if (p.meta) {
          for (var k in p.meta) {
            if (Object.prototype.hasOwnProperty.call(p.meta, k)) state.meta[k] = p.meta[k];
          }
        }
        break;
      case EVT.MEMBERS:
        state.members = clone(p.members || []);
        break;
      case EVT.STATUS:
        state.meta.status = p.status || state.meta.status;
        /* mode（探索/战斗）与房间生命周期状态是两回事（需求 §2.4），
           它跟着同一条 STATUS 事件下发 —— 漏了这里，客户端界面会永远停在探索。 */
        if (p.mode) state.meta.mode = p.mode;
        break;
      case EVT.CHAT:
        state.chats.push({ seq: evt.seq, seat: p.seat || '', nickname: p.nickname || '',
                           text: p.text || '', at: p.at || 0, kind: p.kind || 'user' });
        if (state.chats.length > 500) state.chats.splice(0, state.chats.length - 500);
        break;
      case EVT.LOG:
        state.logs.push({ seq: evt.seq, seat: p.seat || '', text: p.text || '',
                          at: p.at || 0, kind: p.kind || 'info' });
        /* v2.11.8（用户需求）：游戏记录上限从 500 提到 2000，长团也能完整留存。 */
        if (state.logs.length > 2000) state.logs.splice(0, state.logs.length - 2000);
        break;
      case EVT.DICE:
        state.dice.push({ seq: evt.seq, seat: p.seat || '', nickname: p.nickname || '',
                          expr: p.expr || '', rolls: clone(p.rolls || []),
                          total: p.total, level: p.level,
                          levelText: p.levelText || '', label: p.label || '',
                          at: p.at || 0 });
        if (state.dice.length > 200) state.dice.splice(0, state.dice.length - 200);
        break;
      case EVT.SCENE:
        state.scene = clone(p.scene || null);
        break;
      case EVT.COMBAT:
        state.combat = clone(p.combat || null);
        break;
      case EVT.TURN:
        if (state.combat) {
          state.combat.round = p.round === undefined ? state.combat.round : p.round;
          state.combat.turn = p.turn === undefined ? state.combat.turn : p.turn;
          if (p.order) state.combat.order = clone(p.order);
        }
        break;
      /* ---- 回合边界（v1.19.0）----
         由**事件**写 meta.round，而不是像旧代码那样在 nextTurn() 里命令式赋值。
         这样快照 / 回退重放 / 全量同步（syncFor）都能带上正确的回合号，
         客户端也能在断线重连后拿到当前回合。 */
      case EVT.ROUND:
        state.meta.round = (p.round === undefined || p.round === null)
          ? state.meta.round : p.round;
        break;
      /* ---- P4 探索 ---- */
      case EVT.BOARD:
        /* 手绘板：只更新「自己的」那一块；别人的手绘板正文不通过公共流下发，
           所以公共场景里只维护数量/缩略（需求 §6.2 允许最后写入策略）。 */
        if (!state.scene) state.scene = { title: '', image: '', assets: [], marks: [], strokes: [], boards: {} };
        if (!state.scene.boards) state.scene.boards = {};
        if (p.seat) state.scene.boards[p.seat] = { at: p.at || 0, count: (p.strokes || []).length,
                                                   thumb: p.thumb || '' };
        if (p.self && p.strokes) state.board = { strokes: clone(p.strokes), at: p.at || 0 };
        break;
      case EVT.ASSET:
        if (!state.scene) state.scene = { title: '', image: '', assets: [], marks: [], strokes: [], boards: {} };
        if (p.assets) state.scene.assets = clone(p.assets);
        break;
      /* ---- P5 战斗 ---- */
      case EVT.ACTOR:
        if (state.combat && p.actor) {
          var found = false;
          for (var ai = 0; ai < (state.combat.order || []).length; ai++) {
            if (state.combat.order[ai].id === p.actor.id) {
              state.combat.order[ai] = clone(p.actor); found = true; break;
            }
          }
          if (!found) {
            if (!state.combat.order) state.combat.order = [];
            state.combat.order.push(clone(p.actor));
          }
        }
        break;
      case EVT.TURNSTATE:
        if (state.combat) {
          state.combat.turn = p.turn === undefined ? state.combat.turn : p.turn;
          state.combat.round = p.round === undefined ? state.combat.round : p.round;
          if (p.order) state.combat.order = clone(p.order);
        }
        break;
      case EVT.CHECK:
        /* 检定结果进公共日志（可见性由 emit 时决定：SEAT 的不会到这里） */
        if (p.summary) {
          /* v2.2.0 修复（P2-A）：**非公共**检定（VIS.SEAT / VIS.KP）不得把明文
             （含骰值 / 胜负 / 伤害）写进 `state.logs` —— 否则 `syncFor(玩家)` 会把
             秘密对抗的全文同步给每个玩家。这里只落**一条脱敏行**（与「KP 暗骰」
             口径一致）；完整结果由调用方经 EVT.PRIVATE 单独发给 KP。
             `vis` 缺省（客户端 reduce / 旧调用）视为 PUBLIC → 行为不变。 */
          var checkPublic = (evt.vis === undefined || evt.vis === VIS.PUBLIC);
          if (checkPublic) {
            /* v2.2.0（用户第 3 项）：对抗攻击结果额外带一份结构化数据（opp），
               供 appendFeed 渲染反击/闪避、逐轮重掷与伤害段（失败/被躲开时 damage 为 null）。 */
            state.logs.push({ seq: evt.seq, seat: p.seat || '', text: p.summary,
                              at: p.at || 0, kind: 'check',
                              opp: p.kind === 'opposed' ? {
                                a: clone(p.a || null), b: clone(p.b || null),
                                winner: (p.winner === undefined ? null : p.winner),
                                tie: !!p.tie, reaction: p.reaction || '',
                                decidedBy: p.decidedBy || '', fallback: !!p.fallback,
                                rounds: clone(p.rounds || []),
                                damage: p.damage ? clone(p.damage) : null
                              } : null });
          } else {
            state.logs.push({ seq: evt.seq, seat: '', text: 'KP 秘密进行了一次检定',
                              at: p.at || 0, kind: 'check', opp: null, redacted: true });
          }
          if (state.logs.length > 2000) state.logs.splice(0, state.logs.length - 2000);
        }
        break;
      /* ---- v2.2.0（用户第 3 项）：对抗申请 / 状态 ----
         await_kp / await_target → 存待办；rejected / resolved → 清空。
         仅 KP（SEAT 单发）与「状态同步」会出现，玩家侧据 phase 驱动弹层/提示。 */
      case EVT.OPPOSED:
        if (p && (p.phase === 'await_kp' || p.phase === 'await_target')) state.opposed = clone(p);
        else state.opposed = null;
        break;
      /* ---- v2.0.0 场景检定步骤引擎 ----
         整块替换（与 SCENE / COMBAT 同一策略），避免 diff 出岔。 */
      case EVT.SCENE_CHECK:
        state.sceneCheck = (p && p.id) ? clone(p) : null;
        break;
      /* 角色卡状态写回：权威端已把它发给目标玩家（SEAT 单发）。
         这里只留最后一条，供 KP 端界面显示「已同步」。 */
      case EVT.STATE:
        state.lastState = {
          seat: p.seat || '', seq: num(p.seq, 0),
          status: clone(p.status || {}), at: p.at || 0
        };
        break;
      /* 存档推送结果（仅 KP 端关心） */
      case EVT.ARCHIVE:
        state.archive = { seq: num(p.seq, 0), savedAt: p.savedAt || 0, ok: !!p.ok };
        break;
      /* 轮次强提醒：界面据此弹窗 / 响铃 */
      case EVT.TURN_ALERT:
        state.alert = {
          kind: p.kind || 'turn', round: p.round, turn: p.turn,
          name: p.name || '', seat: p.seat || '', at: p.at || 0
        };
        break;
      /* ---- P6 KP 工具 ---- */
      case EVT.REQUEST:
        if (p.self && p.done) {
          /* 请求已被处理（玩家同意/拒绝）→ 从待办里摘掉。
             ⚠️ 没有这一支的后果（真机实测）：客户端的 requests 只增不减，
             界面永远渲染 requests[0] 那张旧卡 —— 玩家看到「请求框不消失、
             再点说已处理、KP 发的新请求排在后面永远显示不出来」。 */
          state.requests = (state.requests || []).filter(function (r) { return r.id !== p.id; });
        } else if (p.self) {
          state.requests.push({ id: p.id, op: p.op, p: clone(p.payload || {}),
                                from: p.from || 'KP', reason: p.reason || '',
                                at: p.at || 0 });
        }
        break;
      case EVT.REWIND:
        state.rewind = clone(p.rewind || null);
        break;
      case EVT.PRIVATE:
        /* v2.10.0（用户第 R4 项）：SEAT 定向私密事件**不归约进 host 的 state.privates** ——
           否则 KP「只给你看的信息」（scene.clue / _sysTo(玩家) / 玩家定向提示）会混进
           KP 栏目的所有玩家定向提示里（根因：reduce 的 PRIVATE 分支不检查 vis/to，无条件 push）。
           判据必须同时带 to 且 to!==HOST_SEAT：host emit 传了 vis/to；
           client receive 不传（vis undefined → 守卫不触发，玩家照常收到自己的私密）。
           KP 定向（_sysTo(HOST_SEAT) / darkRoll / 秘密对抗，to=HOST_SEAT）**不受影响**，
           暗骰与秘密对抗全文仍进 KP 栏。 */
        if (evt.vis === VIS.SEAT && evt.to && evt.to !== HOST_SEAT) break;
        state.privates.push({ seq: evt.seq, text: p.text || '', at: p.at || 0,
                             kind: p.kind || 'info', title: p.title || '' });
        if (state.privates.length > 100) state.privates.splice(0, state.privates.length - 100);
        break;
      case EVT.CLOSED:
        state.meta.status = STATUS.CLOSED;
        break;
      case EVT.ENDED:
        state.meta.status = STATUS.CLOSED;
        state.meta.ended = true;
        break;
      case EVT.KICK:
        state.meta.status = STATUS.CLOSED;
        break;
      default:
        break;
    }
    state.seq = evt.seq;
    return state;
  }

  /* ============================================================
   * 信封
   * ============================================================ */

  /** KP → 玩家：全量同步（重连、首连） */
  function syncMsg(seq, state) {
    return { k: 'sync', seq: seq, state: clone(state) };
  }

  /** KP → 玩家：增量事件 */
  function evtMsg(rec) {
    return { k: 'evt', seq: rec.seq, t: rec.evt.t, p: clone(rec.evt.p || {}) };
  }

  /**
   * KP → 玩家：序号水位标记（这条事件与你无关，但你要把 lastSeq 推到 seq）。
   *
   * ⚠️ 为什么必须有它：序号是**全局**的，而「私下递线索」只发给一个人。
   *    如果其余人什么都没收到，他们的 lastSeq 就会永久落后一格，
   *    下一条公共事件在他们看来就是「丢包」→ 反复补拉 → 补拉又补不回来
   *    （补拉只会重放与己相关的事件），于是界面卡死在补拉循环里。
   *    这一条很小（约 25 字节），而且只对 SEAT 事件产生，代价可以忽略。
   */
  function skipMsg(seq) {
    return { k: 'skip', seq: seq };
  }

  /** 玩家 → KP：意图 */
  function intentMsg(op, p) {
    return { k: 'intent', op: op, p: clone(p || {}) };
  }

  /** 解析中继传来的原始字符串；不是应用层消息就返回 null（例如中继自己的 host.gone） */
  function parse(text) {
    var m = null;
    try { m = JSON.parse(text); } catch (e) { return null; }
    if (!isObj(m)) return null;
    if (m.k === 'sync' || m.k === 'evt' || m.k === 'skip' || m.k === 'intent') return m;
    return null;
  }

  /* ============================================================
   * Host —— 权威端（KP 那台设备）
   * ============================================================ */

  function Host(opts) {
    opts = opts || {};
    this.state = emptyState(opts.meta);
    this.roster = new Roster();
    this.log = new Log(opts.logCap);
    /** KP 私密备忘：**不占共享序号**，也永不外发。
        让它占序号的话，每个玩家都会看到「有个序号我收不到」，
        既泄漏了「存在一条隐藏记录」，又白白增加水量标记。 */
    this.local = [];
    this.localSeq = 0;
    this.now = opts.now || function () { return Date.now(); };
    /** v2.1.5：随机源注入（死亡/疯狂判定的 CON/INT 检定用）。测试可替身；默认 Math.random。 */
    this.rng = opts.rng || Math.random;
    this.selfSeat = 'host';
    /** 回退用的状态快照。第 0 条永远是建团时的空状态 ——
        回退到最开头也要有东西可恢复，否则只能「什么都不做」。 */
    this.snapshots = [{ seq: 0, state: clone(this.state) }];
    this.snapshotEvery = opts.snapshotEvery || 20;
    /* 规则服务（v1.18.5 玩家直投骰用）：宿主注入，模型不硬依赖 window。
       Node 测试可以塞一个假实现；浏览器里就是 CocRules。 */
    this.rules = opts.rules || (typeof global !== 'undefined' ? global.CocRules : null) || null;
    /** 待确认队列：需要 owner/all 确认的操作挂在这里 */
    this.pending = [];
    /* 逐 seat 的私有累计（重连全量同步要靠它恢复）：
       _privateBySeat = 只发给某个人的线索/提示；
       _requestsBySeat = KP 请求改某个玩家状态的待办；
       _boardBySeat = 每个人的手绘板最新内容（只回给他自己）。 */
    this._privateBySeat = {};
    this._requestsBySeat = {};
    this._boardBySeat = {};
    /** v2.5.0（用户第 5 项）：KP 的「开战前候选池」（探索态就能选到的怪物 / NPC）。
        与 _boardBySeat 同款：权威端本地容器，不进 state（不参与事件流），但要进存档。 */
    this.localActors = [];
    /** 未公开素材库（KP 私有，只在 local）。已公开的那部分同时写进 state.scene.assets。 */
    this.localAssets = [];
    /** 回合边界表：[{round, seq}]，随 EVT.ROUND 事件维护（v1.19.0）。
        回退点（beforeSeq）就从这里取 —— 不再用 meta.round 直接减。 */
    this.roundStarts = [];
    /** 当前回退投票（一次只允许一个） */
    this.rewind = null;
    this.rewindSeq = 0;
    this.warnings = [];
    /** v2.0.0：角色卡状态写回用的**单调序号**。
        每次 stateApply 自增；玩家端按它做幂等（同一 seq 应用两次只扣一次血）。 */
    this._stateSeq = 0;
    /** v2.1.5（用户第 2 项）：疯狂症状表（恐惧症/狂躁症）。宿主注入，测试可替身；
        浏览器里就是 CocMadness（含 roll/make）。权威端靠它掷「疯狂发作」症状。 */
    this.madness = opts.madness || (typeof global !== 'undefined' ? global.CocMadness : null) || null;
    /** v2.1.5（用户第 2 项）：本回合每个玩家的 SAN 损失累计 + 回合开始 SAN。
        不定性疯狂的阈值是「一回合内累计损失 ≥ 回合开始 SAN 的 1/5」——
        这个「一回合」由 KP 的「下一回合」按钮划定（nextTurn / round.next 时重置）。
        v2.4.0（用户第 ⑤ 项）：计数器更名为 `_sanLostThisRound`（语义 = 本回合累计 SAN 损失），
        并新增 `_fadedArm`（「不定疯狂（症状消失）」的本回合易伤开关，见 _afterSanLoss）。 */
    this._sanLostThisRound = {};
    this._roundStartSan = {};
    /** v2.4.0（用户第 ⑤ 项）：「不定疯狂（症状消失）」态下「本回合任意损失即复发」的武装开关。
        键：seat；值：false = 本回合已 disarm（KP 推进回合后需重新累计 1/5 才复发）；
        undefined = 武装（缺省值，兼容旧房间 / 直接置态的存档）。进入 FADED 时重新武装。 */
    this._fadedArm = {};
    /** v2.3.0（用户第 8 项）：本轮「某玩家 + 某武器」已发射次数（连发惩罚骰的依据）。
        键：seat + '\u0000' + 武器名；值：已发射弹数。随 EVT.ROUND（emit 统一出口）清零。 */
    this._fireUsed = {};
  }

  Host.prototype.members = function () {
    return this.roster.dump();
  };

  /** 把成员表变更推给所有人 */
  Host.prototype.syncMembers = function () {
    return this.plan(this.emit(EVT.MEMBERS, { members: this.members() }, VIS.PUBLIC));
  };

  /**
   * 给某个 seat 的战斗视图（**按可见性裁剪**）。
   *
   * 需求 §8.2 是把「怪物 HP 数值」当成安全边界：玩家/旁观者只能拿到公开
   * 状态标签，接口响应里**不存在** hp/hpMax 数字。所以这里不是「发全量、
   * 前端少显示」，而是发出去之前就把字段删掉 —— 与 scrub() 同一原则。
   *
   * KP 走 combatFor(HOST_SEAT) 拿到全量。
   */
  Host.prototype.combatFor = function (seat) {
    var c = this.state.combat;
    if (!c) return null;
    var isKp = (seat === HOST_SEAT) || (this._seatIsKp && this._seatIsKp[seat]);
    var out = clone(c);
    if (isKp) return out;
    (out.order || []).forEach(function (slot) {
      var pub = slot.public || {};
      /* 只有「公开」的角色才暴露 HP 数字。怪物默认不公开 → 只留状态标签。 */
      if (!pub.hpPublic) {
        delete pub.hp;
        delete pub.hpMax;
      }
      /* KP 隐藏属性（敏感）一律不下发 */
      delete slot.secret;
      delete slot.kpOnly;
      delete slot.attrs;
      if (slot.actorId) {
        /* 怪物/NPC 的 id 可以留（界面要标识同一个目标），但名称之外的私密资料不留 */
      }
    });
    return out;
  };

  /**
   * ⚠️ Host 所有对外方法一律返回「发送计划」（[{to, msg}]），不返回事件记录。
   *    记录是内部产物（emit* 才产生）；混着返回过一次，结果调用方拿 `plan[0].msg`
   *    取到 undefined —— 类型不统一就要靠人肉记住，迟早出事。
   */
  Host.prototype._push = function (out, rec) {
    var part = this.plan(rec);
    for (var i = 0; i < part.length; i++) out.push(part[i]);
    return out;
  };

  /**
   * 造一条事件并入库。vis 的语义见 VIS 注释。
   * ⚠️ vis !== SEAT 时自动剥掉私有字段（scrub）—— 这是「不许先广播再隐藏」的
   *    机械保证；写错代码也不会把 KP 的秘密发出去。剥过就记一条警告。
   *
   * ⚠️ 这里同时把事件**归约进 this.state**：KP 端也要看自己房间的聊天与日志，
   *    而且重连同步（syncFor）是直接拿 this.state 拼的 —— 不归约的话，
   *    KP 界面是空的、所有重连的人拿到的历史也是空的。
   */
  Host.prototype.emit = function (t, p, vis, to) {
    vis = vis || VIS.PUBLIC;
    if (vis !== VIS.SEAT && hasSecret(p)) {
      this.warnings.push({ t: t, reason: '非 SEAT 事件携带私有字段，已剥离' });
      p = scrub(p);
    }
    var evt = { t: t, vis: vis, to: to || null, p: p || {} };
    var rec = this.log.push(evt);
    /* v2.2.0 修复（P2-A）：把**可见性**一并交给 reduce —— 否则 SEAT/KP 的检定结果
       会被无条件写进公共 state.logs，再经 syncFor 泄漏给每个玩家。 */
    reduce(this.state, { t: evt.t, seq: rec.seq, p: evt.p, vis: vis, to: evt.to });
    /* v2.0.1：SEAT 私密事件必须按收件人累积，否则重连 /sync 的 privates 恒为空
       （KP 递出的线索在玩家断线重连后永久消失）。形状与 _makeSync 消费的一致，
       也与客户端 reduce 的 case EVT.PRIVATE 对齐：{seq,title,text,at,kind}。 */
    if (vis === VIS.SEAT && to && t === EVT.PRIVATE) {
      if (!this._privateBySeat[to]) this._privateBySeat[to] = [];
      this._privateBySeat[to].push({ seq: rec.seq, title: evt.p.title || '',
                                     text: evt.p.text || '', at: evt.p.at || 0,
                                     kind: evt.p.kind || 'info' });
      if (this._privateBySeat[to].length > 100) this._privateBySeat[to].shift();
    }
    /* 回合边界事件 → 记进 roundStarts（回退点靠它算）。
       放在 emit 里（所有状态变更的唯一出口）而不是调用点，
       这样 nextTurn / 「进入下一回合」两条路径都自动维护，不会漏。 */
    if (evt.t === EVT.ROUND && evt.p.round !== undefined && evt.p.round !== null) {
      this.roundStarts.push({ round: evt.p.round, seq: rec.seq });
      /* v2.3.0（用户第 8 项）：新回合 → 清空连发计数（每轮重新计「已发射次数」）。 */
      this._fireUsed = {};
      /* v2.4.0（用户第 ⑤ 项）：新回合 → 清空「本回合累计 SAN 损失」计数，并 disarm
         「不定疯狂（症状消失）」的本回合易伤 —— KP 点「进入下一回合」后，FADED 态
        也重新按「本回合累计 ≥ maxSAN/5」才复发（用户口径：回合推进后不定疯狂的
        任意损失即复发特权收回，需重新累计）。
        放在 emit 统一出口：nextTurn()（战斗）与 round.next（探索）两条路径都覆盖，
        不会漏（旧实现只在 nextTurn→_onRoundBoundary 里重置，round.next 漏掉）。 */
      this._sanLostThisRound = {};
      this._roundStartSan = {};
      /* ⚠️ 不能简单 `this._fadedArm = {}`：清空后键值变 undefined = **武装**（缺省口径），
         等于回合推进后 FADED 仍然「任意损失即复发」，与用户口径「回合推进后需累计
         ≥ ceil(maxSAN/5)」相悖。这里对**当前仍处于 FADED** 的座位显式置 false（disarm），
         其余座位留 undefined（它们本就没有这项特权）。 */
      this._fadedArm = {};
      var mems = this.roster.list();
      for (var mi = 0; mi < mems.length; mi++) {
        var mm = mems[mi];
        var ment = mm && mm.sheet && Array.isArray(mm.sheet.mental) ? mm.sheet.mental : [];
        if (ment.indexOf(MENTAL_INDEF_FADED) >= 0) this._fadedArm[mm.seat] = false;
      }
    }
    this._maybeSnapshot(rec.seq);
    return rec;
  };

  /** 从（已被裁剪的）日志里重建回合边界表。回退后必须调用 —— 被裁掉的
      回合边界不能继续留在表里，否则下一次回退会算到一个已不存在的 seq。 */
  Host.prototype._rebuildRoundStarts = function () {
    this.roundStarts = [];
    var items = this.log.items || [];
    for (var i = 0; i < items.length; i++) {
      var e = items[i].evt;
      if (e && e.t === EVT.ROUND && e.p && e.p.round !== undefined && e.p.round !== null) {
        this.roundStarts.push({ round: e.p.round, seq: items[i].seq });
      }
    }
    return this.roundStarts;
  };

  /** 每 snapshotEvery 条存一份深度快照（回退用）。太多会吃内存，只留最近 20 份。 */
  Host.prototype._maybeSnapshot = function (seq) {
    if (!(this.snapshotEvery > 0) || seq % this.snapshotEvery !== 0) return;
    this.snapshots.push({ seq: seq, state: clone(this.state) });
    if (this.snapshots.length > 20) this.snapshots.shift();
  };

  /** 只记在 KP 本地、永不外发（KP 的私密备忘）。**不占共享序号。** */
  Host.prototype.emitLocal = function (t, p) {
    this.localSeq += 1;
    var rec = { seq: this.localSeq, evt: { t: t, vis: VIS.KP, to: null, p: p || {} } };
    this.local.push(rec);
    if (this.local.length > 200) this.local.shift();
    return rec;
  };

  /**
   * 战斗类事件在**发出去之前**按收件人裁剪（需求 §8.2：玩家接口里不存在怪物 HP 数字）。
   *
   * 为什么不在 emit 时就裁：KP 自己要从 state.combat 读全量（他要看到怪物血量）。
   * 所以 state 里存全量，**只在 plan 生成消息时**逐人裁剪 —— 这样
   * 「发给谁的字节里有什么」是一个可以单独审查的点。
   */
  var COMBAT_EVTS = { combat: 1, actor: 1, turnstate: 1, turn: 1 };

  /* 成员表也是逐人裁剪的：每个成员身上挂的 `sheet`（角色卡摘要 + 疯狂/精神状态）
     对**本人**与 **KP** 全量可见，对**其他玩家**只留公开部分。
     理由同 §8.2：玩家卡上的疯狂症状、SAN 上限减损属于「个人状况」，
     别人不该从网络响应里捡到 —— 所以是发之前裁掉，不是前端少画。 */
  var MEMBER_EVTS = { members: 1 };

  /**
   * 成员的对外视图。`self` = 发这条给谁（HOST_SEAT 表示 KP）。
   *
   *   本人 / KP  → 全量 sheet
   *   其他人     → 只留 charName 与「公开状况标签」（HP/SAN 现状 + 是否疯狂，
   *                但不带具体症状名与减损值）
   *
   * runtime（HP/MP/SAN 现状）本来就随成员表公开广播（KP 要看到血量），
   * 所以这里不裁它；裁的是**新增的** sheet 细节。
   */
  Host.prototype._cropMember = function (m, self) {
    var out = clone(m);
    if (!out.sheet) return out;
    var isKp = (self === HOST_SEAT);
    var isSelf = (self === m.seat);
    if (isKp || isSelf) return out;
    /* 其他玩家：症状名、SAN 上限减损仍不下发；
       v2.13.4（用户第 2 项）：**队友栏要显示 HP / 当前 SAN / 身体状态 / 精神状态** ——
       这些在桌面团里本来就摆在桌上（KP 与同席都看得到），所以把这一小组放开。
       注意 `maxSAN` 仍是 null（上限可能暴露神话侵蚀程度），`madness` 症状名仍不传。 */
    var sh = out.sheet;
    var st = sh.status || {};
    out.sheet = {
      name: sh.name,
      /* v2.13.7：头像对同席公开（桌上本来就看得到人），症状名/SAN 减损仍不外传 */
      avatar: sh.avatar || '',
      status: {
        currentHP: st.currentHP, maxHP: st.maxHP,
        currentSAN: st.currentSAN,
        currentMP: st.currentMP, maxMP: st.maxMP,
        body: st.body || '正常',
        dying: !!st.dying,
        unconscious: !!st.unconscious
      },
      mental: (sh.mental || []).slice(0, 6),
      madnessCount: (sh.madness || []).length,
      sanLoss: null,
      maxSAN: null
    };
    return out;
  };

  /** 整张成员表里**有没有人**挂了自己要裁的 sheet（没有 → 走原来的群发） */
  Host.prototype._membersNeedCrop = function (members) {
    return (members || []).some(function (m) { return !!m.sheet; });
  };

  /** 把整张成员表按收件人裁一遍 */
  Host.prototype._cropMembers = function (members, self) {
    var that = this;
    return (members || []).map(function (m) { return that._cropMember(m, self); });
  };

  Host.prototype._cropFor = function (t, p, seat) {
    if (MEMBER_EVTS[t] && p && p.members) {
      var outM = clone(p);
      outM.members = this._cropMembers(p.members, seat);
      return outM;
    }
    if (!COMBAT_EVTS[t]) return p;
    if (seat === HOST_SEAT) return p;
    var out = clone(p);
    if (t === 'combat' && out.combat) out.combat = this._cropCombat(out.combat);
    if (t === 'actor' && out.actor) out.actor = this._cropSlot(out.actor);
    if (t === 'turnstate' && out.order) out.order = out.order.map(this._cropSlotBind());
    if (t === 'turn' && out.order) out.order = out.order.map(this._cropSlotBind());
    return out;
  };

  Host.prototype._cropSlotBind = function () {
    var self = this;
    return function (s) { return self._cropSlot(clone(s)); };
  };

  Host.prototype._cropSlot = function (slot) {
    if (!slot) return slot;
    var pub = slot.public || (slot.public = {});
    if (!pub.hpPublic) { delete pub.hp; delete pub.hpMax; }
    delete slot.secret; delete slot.kpOnly; delete slot.attrs;
    return slot;
  };

  Host.prototype._cropCombat = function (c) {
    if (!c) return c;
    var self = this;
    var out = clone(c);
    (out.order || []).forEach(function (slot) {
      var pub = slot.public || (slot.public = {});
      if (!pub.hpPublic) { delete pub.hp; delete pub.hpMax; }
      delete slot.secret; delete slot.kpOnly; delete slot.attrs;
    });
    return out;
  };

  /**
   * 分发计划：把一条事件翻译成「发给谁」的列表。
   * 返回 [{to: '*', msg} | {to: seat, msg}]，由传输层照单发送。
   * 中继层只会 hub.send（单发）与 hub.broadcast（群发），别无他法。
   */
  Host.prototype.plan = function (rec) {
    var evt = rec.evt;
    var out = [];
    if (evt.vis === VIS.KP) return out;                       // 根本不出门
    if (evt.vis === VIS.SEAT) {
      if (evt.to) {
        var pp = this._cropFor(evt.t, evt.p, evt.to);
        out.push({ to: evt.to, msg: { k: 'evt', seq: rec.seq, t: evt.t, p: clone(pp || {}) } });
      }
      /* 没有收件人的 SEAT 事件是写错了 —— 悄悄丢掉的话，
         表现是「KP 说发出去了、玩家什么都没收到」，最难查。
         记一条警告，测试里可以直接断言 warnings 为空。 */
      else this.warnings.push({ t: evt.t, reason: 'SEAT 事件缺少收件人 seat' });
      /* 其余在线的人收一条水位标记（原因见 skipMsg 的注释）。
         离线的人不发：他们重连时会收到全量 sync，lastSeq 会一次性推平。 */
      var self = this;
      this.roster.list().forEach(function (m) {
        if (m.seat !== evt.to && m.online) out.push({ to: m.seat, msg: skipMsg(rec.seq) });
      });
      return out;
    }
    /* 公共事件：广播给所有人。战斗类与成员表逐人裁剪 —— 中继只支持 broadcast，
       所以这里对「在线玩家」逐人单发裁剪后的版本；KP 自己不走网络。
       ⚠️ 成员表只有在**确实有人挂了 sheet** 时才逐人单发。没人挂 sheet 时
       保持原来的 `'*'` 群发 —— 否则「某人离线」这种与离线者无关的事件，
       会因为在线人数为 0 而发不出去，剩下的人永远不知道他掉了。 */
    if (MEMBER_EVTS[evt.t] && this._membersNeedCrop(evt.p && evt.p.members)) {
      var anyM = false;
      var selfM = this;
      this.roster.list().forEach(function (m) {
        if (!m.online || m.seat === HOST_SEAT) return;
        anyM = true;
        out.push({ to: m.seat, msg: { k: 'evt', seq: rec.seq, t: evt.t,
                                      p: clone(selfM._cropFor(evt.t, evt.p, m.seat) || {}) } });
      });
      if (anyM) return out;
      /* 没有在线玩家：退回「按陌生人视角裁剪」的群发。
         ⚠️ 不能直接 evtMsg(rec) —— 那样会把原始对象（含症状名）广播出去。
         中继那边没有玩家，但**日志/回放**可能读得到，私密数据不该出现在那里。 */
      out.push({ to: '*', msg: { k: 'evt', seq: rec.seq, t: evt.t,
                                 p: clone(this._cropFor(evt.t, evt.p, '__nobody__') || {}) } });
      return out;
    }
    if (COMBAT_EVTS[evt.t]) {
      var any = false;
      var self2 = this;
      this.roster.list().forEach(function (m) {
        if (!m.online || m.seat === HOST_SEAT) return;
        any = true;
        out.push({ to: m.seat, msg: { k: 'evt', seq: rec.seq, t: evt.t,
                                      p: clone(self2._cropFor(evt.t, evt.p, m.seat) || {}) } });
      });
      /* 没有在线玩家时也要留一条广播占位吗？不需要：KP 端直接读 state。 */
      if (!any) { /* 无人可发，静默 */ }
      return out;
    }
    out.push({ to: '*', msg: evtMsg(rec) });
    return out;
  };

  /** 逐条事件的完整发送计划（顺序必须与 seq 一致，否则玩家端会判成乱序） */
  Host.prototype.planAll = function (recs) {
    var out = [];
    for (var i = 0; i < recs.length; i++) {
      var part = this.plan(recs[i]);
      for (var j = 0; j < part.length; j++) out.push(part[j]);
    }
    return out;
  };

  /**
   * 中继报告有人上线（peer.open）。返回：
   *   { seat, rejected, blocked, member, out }
   * blocked=true 表示这个 seat 被踢过，调用方应直接断开他的连接
   * （别让他「被踢了立刻又回来」，那样房主会觉得踢不掉）。
   */
  Host.prototype.attachPeer = function (m) {
    m = m || {};
    var seat = m.seat || m.cid || '';
    if (!seat) return { seat: '', rejected: true, blocked: false, member: null, out: [] };
    if (this.roster.kicked[seat]) {
      return { seat: seat, rejected: true, blocked: true, member: null, out: [] };
    }
    /* v2.0.3：**设备码重连（同座回来）也必须重发 members**。
       此前只在 `!existed`（新座位）时广播，而「已存在座位」走的是
       Roster.open 原地把 online 置回 true 的路径 —— 它不发任何事件。
       可掉线时 detachPeer 已经 syncMembers() 把 state.members.online 写成了
       false，于是重连后**渲染源永久停在离线**：玩家自己看是 online、
       KP 与其他玩家的成员列表里却一直是灰的；而且之后发言也不会刷新
       （intent() 同样不重发 members）。
       现象即用户报的「我回来了，但别人看我还是离线」。
       ⚠️ 必须在 roster.open() **之前**取旧值：open() 会原地改成 true，
       且对已存在座位返回的是**同一个对象**，事后读就拿不到旧状态了。 */
    var prev = this.roster.get(seat);
    var existed = !!prev;
    var wasOffline = !!(prev && prev.online === false);
    var member = this.roster.open(m);
    var out = [];
    /* 新座位 → 广播；老座位由离线转在线 → 也要广播（否则上面那个坑）。
       已在线成员被重复 attach 时**不**广播，避免刷屏。 */
    if (!existed || wasOffline) out = out.concat(this.syncMembers());
    // 无论新老，都给这个座位推一份全量（他就是靠这条把自己的界面填满的）
    out.push({ to: seat, msg: this.syncFor(seat) });
    return { seat: seat, rejected: false, blocked: false, member: member, out: out };
  };

  /** 中继报告有人掉线（peer.close）：**只标记离线，不移除**（他还要重连回来） */
  Host.prototype.detachPeer = function (seat) {
    var m = this.roster.markOffline(seat);
    var out = [];
    /* 需求 §9：回退表决期间有玩家断线 → 本次回退默认失败 */
    out = out.concat(this.rollbackAbortIfVoting(seat));
    if (!m) return out;
    return out.concat(this.syncMembers());
  };

  /** 首连 / 重连：给某个 seat 的全量同步 */
  Host.prototype.syncFor = function (seat) {
    /* ⚠️ 可见性裁剪发生在**事件产生时**（plan / emit），不是在这里再过滤一遍。
       这里如果额外按角色删内容，会出现「增量收到的和全量同步拿到的不是同一套」
       —— 同一句话在重连前后忽隐忽现，属于最难查的一类不一致。
       所以这里原样给 this.state：SEAT / KP 事件本来就没进过它。 */
    var st = this.state;
    var scene = clone(st.scene);
    /* 「自己的手绘板」与「KP 请求改我状态」是逐人的，全量同步时按 seat 兜底补上
       （它们平时走 SEAT 事件，但重连期内可能已经产生过）。 */
    var board = null;
    return this._makeSync(seat, scene, board);
  };

  Host.prototype._makeSync = function (seat, scene, board) {
    var st = this.state;
    var view = {
      meta: clone(st.meta),
      /* ⚠️ 成员表按收件人裁剪 —— 全量 sync 与增量 MEMBERS 必须用**同一套**
         裁剪规则，否则断线重连的人会拿到别人平时拿不到的症状明细。 */
      members: this._cropMembers(this.members(), seat),
      chats: clone(st.chats),
      logs: clone(st.logs),
      dice: clone(st.dice),
      scene: scene === undefined ? clone(st.scene) : scene,
      combat: this.combatFor(seat),
      privates: (this._privateBySeat && this._privateBySeat[seat]) ? clone(this._privateBySeat[seat]) : [],
      rewind: clone(st.rewind),
      /* v2.1.0 缺陷2c修复：请求形状必须与实时 reduce **完全一致**。
         内部 _requestsBySeat 存的键是 `payload`（consent 落账时读 req.payload），
         而实时 EVT.REQUEST 落进 state.requests 的键是 `p`（见 reduce 的 case EVT.REQUEST）。
         以前这里原样 clone(_requestsBySeat[seat])，于是**经一次全量 sync**
         （重连 / 新客户端）后 state.requests 里的条目没有 `.p` → checkReqCard 的
         `req.p || {}` 拿到空对象，技能名 / 难度 / 场景全丢，卡片「形同没有内容」
         （用户报「全体推送玩家收不到」）。这里统一映射成 {id,op,p,from,reason,at}，
         与 reduce 落库的一条不差。 */
      requests: (this._requestsBySeat && this._requestsBySeat[seat])
        ? this._requestsBySeat[seat].map(function (r) {
            return {
              id: r.id,
              op: r.op,
              p: clone(r.payload || {}),
              from: r.from || 'KP',
              reason: r.reason || '',
              at: r.at || 0
            };
          })
        : [],
      board: board || (this._boardBySeat && this._boardBySeat[seat]) ? clone(this._boardBySeat[seat]) : null,
      seq: this.log.seq,
      version: 1
    };
    return syncMsg(this.log.seq, view);
  };

  /**
   * 收到玩家的意图。返回要发送的计划（可能为空）。
   * 权限判定在这里做 —— 不能指望客户端不发越权请求（任何人都能改前端）。
   */
  Host.prototype.intent = function (seat, msg) {
    var out = [];
    var mem = this.roster.get(seat);
    /* 房主自己也是一个意图来源：他发言、他掷骰都该走同一条路，
       这样日志格式、序号、可见性裁剪与玩家完全一致（否则「KP 说的话」
       会是一套只有 KP 端才有的旁路逻辑）。
       ⚠️ 房主不在花名册里（花名册是玩家/旁观者的名单），
       所以必须按 seat 认，不能靠 roster 查出来的空值当旁观者处理。 */
    var isHost = (seat === HOST_SEAT);
    var role = isHost ? ROLE.KP : (mem ? mem.role : ROLE.SPECTATOR);
    var p = (msg && msg.p) || {};
    var op = msg && msg.op;

    /* v2.1.5（用户第 2 项）：**撕卡**（死亡 / 永久疯狂）的玩家只能聊天。
       v2.1.6（用户第 7 项）：**临时/不定疯狂发作中**的玩家也只能「推进 1 轮」和
       申请治愈 —— 掷骰 / 场景检定 / 改状态全部锁死（KP 推场景检定时由系统自动随机）。 */
    /* v2.10.0（R5 / Q6）：**濒死**（dying 标记）一并并入全局操作锁 —— 与撕卡 /
       疯狂发作 / 昏迷同款，锁死期间只剩白名单操作可用。 */
    var locked = !isHost && mem &&
      (memberRipped(mem) || memberInBout(mem) || this._isUnconscious(mem) || this._isDying(mem));
    if (locked) {
      /* v2.8.0（HP 机制 · 用户第 2 项）：**昏迷**并入全局操作锁 ——
         与撕卡 / 疯狂发作同款：聊天 / SYNC / READY / STATE_SYNC / CHAR / 推进疯狂 /
         申请治愈不定疯狂 + 新增「申请治愈伤势（sheet.healwound）」为**例外白名单**；
         其余操作（掷骰 / 场景检定 / 改状态 / 战斗…）一律锁死。
         v2.10.0（R5）：昏迷判据改读布尔标记（_isUnconscious → status.unconscious）。
         ⚠️ 刻意**不给** `aid.apply`（施救由队友发起，昏迷者本身无需操作）。 */
      var passSelf = (op === INTENT.CHAT || op === INTENT.SYNC || op === INTENT.READY ||
                      op === INTENT.STATE_SYNC || op === INTENT.CHAR ||
                      (op === INTENT.ACT && p.op === 'madness.advance') ||
                      (op === INTENT.ACT && p.op === 'madness.cure') ||
                      (op === INTENT.ACT && p.op === 'sheet.healwound'));
      if (!passSelf) {
        var rippedNow = memberRipped(mem);
        /* v2.10.0（R5）：昏迷 / 濒死合并同一句提示（判据 = 两个标记任一）。 */
        var knock = !rippedNow && !memberInBout(mem) &&
          (this._isUnconscious(mem) || this._isDying(mem));
        this._push(out, this._sysTo(seat, rippedNow
          ? '你的角色已死亡或永久疯狂（撕卡），只能通过聊天框交流'
          : (knock
             ? '你的角色正处于昏迷/濒死，无法进行该操作；可申请治愈伤势或请队友施救'
             : '你的角色正处于疯狂发作中（临时/不定疯狂），只能「推进 1 轮」或申请治愈，其他操作暂不可用')));
        return out;
      }
    }

    switch (op) {
      case INTENT.SYNC: {
        var from = num(p.lastSeq, 0);
        if (from > 0 && this.log.canFill(from)) {
          // 增量补齐：断线期间的事件按序重发（**不要**再叠一条全量 sync，
          // 否则客户端会先被拉到 seq=N、随后那批事件全部被判成重复丢弃，
          // 看起来像「补拉失效」）
          var recs = this.log.since(from);
          for (var i = 0; i < recs.length; i++) {
            var part = this.plan(recs[i]);
            for (var j = 0; j < part.length; j++) {
              if (part[j].to === '*' || part[j].to === seat) {
                out.push({ to: seat, msg: part[j].msg });
              }
            }
          }
          if (!out.length) out.push({ to: seat, msg: this.syncFor(seat) });
        } else {
          // 超出保留窗口（或首次连接）：只能全量
          out.push({ to: seat, msg: this.syncFor(seat) });
        }
        break;
      }
      case INTENT.READY: {
        if (role !== ROLE.PLAYER) {
          this._push(out, this._sysTo(seat, '旁观者不能设准备状态'));
          break;
        }
        /* v2.0.0（契约 §5.4）：必须**先选一张已保存的角色卡**才能准备。
           没有卡就没有权威属性可读 —— 检定、状态回写、战斗结算全都无从谈起。 */
        if (p.ready && !(mem && mem.charId)) {
          this._push(out, this._sysTo(seat, '请先选择角色卡'));
          break;
        }
        if (mem) mem.ready = !!p.ready;
        out = out.concat(this.syncMembers());
        this._push(out, this._sys(this._nick(mem) + (mem && mem.ready ? ' 已准备' : ' 取消准备')));
        break;
      }
      case INTENT.CHAT: {
        var text = cleanText(p.text, 600);
        if (!text) break;
        this._push(out, this.emit(EVT.CHAT, {
          seat: seat, nickname: this._nick(mem, seat), text: text, at: this.now(), kind: 'user'
        }, VIS.PUBLIC));
        break;
      }
      case INTENT.CHAR: {
        /* 玩家上报自己的角色卡摘要。
           ⚠️ 这里以前只存了 charName / charId —— 于是状态管理里的疯狂、
           精神状态、SAN 上限减损**在房间里完全读不到**（玩家存的卡上明明有）。
           现在把跑团真正需要的那几样一起带上：

             madness[]  疯狂症状（背景自带的永久疯狂 + 游戏中新掷的）
             mental[]   精神状态（多选：永久/临时/不定疯狂可以叠加）
             sanLoss     SAN 上限**永久减损**（神话法术 / 接触克苏鲁留下的）
             maxSAN      SAN 上限（= 意志 − sanLoss）
             cur/curMax 当前 SAN 与上限，用于房间里对账

           权威端**不信任**客户端给的数字：一律过 clampNumber 与白名单字段，
           多余键直接丢。它是「展示用摘要」，不能反过来改权威状态。

           ⚠️ 只有**玩家**能上报角色卡。旁观者也在花名册里（有自己的 mem），
           不判角色的话他们也能挂一张卡进成员表 —— 那是身份混淆。 */
        if (role !== ROLE.PLAYER) {
          this._push(out, this._sysTo(seat, '旁观者不需要上报角色卡'));
          break;
        }
        /* v2.1.8（用户第 4 项）：**权威端守卫** —— 拒绝绑定「已撕卡」的角色。
           权威端不能信任客户端的过滤（任何人都能改前端），所以按上报摘要里的
           body / mental 再判一次：死亡 或 永久疯狂 → 拒绝，给玩家一句人话。 */
        var repSheet = (p && p.sheet) || {};
        var repStatus = repSheet.status || {};
        var repMental = Array.isArray(repSheet.mental)
          ? repSheet.mental
          : (repSheet.mental ? [String(repSheet.mental)] : []);
        if (repStatus.body === '死亡' || repMental.indexOf(MENTAL_PERMANENT) >= 0) {
          this._push(out, this._sysTo(seat, '该角色已撕卡（死亡/永久疯狂），不能进入房间'));
          break;
        }
        if (mem) {
          mem.charName = cleanText(p.name, 40) || mem.charName;
          mem.charId = p.id || mem.charId;
          /* v2.1.0 根因修复：char.share 是**整体覆盖** sheet，但 tempStatus / items 是
             **权威端（KP）产生的字段**，不是玩家角色卡自带的内容。玩家重连补报
             （resendBoundSheet / 换卡上报）时不该把它们清空 —— 否则玩家刚收到的
             临时状态与物品会凭空消失（此前 sheetSummary 不产这两个键 → 被重置为 []）。
             处理：新 sheet 覆盖后，把**权威端旧值**贴回；玩家上报里若夹带了
             tempStatus/items，一律不采纳（用旧值覆盖 → 顺带防伪造）。 */
          var prevSheet = mem.sheet || {};
          var prevTs = Array.isArray(prevSheet.tempStatus) ? prevSheet.tempStatus : [];
          var prevItems = Array.isArray(prevSheet.items) ? prevSheet.items : [];
          var nextSheet = sanitizeSheet(p, mem);
          nextSheet.tempStatus = clone(prevTs);
          nextSheet.items = clone(prevItems);
          mem.sheet = nextSheet;
          /* v2.13.4（用户第 2 项）：绑卡即把 HP/MP/SAN 现值写进 runtime。
             否则别人要看你的状态，得等你先改过一次状态（stateApply 才会写 runtime）——
             队友栏里就会一直是「—」。以后 stateApply 仍以它为现值来源。 */
          var nst = nextSheet.status || {};
          mem.runtime = mem.runtime || {};
          if (nst.currentHP !== undefined && nst.currentHP !== null) mem.runtime.hp = nst.currentHP;
          if (nst.maxHP !== undefined && nst.maxHP !== null) mem.runtime.hpMax = nst.maxHP;
          if (nst.currentMP !== undefined && nst.currentMP !== null) mem.runtime.mp = nst.currentMP;
          if (nst.maxMP !== undefined && nst.maxMP !== null) mem.runtime.mpMax = nst.maxMP;
          if (nst.currentSAN !== undefined && nst.currentSAN !== null) mem.runtime.san = nst.currentSAN;
          if (nst.maxSAN !== undefined && nst.maxSAN !== null) mem.runtime.sanMax = nst.maxSAN;
        }
        out = out.concat(this.syncMembers());
        break;
      }
      case INTENT.SAN_CHECK: {
        /* v2.1.1：玩家自助 SAN 检定。**同一条结算**与 KP 定向指令共用
           （_settleSanCheck），保证规则书口径一致；扣减走 stateApply → EVT.STATE。 */
        out = out.concat(this.playerSanCheck(seat, mem, p));
        break;
      }
      case INTENT.OPPOSED: {
        /* v2.2.0（用户第 3 项）：玩家发起武器对抗 / 胜后选怪。
           ⚠️ 不在 locked 的 passSelf 白名单里 → 撕卡/疯狂发作的玩家天然被拒。 */
        out = out.concat(this.opposed(seat, mem, role, p));
        break;
      }
      case INTENT.DICE: {
        /* v1.18.5：玩家点骰子**直接掷**（用户需求：不要再「请 KP 投掷」）。
           结果仍然由权威端算 —— 玩家只声明「掷什么、目标值多少」，骰子本身
           在 KP 设备上掷、全员看到同一颗，重连也能补回（原架构原则不变）。
           旧语义（不带 direct）保留：只记一条「请求掷 XX」。 */
        if (p.direct) {
          out = out.concat(this.diceDirect(seat, mem, role, p));
        } else {
          this._push(out, this.emit(EVT.LOG, {
            seat: seat, text: this._nick(mem, seat) + ' 请求掷 ' + cleanText(p.expr, 40),
            at: this.now(), kind: 'dice-request', expr: cleanText(p.expr, 40)
          }, VIS.PUBLIC));
        }
        break;
      }
      case INTENT.ACT: {
        out = out.concat(this._act(seat, mem, role, p));
        break;
      }
      case INTENT.BOARD: {
        out = out.concat(this.boardSelf(seat, p));
        break;
      }
      case INTENT.VOTE: {
        out = out.concat(this.rollbackVote(seat, !!p.agree));
        break;
      }
      case INTENT.CONSENT: {
        out = out.concat(this.consent(seat, p));
        break;
      }
      case INTENT.CONFIRM: {
        out = out.concat(this.confirmPending(seat, p));
        break;
      }
      /* v2.0.0：玩家回执「我已把状态写入本机角色卡」。
         幂等的落点在玩家端（Client.applySheetState）；这里只记账。 */
      case INTENT.STATE_SYNC: {
        out = out.concat(this.stateSyncAck(seat, p));
        break;
      }
      default:
        break;
    }
    return out;
  };

  /**
   * 玩家对被请求的变更表态（需求 §4：KP 改玩家状态需玩家同意）。
   * 同意 → 真正落账；拒绝 → 记一条系统消息，玩家状态不变。
   */
  Host.prototype.consent = function (seat, p) {
    var out = [];
    var list = this._requestsBySeat[seat] || [];
    var idx = -1;
    for (var i = 0; i < list.length; i++) if (list[i].id === p.id) idx = i;
    if (idx < 0) { this._push(out, this._sysTo(seat, '这条请求已经处理过了')); return out; }
    var req = list[idx];
    /* 检定请求走自己的路径：拒绝=忽略；同意=按 KP 指定技能/难度直接检定。 */
    if (req.op === 'check.request') {
      if (p.agree) {
        /* v2.1.0 缺陷2修复：把 agree=true **真正实现**。
           此前这里只发一条 REQUEST-done 当「知道了」就返回 —— 玩家点「同意」
           之后既不出结果、也没有任何可见反馈（用户报「要求检定点了同意没反应」）。
           现在同意 = 授权权威端用「权威目标值 + KP 指定难度」替该玩家掷一次 D100，
           结果广播全员，再摘卡。骰子仍只在权威端掷（架构不变）。
           安全：base/difficulty 均取权威端存的请求载荷（req.payload），不信客户端。 */
        out = out.concat(this._rollCheckRequest(seat, req));
        var sk = cleanText((req.payload || {}).skill, 20) || '检定';
        return out.concat(this._settleRequest(seat, req.id, true, '同意并完成了「' + sk + '」检定'));
      }
      return out.concat(this._settleRequest(seat, req.id, false, '忽略了检定请求'));
    }
    /* 状态变更请求：先摘卡（玩家端 + 待办表），再落账 */
    out = out.concat(this._settleRequest(seat, req.id, !!p.agree, null));
    if (!p.agree) {
      this._push(out, this._sys(this._nick(this.roster.get(seat), seat) + ' 拒绝了状态变更请求'));
      return out;
    }
    /* 同意：把变更应用到该成员公开字段，并写公共日志（含理由） */
    var m = this.roster.get(seat);
    var ch = req.payload || {};
    if (m) {
      /* v2.6.0（用户第 6 项）：先记写入前的 SAN（供「净减 SAN」判定，与 stateSelf 同口径）。 */
      var sanBeforeConsent = memberStatusValue(m, 'currentSAN');
      /* v2.8.0（HP 机制）：记录改前的 HP / body，供 applyStatusJudgment 做归零分流。
         v2.10.0（R5）：bodyBefore 改传**视图**（bodyView），并新增 flagsBefore。 */
      var hpBeforeConsent = memberStatusValue(m, 'currentHP');
      var bodyBeforeConsent = bodyView(m.sheet && m.sheet.status);
      var flagsBeforeConsent = {
        dying: !!(m.sheet && m.sheet.status && m.sheet.status.dying),
        unconscious: !!(m.sheet && m.sheet.status && m.sheet.status.unconscious)
      };
      /* v2.6.0（用户第 6 项）：不再只写 m.runtime —— 统一走 stateApply，把 m.runtime
         与 m.sheet.status 一起写回（与 stateSelf 完全同一份落地路径），并对当前
         HP/SAN 以上限 clamp（stateApply 内完成）。
         payload 形状 {hp,san,mp}（见 stateRequestSheet）→ 译成
         stateApply 的 {status:{currentHP,currentSAN,currentMP}}。 */
      var change = {};
      var stc = {};
      if (ch.hp !== undefined && ch.hp !== null) { var hpn = num(ch.hp, null); if (hpn !== null) stc.currentHP = hpn; }
      if (ch.san !== undefined && ch.san !== null) { var sann = num(ch.san, null); if (sann !== null) stc.currentSAN = sann; }
      if (ch.mp !== undefined && ch.mp !== null) { var mpn = num(ch.mp, null); if (mpn !== null) stc.currentMP = mpn; }
      if (Object.keys(stc).length) change.status = stc;
      if (Object.keys(change).length) {
        out = out.concat(this.stateApply(seat, change, {}));
        /* v2.6.0（用户第 6 项）：与 stateSelf 共用同一套归零 / 净减 / 撕卡判定
           —— 修复「KP 把玩家 HP 改 0，角色不会被判死」的缺口。 */
        out = out.concat(this.applyStatusJudgment(m, change, seat,
          { sanBefore: sanBeforeConsent, hpBefore: hpBeforeConsent, bodyBefore: bodyBeforeConsent,
            flagsBefore: flagsBeforeConsent }));
      }
    }
    out = out.concat(this.syncMembers());
    this._push(out, this.emit(EVT.LOG, {
      seat: '', text: 'KP 调整了 ' + this._nick(m, seat) + ' 的状态' +
        (req.reason ? ('（' + req.reason + '）') : ''), at: this.now(), kind: 'state'
    }, VIS.PUBLIC));
    return out;
  };

  /**
   * KP 对已排队的高危动作（need = 'twice' / 'kp'）做二次确认。
   * UI 先在本地弹一次确认框，用户点「确定」再发这条意图 —— 这样「两次确认」
   * 一次在客户端（防误触）、一次在权威端（防伪造），两层都要过。
   * - agree=false：丢弃该待办，不做任何改变
   * - agree=true ：把原来的 {op,p} 送去 applyAction 真正执行
   */
  /* v2.13.6（用户报「KP 锁屏解锁后玩家被结团」）：高危动作的二次确认**有效期**。
     安卓锁屏会让页面冻结/重载，一条排队中的「结团」可能几小时后才被点到；
     没有 TTL 的话，那一刻全桌人会被莫名结团。超过 2 分钟一律作废重来。 */
  var CONFIRM_TTL_MS = 120000;

  Host.prototype.confirmPending = function (seat, p) {
    var out = [];
    if (seat !== HOST_SEAT) {
      this._push(out, this._sysTo(seat, '只有房主能确认高危操作'));
      return out;
    }
    var id = p && p.id;
    var idx = -1;
    for (var i = 0; i < this.pending.length; i++) {
      var q = this.pending[i];
      if (!q.need) continue;                       // owner/all 类待办走各自通道
      if (id ? q.id === id : (q.op === (p && p.op))) { idx = i; break; }
    }
    if (idx < 0) { this._push(out, this._sysTo(seat, '没有需要确认的操作')); return out; }
    var task = this.pending.splice(idx, 1)[0];
    /* 过期闸门：排队超过 CONFIRM_TTL_MS 的待办直接丢弃（结团/关房这类不可逆动作
       绝不接受「迟到」的确认）。at 缺失的老数据按 0 处理 → 同样视为过期。 */
    var age = this.now() - num(task.at, 0);
    if (age > CONFIRM_TTL_MS) {
      this._push(out, this._sysTo(seat,
        '这条确认已放太久（' + Math.round(age / 1000) + ' 秒），已作废；请重新点一次操作'));
      return out;
    }
    if (!(p && p.agree)) {
      this._push(out, this._sysTo(seat, '已取消该操作'));
      return out;
    }
    /* v2.1.6：用**原发起者**执行（而不是确认者）—— 玩家发起的 madness.cure /
       state.edit.self 等待办，处理函数需要知道「是谁发起的」才能定位目标；
       以前传确认者的 seat（KP），玩家自服务动作全部拿不到目标。 */
    return out.concat(this.applyAction(task.by || seat, task.p));
  };

  /** 通用动作分发（探索 / 战斗 / KP 工具都从这里进） */
  Host.prototype._act = function (seat, mem, role, p) {
    var out = [];
    var op = p.op;
    // 权限表统一判定；越权一律忽略并回一条系统提示（不静默吞掉）
    var verdict = needs(role === ROLE.KP ? ROLE.KP : role, op);
    if (!verdict.allowed) {
      this._push(out, this._sysTo(seat, '你没有权限执行该操作'));
      return out;
    }
    if (verdict.confirm) {
      /* v2.1.7：KP 自己发起、且确认方就是 KP 的动作（如 KP 工具「治愈疯狂」）
         **直接执行** —— KP 的点击本身就是确认，不应再绕一道「待你确认」队列。 */
      if (verdict.confirm === 'kp' && seat === HOST_SEAT) {
        return out.concat(this.applyAction(seat, p));
      }
      /* v2.2.2（用户第 5 项）：同一发起者对同一目标的**同种待办不重复入队** ——
         玩家连点「申请治愈」时此前会堆多条同 op 待办，KP 确认一次只核销一条、
         队列里永远残留，表现为「治愈后仍显示『已提交，等待确认』、后续操作像排在
         一个永不消失的队列后面」。这里拦掉**载荷完全相同**的重复提交（提示一条即可）。 */
      var pSig = JSON.stringify(p);
      for (var pi = 0; pi < this.pending.length; pi++) {
        var pq = this.pending[pi];
        if (pq && pq.by === seat && pq.op === op && JSON.stringify(pq.p) === pSig) {
          this._push(out, this._sysTo(seat,
            (op === 'madness.cure') ? '你的治愈申请已在等待 KP 同意，请勿重复提交'
                                    : '该操作已在等待确认，请勿重复提交'));
          return out;
        }
      }
      this.pending.push({ by: seat, op: op, p: clone(p), need: verdict.confirm, at: this.now() });
      /* v2.2.2（用户第 5 项）：治愈申请用**更明确**的回话，避免与「已提交，等待确认」
         这种排队语义混淆（用户的 SAN Check 是自身动作、根本不走这里）。 */
      this._push(out, this._sysTo(seat,
        (op === 'madness.cure') ? '已向 KP 发起治愈申请，等待同意' : '已提交，等待确认'));
      return out;
    }
    return out.concat(this.applyAction(seat, p));
  };

  /** 真正执行动作（KP 自己或已经确认过的动作走到这里） */
  Host.prototype.applyAction = function (seat, p) {
    var out = [];
    var op = p.op;
    if (op === 'room.start') {
      out = out.concat(this.setStatus(STATUS.IN_GAME));
      /* v1.19.0：开团即进入第 1 回合（显式回合边界）。没有它，新开的一局
         一个回合边界都没有 → 回退无从算起（旧存档同理）。 */
      if (!(this.state.meta.round >= 1)) {
        this._push(out, this.emit(EVT.ROUND, { round: 1 }, VIS.PUBLIC));
      }
      this._push(out, this._sys('开团！'));
    } else if (op === 'room.kick') {
      out = out.concat(this.kick(p.seat));
    } else if (op === 'scene.set') {
      this._push(out, this.emit(EVT.SCENE, { scene: p.scene }, VIS.PUBLIC));
    } else if (op === 'combat.set') {
      this._push(out, this.emit(EVT.COMBAT, { combat: p.combat }, VIS.PUBLIC));
    } else if (op === 'combat.next') {
      out = out.concat(this.nextTurn());
    } else if (op === 'scene.clue') {
      // 线索发给目标玩家：逐人单发，不进公共流。seat==='*' → 全体在线玩家各发一条
      var thatClue = this;
      var clueTargets = (p.seat === '*')
        ? this.roster.onlinePlayers().map(function (m) { return m.seat; })
        : [p.seat];
      clueTargets.forEach(function (t) {
        thatClue._push(out, thatClue.emit(EVT.PRIVATE,
          { title: p.title || '线索', text: p.text || '', at: thatClue.now() }, VIS.SEAT, t));
      });
      this._push(out, this.emit(EVT.LOG, {
        seat: seat,
        text: (p.seat === '*' ? '（KP 给全体玩家递了线索）' : '（KP 私下递了一张纸条）'),
        at: this.now(), kind: 'note'
      }, VIS.PUBLIC));
    }
    /* ============ P4 探索 ============ */
    else if (op === 'scene.mode') {
      /* v2.6.0（预存在缺陷修复）：`_modeChanged` 返回的是 `this.plan(...)`，即**计划数组**
         `[{to,msg}]`，不是事件记录 —— 直接 `_push(out, 数组)` 会让 `plan(rec)` 读到
         `rec.evt === undefined` 并在 `evt.vis` 处抛 TypeError。必须与其它 op 分支一样
         用 `out = out.concat(...)` 合并。 */
      out = out.concat(this._modeChanged(p.mode));
    } else if (op === 'asset.add') {
      out = out.concat(this.addAsset(p.asset));
    } else if (op === 'asset.reveal') {
      out = out.concat(this.revealAsset(p.id, p.revealed !== false));
    } else if (op === 'asset.cover') {
      out = out.concat(this.coverAsset(p.id));
    } else if (op === 'asset.del') {
      out = out.concat(this.delAsset(p.id));
    } else if (op === 'item.del') {
      out = out.concat(this.delItem(seat, p));
    } else if (op === 'state.self') {
      out = out.concat(this.stateSelf(seat, p));
    } else if (op === 'madness.advance') {
      out = out.concat(this.advanceMadness(seat, p));
    } else if (op === 'madness.cure') {
      out = out.concat(this.cureIndefinite(seat, p));
    } else if (op === 'map.mark') {
      out = out.concat(this.mapMark(p));
    } else if (op === 'map.stroke') {
      out = out.concat(this.mapStroke(p));
    } else if (op === 'map.clear') {
      out = out.concat(this.mapClear(p));
    } else if (op === 'map.strokes.set') {
      /* v2.5.0（用户第 4 项）：实时橡皮擦 / 撤销单笔 —— 整集替换笔迹，不写记录 */
      out = out.concat(this.mapStrokesSet(p));
    } else if (op === 'board.self') {
      out = out.concat(this.boardSelf(seat, p));
    }
    /* ============ P5 战斗 ============ */
    else if (op === 'combat.prepare') {
      /* 纯 UI：打开选怪流程，不产生任何事件（契约 §5.3）。
         登记在权限表里只是为了让 needs() 覆盖、伪造的 ACT 进不来。 */
    } else if (op === 'combat.start') {
      out = out.concat(this.combatStart(p));
    } else if (op === 'combat.pool.set') {
      /* v2.5.0（用户第 5 项）：开战前「候选池」—— 纯权威端本地登记，不产生公开事件 */
      out = out.concat(this.setActorPool(p));
    } else if (op === 'combat.actor') {
      out = out.concat(this.combatActor(p.actor));
    } else if (op === 'combat.enqueue') {
      /* v2.7.0（用户第 1 项）：KP 把玩家 / 单位追加进现有战斗（幂等，不重置 turn/round）。 */
      out = out.concat(this.combatEnqueue(p));
    } else if (op === 'combat.turnState' || op === 'combat.next') {
      if (op === 'combat.next') out = out.concat(this.nextTurn());
      else this._push(out, this.emit(EVT.TURNSTATE, p, VIS.PUBLIC));
    } else if (op === 'combat.damage') {
      out = out.concat(this.combatDamage(p));
    } else if (op === 'combat.attack') {
      out = out.concat(this.combatAttack(seat, p));
    } else if (op === 'combat.end') {
      out = out.concat(this.combatEnd());
    }
    /* ============ 权威掷骰 ============ */
    else if (op === 'dice.roll') {
      out = out.concat(this.diceRoll(seat, p));
    } else if (op === 'dice.dark') {
      /* v2.1.0 #11：暗骰 —— 结果只进 KP 自己的私密信息，公共侧只写一句。 */
      out = out.concat(this.darkRoll(seat, p));
    }
    /* ============ P6 KP 工具 ============ */
    else if (op === 'state.request') {
      out = out.concat(this.stateRequest(seat, p));
    } else if (op === 'check.request') {
      out = out.concat(this.checkRequest(seat, p));
    } else if (op === 'check.opposed') {
      out = out.concat(this.checkOpposed(seat, p));
    } else if (op === 'scene.check.push') {
      out = out.concat(this.sceneCheckPush(seat, p));
    } else if (op === 'scene.check.step') {
      out = out.concat(this.sceneCheckStep(seat, p));
    } else if (op === 'sheet.damage') {
      /* v2.1.0 #11：指定玩家扣血（直接推送，无需同意） */
      out = out.concat(this.sheetDamage(seat, p));
    } else if (op === 'sheet.sancheck') {
      /* v2.1.0 #11：指定玩家做 SAN Check（用**该玩家自己的 SAN** 判定） */
      out = out.concat(this.sheetSanCheck(seat, p));
    } else if (op === 'sheet.tempstatus') {
      /* v2.1.0 #11：给指定玩家加一条临时状态 */
      out = out.concat(this.sheetTempStatus(seat, p));
    } else if (op === 'sheet.item') {
      /* v2.1.0 #11：给指定玩家一个物品道具 */
      out = out.concat(this.sheetItem(seat, p));
    } else if (op === 'room.suspend') {
      out = out.concat(this.suspendRoom(seat));
    } else if (op === 'room.resume') {
      out = out.concat(this.resumeRoom(seat));
    } else if (op === 'room.rules') {
      /* v2.3.0（用户第 7 项）：游戏中改检定成败阈值 → 立即广播 + 写公开日志。 */
      out = out.concat(this.setRoomRules(p));
    } else if (op === 'sheet.sanloss') {
      /* v2.3.0（用户第 7 项）：SAN 大失败追加理智损失（KP 一键入口，掷 1D10，不自动扣）。 */
      out = out.concat(this.sheetSanLoss(seat, p));
    } else if (op === 'sheet.healwound') {
      /* v2.8.0（HP 机制 · 用户第 3/4 项）：治愈伤势（清除重伤/濒死/昏迷）。玩家发起需 KP 同意。 */
      out = out.concat(this.healWound(seat, p));
    } else if (op === 'aid.apply') {
      /* v2.8.0（HP 机制 · 用户第 2 项）：队友施救（急救/医学）—— 检定施救者技能，玩家发起需 KP 同意。 */
      out = out.concat(this.aidApply(seat, p));
    } else if (op === 'aid.psycho') {
      /* v2.11.0（用户第 3 项）：精神分析 —— 治愈队友不定疯狂 + 回 SAN；玩家发起需 KP 同意。 */
      out = out.concat(this.psychoAnalyze(seat, p));
    } else if (op === 'rollback.turn') {
      out = out.concat(this.rollbackPropose(seat, p.turns));
    } else if (op === 'round.next' || op === 'rollback.round') {
      /* v1.19.0：探索态「⏭ 进入下一回合」—— 发一条显式回合边界事件。
         战斗态的回合推进由 nextTurn() 负责（它也发同一条事件）。
         v2.8.0（HP 机制 · 用户第 4 项）：改走**统一回合出口** _advanceRound ——
         与 nextTurn 共用，于是探索态也会触发「濒死每轮 CON」与「天/周恢复」。
         ⚠️ `madness.advance`（推进 1 轮）不 emit ROUND，**不**触发天/周判定。 */
      var nextRound = (this.state.meta.round || 0) + 1;
      out = this._advanceRound(out, nextRound);
      this._push(out, this._sys('进入第 ' + nextRound + ' 回合'));
    } else if (op === 'rollback.commit') {
      out = out.concat(this.rollbackCommit(seat));
    } else if (op === 'session.end') {
      out = out.concat(this.endSession());
    }
    return out;
  };

  /* ============================================================
   * P4 —— 探索：素材 / 地图 / 手绘板
   * ============================================================ */

  Host.prototype._ensureScene = function () {
    if (!this.state.scene) {
      this.state.scene = { title: '', image: '', assets: [], marks: [], strokes: [], boards: {} };
    }
    if (!this.state.scene.assets) this.state.scene.assets = [];
    if (!this.state.scene.marks) this.state.scene.marks = [];
    if (!this.state.scene.strokes) this.state.scene.strokes = [];
    if (!this.state.scene.boards) this.state.scene.boards = {};
    return this.state.scene;
  };

  /** 切模式：探索 / 战斗（需求 §2.4 与房间状态分开） */
  Host.prototype._modeChanged = function (mode) {
    mode = (mode === MODE.COMBAT) ? MODE.COMBAT : MODE.EXPLORATION;
    var st = this.emit(EVT.STATUS, { status: this.state.meta.status, mode: mode }, VIS.PUBLIC);
    this.state.meta.mode = mode;
    return this.plan(st);
  };

  /**
   * 新增素材。**上传 ≠ 公开**（需求 §6.1）：默认只进 KP 私有库，
   * 公开必须显式 reveal。这里为了防止「先广播再靠 UI 隐藏」，
   * 未公开素材根本不会进任何公共事件。
   */
  Host.prototype.addAsset = function (asset) {
    asset = asset || {};
    var id = 'a' + (++this.localSeq);
    var rec = {
      id: id,
      kind: cleanText(asset.kind, 20) || 'map',   // map / npc / item
      name: cleanText(asset.name, 60) || '素材',
      data: asset.data || '',                     // dataURL；大小由 UI 侧限制
      revealed: false,
      at: this.now()
    };
    this.localAssets.push(rec);
    if (this.localAssets.length > 60) this.localAssets.shift();
    var out = [];
    this._push(out, this.emitLocal('asset.added', { asset: clone(rec) }));
    /* ⚠️ 提示必须只发给 KP 自己（_sysTo），**不能**用 _sys 群发 ——
       否则「未公开素材的名字」就跟着系统消息漏给了所有玩家。 */
    this._push(out, this._sysTo(HOST_SEAT, '你上传了素材「' + rec.name + '」（尚未公开）'));
    return out;
  };

  /** 公开 / 隐藏素材。只有公开的才进公共 scene.assets。 */
  Host.prototype.revealAsset = function (id, revealed) {
    var a = null;
    for (var i = 0; i < this.localAssets.length; i++) if (this.localAssets[i].id === id) a = this.localAssets[i];
    if (!a) { var o0 = []; this._push(o0, this._sysTo(HOST_SEAT, '找不到该素材')); return o0; }
    a.revealed = revealed !== false;
    var s = this._ensureScene();
    var pub = s.assets.filter(function (x) { return x.id !== id; });
    if (a.revealed) pub.push(clone(a));
    var out = [];
    this._push(out, this.emit(EVT.ASSET, { assets: pub }, VIS.PUBLIC));
    /* v2.6.0（用户第 1 项）：若被隐藏的正是当前中央底图，清掉悬空的 scene.image ——
       否则 mapBackground 命中不到会「跳」到另一张已公开图（底图无故换人）。 */
    if (!a.revealed && s.image === id) {
      s.image = '';
      this._push(out, this.emit(EVT.SCENE, { scene: this._sceneWith(s, { image: '' }) }, VIS.PUBLIC));
    }
    this._push(out, this._sys(a.revealed ? ('素材「' + a.name + '」已公开') : ('素材「' + a.name + '」已隐藏')));
    return out;
  };

  /**
   * v2.6.0（用户第 1 项）：KP 指定中央 16:9 底图。
   *   约束（铁律）：**只能选已公开素材** —— 传入未公开 / 不存在的 id 一律拒绝
   *   （否则「选底图」会变成一条把私库图漏给全员的侧信道）。
   *   传空 id / null → 清除底图，回落 mapBackground 的「第一张已公开图片」兜底。
   *   这是 KP 的显式操作、玩家会立刻看到底图变化，故写一条公开记录解释原因。
   */
  Host.prototype.coverAsset = function (id) {
    var out = [];
    id = cleanText(id, 24);
    var s = this._ensureScene();
    if (!id) {
      s.image = '';
      this._push(out, this.emit(EVT.SCENE, { scene: this._sceneWith(s, { image: '' }) }, VIS.PUBLIC));
      this._push(out, this._sys('KP 清除了中央底图'));
      return out;
    }
    var hit = null;
    for (var i = 0; i < (s.assets || []).length; i++) {
      if (s.assets[i].id === id) { hit = s.assets[i]; break; }
    }
    if (!hit) {
      this._push(out, this._sysTo(HOST_SEAT, '只能把「已公开」的素材设为底图'));
      return out;
    }
    s.image = id;
    this._push(out, this.emit(EVT.SCENE, { scene: this._sceneWith(s, { image: id }) }, VIS.PUBLIC));
    this._push(out, this._sys('KP 把底图换成了「' + (hit.name || '素材') + '」'));
    return out;
  };

  /**
   * v2.1.3（用户第 5 项）：KP 删除一个素材。
   *
   * 必须**同时**做两件事：从 KP 私有库(localAssets)移除、从公共画面(scene.assets)撤下。
   * 只删私有库 → 已公开的那份还挂在所有玩家的画面上（「删了还在」）；
   * 只删公共 → 私有库残留一条同名幽灵（下次还会被「公开」出来）。
   */
  Host.prototype.delAsset = function (id) {
    var out = [];
    id = cleanText(id, 24);
    var before = this.localAssets.length;
    var removed = null;
    this.localAssets = this.localAssets.filter(function (a) {
      if (a.id === id) { removed = a; return false; }
      return true;
    });
    /* 公共列表也要撤：即使私有库里没有（例如存档恢复后的边界），仍按 id 清一遍 */
    var sc = this._ensureScene();
    var hadPub = sc.assets.some(function (x) { return x.id === id; });
    if (hadPub) {
      sc.assets = sc.assets.filter(function (x) { return x.id !== id; });
      this._push(out, this.emit(EVT.ASSET, { assets: clone(sc.assets) }, VIS.PUBLIC));
      this._push(out, this._sysTo(HOST_SEAT, '已从公开画面撤下该素材'));
      /* v2.6.0（用户第 1 项）：若删的正是当前底图，一并清掉悬空的 scene.image */
      if (sc.image === id) {
        sc.image = '';
        this._push(out, this.emit(EVT.SCENE, { scene: this._sceneWith(sc, { image: '' }) }, VIS.PUBLIC));
      }
    }
    if (!removed && !hadPub) {
      this._push(out, this._sysTo(HOST_SEAT, '找不到该素材（可能已被删除）'));
      return out;
    }
    this._push(out, this._sysTo(HOST_SEAT,
      '已删除素材「' + ((removed && removed.name) || '素材') + '」（私有库 ' + before +
      ' → ' + this.localAssets.length + '）'));
    return out;
  };

  /**
   * v2.1.3（用户第 4 项）：删除某个玩家背包里的一件物品。
   *
   * 权限：KP 可删任意玩家（需要 p.seat）；**玩家只能删自己的**（p.seat 必须等于自己），
   *       跨玩家删除一律拒绝 —— 客户端不能替别人删东西。
   * 幂等：按**物品 id** 删除。重放同一请求时该 id 已不在列表 → 静默无操作，
   *       绝不会误删下标错位后的另一件物品。
   */
  Host.prototype.delItem = function (bySeat, p) {
    var out = [];
    p = p || {};
    var target = cleanText(p.seat, 64) || bySeat;
    if (bySeat !== HOST_SEAT && target !== bySeat) {
      this._push(out, this._sysTo(bySeat, '只能删除自己的物品'));
      return out;
    }
    var m = this.roster.get(target);
    if (!m) { this._push(out, this._sysTo(bySeat, '找不到该玩家，无法删除物品')); return out; }
    if (!m.sheet || !Array.isArray(m.sheet.items)) {
      this._push(out, this._sysTo(bySeat, '该玩家背包里没有物品'));
      return out;
    }
    var id = cleanText(p.id, 24);
    var list = m.sheet.items.slice();
    var idx = -1;
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) idx = i;
    if (idx < 0) return out;      // 已删过 / id 缺失：幂等静默成功，不弹错
    var gone = list[idx];
    list.splice(idx, 1);
    return out.concat(this.stateApply(target, { items: list },
      { reason: '删除物品：' + ((gone && gone.name) || '物品') }));
  };

  /**
   * v2.1.4（用户第 2 项）：**玩家自助修改自己的状态**（HP/MP/SAN/临时状态/疯狂）。
   *
   * 与 `state.edit.self` 的区别：那条要 KP 二次确认；这条**免确认**——
   * 用户明确要求「不需要 kp 同意（可以直接修改）」。
   * 仍然受两道约束：① 玩家只能改**自己**（跨玩家一律拒绝）；
   * ② 数值必须过白名单与区间夹取（复用 sanitizeSheet/sanitizeStatus 的同一套规则）。
   * 走 stateApply → EVT.STATE → 玩家本机角色卡（临时卡）一起更新，并写进游戏记录，
   * 这样「玩家自己改了什么」在全桌可见、也留痕。
   *
   * v2.10.0（R5 / R2a）payload 契约（冻结）：
   *   · `status.body`        4 值白名单（正常/轻伤/重伤/死亡）；
   *   · `status.dying`       布尔（濒死标记，与 body 正交）；
   *   · `status.unconscious` 布尔（昏迷标记，与 body 正交）；
   *   · `reason`             可选，人类可读原因（cleanText 截断 80）—— 进入公开
   *                         「状态变化」日志（EVT.LOG kind:'state'），缺省回落
   *                         「（KP｜玩家自行）修改状态」旧文案。
   */
  Host.prototype.stateSelf = function (bySeat, p) {
    var out = [];
    p = p || {};
    var target = cleanText(p.seat, 64) || (bySeat === HOST_SEAT ? '' : bySeat);
    if (bySeat !== HOST_SEAT && target !== bySeat) {
      this._push(out, this._sysTo(bySeat, '只能修改自己的状态'));
      return out;
    }
    var m = this.roster.get(target);
    if (!m) { this._push(out, this._sysTo(bySeat, '找不到该玩家')); return out; }
    if (!m.sheet) m.sheet = sanitizeSheet({}, m);
    if (!m.sheet.status) m.sheet.status = sanitizeStatus({}, m.sheet);
    if (!Array.isArray(m.sheet.tempStatus)) m.sheet.tempStatus = [];
    if (!Array.isArray(m.sheet.madness)) m.sheet.madness = [];

    var change = {};
    var st = p.status || {};
    var stOut = {};
    ['currentHP', 'currentMP', 'currentSAN', 'maxHP', 'maxMP', 'maxSAN', 'currentLuck'].forEach(function (k) {
      if (st[k] === undefined || st[k] === null || st[k] === '') return;
      var v = Math.round(Number(st[k]));
      if (!isFinite(v)) return;
      stOut[k] = v;
    });
    /* v2.10.0（R2b · 架构师 §4.2）：玩家不得自行把「重伤/濒死/昏迷」降级或取消 ——
       前端禁用矩阵（room-panels.js chips）之外的**第二层（权威端兜底）**：任何人改前端
       都绕不过权威端这一关（QA Round 1 实测过该洞：重伤清醒玩家自发 body=正常/轻伤
       直接被写进权威态，无私密提示）。产品口径：伤势只能经 sheet.healwound /
       aid.apply / HP 驱动判定（deriveBodyFromHp）解除，不能由 state.self 一句话抹掉。
       ⚠️ 只拦「降级/取消」：
         · body 降级 = 传 正常/轻伤（{body:'死亡'} **不属**降级 —— 撕卡自弃，v2.8.0 口径不变）；
         · 显式关标记 = 传 falsy 的 dying/unconscious（判据与下方 !!stOut 落库口径一致，
           防 `dying:0` 这类伪造拼接绕过字面 false 比对）；
         · 受伤组内**叠加**（{unconscious:true}）与**同级改写**（{body:'重伤'}）放行
           （用户要求「可多选」）；轻伤→重伤的「加重」同样放行（只锁取消，不锁加重）。
       ⚠️ KP 直通（bySeat===HOST_SEAT 不走校验）。
       ⚠️ 昏迷/濒死玩家的 state.self 本就先被 intent() 全局锁挡下（不在白名单）——
       本守卫覆盖的是「重伤但清醒」这个原本完全无防护的分支。
       ⚠️⚠️ 下方 clearDying / clearUncon 因此**在玩家自助路径上通常不走**（先被全局锁挡），
          但**勿当死代码删除**：① 它们是意图级第二层防线（不依赖锁），一旦将来 intent()
          全局锁白名单调整（如放行濒死玩家的某些操作）即立刻生效；② 删掉它们既有测试
          **不会变红**（H1/H2 由全局锁兑现，照样绿）—— 属静默回归，只能靠人工比对发现。
          动这块时必须「全局锁 + 本守卫」两层一起确认。 */
    var stNow = m.sheet.status;
    var curWound = (bodyView(stNow) === '重伤' || stNow.dying || stNow.unconscious);
    if (bySeat !== HOST_SEAT && curWound) {
      var nbRaw = (st.body !== undefined && st.body !== null && st.body !== '') ? cleanText(st.body, 8) : null;
      var clearMajor = (nbRaw === '正常' || nbRaw === '轻伤');   // body 降级
      var clearDying = !!(st.dying !== undefined && st.dying !== null && st.dying !== '' && !st.dying && stNow.dying);
      var clearUncon = !!(st.unconscious !== undefined && st.unconscious !== null && st.unconscious !== '' && !st.unconscious && stNow.unconscious);
      if (clearMajor || clearDying || clearUncon) {
        this._push(out, this._sysTo(bySeat,
          '当前处于「' + bodyView(stNow) + '」，不能自行取消该状态 —— 请用「🩹 治愈伤势（需 KP 同意）」或请 KP / 队友施救'));
        return out;
      }
    }
    /* v2.1.5（用户第 2/4 项）：身体状态（单选白名单）。「死亡」= 撕卡。
       v2.10.0（R5）：白名单收敛为 4 值；昏迷 / 濒死改由下面的布尔标记表达。 */
    if (st.body !== undefined && st.body !== null && st.body !== '') {
      var bd = cleanText(st.body, 8);
      if (BODY_OK[bd]) stOut.body = bd;
    }
    /* v2.10.0（用户第 R5 项）：昏迷 / 濒死 = 独立布尔标记（与 body 正交、可叠加）。
       state.self 契约：status 接受 body（4 值白名单）/ dying / unconscious 三个键；
       HP 确有变动时以 deriveBodyFromHp 的判定为准（见 applyStatusJudgment）。 */
    if (st.dying !== undefined && st.dying !== null && st.dying !== '') stOut.dying = !!st.dying;
    if (st.unconscious !== undefined && st.unconscious !== null && st.unconscious !== '') stOut.unconscious = !!st.unconscious;
    if (Object.keys(stOut).length) {
      /* 当前值不得为负；上限至少 1 —— 与 sanitizeStatus 的口径一致 */
      ['currentHP', 'currentMP', 'currentSAN', 'currentLuck'].forEach(function (k) {
        if (stOut[k] !== undefined) stOut[k] = Math.max(0, Math.min(9999, stOut[k]));
      });
      /* v2.6.0（用户第 6 项）：当前 HP/SAN 的**上限 = 角色上限**（不再是固定 9999/999）。
         取「本次要写的上限」优先，否则用已登记上限；⚠️ 上限为 0 / 缺失时不夹
         （clampToMax 的 `max > 0` 守卫），避免把正常角色清零。
         stateApply 会再夹一次（同一口径），此处提前夹保证下发的 change 一致。 */
      var _effMaxHP = (stOut.maxHP !== undefined) ? stOut.maxHP : (m.sheet.status ? m.sheet.status.maxHP : null);
      var _effMaxSAN = (stOut.maxSAN !== undefined) ? stOut.maxSAN : (m.sheet.status ? m.sheet.status.maxSAN : null);
      if (stOut.currentHP !== undefined) stOut.currentHP = clampToMax(stOut.currentHP, _effMaxHP);
      if (stOut.currentSAN !== undefined) stOut.currentSAN = clampToMax(stOut.currentSAN, _effMaxSAN);
      change.status = stOut;
    }
    /* 临时状态：追加一条（与 KP 定向同形） */
    var tsText = cleanText(p.tempStatus, 80);
    if (tsText) {
      var tsList = m.sheet.tempStatus.slice();
      tsList.push({ text: tsText, by: bySeat === HOST_SEAT ? 'kp' : 'self', at: this.now() });
      change.tempStatus = tsList;
    }
    /* 疯狂：追加一条（{type:'phobia'|'mania', name, permanent, rounds}） */
    if (p.madness && p.madness.name) {
      var mdList = m.sheet.madness.slice();
      mdList.push({
        type: (MAD_TYPES[p.madness.type] ? p.madness.type : 'phobia'),
        name: cleanText(p.madness.name, 60),
        permanent: !!p.madness.permanent,
        rounds: p.madness.permanent ? 0 : clampNumber(p.madness.rounds, 0, 99, 0)
      });
      change.madness = mdList;
    }
    /* 精神状态（多选）：整体替换 */
    if (Array.isArray(p.mental)) change.mental = p.mental;

    if (!Object.keys(change).length) {
      this._push(out, this._sysTo(bySeat, '没有要修改的内容'));
      return out;
    }
    /* v2.2.2（用户第 6 项）：记录本次手动修改前的 SAN，用于判定「状态管理扣 SAN」。 */
    var sanBeforeHand = memberStatusValue(m, 'currentSAN');
    /* v2.8.0（HP 机制）：记录改前的 HP / body 视图 / 昏迷濒死标记，供 applyStatusJudgment
       做归零分流（有重伤→濒死 / 无重伤→昏迷）。
       v2.10.0（R5）：bodyBefore 改传**视图**（bodyView），并新增 flagsBefore。 */
    var hpBeforeHand = memberStatusValue(m, 'currentHP');
    var bodyBeforeHand = bodyView(m.sheet.status);
    var flagsBeforeHand = {
      dying: !!(m.sheet.status && m.sheet.status.dying),
      unconscious: !!(m.sheet.status && m.sheet.status.unconscious)
    };
    /* v2.10.0（R2a）：消费 payload 里的 reason（UI「点选身体状态」带入人类可读原因，
       如「自行设置身体状态：重伤 + 昏迷」），让「状态变化」公开日志带上原因 ——
       否则玩家点一下身体状态，权威端不留任何痕迹，KP 复盘时看不到是谁、为什么改的。
       ⚠️ 过 cleanText 剥控制符 + 截断 80（与 stateApply 内部同一口径，防刷屏）；
          缺省 / 空白 → 沿用既有「（KP｜玩家自行）修改状态」文案。 */
    var selfReason = cleanText(p.reason, 80) ||
      ((bySeat === HOST_SEAT ? 'KP' : '玩家自行') + '修改状态');
    out = out.concat(this.stateApply(target, change, { reason: selfReason }));
    /* v2.6.0（用户第 6 项）：把「HP 归零 CON 判定 / SAN 归零永久疯狂 / 净减 SAN 触发
       理智冲击 / 撕卡公开日志」抽到 `applyStatusJudgment` —— 与 KP 请求 `consent`
       共用**同一份**判定，保证两条入口口径完全一致（stateSelf 对外行为保持不变）。 */
    out = out.concat(this.applyStatusJudgment(m, change, bySeat,
      { sanBefore: sanBeforeHand, hpBefore: hpBeforeHand, bodyBefore: bodyBeforeHand,
        flagsBefore: flagsBeforeHand }));
    return out;
  };

  /**
   * v2.6.0（用户第 6 项）：状态写入后的**统一判定**（HP 归零 / SAN 归零 / 净减 SAN / 撕卡）。
   *
   * 为什么需要它：两条改状态入口 —— 玩家自助 `stateSelf` 与 KP 请求 `consent` ——
   * 过去各写各的：`stateSelf` 有全套判定，而 `consent` 只写 `m.runtime` 就收工
   * （KP 把玩家 HP 改 0，角色不会被判死）。现在两条入口共用本方法，口径完全一致。
   *
   * 调用约定：调用方**必须先把新值写进 `m.sheet.status` / `m.runtime`**（通常经 stateApply），
   * 再用 `opts.sanBefore` 传入「写入前的 SAN」——本方法只读取 m 的现值做判定。
   *
   * ⚠️ 与 `stateSelf` 既有行为保持完全一致（不改阈值与文案语义）。
   *
   * @param {object} m       成员记录（roster 里的 member）
   * @param {object} change  本次变更（保留参数位以兼容后续扩展；当前判定只读 m 的现值）
   * @param {string} bySeat  发起者座位（用于 _afterSanLoss 的日志归属）
   * @param {object} [opts]  { sanBefore:number|null } 写入前的 SAN（净减判定用）
   * @returns {Array} 事件流
   */
  Host.prototype.applyStatusJudgment = function (m, change, bySeat, opts) {
    var out = [];
    if (!m || !m.sheet) return out;
    opts = opts || {};
    var target = m.seat || bySeat;
    var who = this._nick(m, target);
    var sanBeforeHand = (opts.sanBefore === undefined) ? null : opts.sanBefore;
    if (!m.sheet.status) m.sheet.status = sanitizeStatus({}, m.sheet);
    /* ① HP 变动 → 身体状态判定（v2.8.0（HP 机制 · 用户需求 A）：状态管理与战斗伤害**同一套口径**）。
       旧实现只在 HP→0 做归零分流 ——「用状态管理把 12 改成 6」不判重伤、「重伤回血」不解除重伤。
       现统一走 deriveBodyFromHp（与 applyHpChange / settleWounds **共用同一份**判定）：
         · 净下降 ≥ 半血 且 hpNow>0 → 重伤（并掷「避免昏迷」CON）；
         · 改前重伤 且 hpNow ≥ 半血 → 解除重伤；
         · hpNow ≤ 0 → 归零分流；
         · 改前濒死 且 hpNow>0 → 回到重伤（≥半血则解除）；
         · 已濒死/昏迷不被非重伤伤害「降级」。
       ⚠️ 只在 HP **确有变动**时判定（避免覆盖玩家仅改 body 的显式选择）。
       ⚠️ 使用**改后的有效 maxHP**（state.self 可在同一次改动里改 maxHP）。
       调用方（stateSelf / consent）须在写入前经 opts.hpBefore / opts.bodyBefore 传入旧值。 */
    var hpNow = memberStatusValue(m, 'currentHP');
    var hpBeforeJ = (opts.hpBefore === undefined || opts.hpBefore === null) ? null : opts.hpBefore;
    /* v2.10.0（R5）：prevBodyJ 改读**视图**（bodyView：死亡 > dying > unconscious > body）——
       昏迷 / 濒死已升级为独立标记，判据必须看合成视图。 */
    var prevBodyJ = (opts.bodyBefore === undefined || opts.bodyBefore === null)
      ? bodyView(m.sheet.status) : opts.bodyBefore;
    /* v2.10.0（R5）：改前的昏迷 / 濒死标记（调用方在写入前捕获；缺省读当前 status）。
       deriveBodyFromHp 返回值里 undefined = 「不动」，flagsBefore 用于「判定结果与改前
       一致 → 不必再发一次 stateApply」的去重（避免同一状态重复落账 / 刷日志）。 */
    var flagsBefore = {
      dying: !!(opts.flagsBefore ? opts.flagsBefore.dying : (m.sheet.status && m.sheet.status.dying)),
      unconscious: !!(opts.flagsBefore ? opts.flagsBefore.unconscious : (m.sheet.status && m.sheet.status.unconscious))
    };
    var hpChanged = (hpBeforeJ == null) || (num(hpBeforeJ, 0) !== num(hpNow, 0));
    if (hpNow != null && hpChanged && m.sheet.status.body !== '死亡') {
      var maxHPNow = memberStatusValue(m, 'maxHP');
      if (maxHPNow == null || !(maxHPNow > 0)) maxHPNow = 0;   /* 上限未知 → 不做重伤/即死判定 */
      var amountNow = (hpBeforeJ != null) ? Math.max(0, num(hpBeforeJ, 0) - num(hpNow, 0)) : 0;
      var jd = deriveBodyFromHp(prevBodyJ, amountNow, num(hpNow, 0), maxHPNow);
      var bodyJ = jd.body;
      var dyingJ = jd.dying;
      var unconsciousJ = jd.unconscious;
      var jNote = '';
      if (jd.needCon) {
        var conJ = memberAttr(m, 'con');
        var jChk = (this.rules && typeof this.rules.dyingRoundCheck === 'function')
          ? this.rules.dyingRoundCheck(conJ == null ? 50 : conJ, this.rng) : null;
        if (jChk) {
          out = out.concat(this.diceRoll(target, {
            expr: '1D100', label: '重伤 CON 检定（避免昏迷，对 ' + jChk.check.base + '）', result: jChk.check
          }));
          jNote = jChk.summary;
          /* v2.10.0（R5）：重伤瞬间 CON 失败 → 置昏迷标记（原来置 body='昏迷'）。 */
          if (jChk.dead) unconsciousJ = true;
        }
      }
      /* v2.10.0（R5）：三键整包比较 —— 任一与改前不同才落账（undefined = 不动）。 */
      var bodyChanged = (bodyJ !== undefined && bodyJ !== m.sheet.status.body);
      var dyingChanged = (dyingJ !== undefined && dyingJ !== flagsBefore.dying);
      var unconsciousChanged = (unconsciousJ !== undefined && unconsciousJ !== flagsBefore.unconscious);
      if (bodyChanged || dyingChanged || unconsciousChanged) {
        /* 理由里展示**合成视图**（死亡 > dying > unconscious > body）。 */
        var viewJ = bodyView({
          body: (bodyJ !== undefined) ? bodyJ : m.sheet.status.body,
          dying: (dyingJ !== undefined) ? dyingJ : flagsBefore.dying,
          unconscious: (unconsciousJ !== undefined) ? unconsciousJ : flagsBefore.unconscious
        });
        out = out.concat(this.stateApply(target, {
          status: { body: bodyJ, dying: dyingJ, unconscious: unconsciousJ }
        }, { reason: 'HP 变动判定：' + viewJ + (jNote ? ('　' + jNote) : '') }));
      }
    }
    /* v2.8.0（HP 机制 · 用户第 2 项）：无论走哪条分支，都把身体状态同步到战斗槽
       —— 覆盖「经 state.self / state.request 变成昏迷的 PC 也可靠跳过战斗轮次」。 */
    out = out.concat(this._syncBodyToCombatSlot(m));
    /* ② SAN → 0：永久疯狂。 */
    var sanNow = memberStatusValue(m, 'currentSAN');
    var mentalNow = (m.sheet && Array.isArray(m.sheet.mental)) ? m.sheet.mental : [];
    if (sanNow != null && sanNow <= 0 && mentalNow.indexOf(MENTAL_PERMANENT) < 0) {
      out = out.concat(this.stateApply(target, { mental: [MENTAL_PERMANENT] },
        { reason: 'SAN 归零 → 永久疯狂' }));
    }
    /* ③ 手动净减 SAN（扣后仍 > 0）：临时 / 不定疯狂（与 SAN Check 共用 _afterSanLoss）。 */
    if (sanBeforeHand != null && sanNow != null && sanNow > 0 && sanNow < sanBeforeHand) {
      out = out.concat(this._afterSanLoss(m, sanBeforeHand - sanNow, bySeat));
    }
    /* ④ 变成死亡 / 永久疯狂 → 撕卡，全桌可见。 */
    if (memberRipped(m)) {
      this._push(out, this.emit(EVT.LOG, {
        seat: '', text: who + ' 已' + (m.sheet.status.body === '死亡' ? '死亡' : '永久疯狂') +
          ' —— 撕卡，只能通过聊天框交流', at: this.now(), kind: 'warn'
      }, VIS.PUBLIC));
    }
    return out;
  };

  /** 地图标记（相对坐标 0..1，跨设备一致；需求 §6.1） */
  Host.prototype.mapMark = function (p) {
    var s = this._ensureScene();
    var out = [];
    var m = {
      id: 'm' + (++this.localSeq),
      x: clamp01(p.x), y: clamp01(p.y),
      kind: cleanText(p.kind, 16) || 'dot',
      label: cleanText(p.label, 24),
      assetId: p.assetId || '',
      revealed: p.revealed !== false,
      at: this.now()
    };
    /* 未公开标记只进 KP 私有（不进 state.scene.marks） */
    if (!m.revealed) {
      this._push(out, this.emitLocal('mark.hidden', { mark: clone(m) }));
      return out;
    }
    this._push(out, this.emit(EVT.SCENE, { scene: this._sceneWith(s, { marks: s.marks.concat([m]) }) }, VIS.PUBLIC));
    return out;
  };

  Host.prototype.mapStroke = function (p) {
    var s = this._ensureScene();
    var out = [];
    var stroke = {
      id: 'p' + (++this.localSeq),
      color: cleanText(p.color, 16) || '#e74c3c',
      width: num(p.width, 3),
      pts: (p.pts || []).slice(0, 2000).map(function (q) { return { x: clamp01(q.x), y: clamp01(q.y) }; })
    };
    if (!stroke.pts.length) return out;
    this._push(out, this.emit(EVT.SCENE, { scene: this._sceneWith(s, { strokes: s.strokes.concat([stroke]) }) }, VIS.PUBLIC));
    return out;
  };

  /**
   * 一键清除：只清笔迹（地图原图是另一个字段，不会被覆盖；需求 §6.1）
   *
   * v2.5.0（用户第 4 项）：**不再写公开记录**。此前这里会写一条
   *   `KP 清空了地图上的绘画`，还会触发 v2.3.0 的操作播报（居中 2 秒提示，
   *   见 room-ui.js#optoastCheck）—— 表现为「KP 一擦黑板，游戏记录里就多一行灰字」。
   *   绘画 / 擦除是板书行为，不是游戏事件：只保留 EVT.SCENE 状态同步即可
   *   （与 map.stroke、board.self 两条路径的口径一致）。
   */
  Host.prototype.mapClear = function (p) {
    var s = this._ensureScene();
    var out = [];
    var marks = (p && p.strokesOnly) ? s.marks : [];
    this._push(out, this.emit(EVT.SCENE, { scene: this._sceneWith(s, { strokes: [], marks: marks }) }, VIS.PUBLIC));
    return out;
  };

  /**
   * v2.5.0（用户第 4 项）：**整集替换**地图笔迹（实时橡皮擦 / 撤销单笔都走这条，
   * op=`map.strokes.set`，payload `{ strokes: [...] }`）。
   *   · 只换 strokes，**保留 marks**（与 map.clear 的 strokesOnly:true 同语义）；
   *   · **不写任何公开 LOG** —— 与 map.clear / map.stroke / board.self 口径一致。
   * @param {object} p { strokes: [{ id?, color?, width?, pts: [{x,y}] }] }
   * @returns {Array} 事件计划
   */
  Host.prototype.mapStrokesSet = function (p) {
    var s = this._ensureScene();
    var out = [];
    var list = Array.isArray(p && p.strokes) ? p.strokes : [];
    var strokes = [];
    for (var i = 0; i < list.length && strokes.length < 4000; i++) {
      var st = list[i];
      if (!st || !Array.isArray(st.pts) || !st.pts.length) continue;
      strokes.push({
        id: cleanText(st.id, 40) || ('p' + (++this.localSeq)),
        color: cleanText(st.color, 16) || '#e74c3c',
        width: num(st.width, 3),
        pts: st.pts.slice(0, 2000).map(function (q) {
          return { x: clamp01(q.x), y: clamp01(q.y) };
        })
      });
    }
    this._push(out, this.emit(EVT.SCENE, { scene: this._sceneWith(s, { strokes: strokes }) }, VIS.PUBLIC));
    return out;
  };

  /** 用局部字段生成一条完整的 scene（客户端整块替换，避免 diff 出岔） */
  Host.prototype._sceneWith = function (s, patch) {
    var next = clone(s);
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) next[k] = patch[k];
    return next;
  };

  /**
   * 个人手绘板（需求 §6.2）：正文**只回给本人**，别人只看到缩略/数量。
   * 最后写入策略：整体替换（不做多人同笔迹合并，需求允许第一版如此）。
   *
   * v2.4.0（用户第 ⑪ 项）：更新**静默** —— 不再往公开记录写 LOG。
   *   原实现在下面还会广播一条「XX 更新了手绘板」（kind: 'board'），
   *   表现为每画一笔公开记录就多一条灰字，并且会触发 v2.3.0 的操作播报
   *   （居中 2 秒提示，见 room-ui.js#optoastCheck）—— 用户明确要求去掉。
   *   现在只保留必要的状态同步：EVT.BOARD（SEAT 单发）维持「正文只回本人」，
   *   权威端 state.scene.boards 的数量/缩略归约不受影响（emit 内统一 reduce），
   *   重连全量同步仍带 counts —— 手绘板功能本身零回归。
   */
  Host.prototype.boardSelf = function (seat, p) {
    var out = [];
    var strokes = (p.strokes || []).slice(0, 4000);
    var rec = { strokes: strokes, at: this.now() };
    this._boardBySeat[seat] = rec;
    /* 自己的板：SEAT 单发（别人拿不到正文） */
    this._push(out, this.emit(EVT.BOARD, { seat: seat, self: true, strokes: strokes, at: rec.at }, VIS.SEAT, seat));
    return out;
  };

  /* ============================================================
   * P5 —— 战斗
   * ============================================================ */

  /**
   * 默认行动顺序的**兜底实现**（仅在规则服务缺失时用 —— 例如只加载了
   * room-model.js 的 Node 单测环境）。生产环境一律走 `CocRules.initiativeOrder`。
   *   规则：DEX 降序；已准备枪械 DEX+50；每轮多次行动展开成多槽。
   */
  Host.prototype._initiativeFallback = function (actors) {
    var list = (actors || []).map(function (a) {
      var dex = num(a.dex, 0);
      var ready = !!a.readyFirearm;
      return {
        id: a.id, name: a.name || '', dex: dex, readyFirearm: ready,
        effDex: ready ? dex + 50 : dex,
        actionsPerRound: Math.max(1, num(a.actionsPerRound, 1)),
        manualOrder: (a.manualOrder === undefined || a.manualOrder === null) ? null : num(a.manualOrder)
      };
    });
    list.sort(function (x, y) {
      if (x.manualOrder !== null && y.manualOrder !== null) return x.manualOrder - y.manualOrder;
      if (x.manualOrder !== null) return -1;
      if (y.manualOrder !== null) return 1;
      if (y.effDex !== x.effDex) return y.effDex - x.effDex;
      return y.dex - x.dex;
    });
    var order = [];
    list.forEach(function (a) {
      for (var i = 0; i < a.actionsPerRound; i++) {
        order.push({ id: a.id, name: a.name, dex: a.dex, effDex: a.effDex,
                     readyFirearm: a.readyFirearm, manualOrder: a.manualOrder,
                     slot: i + 1, totalSlots: a.actionsPerRound });
      }
    });
    return { order: order };
  };

  /**
   * 开战：把 actors 编译成行动槽。
   * - **只把选中的怪物/NPC 入队**（契约 §5.3：新增 actorIds 参数）
   * - **必须调用 CocRules.initiativeOrder()** 排序：
   *     DEX 降序、已准备枪械 +50、manualOrder 优先、多行动展开成多槽
   * - 怪物默认 hpPublic=false → 客户端拿不到 HP 数字
   *
   * @param {object|Array} p  {actors, actorIds, useReadyFirearm}（兼容旧的「直接传数组」）
   */
  Host.prototype.combatStart = function (p) {
    var out = [];
    if (Array.isArray(p)) p = { actors: p };     // 兼容旧的 combatStart(actors)
    p = p || {};
    var pool = Array.isArray(p.actors) ? p.actors : [];
    var ids = Array.isArray(p.actorIds) ? p.actorIds.map(String) : null;
    /* 只把选中的单位入队；没给 actorIds 时退化为「全部入队」（旧行为）。
       v2.0.2 修复C'：**PC 永远自动加入**（无视 actorIds 过滤）—— 与契约注释一致。
       actorIds 只用于过滤「可选单位」（怪物 / NPC）。既有单测场景 13 / 18 显式把
       PC 放进 actors，本改动对它们完全无影响（无 actorIds 时仍是全量入队）。 */
    var actors = (ids && ids.length)
      ? pool.filter(function (a) { return a.kind === 'pc' || ids.indexOf(String(a.id)) >= 0; })
      : pool;
    /* v2.7.0（用户第 1 项）：KP 可选择「哪些玩家进入战斗」—— 载荷带 pcSeats（seat 数组）时
       只保留 seat 命中的 PC；**未传 pcSeats 时保持旧的全量行为**（向后兼容，不打红既有测试）。
       ⚠️ 只影响 PC；怪物 / NPC 仍由 actorIds 过滤，撕卡 PC 仍在下方被跳过。 */
    var pcSeats = Array.isArray(p.pcSeats) ? p.pcSeats.map(String) : null;
    if (pcSeats) {
      actors = actors.filter(function (a) {
        if (!a || a.kind !== 'pc') return true;
        return pcSeats.indexOf(String(a.seat)) >= 0;
      });
    }
    /* v2.1.7（用户 bug 反馈）：**撕卡（死亡/永久疯狂）的角色不能进入战斗** ——
       以前 KP 误选后照常入队，死人还能挨打/行动。跳过并给 KP 明确提示。 */
    var selfCS = this;
    var rippedSkipped = [];
    actors = actors.filter(function (a) {
      if (a && a.kind === 'pc' && a.seat) {
        var mm = selfCS.roster.get(a.seat);
        if (mm && memberRipped(mm)) { rippedSkipped.push(a.name || a.seat); return false; }
      }
      return true;
    });
    if (rippedSkipped.length) {
      this._push(out, this._sysTo(HOST_SEAT,
        '已跳过已撕卡的角色（死亡/永久疯狂，不能参战）：' + rippedSkipped.join('、')));
    }

    /* ---- 排序：优先用规则服务，缺失时兜底 ---- */
    var rules = this.rules;
    var ordered;
    var brief = actors.map(function (a) {
      return { id: a.id, name: a.name, dex: a.dex,
               readyFirearm: !!(a.readyFirearm || a.ready || a.preparedFirearm),
               actionsPerRound: a.actionsPerRound, manualOrder: a.manualOrder };
    });
    if (rules && typeof rules.initiativeOrder === 'function') {
      ordered = rules.initiativeOrder(brief, { useReadyFirearm: p.useReadyFirearm !== false });
      if (!ordered || !Array.isArray(ordered.order)) ordered = this._initiativeFallback(brief);
    } else {
      ordered = this._initiativeFallback(brief);
    }

    /* ---- 把原始单位字段并回槽（排序函数只认识行动相关字段） ---- */
    var byId = {};
    actors.forEach(function (a) { byId[String(a.id)] = a; });
    var slots = ordered.order.map(function (o) {
      var a = byId[String(o.id)] || {};
      var actions = Math.max(1, num(o.totalSlots, Math.max(1, num(a.actionsPerRound, 1))));
      var slotNo = num(o.slot, 1);
      return {
        id: String(o.id) + (actions > 1 ? ('#' + slotNo) : ''),
        actorId: String(o.id),
        name: a.name || o.name || '',
        seat: a.seat || '',
        kind: a.kind || 'npc',                       // pc / npc / monster
        dex: num(a.dex, num(o.dex, 0)),
        effDex: num(o.effDex, num(a.dex, 0)),
        readyFirearm: !!o.readyFirearm,
        manual: (o.manualOrder !== undefined && o.manualOrder !== null),
        manualOrder: (o.manualOrder === undefined ? null : o.manualOrder),
        slot: slotNo,
        totalSlots: actions,
        done: false,
        movedToTail: false,                          // 契约 §6.2：行动结束自动排到队尾的标记
        public: {
          dex: num(a.dex, 0),
          state: a.state || '',
          /* ⚠️ 玩家/NPC 的 HP 可以公开；怪物默认不公开（hpPublic=false） */
          hpPublic: a.kind === 'pc' ? true : (a.hpPublic === true),
          hp: num(a.hp, 0),
          hpMax: num(a.hpMax, 0),
          down: !!a.down
        }
      };
    });

    var combat = { order: slots, turn: 0, round: 1, startedAt: this.now() };
    this.state.combat = combat;
    /* v2.8.0（HP 机制 · 用户需求 B）：入队即按成员 body 同步 PC 槽 down/state/hp ——
       战斗前已「昏迷 / 濒死 / 死亡」的 PC 一进队列就被 slotDown 跳过（不占行动轮）。 */
    this._stampAllPcSlots();
    /* v2.1.7：out 已在函数顶部声明（撕卡跳过提示在那里入列），这里不再重置 */
    this.state.meta.mode = MODE.COMBAT;
    this._push(out, this.emit(EVT.STATUS, { status: this.state.meta.status, mode: MODE.COMBAT }, VIS.PUBLIC));
    this._push(out, this.emit(EVT.COMBAT, { combat: this.combatFor(HOST_SEAT) }, VIS.PUBLIC));
    this._push(out, this._sys('进入战斗：共 ' + slots.length + ' 个行动槽'));
    return out;
  };

  /** 新增 / 更新一个战斗参与者（KP） */
  Host.prototype.combatActor = function (actor) {
    actor = actor || {};
    if (!actor.id) actor.id = 'x' + (++this.localSeq);
    var out = [];
    this._push(out, this.emit(EVT.ACTOR, { actor: actor }, VIS.PUBLIC));
    this._push(out, this._sys('KP 更新了战斗单位「' + (actor.name || '') + '」'));
    return out;
  };

  /**
   * v2.7.0（用户第 1 项）：把指定玩家（seat）/ 单位**追加**进现有战斗行动序。
   *
   *   与 combatStart 的区别 —— 这里**只追加**，绝不重置 turn / round 或覆盖其它槽
   *   （幂等：目标已在队列里则直接跳过）。用途：
   *     · KP 在战斗面板点「＋加入战斗」把某个 PC 临时拉进战斗；
   *     · v2.6.0 轮次门禁要求玩家有自己的 pc 槽才可发起战斗对抗 ——
   *       没被排进 combat.order 的玩家靠这里被 KP 拉进来。
   *
   *   仅战斗态生效；非战斗态给 KP 明确提示，不改动任何状态。
   *
   *   载荷 { seats?:string[], seat?:string, actorIds?:string[], actorId?:string }
   *     · seat    → 追加一个 pc 槽（id 'p-<seat>'，与 room-panels#pcActors 同一命名），
   *                 DEX 走 _skillBaseOf('敏捷')、HP 走成员现值；
   *     · actorId → 从候选池（this.localActors）取单位追加（候选池没有则跳过）。
   *
   * @param {object} p { seats?, seat?, actorIds?, actorId? }
   * @returns {Array} 事件计划
   */
  Host.prototype.combatEnqueue = function (p) {
    var out = [];
    p = p || {};
    var c = this.state.combat;
    if (!c || !Array.isArray(c.order)) {
      this._push(out, this._sysTo(HOST_SEAT, '当前不在战斗中，无法把单位加入战斗（请先开始战斗）'));
      return out;
    }
    var order = c.order;

    /* 归并 seat / actorId（单值与数组两种写法都收） */
    var seatList = [];
    if (Array.isArray(p.seats)) seatList = seatList.concat(p.seats);
    if (p.seat !== undefined && p.seat !== null && p.seat !== '') seatList.push(p.seat);
    var idList = [];
    if (Array.isArray(p.actorIds)) idList = idList.concat(p.actorIds);
    if (p.actorId !== undefined && p.actorId !== null && p.actorId !== '') idList.push(p.actorId);

    var added = [];
    var selfCS = this;
    var skippedRipped = [];   // v2.7.0：被撕卡守卫跳过的角色名（用于逐条提示）

    /* ---- 1) 玩家（pc 槽）：幂等跳过已入队座位；v2.7.0 补撕卡守卫（死亡/永久疯狂不入队） ---- */
    seatList.forEach(function (rawSeat) {
      var seat = cleanText(rawSeat, 40);
      if (!seat) return;
      for (var i = 0; i < order.length; i++) {
        if (order[i] && order[i].kind === 'pc' && order[i].seat === seat) return;   // 已在队列
      }
      var m = selfCS.roster.get(seat);
      var name = selfCS._unitName(m, seat);
      /* v2.7.0（用户第 3 项·纵深防御）：与 combatStart 同一口径 —— 已撕卡（死亡 / 永久
         疯狂）的角色不入队。多目标时不整体失败，只跳过撕卡者（活人照常入队）。 */
      if (m && memberRipped(m)) { skippedRipped.push(name); return; }
      var dex = selfCS._skillBaseOf(m, '敏捷', null);
      var hp = m ? memberStatusValue(m, 'currentHP') : null;
      var hpMax = null;
      if (m && m.sheet && m.sheet.status && isFinite(Number(m.sheet.status.maxHP))) {
        hpMax = Number(m.sheet.status.maxHP);
      }
      var d = (dex == null ? 0 : num(dex, 0));
      var h = (hp == null ? 0 : num(hp, 0));
      var hm = (hpMax == null ? h : num(hpMax, h));
      order.push({
        id: 'p-' + seat,
        actorId: 'p-' + seat,
        name: name,
        seat: seat,
        kind: 'pc',
        dex: d,
        effDex: d,
        readyFirearm: false,
        manual: false,
        manualOrder: null,
        slot: 1,
        totalSlots: 1,
        done: false,
        movedToTail: false,
        public: { dex: d, state: '', hpPublic: true, hp: h, hpMax: hm, down: false }
      });
      added.push(name);
    });

    /* ---- 2) 单位（怪物 / NPC）：从候选池取，幂等跳过已入队 id ---- */
    idList.forEach(function (rawId) {
      var id = cleanText(rawId, 40);
      if (!id) return;
      for (var i = 0; i < order.length; i++) {
        if (order[i] && (order[i].actorId === id || order[i].id === id)) return;      // 已在队列
      }
      var a = null;
      var pool = Array.isArray(selfCS.localActors) ? selfCS.localActors : [];
      for (var j = 0; j < pool.length; j++) { if (pool[j] && pool[j].id === id) { a = pool[j]; break; } }
      if (!a) return;                                                                // 候选池没有 → 跳过
      var dx = num(a.dex, 0);
      var ah = num(a.hp, 0);
      var ahm = num(a.hpMax, ah);
      var kind = (a.kind === 'monster' || a.kind === 'npc') ? a.kind : 'npc';
      order.push({
        id: String(a.id),
        actorId: String(a.id),
        name: cleanText(a.name, 24) || '单位',
        seat: '',
        kind: kind,
        dex: dx,
        effDex: dx,
        readyFirearm: false,
        manual: false,
        manualOrder: null,
        slot: 1,
        totalSlots: Math.max(1, num(a.actionsPerRound, 1)),
        done: false,
        movedToTail: false,
        public: { dex: dx, state: '', hpPublic: false, hp: ah, hpMax: ahm, down: false }
      });
      added.push(cleanText(a.name, 24) || '单位');
    });

    /* v2.7.0（用户第 3 项）：撕卡守卫的逐条提示（对齐 combatStart 的措辞）。 */
    if (!added.length) {
      if (skippedRipped.length) {
        this._push(out, this._sysTo(HOST_SEAT,
          '「' + skippedRipped.join('」「') + '」已撕卡（死亡/永久疯狂），不能加入战斗'));
      } else {
        this._push(out, this._sysTo(HOST_SEAT,
          '没有可加入战斗的目标（已在队列中的会被跳过）'));
      }
      return out;
    }
    if (skippedRipped.length) {
      this._push(out, this._sysTo(HOST_SEAT,
        '已跳过已撕卡的角色（死亡/永久疯狂，不能加入战斗）：' + skippedRipped.join('、')));
    }

    /* v2.8.0（HP 机制 · 用户需求 B）：新入队的 PC 槽按成员 body 同步 down/state/hp
       —— 战斗前已昏迷/濒死/死亡的 PC 一入队即被 slotDown 跳过（随 TURNSTATE 下发）。 */
    this._stampAllPcSlots();

    /* 只广播状态刷新（TURNSTATE 带回原样的 turn / round），**绝不重置轮次**。 */
    this._push(out, this.emit(EVT.TURNSTATE, { turn: c.turn, round: c.round, order: order }, VIS.PUBLIC));
    this._push(out, this._sys('KP 把「' + added.join('」「') + '」加入了战斗'));
    return out;
  };

  /** 伤害结算（走规则服务算好后传入；这里只记账并写日志） */
  Host.prototype.combatDamage = function (p) {
    var out = [];
    var c = this.state.combat;
    if (!c) { this._push(out, this._sysTo(HOST_SEAT, '当前没有战斗')); return out; }
    var slot = null;
    for (var i = 0; i < c.order.length; i++) if (c.order[i].id === p.slotId) slot = c.order[i];
    if (!slot) { this._push(out, this._sysTo(HOST_SEAT, '找不到该行动槽')); return out; }
    var pub = slot.public || (slot.public = {});
    var beforeHp = num(pub.hp, 0);
    var dmg = num(p.damage, 0);
    pub.hp = Math.max(0, beforeHp - dmg);
    if (p.state) pub.state = p.state;
    pub.down = pub.hp <= 0;
    this._push(out, this.emit(EVT.ACTOR, { actor: slot }, VIS.PUBLIC));
    /* v2.1.4（用户第 2 项 ·「战斗信息里血量变了，但左上角玩家信息卡不变」）：
       这里原来**只改战斗槽**（slot.public.hp），没有写回成员表。
       v2.1.5：走 settleWounds 做**死亡判定**（v2.10.0（R6）口径修正：单次伤害 **>** 上限即死；归零分流：有重伤→濒死 / 无重伤→昏迷），
       战斗槽血量优先作为基准（成员可能还没上报角色卡）。 */
    if (slot.seat) {
      var victim = this.roster.get(slot.seat);
      if (victim) {
        /* v2.8.0（HP 机制 · 用户第 1 项）：经统一 HP 收口 applyHpChange（→ settleWounds），
           显式传战斗槽血量作基准（成员可能还没上报角色卡）。 */
        out = out.concat(this.applyHpChange(victim, -dmg, '战斗伤害', {
          base: { maxHP: num(pub.hpMax, num(slot.hpMax, beforeHp || 1)), currentHP: beforeHp }
        }));
        var vhp = memberStatusValue(victim, 'currentHP');
        if (vhp != null) pub.hp = vhp;
        /* v2.8.0（HP 机制 · 用户第 2 项）：昏迷/濒死/死亡同步到战斗槽 down（供 nextTurn 跳轮）。 */
        out = out.concat(this._syncBodyToCombatSlot(victim));
      } else {
        out = out.concat(this.stateApply(slot.seat,
          { status: { currentHP: num(pub.hp, 0) } }, { reason: '战斗伤害' }));
      }
    }
    this._push(out, this.emit(EVT.LOG, {
      seat: HOST_SEAT, text: (slot.name || '') + ' 受到 ' + num(p.damage, 0) + ' 点伤害' +
        (p.summary ? ('（' + p.summary + '）') : ''), at: this.now(), kind: 'damage'
    }, VIS.PUBLIC));
    return out;
  };

  /**
   * 玩家 / KP 提交一次攻击（需求 §8.3 / §10.1，v2.0.0 改造）。
   *
   * v2.0.0：改为走 **CocRules.resolveAttack()** 结算（攻击 + 闪避/反击 +
   * 成功等级比较 + 伤害骰 + 伤害加值 + 护甲减免），产出伤害并**写进 HP 与日志**，
   * 不再原样记录客户端传来的摘要。
   *
   * 规则服务未落地时（D 线未交付）退化为只记日志 —— 不自己实现规则函数。
   */
  Host.prototype.combatAttack = function (seat, p) {
    var out = [];
    var c = this.state.combat;
    if (!c) { this._push(out, this._sysTo(seat, '当前没有战斗')); return out; }
    p = p || {};
    var cur = c.order[c.turn] || {};
    if (seat !== HOST_SEAT && cur.seat !== seat) {
      this._push(out, this._sysTo(seat, '还没轮到你行动'));
      return out;
    }
    /* 目标槽 */
    var tid = p.targetId;
    var tSlot = null;
    for (var i = 0; i < (c.order || []).length; i++) {
      if (c.order[i].actorId === tid) { tSlot = c.order[i]; break; }
    }
    /* v1.18.5（用户需求）：玩家只能攻击怪物/NPC。界面已过滤，这里是权威端兜底。 */
    if (seat !== HOST_SEAT && tSlot && tSlot.kind !== 'monster') {
      this._push(out, this._sysTo(seat, '只能攻击怪物/NPC，不能攻击队友'));
      return out;
    }
    /* 攻击者槽（默认当前行动槽） */
    var aSlot = cur;
    if (p.slotId) {
      for (var s = 0; s < c.order.length; s++) if (c.order[s].id === p.slotId) aSlot = c.order[s];
    }
    var nick = this._nick(this.roster.get(seat), seat);
    var aMem = (aSlot && aSlot.seat) ? this.roster.get(aSlot.seat) : null;
    var tMem = (tSlot && tSlot.seat) ? this.roster.get(tSlot.seat) : null;

    /* 权威取值：优先角色卡（skillValue/attrValue），回落客户端上报 */
    var attackValue = this._skillBaseOf(aMem, p.skill, p.base === undefined ? 50 : p.base);
    var defenseValue = this._skillBaseOf(tMem, p.defenseSkill || '闪避',
                                         p.defenseBase === undefined ? 25 : p.defenseBase);

    /* 目标 HP：规则服务据此判定重伤/濒死/昏迷/死亡（D 线 §4.1 加法扩展）。
       槽位优先（怪物/NPC），玩家则取角色卡状态。 */
    var tPub = (tSlot && tSlot.public) || {};
    var tHp = num(tPub.hp, num(tSlot && tSlot.hp, 0));
    var tMaxHp = num(tPub.hpMax, num(tSlot && tSlot.hpMax, tHp));
    if (tMem && tMem.sheet && tMem.sheet.status) {
      if (tMem.sheet.status.currentHP !== undefined) tHp = num(tMem.sheet.status.currentHP, tHp);
      if (tMem.sheet.status.maxHP !== undefined) tMaxHp = num(tMem.sheet.status.maxHP, tMaxHp);
    }

    var args = Object.assign(ruleOptsOf(this.state.meta), {   // v2.3.0（第 7 项）：透传阈值
      attack: { name: cleanText(p.skill, 30) || '格斗', value: num(attackValue, 50),
                ranged: !!(p.ranged || (p.attack && p.attack.ranged)) },
      defense: {
        name: cleanText(p.defenseSkill, 30) || '闪避',
        value: num(defenseValue, 25),
        mode: (p.defense === 'fightback') ? 'fightback' : ((p.defense === 'none') ? 'none' : 'dodge')
      },
      damage: { expr: cleanText(p.damage, 20) || '1D3', db: cleanText(p.db, 10) || '0' },
      armor: { value: num(p.armor, num(tSlot && tSlot.armor, 0)) },
      impale: !!p.impale,
      difficulty: p.difficulty || 'REGULAR',
      bonus: num(p.bonus, 0), penalty: num(p.penalty, 0),
      secret: !!p.secret,
      /* D 线 §4.1 加法扩展：目标 HP（用于伤势 flags）与远程标记（远程不能反击） */
      maxHP: tMaxHp, currentHP: tHp,
      target: { maxHP: tMaxHp, currentHP: tHp, majorWound: !!tPub.majorWound },
      ranged: !!(p.ranged || (p.attack && p.attack.ranged)),
      rng: p.rng
    });

    var rules = this.rules;
    var res = (rules && typeof rules.resolveAttack === 'function') ? rules.resolveAttack(args) : null;

    if (res && typeof res === 'object') {
      /* ---- 结算：按 outcome 决定**谁挨打**（契约 §4.1）----
         · hit / attacker_wins → 伤害打在**目标**身上
         · defender_wins       → 反击胜出，伤害归防御方，打在**攻击者**身上
         · miss                → 不结算
         ⚠️ 不能只看 damage.applied>0 —— 反击命中时那份伤害是攻击者吃的。 */
      var outcome = res.outcome || 'hit';
      var applied = Math.max(0, num(res.damage && res.damage.applied, 0));
      var victim = null;
      if (applied > 0) {
        if (outcome === 'defender_wins') victim = aSlot;
        else if (outcome === 'hit' || outcome === 'attacker_wins') victim = tSlot;
        /* outcome === 'miss' / 其它 → 不结算伤害 */
      }
      if (victim && applied > 0) {
        var pub = victim.public || (victim.public = {});
        /* v2.8.0（HP 机制 · 用户第 1 项）：记扣血前血量，作 settleWounds 的显式基准
           （玩家槽有 hp/hpMax，成员可能还没上报角色卡 —— 与 combatDamage 同口径）。 */
        var victimHpBefore = num(pub.hp, 0);
        pub.hp = Math.max(0, victimHpBefore - applied);
        pub.down = pub.hp <= 0;
        /* 伤势 flags：仅当规则服务拿到目标 HP（maxHP>0）时才有效；
           若 unknown:true（全 false），不当作「活着」，只是不写状态。 */
        if (res.flags && !res.flags.unknown) {
          if (res.flags.dead) pub.state = 'dead';
          else if (res.flags.dying) pub.state = 'dying';
          else if (res.flags.unconscious) pub.state = 'unconscious';
          else if (res.flags.majorWound) pub.state = 'majorWound';
        }
        this._push(out, this.emit(EVT.ACTOR, { actor: victim }, VIS.PUBLIC));
        /* 挨打的是玩家 → 写回他的本机角色卡（幂等，按 seq）。
           v2.1.5（用户第 2 项）：走 settleWounds 做**死亡判定**（v2.10.0（R6）口径修正：单次伤害 **>** 上限即死；归零分流：有重伤→濒死 / 无重伤→昏迷），
           并把战斗槽血量同步为结算后成员血量。 */
        if (victim.seat) {
          var vMem = this.roster.get(victim.seat);
          if (vMem) {
            /* v2.8.0（HP 机制 · 用户第 1 项）：经统一 HP 收口 applyHpChange（→ settleWounds），
               显式传战斗槽血量作基准。 */
            out = out.concat(this.applyHpChange(vMem, -applied, '战斗受伤', {
              base: { maxHP: num(pub.hpMax, num(victim.hpMax, victimHpBefore || 1)), currentHP: victimHpBefore }
            }));
            var vHp = memberStatusValue(vMem, 'currentHP');
            if (vHp != null) pub.hp = vHp;
            out = out.concat(this._syncBodyToCombatSlot(vMem));
          } else {
            out = out.concat(this.stateApply(victim.seat,
              { status: { currentHP: num(pub.hp, 0) } }, { reason: '战斗受伤' }));
          }
        }
      }
      /* v2.3.0（用户第 10 项）：枪械攻击故障判定 —— 用本次攻击掷值（大成功不故障）。 */
      var mfw = { name: cleanText(p.weaponName, 40) || cleanText(p.skill, 30) || '武器',
                  malfunction: cleanText(p.malfunction, 8), perRound: cleanText(p.perRound, 12) };
      this._applyMalfunction(out, seat, mfw, res.attack ? res.attack.value : 0,
        !!(res.attack && res.attack.critical), p.malfType);
      this._push(out, this.emit(EVT.LOG, {
        seat: seat, text: nick + ' 发起攻击' + (res.summary ? ('：' + res.summary) : ''),
        at: this.now(), kind: 'attack'
      }, VIS.PUBLIC));
    } else {
      /* 规则服务未落地：退化为只记日志、不改 HP —— 与旧行为一致。
         不自己实现规则函数（契约明确）。 */
      var r2 = p.result || {};
      this._push(out, this.emit(EVT.LOG, {
        seat: seat, text: nick + ' 发起攻击' + (r2.summary ? ('：' + r2.summary) : ''),
        at: this.now(), kind: 'attack'
      }, VIS.PUBLIC));
    }
    return out;
  };

  /**
   * v2.3.0（用户第 10 项）：武器故障判定的**统一落地点**（combatAttack 与武器对抗共用）。
   *   · 用本次攻击掷值判故障（大成功不故障、`——`/空/非法永不故障，见 CocRules#malfunctionOf）；
   *   · 自动套用一种常见故障（KP 可在弹层指定 kpType；缺省按武器类型，见
   *     CocRules#defaultMalfunctionType）；四种效果见 CocRules#malfunctionEffect；
   *   · 故障写进该玩家**临时状态**（复用 sheetTempStatus 语义，经 EVT.STATE 写回其角色卡）；
   *   · 炸膛 → 射手受 1D3−1 伤害（走 settleWounds）+ 武器标记 broken（随 EVT.STATE 写回）；
   *   · 同时写一条公开日志。
   * @returns {boolean} 是否触发了故障
   */
  Host.prototype._applyMalfunction = function (out, seat, weapon, rollValue, isCritical, kpType) {
    var rules = this.rules;
    if (!rules || typeof rules.malfunctionOf !== 'function') return false;
    var w = weapon || {};
    var r = rules.malfunctionOf(w, rollValue, { critical: !!isCritical });
    if (!r.jammed) return false;
    var eff = (typeof rules.malfunctionEffect === 'function')
      ? rules.malfunctionEffect(w, cleanText(kpType, 12) || null, this.rng) : null;
    if (!eff) return false;
    var mem = this.roster.get(seat);
    var who = this._nick(mem, seat);
    var wname = cleanText(w.name, 40) || '武器';
    /* ⚠️ 入队必须**原地 push**：`out = out.concat(...)` 会把局部 out 重新绑到新数组，
       调用方（combatAttack / _opposedAttackResolve）手里的原数组就收不到这些事件 ——
       表现为「故障生效了但玩家端看不到日志、也没收到 STATE 写回」（v2.3.0 实测 bug）。 */
    var add = function (arr) { for (var i = 0; i < (arr || []).length; i++) out.push(arr[i]); };
    /* ① 追加临时状态（复用 sheetTempStatus 语义：读旧 → push → stateApply 整体替换） */
    if (mem) {
      if (!mem.sheet) mem.sheet = sanitizeSheet({}, mem);
      if (!Array.isArray(mem.sheet.tempStatus)) mem.sheet.tempStatus = [];
      var tsList = mem.sheet.tempStatus.slice();
      tsList.push({ text: wname + ' ' + eff.label + eff.clearText, by: 'kp', at: this.now() });
      add(this.stateApply(seat, { tempStatus: tsList },
        { reason: '武器故障：' + eff.label }));
      /* ② 炸膛：武器彻底损坏（标记 broken，随 EVT.STATE 写回角色卡）+ 射手受伤 */
      if (eff.destroyed) {
        var ws = (mem.sheet && Array.isArray(mem.sheet.weapons)) ? mem.sheet.weapons.slice() : [];
        var marked = false;
        for (var i = 0; i < ws.length; i++) {
          if (cleanText(ws[i] && ws[i].name, 40) === wname) { ws[i] = Object.assign({}, ws[i], { broken: true }); marked = true; }
        }
        if (!marked) ws.push(Object.assign({}, w, { broken: true }));
        add(this.stateApply(seat, { weapons: ws }, { reason: '武器损坏：' + wname }));
        /* v2.8.0（HP 机制 · 用户第 1 项）：经统一 HP 收口 applyHpChange（→ settleWounds）。 */
        if (eff.damage > 0) add(this.applyHpChange(mem, -eff.damage, wname + ' 炸膛'));
      }
    }
    /* ③ 公开日志（让所有人知道） */
    this._push(out, this.emit(EVT.LOG, {
      seat: seat, kind: 'attack',
      text: who + ' 的 ' + wname + ' ' + eff.label + eff.clearText +
        (eff.destroyed ? '，武器彻底损坏' : '') +
        (eff.damage > 0 ? ('，' + who + ' 受 ' + eff.damage + ' 点伤害') : ''),
      at: this.now()
    }, VIS.PUBLIC));
    return true;
  };

  Host.prototype.combatEnd = function () {
    var out = [];
    this.state.meta.mode = MODE.EXPLORATION;
    this._push(out, this.emit(EVT.COMBAT, { combat: null }, VIS.PUBLIC));
    this._push(out, this.emit(EVT.STATUS, { status: this.state.meta.status, mode: MODE.EXPLORATION }, VIS.PUBLIC));
    this._push(out, this._sys('战斗结束，回到探索模式'));
    return out;
  };

  /**
   * 权威掷骰（需求 §10 / §0：**骰子只能由权威端掷**）。
   * 结果由 KP 端规则服务（RoomRules）算好后带进来；这里只负责记进
   * 公共事件流并广播 —— 这样所有人看到的是同一颗骰子，重连也能补回。
   * 传入 p.result 的字段原样保留（rolls/level/levelText/…），不做二次篡改。
   */
  Host.prototype.diceRoll = function (seat, p) {
    var out = [];
    var res = p.result || {};
    var nick = this._nick(this.roster.get(seat), seat);
    this._push(out, this.emit(EVT.DICE, {
      seat: seat, nickname: nick,
      expr: cleanText(p.expr, 40) || '1D100',
      rolls: res.rolls || [],
      /* v2.1.4（用户第 3 项 · 「加了 2 个奖励骰结果还是 81」）：
         检定结果的骰面明细（如「个位骰 1；十位骰 8/2/2 → 取 21」）。
         rules.check() 把它放在 res.dice.detail，而**不**在 res.rolls 里 ——
         以前这里只取 rolls（永远是空数组），于是游戏记录只显示一个最终数字，
         玩家根本看不出奖励骰有没有生效（81 也可能是两颗十位骰都差）。
         现在把明细一并带下去，记录里能读全。 */
      detail: (res.dice && res.dice.detail) || res.detail || '',
      total: (res.value === undefined ? res.total : res.value),
      level: res.levelKey || res.level || '',
      levelText: res.levelText || '',
      label: cleanText(p.label, 20),
      at: this.now()
    }, VIS.PUBLIC));
    return out;
  };

  /**
   * 玩家**直投**骰子（v1.18.5，用户需求：点 D100 就出结果，不要再请 KP）。
   *
   * 架构不变的部分：骰子仍然**只在权威端掷** —— 玩家的意图只声明
   * 「掷什么（expr）、目标值（base）、难度（difficulty）、奖惩骰（bonus/penalty）」，
   * 骰面与成功等级由 KP 设备上的规则服务算出后广播。这样：
   *   · 全员看到同一颗骰子、重连能补回；
   *   · 玩家端无法伪造骰面（伪造的只是目标值，而目标值和骰面都记录在案，
   *     KP 看得到 —— 朋友间跑团够用了）。
   * 带了 reqId（来自「KP 推送的检定请求」卡片）时，顺手把那张请求卡
   * 在玩家端摘掉（REQUEST-done 事件）。
   */
  Host.prototype.diceDirect = function (seat, mem, role, p) {
    var out = [];
    if (role === ROLE.SPECTATOR) {
      this._push(out, this._sysTo(seat, '旁观者不能掷骰'));
      return out;
    }
    var rules = this.rules;
    var res;
    var expr = cleanText(p.expr, 40) || '1D100';
    if (expr !== '1D100' && rules && typeof rules.rollExpr === 'function') {
      /* 非百分骰（D4/D6/D8/D10、自定义骰式）：解析后按骰式掷，无成功等级 */
      var rr = rules.rollExpr(expr);
      if (rr && rr.ok) {
        res = { rolls: rr.rolls, value: rr.total, detail: rr.detail };
      } else {
        this._push(out, this._sysTo(seat, rr && rr.reason ? rr.reason : '骰式不合法'));
        return out;
      }
    } else if (rules && typeof rules.check === 'function') {
      /* v2.0.0：目标值优先从**角色卡权威取值**（CocRules.skillValue / attrValue），
         查不到才回落到客户端上报的 base —— 客户端上报的 base 可伪造、换机就失效。 */
      var authBase = this._skillBaseOf(mem, p.skill || p.label, null);
      var base = (authBase === null || authBase === undefined)
        ? Math.max(0, Math.min(100, num(p.base, 100)))
        : Math.max(0, Math.min(100, authBase));
      res = rules.check(Object.assign({
        kind: 'skill',
        base: base,
        difficulty: p.difficulty || 'REGULAR',
        bonus: Math.max(0, Math.min(MOD_CAP, num(p.bonus, 0))),
        penalty: Math.max(0, Math.min(MOD_CAP, num(p.penalty, 0))),
        label: cleanText(p.label, 20)
      }, ruleOptsOf(this.state.meta)));   // v2.3.0（第 7 项）：透传大成功 / 大失败阈值
    } else {
      /* 没有规则服务（理论上只有 Node 测试环境）：退化为纯骰面 */
      res = { value: 1 + Math.floor(Math.random() * 100) };
    }
    if (p.secret) {
      /* v2.1.4（用户第 4 项）：**暗骰** —— 结果只发给掷骰者本人与 KP，公共流只留一句
         「XX 暗骰了一次」。以前玩家的 secret 被忽略（暗骰只对 KP 生效），
         于是玩家开着暗骰开关掷出来照样是明骰、数字直接进公共记录。
         ⚠️ 不能用 diceRoll()：它固定 VIS.PUBLIC（那是明骰语义）。 */
      var nick = this._nick(this.roster.get(seat), seat);
      var payload = {
        seat: seat, nickname: nick, secret: true,
        expr: expr,
        rolls: (res && res.rolls) || [],
        total: (res && res.value === undefined ? res.total : res.value),
        level: (res && (res.levelKey || res.level)) || '',
        levelText: (res && res.levelText) || '',
        detail: (res && res.dice && res.dice.detail) || (res && res.detail) || '',
        label: cleanText(p.label, 20),
        at: this.now()
      };
      /* 本人（他能看到自己的暗骰结果） */
      this._push(out, this.emit(EVT.DICE, clone(payload), VIS.SEAT, seat));
      /* KP（暗骰必须让主持人看到，否则没法裁定）—— KP 端也会归约进 state.dice */
      if (seat !== HOST_SEAT) {
        this._push(out, this.emit(EVT.DICE, clone(payload), VIS.SEAT, HOST_SEAT));
      }
      this._push(out, this.emit(EVT.LOG, {
        seat: seat, text: nick + ' 暗骰了一次（结果只有他/她与 KP 可见）',
        at: this.now(), kind: 'dice-dark'
      }, VIS.PUBLIC));
    } else {
      out = out.concat(this.diceRoll(seat, {
        expr: expr,
        label: p.label,
        result: res
      }));
    }
    /* 这颗骰子若是响应 KP 推送的检定请求 → 摘掉那张卡（玩家端 + 待办表） */
    var reqId = cleanText(p.reqId, 24);
    if (reqId) out = out.concat(this._settleRequest(seat, reqId, true, '完成了检定'));
    return out;
  };

  /**
   * v2.1.0 缺陷2：响应 KP「要求检定」请求的**同意**路径 —— 按权威端存的
   * 技能/难度替该玩家掷一次 D100，结果广播全员（骰子仍只在权威端掷）。
   *
   * 目标值取值优先级（与 diceDirect 同一条原则：优先权威、其次请求载荷、最后兜底）：
   *   ① 用**该玩家当前角色卡**权威解析技能值（_skillBaseOf）；
   *   ② 解析不到 → 用 KP 发起请求时算好的权威 base（req.payload.base）；
   *   ③ 都没有 → 100（纯 D100，不判定成功等级以外的误差）。
   *
   * @param {string} seat 玩家座位
   * @param {object} req  挂在 _requestsBySeat 上的请求记录 {op,payload,...}
   * @returns {Array} 发送计划
   */
  Host.prototype._rollCheckRequest = function (seat, req) {
    var out = [];
    var pl = (req && req.payload) || {};
    var mem = this.roster.get(seat);
    var rules = this.rules;
    var authBase = this._skillBaseOf(mem, pl.skill, null);
    var base = (authBase === null || authBase === undefined)
      ? Math.max(0, Math.min(100, num(pl.base, 100)))
      : Math.max(0, Math.min(100, authBase));
    var res;
    if (rules && typeof rules.check === 'function') {
      res = rules.check(Object.assign({
        kind: 'skill',
        base: base,
        difficulty: pl.difficulty || 'REGULAR',
        bonus: 0,
        penalty: 0,
        label: cleanText(pl.skill, 20)
      }, ruleOptsOf(this.state.meta)));   // v2.3.0（第 7 项）：透传阈值
    } else {
      /* 没有规则服务（Node 测试环境）：退化为纯骰面 */
      res = { value: 1 + Math.floor(Math.random() * 100) };
    }
    out = out.concat(this.diceRoll(seat, { expr: '1D100', label: pl.skill, result: res }));
    return out;
  };

  /**
   * 处理完一条针对 seat 的请求：从待办表移除 + 给玩家发 REQUEST-done。
   * 状态变更（consent）与检定响应共用这条收尾路径 —— 三个症状
   * （卡不消失 / 新请求看不见 / 再点说已处理）的根源就是缺了这一步。
   */
  Host.prototype._settleRequest = function (seat, id, agree, verb) {
    var out = [];
    var list = this._requestsBySeat[seat] || [];
    var idx = -1;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) idx = i;
    if (idx >= 0) list.splice(idx, 1);
    this.pending = this.pending.filter(function (x) { return x.id !== id; });
    this._push(out, this.emit(EVT.REQUEST,
      { self: true, id: id, done: true, at: this.now() }, VIS.SEAT, seat));
    if (verb) {
      this._push(out, this._sys(this._nick(this.roster.get(seat), seat) + ' ' + verb));
    }
    return out;
  };

  /* ============================================================
   * P6 —— KP 工具：状态请求 / 回退投票 / 结团
   * ============================================================ */

  /**
   * KP 请求修改玩家状态。**必须玩家明确同意才生效**（需求 §4 重要区分）。
   * 挂进 pending，等 CONSENT 意图回来再 applyAction。
   */
  Host.prototype.stateRequest = function (bySeat, p) {
    var out = [];
    var target = p.seat;
    if (!target) { this._push(out, this._sysTo(bySeat, '要指定目标玩家')); return out; }
    var id = 'r' + (++this.localSeq);
    var rec = { id: id, from: bySeat, op: 'state.apply', payload: clone(p.change || {}),
                reason: cleanText(p.reason, 80), at: this.now() };
    if (!this._requestsBySeat[target]) this._requestsBySeat[target] = [];
    this._requestsBySeat[target].push(rec);
    this.pending.push({ id: id, kind: 'state.request', by: bySeat, to: target,
                        change: clone(p.change || {}), at: this.now() });
    this._push(out, this.emit(EVT.REQUEST,
      { self: true, id: id, op: 'state.apply', payload: rec.payload,
        from: this._nick(this.roster.get(bySeat), bySeat), reason: rec.reason, at: rec.at },
      VIS.SEAT, target));
    this._push(out, this._sysTo(bySeat, '已发送变更请求，等待玩家确认'));
    return out;
  };

  /**
   * KP 推送检定请求（v1.18.5 修「玩家收不到」）。
   *
   * ⚠️ 之前 `check.request` 只在权限表里登记了，applyAction 里**没有处理器**
   *    —— KP 点「推送检定」后 toast 说已推送，实际上一个事件都没发出去。
   *
   * 现在的行为：给目标（全体或单人）各发一条 REQUEST 事件（op='check.request'），
   * 玩家端弹出「KP 要求检定」卡；玩家点掷骰 → diceDirect 算结果并回发
   * REQUEST-done 摘卡。请求本身挂进 _requestsBySeat（consent 的忽略路径共用）。
   */
  Host.prototype.checkRequest = function (bySeat, p) {
    var out = [];
    var skill = cleanText(p.skill, 20) || '检定';
    var difficulty = p.difficulty || 'REGULAR';
    var desc = cleanText(p.desc, 200);
    var id = 'c' + (++this.localSeq);
    var targets;
    if (p.seat === '*' || !p.seat) {
      targets = this.roster.onlinePlayers().map(function (m) { return m.seat; });
    } else {
      targets = [p.seat];
    }
    if (!targets.length) {
      this._push(out, this._sysTo(bySeat, '没有在线的玩家可以推送'));
      return out;
    }
    var that = this;
    targets.forEach(function (t) {
      var tm = that.roster.get(t);
      /* v2.7.0（第 3 项 · 模型守卫）：已撕卡（死亡 / 永久疯狂）的目标**跳过并逐条提示**，
         不再给他发检定请求（否则那张「KP 要求检定」卡会永远挂在他那儿）。
         seat==='*' 时只跳过被撕卡者，其余照常收到 —— **不整体失败**。 */
      if (memberRipped(tm)) {
        that._push(out, that._sysTo(bySeat,
          '「' + that._nick(tm, t) + '」已撕卡（死亡/永久疯狂），已跳过检定请求'));
        return;
      }
      /* v2.0.0：目标值优先从该玩家的角色卡权威取值（不再只信客户端上报的 base）。
         查不到就为 null，玩家端再回落到自己上报的 base。 */
      var authBase = that._skillBaseOf(tm, skill, null);
      var rec = { id: id, from: bySeat, op: 'check.request',
                  payload: { skill: skill, difficulty: difficulty, desc: desc, base: authBase },
                  reason: desc, at: that.now() };
      if (!that._requestsBySeat[t]) that._requestsBySeat[t] = [];
      that._requestsBySeat[t].push(rec);
      that._push(out, that.emit(EVT.REQUEST,
        { self: true, id: id, op: 'check.request',
          payload: rec.payload, from: that._nick(that.roster.get(bySeat), bySeat),
          reason: desc, at: rec.at },
        VIS.SEAT, t));
    });
    var diffText = { REGULAR: '', HARD: '（困难）', EXTREME: '（极难）' }[difficulty] || '';
    this._push(out, this.emit(EVT.LOG, {
      seat: bySeat,
      text: 'KP 要求 ' + (p.seat === '*' || !p.seat ? '全体玩家' : this._nick(this.roster.get(p.seat), p.seat)) +
        '进行「' + skill + '」检定' + diffText,
      at: this.now(), kind: 'check-req'
    }, VIS.PUBLIC));
    this._push(out, this._sysTo(bySeat, '已推送检定请求'));
    return out;
  };

  /**
   * 回退投票（需求 §9）：
   * - 只允许回退 1 或 3 个完整回合（其它步数直接拒）
   * - 需要**所有当前玩家逐一同意**；任一拒绝/超时/断线 → 本次失败
   * - 全部同意后仍要 KP 二次确认（由 UI 调 confirmTwice 再提交）
   * - 提交时用序号校验，防止期间又发生新动作
   *
   * v1.19.0 修正「回退语义」：回退点与目标回合**都从 roundStarts（回合边界表）取**，
   * 不再用 meta.round 直接减、也不再拿「发起时刻」当回退点（那是「不退任何内容」）。
   *
   * 语义：从当前第 C 回合回退 `turns` 回合 → 落到第 (C - turns) 回合，
   * 并把「第 (C - turns) 回合之后」的内容事件全部裁掉。
   * 回退点 beforeSeq = 「第 (C - turns + 1) 回合的起始 seq」——
   * 因为 rollback(beforeSeq) 会丢弃 seq >= beforeSeq 的事件，
   * 于是目标回合及其之前的内容保留、其后的内容被裁掉，正好落在目标回合。
   */
  Host.prototype.rollbackPropose = function (bySeat, turns) {
    var out = [];
    if (turns !== 1 && turns !== 3) {
      this._push(out, this._sysTo(bySeat, '回退只支持 1 或 3 个回合'));
      return out;
    }
    if (this.rewind && this.rewind.state === REWIND.VOTING) {
      this._push(out, this._sysTo(bySeat, '已经有一个回退投票在进行'));
      return out;
    }
    var voters = this.roster.onlinePlayers().map(function (m) { return m.seat; });
    if (!voters.length) {
      this._push(out, this._sysTo(bySeat, '房间里没有可投票的玩家'));
      return out;
    }

    /* ---- 从回合边界表里算回退点 ---- */
    var starts = this.roundStarts || [];
    var cur = this.state.meta.round || 0;
    if (!starts.length || cur < 1) {
      /* 旧存档 / 还没标记过回合：**不静默退到第 1 回合**，而是如实说清楚。 */
      this._push(out, this._sysTo(bySeat,
        '本局还没有标记回合，无法回退。请先用「⏭ 进入下一回合」标记回合边界。'));
      return out;
    }
    var targetRound = cur - turns;
    if (targetRound < 1) {
      this._push(out, this._sysTo(bySeat,
        '没有足够的回合可以回退（当前第 ' + cur + ' 回合，最多回退 ' + (cur - 1) + ' 回合）'));
      return out;
    }
    /* 回退点 = 目标回合**之后**那一个回合的起始 seq（见函数头注释）。 */
    var boundary = null;
    for (var i = starts.length - 1; i >= 0; i--) {
      if (starts[i].round === targetRound + 1) { boundary = starts[i]; break; }
    }
    if (!boundary) {
      this._push(out, this._sysTo(bySeat,
        '找不到第 ' + (targetRound + 1) + ' 回合的边界，无法回退（回合边界不连续）'));
      return out;
    }

    this.rewindSeq += 1;
    this.rewind = {
      id: 'w' + this.rewindSeq, by: bySeat, turns: turns,
      /* beforeSeq = 回退点（目标回合之后那一个回合的起始 seq）。 */
      beforeSeq: boundary.seq,
      /* proposeSeq = 发起时刻的 log.seq —— 提交时用它做**并发干扰**判读：
         只有「发起之后」新出现的内容事件才算并发动作。
         （不能拿 beforeSeq 当基线：它是更早的回合边界，
           会把本回合那些**本就该被回退**的内容误判成并发动作。） */
      proposeSeq: this.log.seq,
      votes: {}, need: voters, state: REWIND.VOTING, at: this.now(),
      targetRound: targetRound
    };
    this._push(out, this.emit(EVT.REWIND, { rewind: clone(this.rewind) }, VIS.PUBLIC));
    this._push(out, this._sysTo(bySeat, '已发起回退 ' + turns + ' 回合的投票（将回到第 ' +
      targetRound + ' 回合），等待玩家同意'));
    return out;
  };

  /** 玩家投票。拒绝 / 断线（由 detachPeer 触发）→ 立即失败 */
  Host.prototype.rollbackVote = function (seat, agree) {
    var out = [];
    var r = this.rewind;
    if (!r || r.state !== REWIND.VOTING) { this._push(out, this._sysTo(seat, '当前没有回退投票')); return out; }
    if (r.need.indexOf(seat) < 0) { this._push(out, this._sysTo(seat, '你不在本次投票名单里')); return out; }
    if (!agree) {
      r.state = REWIND.FAILED; r.failReason = '有人拒绝了本次回退';
      this._push(out, this.emit(EVT.REWIND, { rewind: clone(r) }, VIS.PUBLIC));
      this._push(out, this._sys('回退未通过：' + this._nick(this.roster.get(seat), seat) + ' 拒绝了'));
      return out;
    }
    r.votes[seat] = true;
    this._push(out, this.emit(EVT.REWIND, { rewind: clone(r) }, VIS.PUBLIC));
    var all = r.need.every(function (s) { return r.votes[s]; });
    if (all) {
      /* 全部同意 → 等待 KP 二次确认（需求 §9）。这里只标记为「已可提交」。 */
      r.state = REWIND.DONE;
      r.ready = true;
      this._push(out, this.emit(EVT.REWIND, { rewind: clone(r) }, VIS.PUBLIC));
      this._push(out, this._sys('所有玩家已同意回退 ' + r.turns + ' 回合，等待 KP 确认'));
    } else {
      this._push(out, this._sys(this._nick(this.roster.get(seat), seat) + ' 同意了回退'));
    }
    return out;
  };

  /** KP 二次确认后真正执行回退（防并发：校验期间有没有**非回退类**的新动作） */
  Host.prototype.rollbackCommit = function (bySeat) {
    var out = [];
    var r = this.rewind;
    if (!r || !r.ready || r.state !== REWIND.DONE) {
      this._push(out, this._sysTo(bySeat, '回退还没有获得全部同意'));
      return out;
    }
    /* 投票/回退自身的事件（rewind 状态、给个人的提示、投票进度日志）不算「新动作」；
       只有**游戏内容类**事件（聊天/掷骰/战斗/场景/素材/检定点…）才算并发干扰。
       这样「发起 → 逐人投票 → 提交」这条链本身不会把自己判死，
       而真正的并发动作依然会被抓到。 */
    var META_EVTS = {};
    META_EVTS[EVT.REWIND] = 1;
    META_EVTS[EVT.PRIVATE] = 1;
    META_EVTS[EVT.LOG] = 1;
    var stray = null;
    var items = this.log.items || [];
    /* ⚠️ 并发基线用 proposeSeq（发起时刻），**不是** beforeSeq（回合边界）。
       beforeSeq 比发起时刻早，拿它当基线会把本回合那些本就要被回退的内容
       误判成「投票期间的新动作」，于是每次回退都被自己判死。 */
    var baseline = (r.proposeSeq === undefined || r.proposeSeq === null) ? r.beforeSeq : r.proposeSeq;
    for (var i = 0; i < items.length; i++) {
      if (items[i].seq > baseline && !META_EVTS[items[i].evt.t]) { stray = items[i]; break; }
    }
    if (stray) {
      r.state = REWIND.FAILED;
      r.failReason = '投票期间又有新动作发生，本次回退作废';
      this._push(out, this.emit(EVT.REWIND, { rewind: clone(r) }, VIS.PUBLIC));
      this._push(out, this._sys('回退作废：投票期间又发生了新的动作，请重新发起'));
      return out;
    }
    /* 审计事件（需求 §9：保存审计，但不作为普通游戏行动展示） */
    this._push(out, this.emitLocal('rewind.audit', {
      by: bySeat, turns: r.turns, beforeSeq: r.beforeSeq, at: this.now(),
      agreed: Object.keys(r.votes)
    }));
    out = out.concat(this.rollbackPlan(r.beforeSeq));
    r.state = REWIND.DONE;
    r.committed = true;
    this._push(out, this.emit(EVT.REWIND, { rewind: clone(r) }, VIS.PUBLIC));
    this._push(out, this.emit(EVT.LOG, {
      seat: '', text: '⚠️ 游戏状态已回退到第 ' + r.targetRound + ' 回合（聊天记录保留）',
      at: this.now(), kind: 'rewind'
    }, VIS.PUBLIC));
    return out;
  };

  /** 有人断线 → 进行中的回退投票立即失败（需求 §9） */
  Host.prototype.rollbackAbortIfVoting = function (seat) {
    var r = this.rewind;
    if (!r || r.state !== REWIND.VOTING) return [];
    if (r.need.indexOf(seat) < 0) return [];
    r.state = REWIND.FAILED; r.failReason = '有玩家在表决期间断线';
    var out = [];
    this._push(out, this.emit(EVT.REWIND, { rewind: clone(r) }, VIS.PUBLIC));
    this._push(out, this._sys('回退失败：有玩家在表决期间断线'));
    return out;
  };

  /** 结团：关房 + 归档标记（本地归档由 UI 负责） */
  Host.prototype.endSession = function () {
    var out = [];
    this._push(out, this.emit(EVT.ENDED, { at: this.now() }, VIS.PUBLIC));
    this.state.meta.status = STATUS.CLOSED;
    this.state.meta.ended = true;
    /* v2.1.6（用户第 4 项）：结团时**清空待确认队列** —— 否则残留的 twice/kp 条目
       会在结团后仍显示「待你确认」（用户实测：结团后提示还挂着）。 */
    this.pending = [];
    return out;
  };

  Host.prototype.setStatus = function (s) {
    return this.plan(this.emit(EVT.STATUS, { status: s }, VIS.PUBLIC));
  };

  /**
   * 回退到 beforeSeq 之前（需求 §12：**必须恢复状态快照与关联事件**，
   * 只把界面上的文字删掉不算回退）。
   *
   * 做法：找 seq ≤ beforeSeq-1 的最近快照 → 用它替换状态 → 重放快照之后
   * 到 beforeSeq-1 的事件 → 裁掉 beforeSeq 起的日志。三条缺一不可：
   *   只裁日志 → 界面变干净了，但 KP 内部状态还留着被撤销的伤害/疯狂
   *   只换快照 → 快照之后那些仍然有效的事件丢了
   */
  Host.prototype.rollback = function (beforeSeq) {
    var target = beforeSeq - 1;
    /* ⚠️ 先记下回退前的房间生命周期。status 不是游戏历史（需求 §9：
       回退恢复的是 HP/状态/地图/回合这类**游戏数据**），
       「开团」这个事实不能因为回退到更早的快照而被撤销。 */
    var prevStatus = this.state.meta.status;
    var snap = this.snapshots[0];
    for (var i = 0; i < this.snapshots.length; i++) {
      if (this.snapshots[i].seq <= target) snap = this.snapshots[i];
      else break;
    }
    this.state = emptyState(snap.state.meta);
    for (var k in snap.state) {
      if (Object.prototype.hasOwnProperty.call(snap.state, k)) this.state[k] = clone(snap.state[k]);
    }
    this.state.seq = snap.seq;

    var recs = this.log.items.filter(function (r) { return r.seq > snap.seq && r.seq <= target; });
    for (var j = 0; j < recs.length; j++) {
      reduce(this.state, { t: recs[j].evt.t, seq: recs[j].seq, p: recs[j].evt.p });
    }

    /* 生命周期只进不退：回退前已经在游戏中，恢复出的快照却还是「招募中」
       （快照早于 room.start，或者根本就是建团时的空状态）→ 保持游戏中。
       否则 paintPanels 只认 IN_GAME，KP 工具会全部消失、界面退回开团前
       —— 真机实测：回退成功后 KP「变成旁观者」，只剩解散一条路。 */
    if (prevStatus === STATUS.IN_GAME && this.state.meta.status === STATUS.RECRUITING) {
      this.state.meta.status = STATUS.IN_GAME;
    }

    /* ⚠️ 成员表是「谁现在连着」的现实，不是游戏历史 —— 回退不该把在场的人变没。
       快照里的成员表是当时那条 MEMBERS 事件的产物，回退到建团时刻就会变成空的；
       真按那个走，KP 一按回退，所有玩家都从名单里消失了（而且断开连线也回不来）。
       所以这里用当前花名册覆盖回来。 */
    this.state.members = this.members();

    var dropped = this.log.rollbackBefore(beforeSeq);
    this.snapshots = this.snapshots.filter(function (s) { return s.seq <= target; });
    /* 回合边界表必须跟着日志一起裁剪：被裁掉的回合边界不能继续留在表里，
       否则下一次回退会算到一个已不存在的 seq（v1.19.0）。 */
    this._rebuildRoundStarts();
    return { dropped: dropped, seq: this.log.seq, from: snap.seq };
  };

  /**
   * 回退并广播纠正结果。
   *
   * ⚠️ 为什么是「给所有人重发全量」而不是「再发一条反向事件」：
   *    客户端收到的事件是**已归约过的结果**，它没有反向操作可用（伤害减了
   *    就减了、疯狂标记加上就加上了）。想让所有人回到正确状态，只能整体重放。
   *    写代码时容易下意识地「补一条撤销事件」，那只会让状态越滚越歪。
   */
  Host.prototype.rollbackPlan = function (beforeSeq) {
    var r = this.rollback(beforeSeq);
    var out = [];
    var self = this;
    this.roster.list().forEach(function (m) {
      if (m.online) out.push({ to: m.seat, msg: self.syncFor(m.seat) });
    });
    this._push(out, this._sys('已回退到第 ' + r.seq + ' 条事件（撤销 ' + r.dropped + ' 条）'));
    return out;
  };

  /** 踢人：给被踢者单独发 KICK（他需要知道原因），其余人只看到成员表变化 */
  Host.prototype.kick = function (seat) {
    var m = this.roster.get(seat);
    if (!m) return [];
    var out = [];
    this._push(out, this.emit(EVT.KICK, { reason: '你已被房主移出房间' }, VIS.SEAT, seat));
    this.roster.remove(seat);
    out = out.concat(this.syncMembers());
    this._push(out, this._sys(this._nick(m, seat) + ' 已离开房间'));
    return out;
  };

  /** 关房 / 结团 */
  Host.prototype.closeRoom = function () {
    var out = [];
    this._push(out, this.emit(EVT.CLOSED, { at: this.now() }, VIS.PUBLIC));
    this.state.meta.status = STATUS.CLOSED;
    this.pending = [];              // v2.1.6：同 endSession，关房清空待确认队列
    return out;
  };

  /**
   * 「行动结束自动排到队尾」（契约 §6.2）：
   * 把标了 movedToTail 的槽整体挪到队尾（保持相对顺序），其余保持原序。
   * **只在本轮结束时调用** —— 轮内不重排，扫描「下一个未行动者」才不会被搅乱。
   */
  Host.prototype._reorderTail = function (order) {
    var rest = [], tail = [];
    for (var i = 0; i < order.length; i++) {
      if (order[i] && order[i].movedToTail) tail.push(order[i]);
      else rest.push(order[i]);
    }
    if (!tail.length) return order;
    var merged = rest.concat(tail);
    for (var j = 0; j < merged.length; j++) order[j] = merged[j];
    order.length = merged.length;
    return order;
  };

  /** 推进行动轮（多行动怪物在 order 里已经是多个槽） */
  Host.prototype.nextTurn = function () {
    var c = this.state.combat;
    var out = [];
    if (!c || !c.order || !c.order.length) {
      this._push(out, this._sys('当前没有战斗，无法推进行动轮'));
      return out;
    }
    var order = c.order;
    var len = order.length;
    var i = (c.turn === undefined || c.turn === null) ? 0 : c.turn;
    var prevRound = c.round || 1;
    /* 离开当前槽 → 标记「本轮已行动」 */
    if (order[i]) order[i].done = true;

    /* 一个单位完成本轮**全部**行动槽、且还有别的单位没行动 → 标记 movedToTail。
       （最后一个行动的单位不必标：本轮已经结束，挪不挪都一样。） */
    var curActor = order[i] && order[i].actorId;
    if (curActor) {
      var allMineDone = true, othersPending = false;
      for (var k = 0; k < len; k++) {
        var s = order[k] || {};
        if (s.actorId === curActor) { if (!s.done) allMineDone = false; }
        /* v2.5.0（用户第 3 项）：已死亡 / 倒地的槽不算「还没行动的人」——
           否则全员阵亡时 movedToTail 判定会失真（把回合让给死人）。 */
        else if (!s.done && !slotDown(s)) othersPending = true;
      }
      if (allMineDone && othersPending) {
        for (var m = 0; m < len; m++) {
          if (order[m] && order[m].actorId === curActor) order[m].movedToTail = true;
        }
      }
    }

    var round = prevRound;
    var next = i + 1;
    var guard = 0;
    /* 跳过本轮已行动完的槽；走完队尾就清空重来，轮次 +1 */
    while (guard++ <= len) {
      if (next >= len) {
        next = 0;
        round += 1;
        /* 本轮结束：先把「已完成」的单位挪到队尾，再清空 done / movedToTail */
        this._reorderTail(order);
        order.forEach(function (s) { s.done = false; s.movedToTail = false; });
      }
      if (!(order[next] || {}).done && !slotDown(order[next])) break;
      next += 1;
    }
    /* v2.5.0（用户第 3 项）：兜底 —— 上面的 while 在「全员已死 / 倒地」时靠 guard 退出，
       退出后仍停在一个死槽上（极端情况甚至越界）。这里二次检查：明确提示，并且
       **不把回合停在尸体上**（不发 TURNSTATE / TURN_ALERT，避免「下一回合永远是
       同一具尸体」的死循环）。 */
    if (!order[next] || slotDown(order[next])) {
      this._push(out, this._sys('没有可行动的单位了，请结束战斗或添加新单位'));
      return out;
    }
    /* v1.19.0：回合号改为**事件驱动**（EVT.ROUND），不再命令式赋值 ——
       这样 meta.round 会被快照 / 回退重放 / 全量同步正确携带。
       只在轮次真正变化时才发（同一轮里推进「下一个行动者」不该记一条新回合边界）。 */
    if (round !== prevRound) {
      /* v2.8.0（HP 机制 · 用户第 4 项）：统一回合出口 _advanceRound（发 ROUND +
         濒死每轮 CON + 天/周恢复）。旧实现只在此处（nextTurn）调 _onRoundBoundary，
         探索态 round.next 漏触发 —— 现已收口。 */
      out = this._advanceRound(out, round);
    }
    this._push(out, this.emit(EVT.TURNSTATE, { turn: next, round: round, order: order }, VIS.PUBLIC));
    var cur = order[next] || {};
    this._push(out, this._sys('第 ' + round + ' 轮 · 轮到 ' + (cur.name || '—') +
      (cur.totalSlots > 1 ? ('（第 ' + cur.slot + '/' + cur.totalSlots + ' 次行动）') : '')));
    /* v2.0.0：轮次强提醒 —— 供界面弹窗 / 响铃（与检定用的 EVT.CHECK 分开）。
       roundChanged 让界面区分「新回合」与「换人」，决定提醒的强度。 */
    this._push(out, this.emit(EVT.TURN_ALERT, {
      kind: 'turn', round: round, turn: next,
      name: cur.name || '', seat: cur.seat || '',
      roundChanged: (round !== prevRound), at: this.now()
    }, VIS.PUBLIC));
    return out;
  };

  /**
   * v2.1.5（用户第 2 项）：**回合边界结算**（下一回合按钮触发）。
   *
   *   ① 重置本回合每人的 SAN 损失累计 —— 不定性疯狂的阈值是「一回合内累计损失」，
   *      新回合开始要清零（回合开始 SAN 也随之重记）。
   *      ⚠️ v2.4.0（用户第 ⑤ 项）：该重置已上移到 `emit()` 的 EVT.ROUND 统一出口
   *      （nextTurn 与 round.next 两条路径都覆盖，旧实现漏了 round.next），这里不再重复。
   *   ② 重伤 / 濒死成员每轮做一次 CON 体质检定（规则书自动，无需玩家操作）：
   *       濒死 CON 失败 → 死亡；重伤 CON 失败 → 昏迷（恶化）。
   */
  Host.prototype._onRoundBoundary = function () {
    var out = [];
    var self = this;
    var rules = this.rules;

    this.roster.players().forEach(function (m) {
      if (!m.sheet || !m.sheet.status) return;
      /* v2.8.0（HP 机制 · 用户第 2 项）：规则书口径 —— **只有「濒死」每轮结束做 CON 检定**
         （失败 → 死亡）。「重伤」的 CON 检定是**一次性**的（受伤瞬间，见 settleWounds），
         不再每轮重掷（旧实现把重伤也纳入，等于重复惩罚）。
         v2.10.0（R5）：判据改读 dying 标记（body 白名单收敛为 4 值，「濒死」升为标记）。 */
      if (!m.sheet.status.dying) return;
      var con = memberAttr(m, 'con');
      var chk = (rules && typeof rules.dyingRoundCheck === 'function')
        ? rules.dyingRoundCheck(con == null ? 50 : con, self.rng) : null;
      if (!chk) return;
      out = out.concat(self.diceRoll(m.seat, {
        expr: '1D100', label: '濒死 CON 检定（对 ' + chk.check.base + '）', result: chk.check
      }));
      if (chk.dead) {
        /* v2.10.0（R5）：死亡补丁同时清 dying 标记（视图优先级：死亡 > dying）。 */
        out = out.concat(self.stateApply(m.seat, { status: { body: '死亡', dying: false } },
          { reason: '濒死 CON 检定失败 → 死亡' }));
        out = out.concat(self._syncBodyToCombatSlot(m));
        self._push(out, self.emit(EVT.LOG, {
          seat: '', text: self._nick(m, m.seat) + ' 濒死 CON 检定失败 —— 死亡，撕卡',
          at: self.now(), kind: 'warn'
        }, VIS.PUBLIC));
      } else {
        self._push(out, self.emit(EVT.LOG, {
          seat: '', text: self._nick(m, m.seat) + ' 濒死 CON 检定：' + chk.summary,
          at: self.now(), kind: 'state'
        }, VIS.PUBLIC));
      }
    });
    return out;
  };

  /**
   * v2.8.0（HP 机制 · 用户第 4 项）：**统一回合出口**（nextTurn 与 round.next 共用）。
   *
   *   ① 发显式回合边界事件 EVT.ROUND；
   *   ② 濒死每轮 CON 检定（`_onRoundBoundary`）—— 战斗态与探索态都生效；
   *   ③ 天/周恢复判定（`_onDayWeekTick`）。
   *
   * ⚠️ 为什么不把它塞进 `emit()` 的 `EVT.ROUND` 分支：`emit()` 只返回**单条事件记录**，
   *    无法携带「发送计划」；而 ②③ 会产生新的 DICE / STATE / LOG 事件，必须经 `_push`
   *    进入计划，否则事件写进了日志却发不到玩家端（客户端永远收不到）。
   *    故「唯一出口」的正确落点是一个被两条回合推进路径共用的方法（room.start 的首个
   *    回合边界是「开局」、非「时间流逝」，故意不走这里）。
   */
  Host.prototype._advanceRound = function (out, round) {
    this._push(out, this.emit(EVT.ROUND, { round: round }, VIS.PUBLIC));
    out = out.concat(this._onRoundBoundary());
    out = out.concat(this._onDayWeekTick());
    /* v2.9.0（用户第 1 项）：回合真正推进 → 广播「临时卡生效」，各玩家客户端自行落库。
       ⚠️ 必须放在 `_onDayWeekTick()` **之后** —— 天/周恢复会经 EVT.STATE 改动临时卡
       （重伤每周回血），先发会让玩家把「恢复前」的旧值覆盖回原卡。
       挂在这里（而非 nextTurn 的无条件处）→ 天然覆盖两条路径：
         · 探索态 `round.next` / `rollback.round`（每次推进都走这里）；
         · 战斗态 `combat.next`（仅整轮折返、round 变化时才走到这里）。
       开局 `room.start` 直接 emit EVT.ROUND、**不走本方法**，故不会误触发。
       ⚠️ 必须 `_push` 进计划才会广播（`emit` 只返回单条记录；只 emit 不入 plan = 玩家收不到）。 */
    this._push(out, this.emit(EVT.TEMP_COMMIT, { round: round, at: this.now() }, VIS.PUBLIC));
    return out;
  };

  /**
   * v2.8.0（HP 机制 · 用户第 4 项）：**天 / 周恢复判定**（挂在统一回合出口）。
   *
   *   时间口径（用户明确要求）：**1 回合 = 1 天；3 回合 = 1 周**。
   *   · 未受重伤（正常 / 轻伤）：每推进 1 回合 **+1 HP**（上限 maxHP）。战斗态也生效。
   *   · 重伤：**不**每日恢复；每推进 3 回合（每周）做一次 CON 检定：
   *       成功 → +1D3 HP；**极难成功** → +2D3 HP 且清除重伤；失败 → 无恢复。
   *   · 濒死 / 昏迷 / 死亡 / 未登记 HP：不恢复。
   *
   *   「距上次周检定的回合数」记在 `state.meta.hpWeek`（`{seat: 上次周检定的回合号}`）——
   *   随快照 / 存档携带（`save` / `adoptSave` 整体 clone `meta`）。回退后若基准晚于当前
   *   回合（快照回滚）则重新计时。
   *
   *   ⚠️ `madness.advance`（「推进 1 轮」）**不** emit ROUND，**绝不**触发本判定。
   */
  Host.prototype._onDayWeekTick = function () {
    var out = [];
    var self = this;
    var rules = this.rules;
    if (!this.state.meta.hpWeek || typeof this.state.meta.hpWeek !== 'object') this.state.meta.hpWeek = {};
    var week = this.state.meta.hpWeek;
    var round = this.state.meta.round || 0;
    this.roster.players().forEach(function (m) {
      if (!m.sheet || !m.sheet.status) return;
      var st = m.sheet.status;
      var body = st.body || '正常';
      /* v2.10.0（R5）：不恢复判据 = 死亡 / 濒死(dying) / 昏迷(unconscious)（视图口径）。 */
      if (body === '死亡' || st.dying || st.unconscious) { delete week[m.seat]; return; }
      var maxHP = memberStatusValue(m, 'maxHP');
      var hp = memberStatusValue(m, 'currentHP');
      if (maxHP == null || !(maxHP > 0) || hp == null) { delete week[m.seat]; return; }
      if (body === '重伤') {
        var base = week[m.seat];
        if (base == null || base > round) { week[m.seat] = round; return; }   /* 基准确立 / 回退后重新计时 */
        if (round - base < 3) return;                                        /* 未满 1 周（3 回合） */
        week[m.seat] = round;                                                /* 本次已检定 → 重置基准 */
        var con = memberAttr(m, 'con');
        var chk = (rules && typeof rules.check === 'function')
          ? rules.check({ base: con == null ? 50 : con, difficulty: 'regular', kind: 'attribute',
                          label: '重伤每周 CON 检定', rng: self.rng }) : null;
        if (!chk) return;
        out = out.concat(self.diceRoll(m.seat, {
          expr: '1D100', label: '重伤每周 CON 检定（对 ' + chk.base + '）', result: chk
        }));
        if (!chk.passed) {
          self._push(out, self.emit(EVT.LOG, {
            seat: '', text: self._nick(m, m.seat) + ' 重伤每周 CON 检定失败（掷 ' + chk.value +
              '），本周没有恢复', at: self.now(), kind: 'state'
          }, VIS.PUBLIC));
          return;
        }
        var isExtreme = !!(rules && rules.LEVEL &&
          (chk.level === rules.LEVEL.EXTREME || chk.level === rules.LEVEL.CRITICAL));
        var expr = isExtreme ? '2D3' : '1D3';
        var rr = (typeof rules.rollExpr === 'function') ? rules.rollExpr(expr, self.rng) : null;
        var healAmt = (rr && rr.ok) ? Math.max(0, num(rr.total, 0)) : 0;
        if (healAmt > 0) {
          out = out.concat(self.applyHpChange(m, healAmt,
            '重伤每周 CON ' + (isExtreme ? '极难成功' : '成功') + '恢复 ' + healAmt));
        }
        if (isExtreme) {
          var hAfter = memberStatusValue(m, 'currentHP');
          var clearBody = (hAfter != null && maxHP > 0 && hAfter >= maxHP) ? '正常' : '轻伤';
          out = out.concat(self.stateApply(m.seat, { status: { body: clearBody } },
            { reason: '重伤每周 CON 极难成功 → 清除重伤' }));
          out = out.concat(self._syncBodyToCombatSlot(m));
        }
        self._push(out, self.emit(EVT.LOG, {
          seat: '', text: self._nick(m, m.seat) + ' 重伤每周 CON 检定' +
            (isExtreme ? '极难成功' : '成功') + '（掷 ' + chk.value + '），恢复 ' + healAmt + ' 点生命',
          at: self.now(), kind: 'state'
        }, VIS.PUBLIC));
        return;
      }
      /* 未受重伤（正常 / 轻伤）：每回合 +1 HP（上限 maxHP）。 */
      if (hp < maxHP) {
        out = out.concat(self.applyHpChange(m, 1, '自然恢复（每日 +1 HP）'));
      }
    });
    return out;
  };


  /* ============================================================
   * v2.0.0 —— 权威取值 / 状态回写 / 对抗检定 / 场景检定 / 存档
   * ============================================================ */

  /**
   * 权威取值：从角色卡 sheet 里按技能/属性名取目标值（契约 §4.2 / §6.1）。
   * 优先规则服务的 `skillValue` / `attrValue`；查不到返回 fallback
   * （fallback 传 null 时返回 null，表示「确实查不到」）。
   */
  Host.prototype._skillBaseOf = function (mem, name, fallback) {
    var sheet = mem && mem.sheet;
    var rules = this.rules;
    var nm = cleanText(name, 40);
    if (sheet && nm && rules) {
      if (typeof rules.skillValue === 'function') {
        var v = rules.skillValue(sheet, nm);
        if (v !== null && v !== undefined && isFinite(Number(v))) return Number(v);
      }
      if (typeof rules.attrValue === 'function') {
        var a = rules.attrValue(sheet, nm);
        if (a !== null && a !== undefined && isFinite(Number(a))) return Number(a);
      }
    }
    if (fallback === null || fallback === undefined) return null;
    return num(fallback, 0);
  };

  /**
   * 解析「对抗检定的一方」——可以是房间座位（玩家），也可以是战斗单位 id（NPC/怪物）。
   * 返回 {name, value}。
   *
   * v2.2.1（用户第 2 项·2a）修复：UI（`genericOpposedSheet`）为了在一个下拉里同时容纳
   * 玩家与怪物，曾把复合值 `'p:<seat>'` / `'a:<actorId>'` 直接塞进 aSeat/bSeat，
   * 而这里只会把它当「座位字符串」原样查 roster → 查不到 → 名字退化成 `p:s1·格斗`
   * / `a:m1·觉察`（内部 id 泄漏到公共记录）。现在统一在入口**剥掉类型前缀**并按
   * 语义分派：`p:` → 座位（玩家），`a:` → 战斗单位 id（怪物/NPC）；无前缀则两者都试。
   * 名字一律走 `_unitName` 的退化顺序（角色名 → 昵称 → 「未知单位」），绝不把 id 当名字。
   */
  Host.prototype._resolveActorSkill = function (ref, skillName, fallback) {
    var name = cleanText(skillName, 30) || '技能';
    var raw = cleanText(ref, 64);
    /* v2.4.0（用户第 ④ 项）：所有返回统一带 ok 标记；调用方（checkOpposed）据 reason 明确报错。 */
    if (!raw) return { ok: false, name: '未知单位·' + name, reason: '未指定对抗单位' };
    /* 剥掉 UI 复合前缀：'p:' 玩家座位 / 'a:' 战斗单位；hint 记录强制语义。 */
    var hint = '';
    if (raw.slice(0, 2) === 'p:') { hint = 'pc'; raw = raw.slice(2); }
    else if (raw.slice(0, 2) === 'a:') { hint = 'actor'; raw = raw.slice(2); }
    /* v2.5.0（用户第 5 项）：前缀解析放宽 —— UI 里怪物复合值还可能是 'mo:'（monster）
       或干脆不带前缀；只要能按 id 定位到单位就认，不要因为前缀不认识就报「找不到」。 */
    else if (raw.slice(0, 3) === 'mo:') { hint = 'actor'; raw = raw.slice(3); }
    /* ① 玩家座位（hint 允许 pc / 未指定时都试） */
    if (hint !== 'actor') {
      var m = this.roster.get(raw);
      if (m) {
        /* v2.7.0（第 3 项 · 模型守卫）：玩家侧若已撕卡（死亡 / 永久疯狂）→ 拒绝通用对抗结算。
           （攻击对抗分支早已有 memberRipped 守卫，此处补齐「通用对抗」这条经
           _resolveActorSkill 的路径 —— 返回 ok:false，调用方 checkOpposed 会明确报错。） */
        if (memberRipped(m)) {
          return { ok: false, name: this._unitName(m) + '·' + name,
                   reason: '目标「' + this._nick(m, raw) + '」已撕卡（死亡/永久疯狂）' };
        }
        /* 玩家侧：仍从人物卡读（查不到时用 KP 手输兜底值，语义不变）。 */
        var v = this._skillBaseOf(m, name, fallback === undefined ? null : fallback);
        return { ok: true, name: this._unitName(m) + '·' + name, value: num(v, num(fallback, 0)) };
      }
    }
    /* ② 战斗单位 / 开战前候选池单位（hint 允许 actor / 未指定时都试）
       v2.5.0（用户第 5 项）：探索态下 combat.order 还是空的，但 KP 已经把怪物加进了
       「候选池」host.localActors —— 必须一并查，否则直接落到下面的「找不到对抗单位」
       （旧实现只查 combat.order，这就是「乙方无效，找不到对抗单位」的根因）。 */
    if (hint !== 'pc') {
      var slot = this._findActorSlot(raw);
      if (slot) {
        var val = (slot.skills && slot.skills[name] !== undefined) ? slot.skills[name]
          : (slot.stats && slot.stats.skills ? slot.stats.skills[name] : undefined);
        if (val === undefined) val = slot[name];
        /* v2.4.0（用户第 ④ 项）：战斗单位（NPC/怪物/无卡单位）没有该属性/技能时，
           优先用 KP 在发起弹层手输的 1–100 检定值（fallback）参与结算；
           · 手输了值但非法（非 1–100 整数，如 42.5 / 101）→ **明确报错**（不静默按 0/截断）；
           · 完全没手输（fallback 缺省）→ 保持旧兜底（0）—— 兼容旧调用方
             （UI 已对该类单位强制要求手输，静默 0 路径从 UI 不可达）。 */
        if (val === undefined || val === null || !isFinite(Number(val))) {
          var fv2 = num(fallback, NaN);
          var hasManual = !(fallback === undefined || fallback === null ||
                            fallback === '' || !isFinite(Number(fallback)));
          if (hasManual && !(fv2 >= 1 && fv2 <= 100 && Math.floor(fv2) === fv2)) {
            return { ok: false, name: (cleanText(slot.name, 40) || '未知单位') + '·' + name,
                     reason: '「' + (cleanText(slot.name, 40) || '未知单位') +
                       '」的对抗值需为 1–100 的整数（怪物无人物卡，请 KP 手输）' };
          }
          if (fv2 >= 1 && fv2 <= 100 && Math.floor(fv2) === fv2) {
            return { ok: true, name: (cleanText(slot.name, 40) || '未知单位') + '·' + name, value: fv2 };
          }
        }
        return { ok: true, name: (cleanText(slot.name, 40) || '未知单位') + '·' + name,
                 value: num(val, num(fallback, 0)) };
      }
    }
    /* v2.4.0（用户第 ④ 项）：单位不存在（既不是玩家也不是战斗单位）→ 明确报错 */
    return { ok: false, name: '未知单位·' + name,
             reason: '找不到对抗单位「' + raw + '」（不在成员表也不在战斗列表）' };
  };

  /**
   * v2.5.0（用户第 5 项）：按 id 定位一个「战斗单位 / 开战前候选池单位」。
   *   ① 先查 combat.order（开战后）—— actorId / id / uid 三种键都认；
   *   ② 再查 host.localActors（探索态候选池）—— 让「还没开战就选怪」也能结算。
   * @param {string} raw 已剥掉前缀的单位 id
   * @returns {object|null} 槽（候选池单位会包成一个槽形对象）
   */
  Host.prototype._findActorSlot = function (raw) {
    var q = cleanText(raw, 64);
    if (!q) return null;
    var c = this.state.combat;
    if (c && Array.isArray(c.order)) {
      for (var i = 0; i < c.order.length; i++) {
        var s = c.order[i];
        if (!s) continue;
        if (s.actorId === q || s.id === q || s.uid === q) return s;
      }
    }
    if (Array.isArray(this.localActors)) {
      for (var j = 0; j < this.localActors.length; j++) {
        var a = this.localActors[j];
        if (!a) continue;
        if (a.id === q || a.actorId === q || a.uid === q) {
          /* 候选池单位没有 skills 表：包成槽形对象，技能值一律走 KP 手输（fallback） */
          return { actorId: a.id, id: a.id, name: a.name, kind: a.kind, skills: null };
        }
      }
    }
    return null;
  };

  /**
   * v2.5.0（用户第 5 项）：整体替换「开战前候选池」（op=`combat.pool.set`）。
   *   纯权威端本地状态，**不产生任何事件**（它不是游戏事件），但要落存档 ——
   *   否则断线重连后探索态的怪物全丢了。
   * @param {object} p { actors: [{ id, name, kind, dex, hp, hpMax, actionsPerRound }] }
   * @returns {Array} 事件计划（恒为空数组）
   */
  Host.prototype.setActorPool = function (p) {
    var list = Array.isArray(p && p.actors) ? p.actors : [];
    var seen = {};
    var next = [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a || !a.id || seen[a.id]) continue;
      if (a.kind !== 'monster' && a.kind !== 'npc') continue;
      seen[a.id] = 1;
      var hp = num(a.hp, 0);
      next.push({
        id: cleanText(a.id, 40), name: cleanText(a.name, 24) || '单位', kind: a.kind,
        dex: num(a.dex, 0), hp: hp, hpMax: num(a.hpMax, hp),
        actionsPerRound: clampNumber(a.actionsPerRound, 1, 10, 1)
      });
    }
    this.localActors = next;
    return [];
  };

  /**
   * v2.5.0（用户第 5 项）：往候选池追加一个单位（同 id 视为已存在，不再重复加）。
   * @param {object} actor { id, name, kind, dex, hp, hpMax, actionsPerRound }
   * @returns {boolean} 是否真的加进去了
   */
  Host.prototype.addLocalActor = function (actor) {
    if (!actor || !actor.id) return false;
    if (actor.kind !== 'monster' && actor.kind !== 'npc') return false;
    for (var i = 0; i < this.localActors.length; i++) {
      if (this.localActors[i].id === actor.id) return false;
    }
    this.localActors.push(actor);
    return true;
  };

  /**
   * 统一「单位显示名」的退化顺序（v2.2.1 用户第 2 项·2a）：
   *   ① 角色名（charName） → ② 昵称（nickname） → ③ 兜底「未知单位」。
   * 用途：对抗记录 / 公共日志里展示「是谁」，**任何情况下都不得把
   * seat / actorId 当名字**展示。KP 座位无成员时额外退到 meta.kpName。
   */
  Host.prototype._unitName = function (m, seat) {
    if (m) {
      var cn = cleanText(m.charName, 40);
      if (cn) return cn;
      var nn = cleanText(m.nickname, 40);
      if (nn) return nn;
    }
    if (seat === HOST_SEAT) return (this.state.meta && this.state.meta.kpName) || 'KP';
    return '未知单位';
  };

  /** 玩家回执「我已把状态写入本机角色卡」：只记账，静默（不占公共序号）。 */
  Host.prototype.stateSyncAck = function (seat, p) {
    var m = this.roster.get(seat);
    if (m) m.stateAckSeq = num(p && p.seq, 0);
    return [];
  };

  /**
   * 角色卡状态写回（v2.0.0）：
   *   ① 更新房间成员表（runtime 公开广播 + sheet 本人/KP 全量）
   *   ② 单发给该玩家一条 EVT.STATE（带单调 seq）—— 玩家据此更新本机角色卡，
   *      并按 seq 做**幂等**（同一 seq 应用两次只扣一次血）。
   *
   * @param {string} targetSeat
   * @param {object} change {status:{...}, madness:[], mental:[], sanLoss}
   * @param {object} opts   {reason}
   */
  Host.prototype.stateApply = function (targetSeat, change, opts) {
    var out = [];
    var m = this.roster.get(targetSeat);
    if (!m) { this._push(out, this._sysTo(HOST_SEAT, '找不到该玩家，无法写回状态')); return out; }
    change = change || {};
    opts = opts || {};
    if (!m.runtime) m.runtime = {};
    if (!m.sheet) m.sheet = sanitizeSheet({}, m);
    if (!m.sheet.status) m.sheet.status = sanitizeStatus({}, m.sheet);
    /* v2.1.0 #11：老成员的 sheet 可能还没有这两个字段，先补齐（否则追加逻辑读不到） */
    if (!Array.isArray(m.sheet.tempStatus)) m.sheet.tempStatus = [];
    if (!Array.isArray(m.sheet.items)) m.sheet.items = [];

    var st = change.status || {};
    /* ⚠️ 下列上限字段以前只判 `!== undefined` —— null 会漏进来并被 clamp 成 0
       （上界 0 = 非法，会把 SAN/HP 上限清零）。统一补上 `!== null` 守卫。
       v2.6.0（用户第 6 项）：上限字段**提前到现值之前**写 —— 现值要以「本次写后的
       上限」为上界 clamp（见下）。 */
    if (st.maxHP !== undefined && st.maxHP !== null) m.sheet.status.maxHP = clampNumber(st.maxHP, 0, 9999, m.sheet.status.maxHP);
    if (st.maxMP !== undefined && st.maxMP !== null) m.sheet.status.maxMP = clampNumber(st.maxMP, 0, 9999, m.sheet.status.maxMP);
    if (st.maxSAN !== undefined && st.maxSAN !== null) m.sheet.status.maxSAN = clampNumber(st.maxSAN, 0, 999, m.sheet.status.maxSAN);
    /* v2.6.0（用户第 6 项）：当前 HP/SAN 的**上限 = 角色上限 maxHP/maxSAN**
       （不再是固定 9999/999）。⚠️ clampToMax 内含 `max > 0` 守卫：上限为 0 / 缺失
       （还没登记）时**不夹**，避免把正常角色清零。下界仍为 0。
       ↑ MP 仍沿用固定上界（本次需求只收口 HP / SAN，避免误伤既有 MP 行为）。 */
    if (st.currentHP !== undefined && st.currentHP !== null) {
      m.runtime.hp = clampToMax(clampNumber(st.currentHP, 0, 9999, m.runtime.hp), m.sheet.status.maxHP);
      m.sheet.status.currentHP = m.runtime.hp;
    }
    if (st.currentMP !== undefined && st.currentMP !== null) {
      m.runtime.mp = clampNumber(st.currentMP, 0, 9999, m.runtime.mp);
      m.sheet.status.currentMP = m.runtime.mp;
    }
    if (st.currentSAN !== undefined && st.currentSAN !== null) {
      m.runtime.san = clampToMax(clampNumber(st.currentSAN, 0, 999, m.runtime.san), m.sheet.status.maxSAN);
      m.sheet.status.currentSAN = m.runtime.san;
    }
    if (st.currentLuck !== undefined && st.currentLuck !== null) m.sheet.status.currentLuck = clampNumber(st.currentLuck, 0, 999, m.sheet.status.currentLuck);
    /* v2.1.5（用户第 2/4 项）：身体状态（单选白名单）。「死亡」= 撕卡。 */
    if (st.body !== undefined && st.body !== null && st.body !== '') {
      var b = cleanText(st.body, 8);
      if (BODY_OK[b]) m.sheet.status.body = b;
    }
    /* v2.10.0（用户第 R5 项）：昏迷 / 濒死 = 独立布尔标记，与 body 一并整包写回。
       ⚠️ false 也要写（显式解除：治愈 / 唤醒 / 脱离濒死）；undefined / null / '' 不动
       （调用方没提这个键 = 不改变该项）—— deriveBodyFromHp 的「undefined = 不动」
       语义全靠这条分流兑现。 */
    if (st.dying !== undefined && st.dying !== null && st.dying !== '') m.sheet.status.dying = !!st.dying;
    if (st.unconscious !== undefined && st.unconscious !== null && st.unconscious !== '') m.sheet.status.unconscious = !!st.unconscious;
    if (Array.isArray(change.madness)) m.sheet.madness = sanitizeSheet({ madness: change.madness }, m).madness;
    if (Array.isArray(change.mental)) m.sheet.mental = sanitizeSheet({ mental: change.mental }, m).mental;
    if (change.sanLoss !== undefined && change.sanLoss !== null) m.sheet.sanLoss = clampNumber(change.sanLoss, 0, 99, m.sheet.sanLoss);
    /* v2.1.0 #11：临时状态 / 物品道具 —— **整体替换**（调用方先读出旧数组、追加、再传全量）。
       走 sanitizeSheet 过一遍白名单，保证与 INTENT.CHAR 上报后的形状完全一致。 */
    if (Array.isArray(change.tempStatus)) {
      m.sheet.tempStatus = sanitizeSheet({ tempStatus: change.tempStatus }, m).tempStatus;
    }
    if (Array.isArray(change.items)) {
      m.sheet.items = sanitizeSheet({ items: change.items }, m).items;
    }
    /* v2.3.0（用户第 10 项）：武器清单写回（武器「已损坏」标记 broken 随 EVT.STATE 落到角色卡）。 */
    if (Array.isArray(change.weapons)) {
      m.sheet.weapons = sanitizeSheet({ weapons: change.weapons }, m).weapons;
    }

    this._stateSeq += 1;
    var payload = {
      seq: this._stateSeq, seat: targetSeat, charId: m.charId || null,
      status: clone(m.sheet.status),
      madness: clone(m.sheet.madness),
      mental: clone(m.sheet.mental),
      sanLoss: m.sheet.sanLoss,
      /* v2.1.0 #11：随 EVT.STATE 一并下发给本人（room-net 落到临时卡 / 本机卡） */
      tempStatus: clone(m.sheet.tempStatus),
      items: clone(m.sheet.items),
      /* v2.3.0（用户第 10 项）：武器清单（含 broken 标记）随状态写回下发。 */
      weapons: Array.isArray(m.sheet.weapons) ? clone(m.sheet.weapons) : [],
      reason: cleanText(opts.reason, 80),
      at: this.now()
    };
    /* 本人单发（别人拿不到，也不需要拿） */
    this._push(out, this.emit(EVT.STATE, payload, VIS.SEAT, targetSeat));
    /* 成员表：runtime/sheet 更新，所有人看到公开部分 */
    out = out.concat(this.syncMembers());
    if (opts.reason) {
      this._push(out, this.emit(EVT.LOG, {
        seat: '', text: this._nick(m, targetSeat) + ' 状态变化（' + cleanText(opts.reason, 80) + '）',
        at: this.now(), kind: 'state'
      }, VIS.PUBLIC));
    }
    return out;
  };

  /* ============================================================
   * v2.1.0 #11 —— KP 定向指令（对指定玩家直接推送，无需玩家同意）
   *
   * 「KP 没有角色参与到游戏」：这些按钮给玩家一个变化，不是 KP 自己检定。
   * 通道：stateApply（EVT.STATE 单发本人 + 成员表裁剪）与 EVT.PRIVATE（暗骰）。
   * 冻结接口：op = dice.dark / sheet.damage / sheet.sancheck / sheet.tempstatus / sheet.item。
   * ============================================================ */

  /**
   * 读一个成员当前的 HP/MP/SAN 现值。**优先 sheet.status（权威现值）**，其次 runtime，
   * 最后顶层 sheet 兜底 —— 与界面层 memberStats 的兜底顺序一致。
   * @returns {number|null}
   */
  function memberStatusValue(m, key) {
    if (!m) return null;
    var map = { currentHP: 'hp', currentMP: 'mp', currentSAN: 'san' };
    var sh = m.sheet || {};
    var st = sh.status || {};
    if (st[key] !== undefined && st[key] !== null && isFinite(Number(st[key]))) return Number(st[key]);
    var rt = m.runtime || {};
    var rk = map[key];
    if (rk && rt[rk] !== undefined && rt[rk] !== null && isFinite(Number(rt[rk]))) return Number(rt[rk]);
    if (sh[rk] !== undefined && sh[rk] !== null && isFinite(Number(sh[rk]))) return Number(sh[rk]);
    return null;
  }

  /** 读成员的九项属性之一（如 'con' / 'int'）。取不到返回 null。 */
  function memberAttr(m, key) {
    var a = m && m.sheet && m.sheet.attrs;
    if (!a) return null;
    var v = a[key];
    if (v === undefined || v === null || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  /**
   * v2.7.0（用户第 2 项）：一条疯狂症状是否来自**角色背景**（恐惧症 / 狂躁症）。
   *   判据：带 bg 标记，或（兼容老数据）permanent 且没有 from
   *   —— 游戏内产生的条目（临时 / 不定疯狂）必带 from，故「permanent && !from」即背景。
   * @param {object} x madness 条目
   * @returns {boolean}
   */
  function isBgSymptom(x) {
    if (!x) return false;
    return x.bg === true || (x.permanent === true && !x.from);
  }

  /**
   * v2.7.0（用户第 2 项）：这组症状是否**全部**来自背景（= 该角色「只有背景症状」）。
   *   采用**每一条都是背景条目**的严格判据（而不是「不存在游戏内条目」）——
   *   老卡里可能存在「非永久、又没有 from」的来源不明条目（例如手工写入的临时症状），
   *   按宽松判据会被误当成背景症状，进而错误剔除玩家真实的临时 / 不定疯狂标签。
   *   只要混进任何一条非背景条目，就返回 false、不做归一。
   * @param {Array} list madness 数组
   * @returns {boolean}
   */
  function onlyBgSymptoms(list) {
    if (!Array.isArray(list) || !list.length) return false;
    return list.every(isBgSymptom);
  }

  /**
   * 判断成员是否已「撕卡」—— 身体死亡，或永久疯狂。
   * 撕卡后该玩家只能聊天，不能再控制角色（掷骰 / 场景检定 / 战斗 / 改状态）。
   */
  function memberRipped(m) {
    if (!m || !m.sheet) return false;
    var st = m.sheet.status || {};
    if (st.body === '死亡') return true;
    var mental = m.sheet.mental || [];
    return mental.indexOf(MENTAL_PERMANENT) >= 0;
  }

  /**
   * v2.1.6（用户第 7 项）：判断成员是否处于**疯狂发作中**（临时疯狂 / 不定疯狂）。
   * 发作中只能「推进 1 轮」和申请治愈，其余操作锁死（场景检定由系统自动随机）。
   */
  function memberInBout(m) {
    if (!m || !m.sheet) return false;
    var mental = m.sheet.mental || [];
    return mental.indexOf('临时疯狂') >= 0 || mental.indexOf('不定疯狂') >= 0;
  }

  /**
   * v2.5.0（用户第 2 项）：判断成员是否处于「疯狂发作 / 发作残留」态 ——
   *   · memberInBout：临时疯狂 / 不定疯狂（正在发作，操作全锁）。
   *
   * ⚠️ 关于「不定疯狂（症状消失）」（MENTAL_INDEF_FADED）**刻意不算发作中**：
   *   v2.1.7 起这个状态的定义就是「发作症状已消退、玩家恢复操作（不再锁死），
   *   但状态本身仍需治愈」——它不是发作中。更关键的是 v2.2.2（用户第 6 项）与
   *   v2.4.0 明确规定：该状态的角色**掉 SAN 必须复发**，而「KP 定向 SAN Check」
   *   正是三条复发来源之一（tools/test_v222_fixes.js 来源②、
   *   tools/test_v240_fixes.js (d) 各有断言守着）。若把它一并拦掉，
   *   「不定疯狂复发」这条已交付的用户功能会直接失效。
   *   → 若产品确认要连它一起拦，改这一行即可（同时必须同步改上面两条断言）。
   *
   * ⚠️ 刻意**不修改 memberInBout 本身**：它同时驱动本文件 #_act 的全局操作锁
   *    （`var locked = !isHost && mem && (memberRipped(mem) || memberInBout(mem))`），
   *    放宽它会牵动一大片（连场景检定、战斗、改状态都一起解锁）。这里只新增一个
   *    语义更宽的判定，专供 KP 定向 SAN 指令使用。
   * @param {object} m 成员记录（roster 里的 member）
   * @returns {boolean}
   */
  function memberMadActive(m) {
    if (!m || !m.sheet) return false;
    return memberInBout(m);
  }

  /**
   * v2.10.0（用户第 R5 项）：身体状态**视图合成**（模块级纯函数）。
   *
   *   R5 起 body 只表「伤级」（正常/轻伤/重伤/死亡 4 值），「濒死 / 昏迷」是
   *   `status.dying` / `status.unconscious` 两个独立布尔标记（可与 body 叠加）。
   *   所有「读 body 做显示 / 判定」的地方一律改读本函数，优先级：
   *     **死亡 > dying > unconscious > body**
   *   （老卡遗留的原始 '濒死' / '昏迷' 字符串会原样透传，见 migrateBodyStatus。）
   * @param {object} st sheet.status（可空）
   * @returns {string} '死亡'|'濒死'|'昏迷'|'正常'|'轻伤'|'重伤'
   */
  function bodyView(st) {
    var b = (st && st.body) || '正常';
    if (b === '死亡') return '死亡';
    if (st && st.dying) return '濒死';
    if (st && st.unconscious) return '昏迷';
    return b;
  }

  /**
   * v2.10.0（用户第 R5 项）：按 HP 猜测伤级（**老卡迁移专用**的保守推断）。
   *   · HP ≥ 上限     → 正常；
   *   · HP ≥ 半血     → 重伤（无伤害历史可循时的保守端：昏迷者多半是重伤打晕的）；
   *   · 其余 / 取不到 → 轻伤。
   * ⚠️ 仅用于 migrateBodyStatus 迁移老卡 —— **不能**拿去推导 healWound / aidApply 的
   *    归位结果：那两处的口径是「HP ≥ 上限 → 正常，否则轻伤」（v2.8.0 F3 冻结语义），
   *    套用本函数会把「HP ≥ 半血」误判成重伤（治愈后仍重伤 = 治愈失效）。
   * @param {number} hp    当前 HP（取不到传 NaN / undefined）
   * @param {number} maxHP 上限（≤0 / 取不到 = 未知）
   * @returns {string} '正常'|'重伤'|'轻伤'
   */
  function bodyForHp(hp, maxHP) {
    if (maxHP > 0 && hp >= maxHP) return '正常';
    if (maxHP > 0 && hp * 2 >= maxHP) return '重伤';
    return '轻伤';
  }

  /**
   * v2.10.0（用户第 R5 项）：老卡身体状态**一次性迁移**（幂等）。
   *
   *   body 白名单从 6 值收敛为 4 值（'濒死'/'昏迷' 移除）后，老存档 / 老上报里的
   *   这两个取值必须翻译成新模型，否则会被 BODY_OK 过滤成 '正常' —— 伤势凭空消失：
   *     · body='濒死' → body='重伤' + dying=true；
   *     · body='昏迷' → unconscious=true + body 按 HP 归位（bodyForHp）。
   *   新模型取值（4 值 body + 布尔标记）原样返回；跑两遍不漂移（幂等）。
   * @param {object} st **原始** status（白名单收敛前的形状；原地改并返回同一引用）
   * @returns {object} 同一个 st
   */
  function migrateBodyStatus(st) {
    if (!st) return st;
    if (st.body === '濒死') {
      st.body = '重伤';
      st.dying = true;
    } else if (st.body === '昏迷') {
      st.unconscious = true;
      st.body = bodyForHp(num(pick(st.currentHP, st.hp)), num(pick(st.maxHP, st.maxHP)));
    }
    return st;
  }

  /**
   * v2.8.0（HP 机制 · 用户第 1 项）：**按 HP 变动推导身体状态**（唯一口径）。
   *
   *   `applyHpChange`（回血 amount=0）/ `settleWounds`（伤害 amount>0）/ `applyStatusJudgment`
   *   （状态管理的绝对赋值，amount=净扣减）**共用同一份**，彻底消除「用状态管理改 HP」与
   *   「被打」两套口径的漂移。
   *
   *   v2.10.0（用户第 R5 项）：返回结构扩展为 `{body, dying, unconscious, needCon}` ——
   *   body 只表「伤级」（4 值），昏迷 / 濒死由 dying / unconscious 两个布尔标记表达。
   *   **undefined = 「该项不动」**：调用方把三个键整包写进 change.status，stateApply 对
   *   undefined 跳过、对 false 显式写入 —— 同一函数由此表达「保持」与「显式解除」。
   *   prevBody 传**视图**（bodyView：死亡 > dying > unconscious > body）。
   *
   *   归一语义（#1~#7 与需求逐条对应）：
   *     #1 amount > maxHP（maxHP>0）   → {body:'死亡', dying:false, unconscious:false}（即死；阈值 `>`）；
   *     #2 amount*2 ≥ maxHP 且 after>0 → {body:'重伤', dying:false, needCon: prev 非重伤/濒死}
   *                                     （unconscious 保持改前值：重伤致昏后再受重伤仍昏迷）；
   *     #3 after ≤ 0                  → 有重伤(本次 or 改前) → {body:'重伤', dying:true}；
   *                                     否则 → {unconscious:true}（body 保持改前伤级）；
   *     #4 重伤瞬间 CON 失败          → 由调用方置 unconscious=true（原置 body='昏迷'）；
   *     #5 改前濒死 且 after>0         → dying=false；body = after*2≥maxHP ? (after≥maxHP?'正常':'轻伤') : '重伤'；
   *     #6 改前重伤 且 after ≥ 半血    → body=正常/轻伤，dying=false，unconscious 不动（唤醒靠急救/治愈）；
   *     #7 改前重伤/昏迷 且非重伤伤害   → 全保持（body/dying/unconscious 均不动）；
   *     · 其余                       → HP<上限 → 轻伤；HP≥上限 → 正常。
   * @param {string} prevBody 变动前**视图**（bodyView 合成值）
   * @param {number} amount   净扣血量（≥0；回血/不变传 0）
   * @param {number} after    变动后 HP（已 clamp ≥0）
   * @param {number} maxHP    改后有效上限（≤0 视为「上限未知」→ 只做归零分流）
   * @returns {{body:(string|undefined), dying:(boolean|undefined), unconscious:(boolean|undefined), needCon:boolean}}
   */
  function deriveBodyFromHp(prevBody, amount, after, maxHP) {
    prevBody = prevBody || '正常';
    amount = Math.max(0, num(amount, 0));
    after = Math.max(0, num(after, 0));
    maxHP = num(maxHP, 0);
    var isMajorHit = (maxHP > 0 && amount * 2 >= maxHP);
    var needCon = false;
    /* undefined = 「不动」：调用方按键整包写 change.status（stateApply 跳过 undefined）。 */
    var body;
    var dying;
    var unconscious;
    if (maxHP > 0 && amount > maxHP) {
      /* #1 即死：三键显式落位（死亡同时清零濒死 / 昏迷标记）。 */
      body = '死亡';
      dying = false;
      unconscious = false;
    } else if (after <= 0) {
      /* #3 归零分流：有重伤（本次或改前）→ 濒死；无重伤 → 昏迷（body 保持改前伤级）。
         ⚠️ 已知边界（v2.10.0（R5）· 主理人确认接受，**勿当 bug 修**）：
           prevBody 是**视图**（bodyView：死亡 > dying > unconscious > body），因此
           「重伤+昏迷」（body='重伤' + unconscious=true，视图='昏迷'）的角色再受
           **非重伤**伤害归零时，视图='昏迷' 不计入 hadMajor → 落 unconscious 保持
           （不转濒死）。这与 v2.8.0 单值模型行为一致（当时 body='昏迷' 同样不计重伤），
           属「签名冻结为 4 参」下的刻意取舍；若产品要求改，须先给 deriveBodyFromHp
           增加标记入参（走签名变更流程），并同步 tools/test_v280_fixes.js 的 #7 断言。 */
      var hadMajor = isMajorHit || prevBody === '重伤' || prevBody === '濒死';
      if (hadMajor) {
        body = '重伤';
        dying = true;
      } else {
        unconscious = true;
      }
    } else if (isMajorHit) {
      /* #2 重伤：unconscious 不动（改前昏迷 → 受重伤仍昏迷）。 */
      body = '重伤';
      dying = false;
      needCon = (prevBody !== '重伤' && prevBody !== '濒死');
    } else if (prevBody === '濒死') {
      /* #5 改前濒死 且 after>0：脱离濒死，body 按 HP 归位。 */
      dying = false;
      body = (maxHP > 0 && after * 2 >= maxHP) ? (after >= maxHP ? '正常' : '轻伤') : '重伤';
    } else if (prevBody === '重伤') {
      /* #6 改前重伤 且 after ≥ 半血 → 解除重伤；否则落 #7 全保持。 */
      if (maxHP > 0 && after * 2 >= maxHP) {
        body = (after >= maxHP) ? '正常' : '轻伤';
        dying = false;
      }
    } else if (prevBody === '昏迷') {
      /* #7 改前昏迷 且非重伤伤害 → 全保持（昏迷不降级；唤醒由急救 / 治愈负责）。 */
    } else {
      /* 其余（改前正常 / 轻伤，非重伤伤害）：HP<上限 → 轻伤；HP≥上限 → 正常。 */
      body = (maxHP > 0 && after >= maxHP) ? '正常' : '轻伤';
    }
    return { body: body, dying: dying, unconscious: unconscious, needCon: needCon };
  }

  /**
   * v2.5.0（用户第 3 项）：战斗槽是否已「倒下 / 死亡」。
   *   判据照抄 _aliveMonsters（down / state==='dead' / hp<=0），但**不区分 kind** ——
   *   PC 死了同样不该再轮到他（_aliveMonsters 只过滤 kind==='monster'）。
   *   死亡标记写在槽的 public 上：combatDamage / _opposedDamageMonster /
   *   _opposedDamagePlayer 都会打上这三个之一。
   * @param {object} slot 战斗槽
   * @returns {boolean}
   */
  function slotDown(slot) {
    if (!slot) return false;
    var pub = slot.public || {};
    if (pub.down || pub.state === 'dead') return true;
    /* ⚠️ 单看 hp<=0 会误伤：combatStart 对没填 HP 的单位会写成 `hp:0, hpMax:0`
       （见 combatStart 里 `hp: num(a.hp, 0)`），那不是「死了」而是「没登记血量」。
       所以要求**确有血量上限**（hpMax > 0）时才把 hp<=0 判为倒下。
       真正被打死的单位一定会带 pub.down=true / state='dead'（combatDamage、
       _opposedDamageMonster、_opposedDamagePlayer 都会打这两个标记之一）。 */
    if (pub.hp !== undefined && pub.hp !== null && num(pub.hpMax, 0) > 0 && num(pub.hp, 0) <= 0) return true;
    return false;
  }

  /**
   * v2.5.0（用户第 5 项）：把 UI 传来的手输检定值归一化成数字；
   *   没填 / 空串 / 非法 → undefined（undefined 才会走 _resolveActorSkill 的
   *   「未手输」分支；NaN 会被误判成「手输了一个非法值」从而报错）。
   * @param {*} v
   * @returns {number|undefined}
   */
  function normBase(v) {
    if (v === undefined || v === null || v === '') return undefined;
    var n = Number(v);
    return isFinite(n) ? n : undefined;
  }

  /* ============================================================
   * v2.2.0（用户第 3 项）：对抗相关的模块级助手
   * ============================================================ */

  /** 所有对抗记录的统一前缀（架构 §7：文案前缀固定）。 */
  var OPPOSED_PREFIX = '⚔ 对抗｜';

  /** 归一「防守方式」：counter/fightback→counter；dodge→dodge；其余 none。 */
  function normReaction(r) {
    var s = String(r === undefined || r === null ? '' : r).trim().toLowerCase();
    if (s === 'counter' || s === 'fightback' || s === '反击') return 'counter';
    if (s === 'dodge' || s === '闪避') return 'dodge';
    return 'none';
  }

  /**
   * 逐轮重掷明细文案（每行以「重掷 {n}：」开头；兜底句固定）。
   * @returns {string} 以 '；' 前缀拼接的明细（无明细时返回 ''）
   */
  function buildOpposedRerollLines(rounds, aName, bName, fallback) {
    if (!rounds || !rounds.length) return '';
    var lines = [];
    rounds.forEach(function (r) {
      var who = r.winner === 'a' ? aName : (r.winner === 'b' ? bName : '继续重掷');
      lines.push('重掷 ' + r.round + '：' + aName + ' 掷 ' + r.aRoll + ' vs ' + bName + ' 掷 ' + r.bRoll + ' → ' + who + ' 胜');
    });
    var s = '；' + lines.join('；');
    if (fallback) s += '；达到重掷上限，按规则兜底判发起方胜';
    return s;
  }

  /**
   * 把武器伤害式转成可掷的骰式：
   *   · 先剥掉 DB / 半DB 记号（伤害加值由 rollDamageBonus 单独掷，避免重复计）；
   *   · 若仍不可解析（如 '1D6+燃烧' 这类带说明文字的），退化为取**前导骰式**片段。
   * @returns {{ok:boolean, expr:string, reason:string}}
   */
  function weaponDamageExpr(dmg, rules) {
    var s = String(dmg === undefined || dmg === null ? '' : dmg).trim();
    if (!s) return { ok: false, expr: '', reason: '武器没有伤害式' };
    s = s.replace(/[+＋]?\s*半?\s*D\.?B\.?/gi, '').replace(/[+＋\-\s]+$/, '').replace(/\s+/g, '');
    var R = rules || (typeof global !== 'undefined' ? global.CocRules : null);
    function okExpr(x) { return !!(x && R && typeof R.parseExpr === 'function' && R.parseExpr(x).ok); }
    if (okExpr(s)) return { ok: true, expr: s, reason: '' };
    var m = s.match(/^(\d*[dD]\d+(?:[+-]\d+)*)/);
    if (m && okExpr(m[1])) return { ok: true, expr: m[1], reason: '' };
    return { ok: false, expr: '', reason: '武器伤害式无法解析：' + s };
  }

  /**
   * 从疯狂症状表随机掷一个「疯狂发作」症状（临时，带 1D10 轮）。
   * 权威端靠注入的 madness 提供者（默认 CocMadness）；缺失时返回 null。
   */
  function rollSymptom(madness) {
    if (madness && typeof madness.roll === 'function') {
      var m = madness.roll('any', false);
      if (m) {
        /* v2.1.7：不再强转 phobia —— 疯狂表 1D10 的 1-8 是**发作行为（bout）**，
           必须原样落到成员卡上（否则「失忆」会被记成一条不存在的恐惧症）。 */
        return { type: (MAD_TYPES[m.type] ? m.type : 'phobia'), name: m.name,
                 en: m.en || '', desc: m.desc || '',
                 permanent: false, rounds: (m.rounds != null ? m.rounds : 0) };
      }
    }
    return null;
  }

  /**
   * 归一化 SAN 损失的一侧（`成功损失` / `失败损失`）：空值给默认，其余原样返回字符串。
   * 允许数字（'6'）与骰式（'1D6'）两种写法 —— 旧调用方传的是数字，不能破。
   */
  function normLossPart(v, dflt) {
    if (v === undefined || v === null) return dflt;
    var s = String(v).trim();
    return s === '' ? dflt : s;
  }

  /**
   * v2.1.1：KP 定向指令的**目标展开** —— 把 `'*'` 展开成「全部在线玩家」。
   *
   * 为什么单列一个函数：四种指令（伤害 / SAN / 临时状态 / 物品）都要支持「全部玩家」。
   * 若各自复制一遍循环，早晚会漏掉某个边界（0 人在线要回话、目标不存在要回话、
   * 公共记录要能看出影响了几个玩家）。集中在这里只写一次，四处共用。
   *
   * ⚠️ 语义铁律：**每个目标独立结算**（尤其 SAN Check 各按自己的 SAN 判、各扣各的）。
   *   `fn(m)` 只处理**一名**成员并返回发送计划，循环在外部完成。
   * ⚠️ 未选目标（空串）**不是**「作用自己」—— KP 不参与游戏，直接回话拒绝。
   *
   * @param {string} bySeat 发起者（KP）
   * @param {string} seatSpec 目标：座位号 或 '*'
   * @param {string} what 动作名（用于提示文案，如 '施加伤害'）
   * @param {function(object):Array} fn 对单个成员执行，返回发送计划
   * @returns {Array} 发送计划
   */
  Host.prototype._forEachTarget = function (bySeat, seatSpec, what, fn) {
    var out = [];
    var spec = cleanText(seatSpec, 64);
    var self = this;
    if (spec === '*') {
      var list = this.roster.onlinePlayers();
      if (!list.length) {
        this._push(out, this._sysTo(bySeat, '房间里没有在线玩家，无法' + what));
        return out;
      }
      list.forEach(function (m) { out = out.concat(fn(m)); });
      /* 公共记录要能看出影响了几个玩家 —— 否则全员广播时看不出有没有漏人 */
      this._push(out, this._sys('「全部玩家」指令：' + what + ' → 已作用于 ' +
        list.length + ' 名在线玩家'));
      return out;
    }
    if (!spec) { this._push(out, this._sysTo(bySeat, '请先选择生效目标（不会默认作用于自己）')); return out; }
    var one = this.roster.get(spec);
    if (!one) { this._push(out, this._sysTo(bySeat, '找不到该玩家，无法' + what)); return out; }
    return out.concat(fn(one));
  };

  /**
   * 暗骰（op=`dice.dark`）：KP 掷一颗/多颗骰子，**结果只进 KP 自己**的
   * `state.privates`（收件人 HOST_SEAT）；公共记录只写一句「KP 暗骰了一次」。
   *
   * ⚠️ 刻意**不复用 `diceRoll()`** —— 后者 `emit(EVT.DICE, …, VIS.PUBLIC)` 会把
   *    结果公开，与「暗骰」语义冲突。这里自算骰面，只走 EVT.PRIVATE。
   *
   * @param {string} bySeat 发起者（应为 HOST_SEAT）
   * @param {object} p { sides, count, bonus, reason }
   */
  Host.prototype.darkRoll = function (bySeat, p) {
    var out = [];
    p = p || {};
    var count = clampNumber(p.count, 1, 20, 1);
    var sides = clampNumber(p.sides, 2, 1000, 100);
    var bonus = clampNumber(p.bonus, -999, 999, 0);
    var rolls = [];
    for (var i = 0; i < count; i++) rolls.push(1 + Math.floor(Math.random() * sides));
    var total = rolls.reduce(function (a, b) { return a + b; }, 0) + bonus;
    var expr = count + 'D' + sides + (bonus ? (bonus > 0 ? '+' + bonus : String(bonus)) : '');
    var reason = cleanText(p.reason, 60);

    /* 结果：只发给 KP 自己（VIS.SEAT → HOST_SEAT），进 KP 的 .gp-priv */
    this._push(out, this.emit(EVT.PRIVATE, {
      title: '暗骰', kind: 'dark',
      text: '🕶 ' + expr + ' = ' + total +
            (rolls.length > 1 ? ('（' + rolls.join('、') + '）') : '') +
            (reason ? ('　理由：' + reason) : ''),
      at: this.now()
    }, VIS.SEAT, HOST_SEAT));

    /* 公共记录：只有这一句，**不含**结果 / 骰面 / 理由 */
    this._push(out, this.emit(EVT.LOG, {
      seat: '', text: 'KP 暗骰了一次', at: this.now(), kind: 'dark'
    }, VIS.PUBLIC));
    return out;
  };

  /**
   * v2.1.5（用户第 2 项）：**伤害结算 + 死亡判定**（规则书自动，无需玩家操作）。
   *
   *   规则（CoC 7e）· **v2.8.0（HP 机制 · 用户口径）已修正**：
   *     · 单次伤害 **> 生命值上限** → 立即死亡（原 `≥` 改为 `>`；恰等于上限归入重伤）；
   *     · 单次伤害 **≥ 生命值一半** → 重大伤口（重伤），并**当场做一次 CON 检定**
   *       （失败 → 立即昏迷）；
   *     · HP 归零分流：**有重伤 → 濒死；无重伤 → 昏迷**（归零当刻**不再**掷 CON）；
   *     · HP 恢复/维持到 ≥ 半血 → 自动解除重伤。
   *   死亡 → body='死亡' → 撕卡（memberRipped）。
   *
   *   ⚠️ v2.8.0 起本方法**只应经 `applyHpChange`（唯一 HP 收口）调用**。
   *
   * @param {object} m 成员
   * @param {number} amount 本次伤害点数
   * @param {string} reason 来源描述
   * @param {object} base 可选显式基准 {maxHP, currentHP}（战斗槽血量优先于成员 sheet）
   * @returns {Array} 发送计划
   */
  Host.prototype.settleWounds = function (m, amount, reason, base) {
    var out = [];
    var rules = this.rules;
    var seat = m.seat;
    var who = this._nick(m, seat);
    var maxHP = memberStatusValue(m, 'maxHP');
    var curHP = memberStatusValue(m, 'currentHP');
    /* 调用方可传入显式基准（战斗槽血量优先，成员可能还没上报角色卡） */
    if (base) {
      if (base.maxHP != null && base.maxHP > 0) maxHP = base.maxHP;
      if (base.currentHP != null) curHP = base.currentHP;
    }
    if (curHP == null) curHP = maxHP;
    curHP = Math.max(0, curHP || 0);
    if (maxHP == null || !(maxHP > 0)) maxHP = curHP || 1;

    var after = Math.max(0, curHP - amount);
    var conNote = '';
    /* v2.10.0（R5）：prevBody 改读合成视图 bodyView（死亡 > dying > unconscious > body）。 */
    var prevBody = (m.sheet && m.sheet.status) ? bodyView(m.sheet.status) : '正常';
    /* v2.8.0（HP 机制 · 用户第 2 项）：身体状态判定统一走 deriveBodyFromHp（唯一口径）——
       即死(`>` 上限) / 归零分流 / 重伤(≥半血) / 解除重伤 都在那里；本处只额外负责
       「新进入重伤时掷一次避免昏迷的 CON」。
       v2.10.0（R5）：判定结果整包写 change.status（dying/unconscious；undefined = 不动）。 */
    var verdict = deriveBodyFromHp(prevBody, amount, after, maxHP);
    var body = verdict.body;
    var dying = verdict.dying;
    var unconscious = verdict.unconscious;
    if (verdict.needCon) {
      var con = memberAttr(m, 'con');
      var conChk = (rules && typeof rules.dyingRoundCheck === 'function')
        ? rules.dyingRoundCheck(con == null ? 50 : con, this.rng) : null;
      if (conChk) {
        out = out.concat(this.diceRoll(seat, {
          expr: '1D100', label: '重伤 CON 检定（避免昏迷，对 ' + conChk.check.base + '）',
          result: conChk.check
        }));
        conNote = conChk.summary;
        /* v2.10.0（R5）：重伤瞬间 CON 失败 → 置昏迷标记（原来置 body='昏迷'）。 */
        if (conChk.dead) unconscious = true;
      }
    }

    var change = { status: { currentHP: after } };
    /* v2.10.0（R5）：body / dying / unconscious 三键整包写（undefined = 不动）。 */
    if (body !== undefined) change.status.body = body;
    if (dying !== undefined) change.status.dying = dying;
    if (unconscious !== undefined) change.status.unconscious = unconscious;
    out = out.concat(this.stateApply(seat, change,
      { reason: (reason || '受到伤害') + (conNote ? ('　' + conNote) : '') }));

    /* v2.8.0（HP 机制 · 用户第 2 项）：把身体状态同步到战斗槽（供 nextTurn 跳轮）。 */
    out = out.concat(this._syncBodyToCombatSlot(m));

    /* v2.10.0（R5）：日志展示合成视图（bodyView），与界面口径一致。 */
    var viewNow = bodyView(m.sheet && m.sheet.status);
    this._push(out, this.emit(EVT.LOG, {
      seat: '', text: who + ' 受到 ' + amount + ' 点伤害，HP ' + curHP + ' → ' + after +
        (viewNow ? ('，身体状态：' + viewNow) : '') + (conNote ? ('　·　' + conNote) : ''),
      at: this.now(), kind: 'damage'
    }, VIS.PUBLIC));

    if (body === '死亡') {
      this._push(out, this.emit(EVT.LOG, {
        seat: '', text: who + ' 已死亡 —— 撕卡，该玩家只能通过聊天框交流',
        at: this.now(), kind: 'warn'
      }, VIS.PUBLIC));
    }
    return out;
  };

  /**
   * v2.8.0（HP 机制 · 用户第 1 项）：**HP 变动唯一收口** `applyHpChange(m, delta, reason, opts)`。
   *
   *   规则要求「角色 HP 变动时系统自动判定应带来的效果」——所有「对角色增减 HP」的入口
   *   都应经此：扣血委托给 `settleWounds`（死亡 / 重伤 / 归零分流都在那里），
   *   回血在此处理「濒死→重伤」「重伤恢复（≥ 半血解除）」等规则。
   *
   * @param {object} m      成员
   * @param {number} delta  变动量（正=回血，负=扣血；0 / 非数 → 不产生任何事件）
   * @param {string} reason 来源描述（进公开日志）
   * @param {object} [opts] { base:{maxHP,currentHP} 显式基准, forceBody:'...' 强制身体状态 }
   * @returns {Array} 发送计划
   */
  Host.prototype.applyHpChange = function (m, delta, reason, opts) {
    var out = [];
    if (!m) return out;
    delta = Number(delta);
    if (!isFinite(delta) || delta === 0) return out;
    /* —— 扣血：委托 settleWounds（死亡 / 重伤 / 归零分流） —— */
    if (delta < 0) {
      return this.settleWounds(m, -delta, reason, (opts && opts.base) || null);
    }
    /* —— 回血 —— */
    if (!m.sheet) m.sheet = sanitizeSheet({}, m);
    if (!m.sheet.status) m.sheet.status = sanitizeStatus({}, m.sheet);
    var maxHP = memberStatusValue(m, 'maxHP');
    var curHP = memberStatusValue(m, 'currentHP');
    if (curHP == null) curHP = 0;
    if (maxHP == null || !(maxHP > 0)) maxHP = curHP > 0 ? curHP : 0;
    var cap = (maxHP > 0) ? maxHP : (curHP + delta);
    var after = Math.min(cap, curHP + delta);
    if (after <= curHP) return out;            /* 已满 / 无可恢复 → 无事件 */
    var gain = after - curHP;
    /* v2.10.0（R5）：prevBody 改读合成视图 bodyView。 */
    var prevBody = bodyView(m.sheet.status);
    var body;
    var vDying;
    var vUnconscious;
    if (opts && opts.forceBody) {
      body = opts.forceBody;
    } else if (prevBody === '死亡') {
      body = '死亡';
    } else {
      /* v2.8.0（HP 机制 · 用户第 1 项）：回血的 body 归位统一走 deriveBodyFromHp（amount=0）
         —— 濒死→重伤、重伤恢复到 ≥ 半血→解除、昏迷保持（唤醒由急救/治愈负责）。
         v2.10.0（R5）：连同 dying/unconscious 整包写回（undefined = 不动）。 */
      var hv = deriveBodyFromHp(prevBody, 0, after, maxHP);
      body = hv.body;
      vDying = hv.dying;
      vUnconscious = hv.unconscious;
    }
    var who = this._nick(m, m.seat);
    var stPatch = { currentHP: after };
    if (body !== undefined) stPatch.body = body;
    if (vDying !== undefined) stPatch.dying = vDying;
    if (vUnconscious !== undefined) stPatch.unconscious = vUnconscious;
    out = out.concat(this.stateApply(m.seat, { status: stPatch },
      { reason: reason || '恢复生命' }));
    out = out.concat(this._syncBodyToCombatSlot(m));
    this._push(out, this.emit(EVT.LOG, {
      seat: '', text: who + ' 恢复 ' + gain + ' 点生命，HP ' + curHP + ' → ' + after +
        '，身体状态：' + bodyView(m.sheet.status), at: this.now(), kind: 'state'
    }, VIS.PUBLIC));
    return out;
  };

  /**
   * v2.8.0（HP 机制 · 用户第 2 项）：把成员的身体状态**同步到战斗槽** public.down/state/hp。
   *
   *   为什么需要它：`nextTurn` 挑人判据是 `slotDown(slot)`（只读槽），而经
   *   `state.self` / `state.request` / `sheet.damage` 变成「昏迷」的 PC 不会自动改写战斗槽
   *   → 会漏跳过。这里在**每次身体状态变化后**把「昏迷 / 濒死 / 死亡」反映为 `pub.down=true`。
   *
   *   ⚠️ 取舍：**不修改 `slotDown` 本身** —— 它是纯「只看槽」的判据，且已有
   *   `tools/test_v250_fixes.js` 的真值表把它与 UI 的 `unitDown` 逐例比对（签名不可动）。
   *   故改为「写 body 时同步该槽」，两处口径保持一致。
   * @param {object} m 成员
   * @returns {Array} 发送计划（仅在确有变化时发 EVT.ACTOR）
   */
  Host.prototype._syncBodyToCombatSlot = function (m) {
    var out = [];
    var c = this.state.combat;
    if (!c || !Array.isArray(c.order) || !c.order.length) return out;
    if (!m || !m.sheet) return out;
    for (var i = 0; i < c.order.length; i++) {
      var slot = c.order[i];
      if (!slot || slot.kind !== 'pc' || slot.seat !== m.seat) continue;
      if (this._stampSlotBody(slot, m)) {
        this._push(out, this.emit(EVT.ACTOR, { actor: slot }, VIS.PUBLIC));
      }
    }
    return out;
  };

  /**
   * v2.8.0（HP 机制 · 用户需求 B）：把成员身体状态写入**单个战斗槽**（纯写，不发事件）。
   *   供 `_syncBodyToCombatSlot`（发 ACTOR）与 `combatStart` / `combatEnqueue`
   *   （入队时同步、由随后的 COMBAT / TURNSTATE 携带）共用。
   *   v2.10.0（R5）：读取改走合成视图 bodyView（SLOT_STATE 表键仍是视图值），
   *   其余逻辑一字未动（slotDown 真值表不受影响）。
   * @returns {boolean} 是否发生变更
   */
  Host.prototype._stampSlotBody = function (slot, m) {
    if (!slot || !m || !m.sheet) return false;
    var pub = slot.public || (slot.public = {});
    /* v2.10.0（R5）：改读合成视图 bodyView（死亡 > dying > unconscious > body）。 */
    var body = bodyView(m.sheet.status);
    var hp = memberStatusValue(m, 'currentHP');
    var SLOT_STATE = { '死亡': 'dead', '濒死': 'dying', '昏迷': 'unconscious', '重伤': 'majorWound' };
    var down = (body === '死亡' || body === '濒死' || body === '昏迷') ||
               (hp != null && num(pub.hpMax, 0) > 0 && num(hp, 0) <= 0);
    var slotState = SLOT_STATE[body] || '';
    var changed = false;
    if (!!pub.down !== !!down) { pub.down = down; changed = true; }
    if (slotState && pub.state !== slotState) { pub.state = slotState; changed = true; }
    if (hp != null && num(pub.hp, NaN) !== num(hp, 0)) { pub.hp = Math.max(0, num(hp, 0)); changed = true; }
    return changed;
  };

  /**
   * v2.8.0（HP 机制 · 用户需求 B）：把当前战斗里**所有 PC 槽**按各自成员的 body 同步
   *   （纯写、不发事件）。用于 `combatStart` / `combatEnqueue` 构造槽之后 —— 使战斗前
   *   已「昏迷 / 濒死 / 死亡」的 PC 一入队就被 `slotDown` 跳过（不占行动轮）。
   * @returns {Host} this
   */
  Host.prototype._stampAllPcSlots = function () {
    var c = this.state.combat;
    if (!c || !Array.isArray(c.order)) return this;
    for (var i = 0; i < c.order.length; i++) {
      var s = c.order[i];
      if (!s || s.kind !== 'pc' || !s.seat) continue;
      var m = this.roster.get(s.seat);
      if (m) this._stampSlotBody(s, m);
    }
    return this;
  };

  /**
   * v2.8.0（HP 机制 · 用户第 2 项）：成员是否处于**昏迷**。
   *   v2.10.0（R5）：判据改读布尔标记 status.unconscious（body 白名单已收敛为 4 值）。
   *   用于全局操作锁（intent）与「战斗轮次自动跳过昏迷 PC」。
   * @param {object} m 成员
   * @returns {boolean}
   */
  Host.prototype._isUnconscious = function (m) {
    if (!m || !m.sheet || !m.sheet.status) return false;
    return !!m.sheet.status.unconscious;
  };

  /**
   * v2.10.0（用户第 R5 项 / Q6）：成员是否处于**濒死**（dying 标记）。
   *   用于全局操作锁（intent）—— 濒死玩家不可操作（只剩白名单操作）。
   * @param {object} m 成员
   * @returns {boolean}
   */
  Host.prototype._isDying = function (m) {
    if (!m || !m.sheet || !m.sheet.status) return false;
    return !!m.sheet.status.dying;
  };

  /**
   * v2.8.0（HP 机制 · 用户第 3/4 项）：**治愈伤势**（op=`sheet.healwound`）。
   *   · 结构照抄「治愈不定疯狂」`cureIndefinite`：清除目标的伤势
   *     （v2.10.0（R5）起 = body 归位 + 清 dying/unconscious 两个标记）；
   *   · KP 直接生效；玩家发起需 KP 同意（POLICY confirm:'kp'）；
   *   · 主理人口径：若目标当前 HP ≤ 0 → 置为 1（经 HP 收口，触发相应判定）；
   *     治愈后 body = HP ≥ maxHP ? '正常' : '轻伤'；
   *   · 已撕卡（死亡/永久疯狂）→ 拒绝；目标本就不在受伤三态（重伤/濒死/昏迷）→ 明确提示「无需治愈」。
   * @param {string} bySeat 发起者
   * @param {object} p { seat }
   * @returns {Array} 发送计划
   */
  Host.prototype.healWound = function (bySeat, p) {
    var out = [];
    p = p || {};
    var target = cleanText(p.seat, 64) || (bySeat === HOST_SEAT ? '' : bySeat);
    if (bySeat !== HOST_SEAT && target !== bySeat) {
      this._push(out, this._sysTo(bySeat, '只能申请治愈自己的伤势'));
      return out;
    }
    var m = this.roster.get(target);
    if (!m) { this._push(out, this._sysTo(bySeat, '找不到该玩家')); return out; }
    /* 已撕卡（死亡 / 永久疯狂）→ 拒绝，不结算（对齐 cureIndefinite）。 */
    if (memberRipped(m)) {
      this._push(out, this._sysTo(bySeat, '「' + this._nick(m, target) + '」已撕卡（死亡/永久疯狂），无法治愈'));
      return out;
    }
    if (!m.sheet) m.sheet = sanitizeSheet({}, m);
    if (!m.sheet.status) m.sheet.status = sanitizeStatus({}, m.sheet);
    var st = m.sheet.status;
    /* v2.10.0（R5）：受伤三态 = 重伤伤级 / 濒死标记 / 昏迷标记（任一即「有伤势」）；
       判据从 body 字符串（'重伤'/'濒死'/'昏迷'）改为读标记。 */
    var viewBefore = bodyView(st);
    if (st.body !== '重伤' && !st.dying && !st.unconscious) {
      this._push(out, this._sysTo(bySeat,
        '「' + this._nick(m, target) + '」当前没有需要治愈的伤势（' + viewBefore + '），无需治愈'));
      return out;
    }
    var curHP = memberStatusValue(m, 'currentHP');
    if (curHP == null) curHP = 0;
    /* HP ≤ 0 → 置为 1（经统一收口，触发相应判定）。 */
    if (curHP <= 0) {
      out = out.concat(this.applyHpChange(m, 1 - curHP, '治愈伤势：恢复至 1 点生命'));
    }
    var hpNow = memberStatusValue(m, 'currentHP');
    if (hpNow == null) hpNow = curHP > 0 ? curHP : 1;
    var maxHP = memberStatusValue(m, 'maxHP');
    var newBody = (maxHP != null && maxHP > 0 && hpNow >= maxHP) ? '正常' : '轻伤';
    /* v2.10.0（R5）：治愈补丁整包写三键 —— dying/unconscious 显式解除（false 也要写）。 */
    out = out.concat(this.stateApply(target,
      { status: { body: newBody, dying: false, unconscious: false } }, { reason: '治愈伤势' }));
    out = out.concat(this._syncBodyToCombatSlot(m));
    /* 清掉该玩家残留的「治愈伤势」待办（对齐 cureIndefinite 清 pending 的写法）。 */
    if (this.pending && this.pending.length) {
      this.pending = this.pending.filter(function (q) {
        return !(q && q.op === 'sheet.healwound' &&
                 (q.by === target || (q.p && q.p.seat === target)));
      });
    }
    var who = this._nick(m, target);
    this._push(out, this.emit(EVT.LOG, {
      seat: '', text: who + ' 的伤势（' + viewBefore + '）已被治愈（' +
        (bySeat === HOST_SEAT ? 'KP 裁定' : 'KP 同意') + '），身体状态：' + newBody,
      at: this.now(), kind: 'state'
    }, VIS.PUBLIC));
    return out;
  };

  /**
   * v2.8.0（HP 机制 · 用户第 2 项）：**队友施救**（op=`aid.apply`）—— 急救 / 医学。
   *
   *   本项目此前**没有任何「玩家 → 玩家用技能」的通路**，这是新增的第一条：
   *   · payload `{ seat: 施救者seat, targetSeat, skill: '急救'|'医学' }`；
   *   · 检定的是**施救者**的权威技能值（权威端自动 rules.check），**不是目标的 CON**；
   *   · 主理人口径：「受伤后 1 小时内」「需要 1 小时及设备」「每个伤口仅能尝试一次」
   *     等时限 / 次数限制**全部取消** —— 随时可用；
   *   · 急救成功 → 目标 +1 HP，且若目标濒死（dying）→ 稳定为「重伤」（dying=false）；
   *     医学成功 → 目标 +1D3 HP，且若目标濒死（dying）→ 脱离濒死（回到「重伤」）；
   *     目标昏迷（unconscious）→ 一并唤醒（unconscious=false，body 按 HP 归位）；
   *   · 检定失败 → 无效果 + 明确提示；
   *   · 效果经 HP 收口 applyHpChange（触发相应判定）。
   *   玩家发起需 KP 同意（POLICY confirm:'kp'）。
   * @param {string} bySeat 发起者
   * @param {object} p { seat(施救者), targetSeat, skill }
   * @returns {Array} 发送计划
   */
  Host.prototype.aidApply = function (bySeat, p) {
    var out = [];
    p = p || {};
    var healerSeat = cleanText(p.seat, 64) || bySeat;
    var targetSeat = cleanText(p.targetSeat, 64);
    var skill = cleanText(p.skill, 8);
    if (skill !== '急救' && skill !== '医学') {
      this._push(out, this._sysTo(bySeat, '施救技能只能是「急救」或「医学」'));
      return out;
    }
    if (!targetSeat) { this._push(out, this._sysTo(bySeat, '请先选择施救目标')); return out; }
    var healer = this.roster.get(healerSeat);
    var target = this.roster.get(targetSeat);
    if (!healer) { this._push(out, this._sysTo(bySeat, '找不到施救者')); return out; }
    if (!target) { this._push(out, this._sysTo(bySeat, '找不到施救目标')); return out; }
    if (memberRipped(healer)) {
      this._push(out, this._sysTo(bySeat,
        '施救者「' + this._nick(healer, healerSeat) + '」已撕卡（死亡/永久疯狂），无法施救'));
      return out;
    }
    if (memberRipped(target)) {
      this._push(out, this._sysTo(bySeat,
        '「' + this._nick(target, targetSeat) + '」已撕卡（死亡/永久疯狂），无法施救'));
      return out;
    }
    /* 权威取值：取**施救者**的技能值（不是目标的 CON）。 */
    var base = this._skillBaseOf(healer, skill, null);
    if (base == null) {
      this._push(out, this._sysTo(bySeat, '施救者还没有登记「' + skill + '」技能值（请先绑定角色卡）'));
      return out;
    }
    var rules = this.rules;
    var chk = (rules && typeof rules.check === 'function')
      ? rules.check({ base: num(base, 0), difficulty: 'regular', kind: 'skill',
                      label: skill + ' 检定', rng: this.rng }) : null;
    if (!chk) { this._push(out, this._sysTo(bySeat, '规则服务不可用，施救未结算')); return out; }
    var healerWho = this._nick(healer, healerSeat);
    var targetWho = this._nick(target, targetSeat);
    out = out.concat(this.diceRoll(healerSeat, {
      expr: '1D100', label: '施救·' + skill + ' 检定（对 ' + num(base, 0) + '）', result: chk
    }));
    if (!chk.passed) {
      /* 失败 → 无效果 + 明确提示。 */
      this._push(out, this.emit(EVT.LOG, {
        seat: healerSeat, text: healerWho + ' 对 ' + targetWho + ' 使用「' + skill + '」失败（' +
          (chk.levelText || '失败') + '），没有效果' +
          (chk.value != null ? ('（掷 ' + chk.value + '）') : ''),
        at: this.now(), kind: 'check'
      }, VIS.PUBLIC));
      return out;
    }
    /* 成功 → 计算回血量：急救 +1；医学 +1D3。
       ⚠️ 回血量经 applyHpChange 统一收口，内部已按 maxHP 钳制（var cap = maxHP>0?maxHP:...;
       after = Math.min(cap, curHP+delta)），**绝不会超过目标 maxHP**（v2.11.0 用户审查确认）。 */
    var heal;
    if (skill === '急救') {
      heal = 1;
    } else {
      var rr = (rules && typeof rules.rollExpr === 'function') ? rules.rollExpr('1D3', this.rng) : null;
      heal = (rr && rr.ok) ? Math.max(1, num(rr.total, 1)) : 1;
    }
    /* v2.10.0（R5）：改前判据改读布尔标记（dying/unconscious），不再认 body 字符串。 */
    var stBefore = (target.sheet && target.sheet.status) ? target.sheet.status : {};
    var dyingBefore = !!stBefore.dying;
    var unconsciousBefore = !!stBefore.unconscious;
    var gainNote = '，恢复 ' + heal + ' 点生命';
    out = out.concat(this.applyHpChange(target, heal, skill + '（' + healerWho + ' 施救）'));
    /* 濒死 → 稳定为「重伤」（急救 / 医学皆同：先脱离濒死）。
       v2.8.0（HP 机制 · 用户文档速查表）：**急救/医学成功亦可唤醒「昏迷」**。 */
    if (dyingBefore) {
      var bodyNow = (target.sheet && target.sheet.status) ? (target.sheet.status.body || '') : '';
      if (bodyNow !== '死亡') {
        out = out.concat(this.stateApply(targetSeat, { status: { body: '重伤', dying: false } },
          { reason: skill + ' 稳定濒死伤势' }));
        out = out.concat(this._syncBodyToCombatSlot(target));
        gainNote += '，已脱离濒死（稳定为重伤）';
      }
    } else if (unconsciousBefore) {
      /* 唤醒昏迷（v2.8.0 · F3）：HP ≤ 0 先置 1；body 归位与 healWound 同口径
         （HP ≥ maxHP → 正常，否则轻伤），并同步战斗槽让其恢复行动。
         绝不出现「醒着但 body=昏迷」或「body=正常但 HP≤0」。
         v2.10.0（R5）：唤醒补丁只清 unconscious，**不碰 dying**。 */
      var hW = memberStatusValue(target, 'currentHP');
      if (hW == null) hW = 0;
      if (hW <= 0) {
        out = out.concat(this.applyHpChange(target, 1 - hW, skill + ' 唤醒昏迷：恢复至 1 点生命'));
        hW = memberStatusValue(target, 'currentHP');
        if (hW == null) hW = 1;
      }
      var mxW = memberStatusValue(target, 'maxHP');
      var bodyW = (mxW != null && mxW > 0 && hW >= mxW) ? '正常' : '轻伤';
      out = out.concat(this.stateApply(targetSeat, { status: { body: bodyW, unconscious: false } },
        { reason: skill + ' 唤醒昏迷' }));
      out = out.concat(this._syncBodyToCombatSlot(target));
      gainNote += '，已唤醒（' + bodyW + '）';
    }
    this._push(out, this.emit(EVT.LOG, {
      seat: healerSeat, text: healerWho + ' 对 ' + targetWho + ' 使用「' + skill + '」成功' +
        gainNote + (chk.value != null ? ('（掷 ' + chk.value + '）') : ''),
      at: this.now(), kind: 'check'
    }, VIS.PUBLIC));
    return out;
  };

  /**
   * v2.11.0（用户第 3 项）：**精神分析**（op=`aid.psycho`）—— 玩家对队友做精神分析。
   *
   *   · payload `{ seat: 发起者seat, targetSeat }`；
   *   · 检定的是**发起者**的权威「精神分析」技能值（规则服务自动 rules.check）；
   *   · 成功治愈目标的精神状态：临时疯狂、**不定疯狂**（含「不定疯狂（症状消失）」）、
   *     以及**本次发作产生的疯狂症状条目**（来源 = 临时疯狂 / 不定疯狂）；
   *   · 角色卡自带的背景/永久疯狂症（from 为空）保留，不误删角色设定；
   *   · 永久疯狂角色本身已撕卡、不可作为目标；
   *   · 成功额外恢复目标 1D3 SAN（stateApply 自动按 maxSAN 收口，不超过上限）；
   *   · 失败：目标失去 1D6 SAN；若目标**已处于疯狂状态**（临时/不定/症状消失/永久或仍有疯狂症状），
   *     只损失 SAN、不再新增加疯狂症（跳过 _afterSanLoss）；否则正常扣 SAN（可能触发新疯狂）。
   *   · **冷却**：同一目标每 5 回合（KP 推进回合的 meta.round）只能接受一次精神治疗；
   *     成功结算后记录 psychoRound[target] = 当前 round；冷却中目标不可被选中（前端把关 + 此处兜底拒绝）。
   *   · 玩家发起需 KP 同意（POLICY confirm:'kp'）。
   * @param {string} bySeat 发起者
   * @param {object} p { seat(发起者), targetSeat }
   * @returns {Array} 发送计划
   */
  Host.prototype.psychoAnalyze = function (bySeat, p) {
    var out = [];
    p = p || {};
    var srcSeat = cleanText(p.seat, 64) || bySeat;
    var targetSeat = cleanText(p.targetSeat, 64);
    if (!targetSeat) { this._push(out, this._sysTo(bySeat, '请先选择精神分析目标')); return out; }
    var src = this.roster.get(srcSeat);
    var target = this.roster.get(targetSeat);
    if (!src) { this._push(out, this._sysTo(bySeat, '找不到发起者')); return out; }
    if (!target) { this._push(out, this._sysTo(bySeat, '找不到精神分析目标')); return out; }
    if (memberRipped(src)) {
      this._push(out, this._sysTo(bySeat,
        '发起者「' + this._nick(src, srcSeat) + '」已撕卡（死亡/永久疯狂），无法进行精神分析'));
      return out;
    }
    if (memberRipped(target)) {
      this._push(out, this._sysTo(bySeat,
        '「' + this._nick(target, targetSeat) + '」已撕卡（死亡/永久疯狂），无法作为精神分析目标'));
      return out;
    }
    /* 冷却兜底：同一目标每 5 回合一次。前端已拦，这里再挡一层防越权 / 回放。 */
    if (!this.state.meta.psychoRound || typeof this.state.meta.psychoRound !== 'object') {
      this.state.meta.psychoRound = {};
    }
    var curRound = this.state.meta.round || 0;
    var lastRound = this.state.meta.psychoRound[targetSeat];
    if (lastRound != null && (curRound - lastRound) < 5) {
      var left = 5 - (curRound - lastRound);
      this._push(out, this._sysTo(bySeat,
        '「' + this._nick(target, targetSeat) + '」仍处于精神治疗冷却（还需 ' + left + ' 回合）'));
      return out;
    }
    /* 「已处于疯狂状态」判定（用于失败分支是否新增疯狂症）。 */
    var _ml = (target.sheet && Array.isArray(target.sheet.mental)) ? target.sheet.mental : [];
    var alreadyMad = !!(target.sheet && target.sheet.madness && target.sheet.madness.length) ||
      _ml.indexOf('临时疯狂') >= 0 || _ml.indexOf('不定疯狂') >= 0 ||
      _ml.indexOf('不定疯狂（症状消失）') >= 0 || _ml.indexOf('永久疯狂') >= 0;
    /* 权威取值：发起者的「精神分析」技能值（角色卡没有则取基础值）。 */
    var base = this._skillBaseOf(src, '精神分析', null);
    if (base == null) {
      this._push(out, this._sysTo(bySeat, '发起者还没有登记「精神分析」技能值（请先绑定角色卡）'));
      return out;
    }
    var rules = this.rules;
    var chk = (rules && typeof rules.check === 'function')
      ? rules.check({ base: num(base, 0), difficulty: 'regular', kind: 'skill',
                      label: '精神分析 检定', rng: this.rng }) : null;
    if (!chk) { this._push(out, this._sysTo(bySeat, '规则服务不可用，精神分析未结算')); return out; }
    var srcWho = this._nick(src, srcSeat);
    var targetWho = this._nick(target, targetSeat);
    out = out.concat(this.diceRoll(srcSeat, {
      expr: '1D100', label: '精神分析 检定（对 ' + num(base, 0) + '）', result: chk
    }));
    if (!chk.passed) {
      /* 失败 → 目标失去 1D6 SAN；已疯狂则只失 SAN、不新增疯狂症。 */
      var loss = (rules && typeof rules.rollExpr === 'function') ? rules.rollExpr('1D6', this.rng) : null;
      var sanLoss = (loss && loss.ok) ? Math.max(1, num(loss.total, 1)) : 1;
      var sanBefore = memberStatusValue(target, 'currentSAN');
      if (sanBefore == null) sanBefore = memberStatusValue(target, 'maxSAN');
      if (sanBefore == null) sanBefore = 0;
      var sanAfter = Math.max(0, num(sanBefore, 0) - sanLoss);
      out = out.concat(this.stateApply(targetSeat, { status: { currentSAN: sanAfter } },
        { reason: srcWho + ' 精神分析失败：' + sanLoss + ' SAN' }));
      this._push(out, this.emit(EVT.LOG, {
        seat: srcSeat, kind: 'check',
        text: srcWho + ' 对 ' + targetWho + ' 进行精神分析失败（' + (chk.levelText || '失败') + '，掷 ' +
          (chk.value != null ? chk.value : '?') + '），' + targetWho + ' 失去 ' + sanLoss + ' 点理智' +
          '（SAN ' + sanBefore + ' → ' + sanAfter + '）' + (alreadyMad ? '，因已处于疯狂状态不新增疯狂症' : ''),
        at: this.now()
      }, VIS.PUBLIC));
      if (!alreadyMad) {
        /* 未处于疯狂 → 按规则追加（可能触发不定 / 永久疯狂）。 */
        out = out.concat(this._afterSanLoss(target, sanLoss, bySeat));
      }
      return out;
    }
    /* 成功 → 治愈临时疯狂 + 不定疯狂（含「症状消失」）+ 清除本次发作产生的疯狂症状 + 回 1D3 SAN（不超 maxSAN）。
       v2.11.1（用户追加）：治愈范围从「仅不定疯狂」扩展到「临时疯狂 + 不定疯狂 + 本次发作的疯狂症状」。
       角色卡自带的背景/永久疯狂症（from 为空）保留，不误删角色设定。 */
    var mental = (target.sheet && Array.isArray(target.sheet.mental)) ? target.sheet.mental.slice() : [];
    var md = (target.sheet && Array.isArray(target.sheet.madness)) ? target.sheet.madness.slice() : [];
    var hadTemp = mental.indexOf('临时疯狂') >= 0;
    var hadIndef = mental.indexOf(MENTAL_INDEF) >= 0 || mental.indexOf(MENTAL_INDEF_FADED) >= 0;
    /* 本次发作产生的疯狂症状（来源 = 临时疯狂 / 不定疯狂）；背景症状（permanent / 无 from）保留。 */
    var episodeFrom = { '临时疯狂': 1, '不定疯狂': 1 };
    var mdBefore = md.length;
    var mdCured = md.filter(function (x) { return !(x && episodeFrom[x.from]); });
    var curedSymptomCount = mdBefore - mdCured.length;
    var curedAny = hadTemp || hadIndef || curedSymptomCount > 0;
    var curedParts = [];
    if (hadTemp) curedParts.push('临时疯狂');
    if (hadIndef) curedParts.push('不定疯狂');
    if (curedSymptomCount > 0) curedParts.push(curedSymptomCount + ' 项疯狂症状');
    if (!curedAny) {
      this._push(out, this._sysTo(bySeat,
        '「' + targetWho + '」当前没有可治愈的精神状态（无临时/不定疯狂、无本次发作症状），精神分析未产生治愈效果（仍结算 SAN）'));
    } else {
      /* 摘除可治愈的精神状态标签。 */
      mental = mental.filter(function (x) {
        return x !== '临时疯狂' && x !== MENTAL_INDEF && x !== MENTAL_INDEF_FADED;
      });
      if (!mental.length) mental = ['正常'];
      /* 疯狂症状派生项：若已不存在任何疯狂症状条目则一并摘除（保留背景症状时仍留在面板）。 */
      if (!mdCured.length) mental = mental.filter(function (x) { return x !== MENTAL_SYMPTOM; });
      out = out.concat(this.stateApply(targetSeat, { mental: mental, madness: mdCured },
        { reason: srcWho + ' 精神分析治愈：' + curedParts.join('、') }));
    }
    /* 恢复 1D3 SAN（stateApply 自动按 maxSAN 收口，不会超过上限）。 */
    var sanNow = memberStatusValue(target, 'currentSAN');
    if (sanNow == null) sanNow = memberStatusValue(target, 'maxSAN');
    if (sanNow == null) sanNow = 0;
    var sanMax = memberStatusValue(target, 'maxSAN');
    var restore = (rules && typeof rules.rollExpr === 'function') ? rules.rollExpr('1D3', this.rng) : null;
    var gain = (restore && restore.ok) ? Math.max(1, num(restore.total, 1)) : 1;
    var sanAfter2 = (sanMax != null && sanMax > 0) ? Math.min(sanMax, num(sanNow, 0) + gain) : (num(sanNow, 0) + gain);
    var sanRecovered = (sanAfter2 > num(sanNow, 0)) ? ('，恢复 ' + (sanAfter2 - num(sanNow, 0)) + ' 点理智') : '';
    if (sanAfter2 > num(sanNow, 0)) {
      out = out.concat(this.stateApply(targetSeat, { status: { currentSAN: sanAfter2 } },
        { reason: srcWho + ' 精神分析恢复理智' }));
    }
    /* 记录冷却（成功结算后）。 */
    this.state.meta.psychoRound[targetSeat] = curRound;
    /* 治愈 = 潜在疯狂易伤清零（与 cureIndefinite 同款，避免本回合再累计复发）。 */
    this._sanLostThisRound[targetSeat] = 0;
    delete this._roundStartSan[targetSeat];
    this._push(out, this.emit(EVT.LOG, {
      seat: srcSeat, kind: 'state',
      text: srcWho + ' 对 ' + targetWho + ' 进行精神分析成功（掷 ' + (chk.value != null ? chk.value : '?') +
        '）' + (curedAny ? ('，治愈其' + curedParts.join('、')) : '') + sanRecovered + '（每 5 回合限一次）',
      at: this.now()
    }, VIS.PUBLIC));
    return out;
  };

  /**
   * v2.1.5（用户第 2/3 项）：给成员**追加一条疯狂症状**并同步精神状态。
   *
   * mentalTag 为「临时疯狂」/「不定疯狂」等精神状态标签；追加症状后会自动补上
   * 派生项「疯狂症状」。永久疯狂与正常是互斥项，这里会先踢掉它们再叠加。
   *
   * v2.2.2（用户第 6 项）：新增可选参数 `mentalOverride` —— 调用方已在外部把
   * 「不定疯狂（症状消失）」换回「不定疯狂」时，用这个数组作为精神状态基准
   * （否则 _addSymptom 会从 m.sheet.mental 读到旧的「症状消失」标签并与之并存）。
   * 不传时行为完全不变。
   */
  Host.prototype._addSymptom = function (m, symptom, mentalTag, reason, bySeat, mentalOverride) {
    var out = [];
    var seat = m.seat;
    var mdList = (m.sheet && Array.isArray(m.sheet.madness)) ? m.sheet.madness.slice() : [];
    mdList.push({
      /* v2.1.7：发作行为（bout）/狂躁/恐惧 三类都合法（见 MAD_TYPES） */
      type: MAD_TYPES[symptom.type] ? symptom.type : 'phobia',
      name: cleanText(symptom.name, 60),
      permanent: !!symptom.permanent,
      rounds: symptom.permanent ? 0 : clampNumber(symptom.rounds, 0, 99, 0),
      /* v2.1.6：来源标记（临时疯狂 / 不定疯狂发作）—— 推进轮次时区分
         「临时疯狂的症状消退 → 摘临时疯狂标签」与「不定疯狂的症状消退 → 标签保留」。 */
      from: cleanText(mentalTag, 12)
    });
    var mental = (mentalOverride && Array.isArray(mentalOverride))
      ? mentalOverride.slice()
      : ((m.sheet && Array.isArray(m.sheet.mental)) ? m.sheet.mental.slice() : []);
    mental = mental.filter(function (x) { return x !== '正常' && x !== MENTAL_PERMANENT; });
    if (mentalTag && mental.indexOf(mentalTag) < 0) mental.push(mentalTag);
    if (mental.indexOf(MENTAL_SYMPTOM) < 0) mental.push(MENTAL_SYMPTOM);
    return out.concat(this.stateApply(seat, { madness: mdList, mental: mental }, { reason: reason }));
  };

  /**
   * v2.1.5（用户第 2 项）：**SAN 损失后的自动疯狂判定**（规则书自动，无需玩家操作）。
   *
   *   ① SAN 归零 → 永久疯狂 + 撕卡（只能聊天，不能再掷骰/场景检定）；
   *   ② 单次损失 ≥ 5 → INT 检定判「是否理解」；理解（成功）→ 掷症状 + 1D10 轮；
   *   ③ 本回合累计损失 ≥ 回合开始 SAN 的 1/5 → 不定性疯狂（治愈前不消失）。
   *
   * 「一回合」由 KP 的「下一回合」按钮划定（nextTurn / round.next 时重置累计）。
   *
   * @param {object} m 成员（其 currentSAN 已是扣减后）
   * @param {number} loss 本次损失点数
   * @param {string} bySeat 回话对象
   */
  Host.prototype._afterSanLoss = function (m, loss, bySeat) {
    var out = [];
    var rules = this.rules;
    var seat = m.seat;
    var who = this._nick(m, seat);
    var san = memberStatusValue(m, 'currentSAN');
    if (san == null) san = 0;

    /* 当前精神状态 + 是否处于「不定疯狂（症状消失）」态（供下方 ②/④ 判定）。
       v2.13.13（用户最新需求）：FADED 态角色损失 SAN 只走 ④ 复发（不定疯狂 + 1 症），
       不再额外触发 ② 的「临时疯狂」路径，避免一次性获得 2 个症并叠加临时疯狂标签。 */
    var mentalNow = (m.sheet && Array.isArray(m.sheet.mental)) ? m.sheet.mental : [];
    var isFaded = mentalNow.indexOf(MENTAL_INDEF_FADED) >= 0;

    /* ① SAN 归零 → 永久疯狂 + 撕卡 */
    if (san <= 0) {
      out = out.concat(this.stateApply(seat, { mental: [MENTAL_PERMANENT] },
        { reason: 'SAN 归零 → 永久疯狂' }));
      this._push(out, this.emit(EVT.LOG, {
        seat: '', text: who + ' 的 SAN 归零，判定为永久疯狂 —— 撕卡，只能通过聊天框交流',
        at: this.now(), kind: 'warn'
      }, VIS.PUBLIC));
      return out;
    }

    /* ② 本回合累计跟踪（回合开始 SAN 记第一次损失前的值）。
       v2.4.0（用户第 ⑤ 项）：计数器改名 _sanLostThisRound；治愈不定疯狂时也会清零。 */
    var lossTotal = (this._sanLostThisRound[seat] || 0) + loss;
    this._sanLostThisRound[seat] = lossTotal;
    var roundStart = this._roundStartSan[seat];
    if (roundStart == null || !(roundStart > 0)) {
      roundStart = san + lossTotal;
      this._roundStartSan[seat] = roundStart;
    }

    /* ③ 单次损失 ≥ 5 → 临时疯狂：INT 检定判「是否理解」。
       v2.13.13：FADED（症状消失）态不受此路径影响 —— 该态损失 SAN 只走 ④ 复发，
       避免「临时疯狂 + 不定疯狂」双路径叠加出 2 个症。 */
    if (loss >= 5 && !isFaded) {
      var intVal = memberAttr(m, 'int');
      var intChk = null;
      if (rules && typeof rules.temporaryInsanityCheck === 'function') {
        intChk = rules.temporaryInsanityCheck(intVal == null ? 50 : intVal, this.rng);
      }
      if (intChk) {
        out = out.concat(this.diceRoll(seat, {
          expr: '1D100', label: '临时疯狂 INT 检定（对 ' + intChk.check.base + '）', result: intChk.check
        }));
        this._push(out, this.emit(EVT.LOG, {
          seat: '', text: who + '：' + intChk.summary, at: this.now(), kind: 'warn'
        }, VIS.PUBLIC));
        if (intChk.understood) {
          var symptom = rollSymptom(this.madness);
          if (symptom) {
            out = out.concat(this._addSymptom(m, symptom, '临时疯狂',
              '临时疯狂发作：' + symptom.name + '（持续 ' + symptom.rounds + ' 轮）', bySeat));
          } else {
            this._push(out, this.emit(EVT.LOG, {
              seat: '', text: who + '：临时疯狂发作（症状表未加载，请 KP 手动补症状）',
              at: this.now(), kind: 'warn'
            }, VIS.PUBLIC));
          }
        }
      }
    }

    /* ④ v2.4.0（用户第 ⑤ 项）：不定疯狂判定 —— **统一式**（严格按用户口径）：
         · 状态 = 「不定疯狂（症状消失）」：当前回合内损失任意数值 SAN → 再次不定疯狂
           （v2.2.2 已有行为，保留；靠 _fadedArm 武装开关实现）；
         · KP 点「进入下一回合」之后：计数器清零 + FADED 易伤 disarm → 重新按
           「本回合累计损失 ≥ ceil(maxSAN/5)」才触发不定疯狂；
         · 一旦触发进入「不定疯狂（发作中）」：本回合后续再损失任意 SAN 还会再疯
           （计数器只增不减，条件自然保持成立；_afterSanLoss 每次损失事件只判定一次）；
         · 被治愈（状态回到「正常」）之后：cureIndefinite 清零计数器 → 立刻从零
           重新按同一套判定累计（治愈把「潜在疯狂易伤」清零）。
       症状为**临时 1D10 轮**：轮次结束后症状消失，但「不定疯狂」标签保留 ——
       只能通过「治愈不定疯狂」（KP 同意）取消。 */
    var maxSanForIndef = memberStatusValue(m, 'maxSAN');
    /* mentalNow / isFaded 已在函数顶部计算（FADED 态判定，供 ② 跳过临时疯狂路径）。 */
    /* 缺省（undefined）= 武装：旧房间 / 直接置「症状消失」态的存档仍按 v2.2.2 口径
       「本回合任意损失即复发」；只有 KP 推进回合才把它置 false（disarm）。 */
    var fadedArmed = (this._fadedArm[seat] !== false);
    var oneFifth = (maxSanForIndef != null && maxSanForIndef > 0) ? Math.ceil(maxSanForIndef / 5) : 0;
    var relapseNow = loss > 0 &&
      ((isFaded && fadedArmed) || (oneFifth > 0 && lossTotal >= oneFifth));
    if (relapseNow) {
      /* 处于「症状消失」→ 先把标签换回「不定疯狂」（供 _addSymptom / stateApply 作基准）。 */
      var reEntryMental = isFaded ? mentalNow.map(function (x) {
        return x === MENTAL_INDEF_FADED ? MENTAL_INDEF : x;
      }) : null;
      var relapseWord = isFaded ? '不定疯狂复发' : '不定性疯狂';
      var reSym = rollSymptom(this.madness);
      if (reSym) {
        out = out.concat(this._addSymptom(m, reSym, MENTAL_INDEF,
          relapseWord + '：' + reSym.name + '（发作 ' + reSym.rounds + ' 轮；状态需治愈才解除）',
          bySeat, reEntryMental));
      } else {
        out = out.concat(this.stateApply(seat,
          { mental: reEntryMental || this._mentalWithTag(m, MENTAL_INDEF) },
          { reason: relapseWord + '（症状表未加载，请 KP 手动补症状）' }));
      }
      this._push(out, this.emit(EVT.LOG, {
        seat: '', text: who + (isFaded ? ' 的 SAN 受损，不定疯狂复发' :
          ('：本回合累计理智损失 ' + lossTotal + ' 点，达到最大理智值（' + maxSanForIndef +
           '）的五分之一 —— 判定为不定性疯狂')) +
          (reSym ? ('（' + reSym.name + '，发作 ' + reSym.rounds + ' 轮）') : '') +
          '，「不定疯狂」状态需治愈才解除',
        at: this.now(), kind: 'warn'
      }, VIS.PUBLIC));
    }
    return out;
  };

  /** 给成员的精神状态追加一个标签（踢掉互斥的「正常」），返回新数组（不改原） */
  Host.prototype._mentalWithTag = function (m, tag) {
    var mental = (m.sheet && Array.isArray(m.sheet.mental)) ? m.sheet.mental.slice() : [];
    mental = mental.filter(function (x) { return x !== '正常'; });
    if (mental.indexOf(tag) < 0) mental.push(tag);
    return mental;
  };

  /**
   * v2.1.5（用户第 3 项）：**推进 1 轮** —— 消除临时疯狂（1D10 轮倒计时）。
   *
   *   只推进**临时**疯狂症状（permanent=false）的轮次，到期移除；
   *   永久 / 不定性疯狂（permanent=true）**不随轮次消退**（治愈才消失）。
   *   症状清空后自动摘掉「临时疯狂」与派生项「疯狂症状」。
   *   无需 KP 同意（玩家可自行推进自己的）。
   *
   * @param {string} bySeat 发起者（KP 或玩家自己）
   * @param {object} p { seat }
   */
  Host.prototype.advanceMadness = function (bySeat, p) {
    var out = [];
    p = p || {};
    var target = cleanText(p.seat, 64) || (bySeat === HOST_SEAT ? '' : bySeat);
    if (bySeat !== HOST_SEAT && target !== bySeat) {
      this._push(out, this._sysTo(bySeat, '只能推进自己的疯狂轮次'));
      return out;
    }
    var m = this.roster.get(target);
    if (!m) { this._push(out, this._sysTo(bySeat, '找不到该玩家')); return out; }
    if (!Array.isArray(m.sheet.madness)) m.sheet.madness = [];

    var md = m.sheet.madness.slice();
    var faded = [];
    for (var i = md.length - 1; i >= 0; i--) {
      var x = md[i];
      /* v2.7.0（用户第 2 项）验证结论：背景自带症状必为 permanent:true → 这里恒 continue、
         永不消退；因此下面的 `if (!md.length)` 永不成立 → 派生项「疯狂症状」**始终保留**。
         **刻意不改造成「主动摘除」** —— 保持「背景症状常驻 → 标签常驻」这条自然链路。
         v2.11.8（用户需求）：背景症状（bg）只要带 bg 标记就**绝不随轮次消退** —
         即便个别老数据条目漏标 permanent，也按「纯标记」处理，不出现倒计时、不锁操作。 */
      if (x.permanent || x.bg) continue;     // 永久疯狂 / 背景症状都不消退
      var copy = Object.assign({}, x);
      copy.rounds = (copy.rounds == null || copy.rounds === '') ? 1 : (copy.rounds - 1);
      if (copy.rounds <= 0) { faded.push(copy); md.splice(i, 1); }
      else md[i] = copy;
    }

    /* v2.1.6（用户疯狂规则梳理）：按**发作来源**摘标签 ——
       · 临时疯狂的症状（from='临时疯狂'）全部消退 → 摘「临时疯狂」；
       · 不定疯狂的症状消退 → **只摘症状、不摘「不定疯狂」标签**（需治愈才解除）；
       · 背景天生的症状（from=''，permanent）不在此列；
       · 没有任何症状了 → 摘派生项「疯狂症状」。 */
    /* v2.2.1（QA P2-1 防御性加固）：旧存档可能把 `mental` 存成**字符串**（如 '正常'）——
       原写法 `(m.sheet.mental || []).slice()` 对字符串返回的仍是字符串，随后
       `mental.filter(...)` 会抛 `mental.filter is not a function`。此处先归一为数组：
       数组原样、标量（字符串）包成单元素、null/undefined 归默认 []（口径同 sanitizeSheet）。
       ⚠️ 数组路径行为完全不变（仅新增归一守卫，不改正常链路语义）。 */
    var _mraw = m.sheet.mental;
    var mental = (Array.isArray(_mraw) ? _mraw : (_mraw == null ? [] : [_mraw])).slice();
    var hasTempBout = md.some(function (x) { return !x.permanent && x.from === '临时疯狂'; });
    if (!hasTempBout) mental = mental.filter(function (x) { return x !== '临时疯狂'; });
    /* v2.1.7（用户严重 bug 反馈）：不定疯狂的症状**全部消退**后，玩家却被
       「不定疯狂」标签继续锁死 —— 状态管理打不开、连「申请治愈」都点不到，
       只能干等 KP。本意是：症状消退后即可操作，标签保留、等待治愈。
       实现：自动把「不定疯狂」换成「不定疯狂（症状消失）」——
       前者 = 发作中（锁定）；后者 = 可正常操作、只能通过治愈取消。 */
    var hadIndefSymptom = (faded || []).some(function (x) { return x.from === MENTAL_INDEF; });
    var stillIndefSymptom = md.some(function (x) { return x.from === MENTAL_INDEF; });
    if (hadIndefSymptom && !stillIndefSymptom && mental.indexOf(MENTAL_INDEF) >= 0) {
      mental = mental.map(function (x) {
        return (x === MENTAL_INDEF) ? MENTAL_INDEF_FADED : x;
      });
      /* v2.4.0（用户第 ⑤ 项）：刚进入「不定疯狂（症状消失）」→ 重新武装本回合易伤
         （本回合内再掉任意 SAN 即复发）。KP 推进回合时会统一 disarm。 */
      this._fadedArm[target] = true;
    }
    if (!md.length) mental = mental.filter(function (x) { return x !== MENTAL_SYMPTOM; });
    if (!mental.length) mental = ['正常'];

    var who = this._nick(m, target);
    var reason = '推进 1 轮';
    if (faded.length) reason += '，' + faded.map(function (x) { return x.name; }).join('、') + ' 消退';
    out = out.concat(this.stateApply(target, { madness: md, mental: mental }, { reason: reason }));

    this._push(out, this.emit(EVT.LOG, {
      seat: '', text: who + ' 推进 1 轮' +
        (faded.length ? ('：' + faded.map(function (x) { return x.name; }).join('、') + ' 已消退') : ''),
      at: this.now(), kind: 'state'
    }, VIS.PUBLIC));
    return out;
  };

  /**
   * v2.1.6（用户疯狂规则梳理）：**治愈不定疯狂** —— 摘掉「不定疯狂」标签。
   *
   * 权限：POLICY confirm='kp' —— 玩家发起时进 KP 的「待你确认」队列，
   * KP 同意后才真正执行；KP 自己发起直接执行。不定疯狂**不能**被玩家直接取消。
   */
  Host.prototype.cureIndefinite = function (bySeat, p) {
    var out = [];
    p = p || {};
    var target = cleanText(p.seat, 64) || (bySeat === HOST_SEAT ? '' : bySeat);
    if (bySeat !== HOST_SEAT && target !== bySeat) {
      this._push(out, this._sysTo(bySeat, '只能治愈自己的不定疯狂'));
      return out;
    }
    var m = this.roster.get(target);
    if (!m) { this._push(out, this._sysTo(bySeat, '找不到该玩家')); return out; }
    /* v2.7.0（第 3 项 · 模型守卫）：已撕卡（死亡 / 永久疯狂）→ 拒绝治愈，不结算。 */
    if (memberRipped(m)) {
      this._push(out, this._sysTo(bySeat, '「' + this._nick(m, target) + '」已撕卡（死亡/永久疯狂），无法治愈'));
      return out;
    }
    var mental = (m.sheet && Array.isArray(m.sheet.mental)) ? m.sheet.mental.slice() : [];
    /* v2.7.0（用户第 2 项）：背景自带的疯狂症状是**永久标记，不可治愈**。
       当该角色**只有背景症状**（madness 非空且不含任何游戏内产生的条目）时，
       「疯狂症状」来自角色背景 —— 治愈不适用：给出明确私密说明，绝不静默成功、也不删条目。
       注意：治愈只改 mental 标签、从不删 madness 条目，所以背景症状条目天然不会被治愈删除；
       本判定只负责「把『不可治愈』这件事说清楚」。 */
    var onlyBg = onlyBgSymptoms(m.sheet && m.sheet.madness);
    /* v2.1.7：两种不定疯狂标签都可治愈 —— 「不定疯狂」（发作中）与
       「不定疯狂（症状消失）」（症状已消退、状态待治愈）。 */
    if (mental.indexOf(MENTAL_INDEF) < 0 && mental.indexOf(MENTAL_INDEF_FADED) < 0) {
      /* v2.2.1（用户第 6 项）：治愈**只针对不定疯狂**。临时疯狂（含「疯狂症状」）
        不能也不需治愈 —— 它会随症状消退自动消失（见 advanceMadness）。若当前只有
        临时疯狂，给出**明确说明**（而不是笼统的「没有不定疯狂状态」），避免玩家
        反复点「申请治愈」却不知道为什么没反应。
        v2.7.0（用户第 2 项）：只有背景症状的角色，明确回「来自角色背景，不可治愈」。 */
      if (onlyBg) {
        this._push(out, this._sysTo(bySeat,
          '「' + this._nick(m, target) + '」的『疯狂症状』来自角色背景，不可治愈'));
      } else if (mental.indexOf('临时疯狂') >= 0) {
        this._push(out, this._sysTo(bySeat,
          '临时疯狂不需要治愈：它会随症状消退自动消失（请点「推进 1 轮」）。只有「不定疯狂」才需治愈。'));
      } else {
        this._push(out, this._sysTo(bySeat, '当前没有「不定疯狂」状态'));
      }
      return out;
    }
    mental = mental.filter(function (x) {
      return x !== MENTAL_INDEF && x !== MENTAL_INDEF_FADED;
    });
    if (!mental.length) mental = ['正常'];
    var who = this._nick(m, target);
    /* v2.4.0（用户第 ⑤ 项）：治愈 = 「潜在疯狂易伤」清零 —— 本回合累计 SAN 损失
       计数器归零（从零重新累计：治愈后本回合再累计到 1/5 才会不定疯狂，之后本回合
       任意损失再复发）。这是与旧行为的关键差异（旧实现不清零，治愈后残留的累计值
       会让一次小额损失就再次触发）。 */
    this._sanLostThisRound[target] = 0;
    delete this._roundStartSan[target];
    out = out.concat(this.stateApply(target, { mental: mental }, { reason: '治愈不定疯狂' }));
    /* v2.2.2（用户第 5 项）：治愈生效后，清掉该玩家所有残留的「治愈申请」待办 ——
       避免 KP 面板永远挂着一张「待你确认」卡片、也让玩家的后续动作不排在一个
       永不消失的队列后面（用户实测：治愈后仍见『已提交，等待确认』）。 */
    if (this.pending && this.pending.length) {
      this.pending = this.pending.filter(function (q) {
        return !(q && q.op === 'madness.cure' &&
                 (q.by === target || (q.p && q.p.seat === target)));
      });
    }
    this._push(out, this.emit(EVT.LOG, {
      seat: '', text: who + ' 的不定疯狂已被治愈（' +
        (bySeat === HOST_SEAT ? 'KP 裁定' : 'KP 同意') + '）',
      at: this.now(), kind: 'state'
    }, VIS.PUBLIC));
    return out;
  };

  /**
   * 指定玩家受到伤害（op=`sheet.damage`）：扣 HP 并直接写回，无需玩家同意。
   * v2.1.1：`seat === '*'` → 作用于**全部在线玩家**（每人各扣各的，不共享债务）。
   * v2.1.5（用户第 2 项）：走 settleWounds —— v2.10.0（R6）口径修正：单次伤害 **>** 上限即死；归零分流（有重伤→濒死 / 无重伤→昏迷）。
   * @param {string} bySeat
   * @param {object} p { seat, amount, kind }
   */
  Host.prototype.sheetDamage = function (bySeat, p) {
    p = p || {};
    var amount = clampNumber(p.amount, 0, 9999, 0);
    if (amount <= 0) {
      var bad = [];
      this._push(bad, this._sysTo(bySeat, '伤害值要大于 0'));
      return bad;
    }
    var kind = cleanText(p.kind, 20);
    var self = this;
    return this._forEachTarget(bySeat, p.seat, '施加伤害', function (m) {
      /* v2.1.7（用户 bug 反馈）：撕卡（死亡/永久疯狂）的角色不再接受定向指令 */
      if (memberRipped(m)) {
        var rg = [];
        self._push(rg, self._sysTo(bySeat, '「' + self._nick(m, m.seat) + '」已撕卡，无法施加伤害'));
        return rg;   /* 回调必须返回计划数组（_sysTo 是事件，要经 _push 包装） */
      }
      /* v2.8.0（HP 机制 · 用户第 1 项）：经统一 HP 收口 applyHpChange（→ settleWounds）。 */
      return self.applyHpChange(m, -amount, '受到伤害 ' + amount + (kind ? ('（' + kind + '）') : ''));
    });
  };

  /**
   * 指定玩家做 SAN Check（op=`sheet.sancheck`，冻结接口 `{ seat, loss, reason }`）。
   *
   * v2.1.1 起**按规则书结算**并**自动扣当前 SAN**：
   *   · `loss` 仍是「失败损失」（字段名冻结不变）；新增可选字段 `okLoss` = 成功损失；
   *     两者合成为 `成功/失败` 表达式（默认 `0/1D6`）交给规则服务；
   *   · 规则判定只走 `CocRules.parseSanLoss` + `CocRules.resolveSanCheck`
   *     （成功走成功支、失败走失败支、大失败按规则）；
   *   · `seat === '*'` → 全部在线玩家，**各自独立结算**（各按自己的 SAN 判、各扣各的）。
   *
   * 检定结果**公开**（SAN Check 本就公开），扣减走 stateApply（与任务B 联动）。
   * @param {string} bySeat
   * @param {object} p { seat, loss, okLoss, reason }
   */
  Host.prototype.sheetSanCheck = function (bySeat, p) {
    var self = this;
    p = p || {};
    return this._forEachTarget(bySeat, p.seat, '做 SAN Check', function (m) {
      /* v2.1.7（用户 bug 反馈）：撕卡（死亡/永久疯狂）的角色不再接受定向指令 */
      if (memberRipped(m)) {
        var rg = [];
        self._push(rg, self._sysTo(bySeat, '「' + self._nick(m, m.seat) + '」已撕卡，无法做 SAN Check'));
        return rg;   /* 回调必须返回计划数组（_sysTo 是事件，要经 _push 包装） */
      }
      /* v2.5.0（用户第 2 项）：疯狂发作中（临时疯狂 / 不定疯狂）不能被拉去做
         SAN Check。KP 发起的 ACT 不进 #_act 那条全局操作锁（它只对非 host 生效），
         所以必须在模型入口自己判 —— 否则 KP 能绕过发作限制。
         `seat === '*'` 时 _forEachTarget 会逐人调用本回调，因此是**逐人跳过 +
         逐人提示**，不会让整条全量指令失败。 */
      if (memberMadActive(m)) {
        var rb = [];
        self._push(rb, self._sysTo(bySeat, '「' + self._nick(m, m.seat) + '」正处于疯狂发作中，不能做 SAN Check'));
        return rb;
      }
      return self._settleSanCheck(m, p, bySeat);
    });
  };

  /**
   * v2.3.0（用户第 7 项）：SAN 大失败的**KP 一键入口** —— 按规则书追加理智损失（掷 1D10）。
   *   · 与 sheetDamage 对称：**不自动扣**，必须 KP 主动点击；
   *   · 掷骰在权威端、结果公开、扣减走 stateApply（经 EVT.STATE 写回该玩家角色卡）；
   *   · `seat === '*'` → 全部在线玩家，各自独立掷 1D10 各扣各的；
   *   · 撕卡角色跳过并明确提示。
   * @param {string} bySeat
   * @param {object} p { seat, dice?, reason? }
   */
  Host.prototype.sheetSanLoss = function (bySeat, p) {
    var self = this;
    p = p || {};
    var dice = cleanText(p.dice, 12) || '1D10';
    return this._forEachTarget(bySeat, p.seat, '追加理智损失', function (m) {
      var rg = [];
      if (memberRipped(m)) {
        self._push(rg, self._sysTo(bySeat, '「' + self._nick(m, m.seat) + '」已撕卡，无法追加理智损失'));
        return rg;
      }
      /* v2.5.0（用户第 2 项）：同上 —— 疯狂发作中不接受「SAN 大失败追加理智损失」 */
      if (memberMadActive(m)) {
        self._push(rg, self._sysTo(bySeat, '「' + self._nick(m, m.seat) + '」正处于疯狂发作中，不能追加理智损失'));
        return rg;
      }
      var rules = self.rules;
      var rolled = (rules && typeof rules.rollExpr === 'function') ? rules.rollExpr(dice, self.rng) : null;
      var loss = (rolled && rolled.ok) ? Math.max(0, num(rolled.total, 0)) : 0;
      if (loss <= 0) { self._push(rg, self._sysTo(bySeat, '追加理智损失骰无效：' + dice)); return rg; }
      var san = memberStatusValue(m, 'currentSAN');
      if (san == null) san = memberStatusValue(m, 'maxSAN');
      if (san == null) {
        self._push(rg, self._sysTo(bySeat, '该玩家还没有理智值（未绑定角色卡），无法追加理智损失'));
        return rg;
      }
      var after = Math.max(0, num(san, 0) - loss);
      var who = self._nick(m, m.seat);
      rg = rg.concat(self.diceRoll(m.seat, {
        expr: dice, label: 'SAN 大失败追加理智损失',
        result: { rolls: (rolled && rolled.rolls) || [], value: loss, detail: (rolled && rolled.detail) || '' }
      }));
      self._push(rg, self.emit(EVT.LOG, {
        seat: m.seat, kind: 'check',
        text: who + ' SAN 大失败，按规则书追加理智损失：' + dice + ' = ' + loss + '，SAN ' + san + ' → ' + after,
        at: self.now()
      }, VIS.PUBLIC));
      rg = rg.concat(self.stateApply(m.seat, { status: { currentSAN: after } },
        { reason: 'SAN 大失败追加 ' + dice + ' -' + loss }));
      if (loss > 0) rg = rg.concat(self._afterSanLoss(m, loss, bySeat));
      return rg;
    });
  };

  /**
   * v2.3.0（用户第 7 项）：修改房间的检定成败阈值（KP 工具 · op=`room.rules`）。
   *   critThreshold   —— 大成功阈值：掷出值 ≤ 该值 → 大成功（默认 1）。
   *   fumbleThreshold —— 大失败阈值：掷出值 ≥ 该值 → 大失败；留空 / 0 → 动态规则。
   * 改完更新 meta 并广播（EVT.HELLO 能透传 meta 任意键），写一条公开日志，房内检定**立即生效**。
   */
  Host.prototype.setRoomRules = function (p) {
    var out = [];
    p = p || {};
    var critRaw = p.critThreshold, fumbleRaw = p.fumbleThreshold, crit, fumble;
    if (critRaw === undefined || critRaw === null || String(critRaw).trim() === '') crit = 1;
    else {
      crit = num(critRaw, NaN);
      if (!(crit >= 1 && crit <= 100)) { this._push(out, this._sysTo(HOST_SEAT, '大成功阈值需为 1–100 的整数')); return out; }
    }
    if (fumbleRaw === undefined || fumbleRaw === null || String(fumbleRaw).trim() === '' || num(fumbleRaw, 0) === 0) fumble = 100;
    else {
      fumble = num(fumbleRaw, NaN);
      if (!(fumble >= 1 && fumble <= 100)) { this._push(out, this._sysTo(HOST_SEAT, '大失败阈值需为 1–100 的整数')); return out; }
    }
    this.state.meta.critThreshold = crit;
    this.state.meta.fumbleThreshold = fumble;
    this._push(out, this.emit(EVT.HELLO, { meta: clone(this.state.meta) }, VIS.PUBLIC));
    this._push(out, this.emit(EVT.LOG, {
      seat: '', kind: 'sys',
      text: 'KP 设置了检定阈值：大成功 掷出 ≤ ' + crit + '；大失败 ' +
        ((fumble === 100) ? '按规则书动态判定（要求阈值 < 50 时 96-100，否则仅 100）'
                          : ('掷出 ≥ ' + fumble)),
      at: this.now()
    }, VIS.PUBLIC));
    return out;
  };

  /**
   * v2.1.1：玩家**自助** SAN 检定（INTENT.SAN_CHECK）。与 KP 定向共用同一结算
   * （_settleSanCheck），保证规则书口径一致；玩家只声明损失表达式，状态由权威端写回。
   */
  Host.prototype.playerSanCheck = function (seat, mem, p) {
    var out = [];
    if (!mem || mem.role !== ROLE.PLAYER) {
      this._push(out, this._sysTo(seat, '只有玩家可以做 SAN Check'));
      return out;
    }
    return out.concat(this._settleSanCheck(mem, p || {}, seat));
  };

  /**
   * 结算**一名**成员的 SAN Check 并自动扣其当前 SAN（KP 定向 / 玩家自助共用）。
   *
   * 规则依据：CoC 7e —— SAN 检定掷 1D100 ≤ 当前 SAN 即成功；
   *   成功 → 扣「成功损失」（通常 0）；失败 → 扣「失败损失」；大失败按失败处理。
   *   ⚠️ 判定基准是**检定前那一刻该成员的当前 SAN**（不是上限、不是别人的）。
   *
   * 边界：检定前当前 SAN 缺失时**不静默按 0 判**（那会让检定必定大失败，极隐蔽）——
   *   合理兜底是用 SAN 上限；上限也没有（未绑定角色卡）则明确拒绝并回话。
   *
   * @param {object} m 权威成员
   * @param {object} p { loss(失败损失), okLoss(成功损失), reason }
   * @param {string} bySeat 回话对象
   * @returns {Array} 发送计划
   */
  Host.prototype._settleSanCheck = function (m, p, bySeat) {
    var out = [];
    p = p || {};
    var seat = m.seat;

    var san = memberStatusValue(m, 'currentSAN');
    var maxSan = memberStatusValue(m, 'maxSAN');
    var usedFallback = false;
    if (san == null) {
      if (maxSan != null) { san = maxSan; usedFallback = true; }
      else {
        this._push(out, this._sysTo(bySeat,
          '该玩家还没有理智值（未绑定角色卡），无法做 SAN Check'));
        return out;
      }
    }
    san = clampNumber(san, 0, 99, 0);
    /* SAN 上限由 POW 派生，必然 ≥1 —— maxSAN 缺失、0 或负数都属于**非法/未知**，
       一律按 99（= 不设上界）处理。绝不能把 0 当成合法上界：那会让一次失败的
       SAN Check 把玩家 SAN 直接清零（QA 真机复现的缺陷）。 */
    var maxSanVal = (maxSan == null || !(maxSan > 0)) ? 99 : clampNumber(maxSan, 1, 99, 99);

    /* 成功/失败损失表达式：okLoss 为新增可选字段（默认 0）；loss 保持旧语义=失败损失。
       向后兼容：旧调用方只传数值 loss（如 6）也能正常工作。 */
    var okExpr = normLossPart(p.okLoss, '0');
    var failExpr = normLossPart(p.loss, '1D6');
    var lossExpr = okExpr + '/' + failExpr;

    var rules = this.rules;
    var useLib = !!(rules && typeof rules.parseSanLoss === 'function' &&
                    typeof rules.resolveSanCheck === 'function' && typeof rules.rollExpr === 'function');
    var checkRes = null, loss = 0, branch = failExpr, branchText = '失败';

    if (useLib) {
      var parsed = rules.parseSanLoss(lossExpr);
      if (!parsed.ok) {
        this._push(out, this._sysTo(bySeat,
          '理智损失格式不合法：' + parsed.reason + '（应形如 0/1D6）'));
        return out;
      }
      var rr = rules.resolveSanCheck(Object.assign({
        currentSan: san, maxSan: maxSanVal, lossExpr: lossExpr
      }, ruleOptsOf(this.state.meta)));   // v2.3.0（第 7 项）：透传阈值
      if (!rr || !rr.ok) {
        this._push(out, this._sysTo(bySeat,
          '理智检定结算失败：' + ((rr && rr.reason) || '未知原因')));
        return out;
      }
      checkRes = rr.check;
      loss = clampNumber(rr.loss, 0, 99, 0);
      branchText = rr.branchText;
      branch = (rr.usedBranch === 'onSuccess') ? okExpr : failExpr;
    } else {
      /* 降级路径（规则服务缺失 / 单元测试替身）：只判成功失败 + 按支扣，不解析骰式 */
      if (rules && typeof rules.check === 'function') {
        checkRes = rules.check(Object.assign({ kind: 'san', base: san, difficulty: 'REGULAR',
                                 bonus: 0, penalty: 0, label: 'SAN Check' }, ruleOptsOf(this.state.meta)));
      } else {
        var rv = 1 + Math.floor(Math.random() * 100);
        checkRes = { value: rv, passed: rv <= san, levelText: (rv <= san ? '成功' : '失败') };
      }
      var passed = !!checkRes.passed;
      branchText = passed ? '成功' : '失败';
      branch = passed ? okExpr : failExpr;
      if (/^\d+$/.test(String(branch))) {
        loss = clampNumber(num(branch, 0), 0, 99, 0);
      } else if (rules && typeof rules.rollExpr === 'function') {
        var r2 = rules.rollExpr(branch);
        loss = (r2 && r2.ok) ? clampNumber(r2.total, 0, 99, 0) : 0;
      } else { loss = 0; }
    }

    var roll = num(checkRes && checkRes.value, 0);
    var levelText = (checkRes && (checkRes.levelText || checkRes.levelKey)) || '';
    /* 检定公开：D100 + 成功等级 + 判定目标 = 该玩家当前 SAN */
    out = out.concat(this.diceRoll(seat, {
      expr: '1D100', label: 'SAN Check（对 ' + san + '）', result: checkRes
    }));

    /* 扣减结果：先按损失扣（下限 0）；上界**只做「不得超过」的收敛，且绝不把 SAN
       压到检定前以下** —— 否则一个异常上界（如 0）会在没损失时也把 SAN 往下夹。 */
    var after = Math.max(0, san - loss);
    if (maxSanVal >= san) after = Math.min(after, maxSanVal);
    var who = this._nick(m, seat);
    /* 可读记录：检定目标 / 骰值 / 成功等级 / 走了哪一支 / 损失 / 扣减后剩余。
       ⚠️ loss=0 时**不得**声称「SAN a → b」——没有扣减就不能写出差值（那是一条撒谎的日志）。 */
    var lossText = (loss > 0)
      ? ('，理智损失 ' + loss + '，SAN ' + san + ' → ' + after)
      : '，无理智损失（SAN 保持不变）';
    /* v2.3.0（用户第 7 项）：大失败 → 明确标注 + 给 KP 一个「追加 1D10 理智损失」的入口提示
       （不自动扣：后果由 KP 按规则书裁定，入口见 KP 工具 → 🧾 SAN 大失败追加）。 */
    var fumbleNote = (checkRes && checkRes.fumble)
      ? '　·　⚠ 大失败：KP 可按规则书追加 1D10 理智损失（KP 工具 → 🧾 SAN 大失败追加，不自动扣）'
      : '';
    this._push(out, this.emit(EVT.LOG, {
      seat: seat,
      text: who + ' 做 SAN Check：目标 SAN ' + san +
        '，掷 ' + roll + (levelText ? ('（' + levelText + '）') : '') +
        ' → ' + branchText + '支 ' + branch +
        lossText +
        (usedFallback ? '（未上报当前 SAN，暂以上限判定）' : '') +
        fumbleNote,
      at: this.now(), kind: 'check'
    }, VIS.PUBLIC));

    if (loss > 0) {
      out = out.concat(this.stateApply(seat, { status: { currentSAN: after } },
        { reason: 'SAN Check ' + branchText + ' -' + loss +
          (p.reason ? ('（' + cleanText(p.reason, 40) + '）') : '') }));
      /* v2.1.5（用户第 2 项）：SAN 扣减后**自动**做疯狂判定 ——
         SAN 归零 → 永久疯狂撕卡；单次损失 ≥5 → INT 检定 → 症状 + 1D10 轮；
         本回合累计 ≥ 1/5 → 不定性疯狂。不再只是「提示一句」。 */
      out = out.concat(this._afterSanLoss(m, loss, bySeat));
    }
    return out;
  };

  /**
   * 给指定玩家追加一条临时状态（op=`sheet.tempstatus`）。
   * 语义 = **追加**：读出旧数组 → push 一条 → 交 stateApply 整体替换（过白名单）。
   * v2.1.1：`seat === '*'` → 全部在线玩家各追加一条。
   * @param {string} bySeat
   * @param {object} p { seat, text }
   */
  Host.prototype.sheetTempStatus = function (bySeat, p) {
    p = p || {};
    var text = cleanText(p.text, 80);
    if (!text) {
      var bad = [];
      this._push(bad, this._sysTo(bySeat, '临时状态内容不能为空'));
      return bad;
    }
    var self = this;
    return this._forEachTarget(bySeat, p.seat, '附加临时状态', function (m) {
      /* v2.1.7（用户 bug 反馈）：撕卡（死亡/永久疯狂）的角色不再接受定向指令 */
      if (memberRipped(m)) {
        var rg = [];
        self._push(rg, self._sysTo(bySeat, '「' + self._nick(m, m.seat) + '」已撕卡，无法附加临时状态'));
        return rg;   /* 回调必须返回计划数组（_sysTo 是事件，要经 _push 包装） */
      }
      var list = (m.sheet && Array.isArray(m.sheet.tempStatus)) ? m.sheet.tempStatus.slice() : [];
      list.push({ text: text, by: 'kp', at: self.now() });
      return self.stateApply(m.seat, { tempStatus: list },
        { reason: 'KP 附加临时状态：' + text });
    });
  };

  /**
   * 给指定玩家一个物品道具（op=`sheet.item`）。追加语义同 sheetTempStatus。
   * v2.1.1：`seat === '*'` → 全部在线玩家各发一个。
   * @param {string} bySeat
   * @param {object} p { seat, name, qty, note }
   */
  Host.prototype.sheetItem = function (bySeat, p) {
    p = p || {};
    var name = cleanText(p.name, 40);
    if (!name) {
      var bad = [];
      this._push(bad, this._sysTo(bySeat, '物品名不能为空'));
      return bad;
    }
    var qty = clampNumber(p.qty, 1, 9999, 1);
    var note = cleanText(p.note, 80);
    var self = this;
    return this._forEachTarget(bySeat, p.seat, '给予物品', function (m) {
      /* v2.1.7（用户 bug 反馈）：撕卡（死亡/永久疯狂）的角色不再接受定向指令 */
      if (memberRipped(m)) {
        var rg = [];
        self._push(rg, self._sysTo(bySeat, '「' + self._nick(m, m.seat) + '」已撕卡，无法给予物品'));
        return rg;   /* 回调必须返回计划数组（_sysTo 是事件，要经 _push 包装） */
      }
      var list = (m.sheet && Array.isArray(m.sheet.items)) ? m.sheet.items.slice() : [];
      /* v2.1.3：带稳定 id（玩家据此删除；见 delItem 的幂等说明）。
         ⚠️ 用 self.localSeq —— 这段在 _forEachTarget 的回调里，this 不是 Host。 */
      list.push({ id: 'i' + (++self.localSeq), name: name, qty: qty, note: note });
      return self.stateApply(m.seat, { items: list },
        { reason: 'KP 给予物品：' + name });
    });
  };

  /**
   * v2.2.0 修复（P2-A）：发布一条「对抗检定结果」。
   *   · 非秘密 → EVT.CHECK PUBLIC（全体现行 + 进公共日志，**行为完全不变**）。
   *   · 秘密   → 完整结果经 EVT.PRIVATE 单发 KP（进 KP 私密信息，KP 仍看得到全文）；
   *              公共记录只落一条**脱敏** LOG（不含骰值 / 胜负 / 伤害）——
   *              与既有「KP 暗骰」口径一致，绝不把秘密写进公共 state.logs。
   * @param {Array} out 发送计划累加器
   * @param {Object} payload EVT.CHECK 载荷（含 summary / a / b / rounds / damage …）
   * @param {boolean} secret 是否秘密对抗
   */
  Host.prototype._emitOpposedCheck = function (out, payload, secret) {
    if (secret) {
      this._push(out, this.emit(EVT.PRIVATE, {
        title: '秘密对抗', kind: 'opposed', text: payload.summary || '（秘密对抗）',
        at: payload.at || this.now()
      }, VIS.SEAT, HOST_SEAT));
      this._push(out, this.emit(EVT.LOG, {
        seat: '', text: 'KP 秘密进行了一次对抗检定', at: payload.at || this.now(), kind: 'check'
      }, VIS.PUBLIC));
    } else {
      this._push(out, this.emit(EVT.CHECK, payload, VIS.PUBLIC));
    }
    return out;
  };

  /**
   * 对抗检定（契约 §5.3 check.opposed）：支持非对称（NPC 侦查 vs 玩家潜行）。
   * aSeat/bSeat 可以是房间座位，也可以是战斗单位 id。
   */
  Host.prototype.checkOpposed = function (bySeat, p) {
    var out = [];
    var rules = this.rules;
    if (!rules || typeof rules.check !== 'function') {
      this._push(out, this._sysTo(bySeat, '规则服务不可用，无法进行对抗检定'));
      return out;
    }
    p = p || {};

    /* v2.2.0（用户第 3 项）：攻击对抗分支（discriminator = attack 为真）
       + 「拒绝某条玩家申请」分支（p.cancel === true，核销待办）。 */
    if (p.attack || p.cancel) {
      return this._opposedAttackResolve(bySeat, p);
    }

    /* ---- 原「通用对抗」分支（KP 直接发起；旧字段保留、向后兼容）---- */
    /* v2.5.0（用户第 5 项）：aBase / bBase = KP 在发起弹层里给「无人物卡单位」手输的
       1–100 检定值。先做一次数值归一化（字符串 '60' 也要认，空串/非法视作没填），
       再交给 _resolveActorSkill 当 fallback —— 保证「怪物手输值」这条链路通畅。 */
    var aBase = normBase(p.aBase);
    var bBase = normBase(p.bBase);
    var a = this._resolveActorSkill(p.aSeat, p.aSkill, aBase);
    var b = this._resolveActorSkill(p.bSeat, p.bSkill, bBase);
    /* v2.4.0（用户第 ④ 项）：任一方解析失败（单位不存在等）→ 明确报错，不静默跳过。
       注意：战斗单位缺技能但给了手输值（aBase/bBase）时会正常用手输值结算（见 _resolveActorSkill）。 */
    if (a && a.ok === false) {
      this._push(out, this._sysTo(bySeat, '甲方无效：' + (a.reason || '无法解析')));
      return out;
    }
    if (b && b.ok === false) {
      this._push(out, this._sysTo(bySeat, '乙方无效：' + (b.reason || '无法解析')));
      return out;
    }
    var diff = p.difficulty || 'REGULAR';
    var ro = ruleOptsOf(this.state.meta);   // v2.3.0（第 7 项）：透传大成功 / 大失败阈值
    var aRes = rules.check(Object.assign({ kind: 'opposed', base: a.value, difficulty: diff,
                             bonus: num(p.aBonus, 0), penalty: num(p.aPenalty, 0), label: a.name }, ro));
    var bRes = rules.check(Object.assign({ kind: 'opposed', base: b.value, difficulty: diff,
                             bonus: num(p.bBonus, 0), penalty: num(p.bPenalty, 0), label: b.name }, ro));
    /* v2.2.0（用户第 3 项）：通用对抗改用 opposedFull（同级同值逐轮重掷 ≤10 轮兜底 + 明细）。 */
    var verdict = (typeof rules.opposedFull === 'function')
      ? rules.opposedFull(aRes, bRes, { rng: p.rng })
      : ((typeof rules.opposed === 'function') ? rules.opposed(aRes, bRes) : null);
    var rounds = (verdict && verdict.rounds) ? verdict.rounds : [];
    var summary;
    if (verdict && verdict.winner) {
      var winner = (verdict.winner === 'a') ? a.name : b.name;
      summary = OPPOSED_PREFIX + a.name + '（' + aRes.levelText + '，掷 ' + aRes.value + '） vs ' +
        b.name + '（' + bRes.levelText + '，掷 ' + bRes.value + '） → ' + winner + ' 胜（' + verdict.reason + '）' +
        buildOpposedRerollLines(rounds, a.name, b.name, verdict.fallback);
    } else {
      summary = OPPOSED_PREFIX + a.name + ' vs ' + b.name + '（未能裁定）';
    }
    var id = 'o' + (++this.localSeq);
    /* 秘密对抗 → 完整结果只给 KP（私密），公共只留脱敏行（见 _emitOpposedCheck）。 */
    var secret = !!p.secret;
    this._emitOpposedCheck(out, {
      id: id, kind: 'opposed',
      targets: [p.aSeat, p.bSeat].filter(Boolean),
      skill: (a.name + ' vs ' + b.name), difficulty: diff,
      a: { ref: p.aSeat || '', name: a.name, value: aRes.value, level: aRes.level, levelText: aRes.levelText },
      b: { ref: p.bSeat || '', name: b.name, value: bRes.value, level: bRes.level, levelText: bRes.levelText },
      winner: verdict ? verdict.winner : null, tie: !!(verdict && verdict.tie),
      reaction: '', decidedBy: verdict ? verdict.decidedBy : '',
      rounds: rounds, fallback: !!(verdict && verdict.fallback), damage: null,
      summary: summary, at: this.now()
    }, secret);
    this._push(out, this._sysTo(bySeat, '已发起对抗检定'));
    return out;
  };

  /* ============================================================
   * v2.2.0（用户第 3 项）—— 攻击对抗的权威结算
   *
   * 两条入口：
   *   ① KP 直接发起：p.attacker / p.defender / p.weapon / p.armor（怪物侧手输 1–100）；
   *   ② KP 裁定玩家申请：p.reqId + p.defender{reaction,value}（attacker/weapon/db 取
   *      权威人物卡，不完全信任客户端载荷）。
   * 幂等：处理前先按 reqId 核销 state.opposed；处理后清空 —— 重复事件只结算一次。
   * ============================================================ */

  /**
   * v2.2.1（用户第 2 项·2b）：对抗裁定**失败**时的统一收尾 —— 绝不「点了裁定却什么都没发生」。
   *   · 给 KP（bySeat）私密提示（定位原因）；
   *   · 给发起者（toSeat，若有且非 KP）私密提示（玩家也要知道为何没结算）；
   *   · 公共记录落一条**失败说明**行（`⚔ 对抗｜（未结算）<原因>`），
   *     使「玩家发起 → KP 裁定 → 公共记录空白」的情况不再出现。
   * @param {Array}  out    发送计划累加器
   * @param {string} bySeat KP/发起者座位（私密提示对象）
   * @param {string} toSeat 玩家座位（可空）
   * @param {string} reason 失败原因（人类可读）
   */
  Host.prototype._opposedFail = function (out, bySeat, toSeat, reason) {
    var txt = cleanText(reason, 200) || '对抗裁定失败';
    this._push(out, this._sysTo(bySeat, txt));
    if (toSeat && toSeat !== bySeat) this._push(out, this._sysTo(toSeat, txt));
    this._push(out, this.emit(EVT.LOG, {
      seat: '', text: OPPOSED_PREFIX + '（未结算）' + txt, at: this.now(), kind: 'check'
    }, VIS.PUBLIC));
    return out;
  };

  /** 「拒绝玩家对抗申请」（核销待办，不结算）。 */
  Host.prototype._opposedReject = function (bySeat, p) {
    var out = [];
    var st = this.state.opposed;
    if (!st || (p.reqId && st.id !== p.reqId)) {
      this._push(out, this._sysTo(bySeat, '该对抗申请已处理或不存在'));
      return out;
    }
    var toSeat = st.by;
    this.state.opposed = null;
    this._push(out, this.emit(EVT.OPPOSED,
      { id: st.id, by: st.by, phase: 'rejected', targetId: st.targetId, targetName: st.targetName, at: this.now() },
      VIS.SEAT, toSeat));
    this._push(out, this._sysTo(bySeat, '已拒绝该对抗申请'));
    this._push(out, this._sysTo(toSeat, '你的对抗申请被 KP 拒绝'));
    return out;
  };

  /**
   * 解析攻击对抗的一方：
   *   · side 'pc'      → 权威端**读人物卡**取技能值（查不到明确报错，绝不按 0 结算）；
   *   · side 'monster' → 怪物无人物卡，对抗值一律 KP 手输（1–100 整数）。
   * @returns {{ok, side, seat, actorId, name, skill, value, reaction, ranged, reason}}
   */
  Host.prototype._resolveOpposedSide = function (spec, opts) {
    opts = opts || {};
    spec = spec || {};
    var side = (spec.side === 'pc') ? 'pc' : ((spec.side === 'monster' || spec.side === 'npc') ? 'monster' : '');
    if (!side) return { ok: false, reason: '未指定对抗方类型（玩家 / 怪物）' };
    var skill = cleanText(spec.skill, 30) || (opts.defaultSkill || '');
    var name = cleanText(spec.name, 40) || opts.defaultName || '单位';
    if (side === 'pc') {
      var seat = cleanText(spec.seat, 64);
      var mem = seat ? this.roster.get(seat) : null;
      if (!mem) return { ok: false, reason: '找不到玩家「' + (name || seat) + '」' };
      if (memberRipped(mem)) return { ok: false, reason: '目标「' + this._nick(mem, seat) + '」已撕卡（死亡/永久疯狂）' };
      if (mem.online === false) return { ok: false, reason: '目标「' + this._nick(mem, seat) + '」已离线' };
      if (!skill) return { ok: false, reason: '请指定该玩家要对抗的技能/属性' };
      var v = this._skillBaseOf(mem, skill, null);
      if (v === null || v === undefined || !isFinite(Number(v))) {
        return { ok: false, reason: '在「' + this._nick(mem, seat) + '」人物卡里查不到「' + skill + '」——请核对技能名，或改用 KP 手输值' };
      }
      return { ok: true, side: 'pc', seat: seat, name: this._nick(mem, seat), skill: skill,
               value: Number(v), reaction: spec.reaction || '', ranged: !!spec.ranged };
    }
    /* monster / npc：无人物卡 → 对抗值 KP 手输 1–100 整数 */
    var hv = num(spec.value, NaN);
    if (!(hv >= 1 && hv <= 100) || Math.floor(hv) !== hv) {
      return { ok: false, reason: '「' + name + '」的对抗值需为 1–100 的整数（怪物无人物卡，请 KP 手输）' };
    }
    /* v2.2.1（用户第 2 项·2c）：怪物「不扣血」根因修复 —— 若 KP 载荷没带 actorId
       （旧客户端 / 手填），按**名字**在战斗槽里回填 actorId，否则 _opposedDamageMonster
       会因找不到槽而静默不扣血。 */
    var mActorId = cleanText(spec.actorId, 64);
    if (!mActorId && name) {
      var byName = this._findCombatSlotByName(name);
      if (byName) mActorId = byName.actorId || byName.id;
    }
    return { ok: true, side: 'monster', seat: '', actorId: mActorId,
             name: name, skill: skill || '对抗', value: hv, reaction: spec.reaction || '', ranged: !!spec.ranged };
  };

  /** 攻击对抗主结算（KP 直接发起 / 玩家申请裁定统一走这里）。 */
  Host.prototype._opposedAttackResolve = function (bySeat, p) {
    var out = [];
    var rules = this.rules;
    p = p || {};
    if (p.cancel) return this._opposedReject(bySeat, p);

    var fromRequest = !!p.reqId;
    var st = this.state.opposed;
    if (fromRequest && (!st || st.id !== p.reqId)) {
      this._push(out, this._sysTo(bySeat, '该对抗申请已处理或不存在'));
      return out;
    }

    /* ---- 组装攻击方（attacker）---- */
    var attacker;
    var weapon = null;
    var db = '0';
    var reqTarget = null;
    if (fromRequest) {
      var am = this.roster.get(st.by);
      if (!am) { this._opposedFail(out, bySeat, st.by, '发起者已不在房间，无法结算'); this.state.opposed = null; return out; }
      var reqWeapon = st.weapon || {};
      /* 武器 / DB 从**权威人物卡**取（查不到再用申请载荷，绝不按 0 静默） */
      weapon = this._matchSheetWeapon(am, reqWeapon.name) || reqWeapon;
      db = (am.sheet && am.sheet.db) ? am.sheet.db : (st.db || '0');
      var reqSkill = cleanText(reqWeapon.skill, 30) || '格斗';
      var av = cleanText(weapon.skill, 30) || reqSkill;
      var aval = this._skillBaseOf(am, av, null);
      if (aval === null || aval === undefined || !isFinite(Number(aval))) {
        this._opposedFail(out, bySeat, st.by, '在发起者人物卡里查不到「' + av + '」，无法结算（请核对武器技能）');
        this.state.opposed = null;
        return out;
      }
      attacker = { ok: true, side: 'pc', seat: st.by, name: this._nick(am, st.by),
                   skill: av, value: Number(aval), ranged: /射击|枪|弓|投掷|弩/.test(av) };
      reqTarget = { id: st.targetId, name: st.targetName };
    } else {
      attacker = this._resolveOpposedSide(p.attacker, { defaultName: '攻击方', defaultSkill: '格斗' });
      if (!attacker.ok) { this._push(out, this._sysTo(bySeat, '攻击方无效：' + attacker.reason)); return out; }
      weapon = p.weapon || {};
      db = cleanText(weapon.db, 10) || cleanText(p.db, 10) || '0';
    }

    /* ---- 组装防守方（defender）---- */
    var defender;
    var reaction = normReaction(p.defender && p.defender.reaction);
    /* v2.4.0（用户第 ⑧ 项）：「无法反抗」→ 跳过对抗判定（防守方不掷骰、不需要对抗值），
       攻击方武器对抗**自动成功**，直接进入伤害判定。 */
    var noDefense = !!p.noDefense;
    if (noDefense) reaction = 'none';
    if (fromRequest) {
      /* 目标是「已设置怪物」：从战斗槽按 actorId 找 + 再校验存活 */
      var slot = this._findCombatSlot(st.targetId);
      var dname = st.targetName || (slot && slot.name) || '目标';
      if (!slot) {
        this._opposedFail(out, bySeat, st.by, '目标「' + dname + '」不在战斗中，无法结算');
        this.state.opposed = null;
        return out;
      }
      var dhp = num((slot.public || {}).hp, NaN);
      if ((slot.public || {}).down || slot.public && slot.public.state === 'dead' ||
          (isFinite(dhp) && dhp <= 0)) {
        this._opposedFail(out, bySeat, st.by, '目标「' + dname + '」已死亡/离场，无法结算');
        this.state.opposed = null;
        return out;
      }
      if (noDefense) {
        /* 无法反抗：不要求 KP 手输对抗值，防守技能记作「无法反抗」 */
        defender = { ok: true, side: 'monster', actorId: st.targetId, name: dname,
                     skill: '无法反抗', value: 0, reaction: 'none', noDefense: true };
      } else {
        var dval = num(p.defender && p.defender.value, NaN);
        if (!(dval >= 1 && dval <= 100) || Math.floor(dval) !== dval) {
          this._push(out, this._sysTo(bySeat, '请为「' + dname + '」输入 1–100 的对抗值'));
          return out;   /* 不核销 —— 让 KP 修正后重试 */
        }
        defender = { ok: true, side: 'monster', actorId: st.targetId, name: dname,
                     skill: (reaction === 'counter' ? '反击' : '闪避'), value: dval, reaction: reaction };
      }
    } else if (noDefense) {
      /* KP 直接发起 + 无法反抗：保留 seat/actorId 以便伤害落点，跳过对抗值校验 */
      var dspecND = p.defender || {};
      defender = { ok: true, side: dspecND.seat ? 'pc' : 'monster',
                   seat: cleanText(dspecND.seat, 64) || '',
                   actorId: cleanText(dspecND.actorId, 64) || '',
                   name: cleanText(dspecND.name, 40) || '防守方',
                   skill: '无法反抗', value: 0, reaction: 'none', noDefense: true };
    } else {
      defender = this._resolveOpposedSide(p.defender, { defaultName: '防守方', defaultSkill: '闪避' });
      if (!defender.ok) { this._push(out, this._sysTo(bySeat, '防守方无效：' + defender.reason)); return out; }
      defender.reaction = reaction;
    }

    /* 攻方没成功 → 直接落空（绝不因走完重掷误判攻方胜；resolveAttack 内部已处理）。 */
    var dmgExpr = weaponDamageExpr(weapon && weapon.damage, rules);
    if (!dmgExpr.ok) {
      var dReason = '武器伤害式非法：' + dmgExpr.reason + '（请核对武器）';
      if (fromRequest) { this._opposedFail(out, bySeat, st.by, dReason); this.state.opposed = null; }
      else this._push(out, this._sysTo(bySeat, dReason));
      return out;
    }
    var weaponPierce = (cleanText(weapon && weapon.pierce, 4) === '√');
    var armorValue = Math.max(0, num(p.armor && p.armor.value, 0));

    /* ---- v2.3.0（用户第 8 项）：连发与惩罚骰 ----
       权威端记录「本轮该玩家该武器已发射次数」（this._fireUsed，随 EVT.ROUND 清零）。
       · 每多发一次 +1 惩罚骰（第 1 发 0 个、第 2 发 1 个…）；沿用 check() 的 penalty，上限 MOD_CAP。
       · 玩家申请路径：≤2 发武器必须在申请时选「打 1 发 / 打 2 发」（shots）；≥3 可连续发起。
       v2.4.0（用户第 ⑨ 项）：改为**逐发串行判定** —— 每发独立跑一次攻击 vs 防守，
       只有「胜利且造成伤害（applied>0）」才继续下一发；惩罚骰按**该发序号-1 + 本轮已发射数**计。 */
    var perRoundStr = cleanText(weapon && weapon.perRound, 12);
    var burstMax = (typeof rules.burstMaxOf === 'function') ? rules.burstMaxOf(perRoundStr) : 1;
    var shotsReq = fromRequest ? num(st && st.shots, 0) : num(p.shots, 0);
    var shots = 1;
    if (burstMax > 1) shots = (shotsReq >= 1 && shotsReq <= burstMax) ? Math.floor(shotsReq) : 1;
    var wkey = cleanText(weapon && weapon.name, 40) || '_w';
    var fireKey = (attacker.seat || (st && st.by) || '') + '\u0000' + wkey;
    var priorShots = fromRequest ? num(this._fireUsed[fireKey], 0) : 0;
    /* 记录里的「本次惩罚骰」= 整个连发的最大惩罚骰（最后一发）；逐发明细见每条记录。 */
    var burstPenalty = (burstMax > 1) ? Math.min(MOD_CAP, (shots - 1) + priorShots) : 0;
    var shotNote = (burstMax > 1)
      ? ('本轮已发射 ' + priorShots + '/' + burstMax + '，本次 ' + shots + ' 发，惩罚骰 +' + burstPenalty)
      : '';
    /* 先按计划数记账（申请路径）；逐发结束后再按**实际打出数**覆写。 */
    if (fromRequest) this._fireUsed[fireKey] = priorShots + shots;

    /* 玩家胜 + 多只存活怪物 + 未定最终目标 → 让玩家选怪（仅单发；连发不逐发选怪，
       用申请时已选 targetId；「无法反抗」也不选怪 —— 直接打已选目标）。 */
    var monsters = this._aliveMonsters();
    var canDefer = fromRequest && !noDefense && shots === 1 && monsters.length >= 2;

    /* ---- v2.4.0（用户第 ⑨ 项）：逐发串行判定 ---- */
    var seatOfAttacker = attacker.seat || (st && st.by) || '';
    var firedCount = 0;
    var stopReason = '';
    var lastRes = null;
    var lastDmg = null;
    var lastAttackerWins = false;
    for (var shotIdx = 1; shotIdx <= shots; shotIdx++) {
      /* 第 k 发带 (k-1) + 本轮已发射数 个惩罚骰，上限 MOD_CAP */
      var penaltyThis = (burstMax > 1) ? Math.min(MOD_CAP, (shotIdx - 1) + priorShots) : 0;
      var args = Object.assign(ruleOptsOf(this.state.meta), {   // v2.3.0（第 7 项）：透传阈值
        attack: { name: attacker.skill, value: attacker.value, ranged: !!attacker.ranged },
        defense: { name: defender.skill, value: defender.value,
                   mode: noDefense ? 'none' : ((reaction === 'counter') ? 'fightback' : (reaction === 'dodge' ? 'dodge' : 'none')) },
        damage: { expr: dmgExpr.expr, db: db },
        armor: { value: armorValue },
        impale: weaponPierce,
        difficulty: p.difficulty || 'REGULAR',
        bonus: num(p.bonus, 0), penalty: Math.min(MOD_CAP, num(p.penalty, 0) + penaltyThis),
        secret: !!p.secret,
        ranged: !!attacker.ranged,
        rng: p.rng || this.rng
      });
      var res = (rules && typeof rules.resolveAttack === 'function') ? rules.resolveAttack(args) : null;
      if (!res) { this._push(out, this._sysTo(bySeat, '规则服务无法结算攻击对抗')); return out; }

      /* v2.3.0（用户第 10 项）：枪械攻击故障判定（每一发都用本次攻击掷值；大成功不故障）。 */
      this._applyMalfunction(out, seatOfAttacker, weapon,
        res.attack ? res.attack.value : 0, !!(res.attack && res.attack.critical), p.malfType);

      /* v2.4.0（用户第 ⑧ 项）：无法反抗 → 攻击掷骰照常记录，对抗自动成功
         （攻击检定本身失败也按自动命中补掷伤害，保留极难/大成功贯穿）。 */
      if (noDefense) {
        this._forceAutoHit(res, rules, dmgExpr.expr, db, armorValue, weaponPierce, p.rng || this.rng);
      }

      firedCount++;
      lastRes = res;
      var outcome = res.outcome || 'miss';
      var attackerWins = (outcome === 'hit' || outcome === 'attacker_wins');
      var defenderWins = (outcome === 'defender_wins');
      lastAttackerWins = attackerWins;

      /* 本发伤害结算（attackerWins → 打目标；defenderWins → 反击打攻击方） */
      var dmg = null;
      if (attackerWins || defenderWins) {
        var base = res.damage || {};
        dmg = { expr: base.expr, db: db, raw: num(base.raw, 0), armor: num(base.armor, armorValue),
                applied: num(base.applied, 0), impale: !!base.impale, by: attackerWins ? 'a' : 'b' };
        var applied = Math.max(0, dmg.applied);
        if (defenderWins) {
          /* 反击胜：伤害由防守方打在攻击方身上 */
          if (attacker.side === 'pc' && attacker.seat) {
            out = out.concat(this._opposedDamagePlayer(attacker.seat, applied, '对抗反击'));
          } else if (attacker.actorId) {
            out = out.concat(this._opposedDamageMonster(attacker.actorId, applied));
          }
        } else {
          /* 攻方胜：打防守方 */
          if (defender.side === 'pc' && defender.seat) {
            out = out.concat(this._opposedDamagePlayer(defender.seat, applied, '武器对抗'));
          } else if (defender.actorId) {
            out = out.concat(this._opposedDamageMonster(defender.actorId, applied));
          }
        }
      }
      lastDmg = dmg;

      /* 逐发公开记录：第 1 发带整包连发信息（兼容 v2.3.0 文案），后续发只记本条。
         （canDefer 且本发胜利 → 记录改由选怪流程统一落，避免两条重复结果卡） */
      if (!canDefer || !attackerWins) {
        var shotNoteThis;
        if (burstMax > 1) {
          shotNoteThis = (shotIdx === 1)
            ? (shotNote + '　·　逐发串行判定：第 1/' + shots + ' 发（惩罚骰 +' + penaltyThis + '）')
            : ('连发第 ' + shotIdx + '/' + shots + ' 发（惩罚骰 +' + penaltyThis + '）');
        } else {
          shotNoteThis = shotNote || null;
        }
        this._emitOpposedCheck(out,
          this._opposedCheckPayload(res, attacker, defender, reaction, dmg, shotNoteThis),
          !!p.secret);
      }

      /* 继续条件：胜利且造成伤害；且目标仍未倒下（否则后续发无的放矢） */
      if (!attackerWins) { stopReason = '第 ' + shotIdx + ' 发未命中，连发中断'; break; }
      if (!dmg || dmg.applied <= 0) { stopReason = '第 ' + shotIdx + ' 发未造成伤害，连发中断'; break; }
      if (defender.actorId) {
        var slotNow = this._findCombatSlot(defender.actorId);
        var pubNow = slotNow && slotNow.public;
        var hpNow = num(pubNow && pubNow.hp, NaN);
        if (pubNow && (pubNow.down || pubNow.state === 'dead' || (isFinite(hpNow) && hpNow <= 0))) {
          stopReason = '目标已倒下，连发中断';
          break;
        }
      }
    }
    /* 按**实际打出数**记账（被打断时少于计划数） */
    if (fromRequest && burstMax > 1) this._fireUsed[fireKey] = priorShots + firedCount;

    /* ---- 玩家申请 + 单发 + 玩家胜 + 多只存活怪物 → 让玩家选怪（伤害待选怪后再补）---- */
    if (canDefer && lastAttackerWins) {
      /* 先落一条「对抗结果（待选目标）」记录，伤害待选怪后再补（秘密对抗只留脱敏行）。 */
      this._emitOpposedCheck(out,
        this._opposedCheckPayload(lastRes, attacker, defender, reaction, null,
          '待选择伤害目标' + (shotNote ? ('　·　' + shotNote) : '')),
        !!p.secret);
      /* ⚠️ 顺序很关键：emit(EVT.OPPOSED) 会触发 reduce，把 state.opposed 覆盖成
         「精简载荷（只带 id/phase/monsters）」——所以**rich 状态必须在 emit 之后**写入，
         否则 weapon/dmgExpr/armor/win 全丢，玩家选怪时算不出伤害。 */
      this._push(out, this.emit(EVT.OPPOSED,
        { id: st.id, by: st.by, phase: 'await_target', targetId: st.targetId, targetName: st.targetName,
          monsters: monsters.map(function (s) { return { id: s.actorId || s.id, name: s.name }; }), at: this.now() },
        VIS.SEAT, st.by));
      /* 记录裁定结果，等玩家选怪后再结算伤害：把武器/DB/护甲/贯穿信息暂存。
         secret 一并暂存 → 选怪后的最终伤害卡也走「秘密」通道，不泄漏给玩家。 */
      this.state.opposed = Object.assign({}, st, {
        phase: 'await_target',
        secret: !!p.secret,
        weapon: weapon, db: db, armor: armorValue,
        pierce: weaponPierce, dmgExpr: dmgExpr.expr,
        monsters: monsters.map(function (s) { return { id: s.actorId || s.id, name: s.name }; }),
        win: { a: { name: attacker.name, value: lastRes.attack.value, level: lastRes.attack.level,
                    levelText: lastRes.attack.levelText },
               b: { name: defender.name, value: lastRes.defense ? lastRes.defense.value : defender.value,
                  level: lastRes.defense ? lastRes.defense.level : null,
                  levelText: lastRes.defense ? lastRes.defense.levelText : '' },
               reaction: reaction, decidedBy: (lastRes.compare && lastRes.compare.decidedBy) || '',
               rounds: (lastRes.compare && lastRes.compare.rounds) || [],
               fallback: !!(lastRes.compare && lastRes.compare.fallback) },
        at: this.now()
      });
      this._push(out, this._sysTo(st.by, '对抗胜利！请选择要造成伤害的目标'));
      return out;
    }

    /* 连发中断 → 公开记录说明原因（含实际打出数）；单发武器不写「连发」文案 */
    if (stopReason && burstMax > 1) {
      this._push(out, this.emit(EVT.LOG,
        { text: OPPOSED_PREFIX + stopReason + '（共打出 ' + firedCount + '/' + shots + ' 发）', at: this.now() },
        VIS.PUBLIC));
    }
    if (fromRequest) this.state.opposed = null;
    return out;
  };

  /** v2.4.0（用户第 ⑧ 项）：「无法反抗」自动命中兜底。
   *   resolveAttack 已按 mode='none' 跑完攻击掷骰：攻击成功时本就是 HIT（伤害已掷），
   *   只打标记；攻击检定失败（落空）时也按「自动命中」补掷伤害（武器式 + DB + 贯穿：
   *   极难/大成功且贯穿武器时取最大值并追加伤害骰），并把结局改写为攻方胜。 */
  Host.prototype._forceAutoHit = function (res, rules, expr, db, armorValue, pierce, rng) {
    if (!res) return res;
    res.noDefense = true;
    var alreadyHit = (res.outcome === 'hit' || res.outcome === 'attacker_wins');
    if (!alreadyHit) {
      /* 攻击检定失败也按「自动命中」补掷伤害（武器式 + DB + 贯穿：
         极难/大成功且贯穿武器时取最大值并追加伤害骰）。 */
      var attack = res.attack || {};
      var main = (rules && typeof rules.rollExpr === 'function') ? rules.rollExpr(expr, rng) : null;
      if (main && main.ok) {
        var dbRoll = (rules && typeof rules.rollDamageBonus === 'function') ? rules.rollDamageBonus(db, rng) : { total: 0 };
        var raw = main.total + (dbRoll ? dbRoll.total : 0);
        var impale = false;
        /* 贯穿在「极难成功或大成功」时触发（数值等级 4 / 5），公式统一走 impaleDamage */
        if (pierce && (attack.level === 4 || attack.level === 5) && rules && typeof rules.impaleDamage === 'function') {
          var imp = rules.impaleDamage(expr, db, rng);
          if (imp && imp.ok) { raw = imp.raw; impale = true; }
        }
        var armorV = Math.max(0, num(armorValue, 0));
        res.outcome = 'attacker_wins';
        res.damage = { raw: raw, expr: expr, dbDice: dbRoll, impale: impale,
                       armor: armorV, applied: Math.max(0, raw - armorV) };
      } else {
        res.outcome = 'attacker_wins';
      }
    }
    /* mode='none' 时 compare 恒为 null → 统一补「攻方胜」结论，避免文案出现「未分 胜」 */
    res.compare = { winner: 'a', decidedBy: 'auto', rounds: [] };
    return res;
  };

  /** 组装对抗攻击的 EVT.CHECK 载荷（含 reaction/rounds/fallback/damage）。 */
  Host.prototype._opposedCheckPayload = function (res, attacker, defender, reaction, dmg, note) {
    var cmp = res.compare || {};
    var rounds = cmp.rounds || [];
    var aLevelText = res.attack ? res.attack.levelText : '';
    var dLevelText = res.defense ? res.defense.levelText : '';
    /* v2.4.0（用户第 ⑧ 项）：无法反抗 → 文案写明「跳过对抗判定，自动命中」 */
    var noDefense = !!(res.noDefense || (defender && defender.noDefense));
    var reactionText = noDefense ? '无法反抗'
      : (reaction === 'counter' ? '反击' : (reaction === 'dodge' ? '闪避' : '不防御'));
    var s = OPPOSED_PREFIX + attacker.name + ' 发起对抗（' + attacker.skill + ' ' + attacker.value + '） vs ' +
      defender.name + '（' + reactionText + (noDefense ? '' : (' ' + defender.value)) + '）';
    s += '\n攻方 ' + aLevelText + '（掷 ' + (res.attack ? res.attack.value : '') + '）';
    if (!noDefense) {
      s += ' vs 守方 ' + dLevelText + '（掷 ' + (res.defense ? res.defense.value : '') + '）';
    }
    if (res.coercedFromFightback) s += '\n远程攻击：目标不能反击，按闪避处理';
    var winnerName = cmp.winner === 'a' ? attacker.name
      : (cmp.winner === 'b' ? defender.name : '未分');
    if (res.outcome === 'miss') {
      s += '\n→ 落空 / 被躲开：未造成伤害';
    } else if (res.outcome === 'attacker_wins' || res.outcome === 'hit') {
      s += '\n→ ' + winnerName + ' 胜' + (noDefense ? '（对方无法反抗，自动命中）' : '');
    } else if (res.outcome === 'defender_wins') {
      s += '\n→ ' + winnerName + ' 胜（反击命中）';
    }
    /* 逐轮重掷明细 */
    s += buildOpposedRerollLines(rounds, attacker.name, defender.name, cmp.fallback);
    /* 伤害段：失败 / 被躲开（damage=null）**不显示**伤害行 */
    if (dmg) {
      if (dmg.by === 'a') {
        s += '\n命中：伤害 ' + (dmg.expr || '0') + '+' + (dmg.db || '0') + '=' + dmg.raw +
          '，护甲 ' + dmg.armor + '，实扣 ' + dmg.applied + (dmg.impale ? '（贯穿：取最大值并追加伤害骰）' : '');
      } else {
        s += '\n反击命中：由 ' + defender.name + ' 造成 ' + dmg.applied + ' 点伤害（伤害骰 ' + dmg.raw +
          '，护甲 ' + dmg.armor + '）';
      }
    }
    if (note) s += '\n（' + note + '）';
    return {
      id: 'o' + (++this.localSeq), kind: 'opposed',
      targets: [attacker.seat, defender.seat].filter(Boolean),
      skill: attacker.skill + ' vs ' + defender.skill,
      difficulty: (res.attack && res.attack.difficulty) || 'REGULAR',
      a: { ref: attacker.seat || attacker.actorId || '', name: attacker.name,
           value: res.attack ? res.attack.value : attacker.value,
           level: res.attack ? res.attack.level : null, levelText: aLevelText },
      b: { ref: defender.seat || defender.actorId || '', name: defender.name,
           value: res.defense ? res.defense.value : defender.value,
           level: res.defense ? res.defense.level : null, levelText: dLevelText },
      winner: cmp.winner || null, tie: false,
      reaction: reaction, decidedBy: cmp.decidedBy || '', rounds: rounds,
      fallback: !!cmp.fallback, damage: dmg,
      summary: s, at: this.now()
    };
  };

  /** 找到战斗槽（按 actorId 或槽 id）。 */
  Host.prototype._findCombatSlot = function (id) {
    var c = this.state.combat;
    if (!c || !Array.isArray(c.order) || !id) return null;
    for (var i = 0; i < c.order.length; i++) {
      if (c.order[i].actorId === id || c.order[i].id === id) return c.order[i];
    }
    return null;
  };

  /** 按名字找战斗槽（v2.2.1·2c：actorId 缺省时的兜底匹配键）。 */
  Host.prototype._findCombatSlotByName = function (name) {
    var q = cleanText(name, 40);
    var c = this.state.combat;
    if (!q || !c || !Array.isArray(c.order)) return null;
    for (var i = 0; i < c.order.length; i++) {
      if (cleanText(c.order[i].name, 40) === q) return c.order[i];
    }
    return null;
  };

  /** 存活怪物清单（战斗槽 kind==='monster' 且未死 / 未离场）。 */
  Host.prototype._aliveMonsters = function () {
    var c = this.state.combat;
    if (!c || !Array.isArray(c.order)) return [];
    return c.order.filter(function (s) {
      if (!s || s.kind !== 'monster') return false;
      var pub = s.public || {};
      if (pub.down || pub.state === 'dead') return false;
      if (pub.hp !== undefined && pub.hp !== null && num(pub.hp, 0) <= 0) return false;
      return true;
    });
  };

  /** 在人物卡武器清单里按名匹配（找不到返回 null）。 */
  Host.prototype._matchSheetWeapon = function (mem, name) {
    var list = (mem && mem.sheet && Array.isArray(mem.sheet.weapons)) ? mem.sheet.weapons : [];
    var q = cleanText(name, 40);
    if (!q) return list.length ? list[0] : null;
    for (var i = 0; i < list.length; i++) if (cleanText(list[i].name, 40) === q) return list[i];
    return null;
  };

  /** 对玩家造成伤害（反击 / 武器命中）——走 settleWounds 做死亡判定。
   *  v2.4.0（用户第 ⑥ 项）：结算后把伤害**同步写回该玩家的战斗槽** public.hp
   *  （并处理 down/dead 标注）—— 修复「成员卡/角色信息显示掉血、但战斗模式
   *  『当前行动轮』列表里玩家血量不变（怪物的会变）」的两端不一致。
   *  怪物路径（_opposedDamageMonster）不经过这里，不受影响。 */
  Host.prototype._opposedDamagePlayer = function (seat, amount, reason) {
    var out = [];
    if (!(amount > 0)) return out;
    var m = this.roster.get(seat);
    if (!m) return out;
    /* v2.8.0（HP 机制 · 用户第 1 项）：经统一 HP 收口 applyHpChange（→ settleWounds）。 */
    out = out.concat(this.applyHpChange(m, -amount, reason || '对抗伤害'));
    /* ---- v2.4.0（用户第 ⑥ 项）：战斗槽 HP 同步（玩家被怪物反击命中掉血） ---- */
    var c = this.state.combat;
    if (c && Array.isArray(c.order) && c.order.length) {
      var hpNow = memberStatusValue(m, 'currentHP');
      var synced = false;
      for (var i = 0; i < c.order.length; i++) {
        var slot = c.order[i];
        if (!slot || slot.kind !== 'pc') continue;
        if (slot.seat !== seat && slot.actorId !== seat) continue;
        var pub = slot.public || (slot.public = {});
        if (!isFinite(Number(pub.hp))) pub.hp = num(pub.hpMax, hpNow == null ? 0 : hpNow);
        if (hpNow != null) pub.hp = Math.max(0, hpNow);
        this._push(out, this.emit(EVT.ACTOR, { actor: slot }, VIS.PUBLIC));
        synced = true;
      }
      if (synced) {
        /* v2.8.0（HP 机制 · 用户第 2 项）：昏迷/濒死/死亡同步到槽 down。 */
        out = out.concat(this._syncBodyToCombatSlot(m));
        this._push(out, this.emit(EVT.TURNSTATE,
          { turn: c.turn, round: c.round, order: c.order }, VIS.PUBLIC));
      }
    }
    return out;
  };

  /** 对怪物造成伤害（扣战斗槽 HP）。
   *  v2.2.1（用户第 2 项·2c）修复：
   *    · 找不到目标槽时**不再静默** —— 给 KP 一条明确提示（否则「记录说命中、怪物却没掉血」）；
   *    · 战斗槽尚无 `public.hp` 时用 `hpMax` 兜底初始化，避免「从 0 扣 → 恒为 0」；
   *    · 匹配键统一走 `_findCombatSlot`（actorId 或槽 id 任一）。 */
  Host.prototype._opposedDamageMonster = function (actorId, amount) {
    var out = [];
    if (!(amount > 0)) return out;
    var slot = this._findCombatSlot(actorId);
    if (!slot) {
      this._push(out, this._sysTo(HOST_SEAT,
        '对抗伤害：找不到目标战斗单位「' + (cleanText(actorId, 40) || '（未指定）') +
        '」，怪物未扣血 —— 请在战斗列表核对目标'));
      return out;
    }
    var pub = slot.public || (slot.public = {});
    if (!isFinite(Number(pub.hp))) pub.hp = num(pub.hpMax, 0);
    pub.hp = Math.max(0, num(pub.hp, 0) - amount);
    if (pub.hp <= 0) { pub.down = true; pub.state = 'dead'; }
    this._push(out, this.emit(EVT.ACTOR, { actor: slot }, VIS.PUBLIC));
    return out;
  };

  /**
   * v2.6.0（用户第 3 项）：玩家发起战斗对抗时，判断当前是否**该玩家的行动轮次**。
   *
   * ⚠️ 必须与 `room-panels.js#isMyTurn` 保持**同一口径**（UI 与模型两道门禁）：
   *   · 当前行动槽 `combat.order[combat.turn]` 必须存在；
   *   · 其 `kind` 必须是 'pc'（怪物 / NPC 槽不算任何人的轮次）；
   *   · 其 `seat` 必须与发起者座位一致（同一 pc 的多个行动槽都接受）。
   *
   * 无战斗态（`state.combat` 为空 / 无行动序）时不拦 —— 保持旧行为，
   * 让「没有战斗数据」的场景继续走原有的「没有可选的怪物」等更贴切的报错。
   *
   * ⚠️ 只用于玩家**发起**对抗（phase 'request'）；玩家被攻击时的「反击 / 闪避」
   *    走 KP 的 `check.opposed`（checkOpposed），不经过本判据，不受影响。
   *
   * @param {string} seat 发起者座位
   * @returns {boolean} true = 当前正是该玩家的行动轮次（或非战斗态，不拦）
   */
  Host.prototype._isMyActionTurn = function (seat) {
    var c = this.state.combat;
    if (!c || !Array.isArray(c.order) || !c.order.length) return true;
    var cur = c.order[c.turn] || null;
    if (!cur) return false;
    if (cur.kind !== 'pc') return false;
    return !!(cur.seat && seat && cur.seat === seat);
  };

  /* ------------------------------------------------------------
   * v2.2.0（用户第 3 项）：玩家发起武器对抗（INTENT.OPPOSED）
   *   phase 'request' —— 申请（选武器 + 选目标怪物）→ 建待办，通知 KP。
   *   phase 'target'  —— 胜后选怪 → 结算武器伤害。
   * ------------------------------------------------------------ */
  Host.prototype.opposed = function (seat, mem, role, p) {
    var out = [];
    p = p || {};
    if (role !== ROLE.PLAYER) { this._push(out, this._sysTo(seat, '只有玩家能发起武器对抗')); return out; }
    if (!mem) { this._push(out, this._sysTo(seat, '找不到你的成员信息')); return out; }
    if (memberRipped(mem) || memberInBout(mem)) {
      this._push(out, this._sysTo(seat, '你的角色当前无法发起对抗（撕卡 / 疯狂发作中）'));
      return out;
    }
    var phase = p.phase || 'request';
    if (phase === 'target') return this._opposedPlayerTarget(seat, mem, p);
    return this._opposedPlayerRequest(seat, mem, p);
  };

  Host.prototype._opposedPlayerRequest = function (seat, mem, p) {
    var out = [];
    var cur = this.state.opposed;
    if (cur && cur.phase === 'await_kp' && cur.by === seat) {
      this._push(out, this._sysTo(seat, '你已有一条待处理的对抗申请'));
      return out;
    }
    /* v2.6.0（用户第 3 项）：玩家只能在**自己的行动轮次**发起战斗对抗（模型兜底）。
       判据与 room-panels.js#isMyTurn 一致（见 _isMyActionTurn 注释）。
       ⚠️ 只拦「发起」；玩家被攻击时的反击 / 闪避是 KP 的 check.opposed，
       不经过这里，不受影响。 */
    if (!this._isMyActionTurn(seat)) {
      this._push(out, this._sysTo(seat, '只能在你的行动轮次发起战斗对抗'));
      return out;
    }
    /* 武器：从**权威人物卡**取（申请载荷只用来指认名字） */
    var reqWeapon = p.weapon || {};
    var weapon = this._matchSheetWeapon(mem, reqWeapon.name);
    if (!weapon) {
      this._push(out, this._sysTo(seat, '你的角色卡里没有这把武器「' + cleanText(reqWeapon.name, 40) + '」，无法发起对抗'));
      return out;
    }
    /* v2.3.0（用户第 10 项）：损坏 / 报废的武器不能再用于对抗（发起时校验并明确提示）。 */
    if (weapon.broken) {
      this._push(out, this._sysTo(seat, '「' + cleanText(weapon.name, 40) +
        '」已损坏，不能用于对抗（请先在车卡里更换或修复）'));
      return out;
    }
    var dmgExpr = weaponDamageExpr(weapon.damage, this.rules);
    if (!dmgExpr.ok) { this._push(out, this._sysTo(seat, '该武器伤害式非法，无法发起对抗')); return out; }
    var db = (mem.sheet && mem.sheet.db) ? mem.sheet.db : (cleanText(p.db, 10) || '0');
    /* v2.3.0（用户第 8 项）：连发武器 —— 最多发射数（perRound）。
       · 恰好 2 发 → 发起前**必须先选**「打 1 发 / 打 2 发」；
       · ≥3 发 → 可连续发起（权威端按本轮已发射次数累加惩罚骰）。 */
    var rules = this.rules;
    var perRound = cleanText(weapon.perRound, 12);
    var burstMax = (rules && typeof rules.burstMaxOf === 'function') ? rules.burstMaxOf(perRound) : 1;
    var shots = 1;
    if (burstMax === 2) {
      var reqShots = num(p.shots, 0);
      if (reqShots !== 1 && reqShots !== 2) {
        this._push(out, this._sysTo(seat, '该武器每轮最多发射 2 发，发起前请先选择「打 1 发 / 打 2 发」'));
        return out;
      }
      shots = reqShots;
    } else if (burstMax > 2) {
      var rs2 = num(p.shots, 0);
      shots = (rs2 >= 1 && rs2 <= burstMax) ? Math.floor(rs2) : 1;
    }
    /* 目标：必须是「已设置怪物」里存活的怪物 */
    var monsters = this._aliveMonsters();
    if (!monsters.length) { this._push(out, this._sysTo(seat, '没有可选的怪物（请让 KP 先设置怪物并进入战斗）')); return out; }
    var tid = cleanText(p.targetId, 64);
    var slot = this._findCombatSlot(tid);
    if (!slot || slot.kind !== 'monster' || monsters.indexOf(slot) < 0) {
      this._push(out, this._sysTo(seat, '目标怪物不存在或已死亡/离场'));
      return out;
    }
    var st = {
      id: 'op' + (++this.localSeq), by: seat, byName: this._nick(mem, seat),
      phase: 'await_kp',
      weapon: { name: weapon.name, skill: weapon.skill, damage: weapon.damage,
                pierce: weapon.pierce, perRound: perRound,
                malfunction: cleanText(weapon.malfunction, 8), ammo: cleanText(weapon.ammo, 20) },
      shots: shots, burstMax: burstMax,
      db: db, targetId: slot.actorId || slot.id, targetName: slot.name || '怪物',
      note: cleanText(p.note, 80), at: this.now()
    };
    this.state.opposed = st;
    /* 申请只发给 KP（SEAT）；其余人收水位标记。 */
    this._push(out, this.emit(EVT.OPPOSED,
      { id: st.id, by: seat, byName: st.byName, phase: 'await_kp', weapon: st.weapon, db: st.db,
        shots: st.shots, burstMax: st.burstMax,
        targetId: st.targetId, targetName: st.targetName, note: st.note, at: st.at },
      VIS.SEAT, HOST_SEAT));
    /* v2.3.0（用户第 8 项）：回话里带上「本轮已发射 n/max，本次惩罚骰 +k」的信息。 */
    var fireInfo = '';
    if (burstMax > 1) {
      var prior = num(this._fireUsed[seat + '\u0000' + cleanText(weapon.name, 40)], 0);
      fireInfo = '（本轮已发射 ' + prior + '/' + burstMax + '，本次 ' + shots + ' 发，惩罚骰 +' +
        Math.min(MOD_CAP, (shots - 1) + prior) + '）';
    }
    this._push(out, this._sysTo(seat, '已发送对抗申请，等待 KP 处理' + fireInfo));
    return out;
  };

  /** 玩家胜后选怪 → 结算武器伤害（沿用 parseExpr/rollExpr/rollDamageBonus + 贯穿 + 护甲）。 */
  Host.prototype._opposedPlayerTarget = function (seat, mem, p) {
    var out = [];
    var st = this.state.opposed;
    if (!st || st.phase !== 'await_target' || st.by !== seat) {
      this._push(out, this._sysTo(seat, '当前没有待选择的对抗目标'));
      return out;
    }
    var tid = cleanText(p.targetId, 64);
    var slot = this._findCombatSlot(tid);
    var monsters = this._aliveMonsters();
    if (!slot || slot.kind !== 'monster' || monsters.indexOf(slot) < 0) {
      this._push(out, this._sysTo(seat, '所选目标不存在或已死亡/离场'));
      return out;
    }
    var rules = this.rules;
    var expr = st.dmgExpr || weaponDamageExpr(st.weapon && st.weapon.damage, rules).expr;
    var armor = Math.max(0, num(st.armor, 0));
    var res = (rules && typeof rules.rollExpr === 'function') ? rules.rollExpr(expr) : null;
    if (!res || !res.ok) { this._push(out, this._sysTo(seat, '武器伤害式结算失败')); this.state.opposed = null; return out; }
    var dbRoll = rules.rollDamageBonus(st.db);
    var raw = res.total + dbRoll.total;
    var impale = false;
    /* v2.3.0（用户第 9 项）：贯穿判定**收敛到 LEVEL 枚举（禁止正则）**，
       公式收敛到 CocRules#impaleDamage（与 room-rules#resolveAttack 同一实现）。
       贯穿在「极难成功或大成功」时触发（数值等级 4 / 5）。 */
    var aLevel = (st.win && st.win.a && typeof st.win.a.level === 'number') ? st.win.a.level : null;
    if (st.pierce && aLevel !== null && (aLevel === rules.LEVEL.EXTREME || aLevel === rules.LEVEL.CRITICAL)) {
      var imp = (typeof rules.impaleDamage === 'function') ? rules.impaleDamage(expr, st.db) : null;
      if (imp && imp.ok) { raw = imp.raw; impale = true; }
    }
    var applied = Math.max(0, raw - armor);
    var dmg = { expr: expr, db: st.db, raw: raw, armor: armor, applied: applied, impale: impale, by: 'a' };
    out = out.concat(this._opposedDamageMonster(slot.actorId || slot.id, applied));
    var w = st.win || {};
    var attacker = { name: st.byName || '玩家', skill: (st.weapon && st.weapon.skill) || '格斗',
                     value: (w.a && w.a.value) || '', actorId: '', seat: seat };
    var defender = { name: slot.name || '怪物', skill: '', value: (w.b && w.b.value) || '', actorId: slot.actorId || slot.id };
    /* secret 从 await_target 暂存态继承 → 秘密对抗的最终伤害卡也只给 KP（公共留脱敏行）。 */
    this._emitOpposedCheck(out, {
      id: 'o' + (++this.localSeq), kind: 'opposed',
      targets: [seat], skill: attacker.skill + ' vs 目标',
      difficulty: 'REGULAR',
      a: { ref: seat, name: attacker.name, value: attacker.value,
           level: null, levelText: (w.a && w.a.levelText) || '' },
      b: { ref: defender.actorId, name: defender.name, value: defender.value,
           level: null, levelText: (w.b && w.b.levelText) || '' },
      winner: 'a', tie: false, reaction: (w.reaction || ''), decidedBy: (w.decidedBy || ''),
      rounds: (w.rounds || []), fallback: !!w.fallback, damage: dmg,
      summary: OPPOSED_PREFIX + attacker.name + ' 用「' + ((st.weapon && st.weapon.name) || '武器') + '」攻击 ' +
        defender.name + ' → 命中：伤害 ' + expr + '+' + st.db + '=' + raw + '，护甲 ' + armor + '，实扣 ' + applied +
        (impale ? '（贯穿：取最大值并追加伤害骰）' : ''),
      at: this.now()
    }, !!st.secret);
    /* v2.2.0（用户第 3 项）：通知发起玩家的客户端核销待办（否则 await_target 残留，
       会让客户端反复弹「选择伤害目标」）。phase='resolved' → Client.reduce 置空。 */
    this._push(out, this.emit(EVT.OPPOSED, { id: st.id, by: seat, phase: 'resolved', at: this.now() }, VIS.SEAT, seat));
    this.state.opposed = null;
    return out;
  };


  /* ---- 场景检定步骤引擎（契约 §5.1 / §5.3 / §4.3）---- */

  /** 推场景检定：支持可编辑步骤、按序处理多个玩家、成功/失败分支、失败掷伤害 */
  Host.prototype.sceneCheckPush = function (bySeat, p) {
    var out = [];
    var steps = sanitizeSceneSteps(p && p.steps);
    if (!steps.length) { this._push(out, this._sysTo(bySeat, '至少要有一个检定步骤')); return out; }
    var sc = {
      id: 'sc' + (++this.localSeq),
      title: cleanText(p && p.title, 60) || '场景检定',
      desc: cleanText(p && p.desc, 200),
      steps: steps, cursor: 0, results: [], at: this.now()
    };
    this._push(out, this.emit(EVT.SCENE_CHECK, sc, VIS.PUBLIC));
    this._push(out, this._sys('KP 推送了场景检定「' + sc.title + '」（' + steps.length + ' 步）'));
    /* v2.1.7（用户 bug 反馈）：首个目标若已锁死（撕卡/疯狂发作），立即自动判定 */
    out = out.concat(this._autoAdvanceSceneCheck());
    return out;
  };

  /**
   * v2.1.7（用户 bug 反馈）：场景检定**自动跳过/自动判定**锁死目标的步骤。
   *
   * 目标玩家被锁（撕卡 / 疯狂发作中）时他无法操作，步骤会永远挂着 ——
   * KP 还以为在等玩家。这里推进这些步骤，直到遇到可操作的目标或检定结束。
   *   · 疯狂发作中（memberInBout）→ sceneCheckStep 的自动分支由权威端替他掷骰（v2.1.6）；
   *   · 已撕卡（memberRipped）→ sceneCheckStep 改为**跳过并提示**（v2.7.0，不再替他掷骰）。
   * 只处理**指定座位**的步骤；'*' 全员步仍留给 KP（各人各自掷）。
   * steps 有限且每次判定都前进游标 → 必然终止。
   */
  Host.prototype._autoAdvanceSceneCheck = function () {
    var out = [];
    var guard = 0;
    var sc = this.state.sceneCheck;
    while (sc && sc.steps && (sc.cursor || 0) < sc.steps.length && guard++ < 30) {
      var step = sc.steps[sc.cursor || 0];
      var seat = cleanText(step.targetSeat, 64) || '';
      if (!seat || seat === '*') break;
      var m = this.roster.get(seat);
      if (!m || !(memberRipped(m) || memberInBout(m))) break;
      out = out.concat(this.sceneCheckStep(HOST_SEAT, { stepId: step.id, seat: seat }));
      sc = this.state.sceneCheck;   /* sceneCheckStep 已通过 emit 更新 */
    }
    return out;
  };

  /**
   * v2.7.0（第 3 项 · 模型守卫）：场景检定遇到**已撕卡**（死亡 / 永久疯狂）的目标时，
   * 跳过该步并提示 —— 绝不替他掷骰 / 结算伤害，也不让整条检定失败。
   * 游标前进到下一步，结果表里留一条 skipped 记录，随后继续自动推进后续步骤
   * （终点由 steps 有限 + 游标前进保证，见 _autoAdvanceSceneCheck 的循环）。
   */
  Host.prototype._skipSceneStep = function (bySeat, sc, idx, step, seat, m) {
    var out = [];
    var who = this._nick(m, seat);
    var result = { stepId: step.id, seat: seat, level: null, ok: false, skipped: true,
                   note: '已撕卡，跳过', damage: 0, damageExpr: '', at: this.now() };
    var nextSc = clone(sc);
    nextSc.results = (nextSc.results || []).concat([result]);
    nextSc.cursor = Math.min(idx + 1, nextSc.steps.length);
    nextSc.at = this.now();
    this._push(out, this.emit(EVT.SCENE_CHECK, nextSc, VIS.PUBLIC));
    /* 逐条提示：给发起者私密一行（KP 看得到为什么这一步没人掷），公共记录留一条醒目行。 */
    this._push(out, this._sysTo(bySeat || HOST_SEAT,
      '「' + who + '」已撕卡（死亡/永久疯狂），已跳过场景检定「' + step.title + '」'));
    this._push(out, this.emit(EVT.LOG, {
      seat: '', text: '场景检定「' + step.title + '」：' + who + ' 已撕卡，跳过该步',
      at: this.now(), kind: 'warn'
    }, VIS.PUBLIC));
    out = out.concat(this._autoAdvanceSceneCheck());
    return out;
  };

  /** 结算当前步（或指定步）：按成功等级挑分支、应用伤害、跳转下一步 */
  Host.prototype.sceneCheckStep = function (bySeat, p) {
    var out = [];
    var sc = this.state.sceneCheck;
    if (!sc || !sc.steps || !sc.steps.length) {
      this._push(out, this._sysTo(bySeat, '当前没有进行中的场景检定'));
      return out;
    }
    p = p || {};
    var idx = -1;
    if (p.stepId) {
      for (var i = 0; i < sc.steps.length; i++) if (sc.steps[i].id === p.stepId) { idx = i; break; }
    } else {
      idx = sc.cursor || 0;
    }
    if (idx < 0 || idx >= sc.steps.length) {
      this._push(out, this._sysTo(bySeat, '找不到该步骤'));
      return out;
    }
    var step = sc.steps[idx];
    var rules = this.rules;
    /* v2.1.6（用户第 7 项）：目标玩家处于**疯狂发作中**时由系统自动随机判定 ——
       权威端替他掷一次 D100（对该步骤技能值），玩家无需也不可操作。
       v2.7.0（第 3 项）：已撕卡（死亡 / 永久疯狂）则改为跳过该步（见下），不再替他掷骰。 */
    var seatPre = cleanText(p.seat, 64) || step.targetSeat || '';
    var mPre = seatPre ? this.roster.get(seatPre) : null;
    /* v2.7.0（第 3 项 · 模型守卫）：目标已撕卡（死亡 / 永久疯狂）→ **不再替他掷骰**，
       而是跳过该步并提示（不结算伤害、不整体失败）。疯狂发作中（memberInBout）仍照
       v2.1.6 由系统自动随机判定（见下方分支），二者语义不同；KP 显式给了 p.level 时以
       KP 的裁定为准（不触发本跳过）。 */
    if ((p.level === undefined || p.level === null) && mPre && memberRipped(mPre)) {
      return out.concat(this._skipSceneStep(bySeat, sc, idx, step, seatPre, mPre));
    }
    var level;
    if (p.level === undefined || p.level === null) {
      if (mPre && memberInBout(mPre)) {
        var autoBase = this._skillBaseOf(mPre, step.skill, null);
        if (autoBase == null) autoBase = 50;
        var diff = (rules && typeof rules.normDifficulty === 'function')
          ? rules.normDifficulty(step.difficulty) : 'regular';
        var autoChk = (rules && typeof rules.check === 'function')
          ? rules.check(Object.assign({ base: autoBase, difficulty: diff, kind: 'skill',
                          label: (step.skill || '自动检定') + '（系统自动）', rng: this.rng },
                          ruleOptsOf(this.state.meta)))
          : { value: 1 + Math.floor((this.rng || Math.random)() * 100), level: 0, levelText: '', base: autoBase };
        level = (typeof autoChk.level === 'number') ? autoChk.level : 0;
        out = out.concat(this.diceRoll(seatPre, {
          expr: '1D100',
          label: '场景检定自动判定（' + (step.skill || '') + '，对 ' + autoBase + '，疯狂/撕卡状态由系统随机）',
          result: autoChk
        }));
      } else {
        level = 2;                    // 默认 regular（原行为）
      }
    } else {
      level = num(p.level, 2);
    }
    var plan = (rules && typeof rules.sceneStepResolve === 'function')
      ? rules.sceneStepResolve(step, level)
      : defaultSceneResolve(step, level);        // 兜底（规则服务缺失时）
    plan = plan || {};

    var seat = cleanText(p.seat, 64) || step.targetSeat || '';
    var ok = level >= 2;                          // REGULAR 及以上算成功
    var note = cleanText(plan.note, 120);
    var damageExpr = cleanText(plan.damage, 20);
    var result = { stepId: step.id, seat: seat, level: level, ok: ok,
                   note: note, damage: 0, damageExpr: damageExpr, at: this.now() };

    if (damageExpr && seat) {
      var dmg = 0;
      if (rules && typeof rules.rollExpr === 'function') {
        var rr = rules.rollExpr(damageExpr);
        if (rr && rr.ok) dmg = Math.max(0, num(rr.total, 0));
      } else {
        dmg = Math.max(0, num(damageExpr, 0));
      }
      result.damage = dmg;
      if (dmg > 0) {
        /* v2.8.0（HP 机制 · 用户第 1 项）★ **唯一漏判入口修复**：
           旧实现**直接 `stateApply` 写 HP**，绕过了死亡 / 重伤 / 归零判定
           （场景检定「失败造成致死/重伤伤害」时角色身体状态不会更新、也不会撕卡）。
           现改走**统一收口** `applyHpChange` —— 与其它所有扣血入口同一口径，
           保留原有「场景检定伤害」的骰式与日志语义（见下方 EVT.LOG）。 */
        var m = this.roster.get(seat);
        if (m) out = out.concat(this.applyHpChange(m, -dmg, '场景检定「' + step.title + '」失败'));
      }
    }

    var nextSc = clone(sc);
    nextSc.results = (nextSc.results || []).concat([result]);
    /* D 线 sceneStepResolve 回传 done 布尔（更稳）；同时兼容 next==='end'。 */
    if (plan.done === true || plan.next === 'end') nextSc.cursor = nextSc.steps.length;
    else if (plan.next) {
      var ni = -1;
      for (var j = 0; j < nextSc.steps.length; j++) if (nextSc.steps[j].id === plan.next) ni = j;
      nextSc.cursor = ni >= 0 ? ni : (idx + 1);
    } else {
      nextSc.cursor = idx + 1;
    }
    nextSc.at = this.now();
    this._push(out, this.emit(EVT.SCENE_CHECK, nextSc, VIS.PUBLIC));
    /* v2.3.0（用户第 7 项）：场景检定结果文案区分大成功 / 大失败
       （level 5 = rules.LEVEL.CRITICAL；-1 = rules.LEVEL.FUMBLE），与其它检定路径口径一致。 */
    var lvlWord = (rules && rules.LEVEL && level === rules.LEVEL.CRITICAL) ? '大成功'
      : ((rules && rules.LEVEL && level === rules.LEVEL.FUMBLE) ? '大失败' : (ok ? '成功' : '失败'));
    this._push(out, this.emit(EVT.LOG, {
      seat: bySeat,
      text: '场景检定「' + step.title + '」：' +
        (seat ? (this._nick(this.roster.get(seat), seat) + ' ') : '') +
        lvlWord + (note ? ('（' + note + '）') : '') +
        (result.damage ? ('，受到 ' + result.damage + ' 点伤害') : ''),
      at: this.now(), kind: 'check'
    }, VIS.PUBLIC));
    /* v2.1.7：下一步若也是锁死目标 → 继续自动判定（检定不挂起） */
    out = out.concat(this._autoAdvanceSceneCheck());
    return out;
  };

  /* ---- 挂起 / 复活（网络副作用由传输层触发，见 room-net.js）---- */

  /** 挂起房间：存档保留 30 天，可改天续玩 */
  Host.prototype.suspendRoom = function (bySeat) {
    var out = [];
    if (this.state.meta.status === STATUS.SUSPENDED) {
      this._push(out, this._sysTo(bySeat, '房间已经处于挂起状态'));
      return out;
    }
    out = out.concat(this.setStatus(STATUS.SUSPENDED));
    this._push(out, this._sys('房间已挂起，存档保留 30 天，可改天续玩'));
    return out;
  };

  /** 复活挂起房间（存档由传输层从服务器拉回并 adoptSave 后再调用本方法） */
  Host.prototype.resumeRoom = function (bySeat) {
    var out = [];
    out = out.concat(this.setStatus(STATUS.RECRUITING));
    this._push(out, this._sys('房间已复活，继续跑团'));
    /* 让所有在线玩家重新拉一次全量（他们可能已经断了很久） */
    var self = this;
    this.roster.list().forEach(function (m) {
      if (m.online) out.push({ to: m.seat, msg: self.syncFor(m.seat) });
    });
    return out;
  };

  /* ---- 存档（契约 §6.3：payload 是不透明字符串）---- */

  /**
   * 打包存档。**含 KP 私有内容**（要能续玩），但**不含** hostToken/mtoken/密码。
   * 玩家拉取时由调用侧按身份裁剪（见 playerViewFromSave）。
   */
  Host.prototype.save = function () {
    var st = this.state;
    return {
      v: 2,
      code: (st.meta && st.meta.code) || '',
      rules: (st.meta && st.meta.rules) || 'coc7',
      savedAt: this.now(),
      seq: this.log.seq,
      stateSeq: this._stateSeq,
      meta: clone(st.meta),
      members: this.roster.dump(),
      chats: clone(st.chats), logs: clone(st.logs), dice: clone(st.dice),
      scene: clone(st.scene), combat: clone(st.combat), sceneCheck: clone(st.sceneCheck),
      roundStarts: clone(this.roundStarts),
      privateBySeat: clone(this._privateBySeat),
      requestsBySeat: clone(this._requestsBySeat),
      boardBySeat: clone(this._boardBySeat),
      localAssets: clone(this.localAssets),
      localActors: clone(this.localActors)   /* v2.5.0（用户第 5 项）：探索态候选池跟着存档走 */
    };
  };

  Host.prototype.savePayload = function () { return JSON.stringify(this.save()); };

  /** 把一份存档灌回本 Host（保持引用稳定，UI 不必换对象）。 */
  Host.prototype.adoptSave = function (save) {
    save = save || {};
    var meta = save.meta || {};
    this.state = emptyState(meta);
    this.state.meta = clone(meta);
    this.state.members = clone(save.members || []);
    this.state.chats = clone(save.chats || []);
    this.state.logs = clone(save.logs || []);
    this.state.dice = clone(save.dice || []);
    this.state.scene = clone(save.scene || null);
    this.state.combat = clone(save.combat || null);
    this.state.sceneCheck = clone(save.sceneCheck || null);
    this.state.seq = num(save.seq, 0);

    /* 花名册：从存档重建（保持 seat / sheet / ready / charId）。续玩时都算离线，等重连。 */
    this.roster = new Roster();
    var that = this;
    (save.members || []).forEach(function (m) {
      if (!m || !m.seat) return;
      var rec = clone(m);
      /* v2.10.0（用户第 R5 项）：老存档续玩的一次性身体状态迁移（幂等）——
         本循环直接 clone，**不经过** sanitizeSheet / sanitizeStatus，老卡里的
         body='濒死' / '昏迷' 不会自动翻译，必须在此显式跑一次。
         ⚠️ 只做 body 迁移，**不做**全量重洗（其余字段原样保留）。 */
      if (rec.sheet && rec.sheet.status) migrateBodyStatus(rec.sheet.status);
      rec.online = false;
      that.roster.bySeat[rec.seat] = rec;
      if (that.roster.order.indexOf(rec.seat) < 0) that.roster.order.push(rec.seat);
    });

    this.roundStarts = clone(save.roundStarts || []);
    this._privateBySeat = clone(save.privateBySeat || {});
    this._requestsBySeat = clone(save.requestsBySeat || {});
    this._boardBySeat = clone(save.boardBySeat || {});
    this.localAssets = clone(save.localAssets || []);
    this.localActors = clone(save.localActors || []);   /* v2.5.0（用户第 5 项） */
    this._stateSeq = num(save.stateSeq, 0);
    this.log = new Log(this.log && this.log.cap);
    this.log.seq = num(save.seq, 0);
    this.snapshots = [{ seq: this.log.seq, state: clone(this.state) }];
    this.pending = [];
    this.rewind = null;
    return this;
  };

  /* ---- 内部小工具 ---- */

  Host.prototype._nick = function (m, seat) {
    /* v2.11.9（用户第 7 项）：公开信息栏**优先显示角色名**（玩家绑定的角色卡姓名），
       没有角色名才退回昵称 —— 之前是昵称优先，导致满屏「某玩家做了某事」。
       KP 座位无角色名时仍取 meta.kpName（供既有测试/文案沿用）。 */
    if (m && m.charName) return m.charName;
    if (m && m.nickname) return m.nickname;
    if (seat === HOST_SEAT) return (this.state.meta && this.state.meta.kpName) || 'KP';
    return '某人';
  };

  Host.prototype._sys = function (text) {
    return this.emit(EVT.LOG, { seat: '', text: text, at: this.now(), kind: 'sys' }, VIS.PUBLIC);
  };

  /** 系统提示只发给一个人（例如越权提醒），不要污染公共流 */
  Host.prototype._sysTo = function (seat, text) {
    return this.emit(EVT.PRIVATE, { title: '提示', text: text, at: this.now(), kind: 'sys' },
                     VIS.SEAT, seat);
  };

  /* ============================================================
   * Client —— 玩家 / 旁观者端（确定性回放）
   * ============================================================ */

  function Client(opts) {
    opts = opts || {};
    this.seat = opts.seat || '';
    this.role = opts.role || ROLE.PLAYER;
    this.state = emptyState(opts.meta);
    this.lastSeq = 0;
    this.gapFrom = 0;         // >0 表示检测到丢包，需要补拉
    /** v2.5.0（用户第 7 项·d）：补拉可观测性 —— 本次补拉的起点序号 / 累计次数 */
    this._resyncFromSeq = 0;
    this._resyncCount = 0;
    this.rejected = 0;        // 被丢弃的重复/过期事件数（诊断用）
    this.now = opts.now || function () { return Date.now(); };
    this.onChange = opts.onChange || function () {};
    /** 需要用户确认的改状态请求（KP 要求改我，我要点同意） */
    this.requests = [];
    /** v2.0.0：已应用到的角色卡状态写回序号（幂等用）。 */
    this.lastStateSeq = 0;
    /** v2.0.0：最近一次应用到本机的角色卡状态（供界面显示 / 断线后重放） */
    this.sheetState = null;
  }

  /**
   * 收到中继传来的原始消息。
   * 返回 {kind:'sync'|'evt'|'ignore', dup?, gap?, changed?}
   *   dup  = 序号重复（重连补拉必然出现，直接丢）
   *   gap  = 序号跳跃（丢包了），调用方应发 INTENT.SYNC 带 lastSeq 补拉
   */
  Client.prototype.receive = function (raw) {
    var m = (typeof raw === 'string') ? parse(raw) : raw;
    if (!m) return { kind: 'ignore' };
    if (m.k === 'intent') return { kind: 'ignore' };

    if (m.k === 'sync') {
      var st = m.state || {};
      this.state = emptyState(st.meta);
      for (var k in st) {
        if (!Object.prototype.hasOwnProperty.call(st, k)) continue;
        this.state[k] = clone(st[k]);
      }
      this.lastSeq = num(m.seq, 0);
      this.state.seq = this.lastSeq;
      this.gapFrom = 0;
      this.onChange(this.state);
      return { kind: 'sync', changed: true, seq: this.lastSeq };
    }

    // 水位标记：不改变状态，只把 lastSeq 推上去（见 skipMsg 注释）
    if (m.k === 'skip') {
      var sk = num(m.seq, 0);
      var skGap = this.gapFrom;          /* v2.5.0：_gate 会把它清掉，先留一份 */
      var gs = this._gate(sk);
      if (!gs.ok) return { kind: 'skip', dup: !!gs.dup, gap: !!gs.gap, from: this.lastSeq, got: sk };
      /* v2.5.0（用户第 7 项·b）：水位标记也可能是补齐流的第一条 —— 补上 filled 标记，
         让「补齐已完成」这个事实能传到界面（否则横幅永远挂着）。 */
      return { kind: 'skip', changed: false, seq: sk, filled: this._filledMark(skGap) };
    }

    // 增量事件
    var seq = num(m.seq, 0);
    var evGap = this.gapFrom;          /* v2.5.0：同上，_gate 前先留一份 */
    var g = this._gate(seq);
    if (!g.ok) return { kind: 'evt', dup: !!g.dup, gap: !!g.gap, from: this.lastSeq, got: seq };
    reduce(this.state, { t: m.t, seq: seq, p: m.p || {} });
    this.onChange(this.state);
    return { kind: 'evt', changed: true, seq: seq, t: m.t, filled: this._filledMark(evGap) };
  };

  /**
   * 序号闸门：重复直接丢、跳跃报缺口、连续才放行。
   * 抽出来是因为 skip 与 evt 必须走**同一套**判据 ——
   * 两处各写一遍，早晚会出现「skip 跳号被放过、evt 跳号被拦住」这种
   * 只有一半正确的状态机。
   */
  Client.prototype._gate = function (seq) {
    if (seq <= this.lastSeq) { this.rejected += 1; return { ok: false, dup: true }; }
    if (seq !== this.lastSeq + 1) { this.gapFrom = this.lastSeq; return { ok: false, gap: true }; }
    this.lastSeq = seq;
    /* 收到连续序号 = 缺口已经补上了，必须把标记清掉。
       漏了这一句，界面会永远挂着「连接不稳定，正在补齐记录」的提示，
       而实际上早就补齐了 —— 属于典型的「状态复位漏了一半」。 */
    this.gapFrom = 0;
    return { ok: true };
  };

  /**
   * v2.5.0（用户第 7 项·b）：本次通过闸门是否意味着「之前的缺口补上了」。
   *   prev = 进入 _gate **之前**的 gapFrom（>0 表示此前确实挂着缺口）。
   *   补齐后 lastSeq 一定已经越过那个缺口起点。
   * @param {number} prev 进入闸门前的 gapFrom
   * @returns {boolean}
   */
  Client.prototype._filledMark = function (prev) {
    if (!prev) return false;
    return this.lastSeq > prev;
  };

  /** 生成补拉意图 */
  Client.prototype.resyncIntent = function () {
    /* v2.5.0（用户第 7 项·d）：记下本次补拉的起点与次数 —— 之后能算出
       「补了多少条 / 还有没有洞」，供诊断与界面横幅文案使用。 */
    this._resyncFromSeq = this.gapFrom || this.lastSeq;
    this._resyncCount = (this._resyncCount || 0) + 1;
    return intentMsg(INTENT.SYNC, { lastSeq: this._resyncFromSeq });
  };

  /**
   * v2.5.0（用户第 7 项·d）：补拉进度诊断。
   * @returns {object} { from, last, filled, holes, count }
   */
  Client.prototype.resyncDiag = function () {
    var from = num(this._resyncFromSeq, 0);
    return {
      from: from,
      last: num(this.lastSeq, 0),
      filled: Math.max(0, num(this.lastSeq, 0) - from),
      holes: this.gapFrom ? 1 : 0,
      count: num(this._resyncCount, 0)
    };
  };

  Client.prototype.intent = function (op, p) { return intentMsg(op, p); };

  Client.prototype.member = function (seat) {
    seat = seat || this.seat;
    var ms = this.state.members || [];
    for (var i = 0; i < ms.length; i++) if (ms[i].seat === seat) return ms[i];
    return null;
  };

  Client.prototype.isReady = function () {
    var m = this.member();
    return !!(m && m.ready);
  };

  /**
   * 把权威端写回的角色卡状态应用到本机（**幂等**）。
   *
   * 同一 seq 应用两次只生效一次 —— 断线重连 / 事件重放 / 补拉都不会重复扣血。
   * 调用方（传输层）在 applied=true 时再调 RoomModel.applyStateToCard 落库。
   *
   * @returns {{applied:boolean, seq:number, dup?:boolean}}
   */
  Client.prototype.applySheetState = function (seq, patch) {
    var s = num(seq, 0);
    if (s <= 0) return { applied: false, seq: s };
    if (s <= (this.lastStateSeq || 0)) return { applied: false, seq: s, dup: true };
    this.lastStateSeq = s;
    this.sheetState = patch ? clone(patch) : null;
    return { applied: true, seq: s };
  };

  /* ============================================================
   * 通用助手
   * ============================================================ */

  function num(v, dflt) {
    var n = Number(v);
    return isFinite(n) ? n : dflt;
  }

  /** 取第一个「已提供」（非 undefined/null）的值；都没有则回落 b（v2.10.0（R5）提取到模块级）。 */
  function pick(a, b) { return (a === undefined || a === null) ? b : a; }

  /** 相对坐标夹到 0..1（地图标记跨设备一致的前提） */
  function clamp01(v) {
    var n = Number(v);
    if (!isFinite(n)) return 0;
    return n < 0 ? 0 : (n > 1 ? 1 : n);
  }

  function cleanText(s, max) {
    var t = String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim();
    if (max && t.length > max) t = t.slice(0, max);
    return t;
  }

  /* ============================================================
   * 角色卡摘要的白名单化（INTENT.CHAR 用）
   *
   * 玩家上报的是**展示用摘要**，权威端一个字都不能盲信：
   *   · 只取白名单字段，多余的键直接丢（防止有人塞个假的 maxHP 改别人看到的数）
   *   · 数字一律 clampNumber 夹进合理范围
   *   · 症状名/症状类型只接受字符串，长度截断
   *
   * 结构：
   *   { name, madness:[{type,name,permanent,rounds}], mental:[str],
   *     sanLoss, maxSAN, san, hp, mp }
   * ============================================================ */
  /* v2.1.7（用户第 4 项）：疯狂表 1D10 规则 —— 1-8 掷出的是**发作行为**
     （失忆/被窃/遍体鳞伤…），不是恐惧症/狂躁症，新增 'bout' 类型。 */
  var MAD_TYPES = { phobia: 1, mania: 1, bout: 1 };
  /** 九项属性的键（与 store.js#newCharacter 的 attrs 对齐，契约 §6.1） */
  var ATTR_KEYS = ['str', 'con', 'siz', 'dex', 'app', 'int', 'pow', 'edu', 'luck'];
  /** 精神状态的合法取值。与 rules-coc7.js#MENTAL_STATUS 对齐；
   *  这里再列一份是因为权威端**不能**依赖客户端的枚举（客户端可改）。
   *  v2.1.5（用户第 1 项）：新增「疯狂症状」（持有具体症状），
   *  「永久疯狂」为互斥项（类似「正常」）。 */
  /* v2.1.7：新增「不定疯狂（症状消失）」—— 发作症状随推进轮次消退后自动切换成
     这个状态：玩家恢复操作（不再锁死），但状态本身仍需「治愈」才解除。 */
  var MENTAL_OK = { '正常': 1, '临时疯狂': 1, '不定疯狂': 1, '不定疯狂（症状消失）': 1,
                    '疯狂症状': 1, '永久疯狂': 1, '昏迷': 1, '其他': 1 };
  var MENTAL_PERMANENT = '永久疯狂';
  var MENTAL_SYMPTOM = '疯狂症状';
  var MENTAL_INDEF = '不定疯狂';
  var MENTAL_INDEF_FADED = '不定疯狂（症状消失）';
  /**
   * 身体状态合法取值（单选**伤级**）。v2.1.5（用户第 2/4 项）：「死亡」= 撕卡。
   *
   * v2.8.0（HP 机制 · 用户第 3 项）口径说明：
   *   · 「轻伤」= **HP 低于最大值但未重伤**（即受伤但无重伤）；HP 回满 → 「正常」。
   *     由 `settleWounds` / `applyHpChange` 在 HP 变动后自动派生。
   *   · 「立即倒地(prone)」**不新增字段** —— 战斗态用战斗槽 `slot.public.down` 表达
   *     （见 `_syncBodyToCombatSlot`），成员层用「重伤」状态本身表达。
   *     （规则书 §重伤 2「立即倒地」是战斗站位概念，本项目不维护站位，只体现在行动轮跳过。）
   *
   * v2.10.0（用户第 R5 项）：**收敛为 4 值**（正常/轻伤/重伤/死亡）——「濒死 / 昏迷」
   *   从白名单**移除**，升级为 `sheet.status` 上的独立布尔标记 `dying` / `unconscious`
   *   （与 body 正交、可叠加）；显示 / 判定一律读视图合成 `bodyView()`
   *   （死亡 > dying > unconscious > body）。老卡一次性迁移见 `migrateBodyStatus`。
   */
  var BODY_OK = { '正常': 1, '轻伤': 1, '重伤': 1, '死亡': 1 };

  /**
   * v2.6.0（用户第 6 项）：当前 HP / SAN 的**上界 = 角色上限**（不再是固定 9999 / 999）。
   * 只夹上界；下界（>= 0）由调用方 clampNumber 负责。
   *
   * ⚠️ 硬性守卫 `max > 0`：maxHP / maxSAN 为 0 或缺失（角色还没登记血量上限）时
   *    **不做任何夹取**（原值返回）—— 否则会把正常角色清零（历史教训见 clampNumber 注释）。
   *
   * @param {number} v   目标现值
   * @param {number} max 角色上限（maxHP / maxSAN）
   * @returns {number}
   */
  function clampToMax(v, max) {
    var n = Number(v);
    if (!isFinite(n)) return v;
    var hi = Number(max);
    if (!(isFinite(hi) && hi > 0)) return n;   // 上限未知 / 为 0 → 不夹
    return n > hi ? hi : n;
  }

  function clampNumber(v, lo, hi, dflt) {
    /* ⚠️ null / undefined 是「未提供」哨兵，必须回落到 dflt。
       以前 `Number(null) === 0` 且 isFinite(0) 为真 → 直接返回 0，把
       「未知」伪造成合法 0 —— 后果：本地卡没上报 maxSAN 时，权威端把它记成 0，
       SAN Check 的上界就变成 0（QA 报告：一次失败检定会把玩家 SAN 清零）。
       maxHP / maxMP / maxSAN 都用同一个 clamp，属同一类缺陷，一并收口。 */
    if (v === undefined || v === null) return dflt;
    var n = Number(v);
    if (!isFinite(n)) return dflt;
    n = Math.round(n);
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  /** 属性九项：白名单 + 夹范围（多余的键直接丢） */
  function sanitizeAttrs(a) {
    a = a || {};
    var out = {};
    ATTR_KEYS.forEach(function (k) { out[k] = clampNumber(a[k], 0, 999, 0); });
    return out;
  }

  /**
   * 状态块（契约 §6.1）：currentHP/maxHP/currentMP/maxMP/currentSAN/maxSAN/currentLuck。
   * 兼容旧的上报形状（顶层 hp/mp/san/maxSAN）—— 旧客户端没发 status 时从顶层兜底。
   */
  function sanitizeStatus(st, src) {
    st = st || {};
    src = src || {};
    /* v2.10.0（用户第 R5 项）：老卡一次性迁移必须在白名单收敛**之前**看原始 body ——
       否则 '濒死' / '昏迷' 会先被 BODY_OK 过滤成 '正常'，迁移什么都看不到。
       HP 取不到时 bodyForHp 保守落 '轻伤'。 */
    var raw = migrateBodyStatus({
      body: st.body,
      dying: st.dying,
      unconscious: st.unconscious,
      currentHP: pick(st.currentHP, src.hp),
      hp: st.hp,
      maxHP: pick(st.maxHP, src.maxHP)
    });
    return {
      currentHP: clampNumber(raw.currentHP, 0, 9999, null),
      maxHP: clampNumber(raw.maxHP, 0, 9999, null),
      currentMP: clampNumber(pick(st.currentMP, src.mp), 0, 9999, null),
      maxMP: clampNumber(pick(st.maxMP, src.maxMP), 0, 9999, null),
      currentSAN: clampNumber(pick(st.currentSAN, src.san), 0, 999, null),
      maxSAN: clampNumber(pick(st.maxSAN, src.maxSAN), 0, 999, null),
      currentLuck: clampNumber(st.currentLuck, 0, 999, null),
      /* v2.1.5（用户第 2/4 项）：身体状态（单选白名单），「死亡」= 撕卡。 */
      body: BODY_OK[cleanText(raw.body, 8)] ? cleanText(raw.body, 8) : '正常',
      /* v2.10.0（用户第 R5 项）：昏迷 / 濒死 = 独立布尔标记（与 body 正交、可叠加）。 */
      dying: !!raw.dying,
      unconscious: !!raw.unconscious
    };
  }

  /** 技能列表：只留 {name,total}，不带 base/category（契约 §6.1） */
  function sanitizeSkills(sk) {
    var arr = Array.isArray(sk) ? sk : [];
    var out = [];
    /* v2.13.3（用户报「角色卡技能里没有信用评级了」）：上限 120 → 200。
       根因：整表技能（含子技能 格斗7/射击5/科学13/技艺30/语言15/生存7/学识6…）实测
       已超过 120 条，而「信用评级」在 COC_SKILLS 里排**最后** —— 被这条上限整条截掉，
       于是玩家技能页、技能检定、自由检定里都看不到它（信用评级也要参与检定）。
       200 足够装下整表（实测 ~150），体积可忽略。 */
    for (var i = 0; i < arr.length && out.length < 200; i++) {
      var s = arr[i] || {};
      var name = cleanText(s.name, 40);
      if (!name) continue;
      out.push({ name: name, total: clampNumber(s.total, 0, 999, 0) });
    }
    return out;
  }

  function sanitizeSheet(p, mem) {
    var src = p && p.sheet ? p.sheet : p;
    var out = {
      name: cleanText((src && src.name) || (p && p.name), 40),
      /* v2.0.0：带上 charId（房间内认卡用） */
      charId: cleanText((src && src.charId) || (p && p.id) || '', 64) || null,
      /* v2.13.7（用户需求）：聊天/记录条目左侧要显示角色头像。
         这里只收**缩略图**（room-ui#avatarThumbDataUrl 生成，64px JPEG ≈ 2-4KB）——
         原图可能是几 MB 的 dataURL，直接进成员广播会把 WS 帧撑爆。 */
      avatar: (/^data:image\/(png|jpe?g|webp);base64,/.test((src && src.avatar) || '') &&
               String(src.avatar).length <= 20000) ? String(src.avatar) : '',
      /* v2.0.0：九项属性 / 状态块 / 技能列表（隐私：只对本人与 KP 全量下发） */
      attrs: sanitizeAttrs(src && src.attrs),
      status: sanitizeStatus(src && src.status, src),
      skills: sanitizeSkills(src && src.skills),
      madness: [],
      mental: ['正常'],
      sanLoss: clampNumber(src && src.sanLoss, 0, 99, 0),
      maxSAN: clampNumber(src && src.maxSAN, 0, 99, null),
      san: clampNumber(src && src.san, 0, 99, null),
      hp: clampNumber(src && src.hp, 0, 999, null),
      mp: clampNumber(src && src.mp, 0, 999, null),
      at: Date.now()
    };
    if (mem && mem.charName && !out.name) out.name = mem.charName;

    /* 疯狂症状：最多留 40 条，字段白名单 */
    var arr = (src && Array.isArray(src.madness)) ? src.madness : [];
    out.madness = arr.slice(0, 40).map(function (m) {
      m = m || {};
      var type = MAD_TYPES[m.type] ? m.type : 'phobia';
      return {
        type: type,
        name: cleanText(m.name, 60),
        permanent: !!m.permanent,
        rounds: m.permanent ? 0 : clampNumber(m.rounds, 0, 99, 0),
        /* v2.1.6：发作来源（'临时疯狂'|'不定疯狂'|''）—— 推进轮次时区分标签摘除 */
        from: cleanText(m.from, 12),
        /* v2.1.7：背景来源标记 —— 显示层据此写「（背景症状）」而非「（永久）」 */
        bg: !!m.bg,
        /* v2.1.9（用户第 3 项）：总结症状标记（type='bout' 且来自总结症状表）——
           透传以免背景/总结症状经房间同步后标记丢失（当前无读取方，保留字段更稳）。 */
        sum: !!m.sum
      };
    }).filter(function (m) { return !!m.name; });

    /* 精神状态（多选）：只留合法项；空 → ['正常']。
       v2.1.5：「正常」互斥（选它清空其余）；「永久疯狂」互斥（撕卡级，选它只留它）。 */
    var ms = (src && Array.isArray(src.mental)) ? src.mental : [];
    var clean = [];
    ms.forEach(function (x) {
      var s = cleanText(x, 12);
      if (MENTAL_OK[s] && clean.indexOf(s) < 0) clean.push(s);
    });
    if (clean.indexOf('正常') >= 0) clean = ['正常'];                       // 「正常」互斥
    else if (clean.indexOf(MENTAL_PERMANENT) >= 0) clean = [MENTAL_PERMANENT]; // 「永久疯狂」互斥
    out.mental = clean.length ? clean : ['正常'];

    /* v2.7.0（用户第 2 项）：**背景症状归一化兜底**（模型侧权威，防伪造 / 老卡）。
       背景自带的疯狂症状（恐惧症 / 狂躁症）是永久标记，等同于「疯狂症状」精神状态，
       与「正常」互斥。历史数据 / 伪造载荷可能带 mental=['正常'] 却挂着背景症状，这里在
       白名单重建 mental 之后再做一次归一：
         · 判据「只有背景症状」= madness 非空 **且每一条都是背景条目**（严格判据）：
           背景条目 = bg===true，或兼容老数据 permanent===true && !from；
           只要混进任何一条非背景条目（游戏内掷出的临时 / 不定疯狂、带 sum 的总结症状，
           或来源不明的老条目），就**不**做归一 —— 绝不误伤 v2.2.2 / v2.4.0 的不定疯狂复发。
         · 满足时：强制包含「疯狂症状」，剔除「正常」/「临时疯狂」/「不定疯狂」/
           「不定疯狂（症状消失）」。
         · 「永久疯狂」互斥**优先**（上面已把 clean 收敛为 ['永久疯狂']，这里跳过）。
       ⚠️ 绝对不能在「同时存在游戏内症状」时剔除 临时 / 不定疯狂 —— 那会废掉 v2.2.2 /
          v2.4.0 已交付的「不定疯狂复发」功能。所以本归一**仅**作用于「只有背景症状」的卡。 */
    var onlyBg = onlyBgSymptoms(out.madness);
    if (onlyBg && out.mental.indexOf(MENTAL_PERMANENT) < 0) {
      var norm = out.mental.filter(function (x) {
        return x !== '正常' && x !== '临时疯狂' && x !== MENTAL_INDEF && x !== MENTAL_INDEF_FADED;
      });
      if (norm.indexOf(MENTAL_SYMPTOM) < 0) norm.push(MENTAL_SYMPTOM);
      out.mental = norm;
    }

    /* ---- v2.1.0 #11：KP 定向指令的两个新字段（本人 + KP 可见）----
       ⚠️ 必须在这里做**白名单化**：否则 stateApply 写进 sheet 的 tempStatus/items
          会在下一次 sanitizeSheet（re-sanitize / 重连重建）时被直接剥掉 ——
          典型症状「写了又没写」。字段形状与冻结接口一致。 */
    /* 临时状态：{ text, by:'kp', at }，最多 20 条 */
    var tsArr = (src && Array.isArray(src.tempStatus)) ? src.tempStatus : [];
    out.tempStatus = tsArr.slice(0, 20).map(function (t) {
      t = t || {};
      return {
        text: cleanText(t.text, 80),
        by: cleanText(t.by, 8) || 'kp',
        at: clampNumber(t.at, 0, 1e15, 0)
      };
    }).filter(function (t) { return !!t.text; });

    /* 物品道具：{ name, qty, note }，最多 60 条 */
    var itArr = (src && Array.isArray(src.items)) ? src.items : [];
    out.items = itArr.slice(0, 60).map(function (it) {
      it = it || {};
      return {
        /* v2.1.3（用户第 4 项 · 玩家删物品）：给物品一个**稳定 id**。
           删除必须按 id 而不是按下标 —— 下标在「重放同一请求」或并发增删时会错位，
           于是删掉的是**另一件**物品（最难查的一类数据事故）。 */
        id: cleanText(it.id, 24),
        name: cleanText(it.name, 40),
        qty: clampNumber(it.qty, 0, 9999, 1),
        note: cleanText(it.note, 80)
      };
    }).filter(function (it) { return !!it.name; });

    /* ---- v2.2.0（用户第 3 项）：武器清单 + 伤害加值（本人 + KP 可见）----
       玩家发起武器对抗时，权威端据此取「武器伤害式 / 贯穿 / DB」——
       与 attrs/status/skills 同可见性（其他玩家只留公开部分，见 _cropMember）。 */
    var wpArr = (src && Array.isArray(src.weapons)) ? src.weapons : [];
    out.weapons = wpArr.slice(0, 20).map(function (w) {
      w = w || {};
      var nm = cleanText(w.name, 40);
      if (!nm) return null;
      return {
        name: nm,
        skill: cleanText(w.skill, 30),
        damage: cleanText(w.damage, 30),
        pierce: (cleanText(w.pierce, 4) === '√') ? '√' : '×',
        /* v2.3.0（用户第 8 / 10 项）：连发 / 装弹量 / 故障值 / 损坏标记。
           ⚠️ 必须列入白名单 —— 否则玩家重连补报（INTENT.CHAR）后这些字段被剥掉。 */
        perRound: cleanText(w.perRound, 12),
        ammo: cleanText(w.ammo, 20),
        malfunction: cleanText(w.malfunction, 8),
        broken: !!w.broken
      };
    }).filter(Boolean);
    /* 伤害加值：形如 '+1D4' / '-2' / '0'（字符串，供 rollDamageBonus 掷骰）。 */
    out.db = cleanText(src && src.db, 10) || '0';

    return out;
  }

  /* ============================================================
   * v2.0.0：场景检定步骤 / 存档 / 状态写回的模块级助手
   * ============================================================ */

  /** 场景检定「分支」（成功 / 失败）的白名单化 */
  function sanitizeBranch(b) {
    b = b || {};
    return {
      damage: cleanText(b.damage, 20),   // 伤害表达式（如 '1D4'），可空
      note: cleanText(b.note, 120),
      next: cleanText(b.next, 24)        // 下一步 id：'' = 顺序推进；'end' = 结束
    };
  }

  /** 场景检定步骤数组的白名单化（契约 §4.3） */
  function sanitizeSceneSteps(arr) {
    var out = [];
    (Array.isArray(arr) ? arr : []).slice(0, 60).forEach(function (s, i) {
      s = s || {};
      out.push({
        id: cleanText(s.id, 24) || ('st' + (i + 1)),
        title: cleanText(s.title, 60) || ('步骤 ' + (i + 1)),
        desc: cleanText(s.desc, 200),
        targetSeat: cleanText(s.targetSeat, 64),
        skill: cleanText(s.skill, 30),
        difficulty: (s.difficulty === 'HARD' || s.difficulty === 'EXTREME') ? s.difficulty : 'REGULAR',
        bonus: Math.max(0, Math.min(MOD_CAP, num(s.bonus, 0))),
        penalty: Math.max(0, Math.min(MOD_CAP, num(s.penalty, 0))),
        onSuccess: sanitizeBranch(s.onSuccess),
        onFailure: sanitizeBranch(s.onFailure)
      });
    });
    return out;
  }

  /**
   * 场景检定分支的**兜底**求值（仅在规则服务缺失时用；level>=2 视为成功）。
   * 生产环境一律走 `CocRules.sceneStepResolve`。
   */
  function defaultSceneResolve(step, level) {
    var b = (num(level, 0) >= 2) ? (step && step.onSuccess || {}) : (step && step.onFailure || {});
    return { damage: b.damage || '', note: b.note || '', next: b.next || '' };
  }

  /** 解析存档载荷（字符串或对象）→ 存档对象；失败返回 null */
  function parseSave(payload) {
    if (!payload) return null;
    if (isObj(payload)) return payload;
    try { return JSON.parse(String(payload)); } catch (e) { return null; }
  }

  /** 从存档重建一个 Host（用于续玩 / 玩家侧裁剪） */
  function restoreHost(saveOrPayload, opts) {
    var save = parseSave(saveOrPayload);
    if (!save) return null;
    opts = opts || {};
    var h = new Host(Object.assign({ meta: save.meta || {} }, opts));
    h.adoptSave(save);
    return h;
  }

  /**
   * 玩家侧从服务器存档拿到的**裁剪后视图**（契约 §6.3：玩家拉取的必须是裁剪过的）。
   * 复用 Host.syncFor 的裁剪规则 —— 与增量/全量同步口径完全一致。
   * 返回一个 `{k:'sync', seq, state}` 信封，可直接喂给 Client.receive。
   */
  function playerViewFromSave(saveOrPayload, seat) {
    var h = restoreHost(saveOrPayload);
    if (!h) return null;
    return h.syncFor(seat || '');
  }

  /**
   * 把状态写回本机 Store 的角色卡（best-effort，不改 store.js）。
   *
   * v2.1.1：返回值由 boolean 改为**结构化结果** `{ ok, reason, cardId, source }`。
   *   以前静默 `return false`（找不到卡 / 抛异常），调用方无从判断「到底写没写」，
   *   表现就是「KP 发了指令、玩家人物卡毫无变化，也不报错」—— 这类静默失败必须
   *   有可观测信号（见 room-net.js#_applySheetStateDefault 把结果回抛给界面）。
   *
   * 目标卡定位规则（**不再无条件退到 `stt.current`** —— 那是「写到别人卡上」的根源）：
   *   · 给了 charId 且能命中 → 写那张；
   *   · 给了 charId 但找不到 → **拒绝**（绝不写到当前别的卡上）；
   *   · 没给 charId（未绑定卡的旧路径）→ 才退到 `stt.current`（旧行为，标 source）。
   */
  function applyStateToCard(store, charId, patch) {
    try {
      if (!store || !store.getState) return { ok: false, reason: 'no_store' };
      var stt = store.getState();
      var cid = (charId === undefined || charId === null) ? '' : String(charId);
      var card = null, source = '';
      if (cid) {
        card = (stt.characters && stt.characters[cid]) ? stt.characters[cid] : null;
        /* 仅当 id 完全一致时才允许从 current 兜底 —— 同 id 就是同一张卡，安全 */
        if (!card && stt.current && String(stt.current.id) === cid) card = stt.current;
        if (!card) return { ok: false, reason: 'card_not_found', cardId: cid };
        source = 'characters';
      } else {
        /* 未绑定卡（charId 缺失）→ 只能退到 current（旧行为）。这确实可能写到
           与玩家无关的卡上，所以把 source='current' 明确带出去，方便上层提示。 */
        if (!stt.current) return { ok: false, reason: 'no_card' };
        card = stt.current;
        source = 'current';
      }
      if (!card.status) card.status = {};
      var st = (patch && patch.status) || {};
      ['currentHP', 'maxHP', 'currentMP', 'maxMP', 'currentSAN', 'maxSAN', 'currentLuck'].forEach(function (k) {
        if (st[k] !== undefined && st[k] !== null) card.status[k] = st[k];
      });
      /* v2.1.5（用户第 2/4 项）：身体状态也落到本机卡（「死亡」= 撕卡）。 */
      if (st.body !== undefined && st.body !== null) card.status.body = st.body;
      /* v2.10.0（用户第 R5 项）：昏迷 / 濒死标记一并透传（权威端 → 玩家本机卡）——
         否则两端视图漂移（本机卡仍按旧 body 单值显示）。 */
      if (st.dying !== undefined && st.dying !== null) card.status.dying = !!st.dying;
      if (st.unconscious !== undefined && st.unconscious !== null) card.status.unconscious = !!st.unconscious;
      if (patch && Array.isArray(patch.madness)) card.madness = clone(patch.madness);
      if (patch && Array.isArray(patch.mental)) card.status.mental = clone(patch.mental);
      if (patch && patch.sanLoss !== undefined) card.status.sanLoss = patch.sanLoss;
      /* v2.1.0 #11：KP 定向指令的临时状态 / 物品道具也落到本机卡（离线也看得到） */
      if (patch && Array.isArray(patch.tempStatus)) card.tempStatus = clone(patch.tempStatus);
      if (patch && Array.isArray(patch.items)) card.items = clone(patch.items);
      /* v2.3.0（用户第 10 项）：武器「已损坏」标记随状态写回落本机卡。 */
      if (patch && Array.isArray(patch.weapons)) card.weapons = clone(patch.weapons);
      if (typeof store.saveNow === 'function') store.saveNow();
      return { ok: true, reason: '', cardId: cid || (card.id || ''), source: source };
    } catch (e) {
      return { ok: false, reason: 'exception', error: String((e && e.message) || e) };
    }
  }

  /** 房间号口子：只允许小写字母数字（与服务端正则保持一致） */
  function validCode(c) {
    return /^[a-z0-9]{4,12}$/.test(String(c || ''));
  }

  /** 邀请链接：把服务地址一并带上，加入方不用再猜地址（局域网尤其重要） */
  function inviteLink(pageUrl, code, serverBase) {
    var u = String(pageUrl || '');
    u = u.split('#')[0];
    var sep = u.indexOf('?') >= 0 ? '&' : '?';
    var out = u + sep + 'room=' + encodeURIComponent(code);
    if (serverBase) out += '&srv=' + encodeURIComponent(serverBase);
    return out;
  }

  /**
   * 规范化一个「服务器地址」片段。
   *
   * 用户手填 / 粘贴进来的地址可能没有协议头（`192.168.x.y:8899`），
   * 也可能只有主机名或域名。这里只做最小修正：
   *   · 缺协议头且形如「主机[:端口][/路径]」→ 补 `http://`；
   *   · 去掉结尾多余的斜杠。
   * 不动已有 `http(s)://` 前缀的地址，也不动带查询串的地址。
   */
  function normalizeServerBase(v) {
    var t = String(v == null ? '' : v).trim();
    if (!t) return '';
    if (!/^https?:\/\//i.test(t) && /^[\w.-]+(:\d+)?(\/.*)?$/.test(t)) t = 'http://' + t;
    return t.replace(/\/+$/, '');
  }

  /**
   * 解析「加入信息」字符串 —— 宽容解析，尽量把房间号与服务地址都抠出来。
   *
   * 加入方拿到的输入五花八门：整条邀请链接、从别人那里复制出来的紧凑串、
   * 甚至只贴一个地址或只贴房间号。与其让用户自己拆，不如统一在这里识别。
   * 识别顺序（先匹配到谁就用谁）：
   *   ① COC7ROOM|<host:port>|<code>  —— 「复制加入信息」产出的紧凑串（分隔符兼容全角竖线）
   *   ② 带查询串的链接 / 纯查询串     —— …?room=xx&srv=yy（旧版邀请链接，保持兼容）
   *   ③ 裸地址                         —— host:port 或 http(s)://host[:port][/path]
   *   ④ 裸房间号                       —— 4-12 位小写字母数字
   *
   * ⚠️ 向后兼容：旧的 `?room=xx&srv=yy` 与空串行为必须与以前完全一致
   *    （见 tools/test_room_model.js 第 8 节）。
   *
   * @param {string} str - 待解析字符串（可传 location.search）
   * @returns {{code: string, serverBase: string}}
   */
  function readInvite(str) {
    var out = { code: '', serverBase: '' };
    var s = String(str == null ? '' : str).trim();
    if (!s) return out;

    /* ① 紧凑串：COC7ROOM|<host:port>|<code>
       房间号可缺省（`COC7ROOM|<addr>|`）：只贴了地址也照样把地址抠出来。 */
    var m = /^COC7ROOM\s*[|｜]\s*([^|｜]*)\s*[|｜]\s*([A-Za-z0-9]*)/i.exec(s);
    if (m) {
      out.serverBase = normalizeServerBase(m[1]);
      out.code = String(m[2] || '').toLowerCase();
      return out;
    }

    /* ② 查询串（整条 URL 里的 ?… 或纯 ?room=…）。有 ? 一律按查询串解析，
          保持与旧实现一致：即使没有 room 也要把 srv 取出来。 */
    var qs = s;
    var qi = qs.indexOf('?');
    if (qi >= 0) qs = qs.slice(qi + 1);
    if (qi >= 0 || /(^|[&])room=/.test(s)) {
      var q = {};
      qs.split('&').forEach(function (kv) {
        if (!kv) return;
        var i = kv.indexOf('=');
        var k = i < 0 ? kv : kv.slice(0, i);
        var v = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
        q[k] = v;
      });
      return { code: String(q.room || '').toLowerCase(), serverBase: normalizeServerBase(q.srv || '') };
    }

    /* ③ 裸地址：host:port 或 http(s)://host[:port][/path] */
    if (/^https?:\/\//i.test(s) || /^[\w.-]+:\d+(\/.*)?$/.test(s)) {
      out.serverBase = normalizeServerBase(s);
      return out;
    }

    /* ④ 裸房间号 */
    if (validCode(s.toLowerCase())) {
      out.code = s.toLowerCase();
      return out;
    }
    return out;
  }

  /* ============================================================
   * 对外 API
   * ============================================================ */
  global.RoomModel = {
    ROLE: ROLE,
    HOST_SEAT: HOST_SEAT,
    STATUS: STATUS,
    STATUS_TEXT: STATUS_TEXT,
    MODE: MODE,
    REWIND: REWIND,
    CONFIRM: CONFIRM,
    EVT: EVT,
    INTENT: INTENT,
    VIS: VIS,
    POLICY: POLICY,
    SECRET_KEYS: SECRET_KEYS,

    allowed: allowed,
    needs: needs,
    hasSecret: hasSecret,
    scrub: scrub,

    Log: Log,
    Roster: Roster,
    Host: Host,
    Client: Client,
    emptyState: emptyState,
    reduce: reduce,

    syncMsg: syncMsg,
    evtMsg: evtMsg,
    skipMsg: skipMsg,
    intentMsg: intentMsg,
    parse: parse,

    validCode: validCode,
    cleanText: cleanText,
    inviteLink: inviteLink,
    readInvite: readInvite,
    clone: clone,

    /* v2.0.0：存档 / 状态写回 / 场景检定的助手（传输层与测试都要用） */
    parseSave: parseSave,
    restoreHost: restoreHost,
    playerViewFromSave: playerViewFromSave,
    applyStateToCard: applyStateToCard,
    sanitizeSheet: sanitizeSheet,
    sanitizeSceneSteps: sanitizeSceneSteps,

    /* v2.10.0（用户第 R5 项）：身体状态三键模型（body 4 值 + dying/unconscious 布尔）
       的视图合成 / 迁移助手 —— UI 显示与测试断言共用同一份口径。 */
    bodyView: bodyView,
    bodyForHp: bodyForHp,
    migrateBodyStatus: migrateBodyStatus
  };
})(typeof window !== 'undefined' ? window : this);
