/**
 * 星铁深渊「双数据源互补」
 *
 * 两个站的数据各有对方没有的字段，单用一边必然残缺：
 *
 *   字段                      nanoka(速报)   alioth(速览)
 *   HPCount    血条数 ×N           ✗             ✓
 *   VoracityHP 污染额外血量        ✗             ✓
 *   IAR        效果抗性            ✗             ✓
 *   Summons    召唤物(含子怪数值)   ✗             ✓
 *   invasion    污染机制说明/等级   ✓             ✗
 *
 * 两边的 stage_id 与期 id 同号（实测 nanoka 迷宫集 1035 ↔ alioth chaos/1035
 * 的 stage 30125121 完全对应），因此可以直接按 stage_id 交叉查表，无需映射。
 *
 * 本模块只做「取另一个源补齐缺失字段」，不改变任一源的原始算法，
 * 查不到就返回空，调用方按原样渲染即可。
 */

const ALIOTH_DATA = 'https://json.alioth.wiki/data';
const NANOKA = 'https://static.nanoka.cc/hsr';

/** 期 id -> 解析结果，避免同一期重复请求 */
const CACHE = new Map();

async function getJson(url, timeout = 8000) {
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeout);
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) return null;
        return await res.json();
    } catch (_) {
        return null;
    }
}

/**
 * 从 alioth 补：按期 id 取出该期所有 stage 的怪，返回 stage_id -> { 怪id: 补充字段 }
 * 速报（nanoka）遇到污染怪时调用，补 HPCount / VoracityHP / IAR。
 */
export async function enrichFromAlioth(phaseId, file = 'chaos') {
    if (!phaseId) return {};
    const key = `alioth:${file}:${phaseId}`;
    if (CACHE.has(key)) return CACHE.get(key);
    const data = await getJson(`${ALIOTH_DATA}/hsr/ch/${file}/${phaseId}.json`);
    const out = {};
    if (data?.Stages) {
        for (const [stageId, stage] of Object.entries(data.Stages)) {
            const map = {};
            for (const wave of (stage.Waves ? (Array.isArray(stage.Waves) ? stage.Waves : [stage.Waves]) : [])) {
                for (const m of (wave?.Monsters || [])) {
                    if (m?.ID == null) continue;
                    const info = data.Monsters?.[String(m.ID)] || {};
                    map[String(m.ID)] = {
                        hpCount: Number(info.HPCount) > 1 ? Number(info.HPCount) : 0,
                        voracityHp: m.VoracityHP ? Number(m.VoracityHP) : 0,
                        iar: info.IAR != null ? Number(info.IAR) : null,
                    };
                }
            }
            out[String(stageId)] = map;
        }
    }
    CACHE.set(key, out);
    return out;
}

/**
 * 从 nanoka 补：按迷宫集 id 取出该期所有 stage 的污染信息，
 * 返回 stage_id -> { desc, level, healPct }。
 * 速览（alioth）遇到污染怪时调用，补机制说明与回血比例。
 */
export async function enrichFromNanoka(phaseId, version) {
    if (!phaseId || !version) return {};
    const key = `nanoka:${version}:${phaseId}`;
    if (CACHE.has(key)) return CACHE.get(key);
    const data = await getJson(`${NANOKA}/${version}/zh/maze/${phaseId}.json`);
    const out = {};
    if (Array.isArray(data)) {
        for (const row of data) {
            for (const half of ['event_id_list1', 'event_id_list2']) {
                for (const st of (row?.[half] || [])) {
                    const inv = st?.invasion;
                    if (!inv || st?.stage_id == null) continue;
                    out[String(st.stage_id)] = {
                        desc: String(inv.desc || '').replace(/\\n/g, '\n'),
                        level: Number(inv.level) || 0,
                        healPct: Number(inv.maze_buff_param?.[1]) || 0,
                    };
                }
            }
        }
    }
    CACHE.set(key, out);
    return out;
}

/** 取某个 stage 下某只怪的补充字段 */
export function pickEnrich(map, stageId, monsterId) {
    return map?.[String(stageId)]?.[String(monsterId)] || null;
}
