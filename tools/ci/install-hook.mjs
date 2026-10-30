/**
 * 安装 git 钩子：把仓库内 .githooks/pre-push 复制到 .git/hooks/。
 *
 * 钩子目录属于本地仓库，不会随 git 分发；换机器后执行一次 npm install
 * （prepare 生命周期）即可自动装回来，不需要手工拷贝。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const src = path.join(root, ".githooks", "pre-push")
const dest = path.join(root, ".git", "hooks", "pre-push")

if (process.env.CI) process.exit(0)
if (!fs.existsSync(src) || !fs.existsSync(path.join(root, ".git"))) process.exit(0)
try {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
  fs.chmodSync(dest, 0o755)
  console.log("[ci] 已安装 pre-push 钩子：推送前自动执行 npm run ci")
} catch (err) {
  console.warn("[ci] pre-push 钩子安装失败（不影响安装）：" + (err && err.message ? err.message : err))
}
