# -*- coding: utf-8 -*-
"""test_room_deploy.py —— 公网 /room 全链路验收（对着已部署的域名跑，不启本地服务）

与 probe_room.py 的分工：
  probe_room.py      在本地起 room_server.py，测「服务本身对不对」
  test_room_deploy.py 不打本地服务，测「从公网进来这一条链路通不通」
                      即 Cloudflare → cloudflared → nginx → room_server.py

⚠️ 这是唯一能验证 WebSocket 穿透的测试。nginx 配错（没转发 Upgrade、
   没写 map $http_upgrade、proxy_read_timeout 太短）时，HTTPS 全部 200，
   但只要一开团就「一直重连中」—— 只看 /health 是查不出来的。

用法：
    python tools/test_room_deploy.py
    python tools/test_room_deploy.py --base https://your-domain.example.com/room
    python tools/test_room_deploy.py --write     # 建一个房间但不关，用来手工点浏览器
"""
import argparse, base64, hashlib, json, os, socket, ssl, struct, sys, time
import urllib.error, urllib.request
from urllib.parse import urlparse

DEFAULT_BASE = "https://your-domain.example.com/room"
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
# ⚠️ Cloudflare 会按 UA 拦机器人：Python 的默认 UA（Python-urllib/3.x）会被
#    Error 1010 browser_signature_banned 直接 403，连 /health 都到不了源站。
#    必须装成真实客户端再把「浏览器签名」这条规则绕过去。
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
EXTRA_HEADERS = {
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
}
# 只关掉「自签/域名不匹配」这类 TLS 校验失败（本机可能没装根证书做中间人）；
# 不断言证书链，因为验收目标是「应用协议通不通」，不是「证书合规」。
TLS_CTX = ssl.create_default_context()
TLS_CTX.check_hostname = False
TLS_CTX.verify_mode = ssl.CERT_NONE


class Fail(Exception):
    pass


def check(cond, msg, detail=None):
    if cond:
        return
    raise Fail(msg + (("  ← " + repr(detail)) if detail is not None else ""))


class Client:
    """HTTP + WebSocket 客户端。BASE 带子路径（/room），ws 也走同一条路径。"""

    def __init__(self, base):
        self.base = base.rstrip("/")
        u = urlparse(self.base)
        self.ws_base = ("wss://" if u.scheme == "https" else "ws://") + u.netloc + u.path
        self.ctx = TLS_CTX if u.scheme == "https" else None
        self.log = []

    # ---------- HTTP ----------
    def request(self, method, path, obj=None, timeout=15):
        url = self.base + path
        data = None
        headers = dict(EXTRA_HEADERS)
        if obj is not None:
            data = json.dumps(obj).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, method=method, data=data, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=self.ctx) as r:
                raw = r.read().decode("utf-8", "replace")
                return r.status, (json.loads(raw) if raw.strip() else None), dict(r.headers)
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            try:
                body = json.loads(raw) if raw.strip() else None
            except Exception:
                body = {"__raw__": raw[:200]}
            return e.code, body, dict(e.headers)

    def get(self, path, timeout=15):
        return self.request("GET", path, None, timeout)

    def post(self, path, obj, timeout=15):
        return self.request("POST", path, obj, timeout)

    # ---------- WebSocket（裸 socket 手写握手，才能看清到底谁坏了）----------
    def ws(self, code, token, timeout=15):
        u = urlparse(self.ws_base)
        port = u.port or (443 if u.scheme == "wss" else 80)
        sock = socket.create_connection((u.hostname, port), timeout=timeout)
        if u.scheme == "wss":
            sock = self.ctx.wrap_socket(sock, server_hostname=u.hostname)
        key = base64.b64encode(os.urandom(16)).decode()
        path = "%s/ws?code=%s&t=%s" % (u.path.rstrip("/"), code, token)
        host_hdr = u.hostname if port in (80, 443) else "%s:%d" % (u.hostname, port)
        # Cloudflare 对 WS 升级请求同样按 UA 过滤，这里必须一起带上
        req = ("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\n"
               "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
               "Sec-WebSocket-Version: 13\r\nOrigin: %s\r\n"
               "User-Agent: %s\r\nAccept-Language: zh-CN,zh;q=0.9,en;q=0.8\r\n"
               "Cache-Control: no-cache\r\nPragma: no-cache\r\n\r\n"
               % (path, host_hdr, key, self.base, UA))
        sock.sendall(req.encode())
        buf = b""
        sock.settimeout(timeout)
        while b"\r\n\r\n" not in buf:
            c = sock.recv(4096)
            if not c:
                raise Fail("WS 握手时连接被关（一个字节都没回）—— "
                           "多半是 nginx 没转发 Upgrade 头，或 cloudflared 不支持")
            buf += c
        head = buf.split(b"\r\n\r\n")[0].decode("utf-8", "replace")
        status = head.split("\r\n")[0]
        if "101" not in status:
            sock.close()
            raise Fail("WS 握手没升到 101：%s\n%s" % (status, head[:600]))
        expect = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
        if expect not in head:
            sock.close()
            raise Fail("Sec-WebSocket-Accept 校验失败（中间有人改写了响应）\n" + head[:600])
        return WS(sock, buf.split(b"\r\n\r\n", 1)[1])


class WS:
    def __init__(self, sock, buf=b""):
        self.s = sock
        self.buf = buf

    def send(self, text):
        data = text.encode()
        mask = os.urandom(4)
        n = len(data)
        head = bytearray([0x81])
        if n < 126:
            head.append(0x80 | n)
        elif n < 65536:
            head.append(0x80 | 126)
            head += struct.pack(">H", n)
        else:
            head.append(0x80 | 127)
            head += struct.pack(">Q", n)
        head += mask
        self.s.sendall(bytes(head) + bytes(b ^ mask[i & 3] for i, b in enumerate(data)))

    def _read(self, n):
        while len(self.buf) < n:
            c = self.s.recv(65536)
            if not c:
                raise IOError("closed")
            self.buf += c
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self, timeout=15):
        self.s.settimeout(timeout)
        h = self._read(2)
        op = h[0] & 0x0F
        n = h[1] & 0x7F
        if n == 126:
            n = struct.unpack(">H", self._read(2))[0]
        elif n == 127:
            n = struct.unpack(">Q", self._read(8))[0]
        p = self._read(n)
        if op == 0x8:
            return {"__close__": p.decode("utf-8", "replace"), "__code__": p[:2]}
        if op == 0x9:
            return {"__ping__": True}
        if op == 0xA:
            return self.recv(timeout)
        return json.loads(p.decode())

    def close(self):
        try:
            self.s.close()
        except Exception:
            pass


def run(c, args):
    steps = []

    def step(name, fn):
        t0 = time.time()
        try:
            got = fn()
        except Fail:
            raise
        except Exception as e:
            raise Fail("%s 时抛出异常：%r" % (name, e))
        steps.append((name, time.time() - t0))
        return got

    print("目标：%s" % c.base)
    print("ws  ：%s" % c.ws_base)
    print()

    # --- 1. HTTPS 基本可达（能通说明 CF→cloudflared→nginx→python 这段是好的）---
    def s_health():
        st, b, h = c.get("/health")
        print("  /health →", st, b)
        check(st == 200, "/health 不是 200", (st, b))
        check(b and b.get("ok") is True, "/health 返回体不对", b)
        check(b.get("service") == "coc-room", "service 字段不是 coc-room", b)
        # 顺手确认响应确实来自 room_server.py 而不是 nginx 的兜底页
        check(int(h.get("Content-Length") or 0) > 0, "Content-Length 缺失")
        return b
    step("health", s_health)

    def s_dir():
        st, b, _ = c.get("/api/rooms")
        print("  /api/rooms →", st, "共", len((b or {}).get("rooms") or []), "个房间")
        check(st == 200, "目录接口不是 200", (st, b))
        check(isinstance(b.get("rooms"), list), "目录返回体不对", b)
        return b
    step("directory", s_dir)

    # --- 2. 建房（走后端同一个 POST /api/rooms）---
    name = "部署验收-%s" % time.strftime("%H%M%S")
    holder = {"code": None, "tok": None}

    def s_create():
        st, b, _ = c.post("/api/rooms", {"name": name, "kpName": "验收KP",
                                         "password": "pw123", "maxPlayers": 2,
                                         "allowSpectate": True})
        print("  建房 →", st, {k: b.get(k) for k in ("ok", "code")} if b else b)
        check(st == 200, "建房失败", (st, b))
        check(b.get("code") and b.get("hostToken"), "建房返回缺字段", b)
        holder["code"], holder["tok"] = b["code"], b["hostToken"]
        # wsBase 必须由服务端按 ROOM_PUBLIC_BASE 推出来（https→wss）
        check(str(b.get("wsBase", "")).startswith("wss://"),
              "wsBase 不是 wss:// —— 检查 ROOM_PUBLIC_BASE", b.get("wsBase"))
        check("/room" in b["wsBase"], "wsBase 没带 /room 子路径", b["wsBase"])
        print("     code  =", b["code"])
        print("     wsBase=", b["wsBase"])
        return b
    step("create", s_create)

    # --- 2.1 自检房间：必须能建，但**不进目录**（客户端「网络自检」走的就是这条路）---
    # 为什么值得在真实服务器上测：这条路径是给用户排查「开房连不上」用的，
    # 它自己要是留下垃圾房间，用户的房间列表就被污染了 ——
    # 实测（v1.18.2 开发时）确实抓到过：关房是 fire-and-forget，
    # 调用方一退出请求就发不出去，房间卡在 RECRUITING 6 小时。
    def s_selfcheck():
        st, b, _ = c.post("/api/rooms", {"name": "自检房间", "kpName": "自检",
                                         "rules": "coc7", "maxPlayers": 1,
                                         "allowSpectate": False, "_selfcheck": True})
        print("  自检建房 →", st, {k: b.get(k) for k in ("ok", "code")} if b else b)
        check(st == 200 and b.get("ok") is True, "自检建房失败", (st, b))
        sc_code, sc_tok = b.get("code"), b.get("hostToken")
        check(bool(sc_code and sc_tok), "自检建房返回缺字段", b)

        # ① 自检房间不得出现在目录里
        st2, b2, _ = c.get("/api/rooms")
        codes = [r.get("code") for r in ((b2 or {}).get("rooms") or [])]
        check(sc_code not in codes, "自检房间出现在了目录里（会污染玩家的房间列表）",
              {"selfcheck_code": sc_code, "dir": codes[:12]})
        print("     自检房间不在目录中 ✓（目录共 %d 个）" % len(codes))

        # ② 关掉之后也必须不在目录里（正常路径）
        st3, b3, _ = c.post("/api/rooms/%s/close" % sc_code, {"hostToken": sc_tok})
        check(st3 == 200 and (b3 or {}).get("ok") is True, "自检房间关不掉", (st3, b3))
        return b
    step("selfcheck_invisible", s_selfcheck)
    code, host_token = holder["code"], holder["tok"]

    # --- 3. 预检 / 密码 / 容量 ---
    def s_probe():
        st, b, _ = c.post("/api/rooms/%s/probe" % code, {"role": "player"})
        print("  预检 →", st, {k: b.get(k) for k in ("ok", "needPwd", "status")})
        check(st == 200 and b.get("ok") is True, "预检失败", (st, b))
        check(b.get("needPwd") is True, "预检没识别出需要密码", b)
        return b
    step("probe", s_probe)

    def s_badpwd():
        st, b, _ = c.post("/api/rooms/%s/join" % code,
                          {"role": "player", "nickname": "错密码", "password": "nope"})
        print("  错密码加入 →", st, (b or {}).get("reason"))
        check(st == 403 and b.get("reason") == "BAD_PASSWORD", "错密码没被拒", (st, b))
        return b
    step("wrong-password", s_badpwd)

    p1 = {"mtoken": None, "wsUrl": None, "seat": None, "cid": None}

    def s_join1():
        st, b, _ = c.post("/api/rooms/%s/join" % code,
                          {"role": "player", "nickname": "小明", "password": "pw123"})
        print("  加入小明 →", st, (b or {}).get("ok"))
        check(st == 200 and b.get("ok"), "加入失败", (st, b))
        check(b.get("code") == code, "join 没回 code（客户端要用它拼路由）", b)
        p1["mtoken"], p1["wsUrl"] = b["mtoken"], b["wsUrl"]
        check(p1["wsUrl"].startswith("wss://") and "/room" in p1["wsUrl"],
              "join 回的 wsUrl 不对", p1["wsUrl"])
        return b
    step("join-1", s_join1)

    def s_join2():
        st, b, _ = c.post("/api/rooms/%s/join" % code,
                          {"role": "player", "nickname": "小红", "password": "pw123"})
        check(st == 200, "第二个人加入失败", (st, b))
        return b
    step("join-2", s_join2)

    def s_full():
        st, b, _ = c.post("/api/rooms/%s/join" % code,
                          {"role": "player", "nickname": "第三人", "password": "pw123"})
        print("  满员加入 →", st, (b or {}).get("reason"))
        check(st == 403 and b.get("reason") == "PLAYER_FULL", "满员没被拒", (st, b))
        return b
    step("player-full", s_full)

    def s_spec():
        st, b, _ = c.post("/api/rooms/%s/join" % code, {"role": "spectator", "nickname": "围观"})
        check(st == 403 and b.get("reason") == "BAD_PASSWORD", "旁观没要密码", (st, b))
        st, b, _ = c.post("/api/rooms/%s/join" % code,
                          {"role": "spectator", "nickname": "围观", "password": "pw123"})
        check(st == 200, "旁观加入失败", (st, b))
        return b
    step("spectator", s_spec)

    # --- 4. ★ WebSocket 升级（这一段才是部署验收的核心）---
    host = {"s": None}
    pl = {"s": None}

    def s_host_ws():
        s = c.ws(code, host_token)
        r = s.recv()
        print("  房主 ready →", r.get("k"), "seat=", r.get("seat"), "cid=", r.get("cid"))
        check(r.get("k") == "ready", "房主没收到 ready", r)
        check(r.get("seat") == "host", "房主 seat 不是 host", r)
        r2 = s.recv()
        print("  房主 host.ok →", r2.get("k"), r2.get("counts"))
        check(r2.get("k") == "host.ok", "房主没收到 host.ok", r2)
        host["s"] = s
        return r
    step("ws-host", s_host_ws)

    def s_player_ws():
        s = c.ws(code, p1["mtoken"])
        r = s.recv()
        print("  玩家 ready →", r.get("k"), "seat=", r.get("seat"), "cid=", r.get("cid"))
        check(r.get("k") == "ready", "玩家没收到 ready", r)
        check(r.get("seat") and r.get("seat") != "host", "玩家 seat 不对", r)
        p1["seat"], p1["cid"] = r["seat"], r["cid"]
        pl["s"] = s
        return r
    step("ws-player", s_player_ws)

    def s_peer_open():
        m = host["s"].recv()
        print("  房主收到 peer.open →", m.get("k"), m.get("nickname"), m.get("seat"))
        check(m.get("k") == "peer.open", "房主没收到 peer.open", m)
        check(m.get("seat") == p1["seat"], "peer.open 的 seat 与玩家自己拿的不一致",
              (m.get("seat"), p1["seat"]))
        check(m.get("rejoin") is False, "首次加入 rejoin 应为 False", m)
        return m
    step("peer.open", s_peer_open)

    def s_down():
        cid = host["s"].recv  # noqa: F841 (保持可读性)
        payload = json.dumps({"t": "event", "p": {"m": "公网下行 hello"}}, ensure_ascii=False)
        host["s"].send(json.dumps({"k": "hub.send", "cid": p1["cid"], "text": payload}))
        got = pl["s"].recv()
        print("  房主→玩家：", got)
        check(got.get("p", {}).get("m") == "公网下行 hello", "下行中继内容不对", got)
        return got
    step("ws-down", s_down)

    def s_up():
        # ⚠️ peer.msg 的 text 是中继原样透传的字节，不能拿它做子串匹配
        #    （json.dumps 默认 ensure_ascii=True 会把中文变成 \uXXXX）
        pl["s"].send(json.dumps({"t": "chat", "p": {"text": "公网上行 我准备好了"}},
                                ensure_ascii=False))
        up = host["s"].recv()
        check(up.get("k") == "peer.msg", "上行没收到 peer.msg", up)
        txt = json.loads(up["text"])["p"]["text"]
        print("  玩家→房主：", txt)
        check(txt == "公网上行 我准备好了", "上行中继内容不对", up)
        return up
    step("ws-up", s_up)

    def s_broadcast():
        payload = json.dumps({"t": "sys", "p": "开团"}, ensure_ascii=False)
        host["s"].send(json.dumps({"k": "hub.broadcast", "text": payload}))
        got = pl["s"].recv()
        print("  广播 →", got)
        check(got.get("p") == "开团", "广播内容不对", got)
        return got
    step("ws-broadcast", s_broadcast)

    # --- 5. 断线重连：同一份凭据必须换回同一个座位 ---
    pl2 = {"s": None}

    def s_reconnect():
        s = c.ws(code, p1["mtoken"])
        r = s.recv()
        print("  重连 ready → seat 一致:", r.get("seat") == p1["seat"], "cid 变了:",
              r.get("cid") != p1["cid"])
        check(r.get("seat") == p1["seat"], "重连后 seat 变了（认不出是同一个人）",
              (r.get("seat"), p1["seat"]))
        check(r.get("cid") != p1["cid"], "重连必须是一条新连接（cid 应不同）", r)
        pl2["s"] = s
        return r
    step("ws-reconnect", s_reconnect)

    def s_takeover():
        # 权威端要能看出「同一个人回来了」：同 seat 的 close + open
        kinds, deadline = [], time.time() + 5
        while time.time() < deadline:
            try:
                m = host["s"].recv(timeout=0.5)
            except Exception:
                continue
            kinds.append((m.get("k"), m.get("seat")))
            if ("peer.close", p1["seat"]) in kinds and ("peer.open", p1["seat"]) in kinds:
                break
        print("  重连期间房主收到：", kinds)
        check(("peer.close", p1["seat"]) in kinds, "没收到旧连接的 peer.close", kinds)
        check(("peer.open", p1["seat"]) in kinds, "没收到新连接的 peer.open", kinds)
        return kinds
    step("ws-takeover", s_takeover)

    def s_after_reconnect():
        payload = json.dumps({"t": "sys", "p": "重连后广播"}, ensure_ascii=False)
        host["s"].send(json.dumps({"k": "hub.broadcast", "text": payload}))
        got = pl2["s"].recv()
        check(got.get("p") == "重连后广播", "重连后收不到广播", got)
        pl2["s"].send(json.dumps({"t": "chat", "p": {"text": "我回来了"}}, ensure_ascii=False))
        up = host["s"].recv()
        check(up.get("k") == "peer.msg", "重连后上报失败", up)
        check(json.loads(up["text"])["p"]["text"] == "我回来了", "重连后上报内容不对", up)
        print("  重连后收发都正常")
        return up
    step("ws-after-reconnect", s_after_reconnect)

    # --- 6. 伪造凭据必须被拒（也是「WS 真的到了后端」的反证）---
    def s_forged():
        try:
            s = c.ws(code, "x" * 24)
            s.close()
            raise Fail("伪造凭据竟然连上了")
        except Fail as e:
            if "竟然连上" in str(e):
                raise
            print("  伪造凭据被拒（预期）：", str(e).splitlines()[0][:80])
        return True
    step("ws-forged-rejected", s_forged)

    # --- 7. 目录状态 / 关房 ---
    def s_meta():
        host["s"].send(json.dumps({"k": "hub.meta", "meta": {"status": "IN_GAME"}}))
        time.sleep(0.6)
        st, b, _ = c.get("/api/rooms")
        row = [x for x in b["rooms"] if x["code"] == code]
        check(row, "刚建的房间不在目录里", b)
        print("  目录状态 →", row[0].get("status"), "在线", row[0].get("online"))
        check(row[0].get("status") == "IN_GAME", "目录状态没同步", row[0])
        def s_started():
            st, b2, _ = c.post("/api/rooms/%s/join" % code,
                               {"role": "player", "nickname": "迟到", "password": "pw123"})
            print("  游戏中加入玩家 →", st, (b2 or {}).get("reason"))
            check(b2.get("reason") == "ALREADY_STARTED", "开团后还能加玩家席", (st, b2))
        step("already-started", s_started)
        return row[0]
    step("ws-meta", s_meta)

    # 收尾：先关 socket，再关房
    for k in ("host", "pl", "pl2"):
        s = {"host": host, "pl": pl, "pl2": pl2}[k]["s"]
        if s:
            s.close()

    if args.write:
        print()
        print("=== --write：房间保留在服上，浏览器手动验证 ===")
        print("  房间号 : %s" % code)
        print("  密码   : pw123")
        print("  打开   : %s/" % c.base)
        print("  （含 KP 令牌，别外传）hostToken=%s" % host_token)
        return 0

    def s_close():
        st, b, _ = c.post("/api/rooms/%s/close" % code, {"hostToken": host_token})
        print("  关房 →", st, b)
        check(st == 200, "关房失败", (st, b))
        st, b2, _ = c.post("/api/rooms/%s/probe" % code, {"role": "player"})
        check(b2.get("reason") == "ROOM_CLOSED", "关房后预检还活着", (st, b2))
        print("  关房后预检 →", b2.get("reason"))
        return b
    step("close", s_close)

    print()
    print("--- 步骤耗时 ---")
    for n, d in steps:
        print("  %-22s %.2fs" % (n, d))
    print()
    print("RESULT: PASS  （%d 步）" % len(steps))
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEFAULT_BASE, help="房间服务对外基址")
    ap.add_argument("--write", action="store_true",
                    help="建完房不关，打印房间号供浏览器手工验证")
    args = ap.parse_args()

    c = Client(args.base)
    try:
        return run(c, args)
    except Fail as e:
        print()
        print("✗ " + str(e))
        print()
        print("RESULT: FAIL")
        return 1
    except KeyboardInterrupt:
        print("\n中断")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
