/**
 * 内置版（原 wiki 插件 components）。只保留 models 用得到的三项：
 * wikiPath（资源路径）、Config / Version（配置与版本占位）。
 */
import wikiPath from "./wikiPath.js"
import Config from "./Config.js"
import Version from "./Version.js"

/* 原实现读 miao-plugin/package.json 判断 isFork，miao 卸载后会直接崩；
   这里恒为 true —— 内置副本本来就不依赖外部插件 */
const isFork = true

export { wikiPath, Config, Version, isFork }
