# -*- coding: utf-8 -*-
"""
test_v14.py —— 本职技能「拔尖优先」（取代旧的「广度优先」）

玩家反馈：「之前修改的逻辑很容易变成多个本职点数全都是50点，
          我的本意是本职技能要有几个拔尖的（比如可以接近上限）」。
要求：① 点数仍然必须 100% 用完；② 2-4 项本职技能拔尖（接近上限）；
      ③ 别的职业技能可以不加点、或总值低于 50；④ 兴趣技能不受限制。

覆盖：
  1. 随机卡：点数全用完 + 至少 2 项 ≥50 + 最高项明显拔高（≥70）+ 无同值墙
  2. AI 卡：同样的判据（走真实链路 mock fetch）
  3. 带「每项本职技能上限 80」：拔尖项贴近 80 而不越过，且仍 ≥2 项 ≥50
  4. 低预算（属性很差的角色）：预算不够时也不能退化成「只有 1 项达标」
  5. 不存在「一摞技能全卡在 50」的回归：恰好等于 50 的项数很少
  6. 全部卡通过 Engine.checkList
  7. 兴趣技能不受「50」约束（兴趣点照样花完，项数 ≤10）
"""
import os
import asyncio, os
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:%d/index.html" % int(os.environ.get("COC_STATIC_PORT") or 8899)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots14")
os.makedirs(OUT, exist_ok=True)

errors = []
results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("  [OK] " if ok else "  [!!] ") + name + (("  <- " + str(detail)) if detail else ""))


# 一张卡的「拔尖」体检表
PEAK_JS = """(c) => {
  const OCC = CocOccupation, SM = SkillModel, R = COC7;
  const set = OCC.occupationalSet(c);
  const op = OCC.occupationPoints(c);
  const ip = OCC.interestPoints(c);
  const occ = [];
  let intCount = 0;
  (c.skills || []).forEach(s => {
    if (s.id === 'credit' || s.id === 'cthulhu' || R.isGrowthOnly(s.id)) return;
    if (set[s.key] || set[s.id]) occ.push(s.total);
    else if ((s.int || 0) > 0) intCount++;
  });
  occ.sort((a, b) => b - a);
  const cnt = {};
  occ.forEach(v => { cnt[v] = (cnt[v] || 0) + 1; });
  let maxSame = 0;
  Object.keys(cnt).forEach(k => { if (cnt[k] > maxSame) maxSame = cnt[k]; });
  let occOver = 0;
  (c.skills || []).forEach(s => {
    if (s.id === 'credit' || s.id === 'cthulhu' || R.isGrowthOnly(s.id)) return;
    if (!(set[s.key] || set[s.id])) return;
    if (s.total > SM.capOf(c, s)) occOver++;
  });
  /* 这张卡的预算「够不够把两项本职垫到 50」—— 不够就不该拿「≥2 项 ≥50」去判它。
     预算 = 职业点池总额 - 信用评级占用的那一部分（信用评级是先扣的）。 */
  const creditUsed = (c.skills || []).reduce((a, s) => a + (s.creditOcc || 0), 0);
  const budget0 = Math.max(0, op.total - creditUsed);
  const need50 = [];
  (c.skills || []).forEach(s => {
    if (s.id === 'credit' || s.id === 'cthulhu' || R.isGrowthOnly(s.id)) return;
    if (R.capExempt(s.id)) return;
    if (!(set[s.key] || set[s.id])) return;
    const cap = SM.capOf(c, s);
    if (cap < 50) return;
    need50.push(Math.max(0, Math.min(50, cap) - (s.base || 0)));
  });
  need50.sort((a, b) => a - b);
  const feas2 = need50.length >= 2 && (need50[0] + need50[1] <= budget0);
  return {
    n: occ.length,
    ge50: occ.filter(v => v >= 50).length,
    eq50: occ.filter(v => v === 50).length,
    top: occ[0] || 0,
    maxSame: maxSame,
    occRemain: op.total - op.used,
    intRemain: ip.total - ip.used,
    occOver: occOver,
    intCount: intCount,
    feas2: feas2,
    budget0: budget0,
    totals: occ,
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

        await page.goto(BASE)
        await page.wait_for_timeout(1200)
        await page.evaluate("()=>{try{localStorage.clear()}catch(e){}}")
        await page.reload()
        await page.wait_for_timeout(1200)

        # =========================================================
        # 1. 随机卡：点数用完 + 拔尖
        # =========================================================
        print("\n== 1、随机卡：点数用完 + 拔尖 ==")
        rnd = await page.evaluate("""async () => {
          const f = /*PEAK*/;
          const out = {n:0, left:0, unsound:0, thin:0, infeas:0, lowTop:0, wall:0,
                       sumGe50:0, sumTop:0, sumEq50:0, maxSame:0, samples:[]};
          for (let i = 0; i < 80; i++) {
            const c = PresetGen.generateOne({ctx:{used:{}}});
            if (!c) continue;
            const r = f(c);
            out.n++;
            if (r.occRemain !== 0 || r.intRemain !== 0) out.left++;
            if (r.bad.length) out.unsound++;
            if (r.ge50 < 2) { if (r.feas2) out.thin++; else out.infeas++; }
            if (r.top < 70) out.lowTop++;
            if (r.eq50 >= 4) out.wall++;
            out.sumGe50 += r.ge50;
            out.sumTop += r.top;
            out.sumEq50 += r.eq50;
            out.maxSame = Math.max(out.maxSame, r.maxSame);
            if (out.samples.length < 5) out.samples.push(r.totals);
          }
          return out;
        }""".replace("/*PEAK*/", PEAK_JS))

        print("     %s 张：点数有剩余 %s · 不合格 %s · 预算不够 2 项到 50 的 %s 张" %
              (rnd["n"], rnd["left"], rnd["unsound"], rnd["infeas"]))
        print("     ≥50 平均 %.2f 项 · 最高项平均 %.1f · 恰好=50 平均 %.2f 项" %
              (rnd["sumGe50"] / rnd["n"], rnd["sumTop"] / rnd["n"], rnd["sumEq50"] / rnd["n"]))
        for s in rnd["samples"]:
            print("       样例：" + str(s))
        check("★ 职业点与兴趣点 100% 用完", rnd["left"] == 0, rnd["left"])
        check("★ 全部通过完整性校验", rnd["unsound"] == 0, rnd["unsound"])
        check("★ 只要预算够，每张卡至少 2 项本职技能 ≥ 50", rnd["thin"] == 0,
              "预算够却没做到的有 %s 张" % rnd["thin"])
        check("★ 最高一项平均 ≥ 70（拔尖）",
              rnd["sumTop"] / rnd["n"] >= 70, round(rnd["sumTop"] / rnd["n"], 1))
        check("★ 多数卡的最高项 ≥ 70", rnd["lowTop"] <= rnd["n"] * 0.25,
              "低于 70 的有 %s/%s 张" % (rnd["lowTop"], rnd["n"]))
        check("★ 没有「≥4 项都卡在 50」的同值墙", rnd["wall"] == 0, rnd["wall"])
        check("★ 平均「恰好 50」的项数 < 2", rnd["sumEq50"] / rnd["n"] < 2,
              round(rnd["sumEq50"] / rnd["n"], 2))

        # =========================================================
        # 2. AI 卡（真实链路）
        # =========================================================
        print("\n== 2、AI 卡 ==")
        ai = await page.evaluate("""async () => {
          const f = /*PEAK*/;
          const raw = {
            name: '陆知远', gender: '男', age: 36,
            residence: '上海', birthplace: '宁波',
            setting: 'cn-republic', occupationName: '私家侦探',
            attributes: {str:60,con:65,siz:60,dex:70,app:60,int:70,pow:60,edu:70,luck:55},
            background: {description:'风衣旧了',ideology:'信念：真相',
              significantPeople:'线人｜合作五年｜仍联系', meaningfulPlaces:'码头｜雾｜线索',
              treasuredPossessions:'左轮｜祖传｜随身', traits:'冷静、多疑',
              wounds:'旧枪伤', phobias:'无。', history:'查了十年案。'}
          };
          window.fetch = async () => new Response(JSON.stringify({
            choices:[{message:{content: JSON.stringify(raw)}, finish_reason:'stop'}]
          }), {status:200, headers:{'Content-Type':'application/json'}});
          await Store.setSettings({aiBase:'https://api.test.invalid/v1',
            aiModel:'m', aiKey:'sk-test', aiAttrCap:0, aiOccPtsCap:0, aiIntPtsCap:0});
          const res = await AIGen.makeCharacter('一个民国的私家侦探', ()=>{});
          return f(res.character);
        }""".replace("/*PEAK*/", PEAK_JS))
        print("     职业点剩 %s · 兴趣点剩 %s · 本职 %s 项（≥50 的 %s 项，最高 %s）" %
              (ai["occRemain"], ai["intRemain"], ai["n"], ai["ge50"], ai["top"]))
        print("     明细：" + str(ai["totals"]))
        check("★ AI 卡点数全部用完", ai["occRemain"] == 0 and ai["intRemain"] == 0, ai)
        check("★ AI 卡至少 2 项 ≥ 50", ai["ge50"] >= 2, ai["ge50"])
        check("★ AI 卡有拔尖项（最高 ≥ 70）", ai["top"] >= 70, ai["top"])
        check("★ AI 卡通过完整性校验", len(ai["bad"]) == 0, ai["bad"])

        # =========================================================
        # 3. 带上限 80：拔尖项贴近上限且不越界
        # =========================================================
        print("\n== 3、AI 卡 + 每项本职技能上限 80 ==")
        capped = await page.evaluate("""async () => {
          const f = /*PEAK*/;
          const out = {n:0, over:0, topMax:0, thin:0, left:0, ge50sum:0, topMin:999};
          for (let i = 0; i < 25; i++) {
            const raw = {
              name: '甲' + i, gender: '男', age: 30 + (i % 20),
              residence: '上海', birthplace: '杭州',
              setting: 'cn-republic', occupationName: '私家侦探',
              attributes: {str:65,con:70,siz:60,dex:75,app:60,int:75,pow:65,edu:80,luck:60},
              background: {description:'瘦高',ideology:'信念：真相',
                significantPeople:'委托人｜时好时坏｜仍在追', meaningfulPlaces:'码头｜雾｜线索',
                treasuredPossessions:'左轮｜旧｜祖上留下', traits:'谨慎、多疑',
                wounds:'枪伤', phobias:'无。', history:'十年前办错一案。'}
            };
            window.fetch = async () => new Response(JSON.stringify({
              choices:[{message:{content: JSON.stringify(raw)}, finish_reason:'stop'}]
            }), {status:200, headers:{'Content-Type':'application/json'}});
            await Store.setSettings({aiBase:'https://api.test.invalid/v1',
              aiModel:'m', aiKey:'sk-test', aiAttrCap:0,
              aiOccPtsCap:80, aiIntPtsCap:60});
            const res = await AIGen.makeCharacter('私家侦探', ()=>{});
            const r = f(res.character);
            out.n++;
            out.over += r.occOver;
            if (r.ge50 < 2) out.thin++;
            if (r.occRemain !== 0) out.left++;
            out.ge50sum += r.ge50;
            out.topMax = Math.max(out.topMax, r.top);
            out.topMin = Math.min(out.topMin, r.top);
          }
          return out;
        }""".replace("/*PEAK*/", PEAK_JS))
        print("     %s 张：超上限项 %s · ≥50 平均 %.2f 项 · 最高项 %s~%s · 剩点 %s" %
              (capped["n"], capped["over"], capped["ge50sum"] / capped["n"],
               capped["topMin"], capped["topMax"], capped["left"]))
        check("★ 上限 80：没有任何本职技能越界", capped["over"] == 0, capped["over"])
        check("★ 上限 80：每张卡仍有 ≥2 项 ≥ 50", capped["thin"] == 0, capped["thin"])
        check("★ 上限 80：点数用完", capped["left"] == 0, capped["left"])
        check("★ 上限 80：拔尖项贴近上限（最高 ≥ 70）", capped["topMin"] >= 70, capped["topMin"])
        check("★ 上限 80：拔尖项不超过上限", capped["topMax"] <= 80, capped["topMax"])

        # =========================================================
        # 4. 低预算也不能退化成「只有 1 项达标」
        # =========================================================
        print("\n== 4、低预算（属性很差）==")
        low = await page.evaluate("""async () => {
          const f = /*PEAK*/;
          const out = {n:0, thin:0, infeas:0, left:0, topMin:999, topMax:0, bad:0,
                       infeasTopMin:999};
          for (let i = 0; i < 25; i++) {
            const c = PresetGen.buildFrom({
              fromAI: true, occupationName: '记者', setting: 'cn-modern',
              age: 25 + (i % 10), gender: '男',
              attributes: {str:25,con:25,siz:25,dex:25,app:25,int:25,pow:25,edu:25,luck:25}
            }, 'cn-modern');
            if (!c) continue;
            const r = f(c);
            out.n++;
            if (r.ge50 < 2) {
              if (r.feas2) out.thin++;
              else { out.infeas++; out.infeasTopMin = Math.min(out.infeasTopMin, r.top); }
            }
            if (r.occRemain !== 0 || r.intRemain !== 0) out.left++;
            if (r.bad.length) out.bad++;
            out.topMin = Math.min(out.topMin, r.top);
            out.topMax = Math.max(out.topMax, r.top);
          }
          return out;
        }""".replace("/*PEAK*/", PEAK_JS))
        print("     %s 张：达标不足 2 项 %s（其中预算真不够的 %s）· 最高项 %s~%s · 剩点 %s · 不合格 %s" %
              (low["n"], low["thin"], low["infeas"], low["topMin"], low["topMax"],
               low["left"], low["bad"]))
        check("★ 低预算下：预算够的卡仍保证 ≥2 项 ≥ 50", low["thin"] == 0, low["thin"])
        check("★ 低预算下：预算真不够的卡也要有拔尖项（最高 ≥ 55）",
              low["infeas"] == 0 or low["infeasTopMin"] >= 55, low["infeasTopMin"])
        check("★ 低预算下点数仍然用完", low["left"] == 0, low["left"])
        check("★ 低预算下卡仍然合规", low["bad"] == 0, low["bad"])

        # =========================================================
        # 5. 兴趣技能不受「50」约束
        # =========================================================
        print("\n== 5、兴趣技能 ==")
        ii = await page.evaluate("""async () => {
          const f = /*PEAK*/;
          let worstInt = 0, left = 0, n = 0;
          for (let i = 0; i < 30; i++) {
            const c = PresetGen.generateOne({ctx:{used:{}}});
            if (!c) continue;
            const r = f(c);
            n++;
            worstInt = Math.max(worstInt, r.intCount);
            if (r.intRemain !== 0) left++;
          }
          return {n:n, worstInt:worstInt, left:left};
        }""".replace("/*PEAK*/", PEAK_JS))
        print("     %s 张：兴趣技能最多 %s 项 · 兴趣点有剩余 %s 张" %
              (ii["n"], ii["worstInt"], ii["left"]))
        check("★ 兴趣点照样全部用完", ii["left"] == 0, ii["left"])
        check("★ 拿到点的兴趣技能 ≤ 10 项", ii["worstInt"] <= 10, ii["worstInt"])

        # =========================================================
        # 6. 第 0 步卡片列表拿到的摘要也反映「拔尖」
        #    （summaryOf 的 topSkills 就是卡片上展示的那几项）
        # =========================================================
        print("\n== 6、卡片摘要（第 0 步展示用）==")
        summ = await page.evaluate("""async () => {
          let topMin = 999, topSum = 0, usedAll = 0, n = 0, bad = 0;
          const samples = [];
          for (let i = 0; i < 20; i++) {
            const c = PresetGen.generateOne({ctx:{used:{}}});
            if (!c) continue;
            const s = PresetGen.summaryOf(c);
            n++;
            if (s.occUsed === s.occTotal && s.intUsed === s.intTotal) usedAll++;
            const t = s.topSkills[0];
            if (t) { topSum += t.total; if (t.total < topMin) topMin = t.total; }
            if (samples.length < 4) {
              samples.push(s.topSkills.map(x => x.name + ':' + x.total + (x.occ ? '(本职)' : '')));
            }
          }
          return {n:n, topMin:topMin, topSum:topSum, usedAll:usedAll, samples:samples, bad:bad};
        }""")
        print("     %s 张：卡片展示的最高项 %s~ 平均 %.1f · 点数用完 %s 张" %
              (summ["n"], summ["topMin"], summ["topSum"] / summ["n"], summ["usedAll"]))
        for s in summ["samples"]:
            print("       样例：" + "、".join(s))
        check("★ 卡片展示的最高一项平均 ≥ 70（拔尖）",
              summ["topSum"] / summ["n"] >= 70, round(summ["topSum"] / summ["n"], 1))
        check("★ 卡片展示的最高一项不会太平（最低 ≥ 55）", summ["topMin"] >= 55, summ["topMin"])
        check("★ 摘要里的点数状态是「已用完」", summ["usedAll"] == summ["n"], summ["usedAll"])
        await shot("v14_01_cards")

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
