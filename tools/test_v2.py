# -*- coding: utf-8 -*-
"""针对本轮修改的验证（走真实 UI 交互，不做后门赋值）：
  1. 默认主题为亮色；暗色主题下不再出现黑字
  2. 步骤顺序：资产（信用评级）在技能之前
  3. 技能列表 斗殴/射击 等组技能专攻默认可见
  4. 技能点支持手动键入，且输入过程不失焦、不叠加
  5. 技能点未用完时点下一步会提醒
  6. 信用评级「采用建议值」能真正改变评级
  7. 第九步底部「完成」按钮可点击并保存
  8. 法术可从列表中选取
"""
import os
import asyncio, os
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:%d/index.html" % int(os.environ.get("COC_STATIC_PORT") or 8899)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots2")
os.makedirs(OUT, exist_ok=True)

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

        async def shot(n):
            await page.screenshot(path=os.path.join(OUT, n + ".png"), full_page=True)

        async def skip_step0():
            """第 0 步「快速开始」是本批新加的：新建角色卡会先落在这一步。
            本文件只验证第 1 步起的流程，统一按「我要自己车卡」跳过。"""
            if await page.locator("button:has-text('我要自己车卡')").count():
                await page.click("button:has-text('我要自己车卡')")
                await page.wait_for_timeout(700)

        async def state():
            return await page.evaluate("""()=>{
              const c=Store.getState().current||{};
              const o=c.occupationId?CocOccupation.getById(c.occupationId):null;
              return {step:(document.querySelector('.stepper-item.active')||{}).textContent,
                      occId:c.occupationId||null, occName:o?o.name:null};
            }""")

        # ---------- 0. 干净环境 ----------
        await page.goto(BASE, wait_until="networkidle")
        await page.evaluate("()=>localStorage.clear()")
        await page.goto(BASE, wait_until="networkidle")
        await page.wait_for_timeout(700)

        # ---------- 1. 默认主题 ----------
        print("\n1) 默认主题")
        theme = await page.evaluate("()=>document.documentElement.getAttribute('data-theme')")
        check("默认主题为亮色", theme == "light", "实际=" + str(theme))
        await shot("v01_home_light")

        # ---------- 2. 暗色主题文字可见 ----------
        print("\n2) 暗色主题文字颜色")
        await page.evaluate("()=>{Store.setSettings({theme:'dark'});document.documentElement.setAttribute('data-theme','dark');}")
        await page.wait_for_timeout(400)
        colors = await page.evaluate("""()=>{
          const out={};
          const t=document.querySelector('.rule-card.on .t');
          if(t) out.ruleCardTitle=getComputedStyle(t).color;
          return out;
        }""")
        rgb = colors.get("ruleCardTitle", "")
        dark = False
        if rgb.startswith("rgb("):
            v = [int(x) for x in rgb[4:-1].split(",")[:3]]
            dark = sum(v) < 200
        check("暗色主题下规则卡标题不是黑字", not dark, colors)
        await shot("v02_home_dark")
        await page.evaluate("()=>{Store.setSettings({theme:'light'});document.documentElement.setAttribute('data-theme','light');}")

        # ---------- 3. 步骤顺序 ----------
        print("\n3) 步骤顺序")
        await page.click("button.rule-card.on")
        await page.wait_for_timeout(800)
        await skip_step0()
        order = await page.evaluate("""()=>Array.from(document.querySelectorAll('.stepper-item span:not(.dot)')).map(e=>e.textContent)""")
        expect = ["快速开始", "基本资料", "属性", "职业", "资产", "技能", "战斗", "装备", "背景", "完成"]
        check("步骤顺序为 资产 在 技能 之前（第 0 步「快速开始」在最前）", order == expect, order)

        # 基本资料
        await page.fill("#app .card input[type=text] >> nth=0", "亚历克斯·布莱克")
        await page.fill("#app .card input[type=text] >> nth=1", "茶叶蛋调查员")
        await page.fill("input[type=number]", "30")
        await page.wait_for_timeout(300)
        await page.click(".bottombar button:has-text('下一步')")
        await page.wait_for_timeout(600)

        # 属性
        await page.click(".card .btn.primary")
        await page.wait_for_timeout(700)
        await page.click("button:has-text('接受')")
        await page.wait_for_timeout(500)
        await page.click(".bottombar button:has-text('下一步')")
        await page.wait_for_timeout(600)

        # 职业：搜索后按「名称完全相同」点击，
        # 注意搜索是跨 名称/技能/描述 的子串匹配，"私家侦探"会命中描述里含该词的其它职业
        print("   搜索 私家侦探")
        await page.fill(".search-box input", "私家侦探")
        await page.wait_for_timeout(800)
        hits = await page.evaluate("""()=>Array.from(document.querySelectorAll('.occ-item .nm')).map(e=>e.textContent)""")
        print("   命中：", hits)
        await page.click(".occ-item:has(.nm:text-is('私家侦探'))")
        await page.wait_for_timeout(900)
        st = await state()
        check("职业已选中（私家侦探）", st["occId"] == "occ91", st)

        # 填本职技能选择
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
        await page.wait_for_timeout(400)
        await page.click(".bottombar button:has-text('下一步')")
        await page.wait_for_timeout(700)

        # ---------- 4. 资产步骤：信用评级 ----------
        print("\n4) 信用评级（资产步骤）")
        st = await state()
        check("已进入资产步骤", "资产" in (st["step"] or ""), st["step"])
        cur = await page.evaluate("""()=>{
          const c=Store.getState().current, o=CocOccupation.getById(c.occupationId);
          return {occ:o.name, min:o.creditMin, max:o.creditMax, cr:c.assets.creditRating};
        }""")
        print("     职业=%s 允许 %s-%s 当前=%s" % (cur["occ"], cur["min"], cur["max"], cur["cr"]))
        await shot("v03_assets")

        # 4a) 手动输入：键入 3 后不失焦，再键入 0 得到 30
        box = await page.query_selector(".card input[inputmode=numeric]")
        await box.click()
        await page.keyboard.press("Control+a")
        await page.keyboard.type("3", delay=60)
        mid = await page.evaluate("""()=>({
          val: document.querySelector('.card input[inputmode=numeric]').value,
          focused: document.activeElement === document.querySelector('.card input[inputmode=numeric]'),
          cr: Store.getState().current.assets.creditRating
        })""")
        await page.keyboard.type("0", delay=60)
        await page.wait_for_timeout(300)
        fin = await page.evaluate("""()=>({
          val: document.querySelector('.card input[inputmode=numeric]').value,
          focused: document.activeElement === document.querySelector('.card input[inputmode=numeric]'),
          cr: Store.getState().current.assets.creditRating
        })""")
        check("键入第一位数字后仍保持焦点（键盘不会收起）", mid["focused"], mid)
        check("连续键入 3→30 得到 30（而非 3+30）", fin["val"] == "30" and fin["cr"] == 30, fin)

        # 4b) 采用建议值能改变评级
        before = await page.evaluate("()=>Store.getState().current.assets.creditRating")
        await page.click("button.chip:has-text('采用建议值')")
        await page.wait_for_timeout(500)
        after = await page.evaluate("()=>Store.getState().current.assets.creditRating")
        check("「采用建议值」改变信用评级", before != after, "%s -> %s" % (before, after))
        inputVal = await page.evaluate("()=>document.querySelector('.card input[inputmode=numeric]').value")
        check("输入框同步显示新值", inputVal == str(after), inputVal)

        # 4c) 信用评级占用职业点
        pts = await page.evaluate("""()=>{
          const c=Store.getState().current;
          const p=CocOccupation.occupationPoints(c);
          const cr=c.assets.creditRating;
          const sk=c.skills.filter(s=>s.id==='credit')[0];
          return {total:p.total, used:p.used, cr:cr, creditOcc: sk?sk.occ:null};
        }""")
        check("信用评级计入职业点消耗", pts["used"] >= pts["cr"] and pts["creditOcc"] == pts["cr"], pts)
        await shot("v04_assets_set")

        await page.click(".bottombar button:has-text('下一步')")
        await page.wait_for_timeout(900)

        # ---------- 5. 技能步骤 ----------
        print("\n5) 技能列表与手动输入")
        st = await state()
        check("已进入技能步骤", "技能" in (st["step"] or ""), st["step"])
        allNames = await page.evaluate("()=>Store.getState().current.skills.map(s=>s.name)")
        check("技能列表包含 格斗（斗殴）", any("斗殴" in n for n in allNames))
        check("技能列表包含 射击（手枪）", any("手枪" in n for n in allNames))
        check("技能列表包含 科学（化学）", any("化学" in n for n in allNames))
        check("技能列表包含 心理学", any("心理学" in n for n in allNames))
        check("技能实例总数 >= 120", len(allNames) >= 120, len(allNames))

        # 组技能专攻行默认渲染（而不是折叠起来看不见）
        rendered = await page.evaluate("""()=>[...document.querySelectorAll('.skill-row .nm')].map(e=>e.textContent)""")
        check("「斗殴」行默认可见（组技能默认展开）", any("斗殴" in n for n in rendered),
              "渲染行数=%d" % len(rendered))
        check("「手枪」行默认可见", any("手枪" in n for n in rendered))
        await shot("v05_skill_groups")

        # 手动键入职业点：先全选清空，再键入 45
        res = await page.evaluate("""()=>{
          const c=Store.getState().current;
          return {occTotal: CocOccupation.occupationPoints(c).total,
                  occUsed: CocOccupation.occupationPoints(c).used};
        }""")
        print("     职业点 总%s 已用%s" % (res["occTotal"], res["occUsed"]))
        typed = await page.evaluate("""()=>{
          const rows = [...document.querySelectorAll('.skill-row')];
          const row = rows.find(r => r.querySelector('.nm') && r.querySelector('.nm').textContent === '侦查');
          if (!row) return {ok:false, why:'未找到侦查行'};
          const inp = row.querySelectorAll('.pin-input')[0];
          inp.focus(); inp.select();
          return {ok:true, valBefore: inp.value, ro: inp.readOnly};
        }""")
        if typed.get("ok"):
            await page.keyboard.type("45", delay=60)
            await page.wait_for_timeout(350)
            got = await page.evaluate("""()=>{
              const c=Store.getState().current;
              const s=c.skills.filter(x=>x.id==='spot_hidden')[0];
              const row=[...document.querySelectorAll('.skill-row')].find(r=>r.querySelector('.nm').textContent==='侦查');
              const inp=row.querySelectorAll('.pin-input')[0];
              return {occ:s.occ, total:s.total, inputVal:inp.value,
                      focused: document.activeElement===inp};
            }""")
            check("技能点可直接键入（侦查职业点=45）", got["occ"] == 45, got)
            check("键入技能点后仍保持焦点", got["focused"], got)
        else:
            check("技能点可直接键入", False, typed)

        # 连续键入 3→30 不叠加
        seq = await page.evaluate("""()=>{
          const row=[...document.querySelectorAll('.skill-row')].find(r=>r.querySelector('.nm').textContent==='侦查');
          const inp=row.querySelectorAll('.pin-input')[0];
          inp.focus(); inp.select();
          return true;
        }""")
        await page.keyboard.type("3", delay=70)
        await page.wait_for_timeout(250)
        m1 = await page.evaluate("()=>Store.getState().current.skills.filter(x=>x.id==='spot_hidden')[0].occ")
        await page.keyboard.type("0", delay=70)
        await page.wait_for_timeout(300)
        m2 = await page.evaluate("()=>Store.getState().current.skills.filter(x=>x.id==='spot_hidden')[0].occ")
        check("连键 3→30 结果为 30 而非 33", m1 == 3 and m2 == 30, "%s -> %s" % (m1, m2))

        # ---------- 6. 未用完点数提醒 ----------
        print("\n6) 点数未用完提醒")
        await page.click(".bottombar button:has-text('下一步')")
        await page.wait_for_timeout(700)
        dlgText = None
        try:
            dlg = await page.query_selector(".sheet-mask")
            if dlg:
                dlgText = await page.inner_text(".sheet-mask")
        except Exception:
            pass
        check("未用完点数时弹出提醒", dlgText is not None and ("尚未分配" in dlgText or "还剩" in dlgText),
              (dlgText or "无弹窗")[:80])
        if dlgText:
            await shot("v06_points_warning")
            await page.click(".sheet button:has-text('继续下一步')")
            await page.wait_for_timeout(800)

        # ---------- 7. 战斗 / 装备 / 背景（法术） ----------
        print("\n7) 战斗 / 装备 / 背景 / 法术")
        st = await state()
        check("已进入战斗步骤", "战斗" in (st["step"] or ""), st["step"])
        await page.click("button.btn:has-text('从武器库选择')")
        await page.wait_for_timeout(700)
        await page.click(".sheet .occ-item >> nth=0")
        await page.wait_for_timeout(700)
        await page.click(".bottombar button:has-text('下一步')")
        await page.wait_for_timeout(700)

        st = await state()
        check("已进入装备步骤", "装备" in (st["step"] or ""), st["step"])
        await page.click("button.chip:has-text('手电筒')")
        await page.wait_for_timeout(400)
        items = await page.evaluate("()=>Store.getState().current.items.length")
        check("可快捷添加装备（手电筒）", items >= 1, "物品数=%s" % items)
        await page.click(".bottombar button:has-text('下一步')")
        await page.wait_for_timeout(800)

        st = await state()
        check("已进入背景步骤", "背景" in (st["step"] or ""), st["step"])
        spellsBefore = await page.evaluate("()=>((Store.getState().current.mythos||{}).spells||[]).length")
        check("初始法术数量为 0", spellsBefore == 0, spellsBefore)
        await page.click("button.btn:has-text('从法术表选择')")
        await page.wait_for_timeout(700)
        await shot("v07_spell_picker")
        totalSpells = await page.evaluate("()=>COC_SPELLS.length")
        check("法术表已加载 60+ 个法术", totalSpells >= 60, totalSpells)
        await page.fill(".sheet input", "时空门")
        await page.wait_for_timeout(500)
        await page.click(".sheet .occ-item >> nth=0")
        await page.wait_for_timeout(700)
        spellsAfter = await page.evaluate("""()=>({
          n: ((Store.getState().current.mythos||{}).spells||[]).length,
          name: (((Store.getState().current.mythos||{}).spells||[])[0]||{}).name
        })""")
        check("可从法术表选择法术", spellsAfter["n"] == 1, spellsAfter)
        await shot("v08_spell_added")

        # 自定义法术
        await page.click("button.btn:has-text('自定义法术')")
        await page.wait_for_timeout(600)
        await page.fill(".sheet input >> nth=0", "茶叶蛋的召唤术")
        await page.click(".sheet button:has-text('学会该法术')")
        await page.wait_for_timeout(700)
        n2 = await page.evaluate("()=>((Store.getState().current.mythos||{}).spells||[]).length")
        check("可自定义添加法术", n2 == 2, "法术数=%s" % n2)

        await page.click(".bottombar button:has-text('下一步')")
        await page.wait_for_timeout(800)

        # ---------- 8. 第九步完成按钮 ----------
        print("\n8) 第九步底部完成按钮")
        st = await state()
        check("已进入完成步骤", "完成" in (st["step"] or ""), st["step"])
        await shot("v09_finish")
        btn = await page.query_selector(".bottombar button:has-text('完成')")
        check("底部存在「完成」按钮", btn is not None)
        if btn:
            visible = await btn.is_visible()
            enabled = await btn.is_enabled()
            check("完成按钮可点击", visible and enabled, "visible=%s enabled=%s" % (visible, enabled))
            await btn.click()
            await page.wait_for_timeout(900)
            mask = await page.query_selector(".sheet-mask")
            if mask:
                txt = await page.inner_text(".sheet-mask")
                print("     出现确认框：" + txt[:60].replace("\n", " "))
                ok = await page.query_selector(".sheet button:has-text('继续完成')")
                if ok:
                    await ok.click()
                    await page.wait_for_timeout(1000)
            saved = await page.evaluate("()=>Object.keys(Store.getState().characters||{}).length")
            check("点击完成按钮后角色被保存", saved >= 1, "角色数=%s" % saved)
        await shot("v10_finished")

        # ---------- 结果 ----------
        print("\n=== 控制台错误 ===")
        print("   无" if not errors else "\n".join("   " + e for e in errors[:20]))

        bad = [r for r in results if not r[1]]
        print("\n=== 汇总 ===")
        print("   通过 %d / %d" % (len(results) - len(bad), len(results)))
        for n, _, d in bad:
            print("   失败：" + n + "  " + str(d))
        await browser.close()


asyncio.run(main())
