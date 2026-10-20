# -*- coding: utf-8 -*-
"""
test_nsc.py — network_security_config.xml 的守卫测试

为什么必须有这个测试（v1.18.4 的教训，代价是用户拿两台手机试了一整轮）：

    v1.18.3 我在 nsc 里写了这样一条，以为它能放行整个 192.168.x.x 网段：

        <domain includeSubdomains="true">192.168.x.0</domain>

    **它一条也没放行。** 安卓的 `<domain>` 做的是**主机名字符串匹配**，
    不是 CIDR 前缀匹配 —— `includeSubdomains` 只是在前面补一个点，
    于是它匹配「字面主机 192.168.x.0」和「*.192.168.x.0」。
    真实设备地址 192.168.x.y 两条都不命中，落到 base-config 的
    cleartextTrafficPermitted="false" 被系统瞬间掐断。

    真机表现极具迷惑性：
        127.0.0.1    → 有精确条目 → 36ms 正常   ✅
        192.168.x.y  → 谁都没命中 → 12ms 失败 ❌
    看起来像 AP 隔离、像服务没起来，其实只是白名单写法无效。

    而当时的回归是 33/33 全绿的 —— 因为**没有任何一条断言碰过这个文件**。
    「测试全绿」和「功能正常」之间差的就是这一层：
    改动落在没有测试覆盖的文件上时，全绿什么都不能说明。

本测试守三条：
    1. 不允许出现「看起来像 IP 网段」的 <domain>（那必然是无效写法）
    2. base-config 必须放开明文（局域网 IP 是运行时才知道的，打包时无法枚举）
    3. 关键公网域名必须被显式钉回 TLS（否则全局放开就真把安全边界拆了）
"""
import io
import os
import re
import sys
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
NSC = os.path.normpath(os.path.join(
    HERE, '..', 'android', 'app', 'src', 'main', 'res', 'xml',
    'network_security_config.xml'))
MANIFEST = os.path.normpath(os.path.join(
    HERE, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'))

passed = 0
failed = 0


def ok(cond, name, detail=''):
    global passed, failed
    if cond:
        passed += 1
        print('  [OK] %s' % name)
    else:
        failed += 1
        print('  [!!] %s%s' % (name, ('  ← ' + detail) if detail else ''))


def has_lan_ip_literal(text):
    """看起来像「IP 网段」的 domain 值。

    判定：纯数字点分四段，且最后一段是 0 —— 那就是想当网段用的。
    精确 IP（如 192.168.x.y）是合法且有效的写法，不算违规。
    """
    out = []
    for m in re.finditer(r'<domain[^>]*>\s*([0-9.]+)\s*</domain>', text):
        ip = m.group(1)
        parts = ip.split('.')
        if len(parts) == 4 and all(p.isdigit() for p in parts):
            # 末段为 0 → 当作网段写，必然无效
            if parts[3] == '0':
                out.append(ip)
    return out


def main():
    print('=' * 60)
    print('network_security_config 守卫')
    print('=' * 60)

    if not os.path.isfile(NSC):
        ok(False, '文件存在', NSC)
        print('\n结果：FAIL')
        return 1

    with io.open(NSC, encoding='utf-8') as f:
        text = f.read()
    # 去掉 XML 注释，避免把注释里举的反例当成真实配置
    body = re.sub(r'<!--.*?-->', '', text, flags=re.S)

    root = ET.fromstring(body)

    # ---- 1. 不能有「网段式」IP ----
    bad = has_lan_ip_literal(body)
    ok(not bad,
       '没有「网段式」<domain>（写了也无效）',
       '发现了 %s —— <domain> 只做主机名匹配，不认网段' % ', '.join(bad))

    # ---- 2. base-config 必须放开明文 ----
    base = root.find('base-config')
    ok(base is not None, '存在 base-config')
    if base is not None:
        v = base.get('cleartextTrafficPermitted')
        ok(v == 'true',
           'base-config 放开明文（局域网 IP 打包时无法枚举）',
           '当前是 cleartextTrafficPermitted="%s"' % v)

    # ---- 3. 公共模型服务域名必须被钉回 TLS ----
    # v2.0.2 变更：不再校验「作者自有域名」。开源包里出现自有域名属于
    # 私有信息残留（由 tools/scan_apk_residue.py 拦下），而 self 版预置地址
    # 走的是 https://，那条钉子对功能零影响 —— 两个工具此前互相矛盾，
    # 这里统一口径：只认**公共**模型服务域名（它们承载角色卡 / API Key）。
    must_tls = ['api.openai.com', 'api.deepseek.com',
                'dashscope.aliyuncs.com', 'open.bigmodel.cn']
    locked = {}
    for dc in root.findall('domain-config'):
        if dc.get('cleartextTrafficPermitted') == 'false':
            for d in dc.findall('domain'):
                if d.text:
                    locked[d.text.strip()] = True
    for host in must_tls:
        ok(host in locked,
           '公共模型服务 %s 被钉死为 TLS' % host,
           '全局放开明文后它必须在某个 cleartextTrafficPermitted="false" 的 '
           'domain-config 里，否则角色卡 / API Key 会明文上传')

    # ---- 3b. nsc 内不允许出现自有域名（与残留扫描同源的发布闸门） ----
    # 故意不硬编码具体域名（否则本测试自己就成了一处私有信息），
    # 只用后缀判定 —— 任何 example-private.test 主机都属于私有基础设施。
    ok('example-private.test' not in text,
       'nsc 不含任何 example-private.test 主机（开源包闸门）',
       '自有域名会随 APK 发给所有开源用户。self 版预置地址本身就是 '
       'https://，删掉这条 TLS 钉子不影响功能')

    # ---- 4. manifest 必须引用这份配置 ----
    if os.path.isfile(MANIFEST):
        with io.open(MANIFEST, encoding='utf-8') as f:
            mf = f.read()
        ok('networkSecurityConfig' in mf,
           'manifest 引用了 networkSecurityConfig',
           '没引用的话这个文件根本不生效')
    else:
        ok(False, 'manifest 存在', MANIFEST)

    print('\n' + '=' * 60)
    print('结果：%s（%d / %d）' % ('PASS' if failed == 0 else 'FAIL',
                                  passed, passed + failed))
    return 0 if failed == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
