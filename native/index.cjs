// 只允许媒体 worker 加载；Node-API 隔离于具体 V8 ABI。
const available = ["linux", "darwin"].includes(process.platform);
// Windows 本地开发继续原 Sharp 路径；支持的平台构建失败必须显式报错，不能静默降级。
const unavailable = () => {
  throw new Error("Native GIF codec is unavailable on this platform");
};
const codec = available
  ? require("./build/Release/gif-native.node")
  : {
      transcode: unavailable,
      validate: unavailable,
      validateFile: unavailable,
    };
// 显式列出属性，让原生 ESM 和打包后 worker 都能解析同一组命名导出。
exports.transcode = codec.transcode;
exports.validate = codec.validate;
exports.validateFile = codec.validateFile;
exports.available = available;
