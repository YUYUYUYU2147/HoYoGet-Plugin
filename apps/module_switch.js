import yaml from 'node:yaml'
import fs from 'node:fs'
import { pluginPriority } from '#xhh'
import { MODULES, isModuleEnabled, disabledModuleLabels } from '../system/modules.js'

const CFG_PATH = './plugins/xhh/config/config.yaml'

/** 功能模块开关：关掉后对应指令静默不响应（不提示、不报错，消息放给别的插件） */
export class ModuleSwitch extends plugin {
  constructor() {
    super({
      name: '[小花火]模块开关',
      dsc: '查看/切换各功能模块的启用状态',
      event: 'message',
      priority: pluginPriority('module_switch', 15),
      rule: [
        { reg: '^#*(小花火|xhh)模块(开关|状态)?$', fnc: 'list' },
        { reg: '^#*(小花火|xhh)(关闭|开启)模块\\s+(\\S+)$', fnc: 'toggle' },
        { reg: '^#*(小花火|xhh)模块帮助$', fnc: 'help' },
      ],
    })
  }

  readCfg() {
    try {
      return yaml.parse(fs.readFileSync(CFG_PATH, 'utf8')) || {}
    } catch (err) {
      logger.warn(`[xhh][modules] 读取配置失败：${err?.message || err}`)
      return {}
    }
  }

  writeCfg(cfg) {
    // 保留文件头的注释说明：只重写数据体，头部注释单独拼回
    let header = ''
    try {
      const raw = fs.readFileSync(CFG_PATH, 'utf8')
      const firstKey = raw.search(/^[A-Za-z_]/m)
      if (firstKey > 0) header = raw.slice(0, firstKey)
    } catch {}
    fs.writeFileSync(CFG_PATH, header + yaml.stringify(cfg))
  }

  list(e) {
    if (!isModuleEnabled('module_switch')) return false
    const lines = Object.entries(MODULES).map(([ id, m ]) => {
      const on = isModuleEnabled(id)
      return `${on ? '✅' : '⛔'} ${m.label}（${m.key}）`
    })
    const off = disabledModuleLabels()
    return e.reply([
      '【小花火 · 功能模块开关】',
      ...lines,
      '',
      off.length ? `当前已关闭：${off.join('、')}` : '当前全部开启',
      '切换：#小花火关闭模块 sr_gacha / #小花火开启模块 sr_gacha',
      '也可以在锅巴面板里逐项开关。',
    ].join('\n'))
  }

  help(e) {
    if (!isModuleEnabled('module_switch')) return false
    return e.reply([
      '【模块开关】',
      '#小花火模块 —— 查看各模块当前状态',
      '#小花火关闭模块 <模块id> —— 关闭后该模块指令静默不响应',
      '#小花火开启模块 <模块id> —— 恢复',
      '模块id见下（也可用锅巴面板直接切换）：',
      ...Object.entries(MODULES).map(([ id, m ]) => `${id} = ${m.label}`),
    ].join('\n'))
  }

  async toggle(e) {
    // 本模块自己也能被关掉：关掉后连开关指令都不响应，免得关了之后改不回来
    if (!isModuleEnabled('module_switch')) return false
    if (!e.isMaster) return e.reply('仅主人可切换模块开关', true)
    const [, action, id] = String(e.msg || '').match(/(关闭|开启)模块\s+(\S+)/) || []
    const mod = MODULES[id]
    if (!mod) return e.reply(`没有这个模块：${id}\n发送 #小花火模块帮助 查看全部模块`)
    const cfg = this.readCfg()
    cfg[mod.key] = action === '开启'
    this.writeCfg(cfg)
    return e.reply(`「${mod.label}」已${action}（配置项 ${mod.key} = ${cfg[mod.key]}）\n重启机器人后完全生效`)
  }
}