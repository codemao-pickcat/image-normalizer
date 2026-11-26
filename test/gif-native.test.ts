import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  available,
  transcode,
  validate,
  validateFile,
} from "../native/index.cjs";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { assertValidGif } from "../src/gif-validator.js";
import { GifNormalizer } from "../src/gif-normalizer.js";
import { encodedGif, gifContainer } from "./support/gif.js";
import { indexedGif } from "./support/indexed-gif.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** 每项测试独占输出文件，以便检查排他创建和超限后的实际大小。 */
async function files(bytes: Buffer) {
  const root = await mkdtemp(join(tmpdir(), "pickcat-indexed-gif-"));
  directories.push(root);
  const input = join(root, "input.gif"),
    output = join(root, "output.gif");
  await writeFile(input, bytes);
  return { input, output };
}

/** 由独立解码器逐像素比较所有已合成帧，同时核对原 JS 验证器的完整时间轴。 */
async function roundTrip(source: Buffer) {
  const { input, output } = await files(source);
  expect(transcode(input, output, 20_000_000)).toBe(0);
  const result = await readFile(output);
  expect(assertValidGif(result, { validateCompression: true })).toEqual(
    assertValidGif(source, { validateCompression: true }),
  );
  expect(validate(result)).toEqual(validate(source));
  expect(
    await sharp(result, { animated: true }).ensureAlpha().raw().toBuffer(),
  ).toEqual(
    await sharp(source, { animated: true }).ensureAlpha().raw().toBuffer(),
  );
  return { input, output, result };
}

describe.skipIf(!available)("bounded native GIF codec", () => {
  it.each([0, 1, 2, 3])(
    "disposal %s 保持全局/局部色表、透明和交错帧画面",
    async (disposal) => {
      for (const local of [false, true])
        for (const interlace of [false, true]) {
          await roundTrip(indexedGif({ disposal, local, interlace }));
        }
    },
  );

  it("移除未知扩展及未使用调色板数据，保留隐式延迟和 ffmpeg 零填充", async () => {
    const source = indexedGif({ secret: true });
    const marker = Buffer.from("PRIVATE-COMMENT");
    const bytes = Buffer.concat([
      source.subarray(0, -1),
      Buffer.from([0x21, 0xfe, marker.length]),
      marker,
      Buffer.from([0, 0x3b]),
    ]);
    const { result } = await roundTrip(bytes);
    expect(result.includes(marker)).toBe(false);
    expect(result.includes(Buffer.from("UNUSED-PALETTE-SECRET"))).toBe(false);
    await roundTrip(indexedGif({ noGce: true }));
    await roundTrip(
      await readFile(
        new URL("./fixtures/ffmpeg-transparent-diff.gif", import.meta.url),
      ),
    );
  });

  it.each([0, 1, 3, 65536])(
    "单帧和重复多帧保留 loop=%s、零和最大延迟",
    async (loop) => {
      for (const frames of [1, 3]) {
        const source = await encodedGif({
          frames,
          delay: frames === 1 ? [0] : [0, 10, 90],
          loop: loop === 65536 ? 3 : loop,
          duplicate: true,
        });
        if (loop === 65536) {
          source.writeUInt16LE(
            65535,
            source.indexOf(Buffer.from("NETSCAPE2.0")) + 13,
          );
          source.writeUInt16LE(
            65535,
            source.indexOf(Buffer.from([0x21, 0xf9, 4])) + 4,
          );
        }
        await roundTrip(source);
      }
    },
  );

  it("拒绝畸形压缩流、尾随数据、符号链接和无效参数，不覆盖已有文件", async () => {
    const good = gifContainer();
    for (const bad of [
      gifContainer(20, 20),
      good.subarray(0, -2),
      Buffer.concat([good, Buffer.from([0])]),
    ]) {
      const { input, output } = await files(bad);
      expect(transcode(input, output, 20_000_000)).toBe(1);
      expect(() => validate(bad)).toThrow();
    }
    const { input, output } = await files(good);
    await symlink(input, output);
    expect(() => validateFile(output, 20_000_000)).toThrow();
    expect(transcode(output, output + ".out", 20_000_000)).toBe(1);
    expect(transcode(input, output, 20_000_000)).toBe(1);
    expect(await readFile(input)).toEqual(good);
    for (const budget of [
      NaN,
      Infinity,
      0,
      -1,
      0.5,
      20_000_001,
      2 ** 32 + 20,
    ]) {
      expect(() => transcode(input, output, budget)).toThrow();
      expect(() => validateFile(input, budget)).toThrow();
    }
    for (const path of [input + "\0ignored", "x".repeat(4096), ""]) {
      expect(() => transcode(path, output, 20_000_000)).toThrow();
      expect(() => validateFile(path, 20_000_000)).toThrow();
    }
  });

  it("排他创建 0600 输出，严格预算截断且不写越界字节", async () => {
    const { input, output, result } = await roundTrip(await encodedGif());
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    for (const budget of [1, 20, result.length - 1]) {
      const target = output + budget;
      expect(transcode(input, target, budget)).toBe(3);
      expect((await stat(target)).size).toBeLessThanOrEqual(budget);
    }
    expect(transcode(input, output + "exact", result.length)).toBe(0);
  });

  it("原 JS 与 native 对逐字节变异、截断和随机畸形输入保持一致", async () => {
    // 独立参考实现比较接受/拒绝及元数据，不把 native 的输出当作自己的 oracle。
    const check = (bytes: Buffer) => {
      for (const strict of [false, true]) {
        let js,
          nv,
          jsBad = false,
          nativeBad = false;
        try {
          js = assertValidGif(bytes, {
            validateCompression: strict,
            maxBytes: 20_000_000,
          });
        } catch {
          jsBad = true;
        }
        try {
          nv = validate(bytes, strict);
        } catch {
          nativeBad = true;
        }
        assert.equal(nativeBad, jsBad);
        if (!jsBad) assert.deepEqual(nv, js);
      }
    };
    const basic = gifContainer();
    for (let pos = 0; pos < basic.length; pos++)
      for (let value = 0; value < 256; value++) {
        const bytes = Buffer.from(basic);
        bytes[pos] = value;
        check(bytes);
      }
    // 除正常尺寸外，明确覆盖 C/JS 两侧的边长、帧数和累计画布预算边界。
    for (const [w, h, n] of [
      [4096, 1, 1],
      [4097, 1, 1],
      [800, 400, 100],
      [800, 401, 100],
      [1, 1, 101],
      [4096, 4096, 2],
    ])
      check(gifContainer(w, h, n));
    const aligned = Buffer.from("000104001000408080", "hex"),
      unaligned = Buffer.from("0001040010004040", "hex");
    for (const data of [aligned, unaligned])
      for (const trailing of [
        Buffer.alloc(0),
        Buffer.from([0]),
        Buffer.from([1]),
        Buffer.from([0, 0]),
      ])
        for (const split of [false, true])
          for (const width of [5, 6, 7]) {
            const bytes = Buffer.concat([data, trailing]);
            const parts = split
              ? Array.from(bytes, (value) => Buffer.from([value]))
              : [bytes];
            check(
              Buffer.concat([
                gifContainer(width, 1).subarray(0, 37),
                Buffer.from([8]),
                ...parts.flatMap((part) => [Buffer.from([part.length]), part]),
                Buffer.from([0, 0x3b]),
              ]),
            );
          }
    const base = await encodedGif();
    for (let size = 0; size < base.length; size++)
      check(base.subarray(0, size));
    let state = 20261126;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };
    for (let i = 0; i < 6000; i++) {
      const bytes = Buffer.from(base);
      for (let j = 0; j < 1 + (i % 4); j++)
        bytes[random() % bytes.length] = random() >>> 24;
      check(bytes);
    }
  });

  it("索引快路径拒绝压缩像素不足和错误元数据，不降级为容忍式解码", async () => {
    const source = gifContainer(300, 300);
    const { input, output } = await files(source);
    const normalizer = new GifNormalizer();
    try {
      const dimensions = assertValidGif(source);
      await expect(
        normalizer.normalize({
          inputPath: input,
          outputPath: output,
          dimensions,
        }),
      ).rejects.toMatchObject({ code: "INVALID_IMAGE" });
      await writeFile(input, await encodedGif({ width: 300, height: 300 }));
      await expect(
        normalizer.normalize({
          inputPath: input,
          outputPath: output + "wrong",
          dimensions,
        }),
      ).rejects.toMatchObject({ code: "INVALID_IMAGE" });
    } finally {
      await normalizer.stop();
    }
  });

  it.each([128, 129])(
    "真实 worker 在累计像素阈值两侧保留重复帧、时间轴并执行输出预算（height=%s）",
    async (height) => {
      const source = await encodedGif({
        width: 256,
        height,
        frames: 2,
        delay: [0, 90],
        duplicate: true,
      });
      const { input, output } = await files(source);
      const normalizer = new GifNormalizer();
      try {
        const dimensions = assertValidGif(source);
        const result = await normalizer.normalize({
          inputPath: input,
          outputPath: output,
          dimensions,
        });
        expect(result).toMatchObject(dimensions);
        expect(
          await sharp(output, { animated: true })
            .ensureAlpha()
            .raw()
            .toBuffer(),
        ).toEqual(
          await sharp(source, { animated: true })
            .ensureAlpha()
            .raw()
            .toBuffer(),
        );
        await expect(
          normalizer.normalize({
            inputPath: input,
            outputPath: output + "limited",
            dimensions,
            maxBytes: result.byteSize - 1,
          }),
        ).rejects.toMatchObject({ code: "TOO_LARGE" });
      } finally {
        await normalizer.stop();
      }
    },
  );
});
