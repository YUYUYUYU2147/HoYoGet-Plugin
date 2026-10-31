/**
 * 统一取玩家资料（头像 + 昵称 + 服务器名）
 *
 * 为什么要有这个模块：
 * 崩三水晶统计（apps/bh3_ledger.js）一直靠 index 接口拿头像，
 * 但原石/星琼/菲林账本（apps/currency_ledger.js）没走这套 —— 账本接口
 * （ys_ledger / srledger / nap_ledger）自己根本不返回头像：
 *   原神  data 顶层有 nickname，没有头像字段
 *   星铁  既没有 nickname 也没有头像
 *   绝区零 data.role_info.{nickname,avatar} 都有
 * 所以同一个插件里两套取头像的逻辑，用户看到的就是「水晶统计有头像、
 * 账本没有」。这里把四个游戏统一到同一套。
 *
 * 为什么走 (await getMysInfo()).get 而不是自己 fetch：
 * index 接口对 device_fp 敏感，缺了会返回 -10001 invalid request。
 * genshin 插件的 getData() 会自动补 getFp，而且 URL / DS / 各游戏的 hostRecord
 * 都在它自己的 apiTool 里维护好了 —— 自己拼很容易漏头（第一版就是这么翻车的，
 * 星铁报「米游社接口异常」）。(await getMysInfo()).get 不校验 auth 名单，
 * 'index' 虽然不在 auth 数组里但能正常调用。
 *
 * 四个游戏的 index 路径（取自 genshin/model/mys/apiTool.js）：
 *   崩三    game_record/appv2/honkai3rd/api/index
 *   原神    game_record/app/genshin/api/index
 *   星铁    game_record/app/hkrpg/api/index
 *   绝区零  event/game_record_zzz/api/zzz/index
 */

import { api, mhy } from '#HoYoGet';

// genshin 的 MysInfo 必须动态加载：静态 import 在 genshin 缺失或版本变动时会让**整个插件**
// 加载失败（ESM 解析阶段抛 ERR_MODULE_NOT_FOUND，没有 try/catch 兜底）。
import { makeGenshinLoader } from './genshin_loader.js'
import { getAccount } from './ck_store.js'
const getMysInfo = makeGenshinLoader('model/mys/mysInfo.js', ['model/mys/mysInfo.js'])
const getNoteUser = makeGenshinLoader("model/mys/NoteUser.js", ["model/mys/NoteUser.js"])

// 服务器代码 → 中文名
const SERVER_CN = {
    cn_gf01: '国服', cn_qd01: 'B服', prod_gf_cn: '国服', prod_qd_cn: 'B服',
    os_usa: '美服', os_asia: '亚服', os_euro: '欧服', os_cht: '港澳台服',
    android01: '安卓官服', ios01: 'iOS服', pc01: '桌面服', bb01: '哔哩哔哩', yyb01: '应用宝服', hun01: '渠道1服', hun02: '渠道2服',
    prod_gf_us: '美服', prod_gf_eu: '欧服', prod_gf_jp: '日服', prod_gf_sg: '新加坡服',
    prod_official_usa: '国际服', prod_official_asia: '亚服',
    prod_official_eur: '欧服', prod_official_euro: '欧服', prod_official_cht: '港澳台服',
};

/** 服务器代码转中文，认不出来就原样返回 */
export function serverName(code) {
    const key = String(code || '').trim();
    if (!key) return '';
    if (SERVER_CN[key]) return SERVER_CN[key];
    const guess = key.match(/^(?:prod_(?:gf|official)_|os_)([a-z]{2,4})$/)?.[1];
    if (guess && SERVER_CN[`os_${guess}`]) return SERVER_CN[`os_${guess}`];
    return key;
}

// 各版本 index 接口把头像放在不同字段名里，这些是实测出现过的
const FACE_KEYS = [
    'game_head_icon', 'game_head', 'AvatarUrl', 'avatarUrl', 'cur_head_icon_url',
    'head_icon', 'headIcon', 'avatar_url', 'avatar_icon', 'avatar', 'icon_url',
    'icon_path', 'role_square_url', 'hollow_icon_path', 'group_icon_path',
];

/** 在对象里找头像字段；recursive=true 时往下找一层数组/对象 */
function findFaceUrl(data, recursive = true) {
    if (!data || typeof data !== 'object') return '';
    for (const key of FACE_KEYS) {
        const val = data[key];
        if (typeof val === 'string' && /^https?:\/\//i.test(val)) return val;
    }
    if (!recursive) return '';
    // 原神/星铁的 index 返回 data.avatars[] / data.avatar_list[]，
    // 优先取 is_chosen 的那个（玩家当前使用的头像）
    const chosen = data.avatars?.find?.(a => a?.is_chosen) || data.avatar_list?.find?.(a => a?.is_chosen);
    const fromChosen = findFaceUrl(chosen, false);
    if (fromChosen) return fromChosen;
    for (const list of [data.avatars, data.avatar_list, data.characters, data.avatar_info]) {
        if (!Array.isArray(list)) continue;
        for (const item of list) {
            const hit = findFaceUrl(item, false);
            if (hit) return hit;
        }
    }
    const hit = findFaceUrl(data.role, false);
    if (hit) return hit;
    // 再兜一层：zzz 的 data.avatar_info 是对象
    if (data.avatar_info && typeof data.avatar_info === 'object') return findFaceUrl(data.avatar_info, false);
    return '';
}

/** 签名：原神/星铁 index 里叫 signature，崩三是 sign，绝区零在 role 下 */
function findSignature(d) {
    return String(
        d?.signature || d?.sign || d?.role?.signature || d?.role?.sign ||
        d?.player_info?.signature || d?.avatar_info?.signature || ''
    ).trim();
}

/** 昵称：各游戏字段位置也不一样 */
function findNickname(d) {
    return String(
        d?.nickname || d?.nick_name || d?.role?.nickname ||
        d?.player_info?.nickname || d?.avatar_info?.nickname || ''
    ).trim();
}

/** 绑定设备指纹头：与 mys.req.err 重试时注入的是同一份（data/fp/<qq>.yaml）。
    没有存档时返回空对象，交给 genshin 自己的指纹逻辑，不硬塞假指纹。 */
function deviceFpHeaders(e) {
    const h = mhy.getHeaders(e, '');
    const out = {};
    if (h['x-rpc-device_fp']) out['x-rpc-device_fp'] = h['x-rpc-device_fp'];
    if (h['x-rpc-device_id']) out['x-rpc-device_id'] = h['x-rpc-device_id'];
    return out;
}

/* stoken 换 cookie_token 要打两次网络，头像是半小时一刷的低频需求，换一次缓存六小时 */
const ckUpgradeCache = new Map();
const CK_UPGRADE_TTL = 6 * 60 * 60 * 1000;

async function upgradeCk(e, ck, entry) {
    const key = `${String(e.user_id || '')}:${String(entry?.stuid || '')}:${String(entry?.uid || '')}`;
    const hit = ckUpgradeCache.get(key);
    if (hit && Date.now() - hit.ts < CK_UPGRADE_TTL) return hit.ck;
    let next = ck;
    try {
        /* 与 mys.req.err 处理器共用 TL.js 的换 token 实现，避免两套逻辑各换各的 */
        const { ensureCookieToken } = await import('../../apps/common/TL.js');
        const got = await ensureCookieToken(e, ck, entry);
        if (got && /cookie_token=/.test(got)) next = got;
    } catch (err) {
        logger.debug?.('[HoYoGet][资料] stoken 换 cookie_token 失败：' + (err?.message || err));
    }
    /* 换失败也缓存：不缓存的话每次出图都要白等两个网络往返 */
    ckUpgradeCache.set(key, { ts: Date.now(), ck: next });
    if (ckUpgradeCache.size > 500) ckUpgradeCache.clear();
    return next;
}

/**
 * 取玩家资料
 *
 * @param {object} e 事件对象（会被临时改写 e.game，取完还原）
 * @param {string|number} uid 该游戏的 uid（必须是当前游戏自己的，不能混用）
 * @param {string} game gs | sr | zzz | bh3
 * @param {object} auth 取崩三资料时必填：{ headers, server }
 * @returns {Promise<{nickname:string, avatar:string, signature:string, serverName:string, userLevel:number}>}
 */
export async function getRoleProfile(e, uid, game, auth = {}) {
    const out = { nickname: '', avatar: '', signature: '', serverName: '', userLevel: 0 };
    if (!uid) return out;
    out.serverName = serverName(mhy.getServer(String(uid), game));
    // e.game 必须先设好：(await getMysInfo()).get 内部靠它选游戏和对应的 hostRecord
    const oldGame = e.game; const oldUid = e.uid;
    e.game = game;
    try {
        let res;
        if (game === 'bh3') {
            // 崩三改走小花火自己的 api()。
            // genshin 的 MysApi 打 api-takumi-record 的 honkai3rd/index 会被米游社
            // 403，且那个域名没被 WAF 拦、响应体不是拦截页，代理兜底不会被触发。
            // 小花火的 api() 本就带 DS 签名并走 mhyFetch，
            // 且 api.js 里 bh3_index 与该URL 完全一致（bh3_abyss_boss 已在用）。
            /* 崩三条目的 ck_stoken 常常只有 stuid/stoken/mid，而 record 接口必须带 ltoken：
               与其它游戏共用同一个米游社账号时 ltoken 就存在条目里，这里补一次再请求。 */
            let bh3Headers = auth.headers || null
            if (bh3Headers) {
                const acc = getAccount(e.user_id, uid) || {}
                const ck = String(bh3Headers.Cookie || '')
                if (acc.ltoken && !/ltoken=/.test(ck)) {
                    bh3Headers = { ...bh3Headers, Cookie: `ltoken=${acc.ltoken};ltuid=${acc.stuid || ''};${ck}` }
                }
            }
            res = bh3Headers
                ? await api(e, {
                    type: 'bh3_index',
                    uid,
                    headers: bh3Headers,
                    game: 'bh3',
                    server: auth.server || mhy.getServer(String(uid), 'bh3'),
                    silent: true,
                })
                : null;
        } else {
            e.uid = Number(uid)
            const acc = getAccount(e.user_id, uid)
            let ownCk = acc && acc.ck_stoken ? acc.ck_stoken : ""
            /* [刷新ck] 写的是 Stoken 存档，ck_stoken 常已失效；NoteUser 里按 stuid 配对的 ck
               才是当前可用的那份，优先取它，取不到再退回存档。 */
            if (acc && acc.stuid) {
                try {
                    const _nu = await (await getNoteUser()).create(e.user_id)
                    const _paired = _nu && _nu.mysUsers ? _nu.mysUsers[String(acc.stuid)] : null
                    if (_paired && _paired.ck) ownCk = _paired.ck
                } catch (_) { }
            }
            // 只有含 ltoken/cookie_token 的完整 ck 能直接用于 record 接口；
            // 只存了 stuid/stoken 的条目拿去请求会得到 -100，不能用来重试
            const ckUsable = /ltoken=/.test(ownCk) && /cookie_token=/.test(ownCk)
            /* 设备指纹只有插件通道带得上（mhy.getHeaders 会读 data/fp/<qq>.yaml），
               所以优先用该账号自己的 ck 走插件通道；存档里只有 stoken 时先换出 cookie_token，
               不能直接退化到 genshin —— 那条路用的是随机设备指纹，绝区零 index 会稳定 10041。 */
            const recordCk = ownCk && !ckUsable ? await upgradeCk(e, ownCk, acc) : ownCk
            if (recordCk && /(?:^|; ?)(?:ltoken|cookie_token)=/.test(recordCk)) {
                const own = await api(e, {
                    type: game + '_index',
                    uid: uid,
                    game: game,
                    server: mhy.getServer(String(uid), game),
                    headers: mhy.getHeaders(e, recordCk),
                    silent: true,
                })
                if (own && own.retcode === 0) res = own
            }
            if (!res || res.retcode !== 0) {
                /* genshin 那条路的请求头由 MysApi 自己拼，设备指纹是随机值或公共 getFp，
                   绑定的手机指纹根本用不上，10041 因此常驻。把绑定指纹塞进 data.headers，
                   MysApi.getData 会合并进最终请求头 —— 与 mys.req.err 重试时做的完全一致。 */
                const fb = await (await getMysInfo()).get(e, 'index', { headers: deviceFpHeaders(e) }, { log: false, game })
                if (fb && fb.retcode === 0) res = fb
                /* 10041/5003 依旧只降级成空资料：一个 uid 失败不该拖垮整张面板；
                   但要在日志里留痕，否则「头像突然没了」只能靠猜。 */
                if (!res || res.retcode !== 0) {
                    res = null
                    logger.warn(`[HoYoGet][资料] ${game} uid ${uid} 取 index 失败，头像与昵称回退为空`)
                }
            }
        }
        if (!res || res.retcode !== 0 || !res.data) return out;
        const d = res.data;
        out.nickname = findNickname(d);
        out.avatar = findFaceUrl(d);
        out.signature = findSignature(d);
        out.userLevel = Number(d?.role?.level || d?.level || d?.player_info?.level || 0) || 0;
        // 接口回传的 region 比我们推算的更准（有B服/渠道服时推算不出来）
        const region = d.region || d.role?.region || '';
        if (region) out.serverName = serverName(region);

        // 星铁的 index 确实不带 nickname，但 avatar 藏在 avatar_info/avatars 里
        // （所以头像有、昵称空）。昵称要另外找 basicInfo。
        // 注意 basicInfo 这个 key 只对星铁安全：原神同名 key 指的是
        // game_record/app/genshin/api/gcg/basicInfo（七圣召唤），
        // 跟角色资料完全不相干，不能通用化。
        if (!out.nickname && game === 'sr') {
            const bi = await (await getMysInfo()).get(e, 'basicInfo', {}, { log: false, game });
            if (bi?.retcode === 0 && bi?.data) {
                out.nickname = findNickname(bi.data) || out.nickname;
                out.avatar = findFaceUrl(bi.data) || out.avatar;
                out.signature = out.signature || findSignature(bi.data);
                out.userLevel = Number(bi.data?.level || 0) || out.userLevel;
            }
        }
    } catch (err) {
        logger.debug?.('[HoYoGet][资料] 获取玩家资料失败:', err?.message || err);
    } finally {
        e.game = oldGame; e.uid = oldUid;
    }
    return out;
}

export default { getRoleProfile, serverName };
