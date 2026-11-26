import { lstat, open } from "node:fs/promises";
import { ImageNormalizationError } from "./errors.js";
import { DEFAULT_MAX_BYTES, MAX_DIMENSION } from "./limits.js";
import { imageTooLarge } from "./image-normalizer-process.js";
import { GifLzwValidator } from "./gif-lzw-validator.js";

/** 自动审核 GIF 最多 100 帧，与 Green 截帧上限一致；不得抽帧绕过，管理员表情逐帧路径另行约束。 */
export const GIF_MAX_FRAMES = 100;
/** 按完整画布乘帧数计费，覆盖差分帧还原后的真实内存开销。 */
export const GIF_MAX_PIXELS = 32_000_000;

/** 容器预检得到的动画属性；循环数 0 为无限，1 为只播放一次。 */
export type GifDimensions = {
  width: number;
  height: number;
  frames: number;
  delay: number[];
  loop: number;
};

/** GIF 校验预算，默认 10 MiB；宿主可传入受限的其他字节预算。 */
export type GifValidationOptions = {
  validateCompression?: boolean;
  sequentialFrames?: boolean;
  maxBytes?: number;
};

/** 有界容器检查；validateCompression 仅由子进程开启，补足 native 对不完整压缩帧的容忍。 */
export function assertValidGif(
  bytes: Uint8Array,
  options: GifValidationOptions = {},
): GifDimensions {
  if (bytes.byteLength > (options.maxBytes ?? DEFAULT_MAX_BYTES))
    throw imageTooLarge();
  const reader = new GifReader(bytes);
  const signature = reader.ascii(6);
  if (signature !== "GIF87a" && signature !== "GIF89a")
    throw invalidGif("NOT_GIF");
  const width = reader.uint16();
  const height = reader.uint16();
  if (!width || !height) throw invalidGif("MALFORMED");
  if (width > MAX_DIMENSION || height > MAX_DIMENSION)
    throw invalidGif("DIMENSIONS_EXCEEDED");
  const packed = reader.byte();
  const background = reader.byte();
  reader.byte();
  const globalColours = packed & 0x80 ? 1 << ((packed & 7) + 1) : 0;
  if (globalColours && background >= globalColours)
    throw invalidGif("MALFORMED");
  reader.skip(globalColours * 3);
  const delay: number[] = [];
  let loop = 1;
  let loopSeen = false;
  let control: { delay: number; transparent: number | null } | undefined;

  while (!reader.done) {
    const marker = reader.byte();
    if (marker === 0x3b) {
      // 不接受 trailer 后的夹带字节或悬空 GCE，所有声明必须属于完整帧。
      if (!reader.done || !delay.length || control)
        throw invalidGif("MALFORMED");
      return { width, height, frames: delay.length, delay, loop };
    }
    if (marker === 0x21) {
      const label = reader.byte();
      if (label === 0xf9) {
        if (control || reader.byte() !== 4) throw invalidGif("MALFORMED");
        const flags = reader.byte();
        // 保留位、未定义 disposal 和需人工交互的帧都不能安全转成普通动画。
        if ((flags & 0xe2) !== 0 || ((flags >> 2) & 7) > 3)
          throw invalidGif("MALFORMED");
        const milliseconds = reader.uint16() * 10;
        const transparent = reader.byte();
        if (reader.byte() !== 0) throw invalidGif("MALFORMED");
        control = {
          delay: milliseconds,
          transparent: flags & 1 ? transparent : null,
        };
      } else if (label === 0xff) {
        if (reader.byte() !== 11) throw invalidGif("MALFORMED");
        const app = reader.ascii(11);
        if (app === "NETSCAPE2.0" || app === "ANIMEXTS1.0") {
          if (loopSeen || reader.byte() !== 3 || reader.byte() !== 1)
            throw invalidGif("MALFORMED");
          const repetitions = reader.uint16();
          if (reader.byte() !== 0) throw invalidGif("MALFORMED");
          // GIF 声明的是额外循环次数，sharp/libvips 元数据使用总播放次数。
          loop = repetitions === 0 ? 0 : repetitions + 1;
          loopSeen = true;
        } else reader.subBlocks();
      } else if (label === 0xfe) reader.subBlocks();
      else {
        // Plain Text 等扩展不是普通像素帧，拒绝而非悄悄删除可能可见的内容。
        throw invalidGif("MALFORMED");
      }
      continue;
    }
    if (marker !== 0x2c) throw invalidGif("MALFORMED");
    const x = reader.uint16();
    const y = reader.uint16();
    const frameWidth = reader.uint16();
    const frameHeight = reader.uint16();
    const frameFlags = reader.byte();
    if (
      !frameWidth ||
      !frameHeight ||
      x + frameWidth > width ||
      y + frameHeight > height ||
      (frameFlags & 0x18) !== 0
    )
      throw invalidGif("MALFORMED");
    const localColours = frameFlags & 0x80 ? 1 << ((frameFlags & 7) + 1) : 0;
    reader.skip(localColours * 3);
    const colours = localColours || globalColours;
    if (
      !colours ||
      (control?.transparent != null && control.transparent >= colours)
    )
      throw invalidGif("MALFORMED");
    const minimumCodeSize = reader.byte();
    if (minimumCodeSize < 2 || minimumCodeSize > 8)
      throw invalidGif("MALFORMED");
    // 解压前先约束完整画布资源，不能利用很小的差分块降低安全预算。
    // 新逐帧 worker 不累积解码画布；旧整幅解码器仍必须执行原累计预算。
    if (!options.sequentialFrames) {
      if (delay.length + 1 > GIF_MAX_FRAMES)
        throw invalidGif("FRAMES_EXCEEDED");
      if (width * height * (delay.length + 1) > GIF_MAX_PIXELS)
        throw invalidGif("PIXELS_EXCEEDED");
    }
    const compressed = options.validateCompression
      ? new GifLzwValidator(minimumCodeSize, frameWidth * frameHeight, colours)
      : undefined;
    try {
      if (
        reader.subBlocks(
          compressed ? (bytes) => compressed.consume(bytes) : undefined,
        ) === 0
      )
        throw invalidGif("MALFORMED");
      compressed?.finish();
    } catch {
      throw invalidGif("MALFORMED");
    }
    // 无 GCE 的帧没有显式时长，采用 libvips 的 100ms 默认；显式 0ms 不改写。
    delay.push(control?.delay ?? 100);
    control = undefined;
  }
  throw invalidGif("MALFORMED");
}

/** 按显式预算读取普通文件（默认 10 MiB），严格检查长度与容器且不追随符号链接。 */
export async function assertValidGifFile(
  path: string,
  options: GifValidationOptions = {},
): Promise<GifDimensions> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw invalidGif("MALFORMED");
  const file = await open(path, "r");
  try {
    const stats = await file.stat();
    if (!stats.isFile() || stats.size < 1) throw invalidGif("MALFORMED");
    if (stats.size > (options.maxBytes ?? DEFAULT_MAX_BYTES))
      throw imageTooLarge();
    const bytes = Buffer.allocUnsafe(stats.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!bytesRead) throw invalidGif("MALFORMED");
      offset += bytesRead;
    }
    if ((await file.stat()).size !== bytes.length)
      throw invalidGif("MALFORMED");
    return assertValidGif(bytes, options);
  } finally {
    await file.close();
  }
}

/** 比较全部动画属性，防止解码器静默截断帧、修改延迟或循环次数。 */
export function sameGifDimensions(
  actual: GifDimensions,
  expected: GifDimensions,
): boolean {
  return (
    actual.width === expected.width &&
    actual.height === expected.height &&
    actual.frames === expected.frames &&
    actual.loop === expected.loop &&
    actual.delay.length === expected.delay.length &&
    actual.delay.every((value, index) => value === expected.delay[index])
  );
}

/** 固定大小游标检查每一次读取与跳过，子块只计数不复制压缩载荷。 */
class GifReader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  get done(): boolean {
    return this.offset === this.bytes.length;
  }
  byte(): number {
    this.skip(1);
    return this.bytes[this.offset - 1]!;
  }
  uint16(): number {
    return this.byte() | (this.byte() << 8);
  }
  ascii(length: number): string {
    this.skip(length);
    return String.fromCharCode(
      ...this.bytes.subarray(this.offset - length, this.offset),
    );
  }
  skip(length: number): void {
    if (this.offset + length > this.bytes.length) throw invalidGif("MALFORMED");
    this.offset += length;
  }
  subBlocks(consume?: (bytes: Uint8Array) => void): number {
    let length = 0;
    for (let size = this.byte(); size !== 0; size = this.byte()) {
      this.skip(size);
      consume?.(this.bytes.subarray(this.offset - size, this.offset));
      length += size;
    }
    return length;
  }
}

/** 只暴露稳定原因，不返回压缩载荷、原始路径或解码器信息。 */
function invalidGif(reason: string): ImageNormalizationError {
  return new ImageNormalizationError(
    "INVALID_IMAGE",
    "The uploaded image is not an accepted GIF",
    { reason },
  );
}
