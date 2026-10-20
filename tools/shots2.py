import asyncio, os
from playwright.async_api import async_playwright
BASE="http://127.0.0.1:8899/index.html"
OUT=os.path.join(os.path.dirname(os.path.abspath(__file__)),"shots2"); os.makedirs(OUT,exist_ok=True)
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch()
        c=await b.new_context(viewport={"width":412,"height":860},device_scale_factor=2)
        pg=await c.new_page()
        errs=[]
        pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.goto(BASE,wait_until="networkidle"); await pg.wait_for_timeout(600)
        # 建角色
        await pg.click("button.rule-card.on"); await pg.wait_for_timeout(500)
        await pg.fill("#app .card input[type=text] >> nth=0","亚历克斯·布莱克")
        await pg.fill("#app .card input[type=text] >> nth=1","茶叶蛋调查员")
        await pg.fill("input[type=number]","26"); await pg.wait_for_timeout(300)
        async def nx():
            await pg.click(".bottombar button:has-text('下一步')"); await pg.wait_for_timeout(700)
        await nx()
        await pg.click(".card .btn.primary"); await pg.wait_for_timeout(600)
        await pg.screenshot(path=os.path.join(OUT,"a_roll_preview.png"))
        await pg.click("button:has-text('接受')"); await pg.wait_for_timeout(500)
        await nx()
        await pg.fill(".search-box input","私家侦探"); await pg.wait_for_timeout(600)
        await pg.screenshot(path=os.path.join(OUT,"b_occ_search.png"))
        await pg.click(".occ-item >> nth=0"); await pg.wait_for_timeout(800)
        await pg.screenshot(path=os.path.join(OUT,"c_occ_detail.png"))
        await pg.evaluate("""()=>{const c=Store.getState().current,O=CocOccupation;
          O.getRequirements(c).forEach(r=>{
            if(r.type==='choice'||r.type==='alt'){const pool=r.type==='choice'?r.pool:r.options;
              const need=r.type==='choice'?r.count:1;
              c.occupationPicks[r.id]=pool.slice(0,need).map(p=>({skill:p.skill,sub:p.sub||''}));
              c.occupationPicks[r.id].forEach(p=>{if(p.sub)SkillModel.addSubSkill(c,p.skill,p.sub);});}
            else if(r.type==='free'){c.occupationPicks[r.id]=[{skill:'listen',sub:'',name:'聆听'}];}});
          Store.scheduleSave();}""")
        await pg.evaluate("()=>{const h=location.hash;location.hash='';location.hash=h;}"); await pg.wait_for_timeout(800)
        await nx()
        await pg.evaluate("""()=>{const c=Store.getState().current,SM=SkillModel,O=CocOccupation;
          const occSet=O.occupationalSet(c),pts=O.occupationPoints(c);
          const t=c.skills.filter(s=>occSet[s.key]||occSet[s.id]).slice(0,8);
          const each=Math.floor(pts.total/Math.max(1,t.length));
          t.forEach(s=>{let a=Math.min(each,99-s.total);if(a>0)SM.applyPoint(c,s,'occ',a);});
          const it=O.interestPoints(c);
          ['spot_hidden','listen'].forEach(id=>{const s=c.skills.filter(x=>x.id===id)[0];
            if(s){const a=Math.min(25,it.total-c.skills.reduce((x,y)=>x+(y.int||0),0),99-s.total);
              if(a>0)SM.applyPoint(c,s,'int',a);}});
          Store.scheduleSave();}""")
        await pg.evaluate("()=>{const h=location.hash;location.hash='';location.hash=h;}"); await pg.wait_for_timeout(900)
        await pg.screenshot(path=os.path.join(OUT,"d_skill_top.png"))
        await pg.evaluate("()=>window.scrollTo(0,700)"); await pg.wait_for_timeout(400)
        await pg.screenshot(path=os.path.join(OUT,"e_skill_cards.png"))
        # 直接跳到完成
        await pg.evaluate("()=>Store.getState().current")
        await pg.goto(BASE+"#/create",wait_until="networkidle"); await pg.wait_for_timeout(600)
        # 用 stepper 点完成
        await pg.click(".stepper-item >> nth=8"); await pg.wait_for_timeout(800)
        await pg.screenshot(path=os.path.join(OUT,"f_finish.png"))
        await pg.click("button:has-text('完成角色卡')"); await pg.wait_for_timeout(900)
        await pg.screenshot(path=os.path.join(OUT,"g_saved.png"))
        cid=await pg.evaluate("()=>Store.getState().current.id")
        await pg.goto(BASE+"#/card/coc7/"+cid,wait_until="networkidle"); await pg.wait_for_timeout(1100)
        await pg.screenshot(path=os.path.join(OUT,"h_sheet_head.png"))
        await pg.evaluate("()=>window.scrollTo(0,760)"); await pg.wait_for_timeout(400)
        await pg.screenshot(path=os.path.join(OUT,"i_sheet_skills.png"))
        await pg.evaluate("()=>window.scrollTo(0,1600)"); await pg.wait_for_timeout(400)
        await pg.screenshot(path=os.path.join(OUT,"j_sheet_rest.png"))
        # 属性页购点模式
        await pg.goto(BASE+"#/create",wait_until="networkidle"); await pg.wait_for_timeout(600)
        await pg.click(".stepper-item >> nth=1"); await pg.wait_for_timeout(600)
        await pg.click("button.chip:has-text('手动购点')"); await pg.wait_for_timeout(600)
        await pg.screenshot(path=os.path.join(OUT,"k_pointbuy.png"))
        await pg.click("button.chip:has-text('属性方案')"); await pg.wait_for_timeout(500)
        await pg.screenshot(path=os.path.join(OUT,"l_arrays.png"))
        print("errors:",errs[:5] if errs else "none")
        await b.close()
asyncio.run(main())
