import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { validateInputFile } from "./input-file.js";
import {
  ImageNormalizerPool,
  invalidImage,
  imageTooLarge,
  processingUnavailable,
} from "./image-normalizer-process.js";
import { DEFAULT_MAX_BYTES, MAX_PROCESSING_BYTES } from "./limits.js";
import {
  assertValidStaticWebpFile,
  type StaticWebpDimensions,
} from "./webp-validator.js";

/** 独立重编码的输入；路径仅由服务端临时文件生命周期提供，不接受客户端路径。 */
export type WebpNormalizationInput = {
  inputPath: string;
  outputPath: string;
  dimensions: StaticWebpDimensions;
  maxBytes?: number;
  signal?: AbortSignal;
};

/** 重编码输出的实际属性；原始上传哈希不在此处改写。 */
export type NormalizedWebp = StaticWebpDimensions & {
  byteSize: number;
  sha256: string;
};

/** 重编码进程管理配置；workerUrl 允许故障测试替换子进程，不通过 HTTP 或 env 暴露。 */
export type WebpNormalizerOptions = {
  timeoutMs?: number;
  workerUrl?: URL;
  pool?: ImageNormalizerPool;
};

/**
 * 将不可信压缩流放在独立进程中解码并重编码；只向调用者交付经复检的服务端生成文件。
 * 像素、文件大小、执行时长和入口并发各自受限；V8 堆限不等于 native RSS 的硬限制。
 */
export class WebpNormalizer {
  private readonly shutdown = new AbortController();
  private readonly active = new Set<Promise<void>>();
  private readonly timeoutMs: number;
  private readonly pool: ImageNormalizerPool;
  private readonly ownsPool: boolean;

  constructor(options: WebpNormalizerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.ownsPool = !options.pool;
    this.pool =
      options.pool ?? new ImageNormalizerPool({ workerUrl: options.workerUrl });
  }

  /** 应用启动时预热 native 进程；共享池只会初始化一个空闲名额。 */
  async start(): Promise<void> {
    if (this.shutdown.signal.aborted) throw processingUnavailable();
    await this.pool.start();
  }

  /** 完整重编码并复检输出；成功等待空闲确认，失败等待进程退出且不回退原文件。 */
  async normalize(input: WebpNormalizationInput): Promise<NormalizedWebp> {
    const signal = AbortSignal.any([
      this.shutdown.signal,
      ...(input.signal ? [input.signal] : []),
    ]);
    if (signal.aborted) throw processingUnavailable();
    await validateInputFile(input.inputPath, input.outputPath);
    // 宿主可降低或提高输出预算，但不能越过清洗器的技术上限。
    const maxBytes = Math.min(
      input.maxBytes ?? DEFAULT_MAX_BYTES,
      MAX_PROCESSING_BYTES,
    );
    const running = this.pool.run(
      {
        kind: "WEBP",
        payload: {
          inputPath: input.inputPath,
          outputPath: input.outputPath,
          dimensions: input.dimensions,
          maxBytes,
        },
      },
      {
        timeoutMs: this.timeoutMs,
        signal,
      },
    );
    this.active.add(running);
    try {
      await running;
    } finally {
      this.active.delete(running);
    }
    if (signal.aborted) throw processingUnavailable();
    const stats = await lstat(input.outputPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0)
      throw invalidImage();
    if (stats.size > maxBytes) throw imageTooLarge();
    const dimensions = await assertValidStaticWebpFile(input.outputPath);
    if (
      dimensions.width !== input.dimensions.width ||
      dimensions.height !== input.dimensions.height
    ) {
      throw invalidImage();
    }
    // 输出 SHA-256 和额度来自实际生成字节，不能复用原始上传的声明或哈希。
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(input.outputPath)) {
      if (signal.aborted) throw processingUnavailable();
      hash.update(bytes as Buffer);
    }
    if (signal.aborted) throw processingUnavailable();
    return { ...dimensions, byteSize: stats.size, sha256: hash.digest("hex") };
  }

  /** 应用停止时取消并等待全部子进程，避免临时文件清理后仍有后台写入。 */
  async stop(): Promise<void> {
    this.shutdown.abort();
    if (this.ownsPool) await this.pool.stop();
    await Promise.allSettled([...this.active]);
  }
}
