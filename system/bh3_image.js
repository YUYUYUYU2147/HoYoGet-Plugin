import sharp from 'sharp';

const MAX_IMAGE_BYTES = 1_800_000;

async function compactImage(image) {
  if (!Buffer.isBuffer(image) || image.length <= MAX_IMAGE_BYTES) return image;

  try {
    for (const quality of [82, 74, 66, 58]) {
      const result = await sharp(image).jpeg({ quality, mozjpeg: true }).toBuffer();
      if (result.length <= MAX_IMAGE_BYTES) return result;
    }
    return await sharp(image).jpeg({ quality: 50, mozjpeg: true }).toBuffer();
  } catch (err) {
    globalThis.logger?.warn?.(`[HoYoGet][bh3] 战报图片压缩失败：${err?.message || err}`);
    return image;
  }
}

export async function sendBh3Image(e, image, opts = {}) {
  const file = await compactImage(image);
  const seg = globalThis.segment?.image?.(file) || { type: 'image', data: { file } };
  try {
    if (e.group) return await e.group.sendMsg([seg]);
    if (e.friend) return await e.friend.sendMsg([seg]);
    return await e.reply(seg, true, opts);
  } catch (err) {
    globalThis.logger?.error?.(`[HoYoGet][bh3] 战报图片发送失败：${err?.message || err}`);
    const fallback = '战报已生成，但图片发送失败，请稍后重试。';
    if (e.group) return e.group.sendMsg([{ type: 'text', data: { text: fallback } }]);
    if (e.friend) return e.friend.sendMsg([{ type: 'text', data: { text: fallback } }]);
    return e.reply(fallback, true, opts);
  }
}
