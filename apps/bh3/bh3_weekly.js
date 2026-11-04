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

/**
 * 检测长图里每一期卡片的纵向区间。
 * 卡片是浅色底 / 左侧黄蓝竖条，页面底色是深蓝，沿左侧一列采样即可区分。
 * 返回 { header: [0, top], cards: [{top,height}] }；识别不出时返回 null。
 */
async function detectPeriods(buffer, meta) {
  const W = meta.width || 0;
  const H = meta.height || 0;
  if (!W || !H) return null;
  const candidates = [0.01, 0.02, 0.03, 0.05]
    .map(f => Math.min(W - 1, Math.max(0, Math.round(W * f))));
  let best = null;
  for (const x of candidates) {
    let raw;
    try {
      raw = await sharp(buffer).extract({ left: x, top: 0, width: 1, height: H }).raw().toBuffer();
    } catch (_) {
      continue;
    }
    const ch = Math.max(1, Math.round(raw.length / H));
    const isCard = y => {
      const i = y * ch;
      const r = raw[i], g = raw[i + 1], b = raw[i + 2];
      if (r > 150 && g > 160 && b > 160) return true;            // 浅色卡面
      if (r > 180 && g > 140 && b < 140) return true;            // 黄色左边框
      return false;
    };
    const bands = [];
    let inBand = false, start = 0;
    for (let y = 0; y < H; y++) {
      if (isCard(y)) {
        if (!inBand) { inBand = true; start = y; }
      } else if (inBand) {
        inBand = false;
        bands.push([start, y]);
      }
    }
    if (inBand) bands.push([start, H]);
    // 卡片内部有文字/头像等暗色，短缺口合并回同一张卡
    const merged = [];
    for (const b of bands) {
      const last = merged[merged.length - 1];
      if (last && b[0] - last[1] < 15) last[1] = b[1];
      else merged.push([b[0], b[1]]);
    }
    const minH = Math.max(80, Math.round(H * 0.04));
    const cards = merged
      .filter(([a, b]) => b - a >= minH)
      .map(([a, b]) => ({ top: a, height: b - a }));
    if (!best || cards.length > best.cards.length) best = { x, cards };
  }
  if (!best || best.cards.length < 2) return null;
  const firstTop = best.cards[0].top;
  return {
    header: firstTop > 40 ? { top: 0, height: firstTop } : null,
    cards: best.cards,
    width: W,
    height: H,
  };
}

/** 把一张图按区间裁出来 */
function crop(buffer, { top, height }, width) {
  return sharp(buffer).extract({ left: 0, top, width, height }).png().toBuffer();
}

/** 老逻辑：整图左右并排（检测失败时兜底） */
async function mergeSideBySide(abyss, battlefield) {
  const [am, bm] = await Promise.all([sharp(abyss).metadata(), sharp(battlefield).metadata()]);
  const wA = am.width || 620;
  const wB = bm.width || wA;
  const hA = am.height || 1;
  const hB = bm.height || 1;
  const scale = Math.max(wA / 620, wB / 620);
  const footerHeight = Math.ceil(24 * scale);
  const width = wA + wB;
  const height = Math.max(hA, hB);
  const footer = footerSvg(width, footerHeight, Math.round(width / 2), scale);
  return sharp({ create: { width, height: height + footerHeight, channels: 3, background: '#0878cf' } })
    .composite([
      { input: await sharp(abyss).png().toBuffer(), left: 0, top: 0 },
      { input: await sharp(battlefield).png().toBuffer(), left: wA, top: 0 },
      { input: footer, left: 0, top: height },
    ])
    .jpeg({ quality: 100, mozjpeg: true })
    .toBuffer();
}

function footerSvg(width, height, centerX, scale, separatorX = null) {
  const fontSize = Math.max(12, Math.round(10 * scale));
  const sep = separatorX == null
    ? ''
    : `<path d="M ${separatorX} 0 V ${height}" stroke="#75b8e6" stroke-width="${Math.max(2, Math.round(2 * scale))}"/>`;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="100%" height="100%" fill="#0878cf"/>${sep}` +
    `<text x="${centerX}" y="${height * 0.68}" text-anchor="middle" fill="#e5f3ff" font-family="sans-serif" font-size="${fontSize}">` +
    `from 米游社 · ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}` +
    `</text></svg>`,
  );
}

/** 按期左右配对合成：同一期一行，行高取左右较高者 */
async function mergeByPeriod(abyss, battlefield) {
  const [am, bm] = await Promise.all([sharp(abyss).metadata(), sharp(battlefield).metadata()]);
  const [pa, pb] = await Promise.all([detectPeriods(abyss, am), detectPeriods(battlefield, bm)]);
  if (!pa || !pb || !pa.cards.length || !pb.cards.length) return null;

  const wA = am.width || pa.width;
  const wB = bm.width || pb.width;
  const scale = Math.max(wA / 620, wB / 620);
  const gap = Math.round(18 * scale);
  const rowGap = Math.round(10 * scale);
  const width = wA + gap + wB;
  const footerHeight = Math.ceil(24 * scale);

  const rows = [];
  // 顶部标题区：左右各自保留，拼成第一行
  if (pa.header || pb.header) {
    const hA = pa.header ? pa.header.height : 0;
    const hB = pb.header ? pb.header.height : 0;
    rows.push({
      height: Math.max(hA, hB),
      left: pa.header ? { top: pa.header.top, height: pa.header.height } : null,
      right: pb.header ? { top: pb.header.top, height: pb.header.height } : null,
    });
  }
  const n = Math.max(pa.cards.length, pb.cards.length);
  for (let i = 0; i < n; i++) {
    const l = pa.cards[i];
    const r = pb.cards[i];
    rows.push({ height: Math.max(l?.height || 0, r?.height || 0), left: l || null, right: r || null });
  }

  const totalHeight = rows.reduce((s, r) => s + r.height, 0) + rowGap * Math.max(0, rows.length - 1) + footerHeight;
  const composite = [];
  let top = 0;
  const cropped = await Promise.all(rows.map(async row => {
    const [li, ri] = await Promise.all([
      row.left ? crop(abyss, row.left, wA) : null,
      row.right ? crop(battlefield, row.right, wB) : null,
    ]);
    return { row, li, ri };
  }));
  for (const { row, li, ri } of cropped) {
    if (li) composite.push({ input: li, left: 0, top });
    if (ri) composite.push({ input: ri, left: wA + gap, top });
    top += row.height + rowGap;
  }
  const contentHeight = top - rowGap;
  composite.push({ input: footerSvg(width, footerHeight, Math.round(width / 2), scale, wA + Math.round(gap / 2)), left: 0, top: contentHeight });

  return sharp({ create: { width, height: contentHeight + footerHeight, channels: 3, background: '#0878cf' } })
    .composite(composite)
    .jpeg({ quality: 100, mozjpeg: true })
    .toBuffer();
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
      ], { returnBuffer: true, hideFooter: true, quality: 100 }),
      battlefieldPlugin.battlefield(e, { returnBuffer: true, hideFooter: true, quality: 100 }),
    ]);

    if (!Buffer.isBuffer(abyss) || !Buffer.isBuffer(battlefield)) {
      return e.reply('周常战报合成失败，请分别发送 #崩三深渊 和 #崩三战场查看详情', true);
    }

    try {
      /* 优先按期左右一一对应；识别失败再退回整图并排 */
      const merged = (await mergeByPeriod(abyss, battlefield))
        || (await mergeSideBySide(abyss, battlefield));
      return sendImage(e, merged);
    } catch (err) {
      logger.error('[bh3_weekly] merge failed:', err);
      return e.reply('周常战报合成失败，请分别发送 #崩三深渊 和 #崩三战场查看', true);
    }
  }
}
