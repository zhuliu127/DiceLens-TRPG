# -*- coding: utf-8 -*-
"""针对性截图：只截关键区域，便于肉眼确认排版。"""
import asyncio, os
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8899/index.html"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots2")
os.makedirs(OUT, exist_ok=True)


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        c = await b.new_context(viewport={"width": 412, "height": 900}, device_scale_factor=3)
        page = await c.new_page()
        await page.goto(BASE, wait_until="networkidle")
        await page.evaluate("()=>localStorage.clear()")
        await page.goto(BASE, wait_until="networkidle")
        await page.wait_for_timeout(600)

        # 造一个 58 岁的角色，好看清年龄扣减
        await page.click("button.rule-card.on")
        await page.wait_for_timeout(700)
        await page.fill("#app .card input[type=text] >> nth=0", "伊莱亚斯·凡·德·梅尔")
        await page.fill("#app .card input[type=text] >> nth=1", "茶叶蛋")
        await page.fill("input[type=number]", "58")
        await page.click(".bottombar button:has-text('下一步')")
        await page.wait_for_timeout(700)
        for k, v in {"str": 70, "con": 65, "siz": 60, "dex": 55, "app": 60,
                     "int": 75, "pow": 60, "edu": 85, "luck": 45}.items():
            await page.fill("#attr_%s input" % k, str(v))
        await page.wait_for_timeout(600)

        # 属性格区域
        await page.locator("#attr_str").scroll_into_view_if_needed()
        await page.wait_for_timeout(300)
        await page.locator(".attr-grid").first.screenshot(
            path=os.path.join(OUT, "_z_attr_grid.png"))
        await page.locator(".card").first.screenshot(
            path=os.path.join(OUT, "_z_attr_sum.png"))
        note = page.locator(".card").last
        await note.scroll_into_view_if_needed()
        await page.wait_for_timeout(250)
        await note.screenshot(path=os.path.join(OUT, "_z_age_note.png"))

        # 职业列表（带职业点）
        await page.click(".bottombar button:has-text('下一步')")
        await page.wait_for_timeout(700)
        await page.locator(".card.flush").first.screenshot(
            path=os.path.join(OUT, "_z_occ_list.png"))

        # 选法医 → 资产 → 技能
        await page.fill(".search-box input", "法医")
        await page.wait_for_timeout(500)
        await page.evaluate("""()=>{
          const all=[...document.querySelectorAll('.occ-item')];
          const hit=all.filter(b=>(b.querySelector('.nm')||{}).textContent==='法医')[0];
          if(hit) hit.click();
        }""")
        await page.wait_for_timeout(600)
        await page.click(".bottombar button:has-text('下一步')")
        await page.wait_for_timeout(700)
        await page.click("button.chip:has-text('采用建议值')")
        await page.wait_for_timeout(500)
        await page.click(".bottombar button:has-text('下一步')")
        await page.wait_for_timeout(900)

        # 技能行：先给两个字加些点，好看清按钮与减号可用态
        row = page.locator("div.skill-row:has(span.nm:text-is('侦查'))")
        await row.scroll_into_view_if_needed()
        await page.wait_for_timeout(300)
        grp = row.locator("div.calc-group").nth(0)
        await grp.locator("button.sbtn").nth(2).click()   # +5
        await page.wait_for_timeout(250)
        await grp.locator("button.sbtn").nth(3).click()   # +10
        await page.wait_for_timeout(400)
        await row.screenshot(path=os.path.join(OUT, "_z_skill_row.png"))
        # 再截一个未加点的行，看减号禁用态
        row2 = page.locator("div.skill-row:has(span.nm:text-is('医学'))")
        await row2.scroll_into_view_if_needed()
        await page.wait_for_timeout(300)
        await row2.screenshot(path=os.path.join(OUT, "_z_skill_row_zero.png"))
        await page.locator(".point-bar").screenshot(path=os.path.join(OUT, "_z_point_bar.png"))
        await page.locator(".point-note").screenshot(path=os.path.join(OUT, "_z_point_note.png"))

        # 战斗：自定义武器下拉
        await page.click(".bottombar button:has-text('下一步')")
        await page.wait_for_timeout(600)
        if await page.locator("button:has-text('继续下一步')").count():
            await page.click("button:has-text('继续下一步')")
            await page.wait_for_timeout(700)
        await page.click("button.btn:has-text('＋ 自定义武器')")
        await page.wait_for_timeout(700)
        await page.locator(".sheet .grid2").first.screenshot(
            path=os.path.join(OUT, "_z_weapon_select.png"))
        await page.locator(".sheet-head .icon-btn").first.click()
        await page.wait_for_timeout(300)

        # 装备 → 背景：症状表
        await page.click(".bottombar button:has-text('下一步')")
        await page.wait_for_timeout(600)
        await page.click(".bottombar button:has-text('下一步')")
        await page.wait_for_timeout(600)
        await page.click("button.btn:has-text('打开症状表')")
        await page.wait_for_timeout(700)
        rows = page.locator(".sheet tbody tr")
        for i in range(4):
            await rows.nth(i).locator("td.pick").nth(0).click()
            await page.wait_for_timeout(120)
        await rows.nth(1).locator("td.pick").nth(1).click()
        await page.wait_for_timeout(300)
        await page.locator(".sheet").screenshot(path=os.path.join(OUT, "_z_madness.png"))

        # 首页分类标签
        await page.locator(".sheet-head .icon-btn").first.click()
        await page.wait_for_timeout(300)
        await page.click(".bottombar button:has-text('下一步')")
        await page.wait_for_timeout(700)
        await page.click(".bottombar button:has-text('完成')")
        await page.wait_for_timeout(900)
        if await page.locator("button:has-text('继续完成')").count():
            await page.click("button:has-text('继续完成')")
            await page.wait_for_timeout(900)
        await page.locator(".char-card").first.screenshot(
            path=os.path.join(OUT, "_z_char_card.png"))

        await b.close()
        print("截图完成 ->", OUT)


asyncio.run(main())
