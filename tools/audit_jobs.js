/* 全量审计：把 occupations.js 的 skillText 逐条过解析器，找出
 *   - 池子里解析不出来的技能名（会退化成 free / 整组，导致选项缺失）
 *   - 渲染时会产出 undefined 的地方
 * 运行： node tools/audit_jobs.js
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const win = {};
global.window = win;

function load(f) {
  const code = fs.readFileSync(path.join(root, 'web/js/data', f), 'utf8');
  // 数据文件是 window.XXX = ... 形式
  new Function('window', code)(win);
}

load('skills.js');
load('occupations.js');
load('weapons.js');
load('armors.js');
load('vehicles.js');

// rules-coc7.js 需要 COCDice
global.window.COCDice = { roll: () => 1 };
const rulesCode = fs.readFileSync(path.join(root, 'web/js/core/rules-coc7.js'), 'utf8');
new Function('window', rulesCode)(win);
global.COC7 = win.COC7;

const occCode = fs.readFileSync(path.join(root, 'web/js/core/occupation.js'), 'utf8');
new Function('window', 'COC7', 'COC_SKILLS', 'COC_OCCUPATIONS', occCode)(win, win.COC7, win.COC_SKILLS, win.COC_OCCUPATIONS);
const OCC = win.CocOccupation;

const SKILLS = win.COC_SKILLS;
const byId = {};
SKILLS.forEach(s => (byId[s.id] = s));

const bad = [];   // 池里解析不到的名字
const undef = []; // label / 渲染会 undefined
const stats = {
  fixed: 0, choice: 0, free: 0, alt: 0
};

// —— 复刻 steps-b.js 的渲染逻辑，检测 undefined ——
function renderLabelOfPoolItem(p) {
  // steps-b: var lbl = p.name || (d ? d.name : p.skill) + (p.sub ? '（' + p.sub + '）' : '');
  const d = p.skill ? byId[p.skill] : null;
  return p.name || ((d ? d.name : p.skill) + (p.sub ? '（' + p.sub + '）' : ''));
}
function renderFixedName(r) {
  const def = r.skill ? byId[r.skill] : null;
  return def ? def.name + (r.sub ? '（' + r.sub + '）' : (r.isGroup ? '（任选子类）' : '')) : r.skill;
}

OCC.listAll().forEach(o => {
  let reqs;
  try {
    reqs = OCC.parseSkillText(o.skillText);
  } catch (e) {
    bad.push({ job: o.name, err: String(e.message) });
    return;
  }
  reqs.forEach(r => {
    stats[r.type] = (stats[r.type] || 0) + 1;

    // 1) label 里出现 undefined
    if (r.label === undefined || /undefined/.test(String(r.label))) {
      undef.push({ job: o.name, where: 'label', type: r.type, label: r.label, raw: o.skillText });
    }
    // 2) 池子项渲染 undefined
    if (r.type === 'choice') {
      r.pool.forEach(p => {
        const lbl = renderLabelOfPoolItem(p);
        if (lbl === undefined || /undefined/.test(String(lbl))) {
          undef.push({ job: o.name, where: 'pool', type: r.type, item: p, raw: o.skillText });
        }
        if (!p.skill || !byId[p.skill]) {
          bad.push({ job: o.name, where: 'pool-unresolved', item: p, raw: o.skillText });
        }
      });
    }
    if (r.type === 'alt') {
      r.options.forEach(p => {
        // 择一里的选项本身可以是「组技能任选」（choice，没有 skill 字段），这是合法的
        if (p.type === 'choice') {
          if (!p.pool || !p.pool.length) bad.push({ job: o.name, where: 'alt-empty-choice', item: p, raw: o.skillText });
          return;
        }
        if (!p.skill || !byId[p.skill]) {
          bad.push({ job: o.name, where: 'alt-unresolved', item: p, raw: o.skillText });
        }
      });
    }
    if (r.type === 'fixed') {
      const nm = renderFixedName(r);
      if (nm === undefined || /undefined/.test(String(nm))) {
        undef.push({ job: o.name, where: 'fixed', type: r.type, r: r, raw: o.skillText });
      }
      if (!r.skill || !byId[r.skill]) {
        bad.push({ job: o.name, where: 'fixed-unresolved', item: r, raw: o.skillText });
      }
      // 组技能带 sub 但 sub 不在子类里
      if (r.skill && byId[r.skill] && byId[r.skill].special && r.sub) {
        if (!byId[r.skill].subskills.some(x => x.name === r.sub)) {
          bad.push({ job: o.name, where: 'bad-sub', skill: r.skill, sub: r.sub, raw: o.skillText });
        }
      }
    }
    // 3) free 项没有 raw 但 label 为空
    if (r.type === 'free' && !r.label) {
      undef.push({ job: o.name, where: 'free-empty-label', raw: o.skillText });
    }
  });
});

console.log('=== 解析统计 ===');
console.log(stats);
console.log('\n=== 解析失败 / 未识别（' + bad.length + '）===');
const uniqBad = {};
bad.forEach(b => {
  const k = b.job + '|' + b.where + '|' + JSON.stringify(b.item || b.sub || b.err);
  if (!uniqBad[k]) uniqBad[k] = b;
});
Object.values(uniqBad).slice(0, 60).forEach(b => console.log(' -', b.job, b.where, JSON.stringify(b.item || b.sub || b.err)));

console.log('\n=== 会出现 undefined 的地方（' + undef.length + '）===');
const uniqUndef = {};
undef.forEach(u => {
  const k = u.job + '|' + u.where;
  if (!uniqUndef[k]) uniqUndef[k] = u;
});
Object.values(uniqUndef).slice(0, 60).forEach(u => console.log(' -', u.job, u.where, JSON.stringify(u.item || u.r || u.label), '<<', u.raw));

// —— 社交技能专项：池子里缺哪些 ——
console.log('\n=== 社交技能池覆盖情况 ===');
const social = ['charm', 'fast_talk', 'intimidate', 'persuade'];
const missings = [];
OCC.listAll().forEach(o => {
  const reqs = OCC.parseSkillText(o.skillText);
  reqs.forEach(r => {
    if (r.type !== 'choice') return;
    const ids = r.pool.map(p => p.skill);
    const isSocial = ids.some(i => social.includes(i));
    if (isSocial) {
      const lack = social.filter(s => !ids.includes(s));
      if (lack.length) missings.push({ job: o.name, label: r.label, have: ids, lack: lack });
    }
  });
});
console.log('缺项的社交技能选择：' + missings.length);
missings.slice(0, 40).forEach(m => console.log(' -', m.job, '|', m.label, '| 缺', m.lack.join(',')));
