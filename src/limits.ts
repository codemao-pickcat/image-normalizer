/** 未指定输出预算时使用的字节上限。 */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
/** 输入与输出的技术上限，与 native GIF 校验器保持一致。 */
export const MAX_PROCESSING_BYTES = 20_000_000;
/** 静态图与 GIF 画布的最大单边尺寸。 */
export const MAX_DIMENSION = 4096;
/** 静态 WebP 的最大解码像素数量。 */
export const MAX_PIXELS = MAX_DIMENSION * MAX_DIMENSION;
/** 清洗规则版本，供调用方纳入派生对象身份；不能替代 npm 包版本。 */
export const NORMALIZATION_VERSION = 1;
