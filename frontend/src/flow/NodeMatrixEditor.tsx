import { Button } from "../components/ui/Button";
import { ROLE_CN } from "../lib/labels";
import type { ColumnDef, FieldGroup, FormField, NodeRole } from "../api/types";

/**
 * 一行节点。`__id` 只服务 React key 与行定位：后端建节点时逐键取值
 * （ApiController.java:280-316 的 n.get("hostname") 等），多余键被忽略；
 * Json.java:13 也关了 FAIL_ON_UNKNOWN_PROPERTIES。
 */
export type NodeRow = Record<string, unknown> & { __id?: string };

const ROLES = Object.keys(ROLE_CN) as NodeRole[];

/** 角色留空时后端 NodeRole.fromValue 回退 WORKER（NodeRole.java:25-29），初值与之对齐。 */
const FALLBACK_ROLE: NodeRole = "worker";

const BOOT = Math.random().toString(36).slice(2, 6);
let seq = 0;
const nextId = () => `${BOOT}-${++seq}`;

const cellCls =
  "w-full rounded-btn border border-line bg-panel px-1.5 py-1 font-mono text-xs outline-none focus:border-brand";

const DEMO: Record<string, NodeRow[]> = {
  physical_nodes: [
    { hostname: "ctrl-phy-01", ip: "10.10.0.11", role: "control", vendor: "Dell", model: "PowerEdge R750", idc: "AZ1-A", rack: "R01", nic_speed: "25GbE", raid_level: "RAID10", ssh_key_path: "" },
    { hostname: "ctrl-phy-02", ip: "10.10.0.12", role: "control", vendor: "Dell", model: "PowerEdge R750", idc: "AZ1-A", rack: "R02", nic_speed: "25GbE", raid_level: "RAID10", ssh_key_path: "" },
    { hostname: "ctrl-phy-03", ip: "10.10.0.13", role: "control", vendor: "Dell", model: "PowerEdge R750", idc: "AZ1-A", rack: "R03", nic_speed: "25GbE", raid_level: "RAID10", ssh_key_path: "" },
    { hostname: "db-phy-01", ip: "10.10.0.21", role: "database", vendor: "Huawei", model: "2288H V6", idc: "AZ1-A", rack: "R04", nic_speed: "25GbE", raid_level: "RAID10", ssh_key_path: "" },
  ],
  virtual_nodes: [
    { hostname: "worker-vm-01", ip: "10.10.1.21", role: "worker", host_platform: "VMware vSphere 8", vcpu: 16, memory_gb: 64, disk_gb: 500, image_template: "rocky9-tpl-v3", ssh_key_path: "" },
    { hostname: "worker-vm-02", ip: "10.10.1.22", role: "worker", host_platform: "VMware vSphere 8", vcpu: 16, memory_gb: 64, disk_gb: 500, image_template: "rocky9-tpl-v3", ssh_key_path: "" },
    { hostname: "worker-vm-03", ip: "10.10.1.23", role: "worker", host_platform: "VMware vSphere 8", vcpu: 16, memory_gb: 64, disk_gb: 500, image_template: "rocky9-tpl-v3", ssh_key_path: "" },
    { hostname: "worker-vm-04", ip: "10.10.1.24", role: "worker", host_platform: "VMware vSphere 8", vcpu: 16, memory_gb: 64, disk_gb: 500, image_template: "rocky9-tpl-v3", ssh_key_path: "" },
    { hostname: "gw-vm-01", ip: "10.10.1.31", role: "gateway", host_platform: "VMware vSphere 8", vcpu: 8, memory_gb: 32, disk_gb: 200, image_template: "rocky9-tpl-v3", ssh_key_path: "" },
  ],
};

const blankRow = (cols: ColumnDef[]): NodeRow => {
  const row: NodeRow = { __id: nextId() };
  for (const c of cols) row[c.key] = c.type === "role" ? FALLBACK_ROLE : "";
  return row;
};

const demoRows = (key: string, fallback: NodeRow[]): NodeRow[] => {
  const preset = DEMO[key];
  if (!preset) return [...fallback];
  return preset.map((r) => ({ ...r, __id: nextId() }));
};

const cellText = (v: unknown): string =>
  typeof v === "number" || typeof v === "string" ? String(v) : "";

export interface NodeMatrixEditorProps {
  field: FormField;
  value: NodeRow[];
  onChange: (v: NodeRow[]) => void;
  disabled?: boolean;
}

/** 目录驱动的节点矩阵：列、分组、标题全部来自 field.groups，前端不写死任何列。 */
export function NodeMatrixEditor({ field, value, onChange, disabled }: NodeMatrixEditorProps) {
  const groups: FieldGroup[] =
    field.groups && field.groups.length > 0
      ? field.groups
      : [{ key: field.key, title: field.label, fields: [] }];
  const rows = Array.isArray(value) ? value : [];
  const rowId = (r: NodeRow, i: number) =>
    typeof r.__id === "string" && r.__id !== "" ? r.__id : `srv-${i}`;

  const setCell = (ri: number, key: string, v: unknown) =>
    onChange(rows.map((r, i) => (i === ri ? { ...r, [key]: v } : r)));

  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <div key={g.key} className="overflow-x-auto rounded-card border border-line">
          <header className="flex items-center justify-between gap-2 border-b border-line bg-canvas px-3 py-2">
            <span className="text-xs font-semibold text-ink-soft">
              {g.title} · {rows.length} 台
            </span>
            {g.fields.length > 0 && (
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => onChange([...rows, blankRow(g.fields)])}
                >
                  + 添加一台
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => onChange(demoRows(g.key, rows))}
                >
                  填充演示数据
                </Button>
              </div>
            )}
          </header>

          {g.fields.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-ink-mute">
              目录未下发该字段的列定义，无法在页面上登记节点。
            </p>
          ) : rows.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-ink-mute">
              暂无节点。可「添加一台」逐台填写，或「填充演示数据」快速走通流程。
            </p>
          ) : (
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="text-left text-[11px] font-semibold text-ink-mute">
                  {g.fields.map((c) => (
                    <th key={c.key} className="whitespace-nowrap px-2 py-1.5" style={{ width: c.width }}>
                      {c.label}
                    </th>
                  ))}
                  <th className="w-10 px-2 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, ri) => (
                    <tr key={rowId(r, ri)} className="border-t border-line">
                      {g.fields.map((c) => {
                        const raw = r[c.key];
                        return (
                          <td key={c.key} className="px-1.5 py-1">
                            {c.type === "role" ? (
                              <select
                                aria-label={c.label}
                                disabled={disabled}
                                className={cellCls}
                                value={cellText(raw)}
                                onChange={(e) => setCell(ri, c.key, e.target.value)}
                              >
                                {!ROLES.includes(cellText(raw) as NodeRole) && (
                                  <option value={cellText(raw)}>{cellText(raw) || "（未填写）"}</option>
                                )}
                                {ROLES.map((x) => (
                                  <option key={x} value={x}>{ROLE_CN[x]}</option>
                                ))}
                              </select>
                            ) : (
                              <input
                                aria-label={c.label}
                                disabled={disabled}
                                type={c.type === "number" ? "number" : "text"}
                                className={cellCls}
                                value={cellText(raw)}
                                onChange={(e) => setCell(ri, c.key, e.target.value)}
                              />
                            )}
                          </td>
                        );
                      })}
                      <td className="px-1.5 py-1 text-right">
                        <button
                          type="button"
                          disabled={disabled}
                          aria-label={`删除第 ${ri + 1} 台`}
                          className="text-ink-mute hover:text-danger disabled:opacity-40"
                          onClick={() => onChange(rows.filter((_, i) => i !== ri))}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );
}
