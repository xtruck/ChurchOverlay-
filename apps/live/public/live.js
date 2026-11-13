(function () {
  const STRINGS = {
    en: {
      title: "Live",
      connecting: "Connecting…",
      connected: "Connected",
      reconnecting: "Reconnecting…",
      noAccess: "No access link",
      bible: "Bible",
      translationInfo: "Bible translation currently on screen",
      translationUnknown: "Version not announced",
      translationLsgShort: "LSG",
      translationKjvShort: "KJV",
      translationWebShort: "WEB",
      translationDarbyShort: "Darby",
      nowReading: "Now reading",
      welcome: "Welcome to Service",
      waiting: "Verses spoken during the sermon will appear here in real time.",
      save: "Save to My Notes",
      copy: "Copy",
      savedVerses: "My Saved Verses",
      export: "Export All",
      emptyNotes: 'Tap "Save to My Notes" on any verse above to bookmark it for later study.',
      removeVerse: "Remove {reference}",
      noActive: "No active verse to save",
      saved: "Saved {reference}",
      alreadySaved: "Already in your notes",
      copied: "Copied to clipboard",
      copyFailed: "Copy failed",
      noSaved: "No saved notes to export",
      exported: "Notes exported",
      notesExportHeader: "SERMON NOTES",
      scripture: "Scripture",
    },
    fr: {
      title: "En direct",
      connecting: "Connexion…",
      connected: "Connecté",
      reconnecting: "Reconnexion…",
      noAccess: "Lien d’accès manquant",
      bible: "Bible",
      translationInfo: "Traduction biblique actuellement à l’écran",
      translationUnknown: "Version non indiquée",
      translationLsgShort: "LSG",
      translationKjvShort: "KJV",
      translationWebShort: "WEB",
      translationDarbyShort: "Darby",
      nowReading: "Lecture en cours",
      welcome: "Bienvenue au culte",
      waiting: "Les versets prononcés pendant le sermon apparaîtront ici en temps réel.",
      save: "Enregistrer dans mes notes",
      copy: "Copier",
      savedVerses: "Mes versets enregistrés",
      export: "Tout exporter",
      emptyNotes: "Touchez « Enregistrer dans mes notes » sur un verset pour le garder.",
      removeVerse: "Retirer {reference}",
      noActive: "Aucun verset actif à enregistrer",
      saved: "{reference} enregistré",
      alreadySaved: "Déjà dans vos notes",
      copied: "Copié dans le presse-papiers",
      copyFailed: "Échec de la copie",
      noSaved: "Aucune note à exporter",
      exported: "Notes exportées",
      notesExportHeader: "NOTES DE PRÉDICATION",
      scripture: "Écriture",
    },
  };
  const lang = (navigator.language || "en").toLowerCase().startsWith("fr") ? "fr" : "en";
  const t = (key, vars) => {
    let value = STRINGS[lang][key] || STRINGS.en[key] || key;
    for (const [name, replacement] of Object.entries(vars || {})) {
      value = value.split("{" + name + "}").join(String(replacement));
    }
    return value;
  };
  document.documentElement.lang = lang;
  document.querySelectorAll("[data-t]").forEach((el) => { el.textContent = t(el.dataset.t); });
  document.title = "ChurchOverlay — " + t("title");

  const params = new URLSearchParams(window.location.search);
  // The token is in the URL fragment (#token=..., never sent to a server); ?token= is the older form.
  const token = new URLSearchParams(window.location.hash.slice(1)).get("token") || params.get("token") || "";
  const wsPort = params.get("wsPort") || window.location.port || "8787";
  const wsHost = window.location.hostname || "127.0.0.1";
  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  // Same as the stage page: the token goes in the WebSocket subprotocol
  // header, never in the connection URL (AGENTS.md section 18, SECURITY.md
  // item 3). It still arrives on the page URL, which is the only credential
  // channel a browser tab has — it just isn't repeated on the socket.
  const wsUrl = `${wsProtocol}//${wsHost}:${wsPort}`;

  const referenceEl = document.getElementById("live-reference");
  const textEl = document.getElementById("live-text");
  const heroCard = document.getElementById("live-verse-card");
  const btnSave = document.getElementById("btn-save-verse");
  const btnCopy = document.getElementById("btn-copy-verse");
  const btnExport = document.getElementById("btn-export-notes");
  const savedList = document.getElementById("saved-verses-list");
  const savedCount = document.getElementById("saved-count");
  const toastEl = document.getElementById("live-toast");
  const translationLabel = document.getElementById("translation-label");

  let currentVerse = null;
  const liveStatusEl = document.getElementById("live-status");
  const savedVerses = JSON.parse(localStorage.getItem("churchoverlay_saved_verses") || "[]");
  const TRANSLATION_LABEL_KEYS = {
    ls1910: "translationLsgShort",
    lsg: "translationLsgShort",
    segond: "translationLsgShort",
    kjv: "translationKjvShort",
    web: "translationWebShort",
    darby: "translationDarbyShort",
  };

  function updateTranslationLabel(translation) {
    if (!translationLabel) return;
    const key = TRANSLATION_LABEL_KEYS[String(translation || "").toLowerCase()] || "translationUnknown";
    translationLabel.textContent = t(key);
  }

  function updateVerseActions() {
    const enabled = Boolean(currentVerse && currentVerse.text);
    if (btnSave) btnSave.disabled = !enabled;
    if (btnCopy) btnCopy.disabled = !enabled;
  }

  // Connection state for the header dot + text (data-conn drives the colour
  // in live.css; the text says the same thing in words).
  function setConnection(state, text) {
    document.body.dataset.conn = state;
    if (liveStatusEl) liveStatusEl.textContent = text;
  }

  let toastTimer = null;
  function showToast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.className = "toast";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.className = "toast hidden";
    }, 2500);
  }

  // verse:show carries reference as { book, chapter, verse } (packages/
  // contracts/verse.ts); it used to be stored and shown as-is, which printed
  // "[object Object]". Format it; plain strings (and notes saved by older
  // versions of this page) pass through.
  function formatReference(ref) {
    if (!ref) return t("scripture");
    if (typeof ref === "string") return ref;
    if (typeof ref.book !== "string") return t("scripture");
    const book = ref.book.replace(/\b\w/g, (c) => c.toUpperCase());
    return book + " " + ref.chapter + ":" + ref.verse;
  }

  const SVG_NS = "http://www.w3.org/2000/svg";
  function closeIcon() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M18 6L6 18M6 6l12 12");
    svg.appendChild(path);
    return svg;
  }

  // Saved notes hold server-provided verse text (and, for older entries,
  // whatever was in localStorage): build every node with createElement and
  // textContent only — never innerHTML with data — so nothing in a note can
  // become markup or script.
  function buildSavedCard(v, i) {
    const reference = formatReference(v && v.reference);
    const card = document.createElement("li");
    card.className = "saved-card";

    const header = document.createElement("div");
    header.className = "saved-card-header";

    const meta = document.createElement("div");
    const ref = document.createElement("span");
    ref.className = "saved-card-ref";
    ref.textContent = reference;
    meta.appendChild(ref);
    if (v && typeof v.timestamp === "string" && v.timestamp) {
      const time = document.createElement("span");
      time.className = "saved-card-time";
      time.textContent = v.timestamp;
      meta.appendChild(time);
    }
    header.appendChild(meta);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn-remove-saved";
    remove.dataset.index = String(i);
    remove.setAttribute("aria-label", t("removeVerse", { reference }));
    remove.appendChild(closeIcon());
    remove.addEventListener("click", (e) => {
      const idx = Number(e.currentTarget.dataset.index);
      savedVerses.splice(idx, 1);
      localStorage.setItem("churchoverlay_saved_verses", JSON.stringify(savedVerses));
      renderSavedList();
    });
    header.appendChild(remove);
    card.appendChild(header);

    const text = document.createElement("p");
    text.className = "saved-card-text";
    text.textContent = v && typeof v.text === "string" ? v.text : "";
    card.appendChild(text);
    return card;
  }

  function renderSavedList() {
    if (!savedList || !savedCount) return;
    savedCount.textContent = String(savedVerses.length);
    savedList.replaceChildren();

    if (savedVerses.length === 0) {
      savedList.classList.add("empty");
      const hint = document.createElement("p");
      hint.className = "empty-hint";
      hint.textContent = t("emptyNotes");
      savedList.appendChild(hint);
      return;
    }

    savedList.classList.remove("empty");
    const list = document.createElement("ul");
    list.className = "saved-list";
    savedVerses.forEach((v, i) => list.appendChild(buildSavedCard(v, i)));
    savedList.appendChild(list);
  }

  function saveCurrentVerse() {
    if (!currentVerse || !currentVerse.text) {
      showToast(t("noActive"));
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
      showToast(t("saved", { reference: currentVerse.reference }));
    } else {
      showToast(t("alreadySaved"));
    }
  }

  function copyCurrentVerse() {
    if (!currentVerse || !currentVerse.text) return;
    const textToCopy = `${currentVerse.reference}\n"${currentVerse.text}"`;
    navigator.clipboard
      .writeText(textToCopy)
      .then(() => showToast(t("copied")))
      .catch(() => showToast(t("copyFailed")));
  }

  function exportAllNotes() {
    if (savedVerses.length === 0) {
      showToast(t("noSaved"));
      return;
    }
    const formatted = savedVerses
      .map((v) => `${formatReference(v.reference)}\n"${v.text}"\n`)
      .join("\n---\n\n");
    const blob = new Blob([`${t("notesExportHeader")} — ${new Date().toLocaleDateString()}\n\n${formatted}`], {
      type: "text/plain",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Sermon-Notes-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(t("exported"));
  }

  if (btnSave) btnSave.addEventListener("click", saveCurrentVerse);
  if (btnCopy) btnCopy.addEventListener("click", copyCurrentVerse);
  if (btnExport) btnExport.addEventListener("click", exportAllNotes);

  function connectWs() {
    // The server terminates a connection that presents no subprotocol, so
    // reconnecting without a token would just spin forever behind a page that
    // looks live. Say what's actually missing instead.
    if (!token) {
      console.warn("[live] no viewer token in the page URL — copy the companion link from the app");
      setConnection("offline", t("noAccess"));
      return;
    }
    const ws = new WebSocket(wsUrl, [token]);
    ws.onopen = () => setConnection("connected", t("connected"));
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "verse:show" && msg.payload) {
          const verseLanguage = ["ls1910", "lsg", "segond", "darby"].includes(String(msg.payload.translation || "").toLowerCase()) ? "fr" : "en";
          currentVerse = {
            reference: formatReference(msg.payload.reference),
            text: msg.payload.text || "",
            language: verseLanguage,
          };
          updateVerseActions();
          updateTranslationLabel(msg.payload.translation);
          if (heroCard) heroCard.className = "verse-hero";
          if (referenceEl) {
            referenceEl.textContent = currentVerse.reference;
            referenceEl.lang = verseLanguage;
          }
          if (textEl) {
            textEl.textContent = currentVerse.text;
            textEl.lang = verseLanguage;
            // Replay the gentle fade-in for each new verse.
            textEl.style.animation = "none";
            void textEl.offsetWidth;
            textEl.style.animation = "";
          }
        } else if (msg.type === "verse:clear") {
          currentVerse = null;
          updateVerseActions();
          updateTranslationLabel("");
          if (heroCard) heroCard.className = "verse-hero empty";
          if (referenceEl) {
            referenceEl.textContent = t("welcome");
            referenceEl.lang = lang;
          }
          if (textEl) {
            textEl.textContent = t("waiting");
            textEl.lang = lang;
          }
        }
      } catch (err) {
        console.warn("Malformed WS message:", err);
      }
    };
    ws.onclose = () => {
      setConnection("offline", t("reconnecting"));
      setTimeout(connectWs, 2500);
    };
  }

  setConnection("connecting", t("connecting"));
  renderSavedList();
  connectWs();
})();
