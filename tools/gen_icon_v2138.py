# -*- coding: utf-8 -*-
"""v2.13.8：用新图标「骰境：魔法D20冒险者」重切全套品牌图标。

背景（用户报「手机上看 app 的图标显示不完整」）：
  旧脚本 tools/gen_icon.py 的两个问题——
  ① 旧源图内容顶到画边：系统按圆形 / 圆角矩形 / 方形遮罩裁切时，
     灯笼、城堡、「骰境 TRPG」横幅的边角被切掉；
  ② 自适应前景用 0.70 占比偏大：108dp 画布的系统安全区只有中心 66dp，
     0.70 仍会被系统二轮裁切。

本版策略（核心）：**整体缩小 + 居中留边距**，任何形状遮罩下主体都完整——
  · ic_launcher.png（传统方形）        源图占画布 78%，四角深蓝底
  · ic_launcher_round.png（圆形）      源图占画布 72% + 整画布圆形 alpha 遮罩
  · ic_launcher_foreground.png（自适应）源图占 108dp 画布 62%（安全区 66dp 内）
  · ic_launcher_background.xml          取源图四角色（深蓝天），圆角处不漏白
  · web/img/logo.png（512）/ logo-192（192）  同款留边方形，与 app 图标一致

用法：python tools/gen_icon_v2138.py
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
RES = os.path.join(ROOT, "android", "app", "src", "main", "res")
WEBIMG = os.path.join(ROOT, "web", "img")
SRC = r"C:\Users\60965\.workbuddy\clipboard-images\clipboard-2026-10-19T05-11-25-525Z-9dcceafc.jpg"

DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
LEGACY = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}

SQUARE_RATIO = 0.78    # 传统方形图标：源图占画布比例（四周留边距）
ROUND_RATIO = 0.72     # 圆形图标：源图占画布比例（再收一圈，保证圆内完整）
FG_RATIO = 0.62        # 自适应前景：108dp 画布安全区 66dp → 0.62 稳在内


def load_master():
    """读源图并裁成正方形（居中裁，内容不偏）。"""
    im = Image.open(SRC).convert("RGB")
    w, h = im.size
    s = min(w, h)
    left = (w - s) // 2
    top = (h - s) // 2
    return im.crop((left, top, left + s, top + s))


def corner_color(im):
    """取四角色均值 = 深蓝天背景色（遮罩裁切处用它补底，不漏白边）。"""
    w, h = im.size
    px = im.load()
    pts = [(4, 4), (w - 5, 4), (4, h - 5), (w - 5, h - 5)]
    rs = sum(px[x, y][0] for x, y in pts) // 4
    gs = sum(px[x, y][1] for x, y in pts) // 4
    bs = sum(px[x, y][2] for x, y in pts) // 4
    return (rs, gs, bs)


def padded_square(master, size, bg):
    """深蓝底 + 源图按 SQUARE_RATIO 居中留边（任何方形/圆角遮罩都裁不到主体）。"""
    canvas = Image.new("RGB", (size, size), bg)
    d = int(round(size * SQUARE_RATIO))
    piece = master.resize((d, d), Image.LANCZOS)
    off = (size - d) // 2
    canvas.paste(piece, (off, off))
    return canvas


def round_icon(master, size, bg):
    """圆形图标：源图按 ROUND_RATIO 居中 + 整画布圆形 alpha 遮罩（4x 超采样抗锯齿）。"""
    d = int(round(size * ROUND_RATIO))
    piece = master.resize((d, d), Image.LANCZOS).convert("RGBA")
    off = (size - d) // 2
    base = Image.new("RGBA", (size, size), bg + (255,))
    base.paste(piece, (off, off), piece)
    ss = size * 4
    mask = Image.new("L", (ss, ss), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, ss - 1, ss - 1], fill=255)
    mask = mask.resize((size, size), Image.LANCZOS)
    base.putalpha(mask)
    return base


def foreground(master, canvas):
    """自适应图标前景：108dp 画布，源图按 FG_RATIO 居中（系统二轮裁切也伤不到）。"""
    fg = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    d = int(round(canvas * FG_RATIO))
    piece = master.resize((d, d), Image.LANCZOS).convert("RGBA")
    off = (canvas - d) // 2
    fg.paste(piece, (off, off), piece)
    return fg


def main():
    master = load_master()
    bg = corner_color(master)
    print("源图裁方:", master.size, " 背景色:", bg, "= #%02X%02X%02X" % bg)

    os.makedirs(WEBIMG, exist_ok=True)
    padded_square(master, 512, bg).save(os.path.join(WEBIMG, "logo.png"), "PNG")
    padded_square(master, 192, bg).save(os.path.join(WEBIMG, "logo-192.png"), "PNG")
    print("web logo ->", WEBIMG)

    for name, scale in DENSITIES.items():
        folder = os.path.join(RES, "mipmap-" + name)
        os.makedirs(folder, exist_ok=True)
        legacy = LEGACY[name]
        padded_square(master, legacy, bg).save(os.path.join(folder, "ic_launcher.png"), "PNG")
        round_icon(master, legacy, bg).save(os.path.join(folder, "ic_launcher_round.png"), "PNG")
        fg = foreground(master, int(round(108 * scale)))
        fg.save(os.path.join(folder, "ic_launcher_foreground.png"), "PNG")
        print("icon:", name, "legacy", legacy, "fg", fg.size[0])

    # 自适应图标声明（XML 不变，仍指向 foreground + 背景色；此处兜底重写一遍）
    anydpi = os.path.join(RES, "mipmap-anydpi-v26")
    os.makedirs(anydpi, exist_ok=True)
    xml = ('<?xml version="1.0" encoding="utf-8"?>\n'
           '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
           '    <background android:drawable="@color/ic_launcher_background" />\n'
           '    <foreground android:drawable="@mipmap/ic_launcher_foreground" />\n'
           '</adaptive-icon>\n')
    for f in ("ic_launcher.xml", "ic_launcher_round.xml"):
        with open(os.path.join(anydpi, f), "w", encoding="utf-8") as fh:
            fh.write(xml)
    print("adaptive xml ->", anydpi)

    vals = os.path.join(RES, "values")
    os.makedirs(vals, exist_ok=True)
    hexc = "#%02X%02X%02X" % bg
    with open(os.path.join(vals, "ic_launcher_background.xml"), "w", encoding="utf-8") as fh:
        fh.write('<?xml version="1.0" encoding="utf-8"?>\n'
                 '<resources>\n'
                 '    <color name="ic_launcher_background">%s</color>\n'
                 '</resources>\n' % hexc)
    print("bg color ->", hexc)


if __name__ == "__main__":
    main()
