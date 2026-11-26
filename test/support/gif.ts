import sharp from "sharp";

/** 生成真正可解码的多帧 GIF，支持重复帧以验证归一化绝不合并帧。 */
export async function encodedGif(
  options: {
    width?: number;
    height?: number;
    frames?: number;
    delay?: number[];
    loop?: number;
    duplicate?: boolean;
  } = {},
): Promise<Buffer> {
  const {
    width = 4,
    height = 3,
    frames = 3,
    delay = [40, 90, 180],
    loop = 3,
    duplicate = false,
  } = options;
  const bytes = Buffer.alloc(width * height * frames * 3);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const offset = (frame * width * height + pixel) * 3;
      bytes[offset] = duplicate ? 12 : frame * 70;
      bytes[offset + 1] = 80;
      bytes[offset + 2] = 160;
    }
  }
  return sharp(bytes, {
    raw: { width, height: height * frames, channels: 3, pageHeight: height },
  })
    .gif({ delay, loop, keepDuplicateFrames: true })
    .toBuffer();
}

/** 构建完整容器边界的声明样本；只有 1×1 时压缩像素完整，其余用于预检资源上限。 */
export function gifContainer(width = 1, height = 1, frames = 1): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt16LE(width, 0);
  size.writeUInt16LE(height, 2);
  const header = Buffer.concat([
    Buffer.from("GIF89a"),
    size,
    Buffer.from([0x80, 0, 0, 0, 0, 0, 255, 255, 255]),
  ]);
  const frame = Buffer.concat([
    Buffer.from([0x21, 0xf9, 4, 0, 5, 0, 0, 0, 0x2c, 0, 0, 0, 0]),
    size,
    Buffer.from([0, 2, 2, 0x44, 0x01, 0]),
  ]);
  return Buffer.concat([
    header,
    ...Array.from({ length: frames }, () => frame),
    Buffer.from([0x3b]),
  ]);
}
