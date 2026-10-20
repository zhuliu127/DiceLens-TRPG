# -*- coding: utf-8 -*-
"""
coc-room-server —— 跑团房间 · 公网房间目录 + 实时中继

单文件、纯 Python 标准库（http.server + sqlite3 + hashlib + socket）。
没有用 websockets / aiohttp：一是服务器只有 2C/2G 且要与 blog/dice/license 共存，
二是与同机的 coc_share_server.py 保持同一种形态 —— clone 下来不用装任何依赖就能跑。

## 它在整个体系里的位置（很重要）

跑团房间有两条联网路线，**协议完全相同**，只有「谁是权威端」不同：

  局域网：权威端 = KP 那台手机（安卓外壳内嵌的 LanServer.java 当哑管道转发）
  公网  ：权威端 = 还是 KP 那台手机，本服务只做「鉴权 + 转发 + 房间目录」

也就是说**本服务不持有游戏状态**。游戏状态、事件序号、可见性裁剪全部在 KP 端，
服务端只负责：房间登记、密码校验、容量与状态校验、把字节转发给对的人。
这么设计的原因是需求 §11.1「局域网与公网调用同一套房间事件协议、权限规则与
CoC 规则服务，避免实现两份不一致逻辑」—— 如果服务端也存一份状态，就一定分叉。

## 对照 requirement 的两层协议

  hub.*  ：权威端（KP）→ 中继     （本服务 / LanServer 都实现这一层）
  peer.* ：中继 → 权威端（KP）
  其余   ：中继只是**原样透传**的字节，不解析 ——
           这样加了新事件类型也不用改服务端，更不会因为服务端「看不懂」而丢消息。

### cid 与 seat：一个发信、一个认人（别混用）

  cid  每次连接重新生成 —— 它只是「往哪儿发」的地址，重连就变
  seat 由成员凭据派生，同一 (房间, 凭据) 恒定 —— 权威端**用它认座位**

为什么必须分开：如果权威端拿 cid 当身份，玩家刷新一次页面就会变成
「凭空多出一个人」，他的准备状态、绑定的角色卡、行动顺序全部丢，
而原来那个人永远挂在那里。所以：

  ready      → {cid, seat, role, code, serverTime}   （发给成员自己）
  peer.open  → {cid, seat, role, nickname, ip, spectators, rejoin}
  peer.close → {cid, seat}                           （不带 seat 就分不清
                                                       「重连让位」与「真的走了」）

  · 同一凭据再连一次 = **接管**：老连接收到 CLOSE 帧并被回收，
    权威端会先后收到同 seat 的 open 与 close，据此判断是「rejoin」而非「离开」。
  · 房主（重）连接时，服务端会把**已在线的成员**用 peer.open(rejoin=true) 补发一遍；
    否则 KP 页面刷新一次，权威端就会以为房间是空的（玩家那边还挂着）。

## 接口

  GET  /health                     健康检查
  GET  /api/rooms                  房间目录（只列服务端当前有效的房间）
  POST /api/rooms                  创建房间  → {code, hostToken, wsBase}
  POST /api/rooms/<code>/probe     加入前预检（不需要密码也能问「能不能进」）
  POST /api/rooms/<code>/join      校验密码/容量/状态 → {code, mtoken, wsUrl, role, joinKind, meta}
  POST /api/rooms/<code>/close     KP 关房（需 hostToken）
  POST /api/rooms/<code>/state     写入游戏存档（需 hostToken；payload 不透明，seq 单调递增）
  GET  /api/rooms/<code>/state     读取游戏存档（需 hostToken 或任一有效成员 mtoken）
  POST /api/rooms/<code>/suspend   挂起房间 → SUSPENDED（需 hostToken，存档保留可续玩）
  POST /api/rooms/<code>/resume    复活挂起房间 → RECRUITING（需 hostToken，回传已存 seq/payload）
  POST /api/rooms/<code>/unbind    解绑本机设备身份（v2.0.2；凭据=请求体里的本机 deviceId，只解绑自己）
  POST /api/rooms/<code>/saves     新建一个可命名存档槽（v2.0.2；需 hostToken）
  GET  /api/rooms/<code>/saves     列出存档槽（v2.0.2；需 hostToken）
  GET  /api/rooms/<code>/saves/<id>        读取某存档槽（v2.0.2；hostToken 或成员 mtoken/deviceId）
  POST /api/rooms/<code>/saves/<id>/load   载入某存档槽（v2.0.2；需 hostToken；置 room_state 并把房间置 RECRUITING）
  DELETE /api/rooms/<code>/saves/<id>      删除某存档槽（v2.0.2；需 hostToken）
  GET  /ws?code=..&t=..&d=..        WebSocket 升级（d=设备标识，v2.0.2）

### 设备身份（v2.0.2）

  断线重连的根因：成员 token（mtoken）只在内存里（见下），进程一重启就失效，
  于是 seat（由 mtoken 派生）也跟着变，玩家「永远回不去」。修法：引入**设备标识**
  device_id（安卓原生 sha256(packageName:ANDROID_ID)，浏览器降级为本地随机码），
  把它与 (房间, seat, role) 绑定持久化到 device_seats 表：

    · join / WS 连接：先按 (code, device_id) 查绑定 → 命中即复用原 seat（真重连）；
      未命中才按 mtoken 派生并写入绑定。seat 派生 basis = device_id（有）否则 mtoken（旧行为）。
    · 进程重启后 mtoken 失效：只要 device_id 命中绑定，WS 据此解析 seat 并**补发新 mtoken**
      （写回内存 + 随 ready 回给客户端），于是玩家仍回原座。
    · 安全：device_id 视为凭据 —— **不落日志原文**、比较用 secrets.compare_digest；
      客户端上报的 deviceId 只用于解析「自己的」seat，不能认领别人的 seat。

### 存档协议（v2.0.0 新增）

  · 房间状态新增 SUSPENDED（已挂起、可续玩）。它**不出现在目录**（同 CLOSED），
    但**行不被清理** —— 由 janitor 按 SUSPEND_RETENTION_DAYS（30 天）单独回收。
  · payload 是**不透明字符串**（客户端序列化的存档 JSON）。中继**绝不解析其内容** ——
    与本文件对 {k:'sync'|'evt'|'skip'|'intent'} 一律原样透传是同一条约定。
  · seq 单调递增，只在 seq > 已存 seq 时覆盖（幂等 + 防倒退）；收到更小的 seq 返回
    {ok:true, seq:<已存>, stale:true} 且不覆盖。
  · 错误码统一 {ok:false, error:'<snake_case>'}：no_state / bad_token / not_found /
    too_large / bad_request（两端同名）。
  · 挂起（SUSPENDED）的房间对 /join 一律拒绝，返回 403 {ok:false, error:'room_suspended'}
    （两端同名同码），只有房主 resume 之后才能再加入。
  · v2.1.1（用户第三轮反馈）：**IN_GAME 房间允许玩家加入**（不再返回 ALREADY_STARTED）——
    否则「断线重连 / 保存后重开」会被挡在门外。是否重连由**机器码**判定：
    命中 device_seats 绑定 → joinKind='reconnect'，否则 'new'；名额仍受 max_players 限制。

### 名额为什么要有「预留位」

  join 只到 HTTP 层，此时 WS 还没连上。若名额只看「已经连上 WS 的人」，
  那么 HTTP 阶段所有请求看到的都是 0 人 —— 三个人同时 join 会全部成功，
  到连 WS 那一步才被踢。界面上就是「显示能进、点了没反应」（需求 §2.3 禁止）。

  所以 join 成功即在同一把锁内**原子占位**（reserve），连接建立时转正（consume），
  一直不连的预留位由后台线程按 ROOM_RESERVE_TTL 回收。
  目录里的 players/spectators **含预留位**（否则会出现「列表显示 2/2 却还能点进去」）。

## 数据留存策略（必须明确，不能含糊）

  · SQLite 只存**房间元数据**（房间号 / 名称 / KP / 需不需要密码 / 玩家上限 /
    是否允许旁观 / 状态 / 创建时间 / 最后活跃时间 / 密码散列 / hostToken）。
  · **游戏事件与聊天不经服务端落库**，纯转发。参与者的记录保存在各自设备的
    localStorage 里（见 web/js/core/room-store.js），所以关房/掉线都不会丢记录。
  · 房间行在「最后活跃时间」超过 ROOM_RETENTION_HOURS 后由后台线程删除。
  · 成员 token 只放在内存里，进程重启即失效（客户端会重新 join）。
  · v2.0.0 新增 room_state 表：**只存不透明存档字符串**（code/seq/payload/updated_at），
    服务端不解析 payload。房间行被清理时，其孤儿存档一并删除。

## ⚠️ 这是一个匿名可写的公网端点

和 coc-share 一样，必须有防护，否则会被当成免费的实时聊天中继刷爆，
同机的其它服务跟着一起挂。四道闸：

  1. 单 IP / 全站建房限流
  2. 单 IP 加入尝试限流（防密码爆破）
  3. 房间总数 / 单房成员数 / 单帧大小 上限
  4. 超期房间自动清理

用法：
    export ROOM_PUBLIC_BASE=https://你的域名/room
    python3 room_server.py

v2.12.2 **裸启动**：一个 ROOM_* 环境变量都不带（典型就是双击 coc-room.exe）时，
自动配齐局域网参数，不再被「缺少 ROOM_PUBLIC_BASE」劝退——
监听 0.0.0.0、端口 8080、DB 放程序旁边、PUBLIC_BASE 自动猜本机 IP、
旁边有 index.html 就顺带托管网页（一条命令开完整局域网一体服）、并自动打开浏览器。
生产部署（systemd）显式带全套环境变量，**永远不进裸启动分支，行为与以前一致**。
"""
import base64
import hashlib
import json
import os
import re
import secrets
import select
import socket
import sqlite3
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, quote

# ---------------- 配置 ----------------
HOST = os.environ.get("ROOM_HOST", "127.0.0.1")
PORT = int(os.environ.get("ROOM_PORT", "12710"))
DB_PATH = os.environ.get("ROOM_DB", "/opt/coc-room/rooms.db")

# 对外基址，用来拼 ws 地址。必须由部署者自己设置 —— 代码里不预置任何人的域名。
PUBLIC_BASE = os.environ.get("ROOM_PUBLIC_BASE", "").rstrip("/")

# v2.11.8（局域网一体服）：可选静态托管目录。设了它，中继就顺带把网页也 serve 了 ——
# 于是一台机器、一个 HTTP 源同时提供「网页 + 房间中继」，朋友打开 http://<局域网IP>:端口/
# 即玩：同源、无混合内容、不走外网。**不设则行为完全不变（仍是纯中继，公网部署走这条）**。
# ⚠️ 只新增 GET 静态分发，不改任何 API/WS 端点与消息 → 协议未变，无需同步 LanServer.java。
STATIC_DIR = os.environ.get("ROOM_STATIC_DIR", "").strip()

_STATIC_TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon",
    ".webp": "image/webp", ".txt": "text/plain; charset=utf-8",
    ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
}

CODE_LEN = 6
MAX_FRAME = 64 * 1024            # 单条 WebSocket 消息上限（事件都应该是小 JSON）
MAX_HTTP_BODY = 16 * 1024        # 房间元数据类的请求体上限

# 单条游戏存档（不透明 payload）的字节上限，超过 → too_large。**必须与 LanServer.java 同值。**
# v2.1.3（用户第 3 项「存档推送失败：too_large」）：2MB → 16MB。
#   存档里含**场景图素材的 base64**，一场团几张图就轻松超过 2MB —— 旧值直接把
#   正常存档判成超限（用户实测报错 too_large）。16MB ≈ 十余张压缩后场景图，
#   对自建服务是可接受的内存占用。
MAX_STATE_BYTES = 16 * 1024 * 1024
# 存档端点的 HTTP 请求体上限。payload 是 JSON 字符串，转义/包裹会带来额外开销
# （base64 里的 +/ 在 JSON 里不转义，但换行与引号会），所以请求体上限要显著高于
# payload 上限本身，否则一个合法 payload 会被误判成超限。
# ⚠️ nginx 的 client_max_body_size 必须 ≥ 本值（见 tools/deploy_room_server.py）。
MAX_STATE_BODY = 48 * 1024 * 1024

# ---------------- 防护参数 ----------------
MAX_ROOMS = int(os.environ.get("ROOM_MAX_ROOMS", "200"))              # 房间总数熔断
MAX_MEMBERS = int(os.environ.get("ROOM_MAX_MEMBERS", "24"))           # 单房连接数上限
MAX_PLAYERS_HARD = int(os.environ.get("ROOM_MAX_PLAYERS_HARD", "12"))  # 玩家上限的硬顶
RATE_CREATE_IP = int(os.environ.get("ROOM_RATE_CREATE_IP", "5"))      # 单 IP 每分钟建房
RATE_CREATE_GLOBAL = int(os.environ.get("ROOM_RATE_CREATE_GLOBAL", "30"))
RATE_JOIN_IP = int(os.environ.get("ROOM_RATE_JOIN_IP", "20"))         # 单 IP 每分钟加入尝试（防爆破）
RATE_MSGS = int(os.environ.get("ROOM_RATE_MSGS", "240"))              # 单连接每分钟消息数
RETENTION_HOURS = float(os.environ.get("ROOM_RETENTION_HOURS", "6"))  # 超期房间清理
# 挂起（SUSPENDED）房间的保留时长：远长于普通房间，用于「改天续玩」。
# 普通/已关闭房间仍是 RETENTION_HOURS（6h）；只有 SUSPENDED 用这个更长的 TTL。
SUSPEND_RETENTION_DAYS = float(os.environ.get("ROOM_SUSPEND_RETENTION_DAYS", "30"))
# 自检房间（客户端「网络自检」试建的）保留多久。
# 正常情况房主会立刻 POST /close 干掉它；这个 TTL 只是兜底 ——
# 自检的调用方可能在关房请求发出前就退出了（用户关弹层 / App 切后台 /
# Node 探针 process.exit）。5 分钟足够覆盖一次慢速自检，又不至于在目录里留垃圾。
# 它本来就不出现在目录里（见 _api_list），所以这个 TTL 只影响「占不占房间上限」。
SELFCHECK_TTL_SEC = float(os.environ.get("ROOM_SELFCHECK_TTL", "300"))
RESERVE_TTL_SEC = float(os.environ.get("ROOM_RESERVE_TTL", "120"))    # 加入后的预留位有效期
HEARTBEAT_SEC = 25                                                    # 服务端主动 ping 间隔

# 房间号字符集：去掉 0/o/1/l/i 这些抄下来会看混的
CODE_ALPHA = "23456789abcdefghjkmnpqrstuvwxyz"

_db_lock = threading.Lock()
_rate_lock = threading.Lock()
_rate = {}          # {key: [时间戳,...]}  key 形如 "create:1.2.3.4"
_registry_lock = threading.Lock()
rooms_live = {}     # {code: Room}  Room 持有当前连接
_members = {}       # {(code, mtoken): {role, nickname}}  仅内存，进程重启即失效


def _log(msg, *args):
    sys.stderr.write("[%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg % args if args else msg))


def _now():
    return int(time.time())


# ============================================================
# v2.12.2：裸启动自动配齐（个人 / 局域网）
#
# 判定：一个 ROOM_* 环境变量都没带 = 用户直接双击 coc-room.exe（或空手跑脚本）。
# 生产部署由 systemd 显式带全套变量（ROOM_HOST/PORT/DB/PUBLIC_BASE），
# 永远不进这个分支 —— 上面的默认值一行不改，线上行为逐字节不变。
#
# 为什么值得做：桌面用户不该被一句「缺少 ROOM_PUBLIC_BASE」劝退。
# 而且服务端这个值本来只是「回报用」—— 客户端拼 WS 走的是自己进来的那条路
# （room-net.js#wsUrlFor 的注释写过这个大坑），不信任服务端推荐的 wsBase。
# ============================================================
ROOM_ENV_KEYS = ("ROOM_PUBLIC_BASE", "ROOM_HOST", "ROOM_PORT", "ROOM_DB", "ROOM_STATIC_DIR")
BARE_MODE = not any(os.environ.get(k, "").strip() for k in ROOM_ENV_KEYS)


def _self_dir():
    """程序自身所在目录：打包后的 exe 取 exe 旁，脚本运行取脚本旁。"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def _detect_lan_ip():
    """猜本机局域网 IP。UDP connect 不真发包，只是让内核替我们选源地址；
    没有可用网卡时退回 127.0.0.1（本机自测仍可用）。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        if ip and not ip.startswith("127."):
            return ip
    except Exception:
        pass
    finally:
        try:
            s.close()
        except Exception:
            pass
    try:
        ip = socket.gethostbyname(socket.gethostname())
        if ip and not ip.startswith("127."):
            return ip
    except Exception:
        pass
    return "127.0.0.1"


def _ensure_db_path(p):
    """DB 目录建不出来 / 写不进去时，退到程序旁边的 rooms.db。
    Windows 上默认的 /opt/coc-room/ 根本不存在 —— 不兜这个底，裸跑直接崩在 sqlite。"""
    try:
        d = os.path.dirname(os.path.abspath(p)) or "."
        os.makedirs(d, exist_ok=True)
        probe = os.path.join(d, ".coc-room-write-test")
        with open(probe, "w") as f:
            f.write("ok")
        os.remove(probe)
        return p
    except Exception:
        alt = os.path.join(_self_dir(), "rooms.db")
        _log("DB 路径不可用（%s），已改用：%s", p, alt)
        return alt


if BARE_MODE:
    _bare_dir = _self_dir()
    HOST = "0.0.0.0"                     # 局域网可达（生产仍是 127.0.0.1，由 systemd 显式设置）
    PORT = 8080                          # 与 coc-lan-start.bat 的默认端口一致
    DB_PATH = os.path.join(_bare_dir, "rooms.db")
    PUBLIC_BASE = "http://%s:%d" % (_detect_lan_ip(), PORT)
    if not STATIC_DIR and os.path.isfile(os.path.join(_bare_dir, "index.html")):
        STATIC_DIR = _bare_dir           # 旁边就是网页包 → 同源托管，开箱即完整局域网服
else:
    DB_PATH = _ensure_db_path(DB_PATH)

LAN_IP = _detect_lan_ip()


# ============================================================
# 限流
# ============================================================
def rate_check(key, limit, window=60):
    """滑动窗口限流。返回 (是否放行, 原因)。"""
    now = time.time()
    win = now - window
    with _rate_lock:
        q = _rate.setdefault(key, [])
        while q and q[0] < win:
            q.pop(0)
        if len(q) >= limit:
            return False, "操作太频繁，请过一会儿再试"
        q.append(now)
        if len(_rate) > 20000:      # 防止 _rate 自己变成内存泄漏
            for k in [k for k, v in _rate.items() if not v or v[-1] < win]:
                _rate.pop(k, None)
        return True, ""


# ============================================================
# 数据库
# ============================================================
def _conn():
    d = os.path.dirname(DB_PATH)
    if d:
        os.makedirs(d, exist_ok=True)
    c = sqlite3.connect(DB_PATH, timeout=10)
    c.execute("PRAGMA journal_mode=WAL")
    return c


def init_db():
    with _db_lock, _conn() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS rooms (
                code        TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                rules       TEXT NOT NULL DEFAULT 'coc7',
                kp_name     TEXT NOT NULL,
                need_pwd    INTEGER NOT NULL DEFAULT 0,
                pwd_salt    TEXT NOT NULL DEFAULT '',
                pwd_hash    TEXT NOT NULL DEFAULT '',
                max_players INTEGER NOT NULL DEFAULT 4,
                allow_spec  INTEGER NOT NULL DEFAULT 1,
                status      TEXT NOT NULL DEFAULT 'RECRUITING',
                host_token  TEXT NOT NULL,
                created_at  INTEGER NOT NULL,
                last_seen   INTEGER NOT NULL,
                -- 客户端的「网络自检」会试建房间验证链路。这类房间不出现在目录里，
                -- 且由 janitor 用更短的 TTL 回收（见 SELFCHECK_TTL_SEC）。
                selfcheck   INTEGER NOT NULL DEFAULT 0
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_seen ON rooms(last_seen DESC)")
        # v2.0.0：游戏存档表。payload 是不透明字符串，服务端只按 seq 存取、不解析内容。
        # 与 LanServer.java 的 <filesDir>/rooms/<code>.state.json 一一对应。
        c.execute("""
            CREATE TABLE IF NOT EXISTS room_state (
                code TEXT PRIMARY KEY, seq INTEGER NOT NULL,
                payload TEXT NOT NULL, updated_at INTEGER NOT NULL
            )
        """)
        # v2.0.2：设备 ↔ 座位绑定。断线重连的持久凭据 —— 即使进程重启、成员 token
        # 全失效，只要 device_id 命中本表，就能复用原 seat（见模块头「设备身份」）。
        # device_id 是凭据，**不落日志原文**；与 LanServer.java 的内存绑定同构。
        c.execute("""
            CREATE TABLE IF NOT EXISTS device_seats (
                code       TEXT NOT NULL,
                device_id  TEXT NOT NULL,
                seat       TEXT NOT NULL,
                role       TEXT NOT NULL,
                nickname   TEXT,
                created_at INTEGER,
                last_seen  INTEGER,
                PRIMARY KEY (code, device_id)
            )
        """)
        # v2.0.2：可命名存档槽（「改天凑齐人再开」用）。room_state 仍是「当前状态」单行
        # （实时续玩）；game_saves 是**可长期保留、可命名**的多槽，二者分工明确。
        c.execute("""
            CREATE TABLE IF NOT EXISTS game_saves (
                save_id    TEXT PRIMARY KEY,
                code       TEXT NOT NULL,
                name       TEXT,
                seq        INTEGER,
                payload    TEXT,
                created_at INTEGER,
                updated_at INTEGER
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_game_saves_code ON game_saves(code)")
        # 老库升级：SQLite 没有 ADD COLUMN IF NOT EXISTS，只能先试再兜底
        try:
            c.execute("ALTER TABLE rooms ADD COLUMN selfcheck INTEGER NOT NULL DEFAULT 0")
        except sqlite3.OperationalError:
            pass    # 列已存在


def hash_pwd(password, salt=None):
    salt = salt or secrets.token_hex(8)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 60000)
    return salt, base64.b64encode(dk).decode("ascii")


def verify_pwd(password, salt, expected):
    if not expected:
        return True
    _, got = hash_pwd(password or "", salt)
    return secrets.compare_digest(got, expected)


def new_code():
    return "".join(secrets.choice(CODE_ALPHA) for _ in range(CODE_LEN))


def cleanup_rooms():
    """删三类房间：
      · 普通房间：最后活跃超过 ROOM_RETENTION_HOURS
      · 挂起房间（SUSPENDED）：超过 ROOM_SUSPEND_RETENTION_DAYS（30 天）——
        挂起是为了「改天续玩」，所以 TTL 远长于普通房间；在期限内行不被清理。
      · 自检房间：超过 ROOM_SELFCHECK_TTL（几分钟），它们本来就不出现在目录里，
        也不该长期占着 MAX_ROOMS 的名额
    房间行被删后，顺带清掉它的孤儿存档（room_state）。
    """
    try:
        now = _now()
        cutoff = now - int(RETENTION_HOURS * 3600)
        suspend_cutoff = now - int(SUSPEND_RETENTION_DAYS * 86400)
        sc_cutoff = now - int(SELFCHECK_TTL_SEC)
        with _db_lock, _conn() as c:
            cur = c.execute(
                "DELETE FROM rooms WHERE "
                "  (status='SUSPENDED' AND last_seen < ?) "
                "  OR (status!='SUSPENDED' AND last_seen < ?) "
                "  OR (selfcheck=1 AND last_seen < ?)",
                (suspend_cutoff, cutoff, sc_cutoff))
            n = cur.rowcount or 0
            # 清掉已不存在的房间残留的存档 / 设备绑定 / 命名存档，避免无界增长
            c.execute("DELETE FROM room_state WHERE code NOT IN (SELECT code FROM rooms)")
            c.execute("DELETE FROM device_seats WHERE code NOT IN (SELECT code FROM rooms)")
            c.execute("DELETE FROM game_saves WHERE code NOT IN (SELECT code FROM rooms)")
        if n:
            _log("清理超期房间 %d 个", n)
        return n
    except Exception as e:
        _log("清理失败：%s", e)
        return 0


def janitor(stop_event):
    """后台线程：过期预留位每 60 秒回收一次，超期房间每 5 分钟清一次。

    ⚠️ 房间清理从「每 30 分钟」加快到「每 5 分钟」，是因为自检房间的 TTL 是 5 分钟 ——
    清理周期必须 ≤ TTL，否则一个自检房间最长能活 35 分钟才被扫到。
    """
    tick = 0
    while not stop_event.wait(60):
        tick += 1
        with _registry_lock:
            snapshot = list(rooms_live.values())
        for r in snapshot:
            try:
                r.expire_pending()
            except Exception as e:
                _log("回收预留位失败：%s", e)
        if tick % 5 == 0:
            cleanup_rooms()


def empty_counts():
    """房间还没有活连接时的占位统计。字段必须与 Room.counts() 完全一致，
    否则「目录显示的」和「准入判定的」会用两套口径。"""
    return {"players": 0, "spectators": 0, "livePlayers": 0, "liveSpectators": 0,
            "pending": 0, "hasHost": False}


def touch_room(code):
    try:
        with _db_lock, _conn() as c:
            c.execute("UPDATE rooms SET last_seen=? WHERE code=?", (_now(), code))
    except Exception:
        pass


def get_room_row(code):
    with _db_lock, _conn() as c:
        return c.execute(
            "SELECT code,name,rules,kp_name,need_pwd,pwd_salt,pwd_hash,max_players,"
            "allow_spec,status,host_token,created_at,last_seen FROM rooms WHERE code=?",
            (code,)).fetchone()


def row_to_meta(row):
    """对外可见的房间元信息。**绝不包含 pwd_salt / pwd_hash / host_token**。"""
    if not row:
        return None
    return {
        "code": row[0], "name": row[1], "rules": row[2], "kpName": row[3],
        "needPwd": bool(row[4]),
        "maxPlayers": row[7], "allowSpectate": bool(row[8]),
        "status": row[9], "createdAt": row[11], "lastSeen": row[12],
    }


# ============================================================
# 游戏存档（v2.0.0）—— 不透明存取，服务端不解析 payload
# ============================================================
def get_state_row(code):
    """读一条存档行 (code, seq, payload, updated_at)；没有则 None。"""
    with _db_lock, _conn() as c:
        return c.execute(
            "SELECT code,seq,payload,updated_at FROM room_state WHERE code=?",
            (code,)).fetchone()


def put_state(code, seq, payload):
    """幂等写入存档：**仅当 seq 大于已存 seq 时才覆盖**。

    返回 (stored_seq, saved_at, stale)：
      · 覆盖成功 → (新 seq, 新时间, False)
      · seq 不够大 → (已存 seq, 已存时间, True)，且**不覆盖**
    """
    now = _now()
    with _db_lock, _conn() as c:
        row = c.execute("SELECT seq,updated_at FROM room_state WHERE code=?",
                        (code,)).fetchone()
        cur_seq = row[0] if row else -1
        cur_at = row[1] if row else 0
        if seq <= cur_seq:
            return cur_seq, cur_at, True
        c.execute(
            "INSERT OR REPLACE INTO room_state(code,seq,payload,updated_at) VALUES(?,?,?,?)",
            (code, seq, payload, now))
        return seq, now, False


# ============================================================
# 设备 ↔ 座位绑定（v2.0.2）—— 断线重连的持久凭据
# ============================================================
def clean_device_id(v):
    """规整客户端上报的设备标识。device_id 是**凭据**：只过滤控制字符并截断，
    绝不在日志里回显原文（见 _log 调用点）。空串表示「无设备码」（老客户端/降级）。"""
    s = clean_text(v, 80)
    return s


def get_device_seat(code, device_id):
    """查 (code, device_id) 绑定。返回 (seat, role, nickname) 或 None。

    ⚠️ 用等值查询定位，不做前缀/模糊匹配 —— 杜绝「用一个 device_id 探到别人的座位」。
    """
    if not code or not device_id:
        return None
    with _db_lock, _conn() as c:
        return c.execute(
            "SELECT seat,role,nickname FROM device_seats WHERE code=? AND device_id=?",
            (code, device_id)).fetchone()


def upsert_device_seat(code, device_id, seat, role, nickname):
    """写入/刷新一条设备绑定。created_at 首次写入后保持不变（重连不刷新）。"""
    if not code or not device_id:
        return False
    now = _now()
    with _db_lock, _conn() as c:
        row = c.execute(
            "SELECT created_at FROM device_seats WHERE code=? AND device_id=?",
            (code, device_id)).fetchone()
        created = row[0] if row else now
        c.execute(
            "INSERT OR REPLACE INTO device_seats"
            "(code,device_id,seat,role,nickname,created_at,last_seen) VALUES(?,?,?,?,?,?,?)",
            (code, device_id, seat, role, nickname, created, now))
    return True


def touch_device_seat(code, device_id):
    """刷新 last_seen（重连成功时调用）。失败静默 —— 绑定只是增强，刷不动不影响连接。"""
    if not code or not device_id:
        return
    try:
        with _db_lock, _conn() as c:
            c.execute("UPDATE device_seats SET last_seen=? WHERE code=? AND device_id=?",
                      (_now(), code, device_id))
    except Exception:
        pass


def delete_device_seat(code, device_id):
    """删除一条设备绑定（/unbind 用）。只按「调用者出示的 device_id」删自己那一行。"""
    if not code or not device_id:
        return False
    with _db_lock, _conn() as c:
        cur = c.execute("DELETE FROM device_seats WHERE code=? AND device_id=?",
                        (code, device_id))
        return (cur.rowcount or 0) > 0


# ============================================================
# 可命名存档槽（v2.0.2）—— game_saves
# ============================================================
def new_save_id():
    """存档槽 id：sv + 16 位随机（URL 安全，不含 '/'，便于放进路径）。"""
    return "sv" + secrets.token_hex(8)


def list_saves(code):
    """列出某房间的全部存档槽（按更新时间倒序）。返回 [(save_id,name,seq,updated_at), ...]。"""
    with _db_lock, _conn() as c:
        return c.execute(
            "SELECT save_id,name,seq,updated_at FROM game_saves WHERE code=? "
            "ORDER BY updated_at DESC", (code,)).fetchall()


def create_save(code, name):
    """用当前 room_state 快照建一个命名存档槽。无 room_state → seq=0 / payload=''。"""
    st = get_state_row(code)
    seq = st[1] if st else 0
    payload = st[2] if st else ""
    save_id = new_save_id()
    now = _now()
    with _db_lock, _conn() as c:
        c.execute(
            "INSERT INTO game_saves(save_id,code,name,seq,payload,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,?)",
            (save_id, code, name, seq, payload, now, now))
    return save_id, seq, now


def get_save(code, save_id):
    """读一个存档槽。返回 (save_id,code,name,seq,payload,updated_at) 或 None。"""
    if not code or not save_id:
        return None
    with _db_lock, _conn() as c:
        return c.execute(
            "SELECT save_id,code,name,seq,payload,updated_at FROM game_saves "
            "WHERE code=? AND save_id=?", (code, save_id)).fetchone()


def load_save(code, save_id):
    """把某存档槽**载入为当前状态**：room_state ← 存档；返回 (seq, payload) 或 None。

    ⚠️ 这里直接覆盖 room_state（含更小 seq 的存档也能载入）—— 这是「读档」的语义，
    与 put_state 的「幂等防倒退」不同：用户主动选了一个旧存档，就该回到那个点。
    """
    row = get_save(code, save_id)
    if not row:
        return None
    seq = row[3] if row[3] is not None else 0
    payload = row[4] if row[4] is not None else ""
    now = _now()
    with _db_lock, _conn() as c:
        c.execute(
            "INSERT OR REPLACE INTO room_state(code,seq,payload,updated_at) VALUES(?,?,?,?)",
            (code, seq, payload, now))
    return seq, payload


def delete_save(code, save_id):
    if not code or not save_id:
        return False
    with _db_lock, _conn() as c:
        cur = c.execute("DELETE FROM game_saves WHERE code=? AND save_id=?", (code, save_id))
        return (cur.rowcount or 0) > 0


# ============================================================
# WebSocket 帧编解码（标准库手写）
# ============================================================
OP_CONT, OP_TEXT, OP_BIN, OP_CLOSE, OP_PING, OP_PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

"""关闭状态码。

RFC 6455 §5.5.1：关闭帧的**前两个字节必须是状态码**，原因文本跟在后面。
早期版本只把原因文本塞进载荷（没有状态码），浏览器就会拿原因的头两个字节
当状态码 —— 一个中文原因的前两字节是 0xE6 0x88 之类，解出来是个非法码，
控制台报错、客户端也分不清「该重连」还是「已经被拒了」。

这里用 4000+ 段表示「重连也没用」的业务原因（RFC 允许私有使用 4000–4999），
room-net.js 的 connect() 正是按 `code === 1000 || code >= 4000` 判终止的。
"""
CLOSE_NORMAL = 1000     # 正常关闭（客户端自己点了离开）
CLOSE_TAKEOVER = 4001   # 同一个座位在别处重新连接
CLOSE_REJECT = 4002     # 准入被拒（满了 / 不允许旁观 / 房间已关闭）
CLOSE_TIMEOUT = 4003    # 心跳超时
CLOSE_KICKED = 4004     # 被房主移出


class WSError(Exception):
    pass


def ws_accept_key(key):
    return base64.b64encode(hashlib.sha1((key + WS_GUID).encode("ascii")).digest()).decode("ascii")


def _recv_exact(sock, n, conn=None):
    """读满 n 字节。

    ⚠️ 为什么要在 recv 之前 select 轮询（而不是给 socket 设 timeout）：
      服务端要能「主动踢掉一条空闲连接」（重连接管、房主踢人、心跳失败）。
      阻塞在 recv 上的线程是叫不醒的 —— 实测本机 Windows/CPython 上
      shutdown(SHUT_RDWR) 也**不会**让 recv 返回（Linux 才有效），
      于是老连接会永远留在房间名单里（人数虚高、权威端收不到 peer.close）。
      而给 socket 设 settimeout 会引入更坏的问题：**超时会丢掉已收到的半帧**，
      弱网下一帧被拆成两段就整帧损坏。
      所以保留阻塞式 recv，只在前面加 select 探活：有数据才 recv，
      没有就每 0.5 秒回头看一眼 conn.closed，既丢不掉数据也能及时退出。
    """
    buf = b""
    while len(buf) < n:
        if conn is not None:
            if conn.closed:
                raise WSError("连接已被服务端关闭")
            try:
                ready, _, _ = select.select([sock], [], [], 0.5)
            except Exception:
                raise WSError("连接已失效")
            if not ready:
                continue
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise WSError("连接已关闭")
        buf += chunk
    return buf


def ws_read_frame(sock, max_len=MAX_FRAME, conn=None):
    """读一帧。客户端发来的帧**必须**带掩码（RFC 6455 §5.1）。"""
    hdr = _recv_exact(sock, 2, conn)
    b0, b1 = hdr[0], hdr[1]
    fin = b0 & 0x80
    opcode = b0 & 0x0F
    masked = b1 & 0x80
    length = b1 & 0x7F
    if length == 126:
        length = struct.unpack(">H", _recv_exact(sock, 2, conn))[0]
    elif length == 127:
        length = struct.unpack(">Q", _recv_exact(sock, 8, conn))[0]
    if length > max_len:
        raise WSError("单帧超过上限 %d 字节" % max_len)
    if not masked:
        raise WSError("客户端帧未加掩码")
    mask = _recv_exact(sock, 4, conn)
    payload = bytearray(_recv_exact(sock, length, conn)) if length else bytearray()
    for i in range(length):
        payload[i] ^= mask[i & 3]
    return fin, opcode, bytes(payload)


def ws_write_frame(sock, payload, opcode=OP_TEXT, lock=None):
    """写一帧。服务端 → 客户端**不加掩码**。"""
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    n = len(payload)
    head = bytearray([0x80 | opcode])
    if n < 126:
        head.append(n)
    elif n < 65536:
        head.append(126)
        head += struct.pack(">H", n)
    else:
        head.append(127)
        head += struct.pack(">Q", n)
    data = bytes(head) + payload
    if lock:
        with lock:
            sock.sendall(data)
    else:
        sock.sendall(data)


# ============================================================
# 连接与房间
# ============================================================
class Conn(object):
    """一条已升级的 WebSocket 连接。cid 是权威端（KP）看到的成员句柄。

    ⚠️ cid 不能当身份用：每次连接都会重新生成，刷新一次页面权威端就多出
    「一个新人」，准备状态、角色卡绑定、行动顺序全丢。身份用 **seat**：
    由成员凭据（mtoken）派生，断线重连后保持不变；权威端以 seat 认座位，
    把 cid 当「往哪儿发」的路由地址（需求 §14 断线重连）。
    """

    def __init__(self, sock, addr, code, role, nickname, mtoken="", ip="", device_id=""):
        self.sock = sock
        self.addr = addr
        self.ip = ip or (addr[0] if addr else "?")
        self.code = code
        self.role = role              # 'kp' | 'player' | 'spectator'
        self.nickname = nickname or ""
        self.cid = "c" + secrets.token_hex(5)
        self.mtoken = mtoken or ""
        self.device_id = device_id or ""
        if role == "kp":
            self.seat = "host"
        else:
            # v2.0.2：座位 basis 改为「设备优先」——有稳定设备码就用它派生 seat
            # （换机/重装/服务重启后仍恒定），没有则退回旧行为（用 mtoken 派生）。
            # 只发摘要，不回传凭据本身；同一 (房间, basis) 恒定。
            basis = self.device_id if self.device_id else self.mtoken
            self.seat = hashlib.sha256(
                (code + ":" + basis).encode("utf-8")).hexdigest()[:12]
        self.lock = threading.Lock()
        self.closed = False
        self.msg_times = []
        self.join_at = _now()

    def send_text(self, text):
        if self.closed:
            return False
        try:
            ws_write_frame(self.sock, text, OP_TEXT, self.lock)
            return True
        except Exception:
            self.closed = True
            return False

    def send_close(self, code=CLOSE_NORMAL, reason=""):
        """发关闭帧：**先 2 字节状态码，再原因文本**（见 CLOSE_* 的注释）。"""
        if self.closed:
            return
        try:
            payload = struct.pack(">H", int(code)) + (reason or "").encode("utf-8")[:120]
            ws_write_frame(self.sock, payload, OP_CLOSE, self.lock)
        except Exception:
            pass
        self.closed = True

    def kick(self, code=CLOSE_REJECT, reason=""):
        """服务端主动断开一条连接（踢人 / 重连接管 / 心跳失败）。

        只负责「打招呼 + 标记」：发一个 CLOSE 帧让对端知道原因，
        再 shutdown 通知对端，然后由拥有该 socket 的读循环自己收尾关闭
        （_recv_exact 每 0.5 秒回头检查 closed 标志，见那里的注释）。
        这里**不**直接 close()：从别的线程 close 一个正在 recv 的 socket
        在 Windows 上是未定义行为，交给读循环收更安全。
        """
        self.send_close(code, reason)
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except Exception:
            pass

    def close_socket(self):
        """只由读循环（或没有读循环时）调用。"""
        try:
            self.sock.close()
        except Exception:
            pass

    def rate_ok(self):
        now = time.time()
        self.msg_times = [t for t in self.msg_times if t > now - 60]
        if len(self.msg_times) >= RATE_MSGS:
            return False
        self.msg_times.append(now)
        return True


class Room(object):
    """服务端侧的房间视图：只有元信息 + 当前连接。游戏状态不在这里。

    ⚠️ 为什么要有 pending（预留位）：
      名额校验如果只看「已经连上 WebSocket 的人」，那 HTTP 加入阶段全员都是 0，
      三个人提交 join 会全部返回成功 —— 玩家到 WS 那一步才被踢，界面上就是
      「显示能进、点了没反应」（需求 §2.3 明确禁止）。
      所以 join 成功即**原子地占掉一个位子**，连接上之后才转为正式成员；
      一直不连的预留位由 janitor 过期回收（连不上的人不能永久占坑）。
    """

    def __init__(self, code):
        self.code = code
        self.host = None                  # Conn
        self.players = {}                 # {cid: Conn}
        self.spectators = {}              # {cid: Conn}
        self.pending = {}                 # {mtoken: {"role":.., "at":ts}}
        self.lock = threading.RLock()

    # ---------- 预留位 ----------
    def expire_pending(self, ttl=RESERVE_TTL_SEC, now=None):
        now = now or time.time()
        with self.lock:
            for k in [k for k, v in self.pending.items() if now - v["at"] > ttl]:
                self.pending.pop(k, None)

    def _pending_counts(self):
        p = s = 0
        for v in self.pending.values():
            if v["role"] == "spectator":
                s += 1
            else:
                p += 1
        return p, s

    def counts(self):
        """占位统计。players/spectators **含预留位** —— 目录与准入都用它，
        免得「目录显示 2/2 但还能点进去」。livePlayers 单独给需要真实在线数的场景。"""
        with self.lock:
            pp, ps = self._pending_counts()
            return {
                "players": len(self.players) + pp,
                "spectators": len(self.spectators) + ps,
                "livePlayers": len(self.players),
                "liveSpectators": len(self.spectators),
                "pending": pp + ps,
                "hasHost": self.host is not None,
            }

    def reserve(self, mtoken, role, row):
        """准入判定 + 占位，**同一把锁内完成**。并发下不会超卖。"""
        with self.lock:
            counts = self.counts()
            can, reason, message = join_allowed(row, counts, role)
            if can:
                self.pending[mtoken] = {"role": role, "at": time.time()}
            return can, reason, message

    def consume(self, mtoken):
        """连接建立时把预留位转正；返回预留信息（None 表示不是有效预留）。"""
        with self.lock:
            return self.pending.pop(mtoken, None)

    # ---------- 连接 ----------
    def to_host(self, obj):
        if self.host:
            self.host.send_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))

    def add(self, conn):
        with self.lock:
            if conn.role == "kp":
                self.host = conn
            elif conn.role == "spectator":
                self.spectators[conn.cid] = conn
            else:
                self.players[conn.cid] = conn

    def remove(self, conn):
        with self.lock:
            if self.host is conn:
                self.host = None
            self.players.pop(conn.cid, None)
            self.spectators.pop(conn.cid, None)

    def find(self, cid):
        with self.lock:
            return self.players.get(cid) or self.spectators.get(cid)

    def find_by_token(self, mtoken):
        """按成员凭据找当前活连接。重连时用它判断「是接管老连接」还是「占新位子」。"""
        if not mtoken:
            return None
        with self.lock:
            for c in list(self.players.values()) + list(self.spectators.values()):
                if c.mtoken == mtoken:
                    return c
        return None

    def find_by_seat(self, seat):
        """按座位找当前活连接（v2.0.2）。设备码通道下 mtoken 可能已换，但 seat 不变 ——
        用它接管老连接（同一台设备重连）。"""
        if not seat or seat == "host":
            return None
        with self.lock:
            for c in list(self.players.values()) + list(self.spectators.values()):
                if c.seat == seat:
                    return c
        return None


def live_room(code):
    with _registry_lock:
        return rooms_live.get(code)


def ensure_live_room(code):
    with _registry_lock:
        r = rooms_live.get(code)
        if r is None:
            r = Room(code)
            rooms_live[code] = r
        return r


# ============================================================
# HTTP / WS 处理
# ============================================================
class Handler(BaseHTTPRequestHandler):
    server_version = "coc-room/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        _log(fmt, *args)

    # ---------- 基础 ----------
    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # 车卡器跑在 WebView 里（appassets.androidplatform.net），属于跨域，必须放行
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("X-Robots-Tag", "noindex, nofollow")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False))

    def _serve_static(self, path):
        """局域网一体服：从 STATIC_DIR 分发静态文件；未知路径回退 index.html（SPA）。
        带目录穿越防护。仅在 STATIC_DIR 非空时被调用。"""
        root = os.path.normpath(STATIC_DIR)
        rel = path.lstrip("/") or "index.html"
        full = os.path.normpath(os.path.join(root, rel))
        if full != root and not full.startswith(root + os.sep):
            return self._json(403, {"error": "forbidden"})
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        if not os.path.isfile(full):
            full = os.path.join(root, "index.html")   # SPA 回退
            if not os.path.isfile(full):
                return self._json(404, {"error": "not found"})
        try:
            with open(full, "rb") as f:
                data = f.read()
        except OSError:
            return self._json(404, {"error": "not found"})
        ctype = _STATIC_TYPES.get(os.path.splitext(full)[1].lower(),
                                  "application/octet-stream")
        self._send(200, data, ctype)

    def _read_body(self):
        return self._read_body_max(MAX_HTTP_BODY)

    def _read_body_max(self, max_n):
        """读请求体。n<=0 视为空对象；n 超过 max_n 返回 None（调用方决定错误码）。
        存档端点的请求体远大于房间元数据，故单独给一个更大的上限。"""
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if n <= 0:
            return {}
        if n > max_n:
            return None
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return None

    def client_ip(self):
        """只监听 127.0.0.1，这些头由前置 nginx / cloudflared 覆盖写入，外部无法伪造。"""
        for k in ("CF-Connecting-IP", "X-Real-IP", "X-Forwarded-For"):
            v = self.headers.get(k)
            if v:
                return v.split(",")[0].strip()[:45]
        return (self.client_address[0] if self.client_address else "?")[:45]

    def do_OPTIONS(self):
        self._send(204, b"")

    # ---------- 路由 ----------
    def do_GET(self):
        u = urlparse(self.path)
        path = u.path
        if path == "/health":
            with _registry_lock:
                n_live = len(rooms_live)
            return self._json(200, {"ok": True, "service": "coc-room", "time": _now(),
                                    "liveRooms": n_live})
        if path == "/api/rooms":
            return self._api_list()
        # v2.0.0：读取游戏存档（需 hostToken 或任一有效成员 mtoken/deviceId）
        m = re.fullmatch(r"/api/rooms/([a-z0-9]{4,12})/state", path)
        if m:
            return self._api_get_state(m.group(1), parse_qs(u.query))
        # v2.0.2：可命名存档槽 —— 列表 / 读取
        m = re.fullmatch(r"/api/rooms/([a-z0-9]{4,12})/saves", path)
        if m:
            return self._api_save_list(m.group(1), parse_qs(u.query))
        m = re.fullmatch(r"/api/rooms/([a-z0-9]{4,12})/saves/([A-Za-z0-9_-]{4,40})", path)
        if m:
            return self._api_save_get(m.group(1), m.group(2), parse_qs(u.query))
        if path == "/ws":
            return self._ws(u)

        # ★ 关键：WS 握手必须在 BaseHTTPRequestHandler 的正常流程里完成，
        #   之后再自己接管这个 socket。这里先读原始请求行/头。
        # v2.11.8（局域网一体服）：设了 ROOM_STATIC_DIR 就顺带托管网页，
        #   朋友打开 http://<局域网IP>:端口/ 即玩（同源、无混合内容、不走外网）；
        #   公网纯中继部署不设它 → 走下面原逻辑，行为一行不变。
        if STATIC_DIR:
            return self._serve_static(path)
        if path in ("/", "/index.html"):
            return self._send(200, "coc-room is running. This is a WebSocket relay.\n",
                              "text/plain; charset=utf-8")
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/rooms":
            return self._api_create()
        m = re.fullmatch(r"/api/rooms/([a-z0-9]{4,12})/probe", path)
        if m:
            return self._api_probe(m.group(1))
        m = re.fullmatch(r"/api/rooms/([a-z0-9]{4,12})/join", path)
        if m:
            return self._api_join(m.group(1))
        m = re.fullmatch(r"/api/rooms/([a-z0-9]{4,12})/close", path)
        if m:
            return self._api_close(m.group(1))
        # v2.0.0 新增：存档写入 / 挂起 / 续玩
        m = re.fullmatch(r"/api/rooms/([a-z0-9]{4,12})/state", path)
        if m:
            return self._api_put_state(m.group(1))
        m = re.fullmatch(r"/api/rooms/([a-z0-9]{4,12})/suspend", path)
        if m:
            return self._api_suspend(m.group(1))
        m = re.fullmatch(r"/api/rooms/([a-z0-9]{4,12})/resume", path)
        if m:
            return self._api_resume(m.group(1))
        # v2.0.2 新增：解绑本机设备身份 / 可命名存档槽（建、载入）
        m = re.fullmatch(r"/api/rooms/([a-z0-9]{4,12})/unbind", path)
        if m:
            return self._api_unbind(m.group(1))
        m = re.fullmatch(r"/api/rooms/([a-z0-9]{4,12})/saves", path)
        if m:
            return self._api_save_create(m.group(1))
        m = re.fullmatch(r"/api/rooms/([a-z0-9]{4,12})/saves/([A-Za-z0-9_-]{4,40})/load", path)
        if m:
            return self._api_save_load(m.group(1), m.group(2))
        return self._json(404, {"error": "not found"})

    def do_DELETE(self):
        """v2.0.2：删除可命名存档槽（需 hostToken）。"""
        path = urlparse(self.path).path
        m = re.fullmatch(r"/api/rooms/([a-z0-9]{4,12})/saves/([A-Za-z0-9_-]{4,40})", path)
        if m:
            return self._api_save_delete(m.group(1), m.group(2))
        return self._json(404, {"error": "not found"})

    # ---------- 房间目录 ----------
    def _api_list(self):
        """房间目录。只返回当前有效的房间，且只含公开元信息（无密码散列、无 token）。

        ⚠️ 自检房间（selfcheck=1）**不进目录**：那是客户端验证链路用的空房间，
        不是给人进的。它们由 janitor 按 SELFCHECK_TTL_SEC 单独回收。
        """
        with _registry_lock:
            live = {c: r.counts() for c, r in rooms_live.items()}
        try:
            with _db_lock, _conn() as c:
                rows = c.execute(
                    "SELECT code,name,rules,kp_name,need_pwd,pwd_salt,pwd_hash,max_players,"
                    "allow_spec,status,host_token,created_at,last_seen "
                    "FROM rooms WHERE status!='CLOSED' AND status!='SUSPENDED' AND selfcheck=0 "
                    "ORDER BY created_at DESC LIMIT 100").fetchall()
        except Exception as e:
            _log("目录查询失败：%s", e)
            return self._json(500, {"error": "目录暂时不可用"})

        out = []
        for row in rows:
            meta = row_to_meta(row)
            st = live.get(row[0]) or empty_counts()
            meta.update({"players": st["players"], "spectators": st["spectators"],
                         "online": st["hasHost"]})
            out.append(meta)
        return self._json(200, {"ok": True, "rooms": out, "serverTime": _now()})

    def _api_create(self):
        ip = self.client_ip()
        ok, why = rate_check("create:" + ip, RATE_CREATE_IP)
        if not ok:
            return self._json(429, {"error": why})
        ok, why = rate_check("create:*", RATE_CREATE_GLOBAL)
        if not ok:
            return self._json(429, {"error": why})

        req = self._read_body()
        if req is None:
            return self._json(413, {"error": "请求体过大或不是合法 JSON"})

        name = clean_text(req.get("name"), 40)
        if not name:
            return self._json(400, {"error": "房间名不能为空"})
        kp = clean_text(req.get("kpName"), 24)
        if not kp:
            return self._json(400, {"error": "KP 昵称不能为空"})
        rules = req.get("rules") or "coc7"
        if rules != "coc7":
            # 本期只开放 CoC 7e（需求 §1「本期暂不实现」）
            return self._json(400, {"error": "本期只支持 COC 第七版"})
        try:
            max_players = int(req.get("maxPlayers") or 4)
        except (TypeError, ValueError):
            return self._json(400, {"error": "玩家上限必须是数字"})
        max_players = max(1, min(MAX_PLAYERS_HARD, max_players))
        allow_spec = bool(req.get("allowSpectate", True))
        password = req.get("password") or ""

        with _db_lock, _conn() as c:
            n = c.execute("SELECT COUNT(*) FROM rooms WHERE status!='CLOSED'").fetchone()[0]
        if n >= MAX_ROOMS:
            return self._json(507, {"error": "服务器上的房间数已达上限（%d），请稍后再试" % MAX_ROOMS})

        salt, ph = (hash_pwd(password) if password else ("", ""))
        host_token = secrets.token_urlsafe(24)
        now = _now()
        # 客户端「网络自检」会试建一个房间来验通链路。它有两个特点：
        #   ① 建完就该消失 —— 房主随后会 POST /close，但也可能关不掉
        #      （自检的调用方可能在请求发出前就退出：用户关弹层、App 切后台、
        #       Node 探针 process.exit），于是房间卡在 RECRUITING 6 小时。
        #   ② 它**不该**出现在玩家的房间目录里 —— 那不是给人进的房间。
        # 所以：标成 selfcheck，既不出现在目录，也被 janitor 用更短的 TTL 回收。
        selfcheck = 1 if req.get("_selfcheck") else 0
        with _db_lock, _conn() as c:
            for _ in range(10):
                code = new_code()
                try:
                    c.execute(
                        "INSERT INTO rooms(code,name,rules,kp_name,need_pwd,pwd_salt,pwd_hash,"
                        "max_players,allow_spec,status,host_token,created_at,last_seen,selfcheck) "
                        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (code, name, rules, kp, 1 if password else 0, salt, ph,
                         max_players, 1 if allow_spec else 0, "RECRUITING", host_token, now, now,
                         selfcheck))
                    break
                except sqlite3.IntegrityError:
                    continue
            else:
                return self._json(500, {"error": "生成房间号失败，请重试"})

        self.log_message("room created code=%s kp=%s ip=%s", code, kp, ip)
        return self._json(200, {"ok": True, "code": code, "hostToken": host_token,
                                "wsBase": ws_base(), "meta": row_to_meta(get_room_row(code))})

    def _api_probe(self, code):
        """加入前预检。**不需要密码**也能问「房间在不在、什么状态、满没满」，
        这样列表里就能把「不可加入」的原因直接显示出来，而不是点了才失败（需求 §2.3）。"""
        ip = self.client_ip()
        ok, why = rate_check("join:" + ip, RATE_JOIN_IP)
        if not ok:
            return self._json(429, {"error": why})

        req = self._read_body()
        if req is None:
            return self._json(413, {"error": "请求体过大"})
        role = req.get("role") or "player"
        # v2.1.1：预检也带机器码 → 客户端在点「加入」之前就能知道是「正在重连…」还是「加入中…」。
        device_id = clean_device_id(req.get("deviceId"))
        row = get_room_row(code)
        if not row:
            return self._json(404, {"ok": False, "reason": "ROOM_NOT_FOUND", "message": "房间不存在或已过期"})
        meta = row_to_meta(row)
        live = live_room(code)
        if live:
            live.expire_pending()
        counts = live.counts() if live else empty_counts()

        can, reason, message = join_allowed(row, counts, role)
        # v2.1.1：本机是本房老玩家（机器码命中绑定）→ 回座**不受名额已满影响**，
        # 与 /join 的绑定分支口径一致；否则列表会给老玩家假「已满」而进不去。
        bound = get_device_seat(code, device_id) if device_id else None
        if bound and role == "player" and not can and reason == "PLAYER_FULL":
            can, reason, message = True, "", ""
        out = dict(meta)
        out.update({"ok": can, "reason": reason, "message": message,
                    "joinKind": join_kind(bound),
                    "players": counts["players"], "spectators": counts["spectators"],
                    "online": counts["hasHost"]})
        return self._json(200, out)

    def _api_join(self, code):
        ip = self.client_ip()
        ok, why = rate_check("join:" + ip, RATE_JOIN_IP)
        if not ok:
            return self._json(429, {"error": why})

        req = self._read_body()
        if req is None:
            return self._json(413, {"error": "请求体过大"})
        role = req.get("role") or "player"
        nickname = clean_text(req.get("nickname"), 24)
        if not nickname:
            return self._json(400, {"error": "昵称不能为空"})
        device_id = clean_device_id(req.get("deviceId"))

        row = get_room_row(code)
        if not row:
            return self._json(404, {"ok": False, "reason": "ROOM_NOT_FOUND", "message": "房间不存在或已过期"})
        # 挂起的房间只有房主 resume 之后才能加入（与 LanServer 同名同码 room_suspended）
        if row[9] == "SUSPENDED":
            return self._json(403, {"ok": False, "error": "room_suspended"})
        meta = row_to_meta(row)
        room = ensure_live_room(code)
        room.expire_pending()

        mtoken = secrets.token_urlsafe(18)
        # v2.0.2：设备码派生 seat（无设备码则退回 mtoken 派生，老客户端不退化）
        basis = device_id if device_id else mtoken
        seat = hashlib.sha256((code + ":" + basis).encode("utf-8")).hexdigest()[:12]

        # ⚠️ 密码校验必须在服务端做。房间号只用于定位房间，不等于身份验证（需求 §2.2）。
        if row[4]:
            if not verify_pwd(str(req.get("password") or ""), row[5], row[6]):
                self.log_message("join rejected (bad password) code=%s ip=%s", code, ip)
                return self._json(403, {"ok": False, "reason": "BAD_PASSWORD", "message": "房间密码不正确"})

        # v2.0.2：先看这台设备在本房有没有绑定 —— 命中即「真重连」。
        binding = get_device_seat(code, device_id) if device_id else None
        # v2.1.1（用户要求）：机器码判定这次是「重连」还是「新加入」，回给客户端做提示。
        kind = join_kind(binding)
        if binding:
            # 复用绑定的 role（设备即身份）；刷新昵称/last_seen。**不再占新名额** ——
            # 否则进行中的团会被 join_allowed 的 ALREADY_STARTED 挡掉，重连就回不去。
            role = binding[1] or role
            nickname = nickname or (binding[2] or "")
            upsert_device_seat(code, device_id, binding[0], role, nickname)
        else:
            # 准入判定 + 占位在同一把锁里完成（并发下不会超卖）
            can, reason, message = room.reserve(mtoken, role, row)
            if not can:
                return self._json(403, {"ok": False, "reason": reason, "message": message})
            if device_id:
                upsert_device_seat(code, device_id, seat, role, nickname)

        with _registry_lock:
            _members[(code, mtoken)] = {"role": role, "nickname": nickname, "cid": None,
                                        "at": time.time()}
            # 成员 token 只在内存里，顺手防止它自己变成内存泄漏
            if len(_members) > 20000:
                for k in [k for k in list(_members.keys()) if k[0] not in rooms_live][:10000]:
                    _members.pop(k, None)
        self.log_message("join ok code=%s role=%s nick=%s ip=%s", code, role, nickname, ip)
        # ⚠️ 必须回 code：客户端要用它拼路由（#/room/<code>）。
        #    曾漏掉这个字段，客户端拿 res.code 拼出 "#/room/undefined"，
        #    路由判成「没加入这个房间」把会话清掉 —— 而 WebSocket 还是通着的，
        #    于是表现为「房主能看到人，玩家自己却停在加入界面」。接口该自描述。
        return self._json(200, {"ok": True, "code": code, "mtoken": mtoken, "role": role,
                                "seat": seat,
                                # v2.1.1（用户要求）：机器码判定 → 'reconnect' | 'new'。
                                # 只在「这台设备在本房有没有绑定」上有区别，两种情况都可进。
                                "joinKind": kind,
                                # v2.0.2：join 请求体已带 deviceId → 透传进 wsUrl（&d=<deviceId>）。
                                # 这是协议里最后一个裸 t= 字段，补上以防将来有调用方直接信任它。
                                "wsUrl": ws_base() + "/ws?code=%s&t=%s%s" % (
                                    code, mtoken,
                                    ("&d=" + quote(device_id, safe="") if device_id else "")),
                                "counts": room.counts(), "meta": meta})

    def _api_close(self, code):
        req = self._read_body() or {}
        row = get_room_row(code)
        if not row:
            return self._json(404, {"error": "房间不存在"})
        if not secrets.compare_digest(row[10], str(req.get("hostToken") or "")):
            return self._json(403, {"error": "只有房主可以关闭房间"})
        with _db_lock, _conn() as c:
            c.execute("UPDATE rooms SET status='CLOSED', last_seen=? WHERE code=?", (_now(), code))
        _log("房间 %s 被房主关闭", code)
        return self._json(200, {"ok": True, "code": code})

    # ---------- 游戏存档 / 挂起 / 续玩（v2.0.0）----------
    def _api_put_state(self, code):
        """写入游戏存档。需 hostToken；payload 不透明、不解析；seq 单调递增才覆盖。"""
        req = self._read_body_max(MAX_STATE_BODY)
        if req is None:
            # 请求体超过 MAX_STATE_BODY（或不是合法 JSON）—— 统一按 too_large 处理
            return self._json(413, {"ok": False, "error": "too_large"})
        row = get_room_row(code)
        if not row:
            return self._json(404, {"ok": False, "error": "not_found"})
        if not secrets.compare_digest(row[10], str(req.get("hostToken") or "")):
            return self._json(403, {"ok": False, "error": "bad_token"})
        try:
            seq = int(req.get("seq"))
        except (TypeError, ValueError):
            return self._json(400, {"ok": False, "error": "bad_request"})
        payload = req.get("payload")
        if payload is None:
            payload = ""
        if not isinstance(payload, str):
            return self._json(400, {"ok": False, "error": "bad_request"})
        # 上限按 payload 的 UTF-8 字节数计（不是字符数）—— 中文存档按字节算才准
        if len(payload.encode("utf-8")) > MAX_STATE_BYTES:
            return self._json(413, {"ok": False, "error": "too_large"})
        stored_seq, saved_at, stale = put_state(code, seq, payload)
        touch_room(code)
        out = {"ok": True, "seq": stored_seq, "savedAt": saved_at}
        if stale:
            out["stale"] = True
        return self._json(200, out)

    def _api_get_state(self, code, q):
        """读取游戏存档。token 需是房主 hostToken、任一有效成员 mtoken，或本机 deviceId。"""
        row = get_room_row(code)
        if not row:
            return self._json(404, {"ok": False, "error": "not_found"})
        token = (q.get("token") or [""])[0]
        device_id = clean_device_id((q.get("d") or [""])[0])
        # ⚠️ hostToken 始终可用；成员 token 只在内存里，进程重启后会失效 ——
        #    v2.0.2 起补一条「设备码通道」：deviceId 命中本房绑定即放行（重启后仍可拉存档）。
        is_host = bool(token) and secrets.compare_digest(row[10], token)
        if not is_host:
            with _registry_lock:
                mem = _members.get((code, token or ""))
            if not mem:
                binding = get_device_seat(code, device_id) if device_id else None
                if not binding:
                    return self._json(403, {"ok": False, "error": "bad_token"})
        st = get_state_row(code)
        if not st:
            return self._json(404, {"ok": False, "error": "no_state"})
        return self._json(200, {"ok": True, "seq": st[1], "payload": st[2], "savedAt": st[3]})

    def _api_suspend(self, code):
        """挂起房间：状态置 SUSPENDED（行不清理，30 天后由 janitor 回收）。需 hostToken。"""
        req = self._read_body() or {}
        row = get_room_row(code)
        if not row:
            return self._json(404, {"ok": False, "error": "not_found"})
        if not secrets.compare_digest(row[10], str(req.get("hostToken") or "")):
            return self._json(403, {"ok": False, "error": "bad_token"})
        with _db_lock, _conn() as c:
            c.execute("UPDATE rooms SET status='SUSPENDED', last_seen=? WHERE code=?",
                      (_now(), code))
        _log("房间 %s 被房主挂起", code)
        return self._json(200, {"ok": True, "status": "SUSPENDED"})

    def _api_resume(self, code):
        """复活房间：SUSPENDED/RECRUITING/IN_GAME → RECRUITING，回传已存 seq/payload。需 hostToken。

        v2.0.2：放宽到允许 IN_GAME —— 进行中的团也要能「续玩」（回到存档点）。
        """
        req = self._read_body() or {}
        row = get_room_row(code)
        if not row:
            return self._json(404, {"ok": False, "error": "not_found"})
        if not secrets.compare_digest(row[10], str(req.get("hostToken") or "")):
            return self._json(403, {"ok": False, "error": "bad_token"})
        # SUSPENDED / RECRUITING / IN_GAME 可续玩；CLOSED / 其它一律 not_found
        if row[9] not in ("SUSPENDED", "RECRUITING", "IN_GAME"):
            return self._json(404, {"ok": False, "error": "not_found"})
        with _db_lock, _conn() as c:
            c.execute("UPDATE rooms SET status='RECRUITING', last_seen=? WHERE code=?",
                      (_now(), code))
        st = get_state_row(code)
        _log("房间 %s 被房主续玩", code)
        return self._json(200, {"ok": True, "status": "RECRUITING",
                                "seq": st[1] if st else 0,
                                "payload": st[2] if st else ""})

    def _api_unbind(self, code):
        """解绑本机设备身份（v2.0.2）。

        凭据 = 请求体里的 **本机 deviceId**；只删除 (code, 该 deviceId) 那一行，
        **无法**解绑别人的座位（等值查询 + 只删自己这一行）。解绑后本机被当作新玩家，
        下次加入会分配新座位（清掉 seat / 准备状态 / 角色卡绑定）。

        device_id 是凭据：**不落日志原文**。
        """
        req = self._read_body() or {}
        row = get_room_row(code)
        if not row:
            return self._json(404, {"ok": False, "error": "not_found"})
        device_id = clean_device_id(req.get("deviceId"))
        if not device_id:
            return self._json(400, {"ok": False, "error": "bad_request"})
        removed = delete_device_seat(code, device_id)
        # 只记「发生了」，不回显 deviceId（它是凭据）
        _log("房间 %s 设备解绑（自身）：%s", code, "removed" if removed else "no_binding")
        return self._json(200, {"ok": True, "code": code, "removed": removed})

    # ---------- 可命名存档槽（v2.0.2）----------
    def _api_save_create(self, code):
        """用当前 room_state 快照建一个命名存档槽。需 hostToken。"""
        req = self._read_body() or {}
        row = get_room_row(code)
        if not row:
            return self._json(404, {"ok": False, "error": "not_found"})
        if not secrets.compare_digest(row[10], str(req.get("hostToken") or "")):
            return self._json(403, {"ok": False, "error": "bad_token"})
        name = clean_text(req.get("name"), 40) or ("存档 " + time.strftime("%m-%d %H:%M"))
        save_id, seq, saved_at = create_save(code, name)
        touch_room(code)
        _log("房间 %s 建命名存档 %s", code, save_id)
        return self._json(200, {"ok": True, "saveId": save_id, "name": name,
                                "seq": seq, "savedAt": saved_at})

    def _api_save_list(self, code, q):
        """列出某房间的全部命名存档槽。需 hostToken。"""
        row = get_room_row(code)
        if not row:
            return self._json(404, {"ok": False, "error": "not_found"})
        token = (q.get("token") or [""])[0]
        if not (token and secrets.compare_digest(row[10], token)):
            return self._json(403, {"ok": False, "error": "bad_token"})
        out = [{"saveId": r[0], "name": r[1], "seq": r[2], "updatedAt": r[3]}
               for r in list_saves(code)]
        return self._json(200, {"ok": True, "saves": out})

    def _api_save_get(self, code, save_id, q):
        """读取某存档槽。token 需是 hostToken，或本机 deviceId 命中绑定。"""
        row = get_room_row(code)
        if not row:
            return self._json(404, {"ok": False, "error": "not_found"})
        token = (q.get("token") or [""])[0]
        device_id = clean_device_id((q.get("d") or [""])[0])
        allowed = bool(token) and secrets.compare_digest(row[10], token)
        if not allowed and device_id:
            allowed = get_device_seat(code, device_id) is not None
        if not allowed:
            return self._json(403, {"ok": False, "error": "bad_token"})
        s = get_save(code, save_id)
        if not s:
            return self._json(404, {"ok": False, "error": "not_found"})
        return self._json(200, {"ok": True, "saveId": s[0], "name": s[2],
                                "seq": s[3], "payload": s[4], "updatedAt": s[5]})

    def _api_save_load(self, code, save_id):
        """把某存档槽载入为当前状态（room_state ← 存档），并把房间置 RECRUITING。需 hostToken。"""
        req = self._read_body() or {}
        row = get_room_row(code)
        if not row:
            return self._json(404, {"ok": False, "error": "not_found"})
        if not secrets.compare_digest(row[10], str(req.get("hostToken") or "")):
            return self._json(403, {"ok": False, "error": "bad_token"})
        res = load_save(code, save_id)
        if res is None:
            return self._json(404, {"ok": False, "error": "not_found"})
        seq, payload = res
        with _db_lock, _conn() as c:
            c.execute("UPDATE rooms SET status='RECRUITING', last_seen=? WHERE code=?",
                      (_now(), code))
        _log("房间 %s 载入存档 %s（seq=%s）", code, save_id, seq)
        return self._json(200, {"ok": True, "seq": seq, "payload": payload})

    def _api_save_delete(self, code, save_id):
        """删除某存档槽。需 hostToken。"""
        req = self._read_body() or {}
        row = get_room_row(code)
        if not row:
            return self._json(404, {"ok": False, "error": "not_found"})
        if not secrets.compare_digest(row[10], str(req.get("hostToken") or "")):
            return self._json(403, {"ok": False, "error": "bad_token"})
        delete_save(code, save_id)
        return self._json(200, {"ok": True, "saveId": save_id})

    # ---------- WebSocket ----------
    def _ws(self, u):
        q = parse_qs(u.query)
        code = (q.get("code") or [""])[0]
        token = (q.get("t") or [""])[0]
        device_id = clean_device_id((q.get("d") or [""])[0])
        if not re.fullmatch(r"[a-z0-9]{4,12}", code or ""):
            return self._json(400, {"error": "缺少房间号"})

        row = get_room_row(code)
        if not row:
            return self._json(404, {"error": "房间不存在"})
        if str(row[9]) == "CLOSED":
            return self._json(410, {"error": "房间已关闭"})

        # v2.0.2：先看设备绑定 —— 命中即「本机回座」的持久凭据（进程重启后 mtoken 会失效，
        # 但 device_id 命中就能认回来）。
        binding = get_device_seat(code, device_id) if device_id else None
        active_token = token          # 实际用于 _members 索引的 token（可能是补发的）
        role, nickname = None, ""
        if token and secrets.compare_digest(row[10], token):
            role = "kp"
            nickname = row[3]
        else:
            with _registry_lock:
                m = _members.get((code, token or ""))
            if m:
                role = m["role"]
                nickname = m["nickname"]
            elif binding:
                # 设备码通道：mtoken 已失效（如进程重启）也认 —— 按绑定恢复 role/nickname
                role = binding[1] or "player"
                nickname = binding[2] or ""
        if not role:
            return self._json(403, {"error": "连接凭据无效，请重新加入"})

        key = self.headers.get("Sec-WebSocket-Key")
        upgrade = (self.headers.get("Upgrade") or "").lower()
        if not key or upgrade != "websocket":
            return self._json(400, {"error": "需要 WebSocket 升级请求"})

        sock = self.connection
        sock.settimeout(None)
        try:
            resp = ("HTTP/1.1 101 Switching Protocols\r\n"
                    "Upgrade: websocket\r\n"
                    "Connection: Upgrade\r\n"
                    "Sec-WebSocket-Accept: " + ws_accept_key(key) + "\r\n\r\n")
            sock.sendall(resp.encode("ascii"))
        except Exception:
            return
        # 已经自己接管连接：不要让 BaseHTTPRequestHandler 再动它
        self.close_connection = True

        room = ensure_live_room(code)
        conn = Conn(sock, self.client_address, code, role, nickname, token, self.client_ip(),
                    device_id)

        # ---- 座位转正（关键：名额不能在这里才第一次判）----
        # HTTP join 阶段已经原子占位，这里把预留位**消费**掉；
        # 拿不到预留位的情况还要分三种，不能一律踢：
        #   ① 断线重连：预留位在首次连接时已消费，同一个 token 回来 = 同一个人
        #   ② 别人拿着同一个 token 又连了一条：老连接让位，新的接管
        #   ③ v2.0.2 设备码回座：mtoken 可能已换（进程重启补发），但 device_id 命中绑定
        #      → 按 seat 接管老连接（同一台设备重连），且**跳过容量判定**（不占新名额）。
        # 都没有（伪造 / 预留超时被回收）才拒绝，并要求重新走 join。
        if role == "kp":
            prev = room.host
            if prev is not None:
                self.log_message("ws takeover(kp) code=%s old=%s", code, prev.cid)
                prev.kick(CLOSE_TAKEOVER, "房主已在别处重新连接")
        else:
            reserved = room.consume(token)
            if reserved is None:
                prev = room.find_by_token(token)
                if prev is None and device_id:
                    prev = room.find_by_seat(conn.seat)      # 设备码通道：按座位接管
                if prev is not None:
                    self.log_message("ws takeover code=%s role=%s old=%s seat=%s",
                                     code, role, prev.cid, conn.seat)
                    prev.kick(CLOSE_TAKEOVER, "已在别处重新连接")
                elif binding is not None:
                    # 设备码命中绑定 = 合法回座，**不判容量**（否则进行中的团回不去）
                    touch_device_seat(code, device_id)
                    self.log_message("ws rejoin(device) code=%s role=%s seat=%s",
                                     code, role, conn.seat)
                else:
                    # 还没连过、预留位也没了 → 可能是超时被 janitor 回收，
                    # 也可能是凭据是猜的。两种都得再判一次容量。
                    counts = room.counts()
                    can, reason, message = join_allowed(row, counts, role)
                    if not can:
                        # 还没有读循环，自己收尾
                        conn.kick(CLOSE_REJECT, message)
                        conn.close_socket()
                        return
                    self.log_message("ws rejoin(no reserve) code=%s role=%s seat=%s reason=%s",
                                     code, role, conn.seat, reason)

        # v2.0.2 断点1修复：设备码命中绑定、但 mtoken 已失效（不在 _members）→ **补发新 mtoken**，
        # 写回内存并随 ready 回给客户端。这样进程重启后玩家仍能回座（seat 不变）。
        reissued = ""
        if role != "kp" and binding is not None:
            with _registry_lock:
                known = (code, token or "") in _members
            if not known:
                reissued = secrets.token_urlsafe(18)
                active_token = reissued
                with _registry_lock:
                    _members[(code, reissued)] = {"role": role, "nickname": nickname,
                                                  "cid": conn.cid, "at": time.time()}
        if role != "kp":
            touch_device_seat(code, device_id)

        room.add(conn)
        ready = {"k": "ready", "cid": conn.cid, "seat": conn.seat,
                 "role": role, "code": code, "serverTime": _now()}
        if reissued:
            ready["mtoken"] = reissued          # 客户端据此刷新本机凭据（断线重连用）
        conn.send_text(json.dumps(ready, ensure_ascii=False, separators=(",", ":")))

        if role == "kp":
            with _registry_lock:
                if (code, token) in _members:
                    _members[(code, token)]["cid"] = conn.cid
            room.to_host({"k": "host.ok", "meta": row_to_meta(row), "counts": room.counts()})
            # ⚠️ 房主（重）连接时必须把**已在线的成员补发一遍**。否则 KP 页面刷新
            #    一次，权威端就以为房间是空的，而玩家那边一直挂着 —— 表现为
            #    「KP 的成员列表全没了、但玩家还在等」。带 rejoin 标记让其可区分
            #    「新进来的人」与「我断线期间就在的人」。
            for c2 in list(room.players.values()) + list(room.spectators.values()):
                room.to_host({"k": "peer.open", "cid": c2.cid, "seat": c2.seat,
                              "role": c2.role, "nickname": c2.nickname, "ip": c2.ip,
                              "spectators": room.counts()["spectators"],
                              "rejoin": True})
        else:
            with _registry_lock:
                if (code, active_token) in _members:
                    _members[(code, active_token)]["cid"] = conn.cid
            # seat 给权威端认人（重连不变），cid 给权威端当发信地址（重连会变）
            room.to_host({"k": "peer.open", "cid": conn.cid, "seat": conn.seat,
                          "role": role, "nickname": nickname, "ip": conn.ip,
                          "spectators": room.counts()["spectators"],
                          "rejoin": False})

        self.log_message("ws open code=%s role=%s cid=%s", code, role, conn.cid)

        hb = threading.Thread(target=self._heartbeat, args=(conn,), daemon=True)
        hb.start()
        try:
            self._pump(room, conn)
        except Exception as e:
            _log("ws pump 结束 code=%s cid=%s：%s", code, conn.cid, e)
        finally:
            conn.closed = True
            room.remove(conn)
            with _registry_lock:
                if (code, active_token) in _members:
                    _members[(code, active_token)]["cid"] = None
            if role == "kp":
                # 房主断线：不自动交给别人（需求 §14「不得自动把 KP 隐藏数据交给普通玩家」），
                # 只通知还在线的人，房间进入「等待房主重连」。
                for c2 in list(room.players.values()) + list(room.spectators.values()):
                    c2.send_text(json.dumps({"k": "host.gone",
                                             "message": "房主已断开，正在等待重连"},
                                            ensure_ascii=False))
            else:
                # 带 seat：权威端才会判断「这是重新入座还是真的走了」。
                # ⚠️ 重连接管时老连接也会走这里发 peer.close —— 权威端要按
                #    「seat 是否已重新上线」来收尾，不能一看 close 就把人清掉。
                room.to_host({"k": "peer.close", "cid": conn.cid, "seat": conn.seat})
            conn.close_socket()
            self.log_message("ws close code=%s role=%s cid=%s", code, role, conn.cid)

    def _heartbeat(self, conn):
        """服务端主动 ping。半开的 TCP 连接靠它才能被及时发现（手机切后台很常见）。"""
        while not conn.closed:
            time.sleep(HEARTBEAT_SEC)
            if conn.closed:
                return
            try:
                ws_write_frame(conn.sock, b"", OP_PING, conn.lock)
            except Exception:
                # 写不进去 = 对端已经没了：shutdown 唤醒读循环，让它走正常收尾
                conn.kick(CLOSE_TIMEOUT, "心跳失败")
                return

    def _pump(self, room, conn):
        """读循环。**只解析 hub.* 控制消息，其余一律原样转发给权威端。**"""
        frag = b""
        frag_op = 0
        while not conn.closed:
            fin, opcode, payload = ws_read_frame(conn.sock, MAX_FRAME, conn)
            if opcode == OP_CLOSE:
                return
            if opcode == OP_PING:
                ws_write_frame(conn.sock, payload, OP_PONG, conn.lock)
                continue
            if opcode == OP_PONG:
                continue
            if opcode == OP_CONT:
                frag += payload
                if not fin:
                    continue
                payload, opcode = frag, frag_op
                frag, frag_op = b"", 0
            elif not fin:
                frag, frag_op = payload, opcode
                continue

            if not conn.rate_ok():
                conn.send_text(json.dumps({"k": "error", "message": "消息发送过于频繁，请稍后再试"},
                                          ensure_ascii=False))
                continue

            text = payload.decode("utf-8", "replace")
            if conn.role == "kp":
                self._from_host(room, conn, text)
            else:
                room.to_host({"k": "peer.msg", "cid": conn.cid, "text": text})

    def _from_host(self, room, conn, text):
        """权威端 → 中继。这里只认 hub.*，别的一律忽略（防误用）。"""
        try:
            msg = json.loads(text)
        except Exception:
            return
        k = msg.get("k")
        if k == "hub.send":
            cid = msg.get("cid")
            target = room.players.get(cid) or room.spectators.get(cid)
            if target is not None:
                target.send_text(str(msg.get("text") or ""))
        elif k == "hub.broadcast":
            body = str(msg.get("text") or "")
            for c2 in list(room.players.values()) + list(room.spectators.values()):
                c2.send_text(body)
        elif k == "hub.close":
            cid = msg.get("cid")
            target = room.players.get(cid) or room.spectators.get(cid)
            if target is not None:
                target.kick(CLOSE_KICKED, str(msg.get("text") or "已被房主移出房间"))
        elif k == "hub.meta":
            self._host_meta(room.code, msg.get("meta") or {})
        # 其它 k 一律忽略

    def _host_meta(self, code, meta):
        """权威端上报的房间状态（招募中/游戏中/已关闭、人数）→ 写进目录。"""
        status = meta.get("status")
        if status not in ("RECRUITING", "IN_GAME", "CLOSED"):
            status = None
        try:
            with _db_lock, _conn() as c:
                if status:
                    c.execute("UPDATE rooms SET status=?, last_seen=? WHERE code=?",
                              (status, _now(), code))
                else:
                    c.execute("UPDATE rooms SET last_seen=? WHERE code=?", (_now(), code))
        except Exception as e:
            _log("更新房间状态失败：%s", e)


class QuietServer(ThreadingHTTPServer):
    """把「客户端直接断开」当成正常事件，不要打一坨堆栈。

    手机切网 / 关页面 / 掉线时，socket 被 RST 掉是家常便饭，
    而 http.server 会在读请求行时把它当异常抛到 handle_error，
    结果是日志里全是 Traceback，真出问题时反而看不见。
    """

    daemon_threads = True

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError,
                            BrokenPipeError, TimeoutError)):
            _log("客户端断开（%s）：%s", client_address[0] if client_address else "?", exc)
            return
        ThreadingHTTPServer.handle_error(self, request, client_address)


# ============================================================
# 准入判定（HTTP 预检、join、WS 连接三处共用同一份逻辑 —— 不允许各写一套）
# ============================================================
def join_allowed(row, counts, role):
    """返回 (可否加入, 机器可读原因, 给人看的话)。

    ⚠️ 规则要点（需求 §2.3 / §2.4，v2.1.1 用户明确要求修订）：
      · 玩家名额只算玩家，**不计 KP、不计旁观者**
      · **RECRUITING 与 IN_GAME 都允许玩家加入**（用户第三轮反馈：禁止游戏中加入会
        让「断线重连 / 保存后重开」回不去 —— 玩家被 ALREADY_STARTED 挡在门外）。
        「是不是重连」由**机器码**判定（见 join_kind / get_device_seat），只影响提示与
        落座，不影响能不能进；名额仍受 max_players 限制。
      · CLOSED 一律拒绝；SUSPENDED 由调用方在更早处拒绝（room_suspended）
      · 「允许旁观」关闭时，不能靠邀请链接或列表绕过
    """
    if not row:
        return False, "ROOM_NOT_FOUND", "房间不存在或已过期"
    status = row[9]
    max_players = row[7]
    allow_spec = bool(row[8])
    if status == "CLOSED":
        return False, "ROOM_CLOSED", "房间已解散"
    if role == "kp":
        return True, "", ""
    if role == "spectator":
        if not allow_spec:
            return False, "SPECTATE_DENIED", "该房间不允许旁观"
        if counts["players"] + counts["spectators"] >= MAX_MEMBERS:
            return False, "ROOM_FULL", "房间连接数已满"
        return True, "", ""
    # player —— 招募中 / 游戏中都允许进入，只受玩家席容量限制
    if counts["players"] >= max_players:
        return False, "PLAYER_FULL", "玩家席已满（%d/%d）" % (counts["players"], max_players)
    return True, "", ""


def join_kind(binding):
    """机器码判定结果 → 本次加入是「重连」还是「新加入」（v2.1.1 用户要求）。

    binding = get_device_seat(code, device_id) 的结果：
      命中绑定（非 None）→ 'reconnect'（同一台设备的合法回座）；
      未命中 → 'new'。**只用于提示与落座**，两种情况都允许进入
      （能否进入由 join_allowed 决定）。与 LanServer.joinKindOf 同名同语义。
    """
    return "reconnect" if binding else "new"



def clean_text(v, limit):
    """过滤控制字符并按长度截断。房间名/昵称都进目录，不能带换行与不可见字符。"""
    s = str(v if v is not None else "")
    s = "".join(ch for ch in s if ch >= " " and ch != "\x7f")
    s = re.sub(r"\s+", " ", s).strip()
    return s[:limit]


def ws_base():
    """对外 ws 基址。PUBLIC_BASE 是 https → 换成 wss。"""
    b = PUBLIC_BASE
    if not b:
        b = "http://%s:%d" % (HOST if HOST != "0.0.0.0" else "127.0.0.1", PORT)
    if b.startswith("https://"):
        return "wss://" + b[len("https://"):]
    if b.startswith("http://"):
        return "ws://" + b[len("http://"):]
    return b


def main():
    if not PUBLIC_BASE:
        sys.exit(
            "缺少 ROOM_PUBLIC_BASE 环境变量。\n"
            "它用来拼房间的 ws 地址，必须指向你自己的对外地址，例如：\n"
            "    export ROOM_PUBLIC_BASE=https://你的域名/room\n"
            "（直接双击 coc-room.exe 可不设 —— 会自动按局域网配齐）\n")
    init_db()
    cleanup_rooms()
    stop = threading.Event()
    threading.Thread(target=janitor, args=(stop,), daemon=True).start()

    if BARE_MODE:
        # 桌面用户：把该说的话说完，再替他把浏览器打开（coc-lan-start.bat 也是这么做的）。
        # ROOM_NO_AUTO_OPEN=1 可关掉自动开浏览器（无桌面环境 / 不想弹窗时用）。
        print("=" * 64, flush=True)
        print("  跑团车卡器 · 局域网一体服（裸启动，参数已自动配齐）", flush=True)
        print("  朋友用浏览器打开：  http://%s:%d/" % (LAN_IP, PORT), flush=True)
        if STATIC_DIR:
            print("  网页与中继同源：%s" % STATIC_DIR, flush=True)
        else:
            print("  （旁边没有 index.html —— 当前是纯中继模式，只提供联机）", flush=True)
        print("  停止服务：关闭本窗口", flush=True)
        print("=" * 64, flush=True)

        if not os.environ.get("ROOM_NO_AUTO_OPEN", "").strip():
            def _auto_open():
                time.sleep(1.2)          # 等监听真正起来再开，避免浏览器先报连不上
                try:
                    import webbrowser
                    webbrowser.open("http://%s:%d/" % (LAN_IP, PORT))
                except Exception:
                    pass
            threading.Thread(target=_auto_open, daemon=True).start()

    srv = QuietServer((HOST, PORT), Handler)
    print("coc-room listening on http://%s:%d  db=%s  public=%s" % (HOST, PORT, DB_PATH, PUBLIC_BASE))
    print("ws 基址：%s" % ws_base())
    print("防护：建房 %d 次/分/IP、%d 次/分全站 · 加入尝试 %d 次/分/IP · 房间上限 %d · "
          "单房连接 %d · 单连接 %d 条/分 · 保留 %.1f 小时"
          % (RATE_CREATE_IP, RATE_CREATE_GLOBAL, RATE_JOIN_IP, MAX_ROOMS, MAX_MEMBERS, RATE_MSGS,
             RETENTION_HOURS))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()


if __name__ == "__main__":
    main()
