global.window = global;
const fs=require('fs'), path=require('path');
const base='web/js/';
['data/skills.js','data/occupations.js','data/weapons.js','data/armors.js','data/vehicles.js','data/madness.js','data/assets.js','core/dice.js','core/rules-coc7.js','core/occupation.js']
  .forEach(f=>{ eval(fs.readFileSync(path.join(base,f),'utf8')); });

const O = window.CocOccupation;
console.log('职业总数:', O.listAll().length);

// 解析成功率统计
let totalReqs=0, freeReqs=0, choiceReqs=0, fixedReqs=0, altReqs=0, unresolved=0;
const samples=[];
O.listAll().forEach(o=>{
  const reqs = O.parseSkillText(o.skillText);
  reqs.forEach(r=>{
    totalReqs++;
    if(r.type==='free'){freeReqs++; if(r.raw) unresolved++;}
    else if(r.type==='choice')choiceReqs++;
    else if(r.type==='fixed')fixedReqs++;
    else if(r.type==='alt')altReqs++;
  });
  if(samples.length<12 && o.no<12) samples.push([o.name, o.skillText, reqs]);
});
console.log({totalReqs, fixedReqs, choiceReqs, freeReqs, altReqs, unresolved});

samples.forEach(([n,t,rs])=>{
  console.log('\n【'+n+'】'+t);
  rs.forEach(r=>{
    if(r.type==='fixed') console.log('   fixed:', r.skill + (r.sub?('::'+r.sub):'') + (r.isGroup?' [组]':''));
    else if(r.type==='choice') console.log('   choice x'+r.count+':', r.pool.map(p=>p.name).join('、'), '|', r.label);
    else if(r.type==='free') console.log('   free x'+r.count+':', r.label, r.raw?('RAW='+r.raw):'');
    else console.log('   alt:', r.options.map(o=>o.skill+(o.sub?'::'+o.sub:'')).join(' / '), '|', r.label);
  });
});

// 测试公式
const attrs={str:50,con:50,siz:70,dex:40,app:75,int:60,pow:75,edu:60,luck:60};
['教育×4','教育×2＋敏捷×2','教育×2＋外貌×2','教育×2＋力量或敏捷×2','教育×2＋外貌或敏捷×2'].forEach(f=>{
  console.log('formula', f, '=', O.evalFormula(f, attrs));
});
