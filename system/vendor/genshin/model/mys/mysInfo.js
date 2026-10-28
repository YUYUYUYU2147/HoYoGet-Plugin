/**
 * 内置的 mysInfo 兼容实现。
 *
 * 背景：genshin 的 model/mys/mysInfo.js 长期被本插件的账本、角色资料、抽卡
 * 记录等功能引用。未安装 genshin 时这些功能整块不可用。这里按实际调用面
 * 提供同名静态/实例方法，数据请求全部由本插件自己的能力完成：
 *
 *   · 请求出口 system/mhy_fetch.js（含风控代理兜底）
 *   · 请求头与 DS 签名 system/mhy.js（含设备指纹）
 *   · 记录类接口 system/api.js（与本插件其它功能同一套实现）
 *   · Cookie：本地存档里只有 stoken 时，在线换取 ltoken + cookie_token
 *
 * 覆盖的调用面：
 *   MysInfo.get(e, 'ledger' | 'index' | 'basicInfo', params, opts)
 *   MysInfo.init(e, api) -> { uid, ckInfo: { ck, ltuid } }
 *   new MysInfo(e) / .uid / .getCookie(game)
 *   MysInfo.getUid(e) / getSelfUid(e) / initCache() / initUserCk() / initPubCk()
 */
import mhy from '../../../../mhy.js'
import api from '../../../../api.js'
import { mhyFetch } from '../../../../mhy_fetch.js'
import { getAccount, listAccounts, saveAccount } from '../../../../ck_store.js'
import NoteUser from './NoteUser.js'

/** 三个游戏的账本端点（2026-10 实测可用） */
const LEDGER_API = {
    gs: {
        url: 'https://hk4e-api.mihoyo.com/event/ys_ledger/monthInfo',
        // 原神札记的 month 是「几月」，参数名是 bind_uid / bind_region
        query: (uid, server, m) => 'month=' + m.month + '&bind_uid=' + uid + '&bind_region=' + server,
    },
    sr: {
        // 必须走 api-takumi；换成 api-takumi-record 会直接连接失败
        url: 'https://api-takumi.mihoyo.com/event/srledger/month_info',
        query: (uid, server, m) => 'lang=zh-cn&region=' + server + '&uid=' + uid + '&month=' + m.ym,
    },
    zzz: {
        url: 'https://act-nap-api.mihoyo.com/event/nap_ledger/month_info',
        query: (uid, server, m) => 'lang=zh-cn&uid=' + uid + '&region=' + server + '&month=' + m.ym,
    },
}

/** 换出的 Cookie 在进程内缓存，避免每个指令都打一次通行证接口 */
const CK_TTL = 30 * 60 * 1000
const ckCache = new Map()

/**
 * 解析米游社响应。
 *
 * 被风控拦下时返回的是 HTML 阻断页，部分接口还会在 JSON 后面追加内容，
 * 直接 JSON.parse 会抛语法错误。这里先按整体解析，失败再截取首尾大括号重试。
 */
function parseJson(text) {
    const raw = String(text || '')
    try {
        return JSON.parse(raw)
    } catch { /* 继续尝试裁剪 */ }
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start >= 0 && end > start) {
        try {
            return JSON.parse(raw.slice(start, end + 1))
        } catch { /* 落到统一错误 */ }
    }
    return { retcode: -500, message: '接口返回非 JSON（疑似被风控拦截）' }
}

/** 能直接用于 record / ledger 的 Cookie 必须同时含 ltoken 与 cookie_token */
function usableCk(ck) {
    const s = String(ck || '')
    return /ltoken=/.test(s) && /cookie_token=/.test(s)
}

/** 账本接口认 v1 Cookie，缺 account_id 会被判「未登录」 */
function ledgerCookie(ck, ltuid) {
    let out = String(ck || '').trim()
    if (!out) return ''
    if (ltuid && !/(^|;\s*)account_id=/.test(out)) {
        out = out.replace(/;\s*$/, '') + '; account_id=' + ltuid + ';'
    }
    return out
}

/** 月份参数归一：原神用 1~12，星铁/绝区零用 YYYYMM */
function normalizeMonth(game, input) {
    const now = new Date()
    if (game === 'gs') {
        const n = Number(input)
        if (Number.isInteger(n) && n >= 1 && n <= 12) return { month: n }
        return { month: now.getMonth() + 1 }
    }
    const s = String(input || '')
    if (/^\d{6}$/.test(s)) return { ym: s }
    const n = Number(s)
    if (Number.isInteger(n) && n >= 1 && n <= 12) {
        return { ym: `${now.getFullYear()}${String(n).padStart(2, '0')}` }
    }
    return { ym: `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}` }
}

/**
 * 取某个 QQ 在指定游戏下的账号条目。
 * 指定 uid 时优先精确匹配；否则退化为该游戏的第一条绑定。
 */
function pickAccount(qq, game, uid) {
    if (!qq) return null
    if (uid) {
        const exact = getAccount(qq, uid)
        if (exact && (exact.ck_stoken || exact.stoken)) return exact
    }
    let rows = []
    try {
        rows = listAccounts({ qq, game })
    } catch {
        return null
    }
    for (const row of rows) {
        const acc = getAccount(qq, row.uid)
        if (acc && (acc.ck_stoken || acc.stoken)) return acc
    }
    return null
}

/**
 * 保证拿到可用的 Cookie。
 *
 * 扫码登录存档里常见只有 stoken（ck_stoken 里是 stuid/stoken/mid），
 * 这种串过不了 record 与账本接口。此时用 stoken 在线换 ltoken 与
 * cookie_token，换到后写回存档，后续请求直接复用。
 */
async function ensureCookie(e, acc) {
    const raw = String(acc?.ck_stoken || '')
    if (usableCk(raw)) return raw

    const stoken = String(acc?.stoken || '')
    const stuid = String(acc?.stuid || '')
    if (!stoken || !stuid) return raw

    const cached = ckCache.get(stuid)
    if (cached && Date.now() - cached.time < CK_TTL) return cached.ck

    const mid = String(acc?.mid || '')
    const baseCookie = `stuid=${stuid};stoken=${stoken};mid=${mid}`
    const headers = { ...mhy.getHeaders(e, baseCookie, false), Cookie: baseCookie }

    let ltoken = ''
    let cookieToken = ''
    let ltuid = stuid
    try {
        const r1 = await mhyFetch('https://passport-api.mihoyo.com/account/auth/api/getLTokenBySToken', {
            method: 'GET',
            headers,
        }).then(r => r.json())
        ltoken = String(r1?.data?.ltoken || '')
        const r2 = await mhyFetch(
            `https://api-takumi.mihoyo.com/auth/api/getCookieAccountInfoBySToken?stoken=${stoken}&uid=${stuid}`,
            { method: 'GET', headers }
        ).then(r => r.json())
        cookieToken = String(r2?.data?.cookie_token || '')
        if (r2?.data?.uid) ltuid = String(r2.data.uid)
    } catch (err) {
        globalThis.logger?.debug?.(`[HoYoGet][mys] 换取 Cookie 失败: ${err?.message || err}`)
    }

    if (!ltoken || !cookieToken) return raw

    const ck = `ltoken=${ltoken};ltuid=${ltuid};cookie_token=${cookieToken};stuid=${ltuid};mid=${mid}`
    ckCache.set(stuid, { ck, time: Date.now() })
    try {
        saveAccount(acc.qq, acc.uid, { ck })
    } catch {
        /* 写盘失败只影响下次复用，不影响本次查询 */
    }
    return ck
}

async function ledger(e, game, uid, ck, ltuid, monthInput) {
    const ep = LEDGER_API[game]
    if (!ep) return { retcode: -1, message: `暂不支持 ${game} 的月报查询` }
    const server = mhy.getServer(String(uid), game)
    const m = normalizeMonth(game, monthInput)
    const query = ep.query(String(uid), server, m)
    const dev = mhy.getHeaders(e, ck)
    const headers = {
        Cookie: ledgerCookie(ck, ltuid),
        DS: mhy.getDs2(query, '', '4'),
        'x-rpc-client_type': '5',
        'x-rpc-app_version': '2.40.1',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.73 Mobile Safari/537.36 miHoYoBBS/2.40.1',
        Origin: 'https://webstatic.mihoyo.com',
        Referer: 'https://webstatic.mihoyo.com/',
        'x-rpc-device_id': dev['x-rpc-device_id'],
        'x-rpc-device_fp': dev['x-rpc-device_fp'],
        'x-rpc-device_model': dev['x-rpc-device_model'],
    }
    try {
        const resp = await mhyFetch(ep.url + '?' + query, { method: 'GET', headers })
        return parseJson(await resp.text())
    } catch (err) {
        return { retcode: -500, message: '账本请求失败: ' + (err?.message || err) }
    }
}

/** 星铁基础信息：昵称只在 basicInfo 里，index 不带 */
async function srBasicInfo(e, uid, ck) {
    const server = mhy.getServer(String(uid), 'sr')
    const url = `https://api-takumi-record.mihoyo.com/game_record/app/hkrpg/api/basicInfo?role_id=${uid}&server=${server}`
    try {
        const resp = await mhyFetch(url, { method: 'GET', headers: mhy.getHeaders(e, ck) })
        return parseJson(await resp.text())
    } catch (err) {
        return { retcode: -500, message: '基础信息请求失败: ' + (err?.message || err) }
    }
}

export default class MysInfo {
    constructor(e) {
        this.e = e
        this.uid = ''
        this.ckInfo = { ck: '', uid: '', qq: String(e?.user_id || ''), ltuid: '', type: '' }
    }

    /** 取当前 QQ 在指定游戏下可用的 Cookie（必要时在线换取） */
    async getCookie(game = 'gs') {
        const acc = pickAccount(this.e?.user_id, game, this.uid)
        if (!acc) return ''
        return await ensureCookie(this.e, acc)
    }

    /**
     * 发起一次查询，返回米游社原始响应（含 retcode）。
     * @param {object} e 事件对象
     * @param {'ledger'|'index'|'basicInfo'} type 接口名
     * @param {object} params 附加参数，headers 会并入请求头
     * @param {{log?:boolean, game?:string, uid?:string|number}} opts
     */
    static async get(e, type, params = {}, opts = {}) {
        const game = opts.game || e?.game || (e?.isSr ? 'sr' : 'gs')
        const qq = e?.user_id
        const user = await NoteUser.create(qq)
        const uid = String(opts.uid || e?.uid || user?.getUid(game) || '')
        if (!uid) return { retcode: -1, message: '未找到该游戏绑定的 UID，请先绑定' }
        const acc = pickAccount(qq, game, uid)
        if (!acc) return { retcode: -1, message: '未找到该游戏的绑定记录，请先扫码绑定' }
        const ck = await ensureCookie(e, acc)
        if (!usableCk(ck)) return { retcode: -1, message: 'Cookie 已失效，请重新扫码绑定' }

        if (type === 'ledger') return ledger(e, game, uid, ck, acc.stuid || '', params?.month)
        if (type === 'basicInfo') return srBasicInfo(e, uid, ck)

        // index 走本插件自己的 api()，与其它功能共用设备指纹与代理兜底
        const res = await api(e, {
            type: `${game}_index`,
            uid,
            game,
            server: mhy.getServer(uid, game),
            headers: { ...mhy.getHeaders(e, ck), ...(params?.headers || {}) },
            silent: true,
        })
        // api() 在 silent 模式下出错会返回字符串或 true，统一折成带 retcode 的对象，
        // 调用方只需判断 retcode 即可
        if (!res || typeof res !== 'object' || typeof res.retcode !== 'number') {
            return { retcode: -1, message: typeof res === 'string' ? res : '米游社接口返回异常' }
        }
        return res
    }

    /**
     * 初始化一份查询上下文。
     * @returns {Promise<false|{uid:string, ckInfo:{ck:string, uid:string, ltuid:string}, game:string}>}
     */
    static async init(e, type = '') {
        const game = e?.game || (e?.isSr ? 'sr' : 'gs')
        const user = await NoteUser.create(e)
        const uid = String(e?.uid || user?.getUid(game) || '')
        if (!uid) {
            if (!e?.noTips) e.noTips = true
            return false
        }
        const acc = pickAccount(e?.user_id, game, uid)
        if (!acc) {
            if (!e?.noTips) e.noTips = true
            return false
        }
        const ck = await ensureCookie(e, acc)
        if (!usableCk(ck)) {
            if (!e?.noTips) e.noTips = true
            return false
        }
        return {
            uid,
            game,
            ckInfo: {
                ck,
                uid,
                qq: String(e?.user_id || ''),
                ltuid: acc.stuid || '',
                type,
            },
        }
    }

    /** 取该 QQ 在当前游戏下的 UID */
    static async getUid(e) {
        const game = e?.game || (e?.isSr ? 'sr' : 'gs')
        const user = await NoteUser.create(e)
        return String(e?.uid || user?.getUid(game) || '')
    }

    /** 需要本人 Cookie 的接口用同一个 UID 取值逻辑 */
    static async getSelfUid(e) {
        return MysInfo.getUid(e)
    }

    /* 以下三个是旧调用方保留的初始化钩子：内置实现无共享缓存与公共 CK 池，
       保持空实现以免调用处抛 TypeError。 */
    static async initCache() { }

    static async initUserCk() { }

    static async initPubCk() { }
}
