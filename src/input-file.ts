import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { MAX_PROCESSING_BYTES } from "./limits.js";
import { ImageNormalizationError } from "./errors.js";

/** 调用方应持有私有临时目录；拒绝特殊文件、符号链接、同路径覆盖及超限输入。 */
export async function validateInputFile(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  if (resolve(inputPath) === resolve(outputPath))
    throw new ImageNormalizationError(
      "INVALID_IMAGE",
      "Input and output must use different paths",
    );
  const info = await lstat(inputPath).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.size === 0)
    throw new ImageNormalizationError(
      "INVALID_IMAGE",
      "Input must be a non-empty regular file",
    );
  if (info.size > MAX_PROCESSING_BYTES)
    throw new ImageNormalizationError(
      "TOO_LARGE",
      "Input exceeds the processing budget",
    );
}
