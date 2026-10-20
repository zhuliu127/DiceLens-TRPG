# -*- coding: utf-8 -*-
"""补充素材：主脚本 shoot_promo_viewport.py 里没有、但单点卖点图必须用到的几张真实界面。

  v_11_overflow  属性设置 ·「手动购点」超支：红色「超出 N」+ 错误提示，
                 同时底栏「下一步」被硬拦住（attrBlockReason）
  v_12_longimg   「🖼 生成图片」真正导出的那张长图（不做任何美化，就是玩家拿到的文件）
  v_14_preset    一张「普通」候选卡（非彩蛋），给「一秒开团」那张卖点图用 ——
                 主脚本的 v_03_preset 是彩蛋卡，两张图放一起会撞脸
  v_15_card      与 v_12_longimg **同一张卡**的角色卡页 ——
                 否则「手机里的卡」和「导出的长图」会是两个人，一眼看穿

挑卡规则（候选卡按分数排序，第 1 名给 v_14_preset、第 2 名给长图那组）：
  · 彩蛋卡     −10   避免与「彩蛋角色」那张卖点图撞脸
  · 近未来     −5    它的货币单位是 ¤（U+00A4），长图上看着像乱码
  · 职业带「（原作向）」 −20  occupations.js 里 11 个职业名带这个后缀
                     （occ9 / occ11 / occ16 …），印在推广图上像编辑遗留

为什么单独一个脚本：主脚本是为了 16:9 / 9:16 综合推广图截的，
这里几张是为单点卖点专门造的现场，放一起会让主脚本变得难读。

用法：先在 web/ 目录起静态服务（8899），再 python tools/shoot_promo_extra.py
"""
import asyncio, base64, os
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8899/index.html"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "promo")
os.makedirs(OUT, exist_ok=True)

# 按上面的规则给 5 张候选打分排序，返回 [{name, score, occ, meta}, ...]（高分在前）
RANK = """()=>{
    const cards = [...document.querySelectorAll('.preset-card')];
    const info = c => {
        const occEl  = c.querySelector('.tag.gold');
        const metaEl = c.querySelector('.pc-meta');
        const nameEl = c.querySelector('.pc-name');
        const occ  = occEl  ? occEl.textContent  : '';
        const meta = metaEl ? metaEl.textContent : '';
        const name = nameEl ? nameEl.textContent : '';
        let s = 0;
        if (c.querySelector('.egg-badge')) s -= 10;
        if (/近未来/.test(meta)) s -= 5;
        if (/原作向/.test(occ)) s -= 20;
        return { name: name, score: s, occ: occ, meta: meta };
    };
    return cards.map(info).sort((a, b) => b.score - a.score);
}"""


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(
            viewport={"width": 412, "height": 892},
            device_scale_factor=3, color_scheme="light")
        page = await ctx.new_page()

        async def mute():
            await page.evaluate("()=>{UI.toast=function(){};}")

        async def shot(name):
            await page.evaluate(
                "()=>{document.querySelectorAll('.toast,.toast-item').forEach(e=>e.remove());}")
            await page.wait_for_timeout(220)
            await page.screenshot(path=os.path.join(OUT, name + ".png"), full_page=False)

        async def click(regex):
            return await page.evaluate(
                """(re)=>{
                    const r=new RegExp(re);
                    const b=[...document.querySelectorAll('button')].find(x=>r.test(x.textContent));
                    if(b){b.click();return true;} return false;
                }""", regex)

        async def scroll_to_card(name):
            """把某张候选卡对齐到视口顶部；往回退 64px 躲开固定的顶部栏"""
            ok = await page.evaluate("""(nm)=>{
                const c = [...document.querySelectorAll('.preset-card')]
                    .find(x => ((x.querySelector('.pc-name')||{}).textContent||'') === nm);
                if (!c) return false;
                const r = c.getBoundingClientRect();
                window.scrollTo({top: window.scrollY + r.top - 64, behavior:'instant'});
                return true;
            }""", name)
            await page.wait_for_timeout(420)
            return ok

        async def pick_card(name):
            """点这张卡的「选这张」"""
            return await page.evaluate("""(nm)=>{
                const c = [...document.querySelectorAll('.preset-card')]
                    .find(x => ((x.querySelector('.pc-name')||{}).textContent||'') === nm);
                if (!c) return false;
                const btn = [...c.querySelectorAll('button')].find(b => /选这张/.test(b.textContent));
                if (!btn) return false;
                btn.click();
                return true;
            }""", name)

        await page.goto(BASE, wait_until="domcontentloaded")
        await page.wait_for_timeout(900)
        await page.evaluate("()=>{localStorage.clear();}")
        await page.reload(wait_until="domcontentloaded")
        await page.wait_for_timeout(1000)
        await mute()

        # ---------- 生成一批候选（要保证既有彩蛋卡、又有普通卡）----------
        await page.evaluate("()=>{App.newCharacter();}")
        await page.wait_for_timeout(900)
        await mute()
        await click('生成随机角色')
        await page.wait_for_timeout(900)
        for _ in range(40):
            if await page.evaluate("()=>!!document.querySelector('.egg-badge')"):
                break
            await click('换一批')
            await page.wait_for_timeout(200)

        ranked = await page.evaluate(RANK)
        print("候选排序：")
        for i, r in enumerate(ranked):
            print("   %d) %-12s %+3d  %s | %s" % (i + 1, r["name"], r["score"], r["occ"], r["meta"]))
        if len(ranked) < 2:
            print("候选不足，退出")
            await browser.close()
            return

        shot_card, pick_card_name = ranked[0]["name"], ranked[1]["name"]
        print("截图用：", shot_card, " / 长图用：", pick_card_name)

        # ---------- 1. 普通候选卡 ----------
        if not await scroll_to_card(shot_card):
            print("滚不到卡：", shot_card)
        await shot("v_14_preset")

        # ---------- 2. 选定另一张卡（长图与角色卡页都用它）----------
        if not await pick_card(pick_card_name):
            print("点不到「选这张」：", pick_card_name)
            await browser.close()
            return
        await page.wait_for_timeout(1300)
        await mute()
        cid = await page.evaluate("()=>{const l=Store.listCharacters();return l.length?l[0].id:null;}")
        if not cid:
            print("没有选到角色卡，退出")
            await browser.close()
            return

        # ---------- 3. 真实导出的长图 ----------
        # exportImage() 最后一步是 UI.saveFile(name, dataURL, type)；
        # 把它临时换掉，就能把玩家真正拿到的那张 PNG 原样截下来，
        # 而不是我们自己画一张「看起来像」的。
        captured = await page.evaluate("""(id)=>{
            const c = Store.getState().characters[id];
            if (!c) return null;
            const old = UI.saveFile;
            let got = null;
            UI.saveFile = function(name, url, type){ got = {name:name, url:url, type:type}; };
            try { SheetView.exportImage(c); } finally { UI.saveFile = old; }
            return got;
        }""", cid)
        if not captured or not captured.get("url", "").startswith("data:image/png;base64,"):
            print("长图没拿到：", captured)
            await browser.close()
            return
        raw = base64.b64decode(captured["url"].split(",", 1)[1])
        with open(os.path.join(OUT, "v_12_longimg.png"), "wb") as f:
            f.write(raw)
        print("长图：%d bytes  角色名=%s" % (len(raw), captured.get("name")))

        # ---------- 4. 同一张卡的角色卡页（给「一键长图 / 只读分享」那张用）----------
        await page.evaluate("(id)=>{Store.loadCharacter(id); App.go('#/card/coc7/'+id);}", cid)
        await page.wait_for_timeout(1300)
        await mute()
        await page.evaluate("()=>{window.scrollTo({top:0,behavior:'instant'});}")
        await page.wait_for_timeout(400)
        await shot("v_15_card")

        # ---------- 5. 购点超支（属性步骤 · 手动购点）----------
        # 走编辑会话改属性：直接改 state.characters 里的卡不会反映到编辑页面上。
        await page.evaluate("(id)=>{App.startEdit(id);}", cid)
        await page.wait_for_timeout(1200)
        await mute()
        # 先把数据改成「手动购点 + 超支」，再点步骤条进属性页，
        # 页面渲染时会调 validateMode()，于是红色「超出 N」与错误提示会直接出来。
        await page.evaluate("""()=>{
            const c = Store.getState().current;
            c.attributeMode = 'pointbuy';
            c.pbCap = 550;
            c.pbIncludeLuck = false;
            Object.assign(c.attributes, {
                str:90, con:85, siz:75, dex:85, app:70, int:80, pow:70, edu:85, luck:60
            });
            Engine.recalc(c);
        }""")
        await page.evaluate("""()=>{
            const t=[...document.querySelectorAll('.stepper-item')].find(x=>/属性/.test(x.textContent));
            if(t) t.click();
        }""")
        await page.wait_for_timeout(1100)
        await mute()
        # 滚到购点校验区（sum-grid + 错误提示），并让底栏的「下一步」一起入镜
        await page.evaluate("""()=>{
            const s=document.getElementById('pbStatus');
            if(!s) return;
            const r=s.getBoundingClientRect();
            window.scrollTo({top:window.scrollY + r.top - 150, behavior:'instant'});
        }""")
        await page.wait_for_timeout(430)
        await shot("v_11_overflow")

        await browser.close()

    for f in ("v_11_overflow.png", "v_12_longimg.png", "v_14_preset.png", "v_15_card.png"):
        fp = os.path.join(OUT, f)
        if os.path.exists(fp):
            print("%-20s %7.1f KB" % (f, os.path.getsize(fp) / 1024))
        else:
            print("%-20s MISSING" % f)


asyncio.run(main())
