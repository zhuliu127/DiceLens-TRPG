# -*- coding: utf-8 -*-
"""把 promo-selling-16x9.html 里的 8 张卖点图逐张渲染成 PNG。

与 render_promo.py 的区别：
  · 那边是「一个 HTML = 一张图」，这边是「一个 HTML 里 8 个 section = 8 张图」，
    所以按元素截图，而不是整页截图；
  · 每张出 1x（1920×1080）与 2x（3840×2160）。

内置四道自检（图没加载 / 长图尺寸标注过期 / 内容出画布 / 栏目串位 都直接退出，不出图）：
  1. 任何一张图 naturalWidth === 0 → 失败（历史上出过「渲染成功但图是黑条」）
  2. 图上标注的长图像素尺寸与 v_12_longimg.png 实际尺寸不一致 → 失败
  3. 各栏外接框越出 1920×1080 → 说明有内容被裁掉了
  4. 左栏文案压到页脚 / 左右两栏挨太近 / 舞台压到右下印章 → 版面串位

⚠️ 判溢出不能用 scrollWidth/scrollHeight：.bg-rings 这类装饰元素故意伸到画布外，
   靠 overflow:hidden 裁掉，但 scrollWidth 会把它算进来（每张都误报 +260）。
   要量 boundingClientRect；而且多页是纵向排列的，必须减去本页 top 才是页内坐标。

用法：python tools/render_promo_selling.py
"""
import asyncio, os, sys
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
PROMO = os.path.join(HERE, "promo")
OUT = os.path.join(PROMO, "selling")
HTML = os.path.join(PROMO, "promo-selling-16x9.html")
W, H = 1920, 1080

MEASURE = """()=>{
    const out = [];
    document.querySelectorAll('.slide').forEach(function(s){
        const sr = s.getBoundingClientRect();
        function rel(el){
            const r = el.getBoundingClientRect();
            return { t: Math.round(r.top - sr.top),    b: Math.round(r.bottom - sr.top),
                     l: Math.round(r.left - sr.left),  r: Math.round(r.right - sr.left) };
        }
        const copy  = s.querySelector('.copy');
        const foot  = s.querySelector('.foot');
        const stage = s.querySelector('.stage');
        const top   = s.querySelector('.top');
        const seal  = s.querySelector('.seal');

        let maxR = 0, maxB = 0, minL = 1e9, minT = 1e9;
        [copy, foot, stage, top, seal].forEach(function(el){
            if (!el) return;
            const r = rel(el);
            maxR = Math.max(maxR, r.r); maxB = Math.max(maxB, r.b);
            minL = Math.min(minL, r.l); minT = Math.min(minT, r.t);
        });

        const r = { name: s.dataset.name, id: s.id,
                    overR: maxR - 1920, overB: maxB - 1080,
                    underL: -minL, underT: -minT,
                    sealTop: seal ? rel(seal).t : null };
        if (copy && foot)  r.copyVsFoot = rel(foot).t - rel(copy).b;
        if (copy && stage) r.gutter     = rel(stage).l - rel(copy).r;
        if (stage)         { const st = rel(stage); r.stageBottom = st.b; r.stageRight = st.r; }
        out.push(r);
    });
    return out;
}"""


async def main():
    if not os.path.exists(HTML):
        print("找不到排版文件：", HTML)
        sys.exit(1)
    os.makedirs(OUT, exist_ok=True)

    # 「一键长图」那张会在图上标注长图的真实像素尺寸。
    # 长图是随机角色导出的，行数随技能条数变化 —— 重截素材后这个数字会变，
    # 忘了同步就会出现「图上写着 1440×2136、其实文件是 1440×2240」这种硬伤。
    # 所以这里直接拿真文件量，和 HTML 里写的对不上就不出图。
    try:
        from PIL import Image
    except ImportError:
        print("需要 pillow 才能核对长图尺寸：pip install pillow")
        sys.exit(1)
    longimg = os.path.join(PROMO, "v_12_longimg.png")
    lw, lh = Image.open(longimg).size
    declared = "%d × %d px" % (lw, lh)
    html = open(HTML, encoding="utf-8").read()
    if declared not in html:
        print("[!!] 长图尺寸对不上：文件实际是 %s，但 HTML 里没有这串标注。" % declared)
        print("     改 promo-selling-16x9.html 里「实际导出效果」那行，或重跑 shoot_promo_extra.py。")
        sys.exit(1)
    print("长图尺寸核对通过：%s" % declared)

    ok = True
    async with async_playwright() as p:
        for scale in (1, 2):
            b = await p.chromium.launch()
            c = await b.new_context(viewport={"width": W, "height": H},
                                    device_scale_factor=scale)
            pg = await c.new_page()
            await pg.goto("file:///" + HTML.replace("\\", "/"))
            await pg.wait_for_function(
                "()=>[...document.images].every(i=>i.complete && i.naturalWidth>0)",
                timeout=30000)
            await pg.wait_for_timeout(1000)

            # ---- 自检 1：图片真的解码了 ----
            bad = await pg.evaluate(
                "()=>[...document.images].filter(i=>i.naturalWidth===0)"
                ".map(i=>i.src.split('/').pop())")
            if bad:
                print("[!!] 有图片没加载出来：", bad)
                ok = False

            report = await pg.evaluate(MEASURE)
            suffix = "" if scale == 1 else "-2x"

            if scale == 1:
                for r in report:
                    problems = []
                    if r["overR"] > 0 or r["overB"] > 0:
                        problems.append("内容越出画布 右%+d 下%+d" % (r["overR"], r["overB"]))
                    if r["underL"] > 0 or r["underT"] > 0:
                        problems.append("内容越出画布 左%+d 上%+d" % (r["underL"], r["underT"]))
                    if r.get("copyVsFoot") is not None and r["copyVsFoot"] < 12:
                        problems.append("左栏压到页脚（间距 %d）" % r["copyVsFoot"])
                    if r.get("gutter") is not None and r["gutter"] < 40:
                        problems.append("左右两栏挨太近（间距 %d）" % r["gutter"])
                    if r.get("sealTop") is not None and r.get("stageBottom", 0) > r["sealTop"]:
                        problems.append("舞台压到右下印章（%d > %d）" % (r["stageBottom"], r["sealTop"]))
                    if r.get("stageRight", 0) > 1834:
                        problems.append("舞台右侧越界（%d > 1834）" % r["stageRight"])
                    flag = "OK  " if not problems else "[!!]"
                    print("%s %-18s copy2foot %4s  gutter %4s  stage %s,%s  seal %s" % (
                        flag, r["name"], r.get("copyVsFoot"), r.get("gutter"),
                        r.get("stageRight"), r.get("stageBottom"), r.get("sealTop")))
                    if problems:
                        ok = False
                        print("       -> " + "；".join(problems))

            # ---- 出图 ----
            for r in report:
                el = await pg.query_selector('#' + r["id"])
                if el is None:
                    print("[!!] 找不到 section #%s" % r["id"])
                    ok = False
                    continue
                await el.screenshot(path=os.path.join(OUT, r["name"] + suffix + ".png"))
            await b.close()

    print("")
    for f in sorted(os.listdir(OUT)):
        if f.endswith(".png"):
            print("%-26s %7.0f KB" % (f, os.path.getsize(os.path.join(OUT, f)) / 1024))

    if not ok:
        print("RESULT: FAIL")
        sys.exit(1)
    print("RESULT: PASS")


asyncio.run(main())
