import type {
  BackupKind,
  BackupStatus,
  FlowMode,
  FlowStatus,
  MachineType,
  NodeRole,
  NodeStatus,
  StageStatus,
  StepStatus,
} from "../api/types";

export const ROLE_CN: Record<NodeRole, string> = {
  control: "控制节点", worker: "工作节点", database: "数据库节点", storage: "存储节点", gateway: "网关节点",
};

export const TYPE_CN: Record<MachineType, string> = { physical: "物理机", virtual: "虚拟机" };

export const STATUS_CN: Record<NodeStatus, string> = {
  unknown: "未检测", reachable: "可达", unreachable: "不可达", prepared: "已就绪", installed: "已安装",
};

export const STAGE_CN: Record<StageStatus, string> = {
  locked: "未解锁", ready: "待执行", running: "执行中", passed: "已通过", failed: "失败", skipped: "已跳过",
};

export const STEP_CN: Record<StepStatus, string> = {
  pending: "待执行", running: "执行中", done: "已完成", partial: "部分完成", failed: "失败", skipped: "已跳过",
};

export const FLOW_STATUS_CN: Record<FlowStatus, string> = {
  draft: "草稿", running: "进行中", paused: "已暂停", succeeded: "成功", failed: "失败", aborted: "已中止",
};

export const BACKUP_STATUS_CN: Record<BackupStatus, string> = {
  pending: "待执行", running: "进行中", succeeded: "已完成", verified: "已校验",
  failed: "失败", expired: "已过期", restored: "已恢复",
};

export const BACKUP_KIND_CN: Record<BackupKind, string> = {
  pre_install: "安装前", pre_upgrade: "升级前",
};

/**
 * 词表按后端枚举（BackupKind.java 只有这两个值）建，但页面上拿到的是从库里读回的字符串：
 * 换版或手工写库都可能溢出词表，未命中原样显示，别让表格单元格空着。
 * 与 StatusTag 的 `MAP[kind][value] ?? value` 同一口径。
 */
export function backupKindLabel(kind: string): string {
  return (BACKUP_KIND_CN as Record<string, string>)[kind] ?? kind;
}

export const KIND_CN: Record<string, string> = {
  bundle: "安装包", chart: "Helm Chart", image: "镜像", config: "配置",
};

/**
 * 审计 result 有独立词表：ok / started / mismatch 来自接口与 UploadService，
 * passed / skipped / failed 直接是 StageStatus.getValue()，与流程状态不同集合。
 */
export const AUDIT_CN: Record<string, string> = {
  ok: "成功", started: "已发起", passed: "已通过", skipped: "已跳过",
  failed: "失败", mismatch: "校验不符",
};

export type Tone = "ok" | "warn" | "danger" | "brand" | "mute" | "purple";

const TONE: Record<string, Tone> = {
  ok: "ok", passed: "ok", done: "ok", completed: "ok", succeeded: "ok", verified: "ok", restored: "ok",
  reachable: "ok", installed: "ok",
  ready: "brand", running: "brand", prepared: "brand", started: "brand",
  failed: "danger", unreachable: "danger", aborted: "danger", mismatch: "danger",
  degraded: "warn", paused: "warn", partial: "warn",
  locked: "mute", skipped: "mute", pending: "mute", unknown: "mute", draft: "mute", expired: "mute",
};

export const statusTone = (s: string): Tone => TONE[s] ?? "mute";

export function modeLabel(mode: FlowMode | string): string {
  if (mode === "install") return "全新安装";
  if (mode === "upgrade") return "原地升级";
  if (mode === "upgrade_k8s") return "K8s / Helm 升级";
  return mode;
}

export const MODE_OPTIONS: { value: FlowMode; label: string; hint: string }[] = [
  { value: "install", label: "全新安装", hint: "7 阶段 · 环境登记到安装后验证" },
  { value: "upgrade", label: "原地升级", hint: "5 阶段 · 备份基线到升级后验证" },
  { value: "upgrade_k8s", label: "K8s / Helm 升级", hint: "6 阶段 · Helm release 升级，含回滚预案" },
];
