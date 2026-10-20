package com.teaegg.coc7card;

import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.URLDecoder;
import java.nio.charset.Charset;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * LanServer —— 跑团房间的「局域网直连」内嵌服务（KP 那台手机上跑的那个）。
 *
 * ## 它是什么，不是什么
 *
 * 它**不是**一个游戏逻辑服务端。游戏状态、事件序号、可见性裁剪全部在
 * KP 端的 RoomModel.Host 里（跑在同一台手机的 WebView 里）。本类只做三件事：
 *
 *   ① 房间目录 / 建房 / 准入 / 关房（与公网 room_server.py 完全同一套 HTTP 接口）
 *   ② 把 KP 发来的 hub.* 指令翻译成「发给谁」，再把玩家的字节转成 peer.msg 送给 KP
 *   ③ 额外提供一步「发现」：局域网里谁开了房间（UDP 广播应答），
 *      这样玩家不用手抄 IP 就能进房
 *
 * ## 为什么协议必须与公网版一模一样
 *
 * 需求 §11.1 明确要求「局域网与公网调用同一套房间事件协议、权限规则与 CoC 规则
 * 服务，避免实现两份不一致逻辑」。所以前端的 room-net.js 里**没有**任何
 * 「如果是局域网就…」的分支 —— 它只认「一个 HTTP 基址 + 一个 WS 地址」。
 * 本类因此必须逐字段复刻 room_server.py 的返回值（ready / peer.open /
 * peer.close / host.ok / hub.*），否则前端两端就会分叉。
 *
 * ⚠️ 因此若日后改了公网服务端的接口，这个文件必须同步改 —— 它们是一份契约的两侧。
 *
 * ## 与公网版刻意不同的三点（都是「手机当主机」决定的）
 *
 *   1. **房间元数据不落库，但游戏存档落盘**。公网版用 SQLite 存房间元数据是为了跨进程
 *      重启后仍在；手机端的一次跑团是「应用活着才在」的会话，房间元数据仍全部在内存里，
 *      服务关闭即消失 —— 这与「房间号作废」的语义一致。但 **v2.0.0 起，游戏存档
 *      （不透明 payload）必须落盘**（<filesDir>/rooms/<code>.state.json），否则
 *      「改天续玩 / 断线重连从服务器同步存档」在局域网下无法成立。落盘用
 *      「先写临时文件再 rename」保证原子，读到损坏文件时容错为「无存档」。
 *      ⚠️ 房间元数据仍是内存态：进程重启后房间本身不存在（存档文件仍在盘上），
 *         本轮不持久化房间元数据。
 *   2. **单进程内多线程**，没有 janitor 线程：预留位用惰性过期（每次访问时清），
 *      省一个常驻线程和它带来的竞态。
 *   3. **额外提供 UDP 发现**（DISCOVER 端口）。公网版靠域名，局域网靠广播。
 *
 * ## 线程模型
 *
 *   accept 循环  → 每条连接一个读线程（与公网版一致，够用且简单）
 *   heartbeat    → 每条 WS 连接一个定时线程（25 秒 ping）
 *   discover     → 一个 daemon 线程响应广播探测
 *
 * 所有对 Room 的读写都过 Room.lock（与公网版同构），Conn 的写走 Conn.lock。
 */
final class LanServer {

    private static final String TAG = "COC7-Lan";

    /* ============================================================
     * 常量：协议层（必须与 room_server.py 对齐）
     * ============================================================ */

    private static final int CODE_LEN = 6;
    private static final int MAX_FRAME = 64 * 1024;        // 单条 WS 消息上限
    private static final int MAX_HTTP_BODY = 16 * 1024;    // 房间元数据请求体上限
    // 单条游戏存档（不透明 payload）上限，超过 → too_large。**必须与 room_server.py 同值。**
    private static final int MAX_STATE_BYTES = 16 * 1024 * 1024;   // v2.1.3：2MB→16MB（同 room_server.py）
    // 存档端点的 HTTP 请求体上限（JSON 包裹/转义会带来额外开销，故高于 payload 上限本身）。
    private static final int MAX_STATE_BODY = 48 * 1024 * 1024;    // v2.1.3：6MB→48MB（同 room_server.py）
    private static final int MAX_ROOMS = 8;                // 一台手机同时开 8 个房足够了
    private static final int MAX_MEMBERS = 24;
    private static final int MAX_PLAYERS_HARD = 12;

    private static final long RESERVE_TTL_MS = 120_000L;   // 预留位有效期
    private static final long HEARTBEAT_MS = 25_000L;

    /** 房间号字符集：去掉 0/o/1/l/i 这些抄下来会看混的（与公网版一致） */
    private static final String CODE_ALPHA = "23456789abcdefghjkmnpqrstuvwxyz";

    /* WebSocket opcode / 关闭码（注释见 room_server.py 的同名常量） */
    private static final int OP_CONT = 0x0, OP_TEXT = 0x1, OP_BIN = 0x2,
            OP_CLOSE = 0x8, OP_PING = 0x9, OP_PONG = 0xA;

    private static final int CLOSE_NORMAL = 1000;
    private static final int CLOSE_TAKEOVER = 4001;
    private static final int CLOSE_REJECT = 4002;
    private static final int CLOSE_TIMEOUT = 4003;
    private static final int CLOSE_KICKED = 4004;

    private static final String WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    /* ============================================================
     * 发现协议（局域网专有）
     *
     * 玩家端发一个 UDP 广播 "COCROOM?\n" 到 4210 端口；
     * 每个开着房间的 KP 回一行 JSON：
     *   {"svc":"cocroom","port":4211,"code":"ab12cd","name":"...","kp":"...",
     *    "needPwd":false,"players":1,"maxPlayers":4,"status":"RECRUITING"}
     *
     * 刻意用纯 UDP 广播 + 明文 JSON 而不是 mDNS/NSD：
     *   · mDNS 在部分安卓 ROM 上被省电策略拦，且各厂商实现差异大；
     *   · 我们要的信息很少（谁在哪、能不能进），一个自描述的应答就够；
     *   · 没有第三方依赖，出问题能一眼看明白 —— 与「单文件标准库」的取向一致。
     * ============================================================ */
    static final int DISCOVER_PORT = 4210;
    /* 包内可见（不是 private）：MainActivity 里的「搜索周围房间」要用同一个魔数发广播，
       两处各写一份字符串早晚会改成不一致 —— 那时表现是「搜不到房间」而没有任何报错。 */
    static final String DISCOVER_MAGIC = "COCROOM?";

    /* ============================================================
     * 状态
     * ============================================================ */

    private final int port;
    private ServerSocket tcp;
    private volatile java.net.DatagramSocket discoverSock;
    private volatile boolean running = false;

    /**
     * 存档落盘根目录（一般是 Context.getFilesDir()）。为 null 时退化为
     * java.io.tmpdir 下的 cocroom 目录 —— 那在安卓上就是 App 私有 cache 目录，
     * 进程重启后仍能读到，但不保证长期不被系统清理。
     *
     * ⚠️ 最小侵入：本类构造签名原本只有 (port)，且调用方 MainActivity 属于 B 线在改的文件，
     *    本轮**不改调用方**。故这里提供 (port, stateDir) 重载 + setStateDir() 注入点，
     *    旧的 (port) 构造保持可用（内部 stateDir=null → 走 tmpdir 兜底）。
     */
    private volatile File stateDir;
    private final Object stateLock = new Object();

    private final Map<String, Room> rooms = new LinkedHashMap<String, Room>();
    private final Object registryLock = new Object();

    /** 成员 token → {role, nickname, code}。仅内存，随服务结束消失。 */
    private final Map<String, Member> members = new HashMap<String, Member>();

    /**
     * v2.0.2：设备 ↔ 座位绑定（key = "code|deviceId" → [seat, role, nickname]）。
     * 与公网版 device_seats 表同构；落盘到 &lt;code&gt;.seats.json，使 App 重启后仍能回座。
     */
    private final Map<String, String[]> deviceSeats =
            new java.util.concurrent.ConcurrentHashMap<String, String[]>();
    /** 已从磁盘载入 seats 的房间号，避免每次查绑定都读盘。 */
    private final java.util.Set<String> seatsLoaded = new java.util.HashSet<String>();

    private final Random rnd = new Random();

    /** 房间元信息（相当于公网版的 rooms 表一行，但不落盘） */
    static final class RoomMeta {
        String code, name, rules = "coc7", kpName;
        boolean needPwd;
        String pwdSalt = "", pwdHash = "";
        int maxPlayers = 4;
        boolean allowSpec = true;
        String status = "RECRUITING";
        String hostToken;
        long createdAt, lastSeen;
        /**
         * v2.1.0 缺陷3：本房是否是**从磁盘恢复的历史僵尸房**（transient，不落盘）。
         * 进程启动时 loadPersistedMeta 会把上次遗留的 SUSPENDED/RECRUITING 房恢复进来，
         * 它们会与「本轮新建的房」一起排在 metaIndex 里。UDP 发现应答必须**优先推
         * 本轮新建/加入的房**，否则玩家「搜索附近房间」会进到旧房间（房间号对不上）。
         */
        boolean restored = false;
    }

    static final class Member {
        String role, nickname, code, cid;
    }

    LanServer(int port) {
        this(port, null);
    }

    /** 带存档目录的构造（推荐：由 MainActivity 传 getFilesDir()）。 */
    LanServer(int port, File stateDir) {
        this.port = port;
        this.stateDir = stateDir;
    }

    /** 运行期注入存档目录（不改构造调用方的最小侵入方式）。 */
    void setStateDir(File dir) {
        this.stateDir = dir;
    }

    /* ============================================================
     * 生命周期
     * ============================================================ */

    /** 启动。返回实际监听的端口；失败抛 IOException。 */
    int start() throws IOException {
        tcp = new ServerSocket();
        tcp.setReuseAddress(true);
        tcp.bind(new InetSocketAddress(port));
        running = true;

        // 恢复落盘的房间元数据（「改天续玩」：进程重启后 SUSPENDED/RECRUITING 房间仍在）。
        // 必须在开始 accept 之前完成，避免「刚起来时房间列表还是空的」竞态。
        loadPersistedMeta();

        Thread t = new Thread(new Runnable() {
            @Override public void run() { acceptLoop(); }
        }, "cocroom-accept");
        t.setDaemon(true);
        t.start();

        startDiscovery();
        Log.d(TAG, "lan server listening on " + port);
        return tcp.getLocalPort();
    }

    void stop() {
        running = false;
        try { if (tcp != null) tcp.close(); } catch (Exception ignored) { }
        try { if (discoverSock != null) discoverSock.close(); } catch (Exception ignored) { }
        /* 先把房间摘出来，再在锁外关连接：关连接要碰 socket，可能阻塞。 */
        List<Room> snapshot;
        synchronized (registryLock) {
            snapshot = new ArrayList<Room>(rooms.values());
            rooms.clear();
            metaIndex.clear();
            members.clear();
        }
        for (Room r : snapshot) {
            try { r.closeAll(); } catch (Exception ignored) { }
        }
    }

    boolean isRunning() { return running; }

    int getPort() { return port; }

    /* ============================================================
     * 地址工具：拿到本机局域网 IP（给邀请链接用）
     * ============================================================ */

    /**
     * 本机在当前 WiFi/热点网段上的 IPv4 地址。
     *
     * ⚠️ 不能用 InetAddress.getLocalHost()：它常返回 127.0.0.1，
     *    在部分 ROM 上还会因为 DNS 反查而卡住。必须遍历网卡，
     *    跳过回环与未启用的，取第一个站点本地地址。优先 wlan（WiFi）。
     *
     * ⚠️ v1.18.4 修的第二个坑：**兜底分支不能收任何非回环 IPv4。**
     *    旧写法是「取第一个不是回环 4 地址的 IP 当 fallback」，
     *    于是**蜂窝网卡**（rmnet_data0 / ccmni0）也会被选中。
     *    在运营商 CGNAT 下它长这样：100.173.143.28（实测，见用户截图）。
     *    这个地址：
     *      · 同伴在 WiFi 上**永远连不上**（它不在局域网里）；
     *      · 却会被当成「本机局域网地址」写进邀请链接与界面提示，
     *        把用户引向「是不是不在同一 WiFi」的错误排查方向。
     *    所以兜底只接受**私有网段**（10/172.16-31/192.168）——
     *    局域网开房本来就只可能用这些地址。拿不到就返回 null，
     *    界面会如实说「本机还没有可用的局域网地址（先连 WiFi / 开热点）」。
     */
    static String localIpv4() {
        String fallback = null;
        try {
            Enumeration<NetworkInterface> nis = NetworkInterface.getNetworkInterfaces();
            while (nis != null && nis.hasMoreElements()) {
                NetworkInterface ni = nis.nextElement();
                try {
                    if (!ni.isUp() || ni.isLoopback()) continue;
                } catch (SocketException e) {
                    continue;
                }
                String nm = ni.getName() == null ? "" : ni.getName().toLowerCase();
                Enumeration<InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress a = addrs.nextElement();
                    if (!(a instanceof Inet4Address) || a.isLoopbackAddress()) continue;
                    String ip = a.getHostAddress();
                    if (ip == null || ip.startsWith("169.254.")) continue;   // 链路本地地址没用
                    /* 只认私有网段 —— 蜂窝网段的公网 IP 对局域网开团毫无意义 */
                    if (!isPrivateIpv4(ip)) continue;
                    if (nm.startsWith("wlan") || nm.startsWith("ap")) return ip;
                    if (fallback == null) fallback = ip;
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "localIpv4 failed: " + e.getMessage());
        }
        return fallback;
    }

    /**
     * 是否是「局域网里能互相访问」的私有 IPv4。
     *
     * 三大私网段：10.0.0.0/8、172.16.0.0/12、192.168.0.0/16。
     * 注意 172 段只认 16~31，别把 172.32+（那是公网）也放进来。
     */
    static boolean isPrivateIpv4(String ip) {
        if (ip == null) return false;
        if (ip.startsWith("10.")) return true;
        if (ip.startsWith("192.168.")) return true;
        if (ip.startsWith("172.")) {
            int dot = ip.indexOf('.', 4);
            if (dot > 4) {
                try {
                    int second = Integer.parseInt(ip.substring(4, dot));
                    return second >= 16 && second <= 31;
                } catch (NumberFormatException ignored) {
                    return false;
                }
            }
        }
        return false;
    }

    /** 当前是否有可用的局域网地址（没有就说明没连 WiFi / 没开热点） */
    static boolean hasLan() { return localIpv4() != null; }

    /* ============================================================
     * UDP 发现应答
     * ============================================================ */

    private void startDiscovery() {
        Thread t = new Thread(new Runnable() {
            @Override public void run() { discoveryLoop(); }
        }, "cocroom-discover");
        t.setDaemon(true);
        t.start();
    }

    private void discoveryLoop() {
        java.net.DatagramSocket sock = null;
        try {
            sock = new java.net.DatagramSocket(DISCOVER_PORT);
            sock.setBroadcast(true);
            sock.setReuseAddress(true);
            discoverSock = sock;
            byte[] buf = new byte[256];
            while (running) {
                java.net.DatagramPacket pkt = new java.net.DatagramPacket(buf, buf.length);
                try {
                    sock.receive(pkt);
                } catch (Exception e) {
                    if (!running) break;
                    continue;
                }
                String q = new String(pkt.getData(), 0, pkt.getLength(),
                        Charset.forName("UTF-8")).trim();
                if (!DISCOVER_MAGIC.equals(q)) continue;

                String reply = discoverReply();
                if (reply == null) continue;   // 没开着房间：静默，别打扰
                byte[] out = reply.getBytes(Charset.forName("UTF-8"));
                try {
                    sock.send(new java.net.DatagramPacket(out, out.length,
                            pkt.getAddress(), pkt.getPort()));
                } catch (Exception ignored) { }
            }
        } catch (Exception e) {
            Log.w(TAG, "discovery loop: " + e.getMessage());
        } finally {
            if (sock != null) try { sock.close(); } catch (Exception ignored) { }
        }
    }

    /**
     * 从候选房间里挑「当前最该被发现的那个」。
     *
     * v2.1.0 缺陷3修复：**优先本轮进程内新建/加入的房（restored==false），
     * 而不是从磁盘恢复的历史僵尸房（restored==true）。**
     *
     * 旧实现的坑：按 LinkedHashMap 的**插入顺序**取第一个非关闭房、并优先 RECRUITING。
     * 而 loadPersistedMeta() 在 start() 时会把上次遗留的 SUSPENDED/RECRUITING 房先塞进表，
     * 本轮新建的房 append 在末尾 → pick 命中**旧房间**，UDP 广播的 code 不是 KP 当前这个房，
     * 玩家搜索加入后「房间号对不上」。
     *
     * 排序优先级（逐级比较，取最优）：
     *   ① 新鲜房 > 恢复房（restored 越小越优）；
     *   ② 同等新鲜度下，RECRUITING 优先（还在招募更该被看到）；
     *   ③ 同等条件下，lastSeen 更新者优先（近期活跃）。
     * 这样：有新房时永远推新房；没有新房（例如 KP 显式续玩旧房）时才回落到恢复房。
     *
     * ⚠️ 本方法刻意**不碰 JSON / 网络 / 日志**，是纯函数 —— 便于脱离安卓运行时单测
     * （tools/probe_lan_discover/Probe.java）。
     *
     * @param candidates 候选房间（顺序无关，通常是 metaIndex.values()）
     * @return 最优房间；全部关闭/挂起时返回 null
     */
    static RoomMeta pickDiscoverableRoom(java.util.Collection<RoomMeta> candidates) {
        RoomMeta pick = null;
        if (candidates == null) return null;
        for (RoomMeta m : candidates) {
            if (m == null) continue;
            // 挂起 / 已关闭的房间不该被 UDP 发现推出去
            if ("CLOSED".equals(m.status) || "SUSPENDED".equals(m.status)) continue;
            if (pick == null) { pick = m; continue; }
            if (preferRoom(m, pick)) pick = m;
        }
        return pick;
    }

    /** cand 是否比 cur 更该被推出去（见 {@link #pickDiscoverableRoom} 的排序优先级）。 */
    private static boolean preferRoom(RoomMeta cand, RoomMeta cur) {
        // ① 新鲜房优先于恢复房
        if (cand.restored != cur.restored) return !cand.restored;
        // ② 同等新鲜度：RECRUITING 优先
        boolean cRec = "RECRUITING".equals(cand.status);
        boolean kRec = "RECRUITING".equals(cur.status);
        if (cRec != kRec) return cRec;
        // ③ 同等条件：更近活跃者优先
        return cand.lastSeen > cur.lastSeen;
    }

    /**
     * 把「当前最该被发现的那个房间」编成一行 JSON。
     * 同时开多个房时，优先推本轮新建、且还在招募的（见 pickDiscoverableRoom）。
     */
    private String discoverReply() {
        synchronized (registryLock) {
            RoomMeta pick = pickDiscoverableRoom(metaIndex.values());
            if (pick == null) return null;
            Room live = rooms.get(pick.code);
            int players = 0, specs = 0;
            if (live != null) {
                Counts c = live.counts();
                players = c.players;
                specs = c.spectators;
            }
            try {
                JSONObject o = new JSONObject();
                o.put("svc", "cocroom");
                o.put("port", port);
                o.put("code", pick.code);
                o.put("name", pick.name);
                o.put("kp", pick.kpName);
                o.put("needPwd", pick.needPwd);
                o.put("players", players);
                o.put("spectators", specs);
                o.put("maxPlayers", pick.maxPlayers);
                o.put("status", pick.status);
                return o.toString();
            } catch (Exception e) {
                return null;
            }
        }
    }

    /** code → RoomMeta。与 rooms 一一对应。 */
    private final Map<String, RoomMeta> metaIndex = new LinkedHashMap<String, RoomMeta>();

    /* ============================================================
     * 房间与连接
     * ============================================================ */

    static final class Counts {
        int players, spectators, livePlayers, liveSpectators, pending;
        boolean hasHost;
    }

    final class Room {
        final String code;
        Conn host;
        final Map<String, Conn> players = new HashMap<String, Conn>();
        final Map<String, Conn> spectators = new HashMap<String, Conn>();
        final Map<String, long[]> pending = new HashMap<String, long[]>();  // mtoken → [at, roleFlag]
        final Object lock = new Object();

        Room(String code) { this.code = code; }

        void expirePending() {
            long now = System.currentTimeMillis();
            synchronized (lock) {
                List<String> dead = new ArrayList<String>();
                for (Map.Entry<String, long[]> e : pending.entrySet()) {
                    if (now - e.getValue()[0] > RESERVE_TTL_MS) dead.add(e.getKey());
                }
                for (String k : dead) pending.remove(k);
            }
        }

        void pendingCounts(int[] out) {   // out = {players, spectators}
            for (long[] v : pending.values()) {
                if (v[1] == 1) out[1]++; else out[0]++;
            }
        }

        Counts counts() {
            Counts c = new Counts();
            synchronized (lock) {
                int[] pc = new int[]{0, 0};
                pendingCounts(pc);
                c.players = players.size() + pc[0];
                c.spectators = spectators.size() + pc[1];
                c.livePlayers = players.size();
                c.liveSpectators = spectators.size();
                c.pending = pc[0] + pc[1];
                c.hasHost = host != null;
            }
            return c;
        }

        /** 准入判定 + 占位，同一把锁内完成（并发下不会超卖）。 */
        String reserve(String mtoken, String role, RoomMeta row) {
            synchronized (lock) {
                String verdict = joinAllowed(row, counts(), role);
                if (verdict == null) {
                    pending.put(mtoken, new long[]{System.currentTimeMillis(),
                            "spectator".equals(role) ? 1 : 0});
                }
                return verdict;   // null = 可以进；否则是给用户看的原因
            }
        }

        long[] consume(String mtoken) {
            synchronized (lock) { return pending.remove(mtoken); }
        }

        void add(Conn c) {
            synchronized (lock) {
                if ("kp".equals(c.role)) host = c;
                else if ("spectator".equals(c.role)) spectators.put(c.cid, c);
                else players.put(c.cid, c);
            }
        }

        void remove(Conn c) {
            synchronized (lock) {
                if (host == c) host = null;
                players.remove(c.cid);
                spectators.remove(c.cid);
            }
        }

        Conn find(String cid) {
            synchronized (lock) {
                Conn c = players.get(cid);
                return c != null ? c : spectators.get(cid);
            }
        }

        Conn findByToken(String mtoken) {
            if (mtoken == null || mtoken.isEmpty()) return null;
            synchronized (lock) {
                for (Conn c : players.values()) if (mtoken.equals(c.mtoken)) return c;
                for (Conn c : spectators.values()) if (mtoken.equals(c.mtoken)) return c;
            }
            return null;
        }

        /** v2.0.2：按座位找活连接（设备码通道下 mtoken 可能已换，但 seat 不变）。 */
        Conn findBySeat(String seat) {
            if (seat == null || seat.isEmpty() || "host".equals(seat)) return null;
            synchronized (lock) {
                for (Conn c : players.values()) if (seat.equals(c.seat())) return c;
                for (Conn c : spectators.values()) if (seat.equals(c.seat())) return c;
            }
            return null;
        }

        void toHost(String text) {
            Conn h = host;
            if (h != null) h.sendText(text);
        }

        List<Conn> audience() {
            synchronized (lock) {
                List<Conn> all = new ArrayList<Conn>(players.size() + spectators.size());
                all.addAll(players.values());
                all.addAll(spectators.values());
                return all;
            }
        }

        void closeAll() {
            List<Conn> all = audience();
            if (host != null) all.add(host);
            for (Conn c : all) c.kick(CLOSE_NORMAL, "房间已关闭");
        }
    }

    /** 一条已升级的 WebSocket 连接。 */
    final class Conn {
        final Socket sock;
        final String code, role, nickname, mtoken, ip;
        /** v2.0.2：本机设备标识（WS ?d=…）；空 = 老客户端/降级。 */
        final String deviceId;
        final String cid;
        final Object lock = new Object();
        volatile boolean closed = false;
        final CopyOnWriteArrayList<Long> msgTimes = new CopyOnWriteArrayList<Long>();

        Conn(Socket sock, String role, String code, String nickname, String mtoken, String ip) {
            this(sock, role, code, nickname, mtoken, ip, "");
        }

        Conn(Socket sock, String role, String code, String nickname, String mtoken, String ip,
             String deviceId) {
            this.sock = sock;
            this.code = code;
            this.role = role;
            this.nickname = nickname == null ? "" : nickname;
            this.mtoken = mtoken == null ? "" : mtoken;
            this.ip = ip == null ? "?" : ip;
            this.deviceId = deviceId == null ? "" : deviceId;
            this.cid = "c" + hex(5);
        }

        /**
         * 座位名：由 (房间, 凭据) 派生，重连恒定；KP 固定 "host"。
         * v2.0.2：basis 改为**设备优先** —— 有稳定设备码就用它（换机/重装/服务重启后仍恒定），
         * 没有则退回旧行为（用 mtoken 派生）。与公网版 room_server.py 完全一致。
         */
        String seat() {
            if ("kp".equals(role)) return "host";
            String basis = (deviceId != null && !deviceId.isEmpty()) ? deviceId : mtoken;
            return sha256Hex12(code + ":" + basis);
        }

        boolean sendText(String text) {
            if (closed) return false;
            try {
                /* 必须是 UTF-8 字节：发出去的是 JSON，里面有中文昵称与房间名，
                   用平台默认编码会在部分 ROM 上变成乱码（且只在真机上才看得见）。 */
                wsWrite(sock, text.getBytes(Charset.forName("UTF-8")), OP_TEXT, lock);
                return true;
            } catch (Exception e) {
                closed = true;
                return false;
            }
        }

        void sendClose(int codeNum, String reason) {
            if (closed) return;
            try {
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                bos.write((codeNum >> 8) & 0xFF);
                bos.write(codeNum & 0xFF);
                byte[] rt = (reason == null ? "" : reason).getBytes(Charset.forName("UTF-8"));
                bos.write(rt, 0, Math.min(rt.length, 120));
                wsWrite(sock, bos.toByteArray(), OP_CLOSE, lock);
            } catch (Exception ignored) { }
            closed = true;
        }

        void kick(int codeNum, String reason) {
            sendClose(codeNum, reason);
            try { sock.shutdownInput(); } catch (Exception ignored) { }
            try { sock.shutdownOutput(); } catch (Exception ignored) { }
        }

        void closeSocket() {
            try { sock.close(); } catch (Exception ignored) { }
        }

        boolean rateOk() {
            long now = System.currentTimeMillis();
            for (Long t : msgTimes) if (t < now - 60_000L) msgTimes.remove(t);
            if (msgTimes.size() >= 240) return false;
            msgTimes.add(now);
            return true;
        }
    }

    /* ============================================================
     * accept 循环
     * ============================================================ */

    private void acceptLoop() {
        while (running) {
            Socket s;
            try {
                s = tcp.accept();
            } catch (Exception e) {
                if (!running) break;
                continue;
            }
            try {
                s.setTcpNoDelay(true);
            } catch (Exception ignored) { }
            final Socket conn = s;
            Thread t = new Thread(new Runnable() {
                @Override public void run() {
                    try { handle(conn); }
                    catch (Exception e) { Log.w(TAG, "conn: " + e.getMessage()); }
                    finally { try { conn.close(); } catch (Exception ignored) { } }
                }
            }, "cocroom-conn");
            t.setDaemon(true);
            t.start();
        }
    }

    /* ============================================================
     * HTTP + WS 处理（单文件内手写，与公网版同构）
     * ============================================================ */

    private void handle(Socket sock) throws IOException {
        BufferedInputStream in = new BufferedInputStream(sock.getInputStream());
        OutputStream rawOut = new BufferedOutputStream(sock.getOutputStream());

        String requestLine = readLine(in);
        if (requestLine == null) return;
        String[] parts = requestLine.split(" ");
        if (parts.length < 2) return;
        String method = parts[0];
        String path = parts[1];
        int q = path.indexOf('?');
        String query = q >= 0 ? path.substring(q + 1) : "";
        String route = q >= 0 ? path.substring(0, q) : path;

        // 读请求头（大小写不敏感）
        Map<String, String> headers = new HashMap<String, String>();
        String line;
        int guard = 0;
        while ((line = readLine(in)) != null && line.length() > 0 && guard++ < 200) {
            int c = line.indexOf(':');
            if (c > 0) {
                headers.put(line.substring(0, c).trim().toLowerCase(),
                        line.substring(c + 1).trim());
            }
        }

        if ("OPTIONS".equals(method)) { sendJson(rawOut, 204, "{}"); return; }

        if ("/ws".equals(route)) { doWs(sock, in, rawOut, query, headers); return; }

        if ("GET".equals(method)) {
            if ("/health".equals(route)) {
                int n;
                synchronized (registryLock) { n = rooms.size(); }
                JSONObject o = new JSONObject();
                try {
                    o.put("ok", true);
                    o.put("service", "coc-room-lan");
                    o.put("time", System.currentTimeMillis() / 1000L);
                    o.put("liveRooms", n);
                } catch (Exception ignored) { }
                sendJson(rawOut, 200, o.toString());
                return;
            }
            if ("/api/rooms".equals(route)) { apiList(rawOut); return; }
            java.util.regex.Matcher gm = java.util.regex.Pattern
                    .compile("^/api/rooms/([a-z0-9]{4,12})/state$").matcher(route);
            if (gm.find()) { apiGetState(rawOut, gm.group(1), query); return; }
            // v2.0.2：可命名存档槽 —— 列表 / 读取
            gm = java.util.regex.Pattern.compile("^/api/rooms/([a-z0-9]{4,12})/saves$").matcher(route);
            if (gm.find()) { apiSaveList(rawOut, gm.group(1), query); return; }
            gm = java.util.regex.Pattern
                    .compile("^/api/rooms/([a-z0-9]{4,12})/saves/([A-Za-z0-9_-]{4,40})$").matcher(route);
            if (gm.find()) { apiSaveGet(rawOut, gm.group(1), gm.group(2), query); return; }
            sendJson(rawOut, 200, "{\"ok\":true,\"service\":\"coc-room-lan\"}");
            return;
        }

        if ("DELETE".equals(method)) {
            // v2.0.2：删除可命名存档槽（需 hostToken）
            String dbody = readBody(in, headers, MAX_HTTP_BODY);
            if (dbody == null) { sendJson(rawOut, 413, "{\"error\":\"请求体过大\"}"); return; }
            java.util.regex.Matcher dm = java.util.regex.Pattern
                    .compile("^/api/rooms/([a-z0-9]{4,12})/saves/([A-Za-z0-9_-]{4,40})$")
                    .matcher(route);
            if (dm.find()) { apiSaveDelete(rawOut, dm.group(1), dm.group(2), dbody); return; }
            sendJson(rawOut, 404, "{\"error\":\"not found\"}");
            return;
        }

        if ("POST".equals(method)) {
            // 存档端点的请求体远大于房间元数据，故按路由选择不同的请求体上限。
            boolean stateRoute = java.util.regex.Pattern
                    .compile("^/api/rooms/[a-z0-9]{4,12}/state$").matcher(route).find();
            String body = readBody(in, headers, stateRoute ? MAX_STATE_BODY : MAX_HTTP_BODY);
            if (body == null) {
                if (stateRoute) sendJson(rawOut, 413, "{\"ok\":false,\"error\":\"too_large\"}");
                else sendJson(rawOut, 413, "{\"error\":\"请求体过大或不是合法 JSON\"}");
                return;
            }
            if ("/api/rooms".equals(route)) { apiCreate(rawOut, body); return; }
            java.util.regex.Matcher m;
            m = java.util.regex.Pattern.compile("^/api/rooms/([a-z0-9]{4,12})/probe$").matcher(route);
            if (m.find()) { apiProbe(rawOut, m.group(1), body); return; }
            m = java.util.regex.Pattern.compile("^/api/rooms/([a-z0-9]{4,12})/join$").matcher(route);
            if (m.find()) { apiJoin(rawOut, m.group(1), body); return; }
            m = java.util.regex.Pattern.compile("^/api/rooms/([a-z0-9]{4,12})/close$").matcher(route);
            if (m.find()) { apiClose(rawOut, m.group(1), body); return; }
            m = java.util.regex.Pattern.compile("^/api/rooms/([a-z0-9]{4,12})/state$").matcher(route);
            if (m.find()) { apiPutState(rawOut, m.group(1), body); return; }
            m = java.util.regex.Pattern.compile("^/api/rooms/([a-z0-9]{4,12})/suspend$").matcher(route);
            if (m.find()) { apiSuspend(rawOut, m.group(1), body); return; }
            m = java.util.regex.Pattern.compile("^/api/rooms/([a-z0-9]{4,12})/resume$").matcher(route);
            if (m.find()) { apiResume(rawOut, m.group(1), body); return; }
            // v2.0.2 新增：解绑本机设备身份 / 可命名存档槽（建、载入）
            m = java.util.regex.Pattern.compile("^/api/rooms/([a-z0-9]{4,12})/unbind$").matcher(route);
            if (m.find()) { apiUnbind(rawOut, m.group(1), body); return; }
            m = java.util.regex.Pattern.compile("^/api/rooms/([a-z0-9]{4,12})/saves$").matcher(route);
            if (m.find()) { apiSaveCreate(rawOut, m.group(1), body); return; }
            m = java.util.regex.Pattern
                    .compile("^/api/rooms/([a-z0-9]{4,12})/saves/([A-Za-z0-9_-]{4,40})/load$").matcher(route);
            if (m.find()) { apiSaveLoad(rawOut, m.group(1), m.group(2), body); return; }
            sendJson(rawOut, 404, "{\"error\":\"not found\"}");
            return;
        }

        sendJson(rawOut, 404, "{\"error\":\"not found\"}");
    }

    /* ---------- 房间目录 ---------- */

    private void apiList(OutputStream out) {
        try {
            List<JSONObject> arr = new ArrayList<JSONObject>();
            synchronized (registryLock) {
                for (RoomMeta m : metaIndex.values()) {
                    // CLOSED 与 SUSPENDED 都不进目录（挂起的房间不出现在列表，但行不被清理）
                    if ("CLOSED".equals(m.status) || "SUSPENDED".equals(m.status)) continue;
                    Room live = rooms.get(m.code);
                    Counts c = live != null ? live.counts() : new Counts();
                    JSONObject o = metaJson(m);
                    o.put("players", c.players);
                    o.put("spectators", c.spectators);
                    o.put("online", c.hasHost);
                    arr.add(o);
                }
            }
            JSONObject res = new JSONObject();
            res.put("ok", true);
            res.put("rooms", new org.json.JSONArray(arr.toString()));
            res.put("serverTime", System.currentTimeMillis() / 1000L);
            sendJson(out, 200, res.toString());
        } catch (Exception e) {
            sendJson(out, 500, "{\"error\":\"目录暂时不可用\"}");
        }
    }

    /** 对外可见的房间元信息。**绝不包含 pwdSalt / pwdHash / hostToken**。 */
    private JSONObject metaJson(RoomMeta m) throws Exception {
        JSONObject o = new JSONObject();
        o.put("code", m.code);
        o.put("name", m.name);
        o.put("rules", m.rules);
        o.put("kpName", m.kpName);
        o.put("needPwd", m.needPwd);
        o.put("maxPlayers", m.maxPlayers);
        o.put("allowSpectate", m.allowSpec);
        o.put("status", m.status);
        o.put("createdAt", m.createdAt);
        o.put("lastSeen", m.lastSeen);
        return o;
    }

    private void apiCreate(OutputStream out, String body) {
        JSONObject req;
        try { req = new JSONObject(body); } catch (Exception e) { req = new JSONObject(); }

        String name = cleanText(opt(req, "name"), 40);
        if (name.isEmpty()) { sendJson(out, 400, "{\"error\":\"房间名不能为空\"}"); return; }
        String kp = cleanText(opt(req, "kpName"), 24);
        if (kp.isEmpty()) { sendJson(out, 400, "{\"error\":\"KP 昵称不能为空\"}"); return; }
        String rules = opt(req, "rules");
        if (rules == null || rules.isEmpty()) rules = "coc7";
        if (!"coc7".equals(rules)) { sendJson(out, 400, "{\"error\":\"本期只支持 COC 第七版\"}"); return; }

        int maxPlayers = 4;
        try {
            String mp = opt(req, "maxPlayers");
            if (mp != null && !mp.isEmpty()) maxPlayers = Integer.parseInt(mp.trim());
        } catch (Exception e) { sendJson(out, 400, "{\"error\":\"玩家上限必须是数字\"}"); return; }
        maxPlayers = Math.max(1, Math.min(MAX_PLAYERS_HARD, maxPlayers));

        boolean allowSpec = !"false".equalsIgnoreCase(String.valueOf(opt(req, "allowSpectate")));
        String password = opt(req, "password");
        if (password == null) password = "";

        RoomMeta m = new RoomMeta();
        m.name = name; m.rules = rules; m.kpName = kp;
        m.maxPlayers = maxPlayers; m.allowSpec = allowSpec;
        m.needPwd = !password.isEmpty();
        if (m.needPwd) {
            m.pwdSalt = hex(8);
            m.pwdHash = pbkdf2(password, m.pwdSalt);
        }
        m.hostToken = urlSafe(24);
        m.createdAt = System.currentTimeMillis() / 1000L;
        m.lastSeen = m.createdAt;

        /* ⚠️ 锁内只做「判定 + 登记」，写 socket 一律挪到锁外。
           在全局锁里写网络会阻塞所有房间：一个慢客户端就能卡住全部建房。 */
        String fail = null;
        synchronized (registryLock) {
            if (rooms.size() >= MAX_ROOMS) {
                fail = "{\"error\":\"本机同时开的房间数已达上限\"}";
            } else {
                for (int i = 0; i < 10; i++) {
                    String code = newCode();
                    if (!metaIndex.containsKey(code)) { m.code = code; break; }
                    m.code = null;
                }
                if (m.code == null) {
                    fail = "{\"error\":\"生成房间号失败，请重试\"}";
                } else {
                    metaIndex.put(m.code, m);
                    rooms.put(m.code, new Room(m.code));
                }
            }
        }
        if (fail != null) {
            sendJson(out, fail.contains("上限") ? 507 : 500, fail);
            return;
        }

        persistMeta(m);   // 落盘（锁外做 I/O，别在全局锁里写磁盘）

        try {
            JSONObject res = new JSONObject();
            res.put("ok", true);
            res.put("code", m.code);
            res.put("hostToken", m.hostToken);
            res.put("wsBase", wsBase());
            res.put("meta", metaJson(m));
            sendJson(out, 200, res.toString());
        } catch (Exception e) {
            sendJson(out, 500, "{\"error\":\"建房失败\"}");
        }
    }

    private void apiProbe(OutputStream out, String code, String body) {
        JSONObject req;
        try { req = new JSONObject(body); } catch (Exception e) { req = new JSONObject(); }
        String role = opt(req, "role");
        if (role == null || role.isEmpty()) role = "player";
        // v2.1.1：预检也带机器码 → 客户端在点「加入」之前就知道是「正在重连…」还是「加入中…」。
        String probeDev = cleanText(opt(req, "deviceId"), 80);

        RoomMeta m = metaOf(code);
        if (m == null) { sendJson(out, 404, "{\"ok\":false,\"reason\":\"ROOM_NOT_FOUND\",\"message\":\"房间不存在或已过期\"}"); return; }
        Room live = roomOf(code);
        if (live != null) live.expirePending();
        Counts c = live != null ? live.counts() : new Counts();

        String verdict = joinAllowed(m, c, role);
        String[] pbind = (probeDev == null || probeDev.isEmpty()) ? null : getDeviceSeat(code, probeDev);
        // v2.1.1：本机是本房老玩家（机器码命中）→ 回座**不受名额限制**，与 apiJoin 的
        // 绑定分支口径一致；否则列表会给老玩家假「已满」而进不去。
        if (pbind != null && "player".equals(role) && verdict != null
                && !"CLOSED".equals(m.status) && c.players >= m.maxPlayers) {
            verdict = null;
        }
        try {
            JSONObject o = metaJson(m);
            o.put("ok", verdict == null);
            o.put("reason", verdict == null ? "" : reasonCode(verdict));
            o.put("message", verdict == null ? "" : verdict);
            o.put("joinKind", joinKindOf(pbind));
            o.put("players", c.players);
            o.put("spectators", c.spectators);
            o.put("online", c.hasHost);
            sendJson(out, 200, o.toString());
        } catch (Exception e) {
            sendJson(out, 500, "{\"error\":\"预检失败\"}");
        }
    }

    private void apiJoin(OutputStream out, String code, String body) {
        JSONObject req;
        try { req = new JSONObject(body); } catch (Exception e) { req = new JSONObject(); }

        String role = opt(req, "role");
        if (role == null || role.isEmpty()) role = "player";
        String nickname = cleanText(opt(req, "nickname"), 24);
        if (nickname.isEmpty()) { sendJson(out, 400, "{\"error\":\"昵称不能为空\"}"); return; }
        // v2.0.2：设备标识（断线重连的持久凭据）
        String deviceId = cleanText(opt(req, "deviceId"), 80);

        RoomMeta m = metaOf(code);
        if (m == null) { sendJson(out, 404, "{\"ok\":false,\"reason\":\"ROOM_NOT_FOUND\",\"message\":\"房间不存在或已过期\"}"); return; }

        // 挂起的房间只有房主 resume 之后才能加入（与公网版同名同码 room_suspended）
        if ("SUSPENDED".equals(m.status)) {
            sendJson(out, 403, "{\"ok\":false,\"error\":\"room_suspended\"}");
            return;
        }

        Room room = ensureRoom(code);
        room.expirePending();
        String mtoken = urlSafe(18);
        String seat = sha256Hex12(code + ":" + (deviceId.isEmpty() ? mtoken : deviceId));

        // 密码校验必须在服务端做：房间号只定位房间，不等于身份验证。
        if (m.needPwd) {
            String given = opt(req, "password");
            if (!verifyPwd(given == null ? "" : given, m.pwdSalt, m.pwdHash)) {
                sendJson(out, 403, "{\"ok\":false,\"reason\":\"BAD_PASSWORD\",\"message\":\"房间密码不正确\"}");
                return;
            }
        }

        // v2.0.2：先看设备绑定 —— 命中即「真重连」（复用 role，不再占新名额）
        String[] binding = deviceId.isEmpty() ? null : getDeviceSeat(code, deviceId);
        if (binding != null) {
            if (binding[1] != null && !binding[1].isEmpty()) role = binding[1];
            if (nickname.isEmpty()) nickname = binding[2] == null ? "" : binding[2];
            upsertDeviceSeat(code, deviceId, binding[0], role, nickname);
        } else {
            String verdict = room.reserve(mtoken, role, m);
            if (verdict != null) {
                try {
                    JSONObject o = new JSONObject();
                    o.put("ok", false);
                    o.put("reason", reasonCode(verdict));
                    o.put("message", verdict);
                    sendJson(out, 403, o.toString());
                } catch (Exception ignored) { sendJson(out, 403, "{\"ok\":false}"); }
                return;
            }
            if (!deviceId.isEmpty()) upsertDeviceSeat(code, deviceId, seat, role, nickname);
        }

        Member mem = new Member();
        mem.role = role; mem.nickname = nickname; mem.code = code;
        synchronized (registryLock) {
            members.put(code + "|" + mtoken, mem);
            if (members.size() > 2000) {   // 手机端上限小得多
                for (String k : new ArrayList<String>(members.keySet())) {
                    Member mm = members.get(k);
                    if (mm != null && metaIndex.get(mm.code) == null) members.remove(k);
                }
            }
        }

        try {
            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("code", code);         // 客户端要用它拼 #/room/<code>，漏了就变成 undefined
            o.put("mtoken", mtoken);
            o.put("role", role);
            o.put("seat", seat);
            // v2.1.1（用户要求）：机器码判定 → 'reconnect' | 'new'（只影响界面提示/落座）。
            o.put("joinKind", joinKindOf(binding));
            // v2.0.2：join 请求体已带 deviceId → 透传进 wsUrl（&d=<deviceId>）。
            // 这是协议里最后一个裸 t= 字段，补上以防将来有调用方直接信任它。
            String wsUrl = wsBase() + "/ws?code=" + code + "&t=" + mtoken;
            if (deviceId != null && !deviceId.isEmpty()) {
                wsUrl += "&d=" + java.net.URLEncoder.encode(deviceId, "UTF-8");
            }
            o.put("wsUrl", wsUrl);
            o.put("meta", metaJson(m));
            Counts c = room.counts();
            JSONObject cc = new JSONObject();
            cc.put("players", c.players);
            cc.put("spectators", c.spectators);
            o.put("counts", cc);
            sendJson(out, 200, o.toString());
        } catch (Exception e) {
            sendJson(out, 500, "{\"error\":\"加入失败\"}");
        }
    }

    private void apiClose(OutputStream out, String code, String body) {
        JSONObject req;
        try { req = new JSONObject(body); } catch (Exception e) { req = new JSONObject(); }
        RoomMeta m = metaOf(code);
        if (m == null) { sendJson(out, 404, "{\"error\":\"房间不存在\"}"); return; }
        String tok = opt(req, "hostToken");
        if (tok == null || !constantTimeEq(m.hostToken, tok)) {
            sendJson(out, 403, "{\"error\":\"只有房主可以关闭房间\"}");
            return;
        }
        m.status = "CLOSED";
        m.lastSeen = System.currentTimeMillis() / 1000L;
        Room r = roomOf(code);
        if (r != null) r.closeAll();
        removeMetaFile(code);   // 关房 = 终止：元数据文件同步清理
        removeAuxFiles(code);   // 设备绑定与命名存档一并清理（与公网版孤儿清理对齐）
        sendJson(out, 200, "{\"ok\":true,\"code\":\"" + code + "\"}");
    }

    /* ---------- 游戏存档 / 挂起 / 续玩（v2.0.0）----------
     * 存档（payload）是不透明字符串，**中继绝不解析其内容** —— 与 room_server.py 同一条约定。
     * 落盘到 <stateDir>/rooms/<code>.state.json，含 seq / updatedAt / payload。
     */

    private static final class StateRec {
        long seq;
        long savedAt;
        String payload;
    }

    private static final class SaveResult {
        long seq;
        long savedAt;
        boolean stale;
    }

    /**
     * 落盘目录：<stateDir>/rooms（无 stateDir 时退化为 java.io.tmpdir/cocroom/rooms）。
     * 房间元数据（<code>.meta.json）与游戏存档（<code>.state.json）都放在这里。
     */
    private File roomsDir() {
        File root = stateDir;
        if (root == null) {
            // 兜底：安卓上 java.io.tmpdir 就是 App 私有 cache 目录，进程重启后仍可读
            //（但可能被系统在存储紧张时清理）。理想路径是 MainActivity 注入 getFilesDir()。
            String tmp = System.getProperty("java.io.tmpdir");
            if (tmp == null || tmp.isEmpty()) return null;
            root = new File(tmp, "cocroom");
        }
        File rooms = new File(root, "rooms");
        if (!rooms.exists()) rooms.mkdirs();
        return rooms;
    }

    /** 存档文件路径：<stateDir>/rooms/<code>.state.json；无可用目录时返回 null。 */
    private File stateFile(String code) {
        File dir = roomsDir();
        return dir == null ? null : new File(dir, code + ".state.json");
    }

    /** 房间元数据文件路径：<stateDir>/rooms/<code>.meta.json；无可用目录时返回 null。 */
    private File metaFile(String code) {
        File dir = roomsDir();
        return dir == null ? null : new File(dir, code + ".meta.json");
    }

    /**
     * 原子写：先写 <file>.tmp，fsync 后再 rename 到目标。写一半崩溃不会留下坏文件。
     * 存档与房间元数据共用这一份实现。
     */
    private boolean atomicWrite(File target, byte[] data) {
        if (target == null) return false;
        try {
            File dir = target.getParentFile();
            if (dir != null && !dir.exists()) dir.mkdirs();
            File tmp = new File(target.getAbsolutePath() + ".tmp");
            FileOutputStream fos = new FileOutputStream(tmp);
            try {
                fos.write(data);
                fos.flush();
                fos.getFD().sync();
            } finally {
                fos.close();
            }
            // 同目录内 rename 是原子的；个别实现不能覆盖已存在文件，故失败时删后重试
            if (!tmp.renameTo(target)) {
                if (target.exists()) target.delete();
                if (!tmp.renameTo(target)) return false;
            }
            return true;
        } catch (Exception e) {
            Log.w(TAG, "atomic write failed: " + e.getMessage());
            return false;
        }
    }

    /**
     * 把房间元数据落盘（供进程重启后恢复「改天续玩」）。
     * ⚠️ 含 hostToken / pwdSalt / pwdHash（本来就在内存里），但**绝不**写进 payload。
     */
    private void persistMeta(RoomMeta m) {
        if (m == null) return;
        File f = metaFile(m.code);
        if (f == null) return;
        try {
            JSONObject o = new JSONObject();
            o.put("code", m.code);
            o.put("name", m.name);
            o.put("rules", m.rules);
            o.put("kpName", m.kpName);
            o.put("needPwd", m.needPwd);
            o.put("pwdSalt", m.pwdSalt);
            o.put("pwdHash", m.pwdHash);
            o.put("maxPlayers", m.maxPlayers);
            o.put("allowSpec", m.allowSpec);
            o.put("status", m.status);
            o.put("hostToken", m.hostToken);
            o.put("createdAt", m.createdAt);
            o.put("lastSeen", m.lastSeen);
            atomicWrite(f, o.toString().getBytes(Charset.forName("UTF-8")));
        } catch (Exception e) {
            Log.w(TAG, "meta write failed code=" + m.code + ": " + e.getMessage());
        }
    }

    /** 删除房间元数据文件（close / 清理坏文件时用）。 */
    private void removeMetaFile(String code) {
        File f = metaFile(code);
        if (f != null && f.exists()) {
            try { f.delete(); } catch (Exception ignored) { }
        }
    }

    /**
     * v2.0.2：清理房间的附属文件与内存态（设备绑定 <code>.seats.json、命名存档
     * <code>.saves.json）。关房 = 终止，与公网版「房间行被清理时孤儿存档一并删除」对齐。
     */
    private void removeAuxFiles(String code) {
        try {
            File sf = seatsFile(code);
            if (sf != null && sf.exists()) sf.delete();
            File vf = savesFile(code);
            if (vf != null && vf.exists()) vf.delete();
        } catch (Exception ignored) { }
        String prefix = code + "|";
        for (String k : new ArrayList<String>(deviceSeats.keySet())) {
            if (k.startsWith(prefix)) deviceSeats.remove(k);
        }
        synchronized (registryLock) { seatsLoaded.remove(code); }
    }

    /** 读一个元数据文件；坏文件返回 null（调用方决定删除）。 */
    private RoomMeta readMetaFile(File f, String code) {
        try {
            String txt = readFileText(f);
            if (txt == null || txt.isEmpty()) return null;
            JSONObject o = new JSONObject(txt);
            RoomMeta m = new RoomMeta();
            m.code = code;
            m.name = o.optString("name", "");
            m.rules = o.optString("rules", "coc7");
            m.kpName = o.optString("kpName", "");
            m.needPwd = o.optBoolean("needPwd", false);
            m.pwdSalt = o.optString("pwdSalt", "");
            m.pwdHash = o.optString("pwdHash", "");
            m.maxPlayers = o.optInt("maxPlayers", 4);
            m.allowSpec = o.optBoolean("allowSpec", true);
            m.status = o.optString("status", "RECRUITING");
            m.hostToken = o.optString("hostToken", "");
            m.createdAt = o.optLong("createdAt", 0L);
            m.lastSeen = o.optLong("lastSeen", m.createdAt);
            // 续玩必需字段缺失 → 视为坏文件（不能恢复一个没有房主凭据的房间）
            if (m.name.isEmpty() || m.hostToken == null || m.hostToken.isEmpty()) return null;
            return m;
        } catch (Exception e) {
            Log.w(TAG, "meta read failed code=" + code + ": " + e.getMessage());
            return null;
        }
    }

    /**
     * 启动时把落盘的房间元数据读回内存。
     *   · 恢复 SUSPENDED / RECRUITING / **IN_GAME** 的房间
     *     —— v2.1.1（用户第三轮反馈「KP 掉线重连」）：进行中的团在**房主进程重启后
     *     也必须回来**，否则玩家重连时房间已不存在 → 屏幕上假「连接已断开」，还会被
     *     引到别的房。恢复后玩家凭机器码回到**同一个房间号**原座，不再是新房间。
     *   · CLOSED 的直接丢弃并删文件
     *   · 坏文件当不存在并删掉（避免每次启动都报）
     *   · 恢复房带 restored 标记 → 不参与 UDP 发现（只让「本轮新建的房」被发现）
     */
    private void loadPersistedMeta() {
        File dir = roomsDir();
        if (dir == null || !dir.exists()) return;
        File[] files = dir.listFiles();
        if (files == null) return;
        int restored = 0;
        for (File f : files) {
            String nm = f.getName();
            if (!nm.endsWith(".meta.json")) continue;
            String code = nm.substring(0, nm.length() - ".meta.json".length());
            if (!code.matches("[a-z0-9]{4,12}")) continue;
            RoomMeta m = readMetaFile(f, code);
            if (m == null) {                       // 坏文件 → 丢弃
                try { f.delete(); } catch (Exception ignored) { }
                continue;
            }
            if ("CLOSED".equals(m.status)) {        // 已关闭 → 丢弃并删文件
                try { f.delete(); } catch (Exception ignored) { }
                continue;
            }
            if (!("SUSPENDED".equals(m.status) || "RECRUITING".equals(m.status)
                    || "IN_GAME".equals(m.status))) {
                continue;                           // 其它未知状态：不恢复、保留文件
            }
            synchronized (registryLock) {
                if (metaIndex.size() >= MAX_ROOMS) break;
                /* v2.1.0 缺陷3：标记为「恢复房」——UDP 发现应答会优先推本轮新建的房，
                   不让这些历史遗留房抢答，避免玩家搜索到旧房间（房间号对不上）。 */
                m.restored = true;
                metaIndex.put(code, m);
                if (!rooms.containsKey(code)) rooms.put(code, new Room(code));
            }
            restored++;
        }
        if (restored > 0) Log.d(TAG, "restored " + restored + " persisted room(s)");
    }

    private StateRec loadState(String code) {
        synchronized (stateLock) {
            return loadStateUnlocked(code);
        }
    }

    private StateRec loadStateUnlocked(String code) {
        File f = stateFile(code);
        if (f == null || !f.exists()) return null;
        try {
            String txt = readFileText(f);
            if (txt == null || txt.isEmpty()) return null;
            JSONObject o = new JSONObject(txt);
            StateRec r = new StateRec();
            r.seq = o.optLong("seq", -1L);
            r.savedAt = o.optLong("updatedAt", 0L);
            r.payload = o.optString("payload", "");
            return r;
        } catch (Exception e) {
            // 文件损坏（写一半崩溃等）→ 容错为「无存档」，不要让读端崩
            Log.w(TAG, "state read failed code=" + code + ": " + e.getMessage());
            return null;
        }
    }

    /** 幂等写入：仅当 seq 大于已存 seq 时覆盖。返回实际存储值与是否 stale。 */
    private SaveResult putState(String code, long seq, String payload) {
        SaveResult res = new SaveResult();
        synchronized (stateLock) {
            StateRec cur = loadStateUnlocked(code);
            if (cur != null && seq <= cur.seq) {
                res.seq = cur.seq;
                res.savedAt = cur.savedAt;
                res.stale = true;
                return res;
            }
            long now = System.currentTimeMillis() / 1000L;
            writeStateFile(stateFile(code), seq, payload, now);
            res.seq = seq;
            res.savedAt = now;
            res.stale = false;
            return res;
        }
    }

    /** 原子写存档文件（复用 atomicWrite）。 */
    private boolean writeStateFile(File target, long seq, String payload, long updatedAt) {
        if (target == null) return false;
        try {
            JSONObject o = new JSONObject();
            o.put("seq", seq);
            o.put("updatedAt", updatedAt);
            o.put("payload", payload == null ? "" : payload);
            return atomicWrite(target, o.toString().getBytes(Charset.forName("UTF-8")));
        } catch (Exception e) {
            Log.w(TAG, "state write failed code=" + target.getName() + ": " + e.getMessage());
            return false;
        }
    }

    private static String readFileText(File f) throws IOException {
        long len = f.length();
        if (len <= 0 || len > (long) MAX_STATE_BODY + 1024L) return null;
        FileInputStream in = new FileInputStream(f);
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int r;
            while ((r = in.read(buf)) > 0) bos.write(buf, 0, r);
            return new String(bos.toByteArray(), Charset.forName("UTF-8"));
        } finally {
            in.close();
        }
    }

    /* ============================================================
     * v2.0.2：设备 ↔ 座位绑定（与公网版 device_seats 同构，落盘 <code>.seats.json）
     * ============================================================ */

    private File seatsFile(String code) {
        File dir = roomsDir();
        return dir == null ? null : new File(dir, code + ".seats.json");
    }

    /** 惰性载入某房间的设备绑定（App 重启后从盘上恢复）。 */
    private void ensureSeatsLoaded(String code) {
        synchronized (registryLock) {
            if (seatsLoaded.contains(code)) return;
            seatsLoaded.add(code);
        }
        File f = seatsFile(code);
        if (f == null || !f.exists()) return;
        try {
            String txt = readFileText(f);
            if (txt == null || txt.isEmpty()) return;
            JSONObject o = new JSONObject(txt);
            java.util.Iterator<String> it = o.keys();
            while (it.hasNext()) {
                String dev = it.next();
                org.json.JSONArray arr = o.optJSONArray(dev);
                if (arr == null || arr.length() < 2) continue;
                deviceSeats.put(code + "|" + dev, new String[]{
                        arr.optString(0, ""), arr.optString(1, "player"), arr.optString(2, "")});
            }
        } catch (Exception e) {
            Log.w(TAG, "seats read failed code=" + code + ": " + e.getMessage());
        }
    }

    /** 把某房间的全部设备绑定落盘。 */
    private void persistSeats(String code) {
        File f = seatsFile(code);
        if (f == null) return;
        try {
            JSONObject o = new JSONObject();
            String prefix = code + "|";
            for (Map.Entry<String, String[]> e : deviceSeats.entrySet()) {
                if (!e.getKey().startsWith(prefix)) continue;
                String dev = e.getKey().substring(prefix.length());
                String[] v = e.getValue();
                org.json.JSONArray arr = new org.json.JSONArray();
                arr.put(v[0] == null ? "" : v[0]);
                arr.put(v[1] == null ? "player" : v[1]);
                arr.put(v[2] == null ? "" : v[2]);
                o.put(dev, arr);
            }
            atomicWrite(f, o.toString().getBytes(Charset.forName("UTF-8")));
        } catch (Exception e) {
            Log.w(TAG, "seats write failed code=" + code + ": " + e.getMessage());
        }
    }

    /** 查绑定：返回 [seat, role, nickname] 或 null。 */
    private String[] getDeviceSeat(String code, String deviceId) {
        if (code == null || deviceId == null || deviceId.isEmpty()) return null;
        ensureSeatsLoaded(code);
        return deviceSeats.get(code + "|" + deviceId);
    }

    private void upsertDeviceSeat(String code, String deviceId, String seat, String role,
                                  String nickname) {
        if (code == null || deviceId == null || deviceId.isEmpty()) return;
        ensureSeatsLoaded(code);
        deviceSeats.put(code + "|" + deviceId, new String[]{
                seat == null ? "" : seat, role == null ? "player" : role,
                nickname == null ? "" : nickname});
        persistSeats(code);
    }

    private void deleteDeviceSeat(String code, String deviceId) {
        if (code == null || deviceId == null || deviceId.isEmpty()) return;
        ensureSeatsLoaded(code);
        deviceSeats.remove(code + "|" + deviceId);
        persistSeats(code);
    }

    /* ============================================================
     * v2.0.2：可命名存档槽（game_saves）—— 落盘 <code>.saves.json
     * ============================================================ */

    private File savesFile(String code) {
        File dir = roomsDir();
        return dir == null ? null : new File(dir, code + ".saves.json");
    }

    /** 读某房间的全部存档槽（JSON 数组，按 updatedAt 倒序）。坏文件 → 空表。 */
    private org.json.JSONArray loadSaves(String code) {
        File f = savesFile(code);
        if (f == null || !f.exists()) return new org.json.JSONArray();
        try {
            String txt = readFileText(f);
            if (txt == null || txt.isEmpty()) return new org.json.JSONArray();
            return new org.json.JSONArray(txt);
        } catch (Exception e) {
            Log.w(TAG, "saves read failed code=" + code + ": " + e.getMessage());
            return new org.json.JSONArray();
        }
    }

    private boolean writeSaves(String code, org.json.JSONArray arr) {
        File f = savesFile(code);
        if (f == null) return false;
        return atomicWrite(f, arr.toString().getBytes(Charset.forName("UTF-8")));
    }

    private static JSONObject findSave(org.json.JSONArray arr, String saveId) {
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o != null && saveId.equals(o.optString("saveId", ""))) return o;
        }
        return null;
    }

    private static void sortSavesDesc(org.json.JSONArray arr) {
        List<JSONObject> tmp = new ArrayList<JSONObject>();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o != null) tmp.add(o);
        }
        Collections.sort(tmp, new java.util.Comparator<JSONObject>() {
            @Override public int compare(JSONObject a, JSONObject b) {
                long x = a.optLong("updatedAt", 0L), y = b.optLong("updatedAt", 0L);
                return x == y ? 0 : (x < y ? 1 : -1);      // 倒序
            }
        });
        while (arr.length() > 0) arr.remove(arr.length() - 1);
        for (JSONObject o : tmp) arr.put(o);
    }

    /** 写入存档。需 hostToken；payload 不透明、不解析；seq 单调递增才覆盖。 */
    private void apiPutState(OutputStream out, String code, String body) {
        RoomMeta m = metaOf(code);
        if (m == null) { sendJson(out, 404, "{\"ok\":false,\"error\":\"not_found\"}"); return; }
        JSONObject req;
        try { req = new JSONObject(body); } catch (Exception e) { req = new JSONObject(); }
        String tok = opt(req, "hostToken");
        if (tok == null || !constantTimeEq(m.hostToken, tok)) {
            sendJson(out, 403, "{\"ok\":false,\"error\":\"bad_token\"}");
            return;
        }
        long seq;
        try { seq = Long.parseLong(opt(req, "seq")); }
        catch (Exception e) { sendJson(out, 400, "{\"ok\":false,\"error\":\"bad_request\"}"); return; }
        String payload = opt(req, "payload");
        if (payload == null) payload = "";
        // 上限按 payload 的 UTF-8 字节数计（中文存档按字节算才准）
        if (payload.getBytes(Charset.forName("UTF-8")).length > MAX_STATE_BYTES) {
            sendJson(out, 413, "{\"ok\":false,\"error\":\"too_large\"}");
            return;
        }
        SaveResult r = putState(code, seq, payload);
        m.lastSeen = System.currentTimeMillis() / 1000L;
        try {
            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("seq", r.seq);
            o.put("savedAt", r.savedAt);
            if (r.stale) o.put("stale", true);
            sendJson(out, 200, o.toString());
        } catch (Exception e) {
            sendJson(out, 500, "{\"error\":\"存档失败\"}");
        }
    }

    /** 读取存档。token 需是房主 hostToken、任一有效成员 mtoken，或本机 deviceId 命中绑定。 */
    private void apiGetState(OutputStream out, String code, String query) {
        RoomMeta m = metaOf(code);
        if (m == null) { sendJson(out, 404, "{\"ok\":false,\"error\":\"not_found\"}"); return; }
        Map<String, String> q = parseQuery(query);
        String token = q.get("token");
        String dev = cleanText(q.get("d"), 80);
        // ⚠️ hostToken 始终可用；成员 token 只在内存里，进程重启后会失效 → bad_token
        boolean okTok = token != null && !token.isEmpty() && constantTimeEq(m.hostToken, token);
        if (!okTok) {
            Member mem;
            synchronized (registryLock) {
                mem = members.get(code + "|" + (token == null ? "" : token));
            }
            okTok = mem != null;
        }
        // v2.0.2：与公网版 _api_get_state 的「设备码通道」对齐 —— token 失效（如本机
        // 服务进程重启）时，d 命中本房绑定即放行；否则重启后玩家拉不回存档。
        if (!okTok && !dev.isEmpty()) okTok = getDeviceSeat(code, dev) != null;
        if (!okTok) { sendJson(out, 403, "{\"ok\":false,\"error\":\"bad_token\"}"); return; }
        StateRec r = loadState(code);
        if (r == null) { sendJson(out, 404, "{\"ok\":false,\"error\":\"no_state\"}"); return; }
        try {
            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("seq", r.seq);
            o.put("payload", r.payload);
            o.put("savedAt", r.savedAt);
            sendJson(out, 200, o.toString());
        } catch (Exception e) {
            sendJson(out, 500, "{\"error\":\"读取存档失败\"}");
        }
    }

    /** 挂起房间：状态置 SUSPENDED（行不清理）。需 hostToken。 */
    private void apiSuspend(OutputStream out, String code, String body) {
        RoomMeta m = metaOf(code);
        if (m == null) { sendJson(out, 404, "{\"ok\":false,\"error\":\"not_found\"}"); return; }
        JSONObject req;
        try { req = new JSONObject(body); } catch (Exception e) { req = new JSONObject(); }
        String tok = opt(req, "hostToken");
        if (tok == null || !constantTimeEq(m.hostToken, tok)) {
            sendJson(out, 403, "{\"ok\":false,\"error\":\"bad_token\"}");
            return;
        }
        m.status = "SUSPENDED";
        m.lastSeen = System.currentTimeMillis() / 1000L;
        persistMeta(m);   // 挂起必须落盘：这是「改天续玩」的关键一步
        sendJson(out, 200, "{\"ok\":true,\"status\":\"SUSPENDED\"}");
    }

    /** 复活挂起房间：SUSPENDED/RECRUITING → RECRUITING，回传已存 seq/payload。需 hostToken。 */
    private void apiResume(OutputStream out, String code, String body) {
        RoomMeta m = metaOf(code);
        if (m == null) { sendJson(out, 404, "{\"ok\":false,\"error\":\"not_found\"}"); return; }
        JSONObject req;
        try { req = new JSONObject(body); } catch (Exception e) { req = new JSONObject(); }
        String tok = opt(req, "hostToken");
        if (tok == null || !constantTimeEq(m.hostToken, tok)) {
            sendJson(out, 403, "{\"ok\":false,\"error\":\"bad_token\"}");
            return;
        }
        // v2.1.1（用户要求，与公网版 room_server.py:1310 对齐）：SUSPENDED / RECRUITING /
        // IN_GAME 都可续玩（进行中的团也要能「续玩」回到存档点）；CLOSED / 其它一律 not_found
        if (!("SUSPENDED".equals(m.status) || "RECRUITING".equals(m.status)
                || "IN_GAME".equals(m.status))) {
            sendJson(out, 404, "{\"ok\":false,\"error\":\"not_found\"}");
            return;
        }
        m.status = "RECRUITING";
        m.restored = false;   // v2.1.0：房主显式续玩 → 本房本轮「活跃」，可被 UDP 发现
        m.lastSeen = System.currentTimeMillis() / 1000L;
        persistMeta(m);
        StateRec r = loadState(code);
        try {
            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("status", "RECRUITING");
            o.put("seq", r == null ? 0L : r.seq);
            o.put("payload", r == null ? "" : r.payload);
            sendJson(out, 200, o.toString());
        } catch (Exception e) {
            sendJson(out, 500, "{\"error\":\"恢复失败\"}");
        }
    }

    /* ---------- v2.0.2：解绑本机设备身份 / 可命名存档槽 ---------- */

    /** 解绑本机设备身份。凭据 = 请求体里的本机 deviceId；只删 (code, 该 deviceId)。 */
    private void apiUnbind(OutputStream out, String code, String body) {
        RoomMeta m = metaOf(code);
        if (m == null) { sendJson(out, 404, "{\"ok\":false,\"error\":\"not_found\"}"); return; }
        JSONObject req;
        try { req = new JSONObject(body); } catch (Exception e) { req = new JSONObject(); }
        String dev = cleanText(opt(req, "deviceId"), 80);
        if (dev.isEmpty()) { sendJson(out, 400, "{\"ok\":false,\"error\":\"bad_request\"}"); return; }
        boolean existed = getDeviceSeat(code, dev) != null;
        deleteDeviceSeat(code, dev);
        // device_id 是凭据：不回显原文（只记发生与否）
        Log.d(TAG, "unbind code=" + code + " removed=" + existed);
        sendJson(out, 200, "{\"ok\":true,\"code\":\"" + code + "\",\"removed\":" + existed + "}");
    }

    /** 建命名存档槽（快照当前 room_state）。需 hostToken。 */
    private void apiSaveCreate(OutputStream out, String code, String body) {
        RoomMeta m = metaOf(code);
        if (m == null) { sendJson(out, 404, "{\"ok\":false,\"error\":\"not_found\"}"); return; }
        JSONObject req;
        try { req = new JSONObject(body); } catch (Exception e) { req = new JSONObject(); }
        String tok = opt(req, "hostToken");
        if (tok == null || !constantTimeEq(m.hostToken, tok)) {
            sendJson(out, 403, "{\"ok\":false,\"error\":\"bad_token\"}");
            return;
        }
        String name = cleanText(opt(req, "name"), 40);
        if (name.isEmpty()) name = "存档";
        StateRec st = loadState(code);
        long seq = st == null ? 0L : st.seq;
        String payload = st == null ? "" : st.payload;
        String saveId = "sv" + hex(8);
        long now = System.currentTimeMillis() / 1000L;
        try {
            org.json.JSONArray arr = loadSaves(code);
            JSONObject o = new JSONObject();
            o.put("saveId", saveId);
            o.put("name", name);
            o.put("seq", seq);
            o.put("payload", payload == null ? "" : payload);
            o.put("createdAt", now);
            o.put("updatedAt", now);
            arr.put(o);
            writeSaves(code, arr);
            m.lastSeen = now;
            JSONObject res = new JSONObject();
            res.put("ok", true);
            res.put("saveId", saveId);
            res.put("name", name);
            res.put("seq", seq);
            res.put("savedAt", now);
            sendJson(out, 200, res.toString());
        } catch (Exception e) {
            sendJson(out, 500, "{\"ok\":false,\"error\":\"save_failed\"}");
        }
    }

    /** 列出存档槽。需 hostToken。 */
    private void apiSaveList(OutputStream out, String code, String query) {
        RoomMeta m = metaOf(code);
        if (m == null) { sendJson(out, 404, "{\"ok\":false,\"error\":\"not_found\"}"); return; }
        String token = parseQuery(query).get("token");
        if (token == null || !constantTimeEq(m.hostToken, token)) {
            sendJson(out, 403, "{\"ok\":false,\"error\":\"bad_token\"}");
            return;
        }
        try {
            org.json.JSONArray arr = loadSaves(code);
            sortSavesDesc(arr);
            org.json.JSONArray outArr = new org.json.JSONArray();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                JSONObject e = new JSONObject();
                e.put("saveId", o.optString("saveId", ""));
                e.put("name", o.optString("name", ""));
                e.put("seq", o.optLong("seq", 0L));
                e.put("updatedAt", o.optLong("updatedAt", 0L));
                outArr.put(e);
            }
            JSONObject res = new JSONObject();
            res.put("ok", true);
            res.put("saves", outArr);
            sendJson(out, 200, res.toString());
        } catch (Exception e) {
            sendJson(out, 500, "{\"ok\":false,\"error\":\"list_failed\"}");
        }
    }

    /** 读取某存档槽。token 需是 hostToken，或本机 deviceId 命中绑定。 */
    private void apiSaveGet(OutputStream out, String code, String saveId, String query) {
        RoomMeta m = metaOf(code);
        if (m == null) { sendJson(out, 404, "{\"ok\":false,\"error\":\"not_found\"}"); return; }
        Map<String, String> q = parseQuery(query);
        String token = q.get("token");
        String dev = cleanText(q.get("d"), 80);
        boolean allowed = token != null && constantTimeEq(m.hostToken, token);
        if (!allowed && !dev.isEmpty()) allowed = getDeviceSeat(code, dev) != null;
        if (!allowed) { sendJson(out, 403, "{\"ok\":false,\"error\":\"bad_token\"}"); return; }
        JSONObject o = findSave(loadSaves(code), saveId);
        if (o == null) { sendJson(out, 404, "{\"ok\":false,\"error\":\"not_found\"}"); return; }
        try {
            JSONObject res = new JSONObject();
            res.put("ok", true);
            res.put("saveId", o.optString("saveId", ""));
            res.put("name", o.optString("name", ""));
            res.put("seq", o.optLong("seq", 0L));
            res.put("payload", o.optString("payload", ""));
            res.put("updatedAt", o.optLong("updatedAt", 0L));
            sendJson(out, 200, res.toString());
        } catch (Exception e) {
            sendJson(out, 500, "{\"ok\":false,\"error\":\"read_failed\"}");
        }
    }

    /** 载入某存档槽为当前状态，并把房间置 RECRUITING。需 hostToken。 */
    private void apiSaveLoad(OutputStream out, String code, String saveId, String body) {
        RoomMeta m = metaOf(code);
        if (m == null) { sendJson(out, 404, "{\"ok\":false,\"error\":\"not_found\"}"); return; }
        JSONObject req;
        try { req = new JSONObject(body); } catch (Exception e) { req = new JSONObject(); }
        String tok = opt(req, "hostToken");
        if (tok == null || !constantTimeEq(m.hostToken, tok)) {
            sendJson(out, 403, "{\"ok\":false,\"error\":\"bad_token\"}");
            return;
        }
        JSONObject o = findSave(loadSaves(code), saveId);
        if (o == null) { sendJson(out, 404, "{\"ok\":false,\"error\":\"not_found\"}"); return; }
        long seq = o.optLong("seq", 0L);
        String payload = o.optString("payload", "");
        long now = System.currentTimeMillis() / 1000L;
        writeStateFile(stateFile(code), seq, payload, now);   // 读档：直接覆盖 room_state
        m.status = "RECRUITING";
        m.restored = false;   // v2.1.0：房主读档续玩 → 本房本轮「活跃」，可被 UDP 发现
        m.lastSeen = now;
        persistMeta(m);
        try {
            JSONObject res = new JSONObject();
            res.put("ok", true);
            res.put("seq", seq);
            res.put("payload", payload);
            sendJson(out, 200, res.toString());
        } catch (Exception e) {
            sendJson(out, 500, "{\"ok\":false,\"error\":\"load_failed\"}");
        }
    }

    /** 删除某存档槽。需 hostToken。 */
    private void apiSaveDelete(OutputStream out, String code, String saveId, String body) {
        RoomMeta m = metaOf(code);
        if (m == null) { sendJson(out, 404, "{\"ok\":false,\"error\":\"not_found\"}"); return; }
        JSONObject req;
        try { req = new JSONObject(body); } catch (Exception e) { req = new JSONObject(); }
        String tok = opt(req, "hostToken");
        if (tok == null || !constantTimeEq(m.hostToken, tok)) {
            sendJson(out, 403, "{\"ok\":false,\"error\":\"bad_token\"}");
            return;
        }
        org.json.JSONArray arr = loadSaves(code);
        org.json.JSONArray next = new org.json.JSONArray();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null) continue;
            if (saveId.equals(o.optString("saveId", ""))) continue;
            next.put(o);
        }
        writeSaves(code, next);
        sendJson(out, 200, "{\"ok\":true,\"saveId\":\"" + saveId + "\"}");
    }

    /* ---------- WebSocket ---------- */

    private void doWs(Socket sock, BufferedInputStream in, OutputStream out,
                      String query, Map<String, String> headers) throws IOException {
        Map<String, String> q = parseQuery(query);
        String code = q.get("code");
        String token = q.get("t");
        String deviceId = cleanText(q.get("d"), 80);      // v2.0.2：设备标识

        if (code == null || !code.matches("[a-z0-9]{4,12}")) {
            sendJson(out, 400, "{\"error\":\"缺少房间号\"}");
            return;
        }
        RoomMeta m = metaOf(code);
        if (m == null) { sendJson(out, 404, "{\"error\":\"房间不存在\"}"); return; }
        if ("CLOSED".equals(m.status)) { sendJson(out, 410, "{\"error\":\"房间已关闭\"}"); return; }

        // v2.0.2：设备绑定 —— 命中即「本机回座」的持久凭据（App 重启后 mtoken 失效也认）
        String[] binding = deviceId.isEmpty() ? null : getDeviceSeat(code, deviceId);
        String activeToken = token == null ? "" : token;
        String role = null, nickname = "";
        if (token != null && constantTimeEq(m.hostToken, token)) {
            role = "kp"; nickname = m.kpName;
        } else {
            Member mem;
            synchronized (registryLock) { mem = members.get(code + "|" + activeToken); }
            if (mem != null) { role = mem.role; nickname = mem.nickname; }
            else if (binding != null) {                   // 设备码通道：mtoken 失效也认
                role = (binding[1] == null || binding[1].isEmpty()) ? "player" : binding[1];
                nickname = binding[2] == null ? "" : binding[2];
            }
        }
        if (role == null) {
            sendJson(out, 403, "{\"error\":\"连接凭据无效，请重新加入\"}");
            return;
        }

        String key = headers.get("sec-websocket-key");
        String upgrade = headers.get("upgrade");
        if (key == null || upgrade == null || !"websocket".equalsIgnoreCase(upgrade)) {
            sendJson(out, 400, "{\"error\":\"需要 WebSocket 升级请求\"}");
            return;
        }

        String accept = wsAcceptKey(key);
        out.write(("HTTP/1.1 101 Switching Protocols\r\n"
                + "Upgrade: websocket\r\n"
                + "Connection: Upgrade\r\n"
                + "Sec-WebSocket-Accept: " + accept + "\r\n\r\n")
                .getBytes(Charset.forName("US-ASCII")));
        out.flush();

        Room room = ensureRoom(code);
        Conn conn = new Conn(sock, role, code, nickname, token == null ? "" : token, ipOf(sock),
                deviceId);

        // ---- 座位转正：预留位在 HTTP join 时已占，这里消费；拿不到要分「重连」与「接管」 ----
        if ("kp".equals(role)) {
            Conn prev = room.host;
            if (prev != null) {
                prev.kick(CLOSE_TAKEOVER, "房主已在别处重新连接");
            }
        } else {
            long[] reserved = room.consume(token == null ? "" : token);
            if (reserved == null) {
                Conn prev = room.findByToken(token == null ? "" : token);
                if (prev == null && !deviceId.isEmpty()) {
                    prev = room.findBySeat(conn.seat());     // v2.0.2：设备码通道按座位接管
                }
                if (prev != null) {
                    prev.kick(CLOSE_TAKEOVER, "已在别处重新连接");
                } else if (binding != null) {
                    // 设备码命中绑定 = 合法回座，不判容量（否则进行中的团回不去）
                } else {
                    String verdict = joinAllowed(m, room.counts(), role);
                    if (verdict != null) {
                        conn.kick(CLOSE_REJECT, verdict);
                        conn.closeSocket();
                        return;
                    }
                }
            }
        }

        // v2.0.2 断点1修复：设备码命中、但 mtoken 已失效 → 补发新 mtoken（写回内存 + 随 ready 回）
        String reissued = "";
        if (!"kp".equals(role) && binding != null) {
            boolean known;
            synchronized (registryLock) { known = members.containsKey(code + "|" + activeToken); }
            if (!known) {
                reissued = urlSafe(18);
                activeToken = reissued;
                Member nm = new Member();
                nm.role = role; nm.nickname = nickname; nm.code = code; nm.cid = conn.cid;
                synchronized (registryLock) { members.put(code + "|" + reissued, nm); }
            }
        }

        room.add(conn);
        try {
            JSONObject ready = new JSONObject();
            ready.put("k", "ready");
            ready.put("cid", conn.cid);
            ready.put("seat", conn.seat());
            ready.put("role", role);
            ready.put("code", code);
            ready.put("serverTime", System.currentTimeMillis() / 1000L);
            if (!reissued.isEmpty()) ready.put("mtoken", reissued);
            conn.sendText(ready.toString());
        } catch (Exception ignored) { }

        try {
            if ("kp".equals(role)) {
                JSONObject ok = new JSONObject();
                ok.put("k", "host.ok");
                ok.put("meta", metaJson(m));
                Counts c = room.counts();
                JSONObject cc = new JSONObject();
                cc.put("players", c.players);
                cc.put("spectators", c.spectators);
                ok.put("counts", cc);
                room.toHost(ok.toString());
                // 房主（重）连接：把已在线的成员补发一遍，否则 KP 刷新一次就以为房间空了
                for (Conn c2 : room.audience()) {
                    JSONObject po = new JSONObject();
                    po.put("k", "peer.open");
                    po.put("cid", c2.cid);
                    po.put("seat", c2.seat());
                    po.put("role", c2.role);
                    po.put("nickname", c2.nickname);
                    po.put("ip", c2.ip);
                    po.put("spectators", room.counts().spectators);
                    po.put("rejoin", true);
                    room.toHost(po.toString());
                }
            } else {
                JSONObject po = new JSONObject();
                po.put("k", "peer.open");
                po.put("cid", conn.cid);
                po.put("seat", conn.seat());
                po.put("role", role);
                po.put("nickname", nickname);
                po.put("ip", conn.ip);
                po.put("spectators", room.counts().spectators);
                po.put("rejoin", false);
                room.toHost(po.toString());
            }
        } catch (Exception ignored) { }

        Thread hb = new Thread(new Runnable() {
            @Override public void run() { heartbeat(conn); }
        }, "cocroom-hb");
        hb.setDaemon(true);
        hb.start();

        try {
            pump(room, conn);
        } catch (Exception e) {
            Log.d(TAG, "pump end code=" + code + " cid=" + conn.cid + " " + e.getMessage());
        } finally {
            conn.closed = true;
            room.remove(conn);
            synchronized (registryLock) {
                Member mm = members.get(code + "|" + activeToken);
                if (mm != null) mm.cid = null;
            }
            if ("kp".equals(role)) {
                for (Conn c2 : room.audience()) {
                    c2.sendText("{\"k\":\"host.gone\",\"message\":\"房主已断开，正在等待重连\"}");
                }
            } else {
                try {
                    JSONObject pc = new JSONObject();
                    pc.put("k", "peer.close");
                    pc.put("cid", conn.cid);
                    pc.put("seat", conn.seat());
                    room.toHost(pc.toString());
                } catch (Exception ignored) { }
            }
            conn.closeSocket();
        }
    }

    private void heartbeat(final Conn conn) {
        while (!conn.closed) {
            try { Thread.sleep(HEARTBEAT_MS); } catch (InterruptedException e) { return; }
            if (conn.closed) return;
            try {
                wsWrite(conn.sock, new byte[0], OP_PING, conn.lock);
            } catch (Exception e) {
                conn.kick(CLOSE_TIMEOUT, "心跳失败");
                return;
            }
        }
    }

    /** 读循环。只解析 hub.* 控制消息，其余原样转发给权威端。 */
    private void pump(Room room, Conn conn) throws IOException {
        BufferedInputStream in = new BufferedInputStream(conn.sock.getInputStream());
        ByteArrayOutputStream frag = new ByteArrayOutputStream();
        int fragOp = 0;

        while (!conn.closed) {
            Frame f = wsRead(in, MAX_FRAME);
            if (f == null) return;
            if (f.opcode == OP_CLOSE) return;
            if (f.opcode == OP_PING) { wsWrite(conn.sock, f.payload, OP_PONG, conn.lock); continue; }
            if (f.opcode == OP_PONG) continue;

            byte[] payload = f.payload;
            int opcode = f.opcode;
            if (opcode == OP_CONT) {
                frag.write(payload);
                if (!f.fin) continue;
                payload = frag.toByteArray();
                opcode = fragOp;
                frag.reset();
                fragOp = 0;
            } else if (!f.fin) {
                frag.reset();
                frag.write(payload);
                fragOp = opcode;
                continue;
            }

            if (!conn.rateOk()) {
                conn.sendText("{\"k\":\"error\",\"message\":\"消息发送过于频繁，请稍后再试\"}");
                continue;
            }

            String text = new String(payload, Charset.forName("UTF-8"));
            if ("kp".equals(conn.role)) fromHost(room, text);
            else {
                try {
                    JSONObject o = new JSONObject();
                    o.put("k", "peer.msg");
                    o.put("cid", conn.cid);
                    o.put("text", text);
                    room.toHost(o.toString());
                } catch (Exception ignored) { }
            }
        }
    }

    /** 权威端 → 中继。只认 hub.*，别的一律忽略。 */
    private void fromHost(Room room, String text) {
        JSONObject msg;
        try { msg = new JSONObject(text); } catch (Exception e) { return; }
        String k = msg.optString("k", "");
        if ("hub.send".equals(k)) {
            Conn target = room.find(msg.optString("cid", ""));
            if (target != null) target.sendText(msg.optString("text", ""));
        } else if ("hub.broadcast".equals(k)) {
            String body = msg.optString("text", "");
            for (Conn c : room.audience()) c.sendText(body);
        } else if ("hub.close".equals(k)) {
            Conn target = room.find(msg.optString("cid", ""));
            if (target != null) {
                String reason = msg.optString("text", "");
                target.kick(CLOSE_KICKED, reason.isEmpty() ? "已被房主移出房间" : reason);
            }
        } else if ("hub.meta".equals(k)) {
            hostMeta(room.code, msg.optJSONObject("meta"));
        }
    }

    private void hostMeta(String code, JSONObject meta) {
        RoomMeta m = metaOf(code);
        if (m == null || meta == null) return;
        String status = meta.optString("status", "");
        boolean changed = false;
        if ("RECRUITING".equals(status) || "IN_GAME".equals(status) || "CLOSED".equals(status)) {
            if (!status.equals(m.status)) changed = true;
            m.status = status;
        }
        m.lastSeen = System.currentTimeMillis() / 1000L;
        // 状态变化时同步落盘：CLOSED 删文件，其余覆盖写（未变化就不写盘，省 I/O）
        if ("CLOSED".equals(m.status)) {
            removeMetaFile(code);
            removeAuxFiles(code);
        } else if (changed) {
            persistMeta(m);
        }
    }

    /* ============================================================
     * 准入判定（目录预检 / join / WS 连接三处共用同一份）
     * ============================================================ */

    /** 返回 null = 允许；否则返回给用户看的原因。
     *
     *  v2.1.1（用户第三轮反馈）：**IN_GAME 不再拒绝玩家加入** —— 否则「断线重连 /
     *  保存后重开」会被挡在门外。是否重连由机器码判定（见 joinKindOf），只影响提示与
     *  落座，不影响能不能进；玩家席容量仍然照判。与公网版 join_allowed 逐字对齐。 */
    private static String joinAllowed(RoomMeta m, Counts c, String role) {
        if (m == null) return "房间不存在或已过期";
        if ("CLOSED".equals(m.status)) return "房间已解散";
        if ("kp".equals(role)) return null;
        if ("spectator".equals(role)) {
            if (!m.allowSpec) return "该房间不允许旁观";
            if (c.players + c.spectators >= MAX_MEMBERS) return "房间连接数已满";
            return null;
        }
        if (c.players >= m.maxPlayers) return "玩家席已满（" + c.players + "/" + m.maxPlayers + "）";
        return null;
    }

    /** 机器码判定：binding（getDeviceSeat 结果）命中 → 'reconnect'；否则 'new'。
     *  与公网版 join_kind 同名同语义。只影响提示/落座，不影响能不能进。 */
    private static String joinKindOf(String[] binding) {
        return binding != null ? "reconnect" : "new";
    }

    /** 把「给人看的原因」映射成机器可读的枚举（与公网版一致）。 */
    private static String reasonCode(String message) {
        if (message == null) return "";
        if (message.contains("不存在")) return "ROOM_NOT_FOUND";
        if (message.contains("解散")) return "ROOM_CLOSED";
        if (message.contains("不允许旁观")) return "SPECTATE_DENIED";
        if (message.contains("连接数已满")) return "ROOM_FULL";
        if (message.contains("已经开始")) return "ALREADY_STARTED";
        if (message.contains("玩家席已满")) return "PLAYER_FULL";
        return "";
    }

    /* ============================================================
     * WebSocket 帧编解码（与公网版逐行对应）
     * ============================================================ */

    private static final class Frame {
        boolean fin;
        int opcode;
        byte[] payload;
    }

    private static Frame wsRead(InputStream in, int maxLen) throws IOException {
        int b0 = in.read();
        if (b0 < 0) return null;
        int b1 = in.read();
        if (b1 < 0) return null;

        Frame f = new Frame();
        f.fin = (b0 & 0x80) != 0;
        f.opcode = b0 & 0x0F;
        boolean masked = (b1 & 0x80) != 0;
        long len = b1 & 0x7F;
        if (len == 126) {
            len = ((long) readByte(in) << 8) | readByte(in);
        } else if (len == 127) {
            len = 0;
            for (int i = 0; i < 8; i++) len = (len << 8) | readByte(in);
        }
        if (len > maxLen) throw new IOException("单帧超过上限 " + maxLen);
        if (!masked) throw new IOException("客户端帧未加掩码");

        byte[] mask = readN(in, 4);
        byte[] payload = len > 0 ? readN(in, (int) len) : new byte[0];
        for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        f.payload = payload;
        return f;
    }

    private static void wsWrite(Socket sock, byte[] payload, int opcode, Object lock)
            throws IOException {
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        head.write(0x80 | opcode);
        int n = payload.length;
        if (n < 126) {
            head.write(n);
        } else if (n < 65536) {
            head.write(126);
            head.write((n >> 8) & 0xFF);
            head.write(n & 0xFF);
        } else {
            head.write(127);
            for (int i = 7; i >= 0; i--) head.write((int) (((long) n >> (8 * i)) & 0xFF));
        }
        byte[] h = head.toByteArray();
        byte[] frame = new byte[h.length + n];
        System.arraycopy(h, 0, frame, 0, h.length);
        System.arraycopy(payload, 0, frame, h.length, n);
        synchronized (lock) {
            OutputStream os = sock.getOutputStream();
            os.write(frame);
            os.flush();
        }
    }

    private static String wsAcceptKey(String key) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-1");
            byte[] d = md.digest((key + WS_GUID).getBytes(Charset.forName("US-ASCII")));
            return android.util.Base64.encodeToString(d, android.util.Base64.NO_WRAP);
        } catch (Exception e) {
            return "";
        }
    }

    /* ============================================================
     * 小型工具
     * ============================================================ */

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) >= 0) {
            if (c == '\n') break;
            if (c != '\r') bos.write(c);
        }
        if (c < 0 && bos.size() == 0) return null;
        return new String(bos.toByteArray(), Charset.forName("UTF-8"));
    }

    private static int readByte(InputStream in) throws IOException {
        int c = in.read();
        if (c < 0) throw new IOException("连接已关闭");
        return c;
    }

    private static byte[] readN(InputStream in, int n) throws IOException {
        byte[] buf = new byte[n];
        int off = 0;
        while (off < n) {
            int r = in.read(buf, off, n - off);
            if (r < 0) throw new IOException("连接已关闭");
            off += r;
        }
        return buf;
    }

    private String readBody(InputStream in, Map<String, String> headers, int maxLen) {
        int n;
        try { n = Integer.parseInt(headers.get("content-length")); }
        catch (Exception e) { return "{}"; }
        if (n <= 0) return "{}";
        if (n > maxLen) return null;
        try { return new String(readN(in, n), Charset.forName("UTF-8")); }
        catch (Exception e) { return null; }
    }

    private void sendJson(OutputStream out, int code, String body) {
        try {
            byte[] b = (body == null ? "" : body).getBytes(Charset.forName("UTF-8"));
            StringBuilder sb = new StringBuilder();
            sb.append("HTTP/1.1 ").append(code).append(' ').append(statusText(code)).append("\r\n");
            sb.append("Content-Type: application/json; charset=utf-8\r\n");
            sb.append("Content-Length: ").append(b.length).append("\r\n");
            // 车卡器跑在 appassets.androidplatform.net 虚拟源下，属于跨域，必须放行
            sb.append("Access-Control-Allow-Origin: *\r\n");
            sb.append("Access-Control-Allow-Headers: Content-Type\r\n");
            sb.append("Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS\r\n");
            sb.append("Connection: close\r\n\r\n");
            synchronized (out) {
                out.write(sb.toString().getBytes(Charset.forName("US-ASCII")));
                out.write(b);
                out.flush();
            }
        } catch (Exception ignored) { }
    }

    private static String statusText(int code) {
        switch (code) {
            case 200: return "OK";
            case 204: return "No Content";
            case 400: return "Bad Request";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 410: return "Gone";
            case 413: return "Payload Too Large";
            case 429: return "Too Many Requests";
            case 500: return "Internal Server Error";
            case 507: return "Insufficient Storage";
            default: return "OK";
        }
    }

    private static Map<String, String> parseQuery(String q) {
        Map<String, String> out = new HashMap<String, String>();
        if (q == null || q.isEmpty()) return out;
        for (String pair : q.split("&")) {
            if (pair.isEmpty()) continue;
            int e = pair.indexOf('=');
            try {
                if (e < 0) out.put(dec(pair), "");
                else out.put(dec(pair.substring(0, e)), dec(pair.substring(e + 1)));
            } catch (Exception ignored) { }
        }
        return out;
    }

    private static String dec(String s) throws Exception {
        return URLDecoder.decode(s, "UTF-8");
    }

    private String newCode() {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < CODE_LEN; i++) sb.append(CODE_ALPHA.charAt(rnd.nextInt(CODE_ALPHA.length())));
        return sb.toString();
    }

    private String hex(int bytes) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < bytes; i++) sb.append(String.format("%02x", rnd.nextInt(256)));
        return sb.toString();
    }

    private String urlSafe(int bytes) {
        byte[] b = new byte[bytes];
        rnd.nextBytes(b);
        return android.util.Base64.encodeToString(b,
                android.util.Base64.URL_SAFE | android.util.Base64.NO_WRAP | android.util.Base64.NO_PADDING);
    }

    private static String sha256Hex12(String s) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest(s.getBytes(Charset.forName("UTF-8")));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < d.length && sb.length() < 12; i++) {
                sb.append(String.format("%02x", d[i]));
            }
            return sb.substring(0, 12);
        } catch (Exception e) {
            return "000000000000";
        }
    }

    /** PBKDF2 与公网版同参数（sha256 / 60000 轮），保证同一密码两边都能校验。 */
    private static String pbkdf2(String password, String salt) {
        try {
            javax.crypto.SecretKeyFactory f =
                    javax.crypto.SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256");
            javax.crypto.spec.PBEKeySpec spec = new javax.crypto.spec.PBEKeySpec(
                    password.toCharArray(), salt.getBytes(Charset.forName("UTF-8")), 60000, 256);
            byte[] dk = f.generateSecret(spec).getEncoded();
            return android.util.Base64.encodeToString(dk, android.util.Base64.NO_WRAP);
        } catch (Exception e) {
            return "";
        }
    }

    private static boolean verifyPwd(String given, String salt, String expected) {
        if (expected == null || expected.isEmpty()) return true;
        return constantTimeEq(pbkdf2(given, salt), expected);
    }

    private static boolean constantTimeEq(String a, String b) {
        if (a == null || b == null) return false;
        if (a.length() != b.length()) return false;
        int r = 0;
        for (int i = 0; i < a.length(); i++) r |= a.charAt(i) ^ b.charAt(i);
        return r == 0;
    }

    /** 过滤控制字符并按长度截断。房间名/昵称都进目录，不能带换行与不可见字符。 */
    private static String cleanText(String v, int limit) {
        if (v == null) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < v.length(); i++) {
            char ch = v.charAt(i);
            if (ch >= ' ' && ch != 0x7F) sb.append(ch);
        }
        String s = sb.toString().replaceAll("\\s+", " ").trim();
        return s.length() > limit ? s.substring(0, limit) : s;
    }

    private static String opt(JSONObject o, String k) {
        if (o == null || !o.has(k) || o.isNull(k)) return null;
        return String.valueOf(o.opt(k));
    }

    /** ws 基址：局域网下就是本机 IP + 端口。 */
    private String wsBase() {
        String ip = localIpv4();
        if (ip == null) ip = "127.0.0.1";
        return "ws://" + ip + ":" + port;
    }

    /** http 基址（给邀请链接用）。 */
    String httpBase() {
        String ip = localIpv4();
        if (ip == null) ip = "127.0.0.1";
        return "http://" + ip + ":" + port;
    }

    private static String ipOf(Socket s) {
        try {
            return s.getInetAddress() != null ? s.getInetAddress().getHostAddress() : "?";
        } catch (Exception e) {
            return "?";
        }
    }

    private RoomMeta metaOf(String code) {
        synchronized (registryLock) { return metaIndex.get(code); }
    }

    private Room roomOf(String code) {
        synchronized (registryLock) { return rooms.get(code); }
    }

    private Room ensureRoom(String code) {
        synchronized (registryLock) {
            Room r = rooms.get(code);
            if (r == null) { r = new Room(code); rooms.put(code, r); }
            return r;
        }
    }
}
