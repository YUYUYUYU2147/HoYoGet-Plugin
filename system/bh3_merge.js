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
  const candidates = [0.04, 0.05, 0.06, 0.08, 0.10, 0.12, 0.02]
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
/**
 * 多列合成。
 * @param {{buf:Buffer, mode?:'period'|'block'}[]} items
 *   period：按「期」切分，第 N 期与其他 period 列同处一行（用于深渊/战场）
 *   block ：整块内容放一次，之后用背景把该列补到与前两列同高（用于乐土）
 * period 列全部按期配对；只要有一列识别失败就返回 null（调用方回退并排）。
 */
export async function mergeColumns(items = []) {
  if (!items.length) return null;
  const metas = await Promise.all(items.map(it => sharp(it.buf).metadata()));
  const widths = metas.map((m, i) => m.width || 620);
  const scale = Math.max(...widths.map(w => w / 620));
  const gap = Math.round(18 * scale);
  const rowGap = Math.round(10 * scale);
  const width = widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1);
  const footerHeight = Math.ceil(24 * scale);
  const bg = '#0a1b33'; // 与崩三深蓝底一致，补白不突兀

  const xs = [];
  let acc = 0;
  for (const w of widths) { xs.push(acc); acc += w + gap; }

  const periodIdx = items.map((it, i) => (it.mode === 'block' ? -1 : i)).filter(i => i >= 0);
  const blockIdx = items.map((it, i) => (it.mode === 'block' ? i : -1)).filter(i => i >= 0);

  const periods = {};
  for (const i of periodIdx) {
    periods[i] = await detectPeriods(items[i].buf, metas[i]);
    if (!periods[i] || !periods[i].cards.length) return null;
  }

  const composite = [];
  let top = 0;

  // 1) 顶部标题行：period 列各自 header；block 列整图从顶部开始
  const headerHeights = periodIdx.map(i => periods[i].header?.height || 0);
  const headerHeight = headerHeights.length ? Math.max(...headerHeights) : 0;
  for (const i of periodIdx) {
    const h = periods[i].header;
    if (h) composite.push({ input: await crop(items[i].buf, h, widths[i]), left: xs[i], top });
  }

  // block 列整块内容：从 0 开始（含它自己的页头）
  const blockBottoms = {};
  for (const i of blockIdx) {
    const h = metas[i].height || 0;
    composite.push({ input: await sharp(items[i].buf).png().toBuffer(), left: xs[i], top: 0 });
    blockBottoms[i] = h;
  }
  top = headerHeight;

  // 2) 期行：period 列按期配对
  const periodRows = [];
  const n = periodIdx.length ? Math.max(...periodIdx.map(i => periods[i].cards.length)) : 0;
  for (let k = 0; k < n; k++) {
    const cells = periodIdx.map(i => periods[i].cards[k] || null);
    periodRows.push({
      height: Math.max(0, ...cells.map(c => c?.height || 0)),
      cells,
      rowTop: top,
    });
    top += periodRows[periodRows.length - 1].height + rowGap;
  }
  let bodyBottom = n ? (top - rowGap) : headerHeight; // 前两列内容底部（可能被 block 列撑大）

  // 贴入各期
  for (const row of periodRows) {
    let y = row.rowTop;
    for (let ci = 0; ci < periodIdx.length; ci++) {
      const col = periodIdx[ci];
      const cell = row.cells[ci];
      if (cell) composite.push({ input: await crop(items[col].buf, cell, widths[col]), left: xs[col], top: y });
    }
  }

  // 3) block 列补齐到 bodyBottom：用背景色块填满剩余高度（不缩放、不重复内容）
  for (const i of blockIdx) {
    const bottom = blockBottoms[i] || 0;
    const need = bodyBottom - bottom;
    if (need > 1) {
      const filler = await sharp({
        create: { width: widths[i], height: need, channels: 3, background: bg },
      }).png().toBuffer();
      composite.push({ input: filler, left: xs[i], top: bottom });
    }
    // block 比前两列还高时，把整体高度往下扩
    if (bottom > bodyBottom) bodyBottom = bottom;
  }

  // 4) 页脚
  composite.push({
    input: footerSvg(width, footerHeight, Math.round(width / 2), scale),
    left: 0,
    top: bodyBottom,
  });

  return sharp({ create: { width, height: bodyBottom + footerHeight, channels: 3, background: '#0878cf' } })
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

