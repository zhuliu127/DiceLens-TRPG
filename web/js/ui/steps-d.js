/* ============================================================
 * steps-d.js — 步骤 7 背景 / 步骤 8 完成
 * ============================================================ */
(function (global) {
  'use strict';
  var h = UI.h;
  var R = global.COC7;
  var OCC = global.CocOccupation;

  global.Steps = global.Steps || {};

  /* 10 套预设背景 */
  var PRESETS = [
    { name: '落魄记者', d: '衣着略显褶皱的风衣，领口别着一支钢笔。眼神锐利但眼下有淡淡的青色。',
      id: '真相必须被记录，哪怕没有人愿意读。', p: '主编老陈｜报社上司｜他给了我第一份工作｜严厉但护短。',
      pl: '报社资料室｜堆满旧报纸的房间｜我在这里查到过改变一生的线索。',
      t: '祖父的钢笔｜笔身有裂痕｜祖父遗物｜提醒我为什么开始写作。',
      tr: '固执、习惯性怀疑权威、咖啡成瘾', w: '右手掌有一道旧烫伤。', ph: '对密闭空间有轻微不适。' },
    { name: '退役军官', d: '挺拔的身姿，短发，左眉上有一道疤痕。穿着剪裁利落的旧西装。',
      id: '秩序高于一切，混乱只会带来更多死亡。', p: '老战友哈里斯｜同袍｜我们在同一场战役中活了下来｜唯一可以托付后背的人。',
      pl: '索姆河畔的旧战壕｜荒废的泥土工事｜我在那里失去了半个连队。',
      t: '勋章｜带弹痕的铜质勋章｜战功｜提醒我代价是什么。',
      tr: '沉默、极度整洁、睡前必检查门锁', w: '左腿旧伤，阴雨天会疼。', ph: '听到类似炮声的声音会僵直。' },
    { name: '古董商', d: '圆框眼镜，马甲口袋挂着怀表链。手指因常年擦拭器物而干净修长。',
      id: '每一件旧物都藏着一段没人愿意讲的故事。', p: '埃莉诺姑妈｜启蒙者｜教我辨认真伪｜已故，留下这间店铺。',
      pl: '旧店铺的地下库房｜潮湿但有独特的木质气味｜所有收藏的起点。',
      t: '黄铜钥匙｜无锁可开｜来源不明｜我总觉得它会派上用场。',
      tr: '谨慎、喜欢收集、对数字敏感', w: '右手食指有一道小切口。', ph: '无法忍受器物被粗暴对待。' },
    { name: '医学院学生', d: '白大褂下是皱巴巴的衬衫，总带着淡淡的消毒水气味。',
      id: '死亡是一种可以被理解的现象，仅此而已。', p: '导师布莱克教授｜师长｜在解剖课上注意到了我｜鼓励我质疑权威。',
      pl: '解剖实验室｜有福尔马林的气味｜我第一次意识到人体的脆弱。',
      t: '手术刀｜刻着名字｜父亲送的入学礼物｜提醒我为什么选择这条路。',
      tr: '理性、好奇心过剩、睡眠不足', w: '左手腕有一道练习时留下的浅疤。', ph: '对血液在意外场合出现会短暂失神。' },
    { name: '落魄贵族', d: '昂贵但不合时宜的礼服，袖口有磨损。谈吐优雅，眼神里藏着倦意。',
      id: '家族的名誉比我的生命更重要。', p: '老管家雷诺｜守护者｜服侍家族四十年｜唯一还留在宅邸的人。',
      pl: '祖宅的书房｜三层楼梯尽头｜墙上挂着三代人的肖像。',
      t: '家族印章｜黄铜质地｜父亲遗物｜证明我仍然是谁。',
      tr: '骄傲、讲究礼仪、不擅长说谎', w: '无。', ph: '害怕被人在公开场合认出落魄的样子。' },
    { name: '流浪画家', d: '颜料沾在指缝与袖口，帽檐压得很低，背包里永远有速写本。',
      id: '有些东西用语言说不出来，只能画出来。', p: '同窗米娅｜旧友｜唯一买过我画的人｜现在住在巴黎。',
      pl: '海边的悬崖｜风很大，光很好｜我在那里画出了最好的一张画。',
      t: '速写本｜已经用了七年｜一路的记录｜里面有几页我自己也不敢再看。',
      tr: '敏感、厌恶重复、容易走神', w: '膝盖有摔伤。', ph: '对完全空白的地方会感到莫名不安。' },
    { name: '教堂司事', d: '深色旧外套，脖子上挂着一枚磨得发亮的十字架。说话很慢。',
      id: '我见过的东西不该存在于这个世界上，但我仍然相信有救赎。', p: '老神父马丁｜引路人｜在我最糟的时候收留了我｜已故。',
      pl: '旧教堂的地下室｜潮湿的石墙｜我在那里第一次听见不该有的声音。',
      t: '圣经｜扉页有别人写的字｜来源不明｜那句话始终没看懂。',
      tr: '耐心、习惯祈祷、回避争执', w: '手掌有常年握持留下的厚茧。', ph: '对深夜的钟声极度不安。' },
    { name: '私家侦探', d: '风衣口袋里塞着记事本和半包烟。习惯站在门口观察再进门。',
      id: '真相往往不在别人愿意告诉你的地方。', p: '老搭档路易斯｜前警探｜带我入行｜三年前失踪了。',
      pl: '旧警局后巷｜下过雨的沥青路｜我最后见到路易斯的地方。',
      t: '他的打火机｜银色，有凹痕｜路易斯留下｜我一直在等他回来拿。',
      tr: '多疑、观察力强、不爱说话', w: '鼻梁有旧伤。', ph: '对长时间无人应答的电话铃声不适。' },
    { name: '落魄作家', d: '不修边幅，眼睛布满血丝，口袋里总有揉成团的稿纸。',
      id: '如果我写下的东西是对的，那这个世界就有大问题。', p: '编辑康拉德｜合作者｜唯一愿意读我稿子的人｜一直在催我交稿。',
      pl: '城郊的小旅馆｜六号房间｜我写出那篇小说的房间。',
      t: '打字机｜二手，缺少一个键｜写作工具｜我怀疑它在夜里自己响过。',
      tr: '失眠、强迫性记录、畏惧空白', w: '无。', ph: '对打字机的突然声响会剧烈心悸。' },
    { name: '神秘学者', d: '书房里堆满书，手指上有墨迹。说话时眼神会飘向别处。',
      id: '知识本身没有善恶，只有是否被承受得住。', p: '已故导师惠特尼｜引路者｜把藏书留给了我｜死因不明。',
      pl: '大学图书馆禁区｜铁栅栏后｜我在那里找到了导师的笔记。',
      t: '一本无名手稿｜缺页，用陌生文字写成｜导师遗留｜我不敢读完。',
      tr: '专注、健忘、对日常琐事迟钝', w: '无。', ph: '对特定几何图案会产生眩晕。' }
  ];

  /* ============================================================
   * 步骤 7：背景
   * ============================================================ */
  global.Steps.background = {
    id: 'background', title: '角色背景', short: '背景', icon: '8',
    sub: '背景、经历、伙伴与克苏鲁神话。都非必填，可稍后补充。',
    render: function (root, ctx) {
      var c = ctx.character;
      var bg = c.background;
      function save() { Store.scheduleSave(); }

      /* ---- 预设 ---- */
      var presetRow = h('div.row.wrap', { style: { gap: '7px' } });
      PRESETS.forEach(function (p, i) {
        presetRow.appendChild(h('button.chip', {
          text: p.name, onclick: function () {
            if (!c.characterName) c.characterName = p.name;
            bg.description = p.d;
            bg.ideology = '信仰 / 人生观 / 价值观 / 政治观点 / 人生目标：\n' + p.id;
            bg.significantPeople = p.p;
            bg.meaningfulPlaces = p.pl;
            bg.treasuredPossessions = p.t;
            bg.traits = p.tr;
            bg.wounds = p.w;
            bg.phobias = p.ph;
            // 预设里的恐惧症/狂躁症同样要进结构化数组（认得出来的才进）
            if (global.CocMadness && global.CocMadness.fromBackground) {
              global.CocMadness.fromBackground(c);
            }
            save(); paintAll(); UI.toast('已套用预设：' + p.name, 'ok');
          }
        }));
      });

      /* ---- 文本域组 ---- */
      var fieldsHost = h('div');
      var FIELDS = [
        { k: 'description',           label: '个人描述',   ph: '外貌、身高、体型、穿着、发型、特征…' },
        { k: 'ideology',              label: '思想 / 信念', ph: '信仰、人生观、价值观、政治观点、人生目标…' },
        { k: 'significantPeople',     label: '重要之人',   ph: '姓名 / 身份 / 与角色关系 / 简介…' },
        { k: 'meaningfulPlaces',      label: '意义非凡之地', ph: '地点名称 / 描述 / 为什么重要…' },
        { k: 'treasuredPossessions',  label: '宝贵之物',   ph: '物品名称 / 描述 / 来源 / 为什么重要…' },
        { k: 'traits',                label: '特点（性格）', ph: '例：固执、谨慎、喜欢喝咖啡、不相信警察…' },
        { k: 'wounds',                label: '伤口 / 疤痕', ph: '身体伤口 / 旧伤 / 疤痕 / 来源…' },
        { k: 'phobias',               label: '疯狂症状', ph: '恐惧症 / 狂躁症 / 疯狂发作…（可从下方「疯狂表」选择）' }
      ];

      function paintFields() {
        UI.clear(fieldsHost);
        FIELDS.forEach(function (f) {
          fieldsHost.appendChild(UI.field(f.label,
            UI.textarea({
              value: bg[f.k] || '', placeholder: f.ph,
              oninput: function () { bg[f.k] = this.value; save(); }
            })));
        });
      }

      /* ---- 疯狂表（v2.1.9 用户第 3 项）：10 即时症状 + 10 总结症状 ----
         「点某条症状即选中生效」：点击即写入「疯狂症状」文本框 + 结构化数组，
         不再保留旧的「应用到恐惧症/狂躁症」二次按钮（避免重复写入路径）。
         第 9 / 10 条（恐惧症 / 狂躁症）展开 100 条子表再选。 */
      function madnessSheet() {
        var MAD = global.CocMadness;
        if (!MAD) { UI.toast('疯狂数据未加载', 'err'); return; }
        var bout = MAD.boutTable ? MAD.boutTable() : [];
        var sumTab = MAD.summaryTable ? MAD.summaryTable() : [];

        /* 立即把一条症状写进「疯狂症状」文本 + 结构化数组（永久疯狂 / 背景语义） */
        function applySymptom(kind, name, desc, isSum) {
          var line = '【' + kind + '】' + name + '：' + (desc || '');
          bg.phobias = (bg.phobias ? bg.phobias.replace(/\s*$/, '') + '\n' : '') + line;
          var n = (global.CocMadness && global.CocMadness.fromPicked)
            ? global.CocMadness.fromPicked(c, [{ kind: kind, name: name, desc: desc, sum: !!isSum }])
            : 0;
          save(); paintFields();
          UI.toast(n
            ? ('已选择：' + name + '（已写入「疯狂症状」）')
            : ('已选择：' + name + '（状态里已有，未重复添加）'), 'ok', 3000);
        }

        /* 100 条恐惧症 / 狂躁症子表（各自保留「🎲 随机」按钮） */
        function openSub(kind) {
          var label = (kind === 'mania') ? '狂躁症' : '恐惧症';
          var arr = (kind === 'mania') ? MAD.manias() : MAD.phobias();
          var tableHost = h('div.table-scroll');
          var t = h('table.dtable');
          t.appendChild(h('thead', null, [h('tr', null, [
            h('th', { text: '#' }), h('th', { text: label })
          ])]));
          var tb = h('tbody');
          arr.forEach(function (it, i) {
            tb.appendChild(h('tr', null, [
              h('td.mono', { text: it.no || (i + 1) }),
              h('td.pick', {
                text: it.name, title: it.desc,
                onclick: function () {
                  applySymptom(label, it.name, it.desc, false);
                  sub.close();
                }
              })
            ]));
          });
          t.appendChild(tb); tableHost.appendChild(t);
          var sub = UI.sheet({
            title: label + '表（100 条）',
            body: h('div', null, [
              h('div.btn-group', { style: { marginBottom: '10px' } }, [
                h('button.btn.sm.teal', {
                  text: '🎲 随机' + label, onclick: function () {
                    var it = arr[Math.floor(Math.random() * arr.length)];
                    if (!it) return;
                    applySymptom(label, it.name, it.desc, false);
                    UI.toast(label + '：' + it.name, 'ok');
                    sub.close();
                  }
                })
              ]),
              h('div.tiny.muted', { text: '共 100 条' + label + '。点条目即选中并写入「疯狂症状」。', style: { marginBottom: '10px' } }),
              tableHost
            ])
          });
        }

        /* 主表单元格：第 9 / 10 条（恐惧症 / 狂躁症）点开子表，其余直接选中生效 */
        function cellOf(item, isSum) {
          if (!item) return h('td.pick', { text: '' });
          var isLink = (item.no === 9 || item.no === 10);
          return h('td.pick', {
            text: item.name, title: item.desc,
            onclick: function () {
              if (isLink) { openSub(item.no === 10 ? 'mania' : 'phobia'); return; }
              applySymptom('疯狂发作', item.name, item.desc, isSum);
            }
          });
        }
        function buildMainTable() {
          var t = h('table.dtable');
          t.appendChild(h('thead', null, [h('tr', null, [
            h('th', { text: '#' }),
            h('th', { text: '即时症状（掷 1D10）' }),
            h('th', { text: '总结症状（独处时）' })
          ])]));
          var tb = h('tbody');
          for (var i = 0; i < 10; i++) {
            tb.appendChild(h('tr', null, [
              h('td.mono', { text: (i + 1) }),
              cellOf(bout[i], false),
              cellOf(sumTab[i], true)
            ]));
          }
          t.appendChild(tb);
          return t;
        }

        UI.sheet({
          title: '疯狂表',
          body: h('div', null, [
            h('div.btn-group', { style: { marginBottom: '10px' } }, [
              h('button.btn.sm.teal', {
                text: '🎲 随机',
                title: '掷 1D10：1-8 取即时症状；9 恐惧症 / 10 狂躁症再掷 1D100',
                onclick: function () {
                  /* 严格规则：先掷 1D10 从 10 条即时症状随机选一条；
                     若掷到 9 / 10，再从对应 100 表抽一条。 */
                  var hit = MAD.rollTable();
                  if (!hit) return;
                  if (hit.kind === 'bout') applySymptom('疯狂发作', hit.src.name, hit.src.desc, false);
                  else applySymptom((hit.kind === 'mania') ? '狂躁症' : '恐惧症', hit.src.name, hit.src.desc, false);
                }
              })
            ]),
            h('div.tiny.muted', {
              style: { marginBottom: '10px' },
              text: '即时症状在发作时按轮扮演；总结症状在独自一人时由 KP 陈述。第 9 / 10 条可展开 100 条恐惧症 / 狂躁症子表。点条目即选中并写入「疯狂症状」。'
            }),
            buildMainTable()
          ])
        });
      }

      /* ---- 调查员经历 ---- */
      var histHost = h('div');
      function paintHistory() {
        UI.clear(histHost);
        if (!c.history.length) histHost.appendChild(UI.emptyState('📜', '还没有经历记录', '用于保存角色成长历史'));
        c.history.forEach(function (ev, i) {
          histHost.appendChild(h('div.entry', null, [
            h('div.hd', null, [
              h('span.t', { text: ev.title || '未命名经历' }),
              h('button.btn.sm.danger', { text: '✕', onclick: function () { c.history.splice(i, 1); paintHistory(); save(); } })
            ]),
            (function () {
              var g = h('div');
              [['title', '事件标题', '例：阿卡姆调查事件'],
               ['date', '发生时间', '例：1925-03'],
               ['description', '事件描述', '发生了什么…'],
               ['skillChanges', '技能变化', '例：侦查 +3'],
               ['itemsObtained', '获得物品', '例：神秘古书'],
               ['notes', '备注', '']].forEach(function (f) {
                g.appendChild(UI.field(f[1], UI.input({
                  value: ev[f[0]] || '', placeholder: f[2],
                  oninput: function () { ev[f[0]] = this.value; if (f[0] === 'title') save(); save(); }
                })));
              });
              g.appendChild(h('div.grid3', null, [
                UI.field('SAN 变化', UI.input({ type: 'number', value: ev.sanChange || '', placeholder: '-5', oninput: function () { ev.sanChange = this.value; save(); } })),
                UI.field('HP 变化', UI.input({ type: 'number', value: ev.hpChange || '', placeholder: '-2', oninput: function () { ev.hpChange = this.value; save(); } })),
                UI.field('金钱变化', UI.input({ type: 'number', value: ev.moneyChange || '', placeholder: '0', oninput: function () { ev.moneyChange = this.value; save(); } }))
              ]));
              return g;
            })()
          ]));
        });
      }

      /* ---- 调查员伙伴 ---- */
      var compHost = h('div');
      function paintCompanions() {
        UI.clear(compHost);
        if (!c.companions.length) compHost.appendChild(UI.emptyState('👥', '还没有伙伴记录'));
        c.companions.forEach(function (cp, i) {
          compHost.appendChild(h('div.entry', null, [
            h('div.hd', null, [
              h('span.t', { text: cp.name || '未命名 NPC' }),
              h('button.btn.sm.danger', { text: '✕', onclick: function () { c.companions.splice(i, 1); paintCompanions(); save(); } })
            ]),
            h('div.grid2', null, [
              UI.field('姓名', UI.input({ value: cp.name || '', placeholder: '例：约翰', oninput: function () { cp.name = this.value; save(); } })),
              UI.field('身份', UI.input({ value: cp.identity || '', placeholder: '例：大学教授', oninput: function () { cp.identity = this.value; save(); } }))
            ]),
            h('div.grid2', null, [
              UI.field('年龄', UI.input({ value: cp.age || '', placeholder: '', oninput: function () { cp.age = this.value; save(); } })),
              UI.field('关系', UI.input({ value: cp.relationship || '', placeholder: '例：调查搭档', oninput: function () { cp.relationship = this.value; save(); } }))
            ]),
            UI.field('描述', UI.textarea({ value: cp.description || '', placeholder: '例：两年前认识的考古学家。', style: { minHeight: '54px' }, oninput: function () { cp.description = this.value; save(); } }))
          ]));
        });
      }

      /* ---- 克苏鲁神话 ---- */
      var mythosHost = h('div');
      function paintMythos() {
        UI.clear(mythosHost);
        var ms = c.skills.filter(function (s) { return s.id === 'cthulhu'; })[0];
        var val = ms ? ms.total : 0;
        mythosHost.appendChild(h('div.grid2', null, [
          UI.field('克苏鲁神话技能值', h('div', {
            style: { fontFamily: 'var(--mono)', fontSize: '18px', fontWeight: 700, color: 'var(--arcane)' }, text: val + '%'
          }), { help: '在「技能」步骤中分配职业/兴趣点即可提升' }),
          UI.field('克苏鲁知识', UI.input({
            value: c.mythos.knowledge || '', placeholder: '已知的神话学识…',
            oninput: function () { c.mythos.knowledge = this.value; save(); }
          }))
        ]));
        mythosHost.appendChild(UI.field('神话相关经历（非必填）', UI.textarea({
          value: c.mythos.notes || '',
          placeholder: '古籍 / 魔法 / 神话生物 / 第三类接触 / 梦境 / 其他…',
          oninput: function () { c.mythos.notes = this.value; save(); }
        })));
      }

      /* ---- 神话法术 ---- */
      var spellDB = global.COC_SPELLS || [];
      var spellHost = h('div');

      function spells() {
        if (!Array.isArray(c.mythos.spells)) c.mythos.spells = [];
        return c.mythos.spells;
      }

      function paintSpells() {
        UI.clear(spellHost);
        var list = spells();
        if (!list.length) {
          spellHost.appendChild(UI.emptyState('📜', '还没有学会法术', '从法术表选择，或按格式自定义一个'));
          return;
        }
        list.forEach(function (sp, i) {
          var card = h('div.entry', null, [
            h('div.hd', null, [
              h('span.t', { text: sp.name }),
              h('span.tag.arcane', { text: sp.category || '自定义' }),
              h('button.btn.sm.danger', {
                text: '✕', onclick: function () { list.splice(i, 1); paintSpells(); save(); }
              })
            ]),
            h('div.tiny.dim', { style: { lineHeight: '1.8' }, html:
              '消耗：' + UI.esc(sp.cost || '—') + '<br>用时：' + UI.esc(sp.time || '—') }),
            sp.effect ? h('div.small.dim', { style: { marginTop: '6px', lineHeight: '1.7', whiteSpace: 'pre-wrap' }, text: sp.effect }) : null,
            sp.condition ? h('div.tiny.muted', { style: { marginTop: '6px' }, text: '施法条件：' + sp.condition }) : null
          ]);
          if (sp.variants && sp.variants.length) {
            var vh = h('div', { style: { marginTop: '8px' } });
            var btn = h('button.btn.sm.ghost.block', {
              text: '变体 ' + sp.variants.length + ' 种 ▾',
              onclick: function () {
                var box = vh.querySelector('.var-box');
                if (box) { box.remove(); btn.textContent = '变体 ' + sp.variants.length + ' 种 ▾'; return; }
                var nb = h('div.var-box', { style: { marginTop: '7px' } });
                sp.variants.forEach(function (v) {
                  nb.appendChild(h('div', { style: { padding: '7px 0', borderTop: '1px solid var(--border)' } }, [
                    h('div.small', { style: { fontWeight: 600 }, text: v.name + (v.cost && v.cost !== '同基础消耗' ? '（' + v.cost + '）' : '') }),
                    v.note ? h('div.tiny.muted', { text: v.note }) : null
                  ]));
                });
                vh.appendChild(nb);
                btn.textContent = '收起 ▴';
              }
            });
            vh.appendChild(btn);
            card.appendChild(vh);
          }
          spellHost.appendChild(card);
        });
      }

      /** 从法术表选择（深拷贝，之后编辑不会污染数据源） */
      function addSpell(src) {
        spells().push(JSON.parse(JSON.stringify(src)));
        save(); paintSpells();
        // 必须走 closeAllSheets（而不是直接 remove 遮罩节点）：
        // 直接摘 DOM 会绕过 close()，openSheets 栈里留下僵尸记录、
        // 滚动锁计数归不了零，页面会被永久锁住划不动。
        UI.closeAllSheets();
        UI.toast('已学会：' + src.name, 'ok');
      }

      function spellPicker() {
        if (!spellDB.length) { UI.toast('法术数据未加载', 'err'); return; }
        var kw2 = '', cat = '全部';
        var resHost = h('div');
        var inp = UI.input({ placeholder: '搜索法术名 / 效果 / 条件…', oninput: function () { kw2 = inp.value; paintPicker(); } });
        var chipRow = h('div.row.wrap', { style: { gap: '6px', margin: '10px 0' } });
        var cats = ['全部'];
        spellDB.forEach(function (s) { if (cats.indexOf(s.category) < 0) cats.push(s.category); });
        cats.forEach(function (cc) {
          var chip = h('button.chip' + (cat === cc ? '.on' : ''), {
            text: cc, onclick: function () {
              cat = cc;
              Array.prototype.forEach.call(chipRow.children, function (x) { x.classList.remove('on'); });
              chip.classList.add('on');
              paintPicker();
            }
          });
          chipRow.appendChild(chip);
        });

        function paintPicker() {
          UI.clear(resHost);
          var l = spellDB.filter(function (s) {
            if (cat !== '全部' && s.category !== cat) return false;
            if (kw2) {
              var hay = (s.name + ' ' + s.effect + ' ' + (s.condition || '')).toLowerCase();
              if (hay.indexOf(kw2.toLowerCase()) < 0) return false;
            }
            return true;
          });
          if (!l.length) { resHost.appendChild(UI.emptyState('🔍', '没有匹配的法术')); return; }
          l.forEach(function (s) {
            resHost.appendChild(h('button.occ-item', {
              html: '<div class="grow"><div class="nm">' + UI.esc(s.name) + '</div>' +
                    '<div class="meta">' + UI.esc(s.cost) + ' · ' + UI.esc(s.time) + '</div></div>',
              onclick: function () { addSpell(s); }
            }));
          });
        }
        paintPicker();
        UI.sheet({
          title: '法术表（' + spellDB.length + ' 个）',
          body: h('div', null, [inp, chipRow, resHost])
        });
      }

      function customSpell() {
        var nameI = UI.input({ placeholder: '法术名称，如：阿撒托斯的号角' });
        var catI = UI.input({ value: '自定义', placeholder: '分类' });
        var costI = UI.input({ placeholder: '例：8 点魔法值；1D6 点理智值' });
        var timeI = UI.input({ placeholder: '例：1 轮' });
        var effI = UI.textarea({ placeholder: '效果说明…' });
        var condI = UI.input({ placeholder: '施法条件（可选）' });
        var sh;
        sh = UI.sheet({
          title: '自定义法术',
          body: h('div', null, [
            UI.field('名称', nameI, { required: true }),
            h('div.grid2', null, [
              UI.field('分类', catI),
              UI.field('施法用时', timeI)
            ]),
            UI.field('消耗', costI, { help: '按格式写：X 点魔法值 / X 点理智值 / X 点 POW' }),
            UI.field('效果', effI),
            UI.field('施法条件', condI),
            h('button.btn.primary.block', {
              text: '＋ 学会该法术', onclick: function () {
                var nm = nameI.value.trim();
                if (!nm) { UI.toast('法术名称不能为空', 'err'); return; }
                spells().push({
                  id: 'custom_' + Date.now().toString(36),
                  name: nm,
                  category: catI.value.trim() || '自定义',
                  cost: costI.value.trim() || '—',
                  time: timeI.value.trim() || '—',
                  effect: effI.value.trim(),
                  condition: condI.value.trim(),
                  custom: true
                });
                save(); paintSpells(); sh.close();
                UI.toast('已学会：' + nm, 'ok');
              }
            })
          ])
        });
      }

      function paintAll() { paintFields(); paintHistory(); paintCompanions(); paintMythos(); paintSpells(); }

      root.appendChild(h('div.card', null, [
        h('div.card-head', null, [h('h3', { text: '快速套用预设背景' }), h('span.hint', { text: '10 套' })]),
        presetRow
      ]));
      root.appendChild(h('div.card', null, [h('div.card-title', { text: '角色背景' }), fieldsHost]));
      root.appendChild(h('div.card', null, [
        h('div.card-head', null, [h('h3', { text: '疯狂表' }), h('span.hint', { text: '1D10' })]),
        h('button.btn.block', { text: '打开疯狂表 / 随机生成', onclick: madnessSheet })
      ]));
      root.appendChild(h('div.card', null, [
        h('div.card-head', null, [h('h3', { text: '调查员经历' }), h('span.hint', { text: c.history.length + ' 条' })]),
        histHost,
        h('button.btn.primary.block', { text: '＋ 添加经历', style: { marginTop: '11px' }, onclick: function () { c.history.push({ title: '', date: '', description: '', sanChange: '', hpChange: '', skillChanges: '', moneyChange: '', itemsObtained: '', notes: '' }); paintHistory(); save(); } })
      ]));
      root.appendChild(h('div.card', null, [
        h('div.card-head', null, [h('h3', { text: '调查员伙伴' }), h('span.hint', { text: c.companions.length + ' 位' })]),
        compHost,
        h('button.btn.primary.block', { text: '＋ 添加伙伴', style: { marginTop: '11px' }, onclick: function () { c.companions.push({ name: '', avatar: '', identity: '', age: '', relationship: '', description: '' }); paintCompanions(); save(); } })
      ]));
      root.appendChild(h('div.card', null, [
        h('div.card-head', null, [h('h3', { text: '克苏鲁神话' })]),
        mythosHost
      ]));
      root.appendChild(h('div.card', null, [
        h('div.card-head', null, [
          h('h3', { text: '已学会的法术' }),
          h('span.hint', { text: spells().length + ' 个' })
        ]),
        spellHost,
        h('div.btn-group', { style: { marginTop: '11px' } }, [
          h('button.btn.teal.grow', { text: '📜 从法术表选择', onclick: spellPicker }),
          h('button.btn.ghost.grow', { text: '✎ 自定义法术', onclick: customSpell })
        ]),
        h('div.tiny.muted', {
          style: { marginTop: '10px', lineHeight: '1.7' },
          text: '提示：法术不是调查员的超能力，每次施放都在蚕食理智。学会途径只有阅读神话典籍或他人传授。'
        })
      ]));

      paintAll();
    }
  };

  /* ============================================================
   * 步骤 8：完成
   * ============================================================ */
  global.Steps.finish = {
    id: 'finish', title: '完成角色卡', short: '完成', icon: '9',
    sub: '完整性检查通过后即可保存并生成分享链接。',
    render: function (root, ctx) {
      var c = ctx.character;
      Engine.recalc(c);
      /* 编辑已保存的角色时，这一步不是「新建一张卡然后落库」，
         而是「把改动写回原来的卡」—— 文案和动作都要跟着变。 */
      var editing = Store.isEditing();

      var checkHost = h('div');
      var actionHost = h('div');

      function paintCheck() {
        UI.clear(checkHost);
        var list = Engine.checkList(c);
        var bad = list.filter(function (x) { return !x.ok; });
        var box = h('div.card.flush');
        box.appendChild(h('div.card-head', { style: { margin: '0', borderRadius: '0' } }, [
          h('h3', { text: '完整性检查' }),
          h('span.hint', { text: bad.length ? (bad.length + ' 个问题') : '全部通过' })
        ]));
        list.forEach(function (x) {
          box.appendChild(h('div.chk-row', {
            onclick: x.ok ? null : function () { ctx.goStep(x.step); }
          }, [
            h('div.mk' + (x.ok ? '' : '.bad'), { text: x.ok ? '✓' : '!' }),
            h('div.tx', null, [
              h('div', { text: x.label }),
              (!x.ok && x.detail) ? h('div.tiny', { text: x.detail, style: { color: 'var(--danger)', marginTop: '2px' } }) : null
            ]),
            x.ok ? null : h('div.go', { text: '去修复 →' })
          ]));
        });
        checkHost.appendChild(box);
        return bad;
      }

      function paintActions(bad) {
        UI.clear(actionHost);
        actionHost.appendChild(h('div.btn-group', { style: { gap: '9px' } }, [
          h('button.btn.ghost.grow', { text: '👁 预览角色卡', onclick: function () { global.App.viewSheet(c); } }),
          h('button.btn.primary.grow', {
            text: editing
              ? '💾 保存修改'
              : (bad.length ? '仍要完成（' + bad.length + ' 个问题）' : '✓ 完成角色卡'),
            onclick: function () {
              if (editing) { global.App.saveEdit(); return; }
              if (bad.length) {
                UI.confirm('当前还有 ' + bad.length + ' 个问题未解决，完成后这些数据仍会被保存，但角色卡不符合规则。确定继续吗？',
                  { okText: '继续完成', danger: true }).then(function (ok) { if (ok) doFinish(); });
              } else doFinish();
            }
          })
        ]));

        if (editing) {
          // 编辑模式下绝不能写「已保存到本机」—— 那正是用户踩过的坑
          actionHost.appendChild(h('div.card', { style: { marginTop: '12px' } }, [
            h('div.card-title', { text: '✎ 正在编辑已保存的角色' }),
            h('div.tiny.muted', { style: { lineHeight: '1.8' }, text:
              '这一页的所有改动都还没有写回角色卡。点上面的「保存修改」才会生效；' +
              '点左侧栏顶部的「↩ 放弃」则丢弃全部改动，角色卡恢复原样。' })
          ]));
        } else if (c.shareId || global.CocShare.getFor(c.id)) {
          actionHost.appendChild(h('div.card', { style: { marginTop: '12px' } }, [
            h('div.card-title', { text: '✓ 已保存到本机' }),
            h('div.tiny.muted', { text: '本机角色 ID' }),
            h('div', { text: c.id, style: { fontFamily: 'var(--mono)', fontSize: '15px', fontWeight: 700, color: 'var(--gold-str)' } }),
            h('div.btn-group', { style: { marginTop: '11px' } }, [
              h('button.btn.sm.grow', { text: '🖼 生成图片', onclick: function () { global.App.exportImage(c); } }),
              h('button.btn.sm.grow', {
                text: '💾 导出存档', onclick: function () {
                  var json = Store.exportCharacter(c.id);
                  if (UI.saveFile('coc7-' + (c.characterName || 'character') + '.json', json, 'text')) UI.toast('已导出', 'ok');
                }
              })
            ])
          ]));
        }

        // 云分享：上传到用户自己的服务器，生成真正可以发给别人的只读链接
        if (global.ShareUI) {
          actionHost.appendChild(global.ShareUI.panel(c, function () { paintActions(bad); }).el);
        }
      }

      function doFinish() {
        var cc = Store.finalize();
        Engine.recalc(cc);
        Store.saveNow();
        UI.toast('「' + (cc.characterName || '角色卡') + '」已完成并保存', 'ok', 2400);
        // 完成后按要求跳回首页：角色已进「最近的调查员」，从那里可继续分享/生成图片
        if (global.App && global.App.goHome) global.App.goHome();
      }

      /* 供底栏「✓ 完成 / 💾 保存修改」按钮调用：与页面内按钮行为完全一致 */
      ctx.finishAction = function () {
        // 编辑已保存的角色 → 交给 App 的保存流程（它会再问一次问题清单）
        if (Store.isEditing()) { global.App.saveEdit(); return; }
        var bad = Engine.checkList(c).filter(function (x) { return !x.ok; });
        if (bad.length) {
          UI.confirm('当前还有 ' + bad.length + ' 个问题未解决，完成后这些数据仍会被保存，但角色卡不符合规则。确定继续吗？',
            { okText: '继续完成', cancelText: '回去检查', danger: true })
            .then(function (ok) { if (ok) doFinish(); });
        } else {
          doFinish();
        }
      };

      root.appendChild(h('div.card', null, [
        h('div.card-title', { text: '角色摘要' }),
        h('div.row', { style: { gap: '12px', alignItems: 'flex-start' } }, [
          (function () {
            var av = h('div.pick-avatar', { style: { width: '64px', height: '64px', flex: '0 0 64px' } });
            if (c.avatar) av.appendChild(h('img', { src: c.avatar }));
            else av.appendChild(h('div', { text: '◈' }));
            return av;
          })(),
          h('div.grow', null, [
            h('div', { text: c.characterName || '（未命名）', style: { fontSize: '18px', fontWeight: 700, fontFamily: 'var(--serif)' } }),
            h('div.tiny.muted', { text: '玩家：' + (c.playerName || '—') + '　' + (c.basicInfo.gender || '') + '　' + (c.basicInfo.age || '—') + ' 岁　' + (c.basicInfo.era || '') }),
            h('div.row.wrap', { style: { gap: '5px', marginTop: '7px' } }, [
              h('span.tag.gold', { text: (OCC.getById(c.occupationId) || {}).name || '未选职业' }),
              h('span.tag', { text: 'HP ' + (c.derivedStats.maxHP || 0) }),
              h('span.tag', { text: 'SAN 上限 ' + (c.derivedStats.maxSAN || 0) }),
              h('span.tag', { text: '技能上限 本职 ' + (c.skillCapOcc || 99) + '% / 兴趣 ' + (c.skillCapInterest || 99) + '%' })
            ])
          ])
        ])
      ]));
      root.appendChild(checkHost);
      root.appendChild(actionHost);

      var bad = paintCheck();
      paintActions(bad);
    }
  };
})(window);
