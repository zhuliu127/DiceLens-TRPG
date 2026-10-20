# -*- coding: utf-8 -*-
"""
lead_geom.py — Team Lead 独立几何测量（v2）

用**已由 UI 测试验证过的驱动序列**进入游戏页，但在**我自己选的设备尺寸**上
实测几何并截图，作为演示/验收证据。

- 平板：1180x820（类 iPad Air 横屏）
- 手机：390x844 DPR2（类主流安卓手机）
- 边界：599x900 / 600x900

用法：COC_STATIC_PORT=8931 COC_ROOM_PORT=12793 <managed python> lead_geom.py
"""
import asyncio, json, os, subprocess, sys, tempfile, threading, time
import urllib.request, urllib.parse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_PORT = int(os.environ.get("COC_STATIC_PORT") or 8931)
ROOM_PORT = int(os.environ.get("COC_ROOM_PORT") or 12793)
BASE = "http://127.0.0.1:%d/index.html" % STATIC_PORT
ROOM_BASE = "http://127.0.0.1:%d" % ROOM_PORT
OUT = r"C:/Users/60965/WorkBuddy AI/2026-10-11-01-05-06/lead_shots"

SESSION_JS = """() => {
  const s = RoomUI._session();
  if (!s) return null;
  return { role: s.role, code: s.code, seat: s.client ? s.client.seat : 'host' };
}"""
CLICK_BTN_JS = """(src) => { const rx = new RegExp(src);
  const b = [...document.querySelectorAll('button')].find(x => rx.test(x.textContent));
  if (!b) return false; b.click(); return true; }"""
CLICK_EXACT_JS = """(label) => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === label);
  if (!b) return false; b.click(); return true; }"""
FILL_SHEET_JS = """(vals) => {
  const sh = [...document.querySelectorAll('.sheet')].pop();
  if (!sh) return false;
  const ins = [...sh.querySelectorAll('input')];
  vals.forEach((v, i) => { if (ins[i] === undefined) return;
    ins[i].value = v;
    ins[i].dispatchEvent(new Event('input', { bubbles: true }));
    ins[i].dispatchEvent(new Event('change', { bubbles: true })); });
  return ins.length; }"""
CREATE_CHAR_JS = """(name) => {
  const c = Store.newCharacter('coc7');
  c.characterName = name;
  c.status = Object.assign({}, c.status, {
    currentHP: 12, maxHP: 12, currentMP: 10, maxMP: 10,
    currentSAN: 55, maxSAN: 99, currentLuck: 50 });
  Store.savePreset(c);
  return c.id; }"""

GEOM_JS = r"""() => {
  const gp = document.querySelector('.game-page');
  const out = { hasGamePage: !!gp };
  if (!gp) return out;
  out.gridClass = gp.classList.contains('gp-grid');
  out.vw = window.innerWidth; out.vh = window.innerHeight;
  out.dpr = window.devicePixelRatio;
  const q = (s) => gp.querySelector(s);
  const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top),
             w: Math.round(r.width), h: Math.round(r.height) }; };
  const main = q('.gp-main-kp') || q('.gp-main-pl');
  out.mainSel = q('.gp-main-kp') ? '.gp-main-kp' : (q('.gp-main-pl') ? '.gp-main-pl' : null);
  out.mainBox = box(main);
  if (main) { const cs = getComputedStyle(main);
    out.mainDisplay = cs.display; out.mainCols = cs.gridTemplateColumns;
    out.mainRows = cs.gridTemplateRows;
    out.mainScrollH = main.scrollHeight; out.mainClientH = main.clientHeight; }
  const zoom = q('.gp-zoom'); out.zoomBox = box(zoom);
  if (zoom) { out.zoomH = getComputedStyle(zoom).height;
    out.zoomScrollH = zoom.scrollHeight; out.zoomClientH = zoom.clientHeight; }
  const map = q('.gp-region-kp-map') || q('.gp-region-pl-map');
  out.mapSel = q('.gp-region-kp-map') ? 'kp' : (q('.gp-region-pl-map') ? 'pl' : null);
  out.mapBox = box(map);
  const ig = q('.icon-grid'); out.iconGridBox = box(ig);
  if (ig) { const cs = getComputedStyle(ig);
    out.iconGridDisplay = cs.display; out.iconGridCols = cs.gridTemplateColumns;
    out.iconCells = ig.querySelectorAll('.icon-cell').length; }
  const cr = q('.color-row'); out.colorRowBox = box(cr);
  if (cr) out.colorRowDisplay = getComputedStyle(cr).display;
  const ar = q('.attr-row'); out.attrRowBox = box(ar);
  if (ar) { const cs = getComputedStyle(ar);
    out.attrDisplay = cs.display; out.attrCols = cs.gridTemplateColumns;
    out.attrH = Math.round(ar.getBoundingClientRect().height); }
  const sb = q('.stat-bar'); out.statBarBox = box(sb);
  if (sb) { out.sbH = Math.round(sb.getBoundingClientRect().height);
    out.sbOverflow = getComputedStyle(sb).overflow; }
  out.plRegions = { card: !!q('.gp-region-pl-card'), map: !!q('.gp-region-pl-map'),
    mates: !!q('.gp-region-pl-mates'), feeds: !!q('.gp-region-pl-feeds'),
    log: !!q('.gp-region-pl-log.gp-region'), chat: !!q('.gp-region-pl-chat.gp-region') };
  out.kpRegions = { left: !!q('.gp-region-kp-left'), tools: !!q('.gp-region-kp-tools'),
    map: !!q('.gp-region-kp-map'), combat: !!q('.gp-region-kp-combat'),
    scene: !!q('.gp-region-kp-scene'), players: !!q('.gp-region-kp-players'),
    log: !!q('.gp-region-kp-log'), chat: !!q('.gp-region-kp-chat') };
  const lk = q('.gp-link'); out.linkBox = box(lk);
  out.linkText = lk ? lk.textContent : null;
  out.linkVisible = lk ? lk.offsetParent !== null : false;
  const pv = q('.gp-priv'); out.privBox = box(pv);
  out.privText = pv ? pv.textContent : null;
  out.privChildCount = pv ? pv.children.length : 0;
  return out;
}"""


def start_static():
    from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
    from functools import partial
    class Q(SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    srv = ThreadingHTTPServer(("127.0.0.1", STATIC_PORT),
                              partial(Q, directory=os.path.join(ROOT, "web")))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def start_room(dbdir):
    env = dict(os.environ, ROOM_PORT=str(ROOM_PORT), ROOM_HOST="127.0.0.1",
               ROOM_DB=os.path.join(dbdir, "r.db"), ROOM_PUBLIC_BASE=ROOM_BASE)
    p = subprocess.Popen([sys.executable, os.path.join(ROOT, "tools", "room_server.py")],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    for _ in range(80):
        try:
            urllib.request.urlopen(ROOM_BASE + "/health", timeout=0.5); return p
        except Exception: time.sleep(0.25)
    return p


async def wait_for(pg, js, timeout=10.0):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if await pg.evaluate(js): return True
        except Exception: pass
        await pg.wait_for_timeout(200)
    return False


async def boot(browser, vw, vh, dpr=1.0):
    ctx = await browser.new_context(viewport={"width": vw, "height": vh}, device_scale_factor=dpr)
    pg = await ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    await pg.goto(BASE); await pg.wait_for_timeout(900)
    await pg.evaluate("() => { try{localStorage.clear();}catch(e){} }")
    await pg.reload(); await pg.wait_for_timeout(900)
    await pg.evaluate("(b)=>Store.setSettings({roomBase:b})", ROOM_BASE)
    return ctx, pg, errs


async def create_room(pg, name, nick):
    await pg.evaluate("() => App.go('#/room')"); await pg.wait_for_timeout(400)
    await pg.evaluate(CLICK_BTN_JS, "创建房间"); await pg.wait_for_timeout(500)
    await pg.evaluate(FILL_SHEET_JS, [name, nick, ""])
    await pg.evaluate(CLICK_EXACT_JS, "创建"); await pg.wait_for_timeout(1800)
    return await pg.evaluate(SESSION_JS)


async def join_room(pg, code, nick):
    invite = "%s?room=%s&srv=%s" % (BASE, code, urllib.parse.quote(ROOM_BASE, safe=""))
    await pg.goto(invite); await pg.wait_for_timeout(1300)
    await pg.evaluate(CLICK_BTN_JS, "加入这个房间"); await pg.wait_for_timeout(500)
    await pg.evaluate(FILL_SHEET_JS, [code, nick, ""]); await pg.wait_for_timeout(400)
    await pg.evaluate(CLICK_EXACT_JS, "加入")
    await wait_for(pg, "() => { const s=RoomUI._session();"
                       " return s && s.client && s.client.seat ? true : null; }", 12.0)
    return await pg.evaluate(SESSION_JS)


async def ensure_card(pg, name="调查员"):
    await pg.evaluate(CREATE_CHAR_JS, name)
    if not await pg.evaluate(CLICK_BTN_JS, "绑定角色卡"):
        await pg.evaluate(CLICK_BTN_JS, "更换角色卡")
    await pg.wait_for_timeout(400)
    await pg.evaluate("""() => { const sh=[...document.querySelectorAll('.sheet')].pop();
      if(!sh) return false;
      const b=[...sh.querySelectorAll('button')].find(x=>x.textContent.trim()==='绑定'
        || x.textContent.trim()==='重新同步'); if(!b) return false; b.click(); return true; }""")
    await wait_for(pg, """() => { const s=RoomUI._session(); if(!s||!s.client) return null;
      const me=(s.client.state.members||[]).find(m=>m.seat===s.client.seat);
      return me && me.charName ? me.charName : null; }""", 8.0)


async def snapshot(pg, tag, results):
    g = await pg.evaluate(GEOM_JS)
    results[tag] = g
    await pg.screenshot(path=os.path.join(OUT, tag + ".png"), full_page=True)
    key = ("gridClass","vw","vh","mainSel","mainDisplay","mainCols","zoomClientH",
           "mapBox","iconGridCols","iconCells","colorRowDisplay","attrDisplay",
           "attrCols","attrH","sbH","sbOverflow","linkText","privText")
    print("   [%s] %s" % (tag, json.dumps({k: g.get(k) for k in key if g.get(k) is not None},
                                          ensure_ascii=False)), flush=True)
    return g


async def scenario(browser, results, tag, vw, vh, dpr):
    """建 KP 房 → PL 加入 → 绑卡 → 准备 → 开局 → 双端测量"""
    print("\n== [%s] %dx%d dpr=%s ==" % (tag, vw, vh, dpr), flush=True)
    ctx_kp, kp, ekp = await boot(browser, vw, vh, dpr)
    ks = await create_room(kp, "测试房-" + tag, "KP老张")
    if not ks:
        print("   建房失败", flush=True); results[tag + "_err"] = "create failed"; return
    print("   KP ok code=%s" % ks["code"], flush=True)
    await kp.screenshot(path=os.path.join(OUT, tag + "_1_lobby.png"), full_page=True)

    ctx_pl, pl, epl = await boot(browser, vw, vh, dpr)
    ps = await join_room(pl, ks["code"], "玩家小李")
    if not ps:
        print("   加入失败", flush=True); results[tag + "_err"] = "join failed"
        await snapshot(kp, tag + "_KP_only", results); return
    print("   PL ok seat=%s" % ps["seat"], flush=True)

    await ensure_card(pl, "调查员小李")
    await pl.evaluate(CLICK_EXACT_JS, "我准备好了")
    await kp.wait_for_timeout(1000)
    ok = await kp.evaluate(CLICK_EXACT_JS, "开始游戏")
    print("   开局点击=%s" % ok, flush=True)
    await kp.wait_for_timeout(1500)

    await snapshot(kp, tag + "_KP", results)
    await snapshot(pl, tag + "_PL", results)

    # 掉线提示
    await pl.evaluate("() => RoomUI._setLinkState('player','offline')")
    await pl.wait_for_timeout(400)
    off = await pl.evaluate(GEOM_JS)
    results[tag + "_PL_offline"] = {k: off.get(k) for k in
        ("linkText","linkVisible","linkBox")}
    await pl.screenshot(path=os.path.join(OUT, tag + "_PL_offline.png"), full_page=True)
    print("   掉线态: %s" % json.dumps(results[tag + "_PL_offline"], ensure_ascii=False), flush=True)

    results[tag + "_errors"] = {"kp": ekp[:5], "pl": epl[:5]}
    await ctx_kp.close(); await ctx_pl.close()


async def main():
    os.makedirs(OUT, exist_ok=True)
    db = tempfile.mkdtemp(prefix="lead-geom-")
    s_static = start_static(); s_room = start_room(db)
    print("=== 服务 static=%d room=%d ===" % (STATIC_PORT, ROOM_PORT), flush=True)
    results = {}
    try:
        async with async_playwright() as pw:
            b = await pw.chromium.launch()
            await scenario(b, results, "a4check_412", 412, 900, 1.0)
            await scenario(b, results, "tablet_kp", 1180, 820, 1.0)
            await scenario(b, results, "phone_pl", 390, 844, 2.0)
            await scenario(b, results, "bound599", 599, 900, 1.0)
            await scenario(b, results, "bound600", 600, 900, 1.0)
            await b.close()
    finally:
        try: s_room.terminate()
        except Exception: pass
        try: s_static.shutdown()
        except Exception: pass
    p = os.path.join(OUT, "lead_geom_result.json")
    with open(p, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print("\n===== 结果写入 %s =====" % p, flush=True)


if __name__ == "__main__":
    asyncio.run(main())
