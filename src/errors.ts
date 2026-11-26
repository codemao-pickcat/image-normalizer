/** 与 HTTP 和业务错误码无关的稳定错误类别，调用方自行映射响应。 */
export type ImageNormalizationErrorCode =
  "INVALID_IMAGE" | "TOO_LARGE" | "UNAVAILABLE";

/** 仅携带固定诊断信息，不暴露原始压缩内容、native 错误或服务端文件路径。 */
export class ImageNormalizationError extends Error {
  override readonly name = "ImageNormalizationError";

  constructor(
    readonly code: ImageNormalizationErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}
