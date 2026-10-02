import { test } from "node:test"
import assert from "node:assert/strict"
import { checkDroppedPath, inferMediaKind, deriveTitleFromFilename } from "./media-import"

test("inferMediaKind: recognizes every allowed extension, case-insensitively", () => {
  assert.equal(inferMediaKind("welcome.PNG"), "image")
  assert.equal(inferMediaKind("welcome.jpg"), "image")
  assert.equal(inferMediaKind("welcome.jpeg"), "image")
  assert.equal(inferMediaKind("welcome.webp"), "image")
  assert.equal(inferMediaKind("clip.mp4"), "video")
  assert.equal(inferMediaKind("clip.WEBM"), "video")
  assert.equal(inferMediaKind("song.mp3"), "audio")
  assert.equal(inferMediaKind("song.wav"), "audio")
  assert.equal(inferMediaKind("song.m4a"), "audio")
})

test("inferMediaKind: returns null for an unrecognized extension", () => {
  assert.equal(inferMediaKind("notes.pdf"), null)
  assert.equal(inferMediaKind("malware.exe"), null)
  assert.equal(inferMediaKind("no-extension-at-all"), null)
})

test("deriveTitleFromFilename: strips the extension and replaces separators with spaces", () => {
  assert.equal(deriveTitleFromFilename("welcome-slide.png"), "welcome slide")
  assert.equal(deriveTitleFromFilename("closing_song.mp3"), "closing song")
  assert.equal(deriveTitleFromFilename("Intro Clip.mp4"), "Intro Clip")
})

test("deriveTitleFromFilename: collapses repeated separators and trims", () => {
  assert.equal(deriveTitleFromFilename("welcome--slide__final.png"), "welcome slide final")
  assert.equal(deriveTitleFromFilename("-leading-and-trailing-.png"), "leading and trailing")
})

test("deriveTitleFromFilename: works with a full path, not just a bare filename", () => {
  assert.equal(deriveTitleFromFilename("C:\\Users\\me\\Pictures\\welcome-slide.png"), "welcome slide")
})

test("checkDroppedPath: accepts a local drive path with a supported extension", () => {
  assert.deepEqual(checkDroppedPath("C:\\Users\\op\\Pictures\\Welcome.PNG"), {
    ok: true,
    filePath: "C:\\Users\\op\\Pictures\\Welcome.PNG",
    kind: "image",
  })
  const check = checkDroppedPath("D:/media/clip.mp4")
  assert.equal(check.ok, true)
  assert.equal(check.ok && check.kind, "video")
  assert.equal(check.ok && check.filePath, "D:\\media\\clip.mp4")
})

test("checkDroppedPath: refuses network shares before any filesystem access", () => {
  for (const path of ["\\\\attacker\\share\\a.png", "//attacker/share/a.png", "\\\\?\\UNC\\host\\a.png", "\\\\.\\C:\\a.png"]) {
    assert.equal(checkDroppedPath(path).ok, false, path)
  }
})

test("checkDroppedPath: refuses non-strings, relative paths, NUL bytes and unsupported types", () => {
  const values: unknown[] = [
    undefined,
    null,
    42,
    {},
    "",
    "a.png",
    "..\\a.png",
    "C:a.png",
    "\\a.png",
    "C:\\a.png\0.exe",
    "C:\\tools\\app.exe",
    "C:\\x\\" + "a".repeat(1100) + ".png",
  ]
  for (const value of values) {
    assert.equal(checkDroppedPath(value).ok, false, String(value).slice(0, 40))
  }
})
