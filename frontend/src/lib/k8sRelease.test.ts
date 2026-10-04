import { describe, expect, it } from "vitest";
import { cell, kubeFirstLine, releaseError } from "./k8sRelease";

/** 真机抓到的 /releases 失败体原文（后端 CWD=backend-java/，K8S_OPS 相对 CWD 解析不到，node 把整坨栈塞进 error）。 */
const STACK =
  "node:internal/modules/cjs/loader:1520\n  throw err;\n  ^\n\n" +
  "Error: Cannot find module 'E:\\Yeyib0\\vibe-installer\\backend-java\\k8s-ops\\dist\\index.js'\n" +
  "    at Module._resolveFilename (node:internal/modules/cjs/loader:1517:15)\n" +
  "    at wrapResolveFilename (node:internal/modules/cjs/loader:1071:27)\n" +
  "    at defaultResolveImplForCJSLoading (node:internal/modules/cjs/loader:1095:10)\n" +
  "    at resolveForCJSWithHooks (node:internal/modules/cjs/loader:1122:12)\n" +
  "    at Module._load (node:internal/modules/cjs/loader:1294:5)\n" +
  "    at wrapModuleLoad (node:internal/modules/cjs/loader:255:19)\n" +
  "    at Module.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:154:5)\n" +
  "    at node:internal/main/run_main_module:33:47 {\n" +
  "  code: 'MODULE_NOT_FOUND',\n  requireStack: []\n}\n\nNode.js v24.19.0";

describe("releaseError", () => {
  it("MODULE_NOT_FOUND 栈：取到 Cannot find module 那一行，不含任何 node:internal 帧", () => {
    expect(releaseError(STACK)).toBe(
      "Error: Cannot find module 'E:\\Yeyib0\\vibe-installer\\backend-java\\k8s-ops\\dist\\index.js'",
    );
    expect(releaseError(STACK)).not.toContain("node:internal");
  });

  it("helm 未安装 / 集群不可达：取到那一行原话", () => {
    expect(releaseError("'helm' is not recognized as an internal or external command"))
      .toBe("'helm' is not recognized as an internal or external command");
    expect(releaseError("helm list: Get \"https://10.0.0.5:6443\": connection refused"))
      .toBe("helm list: Get \"https://10.0.0.5:6443\": connection refused");
  });

  it("没有关键字时也绝不端出栈帧：只有栈就回「后端未返回可读的错误信息」", () => {
    expect(releaseError("Node.js v24.19.0\n  throw err;\n}")).toBe("后端未返回可读的错误信息");
    expect(releaseError("")).toBe("后端未返回可读的错误信息");
    // 无关键字的一行普通错误：原样给第一行
    expect(releaseError("kubeconfig 文件不存在")).toBe("kubeconfig 文件不存在");
  });

  it("超长行截到 240 字符并留下截断标记", () => {
    const long = releaseError(`Error: ${"x".repeat(500)}`);
    expect(long).toHaveLength(240);
    expect(long.startsWith("Error: ")).toBe(true);
    // 截断必须看得出来：静默砍尾会让读者以为那就是完整的一行
    expect(long.endsWith("…")).toBe(true);
    expect(releaseError("Error: cannot reach tiller " + "z".repeat(300))).toHaveLength(240);
    expect(releaseError("Error: boom")).toBe("Error: boom");
  });

  it("尾部被截断/只有栈帧的 stderr：一条帧都不许上页面", () => {
    // 进程被杀、stderr 被截断时后端只能给出这种「只剩帧」的坨——旧实现按 INFO 找第一条，
    // emitErrorNT 里的 Error 字样会让整条 node:internal 帧被当成错误信息端上去。
    const framesOnly =
      "  throw err;\n  at emitErrorNT (node:internal/streams/destroy:169:8)\n  at wrap (node:internal/x:1:1)";
    const out = releaseError(framesOnly);
    expect(out).not.toContain("node:internal");
    expect(out).not.toMatch(/^at /);
    expect(out).toBe("后端未返回可读的错误信息");

    const tail = "  at new NodeError (node:internal/errors:761:5)\n  at EventEmitter.emit (node:events:517:28)";
    expect(releaseError(tail)).not.toContain("node:internal");
    expect(releaseError(tail)).toBe("后端未返回可读的错误信息");
  });

  it("先滤帧再挑行：滤完还剩有效行就用它", () => {
    const mixed =
      "Error: connect ECONNREFUSED 10.0.0.5:6443\n  at new NodeError (node:internal/errors:761:5)";
    expect(releaseError(mixed)).toBe("Error: connect ECONNREFUSED 10.0.0.5:6443");
  });

  it("无害的 retry 警告在前时取最后一条匹配行（node 把致命信息放在帧块之前）", () => {
    const out = releaseError(
      "warning: retrying after error on attempt 1\nFatal: connection refused to 10.0.0.5:6443\n  at run (node:internal/x:1:1)",
    );
    expect(out).toBe("Fatal: connection refused to 10.0.0.5:6443");
  });

  it("空与纯空白输入：固定文案，绝不端出空字符串", () => {
    expect(releaseError("")).toBe("后端未返回可读的错误信息");
    expect(releaseError("   \n\n \t ")).toBe("后端未返回可读的错误信息");
  });
});

describe("kubeFirstLine", () => {
  it("只显示第一个非空行，整份 YAML 不外泄", () => {
    expect(kubeFirstLine("apiVersion: v1\nkind: Config")).toBe("apiVersion: v1");
    expect(kubeFirstLine("\n\n  /home/ops/.kube/config  \n")).toBe("/home/ops/.kube/config");
    expect(kubeFirstLine("")).toBe("");
  });
});

describe("cell", () => {
  it("undefined/null/空串都收成「—」，其余原样转文本", () => {
    expect(cell(undefined)).toBe("—");
    expect(cell(null)).toBe("—");
    expect(cell("")).toBe("—");
    expect(cell(3)).toBe("3");
    expect(cell("deployed")).toBe("deployed");
  });
});
