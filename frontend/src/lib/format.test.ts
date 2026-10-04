import { describe, it, expect } from "vitest";
import { fmtBytes, fmtTime, fmtDate, fmtDuration } from "./format";

describe("format", () => {
  it("字节：180KB 用例与旧版一致", () => {
    expect(fmtBytes(180 * 1024)).toBe("180 KB");
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(1536)).toBe("1.5 KB");
    expect(fmtBytes(3 * 1024 * 1024)).toBe("3 MB");
  });
  it("后端无时区时间戳按本地时间解析", () => {
    expect(fmtTime("2026-10-04T09:05:00")).toMatch(/^2026-10-04 09:05$/);
    expect(fmtTime(null)).toBe("—");
  });
  it("耗时", () => {
    expect(fmtDuration(900)).toBe("0.9s");
    expect(fmtDuration(65_000)).toBe("1m5s");
  });
  it("fmtDate 只保留日期，空值回退为破折号", () => {
    expect(fmtDate("2026-10-04T09:05:00")).toBe("2026-10-04");
    expect(fmtDate(undefined)).toBe("—");
  });
  it("超大字节封顶在 TB，非法输入不产生 NaN", () => {
    expect(fmtBytes(1024 ** 5)).toBe("1024 TB");
    expect(fmtBytes(-1)).toBe("0 B");
  });
});
