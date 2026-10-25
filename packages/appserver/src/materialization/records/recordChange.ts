/**
 * `RecordChange` — the materialiser's input type, and the one adapter that
 * produces it from the event log.
 *
 * `docs/plans/replicable-space-workers.md` §5 WS3 makes this the seam between
 * `stream_events` (still the source of truth) and the per-space projection. A
 * Rust worker is written against `RecordChange`, so the shape here is the shape
 * that survives the protocol migration; only the producer changes then.
 *
 * Three properties the type enforces rather than documents:
 *
 *  - **`op` decides the body.** `create` carries the whole record, `update`
 *    carries a patch, `delete` carries no body — three object shapes in one
 *    union, so a `delete` with a `record` is a type error rather than a record
 *    a consumer has to remember to ignore.
 *  - **A kind with no update cannot be updated.** `PatchBody<K>` is `never` for
 *    `reaction`, `ban`, `invite` and `roleGrant`, so `updated()` cannot be
 *    called for one and `ChangeOf<K>` has no `update` member.
 *  - **`collection` follows `kind`.** Each kind's NSID is a literal type, so
 *    `kind === "room"` narrows `collection` to the room collection and a
 *    mismatched pair cannot be constructed.
 *
 * `repo`, `rkey` and `orderStamp` are branded. `rkey` is validated against
 * ATProto's record-key syntax, and `orderStamp` is built only by the function
 * that lifts the log's ordering key — a stamp cannot be invented at a callsite
 * and quietly reorder a room.
 */

import { type Did, type Event, type StreamIndex } from "@roomy-space/sdk";

import { decodeTime } from "ulidx";
import { messageSortIdxKey } from "../sortIdx.ts";
import {
  RECORD_KINDS,
  type FullBody,
  type Nsid,
  type PatchBody,
  type RecordKind,
} from "./recordKinds.ts";

/**
 * A record key: a record's identity within its collection. ATProto record-key
 * syntax — no `/`, no `..`, at most 512 characters.
 */
export type Rkey = string & { readonly __brand: "rkey" };

const RKEY_PATTERN = /^[A-Za-z0-9._~:-]{1,512}$/;

/**
 * The key of a singleton record — one per repo, e.g. a space's sidebar.
 * `literal:self` is the ATProto convention, and what
 * `space.roomy.user.profile` already uses.
 */
export const SINGLETON_RKEY = "self" as Rkey;

/**
 * A composite key: the parts, validated, joined in the order given.
 *
 * Joined with `~` rather than `/` (which ATProto record keys forbid) or `:`
 * (which every DID contains, so a `<user>:<role>` key would not be decodable).
 * `~` is in the record-key alphabet and appears in no DID or ULID, so a part
 * can always be recovered.
 */
export function rkey(...parts: string[]): Rkey {
  const key = parts.join("~");
  if (!RKEY_PATTERN.test(key) || key === "." || key === "..") {
    throw new Error(`Not a valid record key: ${JSON.stringify(key)}`);
  }
  return key as Rkey;
}

/**
 * The ordering stamp: opaque and sortable, assigned once at ingest and never
 * re-derived. Two changes compare by it and nothing may parse it — the internal
 * and protocol producers encode it differently and agree only on the ordering it
 * induces (plan §5 WS3 step 2).
 */
export type OrderStamp = string & { readonly __brand: "orderStamp" };

/** A stamp is the log's 26-character key: 10 of ordering time, 16 of position. */
const STAMP_LENGTH = 26;

/**
 * Wrap an ordering key `sortIdx.ts` produced. Not exported: the stamp has one
 * producer, {@link toRecordChanges}, so a callsite cannot mint one.
 */
function orderStamp(key: string): OrderStamp {
  if (key.length !== STAMP_LENGTH) {
    throw new Error(`Ordering key must be ${STAMP_LENGTH} characters: ${key}`);
  }
  return key as OrderStamp;
}

/** The fields every change carries, whatever its op. */
interface ChangeBase<K extends RecordKind> {
  readonly kind: K;
  /** The repo that owns the record — derived, never the log's stream DID. */
  readonly repo: Did;
  /** The record's collection, at the same kind `kind` narrows to. */
  readonly collection: Nsid<K>;
  readonly rkey: Rkey;
  /** Assigned at ingest; sorts the log and nothing else. */
  readonly orderStamp: OrderStamp;
}

/**
 * The three ops. `create` and `update` are both upserts to the projection
 * (plan §3: "projection rules are set-like"); they are distinguished by what
 * the body contains, which is what the adapter can observe.
 */
export interface RecordCreate<K extends RecordKind> extends ChangeBase<K> {
  readonly op: "create";
  readonly record: FullBody<K>;
}

export interface RecordUpdate<K extends RecordKind> extends ChangeBase<K> {
  readonly op: "update";
  readonly record: PatchBody<K>;
}

export interface RecordDelete<K extends RecordKind> extends ChangeBase<K> {
  readonly op: "delete";
}

/**
 * The changes one kind can carry. `update` is absent for a kind whose
 * `PatchBody` is `never`, because there is no body to give it.
 *
 * `delete` is present for every kind at the type level; which kinds the log
 * ever deletes is a property of the event mapping, stated per kind in
 * `toRecordChanges.ts`. Rooms and the singletons are never deleted there.
 */
export type ChangeOf<K extends RecordKind> =
  | RecordCreate<K>
  | ([PatchBody<K>] extends [never] ? never : RecordUpdate<K>)
  | RecordDelete<K>;

/** Any change, discriminated on `kind` and then on `op`. */
export type RecordChange = { [K in RecordKind]: ChangeOf<K> }[RecordKind];

/**
 * The base of a change. The caller passes the repo and key its kind's key rule
 * derives; the collection and the stamp come from the kind and log entry.
 */
export function changeBase<K extends RecordKind>(
  kind: K,
  repo: Did,
  key: Rkey,
  stamp: OrderStamp,
): ChangeBase<K> {
  return {
    kind,
    repo,
    collection: RECORD_KINDS[kind].collection as Nsid<K>,
    rkey: key,
    orderStamp: stamp,
  };
}

/** `op: create` — the change carries the whole record. */
export function created<K extends RecordKind>(
  kind: K,
  repo: Did,
  key: Rkey,
  stamp: OrderStamp,
  record: FullBody<K>,
): RecordCreate<K> {
  return { ...changeBase(kind, repo, key, stamp), op: "create", record };
}

/**
 * `op: update` — the change carries a patch. Cannot be called for a kind whose
 * patch type is `never`, because there is no value to pass.
 */
export function updated<K extends RecordKind>(
  kind: K,
  repo: Did,
  key: Rkey,
  stamp: OrderStamp,
  record: PatchBody<K>,
): RecordUpdate<K> {
  return { ...changeBase(kind, repo, key, stamp), op: "update", record };
}

/** `op: delete` — removal from the set. */
export function deleted<K extends RecordKind>(
  kind: K,
  repo: Did,
  key: Rkey,
  stamp: OrderStamp,
): RecordDelete<K> {
  return { ...changeBase(kind, repo, key, stamp), op: "delete" };
}

/**
 * Build an {@link OrderStamp} from the log's ordering key.
 *
 * `sortIdx.ts` owns the key rule — ordering time (`received_at`, or a
 * `timestampOverride` on a bridged message) plus log position — so this takes
 * the same inputs that rule takes rather than encoding a second one. That is
 * what makes the stamp equal to the `entities.sort_idx` the materialiser
 * writes, which is the property that lets a worker sort by the stamp without
 * consulting the log again.
 */
export function stampFor(
  event: Event,
  idx: StreamIndex | number,
  receivedAt?: number,
  createdAt?: number,
): OrderStamp {
  return orderStamp(messageSortIdxKey(event, idx, receivedAt, createdAt));
}

/**
 * The instant the log assigns an entry, in epoch milliseconds: the time half of
 * the ordering stamp it carries.
 *
 * An entry the adapter cannot describe — its id is not a ULID, so no stamp can
 * be derived for it — falls back to the log's own receipt time, which is the
 * instant the log did assign. Deterministic either way: a replay reads the same
 * values from the same rows.
 */
export function decidedAtFor(
  event: Event,
  idx: StreamIndex | number,
  receivedAt?: number,
  createdAt?: number,
): number {
  try {
    return decodeTime(stampFor(event, idx, receivedAt, createdAt) as never);
  } catch {
    return createdAt ?? receivedAt ?? 0;
  }
}
