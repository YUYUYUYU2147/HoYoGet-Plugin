import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// config 必须一起导入：loadCfg() 要用它读 plugins/HoYoGet-Plugin/config/config.yaml，
// 只导入 pluginPriority 会让 config() 抛 ReferenceError，配置全走默认值。
import { config, pluginPriority } from '#HoYoGet'

/**
 * 绝区零面板更新加速。
 *
 * ZZZ-Plugin 的「%更新面板」有两处串行阻塞，耗时随角色数线性增长：
 *
 * 1. dist/lib/avatar.js getAvatarInfoList()
 *      for (const item of avatarBaseList) {
 *        const data = await api.getFinalData('zzzAvatarInfo', { id_list: [item.id] })
 *        await new Promise(resolve => setTimeout(resolve, roleInterval))  // 默认 3000ms
 *      }
 *    每角色硬 sleep roleInterval（默认 3 秒），44 个角色 = 132 秒纯等待。
 *
 * 2. dist/lib/avatar.js mergePanel()
 *      for (const item of formattedData) await item.get_basic_assets()
 *    头像下载串行叠加；本地无缓存时每个角色都要联网。
 *
 * 本模块在 ZZZ-Plugin 之前接管该指令，复用它的 api 类与落盘逻辑，
 * 但把上面两处改为「并发窗口 + 小间隔」。不修改 ZZZ-Plugin 任何文件，
 * 因此更新上游不会冲掉，也不会因其内部实现变化而失效。
 *
 * 开关项在 system/default/default_config/config.yaml：
 *   zzz_panel_accel_enabled: true
 *   zzz_panel_accel_concurrency: 4   # 并发窗口，越大越快、越易被限流
 *   zzz_panel_accel_interval: 400    # 每角色请求后的间隔 ms，取代上游的 3000ms
 * 优先级：zzz_panel_accel_priority（默认 -99999999999，须小于 ZZZ-Plugin 面板的 70）
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(__dirname, '..')
const ZZZ_ROOT = path.join(process.cwd(), 'plugins', 'ZZZ-Plugin')

const DEFAULTS = { enabled: true, concurrency: 4, interval: 400 }

/** 三个开关项在 config.yaml 中的键名 */
const CFG_KEYS = {
  enabled: 'zzz_panel_accel_enabled',
  concurrency: 'zzz_panel_accel_concurrency',
  interval: 'zzz_panel_accel_interval'
}

/**
 * 接管范围。ZZZ-Plugin 的面板规则是 `(.*)面板(展柜)?(刷新|更新|列表)?`，
 * 前缀任意，因此这里枚举会被它吃掉的形式：
 * 「更新面板 / 刷新面板 / 更新展柜面板 / 更新全部面板 / 更新面板列表」等。
 */
/**
 * 只接管**带绝区零标识**的指令：%更新面板 / #绝区零更新面板 / zzz刷新面板。
 *
 * 不能把游戏名写成可选：裸的「#更新面板」是 genshin 那边原神面板的固定叫法
 * （model/other/button.js 的按钮就写死这个），前缀一旦可选，本插件又会靠
 * -9999999999 的优先级 + accept 返回 'return' 把它抢走，原神面板永远收不到。
 * ZZZ-Plugin 自己的 rulePrefix 同样把前缀写成可选，那属于它的行为，不在本插件范围内。
 */
const ACCEL_RE = /^[#*\s]*(?:%\s*(?:绝区零|zzz|绝区)?|[/%]\s*|绝区零|[zZ][zZ][zZ]|绝区)\s*(?:更新|刷新)(?:全部|全局|所有|全服|本地)?(?:展柜)?面板(?:列表)?$/

/**
 * 读取配置。走 xhh 自己的 config()（即 plugins/HoYoGet-Plugin/config/config.yaml，
 * 缺失项由 system/default/default_config/config.yaml 兜底），
 * 不自己解析 YAML——之前手写正则既不支持行内注释，也和插件的读取方式不一致。
 */
function loadCfg() {
  const cfg = { ...DEFAULTS }
  try {
    const userCfg = config() || {}
    for (const [ key, cfgKey ] of Object.entries(CFG_KEYS)) {
      const v = userCfg[cfgKey]
      if (v === undefined || v === null || v === '') continue
      if (key === 'enabled') cfg.enabled = !/^(false|0|no|off)$/i.test(String(v))
      else {
        const n = Number(v)
        // 0 是有效值（并发 0 无意义但间隔 0 应尊重），只用 NaN 回退默认
        if (!Number.isNaN(n)) cfg[key] = n
      }
    }
  } catch (err) {
    logger.warn(`[HoYoGet][panel-accel] 配置读取失败，使用默认值：${err?.message || err}`)
  }
  return cfg
}

/**
 * 判断报错是否为风控拦截。
 * 米游社触发风控时不返回错误码，而是返回整页 HTML「已阻断」，实测表现为 HTTP 405，
 * 因此按关键词与状态码共同判定，避免把普通 404 也当成风控。
 */
export function isBlockedErr(msg) {
  const s = String(msg || '')
  return /已阻断|阻断页面|安全威胁/.test(s) || /\b(405|429)\b/.test(s)
}

async function fetchAvatarsConcurrently(api, deviceFp, avatarBaseList, cfg) {
  const results = []
  let index = 0
  // 首次遇到风控后，本轮后续请求全部改走代理：并发下逐个重试没有意义，
  // 触发风控说明出口 IP 已被盯上，继续直连只会整批失败。
  let proxyTried = false

  const worker = async () => {
    while (index < avatarBaseList.length) {
      const item = avatarBaseList[index++]
      try {
        const data = await api.getFinalData('zzzAvatarInfo', {
          deviceFp,
          query: { id_list: [item.id] }
        })
        const avatar = data?.avatar_list?.[0]
        if (avatar) results.push(avatar)
      } catch (err) {
        const msg = String(err?.message || err)
        // 说明：ZZZ-Plugin 的 MysZZZApi 继承自 genshin 的 MysApi，其 getData()
        // 内部已走 mhyFetch —— 直连被风控拦下时（405 + HTML 阻断页）会自动改走
        // 米游社代理，无需在此另做切代理逻辑，这里只做识别与提示，
        // 避免把 404 之类的普通失败也误判成风控。
        if (!proxyTried && isBlockedErr(msg)) {
          proxyTried = true
          logger.warn(`[HoYoGet][panel-accel] 检测到风控拦截（${msg.slice(0, 60)}），后续请求由 mhyFetch 自动改走代理${proxyEnabled() ? ` ${proxyBase()}` : '（但代理未启用！）'}`)
        }
        // 单个角色失败不中断整体，与上游的 continue 语义一致
        logger.debug(`[HoYoGet][panel-accel] 角色 ${item.id} 获取失败：${msg}`)
      }
      // 限流：并发窗口内错开请求，取代上游每角色固定 3 秒的串行等待
      await new Promise(resolve => setTimeout(resolve, cfg.interval))
    }
  }
  const width = Math.min(cfg.concurrency, avatarBaseList.length)
  await Promise.all(Array.from({ length: width }, () => worker()))
  return results
}

/** 并发补齐头像资源，取代上游的串行 for-await */
async function fillIconsConcurrently(ZZZAvatarInfo, items) {
  const list = items.map(item => new ZZZAvatarInfo(item))
  await Promise.all(list.map(item => item.get_basic_assets().catch(() => {})))
  return list
}

export class zzz_panel_accel extends plugin {
  constructor() {
    super({
      name: '[HoYoGet/zzz_panel_accel.js]绝区零面板更新加速',
      dsc: '把 ZZZ-Plugin 面板更新的串行等待改为并发，缩短 %更新面板 耗时',
      event: 'message',
      // 必须早于 ZZZ-Plugin 面板指令（其 priority 取自自身 config 的 panel，默认 70），
      // 否则规则抢不过它、接管不生效。
      // 取 -9999999999 而非更小的值：锅巴 priorityInput 的 min 就是 -9999999999，
      // 填 -99999999999 会被判越界、面板上标成红色无效值。该值与
      // custom_guide_priority / user_priority 同档，语义一致。
      // 不用 -Infinity：YAML 读回会变成字符串 "-Infinity"，pluginPriority 就返回字符串了。
      priority: pluginPriority('zzz_panel_accel', -9999999999),
      rule: [
        { reg: ACCEL_RE.source, fnc: 'fastUpdate' }
      ]
    })
  }

  /** 在 accept 阶段接管：ZZZ-Plugin 的规则同样是「(更新|刷新)…面板」，普通 rule 抢不过它 */
  async accept(e) {
    const msg = String(e?.msg || '').replace(/\s+/g, '')
    if (!ACCEL_RE.test(msg)) return
    const cfg = loadCfg()
    if (!cfg.enabled) return
    if (!fs.existsSync(path.join(ZZZ_ROOT, 'dist', 'lib', 'mysapi.js'))) {
      return e.reply('未检测到 ZZZ-Plugin，跳过面板加速')
    }
    e.msg = msg
    await this.runFastUpdate(e, cfg)
    return 'return'
  }

  async fastUpdate() {
    // accept 阶段已统一处理，这里仅兜底（rule 命中时）
    const cfg = loadCfg()
    if (!cfg.enabled) return false
    return await this.runFastUpdate(this.e, cfg)
  }

  /** 与 ZZZ-Plugin 面板更新同流程，但请求与头像两段都并发 */
  async runFastUpdate(e, cfg) {
    const uid = e.user?.getUid?.('zzz')
    if (!uid) return e.reply('请先绑定绝区零账号')

    const t0 = Date.now()
    let mod
    try {
      mod = await import(path.join(ZZZ_ROOT, 'dist', 'lib', 'avatar.js'))
    } catch (err) {
      logger.error(`[HoYoGet][panel-accel] 加载 ZZZ-Plugin avatar 模块失败：${err?.message || err}`)
      return e.reply('面板加速不可用，请改用 ZZZ-Plugin 的更新指令')
    }
    const { getAvatarBasicList, updatePanelData, mergePanel } = mod

    let api
    let deviceFp
    try {
      // MysZZZApi 是 default 导出
      const apiMod = await import(path.join(ZZZ_ROOT, 'dist', 'lib', 'mysapi.js'))
      const MysZZZApi = apiMod.default
      const ck = await this.getCk(e)
      if (!ck || !Object.values(ck).some(item => item?.ck)) {
        return e.reply('尚未绑定 cookie，请先绑定 cookie 或 #扫码登录')
      }
      api = new MysZZZApi(uid, ck, { handler: e?.runtime?.handler || {}, e })
      // ltuid 需按当前 uid 匹配，与 ZZZ-Plugin getLtuid() 一致
      const ltuid = zzz_panel_accel.pickLtuid(ck, uid)
      if (!ltuid) return e.reply('ltuid 为空，请重新绑定 CK')
      deviceFp = await redis.get(`ZZZ:DEVICE_FP:${ltuid}:FP`)
    } catch (err) {
      logger.error(`[HoYoGet][panel-accel] 初始化 api 失败：${err?.message || err}`)
      return e.reply('面板加速初始化失败，请改用 ZZZ-Plugin 的更新指令')
    }

    await e.reply('正在更新面板列表（并发模式）...')
    try {
      const baseList = await getAvatarBasicList(api, deviceFp, false)
      if (!baseList?.length) return e.reply('面板列表为空，请确保已在游戏中展示角色')

      const avatars = await fetchAvatarsConcurrently(api, deviceFp, baseList, cfg)
      if (!avatars.length) return e.reply('未获取到面板数据，请稍后再试')

      // 复用上游的合并落盘（保留未在展柜中的历史角色、标记 isNew）
      const finalData = updatePanelData(uid, avatars)
      // 头像并发补齐，取代上游串行 for-await
      const { ZZZAvatarInfo } = await import(path.join(ZZZ_ROOT, 'dist', 'model', 'avatar.js'))
      const formatted = await fillIconsConcurrently(ZZZAvatarInfo, finalData)
      await redis.set(`ZZZ:PANEL:${uid}:LASTTIME`, Date.now())

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      const newCount = formatted.filter(item => item.isNew).length

      // 渲染面板图：模板 panel/refresh.html 及 beforeRender 注入的
      // pluResPath / sys.resourcesPath / 玩家信息全在 ZZZ-Plugin 内，
      // xhh 既没有这张模板、也没有 this.renderImg 这个入口（该名字只存在于
      // Mys-plugin 的基类与 apps/meme.js 的模块内局部函数里），
      // 直接调用必然抛错并被下面的 catch 吞掉，表现为「只有文字、没有图」。
      // 因此借 ZZZ-Plugin 面板类自身的 render()，与上游 refreshPanel() 同一入口。
      let img = null
      try {
        const { Panel } = await import(path.join(ZZZ_ROOT, 'dist', 'apps', 'panel.js'))
        const panelApp = new Panel()
        panelApp.e = e
        panelApp.reply = e.reply.bind(e)
        // 与上游 refreshPanel() 一致：先取玩家信息，模板头部需要 player / avatar
        await panelApp.getPlayerInfo().catch(() => {})
        // retType: 'base64' 让 render 只回数据、不自行发送，便于与文字合并成一条消息。
        // 返回值形态随渲染后端而异：'base64://…' 字符串 / Buffer / 已是图片消息段。
        // 12:49 那次只认前两种，把消息段形态的返回值丢掉且不留日志，表现为「图又不见了」，
        // 因此三种形态都认下来，认不出时把真实形态写进日志。
        const raw = await panelApp.render('panel/refresh.html', { newChar: newCount, list: formatted }, { retType: 'base64' })
        if (typeof raw === 'string' && raw) img = segment.image(raw.startsWith('base64://') ? raw : `base64://${raw}`)
        else if (Buffer.isBuffer(raw)) img = segment.image(raw)
        else if (raw?.type === 'image' || raw?.data?.file) img = raw
        if (!img) {
          // 三种已知形态都不匹配时才走到这里：把真实形态写进日志（对象列键名、字符串截前 24 字符），
          // 避免再出现「图不见了却查不到原因」的静默失败。
          const shape = typeof raw === 'string'
            ? `string(${raw.slice(0, 24)})`
            : raw && typeof raw === 'object'
              ? `${Object.prototype.toString.call(raw)} keys=${Object.keys(raw).join('/') || 'none'}${raw.type ? ` type=${raw.type}` : ''}`
              : String(raw)
          logger.warn(`[HoYoGet][panel-accel] 面板图返回值未识别（${shape}），仅返回文字`)
        }
      } catch (err) {
        logger.warn(`[HoYoGet][panel-accel] 面板图渲染失败，仅返回文字：${err?.message || err}`)
      }

      // 落盘数据里没有 name 字段（ZZZAvatarInfo 也没有），角色名是 name_mi18n。
      // 早前写成 i.name 导致「新角色」一栏全是空的分隔符。
      const nameOf = item => item.name_mi18n || item.full_name_mi18n || item.name || `#${item.id}`
      const newItems = formatted.filter(i => i.isNew)
      const lines = [
        `面板更新完成（并发 ${cfg.concurrency}、间隔 ${cfg.interval}ms）`,
        `共 ${formatted.length} 个角色，新增 ${newCount} 个，耗时 ${elapsed} 秒`,
        newItems.length ? '新角色：' + newItems.map(nameOf).join('、') : ''
      ].filter(Boolean)
      // segment 是对象：和文字一起 join('\n') 只会得到一行 "[object Object]"，
      // 图必须作为数组元素与文字并列发送（system/bili.js 的扫码消息即此写法）。
      return e.reply(img ? [img, ...lines] : lines.join('\n'))
    } catch (err) {
      logger.error(`[HoYoGet][panel-accel] 面板更新失败：${err?.message || err}`)
      return e.reply(`面板更新失败：${err?.message || err}`)
    }
  }

  /**
   * 取 ck：直接复用 ZZZ-Plugin 的 getCk（dist/lib/common.js），
   * 它会自行处理 stoken 前缀与 User 实例，不要自己拼。
   * 返回形如 { [key]: { ck, uid, ltuid } }。
   */
  async getCk(e) {
    try {
      const commonMod = await import(path.join(ZZZ_ROOT, 'dist', 'lib', 'common.js'))
      if (typeof commonMod.getCk === 'function') return await commonMod.getCk(e)
      return null
    } catch (err) {
      logger.warn(`[HoYoGet][panel-accel] 取 ck 失败：${err?.message || err}`)
      return null
    }
  }

  /** ltuid 需按当前 uid 匹配对应 ck 条目，不能取第一条 */
  static pickLtuid(ck, uid) {
    const hit = Object.values(ck || {}).find(item => item?.ck && String(item.uid) === String(uid))
    return hit?.ltuid || ''
  }
}

export { loadCfg, DEFAULTS, fetchAvatarsConcurrently }