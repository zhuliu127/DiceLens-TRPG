# -*- coding: utf-8 -*-
"""第二批改版的视觉验收截图：
  首页（hero / 规则卡 / 最近的调查员无缝）· 关于页 · 图标 · 角色卡 SAN
"""
import asyncio, os, json
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8899/index.html"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots4")
os.makedirs(OUT, exist_ok=True)


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 412, "height": 900}, device_scale_factor=2)
        page = await ctx.new_page()

        await page.goto(BASE, wait_until="networkidle")
        await page.evaluate("()=>localStorage.clear()")
        # 造两张已完成的角色卡，才能看到「最近的调查员」
        await page.goto(BASE, wait_until="networkidle")
        await page.wait_for_timeout(600)
        await page.evaluate("""()=>{
          ['亚瑟·布莱克','艾琳·卡特'].forEach(function(n,i){
            var c=Store.newCharacter('coc7');
            c.characterName=n; c.playerName='茶叶蛋';
            c.basicInfo.gender = i? '女':'男'; c.basicInfo.age=30; c.basicInfo.era='现代';
            c.age=30;
            c.attributes={str:60,con:55,siz:60,dex:65,app:55,int:70,pow:60,edu:75,luck:55};
            c.occupationId = i? 'occ223':'occ219';
            c.assets.creditRating = i? 40 : 25;
            SkillModel.syncSkills(c); Engine.recalc(c);
            c.status.currentHP=c.derivedStats.maxHP; c.status.currentMP=c.derivedStats.maxMP;
            c.status.currentSAN=c.derivedStats.maxSAN; c.status._inited=true;
            c.status._hpTouched=c.status._mpTouched=c.status._sanTouched=true;
            Store.getState().current=c;
            Store.finalize();
          });
        }""")
        await page.goto(BASE + "#/", wait_until="networkidle")
        await page.wait_for_timeout(900)
        await page.screenshot(path=os.path.join(OUT, "v4_home.png"), full_page=True)

        # 「最近的调查员」标题与卡片是否无缝（量一下视觉间隙）
        seam = await page.evaluate("""()=>{
          const hd=document.querySelector('.char-list .card-head');
          const cd=document.querySelector('.char-list .char-card');
          if(!hd||!cd) return null;
          const a=hd.getBoundingClientRect(), b=cd.getBoundingClientRect();
          return {gap: Math.round(b.top - a.bottom),
                  sameBg: getComputedStyle(hd).backgroundColor + ' / ' + getComputedStyle(cd).backgroundColor};
        }""")
        print("seam:", seam)

        # 图标资源
        icons = await page.evaluate("""async ()=>{
          const out={};
          for (const u of ['img/logo.png','img/logo-192.png']) {
            const r = await fetch(u); out[u] = r.ok ? r.headers.get('content-length') : ('HTTP '+r.status);
          }
          return out;
        }""")
        print("icons:", json.dumps(icons, ensure_ascii=False))

        # 关于页
        await page.click(".appbar .icon-btn")
        await page.wait_for_timeout(400)
        await page.click("button.occ-item:has-text('关于')")
        await page.wait_for_timeout(500)
        await page.locator(".sheet").screenshot(path=os.path.join(OUT, "v4_about.png"))

        # 角色卡页（SAN 分母 = POW）
        await page.click(".sheet-head .icon-btn")
        await page.wait_for_timeout(350)
        await page.click(".char-list .char-card >> nth=0")
        await page.wait_for_timeout(900)
        await page.screenshot(path=os.path.join(OUT, "v4_card.png"), full_page=True)

        cards = await page.evaluate("""()=>{
          const v=document.querySelector('.vital.san');
          return {san: v?v.textContent:'', mythos: !!document.querySelector('.vital.san .n')};
        }""")
        print("card san:", cards)

        await browser.close()


asyncio.run(main())
