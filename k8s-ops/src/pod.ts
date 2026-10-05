import { resolveKubeconfig, loadKc, exec, output } from './config';
import { CoreV1Api, V1Pod } from '@kubernetes/client-node';

/** Pod / workload 就绪与版本校验。 */
export async function handlePod(action: string, input: any) {
  const kcPath = resolveKubeconfig(input);
  const ns = input.namespace || 'default';
  const env: NodeJS.ProcessEnv = kcPath ? { KUBECONFIG: kcPath } : {};
  const kubeArgs: string[] = kcPath ? ['--kubeconfig', kcPath] : [];

  switch (action) {
    case 'pod.verify_ready': {
      // 校验 namespace 下所有 Pod 均 Running+Ready（可按 label selector 过滤）
      const kc = loadKc(kcPath);
      const core = kc.makeApiClient(CoreV1Api);
      const selector = input.label_selector || '';
      const res = await core.listNamespacedPod(ns, undefined, undefined, undefined, undefined, selector);
      const pods: V1Pod[] = res.body.items || [];
      const notReady = pods.filter((p: V1Pod) => {
        const cs = p.status?.conditions || [];
        const ready = cs.find(c => c.type === 'Ready');
        return p.status?.phase !== 'Running' || ready?.status !== 'True';
      });
      const details = notReady.map((p: V1Pod) => ({
        name: p.metadata?.name, phase: p.status?.phase,
        reasons: (p.status?.containerStatuses || [])
          .filter(c => !c.ready).map(c => `${c.name}: ${c.state?.waiting?.reason || c.state?.terminated?.reason || 'not ready'}`)
      }));
      if (notReady.length > 0) {
        return output(false, { not_ready: details }, `${notReady.length} 个 Pod 未就绪`);
      }
      return output(true, { total: pods.length, all_ready: true });
    }

    case 'pod.rollout_status': {
      // 对所有 workload 执行 kubectl rollout status
      const workloads: string[] = input.workloads || [];
      const results: any[] = [];
      for (const w of workloads) {
        const r = await exec('kubectl', ['rollout', 'status', String(w), '-n', String(ns), '--timeout=180s', ...kubeArgs], { env });
        results.push({ workload: w, ok: r.code === 0, output: r.stdout || r.stderr });
        if (r.code !== 0) return output(false, { results }, `${w} rollout 失败`);
      }
      return output(true, { results });
    }

    case 'pod.get_images': {
      // 列出 namespace 下所有 Pod 的镜像，用于版本一致性校验
      const kc = loadKc(kcPath);
      const core = kc.makeApiClient(CoreV1Api);
      const res = await core.listNamespacedPod(ns);
      const pods = res.body.items || [];
      const images = pods.map(p => ({
        pod: p.metadata?.name,
        images: (p.spec?.containers || []).map(c => c.image)
      }));
      return output(true, { images });
    }

    default:
      return output(false, {}, `未知 pod action: ${action}`);
  }
}
