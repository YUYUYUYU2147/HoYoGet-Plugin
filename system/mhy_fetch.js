import __net from "node:net";
__net.setDefaultAutoSelectFamily(false);
/**
 * 走米游社的请求出口。默认直连，被风控拦了才切代理。
 *
 * 为什么要有这一层：米游社对单个 IP 有频次风控，触发后不是返回错误码而是
 * 返回一整页 HTML「已阻断」（实测表现为 HTTP 405），于是所有接口一起挂，
 * 一轮签到能直接从 51/59 掉到 41/59。
 *
 * 为什么要「被拦才切」而不是一开始就切：代理要经手我们的 Cookie
 * （ltoken + cookie_token + ltuid + account_id），那是能长期占用账号的东西。
 * 所以默认不外传，只有直连确实被拦了、这次请求本来就要发出去时才走代理。
 *
 * 代理配置（锅巴 → 接口设置，默认全空 = 不启用）：
 *   mhy_proxy      代理地址，形如 https://xxx.com/mihoyo_api
 *   mhy_proxy_key  该代理的 token，会放进 x-mihoyo-api-token 头
 *
 * 注意：一旦启用代理，走代理的请求 Cookie 会离开本机。这是知情选择，
 * 不是默认行为，所以默认关闭。
 */

import fetch from 'node-fetch';
import { config } from '#HoYoGet';

/** 米游社返回的不是 JSON 时会带这些特征，用来识别风控拦截页 */
function looksBlocked(text) {
    if (!text) return false;
    const t = String(text);
    return t.includes('已阻断') || t.includes('阻断页面') || t.includes('安全威胁');
}

/**
 * 需要改走代理的错误码。
 *
 * looksBlocked 只认 HTML 阻断页，但实测更常见的是**正常 JSON + retcode**：
 *   · 10041 设备指纹未通过 —— 机房 IP / 环境特征被判异常时也会返回它，
 *     换出口 IP 是唯一可行的自救方式；
 *   · 1034 触发验证码、10035 请求过于频繁 —— 同一类频次/IP 风控。
 * 这些都不是「代码写错」，直连再怎么重试也没用，所以一并触发代理重试。
 */
const PROXY_RETCODES = new Set([10041, 1034, 10035, 5003]);

/**
 * 这些路径不能走代理：
 *   · 社区签到（apihub/app/api/signIn）命中 1034 时要拿服务端返回的
 *     data.gt / challenge 去走验证码流程。代理会把响应换成它自己的
 *     「暂不不支持 https://bbs-api.miyoushe.com」（retcode -1），
 *     验证参数就丢了，签到永远过不了码。
 * 代理本身也只是游戏记录接口的转发，对 miyoushe 社区域名一律不支持。
 */
const NO_PROXY_PATHS = [
    '/apihub/app/api/signIn',
    '/apihub/wapi/getUserMissionsState',
];

function isNoProxyUrl(url) {
    const s = String(url || '');
    return NO_PROXY_PATHS.some(p => s.includes(p));
}

function looksBlockedJson(text) {
    if (!text) return false;
    const t = String(text).trim();
    if (!t.startsWith('{')) return false;
    try {
        const json = JSON.parse(t);
        return PROXY_RETCODES.has(Number(json?.retcode));
    } catch (_) {
        return false;
    }
}

/** 这类 host 才是米游社官方地址，别把打码平台之类的也往代理送 */
const MHY_HOSTS = [
    'api-takumi.mihoyo.com',
    'api-takumi.miyoushe.com',
    'api.mihoyo.com',
    'bbs-api.miyoushe.com',
    'bbs-api-static.miyoushe.com',
    'api-takumi-record.mihoyo.com',
    'public-operation-common.mihoyo.com',
    // 活动公告接口（原神/星铁/绝区零），429 时也要能切代理
    'hk4e-api.mihoyo.com',
    'hkrpg-api.mihoyo.com',
    'announcement-api.mihoyo.com',
];

function isMhyUrl(url) {
    const s = String(url || '');
    return MHY_HOSTS.some(h => s.includes(h));
}

/** 代理没配就返回空，配了就补齐结尾斜杠 */
export function proxyBase() {
    const base = String(config().mhy_proxy || '').trim();
    if (!base) return '';
    return base.endsWith('/') ? base.slice(0, -1) : base;
}

export function proxyEnabled() {
    return !!proxyBase() && !!String(config().mhy_proxy_key || '').trim();
}

/**
 * 被风控拦了之后走代理重试一次。
 * 返回和 fetch 一致的 { ok, status, text() }；失败返回 null 让调用方按原样处理。
 */
async function viaProxy(url, obj) {
    // 地址和 key 必须都在才算启用 —— 只配地址就发请求等于白发一次，
    // 还把 Cookie 交给一个根本不会鉴权的端点。
    if (!proxyEnabled() || !isMhyUrl(url) || isNoProxyUrl(url)) return null;
    const payload = {
        url,
        headers: obj?.headers || {},
        method: obj?.method || 'GET',
        game: gameOfUrl(url),
    };
    // body 是 JSON 字符串，原样转过去，代理会照转给米游社
    if (obj?.body) {
        try {
            payload.body = JSON.parse(obj.body);
        } catch (_) {
            payload.body = obj.body;
        }
    }
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        const resp = await fetch(`${proxyBase()}/get`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-mihoyo-api-token': String(config().mhy_proxy_key || '').trim(),
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        clearTimeout(timer);
        const text = await resp.text();
        try {
            const j = JSON.parse(text);
            // 代理不认识这个域名时会返回「暂不不支持 <url>」(retcode -1)，
            // 那是代理的免责话术，不是米游社的响应。丢掉它，让调用方
            // 继续处理直连拿到的那份（比如 1034 + data.gt 的过码参数）。
            if (Number(j?.retcode) === -1 && /暂不(支持|不支持)|暂不不支持/.test(String(j?.message || ''))) {
                return null;
            }
        } catch (_) {
            // 代理自己出问题时也会吐非 JSON，那就当没代理到
            return null;
        }
        if (config().debug) {
            logger.mark(`[HoYoGet][proxy] 直连被拦，已改走代理 ${String(url).slice(0, 80)}`);
        }
        return makeResponse(resp.ok, resp.status, text);
    } catch (err) {
        if (config().debug) logger.mark(`[HoYoGet][proxy] 代理请求失败: ${err.message}`);
        return null;
    }
}

/** 从 URL 里认出是哪个游戏，好告诉代理（它的 game 参数要用 hk4e/hkrpg/nap） */
function gameOfUrl(url) {
    const s = String(url || '');
    if (s.includes('/hkkrpg/') || s.includes('hkrpg_cn') || s.includes('act_id=e202304121516551')) return 'hkrpg';
    // 绝区零除 /nap/ 外还有两种形态：event/game_record_zzz/ 与 zzz_record。
    // 缺了后者会把面板/调频请求报成 hk4e，代理按原神处理会返回不匹配的数据。
    if (s.includes('/nap/') || s.includes('nap_cn') || s.includes('zzz_cn')
        || s.includes('game_record_zzz') || s.includes('zzz_record')
        || s.includes('act_id=e202406242138391')) return 'nap';
    return 'hk4e';
}

/**
 * 包一层，给出与 fetch 一致的 Response 形状。
 *
 * 少了 json() 会让调用方的 `.then(r => r.json())` 抛「r.json is not a function」——
 * 那是个很难联想到本模块的错误，所以这里直接把 json() 补上，别指望每个调用方都改成 text()。
 */
function makeResponse(ok, status, text) {
    return {
        ok,
        status,
        text: async () => text,
        json: async () => JSON.parse(text),
    };
}

/**
 * 出口。签名和 fetch 兼容，返回带 text() / json() 的响应对象。
 * 正常路径一个代理请求都不会发；只有直连拿到 HTML 阻断页时才试一次代理。
 */
export async function mhyFetch(url, obj = {}) {
    let resp = null;
    try {
        resp = await fetch(url, obj);
    } catch (err) {
        // 连接层面的失败（超时/DNS）不算风控，仍按原样抛给调用方
        throw err;
    }
    // 先把 body 读出来：无论是判断阻断页还是交给调用方解析，都需要文本
    const text = await resp.text();
    // HTML 阻断页、HTTP 429（限流也可能是 JSON/空 body）、
    // 以及风控 retcode（10041/1034/10035/5003）都要试一次代理
    if (resp.status !== 429 && !looksBlocked(text) && !looksBlockedJson(text)) {
        return makeResponse(resp.ok, resp.status, text);
    }
    const via = await viaProxy(url, obj);
    if (via) return via;
    // 没有代理或代理也不行，如实把被拦的事实交回去，由 api_err 归类
    return makeResponse(resp.ok, resp.status, text);
}

export default mhyFetch;
