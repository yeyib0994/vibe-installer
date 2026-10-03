"""节点接入层：SSH 采集、文件分发、远程命令执行。

双驱动，与上一版 K8s 驱动的思路一致但对象换成物理机/虚机：
- SshDriver  : 真实调用 ssh / scp / rsync 二进制
- MockDriver : 无凭据也能演示，返回可信的模拟数据，输出带 [MOCK] 前缀

之所以优先用 ssh/scp/rsync 二进制而不是 paramiko：
真实交付环境里往往已配好 ~/.ssh/config、跳板机、known_hosts，
直接用系统 ssh 能自动复用这些既有配置，比在代码里重新实现一套认证更可靠。
paramiko 作为可选依赖，在需要密码认证时兜底。
"""

from __future__ import annotations

import hashlib
import os
import random
import shutil
import subprocess
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from ..models.schemas import NodeSpec, TransferMode


@dataclass
class CmdResult:
    ok: bool
    stdout: str = ""
    stderr: str = ""
    code: int = 0
    duration_ms: int = 0


def run(cmd: List[str], timeout: int = 120, stdin: Optional[str] = None) -> CmdResult:
    t0 = time.time()
    try:
        p = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout,
            input=stdin, encoding="utf-8", errors="replace",
        )
        return CmdResult(p.returncode == 0, p.stdout or "", p.stderr or "",
                         p.returncode, int((time.time() - t0) * 1000))
    except FileNotFoundError as e:
        return CmdResult(False, "", f"命令不存在: {e}", 127)
    except subprocess.TimeoutExpired:
        return CmdResult(False, "", f"命令超时({timeout}s)", 124)


class BaseDriver:
    is_mock = False

    def __init__(self, node: NodeSpec):
        self.node = node

    # -- 基础 -------------------------------------------------------------- #
    def _ssh_base(self) -> List[str]:
        cmd = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no",
               "-o", "ConnectTimeout=8", "-p", str(self.node.ssh_port)]
        if self.node.ssh_key_path:
            cmd += ["-i", self.node.ssh_key_path]
        cmd.append(f"{self.node.ssh_user}@{self.node.ip}")
        return cmd

    def ssh(self, remote_cmd: str, timeout: int = 120) -> CmdResult:
        return run(self._ssh_base() + [remote_cmd], timeout=timeout)

    # -- 能力 -------------------------------------------------------------- #
    def probe(self) -> Tuple[bool, str, Dict[str, Any]]:
        """探活 + 采集基础信息。"""
        raise NotImplementedError

    def precheck(self) -> Tuple[bool, str, List[str]]:
        """安装前环境预检，返回 (ok, 报告, 问题列表)。"""
        raise NotImplementedError

    def push(self, local_path: str, remote_dir: str,
             mode: TransferMode = TransferMode.RSYNC) -> Tuple[bool, str, int]:
        """推送文件，返回 (ok, 输出, 传输字节数)。"""
        raise NotImplementedError

    def pull(self, remote_path: str, local_dir: str) -> Tuple[bool, str]:
        """拉取文件（备份用）。"""
        raise NotImplementedError

    def remote_sha256(self, remote_path: str) -> Tuple[bool, str]:
        raise NotImplementedError


# --------------------------------------------------------------------------- #
# 真实驱动
# --------------------------------------------------------------------------- #
class SshDriver(BaseDriver):
    is_mock = False

    def probe(self) -> Tuple[bool, str, Dict[str, Any]]:
        r = self.ssh("echo __OK__ && hostname && uname -r && cat /etc/os-release 2>/dev/null | head -2")
        if not r.ok or "__OK__" not in r.stdout:
            return False, f"SSH 不可达: {r.stderr.strip() or '认证失败'}", {}
        lines = [l for l in r.stdout.splitlines() if l.strip() and l != "__OK__"]
        hostname = lines[0] if lines else self.node.hostname
        kernel = lines[1] if len(lines) > 1 else ""
        os_release = " ".join(lines[2:])[:120] if len(lines) > 2 else ""

        info: Dict[str, Any] = {"hostname": hostname, "kernel": kernel, "os_release": os_release}

        # 资源采集
        r = self.ssh("nproc; free -g | awk '/Mem:/{print $2}'; df -BG / | awk 'NR==2{print $4}' | tr -d G")
        if r.ok:
            vals = [v.strip() for v in r.stdout.splitlines() if v.strip()]
            try:
                info["cpu_cores"] = int(vals[0])
                info["mem_total_gb"] = float(vals[1])
                info["disk_free_gb"] = float(vals[2])
            except (IndexError, ValueError):
                pass
        return True, f"{hostname} 可达 ({info.get('os_release', '未知系统')[:40]})", info

    def precheck(self) -> Tuple[bool, str, List[str]]:
        """安装前预检：内核参数、依赖包、端口占用、磁盘、时间同步、SELinux。

        这些是实际交付中最常导致安装失败的项，逐项检查并给出可操作结论。
        """
        script = r"""
set -u
fail=0
echo "##OS"; cat /etc/os-release 2>/dev/null | grep -E '^(NAME|VERSION_ID)=' || echo "UNKNOWN"
echo "##KERNEL"; uname -r
echo "##ARCH"; uname -m
echo "##CPU"; nproc
echo "##MEM"; free -g 2>/dev/null | awk '/Mem:/{print $2}'
echo "##DISK"; df -BG / /var /opt 2>/dev/null | awk 'NR>1{print $6": "$4"G available"}' | sort -u
echo "##SWAP"; free -g 2>/dev/null | awk '/Swap:/{print $2}'
echo "##SELINUX"; getenforce 2>/dev/null || echo "not-installed"
echo "##FIREWALL"; (systemctl is-active firewalld 2>/dev/null || echo inactive)
echo "##TIME"; (timedatectl show -p NTPSynchronized --value 2>/dev/null || echo unknown)
echo "##PORTS"
for p in 22 2379 2380 6443 10250 3306 5432 6379; do
  if (ss -lntH 2>/dev/null || netstat -lntH 2>/dev/null) | awk '{print $4}' | grep -q ":$p\$"; then
    echo "$p OCCUPIED"
  fi
done
echo "##DEPS"
for c in tar gzip curl systemctl; do
  command -v $c >/dev/null 2>&1 && echo "$c ok" || echo "$c MISSING"
done
echo "##ULIMIT"; ulimit -n
echo "##END"
"""
        r = self.ssh(script, timeout=90)
        if not r.ok:
            return False, f"预检脚本执行失败: {r.stderr.strip()}", ["无法通过 SSH 在目标节点执行预检脚本"]

        sections: Dict[str, List[str]] = {}
        cur = None
        for line in r.stdout.splitlines():
            if line.startswith("##"):
                cur = line[2:].strip()
                sections[cur] = []
            elif cur and line.strip():
                sections[cur].append(line.strip())

        issues: List[str] = []
        report: List[str] = []

        os_name = " ".join(sections.get("OS", []))
        report.append(f"操作系统: {os_name or '未知'}")
        arch = (sections.get("ARCH") or ["unknown"])[0]
        report.append(f"架构: {arch}  内核: {(sections.get('KERNEL') or [''])[0]}")
        if arch not in ("x86_64", "aarch64"):
            issues.append(f"CPU 架构 {arch} 不在受支持范围（x86_64 / aarch64）")

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

        disks = sections.get("DISK", [])
        report.append("磁盘: " + ("; ".join(disks) if disks else "未采集到"))
        for d in disks:
            try:
                free_gb = float(d.split(":")[1].strip().rstrip("G"))
                if free_gb < 20:
                    issues.append(f"挂载点 {d.split(':')[0]} 可用空间仅 {free_gb:.0f} GB，低于 20 GB")
            except (IndexError, ValueError):
                pass

        selinux = (sections.get("SELINUX") or ["unknown"])[0]
        report.append(f"SELinux: {selinux}")
        if selinux.lower() == "enforcing":
            issues.append("SELinux 处于 enforcing，可能导致服务启动被拒，建议设为 permissive")

        fw = (sections.get("FIREWALL") or ["inactive"])[0]
        report.append(f"防火墙: {fw}")
        if fw.strip() == "active":
            issues.append("firewalld 处于 active，请确认所需端口已放行")

        ntp = (sections.get("TIME") or ["unknown"])[0]
        report.append(f"时间同步: {ntp}")
        if ntp.strip().lower() != "yes":
            issues.append("NTP 时间未同步，集群组件对时钟偏差敏感")

        ports = sections.get("PORTS", [])
        if ports:
            report.append("已占用端口: " + ", ".join(p.split()[0] for p in ports))
            issues.append("以下端口已被占用，可能与待安装组件冲突: "
                          + ", ".join(p.split()[0] for p in ports))

        deps = sections.get("DEPS", [])
        missing = [d.split()[0] for d in deps if "MISSING" in d]
        if missing:
            issues.append(f"缺少必要命令: {', '.join(missing)}")
        report.append("依赖检查: " + ("全部满足" if not missing else f"缺少 {', '.join(missing)}"))

        ulimit_n = (sections.get("ULIMIT") or ["0"])[0]
        report.append(f"文件句柄上限: {ulimit_n}")
        try:
            if int(ulimit_n) < 65535:
                issues.append(f"ulimit -n 为 {ulimit_n}，建议提升到 65535 以上")
        except ValueError:
            pass

        return len(issues) == 0, "\n".join(report), issues

    def push(self, local_path: str, remote_dir: str,
             mode: TransferMode = TransferMode.RSYNC) -> Tuple[bool, str, int]:
        import os
        size = os.path.getsize(local_path) if os.path.exists(local_path) else 0
        # 先确保目标目录存在
        self.ssh(f"mkdir -p {remote_dir}")

        if mode == TransferMode.RSYNC:
            ssh_cmd = " ".join(self._ssh_base()[:-1])
            if self.node.ssh_key_path:
                ssh_cmd += f" -i {self.node.ssh_key_path}"
            ssh_cmd += f" -p {self.node.ssh_port}"
            cmd = ["rsync", "-az", "--partial", "--inplace",
                   "-e", ssh_cmd, local_path, f"{self.node.ssh_user}@{self.node.ip}:{remote_dir}/"]
            r = run(cmd, timeout=3600)
            if not r.ok and "command not found" in r.stderr.lower():
                # rsync 不可用则退回 scp
                pass
            else:
                return r.ok, (r.stdout or r.stderr).strip(), size

        cmd = ["scp", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no",
               "-P", str(self.node.ssh_port)]
        if self.node.ssh_key_path:
            cmd += ["-i", self.node.ssh_key_path]
        cmd += [local_path, f"{self.node.ssh_user}@{self.node.ip}:{remote_dir}/"]
        r = run(cmd, timeout=3600)
        return r.ok, (r.stdout or r.stderr).strip(), size

    def pull(self, remote_path: str, local_dir: str) -> Tuple[bool, str]:
        import os
        os.makedirs(local_dir, exist_ok=True)
        cmd = ["scp", "-r", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no",
               "-P", str(self.node.ssh_port)]
        if self.node.ssh_key_path:
            cmd += ["-i", self.node.ssh_key_path]
        cmd += [f"{self.node.ssh_user}@{self.node.ip}:{remote_path}", local_dir]
        r = run(cmd, timeout=7200)
        return r.ok, (r.stdout or r.stderr).strip()

    def remote_sha256(self, remote_path: str) -> Tuple[bool, str]:
        r = self.ssh(f"sha256sum {remote_path} 2>/dev/null | awk '{{print $1}}'")
        return r.ok and bool(r.stdout.strip()), r.stdout.strip()


# --------------------------------------------------------------------------- #
# 模拟驱动
# --------------------------------------------------------------------------- #
class MockDriver(BaseDriver):
    is_mock = True

    def probe(self) -> Tuple[bool, str, Dict[str, Any]]:
        seed = int(hashlib.md5(self.node.ip.encode()).hexdigest()[:6], 16)
        rnd = random.Random(seed)
        info = {
            "hostname": self.node.hostname,
            "kernel": "5.14.0-284.el9.x86_64",
            "os_release": 'NAME="Red Hat Enterprise Linux" VERSION_ID="9.2"',
            "cpu_cores": self.node.vcpu or rnd.choice([8, 16, 24, 32]),
            "mem_total_gb": float(self.node.memory_gb or rnd.choice([16, 32, 64, 128])),
            "disk_free_gb": float(self.node.disk_gb or rnd.choice([200, 500, 1000])),
        }
        return True, f"[MOCK] {self.node.hostname} ({self.node.ip}) SSH 可达", info

    def precheck(self) -> Tuple[bool, str, List[str]]:
        seed = int(hashlib.md5(self.node.ip.encode()).hexdigest()[:6], 16)
        rnd = random.Random(seed + 7)
        cores = self.node.vcpu or rnd.choice([8, 16, 24, 32])
        mem = self.node.memory_gb or rnd.choice([16, 32, 64])
        disk = self.node.disk_gb or rnd.choice([200, 500])

        issues: List[str] = []
        # 按节点 IP 哈希稳定复现少数问题，让演示有真实感
        if seed % 7 == 3:
            issues.append("NTP 时间未同步，集群组件对时钟偏差敏感")
        if seed % 11 == 5:
            issues.append("SELinux 处于 enforcing，可能导致服务启动被拒，建议设为 permissive")
        if mem < 8:
            issues.append(f"内存仅 {mem} GB，低于推荐的 8 GB")

        report = "\n".join([
            f"[MOCK] 操作系统: Red Hat Enterprise Linux 9.2",
            f"架构: x86_64  内核: 5.14.0-284.el9.x86_64",
            f"CPU {cores} 核 / 内存 {mem} GB",
            f"磁盘: /: {disk}G available",
            "SELinux: enforcing" if any("SELinux" in i for i in issues) else "SELinux: permissive",
            "防火墙: inactive",
            "时间同步: no" if any("NTP" in i for i in issues) else "时间同步: yes",
            "依赖检查: 全部满足",
            "文件句柄上限: 65535",
        ])
        return len(issues) == 0, report, issues

    def push(self, local_path: str, remote_dir: str,
             mode: TransferMode = TransferMode.RSYNC) -> Tuple[bool, str, int]:
        import os
        size = os.path.getsize(local_path) if os.path.exists(local_path) else 0
        time.sleep(0.3 + random.random() * 0.5)
        return True, f"[MOCK] {mode.value} → {self.node.hostname}:{remote_dir} ({size} 字节)", size

    def pull(self, remote_path: str, local_dir: str) -> Tuple[bool, str]:
        import os
        os.makedirs(local_dir, exist_ok=True)
        time.sleep(0.2)
        return True, f"[MOCK] 已从 {self.node.hostname}:{remote_path} 拉取到 {local_dir}"

    def remote_sha256(self, remote_path: str) -> Tuple[bool, str]:
        return True, hashlib.sha256(remote_path.encode()).hexdigest()


# --------------------------------------------------------------------------- #
# 工厂
# --------------------------------------------------------------------------- #
def force_mock() -> bool:
    """CLOUDOPS_FORCE_MOCK=1 时强制走模拟驱动。

    演示/演练环境里没有真实机器，但本机装了 ssh 二进制，
    只要用户填了密钥路径就会被判定成真实驱动，一跑就全不可达。
    这个开关让控制台在纯演示环境下仍能完整走通流程。
    """
    return os.environ.get("CLOUDOPS_FORCE_MOCK", "") not in ("", "0", "false", "False")


def get_driver(node: NodeSpec) -> BaseDriver:
    """有 ssh_key_path 且本机有 ssh 二进制时用真实驱动，否则模拟。"""
    if force_mock():
        return MockDriver(node)
    if node.ssh_key_path and shutil.which("ssh"):
        return SshDriver(node)
    return MockDriver(node)


def ssh_available() -> bool:
    return shutil.which("ssh") is not None and shutil.which("scp") is not None


def rsync_available() -> bool:
    return shutil.which("rsync") is not None
