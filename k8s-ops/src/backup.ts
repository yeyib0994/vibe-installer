import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveKubeconfig, loadKc, exec, output } from './config';

/** 备份操作：导出 Helm values/manifest、PVC VolumeSnapshot。 */
export async function handleBackup(action: string, input: any) {
  const kcPath = resolveKubeconfig(input);
  const ns = input.namespace || 'default';
  const release = input.release_name;
  const env: NodeJS.ProcessEnv = kcPath ? { KUBECONFIG: kcPath } : {};
  const kubeArgs: string[] = kcPath ? ['--kubeconfig', kcPath] : [];
  const nsArgs = ['-n', String(ns), ...kubeArgs];
  const backupDir = input.backup_dir || path.join(os.tmpdir(), 'cloudops-backup');
  // release_name 会拼进落盘文件名：留着 / 与 .. 就能把导出文件写到 backupDir 之外。
  // argv 已经挡住命令注入，这一层挡的是路径穿越（与后端 packages 落盘同名规则）。
  const releaseFile = String(release ?? '').replace(/[^a-zA-Z0-9._-]/g, '_');
  fs.mkdirSync(backupDir, { recursive: true });

  switch (action) {
    case 'backup.export_values': {
      if (!release) return output(false, {}, '缺少 release_name');
      const r = await exec('helm', ['get', 'values', String(release), '-o', 'json', '--namespace', String(ns), ...kubeArgs], { env });
      if (r.code !== 0) return output(false, {}, r.stderr || r.stdout);
      const f = path.join(backupDir, `${releaseFile}-values.json`);
      fs.writeFileSync(f, r.stdout);
      return output(true, { file: f, values: safeParse(r.stdout) });
    }

    case 'backup.export_manifest': {
      if (!release) return output(false, {}, '缺少 release_name');
      const r = await exec('helm', ['get', 'manifest', String(release), '--namespace', String(ns), ...kubeArgs], { env });
      if (r.code !== 0) return output(false, {}, r.stderr || r.stdout);
      const f = path.join(backupDir, `${releaseFile}-manifest.yaml`);
      fs.writeFileSync(f, r.stdout);
      return output(true, { file: f, bytes: r.stdout.length });
    }

    case 'backup.volume_snapshot': {
      // 对指定 PVC 创建 VolumeSnapshot（依赖 VolumeSnapshotClass）
      const pvcName = input.pvc_name;
      const snapClass = input.snapshot_class || 'default';
      if (!pvcName) return output(false, {}, '缺少 pvc_name');
      // 这三个值要拼进清单 YAML 文本；带换行就能往 manifest 里塞额外字段（K8s 本身也只接受
      // DNS-1123 标签，所以这里拒绝的不是额外限制，而是把「反正会被 apiserver 拒」提前到本地）。
      const LABEL = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
      for (const [what, val] of [['namespace', ns], ['pvc_name', pvcName], ['snapshot_class', snapClass]] as const) {
        if (!LABEL.test(String(val))) return output(false, {}, `${what}「${val}」不是合法的 Kubernetes 名称，不能拼入清单`);
      }
      const snapName = `${pvcName}-snap-${Date.now()}`;
      const yml = `apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: ${snapName}
  namespace: ${ns}
spec:
  volumeSnapshotClassName: ${snapClass}
  source:
    persistentVolumeClaimName: ${pvcName}
`;
      const tmp = path.join(os.tmpdir(), `snap-${snapName}.yaml`);
      fs.writeFileSync(tmp, yml);
      const r = await exec('kubectl', ['apply', '-f', tmp, ...nsArgs], { env });
      fs.unlinkSync(tmp);
      if (r.code !== 0) return output(false, {}, r.stderr || r.stdout);
      return output(true, { snapshot_name: snapName, pvc: pvcName });
    }

    case 'backup.list_pvc': {
      const r = await exec('kubectl', ['get', 'pvc', '-o', 'json', ...nsArgs], { env });
      if (r.code !== 0) return output(false, {}, r.stderr || r.stdout);
      try {
        const data = JSON.parse(r.stdout);
        const pvcs = (data.items || []).map((i: any) => ({
          name: i.metadata.name, size: i.spec.resources.requests.storage, phase: i.status.phase
        }));
        return output(true, { pvcs });
      } catch { return output(true, { raw: r.stdout }); }
    }

    default:
      return output(false, {}, `未知 backup action: ${action}`);
  }
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return s; }
}
