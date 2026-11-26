import { createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  available as nativeAvailable,
  transcode,
  validateFile,
} from "../native/index.cjs";
import sharp, { type Metadata } from "sharp";
import { MAX_PROCESSING_BYTES } from "./limits.js";
import type { GifNormalizationInput } from "./gif-normalizer.js";
import type { ImageNormalizerResult } from "./image-normalizer-protocol.js";
import {
  assertValidGifFile,
  GIF_MAX_PIXELS,
  sameGifDimensions,
  type GifDimensions,
} from "./gif-validator.js";

/** 完整读取全部动画帧并重建 GIF，输出流一旦越过预算立即失败。 */
export async function normalizeGif(
  input: GifNormalizationInput & { maxBytes: number },
): Promise<ImageNormalizerResult> {
  let tooLarge = false;
  let result: ImageNormalizerResult;
  try {
    // 原图和结果都不能突破技术上限，输出流还执行调用方指定的更小预算。
    const maxBytes = Math.min(input.maxBytes, MAX_PROCESSING_BYTES);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new Error("Invalid output budget");
    // 在展开索引前复核完整容器和资源预算；LZW 严格校验与实际解码融合，避免重复扫描。
    const dimensions = nativeAvailable
      ? validateFile(input.inputPath, MAX_PROCESSING_BYTES, false)
      : await assertValidGifFile(input.inputPath, {
          maxBytes: MAX_PROCESSING_BYTES,
          validateCompression: true,
        });
    if (!sameGifDimensions(dimensions, input.dimensions))
      throw new Error("Invalid input metadata");
    // 小图的重新量化可显著缩小调色板；超过 64 Ki 累计画布像素时省去 RGBA 展开和量化。
    const indexed =
      nativeAvailable &&
      dimensions.width * dimensions.height * dimensions.frames > 65_536;
    if (nativeAvailable && !indexed) {
      // Sharp 容忍部分不完整压缩流，小图路径继续保留独立的完整 LZW 校验。
      await assertValidGifFile(input.inputPath, {
        maxBytes: MAX_PROCESSING_BYTES,
        validateCompression: true,
      });
    }
    const image = sharp(input.inputPath, {
      failOn: "warning",
      limitInputPixels: GIF_MAX_PIXELS,
      sequentialRead: true,
      animated: true,
    });
    assertMetadata(await image.metadata(), dimensions);
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
    if (indexed) {
      // 索引解码严格校验每个 LZW 引用并重新编码；调用只发生在可被硬超时终止的 worker 内。
      const code = transcode(input.inputPath, input.outputPath, maxBytes);
      if (code !== 0) {
        tooLarge = code === 3;
        throw new Error("GIF indexed encoding failed");
      }
    } else {
      // 动画时间轴由 libvips 传递，避免显式参数较窄的范围截断 GIF 原生延迟和循环数。
      // 保留重复帧并禁用帧间有损合并，不放宽输出校验，也不降帧或转静态。
      await pipeline(
        image.gif({
          keepDuplicateFrames: true,
          interFrameMaxError: 0,
          interPaletteMaxError: 0,
          effort: 4,
        }),
        limit,
        createWriteStream(input.outputPath, { flags: "wx", mode: 0o600 }),
      );
    }
    // 输出仍完整检查每帧 LZW 的字典、EOI 与像素数；此处只展开字典长度，不再分配像素面。
    let output = indexed
      ? validateFile(input.outputPath, maxBytes, true)
      : await assertValidGifFile(input.outputPath, {
          maxBytes,
          validateCompression: true,
        });
    // libvips 会省略单帧 GIF 的循环扩展。只恢复这一项已验证的标量，不复制原始扩展或压缩载荷。
    // loop=1 只能表示没有循环扩展，因此不会制造重复声明；额外 19 字节仍纳入输出预算。
    if (
      !indexed &&
      dimensions.frames === 1 &&
      dimensions.loop !== 1 &&
      output.frames === 1 &&
      output.loop === 1
    ) {
      if (written + 19 > maxBytes) {
        tooLarge = true;
        throw new Error("Output exceeds budget");
      }
      await restoreSingleFrameLoop(input.outputPath, written, dimensions.loop);
      output = await assertValidGifFile(input.outputPath, {
        maxBytes,
        validateCompression: true,
      });
    }
    if (!sameGifDimensions(output, dimensions))
      throw new Error("Invalid output metadata");
    // 输出也由 native 元数据与独立容器扫描互证；父进程随后再核对格式与输出哈希。
    assertMetadata(
      await sharp(input.outputPath, {
        animated: true,
        failOn: "warning",
        limitInputPixels: GIF_MAX_PIXELS,
      }).metadata(),
      dimensions,
    );
    result = "OK";
  } catch {
    // IPC 仅输出固定类别，禁止把 native 错误或临时路径传回 API。
    result = tooLarge ? "TOO_LARGE" : "INVALID";
  }
  return result;
}

/** 在已验证的 trailer 前恢复固定格式循环声明；不重新写入任何原图字节。 */
async function restoreSingleFrameLoop(
  path: string,
  byteSize: number,
  loop: number,
): Promise<void> {
  const extension = Buffer.from([
    0x21,
    0xff,
    11,
    ...Buffer.from("NETSCAPE2.0"),
    3,
    1,
    0,
    0,
    0,
    0x3b,
  ]);
  extension.writeUInt16LE(loop === 0 ? 0 : loop - 1, 16);
  const file = await open(path, "r+");
  try {
    let offset = 0;
    while (offset < extension.length) {
      const { bytesWritten } = await file.write(
        extension,
        offset,
        extension.length - offset,
        byteSize - 1 + offset,
      );
      if (!bytesWritten) throw new Error("Unable to restore GIF loop");
      offset += bytesWritten;
    }
  } finally {
    await file.close();
  }
}

/** 严格核对解码器看到的完整画布、帧数与时间轴，不能接受静默截断或默认重写。 */
function assertMetadata(metadata: Metadata, expected: GifDimensions): void {
  if (
    metadata.format !== "gif" ||
    !sameGifDimensions(
      {
        width: metadata.width ?? 0,
        height: metadata.pageHeight ?? metadata.height ?? 0,
        frames: metadata.pages ?? 1,
        loop: metadata.loop ?? 1,
        delay: metadata.delay ?? [],
      },
      expected,
    ) ||
    metadata.height !== expected.height * expected.frames
  ) {
    throw new Error("Invalid decoded GIF metadata");
  }
}
