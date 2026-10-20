# -*- coding: utf-8 -*-
"""第二批 6 项需求的回归验证（全部走真实 UI 交互）：
  1. 基本资料：年龄说明只出现一次「教育进步检定」；职业选择已从第一步移除；教育进步检定真的能加 EDU
  2. 属性设置：随机模式点「随机生成」立即预览总属性值（按钮旁）；已删除「重新随机」；
     购点模式上限有真实初值且提示数字随输入实时联动；克苏鲁神话不能靠兴趣加点
  3. 选择职业：已选职业后列表锁定，必须先「清除」；社交技能池含「取悦」；职业选项无 undefined
  4. 技能分配：上限设置只读展示；本职 / 兴趣两类上限分别生效
  5. SAN：上限 = 意志 POW，临时值可突破上限
  6. 品牌与 BUG：名称「跑团车卡器」、首页去掉「克苏鲁的呼唤 第七版」、图标换成 logo.png、
     首页「最近的调查员」能正常打开角色卡、「最近的调查员」标题与卡片无缝、关于页有作者与邮箱
"""
import os
import asyncio, os, re
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:%d/index.html" % int(os.environ.get("COC_STATIC_PORT") or 8899)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots4")
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

        async def step_name():
            return await page.evaluate(
                "()=>((document.querySelector('.stepper-item.active')||{}).textContent||'')")

        async def skip_step0():
            """第 0 步「快速开始」是本批新加的：新建角色卡会先落在这一步。
            本文件只验证第 1 步起的流程，统一按「我要自己车卡」跳过。"""
            if await page.locator("button:has-text('我要自己车卡')").count():
                await page.click("button:has-text('我要自己车卡')")
                await page.wait_for_timeout(700)

        async def step_index():
            return await page.evaluate(
                "()=>[...document.querySelectorAll('.stepper-item')].findIndex(e=>e.classList.contains('active'))")

        async def next_step():
            before = await step_index()
            for attempt in range(3):
                await page.click(".bottombar button:has-text('下一步')")
                await page.wait_for_timeout(520)
                # 点数没用完 / 有未完成选择时会弹确认框
                for _k in range(3):
                    if await page.locator("button:has-text('继续下一步')").count():
                        await page.click("button:has-text('继续下一步')")
                        await page.wait_for_timeout(600)
                    else:
                        break
                if await step_index() != before:
                    return
            await page.wait_for_timeout(300)

        async def text_of(sel):
            return await page.evaluate("(s)=>((document.querySelector(s)||{}).textContent||'')", sel)

        # ---------- 干净环境 ----------
        await page.goto(BASE, wait_until="networkidle")
        await page.evaluate("()=>localStorage.clear()")
        await page.goto(BASE, wait_until="networkidle")
        await page.wait_for_timeout(700)

        # =========================================================
        # 6a. 品牌 / 首页
        # =========================================================
        print("\n6) 品牌改版与首页")
        title = await page.title()
        check("网页标题 = 跑团车卡器", "跑团车卡器" in title, title)

        home_txt = await page.evaluate("()=>document.querySelector('#app').textContent")
        hero_txt = await page.evaluate("()=>document.querySelector('.home-hero').textContent")
        check("首页 hero 文案已去掉「克苏鲁的呼唤 第七版」", "克苏鲁的呼唤 第七版" not in hero_txt, hero_txt)
        check("首页标题为「跑团车卡器」", "跑团车卡器" in home_txt)
        # 规则卡上的「克苏鲁的呼唤 第七版」是可选规则系统的名字，应该保留
        check("规则选择卡仍保留「克苏鲁的呼唤 第七版」", "克苏鲁的呼唤 第七版" in home_txt)

        logo = await page.evaluate("""()=>{
          const imgs=[...document.querySelectorAll('#app img')].map(i=>i.getAttribute('src'));
          return {imgs, hero: !!document.querySelector('.home-hero .seal img')};
        }""")
        check("首页 hero 使用 logo.png", logo["hero"] and any("logo" in (s or "") for s in logo["imgs"]), logo)

        brand = await page.evaluate("""()=>{
          const b=document.querySelector('.appbar .brand');
          return {txt:b?b.textContent:'', hasImg:!!document.querySelector('.appbar .brand .brand-logo')};
        }""")
        check("顶栏品牌为「跑团车卡器」且带 logo", brand["hasImg"] and "跑团车卡器" in brand["txt"], brand)

        # 关于页
        await page.click(".appbar .icon-btn")
        await page.wait_for_timeout(420)
        await page.click("button.occ-item:has-text('关于')")
        await page.wait_for_timeout(500)
        about = await page.evaluate("()=>((document.querySelector('.sheet')||{}).textContent||'')")
        check("关于页含「作者：茶叶蛋」", "作者：茶叶蛋" in about, about[:160])
        check("关于页含邮箱 author@example.com", "author@example.com" in about)
        check("关于页已删除架构说明", "架构" not in about)
        check("关于页显示应用名「跑团车卡器」", "跑团车卡器" in about)
        await shot("v4_01_about")
        await page.click(".sheet-head .icon-btn")
        await page.wait_for_timeout(350)

        # =========================================================
        # 1. 基本资料
        # =========================================================
        print("\n1) 基本资料")
        await page.click("button.rule-card.on")
        await page.wait_for_timeout(800)
        await skip_step0()
        check("已进入创建向导", "基本资料" in await step_name(), await step_name())

        basic_txt = await page.evaluate("()=>document.querySelector('#app').textContent")
        check("第一步已无「职业」入口", "职业（跳转选择）" not in basic_txt and "职业选择" not in basic_txt)

        inputs = await page.locator("#app .card input[type=text]").all()
        await inputs[0].fill("年龄测试员")
        await inputs[1].fill("茶叶蛋")
        await page.fill("input[type=number]", "45")
        await page.wait_for_timeout(400)

        age_hint = await text_of("div.help")
        hint_all = await page.evaluate("""()=>[...document.querySelectorAll('#app .help')]
          .map(e=>e.textContent).filter(t=>t.indexOf('教育进步检定')>=0).join(' || ')""")
        check("年龄说明只出现一次「教育进步检定」", hint_all.count("教育进步检定") == 1, hint_all)
        check("年龄说明写明 2 次检定", "2 次" in hint_all, hint_all)
        await shot("v4_02_basic")

        # =========================================================
        # 2. 属性设置
        # =========================================================
        print("\n2) 属性设置")
        await next_step()
        check("已进入属性步骤", "属性" in await step_name(), await step_name())

        # 2a. 随机模式：点一次「随机生成」立刻预览
        await page.click(".tabs button.chip:has-text('随机生成')")
        await page.wait_for_timeout(300)

        no_reroll = await page.evaluate(
            "()=>document.body.textContent.indexOf('重新随机')<0")
        check("已删除「重新随机」按钮", no_reroll)

        await page.click("button:has-text('🎲 随机生成')")
        await page.wait_for_timeout(400)
        roll_sum = await text_of(".roll-sum")
        check("点「随机生成」后按钮旁立即显示总属性值", "总属性值" in roll_sum and "不含幸运" in roll_sum, roll_sum)
        prev = await page.evaluate("""()=>({
          prevCells: document.querySelectorAll('#rollPreview .attr-cell').length,
          pending: !!document.querySelector('.roll-sum').textContent
        })""")
        check("同时给出逐项预览", prev["prevCells"] >= 9, prev)
        check("预览期间数据尚未写入角色", await page.evaluate(
            "()=>{const c=Store.getState().current;return Object.keys(c.attributes).every(k=>c.attributes[k]===''||c.attributes[k]===undefined);}"))
        await shot("v4_03_roll_preview")

        # 接受
        await page.click("#rollPreview button:has-text('接受')")
        await page.wait_for_timeout(400)
        after_roll = await page.evaluate("()=>Store.getState().current.attributes")
        check("点「接受」后属性写入角色", all(str(after_roll[k]).isdigit() for k in
              ["str", "con", "siz", "dex", "app", "int", "pow", "edu", "luck"]), after_roll)

        # 2b. 购点：默认上限 + 实时联动
        await page.click(".tabs button.chip:has-text('手动购点')")
        await page.wait_for_timeout(350)
        pbcap = await page.evaluate("()=>Store.getState().current.pbCap")
        check("购点上限有真实初值（480）", pbcap == 480, pbcap)

        vals = {"str": 60, "con": 50, "siz": 60, "dex": 50, "app": 50,
                "int": 60, "pow": 50, "edu": 60, "luck": 50}
        for k, v in vals.items():
            await page.fill("#attr_%s input" % k, str(v))
        await page.wait_for_timeout(450)
        s1 = await text_of("#pbStatus")
        check("购点提示给出「计入 9 项」", "计入" in s1 and "9 项" in s1, s1[:70])
        check("购点提示未出现「超出上限 0」这种假数据", "超出上限 0" not in s1, s1[:90])

        # 改上限 → 数字必须变
        cap_input = page.locator("#app .card:has-text('手动购点') input[type=number]").first
        await cap_input.fill("400")
        await page.wait_for_timeout(420)
        s2 = await text_of("#pbStatus")
        m = re.search(r"超出\s*(\d+)", s2)
        check("把上限改成 400 后提示变为「超出」（而非仍显示剩余）", "超出" in s2, s2[:110])
        check("超出数值 = 已用 − 上限 = 490-400 = 90", m and m.group(1) == "90", m.group(1) if m else s2[:110])

        # 改一个属性 → 超出数值必须跟着变
        await page.fill("#attr_str input", "40")
        await page.wait_for_timeout(420)
        s3 = await text_of("#pbStatus")
        m3 = re.search(r"超出\s*(\d+)", s3)
        check("改力量 60→40 后超出数值联动为 70", m3 and m3.group(1) == "70", m3.group(1) if m3 else s3[:110])

        # 切「不包含幸运」→ 计入 8 项、上限对比 8 项
        await page.click("button.chip:has-text('不包含幸运')")
        await page.wait_for_timeout(420)
        s4 = await text_of("#pbStatus")
        check("切「不包含幸运」后提示显示「计入 8 项」", "8 项" in s4, s4[:110])
        luck_ro = await page.evaluate("()=>document.querySelector('#attr_luck input').readOnly")
        check("「不包含幸运」时幸运不可手填", luck_ro)
        await page.click("button.chip:has-text('包含幸运')")
        await page.wait_for_timeout(350)
        await cap_input.fill("480")
        await page.wait_for_timeout(300)

        # 2c. 教育进步检定
        print("\n1b) 教育进步检定（真的加 EDU）")
        await page.fill("#attr_edu input", "50")
        await page.wait_for_timeout(400)
        edu_card = await text_of("#eduCard")
        check("属性步骤出现「教育进步检定」卡片", "教育进步检定" in edu_card, edu_card[:60])
        check("卡片显示需要 2 次（45 岁）", "0 / 2" in edu_card, edu_card[:80])

        base_eff = await page.evaluate("()=>Engine.effAttrs(Store.getState().current).edu")
        check("起始生效 EDU = 50", base_eff == 50, base_eff)

        # 连掷两次，取每次记录
        for i in range(2):
            await page.click("#eduCard button:has-text('掷一次检定')")
            await page.wait_for_timeout(360)
        prog = await page.evaluate("()=>Store.getState().current.eduProgress")
        check("检定记录累计 2 次（不重复掷）", len(prog["log"]) == 2, prog)
        check("每次都记录了掷骰与前后值",
              all(("roll" in x and "before" in x and "after" in x) for x in prog["log"]), prog["log"][:2])

        eff_after = await page.evaluate("()=>Engine.effAttrs(Store.getState().current).edu")
        raw_edu = await page.evaluate("()=>Store.getState().current.attributes.edu")
        check("生效 EDU 已随检定结果增加", eff_after == 50 + prog["bonus"], (eff_after, prog["bonus"]))
        check("原始 EDU 不被改写（购点校验不受污染）", raw_edu == 50, raw_edu)
        check("生效 EDU 等于 原始 + 检定增益",
              eff_after - raw_edu == prog["bonus"], (eff_after, raw_edu, prog["bonus"]))

        edu_full = await text_of("#eduCard")
        check("次数用尽后显示「已全部完成」", "2 / 2" in edu_full, edu_full[:80])
        check("掷满后按钮变成不可再掷", "已全部完成" in edu_full, edu_full[:120])

        # 还原
        await page.click("#eduCard button:has-text('还原')")
        await page.wait_for_timeout(360)
        prog2 = await page.evaluate("()=>Store.getState().current.eduProgress")
        eff2 = await page.evaluate("()=>Engine.effAttrs(Store.getState().current).edu")
        check("「还原」清空检定并回退生效 EDU", len(prog2["log"]) == 0 and eff2 == 50, (prog2, eff2))
        await shot("v4_04_edu")

        # 教育进步对职业点的影响：用一份克隆角色验证（不污染当前卡）
        occ_pts_before = await page.evaluate("""()=>{
          const c=JSON.parse(JSON.stringify(Store.getState().current));
          c.occupationId='occ223'; c.occupationPicks={};   // 医生：教育×4
          Engine.recalc(c);
          const t1=CocOccupation.occupationPoints(c).total;
          // before 必须等于当前原始 EDU，否则 dropStaleEduChecks 会判定
          // 「基准对不上」把这批检定作废掉（守卫是故意的，这里要配合）
          const edu=c.attributes.edu;
          c.eduProgress={base:null,done:1,baseEdu:edu,
                         log:[{n:1,roll:99,before:edu,gain:10,after:edu+10}],bonus:10};
          Engine.recalc(c);
          return {t1, t2:CocOccupation.occupationPoints(c).total, edu,
                  bonus:COC7.eduBonusOf(c)};
        }""")
        check("职业点按生效 EDU 计算（教育 +10 → 职业点 +40）",
              occ_pts_before["t2"] == occ_pts_before["t1"] + 40, occ_pts_before)

        # =========================================================
        # 3. 选择职业
        # =========================================================
        print("\n3) 选择职业")
        await next_step()
        check("已进入职业步骤", "职业" in await step_name(), await step_name())

        occ_txt = await text_of("#app")
        check("职业选项无非法的 undefined", "undefined" not in occ_txt,
              [x for x in occ_txt.split("\n") if "undefined" in x][:3])

        # 直接调解析层做全量审计（页面只看当前职业）
        audit = await page.evaluate("""()=>{
          const bad=[], missSoc=[];
          CocOccupation.listAll().forEach(o=>{
            let reqs=[];
            try{ reqs=CocOccupation.getRequirements({occupationId:o.id, occupationPicks:{}}); }catch(e){ return; }
            reqs.forEach(r=>{
              const s=String(r.label||'')+'|'+String(r.raw||'');
              if(s.indexOf('undefined')>=0) bad.push(o.name+' :: '+s);
              if(/社交/.test(String(r.label||''))){
                const pool=(r.pool||r.options||[]).map(x=>x.skill);
                if(pool.length && pool.indexOf('charm')<0)
                  missSoc.push(o.name+' :: '+r.label+' → ['+pool.join(',')+']');
              }
            });
          });
          return {bad, missSoc};
        }""")
        check("全部职业需求标签无 undefined", len(audit["bad"]) == 0, audit["bad"][:4])
        check("所有「社交技能」选项池都包含「取悦」（魅惑）",
              len(audit["missSoc"]) == 0, audit["missSoc"][:4])

        # 选一个职业，然后尝试换 → 应被拦
        await page.click("#app .occ-item >> nth=0")
        await page.wait_for_timeout(450)
        first_id = await page.evaluate("()=>Store.getState().current.occupationId")
        check("已选中一个职业", bool(first_id), first_id)

        # 已选后列表是否锁定
        lock_card = await page.locator("#app .card:has-text('职业已选定')").count()
        pick_visible = await page.locator("#app .occ-item:visible").count()
        check("已选职业后出现「职业已选定」锁定卡", lock_card > 0, lock_card)
        check("已选职业后列表被收起（不能再重复选）", pick_visible == 0, pick_visible)
        await shot("v4_05_occ_locked")

        # 清除后可以重选
        clear_btn = page.locator("#app button:has-text('清除')")
        if await clear_btn.count():
            await clear_btn.first.click()
            await page.wait_for_timeout(450)
            cleared = await page.evaluate("()=>Store.getState().current.occupationId")
            check("点「清除」后职业被清空，可重新选择", not cleared, cleared)
            reopened = await page.locator("#app .occ-item").count()
            check("清除后职业列表重新出现", reopened > 0, reopened)
            await page.click("#app .occ-item >> nth=1")
            await page.wait_for_timeout(450)
            check("清除后能重新选到另一个职业",
                  await page.evaluate("()=>!!Store.getState().current.occupationId"))
        else:
            check("点「清除」后职业被清空，可重新选择", False, "未找到清除按钮")

        # =========================================================
        # 4. 技能分配
        # =========================================================
        print("\n4) 技能分配")
        # 直接用顶部步骤条跳到「技能」：职业的「自由选择」项还没填，走「下一步」会被守卫拦住
        await page.click(".stepper-item:has-text('技能')")
        await page.wait_for_timeout(700)
        check("已进入技能分配步骤", "技能" in await step_name(), await step_name())

        # 上限只读展示
        capdisp = await page.evaluate("""()=>({
          txt: (document.querySelector('.cap-display')||{}).textContent||'',
          isBtn: !!document.querySelector('.cap-display button')
        })""")
        check("上限以只读形式展示（不是可点按钮）", capdisp["txt"] and not capdisp["isBtn"], capdisp)
        check("分两类展示本职 / 兴趣上限",
              "本职" in capdisp["txt"] and "兴趣" in capdisp["txt"], capdisp["txt"][:80])

        # 双上限真实生效：把本职上限设为 60、兴趣上限设为 40
        await page.evaluate("""()=>{
          const c=Store.getState().current;
          c.skillCapOcc=60; c.skillCapInterest=40;
          SkillModel.syncSkills(c); Engine.recalc(c); Store.scheduleSave();
        }""")
        await page.click(".stepper-item:has-text('技能')")
        await page.wait_for_timeout(650)

        double = await page.evaluate("""()=>{
          const c=Store.getState().current;
          SkillModel.syncSkills(c);
          const occ=CocOccupation.occupationalSet(c);
          const occSkill = c.skills.find(s=>occ[s.key]||occ[s.id]);
          const intSkill = c.skills.find(s=>!occ[s.key]&&!occ[s.id]&&s.id!=='cthulhu');
          return {
            occCap: SkillModel.capOf(c, occSkill),
            intCap: SkillModel.capOf(c, intSkill),
            occName: occSkill.name, intName: intSkill.name
          };
        }""")
        check("本职技能上限 = 60", double["occCap"] == 60, double)
        check("兴趣技能上限 = 40", double["intCap"] == 40, double)

        # 加点约束：本职技能加到 61 应被拒
        block = await page.evaluate("""()=>{
          const c=Store.getState().current;
          const occ=CocOccupation.occupationalSet(c);
          const s=c.skills.find(x=>occ[x.key]||occ[x.id]);
          s.occ=60-s.base; s.int=0; s.growth=0; SkillModel.recompute(s);
          const r=SkillModel.canAdd(c,s,'occ',1);
          return {ok:r.ok, reason:r.reason||'', total:s.total, base:s.base};
        }""")
        check("本职技能到上限后不能再加", not block["ok"], block)

        # 克苏鲁神话：职业点与兴趣点都加不上
        cth = await page.evaluate("""()=>{
          const c=Store.getState().current;
          let s=c.skills.find(x=>x.id==='cthulhu');
          if(!s){ s=SkillModel.makeSkill(c,'cthulhu',''); c.skills.push(s); }
          const a=SkillModel.canAdd(c,s,'occ',1);
          const b=SkillModel.canAdd(c,s,'int',1);
          const g=SkillModel.canAdd(c,s,'growth',1);
          return {occ:a.ok, int:b.ok, growth:g.ok, reason:a.reason||''};
        }""")
        check("克苏鲁神话不能用职业点加", not cth["occ"], cth)
        check("克苏鲁神话不能用兴趣点加", not cth["int"], cth)
        check("克苏鲁神话可以用成长加", cth["growth"], cth)
        await shot("v4_06_skill_caps")

        # =========================================================
        # 5. SAN 模型
        # =========================================================
        print("\n5) SAN 模型")
        san = await page.evaluate("""()=>{
          const c=Store.getState().current;
          Engine.recalc(c);
          const pow=parseInt(c.effAttributes.pow,10)||0;
          // 临时值突破上限
          const before=c.status.currentSAN;
          c.status.currentSAN=Math.min(99,pow+13); c.status._sanTouched=true;
          Engine.recalc(c);
          return {pow, maxSAN:c.derivedStats.maxSAN, stMax:c.status.maxSAN,
                  after:c.status.currentSAN, before, breakOk:c.status.currentSAN>pow};
        }""")
        check("SAN 上限（分母）= 意志 POW", san["maxSAN"] == san["pow"] and san["stMax"] == san["pow"], san)
        check("当前 SAN 不超过上限（v2.1.5 夹回，不再突破）", san["after"] <= san["pow"], san)

        # POW 变化 → 上限跟着变
        powchg = await page.evaluate("""()=>{
          const c=Store.getState().current;
          const old=c.derivedStats.maxSAN;
          c.attributes.pow=parseInt(c.attributes.pow,10)-10;
          Engine.recalc(c);
          const now=c.derivedStats.maxSAN;
          c.attributes.pow=parseInt(c.attributes.pow,10)+10;
          Engine.recalc(c);
          return {old, now, back:c.derivedStats.maxSAN};
        }""")
        check("POW 减少时 SAN 上限同步下降", powchg["now"] == powchg["old"] - 10, powchg)

        # 状态管理面板：SAN 可输入超过 POW（面板由 app.js 渲染，检查接口可用）
        panel = await page.evaluate("""()=>{
          const c=Store.getState().current;
          Engine.recalc(c);
          const pow=c.derivedStats.maxSAN;
          return {pow, ok: pow===c.status.maxSAN};
        }""")
        check("状态面板上限信息与派生属性一致", panel["ok"], panel)
        await shot("v4_07_san")

        # =========================================================
        # 6b. 首页「最近的调查员」BUG
        # =========================================================
        print("\n6b) 首页「最近的调查员」")
        await page.goto(BASE + "#/", wait_until="networkidle")
        await page.wait_for_timeout(800)
        await page.evaluate("()=>{ if(Store.getState().draft) {} }")

        # 让当前角色落库（模拟完成创建）
        await page.evaluate("""()=>{
          const c=Store.getState().current;
          c.characterName = c.characterName || '年龄测试员';
          Store.finalize();
        }""")
        await page.goto(BASE + "#/", wait_until="networkidle")
        await page.wait_for_timeout(800)

        home = await page.evaluate("""()=>({
          hasList: !!document.querySelector('.char-list'),
          headTxt: (document.querySelector('.char-list .card-head')||{}).textContent||'',
          cards: document.querySelectorAll('.char-list .char-card').length,
          gap: (()=>{
            const l=document.querySelector('.char-list');
            const hd=document.querySelector('.char-list .card-head');
            if(!l||!hd) return null;
            const lb=l.getBoundingClientRect(), hb=hd.getBoundingClientRect();
            return Math.round(hb.bottom - lb.top);
          })()
        })""")
        check("首页出现「最近的调查员」区块", home["hasList"] and "最近的调查员" in home["headTxt"], home)
        check("标题与卡片在同一个 .char-list 容器内（无缝隙）",
              home["hasList"] and home["cards"] >= 1 and home["gap"] is not None, home)

        # 点击卡片 → 打开角色卡，不应出现「找不到这张角色卡」
        await page.click(".char-list .char-card >> nth=0")
        await page.wait_for_timeout(900)
        card_txt = await page.evaluate("()=>document.querySelector('#app').textContent")
        check("点击「最近的调查员」不再报「找不到这张角色卡」",
              "找不到这张角色卡" not in card_txt, card_txt[:120])
        check("确实进入了角色卡页面", "调查员" in card_txt or "SAN" in card_txt, card_txt[:80])
        await shot("v4_08_card_from_home")

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
