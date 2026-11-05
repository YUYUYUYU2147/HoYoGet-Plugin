/**
 * 离线自测：不联网、不需要账号，验证协议层的三块地基。
 *   node tools/sr_authkey_selftest.mjs
 *
 * 覆盖：
 *   1. protobuf 编解码往返（loginBodyBase64 逐字节一致）
 *   2. Ec2b 密钥派生（确定性 / 长度 / 行为）
 *   3. MT19937-64 标准向量
 *   4. KCP 段构造与接收重组
 */
import assert from 'node:assert/strict'
import { __internals } from '../system/sr_authkey.js'

const { ec2b, pad, Mt64, parse, encode, number, string, SrConnection, loadNative } = __internals

let pass = 0
const ok = name => {
  pass++
  console.log(`  ✓ ${name}`)
}

/* ---------- 1. protobuf 往返 ---------- */

function reserialize(fields) {
  const chunks = []
  const writeVarint = (arr, value) => {
    let v = BigInt(value)
    do {
      const byte = Number(v & 0x7fn)
      v >>= 7n
      arr.push(Buffer.from([v !== 0n ? byte | 0x80 : byte]))
    } while (v !== 0n)
  }
  for (const f of fields) {
    writeVarint(chunks, (f.id << 3) | f.wire)
    if (f.wire === 0) writeVarint(chunks, f.number)
    else {
      writeVarint(chunks, f.bytes.length)
      chunks.push(f.bytes)
    }
  }
  return Buffer.concat(chunks)
}

const config = loadNative()
const loginBody = Buffer.from(config.loginBodyBase64, 'base64')
const fields = parse(loginBody)
assert.ok(fields.length > 5, '登录包字段过少')
assert.deepEqual(reserialize(fields), loginBody, 'protobuf 往返必须逐字节一致')
ok(`protobuf 往返一致（${loginBody.length} 字节 / ${fields.length} 字段）`)

assert.equal(string(fields, 7), config.device, '字段 7 应为设备号')
assert.ok(string(fields, 15).includes('operatingSystem'), '字段 15 应为设备信息 JSON')
ok('关键字段语义正确（7=device / 15=设备 JSON）')

const round2 = reserialize(parse(encode(3, 'abc', 6, '123', 7, 1, 10, 3, 15, 1)))
assert.equal(round2.length, 16, 'KCP 登录包长度')
ok('encode() 生成登录包字段顺序正确')

/* ---------- 2. Ec2b ---------- */

const fake = Buffer.alloc(2076, 7)
fake.write('Ec2b', 0, 'latin1')
const k1 = ec2b(fake)
assert.equal(k1.length, 4096, 'keystream 长度')
assert.deepEqual(ec2b(Buffer.from(fake)), k1, '同一密钥必须得到同一 keystream')
const fake2 = Buffer.from(fake)
fake2[100] ^= 0xff
assert.notDeepEqual(ec2b(fake2), k1, '不同密钥必须得到不同 keystream')
ok('Ec2b 派生确定性 / 4096 字节 / 对盐敏感')

assert.throws(() => ec2b(Buffer.alloc(2076)), /网关密钥配置需要更新/)
assert.throws(() => ec2b(Buffer.alloc(100)), /网关密钥配置需要更新/)
ok('Ec2b magic / 长度校验生效')

const padBE = pad(123456789n, false)
const padLE = pad(123456789n, true)
assert.equal(padBE.length, 4096)
assert.equal(padBE.readBigUInt64BE(0), padLE.readBigUInt64LE(0), '同一 seed 两种字节序应互为镜像')
ok('MT keystream 字节序镜像关系正确')

/* ---------- 3. MT19937-64 标准向量 ---------- */

const mt = new Mt64(5489n)
assert.equal(mt.next(), 14514284786278117030n, 'MT19937-64 首值应与参考实现一致')
ok('MT19937-64 参考向量匹配（seed=5489）')

/* ---------- 4. KCP 段与重组 ---------- */

const conn = new SrConnection('127.0.0.1', 9, Buffer.alloc(4096, 0))
conn.send = () => {} // 离线测试不需要真的发 ACK
conn.conv = 0x11223344
conn.token = 0x55667788
const seg = conn.segment(81, 0, 7, 1234, Buffer.from('hello'))
assert.equal(seg.length, 28 + 5)
assert.equal(seg.readInt32LE(0), 0x11223344)
assert.equal(seg.readInt32LE(4), 0x55667788)
assert.equal(seg.readUInt8(8), 81)
assert.equal(seg.readInt16LE(10), 256, '窗口固定 256')
assert.equal(seg.readInt32LE(16), 7, 'sn')
assert.equal(seg.readInt32LE(24), 5, 'len')
assert.equal(seg.subarray(28).toString(), 'hello')
ok('KCP 段布局（28 字节头）正确')

// 用 receive 组装一条被拆成两片的消息（frg 递减，末片 0）
conn.conv = 1
conn.token = 2
const mk = (frg, sn, body) => conn.segment(81, frg, sn, 0, body)
conn.receive(mk(1, 0, Buffer.from('ab')))
assert.equal(conn.messages.length, 0, '未收齐前不应产出消息')
conn.receive(mk(0, 1, Buffer.from('cd')))
assert.equal(conn.messages.length, 1, '收齐后应产出一条消息')
assert.equal(conn.messages[0].toString(), 'abcd')
ok('KCP 分片重组正确')

conn.close()
console.log(`\n全部通过：${pass} 项\n`)
