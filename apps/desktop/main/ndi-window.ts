import { BrowserWindow } from "electron"
import { NDI_ACTIVE_FPS, NDI_FRAME_HEIGHT, NDI_FRAME_WIDTH } from "./ndi-output"

/** How many times a crashed offscreen NDI renderer is reloaded before it is left down (and logged). */
export const NDI_MAX_RENDERER_RELOADS = 3

/**
 * ARCHITECTURE.md section 109: the one place the offscreen NDI window is built.
 * Measured in real Electron, each option below fixes a specific defect of the
 * previous bare `{ show: false, offscreen: true }` window:
 *  - `transparent` + `backgroundColor`: without them every frame had an opaque
 *    white background, so the overlay could not be keyed over video.
 *  - `setContentSize` right after creation: the default window was 800x600, and
 *    `width`/`height` alone are clamped to the display (a 1366x768 laptop would
 *    emit a 1366x768 source). `enableLargerThanScreen` was tried and it breaks
 *    transparency, so it is deliberately not used.
 *  - `backgroundThrottling: false`: a hidden window must keep painting.
 *
 * Its own module (not index.ts) so scripts/ndi-window-probe.js can exercise
 * this exact factory in real Electron without booting the whole application.
 */
export async function createNdiWindow(overlayUrl: string, log: (event: string, error?: string) => void): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    show: false,
    width: NDI_FRAME_WIDTH,
    height: NDI_FRAME_HEIGHT,
    transparent: true,
    frame: false,
    backgroundColor: "#00000000",
    webPreferences: { offscreen: true, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  })
  win.setContentSize(NDI_FRAME_WIDTH, NDI_FRAME_HEIGHT)
  win.webContents.setFrameRate(NDI_ACTIVE_FPS)

  // A dead offscreen renderer would leave the NDI source silently frozen on its last frame.
  let reloads = 0
  win.webContents.on("render-process-gone", (_event, details) => {
    log("renderer.gone", details.reason)
    if (win.isDestroyed()) return
    if (reloads >= NDI_MAX_RENDERER_RELOADS) {
      log("renderer.reload-gave-up", `${NDI_MAX_RENDERER_RELOADS} reloads did not help`)
      return
    }
    reloads++
    win.webContents.reload()
  })

  await win.loadURL(overlayUrl)
  return win
}
