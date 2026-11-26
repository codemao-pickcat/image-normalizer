import sharp from "sharp";
import { normalizeWebp } from "./webp-normalizer-worker.js";
import { normalizeGif } from "./gif-normalizer-worker.js";
import type {
  ImageNormalizerRequest,
  ImageNormalizerResponse,
} from "./image-normalizer-protocol.js";

// 进程复用不复用图片缓存，所有格式共用单线程 native 预算。
sharp.cache(false);
sharp.concurrency(1);
let busy = false;

/** IPC 失败后不再接单，避免父进程无法确认仍在运行的 native 任务。 */
function send(message: ImageNormalizerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) {
      reject(new Error("Missing image worker IPC"));
      return;
    }
    process.send(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** 所有输出流和校验完成后才报告结果，下一事件循环再确认可复用。 */
async function execute(message: ImageNormalizerRequest): Promise<void> {
  if (busy || message.type !== "task" || typeof message.id !== "string")
    process.exit(1);
  busy = true;
  const task = message.task;
  const result =
    task.kind === "WEBP"
      ? await normalizeWebp(task.payload)
      : task.kind === "GIF"
        ? await normalizeGif(task.payload)
        : "INVALID";
  await send({ type: "result", id: message.id, result });
  await new Promise<void>((resolve) => setImmediate(resolve));
  busy = false;
  await send({ type: "ready", id: message.id, rss: process.memoryUsage.rss() });
}

process.on("message", (message: ImageNormalizerRequest) => {
  void execute(message).catch(() => process.exit(1));
});
process.once("disconnect", () => process.exit(0));
void send({ type: "ready", rss: process.memoryUsage.rss() }).catch(() =>
  process.exit(1),
);
