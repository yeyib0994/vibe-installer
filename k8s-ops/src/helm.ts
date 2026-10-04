import { resolveKubeconfig, exec, output } from './config';

/** Helm 操作封装。通过 helm CLI 执行，复用其全部能力。 */
export async function handleHelm(action: string, input: any) {
  const kcPath = resolveKubeconfig(input);
  const ns = input.namespace || 'default';
  const release = input.release_name;
  // helm.list 不需要 release_name
  if (action !== 'helm.list' && !release) return output(false, {}, '缺少 release_name');

  // kcPath 为空时使用集群内 ServiceAccount，不传 --kubeconfig
  const env: NodeJS.ProcessEnv = kcPath ? { KUBECONFIG: kcPath } : {};
  const kubeArg = kcPath ? ` --kubeconfig ${kcPath}` : '';
  const common = `--namespace ${ns}${kubeArg}`;

  switch (action) {
    case 'helm.upgrade': {
      const chart = input.chart;
      const version = input.version;
      const valuesFile = input.values_file;
      const setValues = input.set_values || {};
      if (!chart) return output(false, {}, '缺少 chart');
      let cmd = `helm upgrade --install ${release} ${chart} ${common}`;
      if (version) cmd += ` --version ${version}`;
      if (valuesFile) cmd += ` -f ${valuesFile}`;
      for (const [k, v] of Object.entries(setValues)) cmd += ` --set ${k}=${v}`;
      const r = await exec(cmd, { env });
      if (r.code !== 0) return output(false, {}, r.stderr || r.stdout);
      return output(true, { stdout: r.stdout });
    }

    case 'helm.rollback': {
      const revision = input.revision;
      let cmd = `helm rollback ${release} ${common}`;
      if (revision) cmd += ` ${revision}`;
      const r = await exec(cmd, { env });
      if (r.code !== 0) return output(false, {}, r.stderr || r.stdout);
      return output(true, { stdout: r.stdout });
    }

    case 'helm.get_values': {
      const r = await exec(`helm get values ${release} -o json ${common}`, { env });
      if (r.code !== 0) return output(false, {}, r.stderr || r.stdout);
      try { return output(true, { values: JSON.parse(r.stdout) }); }
      catch { return output(true, { values_raw: r.stdout }); }
    }

    case 'helm.get_manifest': {
      const r = await exec(`helm get manifest ${release} ${common}`, { env });
      if (r.code !== 0) return output(false, {}, r.stderr || r.stdout);
      return output(true, { manifest: r.stdout });
    }

    case 'helm.uninstall': {
      const r = await exec(`helm uninstall ${release} ${common}`, { env });
      if (r.code !== 0) return output(false, {}, r.stderr || r.stdout);
      return output(true, { stdout: r.stdout });
    }

    case 'helm.history': {
      const r = await exec(`helm history ${release} -o json ${common}`, { env });
      if (r.code !== 0) return output(false, {}, r.stderr || r.stdout);
      try { return output(true, { revisions: JSON.parse(r.stdout) }); }
      catch { return output(true, { raw: r.stdout }); }
    }

    case 'helm.list': {
      const r = await exec(`helm list -o json ${common}`, { env });
      if (r.code !== 0) return output(false, {}, r.stderr || r.stdout);
      try { return output(true, { releases: JSON.parse(r.stdout) }); }
      catch { return output(true, { raw: r.stdout }); }
    }

    default:
      return output(false, {}, `未知 helm action: ${action}`);
  }
}
