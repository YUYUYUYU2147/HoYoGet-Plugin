import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DATA_CATEGORIES, DataBrowserError, HoYoGetDataBrowser } from './data_browser.js';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frameworkPath = path.resolve(pluginRoot, '../Guoba-Plugin/framework/src/helper/injection.js');
const framework = fs.existsSync(frameworkPath) ? await import(pathToFileURL(frameworkPath).href) : null;
const mounted = Symbol.for('HoYoGet.data-management-page');

export function registerHoYoGetDataPage() {
  const application = framework?.instancesMap.get('tokenInterceptor')?.guobaApp;
  if (!application) {
    globalThis.logger?.warn('[HoYoGet] 未找到锅巴鉴权实例，未注册数据管理页');
    return;
  }
  mountHoYoGetDataPage(application, new HoYoGetDataBrowser(), framework.instancesMap.get('errorController')?.router);
}

export function mountHoYoGetDataPage(application, store, fallbackRouter) {
  const { app } = application;
  if (app[mounted]) return;
  const stack = (app._router || app.router)?.stack;
  const routeStart = stack?.length;
  const prefix = (application._args.prefix || '').replace(/\/$/, '');
  const page = `${prefix}/hoyoget-data/`;
  const api = `${prefix}/api/hoyoget-data`;
  const headers = {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
  };

  for (const file of ['', 'data-management.css', 'data-management.js']) {
    app.get(`${page}${file}`, (req, res) => res.set(headers).sendFile(path.join(pluginRoot, 'resources/guoba', file || 'data-management.html')));
  }
  app.get(`${page}favicon.ico`, (req, res) => res.set(headers).status(204).end());

  // 复用插件自带的游戏图标，数据页的胶囊与文件徽标直接引用
  const ICON_FILES = { gs: 'gs.webp', sr: 'sr.webp', zzz: 'zzz.webp', bh3: 'bh3.webp' };
  for (const [game, file] of Object.entries(ICON_FILES)) {
    app.get(`${page}icons/${game}.webp`, (req, res) => {
      res.set({ ...headers, 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=86400' });
      res.sendFile(path.join(pluginRoot, 'resources/game_icons', file));
    });
  }

  const handler = fn => async (req, res) => {
    res.set(headers);
    try { await fn(req, res); }
    catch (error) {
      const inputError = error instanceof DataBrowserError;
      if (!inputError) globalThis.logger?.error('[HoYoGet] 数据管理读取失败', error);
      res.status(inputError ? 400 : 500).json({ code: -1, message: inputError ? error.message : '数据读取失败，请稍后重试', result: null });
    }
  };

  app.get(`${api}/categories`, handler(async (req, res) => res.json({ code: 0, result: DATA_CATEGORIES })));
  app.get(`${api}/files`, handler(async (req, res) => res.json({ code: 0, result: await store.list(req.query) })));
  app.get(`${api}/preview`, handler(async (req, res) => res.json({ code: 0, result: await store.preview(req.query.path) })));
  app.post(`${api}/save`, handler(async (req, res) => {
    const { path: filePath, content } = req.body || {};
    const saved = await store.save(filePath, content);
    globalThis.logger?.mark?.(`[HoYoGet] 数据管理保存：${saved.path}`);
    res.json({ code: 0, result: saved });
  }));

  app.get(`${api}/download`, handler(async (req, res) => {
    const { file } = await store.file(req.query.path);
    res.attachment(path.basename(file)).type('application/octet-stream');
    await new Promise((resolve, reject) => res.sendFile(file, error => error ? reject(error) : resolve()));
  }));

  const fallbackIndex = stack?.findIndex(layer => layer.handle === fallbackRouter) ?? -1;
  if (fallbackIndex >= 0 && fallbackIndex < routeStart) {
    const routes = stack.splice(routeStart);
    stack.splice(fallbackIndex, 0, ...routes);
  }
  app[mounted] = true;
}
