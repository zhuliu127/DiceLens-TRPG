# -*- coding: utf-8 -*-
"""
test_web_deploy.py —— 验证「车卡器网页版 + 分享服务」在服务器上的部署。

不看本地源码，只打真实域名，模拟一个普通访客：
    https://your-domain.example.com/card/

检查项：
  1. 首页 200，标题正确
  2. 前端所有脚本/css/图片加载成功（抓 4xx/5xx 与控制台 error）
  3. CocShare 读到的是预置的分享地址（说明部署版 build-config.js 生效）
  4. 真能生成 5 张随机候选卡（截图存证）
  5. 分享链路端到端：POST /coc/api/cards → 拿 url → 打开只读页 → 内容正确
     （跑完自动删掉这条测试分享，不污染线上库）

用法：
    python tools/test_web_deploy.py
环境变量：
    WEB_CARD_URL   默认 https://your-domain.example.com/card/
"""
import asyncio
import json
import os
import sys

from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, "shots_web")

CARD_URL = os.environ.get("WEB_CARD_URL", "https://your-domain.example.com/card/").rstrip("/") + "/"
SHARE_BASE = os.environ.get("WEB_SHARE_BASE", "https://your-domain.example.com/coc")

results = []


def check(name, cond, extra=""):
    results.append(bool(cond))
    print(("  [OK] " if cond else "  [!!] ") + name + (("   " + str(extra)) if extra else ""))


async def main():
    os.makedirs(SHOTS, exist_ok=True)
    bad_resp = []
    console_err = []
    page_err = []

    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        ctx = await browser.new_context(
            viewport={"width": 412, "height": 915},
            device_scale_factor=2,
            user_agent=("Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36"),
        )
        pg = await ctx.new_page()
        pg.on("response", lambda r: bad_resp.append("%s %s" % (r.status, r.url)) if r.status >= 400 else None)
        pg.on("console", lambda m: console_err.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: page_err.append(str(e)))

        # ---------- 1. 首页 ----------
        print("\n== 1. 首页与静态资源 ==")
        resp = await pg.goto(CARD_URL, wait_until="domcontentloaded", timeout=60000)
        check("首页 HTTP 200", resp and resp.status == 200, resp.status if resp else "no-resp")
        check("标题为「跑团车卡器」", (await pg.title()) == "跑团车卡器", await pg.title())

        await pg.wait_for_timeout(1800)
        await pg.wait_for_selector("#app .card, #app button", timeout=15000)

        # ---------- 1.5 从首页进入 COC 7th ----------
        # 应用首页是「选择规则系统」，要先选才进第 0 步。
        # （漏掉这一步的话，后面找「生成随机角色」必然落空 —— 不是部署坏了。）
        print("\n== 1.5 首页 → 克苏鲁的呼唤 第七版 ==")
        await pg.screenshot(path=os.path.join(SHOTS, "web_00_home.png"))
        entered = await pg.evaluate(
            """()=>{const b=document.querySelector('button.rule-card.on');
                     if(!b) return false; b.click(); return true;}""")
        check("找到「克苏鲁的呼唤 第七版」入口", entered)
        await pg.wait_for_timeout(1500)

        # ---------- 2. 配置生效 ----------
        print("\n== 2. 部署版配置生效 ==")
        cfg = await pg.evaluate(
            """()=>({
                 edition: (window.BuildConfig||{}).edition,
                 shareBase: (window.BuildConfig||{}).shareBase,
                 cocBase: (window.CocShare ? window.CocShare.BASE : null),
                 cocConfigured: (window.CocShare ? window.CocShare.configured() : null),
                 modules: ['COCDice','SkillModel','Engine','Store','PresetGen',
                           'CocShare','AIGen','CocOccupation','CocPersonas']
                            .filter(k=>!!window[k])
               })""")
        check("BuildConfig.shareBase 已预置", cfg["shareBase"] == SHARE_BASE, cfg["shareBase"])
        check("CocShare 读到该地址（configured=true）",
              cfg["cocConfigured"] is True and cfg["cocBase"] == SHARE_BASE,
              "%s / %s" % (cfg["cocConfigured"], cfg["cocBase"]))
        check("核心模块全部就位（9/9）", len(cfg["modules"]) == 9, cfg["modules"])

        # ---------- 3. 生成随机卡 ----------
        print("\n== 3. 生成随机角色 ==")
        clicked = await pg.evaluate(
            """()=>{const b=[...document.querySelectorAll('button')]
                       .find(x=>x.textContent.includes('生成随机角色'));
                     if(!b) return false; b.click(); return true;}""")
        check("找到并点击「生成随机角色」", clicked)
        await pg.wait_for_timeout(2200)
        cards = await pg.evaluate("()=>document.querySelectorAll('.preset-card').length")
        check("生成 5 张候选卡", cards == 5, "实际 %s 张" % cards)
        await pg.screenshot(path=os.path.join(SHOTS, "web_01_step0.png"))
        await pg.evaluate("()=>{const e=document.querySelector('.preset-card'); if(e) e.scrollIntoView({block:'start'}); }")
        await pg.wait_for_timeout(500)
        await pg.evaluate("()=>window.scrollBy(0,-64)")
        await pg.wait_for_timeout(300)
        await pg.screenshot(path=os.path.join(SHOTS, "web_02_preset.png"))

        # ---------- 3.5 浏览器导出通路 ----------
        # 安卓外壳下走原生桥写相册/下载目录；浏览器下必须落到 <a download>。
        # 这条通路断了，「导出长图 / 导出存档」在网页版就是废的。
        print("\n== 3.5 浏览器导出通路 ==")
        try:
            async with pg.expect_download(timeout=25000) as dl_info:
                await pg.evaluate(
                    """()=>{ UI.saveFile('自检-可删除.json', JSON.stringify({ok:true}), 'text'); }""")
            dl = await dl_info.value
            check("UI.saveFile 触发浏览器下载", bool(dl),
                  dl.suggested_filename if dl else "")
        except Exception as ex:
            check("UI.saveFile 触发浏览器下载", False, str(ex)[:120])

        # ---------- 4. 分享链路 ----------
        print("\n== 4. 分享链路（网页版 → 你自己的服务器）==")
        made = await pg.evaluate(
            """async (base)=>{
                 const card = {
                   characterName: '部署自检-可删除',
                   playerName: '自检脚本',
                   basicInfo: { occupationName: '记者', era: '现代', gender: '女', age: 28 },
                   attributes: { str:50, con:55, siz:60, dex:65, app:70, int:75, pow:60, edu:80, luck:50 },
                   derivedStats: { maxHP:11, maxMP:12, maxSAN:60, mov:8, build:0, db:'0' },
                   status: { currentHP:11, currentMP:12, currentSAN:60 },
                   assets: { creditRating: 35 },
                   skills: [{ name:'侦查', total:70, base:25, occ:30, int:15, growth:0 }],
                   weapons: [], items: [], mythos: { spells: [] },
                   background: { description: '部署自检用，随后自动删除。' }
                 };
                 try {
                   const r = await fetch(base + '/api/cards', {
                     method:'POST', headers:{'Content-Type':'application/json'},
                     body: JSON.stringify({ name: card.characterName, visibility:'link', data: card })
                   });
                   const t = await r.text();
                   if (!r.ok) return { ok:false, status:r.status, body:t.slice(0,200) };
                   return { ok:true, status:r.status, json: JSON.parse(t) };
                 } catch (e) { return { ok:false, error: String(e) }; }
               }""", SHARE_BASE)
        check("跨域 POST /api/cards 成功", made.get("ok") is True,
              made.get("body") or made.get("error") or made.get("status"))
        if made.get("ok"):
            j = made["json"]
            check("返回了分享 url 与删除口令",
                  bool(j.get("url")) and bool(j.get("delToken")), j.get("url"))
            share_url = j["url"]
            r2 = await pg.goto(share_url, wait_until="domcontentloaded", timeout=60000)
            check("只读分享页 200", r2 and r2.status == 200, r2.status if r2 else "no-resp")
            body = await pg.content()
            check("只读页含角色名", "部署自检" in body)
            check("只读页含技能行", "侦查" in body)
            await pg.screenshot(path=os.path.join(SHOTS, "web_03_share_page.png"), full_page=False)
            # 清理：删掉这条测试分享
            gone = await pg.evaluate(
                """async (a)=>{
                     const r = await fetch(a.base + '/api/cards/' + a.id + '/del', {
                       method:'POST', headers:{'Content-Type':'application/json'},
                       body: JSON.stringify({ token: a.token })
                     });
                     return r.ok;
                   }""", {"base": SHARE_BASE, "id": j["id"], "token": j["delToken"]})
            check("测试分享已删除（不留垃圾数据）", gone is True)

        # ---------- 5. 噪声 ----------
        print("\n== 5. 错误与噪声 ==")
        # 图标字体之类偶发 404 不算致命，但要在报告里列出来
        check("无 4xx/5xx 资源", not bad_resp, bad_resp[:4])
        check("无未捕获异常", not page_err, page_err[:3])
        check("无控制台 error", not console_err, console_err[:3])

        await browser.close()

    ok = all(results)
    print("\n---- 共 %d 项，失败 %d 项 ----" % (len(results), results.count(False)))
    print("RESULT: " + ("PASS" if ok else "FAIL"))
    print("截图目录：" + SHOTS)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    asyncio.run(main())
