import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pluginPriority, yaml } from '#HoYoGet'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ALIAS_FILE = path.join(PLUGIN_ROOT, 'system', 'default', 'zzz_js_names.yaml')
const PREFIX = '^(?:米游社|%|#?绝区零)?'

const norm = v => String(v || '').replace(/[\s·・\-—_「」『』《》【】\[\]（）()]/g, '').toLowerCase()

/** 绝区零角色别名维护：添加/删除/查看，直接写本地 zzz_js_names.yaml */
export class ZzzAlias extends plugin {
  constructor(e) {
    super({
      name: '[米哈游]绝区零别名',
      dsc: '绝区零角色别名维护',
      event: 'message',
      priority: pluginPriority('zzz_alias', -100),
      rule: [
        { reg: `${PREFIX}添加(\\S+?)别名(\\S+)$`, fnc: 'addAlias' },
        { reg: `${PREFIX}删除别名(\\S+)$`, fnc: 'deleteAlias' },
        { reg: `${PREFIX}(\\S+?)别名$`, fnc: 'listAlias' },
      ],
    })
  }

  loadAliases() {
    try { return yaml.get(ALIAS_FILE) || {} } catch { return {} }
  }

  resolveFormal(raw = '', data = null) {
    const key = norm(raw)
    if (!key) return ''
    const names = data || this.loadAliases()
    for (const [formal, aliases] of Object.entries(names)) {
      if (norm(formal) === key) return formal
      if (Array.isArray(aliases) && aliases.some(a => norm(a) === key)) return formal
    }
    return ''
  }

  async clearCache() {
    try {
      const { clearZzzAliasCache } = await import('../common/wiki.js')
      clearZzzAliasCache?.()
    } catch { /* 缓存清理失败最多下次重启生效 */ }
  }

  async addAlias(e) {
    if (!e.isMaster) return e.reply('仅限主人设置别名')
    const m = String(e.msg || '').match(new RegExp(`${PREFIX}添加(\\S+?)别名(\\S+)$`))
    if (!m) return false
    const [, key, value] = m
    const data = this.loadAliases()
    const formal = this.resolveFormal(key, data)
    if (!formal) return e.reply(`未找到「${key}」对应的角色`)
    const exists = this.resolveFormal(value, data)
    if (exists) return e.reply(`别名「${value}」已存在（${exists}）`)
    if (!Array.isArray(data[formal])) data[formal] = data[formal] ? [data[formal]] : []
    data[formal].push(value)
    yaml.set(ALIAS_FILE, formal, data[formal])
    await this.clearCache()
    return e.reply(`角色「${formal}」别名「${value}」添加成功`)
  }

  async deleteAlias(e) {
    if (!e.isMaster) return e.reply('仅限主人设置别名')
    const m = String(e.msg || '').match(new RegExp(`${PREFIX}删除别名(\\S+)$`))
    if (!m) return false
    const value = m[1]
    const data = this.loadAliases()
    const formal = this.resolveFormal(value, data)
    if (!formal) return e.reply(`未找到别名「${value}」`)
    if (norm(formal) === norm(value)) return e.reply('角色本名不能作为别名删除')
    const list = Array.isArray(data[formal]) ? data[formal] : []
    const next = list.filter(a => norm(a) !== norm(value))
    if (next.length === list.length) return e.reply(`「${value}」不是 ${formal} 的别名`)
    yaml.set(ALIAS_FILE, formal, next)
    await this.clearCache()
    return e.reply(`角色「${formal}」别名「${value}」删除成功`)
  }

  async listAlias(e) {
    const m = String(e.msg || '').match(new RegExp(`${PREFIX}(\\S+?)别名$`))
    if (!m) return false
    const data = this.loadAliases()
    const formal = this.resolveFormal(m[1], data)
    if (!formal) return false
    const list = Array.isArray(data[formal]) ? data[formal] : []
    if (!list.length) return e.reply(`角色「${formal}」暂无别名，可发送「添加${formal}别名xxx」添加`)
    return e.reply(`角色「${formal}」共 ${list.length} 个别名：\n${list.join('、')}`)
  }
}
