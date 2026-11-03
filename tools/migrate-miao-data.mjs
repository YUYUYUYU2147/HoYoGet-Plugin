/**
 * 把 miao-plugin 的用户数据迁到本插件（hoyo: 前缀）。
 *
 *   node tools/migrate-miao-data.mjs           # 复制（幂等，可重复跑；源数据不动）
 *   node tools/migrate-miao-data.mjs --dry     # 只统计，不写入
 *   node tools/migrate-miao-data.mjs --cleanup # 复制完成后删除 miao:* 旧键
 *
 * 迁移内容：
 *   1. redis 里所有 miao:* 键（群排名 zset、面板 md5 缓存、uid-info、群排名配置…）
 *      → hoyo:*（COPY 保留类型与 TTL）
 *   2. plugins/miao-plugin/config/cfg/*.yaml → system/vendor/miao/config/cfg/
 *      （只拷贝目标不存在的文件，避免覆盖已经在本插件里改过的设置）
 *
 * 面板本体数据（data/PlayerData、data/UserData）本来就在 Yunzai 的共享目录里，
 * 两个插件读的是同一份，不需要迁移。
 *
 * 注意：脚本用 redis-cli 而不是 node-redis，避免要求插件额外装依赖。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const DRY = args.has('--dry')
const CLEANUP = args.has('--cleanup')

const OLD = 'miao:'
const NEW = 'hoyo:'

function cli(...argv) {
  return execFileSync('redis-cli', argv, { encoding: 'utf8' }).trim()
}

function migrateRedis() {
  let keys = []
  try {
    keys = cli('--scan', '--pattern', `${OLD}*`).split('\n').filter(Boolean)
  } catch (err) {
    console.error(`读取 redis 失败（redis-cli 不可用？）：${err.message.split('\n')[0]}`)
    return { ok: 0, skip: 0, fail: 0 }
  }
  if (!keys.length) {
    console.log(`redis：没有 ${OLD}* 键（可能已经迁移过）`)
    return { ok: 0, skip: 0, fail: 0 }
  }
  console.log(`redis：发现 ${keys.length} 个 ${OLD}* 键`)
  if (DRY) return { ok: 0, skip: keys.length, fail: 0 }

  let ok = 0, skip = 0, fail = 0
  const failed = []
  for (const key of keys) {
    const target = NEW + key.slice(OLD.length)
    try {
      // COPY 保留类型与 TTL，且不改动源数据；REPLACE 让脚本可重复执行
      const ret = cli('COPY', key, target, 'REPLACE')
      if (ret === '1') ok++
      else { skip++; failed.push(`${key}（COPY 返回 ${ret}）`) }
    } catch (err) {
      fail++
      failed.push(`${key}（${err.message.split('\n')[0]}）`)
    }
  }
  console.log(`redis：复制成功 ${ok}，跳过 ${skip}，失败 ${fail}`)
  if (failed.length) console.log('失败样例：\n  ' + failed.slice(0, 5).join('\n  '))

  if (CLEANUP && ok) {
    // 清理前再确认一次：新键确实存在才删旧键
    let removed = 0, kept = 0
    for (const key of keys) {
      const target = NEW + key.slice(OLD.length)
      try {
        if (cli('EXISTS', target) === '1') { cli('DEL', key); removed++ } else kept++
      } catch { kept++ }
    }
    console.log(`redis：已删除旧键 ${removed} 个，保留 ${kept} 个（新键缺失）`)
  }
  return { ok, skip, fail }
}

function migrateCfg() {
  const src = path.join(ROOT, '..', 'miao-plugin', 'config', 'cfg')
  const dst = path.join(ROOT, 'system', 'vendor', 'miao', 'config', 'cfg')
  if (!fs.existsSync(src)) {
    console.log('配置：没有找到 miao-plugin/config/cfg（可能没装 miao）')
    return { copied: 0 }
  }
  fs.mkdirSync(dst, { recursive: true })
  const files = fs.readdirSync(src).filter(f => /\.ya?ml$/i.test(f))
  let copied = 0
  for (const f of files) {
    const to = path.join(dst, f)
    if (fs.existsSync(to)) continue // 已存在就不覆盖：本插件里可能已经改过
    if (!DRY) fs.copyFileSync(path.join(src, f), to)
    copied++
  }
  console.log(`配置：${DRY ? '将拷贝' : '已拷贝'} ${copied} 个 yaml（已存在的不覆盖）`)
  return { copied }
}

const redisRet = migrateRedis()
const cfgRet = migrateCfg()
console.log('')
console.log(`完成。redis 新增 ${redisRet.ok} 个键，配置 ${cfgRet.copied} 个文件。`)
if (DRY) console.log('（--dry 模式，未写入任何内容）')
if (!CLEANUP) console.log('源数据（miao:*）保持不动，随时可以回滚；确认无误后可加 --cleanup 清理。')
