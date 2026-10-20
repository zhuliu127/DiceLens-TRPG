# -*- coding: utf-8 -*-
"""
deploy_to_server.py —— 把「车卡器网页版」推到服务器并更新分享服务。

一条命令完成：
    1. 打包（复用 deploy_card_site.py，会预置 shareBase）
    2. 上传 tar.gz 到目标机
    3. 解压到站点目录 + 修权限
    4. 可选：同步 coc_share_server.py 并重启 coc-share

为什么不用 scp
--------------
本机（Windows / OpenSSH 10）上 scp 会直接报 `pipe: Unknown error`（exit 255），
`-O` 也救不回来。经实测可行的是：本地 base64 编码 → 管道喂给 ssh 的 stdin →
远端 `base64 -d` 落盘。大文件同样适用（1.1MB 的 base64 一次过），
用 MD5 双向核对，不会静默损坏。本脚本用的就是这条路。

用法
----
    python tools/deploy_to_server.py --key "D:/服务器/SSH.pem"

    # 顺带把分享服务也升到仓库里的版本
    python tools/deploy_to_server.py --key ... --sync-server

    # 只打包不上传，看会传什么
    python tools/deploy_to_server.py --dry-run
"""
import argparse
import base64
import hashlib
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
DIST_TGZ = os.path.join(ROOT, "dist", "card-site.tar.gz")
SERVER_PY = os.path.join(HERE, "coc_share_server.py")

DEFAULT_HOST = "127.0.0.1"
DEFAULT_USER = "ubuntu"
DEFAULT_SITE_DIR = "/var/www/coc/card"
DEFAULT_SHARE_DIR = "/opt/coc-share"
DEFAULT_PUBLIC_BASE = "https://your-domain.example.com/coc"


def md5_of(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def null_hosts_file():
    """Windows 用 NUL，类 Unix 用 /dev/null。"""
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
    """base64 管道上传 + MD5 校验。失败直接抛。"""
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
        raise RuntimeError("上传后 MD5 不一致（远端 %s / 本地 %s）\n%s" % (got, local_md5, out))
    print("  上传 OK  %s  %.1f KB  md5=%s" % (remote, size / 1024.0, got))
    return remote


def main():
    ap = argparse.ArgumentParser(description="部署车卡器网页版到服务器")
    ap.add_argument("--host", default=DEFAULT_HOST)
    ap.add_argument("--user", default=DEFAULT_USER)
    ap.add_argument("--key", required=False,
                    help="SSH 私钥路径（--dry-run 时可省）")
    ap.add_argument("--site-dir", default=DEFAULT_SITE_DIR)
    ap.add_argument("--share-dir", default=DEFAULT_SHARE_DIR)
    ap.add_argument("--public-base", default=DEFAULT_PUBLIC_BASE)
    ap.add_argument("--sync-server", action="store_true",
                    help="同时把 tools/coc_share_server.py 同步过去并重启 coc-share")
    ap.add_argument("--dry-run", action="store_true", help="只打包，不上传")
    args = ap.parse_args()

    # ---------- 1. 打包 ----------
    print("== 1. 打包 ==")
    py = sys.executable
    p = subprocess.run([py, os.path.join(HERE, "deploy_card_site.py"), args.public_base],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    print(p.stdout.decode("utf-8", "replace").strip())
    if p.returncode != 0 or not os.path.exists(DIST_TGZ):
        sys.exit("[!!] 打包失败，终止。")

    if args.dry_run:
        print("\n[dry-run] 已生成 %s，未上传。" % DIST_TGZ)
        return
    if not args.key:
        sys.exit("[!!] 需要 --key <私钥路径>")

    # ---------- 2. 上传 ----------
    print("\n== 2. 上传站点包 ==")
    upload(args.host, args.user, args.key, DIST_TGZ, "/tmp/card-site.tar.gz")

    # ---------- 3. 解压 + 权限 ----------
    print("\n== 3. 解压到 %s ==" % args.site_dir)
    cmd = ("set -e; "
           "sudo -n mkdir -p {d}; "
           "sudo -n find {d} -mindepth 1 -delete; "
           "sudo -n tar xzf /tmp/card-site.tar.gz -C {d}; "
           "sudo -n find {d} -type d -exec chmod 755 {{}} +; "
           "sudo -n find {d} -type f -exec chmod 644 {{}} +; "
           "sudo -n chown -R www-data:www-data {d}; "
           "echo FILES=$(find {d} -type f | wc -l); "
           "rm -f /tmp/card-site.tar.gz").format(d=args.site_dir)
    rc, out = ssh(args.host, args.user, args.key, cmd)
    print("  " + out.strip().replace("\n", "\n  "))
    if rc != 0:
        sys.exit("[!!] 解压失败。")

    # ---------- 4. 可选：同步分享服务 ----------
    if args.sync_server:
        print("\n== 4. 同步 coc_share_server.py ==")
        print("  本地 md5=%s  %.1f KB" % (md5_of(SERVER_PY), os.path.getsize(SERVER_PY) / 1024.0))
        upload(args.host, args.user, args.key, SERVER_PY, "/tmp/server_new.py")
        cmd = ("set -e; "
               "PYTHONPYCACHEPREFIX=/home/{u}/.pyc python3 -m py_compile /tmp/server_new.py; "
               "sudo -n cp -a {d}/server.py {d}/server.py.bak-last; "
               "sudo -n cp /tmp/server_new.py {d}/server.py; "
               "sudo -n chown {u}:{u} {d}/server.py; "
               "sudo -n systemctl restart coc-share; "
               "sleep 3; "
               "systemctl is-active coc-share; "
               "curl -s http://127.0.0.1:12700/health; echo; "
               "rm -f /tmp/server_new.py").format(u=args.user, d=args.share_dir)
        rc, out = ssh(args.host, args.user, args.key, cmd)
        print("  " + out.strip().replace("\n", "\n  "))
        if rc != 0:
            sys.exit("[!!] 分享服务同步失败，请到机器上看 journalctl -u coc-share")

    # ---------- 5. 提示 ----------
    domain = args.public_base.rsplit("/coc", 1)[0]
    print("\n完成。验证：")
    print("  python tools/test_web_deploy.py")
    print("  或直接浏览器打开 %s/card/" % domain)


if __name__ == "__main__":
    main()
