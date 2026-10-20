# -*- coding: utf-8 -*-
"""qa_v221_ui_probe.py —— v2.2.1 八项修复的**独立**无头 UI 复现（QA 严过关）

只借用 test_room_ui.py 的「起服务 / 建房 / 入房 / 开团」公共骨架（boot plumbing），
所有 v2.2.1 行为断言由本文件**独立**编写，不复用工程师的 v221 用例。

覆盖：
  ①  聊天/记录全屏查看：进入即强制展开、全屏内折叠控件不可点、点折叠不退出、
     「← 返回」可还原且**退出后折叠态与进入前一致**；竖屏 + 横屏各做一遍；
     证伪：快速连点标题/⛶ 不得出现双重覆盖层。
  ③  玩家「⚔ 战斗对抗」在骰子条中的位置（自定义骰子之后、SAN Check 之前）；
     非战斗模式 → disabled + dim。
  ④  竖屏全栏收起后滚动到底，最后一栏底边不被 fixed 底部工具栏遮挡；
     并核对 .gp-zoom 的 padding-bottom = 工具栏高 + 10px。
  ⑤  KP 工具栏「🧰 KP 工具」未读角标：构造待处理 → 角标数值正确、清空归零。
      （⑤ 的计数函数另有 node 白盒用例；此处验证真实 DOM 渲染。）

运行：
  PY="/c/Users/60965/.workbuddy/binaries/python/envs/default/Scripts/python.exe"
  PYTHONPATH=... "$PY" tools/qa_v221_ui_probe.py
"""
import asyncio, os, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_room_ui as T  # noqa: E402
from playwright.async_api import async_playwright  # noqa: E402

R = []
def check(name, ok, detail=""):
    R.append((name, bool(ok), detail))
    print(("  [OK] " if ok else "  [!!] ") + name + (("  <- " + str(detail)) if detail else ""), flush=True)


# ---------- 浏览器内小工具 ----------
# 读某信息流栏（chat/log）的折叠 / 全屏几何
FEED_STATE_JS = """(kind) => {
  const cls = kind === 'chat' ? '.gp-chat' : '.gp-glog';
  const el = document.querySelector(cls);
  if (!el) return { exists: false };
  const body = [...el.children].find(c => c.classList && c.classList.contains('gp-region-body'))
             || [...el.children].find(c => c.classList && (c.classList.contains('gp-chat-list') || c.classList.contains('gp-glog-list')));
  const inline = el.querySelector('.gp-region-fold--inline');
  return {
    exists: true,
    folded: el.classList.contains('folded'),
    inFullscreen: !!el.closest('.gp-fs--feeds'),
    inlineDisplay: inline ? getComputedStyle(inline).display : '(none-node)',
    inlineVisible: inline ? (inline.getClientRects().length > 0) : false,
    bodyDisplay: body ? getComputedStyle(body).display : '?',
    scrolledH: (el.closest('.gp-fs--feeds') ? el : el).scrollHeight
  };
}"""

ENTER_FS_JS = """(kind) => {
  const cls = kind === 'chat' ? '.gp-chat' : '.gp-glog';
  const el = document.querySelector(cls);
  if (!el) return 'no-feed';
  const head = el.querySelector('.gp-region-head');
  if (!head) return 'no-head';
  head.click();
  return 'clicked';
}"""

FS_OVERLAY_COUNT_JS = "() => document.querySelectorAll('.gp-fs--feeds').length"

FS_HEAD_BTN_JS = """(label) => {
  const ov = document.querySelector('.gp-fs--feeds');
  if (!ov) return 'no-fs';
  const b = [...ov.querySelectorAll('button')].find(x => x.textContent.indexOf(label) >= 0);
  if (!b) return 'no-btn';
  b.click();
  return 'clicked';
}"""

TOGGLE_INLINE_JS = """(kind) => {
  const cls = kind === 'chat' ? '.gp-chat' : '.gp-glog';
  const el = document.querySelector(cls);
  if (!el) return 'no-feed';
  const b = el.querySelector('.gp-region-fold--inline');
  if (!b) return 'no-btn';
  b.click();
  return 'clicked';
}"""

# ④：滚动到底 + 量最后一栏底边与工具栏顶边
CLEARANCE_JS = """() => {
  const gp = document.querySelector('.game-page');
  if (!gp) return null;
  const toolbar = gp.querySelector('.gp-toolbar');
  const zoom = gp.querySelector('.gp-zoom');
  // ⚠️ 滚动容器是 .game-page（position:fixed;inset:0;overflow-y:auto），不是 window。
  gp.scrollTop = gp.scrollHeight;
  const tbRect = toolbar ? toolbar.getBoundingClientRect() : null;
  const gpRect = gp.getBoundingClientRect();
  // 找底边最大的栏目块（排除容器）
  const sel = '.gp-region, .gp-priv, .gp-info';
  const els = [...gp.querySelectorAll(sel)].filter(e => {
    const r = e.getBoundingClientRect();
    return r.height > 0 && !e.classList.contains('gp-main') && !e.classList.contains('gp-region-kp-right');
  });
  let last = null;
  els.forEach(e => { const r = e.getBoundingClientRect();
    if (!last || r.bottom > last.bottom) last = { bottom: r.bottom, cls: e.className }; });
  return {
    scrollable: gp.scrollHeight > gp.clientHeight + 1,
    scrollH: gp.scrollHeight, clientH: gp.clientHeight, scrollTop: gp.scrollTop,
    winH: window.innerHeight, gpBottom: gpRect.bottom,
    lastBottom: last ? last.bottom : null, lastCls: last ? last.cls : null,
    toolbarTop: tbRect ? tbRect.top : null,
    paddingBottom: zoom ? getComputedStyle(zoom).paddingBottom : null,
    toolbarH: tbRect ? Math.round(tbRect.height) : null
  };
}"""

# ③：玩家骰子条扩展按钮顺序 + 战斗对抗可用态
DICEBAR_JS = """() => {
  const extra = document.querySelector('.dice-extra');
  if (!extra) return null;
  const btns = [...extra.querySelectorAll('button')].map(b => ({
    text: b.textContent.trim(),
    disabled: !!b.disabled,
    dim: b.classList.contains('dim')
  }));
  const idx = (t) => btns.findIndex(b => b.text.indexOf(t) >= 0);
  return { order: btns.map(b => b.text), idxCustom: idx('自定义骰子'), idxOpp: idx('战斗对抗'),
           idxSan: idx('SAN Check'),
           oppBtn: btns.find(b => b.text.indexOf('战斗对抗') >= 0) || null };
}"""

MODE_JS = "() => { const s = RoomUI._session(); const st = s && s.host ? s.host.state : (s&&s.client?s.client.state:null); return st && st.meta ? st.meta.mode : null; }"


async def main():
    dbdir = tempfile.mkdtemp(prefix="qa_v221_ui_")
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

            code = await T.make_room(kp, "QA221房间", "KP", T.ROOM_BASE)
            await T.join_room(pl, code, "玩家", T.ROOM_BASE)
            await T.start_game(kp, pl)
            await kp.wait_for_timeout(900)
            await kp.wait_for_selector(".game-page", timeout=15000)
            await pl.wait_for_selector(".game-page", timeout=15000)
            await kp.wait_for_selector(".gp-chat", timeout=8000)
            await kp.wait_for_timeout(300)

            gp_cls = await kp.evaluate("() => document.querySelector('.game-page').className")
            check("前置：KP 竖屏(390x844) 单列 .game-page:not(.gp-grid)", "gp-grid" not in gp_cls, gp_cls)

            # ============ ① 全屏查看：竖屏 ============
            print("-- ① 竖屏全屏查看 --", flush=True)
            pre = await kp.evaluate(FEED_STATE_JS, "chat")
            check("①-0 进入前聊天栏未折叠", pre["exists"] and pre["folded"] is False, pre)
            r = await kp.evaluate(ENTER_FS_JS, "chat")
            await kp.wait_for_timeout(400)
            check("①-1 点标题 → 进入 .gp-fs--feeds 全屏", r == "clicked" and await kp.evaluate(FS_OVERLAY_COUNT_JS) == 1)
            fs = await kp.evaluate(FEED_STATE_JS, "chat")
            check("①-2 全屏内栏目处于展开态（强制展开）", fs["folded"] is False, fs)
            check("①-3 全屏内折叠控件已隐藏（display:none / 不可见）",
                  fs["inlineDisplay"] == "none" or fs["inlineVisible"] is False, fs)
            # 证伪：点内嵌折叠 → 不退出、不收起
            t = await kp.evaluate(TOGGLE_INLINE_JS, "chat")
            await kp.wait_for_timeout(300)
            fs2 = await kp.evaluate(FEED_STATE_JS, "chat")
            check("①-4 全屏内点折叠 → 不退出全屏", await kp.evaluate(FS_OVERLAY_COUNT_JS) == 1, t)
            check("①-5 全屏内点折叠 → 内容不收起（仍展开）", fs2["folded"] is False, fs2)
            check("①-6 「← 返回」常驻可点", (await kp.evaluate(
                "() => { const ov=document.querySelector('.gp-fs--feeds'); if(!ov) return false;"
                " return [...ov.querySelectorAll('button')].some(b=>/返回/.test(b.textContent)); }")) is True)
            await kp.evaluate(FS_HEAD_BTN_JS, "返回")
            await kp.wait_for_timeout(400)
            after = await kp.evaluate(FEED_STATE_JS, "chat")
            check("①-7 点返回 → 退出全屏", await kp.evaluate(FS_OVERLAY_COUNT_JS) == 0)
            check("①-8 退出后折叠态 == 进入前（False）", after["folded"] is False and after["inFullscreen"] is False, after)

            # 证伪：进入前先折叠 → 全屏内仍展开 → 退出后还原为折叠
            await kp.evaluate(TOGGLE_INLINE_JS, "chat")
            await kp.wait_for_timeout(300)
            foldedPre = await kp.evaluate(FEED_STATE_JS, "chat")
            check("①-9 预置：先折叠聊天栏", foldedPre["folded"] is True, foldedPre)
            await kp.evaluate(ENTER_FS_JS, "chat")
            await kp.wait_for_timeout(400)
            fsIn = await kp.evaluate(FEED_STATE_JS, "chat")
            check("①-10 已折叠栏进全屏 → 内部强制展开", fsIn["folded"] is False, fsIn)
            await kp.evaluate(FS_HEAD_BTN_JS, "返回")
            await kp.wait_for_timeout(400)
            after2 = await kp.evaluate(FEED_STATE_JS, "chat")
            check("①-11 退出后**还原**为进入前的折叠态（True）", after2["folded"] is True, after2)
            # 复原
            await kp.evaluate(TOGGLE_INLINE_JS, "chat")
            await kp.wait_for_timeout(200)

            # 证伪：快速连点标题/⛶ → 不得双重覆盖层
            await kp.evaluate("""() => { const h=document.querySelector('.gp-chat .gp-region-head'); h.click(); h.click(); }""")
            await kp.wait_for_timeout(300)
            n1 = await kp.evaluate(FS_OVERLAY_COUNT_JS)
            await kp.evaluate(ENTER_FS_JS, "chat")   # 全屏内再点标题
            await kp.wait_for_timeout(200)
            n2 = await kp.evaluate(FS_OVERLAY_COUNT_JS)
            check("①-12 快速连点标题 → 仍只有 1 个全屏覆盖层", n1 == 1, n1)
            check("①-13 全屏内再点标题 → 不叠加第二层", n2 == 1, n2)
            await kp.evaluate(FS_HEAD_BTN_JS, "返回")
            await kp.wait_for_timeout(300)

            # ============ ① 全屏查看：横屏 ============
            print("-- ① 横屏全屏查看 + .gp-grid 零回归 --", flush=True)
            await kp.set_viewport_size({"width": 844, "height": 390})
            await kp.wait_for_timeout(700)
            land = await kp.evaluate("""() => {
              const gp = document.querySelector('.game-page');
              const fp = document.querySelector('.gp-fold-portrait');
              return { grid: gp.classList.contains('gp-grid'),
                       fpDisp: fp ? getComputedStyle(fp).display : '(none)',
                       mainOverflow: (() => { const m = gp.querySelector('.gp-main'); return m ? (m.scrollWidth - m.clientWidth) : 0; })() };
            }""")
            check("①-14 横屏(844x390) 进入 .gp-grid", land["grid"], land)
            check("①-15 横屏 .gp-fold-portrait 隐藏（.gp-grid 零回归）", land["fpDisp"] == "none", land)
            check("①-16 横屏主区无横向溢出", land["mainOverflow"] <= 2, land)
            await kp.evaluate(ENTER_FS_JS, "chat")
            await kp.wait_for_timeout(400)
            fsL = await kp.evaluate(FEED_STATE_JS, "chat")
            check("①-17 横屏进入全屏成功", await kp.evaluate(FS_OVERLAY_COUNT_JS) == 1, fsL)
            check("①-18 横屏全屏内栏目展开（强制展开）", fsL["folded"] is False, fsL)
            await kp.evaluate(FS_HEAD_BTN_JS, "返回")
            await kp.wait_for_timeout(300)
            check("①-19 横屏点返回 → 退出全屏", await kp.evaluate(FS_OVERLAY_COUNT_JS) == 0)
            await kp.set_viewport_size({"width": 390, "height": 844})
            await kp.wait_for_timeout(400)

            # ============ ④ 竖屏工具栏遮挡 ============
            print("-- ④ 竖屏底部工具栏遮挡 --", flush=True)
            # 先收起所有栏目（点全部折叠标题），再滚到底
            nf = await kp.evaluate("""() => {
              const gp = document.querySelector('.game-page');
              const heads = [...gp.querySelectorAll('.gp-region-fold--inline, .gp-region-fold')];
              let n = 0; heads.forEach(h => { h.click(); n++; });
              return n;
            }""")
            await kp.wait_for_timeout(400)
            cl = await kp.evaluate(CLEARANCE_JS)
            check("④-0 找到折叠标题并逐一点击", nf and nf > 0, nf)
            check("④-1 .gp-zoom 已预留底部空间 padding-bottom", cl and cl["paddingBottom"] not in (None, "0px"), cl)
            # padding-bottom 数值应 = 工具栏高 + 10
            import re as _re
            pb = cl["paddingBottom"] if cl else ""
            m = _re.match(r"([0-9.]+)px", str(pb or ""))
            exp = (cl["toolbarH"] + 10) if cl and cl["toolbarH"] else None
            check("④-2 padding-bottom ≈ 工具栏高+10（新增规则生效）",
                  bool(m) and exp is not None and abs(float(m.group(1)) - exp) <= 1.5,
                  "padding=%s expect=%s" % (pb, exp))
            if cl and cl["lastBottom"] is not None and cl["toolbarTop"] is not None:
                check("④-3 滚动到底后最后一栏底边 ≤ 工具栏顶边（不被遮挡）",
                      cl["lastBottom"] <= cl["toolbarTop"] + 1.5,
                      "lastBottom=%.1f toolbarTop=%.1f cls=%s scrollable=%s scrollH=%s clientH=%s" %
                      (cl["lastBottom"], cl["toolbarTop"], cl["lastCls"], cl["scrollable"], cl["scrollH"], cl["clientH"]))
            else:
                check("④-3 滚动到底后最后一栏底边 ≤ 工具栏顶边（不被遮挡）", False, cl)
            # 复原：展开所有
            await kp.evaluate("""() => {
              const gp = document.querySelector('.game-page');
              [...gp.querySelectorAll('.gp-region-fold--inline, .gp-region-fold')].forEach(h => h.click());
            }""")
            await kp.wait_for_timeout(300)

            # ============ ③ 玩家骰子条按钮顺序 + 战斗门控 ============
            print("-- ③ 玩家「战斗对抗」入口 --", flush=True)
            # 默认探索模式
            mode = await pl.evaluate(MODE_JS)
            db = await pl.evaluate(DICEBAR_JS)
            check("③-0 取到玩家骰子条扩展组", db is not None, db)
            if db:
                iC, iO, iS = db["idxCustom"], db["idxOpp"], db["idxSan"]
                check("③-1「战斗对抗」位于「自定义骰子」之后",
                      iC >= 0 and iO > iC, "custom=%s opp=%s" % (iC, iO))
                check("③-2「战斗对抗」位于「SAN Check」之前",
                      iO >= 0 and iS > iO, "opp=%s san=%s" % (iO, iS))
                check("③-3「战斗对抗」与二者**紧邻**（位置契约：自定义骰子/战斗对抗/SAN Check）",
                      iO == iC + 1 and iS == iO + 1, "custom=%s opp=%s san=%s" % (iC, iO, iS))
                check("③-4 探索模式 → 「战斗对抗」disabled", db["oppBtn"] and db["oppBtn"]["disabled"] is True, db["oppBtn"])
                check("③-5 探索模式 → 「战斗对抗」带 .dim", db["oppBtn"] and db["oppBtn"]["dim"] is True, db["oppBtn"])
            check("③-6 当前为探索模式(EXPLORATION)", mode == "EXPLORATION", mode)

            # 让 KP 切到战斗模式（走真实 UI：战斗模式 → 新增怪物 → 勾选 → 战斗部署完毕）
            await kp.evaluate("""() => {
              const b = [...document.querySelectorAll('button')]
                .find(x => x.textContent.indexOf('战斗模式') >= 0);
              if (b) b.click();
            }""")
            await kp.wait_for_timeout(600)
            await kp.evaluate(T.CLICK_BTN_JS, "新增怪物")
            await kp.wait_for_timeout(500)
            await kp.evaluate(T.CLICK_EXACT_JS, "加入候选池")
            await kp.wait_for_timeout(700)
            await kp.evaluate("""() => {
              const sh = [...document.querySelectorAll('.sheet')].pop();
              if (!sh) return false;
              const row = [...sh.querySelectorAll('.actor-line')]
                .find(x => x.textContent.indexOf('新单位') >= 0);
              if (row) { row.click(); return true; }
              return false;
            }""")
            await kp.wait_for_timeout(400)
            await kp.evaluate("""() => {
              const b = [...document.querySelectorAll('button')]
                .find(x => x.textContent.indexOf('战斗部署完毕') >= 0);
              if (b) b.click();
            }""")
            await kp.wait_for_timeout(1400)
            mode2 = await pl.evaluate(MODE_JS)
            db2 = await pl.evaluate(DICEBAR_JS)
            check("③-7 KP 切战斗 → 玩家端进入 COMBAT", mode2 == "COMBAT", mode2)
            if db2 and db2["oppBtn"]:
                check("③-8 战斗模式 → 「战斗对抗」解禁（非 disabled）", db2["oppBtn"]["disabled"] is False, db2["oppBtn"])
            else:
                check("③-8 战斗模式 → 「战斗对抗」解禁（非 disabled）", False, db2)

            # ============ ⑤ KP 未读角标（真实 DOM）============
            print("-- ⑤ KP 工具栏未读角标 --", flush=True)
            # 清空基线：先确保无角标
            zero = await kp.evaluate("() => { const b=document.querySelector('.gp-quick .gp-badge'); return b?b.textContent:'(none)'; }")
            # 直接操作 KP 权威态：构造 1 条 await_kp 对抗申请 + 1 条 need='kp' 队列项
            inj = await kp.evaluate("""() => {
              const s = RoomUI._session();
              if (!s || !s.host) return 'no-host';
              s.host.state.opposed = Object.assign({}, s.host.state.opposed || {},
                { id:'qa-op-1', by:'s1', byName:'玩家', phase:'await_kp', targetId:'m1', targetName:'怪' });
              s.host.pending = (s.host.pending || []).concat([{ seq: 999, need:'kp', kind:'state.request' }]);
              return 'injected';
            }""")
            check("⑤-0 已向 KP 权威态注入待处理（await_kp + need:kp）", inj == "injected", inj)
            # 触发一次重绘：从玩家端发一条聊天（KP 收到事件 → paint）
            await pl.evaluate(T.CHAT_SEND_JS, "触发重绘")
            got_badge = None
            for _ in range(25):
                await kp.wait_for_timeout(200)
                got_badge = await kp.evaluate("() => { const b=document.querySelector('.gp-quick .gp-badge'); return b?b.textContent:null; }")
                if got_badge:
                    break
            check("⑤-1 待处理 → KP 工具按钮出现角标且计数=2", got_badge == "2", "badge=%s (初始=%s)" % (got_badge, zero))
            has_pending_cls = await kp.evaluate("() => { const b=[...document.querySelectorAll('.gp-quick .btn')].find(x=>/KP 工具/.test(x.textContent)); return b?b.classList.contains('has-pending'):null; }")
            check("⑤-2 KP 工具按钮带 .has-pending 类", has_pending_cls is True, has_pending_cls)
            # 清空 → 角标消失（归零）
            await kp.evaluate("""() => {
              const s = RoomUI._session();
              s.host.state.opposed = null;
              s.host.pending = [];
            }""")
            await pl.evaluate(T.CHAT_SEND_JS, "再触发重绘")
            zeroed = None
            for _ in range(25):
                await kp.wait_for_timeout(200)
                zeroed = await kp.evaluate("() => { const b=document.querySelector('.gp-quick .gp-badge'); return b?b.textContent:null; }")
                if not zeroed:
                    break
            check("⑤-3 清空待处理 → 角标消失（归零）", zeroed is None, zeroed)

            # ============ ⑧ 本机权威房间号（入口页「回到游戏」卡 + 地址号纠偏）============
            print("-- ⑧ 本机权威房间号（UI）--", flush=True)
            ent = await ctx.new_page()
            ent.on("pageerror", lambda e: print("   ENTRY pageerror:", e, flush=True))
            await ent.goto(T.BASE)
            await ent.wait_for_timeout(1000)
            await ent.evaluate("(b) => Store.setSettings({ roomBase: b })", T.ROOM_BASE)
            await ent.evaluate("() => App.go('#/room')")
            await ent.wait_for_timeout(700)
            rejoin = await ent.evaluate("""() => {
              const b = [...document.querySelectorAll('button')]
                .find(x => x.textContent.indexOf('回到游戏') >= 0);
              return b ? b.textContent.trim() : null;
            }""")
            check("⑧-1 入口页出现「回到游戏（本机权威号）」卡", bool(rejoin) and code in rejoin, rejoin)
            # 地址栏给一个**旧/错**号 → tier④ 纠偏卡应把权威号列出来
            await ent.evaluate("() => App.go('#/room/WRONGCODE9')")
            await ent.wait_for_timeout(900)
            fix = await ent.evaluate("""() => {
              const b = [...document.querySelectorAll('button')]
                .find(x => x.textContent.indexOf('回到游戏') >= 0);
              return b ? b.textContent.trim() : null;
            }""")
            body_txt = await ent.evaluate("() => document.body.innerText")
            check("⑧-2 地址里旧号被本机权威号覆盖（纠偏卡指向正确房号）",
                  bool(fix) and code in fix, "rejoinBtn=%s" % fix)
            check("⑧-3 纠偏卡文案点明地址号不是本机在玩的房间",
                  ('wrongcode9' in body_txt.lower()) and ('不是本机' in body_txt or '不一致' in body_txt),
                  "hasWrong=%s" % ('wrongcode9' in body_txt.lower()))
            await ent.close()

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
    print("UI probe v2.2.1: PASS=%d FAIL=%d" % (npass, nfail))
    if nfail:
        for name, ok, d in R:
            if not ok:
                print("  FAIL: " + name + ("  <- " + str(d) if d else ""))
        print("RESULT: FAIL")
        sys.exit(1)
    print("RESULT: PASS")


if __name__ == "__main__":
    asyncio.run(main())
