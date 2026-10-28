/**
 * The bookkeeping behind a retained set of tile frames.
 *
 * `./tile-host.ts` keeps a mounted frame alive after its placeholder leaves the
 * page, so scrolling back draws the same frame instead of loading a new one.
 * Kept frames are memory, and an unbounded set of them is a leak that only
 * shows up in a long session, so the retention rules live here — away from the
 * DOM — and the host only has to say which frame it wants and when the frame
 * was last on screen.
 *
 * A key is a rendered tile's identity (`tileRenderKey`: the record plus the
 * payload it is handed). Two placeholders may carry the same key at once — the
 * same post linked in two messages — so several hosts share one key; `acquire`
 * prefers an idle one and only creates when every host for that key is busy.
 *
 * Nothing here touches `window`;
 *
 * - a host is created by the caller's factory, and disposed by the caller's
 *   `dispose` when it is dropped, so this module never needs to know what a
 *   frame is;
 * - time comes from an injectable clock, so eviction is testable.
 */

/** One retained host, and what the pool knows about its use. */
export interface TilePoolSlot<H> {
  /** The rendered tile's identity: record plus payload. */
  readonly key: string;
  /** The caller's frame handle. */
  readonly host: H;
  /** A placeholder is drawing this host; only idle slots are reusable. */
  busy: boolean;
  /** When the host was last on screen, or last went idle. */
  lastVisible: number;
}

export interface TilePoolConfig<H> {
  /**
   * Retained hosts before idle ones are dropped to make room. A soft ceiling:
   * hosts that are all being drawn cannot be evicted, so a page with more
   * visible tiles than this keeps them rather than blanking one.
   */
  limit: number;
  /** How long an idle host is kept before it is dropped. */
  idleLimitMs: number;
  /** Release a host's resources; called once, when the pool drops it. */
  dispose: (host: H) => void;
  /** Clock, for tests. */
  now?: () => number;
}

export class TilePool<H> {
  readonly #config: TilePoolConfig<H>;
  readonly #slots: TilePoolSlot<H>[] = [];
  readonly #now: () => number;

  constructor(config: TilePoolConfig<H>) {
    this.#config = config;
    this.#now = config.now ?? Date.now;
  }

  /** Every retained slot, in creation order — what the host repaints. */
  get slots(): readonly TilePoolSlot<H>[] {
    return this.#slots;
  }

  get size(): number {
    return this.#slots.length;
  }

  /**
   * A host for `key`, idle if one is retained and otherwise built by
   * `create`. The returned slot is busy until it is released.
   */
  acquire(key: string, create: (key: string) => H): TilePoolSlot<H> {
    const now = this.#now();
    this.sweep(now);

    const reused = this.#slots.find((slot) => slot.key === key && !slot.busy);
    if (reused) {
      reused.busy = true;
      reused.lastVisible = now;
      return reused;
    }

    this.#makeRoom();
    const slot: TilePoolSlot<H> = {
      key,
      host: create(key),
      busy: true,
      lastVisible: now,
    };
    this.#slots.push(slot);
    return slot;
  }

  /** The placeholder drawing `slot` has gone; the host is retained, idle. */
  release(slot: TilePoolSlot<H>): void {
    slot.busy = false;
    slot.lastVisible = this.#now();
  }

  /** The host was just on screen; it is the least likely to be evicted. */
  touch(slot: TilePoolSlot<H>): void {
    slot.lastVisible = this.#now();
  }

  /** Drop idle hosts whose retention has run out. */
  sweep(now = this.#now()): void {
    for (const slot of [...this.#slots]) {
      if (slot.busy) continue;
      if (now - slot.lastVisible < this.#config.idleLimitMs) continue;
      this.#evict(slot);
    }
  }

  /** Leave room for one more host by dropping the oldest idle one. */
  #makeRoom(): void {
    while (this.#slots.length >= this.#config.limit) {
      let oldest: TilePoolSlot<H> | undefined;
      for (const slot of this.#slots) {
        if (slot.busy) continue;
        if (!oldest || slot.lastVisible < oldest.lastVisible) oldest = slot;
      }
      // Every retained host is being drawn: keeping them all is the only
      // option that does not blank a tile the reader can see.
      if (!oldest) return;
      this.#evict(oldest);
    }
  }

  #evict(slot: TilePoolSlot<H>): void {
    const at = this.#slots.indexOf(slot);
    if (at === -1) return;
    this.#slots.splice(at, 1);
    this.#config.dispose(slot.host);
  }
}
