import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pluginPriority, render } from '#HoYoGet'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const YUNZAI_DB = path.join(process.cwd(), 'data', 'db', 'data.db')

/**
 * 原神 / 星铁 角色面板总览（自研版式，数据复用 miao-plugin 的模型）
 *
 * 为什么复用 miao 的数据层：米游社面板抓取、圣遗物/遗器评分、天赋与武器换算
 * 都在 miao-plugin 里实现得足够完整，重写一遍既慢又容易出错。
 * 这里只做「取数 → 整理成扁平结构 → 用自己的模板渲染」。
 *
 * miao-plugin 的 UI 与代码本身是开放的（作者 yoimiya-kokomi 明确说明可任意使用，
 * 备注来源即可），本模板版式参考其 profile-list 的网格布局，但样式与结构独立实现。
 *
 * 指令：
 *   #米哈游原神面板 / 米哈游原神面板
 *   #米哈游星铁面板 / 米哈游星铁面板
 *   #米哈游原神面板 123456789   （指定 UID）
 */

const GAME_CONF = {
  gs: { aliases: ['原神', 'gs'], cn: '原神', bind: '#', prefix: '#绑定' },
  sr: { aliases: ['星铁', '崩铁', 'sr'], cn: '星穹铁道', bind: '*', prefix: '*绑定' },
}

const PANEL_REG = /^#?(?:米哈游)?\s*(原神|星铁|崩铁|gs|sr)\s*面板(?:\s+(\d{9}))?$/i
const PANEL_LIST_REG = /^#?(?:米哈游)?\s*(原神|星铁|崩铁|gs|sr)\s*面板列表$/i
/* 更新面板：#米哈游原神更新面板 / #米哈游星铁更新面板 [UID] */
const PANEL_REFRESH_REG = /^#?(?:米哈游)?\s*(原神|星铁|崩铁|gs|sr)\s*(?:更新|刷新)(?:全部)?面板(?:\s+(\d{9}))?$/i

/** 从 Users 表读该用户的某个游戏 UID */
async function readBoundUid(e, game) {
  const qq = String(e?.user_id || e?.sender?.user_id || '').trim()
  if (!qq) return ''
  if (!fs.existsSync(YUNZAI_DB)) return ''
  try {
    const sqlite3 = (await import('sqlite3')).default
    const row = await new Promise(resolve => {
      const db = new sqlite3.Database(YUNZAI_DB, sqlite3.OPEN_READONLY, err => (err ? resolve(null) : null))
      db.get('select games from Users where id = ?', [qq], (err2, r) => {
        db.close(() => {})
        resolve(err2 ? null : r)
      })
    })
    if (!row?.games) return ''
    const uid = String(JSON.parse(row.games)?.[game]?.uid || '').trim()
    if (/^[1-9]\d{8}$/.test(uid)) return uid
  } catch (_) {
    /* 回落下面的 MysUsers */
  }
  return ''
}

/**
 * 从 genshin 的 MysUsers 表读「当前生效 UID」。
 *
 * 为什么优先用它：`#uid 2` 这类切换只会重排 MysUsers.uids[game] 的顺序，
 * **不会改 Users.games.<game>.uid**。只读后者的话，用户切了 UID 这里仍拿旧的。
 * 所以先看 MysUsers（uid 列表第一项即当前生效），拿不到再回落 Users。
 */
async function readMysMainUid(e, game) {
  const qq = String(e?.user_id || e?.sender?.user_id || '').trim()
  if (!qq) return ''
  if (!fs.existsSync(YUNZAI_DB)) return ''
  try {
    const sqlite3 = (await import('sqlite3')).default
    const rows = await new Promise(resolve => {
      const db = new sqlite3.Database(YUNZAI_DB, sqlite3.OPEN_READONLY, err => (err ? resolve([]) : null))
      db.all('select uids from MysUsers', (err2, list) => {
        db.close(() => {})
        resolve(err2 ? [] : list || [])
      })
    })
    // MysUsers 按 ltuid 存，需要再通过 Users.games 里的 ck 归属筛选出该 QQ 的账号；
    // 简单做法：取该 QQ 在 Users 里记过的所有 uid 作为候选，匹配到哪个 ltuid 就用它的 uids[0]
    const own = new Set()
    const userRow = await new Promise(resolve => {
      const db = new sqlite3.Database(YUNZAI_DB, sqlite3.OPEN_READONLY, err => (err ? resolve(null) : null))
      db.get('select games from Users where id = ?', [qq], (err2, r) => {
        db.close(() => {})
        resolve(err2 ? null : r)
      })
    })
    try {
      const games = JSON.parse(userRow?.games || '{}')
      for (const uid of Object.keys(games?.[game]?.data || {})) own.add(String(uid))
      if (games?.[game]?.uid) own.add(String(games[game].uid))
    } catch (_) { /* ignore */ }
    if (!own.size) return ''
    for (const row of rows) {
      let uids = {}
      try { uids = JSON.parse(row.uids || '{}') } catch (_) { continue }
      const list = uids?.[game] || []
      if (list.some(u => own.has(String(u)))) {
        const main = String(list.find(u => own.has(String(u))) || list[0] || '')
        if (/^[1-9]\d{8}$/.test(main)) return main
      }
    }
  } catch (_) {
    /* 回落 */
  }
  return ''
}

/** 动态加载 miao 的模型；缺失时返回 null，让调用方给出可读提示 */
async function loadMiao() {
  try {
    const mod = await import('../../miao-plugin/models/index.js')
    return {
      Player: mod.Player,
      Character: mod.Character,
      MysApi: mod.MysApi,
    }
  } catch (_) {
    return null
  }
}

/**
 * 把一个 miao 的 profile（Avatar 实例）压成模板用的扁平结构。
 * 只取展示需要的字段，避免模板直接依赖 miao 的内部结构。
 */
function flattenProfile(profile, Character) {
  const char = profile.char
  const imgs = char?.imgs || {}
  const artis = profile.artis
  const weapon = profile.weapon
  const talent = profile.talent || {}

  // 圣遗物 / 遗器的总评分与段位（miao 的 ArtisMark 已经算好）
  const artisMark = artis?.markClass || ''
  const artisScore = artis?._mark != null ? Math.round(artis._mark * 10) / 10 : ''

  return {
    id: char?.id || '',
    name: char?.name || '',
    abbr: char?.abbr || char?.name || '',
    star: char?.star || 4,
    elem: char?.elem || '',
    level: profile.level || 1,
    cons: profile.cons || 0,
    // 立绘/头像：优先竖版脸图，退回方图
    // miao 的图片路径以 / 开头（相对 miao 的 resources），模板里要拼 _miao_path，去掉前导斜杠避免双斜杠
    face: String(imgs.qFace || imgs.face || '').replace(/^\//, ''),
    splash: imgs.splash || '',
    artisMark,
    artisScore,
    talent: Object.values(talent)
      .map(t => Number(t?.original ?? t?.level) || 0)
      .filter(Boolean)
      .sort((a, b) => b - a),
    weapon: weapon ? {
      name: weapon.name || '',
      star: weapon.star || 0,
      level: weapon.level || 0,
      refine: weapon.affix || 0,
      icon: String(weapon.imgs?.icon || '').replace(/^\//, ''),
    } : null,
    // 关键属性（模板里展示三四个就够）
    attrs: pickAttrs(profile),
  }
}

/** 从 profile 的属性里挑几个展示用 */
function pickAttrs(profile) {
  const a = profile.attr || {}
  const pct = v => (v == null || v === '') ? '' : `${(Number(v) * 100).toFixed(1)}%`
  const num = v => (v == null || v === '') ? '' : String(Math.round(Number(v)))
  return [
    { k: '生命', v: num(a.hp) },
    { k: '攻击', v: num(a.atk) },
    { k: '防御', v: num(a.def) },
    { k: '暴击', v: pct(a.cpct) },
    { k: '暴伤', v: pct(a.cdmg) },
    { k: '充能', v: pct(a.recharge) },
    { k: '精通', v: num(a.mastery) },
  ].filter(x => x.v)
}

export class hoyo_panel extends plugin {
  constructor() {
    super({
      name: '[米哈游]原神/星铁面板',
      dsc: '原神与星铁的角色面板总览（自研版式，数据复用 miao-plugin）',
      event: 'message',
      priority: pluginPriority('hoyo_panel', -42000),
      rule: [
        { reg: PANEL_REFRESH_REG.source, fnc: 'refreshPanel' },
        { reg: PANEL_REG.source, fnc: 'panel' },
        { reg: PANEL_LIST_REG.source, fnc: 'panel' },
      ],
    })
  }

  /** 「#米哈游原神更新面板」：拉取最新面板后直接出总览图 */
  async refreshPanel(e) {
    const m = String(e.msg || '').match(PANEL_REFRESH_REG)
    if (!m) return false
    const key = String(m[1] || '').toLowerCase()
    const game = ['星铁', '崩铁', 'sr'].includes(key) ? 'sr' : 'gs'
    const conf = GAME_CONF[game]
    e.isSr = game === 'sr'

    const miao = await loadMiao()
    if (!miao) {
      return e.reply('需要先安装 miao-plugin 才能更新面板（本功能复用它抓取的面板）。')
    }

    let uid = m[2] || ''
    if (!uid) uid = await readMysMainUid(e, game)
    if (!uid) uid = await readBoundUid(e, game)
    if (!uid) {
      return e.reply([
        `没能确定要更新的${conf.cn} UID。`,
        `可以这样用：#米哈游${conf.cn}更新面板 123456789`,
        `或先绑定：${conf.prefix}123456789`,
      ].join('\n'))
    }

    try {
      await e.reply(`正在更新 ${uid} 的${conf.cn}面板，请稍候…`)

      const player = new miao.Player(uid, game)
      /* 三个前置条件缺一不可：
         · player.e  —— ProfileAvatar.refreshProfile 用它取 ck 与回复提示
         · e.uid     —— Serv.req 里 ProfileReq.create(e) 要求 e.uid 且大于内置预设的 UID 段，
                        少了直接 return false，表现就是「提示更新成功但数据没变」
         · force=2   —— 传 true 会被当成 force=0，走 60 分钟缓存判断，可能直接跳过 */
      player.e = e
      e.uid = uid
      e.game = game
      /* ProfileReq.requestProfile 里直接读 player.e._mys.getCharacter()，
         而 e._mys 要 MysApi.init() 才会挂上去。不初始化会抛
         「Cannot read properties of undefined (reading 'getCharacter')」。
         用 auth='cookie' 走已绑定的 ck，拿不到（未绑/失效）时明确提示。 */
      const mys = await miao.MysApi.init(e, 'cookie')
      if (!mys) {
        return e.reply([
          `更新 ${uid} 的面板需要米游社 Cookie。`,
          '请先发送 #米哈游扫码绑定 绑定账号，或 #刷新ck 刷新失效的 Cookie。',
        ].join('\n'))
      }
      const refreshed = await player.refreshProfile(2, true)
      /* ⚠ 返回值不能当成败判据：refreshProfile 返回的是 `player._update.length`
         —— 本次**内容有变化**的角色数。数据拉取成功但和缓存一致时它是 0，
         把 0 当失败会出现「数据明明更新了却提示更新失败」。
         真正的失败信号只有 false / undefined（请求没发出去或抛错）。 */
      if (refreshed === false || refreshed === undefined) {
        logger.warn?.(`[HoYoGet][hoyo_panel] ${uid} 面板未刷新（refreshProfile 返回 ${refreshed}）`)
        return e.reply([
          `更新 ${uid} 的${conf.cn}面板失败。`,
          '可能原因：',
          '  · 未绑定 Cookie（先 #米哈游扫码绑定）',
          '  · 米游社请求被风控拦截，稍后重试',
          '  · 面板更新有 CD，刚更新过需要等一会',
        ].join('\n'))
      }
      // refreshProfile 内部会 reload，重新取一次 player 状态
      if (!player.hasProfile) {
        return e.reply([
          `更新失败：没拿到 ${uid} 的${conf.cn}面板数据。`,
          '请确认角色已在游戏内「角色展柜」中展示，并开启「显示角色详情」，',
          '设置完成后等 5 分钟再试。',
        ].join('\n'))
      }

      // 数据已刷新，直接走总览渲染
      return this.renderPanel(e, game, uid, miao, true)
    } catch (err) {
      logger.error?.(`[HoYoGet][hoyo_panel] 更新面板失败: ${err?.message || err}`)
      return e.reply(`更新面板失败：${err?.message || err}`)
    }
  }

  async panel(e) {
    const m = String(e.msg || '').match(PANEL_REG) || String(e.msg || '').match(PANEL_LIST_REG)
    if (!m) return false
    const key = String(m[1] || '').toLowerCase()
    const game = ['星铁', '崩铁', 'sr'].includes(key) ? 'sr' : 'gs'
    const conf = GAME_CONF[game]
    e.isSr = game === 'sr'

    const miao = await loadMiao()
    if (!miao) {
      return e.reply('需要先安装 miao-plugin 才能读取面板数据（本功能复用它抓取的面板）。')
    }

    // UID：指令里带的优先，其次绑定
    let uid = m[2] || ''
    if (!uid) uid = await readMysMainUid(e, game)
    if (!uid) uid = await readBoundUid(e, game)
    if (!uid) {
      return e.reply([
        `没能确定要查询的${conf.cn} UID。`,
        '可以这样用：',
        `  #米哈游${conf.cn}面板 123456789   （直接带 UID）`,
        `  或先绑定：${conf.prefix}123456789`,
      ].join('\n'))
    }

    try {
      const player = new miao.Player(uid, game)
      if (!player.hasProfile) {
        // 本地没有面板缓存，尝试刷新一次（同样需要 e.uid 才能发起请求）
        player.e = e
        e.uid = uid
        e.game = game
        await player.refreshProfile(2, true)
      }
      if (!player.hasProfile) {
        return e.reply([
          `本地暂无 ${uid} 的${conf.cn}面板数据。`,
          '请先在游戏内把角色放进「角色展柜」并开启显示详情，然后：',
          `  #米哈游${conf.cn}更新面板`,
        ].join('\n'))
      }
      return this.renderPanel(e, game, uid, miao, false, player)
    } catch (err) {
      logger.error?.(`[HoYoGet][hoyo_panel] 面板渲染失败: ${err?.message || err}`)
      return e.reply(`面板获取失败：${err?.message || err}`)
    }
  }

  /** 把 player 的面板渲染成总览图（panel 与 refreshPanel 共用） */
  async renderPanel(e, game, uid, miao, isRefresh, prePlayer = null) {
    const conf = GAME_CONF[game]
    try {
      const player = prePlayer || new miao.Player(uid, game)
      /* 逐角色取，单个坏数据不能拖垮整张面板：
         miao 的 Player.getProfiles() 内部会对每个 avatar 调 setAvatar，
         某些残缺记录（如 artis 结构缺字段）会抛错并中断整个遍历。 */
      const chars = []
      let skipped = 0
      const ids = Object.keys(player._avatars || {})
      for (const id of ids) {
        try {
          const av = player.getAvatar(id)
          if (!av?.isProfile) continue
          const item = flattenProfile(av, miao.Character)
          if (item.name) chars.push(item)
        } catch (err) {
          skipped++
          logger.debug?.(`[HoYoGet][hoyo_panel] 跳过角色 ${id}：${err?.message || err}`)
        }
      }
      if (skipped) logger.mark?.(`[HoYoGet][hoyo_panel] ${uid} 有 ${skipped} 个角色数据异常，已跳过`)

      if (!chars.length) return e.reply(`没有读到 ${uid} 的角色面板数据。`)

      // 排序：五星优先 → 等级 → 评分
      chars.sort((a, b) => (b.star - a.star) || (b.level - a.level) || ((b.artisScore || 0) - (a.artisScore || 0)))

      const avgScore = (() => {
        const valid = chars.map(c => c.artisScore).filter(v => typeof v === 'number')
        return valid.length ? (valid.reduce((s, v) => s + v, 0) / valid.length).toFixed(1) : ''
      })()
      const maxScore = Math.max(...chars.map(c => c.artisScore || 0), 0)

      const info = player.getInfo?.() || {}
      const img = await render('hoyo_panel/list', {
        game,
        gameCn: conf.cn,
        uid,
        nickname: info.nickname || info.name || '',
        level: info.level || '',
        chars,
        total: chars.length,
        avgScore,
        maxScore: maxScore ? maxScore.toFixed(1) : '',
      }, { e, ret: true })
      return img
    } catch (err) {
      logger.error?.(`[HoYoGet][hoyo_panel] 面板渲染失败: ${err?.message || err}`)
      return e.reply(`面板获取失败：${err?.message || err}`)
    }
  }
}
