#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把本机当前的内网 IPv4 地址发布到 public/data/lan-hosts.json，并提交推送。

用途：人在外面通过手机 / 另一台电脑打开课表页面时，能随时看到这台部署机
最新的局域网地址（用来连本机起的本地服务）。页面只在带 ?debug=1 时才读这个
文件，正常访客看不到。

为什么必须提交进仓库：GitHub Pages 的每小时任务是用 main 里的 public/ 整目录
覆盖 gh-pages 的，直接往 gh-pages 写会被下一次任务抹掉。

安全取舍：文件在公开仓库里是明文（172.20.x.x 属于内网地址，公网本就访问不到），
页面本身不展示，只有在网址上带 ?debug=1 的人才会看到。

运行环境：Windows + Python 3（本机已有），由计划任务每 5 分钟调用一次：
    python scripts/publish_lan_ip.py

行为约定：
  - 地址没变化 → 不写文件、不提交（避免每 5 分钟刷一次提交）
  - 一个地址都没取到 → 只记日志，绝不把线上文件清空
  - 工作区有别的未提交改动、或本地分支落后于 origin/main → 跳过本次，下轮再试
  - 任何异常都写进日志文件，方便排查（计划任务不带控制台）
"""

import datetime
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]          # 仓库根目录（scripts/ 的上一级）
TARGET = REPO / "public" / "data" / "lan-hosts.json"  # 发布目标（被 .gitignore 忽略，需 -f 强制加入）
LOG_DIR = Path(os.environ.get("LOCALAPPDATA") or tempfile.gettempdir()) / "KJdata"
LOG_FILE = LOG_DIR / "lan-ip.log"

# 只认这个网段：学校里给的内网地址就是 172.20.x.x（换网段时改这里）
PREFIX = "172.20."
# 虚拟网卡（Hyper-V / VirtualBox / VMware）也会拿到 172.x 地址，对远程访问没有意义，排除
SKIP_ALIAS = ("vethernet", "virtualbox", "vmware", "hyper-v", "loopback", "default switch")


def log(msg):
    """带时间戳追加到日志文件；同时打到控制台（手动运行时能直接看到）。"""
    line = f"[{datetime.datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    print(line)
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        if LOG_FILE.exists() and LOG_FILE.stat().st_size > 200 * 1024:
            LOG_FILE.write_text("", encoding="utf-8")  # 简单轮转，别无限长
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def collect_hosts():
    """
    取本机所有 IPv4 地址（地址 + 网卡名）。

    Get-NetIPAddress 的输出含中文网卡名（以太网 / WLAN），直接读 stdout 会碰到
    控制台代码页问题，所以让 PowerShell 写成 UTF-8 临时文件再读。
    """
    fd, tmp = tempfile.mkstemp(suffix=".json")
    os.close(fd)
    try:
        script = (
            "Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | "
            "Select-Object IPAddress,InterfaceAlias | ConvertTo-Json -Compress | "
            f"Set-Content -LiteralPath '{tmp}' -Encoding UTF8"
        )
        subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
            check=True, capture_output=True, timeout=60,
        )
        raw = Path(tmp).read_text(encoding="utf-8-sig").strip()
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass

    if not raw or raw == "null":
        return []

    data = json.loads(raw)
    if isinstance(data, dict):
        data = [data]

    hosts = []
    for row in data:
        ip = str(row.get("IPAddress") or "").strip()
        name = str(row.get("InterfaceAlias") or "").strip()
        if not ip.startswith(PREFIX):
            continue
        if any(key in name.lower() for key in SKIP_ALIAS):
            continue
        hosts.append({"ip": ip, "name": name})

    # 同一地址只留一条，并按地址排序，保证输出稳定（便于比较是否变化）
    uniq = {}
    for h in hosts:
        uniq.setdefault(h["ip"], h)
    return [uniq[ip] for ip in sorted(uniq)]


def git(*args, check=True):
    """在仓库根目录执行 git；禁掉交互式输入，避免计划任务里卡住。"""
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    return subprocess.run(
        ["git", *args], cwd=str(REPO), check=check,
        capture_output=True, text=True, encoding="utf-8", errors="replace", env=env,
    )


def read_existing():
    try:
        return json.loads(TARGET.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def main():
    hosts = collect_hosts()
    if not hosts:
        log(f"未取到 {PREFIX}* 的地址，本次不更新（线上文件保持原样）")
        return 0

    old = read_existing() or {}
    old_hosts = old.get("hosts") or []
    same = [(h.get("ip"), h.get("name")) for h in old_hosts] == [(h["ip"], h["name"]) for h in hosts]
    if same:
        log("地址未变化，无需提交")
        return 0

    # 工作区必须干净：有别人的改动时不掺和，跳过等下一轮
    if git("status", "--porcelain").stdout.strip():
        log("工作区有未提交的改动，跳过本次（避免把无关文件一起提交）")
        return 0

    # 本地必须与 origin/main 同步：落后时先让用户自己处理，避免 rebase 搅乱工作区
    git("fetch", "origin", "main")
    head = git("rev-parse", "HEAD").stdout.strip()
    remote = git("rev-parse", "origin/main").stdout.strip()
    if head != remote:
        log("本地 main 与 origin/main 不一致，跳过本次（请先手动同步）")
        return 0

    payload = {
        "hosts": hosts,
        "updatedAt": f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S}",
        "source": "publish_lan_ip.py",
    }
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    summary = " / ".join(h["ip"] for h in hosts)
    git("add", "-f", str(TARGET.relative_to(REPO)))
    git("-c", "user.name=lan-ip-bot",
        "-c", "user.email=lan-ip-bot@users.noreply.github.com",
        "commit", "-m", f"chore: 更新本机内网地址（{summary}）")

    try:
        git("push", "origin", "main")
    except subprocess.CalledProcessError as err:
        log(f"推送失败（下一轮会重试）：{err.stderr.strip()}")
        return 1

    log(f"已发布：{summary}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # 计划任务里没有控制台，异常必须落盘
        log(f"执行失败：{exc}")
        sys.exit(1)
