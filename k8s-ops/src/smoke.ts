import * as http from 'http';
import { resolveKubeconfig, exec, output } from './config';

/** 冒烟测试：通过 port-forward 或 Service ClusterIP 访问 HTTP 接口。 */
export async function handleSmoke(action: string, input: any) {
  switch (action) {
    case 'smoke.http': {
      const url = input.url;
      const timeout = input.timeout || 10000;
      if (!url) return output(false, {}, '缺少 url');

      const status = await httpGet(url, timeout);
      if (status.ok) return output(true, { status_code: status.code, body: status.body?.slice(0, 500) });
      return output(false, { status_code: status.code }, status.error || '请求失败');
    }

    case 'smoke.port_forward': {
      // 启动 port-forward 并返回端口（供后续 smoke.http 使用）
      const kcPath = resolveKubeconfig(input);
      const ns = input.namespace || 'default';
      const target = input.target; // e.g. svc/my-release
      const localPort = input.local_port || 18080;
      const remotePort = input.remote_port || 80;
      if (!target) return output(false, {}, '缺少 target');

      const { spawn } = require('child_process');
      const args = ['port-forward', target, `${localPort}:${remotePort}`, '-n', ns];
      if (kcPath) args.push('--kubeconfig', kcPath);
      const child = spawn('kubectl', args);
      // 等待端口就绪
      await new Promise(r => setTimeout(r, 3000));
      if (child.killed) return output(false, {}, 'port-forward 启动失败');
      // 不退出进程，让 Java 侧管理生命周期（这里返回 PID）
      return output(true, { local_port: localPort, pid: child.pid });
    }

    default:
      return output(false, {}, `未知 smoke action: ${action}`);
  }
}

function httpGet(url: string, timeout: number): Promise<{ ok: boolean; code?: number; body?: string; error?: string }> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => resolve({ ok: res.statusCode! >= 200 && res.statusCode! < 400, code: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}
