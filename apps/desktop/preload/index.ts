import { contextBridge, ipcRenderer } from "electron"

/**
 * The one bridge between the fully-sandboxed dashboard renderer and the
 * main process (ARCHITECTURE.md section 7, section 27; AGENTS.md section
 * 27). Exposes a narrow, explicit, purpose-built API — never generic
 * ipcRenderer access — so the renderer cannot reach arbitrary main-
 * process capabilities.
 *
 * getOperatorConnectionInfo() is the one place this hands the renderer
 * something secret-shaped: the operator token needed to open the
 * renderer's own WebSocket connection to the local server, plus the port
 * to connect on. This does not violate "renderer must not access
 * secrets" (ARCHITECTURE.md section 6.2) in the sense that rule actually
 * protects against: the renderer never touches the filesystem, safeStorage,
 * or any application secret beyond this one token, and it receives that
 * token only for its own sanctioned connection to a server on the SAME
 * machine, handed to it explicitly by the main process it already trusts.
 * The threat this token defends against is an unrelated local process or
 * web page connecting to the WS server — not the dashboard renderer
 * itself, which the main process created and is choosing to talk to.
 */
contextBridge.exposeInMainWorld("churchOverlay", {
  getOperatorConnectionInfo: () => ipcRenderer.invoke("get-operator-connection-info"),
})
