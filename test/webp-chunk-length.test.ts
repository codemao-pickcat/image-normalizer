import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertValidStaticWebp,
  assertValidStaticWebpFile,
} from "../src/webp-validator.js";
import { minimalLosslessWebp, riff } from "./support/webp.js";

// 使用 1×1 画布隔离长度问题；压缩像素是否可渲染不是本组容器回归的判断依据。
function alphaImage(alpha: Uint8Array): Uint8Array {
  return riff([
    {
      type: "VP8X",
      payload: Uint8Array.from([0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    },
    { type: "ALPH", payload: alpha },
    { type: "VP8 ", payload: vp8Frame(1) },
  ]);
}

function vp8Frame(partitionLength: number): Uint8Array {
  const tag = (partitionLength << 5) | 0x10;
  return Uint8Array.from([
    tag & 0xff,
    tag >>> 8,
    tag >>> 16,
    0x9d,
    1,
    0x2a,
    1,
    0,
    1,
    0,
    0,
  ]);
}

// 只修改声明，不补充实际字节，用于检查短读、越界和错误 padding 分支。
function withDeclaredLength(offset: number, value: number): Uint8Array {
  const bytes = Buffer.from(minimalLosslessWebp());
  bytes.writeUInt32LE(value, offset);
  return bytes;
}

const invalidSamples = [
  { name: "RIFF 声明大于实际文件", bytes: withDeclaredLength(4, 1000) },
  { name: "RIFF 声明小于完整 chunk", bytes: withDeclaredLength(4, 16) },
  {
    name: "chunk 声明越过 RIFF 边界",
    bytes: withDeclaredLength(16, 0xffffffff),
  },
  {
    name: "chunk 声明缩短后遗留不完整的 chunk 字节",
    bytes: withDeclaredLength(16, 1),
  },
  {
    name: "缺失奇数 chunk 的 padding",
    bytes: minimalLosslessWebp().subarray(0, 25),
  },
  {
    name: "压缩 ALPH 只有标志没有数据",
    bytes: alphaImage(Uint8Array.from([1])),
  },
  {
    name: "VP8 第一分区长度为零",
    bytes: riff([{ type: "VP8 ", payload: vp8Frame(0) }]),
  },
  {
    name: "VP8X 固定长度之外附加载荷",
    bytes: riff([
      { type: "VP8X", payload: new Uint8Array(12) },
      { type: "VP8 ", payload: vp8Frame(1) },
    ]),
  },
  {
    name: "奇数 payload 的非零 padding",
    bytes: new Uint8Array([...minimalLosslessWebp().subarray(0, 25), 1]),
  },
  {
    name: "RIFF 声明外的零字节也属于大小不一致",
    bytes: new Uint8Array([...minimalLosslessWebp(), 0, 0]),
  },
  {
    name: "未压缩 ALPH 缺少画布需要的 alpha 样本",
    bytes: alphaImage(Uint8Array.from([0])),
  },
  {
    name: "未压缩 ALPH 夹带超出画布的非像素载荷",
    bytes: alphaImage(
      Uint8Array.from([0, 255, ...new TextEncoder().encode("EXTRA-DATA")]),
    ),
  },
  {
    name: "VP8 第一分区的声明长度超过帧头后可用字节",
    bytes: riff([{ type: "VP8 ", payload: vp8Frame(8) }]),
  },
];

describe.each(["buffer", "file"] as const)(
  "WebP chunk 长度一致性：%s",
  (input) => {
    async function validate(bytes: Uint8Array) {
      if (input === "buffer") return assertValidStaticWebp(bytes);
      const directory = await mkdtemp(join(tmpdir(), "pickcat-webp-length-"));
      const path = join(directory, "sample.webp");
      try {
        await writeFile(path, bytes);
        return await assertValidStaticWebpFile(path);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }

    it.each(invalidSamples)("拒绝 $name", async ({ bytes }) => {
      await expect(validate(bytes)).rejects.toMatchObject({
        code: "INVALID_IMAGE",
        details: { reason: "MALFORMED" },
      });
    });

    it("保留长度精确匹配的未压缩 ALPH 与 RIFF padding", async () => {
      await expect(
        validate(alphaImage(Uint8Array.from([0, 255]))),
      ).resolves.toEqual({ width: 1, height: 1 });
    });
  },
);
