// 构建产物自动部署：将 dist/ 下的构建产物复制到本地 Obsidian 测试库插件目录。
// 目标目录优先级：环境变量 OBSIDIAN_DEPLOY_DIR > .env 中的 OBSIDIAN_DEPLOY_DIR > 默认本地路径。
// 仅覆盖构建产物（main.js / manifest.json / styles.css），绝不触碰 data.json、state/、cache/ 等运行期数据。
// 目标目录不存在时输出提示并正常退出（CI / 其他机器上不影响构建结果）。
const fs = require("fs");
const path = require("path");
const {
  copyFileAtomicWithRetry,
  readEnvValueFromDotEnv,
} = require("./hot-reload-utils.cjs");

const DIST_DIR = path.resolve(__dirname, "..", "dist");
// 默认本地测试库（个人路径，仅本机有效；其他机器上该目录不存在会自动跳过）
const DEFAULT_DEPLOY_DIR = "E:/Obsidian/叫我包仔/.obsidian/plugins/weave-epub-reader";

// 仅部署构建产物；data.json / state / cache 等用户数据一律不动
const DEPLOY_ARTIFACTS = ["main.js", "manifest.json", "styles.css"];

function resolveDeployDir() {
  const fromEnv = process.env.OBSIDIAN_DEPLOY_DIR?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const fromDotEnv = readEnvValueFromDotEnv("OBSIDIAN_DEPLOY_DIR");
  if (fromDotEnv) {
    return fromDotEnv;
  }
  return DEFAULT_DEPLOY_DIR;
}

async function main() {
  if (!fs.existsSync(DIST_DIR)) {
    console.log("[deploy:obsidian] dist/ 不存在，跳过部署");
    return;
  }

  const deployDir = path.resolve(resolveDeployDir());
  if (!fs.existsSync(deployDir)) {
    console.log(`[deploy:obsidian] 目标目录不存在，跳过部署: ${deployDir}`);
    console.log(
      "[deploy:obsidian] 提示：可通过 OBSIDIAN_DEPLOY_DIR 环境变量或 .env 指定目标目录"
    );
    return;
  }

  const copied = [];
  for (const name of DEPLOY_ARTIFACTS) {
    const sourceFile = path.join(DIST_DIR, name);
    if (!fs.existsSync(sourceFile)) {
      continue;
    }
    const targetFile = path.join(deployDir, name);
    await copyFileAtomicWithRetry(sourceFile, targetFile);
    copied.push(name);
  }

  console.log(
    `[deploy:obsidian] 已部署 ${copied.length} 个文件 -> ${deployDir}: ${copied.join(", ")}`
  );
}

main().catch((error) => {
  console.error("[deploy:obsidian] 部署失败:", error);
  process.exitCode = 1;
});
