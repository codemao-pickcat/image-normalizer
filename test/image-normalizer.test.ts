import {
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  ImageNormalizer,
  ImageNormalizationError,
  MAX_PROCESSING_BYTES,
} from "../src/index.js";
import { encodedWebp } from "./support/webp.js";

const contexts: { directory: string; normalizer: ImageNormalizer }[] = [];
afterEach(async () => {
  for (const { directory, normalizer } of contexts.splice(0)) {
    await normalizer.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

/** 每项测试使用独占目录，检查失败后源文件和已有目标仍完整。 */
async function context() {
  const directory = await mkdtemp(join(tmpdir(), "image-api-"));
  const normalizer = new ImageNormalizer();
  contexts.push({ directory, normalizer });
  const inputPath = join(directory, "input.webp");
  const outputPath = join(directory, "output.webp");
  const bytes = await encodedWebp(8, 8);
  await writeFile(inputPath, bytes);
  return { directory, normalizer, inputPath, outputPath, bytes };
}

it("高级入口使用固定错误类型拒绝源文件覆盖，并保留原始内容", async () => {
  const { normalizer, inputPath, bytes } = await context();
  await expect(
    normalizer.normalize({ inputPath, outputPath: inputPath, format: "webp" }),
  ).rejects.toBeInstanceOf(ImageNormalizationError);
  expect(await readFile(inputPath)).toEqual(bytes);
});

it("输出路径已存在时失败，不覆盖调用方文件", async () => {
  const { normalizer, inputPath, outputPath } = await context();
  await writeFile(outputPath, "retain this file");
  await expect(
    normalizer.normalize({ inputPath, outputPath, format: "webp" }),
  ).rejects.toMatchObject({ code: "INVALID_IMAGE" });
  expect(await readFile(outputPath, "utf8")).toBe("retain this file");
});

it("超限输入在解码前拒绝，静态图也受输入技术预算限制", async () => {
  const { normalizer, inputPath, outputPath } = await context();
  await truncate(inputPath, MAX_PROCESSING_BYTES + 1);
  await expect(
    normalizer.normalize({ inputPath, outputPath, format: "webp" }),
  ).rejects.toMatchObject({ code: "TOO_LARGE" });
  await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("拒绝符号链接输入", async () => {
  const { normalizer, directory, inputPath, outputPath } = await context();
  const linked = join(directory, "link.webp");
  await symlink(inputPath, linked);
  await expect(
    normalizer.normalize({ inputPath: linked, outputPath, format: "webp" }),
  ).rejects.toMatchObject({ code: "INVALID_IMAGE" });
});

it("停止后不接受新任务，不产生输出", async () => {
  const { normalizer, inputPath, outputPath } = await context();
  await normalizer.start();
  await normalizer.stop();
  await expect(
    normalizer.normalize({ inputPath, outputPath, format: "webp" }),
  ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
});
