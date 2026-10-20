# -*- coding: utf-8 -*-
"""第四批需求的回归验证（真实浏览器交互）：
  1. 菜单新增「AI 设置」：默认值 / 保存 / 非法地址拦截 / 测试连接的错误提示
  2. 第 0 步新增「AI 车卡」：未配置时给引导；配置后一句话生成调查员、
     结果来自模型、违规内容被本地规则兜住、可反复重新生成
  3. 随机角色：姓名 / 地点 / 时代 / 装备一致，且自动带头像、同批不重名
  4. 弹层打开时锁住背景滚动（修复「浮窗和背景一起动」）
  5. 角色卡「状态管理」入口移到「状态」卡片内，底部按钮不再溢出
  6. 系统返回键：向导内逐级回退，不再直接退出应用
  7. 「⋯」更多按钮触摸热区放大
  8. 关于页新增 B 站与博客链接
"""
import os
import asyncio, json, os
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:%d/index.html" % int(os.environ.get("COC_STATIC_PORT") or 8899)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots6")
os.makedirs(OUT, exist_ok=True)

errors = []
results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("  [OK] " if ok else "  [!!] ") + name + (("  <- " + str(detail)) if detail else ""))


# AI 假装返回的角色（第一次不带围栏，第二次带 ```json 围栏，用来验证容错解析）
AI_CARD = {
    "setting": "中国 · 民国",
    "name": "顾长明",
    "gender": "男",
    "age": 38,
    "residence": "上海",
    "birthplace": "苏州",
    "occupationName": "私家侦探",
    "attributes": {"str": 60, "con": 55, "siz": 65, "dex": 70, "app": 55,
                   "int": 75, "pow": 60, "edu": 80, "luck": 50},
    "background": {
        "description": "旧西装熨得平整，右手的茧比左手厚一层。",
        "ideology": "信念：案子可以结不了，但不能结错。",
        "significantPeople": "老搭档｜一起熬过最难的那两年｜三年前失踪，我一直在等消息。",
        "meaningfulPlaces": "租界外的旧里弄｜下过雨的湿地面｜我最后一次见到他的地方。",
        "treasuredPossessions": "一副旧手铐｜铜面磨得发亮｜前同事留下的｜我一直没还回去。",
        "traits": "沉默、多疑、习惯性守时",
        "wounds": "左手小指不太能弯。",
        "phobias": "【恐惧症】幽闭恐惧：被关在狭窄空间里会失控。",
        "history": "丢差事那年冬天特别冷。后来我发现，只有替别人找答案的时候我还算清醒。"
    }
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

        async def open_menu():
            await page.click(".appbar button.icon-btn")
            await page.wait_for_timeout(450)

        # ---------- 假接口 ----------
        ai_calls = {"n": 0}
        last_body = {"v": None}

        async def ai_handler(route, request):
            if request.method == "OPTIONS":
                await route.fulfill(status=204, headers={
                    "access-control-allow-origin": "*",
                    "access-control-allow-headers": "*",
                    "access-control-allow-methods": "POST, OPTIONS"})
                return
            ai_calls["n"] += 1
            try:
                last_body["v"] = json.loads(request.post_data or "{}")
            except Exception:
                last_body["v"] = None
            content = json.dumps(AI_CARD, ensure_ascii=False)
            if ai_calls["n"] >= 2:
                content = "```json\n" + content + "\n```"   # 第二次带围栏，验证容错解析
            payload = {"choices": [{"message": {"role": "assistant", "content": content}}]}
            # 真实模型不会秒回，这里也拖一下，好让「等待中」的状态被观察到
            await asyncio.sleep(1.2)
            await route.fulfill(status=200, headers={
                "access-control-allow-origin": "*",
                "content-type": "application/json"}, body=json.dumps(payload, ensure_ascii=False))

        await page.route("**/chat/completions", ai_handler)

        # 「测试连接」现在第一步会打 <base>/models 验证地址与 Key。
        # 这里给它一条固定路由，否则请求会真的发到 api.deepseek.com 去。
        async def models_handler(route, request):
            if request.method == "OPTIONS":
                await route.fulfill(status=204, headers={
                    "access-control-allow-origin": "*",
                    "access-control-allow-headers": "*",
                    "access-control-allow-methods": "GET, OPTIONS"})
                return
            ai_calls["models"] = ai_calls.get("models", 0) + 1
            await route.fulfill(status=200, headers={
                "access-control-allow-origin": "*",
                "content-type": "application/json"},
                body=json.dumps({"data": [{"id": "deepseek-flash"}, {"id": "deepseek-chat"}]}))

        await page.route("**/models", models_handler)

        # ---------- 干净环境 ----------
        await page.goto(BASE, wait_until="networkidle")
        await page.evaluate("()=>localStorage.clear()")
        await page.goto(BASE, wait_until="networkidle")
        await page.wait_for_timeout(700)

        # =========================================================
        # 1. 菜单 + AI 设置
        # =========================================================
        print("\n1) 菜单与 AI 设置")
        await open_menu()
        menu_txt = await txt(".sheet")
        check("菜单里有「AI 车卡」", "AI 车卡" in menu_txt)
        check("菜单里有「AI 设置」", "AI 设置" in menu_txt)

        await page.click(".sheet .occ-item:has-text('AI 设置')")
        await page.wait_for_timeout(600)
        defaults = await page.evaluate("""()=>{
          const s = Store.getState().settings;
          return { base: s.aiBase, model: s.aiModel, key: s.aiKey };
        }""")
        check("接口地址默认 DeepSeek 官方", defaults["base"] == "https://api.deepseek.com/v1", defaults)
        check("模型名默认 deepseek-flash", defaults["model"] == "deepseek-flash", defaults)
        check("API Key 默认留空", defaults["key"] == "", defaults)
        ai_txt = await txt(".sheet")
        check("AI 设置里有使用说明", ("怎么用" in ai_txt) and ("测试连接" in ai_txt))
        await shot("v6_01_ai_settings")

        # 1a. 没有 Key 时测试连接应被拦下
        await page.click(".sheet button:has-text('测试连接')")
        await page.wait_for_timeout(700)
        check("三项不全时不让测试连接", "都填好才能测试" in await txt("body"), "toast")

        # 1b. 非法地址拦截
        await page.evaluate("""()=>{
          const ins = document.querySelectorAll('.sheet input');
          ins[0].value = 'api.deepseek.com/v1';
          ins[0].dispatchEvent(new Event('input'));
        }""")
        await page.click(".sheet button:has-text('保存')")
        await page.wait_for_timeout(500)
        bad = await page.evaluate("""()=>({
          saved: Store.getState().settings.aiBase,
          invalid: !!document.querySelector('.sheet input.invalid')
        })""")
        check("不带协议头的地址被拒绝", bad["saved"] == "https://api.deepseek.com/v1", bad)
        check("非法地址输入框标红", bad["invalid"] is True, bad)

        # 1c. 正常保存
        await page.evaluate("""()=>{
          const ins = document.querySelectorAll('.sheet input');
          ins[0].value = 'https://api.deepseek.com/v1';
          ins[0].dispatchEvent(new Event('input'));
          ins[1].value = 'deepseek-flash';
          ins[1].dispatchEvent(new Event('input'));
          ins[2].value = 'sk-test-1234567890';
          ins[2].dispatchEvent(new Event('input'));
        }""")
        await page.click(".sheet button:has-text('保存')")
        await page.wait_for_timeout(700)
        saved = await page.evaluate("()=>Store.getState().settings.aiKey")
        check("API Key 已保存", saved == "sk-test-1234567890", saved)
        state_txt = await txt(".sheet")
        check("状态行显示已配置（Key 打码）", "sk-t" in state_txt and "1234567890" not in state_txt)

        # 1d. 测试连接成功
        # 新逻辑：先打 /models 验证地址与 Key，通了就不再发对话请求（省额度）。
        # 这里比较点击前后的差值，避免被前面步骤的累计计数干扰。
        before_models = ai_calls.get("models", 0)
        before_chat = ai_calls["n"]
        await page.click(".sheet button:has-text('测试连接')")
        await page.wait_for_timeout(1800)
        check("测试连接成功提示", "连接正常" in await txt("body"), "toast")
        sent = (ai_calls.get("models", 0) - before_models) + (ai_calls["n"] - before_chat)
        check("测试请求确实发出去了", sent >= 1,
              {"新增请求数": sent, "chat": ai_calls["n"] - before_chat, "models": ai_calls.get("models", 0) - before_models})
        check("/models 通了就不再发对话请求（省额度）",
              (ai_calls.get("models", 0) - before_models) == 1 and (ai_calls["n"] - before_chat) == 0,
              {"chat": ai_calls["n"] - before_chat, "models": ai_calls.get("models", 0) - before_models})

        # 1e. 接口报错时的中文提示
        async def fail_handler(route, request):
            if request.method == "OPTIONS":
                await route.fulfill(status=204, headers={
                    "access-control-allow-origin": "*",
                    "access-control-allow-headers": "*",
                    "access-control-allow-methods": "POST, OPTIONS"})
                return
            await route.fulfill(status=401, headers={
                "access-control-allow-origin": "*",
                "content-type": "application/json"},
                body=json.dumps({"error": {"message": "Authentication Fails"}}))
        await page.unroute("**/chat/completions")
        await page.route("**/chat/completions", fail_handler)
        # 401 这一步要验「Key 无效」的提示，所以 /models 也得一起失败 ——
        # 否则 test() 第一步探测就成功了，根本走不到对话探测。
        async def models_fail_handler(route, request):
            if request.method == "OPTIONS":
                await route.fulfill(status=204, headers={
                    "access-control-allow-origin": "*",
                    "access-control-allow-headers": "*",
                    "access-control-allow-methods": "GET, OPTIONS"})
                return
            await route.fulfill(status=401, headers={
                "access-control-allow-origin": "*",
                "content-type": "application/json"},
                body=json.dumps({"error": {"message": "Authentication Fails"}}))
        await page.unroute("**/models")
        await page.route("**/models", models_fail_handler)
        await page.click(".sheet button:has-text('测试连接')")
        await page.wait_for_timeout(1800)
        fail_txt = await txt("body")
        check("401 被翻译成「Key 不正确或已失效」", "Key 不正确或已失效" in fail_txt, fail_txt[:120])
        await page.evaluate("()=>{while(document.querySelector('.sheet-mask')){UI.closeTopSheet();}}")
        await page.wait_for_timeout(300)
        # 复原，后面 AI 车卡还要用
        await page.unroute("**/models")
        await page.route("**/models", models_handler)

        # =========================================================
        # 2. AI 车卡
        # =========================================================
        print("\n2) AI 车卡")
        await page.unroute("**/chat/completions")
        await page.route("**/chat/completions", ai_handler)
        ai_calls["n"] = 0

        await page.click(".rule-card.on")
        await page.wait_for_timeout(800)
        start_txt = await txt("#app")
        check("第 0 步有「AI 车卡」入口", "AI 车卡" in start_txt)

        await page.click("button:has-text('✨ AI 车卡')")
        await page.wait_for_timeout(600)
        panel_txt = await txt(".sheet")
        check("AI 面板有描述输入框", await page.evaluate("()=>!!document.querySelector('.sheet textarea')"))
        check("AI 面板给了示例", "例如：" in panel_txt or "民国" in panel_txt)
        await shot("v6_02_ai_panel")

        # 2a. 空描述应被拦下
        await page.click(".sheet button:has-text('✨ 生成调查员')")
        await page.wait_for_timeout(500)
        check("空描述不让生成", "先写一句描述" in await txt("body"))
        check("空描述时没有发出请求", ai_calls["n"] == 0, ai_calls)

        # 2b. 正式生成
        await page.evaluate("""()=>{
          const ta = document.querySelector('.sheet textarea');
          ta.value = '民国时期的私家侦探，前警察，因为一桩案子丢了差事';
          ta.dispatchEvent(new Event('input'));
        }""")
        await page.click(".sheet button:has-text('✨ 生成调查员')")
        await page.wait_for_timeout(900)
        loading_txt = await txt(".sheet")
        check("生成中有等待提示", "正在生成" in loading_txt, loading_txt[:80])
        await shot("v6_03_ai_loading")

        await page.wait_for_selector(".sheet button:has-text('就用这张')", timeout=30000)
        await page.wait_for_timeout(400)
        card_txt = await txt(".sheet")
        check("生成结果展示角色名（来自模型）", "顾长明" in card_txt)
        check("结果里体现模型给的时代", "1920年代" in card_txt)
        check("结果里体现模型给的职业", "私家侦探" in card_txt)
        check("结果里体现模型给的居住地", "上海" in card_txt)

        # 提示词确实把用户描述带过去了
        sent = last_body["v"]
        user_msg = ""
        for m in (sent or {}).get("messages", []):
            if m.get("role") == "user":
                user_msg = m.get("content", "")
        check("请求里带上了用户描述", "丢了差事" in user_msg)
        check("请求里带上了职业清单", "私家侦探" in user_msg)
        check("请求里带上了世界设定清单", "中国 · 民国" in user_msg)
        check("请求用了配置里的模型", (sent or {}).get("model") == "deepseek-flash", (sent or {}).get("model"))
        check("请求带了 Authorization 头", ai_calls["n"] >= 1)

        probe = await page.evaluate("""()=>{
          const card = document.querySelector('.sheet .preset-card');
          const av = card ? card.querySelector('.pc-av') : null;
          return { hasCard: !!card, hasAvatar: !!av,
                   avatarKind: av ? av.getAttribute('src').slice(0, 26) : '' };
        }""")
        check("AI 卡渲染了完整预览", probe["hasCard"] is True, probe)
        check("AI 卡自动带了头像", probe["hasAvatar"] and "data:image/svg+xml" in probe["avatarKind"], probe)
        await shot("v6_04_ai_result")

        # 2c. 重新生成（第二次响应带 markdown 围栏，验证容错）
        before = ai_calls["n"]
        await page.click(".sheet button:has-text('重新生成')")
        await page.wait_for_selector(".sheet button:has-text('就用这张')", timeout=30000)
        await page.wait_for_timeout(400)
        check("重新生成会再发一次请求", ai_calls["n"] == before + 1, ai_calls)
        check("带 ```json 围栏的返回也能解析", "顾长明" in await txt(".sheet"))

        # 2d. 用这张 → 落库 + 回首页
        await page.click(".sheet button:has-text('就用这张')")
        await page.wait_for_timeout(900)
        landed = await page.evaluate("""()=>{
          const cs = Store.listCharacters();
          const c = cs[0] || {};
          return { n: cs.length, name: c.characterName, occ: (CocOccupation.getById(c.occupationId)||{}).name,
                   era: c.basicInfo.era, res: c.basicInfo.residence, birth: c.basicInfo.birthplace,
                   world: c.worldId, avatar: (c.avatar||'').slice(0,24),
                   sound: Engine.checkList(c).filter(x=>!x.ok).length,
                   bg: c.background.description };
        }""")
        check("选定的 AI 卡已保存", landed["n"] == 1 and landed["name"] == "顾长明", landed)
        check("AI 卡职业来自模型选择", landed["occ"] == "私家侦探", landed)
        check("AI 卡时代跟随设定", landed["era"] == "1920年代", landed)
        check("AI 卡居住地 / 籍贯都按模型给的填", landed["res"] == "上海" and landed["birth"] == "苏州", landed)
        check("AI 卡世界设定被识别", landed["world"] == "cn-republic", landed)
        check("AI 卡自动配了头像", "data:image/svg+xml" in landed["avatar"], landed)
        check("AI 卡通过完整校验（0 项不合格）", landed["sound"] == 0, landed)
        check("AI 卡背景用的是模型写的外貌", landed["bg"].startswith("旧西装"), landed["bg"])
        check("生成后回到首页", "选择规则系统" in await txt("#app") or "最近的调查员" in await txt("#app"))
        await shot("v6_05_ai_saved_home")

        # =========================================================
        # 3. 随机角色的自洽性
        # =========================================================
        print("\n3) 随机角色一致性")
        gen = await page.evaluate("""()=>{
          const list = PresetGen.generate(5);
          return list.map(c => {
            const s = CocPersonas.getById(c.worldId);
            return {
              name: c.characterName, world: s ? s.label : null, nameKey: s ? s.nameKey : null,
              era: c.basicInfo.era, eraCustom: c.basicInfo.eraCustom,
              res: c.basicInfo.residence, birth: c.basicInfo.birthplace,
              currency: c.assets.currency, unit: s ? s.unit : null,
              avatar: (c.avatar||'').slice(0,24),
              egg: !!c.isEasterEgg,
              weapons: (c.weapons||[]).map(w=>w.name),
              ok: Engine.checkList(c).filter(x=>!x.ok).length === 0
            };
          });
        }""")
        check("随机生成 5 张", len(gen) == 5, len(gen))
        check("每张都有世界设定", all(g["world"] for g in gen), [g["world"] for g in gen])
        check("每张都自动带头像", all("data:image/svg+xml" in g["avatar"] for g in gen))
        check("每张都通过完整校验", all(g["ok"] for g in gen))
        check("货币单位与设定一致", all(g["currency"] == g["unit"] for g in gen),
              [(g["currency"], g["unit"]) for g in gen])
        check("居住地与出生地不同", all(g["res"] != g["birth"] for g in gen))
        # 西文设定（enWestern / ruOld）姓名必须带间隔号；中文与日文设定不能带
        # ⚠️ 彩蛋卡要跳过：彩蛋用的是历史人物/跑团成员的本名（「爱因斯坦」「李白」），
        #    那个名字跟着**人物本人的国籍**走，不受这一张卡随机抽到的世界设定约束。
        name_ok = True
        for g in gen:
            if g.get("egg"):
                continue
            western = g["nameKey"] in ("enWestern", "ruOld")
            if western and "·" not in g["name"]:
                name_ok = False
            if (not western) and "·" in g["name"]:
                name_ok = False
        check("姓名写法与设定的文化一致", name_ok, [(g["world"], g["name"]) for g in gen])
        # 同一批里不该出现同名
        check("同批不重名", len({g["name"] for g in gen}) == 5, [g["name"] for g in gen])
        # 古代设定不能出现现代枪械
        ancient = await page.evaluate("""()=>{
          const s = CocPersonas.getById('cn-ancient');
          const list = PresetGen.generate(6, { setting: s });
          const bad = [];
          list.forEach(c => (c.weapons||[]).forEach(w => {
            if (/手枪|步枪|冲锋枪|机枪|榴弹|炸弹|地雷|电锯|电棍|霰弹/.test(w.name)) bad.push(w.name);
          }));
          return { bad: bad, n: list.length, era: list[0] ? list[0].basicInfo.era : '' };
        }""")
        check("古代设定不会掏出枪械", ancient["bad"] == [], ancient)
        check("古代设定的时代写成「自定义·古代中国」",
              ancient["era"] == "自定义", ancient["era"])

        # =========================================================
        # 4. 弹层滚动锁
        # =========================================================
        print("\n4) 弹层滚动锁")
        locked_before = await page.evaluate("()=>document.body.classList.contains('scroll-locked')")
        check("平时不锁滚动", locked_before is False)
        await page.click(".rule-card.on")
        await page.wait_for_timeout(700)
        await open_menu()
        locked = await page.evaluate("""()=>({
          body: document.body.classList.contains('scroll-locked'),
          html: document.documentElement.classList.contains('scroll-locked'),
          overflow: getComputedStyle(document.body).overflow,
          sheetOverscroll: getComputedStyle(document.querySelector('.sheet')).overscrollBehavior
        })""")
        check("弹层打开时锁住背景滚动", locked["body"] and locked["html"], locked)
        check("body overflow 变成 hidden", locked["overflow"] == "hidden", locked)
        check("弹层自身限制滚动链（contain）", "contain" in locked["sheetOverscroll"], locked)

        # 多层弹层：只关最上面一层，锁不应该提前释放
        await page.evaluate("()=>UI.sheet({title:'第二层', body:'x'})")
        await page.wait_for_timeout(300)
        two = await page.evaluate("()=>document.querySelectorAll('.sheet-mask').length")
        check("可以叠加两层弹层", two == 2, two)
        await page.evaluate("()=>UI.closeTopSheet()")
        await page.wait_for_timeout(300)
        still = await page.evaluate("""()=>({
          n: document.querySelectorAll('.sheet-mask').length,
          locked: document.body.classList.contains('scroll-locked')
        })""")
        check("关掉一层后剩余层数与锁状态都正确", still["n"] == 1 and still["locked"], still)
        await close_sheets()
        await page.wait_for_timeout(300)
        unlocked = await page.evaluate("()=>document.body.classList.contains('scroll-locked')")
        check("全部关闭后恢复滚动", unlocked is False)

        # =========================================================
        # 5. 状态管理位置 + 按钮不溢出
        # =========================================================
        print("\n5) 角色卡页布局")
        await page.evaluate("()=>App.go('#/my')")
        await page.wait_for_timeout(700)
        await page.click(".char-card")
        await page.wait_for_timeout(900)
        layout = await page.evaluate("""()=>{
          const cards = [...document.querySelectorAll('.content .card')];
          const st = cards.find(c => ((c.querySelector('.card-head h3')||{}).textContent||'') === '状态');
          const groups = [...document.querySelectorAll('.content .btn-group')];
          const flat = groups.flatMap(g => [...g.querySelectorAll('button')]).map(b=>b.textContent.trim());
          const over = [...document.querySelectorAll('.content button')].filter(b => b.scrollWidth > b.clientWidth + 2)
            .map(b => b.textContent.trim());
          return {
            statusHasManage: st ? /状态管理/.test(st.textContent) : false,
            bottomHasManage: flat.some(t => /状态管理/.test(t)),
            flat: flat,
            overflow: over,
            groupClass: groups.map(g=>g.className)
          };
        }""")
        check("「状态」卡片里有状态管理入口", layout["statusHasManage"] is True, layout)
        check("底部按钮组不再有状态管理", layout["bottomHasManage"] is False, layout["flat"])
        check("页面按钮没有文字溢出", layout["overflow"] == [], layout["overflow"])
        check("底部按钮用的是两列网格", any("cols2" in c for c in layout["groupClass"]), layout["groupClass"])
        await shot("v6_06_card_layout")

        # 点一下状态管理，弹层应该能开出来并且里面的控件没溢出
        await page.click(".content .card button:has-text('状态管理')")
        await page.wait_for_timeout(700)
        st_over = await page.evaluate("""()=>{
          const over = [...document.querySelectorAll('.sheet button, .sheet .field label')]
            .filter(e => e.scrollWidth > e.clientWidth + 2).map(e=>e.textContent.trim().slice(0,20));
          return { over: over, title: (document.querySelector('.sheet-head h3')||{}).textContent||'' };
        }""")
        check("状态管理弹层打开正常", "状态管理" in st_over["title"], st_over)
        check("状态管理弹层里没有溢出", st_over["over"] == [], st_over["over"])
        await shot("v6_07_status_sheet")
        await close_sheets()

        # 状态改一下，确认能存回去
        await page.evaluate("()=>{ while(document.querySelector('.sheet-mask')) UI.closeTopSheet(); }")
        await page.wait_for_timeout(200)

        # =========================================================
        # 6. 系统返回键
        # =========================================================
        print("\n6) 返回键逐级回退")
        await page.evaluate("()=>App.go('#/')")
        await page.wait_for_timeout(500)
        home_back = await page.evaluate("()=>App.handleBack()")
        check("首页返回 false（交给系统退出）", home_back is False, home_back)

        await page.click(".rule-card.on")
        await page.wait_for_timeout(800)
        await page.evaluate("()=>App.handleBack()")
        await page.wait_for_timeout(600)
        at0 = await page.evaluate("""()=>({
          home: !!document.querySelector('.home-hero'),
          stepperHidden: getComputedStyle(document.querySelector('.stepper')).display === 'none',
          hash: location.hash
        })""")
        check("第 0 步按返回 → 回首页",
              at0["home"] and at0["stepperHidden"] and "选择规则系统" in await txt("#app"), at0)

        await page.click(".rule-card.on")
        await page.wait_for_timeout(800)
        await page.click(".stepper-item:has-text('职业')")
        await page.wait_for_timeout(700)
        before_idx = await page.evaluate(
            "()=>[...document.querySelectorAll('.stepper-item')].findIndex(e=>e.classList.contains('active'))")
        handled = await page.evaluate("()=>App.handleBack()")
        await page.wait_for_timeout(700)
        after_idx = await page.evaluate(
            "()=>[...document.querySelectorAll('.stepper-item')].findIndex(e=>e.classList.contains('active'))")
        check("向导内按返回 → 退到上一步", handled is True and after_idx == before_idx - 1,
              (before_idx, after_idx))

        # 连续回退到第 0 步之后回到首页
        for _ in range(6):
            await page.evaluate("()=>App.handleBack()")
            await page.wait_for_timeout(280)
        back_home = await page.evaluate("()=>({hash: location.hash, home: !!document.querySelector('.home-hero')})")
        check("一路回退后落回首页", back_home["home"] is True, back_home)

        # 弹层优先
        await open_menu()
        sheet_back = await page.evaluate("()=>App.handleBack()")
        await page.wait_for_timeout(400)
        closed = await page.evaluate("()=>!document.querySelector('.sheet-mask')")
        check("有弹层时返回只关弹层", sheet_back is True and closed, (sheet_back, closed))

        # =========================================================
        # 7. 「⋯」热区 / 关于页链接
        # =========================================================
        print("\n7) 触摸热区与关于页")
        await page.evaluate("()=>App.go('#/my')")
        await page.wait_for_timeout(700)
        hit = await page.evaluate("""()=>{
          const b = document.querySelector('.char-more');
          if (!b) return null;
          const r = b.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height) };
        }""")
        check("「⋯」热区不小于 44×44", hit and hit["w"] >= 44 and hit["h"] >= 44, hit)
        await shot("v6_08_char_more")

        await open_menu()
        await page.click(".sheet .occ-item:has-text('关于')")
        await page.wait_for_timeout(600)
        about = await page.evaluate("""()=>{
          const links = [...document.querySelectorAll('.sheet a')].map(a=>a.getAttribute('href'));
          return { links: links, text: document.querySelector('.sheet').textContent };
        }""")
        check("关于页有 B 站链接",
              any("space.bilibili.com/314257" in (l or "") for l in about["links"]), about["links"])
        check("关于页有博客链接",
              any("your-domain.example.com/blog" in (l or "") for l in about["links"]), about["links"])
        check("关于页给出了链接文字", "茶叶蛋调查员协会" in about["text"])
        await shot("v6_09_about")
        await close_sheets()

        # =========================================================
        # 收尾
        # =========================================================
        # 故障注入那一步是故意让接口返回 401，浏览器必然在控制台记一笔，
        # 过滤掉它（以及 favicon）之后才是有意义的错误数。
        def is_noise(e):
            return ("favicon" in e) or ("401" in e and "Unauthorized" in e)

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
    print("控制台错误 %d 条" % len([e for e in errors if not (("favicon" in e) or ("401" in e and "Unauthorized" in e))]))


asyncio.run(main())
