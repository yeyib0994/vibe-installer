#!/usr/bin/env python3
"""节点排水（drain）脚本，用于升级前驱逐节点上的 Pod。

输入 (stdin JSON):
    {
        "node": "node-01",
        "kubeconfig": "/path/to/kubeconfig",   # 可选
        "ignore_daemonsets": true,
        "delete_emptydir": true,
        "timeout": 300
    }

输出 (stdout JSON):
    {"ok": true, "report": "..."}
    {"ok": false, "error": "..."}
"""
import json
import subprocess
import sys


def main():
    try:
        raw = sys.stdin.read()
        inp = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as e:
        print(json.dumps({"ok": False, "error": f"JSON 解析失败: {e}"}))
        sys.exit(1)

    node = inp.get("node")
    if not node:
        print(json.dumps({"ok": False, "error": "缺少 node"}))
        sys.exit(1)

    kc = inp.get("kubeconfig")
    ignore_ds = inp.get("ignore_daemonsets", True)
    del_emptydir = inp.get("delete_emptydir", True)
    timeout = inp.get("timeout", 300)

    cmd = ["kubectl", "drain", node]
    if ignore_ds:
        cmd.append("--ignore-daemonsets")
    if del_emptydir:
        cmd.append("--delete-emptydir-data")
    cmd += ["--timeout", f"{timeout}s"]
    if kc:
        cmd += ["--kubeconfig", kc]

    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 30,
                           encoding="utf-8", errors="replace")
        if r.returncode != 0:
            print(json.dumps({"ok": False, "error": r.stderr.strip() or r.stdout.strip()}))
            sys.exit(1)
        print(json.dumps({"ok": True, "report": r.stdout.strip()}, ensure_ascii=False))
    except subprocess.TimeoutExpired:
        print(json.dumps({"ok": False, "error": f"drain 超时({timeout}s)"}))
        sys.exit(1)
    except FileNotFoundError:
        print(json.dumps({"ok": False, "error": "kubectl 未安装"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
