import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Table, Td, Tr } from "../components/ui/Table";
import { Empty } from "../components/ui/Empty";
import { QueryError } from "../components/ui/QueryError";
import { Tag } from "../components/ui/Tag";
import { NewClusterDialog } from "../components/k8s/NewClusterDialog";
import { useClusters, useDeleteCluster } from "../hooks/queries";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../components/ToastProvider";
import { endpoints, qk } from "../api/endpoints";
import { ApiError } from "../api/client";
import { fmtDate } from "../lib/format";
import { cell, kubeFirstLine, releaseError } from "../lib/k8sRelease";
import type { K8sCluster } from "../api/types";

export default function K8s() {
  const {
    data: rows = [],
    isLoading,
    isError,
    error,
    isFetching,
    refetch,
  } = useClusters();
  const del = useDeleteCluster();
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const [showNew, setShowNew] = useState(false);
  const [toDelete, setToDelete] = useState<K8sCluster | null>(null);
  const [releasesFor, setReleasesFor] = useState<K8sCluster | null>(null);

  return (
    <div className="flex flex-col gap-5">
      <Card
        title="K8s 集群"
        sub="这张登记表只喂本页面的 helm list 查询；流程的 helm 调用从阶段 inputs 取 kubeconfig/namespace，不读这张登记表"
        actions={<Button size="sm" onClick={() => setShowNew(true)}>登记集群</Button>}
      >
        <Table head={["名称", "命名空间", "context", "kubeconfig", "创建时间", "操作"]}>
          {isLoading && !isError && (
            <tr><Td colSpan={6}><div className="text-sm text-ink-mute">加载集群清单…</div></Td></tr>
          )}
          {isError && (
            <tr>
              <Td colSpan={6}>
                <QueryError label="加载集群清单失败" error={error} retrying={isFetching} onRetry={() => refetch()} />
              </Td>
            </tr>
          )}
          {!isLoading && !isError && rows.length === 0 && (
            <tr><Td colSpan={6}><Empty>尚未登记集群。upgrade_k8s 流程可留空 kubeconfig 使用默认 KUBECONFIG</Empty></Td></tr>
          )}
          {rows.map((c) => {
            const first = kubeFirstLine(c.kubeconfig);
            return (
              <Tr key={c.id}>
                <Td>
                  <div className="font-medium">{c.name}</div>
                  <div className="font-mono text-[11px] text-ink-mute">{c.id}</div>
                </Td>
                <Td><Tag tone="brand">{c.namespace}</Tag></Td>
                <Td className="font-mono text-xs text-ink-soft">{c.context || "—"}</Td>
                <Td>
                  <span
                    className="block max-w-[280px] truncate font-mono text-[11px] text-ink-mute"
                    title={first || "留空：helm 调用回退 $KUBECONFIG，再退到 ~/.kube/config"}
                  >
                    {first || "—"}
                  </span>
                </Td>
                <Td className="text-xs text-ink-mute">{fmtDate(c.created_at)}</Td>
                <Td>
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => setReleasesFor(c)}>Helm Release</Button>
                    <Button size="sm" variant="ghost" onClick={() => nav("/flows?new=1&mode=upgrade_k8s")}>
                      建升级流程
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => setToDelete(c)}>删除</Button>
                  </div>
                </Td>
              </Tr>
            );
          })}
        </Table>
      </Card>

      <NewClusterDialog open={showNew} onClose={() => setShowNew(false)} />

      <ReleasesCard cluster={releasesFor} onClose={() => setReleasesFor(null)} />

      <ConfirmDialog
        open={!!toDelete}
        title="删除集群登记"
        body={toDelete
          ? `将删除「${toDelete.name}」（${toDelete.id}）这条连接登记。\n` +
            // ApiController.java:867-871：store.deleteCluster(id) 后无条件回 ok，未知 id 也一样，
            // 所以成功回执不是「这条记录存在过」的证明，文案不能替后端作存在性担保。
            `后端 DELETE 对未知 id 也返回 ok，返回 ok 不代表后端确认这条记录存在过。\n` +
            `删除只影响本页面：流程的 helm 调用从阶段 inputs 取 kubeconfig/namespace，已建流程的执行不会因此改变。`
          : ""}
        danger
        busy={del.isPending}
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (!toDelete) return;
          del.mutate(toDelete.id, {
            onSuccess: () => {
              toast("集群已删除");
              setToDelete(null);
              // 契约校正 15 定下的函数式更新纪律：删的正是面板里那个集群时把面板收起。
              // qk.releases(id) 是 qk.clusters 的子键，失效重拉会打到一个已不存在的 id 上，
              // 404「集群不存在」会端在一张标题还写着已删集群的卡上，而表里那一行早就没了。
              setReleasesFor((cur) => (cur && cur.id === toDelete.id ? null : cur));
            },
            // 失败意味着这一行现在是真是假都不知，失效重拉，别让它停在旧数据上
            onError: () => {
              qc.invalidateQueries({ queryKey: qk.clusters });
              toast("删除失败", "error");
              setToDelete(null);
            },
          });
        }}
      />

      <Card title="提示" tight>
        <p className="px-4 py-3 text-xs leading-5 text-ink-soft">
          {"需要回滚时到"}
          {" "}
          <Link to="/flows" className="text-brand hover:underline">流程列表</Link>
          {" 打开对应的 K8s 升级流程，页面右上角的「Helm 回滚」会真的执行 "}
          <code className="font-mono">helm rollback</code>
          {"（目标 release 取该流程首阶段登记的 release_name，没填的话后端回「缺少 release_name」），且不会重置阶段状态；"}
          {"「回滚预案」阶段只生成回滚命令清单，不执行回滚。"}
        </p>
      </Card>
    </div>
  );
}

/**
 * Helm release 面板。四种结局都得区分开（全 HTTP 200 的失败体与 404 不是一回事）：
 * 1. 集群 id 不在表里 → 404 {"detail":"集群不存在"} → 查询 isError（ApiError.message 即后端原话）；
 * 2. 脚本跑了但失败（helm 缺失、集群不可达、k8s-ops 未构建）→ {ok:false, error:"<stderr>"}；
 * 3. 脚本成功 → {ok:true, data:{releases:[…]}}，数组在 data 里再套一层 data
 *    （k8s-ops/src/config.ts:53-57 的 output + helm.ts:70，Java 原样透传不拆封，ApiController.java:874-879）；
 * 4. 成功体里读不到数组（非 JSON 输出走 helm.ts:71 的 raw 分支）→ 只能报「读不到清单」。
 * 任何一种都不能落成「该 namespace 下没有 release」，也不能把在途请求显示成空表。
 */
function ReleasesCard({ cluster, onClose }: { cluster: K8sCluster | null; onClose: () => void }) {
  const id = cluster?.id ?? "";
  const { data, isError, error } = useQuery({
    // 哨兵 key 不能写成 ["k8s","clusters",…] 形式：qk.clusters 的失效是前缀匹配，
    // 收起面板后也会被打到 /api/k8s/clusters//releases 上，所以这里刻意避开那个前缀。
    queryKey: id ? qk.releases(id) : ["k8s", "releases", "none"],
    queryFn: () => endpoints.clusterReleases(id),
    enabled: Boolean(id),
    retry: 0,
  });
  if (!cluster) return null;

  // 后端把 k8s-ops 的 stdout 原样透传：data.data 也可能是字符串或数组，所以先做 typeof 门禁再取值。
  const inner = data?.data;
  const payload = typeof inner === "object" && inner !== null ? inner as { releases?: unknown } : undefined;
  const rawList = Array.isArray(payload?.releases) ? payload.releases : null;
  const releases = rawList
    ? rawList.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    : [];
  const scriptFailed = !isError && data?.ok === false;
  // ok 不是 false 也没有 releases 数组（脚本把非 JSON 输出塞进 raw 的那条分支）：
  // 这时候说「该 namespace 下没有 release」是谎话，只能报「读不到清单」。
  // 空响应体走不到这里——TanStack Query 对 queryFn 返回 undefined 直接判 error，落到「查询失败」。
  const shapeMismatch = !isError && !scriptFailed && data !== undefined && rawList === null;
  // 结果还没落地又没失败，就是仍在途：不能拿 isFetching 当门禁 —— networkMode 默认 online，
  // 断网时请求停在 fetchStatus=paused，isFetching 始终 false，只看它就会闪出空表。
  const pending = data === undefined && !isError;
  const reason = isError
    ? (error instanceof ApiError ? error.message : "查询失败")
    : scriptFailed
      // error 不是字符串（后端零校验，对象也进得了这里）时交给 releaseError 的固定文案，别端出 [object Object]
      ? releaseError(typeof data?.error === "string" ? data.error : "")
      : shapeMismatch
        ? "后端返回体里没有 releases 数组，前端不猜清单"
        : null;

  return (
    <Card
      title={`Helm Release · ${cluster.name}`}
      sub={
        pending
          ? "查询中…"
          : reason
            ? "未取得 release 清单"
            : `${releases.length} 个 release（namespace ${cluster.namespace}）`
      }
      actions={<Button size="sm" variant="ghost" onClick={onClose}>收起</Button>}
    >
      {reason && (
        <p className="mb-3 rounded-btn bg-danger/10 px-3 py-2 text-xs text-danger">
          {/* 「helm list 未成功」只对脚本真跑挂了那条分支成立；404 时命令根本没发出去，
              返回体形状不符时命令恰恰是成功的——那时再喊「未成功」就和自己下一句的理由打架。 */}
          {scriptFailed ? "后端 helm list 未成功：" : "未取得清单："}{reason}
        </p>
      )}
      {scriptFailed && (
        <p className="mb-3 text-xs text-ink-mute">
          常见原因：k8s-ops 脚本没跑起来（后端 CWD 下找不到 dist/index.js，可用 CLOUDOPS_K8S_OPS 指路）、helm 未安装，或集群不可达。
        </p>
      )}
      <Table head={["Release", "namespace", "revision", "状态", "Chart", "App 版本"]}>
        {pending && (
          <tr><Td colSpan={6}><div className="text-sm text-ink-mute">读取 release 清单…</div></Td></tr>
        )}
        {!pending && !reason && releases.length === 0 && (
          <tr><Td colSpan={6}><Empty>该 namespace 下没有 release</Empty></Td></tr>
        )}
        {releases.map((r) => {
          // 稳定 key：helm 的 namespace/name/revision 三元组唯一；下标 key 在清单变动会错行
          const rowKey = `${cell(r.namespace)}/${cell(r.name)}/${cell(r.revision)}`;
          return (
            <Tr key={rowKey}>
              {/* helm list -o json 没有独立的 version 键，chart 本身就是 <name>-<version> */}
              <Td className="font-medium">{cell(r.name)}</Td>
              <Td className="font-mono text-xs">{cell(r.namespace)}</Td>
              <Td className="font-mono text-xs">{cell(r.revision)}</Td>
              <Td>
                <Tag tone={r.status === "deployed" ? "ok" : "warn"}>{cell(r.status)}</Tag>
              </Td>
              <Td className="font-mono text-xs">{cell(r.chart)}</Td>
              <Td className="font-mono text-xs">{cell(r.app_version)}</Td>
            </Tr>
          );
        })}
      </Table>
    </Card>
  );
}
