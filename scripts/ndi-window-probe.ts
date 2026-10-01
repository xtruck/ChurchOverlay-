/**
 * Dev probe for the offscreen NDI window (ARCHITECTURE.md section 109).
 * Builds the REAL createNdiWindow() factory in real Electron, serves a tiny
 * page (transparent body + one opaque red box) and reports the size, alpha and
 * paint cadence of what Chromium actually emits. No NDI receiver is involved.
 *
 *   npm run build && electron dist/scripts/ndi-window-probe.js      (add `xvfb-run -a` on a headless box)
 *
 * Exit code 0 only when the frame is 1920x1080, the background is transparent
 * and the red box is opaque.
 */
import { app } from "electron"
import http from "node:http"
import { createNdiWindow } from "../apps/desktop/main/ndi-window"

const PAGE = '<!doctype html><body style="margin:0;background:transparent"><div style="position:absolute;left:100px;top:100px;width:200px;height:200px;background:#f00"></div>'

async function main(): Promise<number> {
  const server = http.createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(PAGE))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  const win = await createNdiWindow(`http://127.0.0.1:${port}/`, (event, error) => console.log("log", event, error ?? ""))
  let last: { w: number; h: number; bgra: Buffer } | null = null
  let paints = 0
  win.webContents.on("paint", (_e, _dirty, image) => {
    const { width, height } = image.getSize()
    last = { w: width, h: height, bgra: image.toBitmap() }
    paints++
  })
  win.webContents.invalidate()
  await new Promise((r) => setTimeout(r, 2000))
  win.destroy()
  server.close()
  if (!last) { console.log("FAIL: no paint event"); return 1 }
  const { w, h, bgra } = last as { w: number; h: number; bgra: Buffer }
  const alphaAt = (x: number, y: number): number => bgra[(y * w + x) * 4 + 3] ?? -1
  const corner = alphaAt(5, 5)
  const box = alphaAt(200, 200)
  console.log({ width: w, height: h, paints, cornerAlpha: corner, boxAlpha: box })
  const ok = w === 1920 && h === 1080 && corner === 0 && box === 255
  console.log(ok ? "PASS" : "FAIL")
  return ok ? 0 : 1
}

app.whenReady().then(main).then((code) => app.exit(code), (err) => { console.error(err); app.exit(1) })
