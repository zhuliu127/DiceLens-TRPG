/* ============================================================
 * app.js — 应用外壳 / 路由 / 主页 / 我的角色
 * ============================================================ */
(function (global) {
  'use strict';
  var h = UI.h;
  var R = global.COC7;
  var OCC = global.CocOccupation;

  /* 步骤顺序：资产（信用评级）前移到技能加点之前，
     因为信用评级本身要用职业点数购买，必须先定下来才知道剩多少职业点可分。
     第 0 步「快速开始」可让玩家直接用一张随机预设卡开团，也可以跳过走完整流程。 */
  var STEP_IDS = ['start', 'basic', 'attr', 'occupation', 'assets', 'skill', 'combat', 'gear', 'background', 'finish'];
  var STEP_META = [
    { id: 'start',      short: '快速开始' },
    { id: 'basic',      short: '基本资料' },
    { id: 'attr',       short: '属性' },
    { id: 'occupation', short: '职业' },
    { id: 'assets',     short: '资产' },
    { id: 'skill',      short: '技能' },
    { id: 'combat',     short: '战斗' },
    { id: 'gear',       short: '装备' },
    { id: 'background', short: '背景' },
    { id: 'finish',     short: '完成' }
  ];

  var appEl = document.getElementById('app');
  var viewEl, barEl, stepperEl, savePillEl, appBarEl;
  var route = { name: 'home' };

  /** 规则系统显示名（首页/角色卡的分类标签用） */
  var RULE_LABEL = { coc7: 'COC 7th', dnd5e: 'DND 5E', custom: '自定义规则' };
  function ruleLabel(id) { return RULE_LABEL[id] || RULE_LABEL.coc7; }

  /* ============================================================
   * 外壳
   * ============================================================ */
  function buildShell() {
    UI.clear(appEl);

    var appbar = h('div.appbar', null, [
      h('div.brand', { onclick: function () { guardLeave(goHome); } }, [
        h('img.brand-logo', { src: 'img/logo.png', alt: '' }),
        h('span', { text: (window.BuildConfig && window.BuildConfig.displayName) || '骰境 TRPG' })
      ]),
      h('div.spacer'),
      savePillEl = h('span.save-pill', { text: '就绪' }),
      h('button.icon-btn', { text: '☰', title: '菜单', onclick: openMenu })
    ]);

    appBarEl = appbar;   // v2.0.10：进房间时隐藏它（.appbar 是 sticky+z-index:60，会盖住游戏页顶栏）

    stepperEl = h('div.stepper', { style: { display: 'none' } });

    viewEl = h('div.content');
    barEl = h('div.bottombar', { style: { display: 'none' } });

    appEl.appendChild(appbar);
    appEl.appendChild(stepperEl);
    appEl.appendChild(viewEl);
    appEl.appendChild(barEl);

    Store.subscribe(function (type) {
      if (!savePillEl) return;
      var editing = Store.isEditing && Store.isEditing();
      if (type === 'saving') {
        savePillEl.className = 'save-pill saving';
        savePillEl.textContent = editing ? '暂存中…' : '正在保存…';
      } else if (type === 'buffered') {
        // 编辑模式下自动保存的只是「中转区」，绝不能显示成「已保存」
        savePillEl.className = 'save-pill pending';
        savePillEl.textContent = '● 修改未保存';
      } else if (type === 'saved' || type === 'edit-committed') {
        savePillEl.className = 'save-pill saved';
        savePillEl.textContent = '✓ 已保存';
      } else if (type === 'edit-begin' || type === 'edit-cancelled' || type === 'edit-suspended') {
        savePillEl.className = 'save-pill';
        savePillEl.textContent = '就绪';
      } else if (type === 'idle') {
        if (editing) { savePillEl.className = 'save-pill pending'; savePillEl.textContent = '● 修改未保存'; }
        else { savePillEl.className = 'save-pill'; savePillEl.textContent = '就绪'; }
      }
    });
  }

  function openMenu() {
    var items = [
      ['🏠 首页', function () { guardLeave(goHome); }],
      ['🎭 跑团房间', function () { guardLeave(function () { go('#/room'); }); }],
      ['📇 我的角色', function () { guardLeave(function () { go('#/my'); }); }],
      ['➕ 创建新角色', function () { guardLeave(function () { createNewCharacter(); }); }],
      ['✨ AI 车卡', function () { aiCreateSheet(); }],
      ['🤖 AI 设置', function () { aiSettingsSheet(); }],
      ['⚙ 设置', function () { settingsSheet(); }],
      ['ℹ 关于', function () { aboutSheet(); }]
    ];
    var sh = UI.sheet({
      title: '菜单',
      body: h('div', null, items.map(function (it) {
        return h('button.occ-item', {
          html: '<div class="grow"><div class="nm">' + it[0] + '</div></div>',
          onclick: function () { sh.close(); it[1](); }
        });
      }))
    });
  }

  /* ============================================================
   * AI 设置
   *
   * opts.focusCaps —— 打开后滚动到「数值上限」那张卡片并高亮一下。
   *   第 0 步的「设置属性 / 技能上限」按钮走的就是这条路：玩家要的是房规
   *   那一块，不该让他自己在长表单里找。滚动用 getBoundingClientRect 的
   *   差值算，不依赖 offsetParent（弹层是 position:fixed，卡片求到的是
   *   遮罩而不是滚动容器，用 offsetTop 会算错）。
   * opts.onClose —— 「数值上限」改完关掉弹层后要回调第 0 步刷新提示行。
   * ============================================================ */
  function aiSettingsSheet(opts) {
    opts = opts || {};
    var s = Store.getState().settings || {};
    var stateLine = h('div.tiny.dim', { style: { marginTop: '9px', lineHeight: '1.75' } });

    function paintState() {
      UI.clear(stateLine);
      var c = global.AIClient.cfg();
      if (!c.base || !c.model || !c.key) {
        stateLine.appendChild(h('div', { text: '尚未配置完整 —— 第 0 步的「AI 车卡」暂不可用（「生成随机角色」不受影响，完全离线）。' }));
      } else {
        stateLine.appendChild(h('div', { text: '当前：' + c.base + '　模型 ' + c.model + '　Key ' + maskKey(c.key) }));
      }
    }

    var baseInput = UI.input({
      type: 'url', value: s.aiBase || '',
      placeholder: 'https://api.deepseek.com/v1'
    });
    var modelInput = UI.input({ value: s.aiModel || '', placeholder: 'deepseek-flash' });
    var keyInput = UI.input({ type: 'password', value: s.aiKey || '', placeholder: 'sk-...' });
    [baseInput, modelInput, keyInput].forEach(function (el) {
      el.addEventListener('input', function () { el.classList.remove('invalid'); });
    });

    /* ---------- 数值上限（可选）---------- */
    /* id 是给自动化测试用的定位锚点 —— 靠输入框顺序去选，
       只要界面排布一变测试就误判，之前踩过。 */
    var capAttrInput = UI.input({
      id: 'aiCapAttr', type: 'number', inputmode: 'numeric',
      value: (s.aiAttrCap && s.aiAttrCap > 0) ? s.aiAttrCap : '',
      placeholder: '不限'
    });
    var capOccInput = UI.input({
      id: 'aiCapOcc', type: 'number', inputmode: 'numeric',
      value: (s.aiOccPtsCap && s.aiOccPtsCap > 0) ? s.aiOccPtsCap : '',
      placeholder: '不限'
    });
    var capIntInput = UI.input({
      id: 'aiCapInt', type: 'number', inputmode: 'numeric',
      value: (s.aiIntPtsCap && s.aiIntPtsCap > 0) ? s.aiIntPtsCap : '',
      placeholder: '不限'
    });

    /* 含幸运 / 不含幸运：两个按钮互斥，视觉上就是一组开关 */
    var withLuck = s.aiAttrCapWithLuck !== false;
    /* 顺序：先「含幸运」再「不含幸运」—— 含幸运是默认值，放前面更符合直觉 */
    var luckBtns = [1, 0].map(function (on) {
      var val = !!on;
      return h('button.chip', {
        text: val ? '含幸运（9 项）' : '不含幸运（8 项）',
        onclick: function () {
          withLuck = val;
          luckBtns.forEach(function (b) { b.classList.toggle('on', b.__v === withLuck); });
        }
      });
    });
    luckBtns[0].__v = true;
    luckBtns[1].__v = false;
    luckBtns.forEach(function (b) { b.classList.toggle('on', b.__v === withLuck); });

    function readCap(el) {
      var v = parseInt(String(el.value || '').trim(), 10);
      if (isNaN(v) || v <= 0) return 0;   // 0 = 不限
      return v;
    }

    var showKey = false;
    var eyeBtn = h('button.btn.sm', {
      text: '显示',
      onclick: function () {
        showKey = !showKey;
        keyInput.type = showKey ? 'text' : 'password';
        this.textContent = showKey ? '隐藏' : '显示';
      }
    });

    function save(quiet) {
      var b = String(baseInput.value || '').trim();
      var m = String(modelInput.value || '').trim();
      var k = String(keyInput.value || '').trim();
      if (b && !/^https?:\/\//i.test(b)) {
        baseInput.classList.add('invalid');
        UI.toast('接口地址需要以 http:// 或 https:// 开头', 'err', 3000);
        return false;
      }
      Store.setSettings({
        aiBase: b, aiModel: m, aiKey: k,
        aiAttrCap: readCap(capAttrInput),
        aiAttrCapWithLuck: withLuck,
        aiOccPtsCap: readCap(capOccInput),
        aiIntPtsCap: readCap(capIntInput)
      });
      baseInput.value = b; modelInput.value = m; keyInput.value = k;
      paintState();
      if (!quiet) UI.toast('AI 设置已保存', 'ok');
      return true;
    }

    var testBtn = h('button.btn.sm.teal', {
      text: '测试连接',
      onclick: function () {
        if (!save(true)) return;
        if (!global.AIClient.configured()) { UI.toast('三项都填好才能测试', 'err', 2600); return; }
        var btn = this;
        btn.disabled = true;
        var old = btn.textContent;
        btn.textContent = '测试中…';
        global.AIClient.test().then(function (r) {
          // test() 现在返回结构化结果：只要 HTTP 通了就算连接正常，
          // 不再要求「必须拿到模型回复的文字」。
          btn.disabled = false; btn.textContent = old;

          // 默认只用 toast —— 连接成功是高频操作，弹模态会挡住后面的流程。
          // 只有「有需要用户留意的东西」时才升级成弹层。
          var warn = [];
          if (r.modelInList === false) {
            warn.push('这个地址可以连通，但列表里没有你填的模型名「' + cfgNow().model +
              '」。AI 车卡大概率会失败（400），建议改成列表里实际存在的名字。');
          }
          if (r.hint) warn.push(r.hint);

          if (!warn.length) {
            UI.toast('连接正常 · ' + (r.reply || '已连通'), 'ok', 3200);
            return;
          }

          var rows = [
            UI.notice(r.reply || '已连接', r.empty ? 'warn' : 'ok', r.empty ? '◈' : '✓'),
            h('div.small.dim', { style: { marginTop: '11px', lineHeight: '1.85' }, text: warn.join('\n') })
          ];
          if (r.models && r.models.length) {
            rows.push(h('div.tiny.muted', { style: { marginTop: '10px', lineHeight: '1.75' }, text:
              '该地址可用模型（部分）：' + r.models.slice(0, 12).join('、') +
              (r.models.length > 12 ? ' 等 ' + r.models.length + ' 个' : '') }));
          }
          rows.push(h('div.tiny.dim', { style: { marginTop: '11px', lineHeight: '1.8' }, text:
            '连接本身是通的，可以直接去第 0 步用「✨ AI 车卡」。' }));
          UI.sheet({ title: '连接正常（有提示）', body: h('div', null, rows) });
        }).catch(function (err) {
          btn.disabled = false; btn.textContent = old;
          UI.sheet({
            title: '连接失败',
            body: h('div', null, [
              UI.notice(err.message || '未知错误', 'err', '✕'),
              h('div.small.dim', { style: { marginTop: '11px', lineHeight: '1.8' }, text:
                '可以按顺序检查：① 接口地址是不是以 http(s):// 开头、结尾有没有多写斜杠；' +
                '② 模型名称是不是该服务商实际提供的名字；③ API Key 有没有复制完整。' +
                '另外请确认网络能访问该地址 —— 部分服务需要代理。' })
            ])
          });
        });
      }
    });

    var body = h('div', null, [
      h('div.card', null, [
        h('div.card-title', { text: 'AI 车卡 · 接入信息' }),
        h('div.tiny.dim', { style: { marginBottom: '11px', lineHeight: '1.75' }, text:
          '填入任意一个「OpenAI 兼容」的大模型接口，就能在第 0 步用一句话生成调查员。三项都只保存在本机。' }),
        UI.field('接口地址', baseInput, { help: '默认 DeepSeek：https://api.deepseek.com/v1' }),
        UI.field('模型名称', modelInput, { help: '默认 deepseek-flash；换服务商时填它提供的模型名' }),
        UI.field('API Key', h('div.row', { style: { gap: '7px' } }, [h('div.grow', null, [keyInput]), eyeBtn]),
          { help: '在服务商后台创建，形如 sk-...' }),
        h('div.btn-group', { style: { marginTop: '4px' } }, [
          h('button.btn.primary.grow', { text: '保存', onclick: function () { save(false); } }),
          testBtn
        ]),
        stateLine
      ]),

        /* id 是定位锚点：第 0 步的「设置属性 / 技能上限」按钮打开本弹层后
           会滚到这张卡片并高亮。别删，改结构时也别把它挪到别的卡片上。 */
        h('div.card#aiCapsCard', null, [
        h('div.card-title', { text: '数值上限（房规 · 可选）' }),
        h('div.tiny.dim', { style: { marginBottom: '11px', lineHeight: '1.75' }, text:
          '定房规用：想让大家创建的调查员别太强，就在这里设上限。' +
          '对「生成随机角色」与「AI 车卡」都生效（彩蛋卡也一样）——' +
          '房间里的规矩该一视同仁，不能只约束一种车卡方式。' +
          '留空（或填 0）表示不限制，默认就是不限制。' }),
        UI.field('属性总和上限', capAttrInput, {
          help: '例如 400。设置后，属性九项合计会被压到不超过这个数 —— ' +
                '随机卡掷完骰、AI 卡拿到模型给的数值之后都会先压缩再生成卡。'
        }),
        h('div.row.wrap', { style: { gap: '6px', marginTop: '-4px', marginBottom: '9px' } }, luckBtns),
        /* ⚠️ 下面两项的措辞必须写清是「**每一项技能**最多到多少」。
           早先写成「职业技能点数上限」并实现成「压缩点数池」，
           玩家看到「职业点 80/280」会以为点数被削了 —— 实际点数没变少，
           少的只是每项的天花板。 */
        UI.field('每项本职技能上限', capOccInput, {
          help: '例：填 80，则「侦查」这类本职技能最高点到 80。' +
                '点数总额仍按职业公式算（多数职业是 教育×4），不会因此变少 ——' +
                '只是每一项到 80 就封顶了。'
        }),
        UI.field('每项兴趣技能上限', capIntInput, {
          help: '例：填 60，则「会计」这类非本职技能最高点到 60。' +
                '含玩家自选的个人特长 / 时代特长 —— 属于本职的走上一项，不属于的走这一项。'
        }),
        h('div.btn-group', { style: { marginTop: '4px' } }, [
          h('button.btn.primary.grow', { text: '保存上限', onclick: function () { save(false); } }),
          h('button.btn.ghost', {
            text: '全部清除',
            onclick: function () {
              capAttrInput.value = ''; capOccInput.value = ''; capIntInput.value = '';
              withLuck = true;
              luckBtns.forEach(function (b) { b.classList.toggle('on', b.__v === true); });
              save(false);
            }
          })
        ]),
        h('div.tiny.muted', { style: { marginTop: '11px', lineHeight: '1.8' }, text:
          'AI 车卡时，提示词会先要求模型照做；模型没照做也没关系 —— 生成后本地还会再校准一次，' +
          '所以「设了就一定不超」。随机卡与彩蛋卡则从一开始就按这里算，不存在超标的问题。' +
          '属性超限时按比例压缩，不会把某个单项砍成废人。' })
      ]),

      h('div.card', null, [
        h('div.card-title', { text: '怎么用（三步）' }),
        h('div.small.dim', { style: { lineHeight: '1.9' } }, [
          h('div', null, [h('b', { text: '① 填三项' }), '　接口地址、模型名称、API Key。默认值已经是 DeepSeek 官方地址与 deepseek-flash，只补 Key 就能用。']),
          h('div', null, [h('b', { text: '② 点「测试连接」' }), '　跳出「连接正常」就说明三项都对，可以放心用。报错时页面会写明原因（Key 无效 / 余额不足 / 模型名不对 / 地址不存在）。']),
          h('div', null, [h('b', { text: '③ 去第 0 步用' }), '　「快速开始 → ✨ AI 车卡」，用一句话描述你想创建什么样的调查员，例如「民国时期的私家侦探，前警察」。不满意点「重新生成」即可。'])
        ]),
        h('div.tiny.muted', { style: { marginTop: '11px', lineHeight: '1.8' }, text:
          '不配置也完全不影响使用：第 0 步的「生成随机角色」与所有车卡功能都是纯本地的。' })
      ]),

      h('div.card', null, [
        h('div.card-title', { text: '去哪儿申请 Key' }),
        h('div.small.dim', { style: { lineHeight: '1.9' } }, [
          h('div', { text: '· DeepSeek：platform.deepseek.com → API keys，价格便宜、中文好。' }),
          h('div', { text: '· 其它兼容 OpenAI 格式的服务（通义千问、智谱、月之暗面、硅基流动等）' }),
          h('div', { text: '　把服务商给的接口地址、模型名、Key 填进去即可，用法完全一样。' })
        ]),
        h('div.tiny.muted', { style: { marginTop: '10px', lineHeight: '1.8' }, text:
          '说明：AI 车卡时，你写的那句描述会发送到上面填写的接口，由该服务商处理；' +
          '除此之外不会有任何数据离开这台设备。生成一张卡通常几秒，费用由你的账号承担。' })
      ])
    ]);

    paintState();
    var sh = UI.sheet({
      title: 'AI 设置', body: body,
      onClose: opts.onClose || null
    });

    /* 从第 0 步「设置属性 / 技能上限」跳进来时，直接定位到房规那一张卡片 ——
       这个弹层里还有接口地址 / 模型 / Key 三张卡片，不定位玩家得自己翻。
       滚动量用 rect 差值算：弹层是 position:fixed，卡片的 offsetParent 是遮罩
       而不是滚动容器，用 offsetTop 会算错位置。 */
    if (opts.focusCaps) {
      requestAnimationFrame(function () {
        var card = body.querySelector('#aiCapsCard');
        if (!card || !sh.el) return;
        var delta = card.getBoundingClientRect().top - sh.el.getBoundingClientRect().top;
        // 顶部留一点余量，避免卡片紧贴着标题栏
        sh.el.scrollTop += delta - 10;
        card.classList.add('cap-jump');
        setTimeout(function () { card.classList.remove('cap-jump'); }, 2600);
      });
    }
    return sh;
  }

  /** 读一次当前保存的 AI 配置（测试连接的结果提示要用） */
  function cfgNow() { return global.AIClient.cfg(); }

  function maskKey(k) {
    k = String(k || '');
    if (k.length <= 8) return '已设置';
    return k.slice(0, 4) + '…' + k.slice(-4);
  }

  /** 菜单里的「AI 车卡」：和向导第 0 步共用同一套交互面板 */
  function aiCreateSheet() {
    if (global.AICreateUI) { global.AICreateUI.open(); return; }
    UI.toast('AI 模块未加载', 'err');
  }

  /* ---------- 设置项：角色卡云分享服务地址 ---------- */
  /**
   * 云分享的后端地址不硬编码在代码里：
   *   打包预置（BuildConfig.shareBase，仅自用版有）→ 用户在此填写 → 未配置
   * 未配置时不提供上传入口，也就不会把任何数据发出去。
   */
  function shareCard() {
    var canCustom = !(global.BuildConfig && global.BuildConfig.allowCustomShareBase === false);
    var preset = global.CocShare.presetBase();

    var stateLine = h('div.tiny.dim', { style: { marginTop: '8px', lineHeight: '1.75' } });
    function paintState() {
      UI.clear(stateLine);
      var now = global.CocShare.base();
      var t;
      if (!now) {
        t = '尚未配置 —— 不会上传任何数据，角色卡只保存在本机。';
      } else if (now === preset) {
        t = '当前生效：' + now + '（本版本已预置，可直接使用）';
      } else {
        t = '当前生效：' + now + '（你填写的地址）';
      }
      stateLine.appendChild(h('div', { text: t }));
    }

    var body = h('div');

    if (canCustom) {
      var input = UI.input({
        type: 'url',
        value: (Store.getState().settings || {}).shareBase || '',
        placeholder: 'https://你的域名/coc'
      });
      input.addEventListener('input', function () { input.classList.remove('invalid'); });

      body.appendChild(h('div', { style: { marginBottom: '10px' } }, [input]));
      body.appendChild(h('div.btn-group', null, [
        h('button.btn.sm.teal.grow', {
          text: '保存地址',
          onclick: function () {
            var v = String(input.value || '').trim();
            if (!v) { UI.toast('请填写地址，或点「清除」恢复默认', 'err'); return; }
            if (!global.CocShare.looksValid(v)) {
              input.classList.add('invalid');
              UI.toast('地址格式不对，需要以 http:// 或 https:// 开头', 'err', 3200);
              return;
            }
            Store.setSettings({ shareBase: v });
            UI.toast('分享服务地址已保存', 'ok');
            paintState();
          }
        }),
        h('button.btn.sm.grow', {
          text: '清除',
          onclick: function () {
            Store.setSettings({ shareBase: '' });
            input.value = '';
            paintState();
            UI.toast(preset ? '已恢复为内置地址' : '已清除，云分享暂不可用', 'ok');
          }
        })
      ]));
    }

    body.appendChild(stateLine);
    paintState();

    return h('div.card', null, [
      h('div.card-title', { text: '角色卡云分享' }),
      h('div.tiny.dim', {
        style: { marginBottom: canCustom ? '10px' : '0', lineHeight: '1.75' },
        text: canCustom
          ? '填入你自己的分享服务地址（后端程序随项目提供）。不填也不影响使用 —— 角色卡始终保存在本机。'
          : '本版本未内置云分享服务，角色卡只保存在本机。'
      }),
      body
    ]);
  }

  function settingsSheet() {
    var s = Store.getState().settings;
    var themeToggles = h('div.row.wrap', { style: { gap: '7px' } });
    ['dark', 'light'].forEach(function (t) {
      var on = s.theme === t;
      themeToggles.appendChild(h('button.chip' + (on ? '.on' : ''), {
        text: t === 'dark' ? '暗色（深渊）' : '亮色（羊皮纸）',
        onclick: function () {
          Store.setSettings({ theme: t });
          applyTheme(t);
          Array.prototype.forEach.call(themeToggles.children, function (x) { x.classList.remove('on'); });
          this.classList.add('on');
        }
      }));
    });

    var autoToggle = h('div.row.wrap', { style: { gap: '7px' } });
    [['开启', true], ['关闭', false]].forEach(function (p) {
      var on = s.autoSave === p[1];
      autoToggle.appendChild(h('button.chip' + (on ? '.on' : ''), {
        text: p[0], onclick: function () {
          Store.setSettings({ autoSave: p[1] });
          Array.prototype.forEach.call(autoToggle.children, function (x) { x.classList.remove('on'); });
          this.classList.add('on');
        }
      }));
    });

    var impInput = h('input', { type: 'file', accept: '.json', style: { display: 'none' } });
    impInput.addEventListener('change', function () {
      var f = impInput.files[0]; if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        var c = Store.importCharacter(fr.result);
        UI.toast(c ? '已导入：' + c.characterName : '导入失败：文件格式不正确', c ? 'ok' : 'err');
        if (c) go('#/my');
      };
      fr.readAsText(f);
      impInput.value = '';
    });

    UI.sheet({
      title: '设置',
      body: h('div', null, [
        UI.field('主题', themeToggles),
        UI.field('自动保存', autoToggle, { help: '修改后 0.5 秒自动写入本地存储' }),
        shareCard(),
        h('div.card', null, [
          h('div.card-title', { text: '数据管理' }),
          h('div.btn-group', null, [
            h('button.btn.sm.grow', { text: '导出全部角色', onclick: function () { exportAll(); } }),
            h('button.btn.sm.grow', { text: '导入角色 JSON', onclick: function () { impInput.click(); } }),
            impInput
          ])
        ]),
        h('div.card', null, [
          h('div.card-title', { text: '规则数据' }),
          h('div.tiny.dim', { html: '职业 <b>' + OCC.listAll().length + '</b> 项 · 技能 <b>' +
            global.COC_SKILLS.length + '</b> 类（含组技能专攻共 ' +
            (global.COC_SKILLS.filter(function (x) { return !x.special; }).length +
             global.COC_SKILLS.reduce(function (a, x) { return a + (x.flat ? x.subskills.length : 0); }, 0)) +
            ' 项）· 武器 <b>' + global.COC_WEAPONS.length + '</b> 件 · 防具 <b>' + global.COC_ARMORS.length +
            '</b> 项 · 载具 <b>' + global.COC_VEHICLES.length + '</b> 种 · 法术 <b>' +
            (global.COC_SPELLS || []).length + '</b> 个 · 恐惧症/狂躁症各 <b>100</b> 条' })
        ]),
        h('div.card', null, [
          h('div.card-title', { text: '危险操作' }),
          h('button.btn.danger.block', {
            text: '清空全部本地数据',
            onclick: function () {
              UI.confirm('将删除本机保存的所有角色与草稿，且无法恢复。确定继续吗？', { danger: true, okText: '确认清空' })
                .then(function (ok) {
                  if (!ok) return;
                  localStorage.removeItem('coc7.characters.v1');
                  localStorage.removeItem('coc7.draft.v1');
                  location.reload();
                });
            }
          })
        ])
      ])
    });
  }

  function exportAll() {
    var json = JSON.stringify({ format: 'coc7-bundle', version: 1, characters: Store.listCharacters() }, null, 2);
    if (UI.saveFile('coc7-characters.json', json, 'text')) UI.toast('已导出', 'ok');
  }

  /** 打开外部链接：安卓走原生（丢给系统浏览器），其余环境新开标签页 */
  function openExternal(url) {
    if (UI.isAndroid()) {
      try {
        if (global.AndroidBridge && global.AndroidBridge.openUrl &&
            global.AndroidBridge.openUrl(url)) return;
      } catch (e) { /* 落到下面的兜底 */ }
    }
    try { global.open(url, '_blank'); } catch (e) { location.href = url; }
  }

  /** 一行「标题 + 可点链接」，关于页与作者信息用 */
  function linkRow(label, url, text) {
    return h('div.tiny.dim', { style: { marginTop: '7px', lineHeight: '1.75' } }, [
      h('span', { text: label + '：' }),
      h('a', {
        href: url, text: text,
        onclick: function (e) { e.preventDefault(); openExternal(url); }
      })
    ]);
  }

  function aboutSheet() {
    UI.sheet({
      title: '关于',
      body: h('div', null, [
        h('div.about-brand', null, [
          h('img', { src: 'img/logo.png', alt: '' }),
          h('div.nm', { text: (window.BuildConfig && window.BuildConfig.displayName) || '骰境 TRPG' })
        ]),
        UI.notice(((window.BuildConfig && window.BuildConfig.displayName) || '骰境 TRPG') + ' · 角色卡创建工具', null, '◈'),
        h('p.small.dim', { text: '骰境 TRPG 是克苏鲁的呼唤第七版（COC 7th）调查员角色卡的创建与跑团工具：既能从零车出一张完整角色卡，也能开房间和同伴实时跑团（地图 / 战斗 / 检定 / 记录 / 手绘 / 笔记）。角色卡默认只保存在本机。' }),
        h('div.card', null, [
          h('div.card-title', { text: '版本' }),
          h('div.small.dim', { text: 'v' + ((window.BuildConfig && window.BuildConfig.versionName) || '2.13.13') })
        ]),
        h('div.card', null, [
          h('div.card-title', { text: '作者' }),
          h('div.tiny.dim', { html: '作者：' + ((window.BuildConfig && window.BuildConfig.authorName) || '茶叶蛋') }),
          ((window.BuildConfig && window.BuildConfig.authorEmail)
            ? h('div.tiny.dim', { style: { marginTop: '6px' }, html: '邮箱：<a href="mailto:' + window.BuildConfig.authorEmail + '">' + window.BuildConfig.authorEmail + '</a>' })
            : null),
          ((window.BuildConfig && window.BuildConfig.authorBili)
            ? linkRow('B 站', window.BuildConfig.authorBili, '空间主页')
            : null),
          ((window.BuildConfig && window.BuildConfig.authorSite)
            ? linkRow('项目主页', window.BuildConfig.authorSite, window.BuildConfig.authorSite)
            : null)
        ]),
        h('div.card', null, [
          h('div.card-title', { text: '功能一览' }),
          h('div.small.dim', { style: { lineHeight: '1.85' }, html:
            '· <b>车卡</b>：一键随机调查员 / AI 一句话车卡 / 完整向导（资料→属性→职业→资产→技能→战斗→装备→背景）<br>' +
            '· <b>智能计算</b>：随机掷骰、手动填写、购点、天命 N 选一；年龄调整、教育进步、派生属性、职业点与技能上限自动算<br>' +
            '· <b>角色卡管理</b>：导出长图与 JSON 存档、生成只读分享链接；已撕卡归档「英灵殿」<br>' +
            '· <b>跑团房间</b>：邀请链接一键进团，实时同步地图 / 战斗 / 记录 / 队友 / 手绘板 / 笔记<br>' +
            '· <b>检定与战斗</b>：场景检定编辑器、技能 / 属性 / SAN 检定、战斗对抗与攻击结算、自定义骰子、暗骰与房规自定义<br>' +
            '· <b>玩家面板</b>：HP / MP / SAN 进度条、自行改状态、临时卡「生效到原卡」、只给你看的私密信息（可全屏）<br>' +
            '· <b>隐私</b>：角色卡默认只存本机，不上传、不注册；仅主动使用云分享 / AI 车卡时才发送数据' })
        ]),
        h('div.card', null, [
          h('div.card-title', { text: '隐私' }),
          h('div.small.dim', { style: { lineHeight: '1.85' }, text:
            '角色卡默认只保存在本机，不上传、不需要注册。仅当你主动使用「云分享」或「AI 车卡」时，' +
            '相关数据才会发送到你填写的服务地址。' })
        ])
      ])
    });
  }

  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t === 'light' ? 'light' : 'dark');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'light' ? '#f2efe9' : '#0b1119');
  }

  /* ============================================================
   * 首页
   * ============================================================ */
  function renderHome() {
    route = { name: 'home' };
    stepperEl.style.display = 'none';
    barEl.style.display = 'none';
    UI.clear(viewEl);

    viewEl.appendChild(h('div.card', null, [
      h('div.card-head', null, [h('h3', { text: '创建角色卡' })]),
      h('button.rule-card.on', {
        onclick: function () { createNewCharacter('coc7'); },
        html: '<div class="ic">🦑</div><div class="grow"><div class="t">克苏鲁的呼唤 第七版</div>' +
              '<div class="d">COC 7th · 调查员角色卡 · ' + OCC.listAll().length + ' 个职业</div></div>' +
              '<div style="color:var(--gold);font-size:18px">→</div>'
      }),
      h('div.tiny.muted', { text: '未来预留', style: { margin: '12px 0 7px', letterSpacing: '.08em' } }),
      h('div', null, (global.RuleRegistry.placeholders || []).map(function (p) {
        return h('button.rule-card.off', {
          disabled: true,
          html: '<div class="ic">🔒</div><div class="grow"><div class="t">' + p.name + '</div>' +
                '<div class="d">' + p.shortName + ' · 尚未开放</div></div>'
        });
      }))
    ]));

    // 跑团房间：和车卡并列的主功能，不是车卡流程里的一步
    viewEl.appendChild(h('button.rule-card.room-entry', {
      onclick: function () { guardLeave(function () { go('#/room'); }); },
      html: '<div class="ic">🎭</div><div class="grow"><div class="t">跑团房间</div>' +
            '<div class="d">和同伴开团：招募 · 聊天 · 掷骰 · 场景与战斗</div></div>' +
            '<div style="color:var(--gold);font-size:18px">→</div>'
    }));

    var chars = Store.listCharacters();
    /* v2.1.8（用户第 3 项）：拆成「已保存的角色卡」（未撕卡）与「英灵殿」（已撕卡）两栏。
       首页只预览未撕卡的卡；撕卡的归到「英灵殿」，不被当成还能用的调查员。 */
    var aliveChars = chars.filter(function (c) { return !isRippedCard(c); });
    var rippedChars = chars.filter(function (c) { return isRippedCard(c); });
    if (aliveChars.length) {
      // 标题栏与角色卡放在同一个容器里（.char-list），视觉上连成一体，
      // 不会出现「标题下面空一道缝、再单独浮出一张卡」的断头感。
      var listWrap = h('div.char-list');
      listWrap.appendChild(h('div.card-head', null, [
        h('h3', { text: '已保存的角色卡' }),
        h('span.hint', { text: aliveChars.length + ' 位' })
      ]));
      aliveChars.slice(0, 3).forEach(function (c) { listWrap.appendChild(charCard(c)); });
      viewEl.appendChild(listWrap);
      viewEl.appendChild(h('button.btn.ghost.block', { text: '查看全部 →', onclick: function () { go('#/my'); } }));
    }
    if (rippedChars.length) {
      viewEl.appendChild(h('div.card', null, [
        h('div.card-head', null, [h('h3', { text: '英灵殿' }), h('span.hint', { text: rippedChars.length + ' 位' })]),
        h('div.tiny.dim', { text: '已撕卡的角色长眠于此（死亡 / 永久疯狂），仅可浏览或删除。' }),
        /* v2.1.10（用户第 1 项）：只显示已撕卡的角色 —— 不再和「查看全部」进同一张表。 */
        h('button.btn.ghost.block', { text: '查看英灵殿 →', style: { marginTop: '8px' }, onclick: function () { go('#/my/ripped'); } })
      ]));
    }
    if (!aliveChars.length && !rippedChars.length) {
      viewEl.appendChild(h('div.card', null, [
        h('div.card-title', { text: '使用流程' }),
        h('div.tiny.dim', { html:
          '填写基本信息 → 生成属性 → 选择职业 → <b>分配信用评级</b> → 分配技能点 → 添加武器装备 → 填写背景与法术 → 完整性检查 → 保存并分享<br><br>' +
          '信用评级由职业决定取值范围，并且要从职业点数里扣除；先定评级再分技能点。<br>' +
          '系统会自动完成：派生属性计算、年龄调整、职业技能点计算（含信用评级）、兴趣技能点计算、技能最终值计算、职业限制检查、技能上限检查、信用评级检查。' })
      ]));
    }

    if (Store.isDraftActive()) {
      var d = Store.getState().draft;
      viewEl.appendChild(h('div.card', null, [
        h('div.card-title', { text: '发现未完成的草稿' }),
        h('div.small.dim', { text: (d.characterName || '未命名') + ' · ' + new Date(d.updatedAt || Date.now()).toLocaleString('zh-CN') }),
        h('div.btn-group', { style: { marginTop: '11px' } }, [
          h('button.btn.primary.grow', {
            text: '继续编辑', onclick: function () { openWizard('coc7', Store.startDraft('coc7')); }
          }),
          h('button.btn.ghost.grow', {
            text: '丢弃草稿', onclick: function () {
              UI.confirm('丢弃当前草稿？草稿里的内容不会被保存。').then(function (ok) {
                if (!ok) return;
                Store.clearDraft();
                renderHome();
              });
            }
          })
        ])
      ]));
    }
  }

  /** v2.1.6：角色是否已「撕卡」（身体死亡 / 永久疯狂）—— 不可再编辑，仅可浏览/删除 */
  function isRippedCard(c) {
    if (!c || !c.status) return false;
    if (c.status.body === '死亡') return true;
    var m = c.status.mental;
    var arr = Array.isArray(m) ? m : (m ? [String(m)] : []);
    return arr.indexOf('永久疯狂') >= 0;
  }

  function charCard(c) {
    var av = h('div.av');
    if (c.avatar) av.appendChild(h('img', { src: c.avatar, style: { width: '100%', height: '100%', objectFit: 'cover', borderRadius: '12px' } }));
    else av.appendChild(h('span', { text: '◈' }));
    return h('button.char-card', {
      // 链接里必须用角色的真实 id：state.characters 是按 id 建索引的。
      // 之前用 (c.shareId || c.id)，一旦完成角色卡就会拿到 shareId，
      // 于是点「已保存的角色卡 / 英灵殿」里的卡跳到 #/card/coc7/<shareId>，查表查不到 →
      // 页面报「找不到这张角色卡，链接可能已失效」。
      onclick: function () { Store.loadCharacter(c.id); go('#/card/' + (c.ruleSystemId || 'coc7') + '/' + c.id); },
      html: ''
    }, [
      av,
      h('div.grow', null, [
        h('div.nm', { text: c.characterName || '（未命名）' }),
        h('div.mt', { text: (OCC.getById(c.occupationId) || {}).name || '未选职业' }),
        h('div.st', null, [
          // 规则系统分类标签：后续接入 DND 5E / 自定义规则后一眼区分
          h('span.tag.rule-tag', { text: ruleLabel(c.ruleSystemId) }),
          h('span.tag', { text: 'HP ' + ((c.derivedStats || {}).maxHP || 0) }),
          h('span.tag', { text: 'SAN 上限 ' + ((c.derivedStats || {}).maxSAN || 0) }),
          /* v2.1.6：撕卡标记（死亡 / 永久疯狂）—— 用户验收：此前看不到撕卡状态 */
          isRippedCard(c) ? h('span.tag.danger', { text: '☠ 已撕卡' }) : null
        ])
      ])
    ]);
  }

  /* ============================================================
   * 我的角色
   * ============================================================ */
  function renderMine(view) {
    /* v2.1.10（用户第 1 项）：首页「查看全部」与「查看英灵殿」此前都跳到 #/my、
       都显示同一张表。现在按路由区分：
         #/my          → 只显示**未撕卡**的「已保存的角色卡」
         #/my/ripped   → 只显示**已撕卡**的「英灵殿」
       顶部给两个切换标签，随时能来回看。 */
    var onlyRipped = (view === 'ripped');
    route = { name: 'my', view: onlyRipped ? 'ripped' : '' };
    stepperEl.style.display = 'none';
    barEl.style.display = 'none';
    UI.clear(viewEl);

    var chars = Store.listCharacters();
    /* v2.1.8（用户第 3 项）：拆「已保存的角色卡」（未撕卡）/「英灵殿」（已撕卡）两栏。 */
    var aliveChars = chars.filter(function (c) { return !isRippedCard(c); });
    var rippedChars = chars.filter(function (c) { return isRippedCard(c); });
    viewEl.appendChild(h('div.step-head', null, [
      h('div.kicker', { text: onlyRipped ? 'VALHALLA' : 'COLLECTION' }),
      h('h2', { text: onlyRipped ? '英灵殿' : '已保存的角色卡' }),
      h('div.sub', { text: onlyRipped
        ? '共 ' + rippedChars.length + ' 位已撕卡的调查员（死亡 / 永久疯狂），仅可浏览或删除。'
        : '共 ' + aliveChars.length + ' 位可用调查员，可直接带进跑团房间。' })
    ]));

    /* 视图切换（两个池子各自的入口从此分得清） */
    viewEl.appendChild(h('div.btn-group', { style: { margin: '2px 0 10px' } }, [
      h('button.chip' + (onlyRipped ? '' : '.on'), {
        text: '已保存的角色卡（' + aliveChars.length + '）',
        onclick: function () { if (onlyRipped) go('#/my'); }
      }),
      h('button.chip' + (onlyRipped ? '.on' : ''), {
        text: '英灵殿（' + rippedChars.length + '）',
        onclick: function () { if (!onlyRipped) go('#/my/ripped'); }
      })
    ]));

    function charRow(c) {
      var wrap = h('div', { style: { position: 'relative' } });
      wrap.appendChild(charCard(c));
      // 「⋯」用 .char-more：视觉上仍是小圆角块，触摸热区 48px，手指不容易点空
      wrap.appendChild(h('button.char-more', {
        title: '更多操作',
        onclick: function (e) { e.stopPropagation(); charMenu(c); }
      }, [h('span', { text: '⋯' })]));
      return wrap;
    }

    if (onlyRipped) {
      if (rippedChars.length) {
        rippedChars.forEach(function (c) { viewEl.appendChild(charRow(c)); });
      } else {
        viewEl.appendChild(UI.emptyState('🕯', '英灵殿', '还没有英雄长眠于此'));
      }
    } else {
      if (!chars.length) {
        viewEl.appendChild(UI.emptyState('📇', '还没有角色', '先创建一位调查员吧'));
        viewEl.appendChild(h('button.btn.primary.block', { text: "＋ 创建角色", onclick: function () { createNewCharacter("coc7"); } }));
        return;
      }
      if (aliveChars.length) {
        aliveChars.forEach(function (c) { viewEl.appendChild(charRow(c)); });
      } else {
        viewEl.appendChild(UI.emptyState('🕯', '没有可用的角色卡',
          '所有角色卡都已撕卡（在「英灵殿」里）——先创建一位新调查员吧'));
      }
    }

    viewEl.appendChild(h('button.btn.primary.block', { text: "＋ 创建新角色", style: { marginTop: "12px" }, onclick: function () { createNewCharacter("coc7"); } }));
  }

  function charMenu(c) {
    var rs = c.ruleSystemId || 'coc7';
    var items = [
      ['👁 查看角色卡', function () { Store.loadCharacter(c.id); go('#/card/' + rs + '/' + c.id); }],
      ['🖼 生成图片', function () { Store.loadCharacter(c.id); global.SheetView.exportImage(Store.getState().current); }],
      ['⬇ 导出 JSON', function () {
        var json = Store.exportCharacter(c.id);
        var blob = new Blob([json], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = (c.characterName || 'character') + '.json';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        UI.toast('已导出', 'ok');
      }],
      ['🗑 删除角色', function () {
        UI.confirm('删除「' + (c.characterName || '未命名') + '」？此操作不可恢复。', { danger: true, okText: '删除' })
          .then(function (ok) {
            if (!ok) return;
            Store.deleteCharacter(c.id);
            renderMine(isRippedCard(c) ? 'ripped' : '');
            UI.toast('已删除', 'ok');
          });
      }]
    ];
    /* v2.1.8（用户第 3 项）：英灵殿里的撕卡不可再编辑 —— 菜单里不给「✎ 编辑角色」。 */
    if (!isRippedCard(c)) {
      items.splice(1, 0, ['✎ 编辑角色', function () { startEdit(c.id); }]);
    }
    var sh = UI.sheet({
      title: c.characterName || '未命名',
      body: h('div', null, items.map(function (it) {
        return h('button.occ-item', {
          html: '<div class="grow"><div class="nm">' + it[0] + '</div></div>',
          onclick: function () { sh.close(); it[1](); }
        });
      }))
    });
  }

  /* ============================================================
   * 编辑会话 —— 改已保存的角色必须手动保存
   *
   * 以前点「编辑角色」直接改的就是存储里那个对象，界面上到处都在
   * 自动保存，于是误改一下就永久覆盖了原卡。
   * 现在改成：Store.beginEdit 给一份副本，编辑期间只写中转区，
   * 点「保存修改」才 commitEdit 落库；「放弃」则原卡纹丝不动。
   * ============================================================ */

  /**
   * 带「未保存修改」保护的离开。
   * 所有会离开向导的入口（菜单、标题栏 logo、返回键）都从这里走，
   * 免得误触一下就把半天车卡白做。
   */
  function guardLeave(then) {
    if (!Store.isEditing()) { then(); return; }
    if (!Store.isEditDirty()) { Store.cancelEdit(); then(); return; }
    var name = (ctx && ctx.character && ctx.character.characterName) || '这张角色卡';
    UI.confirm('「' + name + '」的修改还没有保存。\n离开会丢弃这些修改，角色卡保持原样。',
      { danger: true, okText: '丢弃修改并离开', cancelText: '继续编辑' }
    ).then(function (ok) {
      if (!ok) return;
      Store.cancelEdit();
      ctx = null;
      then();
    });
  }

  /** 进入编辑：从角色卡/我的角色的「✎ 编辑角色」调用 */
  function startEdit(id) {
    var begin = function () {
      var c = Store.beginEdit(id);
      if (!c) { UI.toast('找不到这张角色卡', 'err'); return; }
      openWizard(c.ruleSystemId || 'coc7', c);
      var info = Store.editInfo();
      if (info && info.restored) UI.toast('已恢复上次未保存的修改', 'ok', 2600);
      else UI.toast('编辑模式：改完要点「保存修改」才会写回角色卡', 'ok', 3000);
    };

    // 已经在编辑另一张卡且改过东西 → 先问一句
    var cur = Store.editingId();
    if (cur && cur !== id && Store.isEditDirty()) {
      UI.confirm('另一张角色卡还有未保存的修改，切换编辑对象会丢弃它们。',
        { danger: true, okText: '丢弃并切换', cancelText: '留下继续编辑' }
      ).then(function (ok) { if (ok) begin(); });
      return;
    }
    if (cur && cur !== id) Store.cancelEdit();
    begin();
  }

  /** 手动保存编辑中的角色卡（底栏「保存修改」/ 完成步骤 / 编辑条按钮共用） */
  function saveEdit() {
    if (!Store.isEditing()) return;
    var c = ctx && ctx.character;
    if (!c) { UI.toast('没有可保存的内容', 'err'); return; }
    Engine.recalc(c);
    var bad = Engine.checkList(c).filter(function (x) { return !x.ok; });

    var commit = function () {
      var saved = Store.commitEdit('编辑角色');
      if (!saved) { UI.toast('保存失败：原角色卡已不存在', 'err', 3000); return; }
      UI.toast('已保存「' + (saved.characterName || '角色卡') + '」', 'ok', 2400);
      ctx = null;
      go('#/card/' + (saved.ruleSystemId || 'coc7') + '/' + saved.id);
    };

    if (bad.length) {
      UI.confirm('当前还有 ' + bad.length + ' 个问题未解决（属性未填完 / 技能点超额 / 信用评级越界等）。\n保存后角色卡可以继续编辑，但暂时不符合规则。确定保存吗？',
        { okText: '仍然保存', cancelText: '回去检查', danger: true }
      ).then(function (ok) { if (ok) commit(); });
    } else commit();
  }

  /** 放弃编辑：角色卡回到进入编辑前的样子 */
  function discardEdit() {
    if (!Store.isEditing()) return;
    var id = Store.editingId();
    var rs = (ctx && ctx.character && ctx.character.ruleSystemId) || 'coc7';
    UI.confirm('放弃所有未保存的修改？\n角色卡会恢复成进入编辑前的样子。',
      { danger: true, okText: '放弃修改', cancelText: '继续编辑' }
    ).then(function (ok) {
      if (!ok) return;
      Store.cancelEdit();
      ctx = null;
      UI.toast('已放弃修改，角色卡保持原样', 'ok', 2400);
      go('#/card/' + rs + '/' + id);
    });
  }

  /** 编辑模式下常驻的那条提示（说明「改完要手动保存」并给出两个按钮） */
  function editBar() {
    var c = (ctx && ctx.character) || {};
    return h('div.edit-bar', null, [
      h('div.eb-tx', null, [
        h('div.eb-t', { text: '✎ 正在编辑「' + (c.characterName || '未命名') + '」' }),
        h('div.tiny', { text: '修改不会自动写回角色卡，点「保存修改」才生效' })
      ]),
      h('div.eb-act', null, [
        h('button.btn.sm.teal', { text: '💾 保存修改', onclick: saveEdit }),
        h('button.btn.sm.ghost', { text: '↩ 放弃', onclick: discardEdit })
      ])
    ]);
  }

  /* ============================================================
   * 创建向导
   * ============================================================ */
  var ctx = null;

  /**
   * 用一张具体的角色卡打开向导。
   * 所有进入向导的路径最终都汇聚到这里，避免出现「拿着旧 ctx 渲染新页面」的错位。
   * 起始步骤自动判定：空白草稿 → 第 0 步「快速开始」；已有内容 / 已保存的卡 → 第 1 步。
   */
  function openWizard(ruleSystemId, character) {
    ctx = {
      character: character,
      step: startStepFor(character),
      goStep: function (i) {
        // 编辑已保存的角色时不允许回第 0 步：那里会让人「采用一张新随机卡」，
        // 与「改这张卡」是两回事，点错了等于白改。
        if (Store.isEditing() && i === 0) {
          UI.toast('编辑已保存的角色时不能回到「快速开始」', 'err', 2600);
          return;
        }
        // 一旦离开第 0 步，就记住「已经做过快速开始的选择」，
        // 下次从「我的角色 / #/create」进来不会又把人丢回第 0 步。
        if (ctx.step === 0 && i > 0) { ctx.character.startSkipped = true; Store.scheduleSave(); }
        ctx.step = Math.max(0, Math.min(STEP_IDS.length - 1, i));
        renderWizard();
      },
      refreshBar: function () { paintStepper(); paintBottom(); }
    };
    route = { name: 'create' };
    renderWizard();
  }

  /**
   * 起始步骤：
   *   · 非草稿（编辑已保存的角色）→ 直接进第 1 步「基本资料」
   *   · 草稿但已动过（填过名字 / 属性 / 职业 / 技能），或已经点过「我要自己车卡」→ 第 1 步
   *   · 刚新建、完全空白的草稿 → 第 0 步「快速开始」
   */
  function startStepFor(character) {
    var c = character || {};
    // 编辑已保存的角色：直接进第 1 步（它已经「做过快速开始」了）
    if (Store.isEditing()) return 1;
    var d = Store.getState().draft;
    if (!d || d.id !== c.id) return 1;
    if (c.startSkipped) return 1;
    var touched = !!(c.characterName || c.occupationId ||
                     (c.skills || []).length ||
                     (c.attributes && c.attributes.str !== undefined && c.attributes.str !== ''));
    return touched ? 1 : 0;
  }

  /**
   * 新建一张空白角色卡并打开向导 —— 首页规则卡、菜单与「我的角色」的
   * 创建按钮都走这里。已有未完成草稿时会先问一句，默认把草稿保留下来。
   */
  function createNewCharacter(ruleSystemId) {
    ruleSystemId = ruleSystemId || 'coc7';
    var d = Store.getState().draft;
    var hasContent = d && (d.characterName || (d.skills || []).length);
    if (hasContent) {
      UI.confirm(
        '检测到未完成的草稿「' + (d.characterName || '未命名') + '」。\n新建角色卡会得到一张完全的空白卡，当前草稿将保留在「我的角色」中。',
        { okText: '新建空白卡', cancelText: '继续编辑草稿' }
      ).then(function (ok) {
        if (ok) openWizard(ruleSystemId, Store.newDraft(ruleSystemId));
        else openWizard(ruleSystemId, Store.startDraft(ruleSystemId));
      });
      return;
    }
    openWizard(ruleSystemId, Store.newDraft(ruleSystemId));
  }

  /** 回首页。不依赖 hash 变化，顺便清掉向导上下文，避免下次进来带着旧数据。 */
  function goHome() {
    ctx = null;
    route = { name: 'home' };
    if (location.hash !== '#/' && location.hash !== '') location.hash = '#/';
    renderHome();
  }

  /** 进入 #/create：优先编辑当前内存里的卡，否则恢复草稿/新建 */
  function enterCreateRoute() {
    var cur = Store.getState().current;
    if (cur && cur.ruleSystemId === 'coc7') { openWizard('coc7', cur); return; }
    openWizard('coc7', Store.startDraft('coc7'));
  }

  function renderWizard() {
    if (!ctx) return;
    var c = ctx.character;
    Engine.recalc(c);

    stepperEl.style.display = 'block';
    barEl.style.display = 'flex';
    UI.clear(viewEl);

    paintStepper();

    // 编辑模式：最上面常驻一条提示 + 保存/放弃按钮，任何时候都能存
    if (Store.isEditing()) viewEl.appendChild(editBar());

    var stepId = STEP_IDS[ctx.step];
    var meta = global.Steps[stepId];
    if (!meta) { viewEl.appendChild(UI.emptyState('⚠', '步骤未实现：' + stepId)); return; }

    viewEl.appendChild(h('div.step-head', null, [
      h('div.kicker', { text: ctx.step === 0 ? '第 0 步 · 可选' : ('第 ' + ctx.step + ' / ' + (STEP_IDS.length - 1) + ' 步') }),
      h('h2', { text: meta.title }),
      meta.sub ? h('div.sub', { text: meta.sub }) : null
    ]));

    var body = h('div');
    viewEl.appendChild(body);
    try {
      meta.render(body, ctx);
    } catch (e) {
      console.error(e);
      body.appendChild(UI.notice('该步骤渲染出错：' + e.message, 'err'));
    }

    paintBottom();
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  function paintStepper() {
    UI.clear(stepperEl);
    var track = h('div.stepper-track');
    var done = progressDone();
    var editing = Store.isEditing();
    STEP_META.forEach(function (m, i) {
      var cls = 'stepper-item' + (i === ctx.step ? ' active' : (done[i] ? ' done' : ''));
      // 编辑模式下限速第 0 步：它是「挑一张新卡」，与「改这张卡」无关
      if (editing && i === 0) cls += ' disabled';
      track.appendChild(h('button', {
        class: cls,
        onclick: function () { ctx.goStep(i); }
      }, [
        h('span.dot', { text: done[i] && i !== ctx.step ? '✓' : (i + 1) }),
        h('span', { text: m.short })
      ]));
    });
    stepperEl.appendChild(track);
    // 步骤变多（含第 0 步共 10 步）后，激活项可能在横向轨道外，
    // 主动把它滚到轨道中间，用户一眼能看到自己在哪一步。
    var act = track.querySelector('.stepper-item.active');
    if (act) {
      var target = act.offsetLeft - (track.clientWidth - act.offsetWidth) / 2;
      track.scrollLeft = Math.max(0, target);
    }
    var pct = Math.round((ctx.step / (STEP_IDS.length - 1)) * 100);
    stepperEl.appendChild(h('div.stepper-bar', null, [h('i', { style: { width: pct + '%' } })]));
  }

  /** 判断各步骤完成度（用于进度勾）。按步骤 id 取，避免以后增删步骤时下标错位。 */
  function progressDone() {
    var c = ctx.character;
    var map = {};
    map.start = true;
    map.basic = !!(c.characterName && c.playerName && c.basicInfo.age);
    map.attr = Engine.attrsReady(c) && !attrBlockReason(c);
    map.occupation = !!c.occupationId && R.validators.occupationChoices(c, OCC).length === 0;
    map.assets = !!c.assets.creditRating && R.validators.creditRating(c, OCC).length === 0;
    map.skill = (function () {
      var st = global.SkillModel.stats(c);
      return st.occ.used > 0 && st.occ.used <= st.occ.total && st.interest.used <= st.interest.total && st.overCap.length === 0;
    })();
    map.combat = ((c.weapons || []).length + (c.armors || []).length) > 0;
    map.gear = (c.items || []).length > 0;
    map.background = !!(c.background.description || (c.history || []).length || (c.companions || []).length);
    map.finish = !!c.shareId;
    return STEP_IDS.map(function (id) { return !!map[id]; });
  }

  function paintBottom() {
    UI.clear(barEl);
    var i = ctx.step;
    var last = STEP_IDS.length - 1;

    barEl.appendChild(h('button.btn.ghost', {
      text: '← 上一步',
      disabled: i === 0,
      onclick: function () {
        if (i === 0) return;
        ctx.goStep(i - 1);
      }
    }));

    if (i < last) {
      // 硬性拦截（例如购点超额）必须当场看得见：底栏中间直接给出原因，
      // 「下一步」同时置灰。点它仍然会弹一次同样的提示，免得纯灰按钮让人摸不着头脑。
      var block = stepBlockReason(i);
      barEl.appendChild(h('div.grow.tiny.center' + (block ? '.bar-block' : '.muted'), {
        text: block || STEP_META[i].short,
        title: block || '',
        style: { fontSize: '11.5px' }
      }));
      barEl.appendChild(h('button.btn.primary' + (block ? '.blocked' : ''), {
        text: '下一步 →',
        onclick: advance
      }));
    } else {
      // 末步：底栏直接给真正的「完成」按钮。
      // 之前中间只是一个纯文字步骤名，看着像按钮却点不动，容易误认为卡死。
      barEl.appendChild(h('div.grow'));
      barEl.appendChild(h('button.btn.teal', {
        text: '👁 预览',
        onclick: function () { global.App.viewSheet(ctx.character); }
      }));
      barEl.appendChild(h('button.btn.primary', {
        // 编辑已保存的角色时，这一步的语义是「保存修改」而不是「完成一张新卡」
        text: Store.isEditing() ? '💾 保存修改' : '✓ 完成',
        onclick: function () {
          if (typeof ctx.finishAction === 'function') ctx.finishAction();
          else UI.toast('请在页面中点击「完成角色卡」', 'err');
        }
      }));
    }
  }

  /**
   * 前进到下一步
   *  canAdvance 返回值语义：
   *    true            通过
   *    字符串           硬性错误 → 直接提示、不前进
   *    { warn: '...' } 可以继续但需要用户确认（如技能点没用完）
   */
  function advance() {
    var i = ctx.step;
    var chk = canAdvance(i, true);
    if (chk === true) { ctx.goStep(i + 1); return; }
    if (typeof chk === 'string') { UI.toast(chk, 'err', 2800); return; }
    if (chk && chk.warn) {
      UI.confirm(chk.warn, { okText: '继续下一步', cancelText: '回去分配' }).then(function (ok) {
        if (ok) ctx.goStep(i + 1);
      });
    }
  }

  /** 当前步骤是否存在硬性拦截；有则返回原因文案（无则 null） */
  function stepBlockReason(i) {
    if (!ctx) return null;
    var r = canAdvance(i, true);
    return typeof r === 'string' ? r : null;
  }

  /** 属性步骤的硬性拦截：购点超额 / 天命没选 */
  function attrBlockReason(c) {
    if (!Engine.attrsReady(c)) return null;   // 属性没填完交给 AttrsReady 那句提示
    if (c.attributeMode === 'pointbuy') {
      var cap = parseInt(c.pbCap, 10) || 0;
      var res = R.generators.validatePointBuy(c.attributes, cap, c.pbIncludeLuck);
      if (!res.ok) return res.errors[0].text;
    }
    if (c.attributeMode === 'fate') {
      var f = c.fate || {};
      if (!f.rolled) return '天命还没掷出：先点「掷出天命」';
      if (parseInt(f.picked, 10) < 0) return '请先从 ' + (f.options || []).length + ' 组天命里选一组';
    }
    return null;
  }

  /** 是否可进入下一步；返回 true / 错误文案 / {warn} */
  function canAdvance(i, strict) {
    var c = ctx.character;
    var id = STEP_IDS[i];
    if (id === 'start') return true;   // 快速开始：两边的路都通
    if (id === 'basic') {
      var e = R.validators.basicInfo(c);
      if (e.length) return strict ? e[0].text : true;
      return true;
    }
    if (id === 'attr') {
      if (!Engine.attrsReady(c)) return strict ? '请先完成属性设置' : true;
      // 手动购点：总属性值超出上限就**不允许进入下一步**（硬拦截）
      var block = attrBlockReason(c);
      if (block) return strict ? block : true;
      return true;
    }
    if (id === 'occupation') {
      if (!c.occupationId) return strict ? '请先选择一个职业' : true;
      var errs = R.validators.occupationChoices(c, OCC);
      if (errs.length) return strict ? errs[0].text : true;
      return true;
    }
    // 资产：信用评级必须是合法值（必须在职业范围内）
    if (id === 'assets') {
      var credErrs = R.validators.creditRating(c, OCC);
      if (credErrs.length) return strict ? credErrs[0].text : true;
      return true;
    }
    // 技能：超额是硬错误；没用完只提醒
    if (id === 'skill') {
      var st = global.SkillModel.stats(c);
      if (st.occ.used > st.occ.total) return strict ? '职业技能点超出 ' + (st.occ.used - st.occ.total) + ' 点' : true;
      if (st.interest.used > st.interest.total) return strict ? '兴趣技能点超出 ' + (st.interest.used - st.interest.total) + ' 点' : true;
      if (st.overCap.length) return strict ? '技能「' + st.overCap[0].name + '」超过上限' : true;
      if (strict) {
        var leftOcc = st.occ.total - st.occ.used;
        var leftInt = st.interest.total - st.interest.used;
        if (leftOcc > 0 || leftInt > 0) {
          var parts = [];
          if (leftOcc > 0) parts.push('职业技能点还剩 ' + leftOcc + ' 点');
          if (leftInt > 0) parts.push('兴趣技能点还剩 ' + leftInt + ' 点');
          return { warn: parts.join('，') + ' 尚未分配。未使用的点数会作废，确定进入下一步吗？' };
        }
      }
      return true;
    }
    return true;
  }

  /* ============================================================
   * 状态调整（生命 / 魔法 / 理智 / 幸运 / 身心中状态）
   * ============================================================ */
  /* ============================================================
   * v2.10.0（身体状态模型）：身体状态 chips 编辑器
   *
   * 新模型（与跑团房间共用同一张卡 schema、同语义；房间侧 UI 合成见
   * ui/room-panels.js，权威落库见 room-model.js#stateApply/applyStateToCard）：
   *   · status.body        单值 {正常, 轻伤, 重伤, 死亡}
   *   · status.dying       布尔「濒死」标记，与「重伤」叠加
   *   · status.unconscious 布尔「昏迷」标记，与「重伤」叠加
   *   · 视图合成 bodyView：死亡 > dying > unconscious > body
   *     （单机卡展示侧的等价合成见 ui/sheet.js#bodyViewOf）
   *   · 撕卡判据不变：仍只认 body === "死亡"（isRippedCard，勿动）
   *
   * 交互矩阵（纯函数实现，单测直接抽源 eval，不依赖 DOM）：
   *   · 正常 / 轻伤         单选互斥；处于 重伤/濒死/昏迷 时禁用
   *   · 重伤 / 濒死 / 昏迷  复选可叠加；已勾选的不可自行取消（toast 说明）
   *   · 昏迷或濒死时整行置灰，仅「死亡」可点
   *   · 点「濒死」时若未勾「重伤」→ 自动勾上「重伤」
   *   · 死亡                行内两段式确认（v2.1.6 行为，见 bodySelect）
   * ============================================================ */

  /** 是否处于「受伤组」：重伤 / 濒死 / 昏迷（任一；含老数据里的 body 旧值） */
  function bodyWounded(st) {
    return st.body === '重伤' || st.body === '濒死' || st.body === '昏迷' ||
           st.dying === true || st.unconscious === true;
  }

  /** 是否昏迷 / 濒死 / 死亡 —— 整行置灰，仅「死亡」可点 */
  function bodyLocked(st) {
    return st.body === '死亡' || st.unconscious === true || st.dying === true ||
           st.body === '昏迷' || st.body === '濒死';
  }

  /** chips 禁用矩阵（纯函数，UI 与单测共用）。「死亡」永远可点（两段式确认兜底）。 */
  function bodyChipDisabled(st, chip) {
    if (chip === '死亡') return false;
    if (bodyLocked(st)) return true;
    if (chip === '正常' || chip === '轻伤') return bodyWounded(st);
    if (chip === '重伤') return st.body === '重伤';
    if (chip === '濒死') return st.dying === true;
    if (chip === '昏迷') return st.unconscious === true;
    return false;
  }

  /**
   * 点一个身体状态 chip 后的**纯状态迁移**（就地修改 st，返回界面提示）。
   * 只描述「允许发生的迁移」；禁用矩阵由 bodyChipDisabled 负责，这里再做一层
   * 兜底（防绕过 UI 直接调）：死亡后不可再改、受伤组里改回 正常/轻伤、
   * 取消已勾选的重伤/濒死/昏迷，一律拒绝并给出说明。
   * @param {object} st status 对象（就地修改）
   * @param {string} chip '正常' | '轻伤' | '重伤' | '濒死' | '昏迷'
   * @returns {{toast:string}} toast 为空串表示静默生效
   */
  function bodyChipNext(st, chip) {
    var REFUSE = '不能自行取消该状态 —— 需治愈伤势或队友 / KP 施救';
    /* 死亡（撕卡）是终态：任何身体状态 chip 都不再受理 */
    if (st.body === '死亡') {
      return { toast: '已标记「死亡」（撕卡）—— 不可再修改身体状态' };
    }
    if (chip === '重伤' || chip === '濒死' || chip === '昏迷') {
      if (chip === '重伤') {
        if (st.body === '重伤') return { toast: '不能自行取消「重伤」—— ' + REFUSE };
        st.body = '重伤';
        return { toast: '' };
      }
      var key = (chip === '濒死') ? 'dying' : 'unconscious';
      if (st[key] === true) {
        return { toast: '不能自行取消「' + chip + '」—— ' + REFUSE };
      }
      st[key] = true;
      /* 点「濒死」时若未勾「重伤」→ 自动勾上（濒死以重伤为前提） */
      if (chip === '濒死' && st.body !== '重伤') st.body = '重伤';
      return { toast: '' };
    }
    if (chip === '正常' || chip === '轻伤') {
      if (bodyWounded(st)) {
        return { toast: '处于「重伤 / 濒死 / 昏迷」时不能改回「' + chip + '」—— ' + REFUSE };
      }
      st.body = chip;
      st.dying = false;
      st.unconscious = false;
      return { toast: '' };
    }
    return { toast: '' };
  }

  function statusSheet(c, onDone) {
    /* ============================================================
     * v2.1.10（用户第 3 项）：状态管理改为**草稿制**。
     *
     * 旧行为：面板里的每个输入框 oninput 直接写真实角色卡（c.status / c.sanLoss /
     *   c.madness），且顺手 scheduleSave —— 于是「输入 HP=0 → 直接退出」也会被
     *   存成 HP=0 但没走撕卡判定；任何一次自动保存都会把这个中间态落库。
     *
     * 新行为：面板内所有改动只写**草稿 W**（真实角色卡的深拷贝），
     *   点「保存状态」才是唯一写回点（见下方 commit）；关掉面板 = 全部放弃。
     * ============================================================ */
    var W = (function () {
      try { return JSON.parse(JSON.stringify(c)); } catch (e) { return c; }
    })();
    Engine.recalc(W);
    var st = W.status, d = W.derivedStats;
    var host = h('div');

    /* ============================================================
     * v2.1.9（用户第 2 项）：车卡状态管理 —— 撕卡判定**移到「保存状态」+ 玩家确认后生效**。
     *
     * 旧行为（v2.1.7）：HP/SAN 输入为 0、或 SAN 上限减损到 0 时**立即**把
     *   st.body 改「死亡」/ st.mental 改「永久疯狂」并 toast。用户实测：
     *   只想删掉旧数字重输，就会在输入过程中被误判撕卡。
     *
     * 新行为：
     *   · 输入路径**只提示、不改状态**（见 pendingRipHint / paintRipWarn）；
     *   · 点「保存状态」时**统一判定**，命中则弹 UI.confirm 二次确认，
     *     **玩家确认后**才写入撕卡并保存；取消则什么都不写。
     *   · 掷骰减损 SAN 上限到 0 的路径（applyLoss）保留原有二次确认弹窗语义。
     * ============================================================ */
    var ripWarnHost = h('div');

    /** 计算「保存时是否会撕卡」的判定要素（不修改任何状态） */
    function ripPending() {
      var mental = Array.isArray(st.mental) ? st.mental : (st.mental ? [String(st.mental)] : []);
      var hpDown = (st.currentHP | 0) <= 0 || (st.maxHP | 0) <= 0;
      var sanDown = (st.currentSAN | 0) <= 0 || (st.maxSAN | 0) <= 0;
      var flagged = st.body === '死亡' || mental.indexOf('永久疯狂') >= 0;
      return { hit: hpDown || sanDown || flagged, hpDown: hpDown, sanDown: sanDown, flagged: flagged };
    }

    /** 输入路径的提示：命中撕卡条件时给出「保存状态时将判定」的文案（不改状态） */
    function pendingRipHint() {
      Engine.recalc(W);
      var p = ripPending();
      if (p.hpDown && p.sanDown) return '当前 HP 与 SAN（或其上限）已达 0 —— 保存状态时将判定是否撕卡';
      if (p.hpDown) return '当前 HP（或其上限）已达 0 —— 保存状态时将判定是否撕卡（死亡）';
      if (p.sanDown) return '当前 SAN（或其上限）已达 0 —— 保存状态时将判定是否撕卡（永久疯狂）';
      if (p.flagged) return '已标记「死亡 / 永久疯狂」—— 保存状态时将写入撕卡';
      return '';
    }

    /** 重绘「保存时将撕卡」的提示区（输入路径调用，绝不改状态） */
    function paintRipWarn() {
      if (!ripWarnHost) return;
      UI.clear(ripWarnHost);
      var w = pendingRipHint();
      if (w) ripWarnHost.appendChild(h('div.help', { text: '⚠ ' + w, style: { color: 'var(--danger)' } }));
    }
    function numField(label, key, max, touched) {
      var el = UI.input({
        type: 'number', value: st[key],
        oninput: function () {
          /* v2.1.8（用户第 3 项）：**清空输入 ≠ 0**。用户清掉旧数字只是想重输，
             此时什么都不提交、保持上一个有效值；只有真输入了合法数字（含 0）才写模型。 */
          var raw = String(el.value == null ? '' : el.value).trim();
          UI.clear(hint);
          if (raw === '') {
            hint.appendChild(h('div.help', { text: '取值 0 - ' + max }));
            return;
          }
          var n = parseInt(raw, 10);
          if (!isFinite(n)) {
            hint.appendChild(h('div.help', { text: '请输入数字（0 - ' + max + '）' }));
            return;
          }
          st[key] = Engine.clamp(n, 0, max);
          st[touched] = true;
          hint.appendChild(h('div.help', { text: '取值 0 - ' + max }));
          paintRipWarn();   /* v2.1.9（用户第 2 项）：输入只提示，不撕卡 */
        }
      });
      return UI.field(label, el, { help: '上限 ' + max });
    }

    var hint = h('div');
    host.appendChild(h('div.grid2', null, [
      numField('当前生命 HP', 'currentHP', d.maxHP, '_hpTouched'),
      numField('当前魔法 MP', 'currentMP', d.maxMP, '_mpTouched')
    ]));

    /* 理智的上限 = 意志 POW − 永久减损。v2.1.5（用户第 1 项）：当前 SAN **不得超过**
       这个上限 —— 旧实现允许突破（硬夹 99），会出现「60/59」的矛盾显示。 */
    var sanEl = UI.input({
      type: 'number', value: st.currentSAN,
      oninput: function () {
        /* v2.1.8（用户第 3 项）：同 numField —— 清空/非数字不提交，保持上一有效值。 */
        var raw = String(sanEl.value == null ? '' : sanEl.value).trim();
        UI.clear(sanHint);
        if (raw === '') {
          paintSanHint();
          return;
        }
        var n = parseInt(raw, 10);
        if (!isFinite(n)) {
          paintSanHint();
          return;
        }
        st.currentSAN = Engine.clamp(n, 0, st.maxSAN);
        st._sanTouched = true;
        paintSanHint();
        paintRipWarn();   /* v2.1.9（用户第 2 项）：输入只提示，不撕卡 */
      }
    });
    var mythosCap = (W.sanMythosCap === undefined || W.sanMythosCap === null) ? 99 : W.sanMythosCap;
    var sanHint = h('div');
    function paintSanHint() {
      UI.clear(sanHint);
      var base = (W.baseMaxSAN === undefined || W.baseMaxSAN === null) ? st.maxSAN : W.baseMaxSAN;
      var loss = W.sanLoss || 0;
      var txt = '当前 SAN ' + st.currentSAN + ' / 上限 ' + st.maxSAN;
      if (loss > 0) txt += '（意志 ' + base + ' − 永久减损 ' + loss + '）';
      else txt += '（= 意志 POW）';
      if (mythosCap < st.maxSAN) txt += '　·　神话硬上限 ' + mythosCap;
      sanHint.appendChild(h('div.help', { text: txt }));
    }
    paintSanHint();
    host.appendChild(h('div', null, [
      UI.field('当前理智 SAN', sanEl),
      sanHint
    ]));

    /* ---------- 理智上限的永久减损 ----------
       施放神话法术、与克苏鲁神话生物接触都会永久削掉一部分 SAN 上限
       （规则书：-1D5 / -1D10）。这里让玩家直接填减损总量，
       不用每次去掷骰 —— 掷出来的数字填进来即可。 */
    /* v2.1.6（用户验收 ·「减到 0 没有回退选项」）：
       ① 打开状态管理时快照减损值，「↩ 回退」按钮一键恢复（不依赖弹窗）；
       ② 手动填写归零时同样给提示（此前只有掷骰路径有）。 */
    var sheetStartLoss = W.sanLoss || 0;
    var lossEl = UI.input({
      type: 'number', id: 'sanLossInput', value: W.sanLoss || 0,
      oninput: function () {
        W.sanLoss = Engine.clamp(parseInt(lossEl.value, 10), 0, 99);
        Engine.recalc(W);
        paintSanHint();
        paintMaxPreview();
        if (st.maxSAN <= 0) {
          /* v2.1.9（用户第 2 项）：手动把上限减到 0 **只提示、不撕卡** ——
             保存状态时再统一判定；想反悔可点下方「↩ 回退减损」恢复上限。 */
          UI.toast('SAN 上限已归零 —— 可点下方「↩ 回退减损」恢复；保存状态时将判定是否撕卡', 'warn', 4200);
        }
        paintRipWarn();
      }
    });
    function paintMaxPreview() {
      UI.clear(lossHint);
      var base = (W.baseMaxSAN === undefined || W.baseMaxSAN === null) ? d.maxSAN : W.baseMaxSAN;
      lossHint.appendChild(h('div.help', {
        text: '当前上限 ' + st.maxSAN + '　=　意志 ' + base +
              (W.sanLoss ? ' − 减损 ' + W.sanLoss : '（无减损）') +
              (W.sanLoss >= base ? '　·　已触底：上限为 0' : '')
      }));
    }
    var lossHint = h('div');
    paintMaxPreview();
    host.appendChild(h('div', null, [
      UI.field('SAN 上限永久减损', lossEl, {
        help: '施放神话法术 / 接触克苏鲁生物后，把掷到的减损值（1-5 / 1-10 等）填在这里'
      }),
      lossHint
    ]));
    /* ---------- 快速掷减损 ----------
       规则书里「永久削掉 SAN 上限」的常见骰型是 1D3 / 1D4 / 1D6 / 1D8 / 1D10，
       再配一个自由输入的 1DX（应付 2D6、1D20 这类规则外的场合）。
       点一下按钮就是「掷一次、把结果累加进减损总量」，
       而不是「设成某个数」—— 因为一场团里可能被削好几次。 */
    var lossDice = [3, 4, 6, 8, 10];
    function rollDice(sides) {
      var n = Math.max(1, Math.min(1000, parseInt(sides, 10) || 0));
      return 1 + Math.floor(Math.random() * n);
    }
    function applyLoss(delta, label) {
      var before = W.sanLoss || 0;
      W.sanLoss = Engine.clamp(before + delta, 0, 99);
      Engine.recalc(W);
      lossEl.value = W.sanLoss;
      paintSanHint(); paintMaxPreview();
      var capAfter = st.maxSAN;
      /* v2.1.9（用户第 2 项）：这条「掷骰减损到 0」的路径**保留原有的二次确认弹窗语义** ——
         玩家选「保留」→ 撕卡（永久疯狂）；选「回退这次掷骰」→ 恢复上限、不撕卡。
         （注意：撕卡只在玩家选择保留时才写入，不再像旧版那样先撕再问。） */
      if (capAfter <= 0 && before < 99) {
        UI.toast('⚠️ SAN 上限已减损到 0 —— 点「↩ 回退减损」可一键恢复', 'warn', 4200);
        UI.confirm('⚠️ SAN 上限已被减损到 0（理智上限归零）。\n这通常意味着角色已被永久逼疯。\n\n是否回退这次掷骰？', {
          danger: true, okText: '回退这次掷骰', cancelText: '保留（不推荐）'
        }).then(function (rollback) {          if (rollback) {
            W.sanLoss = sheetStartLoss;
            Engine.recalc(W);
            lossEl.value = W.sanLoss;
            paintSanHint(); paintMaxPreview();
            paintRipWarn();
            UI.toast('已回退，SAN 上限恢复到 ' + st.maxSAN, 'ok', 2600);
            return;
          }
          /* 玩家选择「保留」→ 写入撕卡（永久疯狂） */
          st.mental = ['永久疯狂'];
          Engine.recalc(W);
          paintRipWarn();
          UI.toast('☠ SAN 上限归零 —— 永久疯狂（撕卡）', 'err', 4200);
        });
      }
      UI.toast((label || '减损') + ' +' + delta + '　→　上限 ' + st.maxSAN, 'ok', 2600);
      paintRipWarn();
    }

    var diceRow = h('div.row.wrap', { style: { gap: '7px', marginTop: '-4px' } });
    lossDice.forEach(function (sides) {
      diceRow.appendChild(h('button.btn.sm', {
        text: '🎲 1D' + sides,
        title: '掷一次 1D' + sides + '，结果累加进永久减损',
        onclick: function () { applyLoss(rollDice(sides), '1D' + sides); }
      }));
    });
    host.appendChild(diceRow);

    /* 自定义 1DX：X 由玩家自己填，应付规则书里没列全的骰型 */
    var customEl = UI.input({
      type: 'number', id: 'sanLossDiceSides', value: 100, min: '2', max: '1000',
      style: { width: '72px' }
    });
    host.appendChild(h('div.row.wrap', { style: { gap: '7px', alignItems: 'center' } }, [
      h('span.small', { text: '自定义' }),
      h('span.small', { text: '1D' }),
      customEl,
      h('button.btn.sm', {
        text: '🎲 掷',
        onclick: function () {
          var sides = parseInt(customEl.value, 10);
          if (!(sides >= 2)) { UI.toast('请填一个 ≥2 的面数', 'warn'); return; }
          applyLoss(rollDice(sides), '1D' + sides);
        }
      }),
      h('button.btn.sm', {
        text: '↩ 回退减损',
        title: '撤销本次打开状态管理以来的全部减损改动（回到打开时的值）',
        onclick: function () {
          W.sanLoss = Engine.clamp(sheetStartLoss, 0, 99); Engine.recalc(W);
          lossEl.value = W.sanLoss; paintSanHint(); paintMaxPreview();
          paintRipWarn();
          UI.toast('已回退减损到 ' + W.sanLoss + '（上限 ' + st.maxSAN + '）', 'ok', 2600);
        }
      }),
      h('button.btn.sm', {
        text: '↺ 清除减损',
        onclick: function () {
          W.sanLoss = 0; Engine.recalc(W);
          lossEl.value = 0; paintSanHint(); paintMaxPreview();
          paintRipWarn();
          UI.toast('已清除 SAN 上限永久减损', 'ok', 2000);
        }
      })
    ]));

    host.appendChild(numField('当前幸运 LUCK', 'currentLuck', 99, '_luckTouched'));

    /* 精神状态：**多选**。
       规则上这些状态可以叠加 —— 背景自带的永久疯狂 + 游戏中新掷出的临时/不定疯狂。
       「正常」是互斥项（选它清空其余）；v2.1.5 起「永久疯狂」也改为互斥项（撕卡级），
       「疯狂症状」是**派生项**：由是否持有具体症状（恐惧症/狂躁症）自动决定。 */
    function mentalSelect() {
      var NORMAL = (R.mentalNormal || '正常');
      var SYMPTOM = (R.mentalSymptom || '疯狂症状');
      var PERMANENT = (R.mentalPermanent || '永久疯狂');
      var armedPermanent = false;   /* v2.1.6：永久疯狂的行内两段式确认态 */
      var opts = (R.mentalStatus || [NORMAL]).slice();
      var row = h('div.row.wrap', { style: { gap: '7px' } });
      var chips = {};

      function commit() {
        var list = Store.mentalList(W);
        W.status.mental = list.slice();
        Engine.recalc(W);
       
      }
      function repaint() {
        var list = Store.mentalList(W);
        opts.forEach(function (o) {
          var btn = chips[o];
          if (!btn) return;
          /* 「疯狂症状」的亮灭由症状是否持有派生，不由 mental 数组里有没有它决定 */
          if (o === SYMPTOM) {
            var has = global.CocMadness && global.CocMadness.list(W).length > 0;
            if (has) btn.classList.add('on'); else btn.classList.remove('on');
            return;
          }
          if (list.indexOf(o) >= 0) btn.classList.add('on');
          else btn.classList.remove('on');
        });
      }

      opts.forEach(function (o) {
        var btn = h('button.chip', {
          text: o, 'data-mental': o,
          onclick: function () {
            /* 「疯狂症状」是派生项，不靠点 —— 点了给解释 */
            if (o === SYMPTOM) {
              var hasNow = global.CocMadness && global.CocMadness.list(W).length > 0;
              UI.toast(hasNow
                ? '「疯狂症状」由下方持有的症状自动生成；移除症状即可取消'
                : '当前没有具体症状。请先在下方「疯狂状态」里掷/添加症状', 'warn', 3000);
              return;
            }
            var list = Store.mentalList(W);
            if (o === NORMAL) {
              list = [NORMAL];
            } else if (o === PERMANENT) {
              /* 「永久疯狂」互斥 —— 选了只留它一项；再点取消。
                 v2.1.6：改**行内两段式**确认（第一次点变「⚠ 确认永久疯狂？」），
                 弹窗版用户实测确认后状态未生效，行内版所见即所得。 */
              if (armedPermanent) {
                armedPermanent = false;
                btn.textContent = o;
                btn.classList.remove('on');
                W.status.mental = [PERMANENT];
                commit(); repaint(); 
                return;
              }
              if (list.indexOf(PERMANENT) >= 0) {
                list = list.filter(function (x) { return x !== PERMANENT; });
                if (!list.length) list = [NORMAL];
                W.status.mental = list; commit(); repaint(); 
                return;
              }
              armedPermanent = true;
              btn.classList.add('on');
              btn.textContent = '⚠ 确认永久疯狂？';
              return;
            } else if (list.indexOf(o) >= 0) {
              list = list.filter(function (x) { return x !== o; });
              if (!list.length) list = [NORMAL];
            } else {
              list = list.filter(function (x) { return x !== NORMAL && x !== PERMANENT; });
              list.push(o);
            }
            W.status.mental = list;
            commit();
            repaint();
          }
        });
        chips[o] = btn;
        row.appendChild(btn);
      });

      repaint();
      return UI.field('精神状态（可多选）', row, {
        help: '「疯狂症状」由持有的症状自动生成；「永久疯狂」与「正常」为互斥项'
      });
    }

    /* v2.10.0（身体状态模型）：身体状态**复选 chips** 面板。
       · 正常 / 轻伤 —— 单选互斥；
       · 重伤 / 濒死 / 昏迷 —— 复选可叠加，已勾选的不可自行取消；
       · 昏迷或濒死时整行置灰，仅「死亡」可点；
       · 死亡 —— 行内两段式确认（v2.1.6 行为原样保留）。
       迁移 / 禁用矩阵用模块级纯函数 bodyChipNext / bodyChipDisabled（有单测）。 */
    function bodySelect() {
      var opts = ['正常', '轻伤', '重伤', '濒死', '昏迷', '死亡'];
      var row = h('div.row.wrap', { style: { gap: '7px' } });
      var chips = {};
      var armedDeath = false;   /* 「死亡」行内两段式确认态（v2.1.6） */

      function isOn(o) {
        if (o === '死亡') return st.body === '死亡';
        if (o === '重伤') return st.body === '重伤';
        if (o === '濒死') return st.dying === true;
        if (o === '昏迷') return st.unconscious === true;
        return st.body === o;   /* 正常 / 轻伤 */
      }

      function paint() {
        opts.forEach(function (o) {
          var btn = chips[o];
          if (!btn) return;
          if (isOn(o)) btn.classList.add('on'); else btn.classList.remove('on');
          /* 禁用矩阵：disabled 阻断交互，.off 类复用既有置灰样式（不新造 CSS） */
          var dis = bodyChipDisabled(st, o);
          btn.disabled = dis;
          if (dis) btn.classList.add('off'); else btn.classList.remove('off');
          /* 「死亡」的两段式确认态：armed 时显示确认文案并高亮 */
          if (o === '死亡' && armedDeath) {
            btn.textContent = '⚠ 确认死亡？';
            btn.classList.add('on');
          } else {
            btn.textContent = o;
          }
        });
      }

      opts.forEach(function (o) {
        var btn = h('button.chip', {
          text: o, 'data-body': o,
          onclick: function () {
            if (o === '死亡') {
              /* v2.1.6：行内两段式确认 —— 第一次点变「⚠ 确认死亡？」，再点才生效。
                 弹窗版用户实测「确认后状态没生效」，行内版所见即所得。 */
              if (!armedDeath) {
                armedDeath = true;
                paint();
                return;
              }
              armedDeath = false;
              st.body = '死亡';
              Engine.recalc(W);
              paint();
              paintRipWarn();
              UI.toast('已标记为「死亡」—— 保存状态后将判定撕卡（不可逆）', 'err', 3600);
              return;
            }
            armedDeath = false;   /* 点别的 chip 先解除死亡待确认 */
            var r = bodyChipNext(st, o);
            Engine.recalc(W);
            paint();
            paintRipWarn();
            if (r.toast) UI.toast(r.toast, 'warn', 3200);
          }
        });
        chips[o] = btn;
        row.appendChild(btn);
      });

      paint();
      return UI.field('身体状态（可多选）', row, {
        help: '「正常/轻伤」单选；「重伤/濒死/昏迷」可叠加，需治愈伤势或队友 / KP 施救才能取消；「死亡」连点两次确认'
      });
    }

    /* 身体状态：v2.10.0（身体状态模型）复选 chips。
       「正常/轻伤」单选互斥；「重伤/濒死/昏迷」复选可叠加；「死亡」行内两段式确认。 */
    host.appendChild(bodySelect());

    /* 精神状态：**多选** —— 规则允许叠加。
       背景自带的永久疯狂 + 游戏里新掷出的临时/不定疯狂是同时存在的。
       「正常」是互斥项：选它就清空其余，选其余就摘掉它。 */
    host.appendChild(mentalSelect());

    /* ---------- 疯狂状态 ----------
       v2.1.9（用户第 3 项）：掷「疯狂发作」走**疯狂表 1D10** ——
       1-8 为即时发作症状（失忆 / 假性残疾 / 暴力倾向 / …），9 落到 100 条恐惧症表、
       10 落到 100 条狂躁症表。每条临时症状带 1-10 轮的持续时间。
       临时疯狂会随轮次消退（下方的「推进 1 轮」），永久疯狂不会、只能手动删。 */
    var MAD = global.CocMadness;
    var madHost = h('div');
    function paintMadness() {
      UI.clear(madHost);
      var arr = MAD.list(W);
      if (!arr.length) {
        madHost.appendChild(UI.emptyState('🧠', '当前没有疯狂状态', '掷一个临时或永久疯狂试试'));
      } else {
        arr.forEach(function (m) {
          var row = h('div.occ-item', {
            style: { alignItems: 'flex-start' }
          }, [
            h('div.grow', null, [
              h('div.nm', { html: escapeHtml(global.CocMadness.labelOf(m.type)) + '　<b>' + escapeHtml(m.name) + '</b>' }),
              h('div.meta', { text: m.desc || '' }),
              /* v2.1.7（用户第 2 项）：背景来源的恐惧症/狂躁症标「背景症状」，
                 不再误标「永久」（永久疯狂=撕卡级，与背景症状是两回事）。 */
              h('div.meta', { style: { marginTop: '3px' },
                text: m.permanent
                  ? (m.bg ? '背景症状 · 与生俱来，不会自行消退' : '永久疯狂 · 不会自行消退')
                  : ('临时疯狂 · 还剩 ' + m.rounds + ' 轮') })
            ]),
            h('button.sbtn.minus', {
              title: '删除这条疯狂状态',
              onclick: function () {
                MAD.remove(W, m.id);
                Engine.recalc(W);
                paintMadness(); 
                UI.toast('已移除：' + m.name, 'ok', 2000);
              }
            }, [h('span', { text: '✕' })])
          ]);
          madHost.appendChild(row);
        });
      }
    }
    function escapeHtml(s) { return UI.esc(String(s == null ? '' : s)); }

    /** 手动从症状表里挑一条（不掷骰） */
    function pickSymptom(permanent) {
      var list = h('div', { style: { maxHeight: '46vh', overflow: 'auto' } });
      var kw = '';
      var search = UI.input({ placeholder: '搜索症状名 / 英文名…', oninput: function () { kw = search.value; paint(); } });
      function paint() {
        UI.clear(list);
        var all = MAD.phobias().concat(MAD.manias());
        var l = all.filter(function (x) {
          if (!kw) return true;
          return ((x.name + ' ' + (x.en || '') + ' ' + (x.desc || '')).toLowerCase()).indexOf(kw.toLowerCase()) >= 0;
        });
        if (!l.length) { list.appendChild(UI.emptyState('🔍', '没有匹配的症状')); return; }
        l.slice(0, 120).forEach(function (x) {
          list.appendChild(h('button.occ-item', {
            html: '<div class="grow"><div class="nm">' + UI.esc(global.CocMadness.labelOf(x.type)) +
                  '　' + UI.esc(x.name) + '</div><div class="meta">' + UI.esc(x.desc || '') + '</div></div>',
            onclick: function () {
              var m = MAD.make(x.type, x, permanent);
              MAD.add(W, m);
              Engine.recalc(W);
              UI.closeAllSheets();
              paintMadness(); 
              UI.toast('已添加：' + m.name + (m.permanent ? '（永久）' : '（' + m.rounds + ' 轮）'), 'ok', 2600);
            }
          }));
        });
      }
      paint();
      UI.sheet({
        title: (permanent ? '添加永久疯狂' : '添加临时疯狂') + '　·　共 ' + MAD.size + ' 条症状',
        body: h('div', null, [search, h('div', { style: { height: '8px' } }), list])
      });
    }

    paintMadness();
    host.appendChild(h('div.card', { style: { marginTop: '14px' } }, [
      h('div.card-title', { text: '疯狂状态（疯狂发作 / 恐惧症 / 狂躁症）' }),
      h('div.tiny.dim', { style: { marginBottom: '10px', lineHeight: '1.75' }, text:
        '掷 1D10：1-8 为即时发作症状、9 从 100 条恐惧症表、10 从 100 条狂躁症表。临时疯狂会随轮次自行消退，永久疯狂不会。' }),
      madHost,
      h('div.btn-group', { style: { marginTop: '11px' } }, [
        h('button.btn.primary.sm.grow', { text: '🎲 掷临时疯狂', onclick: function () {
          var m = MAD.roll('any', false);
          if (!m) { UI.toast('症状表未加载', 'err'); return; }
          MAD.add(W, m); Engine.recalc(W);
          paintMadness(); 
          UI.toast('【' + global.CocMadness.labelOf(m.type) + '】' + m.name + '　持续 ' + m.rounds + ' 轮', 'ok', 3200);
        } }),
        /* v2.1.5（用户第 1 项）：原「💀 掷永久疯狂」概念有误 —— 永久疯狂不是掷出来的，
           而是 SAN 归零后的判定结果。这里就是「掷疯狂状态」：从症状表随机掷一个
           疯狂发作症状（临时，持续 1D10 轮）。 */
        h('button.btn.sm.grow', { text: '🎲 掷疯狂状态', onclick: function () {
          var m = MAD.roll('any', false);
          if (!m) { UI.toast('症状表未加载', 'err'); return; }
          MAD.add(W, m); Engine.recalc(W);
          paintMadness(); 
          UI.toast('【' + global.CocMadness.labelOf(m.type) + '】' + m.name + '　持续 ' + m.rounds + ' 轮', 'ok', 3200);
        } }),
        h('button.btn.sm.ghost', { text: '＋ 手动', onclick: function () { pickSymptom(false); } })
      ]),
      h('div.btn-group', { style: { marginTop: '8px' } }, [
        h('button.btn.sm.grow', { text: '⏩ 推进 1 轮', title: '所有临时疯狂倒计时 1 轮，到期的自动消退', onclick: function () {
          var faded = MAD.advance(W, 1);
          Engine.recalc(W);
          paintMadness(); 
          UI.toast(faded.length
            ? ('推进 1 轮，' + faded.length + ' 条临时疯狂已消退：' + faded.map(function (x) { return x.name; }).join('、'))
            : '推进 1 轮，没有临时疯狂到期', faded.length ? 'ok' : null, 3200);
        } }),
        h('button.btn.sm.ghost', { text: '＋ 永久', title: '手动添加一条永久疯狂', onclick: function () { pickSymptom(true); } }),
        h('button.btn.sm.ghost', { text: '🗑 清空', onclick: function () {
          if (!MAD.list(W).length) { UI.toast('本来就没有疯狂状态', null); return; }
          UI.confirm('清空全部疯狂状态？\n当前有 ' + MAD.list(W).length + ' 条。', { danger: true, okText: '清空' })
            .then(function (ok) {
              if (!ok) return;
              MAD.clear(W); Engine.recalc(W);
              paintMadness(); 
              UI.toast('已清空', 'ok');
            });
        } })
      ])
    ]));

    host.appendChild(UI.notice('HP 归零且未重伤为「昏迷」；HP 归零且受重伤为「濒死」。SAN 为 0 即永久疯狂。', null, '◈'));
    host.appendChild(h('div.help', {
      style: { marginTop: '6px' },
      text: '本页所有改动先存在草稿里 —— 点下方「保存状态」才会写入角色卡；直接关闭等于放弃。'
    }));
    host.appendChild(ripWarnHost);
    paintRipWarn();
    /* v2.1.9（用户第 2 项）：「保存状态」= **统一判定撕卡** 的唯一入口。
       命中 HP/SAN（或其上限）归零、或已标记死亡 / 永久疯狂 → 弹二次确认；
       玩家确认后才写入撕卡并保存，取消则什么都不写。 */
    host.appendChild(h('button.btn.primary.block', {
      text: '保存状态', onclick: function () {
        Engine.recalc(W);
        var p = ripPending();
        /* v2.1.10（用户第 3 项）：草稿 → 真实角色卡的**唯一写回点** */
        function commit() {
          var nums = ['currentHP', 'maxHP', 'currentMP', 'maxMP', 'currentSAN', 'maxSAN', 'currentLuck',
                      'body', 'dying', 'unconscious',
                      '_hpTouched', '_mpTouched', '_sanTouched', '_luckTouched'];
          c.status = c.status || {};
          nums.forEach(function (k) { if (W.status[k] !== undefined) c.status[k] = W.status[k]; });
          c.status.mental = (W.status.mental || []).slice();
          c.madness = JSON.parse(JSON.stringify(W.madness || []));
          c.sanLoss = W.sanLoss;
          Engine.recalc(c); Store.scheduleSave();
          if (onDone) onDone();          /* 只有真正落库时才通知上层重绘 */
        }
        if (!p.hit) {
          commit(); sh.close();
          UI.toast('状态已更新', 'ok');
          return;
        }
        var reasons = [];
        if (p.hpDown) reasons.push('HP（或其上限）归零 → 死亡');
        if (p.sanDown) reasons.push('SAN（或其上限）归零 → 永久疯狂');
        if (!p.hpDown && !p.sanDown) reasons.push('已标记「死亡 / 永久疯狂」');
        UI.confirm('保存后角色将被判定撕卡（不可逆）：\n· ' + reasons.join('\n· ') +
          '\n\n确定要撕掉这张角色卡吗？',
          { danger: true, okText: '确认撕卡', cancelText: '取消' })
          .then(function (ok) {
            if (!ok) { UI.toast('已取消，未保存撕卡判定', 'warn', 2800); return; }
            if (p.hpDown) st.body = '死亡';
            if (p.sanDown) st.mental = ['永久疯狂'];
            commit(); sh.close();
            UI.toast('☠ 已判定撕卡：' +
              (p.hpDown && p.sanDown ? '死亡 + 永久疯狂' : p.hpDown ? '死亡' : '永久疯狂'), 'err', 3600);
          });
      }
    }));
    host.appendChild(h('button.btn.ghost.block', {
      text: '放弃修改', style: { marginTop: '8px' },
      onclick: function () {
        sh.close();
        UI.toast('已放弃修改，角色卡保持原样', 'ok', 2400);
      }
    }));
    var sh = UI.sheet({ title: '状态管理', body: host });
  }

  /* ============================================================
   * 角色卡页
   * ============================================================ */
  function renderCard(ruleSystemId, id) {
    route = { name: 'card' };
    stepperEl.style.display = 'none';
    barEl.style.display = 'none';

    var st = Store.getState();
    // 兼容两种写法：按角色 id，或按分享 id（旧链接 / 外部分享过的地址里可能只有 shareId）
    var c = st.characters[id] ||
            Object.keys(st.characters).map(function (k) { return st.characters[k]; })
              .filter(function (x) { return x && x.shareId === id; })[0] ||
            (st.draft && (st.draft.id === id || st.draft.shareId === id) ? st.draft : null);
    if (!c) {
      UI.clear(viewEl);
      viewEl.appendChild(UI.emptyState('✕', '找不到这张角色卡', '链接可能已失效'));
      viewEl.appendChild(h('button.btn.primary.block', { text: '返回首页', onclick: function () { go('#/'); } }));
      return;
    }
    // 用真实 id 打开（shareId 进来时也能正常落到 state.characters 上）
    Store.loadCharacter(c.id);
    c = Store.getState().current;
    Engine.recalc(c);

    UI.clear(viewEl);
    var host = h('div');
    /* v2.1.6：撕卡的卡**只读** —— 不给状态管理入口（状态已定不可改）、禁编辑。 */
    var ripped = isRippedCard(c);
    /* 状态管理入口内嵌在角色卡的「状态」卡片里（跑团时要随时改 HP/SAN，
       放在页面上方比压在页面底端顺手）；这里把回调传进去。 */
    global.SheetView.render(host, c, ripped ? {} : {
      onStatusEdit: function () { statusSheet(c, function () { renderCard(ruleSystemId, id); }); }
    });
    if (ripped) {
      viewEl.appendChild(h('div.card', { style: { border: '1px solid #c0392b', marginTop: '10px' } }, [
        h('div.card-title', { text: '☠ 该调查员已撕卡' }),
        h('div.tiny.dim', { text: '身体状态为「死亡」或已「永久疯狂」。撕卡不可撤销：角色数据仅可浏览，不能再编辑或管理状态（可删除此卡）。' })
      ]));
    }
    viewEl.appendChild(host);

    var mine = st.characters[c.id] || (st.draft && st.draft.id === c.id);
    // 两列网格：按钮文字不会被压到溢出边框，也不会排成一长条
    viewEl.appendChild(h('div.btn-group.cols2', { style: { marginTop: '14px' } }, [
      h('button.btn.ghost', { text: '← 返回', onclick: function () { history.length > 1 ? history.back() : go('#/'); } }),
      h('button.btn.teal', { text: '🖼 生成图片', onclick: function () { global.SheetView.exportImage(c); } }),
      mine && !ripped ? h('button.btn.primary', {
        text: '✎ 编辑角色',
        // 走编辑会话：给的是副本，改完必须手动保存才写回这张卡
        onclick: function () { startEdit(c.id); }
      }) : null,
      mine ? h('button.btn.primary', {
        text: '☁ 分享',
        onclick: function () { global.ShareUI.quickShare(c, function () { renderCard(ruleSystemId, id); }); }
      }) : null
    ]));
    if (mine) {
      viewEl.appendChild(h('button.btn.danger.block', {
        text: '🗑 删除该角色', style: { marginTop: '9px' },
        onclick: function () {
          UI.confirm('删除「' + (c.characterName || '未命名') + '」？', { danger: true, okText: '删除' }).then(function (ok) {
            if (!ok) return;
            Store.deleteCharacter(c.id); go('#/my');
          });
        }
      }));
    }
  }

  /* ============================================================
   * 跑团房间
   *
   * 房间是**独立路由页**，不是弹层：弹层会在切走时被清掉，而房间要一直
   * 保持 WebSocket 连接（玩家翻回首页看一眼角色卡不该掉线）。
   * 所以这里把主视图整块换掉，连接活在 RoomUI 的会话对象里。
   * ============================================================ */
  function enterRoom(code) {
    if (!global.RoomUI) {
      UI.toast('房间模块未加载', 'err');
      goHome();
      return;
    }
    route = { name: 'room', code: code || '' };
    stepperEl.style.display = 'none';
    barEl.style.display = 'none';
    /* v2.0.10（用户第 5 项）：隐藏 App 顶栏 —— .appbar 是 sticky+z-index:60，而游戏页
       .game-page 只有 z-index:5，不隐藏就会把 .gp-topbar 压在下面（看不见、点不到）。 */
    if (appBarEl) appBarEl.style.display = 'none';
    UI.clear(viewEl);
    viewEl.appendChild(global.RoomUI.render(code || ''));
  }

  /* ============================================================
   * 路由
   * ============================================================ */
  function go(hash) {
    // 目标 hash 与当前相同时浏览器不会触发 hashchange，
    // 于是「点菜单里的首页」在已经处于 #/ 的场景下毫无反应。
    // 这里手动补一次路由。
    if (location.hash === hash) { onRoute(); return; }
    location.hash = hash;
  }

  function onRoute() {
    /* 自愈：只要发生了路由切换，说明用户已经离开了当前页面，
       此时不该还残留着弹层或滚动锁。历史上「关弹层时顺手把遮罩节点删掉」
       这类写法会漏掉 close()，导致 html/body 永久带 .scroll-locked，
       表现就是整个页面划不动、切步骤与返回首页全部失效。
       这里兜底清一次，保证「页面卡住」这种最糟的情况不会真的发生。 */
    if (UI.forceUnlockScroll && UI.forceUnlockScroll()) {
      console.warn('检测到残留的弹层/滚动锁，已自动解锁');
    }

    var hash = location.hash.replace(/^#/, '') || '/';
    var parts = hash.split('/').filter(Boolean);

    /* v2.0.10：离开房间路由 → 恢复 App 顶栏（进入房间时由 enterRoom 隐藏）。 */
    if (appBarEl) appBarEl.style.display = (parts[0] === 'room') ? 'none' : '';

    if (parts[0] === 'create') {
      enterCreateRoute();
    } else if (parts[0] === 'my') {
      /* v2.1.10（用户第 1 项）：#/my = 未撕卡；#/my/ripped = 英灵殿 */
      renderMine(parts[1] || '');
    } else if (parts[0] === 'card' && parts[2]) {
      renderCard(parts[1], parts[2]);
    } else if (parts[0] === 'room') {
      enterRoom(parts[1] || '');
    } else if (parts[0] === 'settings') {
      renderHome(); settingsSheet();
    } else {
      route = { name: 'home' };
      renderHome();
    }
  }

  /* ============================================================
   * 对外 API
   * ============================================================ */
  global.App = {
    viewSheet: function (c) {
      Engine.recalc(c);
      var host = h('div');
      function paint() {
        UI.clear(host);
        global.SheetView.render(host, c, {
          onStatusEdit: function () { statusSheet(c, paint); }
        });
      }
      paint();
      UI.sheet({
        title: '角色卡预览',
        body: host,
        headExtra: h('button.btn.sm.teal', { text: '🖼 图片', onclick: function () { global.SheetView.exportImage(c); } })
      });
    },
    exportImage: function (c) { global.SheetView.exportImage(c); },
    /** 回到首页（完成角色卡后跳转用） */
    goHome: goHome,
    /** 新建空白角色卡（首页/菜单/我的角色共用） */
    newCharacter: createNewCharacter,
    /** 打开 AI 车卡面板（菜单里那一项） */
    aiCreate: aiCreateSheet,
    /** 打开 AI 设置 */
    aiSettings: aiSettingsSheet,
    /**
     * 系统返回键的统一入口（安卓外壳会调它）。
     * 返回 true 表示「这次返回已经被消化掉了」，外壳据此决定不退出应用。
     *
     * 之前没有这一层：向导不写 hash，外壳判断「hash 是首页」就直接退出，
     * 于是车卡到一半按返回会直接回到桌面。
     */
    handleBack: function () {
      try {
        // 1) 有弹层：关掉最上面那一层（只关一层，符合直觉）
        if (UI.hasSheet && UI.hasSheet()) { UI.closeTopSheet(); return true; }
        // 2) 跑团房间：从「房间内页」返回 = 回房间入口页。
        //    连接故意不断 —— 切回入口页看一眼「最近加入的房间」不该掉线，
        //    真正离开房间是界面上那个显式的「离开」按钮。
        if (route.name === 'room' && route.code && global.RoomUI && global.RoomUI.handleBack()) {
          return true;
        }
        // 3) 创建向导：退回上一步；已经在第 0 步就回首页
        if (ctx && route.name === 'create') {
          // 编辑模式：先退步骤，退到第 1 步再按才问「要不要丢弃未保存的修改」
          if (Store.isEditing() && ctx.step > 1) { ctx.goStep(ctx.step - 1); return true; }
          if (Store.isEditing()) {
            if (!Store.isEditDirty()) {
              var rid = Store.editingId();
              var rrs = (ctx.character && ctx.character.ruleSystemId) || 'coc7';
              Store.cancelEdit(); ctx = null;
              go('#/card/' + rrs + '/' + rid);
              return true;
            }
            var nm = (ctx.character && ctx.character.characterName) || '这张角色卡';
            UI.confirm('「' + nm + '」的修改还没有保存。\n返回会丢弃这些修改，角色卡保持原样。',
              { danger: true, okText: '丢弃修改', cancelText: '继续编辑' }
            ).then(function (ok) {
              if (!ok) return;
              var id2 = Store.editingId();
              var rs2 = (ctx && ctx.character && ctx.character.ruleSystemId) || 'coc7';
              Store.cancelEdit(); ctx = null;
              go('#/card/' + rs2 + '/' + id2);
            });
            return true;
          }
          if (ctx.step > 0) { ctx.goStep(ctx.step - 1); return true; }
          goHome();
          return true;
        }
        // 4) 其它内页：回首页
        if (route.name === 'card' || route.name === 'my' || route.name === 'room') { goHome(); return true; }
        if (location.hash && location.hash !== '#/' && location.hash !== '#') { goHome(); return true; }
      } catch (e) {
        console.warn('handleBack 出错', e);
      }
      return false;   // 已经在首页，交给系统退出应用
    },
    /** 手动保存编辑中的角色卡（完成步骤与编辑条共用） */
    saveEdit: saveEdit,
    /** 进入编辑会话（角色卡 / 我的角色共用） */
    startEdit: startEdit,
    go: go
  };

  /* ============================================================
   * 启动
   * ============================================================ */
  function boot() {
    buildShell();
    applyTheme((Store.getState().settings || {}).theme || 'light');

    /* 邀请链接（.../index.html?room=xx&srv=yy）打开的，直接进房间入口页。
       不这么做的话用户落在首页，得自己找到「跑团房间」再点进去 ——
       分享出去的是「点一下就能进团」的链接，不该要求对方先逛一圈。 */
    var invited = false;
    try {
      var inv = global.RoomNet && global.RoomNet.inviteParams();
      var h0 = location.hash;
      if (inv && inv.code && (!h0 || h0 === '#' || h0 === '#/')) {
        location.replace(location.pathname + location.search + '#/room');
        invited = true;
      }
    } catch (e) { /* 读不到就按普通首页走 */ }

    var cth = (global.COC_MADNESS || {});
    window.addEventListener('hashchange', onRoute);
    if (!invited) onRoute();   // 改过 hash 的交给 hashchange 触发，免得渲染两遍
    document.addEventListener('keydown', function (e) {
      // 走统一入口，保证关闭弹层时滚动锁也会一并释放
      if (e.key === 'Escape') UI.closeAllSheets();
    });
    console.log('%c' + ((window.BuildConfig && window.BuildConfig.displayName) || '骰境 TRPG') + '已就绪', 'color:#d4a94a;font-weight:700',
      '\n职业 ' + OCC.listAll().length + ' · 武器 ' + global.COC_WEAPONS.length + ' · 防具 ' + global.COC_ARMORS.length +
      ' · 载具 ' + global.COC_VEHICLES.length + ' · 疯狂表 ' + ((cth.phobias || []).length) + '/' + ((cth.manias || []).length));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
