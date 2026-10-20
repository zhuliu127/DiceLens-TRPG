# -*- coding: utf-8 -*-
"""
test_v12.py —— 技能点必须全部用完 + 本职技能「拔尖」

用户反馈：「AI生成角色卡还是会出现有很多技能点（职业和兴趣）没有用完」。
根因：AI 设置里的「技能上限」语义澄清 —— 它是**每一项技能最终值**的上限，
      不是「压缩点数总额」。旧实现压了总额，界面显示「职业点 100/400」，
      看着像有 300 点没用完。

⚠️ v1.13 追加的反馈：「之前修改的逻辑很容易变成多个本职点数全都是50点，
   我的本意是本职技能要有几个拔尖的（比如可以接近上限）」。
   所以本站的判据从「广度优先（达标项数达到预算上界）」改成
   「拔尖优先（至少 2 项 ≥50，且最高一项明显拔高，不再是一堵 50 的墙）」。

覆盖：
  1. 随机生成的卡：职业点 / 兴趣点剩余都是 0
  2. 随机卡的本职技能：至少 2 项 ≥ 50，最高一项平均 ≥ 70（拔尖）
  3. AI 卡（无上限）：点数用完 + 同样的拔尖判据
  4. AI 卡带上限：**点数总额不受影响**，且没有技能超过上限
  5. 极端小上限（如 1）不报错；剩点只能是因为技能全到顶
  6. 界面显示的「职业点 used/total」与数据层一致 —— 由 test_v13 覆盖
  7. 老存档（无上限字段）行为不变、上限回落到 99
  8. 兴趣技能真正拿到点的项数 ≤ 10
"""
import os
import asyncio, json, os
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:%d/index.html" % int(os.environ.get("COC_STATIC_PORT") or 8899)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots12")
os.makedirs(OUT, exist_ok=True)

errors = []
results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("  [OK] " if ok else "  [!!] ") + name + (("  <- " + str(detail)) if detail else ""))


# 在页面里跑的统计脚本：一次算完一张卡的全部指标。
# reachBest = 只看预算、不看分配算法时，最多能有几项达到 50。
# ⚠️ 只用于日志对照，**不再作为通过判据** —— 新算法是拔尖优先，
#    刻意不追求这个上界（追求它就会退回「一摞 50」的旧形态）。
# ⚠️ 成本必须按**原始 base** 算，不能用分配后的 total。
STATS_JS = """(c) => {
  const OCC = CocOccupation, SM = SkillModel, R = COC7;
  const set = OCC.occupationalSet(c);
  const op = OCC.occupationPoints(c);
  const ip = OCC.interestPoints(c);
  let ge50 = 0, below = 0, free = 0, withInt = 0, eq50 = 0;
  const need = [];
  (c.skills || []).forEach(s => {
    if (s.id === 'credit' || s.id === 'cthulhu' || R.isGrowthOnly(s.id)) return;
    if (set[s.key] || set[s.id]) {
      if (s.total >= 50) ge50++; else below++;
      if (s.total === 50) eq50++;
      const b = s.base || 0;
      if (b >= 50) free++;
      else need.push(Math.max(0, Math.min(50 - b, SM.capOf(c, s) - b)));
    } else if ((s.int || 0) > 0) withInt++;
  });
  need.sort((a, b) => a - b);
  const budget = op.total - (parseInt(c.assets.creditRating, 10) || 0);
  let reach = free, acc = 0;
  for (let i = 0; i < need.length; i++) {
    if (acc + need[i] > budget) break;
    acc += need[i]; reach++;
  }
  /* 逐项上限：技能有没有超过它自己的有效上限（capOf） */
  let occOver = 0, intOver = 0, occMax = 0, intMax = 0;
  (c.skills || []).forEach(s => {
    if (s.id === 'credit' || s.id === 'cthulhu' || R.isGrowthOnly(s.id)) return;
    const isOcc = !!(set[s.key] || set[s.id]);
    const cap = SM.capOf(c, s);
    if (isOcc) {
      if (s.total > cap) occOver++;
      if (s.total > occMax) occMax = s.total;
    } else if ((s.int || 0) > 0) {
      if (s.total > cap) intOver++;
      if (s.total > intMax) intMax = s.total;
    }
  });
  /* 点数总额是否被上限改动 —— 必须在**同一张卡**上清掉上限再比。
     另build 一次来比没有意义：教育进步检定是随机的，
     两次调用的 EDU 可能不同，公式算出的总额本来就可能不一样。 */
  const keepOcc = c.skillCapOcc, keepInt = c.skillCapInterest;
  const occTotalCapped = op.total, intTotalCapped = ip.total;
  c.skillCapOcc = 99; c.skillCapInterest = 99;
  const occTotalPlain = OCC.occupationPoints(c).total;
  const intTotalPlain = OCC.interestPoints(c).total;
  c.skillCapOcc = keepOcc; c.skillCapInterest = keepInt;
  return {
    occUsed: op.used, occTotal: op.total, intUsed: ip.used, intTotal: ip.total,
    occRemain: op.total - op.used, intRemain: ip.total - ip.used,
    ge50: ge50, below: below, withInt: withInt, reachBest: reach, eq50: eq50,
    occOver: occOver, intOver: intOver, occMax: occMax, intMax: intMax,
    occTotalPlain: occTotalPlain, intTotalPlain: intTotalPlain,
    occTotalCapped: occTotalCapped, intTotalCapped: intTotalCapped,
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
        # 清干净环境，避免老存档干扰
        await page.evaluate("()=>{try{localStorage.clear()}catch(e){}}")
        await page.reload()
        await page.wait_for_timeout(1200)

        # =========================================================
        # 1. 随机生成的卡：点数必须用完 + 本职技能拔尖
        # =========================================================
        print("\n== 1、随机生成：点数用完 + 拔尖 ==")
        rnd = await page.evaluate("""async () => {
          const f = %s;
          const out = {n:0, occLeft:0, intLeft:0, unsound:0, thin:0, lowTop:0,
                       sumGE50:0, sumBelow:0, sumTop:0, sumEq50:0, wall:0, worstBad:[]};
          for (let i = 0; i < 60; i++) {
            const c = PresetGen.generateOne({ctx:{used:{}}});
            if (!c) continue;
            const r = f(c);
            out.n++;
            if (r.occRemain !== 0) out.occLeft++;
            if (r.intRemain !== 0) out.intLeft++;
            if (r.bad.length) { out.unsound++; if (out.worstBad.length < 3) out.worstBad = out.worstBad.concat(r.bad); }
            /* ★ 拔尖判据：至少 2 项 ≥50，且最高一项拔得起来 */
            if (r.ge50 < 2) out.thin++;
            if (r.occMax < 70) out.lowTop++;
            if (r.eq50 >= 4) out.wall++;
            out.sumGE50 += r.ge50;
            out.sumBelow += r.below;
            out.sumTop += r.occMax;
            out.sumEq50 += r.eq50;
          }
          return out;
        }""" % STATS_JS)

        print("     %s 张：职业点剩 %s · 兴趣点剩 %s · 不合格 %s" %
              (rnd["n"], rnd["occLeft"], rnd["intLeft"], rnd["unsound"]))
        print("     平均 ≥50 的本职技能 %.2f 项，低于 50 的平均 %.2f 项，最高项平均 %.1f，恰好=50 平均 %.2f 项" %
              (rnd["sumGE50"] / rnd["n"], rnd["sumBelow"] / rnd["n"],
               rnd["sumTop"] / rnd["n"], rnd["sumEq50"] / rnd["n"]))
        check("★ 随机卡职业点全部用完", rnd["occLeft"] == 0, rnd["occLeft"])
        check("★ 随机卡兴趣点全部用完", rnd["intLeft"] == 0, rnd["intLeft"])
        check("★ 随机卡全部通过完整性校验", rnd["unsound"] == 0, rnd["worstBad"])
        check("★ 每张卡都至少有 2 项本职技能 ≥ 50", rnd["thin"] == 0, rnd["thin"])
        check("★ 本职最高一项平均 ≥ 70（拔尖，不再是摊平到 50）",
              rnd["sumTop"] / rnd["n"] >= 70, round(rnd["sumTop"] / rnd["n"], 1))
        check("★ 没有「≥4 项都卡在 50」的同值墙", rnd["wall"] == 0, rnd["wall"])

        # =========================================================
        # 2. AI 卡（无上限）
        # =========================================================
        print("\n== 2、AI 卡（无上限）==")
        # 走真实链路：mock fetch 让「模型」返回一张合规的卡
        ai = await page.evaluate("""async () => {
          const f = %s;
          const raw = {
            name: '沈慕青', gender: '女', age: 31,
            residence: '上海', birthplace: '苏州',
            setting: 'cn-republic', occupationName: '记者',
            attributes: {str:50,con:60,siz:55,dex:65,app:70,int:80,pow:60,edu:75,luck:55},
            background: {description:'短发',ideology:'信念：真相',
              significantPeople:'同事｜共事三年｜仍在联系', meaningfulPlaces:'报社｜老楼｜归宿',
              treasuredPossessions:'钢笔｜旧｜父亲留下的', traits:'执拗、克制',
              wounds:'旧伤', phobias:'无。', history:'入行十年。'}
          };
          window.fetch = async () => new Response(JSON.stringify({
            choices:[{message:{content: JSON.stringify(raw)}, finish_reason:'stop'}]
          }), {status:200, headers:{'Content-Type':'application/json'}});
          await Store.setSettings({aiBase:'https://api.test.invalid/v1',
            aiModel:'m', aiKey:'sk-test', aiAttrCap:0, aiOccPtsCap:0, aiIntPtsCap:0});
          const res = await AIGen.makeCharacter('一个民国女记者', ()=>{});
          return f(res.character);
        }""" % STATS_JS)

        print("     职业点 %s/%s · 兴趣点 %s/%s · 本职 ≥50 %s 项（上界参照 %s）· 最高 %s" %
              (ai["occUsed"], ai["occTotal"], ai["intUsed"], ai["intTotal"],
               ai["ge50"], ai["reachBest"], ai["occMax"]))
        check("★ AI 卡职业点全部用完", ai["occRemain"] == 0, ai["occRemain"])
        check("★ AI 卡兴趣点全部用完", ai["intRemain"] == 0, ai["intRemain"])
        check("★ AI 卡通过完整性校验", len(ai["bad"]) == 0, ai["bad"])
        check("★ AI 卡至少 2 项本职技能 ≥ 50", ai["ge50"] >= 2, ai["ge50"])
        check("★ AI 卡有拿得出手的拔尖技能（最高 ≥ 70）", ai["occMax"] >= 70, ai["occMax"])
        # 不设上限时不该出现任何技能上限（默认 99）
        ai2 = await page.evaluate("""() => {
          const c = PresetGen.buildFrom({
            fromAI:true, occupationName:'记者', setting:'cn-republic', age:31,
            gender:'女', attributes:{str:55,con:60,siz:55,dex:65,app:70,int:80,pow:60,edu:75,luck:55}
          }, 'cn-republic', {});
          return {occCap:c.skillCapOcc||0, intCap:c.skillCapInterest||0};
        }""")
        check("★ 不设上限时不写任何技能上限",
              ai2["occCap"] == 99 and ai2["intCap"] == 99, ai2)

        # =========================================================
        # 3. AI 卡带技能上限
        # ⚠️ 语义：上限是「**每项技能**封顶」，**不压缩点数总额**。
        #    所以这里要断言 total 与无上限时一致，而不是「total <= 上限」。
        # =========================================================
        print("\n== 3、AI 卡带技能上限 ==")
        for cap in (99, 80, 60):
            capped = await page.evaluate("""async (cap) => {
              const f = %s;
              const raw = {
                name: '顾长明', gender: '男', age: 38,
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
                aiOccPtsCap:cap, aiIntPtsCap:cap});
              const res = await AIGen.makeCharacter('民国私家侦探', ()=>{});
              return f(res.character);
            }""" % STATS_JS, cap)

            print("     上限 %s → 职业点 %s/%s · 兴趣点 %s/%s · 本职最高 %s · 兴趣最高 %s" %
                  (cap, capped["occUsed"], capped["occTotal"],
                   capped["intUsed"], capped["intTotal"],
                   capped.get("occMax"), capped.get("intMax")))
            # ★ 新语义的核心：同一张卡上清掉上限后，总额必须一模一样
            check("★ 上限 %s：职业点总额不受上限影响" % cap,
                  capped["occTotal"] == capped["occTotalPlain"],
                  "%s vs 清掉上限后 %s" % (capped["occTotal"], capped["occTotalPlain"]))
            check("★ 上限 %s：兴趣点总额不受上限影响" % cap,
                  capped["intTotal"] == capped["intTotalPlain"],
                  "%s vs 清掉上限后 %s" % (capped["intTotal"], capped["intTotalPlain"]))
            check("★ 上限 %s：没有技能超过上限" % cap,
                  capped.get("occOver", 0) == 0 and capped.get("intOver", 0) == 0,
                  "occ %s / int %s" % (capped.get("occOver"), capped.get("intOver")))
            check("★ 上限 %s：点数用完" % cap,
                  capped["occRemain"] == 0 and capped["intRemain"] == 0,
                  "%s / %s" % (capped["occRemain"], capped["intRemain"]))
            check("★ 上限 %s：卡通过完整性校验" % cap, len(capped["bad"]) == 0, capped["bad"])

        # =========================================================
        # 4. 极端上限：不能报错
        # ⚠️ 上限压得极低时点数**必然用不完**（所有技能都到顶了），
        #    那是规则使然，不该断言「用满」—— 要断言的是「不报错、且剩下的原因是到顶」。
        # =========================================================
        print("\n== 4、极端小上限（技能会全部到顶，点数用不完是正常的）==")
        for cap in (1, 20):
            tiny = await page.evaluate("""async (cap) => {
              const f = %s;
              const raw = {
                name: '小可', gender: '女', age: 26,
                residence:'苏州', birthplace:'苏州',
                setting:'cn-modern', occupationName:'法医',
                attributes:{str:55,con:65,siz:55,dex:60,app:65,int:80,pow:60,edu:80,luck:50},
                background:{description:'素净',ideology:'信念：证据',
                  significantPeople:'同事｜默契｜常在', meaningfulPlaces:'解剖室｜冷｜日常',
                  treasuredPossessions:'手术刀｜快｜自用', traits:'冷静、洁癖',
                  wounds:'无。', phobias:'无。', history:'入行五年。'}
              };
              window.fetch = async () => new Response(JSON.stringify({
                choices:[{message:{content: JSON.stringify(raw)}, finish_reason:'stop'}]
              }), {status:200, headers:{'Content-Type':'application/json'}});
              await Store.setSettings({aiBase:'https://api.test.invalid/v1',
                aiModel:'m', aiKey:'sk-test', aiAttrCap:0,
                aiOccPtsCap:cap, aiIntPtsCap:cap});
              try {
                const res = await AIGen.makeCharacter('法医', ()=>{});
                const c = res.character;
                /* 所有可加点技能是否都已到顶 —— 有剩点时必须为 true */
                const set = CocOccupation.occupationalSet(c);
                const list = (c.skills||[]).filter(s =>
                  s.id!=='credit' && s.id!=='cthulhu' && !COC7.isGrowthOnly(s.id));
                const occList = list.filter(s=>set[s.key]||set[s.id]);
                const allCapped = occList.length>0 &&
                  occList.every(s=>s.total >= SkillModel.capOf(c,s));
                return Object.assign(f(c), {err:'', allCapped:allCapped});
              } catch (e) { return {err: String(e && e.message || e)}; }
            }""" % STATS_JS, cap)
            if tiny.get("err"):
                check("★ 极端上限 %s 不抛错" % cap, False, tiny["err"])
            else:
                print("     上限 %s → 职业点 %s/%s（剩 %s）· 全部到顶=%s · 不合格 %s" %
                      (cap, tiny["occUsed"], tiny["occTotal"], tiny["occRemain"],
                       tiny["allCapped"], tiny["bad"]))
                check("★ 极端上限 %s：卡通过完整性校验" % cap, len(tiny["bad"]) == 0, tiny["bad"])
                if tiny["occRemain"] == 0:
                    check("★ 极端上限 %s：点数用完" % cap, True)
                else:
                    check("★ 极端上限 %s：剩点是因为所有本职技能都到顶" % cap,
                          tiny["allCapped"] is True, tiny)

        # =========================================================
        # 5. 老存档兼容
        # ⚠️ 前面几节往「AI 设置」里写过极限上限（1 / 20）。房规上限从
        #    v1.14 起对**随机卡**同样生效，不先清掉的话这里的随机卡会被
        #    封顶在 20 上、「点数用完」必然失败 —— 那是测试自己污染了环境。
        # =========================================================
        print("\n== 5、老存档兼容 ==")
        await page.evaluate("""()=>Store.setSettings({
            aiAttrCap:0, aiAttrCapWithLuck:true, aiOccPtsCap:0, aiIntPtsCap:0})""")
        await page.wait_for_timeout(200)
        legacy = await page.evaluate("""() => {
          const f = %s;
          const c = PresetGen.generateOne({ctx:{used:{}}});
          /* 老存档没有这些字段 */
          delete c.occPointCap; delete c.intPointCap;
          delete c.skillCapOcc; delete c.skillCapInterest; delete c.skillCap;
          const r = f(c);
          return {occTotal:r.occTotal, intTotal:r.intTotal,
                  occRemain:r.occRemain, intRemain:r.intRemain};
        }""" % STATS_JS)
        check("★ 没有上限字段的旧卡：total 正常",
              legacy["occTotal"] > 0 and legacy["intTotal"] > 0, legacy)
        check("★ 没有上限字段的旧卡：点数仍然用完",
              legacy["occRemain"] == 0 and legacy["intRemain"] == 0, legacy)

        # =========================================================
        # 6. 兴趣技能拿到点的项数 ≤ 10
        # =========================================================
        print("\n== 6、兴趣技能项数 ==")
        ints = await page.evaluate("""() => {
          const f = %s;
          let worst = 0, n = 0;
          for (let i = 0; i < 30; i++) {
            const c = PresetGen.generateOne({ctx:{used:{}}});
            if (!c) continue;
            n++;
            worst = Math.max(worst, f(c).withInt);
          }
          return {worst:worst, n:n};
        }""" % STATS_JS)
        print("     %s 张随机卡：真正拿到兴趣点的技能最多 %s 项" % (ints["n"], ints["worst"]))
        check("★ 拿到点的兴趣技能不超过 10 项", ints["worst"] <= 10, ints["worst"])

        await shot("v12_done")

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
