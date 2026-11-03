import { api, mhy, render, pluginPriority } from '#HoYoGet';

// genshin 的 NoteUser 必须动态加载：静态 import 在 genshin 缺失或版本变动时会让**整个插件**
// 加载失败（ESM 解析阶段抛 ERR_MODULE_NOT_FOUND，没有 try/catch 兜底）。
import { makeGenshinLoader } from '../../system/genshin_loader.js'
const getNoteUser = makeGenshinLoader('model/mys/NoteUser.js', ['model/mys/NoteUser.js'])

export class zzz extends plugin {
    constructor(e) {
        super({
            name: '[米哈游]绝区零母带',
            dsc: '绝区零母带查询',
            event: 'message',
            priority: pluginPriority('zzz_md', 100),
            rule: [
                {
                    reg: '^#*(绝区零)?(母带|(绝区零|zzz)(存货|存量|囤货))$',
                    fnc: 'md',
                },
            ],
        });
    }

    async md(e) {
        e.reply('正在获取母带，请稍后...', true, { recallMsg: 60 });
        let qq, uid, ck

        if (e.message.length > 1) {
            for (const message of e.message) {
                if (message.type == 'at') {
                    qq = message.qq
                    break
                }
            }
        }

        if (!qq) qq = e.user_id
        let nu = null
        try { nu = await (await getNoteUser()).create(qq) } catch (_) { }
        uid = nu?.getUid("zzz")
        ck = nu?.getMysUser("zzz")?.ck
        ;({ uid, ck } = await resolveZzzCk(e, qq, uid, ck))

        if (!uid || !ck) return e.reply("请先扫码绑定账号！");
        
        //获取headers

        //扫码得到的 ck 只带 stuid，米游社按通行证 uid 识别账号，缺 ltuid 会被判未登录
        const withLtuid = (cookie) => {
            const id = (String(cookie).match(/(?:^|;)\s*stuid=(\d+)/) || [])[1]
            if (!id || /(?:^|;)\s*ltuid=/.test(cookie)) return cookie
            return cookie + (cookie.endsWith(";") ? "" : ";") + "ltuid=" + id + ";"
        }
        ck = withLtuid(ck)
        let headers = mhy.getHeaders(e, ck);

        let data = {
            uid,
            headers,
            game: 'zzz',
            type: 'zzz_md',
        };

        let res = await api(e, data);

        data = res?.data

        // 接口失败时 res.data 可能为 undefined，直接读 .tickets 会抛 TypeError
        if (!data?.tickets) return logger.mark('未找到母带数据')

        let fldp = 0, fl = 0, jmmd = 0, md = 0, bb = 0, level = '未知', name = '未知'
        //昵称与等级：getUserGameRolesByCookie 同时回这两个字段，域名在代理白名单内，
        //直连被风控时会自动改走米游社代理
        try {
            const roleRes = await api(e, {
                type: "zzz_user",
                uid,
                game: "zzz",
                headers: mhy.getHeaders(e, ck),
                silent: true
            })
            const role = roleRes?.data?.list?.find(v => String(v.game_uid) === String(uid))
            if (role) {
                level = role.level || level
                name = role.nickname || name
            }
        } catch (_) { }
        for (let v of data.tickets) {
            if (v.ticket_type == 'GACHA_TICKET_TYPE_RECHARGE_MONOCHROME') fldp = v.ticket_cnt
            else if (v.ticket_type == 'GACHA_TICKET_TYPE_POLYCHROME') fl = v.ticket_cnt
            else if (v.ticket_type == 'GACHA_TICKET_TYPE_ENCRYPTED_MASTER_TAPE') jmmd = v.ticket_cnt
            else if (v.ticket_type == 'GACHA_TICKET_TYPE_MASTER_TAPE') md = v.ticket_cnt
            else if (v.ticket_type == 'GACHA_TICKET_TYPE_BOOPON') bb = v.ticket_cnt
        }

        render('zzz_md/md', {
            fldp, fl, jmmd, md, bb, uid, qq, name, level
        }, { e, ret: true })

        return true
    }





}

/**
 * 统一解析绝区零 ck。
 *
 * 两类机器的 ck 存放位置不同：TRSS 上在 genshin 的 NoteUser，JiuLi 上在 HoYoGet 的 data/Stoken 存档，
 * [刷新ck] 只写后者。这里按 Stoken 优先、现换 ck、20 分钟缓存的顺序取，没有 genshin 时也能走通。
 */
async function resolveZzzCk(e, qq, uid, ck) {
    try {
        const fs = (await import("node:fs")).default
        const YAML = (await import("yaml")).default
        const f = "./plugins/HoYoGet-Plugin/data/Stoken/" + qq + ".yaml"
        if (!fs.existsSync(f)) return { uid, ck }
        const d = YAML.parse(fs.readFileSync(f, "utf8")) || {}
        const list = (Array.isArray(d) ? d : Object.values(d)).filter(v => v && typeof v === "object" && v.uid)
        const same = uid ? list.filter(v => String(v.uid) === String(uid)) : []
        const hit = same.find(v => /nap/.test(String(v.game_biz || ""))) || same[0]
            || list.find(v => /nap/.test(String(v.game_biz || ""))) || null
        if (!hit) return { uid, ck }
        const nextUid = uid || hit.uid
        const key = "zzz:" + qq + ":" + hit.uid
        const cache = (globalThis.__hoyogetAutoCk = globalThis.__hoyogetAutoCk || new Map())
        const old = cache.get(key)
        if (old && Date.now() - old.at < 20 * 60 * 1000) return { uid: nextUid, ck: old.ck }
        let next = ""
        if (hit.stoken && hit.stuid) {
            try {
                const headers = mhy.getHeaders(e, hit.ck_stoken || "")
                const r = await mhy.refresh_cookies(e, headers, hit.stoken, hit.stuid, { bindGenshinCookie: false })
                next = r && r.ck ? r.ck : ""
            } catch (_) { }
        }
        if (!next) next = hit.ck_stoken || ck || ""
        if (next) cache.set(key, { ck: next, at: Date.now() })
        return { uid: nextUid, ck: next }
    } catch (_) {
        return { uid, ck }
    }
}
