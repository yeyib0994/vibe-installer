import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
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

/** 输出上限：与原 exec 的 maxBuffer 同值，超限即杀进程，避免无界内存。 */
const MAX_OUTPUT = 50 * 1024 * 1024;

/**
 * 执行命令：参数按 argv 数组交给 spawn，绝不经过 shell。
 * 原因：namespace / release_name / chart 这些都是用户在集群页与阶段表单里填的字符串，
 * 拼成一条 shell 命令字符串就等于把命令构造权交给了输入值（`; rm -rf` 之类）。
 * 代价：Windows 上需要真 .exe（`helm.cmd`/`kubectl.cmd` 这类垫片无法不经 shell 启动）；
 * 生产是 Linux 镜像，不受影响。
 */
export function exec(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...opts.env } });
    let stdout = '';
    let stderr = '';
    let killed = '';
    const timer = setTimeout(() => {
      killed = `命令超时被终止（${opts.timeout || 120000}ms）`;
      child.kill();
    }, opts.timeout || 120000);

    child.stdout.on('data', (c) => {
      stdout += c;
      if (stdout.length > MAX_OUTPUT) { killed = '输出超过 50MB 上限'; child.kill(); }
    });
    child.stderr.on('data', (c) => {
      stderr += c;
      if (stderr.length > MAX_OUTPUT) { killed = '输出超过 50MB 上限'; child.kill(); }
    });

    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${cmd} 启动失败: ${e.message}` });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (killed) resolve({ code: 1, stdout, stderr: stderr || killed });
      else resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** 统一输出 JSON 并退出。 */
export function output(ok: boolean, data: any, error?: string) {
  const result = ok ? { ok: true, data } : { ok: false, error: error || String(data) };
  process.stdout.write(JSON.stringify(result, null, 0) + '\n');
  process.exit(ok ? 0 : 1);
}
