import { describe, it, expect } from "vitest";
import { sliceRanges, pickStrategy, CHUNK_SIZE } from "./useChunkedUpload";

describe("sliceRanges", () => {
  it("整片对齐：24MB 切 3 片", () => {
    expect(sliceRanges(3 * CHUNK_SIZE, CHUNK_SIZE)).toEqual([
      [0, CHUNK_SIZE],
      [CHUNK_SIZE, 2 * CHUNK_SIZE],
      [2 * CHUNK_SIZE, 3 * CHUNK_SIZE],
    ]);
  });

  it("末片取余", () => {
    const r = sliceRanges(CHUNK_SIZE + 10, CHUNK_SIZE);
    expect(r).toHaveLength(2);
    expect(r[1]).toEqual([CHUNK_SIZE, CHUNK_SIZE + 10]);
  });

  it("空文件不切", () => {
    expect(sliceRanges(0, CHUNK_SIZE)).toEqual([]);
  });
});

describe("pickStrategy", () => {
  it("小于阈值走单请求", () => {
    expect(pickStrategy(8 * 1024 * 1024)).toBe("single");
  });

  it("达到阈值走分片续传", () => {
    expect(pickStrategy(64 * 1024 * 1024)).toBe("chunked");
  });
});
