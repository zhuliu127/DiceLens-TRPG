/* ============================================================
 * device-id.js — 设备标识（v2.0.2 T1）
 * 对外命名：window.DeviceId
 *
 * 用途只有一个：**「设备即身份」** —— 断线重连 / 换机续玩时，服务端凭这个
 * 稳定标识认出「你还是原来那个座位」，而不是把你当成一个刚进来的新人
 * （新人会拿到新 seat → 准备状态 / 绑定角色卡 / 行动顺序全丢）。
 *
 * 两个来源，前缀区分：
 *   · 安卓原生桥可用（App 内）→ 'a-' + sha256(packageName + ':' + ANDROID_ID)
 *     —— 同签名 + 同用户 + 同设备下，卸载重装后仍不变（见 MainActivity#getDeviceId）。
 *   · 无桥环境（桌面浏览器 / Node 测试 / WebView 桥不可用）→ 'b-' + 本地随机 UUID，
 *     持久化在 localStorage。**同一台设备多次调用结果一致**（这是 C6 的验收点）。
 *
 * ⚠️ 边界：安卓原生码在「换签名（oss/self 双包）或恢复出厂」后会变 → 被视为新玩家；
 *    浏览器降级码在「清浏览器数据 / 换浏览器」后会变。两者都是可接受的取舍（用户已拍板）。
 *
 * 获取时机：由调用方惰性调用 DeviceId.get()（room-net.js 在建房/加入/WS 连接时），
 * 不在 boot 期同步取 —— 避免原生调用阻塞首屏。
 * ============================================================ */
(function (global) {
  'use strict';

  var KEY = 'coc7.device.id.v1';
  var cached = null;

  /** 无桥环境降级：本地随机 UUID 并持久化（同设备多次调用一致） */
  function uuid() {
    try {
      var s = global.localStorage.getItem(KEY);
      if (s) return s;
    } catch (e) { /* 隐私模式 / 无 localStorage → 走内存随机（本次会话内一致） */ }
    var v = 'b-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    try { global.localStorage.setItem(KEY, v); } catch (e) { /* 忽略 */ }
    return v;
  }

  /** 返回本机稳定标识；永不抛异常，最坏情况也返回一个非空字符串 */
  function get() {
    if (cached) return cached;
    try {
      var B = global.AndroidBridge;
      if (B && typeof B.getDeviceId === 'function') {
        var d = String(B.getDeviceId() || '');
        if (d) { cached = 'a-' + d; return cached; }   // 'a-' = 安卓原生稳定码
      }
    } catch (e) { /* 桥抛异常 → 降级 */ }
    cached = uuid();                                   // 'b-' = 浏览器降级随机码
    return cached;
  }

  global.DeviceId = { get: get };
})(typeof window !== 'undefined' ? window : this);
