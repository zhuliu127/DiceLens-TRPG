# -*- coding: utf-8 -*-
"""test_room_reconnect.py —— v2.0.2 T4/T5 服务端验收（设计 §4.3 的 C1–C6）

本文件是**协议层**的验收：直接对 room_server.py 发 HTTP / WebSocket 字节，
验证「设备绑定 + 断线回座 + 可命名存档」这套服务端契约。它和
test_room_ui.py（浏览器端到端）分工互补：这里能**真的重启进程**，
从而直接验证断点 1「服务重启后仍返回相同 seat」。

覆盖：
  C1  同一 device_id 二次 WS 连接 → 相同 seat；**重启进程后仍相同 seat**（补发新 mtoken）
  C2  伪造他人凭据 → 403（GET /state bad_token；WS 握手 403）
  C3  POST /saves → GET /saves 列出；POST /saves/<id>/load → room_state 等于存档
  C4  端到端：KP 存档 → 关房 → 重开 load → 玩家（同 deviceId）重连 → 存档 seq/payload 一致
  C5  断线（同进程）→ 重连 → seat 不变
  C6  无桥环境 DeviceId.get() 稳定（由本脚本用 node 跑一段 device-id.js 验证）

自己起 room_server.py（随机端口 + 临时 DB），末尾收掉。
"""
import base64
import hashlib
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRV = os.path.join(ROOT, "tools", "room_server.py")

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("  [OK] " if ok else "  [!!] ") + name + (("  <- " + str(detail)) if detail else ""),
          flush=True)


# ------------------------------------------------------------
# 极简 HTTP 客户端
# ------------------------------------------------------------
def http(method, url, body=None, timeout=10):
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8")
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            return e.code, json.loads(raw) if raw else {}
        except Exception:
            return e.code, {}


# ------------------------------------------------------------
# 极简 WebSocket 客户端（标准库手写，够用即可）
# ------------------------------------------------------------
class WS(object):
    def __init__(self, host, port, path, timeout=10):
        self.s = socket.create_connection((host, port), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        req = ("GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\n"
               "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
               "Sec-WebSocket-Version: 13\r\n\r\n" % (path, host, port, key))
        self.s.sendall(req.encode("ascii"))
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.s.recv(4096)
            if not chunk:
                break
            buf += chunk
        head, _, rest = buf.partition(b"\r\n\r\n")
        self.status = 0
        first = head.split(b"\r\n", 1)[0].decode("latin-1")
        try:
            self.status = int(first.split(" ")[1])
        except Exception:
            self.status = 0
        self.buf = rest

    def _read_exact(self, n):
        while len(self.buf) < n:
            chunk = self.s.recv(65536)
            if not chunk:
                raise EOFError("socket closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self, timeout=8):
        self.s.settimeout(timeout)
        h = self._read_exact(2)
        b0, b1 = h[0], h[1]
        opcode = b0 & 0x0F
        length = b1 & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._read_exact(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._read_exact(8))[0]
        masked = b1 & 0x80
        if masked:
            mask = self._read_exact(4)
            payload = bytearray(self._read_exact(length))
            for i in range(length):
                payload[i] ^= mask[i & 3]
            payload = bytes(payload)
        else:
            payload = self._read_exact(length)
        if opcode == 0x9:          # ping → pong，再继续读
            self._pong(payload)
            return self.recv(timeout)
        if opcode == 0x8:
            return {"__close__": True, "code": (struct.unpack(">H", payload[:2])[0]
                                                if len(payload) >= 2 else 0)}
        return payload

    def recv_json(self, timeout=8):
        raw = self.recv(timeout)
        if isinstance(raw, dict):
            return raw
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def send(self, text):
        data = text.encode("utf-8")
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
        masked = bytes(b ^ mask[i & 3] for i, b in enumerate(data))
        self.s.sendall(bytes(head) + mask + masked)

    def _pong(self, payload):
        mask = os.urandom(4)
        head = bytearray([0x8A, 0x80 | len(payload)])
        self.s.sendall(bytes(head) + mask + bytes(b ^ mask[i & 3] for i, b in enumerate(payload)))

    def close(self):
        try:
            self.s.close()
        except Exception:
            pass


# ------------------------------------------------------------
# 起 / 停 房间服务
# ------------------------------------------------------------
def start_server(dbdir, port):
    env = dict(os.environ)
    env.update({
        "ROOM_HOST": "127.0.0.1",
        "ROOM_PORT": str(port),
        "ROOM_DB": os.path.join(dbdir, "rooms.db"),
        "ROOM_PUBLIC_BASE": "http://127.0.0.1:%d" % port,
        "ROOM_RATE_CREATE_IP": "200",
        "ROOM_RATE_CREATE_GLOBAL": "800",
        "ROOM_RATE_JOIN_IP": "800",
    })
    logf = open(os.path.join(dbdir, "room_server.log"), "ab")
    p = subprocess.Popen([sys.executable, SRV], env=env,
                         stdout=subprocess.DEVNULL, stderr=logf)
    p._coc_logf = logf
    for _ in range(80):
        try:
            st, _ = http("GET", "http://127.0.0.1:%d/health" % port, timeout=1)
            if st == 200:
                return p
        except Exception:
            pass
        if p.poll() is not None:
            raise RuntimeError("房间服务启动即退出")
        time.sleep(0.2)
    raise RuntimeError("房间服务没起来")


def stop_server(p):
    if not p:
        return
    try:
        p.kill()
        p.wait(timeout=5)
    except Exception:
        pass


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


# ------------------------------------------------------------
# 主流程
# ------------------------------------------------------------
def create_room(base, name="C1团"):
    st, j = http("POST", base + "/api/rooms",
                 {"name": name, "kpName": "KP", "rules": "coc7", "maxPlayers": 6,
                  "allowSpectate": True})
    assert st == 200, (st, j)
    return j["code"], j["hostToken"]


def join(base, code, nick, device_id, role="player"):
    st, j = http("POST", base + "/api/rooms/%s/join" % code,
                 {"nickname": nick, "role": role, "deviceId": device_id})
    return st, j


def main():
    port = free_port()
    dbdir = tempfile.mkdtemp(prefix="coc-room-reconnect-")
    base = "http://127.0.0.1:%d" % port
    srv = None
    try:
        srv = start_server(dbdir, port)
        print("=== 房间服务已起 %s ===" % base, flush=True)

        # ================= C1 =================
        print("\n== C1：同 device_id 二次连接 → 相同 seat；重启进程后仍相同 ==", flush=True)
        code, host_token = create_room(base, "C1团")
        DEV = "a-" + "de" * 32
        st, j1 = join(base, code, "小明", DEV)
        check("C1 join#1 成功", st == 200 and j1.get("ok"), {"st": st, "j": j1})
        mtok1 = j1.get("mtoken", "")
        ws1 = WS("127.0.0.1", port, "/ws?code=%s&t=%s&d=%s" % (code, mtok1, DEV))
        ready1 = ws1.recv_json()
        seat1 = ready1.get("seat", "")
        check("C1 首次 WS 握手返回 seat", ready1.get("k") == "ready" and len(seat1) == 12,
              {"ready": ready1})
        ws1.close()
        time.sleep(0.3)

        # 二次 join（同 deviceId，服务端复用绑定、不占新名额）
        st, j2 = join(base, code, "小明", DEV)
        mtok2 = j2.get("mtoken", "")
        check("C1 join#2 复用同 seat（响应里的 seat 相同）",
              st == 200 and j2.get("seat") == seat1, {"seat1": seat1, "seat2": j2.get("seat")})
        ws2 = WS("127.0.0.1", port, "/ws?code=%s&t=%s&d=%s" % (code, mtok2, DEV))
        ready2 = ws2.recv_json()
        check("C1 二次 WS 握手 seat 相同", ready2.get("seat") == seat1,
              {"seat1": seat1, "seat2": ready2.get("seat")})
        ws2.close()
        time.sleep(0.3)

        # ---- 真的重启进程 ----
        stop_server(srv)
        time.sleep(0.4)
        srv = start_server(dbdir, port)
        print("  （已重启房间服务进程）", flush=True)

        # 用**失效的旧 mtoken** + deviceId 连 —— 服务端应据设备绑定回座并补发新 mtoken
        ws3 = WS("127.0.0.1", port, "/ws?code=%s&t=%s&d=%s" % (code, mtok1, DEV))
        ready3 = ws3.recv_json()
        check("★ ★ C1【断点1】进程重启后：设备码通道仍返回相同 seat",
              ready3.get("seat") == seat1, {"seat1": seat1, "seat3": ready3.get("seat")})
        check("★ ★ C1 进程重启后：服务端补发新 mtoken（随 ready 回传）",
              bool(ready3.get("mtoken")) and ready3.get("mtoken") != mtok1,
              {"mtoken": ready3.get("mtoken"), "old": mtok1})
        ws3.close()
        time.sleep(0.3)

        # ================= C2 =================
        print("\n== C2：伪造他人凭据 → 403 ==", flush=True)
        st, j = http("GET", base + "/api/rooms/%s/state?token=%s" % (code, "GUESS-TOKEN"))
        check("★ C2 GET /state 用伪造 token → 403 bad_token",
              st == 403 and j.get("error") == "bad_token", {"st": st, "j": j})
        # WS 用伪造 token + 伪造设备码 → 握手阶段 403（不升级）
        wsf = WS("127.0.0.1", port, "/ws?code=%s&t=%s&d=%s" % (code, "GUESS", "a-nope"))
        check("★ C2 WS 用伪造凭据 → 握手 403（不升级）", wsf.status == 403, {"status": wsf.status})
        wsf.close()
        # 用**别人的** deviceId（未绑定）也应被拒（不能认领别人的座位）
        st, j = join(base, code, "冒充", "a-unknown-device")
        check("C2 新设备码 join 视为新玩家（不占用别人的座位）",
              st == 200 and j.get("seat") != seat1, {"seat": j.get("seat"), "seat1": seat1})

        # ================= C3 =================
        print("\n== C3：命名存档槽 建 / 列 / 载入 ==", flush=True)
        code3, host3 = create_room(base, "C3团")
        payload3 = json.dumps({"v": 2, "seq": 42, "meta": {"code": code3, "status": "IN_GAME"}})
        st, _ = http("POST", base + "/api/rooms/%s/state" % code3,
                     {"hostToken": host3, "seq": 42, "payload": payload3})
        check("C3 先写入 room_state", st == 200, st)
        st, sv = http("POST", base + "/api/rooms/%s/saves" % code3,
                      {"hostToken": host3, "name": "第一次团"})
        check("C3 POST /saves 建槽成功", st == 200 and sv.get("saveId"), {"st": st, "j": sv})
        sid = sv.get("saveId", "")
        st, ls = http("GET", base + "/api/rooms/%s/saves?token=%s" % (code3, host3))
        check("C3 GET /saves 能列出该槽",
              st == 200 and any(s.get("saveId") == sid for s in ls.get("saves", [])),
              {"st": st, "j": ls})
        st, ld = http("POST", base + "/api/rooms/%s/saves/%s/load" % (code3, sid),
                      {"hostToken": host3})
        check("C3 POST /saves/<id>/load 回传存档 seq/payload",
              st == 200 and ld.get("seq") == 42 and ld.get("payload") == payload3,
              {"st": st, "j": ld})
        st, stt = http("GET", base + "/api/rooms/%s/state?token=%s" % (code3, host3))
        check("C3 load 后 room_state 等于该存档",
              st == 200 and stt.get("seq") == 42 and stt.get("payload") == payload3,
              {"st": st, "j": stt})
        # 删除
        st, dl = http("DELETE", base + "/api/rooms/%s/saves/%s" % (code3, sid), {"hostToken": host3})
        check("C3 DELETE /saves/<id> 成功", st == 200 and dl.get("ok"), {"st": st, "j": dl})

        # ================= C4 =================
        print("\n== C4：KP 存档 → 关房 → 重开 load → 玩家（同 deviceId）重连，seq 一致 ==", flush=True)
        code4, host4 = create_room(base, "C4团")
        DEV4 = "a-" + "4c" * 32
        st, j4 = join(base, code4, "玩家四", DEV4)
        seat4 = j4.get("seat", "")
        mtok4 = j4.get("mtoken", "")
        ws4 = WS("127.0.0.1", port, "/ws?code=%s&t=%s&d=%s" % (code4, mtok4, DEV4))
        check("C4 玩家 WS 就绪", ws4.recv_json().get("k") == "ready")
        # KP 侧：上报 IN_GAME + 推存档（用 host WS 走 hub.meta，模拟真实流程）
        wsk = WS("127.0.0.1", port, "/ws?code=%s&t=%s" % (code4, host4))
        wsk.recv_json()   # ready
        wsk.recv_json()   # host.ok
        wsk.send(json.dumps({"k": "hub.meta", "meta": {"status": "IN_GAME"}}))
        time.sleep(0.3)
        payload4 = json.dumps({"v": 2, "seq": 7, "meta": {"code": code4, "status": "IN_GAME"},
                               "members": [{"seat": seat4}]})
        http("POST", base + "/api/rooms/%s/state" % code4,
             {"hostToken": host4, "seq": 7, "payload": payload4})
        st, sv4 = http("POST", base + "/api/rooms/%s/saves" % code4,
                       {"hostToken": host4, "name": "存档点A"})
        sid4 = sv4.get("saveId", "")
        # 关房
        http("POST", base + "/api/rooms/%s/close" % code4, {"hostToken": host4})
        ws4.close()
        wsk.close()
        time.sleep(0.3)
        # 重开：load 存档槽（会把状态置 RECRUITING）
        st, ld4 = http("POST", base + "/api/rooms/%s/saves/%s/load" % (code4, sid4),
                       {"hostToken": host4})
        check("C4 load 存档 → 回传 seq 7", st == 200 and ld4.get("seq") == 7, {"st": st, "j": ld4})
        st, row = http("GET", base + "/api/rooms/%s/state?token=%s" % (code4, host4))
        check("★ C4 load 后 room_state.seq/payload 与存档一致",
              st == 200 and row.get("seq") == 7 and row.get("payload") == payload4,
              {"st": st, "seq": row.get("seq")})
        # 玩家（同 deviceId）重连 → seat 不变，且能拉到存档
        ws4b = WS("127.0.0.1", port, "/ws?code=%s&t=%s&d=%s" % (code4, mtok4, DEV4))
        ready4b = ws4b.recv_json()
        check("★ C4 玩家同 deviceId 重连 → seat 不变", ready4b.get("seat") == seat4,
              {"seat": seat4, "re": ready4b.get("seat")})
        st, rowp = http("GET", base + "/api/rooms/%s/state?token=%s&d=%s" % (code4, mtok4, DEV4))
        check("★ C4 玩家能拉到存档且 seq 一致（设备码通道放行）",
              st == 200 and rowp.get("seq") == 7, {"st": st, "seq": rowp.get("seq")})
        saved_meta = json.loads(rowp.get("payload", "{}")).get("meta", {}).get("status")
        check("★ C4 存档内 meta.status == IN_GAME（客户端据此回游戏页）",
              saved_meta == "IN_GAME", saved_meta)
        ws4b.close()

        # ================= C5 =================
        print("\n== C5：断线（同进程）→ 重连 → seat 不变 ==", flush=True)
        code5, host5 = create_room(base, "C5团")
        DEV5 = "a-" + "5e" * 32
        st, j5 = join(base, code5, "玩家五", DEV5)
        seat5 = j5.get("seat", "")
        a = WS("127.0.0.1", port, "/ws?code=%s&t=%s&d=%s" % (code5, j5.get("mtoken"), DEV5))
        r5a = a.recv_json()
        a.close()                     # 模拟断线
        time.sleep(0.4)
        b = WS("127.0.0.1", port, "/ws?code=%s&t=%s&d=%s" % (code5, j5.get("mtoken"), DEV5))
        r5b = b.recv_json()
        check("★ C5 断线重连 seat 不变（座位/准备状态不丢）",
              r5a.get("seat") == seat5 and r5b.get("seat") == seat5,
              {"seat5": seat5, "a": r5a.get("seat"), "b": r5b.get("seat")})
        b.close()

        # ================= C6 =================
        print("\n== C6：无桥环境 DeviceId.get() 稳定（同设备多次一致） ==", flush=True)
        js = (
            "const fs=require('fs');"
            "global.window=global;"
            "global.localStorage={_m:{},getItem(k){return this._m[k]||null;},"
            "setItem(k,v){this._m[k]=String(v);},removeItem(k){delete this._m[k];}};"
            "eval(fs.readFileSync('%s','utf8'));"
            "const a=DeviceId.get(),b=DeviceId.get(),c=DeviceId.get();"
            "console.log(JSON.stringify({a,b,c,stable:a===b&&b===c,prefix:a.slice(0,2)}));"
            % os.path.join(ROOT, "web", "js", "core", "device-id.js").replace("\\", "/")
        )
        out = subprocess.run([_node(), "-e", js], capture_output=True, text=True, timeout=30)
        try:
            info = json.loads((out.stdout or "{}").strip().splitlines()[-1])
        except Exception:
            info = {}
        check("★ C6 无桥降级：DeviceId.get() 同设备多次调用一致（b- 前缀）",
              info.get("stable") is True and str(info.get("prefix", "")).startswith("b-"),
              {"out": out.stdout.strip(), "err": out.stderr.strip()[:200], "info": info})

        # 统计
        print("\n===== 结果 %d / %d =====" % (sum(1 for _, o, _ in results if o), len(results)),
              flush=True)
        bad = [n for n, o, _ in results if not o]
        if bad:
            print("失败项：", flush=True)
            for n, o, d in results:
                if not o:
                    print("   [!!] " + n + ("  <- " + str(d) if d else ""), flush=True)
            return 1
        return 0
    finally:
        stop_server(srv)
        import shutil
        shutil.rmtree(dbdir, ignore_errors=True)


def _node():
    import shutil
    return shutil.which("node") or "node"


if __name__ == "__main__":
    raise SystemExit(main())
