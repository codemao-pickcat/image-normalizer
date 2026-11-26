import type { GifNormalizationInput } from "./gif-normalizer.js";
import type { WebpNormalizationInput } from "./webp-normalizer.js";

/** 隔离进程只返回固定结果类别，禁止通过 IPC 泄露 native 错误或源文件内容。 */
export type ImageNormalizerResult = "OK" | "INVALID" | "TOO_LARGE";

/** 共享媒体进程按任务种类调度；载荷仅包含服务端路径及已验证预算。 */
export type ImageNormalizerTask =
  | {
      kind: "WEBP";
      payload: Omit<WebpNormalizationInput, "signal"> & { maxBytes: number };
    }
  | {
      kind: "GIF";
      payload: Omit<GifNormalizationInput, "signal"> & { maxBytes: number };
    };

/** 宿主受信任 worker 的扩展任务；载荷只在本机 IPC 传递，不向 HTTP 调用者开放。 */
export type ImageNormalizerCustomTask = { kind: string; payload: unknown };

/** 随机任务身份隔离复用进程中的迟到响应，不在进程间传递 AbortSignal。 */
export type ImageNormalizerRequest<
  Task extends ImageNormalizerCustomTask = ImageNormalizerTask,
> = {
  type: "task";
  id: string;
  task: Task;
};

/** result 之后必须再收到同任务的 ready，父进程才交付结果或复用进程。 */
export type ImageNormalizerResponse =
  | { type: "result"; id: string; result: ImageNormalizerResult }
  | { type: "ready"; id?: string; rss: number };
