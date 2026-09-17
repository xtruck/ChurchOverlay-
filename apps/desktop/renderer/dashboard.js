// Plain browser JS (no build step) loaded into the Electron dashboard
// BrowserWindow via file loadFile() + a local relative <script src>. Runs
// with nodeIntegration:false/contextIsolation:true — its only path to
// main-process capability is window.churchOverlay, exposed by
// apps/desktop/preload/index.ts.
;(function () {
  const CANONICAL_SAMPLE_RATE = 16000

  // Duplicated from packages/shared/pcm-convert.ts and
  // audio-frame-codec.ts rather than imported: this file has no build
  // step (no bundler is set up in this project, and adding one solely to
  // share ~20 lines of pure math between a Node backend and a browser
  // frontend would be a disproportionate architectural decision for a
  // "small v1" — AGENTS.md sections 40-41). These two functions MUST stay
  // byte-for-byte identical to those files; if either changes, update
  // both. This tradeoff is called out explicitly rather than silently
  // duplicated and forgotten.
  function float32ToInt16(samples) {
    const output = new Int16Array(samples.length)
    for (let i = 0; i < samples.length; i++) {
      const clamped = Math.max(-1, Math.min(1, samples[i]))
      output[i] = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff)
    }
    return output
  }

  function encodeAudioFrame(samples, sequence) {
    const buffer = new ArrayBuffer(4 + samples.length * 2)
    const view = new DataView(buffer)
    view.setUint32(0, sequence, true)
    for (let i = 0; i < samples.length; i++) {
      view.setInt16(4 + i * 2, samples[i], true)
    }
    return buffer
  }

  const statusEl = document.getElementById("status")
  const logEl = document.getElementById("log")
  const transcriptEl = document.getElementById("transcript")
  const referenceInput = document.getElementById("reference")
  const showBtn = document.getElementById("show-btn")
  const clearBtn = document.getElementById("clear-btn")
  const micStartBtn = document.getElementById("mic-start-btn")
  const micStopBtn = document.getElementById("mic-stop-btn")

  let ws = null
  let audioContext = null
  let mediaStream = null

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

  function sendJson(message) {
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
    sendJson({ id: crypto.randomUUID(), type: "verse:override", timestamp: Date.now(), payload: reference })
    log("sent verse:override " + JSON.stringify(reference))
  })

  clearBtn.addEventListener("click", () => {
    sendJson({ id: crypto.randomUUID(), type: "verse:clear", timestamp: Date.now(), payload: null })
    log("sent verse:clear")
  })

  async function startMic() {
    try {
      // ARCHITECTURE.md section 8.3's recommended baseline.
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch (err) {
      log("microphone permission denied or unavailable: " + err.message)
      return
    }

    // Requesting the canonical sample rate directly lets the browser
    // handle resampling from the device's native rate (ARCHITECTURE.md
    // section 8.1) — this codebase does not implement its own resampler.
    audioContext = new AudioContext({ sampleRate: CANONICAL_SAMPLE_RATE })
    await audioContext.audioWorklet.addModule("./pcm-worklet-processor.js")

    const source = audioContext.createMediaStreamSource(mediaStream)
    const workletNode = new AudioWorkletNode(audioContext, "pcm-capture-processor")

    workletNode.port.onmessage = (event) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      const { samples, sequence } = event.data
      const pcm16 = float32ToInt16(samples)
      ws.send(encodeAudioFrame(pcm16, sequence))
    }

    source.connect(workletNode)

    sendJson({ id: crypto.randomUUID(), type: "mic:start", timestamp: Date.now(), payload: null })
    micStartBtn.disabled = true
    micStopBtn.disabled = false
    log("microphone started")
  }

  async function stopMic() {
    sendJson({ id: crypto.randomUUID(), type: "mic:stop", timestamp: Date.now(), payload: null })

    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop())
      mediaStream = null
    }
    if (audioContext) {
      await audioContext.close()
      audioContext = null
    }
    micStartBtn.disabled = false
    micStopBtn.disabled = true
    log("microphone stopped")
  }

  micStartBtn.addEventListener("click", () => startMic())
  micStopBtn.addEventListener("click", () => stopMic())

  function connect(port, token) {
    setStatus("connecting…", false)
    ws = new WebSocket("ws://127.0.0.1:" + port, [token])

    ws.addEventListener("open", () => {
      setStatus("connected (operator)", true)
      log("connected")
    })
    ws.addEventListener("close", () => {
      setStatus("disconnected — retrying…", false)
      log("disconnected, retrying in 2s")
      setTimeout(() => connect(port, token), 2000)
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
      if (message.type === "transcript:partial" || message.type === "verse:show") {
        const text = message.payload && (message.payload.text || "")
        if (text) transcriptEl.textContent = text
      }
    })
  }

  window.churchOverlay
    .getOperatorConnectionInfo()
    .then((info) => connect(info.port, info.token))
    .catch((err) => setStatus("failed to get connection info: " + err.message, false))
})()
