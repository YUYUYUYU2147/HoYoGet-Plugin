/**
 * 绝区零挑战记录：式舆防卫战 / 危局强袭战
 *
 *   %式舆防卫战        （也认：式舆 / 深渊 / 防卫战 / 防卫 / 上期 / 往期）
 *   %危局强袭战        （也认：危局 / 强袭 / 强袭战 / 上期 / 往期）
 *
 * 模板直接用 ZZZ-Plugin 里现成的那两套页面（作者自写，已复制到
 * resources/zzz_challenge/，只改了资源前缀），所以观感与 ZZZ-Plugin 完全一致。
 * 取数复用 zzz_panel_list 的 CK/服务器/接口封装，归一化在 system/zzz_challenge.js。
 * 优先级必须高于 ZZZ-Plugin（-30000）才抢得到指令。
 */
import { pluginPriority, render } from '#HoYoGet'
import { normalizeShiyu, normalizeDeadly } from '../../system/zzz_challenge.js'
import { saveChallengeRecord, listChallengeRecords, readChallengeRecord } from '../../system/zzz_challenge_history.js'
import { zzz_panel_list } from './zzz_panel_list.js'
import { segment } from 'oicq'
import fs from 'node:fs'
import sharp from '../../node_modules/sharp/lib/index.js'

export class zzz_challenge extends zzz_panel_list {
  constructor() {
    super()
    this.name = '[米哈游]绝区零挑战'
    this.dsc = '绝区零式舆防卫战 / 危局强袭战记录'
    // 压过 ZZZ-Plugin 的 abyss/deadly（默认 70，桥接 -30000）
    this.priority = pluginPriority('zzz_challenge', -37000)
    /* 父类构造会注册「挑战提醒」定时任务；这里只复用它的取数方法，不能再挂一份。
       必须是**空数组**：框架 collectTask 会对 task 做 [task] 展开再读 i.cron，
       null / undefined 都会抛 TypeError，进而让整个插件加载失败。 */
    this.task = []
    this.rule = [
      { reg: /^#?(?:%|％|绝区零|米游社)?\s*(上期|往期)?\s*(深渊)\s*(\d+)?$/i.source, fnc: 'both' },
      { reg: /^#?(?:%|％|绝区零|米游社)?\s*(上期|往期)?\s*(式舆防卫战|式舆|防卫战|防卫)\s*(\d+)?$/i.source, fnc: 'shiyu' },
      { reg: /^#?(?:%|％|绝区零|米游社)?\s*(上期|往期)?\s*(危局强袭战|危局|强袭|强袭战)\s*(\d+)?$/i.source, fnc: 'deadly' },
      { reg: /^#?(?:%|％|绝区零|米游社)?\s*(式舆防卫战|式舆|防卫战|防卫)\s*排名$/i.source, fnc: 'shiyuRank' },
      { reg: /^#?(?:%|％|绝区零|米游社)?\s*(危局强袭战|危局|强袭|强袭战)\s*排名$/i.source, fnc: 'deadlyRank' },
      { reg: /^(?:米游社|%|#?绝区零)?清理失效ck$/i.source, fnc: 'cleanInvalidCk' },
      { reg: /^(?:米游社|%|#?绝区零)?刷新群友(ck|cookie)$/i.source, fnc: 'refreshGroupCk' },
      { reg: /^#?(?:%|％|绝区零|米游社)?\s*(深渊)\s*排名$/i.source, fnc: 'bothRank' },
    ]
  }

  /** 挑战相关指令在 accept 阶段直接接管，避免被角色榜的 accept 截走 */
  async accept(e) {
    const msg = String((e && e.msg) || '')
    if (/深渊\s*排名/.test(msg)) {
      this.e = e
      await this.bothRank(e)
      return 'return'
    }
    return super.accept ? super.accept(e) : false
  }

  /** 拆「上期/往期」标记：返回 { kind, index }，kind = cur/prev/history */
  parsePrev(msg) {
    const s = String(msg || '').trim()
    const isHistory = /往期/.test(s)
    const isPrev = /上期/.test(s)
    if (!isHistory && !isPrev) return { kind: 'cur', index: null }
    const idx = s.match(/(\d+)\s*$/)?.[1]
    return {
      kind: isHistory ? 'history' : 'prev',
      index: idx != null ? Number(idx) : null,
    }
  }

  /** 统一取数：uid / ck / 玩家信息 */
  async prepare(e) {
    const uid = this.getZzzUid(e)
    if (!uid) return { error: '请先绑定绝区零账号（#米哈游扫码绑定 或 %绑定你的UID）' }
    const ck = await this.getCk(e, uid)
    if (!ck || !Object.values(ck).some(item => item?.ck)) {
      return { error: '尚未绑定 cookie，请先绑定 cookie 或 #扫码登录' }
    }
    let player = null
    try { player = await this.fetchPlayer(e, uid, ck) } catch { /* 取不到昵称就留空 */ }
    return { uid, ck, player: player || {} }
  }

  /** 式舆防卫战 */
  async shiyu(e) {
    const { error, uid, ck, player } = await this.prepare(e)
    if (error) return e.reply(error)
    const { kind, index } = this.parsePrev(e.msg)

    // 往期：先列历史，或按序号读某期
    if (kind === 'history') {
      return this.showHistory(e, uid, 'shiyu', '式舆防卫战', index)
    }

    const prev = kind === 'prev'

    let raw
    try {
      raw = prev
        ? await this.zzzGetRaw(e, uid, ck, 'challenge', await this.challengeQuery(e, uid, ck))
        : await this.zzzRemindFetch(e, uid, ck, 'challenge')
    } catch (err) {
      return e.reply(`式舆防卫战查询失败：${err?.message || err}`)
    }

    const data = await normalizeShiyu(raw, {
      uid, nickname: player?.nickname, avatar: player?.avatar, periodOffset: prev ? -1 : 0,
    })
    if (data.empty) return e.reply('没有查到式舆防卫战数据，可能是本期还没打，或面板未公开。')

    // 落盘历史（往期查询时也能看到当期/上期）
    if (data.period) saveChallengeRecord(uid, 'shiyu', data.period, data)

    return render('zzz_challenge/challenge', { ...data, footer: 'from 米哈游' }, { e, ret: true, dsf: 2.4 })
  }

  /** 危局强袭战 */
  async deadly(e) {
    const { error, uid, ck, player } = await this.prepare(e)
    if (error) return e.reply(error)
    const { kind, index } = this.parsePrev(e.msg)

    if (kind === 'history') {
      return this.showHistory(e, uid, 'deadly', '危局强袭战', index)
    }

    const prev = kind === 'prev'

    let raw
    try {
      raw = prev
        ? await this.zzzGetRaw(e, uid, ck, 'deadly', await this.deadlyQuery(e, uid, ck))
        : await this.zzzRemindFetch(e, uid, ck, 'deadly')
    } catch (err) {
      return e.reply(`危局强袭战查询失败：${err?.message || err}`)
    }
    if (!raw?.has_data) return e.reply('没有危局强袭战数据，可能是本期还没打。')

    const data = await normalizeDeadly(raw, { uid, nickname: player?.nickname, avatar: player?.avatar })
    if (data.empty) return e.reply('没有查到危局强袭战数据。')

    if (data.period) saveChallengeRecord(uid, 'deadly', data.period, data)

    return render('zzz_challenge/deadly', { ...data, footer: 'from 米哈游' }, { e, ret: true, dsf: 2.4 })
  }

  /** 式舆防卫战 + 危局强袭战：左右拼成一张图 */
  async both(e) {
    const { error, uid, ck, player } = await this.prepare(e)
    if (error) return e.reply(error)
    const { kind, index } = this.parsePrev(e.msg)
    if (kind === 'history') {
      return e.reply(`「深渊」合并图不支持往期回看，请分开查询：\n往期式舆防卫战${index ? ' ' + index : ''}\n往期危局强袭战${index ? ' ' + index : ''}`)
    }
    const prev = kind === 'prev'
    const meta = { uid, nickname: player?.nickname, avatar: player?.avatar }

    const loadShiyu = async () => {
      try {
        const raw = prev
          ? await this.zzzGetRaw(e, uid, ck, 'challenge', await this.challengeQuery(e, uid, ck))
          : await this.zzzRemindFetch(e, uid, ck, 'challenge')
        const d = await normalizeShiyu(raw, { ...meta, periodOffset: prev ? -1 : 0 })
        if (!d || d.empty) return null
        if (d.period) saveChallengeRecord(uid, 'shiyu', d.period, d)
        return d
      } catch { return null }
    }
    const loadDeadly = async () => {
      try {
        const raw = prev
          ? await this.zzzGetRaw(e, uid, ck, 'deadly', await this.deadlyQuery(e, uid, ck))
          : await this.zzzRemindFetch(e, uid, ck, 'deadly')
        if (!raw?.has_data) return null
        const d = await normalizeDeadly(raw, meta)
        if (!d || d.empty) return null
        if (d.period) saveChallengeRecord(uid, 'deadly', d.period, d)
        return d
      } catch { return null }
    }

    const [shiyuData, deadlyData] = await Promise.all([loadShiyu(), loadDeadly()])
    if (!shiyuData && !deadlyData) return e.reply('没查到式舆防卫战与危局强袭战数据，可能是本期还没打。')

    const jobs = []
    if (shiyuData) jobs.push(['zzz_challenge/challenge', shiyuData])
    if (deadlyData) jobs.push(['zzz_challenge/deadly', deadlyData])

    const bufs = []
    for (const [tpl, data] of jobs) {
      const b64 = await render(tpl, { ...data, footer: '' }, { e, ret: false, dsf: 2.4 })
      if (!b64) continue
      const toBuf = (v, d = 0) => {
        if (!v || d > 4) return null
        if (Buffer.isBuffer(v)) return v
        if (v instanceof Uint8Array) return Buffer.from(v)
        if (Array.isArray(v.data) && (v.type === 'Buffer' || v.type === 'Uint8Array')) return Buffer.from(v.data)
        if (v.data instanceof Uint8Array) return Buffer.from(v.data)
        for (const k of ['file', 'data', 'buffer', 'img']) {
          const r = toBuf(v[k], d + 1)
          if (r && r.length) return r
        }
        return null
      }
      let buf = null
      if (typeof b64 === 'string') {
        const str = b64
        if (/^base64:\/\//i.test(str)) buf = Buffer.from(str.replace(/^base64:\/\//i, ''), 'base64')
        else if (/^data:image\//i.test(str)) buf = Buffer.from(str.split(',')[1] || '', 'base64')
        else if (/^https?:\/\//i.test(str)) buf = Buffer.from(await (await fetch(str)).arrayBuffer())
        else if (/^file:\/\//i.test(str)) buf = fs.readFileSync(new URL(str))
        else if (fs.existsSync(str)) buf = fs.readFileSync(str)
        else buf = Buffer.from(str, 'base64')
      } else {
        buf = toBuf(b64)
      }
      const head = buf && buf.length >= 4 ? buf.subarray(0, 4).toString('latin1') : ''
      if (!buf || !buf.length || !(/^\x89PNG/.test(head) || /^\xFF\xD8/.test(head) || /^RIFF/.test(head))) {
        logger.debug?.(`[HoYoGet][zzz_challenge] 渲染结果不是图片 json=${JSON.stringify(b64 || {}).slice(0, 120)}`)
        continue
      }
      bufs.push(buf)
    }
    if (!bufs.length) return e.reply('出图失败，请稍后重试。')
    if (bufs.length === 1) return e.reply(segment.image(bufs[0]))

        const metas = await Promise.all(bufs.map(b2 => sharp(b2).metadata()))
    const gap = 24
    const width = metas.reduce((sum, m) => sum + (m.width || 0), 0) + gap * (bufs.length - 1)
    const contentH = Math.max(...metas.map(m => m.height || 0))
    const fsTip = Math.max(16, Math.round(width * 0.013))
    const fsFrom = Math.max(14, Math.round(fsTip * 0.85))
    const stripH = Math.round(fsTip * 3.2)
    const height = contentH + stripH
    const composite = []
    let left = 0
    bufs.forEach((b2, idx) => {
      const w = metas[idx].width || 0
      const h = metas[idx].height || 0
      composite.push({ input: b2, left, top: Math.round((contentH - h) / 2) })
      left += w + gap
    })
    const cx = Math.round(width / 2)
    const fontStack = 'Noto Sans CJK SC, Noto Sans SC, Source Han Sans SC, WenQuanYi Micro Hei, Microsoft YaHei, sans-serif'
    const strip = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${stripH}">` +
      `<text x="${cx}" y="${Math.round(stripH * 0.42)}" text-anchor="middle" font-size="${fsTip}" fill="#8b93a7" font-family="${fontStack}">* 总得分与排名并非即时刷新，挑战详情存在约2小时延迟</text>` +
      `<text x="${cx}" y="${Math.round(stripH * 0.8)}" text-anchor="middle" font-size="${fsFrom}" fill="#ff4d4f" font-family="${fontStack}">from 米哈游</text>` +
      `</svg>`
    )
    composite.push({ input: strip, left: 0, top: contentH })
    const out = await sharp({ create: { width, height, channels: 4, background: { r: 20, g: 22, b: 34, alpha: 1 } } })
      .composite(composite).png().toBuffer()
    return e.reply(segment.image(out))
  }

  /** 主人专用：触发每个账号的 CK 自动刷新（复用 getCk 内部的 Stoken 刷新） */
  async refreshGroupCk(e) {
    if (!e.isMaster) return e.reply('仅主人可操作')
    const { listAccounts } = await import('../../system/ck_store.js')
    const accounts = listAccounts({ game: 'zzz' })
    if (!accounts.length) return e.reply('没有任何绝区零绑定。')

    let memberSet = null
    if (e.isGroup) {
      try {
        const map = await e.group.getMemberMap()
        memberSet = new Set([...map.keys()].map(String))
      } catch { memberSet = null }
    }
    const targets = memberSet ? accounts.filter(a => memberSet.has(String(a.qq))) : accounts
    if (!targets.length) return e.reply('本群没有已绑定的绝区零账号。')

    await e.reply(`开始刷新 ${targets.length} 个绝区零账号的 CK，逐个请求会限速，请稍候…`)
    const done = []
    const fail = []
    for (const a of targets) {
      const mock = { user_id: Number(a.qq), game: 'zzz', reply: () => {} }
      try {
        const ck = await this.getCk(mock, a.uid)
        if (ck && Object.values(ck).some(i => i && i.ck)) done.push({ qq: a.qq, uid: a.uid })
        else fail.push({ qq: a.qq, uid: a.uid, reason: 'CK 不可用' })
      } catch (err) {
        fail.push({ qq: a.qq, uid: a.uid, reason: String((err && err.message) || err).slice(0, 40) })
      }
      await new Promise(r => setTimeout(r, 1200))
    }

    const lines = [`CK 刷新完成：成功 ${done.length} 个，失败 ${fail.length} 个。`]
    if (done.length) {
      lines.push('', '成功：')
      for (const d of done.slice(0, 10)) lines.push(`  ${d.qq} → ${d.uid}`)
      if (done.length > 10) lines.push(`  ……另有 ${done.length - 10} 个`)
    }
    if (fail.length) {
      lines.push('', '失败（需重新 #米哈游扫码登录）：')
      for (const f of fail.slice(0, 10)) lines.push(`  ${f.qq} → ${f.uid}：${f.reason}`)
      if (fail.length > 10) lines.push(`  ……另有 ${fail.length - 10} 个`)
    }
    return e.reply(lines.join(String.fromCharCode(10)))
  }

  /** 主人专用：实测 CK 有效性，只删除确认失效（-100/-101/-111/10001）的绑定 */
  async cleanInvalidCk(e) {
    if (!e.isMaster) return e.reply('仅主人可操作')
    const { listAccounts, deleteAccount } = await import('../../system/ck_store.js')
    const accounts = listAccounts({ game: 'zzz' })
    if (!accounts.length) return e.reply('没有任何绝区零绑定。')

    let memberSet = null
    if (e.isGroup) {
      try {
        const map = await e.group.getMemberMap()
        memberSet = new Set([...map.keys()].map(String))
      } catch { memberSet = null }
    }
    const targets = memberSet ? accounts.filter(a => memberSet.has(String(a.qq))) : accounts
    if (!targets.length) return e.reply('本群没有已绑定的绝区零账号。')

    await e.reply(`开始检测 ${targets.length} 个绝区零绑定的 CK，逐个请求会限速，请稍候…`)
    const dead = []
    const soft = []
    let good = 0
    for (const a of targets) {
      const mock = { user_id: Number(a.qq), game: 'zzz', reply: () => {} }
      let reason = ''
      try {
        const ck = await this.getCk(mock, a.uid)
        if (!ck || !Object.values(ck).some(i => i && i.ck)) {
          reason = '无可用 CK'
        } else {
          await this.zzzRemindFetch(mock, a.uid, ck, 'challenge')
        }
      } catch (err) {
        reason = String((err && err.message) || err).slice(0, 40)
      }
      if (!reason) good++
      else if (/CK 失效|未登录|-100|-101|-111|10001/.test(reason)) dead.push({ qq: a.qq, uid: a.uid, reason })
      else soft.push({ qq: a.qq, uid: a.uid, reason })
      await new Promise(r => setTimeout(r, 1200))
    }

    const removed = []
    for (const d of dead) {
      try {
        deleteAccount(d.qq, d.uid)
        removed.push(d)
      } catch { /* 删除失败时保留记录 */ }
    }

    const lines = [`CK 检测完成：有效 ${good} 个，确认失效 ${dead.length} 个，已删除 ${removed.length} 个。`]
    if (removed.length) {
      lines.push('', '已删除（需重新扫码绑定）：')
      for (const r of removed.slice(0, 10)) lines.push(`  ${r.qq} → ${r.uid}：${r.reason}`)
      if (removed.length > 10) lines.push(`  ……另有 ${removed.length - 10} 个`)
    }
    if (soft.length) {
      lines.push('', '未删除（非 CK 失效，可能是未打或网络问题）：')
      for (const r of soft.slice(0, 8)) lines.push(`  ${r.qq} → ${r.uid}：${r.reason}`)
    }
    return e.reply(lines.join('\n'))
  }

  /** 式舆防卫战排名：读本插件存档，按总得分排序出图 */
  async shiyuRank(e) {
    return this.challengeRank(e, 'shiyu')
  }

  /** 危局强袭战排名 */
  async deadlyRank(e) {
    return this.challengeRank(e, 'deadly')
  }

  /** 组装排名数据，无可用数据返回 null */
  async buildRankData(type) {
    const rankClass = v => {
      const t = String(v || '').toUpperCase()
      return t ? t.replace('+', 'P') : 'A'
    }
    const isShiyu = type === 'shiyu'
    const { listLatestRecords } = await import('../../system/zzz_challenge_history.js')
    const rows = listLatestRecords(type)
    if (!rows.length) return null
    const scoreOf = d => Number(isShiyu ? (d.brief && d.brief.score) || 0 : d.total_score || 0)
    const rated = rows
      .filter(r => scoreOf(r.data || {}) > 0)
      .sort((a, b) => scoreOf(b.data || {}) - scoreOf(a.data || {}) || String(a.savedAt).localeCompare(String(b.savedAt)))
      .slice(0, 30)
    if (!rated.length) return null

    const scoredData = rated.map(r => {
      const d = r.data || {}
      const score = scoreOf(d)
      const who = {
        avatar: d.avatar_icon || '',
        player: {
          nickname: d.nickname || String(r.uid),
          level: d.level || '',
          region_name: '',
          game_uid: r.uid,
        },
      }
      if (isShiyu) {
        const brief = d.brief || {}
        const layer = (d.layers || []).slice(-1)[0]
        const infos = (layer && layer.data && layer.data.layer_challenge_info_list) || []
        return {
          player: who,
          score: { score, maxScore: score === 150000 ? 150000 : 0, ratingClass: rankClass(brief.rating || d.brief_rating) },
          stages: infos.slice(0, 3).map(it => ({
            title: (it.buffer && it.buffer.title) || '',
            score: Number(it.score || 0),
            maxScore: Number(it.score) === 50000 ? 50000 : 0,
            ratingClass: rankClass(it.rating),
            avatars: (it.avatar_list || []).slice(0, 3),
            buddy: it.buddy || null,
          })),
        }
      }
      return {
        player: who,
        score: { score, maxScore: 0, ratingClass: rankClass(d.brief_rating) },
        stages: (d.list || []).slice(0, 3).map((it, i) => ({
          title: '第' + (i + 1) + '队',
          score: Number(it.score || 0),
          maxScore: 0,
          ratingClass: rankClass(it.rating),
          avatars: (it.avatars || []).slice(0, 3),
          buddy: it.buddy || null,
        })),
      }
    })

    return {
      titleEn: isShiyu ? 'ABYSS RANK' : 'DEADLY RANK',
      titleCn: isShiyu ? '式舆防卫战排名' : '危局强袭战排名',
      notes: [],
      scoredData,
    }
  }

  /** 挑战记录排名（存档驱动，不请求接口） */
  async challengeRank(e, type) {
    const data = await this.buildRankData(type)
    if (!data) {
      return e.reply('还没有' + (type === 'shiyu' ? '式舆防卫战' : '危局强袭战') + '记录，请先查询一次。')
    }
    return render('zzz_challenge/rank_zzz/index', { ...data, signature: 'from 米哈游' }, { e, ret: true, dsf: 2 })
  }

  /** 深渊排名：式舆 + 危局两张榜上下拼接 */
  async bothRank(e) {
    const [a, b] = await Promise.all([this.buildRankData('shiyu'), this.buildRankData('deadly')])
    if (!a && !b) return e.reply('还没有挑战记录，请先查询「式舆防卫战」或「危局强袭战」。')
    if (!a || !b) return this.challengeRank(e, a ? 'shiyu' : 'deadly')

    const toBuf = (v, d = 0) => {
      if (!v || d > 5) return null
      if (Buffer.isBuffer(v)) return v
      if (v instanceof Uint8Array) return Buffer.from(v)
      if (typeof v === 'string') {
        if (v.startsWith('base64://')) return Buffer.from(v.slice(9), 'base64')
        if (v.startsWith('data:image/')) return Buffer.from(v.split(',')[1] || '', 'base64')
        if (v.startsWith('file://')) return fs.readFileSync(new URL(v))
        if (fs.existsSync(v)) return fs.readFileSync(v)
        return Buffer.from(v, 'base64')
      }
      if (Array.isArray(v.data) && (v.type === 'Buffer' || v.type === 'Uint8Array')) return Buffer.from(v.data)
      if (v.data instanceof Uint8Array) return Buffer.from(v.data)
      for (const k of ['file', 'data', 'buffer', 'img', 'image']) {
        const r = toBuf(v[k], d + 1)
        if (r && r.length) return r
      }
      return null
    }

    const [r1, r2] = await Promise.all([
      render('zzz_challenge/rank_zzz/index', { ...a, signature: '' }, { e, ret: false, dsf: 2 }),
      render('zzz_challenge/rank_zzz/index', { ...b, signature: 'from 米哈游' }, { e, ret: false, dsf: 2 }),
    ])
    const b1 = toBuf(r1)
    const b2 = toBuf(r2)
    if (!b1 || !b2) return e.reply('出图失败，请稍后重试。')

    const m1 = await sharp(b1).metadata()
    const m2 = await sharp(b2).metadata()
    const w1 = m1.width || 0
    const w2 = m2.width || 0
    const h1 = m1.height || 0
    const width = Math.max(w1, w2)
    const height = h1 + (m2.height || 0)
    const out = await sharp({ create: { width, height, channels: 4, background: { r: 20, g: 22, b: 34, alpha: 1 } } })
      .composite([
        { input: b1, left: Math.round((width - w1) / 2), top: 0 },
        { input: b2, left: Math.round((width - w2) / 2), top: h1 },
      ])
      .png().toBuffer()
    return e.reply(segment.image(out))
  }

  /** 往期历史：无序号列清单，有序号读某期出图 */
  async showHistory(e, uid, type, label, index) {
    const list = listChallengeRecords(uid, type)
    if (!list.length) {
      return e.reply(`还没有「${label}」的历史记录。\n每次查询 ${label}（当期/上期）都会自动存档，多查几期就能用「往期」回看了。`)
    }
    if (index == null) {
      const lines = [
        `绝区零 · ${label}历史记录（共 ${list.length} 期）`,
        '',
        ...list.map((r, i) => `${i + 1}. ${r.period}${r.savedAt ? '　存档于 ' + String(r.savedAt).slice(0, 10) : ''}`),
        '',
        `用法：往期${label} <序号>　例如 往期${label} 1`,
      ]
      return e.reply(lines.join('\n'))
    }
    const rec = readChallengeRecord(uid, type, index - 1)
    if (!rec) return e.reply(`没有第 ${index} 期记录（共 ${list.length} 期）。`)
    const data = rec.data || {}
    const tpl = type === 'shiyu' ? 'zzz_challenge/challenge' : 'zzz_challenge/deadly'
    return render(tpl, { ...data, footer: 'from 米哈游 · 历史记录' }, { e, ret: true, dsf: 2.4 })
  }

  /** 往期查询串（zzzRemindFetch 只封装了当期，往期要自己拼） */
  async challengeQuery(e, uid, ck) {
    const server = await this.pickServer(uid, ck)
    if (!server) throw new Error('未能判断服务器分区')
    return `lang=zh-cn&role_id=${uid}&server=${server}&schedule_type=1`
  }

  async deadlyQuery(e, uid, ck) {
    const server = await this.pickServer(uid, ck)
    if (!server) throw new Error('未能判断服务器分区')
    return `lang=zh-cn&uid=${uid}&region=${server}&schedule_type=1`
  }
}
