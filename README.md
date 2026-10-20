# 骰境 TRPG · COC 7th 调查员车卡 / 跑团

一个「从零车卡到实时开团」的克苏鲁的呼唤第七版（COC 7th）工具：

- **网页版**：纯静态站点（原生 JS，无构建步骤），浏览器直接跑。
- **Android App**：把同一套网页装进 WebView 的外壳，离线也能用。
- **跑团房间**：KP 开房、玩家用邀请链接进团，实时同步地图 / 战斗 / 检定 / 记录 / 手绘 / 笔记。
- **两个可选后端**：`coc-share`（角色卡分享）与 `coc-room`（公网房间中继），均为**纯 Python 标准库单文件、零依赖**，clone 下来即可部署。

> 本仓库为**开源版（oss）**：不预置任何人的服务器地址、不预置任何 API Key。所有服务地址与模型 Key 都由使用者自行填写或在打包时注入。

---

## 目录

- [功能特性](#功能特性)
- [项目结构](#项目结构)
- [环境要求](#环境要求)
- [一、本地运行网页版](#一本地运行网页版)
- [二、部署「分享服务器」（coc-share）](#二部署分享服务器coc-share)
- [三、部署「跑团服务器」（coc-room）](#三部署跑团服务器coc-room)
- [四、局域网一体服（网页 + 中继同源）](#四局域网一体服网页--中继同源)
- [五、构建 Android App](#五构建-android-app)
- [六、配置项说明](#六配置项说明)
- [七、AI 车卡与你的 API Key](#七ai-车卡与你的-api-key)
- [八、隐私与安全](#八隐私与安全)
- [九、常见问题](#九常见问题)
- [十、许可证](#十许可证)

---

## 功能特性

**车卡（三种方式）**

- 🎲 **随机车卡**：一次生成 5 张完整预设卡（属性 / 技能 / 装备 / 背景全填好），挑一张就能开跑；角色来自古今中外不同地区年代，姓名/籍贯/职业/装备互相匹配。
- ✨ **AI 车卡**：一句话描述（时代、职业、性格都行），由大模型写人物与故事；**规则数值仍由本地引擎计算**，所以卡是合规的。
- ✏️ **按流程车卡**：完整向导 9 步——基本资料 → 属性 → 职业 → 资产 → 技能 → 战斗 → 装备 → 背景 → 完成。
- 属性支持 **随机掷骰 / 手动购点 / 天命 N 选一 / 预设方案**；年龄调整、教育进步、派生属性（HP/MP/SAN/MOV/BUILD/DB）、职业点与技能上限全部自动计算。

**跑团房间**

- KP 一键开房，复制邀请链接/加入信息发群里即可。
- 地图与素材、标记/画笔/橡皮擦、放置单位与玩家、场景检定编辑器（多步骤/分支）。
- 掷骰 / 技能检定 / SAN Check / 战斗对抗与伤害结算 / 自定义骰子 / 暗骰 / 临时状态。
- 玩家视角：我的角色卡、实时状态（HP/MP/SAN、身体/精神状态、疯狂症状与剩余轮数）、队友信息、骰盘。
- 断线重连（设备身份复用座位）、回退、存档槽；局域网与公网**同一套协议**。

**其他**

- 角色卡导出长图 / JSON 存档；只读分享链接；撕卡归档「英灵殿」。
- 角色卡默认**只存本机**，不上传、不注册。

---

## 项目结构

```
web/                    网页版（就是 App 里加载的那套页面）
  index.html
  css/  img/
  js/
    app.js              应用外壳 / 路由 / 关于页等
    core/               核心逻辑（无 DOM 依赖，Node 可直接测）
      room-model.js     跑团房间权威模型（状态机 / 事件 / 可见性裁剪）
      room-rules.js     COC 7 规则服务
      madness.js        疯狂症状表
      store.js          本地存储
      build-config.js   ★ 版本/服务地址/AI 默认配置（打包时按 edition 覆盖）
      ...
    ui/                 界面层（轻量虚 DOM）
      room-ui.js  room-panels.js  steps-*.js  components.js  ...
android/                Android WebView 外壳（Gradle）
  app/build.gradle      ★ 版本号、applicationId、打包配置
  app/src/main/...
tools/                  工具与后端（纯 Python 标准库）
  room_server.py        ★ 跑团房间公网中继（coc-room）
  coc_share_server.py   ★ 角色卡分享服务（coc-share）
  deploy_card_site.py   打包「网页版静态站」为 tar.gz
  deploy_room_server.py 一键部署 coc-room（可选，默认值为占位，请按需传参）
  deploy_to_server.py   一键部署网页 + coc-share（可选）
  test_*.py / *_test.js 测试与探针
edition/                ★ 私有打包配置（.gitignore 已排除，开源版无此目录）
  self/build-config.js  自用版预置的服务地址（不发布）
dist/                   构建产物（.gitignore 已排除）
```

> 带 ★ 的是「换服务地址 / 版本号」时要关注的文件。

---

## 环境要求

| 用途 | 要求 |
|------|------|
| 跑网页版 / 本地开发 | 任意静态服务器（`python -m http.server` 即可） |
| 跑后端（coc-share / coc-room） | Python **3.8+**，**无需 pip 安装任何依赖**（仅标准库） |
| 构建 Android App | JDK **17**、Android SDK（compileSdk 34）、Gradle **8.7** |

---

## 一、本地运行网页版

网页版是纯静态文件，不需要构建：

```bash
cd web
python -m http.server 8080
# 浏览器打开 http://localhost:8080/
```

此时可以正常车卡、管理角色卡。**跑团房间**需要另外提供一个「中继服务」（见第二/三/四节），
并在页面里填写中继地址（设置 → 房间服务地址），或使用局域网一体服同源模式。

---

## 二、部署「分享服务器」（coc-share）

`coc-share` 负责「角色卡只读分享」：玩家把卡上传，得到一个 `https://你的域名/s/xxxx` 链接给别人看。

- 单文件、纯标准库；SQLite 存储；JSON 经 zlib+base64 压缩。
- 内置四道防护（单 IP 限流 / 全站限流 / 总量与体积熔断 / 超期清理）——公开匿名写入接口必须有这些。

### 2.1 直接运行

```bash
# 上传 tools/coc_share_server.py 到服务器，例如 /opt/coc-share/
export COC_SHARE_HOST=127.0.0.1
export COC_SHARE_PORT=12700
export COC_SHARE_DB=/opt/coc-share/cards.db
export COC_SHARE_PUBLIC_BASE=https://your-domain.com/coc   # 用来拼分享链接，必须设置
python3 /opt/coc-share/coc_share_server.py
```

### 2.2 systemd（推荐）

`/etc/systemd/system/coc-share.service`：

```ini
[Unit]
Description=coc-share 角色卡分享服务
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/coc-share
Environment=COC_SHARE_HOST=127.0.0.1
Environment=COC_SHARE_PORT=12700
Environment=COC_SHARE_DB=/opt/coc-share/cards.db
Environment=COC_SHARE_PUBLIC_BASE=https://your-domain.com/coc
ExecStart=/usr/bin/python3 /opt/coc-share/coc_share_server.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now coc-share
curl http://127.0.0.1:12700/health
```

### 2.3 nginx 反代（剥掉 /coc 前缀）

```nginx
location /coc/ {
    proxy_pass http://127.0.0.1:12700/;   # 结尾的 / 会把 /coc 前缀剥掉
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    client_max_body_size 1m;
}
```

接口：`POST /api/cards` 创建、`GET /api/cards/<id>` 读取 JSON、`GET /s/<id>` 只读页面、`POST /api/cards/<id>/del` 删除。

### 2.4 让网页用上它

打包网页时把 `shareBase` 指过去：

```bash
python tools/deploy_card_site.py https://your-domain.com/coc
# 产物：dist/card-site.tar.gz，解压到站点根即可
```

---

## 三、部署「跑团服务器」（coc-room）

`coc-room` 只做 **房间登记 + 鉴权 + 字节转发**，**不持有游戏状态**（状态与可见性裁剪都在 KP 端）。
局域网与公网协议一致，只是「权威端」不同。

### 3.1 直接运行

```bash
export ROOM_HOST=127.0.0.1
export ROOM_PORT=12710
export ROOM_DB=/opt/coc-room/rooms.db
export ROOM_PUBLIC_BASE=https://your-domain.com/room   # 对外基址（拼 ws 地址用）
python3 /opt/coc-room/room_server.py
curl http://127.0.0.1:12710/health
```

### 3.2 systemd

`/etc/systemd/system/coc-room.service`：

```ini
[Unit]
Description=coc-room 跑团房间中继
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/coc-room
Environment=ROOM_HOST=127.0.0.1
Environment=ROOM_PORT=12710
Environment=ROOM_DB=/opt/coc-room/rooms.db
Environment=ROOM_PUBLIC_BASE=https://your-domain.com/room
ExecStart=/usr/bin/python3 /opt/coc-room/room_server.py
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/opt/coc-room

[Install]
WantedBy=multi-user.target
```

### 3.3 nginx 反代（**必须**带 WebSocket 升级头）

```nginx
location /room/ {
    proxy_pass http://127.0.0.1:12710/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 3600s;      # WebSocket 是长连接
    client_max_body_size 8m;       # 场景图上传
}
```

> ⚠️ 少了 `Upgrade/Connection` 两个头，WS 握手会 426；`proxy_read_timeout` 太短会在开团中途被掐断。
> ⚠️ 本服务是**长期并发长连接**，不要丢进容器随便限时；2C/2G 机器注意 `ulimit -n`。

### 3.4 让网页/App 用上它

- 网页打包：`roomBase` 指到 `https://your-domain.com/room`。
- App：在「设置 → 房间服务地址」里填，或打包时在 `build-config.js` / `edition/self/build-config.js` 里预置。

---

## 四、局域网一体服（网页 + 中继同源）

不想配域名/公网时，可在同一台机器上同时提供**静态网页**和**房间中继**（同源，无跨域/混合内容问题）：

```bash
# 1) 把网页版放到一个目录（或解压 card-site-lan.tar.gz）
mkdir -p ~/coc-lan
tar xzf card-site-lan.tar.gz -C ~/coc-lan      # 或直接把 web/ 拷进去

# 2) 启动（ROOM_STATIC_DIR 让中继同时托管静态站）
ROOM_STATIC_DIR=~/coc-lan \
ROOM_PORT=8080 \
ROOM_DB=~/coc-lan/rooms.db \
ROOM_PUBLIC_BASE=http://<本机局域网IP>:8080 \
python3 tools/room_server.py
```

朋友打开 `http://<本机局域网IP>:8080/` 即玩。对应打包模式：

```bash
python tools/deploy_card_site.py --lan
# 产物 dist/card-site-lan.tar.gz，页面的 sameOriginRoom=true（用当前源当中继）
```

---

## 五、构建 Android App

### 5.1 准备

1. JDK 17、Android SDK（`compileSdk 34`）。
2. 在 `android/local.properties` 配置 SDK 路径与签名（**该文件不入库**）：

```properties
sdk.dir=/path/to/Android/Sdk
storeFile=app/keystore/your.jks
storePassword=******
keyAlias=******
keyPassword=******
```

没配签名也能构建（会回退 debug 签名），方便先跑起来。

### 5.2 构建

```bash
cd android
# 开源版（applicationId 带 .oss 后缀，不预置任何服务地址）
./gradlew assembleRelease -Pedition=oss
# 自用版（applicationId 不带后缀；若存在 edition/self/build-config.js 会覆盖配置）
./gradlew assembleRelease -Pedition=self
```

产物：`android/app/build/outputs/apk/release/app-release.apk`

> `syncWeb` 任务会在构建前把 `web/` 复制进 `android/app/src/main/assets/`；
> 该目录是**生成的**，已在 `.gitignore` 中排除，克隆后首次构建会自动生成。
> `applyEdition` 会在自用版构建时用 `edition/self/build-config.js` 覆盖配置。

---

## 六、配置项说明

`web/js/core/build-config.js`（开源版默认值）：

| 字段 | 说明 |
|------|------|
| `edition` | `'oss'` / `'self'` |
| `shareBase` | 云分享后端基址。空 = 未预置，由用户自填 |
| `roomBase` | 跑团房间中继基址（公网）。空 = 未预置，由用户自填；可填多个逗号分隔按序回退 |
| `allowCustomShareBase` / `allowCustomRoomBase` | 是否允许用户在设置里改地址 |
| `gateCode` | 访问暗号。空 = 不启用 |
| `sameOriginRoom` | `true` = 未配置房间地址时用「当前网页源」当中继（局域网一体服） |
| `displayName` | 界面应用名 |
| `authorName` / `authorEmail` / `authorBili` / `authorSite` | 「关于」页作者信息；开源版默认只显示作者名，其余留空不显示 |
| `versionName` | 版本号（与 `android/app/build.gradle` 的 `versionName` 保持一致） |

---

## 七、AI 车卡与你的 API Key

- AI 车卡走 **OpenAI 兼容**接口。默认 `aiBase=https://api.deepseek.com/v1`、`aiModel=deepseek-flash`，可在「AI 设置」里改成任意兼容服务。
- **API Key 只保存在使用者本机的 localStorage**，请求由浏览器/WebView 直接发给你填写的接口，不经过本项目任何服务器。
- **本仓库不包含任何 API Key**；请勿把 Key 写进 `build-config.js` 或源码后提交。

---

## 八、隐私与安全

- 角色卡默认**只存本机**（localStorage），不上传、不注册。
- 仅当你主动使用「云分享」「跑团房间」「AI 车卡」时，相关数据才会发送到**你自己填写的**服务地址。
- 开源版 APK 已确认**不包含**任何私有服务器地址、暗号或 API Key。
- 公开部署 `coc-share` 时，它是一个「匿名可写」接口，务必保留内置限流/熔断，并建议加 WAF 或反向代理层的频率限制。

---

## 九、常见问题

**Q：网页能车卡，但开房连不上？**
A：房间功能需要中继服务。检查 `roomBase` 是否正确、对方是否可达、nginx 是否带了 WebSocket 升级头。

**Q：AI 车卡报错 / 400？**
A：确认「AI 设置」里的接口地址、模型名、Key 正确；模型名必须是该服务真实存在的名字。Key 错误或额度不足都会 400/401。

**Q：手机和电脑能一起跑团吗？**
A：能。局域网下手机开热点或同一 Wi-Fi，用「局域网一体服」；公网则部署 `coc-room` 并填 `roomBase`。

**Q：开源版和自用版有什么区别？**
A：仅 `applicationId`（前者带 `.oss`）与是否预置服务地址不同，可同时安装在一台设备上。

---

## 十、许可证

MIT License，详见 [LICENSE](./LICENSE)。

> 若你 fork 后要公开发布自己的构建，请把 `build-config.js` 里的服务地址/作者信息改成你自己的，并确保不要把 `edition/`、`local.properties`、签名文件或任何 API Key 提交进仓库。
