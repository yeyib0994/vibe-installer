type MessageHandler = (e: MessageEvent) => void;

/**
 * EventSource 测试替身 —— 只实现 useStageStream 实际依赖的能力：
 * onmessage / onerror / close() 与实例登记。
 * 服务端（ApiController.java:404）发送的全部是无名 message 帧（SseEmitter.event().data(...)，从不 .name()），
 * 故替身只走 onmessage 通道即可复现真实形态；不提供 readyState/CONNECTING，
 * 因为降级轮询由 onerror 驱动、不读取连接状态。
 */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];

  url: string;
  onmessage: MessageHandler | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  /** 模拟一帧默认 message 事件（data 为 JSON 载荷）。 */
  emit(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  /** 模拟一次传输层错误（浏览器随即自动重连，服务端会重放全部历史）。 */
  fail(): void {
    this.onerror?.({});
  }
}

export const resetFakeES = (): void => {
  FakeEventSource.instances = [];
};
