import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// 官方 Node 镜像和 Homebrew 均提供本地头文件；构建不下载未锁定依赖。
const root = import.meta.dirname;
if (!["linux", "darwin"].includes(process.platform)) {
  console.log("GIF: this platform retains the Sharp normalization path");
  process.exit(0);
}
const candidates = [
  process.env.NODE_INCLUDE_DIR,
  resolve(dirname(realpathSync(process.execPath)), "../include/node"),
  "/usr/local/include/node",
  "/usr/include/node",
].filter(Boolean);
const headers = candidates.find((path) =>
  existsSync(resolve(path, "node_api.h")),
);
if (!headers) {
  throw new Error(
    "GIF native build requires Linux/macOS, a C compiler and Node headers (NODE_INCLUDE_DIR)",
  );
}
mkdirSync(resolve(root, "build/Release"), { recursive: true });
const compiler = process.env.CC || "cc";
const result = spawnSync(
  compiler,
  [
    "-std=c11",
    "-D_GNU_SOURCE",
    "-O3",
    "-fPIC",
    "-fvisibility=hidden",
    "-Wall",
    "-Wextra",
    "-I",
    headers,
    ...(process.platform === "darwin"
      ? ["-bundle", "-undefined", "dynamic_lookup"]
      : ["-shared"]),
    resolve(root, "gif-native.c"),
    resolve(root, "vendor/cgif_raw.c"),
    "-o",
    resolve(root, "build/Release/gif-native.node"),
  ],
  { stdio: "inherit" },
);
// 缺少编译器时 spawn 不会产生 stderr，必须保留启动错误，避免 CI 只显示笼统失败。
if (result.error) {
  throw new Error(
    `Cannot start C compiler "${compiler}"; install a C11 toolchain (build-essential on Debian/Ubuntu) or set CC`,
    { cause: result.error },
  );
}
if (result.status !== 0) {
  throw new Error(
    `GIF native compilation failed (exit=${result.status}, signal=${result.signal})`,
  );
}
