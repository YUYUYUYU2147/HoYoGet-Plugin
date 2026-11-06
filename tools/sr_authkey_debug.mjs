/**
 * 联调工具：用本机已保存的 stoken 试跑一次「免链接 authkey」，并立刻用拿到的
 * authkey 拉一页官方记录验证有效性。
 *
 *   node tools/sr_authkey_debug.mjs <QQ> [UID]
 *
 * 注意：
 *   · 会让该账号正在运行的游戏客户端掉线，请在用户不在游戏内时执行；
 *   · 只打印 authkey 的前后各 6 位，避免日志泄露凭据。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { getSrAuthkey } from '../system/sr_authkey.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const qq = String(process.argv[2] || '').replace(/\D/g, '')
const wantUid = String(process.argv[3] || '')
if (!qq) {
  console.error('用法：node tools/sr_authkey_debug.mjs <QQ> [UID]')
  process.exit(1)
}

const file = path.join(ROOT, 'data', 'Stoken', `${qq}.yaml`)
if (!fs.existsSync(file)) {
  console.error(`找不到 ${file}，请先用 #米哈游扫码绑定`)
  process.exit(1)
}

const parsed = YAML.parse(fs.readFileSync(file, 'utf8'))
const entries = (Array.isArray(parsed) ? parsed : Object.values(parsed || {})).filter(
  e => e && typeof e === 'object' && e.stoken && /hkrpg/.test(String(e.game_biz || 'sr'))
)
const entry = entries.find(e => !wantUid || String(e.uid) === wantUid)
if (!entry) {
  console.error(`没有可用的星铁 stoken 条目（共 ${entries.length} 条星铁记录）`)
  process.exit(1)
}

const uid = String(entry.uid)
const stuid = String(entry.stuid || entry.ltuid || '')
const mid = String(entry.mid || '')
console.log(`账号 ${qq} · UID ${uid} · stuid ${stuid.slice(0, 3)}***${stuid.slice(-2)} · mid ${mid ? 'ok' : '缺失'}`)
if (!mid) {
  console.error('缺少 mid：新版扫码票据校验需要 mid，请重新扫码绑定后再试')
  process.exit(1)
}

const started = Date.now()
try {
  const { authkey } = await getSrAuthkey({
    stoken: String(entry.stoken),
    stuid,
    mid,
    uid,
    onStep: text => console.log(`  · ${text}`),
  })
  console.log(`authkey 获取成功（${Date.now() - started} ms）：${authkey.slice(0, 6)}…${authkey.slice(-6)}`)

  // 立刻验证：拉角色池第一页
  const query =
    'authkey_ver=1&lang=zh-cn&gacha_type=11&page=1&size=20&end_id=0' +
    `&authkey=${encodeURIComponent(authkey)}&region=prod_gf_cn&game_biz=hkrpg_cn` +
    '&sign_type=2&auth_appid=webview_gacha&version_switch=3.4.0'
  const res = await fetch(`https://public-operation-hkrpg.mihoyo.com/common/hkrpg_gacha_record/api/getGachaLog?${query}`)
  const data = await res.json().catch(() => ({}))
  console.log(`接口验证：retcode=${data.retcode} message=${data.message || ''} 条数=${data?.data?.list?.length ?? 0}`)
  if (Number(data.retcode) !== 0) {
    console.error('authkey 已获取但接口拒绝，通常意味着 authkey 与会话不匹配（下次升级需重新对齐协议版本）')
    process.exit(2)
  }
} catch (err) {
  console.error(`失败：${err?.message || err}`)
  process.exit(1)
}
