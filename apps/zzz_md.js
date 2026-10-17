import { api, mhy, render, pluginPriority } from '#HoYoGet';

// genshin 的 NoteUser 必须动态加载：静态 import 在 genshin 缺失或版本变动时会让**整个插件**
// 加载失败（ESM 解析阶段抛 ERR_MODULE_NOT_FOUND，没有 try/catch 兜底）。
import { makeGenshinLoader } from '../system/genshin_loader.js'
const getNoteUser = makeGenshinLoader('model/mys/NoteUser.js', ['model/mys/NoteUser.js'])

export class zzz extends plugin {
    constructor(e) {
        super({
            name: '[小花火]绝区零母带',
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

        if (qq) {
            uid = (await (await getNoteUser()).create(qq)).getUid('zzz');
            ck = (await (await getNoteUser()).create(qq)).getMysUser('zzz')?.ck
        }

        if (!uid || !ck) {
            uid = e.user.getUid('zzz');
            const mys = e.user.getMysUser('zzz');
            ck = mys?.ck;
            qq = e.user_id
        }

        if (!uid || !ck) return e.reply('请先扫码绑定账号！');
        
        //获取headers
        let headers = mhy.getHeaders(e, ck);

        let data = {
            uid,
            headers,
            game: 'zzz',
            type: 'zzz_md',
        };

        let res = await api(e, data);

        data = res.data

        if (!data.tickets) return logger.mark(`UID${uid},未找到母带数据`)

        let fldp = 0, fl = 0, jmmd = 0, md = 0, bb = 0, level = '未知', name = '未知'
        let sk = await mhy.getstoken(e, uid);
        if (sk) {
            headers = mhy.getHeaders(e, sk);
            res = await api(e, {
                type: 'GameRoles',
                headers
            })
            if (res.data?.list) {
                res.data.list.forEach(v => {
                    if (v.game_uid == uid) {
                        level = v.level
                        name = v.nickname
                    }
                });
            }
        }
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
