/* ============================================================
 * avatar.js — 自动头像
 *
 * 随机预设卡与 AI 车卡都不保证玩家会上传头像。以前没头像就显示一个
 * 灰底的「◈」，一整列角色卡看过去全都一样，认不出谁是谁。
 *
 * 这里用姓名的第一个字 + 一组按名字散列的配色，现场生成一张
 * 「复古徽章」风格的 SVG 头像，转成 dataURI 直接存进角色卡的 avatar 字段。
 * 好处是：不占体积（一张约 1KB）、不放任何外部图片、无限不重复。
 * ============================================================ */
(function (global) {
  'use strict';

  /* 配色：底色渐变 + 主色（描线与文字） */
  var PALETTES = [
    { a: '#233047', b: '#111a28', f: '#d4a94a' },
    { a: '#2c3f3a', b: '#0f1d1a', f: '#57c2ab' },
    { a: '#3a2733', b: '#1b1018', f: '#d98aa0' },
    { a: '#2f2a3f', b: '#14111f', f: '#a99be8' },
    { a: '#3d2f22', b: '#1d1510', f: '#e0b072' },
    { a: '#22364a', b: '#0d161f', f: '#7fb2d8' },
    { a: '#3b2b2b', b: '#1a1111', f: '#e08a6a' },
    { a: '#33403f', b: '#141b1b', f: '#c8cfa8' }
  ];

  /* 古早 / 神秘题材用暖调多一点 */
  var WARM = [4, 6, 0, 2, 7];

  function strHash(s) {
    var hv = 2166136261;
    s = String(s || '');
    for (var i = 0; i < s.length; i++) {
      hv ^= s.charCodeAt(i);
      hv = (hv * 16777619) >>> 0;
    }
    return hv >>> 0;
  }

  /** 取姓名的首字：中文取第一个汉字；西文译名取第一段的第一个字母 */
  function initialOf(name) {
    var n = String(name || '').trim();
    if (!n) return '？';
    // 「亨利·阿米蒂奇」→「亨」；「A. Smith」→「A」
    var m = n.match(/[\u4e00-\u9fa5]/);
    if (m) return m[0];
    return n.charAt(0).toUpperCase();
  }

  function escapeXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /**
   * 生成头像 dataURI
   * @param {string} name    角色名（决定首字与配色）
   * @param {string} flavor  'warm' 走暖色调（古代 / 1920 年代），其余随机
   */
  function make(name, flavor) {
    var hv = strHash(name || 'x');
    var pal;
    if (flavor === 'warm') pal = PALETTES[WARM[hv % WARM.length]];
    else pal = PALETTES[hv % PALETTES.length];
    var ch = escapeXml(initialOf(name));
    var rot = hv % 360;
    var dots = 6 + (hv % 5);

    // 外圈小点（按名字散列数量与角度，保证不同名字长得不一样）
    var ring = '';
    for (var i = 0; i < dots; i++) {
      var ang = (Math.PI * 2 * i) / dots;
      var x = (120 + 100 * Math.cos(ang)).toFixed(1);
      var y = (120 + 100 * Math.sin(ang)).toFixed(1);
      ring += '<circle cx="' + x + '" cy="' + y + '" r="2.2" fill="' + pal.f + '" fill-opacity=".55"/>';
    }

    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="240" height="240">' +
        '<defs>' +
          '<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">' +
            '<stop offset="0" stop-color="' + pal.a + '"/>' +
            '<stop offset="1" stop-color="' + pal.b + '"/>' +
          '</linearGradient>' +
        '</defs>' +
        '<rect width="240" height="240" fill="url(#bg)"/>' +
        '<circle cx="120" cy="120" r="104" fill="none" stroke="' + pal.f + '" stroke-opacity=".16" stroke-width="1"/>' +
        '<circle cx="120" cy="120" r="88" fill="none" stroke="' + pal.f + '" stroke-opacity=".42" stroke-width="2"/>' +
        '<path d="M60 120 A60 60 0 0 1 180 120" fill="none" stroke="' + pal.f + '" stroke-opacity=".22" stroke-width="6" stroke-linecap="round" transform="rotate(' + rot + ' 120 120)"/>' +
        ring +
        '<text x="120" y="124" text-anchor="middle" dominant-baseline="middle" ' +
          'font-family="serif" font-size="98" font-weight="700" fill="' + pal.f + '">' + ch + '</text>' +
      '</svg>';

    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  /** 只在没有头像时填一张，已有就原样返回 */
  function ensure(character, flavor) {
    if (!character) return '';
    if (character.avatar) return character.avatar;
    character.avatar = make(character.characterName, flavor);
    return character.avatar;
  }

  global.CocAvatar = { make: make, ensure: ensure, initialOf: initialOf };
})(window);
