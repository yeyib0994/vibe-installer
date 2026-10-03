/* CloudOps Console — 云化系统安装 / 升级 流程编排控制台
 * 零构建 Vanilla JS SPA。所有渲染走 h() 模板字符串 + 事件委托。 */

// ---------------------------------------------------------------- 基础工具
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(msg, kind = "", ms = 3600) {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.innerHTML = `<span>${kind === "ok" ? "✓" : kind === "err" ? "✕" : "•"}</span><span>${esc(msg)}</span>`;
  $("#toasts").appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = ".25s"; }, ms - 260);
  setTimeout(() => el.remove(), ms);
}

function modal({ title, body, footer, wide }) {
  const bg = document.createElement("div");
  bg.className = "modal-bg";
  bg.innerHTML = `<div class="modal ${wide ? "wide" : ""}">
      <div class="modal-h">${esc(title)}</div>
      <div class="modal-b">${body}</div>
      <div class="modal-f">${footer || ""}</div>
    </div>`;
  bg.addEventListener("click", (e) => { if (e.target === bg) bg.remove(); });
  $("#modalRoot").appendChild(bg);
  return bg;
}
const closeModal = (el) => el?.remove();

async function api(path, opts = {}) {
  const init = { headers: {}, ...opts };
  if (init.body && !(init.body instanceof FormData)) {
    init.headers["Content-Type"] = "application/json";
    if (typeof init.body !== "string") init.body = JSON.stringify(init.body);
  }
  const r = await fetch("/api" + path, init);
  const txt = await r.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = { detail: txt }; }
  if (!r.ok) {
    const d = data?.detail;
    // FastAPI 校验失败会返回 detail: {errors: [...]}
    if (d && typeof d === "object" && d.errors) {
      const e = new Error(d.message || "校验未通过");
      e.fieldErrors = d.errors; e.status = r.status; throw e;
    }
    const e = new Error(typeof d === "string" ? d : (data?.message || `HTTP ${r.status}`));
    e.status = r.status; e.data = data; throw e;
  }
  return data;
}

// 字节 / 时间格式化
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n >= 100 ? 0 : 2) + " " + u[i];
}
function fmtTime(s) {
  if (!s) return "—";
  const d = new Date(String(s).endsWith("Z") ? s : s + "Z");
  if (isNaN(d)) return String(s);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const ROLE_CN = { control: "控制节点", worker: "工作节点", database: "数据库", storage: "存储", gateway: "网关" };
const STATUS_CN = {
  locked: "待解锁", ready: "可执行", running: "执行中", passed: "已通过",
  failed: "失败", skipped: "已跳过", done: "已完成", partial: "部分完成",
  succeeded: "成功", pending: "待开始",
};
const FLOW_STATUS_CN = { running: "进行中", succeeded: "已完成", failed: "失败", pending: "待开始" };
const BACKUP_STATUS_CN = {
  pending: "待执行", running: "备份中", succeeded: "已完成", verified: "已校验",
  failed: "失败", expired: "已过期", restored: "已恢复",
};

// ---------------------------------------------------------------- 应用状态
const S = {
  tab: "overview",
  caps: { ssh: false, rsync: false },
  flowId: null,
  flow: null,
  stageKey: null,
  es: null,            // EventSource
  logs: [],            // 当前阶段日志
  steps: {},           // 当前阶段步骤快照
  running: false,
  draft: {},           // 表单草稿（key: field
  pkgs: [],
  backups: [],
  poll: null,
};

// ---------------------------------------------------------------- 导航
const TABS = [
  ["overview", "总览"],
  ["envs", "环境"],
  ["flows", "流程编排"],
  ["packages", "安装包"],
  ["backups", "备份点"],
];

function renderNav() {
  $("#nav").innerHTML = TABS.map(([k, t]) =>
    `<button data-tab="${k}" class="${S.tab === k ? "on" : ""}">${t}</button>`).join("");
}

function renderMode() {
  // 以后端给的「本次运行实际生效的模式」为准，而不是单纯看本机有没有 ssh：
  // 演示机上 ssh 是存在的，但 CLOUDOPS_FORCE_MOCK=1 时所有节点操作仍走模拟，
  // 只看 ssh 会显示成「真实模式」，与实际情况相反。
  const real = (S.caps.effective_mode || (S.caps.ssh ? "real" : "mock")) === "real";
  const why = S.caps.force_mock ? "（已强制模拟）" : "";
  $("#modePill").innerHTML = real
    ? `<span class="mode-pill real"><i class="dot"></i>真实模式 · SSH 可用</span>`
    : `<span class="mode-pill mock"><i class="dot"></i>模拟模式${why}</span>`;
}

// ---------------------------------------------------------------- 总览
async function viewOverview() {
  const o = await api("/overview");
  const bs = o.flows_by_status || {};
  return `
  <div class="stats">
    <div class="stat"><div class="l">环境</div><div class="v">${o.environments}</div>
      <div class="x">${o.nodes_total} 台节点（物理 ${o.nodes_physical} / 虚拟 ${o.nodes_virtual}）</div></div>
    <div class="stat"><div class="l">流程</div><div class="v">${o.flows_total}</div>
      <div class="x">进行中 ${bs.running || 0} · 已完成 ${bs.succeeded || 0} · 失败 ${bs.failed || 0}</div></div>
    <div class="stat"><div class="l">安装包</div><div class="v">${o.packages}</div>
      <div class="x">共 ${fmtBytes(o.packages_bytes)}</div></div>
    <div class="stat"><div class="l">备份点</div><div class="v">${o.backups}</div>
      <div class="x">${o.backups_restorable} 个可恢复 · ${fmtBytes(o.backups_bytes)}</div></div>
  </div>

  <div class="card" style="margin-top:18px">
    <div class="card-h"><h3>流程编排</h3><span class="sub">点击进入引导式向导</span>
      <span class="spacer"></span>
      <button class="btn primary sm" data-act="newflow">+ 新建安装流程</button>
      <button class="btn sm" data-act="newflow-upgrade">+ 新建升级流程</button></div>
    <div class="card-b tight">${flowTable(o.recent_flows || [], true)}</div>
  </div>

  <div class="card">
    <div class="card-h"><h3>环境</h3><span class="sub">按硬件类型分组的节点矩阵</span>
      <span class="spacer"></span>
      <button class="btn sm" data-act="newenv">+ 新建环境</button></div>
    <div class="card-b tight">${envTable(o.environments_detail || [])}</div>
  </div>

  <div class="card">
    <div class="card-h"><h3>操作审计</h3><span class="sub">最近 20 条</span></div>
    <div class="card-b tight"><div id="auditBox">加载中…</div></div>
  </div>`;
}

function flowTable(flows, compact) {
  if (!flows.length) return emptyBox("还没有流程", "创建一个安装流程开始编排", "newflow", "+ 新建流程");
  return `<table>
    <thead><tr><th>流程</th><th>模式</th><th>环境</th><th>进度</th><th>状态</th>
      ${compact ? "" : "<th>创建时间</th>"}<th></th></tr></thead>
    <tbody>${flows.map((f) => {
      const p = f.progress || { done: 0, total: 0 };
      const pct = p.total ? Math.round(p.done / p.total * 100) : 0;
      return `<tr>
        <td><b>${esc(f.name)}</b></td>
        <td><span class="tag ${f.mode === "upgrade" ? "purple" : "blue"}">${f.mode === "upgrade" ? "升级" : "安装"}</span></td>
        <td>${esc(f.env_name || "—")}</td>
        <td><div style="display:flex;align-items:center;gap:8px">
          <div class="prog" style="width:76px;margin:0"><i style="width:${pct}%"></i></div>
          <span class="mono" style="font-size:11.5px;color:var(--text-3)">${p.done}/${p.total}</span></div></td>
        <td><span class="tag ${statusTone(f.status)}">${FLOW_STATUS_CN[f.status] || f.status}</span></td>
        ${compact ? "" : `<td class="mono" style="font-size:12px;color:var(--text-3)">${fmtTime(f.created_at)}</td>`}
        <td style="text-align:right;white-space:nowrap">
          <button class="btn sm primary" data-act="openflow" data-id="${f.id}">进入向导</button>
          <button class="btn sm danger" data-act="delflow" data-id="${f.id}">删除</button>
        </td></tr>`;
    }).join("")}</tbody></table>`;
}

const statusTone = (s) => ({
  passed: "green", succeeded: "green", verified: "green", done: "green",
  ready: "blue", running: "blue",
  failed: "red", expired: "red",
  skipped: "gray", locked: "gray", pending: "gray",
  partial: "amber",
}[s] || "gray");

function envTable(envs) {
  if (!envs.length) return emptyBox("还没有环境", "先登记安装环境与节点", "newenv", "+ 新建环境");
  return `<table>
    <thead><tr><th>环境</th><th>节点</th><th>物理机</th><th>虚拟机</th><th>角色分布</th><th>K8s 版本</th><th></th></tr></thead>
    <tbody>${envs.map((e) => {
      const s = e.summary || {};
      const roles = Object.entries(s.by_role || {}).map(([k, v]) =>
        `${ROLE_CN[k] || k} ${v}`).join(" · ") || "—";
      return `<tr>
        <td><b>${esc(e.name)}</b><div style="font-size:11.5px;color:var(--text-3)">${esc(e.description || "")}</div></td>
        <td class="num">${s.total || 0}</td>
        <td class="num">${s.physical || 0}</td>
        <td class="num">${s.virtual || 0}</td>
        <td style="font-size:12.5px">${esc(roles)}</td>
        <td class="mono" style="font-size:12px">${esc(e.k8s_version || "—")}</td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn sm" data-act="viewenv" data-id="${e.id}">节点矩阵</button>
          <button class="btn sm danger" data-act="delenv" data-id="${e.id}">删除</button>
        </td></tr>`;
    }).join("")}</tbody></table>`;
}

function emptyBox(title, sub, act, btn) {
  return `<div class="empty">
    <div class="ic">◍</div><div class="t">${esc(title)}</div>
    <div class="s">${esc(sub)}</div>
    ${act ? `<button class="btn primary" data-act="${act}">${esc(btn)}</button>` : ""}
  </div>`;
}

// ---------------------------------------------------------------- 环境页
async function viewEnvs() {
  const envs = await api("/environments");
  return `<div class="card">
    <div class="card-h"><h3>环境列表</h3>
      <span class="sub">环境 = 一批待安装的节点，按物理机 / 虚拟机分组登记</span>
      <span class="spacer"></span>
      <button class="btn primary sm" data-act="newenv">+ 新建环境</button></div>
    <div class="card-b tight">${envTable(envs.map((e) => ({ ...e, summary: summarize(e) })))}</div>
  </div>`;
}

function summarize(e) {
  const nodes = e.nodes || [];
  const by_role = {};
  nodes.forEach((n) => { by_role[n.role] = (by_role[n.role] || 0) + 1; });
  return {
    total: nodes.length,
    by_role,
    by_type: nodes.reduce((a, n) => (a[n.machine_type] = (a[n.machine_type] || 0) + 1, a), {}),
    physical: nodes.filter((n) => n.machine_type === "physical").length,
    virtual: nodes.filter((n) => n.machine_type === "virtual").length,
  };
}

function nodeMatrixTable(nodes) {
  const tone = { installed: "green", reachable: "blue", prepared: "amber", unreachable: "red" };
  return `<div class="matrix-wrap"><table>
    <thead><tr><th>主机名</th><th>IP</th><th>角色</th><th>类型</th><th>规格 / 硬件</th>
      <th>状态</th><th>预检问题</th></tr></thead>
    <tbody>${nodes.map((n) => {
      const spec = n.machine_type === "physical"
        ? [n.vendor, n.model, n.idc && "@" + n.idc, n.rack && "RACK " + n.rack].filter(Boolean).join(" ")
        : [n.host_platform, n.vcpu && n.vcpu + "vCPU", n.memory_gb && n.memory_gb + "GB",
           n.disk_gb && n.disk_gb + "GB 盘"].filter(Boolean).join(" · ");
      return `<tr>
        <td><b>${esc(n.hostname)}</b></td>
        <td class="mono">${esc(n.ip)}</td>
        <td><span class="tag blue">${ROLE_CN[n.role] || n.role}</span></td>
        <td><span class="tag ${n.machine_type === "physical" ? "gray" : "purple"}">${n.machine_type === "physical" ? "物理机" : "虚拟机"}</span></td>
        <td style="font-size:12.5px;color:var(--text-2)">${esc(spec || "—")}</td>
        <td><span class="tag ${tone[n.status] || "gray"}">${n.status}</span></td>
        <td style="font-size:12px;color:var(--warn)">${esc((n.precheck_issues || []).join("；") || "—")}</td>
      </tr>`;
    }).join("")}</tbody></table></div>`;
}

async function openEnvMatrix(id) {
  const e = await api("/environments/" + id);
  const s = summarize(e);
  modal({
    title: `节点矩阵 · ${e.name}`, wide: true,
    body: `
      <div class="kv" style="margin-bottom:16px">
        <dt>节点总数</dt><dd>${s.total} 台（物理机 ${s.physical} / 虚拟机 ${s.virtual}）</dd>
        <dt>角色分布</dt><dd>${Object.entries(s.by_role).map(([k, v]) => `${ROLE_CN[k] || k} ${v}`).join(" · ") || "—"}</dd>
        <dt>K8s 版本</dt><dd class="mono">${esc(e.k8s_version || "—")}</dd>
        <dt>基础域名</dt><dd class="mono">${esc(e.base_domain || "—")}</dd>
        <dt>NTP</dt><dd class="mono">${esc(e.ntp_server || "—")} ${e.dns_servers?.length ? "· DNS " + e.dns_servers.join(",") : ""}</dd>
        <dt>时区</dt><dd class="mono">${esc(e.timezone || "—")}</dd>
      </div>
      ${nodeMatrixTable(e.nodes)}`,
    footer: `<button class="btn" data-close>关闭</button>`,
  });
}

// ---------------------------------------------------------------- 流程列表
async function viewFlows() {
  const flows = await api("/flows");
  return `<div class="card">
    <div class="card-h"><h3>流程编排</h3>
      <span class="sub">安装 / 升级 均以「阶段 → 步骤」形式串行推进，前一阶段通过后自动解锁下一阶段</span>
      <span class="spacer"></span>
      <button class="btn sm" data-act="newflow-upgrade">+ 新建升级流程</button>
      <button class="btn primary sm" data-act="newflow">+ 新建安装流程</button></div>
    <div class="card-b tight">${flowTable(flows, false)}</div>
  </div>`;
}

// ---------------------------------------------------------------- 安装包页
async function viewPackages() {
  const pkgs = await api("/packages");
  S.pkgs = pkgs;
  return `<div class="card">
    <div class="card-h"><h3>上传安装包</h3>
      <span class="sub">控制台接收本地文件；超过 64 MB 自动按分片记录校验和，支持断点续传</span></div>
    <div class="card-b">
      <div class="drop" id="drop">
        <div class="t">拖拽安装包到此处，或点击选择文件</div>
        <div class="s">支持 .tar.gz / .tgz / .zip / .bin，单文件建议不超过 4 GB</div>
        <input type="file" id="fileInput" hidden />
      </div>
      <div id="upProg"></div>
    </div>
  </div>
  <div class="card">
    <div class="card-h"><h3>包清单</h3><span class="sub">共 ${pkgs.length} 个</span></div>
    <div class="card-b tight">${pkgTable(pkgs)}</div>
  </div>`;
}

function pkgTable(pkgs) {
  if (!pkgs.length) return `<div class="empty"><div class="ic">◍</div>
    <div class="t">还没有安装包</div><div class="s">上传一个安装包，或在流程的「上传安装包」阶段上传</div></div>`;
  return `<table>
    <thead><tr><th>名称</th><th>版本</th><th>类型</th><th>大小</th><th>分片</th>
      <th>SHA256</th><th>上传时间</th><th></th></tr></thead>
    <tbody>${pkgs.map((p) => `<tr>
      <td><b>${esc(p.name)}</b></td>
      <td class="mono">${esc(p.version || "—")}</td>
      <td><span class="tag gray">${esc(p.kind)}</span></td>
      <td class="num">${fmtBytes(p.size_bytes)}</td>
      <td class="num">${(p.pieces || []).length || 1}</td>
      <td class="mono" style="font-size:11.5px;color:var(--text-3)">${esc(String(p.checksum).slice(0, 16))}…</td>
      <td class="mono" style="font-size:12px;color:var(--text-3)">${fmtTime(p.created_at)}</td>
      <td style="text-align:right"><button class="btn sm danger" data-act="delpkg" data-id="${p.id}">删除</button></td>
    </tr>`).join("")}</tbody></table>`;
}

// ---------------------------------------------------------------- 备份点页
async function viewBackups() {
  const bs = await api("/backups");
  S.backups = bs;
  if (!bs.length) return `<div class="card"><div class="card-h"><h3>备份点</h3></div>
    <div class="card-b">${emptyBox("还没有备份点", "备份点在流程的「安装前备份 / 升级前备份」阶段自动产生")}</div></div>`;
  return `<div class="card">
    <div class="card-h"><h3>备份点</h3>
      <span class="sub">共 ${bs.length} 个 · 备份最怕「以为备份了其实坏了」，因此每个备份点都可单独校验</span></div>
    <div class="card-b tight">${backupTable(bs)}</div>
  </div>`;
}

function backupTable(bs) {
  return `<table>
    <thead><tr><th>备份点</th><th>类型</th><th>节点</th><th>大小</th><th>保留至</th>
      <th>状态</th><th>完整性</th><th></th></tr></thead>
    <tbody>${bs.map((b) => `<tr>
      <td><b>${esc(b.name)}</b><div class="mono" style="font-size:11px;color:var(--text-3)">${esc(b.id)}</div></td>
      <td><span class="tag ${b.kind === "pre_upgrade" ? "purple" : "blue"}">${b.kind === "pre_upgrade" ? "升级前" : "安装前"}</span></td>
      <td class="num">${(b.nodes_covered || []).length}</td>
      <td class="num">${fmtBytes(b.size_bytes)}</td>
      <td class="mono" style="font-size:12px">${fmtTime(b.expire_at)}</td>
      <td><span class="tag ${statusTone(b.status)}">${BACKUP_STATUS_CN[b.status] || b.status}</span></td>
      <td>${b.verified_at ? `<span class="tag green">已校验</span>` : `<span class="tag gray">未校验</span>`}
        ${b.restorable ? `<span class="tag blue">可恢复</span>` : `<span class="tag red">不可恢复</span>`}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn sm" data-act="verifybk" data-id="${b.id}">校验</button>
        <button class="btn sm danger" data-act="restorebk" data-id="${b.id}"
          ${b.restorable ? "" : "disabled"}>恢复</button>
      </td></tr>`).join("")}</tbody></table>`;
}

// ---------------------------------------------------------------- 流程向导
async function openFlow(id, stageKey) {
  S.flowId = id;
  S.tab = "flows";
  S.stageKey = stageKey || null;
  await refreshFlow();
}

async function refreshFlow() {
  if (!S.flowId) return;
  const f = await api("/flows/" + S.flowId);
  S.flow = f;
  if (!S.stageKey || !f.stages.some((s) => s.key === S.stageKey)) {
    const active = f.stages.find((s) => s.status === "running" || s.status === "failed")
      || f.stages.find((s) => s.status === "ready") || f.stages[0];
    S.stageKey = active.key;
  }
  render();
  // 切阶段时重建日志流
  if (S.running || (S.flow.stages.find((s) => s.key === S.stageKey)?.steps || []).length) {
    loadStageLogs();
  }
}

async function loadStageLogs() {
  try {
    const hist = await api(`/flows/${S.flowId}/stages/${S.stageKey}/logs`);
    S.logs = hist.filter((e) => e.type === "log");
    S.steps = {};
    hist.filter((e) => e.type === "step").forEach((e) => { S.steps[e.step.id] = e.step; });
  } catch { S.logs = []; }

  const f = await api("/flows/" + S.flowId);
  S.flow = f;
  const st = f.stages.find((s) => s.key === S.stageKey);
  S.running = st?.status === "running";
  renderStagePanel();
  if (S.running) attachStream();
}

/** 轮询等待某阶段结束，作为 SSE 的兜底（不依赖长连接可靠性）。 */
function pollStageUntilDone() {
  clearInterval(S.poll);
  S.poll = setInterval(async () => {
    try {
      const f = await api("/flows/" + S.flowId);
      S.flow = f;
      const st = f.stages.find((s) => s.key === S.stageKey);
      if (!st) return;
      const live = await api(`/flows/${S.flowId}/stages/${S.stageKey}/logs`);
      const steps = live.filter((e) => e.type === "step");
      if (steps.length) {
        steps.forEach((e) => { S.steps[e.step.id] = e.step; });
        renderSteps();
      }
      if (st.status !== "running") {
        clearInterval(S.poll); S.poll = null;
        S.running = false;
        const idx = f.stages.findIndex((s) => s.key === S.stageKey);
        const next = f.stages.find(
          (s, i) => i > idx && (s.status === "ready" || s.status === "failed"));
        if (next && next.key !== S.stageKey) {
          S.stageKey = next.key; S.steps = {}; S.logs = [];
        }
        await refreshFlow();
      } else {
        S.running = true;
      }
    } catch { /* 忽略瞬时错误，下一次 tick 重试 */ }
  }, 1200);
}

function attachStream() {
  // 只关掉上一条 SSE，不动轮询 —— 否则 runStage 里先 attachStream 再
  // pollStageUntilDone 的顺序会被打乱。
  if (S.es) { try { S.es.close(); } catch { /* ignore */ } S.es = null; }
  const key = S.stageKey;
  const url = `/api/flows/${S.flowId}/stages/${S.stageKey}/stream`;
  const es = new EventSource(url);
  S.es = es;
  es.onmessage = (ev) => {
    let d; try { d = JSON.parse(ev.data); } catch { return; }
    if (d.type === "log") {
      S.logs.push(d);
      appendLog(d);
    } else if (d.type === "step") {
      S.steps[d.step.id] = d.step;
      renderSteps();
    } else if (d.type === "stage_done") {
      S.running = false;
      if (d.status === "passed") toast("阶段执行完成", "ok");
      else if (d.status === "failed") toast("阶段执行失败：" + (d.error || ""), "err", 6000);
      // 通过后自动把焦点挪到下一个可执行阶段 —— 否则用户会盯着一个
      // 已经没有「执行」按钮的旧阶段发呆，不知道下一步该点哪。
      const justKey = key;
      setTimeout(async () => {
        await refreshFlow();
        if (d.status === "passed") {
          const f = S.flow;
          const idx = f.stages.findIndex((s) => s.key === justKey);
          const next = f.stages.find(
            (s, i) => i > idx && (s.status === "ready" || s.status === "failed"));
          if (next && next.key !== S.stageKey) {
            S.stageKey = next.key; S.steps = {}; S.logs = [];
            render();
            await loadStageLogs();
          }
        }
      }, 350);
      // 服务端发完这条就会关连接，让浏览器自然结束即可，
      // 主动 close() 会在控制台留下 ERR_ABORTED，看着像出错了。
      S.es = null;
    }
  };
  es.onerror = async () => {
    // 连接断开：判断阶段是否已到终态 —— 到了就彻底收工，
    // 否则说明服务端还没发 stage_done（网络抖动等），交给轮询兜底。
    S.es = null;
    try { es.close(); } catch { /* ignore */ }
    const st = S.flow?.stages?.find((s) => s.key === S.stageKey);
    if (st && st.status !== "running") {
      S.running = false;
      await refreshFlow();
    }
  };
  es.onopen = () => { /* 已连上 */ };
}
function detachStream() {
  if (S.poll) { clearInterval(S.poll); S.poll = null; }
  if (S.es) { try { S.es.close(); } catch { /* ignore */ } S.es = null; }
}

function appendLog(e) {
  const box = $("#logBox");
  if (!box) return;
  const span = document.createElement("div");
  span.className = "l-" + (e.level || "info");
  span.textContent = `[${(e.ts || "").slice(11, 19)}] ${e.message}`;
  box.appendChild(span);
  box.scrollTop = box.scrollHeight;
}

function renderSteps() {
  const box = $("#stepBox");
  if (!box) return;
  const list = Object.values(S.steps);
  if (!list.length) { box.innerHTML = `<div style="color:var(--text-3);font-size:13px">尚未开始执行</div>`; return; }
  box.innerHTML = list.map((s) => {
    const ic = s.status === "running" ? `<span class="spin"></span>`
      : s.status === "passed" ? `<span style="color:var(--ok);font-weight:700">✓</span>`
      : s.status === "failed" ? `<span style="color:var(--danger);font-weight:700">✕</span>`
      : s.status === "skipped" ? `<span style="color:var(--text-3)">–</span>`
      : `<span style="color:var(--text-3)">○</span>`;
    return `<div class="srow">
      <span class="ic">${ic}</span>
      <span class="nm"><span class="h">${esc(s.title)}</span>
        ${s.output ? `<div class="o">${esc(s.output)}</div>` : ""}
        ${s.error ? `<div class="o" style="color:var(--danger)">${esc(s.error)}</div>` : ""}</span>
      <span class="ms">${s.duration_ms ? s.duration_ms + " ms" : ""}</span>
    </div>`;
  }).join("");
}

// ---- 阶段面板渲染
function renderStagePanel() {
  const host = $("#stagePanel");
  if (!host || !S.flow) return;
  const f = S.flow;
  const st = f.stages.find((s) => s.key === S.stageKey);
  if (!st) { host.innerHTML = ""; return; }
  const idx = f.stages.findIndex((s) => s.key === st.key);
  const blocker = upstreamBlocker(f, idx);

  const hasSteps = (st.steps || []).length > 0 || Object.keys(S.steps).length > 0;
  const showForm = ["ready", "passed", "failed"].includes(st.status) && !S.running;
  const canRun = (st.status === "ready" || st.status === "failed") && !blocker;

  host.innerHTML = `
    <div class="card">
      <div class="stage-h">
        <span class="num">${idx + 1}</span>
        <div><div class="ttl">${esc(st.title)}
          ${st.required ? "" : `<span class="tag purple" style="margin-left:6px">可选</span>`}
          <span class="tag ${statusTone(st.status)}" style="margin-left:6px">${STATUS_CN[st.status]}</span></div></div>
        <span class="spacer"></span>
        ${canRun ? `<button class="btn primary" data-act="runstage">
          ${st.status === "failed" ? "重试执行" : "执行本阶段"}</button>` : ""}
        ${S.running ? `<button class="btn danger" data-act="cancelstage">取消执行</button>` : ""}
        ${!st.required && st.status !== "skipped" && !S.running
          ? `<button class="btn" data-act="skipstage" ${blocker ? "disabled" : ""}>跳过</button>` : ""}
        ${st.status === "skipped"
          ? `<button class="btn" data-act="unskipstage">取消跳过</button>` : ""}
      </div>
      <div class="stage-h" style="padding-top:0;border-bottom:1px solid var(--border)">
        <div class="desc">${esc(st.description || "")}</div>
      </div>

      ${blocker ? `<div class="stage-sec"><div class="err-list">
        前置阶段「${esc(blocker)}」尚未通过，本阶段暂不可执行。</div></div>` : ""}

      ${st.error ? `<div class="stage-sec"><div class="err-list">
        <b>上次执行失败</b><div>${esc(st.error)}</div></div></div>` : ""}

      ${showForm && (st.form_fields || []).length ? `<div class="stage-sec">
        <div class="sec-t">阶段表单</div>
        <div id="formHost">${renderForm(st, f)}</div>
        <div id="formErrs"></div>
      </div>` : ""}

      ${st.key === "package_upload" ? `<div class="stage-sec">
        <div class="sec-t">控制台上传</div>
        ${renderUploadInline(st)}
      </div>` : ""}

      ${hasSteps ? `<div class="stage-sec">
        <div class="sec-t">执行步骤</div><div class="steplist" id="stepBox"></div></div>` : ""}

      ${S.logs.length || S.running ? `<div class="stage-sec">
        <div class="sec-t">实时日志</div>
        <div class="logbox" id="logBox">${S.logs.map((e) =>
          `<div class="l-${e.level || "info"}">[${String(e.ts || "").slice(11, 19)}] ${esc(e.message)}</div>`).join("")}</div>
      </div>` : ""}
    </div>`;
  renderSteps();
  const lb = $("#logBox"); if (lb) lb.scrollTop = lb.scrollHeight;
  if (S.running && !S.es) attachStream();
  // 阶段内上传区是在 HTML 里渲染出来的，必须在这里补绑事件，
  // 否则拖拽区看着能点、点了没反应。
  const sDrop = $("#sDrop"), sFile = $("#sFile");
  if (sDrop && sFile) bindDrop(sDrop, sFile, (f) => handleInlineUpload(f));
}

async function handleInlineUpload(file) {
  const host = $("#sProg");
  if (!host) return;
  try {
    const p = await doUpload(file, host);
    toast(`上传成功：${p.name} · ${fmtBytes(p.size_bytes)}`, "ok", 5000);
    // 把包元信息直接写进本地阶段输入 —— 不要依赖 S.pkgs（那是安装包页才加载的），
    // 否则版本号回填会落空，紧接着的必填校验必然失败。
    const st = S.flow?.stages?.find((s) => s.key === "package_upload");
    if (st) {
      st.inputs._package_id = p.id;
      st.inputs._package_ids = [...new Set([...(st.inputs._package_ids || []), p.id])];
      st.inputs.package_version = p.version || st.inputs.package_version || "";
      st.inputs.package_kind = p.kind || st.inputs.package_kind || "bundle";
      st.inputs.expected_size = p.size_bytes || st.inputs.expected_size;
    }
    S.pkgs = [...(S.pkgs || []).filter((x) => x.id !== p.id), p];
    // 落盘到服务端，否则 refreshFlow() 会把本地回填冲掉
    try {
      await api(`/flows/${S.flowId}/stages/package_upload/inputs`, {
        method: "POST",
        body: {
          inputs: {
            _package_id: p.id,
            _package_ids: st ? st.inputs._package_ids : [p.id],
            package_version: p.version || "",
            package_kind: p.kind || "bundle",
            expected_size: p.size_bytes || 0,
          },
          operator: "admin",
        },
      });
    } catch { /* 版本号缺失时服务端会拒绝，但包已上传；让用户自己补填 */ }
    await refreshFlow();
  } catch (e) {
    host.innerHTML = `<div class="err-list" style="margin-top:12px">上传失败：${esc(e.message)}</div>`;
    toast("上传失败：" + e.message, "err", 5600);
  }
}

function upstreamBlocker(f, idx) {
  if (idx === 0) return null;
  for (let i = 0; i < idx; i++) {
    const s = f.stages[i];
    if (s.status !== "passed" && s.status !== "skipped") return `${i + 1}. ${s.title}`;
  }
  return null;
}

// ---- 动态表单
function renderForm(st, flow) {
  const inp = { ...(st.inputs || {}) };
  const fields = st.form_fields || [];

  // 上传安装包阶段：把已上传包的元信息回填到表单，省得用户再手抄一遍版本号。
  if (st.key === "package_upload" && inp._package_id) {
    const p = (S.pkgs || []).find((x) => x.id === inp._package_id);
    if (p) {
      if (!inp.package_version && p.version) inp.package_version = p.version;
      if (!inp.package_kind && p.kind) inp.package_kind = p.kind;
      if (!inp.expected_size && p.size_bytes) inp.expected_size = p.size_bytes;
    }
  }

  const grid = fields.filter((f) => f.type !== "node_table");
  const nodeTables = fields.filter((f) => f.type === "node_table");

  let html = `<div class="fgrid">${grid.map((f) => renderField(f, inp[f.key])).join("")}</div>`;

  // 节点矩阵（按硬件类型分组）
  nodeTables.forEach((f) => {
    const groups = (f.groups && f.groups.length) ? f.groups : [
      f.key === "physical_nodes"
        ? { key: "physical_nodes", title: "物理机节点", fields: PHYS_FIELDS }
        : { key: "virtual_nodes", title: "虚拟机节点", fields: VIRT_FIELDS },
    ];
    groups.forEach((g) => { html += renderNodeTable(g, inp); });
  });
  return html;
}

const PHYS_FIELDS = [
  { key: "hostname", label: "主机名", width: 130 },
  { key: "ip", label: "IP", width: 120 },
  { key: "role", label: "角色", type: "role", width: 100 },
  { key: "vendor", label: "厂商", width: 90 },
  { key: "model", label: "型号", width: 150 },
  { key: "idc", label: "机房", width: 100 },
  { key: "rack", label: "机柜", width: 80 },
  { key: "nic_speed", label: "网卡", width: 80 },
  { key: "raid_level", label: "RAID", width: 80 },
  { key: "ssh_key_path", label: "SSH 私钥路径", width: 170 },
];
const VIRT_FIELDS = [
  { key: "hostname", label: "主机名", width: 130 },
  { key: "ip", label: "IP", width: 120 },
  { key: "role", label: "角色", type: "role", width: 100 },
  { key: "host_platform", label: "虚拟化平台", width: 160 },
  { key: "vcpu", label: "vCPU", type: "number", width: 70 },
  { key: "memory_gb", label: "内存 GB", type: "number", width: 80 },
  { key: "disk_gb", label: "磁盘 GB", type: "number", width: 80 },
  { key: "image_template", label: "镜像模板", width: 140 },
  { key: "ssh_key_path", label: "SSH 私钥路径", width: 170 },
];

function renderField(f, val) {
  const req = f.required ? `<span class="req">*</span>` : "";
  const hint = f.hint ? `<div class="hint">${esc(f.hint)}</div>` : "";
  const wide = f.type === "textarea" ? " wide" : "";
  let ctrl = "";

  if (f.type === "select") {
    ctrl = `<select data-fk="${f.key}">${(f.options || []).map((o) => {
      const v = typeof o === "string" ? o : o.value;
      const l = typeof o === "string" ? o : (o.label || o.value);
      return `<option value="${esc(v)}" ${String(val) === String(v) ? "selected" : ""}>${esc(l)}</option>`;
    }).join("")}</select>`;
  } else if (f.type === "multiselect") {
    const cur = Array.isArray(val) ? val : (f.default || []);
    ctrl = `<div class="opts" data-ms="${f.key}">${(f.options || []).map((o) => {
      const v = typeof o === "string" ? o : o.value;
      const l = typeof o === "string" ? o : (o.label || o.value);
      return `<span class="opt ${cur.includes(v) ? "on" : ""}" data-v="${esc(v)}">${esc(l)}</span>`;
    }).join("")}</div>`;
  } else if (f.type === "boolean") {
    ctrl = `<label class="check"><input type="checkbox" data-fk="${f.key}"
      ${(val ?? f.default) ? "checked" : ""} /> ${esc(f.checkbox_label || "是")}</label>`;
  } else if (f.type === "number") {
    ctrl = `<input type="number" data-fk="${f.key}" value="${val ?? f.default ?? ""}"
      placeholder="${esc(f.placeholder || "")}" />`;
  } else if (f.type === "textarea") {
    const s = Array.isArray(val) ? val.join("\n") : (val ?? "");
    ctrl = `<textarea data-fk="${f.key}" placeholder="${esc(f.placeholder || "")}">${esc(s)}</textarea>`;
  } else {
    ctrl = `<input type="text" data-fk="${f.key}" value="${esc(val ?? f.default ?? "")}"
      placeholder="${esc(f.placeholder || "")}" />`;
  }
  return `<div class="field${wide}"><label>${esc(f.label)}${req}</label>${ctrl}${hint}</div>`;
}

function renderNodeTable(g, inp) {
  const rows = inp[g.key] || [];
  return `<div class="matrix-head">
      <span class="t">${esc(g.title)}</span>
      <span class="n">${rows.length} 台</span>
      <span class="spacer"></span>
      <button class="btn sm" data-act="addnode" data-g="${g.key}">+ 添加一行</button>
      <button class="btn sm" data-act="filldemo" data-g="${g.key}">填入示例</button>
    </div>
    <div class="matrix-wrap"><table>
      <thead><tr><th style="width:34px"></th>${g.fields.map((f) =>
        `<th style="min-width:${f.width || 100}px">${esc(f.label)}</th>`).join("")}<th style="width:40px"></th></tr></thead>
      <tbody id="tb-${g.key}">${rows.map((r, i) => nodeRow(g, r, i)).join("")}</tbody>
    </table></div>`;
}

function nodeRow(g, r, i) {
  return `<tr datarow="${i}">${g.fields.map((f) => {
    const v = r[f.key] ?? "";
    if (f.type === "role") {
      return `<td><select data-datak="${g.key}.${i}.${f.key}">${Object.entries(ROLE_CN).map(([k, l]) =>
        `<option value="${k}" ${v === k ? "selected" : ""}>${l}</option>`).join("")}</select></td>`;
    }
    if (f.type === "number") {
      return `<td><input type="number" data-datak="${g.key}.${i}.${f.key}" value="${esc(v)}" /></td>`;
    }
    return `<td><input type="text" data-datak="${g.key}.${i}.${f.key}" value="${esc(v)}"
      placeholder="${esc(f.label)}" /></td>`;
  }).join("")}<td style="text-align:center"><span class="row-del" data-act="delrow"
      data-g="${g.key}" data-i="${i}">×</span></td></tr>`;
}

// 从 DOM 收集表单 → inputs 对象
function collectInputs(st) {
  const out = {};
  const fields = st.form_fields || [];

  $$("[data-fk]", $("#stagePanel")).forEach((el) => {
    const k = el.dataset.fk;
    if (el.type === "checkbox") out[k] = el.checked;
    else if (el.tagName === "TEXTAREA") {
      const fd = fields.find((f) => f.key === k);
      out[k] = fd?.type === "textarea" && fd.multiline_list
        ? el.value.split("\n").map((s) => s.trim()).filter(Boolean)
        : el.value;
    } else if (el.tagName === "SELECT") {
      out[k] = el.value;
    } else {
      const fd = fields.find((f) => f.key === k);
      if (fd?.type === "number") {
        const n = parseInt(el.value, 10);
        if (!isNaN(n)) out[k] = n;
      } else out[k] = el.value;
    }
  });

  $$("[data-ms]", $("#stagePanel")).forEach((box) => {
    out[box.dataset.ms] = $$(".opt.on", box).map((o) => o.dataset.v);
  });

  fields.filter((f) => f.type === "node_table").forEach((f) => {
    (f.groups || [{ key: f.key }]).forEach((grp) => {
      const g = grp.key;
      const tb = $(`#tb-${g}`);
      if (!tb) return;
      out[g] = $$("tr[datarow]", tb).map((tr) => {
        const o = {};
        $$("[data-datak]", tr).forEach((el) => {
          const parts = String(el.dataset.datak || el.getAttribute("data-datak") || "").split(".");
          const key = parts[parts.length - 1];
          if (!key) return;
          let v = el.value;
          if (el.type === "number") v = v === "" ? null : parseInt(v, 10);
          o[key] = v;
        });
        return o;
      }).filter((o) => o.hostname || o.ip);
    });
  });
  return out;
}

// ---------------------------------------------------------------- 上传（独立页 + 阶段内）
function bindDrop(zone, input, onFile) {
  zone.addEventListener("click", () => input.click());
  input.addEventListener("change", () => { if (input.files[0]) onFile(input.files[0]); });
  ["dragenter", "dragover"].forEach((ev) => zone.addEventListener(ev, (e) => {
    e.preventDefault(); zone.classList.add("over");
  }));
  ["dragleave", "drop"].forEach((ev) => zone.addEventListener(ev, (e) => {
    e.preventDefault(); zone.classList.remove("over");
  }));
  zone.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0];
    if (f) onFile(f);
  });
}

function doUpload(file, progHost) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("name", file.name.replace(/\.(tar\.gz|tgz|zip|bin)$/i, ""));
    const m = file.name.match(/v?(\d+\.\d+(\.\d+)?)/);
    if (m) fd.append("version", "v" + m[1]);
    fd.append("kind", "bundle");
    if (S.flowId) fd.append("flow_id", S.flowId);

    progHost.innerHTML = `<div class="prog"><i style="width:0"></i></div>
      <div style="font-size:12.5px;color:var(--text-3);margin-top:7px">
      正在上传 ${esc(file.name)} · ${fmtBytes(file.size)}</div>`;

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/packages/upload");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round(e.loaded / e.total * 100);
        $(".prog > i", progHost).style.width = pct + "%";
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({}); }
      } else {
        let msg = `HTTP ${xhr.status}`;
        try { msg = JSON.parse(xhr.responseText).detail || msg; } catch {}
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error("网络错误"));
    xhr.send(fd);
  });
}

function renderUploadInline(st) {
  const ids = st.inputs?._package_ids || [];
  const pkgs = (S.pkgs || []).filter((p) => ids.includes(p.id) || ids.length === 0).slice(0, 6);
  return `<div class="drop" id="sDrop">
      <div class="t">拖拽安装包到此处，或点击选择文件</div>
      <div class="s">上传完成后自动关联到本阶段，可直接执行</div>
      <input type="file" id="sFile" hidden />
    </div>
    <div id="sProg"></div>
    ${ids.length ? `<div style="margin-top:14px;font-size:13px">
      <b>已关联 ${ids.length} 个包：</b>
      ${ids.map((i) => {
        const p = (S.pkgs || []).find((x) => x.id === i);
        return p ? `<span class="tag blue" style="margin-left:6px">${esc(p.name)} ${esc(p.version || "")} · ${fmtBytes(p.size_bytes)}</span>`
                 : `<span class="tag gray" style="margin-left:6px">${esc(i)}</span>`;
      }).join("")}
    </div>` : ""}`;
}

// ---------------------------------------------------------------- 渲染主入口
function render() {
  renderNav();
  const v = $("#view");
  if (S.flow && S.tab === "flows") {
    v.innerHTML = flowWizardHtml();
    renderStagePanel();
    return;
  }
  v.innerHTML = `<div class="empty"><div class="ic">◍</div><div class="t">加载中…</div></div>`;
}

function flowWizardHtml() {
  const f = S.flow;
  const p = f.progress || { done: 0, total: 0 };
  return `
  <div class="flow-bar">
    <button class="btn sm ghost" data-act="backflows">← 流程列表</button>
    <span class="name">${esc(f.name)}</span>
    <span class="tag ${f.mode === "upgrade" ? "purple" : "blue"}">${f.mode === "upgrade" ? "升级" : "安装"}</span>
    <span class="tag ${statusTone(f.status)}">${FLOW_STATUS_CN[f.status] || f.status}</span>
    <span class="spacer"></span>
    <span style="font-size:12.5px;color:var(--text-3)">环境 <b>${esc(f.env_name || "—")}</b></span>
    <div class="prog" style="width:110px;margin:0"><i style="width:${p.total ? p.done / p.total * 100 : 0}%"></i></div>
    <span class="mono" style="font-size:12px;color:var(--text-3)">${p.done}/${p.total} 阶段</span>
  </div>
  <div class="wizard">
    <aside class="rail">
      <div class="rail-h">阶段</div>
      ${f.stages.map((s, i) => `
        <div class="step ${s.status} ${s.key === S.stageKey ? "on" : ""}" data-act="selstage" data-k="${s.key}">
          <span class="idx">${s.status === "passed" ? "✓" : s.status === "failed" ? "!" : i + 1}</span>
          <span class="body">
            <span class="t">${esc(s.title)} ${s.required ? "" : `<span class="opt">可选</span>`}</span>
            <span class="d">${esc(STATUS_CN[s.status] || s.status)}${(s.steps || []).length ? ` · ${(s.steps || []).length} 步` : ""}</span>
          </span>
        </div>`).join("")}
      ${f.mode === "install" ? "" : ""}
      <div style="padding:12px 10px 6px;border-top:1px solid var(--border);margin-top:8px">
        <div style="font-size:11px;color:var(--text-3);line-height:1.6">
          阶段按顺序推进：前一阶段「已通过」后，下一阶段才会从锁定变为可执行。
        </div>
      </div>
    </aside>
    <section class="stage-panel" id="stagePanel"></section>
  </div>`;
}

// ---------------------------------------------------------------- 事件总线
document.addEventListener("click", async (e) => {
  const tabBtn = e.target.closest("nav.nav button");
  if (tabBtn) {
    S.tab = tabBtn.dataset.tab;
    if (S.tab !== "flows") { detachStream(); S.flowId = null; S.flow = null; }
    render(); await loadTab(); return;
  }

  const opt = e.target.closest(".opt");
  if (opt) { opt.classList.toggle("on"); return; }

  const act = e.target.closest("[data-act]");
  if (!act) return;
  const a = act.dataset.act;
  const id = act.dataset.id;

  try {
    switch (a) {
      case "backflows":
        detachStream(); S.flowId = null; S.flow = null;
        render(); await loadTab(); break;
      case "openflow":
        await openFlow(id); break;
      case "selstage":
        if (act.classList.contains("locked")) { toast("该阶段尚未解锁", "warn"); return; }
        if (S.running) { toast("当前阶段正在执行，请先等待完成", "warn"); return; }
        S.stageKey = act.dataset.k; S.steps = {}; S.logs = [];
        renderStagePanel(); await loadStageLogs(); break;
      case "newflow": await createFlow("install"); break;
      case "newflow-upgrade": await createFlow("upgrade"); break;
      case "delflow": await delFlow(id); break;
      case "newenv": await newEnvDialog(); break;
      case "viewenv": await openEnvMatrix(id); break;
      case "delenv":
        if (!confirm("删除该环境？已关联的流程不会自动删除。")) return;
        await api("/environments/" + id, { method: "DELETE" });
        toast("环境已删除", "ok"); await loadTab(); break;
      case "delpkg":
        if (!confirm("删除该安装包？")) return;
        await api("/packages/" + id, { method: "DELETE" });
        toast("已删除", "ok"); await loadTab(); break;

      case "addnode": addNodeRow(act.dataset.g); break;
      case "filldemo": fillDemo(act.dataset.g); break;
      case "delrow": {
        const g = act.dataset.g, i = +act.dataset.i;
        const st = S.flow.stages.find((s) => s.key === S.stageKey);
        if (!st) break;
        let rows = [];
        try { rows = collectInputs(st)[g] || []; } catch { rows = st.inputs[g] || []; }
        rows.splice(i, 1);
        persistDraft(st, g, rows);
        renderStagePanel();
        break;
      }

      case "runstage": await runStage(); break;
      case "cancelstage":
        await api(`/flows/${S.flowId}/stages/${S.stageKey}/cancel`, { method: "POST" });
        toast("已请求取消", "warn"); break;
      case "skipstage": await skipStage(false); break;
      case "unskipstage": {
        const f = await api("/flows/" + S.flowId);
        const st = f.stages.find((s) => s.key === S.stageKey);
        st.status = "ready"; st.finished_at = null;
        // 直接改库：走一次 inputs 提交触发 refresh_locks
        await api(`/flows/${S.flowId}/stages/${S.stageKey}/inputs`,
          { method: "POST", body: { inputs: {}, operator: "admin" } }).catch(() => {});
        toast("已取消跳过，请重新执行", "ok");
        await refreshFlow(); break;
      }

      case "verifybk": await verifyBackup(id); break;
      case "restorebk": await restoreBackup(id); break;
    }
  } catch (err) {
    if (err.fieldErrors) {
      showFieldErrors(err.fieldErrors);
      toast("表单校验未通过", "err");
    } else {
      toast(err.message || "操作失败", "err", 5600);
    }
  }
});

// 节点矩阵输入同步（input 事件委托）
document.addEventListener("input", (e) => {
  const el = e.target.closest?.("[data-datak]");
  if (!el || !S.flow || !S.flow.stages) return;
  const st = S.flow.stages.find((s) => s.key === S.stageKey);
  if (!st) return;
  const parts = String(el.dataset.datak || el.getAttribute("data-datak") || "").split(".");
  if (parts.length < 3) return;
  const g = parts[0], i = parseInt(parts[1], 10), k = parts[2];
  if (!g || !k || isNaN(i)) return;
  if (!Array.isArray(st.inputs[g])) st.inputs[g] = [];
  if (!st.inputs[g][i]) st.inputs[g][i] = {};
  let v = el.value;
  if (el.type === "number") v = v === "" ? null : parseInt(v, 10);
  st.inputs[g][i][k] = v;
});

document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal($(".modal-bg:last-child")); });

// ---------------------------------------------------------------- 表单错误提示
function showFieldErrors(errors) {
  const host = $("#formErrs");
  const html = `<div class="err-list" style="margin-top:14px"><b>表单校验未通过</b>
    ${errors.map((x) => `<div>· ${esc(typeof x === "string" ? x : (x.message || JSON.stringify(x)))}</div>`).join("")}</div>`;
  if (host) host.innerHTML = html; else toast(errors.join("；"), "err", 6000);
}

// ---------------------------------------------------------------- 动作实现
async function loadTab() {
  render();
  try {
    if (S.tab === "overview") {
      $("#view").innerHTML = await viewOverview();
      loadAudit();
    } else if (S.tab === "envs") $("#view").innerHTML = await viewEnvs();
    else if (S.tab === "flows") {
      if (S.flowId) { await refreshFlow(); }
      else $("#view").innerHTML = await viewFlows();
    } else if (S.tab === "packages") {
      $("#view").innerHTML = await viewPackages();
      bindDrop($("#drop"), $("#fileInput"), (f) => handleUpload(f, $("#upProg")));
    } else if (S.tab === "backups") $("#view").innerHTML = await viewBackups();
  } catch (e) { toast(e.message, "err"); }
}

async function loadAudit() {
  try {
    const rows = await api("/audit?limit=20");
    const box = $("#auditBox");
    if (!box) return;
    if (!rows.length) { box.innerHTML = `<div style="padding:16px 18px;color:var(--text-3);font-size:13px">暂无记录</div>`; return; }
    box.innerHTML = `<table><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>结果</th><th>备注</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td class="mono" style="font-size:12px;color:var(--text-3)">${fmtTime(r.created_at || r.ts)}</td>
        <td>${esc(r.operator || "—")}</td>
        <td class="mono" style="font-size:12px">${esc(r.action)}</td>
        <td><span class="tag ${r.result === "ok" ? "green" : "amber"}">${esc(r.result || "")}</span></td>
        <td style="font-size:12.5px;color:var(--text-2)">${esc(r.detail || "—")}</td>
      </tr>`).join("")}</tbody></table>`;
  } catch { /* 静默 */ }
}

async function createFlow(mode) {
  const envs = await api("/environments");
  if (!envs.length) { toast("请先创建环境", "warn"); S.tab = "envs"; render(); return loadTab(); }
  const bg = modal({
    title: `新建${mode === "upgrade" ? "升级" : "安装"}流程`,
    body: `<div class="fgrid">
      <div class="field wide"><label>流程名称<span class="req">*</span></label>
        <input type="text" id="fName" value="${mode === "upgrade" ? "生产主中心升级" : "生产主中心安装"}" /></div>
      <div class="field wide"><label>目标环境<span class="req">*</span></label>
        <select id="fEnv">${envs.map((e) => `<option value="${e.id}">${esc(e.name)} · ${(e.nodes || []).length} 台节点</option>`).join("")}</select>
        <div class="hint">${mode === "upgrade" ? "升级流程会复用该环境中已登记的节点" : "安装流程的第 1 阶段会自动带入该环境的节点作为初始值"}</div></div>
    </div>`,
    footer: `<button class="btn" data-close>取消</button>
      <button class="btn primary" id="fOk">创建并进入向导</button>`,
  });
  $("#fOk", bg).onclick = async () => {
    const name = $("#fName", bg).value.trim();
    if (!name) return toast("请填写流程名称", "warn");
    const f = await api("/flows", { method: "POST", body: {
      name, env_id: $("#fEnv", bg).value, mode } });
    closeModal(bg);
    toast("流程已创建", "ok");
    S.tab = "flows";
    await openFlow(f.id);
  };
}

async function delFlow(id) {
  if (!confirm("删除该流程？审计记录会保留。")) return;
  await api("/flows/" + id, { method: "DELETE" });
  if (S.flowId === id) { detachStream(); S.flowId = null; S.flow = null; }
  toast("流程已删除", "ok");
  await loadTab();
}

function addNodeRow(g) {
  const st = S.flow.stages.find((s) => s.key === S.stageKey);
  if (!st) return;
  let cur = [];
  try { cur = collectInputs(st)[g] || []; } catch { cur = st.inputs[g] || []; }
  const rows = [...cur, { role: g === "physical_nodes" ? "control" : "worker" }];
  persistDraft(st, g, rows);
  renderStagePanel();
}

/** 把某一组节点行写回阶段输入（同时同步到本地 + 服务端草稿）。 */
function persistDraft(st, g, rows) {
  try {
    const all = { ...(st.inputs || {}), ...collectInputs(st) };
    all[g] = rows;
    st.inputs = all;
  } catch {
    st.inputs[g] = rows;
  }
}

function fillDemo(g) {
  const st = S.flow.stages.find((s) => s.key === S.stageKey);
  if (!st) return;
  let cur = [];
  try { cur = collectInputs(st)[g] || []; } catch { cur = st.inputs[g] || []; }
  const demo = g === "physical_nodes"
    ? [
        { hostname: "ctrl-phy-01", ip: "10.20.1.11", role: "control", vendor: "Dell", model: "PowerEdge R750", idc: "SH-IDC-01", rack: "A-01", nic_speed: "25GE", raid_level: "RAID10", ssh_user: "root" },
        { hostname: "ctrl-phy-02", ip: "10.20.1.12", role: "control", vendor: "Dell", model: "PowerEdge R750", idc: "SH-IDC-01", rack: "A-02", nic_speed: "25GE", raid_level: "RAID10", ssh_user: "root" },
        { hostname: "ctrl-phy-03", ip: "10.20.1.13", role: "control", vendor: "H3C", model: "UniServer R4900 G5", idc: "SH-IDC-01", rack: "A-03", nic_speed: "25GE", raid_level: "RAID10", ssh_user: "root" },
        { hostname: "db-phy-01", ip: "10.20.1.21", role: "database", vendor: "Huawei", model: "FusionServer 2288H V6", idc: "SH-IDC-01", rack: "B-01", nic_speed: "25GE", raid_level: "RAID10", ssh_user: "root" },
      ]
    : [
        { hostname: "worker-vm-01", ip: "10.20.2.31", role: "worker", host_platform: "VMware vSphere 8.0", vcpu: 16, memory_gb: 64, disk_gb: 500, image_template: "ubuntu-2204-k8s-v1.29", ssh_user: "root" },
        { hostname: "worker-vm-02", ip: "10.20.2.32", role: "worker", host_platform: "VMware vSphere 8.0", vcpu: 16, memory_gb: 64, disk_gb: 500, image_template: "ubuntu-2204-k8s-v1.29", ssh_user: "root" },
        { hostname: "worker-vm-03", ip: "10.20.2.33", role: "worker", host_platform: "VMware vSphere 8.0", vcpu: 16, memory_gb: 64, disk_gb: 500, image_template: "ubuntu-2204-k8s-v1.29", ssh_user: "root" },
        { hostname: "worker-vm-04", ip: "10.20.2.34", role: "worker", host_platform: "KVM/oVirt", vcpu: 16, memory_gb: 64, disk_gb: 500, image_template: "ubuntu-2204-k8s-v1.29", ssh_user: "root" },
        { hostname: "worker-vm-05", ip: "10.20.2.35", role: "worker", host_platform: "KVM/oVirt", vcpu: 16, memory_gb: 64, disk_gb: 500, image_template: "ubuntu-2204-k8s-v1.29", ssh_user: "root" },
        { hostname: "gw-vm-01", ip: "10.20.3.41", role: "gateway", host_platform: "VMware vSphere 8.0", vcpu: 8, memory_gb: 32, disk_gb: 300, image_template: "ubuntu-2204-k8s-v1.29", ssh_user: "root" },
      ];
  // 用户已填的行优先（按位置覆盖），其余用示例补齐
  const merged = demo.map((d, i) => ({ ...d, ...(cur[i] || {}) }));
  persistDraft(st, g, merged);
  toast(`已填入 ${merged.length} 台${g === "physical_nodes" ? "物理机" : "虚拟机"}示例`, "ok");
  renderStagePanel();
}

async function runStage() {
  if (S.running) return;
  const st = S.flow.stages.find((s) => s.key === S.stageKey);
  // 服务端产物（如上传接口回填的 _package_id / _package_ids）不在表单里，
  // 必须与 DOM 采集结果合并，否则一提交就被覆盖成空、校验必然失败。
  const inputs = { ...(st.inputs || {}), ...collectInputs(st) };

  // 先校验再落盘（避免把坏数据写进库）
  const v = await api(`/flows/${S.flowId}/stages/${S.stageKey}/validate`,
    { method: "POST", body: { inputs, operator: "admin" } });
  if (!v.valid) { showFieldErrors(v.errors); toast("表单校验未通过", "err"); return; }

  await api(`/flows/${S.flowId}/stages/${S.stageKey}/inputs`,
    { method: "POST", body: { inputs, operator: "admin" } });

  // 阶段本身由引擎执行（env_register 会把节点矩阵落库；其余阶段走各自动作）
  await api(`/flows/${S.flowId}/stages/${S.stageKey}/run`,
    { method: "POST", body: { operator: "admin" } });

  S.logs = []; S.steps = {}; S.running = true;
  renderStagePanel();
  attachStream();
  pollStageUntilDone();
  toast("阶段开始执行", "ok");
}

async function skipStage() {
  const st = S.flow.stages.find((s) => s.key === S.stageKey);
  if (!confirm(`跳过阶段「${st.title}」？该阶段不会执行任何操作。`)) return;
  await api(`/flows/${S.flowId}/stages/${S.stageKey}/skip`,
    { method: "POST", body: { operator: "admin" } });
  toast("已跳过", "ok");
  await refreshFlow();
}

async function handleUpload(file, progHost) {
  try {
    const p = await doUpload(file, progHost);
    toast(`上传成功：${p.name} · ${fmtBytes(p.size_bytes)}${p.pieces_count > 1 ? ` · ${p.pieces_count} 分片` : ""}`, "ok", 5000);
    await loadTab();
  } catch (e) {
    progHost.innerHTML = `<div class="err-list" style="margin-top:12px">上传失败：${esc(e.message)}</div>`;
    toast("上传失败：" + e.message, "err", 5600);
  }
}

async function verifyBackup(id) {
  const r = await api(`/backups/${id}/verify`, { method: "POST" });
  modal({
    title: r.ok ? "校验通过" : "校验失败",
    body: `<div class="${r.ok ? "" : "err-list"}">
        <div style="font-size:14px;font-weight:600;margin-bottom:10px">
          ${r.ok ? "✓ 备份完整，可正常恢复" : "✕ 校验和不一致，备份可能已损坏"}</div>
      </div>
      <dl class="kv" style="margin-top:14px">
        <dt>文件数量</dt><dd>${r.files}</dd>
        <dt>实际大小</dt><dd>${fmtBytes(r.size_bytes)}</dd>
        <dt>登记校验和</dt><dd class="mono">${esc(r.expected)}…</dd>
        <dt>实算校验和</dt><dd class="mono">${esc(r.actual)}…</dd>
      </dl>`,
    footer: `<button class="btn" data-close>关闭</button>`,
  });
  await loadTab();
}

async function restoreBackup(id) {
  const b = (S.backups || []).find((x) => x.id === id) || await api("/backups/" + id);
  const bg = modal({
    title: "恢复备份点",
    body: `<div class="err-list">
        <b>⚠️ 恢复操作会覆盖目标节点上的现有数据</b>
        <div style="margin-top:6px">备份点 <b>${esc(b.name)}</b>，覆盖 ${(b.nodes_covered || []).length} 台节点，大小 ${fmtBytes(b.size_bytes)}。</div>
      </div>
      <div style="margin-top:14px;font-size:13px">覆盖节点：</div>
      <div class="opts" style="margin-top:8px">
        ${(b.nodes_covered || []).map((n) => `<span class="tag gray">${esc(n)}</span>`).join("")}
      </div>
      <label class="check" style="margin-top:16px">
        <input type="checkbox" id="ck" /> 我已确认，理解该操作不可撤销</label>`,
    footer: `<button class="btn" data-close>取消</button>
      <button class="btn danger" id="rOk" disabled>确认恢复</button>`,
  });
  const ok = $("#rOk", bg), ck = $("#ck", bg);
  ck.onchange = () => { ok.disabled = !ck.checked; };
  ok.onclick = async () => {
    try {
      const r = await api(`/backups/${id}/restore`, { method: "POST",
        body: { confirm: true, operator: "admin" } });
      closeModal(bg);
      modal({ title: "恢复完成",
        body: `<div style="font-size:13px;margin-bottom:12px">已恢复 ${r.restored_nodes.length} 台节点</div>
          <div class="logbox">${esc(r.detail)}</div>`,
        footer: `<button class="btn" data-close>关闭</button>` });
      toast("恢复完成", "ok");
      await loadTab();
    } catch (e) { toast(e.message, "err", 5600); }
  };
}

async function newEnvDialog() {
  const bg = modal({
    title: "新建环境",
    body: `<div class="fgrid">
      <div class="field wide"><label>环境名称<span class="req">*</span></label>
        <input type="text" id="eName" placeholder="如：生产主中心-上海" /></div>
      <div class="field"><label>K8s 版本</label>
        <input type="text" id="eVer" value="v1.29.4" /></div>
      <div class="field"><label>基础域名</label>
        <input type="text" id="eDom" placeholder="corp.local" /></div>
      <div class="field"><label>NTP 服务器</label>
        <input type="text" id="eNtp" placeholder="ntp.corp.local" /></div>
      <div class="field"><label>时区</label>
        <input type="text" id="eTz" value="Asia/Shanghai" /></div>
      <div class="field wide"><label>描述</label>
        <input type="text" id="eDesc" placeholder="可选" /></div>
    </div>
    <div class="hint" style="margin-top:12px">节点在流程的「环境登记」阶段按物理机 / 虚拟机分组录入。</div>`,
    footer: `<button class="btn" data-close>取消</button>
      <button class="btn primary" id="eOk">创建</button>`,
  });
  $("#eOk", bg).onclick = async () => {
    const name = $("#eName", bg).value.trim();
    if (!name) return toast("请填写环境名称", "warn");
    await api("/environments", { method: "POST", body: {
      name, description: $("#eDesc", bg).value.trim(),
      k8s_version: $("#eVer", bg).value.trim(),
      base_domain: $("#eDom", bg).value.trim(),
      ntp_server: $("#eNtp", bg).value.trim(),
      timezone: $("#eTz", bg).value.trim(),
    }});
    closeModal(bg);
    toast("环境已创建", "ok");
    await loadTab();
  };
}

// ---------------------------------------------------------------- 启动
(async function boot() {
  try { S.caps = await api("/capabilities"); } catch { S.caps = { ssh: false, rsync: false }; }
  renderMode();
  renderNav();
  await loadTab();
  // 模式提示必须显式告知：否则用户看到节点都在"成功"却不知道这些结果是模拟出来的。
  if (S.caps.mock_notice) {
    toast(S.caps.mock_notice, S.caps.force_mock ? "" : "warn", 6000);
  }
})();
