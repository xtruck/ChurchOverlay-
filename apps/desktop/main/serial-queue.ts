/**
 * Runs async steps strictly one at a time, in call order. A step that rejects does not
 * block the ones after it, and its rejection still reaches its own caller.
 *
 * Used for the service lifecycle (startServices / shutdown): two overlapping settings
 * changes used to run two start-ups concurrently, double-shut-down, and fight over
 * port 8787. A step must never call run() on the same queue and await it (that would
 * wait on itself): code already inside a step calls the unqueued function instead.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(step: () => Promise<T>): Promise<T> {
    const result = this.tail.then(step, step)
    this.tail = result.catch(() => undefined)
    return result
  }
}
