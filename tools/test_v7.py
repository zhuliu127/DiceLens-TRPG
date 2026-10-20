# -*- coding: utf-8 -*-
"""第五批需求的回归验证（真实浏览器交互）：
  1. 年龄扣减改为「力量/体质/敏捷 平均分摊」，单项最低 15
     - 三项扣减量最多相差 1（不出现「只扣力量」）
     - 生效值不低于 15
     - 属性偏低时如实报告「有多少点扣不完」
     - 属性格下方并排显示「年龄 −X → 最终 Y」
  2. 编辑已创建的角色卡必须手动保存
     - 进入编辑后改任何字段，自动保存不得写回角色卡
     - 点「保存修改」才落库
     - 「放弃修改」后角色卡保持原样
     - 离开向导（菜单/返回键）有未保存修改时会拦一下
     - 编辑期间状态胶囊显示「修改未保存」而不是「已保存」
"""
import os
import asyncio, os
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:%d/index.html" % int(os.environ.get("COC_STATIC_PORT") or 8899)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots7")
os.makedirs(OUT, exist_ok=True)

errors = []
results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("  [OK] " if ok else "  [!!] ") + name + (("  <- " + str(detail)) if detail else ""))


# 直接往 localStorage 塞一张已完成的角色卡，避免每次都从头车一遍卡
SEED = {
    "id": "testedit01",
    "ruleSystemId": "coc7",
    "version": "v1.0",
    "characterName": "测试用调查员",
    "basicInfo": {"age": 70, "gender": "男", "residence": "上海", "birthplace": "苏州",
                  "birthday": "1950-03-02"},
    "attributes": {"str": 85, "con": 80, "dex": 75, "siz": 70, "app": 80,
                   "int": 75, "pow": 70, "edu": 75, "luck": 55},
    "occupationId": "investigator",
    "skills": [{"name": "侦查", "base": 25, "value": 55}],
    "status": {"hp": 11, "hpMax": 11, "san": 50, "sanMax": 75, "luck": 55, "move": 8},
    "gear": [], "weapons": [], "armor": [],
    "avatar": "",
    "updatedAt": 1700000000000
}


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

        async def close_sheets():
            await page.evaluate("()=>{while(document.querySelector('.sheet-mask')){UI.closeTopSheet();}}")
            await page.wait_for_timeout(250)

        # =========================================================
        # 一、年龄扣减：平均分摊 + 下限 15
        # =========================================================
        print("\n== 一、年龄扣减的分配逻辑 ==")
        await page.goto(BASE, wait_until="domcontentloaded")
        await page.wait_for_timeout(700)

        # 纯规则层验证（不依赖界面）
        rule = await page.evaluate("""()=>{
          const R = window.COC7;
          function run(age, a){
            const adj = R.ageAdjust(Object.assign({age:age}, a));
            return {
              loss: adj.loss, eff: adj.eff, raw: adj.raw,
              unapplied: adj.unapplied, totalLoss: adj.totalLoss,
              ruleLoss: adj.rule.physLoss
            };
          }
          return {
            old70: run(70, {str:85,con:80,dex:75,siz:70,app:80,int:75,pow:70,edu:75,luck:55}),
            old75: run(75, {str:60,con:55,dex:50,siz:60,app:60,int:60,pow:55,edu:60,luck:50}),
            teen:  run(17, {str:55,con:50,dex:60,siz:45,app:60,int:70,pow:55,edu:60,luck:60}),
            young: run(25, {str:70,con:65,dex:75,siz:60,app:70,int:70,pow:60,edu:70,luck:50}),
            low:   run(85, {str:16,con:15,dex:15,siz:30,app:50,int:60,pow:55,edu:60,luck:50})
          };
        }""")

        L = rule["old70"]["loss"]
        check("70 岁：力量/体质/敏捷三项都被扣（不再只扣力量）",
              L["str"] > 0 and L["con"] > 0 and L["dex"] > 0, L)
        spread = max(L["str"], L["con"], L["dex"]) - min(L["str"], L["con"], L["dex"])
        check("70 岁：三项扣减量最多相差 1", spread <= 1,
              "力 %d / 体 %d / 敏 %d（差 %d）" % (L["str"], L["con"], L["dex"], spread))
        check("70 岁：扣减总量等于规则值", L["str"] + L["con"] + L["dex"] == rule["old70"]["ruleLoss"],
              "%d vs %d" % (L["str"] + L["con"] + L["dex"], rule["old70"]["ruleLoss"]))

        E = rule["old70"]["eff"]
        check("70 岁：三项生效值都不低于 15",
              E["str"] >= 15 and E["con"] >= 15 and E["dex"] >= 15, E)

        LT = rule["low"]
        check("85 岁属性贴近下限：生效值守住 15",
              LT["eff"]["str"] >= 15 and LT["eff"]["con"] >= 15 and LT["eff"]["dex"] >= 15, LT["eff"])
        check("85 岁属性贴近下限：如实报告扣不完的点数",
              LT["unapplied"] > 0, "unapplied=%s" % LT["unapplied"])

        check("17 岁少年：摊到 力量/体型，不只扣力量",
              rule["teen"]["loss"]["str"] > 0 and rule["teen"]["loss"]["siz"] > 0,
              rule["teen"]["loss"])
        check("25 岁青年：完全无扣减", rule["young"]["totalLoss"] == 0, rule["young"]["totalLoss"])

        # 属性步骤里的年龄调整说明（用那张 70 岁的卡进属性步骤看）
        await page.evaluate("""(seed)=>{
          localStorage.setItem('coc7.characters.v1', JSON.stringify({[seed.id]: seed}));
          localStorage.removeItem('coc7.draft.v1');
          localStorage.removeItem('coc7.edit.v1');
        }""", SEED)
        await page.reload(wait_until="domcontentloaded")
        await page.wait_for_timeout(700)
        await page.evaluate("()=>{App.startEdit('testedit01');}")
        await page.wait_for_timeout(700)
        await page.evaluate("""()=>{
          const items=[...document.querySelectorAll('.stepper-item')];
          const t=items.find(x=>/属性/.test(x.textContent));
          if(t) t.click();
        }""")
        await page.wait_for_timeout(800)
        attr_ui = await txt("body")
        check("属性步骤说明了「平均分摊」", "平均分摊" in attr_ui)
        check("属性步骤说明了「最低 15」", "15" in attr_ui)
        cells = await page.evaluate("""()=>[...document.querySelectorAll('.attr-cell')]
            .map(c=>c.textContent).filter(t=>/年龄/.test(t))""")
        check("属性格下方显示「年龄 −X → 最终 Y」", len(cells) >= 3,
              "；".join(cells[:4]))
        note = await page.evaluate("""()=>{
          const b=document.querySelector('#ageNoteBody');
          return b? b.textContent : '';
        }""")
        check("年龄调整说明里三项扣减都列出来了",
              "力量 −14" in note and "体质 −13" in note and "敏捷 −13" in note,
              note[:150])
        check("说明里说明了平均分摊与下限 15",
              "平均分摊" in note and "15" in note, note[:200])
        await shot("v7_00_attr_step")

        # =========================================================
        # 二、属性步骤的界面呈现
        # =========================================================
        print("\n== 二、属性步骤界面 ==")
        # 注意：Store 在页面加载时就把 characters 读进内存了，
        # 后写 localStorage 不生效 —— 必须 reload 让它重新读一遍。
        await page.evaluate("""(seed)=>{
          localStorage.setItem('coc7.characters.v1', JSON.stringify({[seed.id]: seed}));
          localStorage.removeItem('coc7.draft.v1');
          localStorage.removeItem('coc7.edit.v1');
        }""", SEED)
        await page.reload(wait_until="domcontentloaded")
        await page.wait_for_timeout(700)
        seeded = await page.evaluate("()=>!!(Store.listCharacters()||[]).find(c=>c.id==='testedit01')")
        check("测试用角色卡已注入", seeded)
        await page.evaluate("()=>{location.hash='#/my';}")
        await page.wait_for_timeout(600)

        # 进编辑
        await page.evaluate("()=>{App.startEdit('testedit01');}")
        await page.wait_for_timeout(800)

        editing = await page.evaluate("()=>Store.isEditing()")
        check("startEdit 进入编辑会话", editing)

        bar = await page.evaluate("""()=>{
          const e=document.querySelector('.edit-bar');
          return e? e.textContent : '';
        }""")
        check("顶部有「正在编辑」提示条", "正在编辑" in bar, bar[:60])
        check("提示条说明了必须手动保存", "保存修改" in bar, bar[:120])

        # 改姓名（走最直观的路径）
        await page.evaluate("""()=>{
          const c = Store.getState().current;
          c.characterName = '被误改的名字';
          Store.scheduleSave();
        }""")
        await page.wait_for_timeout(1200)   # 等 debounce 走完 + doSave

        pill = await txt(".save-pill")
        check("编辑期间状态胶囊显示「修改未保存」而非「已保存」",
              "未保存" in pill and "已保存" not in pill, pill)

        stored = await page.evaluate("()=>JSON.parse(localStorage.getItem('coc7.characters.v1'))['testedit01'].characterName")
        check("自动保存没有写回角色卡（误改不丢原数据）",
              stored == "测试用调查员", "存储里现在是「%s」" % stored)

        buf = await page.evaluate("()=>{const e=JSON.parse(localStorage.getItem('coc7.edit.v1')||'null'); return e?(e.data.characterName):null;}")
        check("改动被暂存到中转区", buf == "被误改的名字", buf)

        dirty = await page.evaluate("()=>Store.isEditDirty()")
        check("isEditDirty 判定有未保存改动", dirty)

        await shot("v7_01_edit_mode")

        # =========================================================
        # 三、离开拦截
        # =========================================================
        print("\n== 三、离开时的未保存拦截 ==")
        await page.click(".appbar button.icon-btn")
        await page.wait_for_timeout(450)
        await page.click(".sheet .occ-item:has-text('首页')")
        await page.wait_for_timeout(600)
        dlg = await txt(".sheet-mask")
        check("带未保存修改离开向导会先拦一下",
              "还没有保存" in dlg or "未保存" in dlg, dlg[:100])
        await shot("v7_02_guard")
        # 选「继续编辑」
        await page.evaluate("()=>{UI.closeAllSheets();}")
        await page.wait_for_timeout(300)
        still = await page.evaluate("()=>!!Store.isEditing()")
        check("取消后仍停在编辑态", still)

        # =========================================================
        # 四、放弃修改 → 原卡纹丝不动
        # =========================================================
        print("\n== 四、放弃修改 ==")
        # 直接走 UI 上的「放弃」按钮
        await page.evaluate("""()=>{
          const btns=[...document.querySelectorAll('.edit-bar button')];
          const b=btns.find(x=>/放弃/.test(x.textContent));
          if(b) b.click();
        }""")
        await page.wait_for_timeout(500)
        dlg2 = await txt(".sheet-mask")
        check("点「放弃」先弹确认", "放弃所有未保存" in dlg2 or "放弃" in dlg2, dlg2[:100])
        await page.evaluate("()=>{UI.closeAllSheets();}")
        await page.wait_for_timeout(400)

        # =========================================================
        # 五、返回键在编辑态的行为
        # =========================================================
        print("\n== 五、返回键 ==")
        await page.evaluate("()=>{ if(!Store.isEditing()) App.startEdit('testedit01'); }")
        await page.wait_for_timeout(700)
        await page.evaluate("()=>{ Store.getState().current.characterName='返回键测试'; Store.scheduleSave(); }")
        await page.wait_for_timeout(1100)
        stored2 = await page.evaluate("()=>JSON.parse(localStorage.getItem('coc7.characters.v1'))['testedit01'].characterName")
        check("改了名字后角色卡仍未被自动改写", stored2 == "测试用调查员", stored2)

        consumed = await page.evaluate("()=>App.handleBack()")
        check("编辑态按返回不会退出应用", consumed is True)
        await page.wait_for_timeout(500)
        # 有未保存修改 → 弹「丢弃修改吗」，关掉它（相当于选「继续编辑」）
        dlg_back = await txt(".sheet-mask")
        check("编辑态按返回会先问「未保存的修改」",
              "未保存" in dlg_back or "还没有保存" in dlg_back, dlg_back[:80])
        await close_sheets()
        await page.wait_for_timeout(300)
        still_editing = await page.evaluate("()=>Store.isEditing()")
        check("取消后仍停在编辑态（可以接着改）", still_editing is True)

        # =========================================================
        # 六、手动保存才落库
        # =========================================================
        print("\n== 六、手动保存 ==")
        cur_name = await page.evaluate("()=>Store.getState().current.characterName")
        check("编辑副本里能看到刚才的改动", cur_name == "返回键测试", cur_name)

        await page.evaluate("()=>{ App.saveEdit(); }")
        await page.wait_for_timeout(800)
        # 卡不完整时会先弹一次确认（问题清单），点「仍然保存」才真正落库
        dlg3 = await txt(".sheet-mask")
        if "个问题" in dlg3 or "确定保存" in dlg3:
            await page.evaluate("""()=>{
              const bs=[...document.querySelectorAll('.sheet-mask button')];
              const b=bs.find(x=>/仍然保存/.test(x.textContent));
              if(b) b.click();
            }""")
            await page.wait_for_timeout(900)
            check("保存前会提示卡仍有问题", True)

        stored3 = await page.evaluate("()=>JSON.parse(localStorage.getItem('coc7.characters.v1'))['testedit01'].characterName")
        check("点「保存修改」后才写回角色卡", stored3 == "返回键测试", stored3)
        editing2 = await page.evaluate("()=>Store.isEditing()")
        check("保存后结束编辑会话", editing2 is False)
        cleared = await page.evaluate("()=>localStorage.getItem('coc7.edit.v1')")
        check("保存后清掉中转区", cleared is None, str(cleared)[:60])
        await shot("v7_03_saved")

        # =========================================================
        # 七、再次编辑：放弃后应恢复
        # =========================================================
        print("\n== 七、再次编辑 → 放弃 ==")
        await page.evaluate("()=>{App.startEdit('testedit01');}")
        await page.wait_for_timeout(700)
        await page.evaluate("""()=>{
          const c=Store.getState().current;
          c.characterName='又一次误改';
          Store.scheduleSave();
        }""")
        await page.wait_for_timeout(1100)
        stored4 = await page.evaluate("()=>JSON.parse(localStorage.getItem('coc7.characters.v1'))['testedit01'].characterName")
        check("第二次编辑同样不会自动落库", stored4 == "返回键测试", stored4)

        await page.evaluate("()=>{Store.cancelEdit();}")
        await page.wait_for_timeout(400)
        stored5 = await page.evaluate("()=>JSON.parse(localStorage.getItem('coc7.characters.v1'))['testedit01'].characterName")
        check("放弃修改后角色卡恢复原值", stored5 == "返回键测试", stored5)

        # =========================================================
        # 八、角色卡上的编辑入口
        # =========================================================
        print("\n== 八、入口一致性 ==")
        await page.evaluate("()=>{App.go('#/card/coc7/testedit01');}")
        await page.wait_for_timeout(700)
        has_btn = await page.evaluate("""()=>[...document.querySelectorAll('button')].some(b=>/编辑角色/.test(b.textContent))""")
        check("角色卡页仍有「✎ 编辑角色」", has_btn)
        await page.evaluate("""()=>{
          const b=[...document.querySelectorAll('button')].find(x=>/编辑角色/.test(x.textContent));
          if(b) b.click();
        }""")
        await page.wait_for_timeout(800)
        e3 = await page.evaluate("()=>Store.isEditing()")
        check("从角色卡页点编辑也走编辑会话", e3 is True)
        await shot("v7_04_from_card")

        # 编辑模式下不能回第 0 步
        await page.evaluate("()=>{ Store.cancelEdit(); }")
        await page.wait_for_timeout(300)

        # =========================================================
        # 收尾
        # =========================================================
        def is_noise(e):
            return ("favicon" in e)

        real_errors = [e for e in errors if not is_noise(e)]
        print("\n控制台错误：%d 条" % len(real_errors))
        for e in real_errors[:12]:
            print("   " + e)

        await browser.close()

    ok = sum(1 for _, o, _ in results if o)
    print("\n===== 结果 %d / %d =====" % (ok, len(results)))
    if ok != len(results):
        print("失败项：")
        for n, o, d in results:
            if not o:
                print("  - " + n + "  <- " + str(d))
    print("控制台错误 %d 条" % len([e for e in errors if "favicon" not in e]))


asyncio.run(main())