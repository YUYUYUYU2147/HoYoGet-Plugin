import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, getSource, makeForwardMsg, pluginPriority, yaml } from '#HoYoGet';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
// HoYoGet 的持久化数据统一放在插件根目录 data/ 下（迁移提示指定的新数据目录）。
const PLUGIN_DATA_DIR = path.resolve(APP_DIR, '../../data');
const DATA_DIR = path.join(PLUGIN_DATA_DIR, 'user_faces');
const IMAGE_DIR = path.join(DATA_DIR, 'images');
const DATA_FILE = path.join(DATA_DIR, 'userface.json');
const CONFIG_FILE = './plugins/HoYoGet-Plugin/config/config.yaml';
const STOP_WORDS = new Set(['结束添加', '终止添加', '停止添加', '放弃添加', '#结束添加', '#停止添加', '#放弃添加']);
let pending = new Map();

function ensureStore() {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '{}', 'utf8');
}

function readFaces() {
  ensureStore();
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (err) { logger.error(`[HoYoGet表情] 数据文件读取失败: ${err.message}`); return {}; }
}

function writeFaces(data) {
  ensureStore();
  const temp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temp, DATA_FILE);
}

function removeStoredFile(file) {
  if (!file) return;
  const resolved = path.resolve(file);
  if (!resolved.startsWith(`${IMAGE_DIR}${path.sep}`)) return;
  try { fs.unlinkSync(resolved); } catch {}
}

function settings() {
  return config() || {};
}

async function isMaster(e) {
  if (e.isMaster || e.member?.isMaster) return true;
  try {
    const { default: cfg } = await import('../../../../lib/config/config.js');
    return String(cfg.masterQQ) === String(e.user_id);
  } catch { return false; }
}

function id() { return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }

async function download(url, filename) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败 (${response.status})`);
  fs.writeFileSync(filename, Buffer.from(await response.arrayBuffer()));
}

async function storeMessage(e, tag, global = false) {
  const faces = readFaces();
  const message = Array.isArray(e.message) ? e.message : [];
  if (!message.length) return e.reply('没有收到可添加的消息');
  const record = {
    user_id: e.user_id,
    time: new Date().toISOString(),
    belong: e.isGroup && !global ? [e.group_id] : [],
    rand: [e.message_id || e.rand].filter(Boolean),
  };
  if (message.length === 1 && message[0].type === 'image') {
    const url = message[0].url || message[0].data?.url;
    if (!url) return e.reply('没有获取到图片链接');
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    const file = path.join(IMAGE_DIR, `${id()}${['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext) ? ext : '.jpg'}`);
    await download(url, file);
    record.type = 'image'; record.url = url; record.imageFile = file;
  } else if (message.length === 1 && message[0].type === 'video') {
    const url = message[0].url || message[0].data?.url;
    if (!url) return e.reply('当前协议没有提供视频链接，无法保存');
    const file = path.join(IMAGE_DIR, `${id()}.mp4`);
    await download(url, file);
    record.type = 'video'; record.videoFile = file;
  } else if (message.length === 1 && ['forward', 'json'].includes(message[0].type)) {
    record.type = 'forward'; record.msg = await getSource(e) || message;
  } else {
    record.type = 'other';
    record.msg = message.map(seg => ({ ...seg }));
  }
  (faces[tag] ||= { list: [] }).list.push(record);
  writeFaces(faces);
  await e.reply(`- ${tag} - 添加成功`);
}

function segmentFromFace(face) {
  if (face.type === 'image' && fs.existsSync(face.imageFile)) return segment.image(face.imageFile);
  if (face.type === 'video' && fs.existsSync(face.videoFile)) return segment.video(face.videoFile);
  if (face.type === 'forward') return face.msg;
  if (face.type === 'other') return face.msg;
  if (face.type === 'text') return face.content || '';
  if (face.type === 'face') return segment.face(face.id);
  return null;
}

export class HoYoGetUserFace extends plugin {
  constructor() {
    super({
      name: '[HoYoGet]自定义表情',
      dsc: '添加、管理和发送自定义表情',
      event: 'message',
      priority: pluginPriority('user_face', 80),
      rule: [
        { reg: '^#(全局)?(批量|连续|多个|持续)?添加\\s*.+$', fnc: 'add' },
        { reg: '^#?(散|san|San)?表情列表$', fnc: 'list' },
        { reg: '^#?(散|san|San)设置表情添加(开启|关闭)$', fnc: 'switch', permission: 'master' },
        { reg: '^#?(散|san|San)?(表情)?(删除|删去|去除)(全部项)?(.*?)$', fnc: 'remove' },
        { reg: '^#?(散|san|San)?来一点(.+)$', fnc: 'random' },
        { reg: '^(.*)$', fnc: 'reply', log: false },
      ],
    });
  }

  async add(e) {
    const cfg = settings();
    if (cfg.user_face_enabled === false) return e.reply('表情添加已关闭，请发送 #san设置表情添加开启');
    if (cfg.user_face_master_only && !(await isMaster(e))) return e.reply('仅主人可以添加表情');
    const match = String(e.msg || '').match(/^#(全局)?(批量|连续|多个|持续)?添加\s*(.+)$/);
    if (!match) return false;
    const [, global, repeat, tag] = match;
    const source = await getSource(e);
    if (source) {
      return storeMessage({ ...source, reply: e.reply.bind(e), isGroup: e.isGroup, group_id: e.group_id }, tag.trim(), !!global);
    }
    pending.set(String(e.user_id), { tag: tag.trim(), global: !!global, repeat: !!repeat });
    this.setContext('addNext');
    return e.reply('请发送要添加的内容；发送“结束添加”可取消');
  }

  async addNext(e) {
    const state = pending.get(String(e.user_id));
    if (!state) { this.finish('addNext'); return false; }
    const text = String(e.msg || '').trim();
    if (STOP_WORDS.has(text)) {
      pending.delete(String(e.user_id)); this.finish('addNext');
      return e.reply(state.repeat ? `- ${state.tag} - 连续添加已结束` : '已放弃本次添加');
    }
    try { await storeMessage(e, state.tag, state.global); }
    catch (err) { logger.error(`[HoYoGet表情] 添加失败: ${err.stack || err}`); await e.reply('表情添加失败，请检查消息类型或文件权限'); }
    if (!state.repeat) { pending.delete(String(e.user_id)); this.finish('addNext'); }
    return true;
  }

  async list(e) {
    const faces = readFaces();
    const keys = Object.keys(faces);
    if (!keys.length) return e.reply('当前还没有自定义表情');
    const lines = keys.map((key, i) => `${i + 1}. ${key}: ${faces[key].list?.length || 0} 项`);
    return e.reply(await makeForwardMsg(e, [`共 ${keys.length} 个表情`, lines.join('\n')], '自定义表情列表'));
  }

  async switch(e) {
    const match = String(e.msg || '').match(/设置表情添加(开启|关闭)$/);
    if (!match) return false;
    const enabled = match[1] === '开启';
    yaml.setValue(CONFIG_FILE, 'user_face_enabled', enabled);
    return e.reply(`已${match[1]}表情添加`);
  }

  async remove(e) {
    const match = String(e.msg || '').match(/^#?(?:散|san|San)?(?:表情)?(?:删除|删去|去除)(全部项)?\s*(.*?)$/);
    if (!match) return false;
    const all = !!match[1], tag = match[2].trim();
    const faces = readFaces();
    if (all || tag) {
      if (!(await isMaster(e))) return e.reply('仅主人可以删除整个表情分类');
      if (!tag || !faces[tag]) return e.reply(tag ? `没有找到表情 ${tag}` : '请提供要删除的表情名称');
      for (const face of faces[tag].list || []) removeStoredFile(face.imageFile || face.videoFile);
      delete faces[tag]; writeFaces(faces);
      return e.reply(`已删除 ${tag} 的全部内容`);
    }
    const source = await getSource(e);
    if (!source) return e.reply('请引用要删除的表情消息');
    const rand = source.message_id || source.rand || source.real_id;
    let removed = false;
    for (const key of Object.keys(faces)) {
      const list = faces[key].list || [];
      faces[key].list = list.filter(face => {
        const found = rand && face.rand?.some(value => String(value) === String(rand));
        if (found) {
          removed = true;
          removeStoredFile(face.imageFile || face.videoFile);
        }
        return !found;
      });
      if (!faces[key].list.length) delete faces[key];
    }
    if (!removed) return e.reply('没有找到对应表情');
    writeFaces(faces);
    return e.reply('已删除该项表情');
  }

  async random(e) {
    const tag = String(e.msg || '').replace(/^#?(?:散|san|San)?来一点?/, '').trim();
    const faces = readFaces();
    const list = faces[tag]?.list || [];
    if (!list.length) return e.reply(tag ? `没有找到表情 ${tag}` : '表情名称不能为空');
    const count = list.some(face => face.type === 'video') ? Math.min(5, list.length) : Math.min(50, list.length);
    const pool = [...list], messages = [];
    while (pool.length && messages.length < count) {
      const face = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
      const msg = segmentFromFace(face);
      if (msg) messages.push(msg);
    }
    if (!messages.length) return e.reply('该表情没有可发送的内容');
    return e.reply(await makeForwardMsg(e, messages, `-${tag}-`));
  }

  async reply(e) {
    if (String(e.user_id) === String(e.self_id) || !fs.existsSync(DATA_FILE)) return false;
    const text = String(e.msg || '').trim().replace(/^#/, '');
    if (!text) return false;
    const faces = readFaces(), list = faces[text]?.list || [];
    if (!list.length) return false;
    if (settings().user_face_group_separate) {
      if (!e.isGroup && !(await isMaster(e))) return false;
      if (e.isGroup && !list.some(face => !face.belong?.length || face.belong.includes(e.group_id))) return false;
    }
    const candidates = list.filter(face => !settings().user_face_group_separate || !e.isGroup || !face.belong?.length || face.belong.includes(e.group_id));
    const face = candidates[Math.floor(Math.random() * candidates.length)];
    if (!face) return false;
    let msg = segmentFromFace(face);
    if (face.type === 'forward' && Array.isArray(face.msg)) msg = await makeForwardMsg(e, face.msg, `-${text}-`);
    if (msg) await e.reply(msg);
    return false;
  }
}
