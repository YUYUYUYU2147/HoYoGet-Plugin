# 交接：绝区零（ZZZ）图鉴卡片 + 星铁列表（xhh v3）

> 本文档为**当前进行中**任务的交接说明，接手前请先读完「已验证事实」与「踩过的坑」两节。
> 上一版交接（米游社迁移）的内容已并入本文，并修正了其中若干错误结论。

分支 **v3**，全部改动**未提交**（工作区共 27 个文件被改）。
改动**仅提交本插件**（`plugins/xhh` 是子模块，根仓库只记子模块指针）。

---

## 一、当前任务状态

### 已完成并本地验证

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 绝区零角色卡（新链路） | ✅ | 米游社百科 `entry_page` + Bwiki 双源，见下表 |
| 角色详情 / 印象 / CV | ✅ | 米游社 `modules[1] / [5] / [10]` |
| 技能（按类型合并 6 组 + 左右分栏） | ✅ | 官方把一个技能拆成多条分支，按 `tab_name` 归组 |
| 影画 | ✅ | `modules[3]`，行首格形如 `LEVEL1影画名` |
| 养成材料 | ✅ | `modules[8]`，8 档（总计/初始/10…/满级） |
| 卡池信息 | ✅ | Bwiki 往期调频，S 级 + A 级、多期全列 |
| 顶部徽章 12 项 | ✅ | Bwiki 角色页为主，米游社逐项回落 |
| 攻略三块 | ✅ | Bwiki 角色页：配装 / 词条 / 音擎 |
| 星铁列表改用 Bwiki | ✅ | 角色 93 / 光锥 170 / 遗器 62 |
| 星铁列表排序 | ✅ | 测试服置顶 → 五星 → 四星，组内 Bwiki 页序 |
| 星铁卡徽章白名单 | ✅ | 10 项，见下 |
| nanoka 降级机制 | ✅ | 版本号落盘 + stale 兜底 + 冷却递增 |

### 待办

1. **测试服角色头像** —— 需先拿到日志名单（见第六节）
2. **绝区零列表头像覆盖率** —— Bwiki 仅 59 张，5 个角色未命中（见第五节）
3. **绝区零列表「洛克茜变圆形头像」** —— 用户自行改动，需确认是否保留
4. **顶部显示简称还是全名** —— 当前显示全名（「洛克茜·伊芙莉塔·普莱斯」）
5. **角色故事独立指令** —— `#绝区零角色名故事`（故事已移出卡面，指令未做）
6. **属性成长数值** —— 官方接口不返回（JS 滑块），目前留空
7. **UP 次数** —— Bwiki 往期调频只给角色名与稀有度，无次数统计

---

## 二、数据源与分工（务必分清，实测结论）

绝区零一张卡上用了**三个数据源**，各自负责不同内容：

| 内容 | 数据源 | 接口 |
| --- | --- | --- |
| 角色详情、技能、影画、养成材料 | 米游社百科 | `act-api-takumi-static.mihoyo.com/hoyowiki/zzz/wapi/entry_page?app_sn=zzz_wiki&entry_page_id={id}` |
| 顶部徽章（12 项）、攻略三块 | Bwiki 角色页 | `wiki.biligame.com/zzz/api.php?action=parse&page={角色名}` |
| 卡池信息 | Bwiki 往期调频 | 同上，`page=往期调频` |
| 列表头像 | Bwiki 首页 + nanoka | `page=首页`；nanoka 方图见第五节 |

**米游社百科必需 header**（缺了取不到）：

```
x-rpc-wiki_app: zzz
referer: https://baike.mihoyo.com/     ← 必须是根域名，带路径取不到
```

**列表 `content_id` 就是 `entry_page_id`**（实测洛克茜 `content_id=2152` → 详情 `id=2152`），
不需要单独维护 id 映射表。

**两个数据源编号体系不通用**（洛克茜 米游社 2152 / nanoka 1621），
只能按**角色名**匹配，绝不能按 id。

**已知角色 id**：艾莲 = 317、洛克茜 = 2152、克拉蕾 = 2145。

---

## 三、踩过的坑（都已修，勿重犯）

1. **`components[0].data` 是 JSON 字符串**，必须 `JSON.parse`。当对象用会导致「抓到页面但字段全空」，极易误判成要 CK。
2. **模块数据行字段是 `row` 不是 `list`** —— 影画与材料都因此解析为空。
3. **`row[i]` 可能是只含键 `"0"` 的对象**（Node 侧看是对象，Python 侧像字符串）。已用递归 `flattenText` 取值，不依赖层级。
4. **材料数量有两个来源**：认证章/记录类在 `data-entry-amount`，**芯片类只在 `data-entry-desc`**（`amount` 为 undefined）。不回落则芯片数量整列为空。
5. **不要用单条正则串起 `name→amount→img`** —— 属性顺序不固定，会整条失配（实测导致材料恒为 0）。改为以 `data-entry-name` 为锚点、在同一标签内取其余属性。
6. **`indexOf('配装推荐')` 会命中目录锚点**，切出来只有 5~7 字。必须按标题节点 `class="mw-headline"` 定位。
7. **攻略纯文本会重复小标题**（「音擎推荐/可选音擎/推荐理由」反复出现），需行级去重。
8. **技能图标只在 `animated_icon` 上**，`icon` 字段恒为 `null`。
9. **影画/米游社文案带未渲染占位符**：`#{series_refskill_desc:JiText_SeriesSkillDescFormat,151129,2}`，以及半边括号 `「欢愉]`。旧链路在 `system/wiki.js` 的 `zzzRichText` 清理，新链路在 `apps/wiki/zzz_role.js` 的 `cleanText`。
10. **`zzzPageToContent` 是 `static` 方法**，曾被写成 `this.zzzPageToContent(...)` 调用 → 每次官方详情查询必抛 `TypeError`，回落后再报 nanoka 404，两条错误叠加掩盖真实原因。已改 `this.constructor.`。
11. **art-template 不支持 `{{/* */}}` 注释**，只认 HTML 注释 `<!-- -->`。写错会让**所有游戏的所有列表一起渲染失败**（`CompileError`）。此错犯过两次。
12. **改模板前先备份**，不要靠 `git checkout` 回滚 —— 它会把同一文件里的其他改动一起还原（曾因此白做一轮）。
13. **CSS 权重**：`0,2,0` 的 `.chip-slot .chip-ic` 压得过 `0,1,1` 的 `.chip-slot img`。追加规则前先 `grep` 目标类名的现有规则。
14. **缺 `overflow:hidden` 会导致右侧被切**。原神/星铁 `.page` 都有，绝区零最初漏写，内容撑到 1056px × zoom 1.92 = 2028px，超出 body 截图宽度 → 只截到一部分。已补。
15. **`.page` 缺 `id="container"`** 时渲染器退回截 `body`。绝区零已加；原神/星铁未加但因有 `overflow:hidden` 而不受影响。

---

## 四、绝区零卡面规格

板块顺序（`resources/wiki/zzz_role_nk.html`）：

```
顶部：方形卡面 + 名字 + 稀有度 + 属性/特性/阵营 tag + 12 项徽章 + 一句话简介
角色详情（含印象） → 技能 → 影画 → 养成材料 → 攻略 → 卡池信息
```

- **技能按类型合并 6 组**：普攻 / 闪避 / 支援技 / 特殊技 / 终结技 / 核心技，
  组内分支行内流式排版（写满一行自动换行），整块**左右两栏**（`.sk-cols`，grid 1fr 1fr），角色详情仍通栏。
  合并前 16~17 条，卡高 24084px；合并后 6 组。
- **技能只展示描述文本**，不列逐级倍率表（倍率已含在描述里）。完整数据仍在 `skills[].levels`。
- **头像**用 `tachie_pc`（方形透明人物卡面），CSS `object-fit:contain`，**不能用 cover**（透明底会被裁掉人物）。

**体积实测（production zoom 1.92，JPEG q85）**：

| 角色 | 高度 | 体积 |
| --- | --- | --- |
| 艾莲 | 7459px | 1.41MB |
| 洛克茜 | 6022px | 1.26MB |

**QQ 限制 4MB**，Chromium 截图上限 65535px。此前未压缩时艾莲 4.46MB / 洛克茜 5.73MB 都发不出去。

---

## 五、绝区零列表头像（四级兜底，用户所写）

`apps/wiki.js` 的 `mergeZzzWikiIcons`：

```
1. Bwiki 角色头像-{简称}.png     方形、161×161、带透明通道、约 49KB
2. nanoka 方图 IconInterKnotRole{NN}.webp   NN 取自 character.json 的 icon 字段（IconRole68 → 0068，四位补零）
3. 米游社百科图标                  300×300，**无透明通道**，深色卡面烤进像素 → 表现为黑底方块
4. 列表原图（通常是竖版立绘）      .rank 是 cover + top center，天然上半身裁切
```

**Bwiki 覆盖率实测**（`page=首页`，59 张）：

```
列表角色 62 → Bwiki 模糊匹配命中 57
未命中 5：洛克茜·伊芙莉塔·普莱斯、赛维里安·洛威尔、菲欧妮·蕾法爱菈、
        奥菲丝·马格努森&「鬼火」、猫宫 又奈
```

**匹配用的是双向 `includes` 模糊匹配**，因为简称与文件名常不一致
（列表「安比」vs Bwiki「零号·安比」）。

**待解决**：
- 「猫宫 又奈」的简称是「猫又」，与文件名 `猫宫 又奈` **互不包含**，模糊匹配兜不住 → 建议补一张小别名表，**不要继续放宽模糊匹配**（再放宽可能把「安比」错配到别的条目）
- 测试服角色（阿哈等）在 Bwiki 与米游社都没有，nanoka 是否有 `icon` 字段决定能否出方图 → **需日志确认**

---

## 六、验证方式

**本地渲染（不需要重启 bot，推荐）**：

1. 取数：`node /tmp/opencode/measure2.mjs` 内含 `fetchZzzRoleCard()` 调用
2. art-template 编译 `resources/wiki/zzz_role_nk.html`，注入 CSS
3. 写到 `temp/dbg/`，puppeteer 以 `deviceScaleFactor:1` + 视口 1020 加载
4. **`page.$('#container')` 截图**（不是 `body`，否则宽度会被截）
5. 同时输出高度 / 宽度 / 体积，用于判断是否超 QQ 限制

脚本（`/tmp/opencode/`，重启后可能需重建）：
`measure2.mjs`（规格+体积）、`gd.mjs`（攻略去重）、`av3.mjs`（头像覆盖率）、
`drv.mjs`（配装推荐）、`sk.mjs`（技能图标）、`badge.mjs`（徽章）、`bz.mjs`（Bwiki 徽章）。

**真实链路验证**：

1. 重启：`cd /root/TRSS_AllBot/TRSS-Yunzai && bash TRSS-Yunzai.sh restart`
2. 群内发 `绝区零艾莲图鉴`、`绝区零洛克茜图鉴`、`绝区零角色图鉴`
3. 看日志：`grep -E "\[ZZZ" logs/command.*.log | tail -20`

**临时日志（napcat 开不了 debug，已改用 info 级）**：

```
[xhh][ZZZ] nanoka 方形头像 N 个                              ← system/mys.js
[xhh][ZZZ列表] 头像来源 Bwiki .. / nanoka方图 .. / 米游社 .. / 原图 ..；非方图：…   ← apps/wiki.js
```

这两行是用户要求保留的，排查完删掉即可。

---

## 七、其他未提交改动（同会话其他任务）

- **星铁列表/卡**改用 Bwiki，详见本文件外的内容；关键文件 `apps/wiki/bwiki_gs.js`、`apps/wiki/bwiki_sr.js`、`apps/wiki/bwiki_sr_guide.js`
- **星铁缩略图缓存**：`data/sr_art_thumb_w260.json`（角色 93/93 已满；260px 因列表 zoom 2.4，140px 会糊）
- **nanoka 降级机制**：`system/mys.js` 的 `getNanokaVer` 版本号落盘 + stale 兜底；冷却 10→30→60 分钟递增；绝区零列表走 nanoka 时加 6 小时缓存与降期跳过
- **CHANGELOG.md** 已全文规范化（书面语），代码段 364 / 数值 447 均未改动
- **原神/星铁列表卡框**：绝区零与星铁已统一为 90×90 方卡、金(`#b8863b→#94682a`)/紫(`#7a4fa8→#5c3a80`) 渐变

---

## 八、约束提醒

- xhh 只推 v3；v2 是正式分支，用户自己推。**每次提交前必须确认分支。**
- 用户说「有问题」而复现不出来时，**默认信用户**，并用本地渲染对照，不要反复让用户重试。
- 提交/推送前必须等用户验证通过。
- commit 正文只写已验证事实；注释与 commit 不出现「我/你/您/用户」。
- 回复一次性给全，以 `AGENT_NOTIFY_SUMMARY {...}` 单行结尾。
- 群号/QQ/UID/token 不得进仓库。
- NapCat 端**开不了 debug**（心跳刷屏），排查一律用 `logger.info`。