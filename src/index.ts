// 主入口只导出父进程接口，不能加载 Sharp 或 native 编解码器。
export {
  ImageNormalizer,
  type ImageNormalizerOptions,
  type NormalizeImageInput,
  type NormalizedImage,
} from "./image-normalizer.js";
export {
  ImageNormalizationError,
  type ImageNormalizationErrorCode,
} from "./errors.js";
export {
  ImageNormalizerPool,
  type ImageNormalizerPoolOptions,
} from "./image-normalizer-process.js";
export {
  WebpNormalizer,
  type WebpNormalizerOptions,
  type WebpNormalizationInput,
  type NormalizedWebp,
} from "./webp-normalizer.js";
export {
  GifNormalizer,
  type GifNormalizerOptions,
  type GifNormalizationInput,
  type NormalizedGif,
} from "./gif-normalizer.js";
export {
  assertDecodableStaticWebp,
  assertDecodableStaticWebpFile,
  assertValidStaticWebp,
  assertValidStaticWebpFile,
  type StaticWebpDimensions,
  type WebpInvalidReason,
} from "./webp-validator.js";
export {
  assertValidGif,
  assertValidGifFile,
  type GifDimensions,
  type GifValidationOptions,
  GIF_MAX_FRAMES,
  GIF_MAX_PIXELS,
} from "./gif-validator.js";
export {
  DEFAULT_MAX_BYTES,
  MAX_PROCESSING_BYTES,
  MAX_DIMENSION,
  MAX_PIXELS,
  NORMALIZATION_VERSION,
} from "./limits.js";
