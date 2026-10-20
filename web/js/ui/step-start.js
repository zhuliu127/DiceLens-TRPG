/* ============================================================
 * step-start.js — 向导第 0 步：快速开始
 *
 * 三条路：
 *   · 「生成随机角色」→ 一次生成 5 张完整预设卡（世界设定随机，
 *      姓名 / 地点 / 时代 / 装备彼此自洽），挑一张直接用；
 *   · 「AI 车卡」→ 用一句话描述想创建什么样的调查员，交给大模型出创意，
 *      规则数值仍由本地引擎生成，保证卡是可用的；
 *   · 「我要自己车卡」→ 进入原有的完整车卡流程（第 1 步起）。
 *
 * 注意：候选卡全部只存在内存里，只有玩家点「选这张」才会落库 ——
 * 所以连点几次「再来一批」不会留下垃圾数据。
 * ============================================================ */
(function (global) {
  'use strict';
  var h = UI.h;
  var R = global.COC7;

  global.Steps = global.Steps || {};

  var PRESET_COUNT = 5;
  var ATTR_ORDER = ['str', 'con', 'siz', 'dex', 'app', 'int', 'pow', 'edu', 'luck'];

  /**
   * 房规数值上限的说明行（这张卡按什么上限生成）。
   *
   * ⚠️ 旧文案是「这张卡的技能点被上限压过……点数已全部分配完，只是池子
   *    比公式算的小」—— 那是**已废弃的「压缩点数池」语义**。现在上限压的是
   *    「每一项技能能到的最高值」，点数池永远是规则公式算出的全额。
   *    文案必须跟着语义改，否则玩家看到「职业点上限 99」会以为点数被压坏了。
   *
   * ⚠️ 而且旧实现是「只要有 occCap/intCap 就警告」—— 随机卡身上默认就是 99，
   *    于是**每张随机卡**都在喊「被上限压过（职业点上限 99）」。现在由
   *    summaryOf 只送「真正低于默认值」的上限，这里见的都是有意义的。
   *
   * @returns {Element|null}
   */
  function capLine(p) {
    var bits = [];
    if (p.attrCap) {
      bits.push('属性总和 ≤ ' + p.attrCap + (p.attrCapWithLuck === false ? '（不含幸运）' : '（含幸运）'));
    }
    if (p.occCap) bits.push('每项本职技能 ≤ ' + p.occCap);
    if (p.intCap) bits.push('每项兴趣技能 ≤ ' + p.intCap);
    if (!bits.length) return null;

    /* 点数还剩着 = 所有技能都顶到上限了，这不是 bug，得说清楚。 */
    var left = Math.max(0, (p.occTotal || 0) - (p.occUsed || 0)) +
               Math.max(0, (p.intTotal || 0) - (p.intUsed || 0));
    return h('div.tiny', {
      style: {
        marginTop: '5px', lineHeight: '1.7',
        color: left > 0 ? 'var(--warn, #b8860b)' : 'var(--muted, #888)'
      },
      text: '🏠 按「数值上限」房规生成：' + bits.join('、') + '。' +
        '上限压的是「每一项技能能到的最高值」，不是把点数池压小；' +
        '技能点总额仍按规则公式算。' +
        (left > 0
          ? '这次还剩 ' + left + ' 点没用完 —— 因为所有技能都已经顶到上限了。'
          : '点数已全部用完。') +
        '不想被限制：菜单 → 🤖 AI 设置 → 数值上限 → 全部清除。'
    });
  }

  /* ============================================================
   * 候选卡预览（随机卡与 AI 卡共用同一套样式）
   * ============================================================ */
  function presetCard(p, i) {
    var abbr = {};
    R.attributes.forEach(function (a) { abbr[a.key] = a.abbr; });

    return h('div.preset-card', null, [
      h('div.pc-head', null, [
        h('span.pc-no', { text: String(i + 1) }),
        p.avatar ? h('img.pc-av', { src: p.avatar, alt: '' }) : null,
        h('div.grow', null, [
          h('div.pc-name', null, [
            p.name,
            // 彩蛋：🥚 古今中外名人 / 🎭 作者与跑团成员
            p.egg ? h('span.egg-badge' + (p.eggKind === 'friend' ? '.friend' : ''), {
              text: p.egg + (p.eggKind === 'friend' ? ' 跑团成员' : ' 彩蛋'),
              title: p.eggKind === 'friend' ? '作者与跑团成员彩蛋卡' : '名人彩蛋卡'
            }) : null
          ]),
          h('div.pc-meta', {
            text: p.gender + ' · ' + p.age + ' 岁 · ' + p.era + ' · ' + p.residence
          }),
          h('div.pc-meta', { text: '籍贯 ' + (p.birthplace || '—') }),
          h('div.row.wrap', { style: { gap: '5px', marginTop: '6px' } }, [
            h('span.tag.gold', { text: p.occupation }),
            p.world ? h('span.tag.arcane', { text: p.world }) : null,
            h('span.tag', { text: '信用 ' + p.credit }),
            h('span.tag.teal', { text: 'HP ' + p.hp }),
            h('span.tag', { text: 'SAN 上限 ' + p.san })
          ])
        ])
      ]),

      h('div.pc-block', null, [
        h('div.pc-lab', { text: '属性' }),
        h('div.fate-grid', null, ATTR_ORDER.map(function (k) {
          return h('div.fate-cell', null, [
            h('span.k', { text: abbr[k] || k.toUpperCase() }),
            h('span.v', { text: p.attrs[k] })
          ]);
        }))
      ]),

      h('div.pc-block', null, [
        h('div.pc-lab', { text: '派生与点数' }),
        h('div.tiny.dim', { style: { lineHeight: '1.85' }, html:
          'HP <b>' + p.hp + '</b>　MP <b>' + p.mp + '</b>　SAN <b>' + p.san + '</b>　MOV <b>' + p.mov +
          '</b>　体格 <b>' + p.build + '</b>　伤害加值 <b>' + p.db + '</b>　幸运 <b>' + p.luck + '</b><br>' +
          /* used === total 时补一句「已用完」——
             只看100/100 玩家可能以为还有没分配的额度。 */
          '职业点 <b>' + p.occUsed + '/' + p.occTotal + '</b>（信用评级已占 ' + p.credit +
          (p.occUsed >= p.occTotal ? '，已用完' : '，剩 ' + (p.occTotal - p.occUsed)) + '）　' +
          '兴趣点 <b>' + p.intUsed + '/' + p.intTotal + '</b>' +
          (p.intUsed >= p.intTotal ? '（已用完）' : '（剩 ' + (p.intTotal - p.intUsed) + '）') +
          '　本职技能 <b>' + p.occtSkills + '</b> 项' +
          (p.eduChecks ? '　教育进步检定 <b>' + p.eduChecks + '</b> 次（教育 +' + p.eduBonus + '）' : '')
        }),
        /* 房规数值上限的说明（没设上限时不显示任何东西）。
           ⚠️ 这里以前是一段警告：「这张卡的技能点被上限压过……点数已全部分配完，
           只是池子比公式算的小」。那句话描述的是**已被废弃的「压缩点数池」语义**，
           而且对**每一张随机卡**都成立（默认值 99 被当成了「上限 99」），
           玩家据此以为点数被压坏了 —— 所以整段替换掉。 */
        capLine(p)
      ]),

      h('div.pc-block', null, [
        h('div.pc-lab', { text: '主要技能' }),
        h('div.row.wrap', { style: { gap: '5px' } }, p.topSkills.map(function (s) {
          return h('span.tag' + (s.occ ? '.gold' : ''), { text: s.name + ' ' + s.total });
        }))
      ]),

      h('div.pc-block', null, [
        h('div.pc-lab', { text: '背景' }),
        h('div.tiny.dim', { style: { lineHeight: '1.8' } }, [
          h('div', { text: '外貌：' + p.look }),
          h('div', { text: p.belief }),
          h('div', { text: '重要之人：' + p.people }),
          h('div', { text: '意义非凡之地：' + p.place }),
          h('div', { text: '宝贵之物：' + p.treasure }),
          h('div', { text: '特点：' + p.traits + '　伤口：' + p.wound }),
          h('div', { text: '心理：' + p.phobia }),
          h('div', { text: '经历：' + (p.history.join('；') || '—') })
        ])
      ]),

      h('div.pc-block', null, [
        h('div.pc-lab', { text: '装备' }),
        h('div.tiny.dim', { style: { lineHeight: '1.8' }, text:
          '武器：' + (p.weapons.join('、') || '—') +
          '　防具：' + (p.armors.join('、') || '—') +
          '　物品：' + (p.items.join('、') || '—')
        })
      ])
    ]);
  }

  /** 保存候选卡并回首页 */
  function adopt(card, note) {
    card.changeLog = card.changeLog || [];
    card.changeLog.push({ version: 'v1.0', note: note, at: Date.now() });
    Store.savePreset(card);
    UI.toast('已保存「' + (card.characterName || '调查员') + '」到已保存的角色卡', 'ok', 2600);
    global.App.goHome();
  }

  /* ============================================================
   * AI 车卡面板（第 0 步与菜单共用）
   * ============================================================ */
  function openAIPanel() {
    if (!global.AIGen || !global.AIClient) { UI.toast('AI 模块未加载', 'err'); return; }

    var desc = '';
    var busy = false;
    var startedAt = 0;
    var clock = null;
    var result = null;       // summaryOf 结果
    var errorMsg = '';
    var capNote = '';        // 本次生效的数值上限说明
    var body = h('div');
    var sh = UI.sheet({ title: '✨ AI 车卡', body: body });

    function stopClock() { if (clock) { clearInterval(clock); clock = null; } }

    function paint() {
      UI.clear(body);

      /* ---- 没配置：给引导，而不是直接报错 ---- */
      if (!global.AIClient.configured()) {
        body.appendChild(h('div.card', null, [
          h('div.card-title', { text: '先接入一个大模型' }),
          h('div.small.dim', { style: { lineHeight: '1.85' }, text:
            'AI 车卡需要你提供一个「OpenAI 兼容」的模型接口。填接口地址、模型名称与 API Key 三样即可，' +
            '默认值已经填好 DeepSeek 的地址，通常只需要补一个 Key。' }),
          h('div.btn-group.cols2', { style: { marginTop: '13px' } }, [
            h('button.btn.primary', {
              text: '🤖 去配置', onclick: function () { sh.close(); global.App.aiSettings(); }
            }),
            h('button.btn.ghost', {
              text: '🎲 用离线随机卡', onclick: function () { sh.close(); }
            })
          ]),
          h('div.tiny.muted', { style: { marginTop: '11px', lineHeight: '1.8' }, text:
            '不接入也完全不影响使用 —— 第 0 步的「生成随机角色」纯本地运行，不依赖任何接口。' })
        ]));
        return;
      }

      /* ---- 生成中 ---- */
      if (busy) {
        var sec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
        body.appendChild(h('div.card', null, [
          h('div.card-title', { text: '正在生成…' }),
          h('div.ai-loading', { id: 'aiLoading' }, [
            h('span.spinner'),
            h('div.grow', null, [
              h('div', { text: '正在请模型把你的点子写成一个调查员' }),
              h('div.tiny.muted', { text: '已用 ' + sec + ' 秒 · 通常 5-20 秒，模型越慢越久' })
            ])
          ]),
          h('div.tiny.muted', { style: { marginTop: '10px', lineHeight: '1.8' }, text:
            '生成完会自动做一次规则校验：属性、职业点、技能上限、信用评级都要过，通不过会自动重掷，' +
            '所以偶尔会多花几秒。' })
        ]));
        return;
      }

      /* ---- 出错了 ---- */
      if (errorMsg) {
        body.appendChild(h('div.card', null, [
          h('div.card-title', { text: '生成失败' }),
          UI.notice(errorMsg, 'err', '✕'),
          h('div.small.dim', { style: { marginTop: '11px', lineHeight: '1.8' }, text: '描述不会丢，直接再点一次试试；反复失败多半是接口配置的问题。' }),
          h('div.btn-group.cols2', { style: { marginTop: '13px' } }, [
            h('button.btn.primary', { text: '🔄 再试一次', onclick: function () { errorMsg = ''; run(); } }),
            h('button.btn.ghost', { text: '🤖 检查设置', onclick: function () { sh.close(); global.App.aiSettings(); } })
          ])
        ]));
      }

      /* ---- 结果 ---- */
      if (result) {
        body.appendChild(h('div.card-head', null, [
          h('h3', { text: '这张还行吗' }),
          h('span.hint', { text: '不满意可以反复重来' })
        ]));
        body.appendChild(presetCard(result, 0));
        if (capNote) {
          body.appendChild(h('div.tiny.muted', { style: { marginTop: '9px', lineHeight: '1.7' }, text: capNote }));
        }
        body.appendChild(h('div.btn-group.cols2', { style: { marginTop: '11px' } }, [
          h('button.btn.primary', {
            text: '✓ 就用这张', onclick: function () { sh.close(); adopt(result.card, '第 0 步 AI 车卡：采用 AI 生成的调查员'); }
          }),
          h('button.btn.teal', { text: '🔄 重新生成', onclick: function () { run(); } })
        ]));
        body.appendChild(h('div.tiny.muted', { style: { marginTop: '9px', lineHeight: '1.8' }, text:
            '「重新生成」会用同样的描述再要一张，风格会不一样；想换方向就改上面的描述。' }));
      }

      /* ---- 输入区 ---- */
      if (!result) {
        var input = UI.textarea({
          value: desc,
          placeholder: '例如：民国时期的私家侦探，前警察，因为一桩案子丢了差事，随身带着一副旧手铐',
          rows: 3,
          oninput: function () { desc = input.value; }
        });

        body.appendChild(h('div.card', null, [
          h('div.card-title', { text: '描述你想创建什么样的调查员' }),
          h('div.tiny.dim', { style: { marginBottom: '10px', lineHeight: '1.75' }, text:
            '一句话就行 —— 时代、职业、性格、经历，想到什么写什么。写得越具体，出来的卡越贴你的想法。' }),
          input,
          h('div.row.wrap', { style: { gap: '6px', marginTop: '10px' } }, global.AIGen.examples.map(function (ex) {
            return h('button.chip', {
              text: ex.slice(0, 14) + '…',
              title: ex,
              onclick: function () { desc = ex; input.value = ex; }
            });
          })),
          h('button.btn.primary.block', {
            text: '✨ 生成调查员', style: { marginTop: '13px' },
            onclick: function () { run(); }
          }),
          global.AIGen.capsActive()
            ? h('div.tiny.muted', { style: { marginTop: '9px', lineHeight: '1.7' }, text:
                '本次数值上限：' + global.AIGen.capsText() + '　（在「AI 设置」里改）' })
            : null,
          /* ⚠️ 这两个上限压的是「**每一项技能最终值**」，不是「点数池变少」。
             措辞必须说清 —— 否则玩家看到「职业点 ≤ 80」会以为职业点总数
             被压到 80（点数池其实不变，少的是每一项能到的上限）。 */
          global.AIGen.capsActive()
            ? h('div', { style: { marginTop: '9px' } }, [
                h('div.tiny', { style: { color: 'var(--warn, #b8860b)', lineHeight: '1.7' },
                  text: '注意：这里的「职业点 / 兴趣技能点上限」指的是**每一项技能最多能点到多少**' +
                        '（例：职业 80 → 侦查最多 80；兴趣 60 → 会计最多 60），' +
                        '**不是**把职业点总数压到 80。点数总额仍按规则算，只是每项有天花板。' }),
                h('button.btn.sm', {
                  style: { marginTop: '6px' },
                  text: '清除上限，按规则全额生成',
                  onclick: function () {
                    Store.setSettings({ aiAttrCap: 0, aiAttrCapWithLuck: true,
                                       aiOccPtsCap: 0, aiIntPtsCap: 0 });
                    UI.toast('已清除全部数值上限', 'ok');
                    sh.close();
                    global.App.aiSettings();
                  }
                })
              ])
            : null
        ]));

        body.appendChild(h('div.card', null, [
          h('div.card-title', { text: '它是怎么工作的' }),
          h('div.tiny.dim', { style: { lineHeight: '1.85' }, text:
            'AI 只负责「是谁、做什么职业、长什么样、有什么故事」这些创意部分；' +
            '属性、职业点、技能分配、装备与资产全部由本地规则引擎生成，' +
            '所以生成的卡一定能通过完整性校验，可以直接拿去跑团。' })
        ]));
      }
    }

    function run() {
      var text = String(desc || '').trim();
      if (!text) { UI.toast('先写一句描述，或者点下面的示例', 'err', 2600); return; }
      busy = true;
      errorMsg = '';
      result = null;
      startedAt = Date.now();
      paint();
      stopClock();
      clock = setInterval(function () {
        var sec = Math.round((Date.now() - startedAt) / 1000);
        var el = document.getElementById('aiLoading');
        if (el && el.lastChild && el.lastChild.lastChild) {
          el.lastChild.lastChild.textContent = '已用 ' + sec + ' 秒 · 通常 5-20 秒，模型越慢越久';
        }
      }, 1000);

      /* onStage：AI 层在自动重试（额度不够时用更大额度重发）会回调这里，
         让用户看到「正在重试…」而不是以为卡死了 —— 推理型模型重试可能要十几秒。 */
      global.AIGen.makeCharacter(text, function (msg) {
        var el = document.getElementById('aiLoading');
        if (el && el.lastChild && el.lastChild.lastChild) el.lastChild.lastChild.textContent = msg;
      }).then(function (res) {
        stopClock();
        busy = false;
        result = global.PresetGen.summaryOf(res.character);
        /* 告诉玩家「上限到底起没起作用」—— 静默生效的话，
           看到数值被压过会以为生成错了。 */
        capNote = '';
        if (res && res.caps && global.AIGen.capsActive(res.caps)) {
          capNote = '已按上限生成：' + global.AIGen.capsText(res.caps);
          if (res.attrScaled) capNote += '　（模型给的属性超了，已按比例压缩）';
          /* 明确点出「上限是每项的天花板」—— 只说「已按上限生成」不够，
             玩家看到点数没变少会以为上限没生效。 */
          if (res.caps.occCap || res.caps.intCap) {
            capNote += '。技能上限只压**每一项能到的最大值**，不减少点数总额。';
          }
        }
        /* 明确说一句「点数已全部分配」。用户反馈过「有很多技能点没用完」，
           光看used/total 两个相等的数字不夠让人放心。 */
        if (result && result.occUsed === result.occTotal &&
            result.intUsed === result.intTotal) {
          capNote += (capNote ? '　·　' : '') + '技能点已全部分配（职业 ' +
            result.occUsed + '/' + result.occTotal + '，兴趣 ' +
            result.intUsed + '/' + result.intTotal + '）';
        }
        paint();
      }).catch(function (err) {
        stopClock();
        busy = false;
        errorMsg = (err && err.message) || '生成失败';
        paint();
      });
    }

    paint();
  }

  /* ============================================================
   * 第 0 步本体
   * ============================================================ */
  global.Steps.start = {
    id: 'start', title: '快速开始', short: '快速开始', icon: '0',
    sub: '想马上开团？让系统替你造几张调查员，或者让 AI 按你的描述车一张；也可以自己从头来。',
    render: function (root, ctx) {
      var c = ctx.character;
      var presets = [];          // 本次生成的候选（尚未保存）
      var batch = 0;             // 已生成批次，用于显示「第 N 批」
      var capsStale = false;     // 生成后玩家又改了房规上限 → 这批卡作废提示

      /* ---------- 顶部功能说明 ---------- */
      root.appendChild(h('div.card', null, [
        h('div.card-title', { text: '这一步是干什么的' }),
        h('div.small.dim', { style: { lineHeight: '1.75' } }, [
          '这一步是可选的，用最快的速度拿到一张能直接开团的角色卡：',
          h('div', { style: { marginTop: '8px' } }, [
            h('b', { text: '① 生成随机角色' }),
            '　一次生成 ', h('b', { text: String(PRESET_COUNT) + ' 张' }),
            '完整预设卡（属性、技能、装备、背景全部填好）。角色来自古今中外不同的地区与年代，',
            '姓名、籍贯、职业与装备彼此对得上，不会出现「中国名字住在阿卡姆」这种情况。'
          ]),
          h('div', { style: { marginTop: '5px' } }, [
            h('b', { text: '② AI 车卡' }),
            '　用一句话描述你想创建什么样的调查员（时代、职业、性格都行），由大模型写出这个人和他的故事，',
            '规则数值仍由本地引擎算，所以卡是合规的。不满意可以反复重新生成。',
            h('br'), h('span.tiny.muted', { text: '需要在菜单的「AI 设置」里填一次接口信息，只填一次。' })
          ]),
          h('div', { style: { marginTop: '5px' } }, [
            h('b', { text: '③ 选定一张' }),
            '　立刻保存到首页的「已保存的角色卡」，并直接返回首页 —— 马上就能拿去跑团。',
            h('br'), h('span.tiny.muted', { text: '没有选中的那几张不会保存，不占用你的角色列表。' })
          ]),
          h('div', { style: { marginTop: '5px' } }, [
            h('b', { text: '④ 我要自己车卡' }),
            '　跳过这一步，进入完整的车卡流程（基本资料 → 属性 → 职业 → …→ 完成）。'
          ]),
          h('div.tiny.muted', { style: { marginTop: '9px' }, text: '预设卡生成后仍可以随时编辑：首页点开角色卡 →「✎ 编辑角色」。' })
        ])
      ]));

      /* ---------- 操作区 ---------- */
      var resultHost = h('div');
      var capsLine = h('div.tiny.muted', { style: { marginTop: '9px', lineHeight: '1.7' } });

      root.appendChild(h('div.card', null, [
        h('div.card-title', { text: '选择开始方式' }),
        h('button.btn.primary.block', { text: '🎲 生成随机角色（' + PRESET_COUNT + ' 张）', onclick: generate }),
        h('button.btn.teal.block', {
          text: '✨ AI 车卡（一句话生成）', style: { marginTop: '9px' },
          onclick: function () { openAIPanel(); }
        }),
        h('button.btn.ghost.block', { text: '✏ 我要自己车卡', style: { marginTop: '9px' }, onclick: selfBuild }),
        /* 房规数值上限：按钮直接跳到「AI 设置 → 数值上限」那张卡片。
           以前只写「在菜单 → AI 设置里改」，玩家真要改时得在一堆卡片里自己翻 ——
           而这一步恰恰是最该改上限的地方（设完就直接点生成随机角色）。
           上限对上面两种生成方式都生效，所以提示行必须挨着这两个按钮。 */
        /* 图标用 🎛 而不是 🎚 —— 后者（电平滑块）在部分系统的字体里会退化成
           一条细竖条 / 豆腐块，在按钮的小字号下基本看不出是什么。 */
        h('button.btn.ghost.block', {
          text: '🎛 设置属性 / 技能上限', style: { marginTop: '9px' },
          onclick: openCapsSheet
        }),
        capsLine
      ]));

      root.appendChild(resultHost);

      /* ---------- 房规数值上限：跳转 / 提示行 ---------- */
      /** 上限设置的指纹 —— 只为判断「这次弹层关闭时值有没有变过」 */
      function capsSig() {
        var s = (Store.getState() || {}).settings || {};
        return [s.aiAttrCap || 0, s.aiAttrCapWithLuck !== false,
                s.aiOccPtsCap || 0, s.aiIntPtsCap || 0].join('/');
      }

      /** 提示行：没设上限时也要显式写一句「按规则全额」，
          否则玩家看不出这个按钮和当前状态有什么关系。 */
      function paintCapsLine() {
        UI.clear(capsLine);
        var on = global.AIGen && global.AIGen.capsActive();
        capsLine.appendChild(h('div', { text: on
          ? '本次数值上限（上面两种生成方式都生效）：' + global.AIGen.capsText()
          : '暂未设置数值上限 —— 按规则公式全额生成。' }));
      }

      /**
       * 打开「AI 设置」并定位到「数值上限」。
       * 关掉弹层后：① 刷新提示行；② 若值真的变了，已生成的那批候选卡是按
       * 旧上限算的，得明确提示「这批过期了、点换一批重算」——
       * 静默留着会让玩家以为新上限没生效。
       */
      function openCapsSheet() {
        if (!global.App || !global.App.aiSettings) { UI.toast('设置页未加载', 'err'); return; }
        var before = capsSig();
        global.App.aiSettings({
          focusCaps: true,
          onClose: function () {
            paintCapsLine();
            if (capsSig() === before) return;
            UI.toast('数值上限已更新', 'ok', 2400);
            if (presets.length) { capsStale = true; paintResult(); }
          }
        });
      }

      /* ---------- 生成 ---------- */
      function generate() {
        if (!global.PresetGen) { UI.toast('预设卡生成器未加载', 'err'); return; }
        var list;
        try {
          list = global.PresetGen.generate(PRESET_COUNT);
        } catch (e) {
          console.error(e);
          UI.toast('生成失败：' + e.message, 'err', 3200);
          return;
        }
        if (!list || !list.length) { UI.toast('生成失败，请再试一次', 'err'); return; }
        batch++;
        capsStale = false;          // 新一批按当前上限算，之前的「过期」提示作废
        presets = list.map(function (card) { return global.PresetGen.summaryOf(card); });
        paintCapsLine();            // 上限是变量，顺手读一次最新的
        paintResult();
        UI.toast('已生成 ' + presets.length + ' 张预设卡，挑一张吧', 'ok', 2200);
      }

      /** 自己车卡：记下「已经做过第 0 步的选择」，然后进第 1 步 */
      function selfBuild() {
        c.startSkipped = true;
        Store.scheduleSave();
        ctx.goStep(1);
      }

      /* ---------- 选定并保存 ---------- */
      function chooseAt(i) {
        var s = presets[i];
        if (!s) return;
        adopt(s.card, '第 0 步快速开始：采用随机预设卡');
      }

      /* ---------- 渲染结果 ---------- */
      function paintResult() {
        UI.clear(resultHost);
        if (!presets.length) return;

        /* 生成之后又改了房规上限 —— 这批是按旧上限算的。
           不说清楚的话，玩家会以为新上限没生效。 */
        if (capsStale) {
          resultHost.appendChild(UI.notice(
            '这批卡是按改动前的上限生成的。点下面的「换一批」会用新上限重新算。',
            'warn', '!'));
        }

        resultHost.appendChild(h('div.card-head', null, [
          h('h3', { text: '第 ' + batch + ' 批 · ' + presets.length + ' 张候选' }),
          h('span.hint', { text: '未选中的不保存' })
        ]));

        presets.forEach(function (p, i) {
          var card = presetCard(p, i);
          card.appendChild(h('button.btn.primary.block', {
            text: '✓ 选这张，开始跑团',
            style: { marginTop: '11px' },
            onclick: function () { chooseAt(i); }
          }));
          resultHost.appendChild(card);
        });

        resultHost.appendChild(h('div.btn-group.cols2', { style: { marginTop: '4px' } }, [
          h('button.btn.teal', { text: '🎲 换一批（' + PRESET_COUNT + ' 张）', onclick: generate }),
          h('button.btn.ghost', { text: '✏ 我自己车卡', onclick: selfBuild })
        ]));
      }

      paintCapsLine();   // 首屏就把当前房规上限写出来（含「未设置」）
    }
  };

  global.AICreateUI = { open: openAIPanel };
})(window);
