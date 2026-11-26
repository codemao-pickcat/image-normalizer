import { createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { MAX_DIMENSION, MAX_PIXELS, MAX_PROCESSING_BYTES } from "./limits.js";
import type { WebpNormalizationInput } from "./webp-normalizer.js";
import type { ImageNormalizerResult } from "./image-normalizer-protocol.js";

/** 从已通过容器检查的源文件重建全部像素，仅把新编码写入独占输出文件。 */
export async function normalizeWebp(
  input: WebpNormalizationInput & { maxBytes: number },
): Promise<ImageNormalizerResult> {
  let tooLarge = false;
  let result: ImageNormalizerResult;
  try {
    // worker 独立复核技术预算，防止调用方传入不合法或无限大的输出限制。
    const maxBytes = Math.min(input.maxBytes, MAX_PROCESSING_BYTES);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new Error("Invalid output budget");
    // 只解码单帧静态 VP8/VP8L；禁止 pages:-1 / animated 以免走动态 WebP 解码器。
    const image = sharp(input.inputPath, {
      failOn: "warning",
      limitInputPixels: MAX_PIXELS,
      sequentialRead: true,
      animated: false,
      pages: 1,
    });
    const metadata = await image.metadata();
    if (
      metadata.format !== "webp" ||
      (metadata.pages ?? 1) !== 1 ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > MAX_DIMENSION ||
      metadata.height > MAX_DIMENSION ||
      metadata.width !== input.dimensions.width ||
      metadata.height !== input.dimensions.height
    )
      throw new Error("Invalid decoded image dimensions");

    let written = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        written += chunk.byteLength;
        if (written > maxBytes) {
          tooLarge = true;
          callback(new Error("Output exceeds budget"));
        } else callback(null, chunk);
      },
    });
    // 默认不保留任何源元数据；无损重编码保留解码像素，而不复制源压缩数据或尾随字节。
    await pipeline(
      image.webp({ lossless: true, effort: 4 }),
      limit,
      createWriteStream(input.outputPath, { flags: "wx", mode: 0o600 }),
    );
    result = "OK";
  } catch {
    // native 错误文本可能包含路径或压缩载荷；IPC 只发送固定错误类别。
    result = tooLarge ? "TOO_LARGE" : "INVALID";
  }
  return result;
}
