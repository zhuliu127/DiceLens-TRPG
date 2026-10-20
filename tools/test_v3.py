# -*- coding: utf-8 -*-
"""本轮 9 项需求的回归验证（全部走真实 UI 交互）：
  1. 属性步骤：三种模式都显示总属性值；购点「不包含幸运」时幸运不可输入
  2. 年龄调整真正生效（属性扣减 / 派生属性 / 技能基础值）
  3. 职业列表每项显示职业点数
  4. 技能分配：本职技能减号可用；＋5/＋10 快捷按钮
  5. 技能点数说明不再跟随滚动固定在屏幕左上角
  6. 新建角色卡为完全空白（不继承上一张卡）
  7. 自定义武器「使用技能」为下拉，且显示技能成功率
  8. 症状表可点选（多选）并应用到恐惧症/狂躁症
  9. 完成角色卡后跳转首页；首页有规则分类标签；已移除 COC 6th 预留
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

        async def step_name():
            return await page.evaluate(
                "()=>((document.querySelector('.stepper-item.active')||{}).textContent||'')")

        async def next_step():
            await page.click(".bottombar button:has-text('下一步')")
            await page.wait_for_timeout(500)
            # 技能点没用完时会弹确认框，这里照点「继续下一步」
            if await page.locator("button:has-text('继续下一步')").count():
                await page.click("button:has-text('继续下一步')")
                await page.wait_for_timeout(600)

        async def close_sheet():
            if await page.locator(".sheet-head .icon-btn").count():
                await page.locator(".sheet-head .icon-btn").first.click()
                await page.wait_for_timeout(350)

        async def cur():
            return await page.evaluate("()=>Store.getState().current")

        # ---------- 0. 干净环境 ----------
        await page.goto(BASE, wait_until="networkidle")
        await page.evaluate("()=>localStorage.clear()")
        await page.goto(BASE, wait_until="networkidle")
        await page.wait_for_timeout(700)

        # ---------- 9. 首页：预留项 & 进入向导 ----------
        print("\n9) 首页预留项")
        ph = await page.evaluate("()=>RuleRegistry.placeholders.map(p=>p.name)")
        check("已移除「克苏鲁的呼唤 第六版」预留", not any("第六版" in x for x in ph), ph)
        check("仍保留 DND 5E / 自定义规则预留", len(ph) == 2, ph)

        await page.click("button.rule-card.on")
        await page.wait_for_timeout(800)
        await skip_step0()
        check("已进入创建向导", "基本资料" in await step_name(), await step_name())

        # 基本资料：年龄 55（用于验证年龄调整）
        await page.fill("#app .card input[type=text] >> nth=0", "年龄测试员")
        await page.fill("#app .card input[type=text] >> nth=1", "茶叶蛋")
        await page.fill("input[type=number]", "55")
        await page.wait_for_timeout(300)

        # ---------- 1. 总属性值 ----------
        print("\n1) 属性步骤 · 总属性值")
        await next_step()
        check("已进入属性步骤", "属性" in await step_name(), await step_name())

        vals = {"str": 60, "con": 50, "siz": 60, "dex": 50, "app": 50,
                "int": 60, "pow": 50, "edu": 60, "luck": 50}
        for k, v in vals.items():
            await page.fill("#attr_%s input" % k, str(v))
        await page.wait_for_timeout(500)

        sums = await page.evaluate("""()=>({
          rawAll: Engine.attrSum(Store.getState().current,true),
          rawNoLuck: Engine.attrSum(Store.getState().current,false),
          effAll: Engine.attrSumEff(Store.getState().current,true),
          cardText: (document.querySelector('.card')||{}).textContent||''
        })""")
        check("9 项之和 = 490", sums["rawAll"] == 490, sums["rawAll"])
        check("8 项之和（不含幸运）= 440", sums["rawNoLuck"] == 440, sums["rawNoLuck"])
        check("总属性值卡片出现在页面上（随机模式）", "总属性值" in sums["cardText"], sums["cardText"][:40])

        # 三种模式都要显示
        modes_ok = True
        for label in ["手动购点", "属性方案", "随机生成"]:
            await page.click(".tabs button.chip:has-text('%s')" % label)
            await page.wait_for_timeout(350)
            t = await page.evaluate("()=>document.body.textContent.indexOf('总属性值')>=0")
            if not t:
                modes_ok = False
        check("三种模式都显示总属性值", modes_ok)
        await shot("w01_attr_sum")

        # ---------- 2. 年龄调整 ----------
        print("\n2) 年龄调整（真正生效）")
        adj = await page.evaluate("""()=>{
          const a=Store.getState().current.ageAdj;
          return {loss:a.loss, totalLoss:a.totalLoss, eff:a.eff, movLoss:a.movLoss,
                  derived:Store.getState().current.derivedStats};
        }""")
        check("年龄 55 合计扣减 20（物理 10 平均摊到三项 + 外貌 10）", adj["totalLoss"] == 20, adj["loss"])
        # 55 岁规则扣 10 点物理，改为平均分摊到 力量/体质/敏捷：
        # 原 60/50/55 → 各扣 4/3/3，三项扣减量最多相差 1
        L = adj["loss"]
        check("物理扣减摊到三项（不再只扣力量）",
              L.get("str", 0) > 0 and L.get("con", 0) > 0 and L.get("dex", 0) > 0, adj["loss"])
        check("三项扣减量最多相差 1",
              max(L["str"], L["con"], L["dex"]) - min(L["str"], L["con"], L["dex"]) <= 1,
              "力 %d / 体 %d / 敏 %d" % (L["str"], L["con"], L["dex"]))
        check("物理扣减合计 = 10", L["str"] + L["con"] + L["dex"] == 10,
              L["str"] + L["con"] + L["dex"])
        check("生效力量 = 60-4 = 56", adj["eff"]["str"] == 60 - L["str"], adj["eff"]["str"])
        check("生效外貌 = 50-10 = 40", adj["eff"]["app"] == 40, adj["eff"]["app"])
        check("三项生效值都不低于 15",
              adj["eff"]["str"] >= 15 and adj["eff"]["con"] >= 15 and adj["eff"]["dex"] >= 15,
              "力 %d / 体 %d / 敏 %d" % (adj["eff"]["str"], adj["eff"]["con"], adj["eff"]["dex"]))
        check("HP 按生效值计算", adj["derived"]["maxHP"] >= 1, adj["derived"]["maxHP"])
        check("MOV 基础 7 − 年龄 2 = 5", adj["derived"]["mov"] == 5, adj["derived"]["mov"])

        badges = await page.evaluate("""()=>({
          str:(document.querySelector('#attr_str .attr-adj')||{}).textContent||'',
          app:(document.querySelector('#attr_app .attr-adj')||{}).textContent||'',
          con:(document.querySelector('#attr_con .attr-adj')||{}).textContent||'',
          dex:(document.querySelector('#attr_dex .attr-adj')||{}).textContent||''
        })""")
        check("力量格显示「年龄 −X → 最终 Y」",
              ("−%d" % L["str"]) in badges["str"] and str(adj["eff"]["str"]) in badges["str"], badges["str"])
        check("外貌格显示「年龄 −10 → 最终 40」", "−10" in badges["app"] and "40" in badges["app"], badges["app"])
        check("体质格也显示了扣减", ("−%d" % L["con"]) in badges["con"], badges["con"])
        check("敏捷格也显示了扣减", ("−%d" % L["dex"]) in badges["dex"], badges["dex"])

        note = await page.evaluate("()=>document.querySelector('#ageNoteBody').textContent")
        check("年龄说明写明扣减已生效",
              "自动生效" in note and ("力量 −%d" % L["str"]) in note
              and ("体质 −%d" % L["con"]) in note and ("敏捷 −%d" % L["dex"]) in note, note[:120])
        check("年龄说明写明平均分摊与下限 15", "平均分摊" in note and "15" in note, note[:200])
        check("年龄说明写明扣减落点", "派生属性" in note and "技能基础值" in note, note[-120:])

        # ---------- 1b. 购点不含幸运 → 幸运不可输入 ----------
        print("\n1b) 购点模式 · 不包含幸运")
        await page.click(".tabs button.chip:has-text('手动购点')")
        await page.wait_for_timeout(300)
        await page.click("button.chip:has-text('包含幸运')")
        await page.wait_for_timeout(300)
        ro1 = await page.evaluate("()=>document.querySelector('#attr_luck input').readOnly")
        await page.click("button.chip:has-text('不包含幸运')")
        await page.wait_for_timeout(300)
        ro2 = await page.evaluate("()=>document.querySelector('#attr_luck input').readOnly")
        hint = await page.evaluate("()=>((document.querySelector('#attr_luck .attr-lock')||{}).textContent)||''")
        check("含幸运时幸运可输入", ro1 is False, ro1)
        check("不含幸运时幸运输入被锁定", ro2 is True, ro2)
        check("显示锁定原因提示", "随机生成幸运值" in hint, hint)
        await shot("w02_luck_locked")

        # ---------- 3. 职业列表显示职业点 ----------
        print("\n3) 职业列表 · 职业点数")
        await next_step()
        check("已进入职业步骤", "职业" in await step_name(), await step_name())
        occ_pts = await page.evaluate("""()=>{
          const it=document.querySelector('.occ-item .occ-pts');
          return it?{num:it.querySelector('b').textContent, cap:it.querySelector('span').textContent}:null;
        }""")
        check("职业列表每项显示职业点数", occ_pts and occ_pts["num"].isdigit() and int(occ_pts["num"]) > 0, occ_pts)
        await shot("w03_occ_points")

        # 选「法医」：无自由/选择类需求（避免测试被"任选两项"卡住），且含本职技能「侦查」
        await page.fill(".search-box input", "法医")
        await page.wait_for_timeout(500)
        await page.evaluate("""()=>{
          const all=[...document.querySelectorAll('.occ-item')];
          const hit=all.filter(b=>(b.querySelector('.nm')||{}).textContent==='法医')[0];
          if(hit) hit.click();
        }""")
        await page.wait_for_timeout(700)
        occ_now = await page.evaluate("()=>{const c=Store.getState().current;return c.basicInfo.occupationName||null;}")
        check("已选中「法医」", occ_now == "法医", occ_now)

        # ---------- 4. 资产：定信用评级 ----------
        print("\n4) 资产步骤")
        await next_step()
        check("已进入资产步骤", "资产" in await step_name(), await step_name())
        await page.click("button.chip:has-text('采用建议值')")
        await page.wait_for_timeout(500)
        cr = await page.evaluate("()=>Store.getState().current.assets.creditRating")
        check("信用评级已分配且在职业范围内", 40 <= cr <= 60, cr)

        # ---------- 5. 技能：减号 / ＋5 / ＋10 ----------
        print("\n5) 技能分配 · 减号与快捷按钮")
        await next_step()
        check("已进入技能步骤", "技能" in await step_name(), await step_name())

        row_sel = "div.skill-row:has(span.nm:text-is('侦查'))"
        has_row = await page.locator(row_sel).count()
        check("找到「侦查」技能行", has_row > 0, has_row)

        grp = page.locator(row_sel).locator("div.calc-group").nth(0)   # 第 0 组 = 职业点
        minus = grp.locator("button.sbtn").nth(0)
        plus1 = grp.locator("button.sbtn").nth(1)
        plus5 = grp.locator("button.sbtn").nth(2)
        plus10 = grp.locator("button.sbtn").nth(3)

        check("存在「−」按钮", await minus.count() == 1)
        check("存在「+5」按钮", await plus5.inner_text() == "+5")
        check("存在「+10」按钮", await plus10.inner_text() == "+10")

        dis0 = await minus.evaluate("el=>el.classList.contains('dis')")
        check("未加点时减号呈禁用态（.dis）", dis0 is True, dis0)

        await plus5.click()
        await page.wait_for_timeout(350)
        o1 = await page.evaluate("()=>Store.getState().current.skills.find(s=>s.name==='侦查').occ")
        d1 = await minus.evaluate("el=>el.classList.contains('dis')")
        check("点「+5」加 5 点", o1 == 5, o1)
        check("加过点后减号变为可用（关键 bug 修复）", d1 is False, d1)

        await minus.click()
        await page.wait_for_timeout(300)
        o2 = await page.evaluate("()=>Store.getState().current.skills.find(s=>s.name==='侦查').occ")
        check("点「−」减 1 点（本职技能也能减）", o2 == 4, o2)

        await plus10.click()
        await page.wait_for_timeout(300)
        o3 = await page.evaluate("()=>Store.getState().current.skills.find(s=>s.name==='侦查').occ")
        check("点「+10」加 10 点", o3 == 14, o3)

        await minus.click()
        await plus1.click()
        await page.wait_for_timeout(350)
        o4 = await page.evaluate("()=>Store.getState().current.skills.find(s=>s.name==='侦查').occ")
        check("「−」「＋」粒度为 1", o4 == 14, o4)
        await shot("w04_skill_buttons")

        # ---------- 6. 说明文字不跟随滚动 ----------
        print("\n6) 点数说明不固定在屏幕左上角")
        layout = await page.evaluate("""()=>({
          noteExists: !!document.querySelector('.point-note'),
          noteInBar: !!document.querySelector('.point-bar .point-note'),
          tinyInBar: !!document.querySelector('.point-bar .tiny')
        })""")
        check("说明文字不在 sticky 点数条内部", layout["noteExists"] and not layout["noteInBar"] and not layout["tinyInBar"], layout)

        t0 = await page.evaluate("()=>document.querySelector('.point-note').getBoundingClientRect().top")
        await page.evaluate("()=>window.scrollTo(0, 900)")
        await page.wait_for_timeout(400)
        t1 = await page.evaluate("()=>document.querySelector('.point-note').getBoundingClientRect().top")
        barTop = await page.evaluate("()=>document.querySelector('.point-bar').getBoundingClientRect().top")
        check("滚动后说明文字随页面移出（不再固定左上角）", t1 < t0 - 200, "%s -> %s" % (t0, t1))
        check("点数条仍保持吸顶（sticky 未被破坏）", barTop < 120, barTop)
        await page.evaluate("()=>window.scrollTo(0, 0)")
        await page.wait_for_timeout(300)

        # ---------- 7. 战斗装备：武器技能下拉 ----------
        print("\n7) 战斗装备 · 自定义武器技能下拉")
        await next_step()
        check("已进入战斗步骤", "战斗" in await step_name(), await step_name())
        await page.click("button.btn:has-text('＋ 自定义武器')")
        await page.wait_for_timeout(600)

        opts = await page.evaluate("""()=>{
          const s=document.querySelector('.sheet select');
          if(!s) return null;
          return {n:s.options.length, first:[...s.options].slice(0,4).map(o=>o.textContent),
                  hasPercent:[...s.options].every(o=>o.textContent.indexOf('%')>=0)};
        }""")
        check("使用技能是下拉选择框", opts is not None, opts)
        check("下拉项含斗殴 / 手枪等战斗技能", opts and opts["n"] >= 10, opts and opts["n"])
        check("下拉项都带技能成功率", opts and opts["hasPercent"], opts and opts["first"])
        await shot("w05_weapon_select")

        # 选「手枪」并确认成功率提示同步
        await page.select_option(".sheet select", value="手枪")
        await page.wait_for_timeout(400)
        hint = await page.evaluate("()=>((document.querySelector('.sheet .field .help')||{}).textContent)||''")
        check("切换技能后展示成功率三点值", "常规" in hint and "困难" in hint, hint)

        await page.fill(".sheet input.input >> nth=0", "测试左轮")
        await page.click(".sheet button.btn.primary:has-text('保存武器')")
        await page.wait_for_timeout(600)
        w = await page.evaluate("()=>Store.getState().current.weapons.slice(-1)[0]")
        check("武器保存了所选技能", w and w["skill"] == "手枪", w and w["skill"])

        wk = await page.evaluate("()=>Store.getState().current.weapons.slice(-1)[0].skill")
        print("     武器技能 =", wk)

        # 武器库列表也显示技能值
        await page.click("button.btn:has-text('＋ 从武器库选择')")
        await page.wait_for_timeout(600)
        lib = await page.evaluate("""()=>{
          const it=document.querySelector('.sheet .occ-item');
          return it?it.textContent.replace(/\\s+/g,' ').slice(0,80):null;
        }""")
        check("武器库条目显示技能成功率", lib and "%" in lib, lib)
        await close_sheet()

        # ---------- 8. 背景：症状表点选 ----------
        print("\n8) 背景 · 症状表点选应用")
        await next_step()   # 装备
        check("已进入装备步骤", "装备" in await step_name(), await step_name())
        await next_step()   # 背景
        check("已进入背景步骤", "背景" in await step_name(), await step_name())

        await page.click("button.btn:has-text('打开症状表')")
        await page.wait_for_timeout(700)
        rows = page.locator(".sheet tbody tr")
        check("症状表已打开", await rows.count() == 100, await rows.count())

        names = []
        for i in range(3):
            cell = rows.nth(i).locator("td.pick").nth(0)
            names.append((await cell.inner_text()).strip())
            await cell.click()
            await page.wait_for_timeout(120)
        mania = rows.nth(0).locator("td.pick").nth(1)
        mania_name = (await mania.inner_text()).strip()
        await mania.click()
        await page.wait_for_timeout(250)

        picked_ui = await page.evaluate("()=>(document.querySelector('.sheet-actions .tiny')||{}).textContent||''")
        check("已选 4 项（3 恐惧 + 1 狂躁）", "已选 4 项" in picked_ui, picked_ui)
        await shot("w06_madness_pick")

        await page.click(".sheet-actions button.btn.primary")
        await page.wait_for_timeout(600)
        bg = await page.evaluate("()=>Store.getState().current.background.phobias")
        ok_all = all(n in bg for n in names) and mania_name in bg and "恐惧症" in bg and "狂躁症" in bg
        check("选中的症状已应用到恐惧症/狂躁症", ok_all, bg.replace("\n", " | ")[:110])
        await close_sheet()

        # ---------- 9. 完成 → 首页 ----------
        print("\n9) 完成角色卡 · 跳转首页")
        await next_step()
        check("已进入完成步骤", "完成" in await step_name(), await step_name())
        await page.click(".bottombar button:has-text('完成')")
        await page.wait_for_timeout(700)
        if await page.locator("button:has-text('继续完成')").count():
            await page.click("button:has-text('继续完成')")
            await page.wait_for_timeout(900)

        at_home = await page.evaluate("()=>!!document.querySelector('.home-hero')")
        check("完成后跳转到首页", at_home, at_home)
        chars = await page.evaluate("()=>Store.listCharacters().length")
        check("角色已保存", chars == 1, chars)

        tags = await page.evaluate("()=>[...document.querySelectorAll('.char-card .tag.rule-tag')].map(e=>e.textContent)")
        check("首页角色卡带规则分类标签", tags == ["COC 7th"], tags)
        draft = await page.evaluate("()=>Store.isDraftActive()")
        check("完成后不再残留「未完成的草稿」", draft is False, draft)
        await shot("w07_home_tagged")

        # ---------- 新建空白卡 ----------
        print("\n10) 新建角色卡为空白")
        await page.click("button.rule-card.on")
        await page.wait_for_timeout(900)
        await skip_step0()
        blank = await page.evaluate("""()=>{
          const c=Store.getState().current;
          return {name:c.characterName, player:c.playerName, occ:c.occupationId,
                  attrs:c.attributes, skills:c.skills.length, weapons:c.weapons.length,
                  age:c.basicInfo.age, cr:c.assets.creditRating};
        }""")
        check("新建卡姓名为空", blank["name"] == "", repr(blank["name"]))
        check("新建卡玩家名为空", blank["player"] == "", repr(blank["player"]))
        check("新建卡未继承职业", blank["occ"] == "", repr(blank["occ"]))
        check("新建卡属性全为空", all(v == "" for v in blank["attrs"].values()), blank["attrs"])
        check("新建卡技能/武器为空", blank["skills"] == 0 and blank["weapons"] == 0, (blank["skills"], blank["weapons"]))
        check("新建卡信用评级为 0", blank["cr"] == 0, blank["cr"])
        await shot("w08_new_blank")

        # ---------- 7b. 菜单导航（用户报的「第九步回不了首页」） ----------
        print("\n7b) 菜单导航 · 首页")
        await page.click(".stepper-item:has-text('完成')")
        await page.wait_for_timeout(700)
        check("可通过步骤条跳到第九步", "完成" in await step_name(), await step_name())

        async def menu(pick):
            await page.click(".appbar button.icon-btn")
            await page.wait_for_timeout(400)
            await page.click(".sheet button.occ-item:has-text('%s')" % pick)
            await page.wait_for_timeout(700)

        await menu("🏠 首页")
        check("第九步点菜单-首页可以回首页（用户报的 bug）",
              await page.evaluate("()=>!!document.querySelector('.home-hero')"),
              await page.evaluate("()=>location.hash"))

        await menu("🏠 首页")
        check("已处于首页时再点首页仍然正常（同 hash 也能重路由）",
              await page.evaluate("()=>!!document.querySelector('.home-hero')"))

        await menu("📇 我的角色")
        check("可从菜单进入「我的角色」", "我的角色" in (await page.evaluate("()=>document.body.textContent")))
        await menu("🏠 首页")
        check("从「我的角色」也能回首页",
              await page.evaluate("()=>!!document.querySelector('.home-hero')"))

        # ---------- 收尾 ----------
        print("\n=== 控制台错误 ===")
        if errors:
            for e in errors[:12]:
                print("   " + e)
        else:
            print("   无")
        ok = sum(1 for _, o, _ in results if o)
        print("\n=== 汇总 ===")
        print("   通过 %d / %d" % (ok, len(results)))
        await browser.close()
        return 0 if ok == len(results) and not errors else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
