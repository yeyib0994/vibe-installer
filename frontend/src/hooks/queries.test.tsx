import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { qk } from "../api/endpoints";
import {
  useCreateEnv,
  useCreateFlow,
  useDeleteEnv,
  useDeleteFlow,
  useDeletePackage,
} from "./queries";
import { json, makeQc, wrapperOf } from "../test/fixtures";

/** 只放行 expect 的那一条请求，其它一律抛错：多打的请求不能被 stub 兜住。 */
function stubOnly(method: string, url: string) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const got = `${init?.method ?? "GET"} ${String(input)}`;
    if (got !== `${method} ${url}`) throw new Error(`未 stub 的请求: ${got}`);
    calls.push(got);
    return json(200, { ok: true, id: "p1" });
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

// 总览那份聚合计数（环境/流程/安装包，ApiController.java:831-845）此前没有任何 mutation 失效它，
// 而 queryClient 的 staleTime 是 5s：改完数据切回总览，最多 5 秒里显示的还是旧数字。
describe("变更类 hook 的失效范围", () => {
  const cases = [
    { title: "新建环境", method: "POST", url: "/api/environments", list: qk.envs,
      hook: useCreateEnv, vars: { name: "e1" } },
    { title: "删除环境", method: "DELETE", url: "/api/environments/e1", list: qk.envs,
      hook: useDeleteEnv, vars: "e1" },
    { title: "新建流程", method: "POST", url: "/api/flows", list: ["flows"],
      hook: useCreateFlow, vars: { name: "f1", env_id: "e1", mode: "install" as const } },
    { title: "删除流程", method: "DELETE", url: "/api/flows/f1", list: ["flows"],
      hook: useDeleteFlow, vars: "f1" },
    { title: "删除安装包", method: "DELETE", url: "/api/packages/p1", list: qk.packages,
      hook: useDeletePackage, vars: "p1" },
  ];

  for (const c of cases) {
    it(`${c.title}：既失效自己的列表，也失效总览`, async () => {
      stubOnly(c.method, c.url);
      const qc = makeQc();
      const spy = vi.spyOn(qc, "invalidateQueries");
      const { result } = renderHook(() => c.hook(), { wrapper: wrapperOf(qc) });

      await result.current.mutateAsync(c.vars as never);

      await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: c.list }));
      expect(spy).toHaveBeenCalledWith({ queryKey: qk.overview });
    });
  }

  it("请求失败时不失效任何查询（失败的删除不能把列表刷成已删）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(500, { detail: "只读文件系统" })));
    const qc = makeQc();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useDeletePackage(), { wrapper: wrapperOf(qc) });

    await expect(result.current.mutateAsync("p1")).rejects.toThrow();

    expect(spy).not.toHaveBeenCalled();
  });
});
