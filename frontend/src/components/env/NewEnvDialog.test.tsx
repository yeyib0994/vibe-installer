import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NewEnvDialog } from "./NewEnvDialog";
import { ToastProvider } from "../ToastProvider";
import type { Environment } from "../../api/types";

// 每次调用现造 Response：共享同一个 Response 会让顺序 fetch 抛 Body is unusable。
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const createdEnv: Environment = {
  id: "env-9", name: "生产-AZ1", description: "描述", base_domain: "saas.internal.com",
  ntp_server: "ntp.internal.com", dns_servers: [], timezone: "Asia/Shanghai", nodes: [],
  validated: false, validation_issues: [], created_at: "2026-10-04T10:00:00",
  updated_at: "2026-10-04T10:00:00",
};

let fetchMock: ReturnType<typeof vi.fn>;

function setup(onCreated = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <NewEnvDialog open onClose={() => {}} onCreated={onCreated} />
      </ToastProvider>
    </QueryClientProvider>
  );
  return onCreated;
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NewEnvDialog", () => {
  it("环境名称为空时提交：提示必填且不发起请求", async () => {
    const user = userEvent.setup();
    const onCreated = setup();
    await user.click(screen.getByRole("button", { name: "创建" }));
    expect(await screen.findByText("环境名称必填")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("仅空格的名称同样被拦截", async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByPlaceholderText("生产-AZ1"), "   ");
    await user.click(screen.getByRole("button", { name: "创建" }));
    expect(await screen.findByText("环境名称必填")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("成功提交：POST 剥离空白的名称、DNS 按行切成数组，并回调 onCreated(id)", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async () => json(200, createdEnv));
    const onCreated = setup();

    await user.type(screen.getByPlaceholderText("生产-AZ1"), " 生产-AZ1 ");
    await user.type(screen.getByPlaceholderText("saas.internal.com"), "saas.internal.com");
    await user.type(screen.getByPlaceholderText("ntp.internal.com"), "ntp.internal.com");
    await user.type(screen.getByPlaceholderText(/10\.0\.0\.10/), "10.0.0.10\n10.0.0.11\n");
    await user.click(screen.getByRole("button", { name: "创建" }));

    expect(await screen.findByText("环境「生产-AZ1」已创建")).toBeInTheDocument();
    expect(onCreated).toHaveBeenCalledWith("env-9");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/environments");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      name: "生产-AZ1",
      description: "",
      base_domain: "saas.internal.com",
      ntp_server: "ntp.internal.com",
      timezone: "Asia/Shanghai",
      dns_servers: ["10.0.0.10", "10.0.0.11"],
    });
  });

  it("后端 400 返回 detail：toast 展示后端消息且不回调 onCreated", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async () => json(400, { detail: "环境名称已存在" }));
    const onCreated = setup();

    await user.type(screen.getByPlaceholderText("生产-AZ1"), "重复环境");
    await user.click(screen.getByRole("button", { name: "创建" }));

    expect(await screen.findByText("环境名称已存在")).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("后端 422 顶层 {errors,message}：toast 展示 message", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async () => json(422, { errors: ["名称非法"], message: "校验未通过" }));
    setup();

    await user.type(screen.getByPlaceholderText("生产-AZ1"), "x");
    await user.click(screen.getByRole("button", { name: "创建" }));

    expect(await screen.findByText("校验未通过")).toBeInTheDocument();
  });
});
