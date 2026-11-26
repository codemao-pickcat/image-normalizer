const u16 = (n: number) => Buffer.from([n & 255, n >> 8]);
/** 用固定宽度、每个像素前清字典的独立编码器生成交错和局部色表样本。 */
export function indexedGif({
  disposal = 1,
  interlace = false,
  local = false,
  noGce = false,
  secret = false,
}: {
  disposal?: number;
  interlace?: boolean;
  local?: boolean;
  noGce?: boolean;
  secret?: boolean;
} = {}) {
  const width = 7,
    height = 9;
  const palette = Buffer.alloc(secret ? 768 : 12);
  Buffer.from([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]).copy(palette);
  if (secret) Buffer.from("UNUSED-PALETTE-SECRET").copy(palette, 90);
  const chunks = [
    Buffer.from("GIF89a"),
    u16(width),
    u16(height),
    Buffer.from([secret ? 0xf7 : 0x91, 0, 0]),
    palette,
  ];
  for (let frame = 0; frame < 4; frame++) {
    if (!noGce)
      chunks.push(
        Buffer.from([0x21, 0xf9, 4, (disposal << 2) | 1, frame * 2, 0, 0, 0]),
      );
    const w = frame ? 4 : width,
      h = frame ? 5 : height;
    chunks.push(
      Buffer.from([0x2c]),
      u16(frame ? 1 : 0),
      u16(frame ? 2 : 0),
      u16(w),
      u16(h),
      Buffer.from([(interlace ? 64 : 0) | (local ? 0x81 : 0)]),
    );
    if (local)
      chunks.push(
        Buffer.from([
          0,
          0,
          0,
          255,
          frame * 40,
          0,
          frame * 30,
          255,
          0,
          0,
          frame * 20,
          255,
        ]),
      );
    const rows = interlace
      ? [
          [0, 8],
          [4, 8],
          [2, 4],
          [1, 2],
        ].flatMap(([start, step]) =>
          Array.from(
            { length: Math.max(0, Math.ceil((h - start) / step)) },
            (_, i) => start + i * step,
          ),
        )
      : Array.from({ length: h }, (_, i) => i);
    const codes = [];
    for (const y of rows)
      for (let x = 0; x < w; x++) codes.push(4, (x + y + frame) % 4);
    codes.push(5);
    const data = Buffer.alloc(Math.ceil((codes.length * 3) / 8));
    codes.forEach((code, i) => {
      for (let bit = 0; bit < 3; bit++)
        data[(i * 3 + bit) >> 3] |= ((code >> bit) & 1) << ((i * 3 + bit) & 7);
    });
    chunks.push(Buffer.from([2]));
    for (let pos = 0; pos < data.length; pos += 255)
      chunks.push(
        Buffer.from([Math.min(255, data.length - pos)]),
        data.subarray(pos, pos + 255),
      );
    chunks.push(Buffer.from([0]));
  }
  chunks.push(Buffer.from([0x3b]));
  return Buffer.concat(chunks);
}
