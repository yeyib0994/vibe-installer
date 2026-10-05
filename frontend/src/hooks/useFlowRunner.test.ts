import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useFlowRunner } from "./useFlowRunner";
import { useFlow } from "./queries";
import { qk } from "../api/endpoints";
import { json, makeQc, wrapperOf } from "../test/fixtures";
import type { EnvSummary, FlowDetail, FlowStage, FormField } from "../api/types";

const numField = (over: Partial<FormField> = {}): FormField => ({
  key: "chunk_size", label: "分片大小 MB", type: "number", required: false,
  placeholder: "", help: "", hint: "", ...over,
});

const stageOf = (over: Partial<FlowStage> = {}): FlowStage => ({
  key: "upload", index: 1, title: "上传安装包", description: "",
  form_fields: [numField({ default: 8 })],
  inputs: { _package_id: "pk1", _package_ids: ["pk1"], chunk_size: 8 },
  required: true, status: "ready", steps: [], ...over,
});

const summary: EnvSummary = { total: 0, by_role: {}, by_type: {}, physical: 0, virtual: 0 };

const flowDetail = (stages: FlowStage[]): FlowDetail => ({
  id: "f1", name: "生产-AZ1 安装", env_id: "e1", mode: "install", status: "running",
  stages, current_stage: 0, operator: "admin",
  created_at: "2026-10-04T12:00:00", updated_at: "2026-10-04T12:00:00",
  progress: { done: 0, total: stages.length },
  env_name: "生产-AZ1", env_summary: summary, nodes: [],
});

const hookOf = (flow: FlowDetail, qc = makeQc()) =>
  renderHook((f: FlowDetail) => useFlowRunner(f), { wrapper: wrapperOf(qc), initialProps: flow });

/** 让在途请求跑进 pending：真实 macrotask（禁用假定时器 —— React 19 下会死锁 await）。 */
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

interface Call { url: string; method: string; body: Record<string, unknown> }

/**
 * stub validate/inputs/run/skip/cancel 五个写端点。
 * 每次调用现造 Response —— 复用同一 Response 会让第二次读体抛 Body is unusable。
 */
function stubRunnerFetch(opts: { valid?: boolean; errors?: string[]; inputsStatus?: number; gate?: Promise<void> } = {}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ url, method, body });
    if (url.endsWith("/validate")) return json(200, { valid: opts.valid ?? true, errors: opts.errors ?? [] });
    if (url.endsWith("/inputs")) {
      await opts.gate;
      const status = opts.inputsStatus ?? 200;
      return status === 200
        ? json(200, { ok: true, inputs: body.inputs ?? {}, nodes: 1 })
        : json(status, { errors: opts.errors ?? [], message: "数据校验未通过" });
    }
    if (url.endsWith("/run")) return json(200, { ok: true, stage: "upload", status: "running" });
    if (url.endsWith("/skip")) return json(200, { ok: true, stage: stageOf() });
    if (url.endsWith("/cancel")) return json(200, { ok: true });
    throw new Error(`未 stub 的请求: ${method} ${url}`);
  }));
  return calls;
}

const inputsOf = (calls: Call[], suffix: string) => calls.find((c) => c.url.endsWith(suffix))?.body.inputs;

describe("useFlowRunner 草稿归属：只在切阶段时重播种", () => {
  it("切走再切回不保留废弃草稿，同名字段的两阶段互不串值", () => {
    const upload = stageOf();
    const distribute = stageOf({
      key: "distribute", index: 2, title: "分发安装包",
      form_fields: [numField({ default: 16 })], inputs: { _distribution_id: "d0" },
    });
    const { result } = hookOf(flowDetail([upload, distribute]));

    expect(result.current.activeKey).toBe("upload");
    expect(result.current.values).toEqual({ chunk_size: 8 });

    act(() => result.current.setValue("chunk_size", "99"));
    expect(result.current.values.chunk_size).toBe("99");

    // 侧栏整行都能点：再点当前阶段不算切换，草稿不能被抹掉
    act(() => result.current.select("upload"));
    expect(result.current.values.chunk_size).toBe("99");

    // 切到字段名完全相同的另一阶段：只拿到它自己的 default，绝不带 upload 的草稿
    act(() => result.current.select("distribute"));
    expect(result.current.values).toEqual({ chunk_size: 16 });

    // 切回来按 upload 的 inputs 重新播种，废弃草稿不复活
    act(() => result.current.select("upload"));
    expect(result.current.values).toEqual({ chunk_size: 8 });
  });

  it("轮询刷新产出全新 inputs 对象时不抹掉正在输入的值", () => {
    const { result, rerender } = hookOf(flowDetail([stageOf()]));
    act(() => result.current.setValue("chunk_size", "99"));
    // useFlow 在有 running 阶段时每 1.2s 轮询：整棵 flow 树（含 stage.inputs）都是新引用
    rerender(flowDetail([stageOf({ inputs: { _package_id: "pk1", _package_ids: ["pk1"], chunk_size: 8 } })]));
    expect(result.current.values.chunk_size).toBe("99");
    expect(result.current.activeKey).toBe("upload");
  });

  it("setValue 清掉上一轮的 fieldErrors", async () => {
    const calls = stubRunnerFetch({ valid: false, errors: ["分片大小 MB 必须是数字"] });
    const { result } = hookOf(flowDetail([stageOf()]));
    await act(async () => {
      await result.current.run();
    });

    expect(result.current.fieldErrors).toEqual(["分片大小 MB 必须是数字"]);
    expect(calls.some((c) => c.url.endsWith("/inputs"))).toBe(false);

    act(() => result.current.setValue("chunk_size", 9));
    expect(result.current.fieldErrors).toEqual([]);
  });
});

describe("useFlowRunner 初始落点", () => {
  const initialKey = (stages: FlowStage[]) => hookOf(flowDetail(stages)).result.current.activeKey;

  it("running > failed > ready > 未完成，全部通过则兜底首阶段", () => {
    expect(initialKey([stageOf({ key: "a" }), stageOf({ key: "b", index: 2, status: "running" }), stageOf({ key: "c", index: 3, status: "ready" })])).toBe("b");
    expect(initialKey([stageOf({ key: "a", status: "passed" }), stageOf({ key: "b", index: 2, status: "failed" }), stageOf({ key: "c", index: 3, status: "ready" })])).toBe("b");
    expect(initialKey([stageOf({ key: "a", status: "passed" }), stageOf({ key: "b", index: 2, status: "locked" }), stageOf({ key: "c", index: 3, status: "ready" })])).toBe("c");
    // 全通过：没有任何未完成阶段时兜底回首阶段
    expect(initialKey([stageOf({ key: "a", status: "passed" }), stageOf({ key: "b", index: 2, status: "skipped" })])).toBe("a");
  });

  it("空 stages 不崩：activeKey 回空串、无下一步", () => {
    const { result } = hookOf(flowDetail([]));
    expect(result.current.activeKey).toBe("");
    expect(result.current.values).toEqual({});
    expect(result.current.nextReady).toBeUndefined();
  });

  it("nextReady 只认当前阶段之后的 ready/failed，跳过已通过与未解锁", () => {
    const { result } = hookOf(flowDetail([
      stageOf({ key: "a", status: "running" }),
      stageOf({ key: "b", index: 2, status: "passed" }),
      stageOf({ key: "c", index: 3, status: "locked" }),
      stageOf({ key: "d", index: 4, status: "failed" }),
    ]));
    // 起点是 running 的 a；passed 已完成、locked 不可执行，第一个可推进的是 failed 的 d
    expect(result.current.activeKey).toBe("a");
    expect(result.current.nextReady?.key).toBe("d");
  });
});

describe("useFlowRunner run：validate → submit inputs → run", () => {
  it("提交 {...stage.inputs, ...collected}（I3），成功后按实收值回显", async () => {
    const calls = stubRunnerFetch();
    const { result } = hookOf(flowDetail([stageOf()]));
    act(() => result.current.setValue("chunk_size", "99"));

    await act(async () => {
      await expect(result.current.run()).resolves.toBe(true);
    });

    const merged = { _package_id: "pk1", _package_ids: ["pk1"], chunk_size: 99 };
    expect(inputsOf(calls, "/validate")).toEqual(merged);
    expect(inputsOf(calls, "/inputs")).toEqual(merged);
    expect(calls.find((c) => c.url.endsWith("/run"))?.body).toEqual({ operator: "admin" });
    // 所见即所存：表单按刚被收下的那份 inputs 回显（含服务端下划线键）
    expect(result.current.values).toEqual(merged);
    expect(result.current.busy).toBe(false);
  });

  it("留空的可选 number 提交 null 而不是空串（契约校正 8）", async () => {
    const calls = stubRunnerFetch();
    const { result } = hookOf(flowDetail([stageOf()]));
    act(() => result.current.setValue("chunk_size", "   "));

    await act(async () => {
      await result.current.run();
    });

    expect(inputsOf(calls, "/inputs")).toEqual({ _package_id: "pk1", _package_ids: ["pk1"], chunk_size: null });
  });

  it("validate 不过：不提交 inputs、不启动执行，错误进 fieldErrors", async () => {
    const calls = stubRunnerFetch({ valid: false, errors: ["分片大小 MB 必须是数字"] });
    const { result } = hookOf(flowDetail([stageOf()]));

    await act(async () => {
      await expect(result.current.run()).resolves.toBe(false);
    });

    expect(result.current.fieldErrors).toEqual(["分片大小 MB 必须是数字"]);
    expect(calls.map((c) => c.url)).toEqual(["/api/flows/f1/stages/upload/validate"]);
    expect(result.current.busy).toBe(false);
  });

  it("inputs 回 422：后端字段错误落地，run 端点不被调用", async () => {
    const calls = stubRunnerFetch({ inputsStatus: 422, errors: ["目标角色为必填项"] });
    const { result } = hookOf(flowDetail([stageOf()]));

    await act(async () => {
      await expect(result.current.run()).resolves.toBe(false);
    });

    expect(result.current.fieldErrors).toEqual(["目标角色为必填项"]);
    expect(calls.some((c) => c.url.endsWith("/run"))).toBe(false);
  });

  it("在途提交返回时若已切走，不把上一阶段的实收值灌进新阶段", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const calls = stubRunnerFetch({ gate });
    const { result } = hookOf(flowDetail([
      stageOf(),
      stageOf({ key: "distribute", index: 2, form_fields: [numField({ default: 16 })], inputs: { _distribution_id: "d0" } }),
    ]));

    let runPromise: Promise<boolean> | undefined;
    act(() => {
      runPromise = result.current.run();
    });
    await flush();
    expect(calls.some((c) => c.url.endsWith("/inputs"))).toBe(true);
    expect(result.current.busy).toBe(true);

    act(() => result.current.select("distribute"));
    expect(result.current.values).toEqual({ chunk_size: 16 });

    release();
    await act(async () => {
      await runPromise;
    });

    expect(result.current.activeKey).toBe("distribute");
    expect(result.current.values).toEqual({ chunk_size: 16 });
    expect(result.current.busy).toBe(false);
  });
});

describe("useFlowRunner skip / cancel", () => {
  it("两个写操作都打到对应端点并刷新 flow 与阶段日志", async () => {
    const calls = stubRunnerFetch();
    const qc = makeQc();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = hookOf(flowDetail([stageOf()]), qc);

    await act(async () => {
      await result.current.skip();
    });
    const skipCall = calls.find((c) => c.url.endsWith("/skip"));
    expect(skipCall?.method).toBe("POST");
    expect(skipCall?.body).toEqual({ operator: "admin" });

    await act(async () => {
      await result.current.cancel();
    });
    expect(calls.some((c) => c.url === "/api/flows/f1/stages/upload/cancel")).toBe(true);
    expect(spy).toHaveBeenCalledWith({ queryKey: ["flows", "detail", "f1"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["flows", "f1", "stages", "upload", "logs"] });
  });

  it("cancel 返回 ok=false 时不崩，仍刷新 flow", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/cancel") ? json(200, { ok: false }) : json(200, {})));
    const qc = makeQc();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = hookOf(flowDetail([stageOf()]), qc);

    await act(async () => {
      await result.current.cancel();
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["flows", "detail", "f1"] });
  });
});

describe("useFlowRunner onStreamDone：推进只认刷新落定后的 flow", () => {
  it("缓存里没有更新就不推进，留在已结束的阶段", async () => {
    // props 快照里下一阶段已是 ready：若照闭包里的旧数据推进就违反了规则
    const { result } = hookOf(flowDetail([
      stageOf({ key: "a", status: "running" }),
      stageOf({ key: "b", index: 2, status: "ready" }),
    ]));
    act(() => result.current.onStreamDone("a", "passed", null));
    await flush();
    expect(result.current.activeKey).toBe("a");
  });

  it("刷新后的下一个 ready 命中就推进，并按该阶段在缓存里的 inputs 播种", async () => {
    const qc = makeQc();
    qc.setQueryData(qk.flow("f1"), flowDetail([
      stageOf({ key: "a", status: "passed" }),
      stageOf({
        key: "b", index: 2, title: "分发安装包", status: "ready",
        form_fields: [numField({ default: 16 })], inputs: { _distribution_id: "d9", chunk_size: 4 },
      }),
    ]));
    // props 快照仍旧：b 在快照里是 locked（据此推进推不到），只有缓存里才是 ready
    const { result } = hookOf(flowDetail([
      stageOf({ key: "a", status: "running" }),
      stageOf({ key: "b", index: 2, status: "locked" }),
    ]), qc);
    expect(result.current.activeKey).toBe("a");

    act(() => result.current.onStreamDone("a", "passed", null));
    await flush();
    expect(result.current.activeKey).toBe("b");
    expect(result.current.values).toEqual({ chunk_size: 4 });
  });

  it("failed 不推进，但仍刷新 flow", async () => {
    const qc = makeQc();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = hookOf(flowDetail([
      stageOf({ key: "a", status: "running" }),
      stageOf({ key: "b", index: 2, status: "ready" }),
    ]), qc);

    act(() => result.current.onStreamDone("a", "failed", "端口 6443 不可达"));
    expect(spy).toHaveBeenCalledWith({ queryKey: ["flows", "detail", "f1"] });
    await flush();
    expect(result.current.activeKey).toBe("a");
  });

  it("来源 key 不是当前阶段就整个忽略：A 的完成不能作用于 B", () => {
    // 用户点了已通过的 A 切到 B，A 那条还没关的流在此期间下发 stage_done ——
    // 回调闭包里的 stage 已是 B，不认来源就会给 B 弹「通过」并把向导从 B 推进走。
    const qc = makeQc();
    qc.setQueryData(qk.flow("f1"), flowDetail([
      stageOf({ key: "a", status: "passed" }),
      stageOf({ key: "b", index: 2, status: "ready", form_fields: [numField({ default: 16 })], inputs: { chunk_size: 4 } }),
      stageOf({ key: "c", index: 3, status: "ready" }),
    ]));
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = hookOf(flowDetail([
      stageOf({ key: "a", status: "running" }),
      stageOf({ key: "b", index: 2, status: "ready" }),
      stageOf({ key: "c", index: 3, status: "locked" }),
    ]), qc);

    act(() => result.current.select("b"));
    expect(result.current.activeKey).toBe("b");

    spy.mockClear();
    act(() => result.current.onStreamDone("a", "passed", null));
    expect(result.current.activeKey).toBe("b");
    expect(result.current.values).toEqual({ chunk_size: 8 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("来源 key 与当前阶段一致时照常处理（守卫不能把正常回调一起拦掉）", async () => {
    const qc = makeQc();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = hookOf(flowDetail([
      stageOf({ key: "a", status: "running" }),
      stageOf({ key: "b", index: 2, status: "ready" }),
    ]), qc);

    act(() => result.current.select("b"));
    spy.mockClear();
    act(() => result.current.onStreamDone("b", "failed", "端口 6443 不可达"));
    expect(spy).toHaveBeenCalledWith({ queryKey: ["flows", "detail", "f1"] });
    await flush();
    expect(result.current.activeKey).toBe("b");
  });

  it("推进发生在重取落定之后：解锁由重取写回缓存，同步读旧快照必然空转", async () => {
    const stale = flowDetail([
      stageOf({ key: "a", status: "running" }),
      stageOf({ key: "b", index: 2, status: "locked" }),
    ]);
    const fresh = flowDetail([
      stageOf({ key: "a", status: "passed" }),
      stageOf({
        key: "b", index: 2, title: "分发安装包", status: "ready",
        form_fields: [numField({ default: 16 })], inputs: { chunk_size: 4 },
      }),
    ]);
    // 服务端只在阶段结束后才把 b 解锁：首次 GET 给旧状态，失效引发的重取才给新状态
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/flows/f1") {
        reads += 1;
        return json(200, reads === 1 ? stale : fresh);
      }
      throw new Error(`未 stub 的请求: GET ${url}`);
    }));

    const qc = makeQc();
    // 必须真实挂载 flow 详情查询：没有观察者时 invalidateQueries 不会重取，缓存永远停在旧快照
    const { result } = renderHook(
      (f: FlowDetail) => {
        useFlow(f.id);
        return useFlowRunner(f);
      },
      { wrapper: wrapperOf(qc), initialProps: stale },
    );
    await flush();
    expect(qc.getQueryData<FlowDetail>(qk.flow("f1"))?.stages[1].status).toBe("locked");

    act(() => result.current.onStreamDone("a", "passed", null));
    // 重取还没落定，此刻缓存仍是阶段结束前的快照 —— 这里推进就是读旧状态
    expect(result.current.activeKey).toBe("a");

    await waitFor(() => expect(result.current.activeKey).toBe("b"));
    expect(result.current.values).toEqual({ chunk_size: 4 });
    expect(reads).toBe(2);
  });

  it("等重取期间用户切了阶段就放弃推进：A 的落定不能把 B 的草稿换掉", async () => {
    const qc = makeQc();
    qc.setQueryData(qk.flow("f1"), flowDetail([
      stageOf({ key: "a", status: "passed" }),
      stageOf({ key: "b", index: 2, status: "ready", form_fields: [numField({ default: 16 })], inputs: { chunk_size: 4 } }),
      stageOf({ key: "c", index: 3, status: "ready" }),
    ]));
    const { result } = hookOf(flowDetail([
      stageOf({ key: "a", status: "running" }),
      stageOf({ key: "b", index: 2, status: "ready" }),
      stageOf({ key: "c", index: 3, status: "locked" }),
    ]), qc);

    act(() => result.current.onStreamDone("a", "passed", null));
    act(() => result.current.select("b"));
    await flush();

    // 推进的落点本来就是 b，但 goTo 会按缓存重新播种（chunk_size 4）；
    // 守卫生效时 b 用的是 props 的草稿（chunk_size 8），切回来的手不受异步回调干扰。
    expect(result.current.activeKey).toBe("b");
    expect(result.current.values).toEqual({ chunk_size: 8 });
  });
});
