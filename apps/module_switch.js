import { pluginPriority } from '#HoYoGet'
import yaml from '../system/yaml.js'
import { MODULES, isModuleEnabled, disabledModuleLabels } from '../system/modules.js'

const CFG_PATH = './plugins/HoYoGet-Plugin/config/config.yaml'

/** 功能模块开关：关掉后对应指令静默不响应（不提示、不报错，消息放给别的插件） */
export class ModuleSwitch extends plugin {
  constructor() {
    super({
      name: '[米哈游]模块开关',
      dsc: '查看/切换各功能模块的启用状态',
      event: 'message',
      priority: pluginPriority('module_switch', 15),
      rule: [
        { reg: '^#*米哈游模块(开关|状态)?$', fnc: 'list' },
        { reg: '^#*米哈游(关闭|开启)模块\\s+(\\S+)$', fnc: 'toggle' },
        { reg: '^#*米哈游模块帮助$', fnc: 'help' },
      ],
    })
  }

  readCfg() {
    try {
      return yaml.get(CFG_PATH) || {}
    } catch (err) {
      logger.warn(`[HoYoGet][modules] 读取配置失败：${err?.message || err}`)
      return {}
    }
  }

  /** 只改一个键，走 yaml.set 保留文件里的注释与排版（详见 system/yaml.js 的说明） */
  writeKey(key, value) {
    return yaml.set(CFG_PATH, key, value)
  }

  list(e) {
    if (!isModuleEnabled('module_switch')) return false
    const lines = Object.entries(MODULES).map(([ id, m ]) => {
      const on = isModuleEnabled(id)
      return `${on ? '✅' : '⛔'} ${m.label}（${m.key}）`
    })
    const off = disabledModuleLabels()
    return e.reply([
      '【米哈游 · 功能模块开关】',
      ...lines,
      '',
      off.length ? `当前已关闭：${off.join('、')}` : '当前全部开启',
      '切换：#米哈游关闭模块 sr_gacha / #米哈游开启模块 sr_gacha',
      '也可以在锅巴面板里逐项开关。',
    ].join('\n'))
  }

  help(e) {
    if (!isModuleEnabled('module_switch')) return false
    return e.reply([
      '【模块开关】',
      '#米哈游模块 —— 查看各模块当前状态',
      '#米哈游关闭模块 <模块id> —— 关闭后该模块指令静默不响应',
      '#米哈游开启模块 <模块id> —— 恢复',
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
    if (!mod) return e.reply(`没有这个模块：${id}\n发送 #米哈游模块帮助 查看全部模块`)
    const on = action === '开启'
    this.writeKey(mod.key, on)
    return e.reply(`「${mod.label}」已${action}（配置项 ${mod.key} = ${on}）\n重启机器人后完全生效`)
  }
}