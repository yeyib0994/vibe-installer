import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { endpoints, qk } from "../api/endpoints";
import type { EnvironmentInput, FlowCreate } from "../api/types";

/**
 * 改动环境 / 流程 / 安装包后，除了各自的列表还要失效总览：
 * 总览是一份聚合计数（`ApiController.java:837-848` 里 packages / environments / flows_by_status
 * 全在那里加总），而 queryClient 的 staleTime 是 5s —— 不失效它，删完切回总览最多 5 秒仍是旧数字。
 * K8s 集群不进总览，所以那两个 mutation 不走这里。
 */
const refresh = (qc: QueryClient, scope: readonly string[]) => {
  qc.invalidateQueries({ queryKey: scope });
  qc.invalidateQueries({ queryKey: qk.overview });
};

export const useCapabilities = () =>
  useQuery({ queryKey: qk.caps, queryFn: endpoints.capabilities, staleTime: Infinity });

export const useOverview = () => useQuery({ queryKey: qk.overview, queryFn: endpoints.overview });

export const useAudit = (limit = 200) =>
  useQuery({ queryKey: qk.audit(limit), queryFn: () => endpoints.audit(limit) });

export const useEnvironments = () =>
  useQuery({ queryKey: qk.envs, queryFn: endpoints.listEnvs });

export const useEnvironment = (id: string) =>
  useQuery({ queryKey: qk.env(id), queryFn: () => endpoints.getEnv(id), enabled: Boolean(id) });

export const useCreateEnv = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: EnvironmentInput) => endpoints.createEnv(body),
    onSuccess: () => refresh(qc, qk.envs),
  });
};

export const useDeleteEnv = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => endpoints.deleteEnv(id),
    onSuccess: () => refresh(qc, qk.envs),
  });
};

export const useFlows = (limit = 100) =>
  useQuery({ queryKey: qk.flows(limit), queryFn: () => endpoints.listFlows(limit) });

export const useFlow = (id: string) =>
  useQuery({
    queryKey: qk.flow(id),
    queryFn: () => endpoints.getFlow(id),
    // 有阶段在跑时提速轮询，否则只靠失效刷新
    refetchInterval: (q) =>
      q.state.data?.stages.some((s) => s.status === "running") ? 1_200 : false,
  });

export const useCreateFlow = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: FlowCreate) => endpoints.createFlow(body),
    onSuccess: () => refresh(qc, ["flows"]),
  });
};

export const useDeleteFlow = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => endpoints.deleteFlow(id),
    onSuccess: () => refresh(qc, ["flows"]),
  });
};

export const usePackages = () => useQuery({ queryKey: qk.packages, queryFn: endpoints.listPackages });

/** 单个包：后端没有 GET /packages/{id}，从列表查询派生，上传完成后自动刷新。 */
export const usePackage = (id: string) => {
  const { data, isLoading } = usePackages();
  return { data: data?.find((p) => p.id === id) ?? null, isLoading };
};

export const useDeletePackage = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => endpoints.deletePackage(id),
    onSuccess: () => refresh(qc, qk.packages),
  });
};

export const useBackups = (envId?: string) =>
  useQuery({ queryKey: qk.backups(envId), queryFn: () => endpoints.listBackups(envId) });

export const useClusters = () => useQuery({ queryKey: qk.clusters, queryFn: endpoints.listClusters });

export const useCreateCluster = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof endpoints.createCluster>[0]) => endpoints.createCluster(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.clusters }),
  });
};

export const useDeleteCluster = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => endpoints.deleteCluster(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.clusters }),
  });
};
