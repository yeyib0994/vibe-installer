import time, hashlib, sys
from pathlib import Path
from app.core import store
from app.core.seed import seed_if_empty
from app.engine import workflow as wf
from app.engine.executor import executor, DATA_DIR
from app.models.schemas import PackageEntry, StageStatus, EnvironmentSpec, NodeSpec, NodeRole, MachineType

store.init_db(); seed_if_empty()

# 直接构造一个已登记好节点的环境，跳过阶段 1 的交互式表单，
# 从阶段 2 开始跑完整链路。
env = EnvironmentSpec(name='验证环境', id='envcheck0001',
    description='自动化验证用', k8s_version='v1.29.4', base_domain='corp.local')
_n = lambda i, host, ip, role, mt, **kw: NodeSpec(id=f'n{i}', hostname=host, ip=ip,
    role=role, machine_type=mt, **kw)
env.nodes = [
    _n(1,'ctrl-phy-01','10.20.1.11',NodeRole.CONTROL,MachineType.PHYSICAL,
       vendor='Dell', model='PowerEdge R750', idc='SH-IDC-01', rack='A-01', cpu_cores=64,
       mem_total_gb=256, disk_free_gb=1800, ssh_key_path=''),
    _n(2,'ctrl-phy-02','10.20.1.12',NodeRole.CONTROL,MachineType.PHYSICAL,
       vendor='Dell', model='PowerEdge R750', idc='SH-IDC-01', rack='A-02', cpu_cores=64,
       mem_total_gb=256, disk_free_gb=1800, ssh_key_path=''),
    _n(3,'ctrl-phy-03','10.20.1.13',NodeRole.CONTROL,MachineType.PHYSICAL,
       vendor='H3C', model='UniServer R4900 G5', idc='SH-IDC-01', rack='A-03',
       cpu_cores=64, mem_total_gb=256, disk_free_gb=1800, ssh_key_path=''),
    _n(4,'db-phy-01','10.20.1.21',NodeRole.DATABASE,MachineType.PHYSICAL,
       vendor='Huawei', model='FusionServer 2288H V6', idc='SH-IDC-01', rack='B-01',
       cpu_cores=64, mem_total_gb=512, disk_free_gb=3600, ssh_key_path=''),
    _n(5,'worker-vm-01','10.20.2.31',NodeRole.WORKER,MachineType.VIRTUAL,
       host_platform='VMware vSphere 8.0', vcpu=16, memory_gb=64, disk_gb=500,
       ssh_key_path=''),
    _n(6,'worker-vm-02','10.20.2.32',NodeRole.WORKER,MachineType.VIRTUAL,
       host_platform='VMware vSphere 8.0', vcpu=16, memory_gb=64, disk_gb=500,
       ssh_key_path=''),
    _n(7,'worker-vm-03','10.20.2.33',NodeRole.WORKER,MachineType.VIRTUAL,
       host_platform='VMware vSphere 8.0', vcpu=16, memory_gb=64, disk_gb=500,
       ssh_key_path=''),
    _n(8,'worker-vm-04','10.20.2.34',NodeRole.WORKER,MachineType.VIRTUAL,
       host_platform='KVM/oVirt', vcpu=16, memory_gb=64, disk_gb=500,
       ssh_key_path=''),
    _n(9,'worker-vm-05','10.20.2.35',NodeRole.WORKER,MachineType.VIRTUAL,
       host_platform='KVM/oVirt', vcpu=16, memory_gb=64, disk_gb=500,
       ssh_key_path=''),
    _n(10,'gw-vm-01','10.20.3.41',NodeRole.GATEWAY,MachineType.VIRTUAL,
       host_platform='VMware vSphere 8.0', vcpu=8, memory_gb=32, disk_gb=300,
       ssh_key_path=''),
]
store.save_env(env)
flow = wf.create_flow('生产主中心安装', env.id, 'install'); wf.refresh_locks(flow); store.save_flow(flow)

def run(flow_id, stage_key, inputs=None, timeout=180):
    f = store.get_flow(flow_id); st = wf.stage_by_key(f, stage_key)
    if inputs: st.inputs.update(inputs)
    wf.refresh_locks(f); store.save_flow(f)
    executor.submit(f, stage_key, 'ops')
    t0=time.time()
    while time.time()-t0 < timeout:
        time.sleep(0.3)
        f2 = store.get_flow(flow_id); s2 = wf.stage_by_key(f2, stage_key)
        if s2.status in (StageStatus.PASSED, StageStatus.FAILED, StageStatus.SKIPPED): break
    return f2, s2

pkg_dir = DATA_DIR / 'packages'; pkg_dir.mkdir(parents=True, exist_ok=True)
raw = (b'FAKE_INSTALL_BUNDLE_v2.4.0\n' * 40000)
p = pkg_dir / 'demo-bundle-v2.4.0.tar.gz'; p.write_bytes(raw)
pid = 'pkgtest00001'
store.save_package(PackageEntry(id=pid, name='demo-bundle', version='v2.4.0', kind='bundle',
    size_bytes=len(raw), checksum=hashlib.sha256(raw).hexdigest(), path=str(p),
    upload_complete=True, uploaded_bytes=len(raw)))

for key, inputs, label in [
   ('env_register', {'physical_nodes': [n.model_dump(mode='json') for n in env.nodes
                                        if n.machine_type.value == 'physical'],
                     'virtual_nodes': [n.model_dump(mode='json') for n in env.nodes
                                       if n.machine_type.value == 'virtual'],
                     'control_count': 3, 'worker_count': 5,
                     'timezone': 'Asia/Shanghai'}, '[1] 环境登记'),
   ('env_precheck', {'ssh_user':'root','ssh_port':22,'strict_mode':False}, '[2] 环境校验'),
   ('package_upload', {'_package_id': pid, '_package_ids':[pid]}, '[3] 上传安装包'),
   ('package_distribute', {'remote_dir':'/opt/packages','mode':'rsync','concurrency':4,
                            'verify_checksum':True,
                            'target_roles':['control','worker','database','storage','gateway']}, '[4] 包分发'),
   ('pre_install_backup', {'include_paths':['/etc','/var/lib'],'include_databases':['appdb'],
                            'include_config':True,'retention_days':30}, '[5] 安装前备份'),
   ('install_execute', {'install_mode':'full','stop_on_failure':True,'parallel_workers':3}, '[6] 执行安装'),
   ('post_verify', {'keep_backup':True}, '[7] 安装后验证'),
]:
    f, st = run(flow.id, key, inputs)
    print(f'{label} → {st.status.value}')
    if st.status.value == 'failed':
        for s in st.steps:
            if s.error: print('     FAIL:', s.title, '|', s.error)
        break
    last = st.steps[-1]
    print('    ' + '\n    '.join((last.output or '').strip().splitlines()[:8]))
    print()

final = store.get_flow(flow.id)
print('最终流程状态:', final.status.value, '| 终态=%s' % final.finished_at)
b = store.get_backup(final.backup_point_id)
if b: print(f'备份点: {b.name} | {b.size_bytes/1024/1024:.2f} MB | 保留 {b.retention_days} 天 | 可恢复={b.restorable}')
print('阶段总览:', ' '.join(f'{s.key}={s.status.value}' for s in final.stages))
