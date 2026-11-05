/**
 * 星铁「免链接」authkey 获取
 *
 * 链路（与官方客户端跃迁记录页同源，但由服务端自行登录换取）：
 *   stoken ──SDK 扫码票据──> game_token ──granter/login──> combo_token
 *          ──query_dispatch/query_gateway──> 网关 host/port/ec2b
 *          ──KCP(UDP) 登录游戏服──> PlayerGetToken / PlayerLogin
 *          ──GetGachaRecordAuthkey──> authkey（684 字符，供 getGachaLog 使用）
 *
 * 本文件是 星愿档案 1.2.5（com.aozaki.wisharchive）StarRailClient /
 * StarRailConnection / StarRailWire 三个类的 1:1 移植（含 Ec2b 密钥派生、
 * MT19937-64 keystream、KCP 分片与重传），仅把 Java 阻塞 IO 换成 Node
 * 的 dgram + fetch。字段编号、魔数、盐值均按反编译结果保留，改动任何一处都会
 * 导致网关拒绝或解密出乱码。
 *
 * 说明：
 *   · 只读：本模块不写任何游戏数据，只换一个临时登录票据；
 *   · 有代价：同账号正在运行的游戏客户端会被顶下线（官方单端登录），
 *     调用方必须先征得用户同意；
 *   · 版本绑定：native 配置（4.6.0）与网关字段偏移写死在下方 NATIVE 里，
 *     游戏大版本更新后需同步更新，否则会报「星铁协议配置需要更新」。
 */

import { createHmac, createHash, randomBytes } from 'node:crypto'
import dgram from 'node:dgram'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/* ============================ 协议配置 ============================ */

/**
 * 星铁客户端协议配置（等价 APK 内 com/aozaki/wisharchive/core/sr-native.json）。
 * 需要随游戏版本更新：version / gameVersion / loginBodyBase64 / dispatchSeed /
 * gatewayFields 都要与当期客户端一致。
 * 允许用 data/sr_authkey/native.json 覆盖（整份替换）。
 */
const NATIVE = {
  version: 'CNPRODWin4.6.0',
  gameVersion: '4.6.0',
  device: '88beeb9ddc28034cda09df55ee8735cee5752b531785737269323',
  verifyHeaders: {
    'Content-Type': 'application/json',
    'x-rpc-app_id': 'c90mr1bwo2rk',
    'x-rpc-client_type': '3',
    'x-rpc-device_fp': '38d81b09a1b21',
    'x-rpc-device_id': '88beeb9ddc28034cda09df55ee8735cee5752b531785737269323',
    'x-rpc-game_biz': 'hkrpg_cn',
    'x-rpc-language': 'zh-cn',
    'x-rpc-sdk_version': '2.53.0.196',
  },
  appId: 8,
  channelId: 1,
  sdkPublicAppKey: '4650f3a396d34d576c3d65df26415394',
  loginBodyBase64:
    'CgVnd19QQxgDIg5DTlBST0RXaW40LjYuMCjk24QIOjU4OGJlZWI5ZGRjMjgwMzRjZGEwOWRmNTVlZTg3MzVjZWU1NzUyYjUzMTc4NTczNzI2OTMyM0IRQ2hpbmVzZVNpbXBsaWZpZWRQAVoJMjU2MCoxNjAwah5XaW5kb3dzIDExICAoMTAuMC4yNjIwMCkgNjRiaXR6kQV7Im9wZXJhdGluZ1N5c3RlbSI6IldpbmRvd3MgMTEgICgxMC4wLjI2MjAwKSA2NGJpdCIsImRldmljZU1vZGVsIjoiSklBT0xPTkcgU2VyaWVzIChNRUNIUkVWTykiLCJncmFwaGljc0RldmljZU5hbWUiOiJOVklESUEgR2VGb3JjZSBSVFggNTA2MCBMYXB0b3AgR1BVIiwiZ3JhcGhpY3NEZXZpY2VUeXBlIjoiRGlyZWN0M0QxMSIsImdyYXBoaWNzRGV2aWNlVmVuZG9yIjoiTlZJRElBIiwiZ3JhcGhpY3NEZXZpY2VWZXJzaW9uIjoiRGlyZWN0M0QgMTEuMCBbbGV2ZWwgMTEuMV0iLCJncmFwaGljc01lbW9yeVNpemUiOjc4OTksInByb2Nlc3NvckNvdW50IjoyNCwicHJvY2Vzc29yRnJlcXVlbmN5IjoyODk0LCJwcm9jZXNzb3JUeXBlIjoiQU1EIFJ5emVuIDcgODg0MEhYIHdpdGggUmFkZW9uIEdyYXBoaWNzICIsInN5c3RlbU1lbW9yeVNpemUiOjIzNzc2LCJEZXZpY2VTb0MiOiIiLCJzZXJpYWxfbnVtYmVyIjoiODhiZWViOWRkYzI4MDM0Y2RhMDlkZjU1ZWU4NzM1Y2VlNTc1MmI1M19lNTM0MmI0ZC1mN2U1LTQ1NTUtOTY0MC0xNmFjYmUxOTg5ZTBfMTc5MzczMjMyMyIsImdyYXBoaWNzRGV2aWNlSUQiOiIxMTU0NSIsImdyYXBoaWNfc2hhZGVyX2xldmVsIjo1MCwiZGlza190eXBlIjoiU1NEIiwiSW5pdGlhbEdyYXBoaWNzUXVhbGl0eSI6IlZlcnlIaWdoIn2KCwEwwk4IMDg6MDA6MDCYaQGibQ0zOGQ4MWIwOWExYjIxwm0qeyJoa3JwZ19jbiI6eyJ1YXBjIjoiIn0sImh5cCI6eyJ1YXBjIjoiIn190m8A0HK93IQIsHMB',
  gatewayFields: { host: 14, port: 13, ec2b: 1569 },
  supportedVersion: '4.6.0',
  dispatchSeed: 'fb7d74e443',
}

function loadNative() {
  const override = path.join(ROOT, 'data', 'sr_authkey', 'native.json')
  if (fs.existsSync(override)) {
    try {
      return { ...NATIVE, ...JSON.parse(fs.readFileSync(override, 'utf8')) }
    } catch {
      /* 覆盖文件损坏时退回内置配置 */
    }
  }
  return { ...NATIVE }
}

/* ============================ protobuf / 密钥 ============================ */

const ROUNDS = Buffer.from(
  '3c5ead0fd509273fb870009acd301bebb70471d939802129b5cc7ab2aeb67514632a823470a540ebf94e951c0aa4d0f6561e0ee37bbf0dc5d304f343da7637ddade9f69754d256a200be96d0614f8abe5c3274c8fd7f2cfc5d4ed06b2a2bf8de125ba2588c4e02e53ca6db02bfaae512e0ef0936f6a0e560e162e45402a7d171c0f6e0ffdd01bad526942d85a37ddf0f942fd639e6ecca8673d5666a989286ce20b4f04caadd5ad5782c81beae3a3114',
  'hex'
)
const XOR = Buffer.from('a2252599b762f43928e1b77391052587', 'hex')
const SBOX = Buffer.from(
  '52096ad53036a538bf40a39e81f3d7fb7ce339829b2fff87348e4344c4dee9cb547b9432a6c2233dee4c950b42fac34e082ea16628d924b2765ba2496d8bd12572f8f66486689816d4a45ccc5d65b6926c704850fdedb9da5e154657a78d9d8490d8ab008cbcd30af7e45805b8b34506d02c1e8fca3f0f02c1afbd0301138a6b3a9111414f67dcea97f2cfcef0b4e67396ac7422e7ad3585e2f937e81c75df6e47f11a711d29c5896fb7620eaa18be1bfc563e4bc6d279209adbc0fe78cd5af41fdda8338807c731b11210592780ec5f60517fa919b54a0d2de57a9f93c99cefa0e03b4dae2af5b0c8ebbb3c83539961172b047eba77d626e169146355210c7d',
  'hex'
)
const SHIFT = [0, 13, 10, 7, 4, 1, 14, 11, 8, 5, 2, 15, 12, 9, 6, 3]

const M32 = 0xffffffffn

function gfMul(a, b) {
  let r = 0
  while (b !== 0) {
    if (b & 1) r ^= a
    a = ((a & 128) !== 0 ? 283 : 0) ^ (a << 1)
    a &= 255
    b >>>= 1
  }
  return r
}

/** MT19937-64：state[312]，与 Java 版逐位一致 */
class Mt64 {
  constructor(seed) {
    this.state = new Array(312).fill(0n)
    this.index = 312
    this.state[0] = BigInt.asUintN(64, seed)
    for (let i = 1; i < 312; i++) {
      const prev = this.state[i - 1]
      const mixed = prev ^ (prev >> 62n)
      this.state[i] = BigInt.asUintN(64, mixed * 6364136223846793005n + BigInt(i))
    }
  }

  next() {
    const st = this.state
    if (this.index >= 312) {
      for (let i = 0; i < 312; i++) {
        const j = (st[i] & 0xffffffff80000000n) | (st[(i + 1) % 312] & 0x7fffffffn)
        let v = st[(i + 156) % 312] ^ (j >> 1n)
        if (j & 1n) v ^= 0xb5026f5aa96619e9n
        st[i] = BigInt.asUintN(64, v)
      }
      this.index = 0
    }
    let x = st[this.index++]
    x ^= (x >> 29n) & 0x5555555555555555n
    x ^= (x << 17n) & 0x71d67fffeda60000n
    x ^= (x << 37n) & 0xfff7eee000000000n
    x ^= x >> 43n
    return BigInt.asUintN(64, x)
  }
}

/** 4096 字节 keystream：512 个 MT 输出按指定字节序排列 */
function pad(seed, littleEndian = true) {
  const mt = new Mt64(seed)
  const out = Buffer.alloc(4096)
  for (let i = 0; i < 512; i++) {
    const v = mt.next()
    if (littleEndian) out.writeBigUInt64LE(v, i * 8)
    else out.writeBigUInt64BE(v, i * 8)
  }
  return out
}

/**
 * Ec2b 网关密钥派生。
 * 密钥块 2076 字节：magic 'Ec2b' + 8 字节头 + 16 字节密文 + 2048 字节盐。
 * 16 字节密文用「逆 AES 轮函数」（inv SBOX + inv MixColumns）与 ROUNDS 前 11 组
 * 轮密钥还原，再与 XOR 表异或，折叠成 64 位种子喂 MT19937-64 生成 keystream。
 */
function ec2b(key) {
  if (key.length !== 2076 || key[0] !== 0x45 || key[1] !== 0x63 || key[2] !== 0x32 || key[3] !== 0x62) {
    throw new Error('星铁网关密钥配置需要更新')
  }
  const data = Buffer.from(key.subarray(8, 24))
  for (let i = 0; i < 16; i++) data[i] ^= ROUNDS[i]
  for (let round = 1; round <= 10; round++) {
    const prev = Buffer.from(data)
    for (let i = 0; i < 16; i++) data[i] = SBOX[prev[SHIFT[i]]]
    if (round < 10) {
      for (let i = 0; i < 16; i += 4) {
        const a = data[i]
        const b = data[i + 1]
        const c = data[i + 2]
        const d = data[i + 3]
        data[i] = gfMul(a, 14) ^ gfMul(b, 11) ^ gfMul(c, 13) ^ gfMul(d, 9)
        data[i + 1] = gfMul(a, 9) ^ gfMul(b, 14) ^ gfMul(c, 11) ^ gfMul(d, 13)
        data[i + 2] = gfMul(a, 13) ^ gfMul(b, 9) ^ gfMul(c, 14) ^ gfMul(d, 11)
        data[i + 3] = gfMul(a, 11) ^ gfMul(b, 13) ^ gfMul(c, 9) ^ gfMul(d, 14)
      }
    }
    for (let i = 0; i < 16; i++) data[i] ^= ROUNDS[round * 16 + i]
  }
  for (let i = 0; i < 16; i++) data[i] ^= XOR[i]
  let seed = 3554400745913043027n ^ data.readBigUInt64LE(0) ^ data.readBigUInt64LE(8)
  for (let i = 28; i < 2076; i += 8) seed ^= key.readBigUInt64LE(i)
  return pad(seed, true)
}

/* --------------------------- protobuf 编解码 --------------------------- */

function writeVarint(bufs, value) {
  let v = BigInt(value)
  if (v < 0n) v = BigInt.asUintN(64, v)
  do {
    const byte = Number(v & 0x7fn)
    v >>= 7n
    bufs.push(Buffer.from([v !== 0n ? byte | 0x80 : byte]))
  } while (v !== 0n)
}

/** 与 Java 版 encode 一致：成对的 (字段号, 值)，字符串/字节走 wire=2，数字走 wire=0 */
export function encode(...pairs) {
  const bufs = []
  for (let i = 0; i < pairs.length; i += 2) {
    const id = Number(pairs[i])
    const val = pairs[i + 1]
    const isBytes = typeof val === 'string' || Buffer.isBuffer(val) || val instanceof Uint8Array
    writeVarint(bufs, id * 8 + (isBytes ? 2 : 0))
    if (isBytes) {
      const bytes = Buffer.isBuffer(val) ? val : Buffer.from(String(val), 'utf8')
      writeVarint(bufs, bytes.length)
      bufs.push(bytes)
    } else {
      writeVarint(bufs, Number(val))
    }
  }
  return Buffer.concat(bufs)
}

export function parse(buf) {
  const fields = []
  let off = 0
  const readVarint = () => {
    let result = 0n
    for (let i = 0; i < 10; i++) {
      if (off >= buf.length) throw new Error('星铁协议数据截断')
      const b = buf[off++]
      if (i === 9 && (b & 255) > 1) throw new Error('星铁协议整数溢出')
      result |= BigInt(b & 0x7f) << BigInt(i * 7)
      if ((b & 0x80) === 0) return result
    }
    throw new Error('星铁协议整数异常')
  }
  while (off < buf.length) {
    const key = readVarint()
    const id = Number(key >> 3n)
    const wire = Number(key & 7n)
    if (id === 0 || id > 536870911) throw new Error('星铁协议字段异常')
    if (wire === 0) {
      fields.push({ id, wire, number: readVarint(), bytes: null })
      continue
    }
    const len = wire === 2 ? Number(readVarint()) : wire === 1 ? 8 : wire === 5 ? 4 : -1
    if (len < 0 || len > buf.length - off) throw new Error('星铁协议字段长度异常')
    fields.push({ id, wire, number: 0n, bytes: Buffer.from(buf.subarray(off, off + len)) })
    off += len
  }
  return fields
}

function fieldOf(fields, id) {
  const hit = fields.find(f => f.id === id)
  if (!hit) throw new Error(`星铁协议配置需要更新（缺少字段 ${id}）`)
  return hit
}

export function number(fields, id) {
  const f = fieldOf(fields, id)
  if (f.wire !== 0) throw new Error('星铁协议字段类型变化')
  return f.number
}

export function bytes(fields, id) {
  const f = fieldOf(fields, id)
  if (f.wire !== 2) throw new Error('星铁协议字段类型变化')
  return f.bytes
}

export function string(fields, id) {
  return bytes(fields, id).toString('utf8')
}

/* ============================ KCP 会话 ============================ */

const MAGIC_HEAD = -1653291244 /* 0x9d79a2d4 */
const MAGIC_TAIL = -677293368 /* 0xd7a5f0c8 */
const MTU = 1172
const HANDSHAKE = Buffer.alloc(20)
HANDSHAKE.writeInt32BE(255, 0)
HANDSHAKE.writeInt32BE(255, 4)
HANDSHAKE.writeInt32BE(0, 8)
HANDSHAKE.writeInt32BE(255, 12)
HANDSHAKE.writeInt32BE(-1, 16)

const sleep = ms => new Promise(r => setTimeout(r, ms))

class SrConnection {
  constructor(host, port, padBytes) {
    this.conv = 0
    this.token = 0
    this.pad = padBytes
    this.recvSeq = 0
    this.sendSeq = 0
    this.sequence = 0
    this.pending = new Map()
    this.received = new Map()
    this.messages = []
    this.fragments = []
    this.fragmentCount = 0
    this.started = Date.now()
    this.inbox = []
    this.closed = false
    this.socket = dgram.createSocket('udp4')
    this.socket.on('message', msg => this.inbox.push(msg))
    this.socket.on('error', err => {
      this.closed = true
      this.socketError = err
    })
    this.host = host
    this.port = port
  }

  async open() {
    await new Promise((resolve, reject) => {
      const onErr = err => reject(err)
      this.socket.once('error', onErr)
      this.socket.connect(this.port, this.host, () => {
        this.socket.off('error', onErr)
        resolve()
      })
    })
  }

  send(buf) {
    if (this.closed) throw new Error('星铁游戏连接已关闭')
    this.socket.send(buf)
  }

  async read(timeout = 30) {
    const end = Date.now() + timeout
    while (!this.inbox.length) {
      if (this.closed) throw new Error('星铁游戏连接已关闭')
      if (Date.now() >= end) return null
      await sleep(5)
    }
    return this.inbox.shift()
  }

  segment(cmd, frg, sn, ts, payload = Buffer.alloc(0)) {
    const buf = Buffer.alloc(payload.length + 28)
    buf.writeInt32LE(this.conv, 0)
    buf.writeInt32LE(this.token, 4)
    buf.writeUInt8(cmd, 8)
    buf.writeUInt8(frg, 9)
    buf.writeInt16LE(256, 10)
    buf.writeInt32LE(ts | 0, 12)
    buf.writeInt32LE(sn | 0, 16)
    buf.writeInt32LE(this.recvSeq | 0, 20)
    buf.writeInt32LE(payload.length, 24)
    payload.copy(buf, 28)
    return buf
  }

  xor(buf) {
    const out = Buffer.from(buf)
    for (let i = 0; i < out.length; i++) out[i] ^= this.pad[i % this.pad.length]
    return out
  }

  /** 握手：发 255/255/0/255/-1，收回 325/conv/token */
  async connect() {
    for (let i = 0; i < 8; i++) {
      this.send(HANDSHAKE)
      const end = Date.now() + 500
      while (Date.now() < end) {
        const pkt = await this.read(20)
        if (pkt && pkt.length === 20 && pkt.readInt32BE(0) === 325) {
          this.conv = pkt.readInt32BE(4)
          this.token = pkt.readInt32BE(8)
          return
        }
      }
    }
    throw new Error('无法连接星铁游戏服务器，请检查 UDP 网络后重试')
  }

  /** 处理一个 UDP 包（可能粘多个 KCP 段） */
  receive(buf) {
    if (buf.length === 20) {
      if (buf.readInt32BE(0) === 404 && buf.readInt32BE(4) === this.conv && buf.readInt32BE(8) === this.token) {
        throw new Error('星铁游戏连接已关闭')
      }
      return
    }
    let off = 0
    while (off < buf.length) {
      if (buf.length - off < 28) throw new Error('星铁 KCP 数据截断')
      const conv = buf.readInt32LE(off)
      const token = buf.readInt32LE(off + 4)
      const cmd = buf.readUInt8(off + 8)
      const frg = buf.readUInt8(off + 9)
      const ts = buf.readInt32LE(off + 12)
      const sn = buf.readInt32LE(off + 16)
      const una = buf.readInt32LE(off + 20)
      const len = buf.readInt32LE(off + 24)
      off += 28
      if (conv !== this.conv || token !== this.token || len < 0 || len > buf.length - off) {
        throw new Error('星铁 KCP 数据异常')
      }
      const payload = buf.subarray(off, off + len)
      off += len
      for (const key of [...this.pending.keys()]) {
        if (Number(BigInt.asUintN(32, BigInt(key)) < BigInt.asUintN(32, BigInt(una)))) this.pending.delete(key)
      }
      if (cmd === 82) {
        this.pending.delete(sn | 0)
      } else if (cmd === 81) {
        const uSn = BigInt.asUintN(32, BigInt(sn))
        const uRecv = BigInt.asUintN(32, BigInt(this.recvSeq))
        if (uSn >= uRecv && !this.received.has(sn | 0)) {
          if (Number(uSn - uRecv) > 4096 || this.received.size >= 4096) throw new Error('星铁接收窗口异常')
          this.received.set(sn | 0, { remaining: frg, bytes: Buffer.from(payload) })
        }
        while (this.received.has(this.recvSeq | 0)) {
          const frag = this.received.get(this.recvSeq | 0)
          this.received.delete(this.recvSeq | 0)
          this.recvSeq = (this.recvSeq + 1) | 0
          this.fragmentCount++
          if (this.fragmentCount > 256) throw new Error('星铁分片超过上限')
          this.fragments.push(frag.bytes)
          if (this.fragments.reduce((n, b) => n + b.length, 0) > 1048576) throw new Error('星铁消息超过上限')
          if (frag.remaining === 0) {
            if (this.messages.length >= 256) throw new Error('星铁消息超过上限')
            this.messages.push(Buffer.concat(this.fragments))
            this.fragments = []
            this.fragmentCount = 0
          }
        }
        this.send(this.segment(82, 0, sn | 0, ts, Buffer.alloc(0)))
      } else if (cmd === 83) {
        this.send(this.segment(84, 0, 0, 0, Buffer.alloc(0)))
      }
    }
  }

  tick() {
    const now = Date.now()
    for (const p of this.pending.values()) {
      if (now - p.last >= Math.min(1500, 350 << Math.max(0, p.tries - 1))) {
        if (p.tries >= 6) throw new Error('星铁连接确认超时，请稍后重试')
        this.send(this.segment(81, p.fragment, p.seq, now - this.started, p.bytes))
        p.last = now
        p.tries++
      }
    }
  }

  async request(cmd, body, protoId, timeout = 15000) {
    this.sequence = (this.sequence + 1) | 0
    const head = encode(1, this.sequence)
    const raw = Buffer.alloc(head.length + 16 + body.length)
    raw.writeInt32BE(MAGIC_HEAD, 0)
    raw.writeInt16BE(cmd, 4)
    raw.writeInt16BE(head.length, 6)
    raw.writeInt32BE(body.length, 8)
    head.copy(raw, 12)
    body.copy(raw, 12 + head.length)
    raw.writeInt32BE(MAGIC_TAIL, raw.length - 4)
    const framed = this.xor(raw)

    const total = Math.ceil(framed.length / MTU)
    if (total > 255) throw new Error('星铁请求超过上限')
    for (let i = 0; i < total; i++) {
      const sn = this.sendSeq++
      this.pending.set(sn, {
        seq: sn,
        fragment: total - i - 1,
        bytes: framed.subarray(i * MTU, Math.min(framed.length, (i + 1) * MTU)),
        last: 0,
        tries: 0,
      })
    }

    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      this.tick()
      while (this.messages.length) {
        const plain = this.xor(this.messages.shift())
        if (plain.length < 16) throw new Error('星铁消息截断')
        const magic = plain.readInt32BE(0)
        const proto = plain.readUInt16BE(4)
        const headLen = plain.readUInt16BE(6)
        const bodyLen = plain.readInt32BE(8)
        if (magic !== MAGIC_HEAD || bodyLen < 0 || bodyLen + headLen + 16 !== plain.length || plain.readInt32BE(plain.length - 4) !== MAGIC_TAIL) {
          throw new Error('星铁协议配置需要更新')
        }
        if (proto === protoId) {
          const start = headLen + 12
          return parse(plain.subarray(start, bodyLen + start))
        }
      }
      const pkt = await this.read(30)
      if (pkt) this.receive(pkt)
    }
    throw new Error('星铁服务器响应超时，请稍后重试')
  }

  /** PlayerGetToken + PlayerLogin，返回登录后的 UID 字符串 */
  async login(aid, comboToken, loginBody) {
    await this.connect()
    const resp = await this.request(60, encode(3, comboToken, 6, aid, 7, 1, 10, 3, 15, 1), 16)
    const secret = number(resp, 12)
    const uid = number(resp, 15)
    this.pad = pad(secret, false) // BIG_ENDIAN：之后全部用服务端下发密钥
    await this.request(34, loginBody, 25)
    await this.request(80, Buffer.alloc(0), 67)
    return uid.toString()
  }

  async authkey() {
    const resp = await this.request(64, encode(2, 'webview_gacha', 5, 1, 9, 2), 21)
    const key = string(resp, 6)
    if (key.length === 684 && number(resp, 10) === 1n && number(resp, 13) === 2n && string(resp, 15) === 'webview_gacha') {
      return key
    }
    throw new Error('星铁抽卡授权格式变化，请更新协议配置')
  }

  close() {
    try {
      this.socket.close()
    } catch {
      /* ignore */
    }
    this.pending.clear()
    this.received.clear()
    this.messages = []
    this.pad.fill(0)
  }
}

/* ============================ HTTP 层 ============================ */

function md5hex(str) {
  return createHash('md5').update(str, 'utf8').digest('hex')
}

function randHex(bytes) {
  return randomBytes(bytes).toString('hex')
}

/** 与 APK sdkSign 一致：key 字典序 → k=v 用 & 连接 → HmacSHA256 → hex */
function sdkSign(obj, key) {
  const text = Object.keys(obj)
    .sort()
    .map(k => `${k}=${obj[k]}`)
    .join('&')
  return createHmac('sha256', key).update(text, 'utf8').digest('hex')
}

/** DS：salt=salt&t=ts&r=rand → MD5，返回 "t,r,md5"（SDK 侧用固定盐） */
const SDK_DS_SALT = '6s25p5ox5y14umn1p61aqyyvbvvl3lrt'
function sdkDs() {
  const t = Math.floor(Date.now() / 1000)
  const r = Math.floor(Math.random() * 100000) + 100001
  return `${t},${r},${md5hex(`salt=${SDK_DS_SALT}&t=${t}&r=${r}`)}`
}

function parseQuery(url) {
  const out = {}
  try {
    const q = new URL(url).search || (url.includes('?') ? url.slice(url.indexOf('?')) : '')
    for (const [k, v] of new URLSearchParams(q.replace(/^\?/, ''))) out[k] = v
  } catch {
    /* ignore */
  }
  return out
}

const SDK_UA = 'Mozilla/5.0 (Linux; Android 12) Mobile miHoYoBBS/2.86.0'

async function postJson(url, body, headers = {}, { timeout = 15000, label = '' } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': SDK_UA,
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  const aigis = res.headers.get('x-rpc-aigis') || ''
  const text = await res.text()
  let json = {}
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`星铁登录请求返回非 JSON（${label || url}，HTTP ${res.status}）`)
  }
  if (Number(json.retcode) !== 0) {
    if (aigis) throw new Error('米游社要求安全验证（极验），当前会话无法自动通过，请稍后在米游社 App 内确认')
    const detail = json.message ? ` ${json.message}` : ''
    throw new Error(`星铁登录请求失败【${label || url}】${detail}（${json.retcode}）`)
  }
  if (!json.data) throw new Error(`星铁登录数据不完整【${label || url}】`)
  return json.data
}

async function getProtoFields(url, { timeout = 20000 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) })
  if (!res.ok) throw new Error(`连接星铁网关失败（HTTP ${res.status}）`)
  const text = (await res.text()).trim()
  const raw = Buffer.from(text, 'base64')
  return parse(raw)
}

const GATEWAY_HOSTS = ['globaldp-prod-cn01.bhsr.com', 'prod-gf-cn-dp01.bhsr.com', 'prod-gf-cn-dp02.bhsr.com']
function gatewayAllowed(url) {
  try {
    const u = new URL(url)
    return (
      u.protocol === 'https:' &&
      !u.username &&
      (u.port === '' || u.port === '443') &&
      GATEWAY_HOSTS.includes(u.hostname) &&
      ['/query_dispatch', '/query_gateway'].includes(u.pathname)
    )
  } catch {
    return false
  }
}

/* ============================ 对外流程 ============================ */

const CACHE_TTL = 5 * 60 * 1000
const COOLDOWN = 60 * 1000
const cache = new Map() // `${aid}:${uid}` -> { authkey, at }
const lastRun = new Map()
const busy = new Set()

function log(level, msg, logger) {
  const line = `[HoYoGet][sr_authkey] ${msg}`
  if (!logger) return
  if (level === 'error') logger.error?.(line)
  else if (level === 'warn') logger.warn?.(line)
  else logger.mark?.(line)
}

/**
 * 走「临时登录游戏客户端」拿 authkey。
 *
 * @param {object} opt
 * @param {string} opt.stoken      米游社 stoken（必填）
 * @param {string} opt.stuid       米游社 stuid/ltuid（必填，登录票据 Cookie 需要）
 * @param {string} opt.mid         米游社 mid（必填，新版接口校验）
 * @param {string|number} opt.uid  游戏 UID（用于校验登录结果）
 * @param {string} [opt.region]    区服，仅支持 prod_gf_cn / prod_qd_cn
 * @param {object} [opt.logger]    Yunzai logger
 * @param {Function} [opt.onStep]  进度回调 (text) => void
 * @returns {Promise<{authkey: string, uid: string, cached?: boolean}>}
 */
export async function getSrAuthkey(opt = {}) {
  const { stoken, stuid, mid, logger, onStep } = opt
  const uid = String(opt.uid || '')
  const region = String(opt.region || (/^5/.test(uid) ? 'prod_qd_cn' : 'prod_gf_cn'))
  const aid = String(stuid || '')
  const step = text => {
    try {
      onStep?.(text)
    } catch {
      /* ignore */
    }
  }

  if (!stoken || !aid || !mid) throw new Error('缺少 stoken / stuid / mid，无法换取星铁授权')
  if (region !== 'prod_gf_cn') throw new Error('免链接更新目前仅支持星铁国服官服（prod_gf_cn）')

  const cacheKey = `${aid}:${uid}`
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.at < CACHE_TTL) return { authkey: hit.authkey, uid, cached: true }

  if (busy.has(cacheKey)) throw new Error('这个账号正在获取星铁授权，请等待完成')
  const last = lastRun.get(cacheKey) || 0
  if (Date.now() - last < COOLDOWN) {
    throw new Error(`请在 ${Math.ceil((COOLDOWN - (Date.now() - last)) / 1000)} 秒后重试星铁更新`)
  }

  busy.add(cacheKey)
  lastRun.set(cacheKey, Date.now())
  const config = loadNative()
  // 设备指纹随机化，与 APK randomizeLoginDevice 一致（每次登录换一台"机器"）
  const device = randHex(27).slice(0, 53)
  const deviceFp = randHex(7).slice(0, 13)
  const deviceId = randHex(16)
  config.device = device
  config.verifyHeaders = { ...config.verifyHeaders, 'x-rpc-device_id': device, 'x-rpc-device_fp': deviceFp }

  const session = { aid, stoken, mid }
  let verifyHeaders = { ...config.verifyHeaders }

  try {
    /* --- 1. game_token：SDK 扫码票据 --- */
    step('正在获取星铁登录授权…')
    // fetch 是整条链路里唯一"零副作用"的请求，-3001 多为头部组合不被接受，
    // 这里按 APK 头部 → 补 app_version/sdk_version → 换 app_id 三档试，
    // 成功的那套头部沿用到后续步骤，避免让用户反复重试。
    const variants = [
      { tag: 'apk', headers: verifyHeaders },
      {
        tag: 'appver',
        headers: { ...verifyHeaders, 'x-rpc-app_version': '2.86.0', 'x-rpc-sdk_version': '2.35.0', Referer: 'https://app.mihoyo.com' },
      },
      {
        tag: 'passport',
        headers: { ...verifyHeaders, 'x-rpc-app_id': 'bll8iq97cem8', 'x-rpc-app_version': '2.86.0', 'x-rpc-sdk_version': '2.35.0', Referer: 'https://app.mihoyo.com' },
      },
    ]
    let ticketResp = null
    const tried = []
    for (const v of variants) {
      try {
        ticketResp = await postJson(
          'https://hkrpg-sdk.mihoyo.com/hkrpg_cn/combo/panda/qrcode/fetch',
          { app_id: config.appId, device },
          v.headers,
          { label: `qrcode/fetch/${v.tag}` }
        )
        verifyHeaders = v.headers
        if (v.tag !== 'apk') log('warn', `qrcode/fetch 头部变体 ${v.tag} 可用，已切换`, logger)
        break
      } catch (err) {
        tried.push(`${v.tag}: ${err?.message || err}`)
      }
    }
    if (!ticketResp) throw new Error(`星铁登录票据获取失败（${tried.join(' | ')}）`)
    const qrParams = parseQuery(ticketResp.url || ticketResp.qr_url || '')
    const ticket = qrParams.ticket
    if (!ticket || (qrParams.app_id && qrParams.app_id !== '8')) throw new Error('星铁登录票据无效')

    const scanResp = await postJson(
      'https://hkrpg-sdk.mihoyo.com/hkrpg_cn/combo/panda/qrcode/scan',
      { passport_app_id: 'bll8iq97cem8', ticket, app_id: config.appId, device: deviceId, ts: Math.floor(Date.now() / 1000) },
      {},
      { label: 'qrcode/scan' }
    )
    const scanParams = parseQuery(scanResp.passport_qr_url || '')
    const tk = scanParams.tk
    const tokenTypes = scanParams.token_types
    if (!tk || !tokenTypes) throw new Error('星铁授权票据缺少参数')

    /* --- 2. 用 stoken 帮自己"扫码确认"，拿到 game_token --- */
    const passportHeaders = {
      'x-rpc-app_version': '2.86.0',
      'x-rpc-client_type': '2',
      'x-rpc-sdk_version': '2.35.0',
      'x-rpc-device_id': deviceId,
      'x-rpc-app_id': 'bll8iq97cem8',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 12) Mobile miHoYoBBS/2.86.0',
      Referer: 'https://app.mihoyo.com',
      Cookie: `stoken=${stoken}; stuid=${aid}; mid=${mid};`,
      'x-rpc-sys_version': '12',
      'x-rpc-channel': 'xiaomi',
      'x-rpc-device_name': 'Xiaomi 2206123SC',
      'x-rpc-device_model': '2206123SC',
      DS: sdkDs(),
    }
    // 实测（2026-11）：scanQRLogin / confirmQRLogin 只认 fetch 拿到的**原始 ticket**；
    // 传 scan 返回的 tk（APK 的做法）现在会被判 -3001 参数不合法。
    // tk 仍拿来做"scan 是否成功"的校验，但不进请求体。
    const scanBody = {
      ticket,
      // 服务端要求数字数组；传 ["1"] 会被判 -3001 参数不合法（实测）
      token_types: String(tokenTypes)
        .split(',')
        .map(s => Number(String(s).trim()))
        .filter(n => Number.isFinite(n)),
    }
    const loginResp = await postJson('https://passport-api.mihoyo.com/account/ma-cn-passport/app/scanQRLogin', scanBody, passportHeaders, { label: 'scanQRLogin' })
    const appName = String(loginResp.app_name || '')
    if (appName && !appName.includes('星穹铁道')) throw new Error('授权应用与星铁不符，已停止')

    passportHeaders.DS = sdkDs()
    await postJson('https://passport-api.mihoyo.com/account/ma-cn-passport/app/confirmQRLogin', scanBody, passportHeaders, { label: 'confirmQRLogin' })

    let gameToken = ''
    let gameMid = mid
    for (let i = 0; i < 8; i++) {
      const data = await postJson(
        'https://hkrpg-sdk.mihoyo.com/hkrpg_cn/combo/panda/qrcode/query',
        { app_id: config.appId, device, ticket },
        verifyHeaders,
        { label: 'qrcode/query' }
      )
      if (String(data.stat) === 'Confirmed') {
        let raw = data.payload?.raw ?? data.payload
        if (typeof raw === 'string') raw = JSON.parse(raw)
        const token = raw.game_token || raw.token || ''
        const accountId = String(raw.account_id || raw.uid || '')
        if (!token) throw new Error('星铁登录票据无效')
        if (accountId && accountId !== aid) throw new Error('星铁授权账号不匹配，已停止')
        gameToken = token
        gameMid = String(raw.mid || mid)
        break
      }
      if (String(data.stat) === 'Expired') throw new Error('星铁登录票据已过期，请重试')
      await sleep(1000)
    }
    if (!gameToken) throw new Error('等待星铁授权结果超时，请重试')

    /* --- 3. SDK 登录换 combo_token --- */
    step('正在验证星铁登录凭据…')
    const verifyResp = await postJson(
      'https://passport-api.mihoyo.com/account/ma-cn-session/app/verify',
      { mid: gameMid, token: { token_type: 1, token: gameToken }, refresh: true },
      verifyHeaders,
      { label: 'session/verify' }
    )
    if (String(verifyResp.user_info?.aid || '') !== aid) throw new Error('游戏登录凭据所属账号不符')
    let token = gameToken
    const newToken = verifyResp.new_token
    if (newToken && newToken.token) {
      if (Number(newToken.token_type) !== 1) throw new Error('未知游戏登录凭据类型')
      token = newToken.token
    }
    const granterBody = {
      data: JSON.stringify({ uid: aid, guest: false, token }),
      app_id: config.appId,
      channel_id: config.channelId,
      device,
    }
    granterBody.sign = sdkSign(granterBody, config.sdkPublicAppKey)
    const granter = await postJson(
      'https://hkrpg-sdk.mihoyo.com/hkrpg_cn/combo/granter/login/v2/login',
      granterBody,
      { 'x-rpc-client_type': '3', 'x-rpc-game_biz': 'hkrpg_cn' },
      { label: 'granter/login' }
    )
    if (String(granter.open_id || '') !== aid || !granter.combo_token) throw new Error('星铁 SDK 登录账号不匹配')
    const comboToken = String(granter.combo_token)

    /* --- 4. 区服发现 + 网关参数 --- */
    step('正在连接星铁网关…')
    const dispatchUrl =
      'https://globaldp-prod-cn01.bhsr.com/query_dispatch?' +
      new URLSearchParams({
        version: config.version,
        t: String(Math.floor(Date.now() / 1000)),
        language_type: '1',
        platform_type: '3',
        channel_id: '1',
        sub_channel_id: '1',
        is_new_format: '1',
      }).toString()
    const dispatch = await getProtoFields(dispatchUrl)
    let gatewayUrl = ''
    for (const f of dispatch) {
      if (f.id !== 4 || f.wire !== 2) continue
      const sub = parse(f.bytes)
      if (string(sub, 1) === region) {
        gatewayUrl = string(sub, 3)
        break
      }
    }
    if (!gatewayUrl) throw new Error('星铁网关没有返回匹配区服')
    if (!gatewayAllowed(gatewayUrl)) throw new Error('星铁网关地址无效')

    const gwBase = new URL(gatewayUrl)
    const gatewayReq =
      `${gwBase.protocol}//${gwBase.host}${gwBase.pathname}?` +
      new URLSearchParams({
        uid,
        dispatch_seed: config.dispatchSeed,
        is_need_url: '1',
        game_version: config.gameVersion,
        account_type: '1',
        account_uid: aid,
      }).toString()
    if (!gatewayAllowed(gatewayReq)) throw new Error('星铁网关地址无效')
    const gw = await getProtoFields(gatewayReq)
    const host = string(gw, config.gatewayFields.host)
    const port = Number(number(gw, config.gatewayFields.port))
    const ec2bKey = Buffer.from(string(gw, config.gatewayFields.ec2b), 'base64')
    if (!(port >= 1 && port <= 65535)) throw new Error('星铁服务器端口无效')

    /* --- 5. KCP 登录 + 取 authkey --- */
    step('正在临时登录星铁并获取跃迁授权…')
    const padBytes = ec2b(ec2bKey)
    const loginBody = buildLoginBody(config)
    const conn = new SrConnection(host, port, padBytes)
    try {
      await conn.open()
      const loginUid = await conn.login(aid, comboToken, loginBody)
      if (loginUid !== String(uid)) throw new Error('星铁登录 UID 与所选角色不匹配，已停止更新')
      const authkey = await conn.authkey()
      cache.set(cacheKey, { authkey, at: Date.now() })
      log('info', `已获取 ${uid} 的 authkey（${authkey.length} 字符）`, logger)
      return { authkey, uid }
    } finally {
      conn.close()
    }
  } finally {
    busy.delete(cacheKey)
  }
}

/** 按 APK randomizeLoginDevice 的规则重写登录包（设备号/指纹/serial_number 随机化） */
function buildLoginBody(config) {
  const fields = parse(Buffer.from(config.loginBodyBase64, 'base64'))
  const deviceField = fields.find(f => f.id === 7)
  if (!deviceField || deviceField.bytes?.toString('utf8') !== config.device) {
    throw new Error('星铁登录设备配置不一致')
  }
  const info = JSON.parse(fields.find(f => f.id === 15).bytes.toString('utf8'))
  info.serial_number = `${config.device}_${cryptoRandomUUID()}_${Math.floor(Date.now() / 1000)}`
  const deviceBytes = Buffer.from(config.device, 'utf8')
  const infoBytes = Buffer.from(JSON.stringify(info), 'utf8')
  const fpBytes = Buffer.from(config.verifyHeaders['x-rpc-device_fp'], 'utf8')
  const chunks = []
  for (const f of fields) {
    writeVarint(chunks, (f.id << 3) | f.wire)
    if (f.wire === 0) {
      writeVarint(chunks, f.number)
      continue
    }
    const data = f.id === 7 ? deviceBytes : f.id === 15 ? infoBytes : f.id === 1748 ? fpBytes : f.bytes
    writeVarint(chunks, data.length)
    chunks.push(data)
  }
  return Buffer.concat(chunks)
}

function cryptoRandomUUID() {
  const b = randomBytes(16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export function clearSrAuthkeyCache() {
  cache.clear()
  lastRun.clear()
}

/* 供离线自测/调试使用 */
export const __internals = { ec2b, pad, Mt64, encode, parse, number, string, bytes, sdkSign, buildLoginBody, SrConnection, loadNative }
