import type { Rundown, RundownStatePayload } from "../../../packages/contracts"

/**
 * ARCHITECTURE.md section 64.4: the server-authoritative source of truth for
 * "which scene is active, and is a live-detected verse currently interrupting
 * it." No client ever computes or persists this itself (invariant 21).
 *
 * Resolves section 64.2's precedence rule: a live-detected, overridden, or
 * voice-navigated verse always overlays immediately, pausing (not
 * discarding) whatever scene the rundown had on air. `interrupt()` records
 * the pause; `resumeFromInterrupt()` hands control back to exactly that
 * scene when the interrupting verse clears. An explicit rundown action
 * (`next`/`previous`/`goto`) during an interrupt is a deliberate operator
 * override and always wins instead — it discards the pause rather than
 * resuming it later (section 64.2's third bullet).
 */
export class RundownController {
  private rundown: Rundown | null = null
  private cursor = 0
  /** Non-null exactly while a live/overridden/navigated verse is interrupting a scene. */
  private pausedCursor: number | null = null

  /** No-op (returns null) for an empty rundown — nothing to activate. */
  load(rundown: Rundown): RundownStatePayload | null {
    if (rundown.scenes.length === 0) return null
    this.rundown = rundown
    this.cursor = 0
    this.pausedCursor = null
    return this.buildState()
  }

  next(): RundownStatePayload | null {
    return this.moveTo(this.cursor + 1)
  }

  previous(): RundownStatePayload | null {
    return this.moveTo(this.cursor - 1)
  }

  goto(index: number): RundownStatePayload | null {
    return this.moveTo(index)
  }

  /**
   * Called before a live/overridden/navigated verse broadcasts (section
   * 64.2). Pauses the current scene, if a rundown is active and not already
   * interrupted. Returns the updated state (for a `rundown:state` broadcast
   * so the dashboard knows a scene is now paused underneath), or null if no
   * rundown is loaded — nothing to pause.
   */
  interrupt(): RundownStatePayload | null {
    if (!this.rundown) return null
    if (this.pausedCursor === null) this.pausedCursor = this.cursor
    return this.buildState()
  }

  /**
   * Called when the interrupting verse clears. Returns the paused scene's
   * state to re-broadcast (resuming it), or null if nothing was paused —
   * either no rundown was active, or an explicit rundown action already
   * discarded the pause (section 64.2's third bullet).
   */
  resumeFromInterrupt(): RundownStatePayload | null {
    if (this.pausedCursor === null) return null
    this.cursor = this.pausedCursor
    this.pausedCursor = null
    return this.buildState()
  }

  /** For a newly-connected viewer (section 60.4's reconnect sync, reused here). */
  currentState(): RundownStatePayload | null {
    return this.buildState()
  }

  private moveTo(index: number): RundownStatePayload | null {
    if (!this.rundown) return null
    if (index < 0 || index >= this.rundown.scenes.length) return null
    this.cursor = index
    this.pausedCursor = null
    return this.buildState()
  }

  private buildState(): RundownStatePayload | null {
    if (!this.rundown) return null
    const scene = this.rundown.scenes[this.cursor]
    if (!scene) return null
    return {
      rundownId: this.rundown.id,
      cursor: this.cursor,
      scene,
      interrupted: this.pausedCursor !== null,
    }
  }
}
