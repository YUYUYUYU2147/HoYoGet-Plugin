import schedule from 'node-schedule';
import fs from 'node:fs';
import path from 'node:path';
import { pluginPriority } from '#HoYoGet';

const CONFIG_FILE = path.resolve(process.cwd(), 'data/HoYoGet-Plugin/autoGroupSign.json');

function loadCfg() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return {
      hour: Math.min(23, Math.max(0, Number(data.hour) || 0)),
      minute: Math.min(59, Math.max(0, Number(data.minute) || 0)),
    };
  } catch { return { hour: 0, minute: 0 }; }
}

async function doSign(bot) {
  if (!bot || typeof bot.sendApi !== 'function') return;
  try {
    const response = await bot.sendApi('get_group_list');
    const groups = response?.data || (Array.isArray(response) ? response : []);
    let count = 0;
    for (const group of groups) {
      if (!group?.group_id) continue;
      try {
        const result = await bot.sendApi('send_group_sign', { group_id: group.group_id });
        if (result?.retcode === 0) count++;
      } catch (err) {
        logger.warn(`[自动群打卡][${bot.uin}] 群 ${group.group_id} 打卡失败: ${err.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    logger.mark(`[自动群打卡][${bot.uin}] 完成 ${count}/${groups.length} 个群`);
  } catch (err) {
    logger.error(`[自动群打卡][${bot.uin}] 异常:`, err);
  }
}

async function tick() {
  const now = new Date();
  const cfg = loadCfg();
  if (now.getHours() !== cfg.hour || now.getMinutes() !== cfg.minute) return;
  const bots = globalThis.Bot?.bots && typeof Bot.bots === 'object'
    ? Object.values(Bot.bots).filter(bot => bot && typeof bot.sendApi === 'function')
    : [];
  for (const bot of bots) await doSign(bot);
}

const JOB_NAME = 'hoyoget-auto-group-sign';
schedule.scheduledJobs[JOB_NAME]?.cancel();
schedule.scheduleJob(JOB_NAME, '* * * * *', tick);

export class HoYoGetAutoGroupSign extends plugin {
  constructor() {
    super({
      name: '[HoYoGet]自动群打卡',
      dsc: '每天定时自动群打卡（支持多 Bot）',
      event: 'message',
      priority: pluginPriority('auto_group_sign', 5000),
    });
  }
}
