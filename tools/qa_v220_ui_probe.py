# -*- coding: utf-8 -*-
"""qa_v220_ui_probe.py —— v2.2.0 需求 1/2 的**独立**无头复现（QA 严过关）

只借用 test_room_ui.py 的「起服务 / 建房 / 入房 / 开团」公共骨架（boot plumbing），
所有 v2.2.0 行为断言由本文件**独立**编写，不复用工程师的 v220 用例。

覆盖：
  UI-1 新消息（他人）→ 对应信息流容器出现 .gp-flash
  UI-2 约 3 秒后 .gp-flash 自动移除
  UI-3 自己发的消息不触发闪烁
  UI-4 重绘（viewport resize 触发的 repaint）不重新触发闪烁
  UI-5 点信息流标题 → 进入 .gp-fs--feeds 全屏；标题栏可见
  UI-6 全屏内聊天输入行随之搬移（仍可输入）→ 返回后聊天草稿保留
  UI-7 竖屏单列：逐个栏目收起后，DOM 矩形两两求交无重叠（重点：块7 玩家信息）
  UI-8 收起态 body 被隐藏（display:none）/ 高度归零

运行（用带 playwright 的 python）：
  PYTHONPATH=<venv site-packages> python tools/qa_v220_ui_probe.py
"""
import asyncio, os, sys, tempfile, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_room_ui as T  # noqa: E402
from playwright.async_api import async_playwright  # noqa: E402

R = []
def check(name, ok, detail=""):
    R.append((name, bool(ok), detail))
    print(("  [OK] " if ok else "  [!!] ") + name + (("  <- " + str(detail)) if detail else ""), flush=True)

SEND_CHAT_JS = """(text) => {
  const i = document.querySelector('.room-chatbar input')
        || document.querySelector('.gp-chat input');
  if (!i) return 'no-input';
  i.value = text;
  i.dispatchEvent(new Event('input', { bubbles: true }));
  const btn = [...document.querySelectorAll('.room-chatbar button, .gp-chat button')]
        .find(x => x.textContent.trim() === '发送');
  if (btn) { btn.click(); return 'clicked'; }
  i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return 'enter';
}"""

RECTS_JS = """() => {
  const gp = document.querySelector('.game-page');
  if (!gp) return null;
  const sel = '.gp-region, .gp-priv, .gp-info, .gp-region-kp-right, .gp-right-mid';
  const els = [...gp.querySelectorAll(sel)];
  return els.map(e => {
    const r = e.getBoundingClientRect();
    return { cls: e.className, x: r.x, y: r.y, w: r.width, h: r.height,
             folded: e.classList.contains('folded') };
  });
}"""


def overlaps(a, b, tol=1.0):
    ax2, ay2 = a["x"] + a["w"], a["y"] + a["h"]
    bx2, by2 = b["x"] + b["w"], b["y"] + b["h"]
    ix = min(ax2, bx2) - max(a["x"], b["x"])
    iy = min(ay2, by2) - max(a["y"], b["y"])
    return ix > tol and iy > tol


async def main():
    dbdir = tempfile.mkdtemp(prefix="qa_v220_ui_")
    srv_room = T.start_room_server(dbdir)
    srv_static, _ = T.ensure_static()
    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch()
            ctx = await browser.new_context(viewport={"width": 390, "height": 844})
            kp = await ctx.new_page()
            pl = await ctx.new_page()
            kp.on("pageerror", lambda e: print("   KP pageerror:", e, flush=True))
            pl.on("pageerror", lambda e: print("   PL pageerror:", e, flush=True))

            code = await T.make_room(kp, "QA房间", "KP", T.ROOM_BASE)
            await T.join_room(pl, code, "玩家", T.ROOM_BASE)
            await T.start_game(kp, pl)
            await kp.wait_for_timeout(800)
            await kp.wait_for_selector(".game-page", timeout=15000)
            await pl.wait_for_selector(".game-page", timeout=15000)

            gp_cls = await kp.evaluate("() => document.querySelector('.game-page').className")
            check("UI-0 KP 竖屏(390x844) 进入单列布局 .game-page:not(.gp-grid)",
                  "gp-grid" not in gp_cls, gp_cls)

            # 让 KP 完成首帧 feedFlashCheck（首次绘制只登记基线）
            await kp.wait_for_selector(".gp-chat", timeout=8000)
            await kp.wait_for_timeout(300)

            # ---- UI-3 自己发的消息不触发闪烁 ----
            await kp.evaluate(SEND_CHAT_JS, "KP自己说话")
            await kp.wait_for_timeout(700)
            own_flash = await kp.evaluate("() => document.querySelector('.gp-chat').classList.contains('gp-flash')")
            check("UI-3 KP 自己发消息 → 不触发闪烁", own_flash is False, own_flash)
            await kp.wait_for_timeout(3200)

            # ---- UI-1 他人新消息 → 闪烁 ----
            r = await pl.evaluate(SEND_CHAT_JS, "玩家打招呼")
            check("UI-1a 玩家发送聊天动作已执行", r in ("clicked", "enter"), r)
            got = False
            for _ in range(20):
                await kp.wait_for_timeout(200)
                if await kp.evaluate("() => document.querySelector('.gp-chat').classList.contains('gp-flash')"):
                    got = True
                    break
            check("UI-1b KP 收到他人新消息 → .gp-chat 出现 gp-flash", got)

            # ---- UI-4 重绘不触发（先等闪烁消失，再触发 repaint，确认不再出现）----
            await kp.wait_for_timeout(3400)
            gone = await kp.evaluate("() => !document.querySelector('.gp-chat').classList.contains('gp-flash')")
            check("UI-2 约 3 秒后 gp-flash 自动移除", gone)
            # 触发 repaint：resize（等价一次重绘）
            await kp.set_viewport_size({"width": 391, "height": 844})
            await kp.wait_for_timeout(500)
            reflash = await kp.evaluate("() => document.querySelector('.gp-chat').classList.contains('gp-flash')")
            check("UI-4 repaint(resize) 无新消息 → 不闪", reflash is False, reflash)
            await kp.set_viewport_size({"width": 390, "height": 844})
            await kp.wait_for_timeout(300)

            # ---- UI-5/6 全屏查看 + 草稿保留 ----
            # 先在全屏外往输入框写草稿
            draft = "这是全屏前输入的草稿XYZ"
            await kp.evaluate("""(t) => {
              const i = document.querySelector('.gp-chat .room-chatbar input');
              if (i) { i.value = t; i.dispatchEvent(new Event('input', { bubbles: true })); }
            }""", draft)
            await kp.evaluate("""() => {
              const h = document.querySelector('.gp-chat .gp-region-head .gp-region-head-t')
                    || document.querySelector('.gp-chat .gp-region-head');
              h.click();
            }""")
            await kp.wait_for_timeout(400)
            fs = await kp.evaluate("() => !!document.querySelector('.gp-fs.gp-fs--feeds')")
            check("UI-5 点标题 → 进入 .gp-fs.gp-fs--feeds 全屏", fs)
            moved = await kp.evaluate("() => !!document.querySelector('.gp-fs--feeds .gp-chat .room-chatbar input')")
            check("UI-6a 全屏内聊天输入行随之搬移（含草稿）", moved)
            val = await kp.evaluate("() => { const i = document.querySelector('.gp-fs--feeds .gp-chat .room-chatbar input'); return i ? i.value : null; }")
            check("UI-6b 全屏内草稿仍在", val == draft, val)
            # 点返回
            await kp.evaluate("""() => {
              const b = [...document.querySelectorAll('.gp-fs--feeds button')]
                .find(x => /返回/.test(x.textContent));
              if (b) b.click();
            }""")
            await kp.wait_for_timeout(400)
            back = await kp.evaluate("() => !document.querySelector('.gp-fs--feeds')")
            check("UI-6c 点返回 → 退出全屏", back)
            val2 = await kp.evaluate("() => { const i = document.querySelector('.gp-chat .room-chatbar input'); return i ? i.value : null; }")
            check("UI-6d 返回后聊天草稿保留", val2 == draft, val2)

            # ---- UI-7/8 竖屏折叠不重叠 ----
            # 折叠所有带折叠标题的栏目
            collapsed = await kp.evaluate("""() => {
              const gp = document.querySelector('.game-page');
              const heads = [...gp.querySelectorAll('.gp-region-fold, .gp-region-fold--inline')];
              let n = 0;
              heads.forEach(h => { h.click(); n++; });
              return n;
            }""")
            await kp.wait_for_timeout(400)
            check("UI-7a 找到折叠标题并逐一点击", collapsed and collapsed > 0, collapsed)
            rects = await kp.evaluate(RECTS_JS)
            # 仅比较「非包含关系」的叶子栏目块
            leaves = [r for r in rects if r["cls"].find("gp-region") >= 0]
            # 排除互为祖先关系的（用 DOM 包含判定更稳，这里用矩形包含近似 + 类名去重）
            bad = []
            for i in range(len(leaves)):
                for j in range(i + 1, len(leaves)):
                    a, b = leaves[i], leaves[j]
                    # 忽略明显的父子（一方包住另一方全部）
                    contain_ab = (a["x"] <= b["x"] + 1 and a["y"] <= b["y"] + 1 and
                                  a["x"] + a["w"] >= b["x"] + b["w"] - 1 and a["y"] + a["h"] >= b["y"] + b["h"] - 1)
                    contain_ba = (b["x"] <= a["x"] + 1 and b["y"] <= a["y"] + 1 and
                                  b["x"] + b["w"] >= a["x"] + a["w"] - 1 and b["y"] + b["h"] >= a["y"] + a["h"] - 1)
                    if contain_ab or contain_ba:
                        continue
                    if overlaps(a, b, tol=1.0):
                        bad.append((a["cls"], b["cls"], a, b))
            check("UI-7b 竖屏全收起后各栏目矩形两两无重叠", len(bad) == 0,
                  bad[:3] if bad else "")

            # 块7（玩家信息）专项
            p7 = await kp.evaluate("""() => {
              const e = document.querySelector('.gp-region-kp-players');
              if (!e) return null;
              const r = e.getBoundingClientRect();
              const body = e.querySelector('.gp-region-body');
              const bs = body ? getComputedStyle(body).display : '';
              return { folded: e.classList.contains('folded'), h: Math.round(r.height),
                       bodyDisplay: bs };
            }""")
            check("UI-7c 块7「玩家信息」已收起(folded) 且高度收敛", p7 and p7["folded"] and p7["h"] <= 40, p7)
            check("UI-8 收起态 body display:none", p7 and p7["bodyDisplay"] == "none", p7)

            # 展开块7，确认可恢复（点它的折叠标题）
            await kp.evaluate("""() => {
              const e = document.querySelector('.gp-region-kp-players .gp-region-fold');
              if (e) e.click();
            }""")
            await kp.wait_for_timeout(300)
            p7b = await kp.evaluate("""() => {
              const e = document.querySelector('.gp-region-kp-players');
              return e ? { folded: e.classList.contains('folded'), h: Math.round(e.getBoundingClientRect().height) } : null;
            }""")
            check("UI-7d 块7 可再次展开（folded=false）", p7b and p7b["folded"] is False, p7b)

            # ---- UI-9 横屏 .gp-grid 零回归 ----
            await kp.set_viewport_size({"width": 844, "height": 390})
            await kp.wait_for_timeout(600)
            land = await kp.evaluate("""() => {
              const gp = document.querySelector('.game-page');
              const on = gp.classList.contains('gp-grid');
              const fp = document.querySelector('.gp-fold-portrait');
              const fpDisp = fp ? getComputedStyle(fp).display : '(none)';
              const main = gp.querySelector('.gp-main');
              const overflowX = main ? (main.scrollWidth - main.clientWidth) : 0;
              return { grid: on, fpDisp: fpDisp, overflowX: overflowX };
            }""")
            check("UI-9a 横屏(844x390) 进入 .gp-grid", land and land["grid"], land)
            check("UI-9b 横屏下 .gp-fold-portrait 被隐藏（display:none）",
                  land and land["fpDisp"] == "none", land)
            check("UI-9c 横屏主区无横向溢出", land and land["overflowX"] <= 2, land)

            await browser.close()
    finally:
        try:
            if srv_room: srv_room.kill()
        except Exception: pass
        try:
            if srv_static: srv_static.shutdown()
        except Exception: pass

    npass = sum(1 for _, ok, _ in R if ok)
    nfail = len(R) - npass
    print("\n--------------------------------------------------")
    print("UI probe: PASS=%d FAIL=%d" % (npass, nfail))
    if nfail:
        for name, ok, d in R:
            if not ok:
                print("  FAIL: " + name + ("  <- " + str(d) if d else ""))
        print("RESULT: FAIL")
        sys.exit(1)
    print("RESULT: PASS")


if __name__ == "__main__":
    asyncio.run(main())
