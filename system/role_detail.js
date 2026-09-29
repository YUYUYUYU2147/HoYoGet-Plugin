/**
 * 原神 / 星铁 角色详细信息渲染（数据来自 nanoka.cc）
 *
 * 原来这两张卡走米游社 entry_page，只取「基础信息 / 角色晋阶 / 天赋 / 角色突破」
 * 四个模块，模板里也只有 name/img/attribute/grow/week/material，看起来就是一堆材料。
 * 换到 nanoka 后能拿到完整数据：技能逐级数值、命座/星魂、天赋、属性成长表、行迹等。
 *
 * ⚠ 参数格式必须按各自的规则还原，不能一律乘 100：
 *
 *   原神  desc 数组形如 "一段伤害|{param1:F1P}"，格式串已经说明了怎么显示：
 *         F1P = 保留1位小数并按百分比(×100)   F1 = 保留1位小数原值   P = 整数百分比
 *         实际值在 promote[组].param 数组里，下标 = paramN - 1
 *
 *   星铁  desc 里是 #1[i] 这种占位符，下标同样从 1 开始。
 *         后面跟的是 % 就 ×100，跟「层/点/次」这类计数单位就取原值。
 *         实测：普攻 #1[i]% 参数0.5→50%；天赋「可叠加#1[i]层」参数8→8层。
 */

/** 去掉 nanoka/米游社的富文本标签 */
function stripTags(s) {
    return String(s ?? '')
        .replace(/<color=[^>]*>/g, '')
        .replace(/<\/color>/g, '')
        .replace(/<unbreak>/g, '')
        .replace(/<\/unbreak>/g, '')
        .replace(/<br\s*\/?>/g, '\n')
        .replace(/<\/?(b|i|u|size)[^>]*>/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .trim();
}

const num = v => {
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v ?? '');
    return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
};

/** 按「后面跟的是不是百分号」决定是否 ×100 */
function fillSrDesc(desc, params) {
    const arr = Array.isArray(params) ? params : [];
    return stripTags(desc).replace(/#(\d+)\[i\]/g, (m, n, offset, whole) => {
        const v = arr[Number(n) - 1];
        if (v == null) return '—';
        const after = String(whole).slice(offset + m.length, offset + m.length + 1);
        if (after === '%') return num(Number(v) * 100);
        return num(v);
    });
}

/** 按格式串（F1P / F1 / P）还原原神技能描述 */
function fillGsDesc(lines, params) {
    const arr = Array.isArray(params) ? params : [];
    return (Array.isArray(lines) ? lines : []).map(line => {
        const [label, tpl] = String(line).split('|');
        if (!tpl) return stripTags(label);
        const text = tpl.replace(/\{param(\d+):([^}]+)\}/g, (m, idx, fmt) => {
            const v = arr[Number(idx) - 1];
            if (v == null) return '—';
            const n = Number(v);
            if (fmt === 'F1P') return `${(n * 100).toFixed(1)}%`;
            if (fmt === 'P') return `${Math.round(n * 100)}%`;
            if (fmt === 'F1') return n.toFixed(1);
            if (fmt === 'F') return String(Math.round(n));
            return num(n);
        });
        return `${stripTags(label)}：${text}`;
    }).filter(Boolean);
}

const RARITY_CN = { 1: '一星', 2: '二星', 3: '三星', 4: '四星', 5: '五星' };
// 原神详情里的 rarity 是字符串枚举，不是数字
const gsRarityCn = r => {
    const s = String(r || '');
    if (s.includes('ORANGE')) return '五星';
    if (s.includes('PURPLE')) return '四星';
    return RARITY_CN[Number(r)] || '';
};
// 原神地区是枚举值（实测出现这四个，其余走 replace 兜底）
const GS_REGION_CN = {
    ASSOC_TYPE_MONDSTADT: '蒙德',
    ASSOC_TYPE_LIYUE: '璃月',
    ASSOC_TYPE_INAZUMA: '稻妻',
    ASSOC_TYPE_SUMERU: '须弥',
    ASSOC_TYPE_FONTAINE: '枫丹',
    ASSOC_TYPE_NATLAN: '纳塔',
    ASSOC_TYPE_SAYU_UMI: '渊下城',
    ASSOC_TYPE_NOD_KRAI: '挪德卡莱',
    ASSOC_TYPE_FATUI: '法外狂徒',
};
const gsRegionCn = v => GS_REGION_CN[v] || String(v || '').replace(/^ASSOC_TYPE_/, '');

function gsRoleView(detail, id) {
    const d = detail || {};
    const info = d.chara_info || {};
    const mats = d.materials || {};
    const ascensionMats = [];
    for (const step of mats.ascensions || []) {
        for (const m of step.mats || []) {
            if (!m?.name) continue;
            if (ascensionMats.some(x => x.name === m.name)) continue;
            ascensionMats.push({ name: m.name, id: m.id, count: m.count, rank: m.rank });
        }
    }
    const talentMats = [];
    // talents 是 [[{mats,cost}, ...], [...]]，两层数组（第一层是天赋槽位）
    for (const group of mats.talents || []) {
        for (const step of (Array.isArray(group) ? group : [group])) {
            for (const m of step?.mats || []) {
                if (!m?.name || talentMats.some(x => x.name === m.name)) continue;
                talentMats.push({ name: m.name, id: m.id, count: m.count });
            }
        }
    }

    const skills = (d.skills || []).map((sk, i) => {
        // promote 的键 0/1/2/3 不是「天赋组」而是【等级档】，每档自带一份 param 数组
        // （实测 普攻 是 0→Lv.1、3→满级）。展示用满级那档最有参考价值。
        const groups = Object.values(sk.promote || {})
            .map(g => ({ lines: fillGsDesc(g?.desc, g?.param), level: g?.level || 0 }))
            .filter(g => g.lines.length);
        const top = groups[groups.length - 1] || { lines: [], level: 0 };
        const firstIcon = Object.values(sk.promote || {})[0]?.icon;
        return {
            name: sk.name || `技能${i + 1}`,
            icon: firstIcon ? `https://static.nanoka.cc/assets/gi/${firstIcon}.webp` : '',
            lines: top.lines,
            maxLevel: top.level,
            brackets: groups.map(g => g.level).filter(Boolean),
        };
    }).filter(s => s.lines.length);

    return {
        id,
        name: d.name || '',
        icon: d.icon ? `https://static.nanoka.cc/assets/gi/${String(d.icon).replace(/^UI_AvatarIcon_/, '')}.webp` : '',
        rarity: gsRarityCn(d.rarity),
        element: info.vision || '',
        constellation: info.constellation || '',
        region: gsRegionCn(info.region),
        title: info.title || '',
        birth: Array.isArray(info.birth) && info.birth.length === 2 ? `${info.birth[0]}月${info.birth[1]}日` : '',
        release: String(info.release_date || '').slice(0, 10),
        baseHp: d.base_hp, baseAtk: d.base_atk, baseDef: d.base_def,
        critRate: d.crit_rate, critDmg: d.crit_dmg, em: d.elemental_mastery,
        stamina: d.stamina_recovery,
        desc: stripTags(d.desc),
        skills,
        constellations: (d.constellations || []).map((c, i) => ({
            no: i + 1, name: c.name, desc: fillSrDesc(c.desc, c.param_list),
        })).filter(c => c.name),
        passives: (d.passives || []).map(p => ({
            name: p.name, desc: fillSrDesc(p.desc, p.param_list), unlock: p.unlock,
        })).filter(p => p.name),
        ascensionMats,
        talentMats,
    };
}

function srRoleView(detail, id) {
    const d = detail || {};
    const info = d.chara_info || {};
    const stats = d.stats || {};
    const keys = Object.keys(stats);
    const pick = k => stats[k] || null;
    const growth = keys.map(k => {
        const s = stats[k];
        return {
            level: s?.level ?? k,
            atkBase: s?.attack_base, atkAdd: s?.attack_add,
            defBase: s?.defence_base, defAdd: s?.defence_add,
            hpBase: s?.hp_base, hpAdd: s?.hp_add,
            speed: s?.speed_base, crit: s?.critical_chance, critDmg: s?.critical_damage,
        };
    });

    const skills = Object.values(d.skills || {}).map(sk => {
        const lv = sk.level || {};
        const lvKeys = Object.keys(lv);
        const maxKey = lvKeys[lvKeys.length - 1];
        const maxParams = lv?.[maxKey]?.param_list || [];
        const minParams = lv?.[lvKeys[0]]?.param_list || [];
        let icon = '';
        const tag = String(sk.tag || '');
        if (/SingleAttack|BPSkill|Skill|Magic|Attack/.test(tag)) {
            icon = sk.type_name === '普攻' ? 'Normal' : sk.type_name === '战技' ? 'BP' : sk.type_name === '终结技' ? 'Ultra' : 'Passive';
        }
        return {
            type: sk.type_name || '',
            name: sk.name || '',
            icon: icon ? `https://static.nanoka.cc/assets/hsr/skillicons/SkillIcon_${id}_${icon}.webp` : '',
            maxLevel: lvKeys.length,
            desc: fillSrDesc(sk.desc, maxParams),
            minText: fillSrDesc(sk.desc, minParams),
        };
    }).filter(s => s.desc);

    return {
        id,
        name: d.name || '',
        rarity: RARITY_CN[Number(/(\d+)\s*$/.exec(String(d.rarity || ''))?.[1])] || '',
        path: d.base_type || '',
        damage: d.damage_type || '',
        camp: info.camp || '',
        spNeed: d.sp_need,
        desc: stripTags(d.desc),
        growth,
        skills,
        ranks: Object.entries(d.ranks || {}).map(([k, r]) => ({
            no: Number(k), name: r.name, desc: fillSrDesc(r.desc, r.param_list),
            icon: r.icon ? `https://static.nanoka.cc/assets/hsr/skillicons/SkillIcon_${id}_Rank${k}.webp` : '',
        })).filter(r => r.name).sort((a, b) => a.no - b.no),
        stories: Object.values(info.stories || {}).map(s => stripTags(s)).filter(Boolean),
    };
}

export { gsRoleView, srRoleView, stripTags, fillSrDesc, fillGsDesc };
