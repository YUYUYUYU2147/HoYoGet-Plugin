import { config } from '#HoYoGet';
import fs from 'node:fs';
import { bustTplCache } from './tpl_cache.js';
// 临时自测：验证 system/ 下的模块是否随热重载重新求值。
// 置于模块顶层 —— 只要本模块被重新加载就会输出一行，无需触发任何指令。
// 日志之外再落盘一份标记，避免日志被过滤或 console 未被捕获导致误判。
// 验证通过后删除本段。
logger.info?.('[HoYoGet][热重载自测] system/render.js 模块已加载');
try { fs.appendFileSync('./plugins/HoYoGet-Plugin/temp/hot_reload.log', `${new Date().toISOString()} render.js 模块加载\n`) } catch (_) { }
/* 渲染尺寸与出图体积约束
   本机 pm2 对 JiuLi 设了 768MB 的内存上限，超限即被杀掉重启。实测
   4480x7757 的面板长图（dsf 3.2）在 Chromium 位图 + sharp 解码上就会
   逼近这个上限，因此把像素密度封顶在 2.0 倍（约 2800px 宽），并压制
   sharp 的常驻缓存与并发，避免单张图把进程推到重启。
   QQ 服务端对图片消息会缩到 1600px 宽，2800px 冗余量已经够用。 */
const MAX_DSF = 2
const SHRINK_MAX_BYTES = 3 * 1024 * 1024
const SHRINK_QUALITY_STEPS = [90, 84]
const SHRINK_MIN_WIDTH = 1200
const SHRINK_SCALE_STEP = 0.85

/* sharp 只在首次用到时加载，并关闭缓存、限制并发，降低解码大图时的内存峰值。 */
let sharpPromise = null
function getSharp() {
  if (!sharpPromise) {
    sharpPromise = (async () => {
      const sharp = (await import('sharp')).default
      sharp.cache(false)
      sharp.concurrency(1)
      return sharp
    })()
  }
  return sharpPromise
}

/* 从 segment、Buffer、base64 字符串中取出图像字节，并给出对等的回包方式。
   框架的 segment.image(file) 返回 { type, file, name } —— file 直接在顶层，
   没有 data 字段；传入 Buffer 时 file 就是 Buffer，只有在转发给协议端时才
   转成 base64:// 字符串。两种形态都要取到，否则收口会静默跳过。 */
function unpackImage(img) {
  if (Buffer.isBuffer(img)) return { buf: img, pack: b => b }
  const seg = img && typeof img === 'object' ? img : null
  const file = seg ? (seg.file ?? seg.data?.file) : (typeof img === 'string' ? img : null)
  if (Buffer.isBuffer(file)) return { buf: file, pack: b => (seg ? { ...seg, file: b } : b) }
  if (typeof file !== 'string' || !file.startsWith('base64://')) return null
  const raw = file.slice('base64://'.length)
  if (!raw) return null
  return {
    buf: Buffer.from(raw, 'base64'),
    pack: b =>
      seg
        ? { ...seg, file: `base64://${b.toString('base64')}` }
        : `base64://${b.toString('base64')}`,
  }
}

async function shrinkImage(img) {
  const unpacked = unpackImage(img)
  if (!unpacked || !unpacked.buf.length) {
    logger.debug?.(
      `[HoYoGet][render] 出图收口跳过：未识别的图片载荷（${typeof img}${img && typeof img === 'object' ? '/' + typeof img.file : ''}）`,
    );
    return img
  }
  const src = unpacked.buf
  try {
    const sharp = await getSharp()
    const meta = await sharp(src).metadata()
    const w = meta.width || 0
    const h = meta.height || 0
    if (!w || !h) return img
    if ((meta.pages || 1) > 1) return img
    if (src.length <= SHRINK_MAX_BYTES) return img
    const fmt = meta.format === 'png' ? 'png' : meta.format === 'webp' ? 'webp' : 'jpeg'
    const encode = (pipe, q) =>
      fmt === 'png'
        ? pipe.png({ compressionLevel: 9 })
        : fmt === 'webp'
          ? pipe.webp({ quality: q })
          : pipe.jpeg({ quality: q, mozjpeg: true })
    const steps = fmt === 'png' ? [0] : SHRINK_QUALITY_STEPS
    let width = w
    let best = null
    let bestQ = 0
    let picked = null
    for (let round = 0; round < 2; round++) {
      for (const q of steps) {
        const buf = await encode(
          sharp(src, { animated: false, sequentialRead: true }).resize({
            width,
            withoutEnlargement: true,
          }),
          q,
        ).toBuffer()
        if (!best || buf.length < best.length) {
          best = buf
          bestQ = q
        }
        if (buf.length <= SHRINK_MAX_BYTES) {
          picked = buf
          bestQ = q
          break
        }
      }
      if (picked) break
      width = Math.round(width * SHRINK_SCALE_STEP)
      if (width < SHRINK_MIN_WIDTH) break
    }
    const out = picked || best
    if (!out || out.length >= src.length) return img
    const outMeta = await sharp(out).metadata()
    logger.info(
      `[HoYoGet][render] 出图收口 ${w}x${h} ${(src.length / 1024).toFixed(0)}KB → ${outMeta.width}x${outMeta.height} q${bestQ} ${(out.length / 1024).toFixed(0)}KB`,
    )
    return unpacked.pack(out)
  } catch (err) {
    logger.warn?.(`[HoYoGet][render] 出图收口跳过，按原图发送：${err?.message || err}`)
    return img
  }
}

/* 对端连接短暂抖动时发送会抛错，隔几秒重试一次，避免整张图丢掉。 */
async function sendWithRetry(e, img) {
  try {
    return await e.reply(img);
  } catch (err) {
    logger.warn?.('[HoYoGet][render] 图片发送失败，3 秒后重试：' + (err?.message ? err.message : err));
    await new Promise(r => setTimeout(r, 3000));
    return await e.reply(img);
  }
}

async function render(path, data_, cfg) {
  let tplFile =
    data_.tplFile || process.cwd() + '/plugins/HoYoGet-Plugin/resources/' + path + '.html';
  /* 框架缓存了模板内容，chokidar 监听在部分环境失效 —— 改完 html 出图还是旧样子。
     按 mtime/size 主动失效，改模板即时生效。 */
  bustTplCache(tplFile);
  let { e } = cfg;
  if (!e.runtime) {
    logger.error('未找到e.runtime');
  }
  if (path.includes('bilibili')) {
    data_.emoji = config().emoji;
  }
  const img = await e.runtime.render('米哈游', path, data_, {
    retType: 'base64',
    fullPage: cfg.fullPage !== false,
    beforeRender({ data }) {
      // 本地图标（wiki/imgs/*.png）的相对路径必须按实际落盘深度算，不能写死：
      // 框架把 HTML 存在 ./temp/html/小花火/{path}/{saveId}.html，
      // 从那张 HTML 所在目录回到 TRSS-Yunzai 根要上跳「path 段数 + 3」层：
      //   wiki/gs_role_nk（2 段）→ temp/html/小花火/wiki/gs_role_nk → 5 层
      //   abyss_report/nanoka_report_sr（2 段）→ temp/html/HoYoGet/… → 5 层
      // 实测过 4 层不通（CSS 404），框架默认的 3+段数 才是对的，这里保持一致。
      // 写死层数会让 CSS 和图标全部 404 —— 页面上就变成没样式的裸 HTML：
      // 原图按原始尺寸铺开（攻略区几张武器图能占几千 px）、
      // 正文字号回到默认、角色详细那种长段落也不换行约束，图高能到 7000+ px。
      const depth = path.split('/').filter(Boolean).length + 3;
      const ppath = '../'.repeat(depth) + 'plugins/HoYoGet-Plugin/resources/';
      const scale = cfg.pct || (config().img_quality / 100) * 2.4 || 2.4 * 0.8
      const dsf = cfg.dsf ? Math.min(Number(cfg.dsf) || 0, MAX_DSF) : 0
      return {
        sys: {
          // dsf 模式不走 CSS zoom：Chromium 在 `zoom` 下元素截图会按未缩放盒裁剪，
          // 内容比量到的高度高一截时底部就被切掉（实测绝区零面板尾部的排名/版权行消失）。
          // 改成 zoom:1 + deviceScaleFactor 截图，布局尺寸不变、像素密度一样。
          scale: dsf ? 'style=zoom:1' : `style=zoom:${scale}`,
        },
        ...(dsf ? { deviceScaleFactor: dsf } : {}),
        ...data_,
        // 自定义模板目录（模板里 <% include(_tpl_path+'/x.html') %> 用），默认仍是框架给的 miao 目录
        ...(data_.tplPath ? { _tpl_path: data_.tplPath } : {}),
        ppath: data_.ppath || ppath,
        tplFile: tplFile,
        saveId: path.split('/')[path.split('/').length - 1],
      };
    },
  });
  /* 所有渲染路径统一收口：无论由本函数自发送还是调用方发送，
     都先把超出阈值的图压到安全体积（见 shrinkImage）。 */
  const payload = await shrinkImage(img);
  // ret:true 时由 render 统一用图片消息自发送；调用方不要再 e.reply，否则会重复发送。
  // 发送成功则返回 e.reply 的结果（含 message_id，供 %原图 等缓存用），失败/未发送才返回图片本身。
  if (cfg.ret && e) {
    const sent = await sendWithRetry(e, payload);
    return sent ?? payload;
  }
  return payload;
}
export default render;
