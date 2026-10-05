import { useState } from "react";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Table, Td, Tr } from "../components/ui/Table";
import { Empty } from "../components/ui/Empty";
import { QueryError } from "../components/ui/QueryError";
import { Tag } from "../components/ui/Tag";
import { UploadZone } from "../components/upload/UploadZone";
import { useDeletePackage, usePackages } from "../hooks/queries";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../components/ToastProvider";
import { fmtBytes, fmtTime } from "../lib/format";
import { KIND_CN } from "../lib/labels";
import type { PackageEntry } from "../api/types";

export default function Packages() {
  const {
    data: rows = [],
    isLoading,
    isError,
    error,
    isFetching,
    refetch,
  } = usePackages();
  const del = useDeletePackage();
  const toast = useToast();
  const [toDelete, setToDelete] = useState<PackageEntry | null>(null);
  const bytes = rows.reduce((a, p) => a + p.size_bytes, 0);

  // 用 LAN IP 打开控制台时页面不是 secure context，navigator.clipboard 直接是 undefined
  // （lib.dom 把它标成非可选，tsc 查不出来）；不先挡一下就会在点击里抛 TypeError，用户毫无反馈。
  // 真正的 writeText 失败（权限被拒等）再走 .then 的 reject 分支。
  const copyChecksum = (p: PackageEntry) => {
    if (!navigator.clipboard) {
      toast("浏览器不支持写入剪贴板", "error");
      return;
    }
    navigator.clipboard.writeText(p.checksum).then(
      () => toast("校验和已复制"),
      () => toast("浏览器不允许写入剪贴板", "error"),
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <Card title="上传安装包" sub="≥64 MB 自动分片（8 MB/片），中断后重传同名文件会跳过已完成分片">
        <UploadZone />
      </Card>

      <Card title="安装包仓库" sub={`${rows.length} 个 · ${fmtBytes(bytes)}`}>
        <Table head={["名称", "类型", "版本", "大小", "已上传", "完整", "关联环境", "创建时间", "操作"]}>
          {isLoading && !isError && <tr><Td colSpan={9}><div className="text-sm text-ink-mute">加载安装包…</div></Td></tr>}
          {isError && (
            <tr><Td colSpan={9}><QueryError label="加载安装包失败" error={error} retrying={isFetching} onRetry={() => refetch()} /></Td></tr>
          )}
          {!isLoading && !isError && rows.length === 0 && <tr><Td colSpan={9}><Empty>仓库为空</Empty></Td></tr>}
          {rows.map((p) => (
            <Tr key={p.id}>
              <Td>
                <div className="font-medium">{p.name}</div>
                <div className="font-mono text-[11px] text-ink-mute">{p.id}</div>
              </Td>
              <Td><Tag tone="purple">{KIND_CN[p.kind] ?? p.kind}</Tag></Td>
              <Td className="font-mono text-xs">{p.version || "—"}</Td>
              <Td className="font-mono text-xs">{fmtBytes(p.size_bytes)}</Td>
              <Td className="font-mono text-xs">{fmtBytes(p.uploaded_bytes)}</Td>
              <Td>
                {p.upload_complete
                  ? <Tag tone="ok">完整</Tag>
                  : <span className="flex items-center gap-2">
                      <span className="block h-1.5 w-16 overflow-hidden rounded-full bg-line">
                        <span className="block h-full bg-warn" style={{ width: `${p.progress}%` }} />
                      </span>
                      <span className="font-mono text-[11px] text-warn">{p.progress}%</span>
                    </span>}
              </Td>
              <Td className="font-mono text-xs text-ink-mute">{p.target_env_id || "—"}</Td>
              <Td className="text-xs text-ink-mute">{fmtTime(p.created_at)}</Td>
              <Td>
                <div className="flex gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => copyChecksum(p)}>
                    复制校验和
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setToDelete(p)}>删除</Button>
                </div>
              </Td>
            </Tr>
          ))}
        </Table>
      </Card>

      <ConfirmDialog
        open={!!toDelete}
        title="删除安装包"
        body={toDelete ? `将删除「${toDelete.name}」（${fmtBytes(toDelete.size_bytes)}）。已完成的流程阶段记录不受影响，但未执行的「包分发」会拿不到该包。` : ""}
        danger
        busy={del.isPending}
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (!toDelete) return;
          del.mutate(toDelete.id, {
            onSuccess: () => { toast("安装包已删除"); setToDelete(null); },
            onError: () => { toast("删除失败", "error"); setToDelete(null); },
          });
        }}
      />
    </div>
  );
}
