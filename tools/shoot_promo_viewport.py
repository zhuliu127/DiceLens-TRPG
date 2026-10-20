# -*- coding: utf-8 -*-
"""截取推广图用的「手机视口」素材（full_page=False）。

为什么不用 full_page：16:9 / 9:16 宣传图里手机只露出「一屏」，
长图塞进手机框会被压得看不清字，所以这里统一截 412x892 的视口。

素材对应 v1.15.0 的界面：
  v_01_home     首页（规则系统选择 + 最近的调查员）
  v_02_step0    第 0 步 · 选择开始方式（四种入口 + 房规上限提示行）
  v_03_preset   随机候选卡（摇到带彩蛋角标的那一批）
  v_04_attr     属性步骤 · 年龄调整
  v_05_card     角色卡页（含疯狂状态）
  v_06_status   状态管理
  v_07_ai       AI 车卡面板
  v_08_caps     「设置属性 / 技能上限」→ AI 设置定位到「数值上限」卡片
  v_09_skill    技能分配（点数总览 + 拔尖技能）

用法：先在 web/ 目录起静态服务（8899），再 python tools/shoot_promo_viewport.py
"""
import asyncio, os
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8899/index.html"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "promo")
os.makedirs(OUT, exist_ok=True)


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(
            viewport={"width": 412, "height": 892},
            device_scale_factor=3, color_scheme="light")
        page = await ctx.new_page()

        async def shot(name):
            # 截图前清掉 toast，免得飘在画面上
            await page.evaluate(
                "()=>{document.querySelectorAll('.toast,.toast-item').forEach(e=>e.remove());}")
            await page.wait_for_timeout(220)
            await page.screenshot(path=os.path.join(OUT, name + ".png"), full_page=False)

        async def mute():
            """静音 toast：截图脚本里满屏弹提示既碍事又慢"""
            await page.evaluate("()=>{UI.toast=function(){};}")

        async def close_sheets():
            await page.evaluate(
                "()=>{while(document.querySelector('.sheet-mask')){UI.closeTopSheet();}}")
            await page.wait_for_timeout(280)

        async def click(regex):
            return await page.evaluate(
                """(re)=>{
                    const r=new RegExp(re);
                    const b=[...document.querySelectorAll('button')].find(x=>r.test(x.textContent));
                    if(b){b.click();return true;} return false;
                }""", regex)

        await page.goto(BASE, wait_until="domcontentloaded")
        await page.wait_for_timeout(900)
        # 干净起点：清掉上一次跑残留的角色卡与草稿
        await page.evaluate("()=>{localStorage.clear();}")
        await page.reload(wait_until="domcontentloaded")
        await page.wait_for_timeout(1000)
        await mute()

        # ---------- 1. 首页 ----------
        await shot("v_01_home")

        # ---------- 2. 第 0 步 · 选择开始方式 ----------
        await page.evaluate("()=>{App.newCharacter();}")
        await page.wait_for_timeout(900)
        await mute()
        await page.evaluate("""()=>{
            const t=[...document.querySelectorAll('.card-title')].find(x=>/选择开始方式/.test(x.textContent));
            const card=t?t.closest('.card'):null;
            if(card) card.scrollIntoView({block:'start'});
        }""")
        await page.wait_for_timeout(430)
        await shot("v_02_step0")

        # ---------- 3. 点「设置属性 / 技能上限」→ 定位到「数值上限」卡片 ----------
        await click('设置属性')
        await page.wait_for_timeout(1100)
        await shot("v_08_caps")
        await close_sheets()

        # ---------- 4. AI 车卡面板 ----------
        # 未配置 Key 时面板是「去配置」的引导页，不能用来说明「一句话生成」。
        # 这里填一份明显是示例的配置，让面板露出真正的输入框形态。
        await page.evaluate("""()=>Store.setSettings({
            aiBase:'https://api.deepseek.com/v1',
            aiModel:'deepseek-flash',
            aiKey: ''
        })""")
        await click('AI 车卡')
        await page.wait_for_timeout(1000)
        await shot("v_07_ai")
        await close_sheets()

        # ---------- 5. 随机候选卡（摇到出彩蛋角标的那一批）----------
        await page.evaluate("""()=>{
            const t=[...document.querySelectorAll('.card-title')].find(x=>/选择开始方式/.test(x.textContent));
            const card=t?t.closest('.card'):null;
            if(card) card.scrollIntoView({block:'start'});
        }""")
        await page.wait_for_timeout(300)
        await click('生成随机角色')
        await page.wait_for_timeout(620)
        for _ in range(60):
            hit = await page.evaluate("()=>!!document.querySelector('.egg-badge')")
            if hit:
                break
            await click('换一批')
            await page.wait_for_timeout(200)
        # 滚到彩蛋那一张（更有辨识度），没有就退回第一张。
        # 顶部固定栏会盖住贴顶的内容，所以对齐后再往回退 64px，
        # 保证卡片标题与彩蛋角标都在画面里。
        await page.evaluate("""()=>{
            const b=document.querySelector('.egg-badge');
            const card=(b?b.closest('.card, .preset-card'):null)||document.querySelector('.preset-card');
            if(!card) return;
            const r=card.getBoundingClientRect();
            window.scrollTo({top:window.scrollY + r.top - 64, behavior:'instant'});
        }""")
        await page.wait_for_timeout(430)
        await shot("v_03_preset")

        # ---------- 6. 选定一张 → 角色卡页（含疯狂状态）----------
        await click('选这张')
        await page.wait_for_timeout(1100)
        await mute()
        cid = await page.evaluate("""()=>{
            const list=Store.listCharacters();
            if(!list.length) return null;
            const id=list[0].id;
            const c=Store.getState().characters[id];
            c.madness=[
              window.CocMadness.make('phobia', window.CocMadness.phobias()[2], false, 6),
              window.CocMadness.make('mania',  window.CocMadness.manias()[1], true)
            ];
            c.sanLoss=10;
            Engine.recalc(c); Store.scheduleSave();
            return id;
        }""")
        await page.wait_for_timeout(700)
        await page.evaluate("(id)=>{Store.loadCharacter(id); App.go('#/card/coc7/'+id);}", cid)
        await page.wait_for_timeout(1300)
        await mute()
        await page.evaluate("""()=>{
            const s=document.querySelector('.madness-strip');
            if(s) s.scrollIntoView({block:'center'});
        }""")
        await page.wait_for_timeout(430)
        await shot("v_05_card")

        # ---------- 6b. 角色卡的技能表（拔尖技能一眼可见）----------
        await page.evaluate("""()=>{
            const t=document.querySelector('.skill-show');
            if(t) t.scrollIntoView({block:'start'});
            window.scrollBy(0,-64);
        }""")
        await page.wait_for_timeout(430)
        await shot("v_10_skills")

        # ---------- 7. 状态管理 ----------
        await click('状态管理')
        await page.wait_for_timeout(1000)
        await shot("v_06_status")
        await close_sheets()

        # ---------- 8. 编辑 → 技能分配（点数总览 + 拔尖）----------
        await page.evaluate("(id)=>{App.startEdit(id);}", cid)
        await page.wait_for_timeout(1200)
        await mute()
        await page.evaluate("""()=>{
            const t=[...document.querySelectorAll('.stepper-item')].find(x=>/技能/.test(x.textContent));
            if(t) t.click();
        }""")
        await page.wait_for_timeout(1200)
        await shot("v_09_skill")

        # ---------- 9. 属性步骤 · 年龄调整 ----------
        await page.evaluate("""()=>{
            const c=Store.getState().current;
            c.basicInfo.age=70; c.age=70;
            Object.assign(c.attributes,{str:85,con:80,siz:70,dex:75,app:80,int:75,pow:70,edu:75,luck:55});
            Engine.recalc(c);
            const t=[...document.querySelectorAll('.stepper-item')].find(x=>/属性/.test(x.textContent));
            if(t) t.click();
        }""")
        await page.wait_for_timeout(1000)
        await mute()
        await page.evaluate("""()=>{
            const n=document.querySelector('.notice');
            if(n) n.scrollIntoView({block:'center'});
        }""")
        await page.wait_for_timeout(430)
        await shot("v_04_attr")

        await browser.close()

    for f in sorted(os.listdir(OUT)):
        if f.startswith("v_"):
            print("%-18s %7.1f KB" % (f, os.path.getsize(os.path.join(OUT, f)) / 1024))


asyncio.run(main())
