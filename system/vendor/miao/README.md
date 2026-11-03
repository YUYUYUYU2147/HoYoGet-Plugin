# system/vendor/miao —— 内置的数据模型

这里的代码来自 **miao-plugin**（作者 Yoimiya-Kokomi，仓库公开、作者声明可自由使用）
以及 **wiki 插件**的少量模型文件，搬进来是为了让本插件的原神/星铁面板
**不再 import 外部插件**：miao 卸载后角色名、属性计算、圣遗物评分仍然可用。

## 结构

```
system/vendor/miao/
├── components/      miao 的 Data / Cfg / Meta / Format 等
├── models/          Player / Avatar / Character / Weapon / Artifact / 评分(ArtisMark) / MysApi …
├── wiki/            被 models 依赖的 wiki 模型（Character / Weapon / Artifact / Material）
├── config/system/   Cfg 的配置 schema
├── resources/meta-gs/info/   抽卡/宝箱等零散静态数据
├── installMeta.js   原在线补全逻辑，已改为空实现（数据随插件发布）
└── path.js          替代 miao 的 #miao.path，负责解析 meta 资源根
```

## 改动说明（相对上游）

- `#miao` / `#miao.models` / `#miao.path` 改为本插件 `package.json` 里的
  `#hoyo.miao*` 别名（同时保留了 `#miao*`，供 meta 数据文件按自身作用域解析）
- 跨插件相对引用（`../../wiki/models/`、`../../miao-plugin/models/`）改成本目录内的相对路径
- `models/index.js` 只从本插件 `resources/meta-{gs,sr}` 加载 meta，不再优先读 wiki 插件
- `installMeta.js` 不再联网补全（数据已随插件发布）
- `components/Cfg.js` 的配置目录、`config/system/cfg_system.js` 的背景图列表都改成
  「目录不存在也能跑」

## 资源

- **数据**（`*.json` / `*.js`）已拷进本插件 `resources/meta-gs`、`resources/meta-sr`（约 12MB，入库）
- **图片**（立绘/图标，约 295MB）**不入库**：`path.js` 的 `metaRoot()` 按完整度给
  插件自身 resources 与外部 `plugins/miao-plugin/resources` 打分，选更完整的一个。
  只拷了数据 + 立绘（缺 `character/*/icons`、`common/`）的半套目录不会被误选；
  两边都缺图时图片由 `onerror` 隐藏。

同步资源包（`#米哈游同步资源包`）时，如果本机装了 miao-plugin，会从它的
`resources/common` 与 `resources/meta-*` 补齐缺失文件（不碰体积很大的
`profile/normal-character` 自定义立绘）。以后要完全脱离 miao，把
`plugins/miao-plugin/resources` 里的图片拷到 `plugins/HoYoGet-Plugin/resources/` 下即可。
