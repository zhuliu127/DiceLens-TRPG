# -*- coding: utf-8 -*-
"""
diff_apk_assets.py — 包内 assets 与 web/ 源目录逐文件比对

比关键字断言更强：直接证明 APK 里的每个前端文件都与当前源码
逐字节一致。这样「构建成功但 mergeAssets 走 UP-TO-DATE、
新代码没进包」这种静默失败会被直接抓出来 —— 表现为 src_only 非空。

用法：python tools/diff_apk_assets.py <apk> <web 目录>
"""
import hashlib
import os
import sys
import zipfile


def sha(b):
    return hashlib.sha256(b).hexdigest()


def collect(root):
    out = {}
    for dp, _, fns in os.walk(root):
        for fn in fns:
            p = os.path.join(dp, fn)
            rel = os.path.relpath(p, root).replace('\\', '/')
            with open(p, 'rb') as f:
                out[rel] = sha(f.read())
    return out


def main():
    apk, web = sys.argv[1], sys.argv[2]
    src = collect(web)

    with zipfile.ZipFile(apk) as z:
        packed = {}
        for n in z.namelist():
            if n.startswith('assets/') and not n.endswith('/'):
                rel = n[len('assets/'):]
                packed[rel] = sha(z.read(n))

    only_src = sorted(set(src) - set(packed))
    only_apk = sorted(set(packed) - set(src))
    diff = sorted(k for k in (set(src) & set(packed)) if src[k] != packed[k])
    same = len(set(src) & set(packed)) - len(diff)

    print('源文件数：%d' % len(src))
    print('包内文件数：%d' % len(packed))
    print('逐字节一致：%d' % same)
    print('\n--- 源有包无（必须为空） ---')
    print('\n'.join('  ' + x for x in only_src) or '  （无）')
    print('\n--- 包有源无（可能被 syncWeb 过滤，正常可为空） ---')
    print('\n'.join('  ' + x for x in only_apk) or '  （无）')
    print('\n--- 内容不一致（必须为空） ---')
    print('\n'.join('  ' + x for x in diff) or '  （无）')

    bad = only_src or diff
    print('\n' + '=' * 60)
    print('结果：%s' % ('PASS —— 包内 assets 与源码完全一致'
                         if not bad else 'FAIL —— 包内代码未同步'))
    return 0 if not bad else 1


if __name__ == '__main__':
    sys.exit(main())