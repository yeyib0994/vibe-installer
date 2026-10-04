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
  const kubeArg = kcPath ? ` --kubeconfig ${kcPath}` : '';
  const backupDir = input.backup_dir || path.join(os.tmpdir(), 'cloudops-backup');
  fs.mkdirSync(backupDir, { recursive: true });

  switch (action) {
    case 'backup.export_values': {
      if (!release) return output(false, {}, '缺少 release_name');
      const r = await exec(`helm get values ${release} -o json --namespace ${ns}${kubeArg}`, { env });
      if (r.code !== 0) return output(false, {}, r.stderr || r.stdout);
      const f = path.join(backupDir, `${release}-values.json`);
      fs.writeFileSync(f, r.stdout);
      return output(true, { file: f, values: safeParse(r.stdout) });
    }

    case 'backup.export_manifest': {
      if (!release) return output(false, {}, '缺少 release_name');
      const r = await exec(`helm get manifest ${release} --namespace ${ns}${kubeArg}`, { env });
      if (r.code !== 0) return output(false, {}, r.stderr || r.stdout);
      const f = path.join(backupDir, `${release}-manifest.yaml`);
      fs.writeFileSync(f, r.stdout);
      return output(true, { file: f, bytes: r.stdout.length });
    }

    case 'backup.volume_snapshot': {
      // 对指定 PVC 创建 VolumeSnapshot（依赖 VolumeSnapshotClass）
      const pvcName = input.pvc_name;
      const snapClass = input.snapshot_class || 'default';
      if (!pvcName) return output(false, {}, '缺少 pvc_name');
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
      const r = await exec(`kubectl apply -f ${tmp} -n ${ns}${kubeArg}`, { env });
      fs.unlinkSync(tmp);
      if (r.code !== 0) return output(false, {}, r.stderr || r.stdout);
      return output(true, { snapshot_name: snapName, pvc: pvcName });
    }

    case 'backup.list_pvc': {
      const r = await exec(`kubectl get pvc -n ${ns} -o json${kubeArg}`, { env });
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
