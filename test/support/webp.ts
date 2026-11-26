import sharp from "sharp";

/** 生成真实可解码的纯色 WebP，上传测试必须经过服务端解码与重编码。 */
export async function encodedWebp(
  width = 1,
  height = 1,
  background = { r: 40, g: 120, b: 200 },
): Promise<Uint8Array> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background,
    },
  })
    .webp({ lossless: true, effort: 0 })
    .toBuffer();
}

/** 构造仅含 VP8L 帧头的最小静态 WebP，仅供纯容器测试使用。 */
export function minimalLosslessWebp(width = 1, height = 1): Uint8Array {
  if (width < 1 || width > 16_384 || height < 1 || height > 16_384) {
    throw new Error("WebP test dimensions are out of range");
  }
  const bits = (width - 1) | ((height - 1) << 14);
  const payload = Uint8Array.from([
    0x2f,
    bits & 0xff,
    (bits >>> 8) & 0xff,
    (bits >>> 16) & 0xff,
    (bits >>> 24) & 0xff,
  ]);
  return riff([{ type: "VP8L", payload }]);
}

/** 构造测试 RIFF WebP，可注入非法 chunk 覆盖拒绝分支。 */
export function riff(
  chunks: readonly { type: string; payload: Uint8Array }[],
): Uint8Array {
  const bodyLength = chunks.reduce(
    (total, chunk) =>
      total + 8 + chunk.payload.byteLength + (chunk.payload.byteLength % 2),
    4,
  );
  const result = new Uint8Array(bodyLength + 8);
  writeAscii(result, 0, "RIFF");
  writeUint32(result, 4, bodyLength);
  writeAscii(result, 8, "WEBP");
  let offset = 12;
  for (const chunk of chunks) {
    writeAscii(result, offset, chunk.type);
    writeUint32(result, offset + 4, chunk.payload.byteLength);
    result.set(chunk.payload, offset + 8);
    offset += 8 + chunk.payload.byteLength + (chunk.payload.byteLength % 2);
  }
  return result;
}

/** 写入 fourCC 测试文本。 */
function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

/** 写入小端 32-bit 测试整数。 */
function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}
