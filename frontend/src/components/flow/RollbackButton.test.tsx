import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RollbackButton } from "./RollbackButton";
import { ToastProvider } from "../ToastProvider";
import { qk } from "../../api/endpoints";
import { json } from "../../test/fixtures";

const URL = "/api/flows/f1/rollback";

let bodies: string[] = [];

/** 每次命中都调一次工厂，Response 绝不复用。 */
function stubFetch(replies: Array<() => Response>) {
  bodies = [];
  let n = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url !== URL || (init?.method ?? "POST") !== "POST") throw new Error(`未 stub 的请求: ${url}`);
    bodies.push(String(init?.body ?? ""));
    return replies[Math.min(n++, replies.length - 1)]();
  }));
}

const OK: Array<() => Response> = [() => json(200, { ok: true })];

function setup(qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } })) {
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <RollbackButton flowId="f1" releaseName="saas-web" />
      </ToastProvider>
    </QueryClientProvider>
  );
  return qc;
}

const revisionInput = () => screen.getByRole("spinbutton", { name: /目标 revision/ });

afterEach(() => vi.unstubAllGlobals());

describe("RollbackButton", () => {
  it("点按钮先开确认弹层，未确认不发请求", async () => {
    const user = userEvent.setup();
    stubFetch(OK);
    setup();
    await user.click(screen.getByRole("button", { name: "Helm 回滚" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("回滚 Helm Release · saas-web")).toBeInTheDocument();
    expect(within(dialog).getByText(/流程阶段状态不会被重置/)).toBeInTheDocument();
    expect(bodies).toHaveLength(0);
  });

  it("留空 = 上一版本：请求体不带 revision 键，成功后关弹层并刷新 flow", async () => {
    const user = userEvent.setup();
    stubFetch(OK);
    const qc = setup();
    const spy = vi.spyOn(qc, "invalidateQueries");
    await user.click(screen.getByRole("button", { name: "Helm 回滚" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "确认回滚" }));

    await waitFor(() => expect(bodies).toEqual(["{}"]));
    expect(await screen.findByText("Helm 回滚完成：saas-web")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(spy).toHaveBeenCalledWith({ queryKey: qk.flow("f1") });
  });

  it("填 7 就按 revision:7 回滚", async () => {
    const user = userEvent.setup();
    stubFetch(OK);
    setup();
    await user.click(screen.getByRole("button", { name: "Helm 回滚" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(revisionInput(), "7");
    await user.click(within(dialog).getByRole("button", { name: "确认回滚" }));
    await waitFor(() => expect(bodies).toEqual(['{"revision":7}']));
  });

  it("填 0 与留空同义（上一版本），不把 revision:0 发出去", async () => {
    const user = userEvent.setup();
    stubFetch(OK);
    setup();
    await user.click(screen.getByRole("button", { name: "Helm 回滚" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(revisionInput(), "0");
    await user.click(within(dialog).getByRole("button", { name: "确认回滚" }));
    await waitFor(() => expect(bodies).toEqual(["{}"]));
  });

  it("ok=false：toast 带上后端 error，弹层留在原地可重试", async () => {
    const user = userEvent.setup();
    stubFetch([() => json(200, { ok: false, error: 'helm: release "saas-web" not found' })]);
    setup();
    await user.click(screen.getByRole("button", { name: "Helm 回滚" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "确认回滚" }));

    expect(await screen.findByText(/回滚失败：helm: release/)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "确认回滚" })).toBeEnabled();

    // 失败后仍可再次提交
    await user.click(within(dialog).getByRole("button", { name: "确认回滚" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
  });

  it("HTTP 错误：toast 显示后端 detail，按钮恢复可用", async () => {
    const user = userEvent.setup();
    stubFetch([() => json(404, { detail: "流程不存在" })]);
    setup();
    await user.click(screen.getByRole("button", { name: "Helm 回滚" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "确认回滚" }));
    expect(await screen.findByText("流程不存在")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("pending 期间按钮禁用，重复点击只发一次请求", async () => {
    const user = userEvent.setup();
    let resolve!: (r: Response) => void;
    const gate = new Promise<Response>((r) => { resolve = r; });
    bodies = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      bodies.push(String(input));
      return gate;
    }));
    setup();
    await user.click(screen.getByRole("button", { name: "Helm 回滚" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "确认回滚" }));

    const pending = await within(dialog).findByRole("button", { name: "回滚中…" });
    expect(pending).toBeDisabled();
    await user.click(pending);
    expect(bodies).toHaveLength(1);

    resolve(json(200, { ok: true }));
    expect(await screen.findByText("Helm 回滚完成：saas-web")).toBeInTheDocument();
  });
});
