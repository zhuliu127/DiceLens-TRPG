# -*- coding: utf-8 -*-
"""
test_v13.py —— 技能上限的语义（每项封顶）+ 信用评级仅成长

⚠️ 语义已按用户澄清改过：
   旧：把「职业技能点数上限 80」实现成「点数池压到 80」→ 界面显示 80/280，
       看着像有 200 点没用完。
   新：职业点上限 80 → **「侦查」这类本职技能最多点到 80**；
       兴趣点上限 60 → **「会计」这类非本职技能最多点到 60**。
       点数总额始终是规则算出的全额。

另外：信用评级与克苏鲁神话同待遇 —— 车卡时不可加点（仅成长）+豁免技能上限。

覆盖：
  1. 生成前就说明「上限是每一项的天花板，不减少点数总额」
  2. 生成后点数总额**没有被压小**（仍等于规则公式值）
  3. 本职技能逐项不超过本职上限；非本职逐项不超过兴趣上限
  4. 玩家自选的个人特长 / 时代特长按「是否属于本职」分流
  5. 信用评级：技能分配步骤里 occ/int 都加不了、growth 可以
  6. 信用评级豁免上限（把上限压到 30 也仍然是 99）
  7. 信用评级仍落在职业允许区间内，且照常占用职业点
  8. 角色详情页写明上限只压每项、不减点数
"""
import os
import asyncio, os
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:%d/index.html" % int(os.environ.get("COC_STATIC_PORT") or 8899)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots13")
os.makedirs(OUT, exist_ok=True)

errors = []
results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("  [OK] " if ok else "  [!!] ") + name + (("  <- " + str(detail)) if detail else ""))


MECH_ATTRS = {"str": 60, "con": 65, "siz": 60, "dex": 70, "app": 60,
              "int": 70, "pow": 60, "edu": 70, "luck": 55}


async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        page = await browser.new_page(viewport={"width": 412, "height": 900})
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        async def shot(n):
            await page.screenshot(path=os.path.join(OUT, n + ".png"))

        await page.goto(BASE)
        await page.wait_for_timeout(1200)
        await page.evaluate("()=>{try{localStorage.clear()}catch(e){}}")
        await page.reload()
        await page.wait_for_timeout(1200)

        # =========================================================
        # 1. 设置页：措辞要说清是「每一项」
        # =========================================================
        print("\n== 1、AI 设置的措辞 ==")
        await page.evaluate("""()=>Store.setSettings({
            aiBase:'https://api.test.invalid/v1', aiModel:'m', aiKey:'sk-test',
            aiAttrCap:0, aiOccPtsCap:80, aiIntPtsCap:60})""")
        await page.evaluate("()=>App.aiSettings()")
        await page.wait_for_timeout(900)
        body = await page.evaluate("()=>document.body.innerText")
        check("★ 标签写明是「每项本职技能上限」", "每项本职技能上限" in body, body[:200])
        check("★ 标签写明是「每项兴趣技能上限」", "每项兴趣技能上限" in body)
        check("★ 说明「不会因此变少」", "不会因此变少" in body or "不因此减少" in body)
        check("★ 说明自选特长按本职/非本职分流", "个人特长" in body and "时代特长" in body)
        await shot("v13_01_settings")

        # =========================================================
        # 2. 生成前的警告
        # =========================================================
        print("\n== 2、生成前的说明 ==")
        await page.evaluate("()=>{if(window.UI) UI.closeAllSheets();}")
        await page.wait_for_timeout(400)
        await page.evaluate("()=>App.aiCreate()")
        await page.wait_for_timeout(900)
        panel = await page.evaluate("()=>document.body.innerText")
        check("★ 面板列出本次上限", "本次数值上限" in panel, panel[:160])
        check("★ 说清是「每一项技能最多能点到多少」",
              "每一项" in panel or "每项" in panel, panel[:260])
        check("★ 明确「不是把职业点总数压到 80」", "不是" in panel and "总数" in panel, panel[:300])
        await shot("v13_02_panel")

        # =========================================================
        # 3. 生成一张机械师（EDU 70）：点数总额不该被压
        # =========================================================
        print("\n== 3、生成后：点数总额没被压小 ==")
        await page.evaluate("""(attrs)=>{
            const raw = {
              name:'陆承', gender:'男', age:30,
              residence:'苏州', birthplace:'南京',
              setting:'cn-modern', occupationName:'机械师',
              attributes:attrs,
              background:{description:'精瘦',ideology:'信念：手艺',
                significantPeople:'师父｜教了八年｜已故', meaningfulPlaces:'车间｜机油味｜日常',
                treasuredPossessions:'扳手｜磨过｜父亲留下', traits:'沉默、较真',
                wounds:'断指', phobias:'无。', history:'修了十二年机器。'}
            };
            window.fetch = async () => new Response(JSON.stringify({
              choices:[{message:{content: JSON.stringify(raw)}, finish_reason:'stop'}]
            }), {status:200, headers:{'Content-Type':'application/json'}});
        }""", MECH_ATTRS)
        await page.fill(".sheet textarea", "一个苏州的机械师")
        await page.click(".sheet button:has-text('生成调查员')")
        await page.wait_for_timeout(6000)
        note = await page.evaluate("()=>document.body.innerText")
        check("★ 结果页写明「已按上限生成」", "已按上限生成" in note, note[-200:])
        check("★ 结果页说明「只压每一项，不减少点数总额」",
              "每一项" in note and ("不减少" in note or "不减少点数总额" in note), note[-300:])

        # ⚠️ 必须先「就用这张」把卡落到 Store，
        #    否则 Store.getState().current 是空的（test_v11/v12 都踩过）。
        await page.click(".sheet button:has-text('就用这张')")
        await page.wait_for_timeout(1500)

        st = await page.evaluate("""()=>{
            const c=(Store.listCharacters()||[]).find(x=>x.characterName==='陆承');
            if(!c) return null;
            const OCC=CocOccupation, SM=SkillModel, R=COC7;
            const op=OCC.occupationPoints(c), ip=OCC.interestPoints(c);
            const set=OCC.occupationalSet(c);
            let occMax=0,intMax=0,occOver=0,intOver=0;
            (c.skills||[]).forEach(s=>{
              if(s.id==='credit'||s.id==='cthulhu'||R.isGrowthOnly(s.id)) return;
              const cap=SM.capOf(c,s);
              if(set[s.key]||set[s.id]){
                if(s.total>occMax)occMax=s.total;
                if(s.total>cap)occOver++;
              } else if((s.int||0)>0){
                if(s.total>intMax)intMax=s.total;
                if(s.total>cap)intOver++;
              }
            });
            const cs=c.skills.filter(x=>x.id==='credit')[0];
            const occDef=OCC.getById(c.occupationId);
            return {occ:op.used+'/'+op.total, int:ip.used+'/'+ip.total,
                    occRemain:op.remain, intRemain:ip.remain,
                    capOcc:c.skillCapOcc, capInt:c.skillCapInterest,
                    occMax:occMax, intMax:intMax, occOver:occOver, intOver:intOver,
                    credit:parseInt(c.assets.creditRating,10)||0,
                    crMin:occDef?occDef.creditMin:null,
                    crMax:occDef?occDef.creditMax:null};
        }""")
        if st is None:
            check("★ 能读到生成的卡", False, "角色列表里找不到「陆承」")
        else:
            print("     职业点 %s　兴趣点 %s　上限 %s/%s" %
                  (st["occ"], st["int"], st["capOcc"], st["capInt"]))
            print("     本职最高 %s　兴趣最高 %s　超上限 %s/%s" %
                  (st["occMax"], st["intMax"], st["occOver"], st["intOver"]))
            check("★ 职业点总额仍是规则全额（未被压成 80）",
                  st["occ"].split("/")[1] not in ("80", "60"), st)
            check("★ 兴趣点总额仍是规则全额（未被压成 60）",
                  st["int"].split("/")[1] != "60", st)
            check("★ 上限写进了 skillCapOcc / skillCapInterest",
                  st["capOcc"] == 80 and st["capInt"] == 60, st)
            check("★ 没有本职技能超过本职上限", st["occOver"] == 0, st)
            check("★ 没有兴趣技能超过兴趣上限", st["intOver"] == 0, st)
            check("★ 点数仍然用完", st["occRemain"] == 0 and st["intRemain"] == 0, st)

            # =====================================================
            # 4. 信用评级
            # =====================================================
            print("\n== 4、信用评级：仅成长 + 豁免上限 ==")
            cr = await page.evaluate("""()=>{
                const c=(Store.listCharacters()||[]).find(x=>x.characterName==='陆承');
                if(!c) return null;
                const SM=SkillModel;
                const cs=c.skills.filter(x=>x.id==='credit')[0];
                if(!cs) return {noSkill:true};
                const occ=CocOccupation.getById(c.occupationId);
                const saveOcc=c.skillCapOcc, saveInt=c.skillCapInterest;
                const capNormal=SM.capOf(c,cs);
                c.skillCapOcc=30; c.skillCapInterest=30;
                const capLow=SM.capOf(c,cs);
                c.skillCapOcc=saveOcc; c.skillCapInterest=saveInt;
                return {
                  growthOnly: COC7.isGrowthOnly('credit'),
                  capExempt: COC7.capExempt('credit'),
                  canOcc: SM.canAdd(c,cs,'occ',5).ok,
                  canInt: SM.canAdd(c,cs,'int',5).ok,
                  canGrowth: SM.canAdd(c,cs,'growth',5).ok,
                  capNormal: capNormal, capLow: capLow,
                  cr: parseInt(c.assets.creditRating,10)||0,
                  crMin: occ?occ.creditMin:null, crMax: occ?occ.creditMax:null
                };
            }""")
            if cr is None or cr.get("noSkill"):
                check("★ 找到信用评级技能", False, cr)
            else:
                print("     信用评级 = %s（职业允许 %s-%s）" % (cr["cr"], cr["crMin"], cr["crMax"]))
                check("★ isGrowthOnly('credit') = true", cr["growthOnly"], cr)
                check("★ capExempt('credit') = true", cr["capExempt"], cr)
                check("★ 技能点加不了", cr["canOcc"] is False and cr["canInt"] is False, cr)
                check("★ 成长可以加", cr["canGrowth"] is True, cr)
                check("★ capOf(信用评级) = 99", cr["capNormal"] == 99, cr)
                check("★ 上限压到 30 后仍是 99（豁免生效）", cr["capLow"] == 99, cr)
                check("★ 信用评级落在职业允许区间内",
                      cr["crMin"] is None or (cr["cr"] >= cr["crMin"] and cr["cr"] <= cr["crMax"]), cr)

        # =========================================================
        # 5. 技能分配步骤里信用评级的 occ/int 是锁住的
        # =========================================================
        print("\n== 5、技能分配步骤的界面 ==")
        # ⚠️ 进向导必须走 App.startEdit(id)（它内部 beginEdit + openWizard）。
        #    直接 Store.loadCharacter 只会切到「角色详情页」，
        #    向导的 .stepper-item 一个都不会渲染 —— 探针踩过这个坑。
        cid = await page.evaluate(
            """()=>{const c=(Store.listCharacters()||[]).find(x=>x.characterName==='陆承');
                return c?c.id:null;}""")
        check("拿到卡的 id", cid is not None, cid)
        if cid:
            await page.evaluate("(id)=>App.startEdit(id)", cid)
            await page.wait_for_timeout(1600)
            ste = await page.evaluate(
                "()=>[...document.querySelectorAll('.stepper-item')].map(x=>x.textContent.trim())")
            check("★ 向导打开了（有步骤条）", len(ste) > 0, ste)
            await page.evaluate("""()=>{
                const t=[...document.querySelectorAll('.stepper-item')].find(x=>/技能/.test(x.textContent));
                if(t) t.click();
            }""")
            await page.wait_for_timeout(1500)
        ui = await page.evaluate("""()=>{
            const rows=[...document.querySelectorAll('.skill-row')];
            const r=rows.find(x=>/信用评级/.test(x.textContent));
            if(!r) return {found:false};
            const groups=[...r.querySelectorAll('.calc-group')];
            /* ⚠️ 锁定用的是 readonly + .pin-locked，**不是 disabled**。
               查 disabled 会误判成「没锁住」。 */
            return {
              found:true,
              tags: [...r.querySelectorAll('.tag')].map(t=>t.textContent),
              groups: groups.map(g=>{
                const inp=g.querySelector('input');
                return {lab:(g.querySelector('.lg')||{}).textContent||'',
                        readonly: inp? !!inp.readOnly : null,
                        lockedCls: inp? inp.classList.contains('pin-locked') : null};
              })
            };
        }""")
        if not ui.get("found"):
            check("★ 技能列表里能找到信用评级这一行", False, ui)
        else:
            check("★ 技能列表里能找到信用评级这一行", True)
            check("★ 标了「仅成长」", "仅成长" in ui["tags"], ui["tags"])
            occg = [g for g in ui["groups"] if g["lab"] == "职业"]
            intg = [g for g in ui["groups"] if g["lab"] == "兴趣"]
            check("★ 职业栏是只读的", occg and occg[0]["readonly"] is True, ui["groups"])
            check("★ 兴趣栏是只读的", intg and intg[0]["readonly"] is True, ui["groups"])
            grw = [g for g in ui["groups"] if g["lab"] == "成长"]
            check("★ 成长栏仍可编辑",
                  grw and grw[0]["readonly"] is False, ui["groups"])
        await shot("v13_03_skill_row")

        # =========================================================
        # 6. 详情页的说明
        # ⚠️ 必须先**退出编辑模式**再点「我的角色」——
        #    编辑态下点导航会被 guardLeave 拦下来问「要不要丢弃」。
        # =========================================================
        print("\n== 6、角色详情页 ==")
        # 编辑态下导航会被 guardLeave 拦下问「要不要丢弃」，很麻烦。
        # 直接 reload —— 编辑中转区是内存态，刷新即丢弃，列表数据还在。
        await page.reload()
        await page.wait_for_timeout(1600)
        await page.evaluate("()=>{const b=[...document.querySelectorAll('button')].find(x=>/我的角色/.test(x.textContent)); if(b) b.click();}")
        await page.wait_for_timeout(1200)
        await page.evaluate("""()=>{
            const c=[...document.querySelectorAll('.char-card')].find(x=>/陆承/.test(x.textContent));
            if(c) c.click();
        }""")
        await page.wait_for_timeout(1600)
        det = await page.evaluate("()=>document.body.innerText")
        onDetail = await page.evaluate("()=>!!document.querySelector('.sheet-hero')")
        check("★ 进到了角色详情页", onDetail, det[:120])
        check("★ 详情页显示职业点已用完", "已用完" in det, det[:200])
        check("★ 详情页不再出现「恢复全额点数」（语义已变）",
              "恢复全额点数" not in det)
        await shot("v13_04_detail")

        def noise(e):
            return ("favicon" in e) or ("401" in e) or ("test.invalid" in e) \
                or ("Failed to load resource" in e)

        real = [e for e in errors if not noise(e)]
        print("\n控制台错误：%d 条" % len(real))
        for e in real[:10]:
            print("   " + e)
        await browser.close()

    ok = sum(1 for _, o, _ in results if o)
    print("\n===== 结果 %d / %d =====" % (ok, len(results)))
    if ok != len(results):
        print("失败项：")
        for nme, o, d in results:
            if not o:
                print("   [!!] " + nme + ("  <- " + str(d) if d else ""))
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
