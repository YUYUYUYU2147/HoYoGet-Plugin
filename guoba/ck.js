(function () {
  const g = window.__GUOBA__ || {}
  const cards = document.getElementById('ck-cards')
  const meta = document.getElementById('ck-meta')
  const el = id => document.getElementById(id)
  const editor = el('ck-editor')
  let editing = null

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]))
  }
  function headers(json) {
    const h = { [g.tokenKey || 'guoba-access-token']: g.token || '' }
    if (json) h['Content-Type'] = 'application/json'
    return h
  }
  async function api(path, opts) {
    const res = await fetch(g.apiBase + path, opts)
    return await res.json()
  }
  const qqAvatar = qq => 'https://q1.qlogo.cn/g?b=qq&s=140&nk=' + encodeURIComponent(qq) + '.jpg'

  async function load() {
    cards.innerHTML = '<div class="ck-empty">加载中…</div>'
    const p = new URLSearchParams()
    if (el('ck-qq').value.trim()) p.set('qq', el('ck-qq').value.trim())
    if (el('ck-game').value) p.set('game', el('ck-game').value)
    try {
      const json = await api('/ck/list?' + p.toString(), { headers: headers() })
      const list = json?.result || []
      meta.textContent = '共 ' + list.length + ' 个账号'
      if (!list.length) {
        cards.innerHTML = '<div class="ck-empty">没有匹配的账号</div>'
        return
      }
      cards.innerHTML = list.map((a, i) => {
        const ck = a.hasCk ? '<span class="ok">CK 有</span>' : '<span class="no">CK 无</span>'
        const sk = a.hasSk ? '<span class="ok">SK 有</span>' : '<span class="no">SK 无</span>'
        return '<div class="ck-card">'
          + '<img class="ck-avatar" data-i="' + i + '" src="' + qqAvatar(a.qq) + '" title="点击修改" '
          + 'onerror="this.src=\'data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2252%22 height=%2252%22><rect width=%2252%22 height=%2252%22 fill=%22%23eef2f7%22/></svg>\'" />'
          + '<div class="ck-info">'
          + '<div class="ck-name">' + esc(a.gameName) + ' · ' + esc(a.uid) + '</div>'
          + '<div class="ck-sub">' + esc(a.region || '未知区服') + ' · 通行证 ' + esc(a.stuidMask) + '</div>'
          + '<div class="ck-status">' + ck + ' · ' + sk + '</div>'
          + '</div>'
          + '<div class="ck-ops">'
          + '<button class="ck-btn" data-act="edit" data-i="' + i + '">修改</button>'
          + '<button class="ck-btn danger" data-act="del" data-i="' + i + '">删除</button>'
          + '</div>'
          + '</div>'
      }).join('')
      cards.querySelectorAll('[data-act]').forEach(btn => {
        const a = list[Number(btn.dataset.i)]
        btn.addEventListener('click', () => {
          if (btn.dataset.act === 'edit') openEditor(a)
          else remove(a)
        })
      })
      cards.querySelectorAll('.ck-avatar').forEach(av => {
        const a = list[Number(av.dataset.i)]
        av.addEventListener('click', () => openEditor(a))
      })
    } catch (err) {
      cards.innerHTML = '<div class="ck-empty">加载失败：' + esc(err && err.message || err) + '</div>'
    }
  }

  async function openEditor(a) {
    el('ck-msg').textContent = ''
    const json = await api('/ck/get?qq=' + encodeURIComponent(a.qq) + '&uid=' + encodeURIComponent(a.uid), { headers: headers() })
    if (!json?.ok) { el('ck-msg').textContent = json?.message || '读取失败'; return }
    const d = json.result
    editing = { qq: d.qq, uid: d.uid }
    el('ck-editor-title').textContent = '修改账号 · ' + d.gameName + ' · ' + d.uid
    el('ck-f-qq').value = d.qq
    el('ck-f-uid').value = d.uid
    el('ck-f-stuid').value = d.stuid || ''
    el('ck-f-mid').value = d.mid || ''
    el('ck-f-ck').value = d.ck_stoken || ''
    el('ck-f-sk').value = d.stoken || ''
    editor.classList.add('on')
    editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  async function save() {
    if (!editing) return
    const payload = {
      qq: editing.qq, uid: editing.uid,
      stuid: el('ck-f-stuid').value.trim(),
      mid: el('ck-f-mid').value.trim(),
      ck: el('ck-f-ck').value.trim(),
      stoken: el('ck-f-sk').value.trim(),
    }
    el('ck-msg').textContent = '保存中…'
    const json = await api('/ck/save', { method: 'POST', headers: headers(true), body: JSON.stringify(payload) })
    el('ck-msg').textContent = json?.message || (json?.ok ? '已保存' : '保存失败')
    if (json?.ok) { editor.classList.remove('on'); editing = null; load() }
  }

  async function remove(a) {
    if (!confirm('确定删除 ' + a.gameName + ' UID ' + a.uid + ' 的绑定？删除后需要重新扫码或手动填 CK。')) return
    const json = await api('/ck/delete', { method: 'POST', headers: headers(true), body: JSON.stringify({ qq: a.qq, uid: a.uid }) })
    if (!json?.ok) alert(json?.message || '删除失败')
    load()
  }

  el('ck-refresh').addEventListener('click', load)
  el('ck-qq').addEventListener('keydown', e => { if (e.key === 'Enter') load() })
  el('ck-game').addEventListener('change', load)
  el('ck-save').addEventListener('click', save)
  el('ck-cancel').addEventListener('click', () => { editor.classList.remove('on'); editing = null })
  load()
})();
