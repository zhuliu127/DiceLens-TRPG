# -*- coding: utf-8 -*-
"""验证 App 端云分享：完成步骤生成链接 + 角色卡页一键分享。"""
import os
import asyncio, os
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:%d/index.html" % int(os.environ.get("COC_STATIC_PORT") or 8899)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots2")
os.makedirs(OUT, exist_ok=True)

# 这个测试要连一个**真实**的分享服务。地址不写死在代码里 ——
# 自己跑的时候用环境变量传进来，仓库里保持脱敏。
SHARE_BASE = os.environ.get("COC_SHARE_BASE", "")
if not SHARE_BASE:
    print("跳过分享链路测试：未设置 COC_SHARE_BASE")
    print("  用法：COC_SHARE_BASE=https://your-domain.example/coc python tools/test_share.py")
    raise SystemExit(0)

errors = []
results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("  [OK] " if ok else "  [!!] ") + name + (("  <- " + str(detail)) if detail else ""))


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        c = await browser.new_context(viewport={"width": 412, "height": 900}, device_scale_factor=2)
        page = await c.new_page()
        page.on("console", lambda m: errors.append("[%s] %s" % (m.type, m.text)) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append("[pageerror] %s" % e))

        await page.goto(BASE, wait_until="networkidle")
        await page.evaluate("()=>localStorage.clear()")
        # 预览环境跑的是「开源版」默认配置 —— 不预置任何服务地址。
        # 本测试要验证真实分享链路，所以在这里把地址写进设置，扮演「自用版」。
        # （走 localStorage 而不是改 BuildConfig，这样后续刷新页面也不会丢）
        await page.evaluate("""()=>{
          localStorage.setItem('coc7.settings.v1', JSON.stringify({
            skillCap: 99, theme: 'light', autoSave: true, lastRuleSystem: null,
            shareBase: '%s'
          }));
        }""" % SHARE_BASE)
        await page.goto(BASE, wait_until="networkidle")
        await page.wait_for_timeout(700)

        # 新模块是否加载
        mod = await page.evaluate("()=>({core: typeof window.CocShare, ui: typeof window.ShareUI, edition: window.BuildConfig.edition, base: window.CocShare.base()})")
        check("CocShare 与 ShareUI 已加载", mod["core"] == "object" and mod["ui"] == "object", mod)
        check("测试环境已注入分享服务地址", mod["base"] == SHARE_BASE, mod)

        # 直接造一个角色并调用分享（跳过向导，专注验证分享链路）
        await page.evaluate("""()=>{
          const c = Store.startDraft('coc7');
          c.characterName='分享链路测试';
          c.playerName='茶叶蛋';
          c.basicInfo.occupationName='私家侦探'; c.basicInfo.age=30; c.basicInfo.era='现代';
          c.attributes={str:60,con:55,siz:65,dex:70,app:50,int:75,pow:60,edu:80,luck:55};
          c.assets.creditRating=19;
          c.skills=[{key:'spot_hidden',id:'spot_hidden',name:'侦查',base:25,occ:45,int:0,growth:0,total:70}];
          c.items=[{name:'手电筒',quantity:1,description:'备用电池'}];
          c.mythos.spells=[{name:'时空门创造术',category:'时空门',cost:'8 点魔法值',time:'1 轮',effect:'开启一扇门'}];
          Engine.recalc(c); Store.scheduleSave();
          window.__cid = c.id;
        }""")
        cid = await page.evaluate("()=>window.__cid")
        check("已创建测试角色", bool(cid), cid)

        # 走 CocShare.create
        res = await page.evaluate("""async ()=>{
          const c = Store.getState().current;
          try {
            const j = await window.CocShare.create(c);
            return {ok:true, id:j.id, url:j.url, hasToken: !!j.delToken};
          } catch (e) { return {ok:false, err: String(e && e.message || e)}; }
        }""", cid)
        check("App 成功上传并取得分享链接", res.get("ok") and res.get("url", "").startswith("http"), res)
        if not res.get("ok"):
            print("     错误：", res.get("err"))
            print("\n控制台错误：", errors[:10])
            await browser.close()
            return

        # 本机记录
        rec = await page.evaluate("()=>window.CocShare.getFor(window.__cid)")
        check("分享记录已写入本机", bool(rec) and rec.get("id") == res["id"], rec)

        # 打开分享页确认可访问（新开标签）
        p2 = await c.new_page()
        await p2.goto(res["url"], wait_until="networkidle", timeout=30000)
        txt = await p2.inner_text("body")
        check("分享页可公开访问且内容正确",
              "分享链路测试" in txt and "侦查" in txt and "时空门创造术" in txt,
              txt[:60].replace("\n", " "))
        await p2.screenshot(path=os.path.join(OUT, "_share_public.png"), full_page=True)

        # 角色卡预览页（#/card/coc7/<id>）的「☁ 分享」入口
        await page.evaluate("()=>{ Store.finalize(); }")
        await page.wait_for_timeout(300)
        await page.goto(BASE + "#/card/coc7/" + cid, wait_until="networkidle")
        await page.wait_for_timeout(800)
        html = await page.inner_text("body")
        check("角色卡页出现「☁ 分享」入口", "☁ 分享" in html, html[:40].replace("\n", " "))
        await page.screenshot(path=os.path.join(OUT, "_share_btn.png"), full_page=True)

        # 点一下分享按钮，验证弹层给出链接
        btn = await page.query_selector("button:has-text('☁ 分享')")
        if btn:
            await btn.click()
            await page.wait_for_timeout(1500)
            sheet_txt = await page.evaluate("""()=>{
              const m=document.querySelector('.sheet-mask');
              return m ? m.innerText : '';
            }""")
            check("点击分享弹出链接层", "分享链接" in sheet_txt or "coc/s/" in sheet_txt, sheet_txt[:70].replace("\n", " "))
            await page.screenshot(path=os.path.join(OUT, "_share_sheet.png"), full_page=True)
        else:
            check("点击分享弹出链接层", False, "未找到分享按钮")

        print("\n=== 控制台错误 ===")
        print("   无" if not errors else "\n".join("   " + e for e in errors[:10]))
        bad = [r for r in results if not r[1]]
        print("\n=== 汇总: 通过 %d / %d ===" % (len(results) - len(bad), len(results)))
        for n, _, d in bad:
            print("   失败：" + n + "  " + str(d))
        await browser.close()


asyncio.run(main())
