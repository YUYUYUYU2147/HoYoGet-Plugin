const MODE_BY_PREFIX = {
  '#': 'all',
  '*': 'sr',
  '%': 'zzz',
  '!': 'bh3',
  '！': 'bh3',
}

export function uidViewModeFromPrefix(prefix) {
  return MODE_BY_PREFIX[String(prefix || '')] || ''
}

export function selectUidGames(games, mode = 'all') {
  const list = Array.isArray(games) ? games : []
  if (mode === 'all') return list.slice()
  return list.filter(game => game?.key === mode)
}

export function shouldUseUidGrid(games, mode = 'all', threshold = 10) {
  if (mode !== 'all') return false
  const count = (Array.isArray(games) ? games : [])
    .reduce((total, game) => total + (Array.isArray(game?.uidList) ? game.uidList.length : 0), 0)
  return count > threshold
}
