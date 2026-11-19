import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Logger } from "../../../packages/shared/logger"
import { createLogSink, LogRing, RotatingLogFile } from "./log-file"

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "churchoverlay-log-"))
}

test("RotatingLogFile appends lines, creating the directory on first write", async () => {
  const root = tempDir()
  try {
    const dir = join(root, "nested", "logs")
    const file = new RotatingLogFile({ dir })
    file.write('{"a":1}')
    file.write('{"a":2}')
    await file.flush()
    assert.equal(readFileSync(join(dir, "churchoverlay.log"), "utf8"), '{"a":1}\n{"a":2}\n')
    assert.equal(file.stats().linesWritten, 2)
    assert.equal(file.stats().writeFailures, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("RotatingLogFile rotates by size and keeps at most maxFiles files in total", async () => {
  const dir = tempDir()
  try {
    const file = new RotatingLogFile({ dir, maxBytes: 100, maxFiles: 3 })
    const line = "x".repeat(39) // 40 bytes with the newline: two per file
    for (let i = 0; i < 20; i++) {
      file.write(line + String(i % 10))
      await file.flush() // one batch per line so rotation is exercised repeatedly
    }
    const names = readdirSync(dir).sort()
    assert.deepEqual(names, ["churchoverlay.1.log", "churchoverlay.2.log", "churchoverlay.log"])
    for (const name of names) assert.ok(readFileSync(join(dir, name), "utf8").length <= 100, `${name} stays within maxBytes`)
    assert.ok(file.stats().rotations >= 5)
    // The newest line is in the live file.
    assert.ok(readFileSync(join(dir, "churchoverlay.log"), "utf8").includes("x9"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("RotatingLogFile resumes the size of an existing file instead of overshooting maxBytes", async () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, "churchoverlay.log"), "y".repeat(90) + "\n")
    const file = new RotatingLogFile({ dir, maxBytes: 100, maxFiles: 2 })
    file.write("z".repeat(30))
    await file.flush()
    assert.equal(readFileSync(join(dir, "churchoverlay.1.log"), "utf8"), "y".repeat(90) + "\n")
    assert.equal(readFileSync(join(dir, "churchoverlay.log"), "utf8"), "z".repeat(30) + "\n")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("RotatingLogFile with maxFiles 1 keeps a single bounded file", async () => {
  const dir = tempDir()
  try {
    const file = new RotatingLogFile({ dir, maxBytes: 50, maxFiles: 1 })
    for (let i = 0; i < 6; i++) {
      file.write("q".repeat(29) + i)
      await file.flush()
    }
    assert.deepEqual(readdirSync(dir), ["churchoverlay.log"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("RotatingLogFile never writes credentials, even in a raw line", async () => {
  const dir = tempDir()
  try {
    const file = new RotatingLogFile({ dir })
    file.write('{"event":"x","error":"upstream said Bearer abc.def-ghi and ?key=SUPERSECRET and gsk_abcdefghijklmnop"}')
    await file.flush()
    const text = readFileSync(join(dir, "churchoverlay.log"), "utf8")
    assert.ok(!text.includes("abc.def-ghi"))
    assert.ok(!text.includes("SUPERSECRET"))
    assert.ok(!text.includes("gsk_abcdefghijklmnop"))
    assert.ok(text.includes("[REDACTED]"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a failing disk is counted, never thrown, and does not stop later writes from being attempted", async () => {
  const root = tempDir()
  try {
    // The 'directory' is a regular file: mkdir/append must fail.
    const blocker = join(root, "blocked")
    writeFileSync(blocker, "not a directory")
    const file = new RotatingLogFile({ dir: join(blocker, "logs") })
    assert.doesNotThrow(() => file.write("one"))
    await file.flush()
    assert.doesNotThrow(() => file.write("two"))
    await file.flush()
    const stats = file.stats()
    assert.equal(stats.writeFailures, 2)
    assert.equal(stats.droppedLines, 2)
    assert.equal(stats.linesWritten, 0)
    assert.ok(stats.lastError)
    assert.doesNotThrow(() => file.flushSync())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the queue is bounded: overflow drops the oldest lines and counts them", async () => {
  const dir = tempDir()
  try {
    const file = new RotatingLogFile({ dir, maxQueuedLines: 3 })
    for (let i = 1; i <= 6; i++) file.write(`line${i}`)
    await file.flush()
    assert.equal(readFileSync(join(dir, "churchoverlay.log"), "utf8"), "line4\nline5\nline6\n")
    assert.equal(file.stats().droppedLines, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("flushSync writes what is still queued (crash path)", () => {
  const dir = tempDir()
  try {
    const file = new RotatingLogFile({ dir })
    file.write("last words")
    file.flushSync()
    assert.equal(readFileSync(join(dir, "churchoverlay.log"), "utf8"), "last words\n")
    assert.ok(existsSync(join(dir, "churchoverlay.log")))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("LogRing keeps only the newest lines", () => {
  const ring = new LogRing(3)
  for (const line of ["a", "b", "c", "d", "e"]) ring.push(line)
  assert.deepEqual(ring.lines(), ["c", "d", "e"])
  assert.throws(() => new LogRing(0))
})

test("createLogSink feeds stdout, ring and file; a broken stdout is counted, not thrown", async () => {
  const dir = tempDir()
  try {
    const file = new RotatingLogFile({ dir })
    const ring = new LogRing(10)
    const printed: string[] = []
    let broken = false
    const sink = createLogSink(file, ring, (line) => {
      if (broken) throw new Error("EPIPE")
      printed.push(line)
    })
    const logger = new Logger({ write: sink.write, now: () => 0 })
    logger.info({ component: "t", event: "first" })
    broken = true
    logger.error({ component: "t", event: "second", error: "boom", metadata: { apiKey: "gsk_realsecretvalue1234", note: "ok" } })
    await file.flush()
    assert.equal(printed.length, 1)
    assert.equal(sink.consoleFailures(), 1)
    assert.equal(ring.lines().length, 2)
    const onDisk = readFileSync(join(dir, "churchoverlay.log"), "utf8").trim().split("\n")
    assert.equal(onDisk.length, 2)
    assert.equal(JSON.parse(onDisk[1] as string).event, "second")
    assert.ok(!onDisk[1]?.includes("gsk_realsecretvalue1234"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
