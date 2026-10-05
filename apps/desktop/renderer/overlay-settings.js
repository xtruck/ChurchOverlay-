// Plain browser JS, no build step (same convention as dashboard.js).
// ARCHITECTURE.md section 110.7: the Overlay view. Every edit goes
// renderer -> IPC set-overlay-style -> main validates -> AppCore broadcasts
// overlay:style -> the preview iframe (the REAL overlay page) repaints, so
// what the operator sees is exactly what OBS and NDI render. The renderer
// never touches the filesystem, secrets or the WebSocket for this.
;(function () {
  const api = window.churchOverlay
  const t = (key, params) => window.i18n.t(key, params)
  const $ = (id) => document.getElementById(id)
  const view = $("view-overlay")
  if (!view || !api || !api.getOverlayStyle) return

  const els = {
    frame: $("ov-preview-frame"),
    stage: $("ov-stage"),
    handles: $("ov-handles"),
    palettes: $("ov-palettes"),
    cards: $("ov-cards"),
    customBox: $("ov-custom"),
    customGrid: $("ov-custom-grid"),
    customOpacity: $("ov-custom-opacity"),
    contrast: $("ov-contrast"),
    nameText: $("ov-name-text"),
    nameVisible: $("ov-name-visible"),
    nameFont: $("ov-name-font"),
    nameSize: $("ov-name-size"),
    nameWeight: $("ov-name-weight"),
    namePlate: $("ov-name-plate"),
    nameUseColor: $("ov-name-usecolor"),
    nameColor: $("ov-name-color"),
    logoVisible: $("ov-logo-visible"),
    logoPick: $("ov-logo-pick"),
    logoClear: $("ov-logo-clear"),
    logoMsg: $("ov-logo-msg"),
    target: $("ov-target"),
    anchors: $("ov-anchors"),
    reset: $("ov-reset"),
    sliders: { x: $("ov-x"), y: $("ov-y"), scale: $("ov-scale"), rotation: $("ov-rotation"), opacity: $("ov-opacity") },
  }

  const COLOR_ROLES = ["backdrop", "card", "text", "textSecondary", "accent", "border"]
  let meta = null
  let style = null
  let selected = "name" // which brand item the placement controls edit
  let rects = { name: null, logo: null }
  let started = false

  // ---------- helpers ----------
  const lang = () => (window.i18n.getLanguage ? window.i18n.getLanguage() : "en")
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

  function luminance(hex) {
    const lin = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    })
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
  }
  function contrast(a, b) {
    const la = luminance(a), lb = luminance(b)
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
  }
  function composite(fg, alpha, bg) {
    const mix = (i) => Math.round(parseInt(fg.slice(i, i + 2), 16) * alpha + parseInt(bg.slice(i, i + 2), 16) * (1 - alpha)).toString(16).padStart(2, "0")
    return "#" + mix(1) + mix(3) + mix(5)
  }
  // Worst case over black and white video, same rule as the palette gate.
  function worstContrast(colors, fg) {
    return Math.min(contrast(fg, composite(colors.card, colors.cardOpacity, "#000000")), contrast(fg, composite(colors.card, colors.cardOpacity, "#ffffff")))
  }

  /** Settings the server stores: the received style minus revision/colours (colours only matter for custom). */
  function settingsFrom(s) {
    const out = { paletteId: s.paletteId, card: s.card, brand: JSON.parse(JSON.stringify(s.brand)) }
    if (s.paletteId === "custom") out.customColors = { ...s.colors }
    return out
  }

  // ---------- applying edits (latest wins, at most one IPC in flight) ----------
  let inFlight = false
  let queued = null
  function send(settings) {
    if (inFlight) { queued = settings; return }
    inFlight = true
    api.setOverlayStyle(settings)
      .then((next) => { style = next; render(false) })
      .catch((err) => showMessage(String((err && err.message) || err)))
      .finally(() => {
        inFlight = false
        if (queued) { const q = queued; queued = null; send(q) }
      })
  }
  function edit(mutator) {
    if (!style) return
    const s = settingsFrom(style)
    mutator(s)
    // Optimistic local copy so sliders stay smooth; the server's normalized answer replaces it.
    style = { ...style, ...s, colors: s.customColors || style.colors }
    send(s)
  }
  function showMessage(text) { els.logoMsg.textContent = text || "" }

  // ---------- rendering ----------
  function swatchStyle(c) {
    return "background:linear-gradient(135deg," + c.backdrop + " 0 55%," + c.accent + " 55% 70%," + c.text + " 70%)"
  }
  function buildPalettes() {
    els.palettes.textContent = ""
    for (const group of meta.groups) {
      const items = meta.palettes.filter((p) => p.group === group)
      if (!items.length) continue
      const h = document.createElement("div")
      h.className = "ov-group-title"
      h.textContent = t("overlay.group." + group)
      els.palettes.appendChild(h)
      const row = document.createElement("div")
      row.className = "ov-swatch-row"
      for (const p of items) {
        const b = document.createElement("button")
        b.type = "button"
        b.className = "ov-swatch"
        b.dataset.palette = p.id
        b.title = p.label[lang()] || p.label.en
        b.setAttribute("aria-label", b.title)
        const chip = document.createElement("span")
        chip.className = "ov-swatch-chip"
        chip.setAttribute("style", swatchStyle(p.colors))
        const name = document.createElement("span")
        name.className = "ov-swatch-name"
        name.textContent = b.title
        b.append(chip, name)
        b.addEventListener("click", () => edit((s) => { s.paletteId = p.id; delete s.customColors }))
        row.appendChild(b)
      }
      els.palettes.appendChild(row)
    }
    const custom = document.createElement("button")
    custom.type = "button"
    custom.className = "ov-swatch ov-swatch-custom"
    custom.dataset.palette = "custom"
    custom.textContent = t("overlay.palette.custom")
    custom.addEventListener("click", () => edit((s) => { s.paletteId = "custom"; s.customColors = { ...style.colors } }))
    els.palettes.appendChild(custom)
  }
  function buildCards() {
    els.cards.textContent = ""
    for (const card of meta.cards) {
      const b = document.createElement("button")
      b.type = "button"
      b.dataset.card = card
      b.textContent = t("overlayTemplate." + card)
      b.addEventListener("click", () => edit((s) => { s.card = card }))
      els.cards.appendChild(b)
    }
  }
  function buildCustom() {
    els.customGrid.textContent = ""
    for (const role of COLOR_ROLES) {
      const label = document.createElement("label")
      label.className = "ov-color"
      const span = document.createElement("span")
      span.textContent = t("overlay.color." + role)
      const input = document.createElement("input")
      input.type = "color"
      input.dataset.role = role
      input.addEventListener("input", () => edit((s) => { s.customColors[role] = input.value }))
      label.append(span, input)
      els.customGrid.appendChild(label)
    }
  }
  function buildFonts() {
    els.nameFont.textContent = ""
    for (const f of meta.fonts) {
      const o = document.createElement("option")
      o.value = f
      o.textContent = t("overlay.font." + f)
      els.nameFont.appendChild(o)
    }
  }

  function setValue(input, value) {
    if (document.activeElement !== input && String(input.value) !== String(value)) input.value = value
  }

  function render(rebuildLists) {
    if (!style || !meta) return
    if (rebuildLists) { buildPalettes(); buildCards(); buildCustom(); buildFonts() }
    els.palettes.querySelectorAll("[data-palette]").forEach((b) => b.classList.toggle("active", b.dataset.palette === style.paletteId))
    els.cards.querySelectorAll("[data-card]").forEach((b) => b.classList.toggle("active", b.dataset.card === style.card))
    const isCustom = style.paletteId === "custom"
    els.customBox.hidden = !isCustom
    if (isCustom) {
      els.customGrid.querySelectorAll("input[data-role]").forEach((i) => setValue(i, style.colors[i.dataset.role]))
      setValue(els.customOpacity, style.colors.cardOpacity)
    }
    const c = style.colors
    const ratio = c.cardOpacity === 0 ? contrast(c.text, c.backdrop) : worstContrast(c, c.text)
    els.contrast.textContent = t("overlay.contrast", { ratio: ratio.toFixed(1) })
    els.contrast.classList.toggle("warn", ratio < 4.5)

    const n = style.brand.name, l = style.brand.logo
    setValue(els.nameText, n.text)
    els.nameVisible.checked = n.visible
    setValue(els.nameFont, n.font)
    setValue(els.nameSize, n.size)
    setValue(els.nameWeight, n.weight)
    els.namePlate.checked = n.plate
    els.nameUseColor.checked = !!n.color
    els.nameColor.disabled = !n.color
    setValue(els.nameColor, n.color || c.text)
    els.logoVisible.checked = l.visible
    els.logoVisible.disabled = l.version === 0
    els.logoClear.disabled = l.version === 0

    els.target.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.target === selected))
    const item = style.brand[selected]
    for (const key of Object.keys(els.sliders)) setValue(els.sliders[key], item[key])
    drawHandles()
  }

  // ---------- drag handles over the preview ----------
  // Handles are updated IN PLACE: replacing them on every server answer would
  // drop keyboard focus and break an in-progress pointer drag.
  const handleEls = {}
  function makeHandle(key) {
    const h = document.createElement("div")
    h.className = "ov-handle"
    h.dataset.item = key
    h.tabIndex = 0
    h.setAttribute("role", "button")
    h.addEventListener("pointerdown", (e) => startDrag(e, key, h))
    h.addEventListener("keydown", (e) => nudge(e, key))
    h.addEventListener("focus", () => { if (selected !== key) { selected = key; render(false) } })
    h.addEventListener("wheel", (e) => {
      e.preventDefault()
      edit((s) => { s.brand[key].scale = clamp(+(s.brand[key].scale * (e.deltaY < 0 ? 1.05 : 1 / 1.05)).toFixed(3), meta.limits.scale.min, meta.limits.scale.max) })
    }, { passive: false })
    return h
  }
  function drawHandles() {
    for (const key of ["name", "logo"]) {
      const item = style && style.brand[key]
      const r = rects[key]
      const show = !!(item && item.visible && r)
      let h = handleEls[key]
      if (!show) {
        if (h && !(drag && drag.key === key)) { h.remove(); delete handleEls[key] }
        continue
      }
      if (!h) { h = handleEls[key] = makeHandle(key); els.handles.appendChild(h) }
      h.classList.toggle("selected", key === selected)
      h.setAttribute("aria-label", t("overlay.handle." + key))
      h.style.left = r.left + "%"
      h.style.top = r.top + "%"
      h.style.width = r.width + "%"
      h.style.height = r.height + "%"
    }
  }
  let drag = null
  function startDrag(e, key, handle) {
    e.preventDefault()
    selected = key
    const box = els.stage.getBoundingClientRect()
    drag = { key, startX: e.clientX, startY: e.clientY, x0: style.brand[key].x, y0: style.brand[key].y, box, handle }
    handle.setPointerCapture(e.pointerId)
    handle.addEventListener("pointermove", onMove)
    handle.addEventListener("pointerup", endDrag)
    handle.addEventListener("pointercancel", endDrag)
    render(false)
  }
  function snap(v) { return Math.abs(v - 50) < 1.2 ? 50 : v } // centre guide
  function onMove(e) {
    if (!drag) return
    const dx = ((e.clientX - drag.startX) / drag.box.width) * 100
    const dy = ((e.clientY - drag.startY) / drag.box.height) * 100
    const x = clamp(+snap(drag.x0 + dx).toFixed(2), 0, 100)
    const y = clamp(+snap(drag.y0 + dy).toFixed(2), 0, 100)
    edit((s) => { s.brand[drag.key].x = x; s.brand[drag.key].y = y })
  }
  function endDrag(e) {
    if (!drag) return
    drag.handle.removeEventListener("pointermove", onMove)
    drag.handle.removeEventListener("pointerup", endDrag)
    drag.handle.removeEventListener("pointercancel", endDrag)
    drag = null
  }
  function nudge(e, key) {
    const step = e.shiftKey ? 5 : 0.5
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key]
    if (!d) return
    e.preventDefault()
    selected = key
    edit((s) => { s.brand[key].x = clamp(+(s.brand[key].x + d[0]).toFixed(2), 0, 100); s.brand[key].y = clamp(+(s.brand[key].y + d[1]).toFixed(2), 0, 100) })
  }

  // The overlay (in design-preview mode) reports where its items really are.
  window.addEventListener("message", (e) => {
    if (e.source !== els.frame.contentWindow) return
    const d = e.data
    if (!d || d.type !== "churchoverlay:brand-rects") return
    const ok = (r) => r && [r.left, r.top, r.width, r.height].every(Number.isFinite) ? r : null
    rects = { name: ok(d.name), logo: ok(d.logo) }
    if (drag) return // handle follows the pointer's own element until released
    drawHandles()
  })

  // ---------- wiring ----------
  function wire() {
    els.customOpacity.addEventListener("input", () => edit((s) => { s.customColors.cardOpacity = Number(els.customOpacity.value) }))
    els.nameText.addEventListener("input", () => edit((s) => { s.brand.name.text = els.nameText.value; if (els.nameText.value.trim()) s.brand.name.visible = true }))
    els.nameVisible.addEventListener("change", () => edit((s) => { s.brand.name.visible = els.nameVisible.checked }))
    els.nameFont.addEventListener("change", () => edit((s) => { s.brand.name.font = els.nameFont.value }))
    els.nameSize.addEventListener("input", () => edit((s) => { s.brand.name.size = Number(els.nameSize.value) }))
    els.nameWeight.addEventListener("change", () => edit((s) => { s.brand.name.weight = Number(els.nameWeight.value) }))
    els.namePlate.addEventListener("change", () => edit((s) => { s.brand.name.plate = els.namePlate.checked }))
    els.nameUseColor.addEventListener("change", () => edit((s) => { if (els.nameUseColor.checked) s.brand.name.color = els.nameColor.value; else delete s.brand.name.color }))
    els.nameColor.addEventListener("input", () => edit((s) => { if (els.nameUseColor.checked) s.brand.name.color = els.nameColor.value }))
    els.logoVisible.addEventListener("change", () => edit((s) => { s.brand.logo.visible = els.logoVisible.checked }))
    els.logoPick.addEventListener("click", () => {
      showMessage("")
      api.pickBrandLogo()
        .then((r) => {
          if (r.canceled) return
          if (r.error) return showMessage(t("overlay.logo.error." + r.error.reason) || r.error.message)
          style = r.style; selected = "logo"; render(false)
        })
        .catch((err) => showMessage(String((err && err.message) || err)))
    })
    els.logoClear.addEventListener("click", () => {
      showMessage("")
      api.clearBrandLogo().then((s) => { style = s; if (selected === "logo") selected = "name"; render(false) }).catch((err) => showMessage(String((err && err.message) || err)))
    })
    els.target.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { selected = b.dataset.target; render(false) }))
    for (const key of Object.keys(els.sliders)) {
      els.sliders[key].addEventListener("input", () => edit((s) => { s.brand[selected][key] = Number(els.sliders[key].value) }))
    }
    els.anchors.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      const [ax, ay] = b.dataset.anchor.split(",").map(Number)
      // Anchors place the item's EDGE (not its centre) near the frame edge, so a wide name never spills off.
      const r = rects[selected]
      const hw = r ? r.width / 2 : 0
      const hh = r ? r.height / 2 : 0
      const x = ax < 50 ? hw + 2 : ax > 50 ? 100 - hw - 2 : 50
      const y = ay < 50 ? hh + 3 : ay > 50 ? 100 - hh - 3 : 50
      edit((s) => { s.brand[selected].x = clamp(+x.toFixed(2), 0, 100); s.brand[selected].y = clamp(+y.toFixed(2), 0, 100) })
    }))
    els.reset.addEventListener("click", () => {
      api.getOverlayStyleMeta && edit((s) => {
        const d = selected === "name" ? { x: 90, y: 5, scale: 1, rotation: 0, opacity: 0.85 } : { x: 6, y: 9, scale: 1, rotation: 0, opacity: 1 }
        Object.assign(s.brand[selected], d)
      })
    })
  }

  async function start() {
    if (started) return
    started = true
    try {
      meta = await api.getOverlayStyleMeta()
      style = await api.getOverlayStyle()
      const status = await api.getStartupStatus()
      if (status && status.overlayUrl) {
        const url = new URL(status.overlayUrl)
        url.searchParams.set("designPreview", "1")
        els.frame.src = url.toString()
      }
      wire()
      render(true)
    } catch (err) {
      started = false
      showMessage(String((err && err.message) || err))
    }
  }

  // Lazy: nothing is loaded until the operator opens the view (which also
  // means the second preview WebSocket exists only while it is in use).
  window.addEventListener("churchoverlay:viewchange", (event) => {
    if (event.detail.view === "overlay") start()
  })
  if (view.classList.contains("active")) start()
  window.addEventListener("churchoverlay:languagechange", () => meta && render(true))
})()
