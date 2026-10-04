#!/usr/bin/env python3
"""节点安装前预检脚本。

Java 端通过 ProcessBuilder 调用本脚本，传入节点信息（JSON via stdin），
脚本以 JSON 输出预检结果，便于扩展检查项。

输入 (stdin, JSON)：
    {
        "hostname": "ctrl-01",
        "ip": "10.0.0.11",
        "ssh_port": 22,
        "ssh_user": "root",
        "ssh_key_path": "/path/to/key",   # 可为空
        "mock": false                      # true 时走模拟模式
    }

输出 (stdout, JSON)：
    {
        "ok": true,
        "report": "操作系统: ...\n架构: ...",
        "issues": ["NTP 未同步", ...]
    }

扩展方式：在 collect_checks() 里追加新的 (section, cmd) 元组，
或在 analyze() 里追加新的判定逻辑即可，无需改 Java 代码。
"""

from __future__ import annotations

import hashlib
import json
import os
import random
import shutil
import subprocess
import sys
from typing import Any, Dict, List, Tuple


# ===================== 可扩展的检查项定义 =====================

# 每个检查项: (section 名称, 远程命令, 超时秒)
# 新增检查项只需在此追加，analyze() 会按 section 自动解析。
def collect_checks() -> List[Tuple[str, str, int]]:
    return [
        ("OS",       "cat /etc/os-release 2>/dev/null | grep -E '^(NAME|VERSION_ID)=' || echo UNKNOWN", 10),
        ("KERNEL",   "uname -r", 10),
        ("ARCH",     "uname -m", 10),
        ("CPU",      "nproc", 10),
        ("MEM",      "free -g 2>/dev/null | awk '/Mem:/{print $2}'", 10),
        ("DISK",     "df -BG / /var /opt 2>/dev/null | awk 'NR>1{print $6\": \"$4\"G available\"}' | sort -u", 15),
        ("SWAP",     "free -g 2>/dev/null | awk '/Swap:/{print $2}'", 10),
        ("SELINUX",  "getenforce 2>/dev/null || echo not-installed", 10),
        ("FIREWALL", "(systemctl is-active firewalld 2>/dev/null || echo inactive)", 10),
        ("TIME",     "(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo unknown)", 10),
        ("PORTS",    (
            "for p in 22 2379 2380 6443 10250 3306 5432 6379; do "
            "if (ss -lntH 2>/dev/null || netstat -lntH 2>/dev/null) "
            "| awk '{print $4}' | grep -q \":$p$\"; then echo \"$p OCCUPIED\"; fi; done"
        ), 15),
        ("DEPS",     (
            "for c in tar gzip curl systemctl; do "
            "command -v $c >/dev/null 2>&1 && echo \"$c ok\" || echo \"$c MISSING\"; done"
        ), 15),
        ("ULIMIT",   "ulimit -n", 10),
        # === 可在此追加新检查项 ===
        # ("K8S_VER",  "kubectl version --short 2>/dev/null | head -1", 10),
        # ("DOCKER",   "docker --version 2>/dev/null || echo MISSING", 10),
    ]


# ===================== SSH 工具 =====================

def ssh_base(node: Dict[str, Any]) -> List[str]:
    cmd = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no",
           "-o", "ConnectTimeout=8", "-p", str(node.get("ssh_port", 22))]
    key = node.get("ssh_key_path")
    if key:
        cmd += ["-i", key]
    cmd.append(f"{node.get('ssh_user', 'root')}@{node['ip']}")
    return cmd


def run(cmd: List[str], timeout: int = 120) -> Tuple[bool, str, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                           encoding="utf-8", errors="replace")
        return p.returncode == 0, p.stdout or "", p.stderr or ""
    except FileNotFoundError:
        return False, "", "命令不存在"
    except subprocess.TimeoutExpired:
        return False, "", f"命令超时({timeout}s)"


def ssh(node: Dict[str, Any], remote_cmd: str, timeout: int = 120) -> Tuple[bool, str, str]:
    return run(ssh_base(node) + [remote_cmd], timeout)


# ===================== 预检逻辑 =====================

def run_real_precheck(node: Dict[str, Any]) -> Dict[str, Any]:
    sections: Dict[str, List[str]] = {}
    for section, cmd, timeout in collect_checks():
        ok, out, _ = ssh(node, cmd, timeout)
        lines = [l.strip() for l in out.splitlines() if l.strip()]
        sections[section] = lines

    return analyze(sections)


def run_mock_precheck(node: Dict[str, Any]) -> Dict[str, Any]:
    seed = int(hashlib.md5(node["ip"].encode()).hexdigest()[:6], 16)
    rnd = random.Random(seed + 7)
    cores = node.get("vcpu") or rnd.choice([8, 16, 24, 32])
    mem = node.get("memory_gb") or rnd.choice([16, 32, 64])
    disk = node.get("disk_gb") or rnd.choice([200, 500])

    issues: List[str] = []
    if seed % 7 == 3:
        issues.append("NTP 时间未同步，集群组件对时钟偏差敏感")
    if seed % 11 == 5:
        issues.append("SELinux 处于 enforcing，可能导致服务启动被拒，建议设为 permissive")
    if mem < 8:
        issues.append(f"内存仅 {mem} GB，低于推荐的 8 GB")

    selinux = "enforcing" if any("SELinux" in i for i in issues) else "permissive"
    ntp = "no" if any("NTP" in i for i in issues) else "yes"

    report = "\n".join([
        f"[MOCK] 操作系统: Red Hat Enterprise Linux 9.2",
        f"架构: x86_64  内核: 5.14.0-284.el9.x86_64",
        f"CPU {cores} 核 / 内存 {mem} GB",
        f"磁盘: /: {disk}G available",
        f"SELinux: {selinux}",
        "防火墙: inactive",
        f"时间同步: {ntp}",
        "依赖检查: 全部满足",
        "文件句柄上限: 65535",
    ])
    return {"ok": len(issues) == 0, "report": report, "issues": issues}


def analyze(sections: Dict[str, List[str]]) -> Dict[str, Any]:
    """解析各 section 输出，生成报告与问题列表。

    新增检查项后，在此追加对应的解析逻辑。
    """
    issues: List[str] = []
    report: List[str] = []

    # OS
    os_name = " ".join(sections.get("OS", []))
    report.append(f"操作系统: {os_name or '未知'}")

    # ARCH / KERNEL
    arch = (sections.get("ARCH") or ["unknown"])[0]
    report.append(f"架构: {arch}  内核: {(sections.get('KERNEL') or [''])[0]}")
    if arch not in ("x86_64", "aarch64"):
        issues.append(f"CPU 架构 {arch} 不在受支持范围（x86_64 / aarch64）")

    # CPU / MEM
    cpu = (sections.get("CPU") or ["0"])[0]
    mem = (sections.get("MEM") or ["0"])[0]
    report.append(f"CPU {cpu} 核 / 内存 {mem} GB")
    try:
        if int(mem) < 4:
            issues.append(f"内存仅 {mem} GB，低于推荐的 4 GB")
        if int(cpu) < 2:
            issues.append(f"CPU 仅 {cpu} 核，低于推荐的 2 核")
    except ValueError:
        pass

    # DISK
    disks = sections.get("DISK", [])
    report.append("磁盘: " + ("; ".join(disks) if disks else "未采集到"))
    for d in disks:
        try:
            parts = d.split(":")
            free_gb = float(parts[1].strip().replace("G", "").replace(" available", "").strip())
            if free_gb < 20:
                issues.append(f"挂载点 {parts[0]} 可用空间仅 {free_gb:.0f} GB，低于 20 GB")
        except (IndexError, ValueError):
            pass

    # SELINUX
    selinux = (sections.get("SELINUX") or ["unknown"])[0]
    report.append(f"SELinux: {selinux}")
    if selinux.lower() == "enforcing":
        issues.append("SELinux 处于 enforcing，可能导致服务启动被拒，建议设为 permissive")

    # FIREWALL
    fw = (sections.get("FIREWALL") or ["inactive"])[0]
    report.append(f"防火墙: {fw}")
    if fw.strip() == "active":
        issues.append("firewalld 处于 active，请确认所需端口已放行")

    # TIME
    ntp = (sections.get("TIME") or ["unknown"])[0]
    report.append(f"时间同步: {ntp}")
    if ntp.strip().lower() != "yes":
        issues.append("NTP 时间未同步，集群组件对时钟偏差敏感")

    # PORTS
    ports = sections.get("PORTS", [])
    if ports:
        pnums = [p.split()[0] for p in ports]
        report.append("已占用端口: " + ", ".join(pnums))
        issues.append("以下端口已被占用，可能与待安装组件冲突: " + ", ".join(pnums))

    # DEPS
    deps = sections.get("DEPS", [])
    missing = [d.split()[0] for d in deps if "MISSING" in d]
    report.append("依赖检查: " + ("全部满足" if not missing else f"缺少 {', '.join(missing)}"))
    if missing:
        issues.append(f"缺少必要命令: {', '.join(missing)}")

    # ULIMIT
    ulimit_n = (sections.get("ULIMIT") or ["0"])[0]
    report.append(f"文件句柄上限: {ulimit_n}")
    try:
        if int(ulimit_n) < 65535:
            issues.append(f"ulimit -n 为 {ulimit_n}，建议提升到 65535 以上")
    except ValueError:
        pass

    # === 新增检查项的解析可在此追加 ===

    return {"ok": len(issues) == 0, "report": "\n".join(report), "issues": issues}


# ===================== 入口 =====================

def main() -> None:
    try:
        raw = sys.stdin.read()
        node = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as e:
        print(json.dumps({"ok": False, "report": "", "issues": [f"输入 JSON 解析失败: {e}"]}))
        sys.exit(1)

    if not node.get("ip"):
        print(json.dumps({"ok": False, "report": "", "issues": ["缺少节点 ip"]}))
        sys.exit(1)

    if node.get("mock") or not shutil.which("ssh"):
        result = run_mock_precheck(node)
    else:
        result = run_real_precheck(node)

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
