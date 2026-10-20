package com.teaegg.coc7card;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

import org.json.JSONObject;

/**
 * COC 7th 调查员车卡器 —— 原生外壳
 *
 * Web 应用以 https://appassets.androidplatform.net 作为虚拟源提供给 WebView，
 * 这样 localStorage 才能稳定持久化（file:// 源的存储在部分 WebView 版本上不可用）。
 */
public class MainActivity extends Activity {

    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/index.html";

    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;
    private static final int REQ_FILE = 1001;

    /** 局域网房间服务：KP 点「开房（局域网）」时才启动，离开房间时停掉。 */
    private LanServer lanServer;
    private static final int LAN_PORT = 4211;

    private static final Map<String, String> MIME = new HashMap<String, String>();
    static {
        MIME.put("html", "text/html");
        MIME.put("htm", "text/html");
        MIME.put("js", "application/javascript");
        MIME.put("css", "text/css");
        MIME.put("json", "application/json");
        MIME.put("png", "image/png");
        MIME.put("jpg", "image/jpeg");
        MIME.put("jpeg", "image/jpeg");
        MIME.put("webp", "image/webp");
        MIME.put("svg", "image/svg+xml");
        MIME.put("ico", "image/x-icon");
        MIME.put("woff", "font/woff");
        MIME.put("woff2", "font/woff2");
        MIME.put("ttf", "font/ttf");
        MIME.put("txt", "text/plain");
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(false);
        /* v1.19.0：必须用 ALWAYS_ALLOW，不能退回 COMPATIBILITY_MODE —— 否则局域网模式必然不可用。
         *
         * 背景：本页面的源是虚拟 https 源（https://appassets.androidplatform.net），
         * 而「局域网房间」的服务地址是 http://192.168.x.x:4211 —— 一个裸私有 IP 的明文地址。
         * 从 https 页面请求 http 地址，属于「混合内容（Mixed Content）」。
         *
         * 为什么 COMPATIBILITY_MODE 不行：
         *   COMPATIBILITY_MODE 对齐的是现代浏览器的默认行为 —— 只放行/升级
         *   upgradable 的被动内容（图片等），而 fetch()、XMLHttpRequest、WebSocket(ws:)
         *   被 W3C Mixed Content 规范归为 blockable，浏览器**必须拦截**。
         *   web/js/core/room-net.js 恰恰是在页面里直接用 global.fetch(...) 和
         *   new global.WebSocket(url) 访问局域网地址的，因此这两种请求都会被拦掉。
         *   这正是真机现象「回环 http://127.0.0.1:4211 秒通、局域网 http://192.168.x.y:4211
         *   12ms 秒失败」的根因 —— 回环地址被 W3C Secure Contexts 视为可信、不算混合内容，
         *   私有 IP 不在可信列表则被拦；秒失败（而非超时）正是「被策略拦下」的特征。
         *
         * 光放行这一层还不够：系统网络栈也要允许明文，即
         *   network_security_config.xml 的 <base-config cleartextTrafficPermitted="true"/>
         * 配合 manifest 的 usesCleartextTraffic="true"（已在 v1.18.4 落地）。两层都设对，局域网才通。
         *
         * 安全边界：敏感数据（AI 请求 / 角色卡上传）走的是公共模型服务域名，
         * 它们在 network_security_config.xml 的 domain-config 里被显式钉死为 TLS；
         * 这里放行的明文只用于用户自己在同一 WiFi 内开的房间中继，
         * 广播内容本就是同网段可见的角色状态，不涉及账号密码。 */
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
        // 保持用户选择的主题（暗/亮），不做强制反色
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            s.setForceDark(WebSettings.FORCE_DARK_OFF);
        }

        webView.addJavascriptInterface(new Bridge(), "AndroidBridge");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri != null && HOST.equals(uri.getHost())) {
                    String path = uri.getPath();
                    if (path == null) path = "/index.html";
                    if (path.startsWith("/")) path = path.substring(1);
                    if (path.isEmpty()) path = "index.html";
                    try {
                        InputStream is = getAssets().open(path);
                        return new WebResourceResponse(mimeOf(path), "utf-8", 200, "OK",
                                Collections.<String, String>emptyMap(), is);
                    } catch (IOException e) {
                        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                                Collections.<String, String>emptyMap(),
                                new ByteArrayInputStream(("404 " + path).getBytes()));
                    }
                }
                return null;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri != null && HOST.equals(uri.getHost())) return false;
                // 外部链接交给系统浏览器
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException ignored) {
                }
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = cb;
                try {
                    Intent intent = params.createIntent();
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(intent, REQ_FILE);
                    return true;
                } catch (Exception e) {
                    filePathCallback = null;
                    Toast.makeText(MainActivity.this, "无法打开文件选择器", Toast.LENGTH_SHORT).show();
                    return false;
                }
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                android.util.Log.d("COC7", m.message() + " @" + m.lineNumber());
                return true;
            }
        });

        if (savedInstanceState == null) {
            webView.loadUrl(START_URL);
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    private String mimeOf(String path) {
        int dot = path.lastIndexOf('.');
        if (dot < 0) return "application/octet-stream";
        String ext = path.substring(dot + 1).toLowerCase();
        String m = MIME.get(ext);
        return m != null ? m : "application/octet-stream";
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (filePathCallback != null) {
                Uri[] result = null;
                if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                    result = new Uri[]{data.getData()};
                }
                filePathCallback.onReceiveValue(result);
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) webView.saveState(outState);
    }

    /**
     * 系统返回键：把决定权交给网页层。
     *
     * 页面用 App.handleBack() 逐级回退，返回 true 表示「已经处理掉了」：
     *   · 有弹层 → 关掉最上面一层
     *   · 在创建向导里 → 退到上一步；已经在第 0 步 → 回首页
     *   · 在角色卡 / 我的角色页 → 回首页
     * 只有网页明确回答「没得退了」才真正退出应用。
     *
     * 之前这里是网页自己判断 hash：而创建向导并不写 hash，
     * 于是车卡到一半按返回就直接退回系统桌面，草稿都没存。
     */
    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript(
                "(function(){try{return (window.App&&App.handleBack)?(App.handleBack()?'1':'0'):'0';}" +
                "catch(e){return '0';}})()",
                value -> {
                    boolean handled = value != null && value.contains("1");
                    if (!handled) MainActivity.super.onBackPressed();
                });
    }

    /* ============================================================
     * JS 桥：把导出的图片 / JSON 写入系统相册或下载目录
     * ============================================================ */
    public class Bridge {

        @JavascriptInterface
        public boolean isAndroid() { return true; }

        /**
         * 稳定设备标识：供房间身份绑定 / 断线重连使用（v2.0.2 T1）。
         *
         * 取 Settings.Secure.ANDROID_ID（API 24+ **无需任何权限**；同一签名 + 同一用户 +
         * 同一设备下，卸载重装后不变）。隐私：在原生侧做 sha256(packageName + ":" + ANDROID_ID)
         * 后再暴露，不外泄原始标识；packageName 作盐保证「每应用隔离」且重装稳定
         * （不引入随机盐，否则重装后变化，违背「稳定」目标）。无 ANDROID_ID（极少数设备）→ 返回 ""。
         *
         * ⚠️ 稳定性边界（用户已接受）：换签名（oss / self 双包签名不同）或系统「恢复出厂 /
         *    重置广告 ID」后 ANDROID_ID 会变 → 本机将被视为新玩家（需重新加入 / 绑定）。
         */
        @JavascriptInterface
        public String getDeviceId() {
            try {
                String raw = android.provider.Settings.Secure.getString(
                        getContentResolver(), android.provider.Settings.Secure.ANDROID_ID);
                if (raw == null || raw.isEmpty()) return "";
                String salt = getPackageName();
                java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
                byte[] d = md.digest((salt + ":" + raw).getBytes("UTF-8"));
                StringBuilder sb = new StringBuilder();
                for (byte b : d) sb.append(String.format("%02x", b));
                return sb.toString();
            } catch (Exception e) { return ""; }
        }

        @JavascriptInterface
        public String saveImage(String dataUrl, String fileName) {
            try {
                byte[] bytes = decodeDataUrl(dataUrl);
                if (bytes == null) return "数据解析失败";
                String name = safeName(fileName, "COC7角色卡.png");

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Images.Media.DISPLAY_NAME, name);
                    v.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
                    v.put(MediaStore.Images.Media.RELATIVE_PATH,
                            Environment.DIRECTORY_PICTURES + "/COC7th");
                    Uri uri = getContentResolver()
                            .insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
                    if (uri == null) return "无法创建媒体条目";
                    OutputStream os = getContentResolver().openOutputStream(uri);
                    if (os == null) return "无法写入";
                    os.write(bytes);
                    os.close();
                    return "saved:Pictures/COC7th/" + name;
                } else {
                    File dir = new File(getExternalFilesDir(null), "images");
                    if (!dir.exists() && !dir.mkdirs()) return "无法创建目录";
                    File f = new File(dir, name);
                    FileOutputStream fos = new FileOutputStream(f);
                    fos.write(bytes);
                    fos.close();
                    return "saved:" + f.getAbsolutePath();
                }
            } catch (Exception e) {
                return "失败：" + e.getMessage();
            }
        }

        @JavascriptInterface
        public String saveText(String content, String fileName) {
            try {
                String name = safeName(fileName, "coc7-character.json");
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                    v.put(MediaStore.Downloads.MIME_TYPE, "application/json");
                    v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    Uri uri = getContentResolver()
                            .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (uri == null) return "无法创建下载条目";
                    OutputStream os = getContentResolver().openOutputStream(uri);
                    os.write(content.getBytes("UTF-8"));
                    os.close();
                    return "saved:Download/" + name;
                } else {
                    File dir = new File(getExternalFilesDir(null), "export");
                    if (!dir.exists() && !dir.mkdirs()) return "无法创建目录";
                    File f = new File(dir, name);
                    FileOutputStream fos = new FileOutputStream(f);
                    fos.write(content.getBytes("UTF-8"));
                    fos.close();
                    return "saved:" + f.getAbsolutePath();
                }
            } catch (Exception e) {
                return "失败：" + e.getMessage();
            }
        }

        @JavascriptInterface
        public void toast(final String msg) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show());
        }

        /**
         * 复制文本到系统剪贴板。
         * WebView 里 navigator.clipboard 需要安全上下文与用户手势，
         * 安卓外壳下走原生更可靠。
         */
        @JavascriptInterface
        public boolean copyToClipboard(final String text) {
            if (text == null) return false;
            try {
                final ClipboardManager cm =
                        (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm == null) return false;
                runOnUiThread(() -> cm.setPrimaryClip(ClipData.newPlainText("COC7th 分享链接", text)));
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        /** 用系统浏览器打开链接（分享链接点了能直接看） */
        @JavascriptInterface
        public boolean openUrl(final String url) {
            if (url == null || url.trim().isEmpty()) return false;
            try {
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url.trim()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(i);
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        /**
         * 发起一次 HTTPS 请求（供接入第三方大模型使用）。
         *
         * 为什么不让网页直接用 fetch：
         *   1) 网页跑在 https://appassets.androidplatform.net 虚拟源下，
         *      请求外部 API 属于跨域，浏览器会先发 OPTIONS 预检，
         *      而多数模型服务并不返回 CORS 头 —— 直接被拦；
         *   2) 用户若填了 http:// 的接口地址，WebView 会按混合内容策略拦截。
         * 走原生请求两个问题都不存在，而且能在子线程执行，不卡界面。
         *
         * 结果通过 window.__cocHttpDone(reqId, resultJson) 异步回传，
         * resultJson 形如：{"ok":true,"status":200,"body":"..."}
         */
        @JavascriptInterface
        public void httpPostAsync(final String reqId, final String url,                                  final String headersJson, final String body) {
            new Thread(new Runnable() {
                @Override
                public void run() {
                    String result;
                    try {
                        result = httpPost(url, headersJson, body);
                    } catch (Exception e) {
                        String msg = e.getMessage();
                        result = "{\"ok\":false,\"error\":" + jsonStr(msg == null ? "请求失败" : msg) + "}";
                    }
                    deliverHttp(reqId, result);
                }
            }).start();
        }

        /**
         * GET 探测（AI 设置的「测试连接」第一步会打 /models）。
         * 与 POST 共用同一个回调通道 window.__cocHttpDone。
         */
        public void httpGetAsync(final String reqId, final String url, final String headersJson) {
            new Thread(new Runnable() {
                @Override
                public void run() {
                    String result;
                    try {
                        result = httpGet(url, headersJson);
                    } catch (Exception e) {
                        String msg = e.getMessage();
                        result = "{\"ok\":false,\"error\":" + jsonStr(msg == null ? "请求失败" : msg) + "}";
                    }
                    deliverHttp(reqId, result);
                }
            }).start();
        }

        /** 把子线程拿到的结果切回主线程，回调给网页 */
        private void deliverHttp(final String reqId, final String payload) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (webView == null) return;
                    webView.evaluateJavascript(
                            "window.__cocHttpDone&&window.__cocHttpDone(" +
                            jsonStr(reqId) + "," + jsonStr(payload) + ")", null);
                }
            });
        }

        /* ============================================================
         * 局域网房间服务桥
         *
         * 为什么必须由原生来开这个服务：
         *   WebView 里的网页**不能**监听端口、也做不了 UDP 广播。
         *   局域网直连的「权威端 = KP 那台手机」这句话，落到实现上就是
         *   「KP 的手机上跑一个房间中继服务」—— 只能原生做。
         *
         * 但服务本身只是个哑管道：游戏状态仍在网页层的 RoomModel.Host 里，
         * 这个服务负责房间目录、准入、以及把字节转给对的人（见 LanServer）。
         * 因此网页层不需要为局域网写第二套逻辑 —— 它只是拿到一个能用的地址。
         * ============================================================ */

        /** 当前是否有可用的局域网地址（没连 WiFi / 没开热点时为 false） */
        @JavascriptInterface
        public boolean lanAvailable() { return LanServer.hasLan(); }

        /** 本机局域网 IP（形如 192.168.1.7）；没有则返回空串 */
        @JavascriptInterface
        public String lanIp() {
            String ip = LanServer.localIpv4();
            return ip == null ? "" : ip;
        }

        /**
         * 启动局域网房间服务。返回 {ok, base, port, ip} 的 JSON 串。
         * base 就是网页层要填进 ROOM_SERVER_BASE 的 http 地址。
         * 重复调用是幂等的（已经在跑就直接回当前信息）。
         */
        @JavascriptInterface
        public String lanStart() {
            try {
                if (lanServer == null || !lanServer.isRunning()) {
                    if (lanServer != null) { try { lanServer.stop(); } catch (Exception ignored) { } }
                    /* v2.0.0：注入 App 私有 files 目录作为存档落盘根目录
                       （LanServer 会写到 <filesDir>/rooms/<code>.state.json）。
                       不注入则 LanServer 兜底用 java.io.tmpdir —— 在安卓上那是 App 私有
                       cache 目录，系统可能随时清理；而「今天跑不完、明天接着跑」的续玩场景
                       要求存档长期可靠，故必须用 files 目录（不会被系统清理）。
                       getFilesDir() 返回绝对路径，无需任何权限。 */
                    lanServer = new LanServer(LAN_PORT, getFilesDir());
                    int p = lanServer.start();
                    android.util.Log.d("COC7", "LanServer started on " + p);
                }
                JSONObject o = new JSONObject();
                o.put("ok", true);
                o.put("port", lanServer.getPort());
                String ip = LanServer.localIpv4();
                o.put("ip", String.valueOf(ip));
                o.put("base", lanServer.httpBase());
                /* v1.18.4：没有私有网段地址 = 没连 WiFi / 没开热点。
                   这时 httpBase() 会退化成 127.0.0.1 —— 那间房**只有自己能进**，
                   同伴的邀请链接指向一个他们永远连不上的地址。
                   必须把这个状态如实回报给界面，让它在建房前就说清楚，
                   而不是等用户拿两台手机试了半天才发现（需求 §2.3：不做假承诺）。 */
                o.put("wifi", ip != null);
                return o.toString();
            } catch (Exception e) {
                try {
                    JSONObject o = new JSONObject();
                    o.put("ok", false);
                    o.put("error", e.getMessage() == null ? "局域网服务启动失败" : e.getMessage());
                    return o.toString();
                } catch (Exception e2) {
                    return "{\"ok\":false,\"error\":\"局域网服务启动失败\"}";
                }
            }
        }

        /** 停止局域网房间服务（离开房间 / 关房时调用）。 */
        @JavascriptInterface
        public void lanStop() {
            if (lanServer != null) {
                try { lanServer.stop(); } catch (Exception ignored) { }
                lanServer = null;
            }
        }

        @JavascriptInterface
        public boolean lanRunning() { return lanServer != null && lanServer.isRunning(); }

        /**
         * 广播发现：问「这个网段里有谁开着跑团房间」。
         *
         * 网页端发不出 UDP 广播，所以这一问一答必须原生做。
         * 结果通过 window.__cocLanFound(jsonArray) 异步回传，形如：
         *   [{"code":"ab12cd","name":"...","kp":"...","needPwd":false,
         *     "players":1,"maxPlayers":4,"status":"RECRUITING","base":"http://192.168.1.7:4211"}]
         *
         * timeoutMs 是等待应答的窗口（1.5~2 秒比较合适：太短会漏，
         * 太长玩家会觉得「点了没反应」）。
         */
        @JavascriptInterface
        public void lanDiscover(final int timeoutMs) {
            new Thread(new Runnable() {
                @Override
                public void run() {
                    final String payload = discoverLan(timeoutMs <= 0 ? 1600 : timeoutMs);
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            if (webView == null) return;
                            webView.evaluateJavascript(
                                    "window.__cocLanFound&&window.__cocLanFound(" + payload + ")", null);
                        }
                    });
                }
            }).start();
        }

        /* ============================================================
         * 屏幕方向 / 缩放桥（v2.0.0；v2.1.1 取消强制横屏）
         *
         * v2.0.0：进入「游戏页」时强制横屏、离开时恢复跟随系统。
         * v2.1.1（用户第三轮反馈）：**取消强制横屏** —— 游戏页改为**跟随系统旋转**。
         *   setGameOrientation 保留（向后兼容），但不再请求任何锁定方向。
         *
         * 为什么方向切换必须走原生：
         *   WebView 里的网页无法改变宿主 Activity 的屏幕方向，
         *   只能通过 JS 桥请原生去改。且 setRequestedOrientation 必须
         *   切到 UI 线程执行，否则在部分 ROM 上无效、甚至抛异常。
         *
         * 方向：App 全程跟随系统（onCreate 仍是 UNSPECIFIED）。
         *
         * 界面缩放是纯前端实现（F 线在游戏页容器上做
         * transform: scale()），setPinchZoom 的实际用途是「能关掉
         * WebView 原生缩放，避免它与前端捏合手势互相打架」。
         * ============================================================ */

        /**
         * 切换游戏页屏幕方向（v2.1.1 变更：**取消强制横屏**）。
         *
         * v2.0.0 起前端进入游戏页会调本方法请求 landscape 以强制横屏。
         * v2.1.1（用户第三轮反馈）：改为**跟随系统旋转** —— 本方法不再锁死方向，
         * 无论入参为何，一律请求 UNSPECIFIED。保留方法本身只为**向后兼容**
         * （旧前端缓存 / 其它调用点仍可安全调用，不会把屏幕方向锁死）。
         *
         * @param mode 已忽略（历史参数：曾为 {@code "landscape"} / {@code "auto"}）。
         * @return 固定返回 {@code "ok"}，与既有桥方法保持同一返回风格。
         */
        @JavascriptInterface
        public String setGameOrientation(final String mode) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    /* v2.1.1：恒定「跟随系统」，不再请求任何锁定方向。 */
                    setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                }
            });
            return "ok";
        }

        /**
         * 开关 WebView 自身缩放。
         *
         * @param enabled {@code true} → 打开原生缩放；{@code false} → 关闭。
         *                displayZoomControls 恒为 false（不显示那对 +/− 悬浮按钮）。
         * @return 固定返回 {@code "ok"}。
         */
        @JavascriptInterface
        public String setPinchZoom(final boolean enabled) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (webView == null) return;
                    WebSettings s = webView.getSettings();
                    s.setSupportZoom(enabled);
                    s.setBuiltInZoomControls(enabled);
                    s.setDisplayZoomControls(false);
                }
            });
            return "ok";
        }
    }

    /**
     * UDP 广播探测：发 "COCROOM?" 到广播地址的 DISCOVER 端口，
     * 收集 timeoutMs 内所有应答，去重后返回 JSON 数组。
     *
     * 为什么同时发「子网广播」和「255.255.255.255 全局广播」：
     * 部分安卓 ROM 会丢弃全局广播；而子网广播需要正确掩码。
     * 两个都发一遍，命中率最高，代价只是多一个包。
     */
    private static String discoverLan(int timeoutMs) {
        java.net.DatagramSocket sock = null;
        java.util.LinkedHashMap<String, JSONObject> found =
                new java.util.LinkedHashMap<String, JSONObject>();
        try {
            sock = new java.net.DatagramSocket();
            sock.setBroadcast(true);
            sock.setSoTimeout(300);

            byte[] probe = LanServer.DISCOVER_MAGIC.getBytes("UTF-8");
            java.util.List<java.net.InetAddress> targets = new java.util.ArrayList<java.net.InetAddress>();
            try { targets.add(java.net.InetAddress.getByName("255.255.255.255")); } catch (Exception ignored) { }
            java.net.InetAddress subnet = subnetBroadcast();
            if (subnet != null) targets.add(subnet);

            for (java.net.InetAddress t : targets) {
                try {
                    sock.send(new java.net.DatagramPacket(probe, probe.length,
                            t, LanServer.DISCOVER_PORT));
                } catch (Exception ignored) { }
            }

            long deadline = System.currentTimeMillis() + timeoutMs;
            byte[] buf = new byte[1024];
            while (System.currentTimeMillis() < deadline) {
                java.net.DatagramPacket pkt = new java.net.DatagramPacket(buf, buf.length);
                try {
                    sock.receive(pkt);
                } catch (java.net.SocketTimeoutException te) {
                    continue;
                } catch (Exception e) {
                    break;
                }
                try {
                    String text = new String(pkt.getData(), 0, pkt.getLength(), "UTF-8");
                    JSONObject o = new JSONObject(text);
                    String code = o.optString("code", "");
                    if (code.isEmpty()) continue;
                    if (found.containsKey(code)) continue;
                    // 把「从哪来」补齐：应答里没有地址，只有端口，用来源 IP 拼 base
                    int port = o.optInt("port", LAN_PORT);
                    o.put("base", "http://" + pkt.getAddress().getHostAddress() + ":" + port);
                    found.put(code, o);
                } catch (Exception ignored) { }
            }
        } catch (Exception ignored) {
        } finally {
            if (sock != null) try { sock.close(); } catch (Exception ignored) { }
        }

        StringBuilder sb = new StringBuilder("[");
        boolean first = true;
        for (JSONObject o : found.values()) {
            if (!first) sb.append(',');
            sb.append(o.toString());
            first = false;
        }
        sb.append(']');
        return sb.toString();
    }

    /** 本网段的广播地址（如 192.168.1.255）。拿不到就返回 null，只发全局广播。 */
    private static java.net.InetAddress subnetBroadcast() {
        try {
            for (java.util.Enumeration<java.net.NetworkInterface> e =
                 java.net.NetworkInterface.getNetworkInterfaces(); e.hasMoreElements(); ) {
                java.net.NetworkInterface ni = e.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (java.net.InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    java.net.InetAddress b = ia.getBroadcast();
                    if (b != null && b instanceof java.net.Inet4Address) return b;
                }
            }
        } catch (Exception ignored) { }
        return null;
    }


    /** 同步 POST JSON，返回 {"ok":..,"status":..,"body":..} */
    private static String httpPost(String url, String headersJson, String body) throws Exception {
        return http("POST", url, headersJson, body, 120000);
    }

    /** 同步 GET，返回 {"ok":..,"status":..,"body":..}。用于 /models 这类无请求体的探测。 */
    private static String httpGet(String url, String headersJson) throws Exception {
        return http("GET", url, headersJson, null, 20000);
    }

    private static String http(String method, String url, String headersJson, String body, int readTimeoutMs) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            conn.setRequestMethod(method);
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(readTimeoutMs);
            conn.setUseCaches(false);

            /* ⚠️ 所有请求头必须在「连接建立」之前设完。
               conn.getOutputStream() 一被调用，连接就真正建立了，
               此后再调 setRequestProperty 会抛
               IllegalStateException: Cannot set request property after connection is made。
               （曾经把 Accept 写在 getOutputStream 后面，导致 AI 功能全线报「连接失败」，
                 但 Key / 地址其实都是对的。） */
            conn.setRequestProperty("Accept", "application/json");
            if (headersJson != null && !headersJson.isEmpty()) {
                JSONObject h = new JSONObject(headersJson);
                Iterator<String> it = h.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    conn.setRequestProperty(k, h.optString(k, ""));
                }
            }
            if (body != null) {
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                OutputStream os = conn.getOutputStream();
                os.write(body.getBytes("UTF-8"));
                os.flush();
                os.close();
            }

            int code = conn.getResponseCode();
            InputStream is = (code >= 200 && code < 300) ? conn.getInputStream() : conn.getErrorStream();
            String text = readAll(is);
            JSONObject out = new JSONObject();
            out.put("ok", code >= 200 && code < 300);
            out.put("status", code);
            out.put("body", text == null ? "" : text);
            return out.toString();
        } finally {
            try { conn.disconnect(); } catch (Exception ignored) { }
        }
    }

    private static String readAll(InputStream is) throws IOException {
        if (is == null) return "";
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        is.close();
        return new String(bos.toByteArray(), "UTF-8");
    }

    /** 把任意字符串转成安全的 JS 字符串字面量（含引号） */
    private static String jsonStr(String s) {
        if (s == null) return "\"\"";
        StringBuilder sb = new StringBuilder(s.length() + 16);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n");  break;
                case '\r': sb.append("\\r");  break;
                case '\t': sb.append("\\t");  break;
                case '\u2028': sb.append("\\u2028"); break;
                case '\u2029': sb.append("\\u2029"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        sb.append('"');
        return sb.toString();
    }

    private byte[] decodeDataUrl(String dataUrl) {
        if (dataUrl == null) return null;
        int comma = dataUrl.indexOf(',');
        if (comma < 0) return null;
        String b64 = dataUrl.substring(comma + 1);
        try {
            return Base64.decode(b64, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private String safeName(String fileName, String fallback) {
        if (fileName == null || fileName.trim().isEmpty()) return fallback;
        String n = fileName.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
        return n.isEmpty() ? fallback : n;
    }
}
