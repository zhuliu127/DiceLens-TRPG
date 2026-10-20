global.window = global;
const fs=require('fs'), path=require('path');
const base='web/js/';
['data/skills.js','data/occupations.js','data/weapons.js','data/armors.js','data/vehicles.js','data/madness.js','data/assets.js','core/dice.js','core/rules-coc7.js','core/occupation.js']
  .forEach(f=>{ eval(fs.readFileSync(path.join(base,f),'utf8')); });
const R=window.COC7, O=window.CocOccupation;
console.log('=== 派生属性校验 ===');
const a={str:50,con:50,siz:70,dex:40,app:75,int:60,pow:75,edu:60,luck:60,age:26};
const d=R.derived(a);
console.log('HP',d.hp,'(应为12)  MP',d.mp,'(应为15)  SAN',d.san,'(应为75)  MOV',d.mov,'(应为7)  BUILD',d.build,'DB',d.db);
console.log('DB表:', R.dbBuild(120), R.dbBuild(160), R.dbBuild(300), R.dbBuild(500));
console.log('年龄40 MOV修正:', R.ageRule(45).movLoss, '年龄70:', R.ageRule(72).movLoss);
console.log('=== 职业点计算 ===');
const chars=[{no:2,n:'会计师'},{no:4,n:'演员-戏剧演员'},{no:6,n:'事务所侦探、保安'},{no:91,n:'私家侦探'}];
chars.forEach(c=>{
  const occ=O.listAll().find(o=>o.no===c.no);
  console.log(c.n,'| 公式',occ.attrFormula,'→',O.evalFormula(occ.attrFormula,a),'| 职业信用',occ.creditText);
});
console.log('兴趣点 = INT×2 =', a.int*2);
console.log('=== 雷达图 ===');
const sk=[{id:'spot_hidden',total:60,base:25},{id:'listen',total:40,base:20},{id:'library',total:40,base:20},{id:'fighting',total:50,base:25},{id:'medicine',total:31,base:1}];
console.log(R.radar(sk, window.COC_SKILLS));
