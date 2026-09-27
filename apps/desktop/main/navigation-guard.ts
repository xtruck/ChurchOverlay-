/**
 * Pure helpers for the Electron navigation guard in main/index.ts, kept free
 * of any electron import so they can be unit-tested with node --test.
 */

/**
 * A webContents may only navigate within its own origin. For file:// pages
 * (the dashboard) that means the same file — a reload or hash change —
 * never another local file. An empty current URL means the window is still
 * on its initial load, which is always allowed.
 */
export function isAllowedNavigation(currentUrl: string, targetUrl: string): boolean {
  if (currentUrl === "") return true
  let current: URL
  let target: URL
  try {
    current = new URL(currentUrl)
    target = new URL(targetUrl)
  } catch {
    return false
  }
  if (current.protocol !== target.protocol) return false
  if (current.protocol === "file:") return current.pathname === target.pathname
  return current.host === target.host
}

/** Only https URLs are ever handed to the OS browser. */
export function isExternalHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:"
  } catch {
    return false
  }
}
