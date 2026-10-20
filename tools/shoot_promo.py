# -*- coding: utf-8 -*-
"""为推广图专门截一组「干净」的素材：
不带 toast、不带弹层遮罩、光线均匀，直接可放进宣传图里。
"""
import asyncio, json, os
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8899/index.html"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "promo")
os.makedirs(OUT, exist_ok=True)


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(
            viewport={"width": 412, "height": 892},
            device_scale_factor=3,          # 3x 缩放，缩小后依然清晰
            color_scheme="light",
        )
        page = await ctx.new_page()
        # 屏蔽 toast（它们会在截图时糊住界面）
        page.add_init_script("""
            window.__toastOff = true;
            Object.defineProperty(window, 'UI', {
                configurable: true,
                get() { return window.__UIProxy; }
            });
        """)

        async def shot(name, full=True):
            await page.evaluate("()=>{document.querySelectorAll('.toast,.toast-item').forEach(e=>e.remove());}")
            await page.wait_for_timeout(200)
            await page.screenshot(path=os.path.join(OUT, name + ".png"), full_page=full)

        await page.goto(BASE, wait_until="domcontentloaded")
        await page.wait_for_timeout(900)

        # 关掉 toast 工厂
        await page.evaluate("""()=>{
            if(!UI.toast) return;
            UI.toast = function(){};
        }""")

        # ---------- 1. 首页 ----------
        await page.evaluate("""()=>{
            localStorage.clear();
        }""")
        await page.reload(wait_until="domcontentloaded")
        await page.wait_for_timeout(900)
        await page.evaluate("()=>{UI.toast=function(){};}")
        await shot("01_home")

        # ---------- 2. 第 0 步：三种车卡方式 ----------
        await page.evaluate("()=>{App.newCharacter();}")
        await page.wait_for_timeout(900)
        await shot("02_step0")

        # ---------- 3. 随机角色（含彩蛋，多刷几次挑一张有角的） ----------
        found_egg = False
        for i in range(60):
            await page.evaluate("""()=>{
                const b=[...document.querySelectorAll('button')].find(x=>/生成随机角色|换一批/.test(x.textContent));
                if(b) b.click();
            }""")
            await page.wait_for_timeout(180)
            if await page.evaluate("()=>!!document.querySelector('.egg-badge')"):
                found_egg = True
                break
        if not found_egg:
            await page.evaluate("""()=>{
                const b=[...document.querySelectorAll('button')].find(x=>/换一批/.test(x.textContent));
                if(b) b.click();
            }""")
            await page.wait_for_timeout(400)
        # 关掉弹层再截，让卡片露出来
        await page.evaluate("()=>{while(document.querySelector('.sheet-mask')){UI.closeTopSheet();}}")
        await page.wait_for_timeout(300)
        await shot("03_preset_cards")
        has_egg = await page.evaluate("()=>!!document.querySelector('.egg-badge')")
        print("彩蛋卡截到了：", has_egg)

        # ---------- 4. 属性步骤（年龄调整并排显示） ----------
        await page.evaluate("""()=>{
            const t=[...document.querySelectorAll('.stepper-item')].find(x=>/属性/.test(x.textContent));
            if(t) t.click();
        }""")
        await page.wait_for_timeout(500)
        # 填一组属性并把年龄拉到 70，让「年龄 −X → 最终 Y」出现
        await page.evaluate("""()=>{
            const c=Store.getState().current;
            c.basicInfo.age=70; c.age=70;
            const A={str:85,con:80,siz:70,dex:75,app:80,int:75,pow:70,edu:75,luck:55};
            Object.keys(A).forEach(k=>c.attributes[k]=A[k]);
            Engine.recalc(c);
        }""")
        await page.wait_for_timeout(200)
        await page.evaluate("""()=>{
            const t=[...document.querySelectorAll('.stepper-item')].find(x=>/属性/.test(x.textContent));
            if(t) t.click();
        }""")
        await page.wait_for_timeout(900)
        await shot("04_attr_step")

        # ---------- 5. 角色卡页（含疯狂状态条） ----------
        await page.evaluate("""()=>{
            const c=Store.getState().current;
            c.characterName='茶叶蛋';
            c.basicInfo.occupationName='私家侦探';
            c.madness=[
              window.CocMadness.make('phobia', window.CocMadness.phobias()[2], false, 6),
              window.CocMadness.make('mania',  window.CocMadness.manias()[1],  true)
            ];
            c.sanLoss=10; c.baseMaxSAN=75;
            Engine.recalc(c); Store.scheduleSave();
        }""")
        await page.wait_for_timeout(600)
        cid = await page.evaluate("()=>Store.getState().current.id")
        await page.evaluate("(id)=>{Store.loadCharacter(id); App.go('#/card/coc7/'+id);}", cid)
        await page.wait_for_timeout(1100)
        await shot("05_character_card")

        # ---------- 6. 状态管理弹层 ----------
        await page.evaluate("""()=>{
            const b=[...document.querySelectorAll('button')].find(x=>/状态管理/.test(x.textContent));
            if(b) b.click();
        }""")
        await page.wait_for_timeout(900)
        await shot("06_status_sheet", full=False)

        await page.evaluate("()=>{while(document.querySelector('.sheet-mask')){UI.closeTopSheet();}}")
        await page.wait_for_timeout(400)

        # ---------- 7. AI 设置 ----------
        await page.evaluate("()=>{App.go('#/');}")
        await page.wait_for_timeout(600)
        await page.click(".appbar button.icon-btn")
        await page.wait_for_timeout(600)
        await page.evaluate("""()=>{
            const b=[...document.querySelectorAll('.sheet-mask .occ-item')].find(x=>/AI 设置/.test(x.textContent));
            if(b) b.click();
        }""")
        await page.wait_for_timeout(800)
        await shot("07_ai_settings", full=False)
        await page.evaluate("()=>{while(document.querySelector('.sheet-mask')){UI.closeTopSheet();}}")
        await page.wait_for_timeout(400)

        # ---------- 8. AI 车卡面板（关掉「怎么用」只看输入区） ----------
        await page.evaluate("()=>{App.newCharacter();}")
        await page.wait_for_timeout(800)
        await page.evaluate("""()=>{
            const b=[...document.querySelectorAll('button')].find(x=>/AI 车卡/.test(x.textContent));
            if(b) b.click();
        }""")
        await page.wait_for_timeout(800)
        await shot("08_ai_panel", full=False)

        await browser.close()

    for f in sorted(os.listdir(OUT)):
        p2 = os.path.join(OUT, f)
        print("%-22s %6.1f KB" % (f, os.path.getsize(p2) / 1024))


asyncio.run(main())
