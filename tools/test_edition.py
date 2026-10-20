# -*- coding: utf-8 -*-
"""
test_edition.py —— 版本配置与「云分享可配置化」回归测试

覆盖：
  1. 开源版默认不预置任何服务地址（BuildConfig.shareBase 为空）
  2. 未配置时 CocShare.configured() 为 false，且不会发出任何网络请求
  3. 未配置时分享面板显示引导卡片，而不是「生成分享链接」按钮
  4. 设置页可以填写 / 清除服务地址，状态随之切换
  5. 地址格式校验生效（缺协议头应被拒绝）
  6. 预置地址（自用版行为）优先级低于用户填写
"""
import asyncio
import os
import sys

from playwright.async_api import async_playwright

URL = "http://127.0.0.1:" + str(int(os.environ.get("COC_STATIC_PORT") or 8899)) + "/index.html"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "shots_edition")
os.makedirs(OUT, exist_ok=True)

PASS = 0
FAIL = 0
FAILED = []


def check(name, ok, extra=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print("  [ok] %s" % name)
    else:
        FAIL += 1
        FAILED.append(name)
        print("  [!!] %s%s" % (name, ("   <- " + str(extra)) if extra != "" else ""))


def is_external(u):
    """判断是不是「对外」请求。只看协议与主机，不绑定任何具体域名。"""
    return not (u.startswith("http://127.0.0.1") or u.startswith("http://localhost") or
                u.startswith("data:") or u.startswith("blob:") or
                u.startswith("about:") or u.startswith("file:"))


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 430, "height": 932})

        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

        # 记录所有对外请求，用来证明「未配置时零外联」
        requests = []
        page.on("request", lambda r: requests.append(r.url))

        await page.goto(URL, wait_until="networkidle")
        await page.wait_for_timeout(700)

        # ---------------- 1. 默认配置 ----------------
        print("\n--- 1. 开源版默认配置 ---")
        cfg = await page.evaluate("""()=>({
          hasBuildConfig: !!window.BuildConfig,
          edition: window.BuildConfig && window.BuildConfig.edition,
          shareBase: window.BuildConfig && window.BuildConfig.shareBase,
          allowCustom: window.BuildConfig && window.BuildConfig.allowCustomShareBase,
          preset: CocShare.presetBase(),
          base: CocShare.base(),
          configured: CocShare.configured(),
          builtinSettings: (Store.getState().settings || {}).shareBase
        })""")
        check("BuildConfig 已加载", cfg["hasBuildConfig"], cfg)
        check("开源版 edition 为 oss", cfg["edition"] == "oss", cfg["edition"])
        check("开源版不预置服务地址", cfg["shareBase"] == "", repr(cfg["shareBase"]))
        check("允许用户自填地址", cfg["allowCustom"] is True, cfg["allowCustom"])
        check("未配置时 base() 为空串", cfg["base"] == "", repr(cfg["base"]))
        check("未配置时 configured() 为 false", cfg["configured"] is False, cfg["configured"])
        check("设置项 shareBase 默认为空", cfg["builtinSettings"] in ("", None), repr(cfg["builtinSettings"]))

        # ---------------- 2. 未配置时零外联 ----------------
        print("\n--- 2. 未配置时不应有任何外联 ---")
        external = [u for u in requests if is_external(u)]
        check("页面加载未访问分享服务", len(external) == 0, external)

        created = await page.evaluate("""async () => {
          const c = Store.newCharacter('coc7');
          c.characterName = '测试员';
          try { await CocShare.create(c); return 'resolved'; }
          catch (e) { return e.message; }
        }""")
        check("未配置时 create() 直接拒绝（不发起请求）", created == "UNCONFIGURED", created)
        await page.wait_for_timeout(300)
        external = [u for u in requests if is_external(u)]
        check("create() 被拒后依然零外联", len(external) == 0, external)

        # ---------------- 3. 未配置时的分享面板 ----------------
        print("\n--- 3. 未配置时的分享面板 ---")
        panel = await page.evaluate("""()=>{
          const c = Store.newCharacter('coc7');
          c.characterName = '面板测试员';
          const host = document.createElement('div');
          host.id = 'probe-host';
          document.body.appendChild(host);
          const p = ShareUI.panel(c);
          host.appendChild(p.el);
          const txt = host.innerText;
          return {
            text: txt,
            hasUploadBtn: /生成分享链接/.test(txt),
            hasGuideBtn: /去设置里填写服务地址/.test(txt),
            tag: (host.querySelector('.hint') || {}).textContent || ''
          };
        }""")
        check("面板显示「未配置」标记", "未配置" in panel["tag"], panel["tag"])
        check("面板不显示上传按钮", panel["hasUploadBtn"] is False, panel["text"][:120])
        check("面板给出「去设置」引导", panel["hasGuideBtn"] is True, panel["text"][:120])
        check("面板说明「不影响本机使用」", "保存在本机" in panel["text"], panel["text"][:160])
        await page.screenshot(path=os.path.join(OUT, "e_01_panel_unconfigured.png"), full_page=True)

        # ---------------- 4. 设置页填写地址 ----------------
        print("\n--- 4. 设置页填写服务地址 ---")
        # 先拆掉第 3 步的探针容器：它的文案里也含「角色卡云分享」，
        # 会和设置页的卡片一起被 querySelectorAll('.card') 捞出来。
        await page.evaluate("()=>{ const ph=document.getElementById('probe-host'); if (ph) ph.remove(); }")
        await page.evaluate("()=>window.App && App.go('#/settings')")
        await page.wait_for_timeout(700)

        # 只在设置弹层内、用 .card-title 精确定位
        set_ui = await page.evaluate("""()=>{
          const card = Array.from(document.querySelectorAll('.sheet-mask .card'))
            .find(c => ((c.querySelector('.card-title')||{}).textContent||'').trim() === '角色卡云分享');
          return {
            found: !!card,
            text: card ? card.innerText : '',
            input: !!document.querySelector('.sheet-mask input[type=url]'),
            btnSave: !!Array.from(document.querySelectorAll('.sheet-mask button')).find(b=>b.textContent==='保存地址'),
            btnClear: !!Array.from(document.querySelectorAll('.sheet-mask button')).find(b=>b.textContent==='清除')
          };
        }""")
        check("设置页有「角色卡云分享」卡片", set_ui["found"], set_ui["text"][:100])
        check("卡片说明当前尚未配置", "尚未配置" in set_ui["text"], set_ui["text"][:160])
        check("有地址输入框", set_ui["input"], set_ui)
        check("有保存 / 清除按钮", set_ui["btnSave"] and set_ui["btnClear"], set_ui)
        await page.screenshot(path=os.path.join(OUT, "e_02_settings_unconfigured.png"), full_page=True)

        # 4a. 格式校验：不带协议头应被拒绝
        await page.evaluate("""()=>{
          document.querySelector('.sheet-mask input[type=url]').value = 'example.com/coc';
        }""")
        await page.evaluate("""()=>{
          Array.from(document.querySelectorAll('.sheet-mask button')).find(b=>b.textContent==='保存地址').click();
        }""")
        await page.wait_for_timeout(500)
        bad = await page.evaluate("""()=>({
          saved: (Store.getState().settings||{}).shareBase || '',
          invalid: !!document.querySelector('.sheet-mask input[type=url].invalid'),
          toast: (document.querySelector('.toast')||{}).textContent || ''
        })""")
        check("不合法地址被拒绝保存", bad["saved"] == "", repr(bad["saved"]))
        check("不合法地址输入框标红", bad["invalid"] is True, bad)

        # 4b. 合法地址应保存成功
        await page.evaluate("""()=>{
          const inp = document.querySelector('.sheet-mask input[type=url]');
          inp.value = 'https://share.example.com/coc/';
          inp.dispatchEvent(new Event('input'));
        }""")
        await page.evaluate("""()=>{
          Array.from(document.querySelectorAll('.sheet-mask button')).find(b=>b.textContent==='保存地址').click();
        }""")
        await page.wait_for_timeout(600)
        good = await page.evaluate("""()=>({
          saved: (Store.getState().settings||{}).shareBase || '',
          base: CocShare.base(),
          configured: CocShare.configured(),
          invalid: !!document.querySelector('.sheet-mask input[type=url].invalid'),
          cardText: (Array.from(document.querySelectorAll('.sheet-mask .card'))
            .find(c => ((c.querySelector('.card-title')||{}).textContent||'').trim() === '角色卡云分享')||{}).innerText || ''
        })""")
        check("合法地址保存成功", good["saved"] == "https://share.example.com/coc/", repr(good["saved"]))
        check("尾部斜杠被归一化（base 不含尾斜杠）", good["base"] == "https://share.example.com/coc", repr(good["base"]))
        check("configured() 变为 true", good["configured"] is True, good["configured"])
        check("标红状态被清除", good["invalid"] is False, good)
        check("状态行显示生效地址", "share.example.com" in good["cardText"], good["cardText"][:200])
        await page.screenshot(path=os.path.join(OUT, "e_03_settings_configured.png"), full_page=True)

        # 4c. 配置后分享面板应出现上传按钮
        after = await page.evaluate("""()=>{
          let host = document.getElementById('probe-host');
          if (!host) { host = document.createElement('div'); host.id = 'probe-host'; document.body.appendChild(host); }
          host.innerHTML = '';
          const c = Store.newCharacter('coc7');
          c.characterName = '面板测试员2';
          const p = ShareUI.panel(c);
          host.appendChild(p.el);
          const txt = host.innerText;
          return { hasUploadBtn: /生成分享链接/.test(txt), text: txt };
        }""")
        check("配置后分享面板出现上传按钮", after["hasUploadBtn"] is True, after["text"][:120])

        # ---------------- 5. 清除后回到未配置 ----------------
        print("\n--- 5. 清除地址 ---")
        await page.evaluate("""()=>{
          Array.from(document.querySelectorAll('.sheet-mask button')).find(b=>b.textContent==='清除').click();
        }""")
        await page.wait_for_timeout(500)
        cleared = await page.evaluate("""()=>({
          saved: (Store.getState().settings||{}).shareBase || '',
          configured: CocShare.configured(),
          inputValue: (document.querySelector('.sheet-mask input[type=url]')||{}).value,
          cardText: (Array.from(document.querySelectorAll('.sheet-mask .card'))
            .find(c => ((c.querySelector('.card-title')||{}).textContent||'').trim() === '角色卡云分享')||{}).innerText || ''
        })""")
        check("清除后设置为空", cleared["saved"] == "", repr(cleared["saved"]))
        check("清除后 configured() 回到 false", cleared["configured"] is False, cleared["configured"])
        check("清除后输入框同步清空", cleared["inputValue"] == "", repr(cleared["inputValue"]))
        check("状态行回到「尚未配置」", "尚未配置" in cleared["cardText"], cleared["cardText"][:160])

        # ---------------- 6. 预置地址（自用版行为） ----------------
        print("\n--- 6. 预置地址与用户填写的优先级 ---")
        preset = await page.evaluate("""()=>{
          // 模拟 BuildConfig 里有预置地址（自用版）
          BuildConfig.shareBase = 'https://preset.example.com/coc';
          const a = { preset: CocShare.presetBase(), base: CocShare.base(), configured: CocShare.configured() };
          // 用户再自己填一个 → 应覆盖预置
          Store.setSettings({ shareBase: 'https://mine.example.com/coc' });
          const b = { base: CocShare.base() };
          // 用户清掉 → 回落到预置
          Store.setSettings({ shareBase: '' });
          const c = { base: CocShare.base() };
          BuildConfig.shareBase = '';
          return { a: a, b: b, c: c };
        }""")
        check("预置地址被识别为有效配置", preset["a"]["configured"] is True, preset["a"])
        check("预置地址生效", preset["a"]["base"] == "https://preset.example.com/coc", preset["a"])
        check("用户填写的地址优先于预置", preset["b"]["base"] == "https://mine.example.com/coc", preset["b"])
        check("用户清空后回落到预置地址", preset["c"]["base"] == "https://preset.example.com/coc", preset["c"])

        # ---------------- 7. 控制台 ----------------
        print("\n--- 7. 控制台 ---")
        check("无控制台错误", len(errors) == 0, errors[:3])

        await browser.close()

    print("\n" + "=" * 52)
    print("通过 %d / %d" % (PASS, PASS + FAIL))
    if FAILED:
        print("失败项：")
        for f in FAILED:
            print("  - " + f)
    print("=" * 52)
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
