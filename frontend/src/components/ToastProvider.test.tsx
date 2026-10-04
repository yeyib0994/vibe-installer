import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ToastProvider, useToast } from "./ToastProvider";

function Probe() {
  const toast = useToast();
  return (
    <>
      <button onClick={() => toast("保存成功", "ok")}>触发</button>
      <button onClick={() => toast("保存失败", "error")}>触发错误</button>
    </>
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// jsdom 环境下（vitest 3 + RTL 16 + React 19），vi.useFakeTimers() 冻结 setTimeout/setImmediate
// 后，React act 的异步 flush 链（enqueueTask → MessageChannel/setImmediate）无法推进，
// 任何走 RTL asyncWrapper 的 await（user-event 点击、findByText 的 waitFor）都会死锁。
// 可行配方：
// 1) user-event 用 setup({ delay: null }) 跳过事件间等待；
// 2) 点击后在外部循环 advanceTimersByTimeAsync 直到 click Promise 落定
//    （act 链每一跳都是新的 0ms 定时器，单次推进未必跑完整条链）；
//    每跳推进 10ms，最坏 50 跳 = 500ms，仍远小于 3.2s 自动消失窗口，不影响断言。
// 3) toast 状态更新在 click 落定前已被 act 同步 flush，因此用同步 getByText 断言，
//    不用 findByText（其 waitFor 轮询同样依赖被冻结的定时器）。
async function click(user: UserEvent, el: HTMLElement) {
  let settled = false;
  const pending = user.click(el).then(
    (ret) => {
      settled = true;
      return ret;
    },
    (err) => {
      settled = true;
      throw err;
    }
  );
  for (let i = 0; i < 50 && !settled; i++) {
    await vi.advanceTimersByTimeAsync(10);
  }
  await pending;
}

describe("ToastProvider", () => {
  it("渲染并在 3.2s 后自动消失", async () => {
    const user = userEvent.setup({ delay: null });
    render(
      <ToastProvider>
        <Probe />
      </ToastProvider>
    );
    await click(user, screen.getByText("触发"));
    expect(screen.getByText("保存成功")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3_200);
    });
    expect(screen.queryByText("保存成功")).toBeNull();
  });

  it("error 级别以 danger 样式渲染且可手动关闭", async () => {
    const user = userEvent.setup({ delay: null });
    render(
      <ToastProvider>
        <Probe />
      </ToastProvider>
    );
    await click(user, screen.getByText("触发错误"));
    const text = screen.getByText("保存失败");
    expect(text.parentElement?.className).toContain("border-danger/40");
    expect(text.parentElement?.className).toContain("text-danger");
    await click(user, screen.getByLabelText("关闭提示"));
    expect(screen.queryByText("保存失败")).toBeNull();
  });

  it("可同时显示多条提示，关闭其中一条不影响另一条", async () => {
    const user = userEvent.setup({ delay: null });
    render(
      <ToastProvider>
        <Probe />
      </ToastProvider>
    );
    await click(user, screen.getByText("触发"));
    await click(user, screen.getByText("触发错误"));
    expect(screen.getByText("保存成功")).toBeInTheDocument();
    expect(screen.getByText("保存失败")).toBeInTheDocument();
    expect(screen.getAllByLabelText("关闭提示")).toHaveLength(2);
    await click(user, screen.getAllByLabelText("关闭提示")[0]!);
    expect(screen.queryByText("保存成功")).toBeNull();
    expect(screen.getByText("保存失败")).toBeInTheDocument();
    // 剩余 toast 的自动消失定时器不受手动关闭影响
    act(() => {
      vi.advanceTimersByTime(3_200);
    });
    expect(screen.queryByText("保存失败")).toBeNull();
  });
});
