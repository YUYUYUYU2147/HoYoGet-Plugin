import moment from 'moment';
import fs from 'fs';
import path from 'path';
import { render, pluginPriority } from '#xhh';
import MysInfo from '../../genshin/model/mys/mysInfo.js';
/**
 * 原神原石 / 星铁星琼 / 绝区零菲林的月报与统计
 *
 * 三个游戏都走米游社的「月报」接口，只是端点和字段名不一样：
 *
 *   原神   ys_ledger/monthInfo       month 传 1~12
 *          month_data.current_primogems / last_primogems / gacha
 *          month_data.group_by = [{ name, num, icon }]
 *
 *   星铁   srledger/month_info       month 传 YYYYMM
 *          month_data.current_hcoin / last_hcoin / current_rails_pass
 *          month_data.group_by = [{ action, action_name, num, icon, percent }]
 *
 *   绝区零 nap_ledger/month_info     month 传 YYYYMM
 *          month_data.list = [{ data_type, count }]（PolychromesData=菲林…）
 *          month_data.income_components = [{ action, num, percent }]
 *
 * 鉴权与端点都复用 genshin 插件的 MysInfo，这里只做「取数 + 归一化 + 渲染」。
 */
const DATA_DIR = './plugins/xhh/data/CurrencyLedger';
const ZZZ_ACTION_NAME = {
    event_rewards: '活动奖励',
    daily_activity_rewards: '日常活跃奖励',
    shiyu_rewards: '式舆防卫战&危局强袭战奖励',
    mail_rewards: '邮件奖励',
    growth_rewards: '成长奖励',
    hollow_rewards: '零号空洞奖励',
    other_rewards: '其他奖励',
};

// 统计图配色，与崩三水晶统计保持一致
const PIE_COLORS = ['#73a8c6', '#d56565', '#70b2b4', '#bd9a5a', '#739970', '#7a6da7', '#597ea0', '#c98fb0'];
const GAMES = {
    gs: {
        key: 'gs',
        name: '原神',
        alias: '原神原石',
        title: '原神 · 原石札记',
        unit: '原石',
        extraName: '摩拉',
        accent: '#c9a227',
        // 原石的 month 是「几月」，不是 YYYYMM
        monthArg: m => String(m.month),
    },
    sr: {
        key: 'sr',
        name: '星铁',
        alias: '星铁星琼',
        title: '崩坏：星穹铁道 · 开拓月历',
        unit: '星琼',
        extraName: '开拓力',
        accent: '#5b8fd6',
        monthArg: m => m.ym,
    },
    zzz: {
        key: 'zzz',
        name: '绝区零',
        alias: '绝区零菲林',
        title: '绝区零 · 菲林月报',
        unit: '菲林',
        extraName: '加密母带',
        accent: '#e8a33d',
        monthArg: m => m.ym,
    },
};
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];

function dataPath(game, qq) {
    return path.join(DATA_DIR, game, `${qq}.json`);
}

function readAll(game, qq) {
    const file = dataPath(game, qq);
    if (!fs.existsSync(file)) return {};
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return {};
    }
}

function writeAll(game, qq, data) {
    fs.mkdirSync(path.join(DATA_DIR, game), { recursive: true });
    fs.writeFileSync(dataPath(game, qq), JSON.stringify(data, null, '\t'));
}

/** 从指令里认出是哪个游戏 */
function pickGame(msg = '') {
    if (/绝区零|菲林|zzz/i.test(msg)) return 'zzz';
    if (/星铁|星穹|星琼|铁道|sr/i.test(msg)) return 'sr';
    return 'gs';
}

/**
 * 解析月份。支持：留空(当月) / 数字 5 / 中文 五 / YYYYMM(202608)
 * 返回 { month: 1~12, ym: 'YYYYMM' }
 */
function parseMonth(msg = '') {
    const now = moment();
    const curMonth = now.month() + 1;
    const text = String(msg || '')
        .replace(/[#＃%％]/g, '')
        .replace(/(原神|原石|星铁|星穹|星琼|铁道|绝区零|菲林|札记|月报|统计)/g, '');
    const ymMatch = /(\d{4})(\d{2})/.exec(text);
    if (ymMatch) return { month: Number(ymMatch[2]), ym: `${ymMatch[1]}${ymMatch[2]}` };

    let month = null;
    const numMatch = /(\d{1,2})/.exec(text);
    if (numMatch) {
        month = Number(numMatch[1]);
    } else {
        // 必须按长度从长到短找：「十二」里也含「二」，先找短的会把十二月认成二月
        const hit = CN_NUM.slice().sort((a, b) => b.length - a.length).find(c => text.includes(c));
        if (hit) month = CN_NUM.indexOf(hit) + 1;
    }
    if (!(month >= 1 && month <= 12)) {
        return { month: curMonth, ym: now.format('YYYYMM') };
    }

    // 往回数月会跨年：1 月往前推是去年的 12 月
    const back = curMonth - month;
    let year = now.year();
    if (back >= 12) year -= 1;
    else if (back > 0 && month > curMonth) year -= 1;
    return { month, ym: `${year}${String(month).padStart(2, '0')}` };
}

/** 把三个游戏各自不同的响应，统一成同一套字段 */
function normalize(game, res) {
    const d = res?.data || {};
    // 月份键必须是 YYYYMM。原神接口的 month 字段有可能是 "9" 这种只带月份的写法，
    // 直接拿去 slice(0,4)/slice(4) 会得到 "9" 和空串，柱状图的月份标签就渲染不出来。
    // 这里只认 6 位数字，其余交给调用方用「请求的月份」补。
    const ym = v => (/^\d{6}$/.test(String(v || '')) ? String(v) : '');
    if (game === 'gs') {
        const md = d.month_data || {};
        const dd = d.day_data || {};
        return {
            ym: ym(d.month),
            uid: String(d.uid || ''),
            nickname: d.nickname || '',
            avatar: d.avatar || '',
            monthTotal: Number(md.current_primogems || 0),
            lastMonth: Number(md.last_primogems || 0),
            today: Number(dd.current_primogems || 0),
            extra: Number(dd.current_mora || 0),
            gacha: Number(md.gacha || 0),
            list: (md.group_by || [])
                .map(i => ({ name: String(i.name || ''), num: Number(i.num || 0), icon: i.icon || '' }))
                .filter(i => i.name && i.num > 0),
        };
    }
    if (game === 'sr') {
        const md = d.month_data || {};
        const dd = d.day_data || {};
        return {
            ym: ym(d.data_month || d.month),
            uid: String(d.uid || ''),
            nickname: d.role_info?.nickname || '',
            avatar: d.role_info?.avatar || '',
            monthTotal: Number(md.current_hcoin || 0),
            lastMonth: Number(md.last_hcoin || 0),
            today: Number(dd.current_hcoin || 0),
            extra: Number(dd.current_rails_pass || 0),
            gacha: Math.floor(Number(md.current_hcoin || 0) / 160),
            list: (md.group_by || [])
                .map(i => ({ name: String(i.action_name || i.action || ''), num: Number(i.num || 0), icon: i.icon || '' }))
                .filter(i => i.name && i.num > 0),
        };
    }
    // 绝区零
    const md = d.month_data || {};
    const list = md.list || [];
    const pick = t => Number(list.find(i => i.data_type === t)?.count || 0);
    return {
        ym: ym(d.data_month),
        uid: String(d.uid || ''),
        nickname: d.role_info?.nickname || '',
        avatar: d.role_info?.avatar || '',
        monthTotal: pick('PolychromesData'),
        lastMonth: 0,
        today: 0,
        extra: pick('MatserTapeData'),
        boopons: pick('BooponsData'),
        gacha: 0,
        list: (md.income_components || [])
            .map(i => ({ name: ZZZ_ACTION_NAME[i.action] || String(i.action || ''), num: Number(i.num || 0), icon: '' }))
            .filter(i => i.name && i.num > 0),
    };
}

/** 把这个月的快照存下来，统计要用 */
function saveSnapshot(qq, game, snap) {
    if (!snap?.ym) return;
    const all = readAll(game, qq);
    all[snap.ym] = {
        monthTotal: snap.monthTotal,
        lastMonth: snap.lastMonth,
        gacha: snap.gacha,
        list: snap.list,
        saveTime: moment().format('YYYY-MM-DD HH:mm:ss'),
    };
    writeAll(game, qq, all);
}

/** 合并各月来源明细（action_id 跨月不稳定，只能按 name 合并） */
function buildSource(list) {
    const merged = new Map();
    for (const m of list) {
        for (const it of m?.list || []) {
            const name = String(it.name || '').trim();
            if (!name || !(Number(it.num) > 0)) continue;
            if (!merged.has(name)) merged.set(name, { name, num: 0 });
            merged.get(name).num += Number(it.num);
        }
    }
    const rows = [...merged.values()].sort((a, b) => b.num - a.num);
    const base = rows.reduce((s, i) => s + i.num, 0);
    // 最大余数法：逐项四舍五入会算出 101% 这种合计，这里先取整再把余数补给小数最大的几项，
    // 保证图例上的百分比加起来正好 100%
    const raw = rows.map(i => (base > 0 ? (i.num / base) * 100 : 0));
    const floor = raw.map(v => Math.floor(v));
    let rest = 100 - floor.reduce((a, b) => a + b, 0);
    const order = raw
        .map((v, idx) => ({ idx, frac: v - Math.floor(v) }))
        .sort((a, b) => b.frac - a.frac);
    const percent = floor.slice();
    for (const { idx } of order) {
        if (rest <= 0) break;
        percent[idx] += 1;
        rest -= 1;
    }
    return rows.map((i, idx) => ({
        ...i,
        percent: percent[idx],
        color: PIE_COLORS[idx % PIE_COLORS.length],
    }));
}

function toB64(obj) {
    return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

export class CurrencyLedger extends plugin {
    constructor() {
        super({
            name: '[小花火]原石星琼菲林账本',
            dsc: '原神原石 / 星铁星琼 / 绝区零菲林的月报与统计',
            event: 'message',
            priority: pluginPriority('currency_ledger', 100),
            rule: [
                {
                    // 前缀沿用插件约定：#小花火xxx / #xhhxxx / #xxx 都行
                    // 游戏名允许叠加（星铁星琼 / 绝区零菲林 都是常见写法），
                    // 月份支持 8 / 八 / 202608 / 十二月 这几种写法
                    reg: '^[#%*]*(小花火|xhh)?[#%*]*(原神|原石|星铁|星穹|星琼|铁道|绝区零|菲林)+(札记|月报)?(统计)?\\s*(\\d{1,6}|[一二两三四五六七八九十]+)?月*$',
                    fnc: 'run',
                },
            ],
        })
    }

    /** 统一的取数入口 */
    async fetch(e, game, mInfo) {
        const meta = GAMES[game];
        const oldGame = e.game;
        const oldNoTips = e.noTips;
        e.game = game;
        e.noTips = false;
        try {
            const res = await MysInfo.get(e, 'ledger', { month: meta.monthArg(mInfo) }, { log: false, game });
            if (!res || res.retcode !== 0) {
                return { error: res?.message || '月报接口返回异常，请确认已扫码绑定 Cookie 且在米游社 App 内开启「账本」权限。' };
            }
            return { snap: normalize(game, res) };
        } catch (err) {
            return { error: err?.message || String(err) };
        } finally {
            e.game = oldGame;
            e.noTips = oldNoTips;
        }
    }

    async run(e) {
        const msg = e.msg || '';
        const game = pickGame(msg);
        const meta = GAMES[game];
        const mInfo = parseMonth(msg);
        const isCount = /统计/.test(msg);
        const auth = await MysInfo.init(e, 'ledger');
        if (!auth?.uid || !auth?.ckInfo?.ck) {
            return e.reply('未检测到米游社 Cookie，请先发送 #扫码登录 完成绑定。', true, { recallMsg: 60 });
        }
        const { snap, error } = await this.fetch(e, game, mInfo);
        if (error) return e.reply(error, true, { recallMsg: 60 });
        // 接口没回合法 YYYYMM 时用「请求的月份」兜底，否则存盘的键不完整，
        // 统计页的月份标签会渲染成空的「月」
        if (!/^\d{6}$/.test(String(snap.ym || ''))) snap.ym = mInfo.ym;

        // 无论月报还是统计都先把当月存进去，保证统计里始终包含最新月份
        const qq = String(e.user_id || e.user?.qq || '');
        saveSnapshot(qq, game, snap);

        return isCount
            ? this.renderCount(e, game, meta, qq, auth)
            : this.renderMonth(e, game, meta, snap, mInfo, qq, auth);
    }

    async renderMonth(e, game, meta, snap, mInfo, qq, auth) {
        const ym = snap.ym || mInfo.ym;
        const label = ym ? `${Number(ym.slice(0, 4))}年${Number(ym.slice(4))}月` : '本月';
        const rows = snap.list.map((i, idx) => ({ ...i, color: PIE_COLORS[idx % PIE_COLORS.length] }));
        const base = rows.reduce((s, i) => s + i.num, 0);
        const cards = [
            { title: `本月${meta.unit}`, num: snap.monthTotal.toLocaleString('en-US'), accent: meta.accent },
            { title: '上月结余', num: snap.lastMonth.toLocaleString('en-US'), accent: '#8a94a6' },
            { title: `今日${meta.unit}`, num: snap.today.toLocaleString('en-US'), accent: '#5fb08a' },
        ];
        if (game === 'zzz') {
            cards.push({ title: '加密母带', num: Number(snap.extra || 0).toLocaleString('en-US'), accent: '#a06fc0' });
            cards.push({ title: '邦布券', num: Number(snap.boopons || 0).toLocaleString('en-US'), accent: '#d98a5b' });
        } else {
            cards.push({ title: `今日${meta.extraName}`, num: Number(snap.extra || 0).toLocaleString('en-US'), accent: '#a06fc0' });
            cards.push({ title: '本月抽卡', num: `${snap.gacha} 抽`, accent: '#d98a5b' });
        }
        const data = {
            game,
            gameName: meta.name,
            title: meta.title,
            unit: meta.unit,
            accent: meta.accent,
            label,
            ym,
            uid: snap.uid || String(auth?.uid || ''),
            nickname: snap.nickname || '',
            avatarUrl: snap.avatar || '',
            cards,
            rows,
            base: base.toLocaleString('en-US'),
            dateStr: moment().format('YYYY-MM-DD'),
        };
        const img = await render('currency_ledger/ledger', data, { e, pct: 1.5 });
        return e.reply(img);
    }

    async renderCount(e, game, meta, qq, auth) {
        const all = readAll(game, qq);
        const months = Object.keys(all).sort();
        if (!months.length) {
            return e.reply(`还没有${meta.name}的历史记录，先发一次「#${meta.alias}」建立数据。`, true, { recallMsg: 60 });
        }
        const items = months.map(ym => ({
            month: `${Number(ym.slice(4))}月`,
            year: ym.slice(0, 4),
            value: Number(all[ym]?.monthTotal || 0),
        }));
        const total = items.reduce((s, i) => s + i.value, 0);
        const best = items.reduce((a, b) => (b.value > (a?.value ?? -1) ? b : a), null);
        const rows = buildSource(months.map(ym => all[ym]));
        const first = months[0];
        const last = months[months.length - 1];
        const data = {
            game,
            gameName: meta.name,
            title: `${meta.name} · ${meta.unit}统计`,
            unit: meta.unit,
            accent: meta.accent,
            uid: String(auth?.uid || ''),
            total: total.toLocaleString('en-US'),
            monthCount: months.length,
            rangeText: `${Number(first.slice(0, 4))}年${Number(first.slice(4))}月 ~ ${Number(last.slice(0, 4))}年${Number(last.slice(4))}月`,
            bestMonth: best ? `${Number(best.year)}年${best.month}` : '',
            bestValue: best ? best.value.toLocaleString('en-US') : '',
            itemsB64: toB64(items),
            sourceB64: toB64(rows),
            dateStr: moment().format('YYYY-MM-DD'),
        };
        const img = await render('currency_ledger/count', data, { e, pct: 1.5 });
        return e.reply(img);
    }
}
