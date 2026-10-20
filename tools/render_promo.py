# -*- coding: utf-8 -*-
"""把 tools/promo/ 下的排版 HTML 渲染成 PNG。

两个版面：
  promo-16x9.html → 1920×1080（配图 / 视频封面 / 横屏轮播）
  promo-9x16.html → 1080×1920（竖屏短视频封面 / 朋友圈）

每个版面出 1x 与 2x 两张：1x 看排版，2x 用来发布（平台压缩后仍然清晰）。

用法：先起静态服务（web/ 目录，8899）截好素材，再
      python tools/render_promo.py
"""
import asyncio, os, sys
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
PROMO = os.path.join(HERE, "promo")

PAGES = [
    ("promo-16x9.html", 1920, 1080, "promo-16x9"),
    ("promo-9x16.html", 1080, 1920, "promo-9x16"),
]


async def render(html, w, h, stem):
    path = os.path.join(PROMO, html)
    if not os.path.exists(path):
        print("找不到排版文件：", path)
        return False

    for scale, out in ((1, os.path.join(PROMO, stem + ".png")),
                       (2, os.path.join(PROMO, stem + "-2x.png"))):
        async with async_playwright() as p:
            b = await p.chromium.launch()
            c = await b.new_context(
                viewport={"width": w, "height": h},
                device_scale_factor=scale)
            pg = await c.new_page()
            await pg.goto("file:///" + path.replace("\\", "/"))
            # 等图片真正解码完成，否则截出来是空的
            await pg.wait_for_function(
                "()=>[...document.images].every(i=>i.complete && i.naturalWidth>0)",
                timeout=30000)
            await pg.wait_for_timeout(1200)

            # 自检：任何一张图没加载出来就直接退出，别产出「黑条图」
            info = await pg.evaluate(
                "()=>[...document.images].map(i=>({src:i.src.split('/').pop(), w:i.naturalWidth}))")
            bad = [i for i in info if i["w"] == 0]
            if bad:
                print("有图片没加载出来，先别发布：", bad)
                await b.close()
                return False

            await pg.screenshot(path=out)
            await b.close()
        print("%-28s %7.0f KB" % (os.path.basename(out), os.path.getsize(out) / 1024))
    return True


async def main():
    ok = True
    for html, w, h, stem in PAGES:
        print("== %s  (%dx%d) ==" % (html, w, h))
        if not await render(html, w, h, stem):
            ok = False
    if not ok:
        sys.exit(1)


asyncio.run(main())
