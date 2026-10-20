/* 审计：room-ui.js 里用 el(...) 建的 pageRefs 节点**必须都被挂载**
 *
 * 为什么要有这条守卫：
 *   v1.18.5 收口轮真出过一个 bug —— renderGamePage() 里
 *       chatEl: el('div.gp-chat')
 *   建好了、也往里塞了 chatListEl 和 chatBar()（.room-chatbar），
 *   却**忘了** pageRefs.root.appendChild(pageRefs.chatEl)。
 *   结果 .gp-chat / .room-chatbar 都成了**游离节点**（不在文档里），
 *   运行时六区域断言直接报「缺失区域: chat,chatbar」，聊天双向、
 *   旁观者发送禁用等一整片用例连带失败。
 *
 *   这类「建了节点忘了挂」的错误靠人眼 review 极易漏掉，所以做成静态审计：
 *   凡是 pageRefs 上「用 el( 初始化」的键，都必须存在**值用法**
 *   —— 即出现 `pageRefs.<key>` 且其后**不是 `.`**
 *   （作为 appendChild(...) 的实参、或出现在子节点数组里）。
 *   `pageRefs.<key>.appendChild(...)` 属于「接收者用法」，**不算**挂载
 *   （那只说明它自己是个父节点，不代表它挂在树上）。
 *
 * 白名单：root、isGame —— 它们本来就不是「待挂载的节点」
 *   （root 是挂载容器本身；isGame 是布尔标记）。
 *
 * 自检方法（改 room-ui.js 后请手动验一遍，确保守卫真的会响）：
 *   1) 把 room-ui.js 里 `pageRefs.root.appendChild(pageRefs.chatEl);`
 *      那一行临时注释掉 → 本脚本必须 RESULT: FAIL（报 chatEl 未挂载）；
 *   2) 恢复该行 → 必须 RESULT: PASS。
 *
 * 全程离线，只读文件，不发任何网络请求。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'web', 'js', 'ui', 'room-ui.js');

/* 先剥掉注释（保持字符串内容不动）再分析。
   为什么必须这么做：如果只扫原文，**被注释掉的 appendChild 依然会被算成「已挂载」**
   —— 那样守卫就形同虚设（有人把挂载行注释掉，脚本照样报 PASS）。
   字符串感知的剥离：逐字符走，区分「代码 / 行注释 / 块注释 / '…' / "…" / `…`」。 */
function stripComments(code) {
  let out = '';
  let i = 0;
  const n = code.length;
  let state = 'code'; // code | line | block | sq | dq | tq
  while (i < n) {
    const c = code[i];
    const d = i + 1 < n ? code[i + 1] : '';
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") { state = 'sq'; out += c; i++; continue; }
      if (c === '"') { state = 'dq'; out += c; i++; continue; }
      if (c === '`') { state = 'tq'; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; i++; continue; }
      out += ' '; i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += (c === '\n' ? '\n' : ' '); i++; continue;
    }
    /* 字符串内部：处理转义，遇到同种引号即结束 */
    if (c === '\\') { out += c + d; i += 2; continue; }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') ||
        (state === 'tq' && c === '`')) {
      state = 'code'; out += c; i++; continue;
    }
    out += c; i++; continue;
  }
  return out;
}

const src = stripComments(fs.readFileSync(FILE, 'utf8'));

let fail = 0;
const bad = (m) => { console.log('  [FAIL] ' + m); fail++; };
const ok = (m) => console.log('  [OK]   ' + m);

/* 1) 抓出所有 `pageRefs = { ... };` 对象字面量 */
const blocks = [];
const blockRe = /pageRefs\s*=\s*\{([\s\S]*?)\n\s*\};/g;
let m;
while ((m = blockRe.exec(src))) blocks.push(m[1]);

/* 2) 收集「用 el( 初始化」的键（形如 `chatEl: el('div.gp-chat')`） */
const keys = [];
blocks.forEach((blk) => {
  const keyRe = /^\s*([A-Za-z_$][\w$]*)\s*:\s*el\(/gm;
  let k;
  while ((k = keyRe.exec(blk))) {
    if (keys.indexOf(k[1]) < 0) keys.push(k[1]);
  }
});

/* 3) 白名单：不是「待挂载的 DOM 节点」 */
const WHITELIST = ['root', 'isGame'];

/* 4) 是否存在「值用法」：pageRefs.<key> 后面不是 '.' */
function hasValueUse(key) {
  const re = new RegExp('pageRefs\\.' + key + '\\b', 'g');
  let mm;
  while ((mm = re.exec(src))) {
    if (src[mm.index + mm[0].length] !== '.') return true;
  }
  return false;
}

console.log('== room-ui.js：pageRefs 节点挂载审计 ==');
console.log('  扫描文件: ' + path.relative(ROOT, FILE));
console.log('  发现 ' + blocks.length + ' 处 pageRefs 字面量，' +
  keys.length + ' 个 el(...) 键：' + keys.join(', '));

keys.forEach((key) => {
  if (WHITELIST.indexOf(key) >= 0) {
    console.log('  [skip] ' + key + '（白名单：本就不是待挂载节点）');
    return;
  }
  if (hasValueUse(key)) {
    ok('pageRefs.' + key + ' 已作为值使用（已挂载到树上）');
  } else {
    bad('pageRefs.' + key + ' 只有「接收者用法」（pageRefs.' + key +
      '.xxx(...)），却从未作为值被 appendChild —— 典型 bug：建了 DOM 节点忘了挂载');
  }
});

console.log('\n' + (fail === 0 ? 'RESULT: PASS' : 'RESULT: FAIL —— ' + fail + ' 项不通过'));
process.exit(fail === 0 ? 0 : 1);
