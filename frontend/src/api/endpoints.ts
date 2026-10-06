import { api } from "./client";
import type {
  AuditRecord, BackupPoint, Capabilities, Environment, EnvironmentInput, Flow, FlowCreate,
  FlowDetail, FlowStage, FlowSummary, NodeSpecInput, OkResult, Overview,
  PackageEntry, RestoreResult, StreamEvent, UploadChunkResult, UploadInit, UploadStatus,
  ValidateResult, VerifyResult,
} from "./types";

export const qk = {
  caps: ["capabilities"] as const,
  overview: ["overview"] as const,
  // env(id) 是 envs 的子键：invalidateQueries({queryKey: qk.envs}) 前缀匹配已同时刷新列表与详情
  envs: ["environments"] as const,
  env: (id: string) => ["environments", id] as const,
  flows: (limit = 100) => ["flows", limit] as const,
  flow: (id: string) => ["flows", "detail", id] as const,
  packages: ["packages"] as const,
  backups: (envId?: string) => ["backups", envId ?? "all"] as const,
  audit: (limit = 200) => ["audit", limit] as const,
  stageLogs: (flowId: string, key: string) => ["flows", flowId, "stages", key, "logs"] as const,
};

const qs = (o: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

/** 历史日志事件：与 SSE 流同构，但永不含 close 事件（close 仅在 stream 端点内即时生成，不进 LogBus 历史）。 */
export type StageLogEvent = Exclude<StreamEvent, { type: "close" }>;

export const endpoints = {
  capabilities: () => api.get<Capabilities>("/api/capabilities"),
  overview: () => api.get<Overview>("/api/overview"),
  audit: (limit = 200) => api.get<AuditRecord[]>(`/api/audit${qs({ limit })}`),

  listEnvs: () => api.get<Environment[]>("/api/environments"),
  getEnv: (id: string) => api.get<Environment>(`/api/environments/${id}`),
  createEnv: (body: EnvironmentInput) => api.post<Environment>("/api/environments", body),
  deleteEnv: (id: string) => api.del<OkResult>(`/api/environments/${id}`),
  addNodes: (id: string, nodes: NodeSpecInput[]) =>
    api.post<{ ok: boolean; total: number }>(`/api/environments/${id}/nodes`, nodes),

  listFlows: (limit = 100) => api.get<FlowSummary[]>(`/api/flows${qs({ limit })}`),
  getFlow: (id: string) => api.get<FlowDetail>(`/api/flows/${id}`),
  createFlow: (body: FlowCreate) => api.post<Flow>("/api/flows", body),
  deleteFlow: (id: string) => api.del<OkResult>(`/api/flows/${id}`),

  // 后端返回 {ok, inputs, nodes}（nodes 为环境节点数），不回传 stage 对象。
  submitStageInputs: (flowId: string, key: string, inputs: Record<string, unknown>) =>
    api.post<{ ok: boolean; inputs: Record<string, unknown>; nodes: number }>(
      `/api/flows/${flowId}/stages/${key}/inputs`, { inputs }),
  validateStage: (flowId: string, key: string, inputs: Record<string, unknown>) =>
    api.post<ValidateResult>(`/api/flows/${flowId}/stages/${key}/validate`, { inputs }),
  runStage: (flowId: string, key: string, body: { operator?: string; confirm?: boolean }) =>
    api.post<OkResult & { stage: string; status: string }>(`/api/flows/${flowId}/stages/${key}/run`, body),
  cancelStage: (flowId: string, key: string) =>
    api.post<OkResult>(`/api/flows/${flowId}/stages/${key}/cancel`),
  skipStage: (flowId: string, key: string, operator = "admin") =>
    api.post<{ ok: boolean; stage: FlowStage }>(`/api/flows/${flowId}/stages/${key}/skip`, { operator }),
  stageLogs: (flowId: string, key: string) =>
    api.get<StageLogEvent[]>(`/api/flows/${flowId}/stages/${key}/logs`),
  rollback: (flowId: string, revision?: number) =>
    api.post<Record<string, unknown>>(`/api/flows/${flowId}/rollback`, revision == null ? {} : { revision }),

  listPackages: () => api.get<PackageEntry[]>("/api/packages"),
  deletePackage: (id: string) => api.del<OkResult>(`/api/packages/${id}`),
  uploadPackage: (fd: FormData) => api.post<PackageEntry & { pieces_count: number }>("/api/packages/upload", fd),
  initUpload: (body: { name: string; version?: string; kind?: string; size_bytes: number; chunk_size?: number; flow_id?: string }) =>
    api.post<UploadInit>("/api/packages/upload/init", body),
  // 分片与合并都可能被取消，故接 signal；单次上传/建会话/问进度一把就走，取消无从谈起，不给 signal 入口
  uploadChunk: (uploadId: string, index: number, blob: Blob, filename: string, signal?: AbortSignal) => {
    const fd = new FormData();
    fd.append("upload_id", uploadId);
    fd.append("chunk_index", String(index));
    fd.append("file", blob, filename);
    return api.post<UploadChunkResult>("/api/packages/upload/chunk", fd, { signal });
  },
  uploadStatus: (uploadId: string) => api.get<UploadStatus>(`/api/packages/upload/${uploadId}`),
  completeUpload: (uploadId: string, signal?: AbortSignal) =>
    api.post<PackageEntry & { pieces_count: number }>(`/api/packages/upload/${uploadId}/complete`, {}, { signal }),

  listBackups: (envId?: string) => api.get<BackupPoint[]>(`/api/backups${qs({ envId })}`),
  verifyBackup: (id: string) => api.post<VerifyResult>(`/api/backups/${id}/verify`),
  restoreBackup: (id: string, body: { backup_id?: string; node_ids: string[]; confirm: boolean }) =>
    api.post<RestoreResult>(`/api/backups/${id}/restore`, body),
  expireBackup: (id: string) => api.post<OkResult>(`/api/backups/${id}/expire`),
};
