import fs from "node:fs"
import YAML from "yaml"
import chokidar from "chokidar"
import { wikiPath } from "./index.js"

class Config {
  constructor() {
    /** 默认设置 */
    this.defPath = wikiPath.getDir("wiki/config/defSet/")
    this.defSet = {}

    /** 用户设置 */
    this.configPath = wikiPath.getDir("wiki/config/config/")
    this.config = {}

    /** 监听文件 */
    this.watcher = { config: {}, defSet: {} }

    this.initCfg()
  }

  /** 初始化配置 */
  initCfg() {
    /* wiki / miao 插件可能已被卸载，defSet 目录不存在时直接跳过，
       不要抛 ENOENT 把整个插件加载流程带崩 */
    if (!fs.existsSync(this.defPath)) {
      logger.debug?.('[HoYoGet][wiki] 跳过配置初始化：defSet 目录不存在')
      return
    }
    const files = fs.readdirSync(this.defPath).filter(file => file.endsWith(".yaml"))
    if (!fs.existsSync(`${this.configPath}`)) fs.mkdirSync(`${this.configPath}`)
    for (let file of files) {
      if (!fs.existsSync(`${this.configPath}${file}`)) fs.copyFileSync(`${this.defPath}${file}`, `${this.configPath}${file}`)
      this.watch(`${this.configPath}${file}`, file.replace(".yaml", ""), "config")
    }
  }

  /**
   * 获取配置文件内容转JSON
   * @param filename - 文件名
   */
  getCfg(filename) {
    try {
      if (!fs.existsSync(`${this.configPath}${filename}.yaml`)) return false
      return YAML.parse(fs.readFileSync(`${this.configPath}${filename}.yaml`, "utf8"))
    } catch (error) {
      logger.error(`[${filename}] 读取失败 ${error}`)
      return false
    }
  }

  /**
   * 写入配置文件
   * @param filename - 文件名
   * @param item - 配置项
   * @param data - 写入内容
   */
  changeCfg(filename, item, data) {
    const config = this.getCfg(filename)
    config[item] = data
    try {
      if (!fs.existsSync(`${this.configPath}${filename}.yaml`)) return false
      fs.writeFileSync(`${this.configPath}${filename}.yaml`, YAML.stringify(config), "utf8")
    } catch (error) {
      logger.error(`[${filename}] 写入失败 ${error}`)
      return false
    }
  }

  /**
   * 监听配置文件
   * @param file
   * @param app
   * @param type
   */
  watch(file, app, type = "defSet") {
    if (this.watcher[type][app]) return

    const watcher = chokidar.watch(file)
    watcher.on("change", path => {
      delete this[type][app]
      logger.mark(`[wiki][修改配置文件][${type}][${app}]`)
      if (this[`change_${app}`]) this[`change_${app}`]()
    })
    this.watcher[type][app] = watcher
  }
}

export default new Config()
