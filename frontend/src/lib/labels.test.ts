import { describe, it, expect } from "vitest";
import {
  ROLE_CN,
  STATUS_CN,
  STEP_CN,
  FLOW_STATUS_CN,
  BACKUP_STATUS_CN,
  AUDIT_CN,
  statusTone,
  modeLabel,
  KIND_CN,
} from "./labels";

describe("labels", () => {
  it("角色与状态都有中文映射", () => {
    expect(ROLE_CN.control).toBe("控制节点");
    expect(STATUS_CN.reachable).toBe("可达");
    expect(FLOW_STATUS_CN.succeeded).toBe("成功");
    expect(FLOW_STATUS_CN.aborted).toBe("已中止");
    expect(BACKUP_STATUS_CN.verified).toBe("已校验");
    expect(STEP_CN.done).toBe("已完成");
    expect(KIND_CN.bundle).toBe("安装包");
  });
  it("状态色调", () => {
    expect(statusTone("passed")).toBe("ok");
    expect(statusTone("failed")).toBe("danger");
    expect(statusTone("running")).toBe("brand");
    expect(statusTone("locked")).toBe("mute");
  });
  it("mode 标签", () => {
    expect(modeLabel("install")).toBe("全新安装");
    expect(modeLabel("upgrade")).toBe("原地升级");
    expect(modeLabel("upgrade_k8s")).toBe("K8s / Helm 升级");
  });
  it("未知状态色调回退为 mute", () => {
    expect(statusTone("something_new")).toBe("mute");
  });
  it("审计 result 词表覆盖后端实际写入值", () => {
    expect(AUDIT_CN.ok).toBe("成功");
    expect(AUDIT_CN.started).toBe("已发起");
    expect(AUDIT_CN.skipped).toBe("已跳过");
    expect(AUDIT_CN.mismatch).toBe("校验不符");
    expect(statusTone("ok")).toBe("ok");
    expect(statusTone("started")).toBe("brand");
    expect(statusTone("mismatch")).toBe("danger");
  });
});
