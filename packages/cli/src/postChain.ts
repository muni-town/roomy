/**
 * Serial post chain for streamed thinking chunks.
 *
 * The responder streams the model's thinking trace to Roomy while omp is
 * still running, so each chunk post is appended to a promise chain that is
 * only awaited once streaming has finished. That shape has a nasty failure
 * mode: if a post rejects and the chain link is left rejected with no
 * downstream handler, Node treats it as an unhandled rejection and kills the
 * process — which, via the broken pipe, takes the whole `roomy-bridge |
 * respond` pipeline with it and loses the in-flight answer.
 *
 * A `PostChain` closes that hole by construction:
 *
 *  - The chain NEVER rejects. A failed post is logged, counted, and its error
 *    recorded; the chain continues so subsequent chunks (and the final
 *    answer) still get their turn.
 *  - `drain()` always resolves. Callers await it to know every queued post
 *    has settled, then consult `failureCount()`/`firstError()` to decide
 *    whether to warn and continue (the answer is still worth posting) or bail.
 *
 * Rejections are contained, never re-thrown: a link left rejected with nothing
 * attached sits unhandled for the whole remaining streaming window — exactly
 * the window a 20s XRPC timeout spans.
 *
 * Deliberately no retry: a chunk post that times out has an ambiguous
 * outcome (the appserver may have already appended the event), and sendReply
 * mints a fresh ULID per attempt — retrying would silently duplicate the
 * chunk. Containment keeps the trace intact and the pipeline alive.
 */

/** Error text for a thrown value of unknown shape. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * A serial queue of async posts whose failures are contained: the chain
 * settles, failures are counted, and no rejection is ever left unhandled.
 */
export class PostChain {
  #tail: Promise<void> = Promise.resolve();
  #failures = 0;
  #firstError: unknown;
  #log: (msg: string) => void;

  constructor(log: (msg: string) => void = () => {}) {
    this.#log = log;
  }

  /**
   * Append a post to the chain. It runs after every post queued before it
   * has settled. Never rejects, so the chain link is always handled.
   */
  push(post: () => Promise<void>): void {
    this.#tail = this.#tail.then(async () => {
      try {
        await post();
      } catch (e) {
        this.#failures += 1;
        if (this.#firstError === undefined) this.#firstError = e;
        this.#log(`post failed: ${errorText(e)}`);
      }
    });
  }

  /**
   * Wait until every queued post has settled. Always resolves — failures are
   * reported through {@link failureCount} / {@link firstError}, not thrown.
   */
  async drain(): Promise<void> {
    await this.#tail;
  }

  /** Number of posts that failed since construction. */
  failureCount(): number {
    return this.#failures;
  }

  /** The first failure, or undefined when nothing failed. */
  firstError(): unknown {
    return this.#firstError;
  }
}
