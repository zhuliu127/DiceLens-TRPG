/* ============================================================
 * steps-c.js — 步骤 4 战斗 / 步骤 5 装备 / 步骤 6 资产
 * ============================================================ */
(function (global) {
  'use strict';
  var h = UI.h;
  var R = global.COC7;
  var OCC = global.CocOccupation;

  global.Steps = global.Steps || {};

  /* ============================================================
   * 步骤 4：战斗（武器 / 防具 / 载具）
   * ============================================================ */
  global.Steps.combat = {
    id: 'combat', title: '战斗装备', short: '战斗', icon: '6',
    sub: '武器、防具与载具。伤害加值由力量+体型自动得出。',
    render: function (root, ctx) {
      var c = ctx.character;

      function save() { Store.scheduleSave(); }

      /* ============================================================
       * 武器「使用技能」清单
       *   只列真正能拿来打人的技能：格斗各门类 + 射击各门类 + 投掷/炮术/爆破。
       *   之前这里是个自由文本框，能填出「心理学」这种根本打不了架的技能。
       *   选项与武器库列表都带上角色当前技能值，看成功率不用来回翻页。
       * ============================================================ */
      // 武器表里的写法与技能表里的专攻名不完全一致，这里做一次别名归一
      var WEAPON_SKILL_ALIAS = {
        '剑': '刀剑', '鞭子': '鞭', '绞具': '绞索', '链枷': '链锯/连枷', '电锯': '链锯/连枷',
        '机枪': '机枪/重武器/火焰喷射器', '重武器': '机枪/重武器/火焰喷射器',
        '喷射器': '机枪/重武器/火焰喷射器'
      };
      var EXTRA_COMBAT_SKILLS = ['投掷', '炮术', '爆破'];
      var occSet = OCC.occupationalSet(c);

      /** 查角色当前某技能的值；技能还没进列表时退回到数据库基础值 */
      function skillTotalOf(name) {
        var target = WEAPON_SKILL_ALIAS[name] || name;
        var list = c.skills || [];
        for (var i = 0; i < list.length; i++) {
          var s = list[i];
          if (s.name === target || s.sub === target ||
              (s.sub && s.name.indexOf('（' + target + '）') >= 0)) {
            return { total: s.total || 0, occ: !!(occSet[s.key] || occSet[s.id]) };
          }
        }
        var defs = global.COC_SKILLS || [];
        for (var d = 0; d < defs.length; d++) {
          var def = defs[d];
          if (def.special) {
            var subs = def.subskills || [];
            for (var k = 0; k < subs.length; k++) {
              if (subs[k].name === target) return { total: subs[k].base, occ: false };
            }
          } else if (def.name === target) {
            return { total: global.SkillModel.baseValue(c, def.id, ''), occ: false };
          }
        }
        return { total: 0, occ: false };
      }

      /** 「斗殴　45%（本职）」这样的选项文案 */
      function weaponSkillOptions() {
        var seen = {}, out = [];
        function add(name) {
          if (!name || seen[name]) return;
          seen[name] = true;
          var st = skillTotalOf(name);
          out.push({ value: name, label: name + '　' + st.total + '%' + (st.occ ? '（本职）' : '') });
        }
        (global.COC_SKILLS || []).forEach(function (def) {
          if (def.id === 'fighting' || def.id === 'firearms') {
            (def.subskills || []).forEach(function (sub) { add(sub.name); });
          }
        });
        EXTRA_COMBAT_SKILLS.forEach(add);
        return out;
      }

      /** 技能成功率三点提示文案 */
      function skillChanceText(name) {
        var st = skillTotalOf(name);
        return name + '：常规 ' + st.total + '%　困难 ' + Math.floor(st.total / 2) +
               '%　极难 ' + Math.floor(st.total / 5) + '%' + (st.occ ? '（本职技能）' : '');
      }

      /* ---------- 武器 ---------- */
      var wHost = h('div');
      function paintWeapons() {
        UI.clear(wHost);
        if (!c.weapons.length) {
          wHost.appendChild(UI.emptyState('⚔', '尚未添加武器', '从武器库中选择，或自定义一把'));
        }
        c.weapons.forEach(function (w, i) {
          var st = w.skill ? skillTotalOf(w.skill) : null;
          var card = h('div.entry', null, [
            h('div.hd', null, [
              h('span.t', { text: w.name }),
              w.category ? h('span.tag', { text: w.category }) : null,
              h('span.tag.gold', { text: '×' + (w.qty || 1) })
            ]),
            h('div.tiny.dim', { style: { lineHeight: '1.75' } }, [
              '技能 ' + (w.skill || '—') + (st && st.total ? '（' + st.total + '%）' : '') +
              '　伤害 ' + (w.damage || '—') + (w.pierce === '√' ? '（贯穿）' : '') +
              '　射程 ' + (w.range || '—') +
              '　连发 ' + (w.perRound || '—') +
              '　装弹 ' + (w.ammo || '—') +
              '　故障 ' + (w.malfunction || '—') +
              (w.broken ? '　⛔ 已损坏' : '')
            ]),
            st && st.total ? h('div.tiny.muted', {
              text: '成功率：常规 ' + st.total + '%　困难 ' + Math.floor(st.total / 2) + '%　极难 ' + Math.floor(st.total / 5) + '%',
              style: { marginTop: '3px' }
            }) : null,
            w.note ? h('div.tiny.muted', { text: w.note, style: { marginTop: '4px' } }) : null,
            h('div.row', { style: { marginTop: '9px', gap: '7px' } }, [
              h('button.btn.sm.ghost', { text: '编辑', onclick: function () { editWeapon(i); } }),
              h('div.grow'),
              h('button.btn.sm.ghost', { text: '−', onclick: function () { w.qty = Math.max(1, (w.qty || 1) - 1); paintWeapons(); save(); } }),
              h('span.small', { text: (w.qty || 1) + ' 件' }),
              h('button.btn.sm.ghost', { text: '＋', onclick: function () { w.qty = (w.qty || 1) + 1; paintWeapons(); save(); } }),
              h('button.btn.sm.danger', { text: '删除', onclick: function () { c.weapons.splice(i, 1); paintWeapons(); save(); ctx.refreshBar(); } })
            ])
          ]);
          wHost.appendChild(card);
        });
      }

      /** 武器编辑表单（库选择 / 自定义共用） */
      function weaponForm(init, onSave, title) {
        var w = Object.assign({
          name: '', skill: '斗殴', damage: '', range: '', pierce: '', perRound: '',
          ammo: '', malfunction: '', era: '', price: '', category: '自定义', note: '', qty: 1
        }, init || {});
        var F = {};

        /* 使用技能：下拉选择，只给战斗类技能 */
        var skillChoice = { v: w.skill || '斗殴' };
        var skillOpts = weaponSkillOptions();
        // 旧数据/武器库里出现了清单外的写法时保留原值，避免一保存就被改掉
        if (!skillOpts.some(function (o) { return o.value === skillChoice.v; })) {
          skillOpts.unshift({ value: skillChoice.v, label: skillChoice.v + '（武器自带）' });
        }
        var skillHint = h('div.help');
        function paintSkillHint() { skillHint.textContent = skillChanceText(skillChoice.v); }
        paintSkillHint();
        var skillCtl = UI.select(skillOpts, skillChoice.v, function (v) {
          skillChoice.v = v; paintSkillHint();
        });

        /* v2.3.0（用户第 10 项）：贯穿 / 连发两个新输入（装弹量 / 故障值已有）。
           贯穿用下拉（√ / ×）；连发用文本（形如 1 / 1(2) / 1(3)or全自动）。
           ⚠️ 保存时不能只取表单键 —— 否则 era / price / id 等 init 字段会被丢掉
           （旧实现 `Object.keys(F)` 就是这么丢 pierce/perRound 的）。 */
        var pierceOpts = [
          { value: '×', label: '× 不贯穿' },
          { value: '√', label: '√ 贯穿' }
        ];
        if (w.pierce !== '√') w.pierce = '×';
        var pierceSel = UI.select(pierceOpts, w.pierce, function (v) { w.pierce = v; });

        var body = h('div', null, [
          UI.field('武器名称', (F.name = UI.input({ value: w.name || '', placeholder: '例：左轮手枪' }))),
          h('div.grid2', null, [
            UI.field('使用技能', h('div', null, [skillCtl, skillHint])),
            UI.field('类型', (F.category = UI.input({ value: w.category || '' })))
          ]),
          h('div.grid2', null, [
            UI.field('伤害', (F.damage = UI.input({ value: w.damage || '' }))),
            UI.field('射程', (F.range = UI.input({ value: w.range || '' })))
          ]),
          h('div.grid3', null, [
            UI.field('贯穿', pierceSel),
            UI.field('连发（每轮）', (F.perRound = UI.input({ value: w.perRound || '', placeholder: '1 / 1(2) / 1(3)or全自动' }))),
            UI.field('装弹量', (F.ammo = UI.input({ value: w.ammo || '' })))
          ]),
          h('div.grid2', null, [
            UI.field('故障值', (F.malfunction = UI.input({ value: w.malfunction || '', placeholder: '99 / 100 / ——' }))),
            UI.field('数量', (F.qty = UI.input({ type: 'number', value: w.qty || 1 })))
          ]),
          UI.field('备注', (F.note = UI.textarea({ value: w.note || '' }))),
          h('button.btn.primary.block', {
            text: '保存武器', onclick: function () {
              if (!F.name.value.trim()) { UI.toast('武器名称不能为空', 'err'); return; }
              var out = {};
              Object.keys(F).forEach(function (k) { out[k] = F[k].value; });
              /* v2.3.0（用户第 10 项）修保存丢字段：以 init 为底，叠加表单值 ——
                 init 里未被表单覆盖的字段（era/price/id…）得以保留。 */
              var merged = Object.assign({}, init || {}, out);
              merged.skill = skillChoice.v;                 // 下拉值单独取
              merged.pierce = (w.pierce === '√') ? '√' : '×';
              merged.qty = parseInt(out.qty, 10) || 1;
              onSave(merged);
              sh.close();
            }
          })
        ]);
        var sh = UI.sheet({ title: title, body: body });
      }

      function editWeapon(i) {
        weaponForm(c.weapons[i], function (w) {
          c.weapons[i] = w; paintWeapons(); save(); UI.toast('已保存', 'ok');
        }, '编辑武器');
      }

      function pickWeapon() {
        var kw = '';
        var host = h('div.scroll-area');
        var inp = UI.input({ placeholder: '搜索武器…', oninput: function () { kw = inp.value; paint(); } });
        function paint() {
          UI.clear(host);
          var list = global.COC_WEAPONS.filter(function (w) {
            return !kw || w.name.indexOf(kw) >= 0 || (w.skill || '').indexOf(kw) >= 0;
          });
          var curCat = null;
          list.forEach(function (w) {
            if (w.category && w.category !== curCat) {
              curCat = w.category;
              host.appendChild(h('div', {
                text: curCat, style: { padding: '9px 4px 4px', fontSize: '11.5px', color: 'var(--text-mute)', fontWeight: 700 }
              }));
            }
            // 顺带把「用这个技能当前能打出什么成功率」标出来
            var st = w.skill ? skillTotalOf(w.skill) : { total: 0 };
            host.appendChild(h('button.occ-item', {
              html: '<div class="grow"><div class="nm">' + UI.esc(w.name) + '</div>' +
                    '<div class="meta">技能 ' + UI.esc(w.skill) +
                      (st.total ? ' <b>' + st.total + '%</b>' : '') +
                      ' · 伤害 ' + UI.esc(w.damage) + ' · 射程 ' + UI.esc(w.range || '—') +
                      ' · ' + UI.esc(w.era || '') + '</div></div>' +
                    (st.total ? '<div class="occ-pts"><b>' + st.total + '</b><span>成功率</span></div>' : ''),
              onclick: function () {
                c.weapons.push(Object.assign({}, w, { qty: 1 }));
                paintWeapons(); save(); sh.close(); ctx.refreshBar();
                UI.toast('已添加 ' + w.name, 'ok');
              }
            }));
          });
          if (!list.length) host.appendChild(UI.emptyState('🔍', '没有匹配的武器'));
        }
        paint();
        var sh = UI.sheet({ title: '武器库（' + global.COC_WEAPONS.length + ' 件）', body: h('div', null, [inp, host]) });
      }

      /* ---------- 防具 ---------- */
      var aHost = h('div');
      function paintArmors() {
        UI.clear(aHost);
        if (!c.armors.length) aHost.appendChild(UI.emptyState('🛡', '尚未装备防具'));
        c.armors.forEach(function (a, i) {
          aHost.appendChild(h('div.entry', null, [
            h('div.hd', null, [
              h('span.t', { text: a.name }),
              h('span.tag.teal', { text: '护甲 ' + (a.armor || '—') }),
              a.movPenalty && a.movPenalty !== '0' && a.movPenalty !== '——' ? h('span.tag.danger', { text: 'MOV ' + a.movPenalty }) : null
            ]),
            h('div.tiny.dim', null, ['覆盖 ' + (a.cover || '—') + '　时代 ' + (a.era || '—') + '　价格 ' + (a.price || '—')]),
            a.protectLevel ? h('div.tiny.muted', { text: '防护：' + a.protectLevel, style: { marginTop: '3px' } }) : null,
            h('div.row', { style: { marginTop: '8px' } }, [
              h('div.grow'),
              h('button.btn.sm.danger', { text: '移除', onclick: function () { c.armors.splice(i, 1); paintArmors(); save(); } })
            ])
          ]));
        });
      }

      function pickArmor() {
        var kw = '';
        var host = h('div.scroll-area');
        var inp = UI.input({ placeholder: '搜索防具 / 掩体…', oninput: function () { kw = inp.value; paint(); } });
        function paint() {
          UI.clear(host);
          var list = global.COC_ARMORS.filter(function (a) { return !kw || a.name.indexOf(kw) >= 0; });
          list.forEach(function (a) {
            host.appendChild(h('button.occ-item', {
              html: '<div class="grow"><div class="nm">' + UI.esc(a.name) + '</div>' +
                    '<div class="meta">护甲 ' + UI.esc(a.armor) + ' · 覆盖 ' + UI.esc(a.cover || '—') + ' · MOV ' + UI.esc(a.movPenalty || '—') + '</div></div>',
              onclick: function () {
                c.armors.push(Object.assign({}, a));
                paintArmors(); save(); sh.close(); UI.toast('已装备 ' + a.name, 'ok');
              }
            }));
          });
        }
        paint();
        var sh = UI.sheet({ title: '防具表（' + global.COC_ARMORS.length + ' 项）', body: h('div', null, [inp, host]) });
      }

      /* ---------- 载具 ---------- */
      var vHost = h('div');
      function paintVehicles() {
        UI.clear(vHost);
        if (!c.vehicles.length) vHost.appendChild(UI.emptyState('🚗', '尚未拥有载具'));
        c.vehicles.forEach(function (v, i) {
          vHost.appendChild(h('div.entry', null, [
            h('div.hd', null, [h('span.t', { text: v.name }), h('span.tag', { text: 'MOV ' + (v.mov || '—') })]),
            h('div.tiny.dim', null, ['技能 ' + (v.skill || '—') + '　体格 ' + (v.build || '—') + '　载员 ' + (v.capacity || '—') + '　护甲 ' + (v.armor || '—')]),
            h('div.row', { style: { marginTop: '8px' } }, [
              h('div.grow'),
              h('button.btn.sm.danger', { text: '移除', onclick: function () { c.vehicles.splice(i, 1); paintVehicles(); save(); } })
            ])
          ]));
        });
      }

      function pickVehicle() {
        var host = h('div.scroll-area');
        global.COC_VEHICLES.forEach(function (v) {
          host.appendChild(h('button.occ-item', {
            html: '<div class="grow"><div class="nm">' + UI.esc(v.name) + '</div>' +
                  '<div class="meta">MOV ' + UI.esc(v.mov) + ' · 技能 ' + UI.esc(v.skill) + '</div></div>',
            onclick: function () {
              c.vehicles.push(Object.assign({}, v));
              paintVehicles(); save(); sh.close(); UI.toast('已添加 ' + v.name, 'ok');
            }
          }));
        });
        var sh = UI.sheet({ title: '载具表（' + global.COC_VEHICLES.length + ' 种）', body: host });
      }

      /* ---------- 组装 ---------- */
      var d = c.derivedStats || {};
      root.appendChild(h('div.card', null, [
        h('div.card-title', { text: '近战修正（自动）' }),
        h('div.row.wrap', { style: { gap: '8px' } }, [
          h('span.tag.gold', { text: '伤害加值 DB ' + (d.db || '0') }),
          h('span.tag', { text: '体格 Build ' + (d.build === undefined ? '—' : d.build) }),
          h('span.tag', { text: '力量+体型 = ' + ((parseInt(c.attributes.str, 10) || 0) + (parseInt(c.attributes.siz, 10) || 0)) })
        ]),
        h('div.help', { text: '力量+体型合计值每超过一个 80，再 +1D6 伤害加成与 +1 体格。' })
      ]));
      root.appendChild(h('div.card', null, [
        h('div.card-head', null, [h('h3', { text: '武器' }), h('span.hint', { text: c.weapons.length + ' 件' })]),
        wHost,
        h('div.btn-group', { style: { marginTop: '11px' } }, [
          h('button.btn.primary.grow', { text: '＋ 从武器库选择', onclick: pickWeapon }),
          h('button.btn.ghost.grow', { text: '＋ 自定义武器', onclick: function () { weaponForm({}, function (w) { c.weapons.push(w); paintWeapons(); save(); }, '自定义武器'); } })
        ])
      ]));
      root.appendChild(h('div.card', null, [
        h('div.card-head', null, [h('h3', { text: '防具 / 护甲' }), h('span.hint', { text: c.armors.length + ' 项' })]),
        aHost,
        h('button.btn.primary.block', { text: '＋ 从防具表选择', style: { marginTop: '11px' }, onclick: pickArmor })
      ]));
      root.appendChild(h('div.card', null, [
        h('div.card-head', null, [h('h3', { text: '载具' }), h('span.hint', { text: c.vehicles.length + ' 项' })]),
        vHost,
        h('button.btn.primary.block', { text: '＋ 从载具表选择', style: { marginTop: '11px' }, onclick: pickVehicle })
      ]));

      paintWeapons(); paintArmors(); paintVehicles();
    }
  };

  /* ============================================================
   * 步骤 5：随身物品
   * ============================================================ */
  global.Steps.gear = {
    id: 'gear', title: '随身物品', short: '装备', icon: '7',
    sub: '调查员随身携带的装备清单。',
    render: function (root, ctx) {
      var c = ctx.character;
      var PRESETS = ['手电筒', '手机', '钱包', '打火机', '急救包', '相机', '笔记本', '绳索', '瑞士军刀', '雨伞'];

      var host = h('div');
      function paint() {
        UI.clear(host);
        if (!c.items.length) {
          host.appendChild(UI.emptyState('🎒', '背包是空的', '点击下方添加物品'));
        }
        c.items.forEach(function (it, i) {
          host.appendChild(h('div.entry', null, [
            h('div.row', { style: { gap: '9px', alignItems: 'flex-start' } }, [
              h('div.grow', null, [
                UI.input({
                  value: it.name || '', placeholder: '物品名称',
                  oninput: function () { it.name = this.value; Store.scheduleSave(); }
                })
              ]),
              h('div', { style: { width: '92px' } }, [
                UI.input({
                  type: 'number', value: it.quantity || 1, placeholder: '数量',
                  oninput: function () { it.quantity = parseInt(this.value, 10) || 1; Store.scheduleSave(); }
                })
              ]),
              h('button.btn.sm.danger', {
                text: '✕', style: { padding: '11px 12px' },
                onclick: function () { c.items.splice(i, 1); paint(); Store.scheduleSave(); ctx.refreshBar(); }
              })
            ]),
            UI.textarea({
              value: it.description || '', placeholder: '描述 / 用途（可选）',
              style: { marginTop: '8px', minHeight: '52px' },
              oninput: function () { it.description = this.value; Store.scheduleSave(); }
            })
          ]));
        });
      }

      function add(name) {
        c.items.push({ name: name || '', quantity: 1, description: '' });
        paint(); Store.scheduleSave(); ctx.refreshBar();
      }

      var presetRow = h('div.row.wrap', { style: { gap: '7px' } });
      PRESETS.forEach(function (p) {
        presetRow.appendChild(h('button.chip', {
          text: '＋ ' + p, onclick: function () { add(p); UI.toast('已添加 ' + p, 'ok'); }
        }));
      });

      root.appendChild(h('div.card', null, [
        h('div.card-head', null, [h('h3', { text: '常用物品快捷添加' })])
        , presetRow
      ]));
      root.appendChild(h('div.card', null, [
        h('div.card-head', null, [h('h3', { text: '物品清单' }), h('span.hint', { text: c.items.length + ' 项' })]),
        host,
        h('button.btn.primary.block', { text: '＋ 添加物品', style: { marginTop: '11px' }, onclick: function () { add(''); } })
      ]));
      paint();
    }
  };

  /* ============================================================
   * 步骤 6：资产
   * ============================================================ */
  global.Steps.assets = {
    id: 'assets', title: '资产与信用评级', short: '资产', icon: '4',
    sub: '信用评级必须在职业允许范围内，且会占用职业点数。先定信用评级，再分配技能点。',
    render: function (root, ctx) {
      var c = ctx.character;
      var A = global.COC_ASSETS;
      var SM = global.SkillModel;

      function save() { Store.scheduleSave(); }
      function num(v) { var n = parseInt(v, 10); return isNaN(n) ? 0 : n; }

      SM.syncSkills(c);
      var occ = OCC.getById(c.occupationId);
      var creditSkill = c.skills.filter(function (x) { return x.id === 'credit'; })[0];

      /* ============================================================
       * 信用评级
       * 输入框只创建一次：早期版本每次 oninput 都重建整个区块，
       * 导致焦点丢失、软键盘被收起，而且没输完就被判"超出范围"。
       * ============================================================ */
      var crNotice = h('div');
      var crChips = h('div.row.wrap', { style: { gap: '7px', marginTop: '10px' } });
      var lvHost = h('div');

      function creditPoints() { return creditSkill ? (creditSkill.occ || 0) : 0; }

      /** 把资产里的信用评级同步到 credit 技能（基础值 0，整数值都靠职业点买） */
      function syncCreditSkill() {
        var cr = parseInt(c.assets.creditRating, 10) || 0;
        if (creditSkill) {
          creditSkill.occ = cr;
          SM.recompute(creditSkill);
        }
        return cr;
      }

      function refreshCreditNotice() {
        UI.clear(crNotice);
        var cr = parseInt(c.assets.creditRating, 10) || 0;

        if (!occ) {
          crNotice.appendChild(UI.notice('尚未选择职业，无法校验信用评级范围。请先回到「职业」步骤。', 'warn'));
          return;
        }
        if (occ.creditMin === null || occ.creditMin === undefined) {
          crNotice.appendChild(UI.notice('职业「' + occ.name + '」没有规定信用评级范围。', 'ok'));
        } else if (cr === 0) {
          crNotice.appendChild(UI.notice('请分配信用评级。「' + occ.name + '」允许 ' + occ.creditMin + ' - ' + occ.creditMax + '。', 'warn'));
        } else if (cr < occ.creditMin || cr > occ.creditMax) {
          crNotice.appendChild(UI.notice('当前 ' + cr + ' 超出「' + occ.name + '」允许的 ' + occ.creditMin + ' - ' + occ.creditMax + '，请调整。', 'err'));
        } else {
          crNotice.appendChild(UI.notice('信用评级 ' + cr + ' 合法。「' + occ.name + '」允许 ' + occ.creditMin + ' - ' + occ.creditMax + '，本次占用职业点 ' + creditPoints() + ' 点。', 'ok'));
        }

        // 职业点预算一览
        var pts = OCC.occupationPoints(c);
        var other = pts.used - creditPoints();
        var over = pts.used > pts.total;
        crNotice.appendChild(h('div.tiny', {
          style: { marginTop: '8px', color: over ? 'var(--danger)' : 'var(--text-mute)' },
          text: '职业点数：总计 ' + pts.total + '　信用评级占用 ' + creditPoints() +
                '　其它技能占用 ' + other + '　剩余 ' + (pts.total - pts.used) + (over ? '（已超额）' : '')
        }));

        /* 「AI 设置」里的技能上限：它压的是**每个技能最终值**，
           不是点数池。点数池始终是规则算出的全额（上面那行），
           所以这里只提示「每项最多能到多少」，避免玩家误以为点数被削了。 */
        var occCapV = num(c.skillCapOcc) || num(c.skillCap);
        var intCapV = num(c.skillCapInterest) || num(c.skillCap);
        if (occCapV > 0 || intCapV > 0) {
          crNotice.appendChild(h('div.help', {
            style: { marginTop: '8px' },
            text: '技能最终值上限' +
              (occCapV > 0 ? '：本职技能最多 ' + occCapV : '') +
              (occCapV > 0 && intCapV > 0 ? '　·　' : '') +
              (intCapV > 0 ? '非本职技能最多 ' + intCapV : '') +
              '。点数池不因此减少，但如果所有技能都到上限，剩余点数就无法分配。'
          }));
        }
      }

      function paintChips() {
        UI.clear(crChips);
        if (!occ || occ.creditMin === null || occ.creditMin === undefined) return;
        var mid = Math.floor((occ.creditMin + occ.creditMax) / 2);
        [
          ['职业下限', occ.creditMin],
          ['中位', mid],
          ['职业上限', occ.creditMax]
        ].forEach(function (p) {
          crChips.appendChild(h('button.chip', {
            text: p[0] + ' ' + p[1],
            onclick: function () { setCredit(p[1]); }
          }));
        });
        // 这一个就是"采用建议值"，会把信用评级真正写进去
        crChips.appendChild(h('button.chip.on', {
          text: '采用建议值 ' + mid,
          onclick: function () { setCredit(mid); }
        }));
      }

      function setCredit(v) {
        c.assets.creditRating = v;
        if (crInput) crInput.value = String(v);
        syncCreditSkill();
        Engine.recalc(c);
        save();
        refreshCreditNotice(); paintLevel(); ctx.refreshBar();
        UI.toast('信用评级已设为 ' + v, 'ok');
      }

      var crInput = UI.input({
        type: 'text', inputmode: 'numeric', value: c.assets.creditRating || '',
        placeholder: occ && occ.creditMin !== null && occ.creditMin !== undefined
          ? (occ.creditMin + ' - ' + occ.creditMax) : '0 - 99',
        oninput: function () {
          // 只更新数据与提示，绝不重建输入框本身
          var v = crInput.value.replace(/[^\d]/g, '').slice(0, 3);
          if (v !== crInput.value) crInput.value = v;
          c.assets.creditRating = v === '' ? 0 : parseInt(v, 10);
          syncCreditSkill();
          Engine.recalc(c);
          save();
          refreshCreditNotice(); paintLevel(); ctx.refreshBar();
        },
        onblur: function () {
          var cr = parseInt(c.assets.creditRating, 10) || 0;
          if (occ && occ.creditMin !== null && occ.creditMin !== undefined && cr &&
              (cr < occ.creditMin || cr > occ.creditMax)) {
            UI.toast('信用评级需在 ' + occ.creditMin + ' - ' + occ.creditMax + ' 之间', 'err', 2600);
          }
        }
      });

      function levelOf(cr) {
        for (var i = 0; i < A.livingLevels.length; i++) {
          var L = A.livingLevels[i];
          if (cr >= L.crMin && cr <= L.crMax) return L;
        }
        return A.livingLevels[0];
      }

      function paintLevel() {
        UI.clear(lvHost);
        var cr = parseInt(c.assets.creditRating, 10) || 0;
        var L = levelOf(cr);
        c.assets.spendingLevel = L.level;
        if (spendEl) spendEl.value = L.level;
        lvHost.appendChild(h('div.notice', { text: L.level + '：' + L.desc, ico: '◈', style: { marginBottom: '11px' } }));

        var cur = A.currencies.filter(function (x) { return x.era === c.basicInfo.era; })[0] || A.currencies[1];
        c.assets.currency = cur.unit;
        var row = cur.mul.filter(function (m) { return m[0] === L.level; })[0];
        if (row && cr > 0) {
          var cash = row[1] > 100 ? row[1] : row[1] * cr;
          var asset = row[2] > 1000 ? row[2] : row[2] * cr;
          lvHost.appendChild(h('div.card', null, [
            h('div.card-title', { text: '参考数值（' + cur.era + ' · ' + cur.region + '）' }),
            h('div.grid2', null, [
              h('div', null, [
                h('div.tiny.muted', { text: '建议现金' }),
                h('div', { text: cur.unit + ' ' + Math.round(cash), style: { fontFamily: 'var(--mono)', fontSize: '17px', fontWeight: 700, color: 'var(--gold-str)' } })
              ]),
              h('div', null, [
                h('div.tiny.muted', { text: '建议其他资产' }),
                h('div', { text: cur.unit + ' ' + Math.round(asset), style: { fontFamily: 'var(--mono)', fontSize: '17px', fontWeight: 700, color: 'var(--gold-str)' } })
              ])
            ]),
            h('button.btn.sm.teal.block', {
              text: '采用建议现金与资产', style: { marginTop: '10px' },
              onclick: function () {
                c.assets.cash = Math.round(cash);
                c.assets.assetsDescription = '总价值约 ' + cur.unit + ' ' + Math.round(asset);
                cashInput.value = String(c.assets.cash);
                assetInput.value = c.assets.assetsDescription;
                save(); UI.toast('已采用建议数值', 'ok');
              }
            })
          ]));
        }
      }

      /* ---------- 现金与资产（只构建一次，输入时不重建） ---------- */
      var cashInput = UI.input({
        type: 'text', inputmode: 'numeric', value: c.assets.cash || '', placeholder: '例：500',
        oninput: function () {
          var v = cashInput.value.replace(/[^\d]/g, '');
          if (v !== cashInput.value) cashInput.value = v;
          c.assets.cash = v === '' ? 0 : parseInt(v, 10);
          save();
        }
      });
      var assetInput = UI.textarea({
        value: c.assets.assetsDescription || '', placeholder: '例：波士顿公寓一套、1930年福特A型车',
        oninput: function () { c.assets.assetsDescription = assetInput.value; save(); }
      });
      var spendEl = UI.input({ value: c.assets.spendingLevel || '', readonly: true, style: { opacity: .7 } });

      function paintMiscStatic() {
        var miscHost = h('div');
        miscHost.appendChild(h('div.grid2', null, [
          UI.field('现金（' + (c.assets.currency || '$') + '）', cashInput),
          UI.field('消费水平', spendEl, { help: '由信用评级自动确定' })
        ]));
        miscHost.appendChild(UI.field('资产描述', assetInput));

        var CATS = ['交通工具', '住所', '奢侈品', '股票/证券', '其他'];
        var catBox = h('div');
        CATS.forEach(function (cat) {
          var cur2 = (c.assets.assets || []).filter(function (x) { return x.cat === cat; });
          catBox.appendChild(UI.field(cat, h('div', null, [
            UI.input({
              value: cur2.length ? cur2[0].desc : '', placeholder: cat + '…',
              oninput: function () {
                var v = this.value;
                c.assets.assets = (c.assets.assets || []).filter(function (x) { return x.cat !== cat; });
                if (v.trim()) c.assets.assets.push({ cat: cat, desc: v });
                save();
              }
            })
          ])));
        });
        miscHost.appendChild(h('div.card', null, [
          h('div.card-title', { text: '资产分类（参考表）' }),
          catBox
        ]));
        return miscHost;
      }

      root.appendChild(h('div.card', null, [
        h('div.card-head', null, [h('h3', { text: '信用评级与生活水平' })]),
        UI.field('信用评级 Credit Rating', crInput, {
          help: occ && occ.creditMin !== null && occ.creditMin !== undefined
            ? '职业「' + occ.name + '」允许 ' + occ.creditMin + ' - ' + occ.creditMax
            : '选择职业后确定取值范围'
        }),
        crChips,
        crNotice,
        lvHost
      ]));
      root.appendChild(h('div.card', null, [h('div.card-title', { text: '现金与资产' }), paintMiscStatic()]));

      syncCreditSkill();
      Engine.recalc(c);
      refreshCreditNotice(); paintChips(); paintLevel();
    }
  };
})(window);
