/**
 * 「咕咕牛」原图管理器（#原图）的注册入口。
 *
 * 管理器主体在 gallery.js；一个 app 文件只会注册一个插件类，
 * 所以这里单独导出 SleeperAgent，gallery.js 负责注册 MiaoPluginMBT。
 */
import { SleeperAgent } from './gallery.js'

export { SleeperAgent }
