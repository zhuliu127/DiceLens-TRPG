# -*- coding: utf-8 -*-
"""test_room_ui.py —— 跑团房间：真实浏览器端到端

这是需求 §15 第 2/4 步（房间最小闭环 + 招募与聊天）的验收用例。
它和 test_room_model / test_room_net 的分工是：

    Node 单测   → 逻辑不变量（序号、权限、可见性、回退、重连）
    本文件      → 「页面真的能跑通」：点得到、看得见、两个浏览器之间真的收到消息

覆盖：
    A. 首页入口 → 房间入口页 → 创建房间（当 KP）
    B. 玩家用邀请链接加入；KP 的成员表出现这个人
    C. 玩家点「我准备好了」→ KP 看到「已准备」且「开始游戏」可用 → 开团
    D. 聊天双向到达
    E. 私有信息隔离：KP 私下给 A 的线索只有 A 收到，C 一点都看不到
    F. 旁观者：不能准备、发送按钮禁用
    G. 关房后归档，回到入口页

自己起 room_server.py（随机端口 + 临时 DB），静态服务若 8899 已起就直接用，
否则自己拉一个。两者都在 finally 里收掉。
"""
import asyncio, json, os, re, shutil, socket, subprocess, sys, tempfile, threading, time
import urllib.error, urllib.parse, urllib.request

from playwright.async_api import async_playwright

try:
    from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
    from functools import partial
except ImportError:  # pragma: no cover
    ThreadingHTTPServer = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "web")
SRV = os.path.join(ROOT, "tools", "room_server.py")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots_room")
os.makedirs(OUT, exist_ok=True)

STATIC_PORT = int(os.environ.get("COC_STATIC_PORT") or 8899)
# （v1.18.5）8899 被系统/残留进程占住时，run_regression 会回退到 8901+ 并把
# 实际端口放进 COC_STATIC_PORT —— 这里跟它对齐，别再写死。
# v2.0.1（QA 严过关）：房间端口原来写死 12792。两个并发的本测试进程会抢同一
# 端口 → 后起的房间服务 bind 失败 → 旁观者/后续浏览器全部连不上，表现为
# 「大面积假红」（实测 netstat 出现过 3 个进程同时 LISTEN 12792）。
# 改为：优先用 COC_ROOM_PORT；否则在 import 期动态挑一个空闲端口。
def _pick_free_port():
    _s = socket.socket()
    try:
        _s.bind(("127.0.0.1", 0))
        return _s.getsockname()[1]
    finally:
        _s.close()


ROOM_PORT = int(os.environ.get("COC_ROOM_PORT") or _pick_free_port())
BASE = "http://127.0.0.1:%d/index.html" % STATIC_PORT
ROOM_BASE = "http://127.0.0.1:%d" % ROOM_PORT

results = []
errors = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("  [OK] " if ok else "  [!!] ") + name + (("  <- " + str(detail)) if detail else ""), flush=True)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def http_up(url, timeout=1.5):
    try:
        urllib.request.urlopen(url, timeout=timeout).read(1)
        return True
    except Exception:
        return False


# ============================================================
# 服务：静态站（8899，可能已由 run_regression 起好）+ 房间服务
# ============================================================

def ensure_static():
    """返回 (server_or_None, thread_or_None)。自己起的才需要收。"""
    if http_up(BASE):
        return None, None
    if ThreadingHTTPServer is None:
        raise RuntimeError("没有可用的 http.server，且 %s 没起来" % BASE)

    class Quiet(ThreadingHTTPServer):
        def handle_error(self, request, client_address):
            pass

    handler = partial(SimpleHTTPRequestHandler, directory=WEB)
    srv = Quiet(("127.0.0.1", STATIC_PORT), handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    for _ in range(40):
        if http_up(BASE):
            break
        time.sleep(0.25)
    return srv, t


def start_room_server(dbdir):
    env = dict(os.environ)
    env.update({
        "ROOM_HOST": "127.0.0.1",
        "ROOM_PORT": str(ROOM_PORT),
        "ROOM_DB": os.path.join(dbdir, "rooms.db"),
        "ROOM_PUBLIC_BASE": ROOM_BASE,
        # 本用例会起多个房间（A/J/K/L/M 各一个），默认「单 IP 每分钟 5 次建房」
        # 会在测试尾部触发限流，让「建房成功」变成假失败。限流是服务端的防滥用
        # 策略，不是本用例的测试对象 —— 这里为本测试自己的服务放宽它。
        "ROOM_RATE_CREATE_IP": "60",
        "ROOM_RATE_CREATE_GLOBAL": "300",
        "ROOM_RATE_JOIN_IP": "200",
    })
    # ⚠️ 房间服务每个请求都会 log_message() 往 stderr 写一行。以前这里用
    # stderr=subprocess.PIPE 却从不读取 —— 跑到用例后段（本文件 A/J/K/L/M 五段）
    # 累积的日志会写满 64KB 管道缓冲，子进程的 write 直接阻塞 → 服务彻底不响应，
    # 表现为「最后一段建房一直卡在『创建中…』」。这里改写进临时日志文件，
    # 既不会阻塞，又能在启动失败时把内容读出来定位问题。
    logpath = os.path.join(dbdir, "room_server.log")
    logf = open(logpath, "wb")
    p = subprocess.Popen([sys.executable, SRV], env=env,
                         stdout=subprocess.DEVNULL, stderr=logf)
    for _ in range(60):
        if http_up(ROOM_BASE + "/health"):
            # 保留文件对象引用，防止被 GC 关掉（关掉后子进程写日志会 EPIPE/阻塞）
            p._coc_logf = logf
            return p
        if p.poll() is not None:
            logf.close()
            try:
                with open(logpath, "rb") as f:
                    boot = f.read().decode("utf-8", "replace")
            except Exception:
                boot = ""
            raise RuntimeError("房间服务启动即退出：" + boot)
        time.sleep(0.25)
    p.kill()
    logf.close()
    raise RuntimeError("房间服务没起来：%s" % ROOM_BASE)


# ============================================================
# 页面侧的小工具（全部跑在浏览器里）
# ============================================================

SESSION_JS = """() => {
  const s = RoomUI._session();
  if (!s) return null;
  const st = s.host ? s.host.state : (s.client ? s.client.state : null);
  if (!st) return null;
  return {
    role: s.role,
    code: s.code,
    linkState: s.linkState || '',
    seat: s.client ? s.client.seat : 'host',
    metaName: (st.meta || {}).name || '',
    status: (st.meta || {}).status || '',
    members: (st.members || []).map(m => ({
      seat: m.seat, nick: m.nickname, role: m.role,
      ready: !!m.ready, online: !!m.online
    })),
    chats: (st.chats || []).map(c => (c.nickname || '') + ':' + (c.text || '')),
    logs: (st.logs || []).map(l => l.text || ''),
    privates: (st.privates || []).map(p => (p.title || '') + '|' + (p.text || '')),
    seq: st.seq || 0
  };
}"""

CLICK_BTN_JS = """(src) => {
  const rx = new RegExp(src);
  const b = [...document.querySelectorAll('button')].find(x => rx.test(x.textContent));
  if (!b) return false;
  b.click();
  return true;
}"""

CLICK_EXACT_JS = """(label) => {
  const b = [...document.querySelectorAll('button')]
    .find(x => x.textContent.trim() === label);
  if (!b) return false;
  b.click();
  return true;
}"""

# 按**子串**找可点元素并点击，且**不限于 <button>**。
# 为什么需要：游戏页「🧰 KP 工具」弹层里的四个工具是 room-panels.js 的
# toolBtn() 产出的 <div class="tool">（不是 button），文案还带 emoji
# （如「🏁 结团」）。CLICK_EXACT_JS 只找 button、且要求整串完全相等 ——
# 两个条件同时不满足，结团那一步永远点不到，H 段整段假失败。
# 候选按「后代元素最少」排序取最内层那个，避免点到把整块文本都包住的父容器。
CLICK_SUBSTR_JS = """(label) => {
  const cands = [...document.querySelectorAll('button, .tool, .btn')]
    .filter(x => x.textContent.indexOf(label) >= 0);
  if (!cands.length) return false;
  cands.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
  cands[0].click();
  return true;
}"""

FILL_SHEET_JS = """(vals) => {
  const sh = [...document.querySelectorAll('.sheet')].pop();
  if (!sh) return false;
  const ins = [...sh.querySelectorAll('input')];
  vals.forEach((v, i) => {
    if (ins[i] === undefined) return;
    ins[i].value = v;
    ins[i].dispatchEvent(new Event('input', { bubbles: true }));
    ins[i].dispatchEvent(new Event('change', { bubbles: true }));
  });
  return ins.length;
}"""

SET_SELECT_JS = """(opt) => {
  const sh = [...document.querySelectorAll('.sheet')].pop();
  if (!sh) return false;
  const sels = [...sh.querySelectorAll('select')];
  const s = sels.find(x => [...x.options].some(o => o.textContent.indexOf(opt) >= 0));
  if (!s) return false;
  const target = [...s.options].find(o => o.textContent.indexOf(opt) >= 0);
  s.value = target.value;
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return s.value;
}"""

# 页面正文，但**排除 toast**。
# 为什么需要：toast 也在 body 里，innerText 会把它算进去 ——
# 「已停用局域网直连」这种提示会让「按钮是否还在」的断言假失败。
TEXT_NO_TOAST_JS = """() => {
  const host = document.querySelector('.toast-host');
  const prev = host ? host.style.display : null;
  if (host) host.style.display = 'none';
  const t = document.body.innerText;
  if (host) host.style.display = prev || '';
  return t;
}"""

CHAT_SEND_JS = """(text) => {
  const bar = document.querySelector('.room-chatbar');
  if (!bar) return false;
  const inp = bar.querySelector('input');
  if (!inp) return false;
  inp.value = text;
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  return true;
}"""

CONFIRM_JS = """() => {
  const masks = [...document.querySelectorAll('.sheet-mask')];
  const m = masks[masks.length - 1];
  if (!m) return false;
  const b = [...m.querySelectorAll('button')].find(x => /确定|移出|结束房间|结团|删除|丢弃/.test(x.textContent));
  if (!b) return false;
  b.click();
  return true;
}"""

# 假的安卓外壳：让「局域网直连」卡片在浏览器里也能渲染，从而能真正跑一遍
# 「用本机开房 → 关掉它 → 切回服务器」这条路径。
# 它模拟的正是 MainActivity 暴露给网页的那几个桥方法。
FAKE_BRIDGE_JS = """
window.__lanUp = false;
window.AndroidBridge = {
  lanAvailable: function () { return true; },
  lanIp: function () { return '192.168.9.9'; },
  lanRunning: function () { return window.__lanUp === true; },
  lanStart: function () {
    window.__lanUp = true;
    return JSON.stringify({ ok: true, base: 'http://192.168.9.9:4211',
                            ip: '192.168.9.9', port: 4211 });
  },
  lanStop: function () { window.__lanUp = false; return JSON.stringify({ ok: true }); },
  lanDiscover: function () { /* 测试里不发广播 */ }
};
"""


async def wait_for(page, js, arg=None, timeout=8.0, step=0.15):
    """轮询直到 js 返回真值；返回最后一次的值。"""
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = await page.evaluate(js, arg)
        except Exception as e:
            last = None
        if last:
            return last
        await page.wait_for_timeout(int(step * 1000))
    return last


# ============================================================
# 页面侧：建房 / 加入（T02-T05 复用；走 UI，尽量贴近真实用户）
# ============================================================

async def make_room(page, name, kpname, room_base):
    """走 UI 建一个房间，返回房间号（失败返回 None）。"""
    await page.goto(BASE)
    await page.wait_for_timeout(1000)
    await page.evaluate("() => { try { localStorage.clear(); } catch (e) {} }")
    await page.reload()
    await page.wait_for_timeout(1000)
    await page.evaluate("(b) => Store.setSettings({ roomBase: b })", room_base)
    await page.evaluate("() => App.go('#/room')")
    await page.wait_for_timeout(500)
    await page.evaluate(CLICK_BTN_JS, "创建房间")
    await page.wait_for_timeout(500)
    await page.evaluate(FILL_SHEET_JS, [name, kpname, ""])
    await page.evaluate(CLICK_EXACT_JS, "创建")
    got = await wait_for(page, "() => { const s = RoomUI._session();"
                                " return s && s.role === 'kp' ? s.code : null; }", timeout=10.0)
    await wait_for(page, "() => (RoomUI._session()||{}).linkState === 'online'", timeout=10.0)
    return got


async def join_room(page, code, nick, room_base, role=None):
    """用邀请链接打开并加入房间；role='spectator' 时切成旁观。返回 session dict 或 None。"""
    invite = "%s?room=%s&srv=%s" % (BASE, code, urllib.parse.quote(room_base, safe=""))
    await page.goto(invite)
    await page.wait_for_timeout(1200)
    await page.evaluate(CLICK_BTN_JS, "加入这个房间")
    await page.wait_for_timeout(500)
    if role == "spectator":
        await page.evaluate(SET_SELECT_JS, "旁观")
    await page.evaluate(FILL_SHEET_JS, [code, nick, ""])
    await page.wait_for_timeout(500)
    await page.evaluate(CLICK_EXACT_JS, "加入")
    await wait_for(page, "() => { const s = RoomUI._session();"
                         " return s && s.client && s.client.seat ? true : null; }", timeout=10.0)
    return await page.evaluate(SESSION_JS)


async def start_game(kp, pl):
    """玩家准备 → KP 开团（T03/T04 的触摸/面板测试都需要 IN_GAME）。"""
    await ensure_bound_card(pl, "调查员")
    await pl.evaluate(CLICK_EXACT_JS, "我准备好了")
    await kp.wait_for_timeout(900)
    await kp.evaluate(CLICK_EXACT_JS, "开始游戏")
    await kp.wait_for_timeout(1200)


# ============================================================
# v2.0.0（F1）：未绑角色卡不能准备 → 这些 helper 负责给玩家建卡并绑定
# ============================================================

CREATE_CHAR_JS = """(name) => {
  const c = Store.newCharacter('coc7');
  c.characterName = name;
  c.status = Object.assign({}, c.status, {
    currentHP: 12, maxHP: 12, currentMP: 10, maxMP: 10,
    currentSAN: 55, maxSAN: 99, currentLuck: 50
  });
  Store.savePreset(c);
  return c.id;
}"""


async def ensure_bound_card(page, name="调查员", attrs=None):
    """给玩家建一张角色卡并在房间里绑定（未绑卡时「准备」按钮是置灰的）。

    v2.0.2：attrs 非空时一并写入九项属性（供「战斗队列 PC DEX」断言用 ——
    旧版只建卡不写属性，memberDex 取到空 → 无法验证 DEX 贯通）。"""
    if attrs:
        await page.evaluate("""(a) => {
          const c = Store.newCharacter('coc7');
          c.characterName = a.name;
          c.attributes = Object.assign({}, c.attributes, a.attrs);
          c.status = Object.assign({}, c.status, {
            currentHP: 12, maxHP: 12, currentMP: 10, maxMP: 10,
            currentSAN: 55, maxSAN: 99, currentLuck: 50
          });
          Store.savePreset(c);
          return c.id;
        }""", {"name": name, "attrs": attrs})
    else:
        await page.evaluate(CREATE_CHAR_JS, name)
    clicked = await page.evaluate(CLICK_BTN_JS, "绑定角色卡")
    if not clicked:
        clicked = await page.evaluate(CLICK_BTN_JS, "更换角色卡")
    await page.wait_for_timeout(400)
    await page.evaluate("""() => {
      const sh = [...document.querySelectorAll('.sheet')].pop();
      if (!sh) return false;
      const b = [...sh.querySelectorAll('button')]
        .find(x => x.textContent.trim() === '绑定' || x.textContent.trim() === '重新同步');
      if (!b) return false;
      b.click();
      return true;
    }""")
    # 等权威端把 charName 回给玩家（准备按钮据此解禁）
    await wait_for(page, """() => {
      const s = RoomUI._session();
      if (!s || !s.client) return null;
      const me = (s.client.state.members || []).find(m => m.seat === s.client.seat);
      return me && me.charName ? me.charName : null;
    }""", timeout=8.0)


# 假桥：记录横屏调用（v2.0.0 §3）。isAndroid 返回 false，避免引入局域网分支。
# v2.0.2 T4：补 getDeviceId —— 设备身份的**原生路径**要能被测到。
#   · __devId 非空 → DeviceId.get() 走 'a-'（sha256 原生稳定码）路径；
#   · __devId 为空（默认）→ 无原生码 → 走 'b-'（本地随机持久化）路径。
# 两条路径都要有断言覆盖，否则「设备即身份」在真机上是否真的走原生码无从验证。
FAKE_BRIDGE_SHELL_JS = """
window.__orient = [];
window.__devId = window.__devId || '';
window.AndroidBridge = {
  isAndroid: function () { return false; },
  setGameOrientation: function (mode) { window.__orient.push(mode); return 'ok'; },
  setPinchZoom: function () { return 'ok'; },
  getDeviceId: function () { return window.__devId || ''; }
};
"""


async def pinch(page, cx, cy, d1, d2, steps=10):
    """双指捏合：两指沿水平方向从 ±d1 到 ±d2（CDP 真实双指触摸）。"""
    cdp = await page.context.new_cdp_session(page)
    try:
        def pts(d):
            return [{"x": cx - d / 2, "y": cy, "id": 0},
                    {"x": cx + d / 2, "y": cy, "id": 1}]
        await cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": pts(d1)})
        for i in range(1, steps + 1):
            d = d1 + (d2 - d1) * i / steps
            await cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": pts(d)})
            await page.wait_for_timeout(16)
        await cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    finally:
        await cdp.detach()


# ============================================================
# 真实触摸：CDP Input.dispatchTouchEvent（不是 mouse！）
#
# 血泪教训：上一轮 T03 用「只找 <button> 且要求整串文字相等」的 helper 去点
# 一个 <div>，点击根本没落地，但弱断言照样变绿 —— 出现「鼠标过、真机挂」的假绿。
# 这一轮画板 / 标记一律走真实触摸事件，并直接断言 DOM 里真的有 svg>path。
# ============================================================

async def touch_drag(page, x1, y1, x2, y2, steps=12):
    """用 CDP 派发一条真实的触摸拖拽（touchStart → 多个 touchMove → touchEnd）。"""
    cdp = await page.context.new_cdp_session(page)
    try:
        await cdp.send("Input.dispatchTouchEvent", {
            "type": "touchStart", "touchPoints": [{"x": x1, "y": y1, "id": 0}]})
        for i in range(1, steps + 1):
            x = x1 + (x2 - x1) * i / steps
            y = y1 + (y2 - y1) * i / steps
            await cdp.send("Input.dispatchTouchEvent", {
                "type": "touchMove", "touchPoints": [{"x": x, "y": y, "id": 0}]})
            await page.wait_for_timeout(16)
        await cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    finally:
        await cdp.detach()


async def touch_tap(page, x, y):
    """用 CDP 派发一次真实的触摸单击。"""
    cdp = await page.context.new_cdp_session(page)
    try:
        await cdp.send("Input.dispatchTouchEvent", {
            "type": "touchStart", "touchPoints": [{"x": x, "y": y, "id": 0}]})
        await page.wait_for_timeout(70)
        await cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    finally:
        await cdp.detach()


async def touch_drag_cancel(page, x1, y1, x2, y2, steps=6):
    """真实触摸拖拽，但中途被系统 touchCancel 抢走（真机：滚动/长按/来电/通知下拉）。

    v2.1.1（用户第 4 项）新增：用来验证「pointercancel 时也要提交已画笔迹」——
    旧 bindDraw 只在 window 的 pointerup 里提交，touchCancel 不发 pointerup →
    整笔丢失（手绘板「画不出东西」的真机根因之一）。"""
    cdp = await page.context.new_cdp_session(page)
    try:
        await cdp.send("Input.dispatchTouchEvent", {
            "type": "touchStart", "touchPoints": [{"x": x1, "y": y1, "id": 0}]})
        for i in range(1, steps + 1):
            x = x1 + (x2 - x1) * i / steps
            y = y1 + (y2 - y1) * i / steps
            await cdp.send("Input.dispatchTouchEvent", {
                "type": "touchMove", "touchPoints": [{"x": x, "y": y, "id": 0}]})
            await page.wait_for_timeout(16)
        await cdp.send("Input.dispatchTouchEvent", {"type": "touchCancel", "touchPoints": []})
    finally:
        await cdp.detach()


async def rect_of(page, selector):
    """取（最后一个匹配的）元素的视口矩形。"""
    return await page.evaluate("""(sel) => {
      const els = [...document.querySelectorAll(sel)];
      const e = els[els.length - 1];
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    }""", selector)



async def main():
    dbdir = tempfile.mkdtemp(prefix="coc-room-ui-")
    srv_static = srv_room = None
    th = None
    try:
        srv_static, th = ensure_static()
        srv_room = start_room_server(dbdir)
        print("=== 静态服务 + 房间服务已起 ===", flush=True)

        async with async_playwright() as pw:
            browser = await pw.chromium.launch()
            ctx_kp = await browser.new_context(viewport={"width": 412, "height": 900})
            ctx_p = await browser.new_context(viewport={"width": 412, "height": 900})
            ctx_sp = await browser.new_context(viewport={"width": 412, "height": 900})
            kp = await ctx_kp.new_page()
            pl = await ctx_p.new_page()
            sp = await ctx_sp.new_page()

            for pg, tag in ((kp, "KP"), (pl, "玩家"), (sp, "旁观")):
                pg.on("pageerror", lambda e, t=tag: errors.append("[%s] %s" % (t, e)))
                pg.on("console", lambda m, t=tag: errors.append("[%s] %s" % (t, m.text))
                      if m.type == "error" else None)

            async def shot(pg, name):
                await pg.screenshot(path=os.path.join(OUT, name + ".png"), full_page=True)

            async def session(pg):
                return await pg.evaluate(SESSION_JS)

            async def text(pg):
                return await pg.evaluate("() => document.body.innerText")

            # =========================================================
            # A. 首页入口 → 入口页 → 创建房间
            # =========================================================
            print("\n== A、首页入口与创建房间 ==", flush=True)
            await kp.goto(BASE)
            await kp.wait_for_timeout(1200)
            await kp.evaluate("() => { try { localStorage.clear(); } catch (e) {} }")
            await kp.reload()
            await kp.wait_for_timeout(1200)

            home = await text(kp)
            check("★ 首页有「跑团房间」入口", "跑团房间" in home)

            clicked = await kp.evaluate(CLICK_BTN_JS, "跑团房间")
            check("★ 入口点得动", clicked is True)
            await kp.wait_for_timeout(600)
            check("★ 跳到了 #/room", (await kp.evaluate("() => location.hash")) == "#/room",
                  await kp.evaluate("() => location.hash"))

            # 配好服务地址（相当于用户在「设置」里填了自己的服务器）
            await kp.evaluate("(b) => Store.setSettings({ roomBase: b })", ROOM_BASE)
            await kp.evaluate("() => App.go('#/room')")
            await kp.wait_for_timeout(500)
            entry = await text(kp)
            check("★ 入口页显示房间服务地址与类型", ROOM_BASE in entry and "局域网" in entry, entry[:0])
            check("★ 入口页有「创建房间（当 KP）」", "创建房间（当 KP）" in entry)
            check("★ 入口页有「加入房间」", "加入房间" in entry)
            check("★ 规则区写明只开放 COC 7th、其余置灰", "克苏鲁的呼唤 第七版" in entry and "尚未开放" in entry)

            # 局域网直连：浏览器里**不该**出现「用本机开房」这类入口 ——
            # 网页监听不了端口，点了也没用。需求 §2.3 禁止「看着能点、点了没反应」。
            lan_state = await kp.evaluate("""() => {
              return {
                hasMod: !!window.RoomLan,
                isApp: window.RoomLan ? window.RoomLan.isApp() : null,
                avail: window.RoomLan ? window.RoomLan.available() : null
              };
            }""")
            check("★ 局域网模块已加载", bool(lan_state) and lan_state["hasMod"] is True, lan_state)
            check("★ 浏览器里如实回答「不是 App」", bool(lan_state) and lan_state["isApp"] is False, lan_state)
            check("★ 浏览器里如实回答「局域网不可用」",
                  bool(lan_state) and lan_state["avail"] is False, lan_state)
            check("★ 浏览器里不显示「用本机开房」（不给出假入口）", "用本机开房" not in entry)
            await shot(kp, "room_01_entry")

            await kp.evaluate(CLICK_BTN_JS, "创建房间")
            await kp.wait_for_timeout(500)
            filled = await kp.evaluate(FILL_SHEET_JS, ["奈亚拉托提普的面具", "KP老张", ""])
            check("★ 创建弹层有 3 个输入框（房间名 / KP 名字 / 密码）", filled == 3, filled)
            await shot(kp, "room_02_create_sheet")
            await kp.evaluate(CLICK_EXACT_JS, "创建")
            await kp.wait_for_timeout(1500)

            ks = await session(kp)
            check("★ 房主会话建立", bool(ks) and ks["role"] == "kp", ks and ks["role"])
            check("★ 房主进入房间页 #/room/<code>",
                  (await kp.evaluate("() => location.hash")) == "#/room/" + (ks or {}).get("code", ""),
                  await kp.evaluate("() => location.hash"))
            check("★ 房间名同步显示", (ks or {}).get("metaName") == "奈亚拉托提普的面具",
                  (ks or {}).get("metaName"))
            check("★ 房主状态是招募中", (ks or {}).get("status") == "RECRUITING", (ks or {}).get("status"))
            code = ks["code"]

            ok_online = await wait_for(kp, "() => (RoomUI._session()||{}).linkState === 'online'")
            check("★ 房主的 WebSocket 连上了", bool(ok_online))

            kptext = await text(kp)
            check("★ 房间页有房间号与邀请/离开按钮",
                  code in kptext and "复制邀请链接" in kptext and "离开" in kptext)
            check("★ 还没人加入时，成员区解释「你是房主」", "你是房主" in kptext)
            check("★ 开团按钮此时不可用（等全员准备）", "等待全员准备" in kptext)
            await shot(kp, "room_03_kp_empty")

            # =========================================================
            # B. 玩家用邀请链接加入
            # =========================================================
            print("\n== B、玩家加入 ==", flush=True)
            invite = "%s?room=%s&srv=%s" % (BASE, code, urllib.parse.quote(ROOM_BASE, safe=""))
            await pl.goto(invite)
            await pl.wait_for_timeout(1300)
            ptext = await text(pl)
            check("★ 邀请链接打开后，入口页顶部直接给出「加入这个房间」",
                  "有人邀请你加入房间" in ptext and code in ptext)
            check("★ 邀请卡里写清了房间服务地址", ROOM_BASE in ptext)
            await shot(pl, "room_04_invite")

            await pl.evaluate("""(n) => {
              const card = document.querySelector('.invite-card');
              const inp = card.querySelector('input');
              inp.value = n;
              inp.dispatchEvent(new Event('input', { bubbles: true }));
              return true;
            }""", "小明")
            await pl.evaluate(CLICK_BTN_JS, "加入这个房间")
            await pl.wait_for_timeout(600)
            # 弹层里再确认一次：房间号已预填、进度探测要能出结果
            sheet_info = await pl.evaluate("""() => {
              const sh = [...document.querySelectorAll('.sheet')].pop();
              if (!sh) return null;
              const ins = [...sh.querySelectorAll('input')];
              return {
                code: ins[0] ? ins[0].value : '',
                // 探测结果（房间名 + 人数）出现在 hint 那一行
                hint: (sh.querySelector('.tiny.dim:not(:empty)') || {}).innerText || sh.innerText
              };
            }""")
            check("★ 加入弹层预填了邀请里的房间号",
                  bool(sheet_info) and sheet_info["code"] == code, sheet_info and sheet_info["code"])
            check("★ 加入前就能看到房间名与人数（探测生效）",
                  bool(sheet_info) and "奈亚拉托提普的面具" in sheet_info["hint"],
                  sheet_info and sheet_info["hint"][:80])
            await pl.evaluate(FILL_SHEET_JS, [code, "小明", ""])
            await pl.wait_for_timeout(700)
            await pl.evaluate(CLICK_EXACT_JS, "加入")
            await pl.wait_for_timeout(1600)

            ps = await session(pl)
            check("★ 玩家会话建立且角色是玩家", bool(ps) and ps["role"] == "player", ps and ps["role"])
            check("★ 玩家路由到 #/room/<code>（不是 undefined）",
                  (await pl.evaluate("() => location.hash")) == "#/room/" + code,
                  await pl.evaluate("() => location.hash"))
            check("★ 玩家拿到自己的座位号（不是空）", bool((ps or {}).get("seat")), (ps or {}).get("seat"))
            check("★ 玩家的 lastSeq 已被同步推进", (ps or {}).get("seq", 0) > 0, (ps or {}).get("seq"))
            check("★ 玩家页显示的房间名与房主一致",
                  (ps or {}).get("metaName") == "奈亚拉托提普的面具", (ps or {}).get("metaName"))
            await wait_for(pl, "() => (RoomUI._session()||{}).linkState === 'online'")

            # KP 侧应看到成员
            seen = await wait_for(kp, """() => {
              const s = RoomUI._session();
              return s && s.host.state.members.length ? s.host.state.members.map(m => m.nickname) : null;
            }""")
            check("★ 房主的成员表出现了「小明」", bool(seen) and "小明" in seen, seen)
            await shot(kp, "room_05_kp_with_player")
            await shot(pl, "room_06_player_joined")

            # =========================================================
            # C. 准备 → 开团
            # =========================================================
            print("\n== C、准备与开团 ==", flush=True)
            # v2.0.0（用户要求）：未绑定角色卡不能准备 —— 先断言「按钮真的置灰」，再绑卡。
            ready_disabled = await pl.evaluate("""() => {
              const b = [...document.querySelectorAll('button')]
                .find(x => x.textContent.trim() === '我准备好了');
              return b ? !!b.disabled : null;
            }""")
            check("★ ★ 未绑定角色卡时「我准备好了」按钮不可点（disabled）",
                  ready_disabled is True, ready_disabled)
            check("★ ★ 未绑卡时页面给出原因（请先绑定角色卡才能准备）",
                  "请先绑定角色卡才能准备" in (await text(pl)), (await text(pl))[:0])
            await ensure_bound_card(pl, "小明")
            await pl.wait_for_timeout(400)
            check("★ 玩家看到「我准备好了」按钮", "我准备好了" in (await text(pl)))
            await pl.evaluate(CLICK_EXACT_JS, "我准备好了")
            await pl.wait_for_timeout(900)

            ks2 = await session(kp)
            ready_mem = [m for m in (ks2 or {}).get("members", []) if m["nick"] == "小明"]
            check("★ 房主看到「小明」已准备", bool(ready_mem) and ready_mem[0]["ready"] is True,
                  ready_mem)
            kptext2 = await text(kp)
            check("★ 开团按钮变成「开始游戏」", "开始游戏" in kptext2, kptext2[:0])

            await kp.evaluate(CLICK_EXACT_JS, "开始游戏")
            await kp.wait_for_timeout(1200)
            ks3 = await session(kp)
            ps3 = await session(pl)
            check("★ 房主侧状态变为游戏进行中", (ks3 or {}).get("status") == "IN_GAME", (ks3 or {}).get("status"))
            check("★ 玩家侧也收到状态变更", (ps3 or {}).get("status") == "IN_GAME", (ps3 or {}).get("status"))
            ptext3 = await text(pl)
            # v1.18.5：开团后切换到平铺**游戏页**（§5），不再是「房间页下多信息条」
            check("★ 开团后玩家进入平铺游戏页（§5 独立界面）",
                  await pl.evaluate("() => !!document.querySelector('.game-page')"))
            # ⚠️ 断言加强（防复发）：这些区域不仅要存在，还必须**真的挂在
            # .game-page 子树内**。只判 document.querySelector 会放过「节点建了
            # 但挂在别处（游离节点）」的情况 —— 本轮真出过的 bug 正是 chatEl 建了
            # 却忘了 appendChild 到 root。所以这里用 .game-page.contains(node) 卡死
            # 「必须在正确的位置」。status（.gp-status）一并纳入。
            check("★ 游戏页有 KP 栏 / 玩家栏 / 中央图 / 记录 / 状态 / 聊天 / 工具栏六个区域（且都在 .game-page 内）",
                  await pl.evaluate("""() => {
                    const gp = document.querySelector('.game-page');
                    if (!gp) { console.error('没有 .game-page'); return false; }
                    const sel = { kpbar: '.gp-kpbar', players: '.gp-players',
                                  center: '.gp-center', glog: '.gp-glog',
                                  status: '.gp-status',
                                  chat: '.gp-chat', toolbar: '.gp-toolbar',
                                  chatbar: '.room-chatbar' };
                    const missing = [], outside = [];
                    Object.keys(sel).forEach(k => {
                      const n = document.querySelector(sel[k]);
                      if (!n) missing.push(k);
                      else if (!gp.contains(n)) outside.push(k);
                    });
                    if (missing.length || outside.length) {
                      const kids = [...gp.children].map(x => x.className || x.tagName);
                      console.error('缺失区域: ' + missing.join(',') +
                        ' | 不在 game-page 内: ' + outside.join(',') +
                        ' | game-page 子节点: [' + kids.join(' | ') + ']' +
                        ' | 页面数: ' + document.querySelectorAll('.game-page').length);
                    }
                    return missing.length === 0 && outside.length === 0;
                  }"""))
            check("★ 开团后准备按钮不再出现（招募页才需要它）",
                  "我准备好了" not in ptext3, ptext3[:0])
            await shot(pl, "room_07a_started")

            # =========================================================
            # D. 聊天双向
            # =========================================================
            print("\n== D、聊天双向 ==", flush=True)
            await pl.evaluate(CHAT_SEND_JS, "KP，我的调查员要翻窗进去")
            await kp.wait_for_timeout(1000)
            ks4 = await session(kp)
            check("★ 房主收到玩家的发言",
                  any("翻窗" in c for c in (ks4 or {}).get("chats", [])), (ks4 or {}).get("chats"))
            check("★ 房主也收到了开团这条系统日志",
                  any("开团" in t for t in (ks4 or {}).get("logs", [])), (ks4 or {}).get("logs"))

            await kp.evaluate(CHAT_SEND_JS, "可以，但先过一次潜行")
            await pl.wait_for_timeout(1000)
            ps4 = await session(pl)
            check("★ 玩家收到房主的发言",
                  any("过一次潜行" in c for c in (ps4 or {}).get("chats", [])), (ps4 or {}).get("chats"))
            check("★ 玩家侧日志与聊天按序合并展示（seq 单调）",
                  (ps4 or {}).get("seq", 0) >= (ks4 or {}).get("seq", 0))
            await shot(pl, "room_07_chat")
            await shot(kp, "room_08_chat_kp")

            # =========================================================
            # E. 私有信息隔离（第三个浏览器：旁观者）
            # =========================================================
            print("\n== E、私有信息隔离 ==", flush=True)
            await sp.goto(invite)
            await sp.wait_for_timeout(1300)
            await sp.evaluate(CLICK_BTN_JS, "加入房间")
            await sp.wait_for_timeout(600)
            got = await sp.evaluate(SET_SELECT_JS, "旁观")
            check("★ 旁观者能把身份切成「旁观」", got == "spectator", got)
            await sp.evaluate(FILL_SHEET_JS, [code, "围观的小李", ""])
            await sp.wait_for_timeout(700)
            await sp.evaluate(CLICK_EXACT_JS, "加入")
            await sp.wait_for_timeout(1600)

            ss = await session(sp)
            check("★ 旁观者加入成功", bool(ss) and ss["role"] == "spectator", ss and ss["role"])

            # KP 私下把线索只递给「小明」
            target_seat = (ps or {}).get("seat")
            check("★ 拿到玩家的座位号（私有消息要按座位投递）", bool(target_seat), target_seat)
            await kp.evaluate("""(seat) => {
              RoomUI._session().side.act({
                op: 'scene.clue', seat: seat,
                title: '独有发现', text: '你看见墙上的浮雕在缓慢转动'
              });
            }""", target_seat)
            await pl.wait_for_timeout(1200)
            await sp.wait_for_timeout(400)

            ps5 = await session(pl)
            ss5 = await session(sp)
            check("★ 被指的玩家收到了私有信息",
                  any("浮雕" in p for p in (ps5 or {}).get("privates", [])), (ps5 or {}).get("privates"))
            check("★ 玩家页面出现「只给你看的信息」卡片",
                  "只给你看的信息" in (await text(pl)))
            check("★ ★ 旁观者的状态里**完全没有**这条私有信息（不是靠 UI 隐藏）",
                  not any("浮雕" in p for p in (ss5 or {}).get("privates", [])),
                  (ss5 or {}).get("privates"))
            check("★ ★ 旁观者的聊天流里也没有这条内容",
                  not any("浮雕" in c for c in (ss5 or {}).get("chats", [])))
            check("★ 公共日志里只有「递了一张纸条」，没有内容本身",
                  any("纸条" in t for t in (ps5 or {}).get("logs", []))
                  and not any("浮雕" in t for t in (ps5 or {}).get("logs", [])),
                  (ps5 or {}).get("logs"))
            # --- v2.0.1-C1：线索在**游戏页内**有常驻挂载点（根因⑥(b)） ---
            priv_ex = await pl.evaluate("""() => {
              const gp = document.querySelector('.game-page');
              const pv = document.querySelector('.game-page .gp-priv');
              const st = document.querySelector('.game-page .gp-status');
              return {
                inGame: !!gp,
                privExists: !!pv,
                privText: pv ? pv.textContent : null,
                privHasClue: !!(pv && pv.textContent.indexOf('浮雕') >= 0),
                statusHasPrivate: !!(st && st.textContent.indexOf('只给你看的信息') >= 0),
                privInGame: !!(gp && pv && gp.contains(pv))
              };
            }""")
            check("★ ★ v2.0.1-C1 线索渲染在 PL 游戏页**常驻 .gp-priv** 内（不用滚到底才看到）",
                  bool(priv_ex) and priv_ex["inGame"] and priv_ex["privExists"]
                  and priv_ex["privHasClue"] and priv_ex["privInGame"], priv_ex)
            # v2.0.10（用户第 4 项）：游戏页重复的线索卡已删除 —— 线索只保留常驻 .gp-priv，
            # .gp-status 里**不再**出现「只给你看的信息」。原 v2.0.1-C1'（要求 .gp-status
            # 仍保留该卡）与本次用户需求直接冲突，按**新行为**改写该条（非削弱断言）。
            check("★ ★ v2.0.10-C1' 游戏页线索只保留常驻 .gp-priv（.gp-status 不再重复）",
                  bool(priv_ex) and priv_ex["privHasClue"] and priv_ex["privInGame"]
                  and not priv_ex["statusHasPrivate"], priv_ex)
            # --- v2.0.1-C2：旁观者仍收不到（沿用既有 :754 语义，v2.0.1 前缀锁定） ---
            # 这条与既有 :754 同义，但用 v2.0.1 前缀单独留档 —— 防止未来重写 C 段
            # 时把「旁观者隔离」这条唯一的安全断言丢掉。判据：旁观者状态里
            # **没有**该线索，且旁观者游戏页/状态区**看不到**该线索文本。
            c2 = await sp.evaluate("""() => {
              const s = RoomUI._session();
              const st = s && s.client ? s.client.state : (s && s.host ? s.host.state : null);
              const privs = st ? (st.privates || []).map(p => (p.title || '') + '|' + (p.text || '')) : [];
              const body = document.body ? document.body.innerText : '';
              return { privsHaveClue: privs.some(p => p.indexOf('浮雕') >= 0),
                       bodyHasClue: body.indexOf('浮雕') >= 0 };
            }""")
            check("★ ★ v2.0.1-C2 旁观者仍收不到私密线索（状态里无该条 & 页面看不到）",
                  bool(c2) and c2["privsHaveClue"] is False and c2["bodyHasClue"] is False, c2)
            await shot(pl, "room_09_private_note")

            # =========================================================
            # F. 旁观者权限
            # =========================================================
            print("\n== F、旁观者不能掷骰 / 不能改状态 ==", flush=True)
            sptext = await text(sp)
            check("★ 旁观者看到的是「旁观中（不能发言/掷骰）」", "旁观中" in sptext, sptext[:0])
            disabled = await sp.evaluate("""() => {
              const bar = document.querySelector('.room-chatbar');
              const b = bar && bar.querySelector('button');
              return b ? !!b.disabled : null;
            }""")
            check("★ 旁观者的发送按钮是禁用的", disabled is True, disabled)
            check("★ 旁观者没有房主的「结束房间」按钮", "结束房间" not in sptext)

            # =========================================================
            # G. P4-P6 面板：探索 / 战斗 / KP 工具 / 掷骰
            #    这些都是「开团之后」的东西：上面已经在 C 开过团了。
            # =========================================================
            print("\n== G、P4-P6 探索 / 战斗 / 工具 / 掷骰 ==", flush=True)

            # --- 面板要出现（开团前不显示，开团后 KP 一定看得到） ---
            # v1.18.5：游戏页是平铺布局——模式 chip 在 KP 栏；素材入口在
            # 「🗺 素材与地图」弹层里；KP 工具在「🧰 KP 工具」弹层里。
            kp_text_g = await text(kp)
            check("★ KP 栏显示当前模式（探索）", "探索" in kp_text_g, kp_text_g[:0])
            check("★ KP 工具栏有「素材与地图」入口", "素材与地图" in kp_text_g, kp_text_g[:0])
            check("★ KP 侧出现掷骰条（D100 突出）", "D100" in kp_text_g, kp_text_g[:0])
            await shot(kp, "room_11_kp_panels")

            # --- 掷骰：KP 掷一次，玩家要收到同一条权威结果 ---
            await kp.evaluate(CLICK_EXACT_JS, "D100")
            await kp.wait_for_timeout(900)
            kp_dice = await kp.evaluate("""() => {
              const s = RoomUI._session(); const st = s.host.state;
              return (st.dice || []).map(d => ({ v: d.total, lv: d.levelText || '', seat: d.seat }));
            }""")
            check("★ KP 掷骰后权威状态里有骰点记录", bool(kp_dice), kp_dice)
            check("★ 骰点带成功等级（由规则服务算出，非界面自算）",
                  bool(kp_dice) and bool(kp_dice[-1]["lv"]), kp_dice)
            pl_dice = await wait_for(pl, """() => {
              const s = RoomUI._session(); const st = s.client.state;
              return (st.dice || []).length ? (st.dice || []).map(d => d.total) : null;
            }""")
            check("★ 玩家收到同一条掷骰结果（权威掷骰广播）", bool(pl_dice), pl_dice)
            check("★ 玩家页面出现掷骰记录（游戏记录区，§5.5）",
                  "1D100" in (await pl.evaluate("""() => {
                    const g = document.querySelector('.gp-glog');
                    return g ? g.innerText : '';
                  }""")), (await text(pl))[:0])

            # --- 素材：上传默认不公开，公开后玩家才收到 ---
            await kp.evaluate("""() => {
              const s = RoomUI._session();
              // 直接走模型：上传一张 1x1 的图（不公开）
              s.side.act({ op: 'asset.add', asset: { kind: 'map', name: '洋馆一层',
                data: 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=' } });
            }""")
            await kp.wait_for_timeout(500)
            kp_assets = await kp.evaluate("""() => {
              const h = RoomUI._session().host;
              return { local: (h.localAssets || []).map(a => a.name),
                       pub: ((h.state.scene || {}).assets || []).map(a => a.name) };
            }""")
            check("★ 上传后进 KP 私有库、未进公共场景",
                  "洋馆一层" in (kp_assets or {}).get("local", [])
                  and "洋馆一层" not in (kp_assets or {}).get("pub", []), kp_assets)

            pl_before = await pl.evaluate("""() => {
              const a = (RoomUI._session().client.state.scene || {}).assets || [];
              return a.map(x => x.name);
            }""")
            check("★ ★ 未公开的素材不在玩家状态里（不是靠界面隐藏）",
                  "洋馆一层" not in pl_before, pl_before)

            await kp.evaluate("""() => {
              const h = RoomUI._session().host;
              const id = (h.localAssets || [])[0].id;
              h.applyAction('host', { op: 'asset.reveal', id: id, revealed: true });
              RoomUI._session().side.act({ op: 'asset.reveal', id: id, revealed: true });
            }""")
            await kp.wait_for_timeout(800)
            pl_after = await wait_for(pl, """() => {
              const a = (RoomUI._session().client.state.scene || {}).assets || [];
              return a.length ? a.map(x => x.name) : null;
            }""")
            check("★ ★ 公开后玩家立刻收到该素材", bool(pl_after) and "洋馆一层" in pl_after, pl_after)

            # --- 地图标记：相对坐标（跨设备一致） ---
            await kp.evaluate("""() => {
              RoomUI._session().side.act({ op: 'map.mark', x: 0.5, y: 0.5,
                kind: 'dot', label: '暗门', revealed: true });
            }""")
            await kp.wait_for_timeout(800)
            pl_mark = await wait_for(pl, """() => {
              const m = (RoomUI._session().client.state.scene || {}).marks || [];
              return m.length ? m.map(x => ({ x: x.x, y: x.y, label: x.label })) : null;
            }""")
            check("★ 玩家收到地图标记（相对坐标 0..1）",
                  bool(pl_mark) and 0 <= pl_mark[-1]["x"] <= 1 and pl_mark[-1]["label"] == "暗门", pl_mark)
            check("★ 玩家页面的地图舞台画出了标记", "暗门" in (await text(pl)), (await text(pl))[:0])

            # --- 战斗：开战后按 DEX 排顺序、怪物 HP 不下发 ---
            await kp.evaluate("""() => {
              const s = RoomUI._session(); const st = s.host.state;
              const seat = (st.members.find(m => m.role === 'player') || {}).seat || '';
              s.side.act({ op: 'combat.start', actors: [
                { id: 'g1', name: '深潜者', kind: 'monster', dex: 90, actionsPerRound: 3, hp: 13, hpMax: 13 },
                { id: 'p1', name: '小明', kind: 'pc', seat: seat, dex: 60, actionsPerRound: 1, hp: 11, hpMax: 11 }
              ] });
            }""")
            await kp.wait_for_timeout(900)
            kp_cb = await kp.evaluate("""() => {
              const c = RoomUI._session().host.state.combat;
              return c ? { n: c.order.length, mode: RoomUI._session().host.state.meta.mode,
                           g: c.order.filter(s => s.actorId === 'g1').length } : null;
            }""")
            check("★ 开战后进入战斗模式", bool(kp_cb) and kp_cb["mode"] == "COMBAT", kp_cb)
            check("★ 三连击怪物展开成 3 个行动槽（不是 1 个）",
                  bool(kp_cb) and kp_cb["g"] == 3, kp_cb)

            # 关键：玩家状态里的怪物**没有** hp 数字
            pl_cb = await wait_for(pl, """() => {
              const c = RoomUI._session().client.state.combat;
              if (!c) return null;
              const g = c.order.find(s => s.actorId === 'g1');
              const p = c.order.find(s => s.actorId === 'p1');
              return { gHasHp: !!(g && g.public && (g.public.hp !== undefined)),
                       pHasHp: !!(p && p.public && (p.public.hp !== undefined)),
                       hasName: !!(g) };
            }""")
            check("★ ★ 玩家状态里根本不存在怪物 HP 字段",
                  bool(pl_cb) and pl_cb["gHasHp"] is False, pl_cb)
            check("★ 玩家仍能看到怪物名字（要能标识目标）",
                  bool(pl_cb) and pl_cb["hasName"] is True, pl_cb)
            check("★ 玩家角色的 HP 是公开的（需求 §8.2）",
                  bool(pl_cb) and pl_cb["pHasHp"] is True, pl_cb)
            # v2.0.0 集成说明：行动顺序条由 F2 的 room-panels.js（initiativeBar）提供，
            # 文案从旧版的「行动顺序」变成「第 N 轮 · 当前行动：X」。两种文案都接受 ——
            # 断言的意图不变（玩家页确实出现了行动顺序条），只是不再死抠某个旧字面。
            pl_txt = await text(pl)
            check("★ 玩家页出现行动顺序条",
                  ("行动顺序" in pl_txt) or ("当前行动" in pl_txt), pl_txt[:0])
            await shot(pl, "room_12_combat_player")
            await shot(kp, "room_13_combat_kp")

            # --- KP 推进回合 ---
            turn_before = await kp.evaluate("() => RoomUI._session().host.state.combat.turn")
            clicked_next = await kp.evaluate(CLICK_BTN_JS, "下一个行动")
            await kp.wait_for_timeout(800)
            kp_turn = await kp.evaluate("() => RoomUI._session().host.state.combat.turn")
            check("★ KP 战斗面板有「下一个行动」按钮", clicked_next is True, clicked_next)
            check("★ KP 点「下一个行动」推进了当前行动者（turn 前进）",
                  kp_turn is not None and kp_turn > turn_before,
                  {"before": turn_before, "after": kp_turn})

            # --- 状态请求：玩家必须同意才生效 ---
            await kp.evaluate("""() => {
              const s = RoomUI._session(); const st = s.host.state;
              const m = st.members.find(x => x.role === 'player');
              s.side.act({ op: 'state.request', seat: m.seat, reason: '被诅咒', change: { hp: 3 } });
            }""")
            await kp.wait_for_timeout(900)
            pl_consent = await wait_for(pl, """() => {
              const r = (RoomUI._session().client.state.requests || []);
              return r.length ? { n: r.length, hp: (RoomUI._session().client.state.members
                .find(m => m.seat === RoomUI._session().client.seat) || {}).runtime } : null;
            }""")
            check("★ 玩家收到「KP 想调整你的状态」请求", bool(pl_consent), pl_consent)
            await pl.evaluate(CLICK_EXACT_JS, "同意")
            await kp.wait_for_timeout(900)
            kp_hp = await wait_for(kp, """() => {
              const st = RoomUI._session().host.state;
              const m = st.members.find(x => x.role === 'player');
              return (m && m.runtime && m.runtime.hp === 3) ? m.runtime.hp : null;
            }""")
            check("★ ★ 玩家同意后状态才落账（权威端不替玩家改）", kp_hp == 3, kp_hp)

            # --- v2.1.0 缺陷2（用户第 6 项）：检定请求卡「同意」+「未加点技能」权威值兜底 ---
            # 造场景：玩家本机卡**未加点**该技能（清空本机 skills → findLocalSkill 落空），
            # 而权威端 sheet 持有该技能值（→ payload.base 非空）。这正是用户说的
            # 「没有链接到没有加点的技能」：卡片应仍显示技能名 + 非空基础值。
            await pl.evaluate("""() => {
              const s = RoomUI._session();
              const c = Store.getState().characters[s.boundCharId];
              window.__v210_savedSkills = c ? c.skills : null;
              if (c) c.skills = [];
            }""")
            await kp.evaluate("""() => {
              const h = RoomUI._session().host;
              const view = h.state.members.find(x => x.role === 'player');
              const skills = [{ name: '侦查', total: 45 }];
              if (view && view.sheet) view.sheet.skills = skills;
              const rm = (h.roster && h.roster.get) ? h.roster.get(view.seat) : null;
              if (rm) { rm.sheet = rm.sheet || {}; rm.sheet.skills = skills; }
              h.__v210_seat = view.seat;
            }""")
            await kp.evaluate("""() => {
              const s = RoomUI._session();
              s.side.act({ op: 'check.request', seat: s.host.__v210_seat, skill: '侦查',
                           difficulty: 'REGULAR', desc: '未加点技能兜底验证' });
            }""")
            await kp.wait_for_timeout(900)
            payload = await kp.evaluate("""() => {
              const h = RoomUI._session().host;
              const list = h._requestsBySeat[h.__v210_seat] || [];
              const last = list[list.length - 1] || null;
              return last ? { op: last.op, base: (last.payload || {}).base } : null;
            }""")
            check("★ ★ v2.1.0 前置：权威端为「未加点」技能算出了非空基础值（payload.base 非空）",
                  bool(payload) and payload.get("op") == "check.request"
                  and payload.get("base") is not None, payload)
            card = await wait_for(pl, """() => {
              const c = [...document.querySelectorAll('.card')]
                .find(x => (x.textContent || '').indexOf('KP 要求检定') >= 0);
              if (!c) return null;
              const hasAgree = [...c.querySelectorAll('button')]
                .some(b => (b.textContent || '').indexOf('同意') >= 0);
              const m = (c.textContent || '').match(/权威值\\s*(\\d+)/);
              return { hasSkill: (c.textContent || '').indexOf('侦查') >= 0, hasAgree: hasAgree,
                       authShown: m ? Number(m[1]) : null };
            }""")
            check("★ ★ v2.1.0 缺陷2「未加点技能」的检定卡：有技能名、有非空权威基础值、有「同意」按钮",
                  bool(card) and card["hasSkill"] and card["hasAgree"]
                  and card["authShown"] is not None and card["authShown"] > 0, card)
            seq0 = await kp.evaluate("() => RoomUI._session().host.state.seq")
            await pl.evaluate("""() => {
              const c = [...document.querySelectorAll('.card')]
                .find(x => (x.textContent || '').indexOf('KP 要求检定') >= 0);
              const b = c && [...c.querySelectorAll('button')]
                .find(x => (x.textContent || '').indexOf('同意') >= 0);
              if (b) b.click();
            }""")
            await kp.wait_for_timeout(1200)
            res = await kp.evaluate("""() => {
              const st = RoomUI._session().host.state;
              const tail = (st.logs || []).slice(-6).map(x => x.text || '').join(' | ');
              return { seq: st.seq, tail: tail };
            }""")
            check("★ ★ v2.1.0 缺陷2 点「同意」→ 权威端产出检定结果事件（seq 前进，日志含该技能）",
                  res["seq"] > seq0 and ('侦查' in res["tail"] or 'D100' in res["tail"]),
                  {"seq0": seq0, "seq": res["seq"], "tail": res["tail"]})
            gone = await pl.evaluate("""() => ![...document.querySelectorAll('.card')]
              .some(x => (x.textContent || '').indexOf('KP 要求检定') >= 0)""")
            check("★ ★ v2.1.0 缺陷2 同意后检定卡被摘掉（不会一直挂着）", gone is True, gone)
            await pl.evaluate("""() => {
              const s = RoomUI._session();
              const c = Store.getState().characters[s.boundCharId];
              if (c && window.__v210_savedSkills) c.skills = window.__v210_savedSkills;
            }""")

            # --- v2.9.0（用户第 3 项）：回退功能已整体移除 ---
            # 旧版此段：KP 发起回退投票 → 玩家侧出现「同意回退」入口（rollback.turn / pl_vote）。
            # 现改为：只保留「进入下一回合」的正向验证（回合号必须真的推进），
            # 并断言 KP 工具面板**不再出现「回退回合」入口**（回退 UI 已彻底删除）。
            round_before = await kp.evaluate("() => RoomUI._session().host.state.meta.round")
            await kp.evaluate(CLICK_BTN_JS, "KP 工具")
            await kp.wait_for_timeout(500)
            marked = await kp.evaluate(CLICK_SUBSTR_JS, "进入下一回合")
            await kp.wait_for_timeout(700)
            round_after = await kp.evaluate("() => RoomUI._session().host.state.meta.round")
            check("★ 点得到「⏭ 进入下一回合」工具，并真的推进了回合号",
                  marked is True and round_after == (round_before or 0) + 1,
                  {"clicked": marked, "before": round_before, "after": round_after})
            kp_tools_now = await text(kp)
            check("★ ★ v2.9.0（用户第 3 项）：KP 工具面板不再出现「回退回合」入口",
                  "回退回合" not in kp_tools_now, kp_tools_now[:0])
            await kp.evaluate("() => UI.closeAllSheets()")
            await kp.wait_for_timeout(300)

            # --- KP 工具面板存在（v1.18.5：收进「🧰 KP 工具」弹层） ---
            await kp.evaluate(CLICK_BTN_JS, "KP 工具")
            await kp.wait_for_timeout(500)
            kp_tools = await text(kp)
            check("★ KP 工具面板有「要求检定 / 递线索 / 结团」（v2.9.0 用户第 3 项已删「回退回合」）",
                  all(k in kp_tools for k in ["要求检定", "递线索", "结团"]), kp_tools[:0])
            await shot(kp, "room_14_kp_tools")

            # v2.0.2 T5 补漏：存档入口可达性。
            # 此前 createSave 只有定义 + 导出、**全仓无任何界面调用** → KP 能列
            # 存档、能载入，却无从创建，「保存整局、改天再开」实际不可用。
            # v2.1.0 #9（用户报）：文案统一为「保存本局」（原「存档 / 读档」改名 —— 用户要求
            # 不要只叫「存档」）。断言随之改为「保存本局」；入口本身仍必须可达。
            check("★ ★ v2.1.0 #9 KP 工具面板/左栏有「保存本局」入口（原文案「存档 / 读档」已改名）",
                  "保存本局" in kp_tools, kp_tools[:0])
            await kp.evaluate(CLICK_BTN_JS, "保存本局")
            await kp.wait_for_timeout(700)
            save_txt = await text(kp)
            check("★ ★ v2.0.2-T5 点开后出现「保存本局」按钮（KP 确实能存整局）",
                  "保存本局" in save_txt, save_txt[:0])
            await shot(kp, "room_15_save_slots")
            # 关掉存档弹层，避免影响后续「结团」步骤（回到 KP 工具弹层）
            await kp.evaluate("() => { UI.closeTopSheet(); return true; }")
            await kp.wait_for_timeout(300)

            # v2.1.0 #11：KP 定向指令 —— 必须**强制选人**（用户：KP 无角色参与，这些是给玩家的
            # 变化，不是 KP 自己检定）→ 未选人时只提示、绝不自发 intent。
            kp_tools2 = await text(kp)
            check("★ ★ v2.1.0 #11 KP 工具面板有 4 个定向指令 + 暗骰入口",
                  all(k in kp_tools2 for k in ["造成伤害", "临时状态", "给物品", "SAN Check", "暗骰"]),
                  kp_tools2[:0])
            seq_before_sel = await kp.evaluate("() => RoomUI._session().host.state.seq")
            await kp.evaluate(CLICK_SUBSTR_JS, "造成伤害")
            await kp.wait_for_timeout(400)
            picker = await kp.evaluate("""() => {
              const m = [...document.querySelectorAll('.sheet-mask')].pop();
              return { open: !!m, txt: m ? m.innerText.slice(0, 90) : '' };
            }""")
            check("★ ★ v2.1.0 #11 点定向指令先弹「选人」层（不直接生效）",
                  bool(picker) and picker["open"] and ('选一个' in picker["txt"] or '选择玩家' in picker["txt"]),
                  picker)
            # v2.1.1（QA 严过关补，任务A）：选人弹层必须出现「👥 全部玩家」入口
            allp_txt = await kp.evaluate("() => { const m=[...document.querySelectorAll('.sheet-mask')].pop();"
                                         " return m ? m.innerText : ''; }")
            check("★ ★ v2.1.1 任务A 定向指令选人弹层出现「👥 全部玩家」入口",
                  ('全部玩家' in allp_txt), allp_txt[:120])
            await kp.evaluate("() => { UI.closeTopSheet(); }")
            await kp.wait_for_timeout(400)
            seq_after_sel = await kp.evaluate("() => RoomUI._session().host.state.seq")
            check("★ ★ v2.1.0 #11 未选目标玩家 → 不产生任何检定/扣血（权威 seq 不变）",
                  seq_after_sel == seq_before_sel,
                  {"before": seq_before_sel, "after": seq_after_sel})

            # ---- v2.1.0 #11 端到端：KP 定点推送 4 个指令 → 玩家侧变化 → 经一次 sync 不丢 ----
            # 反面①（最易漏）：sanitizeSheet 是**白名单**，漏了 tempStatus/items 就是「写了又没写」。
            san_keep = await kp.evaluate("""() => {
              const s = RoomModel.sanitizeSheet({
                tempStatus: [{ text: '中毒 3 轮', by: 'kp', at: 1 }],
                items: [{ name: '手电筒', qty: 1, note: '' }]
              }, {});
              return { tempStatus: (s.tempStatus || []).length, items: (s.items || []).length };
            }""")
            check("★ ★ v2.1.0 #11 sanitizeSheet 不剥离 tempStatus / items",
                  bool(san_keep) and san_keep["tempStatus"] == 1 and san_keep["items"] == 1, san_keep)
            tgt = await kp.evaluate("""() => {
              const m = RoomUI._session().host.state.members.find(x => x.role === 'player');
              return m ? { seat: m.seat, hp: (m.runtime && m.runtime.hp) } : null;
            }""")
            check("★ ★ v2.1.0 #11 前置：KP 拿得到玩家座位", bool(tgt) and bool(tgt["seat"]), tgt)
            await kp.evaluate("""(seat) => {
              const s = RoomUI._session();
              s.side.act({ op: 'sheet.damage',     seat: seat, amount: 2, kind: '测试' });
              s.side.act({ op: 'sheet.tempstatus', seat: seat, text: '中毒 3 轮' });
              s.side.act({ op: 'sheet.item',       seat: seat, name: '手电筒', qty: 1, note: '测试' });
              s.side.act({ op: 'sheet.sancheck',   seat: seat, loss: '1', reason: '看到不可名状' });
            }""", tgt["seat"])
            await kp.wait_for_timeout(1500)
            plv = await wait_for(pl, """() => {
              const s = RoomUI._session();
              const me = (s.client.state.members || []).find(m => m.seat === s.client.seat);
              if (!me) return null;
              const sh = me.sheet || {};
              const ts = (sh.tempStatus || []).map(x => x.text);
              const it = (sh.items || []).map(x => x.name);
              return (ts.indexOf('中毒 3 轮') >= 0 && it.indexOf('手电筒') >= 0)
                ? { hp: (me.runtime || {}).hp, tempStatus: ts, items: it, san: (me.runtime || {}).san } : null;
            }""", timeout=8.0)
            check("★ ★ v2.1.0 #11 4 个定向指令 → 玩家侧可见变化（HP 扣 / 临时状态 / 物品）",
                  bool(plv) and '中毒 3 轮' in plv["tempStatus"] and '手电筒' in plv["items"]
                  and plv["hp"] is not None, plv)
            # v2.1.1（QA 严过关补，任务C）：SAN Check 后玩家**游戏记录**里能看到损失与扣减后的 SAN
            san_log = await wait_for(pl, """() => {
              const g = document.querySelector('.game-page .gp-glog');
              if (!g) return null;
              const t = g.textContent || '';
              if (t.indexOf('理智损失') < 0 || t.indexOf('SAN ') < 0 || t.indexOf('→') < 0) return null;
              const checks = [...g.querySelectorAll('.log-check')].map(x => (x.textContent || '').slice(0, 90));
              return { checks: checks.slice(-3) };
            }""", timeout=8.0)
            check("★ ★ v2.1.1 任务C SAN Check 后玩家游戏记录出现「理智损失 … SAN a → b」",
                  bool(san_log), san_log)
            # QA 诊断：把权威端该成员的 SAN / maxSAN / runtime.san 一并打出来，便于判断日志里的
            # 「SAN a → b」是否与真实状态一致（任务C 的扣减后剩余必须可信）。
            san_diag = await kp.evaluate("""(seat) => {
              const m = RoomUI._session().host.roster.get(seat) || {};
              const st = (m.sheet && m.sheet.status) || {};
              return { sheetSan: (st.currentSAN != null ? st.currentSAN : null),
                       sheetMax: (st.maxSAN != null ? st.maxSAN : null),
                       rtSan: ((m.runtime || {}).san != null ? m.runtime.san : null) };
            }""", tgt["seat"])
            print("  [diag] 任务C SAN 权威值 = " + repr(san_diag), flush=True)
            stored = await pl.evaluate("""() => {
              const s = RoomUI._session();
              const me = (s.client.state.members || []).find(m => m.seat === s.client.seat) || {};
              const cid = me.charId;
              let tc = null;
              try { if (window.RoomStore && RoomStore.getTempCard && cid) tc = RoomStore.getTempCard(s.code, cid); } catch (e) {}
              /* getTempCard 返回**包装对象**（卡在 .card 里）；无临时卡则回落本机 Store 卡 */
              const card = (tc && tc.card) ? tc.card : ((Store.getState().characters || {})[cid] || null);
              return card ? { hasTemp: !!(card.tempStatus && card.tempStatus.length),
                              hasItems: !!(card.items && card.items.length),
                              src: (tc && tc.card) ? 'tempCard' : 'store' } : null;
            }""")
            check("★ ★ v2.1.0 #11 变化落到本机（临时卡 / 本机 Store）",
                  bool(stored) and (stored["hasTemp"] or stored["hasItems"]), stored)
            # 全量 sync 载荷（_makeSync = 重连时真正下发的那份）必须携带新字段
            sync_view = await kp.evaluate("""(seat) => {
              const h = RoomUI._session().host;
              /* _makeSync 返回的是**同步消息** syncMsg(seq, view) → 状态在 .state 里 */
              const msg = h._makeSync(seat, h.state.scene, null);
              const v = (msg && msg.state) ? msg.state : msg;
              const me = (v.members || []).find(m => m.seat === seat);
              const sh = (me && me.sheet) || {};
              return { tempStatus: (sh.tempStatus || []).map(x => x.text),
                       items: (sh.items || []).map(x => x.name) };
            }""", tgt["seat"])
            check("★ ★ v2.1.0 #11 全量 sync 载荷（_makeSync）携带 tempStatus / items（sync 后不丢）",
                  '中毒 3 轮' in sync_view["tempStatus"] and '手电筒' in sync_view["items"], sync_view)
            # 真·驱动一次掉线→重连（走真实 onLinkState），再确认玩家侧仍在
            await pl.evaluate("() => { RoomUI._setLinkState('player', 'offline'); }")
            await pl.wait_for_timeout(300)
            await pl.evaluate("() => { RoomUI._setLinkState('player', 'online'); }")
            await pl.wait_for_timeout(1200)
            after_sync = await pl.evaluate("""() => {
              const s = RoomUI._session();
              const me = (s.client.state.members || []).find(m => m.seat === s.client.seat);
              const sh = (me && me.sheet) || {};
              return { tempStatus: (sh.tempStatus || []).map(x => x.text),
                       items: (sh.items || []).map(x => x.name) };
            }""")
            check("★ ★ v2.1.0 #11 掉线→重连一轮后 tempStatus / items 仍在",
                  '中毒 3 轮' in after_sync["tempStatus"] and '手电筒' in after_sync["items"], after_sync)

            # ---- v2.1.0 #11 补：**界面**必须看得见（不是只测 state）----
            # ① 状态 tab 的 DOM 里出现 KP 推的临时状态
            ts_dom = await pl.evaluate("""() => {
              const c = document.querySelector('.game-page .pl-char-card');
              if (!c) return null;
              return { hasText: (c.textContent || '').indexOf('中毒 3 轮') >= 0,
                       rows: c.querySelectorAll('.tempstatus-row').length };
            }""")
            check("★ ★ v2.1.0 #11 玩家卡（状态 tab）**DOM 里**出现 KP 推的临时状态",
                  bool(ts_dom) and ts_dom["hasText"] and ts_dom["rows"] >= 1, ts_dom)
            # ② 物品 tab 的 DOM 里出现 KP 给的物品，并有分组标注
            #    ⚠️ panelTabs 产出的是 <div.panel-tab>（**不是 button**）→ 不能用 CLICK_EXACT_JS。
            await pl.evaluate("""() => {
              const t = [...document.querySelectorAll('.game-page .pl-char-card .panel-tab')]
                .find(x => x.textContent.trim() === '物品');
              if (t) t.click();
            }""")
            await pl.wait_for_timeout(400)
            it_dom = await pl.evaluate("""() => {
              const c = document.querySelector('.game-page .pl-char-card');
              if (!c) return null;
              const t = c.textContent || '';
              return { hasItem: t.indexOf('手电筒') >= 0,
                       hasGroup: t.indexOf('KP 给予的物资') >= 0,
                       rows: c.querySelectorAll('.char-items .item-row').length };
            }""")
            check("★ ★ v2.1.0 #11 玩家卡（物品 tab）**DOM 里**出现 KP 给的物品（并标注「KP 给予的物资」）",
                  bool(it_dom) and it_dom["hasItem"] and it_dom["hasGroup"] and it_dom["rows"] >= 1, it_dom)
            await pl.evaluate("""() => {
              const t = [...document.querySelectorAll('.game-page .pl-char-card .panel-tab')]
                .find(x => x.textContent.trim() === '状态');
              if (t) t.click();
            }""")
            await pl.wait_for_timeout(300)
            # ③ 跨路径：再重连一次（触发 resendBoundSheet），界面上的临时状态**仍在**
            await pl.evaluate("() => { RoomUI._setLinkState('player', 'offline'); }")
            await pl.wait_for_timeout(300)
            await pl.evaluate("() => { RoomUI._setLinkState('player', 'online'); }")
            await pl.wait_for_timeout(1200)
            ts_dom2 = await pl.evaluate("""() => {
              const c = document.querySelector('.game-page .pl-char-card');
              if (!c) return null;
              return { hasText: (c.textContent || '').indexOf('中毒 3 轮') >= 0,
                       rows: c.querySelectorAll('.tempstatus-row').length };
            }""")
            check("★ ★ v2.1.0 #11 跨路径：重连一轮后界面上的临时状态**仍在**（覆盖模型侧根因）",
                  bool(ts_dom2) and ts_dom2["hasText"] and ts_dom2["rows"] >= 1, ts_dom2)

            # =========================================================
            # H. 结团 + 归档（v1.18.5：游戏页里走「🧰 KP 工具 → 结团」）
            # =========================================================
            print("\n== H、结团与归档 ==", flush=True)
            # 「🏁 结团」是 <div class="tool">（toolBtn 产出）且文案带 emoji，
            # 必须用按子串、且能点到非 button 元素的方式 —— 见 CLICK_SUBSTR_JS。
            clicked_end = await kp.evaluate(CLICK_SUBSTR_JS, "结团")
            check("★ 点得到「🏁 结团」工具卡", clicked_end is True, clicked_end)
            await kp.wait_for_timeout(600)
            confirm_txt = await kp.evaluate("""() => {
              const m = [...document.querySelectorAll('.sheet-mask')].pop();
              return m ? m.innerText : '';
            }""")
            check("★ 结团有二次确认，并说明会归档", "归档" in confirm_txt, confirm_txt[:120])
            ok_confirm = await kp.evaluate(CONFIRM_JS)
            check("★ 确认按钮点得动", ok_confirm is True)
            await kp.wait_for_timeout(1600)

            check("★ 结团后回到房间入口页",
                  (await kp.evaluate("() => location.hash")) == "#/room",
                  await kp.evaluate("() => location.hash"))
            archived = await kp.evaluate("""() => {
              const a = RoomStore.listArchive() || [];
              return a.length ? { n: a.length, name: (a[0].name || a[0].roomName || ''), members: (a[0].members || []).length } : null;
            }""")
            check("★ 本次团已归档到本机", bool(archived), archived)
            await shot(kp, "room_10_after_close")

            # 玩家侧应感知房间结束
            await pl.wait_for_timeout(900)
            ps6 = await session(pl)
            check("★ 玩家侧状态被标记为已结束",
                  (ps6 or {}).get("status") == "CLOSED", (ps6 or {}).get("status"))

            # =========================================================
            # I. 服务器地址 vs 局域网直连：能不能切回去
            #
            # 复现用户报的问题：
            #   点了「用本机开房」→ 局域网地址被注入，它**盖过**设置里填的
            #   公网服务器地址 → 界面显示的是局域网地址、检测连通性测的也是它，
            #   而且当时**没有任何入口**能关掉内嵌服务器，于是切不回公网开房。
            #
            # 用一个假的 AndroidBridge 让「局域网直连」卡片在浏览器里也能渲染出来，
            # 这样这条路径才能被真正跑一遍（真机之外唯一可行的办法）。
            # =========================================================
            print("\n== I、服务器地址与局域网直连的切换 ==", flush=True)
            ctx_lan = await browser.new_context(viewport={"width": 412, "height": 900})
            await ctx_lan.add_init_script(FAKE_BRIDGE_JS)
            lan = await ctx_lan.new_page()
            lan.on("pageerror", lambda e: errors.append("[局域网] %s" % e))
            lan.on("console", lambda m: errors.append("[局域网] %s" % m.text) if m.type == "error" else None)

            await lan.goto(BASE)
            await lan.wait_for_timeout(1200)
            await lan.evaluate("() => { try { localStorage.clear(); } catch (e) {} }")
            await lan.reload()
            await lan.wait_for_timeout(1200)

            # 用户在设置里填好公网服务器地址（这里用一个本地地址，避免测试依赖外网）
            static_base = "http://127.0.0.1:%d" % STATIC_PORT
            await lan.evaluate("(b) => Store.setSettings({ roomBase: b })", static_base)
            await lan.evaluate("() => App.go('#/room')")
            await lan.wait_for_timeout(700)

            t = await text(lan)
            check("★ App 里能看到「局域网直连」卡片", "局域网直连" in t and "用本机开房" in t, t[:0])
            # 注意不能断言「公网」：测试里用的是 127.0.0.1，它被正确判为局域网地址
            check("★ 未开本机服务时，房间服务用的是「你设置的服务器」",
                  ("你设置的服务器" in t) and (static_base in t), t[:0])
            check("★ 此时不显示「停用局域网直连」", "停用局域网直连" not in t)
            await shot(lan, "room_11_lan_idle")

            # --- 点「用本机开房」：局域网地址生效，并把设置里的地址压下去 ---
            await lan.evaluate(CLICK_BTN_JS, "用本机开房")
            await lan.wait_for_timeout(900)
            await lan.evaluate("() => UI.closeAllSheets()")   # 关掉随后弹出的创建弹层
            await lan.wait_for_timeout(400)

            inj = await lan.evaluate("() => window.ROOM_SERVER_BASE || ''")
            check("★ 本机服务启动后注入了局域网地址",
                  inj == "http://192.168.9.9:4211", inj)

            resolved = await lan.evaluate("() => RoomNet.resolve()")
            check("★ 生效地址切成了局域网直连",
                  resolved.get("source") == "injected", resolved)

            t = await text(lan)
            check("★ 房间服务卡片改显示局域网地址", "http://192.168.9.9:4211" in t, t[:0])
            check("★ ★ 并且明说「你设置的地址暂时不生效」（这次修复的核心）",
                  ("不生效" in t) and (static_base in t), t[:0])
            check("★ ★ 给出了关闭入口「停用局域网直连」", "停用局域网直连" in t)
            check("★ 局域网卡片显示服务器运行中 + 关闭按钮",
                  ("服务器运行中" in t) and ("关闭服务器" in t), t[:0])

            # --- 检测连通性：必须说清「测的是哪个地址」 ---
            # ⚠️ 等待窗口要盖住 DEFAULT_TIMEOUTS.health（12 秒）：
            #    192.168.9.9 不可路由，请求会挂满 12 秒才报错。
            #    超时类失败**不会**整轮重试（room-net.js#req 特意不做，否则手机要干等 ~24 秒），
            #    所以最坏就是 ~12 秒，20 秒窗口足够。
            #    ⚠️ 改超时预算时这里要一起改，否则会误判成「提示没出现」。
            await lan.evaluate(CLICK_EXACT_JS, "检测连通性")
            probe_txt = await wait_for(lan, """() => {
              const n = document.querySelector('.notice.err');
              return n ? n.innerText : null;
            }""", timeout=22.0)
            check("★ ★ 连不上时提示里点名了「试的是哪个地址」",
                  bool(probe_txt) and "192.168.9.9:4211" in probe_txt, probe_txt)
            check("★ 不再出现裸的「Failed to fetch」",
                  bool(probe_txt) and "Failed to fetch" not in probe_txt, probe_txt)
            lan_hint = await text(lan)
            check("★ 并且给出可行动的原因（同一 WiFi / AP 隔离）",
                  ("AP 隔离" in lan_hint) or ("同一个 WiFi" in lan_hint), lan_hint[:0])
            await shot(lan, "room_12_lan_probe")

            # --- 关掉本机服务器：设置里的地址必须立刻生效 ---
            await lan.evaluate(CLICK_BTN_JS, "停用局域网直连")
            await lan.wait_for_timeout(900)

            check("★ 关闭后注入被清掉",
                  not (await lan.evaluate("() => window.ROOM_SERVER_BASE || ''")))
            resolved2 = await lan.evaluate("() => RoomNet.resolve()")
            check("★ ★ 生效地址立刻回到「你设置的服务器」",
                  resolved2.get("source") == "user" and resolved2.get("base") == static_base,
                  resolved2)

            # 读正文时排除 toast：stopLanNow() 会弹「已停用局域网直连」，
            # 那句话会让「关闭入口是否还在」的断言假失败
            t = await lan.evaluate(TEXT_NO_TOAST_JS)
            check("★ 关闭后卡片重新显示设置里的地址，且不再警告「不生效」",
                  (static_base in t) and ("不生效" not in t), t[:0])
            check("★ 关闭入口消失（不再显示停用）", "停用局域网直连" not in t, t[:0])
            check("★ 局域网卡片回到「用本机开房」初始态",
                  "用本机开房" in t and "服务器运行中" not in t, t[:0])
            await shot(lan, "room_13_back_to_server")

            # --- 再检测一次：这次测的必须是设置的地址（本地静态站 → HTTP 404） ---
            # 404 是「服务答了但拒绝」，会立刻返回，不需要等超时；
            # 窗口留 20 秒只是为了兼容最坏情况（静态站偶发慢）。
            await lan.evaluate(CLICK_EXACT_JS, "检测连通性")
            probe2 = await wait_for(lan, """() => {
              const n = document.querySelector('.notice.err');
              return n ? n.innerText : null;
            }""", timeout=20.0)
            check("★ ★ 第二次检测测的是设置的地址，不再是局域网地址",
                  bool(probe2) and static_base in probe2 and "192.168.9.9" not in probe2, probe2)
            check("★ 能连上但被拒时，明确说是 HTTP 层的问题",
                  bool(probe2) and "HTTP" in (await text(lan)), probe2)

            # --- 网络自检：必须真的跑，并给出可截图的结论（§2.3 不许假入口） ---
            # 用户报「开房连不上」而我们这边测服务器一切正常，唯一的办法是
            # 把探测点移到他的手机上。所以要确认这个按钮真的跑完了整条链路。
            #
            # ⚠️ 不要断言「正在检测」那句加载文案：命中本地静态站时自检 3ms 就跑完了，
            #    加载态转瞬即逝，断言它等于在赌时序。只断言**稳定存在**的东西：
            #    弹层标题、逐步结果、结论。
            await lan.evaluate(CLICK_EXACT_JS, "网络自检")
            await lan.wait_for_timeout(400)
            sc_head = await lan.evaluate("""() => {
              const s = document.querySelector('.sheet');
              return s ? s.innerText : '';
            }""")
            check("★ 网络自检弹层打开（标题正确）",
                  "网络自检" in sc_head, sc_head[:120])

            # 地址不通时，最后必须给出结论（而不是一直转圈）
            verdict = await wait_for(lan, """() => {
              const n = document.querySelector('.sheet .notice');
              return n ? n.innerText : null;
            }""", timeout=40.0)
            check("★ ★ 自检跑完并给出结论（不是一直转圈）",
                  bool(verdict) and ("换" in verdict or "浏览器" in verdict or "正常" in verdict
                                     or "错误码" in verdict),
                  verdict)

            # ⚠️ 结论必须与**实际失败类型**一致。本地静态站对 /room/health 回 404，
            #    那是「服务答了」而不是「连不上」—— 结论里绝不能出现「解析失败」，
            #    因为 404 恰恰证明域名解析是成功的。说错话比不说更糟。
            check("★ ★ HTTP 404 时结论说「服务答了」而不是「域名解析失败」",
                  bool(verdict) and ("答了" in verdict) and ("解析/连接失败" not in verdict),
                  verdict)

            sc_txt = await lan.evaluate("""() => {
              const s = document.querySelector('.sheet');
              return s ? s.innerText : '';
            }""")
            check("★ 自检逐步列出结果（能看出卡在哪一步）",
                  ("地址配置" in sc_txt) and ("连通" in sc_txt), sc_txt[:200])
            check("★ 自检结论里带上实际地址（用户能核对）",
                  static_base in sc_txt, sc_txt[:300])
            check("★ 自检给出可复制结论的入口",
                  "复制结论" in sc_txt, sc_txt[-300:])
            await shot(lan, "room_14_selfcheck")

            # --- 局域网自检：房主连不上自己时，必须能查出是三种原因里的哪一种 ---
            #
            # 用户这次报的正是「局域网模式开房还是会提示无法连接」。局域网失败只有
            # 三种成因（服务没起 / 明文被拦 / 不在同一 WiFi·AP 隔离），从外部看完全
            # 一样。这里跑的是「服务在跑、但本机 IP 打不通」这一支 —— 最容易被误诊
            # 成「服务没起」的那种，靠回环探针才能分清。
            #
            # ⚠️ 前面 §I 的第 3 段已经把内嵌服务**关掉了**（点了「停用局域网直连」），
            #    而「局域网自检」入口只在服务运行时出现。所以这里必须先把服务重新
            #    起来，否则按钮根本不在页面上（第一次写这段就是这么误报的）。
            await lan.evaluate("() => UI.closeAllSheets()")
            await lan.wait_for_timeout(300)
            await lan.evaluate("() => RoomLan.start()")
            await lan.evaluate("() => App.go('#/room')")
            await lan.wait_for_timeout(700)

            # 入口按钮的文案带用途说明（「同伴连不上时点这里」），所以按**子串**找，
            # 不能用 CLICK_EXACT_JS（它要求整串完全相同）。
            lan_btn = await lan.evaluate("""() => {
              const b = [...document.querySelectorAll('button')]
                .find(x => x.textContent.indexOf('局域网自检') >= 0);
              if (!b) return false;
              b.click();
              return true;
            }""")
            check("★ 局域网卡片上有「局域网自检」入口（§2.3 不许假入口）", lan_btn is True, lan_btn)
            await lan.wait_for_timeout(400)
            lc_head = await lan.evaluate("""() => {
              const s = document.querySelector('.sheet');
              return s ? s.innerText : '';
            }""")
            check("★ 局域网自检弹层打开（标题正确）",
                  "局域网自检" in lc_head, lc_head[:120])

            # 结论必须落在四种判读之一（而不是一直转圈）
            lc_verdict = await wait_for(lan, """() => {
              const n = document.querySelector('.sheet .notice');
              return n ? n.innerText : null;
            }""", timeout=30.0)
            check("★ ★ 局域网自检跑完并给出判读",
                  bool(lc_verdict) and any(k in lc_verdict for k in
                                           ("本机服务是好的", "本机服务", "局域网服务",
                                            "是活着的", "超时", "两个地址都连不上")),
                  lc_verdict)

            lc_txt = await lan.evaluate("""() => {
              const s = document.querySelector('.sheet');
              return s ? s.innerText : '';
            }""")
            check("★ 局域网自检列出了本机地址与回环地址两探（判读靠对比这两步）",
                  ("192.168.9.9:4211" in lc_txt) and ("127.0.0.1:4211" in lc_txt), lc_txt[:300])
            check("★ 局域网自检也给出可复制结论的入口",
                  "复制结论" in lc_txt, lc_txt[-300:])
            await shot(lan, "room_15_lan_check")

            # 局域网失败时的报错文案：绝不能出现「域名解析失败」（裸 IP 没有域名）
            lan_err = await lan.evaluate("""async () => {
              try {
                await RoomNet.req('GET', '/health', null, 2500, 0);
                return '(没抛错)';
              } catch (e) { return e.message || ''; }
            }""")
            check("★ ★ 局域网地址的报错不再说「域名解析失败」",
                  "域名解析失败" not in lan_err, lan_err)

            await ctx_lan.close()

            # =========================================================
            # J. 游戏页可滚动（T02）：360×640 小屏下顶部/底部不能被切掉
            #
            # 缺陷：.game-page 是 position:fixed;inset:0;overflow:hidden，
            # 而内部若干固定 vh 的子块高度之和 > 视口 → 顶部 KP 栏 / 底部工具栏
            # 被切掉、且整页划不动。修法：overflow-y:auto + 固定高度改 min/max。
            # =========================================================
            print("\n== J、游戏页可滚动（360×640 小屏）==", flush=True)
            ctx_sm = await browser.new_context(viewport={"width": 360, "height": 640})
            ctx_sm_p = await browser.new_context(viewport={"width": 360, "height": 640})
            sm = await ctx_sm.new_page()
            smp = await ctx_sm_p.new_page()
            for pg, tag in ((sm, "小屏KP"), (smp, "小屏玩家")):
                pg.on("pageerror", lambda e, t=tag: errors.append("[%s] %s" % (t, e)))
                pg.on("console", lambda m, t=tag: errors.append("[%s] %s" % (t, m.text))
                      if m.type == "error" else None)
            sm_code = await make_room(sm, "小屏滚动团", "KP小屏", ROOM_BASE)
            check("★ 小屏建房成功", bool(sm_code), sm_code)
            sm_ps = await join_room(smp, sm_code, "小屏玩家", ROOM_BASE)
            check("★ 小屏玩家加入成功", bool(sm_ps) and sm_ps["role"] == "player", sm_ps and sm_ps["role"])
            await start_game(sm, smp)
            check("★ 小屏已开团（进入 .game-page）",
                  await sm.evaluate("() => !!document.querySelector('.game-page')"))

            gp_css = await sm.evaluate("""() => {
              const gp = document.querySelector('.game-page');
              if (!gp) return null;
              const cs = getComputedStyle(gp);
              return { oy: cs.overflowY, ox: cs.overflowX, pos: cs.position,
                       scrollH: gp.scrollHeight, clientH: gp.clientHeight };
            }""")
            check("★ ★ .game-page 允许纵向滚动（overflow-y 为 auto/scroll）",
                  bool(gp_css) and gp_css["oy"] in ("auto", "scroll"), gp_css)
            check("★ .game-page 不出现横向滚动条",
                  bool(gp_css) and gp_css["ox"] in ("hidden", "clip"), gp_css)

            tb_rect = await sm.evaluate("""() => {
              const t = document.querySelector('.gp-toolbar');
              if (!t) return null;
              t.scrollIntoView({ block: 'end' });
              const r = t.getBoundingClientRect();
              return { bottom: Math.round(r.bottom), top: Math.round(r.top),
                       innerH: window.innerHeight };
            }""")
            check("★ ★ 滚到底后工具栏完整可见（bottom ≤ 视口高度，不被切掉）",
                  bool(tb_rect) and tb_rect["bottom"] <= tb_rect["innerH"] + 1, tb_rect)

            # 更强的判据：底部工具栏必须**真的能被点到**（用户原话「底部的东西点不到」）。
            # 用 elementFromPoint 命中测试：点在工具栏矩形内，命中的元素必须属于工具栏。
            tb_hit = await sm.evaluate("""() => {
              const t = document.querySelector('.gp-toolbar');
              if (!t) return null;
              t.scrollIntoView({ block: 'end' });
              const r = t.getBoundingClientRect();
              const cx = Math.round(r.left + r.width / 2);
              const cy = Math.round(Math.min(r.bottom - 6, window.innerHeight - 6));
              const el = document.elementFromPoint(cx, cy);
              return { bottom: Math.round(r.bottom), innerH: window.innerHeight,
                       inToolbar: !!(el && t.contains(el)),
                       hitTag: el ? el.tagName : null };
            }""")
            check("★ ★ 底部工具栏在视口内且可被点到（命中测试通过）",
                  bool(tb_hit) and tb_hit["inToolbar"] is True, tb_hit)

            scroll_ok = await sm.evaluate("""() => {
              const gp = document.querySelector('.game-page');
              if (!gp) return null;
              const maxScroll = gp.scrollHeight - gp.clientHeight;
              gp.scrollTop = 0;
              gp.scrollTop = maxScroll;
              return { maxScroll: maxScroll, scrolled: gp.scrollTop };
            }""")
            check("★ 游戏页内容超出视口时真的能滚（scrollTop 能前进到上限）",
                  bool(scroll_ok) and (scroll_ok["maxScroll"] <= 0 or scroll_ok["scrolled"] > 0), scroll_ok)

            top_ok = await sm.evaluate("""() => {
              const gp = document.querySelector('.game-page');
              if (!gp) return null;
              gp.scrollTop = 0;
              const h = document.querySelector('.gp-kpbar');
              if (!h) return null;
              return { top: Math.round(h.getBoundingClientRect().top) };
            }""")
            check("★ 顶部 KP 栏在视口内（顶部不被切掉）",
                  bool(top_ok) and top_ok["top"] >= -1, top_ok)
            await shot(sm, "room_16_small_scroll")
            await ctx_sm.close()
            await ctx_sm_p.close()

            # =========================================================
            # K. 手绘板 / 标记（T03）：一律用**真实触摸事件**驱动
            #
            # 血泪教训：上一轮用「只找 <button> 且要求整串文字相等」的 helper 去点
            # 一个 <div>，点击根本没落地，但弱断言照样变绿 —— 「鼠标过、真机挂」。
            # 这一轮：Playwright has_touch + is_mobile，用 CDP Input.dispatchTouchEvent
            # （touchStart → 多个 touchMove → touchEnd）驱动；断言直接查 DOM 里是否真的
            # 有 svg > path、其命名空间是否为 SVG、以及是否有 svg 祖先。
            # 只断言「数据里多了笔迹」是不够的 —— 那正是「画得上、看不见」的原症状。
            # =========================================================
            print("\n== K、手绘板与标记（真实触摸）==", flush=True)
            ctx_t_kp = await browser.new_context(viewport={"width": 412, "height": 900},
                                                 has_touch=True, is_mobile=True)
            ctx_t_p = await browser.new_context(viewport={"width": 412, "height": 900},
                                                has_touch=True, is_mobile=True)
            tkp = await ctx_t_kp.new_page()
            tpl = await ctx_t_p.new_page()
            for pg, tag in ((tkp, "触KP"), (tpl, "触玩家")):
                pg.on("pageerror", lambda e, t=tag: errors.append("[%s] %s" % (t, e)))
                pg.on("console", lambda m, t=tag: errors.append("[%s] %s" % (t, m.text))
                      if m.type == "error" else None)

            t_code = await make_room(tkp, "触摸团", "KP触", ROOM_BASE)
            check("★ 触摸上下文建房成功", bool(t_code), t_code)
            ts = await join_room(tpl, t_code, "触屏小明", ROOM_BASE)
            check("★ 触摸上下文玩家加入成功", bool(ts) and ts["role"] == "player", ts and ts["role"])
            await start_game(tkp, tpl)
            check("★ 触摸上下文已开团（进入游戏页）",
                  await tkp.evaluate("() => !!document.querySelector('.game-page')"))

            # --- T03-画板（KP 地图笔迹）：切到「画笔」，真实触摸拖拽 ---
            # v2.0.0：F2 把工具挪进 KP 工具窄栏，并把旧版的「画线」改名为「✏️ 画笔」。
            # 先把工具模式切到画笔（新旧两种叫法都试一次），再打开地图弹层去画。
            drew = await tkp.evaluate(CLICK_BTN_JS, "画笔")
            if not drew:
                drew = await tkp.evaluate(CLICK_SUBSTR_JS, "画线")
            await tkp.wait_for_timeout(400)
            await tkp.evaluate(CLICK_BTN_JS, "素材与地图")
            await tkp.wait_for_timeout(600)
            stage = await rect_of(tkp, ".sheet .map-stage")
            check("★ KP 地图舞台可定位（用于触摸）", bool(stage) and stage["w"] > 10, stage)
            await touch_drag(tkp,
                             stage["x"] + stage["w"] * 0.20, stage["y"] + stage["h"] * 0.30,
                             stage["x"] + stage["w"] * 0.75, stage["y"] + stage["h"] * 0.65)
            kp_stroke = await wait_for(tkp, """() => {
              const s = [...document.querySelectorAll('.sheet .map-stage')].pop();
              if (!s) return null;
              const paths = [...s.querySelectorAll('svg > path')];
              if (!paths.length) return null;
              const p = paths[paths.length - 1];
              return { n: paths.length, ns: p.namespaceURI, hasSvg: !!p.closest('svg'),
                       tag: p.tagName.toLowerCase(),
                       model: (RoomUI._session().host.state.scene.strokes || []).length };
            }""", timeout=6.0)
            check("★ ★ 触摸拖动画线：DOM 里真的出现 svg > path（不是只有数据）",
                  bool(kp_stroke) and kp_stroke["n"] >= 1 and kp_stroke["tag"] == "path", kp_stroke)
            check("★ ★ 笔迹元素的命名空间是 SVG（不是 XHTML —— 旧 bug 就是命名空间错）",
                  bool(kp_stroke) and kp_stroke["ns"] == "http://www.w3.org/2000/svg", kp_stroke)
            check("★ ★ 笔迹 path 有 svg 祖先（否则不会被渲染）",
                  bool(kp_stroke) and kp_stroke["hasSvg"] is True, kp_stroke)
            check("★ 权威状态里也确实记下了这条笔迹（数据与 DOM 一致）",
                  bool(kp_stroke) and kp_stroke["model"] >= 1, kp_stroke)
            # v2.1.1（用户第 4 项）：pointercancel（系统抢走手势）也必须提交已画笔迹。
            # touchCancel 不发 pointerup → 旧实现整笔丢失（真机「画到一半全没了」）。
            kp_n0 = await tkp.evaluate(
                "() => (RoomUI._session().host.state.scene.strokes || []).length")
            await touch_drag_cancel(tkp,
                                    stage["x"] + stage["w"] * 0.30, stage["y"] + stage["h"] * 0.35,
                                    stage["x"] + stage["w"] * 0.85, stage["y"] + stage["h"] * 0.75)
            kp_n1 = await wait_for(tkp, """(n0) => {
              const n = (RoomUI._session().host.state.scene.strokes || []).length;
              return n > n0 ? n : null;
            }""", kp_n0, timeout=4.0)
            check("★ ★ v2.1.1 用户第 4 项 touchCancel 后已画笔迹仍在（onDone 在 pointercancel 也触发）",
                  bool(kp_n1) and kp_n1 > kp_n0, {"before": kp_n0, "after": kp_n1})
            await shot(tkp, "room_17_touch_kp_stroke")
            await tkp.evaluate("() => UI.closeAllSheets()")
            await tkp.wait_for_timeout(300)

            # --- T03-标记：切回「放标记」模式，真实触摸单击放标记 ---
            # v2.0.0：F2 用图标网格（.icon-cell）进入标记模式（旧版是「放标记」按钮）。
            # 必须先切回标记模式 —— 上一步刚把工具模式改成了画笔。
            marked = await tkp.evaluate("""() => {
              const c = document.querySelector('.icon-cell');
              if (c) { c.click(); return true; }
              return false;
            }""")
            if not marked:
                await tkp.evaluate(CLICK_SUBSTR_JS, "放标记")
            await tkp.wait_for_timeout(300)
            await tkp.evaluate(CLICK_BTN_JS, "素材与地图")
            await tkp.wait_for_timeout(600)
            stage2 = await rect_of(tkp, ".sheet .map-stage")
            touchable = await tkp.evaluate("""() => {
              const s = [...document.querySelectorAll('.sheet .map-stage')].pop();
              return s ? { touchStage: s.classList.contains('touch-stage'),
                           cursor: getComputedStyle(s).cursor } : null;
            }""")
            check("★ 标记模式下舞台挂上了触摸加固类 .touch-stage",
                  bool(touchable) and touchable["touchStage"] is True, touchable)

            # 系统 prompt 会弹出来 —— 交给 Playwright 接受（真机上用户手输）
            async def _accept_dialog(d):
                try:
                    await d.accept("触摸标记")
                except Exception:
                    pass
            tkp.on("dialog", lambda d: asyncio.ensure_future(_accept_dialog(d)))

            # 记录舞台上的输入事件（失败时能一眼看出是「事件没到」还是「逻辑没跑」）
            await tkp.evaluate("""() => {
              window.__evtLog = [];
              const s = [...document.querySelectorAll('.sheet .map-stage')].pop();
              if (s) ['pointerdown','pointermove','pointerup','pointercancel',
                      'touchstart','touchmove','touchend','click','contextmenu']
                .forEach(t => s.addEventListener(t, () => window.__evtLog.push(t), true));
            }""")
            await touch_tap(tkp, stage2["x"] + stage2["w"] * 0.55,
                            stage2["y"] + stage2["h"] * 0.45)
            kp_mark = await wait_for(tkp, """() => {
              const st = RoomUI._session().host.state;
              const marks = (st.scene || {}).marks || [];
              if (!marks.length) return null;
              const m = marks[marks.length - 1];
              const s = [...document.querySelectorAll('.sheet .map-stage')].pop();
              return { n: marks.length, x: m.x, y: m.y, label: m.label,
                       dom: s ? s.querySelectorAll('.mk').length : -1 };
            }""", timeout=4.0)
            evt_log = await tkp.evaluate("() => window.__evtLog || []")
            if not kp_mark:
                # 兜底：换 Playwright 自带的真实触摸单击（同样是真触摸，不是 mouse）
                await tkp.touchscreen.tap(stage2["x"] + stage2["w"] * 0.55,
                                          stage2["y"] + stage2["h"] * 0.45)
                kp_mark = await wait_for(tkp, """() => {
                  const st = RoomUI._session().host.state;
                  const marks = (st.scene || {}).marks || [];
                  if (!marks.length) return null;
                  const m = marks[marks.length - 1];
                  const s = [...document.querySelectorAll('.sheet .map-stage')].pop();
                  return { n: marks.length, x: m.x, y: m.y, label: m.label,
                           dom: s ? s.querySelectorAll('.mk').length : -1 };
                }""", timeout=4.0)
                evt_log2 = await tkp.evaluate("() => window.__evtLog || []")
            else:
                evt_log2 = evt_log
            check("★ ★ 触摸单击真的放下了标记（权威状态里有）",
                  bool(kp_mark) and kp_mark["n"] >= 1,
                  {"mark": kp_mark, "evt": evt_log2})
            check("★ ★ 标记落在点的地方（相对坐标 0..1，且贴近点击位置）",
                  bool(kp_mark) and 0.35 <= kp_mark["x"] <= 0.75 and 0.25 <= kp_mark["y"] <= 0.65, kp_mark)
            check("★ ★ 舞台 DOM 里真的画出了标记元素 .mk",
                  bool(kp_mark) and kp_mark["dom"] >= 1, kp_mark)
            await shot(tkp, "room_18_touch_kp_mark")
            await tkp.evaluate("() => UI.closeAllSheets()")
            await tkp.wait_for_timeout(300)

            # --- T03-画板（玩家个人手绘板）：真实触摸拖拽 ---
            await tpl.evaluate(CLICK_BTN_JS, "我的手绘板")
            await tpl.wait_for_timeout(600)
            board = await rect_of(tpl, ".sheet .board-stage")
            check("★ 玩家手绘板舞台可定位（用于触摸）", bool(board) and board["w"] > 10, board)
            await tpl.evaluate("""() => {
              window.__evtLog2 = [];
              const s = [...document.querySelectorAll('.sheet .board-stage')].pop();
              if (s) ['pointerdown','pointermove','pointerup','pointercancel',
                      'touchstart','touchmove','touchend','click']
                .forEach(t => s.addEventListener(t, () => window.__evtLog2.push(t), true));
            }""")
            await touch_drag(tpl,
                             board["x"] + board["w"] * 0.15, board["y"] + board["h"] * 0.20,
                             board["x"] + board["w"] * 0.80, board["y"] + board["h"] * 0.70)
            pl_stroke = await wait_for(tpl, """() => {
              const s = [...document.querySelectorAll('.sheet .board-stage')].pop();
              if (!s) return null;
              const paths = [...s.querySelectorAll('svg > path')];
              if (!paths.length) return null;
              const p = paths[paths.length - 1];
              return { n: paths.length, ns: p.namespaceURI, hasSvg: !!p.closest('svg'),
                       tag: p.tagName.toLowerCase(),
                       model: ((RoomUI._session().client.state.board || {}).strokes || []).length };
            }""", timeout=8.0)
            pl_evt = await tpl.evaluate("""() => {
              const s = [...document.querySelectorAll('.sheet .board-stage')].pop();
              const log = window.__evtLog2 || [];
              return { evt: log.slice(0, 12),
                       board: ((RoomUI._session().client.state.board || {}).strokes || []).length,
                       stage: !!s };
            }""")
            check("★ ★ 玩家触摸拖动画板：DOM 里真的出现 svg > path",
                  bool(pl_stroke) and pl_stroke["n"] >= 1 and pl_stroke["tag"] == "path",
                  {"stroke": pl_stroke, "diag": pl_evt})
            check("★ ★ 手绘板笔迹命名空间是 SVG",
                  bool(pl_stroke) and pl_stroke["ns"] == "http://www.w3.org/2000/svg", pl_stroke)
            check("★ ★ 手绘板笔迹 path 有 svg 祖先（旧 bug：命名空间对但没有 svg 根 → 看不见）",
                  bool(pl_stroke) and pl_stroke["hasSvg"] is True, pl_stroke)
            check("★ 手绘板笔迹也真的回到了本人（数据与 DOM 一致）",
                  bool(pl_stroke) and pl_stroke["model"] >= 1, {"stroke": pl_stroke, "diag": pl_evt})
            await shot(tpl, "room_19_touch_player_board")
            await ctx_t_kp.close()
            await ctx_t_p.close()

            # =========================================================
            # L. 素材 / 公开状态链路（T04）：弹层不关也要立刻刷新
            #
            # 缺陷：sheet() 只在打开那一刻渲染一次（body 是一次性节点），
            # paint() 只重画底层页面，不重画弹层 → 「KP 上传素材后，素材与地图
            # 弹层里看不到新素材」「点了发布，格子样式不变」，用户以为功能坏了。
            # =========================================================
            print("\n== L、素材弹层实时刷新（T04）==", flush=True)
            ctx_r_kp = await browser.new_context(viewport={"width": 412, "height": 900})
            ctx_r_p = await browser.new_context(viewport={"width": 412, "height": 900})
            rkp = await ctx_r_kp.new_page()
            rpl = await ctx_r_p.new_page()
            for pg, tag in ((rkp, "刷KP"), (rpl, "刷玩家")):
                pg.on("pageerror", lambda e, t=tag: errors.append("[%s] %s" % (t, e)))
                pg.on("console", lambda m, t=tag: errors.append("[%s] %s" % (t, m.text))
                      if m.type == "error" else None)

            r_code = await make_room(rkp, "素材刷新团", "KP刷", ROOM_BASE)
            check("★ 素材刷新团建房成功", bool(r_code), r_code)
            rs = await join_room(rpl, r_code, "刷新小明", ROOM_BASE)
            check("★ 素材刷新团玩家加入成功", bool(rs) and rs["role"] == "player", rs and rs["role"])
            await start_game(rkp, rpl)

            # KP 打开「素材与地图」弹层（不关）
            await rkp.evaluate(CLICK_BTN_JS, "素材与地图")
            await rkp.wait_for_timeout(600)
            check("★ KP 打开了「素材与地图」弹层",
                  await rkp.evaluate("() => !!document.querySelector('.sheet')") is True)

            before_cells = await rkp.evaluate("""() => {
              const s = document.querySelector('.sheet');
              return s ? s.innerText.indexOf('洋馆一层') >= 0 : null;
            }""")
            check("★ 上传前弹层里没有该素材", before_cells is False, before_cells)

            # 不关弹层，直接加素材
            await rkp.evaluate("""() => {
              RoomUI._session().side.act({ op: 'asset.add',
                asset: { kind: 'map', name: '洋馆一层',
                         data: 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=' } });
            }""")
            appeared = await wait_for(rkp, """() => {
              const s = document.querySelector('.sheet');
              if (!s) return null;
              const c = [...s.querySelectorAll('.asset-cell')]
                .find(x => x.innerText.indexOf('洋馆一层') >= 0);
              return c ? { secret: c.classList.contains('secret') } : null;
            }""", timeout=5.0)
            check("★ ★ 不关弹层，上传后素材立刻出现在弹层 DOM 里（旧 bug：要关掉重开才看得到）",
                  bool(appeared), appeared)
            check("★ 新素材默认是「未公开」样式（.secret）",
                  bool(appeared) and appeared["secret"] is True, appeared)

            # 点一下素材格子 → 立刻变成「已公开」样式；玩家侧也应收到
            clicked_cell = await rkp.evaluate("""() => {
              const s = document.querySelector('.sheet');
              const c = [...s.querySelectorAll('.asset-cell')]
                .find(x => x.innerText.indexOf('洋馆一层') >= 0);
              if (!c) return false;
              c.click();
              return true;
            }""")
            check("★ 点得到素材格子", clicked_cell is True)
            published = await wait_for(rkp, """() => {
              const s = document.querySelector('.sheet');
              if (!s) return null;
              const c = [...s.querySelectorAll('.asset-cell')]
                .find(x => x.innerText.indexOf('洋馆一层') >= 0);
              if (!c) return null;
              return { secret: c.classList.contains('secret') };
            }""", timeout=5.0)
            check("★ ★ 点一下格子后它立刻变成「已公开」样式（弹层没关）",
                  bool(published) and published["secret"] is False, published)
            r_pl_assets = await wait_for(rpl, """() => {
              const a = (RoomUI._session().client.state.scene || {}).assets || [];
              return a.length ? a.map(x => x.name) : null;
            }""", timeout=8.0)
            check("★ ★ 玩家侧状态里也收到了这个素材",
                  bool(r_pl_assets) and "洋馆一层" in r_pl_assets, r_pl_assets)
            # v2.1.1（用户第 1 项「素材已公开但玩家看不到图」）：光有状态不够 ——
            #   玩家端**DOM** 必须真的渲染出这张图。此前玩家端没有任何公开素材区，
            #   只有「恰好被选作中央底图的那一张」可见 → 公开多张时其余全看不到。
            _asset_data = 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA='
            r_pl_img = await wait_for(rpl, """(data) => {
              const imgs = [...document.querySelectorAll('.game-page img')]
                .filter(i => (i.getAttribute('src') || '') === data);
              return imgs.length >= 1 ? imgs.length : null;
            }""", _asset_data, timeout=8.0)
            check("★ ★ v2.1.1 用户第 1 项：玩家公开素材区 DOM 里真的出现该图（不只看状态）",
                  bool(r_pl_img) and r_pl_img >= 1, r_pl_img)
            await shot(rkp, "room_20_asset_sheet_live")
            await ctx_r_kp.close()
            await ctx_r_p.close()

            # =========================================================
            # M. 手动填地址加入（T05-web）：浏览器里也有入口，能真的连上
            #
            # 加入方不一定收得到邀请链接（房主可能只报了地址 / 房间号）。
            # 浏览器里没有局域网外壳，这个入口是**唯一**能连指定地址的方式。
            # =========================================================
            print("\n== M、手动填地址加入（T05-web）==", flush=True)
            ctx_m_kp = await browser.new_context(viewport={"width": 412, "height": 900})
            ctx_m = await browser.new_context(viewport={"width": 412, "height": 900})
            mkp = await ctx_m_kp.new_page()
            mj = await ctx_m.new_page()
            for pg, tag in ((mkp, "手KP"), (mj, "手加入")):
                pg.on("pageerror", lambda e, t=tag: errors.append("[%s] %s" % (t, e)))
                pg.on("console", lambda m, t=tag: errors.append("[%s] %s" % (t, m.text))
                      if m.type == "error" else None)

            m_code = await make_room(mkp, "手动加入团", "KP手", ROOM_BASE)
            check("★ 手动加入团建房成功", bool(m_code), m_code)

            await mj.goto(BASE)
            await mj.wait_for_timeout(1200)
            await mj.evaluate("() => { try { localStorage.clear(); } catch (e) {} }")
            await mj.reload()
            await mj.wait_for_timeout(1200)
            await mj.evaluate("(b) => Store.setSettings({ roomBase: b })", ROOM_BASE)
            await mj.evaluate("() => App.go('#/room')")
            await mj.wait_for_timeout(700)

            mtext = await mj.evaluate(TEXT_NO_TOAST_JS)
            check("★ ★ 浏览器入口页有「手动填地址加入」按钮（不依赖局域网外壳）",
                  "手动填地址加入" in mtext, mtext[:0])

            await mj.evaluate(CLICK_BTN_JS, "手动填地址加入")
            await mj.wait_for_timeout(600)
            msheet = await mj.evaluate("""() => {
              const s = [...document.querySelectorAll('.sheet')].pop();
              if (!s) return null;
              return { title: (s.querySelector('h3') || {}).innerText || '',
                       inputs: s.querySelectorAll('input').length };
            }""")
            check("★ 手动填地址弹层打开，且有地址/房间号/名字等输入框",
                  bool(msheet) and msheet["inputs"] >= 3, msheet)

            # 填「服务器地址 + 房间号 + 名字」→ 加入（用的是测试起的本地房间服务）
            await mj.evaluate(FILL_SHEET_JS, ["", ROOM_BASE, m_code, "手填小明"])
            await mj.wait_for_timeout(700)
            await mj.evaluate(CLICK_EXACT_JS, "加入")
            await mj.wait_for_timeout(1800)
            ms = await session(mj)
            check("★ ★ 填地址 + 房间号就能加入（用的是测试起的本地房间服务）",
                  bool(ms) and ms["role"] == "player" and ms["code"] == m_code, ms)
            check("★ 手动加入后路由到 #/room/<code>",
                  (await mj.evaluate("() => location.hash")) == "#/room/" + (m_code or ""),
                  await mj.evaluate("() => location.hash"))

            # 顺带验证：紧凑串「COC7ROOM|地址|房间号」粘贴也能被宽容解析
            ctx_m2 = await browser.new_context(viewport={"width": 412, "height": 900})
            mj2 = await ctx_m2.new_page()
            await mj2.goto(BASE)
            await mj2.wait_for_timeout(1000)
            await mj2.evaluate("() => App.go('#/room')")
            await mj2.wait_for_timeout(500)
            await mj2.evaluate(CLICK_BTN_JS, "手动填地址加入")
            await mj2.wait_for_timeout(500)
            parsed = await mj2.evaluate("""(info) => {
              const s = [...document.querySelectorAll('.sheet')].pop();
              const ins = [...s.querySelectorAll('input')];
              ins[0].value = info;
              ins[0].dispatchEvent(new Event('input', { bubbles: true }));
              ins[0].dispatchEvent(new Event('change', { bubbles: true }));
              return { addr: ins[1].value, code: ins[2].value };
            }""", "COC7ROOM|%s|%s" % (ROOM_BASE, m_code or ""))
            check("★ ★ 粘贴「COC7ROOM|地址|房间号」被自动拆成地址与房间号",
                  parsed.get("addr") == ROOM_BASE and parsed.get("code") == m_code, parsed)
            await ctx_m2.close()
            await shot(mj, "room_21_manual_join")
            await ctx_m_kp.close()
            await ctx_m.close()

            # =========================================================
            # N. F1 视图壳（v2.0.0）：横屏桥 / 两套分区骨架 / 双指缩放 / 战斗模式
            #
            # 全部用「行为结果」判定，不靠「元素存在」：
            #   · 横屏 = 假桥真的被调到了 landscape / auto
            #   · 骨架 = 每个关键分区容器都挂在正确的身份根节点下
            #   · 缩放 = 双指捏合后 transform 的 scale 真的变了、重置真的还原
            #   · 战斗 = 走完「战斗模式 → 部署完毕」后 meta.mode 真的变成 COMBAT
            # =========================================================
            print("\n== N、F1 视图壳（横屏 / 骨架 / 缩放 / 战斗模式）==", flush=True)
            # v2.1.6：网格最小高 500 —— 844×390 这类手机横屏现在回退单列；
            # 本节断言的是「网格模式」的骨架/缩放/战斗语义，视口提到 844×600。
            ctx_sh = await browser.new_context(viewport={"width": 844, "height": 600},
                                               has_touch=True)
            ctx_sh_p = await browser.new_context(viewport={"width": 844, "height": 600},
                                                 has_touch=True)
            await ctx_sh.add_init_script(FAKE_BRIDGE_SHELL_JS)
            await ctx_sh_p.add_init_script(FAKE_BRIDGE_SHELL_JS)
            sh_kp = await ctx_sh.new_page()
            sh_pl = await ctx_sh_p.new_page()
            for pg, tag in ((sh_kp, "壳KP"), (sh_pl, "壳玩家")):
                pg.on("pageerror", lambda e, t=tag: errors.append("[%s] %s" % (t, e)))
                pg.on("console", lambda m, t=tag: errors.append("[%s] %s" % (t, m.text))
                      if m.type == "error" else None)

            sh_code = await make_room(sh_kp, "视图壳团", "KP壳", ROOM_BASE)
            check("★ 视图壳团建房成功", bool(sh_code), sh_code)
            sh_ps = await join_room(sh_pl, sh_code, "壳玩家", ROOM_BASE)
            check("★ 视图壳团玩家加入成功",
                  bool(sh_ps) and sh_ps["role"] == "player", sh_ps and sh_ps["role"])
            # v2.0.2：给壳玩家的卡写入真实九项属性（DEX=65）—— 供「战斗队列 PC DEX」断言
            await ensure_bound_card(sh_pl, "壳调查员",
                                    attrs={"str": 60, "con": 55, "siz": 70, "dex": 65,
                                           "app": 50, "int": 80, "pow": 55, "edu": 75, "luck": 45})
            await sh_pl.evaluate(CLICK_EXACT_JS, "我准备好了")
            await sh_kp.wait_for_timeout(900)
            await sh_kp.evaluate(CLICK_EXACT_JS, "开始游戏")
            await sh_kp.wait_for_timeout(1400)
            check("★ 视图壳团已开团（进入 .game-page）",
                  await sh_kp.evaluate("() => !!document.querySelector('.game-page')"))
            # ===== v2.0.10 探索模式布局（必须在进入「战斗模式」之前；此后 meta.mode=COMBAT）=====
            exp = await sh_kp.evaluate("""() => {
              const gp = document.querySelector('.game-page.gp-kp');
              const main = gp && gp.querySelector('.gp-main-kp');
              const strip = gp && gp.querySelector('.gp-combat-strip');
              const combat = gp && gp.querySelector('.gp-region-kp-combat');
              const topbar = gp && gp.querySelector('.gp-topbar');
              const appbar = document.querySelector('.appbar');
              const cols = n => n ? getComputedStyle(n).gridTemplateColumns.split(' ').filter(Boolean).length : 0;
              return {
                grid: !!(gp && gp.classList.contains('gp-grid')),
                explore: !!(gp && gp.classList.contains('gp-explore')),
                mainCols: cols(main),
                combatDisplay: combat ? getComputedStyle(combat).display : null,
                stripFold: !!(strip && strip.querySelector('.gp-combat-fold')),
                hasFoldHeader: !!(gp && gp.querySelector('.gp-region-kp-combat .gp-region-fold')),
                roundInfo: !!(gp && gp.querySelector('.gp-region-kp-map .init-wrap')),
                combatFull: !!(gp && gp.querySelector('.kp-combat-panel')),
                topbarTop: topbar ? Math.round(topbar.getBoundingClientRect().top) : null,
                appbarDisplay: appbar ? getComputedStyle(appbar).display : null
              };
            }""")
            # v2.1.1（用户定稿线框 v2）：KP 的块6/块7 **常驻右列**（由折叠标题栏控制显隐），
            # 不再「探索模式隐藏战斗列 → 降 3 栏 / 顶部全宽细条折叠」。
            # → 原 v2.0.10（第 8 项）两条断言按其新行为**改写**（用户明确要求的行为变更）。
            check("★ ★ v2.1.1 探索模式 .gp-main-kp 仍 4 栏、块6 战斗列常驻（线框：块6/7 常驻右列）",
                  bool(exp) and exp["explore"] and exp["mainCols"] == 4
                  and exp["combatDisplay"] not in (None, "none"),
                  exp and {"cols": exp["mainCols"], "disp": exp["combatDisplay"]})
            check("★ ★ v2.1.1 块6/块7 有可折叠标题栏（.gp-region-fold，替代旧的顶部细条折叠）",
                  bool(exp) and exp["hasFoldHeader"], exp and exp.get("hasFoldHeader"))
            check("★ ★ v2.1.1 块4 的「战斗轮次信息」探索模式**不出现**（仅战斗模式显示）",
                  bool(exp) and exp["roundInfo"] is False, exp and exp.get("roundInfo"))
            check("★ ★ v2.0.10（第 5 项）游戏页顶栏不被遮（.gp-topbar.top≥0 且 .appbar 隐藏）",
                  bool(exp) and exp["topbarTop"] is not None and exp["topbarTop"] >= 0
                  and exp["appbarDisplay"] in (None, "none"), exp)
            # 16:9 实测：光改 CSS 不算，必须量 rendered 尺寸（空态 + 有底图两态）
            ratio0 = await sh_kp.evaluate("""() => {
              const s = document.querySelector('.game-page .gp-center .map-stage');
              if (!s) return null; const r = s.getBoundingClientRect();
              return { w: Math.round(r.width), h: Math.round(r.height),
                       ratio: r.height ? r.width / r.height : null };
            }""")
            check("★ ★ v2.0.10（第 3 项）公开素材 16:9 实测（空态 rendered 比≈1.7778）",
                  bool(ratio0) and ratio0["ratio"] is not None
                  and abs(ratio0["ratio"] - 1.7778) <= 0.06, ratio0)
            ratio1 = await sh_kp.evaluate("""() => {
              const s = document.querySelector('.game-page .gp-center .map-stage');
              if (!s) return null;
              if (!s.querySelector('img')) {
                const img = document.createElement('img');
                img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
                s.appendChild(img);
              }
              const r = s.getBoundingClientRect();
              return { w: Math.round(r.width), h: Math.round(r.height),
                       ratio: r.height ? r.width / r.height : null };
            }""")
            check("★ ★ v2.0.10（第 3 项）公开素材 16:9 实测（有底图态 rendered 比≈1.7778）",
                  bool(ratio1) and ratio1["ratio"] is not None
                  and abs(ratio1["ratio"] - 1.7778) <= 0.06, ratio1)
            # v2.1.1（用户第 3 项「公开素材 16:9 并加大」）：**探索模式**下素材须比 v2.0.10
            #   的 844×390 基线（原 140×79）更大；战斗模式的 16:9（轮次信息以浮层叠在图上方）
            #   由本文件后面的 v2.1.1 段在战斗态单独断言。
            check("★ ★ v2.1.1 用户第 3 项：探索模式块4 公开素材比 v2.0.10 更大（844×390 原 140×79）",
                  bool(ratio1) and ratio1["w"] >= 140 and ratio1["h"] >= 79, ratio1)

            # --- v2.1.1（用户第三轮反馈）：取消「进入游戏页强制横屏」—— 跟随系统旋转 ---
            # 原 v2.0.1 断言要求进入游戏页请求 setGameOrientation('landscape')，
            # 与本轮用户要求**直接冲突** 且 与线框图无关；按新行为**改写**为「不得再请求横屏」。
            orient_kp = await sh_kp.evaluate("() => window.__orient || []")
            orient_pl = await sh_pl.evaluate("() => window.__orient || []")
            check("★ ★ v2.1.1 取消强制横屏：进入游戏页**不再**请求 setGameOrientation('landscape')（KP）",
                  "landscape" not in orient_kp, orient_kp)
            check("★ ★ v2.1.1 取消强制横屏：进入游戏页**不再**请求 setGameOrientation('landscape')（玩家）",
                  "landscape" not in orient_pl, orient_pl)

            # --- KP 分区骨架：每个关键容器都在 .game-page.gp-kp 下 ---
            kp_regions = await sh_kp.evaluate("""() => {
              const gp = document.querySelector('.game-page.gp-kp');
              if (!gp) return null;
              const need = ['.gp-topbar', '.gp-region-kp-left', '.gp-region-kp-tools',
                            '.gp-region-kp-map', '.gp-region-kp-combat', '.gp-region-kp-scene',
                            '.gp-region-kp-players', '.gp-region-kp-log', '.gp-region-kp-chat',
                            '.gp-status', '.gp-toolbar'];
              const missing = need.filter(s => !gp.querySelector(s));
              return { missing: missing, total: need.length };
            }""")
            check("★ ★ KP 页分区容器齐全（左栏/工具栏/地图/战斗/场景检定/玩家列表/记录/聊天/状态/工具栏）",
                  bool(kp_regions) and not kp_regions["missing"], kp_regions)

            # --- PL 分区骨架 ---
            pl_regions = await sh_pl.evaluate("""() => {
              const gp = document.querySelector('.game-page.gp-pl');
              if (!gp) return null;
              const need = ['.gp-topbar', '.gp-region-pl-card', '.gp-region-pl-map',
                            '.gp-region-pl-feeds', '.gp-region-pl-mates',
                            '.gp-region-pl-bottom', '.gp-status', '.gp-glog', '.gp-chat'];
              const missing = need.filter(s => !gp.querySelector(s));
              return { missing: missing, total: need.length };
            }""")
            check("★ ★ PL 页分区容器齐全（角色卡/地图/信息流/队友/底栏/状态/记录/聊天）",
                  bool(pl_regions) and not pl_regions["missing"], pl_regions)

            # 聊天输入行必须只有一处、且在全屏查看后仍保留（§5.9）
            chatbar_n = await sh_pl.evaluate("() => document.querySelectorAll('.room-chatbar').length")
            check("★ 聊天输入行只有一处（§5.9 不重复建）", chatbar_n == 1, chatbar_n)
            await shot(sh_kp, "room_22_shell_kp")
            await shot(sh_pl, "room_23_shell_pl")

            # --- 双指缩放：真实双指触摸 → transform scale 变化 ---
            before_tf = await sh_kp.evaluate("""() => {
              const z = document.querySelector('.game-page .gp-zoom');
              return z ? getComputedStyle(z).transform : null;
            }""")
            gp_rect = await rect_of(sh_kp, ".game-page")
            cx = gp_rect["x"] + gp_rect["w"] / 2
            cy = gp_rect["y"] + gp_rect["h"] / 2
            await pinch(sh_kp, cx, cy, 70, 230)     # 两指张开 → 放大
            await sh_kp.wait_for_timeout(300)
            after_tf = await sh_kp.evaluate("""() => {
              const z = document.querySelector('.game-page .gp-zoom');
              return z ? getComputedStyle(z).transform : null;
            }""")
            zoom_val = await sh_kp.evaluate(
                "() => parseFloat(document.querySelector('.game-page').style.getPropertyValue('--gp-zoom') || '1')")
            check("★ ★ 双指捏合后缩放容器的 transform 真的变了",
                  bool(after_tf) and after_tf != before_tf, {"before": before_tf, "after": after_tf})
            check("★ ★ 缩放比例确实被记录（--gp-zoom ≠ 1）", zoom_val != 1.0, zoom_val)

            # 重置缩放入口
            reset_clicked = await sh_kp.evaluate("""() => {
              const b = document.querySelector('.gp-zoom-reset');
              if (!b) return false;
              b.click();
              return true;
            }""")
            await sh_kp.wait_for_timeout(200)
            zoom_after_reset = await sh_kp.evaluate(
                "() => parseFloat(document.querySelector('.game-page').style.getPropertyValue('--gp-zoom') || '1')")
            check("★ ★ 有「重置缩放」入口，且点一下真的还原到 1:1",
                  reset_clicked is True and abs(zoom_after_reset - 1.0) < 0.001, zoom_after_reset)

            # =========================================================
            # N1b. v2.0.2 问题1：整页等比缩放（纯视觉，不重排）
            #   A2 布局宽度不随缩放变（证明删掉了 calc(100%/zoom) 重排补偿）
            #   A3 放大后原生滚动可充当横向/纵向平移
            #   A5 网格判定与缩放解耦
            #   A6 单指触摸不触发缩放（单指仍归画板手势）
            # =========================================================
            zw0 = await sh_kp.evaluate("""() => {
              const z = document.querySelector('.game-page .gp-zoom');
              return z ? z.offsetWidth : null;
            }""")
            grid_before = await sh_kp.evaluate("() => !!document.querySelector('.game-page.gp-grid')")
            await pinch(sh_kp, cx, cy, 70, 240)     # 双指张开 → 放大
            await sh_kp.wait_for_timeout(300)
            zoom_v2 = await sh_kp.evaluate(
                "() => parseFloat(document.querySelector('.game-page').style.getPropertyValue('--gp-zoom') || '1')")
            zw1 = await sh_kp.evaluate("""() => {
              const z = document.querySelector('.game-page .gp-zoom');
              return z ? z.offsetWidth : null;
            }""")
            check("★ ★ v2.0.2-A2 放大后 .gp-zoom 布局宽度不变（无 calc(100%/zoom) 重排补偿）",
                  zw0 is not None and zw1 == zw0 and zoom_v2 > 1.0,
                  {"before": zw0, "after": zw1, "zoom": zoom_v2})
            sc = await sh_kp.evaluate("""() => {
              const gp = document.querySelector('.game-page');
              return gp ? { sw: gp.scrollWidth, cw: gp.clientWidth,
                            sh: gp.scrollHeight, ch: gp.clientHeight } : null;
            }""")
            check("★ ★ v2.0.2-A3 放大后 .game-page 可横向平移（scrollWidth > clientWidth）",
                  bool(sc) and zoom_v2 > 1.0 and sc["sw"] > sc["cw"] + 1, sc)
            check("★ ★ v2.0.2-A3b 放大后 .game-page 可纵向平移（scrollHeight > clientHeight）",
                  bool(sc) and zoom_v2 > 1.0 and sc["sh"] > sc["ch"] + 1, sc)
            grid_after = await sh_kp.evaluate("() => !!document.querySelector('.game-page.gp-grid')")
            check("★ ★ v2.0.2-A5 缩放不改变网格判定（.gp-grid 与缩放解耦）",
                  grid_before == grid_after, {"before": grid_before, "after": grid_after})
            # A6 单指 touchmove 不触发缩放（单指仍归画板手势 / 原生滚动）
            z_single_before = await sh_kp.evaluate(
                "() => parseFloat(document.querySelector('.game-page').style.getPropertyValue('--gp-zoom') || '1')")
            await touch_drag(sh_kp, cx - 30, cy - 30, cx + 30, cy + 30, steps=6)
            await sh_kp.wait_for_timeout(150)
            z_single_after = await sh_kp.evaluate(
                "() => parseFloat(document.querySelector('.game-page').style.getPropertyValue('--gp-zoom') || '1')")
            check("★ ★ v2.0.2-A6 单指触摸不触发缩放（--gp-zoom 不变）",
                  abs(z_single_before - z_single_after) < 0.001,
                  {"before": z_single_before, "after": z_single_after})
            # 复位到 1:1 —— 后续布局断言（A2 高度链等）必须在默认缩放下进行
            await sh_kp.evaluate("""() => {
              const b = document.querySelector('.gp-zoom-reset');
              if (b) b.click();
            }""")
            await sh_kp.wait_for_timeout(200)
            zoom_reset_v2 = await sh_kp.evaluate(
                "() => parseFloat(document.querySelector('.game-page').style.getPropertyValue('--gp-zoom') || '1')")
            check("★ ★ v2.0.2 复位缩放后回到 1:1（后续布局断言基线）",
                  abs(zoom_reset_v2 - 1.0) < 0.001, zoom_reset_v2)

            # --- 战斗模式：战斗模式 → 选怪 → 战斗部署完毕 → 进入 COMBAT ---
            opened = await sh_kp.evaluate("""() => {
              const b = [...document.querySelectorAll('button')]
                .find(x => x.textContent.indexOf('战斗模式') >= 0);
              if (!b) return false;
              b.click();
              return true;
            }""")
            check("★ KP 游戏页有「战斗模式」入口", opened is True, opened)
            await sh_kp.wait_for_timeout(500)
            # v2.0.2 修复A/B：选怪弹层的「玩家（自动加入）」行显示真实敏捷（非 —）
            pc_dex_txt = await sh_kp.evaluate("""() => {
              const sh = [...document.querySelectorAll('.sheet')].pop();
              if (!sh) return null;
              const row = [...sh.querySelectorAll('.actor-line')]
                .find(x => x.textContent.indexOf('PC · DEX') >= 0);
              return row ? row.textContent : null;
            }""")
            check("★ ★ v2.0.2-B4 选怪弹层「PC · DEX」显示真实敏捷 65（非 —，证明 attrs 上报贯通）",
                  bool(pc_dex_txt) and 'DEX 65' in pc_dex_txt, pc_dex_txt)
            # F2 的选怪弹层要求「至少勾选 1 个怪物/NPC」才会启用「部署完毕」按钮。
            # 走真实 UI：新增一个怪物 → 加入候选池 → 勾选它。
            added = await sh_kp.evaluate(CLICK_BTN_JS, "新增怪物")
            await sh_kp.wait_for_timeout(500)
            pooled = await sh_kp.evaluate(CLICK_EXACT_JS, "加入候选池")
            await sh_kp.wait_for_timeout(600)
            picked = await sh_kp.evaluate("""() => {
              const sh = [...document.querySelectorAll('.sheet')].pop();
              if (!sh) return false;
              const row = [...sh.querySelectorAll('.actor-line')]
                .find(x => x.textContent.indexOf('新单位') >= 0);
              if (!row) return false;
              row.click();
              return true;
            }""")
            check("★ ★ 选怪弹层能新增并勾选怪物/NPC（部署按钮据此解禁）",
                  bool(added) and bool(pooled) and picked is True,
                  {"added": added, "pooled": pooled, "picked": picked})
            await sh_kp.wait_for_timeout(300)
            deployed = await sh_kp.evaluate("""() => {
              const b = [...document.querySelectorAll('button')]
                .find(x => x.textContent.indexOf('战斗部署完毕') >= 0);
              if (!b) return false;
              b.click();
              return true;
            }""")
            check("★ 选怪弹层里有「⚔️ 战斗部署完毕」按钮", deployed is True, deployed)
            await sh_kp.wait_for_timeout(1200)
            combat_mode = await sh_kp.evaluate(
                "() => { const s = RoomUI._session(); return s && s.host ? ((s.host.state.meta||{}).mode) : null; }")
            check("★ ★ 点「战斗部署完毕」后真的进入了战斗模式（meta.mode=COMBAT）",
                  combat_mode == "COMBAT", combat_mode)
            await shot(sh_kp, "room_25_shell_combat")

            # v2.0.2 修复C/C'：战斗队列里必须有 PC 槽（旧版只有怪物；PC 自动加入）
            combat_order = await sh_kp.evaluate("""() => {
              const s = RoomUI._session();
              if (!s || !s.host) return null;
              const c = s.host.state.combat;
              if (!c || !Array.isArray(c.order)) return null;
              return c.order.map(x => ({ actorId: x.actorId, kind: x.kind, dex: (x.public || {}).dex }));
            }""")
            pc_slots = [x for x in (combat_order or []) if x["kind"] == "pc"]
            check("★ ★ v2.0.2-B4b 战斗队列里有 PC 槽（PC 自动加入，不再只有怪物）",
                  len(pc_slots) >= 1, combat_order)
            check("★ ★ v2.0.2-B4b PC 槽公开 DEX = 65（真实敏捷贯通到队列）",
                  any(x["dex"] == 65 for x in pc_slots), combat_order)

            # =========================================================
            # N1c. v2.0.2 问题2：临时卡生命周期（B5 / B6）
            #   · 开局后本机存在临时卡（key = coc7.room.tempcard.<code>.<charId>）
            #   · 游戏内改状态 → 临时卡变、原卡不变
            #   · 「生效」→ 原卡被临时卡覆盖；未点「生效」→ 原卡不动
            # =========================================================
            tc = await sh_pl.evaluate("""() => {
              const s = RoomUI._session();
              const code = s && s.code, id = s && s.boundCharId;
              const rec = (RoomStore.getTempCard && code && id) ? RoomStore.getTempCard(code, id) : null;
              return { code: code, id: id, hasTemp: !!rec,
                       rawKeyExists: !!(code && id &&
                         localStorage.getItem('coc7.room.tempcard.' + code + '.' + id)) };
            }""")
            check("★ ★ v2.0.2-B5 开局后本机存在临时卡（localStorage 落盘）",
                  bool(tc) and tc["hasTemp"] is True and tc["rawKeyExists"] is True, tc)

            # UI 入口：PL 角色卡区有「本局角色卡（未生效）」+「生效到原卡」按钮
            ui_entry = await sh_pl.evaluate("""() => {
              const card = document.querySelector('.gp-region-pl-card');
              const txt = card ? card.textContent : '';
              const btn = card ? [...card.querySelectorAll('button')]
                .find(b => b.textContent.indexOf('生效到原卡') >= 0) : null;
              return { hasBar: txt.indexOf('本局角色卡') >= 0, hasBtn: !!btn };
            }""")
            check("★ ★ v2.0.2-B6 游戏页 PL 角色卡区有「本局角色卡（未生效）」入口",
                  bool(ui_entry) and ui_entry["hasBar"] is True, ui_entry)
            check("★ ★ v2.0.2-B6 临时卡区有「生效到原卡」按钮（二次确认入口）",
                  bool(ui_entry) and ui_entry["hasBtn"] is True, ui_entry)

            # 游戏内改 HP/SAN → 临时卡变、原卡不变
            tc_apply = await sh_pl.evaluate("""() => {
              const s = RoomUI._session();
              const code = s.code, id = s.boundCharId;
              RoomStore.applyToTempCard(code, id, { status: { currentHP: 3, currentSAN: 7 } });
              const temp = RoomStore.getTempCard(code, id);
              const orig = Store.getState().characters[id];
              return { tempHP: temp.card.status.currentHP, tempSAN: temp.card.status.currentSAN,
                       origHP: (orig.status || {}).currentHP };
            }""")
            check("★ ★ v2.0.2-B5 游戏内改 HP/SAN：临时卡变（3/7）、原卡不变（12）",
                  bool(tc_apply) and tc_apply["tempHP"] == 3 and tc_apply["tempSAN"] == 7
                  and tc_apply["origHP"] == 12, tc_apply)

            # 「生效」：原卡被临时卡覆盖
            commit = await sh_pl.evaluate("""() => {
              const s = RoomUI._session();
              const code = s.code, id = s.boundCharId;
              RoomStore.commitTempCard(code, id);
              const orig = Store.getState().characters[id];
              const temp = RoomStore.getTempCard(code, id);
              return { origHP: (orig.status || {}).currentHP, committed: temp.committed };
            }""")
            check("★ ★ v2.0.2-B6 点「生效」→ 原卡被临时卡覆盖（HP 12→3）、临时卡标记 committed",
                  bool(commit) and commit["origHP"] == 3 and commit["committed"] is True, commit)

            # 「取消」路径：临时卡改了但未点生效 → 原卡保持不动
            cancel = await sh_pl.evaluate("""() => {
              const c = Store.newCharacter('coc7');
              c.characterName = '取消测试';
              c.status = Object.assign({}, c.status, { currentHP: 12, maxHP: 12 });
              Store.savePreset(c);
              const id = c.id, code = 'zz99zz';
              RoomStore.ensureTempCard(code, 's-z', id);
              RoomStore.applyToTempCard(code, id, { status: { currentHP: 1 } });
              const mid = Store.getState().characters[id].status.currentHP;   // 未 commit → 仍 12
              RoomStore.clearTempCard(code, id);                              // 清理测试残留
              return { origHP: mid };
            }""")
            check("★ ★ v2.0.2-B6 未点「生效」→ 原卡保持不动（取消安全，仍为 12）",
                  bool(cancel) and cancel["origHP"] == 12, cancel)

            # =========================================================
            # N2. v2.0.1 游戏页布局修复（T14 收口）
            #
            # 根因① 高度链（.gp-zoom 需确定高度）、② 网格列宽、②-α F2 面板
            # 无样式、③ PL 骨架漏 .gp-region、④ 网格/单列由 .gp-grid 独家决定。
            # 视口 844×390 → .gp-grid 应在（网格模式）。
            # ⚠️ 断言不依赖具体阈值：E5「混合态否决」是防复发核心。
            # =========================================================
            print("\n== N2、v2.0.1 游戏页布局（网格模式 844×390）==", flush=True)
            check("★ ★ v2.0.1 844×390 命中网格模式（.game-page 带 .gp-grid）",
                  await sh_kp.evaluate(
                      "() => !!document.querySelector('.game-page.gp-grid')"))

            geom_kp = await sh_kp.evaluate("""() => {
              const q = s => document.querySelector(s);
              const gp = q('.game-page'), zoom = q('.game-page .gp-zoom');
              if (!gp || !zoom) return null;
              const main = q('.gp-main-kp');
              const map = q('.gp-region-kp-map');
              const ig = q('.icon-grid'), ic = q('.icon-cell');
              const cr = q('.color-row');
              const icr = ic ? ic.getBoundingClientRect() : null;
              const crKids = cr ? [...cr.children].slice(0, 2).map(c => c.getBoundingClientRect()) : [];
              return {
                vw: window.innerWidth, vh: window.innerHeight,
                gpScrollH: gp.scrollHeight, gpClientH: gp.clientHeight,
                zoomH: Math.round(zoom.getBoundingClientRect().height),
                mainDisplay: main ? getComputedStyle(main).display : null,
                mainH: main ? Math.round(main.getBoundingClientRect().height) : null,
                mapW: map ? Math.round(map.getBoundingClientRect().width) : null,
                mapH: map ? Math.round(map.getBoundingClientRect().height) : null,
                igDisplay: ig ? getComputedStyle(ig).display : null,
                igCols: ig ? getComputedStyle(ig).gridTemplateColumns : null,
                icW: icr ? Math.round(icr.width) : null,
                crDisplay: cr ? getComputedStyle(cr).display : null,
                crSameRow: crKids.length === 2 &&
                           Math.abs(crKids[0].top - crKids[1].top) < 4
              };
            }""")
            # A1 网格生效
            check("★ ★ v2.0.1-A1 KP 主区是网格（display=grid）",
                  bool(geom_kp) and geom_kp["mainDisplay"] == "grid", geom_kp)
            # A2 高度链：.gp-zoom 高度受视口约束（根因① 不再暴涨）
            check("★ ★ v2.0.1-A2 .gp-zoom 高度受视口约束（≤ 视口×1.2+2）",
                  bool(geom_kp) and geom_kp["zoomH"] <= geom_kp["vh"] * 1.2 + 2, geom_kp)
            # A3 网格模式内容不溢出
            check("★ ★ v2.0.1-A3 网格模式内容不溢出（scrollHeight ≤ clientHeight+4）",
                  bool(geom_kp) and geom_kp["gpScrollH"] <= geom_kp["gpClientH"] + 4, geom_kp)
            # A4 KP 地图不被压扁
            check("★ ★ v2.0.1-A4 KP 地图不被压扁（高≥120 且 宽≥150）",
                  bool(geom_kp) and geom_kp["mapH"] >= 120 and geom_kp["mapW"] >= 150, geom_kp)
            # A5 图标网格是 grid 且列数≥2
            check("★ ★ v2.0.1-A5 标记图标网格 display=grid 且列数≥2（不再竖条堆叠）",
                  bool(geom_kp) and geom_kp["igDisplay"] == "grid" and
                  len((geom_kp["igCols"] or "").split()) >= 2, geom_kp and geom_kp["igCols"])
            # A6 图标有实际宽度
            check("★ ★ v2.0.1-A6 图标单元有实际宽度（≥16px）",
                  bool(geom_kp) and (geom_kp["icW"] or 0) >= 16, geom_kp and geom_kp["icW"])
            # A7 颜色色块横排
            check("★ ★ v2.0.1-A7 颜色色块横向排布（flex 且相邻同排）",
                  bool(geom_kp) and geom_kp["crDisplay"] == "flex" and geom_kp["crSameRow"], geom_kp)

            geom_pl = await sh_pl.evaluate("""() => {
              const q = s => document.querySelector(s);
              const main = q('.gp-main-pl');
              const card = q('.gp-region-pl-card'), map = q('.gp-region-pl-map');
              const mates = q('.gp-region-pl-mates');
              const attr = q('.pl-char-card .attr-row');
              const sb = q('.pl-char-card .stat-bar');
              const gp = q('.game-page');
              return {
                vh: window.innerHeight,
                mainDisplay: main ? getComputedStyle(main).display : null,
                gtc: main ? getComputedStyle(main).gridTemplateColumns : null,
                cardH: card ? Math.round(card.getBoundingClientRect().height) : null,
                mapH: map ? Math.round(map.getBoundingClientRect().height) : null,
                mapTop: map ? Math.round(map.getBoundingClientRect().top) : null,
                matesH: mates ? Math.round(mates.getBoundingClientRect().height) : null,
                matesTop: mates ? Math.round(mates.getBoundingClientRect().top) : null,
                attrDisplay: attr ? getComputedStyle(attr).display : null,
                attrCols: attr ? getComputedStyle(attr).gridTemplateColumns : null,
                attrH: attr ? Math.round(attr.getBoundingClientRect().height) : null,
                sbH: sb ? Math.round(sb.getBoundingClientRect().height) : null,
                sbOverflow: sb ? getComputedStyle(sb).overflow : null,
                logHasRegion: !!q('.gp-region-pl-log.gp-region'),
                chatHasRegion: !!q('.gp-region-pl-chat.gp-region')
              };
            }""")
            # A8 PL 网格生效
            check("★ ★ v2.0.1-A8 PL 主区是网格（grid-template-columns ≠ none）",
                  bool(geom_pl) and geom_pl["mainDisplay"] == "grid" and
                  geom_pl["gtc"] not in (None, "none"), geom_pl and geom_pl["gtc"])
            # A9 PL 地图/队友可见
            check("★ ★ v2.0.1-A9 PL 地图与队友列表在视口内（top<视口 且 高≥80）",
                  bool(geom_pl) and geom_pl["mapTop"] < geom_pl["vh"] and geom_pl["mapH"] >= 80 and
                  geom_pl["matesTop"] < geom_pl["vh"] and geom_pl["matesH"] >= 80, geom_pl)
            # A10 PL 角色卡不拉成长条
            check("★ ★ v2.0.1-A10 PL 角色卡未被拉成长条（高 ≤ 视口×1.3）",
                  bool(geom_pl) and (geom_pl["cardH"] or 0) <= geom_pl["vh"] * 1.3, geom_pl and geom_pl["cardH"])
            # A11 PL log/chat 已带 .gp-region（根因③）
            check("★ ★ v2.0.1-A11 PL 的 log/chat 已带 .gp-region 类",
                  bool(geom_pl) and geom_pl["logHasRegion"] and geom_pl["chatHasRegion"], geom_pl)
            # A5'/A6'/A7' PL 角色卡属性行（根因②-α 用户报的「体质0/0% 长条」）
            check("★ ★ v2.0.1-A5' PL 属性行是 grid 且为 4 列（不再竖条）",
                  bool(geom_pl) and geom_pl["attrDisplay"] == "grid" and
                  len((geom_pl["attrCols"] or "").split()) == 4, geom_pl and geom_pl["attrCols"])
            check("★ ★ v2.0.1-A6' PL 属性行高度 ∈[20,40]（未被裁成 6px）",
                  bool(geom_pl) and 20 <= (geom_pl["attrH"] or 0) <= 40, geom_pl and geom_pl["attrH"])
            check("★ ★ v2.0.1-A7' PL 状态条 height>12 且 overflow=visible（旧版 6px+hidden 是长条主因）",
                  bool(geom_pl) and (geom_pl["sbH"] or 0) > 12 and geom_pl["sbOverflow"] == "visible",
                  geom_pl and {"h": geom_pl["sbH"], "ov": geom_pl["sbOverflow"]})

            # ---- v2.0.10（用户第 1/2/3/4/7 项）：游戏页布局重构（844×390 网格模式） ----
            v210 = await sh_kp.evaluate("""() => {
              const gp = document.querySelector('.game-page.gp-kp');
              const main = gp && gp.querySelector('.gp-main-kp');
              const info = gp && gp.querySelector('.gp-info');
              const tb = gp && gp.querySelector('.gp-toolbar');
              const zoom = gp && gp.querySelector('.gp-zoom');
              const cols = n => n ? getComputedStyle(n).gridTemplateColumns.split(' ').filter(Boolean).length : 0;
              return {
                grid: !!(gp && gp.classList.contains('gp-grid')),
                mainCols: cols(main), infoExists: !!info, infoCols: cols(info),
                toolbarOutsideZoom: !!(tb && zoom && !zoom.contains(tb)),
                statusHasPrivate: !!(gp && gp.querySelector('.gp-status .private-card')),
                privExists: !!(gp && gp.querySelector('.gp-priv')),
                hasFold: !!(gp && gp.querySelector('.gp-combat-fold')),
                combatFull: !!(gp && gp.querySelector('.kp-combat-panel')),
                explore: !!(gp && gp.classList.contains('gp-explore')),
                combatDisplay: (gp && gp.querySelector('.gp-region-kp-combat'))
                  ? getComputedStyle(gp.querySelector('.gp-region-kp-combat')).display : null,
                hScroll: gp ? (gp.scrollWidth > gp.clientWidth + 1) : null
              };
            }""")
            check("★ ★ v2.0.10 横屏 .gp-main-kp 为 4 列（KP/PL 统一骨架）",
                  bool(v210) and v210["grid"] and v210["mainCols"] == 4, v210 and v210["mainCols"])
            check("★ ★ v2.0.10（第 8 项）战斗模式 .gp-main 恢复 4 栏、战斗列可见（探索 3 栏的对照）",
                  bool(v210) and (not v210["explore"]) and v210["mainCols"] == 4
                  and v210["combatDisplay"] not in (None, "none"), v210 and v210["combatDisplay"])
            # v2.1.1（用户定稿线框）：KP 的 .gp-info 改为**底部 feed 行**（块8 聊天 | 块9 记录，
            # 等宽两栏，只占左+中宽度）—— 场景检定已移入右列（块5）。故 3 栏 → 2 栏。
            check("★ ★ v2.1.1 KP .gp-info 是底部 feed 行（块8 聊天 | 块9 记录，等宽 2 栏）",
                  bool(v210) and v210["infoExists"] and v210["infoCols"] == 2, v210 and v210["infoCols"])
            check("★ ★ v2.0.10 工具栏在 .gp-zoom 之外（sticky 不再被 transform 破坏）",
                  bool(v210) and v210["toolbarOutsideZoom"], v210 and v210["toolbarOutsideZoom"])
            check("★ ★ v2.0.10 游戏页无横向滚动条",
                  bool(v210) and v210["hScroll"] is False, v210 and v210["hScroll"])
            check("★ ★ v2.0.10（第 4 项）游戏页 .gp-status 不再重复线索卡、.gp-priv 仍在",
                  bool(v210) and (not v210["statusHasPrivate"]) and v210["privExists"], v210)
            zt = await sh_kp.evaluate("""() => {
              const gp = document.querySelector('.game-page');
              const tb = gp && gp.querySelector('.gp-toolbar');
              if (!tb) return null;
              gp.style.setProperty('--gp-zoom', '1');
              let r = tb.getBoundingClientRect(); const l1 = Math.round(r.left), t1 = Math.round(r.top);
              gp.style.setProperty('--gp-zoom', '2');
              r = tb.getBoundingClientRect(); const l2 = Math.round(r.left), t2 = Math.round(r.top);
              gp.style.setProperty('--gp-zoom', '1');
              return { l1: l1, t1: t1, l2: l2, t2: t2 };
            }""")
            check("★ ★ v2.0.10（第 1 项）--gp-zoom 1→2 时工具栏 left/top 两轴都不动",
                  bool(zt) and zt["l1"] == zt["l2"] and zt["t1"] == zt["t2"], zt)
            pl210 = await sh_pl.evaluate("""() => {
              const gp = document.querySelector('.game-page.gp-pl');
              const cols = n => n ? getComputedStyle(n).gridTemplateColumns.split(' ').filter(Boolean).length : 0;
              return {
                mainCols: cols(gp && gp.querySelector('.gp-main-pl')),
                infoCols: cols(gp && gp.querySelector('.gp-info')),
                hasFeeds: !!(gp && gp.querySelector('.gp-region-pl-feeds')),
                hasCard: !!(gp && gp.querySelector('.gp-region-pl-card'))
              };
            }""")
            check("★ ★ v2.1.6 玩家页新三列布局（.gp-main-pl 3 列 + .gp-info 2 栏，旧类名保留）",
                  bool(pl210) and pl210["mainCols"] == 3 and pl210["infoCols"] == 2
                  and pl210["hasFeeds"] and pl210["hasCard"], pl210)
            # v2.1.0 #9（用户报）：KP 需有「保存本局」入口。
            v210_save = await sh_kp.evaluate("""() => {
              const gp = document.querySelector('.game-page.gp-kp');
              const tb = gp && gp.querySelector('.gp-toolbar');
              const left = gp && gp.querySelector('.gp-region-kp-left');
              const btn = left && [...left.querySelectorAll('button')]
                .find(b => (b.textContent || '').indexOf('保存本局') >= 0);
              return {
                toolbarSave: !!(tb && [...tb.querySelectorAll('button')]
                  .some(b => (b.textContent || '').indexOf('保存本局') >= 0)),
                leftSave: !!btn
              };
            }""")
            check("★ ★ v2.1.0 #9 KP 工具栏有常驻「保存本局」入口",
                  bool(v210_save) and v210_save["toolbarSave"], v210_save)
            # v2.1.1（用户第三轮反馈「删冗余」）：**移除** KP 左栏那个重复的「保存本局」——
            #   底部工具栏已有常驻入口、且「🧰 KP 工具」弹层里也有，左栏是第三处重复。
            #   → 原「左栏保存本局够得到」断言（v2.1.0 #9）按其新行为**改写**为：
            #     「左栏**不应再**出现保存本局」。这是用户明确要求的行为变更，非功能退化。
            check("★ ★ v2.1.1 用户第 2 项：KP 左栏**不再**重复出现「保存本局」（删冗余）",
                  bool(v210_save) and v210_save["leftSave"] is False, v210_save)
            # v2.1.0 #11：骰子行「暗骰」开关态（开态下常用骰子 + 自定义骰子都走 dice.dark）。
            dark0 = await sh_kp.evaluate("""() => {
              const b = [...document.querySelectorAll('.dice-bar button')]
                .find(x => (x.textContent || '').indexOf('暗骰') >= 0);
              if (!b) return null;
              const before = b.textContent;
              b.click();
              return before;
            }""")
            await sh_kp.wait_for_timeout(300)
            dark1 = await sh_kp.evaluate("""() => {
              const b = [...document.querySelectorAll('.dice-bar button')]
                .find(x => (x.textContent || '').indexOf('暗骰') >= 0);
              return b ? b.textContent : null;
            }""")
            check("★ ★ v2.1.0 #11 骰子行有「暗骰」开关态（点击后 关→开）",
                  bool(dark0) and bool(dark1) and ('关' in dark0) and ('开' in dark1),
                  {"before": dark0, "after": dark1})
            await sh_kp.evaluate("""() => {
              const b = [...document.querySelectorAll('.dice-bar button')]
                .find(x => (x.textContent || '').indexOf('暗骰') >= 0);
              if (b && b.textContent.indexOf('开') >= 0) b.click();
            }""")
            await sh_kp.wait_for_timeout(200)
            # v2.1.0 #11 反面：没有临时状态 / KP 物品时，玩家卡**不渲染空壳**。
            neg = await sh_pl.evaluate("""() => {
              const c = document.querySelector('.game-page .pl-char-card');
              if (!c) return null;
              const cs = c.querySelector('.char-status');
              return { tsRows: c.querySelectorAll('.tempstatus-row').length,
                       hasTsTitle: !!(cs && (cs.textContent || '').indexOf('临时状态') >= 0) };
            }""")
            check("★ ★ v2.1.0 #11 反面：无临时状态时不渲染空壳（无 .tempstatus-row / 无标题）",
                  bool(neg) and neg["tsRows"] == 0 and (not neg["hasTsTitle"]), neg)
            await sh_pl.evaluate("""() => {
              const t = [...document.querySelectorAll('.game-page .pl-char-card .panel-tab')]
                .find(x => x.textContent.trim() === '物品');
              if (t) t.click();
            }""")
            await sh_pl.wait_for_timeout(400)
            neg2 = await sh_pl.evaluate("""() => {
              const c = document.querySelector('.game-page .pl-char-card .char-items');
              if (!c) return null;
              return { rows: c.querySelectorAll('.item-row').length,
                       empty: (c.textContent || '').indexOf('还没有物品') >= 0 };
            }""")
            check("★ ★ v2.1.0 #11 反面：无 KP 物品时不渲染物品行（走空态文案）",
                  bool(neg2) and neg2["rows"] == 0 and neg2["empty"], neg2)
            await sh_pl.evaluate("""() => {
              const t = [...document.querySelectorAll('.game-page .pl-char-card .panel-tab')]
                .find(x => x.textContent.trim() === '状态');
              if (t) t.click();
            }""")
            await sh_pl.wait_for_timeout(200)

            # ---- A12（QA 严过关补）：网格模式下底部工具栏仍完整可点 ----
            # 设计 §3.1 A12：网格模式也要能点到工具栏（不能只有单列 J 段测过）。
            # 用 elementFromPoint 命中测试：点在工具栏矩形内，命中的元素必须属于工具栏。
            # 命中测试用「工具栏矩形与视口交集」内的多个采样点（含自身垂直中心），
            # 命中元素属于工具栏（含任意后代）即算通过 —— 单点采样会被子元素/贴边
            # 浮层偶发干扰，故改为多点 OR，避免 flaky。
            tb_hit_grid = await sh_kp.evaluate("""() => {
              const g = document.querySelector('.game-page');
              const t = g && g.querySelector('.gp-toolbar');
              if (!t) return null;
              const r = t.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) return { err: 'toolbar 尺寸为 0', r: r };
              const vh = window.innerHeight, vw = window.innerWidth;
              const inView = r.top < vh && r.bottom > 0;   // 与视口有交集才算「在视口内」
              const relTop = Math.max(r.top, 0);
              const relBottom = Math.min(r.bottom, vh);
              const cxi = Math.min(Math.max(r.left + r.width / 2, 1), vw - 1);
              const ys = [r.top + 6, (relTop + relBottom) / 2, relBottom - 6]
                           .map(y => Math.round(Math.min(Math.max(y, 1), vh - 1)));
              let ok = false, hitCls = null;
              for (const cy of ys) {
                const el = document.elementFromPoint(cxi, cy);
                if (!hitCls && el) hitCls = el.className || el.tagName;
                if (el && t.contains(el)) { ok = true; break; }
              }
              return { inToolbar: ok, hit: hitCls, inView: inView,
                       tbTop: Math.round(r.top), tbBottom: Math.round(r.bottom), innerH: vh };
            }""")
            check("★ ★ v2.0.1-A12 网格模式下底部工具栏在视口内且可被点到（命中测试通过）",
                  bool(tb_hit_grid) and tb_hit_grid.get("inToolbar") is True
                  and tb_hit_grid.get("inView") is True, tb_hit_grid)

            # ---- A12x（QA 严过关 · 独立复验新发现，P1）：网格子区域不得溢出 .gp-main ----
            # 动机：A12 初版用「工具栏顶边取样」时**失败**，探针定位到真实缺陷：
            #   844×390 下 .gp-main-kp 只有 108px 高（被 113px 顶栏 + 151px 工具栏 + 间隙挤压），
            #   而 KT 网格子项的**基础 min-height** 之和远超 108：
            #     .gp-center(min-height:150) / .gp-chat(min-height:96) / .gp-glog(min-height:48)
            #   → 子区域**溢出到 .gp-main 之外**，压在上方（.gp-toolbar 是 z-index:2 的 sticky，
            #     但溢出内容与聊天区会互相叠字）。截图证实：地图/战斗/场景检定/聊天区互相覆盖。
            #   根因：`.game-page.gp-grid .gp-region-*` 只加了 grid-area/overflow，
            #   **没有把基础 min-height 归零**，于是 minmax(0,1fr) 的 0 下限被 min-height 顶破。
            # 判据（不依赖具体数值，只看「溢出」这一事实）：任一网格子区域底边
            # 越过 .gp-main-kp 底边 > 2px 即判失败。
            overflow_probe = await sh_kp.evaluate("""() => {
              const main = document.querySelector('.gp-main-kp');
              if (!main) return null;
              const mr = main.getBoundingClientRect();
              const bad = [];
              [...main.children].forEach(k => {
                const kr = k.getBoundingClientRect();
                const over = Math.round(kr.bottom - mr.bottom);
                if (over > 2) bad.push({ cls: (k.className || '').toString().slice(0, 44), over: over });
              });
              return { vh: window.innerHeight, mainTop: Math.round(mr.top),
                       mainBottom: Math.round(mr.bottom), mainH: Math.round(mr.height), bad: bad };
            }""")
            check("★ ★ v2.0.1-A12x 网格子区域不溢出 .gp-main-kp（溢出即会盖住下方工具栏/互相叠字）",
                  bool(overflow_probe) and not overflow_probe["bad"], overflow_probe)

            # =========================================================
            # v2.1.1（用户第三轮反馈 · 定稿线框）：KP 12 块布局 / 右列图层 / 折叠 / 线索顺序
            #   截图：tools/shots_v211/（由 _verify_v211_layout.py 生成）。
            #   断言只测「UI 结构/几何」，不测数据。
            # =========================================================
            # 先造两条私有消息（块10 有内容、顺序可测）：KP 私下递纸条给玩家。
            sh_seat = (sh_ps or {}).get("seat")
            for _t in ("最早线索", "最新线索"):
                await sh_kp.evaluate("""(a) => { RoomUI._session().side.act({
                  op: 'scene.clue', seat: a.seat, title: '纸条', text: a.t }); }""",
                  {"seat": sh_seat, "t": _t})
                await sh_kp.wait_for_timeout(450)
            await sh_kp.wait_for_timeout(500)
            v211 = await sh_kp.evaluate("""() => {
              const gp = document.querySelector('.game-page.gp-kp');
              if (!gp) return null;
              const q = s => gp.querySelector(s);
              const r = n => { if (!n) return null; const b = n.getBoundingClientRect();
                return { w: Math.round(b.width), h: Math.round(b.height),
                         top: Math.round(b.top), bottom: Math.round(b.bottom), x: Math.round(b.x) }; };
              const mid = q('.gp-right-mid');
              return {
                grid: gp.classList.contains('gp-grid'),
                b2: r(q('.gp-region-kp-left')), b3: r(q('.gp-region-kp-tools')),
                b4: r(q('.gp-region-kp-map')), b5: r(q('.gp-region-kp-scene')),
                b6: r(q('.gp-region-kp-combat')), b7: r(q('.gp-region-kp-players')),
                b8: r(q('.gp-region-kp-chat')), b9: r(q('.gp-region-kp-log')),
                b10: r(q('.gp-priv')), mid: r(mid),
                z10: q('.gp-priv') ? getComputedStyle(q('.gp-priv')).zIndex : null,
                zMid: mid ? getComputedStyle(mid).zIndex : null,
                privInRight: !!(q('.gp-region-kp-right') && q('.gp-region-kp-right').contains(q('.gp-priv'))),
                roundInfo: !!q('.gp-region-kp-map .init-wrap'),
                hScroll: gp.scrollWidth > gp.clientWidth + 1,
                mainOverflow: (() => { const m = q('.gp-main-kp'); const mr = m.getBoundingClientRect();
                  return [...m.children].some(k => k.getBoundingClientRect().bottom - mr.bottom > 2); })()
              };
            }""")
            check("★ ★ v2.1.1 KP 块2/块3 是两个独立窄列（v2.1.4 加宽：块2≤110、块3≤100，各自容器）",
                  bool(v211) and v211["b2"] and v211["b3"] and v211["b2"]["w"] <= 110
                  and v211["b3"]["w"] <= 100 and v211["b2"]["x"] < v211["b3"]["x"] < v211["b4"]["x"],
                  v211 and {"b2w": v211["b2"]["w"], "b3w": v211["b3"]["w"]})
            check("★ ★ v2.1.1 KP 块 5/6/7/8/9/10 各自独立容器（都存在，互不嵌套成一块）",
                  bool(v211) and all(v211[k] for k in ("b5", "b6", "b7", "b8", "b9", "b10")), v211)
            check("★ ★ v2.1.1 KP 右列顺序：块5(场景检定)在上、块6/7 居中、块10(线索)在底",
                  bool(v211) and v211["b5"]["top"] < v211["b6"]["top"] < v211["b10"]["bottom"], v211)
            check("★ ★ v2.1.1 KP 图层（几何断言）：块10 z-index<块6/7 且 上沿 top<块6/7 下沿 bottom",
                  bool(v211) and v211["z10"] != v211["zMid"] and int(v211["z10"]) < int(v211["zMid"])
                  and v211["b10"]["top"] < v211["mid"]["bottom"],
                  v211 and {"z10": v211["z10"], "zMid": v211["zMid"],
                            "b10top": v211["b10"]["top"], "midBot": v211["mid"]["bottom"]})
            check("★ ★ v2.1.1 KP 块8/块9 等宽两栏（块8 聊天 | 块9 记录）",
                  bool(v211) and abs(v211["b8"]["w"] - v211["b9"]["w"]) <= 2,
                  v211 and {"b8": v211["b8"]["w"], "b9": v211["b9"]["w"]})
            check("★ ★ v2.1.1 块10 只在右列内 + 无横向滚动 + 子区不溢出 .gp-main",
                  bool(v211) and v211["privInRight"] and (not v211["hScroll"])
                  and (v211["mainOverflow"] is False), v211)
            check("★ ★ v2.1.1 块4 战斗轮次信息在战斗模式**出现**（仅战斗模式）",
                  bool(v211) and v211["roundInfo"] is True, v211 and v211["roundInfo"])
            order211 = await sh_kp.evaluate("""() => {
              const p = document.querySelector('.game-page .gp-priv');
              if (!p) return null;
              return [...p.querySelectorAll('.priv-text')].map(x => (x.textContent || '').trim());
            }""")
            check("★ ★ v2.1.1 块10 顺序：第一条最老、最后一条最新（三处信息流统一「最新在最下」）",
                  bool(order211) and len(order211) >= 2 and order211[0].endswith("最早线索")
                  and order211[-1].endswith("最新线索"), order211)
            r211 = await sh_kp.evaluate("""() => {
              const s = document.querySelector('.game-page .gp-center .map-stage');
              if (!s) return null; const b = s.getBoundingClientRect();
              return { w: Math.round(b.width), h: Math.round(b.height),
                       ratio: b.height ? b.width / b.height : null };
            }""")
            # v2.1.1（战斗模式块4）：本段已在**战斗模式**（上面 A13 已进战斗）。块4 里除公开
            #   素材还叠着「战斗轮次信息」浮层。修复前该浮层在流内把 16:9 舞台挤成 0 高
            #   （→ 容器查询 100cqh=0 → 舞台塌成 0×0，公开素材「消失」）；现改为浮层叠在图上、
            #   地图铺满块4 → 战斗态同样 16:9 且尺寸 ≥ 探索态，故此处仍按「≥150×85」断言。
            check("★ ★ v2.1.1 块4 公开素材在**战斗模式**也 16:9（有图态≈1.7778）且比 v2.0.10 更大（844×390 原 140×79）",
                  bool(r211) and r211["ratio"] is not None
                  and abs(r211["ratio"] - 1.7778) <= 0.06
                  and r211["w"] >= 150 and r211["h"] >= 85, r211)
            # 块6/块7 折叠：点标题栏 → 高度显著变小 + 状态持久化在 UI_STATE（RoomPanels._state）
            _h6 = "() => { const b = document.querySelector('.gp-region-kp-combat');" \
                  " return b ? Math.round(b.getBoundingClientRect().height) : null; }"
            _h7 = "() => { const b = document.querySelector('.gp-region-kp-players');" \
                  " return b ? Math.round(b.getBoundingClientRect().height) : null; }"
            h6b = await sh_kp.evaluate(_h6)
            await sh_kp.evaluate(
                "() => document.querySelector('.gp-region-kp-combat .gp-region-fold').click()")
            await sh_kp.wait_for_timeout(300)
            h6a = await sh_kp.evaluate(_h6)
            fold6 = await sh_kp.evaluate("() => RoomPanels._state.foldCombat === true")
            # v2.1.2（QA 严过关更新）：阈值 0.5 过严（顶栏 v2.1.2 改造后展开高 46 → 收起 25/27，
            # 差 2px）。改为表达真实意图「折叠后**显著变小**」：after < before*0.75 且 after > 0
            # （即至少缩小 25%、且没有塌成 0）。顶栏若把行高顶爆/折叠失效 → after≈before → FAIL。
            check("★ ★ v2.1.1 块6 可折叠（点标题收起 → 高度显著变小）+ 状态持久化在 UI_STATE.foldCombat",
                  bool(h6b) and bool(h6a) and 0 < h6a < h6b * 0.75 and fold6 is True,
                  {"before": h6b, "after": h6a, "foldCombat": fold6})
            h7b = await sh_kp.evaluate(_h7)
            await sh_kp.evaluate(
                "() => document.querySelector('.gp-region-kp-players .gp-region-fold').click()")
            await sh_kp.wait_for_timeout(300)
            h7a = await sh_kp.evaluate(_h7)
            check("★ ★ v2.1.1 块7 可折叠（点标题收起 → 高度显著变小）",
                  bool(h7b) and bool(h7a) and 0 < h7a < h7b * 0.75, {"before": h7b, "after": h7a})
            await sh_kp.evaluate(
                "() => document.querySelector('.gp-region-kp-combat .gp-region-fold').click()")
            await sh_kp.evaluate(
                "() => document.querySelector('.gp-region-kp-players .gp-region-fold').click()")
            await sh_kp.wait_for_timeout(300)

            # 玩家端 .gp-info 手机横屏：3 列等长、铺满、无横向滚动（用户第 4 项）
            pl_info_js = """() => {
              const gp = document.querySelector('.game-page.gp-pl');
              const info = gp && gp.querySelector('.gp-info');
              if (!info) return null;
              const cols = getComputedStyle(info).gridTemplateColumns.split(' ').filter(Boolean);
              const w = [...info.children].map(k => Math.round(k.getBoundingClientRect().width));
              return { n: cols.length, widths: w, hScroll: info.scrollWidth > info.clientWidth + 1 };
            }"""
            for _vw, _vh in ((1180, 820), (1024, 600), (960, 540)):
                await sh_pl.set_viewport_size({"width": _vw, "height": _vh})
                await sh_pl.wait_for_timeout(350)
                pi = await sh_pl.evaluate(pl_info_js)
                check("★ ★ v2.1.6 玩家端 .gp-info %dx%d：2 栏（聊天|记录）等长、无横向滚动" % (_vw, _vh),
                      bool(pi) and pi["n"] == 2 and (not pi["hScroll"])
                      and (max(pi["widths"]) - min(pi["widths"]) <= 2), pi)
            await sh_pl.set_viewport_size({"width": 844, "height": 600})
            await sh_pl.wait_for_timeout(300)

            # ---- A14（主理人独立视觉验证发现）：390px 窄屏顶栏标题块不得被挤成竖排条 ----
            # 缺陷A：.gp-topbar-inner > .grow 是 flex:1（basis 0），被右侧 chip 挤压后
            # 可缩到 ~11px，中文逐字竖排 → 高度暴涨到数百 px，把 .gp-main 顶下去。
            # 期望：390×844 下 .grow 宽 > 100、高 < 100（换行后独占一行，正常单行标题）。
            ctx_n1 = await browser.new_context(viewport={"width": 390, "height": 844})
            ctx_n1p = await browser.new_context(viewport={"width": 390, "height": 844})
            n1 = await ctx_n1.new_page()
            n1p = await ctx_n1p.new_page()
            for pg, tag in ((n1, "A14KP"), (n1p, "A14PL")):
                pg.on("pageerror", lambda e, t=tag: errors.append("[%s] %s" % (t, e)))
                pg.on("console", lambda m, t=tag: errors.append("[%s] %s" % (t, m.text))
                      if m.type == "error" else None)
            a14_code = await make_room(n1, "A14窄屏团", "KP14", ROOM_BASE)
            a14_ps = await join_room(n1p, a14_code, "A14玩家", ROOM_BASE)
            await start_game(n1, n1p)
            # QA 严过关补：顶栏骨架先挂、.gp-title 后填是异步的 —— 若在标题节点
            # 尚未插入时就量，会拿到 titleW/titleH=null 的假失败（探针已证实修复本身
            # 正确：flex-basis 100%、标题单行 22px）。这里先等标题节点出现再量，
            # 让断言只评判布局、不评判渲染时序。
            try:
                await n1.wait_for_selector(".game-page .gp-topbar-inner > .grow .gp-title",
                                           timeout=5000, state="attached")
            except Exception:
                pass
            a14 = await n1.evaluate("""() => {
              const gp = document.querySelector('.game-page');
              if (!gp) return null;
              const grow = gp.querySelector('.gp-topbar-inner > .grow');
              if (!grow) return { err: 'no .gp-topbar-inner > .grow' };
              const r = grow.getBoundingClientRect();
              const title = grow.querySelector('.gp-title');
              const tr = title ? title.getBoundingClientRect() : null;
              const inner = gp.querySelector('.gp-topbar-inner').getBoundingClientRect();
              return { vw: window.innerWidth, growW: Math.round(r.width), growH: Math.round(r.height),
                       titleW: tr ? Math.round(tr.width) : null, titleH: tr ? Math.round(tr.height) : null,
                       innerW: Math.round(inner.width), innerH: Math.round(inner.height) };
            }""")
            # 判定：标题块宽度接近容器（不再 11px）；标题**单行**（高 < 40，非逐字竖排；
            # 折叠的老缺陷标题会被撑到数百 px）。growH 含 KP 的三行（标题/身份/服务地址块），
            # 正常约 100–110，取 160 作上限以留余量、同时远低于 619 的竖排爆炸。
            check("★ ★ v2.0.1-A14 390×844 窄屏顶栏标题块不被挤成竖排条（宽>100、标题单行高<40）",
                  bool(a14) and not a14.get("err") and a14.get("growW", 0) > 100
                  and a14.get("titleH") is not None and a14.get("titleH", 9999) < 40
                  and a14.get("growH", 9999) < 160, a14)
            await ctx_n1.close()
            await ctx_n1p.close()

            # ---- B5（主理人独立视觉验证发现）：KP 面板状态条不得还是 6px + overflow:hidden ----
            # 缺陷B：room-panels.js statBar() 生成裸 .stat-bar（含 .k/.bar/.num），
            # 旧 .stat-bar{height:6px;overflow:hidden} 把它裁成一条。已修（.stat-bar.row）。
            # 期望：KP 面板内 .stat-bar.row 高 > 12 且 overflow != hidden。
            b5 = await sh_kp.evaluate("""() => {
              const gp = document.querySelector('.game-page');
              if (!gp) return null;
              const bars = gp.querySelectorAll('.stat-bar');
              const rows = [...bars].filter(b => b.querySelector('.k') || b.querySelector('.num'));
              if (!rows.length) return { err: 'KP 面板里没有带 .k/.num 的状态条', total: bars.length };
              const b = rows[0];
              const cs = getComputedStyle(b);
              return { h: Math.round(b.getBoundingClientRect().height), ov: cs.overflow,
                       disp: cs.display, hasRow: b.classList.contains('row'),
                       total: bars.length, rows: rows.length };
            }""")
            check("★ ★ v2.0.1-B5 KP 面板状态条走整行样式（高>12 且 overflow≠hidden，不再 6px 裁切）",
                  bool(b5) and not b5.get("err") and b5.get("h", 0) > 12
                  and b5.get("ov") != "hidden", b5)

            # ---- T16（架构师 elementFromPoint 实测）：工具栏不得被聊天条拦截点击 ----
            # 根因：.game-page 是 fixed+inset:0+z-index:5 的独立 stacking context，
            # 其内 .gp-toolbar(旧 2) 与 .room-chatbar(5) 同层比较 → chatbar 盖住工具栏。
            # 修法：.gp-toolbar z-index → 6。验证：工具栏顶边 +6px 命中元素属于工具栏。
            t16 = await sh_kp.evaluate("""() => {
              const gp = document.querySelector('.game-page');
              const t = gp && gp.querySelector('.gp-toolbar');
              if (!t) return { err: 'no .gp-toolbar' };
              const r = t.getBoundingClientRect();
              const cx = Math.round(Math.min(Math.max(r.left + r.width/2, 1), window.innerWidth-1));
              const cy = Math.round(Math.min(Math.max(r.top + 6, 1), window.innerHeight-1));
              const el = document.elementFromPoint(cx, cy);
              return {
                tbTop: Math.round(r.top), tbBottom: Math.round(r.bottom),
                hitCls: el ? (el.className || el.tagName) : null,
                hitInToolbar: !!(el && el.closest && el.closest('.gp-toolbar')),
                hitInChatbar: !!(el && el.closest && el.closest('.room-chatbar')),
                zToolbar: getComputedStyle(t).zIndex
              };
            }""")
            check("★ ★ v2.0.1-T16 工具栏顶边命中属于工具栏、不被 .room-chatbar 拦截（z-index 提到 6）",
                  bool(t16) and not t16.get("err") and t16.get("hitInToolbar") is True
                  and t16.get("hitInChatbar") is False, t16)

            # ---- T17（v2.1.2 QA 更新）：房间信息行**含房间号**，且房间号**完整可见** ----
            # 现设计（app.css:1445-1447 + room-ui.js:2561）：该行为 nowrap+ellipsis，但**房间号
            # 被移到行首** —— ellipsis 只截尾，所以行首的房间号永不被吃。因此不再断言
            # 「white-space≠nowrap」（那是旧设计要求，与现设计冲突），改为守住**真约束**：
            #   ①「房间号」在该行**行首**（startsWithRoom）；
            #   ② 房间号文本存在；③ 用 Range 量出房间号那段的右边缘确实落在行可见区内
            #      （codeVisible → 没有被 ellipsis 吃掉）。若把房间号挪回行尾/顶栏把行撑爆 → FAIL。
            t17 = await sh_kp.evaluate("""() => {
              const gp = document.querySelector('.game-page');
              if (!gp) return null;
              const grow = gp.querySelector('.gp-topbar-inner > .grow');
              if (!grow) return { err: 'no .grow' };
              const line = [...grow.querySelectorAll('.tiny.dim')]
                             .find(e => e.textContent.indexOf('房间号') >= 0)
                           || grow.querySelector('.tiny.dim');
              if (!line) return { err: 'no 房间信息行' };
              const code = (RoomUI._session() && RoomUI._session().code) || '';
              const txt = line.textContent || '';
              const idx = code ? txt.indexOf(code) : -1;
              const startsRoom = txt.replace(/^\\s+/, '').indexOf('房间号') === 0;
              // 用 Range 测「房间号 <code>」这整段文字的可见性：ellipsis 只截尾，
              // 只要这段的右边缘 ≤ 行右边缘，就说明房间号没被省略号吃掉。
              let codeVisible = false, measured = false;
              try {
                const tn = line.firstChild;
                if (tn && tn.nodeType === 3 && idx >= 0) {
                  const r = document.createRange();
                  r.setStart(tn, idx);
                  r.setEnd(tn, Math.min(tn.length, idx + code.length));
                  const cr = r.getBoundingClientRect(), lr = line.getBoundingClientRect();
                  codeVisible = cr.width > 0 && cr.right <= lr.right + 1 && cr.left >= lr.left - 1;
                  measured = true;
                }
              } catch (e) { measured = false; }
              return { startsRoom: startsRoom, codeInText: idx >= 0, codeVisible: codeVisible,
                       measured: measured, whiteSpace: getComputedStyle(line).whiteSpace,
                       text: txt.slice(0, 60) };
            }""")
            check("★ ★ v2.1.2 房间信息行：房间号在行首且**完整可见**（nowrap+ellipsis 只截尾，房间号不被吃）",
                  bool(t17) and not t17.get("err") and t17.get("startsRoom") is True
                  and t17.get("codeInText") is True and t17.get("codeVisible") is True, t17)

            # ---- A13（QA 严过关补）：单列兜底不被压成 0（360×640） ----
            # 设计 §3.1 A13：根因① 改 height 后，单列模式最怕子项被压成 0px
            # （真机 640×400 实测过 kp-left 高 0）。这里用 360×640 单列验证 > 10。
            ctx_s1 = await browser.new_context(viewport={"width": 360, "height": 640})
            ctx_s1p = await browser.new_context(viewport={"width": 360, "height": 640})
            s1 = await ctx_s1.new_page()
            s1p = await ctx_s1p.new_page()
            for pg, tag in ((s1, "A13KP"), (s1p, "A13PL")):
                pg.on("pageerror", lambda e, t=tag: errors.append("[%s] %s" % (t, e)))
                pg.on("console", lambda m, t=tag: errors.append("[%s] %s" % (t, m.text))
                      if m.type == "error" else None)
            a13_code = await make_room(s1, "A13单列团", "KP13", ROOM_BASE)
            a13_ps = await join_room(s1p, a13_code, "A13玩家", ROOM_BASE)
            await start_game(s1, s1p)
            a13 = await s1.evaluate("""() => {
              const gp = document.querySelector('.game-page');
              const left = document.querySelector('.game-page .gp-region-kp-left');
              const main = document.querySelector('.game-page .gp-main-kp');
              return {
                hasGrid: !!(gp && gp.classList.contains('gp-grid')),
                vw: window.innerWidth, vh: window.innerHeight,
                leftH: left ? Math.round(left.getBoundingClientRect().height) : null,
                mainDisplay: main ? getComputedStyle(main).display : null
              };
            }""")
            check("★ ★ v2.0.1-A13 单列（360×640，无 .gp-grid）最左栏高度 > 10（防 0px 塌陷回归）",
                  bool(a13) and (not a13["hasGrid"]) and (a13["leftH"] or 0) > 10, a13)
            a13_pl = await s1p.evaluate("""() => {
              const gp = document.querySelector('.game-page');
              const card = document.querySelector('.game-page .gp-region-pl-card');
              return {
                hasGrid: !!(gp && gp.classList.contains('gp-grid')),
                cardH: card ? Math.round(card.getBoundingClientRect().height) : null
              };
            }""")
            check("★ v2.0.1-A13' 单列（360×640）PL 角色卡高度 > 10（防 0px 塌陷回归）",
                  bool(a13_pl) and (not a13_pl["hasGrid"]) and (a13_pl["cardH"] or 0) > 10, a13_pl)
            await ctx_s1.close()
            await ctx_s1p.close()

            # ---- A1–A13 第二视口复核（QA 严过关补）：1280×800 网格模式 ----
            # 设计 §3.1 要求 844×390 与 1280×800 **各跑一次**。上面只跑了 844×390。
            # 这条在更宽的视口下重验「网格生效 + 高度链受约束 + 地图不被压扁」。
            ctx_w = await browser.new_context(viewport={"width": 1280, "height": 800})
            ctx_wp = await browser.new_context(viewport={"width": 1280, "height": 800})
            wk = await ctx_w.new_page()
            wp = await ctx_wp.new_page()
            for pg, tag in ((wk, "宽KP"), (wp, "宽PL")):
                pg.on("pageerror", lambda e, t=tag: errors.append("[%s] %s" % (t, e)))
                pg.on("console", lambda m, t=tag: errors.append("[%s] %s" % (t, m.text))
                      if m.type == "error" else None)
            w_code = await make_room(wk, "宽屏团", "KP宽", ROOM_BASE)
            w_ps = await join_room(wp, w_code, "宽屏玩家", ROOM_BASE)
            await start_game(wk, wp)
            wgeom = await wk.evaluate("""() => {
              const gp = document.querySelector('.game-page');
              const zoom = document.querySelector('.game-page .gp-zoom');
              const main = document.querySelector('.gp-main-kp');
              const map = document.querySelector('.gp-region-kp-map');
              const ig = document.querySelector('.icon-grid');
              return {
                hasGrid: !!(gp && gp.classList.contains('gp-grid')),
                vh: window.innerHeight,
                zoomH: zoom ? Math.round(zoom.getBoundingClientRect().height) : null,
                mainDisplay: main ? getComputedStyle(main).display : null,
                mapH: map ? Math.round(map.getBoundingClientRect().height) : null,
                mapW: map ? Math.round(map.getBoundingClientRect().width) : null,
                igCols: ig ? getComputedStyle(ig).gridTemplateColumns : null
              };
            }""")
            check("★ ★ v2.0.1-A1@1280×800 网格模式命中且 .gp-main-kp 是 grid",
                  bool(wgeom) and wgeom["hasGrid"] and wgeom["mainDisplay"] == "grid", wgeom)
            check("★ ★ v2.0.1-A2@1280×800 .gp-zoom 高度受视口约束（≤ 视口×1.2+2）",
                  bool(wgeom) and wgeom["zoomH"] is not None and wgeom["zoomH"] <= wgeom["vh"] * 1.2 + 2, wgeom)
            check("★ ★ v2.0.1-A4@1280×800 KP 地图不被压扁（高≥120 且 宽≥150）",
                  bool(wgeom) and (wgeom["mapH"] or 0) >= 120 and (wgeom["mapW"] or 0) >= 150, wgeom)
            await ctx_w.close()
            await ctx_wp.close()

            # --- N3. v2.0.1 掉线提示（根因⑤：游戏页内 .gp-link 三态） ---
            print("\n== N3、v2.0.1 掉线提示（游戏页内 .gp-link）==", flush=True)
            link0 = await sh_pl.evaluate("""() => {
              const c = document.querySelector('.game-page .gp-link');
              return c ? { txt: c.textContent, vis: c.offsetParent !== null } : null;
            }""")
            check("★ ★ v2.0.1-B1 游戏页有常驻连接指示 .gp-link 且可见、非空",
                  bool(link0) and bool(link0["txt"]) and link0["vis"] is True, link0)
            check("★ ★ v2.0.1-B2 在线态文案含「已连接」",
                  bool(link0) and "已连接" in link0["txt"], link0 and link0["txt"])
            # 模拟掉线：驱动真实 onLinkState（走 paintLinkChip + banner）
            await sh_pl.evaluate("() => { RoomUI._setLinkState('player', 'offline'); }")
            await sh_pl.wait_for_timeout(300)
            link1 = await sh_pl.evaluate("""() => {
              const c = document.querySelector('.game-page .gp-link');
              return c ? { txt: c.textContent, vis: c.offsetParent !== null, cls: c.className } : null;
            }""")
            check("★ ★ v2.0.1-B3 离线态文案含「离线」且节点仍可见（在 .game-page 内）",
                  bool(link1) and "离线" in (link1["txt"] or "") and link1["vis"] is True, link1)
            # 恢复在线
            await sh_pl.evaluate("() => { RoomUI._setLinkState('player', 'online'); }")
            await sh_pl.wait_for_timeout(300)
            link2 = await sh_pl.evaluate("""() => {
              const c = document.querySelector('.game-page .gp-link');
              const bn = document.querySelector('.game-page .room-banner');
              return { txt: c ? c.textContent : null, cls: c ? c.className : null,
                       banner: bn ? bn.textContent.trim() : null };
            }""")
            check("★ ★ v2.0.1-B4 恢复在线后文案含「已连接」且 banner 已清空（重连成功可见反馈）",
                  bool(link2) and "已连接" in (link2["txt"] or "") and not (link2["banner"] or ""),
                  link2)
            # v2.1.0 #10（用户报）：横幅此前是**空操作**（sess.bannerEl 从未挂载）→ 掉线/重连
            # 提示用户全看不到。修好后断言「掉线横幅真的出现在 DOM 上」。
            await sh_pl.evaluate("() => { RoomUI._setLinkState('player', 'offline'); }")
            await sh_pl.wait_for_timeout(250)
            off_bn = await sh_pl.evaluate("""() => {
              const b = document.querySelector('.game-page .room-banner');
              return b ? b.textContent.trim() : null;
            }""")
            check("★ ★ v2.1.0 #10 掉线横幅真的显示（此前 setBanner 是空操作、横幅从不出现）",
                  bool(off_bn) and ('重连' in off_bn), off_bn)
            await sh_pl.evaluate("() => { RoomUI._setLinkState('player', 'online'); }")
            await sh_pl.wait_for_timeout(250)

            # --- N4. v2.0.1 对抗检定结果可见（根因⑥：EVT.CHECK → state.logs → logEl） ---
            print("\n== N4、v2.0.1 对抗检定结果可见 ==", flush=True)
            # 由 KP 发起一次公开对抗检定（KP vs 玩家）
            seat_pl = (sh_ps or {}).get("seat")
            await sh_kp.evaluate("""(seat) => {
              RoomUI._session().side.act({
                op: 'check.opposed',
                aSeat: null, aSkill: '聆听', aBase: 50,
                bSeat: seat, bSkill: '潜行', bBase: 40,
                difficulty: 'REGULAR'
              });
            }""", seat_pl)
            await sh_kp.wait_for_timeout(1200)
            await sh_pl.wait_for_timeout(600)
            check_c4 = await sh_pl.evaluate("""() => {
              const gp = document.querySelector('.game-page');
              const g = document.querySelector('.game-page .gp-glog');
              const ck = document.querySelector('.game-page .log-check');
              const txt = gp ? gp.textContent : '';
              return {
                hasLogCheck: !!ck,
                logHasOpposed: !!(g && g.textContent.indexOf('对抗检定') >= 0),
                gameHasOpposed: txt.indexOf('对抗检定') >= 0,
                logInGame: !!(gp && g && gp.contains(g)),
                sample: ck ? ck.textContent.slice(0, 60) : null
              };
            }""")
            check("★ ★ v2.0.1-C4 对抗检定结果在 PL 游戏页记录区可见（.log-check / 文本含「对抗检定」）",
                  bool(check_c4) and check_c4["logInGame"] and
                  (check_c4["hasLogCheck"] or check_c4["logHasOpposed"] or check_c4["gameHasOpposed"]),
                  check_c4)

            # --- 离开游戏页 → 恢复竖屏 ---
            await sh_kp.evaluate("() => App.go('#/room')")
            await sh_kp.wait_for_timeout(700)
            orient_kp2 = await sh_kp.evaluate("() => window.__orient || []")
            check("★ ★ 离开游戏页后恢复了竖屏（setGameOrientation('auto')）",
                  "auto" in orient_kp2, orient_kp2)

            # --- 续玩入口：本机有归档时，入口页出现「继续上次的团」 ---
            await sh_kp.evaluate("""() => {
              RoomStore.archive({
                meta: { code: 'arch01', name: '上次的团', kpName: 'KP壳' },
                members: [{ seat: 's1', nickname: '壳玩家', role: 'player' }],
                logs: [{ text: '结束' }], seq: 5
              });
            }""")
            await sh_kp.evaluate("() => App.goHome()")
            await sh_kp.wait_for_timeout(500)
            await sh_kp.evaluate("() => App.go('#/room')")
            await sh_kp.wait_for_timeout(700)
            resume_txt = await sh_kp.evaluate(TEXT_NO_TOAST_JS)
            check("★ ★ 入口页有「继续上次的团」续玩入口", "继续上次的团" in resume_txt, resume_txt[:0])
            await shot(sh_kp, "room_24_resume_entry")

            # =========================================================
            # N5. v2.0.1 §3.5 网格门槛边界断言（T14 收口，防复发核心）
            #
            # 网格/单列现由 JS 的 .gp-grid 类**独家**决定（CSS 不再有阈值）：
            #   grid = ((横屏 && w>=520) || w>=820) && !(520<=w<=599) && h>=290
            #   （v2.1.3：高下限 340→290，让手机横屏也能进网格 —— 见 room-ui.js 注释）
            # 为不依赖现有房间生命周期，直接在页内用真实骨架复现两态：
            #   · 把 .game-page 挂进真实 index.html，注入 .gp-grid 与否，
            #     比对各档的 computed 几何 —— 这正是断裂指纹的判据。
            # ⚠️ E5「混合态否决」不依赖具体阈值：只否决
            #    「display=grid 且 .gp-zoom 高 > 视口×1.2」这一断裂组合。
            # =========================================================
            print("\n== N5、v2.0.1 网格门槛边界（E1–E5）==", flush=True)

            # 用 KP 界面在多个视口下重进游戏页，读取真实几何
            async def grid_probe(w, h):
                c = await browser.new_context(viewport={"width": w, "height": h})
                try:
                    pg = await c.new_page()
                    await pg.goto(BASE)
                    await pg.wait_for_timeout(400)
                    # 复用当前房间：以 KP 身份用 hostToken 无法跨 context；改为
                    # 直接注入最小骨架并套用真实 .game-page/.gp-zoom/.gp-main-kp 类，
                    # 由真实 CSS + 真实 applyGridClass 阈值判定（用 matchMedia 等价规则）。
                    res = await pg.evaluate("""(wh) => {
                      const [w, h] = wh;
                      /* v2.1.7：MIN_H 回 290（同步 room-ui.js，手机横屏重新进网格） */
                      const gridOn = ((w > h && w >= 520) || w >= 820) &&
                                     !(w >= 520 && w <= 599) && (h >= 290);
                      const gp = document.createElement('div');
                      gp.className = 'game-page' + (gridOn ? ' gp-grid' : '');
                      gp.style.position = 'fixed'; gp.style.inset = '0';
                      const zoom = document.createElement('div');
                      zoom.className = 'gp-zoom';
                      const bar = document.createElement('div'); bar.className = 'gp-topbar gp-kpbar';
                      const main = document.createElement('div'); main.className = 'gp-main gp-main-kp';
                      ['left','tools','map','combat','scene','players','log','chat'].forEach(n => {
                        const r = document.createElement('div');
                        r.className = 'gp-region gp-region-kp-' + n + (n==='map'? ' gp-center':'');
                        /* 塞 160px 占位内容，逼出高度链断裂（若有） */
                        for (let i=0;i<3;i++){ const c=document.createElement('div');
                          c.className='card'; c.style.height='160px'; r.appendChild(c); }
                        main.appendChild(r);
                      });
                      const status = document.createElement('div'); status.className='gp-status';
                      const tb = document.createElement('div'); tb.className='gp-toolbar';
                      zoom.appendChild(bar); zoom.appendChild(main);
                      zoom.appendChild(status); zoom.appendChild(tb);
                      gp.appendChild(zoom);
                      document.body.appendChild(gp);
                      const cs = getComputedStyle(main);
                      const zr = zoom.getBoundingClientRect();
                      return {
                        gridOn: gridOn, hasClass: gp.classList.contains('gp-grid'),
                        mainDisplay: cs.display, mainH: Math.round(main.getBoundingClientRect().height),
                        zoomH: Math.round(zr.height),
                        vh: window.innerHeight, vw: window.innerWidth,
                        gpScrollH: gp.scrollHeight, gpClientH: gp.clientHeight
                      };
                    }""", [w, h])
                    return res
                finally:
                    await c.close()

            # v2.1.6：网格最小高 500 → 网格档位样本提到 ≥500 高；290/289 档归入单列语义
            e1 = await grid_probe(600, 560)
            e2 = await grid_probe(599, 560)
            e3 = await grid_probe(700, 290)
            e4 = await grid_probe(700, 289)
            check("★ ★ v2.0.1-E1 600×560 → 网格（.gp-grid 在 且 zoom 高≈视口）",
                  bool(e1) and e1["hasClass"] and e1["mainDisplay"] == "grid"
                  and abs(e1["zoomH"] - 560) <= 6, e1)
            check("★ ★ v2.0.1-E2 599×560 → 单列（520–599 太窄；无 .gp-grid 且 flex，不塌陷）",
                  bool(e2) and (not e2["hasClass"]) and e2["mainDisplay"] == "flex"
                  and e2["mainH"] > 0, e2)
            check("★ ★ v2.0.1-E3 700×290 → 网格（h 边界 290 含）",
                  bool(e3) and e3["hasClass"] and e3["mainDisplay"] == "grid"
                  and abs(e3["zoomH"] - 290) <= 6, e3)
            check("★ ★ v2.0.1-E4 700×289 → 单列（h 边界之下；flex 不塌陷）",
                  bool(e4) and (not e4["hasClass"]) and e4["mainDisplay"] == "flex"
                  and e4["mainH"] > 0, e4)
            # E5：混合态否决（核心，不依赖阈值）
            e5_bad = []
            for tag, r in (("600x600", e1), ("599x600", e2), ("700x290", e3), ("700x289", e4)):
                if r and r["mainDisplay"] == "grid" and r["zoomH"] > r["vh"] * 1.2 + 2:
                    e5_bad.append(tag)
            check("★ ★ v2.0.1-E5 混合态否决：任一边界档都不出现「grid 列宽 + .gp-zoom 暴涨」断裂指纹",
                  not e5_bad, {"bad": e5_bad, "e1": e1 and e1["zoomH"], "e2": e2 and e2["zoomH"],
                               "e3": e3 and e3["zoomH"], "e4": e4 and e4["zoomH"]})

            # ---- v2.1.7（用户第 5 项再反转）：手机横屏**重新进网格** ----
            #   v2.1.6 曾回退单列；用户要求改回「和平板同一套网格」+ 用「UI 缩放
            #   百分比」解决拥挤。MIN_H 回 290，三档手机横屏都应命中网格；
            #   缩放由用户点底栏百分比显式设置（transform+倒数布局框，见 app.css）。
            m1 = await grid_probe(780, 320)
            m2 = await grid_probe(640, 300)
            m3 = await grid_probe(780, 390)
            check("★ ★ v2.1.7-A 手机横屏 780×320 → 网格（与平板同一套布局）",
                  bool(m1) and m1["hasClass"] and m1["mainDisplay"] == "grid", m1)
            check("★ ★ v2.1.7-B 小手机横屏 640×300 → 网格",
                  bool(m2) and m2["hasClass"] and m2["mainDisplay"] == "grid", m2)
            check("★ ★ v2.1.7-C 手机横屏 780×390 → 网格且 zoom 高≈视口",
                  bool(m3) and m3["hasClass"] and m3["mainDisplay"] == "grid"
                  and m3["zoomH"] <= m3["vh"] * 1.2 + 2, m3)

            # ---- E-real（QA 严过关补）：**真实 applyGridClass** 的边界翻转 ----
            # ⚠️ 上面的 E1–E4 是在页面里**重新实现了一遍阈值**再手动加/去 .gp-grid ——
            #    它只证明「给定 .gp-grid 时 CSS 的几何正确」，**并没有验证
            #    room-ui.js 的 applyGridClass() 真的按阈值加/去类**。若 JS 阈值写错
            #    或 resize 监听被删，E1–E4 会照常全绿（假绿）。
            # 这里补一条走**真实渲染路径**的断言：在真实游戏页上 set_viewport_size
            #    触发 resize → applyGridClass() → 观察 .gp-grid 是否真的翻转。
            real_ctx = await browser.new_context(viewport={"width": 844, "height": 600})
            real_ctxp = await browser.new_context(viewport={"width": 844, "height": 600})
            rk = await real_ctx.new_page()
            rp = await real_ctxp.new_page()
            for pg, tag in ((rk, "真路径KP"), (rp, "真路径PL")):
                pg.on("pageerror", lambda e, t=tag: errors.append("[%s] %s" % (t, e)))
                pg.on("console", lambda m, t=tag: errors.append("[%s] %s" % (t, m.text))
                      if m.type == "error" else None)
            r_code = await make_room(rk, "真路径团", "KP真", ROOM_BASE)
            await join_room(rp, r_code, "真路径玩家", ROOM_BASE)
            await start_game(rk, rp)
            # 844×600（横屏够宽够高）→ 应命中网格
            real_on = await rk.evaluate(
                "() => { const g = document.querySelector('.game-page');"
                " return g ? g.classList.contains('gp-grid') : null; }")
            # 缩到 599×600（520–599 太窄区）→ 真实 resize 后应退出网格
            await rk.set_viewport_size({"width": 599, "height": 600})
            await rk.wait_for_timeout(500)
            real_off = await rk.evaluate(
                "() => { const g = document.querySelector('.game-page');"
                " return g ? { grid: g.classList.contains('gp-grid'),"
                " mainDisplay: (document.querySelector('.gp-main-kp') ?"
                " getComputedStyle(document.querySelector('.gp-main-kp')).display : null) } : null; }")
            # 再回到 900×600 → 应重新命中网格
            await rk.set_viewport_size({"width": 900, "height": 600})
            await rk.wait_for_timeout(500)
            real_back = await rk.evaluate(
                "() => { const g = document.querySelector('.game-page');"
                " return g ? g.classList.contains('gp-grid') : null; }")
            check("★ ★ v2.0.1-E-real① 真实 applyGridClass：844×600 命中网格（.gp-grid 在）",
                  real_on is True, real_on)
            check("★ ★ v2.0.1-E-real② 真实 resize 到 599×600 后 applyGridClass 退出网格（.gp-grid 去掉 & flex）",
                  bool(real_off) and real_off["grid"] is False
                  and real_off["mainDisplay"] == "flex", real_off)
            check("★ ★ v2.0.1-E-real③ 再 resize 到 900×600 后 applyGridClass 重新命中网格",
                  real_back is True, real_back)
            await real_ctx.close()
            await real_ctxp.close()

            # ---- E6：静态结构不变式（不依赖运行时几何，直接扫源码）----
            # 目的：把「结构规则挂回 @media」或「CSS/JS 双阈值」这两种回归路径
            # 在**源码层**堵死，而不是等 599px 又炸一次才发现。
            css_path = os.path.join(ROOT, "web", "css", "app.css")
            js_path = os.path.join(ROOT, "web", "js", "ui", "room-ui.js")
            with open(css_path, "r", encoding="utf-8") as f:
                css_src = f.read()
            with open(js_path, "r", encoding="utf-8") as f:
                js_src = f.read()

            def strip_css_comments(s):
                return re.sub(r"/\*.*?\*/", "", s, flags=re.S)

            css_clean = strip_css_comments(css_src)

            # E6-a：`.gp-main-kp` / `.gp-main-pl` 的规则**不得**出现在任何 @media 块内。
            # 做法：逐字符扫描，记录每个位置的 @media 嵌套深度，再看选择器命中位置。
            def media_depth_at(src, idx):
                depth, i, n = 0, 0, len(src)
                while i < idx and i < n:
                    if src.startswith("@media", i):
                        depth += 1
                        j = src.find("{", i)
                        if j < 0 or j > idx:
                            break
                        i = j
                    elif src[i] == "}":
                        depth = max(0, depth - 1)
                        i += 1
                    else:
                        i += 1
                return depth

            inside_media = []
            for m in re.finditer(r"\.gp-main-(?:kp|pl)\b", css_clean):
                # 只看「选择器位置」：该匹配到最近的 '{' 之间若出现 ';'，说明它出现在
                # 声明值里（如注释掉的旧写法），不是选择器本身。
                nxt = css_clean.find("{", m.end())
                if nxt < 0:
                    continue
                if ";" in css_clean[m.end():nxt]:
                    continue
                if media_depth_at(css_clean, m.start()) > 0:
                    inside_media.append(css_clean[max(0, m.start() - 40):m.start() + 30].replace("\n", " "))
            check("★ ★ v2.0.1-E6a 结构规则不在 @media 内（.gp-main-kp/.gp-main-pl 只由 .gp-grid 决定）",
                  not inside_media, {"hits": inside_media[:3]})

            # E6-b：旧的 520–599 降级 @media 不得复活；网格阈值只允许由 JS 常量持有。
            # 做法：找出所有 @media 预处理块的 (头, 块体)，只有当块体里出现 `.gp-main-*`
            # 的**结构声明**（display/grid-template）才算违规——避免误伤纯视觉 @media。
            def media_blocks(src):
                out = []
                for m in re.finditer(r"@media([^{]*)\{", src):
                    head, i, n, depth = m.group(1), m.end(), len(src), 1
                    while i < n and depth > 0:
                        if src[i] == "{":
                            depth += 1
                        elif src[i] == "}":
                            depth -= 1
                        i += 1
                    out.append((head, src[m.end():i - 1]))
                return out

            bad_media = []
            for head, body in media_blocks(css_clean):
                if not re.search(r"min-width:\s*5\d\dpx", head):
                    continue          # 只查 5xx 宽度档（历史事故区间）
                if re.search(r"\.gp-main-(?:kp|pl)[^{]*\{[^}]*display:\s*(?:grid|flex)", body):
                    bad_media.append(head.strip()[:60])
            check("★ ★ v2.0.1-E6b 无 5xx 宽度 @media 再写 `.gp-main-*` 结构声明（防「双阈值巧合自洽」回归）",
                  not bad_media, {"bad": bad_media[:3]})

            # E6-c：CSS 网格规则必须一律带 `.gp-grid` 前缀（单列的 `.game-page:not(.gp-grid)` 除外）。
            # 注意单列兜底是 `.gp-main-kp,\n.gp-main-pl { display:flex }` 合写形式，
            # 所以按「选择器串 + 声明块」成对提取，再分别判定 display。
            def decl_for(sel_pat):
                """返回所有匹配选择器串的声明块拼接文本。"""
                buf = []
                for m in re.finditer(r"([^{}]*?)\{([^{}]*)\}", css_clean):
                    if re.search(sel_pat, m.group(1)):
                        buf.append(m.group(2))
                return " ".join(buf)

            grid_decl = decl_for(r"\.game-page\.gp-grid\s+\.gp-main-kp")
            single_decl = decl_for(r"\.game-page:not\(\.gp-grid\)\s+\.gp-main-kp")
            grid_ok = bool(re.search(r"display:\s*grid", grid_decl))
            single_ok = bool(re.search(r"display:\s*flex", single_decl))
            check("★ ★ v2.0.1-E6c 网格=`.game-page.gp-grid` grid、单列=`:not(.gp-grid)` flex（互斥成对）",
                  grid_ok and single_ok, {"grid_ok": grid_ok, "single_ok": single_ok,
                                          "single_decl": single_decl[:60]})

            # E6-d：JS 侧不得再用 matchMedia 判结构（阈值只保留一份常量）。
            check("★ ★ v2.0.1-E6d JS 阈值单源：applyGridClass 不使用 matchMedia",
                  ("matchMedia" not in js_src) and ("applyGridClass" in js_src),
                  {"has_matchMedia": "matchMedia" in js_src, "has_applyGridClass": "applyGridClass" in js_src})

            # E6-e：`.gp-zoom` 的网格态高度必须是 definite（calc），单列态才是 auto。
            # ⚠️ 必须用 (?<!-) 排除 min-height —— 否则 min-height:calc() 会被误判成
            #    「有高度」，正是根因①的形态（旧版就是 min-height-only，没有 definite height）。
            zoom_def = bool(re.search(
                r"\.game-page\.gp-grid\s+\.gp-zoom\s*\{[^}]*(?<![-\w])height:\s*calc\(", css_clean))
            zoom_auto = bool(re.search(
                r"\.game-page:not\(\.gp-grid\)\s+\.gp-zoom\s*\{[^}]*(?<![-\w])height:\s*auto", css_clean))
            check("★ ★ v2.0.1-E6e `.gp-grid .gp-zoom` 高度是 calc(定值)、非网格态才是 auto（高度链闭合）",
                  zoom_def and zoom_auto, {"definite": zoom_def, "auto": zoom_auto})

            # =========================================================
            # O. v2.0.2 T4/T5：设备身份（a-/b-）/ 解绑入口 / 未完结的团（续玩）
            #
            # 一律「行为结果」判定，不靠「元素存在」：
            #   · 设备身份 = 真的调 DeviceId.get()，看前缀是不是 'a-'/'b-'（两条路径都测）
            #   · 解绑入口 = 在**入口页**上真的能看到「解绑本机身份」按钮；点了弹二次确认；
            #               「取消」不误删、「解绑」才真的调 RoomNet.unbind
            #   · 续玩     = 「未完结的团」出现在入口页，「继续」真的把会话连回房间
            # =========================================================
            print("\n== O、v2.0.2 设备身份 / 解绑入口 / 续玩 ==", flush=True)

            # ---- O1：设备身份两条来源（'a-' 原生稳定码 / 'b-' 无桥降级码）----
            ctx_a = await browser.new_context(viewport={"width": 412, "height": 900})
            await ctx_a.add_init_script("window.__devId = 'AID-TEST-1234';")
            await ctx_a.add_init_script(FAKE_BRIDGE_SHELL_JS)
            pg_a = await ctx_a.new_page()
            await pg_a.goto(BASE)
            await pg_a.wait_for_timeout(700)
            a_id = await pg_a.evaluate("() => (window.DeviceId ? DeviceId.get() : null)")
            check("★ ★ v2.0.2-T4 O1 有原生桥 → 设备码前缀 'a-'（sha256 原生稳定码）",
                  isinstance(a_id, str) and a_id.startswith("a-"), a_id)
            a_id2 = await pg_a.evaluate("() => DeviceId.get()")
            check("★ ★ v2.0.2-T4 O1 同设备多次调用设备码一致（稳定）", a_id == a_id2, [a_id, a_id2])
            await ctx_a.close()

            ctx_b = await browser.new_context(viewport={"width": 412, "height": 900})
            await ctx_b.add_init_script(FAKE_BRIDGE_SHELL_JS)   # __devId 默认 '' → 降级
            pg_b = await ctx_b.new_page()
            await pg_b.goto(BASE)
            await pg_b.wait_for_timeout(700)
            b_id = await pg_b.evaluate("() => (window.DeviceId ? DeviceId.get() : null)")
            check("★ ★ v2.0.2-T4 O1 无原生码 → 设备码前缀 'b-'（本地随机持久化）",
                  isinstance(b_id, str) and b_id.startswith("b-"), b_id)
            await pg_b.reload()
            await pg_b.wait_for_timeout(600)
            b_id2 = await pg_b.evaluate("() => DeviceId.get()")
            check("★ ★ v2.0.2-T4 O1 'b-' 降级码跨刷新一致（localStorage 持久化）",
                  b_id == b_id2, [b_id, b_id2])
            await ctx_b.close()

            # ---- O2：解绑入口（用户明确要求，落在入口页）+ 二次确认行为 ----
            ctx_o = await browser.new_context(viewport={"width": 412, "height": 900})
            ctx_o2 = await browser.new_context(viewport={"width": 412, "height": 900})
            ok_kp = await ctx_o.new_page()
            op = await ctx_o2.new_page()
            for pg, tag in ((ok_kp, "解绑KP"), (op, "解绑玩家")):
                pg.on("pageerror", lambda e, t=tag: errors.append("[%s] %s" % (t, e)))
                pg.on("console", lambda m, t=tag: errors.append("[%s] %s" % (t, m.text))
                      if m.type == "error" else None)
            o_code = await make_room(ok_kp, "解绑测试团", "KP解", ROOM_BASE)
            check("★ v2.0.2-T4 O2 解绑测试团建房成功", bool(o_code), o_code)
            o_sess = await join_room(op, o_code, "解绑玩家", ROOM_BASE)
            check("★ v2.0.2-T4 O2 玩家加入成功", bool(o_sess) and o_sess["role"] == "player",
                  o_sess and o_sess["role"])

            # v2.0.2 换座 Bug 防逃逸（P0）：续玩前先绑一张卡并记下 seat / charId，
            # 续玩后必须**仍在同一座位**且角色卡不丢。此前 O3 只断言 code + linkState，
            # 漏了 seat —— 正是本 Bug 逃逸两套测试的原因。
            await ensure_bound_card(op, "续玩调查员")
            pre_seat = (o_sess or {}).get("seat")
            pre_char = await op.evaluate("() => (RoomUI._session() || {}).boundCharId || ''")
            check("★ ★ v2.0.2-T5 O3 续玩前置：已取得座位号与绑定 charId（供后续对比）",
                  bool(pre_seat) and bool(pre_char), [pre_seat, pre_char])

            # 接线完整性：T4/T5 新接口都要真的挂在 RoomNet / RoomUI 上
            api_ok = await op.evaluate("""() => ({
              unbind: typeof RoomNet.unbind === 'function',
              createSave: typeof RoomNet.createSave === 'function',
              listSaves: typeof RoomNet.listSaves === 'function',
              getSave: typeof RoomNet.getSave === 'function',
              loadSave: typeof RoomNet.loadSave === 'function',
              deleteSave: typeof RoomNet.deleteSave === 'function',
              resumeRoom: typeof RoomUI.resumeRoom === 'function',
              saveSlotsSheet: typeof RoomPanels.saveSlotsSheet === 'function'
            })""")
            check("★ ★ v2.0.2-T4/T5 RoomNet 暴露 unbind/saves*、RoomUI 暴露 resumeRoom（接线完整）",
                  bool(api_ok) and all(api_ok.values()), api_ok)

            # 回到入口页 —— 本机已加入过该房间 → 应出现「本机身份绑定」卡片 + 解绑按钮
            await op.evaluate("() => App.go('#/room')")
            await op.wait_for_timeout(600)
            id_card = await op.evaluate("""() => {
              const card = document.querySelector('.gp-identity');
              if (!card) return null;
              const btns = [...card.querySelectorAll('button')].map(b => b.textContent.trim());
              return { hasCard: true, btns: btns,
                       hasUnbind: btns.some(t => t.indexOf('解绑本机身份') >= 0) };
            }""")
            check("★ ★ v2.0.2-T4 O2 入口页出现「本机身份绑定」卡片",
                  bool(id_card) and id_card["hasCard"], id_card)
            check("★ ★ v2.0.2-T4 O2 卡片里有「解绑本机身份」按钮",
                  bool(id_card) and id_card["hasUnbind"], id_card)

            # 桩住 RoomNet.unbind，记录调用（真正的解绑由 test_room_reconnect.py 走真服务验）
            await op.evaluate("""() => {
              window.__unbindCalls = [];
              RoomNet.unbind = function (code, dev) {
                window.__unbindCalls.push({ code: code, dev: dev });
                return Promise.resolve({ ok: true });
              };
            }""")
            # 点解绑 → 弹二次确认，文案须让用户明白后果（与设计 §1.3.2 / 用户要求一致）
            await op.evaluate(CLICK_SUBSTR_JS, "解绑本机身份")
            await op.wait_for_timeout(400)
            confirm_txt = await op.evaluate("""() => {
              const masks = [...document.querySelectorAll('.sheet-mask')];
              const m = masks[masks.length - 1];
              return m ? m.innerText : null;
            }""")
            check("★ ★ v2.0.2-T4 O2 解绑弹二次确认，且文案含「本机将被视为新玩家…下次加入会分配新座位」",
                  bool(confirm_txt) and ('视为新玩家' in confirm_txt) and ('新座位' in confirm_txt),
                  confirm_txt)
            # 「取消」→ 不得调用 unbind（防误删）
            await op.evaluate(CLICK_EXACT_JS, "取消")
            await op.wait_for_timeout(300)
            calls0 = await op.evaluate("() => window.__unbindCalls || []")
            check("★ ★ v2.0.2-T4 O2 二次确认点「取消」→ 不调用 unbind（不误删本机身份）",
                  len(calls0) == 0, calls0)
            # 「解绑」→ 真的调用一次，且带本房间号
            await op.evaluate(CLICK_SUBSTR_JS, "解绑本机身份")
            await op.wait_for_timeout(400)
            await op.evaluate(CLICK_EXACT_JS, "解绑")
            await op.wait_for_timeout(500)
            calls1 = await op.evaluate("() => window.__unbindCalls || []")
            check("★ ★ v2.0.2-T4 O2 二次确认点「解绑」→ 真的调用 RoomNet.unbind（带本房间号）",
                  len(calls1) == 1 and calls1[0]["code"] == o_code, calls1)

            # ---- O3：未完结的团（续玩入口）----
            # 模拟「改天续玩」：刷新页面 —— 会话清空、旧 WS 关闭，只剩本机 localStorage
            # 里的「我加入过」记录（这才能真实检验「靠本机记录把会话连回去」）。
            # （若不刷新，旧连接与续玩新连接会争同一 mtoken 触发 takeover 竞态，测到的是噪声。）
            await op.reload()
            await op.wait_for_timeout(1300)
            await op.evaluate("() => App.go('#/room')")
            await op.wait_for_timeout(600)
            # 玩家已加入过该房间 → listUnfinished() 应把它列出来（含「继续」）
            unf = await op.evaluate("""() => {
              const card = document.querySelector('.gp-unfinished');
              if (!card) return null;
              const btns = [...card.querySelectorAll('button')].map(b => b.textContent.trim());
              return { hasCard: true, btns: btns,
                       hasGo: btns.some(t => t.indexOf('继续') >= 0) };
            }""")
            check("★ ★ v2.0.2-T5 O3 入口页出现「未完结的团」卡片",
                  bool(unf) and unf["hasCard"], unf)
            check("★ ★ v2.0.2-T5 O3 未完结的团里有「继续」按钮",
                  bool(unf) and unf["hasGo"], unf)
            # 点「继续」→ 真的连回房间（session.code 恢复）
            await op.evaluate("""() => {
              const card = document.querySelector('.gp-unfinished');
              const b = card && [...card.querySelectorAll('button')]
                .find(x => x.textContent.trim() === '继续');
              if (b) b.click();
              return !!b;
            }""")
            # v2.1.0 #10（用户报）：点「继续」→ 真正 online 之间要有**明确等待态**
            # （横幅「正在回到房间…」；此前只有通用连接文案，用户注意不到）。
            wait_banner = await wait_for(op, """() => {
              const bn = document.querySelector('.room-banner');
              const t = bn ? bn.textContent.trim() : '';
              return (t.indexOf('正在回到房间') >= 0) ? t : null;
            }""", timeout=4.0)
            check("★ ★ v2.1.0 #10 点「继续」后出现明确等待横幅「正在回到房间…」",
                  bool(wait_banner) and '正在回到房间' in wait_banner, wait_banner)
            back = await wait_for(op, """() => {
              const s = RoomUI._session();
              return s && s.code ? { code: s.code, role: s.role, link: s.linkState } : null;
            }""", timeout=10.0)
            check("★ ★ v2.0.2-T5 O3 点「继续」真的连回房间（session.code 恢复）",
                  bool(back) and back["code"] == o_code, back)
            back_online = await wait_for(
                op, "() => (RoomUI._session() || {}).linkState === 'online'", timeout=10.0)
            check("★ ★ v2.0.2-T5 O3 续玩后 WebSocket 真的连回（linkState=online）",
                  back_online is True, back_online)
            # v2.0.2 换座 Bug 防逃逸：续玩后**座位号不得变**（reopenJoined 必须走
            # 带 d=<deviceId> 的 wsUrlFor 路径；此前手拼 URL 漏 d → 服务端按 mtoken
            # 重算 seat → 换座）。
            back_full = await session(op)
            back_seat = (back_full or {}).get("seat")
            check("★ ★ v2.0.2-T5 O3 续玩后座位号不变（防「换座 Bug」逃逸）",
                  bool(back_seat) and back_seat == pre_seat,
                  {"before": pre_seat, "after": back_seat})
            # 且原座位上的角色卡仍在（换座会让新座位没有 charName → 卡「丢了」）。
            # 用 wait_for 容忍重连后全量 state 的回传时延（座位若换了则永远等不到）。
            back_char = await wait_for(op, """() => {
              const s = RoomUI._session();
              if (!s || !s.client) return null;
              const me = (s.client.state.members || []).find(m => m.seat === s.client.seat);
              return (me && me.charName) ? me.charName : null;
            }""", timeout=8.0)
            check("★ ★ v2.0.2-T5 O3 续玩后原座位上的角色卡仍在（charName 未丢 → 未换座）",
                  bool(back_char), back_char)
            # ★ v2.0.3 新增：【别人看我还是离线】防逃逸。
            # 此前 Host.prototype.attachPeer 只在「新座位」(!existed) 时 syncMembers()，
            # 而同座重连（existed=true，即设备码回座）只把 roster 原地改成 online、
            # **不重发 EVT.MEMBERS** —— 可掉线时 detachPeer 已经把 state.members 写成
            # online:false，于是 KP 侧永久显示该玩家离线（连他发言都不刷新）。
            # ⚠️ 必须断言 KP 的 **state.members**（渲染源）；只断言 roster 是测不出来的
            #    —— 修复前 roster 就已经是 true，那正是这个 bug 能长期躲过回归的原因。
            # ⚠️ 必须问**本房间的 KP**（ok_kp，o_code 的房主）；写 `kp` 是笔误 ——
            #    那是主流程 507 行另一个房间的 KP，state.members 里根本没有 pre_seat，
            #    断言会恒取到 None（看似「缺陷仍在」，其实是打错了页）。
            kp_online = await wait_for(ok_kp, """() => {
              const s = RoomUI._session();
              const st = s && s.host ? s.host.state : null;
              if (!st || !st.members) return null;
              const me = st.members.find(m => m.seat === '%s');
              return me ? !!me.online : null;
            }""" % pre_seat, timeout=8.0)
            check("★ ★ v2.0.3 重连后 KP 侧 state.members.online 翻回 true（别人不再看到我离线）",
                  kp_online is True,
                  {"seat": pre_seat, "kp_state_members_online": kp_online})
            await ctx_o.close()
            await ctx_o2.close()

            # =========================================================
            # P. v2.1.1（用户第三轮反馈）：「游戏中可加入」+ 机器码区分「重连 / 新加入」
            #    协议侧（room_server.py / LanServer.java / room-net.js）由另一工位落地；
            #    本段只验 **room-ui.js 的接线**（界面是否按 joinKind / IN_GAME 正确呈现）：
            #      ① 加入流程按 joinKind 给文案：命中机器码 → 「正在重连…」；全新 → 「加入中…」；
            #      ② IN_GAME 房间预检标「可加入（进行中）」，不再显示「游戏已经开始…」，
            #         且老玩家加入流程真的能进入；
            #      ③ 满员房间下命中机器码的老玩家不被拦（预检 ok + 按钮仍可点 → 进入）。
            # =========================================================
            print("\n== P、v2.1.1 joinKind UI（游戏中可加入 / 重连 vs 新加入）==", flush=True)

            JK_HINT_JS = """() => {
              const sh = [...document.querySelectorAll('.sheet')].pop();
              if (!sh) return null;
              const cand = [...sh.querySelectorAll('.tiny.dim')];
              const h = cand.find(x => x.querySelector('.probe-ok, .probe-err')) || cand[0];
              return h ? h.textContent : null;
            }"""
            # 点「加入」后**同步**读按钮文案：onclick 里先改文案、再 await N.join，
            # 故同一 evaluate 内即可拿到「正在重连…」/「加入中…」。
            JK_CLICK_JOIN_JS = """() => {
              const sh = [...document.querySelectorAll('.sheet')].pop();
              if (!sh) return null;
              const b = [...sh.querySelectorAll('button')]
                .find(x => x.textContent.trim() === '加入');
              if (!b) return null;
              b.click();
              return b.textContent.trim();
            }"""
            JK_FILL_JS = """(vals) => {
              const sh = [...document.querySelectorAll('.sheet')].pop();
              if (!sh) return false;
              const ins = [...sh.querySelectorAll('input')];
              vals.forEach((v, i) => {
                if (ins[i] === undefined) return;
                ins[i].value = v;
                ins[i].dispatchEvent(new Event('input', { bubbles: true }));
                ins[i].dispatchEvent(new Event('change', { bubbles: true }));
              });
              return true;
            }"""

            async def jk_probe_page(code, dev):
                """开一张「干净」的入口页（指定机器码）→ 打开加入弹层并预检该房间。
                ⚠️ 必须同时填「房间号 + 你的名字」：onclick 里若昵称为空会**提前 return**，
                   按钮文案压根不会被改写，断言会假失败。"""
                c = await browser.new_context(viewport={"width": 412, "height": 900})
                await c.add_init_script("window.__devId = '%s';" % dev)
                await c.add_init_script(FAKE_BRIDGE_SHELL_JS)
                p = await c.new_page()
                await p.goto(BASE)
                await p.wait_for_timeout(800)
                await p.evaluate("(b) => Store.setSettings({ roomBase: b })", ROOM_BASE)
                await p.evaluate("() => App.go('#/room')")
                await p.wait_for_timeout(400)
                await p.evaluate(CLICK_BTN_JS, "加入房间")
                await p.wait_for_timeout(400)
                await p.evaluate(JK_FILL_JS, [code, "探路人", ""])
                await p.wait_for_timeout(900)     # 等异步预检回包（probeNow → lastJoinKind）
                return c, p

            # 建房（上限 2 人）→ 甲/乙 各以固定机器码加入（占满）→ 两人准备 → KP 开团（IN_GAME）
            jk_kp_ctx = await browser.new_context(viewport={"width": 1180, "height": 820})
            await jk_kp_ctx.add_init_script("window.__devId = 'AID-JK-KP';")
            await jk_kp_ctx.add_init_script(FAKE_BRIDGE_SHELL_JS)
            jk_kp = await jk_kp_ctx.new_page()
            await jk_kp.goto(BASE)
            await jk_kp.wait_for_timeout(900)
            await jk_kp.evaluate("() => { try { localStorage.clear(); } catch (e) {} }")
            await jk_kp.reload()
            await jk_kp.wait_for_timeout(900)
            await jk_kp.evaluate("(b) => Store.setSettings({ roomBase: b })", ROOM_BASE)
            await jk_kp.evaluate("() => App.go('#/room')")
            await jk_kp.wait_for_timeout(400)
            await jk_kp.evaluate(CLICK_BTN_JS, "创建房间")
            await jk_kp.wait_for_timeout(400)
            await jk_kp.evaluate(FILL_SHEET_JS, ["满员团", "KP满", ""])
            jk_max = await jk_kp.evaluate(SET_SELECT_JS, "2 人")
            check("★ v2.1.1-P 建房时玩家人数上限可设为 2 人", jk_max == "2", jk_max)
            await jk_kp.evaluate(CLICK_EXACT_JS, "创建")
            jk_code = await wait_for(jk_kp, "() => { const s = RoomUI._session();"
                                           " return s && s.role === 'kp' ? s.code : null; }", timeout=10.0)
            await wait_for(jk_kp, "() => (RoomUI._session()||{}).linkState === 'online'", timeout=10.0)
            check("★ v2.1.1-P 满员团建房成功", bool(jk_code), jk_code)

            jk_a_ctx = await browser.new_context(viewport={"width": 412, "height": 900})
            await jk_a_ctx.add_init_script("window.__devId = 'AID-JK-A';")
            await jk_a_ctx.add_init_script(FAKE_BRIDGE_SHELL_JS)
            jk_pa = await jk_a_ctx.new_page()
            jk_b_ctx = await browser.new_context(viewport={"width": 412, "height": 900})
            await jk_b_ctx.add_init_script("window.__devId = 'AID-JK-B';")
            await jk_b_ctx.add_init_script(FAKE_BRIDGE_SHELL_JS)
            jk_pb = await jk_b_ctx.new_page()
            jk_sa = await join_room(jk_pa, jk_code, "甲", ROOM_BASE)
            jk_sb = await join_room(jk_pb, jk_code, "乙", ROOM_BASE)
            check("★ v2.1.1-P 甲乙两名玩家都加入成功（房间占满 2/2）",
                  bool(jk_sa) and bool(jk_sb),
                  [jk_sa and jk_sa.get("seat"), jk_sb and jk_sb.get("seat")])
            await ensure_bound_card(jk_pa, "甲调查员")
            await jk_pa.evaluate(CLICK_EXACT_JS, "我准备好了")
            await jk_pa.wait_for_timeout(500)
            await ensure_bound_card(jk_pb, "乙调查员")
            await jk_pb.evaluate(CLICK_EXACT_JS, "我准备好了")
            await jk_pb.wait_for_timeout(600)
            await jk_kp.evaluate(CLICK_EXACT_JS, "开始游戏")
            await jk_kp.wait_for_timeout(1500)
            jk_ingame = await jk_kp.evaluate("""() => {
              const s = RoomUI._session();
              return s && s.host ? ((s.host.state.meta || {}).status || null) : null; }""")
            check("★ v2.1.1-P 开团后房间状态为 IN_GAME 且满员 2/2", jk_ingame == "IN_GAME", jk_ingame)

            # ---- ① IN_GAME 预检文案 + ② 命中机器码的加入文案（老玩家，满员房）----
            jk_ca2, jk_pa2 = await jk_probe_page(jk_code, "AID-JK-A")
            jk_hint_a = await jk_pa2.evaluate(JK_HINT_JS)
            check("★ ★ v2.1.1-P IN_GAME 房间预检标「可加入（进行中）」，"
                  "且**不**出现「游戏已经开始，不能加入玩家席」",
                  bool(jk_hint_a) and ("可加入（进行中）" in jk_hint_a)
                  and ("游戏已经开始" not in jk_hint_a), jk_hint_a)
            jk_btn_a = await jk_pa2.evaluate(JK_CLICK_JOIN_JS)
            check("★ ★ v2.1.1-P 命中机器码 → 加入按钮文案为「正在重连…」",
                  jk_btn_a == "正在重连…", jk_btn_a)
            jk_enter_a = await wait_for(jk_pa2, "() => { const s = RoomUI._session();"
                                                " return s && s.role === 'player' ? true : null; }", timeout=8.0)
            check("★ ★ v2.1.1-P 满员 + 命中机器码：加入流程真的进入（老玩家不被「不可加入」拦）",
                  jk_enter_a is True, jk_enter_a)
            await jk_ca2.close()

            # ---- ③ 全新机器码：文案「加入中…」，且预检同样不出现「游戏已经开始」----
            jk_cc2, jk_pc2 = await jk_probe_page(jk_code, "AID-JK-C")
            jk_hint_c = await jk_pc2.evaluate(JK_HINT_JS)
            check("★ ★ v2.1.1-P 全新机器码：预检里**不**出现「游戏已经开始，不能加入玩家席」",
                  bool(jk_hint_c) and ("游戏已经开始" not in jk_hint_c), jk_hint_c)
            jk_btn_c = await jk_pc2.evaluate(JK_CLICK_JOIN_JS)
            check("★ ★ v2.1.1-P 全新机器码 → 加入按钮文案为「加入中…」",
                  jk_btn_c == "加入中…", jk_btn_c)
            await jk_cc2.close()

            await jk_a_ctx.close()
            await jk_b_ctx.close()
            await jk_kp_ctx.close()

            # =========================================================
            # Q、v2.1.8 玩家页布局（只增不改）：
            #   ① 聊天输入条钉在聊天框正下方（--gp-zoom 1→2 相对位置不变）
            #   ② 玩家 12 块线框：右列 = 场景检定|队友 → 手绘板(独立块) → 笔记栏
            #   ③ 只给你看的信息：固定高度 + 可滚动 + 智能跟随（上滚不拉回）
            #   ④ 中心公开素材 16:9 且比 v2.1.7 基线（383×216@1180×820）更大
            # 截图：tools/shots_v218/
            # =========================================================
            print("\n== Q、v2.1.8 玩家页布局（输入钉住 / 12块线框 / 线索可滚动）==", flush=True)
            SHOTS218 = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots_v218")
            try:
                os.makedirs(SHOTS218, exist_ok=True)
            except Exception:
                pass
            ctx_q_kp = await browser.new_context(viewport={"width": 1280, "height": 860})
            ctx_q_pl = await browser.new_context(viewport={"width": 1180, "height": 820})
            qkp = await ctx_q_kp.new_page()
            qpl = await ctx_q_pl.new_page()
            for pg, tag in ((qkp, "Q-KP"), (qpl, "Q-PL")):
                pg.on("pageerror", lambda e, t=tag: errors.append("[%s] %s" % (t, e)))
                pg.on("console", lambda m, t=tag: errors.append("[%s] %s" % (t, m.text))
                      if m.type == "error" else None)

            q_code = await make_room(qkp, "v218布局团", "KP218", ROOM_BASE)
            check("★ v2.1.8-Q 建房成功", bool(q_code), q_code)
            await join_room(qpl, q_code, "布局玩家", ROOM_BASE)
            await start_game(qkp, qpl)
            check("★ v2.1.8-Q 已开团（进入 .game-page）",
                  await qpl.evaluate("() => !!document.querySelector('.game-page.gp-pl')"))

            # KP 公开一张素材（中央主图有内容态）
            await qkp.evaluate("""() => { RoomUI._session().side.act({ op: 'asset.add',
              asset: { kind: 'map', name: 'v218素材',
                       data: 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=' } }); }""")
            await qkp.wait_for_timeout(500)
            await qkp.evaluate(CLICK_BTN_JS, "素材与地图")
            await qkp.wait_for_timeout(500)
            await qkp.evaluate("""() => { const s = document.querySelector('.sheet');
              const c = s && [...s.querySelectorAll('.asset-cell')]
                .find(x => x.innerText.indexOf('v218素材') >= 0);
              if (c) { c.click(); return true; } return false; }""")
            await qkp.wait_for_timeout(500)
            await qkp.evaluate("() => { try { UI.closeAllSheets(); } catch (e) {} }")
            await qkp.wait_for_timeout(400)

            # 递 24 条私有线索（触发「只给你看的信息」滚动/跟随语义）
            q_seat = ((await qpl.evaluate(SESSION_JS)) or {}).get("seat")
            check("★ v2.1.8-Q 拿到玩家座位号（按座位递线索）", bool(q_seat), q_seat)
            for _i in range(24):
                await qkp.evaluate("""(a) => { RoomUI._session().side.act({
                  op: 'scene.clue', seat: a.seat,
                  title: '线索' + a.i, text: 'v218线索内容' + a.i }); }""",
                  {"seat": q_seat, "i": _i})
                await qkp.wait_for_timeout(60)
            await qpl.wait_for_timeout(1200)

            # ---- Q1/Q2：12 块线框 —— 右列块序 + 手绘板独立块 ----
            q_wire = await qpl.evaluate("""() => {
              const gp = document.querySelector('.game-page.gp-pl');
              if (!gp) return null;
              const right = gp.querySelector('.gp-pl-right');
              const order = right ? [...right.children].map(n => n.className || '') : [];
              const sketch = gp.querySelector('.gp-pl-sketch');
              const board = sketch ? sketch.querySelector('.mini-board') : null;
              const mates = gp.querySelector('.gp-region-pl-mates');
              const notes = gp.querySelector('.gp-pl-notes');
              const br = board ? board.getBoundingClientRect() : null;
              const idx = (key) => order.findIndex(c => c.indexOf(key) >= 0);
              return {
                row1: idx('gp-pl-row1'), sketch: idx('gp-pl-sketch'), notes: idx('gp-pl-notes'),
                boardInSketch: !!board,
                boardW: br ? Math.round(br.width) : null,
                boardH: br ? Math.round(br.height) : null,
                boardNotInMates: !!(mates && !mates.querySelector('.mini-board')),
                hasNotesBlock: !!notes,
                notesHasPanel: !!(notes && (notes.querySelector('.notes-panel') ||
                  notes.textContent.indexOf('笔记') >= 0)),
                privInMain: !!(gp.querySelector('.gp-main-pl') &&
                  gp.querySelector('.gp-main-pl').contains(gp.querySelector('.gp-priv'))),
                gridOn: gp.classList.contains('gp-grid')
              };
            }""")
            check("★ ★ v2.1.8-Q1 玩家右列块序：场景检定|队友 → 手绘板(独立块) → 笔记栏（线框 12 块）",
                  bool(q_wire) and q_wire["gridOn"] and q_wire["row1"] >= 0
                  and q_wire["sketch"] > q_wire["row1"] and q_wire["notes"] > q_wire["sketch"],
                  q_wire)
            check("★ ★ v2.1.8-Q2 手绘板 .mini-board 渲染在独立块内、可定位（不再挤在队友块里）",
                  bool(q_wire) and q_wire["boardInSketch"] and q_wire["boardNotInMates"]
                  and (q_wire["boardW"] or 0) > 60 and (q_wire["boardH"] or 0) > 40,
                  q_wire)
            check("★ ★ v2.1.8-Q2b 笔记栏（notes-panel）仍存在；「只给你看的信息」在中列底行（grid-area priv）",
                  bool(q_wire) and q_wire["hasNotesBlock"] and q_wire["notesHasPanel"]
                  and q_wire["privInMain"], q_wire)

            # ---- Q3/Q4：中心公开素材 16:9 且更大（v2.1.7 基线 383×216 @1180×820）----
            q_stage = await qpl.evaluate("""() => {
              const s = document.querySelector('.game-page.gp-pl .gp-center .map-stage');
              if (!s) return null; const r = s.getBoundingClientRect();
              return { w: Math.round(r.width), h: Math.round(r.height),
                       ratio: r.height ? +(r.width / r.height).toFixed(4) : null };
            }""")
            check("★ ★ v2.1.8-Q3 中心公开素材 16:9（rendered 比 ≈1.7778 ±0.06）",
                  bool(q_stage) and q_stage["ratio"] is not None
                  and abs(q_stage["ratio"] - 1.7778) <= 0.06, q_stage)
            check("★ ★ v2.1.8-Q4 中心公开素材比 v2.1.7 基线更大（1180×820 原 383×216）",
                  bool(q_stage) and q_stage["w"] >= 600 and q_stage["h"] >= 330, q_stage)

            # ---- Q5/Q6：聊天输入条钉在聊天框正下方（zoom 1→2 不变）----
            Q_CHAT_JS = """() => {
              const chat = document.querySelector('.game-page.gp-pl .gp-region-pl-chat');
              const bar = chat && chat.querySelector('.room-chatbar');
              if (!chat || !bar) return null;
              const c = chat.getBoundingClientRect(), b = bar.getBoundingClientRect();
              const list = chat.querySelector('.gp-chat-list');
              const l = list ? list.getBoundingClientRect() : null;
              return {
                relBottom: +(c.bottom - b.bottom).toFixed(2),
                belowList: l ? +(b.top - l.bottom).toFixed(2) : null,
                inBox: b.top >= c.top - 1 && b.bottom <= c.bottom + 1,
                chatH: +c.height.toFixed(1)
              };
            }"""
            q_chat1 = await qpl.evaluate(Q_CHAT_JS)
            check("★ ★ v2.1.8-Q5 zoom=1：输入条位于聊天框正下方（bottom 与聊天框对齐、不出框）",
                  bool(q_chat1) and q_chat1["relBottom"] <= 2 and q_chat1["inBox"], q_chat1)
            await qpl.evaluate("""() => { const r = document.querySelector('.game-page');
              if (r) { r.classList.remove('gp-noscale'); r.style.setProperty('--gp-zoom', '2'); } }""")
            await qpl.wait_for_timeout(350)
            q_chat2 = await qpl.evaluate(Q_CHAT_JS)
            check("★ ★ v2.1.8-Q6 zoom=2：输入条相对聊天框位置不变（仍正下方，不随缩放漂移）",
                  bool(q_chat2) and q_chat2["relBottom"] <= 2 and q_chat2["inBox"], q_chat2)
            await qpl.evaluate("""() => { const r = document.querySelector('.game-page');
              if (r) { r.classList.add('gp-noscale'); r.style.setProperty('--gp-zoom', '1'); } }""")
            await qpl.wait_for_timeout(250)

            # ---- Q7：只给你看的信息 —— 固定高度 + 可滚动 + 智能跟随 ----
            Q_PRIV_JS = """() => {
              const p = document.querySelector('.game-page.gp-pl .gp-priv');
              if (!p) return null;
              return {
                h: Math.round(p.getBoundingClientRect().height),
                scrollH: p.scrollHeight, clientH: p.clientHeight,
                scrollTop: Math.round(p.scrollTop),
                scrollable: p.scrollHeight > p.clientHeight + 1,
                overflowY: getComputedStyle(p).overflowY,
                atBottom: Math.abs(p.scrollTop + p.clientHeight - p.scrollHeight) < 6,
                lines: p.querySelectorAll('.priv-line').length
              };
            }"""
            q_priv1 = await qpl.evaluate(Q_PRIV_JS)
            check("★ ★ v2.1.8-Q7 只给你看的信息：网格下固定高度（104px 行）+ overflow-y:auto",
                  bool(q_priv1) and q_priv1["overflowY"] == "auto"
                  and 40 <= q_priv1["h"] <= 112, q_priv1)
            check("★ ★ v2.1.8-Q8 24 条线索时容器可滚动（scrollHeight > clientHeight）且默认跟随最新",
                  bool(q_priv1) and q_priv1["scrollable"] and q_priv1["atBottom"]
                  and q_priv1["lines"] >= 12, q_priv1)
            # 手动上滚 → 再来一条 → 不被强行拉回底部
            await qpl.evaluate("""() => { const p = document.querySelector('.game-page.gp-pl .gp-priv');
              p.scrollTop = 0; }""")
            await qkp.evaluate("""(seat) => { RoomUI._session().side.act({
              op: 'scene.clue', seat: seat, title: '上滚验证', text: '不应拉回底部' }); }""", q_seat)
            await qpl.wait_for_timeout(1300)
            q_priv2 = await qpl.evaluate(Q_PRIV_JS)
            check("★ ★ v2.1.8-Q9 用户上滚看旧线索时，重画**不**强行拉回底部（智能跟随，scrollTop 保持在顶部附近）",
                  bool(q_priv2) and q_priv2["scrollable"] and q_priv2["scrollTop"] <= 20,
                  q_priv2)
            check("★ ★ v2.1.8-Q10 上滚后 scrollTop 仍在顶部附近（未跳回底部）且容器高度不变（不随消息数增长）",
                  bool(q_priv2) and q_priv2["atBottom"] is False
                  and abs(q_priv2["h"] - q_priv1["h"]) <= 2,
                  {"before": q_priv1, "after": q_priv2})
            # 回到底部（点最新一条的语义恢复由下一次跟随完成；这里手动复位供截图）
            await qpl.evaluate("""() => { const p = document.querySelector('.game-page.gp-pl .gp-priv');
              p.scrollTop = p.scrollHeight; }""")
            await qpl.wait_for_timeout(200)

            # ---- 截图：tools/shots_v218/（1180×820 → 844×390 → 竖屏）----
            await qpl.screenshot(path=os.path.join(SHOTS218, "pl_1180x820.png"), full_page=True)
            await qkp.screenshot(path=os.path.join(SHOTS218, "kp_1280x860.png"), full_page=True)

            # ---- Q11：竖屏（单列）输入条也在聊天框正下方（旧 sticky 会吸到视口底、悬在聊天框中间）----
            await qpl.set_viewport_size({"width": 390, "height": 844})
            await qpl.wait_for_timeout(500)
            q_chat_p = await qpl.evaluate(Q_CHAT_JS)
            check("★ ★ v2.1.8-Q11 竖屏单列：输入条位于聊天框正下方（bottom 对齐；旧 sticky 实测悬空 180px）",
                  bool(q_chat_p) and q_chat_p["relBottom"] <= 2 and q_chat_p["inBox"], q_chat_p)
            await qpl.screenshot(path=os.path.join(SHOTS218, "pl_390x844.png"), full_page=True)

            # ---- Q12：844×390（手机横屏档，全新载入 → 自动 82% 缩放）：主图 16:9 且可见 ----
            # 注意：不能对旧页 reload —— 断线重连需要用户点「继续」才会回到游戏页；
            # 用全新 844×390 上下文走真实加入流程（= 真机「首次以手机横屏进房」路径）。
            ctx_q_pl2 = await browser.new_context(viewport={"width": 844, "height": 390})
            qpl2 = await ctx_q_pl2.new_page()
            qpl2.on("pageerror", lambda e: errors.append("[Q-PL2] %s" % e))
            qpl2.on("console", lambda m: errors.append("[Q-PL2] %s" % m.text)
                    if m.type == "error" else None)
            await join_room(qpl2, q_code, "横屏玩家", ROOM_BASE)
            await qpl2.wait_for_timeout(2200)
            q_stage_s = await qpl2.evaluate("""() => {
              const s = document.querySelector('.game-page.gp-pl .gp-center .map-stage');
              if (!s) return null; const r = s.getBoundingClientRect();
              return { w: Math.round(r.width), h: Math.round(r.height),
                       ratio: r.height ? +(r.width / r.height).toFixed(4) : null,
                       zoomCls: (document.querySelector('.game-page') || {}).className || '' };
            }""")
            check("★ ★ v2.1.8-Q12 844×390（自动缩放档）：中央公开素材 16:9 且**可见**（旧版塌成 2×2）",
                  bool(q_stage_s) and q_stage_s["w"] >= 60 and q_stage_s["h"] >= 30
                  and q_stage_s["ratio"] is not None
                  and abs(q_stage_s["ratio"] - 1.7778) <= 0.06, q_stage_s)
            await qpl2.screenshot(path=os.path.join(SHOTS218, "pl_844x390.png"), full_page=True)
            await ctx_q_pl2.close()

            await ctx_q_kp.close()
            await ctx_q_pl.close()

            await ctx_sh.close()
            await ctx_sh_p.close()

            def noise(e):
                return ("favicon" in e) or ("Failed to load resource" in e) \
                    or ("net::ERR_CONNECTION" in e) or ("WebSocket connection to" in e and "closed" in e)

            real = [e for e in errors if not noise(e)]
            print("\n控制台错误：%d 条" % len(real), flush=True)
            for e in real[:10]:
                print("   " + e, flush=True)

            await browser.close()
    finally:
        if srv_room:
            srv_room.kill()
            try:
                srv_room.wait(timeout=5)
            except Exception:
                pass
        if srv_static:
            srv_static.shutdown()
        shutil.rmtree(dbdir, ignore_errors=True)

    ok = sum(1 for _, o, _ in results if o)
    print("\n===== 结果 %d / %d =====" % (ok, len(results)), flush=True)
    if ok != len(results):
        print("失败项：", flush=True)
        for nme, o, d in results:
            if not o:
                print("   [!!] " + nme + ("  <- " + str(d) if d else ""), flush=True)
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
