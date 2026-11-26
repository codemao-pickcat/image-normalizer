import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { assertValidGif, GIF_MAX_FRAMES } from "../src/gif-validator.js";
import { DEFAULT_MAX_BYTES } from "../src/limits.js";
import { encodedGif, gifContainer } from "./support/gif.js";

/** 复制后定点破坏字节，避免测试间共享可变样本。 */
function changed(bytes: Buffer, offset: number, value: number): Buffer {
  const result = Buffer.from(bytes);
  result[offset] = value;
  return result;
}

describe("GIF container validation", () => {
  it("识别真实多帧、毫秒延迟与总循环次数", async () => {
    expect(assertValidGif(await encodedGif())).toEqual({
      width: 4,
      height: 3,
      frames: 3,
      delay: [40, 90, 180],
      loop: 3,
    });
    expect(assertValidGif(gifContainer())).toEqual({
      width: 1,
      height: 1,
      frames: 1,
      delay: [50],
      loop: 1,
    });
  });

  it.each([
    ["签名伪装", () => changed(gifContainer(), 0, 0)],
    ["缺少 trailer", () => gifContainer().subarray(0, -1)],
    [
      "trailer 尾随字节",
      () => Buffer.concat([gifContainer(), Buffer.from("hidden")]),
    ],
    ["截断压缩子块", () => changed(gifContainer(), 38, 250)],
    ["非法 LZW 位宽", () => changed(gifContainer(), 37, 1)],
    ["帧超出画布", () => changed(gifContainer(), 28, 1)],
    ["未知 disposal", () => changed(gifContainer(), 22, 28)],
    ["非法透明索引", () => changed(changed(gifContainer(), 22, 1), 25, 250)],
    ["损坏 GCE 终止符", () => changed(gifContainer(), 26, 1)],
    [
      "缺少帧",
      () =>
        Buffer.concat([gifContainer().subarray(0, 19), Buffer.from([0x3b])]),
    ],
  ] as const)("拒绝%s", (_name, bytes) => {
    expect(() => assertValidGif(bytes())).toThrow(
      expect.objectContaining({ code: "INVALID_IMAGE" }),
    );
  });

  it("自动审核 GIF 严格限制 100 帧和全画布累计像素，不以差分帧面积逃逸", () => {
    expect(GIF_MAX_FRAMES).toBe(100);
    expect(assertValidGif(gifContainer(1, 1, 100)).frames).toBe(100);
    expect(() => assertValidGif(gifContainer(1, 1, 101))).toThrow(
      expect.objectContaining({ details: { reason: "FRAMES_EXCEEDED" } }),
    );
    expect(assertValidGif(gifContainer(4000, 4000, 2)).frames).toBe(2);
    // 每帧只声明 1×1 的差分块，资源仍必须按 4096×4096 完整画布计费。
    const differential = gifContainer(1, 1, 2);
    differential.writeUInt16LE(4096, 6);
    differential.writeUInt16LE(4096, 8);
    expect(() => assertValidGif(differential)).toThrow(
      expect.objectContaining({ details: { reason: "PIXELS_EXCEEDED" } }),
    );
    expect(() => assertValidGif(gifContainer(4097, 1))).toThrow(
      expect.objectContaining({ details: { reason: "DIMENSIONS_EXCEEDED" } }),
    );
  });

  it("子进程压缩检查拒绝不完整像素、缺失终止码、非法字典与颜色索引", () => {
    for (const bytes of [
      gifContainer(20, 20),
      changed(gifContainer(), 40, 0),
      changed(gifContainer(), 39, 0x7c),
      changed(gifContainer(), 39, 0x5c),
      changed(gifContainer(), 39, 0x2c),
    ]) {
      expect(() =>
        assertValidGif(bytes, { validateCompression: true }),
      ).toThrow(expect.objectContaining({ code: "INVALID_IMAGE" }));
    }
    const source = gifContainer();
    const splitBlocks = Buffer.concat([
      source.subarray(0, 38),
      Buffer.from([1, 0x44, 1, 0x01, 0, 0x3b]),
    ]);
    expect(
      assertValidGif(splitBlocks, { validateCompression: true }).frames,
    ).toBe(1);
  });

  it("真实交错多帧 GIF 跨越 LZW 扩位与字典重置也能完整检查", async () => {
    const bytes = Buffer.alloc(256 * 128 * 2 * 3);
    let state = 1234567;
    for (let offset = 0; offset < bytes.length; offset += 3) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      bytes.fill(state >>> 24, offset, offset + 3);
    }
    const encoded = await sharp(bytes, {
      raw: { width: 256, height: 256, channels: 3, pageHeight: 128 },
    })
      .gif({
        progressive: true,
        colours: 256,
        effort: 1,
        keepDuplicateFrames: true,
      })
      .toBuffer();
    expect(
      assertValidGif(encoded, { validateCompression: true }),
    ).toMatchObject({ width: 256, height: 128, frames: 2 });
  });

  it("显式字节预算允许等于上限，并拒绝多出一字节的真实容器", () => {
    const source = gifContainer();
    expect(assertValidGif(source, { maxBytes: source.length }).frames).toBe(1);
    expect(() =>
      assertValidGif(source, { maxBytes: source.length - 1 }),
    ).toThrow(expect.objectContaining({ code: "TOO_LARGE" }));
  });

  it("输入字节上限也适用于直接调用预检函数", () => {
    expect(() => assertValidGif(Buffer.alloc(DEFAULT_MAX_BYTES + 1))).toThrow(
      expect.objectContaining({ code: "TOO_LARGE" }),
    );
  });
});
