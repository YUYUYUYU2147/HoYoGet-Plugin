import plugin from '../../../../../lib/plugins/plugin.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from '../../../../../lib/puppeteer/puppeteer.js'

const cfgPath = path.resolve(process.cwd(), 'data/HoYoGet-Plugin/box/config.json')
const resourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../resources/box')

const DEFAULT_CFG = {
  only_admin: false,
  protect_ids: [],
  display_options: [
    'QQ号', '昵称', '备注', '群昵称', '群头衔', '性别',
    '生日', '星座', '生肖', '年龄', '血型', '电话', '邮箱',
    '家乡', '现居', '职业', '个性标签', '风险账号', '机器人账号',
    'QQVIP', '年VIP', 'VIP等级', '群等级', '加群时间', 'QQ等级',
    '注册时间', '签名'
  ],
  recall_time: 0,
  autobox: { white_groups: [], enter: false, exit: false }
}

function loadCfg() {
  try {
    return normalizeCfg(JSON.parse(fs.readFileSync(cfgPath, 'utf8')))
  } catch {
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
    fs.writeFileSync(cfgPath, JSON.stringify(DEFAULT_CFG, null, 2))
    return { ...DEFAULT_CFG }
  }
}

function normalizeCfg(cfg = {}) {
  return {
    ...DEFAULT_CFG,
    ...cfg,
    protect_ids: Array.isArray(cfg.protect_ids) ? cfg.protect_ids.map(String) : [],
    display_options: Array.isArray(cfg.display_options) ? cfg.display_options : DEFAULT_CFG.display_options,
    autobox: {
      ...DEFAULT_CFG.autobox,
      ...(cfg.autobox || {}),
      white_groups: Array.isArray(cfg.autobox?.white_groups) ? cfg.autobox.white_groups.map(String) : [],
    },
  }
}

function getCfg() {
  try { return normalizeCfg(JSON.parse(fs.readFileSync(cfgPath, 'utf8'))) }
  catch { return { ...DEFAULT_CFG, autobox: { ...DEFAULT_CFG.autobox } } }
}

loadCfg()

const FIELD_MAPPING = [
  { key: 'user_id', label: 'QQ号', src: 's' },
  { key: 'nickname', label: '昵称', src: 's' },
  { key: 'remark', label: '备注', src: 's' },
  { key: 'card', label: '群昵称', src: 'm' },
  { key: 'title', label: '群头衔', src: 'm' },
  { key: 'sex', label: '性别', src: 's', fn: v => ({ male: '男', female: '女' })[v] || v },
  { key: 'birthday', label: '生日', calc: true },
  { key: 'constellation', label: '星座', calc: true },
  { key: 'zodiac', label: '生肖', calc: true },
  { key: 'age', label: '年龄', src: 's', sfx: '岁' },
  { key: 'kBloodType', label: '血型', src: 's', fn: v => bloodType(Number(v)) },
  { key: 'phoneNum', label: '电话', src: 's', skip: ['-', ''] },
  { key: 'eMail', label: '邮箱', src: 's', skip: ['-', ''] },
  { key: 'homeTown', label: '家乡', src: 's', fn: parseHomeTown, skip: ['0-0-0', ''] },
  { key: 'address', label: '现居', calc: true },
  { key: 'makeFriendCareer', label: '职业', src: 's', fn: v => career(Number(v)), skip: ['0', ''] },
  { key: 'labels', label: '个性标签', src: 's' },
  { key: 'unfriendly', label: '风险账号', src: 'm', fn: v => v ? '有' : null },
  { key: 'is_robot', label: '机器人账号', src: 'm', fn: v => v ? '是' : null },
  { key: 'is_vip', label: 'QQVIP', src: 's', fn: v => v ? '已开' : null },
  { key: 'is_years_vip', label: '年VIP', src: 's', fn: v => v ? '已开' : null },
  { key: 'vip_level', label: 'VIP等级', src: 's', fn: v => v && Number(v) ? String(v) : null },
  { key: 'level', label: '群等级', src: 'm', fn: v => v ? `${Number(v)}级` : null },
  { key: 'join_time', label: '加群时间', src: 'm', fn: v => v ? fmtTime(v) : null },
  { key: 'qqLevel', label: 'QQ等级', src: 's', fn: v => v ? qqLevelIcon(Number(v)) : null },
  { key: 'reg_time', label: '注册时间', src: 's', fn: v => v ? fmtYear(v) : null },
  { key: 'long_nick', label: '签名', src: 's' },
]

const LABEL_TO_KEY = Object.fromEntries(FIELD_MAPPING.map(f => [f.label, f.key]))

function bloodType(n) {
  return ({ 1: 'A型', 2: 'B型', 3: 'O型', 4: 'AB型', 5: '其他血型' })[n] || null
}

function career(n) {
  return ({
    1: '计算机/互联网/通信', 2: '生产/工艺/制造', 3: '医疗/护理/制药',
    4: '金融/银行/投资/保险', 5: '商业/服务业/个体经营', 6: '文化/广告/传媒',
    7: '娱乐/艺术/表演', 8: '律师/法务', 9: '教育/培训',
    10: '公务员/行政/事业单位', 11: '模特', 12: '空姐', 13: '学生', 14: '其他职业'
  })[n] || null
}

function parseHomeTown(code) {
  if (!code || code === '0-0-0') return null
  const parts = code.split('-')
  const countryMap = { '49': '中国', '250': '俄罗斯', '222': '特里尔', '217': '法国' }
  const provinceMap = {
    '98': '北京', '99': '天津/辽宁', '100': '冀/沪/吉', '101': '苏/豫/晋/黑/渝',
    '102': '浙/鄂/蒙/川', '103': '皖/湘/黔/陕', '104': '闽/粤/滇/甘/台',
    '105': '赣/桂/藏/青/港', '106': '鲁/琼/陕/宁/澳', '107': '新疆'
  }
  const country = countryMap[parts[0]] || `外国${parts[0]}`
  if (parts[0] === '49' && parts[1] && parts[1] !== '0') {
    return provinceMap[parts[1]] || `${parts[1]}省`
  }
  return country
}

function qqLevelIcon(level) {
  const icons = ['👑', '🌞', '🌙', '⭐']
  const levels = [64, 16, 4, 1]
  let result = ''
  let n = level
  for (let i = 0; i < icons.length; i++) {
    const c = Math.floor(n / levels[i])
    result += icons[i].repeat(c)
    n %= levels[i]
  }
  return `${result}(${level})`
}

function getConstellation(month, day) {
  const list = [
    ['摩羯座', 1, 19], ['水瓶座', 2, 18], ['双鱼座', 3, 20],
    ['白羊座', 3, 21], ['金牛座', 4, 20], ['双子座', 5, 21],
    ['巨蟹座', 6, 21], ['狮子座', 7, 22], ['处女座', 8, 23],
    ['天秤座', 9, 23], ['天蝎座', 10, 22], ['射手座', 11, 22],
    ['摩羯座', 12, 21],
  ]
  for (let i = 0; i < list.length - 1; i++) {
    if ((month === list[i][1] && day >= list[i][2]) || (month === list[i + 1][1] && day <= list[i + 1][2])) {
      return list[i][0]
    }
  }
  if (month === 12 && day >= 22) return '摩羯座'
  return `星座${month}-${day}`
}

function getZodiac(year, month, day) {
  const zodiacs = ['鼠🐀', '牛🐂', '虎🐅', '兔🐇', '龙🐉', '蛇🐍', '马🐎', '羊🐏', '猴🐒', '鸡🐔', '狗🐕', '猪🐖']
  const zodiacYear = month < 2 || (month === 2 && day < 4) ? year - 1 : year
  return zodiacs[(zodiacYear - 2020) % 12]
}

function fmtTime(ts) {
  const d = new Date(Number(ts) * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fmtYear(ts) {
  return `${new Date(Number(ts) * 1000).getFullYear()}年`
}

function transformFields(sInfo, mInfo) {
  const _cfg = getCfg()
  const enabled = new Set(_cfg.display_options.map(l => LABEL_TO_KEY[l]).filter(Boolean))
  const lines = []

  for (const fd of FIELD_MAPPING) {
    if (!enabled.has(fd.key)) continue

    if (fd.calc) {
      const bd = parseBirthday(sInfo)
      if (fd.key === 'birthday' && bd) lines.push(`生日：${bd}`)
      else if (fd.key === 'constellation' && bd) {
        const [y, m, d] = bd.split('-').map(Number)
        lines.push(`星座：${getConstellation(m, d)}`)
      } else if (fd.key === 'zodiac' && bd) {
        const [y, m, d] = bd.split('-').map(Number)
        lines.push(`生肖：${getZodiac(y, m, d)}`)
      } else if (fd.key === 'address') {
        const c = sInfo.country, p = sInfo.province, ci = sInfo.city
        if (c === '中国' && (p || ci)) lines.push(`现居：${p || ''}-${ci || ''}`)
        else if (c) lines.push(`现居：${c}`)
      }
      continue
    }

    const data = fd.src === 's' ? sInfo : mInfo
    let val = data[fd.key]

    if (val == null) continue
    if (fd.skip && fd.skip.includes(val)) continue
    if (fd.fn) { val = fd.fn(val); if (val == null) continue }

    const sfx = fd.sfx || ''
    if (fd.key === 'long_nick' && String(val).length > 30) {
      val = String(val).slice(0, 30) + '...'
    }
    lines.push(`${fd.label}：${val}${sfx}`)
  }

  return lines
}

function parseBirthday(info) {
  const y = info.birthday_year, m = info.birthday_month, d = info.birthday_day
  if (y && m && d) {
    try { return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` } catch {}
  }
  return null
}

async function getAvatar(qq) {
  try {
    const resp = await fetch(`https://q4.qlogo.cn/headimg_dl?dst_uin=${qq}&spec=640`)
    if (resp.ok) {
      const buf = await resp.arrayBuffer()
      return `data:image/png;base64,${Buffer.from(buf).toString('base64')}`
    }
  } catch {}
  return null
}

function randColor() {
  const r = Math.floor(Math.random() * 192) + 64
  const g = Math.floor(Math.random() * 192) + 64
  const b = Math.floor(Math.random() * 192) + 64
  return `rgb(${r},${g},${b})`
}

function randTextColor() {
  const r = Math.floor(Math.random() * 128)
  const g = Math.floor(Math.random() * 128)
  const b = Math.floor(Math.random() * 128)
  return `rgb(${r},${g},${b})`
}

export class box extends plugin {
  constructor() {
    super({
      name: 'QQ资料卡片',
      dsc: '以卡片形式展示QQ用户资料',
      event: 'message',
      priority: 5000,
      rule: [
        { reg: '^#?(盒|开盒|box)$', fnc: 'boxCommand' },
      ],
    })
  }

  async boxCommand(e) {
    if (!e.isGroup) return false
    const _cfg = getCfg()

    const targets = this.getTargets(e)
    if (!targets.length) return false

    for (const tid of targets) {
      if (tid === String(e.self_id)) {
        e.reply('不能开盒机器人自己')
        continue
      }
      if (_cfg.protect_ids.includes(tid) && tid !== String(e.user_id)) {
        e.reply('该用户在保护名单中')
        continue
      }
      const isAdmin = e.isMaster || e.member?.is_admin || ['admin', 'owner'].includes(e.sender?.role)
      if (_cfg.only_admin && !isAdmin && tid !== String(e.user_id)) {
        e.reply('仅管理员可开盒他人')
        continue
      }

      try {
        const sInfo = await e.bot.sendApi('get_stranger_info', { user_id: Number(tid), no_cache: true })
        let mInfo = {}
        try {
          mInfo = await e.bot.sendApi('get_group_member_info', { user_id: Number(tid), group_id: Number(e.group_id) })
        } catch {}

        const lines = transformFields(sInfo, mInfo)
        if (!lines.length) {
          e.reply('无可用信息')
          continue
        }

        const avatarDataUrl = await getAvatar(tid)
        const borderColor = randColor()
        const textColor = randTextColor()
        const bgColor = '#f0f2f5'

        const fontDir = resourceDir
        const img = await puppeteer.screenshot('box', {
          tplFile: path.join(fontDir, 'template.html'),
          avatarUrl: avatarDataUrl || '',
          display: lines,
          borderColor,
          textColor,
          bgColor,
          labelColor: '#888',
          fontDir,
        })

        if (img) {
          if (_cfg.recall_time > 0) {
            e.reply(img, false, { recallMsg: _cfg.recall_time })
          } else {
            e.reply(img)
          }
        } else {
          e.reply(lines.join('\n'))
        }
      } catch (err) {
        logger.error(`开盒失败: ${err}`)
        e.reply(`开盒失败：${err.message || err}`)
      }
    }

    return true
  }

  getTargets(e) {
    const ats = e.message.filter(m => m.type === 'at').map(m => String(m.qq)).filter(Boolean)
    if (ats.length) return ats
    if (e.at) return [String(e.at)]
    return [String(e.user_id)]
  }
}

export class autoBox extends plugin {
  constructor() {
    super({
      name: '自动开盒',
      event: 'notice.group.increase',
      priority: 5000,
    })
  }

  async accept(e) {
    const _cfg = getCfg()
    const uid = String(e.user_id)
    if (uid === String(e.self_id)) return false
    if (!e.group_id) return false
    const gid = String(e.group_id)
    if (_cfg.autobox.white_groups.length && !_cfg.autobox.white_groups.includes(gid)) return false
    if (!_cfg.autobox.enter) return false
    if (_cfg.protect_ids.includes(uid)) return false

    try {
      const sInfo = await e.bot.sendApi('get_stranger_info', { user_id: Number(uid), no_cache: true })
      let mInfo = {}
      try {
        mInfo = await e.bot.sendApi('get_group_member_info', { user_id: Number(uid), group_id: Number(e.group_id) })
      } catch {}

      const lines = transformFields(sInfo, mInfo)
      if (!lines.length) return false

      const avatarDataUrl = await getAvatar(uid)
      const fontDir = resourceDir
      const img = await puppeteer.screenshot('box', {
        tplFile: path.join(fontDir, 'template.html'),
        avatarUrl: avatarDataUrl || '',
        display: lines,
        borderColor: randColor(),
        textColor: randTextColor(),
        bgColor: '#f0f2f5',
        labelColor: '#888',
        fontDir,
      })

      if (img) {
        if (_cfg.recall_time > 0) {
          e.reply(img, false, { recallMsg: _cfg.recall_time })
        } else {
          e.reply(img)
        }
      } else {
        e.reply(lines.join('\n'))
      }

      return true
    } catch (err) {
      logger.error(`自动开盒失败: ${err}`)
      return false
    }
  }
}

export class autoBoxExit extends plugin {
  constructor() {
    super({
      name: '自动开盒退群',
      event: 'notice.group.decrease',
      priority: 5000,
    })
  }

  async accept(e) {
    const _cfg = getCfg()
    const uid = String(e.user_id)
    if (uid === String(e.self_id)) return false
    if (!e.group_id) return false
    const gid = String(e.group_id)
    if (_cfg.autobox.white_groups.length && !_cfg.autobox.white_groups.includes(gid)) return false
    if (!_cfg.autobox.exit) return false
    if (_cfg.protect_ids.includes(uid)) return false

    try {
      const sInfo = await e.bot.sendApi('get_stranger_info', { user_id: Number(uid), no_cache: true })
      let mInfo = {}
      const lines = transformFields(sInfo, mInfo)
      if (!lines.length) return false

      const avatarDataUrl = await getAvatar(uid)
      const fontDir = resourceDir
      const img = await puppeteer.screenshot('box', {
        tplFile: path.join(fontDir, 'template.html'),
        avatarUrl: avatarDataUrl || '',
        display: lines,
        borderColor: randColor(),
        textColor: randTextColor(),
        bgColor: '#f0f2f5',
        labelColor: '#888',
        fontDir,
      })

      if (img) {
        if (_cfg.recall_time > 0) {
          e.reply(img, false, { recallMsg: _cfg.recall_time })
        } else {
          e.reply(img)
        }
      } else {
        e.reply(lines.join('\n'))
      }

      return true
    } catch (err) {
      logger.error(`自动开盒退群失败: ${err}`)
      return false
    }
  }
}
