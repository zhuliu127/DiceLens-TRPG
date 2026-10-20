/* ============================================================
 * gate.js — 暗号门（仅私有部署启用）
 *
 * 部署版在 build-config.js 里配 gateCode（非空即开）；开源版为空 →
 * 本文件完全透明，不改变任何行为。放在 build-config.js 之后、其它
 * 脚本之前加载，好在应用启动前就把没通过暗号的人挡在外面。
 *
 * 定位：这是「朋友门槛」，不是安全墙 —— 挡的是随手点进来的人，
 *       挡不住刻意翻源码的人（前端暗号本就可见）。求的是清净，不是保密。
 *
 * 行为：本地没有「已通过」标记 → 全屏暗号输入；输对写 localStorage 放行，
 *       之后同一浏览器不再问；输错可重试。想改成「每次打开都问」，
 *       把下面 pass()/ok() 里的 localStorage 换成 sessionStorage 即可。
 * ============================================================ */
(function (global) {
  'use strict';

  var CODE = (global.BuildConfig && String(global.BuildConfig.gateCode || '').trim()) || '';
  var KEY = 'coc7_gate_ok_v1';

  function ok() {
    try { return global.localStorage.getItem(KEY) === '1'; } catch (e) { return false; }
  }
  function pass() {
    try { global.localStorage.setItem(KEY, '1'); } catch (e) {}
  }

  /* 没配暗号，或这台浏览器早就过了 → 什么都不做 */
  if (!CODE || ok()) return;

  var doc = global.document;

  function css() {
    var s = doc.createElement('style');
    s.textContent =
      'html.coc7-gate-locked #app{visibility:hidden!important}' +
      '#coc7-gate{position:fixed;inset:0;z-index:2147483647;display:flex;' +
      'align-items:center;justify-content:center;background:#f2efe9;' +
      'font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}' +
      '#coc7-gate .g-card{width:min(86vw,360px);background:#fff;border:1px solid #e2dccf;' +
      'border-radius:16px;padding:28px 22px;box-shadow:0 12px 40px rgba(0,0,0,.12);text-align:center}' +
      '#coc7-gate .g-logo{width:56px;height:56px;border-radius:12px;margin:0 auto 12px;display:block}' +
      '#coc7-gate h2{margin:0 0 6px;font-size:19px;color:#3a3327}' +
      '#coc7-gate p{margin:0 0 16px;font-size:13px;color:#8a8172;line-height:1.6}' +
      '#coc7-gate input{width:100%;box-sizing:border-box;font-size:16px;padding:11px 12px;' +
      'border:1px solid #d8d0bf;border-radius:10px;outline:none;text-align:center;background:#faf8f3}' +
      '#coc7-gate input:focus{border-color:#a98f5f}' +
      '#coc7-gate button{width:100%;margin-top:12px;font-size:16px;padding:11px;border:none;' +
      'border-radius:10px;background:#7a6a4a;color:#fff;cursor:pointer}' +
      '#coc7-gate button:active{background:#65573c}' +
      '#coc7-gate .g-err{min-height:18px;margin-top:10px;font-size:13px;color:#c0392b}' +
      '#coc7-gate.shake{animation:gshake .35s}' +
      '@keyframes gshake{0%,100%{transform:translateX(0)}20%{transform:translateX(-8px)}' +
      '40%{transform:translateX(8px)}60%{transform:translateX(-5px)}80%{transform:translateX(5px)}}';
    doc.head.appendChild(s);
  }

  function unlock() {
    var g = doc.getElementById('coc7-gate');
    if (g && g.parentNode) g.parentNode.removeChild(g);
    doc.documentElement.classList.remove('coc7-gate-locked');
    pass();
  }

  function build() {
    css();
    doc.documentElement.classList.add('coc7-gate-locked');
    var wrap = doc.createElement('div');
    wrap.id = 'coc7-gate';
    wrap.innerHTML =
      '<div class="g-card">' +
        '<img class="g-logo" src="img/logo-192.png" alt="">' +
        '<h2>朋友入口</h2>' +
        '<p>这是私人跑团车卡工具，仅对朋友开放。<br>请输入暗号进入。</p>' +
        '<input id="coc7-gate-in" type="text" autocomplete="off" autocapitalize="off" placeholder="请输入暗号">' +
        '<button id="coc7-gate-btn" type="button">进 入</button>' +
        '<div class="g-err" id="coc7-gate-err"></div>' +
      '</div>';
    doc.body.appendChild(wrap);

    var inp = doc.getElementById('coc7-gate-in');
    var btn = doc.getElementById('coc7-gate-btn');
    var err = doc.getElementById('coc7-gate-err');

    function tryUnlock() {
      if (String(inp.value).trim() === CODE) {
        unlock();
      } else {
        err.textContent = '暗号不对，再试试～';
        inp.value = '';
        wrap.classList.remove('shake');
        void wrap.offsetWidth; /* 重启抖动动画 */
        wrap.classList.add('shake');
        inp.focus();
      }
    }
    btn.addEventListener('click', tryUnlock);
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') tryUnlock();
    });
    inp.focus();
  }

  /* 脚本在 <body> 内同步执行，此时 body 已存在，直接建门，避免闪现 */
  build();
})(typeof window !== 'undefined' ? window : this);
