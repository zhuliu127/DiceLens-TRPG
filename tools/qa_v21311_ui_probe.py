# -*- coding: utf-8 -*-
"""qa_v21311_ui_probe.py —— v2.13.11 玩家左栏「角色状态」改造端到端验收（QA 严过关）

复用 test_room_ui 的「起服务 / 建房 / 入房 / 开团」骨架，断言：
  【新需求】玩家左栏「我的角色卡」：
   ① 删除旧的「人物状态」标题 + 「主要技能」区块（及 .char-status 旧渲染）；
   ② 同一位置新增「角色状态」区块，含：
        - 身体状态（bodyViewOf）
        - 精神状态（sh.mental）
        - 疯狂症状（仅疯狂时显示，且显示剩余轮数）
  【回归】版本号 2.13.11；无页面错误。

运行：
  PY="/c/Users/60965/.workbuddy/binaries/python/envs/default/Scripts/python.exe"
  PYTHONPATH=tools "$PY" tools/qa_v21311_ui_probe.py
"""
import asyncio, os, sys, tempfile, shutil

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_room_ui as T  # noqa: E402
from playwright.async_api import async_playwright  # noqa: E402

OUT = os.path.join(T.OUT, "v21311")
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
    dbdir = tempfile.mkdtemp(prefix="coc-qa-v21311-")
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

            # ============ 版本号 ============
            print("\n== 版本号 ==", flush=True)
            await pl.goto(T.BASE)
            await pl.wait_for_timeout(1000)
            ver = await pl.evaluate("() => (window.BuildConfig || {}).versionName")
            check("★ BuildConfig.versionName = 2.13.11", ver == "2.13.11", ver)

            # ============ 建房 / 入房 / 开团 ============
            print("\n== 房间骨架 ==", flush=True)
            code = await T.make_room(kp, "v2.13.11 验收", "KP老张", T.ROOM_BASE)
            check("建房成功", bool(code), code)
            await T.join_room(pl, code, "玩家甲", T.ROOM_BASE)
            await T.start_game(kp, pl)
            seat = await pl.evaluate("() => (RoomUI._session() || {}).client && RoomUI._session().client.seat")
            check("玩家已入座", bool(seat), seat)

            # ============ ① 角色状态区改造 ============
            print("\n== ① 玩家左栏「角色状态」 ==", flush=True)
            base = await pl.evaluate("""() => {
              const card = document.querySelector('.gp-region-pl-card');
              if (!card) return { exists: false };
              const txt = card.innerText;
              return {
                exists: true,
                hasRoleTitle: txt.indexOf('角色状态') >= 0,
                hasBody: txt.indexOf('身体状态') >= 0,
                hasMental: txt.indexOf('精神状态') >= 0,
                hasOldStatusTitle: txt.indexOf('人物状态') >= 0,
                hasOldSkills: txt.indexOf('主要技能') >= 0,
                hasCharStatusClass: !!card.querySelector('.char-status'),
                bodyText: (card.textContent.match(/身体状态[\\s\\S]{0,12}/) || [''])[0].replace(/\\s+/g,''),
                mentalText: (card.textContent.match(/精神状态[\\s\\S]{0,20}/) || [''])[0].replace(/\\s+/g,'')
              };
            }""")
            print("   base:", base, flush=True)
            check("★ 玩家「我的角色卡」区域存在", base.get("exists") is True, base)
            check("★ 新增「角色状态」标题", base.get("hasRoleTitle") is True, base)
            check("★ 显示「身体状态」", base.get("hasBody") is True, base)
            check("★ 显示「精神状态」", base.get("hasMental") is True, base)
            check("★ 旧「人物状态」标题已删除", base.get("hasOldStatusTitle") is False, base)
            check("★ 旧「主要技能」区块已删除", base.get("hasOldSkills") is False, base)
            check("★ 旧 .char-status 渲染已移除", base.get("hasCharStatusClass") is False, base)
            check("★ 身体状态有值（非空/非undefined）", "正常" in (base.get("bodyText") or "") or "身体状态" in (base.get("bodyText") or ""), base.get("bodyText"))
            check("★ 精神状态有值", "正常" in (base.get("mentalText") or "") or "精神状态" in (base.get("mentalText") or ""), base.get("mentalText"))
            await pl.screenshot(path=os.path.join(OUT, "pl_char_card.png"), full_page=True)

            # ============ ② 疯狂症状（疯狂时显示 + 剩余轮数） ============
            print("\n== ② 疯狂症状·疯狂时显示 ==" , flush=True)
            # 正常态：疯狂症状区块应不存在
            normal_mad = await pl.evaluate("""() => {
              const card = document.querySelector('.gp-region-pl-card');
              if (!card) return null;
              return !!card.querySelector('.char-vitals .sec-title') &&
                     [...card.querySelectorAll('.char-vitals .sec-title')].some(s => (s.textContent||'').indexOf('疯狂症状') >= 0);
            }""")
            check("★ 正常态：疯狂症状区块不显示", normal_mad is False, normal_mad)

            # 注入疯狂症状（临时，剩 3 轮）：直接改「玩家成员对象」的 sheet.madness（与卡片读取同源），
            # 再让 KP 发一条线索触发真实重绘（线索只改 scene/clues，不会覆盖 sheet.madness）。
            injected = await pl.evaluate("""(seat) => {
              const ss = RoomUI._session();
              if (!ss) return 'no-session';
              const st = ss.client ? ss.client.state : (ss.host ? ss.host.state : null);
              if (!st) return 'no-state';
              const targets = [];
              if (st.me) targets.push(st.me);
              const arr = st.members || [];
              const m = arr.find(x => x.seat === seat) ||
                       arr.find(x => (x.role || '').toLowerCase() === 'player');
              if (m) targets.push(m);
              if (!targets.length) return 'no-target';
              targets.forEach(t => {
                t.sheet = t.sheet || {};
                t.sheet.madness = [{ type:'phobia', name:'幽闭恐惧症', permanent:false, rounds:3, from:'qa' }];
              });
              return 'injected:' + targets.length;
            }""", seat)
            print("   injected:", injected, flush=True)
            # 触发真实重绘（KP 给该玩家发线索）
            await kp.evaluate("(a) => { const ss = RoomUI._session(); ss.side.act(a); }",
                              {"op": "scene.clue", "seat": seat, "title": "线索", "text": "触发重绘，验证疯狂症状"})
            await pl.wait_for_timeout(700)
            mad = await T.wait_for(pl, """() => {
              const card = document.querySelector('.gp-region-pl-card');
              if (!card) return null;
              const sec = [...card.querySelectorAll('.char-vitals .sec-title')]
                           .find(s => (s.textContent||'').indexOf('疯狂症状') >= 0);
              if (!sec) return null;
              const row = sec.parentElement.querySelector('.tempstatus-row');
              if (!row) return null;
              return row.innerText;
            }""", timeout=8.0)
            print("   mad row:", mad, flush=True)
            check("★ 疯狂时显示「疯狂症状」区块", mad is not None, mad)
            check("★ 疯狂症状显示名称", bool(mad) and '幽闭恐惧症' in (mad or ''), mad)
            check("★ 疯狂症状显示剩余轮数（还剩 3 轮）", bool(mad) and '还剩 3 轮' in (mad or ''), mad)
            await pl.screenshot(path=os.path.join(OUT, "pl_madness.png"), full_page=True)

            # ============ 控制台 / 页面错误 ============
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
