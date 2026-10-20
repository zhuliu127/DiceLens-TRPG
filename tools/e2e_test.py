# -*- coding: utf-8 -*-
"""端到端测试：走完 COC7th 车卡全流程并截图"""
import asyncio, os
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8899/index.html"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots")
os.makedirs(OUT, exist_ok=True)
errors = []


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        c = await browser.new_context(viewport={"width": 412, "height": 900}, device_scale_factor=2)
        page = await c.new_page()
        page.on("console", lambda m: errors.append(f"[{m.type}] {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))

        async def shot(n):
            await page.screenshot(path=os.path.join(OUT, n + ".png"), full_page=True)
            print("  shot:", n)

        async def next_step():
            await page.click(".bottombar button:has-text('下一步')")
            await page.wait_for_timeout(700)

        print("1) 首页")
        await page.goto(BASE, wait_until="networkidle"); await page.wait_for_timeout(700)
        await shot("01_home")
        print("  数据:", await page.evaluate("""()=>({occ:COC_OCCUPATIONS.length,weap:COC_WEAPONS.length,
            armor:COC_ARMORS.length,veh:COC_VEHICLES.length,ph:COC_MADNESS.phobias.length,
            ma:COC_MADNESS.manias.length,skills:COC_SKILLS.length})"""))

        print("2) 基本资料")
        await page.click("button.rule-card.on"); await page.wait_for_timeout(600)
        await page.fill("#app .card input[type=text] >> nth=0", "亚历克斯·布莱克")
        await page.fill("#app .card input[type=text] >> nth=1", "茶叶蛋调查员")
        await page.fill("input[type=number]", "26"); await page.wait_for_timeout(400)
        await shot("02_basic")

        print("3) 属性")
        await next_step()
        await page.click(".card .btn.primary")               # 🎲 随机生成
        await page.wait_for_timeout(700); await shot("03_attr_roll")
        await page.click("button:has-text('接受')"); await page.wait_for_timeout(600)
        await shot("04_attr_ok")
        print("  ", await page.evaluate("()=>Store.getState().current.derivedStats"))

        print("4) 职业")
        await next_step()
        await page.fill(".search-box input", "私家侦探"); await page.wait_for_timeout(600)
        await shot("05_occ_search")
        await page.click(".occ-item >> nth=0"); await page.wait_for_timeout(900)
        await shot("06_occ_selected")
        print("  ", await page.evaluate("""()=>{const c=Store.getState().current,O=CocOccupation;
            return {name:(O.getById(c.occupationId)||{}).name, pts:O.occupationPoints(c),
            reqs:O.getRequirements(c).map(r=>r.type+':'+r.label)};}"""))

        # 完成职业限定技能选择（自动）
        await page.evaluate("""()=>{
            const c=Store.getState().current,O=CocOccupation;
            O.getRequirements(c).forEach(r=>{
                if(r.type==='choice'||r.type==='alt'){
                    const pool=r.type==='choice'?r.pool:r.options;
                    const need=r.type==='choice'?r.count:1;
                    c.occupationPicks[r.id]=pool.slice(0,need).map(p=>({skill:p.skill,sub:p.sub||''}));
                    c.occupationPicks[r.id].forEach(p=>{if(p.sub)SkillModel.addSubSkill(c,p.skill,p.sub);});
                } else if(r.type==='free'){
                    c.occupationPicks[r.id]=[{skill:'listen',sub:'',name:'聆听'}];
                }
            });
            Store.scheduleSave();
        }""")
        await page.evaluate("()=>{const h=location.hash;location.hash='';location.hash=h;}")
        await page.wait_for_timeout(900)
        await shot("07_occ_done")

        print("5) 技能")
        await next_step()
        await page.wait_for_timeout(500)
        print("  ", await page.evaluate("""()=>{const c=Store.getState().current,SM=SkillModel,O=CocOccupation;
            const occSet=O.occupationalSet(c), pts=O.occupationPoints(c);
            const targets=c.skills.filter(s=>occSet[s.key]||occSet[s.id]).slice(0,8);
            const each=Math.floor(pts.total/Math.max(1,targets.length));
            targets.forEach(s=>{let add=Math.min(each,99-s.total);if(add>0)SM.applyPoint(c,s,'occ',add);});
            const it=O.interestPoints(c);
            ['spot_hidden','listen','library'].forEach(id=>{
              const s=c.skills.filter(x=>x.id===id)[0];
              if(s){const add=Math.min(20,it.total-c.skills.reduce((a,x)=>a+(x.int||0),0),99-s.total);
                    if(add>0)SM.applyPoint(c,s,'int',add);}
            });
            Store.scheduleSave();
            return {occ:O.occupationPoints(c),interest:O.interestPoints(c),skills:c.skills.length};}"""))
        await page.evaluate("()=>{const h=location.hash;location.hash='';location.hash=h;}")
        await page.wait_for_timeout(900)
        await shot("08_skill")

        print("6) 战斗")
        await next_step()
        await page.click("button:has-text('从武器库选择')"); await page.wait_for_timeout(700)
        await shot("09_weapon_picker")
        await page.click(".sheet .occ-item >> nth=0"); await page.wait_for_timeout(700)
        await page.keyboard.press("Escape"); await page.wait_for_timeout(300)
        await page.click("button:has-text('从防具表选择')"); await page.wait_for_timeout(700)
        await page.click(".sheet .occ-item >> nth=0"); await page.wait_for_timeout(700)
        await page.keyboard.press("Escape"); await page.wait_for_timeout(300)
        await shot("10_combat")

        print("7) 装备")
        await next_step()
        await page.click("button:has-text('＋ 手电筒')"); await page.wait_for_timeout(300)
        await page.click("button:has-text('＋ 急救包')"); await page.wait_for_timeout(300)
        await page.click("button:has-text('＋ 笔记本')"); await page.wait_for_timeout(400)
        await shot("11_gear")

        print("8) 资产")
        await next_step()
        await shot("12_assets")
        b = await page.query_selector("button:has-text('采用建议值')")
        if b:
            await b.click(); await page.wait_for_timeout(500)
        await shot("13_assets_filled")

        print("9) 背景")
        await next_step()
        await page.click("button:has-text('落魄记者')"); await page.wait_for_timeout(700)
        await shot("14_background")

        print("10) 完成 / 检查")
        await next_step()
        await page.wait_for_timeout(600)
        checks = await page.evaluate("()=>Engine.checkList(Store.getState().current)")
        for x in checks:
            print("    ", "OK " if x["ok"] else "!! ", x["label"], x.get("detail") or "")
        await shot("15_finish")

        print("11) 完成角色卡")
        await page.click("button:has-text('完成角色卡')"); await page.wait_for_timeout(1000)
        await shot("16_saved")
        cid = await page.evaluate("()=>Store.getState().current.id")
        print("   角色ID:", cid)

        print("12) 角色卡页")
        await page.goto(BASE + "#/card/coc7/" + cid, wait_until="networkidle")
        await page.wait_for_timeout(1200); await shot("17_sheet")

        print("13) 我的角色")
        await page.goto(BASE + "#/my", wait_until="networkidle")
        await page.wait_for_timeout(700); await shot("18_mine")

        print("14) 亮色主题 + 桌面宽度")
        await page.evaluate("()=>{Store.setSettings({theme:'light'});document.documentElement.setAttribute('data-theme','light');}")
        await page.set_viewport_size({"width": 1100, "height": 900})
        await page.goto(BASE + "#/card/coc7/" + cid, wait_until="networkidle")
        await page.wait_for_timeout(900); await shot("19_sheet_light_desktop")

        print("15) 续编（编辑已有角色）")
        await page.evaluate("()=>{document.documentElement.setAttribute('data-theme','dark');}")
        await page.set_viewport_size({"width": 412, "height": 900})
        await page.goto(BASE + "#/create", wait_until="networkidle")
        await page.wait_for_timeout(900); await shot("20_edit_resume")

        print("\n=== 控制台错误 ===")
        print("   无" if not errors else "\n".join("   " + e for e in errors[:20]))
        await browser.close()


asyncio.run(main())
