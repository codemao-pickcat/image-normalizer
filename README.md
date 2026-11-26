# Image Normalizer

在受限 Node.js 子进程中清洗静态 WebP 与 GIF。由 PICKCAT 的现有图片处理核心抽取，供 PICKCAT、MOSS 及其他服务共享。

输入完整解码后重新编码，输出重新检查容器、尺寸和实际 SHA-256。静态 WebP 使用无损重编码；GIF 保留帧数、延迟、循环和画布，较大 GIF 使用严格索引重编码。任何失败均拒绝，不交付原始字节。

## 安装

要求 Node.js 24 或更高版本。包发布到 **GitHub Packages npm registry**：

```ini
# 项目 .npmrc；令牌通过用户配置或 CI secret 注入，不写入仓库。
@codemao-pickcat:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

```sh
npm install --save-exact @codemao-pickcat/image-normalizer@0.1.2
```

GitHub Packages 的 npm 安装需要认证。GitHub Actions 使用获得包读取权限的 `GITHUB_TOKEN`；其他环境使用有 `read:packages` 权限的令牌。参见 [GitHub npm registry 文档](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)。

Linux/macOS 安装时编译内置 Node-API GIF 扩展，需要 C11 编译器与当前 Node.js 头文件。Debian/Ubuntu 构建镜像安装 `build-essential`；找不到头文件时设置 `NODE_INCLUDE_DIR`。运行镜像只需复制安装完成的依赖，无需编译器。Windows 使用 Sharp GIF 路径。支持平台上 native 编译或加载失败会直接失败，不静默降级。

## 使用

```ts
import {
  ImageNormalizer,
  ImageNormalizationError,
} from "@codemao-pickcat/image-normalizer";

const normalizer = new ImageNormalizer({ maxWorkers: 2, timeoutMs: 30_000 });
await normalizer.start();

try {
  const result = await normalizer.normalize({
    inputPath: "/service-private-temp/source.webp",
    outputPath: "/service-private-temp/clean.webp",
    format: "webp",
    maxBytes: 10 * 1024 * 1024,
    signal: requestAbortSignal,
  });
  // 仅将 result.outputPath 指向的新文件交给存储和内容审核。
  // result 包含 mediaType、width、height、byteSize、sha256。
} catch (error) {
  if (error instanceof ImageNormalizationError) {
    // INVALID_IMAGE / TOO_LARGE / UNAVAILABLE，由宿主映射业务响应。
  }
  throw error;
}

// 服务停机时执行；不要在每次请求后停止共享实例。
await normalizer.stop();
```

`format: "gif"` 返回 GIF，另含 `frames`、`delay`（毫秒）及 `loop`（总播放次数，0 为无限）。`start()` 是可选预热，`normalize()` 也可按需启动 worker。

路径只能由服务端生成，输入和输出置于调用方独占的临时目录；调用方负责接收文件、控制并发上传及清理临时文件。输出路径必须不存在。失败时可能有部分输出，调用方必须丢弃；Promise 完成后该任务已停止写入，才可清理。不要将 HTTP 输入直接当文件路径。

高级接口包括 `WebpNormalizer`、`GifNormalizer`、`ImageNormalizerPool` 和容器校验函数。校验器检查结构，不能代替清洗；高级 normalizer 的 `dimensions` 必须来自对同一不可变输入的校验。

宿主需要让其他媒体任务共享同一进程预算时，可显式设置 `ImageNormalizerPool({ workerUrl })`，再通过 `runCustom({ kind, payload }, { signal, timeoutMs })` 分配扩展任务。默认 worker 不接受扩展任务。扩展任务继续受同一并发、硬时限、任务身份、`result → ready` 握手和进程回收约束；宿主 worker 必须实现公开的 `ImageNormalizerRequest<Task>` / `ImageNormalizerResponse` 协议。

`@codemao-pickcat/image-normalizer/worker` 导出 `normalizeWebp`、`normalizeGif` 和 `decodeGifFrames`，供宿主的隔离 worker 复用。此入口会加载 Sharp/native，**不能在 HTTP 主进程导入**。worker 路径和扩展载荷必须由受信任的宿主代码构造，不接受网络调用方指定的脚本或命令。开发环境需要 TS loader 时由宿主 JS bootstrap 显式注册，清洗器仍使用固定 heap 参数及环境白名单。

## 边界与预算

| 项目         | 约束                                               |
| ------------ | -------------------------------------------------- |
| 输入格式     | 静态 WebP、GIF；PNG/JPEG 等先由宿主交给 OSS 转格式 |
| 输入技术上限 | 20,000,000 字节                                    |
| 输出上限     | 默认 10 MiB，`maxBytes` 最多 20,000,000 字节       |
| 画布         | 每边最多 4096；静态图最多 4096² 像素               |
| GIF          | 最多 100 帧，累计画布像素最多 32,000,000           |
| 任务时限     | 默认 30 秒，包含启动、处理和空闲确认               |
| 并发         | 默认 1 个进程，最多 64；满载立即失败，无无界队列   |
| 进程回收     | 默认成功处理 100 项或任务后 RSS 达到 256 MiB       |

worker 不继承数据库/OSS 凭据或 `NODE_OPTIONS`，Sharp cache 关闭，native 并发为 1。主入口不加载 Sharp/native。进程隔离不是操作系统权限沙箱；V8 heap 与任务后 RSS 回收不是 native 内存硬上限，部署仍应设置容器内存限制。

清洗移除源元数据、无关扩展及未重新编码的源压缩载荷，不消除像素级隐写。OSS、裁剪、内容审核、授权、上传额度及数据库均由宿主处理。本包没有图片跨格式转换、网络服务或上传接口。

MOSS 接入建议：OSS 裁剪并将静态图转 WebP（GIF 保持 GIF）→ 本包清洗 → 保存独立不可变封面 → 审核与展示读取同一对象。源文件哈希、裁剪规则和 `NORMALIZATION_VERSION` 可共同标识派生对象，原作品资源保持不变。

## 开发与发版

```sh
npm ci
npm run check
```

测试覆盖真实子进程复用与回收、取消/超时、畸形压缩流、元数据和尾载荷、GIF 时间轴/像素、native 与 JS 差分及安装包独立运行。`test:package` 在仓库外仅安装生产依赖并运行 WebP/GIF 清洗。

所有 CI、构建和发布均使用 GitHub 托管 runner，未配置 self-hosted runner。更新版本与变更日志、推送 `vX.Y.Z` 标签后，发布工作流先执行完整校验，再构建并验证 `.tgz`，将同一产物发布到 GitHub Packages 并附到 GitHub Release。发布使用该仓库的 `GITHUB_TOKEN`，不需要长期发布令牌。

## 许可证

MIT。内置 cgif v0.5.3 及其许可证保留在 `native/vendor/`；来源与补丁说明见 `NOTICE`。
