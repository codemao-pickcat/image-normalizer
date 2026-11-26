import { open, type FileHandle } from "node:fs/promises";
import { ImageNormalizationError } from "./errors.js";
import { MAX_DIMENSION, MAX_PIXELS } from "./limits.js";

/** 稳定的 WebP 拒绝原因，供客户端按类别提示而不暴露原始元数据。 */
export type WebpInvalidReason =
  | "NOT_WEBP"
  | "ANIMATED"
  | "METADATA_PRESENT"
  | "DIMENSIONS_EXCEEDED"
  | "MALFORMED";

type Dimensions = { width: number; height: number; alpha: boolean };
/** 经静态 WebP 容器和帧头预检的尺寸；压缩流仍须经过独立进程重编码。 */
export type StaticWebpDimensions = Pick<Dimensions, "width" | "height">;
type Chunk = {
  type: string;
  payload: Uint8Array;
  payloadLength: number;
};
type ParseOptions = { allowMetadata?: boolean };

const METADATA_CHUNK_TYPES = new Set(["EXIF", "XMP ", "ICCP"]);
const METADATA_CHUNK_FLAGS: Record<string, number> = {
  ICCP: 0x20,
  EXIF: 0x08,
  "XMP ": 0x04,
};
const IMAGE_CHUNK_TYPES = new Set(["VP8X", "ALPH", "VP8 ", "VP8L"]);

/**
 * Sharp 输入门闩：确认静态 WebP、帧头尺寸和像素预算，允许 ICCP/EXIF/XMP。
 * 不解码压缩像素；元数据由后续无损重编码丢弃，不能当作已入库。
 */
export function assertDecodableStaticWebp(
  bytes: Uint8Array,
): StaticWebpDimensions {
  return inspectStaticWebp(bytes, { allowMetadata: true });
}

/** 磁盘上的可解码预检，压缩载荷只读帧头。 */
export async function assertDecodableStaticWebpFile(
  path: string,
): Promise<StaticWebpDimensions> {
  return inspectStaticWebpFile(path, { allowMetadata: true });
}

/**
 * 入库物校验：无元数据、无未知 chunk、RIFF 长度精确。
 * 只用于 Sharp 输出或必须原样保存的静态 WebP，不用于云转码产物。
 */
export function assertValidStaticWebp(bytes: Uint8Array): StaticWebpDimensions {
  return inspectStaticWebp(bytes);
}

/** 磁盘上的入库物校验。 */
export async function assertValidStaticWebpFile(
  path: string,
): Promise<StaticWebpDimensions> {
  return inspectStaticWebpFile(path);
}

function inspectStaticWebp(
  bytes: Uint8Array,
  options: ParseOptions = {},
): StaticWebpDimensions {
  if (
    bytes.byteLength < 20 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 12) !== "WEBP"
  ) {
    throw imageInvalid("NOT_WEBP");
  }

  const declaredEnd = readUint32(bytes, 4) + 8;
  // RIFF 大小必须覆盖全部实际字节；仅各 chunk 的奇数长度允许一个零 padding。
  if (
    declaredEnd < 20 ||
    declaredEnd !== bytes.byteLength ||
    declaredEnd % 2 !== 0
  ) {
    throw imageInvalid("MALFORMED");
  }

  const chunks = parseChunks(bytes, declaredEnd, options);
  return boundedDimensions(validateChunkLayout(chunks, options));
}

async function inspectStaticWebpFile(
  path: string,
  options: ParseOptions = {},
): Promise<StaticWebpDimensions> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    if (size < 20) throw imageInvalid("NOT_WEBP");
    const header = await readExact(file, 0, 12);
    if (ascii(header, 0, 4) !== "RIFF" || ascii(header, 8, 12) !== "WEBP") {
      throw imageInvalid("NOT_WEBP");
    }

    const declaredEnd = readUint32(header, 4) + 8;
    if (declaredEnd < 20 || declaredEnd !== size || declaredEnd % 2 !== 0) {
      throw imageInvalid("MALFORMED");
    }
    const chunks = await parseFileChunks(file, declaredEnd, options);
    return boundedDimensions(validateChunkLayout(chunks, options));
  } finally {
    await file.close();
  }
}

function boundedDimensions(dimensions: Dimensions): StaticWebpDimensions {
  if (
    dimensions.width > MAX_DIMENSION ||
    dimensions.height > MAX_DIMENSION ||
    dimensions.width * dimensions.height > MAX_PIXELS
  ) {
    throw imageInvalid("DIMENSIONS_EXCEEDED");
  }
  return { width: dimensions.width, height: dimensions.height };
}

/**
 * 去掉静态 WebP 的 ICCP/EXIF/XMP 及 VP8X 元数据标志，不解码像素。
 * 入站不再依赖此函数过预检；保留给需要在 JS 里剥元数据的调用方。
 */
export function stripStaticWebpMetadata(bytes: Uint8Array): Uint8Array {
  if (
    bytes.byteLength < 20 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 12) !== "WEBP"
  ) {
    throw imageInvalid("NOT_WEBP");
  }
  const declaredEnd = readUint32(bytes, 4) + 8;
  if (
    declaredEnd < 20 ||
    declaredEnd !== bytes.byteLength ||
    declaredEnd % 2 !== 0
  ) {
    throw imageInvalid("MALFORMED");
  }
  const chunks = parseChunks(bytes, declaredEnd, { allowMetadata: true });
  validateChunkLayout(chunks, { allowMetadata: true });
  if (!chunks.some((chunk) => METADATA_CHUNK_TYPES.has(chunk.type))) {
    return bytes;
  }
  return rebuildWebpWithoutMetadata(chunks);
}

/** 按 RIFF 声明边界解析 chunk，并严格校验长度与零 padding。 */
function parseChunks(
  bytes: Uint8Array,
  declaredEnd: number,
  options: ParseOptions = {},
): Chunk[] {
  const chunks: Chunk[] = [];
  let offset = 12;
  while (offset < declaredEnd) {
    if (offset + 8 > declaredEnd) throw imageInvalid("MALFORMED");
    const type = ascii(bytes, offset, offset + 4);
    const length = readUint32(bytes, offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + length;
    if (payloadEnd > declaredEnd) throw imageInvalid("MALFORMED");
    chunks.push({
      type,
      payload: bytes.subarray(payloadStart, payloadEnd),
      payloadLength: length,
    });
    // 边读边拒绝未知/重复 chunk，使攻击者不能用大量空 chunk 撑大数组与解析时间。
    validateChunkTypes(chunks, options);
    offset = payloadEnd;
    if (length % 2 === 1) {
      if (offset >= declaredEnd || bytes[offset] !== 0) {
        throw imageInvalid("MALFORMED");
      }
      offset += 1;
    }
  }
  if (offset !== declaredEnd || chunks.length === 0) {
    throw imageInvalid("MALFORMED");
  }
  return chunks;
}

/** 逐个读取 RIFF chunk 头与最多十字节帧头，跳过压缩像素载荷。 */
async function parseFileChunks(
  file: FileHandle,
  declaredEnd: number,
  options: ParseOptions = {},
): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  let offset = 12;
  while (offset < declaredEnd) {
    if (offset + 8 > declaredEnd) throw imageInvalid("MALFORMED");
    const header = await readExact(file, offset, 8);
    const type = ascii(header, 0, 4);
    const length = readUint32(header, 4);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + length;
    if (payloadEnd > declaredEnd) throw imageInvalid("MALFORMED");
    chunks.push({
      type,
      payload: await readExact(file, payloadStart, Math.min(length, 10)),
      payloadLength: length,
    });
    // 合法类型只有四种且不能重复，尽早校验让随机读取次数也保持有界。
    validateChunkTypes(chunks, options);
    offset = payloadEnd;
    if (length % 2 === 1) {
      if (offset >= declaredEnd) throw imageInvalid("MALFORMED");
      const padding = await readExact(file, offset, 1);
      if (padding[0] !== 0) throw imageInvalid("MALFORMED");
      offset += 1;
    }
  }
  if (offset !== declaredEnd || chunks.length === 0) {
    throw imageInvalid("MALFORMED");
  }
  return chunks;
}

/** 从确定位置完整读取指定字节数，短读统一视为容器损坏。 */
async function readExact(
  file: FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const result = await file.read(bytes, read, length - read, position + read);
    if (result.bytesRead === 0) throw imageInvalid("MALFORMED");
    read += result.bytesRead;
  }
  return bytes;
}

/** 在布局校验前区分动画、元数据与一般非法 chunk。 */
function validateChunkTypes(
  chunks: readonly Chunk[],
  options: ParseOptions = {},
): void {
  const seen = new Set<string>();
  const allowMetadata = options.allowMetadata === true;
  for (const chunk of chunks) {
    if (chunk.type === "ANIM" || chunk.type === "ANMF") {
      throw imageInvalid("ANIMATED");
    }
    if (METADATA_CHUNK_TYPES.has(chunk.type)) {
      if (!allowMetadata) throw imageInvalid("METADATA_PRESENT");
    } else if (!IMAGE_CHUNK_TYPES.has(chunk.type)) {
      throw imageInvalid("MALFORMED");
    }
    if (seen.has(chunk.type)) throw imageInvalid("MALFORMED");
    seen.add(chunk.type);
  }
}

/** 校验 simple/extended WebP 的唯一合法排列，并交叉核对 canvas 与帧尺寸。 */
function validateChunkLayout(
  chunks: readonly Chunk[],
  options: ParseOptions = {},
): Dimensions {
  const allowMetadata = options.allowMetadata === true;
  if (chunks[0]?.type === "VP8X") parseVp8x(chunks[0], allowMetadata);
  if (allowMetadata) validateMetadataPlacement(chunks);
  const image = allowMetadata
    ? chunks.filter((chunk) => !METADATA_CHUNK_TYPES.has(chunk.type))
    : chunks;
  if (image.length === 1 && image[0]?.type === "VP8 ") {
    return parseVp8(image[0]);
  }
  if (image.length === 1 && image[0]?.type === "VP8L") {
    return parseVp8l(image[0]);
  }
  if (image[0]?.type !== "VP8X") throw imageInvalid("MALFORMED");

  const extended = parseVp8x(image[0], allowMetadata);
  if (allowMetadata) {
    const flags = image[0].payload[0]!;
    const expected = chunks.reduce(
      (value, chunk) => value | (METADATA_CHUNK_FLAGS[chunk.type] ?? 0),
      0,
    );
    if ((flags & 0x2c) !== expected) throw imageInvalid("MALFORMED");
  }
  const remainder = image.slice(1);
  let frame: Dimensions;
  let hasAlphaChunk = false;
  if (
    remainder.length === 2 &&
    remainder[0]?.type === "ALPH" &&
    remainder[1]?.type === "VP8 "
  ) {
    hasAlphaChunk = true;
    validateAlphaHeader(remainder[0], extended);
    frame = parseVp8(remainder[1]);
  } else if (remainder.length === 1 && remainder[0]?.type === "VP8 ") {
    frame = parseVp8(remainder[0]);
  } else if (remainder.length === 1 && remainder[0]?.type === "VP8L") {
    frame = parseVp8l(remainder[0]);
  } else {
    throw imageInvalid("MALFORMED");
  }

  const actualAlpha = hasAlphaChunk || frame.alpha;
  if (
    extended.width !== frame.width ||
    extended.height !== frame.height ||
    extended.alpha !== actualAlpha
  ) {
    throw imageInvalid("MALFORMED");
  }
  return extended;
}

/** RFC 9649：VP8X 后可选 ICCP，再是像素块，EXIF/XMP 只能在帧后。 */
function validateMetadataPlacement(chunks: readonly Chunk[]): void {
  if (chunks[0]?.type !== "VP8X") {
    if (chunks.some((chunk) => METADATA_CHUNK_TYPES.has(chunk.type))) {
      throw imageInvalid("MALFORMED");
    }
    return;
  }
  let index = 1;
  if (chunks[index]?.type === "ICCP") index += 1;
  if (chunks[index]?.type === "ALPH") index += 1;
  const frame = chunks[index];
  if (!frame || (frame.type !== "VP8 " && frame.type !== "VP8L")) {
    throw imageInvalid("MALFORMED");
  }
  for (const trailing of chunks.slice(index + 1)) {
    if (trailing.type !== "EXIF" && trailing.type !== "XMP ") {
      throw imageInvalid("MALFORMED");
    }
  }
}

/** 把已通过布局校验的静态帧写回不含元数据的 RIFF。 */
function rebuildWebpWithoutMetadata(chunks: readonly Chunk[]): Uint8Array {
  const retained = chunks
    .filter((chunk) => !METADATA_CHUNK_TYPES.has(chunk.type))
    .map((chunk) => {
      if (chunk.type !== "VP8X") return chunk;
      const payload = Uint8Array.from(chunk.payload);
      payload[0] = payload[0]! & ~0x2c;
      return { ...chunk, payload, payloadLength: payload.byteLength };
    });
  const bodyLength = retained.reduce(
    (total, chunk) =>
      total + 8 + chunk.payloadLength + (chunk.payloadLength % 2),
    4,
  );
  const output = new Uint8Array(bodyLength + 8);
  writeAscii(output, 0, "RIFF");
  writeUint32(output, 4, bodyLength);
  writeAscii(output, 8, "WEBP");
  let offset = 12;
  for (const chunk of retained) {
    writeAscii(output, offset, chunk.type);
    writeUint32(output, offset + 4, chunk.payloadLength);
    output.set(chunk.payload, offset + 8);
    offset += 8 + chunk.payloadLength + (chunk.payloadLength % 2);
  }
  return output;
}

/** 解析扩展 WebP canvas 与 feature flags，拒绝保留位、动画和元数据声明。 */
function parseVp8x(chunk: Chunk, allowMetadata = false): Dimensions {
  const { payload } = chunk;
  if (chunk.payloadLength !== 10) throw imageInvalid("MALFORMED");
  const flags = payload[0]!;
  if ((flags & 0x02) !== 0) throw imageInvalid("ANIMATED");
  if (!allowMetadata && (flags & 0x2c) !== 0) {
    throw imageInvalid("METADATA_PRESENT");
  }
  if ((flags & 0xc1) !== 0 || payload[1] || payload[2] || payload[3]) {
    throw imageInvalid("MALFORMED");
  }
  return {
    width: readUint24(payload, 4) + 1,
    height: readUint24(payload, 7) + 1,
    alpha: (flags & 0x10) !== 0,
  };
}

/** 解析 VP8 key frame 头；静态 WebP 不接受 inter frame。 */
function parseVp8(chunk: Chunk): Dimensions {
  const { payload } = chunk;
  if (chunk.payloadLength < 10) throw imageInvalid("MALFORMED");
  const frameTag = payload[0]! | (payload[1]! << 8) | (payload[2]! << 16);
  if (
    (frameTag & 1) !== 0 ||
    ((frameTag >>> 1) & 0x07) > 3 ||
    ((frameTag >>> 4) & 1) !== 1 ||
    // RFC 6386 的第一分区不包括 key frame 的十字节未压缩帧头。
    frameTag >>> 5 === 0 ||
    frameTag >>> 5 > chunk.payloadLength - 10 ||
    payload[3] !== 0x9d ||
    payload[4] !== 0x01 ||
    payload[5] !== 0x2a
  ) {
    throw imageInvalid("MALFORMED");
  }
  const width = readUint16(payload, 6) & 0x3fff;
  const height = readUint16(payload, 8) & 0x3fff;
  if (!width || !height) throw imageInvalid("MALFORMED");
  return { width, height, alpha: false };
}

/** 校验 ALPH 标志与固定长度原始像素面；压缩模式的完整消费交给后续重编码。 */
function validateAlphaHeader(chunk: Chunk, dimensions: Dimensions): void {
  const { payload } = chunk;
  if (chunk.payloadLength < 1) throw imageInvalid("MALFORMED");
  const header = payload[0]!;
  const compressionMethod = header & 0x03;
  const preprocessing = (header >>> 4) & 0x03;
  if (compressionMethod > 1 || preprocessing > 1 || (header & 0xc0) !== 0) {
    throw imageInvalid("MALFORMED");
  }
  // 未压缩 ALPH 每个像素恰好一个字节，不能用增大 chunk 声明掩盖附加载荷。
  if (
    compressionMethod === 0 &&
    chunk.payloadLength !== 1 + dimensions.width * dimensions.height
  ) {
    throw imageInvalid("MALFORMED");
  }
  if (compressionMethod === 1 && chunk.payloadLength === 1) {
    throw imageInvalid("MALFORMED");
  }
}

/** 解析 VP8L 帧头，读取 14-bit 尺寸、alpha 标志与版本号。 */
function parseVp8l(chunk: Chunk): Dimensions {
  const { payload } = chunk;
  if (chunk.payloadLength < 5 || payload[0] !== 0x2f) {
    throw imageInvalid("MALFORMED");
  }
  const bits = readUint32(payload, 1);
  if (bits >>> 29 !== 0) throw imageInvalid("MALFORMED");
  return {
    width: (bits & 0x3fff) + 1,
    height: ((bits >>> 14) & 0x3fff) + 1,
    alpha: ((bits >>> 28) & 1) === 1,
  };
}

/** 返回稳定的图片拒绝原因，由宿主决定 HTTP 状态或其他响应形式。 */
function imageInvalid(reason: WebpInvalidReason): ImageNormalizationError {
  return new ImageNormalizationError(
    "INVALID_IMAGE",
    "The uploaded image is not an accepted static WebP",
    { reason },
  );
}

/** 读取小端 16-bit 无符号整数。 */
function readUint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

/** 读取小端 24-bit 无符号整数。 */
function readUint24(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
  );
}

/** 读取小端 32-bit 无符号整数。 */
function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

/** 将 ASCII 字节片段转换为 fourCC/容器标识。 */
function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/** 写入 fourCC/容器标识。 */
function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

/** 写入小端 32-bit 无符号整数。 */
function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}
