import { pluginPriority } from '#HoYoGet';
import { bh3_abyss } from './bh3_abyss.js';
import { bh3_battlefield } from './bh3_battlefield.js';
import { bh3_godwar } from './bh3_godwar.js';
import { mergeColumns, mergeSideBySide, detectPeriods } from '../../system/bh3_merge.js';

function sendImage(e, image) {
  const seg = globalThis.segment?.image?.(image) || { type: 'image', data: { file: image } };
  if (e.group) return e.group.sendMsg([seg]);
  if (e.friend) return e.friend.sendMsg([seg]);
  return e.reply(seg, true);
}

export class bh3_weekly extends plugin {
  constructor(e) {
    super({
      name: '[米哈游]崩三周常挑战',
      dsc: '崩坏3深渊 / 记忆战场 / 往世乐土 合并战报',
      event: 'message',
      priority: pluginPriority('bh3_weekly', 100),
      rule: [
        { reg: '^#*崩三周常(挑战)?$', fnc: 'weekly' },
      ],
    });
  }

  async weekly(e) {
    const abyssPlugin = new bh3_abyss(e);
    const battlefieldPlugin = new bh3_battlefield(e);
    const godwarPlugin = new bh3_godwar(e);
    const [abyss, battlefield, godwar] = await Promise.all([
      abyssPlugin._abyss(e, [
        { type: 'bh3_new_abyss', label: '超弦空间' },
        { type: 'bh3_old_abyss', label: '量子流形' },
      ], { returnBuffer: true, hideFooter: true, quality: 100 }),
      battlefieldPlugin.battlefield(e, { returnBuffer: true, hideFooter: true, quality: 100 }),
      godwarPlugin.godwar(e, { returnBuffer: true, hideFooter: true }),
    ]);

    const images = [abyss, battlefield, godwar].filter(b => Buffer.isBuffer(b));
    if (images.length < 2) {
      return e.reply('周常战报合成失败，请分别发送 #崩三深渊 / #崩三战场 / #崩三乐土 查看详情', true);
    }

    try {
      /* 乐土记录接口只给最近 2 条，内容比 8 期的深渊/战场矮。
         先量出前两列按期的总高，再让乐土把多余高度均摊到板块间距上，底部对齐。 */
      let godwarBuf = godwar;
      if (Buffer.isBuffer(abyss) && Buffer.isBuffer(battlefield) && Buffer.isBuffer(godwar)) {
        try {
          const [am, bm, gm] = await Promise.all([
            sharp(abyss).metadata(), sharp(battlefield).metadata(), sharp(godwar).metadata(),
          ]);
          const [pa, pb] = await Promise.all([detectPeriods(abyss, am), detectPeriods(battlefield, bm)]);
          logger.mark(`[bh3_weekly] 识别期数 深渊=${pa?.cards?.length ?? 0} 战场=${pb?.cards?.length ?? 0} 乐土高=${gm.height}`);
          if (pa?.cards.length && pb?.cards.length) {
            const scale = Math.max((am.width || 620) / 620, (bm.width || 620) / 620);
            const rowGap = Math.round(10 * scale);
            const headerH = Math.max(pa.header?.height || 0, pb.header?.height || 0);
            const n = Math.max(pa.cards.length, pb.cards.length);
            let target = headerH;
            for (let i = 0; i < n; i++) {
              target += Math.max(pa.cards[i]?.height || 0, pb.cards[i]?.height || 0) + rowGap;
            }
            target -= rowGap;
            const zoom = (gm.width || 640) / 640;
            const need = (target - (gm.height || 0)) / (zoom || 1);
            logger.mark(`[bh3_weekly] 两列8期总高=${Math.round(target)} 乐土高=${gm.height} 差=${Math.round(need)}`);
            /* 乐土装甲多时会比 8 期还高：按比例减少显示台数，剩余高度由合成器补白。
               乐土偏矮时不动，交给合成器补背景。 */
            if (need < -12) {
              const ratio = target / (gm.height || 1);
              const limit = Math.max(4, Math.min(16, Math.floor(12 * ratio / 2) * 2));
              godwarBuf = await godwarPlugin.godwar(e, { returnBuffer: true, hideFooter: true, transLimit: limit });
              godwar = Buffer.isBuffer(godwarBuf) ? godwarBuf : godwar;
              logger.mark(`[bh3_weekly] 乐土装甲改显示 ${limit} 台`);
            }
          }
        } catch (err) {
          logger.debug?.(`[bh3_weekly] 乐土高度补齐失败：${err?.message || err}`);
        }
      }

      const items = [
        { buf: abyss, mode: 'period' },
        { buf: battlefield, mode: 'period' },
        { buf: godwarBuf, mode: 'block' },
      ].filter(it => Buffer.isBuffer(it.buf));
      const merged = (await mergeColumns(items)) || (await mergeSideBySide(images));
      return sendImage(e, merged);
    } catch (err) {
      logger.error('[bh3_weekly] merge failed:', err);
      return e.reply('周常战报合成失败，请分别发送 #崩三深渊 / #崩三战场 / #崩三乐土 查看', true);
    }
  }
}
