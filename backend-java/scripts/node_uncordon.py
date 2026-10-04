#!/usr/bin/env python3
"""节点恢复调度（uncordon）脚本，用于升级后恢复节点。

输入 (stdin JSON):
    {"node": "node-01", "kubeconfig": "/path/to/kubeconfig"}

输出 (stdout JSON):
    {"ok": true, "report": "..."}
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

    cmd = ["kubectl", "uncordon", node]
    if inp.get("kubeconfig"):
        cmd += ["--kubeconfig", inp["kubeconfig"]]

    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60,
                           encoding="utf-8", errors="replace")
        if r.returncode != 0:
            print(json.dumps({"ok": False, "error": r.stderr.strip() or r.stdout.strip()}))
            sys.exit(1)
        print(json.dumps({"ok": True, "report": r.stdout.strip()}, ensure_ascii=False))
    except FileNotFoundError:
        print(json.dumps({"ok": False, "error": "kubectl 未安装"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
