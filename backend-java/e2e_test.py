"""端到端冒烟测试：通过 HTTP API 跑通 Java 后端的安装工作流。"""
import json
import time
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:8848"


def req(method, path, body=None):
    data = None
    headers = {"Content-Type": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{e.code} {path}: {raw}")


def wait_stage(flow_id, stage_key, timeout=240):
    t0 = time.time()
    while time.time() - t0 < timeout:
        time.sleep(0.4)
        f = req("GET", f"/api/flows/{flow_id}")
        st = next(s for s in f["stages"] if s["key"] == stage_key)
        if st["status"] in ("passed", "failed", "skipped"):
            return f, st
    raise TimeoutError(f"stage {stage_key} 超时")


def main():
    envs = req("GET", "/api/environments")
    env = envs if isinstance(envs, dict) else envs[0]
    env_id = env["id"]
    print(f"使用环境: {env['name']} ({env_id}), 节点数={len(env['nodes'])}")

    flow = req("POST", "/api/flows", {"name": "e2e-java", "env_id": env_id, "mode": "install"})
    flow_id = flow["id"]
    print(f"创建流程: {flow_id}")

    physical = [n for n in env["nodes"] if n["machine_type"] == "physical"]
    virtual = [n for n in env["nodes"] if n["machine_type"] == "virtual"]

    # 上传一个假安装包
    import tempfile, os
    raw = (b"FAKE_INSTALL_BUNDLE_v2.4.0\n" * 40000)
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".tar.gz")
    tmp.write(raw); tmp.close()
    boundary = "----cloudopstest"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="demo-bundle-v2.4.0.tar.gz"\r\n'
        f"Content-Type: application/octet-stream\r\n\r\n"
    ).encode() + raw + (
        f"\r\n--{boundary}\r\n"
        f'Content-Disposition: form-data; name="name"\r\n\r\ndemo-bundle\r\n'
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="version"\r\n\r\nv2.4.0\r\n'
        f"--{boundary}--\r\n"
    ).encode()
    r = urllib.request.Request(BASE + "/api/packages/upload", data=body, method="POST",
                               headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(r, timeout=60) as resp:
        pkg = json.loads(resp.read().decode("utf-8"))
    pid = pkg["id"]
    print(f"上传安装包: {pid} ({pkg['name']} {pkg['version']})")
    os.unlink(tmp.name)

    stages = [
        ("env_register", {"physical_nodes": physical, "virtual_nodes": virtual,
                          "control_count": 3, "worker_count": 5, "timezone": "Asia/Shanghai"}),
        ("env_precheck", {"ssh_user": "root", "ssh_port": 22, "strict_mode": False}),
        ("package_upload", {"_package_id": pid, "_package_ids": [pid]}),
        ("package_distribute", {"remote_dir": "/opt/packages", "mode": "rsync", "concurrency": 4,
                                "verify_checksum": True,
                                "target_roles": ["control", "worker", "database", "gateway"]}),
        ("pre_install_backup", {"include_paths": ["/etc", "/var/lib"], "include_databases": ["appdb"],
                                "include_config": True, "retention_days": 30}),
        ("install_execute", {"install_mode": "full", "stop_on_failure": True, "parallel_workers": 3}),
        ("post_verify", {"keep_backup": True}),
    ]

    for key, inputs in stages:
        req("POST", f"/api/flows/{flow_id}/stages/{key}/inputs", {"inputs": inputs})
        req("POST", f"/api/flows/{flow_id}/stages/{key}/run", {"operator": "ops"})
        f, st = wait_stage(flow_id, key)
        label = st["title"]
        print(f"\n[{key}] {label} -> {st['status']}")
        if st["status"] == "failed":
            for s in st["steps"]:
                if s.get("error"):
                    print(f"  FAIL: {s['title']} | {s['error']}")
            break
        last = st["steps"][-1]
        out = (last.get("output") or "").strip().splitlines()
        for line in out[:6]:
            print("   " + line)

    final = req("GET", f"/api/flows/{flow_id}")
    print(f"\n最终流程状态: {final['status']}")
    print("阶段总览:", " ".join(f"{s['key']}={s['status']}" for s in final["stages"]))


if __name__ == "__main__":
    main()
