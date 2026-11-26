# Changelog

## 0.1.1

- 暴露仅限隔离子进程使用的 worker 入口，宿主可复用 WebP/GIF 重编码及 GIF 帧解码。
- 显式自定义 worker 支持扩展任务，继续共用同一个受限进程池和完整取消/回收协议。
- 导出容器元数据处理及 GIF 属性比较，供消费端薄适配复用。

## 0.1.0

- 从 PICKCAT 抽取静态 WebP/GIF 清洗、严格容器校验与有界进程池。
- 内置 GIF 索引重编码器，保留小图 Sharp 路径及第三方许可证。
- 提供与 HTTP、OSS 和数据库无关的 Node.js API 和稳定错误类型。
- 使用 GitHub 托管 runner 测试并发布到 GitHub Packages。
