import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { decodeGifFrames } from "../src/gif-frame-decoder.js";
import { assertValidGif } from "../src/gif-validator.js";
import { gifContainer } from "./support/gif.js";

// clear、六个黑白交替像素、EOI 均使用 9 位码，结束码恰好落在第九个字节末尾。
const alignedData = Buffer.from("000104001000408080", "hex");
// 少一个像素时共 63 位，结束码之后已在当前字节内留有一位填充空间。
const unalignedData = Buffer.from("0001040010004040", "hex");

/** 将固定 LZW 流分装为真实 GIF 子块，验证读取边界而不依赖本机 ffmpeg。 */
function compressedGif(blocks: readonly Uint8Array[], width = 6): Buffer {
  return Buffer.concat([
    gifContainer(width, 1).subarray(0, 37),
    Buffer.from([8]),
    ...blocks.flatMap((block) => [Buffer.from([block.length]), block]),
    Buffer.from([0, 0x3b]),
  ]);
}

describe.each([
  {
    name: "压缩流校验",
    read: (bytes: Buffer) =>
      assertValidGif(bytes, { validateCompression: true }).frames,
  },
  {
    name: "逐帧解码",
    read: (bytes: Buffer) => [...decodeGifFrames(bytes)].length,
  },
])("GIF LZW 零填充兼容：$name", ({ read }) => {
  it("接受真实 ffmpeg 透明差分帧样本", async () => {
    const bytes = await readFile(
      new URL("./fixtures/ffmpeg-transparent-diff.gif", import.meta.url),
    );
    expect(read(bytes)).toBe(6);
  });

  it.each([
    ["没有额外填充", [alignedData]],
    [
      "同一子块中的单个零填充",
      [Buffer.concat([alignedData, Buffer.from([0])])],
    ],
    ["独立子块中的单个零填充", [alignedData, Buffer.from([0])]],
    [
      "码字跨子块且填充在末尾子块",
      [
        ...Array.from(alignedData, (byte) => Buffer.from([byte])),
        Buffer.from([0]),
      ],
    ],
  ] as const)("接受%s", (_name, blocks) => {
    expect(read(compressedGif(blocks))).toBe(1);
  });

  it("保留结束码未对齐时原字节内的填充", () => {
    expect(read(compressedGif([unalignedData], 5))).toBe(1);
  });

  it.each([
    ["非零尾随字节", [alignedData, Buffer.from([1])]],
    ["同一子块中的多个零字节", [alignedData, Buffer.from([0, 0])]],
    ["多个子块中的零字节", [alignedData, Buffer.from([0]), Buffer.from([0])]],
    ["零填充后夹带非零数据", [alignedData, Buffer.from([0]), Buffer.from([1])]],
    ["缺少结束码", [alignedData.subarray(0, -1)]],
  ] as const)("拒绝%s", (_name, blocks) => {
    expect(() => read(compressedGif(blocks))).toThrow();
  });

  it("结束码未对齐时拒绝额外零字节", () => {
    expect(() =>
      read(compressedGif([unalignedData, Buffer.from([0])], 5)),
    ).toThrow();
  });

  it.each([5, 7])("零填充不能掩盖声明 %s 个像素的数量不符", (width) => {
    expect(() =>
      read(compressedGif([alignedData, Buffer.from([0])], width)),
    ).toThrow();
  });

  it("文件 trailer 后的零字节仍然非法", () => {
    const bytes = compressedGif([alignedData, Buffer.from([0])]);
    expect(() => read(Buffer.concat([bytes, Buffer.from([0])]))).toThrow();
  });
});
