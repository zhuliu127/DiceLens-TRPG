/* ============================================================
 * steps-a.js — 步骤 0 基本资料 / 步骤 1 属性
 * ============================================================ */
(function (global) {
  'use strict';
  var h = UI.h;
  var R = global.COC7;

  global.Steps = global.Steps || {};

  /* ============================================================
   * 步骤 0：基本资料
   * ============================================================ */
  global.Steps.basic = {
    id: 'basic', title: '基本资料', short: '基本资料', icon: '1',
    sub: '角色的身份信息。头像可以稍后再补。',
    render: function (root, ctx) {
      var c = ctx.character, bi = c.basicInfo;

      function markDirty() { Engine.recalc(c); Store.scheduleSave(); }

      /* ---- 头像 ---- */
      var avatarBox = h('div.pick-avatar');
      function paintAvatar() {
        UI.clear(avatarBox);
        if (c.avatar) {
          avatarBox.appendChild(h('img', { src: c.avatar, alt: '头像' }));
        } else {
          avatarBox.appendChild(h('div', { text: '＋' }));
        }
      }
      paintAvatar();

      var fileInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', style: { display: 'none' } });
      fileInput.addEventListener('change', function () {
        var f = fileInput.files && fileInput.files[0];
        if (!f) return;
        UI.readImage(f, 512, function (res) {
          if (res && res.error) { UI.toast(res.error, 'err'); return; }
          c.avatar = res.dataUrl; paintAvatar(); markDirty(); ctx.refreshBar();
        });
        fileInput.value = '';
      });

      var avatarCard = h('div.card', null, [
        h('div.row', { style: { gap: '14px', alignItems: 'flex-start' } }, [
          avatarBox,
          h('div.grow', null, [
            h('div.card-title', { text: '角色头像' }),
            h('div.tiny.muted', { text: '可选。支持 JPG / PNG / WEBP，不上传也可继续创建。', style: { marginBottom: '9px' } }),
            h('div.btn-group', null, [
              h('button.btn.sm', { text: c.avatar ? '更换图片' : '上传图片', onclick: function () { fileInput.click(); } }),
              c.avatar ? h('button.btn.sm.danger', { text: '删除图片', onclick: function () { c.avatar = ''; paintAvatar(); markDirty(); ctx.refreshBar(); } }) : null
            ]),
            fileInput
          ])
        ])
      ]);

      /* ---- 文本字段 ---- */
      function textField(label, key, opts) {
        opts = opts || {};
        var el = UI.input({
          value: c[key] || '', placeholder: opts.placeholder || '',
          oninput: function () {
            c[key] = el.value;
            if (opts.required) ctx.refreshBar();
            if (opts.sync) opts.sync(el.value);
            markDirty();
          }
        });
        if (opts.required && !el.value.trim()) el.classList.add('invalid');
        return UI.field(label, el, { required: opts.required, help: opts.help });
      }

      var nameInput = UI.input({
        value: c.characterName || '', placeholder: '例：亚历克斯·布莱克',
        oninput: function () {
          c.characterName = nameInput.value;
          nameInput.classList.toggle('invalid', !nameInput.value.trim());
          markDirty(); ctx.refreshBar();
        }
      });
      if (!c.characterName) nameInput.classList.add('invalid');

      var playerInput = UI.input({
        value: c.playerName || '', placeholder: '例：茶叶蛋调查员',
        oninput: function () {
          c.playerName = playerInput.value;
          playerInput.classList.toggle('invalid', !playerInput.value.trim());
          markDirty(); ctx.refreshBar();
        }
      });
      if (!c.playerName) playerInput.classList.add('invalid');

      /* ---- 时代 ---- */
      var ERAS = ['现代', '1920年代', '维多利亚时代', '近未来', '自定义'];
      var eraCustomWrap = h('div', { style: { display: bi.era === '自定义' ? '' : 'none', marginTop: '9px' } });
      var eraCustom = UI.input({
        value: bi.eraCustom || '', placeholder: '输入自定义时代，如「文艺复兴时期」',
        oninput: function () { bi.eraCustom = eraCustom.value; markDirty(); }
      });
      eraCustomWrap.appendChild(eraCustom);

      var eraChips = h('div.row.wrap', { style: { gap: '7px' } });
      ERAS.forEach(function (e) {
        var on = bi.era === e;
        eraChips.appendChild(h('button.chip' + (on ? '.on' : ''), {
          text: e, onclick: function () {
            bi.era = e;
            Array.prototype.forEach.call(eraChips.children, function (ch) { ch.classList.remove('on'); });
            this.classList.add('on');
            eraCustomWrap.style.display = (e === '自定义') ? '' : 'none';
            if (e !== '自定义') { bi.eraCustom = ''; eraCustom.value = ''; }
            markDirty();
          }
        }));
      });

      /* ---- 性别 ---- */
      var GENDERS = ['男', '女', '其他', '自定义'];
      var genderCustomWrap = h('div', { style: { display: bi.gender === '自定义' ? '' : 'none', marginTop: '9px' } });
      var genderCustom = UI.input({
        value: bi.genderCustom || '', placeholder: '输入自定义性别',
        oninput: function () { bi.genderCustom = genderCustom.value; markDirty(); }
      });
      genderCustomWrap.appendChild(genderCustom);

      var genderChips = h('div.row.wrap', { style: { gap: '7px' } });
      GENDERS.forEach(function (g) {
        var on = bi.gender === g;
        genderChips.appendChild(h('button.chip' + (on ? '.on' : ''), {
          text: g, onclick: function () {
            bi.gender = g;
            Array.prototype.forEach.call(genderChips.children, function (ch) { ch.classList.remove('on'); });
            this.classList.add('on');
            genderCustomWrap.style.display = (g === '自定义') ? '' : 'none';
            if (g !== '自定义') { bi.genderCustom = ''; genderCustom.value = ''; }
            markDirty();
          }
        }));
      });

      /* ---- 年龄 ---- */
      var ageInput = UI.input({
        type: 'number', inputmode: 'numeric', value: bi.age === '' ? '' : bi.age,
        placeholder: '例：26',
        oninput: function () {
          var v = ageInput.value === '' ? '' : parseInt(ageInput.value, 10);
          bi.age = isNaN(v) ? '' : v;
          c.age = bi.age;
          markDirty(); ctx.refreshBar();
          renderAgeHint();
        }
      });
      var ageHint = h('div.help');
      function renderAgeHint() {
        var ag = parseInt(bi.age, 10);
        if (!ag || ag < 1) { ageHint.textContent = '必须填写合理整数。'; return; }
        var rule = R.ageRule(ag);
        // rule.note 里已经包含了「教育进步检定 N 次」，不要再拼一遍（旧版会说两遍）
        var txt = '年龄调整：' + (rule.note || '无');
        // rule.note 里已经包含了「教育进步检定 N 次」；这里只补一句「去哪儿做」，
        // 不再重复一遍「教育进步检定」，避免同一句话出现两次。
        if (rule.eduChecks) txt += '。这些检定在「属性」步骤里掷（1D100 > 当前教育则 +1D10）。';
        ageHint.textContent = txt;
      }
      renderAgeHint();

      /* ---- 组装 ---- */
      root.appendChild(avatarCard);
      root.appendChild(h('div.card', null, [
        h('div.grid2', null, [
          UI.field('角色姓名', nameInput, { required: true }),
          UI.field('玩家名称', playerInput, { required: true, help: '用于区分玩家与角色' })
        ]),
        UI.field('时代', h('div', null, [eraChips, eraCustomWrap])),
        h('div.grid2', null, [
          UI.field('年龄', ageInput, { required: true }),
          UI.field('性别', genderChips)
        ]),
        genderCustomWrap,
        ageHint,
        h('div.grid2', null, [
          textField('居住地', 'residence', { placeholder: '例：波士顿' }),
          textField('故乡', 'birthplace', { placeholder: '例：阿卡姆' })
        ])
      ]));
      // 职业选择已移到「属性」步骤之后（第三步），这里不再重复放入口
    }
  };

  /* ============================================================
   * 步骤 1：属性
   * ============================================================ */
  global.Steps.attr = {
    id: 'attr', title: '属性设置', short: '属性', icon: '2',
    sub: '四种生成方式：随机掷骰 / 手动购点 / 天命 N 选一 / 预设方案。派生属性自动计算。',
    render: function (root, ctx) {
      var c = ctx.character;
      var ATTRS = R.attributes;
      var LOSS_LABEL = { str: '力量', con: '体质', siz: '体型', dex: '敏捷', app: '外貌' };
      var pending = null;   // 随机生成的待确认结果
      var cells = {};

      /* 属性一改就要重绘「教育进步检定」面板 ——
         检定结果是否还成立取决于当前的原始 EDU（eduStale 判断 baseEdu !== rawEdu）。
         之前这里只 commit() 不重绘，于是改完属性面板还是旧的样子，
         表现为「检定之后一直不会变」。 */
      function commit() {
        Engine.recalc(c); Store.scheduleSave();
        if (typeof paintEdu === 'function') paintEdu();
      }
      function syncDerived() { Engine.recalc(c); paintDerived(); paintSum(); }
      c.attributeMode = c.attributeMode || 'random';

      /* ---------- 总属性值 ----------
       * 9 项属性之和，任何模式都实时显示。
       * 幸运在 COC 里是独立的一次掷骰（不参与购点），所以含/不含幸运分别给一个数。
       * 随机模式「还没点接受」时也照预览值显示 —— 玩家要看着数字决定要不要接受。
       */
      var sumHost = h('div.card');
      var SUM_KEYS = ['str', 'con', 'siz', 'dex', 'app', 'int', 'pow', 'edu', 'luck'];

      /** 随机预览期间以「预览值」为准，其余情况用已生效的属性值 */
      function attrSource() {
        return pending ? Object.assign({}, c.attributes, pending) : c.attributes;
      }

      function paintSum() {
        UI.clear(sumHost);

        var src = attrSource();
        var adj = R.ageAdjust(Object.assign({}, src, { age: c.basicInfo.age }));
        var rawAll = 0, rawNoLuck = 0, effAll = 0, effNoLuck = 0;
        SUM_KEYS.forEach(function (k) {
          var v = parseInt(src[k], 10) || 0;
          var e = adj.eff[k] || 0;
          rawAll += v;
          effAll += e;
          if (k !== 'luck') { rawNoLuck += v; effNoLuck += e; }
        });

        var lossParts = [];
        Object.keys(LOSS_LABEL).forEach(function (k) {
          if (adj.loss && adj.loss[k]) lossParts.push(LOSS_LABEL[k] + ' −' + adj.loss[k]);
        });
        var hasAge = lossParts.length > 0 || adj.movLoss > 0;

        function big(label, v, sub, color) {
          return h('div.sum-cell', null, [
            h('div.k', { text: label }),
            h('div.v', { text: v, style: color ? { color: color } : null }),
            sub ? h('div.n', { text: sub }) : null
          ]);
        }

        sumHost.appendChild(h('div.card-title', null, [
          h('span', { text: '总属性值' }),
          pending ? h('span.tag.arcane', { text: '预览中（未接受）' }) : null
        ]));
        sumHost.appendChild(h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '9px' } }, [
          big('9 项之和（含幸运）', rawAll, '力量+体质+体型+敏捷+外貌+智力+意志+教育+幸运'),
          big('8 项之和（不含幸运）', rawNoLuck, '幸运不计入购点上限')
        ]));

        if (hasAge) {
          sumHost.appendChild(h('div.notice', {
            style: { marginTop: '10px', marginBottom: 0 },
            ico: '◈',
            html: '年龄调整已生效：' + lossParts.join(' · ') +
                  (adj.movLoss ? ' · 移动 −' + adj.movLoss : '') +
                  '<br>调整后生效总值　含幸运 <b>' + effAll + '</b>　不含幸运 <b>' + effNoLuck + '</b>' +
                  '（共 −' + adj.totalLoss + '，只扣属性不扣幸运）' +
                  '<br><span class="tiny muted">力量/体质/敏捷的扣减会<b>平均分摊</b>到三项上（单项最低扣到 15），' +
                  '不会出现「只扣力量」导致属性畸形。原始值不会被改写，派生属性与技能基础值按生效值计算。</span>' +
                  (adj.unapplied ? '<br><span class="tiny muted">注：有 ' + adj.unapplied + ' 点因触及 15 下限未能扣完。</span>' : '')
          }));
        } else {
          sumHost.appendChild(h('div.tiny.muted', {
            style: { marginTop: '9px' },
            text: '按当前年龄（' + (c.basicInfo.age || '—') + '）没有任何属性扣减。'
          }));
        }
      }

      /* ---------- 派生属性面板 ---------- */
      var derivedHost = h('div.derived-grid');
      function paintDerived() {
        UI.clear(derivedHost);
        var d = c.derivedStats || {};
        // SAN：上限（分母）= 意志 POW；当前值是临时值，可以突破上限（但硬天花板是 99）。
        var sanMax = (d.maxSAN === undefined || d.maxSAN === null) ? 0 : d.maxSAN;
        var mythosCap = (c.sanMythosCap === undefined) ? R.maxSan(0) : c.sanMythosCap;
        var sanNote = '上限 = 意志（POW）' + sanMax + '，临时值可突破';
        if (mythosCap < sanMax) sanNote += '；神话侵蚀后硬上限 ' + mythosCap;
        [
          { k: 'HP', v: d.maxHP, n: '（体质+体型）÷10' },
          { k: 'MP', v: d.maxMP, n: '意志÷5' },
          { k: 'SAN', v: (c.status && c.status.currentSAN) || d.san, n: sanNote },
          { k: 'MOV', v: d.mov, n: '力量/敏捷/体型（含年龄）' },
          { k: 'BUILD', v: d.build, n: '力量+体型' },
          { k: 'DB', v: d.db, n: '伤害加值' }
        ].forEach(function (x) {
          derivedHost.appendChild(h('div.derived-cell', null, [
            h('div.k', { text: x.k }),
            h('div.v', { text: (x.v === undefined || x.v === null) ? '—' : x.v }),
            h('div.n', { text: x.n })
          ]));
        });
      }

      /* ---------- 属性网格 ---------- */
      var grid = h('div.attr-grid');
      function buildGrid() {
        /* 守卫：原始 EDU 一旦变了，先把过期的教育进步检定作废。
         *
         * ⚠️ 这里必须放在 buildGrid 里，不能只放在 commit() 里 ——
         * 改属性的路径不止一条：
         *   · 手动输入        → commit()
         *   · 随机「接受」     → acceptRoll()，只调 syncDerived()
         *   · 天命「选定一组」 → pickFate()，也只调 syncDerived()
         * 后两条不经过 commit()，所以之前「改了教育值检定结果仍旧套用」。
         * buildGrid() 是所有路径的必经之地，在这里守一次就够。
         */
        if (typeof invalidateEduIfStale === 'function') invalidateEduIfStale();
        UI.clear(grid); cells = {};
        ATTRS.forEach(function (a) {
          var val = UI.input({
            type: 'number', inputmode: 'numeric',
            value: c.attributes[a.key] === '' || c.attributes[a.key] === undefined ? '' : c.attributes[a.key],
            style: { marginBottom: '2px' },
            oninput: function () {
              var v = val.value === '' ? '' : parseInt(val.value, 10);
              c.attributes[a.key] = isNaN(v) ? '' : v;
              if (a.key === 'edu' || a.key === 'dex' || a.key === 'pow' || a.key === 'con' || a.key === 'siz' || a.key === 'str' || a.key === 'int') syncDerived();
              else commit();
              validateMode();
            }
          });
          var half = h('div.attr-half');
          var adjEl = h('div.attr-adj');
          var lockHint = h('div.attr-lock');
          var cell = h('div.attr-cell', { id: 'attr_' + a.key }, [
            h('div.lab', null, [
              h('span.ab', { text: a.abbr }),
              h('span.cn', { text: a.name }),
              h('button.help-btn', { text: '?', onclick: function (e) { e.stopPropagation(); showAttrHelp(a); } })
            ]),
            val,
            half,
            adjEl,
            lockHint
          ]);
          cells[a.key] = { cell: cell, input: val, half: half, adj: adjEl, lock: lockHint };
          grid.appendChild(cell);
        });
        syncHalves();
        applyLuckLock();
      }

      /** 显示"困难/极难"半值 + 年龄调整后的生效值 */
      function syncHalves() {
        var adj = Engine.ageAdjustOf(c);
        ATTRS.forEach(function (a) {
          var v = parseInt(c.attributes[a.key], 10);
          var cell = cells[a.key];
          if (!cell) return;

          cell.half.textContent = (isNaN(v) || !v) ? '' : ('困难 ' + Math.floor(v / 2) + ' / 极难 ' + Math.floor(v / 5));

          // 年龄扣减 / 教育进步增益：并排显示「原始 → 生效」，让玩家知道最终值落在哪
          var loss = adj.loss && adj.loss[a.key];
          var bonus = (a.key === 'edu') ? (adj.eduBonus || 0) : 0;
          var parts = [];
          if (loss) parts.push('年龄 −' + loss);
          if (bonus) parts.push('教育进步 +' + bonus);
          if (parts.length) {
            cell.adj.textContent = parts.join(' · ') + ' → 最终 ' + adj.eff[a.key];
            cell.adj.style.display = '';
          } else {
            cell.adj.textContent = '';
            cell.adj.style.display = 'none';
          }
        });
      }

      /**
       * 手动购点 + 不包含幸运 → 幸运不计入上限，也就不允许手动填写，
       * 只能用「随机生成幸运值」（规则书里幸运本来就是单独掷 3D6×5）。
       */
      function applyLuckLock() {
        var cell = cells.luck;
        if (!cell) return;
        var locked = (c.attributeMode === 'pointbuy' && c.pbIncludeLuck === false);
        cell.input.readOnly = locked;
        cell.input.classList.toggle('attr-locked', locked);
        cell.lock.textContent = locked ? '幸运不参与购点，请用「手动购点」区域的「随机生成幸运值」' : '';
        cell.lock.style.display = locked ? '' : 'none';
      }

      function showAttrHelp(a) {
        var v = parseInt(c.attributes[a.key], 10);
        UI.sheet({
          title: a.abbr + ' ' + a.name,
          body: h('div', null, [
            UI.notice(a.desc, null, '◈'),
            h('div.small', { text: '当前值：' + (isNaN(v) ? '未设置' : v) }),
            h('div.small.muted', { text: '取值 15-90，为 5 的倍数（COC 7th 标准生成范围）。体型与意志可以超过 99。' , style:{marginTop:'6px'} })
          ])
        });
      }

      /* ---------- 模式一：随机 ----------
       * 「随机生成」本身就是重新掷一次，所以不再单独放「重新随机」按钮（作用完全一样）。
       * 点一下就立刻在按钮旁给出总属性值预览，不必先点「接受」才看得到数字。
       */
      var rollPreview = h('div', { id: 'rollPreview' });
      var rollSumEl = h('span.roll-sum');
      var rollHost = h('div.card', null, [
        h('div.card-title', { text: '模式一 · 随机掷骰' }),
        h('div.tiny.muted', { text: '力量/体质/敏捷/外貌/意志/幸运 = 3D6×5；体型/智力/教育 = (2D6+6)×5', style: { marginBottom: '10px' } }),
        h('div.row.wrap', { style: { gap: '10px', alignItems: 'center' } }, [
          h('button.btn.primary', { text: '🎲 随机生成', onclick: function () { doRoll(); } }),
          rollSumEl
        ]),
        rollPreview
      ]);

      function doRoll() {
        pending = R.generators.random();
        // 立刻预览：按钮旁的总和 + 下方逐项预览，都还没写进角色数据
        paintSum();
        paintRollPreview();
      }

      function paintRollPreview() {
        UI.clear(rollPreview);
        if (!pending) { rollSumEl.textContent = ''; return; }

        var sAll = 0, sNoLuck = 0;
        ATTRS.forEach(function (a) {
          var v = parseInt(pending[a.key], 10) || 0;
          sAll += v;
          if (a.key !== 'luck') sNoLuck += v;
        });
        rollSumEl.textContent = '总属性值 ' + sAll + '（不含幸运 ' + sNoLuck + '）';

        rollPreview.appendChild(h('div.notice', { text: '以下为预览，点「接受」后才会覆盖当前数据；再点一次「随机生成」可以重新掷。', style: { marginTop: '11px', marginBottom: '9px' } }));
        var cols = h('div.attr-grid');
        ATTRS.forEach(function (a) {
          cols.appendChild(h('div.attr-cell', null, [
            h('div.lab', null, [h('span.ab', { text: a.abbr }), h('span.cn', { text: a.name })]),
            h('div', { text: pending[a.key], style: { fontFamily: 'var(--mono)', fontSize: '20px', fontWeight: 700, textAlign: 'center' } })
          ]));
        });
        rollPreview.appendChild(cols);
        rollPreview.appendChild(h('div.btn-group', { style: { marginTop: '11px' } }, [
          h('button.btn.primary.grow', { text: '✓ 接受', onclick: function () { acceptRoll(); } })
        ]));
      }

      function acceptRoll() {
        if (!pending) { UI.toast('请先点「随机生成」', 'err'); return; }
        Object.keys(pending).forEach(function (k) { c.attributes[k] = pending[k]; });
        pending = null;
        UI.clear(rollPreview);
        rollSumEl.textContent = '';
        /* 随机重掷会整体替换属性 —— 教育可能变了，先作废过期的检定 */
        var eduHit = invalidateEduIfStale();
        buildGrid(); syncDerived(); validateMode();
        /* 属性的 AND/OR 组合可能变了，同步重画步骤条上受影响的部分 */
        paintMode(); paintAgeNote(); if (eduHit) paintEdu();
        Store.scheduleSave();
        UI.toast(eduHit ? '已应用新属性（教育变了，教育进步检定需重新掷）' : '已应用新属性', 'ok', eduHit ? 3600 : 2000);
        ctx.refreshBar();
      }

      /* ---------- 模式二：购点 ---------- */
      // 上限必须有真实初值：以前只有输入框显示 480、c.pbCap 始终是 undefined，
      // 校验就按 0 算，页面会显示「属性总和 810 超出上限 0，请减少 810 点」。
      if (c.pbCap === undefined || c.pbCap === null || c.pbCap === '') c.pbCap = R.pointBuyCap.fallback;
      if (c.pbIncludeLuck === undefined) c.pbIncludeLuck = true;

      var pbCap = UI.input({
        type: 'number', inputmode: 'numeric', value: c.pbCap,
        oninput: function () {
          c.pbCap = parseInt(pbCap.value, 10) || 0;
          Store.scheduleSave();
          validateMode();          // 上限一改，下面的数字立刻跟着变
        }
      });
      var pbIncludeLuck = null;
      var pbLuckWrap = h('div');
      var pbStatus = h('div', { id: 'pbStatus' });

      var luckToggle = h('div.row.wrap', { style: { gap: '7px' } });
      ['包含幸运', '不包含幸运'].forEach(function (t, i) {
        var on = (i === 0) === (c.pbIncludeLuck !== false);
        var chip = h('button.chip' + (on ? '.on' : ''), {
          text: t, onclick: function () {
            c.pbIncludeLuck = (i === 0);
            Array.prototype.forEach.call(luckToggle.children, function (x) { x.classList.remove('on'); });
            chip.classList.add('on');
            pbLuckWrap.style.display = c.pbIncludeLuck ? 'none' : '';
            validateMode();
            if (!c.pbIncludeLuck) UI.toast('幸运不参与购点：请用「随机生成幸运值」', null, 2200);
          }
        });
        luckToggle.appendChild(chip);
      });
      if (c.pbIncludeLuck === undefined) c.pbIncludeLuck = true;
      pbLuckWrap.style.display = c.pbIncludeLuck ? 'none' : '';

      pbLuckWrap.appendChild(h('button.btn.sm.teal', {
        text: '🎲 随机生成幸运值',
        onclick: function () {
          var v = R.generators.randomOne('luck');
          c.attributes.luck = v;
          if (cells.luck) cells.luck.input.value = v;
          syncDerived(); validateMode(); Store.scheduleSave();
          UI.toast('幸运 = ' + v, 'ok');
        }
      }));

      var pbHost = h('div.card', null, [
        h('div.card-title', { text: '模式二 · 手动购点' }),
        h('div.grid2', null, [
          UI.field('属性点上限（总和）', pbCap, { help: 'COC 标准：不含幸运 460 / 含幸运 540' }),
          UI.field('幸运是否计入上限', luckToggle)
        ]),
        pbLuckWrap,
        pbStatus
      ]);

      /* ---------- 模式三：天命 N 选一 ----------
       * 一次性掷出 N 组（2-10 组）完整属性，玩家从中挑一组。
       * 设计约束：**掷出后不可重掷** —— 这是这个模式的意义（天命既定），
       * 想换一批只能新建角色卡。选中结果写回 c.attributes，
       * 掷出的 N 组本身原样存在 c.fate.options 里，刷新 / 重进都不会变。
       */
      var fate = ensureFate();
      var fateHost = h('div.card', { id: 'fateCard' });

      function ensureFate() {
        if (!c.fate || typeof c.fate !== 'object') c.fate = { n: 5, rolled: false, options: [], picked: -1, rolledAt: 0 };
        if (!Array.isArray(c.fate.options)) c.fate.options = [];
        var n = parseInt(c.fate.n, 10);
        if (!(n >= 2 && n <= 10)) c.fate.n = 5;
        if (c.fate.picked === undefined || c.fate.picked === null) c.fate.picked = -1;
        return c.fate;
      }

      /** 掷出天命：一次生成 N 组属性，之后锁死（不可重掷） */
      function rollFate() {
        if (fate.rolled) {
          UI.toast('天命已经掷出，不能重掷。想换一批请新建角色卡。', 'err', 3000);
          return;
        }
        var n = parseInt(fateN.value, 10);
        if (!(n >= 2 && n <= 10)) { UI.toast('请把组数填写为 2 - 10 之间的整数', 'err'); return; }
        fate.n = n;
        fate.options = [];
        fate.picked = -1;
        for (var i = 0; i < n; i++) fate.options.push(R.generators.random());
        fate.rolled = true;
        fate.rolledAt = Date.now();
        c.attributeMode = 'fate';
        Store.scheduleSave();
        paintFate(); validateMode();
        UI.toast('天命已掷出 ' + n + ' 组，请挑一组', 'ok', 2400);
      }

      /** 选定某一组：写回属性并记录下标 */
      function pickFate(i) {
        var opt = fate.options[i];
        if (!opt) return;
        SUM_KEYS.forEach(function (k) {
          if (opt[k] !== undefined && opt[k] !== null) c.attributes[k] = opt[k];
        });
        fate.picked = i;
        c.attributeMode = 'fate';
        /* 与 acceptRoll 同理：天命选定会整体替换属性，教育可能变了 */
        var eduHit = invalidateEduIfStale();
        Store.scheduleSave();
        /* buildGrid 内部也会调 invalidateEduIfStale，这里已经先清过了，
           再调 paintEdu 只是为了让按钮状态立刻正确 */
        buildGrid(); syncDerived(); validateMode();
        paintMode(); paintAgeNote(); paintEdu();
        UI.toast(eduHit ? '已选定第 ' + (i + 1) + ' 组（教育变了，教育进步检定需重新掷）'
                        : '已选定第 ' + (i + 1) + ' 组天命属性', eduHit ? 'ok' : 'ok', eduHit ? 3600 : 2000);
      }

      var fateN = UI.input({
        type: 'number', inputmode: 'numeric', min: 2, max: 10, value: fate.n,
        oninput: function () {
          var v = parseInt(fateN.value, 10);
          if (v >= 2 && v <= 10) { fate.n = v; Store.scheduleSave(); }
        }
      });

      function paintFate() {
        UI.clear(fateHost);
        var rolled = fate.rolled;

        fateHost.appendChild(h('div.card-title', null, [
          h('span', { text: '模式三 · 天命 N 选一' }),
          rolled ? h('span.tag.gold', { text: '已掷出 · 不可重掷' }) : h('span.tag', { text: '未掷出' })
        ]));
        fateHost.appendChild(h('div.tiny.muted', {
          style: { lineHeight: '1.7', marginBottom: '10px' },
          html: '一次掷出 <b>N 组</b>完整属性，你从中挑一组用。<b>掷出后不能重掷</b> —— ' +
                '想换一批天命只能新建角色卡；挑中的那组会写进「属性值」，之后仍可手动微调。'
        }));

        fateHost.appendChild(h('div.grid2', null, [
          UI.field('组数 N（2 - 10 选 1）', fateN, {
            help: rolled ? '已掷出，组数锁定' : '例如填 10，就一次生成 10 组属性'
          }),
          UI.field('掷天命', h('div', null, [
            rolled
              ? h('button.btn.block', { text: '✓ 已掷出（不可重掷）', disabled: true })
              : h('button.btn.primary.block', { text: '🎲 掷出天命', onclick: rollFate })
          ]), { help: rolled ? '新建角色卡后才能重新掷' : '同样的组数只掷一次' })
        ]));
        if (rolled) fateN.readOnly = true;

        if (!rolled) return;

        var picked = fate.picked;
        fateHost.appendChild(h('div.notice' + (picked >= 0 ? '.ok' : '.warn'), {
          style: { marginTop: '4px', marginBottom: '11px' },
          text: picked >= 0
            ? '已选定第 ' + (picked + 1) + ' 组。仍可以在下面改选其它组，但不能再掷新的一批。'
            : '共 ' + fate.options.length + ' 组天命，选一组（点「选这组」）。'
        }));

        var box = h('div.fate-list');
        fate.options.forEach(function (opt, i) {
          var all = 0, noLuck = 0;
          SUM_KEYS.forEach(function (k) {
            var v = parseInt(opt[k], 10) || 0;
            all += v;
            if (k !== 'luck') noLuck += v;
          });
          var on = (picked === i);
          var cell = h('div.fate-opt' + (on ? '.on' : ''), null, [
            h('div.fo-head', null, [
              h('span.fo-no', { text: '第 ' + (i + 1) + ' 组' }),
              on ? h('span.tag.gold', { text: '已选定' }) : null,
              h('span.fo-sum', { text: '总 ' + all + '（不含幸运 ' + noLuck + '）' })
            ]),
            h('div.fate-grid', null, ATTRS.map(function (a) {
              return h('div.fate-cell', null, [
                h('span.k', { text: a.abbr }),
                h('span.v', { text: opt[a.key] })
              ]);
            })),
            h('button.btn' + (on ? '' : '.primary') + '.block', {
              text: on ? '✓ 就用这一组' : '选这组',
              disabled: on,
              onclick: function () { pickFate(i); }
            })
          ]);
          box.appendChild(cell);
        });
        fateHost.appendChild(box);
      }

      /* ---------- 模式四：方案 ---------- */
      var arrHost = h('div.card', null, [
        h('div.card-title', { text: '模式四 · 预设方案' }),
        h('div.tiny.muted', { text: '预留能力。选择后自动填入对应属性组合，可再手动微调。', style: { marginBottom: '10px' } }),
        h('div.btn-group', null, ['A', 'B', 'C'].map(function (k) {
          return h('button.btn', {
            text: '方案 ' + k,
            onclick: function () {
              var arr = R.generators.arrays[k];
              Object.keys(arr).forEach(function (key) { c.attributes[key] = arr[key]; });
              /* 预设方案同样会整体替换属性 */
              var eduHit = invalidateEduIfStale();
              buildGrid(); syncDerived(); validateMode();
              paintMode(); paintAgeNote(); paintEdu();
              Store.scheduleSave();
              UI.toast(eduHit ? '已应用方案 ' + k + '（教育变了，教育进步检定需重新掷）'
                              : '已应用方案 ' + k, 'ok', eduHit ? 3600 : 2000);
              ctx.refreshBar();
            }
          });
        }))
      ]);

      /* ---------- 模式切换 ---------- */
      var MODES = [
        { id: 'random', label: '随机生成', host: rollHost },
        { id: 'pointbuy', label: '手动购点', host: pbHost },
        { id: 'fate', label: '天命 N 选一', host: fateHost },
        { id: 'array', label: '属性方案', host: arrHost }
      ];
      // 4 个模式标签挤在一行会窄到看不清，改成两列网格
      var modeTabs = h('div.tabs', {
        style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '7px', marginBottom: '12px' }
      });
      MODES.forEach(function (m) {
        var chip = h('button.chip' + (c.attributeMode === m.id ? '.on' : ''), {
          text: m.label, style: { flex: '1', textAlign: 'center' },
          onclick: function () {
            c.attributeMode = m.id;
            Array.prototype.forEach.call(modeTabs.children, function (x) { x.classList.remove('on'); });
            chip.classList.add('on');
            paintMode(); validateMode(); Store.scheduleSave();
          }
        });
        m.chip = chip;
        modeTabs.appendChild(chip);
      });

      var modeHost = h('div');
      function paintMode() {
        UI.clear(modeHost);
        var m = MODES.filter(function (x) { return x.id === c.attributeMode; })[0];
        if (!m) return;
        modeHost.appendChild(m.host);
        // 天命卡片的内容随状态变化（未掷出 / 已掷出 / 已选定），每次进模式都重画
        if (m.id === 'fate') paintFate();
      }

      /* ---------- 购点实时校验 ----------
       * 提示里的每个数字都来自「本次」校验结果（res），并且 input 的 oninput 会调到这里，
       * 所以改上限 / 改任一属性值时，这些数字会立刻跟着变。
       */
      function validateMode() {
        syncHalves();
        paintSum();
        paintAgeNote();      // 属性变了，年龄扣减的说明也要跟着刷新
        applyLuckLock();
        // 底栏的「下一步」是否被拦截，取决于当前属性状态，
        // 所以每次校验都顺手刷新一下底栏（购点超额 / 天命没选都会在这里变成硬拦截）
        if (ctx.refreshBar) ctx.refreshBar();
        if (c.attributeMode !== 'pointbuy') { UI.clear(pbStatus); return; }
        var cap = parseInt(c.pbCap, 10);
        if (isNaN(cap)) cap = 0;
        var res = R.generators.validatePointBuy(c.attributes, cap, c.pbIncludeLuck);
        UI.clear(pbStatus);

        // 关键数字一目了然地摆出来：计入项数 / 已用 / 上限 / 超出或剩余
        var cells = [
          { k: '计入', v: res.counted + ' 项', n: c.pbIncludeLuck ? '含幸运' : '不含幸运' },
          { k: '已用', v: res.sum, n: '当前属性总和' },
          { k: '上限', v: res.cap, n: c.pbIncludeLuck ? '9 项总和上限' : '8 项总和上限' },
          res.over
            ? { k: '超出', v: res.overBy, n: '需减少的点数', bad: true }
            : { k: '剩余', v: Math.max(0, res.remain), n: '还可分配', good: true }
        ];
        pbStatus.appendChild(h('div.sum-grid', null, cells.map(function (x) {
          return h('div.sum-cell', null, [
            h('div.k', { text: x.k }),
            h('div.v', { text: x.v, style: x.bad ? { color: 'var(--danger, #e05a4f)' } : (x.good ? { color: 'var(--ok, #4fb98a)' } : null) }),
            h('div.n', { text: x.n })
          ]);
        })));

        pbStatus.appendChild(h('div.notice' + (res.ok ? '.ok' : '.err'), {
          ico: res.ok ? '✓' : '!',
          text: res.ok
            ? '合法。已用 ' + res.sum + ' 点，剩余 ' + Math.max(0, res.remain) + ' 点。'
            : res.errors.map(function (e) { return e.text; }).join('；'),
          style: { marginTop: '10px', marginBottom: 0 }
        }));
      }

      /* ---------- 教育进步检定（年龄调整的真正落地） ----------
       * 规则书：年龄带来的「教育进步检定」不是白送 EDU ——
       *   每次掷 1D100，结果 > 当前 EDU 才算进步，EDU +1D10（上限 99）。
       * 所以这里做成可点击的检定，逐次记录结果：不会重复掷、可以还原、也看得见到底加了几点。
       * 增益只进「生效属性」，玩家输入的原始 EDU 与购点校验都不受影响。
       *
       * ⚠️ 基准追踪（baseEdu）—— 这条很重要：
       * 检定是在「当时的 EDU」上掷出来的。如果玩家在检定之后又改了教育值
       * （换模式重掷、手动购点、随机模式重新生成…），之前那几次检定的
       * 「掷数 ≤ 当时的 EDU」这个前提已经不成立了，结果理应重做。
       * 所以每次检定都记下当时的原始 EDU；一旦原始 EDU 变了，
       * 面板会把已掷的检定标记为失效并提示重掷，而不是继续把旧增益
       * 叠加到新数值上 —— 后者会让「教育」在改属性后仍然只往一个方向走。
       */
      var eduHost = h('div.card', { id: 'eduCard' });

      function eduProg() {
        if (!c.eduProgress || typeof c.eduProgress !== 'object') c.eduProgress = { base: null, done: 0, log: [], bonus: 0 };
        if (!Array.isArray(c.eduProgress.log)) c.eduProgress.log = [];
        if (!c.eduProgress.bonus) c.eduProgress.bonus = 0;
        if (c.eduProgress.baseEdu === undefined || c.eduProgress.baseEdu === null) {
          c.eduProgress.baseEdu = rawEdu();
        }
        return c.eduProgress;
      }

      /** 玩家输入的原始 EDU（不含检定增益） */
      function rawEdu() {
        return parseInt(c.attributes.edu, 10) || 0;
      }

      /** 检定结果是否还成立：原始 EDU 变了就失效 */
      function eduStale() {
        var ps = c.eduProgress;
        if (!ps || !Array.isArray(ps.log) || !ps.log.length) return false;
        return ps.baseEdu !== rawEdu();
      }

      /**
       * 原始 EDU 变了就把旧检定**彻底作废**（清数据，不只是标记）。
       *
       * ⚠️ 上一版只把面板标成「已失效」却不清 log / bonus，
       * 结果 Engine.effAttrs() 里的 eduBonus 仍然是旧值 ——
       * 生效教育仍然被旧增益抬着，属性格上的「教育 +X」照样显示。
       * 这就是「改了教育还是套用之前的检定结果」的真正原因：
       * 面板改了，数据没改。现在改成数据层直接清空。
       *
       * 无效（stale）时返回 true，调用方据此决定要不要重绘面板。
       */
      function invalidateEduIfStale() {
        /* ⚠️ 真正的守卫在 Engine.dropStaleEduChecks() 里，由 Engine.recalc() 调用 ——
           改属性的路径太多（手动输入 / 随机接受 / 天命选定 / 预设方案 / 外部赋值），
           在界面层逐个补总会漏。前两版就是漏在「随机接受」和「天命选定」
           这两条不走 commit() 的路径上。
           这里只做一件事：调用引擎里的同一份逻辑，保证逻辑只有一份。 */
        if (!Engine.dropStaleEduChecks) return false;
        var hit = Engine.dropStaleEduChecks(c);
        /* recalc 通常已经清过了；这里补提示标记，
           让「点 stepper 回来」也能看到说明，而不是静默清空 */
        if (!hit && eduStale()) {
          c.eduProgress.log = []; c.eduProgress.bonus = 0; c.eduProgress.done = 0;
          c.eduProgress.staleFromEdu = c.eduProgress.baseEdu;
          c.eduProgress.baseEdu = rawEdu();
          c.eduProgress.resetAt = Date.now();
          hit = true;
        }
        return hit;
      }

      /** 每次检定都从「上一次结果」继续，形成 EDU 递增的链条 */
      function currentEdu() {
        var e = Engine.effAttrs(c).edu;
        return parseInt(e, 10) || 0;
      }

      function doEduCheck() {
        var need = R.ageProgressChecks(parseInt(c.basicInfo.age, 10) || 0);
        var ps = eduProg();
        if (need <= 0) { UI.toast('当前年龄没有教育进步检定', 'err'); return; }
        // 兜底：正常情况下 buildGrid() 已经清过了，但直接从别处调进来也保证一次
        invalidateEduIfStale();
        if (ps.log.length >= need) { UI.toast('教育进步检定已全部完成（' + need + ' 次）', 'err'); return; }

        var before = currentEdu();
        var r = R.eduImproveCheck(before);
        ps.baseEdu = rawEdu();
        ps.log.push({ n: ps.log.length + 1, roll: r.roll, before: before, gain: r.gain, after: Math.min(99, before + r.gain) });
        ps.bonus = ps.log.reduce(function (t, x) { return t + (x.gain || 0); }, 0);
        ps.done = ps.log.length;

        Engine.recalc(c); Store.scheduleSave();
        paintEdu(); paintDerived(); paintSum(); syncHalves();
        UI.toast(r.success
          ? '第 ' + ps.log.length + ' 次：掷 ' + r.roll + ' > EDU ' + before + '，教育 +' + r.gain
          : '第 ' + ps.log.length + ' 次：掷 ' + r.roll + ' ≤ EDU ' + before + '，没有进步', r.success ? 'ok' : null, 2600);
      }

      function doAllEduChecks() {
        var need = R.ageProgressChecks(parseInt(c.basicInfo.age, 10) || 0);
        var ps = eduProg();
        invalidateEduIfStale();
        var rounds = 0;
        while (ps.log.length < need && rounds < 30) {
          var before = currentEdu();
          var r = R.eduImproveCheck(before);
          ps.log.push({ n: ps.log.length + 1, roll: r.roll, before: before, gain: r.gain, after: Math.min(99, before + r.gain) });
          ps.bonus = ps.log.reduce(function (t, x) { return t + (x.gain || 0); }, 0);
          ps.done = ps.log.length;
          ps.baseEdu = rawEdu();
          Engine.recalc(c);
          rounds++;
        }
        Store.scheduleSave();
        paintEdu(); paintDerived(); paintSum(); syncHalves();
        UI.toast('已完成 ' + ps.log.length + '/' + need + ' 次检定，教育累计 +' + ps.bonus, 'ok');
      }

      function resetEduChecks() {
        c.eduProgress = { base: null, done: 0, log: [], bonus: 0, baseEdu: rawEdu(),
                          resetAt: 0, staleFromEdu: null };
        Engine.recalc(c); Store.scheduleSave();
        paintEdu(); paintDerived(); paintSum(); syncHalves();
        UI.toast('已还原教育进步检定', 'ok');
      }

      function paintEdu() {
        UI.clear(eduHost);
        var need = R.ageProgressChecks(parseInt(c.basicInfo.age, 10) || 0);
        var ps = eduProg();
        /* reset 是一次性的提示状态：上一轮检测到教育变了、检定已被清空，
           画完这一次就恢复成正常界面（不一直挂着「需重掷」）。 */
        var wasReset = !!c.eduProgress.resetAt;
        if (c.eduProgress.resetAt) { c.eduProgress.resetAt = 0; }
        var done = ps.log.length;
        var full = need > 0 && done >= need;

        eduHost.appendChild(h('div.card-title', null, [
          h('span', { text: '教育进步检定（年龄调整）' }),
          h('span.tag' + (full ? '.gold' : ''), { text: done + ' / ' + need + ' 次' })
        ]));

        if (need <= 0) {
          eduHost.appendChild(h('div.tiny.muted', {
            text: '当前年龄（' + (c.basicInfo.age || '—') + ' 岁）没有教育进步检定，20 岁起才会出现（40-49 岁为 2 次）。'
          }));
          return;
        }

        eduHost.appendChild(h('div.tiny.muted', {
          style: { lineHeight: '1.7' },
          html: '每次掷 <b>1D100</b>：结果 <b>大于</b>当前教育才进步，教育 <b>+1D10</b>（上限 99）。' +
                '增益计入「生效教育」，不覆盖你输入的原始值。'
        }));

        /* 教育值改动 → 检定已自动清空。明确告诉玩家「发生过什么」，
           而不是静默地把结果丢掉让人以为检定从没生效过。
           staleFromEdu 存的是「作废前按哪个 EDU 掷的」——
           别用 baseEdu（它已经被更新成新教育值了，显示会和「现在」对不上）。 */
        if (wasReset) {
          var fromEdu = ps.staleFromEdu;
          eduHost.appendChild(h('div.notice.warn', {
            style: { marginTop: '10px' },
            ico: '⚠',
            html: '<b>教育值改动过，原先的检定结果已清空。</b><br>' +
                  (fromEdu === undefined || fromEdu === null
                    ? '之前的检定是按旧的教育值掷的，判定条件已经变了。'
                    : '之前的检定是按 <b>EDU ' + fromEdu + '</b> 掷的，现在教育是 <b>' +
                      rawEdu() + '</b>，判定条件变了，需要重新掷。')
          }));
        }

        var nowEdu = currentEdu();
        eduHost.appendChild(h('div.row.wrap', { style: { gap: '7px', marginTop: '9px' } }, [
          h('span.tag', { text: '原始 EDU ' + rawEdu() }),
          h('span.tag' + (ps.bonus ? '.gold' : ''), { text: '检定增益 ' + (ps.bonus ? ('+' + ps.bonus) : '0') }),
          h('span.tag.arcane', { text: '生效 EDU ' + nowEdu })
        ]));

        if (ps.log.length) {
          var list = h('div', { style: { marginTop: '9px' } });
          ps.log.forEach(function (x) {
            list.appendChild(h('div.entry', null, [
              h('div.hd', null, [
                h('span.t', { text: '第 ' + x.n + ' 次' }),
                h('span.tag' + (x.gain > 0 ? '.gold' : ''), { text: x.gain > 0 ? '+' + x.gain : '无进步' })
              ]),
              h('div.tiny.dim', {
                text: '掷出 ' + x.roll + (x.gain > 0 ? ' > ' : ' ≤ ') + x.before +
                      '　→　教育 ' + x.before + ' → ' + x.after
              })
            ]));
          });
          eduHost.appendChild(list);
        }

        var btns = h('div.btn-group', { style: { marginTop: '11px' } }, [
          full
            ? h('button.btn.grow', { text: '✓ 已全部完成', disabled: true })
            : h('button.btn.primary.grow', { text: '🎲 掷一次检定（第 ' + (done + 1) + ' 次）', onclick: doEduCheck }),
          (!full && need - done > 1) ? h('button.btn', { text: '一键完成剩余 ' + (need - done) + ' 次', onclick: doAllEduChecks }) : null,
          (done > 0) ? h('button.btn.danger', { text: '还原', onclick: resetEduChecks }) : null
        ]);
        eduHost.appendChild(btns);
      }

      /* ---------- 年龄调整说明 ----------
       * 用户明确问过「年龄调整到底有没有自动加、加到哪去」，所以这里把机制写清楚：
       * 扣减不改写原始属性，而是生成一份「生效属性」，下游全部按它计算。
       */
      var ageNote = h('div.card', null, [
        h('div.card-title', { text: '年龄调整（自动生效）' }),
        h('div.tiny.dim', { id: 'ageNoteBody', style: { lineHeight: '1.75' } })
      ]);
      function paintAgeNote() {
        var adj = Engine.ageAdjustOf(c);
        var r = adj.rule;
        var body = ageNote.querySelector('#ageNoteBody');
        UI.clear(body);

        body.appendChild(h('div', {
          text: '年龄 ' + (c.basicInfo.age || '—') + ' 岁 → ' + (r.note || '无调整') + '。'
        }));

        var lossParts = [];
        Object.keys(LOSS_LABEL).forEach(function (k) {
          if (adj.loss && adj.loss[k]) lossParts.push(LOSS_LABEL[k] + ' −' + adj.loss[k]);
        });

        if (lossParts.length || adj.movLoss) {
          body.appendChild(h('div.notice.ok', {
            style: { marginTop: '9px', marginBottom: '9px' },
            ico: '✓',
            html: '已自动生效：' + (lossParts.length ? lossParts.join('、') : '属性无扣减') +
                  (adj.movLoss ? '，移动力 −' + adj.movLoss : '')
          }));
          body.appendChild(h('div.tiny.muted', { html:
            '扣减怎么分配：力量 / 体质 / 敏捷 三项<b>平均分摊</b>，' +
            '三项的扣减量最多相差 1，不会把某一项扣穿；单项最低扣到 <b>15</b>（3D6×5 的最低可能值）为止。' +
            (adj.unapplied ? '<br>属性本身偏低，有 <b>' + adj.unapplied + '</b> 点因触及 15 下限未能扣完。' : '') +
            '<br>扣减落在哪：① 属性格下方显示「年龄 −X → 最终 Y」；' +
            '② 派生属性 HP / 移动力 / 伤害加值 / 体格按<b>最终值</b>重算；' +
            '③ 技能基础值里依赖属性的部分（母语=教育、闪避=敏捷÷2）同样用最终值；' +
            '④ 角色卡页面显示的就是最终值。' +
            '<br>输入的原始属性<b>不会被改写</b>，改年龄时不会叠加扣减、也不会破坏购点上限校验。'
          }));
        } else {
          body.appendChild(h('div.tiny.muted', {
            style: { marginTop: '9px' },
            text: '当前年龄没有属性扣减（40 岁起才会扣力量/体质/敏捷与外貌）。'
          }));
        }
      }

      /* ---------- 组装 ---------- */
      root.appendChild(sumHost);
      root.appendChild(h('div.card', null, [
        h('div.card-title', { text: '派生属性（自动计算，不可手改）' }),
        derivedHost
      ]));
      root.appendChild(modeTabs);
      root.appendChild(modeHost);
      root.appendChild(h('div.card', null, [h('div.card-title', { text: '属性值' }), grid]));
      root.appendChild(eduHost);          // 教育进步检定（40 岁以上才有）
      root.appendChild(ageNote);

      Engine.recalc(c);
      buildGrid(); paintMode(); paintDerived(); paintSum(); validateMode(); paintAgeNote(); paintEdu();
      paintDerived();
    }
  };
})(window);
