# Changelog

## 0.1.3

- 以 `@pickcat/image-normalizer` 发布到公开 npm registry，消费端安装无需 GitHub 令牌。
- 使用 GitHub 托管 runner 和 npm Trusted Publishing，保留真实安装校验及同一 tarball 的 Release 附件。
- 清洗算法、API、原生编译与进程预算保持不变。

## 0.1.2

- 为 Node.js 24+ CommonJS 工具提供默认导出条件，支持 Drizzle Kit 读取使用共享校验器的 schema。
- 安装产物测试同时验证 ESM import 和 CommonJS require，确保根入口仍不加载原生编码器。

## 0.1.1

- 暴露仅限隔离子进程使用的 worker 入口，宿主可复用 WebP/GIF 重编码及 GIF 帧解码。
- 显式自定义 worker 支持扩展任务，继续共用同一个受限进程池和完整取消/回收协议。
- 导出容器元数据处理及 GIF 属性比较，供消费端薄适配复用。

## 0.1.0

- 从 PICKCAT 抽取静态 WebP/GIF 清洗、严格容器校验与有界进程池。
- 内置 GIF 索引重编码器，保留小图 Sharp 路径及第三方许可证。
- 提供与 HTTP、OSS 和数据库无关的 Node.js API 和稳定错误类型。
- 使用 GitHub 托管 runner 测试并发布到 GitHub Packages。
