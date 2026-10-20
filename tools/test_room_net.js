/* ============================================================
 * test_room_net.js —— 跑团房间传输层单元测试（纯 Node，用假 WebSocket / 假 fetch）
 *
 * 为什么值得测：这一层干的是「翻译」——把 RoomModel 的发送计划翻译成中继的
 * hub.send / hub.broadcast，再把中继的 peer.* 翻译回模型调用。
 * 翻译错一处的表现都很隐蔽：
 *   · 发错人 → 别人看不见，界面上什么都没发生
 *   · 重连接管时按 cid 判定离线 → 刚回来的人被显示成掉线
 *   · 被踢的人又连上 → 不拦住就变成「踢不掉」
 *   · 地址优先级搞反 → 局域网邀请打开却连到公网
 *
 * 用法：node tools/test_room_net.js
 * 成功时最后一行打印 RESULT: PASS
 * ============================================================ */
'use strict';

global.window = global;
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
eval(fs.readFileSync(path.join(root, 'web/js/core/room-model.js'), 'utf8'));
eval(fs.readFileSync(path.join(root, 'web/js/core/room-net.js'), 'utf8'));

const M = global.RoomModel;
const N = global.RoomNet;

/* ---------------- 迷你断言框架 ---------------- */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(label + (extra === undefined ? '' : '　→ 实际: ' + JSON.stringify(extra)));
}
function eq(a, b, label) { ok(a === b, label, a); }
function section(n) { console.log('\n=== ' + n + ' ==='); }

/* ---------------- 假 WebSocket ---------------- */
const socks = [];
class FakeWS {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWS.last = this;
    socks.push(this);
  }
  send(t) { this.sent.push(t); }
  close(code, reason) {
    this.readyState = 3;
    if (this.onclose) this.onclose({ code: code || 1000, reason: reason || '' });
  }
  /* --- 测试专用 --- */
  fireOpen() { this.readyState = 1; if (this.onopen) this.onopen({}); }
  inject(obj) {
    if (this.onmessage) this.onmessage({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) });
  }
  drain() {
    const out = this.sent.map(t => { try { return JSON.parse(t); } catch (e) { return t; } });
    this.sent = [];
    return out;
  }
}
global.WebSocket = FakeWS;

/* ============================================================
 * 1. 服务地址解析
 * ============================================================ */
section('1. 服务地址解析（局域网 / 公网）');

(function () {
  const stash = { loc: global.location, inj: global.ROOM_SERVER_BASE, store: global.Store, bc: global.BuildConfig };
  function setEnv(loc, inj, userBase, preset) {
    global.location = loc === null ? undefined : { search: loc };
    global.ROOM_SERVER_BASE = inj || undefined;
    global.Store = userBase === null
      ? undefined
      : { getState: () => ({ settings: { roomBase: userBase } }) };
    global.BuildConfig = { roomBase: preset || '' };
  }

  // ① 邀请链接里的地址优先级最高（加入方一定是「刚才那个房间」所在的服务）
  setEnv('?room=ab12cd&srv=http%3A%2F%2F192.168.1.5%3A12710', 'https://injected.example/room',
         'https://user.example/room', 'https://preset.example/room');
  eq(N.base(), 'http://192.168.1.5:12710', '邀请链接里的地址优先级最高');
  eq(N.inviteParams().code, 'ab12cd', '同时解析出房间号');

  // ② 没有邀请参数时用宿主注入的（局域网外壳）
  setEnv('', 'https://injected.example/room', 'https://user.example/room', 'https://preset.example/room');
  eq(N.base(), 'https://injected.example/room', '没有邀请参数时用宿主注入的地址');

  // ③ 再退到用户设置
  setEnv('', '', 'https://user.example/room', 'https://preset.example/room');
  eq(N.base(), 'https://user.example/room', '再退到用户设置里的地址');

  // ④ 最后是打包预置
  setEnv('', '', '', 'https://preset.example/room');
  eq(N.base(), 'https://preset.example/room', '最后用打包预置的地址');

  // ⑤ 都没有 → 未配置
  setEnv('', '', '', '');
  eq(N.base(), '', '都没有时返回空串（表示未配置）');
  eq(N.configured(), false, '未配置时 configured()=false');
  eq(N.userBase(), '', '用户没填时 userBase 为空');

  // 结尾斜杠会被规范化掉，避免拼出 //api/rooms
  setEnv('', 'https://x.example/room///', '', '');
  eq(N.base(), 'https://x.example/room', '结尾斜杠被规范化');
  setEnv('', 'http://192.168.1.5:12710/', '', '');
  eq(N.base(), 'http://192.168.1.5:12710', '局域网地址同样规范化');

  // 非法值一律不采纳（防止把「未填写」当成地址用）
  setEnv('', 'not-a-url', '', '');
  eq(N.base(), '', '非法地址被忽略');
  setEnv('?srv=javascript%3Aalert(1)', '', '', '');
  eq(N.base(), '', '非 http(s) 的邀请参数被忽略');
  setEnv('?room=ab12cd&srv=ftp%3A%2F%2Fx', '', '', '');
  eq(N.base(), '', 'ftp 地址被忽略');
  eq(N.inviteParams().code, 'ab12cd', '但房间号仍然解析出来（界面可以提示地址无效）');

  // ws 地址换算
  eq(N.wsBase('https://coc.example/room'), 'wss://coc.example/room', 'https → wss');
  eq(N.wsBase('http://192.168.1.5:12710'), 'ws://192.168.1.5:12710', 'http → ws');
  setEnv('', 'https://s.example/room', '', '');
  eq(N.wsBase(), 'wss://s.example/room', '不传参数时用当前生效地址');

  // 局域网判定（界面要提示「同一 WiFi 才能连」）
  eq(N.isPrivateHost('http://192.168.1.5:12710'), true, '192.168.x.x 是局域网');
  eq(N.isPrivateHost('http://10.0.0.7:12710'), true, '10.x.x.x 是局域网');
  eq(N.isPrivateHost('http://172.16.3.4:12710'), true, '172.16-31 是局域网');
  eq(N.isPrivateHost('http://172.40.3.4:12710'), false, '172.40 不是私有段');
  eq(N.isPrivateHost('http://localhost:12710'), true, 'localhost 算本机');
  eq(N.isPrivateHost('http://127.0.0.1:12710'), true, '127.0.0.1 算本机');
  eq(N.isPrivateHost('https://coc.example/room'), false, '公网域名不是局域网');
  eq(N.isPrivateHost(''), false, '空地址不是局域网');

  eq(N.looksValid('https://x.example/room'), true, '合法地址通过校验');
  eq(N.looksValid('x.example/room'), false, '缺协议头不通过');
  eq(N.looksValid('  https://x.example/room  '), true, '两侧空白不影响校验');

  // 还原环境，后面的用例自己设
  global.location = stash.loc;
  global.ROOM_SERVER_BASE = stash.inj;
  global.Store = stash.store;
  global.BuildConfig = stash.bc;
})();

/* ============================================================
 * 2. HTTP 层（假 fetch）
 * ============================================================ */
section('2. HTTP 层');

const httpCalls = [];
global.location = { search: '' };
global.ROOM_SERVER_BASE = 'https://room.example/base';

function stubFetch(handler) {
  global.fetch = function (url, opt) {
    httpCalls.push({ url: url, opt: opt });
    return Promise.resolve(handler(url, opt));
  };
}
function jsonRes(obj, status) {
  const s = status || 200;
  return {
    ok: s >= 200 && s < 300, status: s,
    text: () => Promise.resolve(JSON.stringify(obj))
  };
}

const httpTests = [];

httpTests.push(function () {
  stubFetch(() => jsonRes({ ok: true, service: 'coc-room' }));
  return N.health().then(j => {
    eq(httpCalls[0].url, 'https://room.example/base/health', 'health 拼出正确 URL');
    eq(httpCalls[0].opt.method, 'GET', 'health 用 GET');
    eq(j.service, 'coc-room', 'health 返回体被解析');
  });
});

httpTests.push(function () {
  httpCalls.length = 0;
  stubFetch(() => jsonRes({ ok: true, rooms: [{ code: 'ab12cd' }] }));
  return N.list().then(j => {
    eq(httpCalls[0].url, 'https://room.example/base/api/rooms', '目录 URL 正确');
    eq(j.rooms.length, 1, '目录解析出房间');
  });
});

httpTests.push(function () {
  httpCalls.length = 0;
  stubFetch(() => jsonRes({ code: 'ab12cd' }));
  return N.probe('ab12cd', 'spectator').then(() => {
    eq(httpCalls[0].url, 'https://room.example/base/api/rooms/ab12cd/probe', '预检 URL 正确');
    eq(httpCalls[0].opt.method, 'POST', '预检用 POST');
    eq(JSON.parse(httpCalls[0].opt.body).role, 'spectator', '预检带上角色');
    eq(httpCalls[0].opt.headers['Content-Type'], 'application/json', '预检声明 JSON');
  });
});

httpTests.push(function () {
  httpCalls.length = 0;
  stubFetch(() => jsonRes({ ok: true, code: 'zz99xx', hostToken: 'T', wsBase: 'wss://room.example/base' }));
  return N.create({ name: '测试团', kpName: 'KP', maxPlayers: 4, password: 'pw' }).then(j => {
    eq(httpCalls[0].url, 'https://room.example/base/api/rooms', '建房 URL 正确');
    const body = JSON.parse(httpCalls[0].opt.body);
    eq(body.name, '测试团', '建房带上房间名');
    eq(body.maxPlayers, 4, '建房带上人数上限');
    eq(j.hostToken, 'T', '建房返回 hostToken');
  });
});

httpTests.push(function () {
  httpCalls.length = 0;
  stubFetch(() => jsonRes({ ok: true, mtoken: 't1', wsUrl: 'wss://room.example/base/ws?code=ab12cd&t=t1' }));
  return N.join('ab12cd', { nickname: '小明', password: 'pw' }).then(j => {
    eq(httpCalls[0].url, 'https://room.example/base/api/rooms/ab12cd/join', '加入 URL 正确');
    eq(j.mtoken, 't1', '加入返回成员凭据');
  });
});

httpTests.push(function () {
  httpCalls.length = 0;
  stubFetch(() => jsonRes({ ok: true, code: 'ab12cd' }));
  return N.closeRoom('ab12cd', 'T').then(() => {
    eq(httpCalls[0].url, 'https://room.example/base/api/rooms/ab12cd/close', '关房 URL 正确');
    eq(JSON.parse(httpCalls[0].opt.body).hostToken, 'T', '关房带上房主凭据');
  });
});

// 错误映射：把服务端的原因码与提示原样交给界面（界面要显示「为什么进不去」）
httpTests.push(function () {
  stubFetch(() => jsonRes({ ok: false, reason: 'PLAYER_FULL', message: '玩家席已满（4/4）' }, 403));
  return N.join('ab12cd', { nickname: '小明' }).then(
    () => { ok(false, '满员时应当抛错'); },
    e => {
      eq(e.status, 403, '错误里带 HTTP 状态码');
      eq(e.reason, 'PLAYER_FULL', '错误里带机器可读原因码');
      eq(e.message, '玩家席已满（4/4）', '错误里带给用户看的原话');
    });
});

httpTests.push(function () {
  stubFetch(() => jsonRes({ ok: false, reason: 'BAD_PASSWORD', message: '房间密码不正确' }, 403));
  return N.probe('ab12cd').then(
    () => { ok(false, '密码错误时应当抛错'); },
    e => { eq(e.reason, 'BAD_PASSWORD', '密码错误的原因码透传'); });
});

// 未配置地址时立刻拒绝，不要发半个请求
httpTests.push(function () {
  global.ROOM_SERVER_BASE = undefined;
  global.Store = undefined;
  global.BuildConfig = { roomBase: '' };
  const before = httpCalls.length;
  return N.list().then(
    () => { ok(false, '未配置地址时应当拒绝'); },
    e => {
      eq(e.message, 'UNCONFIGURED', '未配置地址时返回 UNCONFIGURED');
      eq(httpCalls.length, before, '未配置地址时不发请求');
    }).then(() => {
      global.ROOM_SERVER_BASE = 'https://room.example/base';
    });
});

/* ---- 生效地址的来源：界面靠它说清「现在到底在用哪个服务器」 ---- */
(function () {
  const saved = {
    loc: global.location, inj: global.ROOM_SERVER_BASE,
    store: global.Store, cfg: global.BuildConfig
  };
  function setEnv(o) {
    global.location = { search: o.search || '' };
    global.ROOM_SERVER_BASE = o.injected;
    global.Store = (o.user == null) ? undefined
      : { getState: () => ({ settings: { roomBase: o.user } }) };
    global.BuildConfig = { roomBase: o.preset || '' };
  }

  setEnv({ user: '', preset: '' });
  eq(N.resolve().source, 'none', '都没配 → 来源 none');
  eq(N.base(), '', '都没配 → base 为空串');

  setEnv({ user: '', preset: 'https://preset.example/room' });
  eq(N.resolve().source, 'preset', '只有打包预置 → preset');

  setEnv({ user: 'https://mine.example/room', preset: 'https://preset.example/room' });
  eq(N.resolve().source, 'user', '用户设置压过打包预置');

  /* ⚠️ 这条是本次修复的核心事实：局域网注入**有意**压过用户设置 ——
     「我这台手机现在就是服务器」，用它的地址才是对的。
     问题不在优先级，而在界面从不说「你填的地址暂时不生效」、也没有关闭入口，
     于是表现成「填了公网地址也没用、检测连通性还报连不上」。 */
  setEnv({ injected: 'http://192.168.1.9:4211', user: 'https://mine.example/room' });
  eq(N.resolve().source, 'injected', '局域网注入压过用户设置（有意的）');
  eq(N.resolve().base, 'http://192.168.1.9:4211', '生效的是注入的局域网地址');
  ok(N.isPrivateHost(N.base()), '注入的地址被识别为局域网');
  eq(N.userBase(), 'https://mine.example/room', '用户设置没被丢掉（关掉局域网后能立刻恢复）');

  setEnv({ search: '?room=ab12cd&srv=' + encodeURIComponent('https://host.example/room'),
           injected: 'http://192.168.1.9:4211', user: 'https://mine.example/room' });
  eq(N.resolve().source, 'invite', '邀请链接优先级最高');
  eq(N.resolve().base, 'https://host.example/room', '邀请链接里的地址生效');

  global.location = saved.loc;
  global.ROOM_SERVER_BASE = saved.inj;
  global.Store = saved.store;
  global.BuildConfig = saved.cfg;
})();

/* ---- 连不上时，错误必须说清「试的是哪个地址、是哪一类问题」 ----
   以前浏览器原样抛 "Failed to fetch"、超时只说「请检查网络」，
   局域网与公网两种模式下是**同一句话**：用户没法描述、我们没法定位。 */
httpTests.push(function () {
  global.ROOM_SERVER_BASE = 'http://192.168.1.9:4211';
  global.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
  return N.req('GET', '/health', null, 500).then(
    () => { ok(false, '网络不通时应当抛错'); },
    e => {
      eq(e.code, 'network', '网络层失败归类为 network');
      eq(e.base, 'http://192.168.1.9:4211', '错误里带上试的是哪个地址');
      ok(e.message.indexOf('Failed to fetch') < 0, '不把裸浏览器错误透给用户');
      /* ⚠️ 这条断言随文案一起改过：以前无论什么地址都只说「无法连接」，
         于是局域网（裸 IP）失败也被说成「域名解析失败」——而 IP 根本没有域名。
         现在局域网/公网分开措辞，所以这里改成断言局域网那一句。 */
      ok(/局域网/.test(e.message), '给一句能读懂的中文（局域网地址指向局域网该查的东西）');
      ok(e.message.indexOf('域名解析失败') < 0, '局域网地址不再被误导为「域名解析失败」');
    });
});

httpTests.push(function () {
  global.fetch = function (url, opt) {
    return new Promise(function (_res, rej) {
      if (opt && opt.signal) {
        opt.signal.addEventListener('abort', function () {
          const e = new Error('aborted');
          e.name = 'AbortError';
          rej(e);
        });
      }
    });
  };
  return N.req('GET', '/health', null, 60).then(
    () => { ok(false, '无响应时应当超时'); },
    e => {
      eq(e.code, 'timeout', '无响应归类为 timeout');
      eq(e.base, 'http://192.168.1.9:4211', '超时也带上是哪个地址');
      ok(/连接超时/.test(e.message), '超时提示里说明等了几秒');
    });
});

httpTests.push(function () {
  global.ROOM_SERVER_BASE = 'https://room.example/base';
  stubFetch(() => jsonRes({ ok: false, message: '只有房主可以关闭房间' }, 403));
  return N.closeRoom('ab12cd', 'bad').then(
    () => { ok(false, '403 应当抛错'); },
    e => {
      eq(e.code, 'http', 'HTTP 层错误归类为 http（不是 network）');
      eq(e.status, 403, '保留状态码，界面按它分支');
      eq(e.base, 'https://room.example/base', 'HTTP 错误也带上是哪个地址');
    });
});

/* ============================================================
 * 3. 权威端（KP）侧：发送计划的翻译
 * ============================================================ */
section('3. 权威端侧的协议翻译');

function newHostSide(opts) {
  const host = new M.Host({ meta: { code: 'ab12cd', name: '测试团', kpName: 'KP', maxPlayers: 4 } });
  const side = new N.HostSide(Object.assign({
    host: host,
    room: { code: 'ab12cd', wsUrl: 'ws://room.example/base/ws?code=ab12cd&t=T', hostToken: 'T' },
    /* ⚠️ 关掉自动存档：否则每次内容变更会排一个 800ms 定时器，
       在后面的 HTTP 用例里触发 fetch，污染其它用例的请求计数。 */
    autoSave: false
  }, opts || {}));
  side.open();
  const sock = FakeWS.last;
  sock.fireOpen();
  sock.inject({ k: 'ready', cid: 'chost', seat: 'host', role: 'kp', code: 'ab12cd' });
  sock.inject({ k: 'host.ok', meta: { code: 'ab12cd', name: '测试团', status: 'RECRUITING' }, counts: { players: 0 } });
  sock.drain();
  return { host: host, side: side, sock: sock };
}

(function () {
  const t = newHostSide();
  eq(t.side.selfCid, 'chost', '记录了权威端自己的 cid');

  // peer.open → 成员表广播 + 给新人的全量同步
  t.sock.inject({ k: 'peer.open', cid: 'c1', seat: 's1', role: 'player', nickname: '小明', ip: '1.2.3.4', rejoin: false });
  const sent = t.sock.drain();
  eq(sent.length, 2, 'peer.open 产生两条：成员表广播 + 给新人的全量同步');
  eq(sent[0].k, 'hub.broadcast', '第一条是群发的成员表');
  ok(JSON.parse(sent[0].text).t === 'members', '群发的是 members 事件');
  ok(sent[0].text.includes('小明'), '成员表里有新人');
  eq(sent[1].k, 'hub.send', '第二条是单发给新人的同步');
  eq(sent[1].cid, 'c1', '同步发给新人的 cid');
  eq(JSON.parse(sent[1].text).k, 'sync', '新人拿到的是全量 sync');
  eq(t.host.roster.players().length, 1, '花名册里多了这名玩家');
})();

(function () {
  const t = newHostSide();
  t.sock.inject({ k: 'peer.open', cid: 'c1', seat: 's1', role: 'player', nickname: '小明' });
  t.sock.drain();

  // peer.msg → 应用层意图 → 广播
  t.sock.inject({ k: 'peer.msg', cid: 'c1', text: JSON.stringify(M.intentMsg(M.INTENT.CHAT, { text: '大家好' })) });
  const sent = t.sock.drain();
  eq(sent.length, 1, '玩家发言产生一条广播');
  eq(sent[0].k, 'hub.broadcast', '发言走群发');
  const ev = JSON.parse(sent[0].text);
  eq(ev.t, 'chat', '广播的是 chat 事件');
  eq(ev.p.text, '大家好', '内容原样带上');
  eq(ev.p.nickname, '小明', '自动补上昵称');

  // 不认识的 cid：忽略，不要瞎猜是谁
  t.sock.inject({ k: 'peer.msg', cid: 'c-unknown', text: JSON.stringify(M.intentMsg(M.INTENT.CHAT, { text: 'x' })) });
  eq(t.sock.drain().length, 0, '陌生 cid 的消息被忽略');

  // 中继层自己的消息从 peer.msg 来也不该被当意图执行
  t.sock.inject({ k: 'peer.msg', cid: 'c1', text: JSON.stringify({ k: 'peer.open', cid: 'x' }) });
  eq(t.sock.drain().length, 0, '非 intent 载荷被忽略');
})();

(function () {
  /* 重连接管的竞态：服务端可能先发新的 peer.open 再发旧的 peer.close。
     如果不比对 cid，就会把刚回来的人又标成离线。 */
  const t = newHostSide();
  t.sock.inject({ k: 'peer.open', cid: 'c1', seat: 's1', role: 'player', nickname: '小明' });
  t.sock.drain();

  t.sock.inject({ k: 'peer.open', cid: 'c2', seat: 's1', role: 'player', nickname: '小明', rejoin: false });
  t.sock.drain();
  eq(t.host.roster.get('s1').online, true, '重连后在线');
  eq(t.host.roster.get('s1').cid, 'c2', 'cid 已更新为新连接');
  eq(t.host.roster.players().length, 1, '重连不会多出一个座位');
  eq(t.host.state.members.length, 1, '成员表里也只有一个人');

  // 老连接随后关闭 —— 必须被忽略
  t.sock.inject({ k: 'peer.close', cid: 'c1', seat: 's1' });
  const sent = t.sock.drain();
  eq(t.host.roster.get('s1').online, true, '老连接关闭不会把新连接标成离线');
  eq(sent.length, 0, '老连接关闭不产生任何广播');

  // 新连接真的断了 → 才标离线
  t.sock.inject({ k: 'peer.close', cid: 'c2', seat: 's1' });
  const sent2 = t.sock.drain();
  eq(t.host.roster.get('s1').online, false, '当前连接关闭才标离线');
  eq(t.host.roster.get('s1').ready, false, '状态正确');
  eq(sent2.length, 1, '离线只广播一次成员表');
  eq(sent2[0].k, 'hub.broadcast', '离线走群发');
})();

(function () {
  // 被踢的人又连上来 → 让中继断开他（否则就是「踢不掉」）
  const t = newHostSide();
  t.sock.inject({ k: 'peer.open', cid: 'c1', seat: 's1', role: 'player', nickname: '小明' });
  t.sock.drain();
  t.side._dispatch(t.host.kick('s1'));
  t.sock.drain();
  eq(t.host.roster.get('s1'), null, '被踢者已离开花名册');

  t.sock.inject({ k: 'peer.open', cid: 'c2', seat: 's1', role: 'player', nickname: '小明' });
  const sent = t.sock.drain();
  eq(sent.length, 1, '被踢者重连只产生一条指令');
  eq(sent[0].k, 'hub.close', '发的是 hub.close（让中继断开他）');
  eq(sent[0].cid, 'c2', '指向新连接');
  eq(t.host.roster.get('s1'), null, '他没能回到花名册');
})();

(function () {
  // 房间状态变化要上报给中继，目录里才显示对
  const t = newHostSide();
  t.sock.inject({ k: 'peer.open', cid: 'c1', seat: 's1', role: 'player', nickname: '小明' });
  t.sock.drain();

  t.side._dispatch(t.host.applyAction('host', { op: 'room.start' }));
  const sent = t.sock.drain();
  const meta = sent.filter(x => x.k === 'hub.meta');
  eq(meta.length, 1, '开团后上报一次状态');
  eq(meta[0].meta.status, 'IN_GAME', '上报的状态是 IN_GAME');

  // 状态没变就不要重复上报（省流量，也让日志可读）
  t.side._dispatch(t.host.applyAction('host', { op: 'combat.next' }));
  eq(t.sock.drain().filter(x => x.k === 'hub.meta').length, 0, '状态没变时不重复上报');
})();

(function () {
  // 私密内容只发给目标：翻译成 hub.send，绝不出现 hub.broadcast
  const t = newHostSide();
  t.sock.inject({ k: 'peer.open', cid: 'c1', seat: 's1', role: 'player', nickname: '小明' });
  t.sock.inject({ k: 'peer.open', cid: 'c2', seat: 's2', role: 'player', nickname: '小红' });
  t.sock.drain();

  t.side._dispatch(t.host.applyAction('host', { op: 'scene.clue', seat: 's1', title: '线索', text: '密室在东侧' }));
  const sent = t.sock.drain();
  const toS1 = sent.filter(x => x.k === 'hub.send' && x.cid === 'c1');
  const toS2 = sent.filter(x => x.k === 'hub.send' && x.cid === 'c2');
  ok(toS1.some(x => x.text.includes('密室在东侧')), '线索单发给目标玩家');
  ok(!toS2.some(x => x.text.includes('密室在东侧')), '另一个玩家拿不到线索内容');
  ok(!sent.some(x => x.k === 'hub.broadcast' && x.text.includes('密室在东侧')), '线索绝不出现在群发里');
  ok(toS2.some(x => JSON.parse(x.text).k === 'skip'), '另一个玩家收到的是水位标记');
})();

(function () {
  // 不在线的人没有 cid：不要硬发（会变成发给空地址）
  const t = newHostSide();
  t.sock.inject({ k: 'peer.open', cid: 'c1', seat: 's1', role: 'player', nickname: '小明' });
  t.sock.drain();
  t.sock.inject({ k: 'peer.close', cid: 'c1', seat: 's1' });
  t.sock.drain();

  t.side._dispatch(t.host.applyAction('host', { op: 'scene.clue', seat: 's1', title: 'x', text: '离线者的线索' }));
  const sent = t.sock.drain();
  eq(sent.filter(x => x.k === 'hub.send').length, 0, '离线的人不发单发消息');
})();

(function () {
  /* act() 是界面唯一该走的出口：界面不该直接碰 _dispatch（私有），
     也不该自己拼 applyAction 的参数顺序。 */
  const t = newHostSide();
  t.sock.inject({ k: 'peer.open', cid: 'c1', seat: 's1', role: 'player', nickname: '小明' });
  t.sock.drain();

  const plan = t.side.act({ op: 'room.start' });
  ok(Array.isArray(plan) && plan.length > 0, 'act() 返回发送计划（便于测试与诊断）');
  const sent = t.sock.drain();
  ok(sent.length > 0, 'act() 把计划真的发出去了');
  eq(t.host.state.meta.status, 'IN_GAME', 'act() 之后权威端状态已推进');

  // 动作的目标（线索给谁）写在 action 里，跟 room.kick 一样
  t.side.act({ op: 'scene.clue', seat: 's1', title: '线索', text: '东侧有暗门' });
  const sent2 = t.sock.drain();
  ok(sent2.some(x => x.k === 'hub.send' && x.cid === 'c1' && x.text.includes('东侧有暗门')),
     'act() 按 action.seat 单发给目标');
})();

(function () {
  /* 房主自己发起动作的两条通路，缺任何一条都会「没反应但不报错」：
       · intent() —— 界面上「发言」只有一个入口，房主和玩家共用同一份代码；
         没有它，房主打字回车完全没动静。
       · onPeer    —— 玩家那边状态一变（准备/发言），房主端状态变了却不重画，
         页面永远停在「等待全员准备」。而状态断言是查不出这个的。 */
  const t = newHostSide();
  const events = [];
  t.side.onPeer = (kind, mem, raw) => events.push(kind);

  const plan = t.side.intent('chat', { text: '你们进了地下室' });
  ok(Array.isArray(plan), '房主的 intent() 返回发送计划');
  const sent = t.sock.drain();
  ok(sent.some(x => x.k === 'hub.broadcast' && x.text.includes('地下室')), '房主发言被群发出去');
  ok(events.includes('self'), '房主自己发言后也通知界面重画');

  /* act()/request() 走的是同一个出口（_dispatch）。曾经这里没有通知界面，
     结果是「模型变了、界面没变」：开战后 KP 面板还停在探索页，
     连「下一个行动」按钮都不在 DOM 里 —— 而状态断言是查不出来的。
     现在 _dispatch 统一负责重画，这条断言就守住这个不变量。 */
  events.length = 0;
  t.side.act({ op: 'scene.set', scene: { title: '地下室' } });
  ok(events.includes('self'), 'act() 之后同样通知界面重画（不靠调用点自觉）');

  events.length = 0;
  t.side.request({ op: 'room.start' });
  ok(events.includes('self'), 'request() 之后同样通知界面重画');

  // 玩家的意图到达 → 必须触发 onPeer（房主页面靠它刷新）
  t.sock.inject({ k: 'peer.open', cid: 'c1', seat: 's1', role: 'player', nickname: '小明' });
  t.sock.drain();
  /* v2.0.0（契约 §5.4）：READY 现在必须先绑角色卡。先上报一张卡，再准备。 */
  t.sock.inject({ k: 'peer.msg', cid: 'c1', text: JSON.stringify(M.intentMsg(M.INTENT.CHAR, { id: 'c-1', name: '小明' })) });
  t.sock.drain();
  events.length = 0;
  t.sock.inject({ k: 'peer.msg', cid: 'c1', text: JSON.stringify(M.intentMsg(M.INTENT.READY, { ready: true })) });
  t.sock.drain();
  ok(events.includes('msg'), '玩家提交意图后通知界面重画（否则成员表永远不刷新）');
  eq(t.host.roster.get('s1').ready, true, '准备状态确实写进了花名册');
})();

(function () {
  /* request / confirmAct —— 高危动作的「二次确认」必须真的经过模型排队，
     不能靠界面自己弹个框就算数：伪造一条 act() 就能绕过。
     这里断言「不确认就不生效、确认后才生效」。 */
  const t = newHostSide();

  // 普通动作：request 等价于 act，立刻执行
  t.side.request({ op: 'room.start' });
  eq(t.host.state.meta.status, M.STATUS.IN_GAME, '普通动作经 request 直接生效');

  // 高危动作：request 只排队，不生效
  const plan = t.side.request({ op: 'session.end' });
  ok(Array.isArray(plan), 'request 返回发送计划');
  ok(t.host.pending.some(q => q.op === 'session.end'), '高危动作进入待确认队列');
  ok(t.host.state.meta.status !== M.STATUS.CLOSED, '未确认前房间没关');
  ok(t.host.state.meta.ended !== true, '未确认前没有「已结团」标记');

  // 取消 → 不生效
  t.side.confirmAct('session.end', false);
  ok(t.host.state.meta.status !== M.STATUS.CLOSED, '取消后房间仍然开着');

  // 再来一次并确认 → 生效
  t.side.request({ op: 'session.end' });
  t.side.confirmAct('session.end', true);
  eq(t.host.state.meta.status, M.STATUS.CLOSED, '确认后房间关闭（结团生效）');
  eq(t.host.state.meta.ended, true, '确认后标记「已结团」');

  // 权限表外的动作：request 一律拒绝，不产生任何发送
  const t2 = newHostSide();
  const bad = t2.side.request({ op: '这不是一个动作' });
  eq(bad.length, 0, '权限表外的动作被 request 拦下（空计划）');
  eq(t2.sock.drain().length, 0, '被拦下的动作一条消息都不发');
})();

/* ============================================================
 * 4. 玩家侧：重连补拉与中继通知
 * ============================================================ */
section('4. 玩家侧的补拉与通知');

function newPlayerSide() {
  const client = new M.Client({ seat: 's1', role: 'player' });
  const events = [];
  const states = [];
  const side = new N.PlayerSide({
    client: client,
    room: { code: 'ab12cd', wsUrl: 'ws://room.example/base/ws?code=ab12cd&t=t1', mtoken: 't1' },
    onEvent: (st, info) => { states.push(st); events.push(info); },
    onState: s => events.push({ kind: 'link', s: s })
  });
  side.open();
  const sock = FakeWS.last;
  sock.fireOpen();
  return { client: client, side: side, sock: sock, events: events };
}

(function () {
  const t = newPlayerSide();
  // 连上就自报家门（带 lastSeq），这是断线重连的全部秘密
  const sent = t.sock.drain();
  eq(sent.length, 1, '连上后立刻发一条消息');
  eq(sent[0].k, 'intent', '发的是意图');
  eq(sent[0].op, 'sync', '发的是 sync 意图');
  eq(sent[0].p.lastSeq, 0, '带上 lastSeq');

  // 权威端回全量同步
  t.sock.inject(M.syncMsg(3, {
    meta: { code: 'ab12cd', name: '测试团', status: 'RECRUITING' },
    members: [{ seat: 's1', nickname: '小明', role: 'player', online: true, ready: false }],
    chats: [{ seq: 1, text: 'hi', at: 1 }], logs: [], dice: [], scene: null, combat: null,
    privates: [], seq: 3
  }));
  eq(t.client.lastSeq, 3, '同步后 lastSeq 对齐');
  eq(t.client.state.members.length, 1, '成员表就位');
  eq(t.client.state.chats.length, 1, '历史聊天就位');

  // 增量事件按序应用
  t.sock.inject(M.evtMsg({ seq: 4, evt: { t: 'chat', p: { text: '第二条', at: 2 } } }));
  eq(t.client.state.chats.length, 2, '增量事件被应用');

  // 丢包 → 自动补拉（不需要界面干预）
  t.events.length = 0;
  t.sock.inject(M.evtMsg({ seq: 6, evt: { t: 'chat', p: { text: '跳过了', at: 3 } } }));
  const sent2 = t.sock.drain();
  eq(sent2.length, 1, '发现丢包后自动发一条补拉请求');
  eq(sent2[0].op, 'sync', '补拉用的是 sync 意图');
  eq(sent2[0].p.lastSeq, 4, '补拉带上最后的连续序号');
  eq(t.client.state.chats.length, 2, '缺口事件没有被应用');
  ok(t.events.some(e => e.kind === 'gap'), '界面能收到「正在补齐」的通知');

  // 补齐后继续正常
  t.sock.inject(M.evtMsg({ seq: 5, evt: { t: 'chat', p: { text: '第五条', at: 4 } } }));
  t.sock.inject(M.evtMsg({ seq: 6, evt: { t: 'chat', p: { text: '第六条', at: 5 } } }));
  eq(t.client.state.chats.length, 4, '补齐后聊天连续');
  eq(t.client.gapFrom, 0, '补齐后缺口标记清零');
  eq(t.client.lastSeq, 6, 'lastSeq 追上');
})();

(function () {
  const t = newPlayerSide();
  t.sock.inject(M.syncMsg(1, { meta: { code: 'ab12cd' }, members: [], chats: [], logs: [], dice: [], scene: null, combat: null, privates: [], seq: 1 }));

  // 房主断线：中继通知，界面要能说清楚
  t.events.length = 0;
  t.sock.inject({ k: 'host.gone', message: '房主已断开，正在等待重连' });
  ok(t.events.some(e => e.kind === 'host-gone'), '收到房主断线通知');

  // 被踢
  t.sock.inject(M.evtMsg({ seq: 2, evt: { t: 'kick', p: { reason: '你已被房主移出房间' } } }));
  eq(t.side.kicked, '你已被房主移出房间', '记录了被踢原因');
  eq(t.client.state.meta.status, 'CLOSED', '被踢后房间状态标记为结束');

  // 关房
  const t2 = newPlayerSide();
  t2.sock.inject(M.syncMsg(1, { meta: { code: 'ab12cd' }, members: [], chats: [], logs: [], dice: [], scene: null, combat: null, privates: [], seq: 1 }));
  t2.sock.inject(M.evtMsg({ seq: 2, evt: { t: 'closed', p: {} } }));
  eq(t2.side.closedByHost, true, '记录了房主关房');
  eq(t2.client.state.meta.status, 'CLOSED', '关房后状态为 CLOSED');
})();

(function () {
  // 水位标记：不该触发 onEvent（没有状态变化，界面不需要重绘）
  const t = newPlayerSide();
  t.sock.inject(M.syncMsg(1, { meta: { code: 'ab12cd' }, members: [], chats: [], logs: [], dice: [], scene: null, combat: null, privates: [], seq: 1 }));
  t.events.length = 0;
  t.sock.inject(M.skipMsg(2));
  eq(t.events.length, 0, '水位标记不触发界面回调');
  eq(t.client.lastSeq, 2, '但 lastSeq 被推进');
  // 紧接着的公共事件必须能被正常接受（水位标记的作用）
  t.sock.inject(M.evtMsg({ seq: 3, evt: { t: 'chat', p: { text: 'ok', at: 1 } } }));
  eq(t.client.state.chats.length, 1, '水位标记之后的公共事件正常应用');
  eq(t.client.gapFrom, 0, '全程没有误判丢包');
})();

/* ============================================================
 * 4b. 玩家侧：握手消息里的 seat 必须落进 Client
 * ============================================================ */

(function () {
  /* 服务端的 ready 是**中继层**消息（{k:'ready'}），不是应用层信封，
     所以它走的是 parse()→null 的中继分支。早期版本这条分支只看 host.gone，
     于是玩家永远不知道自己是谁：成员表里认不出自己、准备按钮永远是灰的、
     自己发的聊天不靠右。这组断言就是钉住这一点的。 */
  const client = new M.Client({ seat: '', role: 'player' });
  const events = [];
  const side = new N.PlayerSide({
    client: client,
    room: { code: 'ab12cd', wsUrl: 'ws://room.example/base/ws?code=ab12cd&t=t1', mtoken: 't1' },
    onEvent: (st, info) => { events.push(info); }
  });
  side.open();
  const sock = FakeWS.last;
  sock.fireOpen();

  eq(client.seat, '', '握手前还不知道自己是谁');

  events.length = 0;
  sock.inject({ k: 'ready', cid: 'c0ffee', seat: 'seat7', role: 'player', code: 'ab12cd' });
  eq(client.seat, 'seat7', '握手消息里的 seat 被记录下来');
  eq(side.selfCid, 'c0ffee', 'cid 记在传输层（发信地址，界面不需要）');
  ok(events.some(e => e.kind === 'ready'), '通知界面可以重画了');

  // 重连场景：同一份凭据回来，seat 不变（所以座位/准备状态不会丢）
  sock.inject({ k: 'ready', cid: 'c1d11', seat: 'seat7', role: 'player', code: 'ab12cd' });
  eq(client.seat, 'seat7', '重连后 seat 保持不变');
  eq(side.selfCid, 'c1d11', '但 cid 换成了新的（发信地址每次连接都变）');
})();

/* ============================================================
 * 5. 断线重连（Link 层）
 * ============================================================ */
section('5. 连接的重连与队列');

(function () {
  const states = [];
  const link = N.connect('ws://x/ws', { onState: s => states.push(s) });
  const s1 = FakeWS.last;
  eq(link.state, 'connecting', '初始状态是连接中');
  s1.fireOpen();
  eq(link.state, 'online', '握手成功后变为在线');

  // 断线：状态变离线，并且会安排重连
  s1.readyState = 3;
  s1.onclose({ code: 1006, reason: '' });
  eq(link.state, 'offline', '异常断开后变为离线');
  eq(FakeWS.last, s1, '此时还没有新建连接（要等退避时间）');

  // 断线期间发的消息进队列
  link.send('断线期间的消息');
  eq(link.queue.length, 1, '断线期间消息进队列');

  link.close();
  eq(link.state, 'closed', '手动关闭后不再重连');
  eq(link.queue.length, 0, '手动关闭清空队列');
})();

(function () {
  // 服务端主动关（1000 / 4000+）不重连：重连一百次也还是被拒
  const states = [];
  let fatal = null;
  const link = N.connect('ws://x/ws', { onState: (s, i) => states.push(s), onFatal: r => { fatal = r; } });
  const s1 = FakeWS.last;
  s1.fireOpen();
  s1.onclose({ code: 4001, reason: '凭据无效' });
  eq(link.state, 'closed', '业务性关闭不进入重连');
  eq(fatal, '凭据无效', '把关闭原因交给上层（界面据此提示重新加入）');

  // 异常码（1006）要重连
  const states2 = [];
  const link2 = N.connect('ws://x/ws', { onState: s => states2.push(s) });
  FakeWS.last.fireOpen();
  FakeWS.last.onclose({ code: 1006, reason: '' });
  eq(link2.state, 'offline', '网络类断开会安排重连');
  link2.close();
})();

(function () {
  // 队列上限：不能无限攒（连着几分钟连不上时会把内存吃掉）
  const link = N.connect('ws://x/ws', {});
  FakeWS.last.onclose({ code: 1006, reason: '' });
  for (let i = 0; i < 260; i++) link.send('m' + i);
  eq(link.queue.length, 200, '队列上限 200 条');
  eq(link.queue[link.queue.length - 1], 'm259', '丢的是最老的，保留最新的');
  link.close();
})();

/* ============================================================
 * 2b. 多候选地址与超时预算（「开房连不上」的加固）
 *
 * 背景：用户报告公网开房永远「连接超时（5 秒内没有响应）」，而同一时刻
 * 我们从桌面直接打这个域名，/health 200、CORS 预检 204、POST /api/rooms
 * 真的建出了房间 —— 服务本身是好的。唯一可观测的异常是 Cloudflare 边缘节点
 * 落在海外（cf-ray …-AMS），对国内手机这条跨境链路可能根本不通。
 *
 * 我们无法在本地复现用户的网络，于是把「单点域名不通」降级成「慢一点」：
 *   · 地址可以配多个，主地址网络层失败就自动换下一个
 *   · 超时从 5 秒放宽（跨境首包 >5s 是常事），避免把「慢」误报成「连不上」
 * ============================================================ */
section('2b. 多地址回退与超时预算');

(function () {
  const saved = { loc: global.location, inj: global.ROOM_SERVER_BASE, store: global.Store, cfg: global.BuildConfig };

  // ① 用户可以把多个候选地址写在一起（逗号 / 分号 / 空白都算分隔）
  global.location = { search: '' };
  global.ROOM_SERVER_BASE = undefined;
  global.Store = { getState: () => ({ settings: {
    roomBase: 'https://a.example/room, https://b.example/room;https://c.example/room'
  } }) };
  global.BuildConfig = { roomBase: '' };
  eq(N.baseCount(), 3, '逗号/分号/空格分隔的多个地址都被识别');
  eq(N.base(), 'https://a.example/room', 'base() 返回第一个（主地址）');
  eq(N.baseList()[1], 'https://b.example/room', '顺序即优先级');

  // ② 用户地址与打包预置合并、且用户优先；重复的去掉
  global.Store = { getState: () => ({ settings: { roomBase: 'https://a.example/room' } }) };
  global.BuildConfig = { roomBase: 'https://a.example/room,https://backup.example/room' };
  eq(N.baseList().length, 2, '用户与预置里的重复地址只留一份');
  eq(N.baseList()[0], 'https://a.example/room', '用户设置的排在预置前面');

  /* ③ ⚠️ 邀请链接与宿主注入是**强指定**：它们一旦存在就只有一个候选。
     退到别的地址会连到一台不相干的服务器，报出更莫名其妙的错。 */
  global.location = { search: '?room=ab12cd&srv=' + encodeURIComponent('https://host.example/room') };
  global.Store = { getState: () => ({ settings: { roomBase: 'https://a.example/room,https://b.example/room' } }) };
  global.BuildConfig = { roomBase: 'https://preset.example/room' };
  eq(N.baseCount(), 1, '邀请链接存在时不退到别的地址');
  eq(N.base(), 'https://host.example/room', '强行用邀请链接里的地址');

  global.location = { search: '' };
  global.ROOM_SERVER_BASE = 'http://192.168.1.9:4211';
  eq(N.baseCount(), 1, '局域网注入同样不参与回退（那台手机才是服务器）');

  // ④ 非法项被逐个剔掉，不会因为一个坏值把整串地址废掉
  global.ROOM_SERVER_BASE = undefined;
  global.Store = { getState: () => ({ settings: {
    roomBase: 'not-a-url, https://good.example/room ,ftp://x/y'
  } }) };
  global.BuildConfig = { roomBase: '' };
  eq(N.baseList().length, 1, '非法地址被剔除，保留合法的那一个');
  eq(N.base(), 'https://good.example/room', '剩下的合法地址成为主地址');

  // ⑤ 拆分函数本身可单独用（界面提示、测试都会用到）
  eq(N.splitBases('a').length, 0, '不成 URL 的串被丢弃');
  eq(N.splitBases('').length, 0, '空串得空数组');

  global.location = saved.loc;
  global.ROOM_SERVER_BASE = saved.inj;
  global.Store = saved.store;
  global.BuildConfig = saved.cfg;
})();

/* ---- 回退行为：主地址网络层失败 → 自动换下一个；服务端明确拒绝 → 不换 ---- */
httpTests.push(function () {
  const saved = { inj: global.ROOM_SERVER_BASE, store: global.Store, cfg: global.BuildConfig };
  global.ROOM_SERVER_BASE = undefined;
  global.Store = { getState: () => ({ settings: { roomBase: 'https://dead.example/room,https://alive.example/room' } }) };
  global.BuildConfig = { roomBase: '' };

  const tried = [];
  global.fetch = function (url) {
    tried.push(url);
    if (url.indexOf('dead.example') >= 0) return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve(jsonRes({ ok: true, service: 'coc-room' }));
  };
  return N.health().then(j => {
    eq(j.service, 'coc-room', '主地址不通时自动用备用地址');
    eq(tried.length, 2, '两个地址各试一次');
    ok(tried[0].indexOf('dead.example') >= 0, '先试主地址');
    ok(tried[1].indexOf('alive.example') >= 0, '再试备用地址');
  }).then(() => {
    global.ROOM_SERVER_BASE = saved.inj;
    global.Store = saved.store;
    global.BuildConfig = saved.cfg;
  });
});

httpTests.push(function () {
  const saved = { inj: global.ROOM_SERVER_BASE, store: global.Store, cfg: global.BuildConfig };
  global.ROOM_SERVER_BASE = undefined;
  global.Store = { getState: () => ({ settings: {
    roomBase: 'https://primary.example/room,https://backup.example/room'
  } }) };
  global.BuildConfig = { roomBase: '' };

  /* ⚠️ 这条是防回归的关键：服务端**答了但拒绝**（403 密码错）时绝不能换地址。
     换了地址就会把「密码错」显示成「连不上」，用户会去查网络而不是改密码 ——
     这正是最容易被忽略、又最难查的一类体验 bug。 */
  const tried = [];
  global.fetch = function (url) {
    tried.push(url);
    return Promise.resolve(jsonRes({ ok: false, reason: 'BAD_PASSWORD', message: '房间密码不正确' }, 403));
  };
  return N.join('ab12cd', { nickname: '小明' }).then(
    () => { ok(false, '403 时应当抛错'); },
    e => {
      eq(e.reason, 'BAD_PASSWORD', '真错误原样透传，没有被改写成「连不上」');
      eq(tried.length, 1, '服务端答过就不再换地址');
    }).then(() => {
      global.ROOM_SERVER_BASE = saved.inj;
      global.Store = saved.store;
      global.BuildConfig = saved.cfg;
    });
});

httpTests.push(function () {
  const saved = { inj: global.ROOM_SERVER_BASE, store: global.Store, cfg: global.BuildConfig };
  global.ROOM_SERVER_BASE = undefined;
  global.Store = { getState: () => ({ settings: {
    roomBase: 'https://one.example/room,https://two.example/room'
  } }) };
  global.BuildConfig = { roomBase: '' };

  global.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
  return N.health().then(
    () => { ok(false, '全部地址都不通时应当抛错'); },
    e => {
      /* 界面要能列出「试过哪些地址」——只报「连不上」，用户说不清是哪个域名的锅 */
      ok(Array.isArray(e.triedAll) && e.triedAll.length === 2, '失败时带上所有试过的地址');
      eq(e.base, 'https://one.example/room', 'base 指向主地址（用户最先该去查的那个）');
    }).then(() => {
      global.ROOM_SERVER_BASE = saved.inj;
      global.Store = saved.store;
      global.BuildConfig = saved.cfg;
    });
});

httpTests.push(function () {
  /* 超时预算必须比以前宽：health 原来 5 秒，手机跨境首连经常超过它，
     于是「慢」被误报成「服务不在」。这条断言把预算钉住，防止以后被改回去。 */
  ok(N.DEFAULT_TIMEOUTS.health >= 12000, 'health 超时预算 ≥12 秒（原来 5 秒会误报超时）');
  ok(N.DEFAULT_TIMEOUTS.post >= 20000, '建房超时预算 ≥20 秒（建房比查询慢得多）');

  global.ROOM_SERVER_BASE = 'https://room.example/base';
  global.Store = undefined;
  global.BuildConfig = { roomBase: '' };
  httpCalls.length = 0;
  stubFetch(() => jsonRes({ ok: true, service: 'coc-room' }));
  return N.health().then(() => {
    eq(httpCalls.length, 1, '地址通时只发一次请求（重试不滥用）');
    eq(httpCalls[0].url, 'https://room.example/base/health', 'health 仍走正确路径');
  });
});

httpTests.push(function () {
  /* GET 是幂等的 → 网络层失败允许静默重试一次。
     但**必须只重试 GET**：POST /api/rooms 是建房，重试会建出两个房间。 */
  global.ROOM_SERVER_BASE = 'https://room.example/base';
  global.Store = undefined;
  global.BuildConfig = { roomBase: '' };
  let n = 0;
  global.fetch = function () {
    n += 1;
    if (n === 1) return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve(jsonRes({ ok: true, service: 'coc-room' }));
  };
  return N.health().then(j => {
    eq(j.service, 'coc-room', 'GET 第一次失败后静默重试成功');
    eq(n, 2, '重试确实发生了第二次');
  });
});

httpTests.push(function () {
  /* POST 绝不重试：建房重试 = 房间里凭空多出一间，而且房主只知道自己那间。 */
  global.ROOM_SERVER_BASE = 'https://room.example/base';
  global.Store = undefined;
  global.BuildConfig = { roomBase: '' };
  let n = 0;
  global.fetch = function () {
    n += 1;
    return Promise.reject(new TypeError('Failed to fetch'));
  };
  return N.create({ name: '团', kpName: 'KP' }).then(
    () => { ok(false, '建房不通时应当抛错'); },
    () => { eq(n, 1, '建房失败不自动重试（避免建出两个房间）'); });
});

httpTests.push(function () {
  /* ⚠️ 超时**不**重试。这是 v1.18.2 特意加的规则：
     超时说明我们已经把 12 秒预算等满了，再来一轮就是让用户再干等 12 秒，
     手机上总等待拉到 ~24 秒 —— 而结果极可能一模一样。
     「秒失败」（network）才值得重试。 */
  global.ROOM_SERVER_BASE = 'https://room.example/base';
  global.Store = undefined;
  global.BuildConfig = { roomBase: '' };
  let n = 0;
  global.fetch = function (url, opt) {
    n += 1;
    return new Promise(function (_res, rej) {
      if (opt && opt.signal) {
        opt.signal.addEventListener('abort', function () {
          const e = new Error('aborted');
          e.name = 'AbortError';
          rej(e);
        });
      }
    });
  };
  return N.req('GET', '/health', null, 80, 1).then(
    () => { ok(false, '超时应当抛错'); },
    e => {
      eq(e.code, 'timeout', '归类为 timeout');
      eq(n, 1, '超时不重试（重试会让手机多等一整个超时预算）');
    });
});

httpTests.push(function () {
  /* 对照：秒失败（network）**要**重试 —— DNS 冷启动 / 刚切网络重来一次命中率高。 */
  global.ROOM_SERVER_BASE = 'https://room.example/base';
  global.Store = undefined;
  global.BuildConfig = { roomBase: '' };
  let n = 0;
  global.fetch = function () {
    n += 1;
    return Promise.reject(new TypeError('Failed to fetch'));
  };
  return N.req('GET', '/health', null, 5000, 1).then(
    () => { ok(false, '全失败时应当抛错'); },
    e => {
      eq(e.code, 'network', '归类为 network');
      eq(n, 2, '秒失败会重试一次（成本低、命中率高）');
    });
});

httpTests.push(function () {
  /* 重试是**跨整份候选列表**做的，不是每个地址各试一遍：
     配了 2 个地址、第一个不通时若按地址重试，会变成 3~4 次请求、耗时翻倍，
     而备用的意义恰恰是「主地址不可用」—— 死地址上再来一次毫无价值。 */
  global.ROOM_SERVER_BASE = undefined;
  global.Store = { getState: () => ({ settings: {
    roomBase: 'https://one.example/room,https://two.example/room'
  } }) };
  global.BuildConfig = { roomBase: '' };
  let n = 0;
  global.fetch = function () {
    n += 1;
    return Promise.reject(new TypeError('Failed to fetch'));
  };
  return N.req('GET', '/health', null, 5000, 1).then(
    () => { ok(false, '全失败时应当抛错'); },
    () => {
      /* 一轮 = 2 个地址；重试 1 次 = 再加一轮 → 4 次 */
      eq(n, 4, '两地址 × 两轮 = 4 次请求（不是每地址各自重试）');
    });
});

/* ---- 网络自检：把整条链路在用户手机上跑一遍，给出可截图的结论 ---- */
httpTests.push(function () {
  global.ROOM_SERVER_BASE = 'https://room.example/base';
  global.Store = undefined;
  global.BuildConfig = { roomBase: '' };
  const calls = [];
  global.fetch = function (url, opt) {
    calls.push({ url: url, method: (opt && opt.method) || 'GET' });
    if (/\/health$/.test(url)) return Promise.resolve(jsonRes({ ok: true, service: 'coc-room' }));
    if (/\/api\/rooms$/.test(url)) {
      return Promise.resolve(jsonRes({ ok: true, code: 'self01', hostToken: 'T', wsBase: 'wss://room.example/base' }));
    }
    return Promise.resolve(jsonRes({ ok: true }));
  };
  return N.selfCheck().then(res => {
    eq(res.ok, true, '自检判定链路正常');
    eq(res.steps.length, 3, '三个步骤：地址配置 / 连通 / 建房能力');
    eq(res.steps[0].name, '地址配置', '第一步说清配的是什么地址');
    ok(/room\.example/.test(res.steps[0].text), '第一步带上实际地址（用户能核对）');
    eq(res.steps[1].ok, true, '第二步连通正常');
    ok(typeof res.steps[1].ms === 'number', '第二步报出毫秒数（慢不慢一眼看到）');
    eq(res.steps[2].ok, true, '第三步真的建出了房');
    /* ⚠️ 自检建的房必须收拾干净，否则会污染玩家看到的房间列表。
       这条断言是**在真实服务器上抓到过 bug 才补的**：
       早先关房是 fire-and-forget，调用方一退出请求就发不出去，
       房间永远留着（实测在公网目录里攒了两个）。 */
    const closes = calls.filter(c => /\/close$/.test(c.url));
    eq(closes.length, 1, '自检结束后自动关闭试建的房间');
    ok(/已立刻关闭/.test(res.steps[2].text), '关房成功要如实写进结论');
    ok(!res.cleanupFailed, '正常情况下没有残留房间');
  });
});

httpTests.push(function () {
  /* 关房失败时**必须如实说**，不能假装干净 —— 用户会看到目录里多出来的房间。
     而且自检要等关房请求真的发完才返回（await），不能 fire-and-forget。 */
  global.ROOM_SERVER_BASE = 'https://room.example/base';
  global.Store = undefined;
  global.BuildConfig = { roomBase: '' };
  global.fetch = function (url, opt) {
    if (/\/health$/.test(url)) return Promise.resolve(jsonRes({ ok: true, service: 'coc-room' }));
    if (/\/api\/rooms$/.test(url)) {
      return Promise.resolve(jsonRes({ ok: true, code: 'self02', hostToken: 'T' }));
    }
    if (/\/close$/.test(url)) {
      return Promise.resolve(jsonRes({ ok: false, message: '只有房主可以关闭房间' }, 403));
    }
    return Promise.resolve(jsonRes({ ok: true }));
  };
  return N.selfCheck().then(res => {
    eq(res.cleanupFailed, 'self02', '关房失败时记下残留房间号');
    ok(/未能关闭/.test(res.steps[2].text), '结论里如实说明没关掉（不假装干净）');
  });
});

httpTests.push(function () {
  /* 「GET 通、POST 被挡」是反代配置里很常见的一种：
     检查连通性显示正常，开房却失败。自检必须把这两种分开报，否则用户会一直查网络。 */
  global.ROOM_SERVER_BASE = 'https://room.example/base';
  global.Store = undefined;
  global.BuildConfig = { roomBase: '' };
  global.fetch = function (url, opt) {
    if (/\/health$/.test(url)) return Promise.resolve(jsonRes({ ok: true, service: 'coc-room' }));
    if (/\/api\/rooms$/.test(url) && opt && opt.method === 'POST') {
      return Promise.resolve(jsonRes({ ok: false, message: 'Not Allowed' }, 405));
    }
    return Promise.resolve(jsonRes({ ok: true }));
  };
  return N.selfCheck().then(res => {
    eq(res.ok, true, '连通正常');
    eq(res.steps[2].ok, false, '但建房被拒绝要如实报出来');
    ok(/405/.test(res.steps[2].text), '带上 HTTP 状态码（服务端配置问题的直接线索）');
  });
});

httpTests.push(function () {
  /* ⚠️ 失败类型的**归类**必须准确，因为界面据它给建议。
     服务端答了 404 → 必须是 'http'，**不能**是 'network'：
     404 恰恰证明域名解析是成功的，说成「解析失败」等于给用户指错路。 */
  global.ROOM_SERVER_BASE = 'https://room.example/base';
  global.Store = undefined;
  global.BuildConfig = { roomBase: '' };
  global.fetch = () => Promise.resolve(jsonRes({ ok: false, message: 'Not Found' }, 404));
  return N.pingBase('https://room.example/base', 3000).then(r => {
    eq(r.ok, false, '404 算连通失败');
    eq(r.code, 'http', '答过错误码 → 归类为 http（不是 network）');
    ok(/404/.test(r.message), '消息里带上状态码');
  });
});

httpTests.push(function () {
  /* 对照：fetch 直接抛错（DNS 失败 / 拒绝连接）才是 'network'。 */
  global.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
  return N.pingBase('https://dead.example/base', 3000).then(r => {
    eq(r.code, 'network', '连都没连上 → network');
    ok(r.ms >= 0, '即使失败也报耗时');
  });
});

httpTests.push(function () {
  /* 超时单独归类：链路可能只是慢/被限速（跨境常见），与「完全不通」修法不同。 */
  global.fetch = function (url, opt) {
    return new Promise(function (_res, rej) {
      if (opt && opt.signal) {
        opt.signal.addEventListener('abort', function () {
          const e = new Error('aborted');
          e.name = 'AbortError';
          rej(e);
        });
      }
    });
  };
  return N.pingBase('https://slow.example/base', 60).then(r => {
    eq(r.code, 'timeout', '无响应 → timeout');
  });
});

httpTests.push(function () {
  /* 全部不通时，自检也必须把每一步都跑完 ——
     「DNS 都不通」和「DNS 通但服务不在」的修法完全不同，跳过就分不出来了。 */
  global.ROOM_SERVER_BASE = undefined;
  global.Store = { getState: () => ({ settings: {
    roomBase: 'https://one.example/room,https://two.example/room'
  } }) };
  global.BuildConfig = { roomBase: '' };
  global.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
  return N.selfCheck().then(res => {
    eq(res.ok, false, '全不通时判定失败');
    eq(res.steps.length, 3, '每个候选地址都被试过并如实记录');
    eq(res.steps[1].ok, false, '第一个地址不通');
    eq(res.steps[2].ok, false, '第二个地址不通');
    ok(res.steps[1].code === 'network' || res.steps[1].code === 'timeout', '带上失败类型（界面据此给不同的建议）');
  });
});

httpTests.push(function () {
  global.ROOM_SERVER_BASE = undefined;
  global.Store = undefined;
  global.BuildConfig = { roomBase: '' };
  return N.selfCheck().then(res => {
    eq(res.ok, false, '未配置地址时自检失败');
    eq(res.steps.length, 1, '未配置时只报「地址配置」这一步，不发无意义的请求');
  });
});

/* ============================================================
 * 2c. 局域网自检（local diagnose）
 *
 * 用户报「局域网模式开房还是提示无法连接」。局域网失败有三种成因，
 * 从外部看起来一模一样，必须靠**改探回环**把「服务没起」和
 * 「这条路被挡」区分开 —— 这一节就是在锁住那套判读。
 * ============================================================ */
section('2c. 局域网自检的判读');

/* 变换主机名：这是「改探回环」的实现，错了会把回环探到别处去 */
eq(N.swapHost('http://192.168.1.7:4211', '127.0.0.1'),
   'http://127.0.0.1:4211', 'swapHost 只换主机、保留端口');
eq(N.swapHost('http://10.0.0.5:8080/', '127.0.0.1'),
   'http://127.0.0.1:8080', 'swapHost 去掉末尾斜杠');
ok(N.isPrivateHost('http://10.0.0.5:4211'), '10.x 判为私有');
ok(N.isPrivateHost('http://172.20.1.1:4211'), '172.16-31 判为私有');
ok(!N.isPrivateHost('http://172.9.1.1:4211'), '172.9 不是私有段（边界）');
ok(!N.isPrivateHost('https://room.example.com'), '公网域名不是私有');

/* 场景 A：局域网 IP 通 → lan-ok */
httpTests.push(function () {
  global.Store = { getState: () => ({ settings: { roomBase: '' } }) };
  global.BuildConfig = { roomBase: '' };
  global.ROOM_SERVER_BASE = 'http://192.168.1.7:4211';
  stubFetch(() => jsonRes({ ok: true, service: 'coc-room-lan' }));
  return N.lanDiagnose('http://192.168.1.7:4211').then(res => {
    eq(res.verdict, 'lan-ok', '本机 IP 能通 → 判定 lan-ok');
    eq(res.ok, true, 'lan-ok 时 ok 为真');
    eq(res.steps.length, 3, '三步：地址 / 本机 IP / 回环');
    eq(res.steps[0].name, '局域网地址', '第一步先说清探的是哪个地址');
  });
});

/* 场景 B：本机 IP 不通、回环通 → lan-blocked（最有价值的一条） */
httpTests.push(function () {
  global.ROOM_SERVER_BASE = 'http://192.168.1.7:4211';
  /* ⚠️ stubFetch 会把返回值包进 Promise.resolve，所以这里返回**响应对象**；
     要模拟 fetch 抛错（网络层失败），得自己抛 —— 用一个直接 reject 的 fetch。 */
  global.fetch = (url) => /127\.0\.0\.1/.test(url)
    ? Promise.resolve(jsonRes({ ok: true, service: 'coc-room-lan' }))
    : Promise.reject(new TypeError('Failed to fetch'));
  return N.lanDiagnose('http://192.168.1.7:4211').then(res => {
    eq(res.verdict, 'lan-blocked', '服务活着但这个 IP 走不通 → lan-blocked');
    eq(res.ok, false, 'lan-blocked 时 ok 为假');
    eq(res.loopOk, true, '回环是通的（证明服务确实活着）');
    eq(res.lanOk, false, '本机 IP 不通');
  });
});

/* 场景 C：两探全废 → lan-dead（服务没起 or 明文被系统拦） */
httpTests.push(function () {
  global.ROOM_SERVER_BASE = 'http://192.168.1.7:4211';
  global.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
  return N.lanDiagnose('http://192.168.1.7:4211').then(res => {
    eq(res.verdict, 'lan-dead', '两个地址都不通 → lan-dead');
    eq(res.steps.length, 3, '失败路径也把两步都跑完，不因第一步失败就跳过');
  });
});

/* 场景 D：两探都超时 → lan-timeout（端口被占 / VPN 劫持） */
httpTests.push(function () {
  global.ROOM_SERVER_BASE = 'http://192.168.1.7:4211';
  global.fetch = () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  return N.lanDiagnose('http://192.168.1.7:4211').then(res => {
    eq(res.verdict, 'lan-timeout', '两探都超时 → lan-timeout');
  });
});

/* 场景 E：还没开服务 → lan-down，且不发任何请求 */
httpTests.push(function () {
  global.ROOM_SERVER_BASE = undefined;
  let called = 0;
  global.fetch = () => { called++; return Promise.reject(new TypeError('Failed to fetch')); };
  return N.lanDiagnose('').then(res => {
    eq(res.verdict, 'lan-down', '没有局域网地址 → lan-down');
    eq(called, 0, '没有地址时一个请求都不发');
    eq(res.steps.length, 1, 'lan-down 只报一步');
  });
});

/* ============================================================
 * 场景 F（v1.19.0）：lan-mixed-blocked —— 「明文被 WebView 拦」的回归哨兵
 *
 * 指纹：页面来源是 https，目标却是 http 的局域网 IP，且请求在**本地瞬时**
 * 被掐断（fetch 立刻抛 TypeError）。此时回环 127.0.0.1（被视为可信来源、
 * 不受混合内容限制）仍能通，而局域网 IP 不通 —— 旧判读会把它误报成
 * lan-blocked（让人去查 VPN / AP 隔离），指错了路。
 * ============================================================ */
httpTests.push(function () {
  const savedLoc = global.location;
  global.location = { protocol: 'https:', search: '' };
  global.ROOM_SERVER_BASE = 'http://192.168.1.7:4211';
  global.Store = { getState: () => ({ settings: { roomBase: '' } }) };
  global.BuildConfig = { roomBase: '' };
  global.fetch = (url) => /127\.0\.0\.1/.test(url)
    ? Promise.resolve(jsonRes({ ok: true, service: 'coc-room-lan' }))
    : Promise.reject(new TypeError('Failed to fetch'));
  return N.lanDiagnose('http://192.168.1.7:4211').then(res => {
    eq(res.verdict, 'lan-mixed-blocked',
       '★ 页面 https + http 局域网瞬时失败 → lan-mixed-blocked（明文被拦）');
    eq(res.mixedBlocked, true, '打上了混合内容哨兵标记');
    eq(res.loopOk, true, '回环仍能通（正是这一类的指纹）');
    global.location = savedLoc;
  }, e => { global.location = savedLoc; throw e; });
});

/* 对照 1：页面不是 https（http / 虚拟源）→ 没有混合内容限制，不能误判 */
httpTests.push(function () {
  const savedLoc = global.location;
  global.location = { protocol: 'http:', search: '' };
  global.ROOM_SERVER_BASE = 'http://192.168.1.7:4211';
  global.Store = { getState: () => ({ settings: { roomBase: '' } }) };
  global.BuildConfig = { roomBase: '' };
  global.fetch = (url) => /127\.0\.0\.1/.test(url)
    ? Promise.resolve(jsonRes({ ok: true, service: 'coc-room-lan' }))
    : Promise.reject(new TypeError('Failed to fetch'));
  return N.lanDiagnose('http://192.168.1.7:4211').then(res => {
    eq(res.verdict, 'lan-blocked', '非 https 页面 → 不判 mixed-blocked，仍是 lan-blocked');
    eq(res.mixedBlocked, false, '哨兵未触发（页面不是 https）');
    global.location = savedLoc;
  }, e => { global.location = savedLoc; throw e; });
});

/* 对照 2：https 页面但失败不是「瞬时」（≥150ms）→ 更像真实网络问题，不能误诊 */
httpTests.push(function () {
  const savedLoc = global.location;
  global.location = { protocol: 'https:', search: '' };
  global.ROOM_SERVER_BASE = 'http://192.168.1.7:4211';
  global.Store = { getState: () => ({ settings: { roomBase: '' } }) };
  global.BuildConfig = { roomBase: '' };
  global.fetch = (url) => {
    if (/127\.0\.0\.1/.test(url)) return Promise.resolve(jsonRes({ ok: true, service: 'coc-room-lan' }));
    return new Promise((_r, rej) => setTimeout(() => rej(new TypeError('Failed to fetch')), 220));
  };
  return N.lanDiagnose('http://192.168.1.7:4211').then(res => {
    eq(res.verdict, 'lan-blocked', '失败耗时 ≥150ms → 不判 mixed-blocked（避免把真网络问题误诊）');
    eq(res.mixedBlocked, false, '哨兵未触发（不是瞬时失败）');
    global.location = savedLoc;
  }, e => { global.location = savedLoc; throw e; });
});

/* 局域网错误文案必须与公网区分开：不能在裸 IP 上说「域名解析失败」 */
httpTests.push(function () {
  global.ROOM_SERVER_BASE = 'http://192.168.1.7:4211';
  global.Store = { getState: () => ({ settings: { roomBase: '' } }) };
  global.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
  return N.req('GET', '/health', null, 3000, 0).then(
    () => { ok(false, '不该成功'); },
    e => {
      eq(e.code, 'network', '网络层失败归类为 network');
      eq(e.lan, true, '标记为局域网失败，界面据此换用局域网自检');
      ok(e.message.indexOf('域名解析失败') < 0,
         '局域网地址的报错里不再出现「域名解析失败」（裸 IP 没有域名可解析）');
      ok(/同一 WiFi|AP 隔离|局域网/.test(e.message), '文案指向局域网真正的原因');
    });
});

/* 公网地址的文案保持不变（别把公网也带偏） */
httpTests.push(function () {
  global.ROOM_SERVER_BASE = undefined;
  global.Store = { getState: () => ({ settings: { roomBase: 'https://room.example.com' } }) };
  global.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
  return N.req('GET', '/health', null, 3000, 0).then(
    () => { ok(false, '不该成功'); },
    e => {
      eq(e.code, 'network', '公网失败仍是 network');
      ok(!e.lan, '公网失败不被打上局域网标记');
      ok(e.message.indexOf('域名解析失败') >= 0, '公网文案保留「域名解析失败」（那确实可能是原因）');
    });
});

/* ============================================================
 * 2d. HTTP 与 WS 必须走同一条路
 *
 * 这是「开房失败」最隐蔽的一个根因：
 *   建房 HTTP 走的是「国内源站直连 IP」（快），服务端却在返回体里
 *   写死一个**跨境域名**的 wsBase，客户端照抄 → WS 走跨境那条不通的路
 *   → 房间建出来了、界面却一直「重连中」，用户以为「建不了房」。
 * 修法两条：① wsUrlFor 按「实际成功那条路」推 WS；② activeBase 记住赢家。
 * ============================================================ */
section('2d. WS 与 HTTP 同路');

/* wsUrlFor：协议随基址走，路径拼对 */
eq(N.wsUrlFor('http://127.0.0.1/room', 'ab12cd', 'TOK'),
   'ws://127.0.0.1/room/ws?code=ab12cd&t=TOK',
   '明文基址 → ws://（直连源站必须这样，它没有证书）');
eq(N.wsUrlFor('https://room.example.com/room', 'ab12cd', 'TOK'),
   'wss://room.example.com/room/ws?code=ab12cd&t=TOK',
   'https 基址 → wss://');
eq(N.wsUrlFor('http://192.168.1.7:4211', 'ab12cd', 'TOK'),
   'ws://192.168.1.7:4211/ws?code=ab12cd&t=TOK',
   '局域网基址 → ws://（端口保留）');
ok(N.wsUrlFor('', 'ab12cd', 'TOK', { wsBase: 'wss://fb.example/room' })
     === 'wss://fb.example/room/ws?code=ab12cd&t=TOK',
   '基址缺失时退回服务端的 wsBase（兜底，不是首选）');
eq(N.wsUrlFor('', 'ab12cd', ''), '', '两边都没有时返回空串，而不是拼出个怪地址');
ok(N.wsUrlFor('http://127.0.0.1/room', 'ab/cd', 'a b').indexOf('ab%2Fcd') > 0,
   '房间号/凭据做了 URL 编码（别把特殊字符直接塞进 query）');

/* activeBase：初始回落主地址；备用赢下之后必须跟着换 */
httpTests.push(function () {
  global.ROOM_SERVER_BASE = undefined;
  global.Store = { getState: () => ({ settings: {
    roomBase: 'http://127.0.0.1/room,https://far.example/room' } }) };
  global.BuildConfig = { roomBase: '' };
  eq(N.activeBase(), 'http://127.0.0.1/room', '还没请求过时，activeBase 就是主地址');

  /* 主地址（直连 IP）不通 → 回退到备用域名 → 备用赢 */
  global.fetch = (url) => /150\.158\.38\.18/.test(url)
    ? Promise.reject(new TypeError('Failed to fetch'))
    : Promise.resolve(jsonRes({ ok: true, service: 'coc-room' }));
  return N.req('GET', '/health', null, 3000, 0).then(() => {
    eq(N.activeBase(), 'https://far.example/room',
       '★ 备用地址赢下之后，activeBase 跟着换 —— WS 才不会连到死掉的主地址上');
    /* 关键：WS 要沿备用那条路回去 */
    eq(N.wsUrlFor(N.activeBase(), 'ab12cd', 'TOK'),
       'wss://far.example/room/ws?code=ab12cd&t=TOK',
       '★ WS 落在「真正连通的那条路」上');
  });
});

/* activeBase 必须作废：用户改地址后，旧的成功记录不能继续生效 */
httpTests.push(function () {
  global.Store = { getState: () => ({ settings: {
    roomBase: 'https://old.example/room' } }) };
  global.fetch = () => Promise.resolve(jsonRes({ ok: true, service: 'coc-room' }));
  return N.req('GET', '/health', null, 3000, 0).then(() => {
    eq(N.activeBase(), 'https://old.example/room', '旧地址下的成功记录生效中');
    /* 用户换成另一个地址 */
    global.Store = { getState: () => ({ settings: {
      roomBase: 'https://new.example/room' } }) };
    eq(N.activeBase(), 'https://new.example/room',
       '★ 换了地址后旧的成功记录立刻作废（否则 WS 会连到不相干的服务器）');
  });
});

/* ============================================================
 * 6. v2.0.0 存档：HTTP 端点 / 节流推送 / 玩家拉取 / 状态回写
 * ============================================================ */
section('6. v2.0.0 存档与状态回写');

/* ---- HTTP 端点形状 ---- */
httpTests.push(function () {
  global.ROOM_SERVER_BASE = 'https://room.example/base';
  global.Store = undefined;
  global.BuildConfig = { roomBase: '' };
  httpCalls.length = 0;
  stubFetch(() => jsonRes({ ok: true, seq: 9, savedAt: 1700000000123 }));
  return N.saveState('ab12cd', 'T', 9, '{"v":2}').then(j => {
    eq(httpCalls[0].url, 'https://room.example/base/api/rooms/ab12cd/state', '存档 URL 正确');
    eq(httpCalls[0].opt.method, 'POST', '存档用 POST');
    const body = JSON.parse(httpCalls[0].opt.body);
    eq(body.hostToken, 'T', '存档带 hostToken');
    eq(body.seq, 9, '存档带 seq');
    eq(body.payload, '{"v":2}', 'payload 是不透明字符串（原样透传）');
    eq(j.savedAt, 1700000000123, '服务端回传 savedAt');
  });
});

httpTests.push(function () {
  httpCalls.length = 0;
  stubFetch(() => jsonRes({ ok: true, seq: 5, payload: '{"v":2}', savedAt: 1 }));
  return N.getState('ab12cd', 'mtok').then(j => {
    ok(httpCalls[0].url.indexOf('/api/rooms/ab12cd/state?token=mtok') >= 0, '拉存档 URL 带 token');
    eq(httpCalls[0].opt.method, 'GET', '拉存档用 GET');
    eq(j.payload, '{"v":2}', '拿到 payload');
  });
});

httpTests.push(function () {
  httpCalls.length = 0;
  stubFetch(() => jsonRes({ ok: false, error: 'no_state' }, 404));
  return N.getState('ab12cd', 'mtok').then(
    () => { ok(false, 'no_state 应当抛错（调用方优雅降级）'); },
    e => { eq(e.status, 404, '无存档返回 404'); eq(e.body.error, 'no_state', '错误码 no_state'); });
});

httpTests.push(function () {
  httpCalls.length = 0;
  stubFetch(() => jsonRes({ ok: true, status: 'SUSPENDED' }));
  return N.suspendRoom('ab12cd', 'T').then(j => {
    eq(httpCalls[0].url, 'https://room.example/base/api/rooms/ab12cd/suspend', '挂起 URL 正确');
    eq(JSON.parse(httpCalls[0].opt.body).hostToken, 'T', '挂起带 hostToken');
    eq(j.status, 'SUSPENDED', '挂起返回 SUSPENDED');
  });
});

httpTests.push(function () {
  httpCalls.length = 0;
  stubFetch(() => jsonRes({ ok: true, status: 'RECRUITING', seq: 5, payload: '{"v":2}' }));
  return N.resumeRoom('ab12cd', 'T').then(j => {
    eq(httpCalls[0].url, 'https://room.example/base/api/rooms/ab12cd/resume', '复活 URL 正确');
    eq(JSON.parse(httpCalls[0].opt.body).hostToken, 'T', '复活带 hostToken');
    eq(j.payload, '{"v":2}', '复活回传存档 payload');
  });
});

/* ---- HostSide：节流合并推送 + ARCHIVE 回执 ---- */
httpTests.push(function () {
  global.ROOM_SERVER_BASE = 'https://room.example/base';
  global.Store = undefined;
  global.BuildConfig = { roomBase: '' };
  httpCalls.length = 0;
  stubFetch(() => jsonRes({ ok: true, seq: 1, savedAt: 1 }));
  const host = new M.Host({ meta: { code: 'ab12cd', name: '测试团', kpName: 'KP' } });
  const side = new N.HostSide({
    host: host,
    room: { code: 'ab12cd', wsUrl: 'ws://x/ws?code=ab12cd&t=T', hostToken: 'T' },
    autoSave: true, saveWindow: 30
  });
  side.open();
  const sock = FakeWS.last;
  sock.fireOpen();
  sock.inject({ k: 'ready', cid: 'chost', seat: 'host', role: 'kp', code: 'ab12cd' });
  sock.inject({ k: 'host.ok', meta: { code: 'ab12cd', status: 'RECRUITING' }, counts: {} });
  sock.drain();
  httpCalls.length = 0;

  // 连续三次内容变更 → 节流窗口内合并
  side.act({ op: 'scene.set', scene: { title: '一' } });
  side.act({ op: 'scene.set', scene: { title: '二' } });
  side.act({ op: 'scene.set', scene: { title: '三' } });
  eq(httpCalls.filter(c => /\/state$/.test(c.url)).length, 0, '变更后不立刻发（节流窗口内合并）');

  return new Promise(resolve => setTimeout(resolve, 120)).then(() => {
    const posts = httpCalls.filter(c => /\/state$/.test(c.url));
    eq(posts.length, 1, '★ 节流：多次变更合并成一次存档推送');
    const body = JSON.parse(posts[0].opt.body);
    ok(body.seq > 0, '推送带 seq');
    ok(typeof body.payload === 'string' && body.payload.indexOf('"v":2') >= 0, 'payload 是存档字符串');
    ok(host.state.archive && host.state.archive.ok === true, '推送成功后发出 ARCHIVE 回执（仅 KP 可见）');
    /* ARCHIVE 不能反过来触发新的推送（否则死循环） */
    eq(httpCalls.filter(c => /\/state$/.test(c.url)).length, 1, 'ARCHIVE 回执不触发新一轮推送');
    side.destroy();
  });
});

/* ---- HostSide：suspend / resume 的 HTTP 副作用 ---- */
httpTests.push(function () {
  global.ROOM_SERVER_BASE = 'https://room.example/base';
  global.Store = undefined;
  global.BuildConfig = { roomBase: '' };
  httpCalls.length = 0;
  stubFetch((url) => {
    if (/\/suspend$/.test(url)) return jsonRes({ ok: true, status: 'SUSPENDED' });
    if (/\/resume$/.test(url)) {
      return jsonRes({ ok: true, status: 'RECRUITING', seq: 3,
        payload: JSON.stringify({ v: 2, meta: { code: 'ab12cd', status: 'IN_GAME' },
                                  members: [], chats: [], logs: [], dice: [] }) });
    }
    return jsonRes({ ok: true, seq: 1, savedAt: 1 });
  });
  const t = newHostSide();
  t.sock.drain();

  t.side.suspend();
  eq(t.host.state.meta.status, 'SUSPENDED', 'suspend() 后房间挂起');
  return new Promise(resolve => setTimeout(resolve, 30)).then(() => {
    ok(httpCalls.some(c => /\/suspend$/.test(c.url)), '★ 挂起触发了 POST /suspend');
    return t.side.resume();
  }).then(() => {
    ok(httpCalls.some(c => /\/resume$/.test(c.url)), '★ 复活触发了 POST /resume');
    eq(t.host.state.meta.status, 'RECRUITING', '复活后房间回到 RECRUITING');
    eq(t.host.state.meta.code, 'ab12cd', '复活后 meta 来自服务器存档');
    t.side.destroy();
  });
});

/* ---- PlayerSide：断线重连从服务器拉存档 ---- */
httpTests.push(function () {
  global.ROOM_SERVER_BASE = 'https://room.example/base';
  global.Store = undefined;
  global.BuildConfig = { roomBase: '' };
  const save = {
    v: 2, code: 'ab12cd', seq: 9, meta: { code: 'ab12cd', status: 'IN_GAME' },
    members: [{ seat: 's1', nickname: '小明', role: 'player', online: false, ready: true, charId: 'c-1',
                sheet: { name: '小明', madness: [{ type: 'phobia', name: '幽闭恐惧症' }], mental: ['永久疯狂'], sanLoss: 3, maxSAN: 60 } }],
    chats: [{ seq: 1, text: 'hi', at: 1 }], logs: [], dice: [], scene: null, combat: null,
    privateBySeat: {}, requestsBySeat: {}, boardBySeat: {}, localAssets: [], roundStarts: []
  };
  httpCalls.length = 0;
  global.fetch = function (url, opt) {
    httpCalls.push({ url: url, opt: opt });
    if (/\/state\?token=/.test(url)) {
      return Promise.resolve(jsonRes({ ok: true, seq: 9, payload: JSON.stringify(save), savedAt: 1 }));
    }
    return Promise.resolve(jsonRes({ ok: true }));
  };
  const client = new M.Client({ seat: 's1', role: 'player' });
  const events = [];
  const side = new N.PlayerSide({
    client: client, room: { code: 'ab12cd', wsUrl: 'ws://x/ws?code=ab12cd&t=t1', mtoken: 't1' },
    onEvent: (st, info) => events.push(info)
  });
  side.open();
  FakeWS.last.fireOpen();
  return new Promise(resolve => setTimeout(resolve, 40)).then(() => {
    ok(events.some(e => e.kind === 'server-state'), '★ 连上后从服务器拉存档并应用');
    eq(client.state.meta.status, 'IN_GAME', '拉到存档后房间状态就位');
    eq(client.state.chats.length, 1, '存档里的聊天就位');
    eq(client.lastSeq, 9, 'lastSeq 对齐到服务器存档 seq');
    ok(JSON.stringify(client.state).indexOf('幽闭恐惧症') >= 0, '本人拉取仍能看到自己的症状（本人全量）');
    side.destroy();
  });
});

httpTests.push(function () {
  /* 进程重启后 mtoken 会失效 → 拉取失败必须优雅降级，不能卡死/弹错 */
  global.ROOM_SERVER_BASE = 'https://room.example/base';
  global.Store = undefined;
  global.BuildConfig = { roomBase: '' };
  global.fetch = function () {
    return Promise.resolve(jsonRes({ ok: false, error: 'bad_token' }, 403));
  };
  const client = new M.Client({ seat: 's1', role: 'player' });
  const events = [];
  const side = new N.PlayerSide({
    client: client, room: { code: 'ab12cd', wsUrl: 'ws://x/ws?code=ab12cd&t=t1', mtoken: 't1' },
    onEvent: (st, info) => events.push(info)
  });
  side.open();
  FakeWS.last.fireOpen();
  return new Promise(resolve => setTimeout(resolve, 40)).then(() => {
    ok(!events.some(e => e.kind === 'server-state'), '拉不到存档时优雅降级（不应用）');
    eq(client.lastSeq, 0, 'lastSeq 不变（等房主重推）');
    eq(side.kicked, null, '拉取失败不会误判为被踢');
    side.destroy();
  });
});

/* ---- PlayerSide：角色卡状态写回（幂等）+ 回执 ---- */
httpTests.push(function () {
  global.ROOM_SERVER_BASE = undefined;      // 无地址 → 拉存档那条路径直接降级，不干扰本用例
  global.Store = undefined;
  global.BuildConfig = { roomBase: '' };
  const client = new M.Client({ seat: 's1', role: 'player' });
  const applied = [];
  const side = new N.PlayerSide({
    client: client, room: { code: 'ab12cd', wsUrl: 'ws://x/ws?code=ab12cd&t=t1', mtoken: 't1' },
    onSheetState: (p, r) => applied.push(p)
  });
  side.open();
  const sock = FakeWS.last;
  sock.fireOpen();
  sock.drain();
  sock.inject(M.syncMsg(1, { meta: { code: 'ab12cd' }, members: [], chats: [], logs: [], dice: [],
                             scene: null, combat: null, privates: [], seq: 1 }));
  sock.drain();

  sock.inject(M.evtMsg({ seq: 2, evt: { t: 'state',
    p: { seq: 3, seat: 's1', charId: 'c-1', status: { currentHP: 8 } } } }));
  eq(applied.length, 1, 'EVT.STATE 触发本机角色卡写回');
  let sent = sock.drain();
  const receipt = sent.find(x => x.k === 'intent' && x.op === 'statesync');
  ok(!!receipt, '★ 写回后回一条 INTENT.STATE_SYNC 回执');
  eq(receipt.p.seq, 3, '回执带上已应用的 seq');

  // 同一 seq 再投一次 → 幂等，不再写回、不再回执
  sock.inject(M.evtMsg({ seq: 3, evt: { t: 'state',
    p: { seq: 3, seat: 's1', charId: 'c-1', status: { currentHP: 8 } } } }));
  eq(applied.length, 1, '★ 同一 seq 重复投递不再写回（幂等）');
  sent = sock.drain();
  ok(!sent.some(x => x.k === 'intent' && x.op === 'statesync'), '同一 seq 不再重复回执');
  eq(client.lastStateSeq, 3, '记录已应用序号');
  side.destroy();
});

/* ---- v2.1.1 任务B：状态写回结果可观测（不静默）+ 先写回后重绘 ---- */
httpTests.push(function () {
  global.ROOM_SERVER_BASE = undefined;
  global.BuildConfig = { roomBase: '' };
  const savedStore = global.Store;
  const savedRS = global.RoomStore;
  const SYNC = M.syncMsg(1, { meta: { code: 'ab12cd' }, members: [], chats: [], logs: [], dice: [],
                              scene: null, combat: null, privates: [], seq: 1 });
  try {
    /* (1) 本房本卡有临时卡 → 走临时卡；记录「写卡」与「重绘」的先后 */
    const order = [];
    global.RoomStore = {
      getTempCard: function (code, cid) { return { id: cid }; },
      applyToTempCard: function (code, cid, p) { order.push('tempWrite'); return true; }
    };
    const client = new M.Client({ seat: 's1', role: 'player' });
    const diags = [];
    const side = new N.PlayerSide({
      client: client, room: { code: 'ab12cd', wsUrl: 'ws://x/ws?code=ab12cd&t=t1', mtoken: 't1' },
      onEvent: function () { order.push('repaint'); },
      onSheetApply: function (d) { diags.push(d); }
    });
    side.open();
    const sock = FakeWS.last;
    sock.fireOpen(); sock.drain();
    sock.inject(SYNC); sock.drain();
    order.length = 0;   // 只看「状态事件」这条链路的先后，排除 sync 带来的重绘
    sock.inject(M.evtMsg({ seq: 2, evt: { t: 'state',
      p: { seq: 3, seat: 's1', charId: 'c-1', status: { currentHP: 7 } } } }));
    ok(side.lastSheetApply && side.lastSheetApply.ok === true && side.lastSheetApply.via === 'tempCard',
       '★ 命中临时卡 → lastSheetApply = {ok:true, via:tempCard}', side.lastSheetApply);
    eq(diags.length, 0, '★ 写回成功**不**触发失败诊断回调');
    ok(order.indexOf('tempWrite') >= 0 && order.indexOf('tempWrite') < order.indexOf('repaint'),
       '★ 先写回临时卡、后重绘（界面不再滞后一帧）', order);
    side.destroy();

    /* (2) charId 在本机找不到 → 明确失败（不静默），且触发诊断回调；不误写别的卡 */
    global.RoomStore = undefined;
    global.Store = { getState: function () { return { characters: { c9: { id: 'c9', status: {} } }, current: { id: 'c9', status: {} } }; },
                     saveNow: function () {} };
    const client2 = new M.Client({ seat: 's1', role: 'player' });
    const diags2 = [];
    const side2 = new N.PlayerSide({
      client: client2, room: { code: 'ab12cd', wsUrl: 'ws://x/ws?code=ab12cd&t=t1', mtoken: 't1' },
      onEvent: function () {},
      onSheetApply: function (d) { diags2.push(d); }
    });
    side2.open();
    const sock2 = FakeWS.last;
    sock2.fireOpen(); sock2.drain();
    sock2.inject(SYNC); sock2.drain();
    sock2.inject(M.evtMsg({ seq: 2, evt: { t: 'state',
      p: { seq: 3, seat: 's1', charId: 'missing', status: { currentHP: 7 } } } }));
    ok(side2.lastSheetApply && side2.lastSheetApply.ok === false &&
       side2.lastSheetApply.reason === 'card_not_found',
       '★ charId 找不到 → lastSheetApply.ok=false（不再静默吞掉）', side2.lastSheetApply);
    eq(diags2.length, 1, '★ 写回失败时触发 onSheetApply 诊断（界面可提示玩家）');
    eq(global.Store.getState().characters.c9.status.currentHP, undefined,
       '★ 且绝不误写到 current / 别人的卡上');
    side2.destroy();
  } finally {
    global.Store = savedStore;
    global.RoomStore = savedRS;
  }
});

/* ============================================================
 * 汇总（HTTP 部分是异步的，先跑完再统一输出）
 * ============================================================ */
function finish() {
  console.log('\n' + '='.repeat(60));
  if (fail) {
    console.log('失败 ' + fail + ' 项：');
    failures.forEach(f => console.log('  ✗ ' + f));
    console.log('RESULT: FAIL');
    process.exit(1);
  }
  console.log('全部通过：' + pass + ' 项断言');
  console.log('RESULT: PASS');
}

(function runHttp(i) {
  if (i >= httpTests.length) return finish();
  Promise.resolve()
    .then(httpTests[i])
    .then(() => runHttp(i + 1))
    .catch(e => {
      fail++;
      failures.push('HTTP 用例 ' + i + ' 抛出异常：' + (e && e.stack || e));
      runHttp(i + 1);
    });
})(0);
