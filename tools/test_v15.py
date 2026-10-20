# -*- coding: utf-8 -*-
"""
test_v15.py —— 房规数值上限也套用到「第 0 步随机卡 / 彩蛋卡」

背景（用户反馈）：
    随机卡上一直弹一句
    「这张卡的技能点被[AI设置]里的数值上限压过(职业点上限99)(兴趣点上限99)。
      点数已全部分配完，只是池子比公式算的小。」
    两个毛病：
      · 那句话是**早已废弃的「压缩点数池」语义** —— 现在上限压的是
        「每一项技能能到的最高值」，点数池永远是规则公式算出的全额；
      · 99 是「不限」，却被当成了「上限 99」，于是**每一张**随机卡都在误报。

要求：
    AI 车卡那套技能分配逻辑 + 数值上限设置（属性总值上限、技能点上限），
    是**变量**，要动态套用到第 0 步随机生成的角色卡上，让玩家按房规自定义；
    彩蛋卡也要生效。

覆盖：
  1. 不设上限：随机卡不显示任何上限提示，卡上也不写上限字段
  2. 设了上限：随机卡逐项不超上限 · 属性总和 ≤ 上限 · 点数仍然用完 · 全部合规
  3. 彩蛋卡（🥚 名人 / 🎭 跑团成员）同样吃上限
  4. 卡片说明是**新语义**：说清「压的是每一项能到的最高值、点数池不缩水」，
     且旧文案「池子比公式算的小」已经消失
  5. 上限是变量：改完设置再生成，新卡立刻按新上限来
  6. 「全部清除」之后随机卡恢复不限
"""
import os
import asyncio, os
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:%d/index.html" % int(os.environ.get("COC_STATIC_PORT") or 8899)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots15")
os.makedirs(OUT, exist_ok=True)

errors = []
results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("  [OK] " if ok else "  [!!] ") + name + (("  <- " + str(detail)) if detail else ""))


# 一张卡的「上限体检表」：属性总和 / 逐项超限 / 点数剩多少 / 卡上的上限字段
CAP_JS = """(c) => {
  const OCC = CocOccupation, SM = SkillModel, R = COC7;
  const set = OCC.occupationalSet(c);
  const op = OCC.occupationPoints(c);
  const ip = OCC.interestPoints(c);
  const A9 = ['str','con','siz','dex','app','int','pow','edu','luck'];
  const sum9 = A9.reduce((t,k)=>t+(parseInt(c.attributes[k],10)||0),0);
  let over = 0, occTop = 0, intTop = 0, occGE50 = 0;
  (c.skills||[]).forEach(s => {
    if (s.id==='credit' || s.id==='cthulhu' || R.isGrowthOnly(s.id)) return;
    const isOcc = !!(set[s.key] || set[s.id]);
    if (s.total > SM.capOf(c, s)) over++;
    if (isOcc) {
      if (!R.capExempt(s.id) && s.total > occTop) occTop = s.total;
      if (s.total >= 50) occGE50++;
    } else if ((s.int||0) > 0 && !R.capExempt(s.id) && s.total > intTop) {
      intTop = s.total;
    }
  });
  const s0 = PresetGen.summaryOf(c);
  return {
    name: c.characterName, egg: c.isEasterEgg ? (c.eggKind||'celeb') : '',
    sum9: sum9, over: over, occTop: occTop, intTop: intTop, occGE50: occGE50,
    occRemain: op.total - op.used, intRemain: ip.total - ip.used,
    cardOccCap: c.skillCapOcc, cardIntCap: c.skillCapInterest,
    cardAttrCap: c.attrCapSetting || 0, scaled: !!c.attrCapScaled,
    sOccCap: s0.occCap, sIntCap: s0.intCap, sAttrCap: s0.attrCap,
    bad: Engine.checkList(c).filter(x => !x.ok).map(x => x.label + ' -> ' + x.detail)
  };
}"""


async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        page = await browser.new_page(viewport={"width": 412, "height": 900})
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        async def shot(name):
            await page.screenshot(path=os.path.join(OUT, name + ".png"))

        async def to_step0():
            await page.evaluate("()=>App.go('#/')")
            await page.wait_for_timeout(500)
            await page.evaluate("()=>App.newCharacter()")
            await page.wait_for_timeout(1200)

        async def click_random():
            await page.evaluate("""()=>{
                const b=[...document.querySelectorAll('button')].find(x=>/生成随机角色/.test(x.textContent));
                if(b) b.click();
            }""")
            await page.wait_for_timeout(1800)

        await page.goto(BASE)
        await page.wait_for_timeout(1200)
        await page.evaluate("()=>{try{localStorage.clear()}catch(e){}}")
        await page.reload()
        await page.wait_for_timeout(1200)

        # =========================================================
        # 1. 不设上限：不该有任何「被上限压过」的提示
        # =========================================================
        print("\n== 1、不设上限（默认）==")
        plain = await page.evaluate("""() => {
          const f = %s;
          const out = [];
          for (let i = 0; i < 20; i++) {
            const c = PresetGen.generateOne({ctx:{used:{}}});
            if (c) out.push(f(c));
          }
          return out;
        }""" % CAP_JS)
        n_cap_marks = len([r for r in plain if r["sOccCap"] or r["sIntCap"] or r["sAttrCap"]])
        print("     20 张随机卡：summaryOf 报出上限的 %s 张 · 卡上 skillCapOcc=%s" %
              (n_cap_marks, plain[0]["cardOccCap"]))
        check("★ 不带上限时 summaryOf 不报任何上限（99 ≠ 上限 99）",
              n_cap_marks == 0, n_cap_marks)
        check("★ 卡上仍是规则默认（skillCapOcc / Interest = 99）",
              plain[0]["cardOccCap"] == 99 and plain[0]["cardIntCap"] == 99,
              [plain[0]["cardOccCap"], plain[0]["cardIntCap"]])
        check("★ 不设上限时不会有 attrCap 标记",
              all(r["cardAttrCap"] == 0 for r in plain),
              [r["cardAttrCap"] for r in plain[:5]])

        await to_step0()
        step0 = await page.evaluate("()=>document.body.innerText")
        check("★ 第 0 步不显示「本次数值上限」（没设就是没设）",
              "本次数值上限" not in step0, step0[:200])
        await click_random()
        card_txt = await page.evaluate("()=>document.body.innerText")
        check("★ 随机卡上不再出现旧文案「池子比公式算的小」",
              "池子比公式算的小" not in card_txt)
        check("★ 随机卡上不再出现「数值上限压过」",
              "数值上限压过" not in card_txt)
        await shot("v15_01_no_caps")

        # =========================================================
        # 2. 设了上限：随机卡全批都要吃
        # =========================================================
        print("\n== 2、设上限 400 / 本职 60 / 兴趣 50 ==")
        await page.evaluate("""()=>Store.setSettings({
            aiAttrCap:400, aiAttrCapWithLuck:true, aiOccPtsCap:60, aiIntPtsCap:50})""")
        await page.wait_for_timeout(300)
        capped = await page.evaluate("""() => {
          const f = %s;
          const out = [];
          for (let i = 0; i < 40; i++) {
            const c = PresetGen.generateOne({ctx:{used:{}}});
            if (c) out.push(f(c));
          }
          return out;
        }""" % CAP_JS)
        n = len(capped)
        over = len([r for r in capped if r["over"]])
        over_sum = len([r for r in capped if r["sum9"] > 400])
        bad = len([r for r in capped if r["bad"]])
        left = len([r for r in capped if r["occRemain"] > 0 or r["intRemain"] > 0])
        max_occ = max(r["occTop"] for r in capped)
        max_int = max(r["intTop"] for r in capped)
        print("     %s 张：逐项超上限 %s · 属性超 400 的 %s · 不合格 %s · 有剩点 %s" %
              (n, over, over_sum, bad, left))
        print("     本职最高 %s（上限 60）· 兴趣最高 %s（上限 50）" % (max_occ, max_int))
        check("★ 随机卡逐项不超房规上限", over == 0, over)
        check("★ 随机卡属性总和被压到 ≤ 400", over_sum == 0, over_sum)
        check("★ 随机卡全部通过完整性校验", bad == 0, bad)
        check("★ 随机卡点数仍然 100% 用完", left == 0, left)
        check("★ 本职技能被封顶在 60 以内", max_occ <= 60, max_occ)
        check("★ 兴趣技能被封顶在 50 以内", max_int <= 50, max_int)
        check("★ 上限写进了卡（skillCapOcc / skillCapInterest）",
              all(r["cardOccCap"] == 60 and r["cardIntCap"] == 50 for r in capped),
              [capped[0]["cardOccCap"], capped[0]["cardIntCap"]])
        check("★ 房规上限不妨碍「至少 2 项本职 ≥50」",
              all(r["occGE50"] >= 2 for r in capped),
              [r["occGE50"] for r in capped if r["occGE50"] < 2])

        await to_step0()
        step0b = await page.evaluate("()=>document.body.innerText")
        check("★ 第 0 步列出本次生效的房规上限",
              "本次数值上限" in step0b and "400" in step0b, step0b[:200])
        check("★ 并说明随机卡与 AI 卡都生效",
              "都生效" in step0b or "生成方式" in step0b, step0b[:260])
        await shot("v15_02_step0_caps")

        await click_random()
        card_txt2 = await page.evaluate("()=>document.body.innerText")
        check("★ 卡片上写明「按数值上限房规生成」",
              "房规生成" in card_txt2, card_txt2[-400:])
        check("★ 卡片上说清上限压的是「每一项技能能到的最高值」",
              "每一项技能能到的最高值" in card_txt2, card_txt2[-400:])
        check("★ 卡片上不再出现「池子比公式算的小」",
              "池子比公式算的小" not in card_txt2)
        await shot("v15_03_card_with_caps")

        # =========================================================
        # 3. 彩蛋卡同样生效
        # =========================================================
        print("\n== 3、彩蛋卡 ==")
        eggs = await page.evaluate("""() => {
          const f = %s;
          const all = CocEasterEgg.all();
          const out = [];
          all.forEach(x => {
            const c = PresetGen.generateOne({
              ctx:{used:{}}, profile: CocEasterEgg.toProfile(x)
            });
            if (!c) { out.push({name:x.data.name, failed:true}); return; }
            c.isEasterEgg = true; c.eggKind = x.kind;
            out.push(f(c));
          });
          return out;
        }""" % CAP_JS)
        ok_eggs = [r for r in eggs if not r.get("failed")]
        egg_over = len([r for r in ok_eggs if r["over"]])
        egg_sum = len([r for r in ok_eggs if r["sum9"] > 400])
        egg_bad = len([r for r in ok_eggs if r["bad"]])
        egg_cap = len([r for r in ok_eggs if r["cardOccCap"] == 60 and r["cardIntCap"] == 50])
        egg_attr = len([r for r in ok_eggs if r["cardAttrCap"] == 400])
        kinds = sorted(set(r["egg"] for r in ok_eggs))
        print("     彩蛋 %s 张（类型 %s）：超上限 %s · 属性超 400 %s · 不合格 %s" %
              (len(ok_eggs), kinds, egg_over, egg_sum, egg_bad))
        print("     技能上限写进卡 %s 张 · 属性上限写进卡 %s 张" % (egg_cap, egg_attr))
        check("★ 彩蛋卡全部生成成功", len(ok_eggs) == len(eggs),
              [r["name"] for r in eggs if r.get("failed")])
        check("★ 彩蛋卡逐项不超上限", egg_over == 0, egg_over)
        check("★ 彩蛋卡属性总和 ≤ 上限", egg_sum == 0, egg_sum)
        check("★ 彩蛋卡全部通过完整性校验", egg_bad == 0,
              [r["bad"] for r in ok_eggs if r["bad"]][:2])
        check("★ 彩蛋卡吃到技能上限", egg_cap == len(ok_eggs), egg_cap)
        check("★ 彩蛋卡吃到属性上限", egg_attr == len(ok_eggs), egg_attr)

        batch = await page.evaluate("""() => {
          const f = %s;
          const list = PresetGen.generate(5);
          return list.map(c => f(c));
        }""" % CAP_JS)
        print("     一整批 %s 张：%s" % (len(batch), "、".join(
            "%s(sum9=%s,occTop=%s%s)" % (r["name"], r["sum9"], r["occTop"],
                                         ",彩蛋)" if r["egg"] else "")
            for r in batch)))
        check("★ generate(5) 整批都吃上限",
              len(batch) == 5
              and all(r["over"] == 0 and r["sum9"] <= 400 and r["cardOccCap"] == 60
                      for r in batch),
              [r["sum9"] for r in batch])
        check("★ generate(5) 整批都合规",
              all(not r["bad"] for r in batch),
              [r["bad"] for r in batch if r["bad"]])

        # =========================================================
        # 4. 上限是变量：改完设置立刻生效
        # =========================================================
        print("\n== 4、上限是变量（改完立刻生效，不必重启）==")
        await page.evaluate("""()=>Store.setSettings({
            aiAttrCap:360, aiAttrCapWithLuck:true, aiOccPtsCap:40, aiIntPtsCap:30})""")
        await page.wait_for_timeout(200)
        varcheck = await page.evaluate("""() => {
          const f = %s;
          const c = PresetGen.generateOne({ctx:{used:{}}});
          return f(c);
        }""" % CAP_JS)
        print("     改成 360/40/30 → 新卡：sum9=%s occTop=%s intTop=%s 卡上限=%s/%s" %
              (varcheck["sum9"], varcheck["occTop"], varcheck["intTop"],
               varcheck["cardOccCap"], varcheck["cardIntCap"]))
        check("★ 换个上限后新卡立刻按新的来（属性）", varcheck["sum9"] <= 360,
              varcheck["sum9"])
        check("★ 换个上限后新卡立刻按新的来（技能）",
              varcheck["cardOccCap"] == 40 and varcheck["cardIntCap"] == 30
              and varcheck["occTop"] <= 40 and varcheck["intTop"] <= 30,
              varcheck)
        check("★ 新上限下卡仍然合规", not varcheck["bad"], varcheck["bad"])

        # =========================================================
        # 5. 全部清除 → 恢复不限
        # =========================================================
        print("\n== 5、「全部清除」后恢复不限 ==")
        await page.evaluate("""()=>Store.setSettings({
            aiAttrCap:0, aiAttrCapWithLuck:true, aiOccPtsCap:0, aiIntPtsCap:0})""")
        await page.wait_for_timeout(200)
        cleared = await page.evaluate("""() => {
          const f = %s;
          const out = [];
          for (let i = 0; i < 15; i++) {
            const c = PresetGen.generateOne({ctx:{used:{}}});
            if (c) out.push(f(c));
          }
          return out;
        }""" % CAP_JS)
        check("★ 清除后随机卡不再写任何上限",
              all(r["cardAttrCap"] == 0 and r["cardOccCap"] == 99 and r["cardIntCap"] == 99
                  for r in cleared),
              [r["cardOccCap"] for r in cleared[:5]])
        check("★ 清除后 summaryOf 不再报上限",
              all(r["sOccCap"] == 0 and r["sIntCap"] == 0 and r["sAttrCap"] == 0
                  for r in cleared))
        check("★ 清除后点数仍然用完、卡仍然合规",
              all(r["occRemain"] == 0 and r["intRemain"] == 0 and not r["bad"]
                  for r in cleared),
              [r["occRemain"] for r in cleared if r["occRemain"]])

        await to_step0()
        await click_random()
        card_txt3 = await page.evaluate("()=>document.body.innerText")
        check("★ 清除后卡片上也不再出现房规上限说明",
              "房规生成" not in card_txt3, card_txt3[-300:])
        await shot("v15_04_done")

        def noise(e):
            return ("favicon" in e) or ("401" in e and "Unauthorized" in e) \
                or ("test.invalid" in e) or ("Failed to load resource" in e)

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
