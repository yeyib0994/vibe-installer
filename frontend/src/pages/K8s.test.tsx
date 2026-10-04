import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import K8s, { releaseError } from "./K8s";
import { ToastProvider } from "../components/ToastProvider";
import { qk } from "../api/endpoints";
import type { K8sCluster } from "../api/types";

// 每次调用现造 Response：复用同一 Response 会让顺序 fetch 抛 Body is unusable。
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const cluster = (over: Partial<K8sCluster> = {}): K8sCluster => ({
  id: "k8s-0f872ce7", name: "prod-hz-01", kubeconfig: "", namespace: "shipdesk",
  context: "", created_at: "2026-10-04T19:21:30.2302941", ...over,
});

/** 真机抓到的 /releases 失败体原文（后端 CWD=backend-java/，K8S_OPS 相对 CWD 解析不到，node 把整坨栈塞进 error）。 */
const STACK =
  "node:internal/modules/cjs/loader:1520\n  throw err;\n  ^\n\n" +
  "Error: Cannot find module 'E:\\Yeyib0\\vibe-installer\\backend-java\\k8s-ops\\dist\\index.js'\n" +
  "    at Module._resolveFilename (node:internal/modules/cjs/loader:1517:15)\n" +
  "    at wrapResolveFilename (node:internal/modules/cjs/loader:1071:27)\n" +
  "    at defaultResolveImplForCJSLoading (node:internal/modules/cjs/loader:1095:10)\n" +
  "    at resolveForCJSWithHooks (node:internal/modules/cjs/loader:1122:12)\n" +
  "    at Module._load (node:internal/modules/cjs/loader:1294:5)\n" +
  "    at wrapModuleLoad (node:internal/modules/cjs/loader:255:19)\n" +
  "    at Module.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:154:5)\n" +
  "    at node:internal/main/run_main_module:33:47 {\n" +
  "  code: 'MODULE_NOT_FOUND',\n  requireStack: []\n}\n\nNode.js v24.19.0";

const RELEASE = {
  name: "saas-web", namespace: "shipdesk", revision: 3, status: "deployed",
  chart: "web-1.2.3", app_version: "1.2.3",
};

const RELEASES_URL = "/api/k8s/clusters/k8s-0f872ce7/releases";

type Handler = (url: string, method: string, body?: string) => Response | Promise<Response> | undefined;

let fetchMock: ReturnType<typeof vi.fn>;

function stub(handler: Handler) {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const res = handler(url, method, init?.body == null ? undefined : String(init.body));
    if (!res) throw new Error(`未 stub 的请求: ${method} ${url}`);
    return res;
  });
  vi.stubGlobal("fetch", fetchMock);
}

/** 集群列表的默认 stub；rows 用回调，方便模拟「后端已改数据」后的重新拉取。 */
function stubList(rows: () => K8sCluster[], extra: Handler = () => undefined) {
  stub((url, method, body) => {
    if (url === "/api/k8s/clusters" && method === "GET") return json(200, rows());
    return extra(url, method, body);
  });
}

const LocationDump = () => <span data-testid="location">{`${useLocation().pathname}${useLocation().search}`}</span>;

function setup(initialEntry = "/k8s") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/k8s" element={<K8s />} />
            <Route path="/flows" element={<div>流程列表页</div>} />
          </Routes>
          <LocationDump />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
  return { invalidate };
}

/** 挂起的请求：先断言 pending 态 UI，resolve 后再断言终态。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** 行内断言：集群名也会出现在弹窗/toast 里，只认表格内的那一处。 */
function rowOf(name: string) {
  const row = screen
    .getAllByText(name)
    .map((el) => el.closest("tr"))
    .find((tr): tr is HTMLTableRowElement => tr !== null && tr.closest("table") !== null);
  if (!row) throw new Error(`未找到「${name}」所在行`);
  return within(row);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("K8s 集群页", () => {
  it("首屏加载显示占位行，不误报「尚未登记集群」", async () => {
    const d = deferred<Response>();
    stub((url, method) => (url === "/api/k8s/clusters" && method === "GET" ? d.promise : undefined));
    setup();
    expect(await screen.findByText("加载集群清单…")).toBeInTheDocument();
    expect(screen.queryByText(/尚未登记集群/)).not.toBeInTheDocument();
    d.resolve(json(200, []));
    expect(await screen.findByText(/尚未登记集群/)).toBeInTheDocument();
    expect(screen.queryByText("加载集群清单…")).not.toBeInTheDocument();
  });

  it("加载完成后的空列表给出空态文案（含默认 KUBECONFIG 说明）", async () => {
    stubList(() => []);
    setup();
    expect(
      await screen.findByText("尚未登记集群。upgrade_k8s 流程可留空 kubeconfig 使用默认 KUBECONFIG"),
    ).toBeInTheDocument();
  });

  it("渲染集群行：名称、id、命名空间、context、fmtDate 创建时间与三个操作", async () => {
    stubList(() => [cluster({ kubeconfig: "/home/ops/.kube/config", context: "prod-hz" })]);
    setup();
    await screen.findByText("prod-hz-01");
    const row = rowOf("prod-hz-01");
    expect(row.getByText("k8s-0f872ce7")).toBeInTheDocument();
    expect(row.getByText("shipdesk")).toBeInTheDocument();
    expect(row.getByText("prod-hz")).toBeInTheDocument();
    expect(row.getByText("/home/ops/.kube/config")).toBeInTheDocument();
    expect(row.getByText("2026-10-04")).toBeInTheDocument();
    expect(row.getByRole("button", { name: "Helm Release" })).toBeInTheDocument();
    expect(row.getByRole("button", { name: "建升级流程" })).toBeInTheDocument();
    expect(row.getByRole("button", { name: "删除" })).toBeInTheDocument();
    // 登记表并非流程的执行来源：这条诚实说明必须写在页面上
    expect(screen.getByText(/不读这张登记表/)).toBeInTheDocument();
  });

  it("kubeconfig 是粘贴进来的整份文档：只显示首行，全文不外泄", async () => {
    stubList(() => [cluster({
      kubeconfig: "apiVersion: v1\nclusters:\n- cluster:\n    server: https://10.0.0.5:6443\nkind: Config",
    })]);
    setup();
    await screen.findByText("prod-hz-01");
    const cell = rowOf("prod-hz-01").getByText("apiVersion: v1");
    expect(cell).toHaveAttribute("title", "apiVersion: v1");
    expect(screen.queryByText(/server: https:\/\/10\.0\.0\.5/)).not.toBeInTheDocument();
    expect(screen.queryByText(/kind: Config/)).not.toBeInTheDocument();
  });

  it("kubeconfig 留空：显示「—」并说明回退到默认 KUBECONFIG", async () => {
    stubList(() => [cluster()]);
    setup();
    await screen.findByText("prod-hz-01");
    expect(rowOf("prod-hz-01").getByText("—", { selector: "span[title]" })).toHaveAttribute(
      "title", "留空：helm 调用回退 $KUBECONFIG，再退到 ~/.kube/config",
    );
  });

  it("登记弹窗：名称留空只给必填提示，一个 POST 都不发", async () => {
    const user = userEvent.setup();
    const posts: string[] = [];
    stubList(() => [], (url, method, body) => {
      if (url === "/api/k8s/clusters" && method === "POST") {
        posts.push(String(body));
        return json(200, cluster());
      }
      return undefined;
    });
    setup();
    await user.click(await screen.findByRole("button", { name: "登记集群" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(await screen.findByText("集群名称必填")).toBeInTheDocument();
    // 后端 POST 不校验（ApiController.java:850-853 直接绑定 K8sCluster），必填只靠这一层
    expect(within(dialog).getByText(/后端 POST 不校验名称/)).toBeInTheDocument();
    expect(posts).toHaveLength(0);
    expect(screen.queryByText("集群「prod-hz-01」已登记")).not.toBeInTheDocument();
  });

  it("登记弹窗：context 字段如实标注「仅登记备查」，kubeconfig 只承诺路径与 base64", async () => {
    const user = userEvent.setup();
    stubList(() => []);
    setup();
    await user.click(await screen.findByRole("button", { name: "登记集群" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/仅登记备查/)).toBeInTheDocument();
    expect(within(dialog).getByText(/helm 调用只传 namespace \/ kubeconfig/)).toBeInTheDocument();
    // 直接粘 YAML 会被 k8s-ops 当 base64 解码（config.ts:14-20），弹窗不能说「粘贴内容也行」
    expect(within(dialog).getByText(/填文件路径或 base64 内容/)).toBeInTheDocument();
    expect(within(dialog).getByText(/当成 base64 解码/)).toBeInTheDocument();
  });

  it("登记弹窗：填名称后恰好一次 POST，成功 toast、关窗并失效集群清单", async () => {
    const user = userEvent.setup();
    const posts: string[] = [];
    stubList(() => [cluster()], (url, method, body) => {
      if (url === "/api/k8s/clusters" && method === "POST") {
        posts.push(String(body));
        return json(200, cluster({ name: "prod-hz-02" }));
      }
      return undefined;
    });
    const { invalidate } = setup();
    await user.click(await screen.findByRole("button", { name: "登记集群" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByPlaceholderText("prod-hz-01"), "prod-hz-02");
    await user.type(within(dialog).getByPlaceholderText("/home/ops/.kube/config"), "/home/ops/.kube/prod2");
    await user.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(JSON.parse(posts[0])).toEqual({
      name: "prod-hz-02", kubeconfig: "/home/ops/.kube/prod2", namespace: "default", context: "",
    });
    expect(await screen.findByText("集群「prod-hz-02」已登记")).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.clusters });
    // 成功即关窗（后端已回一条记录，表单草稿没有留着的理由）：重开必须是干净表单
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "登记集群" }));
    const reopened = await screen.findByRole("dialog");
    expect(within(reopened).getByPlaceholderText("prod-hz-01")).toHaveValue("");
    expect(within(reopened).getByPlaceholderText("/home/ops/.kube/config")).toHaveValue("");
    expect(within(reopened).getByRole("button", { name: "关闭" })).toBeInTheDocument();
  });

  it("登记失败：后端消息原样透出且窗口不关", async () => {
    const user = userEvent.setup();
    stubList(() => [], (url, method) =>
      url === "/api/k8s/clusters" && method === "POST"
        ? json(500, { detail: "saveCluster 失败" })
        : undefined);
    setup();
    await user.click(await screen.findByRole("button", { name: "登记集群" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByPlaceholderText("prod-hz-01"), "prod-hz-03");
    await user.click(within(dialog).getByRole("button", { name: "保存" }));
    const toast = await screen.findByText("saveCluster 失败");
    expect(toast.parentElement?.className).toContain("text-danger");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("删除：取消不发 DELETE；确认后恰好一次 DELETE，且文案不谎称后端确认删除", async () => {
    const user = userEvent.setup();
    const delUrls: string[] = [];
    stubList(() => [cluster()], (url, method) => {
      if (url.startsWith("/api/k8s/clusters/") && method === "DELETE") {
        delUrls.push(url);
        return json(200, { ok: true, id: "k8s-0f872ce7" });
      }
      return undefined;
    });
    const { invalidate } = setup();
    await user.click(await screen.findByRole("button", { name: "删除" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("删除集群登记")).toBeInTheDocument();
    // ApiController.java:867-871 对未知 id 也回 ok：回执不能当存在性证明
    expect(within(dialog).getByText(/返回 ok 不代表后端确认这条记录存在过/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/后端确认已删除/)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(delUrls).toHaveLength(0);

    await user.click(rowOf("prod-hz-01").getByRole("button", { name: "删除" }));
    const confirm = await screen.findByRole("dialog");
    await user.click(within(confirm).getByRole("button", { name: "确认" }));
    await waitFor(() => expect(delUrls).toEqual(["/api/k8s/clusters/k8s-0f872ce7"]));
    expect(await screen.findByText("集群已删除")).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.clusters });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("删除失败：给「删除失败」错误 toast，窗口照关并失效重拉（那一行真假已不可信）", async () => {
    const user = userEvent.setup();
    stubList(() => [cluster()], (url, method) =>
      url.startsWith("/api/k8s/clusters/") && method === "DELETE" ? json(500, { detail: "boom" }) : undefined);
    const { invalidate } = setup();
    await user.click(await screen.findByRole("button", { name: "删除" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "确认" }));
    const toast = await screen.findByText("删除失败");
    expect(toast.parentElement?.className).toContain("text-danger");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.clusters });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("「建升级流程」走 useNavigate 到 /flows?new=1&mode=upgrade_k8s，不整页刷新", async () => {
    const user = userEvent.setup();
    stubList(() => [cluster()]);
    setup();
    await user.click(await screen.findByRole("button", { name: "建升级流程" }));
    expect(await screen.findByTestId("location")).toHaveTextContent("/flows?new=1&mode=upgrade_k8s");
    expect(screen.getByText("流程列表页")).toBeInTheDocument();
  });

  it("Helm Release 查询中：显示「查询中…」，既不渲染空表也不渲染错误", async () => {
    const user = userEvent.setup();
    const d = deferred<Response>();
    stubList(() => [cluster()], (url, method) =>
      url === RELEASES_URL && method === "GET" ? d.promise : undefined);
    setup();
    await user.click(await screen.findByRole("button", { name: "Helm Release" }));
    expect(await screen.findByText("Helm Release · prod-hz-01")).toBeInTheDocument();
    expect(screen.getByText("查询中…")).toBeInTheDocument();
    expect(screen.queryByText(/该 namespace 下没有 release/)).not.toBeInTheDocument();
    expect(screen.queryByText(/未成功/)).not.toBeInTheDocument();
    d.resolve(json(200, { ok: true, data: { releases: [] } }));
    expect(await screen.findByText(/该 namespace 下没有 release/)).toBeInTheDocument();
    expect(screen.getByText("0 个 release（namespace shipdesk）")).toBeInTheDocument();
  });

  it("Helm Release 成功：读 data.data.releases，六列齐全且无错误条", async () => {
    const user = userEvent.setup();
    stubList(() => [cluster()], (url, method) =>
      url === RELEASES_URL && method === "GET"
        ? json(200, { ok: true, data: { releases: [RELEASE, { ...RELEASE, name: "saas-api", status: "failed" }] } })
        : undefined);
    setup();
    await user.click(await screen.findByRole("button", { name: "Helm Release" }));
    await screen.findByText("Helm Release · prod-hz-01");
    expect(await screen.findByText("2 个 release（namespace shipdesk）")).toBeInTheDocument();
    const row = rowOf("saas-web");
    expect(row.getByText("shipdesk")).toBeInTheDocument();
    expect(row.getByText("3")).toBeInTheDocument();
    expect(row.getByText("deployed")).toBeInTheDocument();
    // chart 本身就是 <name>-<version>，helm list -o json 没有独立的 version 键
    expect(row.getByText("web-1.2.3")).toBeInTheDocument();
    expect(row.getByText("1.2.3")).toBeInTheDocument();
    expect(rowOf("saas-api").getByText("failed")).toBeInTheDocument();
    expect(screen.queryByText(/未成功/)).not.toBeInTheDocument();
  });

  it("Helm Release 失败（node 栈）：只显示有效信息行，栈帧不外泄且不当成空清单", async () => {
    const user = userEvent.setup();
    stubList(() => [cluster()], (url, method) =>
      url === RELEASES_URL && method === "GET" ? json(200, { ok: false, error: STACK }) : undefined);
    setup();
    await user.click(await screen.findByRole("button", { name: "Helm Release" }));
    const band = await screen.findByText(/未成功/);
    expect(band.textContent).toContain(
      "Cannot find module 'E:\\Yeyib0\\vibe-installer\\backend-java\\k8s-ops\\dist\\index.js'",
    );
    expect(band.textContent).not.toContain("node:internal");
    expect(band.textContent).not.toContain("MODULE_NOT_FOUND");
    expect(screen.getByText("未取得 release 清单")).toBeInTheDocument();
    expect(screen.queryByText(/该 namespace 下没有 release/)).not.toBeInTheDocument();
    // 一行可读原因 + 一条能动手的建议，而不是整坨 stderr
    expect(screen.getByText(/k8s-ops 脚本没跑起来/)).toBeInTheDocument();
  });

  it("Helm Release 404：显示后端「集群不存在」，不是栈也不是空态", async () => {
    const user = userEvent.setup();
    stubList(() => [cluster()], (url, method) =>
      url === RELEASES_URL && method === "GET" ? json(404, { detail: "集群不存在" }) : undefined);
    setup();
    await user.click(await screen.findByRole("button", { name: "Helm Release" }));
    const band = await screen.findByText(/未成功：集群不存在/);
    expect(band.textContent).not.toContain("node:internal");
    expect(screen.getByText("未取得 release 清单")).toBeInTheDocument();
    expect(screen.queryByText(/该 namespace 下没有 release/)).not.toBeInTheDocument();
  });

  it("Helm Release 成功体里没有 releases 数组：说「读不到清单」而不是「没有 release」", async () => {
    const user = userEvent.setup();
    stubList(() => [cluster()], (url, method) =>
      url === RELEASES_URL && method === "GET"
        ? json(200, { ok: true, data: { raw: "helm 输出不是 JSON" } })
        : undefined);
    setup();
    await user.click(await screen.findByRole("button", { name: "Helm Release" }));
    expect(await screen.findByText(/未取得 release 清单/)).toBeInTheDocument();
    expect(screen.getByText(/返回体里没有 releases 数组/)).toBeInTheDocument();
    expect(screen.queryByText(/该 namespace 下没有 release/)).not.toBeInTheDocument();
  });

  it("Helm Release 200 空响应体：落到「查询失败」，不端出空清单", async () => {
    const user = userEvent.setup();
    stubList(() => [cluster()], (url, method) =>
      url === RELEASES_URL && method === "GET" ? new Response("", { status: 200 }) : undefined);
    setup();
    await user.click(await screen.findByRole("button", { name: "Helm Release" }));
    // TanStack Query 不接受 queryFn 返回 undefined，直接判 error：非 ApiError 就说「查询失败」
    expect(await screen.findByText(/未成功：查询失败/)).toBeInTheDocument();
    expect(screen.getByText("未取得 release 清单")).toBeInTheDocument();
    expect(screen.queryByText(/该 namespace 下没有 release/)).not.toBeInTheDocument();
  });

  it("提示卡与 RollbackButton 的真实行为一致：回滚在流程页右上角，回滚预案只给清单", async () => {
    stubList(() => []);
    setup();
    await screen.findByText(/尚未登记集群/);
    expect(screen.getByText(/Helm 回滚/)).toBeInTheDocument();
    expect(screen.getByText(/不会重置阶段状态/)).toBeInTheDocument();
    expect(screen.getByText(/「回滚预案」阶段只生成回滚命令清单/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "流程列表" })).toHaveAttribute("href", "/flows");
  });
});

describe("releaseError", () => {
  it("MODULE_NOT_FOUND 栈：取到 Cannot find module 那一行，不含任何 node:internal 帧", () => {
    expect(releaseError(STACK)).toBe(
      "Error: Cannot find module 'E:\\Yeyib0\\vibe-installer\\backend-java\\k8s-ops\\dist\\index.js'",
    );
    expect(releaseError(STACK)).not.toContain("node:internal");
  });

  it("helm 未安装 / 集群不可达：取到那一行原话", () => {
    expect(releaseError("'helm' is not recognized as an internal or external command"))
      .toBe("'helm' is not recognized as an internal or external command");
    expect(releaseError("helm list: Get \"https://10.0.0.5:6443\": connection refused"))
      .toBe("helm list: Get \"https://10.0.0.5:6443\": connection refused");
  });

  it("没有关键字时也绝不端出栈帧：只有栈就回「后端未返回可读的错误信息」", () => {
    expect(releaseError("Node.js v24.19.0\n  throw err;\n}")).toBe("后端未返回可读的错误信息");
    expect(releaseError("")).toBe("后端未返回可读的错误信息");
    // 无关键字的一行普通错误：原样给第一行
    expect(releaseError("kubeconfig 文件不存在")).toBe("kubeconfig 文件不存在");
  });

  it("超长行截到 240 字符", () => {
    const long = releaseError(`Error: ${"x".repeat(500)}`);
    expect(long).toHaveLength(240);
    expect(long.startsWith("Error: ")).toBe(true);
    expect(releaseError("Error: cannot reach tiller " + "z".repeat(300))).toHaveLength(240);
  });
});
