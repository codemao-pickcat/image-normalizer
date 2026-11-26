/** 当前平台是否支持索引编解码；其他平台继续原 Sharp 路径。 */
export const available: boolean;
/** 严格 GIF 元数据；loop 为总播放次数（0 表示无限），delay 单位为毫秒。 */
export type GifMetadata = {
  width: number;
  height: number;
  frames: number;
  loop: number;
  delay: number[];
};
/** 同步、单线程逐帧重编码；返回 0 成功、1 非法/失败、3 输出超限，仅供隔离 worker 使用。 */
export function transcode(
  input: string,
  output: string,
  maxBytes: number,
): 0 | 1 | 3;
/** 完整容器校验，strict 时追加 LZW 字典及像素数量校验；失败抛出固定错误。 */
export function validate(bytes: Buffer, strict?: boolean): GifMetadata;
/** 有界读取普通文件并校验，不追随符号链接；maxBytes 不得超过 20,000,000。 */
export function validateFile(
  path: string,
  maxBytes: number,
  strict?: boolean,
): GifMetadata;
