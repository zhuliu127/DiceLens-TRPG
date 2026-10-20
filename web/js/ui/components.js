/* ============================================================
 * components.js — 通用 UI 组件（无业务规则）
 * ============================================================ */
(function (global) {
  'use strict';

  /** 创建元素: h('div.card', {onclick}, [children]) */
  function h(sel, props, children) {
    var tag = 'div', cls = [], id = null;
    sel = sel || 'div';
    sel.split(/(?=[.#])/).forEach(function (p) {
      if (p[0] === '.') cls.push(p.slice(1));
      else if (p[0] === '#') id = p.slice(1);
      else tag = p;
    });
    var el = document.createElement(tag);
    if (cls.length) el.className = cls.join(' ');
    if (id) el.id = id;
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'html') el.innerHTML = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'class') el.className += ' ' + v;
        else if (k in el && k !== 'list') { try { el[k] = v; } catch (e) { el.setAttribute(k, v); } }
        else el.setAttribute(k, v);
      });
    }
    append(el, children);
    return el;
  }

  function append(parent, children) {
    if (children === null || children === undefined || children === false) return;
    if (Array.isArray(children)) { children.forEach(function (c) { append(parent, c); }); return; }
    if (children instanceof Node) { parent.appendChild(children); return; }
    parent.appendChild(document.createTextNode(String(children)));
  }

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------- Toast ---------- */
  var toastHost = null;
  function toast(msg, kind, ms) {
    if (!toastHost) { toastHost = h('div.toast-host'); document.body.appendChild(toastHost); }
    var t = h('div.toast' + (kind ? '.' + kind : ''), { text: msg });
    toastHost.appendChild(t);
    setTimeout(function () {
      t.style.transition = 'opacity .25s, transform .25s';
      t.style.opacity = '0'; t.style.transform = 'translateY(8px)';
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 260);
    }, ms || 1900);
  }

  /* ---------- 弹层滚动锁 ----------
     弹层打开时必须锁住页面背景：否则手指在弹层上滑动，滚到边界后
     滚动会「穿透」传给底下的角色卡 / 列表，出现「浮窗和背景一起动」。
     用计数锁：多层弹层叠加时，只有最后一个关闭才恢复背景滚动。 */
  var scrollLockCount = 0;
  var savedScrollY = 0;

  function lockScroll() {
    scrollLockCount++;
    if (scrollLockCount > 1) return;
    savedScrollY = window.pageYOffset || document.documentElement.scrollTop || 0;
    document.documentElement.classList.add('scroll-locked');
    document.body.classList.add('scroll-locked');
  }

  function unlockScroll() {
    if (scrollLockCount === 0) return;
    scrollLockCount--;
    if (scrollLockCount > 0) return;
    document.documentElement.classList.remove('scroll-locked');
    document.body.classList.remove('scroll-locked');
    // 锁定时把 overflow 关掉会让页面回到顶部，这里还原原来的位置
    if (savedScrollY) window.scrollTo(0, savedScrollY);
  }

  /* 打开中的弹层（后进先出）。系统返回键与「关闭最上层」都靠它。 */
  var openSheets = [];

  /** 是否有弹层处于打开状态 */
  function hasSheet() { return openSheets.length > 0; }

  /** 关掉最上面那一层；返回是否真的关掉了东西 */
  function closeTopSheet() {
    var top = openSheets[openSheets.length - 1];
    if (!top) return false;
    top.close();
    return true;
  }

  function closeAllSheets() {
    while (openSheets.length) openSheets[openSheets.length - 1].close();
  }

  /**
   * 刷新「最上层」那个**可刷新**的 sheet（即 body 传的是 render() 函数）。
   *
   * 用途：常驻面板（KP 工具 / 素材与地图 / 手绘板）在打开期间，底层状态会因
   * 网络消息而改变。以前这些 sheet 只在「打开那一刻」渲染一次，之后即使
   * `paint()` 重画了底层页面，sheet 里显示的仍是旧数据 —— 表现为
   * 「KP 上传素材后，素材与地图弹层里看不到新素材」「点了发布，格子样式不变」。
   *
   * 从栈顶往下找第一个 refreshable 的 sheet 并刷新它；找不到返回 false。
   * 只刷新最上面那一个，避免把下层被遮住的弹层也一起重画（它们可能持有
   * 用户正在填写的临时输入）。
   *
   * @returns {boolean} 是否刷新了某个 sheet
   */
  function refreshTopSheet() {
    for (var i = openSheets.length - 1; i >= 0; i--) {
      var s = openSheets[i];
      if (s && s.refreshable && typeof s.refresh === 'function') {
        s.refresh();
        return true;
      }
    }
    return false;
  }

  /**
   * 关掉「最外层」弹层，回到上一层。
   *
   * 用途：某些流程会在弹层之上再开一个弹层（例如「AI 设置」里点「测试连接」
   * 失败会弹「连接失败」）。这时 closeAllSheets() 会把用户自己开的那层也一起关掉，
   * 只能用本方法退掉最上面一层。
   *
   * ⚠️ 以前各业务模块图省事，直接
   *     document.querySelectorAll('.sheet-mask').forEach(m => m.remove())
   * 来关闭弹层 —— 这只摘掉了 DOM 节点，没有走 close()，
   * 于是 openSheets 栈里留下一条僵尸记录、scrollLockCount 永远归不了零，
   * 结果就是「html/body 永久带着 .scroll-locked」→ 整个页面划不动、点不动，
   * 切上一步、返回首页全都失效。法术选择后页面卡死就是这条路径造成的。
   * 所以一律走 closeAllSheets / closeTopSheet，不要再自己 remove 节点。
   */
  function closeOutermostSheets(n) {
    n = Math.max(1, parseInt(n, 10) || 1);
    var closed = 0;
    while (closed < n && openSheets.length) {
      openSheets[openSheets.length - 1].close();
      closed++;
    }
    return closed;
  }

  /* 兜底：如果因为任何异常留下 .scroll-locked（例如弹层被外部脚本误删），
     页面会永久无法滚动。给一个自愈入口，路由切换时调用。 */
  function forceUnlockScroll() {
    if (scrollLockCount <= 0 && !document.body.classList.contains('scroll-locked')) return false;
    scrollLockCount = 0;
    openSheets.length = 0;
    document.documentElement.classList.remove('scroll-locked');
    document.body.classList.remove('scroll-locked');
    return true;
  }

  /* ---------- 底部弹层 ---------- */
  /**
   * 打开一个底部弹层。
   *
   * `opts.body` 支持三种形式，且**必须向后兼容**（现有调用点大多是「一次性 body」）：
   *   1. string            —— 直接写入 innerHTML，一次性（不参与 refresh）。
   *   2. Node / Node[]     —— 直接 append，一次性（不参与 refresh）。
   *   3. function render() —— **可刷新**：调用一次渲染，之后可用 `api.refresh()`
   *                          重新渲染（清空 body 后再次调用 render()）。
   *
   * v2.13.8（用户报「SAN Check 连点卡死」）：`opts.key` 同名弹层**单例** ——
   *   连点入口按钮（骰子行的 SAN Check / 技能检定 / 自定义骰子…）此前会叠出一模
   *   一样的模态：关掉最上面一层，下面还露着一层，界面像卡住不动；每层各提交一次
   *   还会发出重复 intent。传了 key 就先关掉已打开的同名弹层再开新的。
   *
   * 返回的 api 上带 `refresh()`：当底层状态变化（例如 paint 重画）时，
   * 由 panelCtx 调用来让「常驻 sheet」跟着一起更新，避免出现
   * 「数据已经变了，但 sheet 还停在打开那一刻」的假死现象。
   *
   * @param {Object} opts - {title, headExtra, body, onClose, key}
   * @returns {{el: Element, body: Element, mask: Element, close: Function, refresh: Function}}
   */
  function sheet(opts) {
    /* 同名弹层去重：从栈顶往下关掉所有同 key 的旧弹层（保留更早的其它弹层）。 */
    if (opts.key) {
      for (var di = openSheets.length - 1; di >= 0; di--) {
        if (openSheets[di] && openSheets[di].key === opts.key) openSheets[di].close();
      }
    }
    var mask = h('div.sheet-mask');
    var panel = h('div.sheet');
    var head = h('div.sheet-head', null, [
      h('h3', { text: opts.title || '' }),
      opts.headExtra || null,
      h('button.icon-btn', { text: '✕', onclick: close })
    ]);
    var body = h('div');
    var renderFn = (typeof opts.body === 'function') ? opts.body : null;
    if (renderFn) {
      // 可刷新：交给 render 产出节点
      append(body, renderFn());
    } else if (typeof opts.body === 'string') {
      body.innerHTML = opts.body;
    } else if (opts.body) {
      append(body, opts.body);
    }
    panel.appendChild(head); panel.appendChild(body);
    mask.appendChild(panel);
    // 点弹层内部不会误关；点遮罩**默认也不再关闭**（v2.11.9 用户第 5 项：
    // KP 用电脑极易误点遮罩把弹窗关掉）。仅当显式传 maskClose:true 才允许点外部关闭。
    mask.addEventListener('click', function (e) { if (e.target === mask && opts.maskClose === true) close(); });
    document.body.appendChild(mask);
    lockScroll();

    var api = { el: panel, body: body, close: close, mask: mask, refresh: refresh, refreshable: !!renderFn, key: opts.key || '' };
    openSheets.push(api);

    /** 重新渲染可刷新 sheet；对「一次性 body」是 no-op。 */
    function refresh() {
      if (!renderFn) return false;
      clear(body);
      append(body, renderFn());
      return true;
    }

    function close() {
      var i = openSheets.indexOf(api);
      if (i >= 0) openSheets.splice(i, 1);
      if (mask.parentNode) mask.parentNode.removeChild(mask);
      unlockScroll();
      if (opts.onClose) opts.onClose();
    }
    return api;
  }

  function confirm(message, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      // 只认第一次结果。
      // 之前按钮回调是「先 s.close() 再 resolve(true)」，
      // 而 close() 会触发 onClose → resolve(false)，
      // 于是点「确定 / 继续下一步」永远返回 false —— 表现为按钮点了没反应。
      var settled = false;
      function done(v) { if (settled) return; settled = true; resolve(v); }
      var s = sheet({
        title: opts.title || '确认',
        body: h('div', null, [
          h('p', { text: message, style: { marginBottom: '16px', lineHeight: '1.65' } }),
          h('div.btn-group', null, [
            opts.hideCancel ? null :
              h('button.btn.ghost.grow', { text: opts.cancelText || '取消', onclick: function () { done(false); s.close(); } }),
            h('button.btn.' + (opts.danger ? 'danger' : 'primary') + '.grow', {
              text: opts.okText || '确定',
              onclick: function () { done(true); s.close(); }
            })
          ].filter(Boolean))
        ]),
        onClose: function () { done(false); }
      });
    });
  }

  /* ---------- 通用小部件 ---------- */
  function field(label, control, opts) {
    opts = opts || {};
    return h('div.field', null, [
      h('label', null, [label, opts.required ? h('span.req', { text: '*' }) : null]),
      control,
      opts.help ? h('div.help', { text: opts.help }) : null
    ]);
  }

  function input(props) { return h('input.input', Object.assign({ type: 'text' }, props)); }
  function textarea(props) { return h('textarea.textarea', props); }

  function select(options, value, onchange, props) {
    var sel = h('select.select', Object.assign({ onchange: function () { onchange && onchange(sel.value); } }, props || {}));
    options.forEach(function (o) {
      var item = h('option', { value: o.value, text: o.label });
      if (String(o.value) === String(value)) item.selected = true;
      sel.appendChild(item);
    });
    return h('div.select-wrap', null, [sel]);
  }

  /** 数字步进器 */
  function stepper(value, opts) {
    opts = opts || {};
    var valEl = h('div.val', { text: value });
    var wrap = h('div.calc-group' + (opts.locked ? '.locked' : ''), null, [
      opts.label ? h('span.lg', { text: opts.label }) : null,
      h('button.sbtn.minus' + (opts.locked ? '.dis' : ''), {
        text: '−', onclick: function () { if (!opts.locked) opts.onChange(-(opts.step || 1)); }
      }),
      valEl,
      h('button.sbtn.plus' + (opts.locked ? '.dis' : ''), {
        text: '+', onclick: function () { if (!opts.locked) opts.onChange(opts.step || 1); }
      })
    ]);
    wrap.setValue = function (v) { valEl.textContent = v; };
    return wrap;
  }

  function notice(text, kind, ico) {
    return h('div.notice' + (kind ? '.' + kind : ''), null, [
      h('span.ico', { text: ico || (kind === 'err' ? '⚠' : kind === 'warn' ? '!' : kind === 'ok' ? '✓' : 'ℹ') }),
      h('div.grow', { text: text })
    ]);
  }

  function emptyState(ico, text, sub) {
    return h('div.empty', null, [
      h('div.big', { text: ico || '◌' }),
      h('div', { text: text }),
      sub ? h('div.tiny', { text: sub, style: { marginTop: '5px' } }) : null
    ]);
  }

  /* ---------- 头像读取 ---------- */
  function readImage(file, maxSize, cb) {
    if (!file) return cb(null);
    if (!/^image\/(jpeg|png|webp|jpg)$/i.test(file.type)) {
      return cb({ error: '仅支持 JPG / PNG / WEBP 格式' });
    }
    var fr = new FileReader();
    fr.onload = function () {
      var img = new Image();
      img.onload = function () {
        var w = img.width, hgt = img.height;
        var scale = Math.min(1, maxSize / Math.max(w, hgt));
        var cw = Math.round(w * scale), ch = Math.round(hgt * scale);
        var cv = document.createElement('canvas');
        cv.width = cw; cv.height = ch;
        cv.getContext('2d').drawImage(img, 0, 0, cw, ch);
        try { cb({ dataUrl: cv.toDataURL('image/jpeg', 0.86) }); }
        catch (e) { cb({ dataUrl: fr.result }); }
      };
      img.onerror = function () { cb({ error: '图片解析失败' }); };
      img.src = fr.result;
    };
    fr.onerror = function () { cb({ error: '文件读取失败' }); };
    fr.readAsDataURL(file);
  }

  /* ---------- 雷达图 (SVG) ---------- */
  function radarChart(dims, size) {
    size = size || 230;
    var cx = size / 2, cy = size / 2, R = size / 2 - 34;
    var n = dims.length;
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
    svg.setAttribute('width', '100%');
    svg.setAttribute('style', 'max-width:' + size + 'px');
    function pt(i, r) {
      var ang = -Math.PI / 2 + (2 * Math.PI * i) / n;
      return [cx + r * Math.cos(ang), cy + r * Math.sin(ang)];
    }
    function mk(tag, attrs) {
      var e = document.createElementNS(NS, tag);
      Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
      return e;
    }
    // 网格
    [0.25, 0.5, 0.75, 1].forEach(function (f) {
      var d = '';
      for (var i = 0; i < n; i++) {
        var p = pt(i, R * f);
        d += (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1);
      }
      svg.appendChild(mk('path', {
        d: d + 'Z', fill: 'none',
        stroke: 'currentColor', 'stroke-opacity': f === 1 ? 0.32 : 0.14, 'stroke-width': 1
      }));
    });
    // 轴线
    for (var i = 0; i < n; i++) {
      var p = pt(i, R);
      svg.appendChild(mk('line', {
        x1: cx, y1: cy, x2: p[0], y2: p[1],
        stroke: 'currentColor', 'stroke-opacity': 0.16, 'stroke-width': 1
      }));
    }
    // 数据面
    /* v2.2.0（用户第 4 项）：改用**占比口径**绘制 —— 有 d.norm 时按 norm（0–100，
       最大占比=100）定半径；没有 norm（旧数据）时退回 d.value，行为不变。 */
    function radiusOf(d) {
      var rv = (d && d.norm !== undefined && d.norm !== null && isFinite(d.norm)) ? d.norm : (d ? d.value : 0);
      return R * Math.max(0.03, Math.min(100, rv) / 100);
    }
    var dpath = '';
    dims.forEach(function (d, i) {
      var p = pt(i, radiusOf(d));
      dpath += (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1);
    });
    svg.appendChild(mk('path', {
      d: dpath + 'Z', fill: 'rgba(212,169,74,.26)', stroke: '#d4a94a', 'stroke-width': 2,
      'stroke-linejoin': 'round'
    }));
    // 数据点
    dims.forEach(function (d, i) {
      var r = radiusOf(d);
      var p = pt(i, r);
      svg.appendChild(mk('circle', { cx: p[0], cy: p[1], r: 3.4, fill: d.color || '#d4a94a', stroke: '#0b1119', 'stroke-width': 1 }));
      // 标签
      var lp = pt(i, R + 22);
      var txt = mk('text', {
        x: lp[0], y: lp[1], 'text-anchor': 'middle', 'dominant-baseline': 'middle',
        'font-size': 10.5, fill: d.color || 'currentColor', 'font-weight': 600
      });
      txt.textContent = d.label.replace('能力', '');
      svg.appendChild(txt);
      var vt = mk('text', {
        x: lp[0], y: lp[1] + 12, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
        'font-size': 9.5, fill: 'currentColor', 'fill-opacity': .65, 'font-family': 'monospace'
      });
      /* 轴下数值显示**绝对量**（d.sub 优先；否则 d.sum；再否则旧 d.value）——
         形状按占比、数字仍是可核对的绝对值。 */
      vt.textContent = (d.sub !== undefined && d.sub !== null) ? d.sub
        : ((d.sum !== undefined && d.sum !== null) ? d.sum : d.value);
      svg.appendChild(vt);
    });
    var wrap = h('div.radar-wrap', { style: { color: 'var(--text-mute)' } }, [svg]);
    return wrap;
  }

  /* ---------- 文件导出（兼容安卓外壳） ---------- */
  function isAndroid() {
    try { return !!(global.AndroidBridge && global.AndroidBridge.isAndroid && global.AndroidBridge.isAndroid()); }
    catch (e) { return false; }
  }

  /**
   * 保存文件。安卓端走原生桥（写入相册 / 下载目录），浏览器端走 <a download>。
   * @param {string} filename
   * @param {string} content  dataURL（图片）或纯文本
   * @param {string} kind     'image' | 'text'
   */
  function saveFile(filename, content, kind) {
    if (isAndroid()) {
      try {
        var r = kind === 'image'
          ? global.AndroidBridge.saveImage(content, filename)
          : global.AndroidBridge.saveText(content, filename);
        if (r && r.indexOf('saved:') === 0) {
          toast('已保存到 ' + r.slice(6), 'ok', 3400);
          return true;
        }
        toast('保存失败：' + (r || '未知错误'), 'err', 3400);
        return false;
      } catch (e) {
        toast('保存失败：' + e.message, 'err');
        return false;
      }
    }
    // 浏览器
    try {
      var url, revoke = false;
      if (kind === 'image' && content.indexOf('data:') === 0) url = content;
      else { url = URL.createObjectURL(new Blob([content], { type: 'application/json' })); revoke = true; }
      var a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      if (revoke) setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      return true;
    } catch (e) {
      toast('导出失败：' + e.message, 'err');
      return false;
    }
  }

  /* ---------- 骰子按钮 ---------- */
  function diceButton(label, onRoll) {
    return h('button.btn.sm.ghost', {
      html: '🎲 ' + esc(label),
      onclick: function () {
        var v = global.COCDice.d100();
        onRoll && onRoll(v);
        toast('骰出 ' + v, v === 1 ? 'ok' : (v >= 96 ? 'err' : null), 1600);
      }
    });
  }

  /* ---------- 状态条 / 头像（v2.0.0 游戏页分区骨架用） ----------
     参考图里玩家列表 / 角色卡上到处是细长的 HP / MP / SAN 条与圆形头像。
     做成通用小部件，避免每个面板各写一份。 */
  /**
   * 细状态条。
   * @param {number} value 当前值
   * @param {number} max   上限（<=0 视为空）
   * @param {string} kind  'hp' | 'mp' | 'san' | ''
   */
  function statBar(value, max, kind) {
    var v = Number(value) || 0, m = Number(max) || 0;
    var ratio = m > 0 ? Math.max(0, Math.min(1, v / m)) : 0;
    return h('div.stat-bar' + (kind ? '.' + kind : ''), null, [
      h('i', { style: { width: Math.round(ratio * 100) + '%' } })
    ]);
  }

  /**
   * 圆形小头像：有图用图，没图用名字首字占位。
   * @param {string} src  图片 dataURL / URL
   * @param {string} name 名字（占位用）
   */
  function avatar(src, name) {
    if (src) return h('img.avatar-sm', { src: src, alt: name || '' });
    return h('div.avatar-sm', { text: String(name || '?').slice(0, 1) });
  }

  global.UI = {
    h: h, append: append, clear: clear, esc: esc,
    toast: toast, sheet: sheet, confirm: confirm,
    hasSheet: hasSheet, closeTopSheet: closeTopSheet, closeAllSheets: closeAllSheets,
    refreshTopSheet: refreshTopSheet,
    closeOutermostSheets: closeOutermostSheets, forceUnlockScroll: forceUnlockScroll,
    field: field, input: input, textarea: textarea, select: select,
    stepper: stepper, notice: notice, emptyState: emptyState,
    readImage: readImage, radarChart: radarChart, diceButton: diceButton,
    statBar: statBar, avatar: avatar,
    saveFile: saveFile, isAndroid: isAndroid
  };
})(window);
