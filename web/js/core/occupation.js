/* ============================================================
 * occupation.js — 职业模型
 *   1. 解析职业的「本职技能」描述文本 → 结构化选择规则
 *   2. 解析职业的「属性点公式」→ 职业技能点总数
 *   3. 计算职业点 / 兴趣点使用情况
 * ============================================================ */
(function (global) {
  'use strict';

  var R = global.COC7;
  var SKILLS = global.COC_SKILLS;
  var OCCUPATIONS = global.COC_OCCUPATIONS;

  /* ---------- 技能名 → 技能 id 映射 (含别名, 取自卡表"技能名的改变") ---------- */
  var ALIAS = {
    '图书馆': 'library', '图书馆使用': 'library',
    '计算机': 'computer', '电脑': 'computer', '计算机使用': 'computer',
    '汽车': 'drive_auto', '驾驶汽车': 'drive_auto', '汽车驾驶': 'drive_auto',
    '开锁': 'locksmith', '锁匠': 'locksmith',
    '自然学': 'natural_world', '博物学': 'natural_world',
    '导航': 'navigate', '领航': 'navigate',
    '重型操作': 'op_heavy', '重型机械': 'op_heavy', '重型': 'op_heavy',
    '重型机械操作': 'op_heavy', '操作重型机械': 'op_heavy',
    '信用': 'credit', '信誉': 'credit', '信用评级': 'credit',
    '克苏鲁': 'cthulhu', 'cm': 'cthulhu', '克苏鲁神话': 'cthulhu',
    '步枪': 'firearms', '霰弹枪': 'firearms', '步霰': 'firearms',
    '撬锁': 'locksmith',
    '侦查': 'spot_hidden', '侦察': 'spot_hidden',
    '电气维修': 'elec_repair', '机械维修': 'mech_repair',
    '技艺': 'art_craft', '艺术与手艺': 'art_craft', '艺术': 'art_craft',
    '科学': 'science', '格斗': 'fighting', '射击': 'firearms',
    '生存': 'survival', '驾驶': 'pilot', '外语': 'language_other',
    '母语': 'language_own', '学问': 'lore',
    '自然': 'natural_world', '骑乘': 'ride', '骑马': 'ride',
    '撬锁': 'locksmith', '速记': 'art_craft', '会计学': 'accounting',
    '医学': 'medicine', '急救': 'first_aid', '考古': 'archaeology',
    '心理': 'psychology', '开锁': 'locksmith', '电脑': 'computer',
    '摄影': 'art_craft', '说服': 'persuade', '法律': 'law',
    '手艺': 'art_craft', '其他语言': 'language_other', '语言': 'language_other',
    '电工': 'elec_repair', '马车驾驶': 'pilot', '自行车驾驶': 'pilot',
    '驾驶：船': 'pilot', '钳工': 'mech_repair', '礼仪': 'persuade',
    '拉丁语': 'language_other', '外语（母语或外语）': 'language_other',
    /* 技能库里这一项的正式名是「取悦」（旧译「魅惑」）。
       职业数据 130+ 处写的是「魅惑」，不别名过来的话
       「两项社交技能（魅惑、话术、恐吓、说服）」只能解析出 3 项。 */
    '魅惑': 'charm', '取悦': 'charm', '魅惑（取悦）': 'charm', '魅惑/取悦': 'charm',
    '电子学': 'elec_repair', '电子': 'elec_repair',
    '艺术及手艺': 'art_craft', '艺术/工艺': 'art_craft'
  };

  /* ---------- 组技能「子类」别名 ----------
   * 职业数据里的写法与技能库的子类名常有出入（制药 / 药剂学 → 药学，拉丁文 → 拉丁语…）
   * 不归一化的话，「科学（生物学，制药）」会丢一项。 */
  var SUB_ALIAS = {
    '制药': '药学', '药剂学': '药学', '药物学': '药学',
    '拉丁文': '拉丁语',
    '物理': '物理学', '生物': '生物学', '植物': '植物学', '天文': '天文学',
    '地质': '地质学', '气象': '气象学', '动物': '动物学', '密码': '密码学',
    '工程': '工程学', '司法': '司法科学', '药理': '药学',
    '驾驶（船）': '船', '驾驶（飞行器）': '飞行器', '驾驶（飞行器或船）': '飞行器'
  };

  /** 把「子类写法」归一到技能库里的正式子类名；匹配不到返回 null */
  function canonicalSub(subs, name) {
    if (!name) return null;
    var s = String(name).trim()
      .replace(/^如/, '')
      .replace(/^[（(]|[）)]$/g, '')
      .replace(/[（(].*$/, '')
      .trim();
    if (!s) return null;
    var i, n;
    for (i = 0; i < subs.length; i++) if (subs[i].name === s) return subs[i].name;
    if (SUB_ALIAS[s]) {
      for (i = 0; i < subs.length; i++) if (subs[i].name === SUB_ALIAS[s]) return subs[i].name;
    }
    // 后缀差异：「生物」↔「生物学」；只允许前缀关系，避免误伤
    for (i = 0; i < subs.length; i++) {
      n = subs[i].name;
      if (n.length >= 2 && s.length >= 2 && (n.indexOf(s) === 0 || s.indexOf(n) === 0)) return n;
    }
    return null;
  }
  var NAME2ID = {};
  SKILLS.forEach(function (s) {
    NAME2ID[s.name] = s.id;
    NAME2ID[s.name.replace(/[：:]/g, '')] = s.id;
  });
  Object.keys(ALIAS).forEach(function (k) { NAME2ID[k] = ALIAS[k]; });
  // 长名优先匹配
  var NAME_KEYS = Object.keys(NAME2ID).sort(function (a, b) { return b.length - a.length; });

  function resolveSkillId(name) {
    if (!name) return null;
    name = String(name).trim().replace(/[：:]/g, '');
    if (NAME2ID[name]) return NAME2ID[name];
    for (var i = 0; i < NAME_KEYS.length; i++) {
      if (name.indexOf(NAME_KEYS[i]) === 0) return NAME2ID[NAME_KEYS[i]];
    }
    return null;
  }

  function skillById(id) {
    for (var i = 0; i < SKILLS.length; i++) if (SKILLS[i].id === id) return SKILLS[i];
    return null;
  }

  /* ============================================================
   * 技能搜索索引
   * ------------------------------------------------------------
   * 曾经的搜索只比对技能「本身」的名字：
   *   · 组技能（格斗 / 射击 / 科学 / 技艺 / 驾驶 / 生存 / 学识 / 其他语言）
   *     只有组名进了索引，子类名完全没有 —— 搜「斗殴」「步枪」「拉丁语」
   *     会把整组直接过滤掉，什么都搜不到；
   *   · 技能库里「取悦」在职业数据里大量写作旧译「魅惑」，搜「魅惑」也会落空。
   * 这里把「组名 + 全部子类名 + 别名 + 分类 + 描述」合成一个可检索文本，
   * 组技能再额外支持「按子类名只列出命中的那个子类」。
   * ============================================================ */

  /** 子类名 → 所属组技能 id */
  var SUB2GROUP = {};
  SKILLS.forEach(function (s) {
    if (s.special) (s.subskills || []).forEach(function (sub) { SUB2GROUP[sub.name] = s.id; });
  });

  /** 与某技能 id 相关的全部中文别名 */
  function aliasesOf(id) {
    var out = [];
    Object.keys(ALIAS).forEach(function (k) { if (ALIAS[k] === id) out.push(k); });
    return out;
  }

  /** 一个技能定义（含组技能的全部子类）参与搜索的文本 */
  function skillSearchText(def) {
    if (!def) return '';
    var parts = [def.id || '', def.name || '', def.category || '', def.desc || ''];
    parts = parts.concat(aliasesOf(def.id));
    if (def.special) {
      (def.subskills || []).forEach(function (s) {
        parts.push(s.name);
        Object.keys(SUB_ALIAS).forEach(function (k) { if (SUB_ALIAS[k] === s.name) parts.push(k); });
      });
    }
    return parts.join(' ').toLowerCase();
  }

  /** 关键词能否命中该技能定义（组技能：命中组名 或 任一子类名） */
  function skillMatches(def, kw) {
    if (!kw) return true;
    return skillSearchText(def).indexOf(String(kw).trim().toLowerCase()) >= 0;
  }

  /**
   * 搜子类名时只列出命中的子类（避免搜「斗殴」却把 7 个格斗专攻全列出来）。
   * 命中组名 / 关键词为空 → 返回 null，表示「整组都要列」。
   */
  function matchedSubs(def, kw) {
    if (!def || !def.special) return null;
    kw = String(kw || '').trim().toLowerCase();
    if (!kw) return null;
    if ((def.name || '').toLowerCase().indexOf(kw) >= 0) return null;   // 命中组名 → 全列
    var out = (def.subskills || []).filter(function (s) {
      return s.name.toLowerCase().indexOf(kw) >= 0;
    });
    return out.length ? out : null;
  }

  /**
   * 一个「技能实例」（可能是组技能的某个专攻）参与搜索的文本。
   * 注意：专攻实例不并入同组其它子类名 —— 否则搜「斗殴」会把 7 个格斗专攻全列出来。
   */
  function instanceSearchText(id, sub) {
    var def = skillById(id);
    if (!def) return String(sub || id || '').toLowerCase();
    var parts = [def.id || '', def.name || '', def.category || '', sub || ''];
    parts = parts.concat(aliasesOf(def.id));
    if (sub) {
      Object.keys(SUB_ALIAS).forEach(function (k) { if (SUB_ALIAS[k] === sub) parts.push(k); });
    } else if (def.special) {
      (def.subskills || []).forEach(function (s) { parts.push(s.name); });
    }
    return parts.join(' ').toLowerCase();
  }

  /** 技能是否命中关键词（按实例：id + 专攻名） */
  function instanceMatches(id, sub, kw) {
    if (!kw) return true;
    return instanceSearchText(id, sub).indexOf(String(kw).trim().toLowerCase()) >= 0;
  }

  /* ---------- 顶层分割（忽略括号内） ---------- */
  function splitTop(text, seps) {
    var out = [], buf = '', depth = 0;
    var open = '（(【', close = '）)】';
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (open.indexOf(ch) >= 0) depth++;
      else if (close.indexOf(ch) >= 0) depth--;
      if (depth === 0 && seps.indexOf(ch) >= 0) {
        if (buf.trim()) out.push(buf.trim());
        buf = '';
      } else buf += ch;
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  }

  var CN_NUM = { '一': 1, '两': 2, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8 };

  /**
   * 解析本职技能描述
   * @returns Array<Requirement>
   *  Requirement:
   *   { id, type:'fixed',  skill, sub }          固定技能
   *   { id, type:'choice', count, pool:[{skill,sub}], label }   从池中选 count 项
   *   { id, type:'free',   count, label }        任选 count 项
   *   { id, type:'alt',    options:[Requirement], label }       或 — 择一
   */
  function parseSkillText(text) {
    if (!text) return [];
    var t = String(text)
      /* 数据里有的职业用换行分行（甚至整段重复粘贴）。
         换行必须尽早变成逗号：JS 正则的 `.` 默认不匹配换行，
         留着它会让「N 项…」这类整行匹配直接失败，退化成「择一」并产出 undefined。 */
      .replace(/\r?\n/g, '，')
      // 句号不是分隔符，紧跟分隔符或位于行尾时去掉，避免混进选项名
      .replace(/。\s*(?=[，,、；;]|$)/g, '')
      .replace(/[。；;]\s*$/g, '')
      .replace(/任意其他/g, '任意')
      /* 「任两种其他学术或个人特长」「任意四项其他学术、时代或个人特长」
         本质都是「自由选择 N 项」，中间那些「或／、」不是择一、也不是分隔，
         先整体收成一个不含分隔符的说法，后面才不会被拆坏。 */
      .replace(
        /任(?:意)?\s*([一二两三四五六七八九十\d]+)\s*[种项]\s*(?:其他)?\s*(?:学术|学识|个人|时代)(?:\s*[、，,或\/]\s*(?:学术|学识|个人|时代))*\s*(?:特长|技能)?[。]?/g,
        function (m, n) { return '任' + n + '项个人或时代特长'; }
      )
      .replace(/可以使用/g, '')
      .replace(/※[^，,]*/g, '')
      .replace(/以及/g, '')
      .replace(/(从)?(下面|以下)(中)?/g, '')
      .replace(/(最多)?(选取|选择|任选)(?=\s*[一二两三四五六七八九十\d]+\s*项)/g, '')
      .trim();
    if (!t) return [];

    // 特例：自定义职业的自由描述
    var mFree = t.match(/^不多于\s*(\d+)\s*个本职技能/);
    if (mFree) {
      return [{ id: 'r0', type: 'free', count: parseInt(mFree[1], 10), label: '任选 ' + mFree[1] + ' 项本职技能' }];
    }

    var parts = splitTop(t, '，,、');
    // 去重：部分职业数据里同一项被写了两次（如「士兵」的潜行），
    // 重复项会在界面上变成两个一模一样的「本职」条目。
    var seenPart = {};
    var reqs = [], idx = 0;

    parts.forEach(function (raw) {
      var part = raw.trim();
      if (!part || seenPart[part]) return;
      seenPart[part] = true;
      var rs = parsePart(part);
      (Array.isArray(rs) ? rs : [rs]).forEach(function (r) {
        if (r) reqs.push(assignId(r, idx++));
      });
    });

    return reqs;
  }

  function assignId(r, i) {
    r.id = 'r' + i;
    if (!r.label) r.label = reqLabel(r);
    return r;
  }

  function reqLabel(r) {
    if (r.type === 'fixed') {
      var s = skillById(r.skill);
      return s ? s.name + (r.sub ? '（' + r.sub + '）' : (r.isGroup ? '（任选子类）' : '')) : r.skill;
    }
    if (r.type === 'alt' && r.options) {
      return r.options.map(function (o) {
        if (o && (o.skill || o.type === 'fixed')) {
          var d = skillById(o.skill);
          return (d ? d.name : o.skill) + (o.sub ? '（' + o.sub + '）' : (o.isGroup ? '（任选子类）' : ''));
        }
        // 择一项里也可能是「自由选择 / 组技能任选」这类没有 skill 的项。
        // 老实现直接读 o.skill → undefined，界面上就出现「undefined 或 undefined」。
        return (o && (o.label || o.raw)) || '自由选择';
      }).join(' 或 ');
    }
    return r.label || '';
  }

  var ANY_WORD = /^(任一|任意|任选|任何|任意一个|任意一种)/;

  /**
   * 解析单个顶层片段
   * 顺序很重要：先处理「N项」整体，避免「个人或时代」被误当作择一
   */
  function parsePart(part) {
    var p = part.trim().replace(/^[：:]\s*/, '');
    if (!p) return null;

    // ---- 1) 「(任意)N项 …」 / 「任N种 …」 ----
    // 前缀允许只写「任」，量词允许「种」——数据里两种写法都有
    var m = p.match(/^(任(?:意)?)?\s*([一二两三四五六七八九十\d]+)\s*[种项]\s*(.*)$/);
    if (m) {
      var cnt = CN_NUM[m[2]] || parseInt(m[2], 10) || 1;
      var rest = (m[3] || '').trim();
      var any = !!m[1];

      // 1a) 后接「名称（池）」
      var mm = rest.match(/^([^（(]*)[（(]([^）)]*)[）)]\s*(.*)$/);
      if (mm) {
        var catName = (mm[1] || '').trim();
        var inner = (mm[2] || '').trim();
        var tail = (mm[3] || '').trim();
        var label = (any ? '任意' : '') + num2cn(cnt) + '项' + catName;
        // 「如…」是举例提示，不作为限定池
        if (!/^如/.test(inner)) {
          var pool = buildPool(inner);
          if (pool.length >= 2) {
            return { type: 'choice', count: cnt, pool: pool, label: label };
          }
          if (pool.length === 1) {
            return { type: 'fixed', skill: pool[0].skill, sub: pool[0].sub, weight: cnt };
          }
        }
        if (inner) label += '（' + inner + '）';
        return { type: 'free', count: cnt, label: label };
      }

      // 1b) 后接「：具体技能」或「：（池）」
      var m2 = rest.match(/^[：:]\s*(.+)$/);
      if (m2) {
        var inner0 = m2[1].trim();
        var pool3 = buildPool(inner0.replace(/^[（(]|[）)]$/g, ''));
        if (pool3.length >= 2) {
          return { type: 'choice', count: cnt, pool: pool3,
            label: (any ? '任意' : '') + num2cn(cnt) + '项技能' };
        }
        var sid2 = resolveSkillId(inner0);
        if (sid2) return { type: 'fixed', skill: sid2, sub: null, weight: cnt };
      }

      // 1c) 纯自由选择
      return { type: 'free', count: cnt, label: (any ? '任意' : '') + num2cn(cnt) + '项' + (rest || '技能') };
    }

    // ---- 2) 「A 或 B」 择一（splitTop 已忽略括号内） ----
    var alts = splitTop(p, '或');
    if (alts.length > 1) {
      var options = [];
      alts.forEach(function (a) {
        var sub = parseSingle(a.trim());
        if (sub && sub.type !== 'alt') options.push(sub);
      });
      if (options.length > 1) {
        var opt = { type: 'alt', options: options };
        opt.label = reqLabel(opt);
        return opt;
      }
      if (options.length === 1) return options[0];
    }

    // ---- 3) 单项 ----
    return parseSingle(p);
  }

  /** 解析不可再分的单项技能 */
  function parseSingle(part) {
    var p = String(part).trim().replace(/^[：:]\s*/, '');
    if (!p) return null;

    // 组技能 + 括号
    var m4 = p.match(/^([^（(]+)[（(]([^）)]*)[）)]\s*(.*)$/);
    if (m4) {
      var base = m4[1].trim();
      var inner = m4[2].trim();
      var tail = (m4[3] || '').trim();
      var sid = resolveSkillId(base);
      if (sid) {
        var def = skillById(sid);
        var subs = (def && def.special) ? def.subskills : [];

        // 「如…」举例 → 视为自由选择并保留提示
        if (/^如/.test(inner)) {
          var pool2 = buildPool(inner.replace(/^如/, ''));
          if (pool2.length >= 2) {
            return { type: 'choice', count: 1, pool: pool2, label: '一项' + def.name };
          }
          return { type: 'free', count: 1, label: '一项' + def.name + '（' + inner + '）' };
        }

        // 「任一 / 任意」→ 整组任选
        if (ANY_WORD.test(inner)) {
          if (subs.length) {
            return { type: 'choice', count: 1,
              pool: subs.map(function (s) { return { skill: sid, sub: s.name, name: s.name }; }),
              label: '一项' + def.name };
          }
          return { type: 'fixed', skill: sid, sub: null, isGroup: true };
        }

        if (subs.length) {
          var subList = splitTop(inner, '、,，');
          // 子类名做归一化匹配（制药→药学、拉丁文→拉丁语、生物→生物学…）
          var resolved = [];
          subList.forEach(function (s) {
            var c = canonicalSub(subs, s);
            if (c && resolved.indexOf(c) < 0) resolved.push(c);
          });
          if (resolved.length === subList.length && resolved.length === 1) {
            return { type: 'fixed', skill: sid, sub: resolved[0] };
          }
          if (resolved.length > 1) {
            var opts = resolved.map(function (s) { return { type: 'fixed', skill: sid, sub: s }; });
            var alt = { type: 'alt', options: opts };
            alt.label = reqLabel(alt);
            return alt;
          }
          // 未识别子类名 → 整组
          return { type: 'fixed', skill: sid, sub: null, isGroup: true };
        }
        return { type: 'fixed', skill: sid, sub: tail || null };
      }
    }

    // 纯技能名
    var sid5 = resolveSkillId(p);
    if (sid5) {
      var d5 = skillById(sid5);
      if (d5 && d5.special) {
        // 组技能（技艺/科学/格斗/射击/驾驶/生存/外语）→ 整组开放
        return { type: 'fixed', skill: sid5, sub: null, isGroup: true };
      }
      return { type: 'fixed', skill: sid5, sub: null };
    }

    // 无法识别 → 自由选择，保留原文供提示
    return { type: 'free', count: 1, label: p, raw: p };
  }

  function num2cn(n) {
    var map = { 1: '一', 2: '两', 3: '三', 4: '四', 5: '五', 6: '六', 7: '七', 8: '八' };
    return map[n] || String(n);
  }

  function buildPool(text) {
    var pool = [];
    var seen = {};
    splitTop(text, '、,，或/').forEach(function (s) {
      s = s.replace(/^如/, '').replace(/等$/, '').trim();
      if (!s) return;
      var id = resolveSkillId(s);
      if (!id || seen[id]) return;    // 去重：同一技能被写两遍只算一项
      seen[id] = true;
      var def = skillById(id);
      // 用技能库的正式名，保证选项文字和技能列表里看到的一致
      // （数据写「魅惑」、库里叫「取悦」，两边统一显示后者）
      pool.push({ skill: id, sub: null, name: def ? def.name : s });
    });
    return pool;
  }

  /* ---------- 职业属性点公式 ---------- */
  function evalFormula(formula, attrs) {
    if (!formula) return 0;
    var f = String(formula).replace(/[＋]/g, '+').replace(/[×✕xX*]/g, '*').trim();
    if (!f) return 0;
    var terms = f.split('+');
    var total = 0, ok = false;
    terms.forEach(function (term) {
      term = term.trim();
      if (!term) return;
      var m = term.match(/^(.+?)\s*\*\s*(\d+)$/);
      if (!m) return;
      var names = m[1].split('或');
      var mult = parseInt(m[2], 10);
      var vals = names.map(function (n) {
        var k = R.attrByName(n);
        return k ? (parseInt(attrs[k], 10) || 0) : null;
      }).filter(function (v) { return v !== null; });
      if (!vals.length) return;
      total += Math.max.apply(null, vals) * mult;
      ok = true;
    });
    return ok ? total : 0;
  }

  /* ============================================================
   * 职业模型 API
   * ============================================================ */
  function getById(id) {
    for (var i = 0; i < OCCUPATIONS.length; i++) if (OCCUPATIONS[i].id === id) return OCCUPATIONS[i];
    return null;
  }

  function listAll() { return OCCUPATIONS; }

  /**
   * 职业的可检索文本。
   * 除了名称 / 描述 / 原文，还把「解析后的技能名」与「技能库里这些技能的
   * 正式名 + 全部子类名」并进来 —— 职业数据写「魅惑」、技能库叫「取悦」，
   * 只比对原文的话，搜「取悦」就找不到任何一个需要社交技能的职业。
   */
  var occSearchCache = {};
  function collectReqSkillIds(r, out) {
    if (!r) return;
    if (r.skill) out[r.skill] = true;
    if (r.pool) r.pool.forEach(function (p) { if (p.skill) out[p.skill] = true; });
    if (r.options) r.options.forEach(function (x) { collectReqSkillIds(x, out); });
  }
  function searchTextOfOccupation(o) {
    if (occSearchCache[o.id]) return occSearchCache[o.id];
    var parts = [o.name || '', o.desc || '', o.skillText || '', o.attrFormula || '', o.creditText || ''];
    var ids = {};
    try {
      parseSkillText(o.skillText).forEach(function (r) {
        parts.push(reqLabel(r));
        collectReqSkillIds(r, ids);
      });
    } catch (e) { /* 单条数据解析失败不影响搜索 */ }
    Object.keys(ids).forEach(function (id) {
      var def = skillById(id);
      if (def) parts.push(skillSearchText(def));   // 组技能 → 连子类名一起进索引
    });
    occSearchCache[o.id] = parts.join(' ').toLowerCase();
    return occSearchCache[o.id];
  }

  /** 按关键词搜索职业（名称 / 描述 / 技能原文 / 解析后的技能名与别名的统一索引） */
  function search(kw) {
    if (!kw) return OCCUPATIONS;
    kw = String(kw).trim().toLowerCase();
    return OCCUPATIONS.filter(function (o) { return searchTextOfOccupation(o).indexOf(kw) >= 0; });
  }

  var cache = {};
  /** 取得该职业的结构化技能要求（含用户已选项） */
  function getRequirements(character) {
    var occ = getById(character.occupationId);
    if (!occ) return [];
    var key = occ.id;
    if (!cache[key]) cache[key] = parseSkillText(occ.skillText);
    var picked = character.occupationPicks || {};
    // 深拷贝并附加已选状态
    return cache[key].map(function (r) {
      var c = JSON.parse(JSON.stringify(r));
      c.picked = picked[c.id] || [];
      return c;
    });
  }

  /**
   * 组技能「没指定专攻」时该算哪个专攻。
   *
   * ⚠️ 这是「一张卡冒出 40 项本职技能」的根治点。
   * 职业原文里经常只写「格斗」「技艺」「射击」而不点名专攻，
   * 早先的实现把整组（技艺 30 个专攻、格斗 7 个）全部标成本职，
   * 于是「厨师」「技师」这类卡的本职技能能到 40-51 项 ——
   * 界面上根本看不完，点数也被摊得极薄。
   * 规则书里这种写法是「任选一个专攻」，所以只该算**一个**。
   *
   * 取值顺序（保证稳定，不能随机 —— 校验器与界面会反复调用）：
   *   ① 已经选过就用选过的（occupationPicks）
   *   ② 职业原文点名的专攻（「手艺（烹饪）」→ 烹饪）
   *   ③ 否则取该组第一个专攻
   */
  function groupSubFor(character, r, def) {
    var subs = (def && def.subskills) || [];
    if (!subs.length) return '';

    var picked = (r && r.picked) || [];
    for (var i = 0; i < picked.length; i++) {
      if (picked[i] && picked[i].sub) return picked[i].sub;
    }

    var occ = getById(character && character.occupationId);
    var text = String((occ && (occ.skillText || '')) + '　' + ((occ && occ.desc) || ''));
    for (var j = 0; j < subs.length; j++) {
      if (subs[j].name && text.indexOf(subs[j].name) >= 0) return subs[j].name;
    }
    return subs[0].name;
  }

  /** 标记一个技能（组技能会自动收敛到单个专攻） */
  function markReq(set, character, reqOrItem, skillId, sub, on) {
    if (!skillId) return;
    var def = skillById(skillId);
    if (def && def.special && !sub) {
      var one = groupSubFor(character, reqOrItem, def);
      set[skillId + '::' + one] = on;
      return;
    }
    set[sub ? skillId + '::' + sub : skillId] = on;
  }

  /** 该职业的全部可选技能池（用于判断某技能是否为"本职"） */
  function occupationalSet(character) {
    var set = {};
    var occ = getById(character.occupationId);
    if (!occ) return set;
    var reqs = getRequirements(character);
    reqs.forEach(function (r) {
      if (r.type === 'fixed') { markReq(set, character, r, r.skill, r.sub, true); }
      else if (r.type === 'choice') {
        var chosen = r.picked || [];
        if (chosen.length) {
          chosen.forEach(function (p) { markReq(set, character, r, p.skill, p.sub, true); });
        } else {
          r.pool.forEach(function (p) { markReq(set, character, r, p.skill, p.sub, true); });
        }
      } else if (r.type === 'alt') {
        var ch = r.picked || [];
        if (ch.length) markReq(set, character, r, ch[0].skill, ch[0].sub, true);
        else r.options.forEach(function (o) { markReq(set, character, r, o.skill, o.sub, true); });
      } else if (r.type === 'free') {
        (r.picked || []).forEach(function (p) { markReq(set, character, r, p.skill, p.sub, true); });
      }
    });
    return set;
  }

  function markSkill(set, skillId, sub, on) {
    /* 注意：这里**不再**把组技能整组展开。
       需要「组技能收敛到一个专攻」时请用 markReq()，它要用到角色上下文。 */
    if (!skillId) return;
    set[sub ? skillId + '::' + sub : skillId] = on;
  }

  /** 取「生效属性」（含年龄调整与教育进步增益）；Engine 未就绪时回落到原始属性 */
  function attrsFor(character) {
    var E = global.Engine;
    if (E && E.effAttrs) {
      try { return E.effAttrs(character); } catch (e) { /* 回落 */ }
    }
    return (character && character.attributes) || {};
  }

  /** 职业技能点总数（按生效属性算：EDU 被教育进步检定抬高后，点数要跟着涨）
   *
   * ⚠️ 这里**不再**有「点数总额上限」。
   * 早先的 AI 设置把「职业技能点数上限」理解成「压缩整个点数池」，
   * 于是 total 变小、界面显示「职业点 80/280」，看着像有 200 点没用完。
   * 现在的语义是**每个技能最终值**的上限（见 skillCapOf），
   * 点数池始终是规则算出的全额 —— 玩家设上限不会凭空少掉点数，
   * 只是每一项最多点到那个值。
   */
  function occupationPoints(character) {
    var occ = getById(character.occupationId);
    var total = occ ? evalFormula(occ.attrFormula, attrsFor(character)) : 0;
    var used = usedOccPoints(character);
    return { total: total, used: used, remain: total - used };
  }

  function usedOccPoints(character) {
    return (character.skills || []).reduce(function (a, s) {
      return a + (s.occ || 0) + (s.creditOcc || 0);
    }, 0);
  }

  /** 兴趣技能点总数 = INT × 2 */
  function interestPoints(character) {
    var attrs = attrsFor(character);
    var base = parseInt(attrs && attrs.int, 10) || 0;
    var total = base * 2;
    var used = (character.skills || []).reduce(function (a, s) { return a + (s.int || 0); }, 0);
    return { total: total, used: used, remain: total - used };
  }

  global.CocOccupation = {
    listAll: listAll, getById: getById, search: search,
    parseSkillText: parseSkillText,
    getRequirements: getRequirements,
    occupationalSet: occupationalSet,
    occupationPoints: occupationPoints,
    interestPoints: interestPoints,
    pointsFull: function (character) {
      var o = getById(character.occupationId);
      var attrs = attrsFor(character);
      return {
        occ: o ? evalFormula(o.attrFormula, attrs) : 0,
        int: (parseInt(attrs && attrs.int, 10) || 0) * 2
      };
    },
    evalFormula: evalFormula,
    resolveSkillId: resolveSkillId,
    skillById: skillById,
    /* 搜索索引（供「指定技能」选择器与技能列表共用） */
    skillSearchText: skillSearchText,
    skillMatches: skillMatches,
    matchedSubs: matchedSubs,
    instanceSearchText: instanceSearchText,
    instanceMatches: instanceMatches,
    subToGroup: SUB2GROUP,
    name2id: NAME2ID
  };
})(window);
