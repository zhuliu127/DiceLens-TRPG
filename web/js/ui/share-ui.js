/* ============================================================
 * share-ui.js — 角色卡云分享的界面部分
 *
 * 完成步骤与角色卡预览页都用它，避免两处各写一套。
 * ============================================================ */
(function (global) {
  'use strict';
  var h = UI.h;

  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /** 链接展示行：号码 + 复制 + 打开 */
  function linkRow(rec) {
    return h('div', null, [
      h('div.tiny.muted', { text: '分享链接（任何人可打开，只读）' }),
      h('div.link-box', { text: rec.url }),
      h('div.btn-group', { style: { marginTop: '9px' } }, [
        h('button.btn.sm.teal.grow', { text: '📋 复制链接', onclick: function () { global.CocShare.copy(rec.url); } }),
        h('button.btn.sm.grow', { text: '🌐 浏览器打开', onclick: function () { global.CocShare.open(rec.url); } })
      ]),
      h('div.tiny.muted', { style: { marginTop: '9px' }, text: '管理口令（删除该分享时需要，建议记下来）：' }),
      h('div.tiny', {
        text: rec.delToken || '—',
        style: { fontFamily: 'var(--mono)', wordBreak: 'break-all', color: 'var(--gold-str)' }
      }),
      h('div.tiny.muted', { style: { marginTop: '4px' }, text: '生成于 ' + fmtTime(rec.at) })
    ]);
  }

  /** 关掉当前所有弹层（跳设置前用） */
  function closeSheets() {
    // 走 UI.closeAllSheets 而不是自己 remove 节点 —— 直接摘 DOM 会绕过
    // close()，在 openSheets 栈里留下僵尸记录并让滚动锁归不了零，
    // 页面之后会永久划不动。
    UI.closeAllSheets();
  }

  /** 打开「设置」页 —— 云分享服务地址在那儿填 */
  function openSettings() {
    closeSheets();
    if (global.App && global.App.go) global.App.go('#/settings');
  }

  /**
   * 未配置云分享服务时的占位卡片。
   * 不报错、不隐藏功能，而是把「怎么开启」和「不开也能用」两件事说清楚。
   */
  function configCard() {
    var canCustom = !(global.BuildConfig && global.BuildConfig.allowCustomShareBase === false);
    var body = h('div');
    body.appendChild(h('div.small.muted', {
      style: { marginBottom: '11px', lineHeight: '1.75' },
      text: canCustom
        ? '云分享需要先指定一个后端服务地址。「设置 → 角色卡云分享」里填入你自己的服务地址即可开启，服务端程序随项目提供。'
        : '本版本未内置云分享服务。'
    }));
    body.appendChild(h('div.small.muted', {
      style: { marginBottom: '12px', lineHeight: '1.75' },
      text: '不配置也完全不影响使用：角色卡始终保存在本机，可以用「🖼 生成图片」或「💾 导出存档」直接发给队友。'
    }));
    if (canCustom) {
      body.appendChild(h('button.btn.block', { text: '⚙ 去设置里填写服务地址', onclick: openSettings }));
    }
    return h('div.card', { style: { marginTop: '12px' } }, [
      h('div.card-head', null, [
        h('h3', { text: '☁ 云分享' }),
        h('span.hint', { text: '未配置' })
      ]),
      body
    ]);
  }

  /**
   * 分享卡片
   * @param c        角色对象
   * @param onChange 状态变化后的回调（可选）
   */
  function panel(c, onChange) {
    var host = h('div');
    var busy = false;

    function paint() {
      UI.clear(host);
      var rec = global.CocShare.getFor(c.id);

      /* 没配服务地址就别摆上传按钮 —— 点了只会失败，不如直接给引导 */
      if (!global.CocShare.configured()) {
        host.appendChild(configCard());
        return;
      }

      var head = h('div.card-head', null, [
        h('h3', { text: '☁ 云分享' }),
        h('span.hint', { text: rec ? '已生成' : '未分享' })
      ]);
      var body = h('div');

      if (rec) {
        body.appendChild(linkRow(rec));
        body.appendChild(h('div.btn-group', { style: { marginTop: '12px' } }, [
          h('button.btn.sm.grow', { text: '↻ 更新为当前版本', onclick: function () { doCreate(rec); } }),
          h('button.btn.sm.danger.grow', {
            text: '删除分享', onclick: function () {
              UI.confirm('删除后该链接立即失效，其他人将无法打开。确定删除吗？',
                { okText: '删除', danger: true }).then(function (ok) {
                  if (!ok) return;
                  global.CocShare.remove(c.id).then(function () {
                    UI.toast('分享已删除', 'ok');
                    paint(); onChange && onChange();
                  }, function (err) { UI.toast(err.message || '删除失败', 'err', 3000); });
                });
            }
          })
        ]));
      } else {
        body.appendChild(h('div.small.muted', {
          style: { marginBottom: '12px', lineHeight: '1.7' },
          text: '把角色卡上传到你自己的服务器，生成一个只读链接。发给 KP 或队友，他们用浏览器就能看到完整角色卡，不需要安装本应用。'
        }));
        body.appendChild(h('button.btn.primary.block', { text: '☁ 生成分享链接', onclick: function () { doCreate(null); } }));
      }

      host.appendChild(h('div.card', { style: { marginTop: '12px' } }, [head, body]));
    }

    function doCreate(old) {
      if (busy) return;
      busy = true;
      UI.toast(old ? '正在更新分享…' : '正在上传角色卡…');

      global.CocShare.create(c)
        .then(function (j) {
          UI.toast(old ? '分享已更新' : '分享链接已生成', 'ok');
          Store.scheduleSave();
          paint();
          onChange && onChange();
          // 生成后直接把链接摆到面前，省得再点一次
          UI.sheet({
            title: '分享链接已生成',
            body: h('div', null, [
              UI.notice('链接已复制前的最后一步：点下面的按钮复制，或长按链接手动复制。', null, '☁'),
              linkRow({ url: j.url, delToken: j.delToken, at: Date.now() }),
              h('button.btn.primary.block', {
                text: '📋 复制链接', style: { marginTop: '12px' },
                onclick: function () { global.CocShare.copy(j.url); }
              })
            ])
          });
        })
        .catch(function (err) {
          var msg = (err && err.message) || '网络异常';
          if (msg === 'UNCONFIGURED') { paint(); return; }
          if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
            msg = '无法连接分享服务器，请检查网络后重试。';
          }
          UI.sheet({
            title: '分享失败',
            body: h('div', null, [
              UI.notice(msg, 'err', '✕'),
              h('div.small.muted', { style: { marginTop: '10px', lineHeight: '1.7' },
                text: '角色卡已经保存在本机，不会丢失。稍后重试即可。' })
            ])
          });
        })
        .then(function () { busy = false; });
    }

    paint();                       // 首次渲染：直接往 host 里填内容
    return { el: host, repaint: paint };
  }

  /** 角色卡预览页用的一键分享按钮 */
  function quickShare(c, onChange) {
    if (!global.CocShare.configured()) {
      UI.sheet({
        title: '☁ 云分享',
        body: h('div', null, [
          UI.notice('还没有配置分享服务地址，无法生成云分享链接。', null, '☁'),
          h('div.small.muted', { style: { marginTop: '10px', lineHeight: '1.75' },
            text: '你可以在设置里填入自建服务地址；也可以改用「🖼 生成图片」把角色卡发给队友。' }),
          h('button.btn.primary.block', {
            text: '⚙ 去设置里填写服务地址', style: { marginTop: '12px' }, onclick: openSettings
          })
        ])
      });
      return;
    }
    var rec = global.CocShare.getFor(c.id);
    if (rec) {
      UI.sheet({
        title: '☁ 云分享',
        body: h('div', null, [
          linkRow(rec),
          h('div.btn-group', { style: { marginTop: '12px' } }, [
            h('button.btn.sm.grow', { text: '↻ 更新为当前版本', onclick: function () {
              closeSheets();
              UI.toast('正在更新分享…');
              global.CocShare.create(c).then(function () {
                UI.toast('分享已更新', 'ok'); onChange && onChange();
              }, function (e) { UI.toast((e && e.message) || '更新失败', 'err', 3000); });
            } })
          ])
        ])
      });
      return;
    }
    UI.toast('正在上传角色卡…');
    global.CocShare.create(c).then(function (j) {
      UI.toast('分享链接已生成', 'ok');
      onChange && onChange();
      UI.sheet({
        title: '分享链接已生成',
        body: h('div', null, [linkRow({ url: j.url, delToken: j.delToken, at: Date.now() })])
      });
    }, function (e) {
      UI.toast((e && e.message) || '分享失败', 'err', 3000);
    });
  }

  global.ShareUI = { panel: panel, quickShare: quickShare, linkRow: linkRow };
})(window);
