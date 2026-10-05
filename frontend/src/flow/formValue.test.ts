import { describe, expect, it } from "vitest";
import { coerce, collect, initialValues, mergeInputs } from "./formValue";
import type { FlowStage, FormField } from "../api/types";

/**
 * fixture 逐字段取自后端真实目录 backend-java/.../engine/Workflow.java，
 * 保证 type / multiline_list / default 的拼写与线上序列化结果一致：
 *  - number  control_count      —— Workflow.java:134（numberField）
 *  - textarea include_paths     —— Workflow.java:214（textareaField 是唯一带 multiline_list 的构造器，Workflow.java:92-93）
 *  - boolean strict_mode        —— Workflow.java:160（boolField）
 *  - select  mode               —— Workflow.java:193（selectField，后端取值用 s(...) 即字符串）
 *  - multiselect target_roles   —— Workflow.java:196-198（default 是 List，StageExecutor.java:656 用 asStringList）
 *  - node_table physical_nodes  —— Workflow.java:136-139（ApiController.java:274 硬转 List<Map>）
 *  - text  smoke_endpoints      —— Workflow.java:252-253（type 是 text，default 却是数组）
 *  - number expected_size       —— Workflow.java:177（default 为 null → field() 不写 default 键，Workflow.java:67）
 */
const num: FormField = { key: "control_count", label: "控制节点数", type: "number", required: false, placeholder: "", help: "", hint: "", default: 3 };
const ml: FormField = { key: "include_paths", label: "备份目录", type: "textarea", required: false, placeholder: "每行一个目录", help: "", hint: "", multiline_list: true, default: ["/etc", "/var/lib", "/opt/data"] };
const bool: FormField = { key: "strict_mode", label: "严格模式", type: "boolean", required: false, placeholder: "", help: "", hint: "", default: false };
const sel: FormField = { key: "mode", label: "传输方式", type: "select", required: false, placeholder: "", help: "", hint: "", default: "rsync", options: [{ value: "rsync", label: "rsync" }, { value: "scp", label: "scp" }] };
const ms: FormField = { key: "target_roles", label: "分发到哪些角色", type: "multiselect", required: true, placeholder: "", help: "", hint: "", default: ["control", "worker"], options: [{ value: "control", label: "control" }, { value: "worker", label: "worker" }] };
const table: FormField = { key: "physical_nodes", label: "物理机列表", type: "node_table", required: false, placeholder: "", help: "", hint: "", default: [], groups: [{ key: "physical_nodes", title: "物理机节点", fields: [{ key: "hostname", label: "主机名", width: 130 }] }] };
const textList: FormField = { key: "smoke_endpoints", label: "冒烟测试接口（逗号分隔）", type: "text", required: false, placeholder: "", help: "", hint: "", default: ["/healthz", "/api/v1/version"] };
const numNoDefault: FormField = { key: "expected_size", label: "预计大小（字节）", type: "number", required: false, placeholder: "", help: "", hint: "" };

const mkStage = (form_fields: FormField[], inputs: Record<string, unknown>): FlowStage => ({
  key: "install_execute",
  index: 5,
  title: "执行安装",
  description: "",
  form_fields,
  inputs,
  required: true,
  status: "ready",
  steps: [],
});

describe("formValue", () => {
  it("mergeInputs 保留服务端下划线键（I3）", () => {
    const server = { _package_id: "pk1", _package_ids: ["pk1"], ssh_user: "root" };
    const collected = { ssh_user: "ops", ssh_port: 2222 };
    expect(mergeInputs(server, collected)).toEqual({
      _package_id: "pk1", _package_ids: ["pk1"], ssh_user: "ops", ssh_port: 2222,
    });
  });

  it("mergeInputs 下划线键即使为空数组也按 key 存活", () => {
    // 后端用 inputs.getOrDefault("_package_ids", …) / containsKey 取值（ApiController.java:548），
    // 空数组与缺键语义不同，必须原样带上。
    const server = { _package_ids: [] as string[], _package_id: "" };
    expect(mergeInputs(server, { remote_dir: "/opt/packages" })).toEqual({
      _package_ids: [], _package_id: "", remote_dir: "/opt/packages",
    });
  });

  it("mergeInputs 不修改入参", () => {
    const server: Record<string, unknown> = { a: 1 };
    const out = mergeInputs(server, { b: 2 });
    expect(server).toEqual({ a: 1 });
    expect(out).not.toBe(server);
  });

  describe("coerce number", () => {
    it("number：空串→null（绝不能是 \"\"，Integer.parseInt(\"\") 会 500 掉阶段）", () => {
      expect(coerce(num, "")).toBeNull();
      expect(coerce(num, "5")).toBe(5);
    });

    it("number：null/undefined/纯空白→null（绝不变 0）", () => {
      expect(coerce(num, null)).toBeNull();
      expect(coerce(num, undefined)).toBeNull();
      expect(coerce(num, "   ")).toBeNull();
    });

    it("number：0 是有效值，不得被当成空白", () => {
      expect(coerce(num, "0")).toBe(0);
      expect(coerce(num, 0)).toBe(0);
    });

    it("number：先 trim 再转，避免后端 Integer.parseInt 抛错", () => {
      // Workflow.java:587 用 Integer.parseInt(val.toString())，不吞前后空白。
      expect(coerce(num, " 22 ")).toBe(22);
      expect(coerce(num, 22)).toBe(22);
    });

    it("number：非整数串原样保留，交给后端回 422「必须是数字」", () => {
      // 转成 0 会写进库；转成空串会让必填/范围校验静默放行——都丢用户输入。
      expect(coerce(num, "abc")).toBe("abc");
      expect(coerce(num, "2.5")).toBe("2.5");
    });
  });

  it("multiline_list：按行切并去空", () => {
    expect(coerce(ml, "10.0.0.10\n\n10.0.0.11")).toEqual(["10.0.0.10", "10.0.0.11"]);
    expect(coerce(ml, [])).toEqual([]);
  });

  it("multiline_list：数组原样，空值切成空数组", () => {
    expect(coerce(ml, ["/etc", "/var"])).toEqual(["/etc", "/var"]);
    expect(coerce(ml, "")).toEqual([]);
    expect(coerce(ml, undefined)).toEqual([]);
  });

  it("boolean 原样", () => {
    expect(coerce(bool, true)).toBe(true);
    expect(coerce(bool, false)).toBe(false);
    expect(coerce(bool, undefined)).toBe(false);
  });

  it("node_table：只认数组，其余归零为空矩阵", () => {
    const rows = [{ hostname: "c1", ip: "10.0.0.1" }];
    expect(coerce(table, rows)).toEqual(rows);
    expect(coerce(table, "")).toEqual([]);
    expect(coerce(table, undefined)).toEqual([]);
  });

  it("multiselect：一律产出字符串数组（后端 asStringList / 必填判空按 List）", () => {
    expect(coerce(ms, ["control"])).toEqual(["control"]);
    expect(coerce(ms, "control,worker")).toEqual(["control", "worker"]);
    expect(coerce(ms, "")).toEqual([]);
    expect(coerce(ms, undefined)).toEqual([]);
  });

  it("select / text：字符串原样，缺值归空串", () => {
    expect(coerce(sel, "scp")).toBe("scp");
    expect(coerce(sel, undefined)).toBe("");
    expect(coerce(textList, undefined)).toBe("");
  });

  it("text 字段可携带数组值（smoke_endpoints 的 default 是 List），兜底分支不得字符串化", () => {
    const v = ["/healthz", "/version"];
    expect(coerce(textList, v)).toEqual(v);
  });

  describe("initialValues / collect", () => {
    it("initialValues：inputs 优先，其次 default，最后按 type 兜底", () => {
      const stage = mkStage([num, ml, bool, ms, table, sel, textList, numNoDefault], {
        control_count: 5, include_paths: ["/etc"], strict_mode: true,
      });
      expect(initialValues(stage)).toEqual({
        control_count: 5,
        include_paths: ["/etc"],
        strict_mode: true,
        target_roles: ["control", "worker"],
        physical_nodes: [],
        mode: "rsync",
        smoke_endpoints: ["/healthz", "/api/v1/version"],
        expected_size: "",
      });
    });

    it("initialValues 只产出 form_fields 的键，不下划线键", () => {
      const stage = mkStage([num], { _package_id: "pk1" });
      expect(Object.keys(initialValues(stage))).toEqual(["control_count"]);
    });

    it("往返幂等：collect(stage, initialValues(stage)) 原样回吐服务端已存值", () => {
      const stage = mkStage([num, ml, bool, sel, ms, table, textList], {
        control_count: 3,
        include_paths: ["/etc", "/opt/data"],
        strict_mode: false,
        mode: "rsync",
        target_roles: ["control", "worker", "database"],
        physical_nodes: [{ hostname: "c1", ip: "10.0.0.1" }],
        smoke_endpoints: ["/healthz", "/api/v1/version"],
        _package_id: "pk1",
        _package_ids: ["pk1"],
      });
      expect(collect(stage, initialValues(stage))).toEqual({ ...stage.inputs });
    });

    it("collect 覆盖同名字段但保留不在表单里的下划线键（I3）", () => {
      const stage = mkStage([num, ml, bool], {
        control_count: 3, include_paths: ["/etc"], strict_mode: true,
        _package_id: "pk1", _package_ids: ["pk1"],
      });
      expect(collect(stage, { control_count: "5", include_paths: "a\n\nb\nc", strict_mode: false })).toEqual({
        control_count: 5, include_paths: ["a", "b", "c"], strict_mode: false,
        _package_id: "pk1", _package_ids: ["pk1"],
      });
    });

    it("collect 对 values 缺失的字段保留服务端原值，且不改写入参", () => {
      const inputs = { control_count: 3, include_paths: ["/etc"], _package_ids: ["pk1"] };
      const stage = mkStage([num, ml], inputs);
      const snapshot = JSON.parse(JSON.stringify(inputs));
      expect(collect(stage, {})).toEqual(inputs);
      expect(stage.inputs).toEqual(snapshot);
    });

    it("collect 把空白的可选数字项写成 null，而不是 \"\"", () => {
      // 服务端读法是 `inp.get(k) != null ? Integer.parseInt(s(inp.get(k))) : 默认值`
      // （StageExecutor.java:675/851），"" 会走 parseInt 抛 NumberFormatException，
      // null 才会回落到默认值。
      const stage = mkStage([num], { control_count: 3, _package_id: "pk1" });
      expect(collect(stage, { control_count: "" })).toEqual({ control_count: null, _package_id: "pk1" });
    });

    it("initialValues 把已存的 null 当缺省回显 default", () => {
      expect(initialValues(mkStage([num, numNoDefault], { control_count: null, expected_size: null })))
        .toEqual({ control_count: 3, expected_size: "" });
    });
  });
});
