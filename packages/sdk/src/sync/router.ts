/**
 * Frame-to-cache router.
 *
 * Subscribes to a {@link SyncConnection}'s frame stream and dispatches each
 * decoded frame into the supplied {@link CacheAdapter}:
 *
 *  - `#invalidate` → `adapter.invalidate(queryKey(nsid, params))`
 *  - `#messageDiff` → `adapter.patch(queryKey(GET_MESSAGES_NSID, { roomId }),
 *                                    prev => applyMessageDiff(prev, ops))`
 *
 * Per Slice 6, the per-frame dispatch is hardcoded rather than registered
 * through a pluggable table — we only have one diffable surface today.
 * `applyMessageDiff` tolerates `undefined` prev (commit `749992c1`).
 */
import { type } from "arktype";
import { Body as InvalidateBody } from "../schemas/frames/invalidate";
import { Body as MessageDiffBody } from "../schemas/frames/messageDiff";
import { Body as RoomMetadataDiffBody } from "../schemas/frames/roomMetadataDiff";
import type { CacheAdapter } from "../cache/adapter";
import { queryKey } from "../cache/query-key";
import { applyMessageDiff, type Message } from "./diff";
import {
  patchRoomMetadata,
  patchSpaces,
  patchSpaceMetadata,
  type RoomMetadataResponse,
  type GetSpacesResponse,
  type SpaceMetadataResponse,
} from "./roomMetadataDiff";
import type { SyncConnection, SyncFrame, Unsubscribe } from "./connection";

const GET_MESSAGES_NSID = "space.roomy.room.getMessages" as const;
const ROOM_METADATA_NSID = "space.roomy.room.getMetadata" as const;
const GET_SPACES_NSID = "space.roomy.space.getSpaces" as const;
const SPACE_METADATA_NSID = "space.roomy.space.getMetadata" as const;

export interface SyncRouterOptions {
  /**
   * Called when a frame fails arktype validation. Defaults to a no-op so
   * the router never throws into the WS message handler. Consumers
   * (especially during dev) typically pass a `console.warn`-like callback.
   */
  onValidationError?: (info: {
    frameType: string;
    summary: string;
    raw: Record<string, unknown>;
  }) => void;
  /** Called for frames whose `header.t` we don't know how to route. */
  onUnknownFrame?: (frame: SyncFrame) => void;
}

export class SyncRouter {
  readonly #connection: SyncConnection;
  readonly #adapter: CacheAdapter;
  readonly #opts: SyncRouterOptions;
  #unsubscribe: Unsubscribe | null = null;

  constructor(
    connection: SyncConnection,
    adapter: CacheAdapter,
    opts: SyncRouterOptions = {},
  ) {
    this.#connection = connection;
    this.#adapter = adapter;
    this.#opts = opts;
  }

  /** Begin routing frames. Returns the unsubscribe handle (also storable via `stop()`). */
  start(): Unsubscribe {
    if (this.#unsubscribe) return this.#unsubscribe;
    const unsub = this.#connection.onFrame((frame) => this.#route(frame));
    this.#unsubscribe = () => {
      unsub();
      this.#unsubscribe = null;
    };
    return this.#unsubscribe;
  }

  /** Stop routing. Idempotent. */
  stop(): void {
    this.#unsubscribe?.();
  }

  #route(frame: SyncFrame): void {
    const t = frame.header["t"];
    if (typeof t !== "string") {
      this.#opts.onUnknownFrame?.(frame);
      return;
    }

    if (t === "#invalidate") {
      const parsed = InvalidateBody(frame.body);
      if (parsed instanceof type.errors) {
        this.#opts.onValidationError?.({
          frameType: t,
          summary: parsed.summary,
          raw: frame.body,
        });
        return;
      }
      this.#adapter.invalidate(queryKey(parsed.nsid, parsed.params));
      return;
    }

    if (t === "#messageDiff") {
      const parsed = MessageDiffBody(frame.body);
      if (parsed instanceof type.errors) {
        this.#opts.onValidationError?.({
          frameType: t,
          summary: parsed.summary,
          raw: frame.body,
        });
        return;
      }
      this.#adapter.patch<Message[]>(
        queryKey(GET_MESSAGES_NSID, { roomId: parsed.roomId }),
        (prev) => applyMessageDiff(prev, parsed.ops),
      );
      return;
    }

    if (t === "#roomMetadataDiff") {
      const parsed = RoomMetadataDiffBody(frame.body);
      if (parsed instanceof type.errors) {
        this.#opts.onValidationError?.({
          frameType: t,
          summary: parsed.summary,
          raw: frame.body,
        });
        return;
      }
      // Patch three cache entries from the one frame. Each patcher returns
      // undefined when its cache entry is absent or the target isn't found —
      // a no-op (`setQueryData` treats undefined as "don't write").
      this.#adapter.patch<RoomMetadataResponse>(
        queryKey(ROOM_METADATA_NSID, { roomId: parsed.roomId }),
        (prev) => patchRoomMetadata(prev, parsed.delta),
      );
      this.#adapter.patch<GetSpacesResponse>(
        queryKey(GET_SPACES_NSID),
        (prev) => patchSpaces(prev, parsed.spaceId, parsed.delta),
      );
      this.#adapter.patch<SpaceMetadataResponse>(
        queryKey(SPACE_METADATA_NSID, { spaceId: parsed.spaceId }),
        (prev) => patchSpaceMetadata(prev, parsed.roomId, parsed.delta),
      );
      return;
    }

    this.#opts.onUnknownFrame?.(frame);
  }
}
