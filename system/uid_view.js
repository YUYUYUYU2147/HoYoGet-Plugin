const MODE_BY_PREFIX = {
  '#': 'all',
  '*': 'sr',
  '%': 'zzz',
  '!': 'bh3',
  '！': 'bh3',
}

export const UID_LAYOUT_WIDTH = {
  single: 450,
  grid: 790,
}
export const UID_RENDER_SCALE = 1.4

export function uidViewModeFromPrefix(prefix) {
  return MODE_BY_PREFIX[String(prefix || '')] || ''
}

export function selectUidGames(games, mode = 'all') {
  const list = Array.isArray(games) ? games : []
  if (mode === 'all') return list.slice()
  return list.filter(game => game?.key === mode)
}

export function shouldUseUidGrid(games, threshold = 10) {
  const count = (Array.isArray(games) ? games : [])
    .reduce((total, game) => total + (Array.isArray(game?.uidList) ? game.uidList.length : 0), 0)
  return count > threshold
}

export function uidRenderViewportWidth(games) {
  const layoutWidth = shouldUseUidGrid(games) ? UID_LAYOUT_WIDTH.grid : UID_LAYOUT_WIDTH.single
  return Math.ceil(layoutWidth * UID_RENDER_SCALE)
}
