/* 插件自举热重载：改完文件自动生效，不用 `#重启`、也不用框架的 `#重载插件`
 * （实测框架那条命令不会重新 import ESM 入口，对 米哈游 完全无效）。
 *
 * 原理（三步）：
 *   1. fs.watch 递归监听 apps/ 与 system/，文件一改（防抖后）就重新 import 每个
 *      apps 模块，URL 带 ?t=时间戳 → 强制拿到新实例，不吃 ESM 缓存；
 *   2. 该 apps 模块内部 import 的 system/ 模块是**裸相对路径**，
 *      由 system/hot/hooks.mjs 按 mtime 追加版本号 —— 所以**改过的** system 模块
 *      会跟着重新求值，没改过的仍复用缓存（不重复求值、不重跑副作用）；
 *   3. 拿到新类后把原型方法与静态成员**就地拷到框架正在用的旧类上** ——
 *      框架持有的是启动时那个类对象，只能原地改，不能整体替换。
 *
 * ⚠ 边界（这些仍需 `#重启`）：
 *   · constructor 不可替换 → **新增 / 删除指令不生效**（指令表在 constructor 里
 *     交给 plugin 基类注册）；改指令的**处理方法**是生效的。
 *   · index.js 自身改动不生效（入口不会被重新加载）。
 *   · 新增 apps 文件：模块会被加载，但指令注册不进框架，仍需 `#重启`。
 *   · 被重新求值的模块会再跑一次顶层代码（已确认 system/ 顶层无定时器）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEBOUNCE_MS = 800
// 这些目录不监听：日志/数据/配置/依赖。尤其 temp/ —— 自己写日志会把自己触发成死循环
const SKIP_DIRS = new Set(['temp', 'data', 'node_modules', '.git', 'config', 'resources'])

/** 把新类的原型方法与静态成员拷到旧类上（框架持有的旧类引用不变，行为换成新的） */
function patchClass(oldC, NewC) {
    if (!oldC || !NewC || oldC === NewC) return false
    let n = 0
    const src = NewC.prototype
    const dst = oldC.prototype
    if (src && dst) {
        for (const k of Object.getOwnPropertyNames(src)) {
            // constructor 换不掉（class 的 [[Construct]] 内部槽），跳过
            if (k === 'constructor') continue
            try {
                Object.defineProperty(dst, k, Object.getOwnPropertyDescriptor(src, k))
                n++
            } catch (_) { /* 个别不可配置的成员跳过，不影响其它 */ }
        }
    }
    for (const k of Object.getOwnPropertyNames(NewC)) {
        if (k === 'length' || k === 'name' || k === 'prototype') continue
        try {
            Object.defineProperty(oldC, k, Object.getOwnPropertyDescriptor(NewC, k))
        } catch (_) { }
    }
    return n > 0
}

/**
 * @param {object} o
 * @param {Record<string, Function>} o.apps  index.js 的 apps 映射（相对 apps/ 的路径 → 类）
 * @param {string[]} o.files                apps 目录下的文件名列表
 * @param {string}   o.root                 插件根目录 URL（file:///…/plugins/HoYoGet-Plugin/）
 * @param {object}   o.logger               日志对象
 */
export function startAutoReload({ apps = {}, files = [], root = '', logger } = {}) {
    const log = logger || console
    if (!root) return false
    let rootPath
    try {
        rootPath = fileURLToPath(root)
    } catch (_) {
        return false
    }

    let timer = null
    let running = false

    const reload = async () => {
        if (running) return
        running = true
        let changed = 0
        try {
            for (const file of files) {
                // index.js 传进来的 file 是相对 apps/ 的 POSIX 路径（如 gs/foo.js），
                // apps 的 key 也必须是同一条路径，不能只取 basename。
                const rel = String(file).replace(/\\/g, '/')
                const name = rel.replace(/\.js$/, '')
                const oldC = apps[name]
                if (!oldC) continue
                try {
                    const url = new URL(`./apps/${rel}`, root).href + `?t=${Date.now()}`
                    const mod = await import(url)
                    /* 不能取「第一个导出」：app 文件现在会导出工具函数
                       （如 zzz_panel_list.js 导出 buildBasicProperties / calcDamage 给排名页复用），
                       按顺序取第一个会拿到函数而不是插件类，patchClass 拷了个寂寞，
                       还可能把函数属性写到旧类上。这里按「原型继承自全局 plugin」识别真正的插件类，
                       与 index.js 的注册逻辑保持同一判据。 */
                    const base = globalThis.plugin
                    const NewC = typeof base === 'function'
                        ? Object.values(mod || {}).find(v => typeof v === 'function' && v.prototype instanceof base)
                        : null
                    if (typeof NewC !== 'function') continue
                    if (patchClass(oldC, NewC)) changed++
                } catch (err) {
                    // 单个模块失败不影响其它，也不影响正在跑的旧代码
                    log.error?.(`[HoYoGet][热重载] ${file} 重载失败，保留旧代码：${err?.message || err}`)
                }
            }
            if (changed) log.mark?.(`[HoYoGet][热重载] 已热更新 ${changed} 个模块`)
        } finally {
            running = false
        }
    }

    const schedule = () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
            timer = null
            reload()
        }, DEBOUNCE_MS)
    }

    const watch = dir => {
        try {
            fs.watch(dir, { recursive: true }, (_ev, filename) => {
                // 只看 js/mjs；filename 在部分平台为空，那就一律触发（防抖会合并）
                if (!filename || /\.(js|mjs)$/.test(filename)) schedule()
            })
            return true
        } catch (_) {
            // 老平台不支持 recursive：退化为监听该层目录（子目录的改动靠父目录事件兜）
            try {
                fs.watch(dir, () => schedule())
                return true
            } catch (_) {
                return false
            }
        }
    }

    const ok1 = watch(path.join(rootPath, 'apps'))
    const ok2 = watch(path.join(rootPath, 'system'))
    if (!ok1 && !ok2) {
        log.warn?.('[HoYoGet][热重载] 目录监听失败，热重载未启用')
        return false
    }
    log.mark?.('[HoYoGet] 自举热重载已开启：改动 apps/ 与 system/ 后自动生效（新增指令仍需 #重启）')
    return true
}
