(function () {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token") || "";
  const wsPort = params.get("wsPort") || window.location.port || "8787";
  const wsHost = window.location.hostname || "127.0.0.1";
  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  // The token is NOT part of the connection URL: it travels in the
  // Sec-WebSocket-Protocol header instead (AGENTS.md section 18, SECURITY.md
  // item 3). Query strings leak into access logs, referrers and process
  // lists; the subprotocol header does not. The token still arrives on the
  // page URL (OBS Browser Source and a plain browser tab have no other
  // credential channel) — it just isn't repeated on the socket.
  const wsUrl = `${wsProtocol}//${wsHost}:${wsPort}`;

  const clockEl = document.getElementById("current-clock");
  const timerBadge = document.getElementById("timer-badge");
  const timerDisplay = document.getElementById("timer-display");
  const alertBanner = document.getElementById("stage-alert-banner");
  const alertText = document.getElementById("alert-text");
  const verseCard = document.getElementById("stage-verse-card");
  const referenceEl = document.getElementById("stage-reference");
  const verseTextEl = document.getElementById("stage-verse-text");
  const wsDot = document.getElementById("ws-indicator");
  const wsText = document.getElementById("ws-status-text");
  const audioText = document.getElementById("audio-status-text");

  let alertTimeout = null;

  function updateClock() {
    const now = new Date();
    if (clockEl) {
      clockEl.textContent = now.toTimeString().split(" ")[0];
    }
  }
  setInterval(updateClock, 1000);
  updateClock();

  function formatTime(totalSeconds) {
    const sign = totalSeconds < 0 ? "-" : "";
    const absSec = Math.abs(totalSeconds);
    const mins = Math.floor(absSec / 60);
    const secs = absSec % 60;
    return `${sign}${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  function connectWs() {
    // Same guard overlay.js applies: with no token the server terminates the
    // socket as unauthenticated, so opening one would only produce an endless
    // reconnect loop behind a misleading DISCONNECTED indicator.
    if (!token) {
      if (wsDot) wsDot.className = "dot disconnected";
      if (wsText) wsText.textContent = "NO TOKEN — COPY THE STAGE LINK FROM THE APP";
      return;
    }
    const ws = new WebSocket(wsUrl, [token]);
    ws.onopen = () => {
      if (wsDot) wsDot.className = "dot connected";
      if (wsText) wsText.textContent = "CONNECTED";
    };
    ws.onclose = () => {
      if (wsDot) wsDot.className = "dot disconnected";
      if (wsText) wsText.textContent = "DISCONNECTED";
      setTimeout(connectWs, 2000);
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
      } catch (err) {
        console.warn("Malformed WS message:", err);
      }
    };
  }

  function handleMessage(msg) {
    if (!msg || !msg.type) return;

    if (msg.type === "verse:show" && msg.payload) {
      if (verseCard) verseCard.className = "stage-verse-card";
      if (referenceEl) referenceEl.textContent = msg.payload.reference || "Scripture";
      if (verseTextEl) verseTextEl.textContent = msg.payload.text || "";
    } else if (msg.type === "verse:clear") {
      if (verseCard) verseCard.className = "stage-verse-card empty";
      if (referenceEl) referenceEl.textContent = "No verse displayed";
      if (verseTextEl)
        verseTextEl.textContent = "Awaiting scripture detection from pulpit speech...";
    } else if (msg.type === "timer:state" && msg.payload) {
      const p = msg.payload;
      if (timerDisplay) timerDisplay.textContent = formatTime(p.remainingSeconds);
      if (timerBadge) {
        let state = "stopped";
        if (p.isOvertime) state = "overtime";
        else if (p.remainingSeconds <= 300 && p.running) state = "warning";
        else if (p.running) state = "running";
        timerBadge.className = `timer-badge ${state}`;
      }
    } else if (msg.type === "stage:alert" && msg.payload) {
      if (alertText) alertText.textContent = msg.payload.message || "";
      if (alertBanner) alertBanner.className = "stage-alert-banner";
      if (alertTimeout) clearTimeout(alertTimeout);
      const dur = (msg.payload.durationSeconds || 15) * 1000;
      alertTimeout = setTimeout(() => {
        if (alertBanner) alertBanner.className = "stage-alert-banner hidden";
      }, dur);
    } else if (msg.type === "stage:clear-alert") {
      if (alertTimeout) clearTimeout(alertTimeout);
      if (alertBanner) alertBanner.className = "stage-alert-banner hidden";
    } else if (msg.type === "status:update" && msg.payload) {
      if (msg.payload.asrHealth && audioText) {
        audioText.textContent = msg.payload.asrHealth.toUpperCase();
      }
    }
  }

  connectWs();
})();
