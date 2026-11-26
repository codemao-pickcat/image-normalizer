import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "sharp";

// 在仓库外安装实际 tarball，确保没有借用源码路径、开发依赖或本机 native 二进制。
const directory = await mkdtemp(join(tmpdir(), "image-normalizer-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  let tarball = process.argv[2] && resolve(process.argv[2]);
  if (!tarball) {
    const packed = JSON.parse(
      run(
        npm,
        ["pack", "--json", "--ignore-scripts", "--pack-destination", directory],
        process.cwd(),
      ),
    );
    assert.equal(packed.length, 1);
    const files = packed[0].files.map((file) => file.path);
    assert(files.includes("dist/image-normalizer-worker.js"));
    assert(files.includes("native/vendor/LICENSE"));
    assert(
      !files.some((file) =>
        /(?:^|\/)(?:\.env|node_modules|test|src|build)(?:\/|$)|\.node$/.test(
          file,
        ),
      ),
    );
    tarball = join(directory, packed[0].filename);
  }
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  run(
    npm,
    [
      "install",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org",
      tarball,
    ],
    directory,
  );
  await writeFile(
    join(directory, "input.webp"),
    await sharp({
      create: { width: 8, height: 4, channels: 4, background: "red" },
    })
      .webp()
      .toBuffer(),
  );
  // 两帧 GIF 证明发布包包含 native/Sharp 的完整运行依赖及动画 worker。
  await writeFile(
    join(directory, "input.gif"),
    await sharp(Buffer.alloc(8 * 8 * 2 * 4, 255), {
      raw: { width: 8, height: 16, channels: 4, pageHeight: 8 },
    })
      .gif({ keepDuplicateFrames: true, delay: [40, 90], loop: 0 })
      .toBuffer(),
  );
  await writeFile(
    join(directory, "smoke.mjs"),
    `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { ImageNormalizer, ImageNormalizationError } from "@codemao-pickcat/image-normalizer";
const require = createRequire(import.meta.url);
assert(!Object.keys(require.cache).some((path) => /sharp|gif-native/.test(path)));
const normalizer = new ImageNormalizer({ maxWorkers: 1 });
try {
  await normalizer.start();
  for (const format of ["webp", "gif"]) {
    const outputPath = "output." + format;
    const result = await normalizer.normalize({ inputPath: "input." + format, outputPath, format });
    const bytes = await readFile(outputPath);
    assert.equal(result.byteSize, bytes.length);
    assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(result.width, 8);
    if (format === "gif") { assert.equal(result.frames, 2); assert.deepEqual(result.delay, [40, 90]); }
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(normalizer.normalize({ inputPath: "input.webp", outputPath: "cancel.webp", format: "webp", signal: controller.signal }), (error) => error instanceof ImageNormalizationError && error.code === "UNAVAILABLE");
} finally { await normalizer.stop(); }
console.log("Installed package WebP/GIF smoke passed");
`,
  );
  process.stdout.write(run(process.execPath, ["smoke.mjs"], directory));
  const installed = JSON.parse(
    await readFile(
      join(
        directory,
        "node_modules/@codemao-pickcat/image-normalizer/package.json",
      ),
      "utf8",
    ),
  );
  assert.equal(installed.name, "@codemao-pickcat/image-normalizer");
} finally {
  await rm(directory, { recursive: true, force: true });
}
