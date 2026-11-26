import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ImageNormalizationError } from "./errors.js";
import type {
  ImageNormalizerRequest,
  ImageNormalizerResult,
  ImageNormalizerTask,
} from "./image-normalizer-protocol.js";

/** 子进程池的服务端执行策略；不向 HTTP 调用方开放，测试可替换 worker。 */
export type ImageNormalizerPoolOptions = {
  maxWorkers?: number;
  maxTasksPerWorker?: number;
  maxWorkerRssBytes?: number;
  startupTimeoutMs?: number;
  workerUrl?: URL;
};

/** 单任务的取消与硬时限；启动和等待完成确认均计入该时限。 */
export type ImageNormalizerRunOptions = {
  signal: AbortSignal;
  timeoutMs: number;
};

type Job = {
  id: string;
  task: ImageNormalizerTask;
  signal: AbortSignal;
  abort: () => void;
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: ImageNormalizationError) => void;
  result?: ImageNormalizerResult;
  completed?: boolean;
};

type Worker = {
  child: ChildProcess;
  ready: boolean;
  initialized: boolean;
  retiring: boolean;
  jobs: number;
  job?: Job;
  failure?: ImageNormalizationError;
  startupTimer?: ReturnType<typeof setTimeout>;
  started: Promise<void>;
  resolveStarted: () => void;
  rejectStarted: (error: ImageNormalizationError) => void;
  closed: Promise<void>;
  resolveClosed: () => void;
};

/**
 * 有界共享媒体进程池：预热一个进程，按需扩容，无空闲名额时立即拒绝而非无界排队。
 * 每进程同一时刻只运行一个任务；异常、取消与超时等待进程关闭后才允许清理临时文件。
 */
export class ImageNormalizerPool {
  private readonly workers = new Set<Worker>();
  private readonly workerUrl: URL;
  private readonly maxWorkers: number;
  private readonly maxTasks: number;
  private readonly maxRss: number;
  private readonly startupTimeout: number;
  private stopping?: Promise<void>;
  private stopped = false;

  constructor(options: ImageNormalizerPoolOptions = {}) {
    this.maxWorkers = options.maxWorkers ?? 1;
    this.maxTasks = options.maxTasksPerWorker ?? 100;
    this.maxRss = options.maxWorkerRssBytes ?? 256 * 1024 * 1024;
    this.startupTimeout = options.startupTimeoutMs ?? 30_000;
    for (const value of [
      this.maxWorkers,
      this.maxTasks,
      this.maxRss,
      this.startupTimeout,
    ])
      if (!Number.isSafeInteger(value) || value < 1)
        throw new RangeError("Invalid image worker pool budget");
    if (this.maxWorkers > 64) throw new RangeError("Too many image workers");
    this.workerUrl =
      options.workerUrl ??
      new URL(
        import.meta.url.endsWith(".ts")
          ? "../dist/image-normalizer-worker.js"
          : "./image-normalizer-worker.js",
        import.meta.url,
      );
  }

  /** 预热一个已加载 native 模块的进程；重复调用共享同一个启动握手。 */
  async start(): Promise<void> {
    if (this.stopped) throw processingUnavailable();
    const worker = [...this.workers].find((item) => !item.retiring);
    if (worker) return worker.started;
    if (this.workers.size >= this.maxWorkers) throw processingUnavailable();
    return this.spawn().started;
  }

  /** 分配独占进程并等待 result 与 ready；满载不排队，任务失败不自动重放。 */
  run(
    task: ImageNormalizerTask,
    options: ImageNormalizerRunOptions,
  ): Promise<void> {
    if (this.stopped || options.signal.aborted)
      return Promise.reject(processingUnavailable());
    let worker = [...this.workers].find((item) => !item.retiring && !item.job);
    if (!worker) {
      if (this.workers.size >= this.maxWorkers)
        return Promise.reject(processingUnavailable());
      try {
        worker = this.spawn();
      } catch {
        return Promise.reject(processingUnavailable());
      }
    }
    const slot = worker;
    return new Promise((resolve, reject) => {
      const abort = () => this.retire(slot, processingUnavailable());
      const timer = setTimeout(abort, options.timeoutMs);
      timer.unref();
      slot.job = {
        id: randomUUID(),
        task,
        signal: options.signal,
        abort,
        timer,
        resolve,
        reject,
      };
      this.reference(slot);
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) abort();
      else if (slot.ready) this.dispatch(slot);
    });
  }

  /** 停服先禁止分配，再杀死并等待全部忙碌、空闲或仍在启动的进程。 */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.stopping = Promise.all(
      [...this.workers].map((worker) => {
        this.retire(worker, processingUnavailable());
        return worker.closed;
      }),
    ).then(() => undefined);
    return this.stopping;
  }

  /** 环境只传白名单；替换进程在旧进程 close 后创建，不能短暂突破并发预算。 */
  private spawn(): Worker {
    const child = fork(fileURLToPath(this.workerUrl), [], {
      execArgv: ["--max-old-space-size=128"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        UV_THREADPOOL_SIZE: "1",
        VIPS_CONCURRENCY: "1",
      },
    });
    let resolveStarted!: () => void;
    let rejectStarted!: (error: ImageNormalizationError) => void;
    let resolveClosed!: () => void;
    const started = new Promise<void>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    // 按需分配不一定显式 await start，启动失败仍由当前任务接收，避免未处理的拒绝。
    void started.catch(() => undefined);
    const worker: Worker = {
      child,
      started,
      resolveStarted,
      rejectStarted,
      closed: new Promise<void>((resolve) => {
        resolveClosed = resolve;
      }),
      resolveClosed: () => resolveClosed(),
      ready: false,
      initialized: false,
      retiring: false,
      jobs: 0,
    };
    this.workers.add(worker);
    worker.startupTimer = setTimeout(
      () => this.retire(worker, processingUnavailable()),
      this.startupTimeout,
    );
    worker.startupTimer.unref();
    child.on("message", (message: unknown) => this.receive(worker, message));
    child.once("error", () => this.retire(worker, processingUnavailable()));
    child.once("disconnect", () => {
      if (!worker.retiring)
        this.retire(
          worker,
          worker.initialized ? invalidImage() : processingUnavailable(),
        );
    });
    child.once("close", () => this.closed(worker));
    return worker;
  }

  /** 随机身份和两阶段完成握手防止迟到、重复回执结束另一项任务。 */
  private receive(worker: Worker, message: unknown): void {
    if (worker.retiring) return;
    if (!message || typeof message !== "object") {
      this.retire(worker, invalidImage());
      return;
    }
    const type = Reflect.get(message, "type"),
      id = Reflect.get(message, "id");
    const job = worker.job;
    if (type === "result") {
      const result: unknown = Reflect.get(message, "result");
      if (
        !worker.initialized ||
        !job ||
        id !== job.id ||
        job.result ||
        (result !== "OK" && result !== "INVALID" && result !== "TOO_LARGE")
      ) {
        this.retire(worker, invalidImage());
        return;
      }
      job.result = result;
      // 解码失败的进程不复用，等待退出后才返回业务错误，避免 native 工作继续写入。
      if (result !== "OK")
        this.retire(
          worker,
          result === "TOO_LARGE" ? imageTooLarge() : invalidImage(),
        );
      return;
    }
    const rss: unknown = Reflect.get(message, "rss");
    if (
      type !== "ready" ||
      typeof rss !== "number" ||
      !Number.isSafeInteger(rss) ||
      rss <= 0
    ) {
      this.retire(worker, invalidImage());
      return;
    }
    if (!worker.initialized) {
      if (id !== undefined) {
        this.retire(worker, invalidImage());
        return;
      }
      clearTimeout(worker.startupTimer);
      worker.initialized = true;
      worker.ready = true;
      worker.resolveStarted();
      if (job) this.dispatch(worker);
      else this.unreference(worker);
      return;
    }
    if (!job || id !== job.id || job.result !== "OK") {
      this.retire(worker, invalidImage());
      return;
    }
    job.completed = true;
    worker.jobs++;
    if (worker.jobs >= this.maxTasks || rss >= this.maxRss) {
      this.retire(worker);
      return;
    }
    this.cleanupJob(job);
    worker.job = undefined;
    worker.ready = true;
    this.unreference(worker);
    job.resolve();
  }

  private dispatch(worker: Worker): void {
    const job = worker.job;
    if (!job || worker.retiring) return;
    worker.ready = false;
    const message: ImageNormalizerRequest = {
      type: "task",
      id: job.id,
      task: job.task,
    };
    worker.child.send(message, (error) => {
      if (error && worker.job === job)
        this.retire(worker, processingUnavailable());
    });
  }

  /** 即使 IPC 曾报告成功，未确认 ready 的任务也必须随进程退出后才结束。 */
  private retire(worker: Worker, failure?: ImageNormalizationError): void {
    worker.failure ??= failure;
    if (worker.retiring) return;
    worker.retiring = true;
    clearTimeout(worker.startupTimer);
    this.reference(worker);
    worker.child.kill("SIGKILL");
  }

  private closed(worker: Worker): void {
    this.workers.delete(worker);
    clearTimeout(worker.startupTimer);
    if (!worker.initialized)
      worker.rejectStarted(worker.failure ?? processingUnavailable());
    const job = worker.job;
    if (job) {
      this.cleanupJob(job);
      if (worker.failure) job.reject(worker.failure);
      else if (job.result === "OK" && job.completed) job.resolve();
      else job.reject(invalidImage());
    }
    worker.resolveClosed();
    // 只有已成功启动的进程才自动补位，启动即崩溃时不无限 fork 重试。
    if (!this.stopped && worker.initialized) {
      try {
        this.spawn();
      } catch {
        /* 下一次请求仍可按需恢复。 */
      }
    }
  }

  private cleanupJob(job: Job): void {
    clearTimeout(job.timer);
    job.signal.removeEventListener("abort", job.abort);
  }

  private reference(worker: Worker): void {
    worker.child.ref();
    worker.child.channel?.ref();
  }

  /** 空闲池不阻止父进程自然退出；父进程断连时 worker 自行退出。 */
  private unreference(worker: Worker): void {
    worker.child.unref();
    worker.child.channel?.unref();
  }
}

/** 对外错误不包含 native 解码器信息、临时路径或用户载荷。 */
export function invalidImage(): ImageNormalizationError {
  return new ImageNormalizationError(
    "INVALID_IMAGE",
    "The uploaded image cannot be safely normalized",
    { reason: "MALFORMED" },
  );
}

/** 重编码后的实际输出同样受字节上限约束。 */
export function imageTooLarge(): ImageNormalizationError {
  return new ImageNormalizationError(
    "TOO_LARGE",
    "The normalized image exceeds the file size limit",
  );
}

/** 启动、超时或取消均失败关闭，不回退为原始上传字节。 */
export function processingUnavailable(): ImageNormalizationError {
  return new ImageNormalizationError(
    "UNAVAILABLE",
    "Image processing is temporarily unavailable",
    { retryAfterSeconds: 5 },
  );
}
