/**
 * 内置的 mhyFetch 兼容实现。
 *
 * 上游 genshin 的 model/mys/mhyFetch.js 与本节目的相同：给米游社请求
 * 加一层「直连被风控才切代理」的兜底。本插件早已自建同一层
 * （system/mhy_fetch.js，含阻断页识别与代理配置），这里直接转出，
 * 避免跨插件依赖。
 */
export { mhyFetch, proxyBase, proxyEnabled, default } from '../../../../mhy_fetch.js'
