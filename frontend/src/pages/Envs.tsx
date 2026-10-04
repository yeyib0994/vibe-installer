import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Table, Td, Tr } from "../components/ui/Table";
import { Empty } from "../components/ui/Empty";
import { Tag } from "../components/ui/Tag";
import { Modal } from "../components/ui/Modal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { NodeMatrixReadonly } from "../components/env/NodeMatrixReadonly";
import { NewEnvDialog } from "../components/env/NewEnvDialog";
import { useToast } from "../components/ToastProvider";
import { useDeleteEnv, useEnvironment, useEnvironments } from "../hooks/queries";
import { endpoints, qk } from "../api/endpoints";
import { fmtDate } from "../lib/format";
import type { Environment, NodeSpecInput } from "../api/types";

export default function Envs() {
  const [showNew, setShowNew] = useState(false);
  // 详情走单环境查询（GET /environments/{id}），不信任可能过期的列表行
  const [detailId, setDetailId] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Environment | null>(null);
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { data: envs = [], isLoading: envsLoading } = useEnvironments();
  const {
    data: detail,
    isLoading: detailLoading,
    isError: detailError,
    error: detailErr,
    isFetching: detailFetching,
    refetch: refetchDetail,
  } = useEnvironment(detailId ?? "");
  const delEnv = useDeleteEnv();
  const addNodes = useMutation({
    mutationFn: (envId: string) => endpoints.addNodes(envId, DEMO_NODES),
    // qk.envs=["environments"] 是 qk.env(id)=["environments", id] 的前缀，
    // TanStack Query 默认前缀匹配失效：一次调用即同时刷新列表与详情
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.envs });
      toast(`已追加 ${DEMO_NODES.length} 台演示节点`);
    },
    onError: () => toast("追加演示节点失败", "error"),
  });

  return (
    <div className="flex flex-col gap-5">
      <Card
        title="安装环境"
        sub={`${envs.length} 套 · 节点矩阵决定组件分派`}
        actions={<Button size="sm" onClick={() => setShowNew(true)}>新建环境</Button>}
      >
        <Table head={["名称", "描述", "域名", "节点", "物理/虚拟", "创建时间", "操作"]}>
          {envsLoading && <tr><Td colSpan={7}><div className="text-sm text-ink-mute">加载环境…</div></Td></tr>}
          {!envsLoading && envs.length === 0 && <tr><Td colSpan={7}><Empty>暂无环境，先创建一套再新建流程</Empty></Td></tr>}
          {envs.map((e) => (
            // Table 的 Tr onClick 只对鼠标生效，此处操作全在按钮里，不给整行挂 onClick
            <Tr key={e.id}>
              <Td className="font-medium">{e.name}</Td>
              <Td className="text-ink-soft">{e.description || "—"}</Td>
              <Td className="font-mono text-xs text-ink-soft">{e.base_domain || "—"}</Td>
              <Td className="font-mono">{e.summary?.total ?? e.nodes.length}</Td>
              <Td className="font-mono text-xs">{e.summary?.physical ?? 0} / {e.summary?.virtual ?? 0}</Td>
              <Td className="text-xs text-ink-mute">{fmtDate(e.created_at)}</Td>
              <Td>
                <div className="flex gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => setDetailId(e.id)}>节点</Button>
                  {/* 只禁用正在处理的那一行：mutation 的 variables 即本次 envId */}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={addNodes.isPending && addNodes.variables === e.id}
                    onClick={() => addNodes.mutate(e.id)}
                  >
                    +演示节点
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => nav(`/flows?new=1&env=${e.id}`)}>建流程</Button>
                  <Button size="sm" variant="danger" onClick={() => setToDelete(e)}>删除</Button>
                </div>
              </Td>
            </Tr>
          ))}
        </Table>
      </Card>

      <NewEnvDialog open={showNew} onClose={() => setShowNew(false)}
        onCreated={(id) => { setShowNew(false); nav(`/flows?new=1&env=${id}`); }} />

      <Modal open={detailId !== null} title={detail?.name ?? ""} width={1080} onClose={() => setDetailId(null)}
        sub={detail ? `${detail.nodes.length} 台节点 · ${detail.timezone}` : ""}>
        {detailLoading ? (
          <div className="text-sm text-ink-mute">加载节点…</div>
        ) : detailError ? (
          <div className="flex items-center gap-3">
            <div className="text-sm text-danger">
              加载节点失败：{detailErr?.message || "请稍后重试"}
            </div>
            <Button size="sm" variant="ghost" disabled={detailFetching} onClick={() => refetchDetail()}>
              重试
            </Button>
          </div>
        ) : detail ? (
          <NodeMatrixReadonly nodes={detail.nodes} />
        ) : null}
      </Modal>

      <ConfirmDialog
        open={!!toDelete}
        title="删除环境"
        body={toDelete
          ? `将删除环境「${toDelete.name}」及其 ${toDelete.nodes.length} 台节点登记。已创建的流程不会被删除，但流程详情中的环境名将显示为空。`
          : ""}
        danger
        busy={delEnv.isPending}
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (!toDelete) return;
          delEnv.mutate(toDelete.id, {
            onSuccess: () => { toast("环境已删除"); setToDelete(null); },
            onError: () => { toast("删除失败", "error"); setToDelete(null); },
          });
        }}
      />

      {envs.some((e) => e.validation_issues.length > 0) && (
        <Card title="校验提示">
          {envs.map((e) => e.validation_issues.map((x, i) => (
            <div key={`${e.id}-${i}`} className="flex items-center gap-2 py-1 text-xs text-warn">
              <Tag tone="warn">{e.name}</Tag>{x}
            </div>
          )))}
        </Card>
      )}
    </div>
  );
}

/**
 * 演示节点：3 台物理控制 + 2 台物理数据库 + 4 台虚拟工作节点。
 * 角色必须是后端 NodeRole 枚举值（database 而非 db），两条后端路径对非法值的处理不同：
 * 本按钮走的 POST /environments/{id}/nodes 用 Jackson 反序列化 NodeSpecInput.role
 * （枚举 @JsonValue），非法值直接 400 拒绝；流程 stage 路径改用 NodeRole.fromValue，
 * 非法值被静默映射成 worker。返回类型标注让错误在编译期暴露。
 */
const DEMO_NODES: NodeSpecInput[] = buildDemoNodes();

function buildDemoNodes(): NodeSpecInput[] {
  const base = { ssh_port: 22, ssh_user: "root", ssh_key_path: "" };
  return [
    // 回调必须显式标注返回类型：否则 "control" 等字面量被拓宽成 string，无法满足 NodeRole
    ...[1, 2, 3].map((i): NodeSpecInput => ({
      ...base, hostname: `ctrl-phy-0${i}`, ip: `10.10.0.1${i}`, role: "control",
      machine_type: "physical", vendor: "Dell", model: "PowerEdge R750",
      idc: "AZ1-A", rack: `R0${i}`, nic_speed: "25GbE", raid_level: "RAID10",
      host_platform: null, vcpu: null, memory_gb: null, disk_gb: null, image_template: null,
    })),
    ...[1, 2].map((i): NodeSpecInput => ({
      ...base, hostname: `db-phy-0${i}`, ip: `10.10.0.2${i}`, role: "database",
      machine_type: "physical", vendor: "Huawei", model: "2288H V6",
      idc: "AZ1-A", rack: `R0${i + 3}`, nic_speed: "25GbE", raid_level: "RAID10",
      host_platform: null, vcpu: null, memory_gb: null, disk_gb: null, image_template: null,
    })),
    ...[1, 2, 3, 4].map((i): NodeSpecInput => ({
      ...base, hostname: `worker-vm-0${i}`, ip: `10.10.1.${20 + i}`, role: "worker",
      machine_type: "virtual", host_platform: "VMware vSphere 8", vcpu: 16,
      memory_gb: 64, disk_gb: 500, image_template: "rocky9-tpl-v3",
      vendor: null, model: null, idc: null, rack: null, nic_speed: null, raid_level: null,
    })),
  ];
}
