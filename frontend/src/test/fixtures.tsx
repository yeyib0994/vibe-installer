import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * 每次调用现造 Response：复用同一 Response 会让下一次读体抛
 * 「Body is unusable」，于是一组测试里第二个断言就在读空流。
 */
export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** 测试用 QueryClient：retry 必须为 0 —— 失败请求会重投到未 stub 的 fetch 上，把「未 stub 的请求」吞成超时。 */
export const makeQc = () => new QueryClient({ defaultOptions: { queries: { retry: 0 } } });

export const wrapperOf = (qc: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
