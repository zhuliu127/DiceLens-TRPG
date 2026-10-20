# -*- coding: utf-8 -*-
"""模拟 AndroidBridge，验证 UI.saveFile 在安卓环境下正确路由到原生接口"""
import os
import asyncio, os
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:%d/index.html" % int(os.environ.get("COC_STATIC_PORT") or 8899)
errors = []


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        c = await browser.new_context(viewport={"width": 412, "height": 900}, device_scale_factor=2)
        page = await c.new_page()
        page.on("console", lambda m: errors.append(f"[{m.type}] {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))

        # 在页面任何脚本执行前注入假的 AndroidBridge —— 模拟 APK 环境
        await page.add_init_script("""
            window.__calls = [];
            window.AndroidBridge = {
              isAndroid: function(){ window.__calls.push(['isAndroid']); return true; },
              saveImage: function(dataUrl, name){
                window.__calls.push(['saveImage', name, (dataUrl||'').slice(0,22), (dataUrl||'').length]);
                return 'saved:Pictures/COC7th/' + name;
              },
              saveText: function(content, name){
                window.__calls.push(['saveText', name, (content||'').length]);
                return 'saved:Download/' + name;
              },
              toast: function(m){ window.__calls.push(['toast', m]); }
            };
        """)

        await page.goto(BASE, wait_until="networkidle")
        await page.wait_for_timeout(600)

        print("1) isAndroid 探测")
        print("   ", await page.evaluate("()=>UI.isAndroid()"))

        print("2) 走完最小流程生成一张角色卡")
        await page.evaluate("""()=>{
            const Store=window.Store;
            Store.startDraft('coc7');
            const ch=Store.getState().current;
            ch.characterName='桥接测试'; ch.playerName='测试员';
            ch.age=30; ch.basicInfo.age=30;
            ch.attributes={str:50,con:50,siz:60,dex:60,app:50,int:60,pow:60,edu:60,luck:50};
            Engine.recalc(ch);
            Store.scheduleSave();
            return ch.id;
        }""")
        await page.wait_for_timeout(500)
        cid = await page.evaluate("()=>Store.getState().current.id")

        print("3) saveFile(text) 应走 saveText")
        r = await page.evaluate("""()=>{
            const ok = UI.saveFile('coc7-characters.json', '{"a":1}', 'text');
            return {ok:ok, calls: window.__calls.slice()};
        }""")
        print("   ", r)
        assert r["ok"] is True, "saveFile 返回应为 true"
        texts = [x for x in r["calls"] if x[0] == "saveText"]
        assert texts, "未调用 AndroidBridge.saveText"
        assert texts[-1][1] == "coc7-characters.json", "文件名传递错误"
        print("   -> saveText 调用正确")

        print("4) saveFile(image) 应走 saveImage")
        r2 = await page.evaluate("""()=>{
            window.__calls.length = 0;
            const ok = UI.saveFile('角色卡.png', 'data:image/png;base64,iVBORw0KGgo=', 'image');
            return {ok:ok, calls: window.__calls.slice()};
        }""")
        print("   ", r2)
        assert r2["ok"] is True
        imgs = [x for x in r2["calls"] if x[0] == "saveImage"]
        assert imgs, "未调用 AndroidBridge.saveImage"
        assert imgs[-1][2].startswith("data:image/png"), "dataURL 未透传"
        print("   -> saveImage 调用正确")

        print("5) 角色卡页真实导出（走 SheetView.exportImage）")
        await page.goto(BASE + "#/card/coc7/" + cid, wait_until="networkidle")
        await page.wait_for_timeout(1200)
        r3 = await page.evaluate("""()=>{
            window.__calls.length = 0;
            const c = Store.getState().current;
            SheetView.exportImage(c);
            return window.__calls.slice();
        }""")
        print("   ", [tuple(str(v)[:60] for v in x) for x in r3])
        imgs = [x for x in r3 if x[0] == "saveImage"]
        assert imgs, "角色卡导出未调用原生保存"
        assert imgs[-1][3] > 5000, "PNG dataURL 长度异常：%s" % imgs[-1][3]
        print("   -> 角色卡 PNG 已透过原生接口保存，base64 长度", imgs[-1][3])

        print("\n=== 控制台错误 ===")
        print("   无" if not errors else "\n".join("   " + e for e in errors[:20]))
        await browser.close()
        print("\n[PASS] Android 桥接导出通路验证通过")


asyncio.run(main())
