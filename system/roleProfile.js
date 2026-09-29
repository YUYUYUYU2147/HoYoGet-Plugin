/**
 * 统一取玩家资料（头像 + 昵称 + 服务器名）
 *
 * 为什么要有这个模块：
 * 崩三水晶统计（apps/bh3_ledger.js）一直靠 bh3_index 接口拿头像，
 * 但原石/星琼/菲林账本（apps/currency_ledger.js）没走这套 —— 账本接口
 * （ys_ledger / srledger / nap_ledger）自己根本不返回头像：
 *   原神  data 顶层有 nickname，没有头像字段
 *   星铁  既没有 nickname 也没有头像
 *   绝区零 data.role_info.{nickname,avatar} 都有
 * 所以同一个插件里两套取头像的逻辑，用户看到的就是「水晶统计有头像、
 * 账本没有」。这里把四个游戏统一到同一套：都走各自的 index 接口。
 *
 * 为什么不直接用 NoteUser：
 * NoteUser 那套要建 model、读 redis、写缓存，依赖比较重；
 * 账本这里只需要一张头像一个昵称，直接打 index 接口更轻，
 * 也和水晶统计的写法保持一致（都是 api(e, {type: *_index})）。
 */

import api from './api.js';
import { mhy } from '#xhh';

// index 接口类型：四个游戏各一个，路径规律一致
const INDEX_TYPE = {
    gs: 'gs_index',
    sr: 'sr_index',
    zzz: 'zzz_index',
    bh3: 'bh3_index',
};

// 服务器代码 → 中文名
const SERVER_CN = {
    cn_gf01: '国服', cn_qd01: 'B服', prod_gf_cn: '国服', prod_qd_cn: 'B服',
    os_usa: '美服', os_asia: '亚服', os_euro: '欧服', os_cht: '港澳台服',
    android01: '安卓官服', ios01: 'iOS服',
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

/** 昵称：各游戏字段位置也不一样 */
function findNickname(d) {
    return String(
        d?.nickname || d?.nick_name || d?.role?.nickname ||
        d?.player_info?.nickname || d?.avatar_info?.nickname || ''
    ).trim();
}

/**
 * 取玩家资料
 *
 * @param {object} e 事件对象
 * @param {string|number} uid 该游戏的 uid（必须是当前游戏自己的，不能混用）
 * @param {string} game gs | sr | zzz | bh3
 * @param {string} ck Cookie；也可以传现成的 headers（含 Cookie 字段），
 *                        这样能复用调用方已经算好的 DS，不用重算
 * @returns {Promise<{nickname:string, avatar:string, serverName:string, userLevel:number}>}
 */
export async function getRoleProfile(e, uid, game, ck) {
    const out = { nickname: '', avatar: '', serverName: '', userLevel: 0 };
    if (!uid || !ck) return out;
    const type = INDEX_TYPE[game];
    if (!type) return out;
    const server = mhy.getServer(String(uid), game);
    out.serverName = serverName(server);
    try {
        // ck 可以是 Cookie 字符串，也可以是已经带好 Cookie 的 headers 对象
        const headers = (typeof ck === 'object' && ck?.Cookie !== undefined) ? ck : mhy.getHeaders(e, ck);
        const res = await api(e, { type, uid: String(uid), headers, game, server });
        if (res?.retcode !== 0 || !res?.data) return out;
        const d = res.data;
        out.nickname = findNickname(d);
        out.avatar = findFaceUrl(d);
        out.userLevel = Number(d?.role?.level || d?.level || d?.player_info?.level || 0) || 0;
        // 接口回传的 region 比我们推算的更准（有B服/渠道服时推算不出来）
        const region = d.region || d.role?.region || '';
        if (region) out.serverName = serverName(region);
    } catch (err) {
        logger.debug?.('[xhh][资料] 获取玩家资料失败:', err?.message || err);
    }
    return out;
}

export default { getRoleProfile, serverName };
