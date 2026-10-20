/* ============================================================
 * ai.js — 大模型接入（AI 车卡）
 *
 * 分两层：
 *   AIClient —— 一个极小的 OpenAI 兼容 chat 客户端。
 *       安卓外壳下走原生桥（AndroidBridge.httpPostAsync）发起请求：
 *       网页的源是 https://appassets.androidplatform.net，直接 fetch 外部接口
 *       会撞上跨域预检和混合内容策略，而多数模型服务并不返回 CORS 头；
 *       浏览器里则回退到 fetch，方便本地调试。
 *   AIGen —— 提示词与结果落地。
 *       AI 只负责「是谁、做什么、长什么样、有什么故事」这类创意字段，
 *       数值部分（属性合法性、职业点、技能上限、装备、资产）全部交给
 *       preset.js 用规则引擎生成，保证出来的卡一定是能用的。
 * ============================================================ */
(function (global) {
  'use strict';

  var Store = global.Store;

  /* ---------- 全局请求参数 ----------
     maxTokens 要同时装下「推理模型的思考链」和「正文」，所以给得比普通模型宽。
     实测 LongCat-2.5-Preview：1800 会把 79% 的额度用在思考上、正文被截断；
     6000 时 reasoning 只占 202，正文完整。见 chat() 的注释。 */
  var DEFAULT_MAX_TOKENS = 6000;
  var DEFAULT_TIMEOUT = 180000;   // 推理模型慢，3 分钟比 90 秒稳妥
  var MAX_RETRY_TOKENS = 16000;   // 第一次被截断时的第二次额度

  /* ============================================================
   * 一、HTTP 通道
   * ============================================================ */
  var seq = 0;
  var pending = {};

  /** 原生桥回调用 */
  global.__cocHttpDone = function (reqId, payload) {
    var fn = pending[reqId];
    if (!fn) return;
    delete pending[reqId];
    var data;
    try { data = JSON.parse(payload); }
    catch (e) { data = { ok: false, error: '返回数据无法解析' }; }
    fn(data);
  };

  function hasBridge() {
    try { return !!(global.AndroidBridge && global.AndroidBridge.httpPostAsync); }
    catch (e) { return false; }
  }

  /**
   * 发起一次 HTTP 请求
   * @param {string} url
   * @param {Object} headers
   * @param {string} body  POST 时才需要
   * @param {number} timeoutMs
   * @param {string} method 默认 POST；传 'GET' 走无请求体的探测（见 test()）
   */
  function request(url, headers, body, timeoutMs, method) {
    timeoutMs = timeoutMs || 90000;
    method = (method || 'POST').toUpperCase();
    if (method === 'GET') body = '';

    if (hasBridge()) {
      return new Promise(function (resolve) {
        var id = 'ai' + (++seq) + '_' + Date.now();
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          delete pending[id];
          resolve({ ok: false, error: '请求超时（超过 ' + Math.round(timeoutMs / 1000) + ' 秒没有响应）' });
        }, timeoutMs + 5000);

        pending[id] = function (res) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(res);
        };
        try {
          if (method === 'GET') global.AndroidBridge.httpGetAsync(id, url, JSON.stringify(headers));
          else global.AndroidBridge.httpPostAsync(id, url, JSON.stringify(headers), body);
        } catch (e) {
          clearTimeout(timer);
          delete pending[id];
          resolve({ ok: false, error: '发起请求失败：' + (e.message || e) });
        }
      });
    }

    // 浏览器：走 fetch（本地调试用；线上由原生桥兜底）
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer2 = setTimeout(function () { if (ctl) ctl.abort(); }, timeoutMs);
    return global.fetch(url, {
      method: method,
      headers: headers,
      body: method === 'GET' ? undefined : body,
      signal: ctl ? ctl.signal : undefined
    }).then(function (r) {
      return r.text().then(function (t) {
        clearTimeout(timer2);
        return { ok: r.ok, status: r.status, body: t };
      });
    }).catch(function (e) {
      clearTimeout(timer2);
      var msg = (e && e.name === 'AbortError') ? '请求超时'
        : /Failed to fetch|NetworkError|Load failed/i.test(String(e && e.message))
          ? '无法连接接口地址，请检查网络与地址是否正确'
          /* 其余异常统一走翻译：本地调试时 fetch 也可能带回同样的原生异常文案 */
          : explainRequestError((e && e.message) || e);
      return { ok: false, error: msg };
    });
  }

  /**
   * 把「发起请求阶段」的异常翻译成人话。
   *
   * 这里单独处理一个高频坑：安卓原生桥抛回来的
   * `java.lang.IllegalStateException: Cannot set request property after connection is made`
   * 并不是网络/Key/地址的问题，而是**外壳代码的 bug**（在 getOutputStream() 之后
   * 才设请求头）。用户填的东西全对，却看到「连接失败」，非常困惑。
   * 明确指出「这是应用自身的缺陷，请更新版本」比让他去检查 Key 有用得多。
   */
  function explainRequestError(msg) {
    var s = String(msg || '');
    if (/Cannot set request property after connection is made/i.test(s)) {
      return '这是应用自身的缺陷（请求头设置时机不对），与你的 Key、地址无关。' +
             '请升级到修复后的版本；当前版本无法正常发起请求。';
    }
    if (/Cleartext.*not permitted|NetworkSecurityPolicy/i.test(s)) {
      return '接口地址是 http://，但系统不允许明文流量。请改用 https:// 地址。';
    }
    if (/UnknownHost|unable to resolve host/i.test(s)) {
      return '域名解析失败，请检查接口地址是否写错、是否有网络连接。';
    }
    if (/SSL|handshake|certificate/i.test(s)) {
      return 'HTTPS 握手失败，可能是证书问题或该服务需要自签证书。';
    }
    if (/timeout|timed out/i.test(s)) return '连接超时，网络可能较慢或被拦截。';
    if (/Connection refused|ECONNREFUSED/i.test(s)) return '连接被拒绝，地址或端口可能有误。';
    return '请求失败：' + s;
  }

  /** 把 HTTP 错误翻译成人能看懂的话 */
  function explainError(res) {
    var detail = '';
    try {
      var j = JSON.parse(res.body);
      detail = (j && j.error && (j.error.message || j.error.type)) || (j && j.message) || '';
    } catch (e) { /* 不是 JSON，忽略 */ }

    var code = res.status;
    var head;
    if (code === 400) head = '请求被拒绝（400），可能是模型名称不对，或该模型不支持这种调用';
    else if (code === 401) head = 'API Key 不正确或已失效（401）';
    else if (code === 402) head = '账户余额不足（402）';
    else if (code === 403) head = '没有访问权限（403），请确认 Key 的可用范围';
    else if (code === 404) head = '接口地址或模型名称不存在（404）';
    else if (code === 422) head = '参数不被接受（422）';
    else if (code === 429) head = '请求过于频繁或额度已用尽（429），稍后再试';
    else if (code >= 500) head = '模型服务端出错（' + code + '），稍后再试';
    else head = '请求失败（' + (code || '无响应') + '）';

    return detail ? (head + '：' + detail) : head;
  }

  /* ============================================================
   * 二、客户端
   * ============================================================ */
  function cfg() {
    var s = (Store.getState().settings) || {};
    return {
      base: String(s.aiBase || '').trim(),
      model: String(s.aiModel || '').trim(),
      key: String(s.aiKey || '').trim()
    };
  }

  function configured() {
    var c = cfg();
    return !!(c.base && c.model && c.key);
  }

  function endpointOf(base) {
    var b = base.replace(/\s+/g, '').replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(b)) return b;
    return b + '/chat/completions';
  }

  /**
   * 发一次对话请求，返回模型回复的纯文本。
   * @param {Array} messages [{role, content}]
   * @param {Object} opt { temperature, maxTokens, timeout }
   */
  /**
   * 发一次对话请求，返回模型回复的纯文本。
   * @param {Array} messages [{role, content}]
   * @param {Object} opt { temperature, maxTokens, timeout, onMeta }
   *
   * ⚠️ maxTokens 的默认值为什么是 6000 而不是 1800 ——
   * 推理型模型（LongCat / DeepSeek-Reasoner / o 系列 / R1 蒸馏版）会把
   * max_tokens 里的一大半花在 reasoning_content（思考链）上，正文只拿到剩下的。
   * 实测 LongCat-2.5-Preview 生成一张角色卡：
   *   max_tokens=1800 → reasoning_tokens=1425（占 79%），
   *     finish_reason=length，正文只剩 750 字符，JSON 在半个字符串处被截断 → 「JSON 不完整」
   *   max_tokens=6000 → reasoning_tokens=202，正文 1082 字符，finish_reason=stop，完整 JSON
   * 所以默认额度必须留够「思考链 + 正文」两份，不能按普通模型的正文长度来定。
   */
  function chat(messages, opt) {
    opt = opt || {};
    var c = cfg();
    if (!c.base) return Promise.reject(new Error('还没填写接口地址，请先到「AI 设置」里配置'));
    if (!c.model) return Promise.reject(new Error('还没填写模型名称，请先到「AI 设置」里配置'));
    if (!c.key) return Promise.reject(new Error('还没填写 API Key，请先到「AI 设置」里配置'));

    var body = JSON.stringify({
      model: c.model,
      messages: messages,
      temperature: opt.temperature === undefined ? 0.9 : opt.temperature,
      max_tokens: opt.maxTokens || DEFAULT_MAX_TOKENS,
      stream: false
    });

    return request(endpointOf(c.base), {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + c.key
    }, body, opt.timeout || DEFAULT_TIMEOUT).then(function (res) {
      if (res.error) throw new Error(explainRequestError(res.error));
      if (!res.ok) throw new Error(explainError(res));
      var data;
      try { data = JSON.parse(res.body); }
      catch (e) { throw new Error('服务返回的内容不是 JSON，请确认接口地址填的是 OpenAI 兼容接口'); }

      var ch = (data.choices || [])[0];
      var text = ch ? ((ch.message && ch.message.content) || ch.text || '') : '';

      /* 把「这次请求花了多少 token / 有没有被截断」告诉调用方。
         调用方据此判断要不要用更大额度重试 —— 这是唯一可靠的重试信号：
         finish_reason=length 就意味着正文被硬生生切断了，
         解析再宽容也救不回来，必须重发。 */
      if (typeof opt.onMeta === 'function') {
        var u = data.usage || {};
        var det = u.completion_tokens_details || {};
        opt.onMeta({
          finishReason: ch ? String(ch.finish_reason || '') : '',
          completionTokens: u.completion_tokens || 0,
          reasoningTokens: det.reasoning_tokens || 0,
          truncated: !!ch && String(ch.finish_reason) === 'length'
        });
      }

      if (!text) {
        /* 内容为空但有思考链 → 几乎必然是额度被思考链吃光了 */
        if (ch && (ch.message && ch.message.reasoning_content)) {
          throw new Error('模型只输出了思考过程、没有输出正文。' +
            '这是额度不够导致的（推理型模型会把 max_tokens 的一大截用在思考上），请稍后重试。');
        }
        throw new Error('模型没有返回任何内容');
      }
      return String(text);
    });
  }

  /* ---------- 从响应里挖出模型回复 ----------
     ⚠️ 不要用 reasoning_content 兜底：那是模型的思考链，不是给用户看的回复。
     推理型模型（deepseek-reasoner / o 系列 / R1 蒸馏版）在小 max_tokens 下
     会把额度全花在思考链上，content 为空而 reasoning_content 很长。
     自检时如果拿思考链当「回复」，就会把「额度不够」误判成「连接正常且有回复」，
     掩盖掉真正需要提醒用户的事。 */
  function pickText(data) {
    var ch = (data && (data.choices || [])[0]) || null;
    if (!ch) return '';
    var m = ch.message || {};
    return String(m.content || ch.text || '');
  }

  /** 单独取思考链长度，用于自检时解释「为什么没有文字」 */
  function reasoningLen(data) {
    var ch = (data && (data.choices || [])[0]) || null;
    var m = (ch && ch.message) || {};
    return String(m.reasoning_content || '').length;
  }

  /** 从响应里挖出「结束原因」，用于给用户解释空回复 */
  function finishReason(data) {
    var ch = (data && (data.choices || [])[0]) || null;
    return ch ? String(ch.finish_reason || '') : '';
  }

  /* ============================================================
   * 连通性自检
   *
   * 之前这里只有「发一个 16 token 的对话，看有没有回复」这一条路，
   * 判定标准是「必须拿到非空文字」。于是踩了两个坑：
   *   ① max_tokens 太小，推理型模型的额度被思考链吃光 → content 为空 →
   *      报「模型没有返回任何内容」，而同一个配置下 AI 车卡（1800 token）完全正常；
   *   ② 有些服务不返回 CORS 头，本地 fetch 探测会失败，但原生桥那条路是好的，
   *      于是「测试连接」永远失败、实际却能用。
   *
   * 现在分两步：先打 /models（只验地址与 Key，秒回、不烧生成额度），
   * 失败再退回对话探测；并且只要 HTTP 通了、返回是合法 JSON，就判定连接正常，
   * 文字只作为「附带的确认信息」。
   * ============================================================ */
  function modelsEndpoint(base) {
    var b = base.replace(/\s+/g, '').replace(/\/+$/, '');
    b = b.replace(/\/chat\/completions$/i, '');
    return b + '/models';
  }

  function test() {
    var c = cfg();
    if (!c.base) return Promise.reject(new Error('还没填写接口地址，请先到「AI 设置」里配置'));
    if (!c.model) return Promise.reject(new Error('还没填写模型名称，请先到「AI 设置」里配置'));
    if (!c.key) return Promise.reject(new Error('还没填写 API Key，请先到「AI 设置」里配置'));

    var auth = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.key };

    /* 第 1 步：GET /models —— 验证「地址 + Key」。用 GET，很多服务都支持。 */
    return request(modelsEndpoint(c.base), auth, '', 20000, 'GET').then(function (res) {
      if (res.ok && !/not found|not supported|404/i.test(String(res.body || '').slice(0, 200))) {
        var names = [];
        try { names = ((JSON.parse(res.body) || {}).data || []).map(function (m) { return m && m.id; }); }
        catch (e) { /* 不是 JSON 也算数，至少 HTTP 通了 */ }
        return {
          ok: true,
          via: 'models',
          reply: (names || []).length ? ('已连接 · 该地址可用模型 ' + names.length + ' 个') : '已连接',
          models: names || [],
          modelInList: !names || !names.length ? true : names.indexOf(c.model) >= 0
        };
      }

      /* 第 2 步：退回对话探测。 */
      var body = JSON.stringify({
        model: c.model,
        messages: [{ role: 'user', content: '回复「好」一个字即可' }],
        temperature: 0,
        max_tokens: 512,     // 不能太小：推理模型要留额度给思考链
        stream: false
      });
      return request(endpointOf(c.base), auth, body, 60000).then(function (r2) {
        if (r2.error) throw new Error(explainRequestError(r2.error));
        if (!r2.ok) throw new Error(explainError(r2));
        var data;
        try { data = JSON.parse(r2.body); }
        catch (e) { throw new Error('服务返回的内容不是 JSON，请确认接口地址填的是 OpenAI 兼容接口'); }

        var text = pickText(data).trim();
        if (text) {
          return { ok: true, via: 'chat', reply: text.slice(0, 20), models: [], modelInList: true };
        }
        // HTTP 成功 + 合法 JSON，但文字为空：多见于推理型模型额度不足。
        // 这说明地址 / Key / 模型都是通的，不该报「连接失败」。
        var fr = finishReason(data);
        var rlen = reasoningLen(data);
        return {
          ok: true,
          via: 'chat',
          empty: true,
          reply: '已连接（模型未输出文字' + (fr ? '，结束原因 ' + fr : '') + '）',
          models: [],
          modelInList: true,
          hint: '这不影响 AI 车卡 —— 车卡请求的额度更大。' +
                (rlen ? '这次模型把 ' + rlen + ' 个字用在了思考过程上，说明它可能是推理型模型。' : '') +
                '若想让测试连接也显示回复文字，可换一个非推理型模型名。'
        };
      });
    });
  }

  /* ============================================================
   * 三、AI 车卡
   * ============================================================ */

  /** 职业清单（去重、剔除自定义职业） —— 给模型一份「可选项」，避免它编出不存在的职业 */
  var OCC_NAMES = null;
  function occNames() {
    if (OCC_NAMES) return OCC_NAMES;
    var seen = {}, out = [];
    (global.COC_OCCUPATIONS || []).forEach(function (o) {
      if (!o || !o.name || o.id === 'occ1') return;
      if (o.creditMin === null || o.creditMin === undefined) return;
      if (seen[o.name]) return;
      seen[o.name] = 1;
      out.push(o.name);
    });
    OCC_NAMES = out;
    return out;
  }

  /* ============================================================
   * AI 车卡的数值上限（可选）
   *   在「菜单 → AI 设置」里配。0 = 不限。
   *   两道保障：① 写进提示词让模型照做；② 本地二次校准兜底 ——
   *   模型不照做也不会超标，因为 ① 只是「请求」，② 才是「保证」。
   * ============================================================ */
  var ATTR_KEYS = ['str', 'con', 'siz', 'dex', 'app', 'int', 'pow', 'edu'];
  var ATTR_MIN = 15, ATTR_MAX = 99;

  function caps() {
    var s = (Store && Store.getState && (Store.getState() || {}).settings) || {};
    var out = { attrCap: 0, withLuck: true, occCap: 0, intCap: 0 };
    var a = parseInt(s.aiAttrCap, 10);
    if (a > 0) {
      out.attrCap = a;
      out.withLuck = s.aiAttrCapWithLuck !== false;
    }
    var o = parseInt(s.aiOccPtsCap, 10);
    if (o > 0) out.occCap = o;
    var i = parseInt(s.aiIntPtsCap, 10);
    if (i > 0) out.intCap = i;
    return out;
  }

  /** 上限是否生效（界面提示要用） */
  function capsActive(c) {
    c = c || caps();
    return !!(c.attrCap || c.occCap || c.intCap);
  }

  /** 把上限翻译成一句人话，界面上显示「本次会按这些上限生成」 */
  function capsText(c) {
    c = c || caps();
    var parts = [];
    if (c.attrCap) {
      parts.push('属性总和 ≤ ' + c.attrCap + '（' + (c.withLuck ? '含幸运' : '不含幸运') + '）');
    }
    /* ⚠️ 措辞要说清是「**每一项**技能的上限」，不是「点数池变少」。
       玩家看到「职业点 ≤ 80」会以为职业点总数被压到 80，
       而实际是「侦查这类本职技能最多点到 80」。 */
    if (c.occCap) parts.push('每项本职技能 ≤ ' + c.occCap);
    if (c.intCap) parts.push('每项兴趣技能 ≤ ' + c.intCap);
    return parts.join(' · ');
  }

  /** 上限写进提示词的那几行（没设就返回空数组） */
  function capLines() {
    var c = caps(), out = [];
    if (c.attrCap) {
      out.push('· 属性总和上限：' + (c.withLuck ? '九项（含幸运）' : '八项（不含幸运）') +
        '相加不得超过 ' + c.attrCap + '。请主动把数值压在上限内，不要等到被提醒。');
    }
    if (c.occCap) out.push('· 每项本职技能的最终值不得超过 ' + c.occCap + ' 点。');
    if (c.intCap) out.push('· 每项非本职（兴趣）技能的最终值不得超过 ' + c.intCap + ' 点。');
    return out;
  }

  /**
   * 属性总和超限时的本地校准：等比压缩 + 最大余数法补齐。
   *
   * ⚠️ 为什么不能直接按超出量从最高项硬扣：
   * 那样会把「力量 90、教育 45」压成「力量 45」，人物性格直接被改掉。
   * 等比压缩保留相对高低（强的还是强），再把因取整丢掉的点数
   * 按小数部分从大到小补回去，保证总和**正好**等于上限。
   *
   * @returns {boolean} 是否动过
   */
  function applyAttrCap(profile, cap) {
    if (!cap || !cap.attrCap || !profile || !profile.attributes) return false;
    var keys = ATTR_KEYS.slice();
    if (cap.withLuck) keys.push('luck');

    var sum = 0, i;
    for (i = 0; i < keys.length; i++) sum += parseInt(profile.attributes[keys[i]], 10) || 0;
    if (!sum || sum <= cap.attrCap) return false;

    var f = cap.attrCap / sum;
    var vals = {}, fracs = [], total = 0;
    keys.forEach(function (k) {
      var v = parseInt(profile.attributes[k], 10) || 0;
      var t = v * f;
      var b = Math.min(ATTR_MAX, Math.max(ATTR_MIN, Math.floor(t)));
      vals[k] = b;
      total += b;
      fracs.push({ k: k, r: t - Math.floor(t) });
    });

    /* 补齐：按小数部分从大到小，每项**最多补 1 个**。
       ⚠️ 不能写成「每轮都给小数最大的那个 +1」—— 那会让同一项连拿好几个，
       结果力量 60 反而压过敏捷 70，人物性格直接被改掉。 */
    var rem = cap.attrCap - total;
    if (rem > 0) {
      fracs.sort(function (a, b) { return b.r - a.r; });
      for (i = 0; i < fracs.length && rem > 0; i++) {
        if (vals[fracs[i].k] < ATTR_MAX) { vals[fracs[i].k]++; rem--; }
      }
      // 都到顶了还没补齐（上限设得极不合理时）：从大到小继续加
      var g2 = 0;
      while (rem > 0 && g2++ < 4000) {
        var moved2 = false;
        for (i = 0; i < fracs.length && rem > 0; i++) {
          if (vals[fracs[i].k] < ATTR_MAX) { vals[fracs[i].k]++; rem--; moved2 = true; }
        }
        if (!moved2) break;
      }
    }
    // 超了（被 ATTR_MIN 抬高）：从最高的往下扣
    var guard = 0;
    while (total > cap.attrCap && guard++ < 4000) {
      var hi = null;
      keys.forEach(function (k) { if (hi === null || vals[k] > vals[hi]) hi = k; });
      if (hi === null || vals[hi] <= ATTR_MIN) break;
      vals[hi]--; total--;
    }

    /* 最后一道秩序修复：等比 + 取整难免出现「原来高的反而低了 1 点」
       这种相邻倒置。按原始高低排好序，把倒置的相邻两项**交换**回来 ——
       交换不改变总和，人物强弱关系却保住了。 */
    var byOrig = keys.slice().sort(function (a, b) {
      var va = parseInt(profile.attributes[a], 10) || 0;
      var vb = parseInt(profile.attributes[b], 10) || 0;
      return vb - va;
    });
    for (var pass = 0; pass < byOrig.length; pass++) {
      var swapped = false;
      for (i = 0; i < byOrig.length - 1; i++) {
        if (vals[byOrig[i]] < vals[byOrig[i + 1]]) {
          var tmp = vals[byOrig[i]];
          vals[byOrig[i]] = vals[byOrig[i + 1]];
          vals[byOrig[i + 1]] = tmp;
          swapped = true;
        }
      }
      if (!swapped) break;
    }

    keys.forEach(function (k) { profile.attributes[k] = vals[k]; });
    return true;
  }

  var SYSTEM_PROMPT = [
    '你是一位资深的《克苏鲁的呼唤》第七版（COC 7th）跑团守秘人，擅长把玩家一句',
    '随手写的点子扩写成一位有血有肉、能直接上桌的调查员。',
    '',
    '你的输出必须是**一个 JSON 对象**，从第一个字符 { 到最后一个字符 } 为止，',
    '不要输出任何解释、前后缀、Markdown 代码块围栏或注释。',
    '所有文本字段一律使用简体中文，人名与地名按所选时代与地区的习惯书写。'
  ].join('\n');

  function buildPrompt(desc) {
    var labels = (global.CocPersonas ? global.CocPersonas.labels : []).join('\n  ');
    var names = occNames().join('、');
    var lines = capLines();
    var out = [
      '请根据下面这段玩家的描述，创建一位调查员：',
      '"""',
      String(desc || '').trim(),
      '"""',
      '',
      '【第一步】从下列世界设定中选一个最贴合的，填入 setting 字段，必须原样照抄其中一个：',
      '  ' + labels,
      '',
      '【第二步】职业：优先从下面这份清单里选一个最贴合的，填入 occupationName（原样照抄）：',
      names,
      '  只有当清单里确实没有任何一个贴合时，才填「自定义职业」，',
      '  并在 occupationSkills 里给出 6-8 个本职技能名（从上面的职业描述里挑说法，',
      '  例如 ["侦查","潜行","图书馆使用","心理学","说服","手枪射击"]）。',
      '',
      '【第三步】按下面的结构输出 JSON：',
      '{',
      '  "setting": "上面清单里的某一个，原样照抄",',
      '  "name": "符合该设定文化的完整人名",',
      '  "gender": "男 或 女",',
      '  "age": 15 到 75 之间的整数,',
      '  "residence": "现居城市，必须是该设定下合理的地名",',
      '  "birthplace": "出生地，同样合理，且不能与现居城市相同",',
      '  "occupationName": "上面职业清单里的某一个，或「自定义职业」",',
      '  "occupationSkills": ["仅当 occupationName 为「自定义职业」时才填，6-8 个技能名"],',
      '  "attributes": { "str": 0, "con": 0, "siz": 0, "dex": 0, "app": 0, "int": 0, "pow": 0, "edu": 0, "luck": 0 },',
      '  "background": {',
      '    "description": "外貌，一句话，要有具体细节",',
      '    "ideology": "信念，以「信念：」开头，一句话",',
      '    "significantPeople": "严格按「关系｜经过｜现状」三段写",',
      '    "meaningfulPlaces": "严格按「地点｜氛围｜意义」三段写",',
      '    "treasuredPossessions": "严格按「物品｜特征｜来历｜意义」四段写",',
      '    "traits": "三到四个性格特点，用「、」分隔",',
      '    "wounds": "一处旧伤，没有就写「无。」",',
      '    "phobias": "根据这个人物的性格与经历，判断他是否可能有背景疯狂症状',
      '（恐惧症 / 狂躁症 / 疯狂发作）：有就写「【恐惧症】」或「【狂躁症】」或',
      '「【疯狂发作】」+ 具体症状名 + 「：」+ 一句具体描述；没有就写「无。」。',
      '由你依据人物设定判断，不要人人都写一条，也不要为了写而强行编造",',
      '    "history": "两到三句话的入行经历，要能看出他为什么走上这条路"',
      '  }',
      '}',
      '',
      '数值要求（重要，请严格遵守）：',
      '· str/con/siz/dex/app/int/pow 取值 20-90；edu 取值 40-95；luck 取值 15-90。',
      '· 数值要与职业和年龄相称：学者型 int/edu 高，运动员与体力职业 str/con/dex 高，',
      '  年长者 edu 可以高但 dex 偏低。不要所有人都是相同的数字。'
    ];
    if (lines.length) {
      out.push('');
      out.push('本次的硬性上限（超过会被自动压缩，请主动遵守）：');
      lines.forEach(function (l) { out.push(l); });
    }
    out.push('');
    out.push('内容要求：');
    out.push('· 姓名、地名、职业、装备、经历必须在同一个时代与地区里说得通 ——');
    out.push('  例如选「中国 · 古代」就不要出现手枪、电脑、现代职称。');
    out.push('· 背景要贴合玩家描述里透露的线索，不要写成放之四海皆可的空话。');
    out.push('');
    out.push('现在只输出这个 JSON。');
    return out.join('\n');
  }

  /** 从模型回复里把 JSON 抠出来（容忍代码块围栏、前后废话、中文标点） */
  function parseJson(text) {
    var s = String(text || '').trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(s); } catch (e) { /* 继续尝试 */ }

    var start = s.indexOf('{');
    if (start < 0) {
      throw new Error('模型没有返回 JSON 结构（回复开头是：' + s.slice(0, 40) + '…）');
    }
    var depth = 0, inStr = false, esc = false, end = -1;
    for (var i = start; i < s.length; i++) {
      var ch = s.charAt(i);
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) {
      /* 花括号没配平 —— 这是「被 max_tokens 截断」最典型的症状，
         模型正写到一半额度就没了。把尾部露出来方便判断。 */
      var tail = s.slice(-50);
      throw new Error('模型返回的 JSON 不完整（花括号没配平，末尾停在：…' + tail + '）');
    }
    var frag = s.slice(start, end + 1);
    try { return JSON.parse(frag); }
    catch (e2) {
      // 常见毛病：末尾多了逗号
      var fixed = frag.replace(/,\s*([}\]])/g, '$1');
      try { return JSON.parse(fixed); }
      catch (e3) {
        throw new Error('JSON 格式有误：' + (e3.message || e3));
      }
    }
  }

  /** 把模型给的零散信息洗成 preset.js 能吃的 profile */
  function toProfile(raw) {
    raw = raw || {};
    var ATTR_KEYS = ['str', 'con', 'siz', 'dex', 'app', 'int', 'pow', 'edu', 'luck'];
    var attrs = null;
    if (raw.attributes && typeof raw.attributes === 'object') {
      attrs = {};
      var any = false;
      ATTR_KEYS.forEach(function (k) {
        var v = parseInt(raw.attributes[k], 10);
        if (!isNaN(v)) { attrs[k] = v; any = true; }
      });
      if (!any) attrs = null;
    }

    var bgIn = raw.background || {};
    function s(v) {
      if (v === null || v === undefined) return '';
      return String(v).replace(/\s*\n+\s*/g, ' ').trim().slice(0, 240);
    }
    var bg = {
      description: s(bgIn.description),
      ideology: s(bgIn.ideology),
      significantPeople: s(bgIn.significantPeople),
      meaningfulPlaces: s(bgIn.meaningfulPlaces),
      treasuredPossessions: s(bgIn.treasuredPossessions),
      traits: s(bgIn.traits),
      wounds: s(bgIn.wounds),
      phobias: s(bgIn.phobias),
      history: s(bgIn.history)
    };
    /* v2.11.4（用户第 3 项）：背景疯狂症状**改由 AI 根据人物描述自行决定** ——
       提示词已要求它判断「有没有、是什么」，这里**采信 AI 的返回值**
       （含它写「无。」= 判定没有），不再由系统按疯狂表代替掷骰。
       ⚠️ 与 v2.1.9 旧口径的区别：那时一律丢弃 AI 文本、系统必掷一条；
          现在把决定权交还 AI，preset.js 侧也对 fromAI 的卡跳过 1/5 随机闸门，
          避免「AI 说了无、系统又掷一条」的双重决定。 */
    // 全空就当没给，交给池子补
    var hasBg = Object.keys(bg).some(function (k) { return !!bg[k]; });

    var gender = raw.gender === '男' || raw.gender === '女' ? raw.gender : '';
    var age = parseInt(raw.age, 10);

    /* 自定义职业时模型给的本职技能名（6-8 个），交给 preset 去解析；
       解析不出来的名字会在那边被跳过，所以这里不做严格校验。 */
    var occSkills = null;
    if (Array.isArray(raw.occupationSkills)) {
      var arr = raw.occupationSkills
        .map(function (x) { return String(x || '').trim(); })
        .filter(Boolean).slice(0, 8);
      if (arr.length) occSkills = arr;
    }

    return {
      fromAI: true,
      occupationSkills: occSkills,
      setting: s(raw.setting) || '',
      name: s(raw.name) || '',
      gender: gender,
      age: (age && age >= 15 && age <= 75) ? age : 0,
      residence: s(raw.residence) || '',
      birthplace: s(raw.birthplace) || '',
      occupationId: s(raw.occupationId) || '',
      occupationName: s(raw.occupationName) || '',
      attributes: attrs,
      background: hasBg ? bg : null
    };
  }

  /**
   * 一句话 → 一张完整可用的角色卡
   *
   * 对「模型返回的 JSON 不完整」做了**自适应重试**：
   *   第一次用 DEFAULT_MAX_TOKENS，若 finish_reason=length（被硬截断）
   *   或 parseJson 报「不完整」，就用 4 倍额度再发一次。
   *   推理型模型（LongCat / DeepSeek-Reasoner / o 系列）第一发很可能不够，
   *   自动重发就能拿到完整 JSON —— 不用用户自己反复点「重新生成」。
   *
   * @param {string} desc 玩家的自然语言描述
   * @param {function} onStage 阶段回调（给界面显示「额度不够，正在重试…」）
   * @returns {Promise<{character, profile, raw}>}
   */
  function makeCharacter(desc, onStage) {
    if (!String(desc || '').trim()) {
      return Promise.reject(new Error('先写一句你想创建什么样的调查员'));
    }
    var msgs = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildPrompt(desc) }
    ];

    function attempt(maxTokens) {
      var meta = {};
      return chat(msgs, {
        temperature: 0.9, maxTokens: maxTokens,
        onMeta: function (m) { meta = m; }
      }).then(function (text) {
        return { text: text, meta: meta };
      });
    }

    return attempt(DEFAULT_MAX_TOKENS).then(function (r1) {
      var needRetry = r1.meta.truncated;
      var raw = null, parseErr = null;
      try {
        raw = parseJson(r1.text);
      } catch (e) {
        parseErr = e;
      }

      /* 没被截断且解析成功 → 直接用 */
      if (raw && !needRetry) return { raw: raw, meta: r1.meta };

      /* 被截断 或 解析失败 → 用大额度重发一次 */
      if (typeof onStage === 'function') {
        onStage(needRetry
          ? '模型回复被截断（思考链占用了太多额度），正在用更大额度重试…'
          : '模型返回的 JSON 不完整，正在重试…');
      }
      return attempt(MAX_RETRY_TOKENS).then(function (r2) {
        var raw2 = null;
        try {
          raw2 = parseJson(r2.text);
        } catch (e2) {
          /* 两次都不行：把第一次的错误原因也说清楚，别只丢一句「失败」 */
          var why = parseErr && parseErr.message ? parseErr.message : 'JSON 解析失败';
          if (r2.meta.truncated) {
            throw new Error('模型两次都没能输出完整内容（连续被额度截断）。' +
              '这通常是推理型模型思考链过长所致，建议：换用非推理型模型，或把描述写短一点。');
          }
          throw new Error('模型返回的内容无法解析为角色卡（' + why + '）。可以点「重新生成」再试一次。');
        }
        return { raw: raw2, meta: r2.meta };
      });
    }).then(function (r) {
      var profile = toProfile(r.raw);
      var c0 = caps();

      /* 属性上限：本地二次校准。
         提示词里已经要求过一次，但模型不照做是常态 ——
         这里压缩到上限内，保证「设置了就一定不超」。 */
      var scaled = applyAttrCap(profile, c0);

      var c = global.PresetGen.buildFrom(profile, profile.setting, {
        /* 三个上限一起交给 build()：技能上限写进 skillCapOcc / skillCapInterest，
           属性上限在属性定下来之后再压一次 —— 上面那次压缩针对「模型给的属性」，
           这一次兜住「模型属性不合格、退回本机掷骰」的情况。两处共用
           applyAttrCap，所以压完的形态完全一致。 */
        caps: c0
      });
      if (!c) throw new Error('角色生成失败，请重试一次');
      if (scaled) c.aiAttrScaled = true;   // 界面提示「已按上限压缩」
      c.changeLog = c.changeLog || [];
      c.changeLog.push({ version: 'v1.0', note: 'AI 车卡：' + String(desc).trim().slice(0, 30), at: Date.now() });
      return { character: c, profile: profile, raw: r.raw, caps: c0, attrScaled: !!scaled };
    });
  }

  /** 描述示例，给不知道写什么的人一点手感 */
  var EXAMPLES = [
    '一个在旧书店打工的女大学生，喜欢研究古旧地图，胆子小但好奇心很重',
    '民国时期的私家侦探，前警察，因为一桩案子丢了差事，随身带着一副旧手铐',
    '1920 年代波士顿的报社记者，参加过一战，落下了耳背的毛病',
    '中国当代的法医，理性到近乎冷淡，但会替无名死者记下名字',
    '维多利亚时代的乡间医生，业余研究真菌，被同行视为怪人',
    '近未来的机械师，装了一条二手义肢，靠修旧机器过活'
  ];

  global.AIClient = {
    chat: chat,
    test: test,
    configured: configured,
    cfg: cfg,
    endpointOf: endpointOf,
    hasBridge: hasBridge,
    explainError: explainError
  };

  global.AIGen = {
    makeCharacter: makeCharacter,
    parseJson: parseJson,
    toProfile: toProfile,
    buildPrompt: buildPrompt,
    occNames: occNames,
    examples: EXAMPLES,
    /* 数值上限（AI 设置里配的可选项） */
    caps: caps,
    capsActive: capsActive,
    capsText: capsText,
    applyAttrCap: applyAttrCap
  };
})(window);
