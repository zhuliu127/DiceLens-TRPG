/* ============================================================
 * build-config.js — 版本配置（打包时按 edition 覆盖）
 *
 * 仓库里这份是「开源版」的默认值：不预置任何人的服务器地址。
 * 「自用版」由打包流程用 edition/self/build-config.js 覆盖
 * （该目录不入库，见 .gitignore）。
 *
 * 字段说明：
 *   edition               'oss' = 开源版，'self' = 自用版
 *   shareBase             云分享后端基址。空字符串 = 未预置，由用户自填
 *   roomBase              跑团房间中继基址（公网）。空字符串 = 未预置，由用户自填
 *   allowCustomShareBase  是否允许用户在「设置」里自行填写服务地址
 *   gateCode              访问暗号。空字符串 = 不启用暗号门（开源版默认；私有部署才填）
 *   sameOriginRoom        true = 未配置任何房间地址时，用「当前网页所在的源」当中继
 *                        （局域网一体服专用：网页与中继同源）。默认 false。
 *   displayName           界面文案里使用的应用名
 *
 * ⚠️ shareBase 与 roomBase 是**两个不同的服务**（云分享 vs 房间中继），
 *    不要指望配了其中一个另一个就能用。`RoomNet.presetBase()` 只读 roomBase。
 *
 * ⚠️ 除本文件外，任何地方都不要硬编码服务器地址。
 * ============================================================ */
(function (global) {
  'use strict';

  global.BuildConfig = {
    edition: 'oss',
    shareBase: '',
    roomBase: '',
    allowCustomShareBase: true,
    gateCode: '',
    sameOriginRoom: false,
    displayName: '骰境 TRPG',
    /* 作者信息（开源版默认留空 = 不显示邮箱/B站/主页）；
       自用版可在 edition/self/build-config.js 里填写。 */
    authorName: '茶叶蛋',
    authorEmail: '',
    authorBili: '',
    authorSite: '',
    versionName: '2.13.13'
  };
})(window);
