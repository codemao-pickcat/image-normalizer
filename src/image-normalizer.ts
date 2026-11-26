import {
  ImageNormalizerPool,
  type ImageNormalizerPoolOptions,
} from "./image-normalizer-process.js";
import { WebpNormalizer, type NormalizedWebp } from "./webp-normalizer.js";
import { GifNormalizer, type NormalizedGif } from "./gif-normalizer.js";
import { assertDecodableStaticWebpFile } from "./webp-validator.js";
import { assertValidGifFile } from "./gif-validator.js";
import { MAX_PROCESSING_BYTES } from "./limits.js";
import { validateInputFile } from "./input-file.js";
import { ImageNormalizationError } from "./errors.js";

/** 实例独占一个受限进程池；时限包含进程启动、处理与空闲确认。 */
export type ImageNormalizerOptions = Omit<
  ImageNormalizerPoolOptions,
  "workerUrl"
> & { timeoutMs?: number };
/** 路径和预算来自受信任的服务端；原图格式转换及裁剪由宿主负责。 */
export type NormalizeImageInput = {
  inputPath: string;
  outputPath: string;
  format: "webp" | "gif";
  maxBytes?: number;
  signal?: AbortSignal;
};
/** 属性和 SHA-256 均基于新编码文件，GIF 同时返回完整动画时间轴。 */
export type NormalizedImage =
  | (NormalizedWebp & {
      format: "webp";
      mediaType: "image/webp";
      outputPath: string;
    })
  | (NormalizedGif & {
      format: "gif";
      mediaType: "image/gif";
      outputPath: string;
    });

/** 服务级清洗器，复用 WebP/GIF 子进程；结束时必须等待 stop 再清理在用临时目录。 */
export class ImageNormalizer {
  private readonly pool: ImageNormalizerPool;
  private readonly webp: WebpNormalizer;
  private readonly gif: GifNormalizer;

  constructor(options: ImageNormalizerOptions = {}) {
    this.pool = new ImageNormalizerPool(options);
    this.webp = new WebpNormalizer({
      pool: this.pool,
      timeoutMs: options.timeoutMs,
    });
    this.gif = new GifNormalizer({
      pool: this.pool,
      timeoutMs: options.timeoutMs,
    });
  }

  /** 可选预热；未预热时首项任务仍会按需启动进程。 */
  start(): Promise<void> {
    return this.pool.start();
  }

  /** 容器预检、受限重编码、父进程复检；任何失败均不回退原图。 */
  async normalize(input: NormalizeImageInput): Promise<NormalizedImage> {
    if (input.signal?.aborted)
      throw new ImageNormalizationError(
        "UNAVAILABLE",
        "Image processing was cancelled",
      );
    await validateInputFile(input.inputPath, input.outputPath);
    if (input.format === "webp") {
      const dimensions = await assertDecodableStaticWebpFile(input.inputPath);
      const result = await this.webp.normalize({ ...input, dimensions });
      return {
        ...result,
        format: "webp",
        mediaType: "image/webp",
        outputPath: input.outputPath,
      };
    }
    if (input.format === "gif") {
      const dimensions = await assertValidGifFile(input.inputPath, {
        maxBytes: MAX_PROCESSING_BYTES,
      });
      const result = await this.gif.normalize({ ...input, dimensions });
      return {
        ...result,
        format: "gif",
        mediaType: "image/gif",
        outputPath: input.outputPath,
      };
    }
    throw new ImageNormalizationError(
      "INVALID_IMAGE",
      "Only static WebP and GIF are supported",
    );
  }

  /** 禁止新任务并等待所有 worker 关闭，重复调用安全。 */
  async stop(): Promise<void> {
    await Promise.all([this.webp.stop(), this.gif.stop(), this.pool.stop()]);
  }
}
