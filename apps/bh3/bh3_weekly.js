import { pluginPriority } from '#HoYoGet';
import sharp from 'sharp';
import { bh3_abyss } from './bh3_abyss.js';
import { bh3_battlefield } from './bh3_battlefield.js';

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
      dsc: '崩坏3深渊与记忆战场合并战报',
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
    const [abyss, battlefield] = await Promise.all([
      abyssPlugin._abyss(e, [
        { type: 'bh3_new_abyss', label: '超弦空间' },
        { type: 'bh3_old_abyss', label: '量子流形' },
      ], { returnBuffer: true, hideFooter: true }),
      battlefieldPlugin.battlefield(e, { returnBuffer: true, hideFooter: true }),
    ]);

    if (!Buffer.isBuffer(abyss) || !Buffer.isBuffer(battlefield)) {
      return e.reply('周常战报合成失败，请分别发送 #崩三深渊 和 #崩三战场查看详情', true);
    }

    try {
      const [abyssMeta, battlefieldMeta] = await Promise.all([
        sharp(abyss).metadata(),
        sharp(battlefield).metadata(),
      ]);
      const abyssWidth = abyssMeta.width || 620;
      const battlefieldWidth = battlefieldMeta.width || abyssWidth;
      const scaleA = abyssWidth / 620;
      const scaleB = battlefieldWidth / 620;
      const findContentHeight = async (image, meta, scale) => {
        const width = meta.width || 620;
        const height = meta.height || 1;
        const sampleX = Math.min(width - 1, Math.floor(width * 0.04));
        const sampleWidth = Math.max(1, Math.min(8, width - sampleX));
        const sample = await sharp(image).extract({ left: sampleX, top: 0, width: sampleWidth, height }).raw().toBuffer({ resolveWithObject: true });
        const rowBytes = sample.info.width * sample.info.channels;
        let footerStart = height;
        for (let y = height - 1; y >= 0; y--) {
          let bluePixels = 0;
          for (let x = 0; x < sample.info.width; x++) {
            const i = y * rowBytes + x * sample.info.channels;
            if (sample.data[i] < 50 && sample.data[i + 2] > 100) bluePixels++;
          }
          if (bluePixels / sample.info.width < 0.7) break;
          footerStart = y;
        }
        return Math.max(1, footerStart || height - Math.ceil(12 * scale));
      };
      const [abyssContentHeight, battlefieldContentHeight] = await Promise.all([
        findContentHeight(abyss, abyssMeta, scaleA),
        findContentHeight(battlefield, battlefieldMeta, scaleB),
      ]);
      const contentHeight = Math.max(abyssContentHeight, battlefieldContentHeight);
      const footerHeight = Math.ceil(24 * Math.max(scaleA, scaleB));
      const abyssImage = await sharp(abyss).extract({ left: 0, top: 0, width: abyssWidth, height: abyssContentHeight }).png().toBuffer();
      const battlefieldImage = await sharp(battlefield).extract({ left: 0, top: 0, width: battlefieldWidth, height: battlefieldContentHeight }).png().toBuffer();
      const width = abyssWidth + battlefieldWidth;
      const footer = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${footerHeight}"><rect width="100%" height="100%" fill="#0878cf"/><path d="M ${abyssWidth} 0 V ${footerHeight}" stroke="#75b8e6" stroke-width="${Math.max(2, Math.round(2 * Math.max(scaleA, scaleB)))}"/><text x="${width / 2}" y="${footerHeight * 0.68}" text-anchor="middle" fill="#e5f3ff" font-family="sans-serif" font-size="${Math.max(12, Math.round(10 * Math.max(scaleA, scaleB)))}">from 米游社 · ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</text></svg>`);
      const merged = await sharp({
        create: {
          width,
          height: contentHeight + footerHeight,
          channels: 4,
          background: '#0878cf',
        },
      }).composite([
        { input: abyssImage, left: 0, top: 0 },
        { input: battlefieldImage, left: abyssWidth, top: 0 },
        { input: footer, left: 0, top: contentHeight },
      ]).png().toBuffer();
      return sendImage(e, merged);
    } catch (err) {
      logger.error('[bh3_weekly] merge failed:', err);
      return e.reply('周常战报合成失败，请分别发送 #崩三深渊 和 #崩三战场查看', true);
    }
  }
}
