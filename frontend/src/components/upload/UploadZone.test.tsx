import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UploadZone } from "./UploadZone";
import type { UploadProgress } from "../../hooks/useChunkedUpload";
import type { PackageEntry } from "../../api/types";

/**
 * 只 stub hook，不碰 HTTP 层：UploadZone 的职责就是把 hook 的 busy/cancellable/progress
 * 三态翻译成按钮和进度条，所以断言全部围绕「哪种状态下渲染哪个按钮」展开。
 *
 * 关键一条：取消入口只看 cancellable。busy 但 cancellable=false（<64MB 的
 * 单请求路径，客户端 abort 也拦不住服务端收完包体）必须只给一个 disabled 的「上传中…」，
 * 绝不出现「取消上传」。若实现改回按 up.busy 挂取消按钮，本组的第二个用例即失败。
 */

const up = vi.hoisted(() => ({
  busy: false,
  cancellable: false,
  progress: null as UploadProgress | null,
  upload: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("../../hooks/useChunkedUpload", () => ({ useChunkedUpload: () => up }));

const MB = 1024 * 1024;

const progress = (over: Partial<UploadProgress> = {}): UploadProgress => ({
  fileName: "app.tar.gz",
  totalBytes: 64 * MB,
  sentBytes: 16 * MB,
  percent: 25,
  chunkIndex: 2,
  totalChunks: 8,
  resuming: false,
  ...over,
});

const pkg = (over: Partial<PackageEntry> = {}): PackageEntry => ({
  id: "pkg-9", name: "app.tar.gz", version: "", kind: "bundle", size_bytes: 64 * MB,
  checksum: "sha256:abc", pieces: [], upload_complete: true, uploaded_bytes: 64 * MB,
  path: "data/packages/app.tar.gz", storage: "local", target_env_id: null,
  created_at: "2026-10-04T12:00:00", note: "", progress: 100, ...over,
});

/** 先设好 stub 状态再渲染：hook 已被换掉，改状态不会触发重渲染。 */
function setup(
  state: { busy?: boolean; cancellable?: boolean; progress?: UploadProgress | null } = {},
  props: Parameters<typeof UploadZone>[0] = {},
) {
  up.busy = state.busy ?? false;
  up.cancellable = state.cancellable ?? false;
  up.progress = state.progress ?? null;
  return render(<UploadZone {...props} />);
}

const fileInput = (container: HTMLElement) => container.querySelector('input[type="file"]') as HTMLInputElement;

const pickFile = async (container: HTMLElement) => {
  await userEvent.upload(fileInput(container), new File(["x".repeat(128)], "app.tar.gz", { type: "application/gzip" }));
};

beforeEach(() => {
  up.busy = false;
  up.cancellable = false;
  up.progress = null;
  up.upload = vi.fn(async () => pkg());
  up.cancel = vi.fn();
});

describe("UploadZone 选文件与开始上传", () => {
  it("未选文件时「开始上传」禁用，选中后解禁并回显文件名与大小", async () => {
    const { container } = setup();
    const start = screen.getByRole("button", { name: "开始上传" });
    expect(start).toBeDisabled();
    expect(screen.getByText(/拖拽 tar\.gz \/ chart 包到此处/)).toBeInTheDocument();

    await pickFile(container);
    expect(start).toBeEnabled();
    expect(screen.getByText("已选择：app.tar.gz · 128 B")).toBeInTheDocument();
  });

  it("外部 disabled（阶段执行中）不给上传", () => {
    setup({ busy: false }, { disabled: true });
    expect(screen.getByRole("button", { name: "选择文件" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "开始上传" })).toBeDisabled();
  });

  it("上传进行中不给再选文件（两次上传互相踩进度）", () => {
    setup({ busy: true, cancellable: true });
    expect(screen.getByRole("button", { name: "选择文件" })).toBeDisabled();
  });

  it("选完文件后 input.value 立即清空：再次选同一个文件仍能触发 change", async () => {
    const { container } = setup();
    const input = fileInput(container);
    await pickFile(container);
    expect(screen.getByText(/已选择：app\.tar\.gz/)).toBeInTheDocument();
    // 复位 value 后，同一文件再选会再次触发 change；否则 input.value 仍是旧值，change 不 fire
    expect(input.value).toBe("");
  });

  it("空闲态拖拽落文件即选中", () => {
    const { container } = setup();
    const zone = container.querySelector(".border-dashed") as HTMLElement;
    fireEvent.drop(zone, { dataTransfer: { files: [new File(["x"], "drag.tar.gz")] } });
    expect(screen.getByText(/已选择：drag\.tar\.gz/)).toBeInTheDocument();
  });

  it("上传中（busy）拖拽被忽略，不改选文件", () => {
    const { container } = setup({ busy: true, cancellable: true });
    const zone = container.querySelector(".border-dashed") as HTMLElement;
    fireEvent.drop(zone, { dataTransfer: { files: [new File(["x"], "drag.tar.gz")] } });
    expect(screen.queryByText(/已选择：/)).toBeNull();
  });

  it("外部 disabled（阶段执行中）拖拽被忽略，不改选文件", () => {
    const { container } = setup({ busy: false }, { disabled: true });
    const zone = container.querySelector(".border-dashed") as HTMLElement;
    fireEvent.drop(zone, { dataTransfer: { files: [new File(["x"], "drag.tar.gz")] } });
    expect(screen.queryByText(/已选择：/)).toBeNull();
  });

  it("禁用态仍取消 dragOver 并把 dropEffect 置为 none：避免浏览器接管文件拖放", () => {
    for (const state of [
      { props: { disabled: true }, label: "disabled" },
      { props: {}, busy: true, label: "busy" },
    ]) {
      const { container } = setup({ busy: state.busy ?? false }, state.props);
      const zone = container.querySelector(".border-dashed") as HTMLElement;
      const dataTransfer = { dropEffect: "copy", files: [] };
      // fireEvent 返回 !defaultPrevented：locked 时仍须取消 dragover，否则浏览器默认打开文件会卸载 SPA
      expect(fireEvent.dragOver(zone, { dataTransfer })).toBe(false);
      expect(dataTransfer.dropEffect).toBe("none");
      expect(screen.queryByText(/已选择：/)).toBeNull();
    }
  });

  it("空闲态 dragOver 会高亮且不置 none", () => {
    const { container } = setup();
    const zone = container.querySelector(".border-dashed") as HTMLElement;
    const dataTransfer = { dropEffect: "copy", files: [] };
    expect(fireEvent.dragOver(zone, { dataTransfer })).toBe(false);
    expect(dataTransfer.dropEffect).toBe("copy");
    expect(zone.className).toContain("bg-brand-soft");
  });
});

describe("UploadZone 取消入口只认 cancellable", () => {
  it("cancellable 为真才给「取消上传」，点击转交 hook 的 cancel", async () => {
    setup({ busy: true, cancellable: true });
    const cancel = screen.getByRole("button", { name: "取消上传" });
    expect(cancel).toBeEnabled();
    await userEvent.click(cancel);
    expect(up.cancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "开始上传" })).toBeNull();
    expect(screen.queryByRole("button", { name: "上传中…" })).toBeNull();
  });

  it("busy 但 cancellable 为假：只有 disabled 的「上传中…」，没有任何取消按钮", () => {
    setup({ busy: true, cancellable: false });
    expect(screen.queryByRole("button", { name: "取消上传" })).toBeNull();
    expect(screen.getByRole("button", { name: "上传中…" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "开始上传" })).toBeNull();
  });

  it("空闲态既没有取消也没有「上传中…」", () => {
    setup();
    expect(screen.queryByRole("button", { name: "取消上传" })).toBeNull();
    expect(screen.queryByRole("button", { name: "上传中…" })).toBeNull();
    expect(screen.getByRole("button", { name: "开始上传" })).toBeDisabled();
  });
});

describe("UploadZone 进度区", () => {
  it("续传中的进度行说「断点续传中」", () => {
    setup({ busy: true, progress: progress({ resuming: true }) });
    expect(screen.getByText("断点续传中 · 分片 2/8")).toBeInTheDocument();
  });

  it("progress 为 null 时整块进度不渲染", () => {
    setup();
    expect(screen.queryByText(/分片/)).toBeNull();
    expect(screen.queryByText(/64 MB/)).toBeNull();
  });

  it("分片路径（totalChunks>1）：显示分片计数、已发/总字节与确定宽度条", () => {
    const { container } = setup({ busy: true, cancellable: true, progress: progress() });
    expect(screen.getByText("上传中 · 分片 2/8")).toBeInTheDocument();
    expect(screen.getByText("16 MB / 64 MB")).toBeInTheDocument();
    const bar = container.querySelector(".bg-line > span") as HTMLElement;
    expect(bar).not.toHaveClass("animate-pulse");
    expect(bar).toHaveStyle({ width: "25%" });
  });

  it("单请求路径（totalChunks<=1）：无「分片」计数、无已发字节，条为不确定态（animate-pulse 全宽）", () => {
    const { container } = setup({
      busy: true,
      progress: progress({ totalChunks: 1, chunkIndex: 0, percent: 0, sentBytes: 0 }),
    });
    expect(screen.getByText("上传中")).toBeInTheDocument();
    expect(screen.queryByText(/分片/)).toBeNull();
    // 只报总大小，不编造已发进度
    expect(screen.getByText("64 MB")).toBeInTheDocument();
    expect(screen.queryByText(/\/ 64 MB/)).toBeNull();
    const bar = container.querySelector(".bg-line > span") as HTMLElement;
    expect(bar).toHaveClass("animate-pulse");
    expect(bar.style.width).toBe("");
  });

  it("单请求路径不误报「断点续传中」", () => {
    setup({ busy: true, progress: progress({ totalChunks: 1, chunkIndex: 0, resuming: true }) });
    expect(screen.getByText("上传中")).toBeInTheDocument();
    expect(screen.queryByText(/断点续传/)).toBeNull();
  });
});

describe("UploadZone 上传收尾", () => {
  it("成功：清掉本地已选文件回到拖拽提示", async () => {
    up.upload = vi.fn(async () => pkg({ id: "pkg-42" }));
    const { container } = setup();

    await pickFile(container);
    await userEvent.click(screen.getByRole("button", { name: "开始上传" }));

    await waitFor(() => expect(up.upload).toHaveBeenCalledTimes(1));
    expect(up.upload.mock.calls[0][0]).toBeInstanceOf(File);
    expect(screen.getByText(/拖拽 tar\.gz \/ chart 包到此处/)).toBeInTheDocument();
    expect(screen.queryByText(/已选择：/)).toBeNull();
  });

  it("返回 null（取消或失败，提示由 hook 发）：保留选择", async () => {
    up.upload = vi.fn(async () => null);
    const { container } = setup();

    await pickFile(container);
    await userEvent.click(screen.getByRole("button", { name: "开始上传" }));

    await waitFor(() => expect(up.upload).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/已选择：app\.tar\.gz/)).toBeInTheDocument();
  });
});
