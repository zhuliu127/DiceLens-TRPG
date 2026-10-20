# -*- coding: utf-8 -*-
"""qa_v2138_ui_probe.py —— v2.13.8 四项需求的端到端验收（QA 严过关）

复用 test_room_ui 的「起服务 / 建房 / 入房 / 开团」骨架，断言：
  ① 玩家右列紧凑化：队友栏顶端紧贴场景检定底端（gap≈6px，旧版是一大片空白），
     场景检定不拉伸、笔记栏不出列、右列不出横向滚动条；
  ② 「只给你看的信息」标题栏 + ⛶ 全屏：进全屏 → 覆盖层带「← 返回」与全部线索，
     全屏期间新线索照常刷新（不清空），退出后卡片归位内容不丢；
  ③ SAN Check 连点不卡：组件层同名弹层单例 + 骰子行连点 3 次只有 1 个模态，
     提交后权威端结算结果正常回到游戏记录（证明链路不卡）；
  ④ 版本号：关于页显示 v2.13.8，标题为「骰境 TRPG」。

运行：
  PY="/c/Users/60965/.workbuddy/binaries/python/envs/default/Scripts/python.exe"
  PYTHONPATH=tools "$PY" tools/qa_v2138_ui_probe.py
"""
import asyncio, os, sys, tempfile, shutil

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_room_ui as T  # noqa: E402
from playwright.async_api import async_playwright  # noqa: E402

OUT = os.path.join(T.OUT, "v2138")
os.makedirs(OUT, exist_ok=True)

CLICK_TEXT_JS = """(txt) => {
  const bs = [...document.querySelectorAll('button')];
  const b = bs.find(x => (x.textContent || '').indexOf(txt) >= 0);
  if (!b) return false;
  b.click();
  return true;
}"""


def check(name, ok, detail=""):
    T.results.append((name, bool(ok), detail))
    print(("  [OK] " if ok else "  [!!] ") + name + (("  <- " + str(detail)) if detail else ""), flush=True)


async def main():
    dbdir = tempfile.mkdtemp(prefix="coc-qa-v2138-")
    srv_static, th = T.ensure_static()
    srv_room = T.start_room_server(dbdir)
    browser = None
    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch()
            # 视口对齐用户设备（横屏大屏：截图里手绘板/笔记栏都可见 → 高度 > 470）
            ctx_kp = await browser.new_context(viewport={"width": 1180, "height": 820})
            ctx_p = await browser.new_context(viewport={"width": 1180, "height": 820})
            ctx_a = await browser.new_context(viewport={"width": 412, "height": 900})
            kp = await ctx_kp.new_page()
            pl = await ctx_p.new_page()
            about = await ctx_a.new_page()
            for pg, tag in ((kp, "KP"), (pl, "玩家"), (about, "关于")):
                pg.on("pageerror", lambda e, t=tag: T.errors.append("[%s] %s" % (t, e)))
                pg.on("console", lambda m, t=tag: T.errors.append("[%s] %s" % (t, m.text))
                      if m.type == "error" else None)

            # ================= ④ 版本与标题 =================
            print("\n== ④ 版本号与标题 ==", flush=True)
            await about.goto(T.BASE)
            await about.wait_for_timeout(1200)
            await about.evaluate("() => { try { localStorage.clear(); } catch (e) {} }")
            await about.reload()
            await about.wait_for_timeout(1000)
            title = await about.title()
            check("★ 页面标题为「骰境 TRPG」", "骰境 TRPG" in (title or ""), title)
            ver = await about.evaluate("() => (window.BuildConfig || {}).versionName")
            check("★ BuildConfig.versionName = 2.13.8", ver == "2.13.8", ver)
            # 「ℹ 关于」在 ☰ 菜单里，不在首页按钮列 —— 先开菜单再点
            await about.evaluate(CLICK_TEXT_JS, "☰")
            await about.wait_for_timeout(400)
            await about.evaluate(CLICK_TEXT_JS, "关于")
            await about.wait_for_timeout(600)
            about_text = await about.evaluate("() => document.body.innerText")
            check("★ 关于页显示 v2.13.8", "v2.13.8" in about_text, about_text[:80])
            await about.screenshot(path=os.path.join(OUT, "about.png"), full_page=True)

            # ================= 建房 / 入房 / 开团 =================
            print("\n== 房间骨架 ==", flush=True)
            code = await T.make_room(kp, "v2.13.8 验收", "KP老张", T.ROOM_BASE)
            check("建房成功", bool(code), code)
            await T.join_room(pl, code, "玩家甲", T.ROOM_BASE)
            await T.start_game(kp, pl)
            seat = await pl.evaluate("() => (RoomUI._session() || {}).client && RoomUI._session().client.seat")
            check("玩家已入座", bool(seat), seat)

            # KP 递两条线索 → 玩家「只给你看的信息」有内容（空态时该条隐藏，无法测全屏）
            for txt in ["第一条：奈亚的化身潜伏在港口。", "第二条：灯塔看守昨晚没回来。"]:
                await kp.evaluate("(a) => { const ss = RoomUI._session(); ss.side.act(a); }",
                                  {"op": "scene.clue", "seat": seat, "title": "线索", "text": txt})
                await kp.wait_for_timeout(500)
            got_lines = await T.wait_for(pl, """() => {
              const n = document.querySelectorAll('.gp-pl-right > .gp-priv .priv-line').length;
              return n >= 2 ? n : null;
            }""", timeout=8.0)
            check("★ 玩家私密条收到 2 条线索", bool(got_lines), got_lines)

            # ================= ① 右列紧凑化 =================
            print("\n== ① 右列紧凑化 ==", flush=True)
            geom = await pl.evaluate("""() => {
              const q = s => document.querySelector(s);
              const r = e => { if (!e) return null; const b = e.getBoundingClientRect();
                               return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, h: b.height }; };
              const right = q('.gp-pl-right');
              return {
                right: r(right),
                scene: r(q('.gp-pl-right .gp-region-pl-scene')),
                mates: r(q('.gp-pl-right .gp-region-pl-mates')),
                priv: r(q('.gp-pl-right > .gp-priv')),
                sketch: r(q('.gp-pl-right .gp-pl-sketch')),
                notes: r(q('.gp-pl-right .gp-pl-notes')),
                sceneEmptyTail: (() => {
                  const s = q('.gp-pl-right .gp-region-pl-scene');
                  if (!s) return null;
                  // 场景检定内容底边 vs 面板底边：旧版被拉伸时空尾 > 60px
                  let maxB = 0;
                  s.querySelectorAll('*').forEach(c => { const b = c.getBoundingClientRect();
                    if (b.height > 0 && b.bottom > maxB) maxB = b.bottom; });
                  return Math.round(s.getBoundingClientRect().bottom - maxB);
                })(),
                rightScrollX: right ? (right.scrollWidth > right.clientWidth + 1) : null,
                rightScrollY: right ? (right.scrollHeight > right.clientHeight + 1) : null,
                infoScrollX: (() => { const i = q('.gp-info'); return i ? (i.scrollWidth > i.clientWidth + 1) : null; })()
              };
            }""")
            print("   geom:", geom, flush=True)
            check("★ 队友栏顶端紧贴场景检定底端（间距 ≤ 8px）",
                  geom["mates"] and geom["scene"] and (geom["mates"]["top"] - geom["scene"]["bottom"]) <= 8,
                  geom["mates"]["top"] - geom["scene"]["bottom"])
            check("★ 场景检定不再拉伸（面板高度 ≤ 320px）",
                  geom["scene"] and geom["scene"]["h"] <= 320, geom["scene"]["h"])
            check("★ 场景检定面板底部无大片空白（空尾 ≤ 60px）",
                  geom["sceneEmptyTail"] is not None and geom["sceneEmptyTail"] <= 60, geom["sceneEmptyTail"])
            check("★ 私密条紧贴队友栏（间距 ≤ 8px）",
                  geom["priv"] and geom["mates"] and (geom["priv"]["top"] - geom["mates"]["bottom"]) <= 8,
                  geom["priv"]["top"] - geom["mates"]["bottom"])
            check("★ 手绘板紧贴私密条（间距 ≤ 8px）",
                  geom["sketch"] and geom["priv"] and (geom["sketch"]["top"] - geom["priv"]["bottom"]) <= 8,
                  geom["sketch"]["top"] - geom["priv"]["bottom"])
            check("★ 笔记栏不出右列（底边 ≤ 列底边 + 2）",
                  geom["notes"] and geom["right"] and geom["notes"]["bottom"] <= geom["right"]["bottom"] + 2,
                  (geom["notes"]["bottom"], geom["right"]["bottom"]))
            check("★ 右列无横向滚动", geom["rightScrollX"] is False, geom["rightScrollX"])
            check("★ 信息栏无横向滚动", geom["infoScrollX"] is False, geom["infoScrollX"])
            await pl.screenshot(path=os.path.join(OUT, "pl_right_column.png"), full_page=True)

            # ================= ② 私密信息全屏 =================
            print("\n== ② 私密信息全屏 ==", flush=True)
            head_ok = await pl.evaluate("""() => {
              const priv = document.querySelector('.gp-pl-right > .gp-priv');
              if (!priv) return 'no-priv';
              const head = priv.querySelector('.gp-region-head');
              const btn = priv.querySelector('.gp-region-fs-btn');
              return (head && btn) ? 'ok' : 'no-head-or-btn';
            }""")
            check("★ 私密条有标题栏 + ⛶ 全屏按钮", head_ok == "ok", head_ok)

            entered = await pl.evaluate("""() => {
              const btn = document.querySelector('.gp-pl-right > .gp-priv .gp-region-fs-btn');
              if (!btn) return 'no-btn';
              btn.click();
              return 'clicked';
            }""")
            await pl.wait_for_timeout(400)
            fs_state = await pl.evaluate("""() => {
              const ov = document.querySelector('.gp-fs--priv');
              if (!ov) return { exists: false };
              const back = [...ov.querySelectorAll('button')].find(b => (b.textContent || '').indexOf('返回') >= 0);
              const card = ov.querySelector('.priv-card');
              return {
                exists: true,
                hasBack: !!back,
                lines: ov.querySelectorAll('.priv-line').length,
                cardInOverlay: !!card,
                title: (ov.querySelector('.gp-region-head-t') || {}).textContent || ''
              };
            }""")
            check("★ 点击 ⛶ 进入全屏覆盖层", fs_state.get("exists") is True, fs_state)
            check("★ 全屏内有「← 返回」按钮", fs_state.get("hasBack") is True, fs_state)
            check("★ 全屏内线索齐全（2 条）", fs_state.get("lines") == 2, fs_state)
            check("★ 全屏标题为「只给你看的信息」", "只给你看" in (fs_state.get("title") or ""), fs_state.get("title"))
            await pl.screenshot(path=os.path.join(OUT, "priv_fullscreen.png"), full_page=True)

            # 全屏期间 KP 再递一条 → 覆盖层内容应刷新（不能被清空）
            await kp.evaluate("(a) => { const ss = RoomUI._session(); ss.side.act(a); }",
                              {"op": "scene.clue", "seat": seat, "title": "线索", "text": "第三条：墓室里的低语。"})
            fresh = await T.wait_for(pl, """() => {
              const ov = document.querySelector('.gp-fs--priv');
              if (!ov) return null;
              const n = ov.querySelectorAll('.priv-line').length;
              return n >= 3 ? n : null;
            }""", timeout=8.0)
            check("★ 全屏期间新线索照常刷新（3 条）", bool(fresh), fresh)

            exited = await pl.evaluate("""() => {
              const ov = document.querySelector('.gp-fs--priv');
              if (!ov) return 'no-fs';
              const back = [...ov.querySelectorAll('button')].find(b => (b.textContent || '').indexOf('返回') >= 0);
              if (!back) return 'no-btn';
              back.click();
              return 'clicked';
            }""")
            await pl.wait_for_timeout(500)
            after = await pl.evaluate("""() => {
              const ov = document.querySelector('.gp-fs--priv');
              const priv = document.querySelector('.gp-pl-right > .gp-priv');
              const card = priv ? priv.querySelector('.priv-card') : null;
              return { overlayGone: !ov, cardBack: !!card,
                       lines: card ? card.querySelectorAll('.priv-line').length : 0,
                       headStill: priv ? !!priv.querySelector('.gp-region-fs-btn') : false };
            }""")
            check("★ 退出后覆盖层消失", after.get("overlayGone") is True, after)
            check("★ 退出后私密卡归位且内容不丢（3 条）", after.get("cardBack") is True and after.get("lines") == 3, after)
            check("★ 退出后全屏按钮仍在", after.get("headStill") is True, after)

            # ================= ③ SAN Check 连点不卡 =================
            print("\n== ③ SAN Check 连点不卡 ==", flush=True)
            # ③-a 组件层直证：同名弹层单例
            dup = await pl.evaluate("""() => {
              const UI = window.UI;
              UI.sheet({ title: '重复弹层', key: 'dup-key', body: UI.h('div', null, ['一']) });
              UI.sheet({ title: '重复弹层', key: 'dup-key', body: UI.h('div', null, ['二']) });
              const n = document.querySelectorAll('.sheet-mask').length;
              UI.closeAllSheets();
              return n;
            }""")
            check("★ 同名弹层单例（连开两次只剩 1 个模态）", dup == 1, dup)

            # ③-b 真实入口：连点骰子行「SAN Check」3 次
            for i in range(3):
                await pl.evaluate(CLICK_TEXT_JS, "SAN Check")
                await pl.wait_for_timeout(120)
            masks = await pl.evaluate("""() => {
              const ms = document.querySelectorAll('.sheet-mask');
              const titles = [...ms].map(m => ((m.querySelector('.sheet-head h3') || {}).textContent) || '');
              return { count: ms.length, titles: titles };
            }""")
            check("★ 连点 3 次「SAN Check」只有 1 个模态", masks["count"] == 1, masks)
            check("★ 该模态就是 SAN Check 表单", any("SAN Check" in t for t in masks["titles"]), masks)

            # ③-c 提交一次 → 权威端结算结果回到游戏记录（链路不卡的硬证据）
            submitted = await pl.evaluate("""() => {
              const ms = document.querySelectorAll('.sheet-mask');
              if (!ms.length) return 'no-mask';
              const b = [...ms[ms.length - 1].querySelectorAll('button')]
                .find(x => (x.textContent || '').indexOf('掷 SAN Check') >= 0);
              if (!b) return 'no-btn';
              b.click();
              return 'clicked';
            }""")
            check("★ 提交按钮可点", submitted == "clicked", submitted)
            settled = await T.wait_for(pl, """() => {
              const log = document.querySelector('.gp-glog');
              if (!log) return null;
              return log.innerText.indexOf('SAN Check') >= 0 ? 'settled' : null;
            }""", timeout=10.0)
            check("★ 权威端结算结果回到游戏记录（不卡）", settled == "settled", settled)
            # 提交后模态应已关闭（不残留）
            await pl.wait_for_timeout(300)
            left = await pl.evaluate("() => document.querySelectorAll('.sheet-mask').length")
            check("★ 提交后模态关闭无残留", left == 0, left)
            await pl.screenshot(path=os.path.join(OUT, "pl_after_san.png"), full_page=True)

            # ================= 控制台 / 页面错误 =================
            print("\n== 控制台 ==", flush=True)
            check("★ 无页面错误 / 控制台报错", len(T.errors) == 0, T.errors[:3])

        print("\n" + "=" * 52)
        print("通过 %d / %d" % (sum(1 for _, ok, _ in T.results if ok), len(T.results)))
        bad = [n for n, ok, _ in T.results if not ok]
        if bad:
            print("失败项：")
            for b in bad:
                print("  - " + b)
        print("=" * 52)
        return 0 if not bad else 1
    finally:
        try:
            if browser:
                await browser.close()
        except Exception:
            pass
        for s in (srv_room, srv_static):
            try:
                if s:
                    s.shutdown()
                    s.server_close()
            except Exception:
                pass
        if th:
            try:
                th.join(timeout=2)
            except Exception:
                pass
        shutil.rmtree(dbdir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
