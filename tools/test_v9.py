# -*- coding: utf-8 -*-
"""第七批：三个严重 bug 的回归验证
  1. AI 测试连接：Cannot set request property after connection is made
     这是原生 HTTP 层的 bug（Accept 头设在 getOutputStream 之后）。
     浏览器里测不到原生代码，所以这里做两件事：
       a) 断言源码里 Accept 一定在 getOutputStream 之前（静态检查）
       b) 断言 explainRequestError 能把这个异常翻译成「应用自身缺陷」而非「检查 Key」
  2. 属性步骤：检定后改教育值，检定结果应变为失效并可重掷
  3. 职业步骤：任选 X 项不能重复选、不能与已有职业技能重复
"""
import os
import asyncio, json, os, re
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:%d/index.html" % int(os.environ.get("COC_STATIC_PORT") or 8899)
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots9")
os.makedirs(OUT, exist_ok=True)

errors = []
results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("  [OK] " if ok else "  [!!] ") + name + (("  <- " + str(detail)) if detail else ""))


async def main():
    # =========================================================
    # 1. 原生 HTTP 层：静态检查（这段代码浏览器跑不到）
    # =========================================================
    print("\n== 1、AI 测试连接 · 原生请求头顺序 ==")
    java = open(os.path.join(ROOT, "android/app/src/main/java/com/teaegg/coc7card/MainActivity.java"),
                encoding="utf-8").read()

    # 精确定位 http() 方法体：从方法签名开始，到它自己的收尾大括号（缩进 4 空格）
    sig = java.find("private static String http(String method")
    check("找到原生 http() 方法", sig >= 0)
    end = java.find("\n    }\n", sig)          # 该方法的收尾
    body = java[sig:end] if (sig >= 0 and end > sig) else ""
    check("截取到 http() 方法体", len(body) > 200, "长度 %d" % len(body))

    # 注释里的示例不参与比较，先剥掉
    code = re.sub(r"/\*.*?\*/", "", body, flags=re.S)

    i_accept = code.find('setRequestProperty("Accept"')
    i_stream = code.find("getOutputStream()")
    check("代码里有 Accept 请求头", i_accept >= 0)
    check("代码里有 getOutputStream()", i_stream >= 0)
    check("★ Accept 设置在 getOutputStream 之前（否则抛 Cannot set request property）",
          i_accept >= 0 and i_stream >= 0 and i_accept < i_stream,
          "Accept@%d, getOutputStream@%d" % (i_accept, i_stream))

    # getOutputStream 之后不能再有任何 setRequestProperty
    after = [mm.start() for mm in re.finditer(r"setRequestProperty", code) if mm.start() > i_stream]
    check("★ getOutputStream 之后不再有任何 setRequestProperty", len(after) == 0,
          "发现 %d 处" % len(after))

    # =========================================================
    # 浏览器部分
    # =========================================================
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 412, "height": 900},
                                        device_scale_factor=2)
        page = await ctx.new_page()
        page.on("console", lambda mm: errors.append("[%s] %s" % (mm.type, mm.text)) if mm.type == "error" else None)
        page.on("pageerror", lambda e: errors.append("[pageerror] %s" % e))

        async def shot(n):
            await page.screenshot(path=os.path.join(OUT, n + ".png"), full_page=True)

        async def txt(sel="body"):
            return await page.evaluate("(s)=>((document.querySelector(s)||{}).textContent||'')", sel)

        async def close_sheets():
            await page.evaluate("()=>{while(document.querySelector('.sheet-mask')){UI.closeTopSheet();}}")
            await page.wait_for_timeout(250)

        await page.goto(BASE, wait_until="domcontentloaded")
        await page.wait_for_timeout(900)

        # ---------- 1b. 错误翻译 ----------
        print("\n== 1b、连接异常的错误翻译 ==")
        # 注入一个「原生桥回传 Java 异常」的假场景，验证文案翻译
        tr = await page.evaluate("""async()=>{
            const orig = window.fetch;
            // 让 fetch 抛一个带 Java 异常文案的错误，模拟原生桥回传失败
            window.fetch = ()=>Promise.reject(new Error(
                'Request failed: java.lang.IllegalStateException: ' +
                'Cannot set request property after connection is made'));
            Store.setSettings({aiBase:'https://api.deepseek.com/v1',
                               aiModel:'deepseek-flash', aiKey:'sk-test'});
            let out='';
            try { await window.AIClient.test(); out='RESOLVED'; }
            catch(e){ out = e.message; }
            window.fetch = orig;
            return out;
        }""")
        check("★ 那个 Java 异常不再原样弹给用户",
              "Cannot set request property" not in str(tr), str(tr)[:130])
        check("★ 明确告知是应用自身缺陷、不是 Key 的问题",
              ("缺陷" in str(tr) or "自身" in str(tr)) and ("Key" in str(tr) or "升级" in str(tr)),
              str(tr)[:160])

        # 其他几类原生异常也要有可读文案
        others = await page.evaluate("""async()=>{
            const orig = window.fetch;
            const samples = [
              'java.net.UnknownHostException: api.deepseek.com',
              'java.net.SSLHandshakeException: certificate verify failed',
              'Cleartext HTTP traffic to api.deepseek.com not permitted'
            ];
            const out=[];
            for(const s of samples){
              window.fetch = ()=>Promise.reject(new Error('Request failed: '+s));
              try { await window.AIClient.test(); out.push(s+' => RESOLVED'); }
              catch(e){ out.push(s+' => '+e.message); }
            }
            window.fetch = orig;
            return out;
        }""")
        check("域名解析失败有专门提示",
              any("域名解析" in o for o in others), others[0] if others else "")
        check("明文流量被拦有专门提示",
              any("http://" in o or "https" in o for o in others), others[2] if len(others) > 2 else "")

        await page.evaluate("""()=>{
            Store.setSettings({aiBase:'https://api.deepseek.com/v1', aiModel:'deepseek-flash', aiKey:''});
        }""")

        # ---------- 2. 教育进步检定随属性变化 ----------
        print("\n== 2、教育进步检定 · 改了教育值就应失效 ==")
        await page.evaluate("()=>{App.newCharacter();}")
        await page.wait_for_timeout(700)

        # 进属性步骤，年龄设 70（有 4 次检定）
        await page.evaluate("""()=>{
            const c=Store.getState().current;
            c.basicInfo.age=70; c.age=70;
            Object.assign(c.attributes,{str:70,con:70,siz:65,dex:70,app:70,int:75,pow:70,edu:60,luck:55});
            Engine.recalc(c);
            const t=[...document.querySelectorAll('.stepper-item')].find(x=>/属性/.test(x.textContent));
            if(t) t.click();
        }""")
        await page.wait_for_timeout(900)

        edu_txt = await txt("#eduCard")
        check("教育进步检定卡片存在", "教育进步检定" in edu_txt, edu_txt[:80])
        need = await page.evaluate("()=>COC7.ageProgressChecks(70)")
        check("70 岁需要 " + str(need) + " 次检定", need > 0, need)

        # 一键完成
        await page.evaluate("""()=>{
            const b=[...document.querySelectorAll('#eduCard button')].find(x=>/一键完成|掷一次检定/.test(x.textContent));
            if(b) b.click();
        }""")
        await page.wait_for_timeout(700)
        # 补足剩余次数
        for _ in range(6):
            st = await page.evaluate("""()=>{
                const c=Store.getState().current;
                return {done:(c.eduProgress.log||[]).length, need:COC7.ageProgressChecks(70),
                        baseEdu:c.eduProgress.baseEdu, edu:c.attributes.edu};
            }""")
            if st["done"] >= st["need"]:
                break
            await page.evaluate("""()=>{
                const b=[...document.querySelectorAll('#eduCard button')].find(x=>/掷一次检定|一键完成/.test(x.textContent));
                if(b) b.click();
            }""")
            await page.wait_for_timeout(400)

        before = await page.evaluate("""()=>{
            const c=Store.getState().current;
            return {log:(c.eduProgress.log||[]).length, bonus:c.eduProgress.bonus,
                    baseEdu:c.eduProgress.baseEdu, edu:c.attributes.edu,
                    effEdu:Engine.effAttrs(c).edu};
        }""")
        check("检定已完成", before["log"] >= need, before)
        check("记录了检定时的教育基准", before["baseEdu"] == before["edu"],
              "baseEdu=%s, edu=%s" % (before["baseEdu"], before["edu"]))

        # ★ 关键：改教育值
        await page.evaluate("""()=>{
            const c=Store.getState().current;
            c.attributes.edu = 85;
            Engine.recalc(c);
            const t=[...document.querySelectorAll('.stepper-item')].find(x=>/属性/.test(x.textContent));
            if(t) t.click();
        }""")
        await page.wait_for_timeout(800)

        after = await page.evaluate("""()=>{
            const c=Store.getState().current;
            return {edu:c.attributes.edu, baseEdu:c.eduProgress.baseEdu,
                    log:(c.eduProgress.log||[]).length, bonus:c.eduProgress.bonus,
                    effEdu:Engine.effAttrs(c).edu};
        }""")
        check("★ 教育值已改为 85", after["edu"] == 85, after)
        # ⚠️ v1.7.1 之后行为变了：旧检定被**彻底清空**（不只是标成「已失效」）。
        # 起因是上一版只改面板不改数据，eduProgress.bonus 仍在，
        # Engine.effAttrs() 里的 eduBonus 还是旧值 —— 生效教育被旧增益抬着，
        # 用户看到的就是「改了教育还是套用之前的检定结果」。
        await page.wait_for_timeout(600)   # 等 buildGrid 守卫跑完
        after = await page.evaluate("""()=>{
            const c=Store.getState().current;
            return {edu:c.attributes.edu, baseEdu:c.eduProgress.baseEdu,
                    log:(c.eduProgress.log||[]).length, bonus:c.eduProgress.bonus,
                    effEdu:Engine.effAttrs(c).edu};
        }""")
        check("★ 原始 EDU 已改为 85", after["edu"] == 85, after)
        check("★ 旧检定记录已清空（log 归零）",
              after["log"] == 0, after)
        check("★ 旧增益 bonus 已清零",
              after["bonus"] == 0, after)
        check("★ Engine 里的 eduBonus 也归零",
              after["effEdu"] == after["edu"],
              "生效 %s vs 原始 %s" % (after["effEdu"], after["edu"]))
        edu2 = await txt("#eduCard")
        check("★ 面板说明「教育值改动过，检定已清空」",
              "清空" in edu2, edu2[:200])
        check("★ 提示里给出了旧基准 EDU（应显示 60 而不是 85）",
              "60" in edu2, edu2[:240])
        check("★ 仍可正常掷一次检定",
              "掷一次检定" in edu2, edu2[:100])
        await shot("v9_01_edu_cleared")

        # 点重掷
        await page.evaluate("""()=>{
            const b=[...document.querySelectorAll('#eduCard button')].find(x=>/重掷/.test(x.textContent));
            if(b) b.click();
        }""")
        await page.wait_for_timeout(800)
        fixed = await page.evaluate("""()=>{
            const c=Store.getState().current;
            return {baseEdu:c.eduProgress.baseEdu, edu:c.attributes.edu,
                    log:(c.eduProgress.log||[]).length, bonus:c.eduProgress.bonus};
        }""")
        check("★ 重掷后基准更新为新的教育值", fixed["baseEdu"] == 85, fixed)
        edu3 = await txt("#eduCard")
        check("重掷后不再显示「已失效」", "已失效" not in edu3 and "作废" not in edu3, edu3[:150])

        # 反复改教育值：每次旧检定都应被清空，且生效教育 == 原始教育
        for edu_val in (70, 90, 55):
            await page.evaluate("""(v)=>{
                const c=Store.getState().current;
                c.eduProgress.log=[{n:1,roll:99,before:c.eduProgress.baseEdu,gain:5,after:c.eduProgress.baseEdu+5}];
                c.eduProgress.bonus=5; c.eduProgress.baseEdu=c.attributes.edu;
                Engine.recalc(c);
                const t=[...document.querySelectorAll('.stepper-item')].find(x=>/属性/.test(x.textContent));
                if(t) t.click();
            }""", edu_val)
            await page.wait_for_timeout(300)
            await page.evaluate("""(v)=>{
                const c=Store.getState().current;
                c.attributes.edu=v; Engine.recalc(c);
                const t=[...document.querySelectorAll('.stepper-item')].find(x=>/属性/.test(x.textContent));
                if(t) t.click();
            }""", edu_val)
            await page.wait_for_timeout(500)
            st = await page.evaluate("""()=>{
                const c=Store.getState().current;
                return {log:(c.eduProgress.log||[]).length, bonus:c.eduProgress.bonus,
                        eff:Engine.effAttrs(c).edu, edu:c.attributes.edu};
            }""")
            check("教育改为 %d 时旧检定被清空且生效教育跟随" % edu_val,
                  st["log"] == 0 and st["bonus"] == 0 and st["eff"] == st["edu"], st)

        await shot("v9_02_edu_done")

        # ---------- 3. 任选 X 项去重 ----------
        print("\n== 3、职业任选 X 项 · 不能重复选 ==")
        await page.evaluate("""()=>{
            const c=Store.getState().current;
            // occ215「业余艺术爱好者」= 任意六项个人或时代特长（free 型，最适合验证）
            c.occupationId='occ215';
            c.basicInfo.occupationName='业余艺术爱好者';
            c.skills=[]; c.occupationPicks={};
            window.SkillModel.syncSkills(c);
            Engine.recalc(c);
        }""")
        await page.wait_for_timeout(400)
        await page.evaluate("""()=>{
            const t=[...document.querySelectorAll('.stepper-item')].find(x=>/职业/.test(x.textContent));
            if(t) t.click();
        }""")
        await page.wait_for_timeout(900)

        occ_txt = await txt("body")
        check("进入职业步骤", "业余艺术爱好者" in occ_txt or "任选" in occ_txt, occ_txt[:120])

        reqs = await page.evaluate("""()=>{
            const c=Store.getState().current;
            return window.CocOccupation.getRequirements(c).map(r=>({id:r.id,type:r.type,count:r.count,label:r.label}));
        }""")
        frees = [r for r in reqs if r["type"] == "free"]
        check("该职业有「任选 N 项」的要求", len(frees) >= 1, reqs)
        fr = frees[0]
        check("任选数量为 %s" % fr["count"], fr["count"] == 6, fr)

        # 打开选择器
        await page.evaluate("""()=>{
            const b=[...document.querySelectorAll('button')].find(x=>/指定技能/.test(x.textContent));
            if(b) b.click();
        }""")
        await page.wait_for_timeout(700)
        check("选择器已打开", await page.evaluate("()=>!!document.querySelector('.sheet-mask')"))

        # 选第一个技能
        first = await page.evaluate("""()=>{
            const b=[...document.querySelectorAll('.sheet-mask .occ-item')].find(x=>x.textContent.trim());
            if(!b) return null;
            const nm=b.querySelector('.nm');
            nm&&b.click();
            return nm?nm.textContent.trim():null;
        }""")
        check("选中了第一个技能：%s" % first, first is not None)
        await page.wait_for_timeout(700)

        # 再打开，选刚才那个 —— 应该已经不在列表里
        await page.evaluate("""()=>{
            const b=[...document.querySelectorAll('button')].find(x=>/指定技能/.test(x.textContent));
            if(b) b.click();
        }""")
        await page.wait_for_timeout(700)
        again = await page.evaluate("""(firstName)=>{
            const items=[...document.querySelectorAll('.sheet-mask .occ-item')];
            const hit=items.find(x=>x.textContent.trim().indexOf(firstName)===0);
            return {total:items.length, stillThere:!!hit};
        }""", first or "")
        check("★ 已选的技能从候选列表里消失了",
              again["stillThere"] is False, again)

        # 继续选满 6 个（每次都应该不重复）
        picked = await page.evaluate("""()=>{
            const c=Store.getState().current;
            return (c.occupationPicks[Object.keys(c.occupationPicks||{})[0]]||[]).map(p=>p.name);
        }""")
        for _ in range(10):
            await page.evaluate("""()=>{
                const b=[...document.querySelectorAll('button')].find(x=>/指定技能/.test(x.textContent));
                if(b) b.click();
            }""")
            await page.wait_for_timeout(500)
            await page.evaluate("""()=>{
                const b=[...document.querySelectorAll('.sheet-mask .occ-item')].find(x=>x.textContent.trim());
                if(b) b.click();
            }""")
            await page.wait_for_timeout(500)
            st = await page.evaluate("""()=>{
                const c=Store.getState().current;
                const arr=(c.occupationPicks[Object.keys(c.occupationPicks||{})[0]]||[]);
                return {n:arr.length, names:arr.map(p=>p.name)};
            }""")
            if st["n"] >= 6:
                break
        await close_sheets()
        await page.wait_for_timeout(400)

        final = await page.evaluate("""()=>{
            const c=Store.getState().current;
            const rid=Object.keys(c.occupationPicks||{})[0];
            const arr=c.occupationPicks[rid]||[];
            return {n:arr.length, names:arr.map(p=>p.name),
                    keys:arr.map(p=>p.skill+'|'+(p.sub||''))};
        }""")
        check("选满了 " + str(final["n"]) + " 项", final["n"] == 6, final["names"])
        uniq = len(set(final["keys"]))
        check("★ 没有重复项（%d 项 / %d 个唯一 key）" % (final["n"], uniq),
              uniq == final["n"], final["keys"])
        await shot("v9_03_free_picks")

        # 校验器应无「重复」类错误
        errs = await page.evaluate("""()=>{
            const c=Store.getState().current;
            return window.COC7.validators.occupationChoices(c, window.CocOccupation).map(e=>e.text);
        }""")
        dup_errs = [e for e in errs if "重复" in e]
        check("★ 完整性校验没有报重复", len(dup_errs) == 0, errs)

        # ---------- 3b. 与本职技能冲突 ----------
        print("\n== 3b、任选项不能与本职技能重复 ==")
        # ⚠️ 必须挑「确实有 free 型要求」的职业，并**用实际的块 id**。
        # occ158 暴走族的块是 r0-r4 fixed + r5 free（不是 r1），而且它没有 choice 型要求；
        # occ215 是纯 free 职业（r0 free × 6）。
        # 前两版分别踩了「块类型选错（拿 occ2 的 choice 当 free）」和
        # 「块 id 写错（把 r1 当 free）」这两个坑 —— 断言看似失败、实则根本没测到东西。
        conflict2 = await page.evaluate("""()=>{
            function run(occId, picks){
              const c=Store.newCharacter('coc7');
              c.occupationId=occId;
              Object.assign(c.attributes,{str:70,con:70,siz:65,dex:70,app:70,int:75,pow:70,edu:70,luck:55});
              c.occupationPicks=JSON.parse(JSON.stringify(picks));
              Engine.recalc(c);
              const reqs = window.CocOccupation.getRequirements(c);
              return {
                hasFree: reqs.some(r=>r.type==='free'),
                freeIds: reqs.filter(r=>r.type==='free').map(r=>r.id),
                errs: window.COC7.validators.occupationChoices(c, window.CocOccupation).map(e=>e.text)
              };
            }
            return {
              // occ158 的 r5（free）里选了固定本职「格斗（斗殴）」→ 应报冲突
              sameOcc: run('occ158', {r5:[{skill:'fighting',sub:'斗殴',name:'格斗（斗殴）'}]}),
              // r5 内同块重复
              dupInBlock: run('occ158', {r5:[{skill:'swim',sub:'',name:'游泳'},{skill:'swim',sub:'',name:'游泳'}]}),
              // 跨 free 块重复：用 occ106（实测有两个 free 块），
              // 块 id 由引擎解析给出，不自己编
              dupAcross: run('occ106', (function(){
                const f=window.CocOccupation.getRequirements({occupationId:'occ106'})
                          .filter(r=>r.type==='free');
                const o={}; o[f[0].id]=[{skill:'swim',sub:'',name:'游泳'}];
                o[f[1].id]=[{skill:'swim',sub:'',name:'游泳'}];
                return o;
              })())
            };
        }""")
        check("★ 与本职技能重复会被校验出来",
              any("本职技能" in t for t in conflict2["sameOcc"]["errs"]), conflict2["sameOcc"]["errs"])
        check("★ 同一块内重复会被校验出来",
              any("重复" in t for t in conflict2["dupInBlock"]["errs"]), conflict2["dupInBlock"]["errs"])
        check("★ 跨块重复（free 块选到其它块已占用的技能）也会被校验出来",
              any("重复" in t for t in conflict2["dupAcross"]["errs"]), conflict2["dupAcross"]["errs"])

        # 反向断言：choice 块单独选一个技能**不该**报重复。
        # duplicatePicks 只在 free 块之间查重，且不与 fixed 冲突 —— 这条边界是踩过坑才定下来的：
        # 不分类型会把 12/29 张彩蛋卡判成不合格。
        no_false = await page.evaluate("""()=>{
            const c=Store.newCharacter('coc7');
            c.occupationId='occ2';
            Object.assign(c.attributes,{str:70,con:70,siz:65,dex:70,app:70,int:75,pow:70,edu:70,luck:55});
            c.occupationPicks={r6:[{skill:'swim',sub:'',name:'游泳'}]};
            Engine.recalc(c);
            return window.COC7.validators.occupationChoices(c, window.CocOccupation).map(e=>e.text);
        }""")
        check("★ 不误报：free 块只选一个技能不算重复",
              not any("重复" in t for t in no_false), no_false)

        # ---------- 3c. 删除特长后技能表不残留 ----------
        print("\n== 3c、删除任选项后技能表不残留 ==")
        residue = await page.evaluate("""()=>{
            const c=Store.getState().current;
            c.occupationId='occ215';
            c.skills=[]; c.occupationPicks={};
            window.SkillModel.syncSkills(c);
            // 选一个组技能专攻
            c.occupationPicks['r0']=[{skill:'fighting', sub:'擒拿', name:'格斗（擒拿）'}];
            window.SkillModel.addSubSkill(c,'fighting','擒拿');
            const key=window.SkillModel.keyOf('fighting','擒拿');
            const had=!!window.SkillModel.find(c,key);
            // 模拟界面上的删除动作
            const arr=c.occupationPicks['r0'];
            arr.splice(0,1);
            let stillUsed=false;
            Object.keys(c.occupationPicks||{}).forEach(rid=>{
                (c.occupationPicks[rid]||[]).forEach(q=>{
                    if(q.skill==='fighting' && q.sub==='擒拿') stillUsed=true;
                });
            });
            if(!stillUsed) window.SkillModel.removeSkill(c, key);
            const now=!!window.SkillModel.find(c,key);
            return {had:had, after:now, key:key};
        }""")
        check("删除前技能表里有这条", residue["had"] is True, residue)
        check("★ 删除后技能表里不再残留", residue["after"] is False, residue)

        # =========================================================
        # 收尾
        # =========================================================
        real_errors = [e for e in errors if "favicon" not in e]
        print("\n控制台错误：%d 条" % len(real_errors))
        for e in real_errors[:10]:
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
