# HoYoGet 崩坏3导出修复

这是 HoYoGet-Plugin 的源代码补丁，不是 WishArchive APK 重打包。

安装方式：将 `apps/common/gacha_export.js` 覆盖到现有 HoYoGet-Plugin 的同路径；测试文件可放入 `test/`，仅用于验证。

新增命令：

`#崩三导出抽卡记录`

`#崩三导出抽卡记录 629516298`

导出的 JSON 同时包含两种导入格式：`pools` 和 `bh3` 数据。导出时会去除角色名末尾的 `角色卡`，补齐可识别的 `rank_type`，并保留完整逐抽记录。

验证命令：

`node --test test/bh3-gacha-export.test.js`
