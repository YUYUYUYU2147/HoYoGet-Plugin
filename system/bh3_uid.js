/**
 * 崩坏3 UID 列表：给 genshin 的 #uid 面板补一行崩三
 *
 * 数据来源与 #切换水晶uid 完全一致：
 *   HoYoGet 的 Stoken 文件 data/Stoken/<QQ>.yaml（game_biz=bh3_cn）
 *   + 一次 getUserGameRolesByStoken 补昵称/等级
 *   + redis HoYoGet:bh3_uid:<QQ> 记录当前用于查水晶的 UID
 * 任何一步取不到都只返回空列表，调用方保持原样，不影响原有面板。
 */
import fs from 'node:fs';
import YAML from 'yaml';
import { api, mhy } from '#HoYoGet';

const BH3_REGIONS = ['android01', 'ios01', 'pc01', 'bb01', 'yyb01', 'hun01', 'hun02'];
const REGION_LABEL = {
    android01: '安卓国服',
    ios01: 'iOS国服',
    pc01: '全平台（桌面）服',
    bb01: 'B服',
    yyb01: '应用宝服',
    hun01: '渠道服',
    hun02: '渠道服',
};

function isBh3Entry(entry = {}) {
    if (entry.game_biz) return entry.game_biz === 'bh3_cn';
    return BH3_REGIONS.includes(entry.region || '');
}

export async function getBh3UidList(e, qq) {
    const user = String(qq || e?.user_id || '');
    if (!user) return { list: [], current: '' };
    const path = './plugins/HoYoGet-Plugin/data/Stoken/' + user + '.yaml';
    if (!fs.existsSync(path)) return { list: [], current: '' };
    let data = {};
    try {
        data = YAML.parse(fs.readFileSync(path, 'utf8')) || {};
    } catch (err) {
        return { list: [], current: '' };
    }
    const list = [];
    for (const uid of Object.keys(data)) {
        const entry = data[uid] || {};
        if (!isBh3Entry(entry)) continue;
        list.push({
            uid: String(uid),
            region: entry.region || '',
            serverName: entry.region_name || REGION_LABEL[entry.region] || entry.region || '',
            nickname: '',
            level: 0,
            ck: entry.ck_stoken || '',
        });
    }
    if (!list.length) return { list: [], current: '' };
    try {
        const ck = list.find(v => v.ck)?.ck || '';
        if (ck) {
            const headers = mhy.getHeaders(e, ck);
            const res = await api(e, { type: 'GameRoles', headers, silent: true });
            const rows = res?.data?.list || [];
            for (const item of list) {
                const hit = rows.find(row => String(row.game_uid) === item.uid);
                if (!hit) continue;
                item.nickname = hit.nickname || '';
                item.level = Number(hit.level || 0) || 0;
            }
        }
    } catch (err) { /* 昵称取不到不影响列表显示 */ }
    let current = '';
    try {
        if (typeof redis !== 'undefined') current = String(await redis.get('HoYoGet:bh3_uid:' + user) || '');
    } catch (err) {}
    return { list, current };
}

export default { getBh3UidList };
