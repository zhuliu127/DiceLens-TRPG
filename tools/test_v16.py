# -*- coding: utf-8 -*-
"""
test_v16.py —— 第 0 步「设置属性 / 技能上限」按钮 → 直接跳到 AI 设置里的数值上限

需求（用户）：
    在车卡第 0 步增加一个按钮「设置属性/技能上限」（位置你看着放），
    点击后自动打开「菜单 → AI 设置」里面的对应位置。

「对应位置」是关键：AI 设置那个弹层里还有接口地址 / 模型名称 / API Key 三张卡片，
只把弹层打开、让玩家自己往下翻，等于没做定位。所以覆盖点分三层：

  A. 按钮本身 —— 在第 0 步的操作区里、文案对、点得动
  B. 定位效果 —— 弹层打开后滚动到「数值上限」卡片、并且给一下视觉高亮
  C. 闭环 —— 在弹层里改完保存、关掉弹层，第 0 步的提示行要立刻跟着变；
     已经有候选卡时要提示「这批是按旧上限生成的」，点「换一批」后提示消失

另有一条容易漏的：弹层必须走 UI.sheet 的 close 路径关掉（不能直接摘 DOM），
否则 scrollLockCount 归不了零 → html/body 永久带 .scroll-locked → 整页划不动。
"""
import os
import asyncio, os
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:%d/index.html" % int(os.environ.get("COC_STATIC_PORT") or 8899)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots16")
os.makedirs(OUT, exist_ok=True)

errors = []
results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("  [OK] " if ok else "  [!!] ") + name + (("  <- " + str(detail)) if detail else ""))


# 弹层与目标卡片的几何关系：判断「有没有滚到那张卡片上」
GEO_JS = """() => {
  const sheets = document.querySelectorAll('.sheet');
  const sh = sheets[sheets.length - 1];
  const card = sh ? sh.querySelector('#aiCapsCard') : null;
  if (!sh || !card) return { ok: false, why: sh ? 'no-card' : 'no-sheet' };
  const rt = sh.getBoundingClientRect().top;
  const ct = card.getBoundingClientRect().top;
  return {
    ok: true,
    offset: Math.round(ct - rt),      // 卡片顶相对滚动容器顶
    scrollTop: Math.round(sh.scrollTop),
    scrollable: sh.scrollHeight > sh.clientHeight,
    title: (sh.querySelector('.sheet-head h3') || {}).textContent || '',
    jumped: card.classList.contains('cap-jump'),
    bodyText: sh.innerText
  };
}"""


async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        page = await browser.new_page(viewport={"width": 412, "height": 900})
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        async def shot(name):
            await page.screenshot(path=os.path.join(OUT, name + ".png"))

        async def to_step0():
            await page.evaluate("()=>App.go('#/')")
            await page.wait_for_timeout(450)
            await page.evaluate("()=>App.newCharacter()")
            await page.wait_for_timeout(1100)

        async def click_by(regex):
            return await page.evaluate("""(src)=>{
                const rx = new RegExp(src);
                const b = [...document.querySelectorAll('button')].find(x=>rx.test(x.textContent));
                if (b) { b.click(); return true; }
                return false;
            }""", regex)

        async def step0_text():
            return await page.evaluate("()=>document.body.innerText")

        await page.goto(BASE)
        await page.wait_for_timeout(1200)
        await page.evaluate("()=>{try{localStorage.clear()}catch(e){}}")
        await page.reload()
        await page.wait_for_timeout(1200)

        # =========================================================
        # A. 按钮存在、位置在操作区、文案正确
        # =========================================================
        print("\n== A、第 0 步的按钮本身 ==")
        await to_step0()
        info = await page.evaluate("""() => {
          const btns = [...document.querySelectorAll('button')];
          const find = re => btns.find(b => re.test(b.textContent));
          const capBtn = find(/设置属性/);
          const randBtn = find(/生成随机角色/);
          const aiBtn   = find(/AI 车卡/);
          const selfBtn = find(/我要自己车卡/);
          if (!capBtn) return { found: false };
          /* 三者必须在同一张卡片里（操作区），不能飘到别处去 */
          const cardOf = el => el.closest('.card') || null;
          const c = cardOf(capBtn);
          return {
            found: true,
            text: capBtn.textContent.trim(),
            sameCardAsRandom: !!c && c === cardOf(randBtn),
            sameCardAsAI: !!c && c === cardOf(aiBtn),
            sameCardAsSelf: !!c && c === cardOf(selfBtn),
            blocked: capBtn.classList.contains('btn'),
            /* 位置：必须在「我要自己车卡」之后（操作区最下面、紧挨着提示行） */
            afterSelf: !!(selfBtn && (selfBtn.compareDocumentPosition(capBtn) & 4)),
            cardTitle: c ? (c.querySelector('.card-title') || {}).textContent : ''
          };
        }""")
        check("★ 第 0 步有「设置属性 / 技能上限」按钮", info.get("found"), info)
        if info.get("found"):
            check("★ 文案含「属性」与「上限」两件事",
                  "属性" in info["text"] and "上限" in info["text"], info["text"])
            # 图标必须能渲染：🎚（U+1F39A）在部分系统字体里会退化成细竖条 / 豆腐块，
            # 曾在这台机器上实际出现过 —— 换图标时别改回这一类冷门字形。
            check("★ 图标用的是可渲染的 🎛（不是会退化成豆腐块的 🎚）",
                  info["text"].startswith("\U0001F39B") and "\U0001F39A" not in info["text"],
                  repr(info["text"][:3]))
            check("★ 按钮在操作区（与随机角色 / AI 车卡 / 自己车卡同一张卡）",
                  info["sameCardAsRandom"] and info["sameCardAsAI"] and info["sameCardAsSelf"],
                  info)
            check("★ 按钮排在「我要自己车卡」之后（操作区最后一行）",
                  info["afterSelf"] is True, info)

        # 未设上限时提示行仍要存在，并说明「按规则全额」
        t0 = await step0_text()
        check("★ 未设上限时提示行写「暂未设置数值上限」",
              "暂未设置数值上限" in t0, t0[:0])
        check("★ 未设上限时提示行说明按规则全额生成",
              "全额生成" in t0)
        check("★ 未设上限时不出现「本次数值上限」",
              "本次数值上限" not in t0)
        # 截图前把操作区滚进视野，方便肉眼核对按钮位置与样式
        await page.evaluate("""()=>{
          const b=[...document.querySelectorAll('button')].find(x=>/设置属性/.test(x.textContent));
          if(b) b.scrollIntoView({block:'center'});
        }""")
        await page.wait_for_timeout(400)
        await shot("v16_01_step0_button")

        # =========================================================
        # B. 点击后定位到「数值上限」卡片
        # =========================================================
        print("\n== B、点击后的定位效果 ==")
        clicked = await click_by("设置属性")
        check("★ 按钮点得动", clicked)
        await page.wait_for_timeout(600)

        geo = await page.evaluate(GEO_JS)
        check("★ 打开了弹层，标题是「AI 设置」", geo.get("ok") and geo.get("title") == "AI 设置", geo)
        check("★ 弹层内确实有 #aiCapsCard 这张卡片", geo.get("ok"), geo.get("why"))
        check("★ 滚动到了「数值上限」卡片（卡片顶贴近容器顶）",
              0 <= geo.get("offset", 999) < 120, geo.get("offset"))
        check("★ 真的滚动了（scrollTop > 0）",
              geo.get("scrollTop", 0) > 0, geo.get("scrollTop"))
        check("★ 目标卡片被高亮（cap-jump）", geo.get("jumped") is True, geo.get("jumped"))
        check("★ 定位到的是「数值上限（房规 · 可选）」那张卡",
              "数值上限" in geo.get("bodyText", ""), "")
        await shot("v16_02_jump_to_caps")

        # 卡片确实在可视区域内（不是滚过头 / 停在下面）
        vis = await page.evaluate("""() => {
          const sh = [...document.querySelectorAll('.sheet')].pop();
          const card = sh.querySelector('#aiCapsCard');
          const r = card.getBoundingClientRect();
          const sr = sh.getBoundingClientRect();
          return { withinTop: r.top >= sr.top - 4, withinBottom: r.top < sr.bottom,
                   visible: r.height > 100 && r.top < sr.bottom && r.bottom > sr.top };
        }""")
        check("★ 卡片顶没被滚出可视区", vis["withinTop"], vis)
        check("★ 卡片可见", vis["visible"] and vis["withinBottom"], vis)

        # =========================================================
        # C. 闭环：改完保存 → 关弹层 → 第 0 步提示行刷新
        # =========================================================
        print("\n== C、改完关掉弹层的闭环 ==")

        # 先在弹层里改一组上限
        setv = await page.evaluate("""() => {
          const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = String(v); return !!el; };
          return [set('aiCapAttr', 400), set('aiCapOcc', 60), set('aiCapInt', 50)];
        }""")
        check("★ 三个上限输入框都在弹层里（id 定位锚点没被改掉）",
              setv == [True, True, True], setv)

        # 点「保存上限」
        saved = await click_by("保存上限")
        check("★ 点了「保存上限」", saved)
        await page.wait_for_timeout(400)
        stored = await page.evaluate("""()=>{
          const s = Store.getState().settings || {};
          return [s.aiAttrCap, s.aiOccPtsCap, s.aiIntPtsCap];
        }""")
        check("★ 上限写进了设置", stored == [400, 60, 50], stored)

        # 关弹层（走真实用户路径：点弹层右上角 ✕）
        closed = await page.evaluate("""()=>{
          const sh = [...document.querySelectorAll('.sheet')].pop();
          if (!sh) return false;
          const btn = sh.querySelector('.sheet-head .icon-btn');
          if (!btn) return false;
          btn.click(); return true;
        }""")
        check("★ 能用弹层自己的 ✕ 关掉", closed)
        await page.wait_for_timeout(500)

        leaked = await page.evaluate("""()=>({
          locked: document.documentElement.classList.contains('scroll-locked')
                  || document.body.classList.contains('scroll-locked'),
          sheet: UI.hasSheet(),
          masks: document.querySelectorAll('.sheet-mask').length
        })""")
        check("★ 关掉后没有残留弹层（DOM 与栈都干净）",
              (not leaked["sheet"]) and leaked["masks"] == 0, leaked)
        check("★ 关掉后滚动锁归零（不会整页划不动）",
              leaked["locked"] is False, leaked)

        t1 = await step0_text()
        check("★ 提示行自动刷新成刚设的上限",
              "本次数值上限" in t1 and "400" in t1 and "60" in t1 and "50" in t1, t1[:0])
        check("★ 提示行仍写明两种生成方式都生效",
              "都生效" in t1 or "生成方式" in t1)
        check("★ 改完弹了一个「数值上限已更新」的提示",
              "数值上限已更新" in t1)
        await shot("v16_03_after_apply")

        # =========================================================
        # D. 已有候选卡时改上限 → 提示这批过期 + 换一批后消失
        # =========================================================
        print("\n== D、生成之后再改上限：候选卡要提示过期 ==")
        await click_by("生成随机角色")
        await page.wait_for_timeout(1800)
        batch1 = await page.evaluate("()=>document.querySelectorAll('.preset-card').length")
        check("★ 生成了候选卡", batch1 == 5, batch1)

        await click_by("设置属性")
        await page.wait_for_timeout(500)
        await page.evaluate("""() => {
          const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = String(v); };
          set('aiCapAttr', 360); set('aiCapOcc', 40); set('aiCapInt', 30);
        }""")
        await click_by("保存上限")
        await page.wait_for_timeout(300)
        await page.evaluate("""()=>{
          const sh = [...document.querySelectorAll('.sheet')].pop();
          sh.querySelector('.sheet-head .icon-btn').click();
        }""")
        await page.wait_for_timeout(500)

        t2 = await step0_text()
        check("★ 已有候选卡时，提示「这批是按改动前的上限生成的」",
              "按改动前的上限" in t2, t2[-500:])
        check("★ 提示里指路「换一批」",
              "换一批" in t2)
        check("★ 提示行同步成新上限 360 / 40 / 30",
              "360" in t2 and "40" in t2 and "30" in t2)
        await shot("v16_04_stale_notice")

        await click_by("换一批")
        await page.wait_for_timeout(1800)
        t3 = await step0_text()
        check("★ 换一批后过期提示消失", "按改动前的上限" not in t3, t3[-400:])
        newcaps = await page.evaluate("""() => {
          const out = [];
          document.querySelectorAll('.preset-card').forEach(c => {
            const m = c.innerText.match(/每项本职技能 ≤ (\\d+)/);
            if (m) out.push(parseInt(m[1], 10));
          });
          return out;
        }""")
        check("★ 新一批卡片带的是新上限（每项本职技能 ≤ 40）",
              len(newcaps) > 0 and all(v == 40 for v in newcaps), newcaps)
        await shot("v16_05_regenerated")

        # =========================================================
        # E. 没改就关：不该误报「过期」
        # =========================================================
        print("\n== E、没改就关掉：不能误报 ==")
        await click_by("设置属性")
        await page.wait_for_timeout(500)
        await click_by("保存上限")          # 值没变，只是再存一次
        await page.wait_for_timeout(300)
        await page.evaluate("""()=>{
          const sh = [...document.querySelectorAll('.sheet')].pop();
          sh.querySelector('.sheet-head .icon-btn').click();
        }""")
        await page.wait_for_timeout(500)
        t4 = await step0_text()
        check("★ 值没变时不报「这批过期」", "按改动前的上限" not in t4, t4[-400:])
        check("★ 值没变时也不弹「数值上限已更新」", "数值上限已更新" not in t4)

        # =========================================================
        # F. 从菜单进「AI 设置」不受影响（不该自动滚动 / 高亮）
        # =========================================================
        print("\n== F、菜单直进的 AI 设置不该被定位逻辑影响 ==")
        await page.evaluate("()=>App.aiSettings()")
        await page.wait_for_timeout(500)
        menu_geo = await page.evaluate(GEO_JS)
        check("★ 菜单直进时停在顶部（scrollTop 为 0）",
              menu_geo.get("scrollTop", -1) == 0, menu_geo.get("scrollTop"))
        check("★ 菜单直进时没有高亮 class",
              menu_geo.get("jumped") is False, menu_geo.get("jumped"))
        await page.evaluate("()=>UI.closeAllSheets()")
        await page.wait_for_timeout(300)

        def noise(e):
            return ("favicon" in e) or ("401" in e and "Unauthorized" in e) \
                or ("test.invalid" in e) or ("Failed to load resource" in e)

        real = [e for e in errors if not noise(e)]
        print("\n控制台错误：%d 条" % len(real))
        for e in real[:10]:
            print("   " + e)
        await browser.close()

    ok = sum(1 for _, o, _ in results if o)
    print("\n===== 结果 %d / %d =====" % (ok, len(results)))
    if ok != len(results):
        print("失败项：")
        for nme, o, d in results:
            if not o:
                print("   [!!] " + nme + ("  <- " + str(d) if d else ""))
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
