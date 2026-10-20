# -*- coding: utf-8 -*-
"""第十一批需求的回归验证（真实浏览器交互）：
  1. AI 车卡新增「可选数值上限」：属性总和上限（含/不含幸运）、职业点上限、兴趣点上限
  2. 上限写进提示词，且生成后**本地兜底校准**——模型没照做也一定不超标
  3. 自定义职业：本职 ≤ 8 项，且有拔尖项（至少 2 项 ≥50、最高一项 ≥70）
     —— ⚠️ v1.13 起判据由「多数达到 50」改成「拔尖」，见 test_v12 的说明
  4. 所有职业：兴趣技能不超过 10 项
"""
import os
import asyncio, json, os
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:%d/index.html" % int(os.environ.get("COC_STATIC_PORT") or 8899)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots11")
os.makedirs(OUT, exist_ok=True)

errors = []
results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("  [OK] " if ok else "  [!!] ") + name + (("  <- " + str(detail)) if detail else ""))


# 模型故意给**超标**的属性（九项合计 705），用来验证本地校准兜底
AI_CARD_OVER = {
    "setting": "中国 · 民国",
    "name": "顾长明",
    "gender": "男",
    "age": 38,
    "residence": "上海",
    "birthplace": "苏州",
    "occupationName": "私家侦探",
    "attributes": {"str": 90, "con": 85, "siz": 80, "dex": 88, "app": 75,
                   "int": 92, "pow": 80, "edu": 90, "luck": 85},
    "background": {
        "description": "旧西装熨得平整。",
        "ideology": "信念：案子可以结不了，但不能结错。",
        "traits": "沉默、多疑",
        "wounds": "无。",
        "phobias": "【恐惧症】幽闭恐惧：狭窄空间里会失控。",
        "history": "丢差事那年冬天特别冷。"
    }
}

# 自定义职业：模型明确要求自定义，并给出 8 个本职技能
AI_CARD_CUSTOM = json.loads(json.dumps(AI_CARD_OVER, ensure_ascii=False))
AI_CARD_CUSTOM.update({
    "name": "沈砚",
    "occupationName": "自定义职业",
    "occupationSkills": ["侦查", "潜行", "图书馆使用", "心理学", "说服", "手枪射击", "历史", "锁匠"]
})

CURRENT = {"card": AI_CARD_OVER}


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 412, "height": 900}, device_scale_factor=2)
        page = await ctx.new_page()
        page.on("console", lambda m: errors.append("[%s] %s" % (m.type, m.text)) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append("[pageerror] %s" % e))

        async def shot(n):
            await page.screenshot(path=os.path.join(OUT, n + ".png"), full_page=True)

        async def txt(sel="body"):
            return await page.evaluate("(s)=>((document.querySelector(s)||{}).textContent||'')", sel)

        async def open_menu():
            await page.click(".appbar button.icon-btn")
            await page.wait_for_timeout(450)

        async def close_sheets():
            await page.evaluate("()=>{while(document.querySelector('.sheet-mask')){UI.closeTopSheet();}}")
            await page.wait_for_timeout(250)

        # ---------- 假接口 ----------
        async def ai_handler(route, request):
            if request.method == "OPTIONS":
                await route.fulfill(status=204, headers={
                    "access-control-allow-origin": "*",
                    "access-control-allow-headers": "*",
                    "access-control-allow-methods": "POST, OPTIONS"})
                return
            content = json.dumps(CURRENT["card"], ensure_ascii=False)
            payload = {"choices": [{"message": {"role": "assistant", "content": content}}]}
            await asyncio.sleep(0.6)
            await route.fulfill(status=200, headers={
                "access-control-allow-origin": "*",
                "content-type": "application/json"}, body=json.dumps(payload, ensure_ascii=False))

        async def models_handler(route, request):
            if request.method == "OPTIONS":
                await route.fulfill(status=204, headers={
                    "access-control-allow-origin": "*",
                    "access-control-allow-headers": "*",
                    "access-control-allow-methods": "GET, OPTIONS"})
                return
            await route.fulfill(status=200, headers={
                "access-control-allow-origin": "*",
                "content-type": "application/json"},
                body=json.dumps({"data": [{"id": "test-model"}]}))

        await page.route("**/chat/completions", ai_handler)
        await page.route("**/models", models_handler)

        # ---------- 干净环境 ----------
        await page.goto(BASE, wait_until="networkidle")
        await page.evaluate("()=>localStorage.clear()")
        await page.goto(BASE, wait_until="networkidle")
        await page.wait_for_timeout(700)

        # =========================================================
        # 1. AI 设置里新增「数值上限」
        # =========================================================
        print("\n== 1、AI 设置 · 数值上限 ==")
        await open_menu()
        await page.click(".sheet .occ-item:has-text('AI 设置')")
        await page.wait_for_timeout(600)

        sheet_txt = await txt(".sheet")
        check("设置里有「数值上限」卡片", "数值上限" in sheet_txt, sheet_txt[:60])
        check("有「属性总和上限」输入项", "属性总和上限" in sheet_txt)
        check("有含/不含幸运的两种口径", "含幸运（9 项）" in sheet_txt and "不含幸运（8 项）" in sheet_txt)
        # ⚠️ 措辞在 v1.12 改过：现在明确是「**每项**技能上限」，
        #    避免被理解成「压缩点数总额」（点数总额其实不受影响）。
        check("有「每项本职技能上限」", "每项本职技能上限" in sheet_txt, sheet_txt[:400])
        check("有「每项兴趣技能上限」", "每项兴趣技能上限" in sheet_txt)
        check("★ 说明「不会因此变少」",
              "不会因此变少" in sheet_txt and "点数总额" in sheet_txt, sheet_txt[-500:])
        await shot("v11_01_ai_settings")

        ids = await page.evaluate("""()=>['aiCapAttr','aiCapOcc','aiCapInt'].map(i=>!!document.getElementById(i))""")
        check("三个上限输入框都能定位到", all(ids), ids)

        dflt = await page.evaluate("""()=>{
          const s=Store.getState().settings;
          return {a:s.aiAttrCap, o:s.aiOccPtsCap, i:s.aiIntPtsCap, luck:s.aiAttrCapWithLuck};
        }""")
        check("默认不限制（三项均为 0）", dflt["a"] == 0 and dflt["o"] == 0 and dflt["i"] == 0, dflt)
        check("默认口径是「含幸运」", dflt["luck"] is True, dflt["luck"])

        # 填上限并保存
        await page.fill("#aiCapAttr", "400")
        await page.fill("#aiCapOcc", "200")
        await page.fill("#aiCapInt", "120")
        # ⚠️ 「不含幸运（8 项）」里也含「含幸运」三个字，用文案选会撞车 —— 按序号选
        await page.click(".sheet button.chip >> nth=1")   # 不含幸运
        await page.wait_for_timeout(200)
        await page.click(".sheet button:has-text('保存上限')")
        await page.wait_for_timeout(500)

        saved = await page.evaluate("""()=>{
          const s=Store.getState().settings;
          return {a:s.aiAttrCap, o:s.aiOccPtsCap, i:s.aiIntPtsCap, luck:s.aiAttrCapWithLuck};
        }""")
        check("★ 属性上限 400 已保存", saved["a"] == 400, saved)
        check("★ 职业点上限 200 已保存", saved["o"] == 200, saved)
        check("★ 兴趣点上限 120 已保存", saved["i"] == 120, saved)
        check("★ 「不含幸运」口径已保存", saved["luck"] is False, saved["luck"])

        cap_text = await page.evaluate("()=>AIGen.capsText()")
        check("上限说明文案可读", "400" in cap_text and "200" in cap_text and "120" in cap_text, cap_text)

        await close_sheets()

        # 换个口径再验一次（含幸运）
        await open_menu()
        await page.click(".sheet .occ-item:has-text('AI 设置')")
        await page.wait_for_timeout(500)
        await page.click(".sheet button.chip >> nth=0")   # 含幸运
        await page.wait_for_timeout(200)
        await page.click(".sheet button:has-text('保存上限')")
        await page.wait_for_timeout(400)
        saved2 = await page.evaluate("()=>Store.getState().settings.aiAttrCapWithLuck")
        check("切回「含幸运」也能保存", saved2 is True, saved2)

        # 上限要写进提示词
        prompt = await page.evaluate("()=>AIGen.buildPrompt('民国侦探')")
        check("★ 提示词里写明了属性上限 400", "400" in prompt)
        check("★ 提示词里写明了职业点上限 200", "200" in prompt)
        check("★ 提示词里写明了兴趣点上限 120", "120" in prompt)

        # 清掉后提示词不应残留上限
        await page.click(".sheet button:has-text('全部清除')")
        await page.wait_for_timeout(400)
        cleared = await page.evaluate("""()=>{
          const s=Store.getState().settings;
          return {a:s.aiAttrCap,o:s.aiOccPtsCap,i:s.aiIntPtsCap,p:/总和上限/.test(AIGen.buildPrompt('x'))};
        }""")
        check("「全部清除」能把三项都清掉",
              cleared["a"] == 0 and cleared["o"] == 0 and cleared["i"] == 0, cleared)
        check("清除后提示词不再要求上限", cleared["p"] is False, cleared)
        await close_sheets()

        # =========================================================
        # 2. 带上限生成：模型超标也要被压回来
        # =========================================================
        print("\n== 2、带上限生成（模型故意超标）==")
        await page.evaluate("""()=>Store.setSettings({
            aiBase:'https://api.test.invalid/v1', aiModel:'test-model', aiKey:'sk-test',
            aiAttrCap:400, aiAttrCapWithLuck:true, aiOccPtsCap:200, aiIntPtsCap:120
        })""")
        await page.wait_for_timeout(300)

        await page.evaluate("()=>App.aiCreate()")
        await page.wait_for_timeout(700)
        panel = await txt(".sheet")
        check("面板上会提示本次生效的上限", "本次数值上限" in panel, panel[:80])
        await shot("v11_02_panel_with_caps")

        await page.fill(".sheet textarea", "民国时期的私家侦探")
        await page.click(".sheet button:has-text('生成调查员')")
        await page.wait_for_timeout(6000)

        note = await txt(".sheet")
        check("★ 结果页写明「已按上限生成」", "已按上限生成" in note, note[-200:])
        check("★ 并说明属性被压缩过", "按比例压缩" in note, note[-260:])
        await shot("v11_03_result_with_caps")

        # 生成结果还没写进 Store —— 要先「就用这张」才进 current
        await page.click(".sheet button:has-text('就用这张')")
        await page.wait_for_timeout(1200)

        # ⚠️ adopt() 做的是「存进最近调查员 + 回首页」，不会把卡留在 current 里。
        #    所以按名字从角色列表里取回来。
        got = await page.evaluate("""()=>{
          const cur=(Store.listCharacters()||[]).find(x=>x.characterName==='顾长明');
          if(!cur) return null;
          const a=cur.attributes||{};
          const sum9=['str','con','siz','dex','app','int','pow','edu','luck']
                     .reduce((t,k)=>t+(parseInt(a[k],10)||0),0);
          return {name:cur.characterName, sum9:sum9, attrs:Object.assign({},a)};
        }""")
        check("★ AI 卡生成成功并被采用", got is not None and got["name"] == "顾长明", got and got["name"])
        if got:
            check("★ 模型给的 705 被压到 ≤ 400", got["sum9"] <= 400, got["sum9"])
            check("★ 压缩后没有出现 <15 的废值",
                  all(v >= 15 for v in got["attrs"].values()), got["attrs"])
            check("★ 压缩后没有 >99 的值",
                  all(v <= 99 for v in got["attrs"].values()), got["attrs"])

        pts = await page.evaluate("""()=>{
          const c=(Store.listCharacters()||[]).find(x=>x.characterName==='顾长明');
          const op=CocOccupation.occupationPoints(c);
          const ip=CocOccupation.interestPoints(c);
          const withInt=(c.skills||[]).filter(x=>(x.int||0)>0).length;
          const set=CocOccupation.occupationalSet(c);
          const occ=(c.skills||[]).filter(x=>x.id!=='credit'&&x.id!=='cthulhu'&&(set[x.key]||set[x.id]));
          /* ⚠️ 上限语义已改为「每项技能封顶」，**不压缩点数总额**。
             所以不能再断言「used <= 上限」—— 那是旧语义的残留检查。
             改为逐项核对有没有技能超过它自己的有效上限。 */
          let occOver=0, intOver=0;
          (c.skills||[]).forEach(x=>{
            if(x.id==='credit'||x.id==='cthulhu'||COC7.isGrowthOnly(x.id)) return;
            const cap=SkillModel.capOf(c,x);
            if(set[x.key]||set[x.id]){ if(x.total>cap) occOver++; }
            else if((x.int||0)>0){ if(x.total>cap) intOver++; }
          });
          return {occUsed:op.used, occTotal:op.total, intUsed:ip.used, intTotal:ip.total,
                  withInt:withInt, occN:occ.length, occOver:occOver, intOver:intOver,
                  occHigh:occ.filter(x=>x.total>=50).length,
                  occTop:occ.reduce((m,x)=>Math.max(m,x.total),0),
                  bad:Engine.checkList(c).filter(x=>!x.ok).map(x=>x.label+' -> '+x.detail)};
        }""")
        print("     职业点 %s/%s · 兴趣点 %s/%s · 兴趣技能 %s 项" %
              (pts["occUsed"], pts["occTotal"], pts["intUsed"], pts["intTotal"], pts["withInt"]))
        check("★ 没有本职技能超过本职上限", pts["occOver"] == 0, pts["occOver"])
        check("★ 没有兴趣技能超过兴趣上限", pts["intOver"] == 0, pts["intOver"])
        check("★ 兴趣技能不超过 10 项", pts["withInt"] <= 10, pts["withInt"])
        check("★ 本职技能有拿得出手的主技能（最高 ≥ 50）", pts["occTop"] >= 50, pts["occTop"])
        check("★ 采用的卡通过完整性校验", len(pts["bad"]) == 0, pts["bad"])

        # =========================================================
        # 3. 自定义职业
        # =========================================================
        print("\n== 3、自定义职业 ==")
        CURRENT["card"] = AI_CARD_CUSTOM
        await page.evaluate("""()=>Store.setSettings({
            aiAttrCap:0, aiOccPtsCap:0, aiIntPtsCap:0
        })""")
        await page.evaluate("()=>App.aiCreate()")
        await page.wait_for_timeout(700)
        await page.fill(".sheet textarea", "一个什么都会一点的江湖人")
        await page.click(".sheet button:has-text('生成调查员')")
        await page.wait_for_timeout(6000)
        await page.click(".sheet button:has-text('就用这张')")
        await page.wait_for_timeout(1200)

        custom = await page.evaluate("""()=>{
          const c=(Store.listCharacters()||[]).find(x=>x.characterName==='沈砚');
          if(!c) return {found:false};
          const set=CocOccupation.occupationalSet(c);
          const occ=(c.skills||[]).filter(x=>x.id!=='credit'&&x.id!=='cthulhu'&&(set[x.key]||set[x.id]));
          return {found:true, occId:c.occupationId, name:c.basicInfo.occupationName,
                  occN:occ.length, occHigh:occ.filter(x=>x.total>=50).length,
                  occLow:occ.filter(x=>x.total<50).length,
                  occTop:occ.reduce((m,x)=>Math.max(m,x.total),0),
                  names:occ.map(x=>x.name),
                  bad:Engine.checkList(c).filter(x=>!x.ok).map(x=>x.label+' -> '+x.detail)};
        }""")
        check("自定义职业卡生成成功", custom.get("found") is True, custom)
        if custom.get("found"):
            check("★ 落到自定义职业 occ1", custom["occId"] == "occ1", custom["occId"])
            print("     本职技能 %s 项：%s" % (custom["occN"], "、".join(custom["names"][:8])))
            print("     ≥50 的 %s 项 · 最高 %s" % (custom["occHigh"], custom["occTop"]))
            check("★ 自定义职业本职技能 ≤ 8 项", custom["occN"] <= 8, custom["occN"])
            check("★ 至少 2 项本职技能 ≥ 50", custom["occHigh"] >= 2,
                  "≥50 的有 %s 项 / 共 %s 项" % (custom["occHigh"], custom["occN"]))
            check("★ 有一项明显拔尖（最高 ≥ 70）", custom["occTop"] >= 70, custom["occTop"])
            check("★ 自定义职业卡通过完整性校验", len(custom["bad"]) == 0, custom["bad"])
            await shot("v11_04_custom_occ")

        await close_sheets()

        # =========================================================
        # 4. 随机卡也遵守「兴趣 ≤ 10 项」
        # =========================================================
        print("\n== 4、随机卡的兴趣技能项数 ==")
        rnd = await page.evaluate("""()=>{
          let worst=0, worstOccLow=99, cards=0, badCards=0;
          for(let i=0;i<40;i++){
            const c=PresetGen.generateOne({ctx:{used:{}}});
            if(!c) continue;
            cards++;
            const n=(c.skills||[]).filter(x=>(x.int||0)>0).length;
            worst=Math.max(worst,n);
            if(Engine.checkList(c).some(x=>!x.ok)) badCards++;
          }
          return {worst:worst, cards:cards, badCards:badCards};
        }""")
        print("     %s 张随机卡：兴趣技能最多 %s 项" % (rnd["cards"], rnd["worst"]))
        check("★ 随机卡兴趣技能也不超过 10 项", rnd["worst"] <= 10, rnd["worst"])
        check("随机卡全部通过完整性校验", rnd["badCards"] == 0, rnd["badCards"])

        # =========================================================
        # 收尾
        # =========================================================
        def noise(e):
            return ("favicon" in e) or ("401" in e and "Unauthorized" in e)

        real = [e for e in errors if not noise(e)]
        print("\n控制台错误：%d 条" % len(real))
        for e in real[:10]:
            print("   " + e)
        await browser.close()

    ok = sum(1 for _, o, _ in results if o)
    print("\n===== 结果 %d / %d =====" % (ok, len(results)))
    if ok != len(results):
        print("失败项：")
        for n, o, d in results:
            if not o:
                print("  - " + n + "  <- " + str(d))
    print("控制台错误 %d 条" % len([e for e in errors if not (("favicon" in e) or ("401" in e and "Unauthorized" in e))]))


asyncio.run(main())
