# -*- coding: utf-8 -*-
"""
deploy_card_site.py —— 打包「车卡器网页版」，用于部署到静态服务器。

两种模式：
  · 默认（公网/自建服务器）：预置 shareBase（云分享）+ roomBase（公网房间中继 /room）
    → 产物 dist/card-site.tar.gz
  · --lan（局域网一体服）：roomBase 留空 + sameOriginRoom=true → 网页用「自己所在的源」
    当中继；配一台同源 serve 网页+中继的机器（room_server.py 开 ROOM_STATIC_DIR）即用，
    朋友打开 http://<局域网IP>:端口/ 即玩，同源、无混合内容、不走外网。
    shareBase 留空（局域网不走云分享）→ 产物 dist/card-site-lan.tar.gz

产物解压后即为站点根（index.html 在包根）。仓库源码一个字都不改。

用法：
    python tools/deploy_card_site.py                        # 公网模式，默认地址
    python tools/deploy_card_site.py https://example.com/coc
    python tools/deploy_card_site.py --lan                  # 局域网一体服
    python tools/deploy_card_site.py --lan --out D:/tmp/lan.tar.gz

自检（任一失败即不出包）：
  1. 包内文件数与 web/ 逐一对齐
  2. 包内 build-config.js 含预期关键字段（公网=shareBase+roomBase；局域网=sameOriginRoom+gateCode）
  3. 包内 index.html 的本地资源引用都带 ?v=<本次版本号>（绕开 Cloudflare/浏览器缓存，
     否则原地覆盖部署后边缘仍是旧文件 —— 实测 cf-cache-status HIT 挡了 3 小时）
  4. 包内不得出现 APK 侧的私有配置（edition/ 、.pem 、keystore 之类）
"""
import argparse
import io
import os
import re
import sys
import tarfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
WEB = os.path.join(ROOT, "web")
DIST = os.path.join(ROOT, "dist")
CONFIG_REL = "js/core/build-config.js"

DEFAULT_BASE = "https://your-domain.example.com/coc"
ROOM_BASE_PUBLIC = "https://your-domain.example.com/room"
GATE_CODE = "change-me"

CONFIG_TPL = """/* ============================================================
 * build-config.js —— 部署版（由 tools/deploy_card_site.py 自动生成）
 *
 * 不要手改这个文件 —— 改 tools/deploy_card_site.py 里的模板再重新打包。
 * ============================================================ */
(function (global) {
  'use strict';

  global.BuildConfig = {
    edition: 'web',
    shareBase: '%(share)s',
    allowCustomShareBase: true,
    /* 房间中继基址。局域网一体服留空 + sameOriginRoom:true → 用当前网页源当中继。 */
    roomBase: '%(room)s',
    allowCustomRoomBase: true,
    sameOriginRoom: %(sameorigin)s,
    /* 暗号门 —— 仅对朋友开放，打开先输暗号。 */
    gateCode: '%(gate)s',
    displayName: '骰境 TRPG',
    versionName: '2.13.13'
  };
})(window);
"""

# 打包时必须排除的东西（防止把私有配置带进公开站点）
FORBIDDEN_SUFFIX = (".pem", ".jks", ".keystore", ".key")


def config_text(share_base, room_base, same_origin, gate_code):
    return CONFIG_TPL % {
        "share": share_base,
        "room": room_base,
        "sameorigin": "true" if same_origin else "false",
        "gate": gate_code,
    }


def check_names(rel):
    """返回错误信息，None 表示放行。"""
    low = rel.lower()
    if low.endswith(FORBIDDEN_SUFFIX):
        return "疑似私钥文件：%s" % rel
    if rel.startswith("edition/") or "/edition/" in rel:
        return "私有构建配置不应进入站点：%s" % rel
    return None


# 只给「包内的本地相对路径」加版本号：带协议 / 锚点 / data: / 已有查询串的一律不碰
_LOCAL_RE = re.compile(r'^[A-Za-z0-9_][A-Za-z0-9_./-]*$')
_ATTR_RE = re.compile(r'((?:src|href)\s*=\s*")([^"]*)(")')


def bust_version(html, ver, known):
    """把 index.html 里指向包内资源的 src/href 加上 ?v=<ver>。

    为什么必须做：Cloudflare（以及浏览器）会按 URL 缓存 js/css，max-age 4 小时。
    以前原地覆盖部署，边缘缓存还是旧文件 —— 用户死活看不到新功能
    （实测：密码框上线 3 小时，边缘 cf-cache-status 仍是 HIT、Age 6447s）。
    换 URL 是最可靠的解法：index.html 本身不被 CF 缓存（DYNAMIC），
    它引用带新版本号的资源 → 边缘必然回源站取新文件。一次部署，永久生效。
    """
    def repl(m):
        url = m.group(2)
        if not _LOCAL_RE.match(url):
            return m.group(0)                 # 外链/锚点/data: → 原样
        if url in known:
            return m.group(1) + url + "?v=" + ver + m.group(3)
        return m.group(0)                     # 不在包内的路径不加（避免无意义查询串）
    return _ATTR_RE.sub(repl, html)


def main():
    ap = argparse.ArgumentParser(description="打包车卡器网页版")
    ap.add_argument("base", nargs="?", default=DEFAULT_BASE,
                    help="云分享服务基址（公网模式；默认 %s）" % DEFAULT_BASE)
    ap.add_argument("--lan", action="store_true",
                    help="局域网一体服模式：roomBase 留空 + sameOriginRoom，产物 card-site-lan.tar.gz")
    ap.add_argument("-o", "--out", default=None, help="输出文件路径")
    args = ap.parse_args()

    if not os.path.isdir(WEB):
        sys.exit("[!!] 找不到 web 目录：%s" % WEB)

    if args.lan:
        share_base = ""            # 局域网不走云分享
        room_base = ""              # 留空 → sameOriginRoom 用当前源当中继
        same_origin = True
        gate_code = GATE_CODE
        out_default = os.path.join(DIST, "card-site-lan.tar.gz")
        mode = "lan"
    else:
        base = args.base.strip().rstrip("/")
        if not base.lower().startswith(("http://", "https://")):
            sys.exit("[!!] shareBase 必须以 http:// 或 https:// 开头：%s" % base)
        share_base = base
        room_base = ROOM_BASE_PUBLIC
        same_origin = False
        gate_code = GATE_CODE
        out_default = os.path.join(DIST, "card-site.tar.gz")
        mode = "public"

    out = os.path.abspath(args.out or out_default)
    os.makedirs(os.path.dirname(out), exist_ok=True)

    # ---- 收集源文件 ----
    src = {}
    for root, dirs, files in os.walk(WEB):
        dirs.sort()
        for f in sorted(files):
            p = os.path.join(root, f)
            rel = os.path.relpath(p, WEB).replace(os.sep, "/")
            bad = check_names(rel)
            if bad:
                sys.exit("[!!] %s" % bad)
            src[rel] = p

    if CONFIG_REL not in src:
        sys.exit("[!!] web/ 里找不到 %s" % CONFIG_REL)

    # ---- 打包 ----
    cfg = config_text(share_base, room_base, same_origin, gate_code)
    ver = time.strftime("%Y%m%d%H%M%S")       # 每次打包唯一 → 资源 URL 唯一 → 绕开 CDN 缓存

    def add_bytes(tf, rel, data):
        info = tarfile.TarInfo(rel)
        info.size = len(data)
        info.mtime = int(time.time())
        info.mode = 0o644
        info.uid = info.gid = 0
        info.uname = info.gname = "root"
        tf.addfile(info, io.BytesIO(data))

    with tarfile.open(out, "w:gz") as tf:
        for rel in sorted(src):
            if rel == CONFIG_REL or rel == "index.html":
                continue
            tf.add(src[rel], arcname=rel, recursive=False)
        add_bytes(tf, CONFIG_REL, cfg.encode("utf-8"))
        with io.open(src["index.html"], "r", encoding="utf-8") as f:
            html = f.read()
        add_bytes(tf, "index.html", bust_version(html, ver, set(src)).encode("utf-8"))

    # ---- 自检 ----
    problems = []
    with tarfile.open(out, "r:gz") as tf:
        names = [m.name for m in tf.getmembers() if m.isfile()]
        if len(names) != len(src):
            problems.append("包内文件数 %d ≠ 源文件数 %d" % (len(names), len(src)))
        missing = sorted(set(src) - set(names))
        extra = sorted(set(names) - set(src))
        if missing:
            problems.append("源有包无：%s" % ", ".join(missing))
        if extra:
            problems.append("包有源无：%s" % ", ".join(extra))
        try:
            got = tf.extractfile(CONFIG_REL).read().decode("utf-8")
            if mode == "public":
                if share_base not in got:
                    problems.append("包内 build-config.js 未含 shareBase=%s" % share_base)
                if room_base not in got:
                    problems.append("包内 build-config.js 未含 roomBase=%s" % room_base)
            else:
                if "sameOriginRoom: true" not in got:
                    problems.append("局域网包 build-config.js 未开 sameOriginRoom")
                if GATE_CODE not in got:
                    problems.append("局域网包 build-config.js 未含 gateCode")
        except Exception as ex:
            problems.append("读包内 build-config.js 失败：%s" % ex)
        try:
            html_got = tf.extractfile("index.html").read().decode("utf-8")
            if ("?v=" + ver) not in html_got:
                problems.append("包内 index.html 未加版本号（?v=%s）——CDN 缓存会挡住更新" % ver)
            if html_got.count("?v=") < 10:
                problems.append("包内 index.html 加版本号的引用太少：%d" % html_got.count("?v="))
        except Exception as ex:
            problems.append("读包内 index.html 失败：%s" % ex)

    if problems:
        print("[!!] 自检失败，已删除产物：")
        for p in problems:
            print("     -> " + p)
        try:
            os.remove(out)
        except OSError:
            pass
        sys.exit(1)

    size = os.path.getsize(out)
    print("打包完成（%s 模式）：%s" % (mode, out))
    print("  文件数 %d · 体积 %.1f KB（未压缩 %.1f KB）"
          % (len(src), size / 1024.0,
             sum(os.path.getsize(p) for p in src.values()) / 1024.0))
    print("  shareBase=%s · roomBase=%s · sameOriginRoom=%s · gateCode=已设"
          % (share_base or "(空)", room_base or "(空=同源)", same_origin))
    print("  资源版本号 v=%s（index.html 内本地引用已带 ?v=%s，换 URL 绕开 CDN 缓存）"
          % (ver, ver))
    print()
    if mode == "public":
        print("部署（在服务器上执行）：")
        print("  sudo mkdir -p /var/www/coc/trpg")
        print("  sudo tar xzf card-site.tar.gz -C /var/www/coc/trpg")
        print("  sudo chown -R www-data:www-data /var/www/coc/trpg")
        print("  -> 访问 https://你的域名/trpg/")
    else:
        print("局域网一体服部署（在局域网机器上执行，网页+中继同源）：")
        print("  mkdir -p ~/coc-lan && tar xzf card-site-lan.tar.gz -C ~/coc-lan")
        print("  ROOM_STATIC_DIR=~/coc-lan ROOM_PORT=8080 ROOM_DB=~/coc-lan/rooms.db \\")
        print("    ROOM_PUBLIC_BASE=http://<本机局域网IP>:8080 \\")
        print("    python3 tools/room_server.py")
        print("  -> 朋友打开 http://<本机局域网IP>:8080/ 即玩（暗号：%s）" % GATE_CODE)


if __name__ == "__main__":
    main()
