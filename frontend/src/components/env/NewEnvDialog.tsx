import { useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { useCreateEnv } from "../../hooks/queries";
import { useToast } from "../ToastProvider";
import { ApiError } from "../../api/client";
import { inputCls, labelCls, Field } from "../ui/Field";

const EMPTY = { name: "", description: "", base_domain: "", ntp_server: "", timezone: "Asia/Shanghai", dns_servers: "" };

/**
 * 环境全局参数登记表单。POST /api/environments 请求体与后端 dto/EnvironmentSpecInput
 * 逐字段对齐（dns_servers 为字符串数组，timezone 缺省 Asia/Shanghai）；
 * 返回的裸 EnvironmentSpec 不带 summary。
 */
export function NewEnvDialog({ open, onClose, onCreated }: {
  open: boolean; onClose: () => void; onCreated: (id: string) => void;
}) {
  const [v, setV] = useState(EMPTY);
  const create = useCreateEnv();
  const toast = useToast();
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }));

  const submit = () => {
    if (!v.name.trim()) { toast("环境名称必填", "warn"); return; }
    create.mutate(
      {
        name: v.name.trim(),
        description: v.description,
        base_domain: v.base_domain,
        ntp_server: v.ntp_server,
        timezone: v.timezone,
        dns_servers: v.dns_servers.split("\n").map((s) => s.trim()).filter(Boolean),
      },
      {
        onSuccess: (env) => { toast(`环境「${env.name}」已创建`); setV(EMPTY); onCreated(env.id); },
        onError: (e) => toast(e instanceof ApiError ? e.message : "创建失败", "error"),
      }
    );
  };

  return (
    <Modal
      open={open}
      title="新建环境"
      sub="先登记环境全局参数，节点矩阵在流程的「环境登记」阶段逐台填写"
      width={560}
      onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button onClick={submit} disabled={create.isPending}>创建</Button></>}
    >
      <div className="flex flex-col gap-3.5">
        <Field label={<span className={labelCls}>环境名称 *</span>}>
          <input className={inputCls} value={v.name} onChange={set("name")} placeholder="生产-AZ1" />
        </Field>
        <Field label={<span className={labelCls}>描述</span>}>
          <input className={inputCls} value={v.description} onChange={set("description")} />
        </Field>
        <div className="grid grid-cols-2 gap-3.5">
          <Field label={<span className={labelCls}>基础域名</span>}>
            <input className={inputCls} value={v.base_domain} onChange={set("base_domain")} placeholder="saas.internal.com" />
          </Field>
          <Field label={<span className={labelCls}>NTP 服务器</span>}>
            <input className={inputCls} value={v.ntp_server} onChange={set("ntp_server")} placeholder="ntp.internal.com" />
          </Field>
        </div>
        <Field label={<span className={labelCls}>DNS（每行一个）</span>} hint="每行一个 DNS 服务器地址，空行自动忽略">
          <textarea className={`${inputCls} h-20 font-mono`} value={v.dns_servers} onChange={set("dns_servers")} placeholder={"10.0.0.10\n10.0.0.11"} />
        </Field>
        <Field label={<span className={labelCls}>时区</span>}>
          <input className={inputCls} value={v.timezone} onChange={set("timezone")} />
        </Field>
      </div>
    </Modal>
  );
}
