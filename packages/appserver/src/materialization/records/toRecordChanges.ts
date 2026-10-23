/**
 * The event log → `RecordChange[]` adapter.
 *
 * `docs/plans/replicable-space-workers.md` §5 WS3: 47 event types collapse onto
 * 16 record kinds, and this is where that collapse happens. A kind in
 * {@link CONVERTED_KINDS} is applied by the projection rules; every other kind
 * still runs its SDK materialiser, so both descriptions of the log live in this
 * tree and the tests are what keep them equal.
 *
 * Four rules the plan fixes, and this module is only correct with all four:
 *
 *  - **`repo` is derived, not copied.** The internal log is per-space
 *    (`sendEvents` asserts `streamDid = spaceId`), but the protocol log is
 *    per-repo. So the repo comes from what the event says: the author DID for
 *    member content, the space DID for collective records.
 *  - **`orderStamp` is lifted, not re-derived.** Every change from one log entry
 *    carries the key `sortIdx.ts` derived for that entry, so it equals the
 *    `entities.sort_idx` the materialiser wrote. One entry can emit several
 *    changes and they share a stamp; a worker applies them in emission order.
 *  - **Each change is keyed by its own record.** `createRoomLink` emits a room
 *    update keyed by `linkToRoom` and a message create keyed by the event's own
 *    id, and those are two different rooms. Keying either by the event's `room`
 *    would be wrong for both.
 *  - **Four event types produce no record**, by decision: see
 *    {@link NO_RECORD_EVENT_TYPES}.
 *
 * ## `create` vs `update`
 *
 * The plan's mapping table names some kinds as created *and* updated by the same
 * event (`addAdmin` → `membership`, `setRoleRoomPermission` →
 * `roomPermission`). The adapter is stateless — it sees one log entry — so it
 * cannot tell whether the record already exists. Those write `update`, and the
 * projection's rules are set-like upserts (plan §3), so an update to a record
 * that is not there creates it. Choosing per-event would need state the adapter
 * deliberately does not have.
 *
 * ## Writes over another author's record
 *
 * `editMessage`, `deleteMessage` and `moveMessages` each write a message record
 * whose author the event does not name. `editMessage`/`deleteMessage` are
 * authorized as author-**or**-admin, and a move is admin-only, so the acting DID
 * is not necessarily the record's owner. The adapter emits those with the
 * **space** as `repo`: the interim shape the plan records at Q9 for
 * `moveMessages`, applied to the two edits for the same reason. An action by an
 * admin over another author's content cannot live in that author's repo, and the
 * protocol model has no place for it yet. Stage 3 settles where curator actions
 * live; until then this is what the projection does.
 */

import {
  type Did,
  type Event,
  type EventType,
  type RoomKind,
  type StreamDid,
  type UserDid,
} from "@roomy-space/sdk";
import { fromBytes } from "@atcute/cbor";
import { decodeTime } from "ulidx";

import type { LoggedEvent } from "../types.ts";
import { log } from "../../log.ts";
import type { RecordKind, SidebarCategory } from "./recordKinds.ts";
import {
  type OrderStamp,
  type RecordChange,
  SINGLETON_RKEY,
  created,
  deleted,
  rkey,
  stampFor,
  updated,
} from "./recordChange.ts";

/**
 * A content block's bytes. `fromBytes` accepts the CBOR `{ $bytes }` form; a
 * decoded log entry carries the raw `{ buf }` wrapper, which is what this
 * unpacks before handing the value to CBOR.
 */
function bodyBytes(data: unknown): Uint8Array {
  if (data !== null && typeof data === "object" && "buf" in data) {
    const buf = data.buf;
    if (buf instanceof Uint8Array) return buf;
  }
  return fromBytes(data as never);
}

/** The extension key a bridged message uses to name the real author. */
const AUTHOR_OVERRIDE = "space.roomy.extension.authorOverride.v0";

/** The extension key the Discord bridge sets a user's handle under. */
const DISCORD_USER_ORIGIN = "space.roomy.extension.discordUserOrigin.v0";

/**
 * Every event type and the record kinds it produces, in emission order. Empty
 * for the four types that produce no record.
 *
 * `Record<EventType, …>` makes this exhaustive at compile time: an event type
 * added to the SDK without an entry here fails the build. The test compares it
 * against what {@link toRecordChanges} actually emits, so the table cannot drift
 * from the switch either.
 */
export const RECORD_KINDS_FOR_EVENT: Record<EventType, readonly RecordKind[]> = {
  "space.roomy.message.createMessage.v0": ["message"],
  "space.roomy.message.editMessage.v0": ["message"],
  "space.roomy.message.deleteMessage.v0": ["message"],
  "space.roomy.message.moveMessages.v0": ["message"],
  "space.roomy.message.reorderMessage.v0": [],
  "space.roomy.message.forwardMessages.v0": ["message"],
  "space.roomy.room.createRoom.v0": ["room"],
  "space.roomy.room.updateRoom.v0": ["room"],
  "space.roomy.room.deleteRoom.v0": ["room"],
  "space.roomy.room.restoreRoom.v0": ["room"],
  "space.roomy.reaction.addReaction.v0": ["reaction"],
  "space.roomy.reaction.removeReaction.v0": ["reaction"],
  "space.roomy.reaction.addBridgedReaction.v0": ["reaction"],
  "space.roomy.reaction.removeBridgedReaction.v0": ["reaction"],
  "space.roomy.space.joinSpace.v0": ["membership"],
  "space.roomy.space.leaveSpace.v0": ["membership"],
  "space.roomy.space.updateSpaceInfo.v0": ["spaceInfo"],
  "space.roomy.space.updateSidebar.v0": ["spaceSidebar"],
  "space.roomy.space.updateSidebar.v1": ["spaceSidebar"],
  "space.roomy.space.addAdmin.v0": ["membership"],
  "space.roomy.space.removeAdmin.v0": ["membership"],
  "space.roomy.space.setHandleProvider.v0": [],
  "space.roomy.page.editPage.v0": [],
  "space.roomy.user.updateProfile.v0": ["profile"],
  "space.roomy.link.createRoomLink.v0": ["room", "message"],
  "space.roomy.link.removeRoomLink.v0": ["room"],
  "space.roomy.openmeet.configure.v0": ["calendarLink"],
  "space.roomy.state.markRead.v0": [],
  "space.roomy.space.banAccount.v0": ["ban"],
  "space.roomy.space.unbanAccount.v0": ["ban"],
  "space.roomy.space.createInvite.v0": ["invite"],
  "space.roomy.space.revokeInvite.v0": ["invite"],
  "space.roomy.role.createRole.v0": ["role"],
  "space.roomy.role.deleteRole.v0": ["role"],
  "space.roomy.role.updateRole.v0": ["role"],
  "space.roomy.role.addMemberRole.v0": ["roleGrant"],
  "space.roomy.role.removeMemberRole.v0": ["roleGrant"],
  "space.roomy.role.setRoleRoomPermission.v0": ["roomPermission"],
  "space.roomy.federation.request.v0": ["federationRequest"],
  "space.roomy.federation.respond.v0": ["federationRequest"],
  "space.roomy.federation.remove.v0": ["federationRequest", "federationGrant"],
  "space.roomy.federation.setRoomPermission.v0": ["federationGrant"],
  "space.roomy.federation.setReceiverPermission.v0": ["federationGrant"],
  "space.roomy.voice.callStarted.v0": ["voiceCall"],
  "space.roomy.voice.callJoined.v0": ["voiceCall"],
  "space.roomy.voice.callLeft.v0": ["voiceCall"],
  "space.roomy.voice.callEnded.v0": ["voiceCall"],
};

/**
 * The record kinds the worker applies through the projection rules instead of
 * the event materialisers. A kind joins this set once its rules cover every op
 * the log produces for it.
 */
export const CONVERTED_KINDS: ReadonlySet<RecordKind> = new Set<RecordKind>([
  "message",
  "reaction",
  "room",
  "spaceInfo",
  "spaceSidebar",
  "membership",
  "ban",
  "invite",
  "role",
  "roleGrant",
  "roomPermission",
  "federationRequest",
  "federationGrant",
]);

/** The set the record path routes by; `_withEventPath` swaps it for a test. */
let routedKinds: ReadonlySet<RecordKind> = CONVERTED_KINDS;

/**
 * The changes `logged` produces when it is applied as a record, or `null` when
 * it stays on the event path.
 *
 * The decision is "every emitted kind is converted", not "the event mentions a
 * converted kind". An event that also emits an unconverted kind keeps its whole
 * change set on the event path: `createRoomLink` writes a `room` and a
 * `message`, so routing it by the message alone would apply that message twice
 * — once by the rule, once by the materialiser. A kind converts by joining
 * {@link CONVERTED_KINDS}, and an event straddling two kinds converts when the
 * last of them does.
 *
 * An event that emits nothing has nothing to convert, so it stays on the event
 * path: `reorderMessage` maps to no record and its materialiser still rewrites
 * `sort_idx` from its neighbours.
 *
 * {@link RECORD_KINDS_FOR_EVENT} answers first, so the adapter runs only for an
 * event that could convert: deriving a change stamps it, which no other event
 * needs. Its answer is then what the rules act on, and the adapter's own kinds
 * must agree with the table — the table is tested against them.
 *
 * An entry the adapter cannot describe — a log row whose id is not the ULID
 * its kind requires, say — is left to the event path rather than thrown from
 * here: `materialize` catches a materialiser failure and records it, so one
 * unreadable row costs its own event and not the rest of the batch.
 */
export function convertedChanges(
  logged: LoggedEvent,
  streamId: StreamDid,
): RecordChange[] | null {
  // The declared mapping answers whether the adapter needs to run at all: an
  // event with no record, or with an unconverted kind among its own, will not
  // use the changes, and deriving them stamps every one of them.
  const declared = RECORD_KINDS_FOR_EVENT[logged.event.$type] as
    | readonly RecordKind[]
    | undefined;
  if (declared === undefined || declared.length === 0) return null;
  if (!declared.every((kind) => routedKinds.has(kind))) return null;

  let changes: RecordChange[];
  try {
    changes = toRecordChanges(logged, streamId);
  } catch (err) {
    // The materialiser reports this event's failure where the batch can count
    // it, which is what keeps one bad row from failing the whole batch.
    log.warn(
      `[materialize] no record for event ${logged.event.id} (${logged.event.$type}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  return changes.every((change) => routedKinds.has(change.kind))
    ? changes
    : null;
}

/**
 * Run `run` with every kind on the event path, so a test can derive one log
 * through the event materialisers and compare the two projections. Test support
 * only; no production caller.
 */
export async function _withEventPath<T>(run: () => Promise<T>): Promise<T> {
  const outer = routedKinds;
  routedKinds = new Set<RecordKind>();
  try {
    return await run();
  } finally {
    routedKinds = outer;
  }
}

/**
 * Event types that map to no record, each for its own reason. A type absent from
 * {@link RECORD_KINDS_FOR_EVENT}'s non-empty entries must be here, and this map
 * must not name anything that does emit a record.
 */
export const NO_RECORD_EVENT_TYPES: Readonly<Record<string, string>> = {
  /** Retired: space handles are DID- and DNS-derived. Writes a column with no readers. */
  "space.roomy.space.setHandleProvider.v0":
    "retired — space handles are DID- and DNS-derived",
  /** Pages are unsupported by the client and nothing reads `comp_page_edits`. */
  "space.roomy.page.editPage.v0": "retired — no client support, no reader",
  /**
   * The one event whose key is derived from its neighbours: the materialiser
   * takes a midpoint between `after` and the key that sorts next. A record would
   * have to carry the resulting key for a worker to reproduce it, and no
   * producer emits a reorder (`spaceMigrations.ts` forces a full rebuild for a
   * space whose log holds one), so it stays out of the record model.
   */
  "space.roomy.message.reorderMessage.v0":
    "key is derived from neighbours; no producer emits one",
  /** Rejected at the write path; read receipts stay gateway-side. */
  "space.roomy.state.markRead.v0": "rejected at the write path",
};

/**
 * Synthetic event types. They have no live producer and are absent from
 * `eventRegistry`; named here so the record model says explicitly that an event
 * which is neither a record nor a log entry has no representation.
 */
export const NO_RECORD_SYNTHETIC_EVENT_TYPES = [
  "space.roomy.query.spaceMeta.v0",
  "space.roomy.query.profile.v0",
] as const;

/**
 * The DID a message's author edge points at: the override when a bridge set one,
 * otherwise the sender. This is the message record's `repo` too — the projection
 * attributes a bridged message to the overridden author, so that is whose
 * content it is.
 */
function messageAuthor(event: Event, actor: UserDid): Did {
  if (event.$type !== "space.roomy.message.createMessage.v0") return actor;
  const override = event.extensions?.[AUTHOR_OVERRIDE]?.did;
  return override ?? actor;
}

/**
 * The handle a bridged profile carries, if any. `updateProfile` types its
 * extensions as open (`Record<string, unknown>`), so the one field read out of
 * them is narrowed here rather than asserted.
 */
function discordHandle(event: Event): string | undefined {
  if (event.$type !== "space.roomy.user.updateProfile.v0") return undefined;
  const origin = event.extensions?.[DISCORD_USER_ORIGIN];
  if (origin === null || typeof origin !== "object" || !("handle" in origin)) {
    return undefined;
  }
  return typeof origin.handle === "string" ? origin.handle : undefined;
}

/** A category list, with `id` present only when the event sent one. */
function sidebarCategories(
  categories: ReadonlyArray<{ id?: string; name: string; children: string[] }>,
): SidebarCategory[] {
  return categories.map((c) =>
    c.id === undefined
      ? { name: c.name, children: c.children }
      : { id: c.id, name: c.name, children: c.children },
  );
}

/**
 * Every record change one log entry produces. Empty for the four event types in
 * {@link NO_RECORD_EVENT_TYPES}; two changes for `createRoomLink` and for
 * `federation.remove`.
 *
 * `streamId` is the space the log belongs to. It is the space DID for every
 * collective record, and it is the author of the link system message the
 * projection attributes to the stream.
 */
export function toRecordChanges(
  logged: LoggedEvent,
  streamId: StreamDid,
): RecordChange[] {
  const { event, idx, user, receivedAt, createdAt } = logged;
  const space = streamId as Did;
  const actor = user as Did;
  // The same inputs `applyBatch` gives `messageSortIdxKey`, so the stamp equals
  // the `entities.sort_idx` that write produced.
  const stamp: OrderStamp = stampFor(event, idx, receivedAt, createdAt);

  switch (event.$type) {
    // ── message ──────────────────────────────────────────────────────────
    case "space.roomy.message.createMessage.v0": {
      const author = messageAuthor(event, user);
      return [
        created("message", author, rkey(event.id), stamp, {
          room: event.room,
          author,
          content: {
            mimeType: event.body.mimeType,
            data: bodyBytes(event.body.data),
          },
          extensions: event.extensions,
        }),
      ];
    }

    // `editMessage`/`deleteMessage`/`moveMessages` write a message whose author
    // the event does not name, and they are authorized as author-or-admin (or
    // admin-only, for a move). The space is the repo, per Q9.
    case "space.roomy.message.editMessage.v0":
      return [
        updated("message", space, rkey(event.messageId), stamp, {
          content: {
            mimeType: event.body.mimeType,
            data: bodyBytes(event.body.data),
          },
          // Present means "replace with this set" (an empty list removes all);
          // absent means "leave the attachments alone", so the map is passed
          // through rather than defaulted.
          ...(event.extensions === undefined
            ? {}
            : { extensions: event.extensions }),
        }),
      ];

    case "space.roomy.message.deleteMessage.v0":
      return [deleted("message", space, rkey(event.messageId), stamp)];

    case "space.roomy.message.moveMessages.v0":
      return event.messageIds.map((messageId) =>
        updated("message", space, rkey(messageId), stamp, {
          room: event.toRoomId,
        }),
      );

    case "space.roomy.message.forwardMessages.v0":
      // The projection makes the forward reference its own entity in the
      // destination room — no content, no author edge — and `selectMessages`
      // reaches it through the forward edge. The record carries that fact; the
      // forwarder is the repo because the forward is content they created.
      return [
        created("message", actor, rkey(event.id), stamp, {
          room: event.room,
          author: actor,
          forwardOf: event.messageIds,
        }),
      ];

    // ── room ─────────────────────────────────────────────────────────────
    case "space.roomy.room.createRoom.v0": {
      const discordOrigin =
        event.extensions?.["space.roomy.extension.discordOrigin.v0"];
      return [
        created("room", space, rkey(event.id), stamp, {
          kind: event.kind as RoomKind,
          name: event.name || null,
          avatar: event.avatar || null,
          description: event.description || null,
          // A thread takes its access from its parent, so it carries none.
          defaultAccess:
            event.kind === "space.roomy.thread"
              ? null
              : (event.defaultAccess ?? "readwrite"),
          deleted: false,
          parent: null,
          ...(discordOrigin
            ? {
                discordOrigin: {
                  snowflake: discordOrigin.snowflake,
                  guildId: discordOrigin.guildId,
                },
              }
            : {}),
        }),
      ];
    }

    case "space.roomy.room.updateRoom.v0":
      return [
        updated("room", space, rkey(event.roomId), stamp, {
          ...(event.kind === undefined || event.kind === null
            ? {}
            : { kind: event.kind }),
          // The projection writes `readwrite` for an explicit null, so the
          // record carries the value the projection ends up with.
          ...(event.defaultAccess === undefined
            ? {}
            : { defaultAccess: event.defaultAccess ?? "readwrite" }),
          ...(event.name === undefined ? {} : { name: event.name }),
          ...(event.avatar === undefined ? {} : { avatar: event.avatar }),
          ...(event.description === undefined
            ? {}
            : { description: event.description }),
        }),
      ];

    // A soft delete: the record stays in the set carrying `deleted`, which is
    // what `getMetadata`'s `deletedRooms` list and the restore modal read.
    // `op: delete` is never used for a room.
    case "space.roomy.room.deleteRoom.v0":
      return [
        updated("room", space, rkey(event.roomId), stamp, { deleted: true }),
      ];

    case "space.roomy.room.restoreRoom.v0":
      return [
        updated("room", space, rkey(event.roomId), stamp, { deleted: false }),
      ];

    // ── room link: a `parent` on the linked room, plus the system message ──
    case "space.roomy.link.createRoomLink.v0":
      return [
        updated("room", space, rkey(event.linkToRoom), stamp, {
          parent: event.room,
        }),
        // The system message is real content: the projection writes an entity,
        // a `comp_content` row, and an author edge pointing at the *space*. Its
        // text names the acting DID as a mention, so the record carries `actor`
        // explicitly — recovering it from the markdown is not an option, and the
        // space DID cannot stand in for it. The text also interpolates the
        // linked room's name, which is projection state, hence a structured
        // `system` body for the rule to render rather than a stored string.
        //
        // Single-parent: this event carries exactly one `linkToRoom`, and the
        // adapter holds no state, so a *second* link is not observable here —
        // only the projection can see that one already exists. The assertion
        // therefore belongs in the projection rule (S2/S3), which does hold
        // state; here it would only fire on a malformed event.
        created("message", space, rkey(event.id), stamp, {
          room: event.room,
          author: space,
          actor,
          system: {
            kind: "roomLink",
            linkToRoom: event.linkToRoom,
            isCreationLink: event.isCreationLink === true,
          },
        }),
      ];

    case "space.roomy.link.removeRoomLink.v0":
      // No system message is written for an unlink, and the projection deletes
      // the `link` edge outright, so the linked room's `parent` is cleared.
      return [
        updated("room", space, rkey(event.linkToRoom), stamp, { parent: null }),
      ];

    // ── reaction ─────────────────────────────────────────────────────────
    case "space.roomy.reaction.addReaction.v0":
      return [
        created("reaction", actor, rkey(event.id), stamp, {
          target: event.reactionTo,
          user,
          reaction: event.reaction,
        }),
      ];

    case "space.roomy.reaction.removeReaction.v0":
      // Keyed by the add event's id, which is what the projection stores as
      // `comp_reaction.reaction_id` — so a removal names the record it removes
      // without naming the user.
      return [deleted("reaction", actor, rkey(event.reactionId), stamp)];

    case "space.roomy.reaction.addBridgedReaction.v0":
      // The reacting user is the external one, and the projection attributes the
      // reaction to them rather than to the bridge — the same rule a bridged
      // message's author override follows. So that user is the repo.
      return [
        created("reaction", event.reactingUser, rkey(event.id), stamp, {
          target: event.reactionTo,
          user: event.reactingUser,
          reaction: event.reaction,
          bridged: true,
        }),
      ];

    case "space.roomy.reaction.removeBridgedReaction.v0":
      return [
        deleted("reaction", event.reactingUser, rkey(event.reactionId), stamp),
      ];

    // ── membership ───────────────────────────────────────────────────────
    // One record per (space, user), owned by the space: membership is a
    // collective fact about a user, not content in their repo.
    case "space.roomy.space.joinSpace.v0":
      // `can: "post"` even for an admin rejoining: the projection's "a rejoin
      // keeps admin" rule reads the existing admin edge, which the adapter
      // cannot see. `addAdmin` is what carries the admin bit.
      return [
        created("membership", space, rkey(user), stamp, { user, can: "post" }),
      ];

    case "space.roomy.space.leaveSpace.v0":
      return [deleted("membership", space, rkey(user), stamp)];

    case "space.roomy.space.addAdmin.v0":
      return [
        updated("membership", space, rkey(event.userDid), stamp, {
          can: "admin",
        }),
      ];

    case "space.roomy.space.removeAdmin.v0":
      return [
        updated("membership", space, rkey(event.userDid), stamp, {
          can: "post",
        }),
      ];

    // ── space config ─────────────────────────────────────────────────────
    case "space.roomy.space.updateSpaceInfo.v0":
      return [
        updated("spaceInfo", space, SINGLETON_RKEY, stamp, {
          ...(event.name === undefined ? {} : { name: event.name }),
          ...(event.avatar === undefined ? {} : { avatar: event.avatar }),
          ...(event.description === undefined
            ? {}
            : { description: event.description }),
          ...(event.allowPublicJoin === undefined
            ? {}
            : { allowPublicJoin: event.allowPublicJoin }),
          ...(event.allowMemberInvites === undefined
            ? {}
            : { allowMemberInvites: event.allowMemberInvites }),
          ...(event.suggestToOthers === undefined
            ? {}
            : { suggestToOthers: event.suggestToOthers }),
        }),
      ];

    // Both sidebar versions overwrite the whole config, so the v1 form is the
    // record shape and v0 is the same record without category ids.
    case "space.roomy.space.updateSidebar.v0":
      return [
        updated("spaceSidebar", space, SINGLETON_RKEY, stamp, {
          categories: sidebarCategories(event.categories),
        }),
      ];

    case "space.roomy.space.updateSidebar.v1":
      return [
        updated("spaceSidebar", space, SINGLETON_RKEY, stamp, {
          categories: sidebarCategories(event.categories),
          ...(event.extensions === undefined
            ? {}
            : { extensions: event.extensions }),
        }),
      ];

    // ── ban ──────────────────────────────────────────────────────────────
    case "space.roomy.space.banAccount.v0":
      return [
        created("ban", space, rkey(event.userDid), stamp, {
          user: event.userDid,
        }),
      ];

    case "space.roomy.space.unbanAccount.v0":
      return [deleted("ban", space, rkey(event.userDid), stamp)];

    // ── invite ───────────────────────────────────────────────────────────
    case "space.roomy.space.createInvite.v0":
      // Keyed by the token: a revoke names the token and nothing else, so the
      // token is the only key the two events share.
      return [
        created("invite", space, rkey(event.token), stamp, {
          token: event.token,
          createdBy: user,
        }),
      ];

    case "space.roomy.space.revokeInvite.v0":
      return [deleted("invite", space, rkey(event.token), stamp)];

    // ── role ─────────────────────────────────────────────────────────────
    case "space.roomy.role.createRole.v0":
      return [
        created("role", space, rkey(event.id), stamp, {
          name: event.name || null,
          avatar: event.avatar || null,
          description: event.description || null,
        }),
      ];

    case "space.roomy.role.updateRole.v0":
      return [
        updated("role", space, rkey(event.roleId), stamp, {
          ...(event.name === undefined ? {} : { name: event.name }),
          ...(event.avatar === undefined ? {} : { avatar: event.avatar }),
          ...(event.description === undefined
            ? {}
            : { description: event.description }),
        }),
      ];

    case "space.roomy.role.deleteRole.v0":
      // The projection marks `roles.deleted` rather than removing the row and
      // every reader filters on it; no event restores a role, so removal from
      // the set is the same read result.
      return [deleted("role", space, rkey(event.roleId), stamp)];

    case "space.roomy.role.addMemberRole.v0":
      return [
        created("roleGrant", space, rkey(event.userDid, event.roleId), stamp, {
          user: event.userDid,
          role: event.roleId,
        }),
      ];

    case "space.roomy.role.removeMemberRole.v0":
      return [
        deleted("roleGrant", space, rkey(event.userDid, event.roleId), stamp),
      ];

    case "space.roomy.role.setRoleRoomPermission.v0":
      // A null level removes the role's access, which the projection expresses
      // as delete-then-maybe-insert on one key. Two ops on the same record are
      // exactly what a null and a non-null permission are.
      return [
        event.permission === null
          ? deleted(
              "roomPermission",
              space,
              rkey(event.roleId, event.roomId),
              stamp,
            )
          : updated(
              "roomPermission",
              space,
              rkey(event.roleId, event.roomId),
              stamp,
              {
                role: event.roleId,
                room: event.roomId,
                permission: event.permission,
              },
            ),
      ];

    // ── federation ───────────────────────────────────────────────────────
    // Both records are keyed by the receiving space (B) alone, because the one
    // event that removes them names B and nothing finer.
    case "space.roomy.federation.request.v0":
      return [
        created(
          "federationRequest",
          space,
          rkey(event.federatingSpaceDid),
          stamp,
          {
            federatingSpace: event.federatingSpaceDid,
            requestedBy: user,
            message: event.message ?? null,
          },
        ),
      ];

    case "space.roomy.federation.respond.v0":
      return [
        updated(
          "federationRequest",
          space,
          rkey(event.federatingSpaceDid),
          stamp,
          {
            status: event.approve ? "active" : "rejected",
            decidedBy: user,
            message: event.message ?? null,
          },
        ),
      ];

    // One event, two deletes: the relationship and every grant it created.
    case "space.roomy.federation.remove.v0":
      return [
        deleted(
          "federationRequest",
          space,
          rkey(event.federatingSpaceDid),
          stamp,
        ),
        deleted(
          "federationGrant",
          space,
          rkey(event.federatingSpaceDid),
          stamp,
        ),
      ];

    case "space.roomy.federation.setRoomPermission.v0":
      // A null level clears the origin grant for one channel, so both directions
      // are updates to the grant record. Both grant events write the same
      // record, and `federation.remove` deletes it whole — which is why the
      // record is per receiving space rather than per channel.
      return [
        updated(
          "federationGrant",
          space,
          rkey(event.federatingSpaceDid),
          stamp,
          {
            scope: "origin",
            room: event.roomId,
            permission: event.permission,
          },
        ),
      ];

    case "space.roomy.federation.setReceiverPermission.v0":
      // Sent on B's stream, but the grant it writes belongs to the origin space
      // A — so A is the repo and the stream (B) is part of the key.
      return [
        updated("federationGrant", event.originSpaceId, rkey(streamId), stamp, {
          scope: "receiver",
          room: event.roomId,
          grantee: event.grantee,
          granteeKind: event.kind,
          permission: event.permission,
        }),
      ];

    // ── profile, calendar, voice ─────────────────────────────────────────
    case "space.roomy.user.updateProfile.v0":
      // The subject is named by the event and can differ from the sender: this
      // write exists so a bridge or an admin can set someone else's profile,
      // which the protocol model cannot express inside the subject's repo. The
      // record is the subject's, so the subject is its repo; the write path is
      // flagged rather than resolved, the same class of problem as Q9's curator
      // actions.
      return [
        updated("profile", event.did, SINGLETON_RKEY, stamp, {
          ...(event.name === undefined ? {} : { name: event.name }),
          ...(event.avatar === undefined ? {} : { avatar: event.avatar }),
          ...(event.description === undefined
            ? {}
            : { description: event.description }),
          ...(discordHandle(event) === undefined
            ? {}
            : { handle: discordHandle(event) }),
        }),
      ];

    case "space.roomy.openmeet.configure.v0":
      return [
        event.groupSlug === null
          ? deleted("calendarLink", space, SINGLETON_RKEY, stamp)
          : updated("calendarLink", space, SINGLETON_RKEY, stamp, {
              groupSlug: event.groupSlug,
              tenantId: event.tenantId as string,
              apiUrl: event.apiUrl as string,
            }),
      ];

    case "space.roomy.voice.callStarted.v0":
      return [
        created("voiceCall", space, rkey(event.callId), stamp, {
          room: event.room,
          source: event.source,
          // The projection's `started_at` is the start event's ULID time, which
          // the log determines — unlike a wall-clock read at materialisation.
          startedAt: decodeTime(event.id),
        }),
      ];

    case "space.roomy.voice.callJoined.v0":
      return [
        updated("voiceCall", space, rkey(event.callId), stamp, {
          source: event.source,
          joined: event.userDid,
        }),
      ];

    case "space.roomy.voice.callLeft.v0":
      return [
        updated("voiceCall", space, rkey(event.callId), stamp, {
          source: event.source,
          left: event.userDid,
        }),
      ];

    case "space.roomy.voice.callEnded.v0":
      return [deleted("voiceCall", space, rkey(event.callId), stamp)];

    // ── no record ────────────────────────────────────────────────────────
    // Each is a deliberate omission, not an unimplemented case; the reasons are
    // in `NO_RECORD_EVENT_TYPES`. They stay accepted at the write path and keep
    // their event materialisers.
    case "space.roomy.space.setHandleProvider.v0":
    case "space.roomy.page.editPage.v0":
    case "space.roomy.message.reorderMessage.v0":
    case "space.roomy.state.markRead.v0":
      return [];

    default: {
      // Unreachable: the union above is exhaustive, so a new event type fails
      // the build here rather than producing no records at runtime.
      const unhandled: never = event;
      throw new Error(`No record mapping for event type: ${unhandled}`);
    }
  }
}
