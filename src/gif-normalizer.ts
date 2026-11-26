import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { validateInputFile } from "./input-file.js";
import { DEFAULT_MAX_BYTES, MAX_PROCESSING_BYTES } from "./limits.js";
import {
  imageTooLarge,
  invalidImage,
  processingUnavailable,
  ImageNormalizerPool,
} from "./image-normalizer-process.js";
import {
  assertValidGifFile,
  sameGifDimensions,
  type GifDimensions,
} from "./gif-validator.js";

/** GIF 隔离重编码输入；路径必须来自服务端临时目录，不能由客户端提供。 */
export type GifNormalizationInput = {
  inputPath: string;
  outputPath: string;
  dimensions: GifDimensions;
  maxBytes?: number;
  signal?: AbortSignal;
};

/** GIF 重编码后的实际动画属性、字节数与 SHA-256。 */
export type NormalizedGif = GifDimensions & {
  byteSize: number;
  sha256: string;
};

/** 仅供故障测试替换 worker 与时限，HTTP 请求不能覆盖执行策略。 */
export type GifNormalizerOptions = {
  timeoutMs?: number;
  workerUrl?: URL;
  pool?: ImageNormalizerPool;
};

/**
 * GIF 全帧解码只在子进程发生，父进程仅做有界容器预检和输出指纹复查。
 * 像素、字节、时限及共享并发分别受限；与 WebP 相同，V8 堆限不是 native RSS 硬限。
 */
export class GifNormalizer {
  private readonly shutdown = new AbortController();
  private readonly active = new Set<Promise<void>>();
  private readonly pool: ImageNormalizerPool;
  private readonly ownsPool: boolean;
  private readonly timeoutMs: number;

  constructor(options: GifNormalizerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.ownsPool = !options.pool;
    this.pool =
      options.pool ?? new ImageNormalizerPool({ workerUrl: options.workerUrl });
  }

  /** 预热共享媒体进程，避免首个 GIF 请求承担模块加载成本。 */
  async start(): Promise<void> {
    if (this.shutdown.signal.aborted) throw processingUnavailable();
    await this.pool.start();
  }

  /** 输出必须保持所有帧、画布、延迟与循环；任何异常均拒绝，不回退原始字节。 */
  async normalize(input: GifNormalizationInput): Promise<NormalizedGif> {
    const signal = AbortSignal.any([
      this.shutdown.signal,
      ...(input.signal ? [input.signal] : []),
    ]);
    if (signal.aborted) throw processingUnavailable();
    await validateInputFile(input.inputPath, input.outputPath);
    // 输出预算独立于宿主的上传额度，始终受清洗器技术上限约束。
    const maxBytes = Math.min(
      input.maxBytes ?? DEFAULT_MAX_BYTES,
      MAX_PROCESSING_BYTES,
    );
    const running = this.pool.run(
      {
        kind: "GIF",
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
    const dimensions = await assertValidGifFile(input.outputPath, { maxBytes });
    if (!sameGifDimensions(dimensions, input.dimensions)) throw invalidImage();
    // 指纹与计费尺寸始终基于新编码字节，不相信 worker 自报或原始上传哈希。
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(input.outputPath)) {
      if (signal.aborted) throw processingUnavailable();
      hash.update(bytes as Buffer);
    }
    if (signal.aborted) throw processingUnavailable();
    return { ...dimensions, byteSize: stats.size, sha256: hash.digest("hex") };
  }

  /** 停服先杀死并等待全部 native worker，随后上层才能清理临时文件。 */
  async stop(): Promise<void> {
    this.shutdown.abort();
    if (this.ownsPool) await this.pool.stop();
    await Promise.allSettled([...this.active]);
  }
}
