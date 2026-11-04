import { pluginPriority, scaleStyle } from '#HoYoGet';
import puppeteer from '../../../../lib/puppeteer/puppeteer.js';
import {
  fetchElysianList,
  fetchElysianDetail,
  normalizeRecommendation,
  selectRecommendation,
} from '../../system/elysian.js';

const RULE = /^#*崩三(?:往[世事]乐土|乐土)(?:(?:热门角色榜|热门榜|角色榜|热门)(?:详情|推荐)?|(?:角色)?(?:推荐)?详情)\s*(.*?)\s*$/;

function sendImage(e, buf) {
  const seg = globalThis.segment?.image?.(buf) || { type: 'image', data: { file: buf } };
  if (e.group) return e.group.sendMsg([seg]);
  if (e.friend) return e.friend.sendMsg([seg]);
  return e.reply(seg, true);
}

export class bh3_elysian extends plugin {
  constructor(e) {
    super({
      name: '[米哈游]崩三乐土热门角色榜',
      dsc: '往世乐土当期热门角色榜 / 推荐详情',
      event: 'message',
      priority: pluginPriority('bh3_elysian', 200),
      rule: [{ reg: RULE.source, fnc: 'recommend' }],
    });
  }

  async recommend(e) {
    const query = String(e.msg || '').match(RULE)?.[1] || '';
    try {
      const schedule = await fetchElysianList();
      const rows = Array.isArray(schedule.data) ? schedule.data : [];
      const data = {
        schedule,
        detail: null,
        characters: rows.map(normalizeRecommendation),
        sys: { scale: scaleStyle() },
      };

      if (query) {
        const row = selectRecommendation(rows, query);
        if (!row) {
          const list = rows.map((r, i) => `${i + 1}. ${r.avatar?.name || '未知'}`).join('\n');
          return e.reply(
            `未找到唯一匹配的热门角色，请使用榜单序号或完整角色名。\n例如：#崩三乐土详情1\n${list}`,
            true,
          );
        }
        data.detail = normalizeRecommendation(await fetchElysianDetail(row.avatar_id, schedule.schedule_id));
      }

      let buf;
      try {
        buf = await puppeteer.render('米哈游/elysian/elysian', {
          ...data,
          // 资源深度：temp/html/米哈游/elysian/ → 上跳 5 层到 TRSS 根
          ppath: '../../../../../plugins/HoYoGet-Plugin/resources/',
          tplFile: process.cwd() + '/plugins/HoYoGet-Plugin/resources/elysian/elysian.html',
          saveId: `elysian-${schedule.schedule_id}${data.detail ? '-' + data.detail.id : ''}`,
        });
      } catch (err) {
        logger.error('[bh3_elysian] render failed:', err);
      }
      if (buf && Buffer.isBuffer(buf)) return sendImage(e, buf);

      // 渲染失败的文字兜底
      if (data.detail) {
        const d = data.detail;
        return e.reply([
          `往世乐土热门角色：${d.name}`,
          '专属刻印：' + (d.exclusive.map(x => `${x.order}${x.name}`).join(' / ') || '暂无'),
          '核心刻印：' + (d.core.map(x => `${x.order}${x.name}`).join(' / ') || '暂无'),
        ].join('\n'), true);
      }
      return e.reply(rows.slice(0, 10).map((r, i) => `${i + 1}. ${r.avatar?.name || '未知'}`).join('\n'), true);
    } catch (err) {
      logger.warn(`[HoYoGet][bh3_elysian] 查询失败：${err?.message || err}`);
      return e.reply(
        '乐土热门榜查询失败：'
        + (/热门榜|推荐详情|刷新|公布/.test(String(err?.message || '')) ? err.message : '网络请求异常，请稍后重试'),
        true,
      );
    }
  }
}
