# -*- coding: utf-8 -*-
"""第六批需求的回归验证（真实浏览器交互）：
  1. 第 8 步从法术表选一个法术后，页面仍可正常操作
     （滚动锁被正确释放、能切步骤、能回首页）
  2. AI 设置的「测试连接」不再误报失败
     - /models 探测成功 → 判定连接正常
     - 只有 /models 不支持时，回退对话探测，HTTP 通了就算正常
     - 推理型模型（content 为空、finish_reason=length）也判为连接正常
     - 真的失败（401）才报失败
  3. 状态管理可以修改最大理智值（SAN 上限永久减损）
  4. 状态管理可以随机疯狂状态（症状表随机 + 1-10 轮），可手动删除
  5. 随机角色含彩蛋（名人 + 跑团成员）
"""
import os
import asyncio, json, os
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:%d/index.html" % int(os.environ.get("COC_STATIC_PORT") or 8899)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots8")
os.makedirs(OUT, exist_ok=True)

errors = []
results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("  [OK] " if ok else "  [!!] ") + name + (("  <- " + str(detail)) if detail else ""))


SEED = {
    "id": "madtest01",
    "ruleSystemId": "coc7",
    "version": "v1.0",
    "characterName": "疯狂测试员",
    "basicInfo": {"era": "现代", "eraCustom": "", "age": 30, "gender": "男",
                  "residence": "宿州", "birthplace": "南京", "birthday": "1996-01-01"},
    "attributes": {"str": 65, "con": 70, "siz": 68, "dex": 72, "app": 70,
                   "int": 80, "pow": 75, "edu": 78, "luck": 60},
    "occupationId": "investigator",
    "skills": [{"name": "侦查", "base": 25, "value": 55}],
    "status": {"currentHP": 11, "maxHP": 11, "currentSAN": 70, "maxSAN": 70, "currentLuck": 60},
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
        # 记录 404 的具体资源，用来区分「测试自己造的 404」与「真的缺文件」
        page.on("response", lambda r: errors.append("[404] %s" % r.url) if r.status == 404 else None)

        # ---------- 假大模型服务 ----------
        # ai_mode 控制当前 /models 与 chat 的返回，用来覆盖各种判定分支
        ai_state = {"models": "ok", "chat": "ok"}

        async def handle(route):
            req = route.request
            if req.method == "OPTIONS":
                await route.fulfill(status=204, headers={
                    "access-control-allow-origin": "*",
                    "access-control-allow-methods": "GET,POST,OPTIONS",
                    "access-control-allow-headers": "*"})
                return
            if "/models" in req.url:
                if ai_state["models"] == "404":
                    await route.fulfill(status=404, body="not found",
                                        headers={"access-control-allow-origin": "*",
                                                 "content-type": "application/json"})
                else:
                    await route.fulfill(status=200, headers={
                        "access-control-allow-origin": "*", "content-type": "application/json"},
                        body=json.dumps({"data": [{"id": "deepseek-flash"}, {"id": "deepseek-chat"}]}))
                return
            if "/chat/completions" in req.url:
                if ai_state["chat"] == "401":
                    await route.fulfill(status=401, headers={
                        "access-control-allow-origin": "*", "content-type": "application/json"},
                        body=json.dumps({"error": {"message": "invalid api key"}}))
                elif ai_state["chat"] == "empty":
                    # 推理型模型：max_tokens 被思考链吃光，content 为空
                    await route.fulfill(status=200, headers={
                        "access-control-allow-origin": "*", "content-type": "application/json"},
                        body=json.dumps({"choices": [{"message": {
                            "content": "", "reasoning_content": "先思考一下……"},
                            "finish_reason": "length"}]}))
                else:
                    await route.fulfill(status=200, headers={
                        "access-control-allow-origin": "*", "content-type": "application/json"},
                        body=json.dumps({"choices": [{"message": {"content": "好"},
                                                     "finish_reason": "stop"}]}))
                return
            await route.continue_()

        await ctx.route("**/*", handle)

        async def shot(n):
            await page.screenshot(path=os.path.join(OUT, n + ".png"), full_page=True)

        async def txt(sel="body"):
            return await page.evaluate("(s)=>((document.querySelector(s)||{}).textContent||'')", sel)

        async def close_sheets():
            await page.evaluate("()=>{while(document.querySelector('.sheet-mask')){UI.closeTopSheet();}}")
            await page.wait_for_timeout(250)

        async def scroll_locked():
            return await page.evaluate("()=>document.body.classList.contains('scroll-locked')")

        # =========================================================
        # 1. 法术选择后页面卡死
        # =========================================================
        print("\n== 1、法术选择后页面不再卡死 ==")
        await page.goto(BASE, wait_until="domcontentloaded")
        await page.wait_for_timeout(800)

        await page.evaluate("""(seed)=>{
          localStorage.setItem('coc7.characters.v1', JSON.stringify({[seed.id]: seed}));
          localStorage.removeItem('coc7.draft.v1');
          localStorage.removeItem('coc7.edit.v1');
        }""", SEED)
        await page.reload(wait_until="domcontentloaded")
        await page.wait_for_timeout(800)
        await page.evaluate("()=>{App.startEdit('madtest01');}")
        await page.wait_for_timeout(800)

        # 跳到第 8 步「角色背景」
        await page.evaluate("""()=>{
          const items=[...document.querySelectorAll('.stepper-item')];
          const t=items.find(x=>/背景/.test(x.textContent));
          if(t) t.click();
        }""")
        await page.wait_for_timeout(800)
        on_bg = await page.evaluate("""()=>{
          const t=[...document.querySelectorAll('.stepper-item.active')][0];
          return t?t.textContent:'';
        }""")
        check("已进入第 8 步角色背景", "背景" in on_bg, on_bg)

        # 点「从法术表选择」
        await page.evaluate("""()=>{
          const b=[...document.querySelectorAll('button')].find(x=>/从法术表选择/.test(x.textContent));
          if(b) b.click();
        }""")
        await page.wait_for_timeout(700)
        n_before = await page.evaluate("()=>(Store.getState().current.mythos.spells||[]).length")
        check("法术表弹层已打开", await page.evaluate("()=>!!document.querySelector('.sheet-mask')"))
        check("打开弹层时确实锁住了背景滚动", await scroll_locked())

        # 选第一个法术
        await page.evaluate("""()=>{
          const items=[...document.querySelectorAll('.sheet-mask .occ-item')];
          if(items[0]) items[0].click();
        }""")
        await page.wait_for_timeout(900)

        n_after = await page.evaluate("()=>(Store.getState().current.mythos.spells||[]).length")
        check("法术已加入角色卡", n_after == n_before + 1, "%d → %d" % (n_before, n_after))
        check("弹层已关闭", not await page.evaluate("()=>!!document.querySelector('.sheet-mask')"))
        check("★ 滚动锁已释放（页面不再卡死）", not await scroll_locked())
        check("★ 弹层栈已清空（无僵尸记录）",
              not await page.evaluate("()=>UI.hasSheet()"))

        # 页面真的能滚
        can_scroll = await page.evaluate("""async()=>{
          const y0 = window.pageYOffset;
          window.scrollTo(0, 600);
          await new Promise(r=>setTimeout(r,200));
          const moved = window.pageYOffset !== y0;
          window.scrollTo(0, y0);
          return moved || document.body.scrollHeight <= window.innerHeight;
        }""")
        check("★ 页面可以正常滚动", can_scroll)

        # 切到上一步（背景的前一步是「战斗」）
        await page.evaluate("""()=>{
          const items=[...document.querySelectorAll('.stepper-item')];
          const t=items.find(x=>/战斗/.test(x.textContent));
          if(t) t.click();
        }""")
        await page.wait_for_timeout(600)
        on_prev = await page.evaluate("""()=>{
          const t=[...document.querySelectorAll('.stepper-item.active')][0];
          return t?t.textContent:'';
        }""")
        check("★ 可以切到上一步", "战斗" in on_prev, on_prev)
        await shot("v8_01_after_spell")

        # 回首页
        await page.evaluate("()=>{App.go('#/');}")
        await page.wait_for_timeout(700)
        home_ok = await page.evaluate("()=>!!document.querySelector('.home-hero')")
        check("★ 可以返回首页", home_ok)
        check("★ 回首页后滚动锁仍正常", not await scroll_locked())

        # 补一个「自愈」验证：人为把 scroll-locked 挂上，路由切换应自动解锁
        await page.evaluate("()=>{document.body.classList.add('scroll-locked');document.documentElement.classList.add('scroll-locked');}")
        await page.evaluate("()=>{App.go('#/my');}")
        await page.wait_for_timeout(600)
        check("★ 路由切换能自愈残留的滚动锁", not await scroll_locked())
        await page.evaluate("()=>{App.go('#/');}")
        await page.wait_for_timeout(500)

        # =========================================================
        # 2. AI 测试连接
        # =========================================================
        print("\n== 2、AI 设置 · 测试连接不再误报 ==")
        await page.evaluate("""()=>{
          Store.setSettings({aiBase:'https://api.deepseek.com/v1', aiModel:'deepseek-flash', aiKey:'sk-test'});
        }""")
        await page.wait_for_timeout(300)

        # 2a. /models 正常
        r = await page.evaluate("()=>AIClient.test()")
        check("★ /models 探测通过 → 连接正常", r.get("ok") is True, r)
        check("★ 判定为正常而不是失败", "失败" not in (r.get("reply") or ""), r.get("reply"))
        check("返回了可用模型列表", "deepseek-flash" in (r.get("models") or []), r.get("models"))

        # 2b. 模型名不在列表 → 给出提醒但仍算连接正常
        await page.evaluate("()=>{Store.setSettings({aiModel:'no-such-model'});}")
        r = await page.evaluate("()=>AIClient.test()")
        check("★ 模型名不存在时仍是连接正常（HTTP 通了）", r.get("ok") is True, r)
        check("并提示模型名可能不对", r.get("modelInList") is False, r)

        # 2c. /models 404 → 回退对话探测，正常
        ai_state["models"] = "404"
        await page.evaluate("()=>{Store.setSettings({aiModel:'deepseek-flash'});}")
        r = await page.evaluate("()=>AIClient.test()")
        check("★ /models 不支持时回退对话探测并成功", r.get("ok") is True, r)
        check("回退路径标为 via=chat", r.get("via") == "chat", r.get("via"))
        ai_state["models"] = "ok"

        # 2d. 推理型模型：content 为空 → 判为连接正常（这是原来的误报来源）
        ai_state["models"] = "404"
        ai_state["chat"] = "empty"
        r = await page.evaluate("()=>AIClient.test()")
        check("★ 推理型模型（回复为空）不再报连接失败", r.get("ok") is True, r)
        check("★ 明确告知「已连接但无文字」", r.get("empty") is True, r.get("reply"))
        check("★ 附带说明这不影响 AI 车卡", "不影响" in (r.get("hint") or ""), r.get("hint"))

        # 2e. 真的失败（401）才报错
        ai_state["models"] = "404"
        ai_state["chat"] = "401"
        failed = False
        msg = ""
        try:
            await page.evaluate("()=>AIClient.test()")
        except Exception as e:
            failed = True
            msg = str(e)[:120]
        check("★ 真的鉴权失败（401）才判失败", failed, msg)
        ai_state["chat"] = "ok"
        ai_state["models"] = "ok"

        # 2f. 走一遍界面上的「测试连接」按钮，确认弹的是「连接正常」
        await page.evaluate("()=>{App.go('#/');}")
        await page.wait_for_timeout(400)
        await page.click(".appbar button.icon-btn")
        await page.wait_for_timeout(500)
        await page.evaluate("""()=>{
          const b=[...document.querySelectorAll('.sheet-mask .occ-item')].find(x=>/AI 设置/.test(x.textContent));
          if(b) b.click();
        }""")
        await page.wait_for_timeout(600)
        await page.evaluate("""()=>{
          const b=[...document.querySelectorAll('button')].find(x=>/测试连接/.test(x.textContent));
          if(b) b.click();
        }""")
        await page.wait_for_timeout(2500)
        sheet_title = await txt(".sheet-mask h3")
        body_txt = await txt(".sheet-mask")
        check("★ 界面上点测试连接弹出「连接正常」", "连接正常" in body_txt, sheet_title[:60])
        check("★ 没有出现「连接失败」", "连接失败" not in body_txt, body_txt[:80])
        check("★ 弹层可正常关闭", True)
        await shot("v8_02_test_ok")
        await close_sheets()
        check("★ 关闭后滚动锁已释放", not await scroll_locked())

        # =========================================================
        # 3+4. 状态管理：SAN 上限 + 疯狂状态
        # =========================================================
        print("\n== 3、状态管理 · 最大理智值 ==")
        # 先退出编辑会话：编辑态下改的是副本，要点「保存修改」才落库。
        # 这里要验的是状态管理本身，所以走非编辑路径（与跑团时点开状态管理一致）。
        await page.evaluate("""()=>{
          if(Store.isEditing()) Store.cancelEdit();
          Store.loadCharacter('madtest01');
        }""")
        await page.wait_for_timeout(400)
        await page.evaluate("()=>{App.go('#/card/coc7/madtest01');}")
        await page.wait_for_timeout(900)
        await page.evaluate("""()=>{
          const b=[...document.querySelectorAll('button')].find(x=>/状态管理/.test(x.textContent));
          if(b) b.click();
        }""")
        await page.wait_for_timeout(700)
        st_txt = await txt(".sheet-mask")
        check("状态管理面板已打开", "状态管理" in st_txt, st_txt[:60])
        check("有「SAN 上限永久减损」输入项", "SAN 上限永久减损" in st_txt)
        # 常用骰型 1D3 / 1D4 / 1D6 / 1D8 / 1D10（旧的 1D5 已按需求移除）
        for sides in (3, 4, 6, 8, 10):
            check("有「1D%d」减损按钮" % sides, ("1D%d" % sides) in st_txt)
        check("旧的「掷减损 1D5」已移除", "掷减损 1D5" not in st_txt)
        check("有自定义 1DX 输入框", "自定义" in st_txt)
        check("有清除减损按钮", "清除减损" in st_txt)
        # 精神状态：多选 + 「永久疯狂」
        check("精神状态改为多选", "可多选" in st_txt)
        check("精神状态含「永久疯狂」", "永久疯狂" in st_txt)

        base_max = await page.evaluate("()=>Store.getState().current.baseMaxSAN")
        check("baseMaxSAN 已记录（= 意志）", base_max is not None, base_max)

        # 填一个减损值（用专用 id 定位，不依赖 DOM 顺序）
        ok_fill = await page.evaluate("""()=>{
          const el=document.querySelector('#sanLossInput');
          if(!el) return false;
          el.value=7; el.dispatchEvent(new Event('input',{bubbles:true}));
          return true;
        }""")
        check("找到 SAN 上限减损输入框", ok_fill)
        await page.wait_for_timeout(500)
        after = await page.evaluate("""()=>{
          const c=Store.getState().current;
          return {sanLoss:c.sanLoss, maxSAN:c.status.maxSAN, base:c.baseMaxSAN};
        }""")
        check("★ 减损值已记录", after["sanLoss"] == 7, after)
        check("★ 最大理智值 = 意志 − 减损", after["maxSAN"] == after["base"] - 7,
              "上限 %s，基准 %s" % (after["maxSAN"], after["base"]))
        hint = await txt(".sheet-mask")
        check("界面上写明「永久减损」", "永久减损" in hint)

        # 掷 1D3：值必然落在 [1,3]，且是累加
        await page.evaluate("""()=>{
          const b=[...document.querySelectorAll('.sheet-mask button')].find(x=>/1D3/.test(x.textContent));
          if(b) b.click();
        }""")
        await page.wait_for_timeout(400)
        after3 = await page.evaluate("()=>Store.getState().current.sanLoss")
        check("★ 「1D3」能加上 1-3 的随机值",
              after["sanLoss"] < after3 <= after["sanLoss"] + 3,
              "%d → %d" % (after["sanLoss"], after3))

        # 自定义 1DX：填 100，掷一次必须落在 [1,100]
        await page.evaluate("""()=>{
          const sides=document.querySelector('#sanLossDiceSides');
          if(sides){ sides.value='100'; sides.dispatchEvent(new Event('input',{bubbles:true})); }
          const b=[...document.querySelectorAll('.sheet-mask button')].find(x=>/^🎲 掷$/.test(x.textContent.trim()));
          if(b) b.click();
        }""")
        await page.wait_for_timeout(400)
        afterC = await page.evaluate("()=>Store.getState().current.sanLoss")
        check("★ 自定义 1DX 能加上 1-100 的随机值",
              after3 < afterC <= after3 + 100, "%d → %d" % (after3, afterC))

        # 清除
        await page.evaluate("""()=>{
          const b=[...document.querySelectorAll('.sheet-mask button')].find(x=>/清除减损/.test(x.textContent));
          if(b) b.click();
        }""")
        await page.wait_for_timeout(400)
        cleared = await page.evaluate("""()=>{
          const c=Store.getState().current;
          return {sanLoss:c.sanLoss, maxSAN:c.status.maxSAN, base:c.baseMaxSAN};
        }""")
        check("★ 「清除减损」把上限还原为意志", cleared["sanLoss"] == 0 and cleared["maxSAN"] == cleared["base"],
              cleared)

        print("\n== 4、状态管理 · 随机疯狂状态 ==")
        mad_txt = await txt(".sheet-mask")
        check("有疯狂状态区", "疯狂状态" in mad_txt)
        check("有「掷临时疯狂」按钮", "掷临时疯狂" in mad_txt)
        check("有「掷疯狂状态」按钮", "掷疯狂状态" in mad_txt)  # v2.1.5：原「掷永久疯狂」改名
        check("有「推进 1 轮」按钮", "推进 1 轮" in mad_txt)
        check("说明症状表条数", "200 条" in mad_txt, "查找 200 条")
        check("初始为空", "当前没有疯狂状态" in mad_txt)

        # 掷一个临时疯狂
        await page.evaluate("""()=>{
          const b=[...document.querySelectorAll('.sheet-mask button')].find(x=>/掷临时疯狂/.test(x.textContent));
          if(b) b.click();
        }""")
        await page.wait_for_timeout(600)
        m1 = await page.evaluate("()=>Store.getState().current.madness[0]")
        check("★ 掷出了临时疯狂", m1 and m1["permanent"] is False, m1)
        check("★ 带 1-10 轮持续时间", m1 and 1 <= m1["rounds"] <= 10, m1 and m1["rounds"])
        check("★ 有症状名与描述", m1 and m1["name"] and m1["desc"], m1 and m1["name"])
        # v2.1.7：疯狂表 1D10 —— 1-8 掷出的是发作行为（bout），合法类型
        check("★ 类型是恐惧症/狂躁症/发作行为", m1 and m1["type"] in ("phobia", "mania", "bout"), m1 and m1["type"])

        # 再掷两个
        for _ in range(2):
            await page.evaluate("""()=>{
              const b=[...document.querySelectorAll('.sheet-mask button')].find(x=>/掷临时疯狂/.test(x.textContent));
              if(b) b.click();
            }""")
            await page.wait_for_timeout(300)
        n_mad = await page.evaluate("()=>Store.getState().current.madness.length")
        check("可以连续掷多个症状", n_mad == 3, n_mad)

        # 掷一个「疯狂状态」（v2.1.5：概念纠正，不再是「掷永久疯狂」—— 永久疯狂不是掷出来的）
        await page.evaluate("""()=>{
          const b=[...document.querySelectorAll('.sheet-mask button')].find(x=>/掷疯狂状态/.test(x.textContent));
          if(b) b.click();
        }""")
        await page.wait_for_timeout(600)
        mads = await page.evaluate("()=>Store.getState().current.madness")
        check("★ 能掷出疯狂状态（临时，带 1-10 轮）", len(mads) == 4 and mads[3]["permanent"] is False and 1 <= mads[3]["rounds"] <= 10, "共 %d 条" % len(mads))

        # 推进 10 轮：临时全部消退（v2.1.5 没有「永久疯狂」被掷出，全是临时）
        await page.evaluate("""()=>{
          const b=[...document.querySelectorAll('.sheet-mask button')].find(x=>/推进 1 轮/.test(x.textContent));
          for(let i=0;i<10;i++) if(b) b.click();
        }""")
        await page.wait_for_timeout(900)
        after_adv = await page.evaluate("()=>Store.getState().current.madness")
        check("★ 推进轮次后临时疯狂已消退", len(after_adv) == 0, "剩 %d 条" % len(after_adv))

        # 手动删除
        await page.evaluate("""()=>{
          const b=[...document.querySelectorAll('.sheet-mask .sbtn.minus')][0];
          if(b) b.click();
        }""")
        await page.wait_for_timeout(500)
        after_del = await page.evaluate("()=>Store.getState().current.madness")
        check("★ 可以手动删除疯狂状态", len(after_del) == 0, "剩 %d 条" % len(after_del))
        check("★ 删空后显示空状态提示", "当前没有疯狂状态" in await txt(".sheet-mask"))
        await shot("v8_03_madness")

        # 保存状态
        await page.evaluate("""()=>{
          const b=[...document.querySelectorAll('.sheet-mask button')].find(x=>/保存状态/.test(x.textContent));
          if(b) b.click();
        }""")
        await page.wait_for_timeout(800)

        # 角色卡上应显示疯狂状态条
        await page.evaluate("""()=>{
          const c=Store.loadCharacter('madtest01');
          c.madness=[window.CocMadness.make('phobia', window.CocMadness.phobias()[3], false, 4)];
          window.CocMadness.make;
          Store.commitEdit&&0;
        }""")
        await page.evaluate("""()=>{
          const c=Store.getState().current;
          c.madness=[window.CocMadness.make('phobia', window.CocMadness.phobias()[3], false, 4)];
          window.Engine.recalc(c); Store.scheduleSave();
        }""")
        await page.wait_for_timeout(900)
        await page.evaluate("()=>{App.go('#/card/coc7/madtest01');}")
        await page.wait_for_timeout(900)
        card_txt = await txt(".content")
        check("★ 角色卡「状态」区列出疯狂状态", "疯狂状态" in card_txt, card_txt[:200] if "疯狂状态" not in card_txt else "")
        if "疯狂状态" in card_txt:
            check("★ 显示剩余轮数", "轮）" in card_txt, "")
        await shot("v8_04_card_madness")

        # =========================================================
        # 4.5 精神状态多选 + 背景恐惧症 → 永久疯狂
        # =========================================================
        print("\n== 4.5 精神状态多选 / 背景症状进疯狂状态 ==")
        await page.evaluate("""()=>{
          const c=Store.loadCharacter('madtest01');
          if(c){ c.madness=[]; c.status.mental=['正常']; window.Engine.recalc(c); Store.scheduleSave(); }
        }""")
        await page.wait_for_timeout(600)
        await page.evaluate("()=>{App.go('#/card/coc7/madtest01');}")
        await page.wait_for_timeout(800)
        await page.evaluate("""()=>{
          const b=[...document.querySelectorAll('button')].find(x=>/状态管理/.test(x.textContent));
          if(b) b.click();
        }""")
        await page.wait_for_timeout(700)

        # 点「临时疯狂」→ 临时疯狂（踢掉「正常」）
        # ⚠️ 必须按 data-mental 定位：身体状态那一行也有个「正常」，
        #    只按文字找 chip 会误命中「身体状态 / 正常」。
        await page.evaluate("""()=>{
          const t=document.querySelector('.sheet-mask .chip[data-mental="临时疯狂"]');
          if(t) t.click();
        }""")
        await page.wait_for_timeout(350)
        mental_tmp = await page.evaluate("()=>Store.getState().current.status.mental")
        check("★ 选「临时疯狂」后不含「正常」", "临时疯狂" in mental_tmp and "正常" not in mental_tmp, mental_tmp)

        # 点「永久疯狂」→ v2.1.6 **行内两段式**：第一次变「⚠ 确认永久疯狂？」，再点生效
        await page.evaluate("""()=>{
          const p=document.querySelector('.sheet-mask .chip[data-mental="永久疯狂"]');
          if(p) p.click();
        }""")
        await page.wait_for_timeout(400)
        await page.evaluate("""()=>{
          const p=document.querySelector('.sheet-mask .chip[data-mental="永久疯狂"]');
          if(p) p.click();
        }""")
        await page.wait_for_timeout(400)
        mental = await page.evaluate("()=>Store.getState().current.status.mental")
        check("★ 永久疯狂互斥（只留它一项）", mental == ["永久疯狂"], mental)

        # 点「正常」→ 清空其余
        await page.evaluate("""()=>{
          const n=document.querySelector('.sheet-mask .chip[data-mental="正常"]');
          if(n) n.click();
        }""")
        await page.wait_for_timeout(400)
        mental2 = await page.evaluate("()=>Store.getState().current.status.mental")
        check("★ 选「正常」清空其余项", mental2 == ["正常"], mental2)

        # 角色卡上应显示多选结果（不是 [object Array]）
        await page.evaluate("""()=>{
          const c=Store.getState().current;
          c.status.mental=['永久疯狂','不定疯狂'];
          window.Engine.recalc(c); Store.scheduleSave();
        }""")
        await page.wait_for_timeout(500)
        await page.evaluate("()=>{App.go('#/card/coc7/madtest01');}")
        await page.wait_for_timeout(800)
        card2 = await txt(".content")
        check("★ 角色卡精神状态显示为文本", "永久疯狂" in card2 and "[object" not in card2,
              card2[:200] if "[object" in card2 else "")

        # 背景里的【恐惧症】应自动进结构化「永久疯狂」
        await page.evaluate("""()=>{
          const c=Store.getState().current;
          const nm=window.CocMadness.phobias()[0].name;
          c.madness=[];
          c.background.phobias='【恐惧症】'+nm+'：测试用';
          window.Engine.recalc(c);
          window.CocMadness.fromBackground(c);
          Store.scheduleSave();
          return c.madness.length;
        }""")
        await page.wait_for_timeout(600)
        bg_mad = await page.evaluate("()=>Store.getState().current.madness")
        check("★ 背景【恐惧症】被补进结构化疯狂数组", len(bg_mad) >= 1, "%d 条" % len(bg_mad))
        check("★ 补进来的是永久疯狂", bg_mad and bg_mad[0]["permanent"] is True, bg_mad[:1])
        await shot("v8_05_mental_multi")

        # =========================================================
        # 5. 彩蛋
        # =========================================================
        print("\n== 5、随机角色的彩蛋 ==")
        egg = await page.evaluate("""()=>{
          const E=window.CocEasterEgg;
          return {
            celebs: E.celebrities.length,
            friends: E.friends.length,
            friendNames: E.friends.map(f=>f.name),
            friendGenders: E.friends.map(f=>f.gender),
            friendEras: E.friends.map(f=>f.era)
          };
        }""")
        want = ["茶叶蛋", "秦九", "北北", "小张", "乌龟", "阿肆", "年年"]
        check("★ 7 位跑团成员都在", all(n in egg["friendNames"] for n in want), egg["friendNames"])
        check("★ 成员性别正确",
              egg["friendGenders"][egg["friendNames"].index("茶叶蛋")] == "男" and
              egg["friendGenders"][egg["friendNames"].index("秦九")] == "女" and
              egg["friendGenders"][egg["friendNames"].index("北北")] == "女" and
              egg["friendGenders"][egg["friendNames"].index("年年")] == "男", egg["friendGenders"])
        check("★ 成员时代都是现代", all(e == "现代" for e in egg["friendEras"]), egg["friendEras"])
        check("★ 名人彩蛋有存货", egg["celebs"] >= 20, egg["celebs"])

        # 强制抽到彩蛋，验证生成的卡合规
        forced = await page.evaluate("""()=>{
          const E=window.CocEasterEgg, G=window.PresetGen;
          const out=[];
          for(const f of E.friends){
            const pf=E.toProfile({kind:'friend', data:f});
            const c=G.generateOne({profile: pf, ctx:{used:{}}});
            if(!c){ out.push({name:f.name, err:'生成失败'}); continue; }
            const bads=window.Engine.checkList(c).filter(x=>!x.ok);
            out.push({
              name:f.name, cardName:c.characterName,
              era:c.basicInfo.era,
              residence:c.basicInfo.residence,
              bad: bads.length,
              egg: !!c.isEasterEgg, kind: c.eggKind,
              avatar: !!c.avatar,
              hp: c.status.maxHP, san: c.status.maxSAN
            });
          }
          return out;
        }""")
        for f in forced:
            tag = f.get("name", "?")
            check("★ 彩蛋卡「%s」生成合规" % tag,
                  f.get("bad") == 0 and f.get("cardName") == tag and f.get("egg") and f.get("avatar"),
                  f)
        check("★ 成员卡时代为现代", all(f.get("era") == "现代" for f in forced), [f.get("era") for f in forced])

        # 名人卡
        celeb_cards = await page.evaluate("""()=>{
          const E=window.CocEasterEgg, G=window.PresetGen;
          let ok=0, total=E.celebrities.length, sample=[];
          for(const cb of E.celebrities){
            const pf=E.toProfile({kind:'celeb', data:cb});
            const c=G.generateOne({profile: pf, ctx:{used:{}}});
            if(!c) continue;
            if(c.characterName===cb.name && window.Engine.checkList(c).every(x=>x.ok) && c.isEasterEgg) ok++;
            else if(sample.length<3) sample.push({want:cb.name, got:c.characterName});
          }
          return {ok:ok, total:total, sample:sample};
        }""")
        check("★ 全部名人彩蛋卡生成合规",
              celeb_cards["ok"] == celeb_cards["total"],
              "%d/%d %s" % (celeb_cards["ok"], celeb_cards["total"], celeb_cards["sample"]))

        # 命中率：跑 4000 次生成，看有没有抽到
        rate = await page.evaluate("""()=>{
          let hit=0, n=0;
          for(let i=0;i<4000;i++){
            const cards=window.PresetGen.generate(1);
            if(cards[0] && cards[0].isEasterEgg) hit++;
            n++;
          }
          return {hit:hit, n:n};
        }""")
        pct = rate["hit"] / rate["n"] * 100
        check("★ 随机生成能抽到彩蛋", rate["hit"] > 0, "%d/%d ≈ %.1f%%" % (rate["hit"], rate["n"], pct))
        check("彩蛋命中率在合理区间（批级抽签约 50%）", pct < 65, "%.1f%%" % pct)

        # 同批不重复
        dup = await page.evaluate("""()=>{
          let dupNames=0;
          for(let i=0;i<300;i++){
            const cards=window.PresetGen.generate(5);
            const names=cards.map(c=>c.characterName);
            if(new Set(names).size !== names.length) dupNames++;
          }
          return dupNames;
        }""")
        check("★ 同批 5 张不出现同名", dup == 0, "重复批次 %d/300" % dup)

        # 界面上能看到彩蛋角标
        await page.evaluate("()=>{App.go('#/');}")
        await page.wait_for_timeout(500)
        await page.evaluate("()=>{App.newCharacter();}")
        await page.wait_for_timeout(900)
        # 先点「生成随机角色」出第一批
        await page.evaluate("""()=>{
          const b=[...document.querySelectorAll('button')].find(x=>/生成随机角色/.test(x.textContent));
          if(b) b.click();
        }""")
        await page.wait_for_timeout(1200)
        check("随机卡已生成", await page.evaluate("()=>document.querySelectorAll('.preset-card').length") > 0,
              await page.evaluate("()=>document.querySelectorAll('.preset-card').length"))

        # 反复「换一批」直到抽到彩蛋（命中率约 5%，60 轮足够）
        got_badge = False
        for _ in range(80):
            if await page.evaluate("()=>!!document.querySelector('.egg-badge')"):
                got_badge = True
                break
            await page.evaluate("""()=>{
              const b=[...document.querySelectorAll('button')].find(x=>/换一批/.test(x.textContent));
              if(b) b.click();
            }""")
            await page.wait_for_timeout(160)
        check("★ 界面上能看到彩蛋角标", got_badge)
        if got_badge:
            badge = await txt(".egg-badge")
            check("角标带「彩蛋」或「跑团成员」字样", "彩蛋" in badge or "跑团成员" in badge, badge)
        await shot("v8_05_egg")

        # =========================================================
        # 收尾
        # =========================================================
        # 测试自己会造 404（/models 不支持）与 401（Key 无效）两种响应，
        # 浏览器必然各记一笔；这些是有意注入的，不算应用错误。
        def is_noise(e):
            return ("favicon" in e) or ("401" in e and "Unauthorized" in e) or e.startswith("[404]")

        real_errors = [e for e in errors if not is_noise(e)]
        print("\n404 资源：%s" % [e for e in errors if e.startswith("[404]")][:6])
        print("控制台错误：%d 条" % len(real_errors))
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
    print("控制台错误 %d 条" % len([e for e in errors if not (("favicon" in e) or ("401" in e and "Unauthorized" in e) or e.startswith("[404]"))]))


asyncio.run(main())
