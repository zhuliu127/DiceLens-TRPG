# -*- coding: utf-8 -*-
"""从用户提供的「茶叶蛋调查员协会」徽章图生成全套品牌图标。

产出：
  web/img/logo.png                     应用内使用（透明圆角外，正方形画布）
  web/img/logo-192.png                 小尺寸（列表/加载用）
  android/.../mipmap-*/ic_launcher.png        传统方形图标（羊皮纸底 + 圆徽章）
  android/.../mipmap-*/ic_launcher_round.png  圆形图标（透明）
  android/.../mipmap-*/ic_launcher_foreground.png  自适应图标前景（108dp 画布）
  android/.../mipmap-anydpi-v26/ic_launcher*.xml   自适应图标声明
  android/.../values/ic_launcher_background.xml    自适应图标背景色
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
RES = os.path.join(ROOT, "android", "app", "src", "main", "res")
WEBIMG = os.path.join(ROOT, "web", "img")
SRC = r"C:\Users\60965\.workbuddy\clipboard-images\clipboard-2026-10-08T13-37-42-312Z-32089b6c.jpg"

DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
LEGACY = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}

# 徽章外圈是羊皮纸米色，用它做图标底色／自适应图标背景，圆外不会露出白边
PARCHMENT = (240, 216, 168)
PARCHMENT_HEX = "#F0D8A8"


def load_master():
    """裁到圆的外接正方形，并加抗锯齿的圆形 alpha 遮罩"""
    im = Image.open(SRC).convert("RGB")
    W, H = im.size
    px = im.load()
    cy = int(H / 2)

    def non_white(seq):
        for i, (x, y) in enumerate(seq):
            r, g, b = px[x, y]
            if not (r > 245 and g > 245 and b > 245):
                return i
        return 0

    left = non_white([(i, cy) for i in range(W)])
    right = W - 1 - non_white([(W - 1 - i, cy) for i in range(W)])
    d = right - left + 1
    im = im.crop((left, 0, left + d, d if d <= H else H))
    if im.size[0] != im.size[1]:
        s = min(im.size)
        im = im.crop((0, 0, s, s))

    S = im.size[0]
    SS = S * 4                       # 4x 超采样做遮罩边缘
    big = im.resize((SS, SS), Image.LANCZOS).convert("RGBA")
    mask = Image.new("L", (SS, SS), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, SS - 1, SS - 1], fill=255)
    mask = mask.resize((S, S), Image.LANCZOS)
    im = im.convert("RGBA")
    im.putalpha(mask)
    return im


def on_background(circle, size, bg=PARCHMENT):
    canvas = Image.new("RGB", (size, size), bg)
    c = circle.resize((size, size), Image.LANCZOS)
    canvas.paste(c, (0, 0), c)
    return canvas


def round_png(circle, size):
    return circle.resize((size, size), Image.LANCZOS)


def foreground(circle, canvas, logo_ratio=0.70):
    """自适应图标前景：108dp 画布，徽章居中占 logo_ratio"""
    fg = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    d = int(round(canvas * logo_ratio))
    c = circle.resize((d, d), Image.LANCZOS)
    off = (canvas - d) // 2
    fg.paste(c, (off, off), c)
    return fg


def main():
    master = load_master()
    print("源图裁切后:", master.size)

    os.makedirs(WEBIMG, exist_ok=True)
    master.resize((512, 512), Image.LANCZOS).save(os.path.join(WEBIMG, "logo.png"), "PNG")
    master.resize((192, 192), Image.LANCZOS).save(os.path.join(WEBIMG, "logo-192.png"), "PNG")
    print("web logo ->", WEBIMG)

    for name, scale in DENSITIES.items():
        folder = os.path.join(RES, "mipmap-" + name)
        os.makedirs(folder, exist_ok=True)
        legacy = LEGACY[name]
        on_background(master, legacy).save(os.path.join(folder, "ic_launcher.png"), "PNG")
        round_png(master, legacy).save(os.path.join(folder, "ic_launcher_round.png"), "PNG")
        # 108dp 画布
        fg = foreground(master, int(round(108 * scale)))
        fg.save(os.path.join(folder, "ic_launcher_foreground.png"), "PNG")
        print("icon:", name, legacy, "fg", fg.size[0])

    # 自适应图标声明
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

    # 背景色
    vals = os.path.join(RES, "values")
    os.makedirs(vals, exist_ok=True)
    with open(os.path.join(vals, "ic_launcher_background.xml"), "w", encoding="utf-8") as fh:
        fh.write('<?xml version="1.0" encoding="utf-8"?>\n'
                 '<resources>\n'
                 '    <color name="ic_launcher_background">%s</color>\n'
                 '</resources>\n' % PARCHMENT_HEX)
    print("bg color ->", PARCHMENT_HEX)


if __name__ == "__main__":
    main()
