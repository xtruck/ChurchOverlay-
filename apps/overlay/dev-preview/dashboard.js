// Plain browser JS, no build step. A REAL, functional preview of the
// operator side of the WsMessage protocol — not a mockup — but
// deliberately temporary: the final delivery is an Electron renderer
// receiving its operator token through the secure preload/contextBridge
// (see apps/desktop/preload, not yet built), not a URL query parameter.
// This exists only so the app can be seen working in a plain browser
// before that Electron scaffolding exists.
//
// Uses crypto.randomUUID() for message ids rather than the real app's
// generateUlid() (packages/shared/ulid.ts) purely because this static
// page has no build step to import TypeScript from — not a statement
// that random UUIDs are an acceptable replacement in the real app.
(function () {
  const params = new URLSearchParams(window.location.search)
  const token = params.get("token")
  const wsPort = params.get("wsPort") || window.location.port

  const statusEl = document.getElementById("status")
  const logEl = document.getElementById("log")
  const referenceInput = document.getElementById("reference")
  const showBtn = document.getElementById("show-btn")
  const clearBtn = document.getElementById("clear-btn")

  let ws = null

  function log(text) {
    const line = document.createElement("div")
    line.textContent = new Date().toLocaleTimeString() + "  " + text
    logEl.prepend(line)
  }

  function setStatus(text, connected) {
    statusEl.textContent = text
    statusEl.className = connected ? "status-connected" : "status-disconnected"
  }

  function parseReference(text) {
    const match = /^\s*((?:[123]\s+)?[A-Za-z]+)\s+(\d{1,3}):(\d{1,3})\s*$/.exec(text)
    if (!match) return null
    return {
      book: match[1].trim().replace(/\s+/g, " ").toLowerCase(),
      chapter: Number.parseInt(match[2], 10),
      verse: Number.parseInt(match[3], 10),
    }
  }

  function send(message) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      log("not connected — can't send")
      return
    }
    ws.send(JSON.stringify(message))
  }

  showBtn.addEventListener("click", () => {
    const reference = parseReference(referenceInput.value)
    if (!reference) {
      log('could not parse "' + referenceInput.value + '" as "Book Chapter:Verse"')
      return
    }
    send({
      id: crypto.randomUUID(),
      type: "verse:override",
      timestamp: Date.now(),
      payload: reference,
    })
    log("sent verse:override " + JSON.stringify(reference))
  })

  clearBtn.addEventListener("click", () => {
    send({ id: crypto.randomUUID(), type: "verse:clear", timestamp: Date.now(), payload: null })
    log("sent verse:clear")
  })

  function connect() {
    if (!token) {
      setStatus("no operator token in URL (add ?token=...)", false)
      return
    }
    setStatus("connecting…", false)
    ws = new WebSocket("ws://127.0.0.1:" + wsPort, [token])

    ws.addEventListener("open", () => {
      setStatus("connected (operator)", true)
      log("connected")
    })
    ws.addEventListener("close", () => {
      setStatus("disconnected — retrying…", false)
      log("disconnected, retrying in 2s")
      setTimeout(connect, 2000)
    })
    ws.addEventListener("error", () => log("connection error"))
    ws.addEventListener("message", (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      log("received " + message.type)
    })
  }

  connect()
})()
