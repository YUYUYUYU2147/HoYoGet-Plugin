const GAMES = [
  { key: 'gs', symbol: '#', canonical: '原神', defaultPrefix: '#|＃|米哈游原神|原神|genshin|gs' },
  { key: 'sr', symbol: '*', canonical: '星铁', defaultPrefix: '*|＊|米哈游星铁|米哈游崩铁|米哈游星穹铁道|星铁|星穹铁道|崩铁|starrail|sr' },
  { key: 'zzz', symbol: '%', canonical: '绝区零', defaultPrefix: '%|％|米哈游绝区零|绝区零|绝区|zzz' },
  { key: 'bh3', symbol: '#', canonical: '崩三', defaultPrefix: '!|！|米哈游崩坏三|崩坏三|崩坏3|崩三|bh3' },
]

const SYMBOLS = { '#': 'gs', '＃': 'gs', '*': 'sr', '＊': 'sr', '%': 'zzz', '％': 'zzz', '!': 'bh3', '！': 'bh3' }
function prefixList(game, config) {
  const raw = config?.[`${game.key}_command_prefixes`] ?? game.defaultPrefix
  return String(raw).split(/[|，,\n]/).map(value => value.trim()).filter(Boolean)
}

export function parseHoYoGetPrefix(message, config = {}) {
  const input = String(message ?? '').trimStart()
  if (!input) return null

  const symbolGame = SYMBOLS[input[0]]
  const body = symbolGame ? input.slice(1).trimStart() : input
  const prefixes = GAMES.flatMap(game => prefixList(game, config).map(prefix => ({ game, prefix })))
    .sort((a, b) => b.prefix.length - a.prefix.length)
  const match = prefixes.find(({ prefix }) => body.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase()))
  if (!match) {
    if (!symbolGame) return null
    return { game: symbolGame, text: body, normalized: input[0] + body, kind: 'symbol' }
  }

  const rest = body.slice(match.prefix.length).trimStart()
  const normalized = match.game.symbol + match.game.canonical + rest
  return { game: match.game.key, text: rest, normalized, kind: 'text' }
}

export function normalizeHoYoGetEvent(event, config = {}) {
  if (!event || event.__hoyoGetPrefixNormalized) return null
  const segments = event.message?.filter?.(item => item.type === 'text')
  const raw = typeof event.raw_msg === 'string'
    ? event.raw_msg
    : typeof event.raw_message === 'string'
      ? event.raw_message
      : segments?.length
        ? segments.map(item => item.text || '').join('')
      : typeof event.original_msg === 'string'
        ? event.original_msg
        : event.msg
  if (typeof raw !== 'string') return null
  if (event.raw_msg === undefined) event.raw_msg = raw

  const parsed = parseHoYoGetPrefix(raw, config)
  if (!parsed) return null

  event.__hoyoGetPrefixNormalized = true
  event.hoyoGetGame = parsed.game
  event.msg = parsed.normalized
  if (typeof event.original_msg === 'string') event.original_msg = parsed.normalized
  return parsed
}

