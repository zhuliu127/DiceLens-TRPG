/* ============================================================
 * steps-b.js — 步骤 2 职业 / 步骤 3 技能
 * ============================================================ */
(function (global) {
  'use strict';
  var h = UI.h;
  var R = global.COC7;
  var OCC = global.CocOccupation;
  var SM = global.SkillModel;

  global.Steps = global.Steps || {};

  /* v2.11.9（用户第 2 项）：取消「任选本职技能」后，把已加在该技能上的本职技能点
     退还回池（s.occ 归零 → 已用点数下降 → 可重新分配）；重选的技能经
     OCC.occupationalSet 自动变回本职、可花职业点。只清「已不再是本职、却还留着
     职业点」的技能（不变更占用其它途径的点），避免误伤正常技能。 */
  function refundOrphanOcc(c) {
    var occSet = OCC.occupationalSet(c);
    var refunded = 0;
    (c.skills || []).forEach(function (s) {
      if ((s.occ || 0) > 0 && !occSet[s.key] && !occSet[s.id]) {
        refunded += s.occ;
        s.occ = 0;
        if (SM.recompute) SM.recompute(s);
      }
    });
    return refunded;
  }

  /* ============================================================
   * 步骤 2：职业
   * ============================================================ */
  global.Steps.occupation = {
    id: 'occupation', title: '选择职业', short: '职业', icon: '3',
    sub: '职业决定本职技能、信用评级范围与职业技能点公式。',
    render: function (root, ctx) {
      var c = ctx.character;
      var kw = '';
      var page = 0;
      var PAGE = 30;

      var listHost = h('div.card.flush');
      var detailHost = h('div');
      var searchInput = UI.input({
        placeholder: '搜索职业名称 / 技能 / 描述…',
        oninput: function () { kw = searchInput.value; page = 0; paintList(); }
      });
      /* 职业列表（未选职业时显示）与「已选定」锁定卡，二者互斥。
         注意 searchInput 必须先创建：下面 pickCard 会立刻用到它。 */
      var pickCard = h('div.card', null, [
        h('div.card-head', null, [h('h3', { text: '职业列表' }), h('span.hint', { text: '点击选择' })]),
        h('div.search-box', null, [searchInput])
      ]);
      var lockCard = h('div.card');

      function paintList() {
        UI.clear(listHost);
        var all = OCC.search(kw);
        var shown = all.slice(page * PAGE, page * PAGE + PAGE);
        // 职业点数由当前属性决定（EDU×4 等），属性没填完就算不出来
        var ready = Engine.attrsReady(c);
        var inner = h('div.scroll-area');
        if (!all.length) {
          inner.appendChild(UI.emptyState('🔍', '没有找到匹配的职业', '换个关键词试试'));
        } else {
          if (!ready) {
            inner.appendChild(h('div.tiny.muted', {
              style: { padding: '8px 12px', lineHeight: '1.6' },
              text: '属性还没填完，暂时算不出各职业的技能点数。可先回「属性」步骤生成属性。'
            }));
          }
          shown.forEach(function (o) {
            var sel = c.occupationId === o.id;
            var pts = ready ? OCC.evalFormula(o.attrFormula, c.attributes) : 0;
            inner.appendChild(h('button.occ-item' + (sel ? '.sel' : ''), {
              onclick: function () { pick(o); },
              html:
                '<div class="grow"><div class="nm">' + UI.esc(o.name) + '</div>' +
                '<div class="meta">信用 ' + UI.esc(o.creditText || '—') + ' · ' + UI.esc(o.attrFormula || '—') + '</div></div>' +
                // 右侧预览：这个职业按当前属性能拿到多少职业技能点
                '<div class="occ-pts">' +
                  '<b>' + (ready ? pts : '—') + '</b><span>职业点</span>' +
                '</div>' +
                (sel ? '<div class="chk">✓</div>' : '')
            }));
          });
        }
        listHost.appendChild(inner);
        if (all.length > PAGE) {
          listHost.appendChild(h('div.row', { style: { padding: '10px 12px', borderTop: '1px solid var(--border)' } }, [
            h('button.btn.sm.ghost', { text: '← 上一页', disabled: page === 0, onclick: function () { page--; paintList(); } }),
            h('div.grow.tiny.muted.center', { text: (page + 1) + ' / ' + Math.ceil(all.length / PAGE) + '（共 ' + all.length + ' 个）' }),
            h('button.btn.sm.ghost', { text: '下一页 →', disabled: (page + 1) * PAGE >= all.length, onclick: function () { page++; paintList(); } })
          ]));
        }
      }

      function pick(o) {
        if (c.occupationId && c.occupationId !== o.id) {
          UI.toast('请先点「清除」再更换职业', 'err', 2400);
          return;
        }
        c.occupationId = o.id;
        c.basicInfo.occupationName = o.name;
        c.occupationPicks = {};
        // 自动把信用评级下限填入资产
        if (o.creditMin !== null && c.assets.creditRating === 0) c.assets.creditRating = o.creditMin;
        if (o.creditMin !== null) {
          c.assets.creditMin = o.creditMin; c.assets.creditMax = o.creditMax;
        }
        Engine.recalc(c);
        Store.scheduleSave();
        paintList(); paintDetail(); paintLock();
        ctx.refreshBar();
        UI.toast('已选择：' + o.name, 'ok');
      }

      /** 清除职业：唯一的换职业入口 */
      function clearOcc() {
        var oldName = (OCC.getById(c.occupationId) || {}).name || '';
        c.occupationId = '';
        c.occupationPicks = {};
        c.basicInfo.occupationName = '';
        Engine.recalc(c);
        Store.scheduleSave();
        paintList(); paintDetail(); paintLock();
        ctx.refreshBar();
        if (oldName) UI.toast('已清除「' + oldName + '」，可以重新选择', 'ok');
      }

      /**
       * 职业一旦选定就锁定列表。
       * 之前选完职业、拉到底部还挂着一整张「职业列表」，
       * 顺手点一下就把已选的本职技能全部清掉（pick 里会重置 occupationPicks），
       * 既容易误操作，也让人误以为还要再选一次。
       */
      function paintLock() {
        var o = OCC.getById(c.occupationId);
        if (!o) {
          lockCard.style.display = 'none';
          pickCard.style.display = '';
          listHost.style.display = '';
          return;
        }
        lockCard.style.display = '';
        pickCard.style.display = 'none';
        listHost.style.display = 'none';
        UI.clear(lockCard);
        lockCard.appendChild(h('div.card-title', { text: '职业已选定' }));
        lockCard.appendChild(h('div.small.dim', {
          style: { lineHeight: '1.7' },
          html: '当前职业：<b>' + UI.esc(o.name) + '</b><br>' +
                '职业与本职技能已锁定，避免误触清空已做的选择。' +
                '如需更换职业，请先点下面的「清除」——清除后职业列表会重新出现。'
        }));
        lockCard.appendChild(h('div.btn-group', { style: { marginTop: '11px' } }, [
          h('button.btn.danger.grow', { text: '清除并重新选择', onclick: clearOcc })
        ]));
      }

      function paintDetail() {
        UI.clear(detailHost);
        var o = OCC.getById(c.occupationId);
        if (!o) {
          detailHost.appendChild(UI.notice('尚未选择职业。从下方列表中选择一个职业，或先查看职业详情。', 'warn'));
          return;
        }
        var pts = OCC.occupationPoints(c);
        var reqs = OCC.getRequirements(c);

        var head = h('div.card', null, [
          h('div.spread', null, [
            h('div.grow', null, [
              h('div.card-title', { text: o.name, style: { fontSize: '17px' } }),
              h('div.row.wrap', { style: { gap: '6px', marginTop: '4px' } }, [
                h('span.tag.gold', { text: '信用 ' + (o.creditText || '—') }),
                h('span.tag', { text: o.attrFormula || '—' }),
                h('span.tag.teal', { text: '职业点 ' + pts.total })
              ])
            ]),
            h('button.btn.sm.danger', {
              text: '清除', onclick: function () { clearOcc(); }
            })
          ]),
          h('div.help', { text: '技能点公式：' + (o.attrFormula || '—') + '（当前属性下 = ' + pts.total + ' 点）' })
        ]);

        // 职业介绍
        if (o.desc) {
          detailHost.appendChild(head);
          var dCard = h('div.card', null, [h('div.card-title', { text: '职业介绍' })]);
          var box = h('div.small.dim', { style: { maxHeight: '170px', overflowY: 'auto', whiteSpace: 'pre-wrap', lineHeight: '1.7' } });
          box.textContent = o.desc;
          dCard.appendChild(box);
          if (o.contacts) dCard.appendChild(h('div.help', { text: '推荐关系人：' + o.contacts }));
          detailHost.appendChild(dCard);
        } else {
          detailHost.appendChild(head);
        }

        /* --- 本职技能选择 --- */
        var reqCard = h('div.card', null, [
          h('div.card-head', null, [
            h('h3', { text: '本职技能' }),
            h('span.hint', { text: '按规则完成选择' })
          ])
        ]);

        reqs.forEach(function (r) {
          var block = h('div', { style: { marginBottom: '12px' }, id: 'occ_' + r.id });

          if (r.type === 'fixed') {
            var def = OCC.skillById(r.skill);
            var nm = def ? def.name + (r.sub ? '（' + r.sub + '）' : (r.isGroup ? '（任选子类）' : '')) : r.skill;
            block.appendChild(h('div.row.wrap', null, [
              h('span.tag.gold', { text: '本职' }),
              h('span.small', { text: nm }),
              r.weight > 1 ? h('span.tag', { text: '占 ' + r.weight + ' 项' }) : null
            ]));
            // 组技能：允许挑选具体子类
            if (def && def.special) {
              var subChips = h('div.row.wrap', { style: { gap: '6px', marginTop: '7px' } });
              var picked = (c.occupationPicksForGroup = c.occupationPicksForGroup || {});
              def.subskills.forEach(function (s) {
                var k = def.id + '::' + s.name;
                var on = !!picked[k];
                if (on) SM.addSubSkill(c, def.id, s.name);
                subChips.appendChild(h('button.chip' + (on ? '.on' : ''), {
                  text: s.name + ' ' + s.base, onclick: function () {
                    if (picked[k]) { delete picked[k]; this.classList.remove('on'); }
                    else { picked[k] = true; this.classList.add('on'); SM.addSubSkill(c, def.id, s.name); }
                    Store.scheduleSave();
                  }
                }));
              });
              block.appendChild(subChips);
            }
          } else if (r.type === 'choice' || r.type === 'alt') {
            var pool = r.type === 'choice' ? r.pool : r.options;
            var need = r.type === 'choice' ? r.count : 1;
            block.appendChild(h('div.row', null, [
              h('span.tag.teal', { text: r.label }),
              h('span.tiny.muted', { text: '需选 ' + need + ' 项' })
            ]));
            var chips = h('div.row.wrap', { style: { gap: '6px', marginTop: '7px' } });
            var cur = c.occupationPicks[r.id] || [];
            pool.forEach(function (p) {
              var isOn = cur.some(function (x) { return x.skill === p.skill && (x.sub || '') === (p.sub || ''); });
              var d = OCC.skillById(p.skill);
              var lbl = p.name || (d ? d.name : p.skill) + (p.sub ? '（' + p.sub + '）' : '');
              chips.appendChild(h('button.chip' + (isOn ? '.on' : ''), {
                text: lbl, onclick: function () {
                  var arr = c.occupationPicks[r.id] || [];
                  var idx = arr.findIndex(function (x) { return x.skill === p.skill && (x.sub || '') === (p.sub || ''); });
                  if (idx >= 0) arr.splice(idx, 1);
                  else {
                    if (arr.length >= need) {
                      UI.toast('「' + r.label + '」最多选择 ' + need + ' 项', 'err');
                      return;
                    }
                    arr.push({ skill: p.skill, sub: p.sub || '' });
                    if (p.sub) SM.addSubSkill(c, p.skill, p.sub);
                  }
                  c.occupationPicks[r.id] = arr;
                  refundOrphanOcc(c);   // v2.11.9 #2：取消/改选本职技能即退还其已加职业点
                  Store.scheduleSave(); paintDetail(); ctx.refreshBar();
                }
              }));
            });
            block.appendChild(chips);
          } else if (r.type === 'free') {
            var pickedArr = c.occupationPicks[r.id] || [];
            block.appendChild(h('div.row', null, [
              h('span.tag.arcane', { text: r.label }),
              h('span.tiny.muted', { text: pickedArr.length + ' / ' + r.count })
            ]));
            if (r.raw) block.appendChild(h('div.tiny.muted', { text: '原文：' + r.raw }));
            var chipRow = h('div.row.wrap', { style: { gap: '6px', marginTop: '7px' } });
            pickedArr.forEach(function (p, i) {
              chipRow.appendChild(h('button.chip.on', {
                text: (p.name || OCC.skillById(p.skill) && OCC.skillById(p.skill).name || '自由技能') + ' ✕',
                onclick: function () {
                  pickedArr.splice(i, 1);
                  c.occupationPicks[r.id] = pickedArr;
                  /* 组技能（如「格斗（擒拿）」）在 SM 里建了一条专攻实例。
                     只从 occupationPicks 里删掉的话，技能表里那条会残留——
                     界面上就出现「特长已经删了、但技能还在」的重影。
                     所以这里同步移除，但要先确认没有别的「任选」块也用到它。 */
                  if (p.sub) {
                    var stillUsed = false;
                    Object.keys(c.occupationPicks || {}).forEach(function (rid) {
                      (c.occupationPicks[rid] || []).forEach(function (q) {
                        if (q.skill === p.skill && q.sub === p.sub) stillUsed = true;
                      });
                    });
                    if (!stillUsed) SM.removeSkill(c, SM.keyOf(p.skill, p.sub));
                  }
                  Store.scheduleSave(); paintDetail(); ctx.refreshBar();
                }
              }));
            });
            chipRow.appendChild(h('button.chip', {
              text: '＋ 指定技能', onclick: function () { pickFree(r); }
            }));
            block.appendChild(chipRow);
          }
          reqCard.appendChild(block);
        });

        detailHost.appendChild(reqCard);

        var errs = R.validators.occupationChoices(c, OCC);
        if (errs.length) {
          detailHost.appendChild(UI.notice(errs.map(function (e) { return e.text; }).join('；'), 'warn'));
        } else {
          var rangeTxt = (o.creditMin === null || o.creditMin === undefined)
            ? '' : '先到「资产」步骤分配信用评级（' + o.creditMin + ' - ' + o.creditMax + '，会占用职业点数），';
          detailHost.appendChild(UI.notice('本职技能选择已完成。职业技能点共 ' + pts.total + ' 点，' + rangeTxt + '再到「技能」步骤分配剩余点数。', 'ok'));
        }
      }

      /* 自由技能选择器（「任选 X 项个人或时代特长」）
       *
       * ⚠️ 去重是这个选择器最容易出问题的地方：
       * 规则书要求「任选」的必须是**尚未拥有的**技能 ——
       *   ① 不能在同一个「任选」里重复选同一个技能（选两次「游泳」等于白占一个名额）；
       *   ② 不能选已经作为本职技能获得的技能（「历史」既是本职又当特长，属于重复）；
       *   ③ 组技能的不同专攻之间也不能重复选（格斗（斗殴）与格斗（擒拿）算两个不同的，
       *      但格斗（斗殴）不能选两次）。
       * 早先只做了「数量上限」，没做去重，于是能连点同一个技能把名额占满。
       * 这里用 takenOf() 统一判定，三条一起管。
       */
      function pickFree(r) {
        var arr = c.occupationPicks[r.id] || [];
        if (arr.length >= r.count) { UI.toast('已达到 ' + r.count + ' 项上限', 'err'); return; }

        /* 已占用的技能：同一个「任选」里已选的 + 全部本职技能 */
        function takenOf(excludeId) {
          var map = {};
          if (excludeId) (c.occupationPicks[excludeId] || []).forEach(function (p) {
            map[p.skill + '|' + (p.sub || '')] = 1;
          });
          Object.keys(c.occupationPicks || {}).forEach(function (rid) {
            if (rid === excludeId) return;
            (c.occupationPicks[rid] || []).forEach(function (p) {
              map[p.skill + '|' + (p.sub || '')] = 1;
            });
          });
          return map;
        }
        function keyOf(skill, sub) { return skill + '|' + (sub || ''); }
        function isTaken(skill, sub) { return !!takenOf(r.id)[keyOf(skill, sub)]; }
        /* 组技能：任一专攻已占用就整组标为「已选」，
           避免出现「格斗（斗殴）已选，还能再选格斗（擒拿）」之外的同类问题 */
        function subTaken(skill, subs) {
          var m = takenOf(r.id);
          return (subs || []).some(function (s) { return m[keyOf(skill, s.name)]; });
        }

        var kw2 = '';
        var resHost = h('div.scroll-area');
        var inp = UI.input({ placeholder: '搜索技能…', oninput: function () { kw2 = inp.value; paint(); } });

        function paint() {
          UI.clear(resHost);
          /* 搜索走技能索引（组名 + 全部子类名 + 别名 + 分类 + 描述）。
             老实现只比对「技能本身的名字」，组技能的子类完全不参与 ——
             搜「斗殴」时整组「格斗」被过滤掉，什么都不显示。 */
          var list = global.COC_SKILLS.filter(function (s) { return OCC.skillMatches(s, kw2); });
          if (!list.length) {
            resHost.appendChild(UI.emptyState('🔍', '没有匹配的技能', '试试技能全名或组技能名，如「斗殴」「格斗」「射击」'));
            return;
          }
          var shown = 0;
          list.forEach(function (s) {
            if (s.special) {
              // 命中子类名时只列命中的那个专攻；命中组名（或没输关键词）时列全组
              var hitSubs = OCC.matchedSubs(s, kw2);
              var subs = (hitSubs || s.subskills).filter(function (sub) { return !isTaken(s.id, sub.name); });
              if (!subs.length) return;      // 整组都被选过了
              shown++;
              resHost.appendChild(h('div', { style: { padding: '8px 4px 4px', fontSize: '11.5px', color: 'var(--text-mute)', fontWeight: 700 } }, [
                s.name + (hitSubs ? ' · 命中 ' + subs.length + ' 个专攻' : '')
              ]));
              subs.forEach(function (sub) {
                resHost.appendChild(h('button.occ-item', {
                  html: '<div class="grow"><div class="nm">' + UI.esc(s.name) + '（' + UI.esc(sub.name) + '）</div><div class="meta">基础值 ' + sub.base + '</div></div>',
                  onclick: function () { choose({ skill: s.id, sub: sub.name, name: s.name + '（' + sub.name + '）' }); }
                }));
              });
            } else {
              if (isTaken(s.id, '')) return;   // 已拥有，不再列
              shown++;
              resHost.appendChild(h('button.occ-item', {
                html: '<div class="grow"><div class="nm">' + UI.esc(s.name) + '</div><div class="meta">基础值 ' + s.base + ' · ' + UI.esc(s.category || '') + '</div></div>',
                onclick: function () { choose({ skill: s.id, sub: '', name: s.name }); }
              }));
            }
          });
          if (!shown) {
            resHost.appendChild(UI.emptyState('✓', '候选技能都已选过',
              '换一套职业，或到「技能」步骤用兴趣点补'));
          }
        }
        function choose(p) {
          // 二次防线：UI 已过滤，这里再挡一次，防止快速连点穿透
          if (isTaken(p.skill, p.sub)) {
            UI.toast('「' + (p.name || p.skill) + '」已经在你的技能里了', 'err', 2600);
            paint();
            return;
          }
          arr.push(p);
          c.occupationPicks[r.id] = arr;
          if (p.sub) SM.addSubSkill(c, p.skill, p.sub);
          Store.scheduleSave();
          sh.close(); paintDetail(); ctx.refreshBar();
        }
        paint();
        var sh = UI.sheet({ title: '指定「' + r.label + '」技能', body: h('div', null, [inp, resHost]) });
      }

      /* ---------- 组装 ---------- */
      root.appendChild(detailHost);
      root.appendChild(lockCard);
      root.appendChild(pickCard);
      root.appendChild(listHost);

      paintList(); paintDetail(); paintLock();
    }
  };

  /* ============================================================
   * 步骤 3：技能
   * ============================================================ */
  global.Steps.skill = {
    id: 'skill', title: '技能分配', short: '技能', icon: '5',
    sub: '职业点 / 兴趣点可直接键入数字。组技能（格斗、射击、技艺…）点标题即可展开选择专攻。',
    render: function (root, ctx) {
      var c = ctx.character;
      SM.syncSkills(c);
      Engine.recalc(c);

      var filter = '全部';
      var kw = '';
      var hideUnused = false;
      var listHost = h('div.skill-list');
      // 点数总览条是 sticky 的（滚动时一直能看到剩余点数），
      // 但说明文字不能跟在里面 —— 之前它被一起 sticky 住，
      // 表现为「一直飘在屏幕左上角挡住内容」。
      var barHost = h('div.point-bar');
      var noteHost = h('div.point-note');

      /* ---------- 点数总览 ---------- */
      function paintBar() {
        UI.clear(barHost);
        var st = SM.stats(c);
        barHost.appendChild(pointBox('职业技能点', st.occ, '#c9a227'));
        barHost.appendChild(pointBox('兴趣技能点', st.interest, '#4fb98a'));

        // 信用评级是从职业点里扣的，这里明示，避免玩家算不明白
        UI.clear(noteHost);
        var cr = parseInt(c.assets && c.assets.creditRating, 10) || 0;
        noteHost.appendChild(h('div.tiny', {
          style: { lineHeight: '1.7' },
          html: cr
            ? '信用评级 <b>' + cr + '</b> 已从职业点中占用 <b>' + cr + '</b> 点（在「资产」步骤设置）。' +
              '可直接在数字框里键入点数，或用 ＋ / ＋5 / ＋10 快速加点。'
            : '尚未设置信用评级，请回到「资产」步骤分配。可直接在数字框里键入点数，或用 ＋ / ＋5 / ＋10 快速加点。'
        }));
      }
      function pointBox(title, p, color) {
        var over = p.used > p.total;
        var pct = p.total ? Math.min(100, (p.used / p.total) * 100) : 0;
        return h('div.point-box', null, [
          h('div.ttl', { text: title }),
          h('div.nums', { html: '总 <b>' + p.total + '</b> · 已用 ' + p.used + ' · 剩余 <b class="r' + (over ? ' neg' : '') + '">' + (p.total - p.used) + '</b>' }),
          h('div.bar' + (over ? '.over' : ''), null, [h('i', { style: { width: Math.min(100, pct) + '%' } })])
        ]);
      }

      /* ---------- 筛选 ---------- */
      var CATS = ['全部', '本职', '战斗', '探索', '交流', '知识', '生存', '其他', '自定义'];
      var toolbar = h('div.skill-toolbar');
      CATS.forEach(function (cat) {
        var chip = h('button.chip' + (filter === cat ? '.on' : ''), {
          text: cat, onclick: function () {
            filter = cat;
            Array.prototype.forEach.call(toolbar.children, function (x) { x.classList.remove('on'); });
            chip.classList.add('on');
            paintList();
          }
        });
        toolbar.appendChild(chip);
      });
      // 组技能全部展开后技能行较多，给一个精简开关
      var hideChip = h('button.chip', {
        text: '隐藏未加点', onclick: function () {
          hideUnused = !hideUnused;
          hideChip.classList.toggle('on', hideUnused);
          paintList();
        }
      });
      toolbar.appendChild(hideChip);

      /* ---------- 技能列表 ---------- */
      var collapsedGroups = {};   // 组技能（格斗/射击/技艺…）的折叠状态

      function paintList() {
        UI.clear(listHost);
        var occSet = OCC.occupationalSet(c);

        var list = c.skills.filter(function (s) {
          var isOcc = !!occSet[s.key] || !!occSet[s.id];
          if (filter === '本职' && !isOcc) return false;
          if (filter !== '全部' && filter !== '本职' && SM.categoryOf(s.id) !== filter && !(filter === '自定义' && s.custom)) return false;
          // 搜索走技能索引：组技能支持按子类名命中（搜「斗殴」「步枪」），
          // 也认得别名词（技能库的「取悦」= 数据里的「魅惑」）。
          if (kw && !s.custom && !OCC.instanceMatches(s.id, s.sub, kw)) return false;
          if (kw && s.custom && s.name.toLowerCase().indexOf(kw.toLowerCase()) < 0) return false;
          if (hideUnused && !isOcc && !(s.occ + s.int + s.growth)) return false;
          return true;
        });

        // 有加点或本职的排前面
        list.sort(function (a, b) {
          var ao = (occSet[a.key] || occSet[a.id]) ? 1 : 0;
          var bo = (occSet[b.key] || occSet[b.id]) ? 1 : 0;
          var av = a.occ + a.int + a.growth, bv = b.occ + b.int + b.growth;
          if (bo !== ao) return bo - ao;
          if (bv !== av) return bv - av;
          return 0;
        });

        if (!list.length) {
          listHost.appendChild(UI.emptyState('◌', '没有符合条件的技能'));
          return;
        }

        // 拆成「独立技能」与「组技能专攻」两部分。
        // 组技能（格斗/射击/技艺…）默认展开，保证「斗殴」「射击（手枪）」这类
        // 专攻一进技能步骤就能看到 —— 之前默认折叠成一行，用户会以为技能表缺了这些。
        // 想精简列表可以点「隐藏未加点」，或手动收起某个组。
        var solo = [], groups = {}, groupOrder = [];
        list.forEach(function (s) {
          if (s.sub) {
            if (!groups[s.id]) { groups[s.id] = []; groupOrder.push(s.id); }
            groups[s.id].push(s);
          } else solo.push(s);
        });

        solo.forEach(function (s) { listHost.appendChild(buildRow(s, occSet)); });

        groupOrder.forEach(function (gid) {
          var members = groups[gid];
          var def = OCC.skillById(gid);
          var gname = def ? def.name : gid;
          var hot = members.filter(function (m) {
            return (m.occ + m.int + m.growth) > 0 || occSet[m.key] || occSet[m.id];
          });
          var isOpen = (collapsedGroups[gid] === undefined) ? true : collapsedGroups[gid];
          if (kw) isOpen = true;   // 搜索时强制展开

          // 折叠时在标题里预览几个子类名，避免让人误以为技能缺失
          var preview = members.slice(0, 4).map(function (m) { return m.name.replace(/^.*（|）$/g, ''); }).join('·');
          if (members.length > 4) preview += '…';

          listHost.appendChild(h('button.skill-group-head' + (isOpen ? '.open' : ''), {
            onclick: function () { collapsedGroups[gid] = !isOpen; paintList(); }
          }, [
            h('span.gn', { text: gname }),
            hot.length ? h('span.tag.gold', { text: hot.length + ' 项已用' }) : null,
            h('span.gc', { text: isOpen ? (members.length + ' 个门类') : preview }),
            h('span.gv', { text: isOpen ? '收起 ▴' : '展开 ▾' })
          ]));

          if (isOpen) members.forEach(function (m) { listHost.appendChild(buildRow(m, occSet)); });
        });
      }

      /** 构建单个技能行 */
      function buildRow(s, occSet) {
          var isOcc = !!occSet[s.key] || !!occSet[s.id];
          var isCredit = (s.id === 'credit');
          // 上限分两类：本职技能走本职上限，非本职走兴趣上限
          var cap = SM.capOf(c, s);
          var growthOnly = R.isGrowthOnly(s.id);
          // 母语的基础值 = 教育 EDU，天生可能超过自定义上限，规则上只受 99 硬顶约束
          var capFree = R.capExempt(s.id);
          var row = h('div.skill-row' + (isOcc ? '.is-occ' : '') + (s.total > cap ? '.is-err' : '') + (s.sub ? '.is-sub' : ''), { id: 'skill_' + s.key.replace(/[^\w]/g, '_') });

          var totalEl = h('div.total' + (s.total > cap ? '.warn' : (s.total >= Math.floor(cap * 0.8) ? '.hi' : '')), {
            text: s.total,
            title: '常规 ' + s.total + ' / 困难 ' + Math.floor(s.total / 2) + ' / 极难 ' + Math.floor(s.total / 5)
          });

          row.appendChild(h('div.top', null, [
            h('span.nm', { text: s.name }),
            isOcc ? h('span.tag.gold', { text: '本职' }) : null,
            s.custom ? h('span.tag.arcane', { text: '自定义' }) : null,
            isCredit ? h('span.tag.teal', { text: '资产步骤设置', title: '信用评级在「资产与信用评级」步骤里设，那里会按职业允许的范围校验' }) : null,
            growthOnly ? h('span.tag.teal', {
              text: '仅成长',
              title: isCredit
                ? '信用评级由规则决定（职业允许的区间），不能靠技能点或兴趣点堆高'
                : '该技能只能通过「成长」增加'
            }) : null,
            capFree ? h('span.tag.teal', { text: '上限豁免' }) : null,
            h('span.base', { text: '基础 ' + s.base }),
            totalEl
          ]));

          // 局部刷新：只更新本行数字与顶部点数条，不重建列表，
          // 否则输入到一半就会失焦、软键盘收起。
          function touch() {
            totalEl.textContent = s.total;
            totalEl.className = 'total' + (s.total > cap ? ' warn' : (s.total >= Math.floor(cap * 0.8) ? ' hi' : ''));
            paintBar();
            ctx.refreshBar();
          }

          var calc = h('div.skill-calc');
          // 克苏鲁神话只能靠成长加：职业点 / 兴趣点都锁住
          calc.appendChild(calcGroup(s, 'occ', '职业', !isOcc || growthOnly, touch,
            !isOcc ? '非本职技能，不能使用职业点' : (growthOnly ? '该技能只能通过「成长」增加' : '')));
          calc.appendChild(calcGroup(s, 'int', '兴趣', growthOnly, touch,
            growthOnly ? '该技能只能通过「成长」增加' : ''));
          calc.appendChild(calcGroup(s, 'growth', '成长', false, touch, ''));
          var del = h('div.calc-group.detail', null, [
            h('div.cg-top', null, [h('span.lg', { text: '详情' })]),
            h('div.cg-ops', null, [
              h('button.sbtn', {
                text: 'ⓘ',
                onclick: function () {
                UI.sheet({
                  title: s.name,
                  body: h('div', null, [
                    UI.notice('基础 ' + s.base + ' + 职业 ' + s.occ + ' + 兴趣 ' + s.int + ' + 成长 ' + s.growth + ' = ' + s.total, null, '◈'),
                    h('div.small', { text: '常规成功 ≤ ' + s.total + '　困难成功 ≤ ' + Math.floor(s.total / 2) + '　极难成功 ≤ ' + Math.floor(s.total / 5) }),
                    h('div.small.muted', { text: (isOcc ? '本职' : '兴趣') + '技能上限 ' + cap + '%' +
                        (capFree ? '（母语不受上限设置约束，硬顶 99%）' : ''), style: { marginTop: '6px' } }),
                    s.custom ? h('button.btn.danger.block', {
                      text: '删除该自定义技能', style: { marginTop: '12px' },
                      onclick: function () {
                        SM.removeSkill(c, s.key);
                        Store.scheduleSave();
                        UI.closeAllSheets();
                        paintList(); ctx.refreshBar();
                      }
                    }) : null
                  ])
                });
              }
            })
            ])
          ]);
          calc.appendChild(del);
          row.appendChild(calc);
          return row;
      }

      /** 在点数预算与技能上限约束下，该字段能取到的最大绝对值 */
      function maxAllowed(s, field) {
        var cap = SM.capOf(c, s);
        var others;
        if (field === 'growth') others = (s.base || 0) + (s.occ || 0) + (s.int || 0);
        else others = (s.base || 0) + (s.growth || 0) + (field === 'occ' ? (s.int || 0) : (s.occ || 0));
        var room = cap - others;
        if (field === 'occ') {
          var p = OCC.occupationPoints(c);
          room = Math.min(room, (p.total - p.used) + (s.occ || 0));
        } else if (field === 'int') {
          var it = OCC.interestPoints(c);
          room = Math.min(room, (it.total - it.used) + (s.int || 0));
        }
        return Math.max(0, room);
      }

      /** 信用评级由职业点购买，改动后要同步回「资产」步骤 */
      function syncCredit(s) {
        if (s.id === 'credit') c.assets.creditRating = s.occ || 0;
      }

      /**
       * 一个点数控制组：标签 + 可键入数字框 + 快捷按钮。
       * 按钮为 −1 / +1 / +5 / +10 —— 技能动辄要加几十点，一直点 ＋1 太费手。
       */
      function calcGroup(s, field, label, locked, after, lockReason) {
        // 用对象持有「获得焦点时的基准值」。
        // 之前这里是 var focusBase，而 onType 是同级函数、根本访问不到它，
        // 导致每次键入都抛 ReferenceError: focusBase is not defined，
        // applyPoint 从未执行 —— 手动键入技能点静默失效。
        var pin = { base: s[field] || 0 };
        var minus = null;   // 下面才创建，refreshMinus 会做存在性判断

        /** 同步「减号是否可用」。
         *  旧实现只在构建时判断一次 (cur <= 0) 就永久挂上 .dis（CSS 里是
         *  pointer-events:none），于是本职技能点上去以后减号再也点不动——
         *  这正是「只能点 + 不能点 −」的原因。 */
        function refreshMinus() {
          if (!minus) return;
          var zero = (s[field] || 0) <= 0;
          minus.classList.toggle('dis', zero || locked);
        }

        /** 按钮动作结束后：刷新减号状态 + 通知调用方 */
        function afterAll() { refreshMinus(); after(); }

        function step(delta) {
          if (locked) return;
          var res = SM.applyPoint(c, s, field, delta);
          if (!res.ok) { UI.toast(res.reason + (res.detail ? '｜' + res.detail : ''), 'err', 2600); refreshMinus(); return; }
          numEl.value = String(s[field] || 0);
          pin.base = s[field] || 0;
          syncCredit(s);
          Store.scheduleSave(); Engine.recalc(c);
          afterAll();
        }

        var numEl = UI.input({
          type: 'text', inputmode: 'numeric', value: String(s[field] || 0),
          readonly: !!locked,
          class: 'pin-input' + (locked ? ' pin-locked' : ''),
          title: locked ? (lockReason || '该栏位不可加点') : '可直接键入数字',
          onfocus: function () { pin.base = s[field] || 0; },
          oninput: function () { onType(s, field, numEl, locked, afterAll, pin); },
          onkeydown: function (e) { if (e.key === 'Enter') numEl.blur(); }
        });

        minus = h('button.sbtn.minus', { text: '−', title: '减 1 点', onclick: function () { step(-1); } });
        refreshMinus();

        return h('div.calc-group' + (locked ? '.locked' : ''), null, [
          h('div.cg-top', null, [h('span.lg', { text: label }), numEl]),
          h('div.cg-ops', null, [
            minus,
            h('button.sbtn.plus', { text: '+', title: '加 1 点', onclick: function () { step(1); } }),
            h('button.sbtn.plus', { text: '+5', title: '加 5 点', onclick: function () { step(5); } }),
            h('button.sbtn.plus', { text: '+10', title: '加 10 点', onclick: function () { step(10); } })
          ])
        ]);
      }

      /**
       * 手动输入点数：以「获得焦点时的值」为基准做增量，
       * 这样连续键入 3 → 30 不会被当成"3 点"再"30 点"两次叠加。
       * 超出预算时自动夹到最大可用值并给出提示。
       * pin 为 calcGroup 传入的状态对象，持有基准值。
       */
      function onType(s, field, el, locked, after, pin) {
        if (locked) return;
        var v = el.value.replace(/[^\d]/g, '').slice(0, 3);
        if (v !== el.value) el.value = v;
        var want = v === '' ? 0 : parseInt(v, 10);

        var res = SM.applyPoint(c, s, field, want - pin.base);
        if (!res.ok) {
          var mx = maxAllowed(s, field);
          var now = s[field] || 0;
          if (mx !== now) SM.applyPoint(c, s, field, mx - now);
          UI.toast(res.reason + (res.detail ? '｜' + res.detail : ''), 'err', 2600);
          pin.base = s[field] || 0;
          el.value = String(pin.base);
        } else {
          pin.base = want;
        }
        syncCredit(s);
        Store.scheduleSave(); Engine.recalc(c);
        after();
      }

      /* ---------- 添加技能 ---------- */
      function addSkillSheet() {
        var host = h('div');
        var groupHost = h('div');
        groupHost.appendChild(h('div.card-title', { text: '组技能（需先选择子类）' }));
        global.COC_SKILLS.filter(function (s) { return s.special; }).forEach(function (g) {
          var chips = h('div.row.wrap', { style: { gap: '6px', marginBottom: '11px' } });
          chips.appendChild(h('div.tiny.muted', { text: g.name, style: { width: '100%' } }));
          g.subskills.forEach(function (sub) {
            var exists = !!SM.find(c, SM.keyOf(g.id, sub.name));
            chips.appendChild(h('button.chip' + (exists ? '.on' : ''), {
              text: sub.name + ' ' + sub.base, onclick: function () {
                if (exists) { UI.toast('已存在', 'err'); return; }
                SM.addSubSkill(c, g.id, sub.name);
                Store.scheduleSave();
                this.classList.add('on');
                UI.toast('已添加 ' + g.name + '（' + sub.name + '）', 'ok');
                paintList(); ctx.refreshBar();
              }
            }));
          });
          groupHost.appendChild(chips);
        });

        var nInput = UI.input({ placeholder: '技能名称，如：古代精灵语' });
        var bInput = UI.input({ type: 'number', value: 5, placeholder: '初始值' });
        var dInput = UI.input({ placeholder: '描述（可选）' });
        host.appendChild(h('div.card', null, [
          h('div.card-title', { text: '添加自定义技能' }),
          UI.field('技能名称', nInput),
          h('div.grid2', null, [
            UI.field('初始值', bInput),
            UI.field('描述', dInput)
          ]),
          h('button.btn.primary.block', {
            text: '＋ 添加', onclick: function () {
              var nm = nInput.value.trim();
              if (!nm) { UI.toast('技能名称不能为空', 'err'); return; }
              var dup = c.skills.some(function (s) { return s.name === nm; });
              if (dup) { UI.toast('技能「' + nm + '」已存在', 'err'); return; }
              SM.addCustomSkill(c, { name: nm, base: parseInt(bInput.value, 10) || 0, desc: dInput.value });
              Store.scheduleSave();
              UI.toast('已添加 ' + nm, 'ok');
              sh.close(); paintList(); ctx.refreshBar();
            }
          })
        ]));
        host.appendChild(h('div.card', null, [groupHost]));
        var sh = UI.sheet({ title: '添加技能', body: host });
      }

      /* ---------- 技能上限设置（两类） ----------
       * 本职技能上限：所有「本职」技能的最终值上限。
       * 兴趣技能上限：非本职（靠兴趣点/成长加）技能的最终值上限。
       * 两者会真正约束加点：加到上限就加不动了。
       */
      function caps() {
        var st = SM.stats(c);
        return { occ: st.occCap, interest: st.interestCap };
      }

      function capSheet() {
        var cur = caps();
        var occInp = UI.input({ type: 'number', value: cur.occ, inputmode: 'numeric' });
        var intInp = UI.input({ type: 'number', value: cur.interest, inputmode: 'numeric' });
        var sh = UI.sheet({
          title: '技能上限设置',
          body: h('div', null, [
            UI.notice('上限会直接约束加点：某个技能加到上限后就再也加不动了。规则书默认都是 99%。', null, '◈'),
            h('div.grid2', null, [
              UI.field('本职技能上限 %', occInp, { help: '「本职」标签的技能' }),
              UI.field('兴趣技能上限 %', intInp, { help: '非本职的技能' })
            ]),
            h('div.tiny.muted', {
              style: { marginTop: '10px', lineHeight: '1.7' },
              html: '两处例外（规则决定，不受这里的数值约束）：<br>' +
                    '· <b>母语</b> —— 基础值等于「教育 EDU」，可能天生就高过上限，固定按 99% 计；<br>' +
                    '· 其余技能的<b>基础值</b>不会被算成超上限（基础值不是用点数买来的）。'
            }),
            h('button.btn.primary.block', {
              text: '保存', onclick: function () {
                var a = parseInt(occInp.value, 10);
                var b = parseInt(intInp.value, 10);
                if (!a || a < 1 || a > 999 || !b || b < 1 || b > 999) {
                  UI.toast('请输入 1-999 之间的数值', 'err'); return;
                }
                c.skillCapOcc = a;
                c.skillCapInterest = b;
                // 旧字段不再参与计算，清掉避免下次迁移又把它当基准
                c.skillCap = a;
                Store.scheduleSave(); sh.close(); paintList(); paintBar(); refreshCapDisplay(); ctx.refreshBar();
                UI.toast('上限已设为 本职 ' + a + '% / 兴趣 ' + b + '%', 'ok');
              }
            }),
            h('button.btn.ghost.block', {
              text: '恢复默认（99 / 99）', style: { marginTop: '9px' },
              onclick: function () {
                c.skillCapOcc = R.defaultOccSkillCap;
                c.skillCapInterest = R.defaultInterestSkillCap;
                c.skillCap = R.defaultOccSkillCap;
                Store.scheduleSave(); sh.close(); paintList(); paintBar(); refreshCapDisplay(); ctx.refreshBar();
                UI.toast('已恢复默认上限', 'ok');
              }
            })
          ])
        });
      }

      /** 只读的上限展示：不再做成按钮，点了没反应会让人以为坏了 */
      var capDisplay = h('div.cap-display');
      function refreshCapDisplay() {
        UI.clear(capDisplay);
        var cur = caps();
        capDisplay.appendChild(h('div.cd-row', null, [
          h('span.k', { text: '本职技能上限' }), h('b', { text: cur.occ + '%' })
        ]));
        capDisplay.appendChild(h('div.cd-row', null, [
          h('span.k', { text: '兴趣技能上限' }), h('b', { text: cur.interest + '%' })
        ]));
      }

      /* ---------- 组装 ---------- */
      root.appendChild(h('div.card', null, [
        h('div.grid2', null, [
          h('div', null, [
            h('div.card-title', { text: '搜索' }),
            UI.input({ placeholder: '技能名…', oninput: function () { kw = this.value; paintList(); } })
          ]),
          h('div', null, [
            h('div.card-title', { text: '上限' }),
            capDisplay
          ])
        ]),
        h('div.btn-group', { style: { marginTop: '11px' } }, [
          h('button.btn.teal.grow', { text: '＋ 添加技能', onclick: addSkillSheet }),
          h('button.btn.ghost.grow', { text: '⚙ 上限设置', onclick: capSheet })
        ])
      ]));
      root.appendChild(barHost);
      root.appendChild(noteHost);
      root.appendChild(toolbar);
      root.appendChild(listHost);

      refreshCapDisplay(); paintBar(); paintList();
    }
  };
})(window);
