import { test } from "node:test"
import assert from "node:assert/strict"
import { matchesSignature } from "./media-signature"
import { fakeMediaBytes } from "./media-test-fixtures"

const EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".wav", ".mp4", ".m4a", ".webm", ".mp3"]

test("matchesSignature: accepts the real signature for every allowed extension, any case", () => {
  for (const ext of EXTENSIONS) {
    assert.equal(matchesSignature(ext, fakeMediaBytes("file" + ext)), true, ext)
    assert.equal(matchesSignature(ext.toUpperCase(), fakeMediaBytes("file" + ext)), true, ext)
  }
})

test("matchesSignature: rejects text, executables, and one format named as another", () => {
  const text = Buffer.from("hello world, not media")
  const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00])
  for (const ext of EXTENSIONS) {
    assert.equal(matchesSignature(ext, text), false, ext)
    assert.equal(matchesSignature(ext, exe), false, ext)
  }
  assert.equal(matchesSignature(".png", fakeMediaBytes("x.jpg")), false)
  assert.equal(matchesSignature(".webp", fakeMediaBytes("x.wav")), false)
  assert.equal(matchesSignature(".wav", fakeMediaBytes("x.webp")), false)
})

test("matchesSignature: accepts an untagged MP3 frame, rejects truncated input and unknown extensions", () => {
  assert.equal(matchesSignature(".mp3", Buffer.from([0xff, 0xfb, 0x90, 0x00])), true)
  assert.equal(matchesSignature(".mp3", Buffer.from([0xff, 0xe0])), false) // reserved layer bits
  assert.equal(matchesSignature(".png", Buffer.from([0x89, 0x50])), false)
  assert.equal(matchesSignature(".mp4", Buffer.alloc(0)), false)
  assert.equal(matchesSignature(".exe", fakeMediaBytes("x.png")), false)
})
