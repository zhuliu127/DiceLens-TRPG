# -*- coding: utf-8 -*-
"""
deploy_room_server.py —— 把「跑团房间 · 公网房间服务」部署到服务器。

一条命令完成：
    1. 上传 tools/room_server.py
    2. 建 /opt/coc-room、写 rooms.db 目录、装 systemd 单元
    3. 开 nginx 的 /room/ 反代（含 WebSocket 升级头）
    4. 重载 nginx、启动/重启服务、跑健康检查

为什么单独写一个（不复用 deploy_to_server.py）
--------------------------------------------
那个脚本推的是**网页版静态站**；这个是**常驻服务**，且比 /coc 多两件事：
  · 需要 WebSocket 升级（Upgrade/Connection 头），否则 WS 握手 426
  · 请求体上限要大（场景图上传），不能照抄 /coc 的 1m
  · 不能开任何缓存，且读超时要长（WS 是长连接）

⚠️ 与 coc-share 的关键区别：本服务**绝不能被丢进容器**，
   它需要长时间保持大量并发长连接（2C/2G 机器上要留意 ulimit）。

用法
----
    python tools/deploy_room_server.py --key "D:/服务器/SSH.pem"
    python tools/deploy_room_server.py --key ... --dry-run     # 只本地校验语法
"""
import argparse
import base64
import hashlib
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
SERVER_PY = os.path.join(HERE, "room_server.py")

DEFAULT_HOST = "127.0.0.1"
DEFAULT_USER = "ubuntu"
DEFAULT_DIR = "/opt/coc-room"
DEFAULT_PORT = 12710
DEFAULT_PUBLIC_BASE = "https://your-domain.example.com/room"
NGINX_SITE = "/etc/nginx/sites-available/coc"

UNIT = """[Unit]
Description=COC7th 调查员车卡器 - 跑团房间服务
Documentation={public_base}/
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User={user}
Group={user}
WorkingDirectory={dir}
Environment=ROOM_HOST=127.0.0.1
Environment=ROOM_PORT={port}
Environment=ROOM_DB={dir}/rooms.db
Environment=ROOM_PUBLIC_BASE={public_base}
Environment=PYTHONUNBUFFERED=1
ExecStart=/usr/bin/python3 {dir}/room_server.py
Restart=always
RestartSec=3

# 轻度加固：只允许写自己的目录
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths={dir}

[Install]
WantedBy=multi-user.target
"""

# nginx 片段：/room/ → 127.0.0.1:12710（含 WS 升级）
# 位置必须与站内其它 location 同级，由插入脚本负责插在 `location / {` 之前。
NGINX_BLOCK = """
    # ================= 调查员车卡器 · 跑团房间 =================
    # 后端：/opt/coc-room/room_server.py（systemd: coc-room，监听 127.0.0.1:{port}）
    # 服务自身不认 /room 前缀，先 rewrite 削掉再转发。
    # ⚠️ 与 /coc 的三点不同（照抄会坏）：
    #   1) 必须转发 Upgrade/Connection，否则 WebSocket 握手失败（表现为「一直重连中」）
    #   2) 请求体上限调大（场景图上传），/coc 的 1m 不够
    #   3) proxy_read_timeout 必须很长 —— WS 是长连接，默认 60s 会把空闲连接掐断
    location ^~ /room/ {{
        rewrite ^/room/(.*)$ /$1 break;
        proxy_pass http://127.0.0.1:{port};
        proxy_http_version 1.1;
        # ---- WebSocket 升级（关键） ----
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header CF-Connecting-IP $http_cf_connecting_ip;
        # ---- 长连接与上传 ----
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        # v2.1.3：8m → 64m。服务端存档 payload 上限已提到 16MB，
        # nginx 必须显著高于它（JSON 包裹 + 转义开销），否则合法存档会被 nginx 先拒。
        client_max_body_size 64m;
        # 一律不缓存（动态 + 实时）
        proxy_no_cache 1;
        proxy_cache_bypass 1;
    }}
    location = /room {{
        return 301 /room/;
    }}
    # ================= 调查员车卡器 · 跑团房间结束 =================
"""

# 全局 http 块里需要有 $connection_upgrade 变量（nginx 1.24 没有内置）
MAP_SNIPPET = """# 由 deploy_room_server.py 添加：WebSocket 升级用的 Connection 变量
# 有 Upgrade 头就用 upgrade，否则保持 close —— 这是官方推荐写法
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
"""

MAP_FILE = "/etc/nginx/conf.d/ws_upgrade.conf"


def md5_of(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def null_hosts_file():
    return "NUL" if os.name == "nt" else "/dev/null"


def ssh(host, user, key, command, stdin_bytes=None, quiet=True):
    args = ["ssh", "-i", key,
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=" + null_hosts_file(),
            "-o", "ConnectTimeout=20",
            "%s@%s" % (user, host), command]
    if quiet:
        args.insert(1, "-q")
    p = subprocess.run(args, input=stdin_bytes,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    return p.returncode, p.stdout.decode("utf-8", "replace")


def upload(host, user, key, local, remote):
    """base64 管道上传 + MD5 校验（与 deploy_to_server.py 同一套路）。"""
    local_md5 = md5_of(local)
    size = os.path.getsize(local)
    with open(local, "rb") as f:
        b64 = base64.b64encode(f.read())
    cmd = ("cat > /tmp/_up.b64; tr -d '\\r\\n' < /tmp/_up.b64 | base64 -d > {r}; "
           "md5sum {r}; wc -c < {r}; rm -f /tmp/_up.b64").format(r=remote)
    rc, out = ssh(host, user, key, cmd, stdin_bytes=b64)
    if rc != 0:
        raise RuntimeError("上传失败（ssh 退出码 %d）：\n%s" % (rc, out))
    got = out.split()[0].strip() if out.strip() else ""
    if got != local_md5:
        raise RuntimeError("上传后 MD5 不一致（远端 %s / 本地 %s）\n%s"
                           % (got, local_md5, out))
    print("  上传 OK  %s  %.1f KB  md5=%s" % (remote, size / 1024.0, got))
    return remote


def main():
    ap = argparse.ArgumentParser(description="部署跑团房间服务")
    ap.add_argument("--host", default=DEFAULT_HOST)
    ap.add_argument("--user", default=DEFAULT_USER)
    ap.add_argument("--key", required=False)
    ap.add_argument("--dir", default=DEFAULT_DIR)
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--public-base", default=DEFAULT_PUBLIC_BASE)
    ap.add_argument("--dry-run", action="store_true",
                    help="只在本地做语法检查，不连服务器")
    args = ap.parse_args()

    # ---------- 0. 本地语法自检 ----------
    print("== 0. 本地语法检查 ==")
    p = subprocess.run([sys.executable, "-m", "py_compile", SERVER_PY],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if p.returncode != 0:
        sys.exit("[!!] room_server.py 语法错误：\n" + p.stdout.decode("utf-8", "replace"))
    print("  room_server.py 语法 OK  %.1f KB" % (os.path.getsize(SERVER_PY) / 1024.0))

    if args.dry_run:
        print("\n[dry-run] 不连服务器。将部署到 %s:%d，公开地址 %s"
              % (args.host, args.port, args.public_base))
        return
    if not args.key:
        sys.exit("[!!] 需要 --key <私钥路径>")

    unit = UNIT.format(user=args.user, dir=args.dir, port=args.port,
                       public_base=args.public_base)
    nginx_block = NGINX_BLOCK.format(port=args.port)

    # ---------- 1. 上传服务 ----------
    print("\n== 1. 上传 room_server.py ==")
    upload(args.host, args.user, args.key, SERVER_PY, "/tmp/room_server.py")
    upload(args.host, args.user, args.key,
           _tmp(unit, "coc-room.service"), "/tmp/coc-room.service")
    upload(args.host, args.user, args.key,
           _tmp(nginx_block, "room_nginx.block"), "/tmp/room_nginx.block")
    upload(args.host, args.user, args.key,
           _tmp(MAP_SNIPPET, "ws_upgrade.conf"), "/tmp/ws_upgrade.conf")

    # ---------- 2. 装服务 ----------
    print("\n== 2. 安装服务到 %s ==" % args.dir)
    cmd = ("set -e; "
           "sudo -n mkdir -p {d}; "
           "sudo -n chown {u}:{u} {d}; "
           "sudo -n cp /tmp/room_server.py {d}/room_server.py; "
           "sudo -n chown {u}:{u} {d}/room_server.py; "
           "sudo -n chmod 644 {d}/room_server.py; "
           "sudo -n cp /tmp/coc-room.service /etc/systemd/system/coc-room.service; "
           "sudo -n chmod 644 /etc/systemd/system/coc-room.service; "
           "sudo -n systemctl daemon-reload; "
           "echo OK_DIR=${{d}}").format(d=args.dir, u=args.user)
    rc, out = ssh(args.host, args.user, args.key, cmd)
    print("  " + out.strip().replace("\n", "\n  "))
    if rc != 0:
        sys.exit("[!!] 安装服务失败。")

    # ---------- 3. 装 nginx：map + /room/ 反代 ----------
    print("\n== 3. 配置 nginx /room/ 反代 ==")
    # 3a. map 变量（幂等：已存在就不重复写）
    cmd = ("set -e; "
           "if grep -q connection_upgrade /etc/nginx/nginx.conf 2>/dev/null; then "
           "  echo 'MAP_IN_NGINXCONF'; "
           "elif [ -f {mf} ] && grep -q connection_upgrade {mf}; then "
           "  echo 'MAP_ALREADY'; "
           "else "
           "  sudo -n cp /tmp/ws_upgrade.conf {mf}; "
           "  sudo -n chmod 644 {mf}; "
           "  echo 'MAP_WRITTEN'; "
           "fi").format(mf=MAP_FILE)
    rc, out = ssh(args.host, args.user, args.key, cmd)
    print("  map: " + out.strip())
    if rc != 0:
        sys.exit("[!!] 写 map 失败。")

    # 3b. 插入 location 块（幂等：先删旧块再插，保证可重复部署）
    print("  插入 location /room/ …")
    rc, out = ssh(args.host, args.user, args.key, _nginx_patch_cmd(args.port))
    print("  " + out.strip().replace("\n", "\n  "))
    if rc != 0:
        sys.exit("[!!] nginx 配置插入失败（已自动回滚备份）。")

    # 3c. 语法检查 + reload
    print("\n== 4. nginx -t & reload ==")
    cmd = ("set -e; "
           "sudo -n nginx -t 2>&1; "
           "sudo -n systemctl reload nginx; "
           "echo RELOADED")
    rc, out = ssh(args.host, args.user, args.key, cmd)
    print("  " + out.strip().replace("\n", "\n  "))
    if rc != 0:
        # nginx -t 失败必须回滚，否则线上全站 502
        print("\n  [!!] nginx -t 失败，回滚配置 …")
        ssh(args.host, args.user, args.key,
            "sudo -n cp {s}.bak-room {s}; sudo -n systemctl reload nginx; echo ROLLED_BACK"
            .format(s=NGINX_SITE))
        sys.exit("[!!] 已回滚，请查看上面的 nginx -t 报错。")

    # ---------- 5. 起服务 ----------
    print("\n== 5. 启动 coc-room ==")
    cmd = ("set -e; "
           "sudo -n systemctl enable coc-room >/dev/null 2>&1; "
           "sudo -n systemctl restart coc-room; "
           "sleep 3; "
           "systemctl is-active coc-room; "
           "echo '--- health ---'; "
           "curl -s http://127.0.0.1:{p}/health; echo; "
           "echo '--- log ---'; "
           "sudo -n journalctl -u coc-room -n 8 --no-pager").format(p=args.port)
    rc, out = ssh(args.host, args.user, args.key, cmd)
    print("  " + out.strip().replace("\n", "\n  "))
    if rc != 0:
        sys.exit("[!!] 服务启动失败，看上面日志。")

    print("\n完成。验证：")
    print("  python tools/test_room_deploy.py")
    print("  或浏览器打开 %s/health" % args.public_base)


def _tmp(text, name):
    """把文本写到本地临时文件，供 upload 使用。"""
    d = os.path.join(ROOT, "dist")
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, "_room_" + name)
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return p


def _nginx_patch_cmd(port):
    """
    幂等插入：删掉本脚本上次写的块 → 备份 → 在 `location / {` 前插入新块 → 校验。
    用 python 在远端做文本操作，避免 sed 多行替换的转义地狱。
    """
    patch = r'''
import re, shutil, sys
SITE = "%(site)s"
txt = open(SITE, encoding="utf-8").read()
blk = open("/tmp/room_nginx.block", encoding="utf-8").read()

# 1) 删掉旧块（上次部署留下的）
txt = re.sub(r"\n?    # =+ 调查员车卡器 · 跑团房间 =+\n.*?"
             r"    # =+ 调查员车卡器 · 跑团房间结束 =+\n",
             "\n", txt, flags=re.S)

# 2) 备份
shutil.copy2(SITE, SITE + ".bak-room")

# 3) 插到 `location / {` 之前（同一 server 块内）
m = re.search(r"^    location / \{", txt, flags=re.M)
if not m:
    sys.exit("找不到 `location / {` 锚点")
txt = txt[:m.start()] + blk.lstrip("\n") + "\n" + txt[m.start():]

open(SITE, "w", encoding="utf-8").write(txt)
print("PATCHED lines=%%d" %% txt.count("\n"))
''' % {"site": NGINX_SITE}

    inner = patch.replace("'", "'\\''")
    return "sudo -n python3 -c '%s' && echo NGINX_PATCH_OK" % inner


if __name__ == "__main__":
    main()
