import { render, pluginPriority, yaml } from '#HoYoGet';

const HELP_PATH = './plugins/HoYoGet-Plugin/system/default/help.yaml';
const DETAIL_HELP_PATH = './plugins/HoYoGet-Plugin/system/default/help-detail.yaml';
const HELP_URL = 'https://yuyu2147.dpdns.org/';
const GAME_HELP_ALIASES = {
  原神: ['原神'],
  星铁: ['星铁', '崩铁'],
  崩铁: ['星铁', '崩铁'],
  绝区零: ['绝区零'],
  崩三: ['崩三', '崩坏3', '崩坏三'],
  崩坏3: ['崩三', '崩坏3', '崩坏三'],
};
/* 各游戏的帮助主题：模板里落成 <body class="theme-xxx">，由 help.css 决定配色与纹理。
   没有单独主题时用 default（通用蓝白）。新增主题只需在这里加一条 + 在 css 里补
   一组 --g-* 变量，不用改模板。 */
const GAME_THEME = {
  原神: 'genshin',
  星铁: 'starrail',
  崩铁: 'starrail',
  绝区零: 'zzz',
  崩三: 'honkai3',
  崩坏3: 'honkai3',
};
/* 帮助页顶部标题/副标题：分游戏出图时换成游戏名，比「米哈游插件」更有指向性 */
const THEME_HEAD = {
  genshin: { title: '原神', sub: '命令帮助 · 提瓦特指南' },
  starrail: { title: '星穹铁道', sub: '命令帮助 · 星穹列车手册' },
  zzz: { title: '绝区零', sub: '命令帮助 · 绳网终端' },
  honkai3: { title: '崩坏3', sub: '命令帮助 · 休伯利安舰务' },
  default: { title: '米哈游插件', sub: '命令帮助 · 指令速查' },
};

export class help extends plugin {
  constructor(e) {
    super({
      name: '[米哈游]帮助',
      dsc: '帮助',
      event: 'message',
      priority: pluginPriority('help', 100),
      rule: [
        {
          reg: '^#*米哈游(命令|帮助|菜单|help|说明|功能|指令|使用说明)$',
          fnc: 'help',
        },
        {
          reg: '^#*米哈游(原神|星铁|崩铁|绝区零|崩三|崩坏3|卡池|图鉴|攻略|B站|b站|完整)帮助$',
          fnc: 'help',
        },
      ],
    });
  }

  async help(e) {
    try {
      const msg = String(e.msg || '').trim().replace(/^#+/, '');
      const command = msg.replace(/^米哈游/i, '');
      const game = Object.prototype.hasOwnProperty.call(GAME_HELP_ALIASES, command.replace(/帮助$/, ''))
        ? command.replace(/帮助$/, '')
        : '';
      const isDetail = /^(?:完整|卡池|图鉴|攻略|B站|b站)帮助$/.test(command) || !!game;
      const raw = yaml.get(isDetail ? DETAIL_HELP_PATH : HELP_PATH) || [];
      let data = Array.isArray(raw) ? raw : (raw.list || raw.data || []);
      if (game) {
        const aliases = GAME_HELP_ALIASES[game];
        const shared = /体力|扫码绑定|删除stoken|签到|官方当前卡池|刷新卡池数据|资源预估|余额|卡池时间|xx语音|xx图鉴/;
        data = data.filter(group => {
          if (group.group === '主人专用命令' || group.group === '设备命令') return false;
          if (game === '原神' || game === '星铁' || game === '崩铁') {
            return group.group === '原神/星铁';
          }
          return group.group === '崩坏3';
        });
        data = data.map(group => ({
          ...group,
          list: group.list.filter(item => {
            const text = `${item.title} ${item.desc}`;
            const mentionsOtherGame = /(原神|星铁|绝区零|崩三|崩坏3|崩坏三)/.test(text)
              && !aliases.some(alias => text.includes(alias));
            return !mentionsOtherGame && (aliases.some(alias => text.includes(alias)) || shared.test(text));
          })
        })).filter(group => group.list.length);
      } else if (isDetail) {
        const type = command.match(/^(卡池|图鉴|攻略|B站|b站)帮助$/)?.[1] || '';
        const matchers = {
          卡池: /卡池|复刻|UP|多久没复刻/,
          图鉴: /图鉴|怪物|首领|敌人|魔物/,
          攻略: /攻略|配队|配对|作业|阵容|一图流/,
          B站: /./,
          b站: /./,
        };
        if (type === 'B站' || type === 'b站') {
          data = data.filter(group => group.group === 'bilibili命令');
        } else if (matchers[type]) {
          data = data.map(group => ({
            ...group,
            list: group.list.filter(item => matchers[type].test(`${item.title} ${item.desc}`))
          })).filter(group => group.list.length);
        }
      }
      if (!data.length) {
        return e.reply('帮助内容为空，可在线查看：' + HELP_URL, true, { recallMsg: 60 });
      }
      // au 为主人时才展示「主人专用指令」分组
      const theme = game ? (GAME_THEME[game] || 'default') : 'default'
      const head = THEME_HEAD[theme] || THEME_HEAD.default
      const img = await render('help/help', {
        data,
        au: !!e.isMaster,
        theme,
        headTitle: head.title,
        headSub: head.sub,
      }, { e, pct: 1 });
      return e.reply(img);
    } catch (err) {
      logger.warn(`[HoYoGet][help] 帮助图渲染失败: ${err?.message || err}`);
      return e.reply(`米哈游命令帮助：${HELP_URL}`, true, { recallMsg: 60 });
    }
  }
}
