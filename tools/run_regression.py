# -*- coding: utf-8 -*-
"""
run_regression.py —— 一条命令跑完全量回归。

为什么要有一个 Python 版：
    `_run_regression.ps1` 依赖 `Start-Job` 起静态服务，而 Start-Job 在工作机
    的沙箱里会被拦掉；PowerShell 脚本文件也常常不允许直接执行。
    Python 版用 subprocess 起 `http.server`，跨环境稳定，且**全程只在自己
    的进程里**收尾（finally 里 kill），不会像 Start-Process 那样随会话被回收，
    也不会出现「第一次跑超时 → 重启后好 → 又掉」的老问题。

用法：
    python tools/run_regression.py            # 全量
    python tools/run_regression.py v14 audit_point_spend
                                              # 只跑名字里含这些关键字的项

输出：
    末尾打印一张「通过 / 失败」表，并给出 RESULT: PASS|FAIL。
    完整日志写在 tools/_reg_last.log。
"""
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.join(ROOT, "tools")
WEB = os.path.join(ROOT, "web")
PORT = 8899
BASE = "http://127.0.0.1:%d/index.html" % PORT
LOG = os.path.join(TOOLS, "_reg_last.log")

PY = os.environ.get("COC_PY") or sys.executable
NODE = os.environ.get("COC_NODE") or "node"

PY_TESTS = ["test_edition"] + ["test_v%d" % n for n in range(2, 17)] + \
           ["test_room_ui", "test_room_reconnect", "test_nsc"]

# 纯 Node 的单元测试（不依赖浏览器、不起静态服务）。
# 与 audit_*.js 分开：audit_* 是「数据一致性审计」，这些是「功能单元测试」，
# 所以不能靠 audit_ 前缀自动收录，必须在这里显式登记。
JS_TESTS = ["test_room_rules", "test_room_model", "test_room_net", "test_room_lan",
            "test_status_madness"]

log_lines = []


def log(s):
    log_lines.append(s)
    print(s, flush=True)


def find_audits():
    names = []
    for fn in sorted(os.listdir(TOOLS)):
        if fn.startswith("audit_") and fn.endswith(".js"):
            names.append(fn[:-3])
    return names


def find_opt_in():
    """需要显式点名才跑的外网测试。

    test_room_deploy.py 打的是**公网域名**（https://your-domain.example.com/room），
    依赖「服务器活着 + CF 回源正常 + 家里的网通」。把它放进默认全量，
    只会让本地回归在断网/服务器重启时无谓地变红 —— 所以默认跳过，
    要跑必须显式点名：python tools/run_regression.py room_deploy
    """
    return ["test_room_deploy"]


def run(cmd):
    t0 = time.time()
    p = subprocess.run(cmd, cwd=ROOT, capture_output=True)
    dt = time.time() - t0
    out = (p.stdout or b"").decode("utf-8", "replace")
    err = (p.stderr or b"").decode("utf-8", "replace")
    return p.returncode, out, err, dt


def start_server():
    """起静态服务。⚠️ 端口可能被系统/残留进程拒绝（WinError 10013，
    本机实测出现过：8899 突然 bind 不上，netstat 里却没有任何监听者）——
    所以按 8899 → 8901 → 8902 依次回退，并把实际端口写回全局 BASE，
    测试里所有绝对地址都引用 BASE，不用改。"""
    import urllib.request
    global PORT, BASE
    py = PY
    last_err = None
    for port in (PORT, 8901, 8902, 8903):
        p = subprocess.Popen(
            [py, "-m", "http.server", str(port), "--bind", "127.0.0.1"],
            cwd=WEB, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        base = "http://127.0.0.1:%d/index.html" % port
        for _ in range(40):
            try:
                urllib.request.urlopen(base, timeout=2).read(1)
                if port != PORT:
                    print("[reg] 端口 %d 不可用，回退到 %d" % (PORT, port), flush=True)
                    PORT = port
                    BASE = base
                return p
            except Exception as e:
                last_err = e
                time.sleep(0.25)
        p.kill()
    raise RuntimeError("静态服务没起来（8899/8901/8902/8903 全失败）：%s" % last_err)


def pick(all_names, filters):
    if not filters:
        return all_names
    hit = [n for n in all_names if any(f in n for f in filters)]
    return hit


def main():
    filters = [a for a in sys.argv[1:] if not a.startswith("-")]
    py_names = pick(PY_TESTS, filters)
    aud_names = pick(find_audits(), filters)
    js_names = pick(JS_TESTS, filters)
    net_names = pick(find_opt_in(), filters)

    srv = start_server()
    log("静态服务已就绪 %s" % BASE)
    # 端口回退后必须告诉子进程实际端口（test_room_ui 自己起服务时用同一端口）
    os.environ["COC_STATIC_PORT"] = str(PORT)
    rows = []
    try:
        for name in py_names:
            path = os.path.join(TOOLS, name + ".py")
            if not os.path.exists(path):
                rows.append((name, "SKIP", 0.0, "文件不存在"))
                continue
            rc, out, err, dt = run([PY, path])
            log("\n===== %s (%.1fs) =====" % (name, dt))
            log(out.rstrip())
            if err.strip():
                log("[stderr] " + err.rstrip())
            ok = (rc == 0) and ("[!!]" not in out) and ("Traceback" not in out)
            rows.append((name, "PASS" if ok else "FAIL", dt, ""))
        for name in aud_names:
            path = os.path.join(TOOLS, name + ".js")
            rc, out, err, dt = run([NODE, path])
            log("\n===== %s (%.1fs) =====" % (name, dt))
            log(out.rstrip())
            if err.strip():
                log("[stderr] " + err.rstrip())
            text = out + err
            # Node 审计没有统一出口码，认这三种「合格」标记
            ok = (rc == 0) and ("RESULT: FAIL" not in text) and ("结论：FAIL" not in text) \
                and ("[FAIL]" not in text)
            rows.append((name, "PASS" if ok else "FAIL", dt, ""))
        for name in js_names:
            path = os.path.join(TOOLS, name + ".js")
            if not os.path.exists(path):
                rows.append((name, "SKIP", 0.0, "文件不存在"))
                continue
            rc, out, err, dt = run([NODE, path])
            log("\n===== %s (%.1fs) =====" % (name, dt))
            log(out.rstrip())
            if err.strip():
                log("[stderr] " + err.rstrip())
            text = out + err
            ok = (rc == 0) and ("RESULT: FAIL" not in text) and ("Traceback" not in text)
            rows.append((name, "PASS" if ok else "FAIL", dt, ""))
        # 外网项放最后：它最慢，也最可能受环境影响
        for name in net_names:
            path = os.path.join(TOOLS, name + ".py")
            if not os.path.exists(path):
                rows.append((name, "SKIP", 0.0, "文件不存在"))
                continue
            rc, out, err, dt = run([PY, path])
            log("\n===== %s (%.1fs) =====" % (name, dt))
            log(out.rstrip())
            if err.strip():
                log("[stderr] " + err.rstrip())
            text = out + err
            ok = (rc == 0) and ("RESULT: FAIL" not in text) and ("Traceback" not in text)
            rows.append((name, "PASS" if ok else "FAIL", dt, "(外网)"))
    finally:
        srv.kill()
        srv.wait()

    log("\n" + "=" * 52)
    log("%-28s %-6s %s" % ("项目", "结果", "耗时"))
    log("-" * 52)
    bad = 0
    for n, s, dt, note in rows:
        if s != "PASS":
            bad += 1
        log("%-28s %-6s %.1fs %s" % (n, s, dt, note))
    log("=" * 52)
    log("共 %d 项，失败 %d 项" % (len(rows), bad))
    log("RESULT: %s" % ("PASS" if bad == 0 else "FAIL"))

    with open(LOG, "w", encoding="utf-8") as f:
        f.write("\n".join(log_lines))
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
