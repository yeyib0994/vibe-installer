import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import Backups from "./Backups";
import { ToastProvider } from "../components/ToastProvider";
import { qk } from "../api/endpoints";
import type { BackupPoint, Environment, NodeSpec } from "../api/types";

// 每次调用现造 Response：复用同一 Response 会让顺序 fetch 抛 Body is unusable。
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const node = (over: Partial<NodeSpec> = {}): NodeSpec => ({
  id: "n1", hostname: "ctrl-phy-01", ip: "10.10.0.11", role: "control", machine_type: "physical",
  ssh_port: 22, ssh_user: "root", status: "unknown", precheck_issues: [], ...over,
});

const baseEnv: Omit<Environment, "id" | "name"> = {
  description: "", base_domain: "saas.internal.com", ntp_server: "", dns_servers: [],
  timezone: "Asia/Shanghai", nodes: [], validated: true, validation_issues: [],
  created_at: "2026-10-01T08:00:00", updated_at: "2026-10-01T08:00:00",
};

const env1: Environment = {
  ...baseEnv, id: "e1", name: "生产-AZ1",
  nodes: [node(), node({ id: "n2", hostname: "db-phy-02", role: "database", ip: "10.10.0.21" })],
};

const env2: Environment = {
  ...baseEnv, id: "e2", name: "预发-AZ2",
  nodes: [node({ id: "n3", hostname: "worker-vm-01", role: "worker", machine_type: "virtual" })],
};

const backup = (over: Partial<BackupPoint> = {}): BackupPoint => ({
  id: "b1", name: "上线前备份", kind: "pre_upgrade", env_id: "e1", flow_id: "f1",
  include_paths: ["/opt/app"], include_databases: ["prod"], include_config: true,
  retention_days: 7, status: "succeeded", size_bytes: 2048,
  checksum: "sha256:0123456789abcdef0123456789abcdef", path: "data/backups/b1",
  nodes_covered: ["ctrl-phy-01", "db-phy-02"], started_at: "2026-10-05T14:00:00",
  finished_at: "2026-10-05T14:30:00", expire_at: "2026-10-12T14:30:00", verified_at: null,
  restorable: true, error: null, ...over,
});

/** 后端逐节点拼的 detail 原文：%-20s 补齐到 20 字符，被跳过的节点也在 restored_nodes 里。 */
const RESTORE_DETAIL =
  "  ✔ ctrl-phy-01         [MOCK] 已恢复目录与配置文件\n  – db-phy-02: 无备份数据，跳过";

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

/** 列表与环境两个查询的默认 stub；rows 用回调，方便模拟「后端已改状态」后的重新拉取。 */
function stubList(rows: () => BackupPoint[], extra: Handler = () => undefined) {
  stub((url, method, body) => {
    if (url === "/api/backups" && method === "GET") return json(200, rows());
    if (url === "/api/environments" && method === "GET") return json(200, [env1, env2]);
    return extra(url, method, body);
  });
}

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <Backups />
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

/** 行内断言：备份点名也会出现在弹窗里，只认表格内的那一处。 */
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

describe("Backups 页", () => {
  it("首屏加载显示占位行，不误报「自动生成备份点」空态", async () => {
    const d = deferred<Response>();
    stub((url, method) => {
      if (url === "/api/environments" && method === "GET") return json(200, [env1, env2]);
      if (url === "/api/backups" && method === "GET") return d.promise;
      return undefined;
    });
    setup();
    expect(await screen.findByText("加载备份点…")).toBeInTheDocument();
    expect(screen.queryByText(/自动生成备份点/)).not.toBeInTheDocument();
    d.resolve(json(200, []));
    expect(await screen.findByText("流程的备份阶段执行后会自动生成备份点")).toBeInTheDocument();
    expect(screen.queryByText("加载备份点…")).not.toBeInTheDocument();
  });

  it("加载完成后空列表显示空态文案", async () => {
    stubList(() => []);
    setup();
    expect(await screen.findByText("流程的备份阶段执行后会自动生成备份点")).toBeInTheDocument();
  });

  it("渲染行：类型、状态、覆盖台数与清单、大小、校验和前 12 位、完成与过期时间", async () => {
    stubList(() => [backup()]);
    setup();
    await screen.findByText("上线前备份");
    const row = rowOf("上线前备份");
    expect(row.getByText("升级前")).toBeInTheDocument();
    expect(row.getByText("已完成")).toBeInTheDocument();
    expect(row.getByText("2 台")).toBeInTheDocument();
    expect(row.getByText("ctrl-phy-01, db-phy-02")).toBeInTheDocument();
    expect(row.getByText("2 KB")).toBeInTheDocument();
    expect(row.getByText("sha256:01234")).toBeInTheDocument();
    expect(row.getByText("2026-10-05 14:30")).toBeInTheDocument();
    expect(row.getByText("2026-10-12")).toBeInTheDocument();
  });

  it("restorable=false 的行「恢复」按钮禁用", async () => {
    stubList(() => [backup({ restorable: false })]);
    setup();
    await screen.findByText("上线前备份");
    expect(rowOf("上线前备份").getByRole("button", { name: "恢复" })).toBeDisabled();
  });

  it("环境筛选：只显示该环境的备份点，Card 计数与体积随之变化", async () => {
    const user = userEvent.setup();
    stubList(() => [backup(), backup({ id: "b2", name: "预装备份", env_id: "e2", size_bytes: 1024 })]);
    setup();
    await screen.findByText("上线前备份");
    expect(screen.getByText("2 个 · 3 KB · 恢复会覆盖目标节点数据")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox"), "e1");
    expect(screen.getByText("1 个 · 2 KB · 恢复会覆盖目标节点数据")).toBeInTheDocument();
    expect(screen.queryByText("预装备份")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox"), "");
    expect(screen.getByText("2 个 · 3 KB · 恢复会覆盖目标节点数据")).toBeInTheDocument();
    expect(screen.getByText("预装备份")).toBeInTheDocument();
  });

  it("校验通过：弹窗展示后端消息、文件数、体积与期望/实际校验和", async () => {
    const user = userEvent.setup();
    stubList(() => [backup()], (url, method) => {
      if (url === "/api/backups/b1/verify" && method === "POST") {
        return json(200, {
          ok: true, files: 12, size_bytes: 3072,
          expected: "sha256:0123456789abcdef0123456789ab", actual: "sha256:0123456789abcdef0123456789ab",
          message: "校验通过，备份可正常恢复",
        });
      }
      return undefined;
    });
    setup();
    await user.click(await screen.findByRole("button", { name: "校验" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("校验通过")).toBeInTheDocument();
    expect(within(dialog).getByText("校验通过，备份可正常恢复")).toBeInTheDocument();
    expect(within(dialog).getByText("上线前备份")).toBeInTheDocument();
    expect(within(dialog).getByText("12")).toBeInTheDocument();
    expect(within(dialog).getByText("3 KB")).toBeInTheDocument();
    // expected / actual 各占一行：原样透出后端截断到 32 字符的值，前端不再截
    expect(within(dialog).getAllByText("sha256:0123456789abcdef0123456789ab")).toHaveLength(2);
    // toast 文案与弹窗标题同名：文档级命中 2 处即证明 toast 也走 ok 分支
    expect(screen.getAllByText("校验通过")).toHaveLength(2);
  });

  it("校验不一致：toast 走 error 分支，弹窗标题「校验失败」", async () => {
    const user = userEvent.setup();
    stubList(() => [backup()], (url, method) => {
      if (url === "/api/backups/b1/verify" && method === "POST") {
        return json(200, {
          ok: false, files: 9, size_bytes: 1024,
          expected: "sha256:0123456789abcdef0123456789ab", actual: "sha256:ffffffffffffffffffffffffff00",
          message: "校验和不一致，备份可能已损坏",
        });
      }
      return undefined;
    });
    setup();
    await user.click(await screen.findByRole("button", { name: "校验" }));
    const toast = await screen.findByText("校验不一致");
    expect(toast.parentElement?.className).toContain("text-danger");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("校验失败")).toBeInTheDocument();
    expect(within(dialog).getByText("校验和不一致，备份可能已损坏")).toBeInTheDocument();
    expect(within(dialog).getByText("sha256:0123456789abcdef0123456789ab")).toBeInTheDocument();
    expect(within(dialog).getByText("sha256:ffffffffffffffffffffffffff00")).toBeInTheDocument();
  });

  it("校验 409：后端消息原样透出，并失效备份查询刷新那一行", async () => {
    const user = userEvent.setup();
    let marked = false;
    stub((url, method) => {
      if (url === "/api/backups" && method === "GET") {
        return json(200, [marked ? backup({ status: "failed" }) : backup()]);
      }
      if (url === "/api/environments" && method === "GET") return json(200, [env1, env2]);
      if (url === "/api/backups/b1/verify" && method === "POST") {
        marked = true;
        return json(409, { detail: "备份目录不存在，备份点已标记为失败" });
      }
      return undefined;
    });
    const { invalidate } = setup();
    await user.click(await screen.findByRole("button", { name: "校验" }));
    expect(await screen.findByText("备份目录不存在，备份点已标记为失败")).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.backups() });
    await waitFor(() => expect(rowOf("上线前备份").getByText("失败")).toBeInTheDocument());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("校验中：只有发起校验的那一行按钮文案变化", async () => {
    const user = userEvent.setup();
    const d = deferred<Response>();
    stubList(() => [backup(), backup({ id: "b2", name: "预装备份", env_id: "e2" })], () => d.promise);
    setup();
    await screen.findByText("上线前备份");
    await user.click(rowOf("上线前备份").getByRole("button", { name: "校验" }));
    expect(await rowOf("上线前备份").findByRole("button", { name: "校验中…" })).toBeInTheDocument();
    const other = rowOf("预装备份").getByRole("button", { name: "校验" });
    expect(other).toBeDisabled();
    // 别的行为什么点不动：串行是后端的磁盘遍历决定的，不写出来就像页面坏了
    expect(other).toHaveAttribute("title", "校验是磁盘遍历，暂不支持并发");
    d.resolve(json(200, {
      ok: true, files: 1, size_bytes: 10, expected: "a", actual: "a", message: "校验通过，备份可正常恢复",
    }));
    expect(await screen.findByText("校验通过，备份可正常恢复")).toBeInTheDocument();
    await waitFor(() => expect(rowOf("上线前备份").getByRole("button", { name: "校验" })).toBeEnabled());
  });

  it("标记过期：失效查询，重新拉取后该行变已过期且「恢复」禁用", async () => {
    const user = userEvent.setup();
    let expired = false;
    stub((url, method) => {
      if (url === "/api/backups" && method === "GET") {
        return json(200, [expired ? backup({ status: "expired", restorable: false }) : backup()]);
      }
      if (url === "/api/environments" && method === "GET") return json(200, [env1, env2]);
      if (url === "/api/backups/b1/expire" && method === "POST") {
        expired = true;
        return json(200, { ok: true });
      }
      return undefined;
    });
    const { invalidate } = setup();
    await user.click(await screen.findByRole("button", { name: "标记过期" }));
    expect(await screen.findByText("已标记过期")).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.backups() });
    await waitFor(() => expect(rowOf("上线前备份").getByRole("button", { name: "恢复" })).toBeDisabled());
    expect(rowOf("上线前备份").getByText("已过期")).toBeInTheDocument();
  });

  it("标记过期：进行中的那一行按钮显示「处理中…」", async () => {
    const user = userEvent.setup();
    const d = deferred<Response>();
    stubList(() => [backup(), backup({ id: "b2", name: "预装备份", env_id: "e2" })], (url, method) =>
      url === "/api/backups/b1/expire" && method === "POST" ? d.promise : undefined);
    setup();
    await screen.findByText("上线前备份");
    await user.click(rowOf("上线前备份").getByRole("button", { name: "标记过期" }));
    expect(await rowOf("上线前备份").findByRole("button", { name: "处理中…" })).toBeInTheDocument();
    expect(rowOf("预装备份").getByRole("button", { name: "标记过期" })).toBeEnabled();
    d.resolve(json(200, { ok: true }));
    expect(await screen.findByText("已标记过期")).toBeInTheDocument();
  });

  it("标记过期失败：后端消息原样透出，404 同样失效查询（那一行已经不可信）", async () => {
    const user = userEvent.setup();
    stubList(() => [backup()], (url, method) =>
      url === "/api/backups/b1/expire" && method === "POST"
        ? json(404, { detail: "备份点不存在" })
        : undefined);
    const { invalidate } = setup();
    await user.click(await screen.findByRole("button", { name: "标记过期" }));
    const toast = await screen.findByText("备份点不存在");
    expect(toast.parentElement?.className).toContain("text-danger");
    expect(screen.queryByText("已标记过期")).not.toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.backups() });
  });

  it("恢复：确认文案含目标 hostname 与「不可撤销」，请求体带 node_ids 与 confirm", async () => {
    const user = userEvent.setup();
    const bodies: string[] = [];
    stubList(() => [backup()], (url, method, body) => {
      if (url === "/api/backups/b1/restore" && method === "POST") {
        bodies.push(String(body));
        return json(200, { ok: true, restored_nodes: ["ctrl-phy-01", "db-phy-02"], detail: RESTORE_DETAIL });
      }
      return undefined;
    });
    setup();
    await user.click(await screen.findByRole("button", { name: "恢复" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/备份点「上线前备份」覆盖 2 台节点/)).toBeInTheDocument();
    expect(within(dialog).getByText(/本次恢复目标：2 台（ctrl-phy-01, db-phy-02）/)).toBeInTheDocument();
    expect(within(dialog).getByText(/该操作会覆盖目标节点上的现有数据，不可撤销/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "确认覆盖并恢复" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(JSON.parse(bodies[0])).toEqual({ backup_id: "b1", node_ids: ["n1", "n2"], confirm: true });
  });

  it("恢复成功：toast 只报目标台数，结果弹窗原样展示 detail（含被跳过的节点）", async () => {
    const user = userEvent.setup();
    stubList(() => [backup()], (url, method) =>
      url === "/api/backups/b1/restore" && method === "POST"
        ? json(200, { ok: true, restored_nodes: ["ctrl-phy-01", "db-phy-02"], detail: RESTORE_DETAIL })
        : undefined);
    setup();
    await user.click(await screen.findByRole("button", { name: "恢复" }));
    const confirm = await screen.findByRole("dialog");
    await user.click(within(confirm).getByRole("button", { name: "确认覆盖并恢复" }));
    const toast = await screen.findByText("恢复完成 · 目标 2 台节点");
    expect(toast.parentElement?.className).toContain("text-ok");
    // restored_nodes 含被跳过的节点，不能写成「已恢复 2 台节点」
    expect(screen.queryByText(/已恢复 2 台节点/)).not.toBeInTheDocument();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("恢复结果")).toBeInTheDocument();
    expect(within(dialog).getByText(/无备份数据，跳过/)).toBeInTheDocument();
    expect(within(dialog).getByText(/\[MOCK\] 已恢复目录与配置文件/).textContent).toBe(RESTORE_DETAIL);
  });

  it("恢复失败（409 已过期）：toast 透出后端消息、失效查询且不弹结果窗", async () => {
    const user = userEvent.setup();
    stubList(() => [backup()], (url, method) =>
      url === "/api/backups/b1/restore" && method === "POST"
        ? json(409, { detail: "该备份点已过期，可能已被清理" })
        : undefined);
    const { invalidate } = setup();
    await user.click(await screen.findByRole("button", { name: "恢复" }));
    const confirm = await screen.findByRole("dialog");
    await user.click(within(confirm).getByRole("button", { name: "确认覆盖并恢复" }));
    const toast = await screen.findByText("该备份点已过期，可能已被清理");
    expect(toast.parentElement?.className).toContain("text-danger");
    expect(screen.queryByText("恢复结果")).not.toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.backups() });
  });

  it("环境已不在清单：文案说明无法恢复，确认按钮禁用且点击不发恢复请求", async () => {
    const user = userEvent.setup();
    const restoreBodies: string[] = [];
    stub((url, method, body) => {
      if (url === "/api/backups" && method === "GET") return json(200, [backup()]);
      if (url === "/api/environments" && method === "GET") return json(200, [env2]);
      if (url === "/api/backups/b1/restore" && method === "POST") {
        restoreBodies.push(String(body));
        return json(200, { ok: true, restored_nodes: [], detail: "" });
      }
      return undefined;
    });
    setup();
    await user.click(await screen.findByRole("button", { name: "恢复" }));
    const dialog = await screen.findByRole("dialog");
    // 后端 restoreBackup 先 store.getEnv(b.envId)，拿不到就 404「环境不存在」：
    // 结局已知就不该再给出确认动作，文案也要说清按钮为什么点不动（而不是预告一句谎话再喂 404）。
    expect(within(dialog).getByText(/该环境已不在清单中，无法恢复；需先重新登记同名环境/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "确认覆盖并恢复" });
    expect(confirm).toBeDisabled();
    // 禁用不是 busy 态：文案必须还是「确认覆盖并恢复」，「处理中…」在这一分支是谎话
    await user.click(confirm);
    expect(restoreBodies).toHaveLength(0);
    expect(within(dialog).queryByRole("button", { name: "处理中…" })).not.toBeInTheDocument();
  });

  it("恢复：环境清单还在加载时不断言环境不在清单", async () => {
    const user = userEvent.setup();
    const d = deferred<Response>();
    stub((url, method) => {
      if (url === "/api/backups" && method === "GET") return json(200, [backup()]);
      if (url === "/api/environments" && method === "GET") return d.promise;
      return undefined;
    });
    setup();
    await user.click(await screen.findByRole("button", { name: "恢复" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/环境清单加载中，确认后由后端按该环境的全部节点解析/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/不在当前清单/)).not.toBeInTheDocument();
    // 诚实规则回归位：加载中≠不存在，这时候确认必须仍可点
    expect(within(dialog).getByRole("button", { name: "确认覆盖并恢复" })).toBeEnabled();
    d.resolve(json(200, [env1, env2]));
    expect(await within(dialog).findByText(/本次恢复目标：2 台（ctrl-phy-01, db-phy-02）/)).toBeInTheDocument();
  });

  it("恢复在途：单发约束——A 未结算时 B 的行按钮禁用，只发一次 restore；A 的结果窗照常弹出", async () => {
    const user = userEvent.setup();
    const dA = deferred<Response>();
    const restoreUrls: string[] = [];
    stubList(() => [backup(), backup({ id: "b2", name: "预装备份", env_id: "e2" })], (url, method) => {
      if (method !== "POST" || !/^\/api\/backups\/[^/]+\/restore$/.test(url)) return undefined;
      restoreUrls.push(url);
      if (url === "/api/backups/b1/restore") return dA.promise;
      return json(200, { ok: true, restored_nodes: ["worker-vm-01"], detail: "  ✔ worker-vm-01" });
    });
    setup();
    await screen.findByText("上线前备份");
    await user.click(rowOf("上线前备份").getByRole("button", { name: "恢复" }));
    const confirmA = await screen.findByRole("dialog");
    await user.click(within(confirmA).getByRole("button", { name: "确认覆盖并恢复" }));
    expect(await within(confirmA).findByRole("button", { name: "处理中…" })).toBeDisabled();

    // 恢复与校验同为节点级操作：A 在途时 B 的行按钮必须点不动，并发 restore 无从发起
    const btnB = rowOf("预装备份").getByRole("button", { name: "恢复" });
    expect(btnB).toBeDisabled();
    expect(btnB).toHaveAttribute("title", "恢复是节点级操作，暂不支持并发");
    // Modal 的 Esc 在途照样生效：A 的弹窗关掉，请求还在飞
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(rowOf("预装备份").getByRole("button", { name: "恢复" }));
    expect(restoreUrls).toEqual(["/api/backups/b1/restore"]);

    dA.resolve(json(200, {
      ok: true, restored_nodes: ["ctrl-phy-01", "db-phy-02"], detail: RESTORE_DETAIL,
    }));
    // 结果窗绑定这次结算的 b（query variables）：无条件弹出才是诚实的
    expect(await screen.findByText("恢复完成 · 目标 2 台节点")).toBeInTheDocument();
    const result = await screen.findByRole("dialog");
    expect(within(result).getByText("恢复结果")).toBeInTheDocument();
    expect(within(result).getByText("上线前备份")).toBeInTheDocument();
    expect(restoreUrls).toHaveLength(1);

    // 结算后 B 解锁，用户能正常发起自己那一次恢复
    // （getByText 只命中 footer 的「关闭」按钮：头部 ✕ 的 aria-label 也叫「关闭」）
    await user.click(within(result).getByText("关闭"));
    await waitFor(() => expect(rowOf("预装备份").getByRole("button", { name: "恢复" })).toBeEnabled());
    await user.click(rowOf("预装备份").getByRole("button", { name: "恢复" }));
    const confirmB = await screen.findByRole("dialog");
    expect(within(confirmB).getByRole("button", { name: "确认覆盖并恢复" })).toBeEnabled();
    await user.click(within(confirmB).getByRole("button", { name: "确认覆盖并恢复" }));
    await waitFor(() => expect(restoreUrls).toEqual([
      "/api/backups/b1/restore", "/api/backups/b2/restore",
    ]));
  });

  it("失败行显示后端 error 原话，已校验的行在完成时间下补一行已校验", async () => {
    stubList(() => [
      backup({ status: "failed", error: "备份目录不存在" }),
      backup({ id: "b2", name: "预装备份", env_id: "e2", status: "verified", verified_at: "2026-10-06T09:12:00" }),
    ]);
    setup();
    await screen.findByText("上线前备份");
    const failed = rowOf("上线前备份");
    expect(failed.getByText("失败")).toBeInTheDocument();
    expect(failed.getByText("备份目录不存在")).toBeInTheDocument();
    expect(failed.queryByText(/已校验/)).not.toBeInTheDocument();
    const verified = rowOf("预装备份");
    expect(verified.getByText("已校验 2026-10-06 09:12")).toBeInTheDocument();
    expect(verified.queryByText("备份目录不存在")).not.toBeInTheDocument();
  });
});
