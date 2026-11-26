import { assertValidGif } from "./gif-validator.js";

/** 逐帧 GIF 解码输出借用同一个画布；调用者必须在推进迭代器前编码或复制。 */
export function* decodeGifFrames(
  bytes: Buffer,
): Generator<{ pixels: Buffer; duration: number }> {
  const metadata = assertValidGif(bytes, { sequentialFrames: true });
  const { width, height } = metadata;
  let offset = 13;
  const global =
    bytes[10]! & 128
      ? bytes.subarray(offset, (offset += 3 * (1 << ((bytes[10]! & 7) + 1))))
      : Buffer.alloc(0);
  const canvas = Buffer.alloc(width * height * 4);
  let transparent = -1,
    disposal = 0,
    duration = 100,
    firstFrame = true;
  const background = Buffer.from([
    global[bytes[11]! * 3] ?? 0,
    global[bytes[11]! * 3 + 1] ?? 0,
    global[bytes[11]! * 3 + 2] ?? 0,
    global.length ? 255 : 0,
  ]);
  const subBlocks = () => {
    const blocks: Buffer[] = [];
    for (let size = bytes[offset++]!; size; size = bytes[offset++]!) {
      blocks.push(bytes.subarray(offset, (offset += size)));
    }
    return Buffer.concat(blocks);
  };
  while (offset < bytes.length) {
    const marker = bytes[offset++]!;
    if (marker === 0x3b) return;
    if (marker === 0x21) {
      const label = bytes[offset++]!;
      if (label === 0xf9) {
        offset++;
        const flags = bytes[offset++]!;
        disposal = (flags >> 2) & 7;
        duration = bytes.readUInt16LE(offset) * 10;
        offset += 2;
        transparent = flags & 1 ? bytes[offset]! : -1;
        offset += 2;
      } else subBlocks();
      continue;
    }
    const x = bytes.readUInt16LE(offset),
      y = bytes.readUInt16LE(offset + 2);
    const w = bytes.readUInt16LE(offset + 4),
      h = bytes.readUInt16LE(offset + 6);
    const flags = bytes[offset + 8]!;
    offset += 9;
    const palette =
      flags & 128
        ? bytes.subarray(offset, (offset += 3 * (1 << ((flags & 7) + 1))))
        : global;
    const minimum = bytes[offset++]!;
    const indices = decodeIndices(
      subBlocks(),
      minimum,
      w * h,
      palette.length / 3,
    );
    if (firstFrame) {
      if (transparent < 0) canvas.fill(background);
      firstFrame = false;
    }
    // disposal=previous 最多多保留一个画布，与帧总数和总时长无关。
    const previous = disposal === 3 ? Buffer.from(canvas) : undefined;
    let sourceRow = 0;
    const rows: number[] = [];
    if (flags & 64) {
      for (const [start, step] of [
        [0, 8],
        [4, 8],
        [2, 4],
        [1, 2],
      ])
        for (let row = start!; row < h; row += step!) rows.push(row);
    } else for (let row = 0; row < h; row++) rows.push(row);
    for (const row of rows) {
      for (let col = 0; col < w; col++) {
        const index = indices[sourceRow * w + col]!;
        if (index === transparent) continue;
        const at = ((y + row) * width + x + col) * 4;
        canvas[at] = palette[index * 3]!;
        canvas[at + 1] = palette[index * 3 + 1]!;
        canvas[at + 2] = palette[index * 3 + 2]!;
        canvas[at + 3] = 255;
      }
      sourceRow++;
    }
    if (!duration) throw new Error("Ambiguous zero GIF frame duration");
    yield { pixels: canvas, duration };
    if (previous) previous.copy(canvas);
    else if (disposal === 2) {
      for (let row = y; row < y + h; row++)
        canvas.fill(
          transparent < 0 ? background : Buffer.alloc(4),
          (row * width + x) * 4,
          (row * width + x + w) * 4,
        );
    }
    transparent = -1;
    disposal = 0;
    duration = 100;
  }
}

/** 固定 4096 项字典和单帧索引面，不缓存历次像素或无限扩张字典。 */
function decodeIndices(
  data: Buffer,
  minimum: number,
  expected: number,
  colours: number,
): Uint8Array {
  const clear = 1 << minimum,
    end = clear + 1;
  const prefix = new Uint16Array(4096),
    suffix = new Uint8Array(4096),
    stack = new Uint8Array(4096);
  for (let i = 0; i < clear; i++) suffix[i] = i;
  const output = new Uint8Array(expected);
  let next = end + 1,
    bits = minimum + 1,
    previous = -1,
    first = 0,
    pos = 0,
    bit = 0;
  while (bit + bits <= data.length * 8) {
    let code = 0;
    for (let i = 0; i < bits; i++, bit++)
      code |= ((data[bit >> 3]! >> (bit & 7)) & 1) << i;
    if (code === clear) {
      next = end + 1;
      bits = minimum + 1;
      previous = -1;
      continue;
    }
    if (code === end) {
      const consumed = Math.ceil(bit / 8);
      // 与压缩流校验一致，只兼容 ffmpeg 在字节对齐 EOI 后生成的单个零填充字节。
      const padded =
        bit % 8 === 0 && data.length === consumed + 1 && data[consumed] === 0;
      if (pos !== expected || (consumed !== data.length && !padded))
        throw new Error("Incomplete GIF");
      return output;
    }
    const original = code;
    let top = 0;
    if (code === next && previous !== -1) {
      stack[top++] = first;
      code = previous;
    } else if (code >= next) throw new Error("Invalid GIF dictionary");
    while (code >= clear) {
      if (code <= end || top >= 4095) throw new Error("Invalid GIF dictionary");
      stack[top++] = suffix[code]!;
      code = prefix[code]!;
    }
    if (code >= colours) throw new Error("Invalid GIF palette");
    first = code;
    stack[top++] = first;
    if (pos + top > expected) throw new Error("GIF exceeds frame");
    while (top) output[pos++] = stack[--top]!;
    if (previous !== -1 && next < 4096) {
      prefix[next] = previous;
      suffix[next++] = first;
      if (next === 1 << bits && bits < 12) bits++;
    }
    previous = original;
  }
  throw new Error("Missing GIF end");
}
