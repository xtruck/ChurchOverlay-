// Plain browser JS, no build step (same convention as dashboard.js).
// Ready check (architecture-notes/ready-check.md): one button, one IPC call.
// The main process gathers the state and runs the checks; this file only
// renders the returned codes in the operator's language. Each line carries an
// icon AND a status word, so the state is never conveyed by colour alone.
;(function () {
  const api = window.churchOverlay
  const t = (key, params) => window.i18n.t(key, params)
  const $ = (id) => document.getElementById(id)
  const button = $("ready-check-btn")
  const summary = $("ready-check-summary")
  const list = $("ready-check-list")
  if (!button || !summary || !list || !api || !api.runReadyCheck) return

  const ICONS = { ok: "✓", warn: "!", fail: "✕", unknown: "?" }
  const STATUSES = ["ok", "warn", "fail", "unknown"]
  let lastReport = null
  let lastError = null

  /** Only known status codes reach the DOM as attributes; anything else reads as "unknown". */
  const statusOf = (value) => (STATUSES.includes(value) ? value : "unknown")

  /** Translated params: an ASR provider or translation code is shown by its readable name. */
  function paramsFor(line) {
    const params = Object.assign({}, line.params || {})
    if (typeof params.provider === "string") params.provider = t("readyCheck.provider." + params.provider)
    return params
  }

  function renderLine(line) {
    const status = statusOf(line.status)
    const item = document.createElement("li")
    item.className = "ready-check-line"
    item.dataset.status = status
    const icon = document.createElement("span")
    icon.className = "ready-check-icon"
    icon.setAttribute("aria-hidden", "true")
    icon.textContent = ICONS[status]
    const body = document.createElement("div")
    body.className = "ready-check-body"
    const head = document.createElement("div")
    head.className = "ready-check-head"
    const name = document.createElement("span")
    name.className = "ready-check-name"
    name.textContent = t("readyCheck.check." + line.id)
    const word = document.createElement("span")
    word.className = "ready-check-status"
    word.textContent = t("readyCheck.status." + status)
    head.append(name, word)
    const detail = document.createElement("div")
    detail.className = "ready-check-detail"
    detail.textContent = t("readyCheck.detail." + line.detail, paramsFor(line))
    body.append(head, detail)
    if (line.fixHint) {
      const fix = document.createElement("div")
      fix.className = "ready-check-fix"
      fix.textContent = t("readyCheck.fix." + line.fixHint)
      body.append(fix)
    }
    item.append(icon, body)
    return item
  }

  function render() {
    list.replaceChildren()
    if (lastError) {
      summary.dataset.state = "fail"
      summary.textContent = t("readyCheck.runFailed", { error: lastError })
      return
    }
    if (!lastReport) {
      summary.dataset.state = "idle"
      summary.textContent = t("readyCheck.idle")
      return
    }
    const overall = statusOf(lastReport.overall)
    summary.dataset.state = overall
    const time = new Date(lastReport.startedAt).toLocaleTimeString()
    summary.textContent = ICONS[overall] + " " + t("readyCheck.overall." + overall, { time })
    for (const line of lastReport.lines || []) list.append(renderLine(line))
  }

  button.addEventListener("click", () => {
    button.disabled = true
    button.textContent = t("readyCheck.running")
    summary.dataset.state = "running"
    summary.textContent = t("readyCheck.running")
    api
      .runReadyCheck()
      .then((report) => {
        lastReport = report
        lastError = null
      })
      .catch((err) => {
        lastError = String((err && err.message) || err)
      })
      .finally(() => {
        button.disabled = false
        button.textContent = t("readyCheck.run")
        render()
      })
  })

  // Re-render in the new language; applyTranslations() already reset the static labels.
  window.addEventListener("churchoverlay:languagechange", () => {
    if (!button.disabled) render()
  })
})()
