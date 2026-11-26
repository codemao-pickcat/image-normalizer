import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GifNormalizer,
  type GifNormalizerOptions,
} from "../src/gif-normalizer.js";
import { assertValidGif } from "../src/gif-validator.js";
import { encodedGif, gifContainer } from "./support/gif.js";

const directories: string[] = [];
const normalizers: GifNormalizer[] = [];
afterEach(async () => {
  await Promise.all(normalizers.splice(0).map((value) => value.stop()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.unstubAllEnvs();
});

/** 为每次规范化建立独立源与输出路径。 */
async function inputs(bytes: Buffer) {
  const directory = await mkdtemp(join(tmpdir(), "pickcat-gif-normalizer-"));
  directories.push(directory);
  const inputPath = join(directory, "input.gif");
  const outputPath = join(directory, "output.gif");
  await writeFile(inputPath, bytes);
  return { inputPath, outputPath, dimensions: assertValidGif(bytes) };
}

/** 记录实例以确保测试失败也终止所有 worker。 */
function normalizer(options: GifNormalizerOptions = {}) {
  const value = new GifNormalizer(options);
  normalizers.push(value);
  return value;
}

describe("isolated GIF normalization", () => {
  it("兼容 ffmpeg 差分帧的 LZW 零填充并保持全部画面与时间轴", async () => {
    // 固定 ffmpeg 9.1 默认 palettegen/paletteuse 样本，第 2–6 帧的 EOI 对齐后各有一个零填充字节。
    // 画面为 64×48 浅色背景上的红色矩形，每帧右移 5px；固定文件避免测试依赖 ffmpeg 安装。
    const source = await readFile(
      new URL("./fixtures/ffmpeg-transparent-diff.gif", import.meta.url),
    );
    const input = await inputs(source);
    const result = await normalizer().normalize(input);
    expect(result).toMatchObject({
      width: 64,
      height: 48,
      frames: 6,
      delay: [100, 100, 100, 100, 100, 100],
      loop: 0,
    });
    const output = await readFile(input.outputPath);
    expect(assertValidGif(output, { validateCompression: true })).toEqual(
      input.dimensions,
    );
    expect(
      await sharp(output, { animated: true }).ensureAlpha().raw().toBuffer(),
    ).toEqual(
      await sharp(source, { animated: true }).ensureAlpha().raw().toBuffer(),
    );
  });

  it.each([false, true])(
    "重建全部帧并保留延迟、循环和重复帧（重复=%s）",
    async (duplicate) => {
      const source = await encodedGif({ duplicate });
      const marker = Buffer.from("PRIVATE-COMMENT-123456");
      // 合法 comment 不应出现在重建输出中，证明不是复制原字节。
      const input = await inputs(
        Buffer.concat([
          source.subarray(0, -1),
          Buffer.from([0x21, 0xfe, marker.length]),
          marker,
          Buffer.from([0, 0x3b]),
        ]),
      );
      const result = await normalizer().normalize(input);
      const output = await readFile(input.outputPath);
      expect(output.includes(marker)).toBe(false);
      expect(result).toEqual({
        ...input.dimensions,
        byteSize: output.length,
        sha256: createHash("sha256").update(output).digest("hex"),
      });
      expect(
        await sharp(output, { animated: true }).ensureAlpha().raw().toBuffer(),
      ).toEqual(
        await sharp(source, { animated: true }).ensureAlpha().raw().toBuffer(),
      );
      expect((await sharp(output, { animated: true }).metadata()).pages).toBe(
        3,
      );
    },
  );

  it.each([0, 1, 3])("保留循环 %s 与显式零延迟", async (loop) => {
    const input = await inputs(await encodedGif({ delay: [0, 10, 90], loop }));
    const result = await normalizer().normalize(input);
    expect(result.loop).toBe(loop);
    expect(result.delay).toEqual([0, 10, 90]);
  });

  it("保留 GIF 原生最长帧延迟与最大有限循环，不受 sharp 参数较窄范围影响", async () => {
    const source = await encodedGif();
    const control = source.indexOf(Buffer.from([0x21, 0xf9, 4]));
    source.writeUInt16LE(65535, control + 4);
    const loop = source.indexOf(Buffer.from("NETSCAPE2.0"));
    source.writeUInt16LE(65535, loop + 13);
    const input = await inputs(source);
    const output = await normalizer().normalize(input);
    expect(output.delay[0]).toBe(655350);
    expect(output.loop).toBe(65536);
  });

  it.each([0, 1, 3, 65536])(
    "单帧 GIF 仍保留循环 %s，恢复标记不能绕过输出预算",
    async (loop) => {
      const source = await encodedGif({
        frames: 1,
        delay: [100],
        loop: loop === 65536 ? 3 : loop,
      });
      if (loop === 65536) {
        const marker = source.indexOf(Buffer.from("NETSCAPE2.0"));
        source.writeUInt16LE(65535, marker + 13);
        const control = source.indexOf(Buffer.from([0x21, 0xf9, 4]));
        source.writeUInt16LE(65535, control + 4);
      }
      const input = await inputs(source);
      const result = await normalizer().normalize(input);
      expect(result.frames).toBe(1);
      expect(result.loop).toBe(loop);
      expect(result.delay).toEqual([loop === 65536 ? 655350 : 100]);
      if (loop !== 1) {
        const limited = await inputs(source);
        await expect(
          normalizer().normalize({ ...limited, maxBytes: result.byteSize - 1 }),
        ).rejects.toMatchObject({ code: "TOO_LARGE" });
      }
    },
  );

  it("可处理真实静态 GIF，但不可用单帧解码替代动画", async () => {
    const input = await inputs(gifContainer());
    expect((await normalizer().normalize(input)).frames).toBe(1);
  });

  it("完整容器但压缩像素不足时拒绝，不回退原始字节", async () => {
    const input = await inputs(gifContainer(20, 20));
    await expect(normalizer().normalize(input)).rejects.toMatchObject({
      code: "INVALID_IMAGE",
    });
  });

  it("worker 独立复核输入的帧数、尺寸与资源预算", async () => {
    const input = await inputs(await encodedGif());
    await expect(
      normalizer().normalize({
        ...input,
        dimensions: { ...input.dimensions, frames: 1 },
      }),
    ).rejects.toMatchObject({ code: "INVALID_IMAGE" });
    await writeFile(input.inputPath, gifContainer(1, 1, 201));
    await expect(normalizer().normalize(input)).rejects.toMatchObject({
      code: "INVALID_IMAGE",
    });
  });

  it("超出输出预算不会写入越界字节", async () => {
    const input = await inputs(await encodedGif());
    await expect(
      normalizer().normalize({ ...input, maxBytes: 20 }),
    ).rejects.toMatchObject({ code: "TOO_LARGE" });
    expect(
      await stat(input.outputPath)
        .then((value) => value.size)
        .catch(() => 0),
    ).toBeLessThanOrEqual(20);
  });

  it("父进程拒绝虚假成功回执和不符合输入时间轴的输出", async () => {
    const input = await inputs(await encodedGif());
    const worker = join(input.inputPath, "..", "fake.mjs");
    await writeFile(
      worker,
      `import { writeFileSync } from "node:fs";
process.send({ type: "ready", rss: process.memoryUsage.rss() });
process.once("message", ({ id, task: { payload: input } }) => {
  writeFileSync(input.outputPath, Buffer.from(${JSON.stringify(gifContainer().toString("base64"))}, "base64"));
  process.send({ type: "result", id, result: "OK" });
  process.send({ type: "ready", id, rss: process.memoryUsage.rss() });
});`,
    );
    await expect(
      normalizer({ workerUrl: pathToFileURL(worker) }).normalize(input),
    ).rejects.toMatchObject({ code: "INVALID_IMAGE" });
  });

  it.each(["timeout", "abort", "stop"] as const)(
    "%s 杀死已报告成功但未确认空闲的 worker，等待退出后才返回",
    async (mode) => {
      const input = await inputs(await encodedGif());
      const worker = join(input.inputPath, "..", "stalled.mjs");
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
        timeoutMs: mode === "timeout" ? 2000 : 10000,
      });
      const rejected = expect(
        instance.normalize({ ...input, signal: controller.signal }),
      ).rejects.toMatchObject({ code: "UNAVAILABLE" });
      await expect
        .poll(() => readFile(input.outputPath, "utf8").catch(() => ""), {
          timeout: 1500,
        })
        .not.toBe("");
      const pid = Number(await readFile(input.outputPath, "utf8"));
      if (mode === "abort") controller.abort();
      if (mode === "stop") await instance.stop();
      await rejected;
      expect(() => process.kill(pid, 0)).toThrow();
    },
  );

  it("worker 环境只传白名单，排除凭据和 NODE_OPTIONS", async () => {
    const input = await inputs(await encodedGif());
    const worker = join(input.inputPath, "..", "environment.mjs");
    vi.stubEnv("OSS_ACCESS_KEY_SECRET", "test-private-secret");
    vi.stubEnv("DATABASE_URL", "test-private-database");
    vi.stubEnv("NODE_OPTIONS", "--this-option-must-not-reach-worker");
    await writeFile(
      worker,
      `import { writeFileSync } from "node:fs";
process.send({ type: "ready", rss: process.memoryUsage.rss() });
process.once("message", ({ id, task: { payload: input } }) => {
  writeFileSync(input.outputPath, JSON.stringify(process.env));
  process.send({ type: "result", id, result: "INVALID" });
});`,
    );
    await expect(
      normalizer({ workerUrl: pathToFileURL(worker) }).normalize(input),
    ).rejects.toMatchObject({ code: "INVALID_IMAGE" });
    const environment = JSON.parse(await readFile(input.outputPath, "utf8"));
    expect(environment).not.toHaveProperty("OSS_ACCESS_KEY_SECRET");
    expect(environment).not.toHaveProperty("DATABASE_URL");
    expect(environment).not.toHaveProperty("NODE_OPTIONS");
    expect(environment.VIPS_CONCURRENCY).toBe("1");
  });

  it("已取消请求不产生任何输出", async () => {
    const input = await inputs(await encodedGif());
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
