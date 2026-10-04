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
  const { data: envs = [] } = useEnvironments();
  const { data: detail, isLoading: detailLoading } = useEnvironment(detailId ?? "");
  const delEnv = useDeleteEnv();
  const addNodes = useMutation({
    mutationFn: (envId: string) => endpoints.addNodes(envId, demoNodes()),
    onSuccess: (_r, envId) => {
      qc.invalidateQueries({ queryKey: qk.envs });
      qc.invalidateQueries({ queryKey: qk.env(envId) });
      toast(`已追加 ${DEMO_COUNT} 台演示节点`);
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
          {envs.length === 0 && <tr><Td colSpan={7}><Empty>暂无环境，先创建一套再新建流程</Empty></Td></tr>}
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
                  <Button size="sm" variant="ghost" onClick={() => addNodes.mutate(e.id)}>+演示节点</Button>
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
        {detailLoading || !detail
          ? <div className="text-sm text-ink-mute">加载节点…</div>
          : <NodeMatrixReadonly nodes={detail.nodes} />}
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
 * 角色必须是后端 NodeRole 枚举值（database 而非 db —— 非法值会被
 * NodeRole.fromValue 静默回退成 worker），返回类型标注让错误在编译期暴露。
 */
const DEMO_COUNT = 9;

function demoNodes(): NodeSpecInput[] {
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
