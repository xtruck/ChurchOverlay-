import { test } from "node:test"
import assert from "node:assert/strict"
import type { TranscriptResult, Verse, VerseReference, WsMessage } from "../../../packages/contracts"
import { Logger } from "../../../packages/shared/logger"
import { AiSuggestionCoordinator, type AiSuggestionPorts } from "./ai-suggestion-coordinator"
import { SuggestionArbiter } from "./suggestion-arbiter"

const JOHN_3_16: VerseReference = { book: "john", chapter: 3, verse: 16 }
const JOHN_VERSE: Verse = { reference: JOHN_3_16, text: "For God so loved the world...", translation: "kjv", source: "bible-api.com" }
const CLEANUP_PROMPT = "correct speech-to-text"
const SEMANTIC_PROMPT = "quoting or closely paraphrasing"
const COPILOT_PROMPT = "assist the operator"
const GARBLED = "Ouvrez vos Bibles à Jonn 3 verset 16"
const FIXED = "Ouvrez vos Bibles à Jean 3 verset 16"
const PARAPHRASE = "God loved the world so much that he gave his only son for us"

function final(id: string, text: string): TranscriptResult {
  return { id, correlationId: `C-${id}`, sequence: 1, text, state: "final", timestamp: Date.now() }
}

/** A completer the test releases by hand, so state can change while the model call is in flight. */
function controllableCompleter() {
  const waiting: Array<{ system: string; resolve: (answer: string) => void }> = []
  return {
    waiting,
    complete: (request: { system: string; user: string }) => new Promise<string>((resolve) => { waiting.push({ system: request.system, resolve }) }),
    release: (match: string, answer: string) => {
      const index = waiting.findIndex((call) => call.system.includes(match))
      assert.ok(index >= 0, `no pending ${match} call`)
      waiting.splice(index, 1)[0]?.resolve(answer)
    },
  }
}

function makePorts(overrides: Partial<AiSuggestionPorts> & Pick<AiSuggestionPorts, "completer">) {
  const offered: Verse[] = []
  const operatorMessages: WsMessage[] = []
  let stopped = false
  const ports: AiSuggestionPorts = {
    logger: new Logger({ write: () => {} }),
    isStopped: () => stopped,
    currentBook: () => null,
    currentPosition: () => null,
    detectValidated: (text) => (/jean\s*3/i.test(text) ? [JOHN_3_16] : []),
    validateProposal: (proposal) => (proposal.book.toLowerCase() === "john" && proposal.chapter === 3 && proposal.verse === 16 ? JOHN_3_16 : null),
    resolve: async () => JOHN_VERSE,
    containsBookName: () => false,
    quoteMatches: () => false,
    shownKeys: () => [],
    arbiter: new SuggestionArbiter(),
    offerPending: (verse) => { offered.push(verse) },
    sendToOperators: (message) => { operatorMessages.push(message) },
    copilotIntervalMs: 3_600_000,
    ...overrides,
  }
  return { ports, offered, operatorMessages, stop: () => { stopped = true } }
}

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))

test("AiSuggestionCoordinator (cleanup): a correction that finds a verse is offered as a pending cleanup suggestion", async () => {
  const completer = controllableCompleter()
  const { ports, offered } = makePorts({ completer, flags: { transcriptCleanup: true } })
  const coordinator = new AiSuggestionCoordinator(ports)
  try {
    coordinator.cleanupTranscript(final("A", GARBLED))
    await settle()
    completer.release(CLEANUP_PROMPT, FIXED)
    await settle()
    assert.equal(offered.length, 1)
    assert.deepEqual(offered[0], { ...JOHN_VERSE, origin: "ai", suggestedBy: "cleanup" })
  } finally {
    coordinator.stop()
  }
})

test("AiSuggestionCoordinator (cleanup): nothing is offered when the core stops while the model call is in flight", async () => {
  const completer = controllableCompleter()
  const { ports, offered, stop } = makePorts({ completer, flags: { transcriptCleanup: true } })
  const coordinator = new AiSuggestionCoordinator(ports)
  try {
    coordinator.cleanupTranscript(final("A", GARBLED))
    await settle()
    stop()
    completer.release(CLEANUP_PROMPT, FIXED)
    await settle()
    assert.equal(offered.length, 0)
  } finally {
    coordinator.stop()
  }
})

test("AiSuggestionCoordinator (cleanup): nothing is offered when the core stops while the verse is being fetched", async () => {
  const completer = controllableCompleter()
  let finishLookup: (verse: Verse) => void = () => {}
  const { ports, offered, stop } = makePorts({
    completer,
    flags: { transcriptCleanup: true },
    resolve: () => new Promise<Verse>((resolve) => { finishLookup = resolve }),
  })
  const coordinator = new AiSuggestionCoordinator(ports)
  try {
    coordinator.cleanupTranscript(final("A", GARBLED))
    await settle()
    completer.release(CLEANUP_PROMPT, FIXED)
    await settle()
    stop()
    finishLookup(JOHN_VERSE)
    await settle()
    assert.equal(offered.length, 0)
  } finally {
    coordinator.stop()
  }
})

test("AiSuggestionCoordinator (semantic): a failed lookup does not start the cooldown, a waiting detection holds the guess back, then it is offered", async () => {
  const completer = controllableCompleter()
  const arbiter = new SuggestionArbiter()
  let lookups = 0
  const { ports, offered } = makePorts({
    completer,
    arbiter,
    flags: { semanticDetection: true },
    semanticMinIntervalMs: 0,
    resolve: async () => (++lookups === 1 ? null : JOHN_VERSE),
  })
  const coordinator = new AiSuggestionCoordinator(ports)
  const answer = '{"book":"John","chapter":3,"verse":16,"confidence":"high"}'
  try {
    // 1) the lookup fails: nothing offered, and the verse is NOT blocked for 60 s
    coordinator.onFinalAnalyzed(final("A", PARAPHRASE), false)
    await settle()
    completer.release(SEMANTIC_PROMPT, answer)
    await settle()
    assert.equal(offered.length, 0)
    assert.equal(arbiter.canOffer(JOHN_3_16, null), true)

    // 2) a detected verse is waiting for approval: the guess waits
    arbiter.noteDetectedWaiting()
    coordinator.onFinalAnalyzed(final("B", PARAPHRASE), false)
    await settle()
    completer.release(SEMANTIC_PROMPT, answer)
    await settle()
    assert.equal(offered.length, 0)

    // 3) nothing waiting any more: the same guess is offered
    arbiter.clearDetectedWaiting()
    coordinator.onFinalAnalyzed(final("C", PARAPHRASE), false)
    await settle()
    completer.release(SEMANTIC_PROMPT, answer)
    await settle()
    assert.equal(offered.length, 1)
    assert.equal((offered[0] as Verse & { suggestedBy?: string }).suggestedBy, "semantic")
  } finally {
    coordinator.stop()
  }
})

test("AiSuggestionCoordinator (semantic): a final that carried an explicit reference or command never reaches the model", async () => {
  const completer = controllableCompleter()
  const { ports } = makePorts({ completer, flags: { semanticDetection: true } })
  const coordinator = new AiSuggestionCoordinator(ports)
  try {
    coordinator.onFinalAnalyzed(final("A", PARAPHRASE), true)
    await settle()
    assert.equal(completer.waiting.length, 0)
  } finally {
    coordinator.stop()
  }
})

test("AiSuggestionCoordinator: every feature is OFF by default, and partials never reach a helper", async () => {
  const completer = controllableCompleter()
  const { ports } = makePorts({ completer })
  const coordinator = new AiSuggestionCoordinator(ports)
  try {
    coordinator.cleanupTranscript(final("A", GARBLED))
    coordinator.onFinalAnalyzed(final("B", PARAPHRASE), false)
    coordinator.setFeature("transcriptCleanup", true)
    coordinator.setFeature("semanticDetection", true)
    coordinator.cleanupTranscript({ ...final("C", GARBLED), state: "partial" })
    coordinator.onFinalAnalyzed({ ...final("D", PARAPHRASE), state: "partial" }, false)
    await settle()
    assert.equal(completer.waiting.length, 0)
  } finally {
    coordinator.stop()
  }
})

test("AiSuggestionCoordinator (copilot): validated verses go to operators only; nothing is sent once the feature is switched off in flight", async () => {
  const completer = controllableCompleter()
  const { ports, offered, operatorMessages } = makePorts({
    completer,
    flags: { sermonCopilot: true },
    copilotIntervalMs: 20,
  })
  const coordinator = new AiSuggestionCoordinator(ports)
  const answer = JSON.stringify({ relatedVerses: [{ book: "John", chapter: 3, verse: 16 }, { book: "John", chapter: 99, verse: 99 }], keyPoint: null })
  const filler = "Frères et soeurs, la grâce de Dieu nous soutient chaque jour et sa fidélité ne change jamais, même quand nous traversons des moments difficiles dans nos familles et dans notre travail, car il agit pour notre bien."
  try {
    coordinator.onFinalAnalyzed(final("A", filler), false)
    await new Promise((resolve) => setTimeout(resolve, 80))
    completer.release(COPILOT_PROMPT, answer)
    await settle()
    assert.equal(operatorMessages.length, 1)
    const payload = operatorMessages[0]?.payload as { relatedVerses: Verse[] }
    assert.deepEqual(payload.relatedVerses.map((verse) => verse.reference), [JOHN_3_16])
    assert.equal(offered.length, 0)

    coordinator.onFinalAnalyzed(final("B", filler), false)
    await new Promise((resolve) => setTimeout(resolve, 80))
    coordinator.setFeature("sermonCopilot", false)
    completer.release(COPILOT_PROMPT, answer)
    await settle()
    assert.equal(operatorMessages.length, 1)
  } finally {
    coordinator.stop()
  }
})
