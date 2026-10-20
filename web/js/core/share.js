/* ============================================================
 * share.js — 角色卡云分享
 *
 * 服务地址不在代码里硬编码，按下面的优先级解析（见 base()）：
 *   1) 用户在「设置」里自己填的地址（settings.shareBase）
 *   2) 打包时预置的地址（BuildConfig.shareBase，仅自用版有）
 *   3) 都没有 → 视为「未配置」，界面引导用户去填写或改用本机导出
 *
 * 后端接口约定（自建服务实现这几个路由即可）：
 *   POST /api/cards           创建分享  body {name, visibility, data}
 *                             → {id, url, delToken}
 *   POST /api/cards/<id>/del  删除      body {token}
 *
 * 之前 finish 步骤里那个「分享链接」是 #/card/coc7/<id> 本地路由，
 * 只在本机 localStorage 里有效，发给别人打不开。这里换成真正的服务端分享。
 * ============================================================ */
(function (global) {
  'use strict';

  var KEY = 'coc7_card_shares_v1';   // { [characterId]: {id,url,delToken,at,name} }

  /* ---------- 服务地址解析 ---------- */

  function normalizeBase(u) {
    return String(u == null ? '' : u).trim().replace(/\/+$/, '');
  }

  /** 用户在设置里填的地址 */
  function userBase() {
    try {
      var st = global.Store && global.Store.getState && global.Store.getState().settings;
      return normalizeBase(st && st.shareBase);
    } catch (e) { return ''; }
  }

  /** 打包时预置的地址（开源版为空） */
  function presetBase() {
    return normalizeBase(global.BuildConfig && global.BuildConfig.shareBase);
  }

  /** 当前生效的服务地址；空串表示尚未配置 */
  function base() {
    return userBase() || presetBase();
  }

  function configured() { return !!base(); }

  /** 地址是否看起来可用（设置页做即时校验用） */
  function looksValid(u) {
    var v = normalizeBase(u);
    return /^https?:\/\/[^\s/]+/i.test(v);
  }

  function readAll() {
    try { return JSON.parse(global.localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
  }
  function writeAll(o) {
    try { global.localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) { /* 配额满就算了 */ }
  }

  function getFor(charId) { return charId ? (readAll()[charId] || null) : null; }

  /** 头像体积大（data URL 可能几百 KB），且服务端不展示，剔除后再上传 */
  function slimSkill(s) {
    return {
      name: s.name, total: s.total, base: s.base,
      occ: s.occ, int: s.int, growth: s.growth
    };
  }

  function buildPayload(c) {
    return {
      name: c.characterName || '未命名调查员',
      visibility: c.shareVisibility || 'link',
      data: {
        characterName: c.characterName,
        playerName: c.playerName,
        basicInfo: c.basicInfo,
        attributes: c.attributes,
        derivedStats: c.derivedStats,
        status: c.status,
        assets: c.assets,
        background: c.background,
        skills: (c.skills || []).map(slimSkill),
        weapons: (c.weapons || []).map(function (w) {
          return { name: w.name, skill: w.skill, damage: w.damage, range: w.range, ammo: w.ammo };
        }),
        items: (c.items || []).map(function (i) {
          return { name: i.name, quantity: i.quantity, description: i.description };
        }),
        mythos: c.mythos,
        history: c.history,
        unitName: (c.basicInfo || {}).occupationName || '',
        sharedAt: Date.now()
      }
    };
  }

  function create(c) {
    var b = base();
    if (!b) return Promise.reject(new Error('UNCONFIGURED'));
    return global.fetch(b + '/api/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload(c))
    }).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (t) {
          throw new Error('服务器返回 ' + r.status + '：' + String(t).slice(0, 140));
        });
      }
      return r.json();
    }).then(function (j) {
      var all = readAll();
      all[c.id] = { id: j.id, url: j.url, delToken: j.delToken, at: Date.now(), name: c.characterName };
      writeAll(all);
      c.shareId = j.id;
      return j;
    });
  }

  function remove(charId, token) {
    var rec = getFor(charId);
    if (!rec) return Promise.reject(new Error('本机没有该角色的分享记录'));
    var b = base();
    if (!b) return Promise.reject(new Error('UNCONFIGURED'));
    return global.fetch(b + '/api/cards/' + rec.id + '/del', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token || rec.delToken })
    }).then(function (r) {
      if (!r.ok) throw new Error('删除失败（' + r.status + '）');
      var all = readAll();
      delete all[charId];
      writeAll(all);
      return true;
    });
  }

  /* ---------- 剪贴板 / 打开链接（优先走原生桥） ---------- */
  function copy(text) {
    var b = global.AndroidBridge;
    if (b && b.copyToClipboard) {
      try {
        var r = b.copyToClipboard(String(text));
        if (r === true || r === 'ok') { UI.toast('链接已复制', 'ok'); return; }
      } catch (e) { /* 落到下面走网页方案 */ }
    }
    if (global.navigator && global.navigator.clipboard) {
      global.navigator.clipboard.writeText(String(text)).then(
        function () { UI.toast('链接已复制', 'ok'); },
        function () { legacyCopy(text); });
    } else {
      legacyCopy(text);
    }
  }

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = String(text);
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      UI.toast('链接已复制', 'ok');
    } catch (e) {
      UI.toast('复制失败，请长按链接手动复制', 'err');
    }
    document.body.removeChild(ta);
  }

  function open(url) {
    var b = global.AndroidBridge;
    if (b && b.openUrl) {
      try { b.openUrl(String(url)); return; } catch (e) { /* 降级 */ }
    }
    global.open(String(url), '_blank');
  }

  global.CocShare = {
    /* BASE 保留为 getter：始终返回当前生效地址，未配置时是空串 */
    get BASE() { return base(); },
    base: base,
    userBase: userBase,
    presetBase: presetBase,
    configured: configured,
    looksValid: looksValid,
    getFor: getFor,
    create: create,
    remove: remove,
    copy: copy,
    open: open,
    list: readAll
  };
})(window);
