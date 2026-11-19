import assert from 'node:assert/strict'
import test from 'node:test'

globalThis.plugin = class { constructor (options) { Object.assign(this, options) } }
globalThis.logger = { warn () {}, error () {}, debug () {}, mark () {} }
globalThis.config = () => ({})
globalThis.Bot = {}

const { githubNoreplyLogin, getUpdateLogAvatar } = await import('../apps/common/update.js')

const image = (type = 'image/jpeg') => new Response('avatar', { headers: { 'content-type': type } })

test('github noreply login supports old and new formats', () => {
  assert.equal(githubNoreplyLogin('130297022+YUYUYUYU2147@users.noreply.github.com'), 'YUYUYUYU2147')
  assert.equal(githubNoreplyLogin('octocat@users.noreply.github.com'), 'octocat')
  assert.equal(githubNoreplyLogin('dev@example.com'), '')
  assert.equal(githubNoreplyLogin(''), '')
})

test('noreply commits use the GitHub avatar directly', async (t) => {
  const calls = []
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async url => {
    calls.push(String(url))
    return image()
  }

  const avatar = await getUpdateLogAvatar('owner/repo', {
    authorEmail: '130297022+YUYUYUYU2147@users.noreply.github.com',
    author: '鱼鱼鱼鱼',
    fullHash: '79c7258',
  })

  assert.match(avatar, /^data:image\/jpeg;base64,/)
  assert.ok(calls.includes('https://github.com/YUYUYUYU2147.png?size=96'))
  assert.ok(!calls.some(url => url.startsWith('https://api.github.com/')))
})

test('regular emails fall back to the GitHub commit API', async (t) => {
  const calls = []
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async url => {
    const target = String(url)
    calls.push(target)
    if (target.startsWith('https://api.github.com/')) {
      return Response.json({ author: { avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' } })
    }
    if (target.startsWith('https://cravatar.cn/')) return new Response('', { status: 404 })
    return image()
  }

  const avatar = await getUpdateLogAvatar('owner/repo', {
    authorEmail: 'dev@example.com',
    author: 'Dev',
    fullHash: 'abc1234',
  })

  assert.match(avatar, /^data:image\/jpeg;base64,/)
  assert.ok(!calls.some(url => url.startsWith('https://github.com/')))
  assert.ok(calls.some(url => url.startsWith('https://api.github.com/repos/owner/repo/commits/abc1234')))
  assert.ok(calls.includes('https://avatars.githubusercontent.com/u/1?v=4'))
})

test('offline authors get a local identicon', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => { throw new Error('offline') }

  const avatar = await getUpdateLogAvatar('owner/repo', {
    authorEmail: 'offline@example.com',
    author: 'Offline',
    fullHash: 'def5678',
  })

  assert.match(avatar, /^data:image\/svg\+xml;base64,/)
})
