# -*- coding: utf-8 -*-
"""
assert_apk_assets.py — 包内新逻辑断言

为什么需要这个：gradle 的 mergeAssets 可能走 UP-TO-DATE，构建成功
不代表新代码同步进 APK 了。必须直接读 zip 里的 assets 做正向断言。

用法：python tools/assert_apk_assets.py <apk> [关键字 ...]
不传关键字时跑内置默认清单。

关键字写法：
    普通字符串          → 在 assets/js、assets/css、assets/index.html 的**内容**里找
    dex:XXXXXXXX        → 在 classes*.dex 里找（Java 类编译进 dex，**不在 assets 里**）

⚠️ 为什么要 dex: 前缀：v1.18.0 出包指引里写的是
`assert_apk_assets.py <apk> room-lan.js LanServer`，其中 LanServer 永远不可能命中 ——
它只扫 assets，而 Java 类在 dex。照抄那条命令会得到一个假的 FAIL，
让人以为「代码没进包」，实际是断言写错了地方。
"""
import sys
import zipfile

APK = sys.argv[1] if len(sys.argv) > 1 else \
    'android/app/build/outputs/apk/release/app-release.apk'

# (资产相对路径, 关键字) —— 必须命中；where 为 '' 表示按关键字前缀自行决定
DEFAULT = [
    ('assets/js/core/build-config.js', "edition: 'oss'"),
    ('assets/js/core/build-config.js', "shareBase: ''"),
    ('assets/index.html', 'app.js'),
    # 局域网直连：页面必须真的加载了 room-lan.js。
    # 漏了这条，RoomLan 就是 undefined → 界面按「不在 App 里」处理，
    # 「局域网直连」卡片根本不显示，现象看着像代码写错了。
    ('assets/index.html', 'room-lan.js'),
    # 内嵌 LAN 服务类：编译进 dex
    ('', 'dex:LanServer'),
]

# 只扫这些资产目录
SCAN_PREFIX = ('assets/js/', 'assets/index.html', 'assets/css/')

DEX_PREFIX = 'dex:'


def main():
    keys = sys.argv[2:] or None

    with zipfile.ZipFile(APK) as z:
        names = [n for n in z.namelist()
                 if not n.endswith('/') and n.startswith(SCAN_PREFIX)]
        blob = {n: z.read(n).decode('utf-8', 'replace') for n in names}
        allt = '\n'.join(blob.values())
        dex_names = sorted(n for n in z.namelist()
                           if not n.endswith('/') and n.endswith('.dex'))
        dex_blob = b''.join(z.read(n) for n in dex_names)

    print('扫描资产条目：%d（dex：%s）' % (len(names), ', '.join(dex_names) or '无'))

    targets = []
    if keys:
        for k in keys:
            targets.append(('', k))
    else:
        targets = DEFAULT

    ok = True

    print('\n--- 关键字断言 ---')
    for where, k in targets:
        if k.startswith(DEX_PREFIX):
            needle = k[len(DEX_PREFIX):].encode('utf-8')
            hit = needle in dex_blob
            shown = '%s（dex 扫描）' % k
        elif where.startswith('assets/'):
            hit = k in blob.get(where, '')
            shown = '%s  ←  %s' % (k, where)
        else:
            hit = k in allt
            shown = '%s（全 assets 扫描）' % k
        print('  [%s] %s' % ('OK' if hit else '!!', shown))
        if not hit:
            ok = False
            if k.startswith(DEX_PREFIX) and not dex_names:
                print('        （包里根本没有 .dex —— 先确认 APK 路径对不对）')

    # 反向断言：OSS 版绝不能预置分享服务 / 私有激活码
    print('\n--- 反向断言（OSS 版不应出现） ---')
    for k in ["shareBase: 'http", "edition: 'self'", 'BAILI-']:
        bad = k in allt
        print('  [%s] 不应出现: %s' % ('OK' if not bad else '!!', k))
        if bad:
            ok = False

    print('\n' + '=' * 60)
    print('结果：%s' % ('PASS' if ok else 'FAIL'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
