/**
 * Refcounted topic subscription manager.
 *
 * Multiple query factories may declare the same topic. We only want one
 * `sub` frame to hit the wire per topic, regardless of how many consumers
 * are watching it. The manager tracks a refcount per topic and emits
 * `subscribe`/`unsubscribe` to the underlying {@link SyncConnection} only
 * on 0→1 and 1→0 transitions.
 */
import type { SyncConnection, Topic, Unsubscribe } from "./connection";

const KEY = (t: Topic) => `${t.kind}:${t.id}`;

export class TopicManager {
  readonly #connection: SyncConnection;
  readonly #refcounts = new Map<string, number>();

  constructor(connection: SyncConnection) {
    this.#connection = connection;
  }

  /**
   * Acquire a subscription handle for `topic`. The first call sends `sub`
   * over the connection; subsequent calls just bump the refcount. The
   * returned disposer releases this hold; the topic is unsubscribed once
   * the last hold is released. Disposers are idempotent — calling twice
   * is a no-op the second time.
   */
  acquire(topic: Topic): Unsubscribe {
    const key = KEY(topic);
    const prev = this.#refcounts.get(key) ?? 0;
    this.#refcounts.set(key, prev + 1);
    if (prev === 0) {
      this.#connection.subscribe(topic);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const cur = this.#refcounts.get(key) ?? 0;
      if (cur <= 1) {
        this.#refcounts.delete(key);
        this.#connection.unsubscribe(topic);
      } else {
        this.#refcounts.set(key, cur - 1);
      }
    };
  }

  /** Diagnostic accessor — current refcount for a topic. */
  refcount(topic: Topic): number {
    return this.#refcounts.get(KEY(topic)) ?? 0;
  }
}
