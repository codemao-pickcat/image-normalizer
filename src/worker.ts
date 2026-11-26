// 此子路径会加载 Sharp/native，只能在独立 worker 使用，不能由 HTTP 主进程导入。
export { normalizeWebp } from "./webp-normalizer-worker.js";
export { normalizeGif } from "./gif-normalizer-worker.js";
export { decodeGifFrames } from "./gif-frame-decoder.js";
export type {
  ImageNormalizerTask,
  ImageNormalizerCustomTask,
  ImageNormalizerRequest,
  ImageNormalizerResponse,
  ImageNormalizerResult,
} from "./image-normalizer-protocol.js";
