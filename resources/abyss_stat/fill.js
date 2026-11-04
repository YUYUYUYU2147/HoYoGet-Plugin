/* 各列等高：测量最高列，把「快速通关 / 王棋历史记录」候选卡逐张补进较矮的列，
   直到贴到最高列的底线；最后一张卡用 margin 微调到底线。
   这样列高一致但卡片本身不拉伸，避免图片变形/发糊。 */
(function () {
  let done = false

  function pageScale() {
    const style = getComputedStyle(document.body)
    const tf = style.transform
    if (tf && tf !== 'none') {
      const m = tf.match(/matrix\(([^)]+)\)/)
      if (m) {
        const a = parseFloat(m[1].split(',')[0])
        if (a > 0) return a
      }
    }
    const zoom = parseFloat(style.zoom)
    if (zoom && zoom > 0) return zoom
    return 1
  }

  function waitImages() {
    const imgs = [...document.images]
    return Promise.all(imgs.map(img => img.complete
      ? null
      : new Promise(resolve => {
        img.addEventListener('load', resolve, { once: true })
        img.addEventListener('error', resolve, { once: true })
      })))
  }

  const nextFrame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))

  async function fill() {
    if (done) return
    done = true
    try { await document.fonts.ready } catch (_) { }
    try { await waitImages() } catch (_) { }
    await nextFrame()

    const columns = [...document.querySelectorAll('.container .column')]
    if (!columns.length) return
    const reports = columns.map(c => c.querySelector('.report'))
    const scale = pageScale() || 1
    const bottom = el => el.getBoundingClientRect().bottom
    const valid = reports.filter(Boolean)
    if (!valid.length) return
    const target = Math.max(...valid.map(bottom))
    if (!Number.isFinite(target)) return

    columns.forEach((column, index) => {
      const report = reports[index]
      if (!report) return
      /* 只用本期自带的「快速通关」卡补位，不再请求上期。 */
      const candidates = [...report.querySelectorAll('.fast-clear')]

      candidates.forEach(card => {
        report.appendChild(card)
        card.classList.add('is-filler-visible')
        if (bottom(report) > target + 1) card.classList.remove('is-filler-visible')
      })

      const visible = candidates.filter(c => c.classList.contains('is-filler-visible'))
      const last = visible[visible.length - 1]
      if (last) {
        const remaining = Math.max(0, target - bottom(report))
        last.style.marginTop = `${(remaining / scale).toFixed(2)}px`
      }
    })

    /* 候选卡用完仍不够高时（比如上期没数据），把列面板垫到同一底线：
       拉伸的是背景面板，不是卡片里的图片，所以不会变形/发糊。 */
    const colBottom = el => el.getBoundingClientRect().bottom
    const targetBottom = Math.max(...columns.map(colBottom))
    columns.forEach(column => {
      const gap = targetBottom - colBottom(column)
      if (gap > 1) {
        const h = (column.getBoundingClientRect().height + gap) / scale
        /* 页面里 `.column { min-height: 0 !important }` 的旧规则会压住普通内联样式，
           这里用内联 !important 才能生效。 */
        column.style.setProperty('min-height', `${h.toFixed(2)}px`, 'important')
      }
    })
  }

  if (document.readyState === 'complete') fill()
  else window.addEventListener('load', fill)
})()
