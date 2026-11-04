/**
 * 崩三周常：多列长图「按期配对」合成。
 * 从各列图片左侧扫描浅色卡片条，得到每期区间，再按第 N 期拼成一行。
 */
import sharp from 'sharp'

/**
 * 检测长图里每一期卡片的纵向区间。
 * 卡片是浅色底 / 左侧黄蓝竖条，页面底色是深蓝，沿左侧一列采样即可区分。
 * 返回 { header: [0, top], cards: [{top,height}] }；识别不出时返回 null。
 */
export async function detectPeriods(buffer, meta) {
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
export function crop(buffer, { top, height }, width) {
  return sharp(buffer).extract({ left: 0, top, width, height }).png().toBuffer();
}

export function footerSvg(width, height, centerX, scale, separatorX = null) {
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

/** 三（多）列按期配对合成：同一期一行，行高取各行最高 */
export async function mergeByPeriod(images, labels = []) {
  const metas = await Promise.all(images.map(b => sharp(b).metadata()));
  const periods = await Promise.all(images.map((b, i) => detectPeriods(b, metas[i])));
  // 任意一列识别失败就退回整图并排
  if (periods.some(p => !p || !p.cards.length)) return null;

  const widths = metas.map((m, i) => m.width || periods[i].width);
  const scale = Math.max(...widths.map(w => w / 620));
  const gap = Math.round(18 * scale);
  const rowGap = Math.round(10 * scale);
  const width = widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1);
  const footerHeight = Math.ceil(24 * scale);

  // 每列 x 偏移
  const xs = [];
  let acc = 0;
  for (const w of widths) { xs.push(acc); acc += w + gap; }

  const rows = [];
  const headers = periods.map(p => p.header);
  if (headers.some(Boolean)) {
    rows.push({
      height: Math.max(...headers.map(h => h?.height || 0)),
      cells: headers,
    });
  }
  const n = Math.max(...periods.map(p => p.cards.length));
  for (let i = 0; i < n; i++) {
    const cells = periods.map(p => p.cards[i] || null);
    rows.push({ height: Math.max(...cells.map(c => c?.height || 0)), cells });
  }

  const composite = [];
  let top = 0;
  const croppedRows = await Promise.all(rows.map(async row => {
    const imgs = await Promise.all(row.cells.map((cell, i) => (
      cell ? crop(images[i], cell, widths[i]) : null
    )));
    return { row, imgs };
  }));
  for (const { row, imgs } of croppedRows) {
    imgs.forEach((buf, i) => { if (buf) composite.push({ input: buf, left: xs[i], top }); });
    top += row.height + rowGap;
  }
  const contentHeight = top - rowGap;
  composite.push({
    input: footerSvg(width, footerHeight, Math.round(width / 2), scale),
    left: 0,
    top: contentHeight,
  });

  return sharp({ create: { width, height: contentHeight + footerHeight, channels: 3, background: '#0878cf' } })
    .composite(composite)
    .jpeg({ quality: 100, mozjpeg: true })
    .toBuffer();
}

/** 兜底：整图横向并排 */
export async function mergeSideBySide(images) {
  const metas = await Promise.all(images.map(b => sharp(b).metadata()));
  const widths = metas.map((m, i) => m.width || 620);
  const heights = metas.map((m, i) => m.height || 1);
  const scale = Math.max(...widths.map(w => w / 620));
  const gap = Math.round(18 * scale);
  const footerHeight = Math.ceil(24 * scale);
  const width = widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1);
  const height = Math.max(...heights);
  const composite = [];
  let left = 0;
  for (let i = 0; i < images.length; i++) {
    composite.push({ input: await sharp(images[i]).png().toBuffer(), left, top: 0 });
    left += widths[i] + gap;
  }
  composite.push({ input: footerSvg(width, footerHeight, Math.round(width / 2), scale), left: 0, top: height });
  return sharp({ create: { width, height: height + footerHeight, channels: 3, background: '#0878cf' } })
    .composite(composite)
    .jpeg({ quality: 100, mozjpeg: true })
    .toBuffer();
}

