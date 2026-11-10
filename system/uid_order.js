export function orderUidRowsByReference(rows, reference = []) {
  const referenceOrder = new Map()
  for (const item of Array.isArray(reference) ? reference : []) {
    const uid = String(item?.uid ?? item?.uid_str ?? item ?? '').trim()
    if (uid && !referenceOrder.has(uid)) referenceOrder.set(uid, referenceOrder.size)
  }

  return (Array.isArray(rows) ? rows : [])
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aUid = String(a.item?.uid ?? a.item?.uid_str ?? '').trim()
      const bUid = String(b.item?.uid ?? b.item?.uid_str ?? '').trim()
      const aOrder = referenceOrder.has(aUid) ? referenceOrder.get(aUid) : Number.MAX_SAFE_INTEGER
      const bOrder = referenceOrder.has(bUid) ? referenceOrder.get(bUid) : Number.MAX_SAFE_INTEGER
      return aOrder - bOrder || a.index - b.index
    })
    .map(row => row.item)
}
