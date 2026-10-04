import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import K8s from "./K8s";
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

/** 第二个集群：竞态与「删除正在看的集群」的用例都要靠它做对照。 */
const clusterB = (over: Partial<K8sCluster> = {}): K8sCluster =>
  cluster({ id: "k8s-77aa1bc9", name: "test-sh-02", namespace: "kube-system", ...over });

const RELEASES_URL = "/api/k8s/clusters/k8s-0f872ce7/releases";
const RELEASES_URL_B = "/api/k8s/clusters/k8s-77aa1bc9/releases";

const RELEASE_B = {
  name: "ops-agent", namespace: "kube-system", revision: 1, status: "deployed",
  chart: "agent-0.4.0", app_version: "0.4.0",
};

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

  it("登记弹窗：填名称后恰好一次 POST，成功 toast、关窗并让清单真的落到新行", async () => {
    const user = userEvent.setup();
    const posts: string[] = [];
    // 后端已改数据：重拉必须回一份不一样的清单，才能验证表格是「落到新行」而不是只调了一次 invalidate
    let rows: K8sCluster[] = [];
    stubList(() => rows, (url, method, body) => {
      if (url === "/api/k8s/clusters" && method === "POST") {
        posts.push(String(body));
        rows = [cluster({ id: "k8s-3c1d9a77", name: "prod-hz-02", kubeconfig: "/home/ops/.kube/prod2" })];
        return json(200, cluster({ name: "prod-hz-02" }));
      }
      return undefined;
    });
    const { invalidate } = setup();
    await user.click(await screen.findByRole("button", { name: "登记集群" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByPlaceholderText("prod-hz-01"), "prod-hz-02");
    await user.type(within(dialog).getByPlaceholderText("/home/ops/.kube/config"), "/home/ops/.kube/prod2");
    // 另外三个字段都 trim，context 不能例外
    await user.type(within(dialog).getByPlaceholderText("留空=当前 context"), " prod-hz-02 ");
    await user.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(JSON.parse(posts[0])).toEqual({
      name: "prod-hz-02", kubeconfig: "/home/ops/.kube/prod2", namespace: "default", context: "prod-hz-02",
    });
    expect(await screen.findByText("集群「prod-hz-02」已登记")).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.clusters });
    // 失效重拉要真的收敛：新行落在表里，旧的空态不再占位
    expect(await rowOf("prod-hz-02").getByText("k8s-3c1d9a77")).toBeInTheDocument();
    expect(rowOf("prod-hz-02").getByText("/home/ops/.kube/prod2")).toBeInTheDocument();
    // 成功即关窗（后端已回一条记录，表单草稿没有留着的理由）：重开必须是干净表单
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "登记集群" }));
    const reopened = await screen.findByRole("dialog");
    expect(within(reopened).getByPlaceholderText("prod-hz-01")).toHaveValue("");
    expect(within(reopened).getByPlaceholderText("/home/ops/.kube/config")).toHaveValue("");
    expect(within(reopened).getByPlaceholderText("留空=当前 context")).toHaveValue("");
    expect(within(reopened).getByRole("button", { name: "关闭" })).toBeInTheDocument();
  });

  it("登记弹窗：保存中不给取消——取消/✕/backdrop 都不关窗，失败后草稿还在", async () => {
    const user = userEvent.setup();
    const d = deferred<Response>();
    const posts: string[] = [];
    stubList(() => [], (url, method, body) => {
      if (url === "/api/k8s/clusters" && method === "POST") {
        posts.push(String(body));
        return d.promise;
      }
      return undefined;
    });
    setup();
    await user.click(await screen.findByRole("button", { name: "登记集群" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByPlaceholderText("prod-hz-01"), "prod-hz-09");
    await user.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    // 与 ConfirmDialog 的 busy 处理一致：在途时取消禁用
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "保存中…" })).toBeDisabled();
    // ✕ 与 backdrop 走的是同一个 onClose，也必须挡住在途请求
    await user.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByRole("dialog"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    d.resolve(json(500, { detail: "saveCluster 失败" }));
    expect(await screen.findByText("saveCluster 失败")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(within(dialog).getByPlaceholderText("prod-hz-01")).toHaveValue("prod-hz-09");
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeEnabled();
  });

  it("登记弹窗：取消会清空草稿与必填红字，重开是干净表单", async () => {
    const user = userEvent.setup();
    stubList(() => []);
    setup();
    await user.click(await screen.findByRole("button", { name: "登记集群" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByPlaceholderText("/home/ops/.kube/config"), "/home/ops/.kube/keep");
    await user.type(within(dialog).getByPlaceholderText("留空=当前 context"), "keep-me");
    // 名称留空点保存：红字与 toast 出现，然后取消
    await user.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(await within(dialog).findByText(/后端 POST 不校验名称/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // Modal 只是 return null，组件从没卸载：不清草稿的话重开会带着上次的半截输入与红字
    await user.click(screen.getByRole("button", { name: "登记集群" }));
    const reopened = await screen.findByRole("dialog");
    expect(within(reopened).getByPlaceholderText("prod-hz-01")).toHaveValue("");
    expect(within(reopened).getByPlaceholderText("/home/ops/.kube/config")).toHaveValue("");
    expect(within(reopened).getByPlaceholderText("留空=当前 context")).toHaveValue("");
    expect(within(reopened).queryByText(/后端 POST 不校验名称/)).not.toBeInTheDocument();
    expect(within(reopened).getByPlaceholderText("prod-hz-01").className).not.toContain("border-danger");
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

  it("删除：取消不发 DELETE；确认后恰好一次 DELETE，重拉真的让该行消失，且文案不谎称后端确认删除", async () => {
    const user = userEvent.setup();
    const delUrls: string[] = [];
    // 后端已删：重拉回的清单少一条，才能验证表格收敛而不是只调了一次 invalidate
    let rows = [cluster(), clusterB()];
    stubList(() => rows, (url, method) => {
      if (url.startsWith("/api/k8s/clusters/") && method === "DELETE") {
        delUrls.push(url);
        rows = rows.filter((c) => c.id !== "k8s-0f872ce7");
        return json(200, { ok: true, id: "k8s-0f872ce7" });
      }
      return undefined;
    });
    const { invalidate } = setup();
    await screen.findByText("prod-hz-01");
    await user.click(rowOf("prod-hz-01").getByRole("button", { name: "删除" }));
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
    await waitFor(() => expect(screen.queryByText("prod-hz-01")).not.toBeInTheDocument());
    expect(rowOf("test-sh-02").getByText("k8s-77aa1bc9")).toBeInTheDocument();
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

  it("删除正开着面板的集群：面板一起收起，不把 404「集群不存在」端在已删集群的标题下", async () => {
    const user = userEvent.setup();
    let rows = [cluster(), clusterB()];
    const state = { releasesCalls: 0 };
    stubList(() => rows, (url, method) => {
      if (url === RELEASES_URL && method === "GET") {
        state.releasesCalls += 1;
        // 删除前给清单，删除后这条 id 已不在表里 → 后端 404「集群不存在」
        return state.releasesCalls === 1
          ? json(200, { ok: true, data: { releases: [RELEASE] } })
          : json(404, { detail: "集群不存在" });
      }
      if (url === "/api/k8s/clusters/k8s-0f872ce7" && method === "DELETE") {
        rows = rows.filter((c) => c.id !== "k8s-0f872ce7");
        return json(200, { ok: true, id: "k8s-0f872ce7" });
      }
      return undefined;
    });
    setup();
    await screen.findByText("prod-hz-01");
    await user.click(rowOf("prod-hz-01").getByRole("button", { name: "Helm Release" }));
    await screen.findByText("saas-web");
    expect(rowOf("saas-web").getByText("deployed")).toBeInTheDocument();

    await user.click(rowOf("prod-hz-01").getByRole("button", { name: "删除" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "确认" }));
    // 卡片整体消失：标题里的名字已经不存在，留着它就是给一个查无此集群的面板起名
    await waitFor(() => expect(screen.queryByText(/Helm Release · prod-hz-01/)).not.toBeInTheDocument());
    expect(screen.queryByText(/集群不存在/)).not.toBeInTheDocument();
    expect(screen.queryByText("saas-web")).not.toBeInTheDocument();
    expect(screen.queryByText("test-sh-02")).toBeInTheDocument();
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

  it("Helm Release 面板的第一次提交：请求在途也不闪「该 namespace 下没有 release」", async () => {
    const user = userEvent.setup();
    const d = deferred<Response>();
    // TanStack Query 在 passive effect 里排请求，所以 stub 被调用的那一刻 DOM 还停在
    // setReleasesFor(c) 之后的第一次提交——await findBy* 只能看到效果冲洗完的那一帧，闪一帧的空表看不见。
    // 这里在发起请求的当口直接 queryByText 抓首帧，请求则永不 resolve。
    const firstFrame: { empty: HTMLElement | null; sub: HTMLElement | null; loading: HTMLElement | null } = {
      empty: null, sub: null, loading: null,
    };
    let captured = false;
    stubList(() => [cluster()], (url, method) => {
      if (url === RELEASES_URL && method === "GET") {
        if (!captured) {
          captured = true;
          firstFrame.empty = screen.queryByText(/该 namespace 下没有 release/);
          firstFrame.sub = screen.queryByText(/个 release（namespace/);
          firstFrame.loading = screen.queryByText("读取 release 清单…");
        }
        return d.promise;
      }
      return undefined;
    });
    setup();
    await user.click(await screen.findByRole("button", { name: "Helm Release" }));
    // 首帧：既不能是空表，也不能是「0 个 release」这种把在途说成结论的副标题
    expect(firstFrame.empty).toBeNull();
    expect(firstFrame.sub).toBeNull();
    expect(firstFrame.loading?.textContent).toBe("读取 release 清单…");
    // isFetching 翻上来之后，在途文案照旧要在
    expect(await screen.findByText("Helm Release · prod-hz-01")).toBeInTheDocument();
    expect(screen.getByText("查询中…")).toBeInTheDocument();
    expect(screen.getByText("读取 release 清单…")).toBeInTheDocument();
    expect(screen.queryByText(/该 namespace 下没有 release/)).not.toBeInTheDocument();
    expect(screen.queryByText(/个 release（namespace/)).not.toBeInTheDocument();
  });

  it("离线（fetchStatus 停在 paused，首次提交 isFetching=false、data=undefined）：在途不能说成「该 namespace 下没有 release」", async () => {
    const user = userEvent.setup();
    const d = deferred<Response>();
    stubList(() => [cluster()], (url, method) =>
      url === RELEASES_URL && method === "GET" ? d.promise : undefined);
    setup();
    await screen.findByText("prod-hz-01");
    // 清单到手之后才断网：onlineManager 是全局单例，networkMode 默认 online，
    // 断网后新挂载的查询只会停在 fetchStatus=paused —— isFetching 一直是 false，
    // 于是「只看 isFetching 的空表门禁」这时候真的会把待完成的查询说成空清单。
    onlineManager.setOnline(false);
    try {
      await user.click(rowOf("prod-hz-01").getByRole("button", { name: "Helm Release" }));
      expect(await screen.findByText("Helm Release · prod-hz-01")).toBeInTheDocument();
      expect(screen.queryByText(/该 namespace 下没有 release/)).not.toBeInTheDocument();
      expect(screen.queryByText(/个 release（namespace/)).not.toBeInTheDocument();
      expect(screen.getByText("查询中…")).toBeInTheDocument();
      expect(screen.getByText("读取 release 清单…")).toBeInTheDocument();
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it("切换集群 A→B：面板只端出 B 的清单，A 的 release 一行都不留", async () => {
    const user = userEvent.setup();
    const a = deferred<Response>();
    const b = deferred<Response>();
    // 抓 B 那次请求发起当口的 DOM：这时候 A 的清单若还在表里就是残留
    const atBRequest: { stale: HTMLElement | null } = { stale: null };
    let captured = false;
    stubList(() => [cluster(), clusterB()], (url, method) => {
      if (url === RELEASES_URL && method === "GET") return a.promise;
      if (url === RELEASES_URL_B && method === "GET") {
        if (!captured) {
          captured = true;
          atBRequest.stale = screen.queryByText("saas-web");
        }
        return b.promise;
      }
      return undefined;
    });
    setup();
    await screen.findByText("prod-hz-01");
    await user.click(rowOf("prod-hz-01").getByRole("button", { name: "Helm Release" }));
    a.resolve(json(200, { ok: true, data: { releases: [RELEASE] } }));
    await screen.findByText("saas-web");
    expect(rowOf("saas-web").getByText("web-1.2.3")).toBeInTheDocument();

    await user.click(rowOf("test-sh-02").getByRole("button", { name: "Helm Release" }));
    expect(atBRequest.stale).toBeNull();
    b.resolve(json(200, { ok: true, data: { releases: [RELEASE_B] } }));
    expect(await screen.findByText("Helm Release · test-sh-02")).toBeInTheDocument();
    expect(await screen.findByText("ops-agent")).toBeInTheDocument();
    expect(screen.queryByText("saas-web")).not.toBeInTheDocument();
    expect(screen.getByText("1 个 release（namespace kube-system）")).toBeInTheDocument();
  });

  it("带着已有数据重新拉取：不闪成空表，已渲染的 release 留在原位", async () => {
    const user = userEvent.setup();
    let rows = [cluster(), clusterB()];
    const refetch = deferred<Response>();
    const state = { releasesCalls: 0, refetching: false };
    stubList(() => rows, (url, method) => {
      if (url === RELEASES_URL && method === "GET") {
        state.releasesCalls += 1;
        if (state.releasesCalls === 1) {
          return json(200, { ok: true, data: { releases: [RELEASE, { ...RELEASE, name: "saas-api" }] } });
        }
        state.refetching = true;
        return refetch.promise;
      }
      if (url.startsWith("/api/k8s/clusters/") && method === "DELETE") {
        rows = rows.filter((c) => c.id !== clusterB().id);
        return json(200, { ok: true, id: clusterB().id });
      }
      return undefined;
    });
    setup();
    await screen.findByText("prod-hz-01");
    await user.click(rowOf("prod-hz-01").getByRole("button", { name: "Helm Release" }));
    expect(await screen.findByText("2 个 release（namespace shipdesk）")).toBeInTheDocument();

    // 删掉另一个集群 → qk.clusters 前缀命中 releases key → 面板后台重拉
    await user.click(rowOf("test-sh-02").getByRole("button", { name: "删除" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "确认" }));
    await waitFor(() => expect(state.refetching).toBe(true));
    expect(await screen.findByText("Helm Release · prod-hz-01")).toBeInTheDocument();
    expect(screen.getByText("saas-web")).toBeInTheDocument();
    expect(screen.getByText("saas-api")).toBeInTheDocument();
    expect(screen.queryByText(/该 namespace 下没有 release/)).not.toBeInTheDocument();
    expect(screen.queryByText("读取 release 清单…")).not.toBeInTheDocument();
    expect(screen.queryByText(/未成功/)).not.toBeInTheDocument();
    expect(screen.queryByText("test-sh-02")).not.toBeInTheDocument();
    refetch.resolve(json(200, { ok: true, data: { releases: [RELEASE] } }));
    expect(await screen.findByText("1 个 release（namespace shipdesk）")).toBeInTheDocument();
  });

  it("收起面板再打开另一个集群：不残留上一个集群的清单", async () => {
    const user = userEvent.setup();
    const b = deferred<Response>();
    const atBRequest: { stale: HTMLElement | null; loading: HTMLElement | null } = { stale: null, loading: null };
    let captured = false;
    stubList(() => [cluster(), clusterB()], (url, method) => {
      if (url === RELEASES_URL && method === "GET") return json(200, { ok: true, data: { releases: [RELEASE] } });
      if (url === RELEASES_URL_B && method === "GET") {
        if (!captured) {
          captured = true;
          atBRequest.stale = screen.queryByText("saas-web");
          atBRequest.loading = screen.queryByText("读取 release 清单…");
        }
        return b.promise;
      }
      return undefined;
    });
    setup();
    await screen.findByText("prod-hz-01");
    await user.click(rowOf("prod-hz-01").getByRole("button", { name: "Helm Release" }));
    expect(await screen.findByText("saas-web")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "收起" }));
    await waitFor(() => expect(screen.queryByText(/Helm Release · prod-hz-01/)).not.toBeInTheDocument());
    expect(screen.queryByText("saas-web")).not.toBeInTheDocument();

    await user.click(rowOf("test-sh-02").getByRole("button", { name: "Helm Release" }));
    expect(atBRequest.stale).toBeNull();
    expect(atBRequest.loading?.textContent).toBe("读取 release 清单…");
    b.resolve(json(200, { ok: true, data: { releases: [RELEASE_B] } }));
    expect(await screen.findByText("Helm Release · test-sh-02")).toBeInTheDocument();
    expect(await screen.findByText("ops-agent")).toBeInTheDocument();
    expect(screen.queryByText("saas-web")).not.toBeInTheDocument();
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

  it("Helm Release 失败体的 error 不是字符串（后端零校验，对象也进得了这里）：不端出 [object Object]", async () => {
    const user = userEvent.setup();
    stubList(() => [cluster()], (url, method) =>
      url === RELEASES_URL && method === "GET"
        ? json(200, { ok: false, error: { cause: "helm not found" } })
        : undefined);
    setup();
    await user.click(await screen.findByRole("button", { name: "Helm Release" }));
    const band = await screen.findByText(/未成功/);
    expect(band.textContent).toContain("后端未返回可读的错误信息");
    expect(band.textContent).not.toContain("[object Object]");
    expect(screen.queryByText(/该 namespace 下没有 release/)).not.toBeInTheDocument();
  });

  it("Helm Release 404：显示后端「集群不存在」，不是栈也不是空态", async () => {
    const user = userEvent.setup();
    stubList(() => [cluster()], (url, method) =>
      url === RELEASES_URL && method === "GET" ? json(404, { detail: "集群不存在" }) : undefined);
    setup();
    await user.click(await screen.findByRole("button", { name: "Helm Release" }));
    const band = await screen.findByText(/未取得清单：集群不存在/);
    expect(band.textContent).not.toContain("node:internal");
    // 404 是「请求被后端拒了」，helm list 压根没发出去，不许写「后端 helm list 未成功」
    expect(band.textContent).not.toContain("未成功");
    expect(screen.getByText("未取得 release 清单")).toBeInTheDocument();
    expect(screen.queryByText(/该 namespace 下没有 release/)).not.toBeInTheDocument();
    // 契约校正 17⑤：「常见原因」那条只跟着 {ok:false} 的脚本失败分支，404 是集群不存在，贴上去就是误导
    expect(screen.queryByText(/k8s-ops 脚本没跑起来/)).not.toBeInTheDocument();
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
    const band = screen.getByText(/返回体里没有 releases 数组/);
    // 恰恰相反：这条分支上 helm list 是成功返回的，只是输出不是 JSON
    expect(band.textContent).not.toContain("未成功");
    expect(screen.queryByText(/该 namespace 下没有 release/)).not.toBeInTheDocument();
  });

  it("Helm Release 200 空响应体：落到「查询失败」，不端出空清单", async () => {
    const user = userEvent.setup();
    stubList(() => [cluster()], (url, method) =>
      url === RELEASES_URL && method === "GET" ? new Response("", { status: 200 }) : undefined);
    setup();
    await user.click(await screen.findByRole("button", { name: "Helm Release" }));
    // TanStack Query 不接受 queryFn 返回 undefined，直接判 error：非 ApiError 就说「查询失败」；
    // 这条不是脚本挂掉，所以前缀是「未取得清单」而不是「helm list 未成功」
    expect(await screen.findByText(/未取得清单：查询失败/)).toBeInTheDocument();
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
