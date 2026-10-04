import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KubeConfig } from '@kubernetes/client-node';

/** 解析输入中的 kubeconfig。
 *  优先级: 显式文件路径 > base64 内容 > 环境变量 KUBECONFIG > 默认 ~/.kube/config
 *  若均不可用，返回空字符串（调用方应使用集群内 ServiceAccount）。
 */
export function resolveKubeconfig(input: any): string {
  if (input.kubeconfig) {
    const v = String(input.kubeconfig);
    // 判断是路径还是 base64 内容：路径以 / 或 ~ 开头，或文件存在
    if (v.startsWith('/') || v.startsWith('~') || v.match(/^[A-Za-z]:[\\/]/) || fs.existsSync(v)) {
      return v.startsWith('~') ? v.replace('~', os.homedir()) : v;
    }
    // 否则当作 base64 内容，写入临时文件
    const tmp = path.join(os.tmpdir(), `kubeconfig-${process.pid}.yaml`);
    fs.writeFileSync(tmp, Buffer.from(v, 'base64').toString('utf8'), { mode: 0o600 });
    return tmp;
  }
  if (process.env.KUBECONFIG && fs.existsSync(process.env.KUBECONFIG)) return process.env.KUBECONFIG;
  const def = path.join(os.homedir(), '.kube', 'config');
  return fs.existsSync(def) ? def : '';
}

/** 构造 @kubernetes/client-node 的 KubeConfig 对象。 */
export function loadKc(kubeconfigPath: string): KubeConfig {
  const kc = new KubeConfig();
  if (fs.existsSync(kubeconfigPath)) {
    kc.loadFromFile(kubeconfigPath);
  } else {
    kc.loadFromDefault();
  }
  return kc;
}

/** 执行命令，返回 stdout/stderr。 */
export function exec(cmd: string, opts: { env?: NodeJS.ProcessEnv; timeout?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const { exec: cpExec } = require('child_process');
    cpExec(cmd, {
      env: { ...process.env, ...opts.env },
      timeout: opts.timeout || 120000,
      maxBuffer: 50 * 1024 * 1024,
    }, (err: any, stdout: string, stderr: string) => {
      resolve({ code: err ? err.code || 1 : 0, stdout, stderr });
    });
  });
}

/** 统一输出 JSON 并退出。 */
export function output(ok: boolean, data: any, error?: string) {
  const result = ok ? { ok: true, data } : { ok: false, error: error || String(data) };
  process.stdout.write(JSON.stringify(result, null, 0) + '\n');
  process.exit(ok ? 0 : 1);
}
