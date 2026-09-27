import { test } from "node:test"
import assert from "node:assert/strict"
import { isAllowedNavigation, isExternalHttpsUrl } from "./navigation-guard"

const DASHBOARD = "file:///C:/Program%20Files/ChurchOverlay/resources/app.asar/apps/desktop/renderer/index.html"

test("navigation guard: initial load (empty current URL) is allowed", () => {
  assert.equal(isAllowedNavigation("", DASHBOARD), true)
})

test("navigation guard: dashboard reload or hash change stays allowed", () => {
  assert.equal(isAllowedNavigation(DASHBOARD, DASHBOARD), true)
  assert.equal(isAllowedNavigation(DASHBOARD, DASHBOARD + "#settings"), true)
})

test("navigation guard: dashboard cannot navigate to an external site", () => {
  assert.equal(isAllowedNavigation(DASHBOARD, "https://evil.example/"), false)
  assert.equal(isAllowedNavigation(DASHBOARD, "http://127.0.0.1:3000/"), false)
})

test("navigation guard: dashboard cannot navigate to another local file", () => {
  assert.equal(isAllowedNavigation(DASHBOARD, "file:///C:/Users/op/Downloads/page.html"), false)
})

test("navigation guard: overlay renderer may move within its own local origin only", () => {
  assert.equal(isAllowedNavigation("http://127.0.0.1:8080/", "http://127.0.0.1:8080/?layout=full"), true)
  assert.equal(isAllowedNavigation("http://127.0.0.1:8080/", "http://127.0.0.1:9999/"), false)
  assert.equal(isAllowedNavigation("http://127.0.0.1:8080/", "https://127.0.0.1:8080/"), false)
})

test("navigation guard: malformed URLs are refused", () => {
  assert.equal(isAllowedNavigation(DASHBOARD, "not a url"), false)
})

test("isExternalHttpsUrl: only https is handed to the OS browser", () => {
  assert.equal(isExternalHttpsUrl("https://bible.helloao.org/"), true)
  assert.equal(isExternalHttpsUrl("http://example.com/"), false)
  assert.equal(isExternalHttpsUrl("file:///C:/Windows/System32/calc.exe"), false)
  assert.equal(isExternalHttpsUrl("javascript:alert(1)"), false)
  assert.equal(isExternalHttpsUrl("garbage"), false)
})
