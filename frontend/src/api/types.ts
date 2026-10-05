/**
 * 后端契约唯一真源 —— 与 backend-java 的 Jackson 序列化结果逐字段对齐。
 *
 * 规则：
 * - 所有 JSON 字段为 snake_case（后端模型与 DTO 均标注 @JsonNaming(SnakeCaseStrategy)）。
 * - 时间字段为 `yyyy-MM-dd'T'HH:mm:ss` 无时区后缀的字符串。
 * - 本文件只允许类型（interface / type alias），不得出现任何运行时值、enum 或 const 对象
 *   （tsconfig: verbatimModuleSyntax + isolatedModules，消费方必须 `import type`）。
 */

export type NodeRole = "control" | "worker" | "database" | "storage" | "gateway";
export type MachineType = "physical" | "virtual";
export type NodeStatus = "unknown" | "reachable" | "unreachable" | "prepared" | "installed";
export type StageStatus = "locked" | "ready" | "running" | "passed" | "failed" | "skipped";
export type StepStatus = "pending" | "running" | "done" | "partial" | "failed" | "skipped";
export type FlowStatus = "draft" | "running" | "paused" | "succeeded" | "failed" | "aborted";
export type FlowMode = "install" | "upgrade" | "upgrade_k8s";
export type BackupKind = "pre_install" | "pre_upgrade";
export type BackupStatus =
  | "pending" | "running" | "succeeded" | "verified" | "failed" | "expired" | "restored";
export type FieldType =
  | "text" | "number" | "select" | "boolean" | "textarea" | "node_table" | "multiselect";
export type LogLevel = "info" | "ok" | "warn" | "error";

export interface NodeSpec {
  id: string;
  hostname: string;
  ip: string;
  role: NodeRole;
  machine_type: MachineType;
  ssh_port: number;
  ssh_user: string;
  ssh_key_path?: string | null;
  ssh_password_set?: boolean;
  vendor?: string | null;
  model?: string | null;
  idc?: string | null;
  rack?: string | null;
  nic_speed?: string | null;
  raid_level?: string | null;
  host_platform?: string | null;
  vcpu?: number | null;
  memory_gb?: number | null;
  disk_gb?: number | null;
  image_template?: string | null;
  status: NodeStatus;
  os_release?: string | null;
  kernel?: string | null;
  cpu_cores?: number | null;
  mem_total_gb?: number | null;
  disk_free_gb?: number | null;
  last_checked_at?: string | null;
  precheck_issues: string[];
}

export interface NodeSpecInput {
  hostname: string;
  ip: string;
  role: NodeRole;
  machine_type: MachineType;
  ssh_port: number;
  ssh_user: string;
  ssh_key_path?: string | null;
  vendor?: string | null;
  model?: string | null;
  idc?: string | null;
  rack?: string | null;
  nic_speed?: string | null;
  raid_level?: string | null;
  host_platform?: string | null;
  vcpu?: number | null;
  memory_gb?: number | null;
  disk_gb?: number | null;
  image_template?: string | null;
}

export interface EnvSummary {
  total: number;
  by_role: Partial<Record<NodeRole, number>>;
  by_type: Partial<Record<MachineType, number>>;
  physical: number;
  virtual: number;
}

export interface Environment {
  id: string;
  name: string;
  description: string;
  base_domain: string;
  ntp_server: string;
  dns_servers: string[];
  timezone: string;
  nodes: NodeSpec[];
  validated: boolean;
  validation_issues: string[];
  created_at: string;
  updated_at: string;
  /** GET /environments 与 GET /environments/{id} 附带；POST 返回的裸 EnvironmentSpec 无此字段。 */
  summary?: EnvSummary;
}

export interface EnvironmentInput {
  name: string;
  description?: string;
  base_domain?: string;
  ntp_server?: string;
  dns_servers?: string[];
  timezone?: string;
}

export interface ColumnDef {
  key: string;
  label: string;
  width?: number;
  type?: "role" | "number" | "text";
}

export interface FieldGroup {
  key: string;
  title: string;
  fields: ColumnDef[];
}

export interface FieldOption {
  value: string;
  label: string;
}

export interface FormField {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  placeholder: string;
  help: string;
  hint: string;
  default?: unknown;
  options?: FieldOption[];
  multiline_list?: boolean;
  groups?: FieldGroup[];
}

export interface StepState {
  id: string;
  index: number;
  title: string;
  detail: string;
  action: string;
  args: Record<string, unknown>;
  status: StepStatus;
  output: string;
  error?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  duration_ms: number;
}

export interface FlowStage {
  key: string;
  index: number;
  title: string;
  description: string;
  form_fields: FormField[];
  inputs: Record<string, unknown>;
  required: boolean;
  status: StageStatus;
  steps: StepState[];
  started_at?: string | null;
  finished_at?: string | null;
  error?: string | null;
}

export interface Flow {
  id: string;
  name: string;
  env_id: string;
  mode: FlowMode;
  status: FlowStatus;
  stages: FlowStage[];
  current_stage: number;
  operator: string;
  created_at: string;
  updated_at: string;
  finished_at?: string | null;
  error?: string | null;
  backup_point_id?: string | null;
}

export interface FlowProgress { done: number; total: number }

/** POST /api/flows 请求体 —— 与 dto/FlowCreate 对齐（无 operator 字段，后端固定写 "admin"）。 */
export interface FlowCreate { name: string; env_id: string; mode: FlowMode }
export interface FlowSummary extends Flow { progress: FlowProgress }
export interface FlowDetail extends FlowSummary {
  env_name: string;
  env_summary: EnvSummary;
  nodes: NodeSpec[];
}

export interface PackagePiece { index: number; size_bytes: number; checksum: string }

export interface PackageEntry {
  id: string;
  name: string;
  version: string;
  kind: string;
  size_bytes: number;
  checksum: string;
  pieces: PackagePiece[];
  upload_complete: boolean;
  uploaded_bytes: number;
  path: string;
  storage: string;
  target_env_id?: string | null;
  created_at: string;
  note: string;
  progress: number;
}

export interface BackupPoint {
  id: string;
  name: string;
  kind: BackupKind;
  env_id: string;
  flow_id?: string | null;
  include_paths: string[];
  include_databases: string[];
  /** 与后端 BackupPoint.includePathsAllowGlob 同步：false 时目录逐项加引号，true 时由远端 shell 展开 */
  include_paths_allow_glob: boolean;
  include_config: boolean;
  retention_days: number;
  status: BackupStatus;
  size_bytes: number;
  checksum: string;
  path: string;
  nodes_covered: string[];
  started_at?: string | null;
  finished_at?: string | null;
  expire_at?: string | null;
  verified_at?: string | null;
  restorable: boolean;
  error?: string | null;
}

export interface Capabilities {
  ssh: boolean;
  rsync: boolean;
  force_mock: boolean;
  effective_mode: "real" | "mock";
  mock_notice: string;
}

export interface Overview {
  environments: number;
  flows_total: number;
  flows_by_status: Record<string, number>;
  packages: number;
  packages_bytes: number;
  backups: number;
  backups_bytes: number;
  backups_restorable: number;
  nodes_total: number;
  nodes_physical: number;
  nodes_virtual: number;
  recent_flows: (FlowSummary & { env_name: string })[];
  environments_detail: (Environment & { summary: EnvSummary })[];
}

export interface AuditRecord {
  id: number;
  ts: string;
  operator: string;
  action: string;
  target: string;
  result: string;
  detail: string;
}

export interface K8sCluster {
  id: string;
  name: string;
  kubeconfig: string;
  namespace: string;
  context: string;
  created_at: string;
}

export interface VerifyResult {
  ok: boolean;
  files: number;
  size_bytes: number;
  expected: string;
  actual: string;
  message: string;
}

export interface RestoreResult { ok: boolean; restored_nodes: string[]; detail: string }

export interface UploadInit {
  upload_id: string;
  name: string;
  size_bytes: number;
  chunk_size: number;
  total_chunks: number;
  flow_id: string;
}

export interface UploadStatus {
  upload_id: string;
  name: string;
  size_bytes: number;
  uploaded_bytes: number;
  chunk_size: number;
  total_chunks: number;
  done_chunks: number[];
  progress: number;
  complete: boolean;
}

export interface UploadChunkResult {
  upload_id: string;
  chunk_index: number;
  received_bytes: number;
  checksum: string;
  progress: number;
}

/** 建连时服务端先重放 LogBus 历史并给每帧加 replay 标记，实时帧无标记（ApiController.java:420-426）。 */
export type StreamEvent =
  | { type: "log"; level: LogLevel; message: string; ts: string; replay?: boolean }
  | { type: "step"; stage: string; step: StepState; ts?: string; replay?: boolean }
  | { type: "stage_done"; stage: string; status: StageStatus; error?: string | null; ts?: string; replay?: boolean }
  | { type: "close"; status: StageStatus };

export interface ValidateResult { valid: boolean; errors: string[] }
export interface OkResult { ok: boolean }
