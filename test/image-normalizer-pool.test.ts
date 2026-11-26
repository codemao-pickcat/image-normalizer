import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ImageNormalizerPool,
  type ImageNormalizerPoolOptions,
} from "../src/image-normalizer-process.js";
import type { ImageNormalizerTask } from "../src/image-normalizer-protocol.js";
import { GifNormalizer } from "../src/gif-normalizer.js";
import { WebpNormalizer } from "../src/webp-normalizer.js";
import { assertValidGif } from "../src/gif-validator.js";
import { encodedGif } from "./support/gif.js";
import { encodedWebp } from "./support/webp.js";

const contexts: { pool: ImageNormalizerPool; directory: string }[] = [];
afterEach(async () => {
  for (const { pool, directory } of contexts.splice(0)) {
    await pool.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

/** 用真实子进程可观察的 PID、结果与文件写入验证进程生命周期，不模拟 kill/close。 */
async function context(
  options: ImageNormalizerPoolOptions = {},
  startupReady = true,
) {
  const directory = await mkdtemp(join(tmpdir(), "image-pool-test-"));
  const worker = join(directory, "worker.mjs");
  await writeFile(
    worker,
    `
import { appendFileSync, writeFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(directory, "starts"))}, process.pid + String.fromCharCode(10));
process.once("disconnect", () => process.exit(0));
let sequence = 0, previous;
process.on("message", ({id, task}) => {
  const {inputPath, outputPath} = task.payload;
  writeFileSync(outputPath, JSON.stringify({pid: process.pid, kind: task.kind, sequence: ++sequence}));
  if (inputPath === "exit") process.exit(1);
  if (inputPath === "invalid" || inputPath === "large") {
    process.send({type: "result", id, result: inputPath === "large" ? "TOO_LARGE" : "INVALID"});
    return;
  }
  if (inputPath === "wrong" || inputPath === "stale") {
    process.send({type: "result", id: inputPath === "stale" ? previous : "wrong-id", result: "OK"});
    return;
  }
  if (inputPath === "early-ready") {
    process.send({type: "ready", id, rss: process.memoryUsage.rss()});
    return;
  }
  const finish = () => {
    process.send({type: "result", id, result: "OK"});
    if (inputPath === "hold") return;
    if (inputPath === "duplicate") {
      process.send({type: "result", id, result: "OK"});
      return;
    }
    previous = id;
    setImmediate(() => process.send({type: "ready", id, rss: process.memoryUsage.rss()}));
  };
  if (inputPath === "slow") setTimeout(finish, 200);
  else finish();
});
${startupReady ? 'process.send({type: "ready", rss: process.memoryUsage.rss()});' : ""}
`,
  );
  const pool = new ImageNormalizerPool({
    workerUrl: pathToFileURL(worker),
    ...options,
  });
  contexts.push({ pool, directory });
  let sequence = 0;
  const request = (
    mode = "normal",
    signal = new AbortController().signal,
    kind: ImageNormalizerTask["kind"] = "GIF",
    timeoutMs = 2000,
  ) => {
    const outputPath = join(directory, `output-${++sequence}`);
    const payload = {
      inputPath: mode,
      outputPath,
      dimensions: { width: 1, height: 1, frames: 1, delay: [100], loop: 1 },
      maxBytes: 1000,
    };
    const task: ImageNormalizerTask =
      kind === "GIF"
        ? { kind, payload }
        : kind === "WEBP"
          ? { kind, payload }
          : { kind, payload };
    return { outputPath, run: () => pool.run(task, { signal, timeoutMs }) };
  };
  return { pool, directory, request };
}

/** 读取子进程自己的回执，避免通过池的内部字段证明复用或回收。 */
async function output(
  path: string,
): Promise<{ pid: number; kind: string; sequence: number }> {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("媒体子进程池", () => {
  it.each(["cold", "ready"] as const)(
    "%s worker 拒绝不可序列化的扩展载荷，并恢复同一池的可用名额",
    async (state) => {
      const ctx = await context();
      if (state === "ready") await ctx.pool.start();
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      for (const invalid of [1n, cyclic]) {
        await expect(
          ctx.pool.runCustom(
            { kind: "CUSTOM", payload: invalid },
            { signal: new AbortController().signal, timeoutMs: 2000 },
          ),
        ).rejects.toMatchObject({ code: "INVALID_IMAGE" });
        await ctx.request().run();
      }
    },
  );

  it("默认 worker 不接受宿主扩展任务", async () => {
    const pool = new ImageNormalizerPool();
    try {
      await expect(
        pool.runCustom(
          { kind: "EMOJI_WEBP", payload: {} },
          { signal: new AbortController().signal, timeoutMs: 1000 },
        ),
      ).rejects.toMatchObject({
        code: "INVALID_IMAGE",
        details: { reason: "CUSTOM_WORKER_REQUIRED" },
      });
    } finally {
      await pool.stop();
    }
  });

  it("扩展任务与内置任务共用进程和总并发预算", async () => {
    const ctx = await context({ maxWorkers: 1 });
    const signal = new AbortController().signal;
    const customPath = join(ctx.directory, "custom-output");
    const custom = ctx.pool.runCustom(
      {
        kind: "EMOJI_WEBP",
        payload: { inputPath: "slow", outputPath: customPath },
      },
      { signal, timeoutMs: 2000 },
    );
    await expect(ctx.request().run()).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    await custom;
    const builtin = ctx.request();
    await builtin.run();
    expect((await output(customPath)).pid).toBe(
      (await output(builtin.outputPath)).pid,
    );
    expect((await output(customPath)).kind).toBe("EMOJI_WEBP");
  });

  it("扩展任务取消等待真实进程退出，不影响随后复用的任务", async () => {
    const ctx = await context();
    const controller = new AbortController();
    const outputPath = join(ctx.directory, "custom-hold");
    const result = expect(
      ctx.pool.runCustom(
        { kind: "EMOJI_WEBP", payload: { inputPath: "hold", outputPath } },
        { signal: controller.signal, timeoutMs: 2000 },
      ),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect
      .poll(() => output(outputPath).catch(() => undefined))
      .toBeDefined();
    const pid = (await output(outputPath)).pid;
    controller.abort();
    await result;
    expect(() => process.kill(pid, 0)).toThrow();
    const next = ctx.request();
    await next.run();
    expect((await output(next.outputPath)).pid).not.toBe(pid);
  });

  it("重复预热和跨格式任务复用同一进程，停服回收空闲进程", async () => {
    const ctx = await context();
    await Promise.all([ctx.pool.start(), ctx.pool.start()]);
    const receipts: Awaited<ReturnType<typeof output>>[] = [];
    for (const kind of ["GIF", "WEBP", "GIF"] as const) {
      const request = ctx.request("normal", undefined, kind);
      await request.run();
      receipts.push(await output(request.outputPath));
    }
    expect(new Set(receipts.map((value) => value.pid)).size).toBe(1);
    expect(receipts.map((value) => value.sequence)).toEqual([1, 2, 3]);
    expect(receipts.map((value) => value.kind)).toEqual(["GIF", "WEBP", "GIF"]);
    await ctx.pool.stop();
    expect(() => process.kill(receipts[0]!.pid, 0)).toThrow();
    await expect(ctx.pool.start()).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
  });

  it("按需扩容但总槽位有界，满载请求立即失败", async () => {
    const ctx = await context({ maxWorkers: 2 });
    const first = ctx.request("slow"),
      second = ctx.request("slow");
    const pending = Promise.all([first.run(), second.run()]);
    await expect(ctx.request().run()).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    await pending;
    const a = await output(first.outputPath),
      b = await output(second.outputPath);
    expect(a.pid).not.toBe(b.pid);
    await ctx.pool.stop();
    for (const pid of [a.pid, b.pid])
      expect(() => process.kill(pid, 0)).toThrow();
  });

  it.each(["abort", "timeout", "stop"] as const)(
    "%s 等待已报告结果但未确认空闲的进程退出",
    async (mode) => {
      const ctx = await context();
      const controller = new AbortController();
      const request = ctx.request(
        "hold",
        controller.signal,
        "GIF",
        mode === "timeout" ? 400 : 2000,
      );
      const pending = expect(request.run()).rejects.toMatchObject({
        code: "UNAVAILABLE",
      });
      await expect
        .poll(() => output(request.outputPath).catch(() => undefined))
        .toBeDefined();
      const { pid } = await output(request.outputPath);
      if (mode === "abort") controller.abort();
      if (mode === "stop") await ctx.pool.stop();
      await pending;
      expect(() => process.kill(pid, 0)).toThrow();
      if (mode !== "stop") {
        await ctx.pool.start();
        const next = ctx.request();
        await next.run();
        expect((await output(next.outputPath)).pid).not.toBe(pid);
      }
    },
  );

  it.each([
    ["invalid", "INVALID_IMAGE"],
    ["large", "TOO_LARGE"],
    ["exit", "INVALID_IMAGE"],
    ["wrong", "INVALID_IMAGE"],
    ["early-ready", "INVALID_IMAGE"],
    ["duplicate", "INVALID_IMAGE"],
  ])("%s 进程退出后返回稳定错误并补位", async (mode, code) => {
    const ctx = await context();
    const request = ctx.request(mode);
    await expect(request.run()).rejects.toMatchObject({ code });
    const { pid } = await output(request.outputPath);
    expect(() => process.kill(pid, 0)).toThrow();
    await ctx.pool.start();
    const next = ctx.request();
    await next.run();
    expect((await output(next.outputPath)).pid).not.toBe(pid);
  });

  it("旧任务回执不能结束复用进程中的新任务", async () => {
    const ctx = await context();
    const first = ctx.request();
    await first.run();
    const second = ctx.request("stale");
    await expect(second.run()).rejects.toMatchObject({
      code: "INVALID_IMAGE",
    });
    expect((await output(first.outputPath)).pid).toBe(
      (await output(second.outputPath)).pid,
    );
    const { pid } = await output(second.outputPath);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("旧任务取消信号不会杀死进程中的下一项任务", async () => {
    const ctx = await context();
    const controller = new AbortController();
    const first = ctx.request("normal", controller.signal);
    await first.run();
    const second = ctx.request("slow");
    const pending = second.run();
    controller.abort();
    await pending;
    expect((await output(second.outputPath)).pid).toBe(
      (await output(first.outputPath)).pid,
    );
  });

  it.each([{ maxTasksPerWorker: 1 }, { maxWorkerRssBytes: 1 }])(
    "达到回收阈值仍交付已完成任务，并等待旧进程退出",
    async (options) => {
      const ctx = await context(options);
      const first = ctx.request();
      await first.run();
      const { pid } = await output(first.outputPath);
      expect(() => process.kill(pid, 0)).toThrow();
      await ctx.pool.start();
      const second = ctx.request();
      await second.run();
      expect((await output(second.outputPath)).pid).not.toBe(pid);
    },
  );

  it("启动超时回收进程，不无限补位重试", async () => {
    const ctx = await context({ startupTimeoutMs: 400 }, false);
    await expect(ctx.pool.start()).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    const pids = (await readFile(join(ctx.directory, "starts"), "utf8"))
      .trim()
      .split("\n")
      .map(Number);
    expect(pids).toHaveLength(1);
    expect(() => process.kill(pids[0]!, 0)).toThrow();
  });

  it("已取消任务不启动进程", async () => {
    const ctx = await context();
    const controller = new AbortController();
    controller.abort();
    await expect(
      ctx.request("normal", controller.signal).run(),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(readFile(join(ctx.directory, "starts"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("真实共享进程可轮换处理静态图、GIF，单个使用者停止不关闭共享池", async () => {
    const directory = await mkdtemp(join(tmpdir(), "image-pool-native-"));
    const pool = new ImageNormalizerPool();
    contexts.push({ directory, pool });
    const webp = new WebpNormalizer({ pool }),
      gif = new GifNormalizer({ pool });
    const inputPath = join(directory, "source");
    try {
      await pool.start();
      for (let round = 0; round < 2; round++) {
        const source = await encodedGif({ loop: round ? 0 : 3 });
        await writeFile(inputPath, source);
        await expect(
          gif.normalize({
            inputPath,
            outputPath: join(directory, `gif-${round}`),
            dimensions: assertValidGif(source),
          }),
        ).resolves.toMatchObject({ frames: 3, loop: round ? 0 : 3 });
        await writeFile(inputPath, await encodedWebp(8, 8));
        await expect(
          webp.normalize({
            inputPath,
            outputPath: join(directory, `webp-${round}`),
            dimensions: { width: 8, height: 8 },
          }),
        ).resolves.toMatchObject({ width: 8, height: 8 });
      }
      await gif.stop();
      await expect(
        webp.normalize({
          inputPath,
          outputPath: join(directory, "after-gif-stop"),
          dimensions: { width: 8, height: 8 },
        }),
      ).resolves.toMatchObject({ width: 8 });
    } finally {
      await Promise.all([webp.stop(), gif.stop()]);
    }
  });
});
