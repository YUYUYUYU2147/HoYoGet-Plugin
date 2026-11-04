import { Restart } from '../../../other/restart.js';
import { createRequire } from 'module';
import lodash from 'lodash';
import fs from 'node:fs';
import { yaml, config, pluginPriority, scaleStyle } from '#HoYoGet';
import { runCronTask } from '../../system/task_history.js';
import { promisify } from 'node:util';
import puppeteer from '../../../../lib/puppeteer/puppeteer.js';

const require = createRequire(import.meta.url);
const { exec, execSync } = require('child_process');
const execFile = promisify(require('child_process').execFile);

let uping = false;

export class update extends plugin {
  constructor() {
    super({
      name: '[米哈游]插件更新',
      dsc: '[米哈游]插件更新',
      event: 'message',
      priority: pluginPriority('update', 10),
      rule: [
        {
          reg: '^#*米哈游(插件)?(强制)?更新$',
          fnc: 'update',
        },
        {
          reg: '^#*米哈游(插件)?更新日志(?:\\s*(?:第\\s*)?(\\d+)(?:\\s*页)?)?$',
          fnc: 'updateLog',
        },
        {
          // 从线上补齐 meta 资源（角色/武器/圣遗物图片），不依赖 miao 插件
          reg: '^#*米哈游(强制)?(同步|更新)资源(包)?$',
          fnc: 'updateMeta',
        },
      ],
    });
    this.typeName = 'HoYoGet-Plugin';
    this.task = {
      cron: '0 30 3 * * *', //凌晨3.30自动更新
      name: '[米哈游]检查是否需要自动更新',
      fnc: () => runCronTask('自动更新检查', () => this.zd()),
      log: true,
    };
  }
  async zd() {
    if (config().update) {
      let git = await execSync('git --version', { encoding: 'utf-8' });
      if (!git || !git.includes('git version')) {
        return logger.error('未找到git');
      }
      this.oldCommitId = await this.getcommitId('HoYoGet-Plugin');
      uping = true;
      let cm =
        'cd plugins/HoYoGet-Plugin && git reset --hard && git pull --rebase --allow-unrelated-histories';
      let ret = await this.execSync(cm);
      uping = false;
      if (ret.error) {
        logger.mark('HoYoGet-Plugin 更新失败');
        return;
      }
      if (/Already up|已经是最新/g.test(ret.stdout)) {
        logger.info('HoYoGet-Plugin 已经是最新');
      } else {
        logger.info('HoYoGet-Plugin 更新成功,即将重启');
        let npm = await this.checkPnpm();
        cm = `${npm} start`;
        if (process.argv[1].includes('pm2')) {
          cm = `${npm} run restart`;
        }
        exec(cm, { windowsHide: true }, (error, stdout, stderr) => {
          if (error) {
            logger.error(`重启失败\n${error.stack}`);
          } else if (stdout) {
            logger.mark('重启成功，运行已由前台转为后台');
            logger.mark(`查看日志请用命令：${npm} run log`);
            logger.mark(`停止后台运行命令：${npm} stop`);
            process.exit();
          }
        });
      }
    }
    return;
  }

  /** 主人：同步 meta 资源（角色立绘/武器图/圣遗物图） */
  async updateMeta() {
    if (!this.e.isMaster) return false
    const force = /强制/.test(String(this.e.msg || ''))
    await this.reply(force ? '开始强制同步资源包…' : '开始同步资源包…')
    const { syncAllMeta } = await import('../../system/meta_sync.js')
    if (force) {
      // 强制模式：删掉版本标记，让它重新应用一次（会重新下载最新增量包）
      for (const game of ['gs', 'sr']) {
        try { fs.unlinkSync(`./plugins/HoYoGet-Plugin/resources/meta-${game}/.sha`) } catch (_) { }
      }
    }
    let res
    try {
      res = await syncAllMeta({ log: msg => logger.mark?.(`[HoYoGet][meta] ${msg}`) })
    } catch (err) {
      return this.reply(`同步失败：${err?.message || err}`)
    }
    const lines = res.map(r => r.error
      ? `  ${r.game}：失败 ${r.error}`
      : `  ${r.game}：${r.skipped ? '已是最新' : `更新 ${r.updated} 个提交`}（${String(r.latest || '').slice(0, 8)}）`)
    return this.reply(['资源包同步完成：', ...lines].join('\n'))
  }

  async update() {
    if (!this.e.isMaster) return false;
    if (uping) {
      await this.reply('已有命令更新中..请勿重复操作');
      return;
    }
    /** 获取插件 */
    let plugin = 'HoYoGet-Plugin';

    /** 检查git安装 */
    if (!(await this.checkGit())) return;

    /** 执行更新 */
    await this.runUpdate(plugin);

    /** 是否需要重启 */
    if (this.isUp) {
      // await this.reply('即将执行重启，以应用更新')
      setTimeout(() => this.restart(), 2000);
    }
  }

  restart() {
    new Restart(this.e).restart();
  }

  async checkGit() {
    let ret = await execSync('git --version', { encoding: 'utf-8' });
    if (!ret || !ret.includes('git version')) {
      await this.reply('请先安装git');
      return false;
    }

    return true;
  }

  async runUpdate(plugin = '') {
    this.isNowUp = false;

    let cm = `cd "plugins/${plugin}" && git pull --no-rebase`;

    let type = '更新';
    if (this.e.msg.includes('强制')) {
      type = '强制更新';
      cm = `cd "plugins/${plugin}" && git reset --hard && git pull --rebase --allow-unrelated-histories`;
    }

    this.oldCommitId = await this.getcommitId(plugin);

    await this.reply(`开始执行${type}操作...`);
    uping = true;
    let ret = await this.execSync(cm);
    uping = false;

    if (ret.error) {
      logger.mark(`${this.e.logFnc} 更新失败：${this.typeName}`);
      this.gitErr(ret.error, ret.stdout);
      return false;
    }

    let time = await this.getTime(plugin);

    if (/Already up|已经是最新/g.test(ret.stdout)) {
      await this.reply(`${this.typeName}已经是最新\n最后更新时间：${time}`);
    } else {
      await this.reply(`${this.typeName}更新成功\n更新时间：${time}`);
      this.isUp = true;
      let log = await this.getLog(plugin);
      await this.reply(log);
    }

    logger.mark(`${this.e.logFnc} 最后更新时间：${time}`);

    return true;
  }

  async gitErr(err, stdout) {
    let msg = '更新失败！';
    let errMsg = err.toString();
    stdout = stdout.toString();

    if (errMsg.includes('Timed out')) {
      let remote = errMsg.match(/'(.+?)'/g)[0].replace(/'/g, '');
      await this.reply(msg + `\n连接超时：${remote}`);
      return;
    }

    if (/Failed to connect|unable to access/g.test(errMsg)) {
      let remote = errMsg.match(/'(.+?)'/g)[0].replace(/'/g, '');
      await this.reply(msg + `\n连接失败：${remote}`);
      return;
    }

    if (errMsg.includes('be overwritten by merge')) {
      await this.reply(
        msg +
          `存在冲突：\n${errMsg}\n` +
          '请解决冲突后再更新，或者执行#米哈游强制更新，放弃本地修改'
      );
      return;
    }

    if (stdout.includes('CONFLICT')) {
      await this.reply([
        msg + '存在冲突\n',
        errMsg,
        stdout,
        '\n请解决冲突后再更新，或者执行#米哈游强制更新，放弃本地修改',
      ]);
      return;
    }

    await this.reply([errMsg, stdout]);
  }

  async getcommitId(plugin = '') {
    let cm = `cd "plugins/${plugin}" && git rev-parse --short HEAD`;

    let commitId = await execSync(cm, { encoding: 'utf-8' });
    commitId = lodash.trim(commitId);

    return commitId;
  }

  async getTime(plugin = '') {
    let cm = `cd "plugins/${plugin}" && git log -1 --pretty=format:"%cr"`;

    let time = '';
    try {
      time = await execSync(cm, { encoding: 'utf-8' });
      time = lodash.trim(time);
      time = time
        .replace(/ago/g, '前')
        .replace(/days/g, '天')
        .replace(/hours/g, '小时')
        .replace(/minutes/g, '分钟')
        .replace(/seconds/g, '秒')
        .replace(/weeks/g, '周')
        .replace(/months/g, '月')
        .replace(/ 前/g, '前');
    } catch (error) {
      logger.error(error.toString());
      time = '获取时间失败';
    }

    return time;
  }

  async execSync(cmd) {
    return new Promise((resolve, reject) => {
      exec(cmd, { windowsHide: true }, (error, stdout, stderr) => {
        resolve({ error, stdout, stderr });
      });
    });
  }

  async getLogPage(page = 1) {
    try {
      const cwd = `${process.cwd()}/plugins/HoYoGet-Plugin`;
      const { stdout: countText } = await execFile('git', ['rev-list', '--no-merges', '--count', 'HEAD'], {
        cwd, encoding: 'utf8', timeout: 15000,
      });
      const totalCommits = Number(countText.trim()) || 0;
      const totalPages = Math.max(1, Math.ceil(totalCommits / 12));
      const currentPage = Math.min(totalPages, Math.max(1, Math.trunc(Number(page)) || 1));
      const { stdout } = await execFile('git', [
        'log', '--no-merges', '--max-count=12', `--skip=${(currentPage - 1) * 12}`,
        '--format=%x1e%h%x1f%cI%x1f%s%x1f%an',
      ], { cwd, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
      const logs = stdout.split('\x1e').filter(Boolean).map((row, index) => {
        const [hash, date, subject, author] = row.trim().split('\x1f');
        const match = /^(feat|fix|perf|refactor|docs|style|test|chore|build|ci|revert)(?:\([^)]*\))?!?:\s*(.+)$/i.exec(subject || '');
        const typeNames = { feat: '新增', fix: '修复', perf: '性能', refactor: '重构', docs: '文档', style: '样式', test: '测试', chore: '维护', build: '构建', ci: '构建', revert: '回退' };
        const kinds = { feat: 'feat', fix: 'fix', perf: 'perf', docs: 'docs' };
        const type = match ? match[1].toLowerCase() : 'update';
        const displayDate = new Intl.DateTimeFormat('zh-CN', {
          timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hour12: false,
        }).format(new Date(date));
        return {
          hash,
          subject: match ? match[2] : (subject || '更新'),
          type: typeNames[type] || '更新',
          kind: kinds[type] || 'update',
          author: author || 'HoYoGet contributors',
          date: displayDate,
          number: String((currentPage - 1) * 12 + index + 1).padStart(2, '0'),
        };
      });
      return { logs, page: currentPage, totalPages, totalCommits };
    } catch (error) {
      logger.error(error.toString());
      return null;
    }
  }

  async updateLog() {
    const pageMatch = String(this.e.msg || '').match(/(?:第\s*)?(\d+)(?:\s*页)?\s*$/);
    const requestedPage = Math.max(1, Number(pageMatch?.[1]) || 1);
    const data = await this.getLogPage(requestedPage);
    if (!data) return this.reply('读取 HoYoGet 更新日志失败，请确认插件目录是 Git 仓库。');
    if (!data.logs.length) return this.reply(`第 ${data.page} 页暂无更新记录。`);

    const remote = await execFile('git', ['remote', 'get-url', 'origin'], {
      cwd: `${process.cwd()}/plugins/HoYoGet-Plugin`, encoding: 'utf8', timeout: 10000,
    }).then(result => result.stdout.trim().replace(/\.git$/, '')).catch(() => 'HoYoGet-Plugin');
    const logo = fs.readFileSync(new URL('../../resources/help/games/bh3-logo.png', import.meta.url));
    const icon = fs.readFileSync(new URL('../../resources/game_icons/bh3.webp', import.meta.url));
    const buffer = await puppeteer.render('米哈游/update_log/update_log', {
      ...data,
      repo: remote.replace(/^https?:\/\/github\.com\//, ''),
      gameLogo: `data:image/png;base64,${logo.toString('base64')}`,
      gameIcon: `data:image/webp;base64,${icon.toString('base64')}`,
      sys: { scale: scaleStyle() },
      ppath: '../../../../../plugins/HoYoGet-Plugin/resources/',
      tplFile: `${process.cwd()}/plugins/HoYoGet-Plugin/resources/update_log/update_log.html`,
      saveId: 'update_log',
      imgType: 'png',
    });
    if (!Buffer.isBuffer(buffer)) return this.reply('更新日志图片渲染失败，请检查截图服务。');
    const seg = globalThis.segment?.image?.(buffer) || { type: 'image', data: { file: buffer } };
    return this.reply(seg);
  }

  async checkPnpm() {
    let npm = 'npm';
    let ret = await this.execSync('pnpm -v');
    if (ret.stdout) npm = 'pnpm';
    return npm;
  }
}
