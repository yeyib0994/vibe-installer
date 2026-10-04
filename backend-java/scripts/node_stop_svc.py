#!/usr/bin/env python3
"""停服脚本：停止目标节点上的 systemd 服务（升级前优雅停止）。

输入 (stdin JSON):
    {
        "ip": "10.0.0.11",
        "ssh_port": 22,
        "ssh_user": "root",
        "ssh_key_path": "/path/to/key",
        "services": ["cloudops-agent", "kubelet"],
        "timeout": 120
    }

输出 (stdout JSON):
    {"ok": true, "report": "..."}
"""
import json
import subprocess
import sys


def ssh_base(inp):
    cmd = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no",
           "-o", "ConnectTimeout=8", "-p", str(inp.get("ssh_port", 22))]
    if inp.get("ssh_key_path"):
        cmd += ["-i", inp["ssh_key_path"]]
    cmd.append(f"{inp.get('ssh_user', 'root')}@{inp['ip']}")
    return cmd


def main():
    try:
        raw = sys.stdin.read()
        inp = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as e:
        print(json.dumps({"ok": False, "error": f"JSON 解析失败: {e}"}))
        sys.exit(1)

    if not inp.get("ip"):
        print(json.dumps({"ok": False, "error": "缺少 ip"}))
        sys.exit(1)

    services = inp.get("services") or []
    if not services:
        print(json.dumps({"ok": False, "error": "缺少 services"}))
        sys.exit(1)

    timeout = inp.get("timeout", 120)
    remote = " && ".join([f"systemctl stop {s}" for s in services])
    cmd = ssh_base(inp) + [remote]

    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                           encoding="utf-8", errors="replace")
        if r.returncode != 0:
            print(json.dumps({"ok": False, "error": r.stderr.strip() or r.stdout.strip()}))
            sys.exit(1)
        print(json.dumps({"ok": True, "report": f"已停止服务: {', '.join(services)}"},
                         ensure_ascii=False))
    except subprocess.TimeoutExpired:
        print(json.dumps({"ok": False, "error": f"停服超时({timeout}s)"}))
        sys.exit(1)
    except FileNotFoundError:
        print(json.dumps({"ok": False, "error": "ssh 未安装"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
