/* ============================================================
 * madness.js — 疯狂状态管理
 *
 * 跑团中角色会逐条掷出「临时疯狂」（Bout of Sanity）等发作状态。
 * v2.1.9（用户第 3 项）疯狂表体系重做 —— 规则书的「疯狂表」实为**两张**：
 *   即时症状表（发作时，掷 1D10）与 总结症状表（独处 / 事后，掷 1D10）。
 *   两表各 10 条，第 9 / 10 条指向 100 条的恐惧症 / 狂躁症子表（再掷 1D100）。
 *   （详见下方 BOUT_TABLE / SUMMARY_TABLE 与 rollTable / rollSummary）
 *
 * 之前这些状态只是第 8 步背景里的一个文本框（background.phobias），
 * 跑团中想掷一个症状没地方掷、也没法记「还剩几轮」、更没法删。
 * 这里把症状提升成一等公民：每条独立记录、可单独删除、带剩余轮数。
 *
 * 数据落在 character.madness（数组），每条：
 *   { id, type, name, en, desc, rounds, permanent, bg, at }
 *     type       'phobia'（恐惧症）| 'mania'（狂躁症）| 'bout'（1-8 发作行为）
 *     rounds     剩余轮数；permanent 为 true 时忽略此字段
 *     permanent  true = 不随轮次消失（永久疯狂或背景症状）
 *     bg         true = 来自角色背景（显示「（背景症状）」）
 * ============================================================ */
(function (global) {
  'use strict';

  var DB = global.COC_MADNESS || { phobias: [], manias: [] };

  function pool(type) {
    return type === 'mania' ? (DB.manias || []) : (DB.phobias || []);
  }
  function labelOf(type) {
    if (type === 'mania') return '狂躁症';
    if (type === 'bout') return '疯狂发作';
    return '恐惧症';
  }

  function uid() {
    return 'm' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }

  function poolSize(type) { return pool(type).length; }

  /** 全池（两种症状混在一起随机，规则书本来就是混着掷的） */
  function allSymptoms() {
    return (DB.phobias || []).map(tag('phobia')).concat((DB.manias || []).map(tag('mania')));
  }

  function tag(type) {
    return function (x) { return { type: type, name: x.name, en: x.en, desc: x.desc, no: x.no }; };
  }

  /* ============================================================
   * v2.1.9（用户第 3 项）：**疯狂表体系重做** ——
   * 规则书的「疯狂表」实为两张：**即时症状表**（发作时，掷 1D10）
   * 与**总结症状表**（独处 / 事后，掷 1D10）。两表都是 10 条，
   * 第 9、10 条指向 100 条的恐惧症 / 狂躁症子表（再掷 1D100）。
   *
   *   即时症状（掷 1D10；有同伴在场时按轮扮演，各持续 1D10 轮）：
   *     1 失忆  2 假性残疾  3 暴力倾向  4 偏执妄想  5 人际依赖
   *     6 昏厥  7 惊慌逃窜  8 歇斯底里  9 恐惧症  10 躁狂症
   *   总结症状（独自一人时，KP 快进陈述结果，约 1D10 小时后恢复神志）：
   *     1 失忆  2 被劫  3 遍体鳞伤  4 暴力  5 思想与信念
   *     6 重要之人  7 被收容  8 惊慌逃窜  9 恐惧症  10 躁狂症
   *
   * 规则书里 1-8 是**行为层面的结果**（不产生具体恐惧症/狂躁症），
   * 只有 1/5 的概率发展出新的恐惧症（9）或狂躁症（10）。
   * 这条规则贯穿所有「随机疯狂」路径：跑团 SAN Check 结算、
   * 车卡「掷疯狂状态」、随机角色池预设卡、彩蛋卡、AI 生卡。
   * ============================================================ */

  /* 即时症状表（发作时，掷 1D10）。no 9 / 10 的 link 指向 100 条子表。 */
  var BOUT_TABLE = [
    { no: 1, name: '失忆', en: 'Amnesia',
      desc: '不知何时到的这里。' },
    { no: 2, name: '假性残疾', en: 'Psychosomatic Disability',
      desc: '心因性失明 / 耳聋 / 失能。' },
    { no: 3, name: '暴力倾向', en: 'Violence',
      desc: '对四周无差别破坏。' },
    { no: 4, name: '偏执妄想', en: 'Paranoia',
      desc: '人人与我作对。' },
    { no: 5, name: '人际依赖', en: 'Interpersonal Dependency',
      desc: '把同伴错认成重要之人。' },
    { no: 6, name: '昏厥', en: 'Fainting',
      desc: '立即昏倒。' },
    { no: 7, name: '惊慌逃窜', en: 'Flee in Panic',
      desc: '不择手段逃离。' },
    { no: 8, name: '歇斯底里', en: 'Hysteria',
      desc: '狂笑 / 哭泣 / 尖叫。' },
    { no: 9, name: '恐惧症', en: 'Phobia', link: 'phobia',
      desc: '掷 1D100 从恐惧症表（100 条）决定具体症状。' },
    { no: 10, name: '躁狂症', en: 'Mania', link: 'mania',
      desc: '掷 1D100 从狂躁症表（100 条）决定具体症状。' }
  ];

  /* 总结症状表（独处 / 事后，掷 1D10）。no 9 / 10 同样指向 100 条子表。 */
  var SUMMARY_TABLE = [
    { no: 1, name: '失忆', en: 'Amnesia',
      desc: '身在陌生地点，连自己是谁都不记得。' },
    { no: 2, name: '被劫', en: 'Robbed',
      desc: '财物遭劫，宝贵之物掷幸运决定是否幸免。' },
    { no: 3, name: '遍体鳞伤', en: 'Battered',
      desc: 'HP 减半（不算重伤）。' },
    { no: 4, name: '暴力', en: 'Violence',
      desc: '对谁施暴、是否致死由 KP 决定。' },
    { no: 5, name: '思想与信念', en: 'Ideology',
      desc: '把信条以极端方式活出来。' },
    { no: 6, name: '重要之人', en: 'Significant People',
      desc: '尽一切努力接近 TA。' },
    { no: 7, name: '被收容', en: 'Institutionalized',
      desc: '醒来在病房或拘留室。' },
    { no: 8, name: '惊慌逃窜', en: 'Flee in Panic',
      desc: '醒来已在荒野或长途车上。' },
    { no: 9, name: '恐惧症', en: 'Phobia', link: 'phobia',
      desc: '掷 1D100 从恐惧症表（100 条）决定具体症状。' },
    { no: 10, name: '躁狂症', en: 'Mania', link: 'mania',
      desc: '掷 1D100 从狂躁症表（100 条）决定具体症状。' }
  ];

  /**
   * 掷**即时症状表**：1D10 决定发作种类。
   * @param {function} [rng] 可注入随机源（0..1），测试用
   * @returns {{kind:'bout'|'phobia'|'mania', no:number, src:object}}
   *   1-8 → kind='bout'（src = BOUT_TABLE 条目）；
   *   9 → kind='phobia'、10 → kind='mania'（src = 对应 100 表随机一条）。
   */
  function rollTable(rng) {
    var r = rng || Math.random;
    var no = 1 + Math.floor(r() * 10);
    var row = BOUT_TABLE[no - 1];
    if (!row || !row.link) return { kind: 'bout', no: no, src: row };
    var arr = pool(row.link);
    if (!arr.length) return { kind: 'bout', no: no, src: row };
    return { kind: row.link, no: no, src: arr[Math.floor(r() * arr.length)] };
  }

  /**
   * 掷**总结症状表**（独处 / 事后）。规则同 rollTable，只是 1-8 取 SUMMARY_TABLE。
   * @param {function} [rng] 可注入随机源（0..1），测试用
   * @returns {{kind:'sum'|'phobia'|'mania', no:number, src:object}}
   */
  function rollSummary(rng) {
    var r = rng || Math.random;
    var no = 1 + Math.floor(r() * 10);
    var row = SUMMARY_TABLE[no - 1];
    if (!row || !row.link) return { kind: 'sum', no: no, src: row };
    var arr = pool(row.link);
    if (!arr.length) return { kind: 'sum', no: no, src: row };
    return { kind: row.link, no: no, src: arr[Math.floor(r() * arr.length)] };
  }

  /**
   * 背景症状文本（给随机角色池 / 彩蛋卡 / AI 卡用）。
   *
   * v2.1.9（用户第 3 项）：背景心理症状**改按总结症状表**掷骰 ——
   * 8/10 得到一条总结症状（文本标【疯狂发作】），
   * 各 1/10 得到恐惧症 / 狂躁症（来自 100 条子表）。
   * 文本格式沿用 `【类型】名字：描述`。
   * @param {string} [tail] 追加在描述后的风味尾注（如「（来自人设）」）
   */
  function backgroundText(tail, rng) {
    var hit = rollSummary(rng);
    if (hit.kind === 'sum') {
      return '【疯狂发作】' + hit.src.name + '：' + (hit.src.desc || '') + (tail || '');
    }
    var t = (hit.kind === 'mania') ? '狂躁症' : '恐惧症';
    return '【' + t + '】' + hit.src.name + '：' + (hit.src.desc || '') + (tail || '');
  }

  /**
   * 随机一个疯狂结果。
   * @param {string} type  'phobia' | 'mania'（手动指定表，直接从该表抽）
   *                       | 'any'（默认：**按疯狂表 1D10 规则** —— 见 BOUT_TABLE）
   * @param {boolean} permanent 是否永久（轮次归零、不随推进消退）
   * @param {function} [rng] 可注入随机源（测试用）
   * @returns {{type,name,en,desc,permanent,rounds,id,at}}
   *   type 可能是 'phobia' | 'mania' | 'bout'（1-8 的发作行为）。
   */
  function roll(type, permanent, rng) {
    type = (type === 'phobia' || type === 'mania') ? type : 'any';
    var s;
    if (type === 'any') {
      /* v2.1.7：1D10 疯狂表 —— 1-8 发作行为、9 恐惧表、10 狂躁表 */
      var hit = rollTable(rng);
      s = { type: hit.kind, name: hit.src.name, en: hit.src.en || '', desc: hit.src.desc || '' };
    } else {
      var src = pool(type);
      if (!src || !src.length) return null;
      var p = src[Math.floor((rng || Math.random)() * src.length)];
      s = { type: type, name: p.name, en: p.en || '', desc: p.desc || '' };
    }
    return {
      id: uid(),
      type: s.type,
      name: s.name,
      en: s.en || '',
      desc: s.desc || '',
      permanent: !!permanent,
      // 规则书：临时疯狂持续 1D10 轮。这里随机 1-10 轮。
      rounds: permanent ? 0 : (1 + Math.floor(Math.random() * 10)),
      at: Date.now()
    };
  }

  /** 从症状表里挑一条（不掷骰，供「手动添加」用） */
  function make(type, src, permanent, rounds) {
    if (!src) return roll(type, permanent);
    /* v2.1.9（用户第 3 项）：保留 bout（发作行为 / 总结症状）类型，
       不再一律强转 phobia —— 否则「失忆」会被记成一条不存在的恐惧症。 */
    var t = (type === 'mania') ? 'mania' : (type === 'bout' ? 'bout' : 'phobia');
    return {
      id: uid(),
      type: t,
      name: src.name,
      en: src.en || '',
      desc: src.desc || '',
      permanent: !!permanent,
      rounds: permanent ? 0 : (rounds || (1 + Math.floor(Math.random() * 10))),
      at: Date.now()
    };
  }

  function list(character) {
    if (!character) return [];
    if (!Array.isArray(character.madness)) character.madness = [];
    return character.madness;
  }

  function add(character, entry) {
    if (!entry) return null;
    list(character).push(entry);
    return entry;
  }

  function remove(character, id) {
    var arr = list(character);
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].id === id) { var gone = arr.splice(i, 1)[0]; return gone; }
    }
    return null;
  }

  function clear(character) {
    if (character) character.madness = [];
  }

  /**
   * 推进 n 轮，把到期的临时疯狂清掉。
   * 永久疯狂（permanent）永远不会被这一步清掉 —— 只能手动删。
   *
   * @returns {Array} 本轮自然消退的症状
   */
  function advance(character, n) {
    n = Math.max(1, parseInt(n, 10) || 1);
    var arr = list(character);
    var faded = [];
    for (var i = arr.length - 1; i >= 0; i--) {
      var m = arr[i];
      if (m.permanent) continue;
      m.rounds = (m.rounds === undefined || m.rounds === null) ? 1 : (m.rounds - n);
      if (m.rounds <= 0) { faded.push(arr.splice(i, 1)[0]); }
    }
    return faded;
  }

  /** 一句话摘要，给角色卡与状态栏显示（v2.1.7：背景症状单独标注） */
  function summary(character) {
    var arr = list(character);
    if (!arr.length) return '';
    return arr.map(function (m) {
      return '【' + labelOf(m.type) + '】' + m.name + tailText(m);
    }).join('　');
  }

  /** 条目尾注：背景症状 / 永久 / 剩余轮次（三处显示共用，v2.1.7 抽出） */
  function tailText(m) {
    if (m.permanent) return m.bg ? '（背景症状）' : '（永久）';
    return '（' + (m.rounds || 0) + ' 轮）';
  }

  /** 还有几条会在 N 轮内消退（给「本轮结束」提示用） */
  function fading(character, within) {
    within = Math.max(1, parseInt(within, 10) || 1);
    return list(character).filter(function (m) { return !m.permanent && m.rounds <= within; });
  }

  /* ============================================================
   * 背景文本 → 结构化症状
   *
   * 第 8 步「恐惧症 / 狂躁症」在很长一段时间里只是一个**文本框**
   * （background.phobias），而状态管理里的 madness 是另一套数组，
   * 两者互不相通 —— 结果是「背景里明明写着幽闭恐惧症，状态管理里却是空的」。
   *
   * 这里做两件事：
   *   1) 以后在背景里点选症状时，**同时**写结构化数组（见 fromPicked）；
   *   2) 对**已经存下来的老卡**做一次性迁移，把文本里的症状补进数组。
   *
   * 迁移必须幂等：同一张卡反复进 normal() 不能越迁越多（否则每存一次
   * 就多一条重复的症状）。所以按「名称 + 类型」去重，且只处理
   * **在症状表里确实存在**的名字 —— 文本框里玩家自己写的自由文字不硬塞。
   * ============================================================ */

  /** 把一条症状名归一到症状表里的条目；认不出返回 null */
  function lookup(name, type) {
    var n = String(name == null ? '' : name).trim();
    if (!n) return null;
    var pools = (type === 'mania') ? ['mania'] : (type === 'phobia') ? ['phobia'] : ['phobia', 'mania'];
    for (var i = 0; i < pools.length; i++) {
      var arr = pool(pools[i]);
      for (var j = 0; j < arr.length; j++) {
        if (arr[j].name === n) return { type: pools[i], src: arr[j] };
      }
    }
    return null;
  }

  /** 背景文本里是否已经有这一条（同一姓名 + 同一类型算重复） */
  function hasName(character, type, name) {
    return list(character).some(function (m) {
      return m.name === name && (m.type === type || !type);
    });
  }

  /**
   * 从背景文本解析出症状名。
   *
   * 背景里的写入格式是每一行 `【恐惧症】幽闭恐惧症：描述…`（见 steps-d.js）。
   * 但用户也可能手打进纯文本，所以这里两种都认：
   *   · 带 `【类型】名字：…` 的按标记走（最准）
   *   · 其余每一行取「：」之前那段当候选名，再去症状表里查
   * 查不到的一律忽略 —— 不能把玩家的自由描述硬当成症状。
   */
  function parseBackground(text) {
    var out = [];
    var seen = {};
    String(text == null ? '' : text).split(/\r?\n/).forEach(function (line) {
      var s = line.trim();
      if (!s) return;
      var m = s.match(/^【(恐惧症|狂躁症)】\s*([^：:]+)/);
      if (m) {
        var t = (m[1] === '狂躁症') ? 'mania' : 'phobia';
        var hit = lookup(m[2].trim(), t);
        if (hit && !seen[t + '/' + hit.src.name]) {
          seen[t + '/' + hit.src.name] = 1;
          out.push(hit);
        }
        return;
      }
      // 没带标记：整行当候选名（去了「：描述」的尾巴）
      var bare = s.split(/[：:]/)[0].trim();
      var h2 = lookup(bare);
      if (h2 && !seen[h2.type + '/' + h2.src.name]) {
        seen[h2.type + '/' + h2.src.name] = 1;
        out.push(h2);
      }
    });
    return out;
  }

  /**
   * 把背景文本里已识别的症状**补进** madness 数组（永久疯狂）。
   * 幂等：已有的不重复加。返回本次新增的条数。
   */
  function fromBackground(character) {
    if (!character) return 0;
    var found = parseBackground(character.background && character.background.phobias);
    var added = 0;
    found.forEach(function (h) {
      if (hasName(character, h.type, h.src.name)) return;
      var e = make(h.type, h.src, true);
      e.bg = true;   /* v2.1.7：标记来源是背景 —— 显示「（背景症状）」而非「（永久）」 */
      add(character, e);
      added++;
    });
    return added;
  }

  /** 背景点选后调用：把选中的症状同时写进结构化数组（永久疯狂），返回新增条数 */
  function fromPicked(character, picked) {
    if (!character || !Array.isArray(picked)) return 0;
    var added = 0;
    picked.forEach(function (x) {
      /* v2.1.9（用户第 3 项）：新增支持『疯狂发作』（即时 / 总结症状）—— type='bout'，
         并打 sum 标记；恐惧症 / 狂躁症仍走 phobia / mania。 */
      var type;
      if (x.type === 'bout' || x.kind === '疯狂发作') type = 'bout';
      else type = (x.kind === '狂躁症' || x.type === 'mania') ? 'mania' : 'phobia';
      var name = String((x.name != null ? x.name : x) || '').trim();
      if (!name) return;
      if (hasName(character, type, name)) return;
      var hit = (type === 'bout') ? null : lookup(name, type);
      var src = hit ? hit.src : { name: name, en: x.en || '', desc: x.desc || '' };
      var e = make(type, src, true);
      e.bg = true;   /* v2.1.7：同 fromBackground */
      if (type === 'bout' && x.sum) e.sum = true;   /* v2.1.9：总结症状标记 */
      add(character, e);
      added++;
    });
    return added;
  }

  global.CocMadness = {
    roll: roll,
    rollTable: rollTable,
    /* v2.1.9（用户第 3 项）：总结症状表 + 掷骰（背景症状 / 独处总结用） */
    rollSummary: rollSummary,
    backgroundText: backgroundText,
    boutTable: function () { return BOUT_TABLE.slice(); },
    summaryTable: function () { return SUMMARY_TABLE.slice(); },
    make: make,
    list: list,
    add: add,
    remove: remove,
    clear: clear,
    advance: advance,
    summary: summary,
    fading: fading,
    poolSize: poolSize,
    phobias: function () { return (DB.phobias || []).map(tag('phobia')); },
    manias: function () { return (DB.manias || []).map(tag('mania')); },
    labelOf: labelOf,
    /* 背景 ⇄ 结构化数组的桥（见上方注释） */
    lookup: lookup,
    hasName: hasName,
    parseBackground: parseBackground,
    fromBackground: fromBackground,
    fromPicked: fromPicked,
    size: (DB.phobias || []).length + (DB.manias || []).length
  };
})(window);
