import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { WebpNormalizer } from "../src/webp-normalizer.js";
import {
  assertDecodableStaticWebp,
  assertValidStaticWebp,
} from "../src/webp-validator.js";
import { minimalLosslessWebp, riff } from "./support/webp.js";

const directories: string[] = [];
const normalizers: WebpNormalizer[] = [];

afterEach(async () => {
  await Promise.all(
    normalizers.splice(0).map((normalizer) => normalizer.stop()),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function inputs(bytes: Uint8Array) {
  const directory = await mkdtemp(join(tmpdir(), "pickcat-normalizer-test-"));
  directories.push(directory);
  const inputPath = join(directory, "input.webp");
  const outputPath = join(directory, "output.webp");
  await writeFile(inputPath, bytes);
  return { inputPath, outputPath, dimensions: assertValidStaticWebp(bytes) };
}

function normalizer(
  options: ConstructorParameters<typeof WebpNormalizer>[0] = {},
) {
  const value = new WebpNormalizer(options);
  normalizers.push(value);
  return value;
}

async function encoded() {
  return sharp({
    create: {
      width: 8,
      height: 8,
      channels: 4,
      background: { r: 12, g: 34, b: 56, alpha: 0.5 },
    },
  })
    .webp({ lossless: true })
    .toBuffer();
}

// 人为同步改大 RIFF 与 VP8L 声明，使容器仍合法；用于验证重编码不复制解码器忽略的尾载荷。
function appendToLosslessChunk(bytes: Buffer, marker: Buffer): Uint8Array {
  const chunks: { type: string; payload: Uint8Array }[] = [];
  for (let offset = 12; offset < bytes.length;) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    chunks.push({
      type,
      payload: type === "VP8L" ? Buffer.concat([payload, marker]) : payload,
    });
    offset += 8 + length + (length % 2);
  }
  return riff(chunks);
}

describe("isolated WebP normalization", () => {
  it("不复制合法压缩帧尾部夹带的载荷，并按实际输出计算大小和哈希", async () => {
    const source = await encoded();
    const marker = Buffer.from("PRIVATE-TRAILING-PAYLOAD-7654321");
    const input = await inputs(appendToLosslessChunk(source, marker));
    const result = await normalizer().normalize(input);
    const output = await readFile(input.outputPath);
    expect(output.includes(marker)).toBe(false);
    expect(result).toEqual({
      width: 8,
      height: 8,
      byteSize: output.length,
      sha256: createHash("sha256").update(output).digest("hex"),
    });
    expect(await sharp(output).ensureAlpha().raw().toBuffer()).toEqual(
      await sharp(source).ensureAlpha().raw().toBuffer(),
    );
  });

  it("拒绝只有合法帧头而没有可解码像素的文件，不回退原始字节", async () => {
    const input = await inputs(minimalLosslessWebp());
    await expect(normalizer().normalize(input)).rejects.toMatchObject({
      code: "INVALID_IMAGE",
      details: { reason: "MALFORMED" },
    });
  });

  it("输出超过限制时失败关闭", async () => {
    const input = await inputs(await encoded());
    await expect(
      normalizer().normalize({ ...input, maxBytes: 20 }),
    ).rejects.toMatchObject({ code: "TOO_LARGE" });
    const size = await stat(input.outputPath)
      .then((value) => value.size)
      .catch(() => 0);
    expect(size).toBeLessThanOrEqual(20);
  });

  it("可解码预检允许元数据，输出仍是无 ICC/EXIF 的入库 WebP", async () => {
    const source = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: "red",
      },
    })
      .withMetadata({ icc: "srgb" })
      .webp({ quality: 80 })
      .toBuffer();
    const directory = await mkdtemp(join(tmpdir(), "pickcat-normalizer-test-"));
    directories.push(directory);
    const inputPath = join(directory, "input.webp");
    const outputPath = join(directory, "output.webp");
    await writeFile(inputPath, source);
    const result = await normalizer().normalize({
      inputPath,
      outputPath,
      dimensions: assertDecodableStaticWebp(source),
    });
    const output = await readFile(outputPath);
    expect(assertValidStaticWebp(output)).toEqual({ width: 8, height: 8 });
    expect(result.width).toBe(8);
    const metadata = await sharp(output).metadata();
    expect(metadata.icc).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
  });

  it("拒绝与预检尺寸不一致的解码结果", async () => {
    const input = await inputs(await encoded());
    await expect(
      normalizer().normalize({ ...input, dimensions: { width: 1, height: 1 } }),
    ).rejects.toMatchObject({ code: "INVALID_IMAGE" });
  });

  it.each(["timeout", "abort", "stop"] as const)(
    "%s 会终止已报告结果但未确认空闲的子进程后才返回",
    async (mode) => {
      const input = await inputs(await encoded());
      const worker = join(input.inputPath, "..", "stalled-worker.mjs");
      // 使用真实子进程模拟 native 挂起，不能用只拒绝 Promise 的假实现掩盖后台继续执行。
      await writeFile(
        worker,
        `import { writeFileSync } from "node:fs";
process.send({ type: "ready", rss: process.memoryUsage.rss() });
process.once("message", ({ id, task: { payload: input } }) => {
  writeFileSync(input.outputPath, String(process.pid));
  process.send({ type: "result", id, result: "OK" });
  setInterval(() => {}, 1000);
});`,
      );
      const controller = new AbortController();
      const instance = normalizer({
        workerUrl: pathToFileURL(worker),
        timeoutMs: mode === "timeout" ? 1500 : 10000,
      });
      const rejected = expect(
        instance.normalize({ ...input, signal: controller.signal }),
      ).rejects.toMatchObject({ code: "UNAVAILABLE" });
      await expect
        .poll(() => readFile(input.outputPath, "utf8").catch(() => ""), {
          timeout: 1200,
        })
        .not.toBe("");
      const pid = Number(await readFile(input.outputPath, "utf8"));
      if (mode === "abort") controller.abort();
      if (mode === "stop") await instance.stop();
      await rejected;
      expect(() => process.kill(pid, 0)).toThrow();
    },
  );

  it("已取消的请求不会启动子进程", async () => {
    const input = await inputs(await encoded());
    const controller = new AbortController();
    controller.abort();
    await expect(
      normalizer().normalize({ ...input, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(stat(input.outputPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
