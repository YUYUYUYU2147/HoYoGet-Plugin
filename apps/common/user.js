import {
    mhy,
    yaml,
    QR,
    sleep,
    reply_recallMsg,
    recallMsg,
    makeForwardMsg,
    api,
    config,
    pluginPriority,
    render
} from '#HoYoGet';
import { getRoleProfile } from '../../system/roleProfile.js';
import YAML from 'yaml';
import fs from 'fs';
import moment from 'moment';
import {
    Restart
} from '../../../other/restart.js';

const BH3_LEGACY_REGIONS = ['android01', 'ios01', 'pc01', 'bb01', 'yyb01', 'hun01', 'hun02'];

function isBh3Role(entry = {}) {
    if (entry.game_biz) return entry.game_biz === 'bh3_cn';
    return BH3_LEGACY_REGIONS.includes(entry.region || '');
}

const GAME_BIZ = { hk4e_cn: 'gs', hkrpg_cn: 'sr', nap_cn: 'zzz', bh3_cn: 'bh3' };
const REGION_NAME = { 天空岛: 'gs', 世界树: 'gs', 星穹列车: 'sr', 新艾利都: 'zzz' };
const GAME_NAME = { gs: '原神', sr: '崩坏：星穹铁道', zzz: '绝区零', bh3: '崩坏3' };

function gameOfEntry(entry = {}) {
    if (GAME_BIZ[entry.game_biz]) return GAME_BIZ[entry.game_biz];
    if (REGION_NAME[entry.region_name]) return REGION_NAME[entry.region_name];
    return BH3_LEGACY_REGIONS.includes(entry.region || '') ? 'bh3' : '';
}

/* 用 stoken 拉一次「角色列表」，补昵称与等级。
   绝区零的 record index 只返回头像（cur_head_icon_url），没有昵称字段，
   只靠 getRoleProfile 会让绝区零那行退化成「UID xxxxxx」。
   getUserGameRolesByStoken 走 stoken，与 getSToken 同一条路，返回必定带 nickname。 */
async function collectStokenRoles(e, stokenData) {
    const roles = new Map();
    const seen = new Set();
    for (const entry of Object.values(stokenData || {})) {
        const ck = entry?.ck_stoken || '';
        if (!ck || seen.has(ck)) continue;
        seen.add(ck);
        try {
            const headers = mhy.getHeaders(e, ck);
            const res = await api(e, { type: 'GameRoles', headers, silent: true });
            for (const row of res?.data?.list || []) {
                if (!row?.game_uid) continue;
                roles.set(String(row.game_uid), {
                    nickname: row.nickname || '',
                    level: Number(row.level || 0) || 0,
                });
            }
        } catch { /* 单条失败不影响出图 */ }
    }
    return roles;
}

/* 从 Stoken 结构（<uid> → 条目）收集出图用账号，逐个查昵称头像。
   查不到就回退「UID xxx」与空头像，不阻塞。 */
async function collectBindAccounts(e, stokenData) {
    const accounts = [];
    const stokenRoles = await collectStokenRoles(e, stokenData);
    for (const uid of Object.keys(stokenData || {})) {
        const entry = stokenData[uid] || {};
        if (!/^\d+$/.test(String(uid)) || Number(uid) <= 0) continue;
        const game = gameOfEntry(entry);
        if (!game) continue;
        let profile = { nickname: '', avatar: '', userLevel: 0 };
        try {
        const passCk = entry.ck_stoken || ['stuid=', entry.stuid, ';', 'stoken', '=', entry.stoken, ';'].join('')
        e.bindCk = passCk;
        const headers = mhy.getHeaders(e, passCk);
            profile = await getRoleProfile(e, uid, game, game === 'bh3' ? { headers, server: entry.region } : {});
        } catch { /* 忽略，回退 */ }
        const fallback = stokenRoles.get(String(uid)) || {};
        accounts.push({
            uid: String(uid),
            game,
            gameName: GAME_NAME[game] || '未知',
            name: profile.nickname || fallback.nickname || '',
            avatar: profile.avatar,
            level: profile.userLevel || fallback.level || 0,
            ok: true,
        });
    }
    return accounts;
}

/* 出图；渲染失败就回退文字，保证绑定/刷新本身不受影响。
   注意：render 传了 ret:true，图已经由 runtime 直接发出去了，
   这里绝不能再 e.reply 一次，否则同一张图会被发两遍。
   render 的返回值可能是 message_id（发送成功）或 base64 字符串（未发出），
   两者都不是 Buffer，所以原来的 Buffer.isBuffer 判断其实是多余的。 */
async function replyBindImage(e, accounts, title) {
    if (!accounts.length) return false;
    try {
        await render('sign/bind_result', {
            title,
            statusText: '成功',
            statusClass: '',
            accounts,
            sys: { scale: '' },
            saveId: 'bind_result',
        }, { e, ret: true });
        return true;
    } catch (err) {
        logger.warn(`[HoYoGet][user] 绑定结果出图失败，回退文字：${err?.message || err}`);
        return false;
    }
}

async function fetchJson(url, options = {}, label = '米游社接口') {
    const resp = await fetch(url, options);
    const text = await resp.text();
    try {
        return JSON.parse(text);
    } catch (err) {
        const head = String(text || '').trim().slice(0, 80);
        logger.mark(`[HoYoGet][sm] ${label} 返回非 JSON，status=${resp.status} body=${head}`);
        return {
            retcode: -1,
            message: head.startsWith('<') ? '米游社返回拦截页，请稍后重试' : '米游社接口返回异常',
            _html: head.startsWith('<'),
            _status: resp.status,
        };
    }
}

export class user extends plugin {
    constructor(e) {
        super({
            name: '[米哈游]user',
            dsc: '',
            event: 'message',
            handler: [{
                key: 'mys.req.err',
                fn: 'mysReqErrHandler',
            }, ],
            priority: pluginPriority('user', -9999999999),
            rule: [{
                    // genshin 的 #绑定设备 是 priority:-Infinity，有限优先级抢不过；
                    // 加「米哈游/绝区零」前缀就能绕开它的正则，稳定进本插件。
                    reg: '^#?(米哈游|绝区零)(绑定)?设备(绑定)?帮助$',
                    fnc: 'help',
                },
                {
                    reg: '^#?(米哈游|绝区零)(删除|绑定)设备(.*)$',
                    fnc: 'fp',
                },
                {
                    reg: '^#?(删除|绑定)*设备(.*)$',
                    fnc: 'fp',
                },
                {
                    reg: '^#?(米哈游)?扫码(登录|绑定|登陆)$',
                    fnc: 'sm',
                },
                {
                    reg: '^#?(绑定)?设备(绑定)?帮助$',
                    fnc: 'help',
                },
                {
                    reg: '^#?删除stoken$',
                    fnc: 'del',
                },
                {
                    reg: '^#?刷新(cookie|ck)$',
                    fnc: 'refresh_ck',
                },
                {
                    reg: '^#*米哈游开启设备(绑定)?$',
                    fnc: 'kq',
                },
                {
                    reg: '^#*解码(余额)*$',
                    fnc: 'yue',
                }
            ],
        });
    }

    async kq(e) {
        if (!e.isMaster) return false
        let path = './plugins/HoYoGet-Plugin/config/config.yaml';
        /* 未安装 genshin 时没有可注入的目标目录，跳过这一步；
           设备指纹绑定本身由本插件完成，不依赖 genshin。 */
        if (fs.existsSync('./plugins/genshin/model/mys')) {
            fs.cpSync('./plugins/HoYoGet-Plugin/system/checkCode/gs.txt', './plugins/genshin/model/mys/mysInfo.js')
        } else {
            logger.warn('[HoYoGet] 未安装 genshin 插件，已跳过设备绑定注入')
        }
        // 星铁这份实现依赖 StarRail-plugin 自己的 SRApiTool/getDeviceFp；
        // 这两个文件不存在时覆盖过去只会让 StarRail-plugin 直接 ERR_MODULE_NOT_FOUND。
        const srRuntime = './plugins/StarRail-plugin/runtime'
        if (fs.existsSync(`${srRuntime}/SRApiTool.js`) && fs.existsSync(`${srRuntime}/getDeviceFp.js`)) {
            fs.cpSync('./plugins/HoYoGet-Plugin/system/checkCode/sr.txt', `${srRuntime}/MysSRApi.js`)
        } else {
            logger.warn('[HoYoGet] StarRail-plugin 缺少 SRApiTool/getDeviceFp，已跳过星铁设备绑定注入')
        }
        await yaml.set(path, 'bdsb', true);
        await e.reply('开启设备完成，执行重启！')
        new Restart(this.e).restart();
    }



    fp(e) {
        if (!config().bdsb) return false
        if (e.msg.includes('删除')) return this.Delete(e);
        let msg = e.msg.replace(/米哈游|绝区零|绑定|设备|#/g, '');
        let info;
        try {
            info = JSON.parse(msg);
        } catch (err) {
            return false;
        }
        if (e.isGroup) {
            // e.reply('请私聊绑定设备'
            recallMsg(e);
        }
        return mhy.shebei(e, info);
    }

    async help(e) {
        if (!config().bdsb) return false
        const msg = [
            '[注意点]',
            '1.绑定设备主要是解决查询米游社报的异常问题，我通过模拟你的常用设备访问米游社获取fp设备指纹参数，用于后续查询米游社时使用',
            '2.如果你不信任我，请不要使用此功能\n',
            '[绑定设备]',
            '方法一（仅适用于部分安卓设备）：',
            '1. 使用常用米游社手机下载下面链接的APK文件（复制到浏览器打开），并安装',
            'https://e-e.lanzouw.com/isfXD2f00v6f',
            '密码:xhh',
            '2. 打开app后点击按钮复制设备信息(注意:oaid不能全是0，也不能出现error)',
            '3. 发送：#米哈游绑定设备（+设备信息）',
            '-------------------------------',
            '方法二(不会抓包就别试了)：',
            '1. 使用抓包软件抓取常用手机的米游社APP请求',
            '2. 在请求头内找到【x-rpc-device_id】和【x-rpc-device_fp】',
            '3. 自行构造如下格式的信息：',
            '   {"device_id": "x-rpc-device_id的内容", "device_fp": "x-rpc-device_fp的内容"}',
            '4. 发送：#米哈游绑定设备（+构造的设备信息）',
            '-------------------------------',
            '[删除设备]',
            '发送 #米哈游删除设备 即可',
        ].join('\n');
        e.reply(await makeForwardMsg(e, msg));
    }

    async sm(e) {
        if (config().debug) logger.mark('[sm] starting scan login');
        if (!config().sm) return false;
        let CD = config().sm_cd || 0;
        let now_time = moment(new Date()).format('YYYY-MM-DD HH:mm:ss');
        const last_time = await redis.get(`xhh_sm:${e.user_id}_CD`);
        if (last_time && !e.isMaster) {
            const seconds = moment(now_time).diff(moment(last_time), 'seconds');
            e.reply(
                '扫码登录CD中，请不要重复触发！剩余时间：' + (CD - seconds) + '秒',
                true
            );
            return true;
        }

        let url = 'https://passport-api.mihoyo.com/account/ma-cn-passport/app/createQRLogin'; //获取二维码
        // const app_id = 2;
        /**
        1 《崩坏3》
        2 《未定事件簿》
        4 《原神》
        7 《崩坏学园2》
        8 《崩坏：星穹铁道》
        12 《绝区零》
         * 
         */

        let headers = mhy.getHeaders(e);

        let body = {
            // app_id: app_id,
            // device: headers['x-rpc-device_id'],
        };
        let res = await fetchJson(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        }, '创建扫码二维码');

        if (!res?.data?.url || !res?.data?.ticket) {
            return e.reply(`创建二维码失败：${res?.message || '接口返回异常，请稍后重试'}`, true);
        }

        const sm_url = res.data.url;
        let ticket = res.data.ticket
        
        let img = segment.image(
            (await QR.toDataURL(sm_url)).replace(
                'data:image/png;base64,',
                'base64://'
            )
        );

        const re = await reply_recallMsg(
            e,
            [
                '请在60秒内使用手机米游社扫码登录',
                img,
                '谁触发谁扫码,请不要帮别人绑定自己的米游社！！！',
            ],
            60,
            true
        );
        if (re?.data?.message_id) re.message_id = re?.data?.message_id;
        await sleep(2000);

        url = 'https://passport-api.mihoyo.com/account/ma-cn-passport/app/queryQRLoginStatus'; //查询二维码状态
        body = {ticket};
        let zt;
        now_time = moment(new Date()).format('YYYY-MM-DD HH:mm:ss');
        await redis.set(`xhh_sm:${e.user_id}_CD`, now_time, {
            EX: CD
        }); //进入CD
        
      
        for (var n = 1; n < 150; n++) {
            await sleep(1000);
            res = await fetchJson(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
            }, '查询扫码状态');
            
                            
            if (res?.retcode != 0) return e.reply(res?._html ? '米游社返回拦截页，扫码绑定失败。请稍后重试或换网络环境。' : '二维码已过期~', true);
            if (res.data.status == 'Init') continue;
            if (res.data.status == 'Scanned' && !zt) {
                zt = true;
                if (re?.message_id) recallMsg(e, re.message_id);
                e.reply('二维码已被扫，请确认登录~', true);
            }
            
            if (res.data.status == 'Confirmed') {
                if (config().debug) logger.mark('[sm] confirmed, stuid:', res.data.user_info.aid || res.data.user_info.uid || res.data.user_info.account_id);

                //SToken
                const SToken = (
                  res.data.tokens.find(i => i.name === "stoken" || i.name === "stoken_v2") ||
                  res.data.tokens[0]
                  )?.token
                //stuid
                const stuid = res.data.user_info.aid || res.data.user_info.uid || res.data.user_info.account_id
                //mid
                const mid = res.data.user_info.mid;
                //扫码响应里若直接带了 v2 token，就原样透传给 genshin。
                //没有就是没有——getCookieAccountInfoBySToken 换来的仍是 v1 字段，
                //把 cookie_token 改名成 cookie_token_v2 只会让 genshin 走 flagV2
                //分支拿 v1 的值去校验，比走老格式失败得更快。
                const tk = n => res.data.tokens.find(i => i.name === n)?.token;
                
                //用SToken获取cookie
                const ck = `stuid=${stuid};stoken=${SToken};mid=${mid};`;
                
                headers.Cookie = ck;
                const {
                    sendMsg,
                    ltoken
                } = await mhy.refresh_cookies(e, headers, SToken, stuid, {
                    bindGenshinCookie: true,
                    mid,
                    cookieTokenV2: tk("cookie_token_v2"),
                    ltokenV2: tk("ltoken_v2")
                });
                let data_ = {};
                if (SToken && stuid && mid && ltoken) {
                    res = await api(e, {
                        type: 'GameRoles',
                        headers: headers
                    });
                    /*
                    hk4e_cn国服原神
                    hkrpg_cn国服星铁
                    nap_cn国服绝区零
                    */
                     const game_list = ['hk4e_cn', 'hkrpg_cn', 'nap_cn', 'bh3_cn'];
                    res.data.list.map(v => {
                        if (game_list.includes(v.game_biz)) {
                            data_[v.game_uid] = {
                                uid: v.game_uid,
                                stuid: stuid,
                                stoken: SToken,
                                ck_stoken: `stuid=${stuid};stoken=${SToken};mid=${mid};`,
                                mid: mid,
                                ltoken: ltoken,
                                game_biz: v.game_biz,
                                region_name: v.region_name,
                                region: v.region,
                            };
                        }
                    });
                    let yaml_url = `./plugins/HoYoGet-Plugin/data/Stoken/${e.user_id}.yaml`;
                    await this.process_files(yaml_url, data_);
                    const yaml_path = './plugins/xiaoyao-cvs-plugin/data/yaml/';
                    if (fs.existsSync(yaml_path)) { //fs.mkdirSync(yaml_path, { recursive: true });
                        yaml_url = `${yaml_path}${e.user_id}.yaml`;
                        for (let k in data_) {
                            data_[k]['userId'] = Number(e.user_id);
                            data_[k]['is_sign'] = true;
                        }
                        await this.process_files(yaml_url, data_);
                    }
                    const bh3BindInfo = await this.prepareBh3BindInfo(e, data_);
                    if (bh3BindInfo) sendMsg.push(bh3BindInfo);
                }
                if (e.no_reply) e.reply = e.no_reply;
                const bindAccounts = await collectBindAccounts(e, data_);
                if (bindAccounts.length && await replyBindImage(e, bindAccounts, '米哈游扫码绑定结果')) {
                    break;
                }
                await this.replyBindResult(e, sendMsg, '米哈游扫码绑定结果');
                if (!bindAccounts.length && !sendMsg.length) {
                    e.reply('扫码登录成功，但未读取到可绑定的游戏角色。请确认该米游社账号下已创建角色、并已开启战绩展示后再试', true);
                }
                break;
            }
        }
        return true;
    }

    //删除设备
    async Delete(e) {
        const path = `./plugins/HoYoGet-Plugin/data/fp/${e.user_id}.yaml`;
        if (!fs.existsSync(path)) return e.reply('你没有绑定过设备', true);
        fs.unlinkSync(path);
        //ZZZ-Plugin???
        const ltuid = e.user.getMysUser('zzz').ltuid
        await redis.del(`ZZZ:DEVICE_FP:${ltuid}:FP`);
        await redis.del(`ZZZ:DEVICE_FP:${ltuid}:ID`);
        e.reply('删除成功!', true);
        return true;
    }

    //删除stoken
    del(e) {
        const path = `./plugins/HoYoGet-Plugin/data/Stoken/${e.user_id}.yaml`;
        const path2 = `./plugins/xiaoyao-cvs-plugin/data/yaml/${e.user_id}.yaml`;
        if (!fs.existsSync(path) && !fs.existsSync(path2)) {
            return e.reply('你没有绑定过stoken', true);
        }
        if (fs.existsSync(path2)) fs.unlinkSync(path2);
        if (fs.existsSync(path)) fs.unlinkSync(path);
        e.reply('删除成功!', true);
        return true;
    }

    //刷新ck
    async refresh_ck(e) {
        let msgs = [],
            kg;
        let data_ = await mhy.getSToken(e);
        if (!data_) return e.reply(`未绑定米游社，请发送[扫码绑定]`, true);
        const path = `./plugins/HoYoGet-Plugin/data/Stoken/${e.user_id}.yaml`;
        let data;
        if (!Array.isArray(data_)) data = yaml.get(path);
        else((data = data_[1]), (data_ = data_[0]));
        for (let k in data_) {
            const [SToken, ck] = data_[k];
            const headers = mhy.getHeaders(e, ck);
            //ck_stoken 里带 mid，有它 genshin 才能走 v2 分支
            const mid = String(ck || '').match(/mid=([^;]+)/)?.[1] || '';
            const {
                sendMsg,
                ltoken
            } = await mhy.refresh_cookies(e, headers, SToken, k, {
                bindGenshinCookie: true,
                mid
            });
            if (ltoken && data) {
                /* 按 game_uid 精确写回。同一 stuid 下可能有多个游戏，
                   用 stoken 匹配会把这一轮刷出来的 ltoken 写到所有游戏上。 */
                if (data[k] && data[k].stoken == SToken) {
                    data[k].ltoken = ltoken;
                    kg = 1;
                }
            }
            msgs.push(...sendMsg);
        }
        if (kg) fs.writeFileSync(path, YAML.stringify(data), 'utf-8');
        if (e.no_reply) e.reply = e.no_reply;
        msgs.map((v, i) => {
            if (typeof msgs[i] === 'string') msgs[i] = msgs[i].replace(/绑定Cookie/g, '刷新Cookie');
        })
        const refreshAccounts = await collectBindAccounts(e, data);
        if (refreshAccounts.length && await replyBindImage(e, refreshAccounts, '米哈游刷新Cookie结果')) {
            return;
        }
        await this.replyBindResult(e, msgs, '米哈游刷新Cookie结果');
    }

    normalizeBindMessages(msgs = []) {
        const ret = [];
        const pick = m => {
            if (!m) return;
            if (Array.isArray(m)) return m.forEach(pick);
            if (typeof m === 'string') {
                const text = m.trim();
                if (text) ret.push(text);
                return;
            }
            if (m.type === 'text') {
                const text = (m.text || m.data?.text || '').trim();
                if (text) ret.push(text);
                return;
            }
            if (typeof m.message === 'string') {
                const text = m.message.trim();
                if (text) ret.push(text);
                return;
            }
            if (m.data?.text) {
                const text = String(m.data.text).trim();
                if (text) ret.push(text);
            }
        };
        pick(msgs);
        const text = [...new Set(ret)]
            .join('\n')
            .replace(/绑定Cookie成功\s*【/g, '绑定Cookie成功\n【')
            .replace(/(\d)(使用命令说明)/g, '$1\n$2')
            .replace(/使用命令说明\s*#/g, '使用命令说明 #')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        if (!text) return [];
        const chunks = [];
        let cur = '';
        for (const line of text.split('\n')) {
            if ((cur + '\n' + line).length > 900) {
                if (cur) chunks.push(cur);
                cur = line;
            } else {
                cur = cur ? `${cur}\n${line}` : line;
            }
        }
        if (cur) chunks.push(cur);
        return chunks;
    }

    async replyBindResult(e, msgs = [], title = '米哈游绑定结果') {
        if (e.no_reply) e.reply = e.no_reply;
        const list = this.normalizeBindMessages(msgs);
        if (!list.length) return e.reply('操作完成，但没有可展示的文本结果', true);
        if (list.length === 1 && list[0].length < 500) return e.reply(list[0], true);
        try {
            const forward = await makeForwardMsg(e, list, title);
            return e.reply(forward);
        } catch (err) {
            logger.warn(`[HoYoGet][user] 合并转发失败，回退为分段文本: ${err?.message || err}`);
            const text = list.join('\n\n');
            if (text.length <= 1800) return e.reply(text, true);
            for (let i = 0; i < text.length; i += 1600) {
                await e.reply(text.slice(i, i + 1600), true);
            }
        }
    }

    async process_files(yaml_url, data_) {
        if (!fs.existsSync(yaml_url)) {
            fs.writeFileSync(yaml_url, YAML.stringify(data_), 'utf-8');
        } else {
            const _data_ = await yaml.get(yaml_url);
            for (let k in data_) {
                if (_data_[k]?.hasOwnProperty('is_sign'))
                    data_[k]['is_sign'] = _data_[k].is_sign;
                _data_[k] = data_[k];
            }
            fs.writeFileSync(yaml_url, YAML.stringify(_data_), 'utf-8');
        }
    }

    async prepareBh3BindInfo(e, data_ = {}) {
        const accounts = Object.entries(data_)
            .filter(([, v]) => isBh3Role(v))
            .map(([uid, v]) => ({
                uid,
                region: v.region || '',
                name: v.region_name || v.region || '未知服务器',
            }));
        if (!accounts.length) return '';
        const current = await redis.get(`xhh:bh3_uid:${e.user_id}`);
        let defaultText = '';
        if (!current) {
            const first = accounts[0];
            await redis.set(`xhh:bh3_uid:${e.user_id}`, first.uid);
            await redis.set(`xhh:bh3_region:${e.user_id}`, first.region);
            defaultText = `\n已自动设为默认水晶查询UID：${first.uid}（${first.name}）`;
        }
        const list = accounts.map((item, i) => `${i + 1}. ${item.uid}（${item.name}）`).join('\n');
        return `已绑定崩坏3账号：\n${list}${defaultText}\n如需切换默认水晶查询账号，请发送 #切换水晶uid`;
    }

    async mysReqErrHandler(e, args, reject) {
        logger.mark('[mysover] hin ret:'+args?.res?.retcode+' bdsb:'+config().bdsb+' mreq:'+e.mysReq);
        if (!config().bdsb) return reject();
        let {
            data,
            mysApi,
            type
        } = args;
        if (![1034, 10035, 10041, 5003].includes(Number(args?.res?.retcode))) {
            return reject();
        }
        if (e.mysReq) return await mysApi.getData(type, data);

        mysApi.getUrl = (...args) => this.getUrl.apply(mysApi, args)

        const yaml_url = `./plugins/HoYoGet-Plugin/data/fp/${e.user_id}.yaml`;
        if (fs.existsSync(yaml_url)) {
            let data_ = fs.readFileSync(yaml_url, 'utf-8');
            data_ = YAML.parse(data_);
            let fp;
            if (data_.fp) fp = data_.fp;
            if (!fp) return reject();
            if (data?.headers) {
                data.headers['x-rpc-device_fp'] = fp;
            } else {
                if (!data) data = {};
                data.headers = {
                    'x-rpc-device_fp': fp
                };
            }
            data.headers['x-rpc-device_id'] = data_.device_id
            if (!e.deviceFp) e.reply(`米游社访问异常,正在调用QQ：${e.user_id}常用设备重试米游社......`)
            e.deviceFp = true
        } else if ([1034, 10035].includes(Number(args?.res?.retcode))) {
            let create = await mysApi.getData('createVerification')
            if (!create || create.retcode !== 0) return reject();
            let verify = await this.ManualVerify(e, create.data)
            if (!verify) {
                if (e.isGroup) {
                    Bot.pickGroup(e.group_id).sendMsg('验证码验证失败或已超时🥀')
                } else {
                    Bot.pickFriend(e.user_id).sendMsg('验证码验证失败或已超时🥀')
                }
                e.mysReq = true
                return reject();
            }
            let submit = await mysApi.getData('verifyVerification', verify)
            if (!submit || submit.retcode !== 0) return reject();
            e.mysReq = true
            await sleep(2000)
        }else{logger.mark('[mysover] enter uid:'+mysApi.uid+' ckLen:'+(e.bindCk||'').length);const a=config()?.auto_verify_addr||'http://127.0.0.1:2149/solve',k=await(await import('./TL.js')).ensureCookieToken(e,args?.mysApi?.cookie||e.bindCk||'');if(!a||!k)return reject();const r=await fetch(a,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cookie:k,clientType:'2',game:String(mysApi.game||(mysApi.isSr?'sr':'gs'))}),signal:AbortSignal.timeout(360000)}).then(x=>x.json()).catch(e=>{logger.warn('[mysover] ferr '+(e?.message||e));return null});if(r?.data?.result!=='ok')return reject();data=data||{};logger.mark('[mysover] ch='+String(r.data.challenge).slice(0,14)+' g='+String(mysApi.isSr?6:(mysApi.game==='zzz'?8:2)));}

        let res = await mysApi.getData(type, data);
        if (![1034, 5003, 10035, 10041].includes(Number(res?.retcode))) {
            logger.mark(`[[HoYoGet]mys重试成功][uid:${mysApi.uid}][qq:${e.user_id}]`)
            return res;
        }
        return reject();
    }

    getUrl(type, data = {}) {
        let urlMap = {
            ...this.apiTool.getUrlMap({
                ...data,
                deviceId: this.device
            }),
            createVerification: {
                url: 'https://bbs-api.miyoushe.com/misc/wapi/createVerification',
                query: 'gids=2&is_high=false'
            },
            verifyVerification: {
                url: 'https://bbs-api.miyoushe.com/misc/wapi/verifyVerification',
                body: data
            }
        }
        if (!urlMap[type]) return false


        let {
            url,
            query = '',
            body = ''
        } = urlMap[type]

        if (query) url += `?${query}`
        if (body) body = JSON.stringify(body)

        let headers = this.getHeaders(query, body)
        if (this.isSr) headers['x-rpc-challenge_game'] = '6'
        if (this.game == 'zzz') headers['x-rpc-challenge_game'] = '8'

        return {
            url,
            headers,
            body
        }
    }

    async yz(e, game, headers) {
        //获取headers
        if (!headers) headers = mhy.getHeaders(e, e.user.getMysUser().ck)
        headers['x-rpc-client_type'] = 5
        headers.DS = mhy.getDs2('gids=2&is_high=false', '', 4)
        headers['x-rpc-challenge_game'] = game == 'zzz' ? '8' : game == 'sr' ? '6' : '2'

        let data = {
            headers,
            type: "createVerification"
        }

        let res = await api(e, data);
        if (!res || res.retcode !== 0) return false

        let body = await this.ManualVerify(e, res.data)

        if (!body) {
            e.reply('验证码验证失败或已超时')
            return false
        }
        body = JSON.stringify(body)
        headers.DS = mhy.getDs2('', body, 4)

        data = {
            headers,
            type: "verifyVerification",
            body
        }

        res = await api(e, data);
        if (!res || res.retcode !== 0) {
            e.reply('验证码验证失败或已超时🥀')
            return false
        }
        return true
    }


    // 手动过码：走 local 验证页面（system/manual_geetest.js），不再使用第三方自动识别
    async ManualVerify(e, data) {
        if (!data?.gt || !data?.challenge) return false;
        const { manualGeetest } = await import('../../system/manual_geetest.js');
        const validated = await manualGeetest(e, data, '米游社查询验证码');
        if (!validated?.validate) return false;
        if (e.isGroup) Bot.pickGroup(e.group_id).sendMsg('验证完成，正在重试查询~');
        else Bot.pickFriend(e.user_id).sendMsg('验证完成，正在重试查询~');
        return {
            geetest_challenge: validated.challenge || data.challenge,
            geetest_validate: validated.validate,
            geetest_seccode: validated.seccode || `${validated.validate}|jordan`,
        };
    }

}
