/* ============================================================
 * sheet.js — 角色卡展示 / 预览 / 分享页 / 图片导出
 * ============================================================ */
(function (global) {
  'use strict';
  var h = UI.h;
  var R = global.COC7;
  var OCC = global.CocOccupation;
  var SM = global.SkillModel;
  /* Engine 不在模块加载时捕获 —— ui/* 可能在 core/ 之前被引入，
     早一点捕获会拿到 undefined。用到的时候再取global.Engine。 */

  function skillRows(c) {
    var occSet = OCC.occupationalSet(c);
    return c.skills
      .filter(function (s) { return (s.occ || 0) + (s.int || 0) + (s.growth || 0) > 0 || occSet[s.key] || s.custom; })
      .sort(function (a, b) {
        var ao = (occSet[a.key] || occSet[a.id]) ? 1 : 0, bo = (occSet[b.key] || occSet[b.id]) ? 1 : 0;
        if (bo !== ao) return bo - ao;
        return b.total - a.total;
      });
  }

  function num(v) { var n = parseInt(v, 10); return isNaN(n) ? 0 : n; }

  /* ============================================================
   * v2.10.0（身体状态模型）：身体状态**视图合成**（纯函数，单测抽源 eval）。
   *
   * 新模型（与跑团房间共用同一张卡 schema、同语义；房间侧 UI 合成见
   * ui/room-panels.js，单机车卡编辑器见 app.js#bodySelect）：
   *   · status.body        单值 {正常, 轻伤, 重伤, 死亡}
   *   · status.dying       布尔「濒死」标记，与「重伤」叠加
   *   · status.unconscious 布尔「昏迷」标记，与「重伤」叠加
   * ============================================================ */

  /** 视图（主状态行用）：死亡 > 濒死 > 昏迷 > body。
   *  例如「重伤 + 濒死 + 昏迷」合成显示为「濒死」。 */
  function bodyViewOf(c) {
    var st = (c && c.status) || {};
    if (st.body === '死亡') return '死亡';
    if (st.dying) return '濒死';
    if (st.unconscious) return '昏迷';
    return st.body || '正常';
  }

  /** 叠加态列全（详情行用）：按 body → 濒死 → 昏迷 顺序拼出，
   *  例如「重伤 · 濒死 · 昏迷」。视图只显示最高优先级，这里补齐全部。 */
  function bodyDetailOf(c) {
    var st = (c && c.status) || {};
    if (st.body === '死亡') return '死亡';
    var parts = [];
    if (st.body && st.body !== '正常') parts.push(st.body);
    if (st.dying) parts.push('濒死');
    if (st.unconscious) parts.push('昏迷');
    return parts.length ? parts.join(' · ') : '正常';
  }

  /** 本职技能是不是**全部**都到上限了。
   *  全部到顶时点数用不完是规则使然（玩家把「技能上限」设低了），
   *  界面要如实说明，不能让玩家误以为分配逻辑有 bug。 */
  function allOccAtCap(c, occSet, cap) {
    var list = (c.skills || []).filter(function (s) {
      if (s.id === 'credit' || s.id === 'cthulhu' || R.isGrowthOnly(s.id)) return false;
      return !!(occSet[s.key] || occSet[s.id]);
    });
    if (!list.length) return false;
    return list.every(function (s) { return s.total >= SM.capOf(c, s); });
  }

  /** 兴趣技能同理（只数真正拿到点的） */
  function allIntAtCap(c) {
    var list = (c.skills || []).filter(function (s) {
      if (s.id === 'credit' || s.id === 'cthulhu' || R.isGrowthOnly(s.id)) return false;
      if (OCC.occupationalSet(c)[s.key] || OCC.occupationalSet(c)[s.id]) return false;
      return (s.int || 0) > 0;
    });
    if (!list.length) return false;
    return list.every(function (s) { return s.total >= SM.capOf(c, s); });
  }

  function vitality(c) {
    var st = c.status, d = c.derivedStats;
    /* SAN 的分母（上限）= 意志 POW；分子是临时值，允许突破上限。
       只要克苏鲁神话侵蚀了硬上限，就在下方补一行小字说明，避免玩家以为显示错了。 */
    var sanCap = (st.maxSAN === undefined || st.maxSAN === null) ? (d.maxSAN || 0) : st.maxSAN;
    var mythosCap = (c.sanMythosCap === undefined || c.sanMythosCap === null) ? 99 : c.sanMythosCap;
    var sanCell = h('div.vital.san', null, [
      h('div.k', { text: 'SAN' }),
      h('div.v', { html: st.currentSAN + '<small>/' + sanCap + '</small>' })
    ]);
    if (mythosCap < sanCap) {
      sanCell.appendChild(h('div.n', { text: '神话硬上限 ' + mythosCap, style: { fontSize: '9.5px', color: 'var(--danger)', textAlign: 'center', marginTop: '2px' } }));
    }
    return h('div.vital-row', null, [
      h('div.vital.hp', null, [h('div.k', { text: 'HP' }), h('div.v', { html: st.currentHP + '<small>/' + d.maxHP + '</small>' })]),
      h('div.vital.mp', null, [h('div.k', { text: 'MP' }), h('div.v', { html: st.currentMP + '<small>/' + d.maxMP + '</small>' })]),
      sanCell,
      h('div.vital.luck', null, [h('div.k', { text: 'LUCK' }), h('div.v', { html: st.currentLuck + '<small>/99</small>' })])
    ]);
  }

  function attrMini(c) {
    var box = h('div.attr-mini');
    R.attributes.forEach(function (a) {
      box.appendChild(h('div.c', null, [
        h('div.a', { text: a.abbr }),
        h('div.v', { text: (c.attributes[a.key] === '' || c.attributes[a.key] === undefined) ? '—' : c.attributes[a.key] })
      ]));
    });
    return box;
  }

  function derivedRow(c) {
    var d = c.derivedStats;
    return h('div.row.wrap', { style: { gap: '7px' } }, [
      h('span.tag', { text: 'MOV ' + d.mov }),
      h('span.tag', { text: 'BUILD ' + d.build }),
      h('span.tag', { text: 'DB ' + d.db }),
      h('span.tag', { text: '体格修正 ' + (d.build >= 0 ? '+' : '') + d.build }),
      h('span.tag', { text: (d.maxHP) + ' HP / ' + d.maxMP + ' MP' })
    ]);
  }

  /* ============================================================
   * 主渲染
   * ============================================================ */
  function render(container, c, opts) {
    opts = opts || {};
    var occ = OCC.getById(c.occupationId);
    UI.clear(container);

    /* ---------- Hero ---------- */
    var av = h('div.avatar');
    if (c.avatar) av.appendChild(h('img', { src: c.avatar, style: { width: '100%', height: '100%', objectFit: 'cover', borderRadius: '14px' } }));
    else av.appendChild(h('span', { text: '◈' }));

    container.appendChild(h('div.sheet-hero', null, [
      h('div.row', { style: { gap: '14px', alignItems: 'flex-start' } }, [
        av,
        h('div.grow', null, [
          h('div.nm', { text: c.characterName || '（未命名调查员）' }),
          h('div.pl', { text: '玩家：' + (c.playerName || '—') }),
          h('div.tags', null, [
            h('span.tag.gold', { text: occ ? occ.name : '未选职业' }),
            c.basicInfo.gender ? h('span.tag', { text: c.basicInfo.gender }) : null,
            c.basicInfo.age ? h('span.tag', { text: c.basicInfo.age + ' 岁' }) : null,
            h('span.tag', { text: c.basicInfo.era === '自定义' ? c.basicInfo.eraCustom : c.basicInfo.era }),
            c.basicInfo.residence ? h('span.tag', { text: '现居 ' + c.basicInfo.residence }) : null,
            h('span.tag.arcane', { text: c.version || 'v1.0' })
          ])
        ])
      ])
    ]));

    /* ---------- 状态值 ----------
       跑团过程里 HP / MP / SAN / 幸运 是要随时改的，所以把「状态管理」入口
       直接放在这张卡片里（以前压在页面最底端，翻半天才够得着）。 */
    var statusKids = [
      vitality(c),
      h('div.grid2', null, [
        h('div', null, [
          /* v2.10.0（身体状态模型）：身体状态改走 bodyView 合成
             （死亡 > 濒死 > 昏迷 > body），不再直接读 status.body。 */
          h('div.tiny.muted', { text: '身体状态：' + bodyViewOf(c) }),
          /* 叠加态列全：视图只显示最高优先级（如「濒死」），
             同时存在的状态在下一行补齐（如「重伤 · 濒死 + 昏迷」时显示「叠加态：重伤 · 濒死 · 昏迷」）。 */
          bodyDetailOf(c) !== bodyViewOf(c)
            ? h('div.tiny.dim', { style: { marginTop: '2px' }, text: '叠加态：' + bodyDetailOf(c) })
            : null
        ]),
        /* 精神状态现在是**多选数组**（可能同时有永久/临时/不定疯狂），
           所以走 Store.mentalText 拼成一行，别再直接读 c.status.mental。 */
        h('div', null, [h('div.tiny.muted', {
          text: '精神状态：' + (Store.mentalText ? Store.mentalText(c) : (c.status.mental || '正常'))
        })])
      ]),
      h('div', { style: { marginTop: '9px' } }, [derivedRow(c)])
    ];

    /* 疯狂状态：跑团里 SAN 掉下去就会掷症状卡，这里把当前持有的列出来，
       让人一眼看到「还剩几轮」「是不是永久」。删减在「状态管理」里做。 */
    var mad = global.CocMadness ? global.CocMadness.list(c) : [];
    if (mad.length) {
      statusKids.push(h('div.madness-strip', null, [
        h('div.madness-head', { text: '疯狂状态 · ' + mad.length + ' 条' }),
        h('div.row.wrap', { style: { gap: '5px' } }, mad.map(function (m) {
          return h('span.tag' + (m.permanent ? '.danger' : '.arcane'), {
            text: (global.CocMadness.labelOf(m.type)) + ' ' + m.name +
                  (m.permanent ? (m.bg ? '（背景症状）' : '（永久）')
                               : '（' + m.rounds + ' 轮）'),
            title: m.desc || ''
          });
        }))
      ]));
    }

    if (typeof opts.onStatusEdit === 'function') {
      statusKids.push(h('button.btn.primary.block', {
        text: '⚔ 状态管理（HP / SAN / 幸运 / 疯狂状态）',
        style: { marginTop: '12px', whiteSpace: 'normal', lineHeight: '1.35' },
        onclick: function () { opts.onStatusEdit(); }
      }));
    }
    card(container, '状态', statusKids);

    /* ---------- 属性 ---------- */
    card(container, '属性', [attrMini(c)]);

    /* ---------- 能力雷达图 ---------- */
    /* v2.2.0（用户第 4 项）：雷达图改用**占比口径**绘制（radarChart 优先读 d.norm）；
       图例显示「绝对值（占比%）」—— 绝对值取该类技能值之和（d.sum），占比为五类占比（d.pct）。 */
    var radarDims = R.radar(c.skills, global.COC_SKILLS);
    var radarBox = h('div');
    radarBox.appendChild(UI.radarChart(radarDims, 240));
    radarBox.appendChild(h('div.radar-legend', null, radarDims.map(function (d) {
      var abs = (d.sum !== undefined && d.sum !== null) ? d.sum : d.value;
      var pct = (d.pct !== undefined && d.pct !== null) ? d.pct : 0;
      return h('span', null, [h('i', { style: { background: d.color } }), d.label + ' ' + abs + '（' + pct + '%）']);
    })));
    card(container, '能力统计', [radarBox], '仅展示，不修改数据');

    /* ---------- 技能 ---------- */
    var rows = skillRows(c);
    var occSet = OCC.occupationalSet(c);
    var sTable = h('div.skill-show');

    /* 点数说明放在**技能表正上方** —— 这是玩家核对点数时真正在看的地方。
       必须说清「已用完」还是「剩 N 点」：
       只给一个「80/80」区分不出「池子被压过」和「分配没做完」。

       ⚠️ 若剩余点数是因为**所有技能都到了上限**（玩家把「技能上限」设低了），
          要如实说明原因，而不是让玩家以为分配逻辑有问题。 */
    var op = OCC.occupationPoints(c);
    var ip = OCC.interestPoints(c);
    var occCapV = num(c.skillCapOcc) || num(c.skillCap) || R.defaultOccSkillCap;
    var intCapV = num(c.skillCapInterest) || num(c.skillCap) || R.defaultInterestSkillCap;
    var occAllCapped = allOccAtCap(c, occSet, occCapV);
    var intAllCapped = allIntAtCap(c, intCapV);
    var ptsLine = h('div.tiny', { style: { marginBottom: '9px', lineHeight: '1.75' } });
    ptsLine.appendChild(h('div', {
      html: '职业点 <b>' + op.used + '/' + op.total + '</b>' +
            (op.remain === 0 ? '（已用完）'
                             : (occAllCapped ? '（剩 ' + op.remain + '，本职技能已到上限）'
                                              : '（剩 ' + op.remain + '）')) +
            '　兴趣点 <b>' + ip.used + '/' + ip.total + '</b>' +
            (ip.remain === 0 ? '（已用完）'
                             : (intAllCapped ? '（剩 ' + ip.remain + '，兴趣技能已到上限）'
                                              : '（剩 ' + ip.remain + '）'))
    }));
    sTable.appendChild(ptsLine);

    sTable.appendChild(h('div.r.head', null, [
      h('div', { text: '技能' }), h('div.c', { text: '基础' }), h('div.c', { text: '职业' }),
      h('div.c', { text: '兴趣' }), h('div.c', { text: '总值' })
    ]));
    if (!rows.length) sTable.appendChild(UI.emptyState('◌', '尚未分配技能点'));
    rows.forEach(function (s) {
      var isOcc = occSet[s.key] || occSet[s.id];
      sTable.appendChild(h('div.r', null, [
        h('div.nm', { text: s.name + (isOcc ? ' ★' : '') , title: s.name }),
        h('div.c', { text: s.base }),
        h('div.c', { text: s.occ || 0, style: { color: isOcc ? 'var(--gold)' : 'inherit' } }),
        h('div.c', { text: s.int || 0 }),
        h('div.c.big', { text: s.total })
      ]));
    });
    card(container, '技能（★ 为本职技能）', [h('div.table-scroll', null, [sTable])], rows.length + ' 项');

    /* ---------- 武器 ---------- */
    if (c.weapons.length) {
      var wt = h('table.dtable');
      wt.appendChild(h('thead', null, [h('tr', null, ['名称', '技能', '伤害', '射程', '装弹', '故障', '数量'].map(function (t) { return h('th', { text: t }); }))]));
      var wb = h('tbody');
      c.weapons.forEach(function (w) {
        wb.appendChild(h('tr', null, [
          h('td', { text: w.name }), h('td', { text: w.skill || '—' }), h('td.mono', { text: w.damage || '—' }),
          h('td', { text: w.range || '—' }), h('td', { text: w.ammo || '—' }), h('td', { text: w.malfunction || '—' }),
          h('td.mono', { text: w.qty || 1 })
        ]));
      });
      wt.appendChild(wb);
      card(container, '武器', [h('div.table-scroll', null, [wt])], c.weapons.length + ' 件');
    }

    /* ---------- 防具 / 载具 ---------- */
    if (c.armors.length || c.vehicles.length) {
      var rowsBox = h('div');
      if (c.armors.length) {
        rowsBox.appendChild(h('div.card-title', { text: '防具' }));
        var at = h('table.dtable');
        at.appendChild(h('thead', null, [h('tr', null, ['名称', '护甲', '覆盖', 'MOV惩罚'].map(function (t) { return h('th', { text: t }); }))]));
        var ab = h('tbody');
        c.armors.forEach(function (a) {
          ab.appendChild(h('tr', null, [h('td', { text: a.name }), h('td.mono', { text: a.armor || '—' }), h('td', { text: a.cover || '—' }), h('td.mono', { text: a.movPenalty || '—' })]));
        });
        at.appendChild(ab);
        rowsBox.appendChild(h('div.table-scroll', null, [at]));
      }
      if (c.vehicles.length) {
        rowsBox.appendChild(h('div.card-title', { text: '载具', style: { marginTop: '12px' } }));
        var vt = h('table.dtable');
        vt.appendChild(h('thead', null, [h('tr', null, ['名称', '技能', 'MOV', '体格', '载员'].map(function (t) { return h('th', { text: t }); }))]));
        var vb = h('tbody');
        c.vehicles.forEach(function (v) {
          vb.appendChild(h('tr', null, [h('td', { text: v.name }), h('td', { text: v.skill || '—' }), h('td.mono', { text: v.mov || '—' }), h('td.mono', { text: v.build || '—' }), h('td.mono', { text: v.capacity || '—' })]));
        });
        vt.appendChild(vb);
        rowsBox.appendChild(h('div.table-scroll', null, [vt]));
      }
      card(container, '防具 / 载具', [rowsBox]);
    }

    /* ---------- 随身物品 ---------- */
    if (c.items.length) {
      var it = h('table.dtable');
      it.appendChild(h('thead', null, [
        h('tr', null, [h('th', { text: '物品' }), h('th', { text: '数量' }), h('th', { text: '说明' })])
      ]));
      var ib = h('tbody');
      c.items.forEach(function (x) {
        ib.appendChild(h('tr', null, [h('td', { text: x.name || '—' }), h('td.mono', { text: x.quantity || 1 }), h('td', { text: x.description || '' })]));
      });
      it.appendChild(ib);
      card(container, '随身物品', [h('div.table-scroll', null, [it])], c.items.length + ' 项');
    }

    /* ---------- 资产 ---------- */
    var occCR = occ && occ.creditMin !== null ? (occ.creditMin + '-' + occ.creditMax) : '—';
    card(container, '资产', [
      h('div.grid2', null, [
        h('div', null, [
          h('div.tiny.muted', { text: '信用评级' }),
          h('div', { text: (c.assets.creditRating || 0) + '（职业范围 ' + occCR + '）', style: { fontWeight: 700 } }),
          h('div.tiny.muted', { text: '生活水平：' + (c.assets.spendingLevel || '标准'), style: { marginTop: '5px' } })
        ]),
        h('div', null, [
          h('div.tiny.muted', { text: '现金' }),
          h('div', { text: (c.assets.currency || '$') + ' ' + (c.assets.cash || 0), style: { fontWeight: 700, fontFamily: 'var(--mono)' } })
        ])
      ]),
      c.assets.assetsDescription ? h('div.small.dim', { text: c.assets.assetsDescription, style: { marginTop: '9px', whiteSpace: 'pre-wrap' } }) : null,
      (c.assets.assets || []).length ? h('div.row.wrap', { style: { gap: '6px', marginTop: '9px' } },
        c.assets.assets.map(function (a) { return h('span.tag', { text: a.cat + '：' + a.desc }); })) : null
    ]);

    /* ---------- 背景 ---------- */
    var BG = [
      ['个人描述', 'description'], ['思想 / 信念', 'ideology'], ['重要之人', 'significantPeople'],
      ['意义非凡之地', 'meaningfulPlaces'], ['宝贵之物', 'treasuredPossessions'],
      ['特点', 'traits'], ['伤口 / 疤痕', 'wounds'], ['疯狂症状', 'phobias']
    ];
    var bgBox = h('div');
    var hasBg = false;
    BG.forEach(function (f) {
      var v = c.background[f[1]];
      if (!v) return;
      hasBg = true;
      bgBox.appendChild(h('div', { style: { marginBottom: '11px' } }, [
        h('div.tiny', { text: f[0], style: { color: 'var(--gold)', fontWeight: 700, marginBottom: '3px' } }),
        h('div.small.dim', { text: v, style: { whiteSpace: 'pre-wrap' } })
      ]));
    });
    if (hasBg) card(container, '角色背景', [bgBox]);

    /* ---------- 调查员经历 ---------- */
    if (c.history.length) {
      var hb = h('div');
      c.history.forEach(function (ev) {
        hb.appendChild(h('div.entry', null, [
          h('div', { text: ev.title || '经历', style: { fontWeight: 700 } }),
          ev.date ? h('div.tiny.muted', { text: ev.date }) : null,
          ev.description ? h('div.small.dim', { text: ev.description, style: { marginTop: '4px' } }) : null,
          h('div.row.wrap', { style: { gap: '6px', marginTop: '6px' } }, [
            ev.sanChange ? h('span.tag.danger', { text: 'SAN ' + ev.sanChange }) : null,
            ev.hpChange ? h('span.tag.danger', { text: 'HP ' + ev.hpChange }) : null,
            ev.skillChanges ? h('span.tag.teal', { text: ev.skillChanges }) : null,
            ev.itemsObtained ? h('span.tag', { text: '获得：' + ev.itemsObtained }) : null,
            ev.moneyChange ? h('span.tag', { text: '金钱 ' + ev.moneyChange }) : null
          ])
        ]));
      });
      card(container, '调查员经历', [hb], c.history.length + ' 条');
    }

    /* ---------- 调查员伙伴 ---------- */
    if (c.companions.length) {
      var cb = h('div');
      c.companions.forEach(function (cp) {
        cb.appendChild(h('div.entry', null, [
          h('div', { text: cp.name || 'NPC', style: { fontWeight: 700 } }),
          h('div.tiny.muted', { text: [cp.identity, cp.age ? cp.age + '岁' : '', cp.relationship].filter(Boolean).join(' · ') }),
          cp.description ? h('div.small.dim', { text: cp.description, style: { marginTop: '4px' } }) : null
        ]));
      });
      card(container, '调查员伙伴', [cb]);
    }

    /* ---------- 克苏鲁神话 ---------- */
    var cth = c.skills.filter(function (s) { return s.id === 'cthulhu'; })[0];
    var mythosVal = cth ? cth.total : 0;
    if (mythosVal > 0 || c.mythos.knowledge || c.mythos.notes) {
      card(container, '克苏鲁神话', [
        h('div.row.wrap', { style: { gap: '7px' } }, [
          h('span.tag.arcane', { text: '克苏鲁神话 ' + mythosVal + '%' }),
          h('span.tag', { text: '神话侵蚀后 SAN 硬上限 ' + R.maxSan(mythosVal) })
        ]),
        c.mythos.knowledge ? h('div.small.dim', { text: c.mythos.knowledge, style: { marginTop: '9px', whiteSpace: 'pre-wrap' } }) : null,
        c.mythos.notes ? h('div.small.dim', { text: c.mythos.notes, style: { marginTop: '7px', whiteSpace: 'pre-wrap' } }) : null
      ]);
    }

    /* ---------- 已学会的法术 ---------- */
    var spl = (c.mythos && c.mythos.spells) || [];
    if (spl.length) {
      var sRows = spl.map(function (sp) {
        return h('div.entry', null, [
          h('div.hd', null, [
            h('span.t', { text: sp.name }),
            h('span.tag.arcane', { text: sp.category || '法术' })
          ]),
          h('div.tiny.dim', { style: { lineHeight: '1.8' }, html:
            '消耗：' + UI.esc(sp.cost || '—') + '<br>用时：' + UI.esc(sp.time || '—') }),
          sp.effect ? h('div.tiny.dim', { style: { marginTop: '5px', whiteSpace: 'pre-wrap', lineHeight: '1.65' }, text: sp.effect }) : null
        ]);
      });
      card(container, '法术（' + spl.length + '）', sRows);
    }

    /* ---------- 元信息 ---------- */
    card(container, '角色卡信息', [
      h('div.grid2', null, [
        h('div', null, [h('div.tiny.muted', { text: '角色 ID' }), h('div.small', { text: c.id, style: { fontFamily: 'var(--mono)' } })]),
        h('div', null, [h('div.tiny.muted', { text: '规则系统' }), h('div.small', { text: R.name })]),
        h('div', null, [h('div.tiny.muted', { text: '版本' }), h('div.small', { text: (c.version || 'v1.0') + '　' + (c.changeLog && c.changeLog.length ? c.changeLog[c.changeLog.length - 1].note : '') })]),
        h('div', null, [h('div.tiny.muted', { text: '最后更新' }), h('div.small', { text: new Date(c.updatedAt || Date.now()).toLocaleString('zh-CN') })])
      ])
    ]);
  }

  function card(container, title, children, hint) {
    var c = h('div.card');
    if (title) c.appendChild(h('div.card-head', null, [h('h3', { text: title }), hint ? h('span.hint', { text: hint }) : null]));
    UI.append(c, children);
    container.appendChild(c);
    return c;
  }

  /* ============================================================
   * 导出为图片
   *
   * v2.13.3（用户第 5 项）：拆成 renderImage（只出 dataURL、不落盘）+ exportImage（落盘）。
   * 跑团房间里玩家点「📋 人物卡查看」要看的就是这张**车卡系统生成的完整信息图**，
   * 直接复用同一套画布渲染，保证「房间内看到的」与「分享出去的那张」一模一样。
   * ============================================================ */
  function renderImage(c) {
    try {
      var W = 720, PAD = 30;
      var cv = document.createElement('canvas');
      var ctx = cv.getContext('2d');
      // 先测量高度
      var lines = buildImageLines(c);
      var lineH = 26;
      var H = PAD + 150 + lines.length * lineH + PAD;
      var scale = 2;
      cv.width = W * scale; cv.height = H * scale;
      ctx.scale(scale, scale);

      var isDark = document.documentElement.getAttribute('data-theme') !== 'light';
      var BG = isDark ? '#0b1119' : '#f7f4ee';
      var TXT = isDark ? '#e8eef7' : '#221c12';
      var DIM = isDark ? '#93a3ba' : '#5d5445';
      var GOLD = isDark ? '#d4a94a' : '#a8791a';
      var TEAL = isDark ? '#46b9a8' : '#1f8b7a';

      ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
      var grad = ctx.createLinearGradient(0, 0, W, 180);
      grad.addColorStop(0, isDark ? '#233047' : '#ffffff');
      grad.addColorStop(1, isDark ? '#161f2e' : '#eeeae1');
      ctx.fillStyle = grad; ctx.fillRect(0, 0, W, 150);
      ctx.strokeStyle = GOLD; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, 150); ctx.lineTo(W, 150); ctx.stroke();

      var y = PAD + 34;
      ctx.fillStyle = GOLD; ctx.font = '600 13px sans-serif';
      ctx.fillText('COC 7th · 调查员角色卡', PAD, y - 16);
      ctx.fillStyle = TXT; ctx.font = '700 30px serif';
      ctx.fillText(c.characterName || '（未命名）', PAD, y + 20);
      ctx.fillStyle = DIM; ctx.font = '14px sans-serif';
      ctx.fillText('玩家：' + (c.playerName || '—') + '　' + (c.basicInfo.gender || '') + '　' +
        (c.basicInfo.age || '') + '岁　' + (OCC.getById(c.occupationId) || {}).name, PAD, y + 48);

      y = 150 + PAD;
      lines.forEach(function (ln) {
        if (ln.t === 'h') {
          ctx.fillStyle = GOLD; ctx.font = '700 14px sans-serif';
          y += 10; ctx.fillText(ln.s, PAD, y); y += 6;
          ctx.strokeStyle = isDark ? 'rgba(255,255,255,.14)' : 'rgba(30,24,12,.14)';
          ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke();
        } else if (ln.t === 'kv') {
          ctx.fillStyle = DIM; ctx.font = '13px sans-serif';
          ctx.fillText(ln.s, PAD, y);
          if (ln.v) { ctx.fillStyle = TEAL; ctx.font = '700 14px monospace'; ctx.textAlign = 'right'; ctx.fillText(ln.v, W - PAD, y); ctx.textAlign = 'left'; }
        } else {
          ctx.fillStyle = TXT; ctx.font = '13px sans-serif';
          ctx.fillText(ln.s, PAD, y);
        }
        y += lineH - 6;
      });

      return cv.toDataURL('image/png');
    } catch (e) {
      console.error(e);
      return '';
    }
  }

  /** 导出成 PNG 文件（车卡系统「🖼 生成图片」/ 分享人物卡用的就是这张图） */
  function exportImage(c) {
    var url = renderImage(c);
    if (!url) { UI.toast('图片生成失败', 'err'); return; }
    UI.saveFile((c.characterName || 'COC角色卡') + '.png', url, 'image');
    if (!UI.isAndroid()) UI.toast('图片已生成', 'ok');
  }

  function buildImageLines(c) {
    var L = [], d = c.derivedStats;
    L.push({ t: 'h', s: '状态' });
    L.push({ t: 'kv', s: 'HP / MP / SAN / LUCK', v: d.maxHP + ' / ' + d.maxMP + ' / ' + d.maxSAN + ' / ' + c.status.currentLuck });
    L.push({ t: 'kv', s: 'MOV / BUILD / DB', v: d.mov + ' / ' + d.build + ' / ' + d.db });
    L.push({ t: 'h', s: '属性' });
    R.attributes.forEach(function (a) {
      L.push({ t: 'kv', s: a.abbr + ' ' + a.name, v: String(c.attributes[a.key] === '' ? '—' : c.attributes[a.key]) });
    });
    L.push({ t: 'h', s: '主要技能' });
    var occSet = OCC.occupationalSet(c);
    skillRows(c).slice(0, 24).forEach(function (s) {
      L.push({ t: 'kv', s: s.name + ((occSet[s.key] || occSet[s.id]) ? ' ★' : ''), v: String(s.total) });
    });
    if (c.weapons.length) {
      L.push({ t: 'h', s: '武器' });
      c.weapons.forEach(function (w) { L.push({ t: 'kv', s: w.name, v: (w.damage || '') + ' ×' + (w.qty || 1) }); });
    }
    L.push({ t: 'h', s: '资产' });
    L.push({ t: 'kv', s: '信用评级 / 生活水平', v: (c.assets.creditRating || 0) + ' / ' + (c.assets.spendingLevel || '') });
    L.push({ t: 'kv', s: '现金', v: (c.assets.currency || '$') + ' ' + (c.assets.cash || 0) });
    return L;
  }

  global.SheetView = { render: render, exportImage: exportImage, renderImage: renderImage, skillRows: skillRows };
})(window);
