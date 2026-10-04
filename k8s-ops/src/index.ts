import { output } from './config';
import { handleHelm } from './helm';
import { handlePod } from './pod';
import { handleBackup } from './backup';
import { handleSmoke } from './smoke';

/** CLI 入口：从 stdin 读取 JSON {action, ...}，按 action 分发。 */
async function main() {
  let raw = '';
  try {
    raw = await readStdin();
  } catch (e: any) {
    return output(false, {}, `读取 stdin 失败: ${e.message}`);
  }

  let input: any;
  try {
    input = JSON.parse(raw);
  } catch (e: any) {
    return output(false, {}, `JSON 解析失败: ${e.message}`);
  }

  const action: string = input.action || '';
  try {
    if (action.startsWith('helm.')) return await handleHelm(action, input);
    if (action.startsWith('pod.')) return await handlePod(action, input);
    if (action.startsWith('backup.')) return await handleBackup(action, input);
    if (action.startsWith('smoke.')) return await handleSmoke(action, input);
    return output(false, {}, `未知 action: ${action}`);
  } catch (e: any) {
    return output(false, {}, `${action} 执行异常: ${e.message}`);
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => data += c);
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

main();
