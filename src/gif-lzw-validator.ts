/**
 * 子进程专用 GIF 压缩流完整性检查器：只展开字典长度，不分配完整像素面。
 * libvips 会容忍提前结束的 GIF，因此需要独立核对每帧像素数、字典引用和终止码。
 */
export class GifLzwValidator {
  private readonly clear: number;
  private readonly end: number;
  private readonly lengths = new Uint32Array(4096);
  private next: number;
  private bits: number;
  private previousLength = 0;
  private pixels = 0;
  private buffer = 0;
  private bufferedBits = 0;
  private ended = false;
  private paddingSeen = false;

  constructor(
    private readonly minimumCodeSize: number,
    private readonly expectedPixels: number,
    private readonly colours: number,
  ) {
    this.clear = 1 << minimumCodeSize;
    this.end = this.clear + 1;
    this.next = this.end + 1;
    this.bits = minimumCodeSize + 1;
  }

  /** 按子块连续供给字节；仅兼容字节对齐终止码后的单个零填充，拒绝其他尾随数据。 */
  consume(bytes: Uint8Array): void {
    for (const byte of bytes) {
      if (this.ended) {
        // ffmpeg 在 EOI 后追加一位零；仅当 EOI 恰好字节对齐时，这一位才独占额外字节。
        // 填充状态跨子块保留，不能借拆分子块夹带多个零字节。
        if (this.bufferedBits !== 0 || this.paddingSeen || byte !== 0)
          throw new Error("Trailing GIF compressed data");
        this.paddingSeen = true;
        continue;
      }
      this.buffer |= byte << this.bufferedBits;
      this.bufferedBits += 8;
      while (!this.ended && this.bufferedBits >= this.bits) {
        const code = this.buffer & ((1 << this.bits) - 1);
        this.buffer >>>= this.bits;
        this.bufferedBits -= this.bits;
        this.code(code);
      }
    }
  }

  /** 缺少终止码或像素数量不符都不是完整帧，不能依靠解码器补背景色。 */
  finish(): void {
    if (!this.ended || this.pixels !== this.expectedPixels)
      throw new Error("Incomplete GIF pixels");
  }

  /** GIF 使用最多 12 位字典；按解码时点扩位，字典满后等待 clear 而非无限增长。 */
  private code(code: number): void {
    if (code === this.clear) {
      this.next = this.end + 1;
      this.bits = this.minimumCodeSize + 1;
      this.previousLength = 0;
      return;
    }
    if (code === this.end) {
      this.ended = true;
      this.finish();
      return;
    }
    let length: number;
    if (code < this.clear) {
      if (code >= this.colours) throw new Error("Invalid GIF colour index");
      length = 1;
    } else if (code < this.next) {
      length = this.lengths[code]!;
    } else if (code === this.next && this.previousLength > 0) {
      // LZW 的唯一合法前向引用是上一字符串追加自己的首像素。
      length = this.previousLength + 1;
    } else throw new Error("Invalid GIF dictionary reference");
    if (!length || this.pixels + length > this.expectedPixels)
      throw new Error("GIF pixels exceed frame");
    this.pixels += length;
    if (this.previousLength && this.next < 4096) {
      this.lengths[this.next] = this.previousLength + 1;
      this.next += 1;
      if (this.next === 1 << this.bits && this.bits < 12) this.bits += 1;
    }
    this.previousLength = length;
  }
}
