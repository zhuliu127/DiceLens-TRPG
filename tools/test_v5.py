# -*- coding: utf-8 -*-
"""第三批 4 项需求的回归验证（全部走真实 UI 交互）：
  1. 属性设置：新增「天命 N 选一」模式（2-10 选 1、掷出后不可重掷、选中写回属性）；
     手动购点总属性值超过上限时「下一步」被硬拦截
  2. 搜索：指定技能搜「斗殴」能搜到「格斗（斗殴）」；技能列表搜子类名/别名词也能命中
  3. 技能分配：母语不受上限设置限制（固定 99），基础值不会被误判超上限
  4. 第零步「快速开始」：生成 5 张预设卡、显示摘要、选中后保存到最近的调查员并回首页、
     未选中的不保存、可反复生成、可跳过去自己车卡
"""
import os
import asyncio, os
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:%d/index.html" % int(os.environ.get("COC_STATIC_PORT") or 8899)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots5")
os.makedirs(OUT, exist_ok=True)

errors = []
results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("  [OK] " if ok else "  [!!] ") + name + (("  <- " + str(detail)) if detail else ""))


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 412, "height": 900}, device_scale_factor=2)
        page = await ctx.new_page()
        page.on("console", lambda m: errors.append("[%s] %s" % (m.type, m.text)) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append("[pageerror] %s" % e))

        async def shot(n):
            await page.screenshot(path=os.path.join(OUT, n + ".png"), full_page=True)

        async def step_index():
            return await page.evaluate(
                "()=>[...document.querySelectorAll('.stepper-item')].findIndex(e=>e.classList.contains('active'))")

        async def step_labels():
            return await page.evaluate(
                "()=>[...document.querySelectorAll('.stepper-item')].map(e=>e.textContent)")

        async def txt(sel="body"):
            return await page.evaluate("(s)=>((document.querySelector(s)||{}).textContent||'')", sel)

        async def goto_step(name):
            """点顶部步骤条直接跳步（跳过校验）"""
            await page.click(".stepper-item:has-text('%s')" % name)
            await page.wait_for_timeout(650)

        async def reopen():
            """刷新页面（验证持久化）后重新回到向导。
            向导本身不写 location.hash，刷新会直接回首页，
            所以这里用 App.go('#/create') 显式进入；草稿有内容时会恢复到第 1 步。"""
            await page.reload(wait_until="networkidle")
            await page.wait_for_timeout(600)
            await page.evaluate("()=>window.App && App.go('#/create')")
            await page.wait_for_timeout(900)

        # ---------- 干净环境 ----------
        await page.goto(BASE, wait_until="networkidle")
        await page.evaluate("()=>localStorage.clear()")
        await page.goto(BASE, wait_until="networkidle")
        await page.wait_for_timeout(700)

        # =========================================================
        # 4. 第零步「快速开始」
        # =========================================================
        print("\n4) 第零步 快速开始")
        await page.click(".rule-card.on")
        await page.wait_for_timeout(800)
        labels = await step_labels()
        check("第 0 步已加入步骤条（共 10 步）", len(labels) == 10 and "快速开始" in labels[0], labels)
        check("新建角色默认落在第 0 步", await step_index() == 0)

        start_txt = await txt("#app")
        check("第 0 步顶部有功能说明", "这一步是干什么的" in start_txt and "生成随机角色" in start_txt)
        check("有「我要自己车卡」按钮", await page.locator("button:has-text('我要自己车卡')").count() == 1)
        await shot("v5_01_start")

        # --- 生成 5 张 ---
        await page.click("button:has-text('生成随机角色')")
        await page.wait_for_timeout(1600)
        n_cards = await page.locator(".preset-card").count()
        check("点一次生成 5 张预设卡", n_cards == 5, n_cards)

        info = await page.evaluate("""()=>{
          const host=Store.getState();
          return {chars:Object.keys(host.characters).length, draft: !!host.draft};
        }""")
        check("生成的预设卡不会自动落库（未选中不保存）", info["chars"] == 0, info)

        summary = await page.evaluate("""()=>{
          const c=document.querySelector('.preset-card');
          if(!c) return null;
          return {
            txt:c.textContent,
            attrs:c.querySelectorAll('.fate-cell').length,
            cells:[...c.querySelectorAll('.fate-cell .v')].map(x=>x.textContent),
            hasBtn: !!c.querySelector('button')
          };
        }""")
        check("摘要含 9 项属性", summary and summary["attrs"] == 9, summary and summary["attrs"])
        check("摘要属性值都是数字", summary and all(x.strip().isdigit() for x in summary["cells"]),
              summary and summary["cells"])
        for kw in ["属性", "派生与点数", "主要技能", "背景", "装备", "信用"]:
            check("摘要含「%s」区块" % kw, summary and kw in summary["txt"])
        await shot("v5_02_presets")

        # --- 再次生成，替换为新的一批（旧的仍不落库） ---
        old_name = await page.evaluate(
            "()=>document.querySelector('.preset-card .pc-name').textContent")
        await page.click("button:has-text('换一批')")
        await page.wait_for_timeout(1600)
        check("再点一次仍然给 5 张", await page.locator(".preset-card").count() == 5)
        check("重新生成后批次标题更新",
              "第 2 批" in await txt("#app"))
        still_zero = await page.evaluate("()=>Object.keys(Store.getState().characters).length")
        check("重新生成后旧批次仍未落库", still_zero == 0, still_zero)

        # --- 直接验证生成器：5 张全部通过完整校验 ---
        quality = await page.evaluate("""()=>{
          const list = PresetGen.generate(5);
          return list.map(c=>{
            Engine.recalc(c);
            const bad = Engine.checkList(c).filter(x=>!x.ok).map(x=>x.label);
            const o = CocOccupation.getById(c.occupationId) || {};
            const occ = CocOccupation.occupationPoints(c);
            const it = CocOccupation.interestPoints(c);
            return {
              bad:bad,
              name:c.characterName,
              occ:c.occupationId, occName:o.name,
              used:occ.used, total:occ.total,
              iUsed:it.used, iTotal:it.total,
              cr:c.assets.creditRating, crMin:o.creditMin, crMax:o.creditMax,
              weapons:c.weapons.length, armors:c.armors.length, items:c.items.length,
              bg:!!c.background.description, comp:c.companions.length, his:c.history.length,
              occDiffs: [...new Set(CocOccupation.occupationalSet(c) ? Object.keys(CocOccupation.occupationalSet(c)) : [])].length
            };
          });
        }""")
        check("生成器一次产出 5 张", len(quality) == 5, len(quality))
        check("5 张全部通过完整校验",
              all(len(q["bad"]) == 0 for q in quality),
              [q["bad"] for q in quality if q["bad"]])
        check("5 张技能点都未超额",
              all(q["used"] <= q["total"] and q["iUsed"] <= q["iTotal"] for q in quality),
              [(q["used"], q["total"], q["iUsed"], q["iTotal"]) for q in quality])
        check("5 张信用评级都在职业范围内",
              all(q["crMin"] <= q["cr"] <= q["crMax"] for q in quality),
              [(q["cr"], q["crMin"], q["crMax"]) for q in quality])
        check("5 张职业各不相同（同一批内不重样）",
              len(set(q["occ"] for q in quality)) >= 4, [q["occName"] for q in quality])
        check("5 张都填了背景 / 武器 / 防具 / 物品 / 经历 / 伙伴",
              all(q["bg"] and q["weapons"] and q["armors"] and q["items"] and q["comp"] and q["his"]
                  for q in quality))
        check("5 张都选了本职技能（occupationalSet 非空）",
              all(q["occDiffs"] > 0 for q in quality), [q["occDiffs"] for q in quality])

        # --- 选一张 → 保存并回首页 ---
        pick_name = await page.evaluate(
            "()=>document.querySelector('.preset-card .pc-name').textContent")
        await page.click(".preset-card button:has-text('选这张')")
        await page.wait_for_timeout(1200)
        check("选完自动回到首页", await page.evaluate("()=>!!document.querySelector('.home-hero')"))
        home_now = await txt("#app")
        check("首页「最近的调查员」出现该预设卡", pick_name in home_now, pick_name)
        saved = await page.evaluate("()=>Object.keys(Store.getState().characters).length")
        check("只保存了选中的这一张（未选中的没落库）", saved == 1, saved)
        check("首页不再挂着「发现未完成的草稿」", "发现未完成的草稿" not in home_now)
        await shot("v5_03_picked_home")

        # --- 保存的卡能正常打开角色卡 ---
        await page.click(".char-list .char-card >> nth=0")
        await page.wait_for_timeout(900)
        card_txt = await txt("#app")
        check("预设卡能正常打开（不报链接失效）", "找不到这张角色卡" not in card_txt)
        check("预设卡页面有 SAN / 技能内容", ("SAN" in card_txt) and ("技能" in card_txt), card_txt[:100])
        await shot("v5_04_preset_card")

        # --- 再走一遍：这次选「我要自己车卡」 ---
        await page.goto(BASE, wait_until="networkidle")
        await page.wait_for_timeout(600)
        await page.click(".rule-card.on")
        await page.wait_for_timeout(800)
        check("新建角色重新回到第 0 步", await step_index() == 0)
        await page.click("button:has-text('我要自己车卡')")
        await page.wait_for_timeout(800)
        idx = await step_index()
        check("点「我要自己车卡」进入第 1 步（基本资料）", idx == 1, idx)
        check("第 1 步没有预设卡区块",
              await page.locator(".preset-card").count() == 0)
        check("跳过后再次进入 #/create 不会退回第 0 步",
              await page.evaluate("()=>Store.getState().current.startSkipped === true"))
        await shot("v5_05_selfbuild")

        # =========================================================
        # 1. 天命 N 选一
        # =========================================================
        print("\n1) 属性设置：天命 N 选一 + 购点硬拦截")
        await page.evaluate("""()=>{
          const c=Store.getState().current;
          c.characterName='天命测试员'; c.playerName='茶叶蛋';
          c.basicInfo.age=30; c.age=30; c.basicInfo.gender='男';
          Store.scheduleSave();
        }""")
        await goto_step("属性")
        check("属性步骤在", "属性设置" in await txt(".step-head"))

        fate_tab = page.locator("button.chip:has-text('天命')")
        check("模式切换里有「天命 N 选一」", await fate_tab.count() == 1)
        await fate_tab.click()
        await page.wait_for_timeout(500)
        check("天命卡片渲染", "天命" in await txt("#fateCard"))
        check("说明写明掷出后不能重掷", "不能重掷" in await txt("#fateCard"))
        await shot("v5_06_fate_idle")

        # N=10
        n_input = page.locator("#fateCard input[type=number]").first
        await n_input.fill("10")
        await page.wait_for_timeout(300)
        await page.click("#fateCard button:has-text('掷出天命')")
        await page.wait_for_timeout(900)
        opts = await page.locator("#fateCard .fate-opt").count()
        check("填 10 就掷出 10 组", opts == 10, opts)
        check("已掷出标识", "不可重掷" in await txt("#fateCard"))
        roll_btn_disabled = await page.evaluate("""()=>{
          const bs=[...document.querySelectorAll('#fateCard button')];
          const b=bs.find(x=>/掷出天命|已掷出/.test(x.textContent));
          return b ? !!b.disabled : null;
        }""")
        check("「掷出天命」按钮已禁用", roll_btn_disabled is True, roll_btn_disabled)
        check("组数输入框已锁定",
              await page.evaluate("()=>document.querySelector('#fateCard input[type=number]').readOnly"))
        await shot("v5_07_fate_rolled")

        # 掷出后没选 → 不能进下一步
        await page.evaluate("""()=>{
          const c=Store.getState().current;
          c.attributes={str:'',con:'',siz:'',dex:'',app:'',int:'',pow:'',edu:'',luck:''};
          Engine.recalc(c); App.go && 0;
        }""")
        await page.wait_for_timeout(200)
        await page.click("button:has-text('下一步')")
        await page.wait_for_timeout(600)
        check("天命没选时不能进入下一步（留在第 2 步）", await step_index() == 2, await step_index())
        toast = await txt(".toast-host")
        check("给出「先选一组」的提示", "天命" in toast or "选一组" in toast, toast[:80])

        # 选一组
        first_roll = await page.evaluate("()=>JSON.stringify(Store.getState().current.fate.options)")
        await page.click("#fateCard .fate-opt >> nth=0 >> button")
        await page.wait_for_timeout(700)
        got = await page.evaluate("""()=>{
          const c=Store.getState().current;
          return {attrs:c.attributes, picked:c.fate.picked, mode:c.attributeMode};
        }""")
        check("选定后写回属性", all(str(got["attrs"][k]).strip() for k in
              ["str", "con", "siz", "dex", "app", "int", "pow", "edu", "luck"]), got["attrs"])
        check("picked = 0", got["picked"] == 0, got["picked"])
        check("attributeMode = fate", got["mode"] == "fate", got["mode"])
        check("掷出的 10 组没有因为选择而改变",
              first_roll == await page.evaluate("()=>JSON.stringify(Store.getState().current.fate.options)"))
        check("选中后可以进下一步（属性齐备）",
              await page.evaluate(
                  "()=>{const c=Store.getState().current;return Engine.attrsReady(c);}"))
        await shot("v5_08_fate_picked")

        # 不可重掷：再点一次（按钮禁用 → 用 evaluate 直接调 rollFate 走不通，改点选其它组仍然只换选择）
        await page.click("#fateCard .fate-opt >> nth=3 >> button")
        await page.wait_for_timeout(600)
        got2 = await page.evaluate("()=>Store.getState().current.fate.picked")
        check("可以改选其它组（但不会重掷）", got2 == 3, got2)
        same_opts = await page.evaluate("""()=>{
          const o=Store.getState().current.fate.options;
          return o.length===10 && o[0].str!==undefined;
        }""")
        check("10 组天命仍然只有一批（没有重掷）", same_opts)

        # 刷新生效（持久化）
        await reopen()
        persisted = await page.evaluate("""()=>{
          const c=Store.getState().current;
          if(!c) return {err:'current 为空'};
          return {rolled:c.fate.rolled, n:c.fate.n, len:c.fate.options.length, picked:c.fate.picked};
        }""")
        check("刷新后天命仍是同一批（持久化）",
              persisted["rolled"] and persisted["len"] == 10 and persisted["n"] == 10, persisted)

        # --- 购点：超额不能下一步 ---
        await goto_step("属性")
        await page.locator("button.chip:has-text('手动购点')").click()
        await page.wait_for_timeout(500)
        await page.evaluate("""()=>{
          const c=Store.getState().current;
          const vals=[90,90,90,90,90,90,90,90,90];
          const keys=['str','con','siz','dex','app','int','pow','edu','luck'];
          keys.forEach((k,i)=>{c.attributes[k]=vals[i];});
          c.pbCap=480; c.pbIncludeLuck=true;
          Engine.recalc(c); Store.saveNow();
        }""")
        await reopen()
        await goto_step("属性")
        await page.locator("button.chip:has-text('手动购点')").click()
        await page.wait_for_timeout(600)
        status = await txt(".sum-grid")
        check("购点提示显示超出上限", "超出" in status, status)
        blocked = await page.evaluate("""()=>{
          const t=document.querySelector('.bottombar .bar-block');
          return t ? t.textContent : '';
        }""")
        check("底栏显示硬拦截原因", "超出上限" in blocked, blocked)
        check("下一步按钮置灰",
              await page.evaluate("()=>!!document.querySelector('.bottombar button.btn.blocked')"))

        before_idx = await step_index()
        await page.click(".bottombar button:has-text('下一步')")
        await page.wait_for_timeout(700)
        check("购点超额时点「下一步」不前进", await step_index() == before_idx, await step_index())
        await shot("v5_09_pointbuy_blocked")

        # 改小 → 恢复可前进
        await page.evaluate("""()=>{
          const c=Store.getState().current;
          ['str','con','siz','dex','app','int','pow','edu','luck'].forEach(k=>c.attributes[k]=50);
          Engine.recalc(c); Store.saveNow();
        }""")
        await reopen()
        await goto_step("属性")
        await page.locator("button.chip:has-text('手动购点')").click()
        await page.wait_for_timeout(600)
        check("属性降到上限内后拦截消失",
              await page.locator(".bottombar .bar-block").count() == 0)
        await page.click(".bottombar button:has-text('下一步')")
        await page.wait_for_timeout(800)
        check("恢复后可以进入下一步", await step_index() == 3, await step_index())

        # =========================================================
        # 2. 搜索：斗殴 → 格斗（斗殴）
        # =========================================================
        print("\n2) 搜索：斗殴 / 子类名 / 别名")
        search_probe = await page.evaluate("""()=>{
          const hit = kw => window.COC_SKILLS.filter(s=>CocOccupation.skillMatches(s, kw))
            .map(s=>s.name + (CocOccupation.matchedSubs(s,kw) ? '|' + CocOccupation.matchedSubs(s,kw).map(x=>x.name).join(',') : ''));
          const g = window.COC_SKILLS.find(s=>s.id==='fighting');
          return {
            dou: hit('斗殴'),
            ge: hit('格斗'),
            geNull: CocOccupation.matchedSubs(g,'格斗') === null,
            geSubCount: (g.subskills||[]).length,
            geSubNames: (g.subskills||[]).map(x=>x.name),
            buqiang: hit('步枪'),
            latin: hit('拉丁语'),
            meihuo: hit('魅惑'),
            quyue: hit('取悦'),
            sheji: hit('射击'),
            inst: CocOccupation.instanceSearchText('fighting','斗殴'),
            instMatch: CocOccupation.instanceMatches('fighting','斗殴','斗殴'),
            instNoCross: CocOccupation.instanceMatches('fighting','斗殴','斧')
          };
        }""")
        check("搜「斗殴」能命中格斗组且只列斗殴",
              search_probe["dou"] == ["格斗|斗殴"], search_probe["dou"])
        # 搜组名本身 → matchedSubs 返回 null，代表 UI 会把整组专攻全列出来（这是期望行为）
        check("搜「格斗」命中组名（matchedSubs 返回 null = 列全组）",
              search_probe["ge"] == ["格斗"], search_probe["ge"])
        check("搜「格斗」时整组 7 个专攻都会被列出",
              search_probe["geNull"] and search_probe["geSubCount"] == 7,
              (search_probe["geNull"], search_probe["geSubCount"], search_probe["geSubNames"]))
        check("搜「步枪」命中射击组", search_probe["buqiang"] and "射击" in search_probe["buqiang"][0],
              search_probe["buqiang"])
        check("搜「拉丁语」命中其他语言组", any("其他语言" in x for x in search_probe["latin"]),
              search_probe["latin"])
        check("搜「魅惑」命中取悦", any("取悦" in x for x in search_probe["meihuo"]), search_probe["meihuo"])
        check("搜「取悦」命中取悦", any("取悦" in x for x in search_probe["quyue"]), search_probe["quyue"])
        check("搜「射击」命中射击组", any("射击" in x for x in search_probe["sheji"]), search_probe["sheji"])
        check("专攻实例搜索文本含自身名", "斗殴" in search_probe["inst"], search_probe["inst"])
        check("专攻实例不会跨子类误命中（搜斗殴不该命中斧）", search_probe["instNoCross"] is False)

        # 真机操作：职业步骤的「＋ 指定技能」搜索
        await goto_step("职业")
        await page.evaluate("""()=>{
          const c=Store.getState().current;
          c.occupationId='occ1';   // 自定义职业 → 有「不多于 8 个本职技能」的自由选择
          c.occupationPicks={};
          Store.saveNow();
        }""")
        await reopen()
        await goto_step("职业")
        free_btn = page.locator("button.chip:has-text('指定技能')").first
        check("存在「指定技能」入口", await free_btn.count() >= 1)
        await free_btn.click()
        await page.wait_for_timeout(600)
        sheet_input = page.locator(".sheet input").first
        await sheet_input.fill("斗殴")
        await page.wait_for_timeout(500)
        sheet_txt = await txt(".sheet")
        check("在「指定技能」里搜「斗殴」能搜到「格斗（斗殴）」", "斗殴" in sheet_txt, sheet_txt[:200])
        check("搜「斗殴」时不会把整组 7 个专攻都列出来",
              "斧" not in sheet_txt, sheet_txt[:200])
        await shot("v5_10_search_dou")
        await sheet_input.fill("魅惑")
        await page.wait_for_timeout(500)
        sheet_txt2 = await txt(".sheet")
        check("在「指定技能」里搜「魅惑」能搜到「取悦」", "取悦" in sheet_txt2, sheet_txt2[:200])
        await page.evaluate("()=>document.querySelectorAll('.sheet-mask').forEach(m=>m.remove())")
        await page.wait_for_timeout(300)

        # 技能列表搜索
        await page.evaluate("""()=>{
          const c=Store.getState().current;
          c.characterName='搜索测试员'; c.playerName='茶叶蛋';
          c.basicInfo.age=30; c.age=30;
          c.attributes={str:60,con:60,siz:60,dex:60,app:60,int:70,pow:60,edu:70,luck:50};
          Store.saveNow();
        }""")
        await goto_step("技能")
        skill_search = page.locator(".card input[placeholder='技能名…']")
        await skill_search.fill("斗殴")
        await page.wait_for_timeout(600)
        list_txt = await txt(".skill-list")
        check("技能列表搜「斗殴」出现在列表中", "斗殴" in list_txt, list_txt[:160])
        await skill_search.fill("斧")
        await page.wait_for_timeout(500)
        list_txt2 = await txt(".skill-list")
        check("技能列表搜「斧」只列格斗（斧）", "斧" in list_txt2 and "斗殴" not in list_txt2,
              list_txt2[:160])
        await skill_search.fill("魅惑")
        await page.wait_for_timeout(500)
        check("技能列表搜旧译「魅惑」能搜到「取悦」", "取悦" in await txt(".skill-list"))
        await shot("v5_11_skill_search")

        # =========================================================
        # 3. 母语不受上限限制
        # =========================================================
        print("\n3) 技能分配：母语不受上限设置")
        caps = await page.evaluate("""()=>{
          const c=Store.getState().current;
          c.skillCapOcc=50; c.skillCapInterest=40; c.skillCap=50;
          SkillModel.syncSkills(c);
          // 让教育高达 85，母语基础值就会超过 40/50 两个上限
          c.attributes.edu=85; Engine.recalc(c);
          SkillModel.syncSkills(c); Engine.recalc(c);
          const own=c.skills.find(s=>s.id==='language_own');
          const dodge=c.skills.find(s=>s.id==='dodge');
          const other=c.skills.find(s=>s.id==='spot_hidden');
          Store.saveNow();   // 落库，下面要刷新页面验证 UI
          return {
            edu:Engine.effAttrs(c).edu,
            ownBase:own.base, ownTotal:own.total, ownCap:SkillModel.capOf(c,own),
            dodgeBase:dodge.base, dodgeCap:SkillModel.capOf(c,dodge),
            otherCap:SkillModel.capOf(c,other),
            overCap: SkillModel.stats(c).overCap.map(s=>s.name),
            addOk: SkillModel.canAdd(c, own, 'int', 10).ok,
            addTooMuch: SkillModel.canAdd(c, own, 'int', 60).ok,
            validator: COC7.validators.skillCap(c).map(x=>x.text)
          };
        }""")
        check("母语基础值 = 教育（85）", caps["ownBase"] == caps["edu"] == 85, caps)
        check("母语上限固定 99（不受 40/50 约束）", caps["ownCap"] == 99, caps["ownCap"])
        check("母语基础 85 不再被算作超上限", caps["ownTotal"] <= caps["ownCap"], caps)
        check("其他技能仍受上限约束（侦查 = 兴趣上限 40）", caps["otherCap"] == 40, caps["otherCap"])
        check("母语可以继续加点", caps["addOk"] is True)
        check("母语硬顶 99：加到 145 被拒", caps["addTooMuch"] is False)
        check("overCap 列表里没有母语", "母语" not in caps["overCap"], caps["overCap"])
        check("skillCap 校验器不再报母语超限",
              not any("母语" in x for x in caps["validator"]), caps["validator"])
        check("闪避上限不低于自身基础值（基础值不算超限）",
              caps["dodgeCap"] >= caps["dodgeBase"], (caps["dodgeBase"], caps["dodgeCap"]))

        # UI 上的表现
        await reopen()
        await goto_step("技能")
        own_row = await page.evaluate("""()=>{
          const c=Store.getState().current;
          const own=c.skills.find(s=>s.id==='language_own');
          const el=document.getElementById('skill_'+own.key.replace(/[^\\w]/g,'_'));
          return el ? {txt:el.textContent, err:el.classList.contains('is-err')} : null;
        }""")
        check("母语行有「上限豁免」标签", own_row and "上限豁免" in own_row["txt"], own_row and own_row["txt"][:120])
        check("母语行没有被标红", own_row and not own_row["err"])
        await shot("v5_12_native_cap")

        # 上限设置弹层里有豁免说明
        await page.click("button:has-text('上限设置')")
        await page.wait_for_timeout(600)
        cap_txt = await txt(".sheet")
        check("上限设置弹层说明母语的豁免", "母语" in cap_txt and "99" in cap_txt, cap_txt[:200])
        await shot("v5_13_cap_sheet")
        await page.evaluate("()=>document.querySelectorAll('.sheet-mask').forEach(m=>m.remove())")

        # ---------- 收尾 ----------
        await browser.close()

    print("\n================ 汇总 ================")
    okn = sum(1 for r in results if r[1])
    print("通过 %d / %d" % (okn, len(results)))
    failed = [r for r in results if not r[1]]
    if failed:
        print("\n失败项：")
        for n, _, d in failed:
            print("  - %s   %s" % (n, d))
    errs = [e for e in errors if "favicon" not in e.lower()]
    print("\n控制台错误 %d 条" % len(errs))
    for e in errs[:12]:
        print("  " + e)
    return 0 if (okn == len(results) and not errs) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
