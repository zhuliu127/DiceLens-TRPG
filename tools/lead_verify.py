# -*- coding: utf-8 -*-
"""lead_verify.py — Team Lead 独立验证 T16（z-index）+ 全尺寸几何快照

与工程师/QA 的探针完全独立：自己的驱动、自己的断言。
用法：COC_STATIC_PORT=8939 COC_ROOM_PORT=12797 <python> lead_verify.py
"""
import asyncio, json, os, subprocess, sys, tempfile, threading, time
import urllib.request, urllib.parse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_PORT = int(os.environ.get("COC_STATIC_PORT") or 8939)
ROOM_PORT = int(os.environ.get("COC_ROOM_PORT") or 12797)
BASE = "http://127.0.0.1:%d/index.html" % STATIC_PORT
ROOM_BASE = "http://127.0.0.1:%d" % ROOM_PORT
OUT = r"C:/Users/60965/WorkBuddy AI/2026-10-11-01-05-06/lead_shots"

SESSION_JS = """() => { const s=RoomUI._session(); if(!s) return null;
  return { role: s.role, code: s.code, seat: s.client ? s.client.seat : 'host' }; }"""
CLICK_BTN_JS = """(src) => { const rx=new RegExp(src);
  const b=[...document.querySelectorAll('button')].find(x=>rx.test(x.textContent));
  if(!b) return false; b.click(); return true; }"""
CLICK_EXACT_JS = """(l)=>{const b=[...document.querySelectorAll('button')]
  .find(x=>x.textContent.trim()===l); if(!b)return false; b.click(); return true;}"""
FILL_SHEET_JS = """(vals)=>{const sh=[...document.querySelectorAll('.sheet')].pop();
  if(!sh)return false; const ins=[...sh.querySelectorAll('input')];
  vals.forEach((v,i)=>{if(ins[i]===undefined)return;ins[i].value=v;
    ins[i].dispatchEvent(new Event('input',{bubbles:true}));
    ins[i].dispatchEvent(new Event('change',{bubbles:true}));}); return ins.length;}"""
CREATE_CHAR_JS = """(name)=>{const c=Store.newCharacter('coc7'); c.characterName=name;
  c.status=Object.assign({},c.status,{currentHP:12,maxHP:12,currentMP:10,maxMP:10,
  currentSAN:55,maxSAN:99,currentLuck:50}); Store.savePreset(c); return c.id;}"""

# 核心：独立几何 + z-index 命中探针
VERIFY_JS = r"""() => {
  const gp = document.querySelector('.game-page');
  if (!gp) return { hasGamePage: false };
  const q = (s) => gp.querySelector(s);
  const box = (e) => { if(!e) return null; const r=e.getBoundingClientRect();
    return { x:Math.round(r.left), y:Math.round(r.top), w:Math.round(r.width), h:Math.round(r.height) }; };
  const out = { hasGamePage: true, grid: gp.classList.contains('gp-grid'),
                vw: innerWidth, vh: innerHeight };

  // ---- T16 验证：工具栏顶边 +6px 命中测试 ----
  const tb = q('.gp-toolbar');
  out.toolbarBox = box(tb);
  out.toolbarZ = tb ? getComputedStyle(tb).zIndex : null;
  if (tb) {
    const r = tb.getBoundingClientRect();
    const px = Math.round(r.left + r.width / 2), py = Math.round(r.top + 6);
    const hit = document.elementFromPoint(px, py);
    out.t16 = {
      probe: { x: px, y: py },
      hitTag: hit ? hit.tagName : null,
      hitClass: hit ? String(hit.className) : null,
      inToolbar: !!(hit && hit.closest('.gp-toolbar')),
      isChatbar: !!(hit && hit.closest('.room-chatbar') && !hit.closest('.gp-toolbar'))
    };
  }
  // ---- 工具：网格子项越界检测 ----
  const main = q('.gp-main-kp') || q('.gp-main-pl');
  out.mainSel = q('.gp-main-kp') ? 'kp' : 'pl';
  out.mainBox = box(main);
  if (main) {
    out.mainDisplay = getComputedStyle(main).display;
    out.mainCols = getComputedStyle(main).gridTemplateColumns;
    const mb = main.getBoundingClientRect();
    const over = [];
    [...main.children].forEach((c) => {
      const r = c.getBoundingClientRect();
      const d = Math.round(r.bottom - mb.bottom);
      if (d > 2) over.push({ cls: String(c.className).slice(0,40), over: d });
    });
    out.overflows = over;
  }
  // ---- 关键元素 ----
  out.mapBox = box(q('.gp-region-kp-map') || q('.gp-region-pl-map'));
  const ig = q('.icon-grid');
  out.iconGridCols = ig ? getComputedStyle(ig).gridTemplateColumns : null;
  out.iconCells = ig ? ig.querySelectorAll('.icon-cell').length : 0;
  const sb = q('.stat-bar');
  out.statBar = sb ? { h: Math.round(sb.getBoundingClientRect().height),
                       ov: getComputedStyle(sb).overflow,
                       cls: String(sb.className) } : null;
  const ar = q('.attr-row');
  out.attrRow = ar ? { d: getComputedStyle(ar).display,
                       cols: getComputedStyle(ar).gridTemplateColumns.split(' ').length,
                       h: Math.round(ar.getBoundingClientRect().height) } : null;
  // ---- 顶栏（缺陷A 验证）----
  const gi = q('.gp-topbar-inner > .grow');
  out.growBox = box(gi);
  const td = q('.gp-topbar-inner > .grow .tiny.dim');
  if (td) { const cs = getComputedStyle(td);
    out.tinyDimWrap = cs.whiteSpace + '/' + cs.textOverflow;
    out.tinyDimText = td.textContent.slice(0, 60); }
  // ---- 掉线指示 ----
  const lk = q('.gp-link');
  out.linkText = lk ? lk.textContent : null;
  out.linkVisible = lk ? lk.offsetParent !== null : false;
  // ---- PL 区域 ----
  out.plRegions = { card: !!q('.gp-region-pl-card'), map: !!q('.gp-region-pl-map'),
    mates: !!q('.gp-region-pl-mates'),
    log: !!q('.gp-region-pl-log.gp-region'), chat: !!q('.gp-region-pl-chat.gp-region') };
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


def start_room(db):
    env = dict(os.environ, ROOM_PORT=str(ROOM_PORT), ROOM_HOST="127.0.0.1",
               ROOM_DB=os.path.join(db, "r.db"), ROOM_PUBLIC_BASE=ROOM_BASE)
    p = subprocess.Popen([sys.executable, os.path.join(ROOT, "tools", "room_server.py")],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    for _ in range(80):
        try:
            urllib.request.urlopen(ROOM_BASE + "/health", timeout=0.5); return p
        except Exception: time.sleep(0.25)
    return p


async def wait_for(pg, js, t=10.0):
    end = time.time() + t
    while time.time() < end:
        try:
            if await pg.evaluate(js): return True
        except Exception: pass
        await pg.wait_for_timeout(200)
    return False


async def boot(b, vw, vh, dpr=1.0):
    ctx = await b.new_context(viewport={"width": vw, "height": vh}, device_scale_factor=dpr)
    pg = await ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    await pg.goto(BASE); await pg.wait_for_timeout(900)
    await pg.evaluate("() => { try{localStorage.clear();}catch(e){} }")
    await pg.reload(); await pg.wait_for_timeout(900)
    await pg.evaluate("(b)=>Store.setSettings({roomBase:b})", ROOM_BASE)
    return ctx, pg, errs


async def enter_game(b, vw, vh, tag, dpr=1.0):
    ctx_kp, kp, ekp = await boot(b, vw, vh, dpr)
    await kp.evaluate("() => App.go('#/room')"); await kp.wait_for_timeout(400)
    await kp.evaluate(CLICK_BTN_JS, "创建房间"); await kp.wait_for_timeout(500)
    await kp.evaluate(FILL_SHEET_JS, ["测试-" + tag, "KPT", ""])
    await kp.evaluate(CLICK_EXACT_JS, "创建"); await kp.wait_for_timeout(1700)
    ks = await kp.evaluate(SESSION_JS)
    if not ks: return None
    ctx_pl, pl, epl = await boot(b, vw, vh, dpr)
    inv = "%s?room=%s&srv=%s" % (BASE, ks["code"], urllib.parse.quote(ROOM_BASE, safe=""))
    await pl.goto(inv); await pl.wait_for_timeout(1300)
    await pl.evaluate(CLICK_BTN_JS, "加入这个房间"); await pl.wait_for_timeout(500)
    await pl.evaluate(FILL_SHEET_JS, [ks["code"], "玩家小李", ""]); await pl.wait_for_timeout(400)
    await pl.evaluate(CLICK_EXACT_JS, "加入")
    await wait_for(pl, "()=>{const s=RoomUI._session();return s&&s.client&&s.client.seat?true:null;}", 12)
    await pl.evaluate(CREATE_CHAR_JS, "调查员小李")
    await pl.evaluate(CLICK_BTN_JS, "绑定角色卡"); await pl.wait_for_timeout(400)
    await pl.evaluate("""()=>{const sh=[...document.querySelectorAll('.sheet')].pop();
      if(!sh)return false; const b=[...sh.querySelectorAll('button')]
      .find(x=>x.textContent.trim()==='绑定'||x.textContent.trim()==='重新同步');
      if(!b)return false; b.click(); return true;}""")
    await wait_for(pl, """()=>{const s=RoomUI._session(); if(!s||!s.client)return null;
      const me=(s.client.state.members||[]).find(m=>m.seat===s.client.seat);
      return me&&me.charName?me.charName:null;}""", 8)
    await pl.evaluate(CLICK_EXACT_JS, "我准备好了")
    await kp.wait_for_timeout(900)
    await kp.evaluate(CLICK_EXACT_JS, "开始游戏")
    await kp.wait_for_timeout(1500)
    return (ctx_kp, kp, ekp, ctx_pl, pl, epl)


async def main():
    os.makedirs(OUT, exist_ok=True)
    db = tempfile.mkdtemp(prefix="lead-verify-")
    s1 = start_static(); s2 = start_room(db)
    print("=== static=%d room=%d ===" % (STATIC_PORT, ROOM_PORT), flush=True)
    res = {}
    try:
        async with async_playwright() as pw:
            b = await pw.chromium.launch()
            for tag, vw, vh, dpr in [("844x390横屏", 844, 390, 1.0),
                                     ("1180x820平板", 1180, 820, 1.0),
                                     ("390x844手机", 390, 844, 2.0),
                                     ("1280x800宽屏", 1280, 800, 1.0)]:
                print("\n== %s ==" % tag, flush=True)
                r = await enter_game(b, vw, vh, tag, dpr)
                if not r:
                    print("   setup 失败", flush=True); res[tag] = "setup failed"; continue
                ck, kp, ekp, cp, pl, epl = r
                gk = await kp.evaluate(VERIFY_JS)
                gp_ = await pl.evaluate(VERIFY_JS)
                res[tag] = {"KP": gk, "PL": gp_}
                print("  KP: grid=%s main=%s display=%s overflows=%s" % (
                    gk.get("grid"), gk.get("mainSel"), gk.get("mainDisplay"),
                    gk.get("overflows")), flush=True)
                print("  KP cols=%s" % gk.get("mainCols"), flush=True)
                print("  T16: %s" % json.dumps(gk.get("t16"), ensure_ascii=False), flush=True)
                print("  statBar=%s attrRow=%s" % (json.dumps(gk.get("statBar"), ensure_ascii=False),
                                                   json.dumps(gk.get("attrRow"), ensure_ascii=False)), flush=True)
                print("  grow=%s tinyDimWrap=%s" % (json.dumps(gk.get("growBox"), ensure_ascii=False),
                                                    gk.get("tinyDimWrap")), flush=True)
                print("  iconCells=%s cols=%s map=%s" % (
                    gk.get("iconCells"), (gk.get("iconGridCols") or "")[:52],
                    json.dumps(gk.get("mapBox"), ensure_ascii=False)), flush=True)
                # 掉线
                await pl.evaluate("() => RoomUI._setLinkState('player','offline')")
                await pl.wait_for_timeout(350)
                off = await pl.evaluate(VERIFY_JS)
                res[tag]["PL_offline"] = {k: off.get(k) for k in ("linkText", "linkVisible")}
                print("  掉线: %s" % json.dumps(res[tag]["PL_offline"], ensure_ascii=False), flush=True)
                await kp.screenshot(path=os.path.join(OUT, "verify_%s_KP.png" % tag), full_page=True)
                await pl.screenshot(path=os.path.join(OUT, "verify_%s_PL.png" % tag), full_page=True)
                res[tag]["errors"] = {"kp": ekp[:4], "pl": epl[:4]}
                await ck.close(); await cp.close()
            await b.close()
    finally:
        try: s2.terminate()
        except Exception: pass
        try: s1.shutdown()
        except Exception: pass
    p = os.path.join(OUT, "lead_verify_result.json")
    with open(p, "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=2)
    print("\n===== 写入 %s =====" % p, flush=True)


if __name__ == "__main__":
    asyncio.run(main())
