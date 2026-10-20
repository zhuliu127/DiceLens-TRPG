# -*- coding: utf-8 -*-
"""
coc-share —— 调查员车卡器 · 角色卡分享服务

单文件、纯标准库（http.server + sqlite3 + zlib），内存占用 <30MB，
适合跑在 2C/1G 的小机器上，与其它服务共存。

接口（nginx 剥掉 /coc 前缀后，后端看到的是下面的根路径）：
  GET  /health              健康检查
  POST /api/cards           创建分享  body: {"name": "...", "data": {...}}
                            → {"id":"xxx","url":"https://.../s/xxx","delToken":"..."}
  GET  /api/cards/<id>      读取 JSON
  GET  /s/<id>              只读角色卡页面（给玩家看，不含编辑器）
  POST /api/cards/<id>/del  删除  body: {"token":"..."}

存储：SQLite（默认 /opt/coc-share/cards.db），角色 JSON 经 zlib+base64 压缩后入库。

⚠️ 这是一个「任何人可匿名写入」的公开接口，因此内置了四道防护：
     单 IP 限流 / 全站限流 / 总量与体积熔断 / 超期自动清理。
   这些不是可选项 —— 没有它们，接口会被当成免费网盘灌满磁盘，
   而同机上的其它服务会跟着一起挂。参数见下方「防护参数」，可用环境变量覆盖。

用法：
    export COC_SHARE_PUBLIC_BASE=https://你的域名/coc
    python3 coc_share_server.py
"""
import base64
import html
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

# ---------------- 配置 ----------------
HOST = os.environ.get("COC_SHARE_HOST", "127.0.0.1")
PORT = int(os.environ.get("COC_SHARE_PORT", "12700"))
DB_PATH = os.environ.get("COC_SHARE_DB", "/opt/coc-share/cards.db")

# 对外基址，用来拼分享链接。必须由部署者自己设置 ——
# 代码里不预置任何人的域名。
PUBLIC_BASE = os.environ.get("COC_SHARE_PUBLIC_BASE", "").rstrip("/")

MAX_BODY = 512 * 1024          # 单张卡上限 512KB（原始 JSON）
ID_LEN = 10

# ---------------- 防护参数 ----------------
MAX_TOTAL_CARDS = int(os.environ.get("COC_SHARE_MAX_CARDS", "5000"))     # 总条数熔断
MAX_DB_MB = int(os.environ.get("COC_SHARE_MAX_DB_MB", "200"))            # 库体积熔断（MB）
RETENTION_DAYS = int(os.environ.get("COC_SHARE_RETENTION_DAYS", "90"))   # 超期自动清理（天）
RATE_PER_IP = int(os.environ.get("COC_SHARE_RATE_PER_IP", "6"))          # 单 IP 每分钟创建数
RATE_GLOBAL = int(os.environ.get("COC_SHARE_RATE_GLOBAL", "60"))         # 全站每分钟创建数

_db_lock = threading.Lock()
_rate_lock = threading.Lock()
_rate_ip = {}          # {ip: [时间戳, ...]}
_rate_global = []      # [时间戳, ...]


def _log(msg, *args):
    sys.stderr.write("[%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg % args if args else msg))


# ---------------- 限流与容量 ----------------
def rate_check(ip):
    """滑动窗口限流。返回 (是否放行, 拒绝原因)。只作用于「创建」这类写操作。"""
    now = time.time()
    win = now - 60
    with _rate_lock:
        while _rate_global and _rate_global[0] < win:
            _rate_global.pop(0)
        if len(_rate_global) >= RATE_GLOBAL:
            return False, "全站创建频率已达上限，请稍后再试"

        q = _rate_ip.setdefault(ip, [])
        while q and q[0] < win:
            q.pop(0)
        if len(q) >= RATE_PER_IP:
            return False, "创建太频繁了，请过一会儿再试"

        q.append(now)
        _rate_global.append(now)

        # 防止 _rate_ip 本身变成内存泄漏
        if len(_rate_ip) > 20000:
            for k in [k for k, v in _rate_ip.items() if not v or v[-1] < win]:
                _rate_ip.pop(k, None)
        return True, ""


def capacity_check():
    """总量与体积熔断。返回 (是否放行, 拒绝原因)。"""
    try:
        with _db_lock, _conn() as conn:
            n = conn.execute("SELECT COUNT(*) FROM cards").fetchone()[0]
        if n >= MAX_TOTAL_CARDS:
            return False, "分享总数已达上限（%d 条），暂不接收新分享" % MAX_TOTAL_CARDS
    except Exception as e:
        _log("capacity_check 查询失败：%s", e)
        return True, ""      # 查不动就别挡用户，限流那层还在
    try:
        if os.path.exists(DB_PATH):
            mb = os.path.getsize(DB_PATH) / 1048576.0
            if mb >= MAX_DB_MB:
                return False, "存储空间已达上限，暂不接收新分享"
    except OSError:
        pass
    return True, ""


def cleanup_expired():
    """删除超过保留期的分享，并回收 WAL。返回删除条数。"""
    if RETENTION_DAYS <= 0:
        return 0
    cutoff = int(time.time()) - RETENTION_DAYS * 86400
    try:
        with _db_lock, _conn() as conn:
            cur = conn.execute("DELETE FROM cards WHERE created_at < ?", (cutoff,))
            n = cur.rowcount or 0
            if n:
                conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        if n:
            _log("清理超期分享 %d 条（早于 %s）", n, time.strftime("%Y-%m-%d", time.localtime(cutoff)))
        return n
    except Exception as e:
        _log("清理失败：%s", e)
        return 0


def janitor(stop_event):
    """后台线程：定期清理超期数据。"""
    while not stop_event.wait(6 * 3600):
        cleanup_expired()


def client_ip(handler):
    """取真实客户端 IP。服务只监听 127.0.0.1，这些头由前置 nginx 覆盖写入，
    外部无法伪造。"""
    for k in ("CF-Connecting-IP", "X-Real-IP", "X-Forwarded-For"):
        v = handler.headers.get(k)
        if v:
            return v.split(",")[0].strip()[:45]
    return (handler.client_address[0] if handler.client_address else "?")[:45]



def _conn():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    c = sqlite3.connect(DB_PATH, timeout=10)
    c.execute("PRAGMA journal_mode=WAL")
    return c


def init_db():
    with _db_lock, _conn() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS cards (
                id         TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                payload    BLOB NOT NULL,
                visibility TEXT NOT NULL DEFAULT 'link',
                del_token  TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                views      INTEGER NOT NULL DEFAULT 0
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_created ON cards(created_at DESC)")


def new_id():
    # 去掉容易看混的 0/o/1/l/i
    alpha = "23456789abcdefghjkmnpqrstuvwxyz"
    return "".join(secrets.choice(alpha) for _ in range(ID_LEN))


def pack(obj):
    return zlib.compress(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), 9)


def unpack(blob):
    return json.loads(zlib.decompress(blob).decode("utf-8"))


# ---------------- 角色卡渲染 ----------------
def e(v):
    return html.escape(str("" if v is None else v), quote=True)


def n(v):
    """安全转 int：技能实例的 total/base 等字段可能是 None 或空串。"""
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


def _attr_rows(a):
    pairs = [("力量 STR", a.get("str")), ("体质 CON", a.get("con")), ("体型 SIZ", a.get("siz")),
             ("敏捷 DEX", a.get("dex")), ("外貌 APP", a.get("app")), ("智力 INT", a.get("int")),
             ("意志 POW", a.get("pow")), ("教育 EDU", a.get("edu")), ("幸运 LUCK", a.get("luck"))]
    return "".join(
        '<div class="at"><span class="k">%s</span><span class="v">%s</span></div>' % (e(k), e(v if v != "" else "—"))
        for k, v in pairs
    )


def render_card(cid, card):
    c = card or {}
    bi = c.get("basicInfo") or {}
    st = c.get("status") or {}
    dv = c.get("derivedStats") or {}
    assets = c.get("assets") or {}
    bg = c.get("background") or {}
    myth = c.get("mythos") or {}

    name = c.get("characterName") or "未命名调查员"
    occ = bi.get("occupationName") or "—"
    era = bi.get("era") or "—"
    sex = bi.get("gender") or "—"
    age = bi.get("age") or "—"

    # 派生值与状态
    hp = "%s / %s" % (st.get("currentHP") if st.get("currentHP") is not None else dv.get("maxHP", 0), dv.get("maxHP", 0))
    mp = "%s / %s" % (st.get("currentMP") if st.get("currentMP") is not None else dv.get("maxMP", 0), dv.get("maxMP", 0))
    san = "%s / %s" % (st.get("currentSAN") if st.get("currentSAN") is not None else dv.get("maxSAN", 0), dv.get("maxSAN", 0))
    stats = [("HP 生命", hp), ("MP 魔法", mp), ("SAN 理智", san),
             ("MOV 移动", dv.get("mov", "—")), ("BUILD 体格", dv.get("build", "—")), ("DB 伤害加值", dv.get("db", "—"))]
    stat_html = "".join('<div class="st"><span class="k">%s</span><span class="v">%s</span></div>' % (e(k), e(v))
                        for k, v in stats)

    # 技能：只列出加过点的，以及本职技能（避免 131 行全铺开）
    skills = c.get("skills") or []
    used = [s for s in skills if n(s.get("occ")) + n(s.get("int")) + n(s.get("growth")) > 0]
    used.sort(key=lambda s: -n(s.get("total")))
    skill_html = "".join(
        '<tr><td>%s</td><td class="n">%s</td><td class="d">%s</td><td class="d">%s</td><td class="d">%s</td></tr>'
        % (e(s.get("name")), e(n(s.get("total"))),
           e(n(s.get("total")) // 2), e(n(s.get("total")) // 5),
           e("%d + %d + %d + %d" % (n(s.get("base")), n(s.get("occ")), n(s.get("int")), n(s.get("growth")))))
        for s in used
    ) or '<tr><td colspan="5" class="muted">尚未分配技能点</td></tr>'

    def simple_rows(arr, cols):
        if not arr:
            return '<div class="muted small">无</div>'
        head = "".join("<th>%s</th>" % e(t) for _, t in cols)
        body = ""
        for it in arr:
            body += "<tr>" + "".join("<td>%s</td>" % e(it.get(k, "")) for k, _ in cols) + "</tr>"
        return '<table class="grid"><thead><tr>%s</tr></thead><tbody>%s</tbody></table>' % (head, body)

    weapons_html = simple_rows(c.get("weapons"), [("name", "武器"), ("skill", "技能"), ("damage", "伤害"),
                                                  ("range", "射程"), ("ammo", "弹容")])
    items_html = simple_rows(c.get("items"), [("name", "物品"), ("quantity", "数量"), ("description", "备注")])

    spells = myth.get("spells") or []
    spells_html = "".join(
        '<div class="sp"><div class="spn">%s<span class="tag">%s</span></div>'
        '<div class="spl"><b>消耗</b> %s　<b>用时</b> %s</div>'
        '<div class="spe">%s</div></div>'
        % (e(s.get("name")), e(s.get("category") or "法术"), e(s.get("cost") or "—"),
           e(s.get("time") or "—"), e(s.get("effect") or ""))
        for s in spells
    ) or '<div class="muted small">未学会法术</div>'

    bg_fields = [("形象描述", bg.get("description")), ("思想与信念", bg.get("ideology")),
                 ("重要之人", bg.get("significantPeople")), ("意义非凡之地", bg.get("meaningfulPlaces")),
                 ("宝贵之物", bg.get("treasuredPossessions")), ("特质", bg.get("traits")),
                 ("伤口与疤痕", bg.get("wounds")), ("恐惧症 / 狂躁症", bg.get("phobias"))]
    bg_html = "".join(
        '<div class="bgf"><div class="t">%s</div><div class="d">%s</div></div>' % (e(k), e(v or "—"))
        for k, v in bg_fields
    )

    # 模板用 {{TOKEN}} 占位再 replace，而不是 % 格式化 ——
    # CSS 里有 width:100% 这种 % 字符，用 % 格式化会直接抛
    # ValueError: unsupported format character。
    tpl = """<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>{{NAME}} · 调查员角色卡</title>
<style>
:root{--bg:#12151c;--card:#1b2029;--card2:#222834;--bd:#333c4b;--tx:#e8eef7;--mut:#93a0b4;--gold:#d9b44a;--teal:#3fbf9a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:920px;margin:0 auto;padding:20px 14px 60px}
h1{font-size:23px;margin:0 0 4px}
h2{font-size:15px;margin:0 0 10px;color:var(--gold);letter-spacing:.5px}
.sub{color:var(--mut);font-size:13px;margin-bottom:18px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:15px;margin-bottom:14px}
.hero{background:linear-gradient(135deg,#1e2530,#171b24);border-color:#3d4657}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}
.tag{display:inline-block;background:var(--card2);border:1px solid var(--bd);border-radius:20px;padding:2px 10px;font-size:11.5px;color:var(--mut);margin-left:6px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}
.st,.at{background:var(--card2);border-radius:10px;padding:9px 11px;display:flex;justify-content:space-between;align-items:baseline}
.st .k,.at .k{font-size:11.5px;color:var(--mut)}
.st .v,.at .v{font-weight:700;font-size:16px;font-variant-numeric:tabular-nums}
.attrs{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:8px}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;color:var(--mut);font-weight:600;font-size:12px;padding:6px 8px;border-bottom:1px solid var(--bd)}
td{padding:7px 8px;border-bottom:1px solid rgba(255,255,255,.05)}
td.n{font-weight:700;color:var(--gold);font-variant-numeric:tabular-nums}
td.d{color:var(--mut);font-size:12.5px}
.muted{color:var(--mut)}
.small{font-size:13px}
.bgf{margin-bottom:11px}
.bgf .t{font-size:12px;color:var(--gold);margin-bottom:2px}
.bgf .d{white-space:pre-wrap}
.sp{background:var(--card2);border-radius:10px;padding:11px;margin-bottom:9px}
.sp .spn{font-weight:700;margin-bottom:5px}
.sp .spl{font-size:12.5px;color:var(--mut);margin-bottom:5px}
.sp .spe{font-size:13px;white-space:pre-wrap}
.foot{text-align:center;color:var(--mut);font-size:12px;margin-top:26px;line-height:1.9}
a{color:var(--teal)}
</style></head><body><div class="wrap">
<div class="card hero">
  <h1>{{NAME}}</h1>
  <div class="sub">玩家：{{PLAYER}}</div>
  <div class="tags"><span class="tag">{{ERA}}</span><span class="tag">{{OCC}}</span><span class="tag">{{SEX}}</span><span class="tag">{{AGE}} 岁</span><span class="tag">信用评级 {{CR}}</span></div>
</div>
<div class="card"><h2>派生属性与状态</h2><div class="stats">{{STATS}}</div></div>
<div class="card"><h2>基础属性</h2><div class="attrs">{{ATTRS}}</div></div>
<div class="card"><h2>技能（已分配 {{NSKILL}} 项）</h2>
<table><thead><tr><th>技能</th><th>总值</th><th>困难</th><th>极难</th><th>构成</th></tr></thead>
<tbody>{{SKILLS}}</tbody></table></div>
<div class="card"><h2>武器</h2>{{WEAPONS}}</div>
<div class="card"><h2>随身物品</h2>{{ITEMS}}</div>
<div class="card"><h2>神话法术（{{NSPELL}}）</h2>{{SPELLS}}</div>
<div class="card"><h2>背景</h2>{{BG}}</div>
<div class="foot">由「调查员车卡器」生成 · 分享编号 <b>{{CID}}</b><br>本页面为只读快照，不含编辑功能</div>
</div></body></html>"""
    for k, v in (
        ("NAME", e(name)), ("PLAYER", e(c.get("playerName") or "—")),
        ("ERA", e(era)), ("OCC", e(occ)), ("SEX", e(sex)), ("AGE", e(age)),
        ("CR", e(assets.get("creditRating", 0))), ("STATS", stat_html),
        ("ATTRS", _attr_rows(c.get("attributes") or {})),
        ("NSKILL", str(len(used))), ("SKILLS", skill_html),
        ("WEAPONS", weapons_html), ("ITEMS", items_html),
        ("NSPELL", str(len(spells))), ("SPELLS", spells_html),
        ("BG", bg_html), ("CID", e(cid)),
    ):
        tpl = tpl.replace("{{%s}}" % k, v)
    return tpl


# ---------------- HTTP ----------------
class Handler(BaseHTTPRequestHandler):
    server_version = "coc-share/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        _log(fmt, *args)

    # --- helpers ---
    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # 车卡器跑在 WebView 里（appassets.androidplatform.net），属于跨域，必须放行
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("X-Robots-Tag", "noindex, nofollow")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False), "application/json; charset=utf-8")

    def _read_body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if n <= 0 or n > MAX_BODY:
            return None
        return self.rfile.read(n)

    def do_OPTIONS(self):
        self._send(204, b"")

    # --- routes ---
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            return self._json(200, {"ok": True, "service": "coc-share", "time": int(time.time())})
        m = re.fullmatch(r"/api/cards/([A-Za-z0-9]{4,32})", path)
        if m:
            return self._api_get(m.group(1))
        m = re.fullmatch(r"/s/([A-Za-z0-9]{4,32})", path)
        if m:
            return self._page(m.group(1))
        if path in ("/", "/index.html"):
            return self._send(200, "coc-share is running. POST /api/cards to share a card.\n",
                              "text/plain; charset=utf-8")
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/cards":
            return self._api_create()
        m = re.fullmatch(r"/api/cards/([A-Za-z0-9]{4,32})/del", path)
        if m:
            return self._api_del(m.group(1))
        return self._json(404, {"error": "not found"})

    def _api_create(self):
        ip = client_ip(self)

        ok, why = rate_check(ip)
        if not ok:
            self.log_message("rate limited ip=%s", ip)
            return self._json(429, {"error": why})

        ok, why = capacity_check()
        if not ok:
            _log("容量已达上限，拒绝 ip=%s：%s", ip, why)
            return self._json(507, {"error": why})

        raw = self._read_body()
        if raw is None:
            return self._json(413, {"error": "body 缺失或超过 %d 字节" % MAX_BODY})
        try:
            req = json.loads(raw.decode("utf-8"))
        except Exception:
            return self._json(400, {"error": "JSON 解析失败"})
        data = req.get("data")
        if not isinstance(data, dict):
            return self._json(400, {"error": "缺少 data 字段"})
        name = (req.get("name") or data.get("characterName") or "未命名调查员")[:60]
        vis = req.get("visibility") or data.get("shareVisibility") or "link"
        if vis not in ("link", "public", "private"):
            vis = "link"

        payload = pack(data)
        if len(payload) > MAX_BODY:
            return self._json(413, {"error": "角色卡过大"})

        cid = new_id()
        token = secrets.token_urlsafe(18)
        with _db_lock, _conn() as conn:
            for _ in range(8):
                try:
                    conn.execute(
                        "INSERT INTO cards(id,name,payload,visibility,del_token,created_at) VALUES(?,?,?,?,?,?)",
                        (cid, name, payload, vis, token, int(time.time())))
                    break
                except sqlite3.IntegrityError:
                    cid = new_id()
            else:
                return self._json(500, {"error": "生成编号失败，请重试"})

        self.log_message("share created id=%s name=%s size=%dB ip=%s", cid, name, len(payload), ip)
        return self._json(200, {
            "ok": True, "id": cid, "url": "%s/s/%s" % (PUBLIC_BASE, cid),
            "apiUrl": "%s/api/cards/%s" % (PUBLIC_BASE, cid), "delToken": token,
        })

    def _api_del(self, cid):
        raw = self._read_body() or b"{}"
        try:
            req = json.loads(raw.decode("utf-8"))
        except Exception:
            req = {}
        with _db_lock, _conn() as conn:
            row = conn.execute("SELECT del_token FROM cards WHERE id=?", (cid,)).fetchone()
            if not row:
                return self._json(404, {"error": "不存在"})
            if not secrets.compare_digest(row[0], str(req.get("token") or "")):
                return self._json(403, {"error": "管理口令不正确"})
            conn.execute("DELETE FROM cards WHERE id=?", (cid,))
        return self._json(200, {"ok": True, "deleted": cid})

    def _api_get(self, cid):
        with _db_lock, _conn() as conn:
            row = conn.execute("SELECT payload,visibility,created_at,name FROM cards WHERE id=?", (cid,)).fetchone()
            if row:
                conn.execute("UPDATE cards SET views=views+1 WHERE id=?", (cid,))
        if not row:
            return self._json(404, {"error": "分享不存在或已删除"})
        if row[1] == "private":
            return self._json(403, {"error": "该分享为私密"})
        return self._json(200, {"id": cid, "name": row[3], "createdAt": row[2], "data": unpack(row[0])})

    def _page(self, cid):
        with _db_lock, _conn() as conn:
            row = conn.execute("SELECT payload,visibility FROM cards WHERE id=?", (cid,)).fetchone()
            if row:
                conn.execute("UPDATE cards SET views=views+1 WHERE id=?", (cid,))
        if not row:
            return self._send(404, "<h1>404</h1><p>分享不存在或已被删除。</p>",
                              "text/html; charset=utf-8")
        if row[1] == "private":
            return self._send(403, "<h1>403</h1><p>该分享为私密，未公开。</p>",
                              "text/html; charset=utf-8")
        try:
            data = unpack(row[0])
        except Exception:
            return self._send(500, "<h1>500</h1><p>角色卡数据损坏。</p>", "text/html; charset=utf-8")
        return self._send(200, render_card(cid, data), "text/html; charset=utf-8")


def main():
    if not PUBLIC_BASE:
        sys.exit(
            "缺少 COC_SHARE_PUBLIC_BASE 环境变量。\n"
            "它用来拼分享链接，必须指向你自己的对外地址，例如：\n"
            "    export COC_SHARE_PUBLIC_BASE=https://你的域名/coc\n")

    init_db()
    cleanup_expired()          # 启动时先清一次

    stop_event = threading.Event()
    threading.Thread(target=janitor, args=(stop_event,), daemon=True).start()

    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    print("coc-share listening on http://%s:%d  db=%s  public=%s" % (HOST, PORT, DB_PATH, PUBLIC_BASE))
    print("防护：单 IP %d 次/分 · 全站 %d 次/分 · 上限 %d 条 / %d MB · 保留 %d 天"
          % (RATE_PER_IP, RATE_GLOBAL, MAX_TOTAL_CARDS, MAX_DB_MB, RETENTION_DAYS))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop_event.set()


if __name__ == "__main__":
    main()
