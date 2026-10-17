/**
 * 功能模块注册表 —— 模块开关的单一事实来源
 *
 * 参考 xhh-TL 的实现（https://github.com/cchanlan/xhh-TL）改写，适配 xhh 的配置体系：
 * 配置读取走 system/yaml.js 读 config/config.yaml，而不是 xhh-TL 的 pluginConfig。
 *
 * 为什么要有这个文件：
 *   · 过去各模块的开关要么没有、要么散落在各文件里，关掉一个功能只能注释代码；
 *   · 帮助图又是另一份手写清单，跟实际开关对不上（关了但帮助里还在）。
 * 这里把「模块 → 配置键」绑在一处，任何一侧增删都只改这一张表。
 *
 * ⚠️ 新增模块时三件事一起做，缺一个就会出现「关了没用」：
 *   1. MODULES 里加一项
 *   2. config/config.yaml 加同名键（默认 true）
 *   3. guoba.support.js 加 Switch（label 与这里保持一致）
 *   4. 对应 app 文件末尾调 guardModule(Class, '模块id', ['方法名'])
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from './yaml.js'

const CFG_PATH = './plugins/HoYoGet-Plugin/config/config.yaml'
const DEF_CFG_PATH = './plugins/HoYoGet-Plugin/system/default/default_config/config.yaml'

// 本文件位于 <插件根>/system/，上溯一级即插件根（与 apps/ 下各文件的取法一致）
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function readCfg() {
  try {
    return yaml.get(CFG_PATH) || {}
  } catch (_) {
    return {}
  }
}

/**
 * 用户配置里没有的键，回落到默认配置。
 *
 * config/ 是用户目录（.gitignore 忽略，不入库），system/default/default_config/
 * 才是随仓库走的默认配置。新增模块开关时两处都要写：默认配置决定新装用户的
 * 初值，用户配置决定实际生效值。
 */
function readDefaultCfg() {
  try {
    return yaml.get(DEF_CFG_PATH) || {}
  } catch (_) {
    return {}
  }
}

/**
 * 模块清单。
 * key   = 写进 config.yaml 的配置键（必须与 config.yaml 同名）
 * label = 锅巴与日志里显示的名字
 */
export const MODULES = {
  tl: { key: 'Tl', label: '体力查询' },
  tlp: { key: 'tlp', label: '塔罗牌' },
  wiki: { key: 'wiki', label: '图鉴' },
  gs_logs: { key: 'gs_logs', label: '原神历史卡池' },
  sr_logs: { key: 'sr_logs', label: '星铁历史卡池' },
  zzz_logs: { key: 'zzz_logs', label: '绝区零历史卡池' },
  gs_gacha: { key: 'gs_gacha_enable', label: '原神抽卡记录' },
  sr_gacha: { key: 'sr_gacha_enable', label: '星铁抽卡记录' },
  zzz_gacha: { key: 'zzz_gacha_enable', label: '绝区零抽卡记录' },
  bh3_gacha: { key: 'bh3_gacha_enable', label: '崩坏三抽卡记录' },
  sign: { key: 'sign', label: '米游社签到' },
  bili: { key: 'bilibili', label: '哔哩哔哩' },
  bili_live: { key: 'bili_live', label: '哔哩哔哩直播' },
  gs_voice: { key: 'gs_voice', label: '原神语音' },
  sr_voice: { key: 'sr_voice', label: '星铁语音' },
  zzz_voice: { key: 'zzz_voice', label: '绝区零语音' },
  bh3_voice: { key: 'bh3_voice', label: '崩坏三语音' },
  meme: { key: 'meme_enable', label: '表情包' },
  gacha_pool: { key: 'gacha_pool_enable', label: '卡池日程维护' },
  module_switch: { key: 'module_switch_enable', label: '模块开关指令' },
}

/**
 * 某模块是否启用。
 *
 * 语义刻意做成「只有明确写 false 才算关」：
 *   · 键缺失 / null / undefined → 视为开。老用户升级后 config.yaml 里还没有新键，
 *     不能因为「没配过」就把功能停掉。
 *   · 兼容字符串：锅巴的输入框清空后可能提交 '' / 'false' / 'off'。
 *
 * @param {string} id MODULES 的键
 * @returns {boolean}
 */
export function isModuleEnabled(id) {
  const mod = MODULES[id]
  if (!mod) return true
  const value = readCfg()[mod.key] ?? readDefaultCfg()[mod.key]
  if (value === undefined || value === null) return true
  if (value === false || value === 0) return false
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase()
    if (s === 'false' || s === '0' || s === 'off' || s === 'no') return false
  }
  return true
}

/** 取某模块的配置键（日志用） */
export function moduleKey(id) {
  return MODULES[id]?.key || ''
}

/**
 * 给插件类的方法挂「模块开关守卫」。
 *
 * 为什么在原型上包一层，而不是在每个 fnc 里手写 if：
 * 一个模块动辄十几条 rule，逐条手写既啰嗦又必然漏。包装在原型上，
 * 构造函数注册的 rule 拿到的就是包装后的函数，一处生效、无遗漏。
 *
 * 返回值语义（TRSS loader）：
 *   false → 本插件不处理，消息继续交给别的插件
 *   true  → 消息已被消费，会终结分发链（这里不用）
 * 所以模块关闭时统一返回 false：**静默不响应**，把消息放给别的插件。
 *
 * @param {Function} cls 插件类
 * @param {string} id 模块 id
 * @param {string|string[]} fncNames 需要守卫的方法名
 */
export function guardModule(cls, id, fncNames) {
  const names = Array.isArray(fncNames) ? fncNames : [fncNames]
  const label = MODULES[id]?.label || id
  for (const name of names) {
    const original = cls.prototype?.[name]
    if (typeof original !== 'function') {
      logger?.warn?.(`[HoYoGet][modules] ${cls.name}.${name}() 不存在，「${label}」的开关守卫没挂上`)
      continue
    }
    // 同一个方法可能被多个模块守卫，重复包装只留最外层
    if (original.__xhhModuleGuarded) continue
    const wrapped = async function (...args) {
      if (!isModuleEnabled(id)) {
        logger?.debug?.(`[HoYoGet][modules]「${label}」已关闭，${cls.name}.${name}() 静默不响应`)
        return false
      }
      return original.apply(this, args)
    }
    wrapped.__xhhModuleGuarded = true
    wrapped.__xhhOriginal = original
    cls.prototype[name] = wrapped
  }
}

/** 已关闭的模块清单（帮助/指令里提示用） */
export function disabledModuleLabels() {
  return Object.keys(MODULES)
    .filter((id) => !isModuleEnabled(id))
    .map((id) => MODULES[id].label)
}

/**
 * 按 app 文件里的 rule 自动挂守卫。
 *
 * 一个模块动辄十几条 rule、对应十几个 fnc 方法，手写方法名列表必然漏（漏一个就是
 * 「关了还能用」）。这里在模块加载时读一次自己的源码，把 `fnc: 'xxx'` 里出现过的
 * 方法名全部收集起来再统一包装，新增 rule 不用同步维护列表。
 *
 * @param {Function} cls 插件类
 * @param {string} id 模块 id
 * @param {string} file apps/ 下的文件名，如 'sr_gacha.js'
 */
export function guardModuleByFile(cls, id, file) {
  let names = []
  try {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'apps', file), 'utf8')
    names = [...src.matchAll(/fnc:\s*['"]([A-Za-z_$][\w$]*)['"]/g)].map(m => m[1])
    // 去重
    names = [...new Set(names)]
  } catch (err) {
    logger?.warn?.(`[HoYoGet][modules] 读取 ${file} 失败，「${MODULES[id]?.label || id}」的守卫改用显式列表`)
    return guardModule(cls, id, [])
  }
  if (!names.length) {
    logger?.warn?.(`[HoYoGet][modules] ${file} 里没解析到 fnc，「${MODULES[id]?.label || id}」的守卫没挂上`)
    return
  }
  guardModule(cls, id, names)
}
