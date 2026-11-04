import { pluginPriority } from '#HoYoGet';
import { bh3_abyss } from './bh3_abyss.js';
import { bh3_battlefield } from './bh3_battlefield.js';
import { bh3_godwar } from './bh3_godwar.js';
import { mergeColumns, mergeSideBySide } from '../../system/bh3_merge.js';

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
      const items = [
        { buf: abyss, mode: 'period' },
        { buf: battlefield, mode: 'period' },
        { buf: godwar, mode: 'block' },
      ].filter(it => Buffer.isBuffer(it.buf));
      const merged = (await mergeColumns(items)) || (await mergeSideBySide(images));
      return sendImage(e, merged);
    } catch (err) {
      logger.error('[bh3_weekly] merge failed:', err);
      return e.reply('周常战报合成失败，请分别发送 #崩三深渊 / #崩三战场 / #崩三乐土 查看', true);
    }
  }
}
