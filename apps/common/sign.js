import {
    config,
    MysSign,
    zd_MysSign,
    BbsSign,
    BbsAutoSign,
    sendBbsAutoResult,
    collapseMsgs,
    yaml,
    sleep,
    pluginPriority
} from '#HoYoGet';
import lodash from 'lodash';
import Runtime from '../../../../lib/plugins/runtime.js';
import { runCronTask } from '../../system/task_history.js';

/**
 * 跨天去重的状态挂到 globalThis，而不是模块级 let。
 *
 * 原因：插件有「自举热重载」，改任意 apps/system 文件都会重新 import 本模块，
 * 新模块的模块级变量是全新的空值 —— 而框架里跑着的定时任务是**旧闭包**创建的
 * `this.scheduled_sign`，热重载只把原型方法换成新的（新方法用的是新闭包变量）。
 * 于是每热重载一次，「今日已签到」标记就被清空，定时任务下一分钟就又跑一遍签到，
 * 表现为「时不时就自动触发一次」（实测改代码期间 21:23/21:35/21:37… 反复触发）。
 * 挂到 globalThis 后新旧闭包共享同一份状态，热重载不再丢标记。
 */
const signState = (globalThis.__xhh_sign_state ||= {
    bbsDoneDay: '',
    signDoneDay: '',
    signing: false,
    bbsSigning: false,
});
// 状态字段：
//   bbsDoneDay / signDoneDay —— 各签到今日是否已跑（本地日期），用于跨天重置与当日去重；
//   signing / bbsSigning       —— 是否正在执行，用于避免手动指令与定时任务撞车。

// 本地日期指纹（年-月-日），跨天即变化，用于社区签到的每日去重。
function bbsDay() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// 各适配器 e.reply 的返回值结构不一致，尽量把 message_id 抠出来（取不到就别撤，绝不能误撤用户消息）
function pickMsgId(res) {
    if (!res) return '';
    if (Array.isArray(res)) return pickMsgId(res[0]);
    if (typeof res === 'object') return res.message_id ?? res.msg_id ?? res.data?.message_id ?? '';
    return res;
}

// 发一条会过期的临时提示：e.reply 的 recallMsg 选项在多数协议层会被静默忽略，
// 所以自己拿 message_id 定时主动撤回；不带引用（第二参数不传 true）
async function sendExpireTip(e, text, seconds = 60) {
    let msgId = '';
    try {
        msgId = pickMsgId(await e.reply(text));
    } catch (err) {
        if (config().debug) logger.mark(`[HoYoGet][bbs_sign] e.reply 失败，退回 Bot.pickXxx: ${err.message}`);
        try {
            const target = e.isGroup ? Bot?.pickGroup?.(e.group_id) : Bot?.pickFriend?.(e.user_id);
            msgId = pickMsgId(await target?.sendMsg?.(text));
        } catch (_) {}
    }
    if (config().debug) logger.mark(`[HoYoGet][bbs_sign] 稍等提示 message_id=${msgId || '未取到'}`);
    if (!msgId) return async () => {};
    let recalled = false;
    const recall = async () => {
        if (recalled) return true;
        const done = await recallOwnMsg(e, msgId);
        if (done) {
            recalled = true;
        } else if (config().debug) {
            logger.mark('[HoYoGet][bbs_sign] 稍等提示撤回失败：适配器不支持主动撤回');
        }
        return done;
    };
    // 60s 兜底撤回
    setTimeout(recall, seconds * 1000);
    // 同时返回立即撤回函数：签到结果出来后提示就没用了，调用方可以马上撤
    return recall;
}

// 撤回自己发的消息：几套 API 挨个试，有一套能用就行
async function recallOwnMsg(e, messageId) {
    if (!messageId) return false;
    const tasks = e.isGroup
        ? [
            () => e.group?.recallMsg(messageId),
            () => Bot?.pickGroup?.(e.group_id)?.recallMsg(messageId),
        ]
        : [
            () => e.friend?.recallMsg(messageId),
            () => Bot?.pickFriend?.(e.user_id)?.recallMsg(messageId),
        ];
    tasks.push(() => Bot?.deleteMsg?.(messageId), () => e.bot?.recallMsg?.(messageId));
    for (const task of tasks) {
        try {
            const ret = task();
            if (ret?.then) await ret;
            return true;
        } catch (_) {}
    }
    return false;
}

export class Sign extends plugin {
    constructor(e) {
        super({
            name: '[米哈游]签到',
            dsc: '签到',
            event: 'message',
            priority: pluginPriority('sign', -26),
            rule: [{
                    reg: '^#*米哈游*(原神|星铁|绝区零|崩三|崩坏3|崩坏三|BH3)*签到$',
                    fnc: 'sign',
                },
                {
                    reg: '^#*米哈游*全部游戏签到$',
                    fnc: 'sign',
                },
                {
                    reg: '^#米哈游*(本群)*开始签到$',
                    fnc: 'scheduled_sign',
                    permission: 'master',
                },
                {
                    reg: '^#*米哈游*((米游社|社区|论坛)(全部)?(米游社|社区|论坛)?|全部(米游社|社区|论坛))签到$',
                    fnc: 'bbsSign',
                },
                {
                    reg: '^#*米哈游*(手动验证|验证码)(服务)?(自测|测试|test)$',
                    fnc: 'gtTest',
                    permission: 'master',
                },
                {
                    reg: '^#*米哈游*(手动)?(过码|过验证码|真实过码)(端到端)?(测试|test)$',
                    fnc: 'gtRealTest',
                    permission: 'master',
                },
            ],
        });
        // 定时触发时间直接写进 cron：框架只在配置的那一刻唤起，
        // 任务表不再每分钟空转，日志里也不会出现一堆「开始处理/完成」。
        // 顺带解决「社区签到被游戏签到耗时拖过那一分钟」的老问题 ——
        // 两者是**两个独立任务**，各自按自己的时间触发，不再有同一分钟内的先后依赖。
        //
        // 注意：cron 在构造时读 sign.yaml，改配置后需 #重启 才会生效。
        const signCfg = yaml.get('./plugins/HoYoGet-Plugin/config/sign.yaml') || {};
        this.task = [{
            cron: buildSignCron(signCfg.sign_hour, signCfg.sign_minute),
            name: '[米哈游]米游社签到',
            log: true,
            fnc: async () => {
                await runCronTask('米游社签到', () => this.scheduled_sign());
            },
        },
        {
            cron: buildSignCron(signCfg.bbs_sign_hour, signCfg.bbs_sign_minute),
            name: '[米哈游]米游社社区签到',
            log: true,
            fnc: async () => {
                await runCronTask('米游社社区签到', () => this.scheduled_bbs_sign());
            },
        }];
    }

    async sign(e) {
        // 手动签到不再看 zd_sign。那个开关字面写的是「自动签到：0关闭 1开启」，
        // 只该管定时任务（scheduled_sign 内部会查），拿它挡手动指令等于
        // 「关掉自动签到 → 手动也没法签」，实测很多人被这个静默返回坑住，
        // 在群里表现为「发了 xhh签到 完全没反应」。手动是明确要求的动作，直接做。
        // 「这个命令该让给别的插件」由 config.yaml 的 sign_priority 决定，
        // 不在代码里硬写 return false —— 数字越大越晚处理，想让位就把它调大。
        // sign 是群号到QQ列表的白名单映射，不是开关，不能拿它判断。
        const signCfg = yaml.get('./plugins/HoYoGet-Plugin/config/sign.yaml') || {};
        if (signState.signing) return e.reply('有签到任务进行中, 过会儿再试吧！');
        if (e.isGroup) {
            const wl = signCfg.sign_group || [];
            if (wl.length > 0 && !wl.includes(String(e.group_id)) && !wl.includes(Number(e.group_id))) {
                return e.reply(`本群不在游戏签到白名单里，已跳过（白名单：${wl.join('、')}）\n可在锅巴「签到设置 → 游戏签到白名单群」里增删，或清空表示不限制`, true, { recallMsg: 120 });
            }
        }
        signState.signing = true;
        let recallTip;
        const allAccounts = /全部游戏/.test(e.msg || '');
        const GAME_MAP = {
            星铁: ['sr'],
            绝区零: ['zzz'],
            原神: ['gs'],
            崩三: ['bh3'],
            崩坏3: ['bh3'],
            崩坏三: ['bh3'],
            BH3: ['bh3'],
        };
        try {
            // 和社区签到一致：先发临时提示，签到结果出来后立刻撤回，60s 兜底撤回
            recallTip = await sendExpireTip(e, '正在进行米游社游戏签到，请稍等……', 60);
            for (const [key, value] of Object.entries(GAME_MAP)) {
                if (e.msg.includes(key)) {
                    await MysSign(e, value, allAccounts);
                    return false;
                }
            }

            await MysSign(e, ['gs', 'sr', 'zzz', 'bh3'], allAccounts);
        } catch (error) {
            logger.error(`签到异常: ${error.message}`);
        } finally {
            signState.signing = false;
            try { await recallTip?.(); } catch (_) {}
        }
        return false;
    }

    // 手动过码端到端测试：用真实的 createVerification 造一个真实验证码，
    // 过完码再回交 verifyVerification，能完整验证「本地服务 → 页面 → 回传 → 米游社换 challenge」整条链路。
    async gtRealTest(e) {
        const { default: api } = await import('../../system/api.js');
        const { default: mhy } = await import('../../system/mhy.js');
        const { manualGeetest } = await import('../../system/manual_geetest.js');
        const uid = e.user?.getUid?.('gs') || e.user?.getUid?.();
        if (!uid) return e.reply('未找到绑定的 UID，请先 #米哈游扫码绑定', true);
        const sk = await mhy.getstoken(e, uid);
        if (!sk) return e.reply(`UID:${uid} 未绑定米游社 SToken，请先 #米哈游扫码绑定`, true);

        const headers = mhy.getHeaders(e, sk, false);
        headers['x-rpc-client_type'] = 5;
        headers.DS = mhy.getDs2('gids=2&is_high=false', '', 4);

        const create = await api(e, { headers, type: 'createVerification' });
        if (Number(create?.retcode) !== 0 || !create?.data?.gt) {
            return e.reply(`获取验证码失败：retcode=${create?.retcode} message=${create?.message || '无'}`, true);
        }
        await e.reply(`已向米游社申请真实验证码（gt=${String(create.data.gt).slice(0, 12)}…），正在准备验证链接…`, true);
        const validated = await manualGeetest(e, { ...create.data, uid }, '手动过码端到端测试');
        if (!validated?.validate) return e.reply('未完成验证（超时或主动关闭），本次测试结束。', true);

        // 回交米游社，换取新的 challenge
        const body = JSON.stringify({
            geetest_challenge: validated.challenge || create.data.challenge,
            geetest_validate: validated.validate,
            geetest_seccode: validated.seccode || `${validated.validate}|jordan`,
        });
        const verifyHeaders = { ...headers, DS: mhy.getDs2('', body, 4) };
        const verify = await api(e, { headers: verifyHeaders, type: 'verifyVerification', body });
        if (Number(verify?.retcode) === 0) {
            return e.reply(
                `✅ 端到端测试通过\n` +
                '· 本地验证页渲染正常、Geetest 可加载\n' +
                '· 滑块结果成功回传\n' +
                '· 米游社 verifyVerification 校验通过（retcode=0），风控已解除\n' +
                '现在可以正常查体力/签到了。',
                true,
            );
        }
        return e.reply(`⚠️ 页面验证成功，但米游社回交校验失败：retcode=${verify?.retcode} message=${verify?.message || '无'}`, true);
    }

    // 手动验证服务自测
    async gtTest(e) {
        const { manualGeetestTest } = await import('../../system/manual_geetest.js');
        return manualGeetestTest(e);
    }

    async bbsSign(e) {
        // 同上：bbs_zd_sign 只管定时任务（scheduled_bbs_sign 内部会查），
        // 不再挡手动指令；让位靠 config.yaml 的 sign_priority。
        // sign 是群号到QQ列表的白名单映射，不是开关。
        const bbsCfg = yaml.get('./plugins/HoYoGet-Plugin/config/sign.yaml') || {};
        if (signState.signing || signState.bbsSigning) {
            await e.reply('有签到任务进行中, 过会儿再试吧！');
            return false;
        }
        if (e.isGroup) {
            const wl = bbsCfg.bbs_sign_group || [];
            if (wl.length > 0 && !wl.includes(String(e.group_id)) && !wl.includes(Number(e.group_id))) {
                // 之前这里直接静默返回，群里看起来就是「指令没反应」，补一句提示便于排查
                return e.reply(`本群不在社区签到白名单里，已跳过（白名单：${wl.join('、')}）\n可在锅巴「签到设置 → 社区签到白名单群」里增删，或清空表示不限制`, true, { recallMsg: 120 });
            }
        }
        signState.signing = true;
        let recallTip;
        try {
            // 只是「请稍等」的临时提示：结果出来就撤，最迟 60s 兜底撤回
            recallTip = await sendExpireTip(e, '正在进行米游社社区签到，请稍等……', 60);
            addBbs(e);
            await BbsSign(e);
        } catch (error) {
            logger.error(`社区签到异常: ${error.message}`);
        } finally {
            signState.signing = false;
            try { await recallTip?.(); } catch (_) {}
        }
        return false;
    }

    async scheduled_bbs_sign() {
        const data = yaml.get('./plugins/HoYoGet-Plugin/config/sign.yaml') || {};
        if (!data.bbs_zd_sign || !data.bbs_sign || typeof data.bbs_sign !== 'object') {
            // 常态不记：开关关着或没登记群时每天都会走到这里
            return false;
        }
        // 社区签到是独立任务、按自己的 cron 触发（不再靠游戏签到那个任务的标记），
        // 这里只保留「当日去重 + 调度漂移容差」两道判定。
        const bbsDone = signState.bbsDoneDay === bbsDay();
        const bbsCfg = clampInt(data.bbs_sign_hour, 0, 23, 0) * 60 + clampInt(data.bbs_sign_minute, 0, 59, 0);
        const bbsCur = new Date().getHours() * 60 + new Date().getMinutes();
        if (!bbsDone && (bbsCur < bbsCfg || bbsCur > bbsCfg + 10)) return false;
        // 与游戏签到撞在同一分钟时（两边配了同一时间）：游戏签到实测能跑 2 分多钟，
        // 这里原地等待它结束，而不是像以前那样「留着标记等下一分钟」——
        // 任务不再每分钟轮询，没有「下一分钟」了。
        if (signState.signing || signState.bbsSigning) {
            logger.mark(`[HoYoGet][bbs_sign] 游戏签到仍在执行，等待其结束后再跑社区签到`);
            const waited = await waitOtherSignDone();
            if (!waited) {
                logger.warn('[HoYoGet][bbs_sign] 等待游戏签到超时（10 分钟），本轮社区签到跳过');
                return false;
            }
        }
        signState.bbsDoneDay = bbsDay(); // 今日已发起，重启/漂移都不重复跑
        logger.mark('[HoYoGet][bbs_sign] 开始执行社区签到');
        signState.bbsSigning = true;
        try {
            let groups = Object.keys(data.bbs_sign || {}).filter(group =>
                Array.isArray(data.bbs_sign[group]) && data.bbs_sign[group].length > 0
            );
            if (Array.isArray(data.bbs_sign_group) && data.bbs_sign_group.length) {
                const allow = new Set(data.bbs_sign_group.map(v => String(v)));
                groups = groups.filter(group => allow.has(String(group)));
            }
            for (const group of groups) {
                const result = await BbsAutoSign(data.bbs_sign[group], group);
                // 与游戏自动签到一致：定时结果出图，渲染失败才退回文字
                let img = '';
                try {
                    img = await render('sign/sign', {
                        msgs: collapseMsgs(result.msgs || []),
                        qq: '',
                        xhhAvatar: true,
                    }, { saveId: 'bbs_auto_sign' });
                } catch (err) {
                    logger.error(`[社区自动签到] 出图失败，退回文字: ${err.message}`);
                }
                await sendBbsAutoResult(group, result, img, data);
                await sleep(1000);
            }
        } catch (error) {
            logger.error(`社区自动签到异常: ${error.message}`);
        } finally {
            signState.bbsSigning = false;
        }
        return false;
    }

    async scheduled_sign() {
        const data = yaml.get('./plugins/HoYoGet-Plugin/config/sign.yaml') || {};
        const isManual = !!this.e?.msg;
        // 手动触发（群里发指令）不受时间与今日去重限制，直接走下面的签到逻辑。
        if (!isManual) {
            // 跨天即变化：今天已成功发起过游戏自动签到则跳过，避免每分钟重复跑。
            if (signState.signDoneDay === bbsDay()) return false;
            // cron 已经只在配置那一刻触发，这里只留一层容差：
            // 调度漂移（机器繁忙、休眠唤醒）时，10 分钟内仍允许补跑；
            // 超出窗口说明这次触发异常，直接跳过，等明天。
            const cfgH = clampInt(data.sign_hour, 0, 23, 0);
            const cfgM = clampInt(data.sign_minute, 0, 59, 0);
            const now = new Date();
            const cur = now.getHours() * 60 + now.getMinutes();
            const cfg = cfgH * 60 + cfgM;
            if (cur < cfg || cur > cfg + 10) return false;

        }
        if (!data.zd_sign) return false;
        if (!data.sign || typeof data.sign != 'object' || !Object.keys(data.sign).length) {
            // 开关开着却没有群记录时静默 return，表现为「自动签到开了却什么都不做」。
            // 这个字典只有手动在群里签过一次才会写入，这里记一笔便于排查。
            logger.mark('[游戏自动签到] 开关已开，但没有任何登记群，未执行。'
                + '请在目标群里发「#加入自动签到」登记一次');
            return false;
        }
        signState.signDoneDay = bbsDay(); // 今日已发起，避免 cron 漂移后每分钟重复签到
        logger.mark(`[游戏自动签到] 开始执行（本分钟 cron 触发）`);
        signState.signing = true;
        try {

            let groups = Object.keys(data.sign).sort(
                (a, b) => data.sign[b].length - data.sign[a].length
            );
            if (this.e?.msg?.includes('本群') && this.e.isGroup)
                groups = [this.e.group_id];
            for (const group of groups) {
                if (!isAllowSignGroup(data.sign_group, group)) continue; //非白名单群
                if (!Array.isArray(data.sign[group]) || data.sign[group].length === 0) continue; //群里没人
                let data_ = {
                    qqs: data.sign[group],
                };
                let path = 'sign/list';
                //渲染
                let img = await render(path, data_);
                try {
                    Bot.pickGroup(Number(group)).sendMsg(img);
                } catch (err) {
                    logger.error(err);
                    continue;
                }
                const {
                    num,
                    z_num,
                    cg_qqs,
                    sbai_qqs
                } = await zd_MysSign(
                    data.sign[group]
                ); //开始签到
                data_ = {
                    num,
                    z_num,
                    cg_qqs,
                    sbai_qqs,
                };
                path = 'sign/end_list';
                img = await render(path, data_);
                await Bot.pickGroup(Number(group)).sendMsg(img);
                if (sbai_qqs.length) {
                    //删除签到失败的qq
                    del(sbai_qqs, group);
                    if (data.sbai) {
                        let atqq = sbai_qqs.map(v => v = segment.at(v))
                        Bot.pickGroup(Number(group)).sendMsg(atqq);
                    }
                }
                await sleep(200);
            }

        } catch (error) {
            logger.error(`自动签到异常: ${error.message}`);
        } finally {
            signState.signing = false;
        }
    }
}

function del(qqs, group) {
    const path = './plugins/HoYoGet-Plugin/config/sign.yaml';
    const data = yaml.get(path);
    data.sign[group] = removeCommonElements(data.sign[group], qqs)
    return yaml.set(path, 'sign', data.sign);
}

function isAllowSignGroup(signGroup, group) {
    // sign_group 为空数组/空值表示不限制；旧逻辑把 [] 当成 truthy，导致所有群都被跳过。
    if (!Array.isArray(signGroup) || signGroup.length === 0) return true;
    const gid = String(group);
    return signGroup.map(v => String(v)).includes(gid);
}

function addBbs(e) {
    const path = './plugins/HoYoGet-Plugin/config/sign.yaml';
    const data = yaml.get(path) || {};
    if (!data.bbs_zd_sign || !e.isGroup) return false;
    if (!isAllowSignGroup(data.bbs_sign_group, e.group_id)) return false;
    if (!data.bbs_sign || typeof data.bbs_sign !== 'object') data.bbs_sign = {};
    const group = String(e.group_id);
    const qq = String(e.user_id);
    const qqs = Array.isArray(data.bbs_sign[group]) ? data.bbs_sign[group].map(String) : [];
    if (qqs.includes(qq)) return false;
    qqs.push(qq);
    data.bbs_sign[group] = qqs;
    return yaml.set(path, 'bbs_sign', data.bbs_sign);
}


/**
 * 由配置的小时/分钟拼出 cron（6 位，含秒）：`0 分 时 * * *`。
 * 把时间交给框架调度，插件内部不再做「到点判定」。
 */
/** 等待另一个签到任务结束；超时（默认 10 分钟）返回 false */
async function waitOtherSignDone(timeoutMs = 10 * 60 * 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!signState.signing && !signState.bbsSigning) return true;
        await sleep(10000);
    }
    return false;
}

function buildSignCron(hour, minute) {
    const h = clampInt(hour, 0, 23, 0);
    const m = clampInt(minute, 0, 59, 0);
    return `0 ${m} ${h} * * *`;
}

function clampInt(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(num)));
}

function removeCommonElements(arr1, arr2) {
    // 将数组2转为Set提高查找效率
    const set2 = new Set(arr2);
    // 过滤掉数组1中存在于数组2的元素
    return arr1.filter(item => !set2.has(item));
}

async function render(path, data_, cfg = {}) {
    let tplFile = process.cwd() + '/plugins/HoYoGet-Plugin/resources/' + path + '.html';
    // 同 system/render.js：主动失效模板缓存，改完 html 不必重启
    try { const { bustTplCache } = await import('../../system/tpl_cache.js'); bustTplCache(tplFile); } catch (_) {}
    const img = await new Runtime().render('米哈游', path, data_, {
        retType: 'base64',
        beforeRender({
            data
        }) {
            /* 样式与本地图标（sign/list.css、xhh_avatar.png、mianju.png 等）全靠 ppath 定位。
               框架把 HTML 写到 temp/html/米哈游/{path}/{saveId}.html，
               从那张 HTML 回到项目根要上跳「path 段数 + 3」层 —— 与 system/render.js 同一套算法。
               此处覆盖了 beforeRender，若不自己算 ppath，模板里的 {{ppath}} 会是空串：
               样式表与本地图片全部 404，页面退化成裸 HTML（头像按原尺寸铺开、图标破图）。 */
            const depth = path.split('/').filter(Boolean).length + 3;
            return {
                // 框架注入的上下文（如 ppath）先铺一层，后面再按本插件的规则覆盖
                ...data,
                sys: {
                    /* 与 system/render.js 统一用 zoom。
                       transform:scale 不改变布局尺寸，框架按内容尺寸截图时，
                       放大后的内容会溢出而截图高度仍按未缩放的布局算，
                       成图下半部分被裁掉或露出空白（wiki 那批卡片一直用 zoom）。 */
                    scale: `style=zoom:${(config().img_quality / 100) * 2.4 || 2.4 * 0.8}`,
                },
                ...data_,
                ppath: data_.ppath || ('../'.repeat(depth) + 'plugins/HoYoGet-Plugin/resources/'),
                tplFile: tplFile,
                // sign/sign.html 被游戏签到和社区签到共用，saveId 撞了会命中对方的渲染缓存
                saveId: cfg.saveId || path.split('/')[path.split('/').length - 1],
            };
        },
    });
    return img;
}
