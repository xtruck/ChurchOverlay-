(function () {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token") || "";
  const wsPort = params.get("wsPort") || window.location.port || "8787";
  const wsHost = window.location.hostname || "127.0.0.1";
  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${wsProtocol}//${wsHost}:${wsPort}/?token=${encodeURIComponent(token)}`;

  const referenceEl = document.getElementById("live-reference");
  const textEl = document.getElementById("live-text");
  const heroCard = document.getElementById("live-verse-card");
  const btnSave = document.getElementById("btn-save-verse");
  const btnCopy = document.getElementById("btn-copy-verse");
  const btnExport = document.getElementById("btn-export-notes");
  const savedList = document.getElementById("saved-verses-list");
  const savedCount = document.getElementById("saved-count");
  const toastEl = document.getElementById("live-toast");
  const translationSelect = document.getElementById("translation-select");

  let currentVerse = null;
  const savedVerses = JSON.parse(localStorage.getItem("churchoverlay_saved_verses") || "[]");

  function showToast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.className = "toast";
    setTimeout(() => {
      toastEl.className = "toast hidden";
    }, 2500);
  }

  function renderSavedList() {
    if (!savedList || !savedCount) return;
    savedCount.textContent = String(savedVerses.length);

    if (savedVerses.length === 0) {
      savedList.innerHTML =
        '<p class="empty-hint">Tap "Save to My Notes" on any verse above to bookmark it for later study.</p>';
      return;
    }

    savedList.innerHTML = savedVerses
      .map(
        (v, i) => `
      <div class="saved-card">
        <div class="saved-card-header">
          <span class="saved-card-ref">${v.reference}</span>
          <button class="btn-remove-saved" data-index="${i}">✕</button>
        </div>
        <p class="saved-card-text">${v.text}</p>
      </div>
    `
      )
      .join("");

    savedList.querySelectorAll(".btn-remove-saved").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const idx = Number(e.currentTarget.dataset.index);
        savedVerses.splice(idx, 1);
        localStorage.setItem("churchoverlay_saved_verses", JSON.stringify(savedVerses));
        renderSavedList();
      });
    });
  }

  function saveCurrentVerse() {
    if (!currentVerse || !currentVerse.text) {
      showToast("No active verse to save");
      return;
    }
    const exists = savedVerses.some((v) => v.reference === currentVerse.reference);
    if (!exists) {
      savedVerses.unshift({
        reference: currentVerse.reference,
        text: currentVerse.text,
        timestamp: new Date().toLocaleTimeString(),
      });
      localStorage.setItem("churchoverlay_saved_verses", JSON.stringify(savedVerses));
      renderSavedList();
      showToast(`Saved ${currentVerse.reference}! ⭐`);
    } else {
      showToast("Already in your notes!");
    }
  }

  function copyCurrentVerse() {
    if (!currentVerse || !currentVerse.text) return;
    const textToCopy = `${currentVerse.reference}\n"${currentVerse.text}"`;
    navigator.clipboard
      .writeText(textToCopy)
      .then(() => showToast("Copied to clipboard! 📋"))
      .catch(() => showToast("Copy failed"));
  }

  function exportAllNotes() {
    if (savedVerses.length === 0) {
      showToast("No saved notes to export");
      return;
    }
    const formatted = savedVerses
      .map((v) => `${v.reference}\n"${v.text}"\n`)
      .join("\n---\n\n");
    const blob = new Blob([`SERMON NOTES — ${new Date().toLocaleDateString()}\n\n${formatted}`], {
      type: "text/plain",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Sermon-Notes-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Notes exported! 📥");
  }

  if (btnSave) btnSave.addEventListener("click", saveCurrentVerse);
  if (btnCopy) btnCopy.addEventListener("click", copyCurrentVerse);
  if (btnExport) btnExport.addEventListener("click", exportAllNotes);

  function connectWs() {
    const ws = new WebSocket(wsUrl);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "verse:show" && msg.payload) {
          currentVerse = {
            reference: msg.payload.reference || "Scripture",
            text: msg.payload.text || "",
          };
          if (heroCard) heroCard.className = "verse-hero";
          if (referenceEl) referenceEl.textContent = currentVerse.reference;
          if (textEl) textEl.textContent = currentVerse.text;
        } else if (msg.type === "verse:clear") {
          currentVerse = null;
          if (heroCard) heroCard.className = "verse-hero empty";
          if (referenceEl) referenceEl.textContent = "Welcome to Service";
          if (textEl)
            textEl.textContent =
              "Verses spoken during the sermon will appear here in real-time.";
        }
      } catch (err) {
        console.warn("Malformed WS message:", err);
      }
    };
    ws.onclose = () => setTimeout(connectWs, 2500);
  }

  renderSavedList();
  connectWs();
})();
