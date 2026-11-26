import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { assertValidGif } from "../src/gif-validator.js";
import { normalizeGif } from "../src/gif-normalizer-worker.js";
import { encodedGif, gifContainer } from "./support/gif.js";

// 模拟不支持 native 的平台，编码和校验均不得误调用不可用的扩展。
vi.mock("../native/index.cjs", () => ({
  available: false,
  transcode: () => {
    throw new Error("Unavailable codec called");
  },
  validateFile: () => {
    throw new Error("Unavailable codec called");
  },
}));

it("无 native 时大小图均保持 Sharp 路径及完整压缩校验和输出预算", async () => {
  const root = await mkdtemp(join(tmpdir(), "pickcat-gif-fallback-"));
  try {
    for (const width of [4, 300]) {
      const bytes = await encodedGif({ width, height: width });
      const inputPath = join(root, `input-${width}.gif`),
        outputPath = join(root, `output-${width}.gif`);
      await writeFile(inputPath, bytes);
      const input = {
        inputPath,
        outputPath,
        dimensions: assertValidGif(bytes),
        maxBytes: 20_000_000,
      };
      expect(await normalizeGif(input)).toBe("OK");
      expect(
        assertValidGif(await readFile(outputPath), {
          validateCompression: true,
        }),
      ).toEqual(input.dimensions);
      expect(
        await normalizeGif({
          ...input,
          outputPath: outputPath + "limited",
          maxBytes: 20,
        }),
      ).toBe("TOO_LARGE");
      const bad = gifContainer(width, width);
      await writeFile(inputPath, bad);
      expect(
        await normalizeGif({
          ...input,
          outputPath: outputPath + "invalid",
          dimensions: assertValidGif(bad),
        }),
      ).toBe("INVALID");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
