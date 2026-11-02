/** Bounded downlink queue of one Remote stream that ends on replacement, failure or cancellation. */

/** Items queued for one Remote stream until the Remote reads them. */
export class StreamChannel<T> {
  private readonly items: T[] = []
  private wake: (() => void) | undefined
  private ended = false
  private failure: Error | undefined

  /**
   * @param maxQueued - queued items beyond which the stream fails.
   * @param overflow - failure text when the queue overflows.
   */
  constructor(private readonly maxQueued: number, private readonly overflow: string) {}

  /**
   * Queue one item.
   * @param item - queued unless the stream has ended; an overflow fails the stream.
   */
  push(item: T): void {
    if (this.ended) return
    if (this.items.length >= this.maxQueued) {
      this.fail(new Error(this.overflow))
      return
    }
    this.items.push(item)
    this.wake?.()
  }

  /** End after the queued items. */
  end(): void {
    this.ended = true
    this.wake?.()
  }

  /**
   * End the stream with a failure.
   * @param error - thrown after the queued items; the first failure wins.
   */
  fail(error: Error): void {
    this.failure ??= error
    this.end()
  }

  /**
   * Yield queued items until the stream ends.
   * @param signal - cancellation; ends the stream after the queued items.
   * @yields each item in order.
   * @returns a generator that finishes when the stream ends and throws its failure.
   */
  async *drain(signal: AbortSignal): AsyncGenerator<T> {
    const abort = (): void => { this.end() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      for (;;) {
        while (this.items.length > 0) yield this.items.shift() as T
        if (this.failure !== undefined) throw this.failure
        if (this.ended || signal.aborted) return
        await new Promise<void>((resolve) => { this.wake = resolve })
        this.wake = undefined
      }
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }
}
