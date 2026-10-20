global.window = global;
const fs=require('fs'), path=require('path');
const base='web/js/';
['data/skills.js','data/occupations.js','core/dice.js','core/rules-coc7.js','core/occupation.js']
  .forEach(f=>{ eval(fs.readFileSync(path.join(base,f),'utf8')); });
const O = window.CocOccupation;
const seen={};
let emptyOcc=[];
O.listAll().forEach(o=>{
  const reqs=O.parseSkillText(o.skillText);
  if(!reqs.length) emptyOcc.push(o.name);
  reqs.forEach(r=>{
    if(r.type==='free'&&r.raw) seen[r.raw]=(seen[r.raw]||0)+1;
    // 递归 alt
    (r.options||[]).forEach(oo=>{ if(oo.type==='free'&&oo.raw) seen[oo.raw]=(seen[oo.raw]||0)+1; });
  });
});
console.log('=== 未识别技能原文 ===');
Object.entries(seen).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(v,'|',k));
console.log('\n=== 无任何要求的职业 ===', emptyOcc.length, emptyOcc.join(', '));
