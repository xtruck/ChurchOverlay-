import { contextBridge, ipcRenderer } from "electron"

/**
 * The one bridge between the fully-sandboxed dashboard renderer and the
 * main process (ARCHITECTURE.md section 7, section 27; AGENTS.md section
 * 27). Exposes a narrow, explicit, purpose-built API — never generic
 * ipcRenderer access — so the renderer cannot reach arbitrary main-
 * process capabilities.
 *
 * getOperatorConnectionInfo() and getStartupStatus() are the one place
 * this hands the renderer something secret-shaped: the operator token
 * needed to open the renderer's own WebSocket connection to the local
 * server, plus the port to connect on. This does not violate "renderer
 * must not access secrets" (ARCHITECTURE.md section 6.2) in the sense
 * that rule actually protects against: the renderer never touches the
 * filesystem, safeStorage, or any application secret beyond this one
 * token, and it receives that token only for its own sanctioned
 * connection to a server on the SAME machine, handed to it explicitly by
 * the main process it already trusts. The threat this token defends
 * against is an unrelated local process or web page connecting to the WS
 * server — not the dashboard renderer itself, which the main process
 * created and is choosing to talk to.
 *
 * completeSetup() carries the Groq API key from the first-run setup
 * screen to the main process, which is the only place that ever
 * persists it (via ConfigStore + safeStorage) — the renderer sends it
 * once and never stores or re-reads it itself.
 *
 * importMediaFile() is the same pattern applied to local files
 * (ARCHITECTURE.md section 60.4): the renderer asks, the main process
 * opens the native file dialog, and the renderer gets back a suggested
 * title (derived from the filename) plus nothing else identifying the
 * file — never the operator's original filesystem path. The renderer
 * shows its own confirmation dialog for that title (ARCHITECTURE.md
 * section 74 — it IS the voice-trigger phrase, so it must be
 * confirmable/editable, not silently accepted); confirmMediaImport()
 * is where the main process actually copies the file, using only the
 * title text handed back to it. cancelMediaImport() discards the
 * pending pick if the operator dismisses that dialog instead.
 *
 * renameMediaCue()/deleteMediaCue() (ARCHITECTURE.md section 74) let an
 * operator fix an import mistake directly — the wrong file imported, or
 * a typo'd title — without restarting the app. Same "id in, never a raw
 * path" shape as everything else here.
 *
 * setDisplayMode()/setUiLanguage() (ARCHITECTURE.md sections 63.2/63.5)
 * are the live-toggle half of "setup default + live dashboard toggle" —
 * completeSetup() carries the setup-time default for both.
 */
contextBridge.exposeInMainWorld("churchOverlay", {
  getOperatorConnectionInfo: () => ipcRenderer.invoke("get-operator-connection-info"),
  getStartupStatus: () => ipcRenderer.invoke("get-startup-status"),
  completeSetup: (groqApiKey: string, displayMode: string, uiLanguage: string, allowPhoneRemote: boolean) =>
    ipcRenderer.invoke("complete-setup", { groqApiKey, displayMode, uiLanguage, allowPhoneRemote }),
  importMediaFile: () => ipcRenderer.invoke("import-media-file"),
  confirmMediaImport: (title: string) => ipcRenderer.invoke("confirm-media-import", title),
  cancelMediaImport: () => ipcRenderer.invoke("cancel-media-import"),
  listMediaCues: () => ipcRenderer.invoke("list-media-cues"),
  renameMediaCue: (id: string, newTitle: string) => ipcRenderer.invoke("rename-media-cue", id, newTitle),
  deleteMediaCue: (id: string) => ipcRenderer.invoke("delete-media-cue", id),
  setDisplayMode: (mode: string) => ipcRenderer.invoke("set-display-mode", mode),
  setUiLanguage: (language: string) => ipcRenderer.invoke("set-ui-language", language),
  setVerseConfirmationMode: (mode: string) => ipcRenderer.invoke("set-verse-confirmation-mode", mode),
  exportSession: () => ipcRenderer.invoke("export-session"),
  setEnableSermonNotes: (enabled: boolean) => ipcRenderer.invoke("set-enable-sermon-notes", enabled),
})
