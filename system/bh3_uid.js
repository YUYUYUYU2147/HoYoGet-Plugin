/**
 * 崩坏3 UID 列表：给 genshin 的 #uid 面板补一行崩三
 *
 * 数据来源与 #切换水晶uid 完全一致：
 *   HoYoGet 的 Stoken 文件 data/Stoken/<QQ>.yaml（game_biz=bh3_cn）
 *   昵称与等级由 UID 面板从本地角色缓存补全
 *   + redis HoYoGet:bh3_uid:<QQ> 记录当前用于查水晶的 UID
 * 缓存缺失时保留账号 UID，由面板显示暂无数据状态。
 */
import fs from 'node:fs';
import YAML from 'yaml';

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
            serverName: REGION_LABEL[entry.region] || entry.region_name || entry.region || '',
            nickname: '',
            level: 0,
        });
    }
    if (!list.length) return { list: [], current: '' };
    let current = '';
    try {
        if (typeof redis !== 'undefined') current = String(await redis.get('HoYoGet:bh3_uid:' + user) || '');
    } catch (err) {}
    return { list, current };
}

export default { getBh3UidList };
