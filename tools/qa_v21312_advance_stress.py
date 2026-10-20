# -*- coding: utf-8 -*-
"""qa_v21312_advance_stress.py —— 复现并验收「玩家连续点击『推进 1 轮』卡住」(v2.13.12)

复现 / 验收策略：
  ① 起服务 / 建房 / 入房 / 开团；
  ② 在【房主权威端】给玩家注入临时疯狂症状（rounds=10），使推进可观测；
     （玩家侧的 推进1轮 改的是权威端 sheet.madness，必须读权威端才看得到结算结果）
  ③ 用真实 DOM click 极速连点「⏩ 推进 1 轮」30 次（每次间隔 ~5ms）；
  ④ 验收要点：
       - 页面未假死（evaluate 有响应）、推进按钮仍存在、无控制台报错；
       - 【防连点生效】权威端 rounds 未归零（即 30 次连点远未全部结算，被合并/节流）；
       - 【仍可正常推进】结算后单次点击仍能令 rounds 再 -1（未被永久禁用）。

运行：
  PY="/c/Users/60965/.workbuddy/binaries/python/envs/default/Scripts/python.exe"
  PYTHONPATH=tools "$PY" tools/qa_v21312_advance_stress.py
"""
import asyncio, os, sys, tempfile, shutil

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_room_ui as T  # noqa: E402
from playwright.async_api import async_playwright  # noqa: E402

OUT = os.path.join(T.OUT, "v21312")
os.makedirs(OUT, exist_ok=True)

CLICK_ADVANCE_JS = """() => {
  const bs = [...document.querySelectorAll('button')];
  const b = bs.find(x => (x.textContent || '').indexOf('⏩ 推进 1 轮') >= 0);
  if (!b) return false;
  b.click();
  return true;
}"""

HOST_READ_ROUNDS_JS = """(seat) => {
  const ss = RoomUI._session();
  if (!ss || !ss.host) return 'no-host';
  const m = ss.host.roster.get(seat);
  if (!m || !m.sheet) return 'no-member';
  const md = Array.isArray(m.sheet.madness) ? m.sheet.madness : [];
  if (!md.length) return 'faded';
  return md[0].rounds;
}"""

HOST_INJECT_JS = """(seat) => {
  const ss = RoomUI._session();
  if (!ss || !ss.host) return 'no-host';
  const m = ss.host.roster.get(seat);
  if (!m) return 'no-member';
  m.sheet = m.sheet || {};
  m.sheet.madness = [{ type:'phobia', name:'测试症状', permanent:false, rounds:10, from:'qa' }];
  return 'injected:10';
}"""


def check(name, ok, detail=""):
    T.results.append((name, bool(ok), detail))
    print(("  [OK] " if ok else "  [!!] ") + name + (("  <- " + str(detail)) if detail else ""), flush=True)


async def main():
    dbdir = tempfile.mkdtemp(prefix="coc-qa-v21312-")
    srv_static, th = T.ensure_static()
    srv_room = T.start_room_server(dbdir)
    browser = None
    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch()
            ctx_kp = await browser.new_context(viewport={"width": 1180, "height": 820})
            ctx_p = await browser.new_context(viewport={"width": 1180, "height": 820})
            kp = await ctx_kp.new_page()
            pl = await ctx_p.new_page()
            for pg, tag in ((kp, "KP"), (pl, "玩家")):
                pg.on("pageerror", lambda e, t=tag: T.errors.append("[%s] %s" % (t, e)))
                pg.on("console", lambda m, t=tag: T.errors.append("[%s] %s" % (t, m.text))
                      if m.type == "error" else None)

            print("\n== 房间骨架 ==", flush=True)
            code = await T.make_room(kp, "v2.13.12 连点验收", "KP老张", T.ROOM_BASE)
            check("建房成功", bool(code), code)
            await T.join_room(pl, code, "玩家甲", T.ROOM_BASE)
            await T.start_game(kp, pl)
            seat = await pl.evaluate("() => (RoomUI._session() || {}).client && RoomUI._session().client.seat")
            check("玩家已入座", bool(seat), seat)

            # ---- 在【房主权威端】注入临时疯狂（rounds=10）----
            inj = await kp.evaluate(HOST_INJECT_JS, seat)
            print("   host inject:", inj, flush=True)
            check("★ 权威端注入成功（rounds=10）", inj == "injected:10", inj)
            # 让玩家端拉到这次状态（KP 发条线索触发重绘 + 同步）
            await kp.evaluate("(a) => { const ss = RoomUI._session(); ss.side.act(a); }",
                              {"op": "scene.clue", "seat": seat, "title": "线索", "text": "触发重绘"})
            await pl.wait_for_timeout(500)
            before = await kp.evaluate(HOST_READ_ROUNDS_JS, seat)
            print("   before rounds (host):", before, flush=True)
            check("★ 注入生效（权威端 rounds=10）", str(before) == "10", before)

            # ============ 极速连点 30 次（复现「卡住」） ============
            print("\n== 极速连点「推进 1 轮」×30（复现并验收防连点） ==", flush=True)
            clicked = 0
            for i in range(30):
                ok = await pl.evaluate(CLICK_ADVANCE_JS)
                if ok:
                    clicked += 1
                await pl.wait_for_timeout(5)
            print("   clicked:", clicked, flush=True)
            check("★ 30 次点击都命中按钮", clicked == 30, clicked)

            # 等结算
            await pl.wait_for_timeout(1500)

            # ============ 假死 / 冻结检查 ============
            print("\n== 假死 / 冻结检查 ==", flush=True)
            try:
                alive = await asyncio.wait_for(pl.evaluate("() => 1 + 1"), timeout=3.0)
            except Exception as e:
                alive = "TIMEOUT:%s" % e
            check("★ 页面未假死（evaluate 有响应）", alive == 2, alive)

            btn_exists = await pl.evaluate("""() => {
              const bs = [...document.querySelectorAll('button')];
              return bs.some(x => (x.textContent || '').indexOf('⏩ 推进 1 轮') >= 0);
            }""")
            check("★ 推进按钮仍存在", btn_exists is True, btn_exists)

            after = await kp.evaluate(HOST_READ_ROUNDS_JS, seat)
            print("   after rounds (host):", after, flush=True)
            # 无防护时 30 连点会一次性把 rounds 从 10 打到 0（'faded'）；
            # 有防护时连点被合并/节流，权威端 rounds 应仍 > 0。
            check("★ 防连点生效：30 连点未全部结算（rounds 未归零）",
                  str(after) not in ("faded", "0") and str(after) != "0", after)
            check("★ 防连点生效：确实推进了一些（rounds 下降）",
                  str(after).isdigit() and int(after) < 10, after)

            # ============ 后续单次点击仍可用（未被永久禁用） ============
            print("\n== 后续单次点击仍可用 ==", flush=True)
            before_one = int(after) if str(after).isdigit() else 10
            ok2 = await pl.evaluate(CLICK_ADVANCE_JS)
            await pl.wait_for_timeout(900)
            after2 = await kp.evaluate(HOST_READ_ROUNDS_JS, seat)
            print("   after single click rounds (host):", after2, flush=True)
            check("★ 后续单次点击仍生效（未被永久禁用）",
                  ok2 is True and str(after2).isdigit() and int(after2) == before_one - 1,
                  "%s -> %s" % (before_one, after2))

            # ============ 控制台错误 ============
            print("\n== 控制台 ==", flush=True)
            check("★ 连点过程无页面错误 / 控制台报错", len(T.errors) == 0, T.errors[:3])

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
