# 绝区零图鉴：头像链路与技能区 交接文档

> 本文件记录 2026-10-05 那一轮的全部改动与实测结论。**所有改动均未提交**，
> `plugins/xhh` 是子模块，只推 v3 分支。旧的 `ZZZ_HANDOFF.md` 仍然有效（15 条坑），
> 本文只补充本轮新增的内容，不替代它。

---

## 一、TL;DR

本轮做了 6 处代码改动 + 1 处诊断日志，**全部未提交、全部未验证**（只过了 `node --check`）。
另有一个撤回的错误改动。剩余未解决 3 项，见第五节。

---

## 二、本轮改动清单

### 1. 技能区空白（已改，未验）

`resources/wiki/zzz_role_nk.css`

```diff
-.sk-cols{display:grid;grid-template-columns:1fr 1fr;gap:0 20px;align-items:start}
-.sk-col{padding:7px 0;border-bottom:1px dashed #e6eaf0;min-width:0}
-.sk-col:nth-last-child(-n+2){border-bottom:0}
+.sk-cols{column-count:2;column-gap:20px}
+.sk-col{padding:7px 0;border-bottom:1px dashed #e6eaf0;min-width:0;
+  break-inside:avoid;-webkit-column-break-inside:avoid;page-break-inside:avoid}
+.sk-col:last-child{border-bottom:0}

-.sk-flow .sk-desc{display:inline;white-space:pre-line}
+.sk-flow .sk-desc{display:inline;white-space:normal}
```

**成因**：grid 按行对齐，同一行行高取两列较高者。「普攻」(1 分支) 与「闪避」(4 分支)
并排时普攻那列下方空出一大块；6 组排 3 行，叠起来就是技能区的一批空白。
`white-space:pre-line` 会把描述自带的 `\n` 变成硬换行，在 inline 流里同样撑空档。

**预期**：空白消失，卡面变矮变轻（此前艾莲 2494KB）。

### 2. 顶部简介的 SEO 关键词串（已改，未验）

`apps/wiki/zzz_role.js:135` 新增 `briefOf()`，`return.desc` 改用它。

Bwiki 词条页 `desc` 字段塞的是关键词串而非简介，实测原文：

```
文莲·乔,艾莲,鲨鱼,鲨鱼妹,艾莲技能,艾莲驱动盘,艾莲图鉴,…,深海访客,巡游,强攻,急冻充能,配队,配对,1.0,…
```

判据：**无句末标点（。！？；）却逗号/顿号 ≥5 个 → 判为关键词串，丢弃**。
完整描述仍保留在下面的「角色详情」面板，不丢内容。

> 已确认：角色详情保留，用户明确要求。

### 3. 顶部 tag 图标（已改，未验）

`apps/wiki/zzz_role.js` 加 `TAG_ICON` 映射 + return 新增 `damageIcon` / `professionIcon` / `campIcon`。
`zzz_role_nk.html:20` 三个 tag 加 `<img>`。
`zzz_role_nk.css:21` 加 `.tag-ic{width:14px;height:14px;object-fit:contain;flex:0 0 auto}`
并把 `.tag` 改成 `inline-flex`。

- 属性（冰/火/物理/电/以太/风）、职业（强攻/支援/防护/命破/异常/击破）用本地 `resources/wiki/imgs/zzz_*.png`（共 11 个）
- 阵营（维多利亚家政/白祇亭…）无本地图标，复用 Bwiki 徽章里的 `iconUrl`，取不到就退回纯文字

> **注意**：用户口中的「徽章没图标」其实是模板的 `.tags`（属性/职业/阵营），
> 不是 `.badges`。`.tags` 原来就没写 `<img>`。

> **已知取舍**：`TAG_ICON` 与 `system/wiki.js:149` 的 `zzzIconMap` 是同一份数据的两处拷贝。
> 新增属性时**两边都要补**。彻底干净的做法是把 `getWikiIcon` 抽成可导入模块，
> 但会动到原神/星铁/崩铁四条线，本轮没做。

### 4. nanoka 未实装角色头像（已改，未验）

**实测结论**：nanoka 对未实装角色用 `IconRoleSelect{id}.webp`，不是 `IconInterKnotRole{id}.webp`。

```
https://static.nanoka.cc/assets/zzz/IconRoleSelect1631.webp   200（赛维里安）
https://static.nanoka.cc/assets/zzz/IconRoleSelect1641.webp   200（菲欧妮）
https://static.nanoka.cc/assets/zzz/IconInterKnotRole1631.webp 404
https://static.nanoka.cc/assets/zzz/IconInterKnotRole1641.webp 404
```

`system/mys.js:1332` —— `zzz_nanoka_avatar_map()` 的值从单个 URL 改成 `{icon, sel}`：

```js
map.set(name, {
  icon: `${base}/IconInterKnotRole${num}.webp`,
  sel:  `${base}/IconRoleSelect${num}.webp`
});
```

`apps/wiki.js` 三个分支的 `iconFallback` 全部接上 nanoka 的 `icon` + `sel`。
靠 `list.html` 已有的 `onerror` 链自动切换，**不做任何探测请求**。

> **原 bug**：米游社分支的 `iconFallback` 只放了 `item.icon`，等于没有第二来源。
> 未实装角色在米游社有条目但图标文件未上传（src 有值、请求 404）→ 链一断就裂图。

> 该 map 只有 `apps/wiki.js:1091` 一个调用方，已确认。

### 5. Bwiki 别名表（已改，未验）

`apps/wiki.js:1112` `ZZZ_BWIKI_ALIAS`：

```js
const ZZZ_BWIKI_ALIAS = {
  '猫宫又奈': '猫又',
  '奥菲丝·马格努森&「鬼火」': '奥菲丝&「鬼火」'
};
```

**必须优先命中 Bwiki，不能落 nanoka** —— 见第三节的圆盘问题。

另有 `ZZZ_NK_ALIAS`（nanoka 侧同样的两条），现在只是 Bwiki 失败后的第二兜底。

> Bwiki 首页 alt 里的 `&` 是 HTML 实体（`奥菲丝&amp;「鬼火」`），
> `getZzzBwikiAvatars()` 里已有解码，不要删。

### 6. Bwiki 多页抓取（已改，未验）

`getZzzBwikiAvatars()` 从只抓「首页」改成 `for (const pageName of ['首页', '未实装'])`。

「未实装」页有且仅有 **1 条**（洛克茜 227×227），正好补上首页缺的。
多 **1 次请求**，结果缓存（`_zzzBwikiAvatar`），只在首次生效。

### 7. 诊断日志（已改，未验）

`apps/wiki.js` `fuzzyHit` 加了 `tag` 参数并记录 `fuzzyTrace`，
日志尾部追加 `；模糊命中：A=>B、C=>D`。用于暴露「模糊匹配撞错角色」。

---

## 三、数据源实测结论（重要，别再重复测）

### 头像形状：靠像素实测，不靠肉眼

判据：**不透明像素占比**。内切圆 = π/4 ≈ **78.5%**，满铺方图 = 95~100%。

| 源 | 尺寸 | 不透明占比 | 四角 alpha | 结论 |
|---|---|---|---|---|
| nanoka `IconInterKnotRole*` | 200×200 | **79.1%（62 个无一例外）** | 全 0 | **标准圆盘** |
| Bwiki 猫又 | 250×250 | 95.6% | 部分 255 | 满铺方图 |
| Bwiki 奥菲丝 | 391×391 | 87.8% | `[0,0,255,255]` **不对称** | 不干净 |
| Bwiki 洛克茜 | 227×227 | 84.6% | — | 偏圆 |
| 米游社百科图标 | 300×300 | — | **无透明通道** | 深色卡面烤进像素，黑底 |

**因此**：
- nanoka 的图**永远**是圆盘，改不了（探测过 7 种命名：IconRole / IconRoleSelect /
  IconCard / RoleIcon / IconRole.png / IconInterKnotRole.png / Tachie，除已知两种外全 404）
- Bwiki 的图**每个角色都不一样**，不能假设「Bwiki 就是方的」——本轮曾因此判断错

### 圆头像的真正成因

`.ava` 本来就有金色方底（`list.css:239`，`#b8863b→#94682a`）。
所以不是「缺方底」，而是：满铺方图铺满金框看不见底，**圆盘图会露出一圈金色**。

> **「垫方底统一观感」这个方案不成立** —— 方底早就有了。本轮试过写
> `.game-zzz .box_ img{background:...}`，既被现有更高优先级规则
> （`.container.game-zzz .box_ .ava > img.rank`）覆盖，也会破坏配色，已撤回。

### 角色收录情况（全量比对，2026-10-05）

```
Bwiki 可用条目 60（首页 59 + 未实装 1）
nanoka 62
```

| 角色 | 头像来源 | 形状 |
|---|---|---|
| 猫又 | Bwiki 首页（别名命中） | 方 ✓ |
| 奥菲丝 | Bwiki 首页（别名命中） | 方 ✓ |
| 洛克茜 | Bwiki 未实装页 | 方 ✓ |
| 赛维里安 | nanoka IconRoleSelect1631 | **圆** |
| 菲欧妮 | nanoka IconRoleSelect1641 | **圆** |
| 费维里安·洛威尔 | **无** | 空白 |
| 其余 56 个 | Bwiki 首页 | 方 ✓ |

Bwiki 搜索接口**查不到费维里安**（`action=query&list=search` 返回空），
赛维里安/菲欧妮的词条页里那 59 条是**同一个导航框**，与首页重复、没有角色自己的图。

---

## 四、本轮撤回的错误改动（记录以免重犯）

**给洛克茜加 `ZZZ_NK_PREFER = ['洛克茜']` 优先用 nanoka** —— 方向完全反了，
nanoka 是圆盘源、Bwiki 才是方图源，等于把方图换成了圆图。已删除，勿再尝试。

**两次误判**：
1. 看到 nanoka 图「中线不透明 0~199 满宽」就断言是方形 —— 错，四角 alpha 也是 0，
   满宽只说明人物横跨画面，圆盘同样满足
2. 断言「Bwiki 是方图、nanoka 是圆图」—— 错，只拿猫又一个样本，Bwiki 实际 84.6%~95.6% 不一致

---

## 五、未解决问题

### A. 费维里安·洛威尔零来源

Bwiki 无词条、nanoka 无条目、米游社无图。**需要 content_id**，
拿到后加进 `zzz_nanoka_avatar_map()` 的别名逻辑即可（格式 `IconRoleSelect{id}.webp`）。

### B. 赛维里安 / 菲欧妮 是圆头像

只有图像裁切（检测圆盘 → 放大裁成方卡）能解决。**风险**：要在渲染前下载+处理图片，
卡顿和体积需重新评估。本轮未做。

### C. 日志与实际不符（未定位）

日志 `Bwiki 59 / nanoka方图 3 / 米游社 0 / 原图 0，共 62；非方图：无`
声称 62 个**全部匹配成功**，但本地复现「费维里安·洛威尔」「菲欧妮·看法竞」
在 60 个 Bwiki key 和 62 个 nanoka 条目里**精确/模糊都无匹配**。

两者矛盾。可能原因：这两个测试服角色是直读 manifest 追加的（`TEST` 角标来源），
追加时机在 `mergeZzzWikiIcons` 之后 → 从未被处理 → 没有 `icon`。
但那样计数应该是 60 而不是 62。**需要第 7 条的 `模糊命中` 日志来定位。**

---

## 六、验证方法

```bash
bash TRSS-Yunzai.sh restart          # 改动后必须重启
# 群内发：
#   绝区零角色图鉴      → 看列表
#   绝区零艾莲图鉴      → 带前缀才秒出
#   艾莲图鉴            → 不带前缀会走完原神→星铁兜底链，白等约 15 秒
```

看日志三行：

```
[xhh][ZZZ] nanoka 方形头像 N 个                        N 应为 62
[xhh][ZZZ列表] 头像来源 Bwiki ? / nanoka方图 ? / 米游社 ? / 原图 ?
[xhh][ZZZ列表] ...；非方图：…；模糊命中：A=>B          ← 本轮新增
```

像素实测脚本（判断圆/方最可靠）：

```python
from PIL import Image
im = Image.open(p).convert('RGBA'); w, h = im.size
op = sum(1 for d in list(im.getdata()) if d[3] > 10)
print(f'{w}x{h} 不透明={op/(w*h)*100:.1f}%')   # 78.5%=圆盘 95~100%=方图
```

---

## 七、坑（补充 `ZZZ_HANDOFF.md` 之外的）

1. **测 nanoka 图必须用 `assets/zzz/IconInterKnotRole{4位}.webp`**，
   不是 `zzz/{ver}/assets/...`。我一开始猜错路径，全部 404，误判成「资源不存在」。
2. **`Character.json` 的 `icon` 字段不带前缀语义**，`IconRole1641` → 数字 `1641` → 补零 4 位。
3. **Bwiki `getZzzBwikiAvatars` 只抓首页**，首页只有 59 条，不是全量 62。
4. **`miss`（非方图）名单只在「米游社」和「原图」两个分支 push**，
   所以「匹配成功但 URL 404」的角色既不在告警里也不算失败 —— 这个盲区让本轮排查绕了远路。
   第 4 项改动补齐三个分支的兜底后才消除。
5. **测试服角色名与 nanoka/Bwiki 写法不一致**（`费维里安·洛威尔` vs 无），
   且来源是 manifest 直读，合并逻辑可能覆盖不到。
6. **`art-template` 只认 HTML 注释**，改 `list.html` / `list_dense.html` 时大括号注释会导致
   CompileError，**所有游戏列表一起挂**。

---

## 八、清理待办

- `apps/wiki.js:1186` 的临时 `logger.info`（头像来源那行）验证完应降级或删除
- `fuzzyTrace` 诊断日志定位完问题后应删除
- 根仓库调试残留：`Elation`、`_403.mjs`、`_e2e_mjs`（待用户决定）
---

## 九、第二轮修复（2026-10-05 晚）

### A. 奥菲丝变黑底 —— 真因是别名查询键没归一化（不是图的问题）

**现象**：列表里只有奥菲丝是黑底，其他角色都正常。

**排查走过的弯路**（别再重复）：

1. 先怀疑「源图自带深色底板」→ 用 PIL 量 alpha，得出「完全不透明 87.2%、四角
   `[0,0,255,255]`」，误判成整块实心深色底。
2. 又怀疑「Bwiki 是圆形、nanoka 是方图」→ 量了 `IconRoleCircle49`(78.7%) 和
   `IconInterKnotRole0049`(79.2%)，误判成 nanoka 是圆盘源。
3. 中途还加了 `.icon-dark { border-radius:50%; filter:brightness() }` 和
   `img 缩到 78px 居中` 两条 CSS —— **两条都已回滚**，list.css 净改动为零。
   教训：全局 CSS 一动就是**所有游戏列表**一起挂（见第七节第 6 条）。

**真因**（`apps/wiki.js` `mergeZzzWikiIcons`）：

- `getZzzBwikiAvatars()` 存的键是 **`normalizeZzzKey()` 之后**的
  （`「」·・（）` 等符号已被剥掉），例如 `奥菲丝&鬼火`；
- 而 `ZZZ_BWIKI_ALIAS` / `ZZZ_NK_ALIAS` 拿**原文**去 `map.has()`，
  查 `'奥菲丝&「鬼火」'` 必然 miss；
- 接着模糊匹配也救不回来：列表 `item.name` 是全名
  `奥菲丝·马格努森&「鬼火」` → 归一化 `奥菲丝马格努森&鬼火`，
  与 `奥菲丝&鬼火` **互不包含**（中间夹着「马格努森」）；
- 于是落到**米游社分支**，那张 300×300 深色背景烤进像素 →列表里就是黑底。

**修法**：`bwikiHit` / `nkAliasHit` 里别名两侧都 `normalizeZzzKey()` 后再查。

**日志自证**：`[xhh][ZZZ列表] …模糊命中：…` 里**没有奥菲丝这一行**，
就是「两条路都没命中」的信号。以后先看这行，再去看图。

**排查方法教训**：

- 要还原线上分支，必须用**列表里的 `item.name`（全名）**去跑映射；
  用 `alias_name`（简称）模拟会得到相反结论。
- 顺序必须是：取源日志 → 渲染截图 → 最后才量像素。
- 想低成本看真实 CSS 效果，用系统 chromium 直接渲：
  `puppeteer.launch({executablePath:'/snap/bin/chromium', args:['--no-sandbox']})`；
  注意 snap 的 chromium **读不到 /tmp**，页面要放在 `/root/...` 下。

### B. 未实装角色（赛维里安/菲欧妮）头像

- 实测 nanoka 对未实装角色给 `IconRoleSelect{id}.webp`（256×250，200），
  而 `IconInterKnotRole{id}.webp` **404**；
  另 24 种命名（IconRoleHead / IconRoleSelect+InterKnot / IconCard /
  IconPortrait / IconAvatar …）全部 404，别再探了。
- 判定规律：**`character.json` 的 icon 数字 == nanoka 条目 id** ⇒ 没有方图资源
  （实测 1611 克拉蕾 / 1631 赛维里安 / 1641 菲欧妮三个都是）。
  `zzz_nanoka_avatar_map()` 据此给出 `hasKoth=false`。
- Bwiki 侧确认无解：赛维里安/菲欧妮词条页的 60 张 `角色头像-*.png` 全是导航框，
  `action=query&prop=images` 与 `list=allimages&aiprefix=角色头像-` 均查不到。
- 当前策略：`hasKnot===false` → 主图 `IconRoleSelect`，兜底
  `IconInterKnotRole → 米游社 → 原图`。米游社那张是**黑底**（100% 不透明），
  只能当末位兜底。

### C. Bwiki 头像形状（补第七节结论，仍然成立）

- 「角色图鉴」页 59 张：克拉蕾 163×163/88.1%、希格莉德 161×161/87.6%、
  诺姆 225×226/94.9%、佩洛伊斯 170×170/70.5% → **圆角方图**（不是圆盘）。
- nanoka 的 `IconInterKnotRole*` / `IconRoleCircle*` 才是圆盘（≈78.5% = 内切圆）。
- 全部 59~118 张都是同一模板：上方圆形头像 + 下方角色名牌条，
  名牌条占比因角色而异（26 张「顶部<75% 且底部>88% 不透明」）。
- 想统一裁掉名牌条 → `overflow:hidden` + `scale(1.25) 顶部对齐`，
  但用户反馈**放大后糊**，已否决，别再提。

### D. 攻略区（艾莲图鉴过长）

- Bwiki 每块内容渲染**两份**（`div.visible-md` 桌面版 + `div.visible-xs` 移动版），
  纯文本切片会把两份都吃进来 —— 词条推荐整块原样重复两遍（实测 1626 字符里一半是重复）。
- 修法：`bwiki_zzz.js` 只取标题下**第一张**表（`firstTable()`），并改成结构化：
  词条 → `{main:[{slot,text}], sub, reason}`；
  音擎 → `{best/alt:[{name,icon,rarity}], reason}`，丢掉每把音擎的面板+5 档技能文案。
- 「可选音擎」在页面上是**多行**，必须 `push` 累积（曾只保留最后一行，8 把丢 6 把）。
- 效果：艾莲攻略段从约 4600 字符降到约 700。

---

## 第十节：图鉴列表排序 / 全游戏别名 / 圣遗物·遗器·驱动盘统一模板

本节记录最近这批改动的**结论与坑**，测试时按第十节末尾的清单逐条验。

### A. 列表排序：唯一实现 `apps/wiki/list_order.js`

排序键只有三层，**全游戏同一套**，任何地方都不许再写按游戏的 if：

1. **测试服置顶** —— 判定统一：数据标志位（`isUnreleased/isTest/test/preview/isNew`）
   + 名字/版本关键词（`测试服|体验服|前瞻|未实装|未上线`），卡面挂 `TEST` 角标
2. **星级分层** —— 五星整组在前，然后四星、三星；绝区零 S/A/B 同理。
   像驱动盘这种「只有 S 级」的列表，这一层自动不产生差异
3. **组内最新优先** —— 按可信度选**一个**来源：`版本(4.6) > 日期 > 绝区零_ord > id`，
   同档内比数值；全都没有 → 排最后（「未知」≠「最新」）

坑（都踩过）：
- **不能取各来源的最大值**：版本 406 和 id 655 量纲不同，取 max 会让「只有 id 的老条目」
  压过「4.6 的新条目」。必须**按来源分档**（version4 > date3 > ord2 > id1），
  先比档位再比数值。
- `starRank` **必须认中文**：原神 `ji` 写「五星/四星」，星铁写「5星」，绝区零写「S级」。
  只匹配 `[1-5]` 时原神角色全落进兜底档，新旧一混就变成五星四星交错（用户实图）。
  字母等级判断要放在数字**之前**，否则 `A5` 这类写法会先被数字规则吃掉。
- 排序点必须在 **merge 之后**：版本号是 merge 时从 Bwiki 图鉴页带过来的。

测试服数据来源：`manifest.json` 的 `new.*`，六个键全收 ——
`character / weapon / lightcone / artifact / relicset / equipment`。
以前只取前三个，所以原神武器有 TEST、圣遗物遗器驱动盘没有。
米游社兜底路径（`official_tujian`）原来**只给角色**标未上线，现在按类型全量标。

绝区零补测试服条目的坑：`zzz_tujian` 的 merge 里有
`if (nameHit(keys, item.title) || nameHit(keysOf(item), item.title))`，
第二个条件是拿条目**和自己**比（`keysOf(item)[0]` 就是它自己的名字），永远命中
→ nanoka 一条都补不进来（实测官方 100 把、nanoka 103 把，补入 0 条）。
另外 `nameHit` 原来按「切段后有交集」判，`「月相」-望` 与 `「月相」-弦` 共享「月相」
→ 互相判为已存在。已改为「归一化后完全相等，或一方包含另一方且较短方 ≥3 字」。

原神武器顺序：数据层本来有 `gslogs.yaml` 卡池日期，但只是「顺序」不是「数据」，
列表层拿不到就退回按 id 排，而 nanoka 武器 id 是**按类型分段**的
（单手剑 11xxx / 双手剑 12xxx / 法器 15xxx…）→ 看起来像按类型排。
已在条目上补 `release_date`（并透传），`getGsDebut()` 补读 `lists[3]`（4★ 武器列），
覆盖 54 → 116 把。

### B. 别名统一：`apps/wiki/name_alias.js`（8243 条）

所有别名源摊平成一张 `别名 → {正式名, 游戏, 类型}` 索引，分派前先查，命中直接走对应类型：
14 张本地 yaml + 喵喵插件（**自动发现** `meta-gs`/`meta-sr` 下的 `alias.js`/`data.json`）
+ ZZZ-Plugin `alias.yaml`。写死喵喵的文件清单会漏（`meta/artifact` 不存在、
目录名从 `meta` 变 `meta-gs`、`lightcone` 变 `weapon`）。

三道闸门：
- 类别关键词（`武器/角色/遗器/图鉴`…）不参与别名解析，否则会命中一堆含该词的角色名
- 单字别名（`鱼`）只允许完全相等命中
- 「XX专武」类查询优先装备类型（`薇斯纳专武` → 武器蝶变，而不是角色薇斯纳）

数据表里混着 `desc` 这类长文本 HTML 字段，必须按「别名 ≤24 字且不含标签/换行」过滤
（否则「开拓者」会命中一整段 HTML）。遗器/圣遗物要按 `idxs` 记录的**散件→套装归属表**
归组（喵喵把套装和散件都当独立条目，直接当正式名会让散件解析成自己）。

### C. 圣遗物 / 遗器 / 驱动盘：同一模板 `resources/wiki/relic_bwiki.html`

取图与字段归一在 `apps/wiki/relic_view.js`，三个游戏一张规则表（按 alt 命名识别）：

| | 卡面方图 | 散件 | 推荐角色 | 角标 |
|---|---|---|---|---|
| 原神 | 页面无独立方图 → 用列表图标/`<套装名>.png` | `<套装><生之花…>` | `无背景-角色-X.png` | `元素火.png` |
| 星铁 | `<套装>.png` | 页签里的散件名 | `role-box` 块 | `毁灭-白.png` |
| 绝区零 | `驱动盘图标-X.png` | `驱动盘-X-A/B.png` | 米游社官方 | `图标-强攻.png` |

件数按页面实际给，别写死：原神 5 件、星铁隧洞 4 件 / 位面饰品 2 件、绝区零**6 个位置**
（Bwiki 只给 2 张，6 张在米游社 `driver_disk` 组件的 `disks_icon`）。

踩过的坑：
- **art-template 里任何位置都不能出现花括号模板语法，连 HTML 注释里也不行**。
  注释中出现一次就整模板编译失败，表现是所有这类卡片静默无反应（异常被上层 catch）。
  「原样输出」正确写法是两个大括号 + `@`；写成三个大括号同样编译失败。
- 绝区零驱动盘页上有一整排**别的盘**的图标（30 个），散件必须按「所属盘名」比对。
- 绝区零有的盘同时有合并图和分件图 → 有分件图就丢掉合并图（3 张 → 2 张）。
- 星铁遗器页「套装图标/单件图标」两行**内容完全重复**，逐行收会变成 8 个散件图 → 按 URL 去重。
- `bwiki_sr_item.js` 里推荐角色段原来写 `if (ri < 0) return;`，
  页面没有该小节时**直接返回 undefined**，把已解析的套装效果/来历全丢掉 →
  卡面只剩名字/星级/版本（星体差分机就是这样变空壳的）。只能跳过该段。

### D. 推荐角色：三家数据源不同，版式统一

| 游戏 | 来源 | 表头措辞 | 实测 |
|---|---|---|---|
| 原神 | 米游社 `角色推荐` | `角色名称/推荐原因/词缀搭配` | 63 套里部分有；老套装（血红之证）官方没写 |
| 绝区零 | 米游社 `推荐角色` | `推荐角色/推荐理由` | 荆棘玫瑰 1 人、极地重金属 2 人 |
| 星铁 | Bwiki「遗器说明」小节 = 理由；`role-box` = 推荐角色 | — | 官方米游社无此块 |

接口：`/hoyowiki/{genshin|hsr|zzz}/wapi/entry_page?app_sn=…&entry_page_id=…&lang=zh-cn`。
**必须带 `x-rpc-wiki_app`（ys/sr/zzz）请求头**，否则只返回基础信息、推荐整块消失
（绝区零 9209 字符无推荐 vs 27428 字符有推荐）。

- 绝区零一格里可能塞**多个**角色（极地重金属：艾莲·乔 + 冯·莱卡恩 同一格共享一段理由），
  只取第一个 `data-entry-name` 会漏一半。
- 星铁的「推荐角色」小节有**两块**：前面是编辑精选 `role-box`（头像是 `X.png`），
  后面是「使用到该遗器的角色」整份名单（`X竖版头像.png`，实测 15 个）。
  必须先把范围截断到第一个「竖版头像」之前，否则会把后者当推荐。
  另外**不能按「4件套」角标筛**：不死途的角标是空的，会被漏掉。
- **命途图/属性图必须排除**：`毁灭-白.png`（命途）、`雷.png`/`风.png`/`物理.png`（属性）
  与角色头像 `X.png` 形状完全一样，不排掉就会在「推荐角色」里出现一排「毁灭-白」
  （用户实图）。星铁遗器页上这两种图各有 9/7 张，是页面公共导航装饰。
  排除规则：`/-(白|黑)$/` + `/^(雷|风|物理|火|冰|虚数|量子|光|电)$/`。
  这条规则 `relic_view.js` 和 `bwiki_sr_item.js` **两边都要有**（卡面走后者）。
- 官方没写推荐 → 显示「官方暂未推荐角色」，**不拿 Bwiki 的推荐角色小节凑**
  （那页自己写着「以下内容可能存在主观性」，会出现跟套装不匹配的推荐）。
- 遗器类卡片**右上角不画角标**：遗器没有命途/属性自身属性，页面上的命途图、元素图、
  强攻类型图都是维基公共装饰（同一页会同时出现 9 张命途图 + 7 张属性图）。
  要看命途/属性请看角色卡/光锥卡。
  （若想让右上角有内容，可改成「获取途径类别」图标：侵蚀隧洞/位面饰品，尚未实现。）

### E. 本轮涉及文件

- `apps/wiki/list_order.js`（新增）统一排序
- `apps/wiki/name_alias.js`（新增）统一别名索引
- `apps/wiki/relic_view.js`（新增）遗器类取图 + 视图归一
- `apps/wiki/mihoyo_agents.js`（新增）米游社角色推荐 + 驱动盘 6 部位图
- `apps/wiki/zzz_disc_agents.js`（新增）绝区零推荐（主路径米游社，反查仅兜底）
- `apps/wiki.js`、`system/mys.js`、`apps/wiki/bwiki_gs.js`、`bwiki_zzz.js`、
  `bwiki_gs_item.js`、`bwiki_sr_item.js`
- 交接文档：测试前先看本节 **F 待测清单**
- `resources/wiki/relic_bwiki.html/.css`（新增）、`sr_item_bwiki.*`、`list.html`、`list_dense.*`
- 列表磁盘缓存：`data/sr_item_list_cache.json`、`data/zzz_disc_agents.json`

### F. 待测清单（逐条验）

| 命令 | 预期 |
|---|---|
| `#光锥图鉴` / `*光锥图鉴` | TEST 置顶；4.6→4.5→4.4…，五星组在前 |
| `#遗器图鉴` | 同上；遗器版本取自 param3 |
| `#原神武器图鉴` | TEST 置顶；按首发日新→旧，类型不再分块 |
| `#原神角色图鉴` | 五星整组在前（原神是中文「五星」，之前混排过） |
| `#绝区零音擎图鉴` | TEST 3 条（烛光诡计/禁罪囚笼/涅槃初翎）置顶 |
| `#绝区零驱动盘图鉴` | 同上 |
| `#绝区零角色图鉴` | 同上 |
| `#死水深潜的先驱图鉴` | 散件 4，推荐角色 **4**（不死途/砂金/那刻夏/黄泉），**不得出现命途图**，有「遗器说明」理由 |
| `#渊思寂虑的巨树图鉴` | 散件 2，推荐 2（加拉赫/风堇） |
| `#星体差分机图鉴` | 有 2 件套 + 815 字来历，**无推荐角色区块**（页面本来就没有） |
| `#血红之证图鉴` | 显示「官方暂未推荐角色」 |
| `#极地重金属图鉴` | 部位图 **6** 张，推荐角色 **2**（艾莲·乔/冯·莱卡恩） |
| `#荆棘玫瑰图鉴` | 部位图 6，推荐 1（克拉蕾·弗林特）+ 理由 |
| `#炉火融炼之心图鉴` | 官方推荐 2 人 + 理由 |
| `#快枪手图鉴` | 别名 → 野穗伴行的快枪手（遗器，不是武器） |
| `#看板娘图鉴` | 别名 → 三月七 |
| `#沉陆海域露莎卡图鉴` | 能出图（模板编译修好后） |

注意：Bwiki `wiki.biligame.com` 限流很凶（EdgeOne 567），连续请求会失败。
测试时若某条无反应，先看日志区分「风控拦截」还是「真没数据」；
`sr_item_list_cache.json` 有磁盘缓存，被限流时会回落到它。

---

## 第十一节：绝区零邦布卡（Bwiki + 米游社合并）

### A. 为什么两个源都要

| 数据 | 来源 | 说明 |
|---|---|---|
| 初始攻击力 / 伤害属性 / 实装版本 / 获取途径 / 阵营 / TAG | Bwiki 邦布词条 | 米游社那边版本号格式不同 |
| 技能（含 LV1~LV10 详细属性表） | Bwiki 技能块 | 米游社只有纯文本描述 |
| 突破材料 / 邦布面板 / 卡池 | Bwiki | 米游社无 |
| **基础属性五维**（生命/攻击/防御/冲击/异常掌控） | 米游社 `role_ascension` 组件 | Bwiki 没有数值 |
| **搭配组合 + 推荐理由** | 米游社 `double_col_table` | Bwiki **没有这一块** |

关键事实：**Bwiki 邦布页上那些 `角色头像-*.png` 是全站共用的代理人导航条**
（每个邦布页都一样），不能当「相关代理人」用 —— 所以配队只能取米游社。

实现：`apps/wiki/bangboo_view.js`（`fetchMihoyoBangboo` + `buildBangbooView`），
模板 `resources/wiki/zzz_yq_bwiki.html` 一个模板出所有邦布卡（Bwiki 缺哪项就少哪行，
不填占位）。

坑：
- 「阵营代理人」原来直接取纯文本，`stripHtml` 会把 `<img alt>` 里的 `安德烈.png`
  留下来，卡上出现「阵营代理人 · 安德烈.png」（用户实图）。
  已改成按 `icon1-item` 块结构化取 `角色头像-X.png` → 去前缀去扩展名。
- 米游社接口同样必须带 `x-rpc-wiki_app: zzz`，否则只剩基础信息模块。

### A2. 卡片区块顺序（用户指定，别改）

**基础属性 → 邦布面板 → 面板·附加 → 技能（含倍率） → 搭配组合 → 突破材料**

技能倍率来自米游社 `role_talent` 的 `children[].growth`：
`[{name:'1', children:[{row:[['<p>伤害倍率：128%+256%</p>…']]}]}]`，
每级一行（主动技 10 级、额外能力 5 级）。Bwiki 技能块给的是 LV1~LV10 详细属性表，
两边按类型（主动技/额外能力/邦布连携技）合并，缺哪部分留空。

**搬区块时别把 `{{if}}` 守卫丢了**：我用脚本给星铁卡重排区块顺序时，把
`{{if agents.length}}`/`{{/if}}` 留在了原地，结果「推荐角色/套装与散件/二件套/四件套」
四个空标题块无脑渲染（用户实图）。教训：整块搬移要连 `{{if}}` 一起搬；
搬完必须 `art.compile()` + 渲染一次看区块列表。顺带：
- **武器卡不该有套装块**：「二件套效果/四件套效果/套装与散件」是遗器的东西，
  原神武器卡和星铁光锥卡的模板里都删掉了（用户反馈「武器哪来的套装？明明是突破材料」）
- **推荐角色为空要给提示**：星铁光锥官方/Bwiki 词条页本来就没有推荐角色，
  两张卡都改成空时显示「官方暂未推荐角色」，不留空标题块
- **光锥故事排成一段**：页面里每个单元格/`<br />` 都留换行，卡面上一句一行；
  现在解析时去掉所有换行 + CSS `white-space:normal`，由浏览器按宽度自动折行

**两张武器卡版式统一**（用户要求「星铁武器图鉴和原神武器图鉴格式一样」）：
- 区块顺序统一为 简介 → 武器/光锥效果 → 详细面板 → 推荐角色(+理由) → 套装与散件 →
  二/四件套 → 故事（原神卡多一个「突破材料·总计」，光锥没有材料，属数据差异不是版式差异）
- 星铁卡新增 `{{if intro}}简介{{/if}}` 区块，`intro` 由 `bwFields.desc || hit.desc` 映射；
  「基本信息」块删掉，获取途径/实装日期/TAG 挪进 hero 的 tag 与 brief 行（与原神卡一致）
- 左上角图标两边都改成 `width/height:100% + object-fit:cover + border-radius:16px`（真正铺满）
- 实测并排渲染高度 511 / 531 px，版式对齐

⚠ **TEST 角标**：所有详情卡（gs_role_nk / sr_role_nk / gs_item_bwiki / sr_item_bwiki /
relic_bwiki / zzz_role_nk / zzz_yq_bwiki / zzz_wq_bwiki）在 `<div class="page">` 之后统一插
`{{if unreleased}}<div class="corner-test">TEST</div>{{/if}}`，CSS `.corner-test`（金色，右上角 10px）。
`unreleased` 由数据层 `data()` 返回的 `isUnreleased` 一路传到视图（`this._curUnreleased` 兜底），
**与数据模式开关无关**——两种模式下测试服数据都要打标（用户要求）。
实测 8 个模板：正式服 → 无角标，测试服 → 右上角 TEST（距卡面右边缘 0px）。

⚠ **模板加固**：所有 `{{if X.length}}` 一律改成 `{{if X && X.length}}`（全库 32 处）。
字段缺失时原来是**整卡渲染失败**，不是少一块。
⚠ 用脚本批量改模板时务必先备份、并且正则要**连结尾 `}}` 一起写回**——
我漏写结尾把 8 个模板改成 `{{if X && X.length`（语法直接崩），已全部还原并通过自检。

**数据模式开关（正式服 / 测试服）**：数据层 `mys.getDataMode()/setDataMode()`，
配置文件 `plugins/xhh/config/xhh_data_mode.yaml`（`mode: official|test`，**默认 official 正式服**；无配置或配置值非法都按正式服，宁可少出卡也不混进测试服数据），
群指令 `#切换正式服模式` / `#切换测试服模式` / `#数据模式`（查当前）——**两种方式都支持**。
- 正式服模式：`detail()` 完全不读 nanoka；列表命中 `isUnreleased`（manifest 的 new.*）时
  `blocked=true`，命令层直接回「该条目是测试服数据，当前为正式服模式，不出卡。可用 #切换测试服模式 后重试」
  （角色/武器/圣遗物遗器/驱动盘四条路径都接了）
- **列表也要过滤**（用户反馈「图鉴列表怎么还是有测试服」）：`filterListByMode()` 加在**所有**
  列表出口（GS/SR 的 nanoka 列表、官方兜底列表、合并后列表、ZZZ 列表）。测试服判定认两种标记：
  `isUnreleased`（原神/星铁 manifest.new.*）与 `_src==='nanoka'`（绝区零 nanoka 独有条目——
  merge 只补官方列表里没有的，那些就是测试服内容；官方列表里的条目不带 `_src`）。
  之前只判前者，绝区零列表一条都没剔掉。
  实测：正式服 → 胡桃/艾莲·乔/鲨牙布；测试服 → 6 条全出（含米提亚、阿哈、赛维里安）。
- **两边数据严格不混合**：`detail(..., src)` 里 src='official' 只走米游社官方、官方没有就返回
  false（不去 nanoka 拿测试服数据）；src='nanoka'（测试服实体）只走 nanoka、没有就返回 false
  （不混官方数据）。

⚠ 模式只隔离**数据源**，不拆插件：两份物理插件会让同一修复要改两遍，很快又出现
「正式服和测试服表现不一致」——那正是这轮连环问题的根源。

**id 与来源必须同行（用户原话：id 怎么会混用）**：列表是 nanoka 与米游社**合并**的
（`merge()` 把 nanoka 独有条目带 `_src:'nanoka'` 塞进官方数组），两套 id 体系不通。
之前 `data()` 只回 `{ id }` 丢掉 `_src`，`detail(id)` 再一律 nanoka 优先 →
米游社 content_id 打到 nanoka 必然 404，每次查正式服条目都白跑并打 WARN。
现在 `data()` 返回 `{ id, src, isUnreleased, blocked }`，`detail(..., src)` 按来源决定先去哪个源
（official → 米游社优先、nanoka 兜底；nanoka → nanoka 优先）。之前为绕这个坑加的
`preferNanokaId()` 已删除。

**方法名拼写不一致 = 整条命令崩**：`this.preferNanokaId is not a function`
（星铁阿哈一直「没反应」的**真正原因**）。我定义方法时写成 `preferNanokoId`、
调用处写成 `preferNanokaId`（差一个 o）。`node --check` **查不出**这类错，
它只查语法；必须自己扫：`this.X(` 的名字是否都在同文件里有对应定义。
已在两个调用点加 `typeof this.preferNanokaId === 'function'` 兜底，
热更新期间跑旧模块最多退化成「沿用列表 id」，不会把命令带崩。

**nanoka 与米游社两套 id 必须同源**：日志「nanoka 详情为空，回退米游社官方 Wiki」+
「星铁阿哈图鉴没反应」的组合说明：列表命中的是**米游社体系的 id**（6 位 content_id，
因为列表回退过官方），拿它去 nanoka 查 `zh/character/{id}.json` 必然 404，而米游社又没有
未实装角色 → 未找到。现在 `data()` 命中后走 `preferNanokoId()`：nanoka 里有同名角色就改用
nanoka 的 id（列表与详情同源，这是硬约束）。配套：
- `nanoka_detail()` 在缓存版本取不到时，用 manifest 的 **latest** 版本再试一次
  （nanoka 只保留当前版本，`available` 里旧版本没有测试服实体：实测 hsr 4.6 无 1511、4.6.51 有）
- 星铁附属表（item/lightcone/relicset）失败只降级为空，不再连带整张卡
- 取不到时打出 URL 与 base 的 debug，下次好定位

**测试服角色列表兜底**：「星铁阿哈图鉴没反应」——列表可能来自米游社官方（不含未实装角色），
精确/包含匹配都落空就返回未找到。现在 `mys.data()` 在角色查不到时走
`nanokaCharacterFallback()`：直接翻 nanoka 的 `character.json` 再匹配一次，
命中返回 nanoka 体系的 id（详情同源，必须同源）。实测「阿哈」→1511(isUnreleased=true)、
「真珠」→1503，不存在的名字仍然正常返回未找到。
另外 `nanoka_role_pictures` 里测试服角色**不并 Bwiki**（`unreleased ? {...view} : merge…`），
避免 Bwiki 空壳词条把 nanoka 的完整属性/技能覆盖掉。

**stats 的键有两种含义**（星铁角色）：`srRoleView` 里 nanoka 的 `character.json` 的 `stats`
可能是**等级档**（键 1/20/40/…/80），也可能是**星魂档**（键 0~6，星魂逐级解锁的属性强化档，
实测真珠就是这种：163.68 → 556512）。之前一律按「取 level 最大」→ 星魂角色取到第 6 档，
卡上显示成「等级 6」（用户反馈「最高等级为啥是 6」）。
现在判据：键全在 0~6 且有 7 档 → 星魂档，行的标签写 `星魂6`、首列表头 `星魂`、标题
「基础属性 · 满星魂」；否则按等级档。**别的地方按数值取最大档之前，先想清楚键是什么。**

**同一张卡别出现两块重复数值**：星铁光锥卡原来有「基础属性」（基础HP/攻击/防御）
和「详细面板」（等级成长）两块，内容重复看着像冲突（用户反馈）。
现在「基础属性」块只留元信息（获取途径/实装日期/TAG），标题改成「基本信息」，
数值统一由详细面板承载；顺便把详细面板也按同一口径裁到**最高等级一行**
（原神武器/星铁角色/邦布/ZZZ角色都是这条口径，别的地方不要再逐档全列）。

**精炼数值的上色**：`paintNumbers`（`bwiki_gs_item.js`，已改为 export）只处理百分比，
「48/60/72/84/96点」这类无量纲序列不管；新增模块级 `paintRefineText()`：
先跑 `paintNumbers`，再补「数字序列+点/秒/层」与单个「数字+点/秒/层」。
⚠ **顺序要紧**：序列规则必须在单数字规则之前，反过来会让单数字规则先吃掉序列最后一个数，
出现「48/60/72/84/<span>96</span>点」的半截上色。`.num` 统一 `#4571ec`。
`x1/x2` 标签已全部移除（模板改按段落 `.refine-p` 排，退回逐档时也不加标签）。

**精炼按官方客户端写法（只写变化的数值）**：`compactRefinements()`（`apps/wiki.js` 模块级函数）
把五档描述压成一句「骨架 + 数值序列」，如
「暴击伤害提升24%/30%/36%/42%/48%。…元素精通提升48/60/72/84/96点…」
（用户要求「像正式服那样写变化的数值就行」）。三重守卫，任一不满足就退回 `x1/x2/x3/x4/x5` 逐档展开：
1. 五档**文案骨架必须一致**（把数字换成占位符后相同）
2. 各档**数字个数必须一致**，且压缩后能**逐档还原**与原文完全相同（自校验，对不上就退回）
3. 变化的数字位之间必须**隔着实质文字**（≥4 个非空白字符）。
   判据 3 的由来：雾切「持有1/2/3层时，获得8/16/28%」这种**同档内列表**跨档合并会串成
   「8/10/12/14/16/16/20/24/28/32/28%/35%/…」，所以它退回逐档；
   而护摩「生命值提升20%。此外，基于…的0.8%」隔着一整句，可以合并。
全库 289 把：压缩成功 224 / 退回逐档 16。

**清洗函数要复用，不要各写一套**：`nanoka_wq_pictures` 里自己写的 `clean()` 只剥了
`<color>`，没还原字面 `\n`，秘星典谕技能描述卡面上直接出现「；\n辉映·星烁」。
现已改成直接用 `role_detail.js` 导出的 `stripTags()`（字面 \n / <color> / {LINK#…} 全覆盖），
`apps/wiki.js` 顶部 import 加上。写新的文本清洗前先看 `stripTags` 有没有现成的。

**模板键名别串**：`gs_item_bwiki.html` 读的是 **`skillDesc`**，
而星铁光锥模板读 `talentDesc`。nanoka 武器卡一开始传了 `talentDesc`，
于是「武器技能」只剩技能名、描述整块被 `{{if skillDesc}}` 挡掉（用户问「技能有了吗」）。
两个模板键名不同，改这类视图时先 `grep` 一下模板实际读的键。

⚠ **判据必须是「是否测试服」，不是「是否取到数据」**：第一版写成「米游社/Bwiki 没数据就走
nanoka 武器卡」，而 `mys.detail()` 本身优先走 nanoka —— 于是正式服武器只要 Bwiki 限流(567)
就被当成测试服出卡（用户反馈「正式服武器图鉴你搞什么测试服图鉴」，而且那张卡没有故事）。
正确判据：`mys.data()` 返回的 `isUnreleased`（来自 nanoka manifest 的 `new.weapon`），
和角色那边 `role()` 的 `!isUnreleased` 是同一条规则。

**游戏内富文本标记没清洗**：「米提亚」技能文本里带 `{LINK#N11360002}侦测炉心{/LINK}`、
`{ICON#A1}…{/ICON}`，卡面直接显示成一串花括号代码（用户反馈「技能表述有些代码」）。
`role_detail.js` 的 `stripTags()` 与 `wiki.js` 的 `zzzCleanText()` 各加一段：
先删 `{LINK#…}`/`{ICON#…}`/`{COLOR#…}` 开标记与其闭标记，再兜底删掉残留的 `{…}`
（已实装角色实测不含这种标记，是 nanoka 测试服数据独有）。
⚠ 已有 `\n` 字面转义与 `<color>` 标签的处理，别重复造。

**测试服武器走 nanoka（同测试服角色那条口径）**：「秘星典谕」是**测试服五星法器**
（nanoka weapon.json id=14525，manifest new.weapon 里就是它），米游社与 Bwiki 都没词条。
之前 `mys.detail()` 的 nanoka 分支**只查角色**（`zh/character/{id}.json`），
于是武器详情永远取不到 → 掉进「百科未收录」简版空卡 = 用户反馈「没反应」。
修法：
- `nanoka_detail(id, isSr, kind='character')` 增加 `kind='weapon'` → `zh/weapon/{id}.json`；
  `detail()` 透传 kind
- `weapon()` 里 **只在 `ret.isUnreleased`（测试服武器）** 且米游社/Bwiki 都没数据时，
  才按武器再取一次 nanoka，命中走新渲染
  `nanoka_wq_pictures()`（统一 `wiki/gs_item_bwiki` 版式）：名称/图标/星级/类型/
  1级基础攻击/精炼1阶技能/突破材料汇总
- 90 级面板（第一版说「不画」是偷懒，用户点出有数据就该抓，已接上）：
  - 攻击力 = **weapon.json 条目的 `atk`**（详情的 weapon_prop+ascension 反推不出来，
    试过 `base*levels[90]+ascension` 对不上）。校验：雾切 674、护摩 608、和璞鸢 674，与 Bwiki 完全一致
  - 副属性 = `stats_modifier[sub].base × levels['90'] × 100`。校验：雾切 44.1%、和璞鸢 22.1%，与 Bwiki 一致
  - `stats_modifier` 的键名大小写不统一（FIGHT_PROP_CRITICAL_HURT / fight_prop_critical_hurt），
    必须按 weapon.json 的 `sub` **忽略大小写**匹配
  - `nanoka_tujian` 把武器表挂到 `this._nkEquipMap[base]` 复用，避免为一张卡再拉全表
  - 实测秘星典谕：90 级 542 / 暴伤 88.2%
- 米游社武器 id 是 6 位 content_id，nanoka 武器 id 是 5~6 位（14525），
  两套编号不同源，所以列表与详情必须同源（和角色那边一样的约束）

**原神武器卡材料只出总计（第 2 版）**：第一版只改模板，结果 Bwiki 武器页**根本没有「总计」表**
（那是邦布页才有的），`materialTotal` 一直是空 → 模板每次都回退到 6 行分级明细。
现在 `bwiki_gs_item.js` 在解析后**自己按材料名汇总各突破档**：无官方总计时才汇总，
数字带「万/亿」的保留原文不做单位换算。赤月之形实测：残毁的剑柄 5+18=23、
未熄的剑柄 14+27=41、啮合齿轮 3+12=15，与截图逐项吻合。

**原神武器卡材料只出总计**：`{{if materialTotal.length}}` 出「突破材料 · 总计」一行，
解析不到总计时退回分级明细（信息不丢）。实测 63 个圣遗物里 46 个有官方推荐原因。

**原神圣遗物卡推荐理由**：`mihoyoItemAgents('gs')` 其实早就取到了理由（原来 `buildRelicView`
把多个角色的理由 `join('\n')` 拼成一整段，看不出哪句说谁）。现在改成**一角色一条**，
前面标角色名（`.agent-why .who`）；某角色没理由就不渲染那条。
另外补了「官方没推荐」的独立分支：原来 `noRecommend` 提示被包在 `{{if agents.length}}` 里，
agents 为空时**整块不渲染**（血红之证就是这种），现在 `{{else if noRecommend}}` 单独出提示。

**「xx专武」不存在却出真珠专武** = 同一条空串 bug（`weapon()` 把解析失败后的空串
`wq` 丢给 `sr_item_bwiki_pictures('','gz')` → 命中光锥列表第一条「献给明日的色彩」）。
`weapon()` 已改成 `isSr && wq` 才调；不存在时正常落到末尾提示
「没有找到「xx专武」的图鉴数据」，不再出无关卡。

**星铁光锥卡版式**：去掉右上角武器立绘（模板里 `{{if art}}` 整段删除 + CSS 里的
`.hero-art` 保留备用）；左上角图改为 `width/height:100% + object-fit:cover + border-radius:16px`
真正铺满方框（原来 88×88 contain 留白）。

**原神武器卡**去掉「编辑者观点」提示行（用户要求），推荐理由保留。

**空串模糊匹配会命中列表第一条**：`sr_item_bwiki_pictures` 里
`list.find(x => norm(x.name).includes(key))`，当 name 为空时 `''.includes('')` 为 true，
于是命中**列表第一条**。上游 `weapon()` 名称解析失败时把空串传下来，
「星铁阿哈的第一声响起武器图鉴」就出了列表第一条光锥（真珠专武「献给明日的色彩」）的卡。
修法三处：① key <2 字直接不匹配；② 两个包含方向都要求被包含一方 ≥3 字；
③ `weapon()` 里改成 `isSr && wq` 才调 Bwiki 光锥卡。
另外 `gz_names.yaml` 补了「当第一声「阿哈」响起」（真实名称，含官方英文 Upon the First Echo of "Aha"）
的别名：阿哈的第一声响起 / 阿哈第一声响起 / 阿哈的光锥 / 星神阿哈专武 / 阿哈专武。

**原神武器的推荐理由**：Bwiki 武器页「推荐角色」小节里其实有「推荐说明」
（每个 roleicon 卡后面跟 `<div class="main"><div class="title">推荐说明</div><div class="item">…`），
原来只取了头像、丢了正文。现在按「下一个 roleicon 之前」切段取说明，同一角色多段用换行拼接，
模板在头像列表下方逐个渲染 `.agent-why`。
⚠ 该小节页面自带「以下内容可能存在主观性」声明（编辑者观点），头像本来就是这段的数据，
所以理由同源，并额外渲染一条「编辑者观点」提示，不假装是官方数据。
实测雾切之回光 7 个角色都有理由。

**等级表只留最高等级（第4 处）**：原神武器/专武「详细面板」也是 1~90 级 16 行，
`bwiki_gs_item.js` 在拼 colspan 之前先裁到「有数值的最高等级行」。
实测 雾切之回光 674/44.1%、护摩之杖 608/66.2%、和璞鸢 674/22.1%，都只剩 90 级一行。

**模板用了标记但漏了样式**：`gs_item_bwiki.html`（原神武器/专武）用了 `.agents/.agent`
标记却没配套 CSS → 浏览器默认 img 尺寸，推荐角色头像变得巨大。
已把 `relic_bwiki.css` 那套（圆形 22×22 + 胶囊底 + `.agent-why`）原样搬过去，
Puppeteer 实测武器卡与圣遗物卡同段都是 22px。已扫全部模板，无第二处漏样式。

**测试服角色走 nanoka，不要走 Bwiki**：原神角色路由原本「优先 Bwiki、nanoka 兜底」，
注释写着「测试服角色 Bwiki 还没有」——**现在 Bwiki 也收录未实装角色了**（米提亚有词条），
但那是空壳：等级成长表 1~100 级整表无数值、生日是空数组，出来一张残卡。
修法：`mys.data()` 单查时把列表条目的 `isUnreleased`（来自 nanoka manifest 的
`new.character`）透传出来，`role()` 里 `!isUnreleased` 才走 Bwiki。
测试服数据源 = nanoka，这是既定口径，别再顺着 Bwiki 修测试服角色。

**测试服角色的成长表是空壳**（上一条修完路由后的兜底，双保险留着）：米提亚（Bwiki 有词条）在 Bwiki 上的等级成长表
1~100 级格子**全是空的**（不是解析问题）——`d.growth` 有 10 行但一格数值都没有。
现在 `buildGsDetail` 检测「有行但整表无数值」→ 基础属性显示「未公布」而不是四个空格。
（对照：阿蕾奇诺 13103/342/765/38.4% 正常。）

**Bwiki basic/other 的值不一定是字符串**：「原神米提亚图鉴」整张卡无反应，
日志 `bwiki_gs.js:714 TypeError: ((intermediate value) || "").match is not a function` ——
米提亚的「生日」是**数组**，`(x || '').match()` 只兜假值不兜类型。
现在生日统一「数组取前两个 / 其余 String 后正则」，`实装日期`、`稀有度` 也补String()。
教训：所有从米游社 basic/other 取值的字符串操作都要先 `String()`。

**稀有度配色不能写死金色**：`zzz_yq_bwiki` 的 `.hero-ic` 与 `.rarity` 原来都是金色，
A级邦布也显示金色方框+金色 A级 字（用户反馈「A级为啥是金色，不该紫色吗」）。
现在 header 按稀有度挂 `rar-a` / `rar-b` / `rar-s`，配色沿用列表端口径：
S 金 `#e0a92f→#c9881f`、A 紫 `#9a5fd0→#7a41ad`、B 蓝 `#6f9fd6`。
另外 `teamList()` 过滤掉「暂无」占位（官方没写推荐时米游社填字，会出裂图+「暂无 暂无」）。

**面板·附加必须有列名**：原来只取数值丢弃表头，卡面上一片 50% / 100% 没有列名，
用户完全看不出是什么属性。现在 `bwiki_zzz.js` 把「整行无数字」的表头行存进 `panelSubHead`
（⚠ 必须判在「等级」跳过之前 —— 表头首格就是 rowspan=2 的「等级」），
`bangboo_view.js` 透传，模板渲染成 `等级 | 暴击率 | 暴击伤害 | 能量自动回复`。
`ok` 判定加上 `panelSub.length`（之前只有 panelSub 时会被判成「非邦布页」返回 null）。

**回落卡也要统一模板**：伊埃斯（Bwiki 没收录 + 米游社邦布列表 41 条里也没有，走观测枢/nanoka）
原来回落到 `zzz_yq_pictures` → 渲染 **`wiki/zzz_role`**（ARCHIVE/PROFILE/INFO/STATS 旧角色卡版式），
所以同一个邦布出现两套 UI。现在回落也走 `wiki/zzz_yq_bwiki`：
观测枢字段名映射成统一视图的键（生命值/攻击力/防御力/冲击力/异常掌控…），
技能用观测枢的键名当类型，只有一档基础值（观测枢没有突破分档），模板加了 `profile` 简介位。

**推荐理由重复**：邦布「搭配组合」4 个角色共用同一句官方推荐理由，逐角色渲染会重复 4 遍（用户实图）。
`bangboo_view.js` 的 `groupReasons()` 按理由内容归并，一条理由渲染一次并标出适用角色；
`teamList()` 顺手去掉同名重复登记的角色。

**角色卡基础属性只留最高等级**（第三次踩同一个坑，三处都在输出整张等级表）：
- `srRoleView`（`system/role_detail.js`）：1~80 → 只留最高等级行，模板标题改「基础属性 · 最高等级」
- ZZZ 角色卡 `baseStats.growth`（`apps/wiki/bwiki_zzz.js`）：Bwiki「属性数据」1~60 级成长表 → 只留最高等级行
  （用户反馈「艾莲图鉴还是 1~60」；模板 `zzz_role_nk.html` 标题同步改）
- 邦布卡：`bangboo_view.js` 的 `keepMaxLv()` 管面板 / 面板·附加 / 技能倍率
口径统一：**等级表只留最高等级一行**；GS 角色卡本来就是单值（基础属性 + 等级加成）。

**词条名跨类型共用（Bwiki）**：「鲨牙布图鉴」出的是一张几乎全空的**音擎**卡 ——
Bwiki 词条名跨类型共用，绝区零分派顺序又是「角色 → 武器(音擎) → 遗器 → 邦布」，
音擎路径先把邦布页抢走当音擎解析（基础攻击力空、面板空、材料还是邦布的突破材料，
10/40级突破还重复两次）。两处都改了：
- 分派顺序改成「角色 → **邦布** → 武器 → 遗器」（`apps/wiki.js`）
- 双向页面类型守卫：`fetchZzzBwikiWeapon` 要求音擎特征且排除邦布/驱动盘特征；
  `fetchZzzBwikiBangboo` 要求邦布特征（主动技/额外能力/邦布连携技/邦布图标/初始攻击力）。
  命中不了就返回 null，让上层正常回落，而不是硬渲染一张空卡。
- 顺带：音擎材料表按「档位+材料」去重（同一页多张材料表时不再出现两个 10级突破）

**卡片长度**：邦布原本四张等级表全列（面板 7 行、面板·附加 7 行、技能倍率、技能面板）+ 基础属性 19 行，
一张卡 8650px(2x)。统一按「等级表只留最高等级 / 基础属性只留最高档」裁剪：
- `bangboo_view.js` 的 `keepMaxLv()`：面板、面板·附加、技能倍率各只留最高等级那行
- 基础属性只留「突破后」那一档（`突破后X` 存在就丢掉 1 级值的 `X`），19 行 → 9 行
- `wiki.js` 邦布分支不再用未裁剪的 `bw.panel/panelSub` 覆盖视图（原来会把裁剪冲掉）
- 结果：8650px → 3700px（2x），即约 4300 → 1850 CSS px

**技能图标**：邦布三个技能（主动技/额外能力/邦布连携技 = a/b/c）的官方图标在米游社
`role_talent` 的 `icon` / `animated_icon`，Bwiki 没有。已接进 `talents[].icon`，
模板里每个技能块标题前显示（`.skill-ic`，20×20）。

右上角两个小图标是用户点名要的官方图标：
稀有度 `图标-材料稀有度-S.png`（在标题区 `bangboo-title-S .rarity-img`）、
伤害属性 `图标-冰.png`（在「伤害属性」标题右侧，alt 是**单字属性名**，不是「图标-冰属性.png」）。
两者都**不在基础信息表里**，放在表格循环里取永远取不到（实测角标 0）。

### B. 伊埃斯（测试服邦布）没有头像 — 三个源都没有

- nanoka `bangboo.json` 里**有**这个条目（id 55098），但 `icon` 字段是**空串**；
- 米游社邦布列表 41 条里**没有**它（所以也拿不到观测枢图标）；
- Bwiki **没有它的词条页**（`missingtitle`）；
- 本地图标目录 `resources/wiki/zzz_bangboo/`（代码早就支持，目录之前不存在）
  已建好并附 README；**用户已提供一张图并已存为 `伊埃斯.png`**，
  列表（`mys.js` 的 `localBangbooIcon` 兜底）和卡片都会用它；
- 代码里也加了兜底：邦布条目 icon 为空时读该目录（`mys.js` 的 `localBangbooIcon`）。

要拿到图只能：① 用户自己放一张；② 等 nanoka/mihoyo 上架后自动出现。
