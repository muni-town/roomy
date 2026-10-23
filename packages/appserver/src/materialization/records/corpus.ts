/**
 * The registry corpus: one well-formed event per record-producing event type,
 * in an order the materialiser can apply.
 *
 * Two consumers share it. The record-path tests build a space from it through
 * `applyBatch` and assert the adapter's changes describe the projection that
 * came out. The parity exporter (`scripts/export-worker-fixtures.ts`) records
 * the same log's change feed and the digests of the two databases it produces,
 * which is what a second implementation of the projection is checked against.
 *
 * Ids come from the caller, so a test can let them be fresh while a committed
 * fixture makes them fixed: regenerating a fixture then produces byte-identical
 * files.
 */

import type {
  Event,
  EventType,
  StreamDid,
  StreamIndex,
  UserDid,
} from "@roomy-space/sdk";
import { newUlid } from "@roomy-space/sdk";

import type { LoggedEvent } from "../types.ts";
import { RECORD_KINDS_FOR_EVENT } from "./toRecordChanges.ts";

/** The space every corpus entry is logged against. */
export const CORPUS_STREAM = "did:web:adapter-fixture.example" as StreamDid;
/** The user every entry is attributed to unless the sample says otherwise. */
export const CORPUS_USER = "did:plc:adapter-user";
export const CORPUS_OTHER = "did:plc:adapter-other";
export const CORPUS_THIRD = "did:plc:adapter-third";
/** The origin space of a receiver grant, which is not the stream it arrives on. */
export const CORPUS_ORIGIN = "did:web:origin.example" as StreamDid;
/** The receiving space of an origin grant. */
export const CORPUS_RECEIVING = "did:web:receiving.example" as StreamDid;

const USER = CORPUS_USER;
const OTHER = CORPUS_OTHER;
const THIRD = CORPUS_THIRD;
const ORIGIN = CORPUS_ORIGIN;
const RECEIVING = CORPUS_RECEIVING;

/** The instant every entry's receipt is stamped with, so a fixture is stable. */
export const CORPUS_RECEIVED_AT = 1_700_000_000_000;

/** How a corpus run mints the ids its events name. */
export type IdSource = () => string;

/** What {@link buildCorpus} needs: the ids it mints and the receipt it stamps. */
export interface CorpusOpts {
  /** Defaults to fresh ULIDs. A fixture passes a counter-based generator. */
  readonly ids?: IdSource;
  readonly receivedAt?: number;
  /**
   * Drop the entries whose event type emits no record. A projection built from
   * the change feed cannot reproduce what those entries write — they have no
   * change to carry it — so a cross-implementation comparison uses the log
   * without them.
   */
  readonly recordProducingOnly?: boolean;
}

export function corpusContent(text: string) {
  return {
    mimeType: "text/markdown",
    data: { buf: new TextEncoder().encode(text) },
  };
}

/** The ids the fixture's events refer to; filled in as the log is built. */
export interface Fixture {
  channel: string;
  /** Linked from the channel and unlinked later in the log. */
  spareThread: string;
  /** Linked from the channel; the link stands. */
  thread: string;
  /** A message that survives the log, moved into the thread. */
  kept: string;
  /** A message whose content the log edits. */
  edited: string;
  /** A message the log deletes. */
  deleted: string;
  role: string;
  reaction: string;
  call: string;
  inviteToken: string;
}

export function emptyFixture(id: IdSource): Fixture {
  return {
    channel: id(),
    spareThread: id(),
    thread: id(),
    kept: id(),
    edited: id(),
    deleted: id(),
    role: id(),
    reaction: id(),
    call: id(),
    inviteToken: "fixture-token",
  };
}

/**
 * One well-formed event of `$type`.
 *
 * Well-formed enough that the materialiser runs: it reads fields without
 * validating them, so a missing field shows up as a projection error rather
 * than as a wrong record. `overrides` is how the fixture builds a second room or
 * a second message of a type it already used.
 */
export function sample(
  $type: EventType,
  fx: Fixture,
  ids: IdSource,
  overrides: Record<string, unknown> = {},
): Event {
  const id = ids();
  const base = (fields: Record<string, unknown>) =>
    ({ $type, id, ...fields, ...overrides }) as unknown as Event;

  switch ($type) {
    case "space.roomy.message.createMessage.v0":
      return base({ room: fx.channel, body: corpusContent("hello"), extensions: {} });
    case "space.roomy.message.editMessage.v0":
      return base({
        room: fx.channel,
        messageId: fx.edited,
        body: corpusContent("after edit"),
      });
    case "space.roomy.message.deleteMessage.v0":
      return base({ room: fx.channel, messageId: fx.deleted });
    case "space.roomy.message.moveMessages.v0":
      return base({
        room: fx.channel,
        messageIds: [fx.kept],
        toRoomId: fx.thread,
      });
    case "space.roomy.message.reorderMessage.v0":
      return base({ room: fx.channel, messageId: fx.kept, after: fx.edited });
    case "space.roomy.message.forwardMessages.v0":
      return base({
        room: fx.thread,
        messageIds: [fx.kept],
        fromRoomId: fx.channel,
      });

    case "space.roomy.room.createRoom.v0":
      return base({ kind: "space.roomy.channel", name: "general" });
    case "space.roomy.room.updateRoom.v0":
      return base({ roomId: fx.channel, name: "general (renamed)" });
    case "space.roomy.room.deleteRoom.v0":
      return base({ roomId: fx.thread });
    case "space.roomy.room.restoreRoom.v0":
      return base({ roomId: fx.thread });

    case "space.roomy.reaction.addReaction.v0":
      return base({
        room: fx.channel,
        reactionTo: fx.edited,
        reaction: "👍",
      });
    case "space.roomy.reaction.removeReaction.v0":
      return base({ room: fx.channel, reactionId: fx.reaction });
    case "space.roomy.reaction.addBridgedReaction.v0":
      return base({
        room: fx.channel,
        reactionTo: fx.edited,
        reaction: "🎉",
        reactingUser: THIRD,
        extensions: {},
      });
    case "space.roomy.reaction.removeBridgedReaction.v0":
      return base({
        room: fx.channel,
        reactionId: fx.reaction,
        reactingUser: THIRD,
        extensions: {},
      });

    case "space.roomy.space.joinSpace.v0":
      return base({});
    case "space.roomy.space.leaveSpace.v0":
      return base({});
    case "space.roomy.space.updateSpaceInfo.v0":
      return base({ name: "Fixture space" });
    case "space.roomy.space.updateSidebar.v0":
      return base({
        categories: [{ name: "General", children: [fx.channel] }],
      });
    case "space.roomy.space.updateSidebar.v1":
      return base({
        categories: [
          { id: ids(), name: "General", children: [fx.channel] },
        ],
      });
    case "space.roomy.space.addAdmin.v0":
      return base({ userDid: OTHER });
    case "space.roomy.space.removeAdmin.v0":
      return base({ userDid: OTHER });
    case "space.roomy.space.setHandleProvider.v0":
      return base({ did: OTHER });
    case "space.roomy.space.banAccount.v0":
      return base({ userDid: THIRD });
    case "space.roomy.space.unbanAccount.v0":
      return base({ userDid: THIRD });
    case "space.roomy.space.createInvite.v0":
      return base({ token: fx.inviteToken });
    case "space.roomy.space.revokeInvite.v0":
      return base({ token: fx.inviteToken });

    case "space.roomy.page.editPage.v0":
      // A real byte array: this event's materialiser binds the content straight
      // to SQL, unlike the CBOR-wrapped form the message events carry.
      return base({
        room: fx.channel,
        body: {
          mimeType: "text/markdown",
          data: new TextEncoder().encode("a page"),
        },
      });

    case "space.roomy.user.updateProfile.v0":
      return base({ did: OTHER, name: "Other Person" });

    case "space.roomy.link.createRoomLink.v0":
      return base({
        room: fx.channel,
        linkToRoom: fx.thread,
        isCreationLink: true,
      });
    case "space.roomy.link.removeRoomLink.v0":
      // The spare thread, so the first thread's `parent` edge survives the log
      // and both directions are visible in one projection.
      return base({ room: fx.channel, linkToRoom: fx.spareThread });

    case "space.roomy.openmeet.configure.v0":
      return base({
        groupSlug: "fixture-group",
        tenantId: "tenant-1",
        apiUrl: "https://calendar.example",
      });

    case "space.roomy.state.markRead.v0":
      return base({ room: fx.channel });

    case "space.roomy.role.createRole.v0":
      return base({ name: "Moderator" });
    case "space.roomy.role.updateRole.v0":
      return base({ roleId: fx.role, description: "keeps the peace" });
    case "space.roomy.role.deleteRole.v0":
      return base({ roleId: fx.role });
    case "space.roomy.role.addMemberRole.v0":
      return base({ userDid: OTHER, roleId: fx.role });
    case "space.roomy.role.removeMemberRole.v0":
      return base({ userDid: OTHER, roleId: fx.role });
    case "space.roomy.role.setRoleRoomPermission.v0":
      return base({
        roleId: fx.role,
        roomId: fx.channel,
        permission: "readwrite",
      });

    case "space.roomy.federation.request.v0":
      return base({ federatingSpaceDid: RECEIVING, message: "please" });
    case "space.roomy.federation.respond.v0":
      return base({ federatingSpaceDid: RECEIVING, approve: true });
    case "space.roomy.federation.remove.v0":
      return base({ federatingSpaceDid: RECEIVING });
    case "space.roomy.federation.setRoomPermission.v0":
      return base({
        federatingSpaceDid: RECEIVING,
        roomId: fx.channel,
        permission: "read",
      });
    case "space.roomy.federation.setReceiverPermission.v0":
      // Sent on this space's stream, but the grant it writes is the origin
      // space's — so the two are different repos.
      return base({
        originSpaceId: ORIGIN,
        roomId: fx.channel,
        grantee: RECEIVING,
        kind: "members",
        permission: "read",
      });

    case "space.roomy.voice.callStarted.v0":
      return base({ room: fx.channel, callId: fx.call, source: "user" });
    case "space.roomy.voice.callJoined.v0":
      return base({
        room: fx.channel,
        callId: fx.call,
        userDid: OTHER,
        source: "user",
      });
    case "space.roomy.voice.callLeft.v0":
      return base({
        room: fx.channel,
        callId: fx.call,
        userDid: OTHER,
        source: "user",
      });
    case "space.roomy.voice.callEnded.v0":
      return base({ room: fx.channel, callId: fx.call, source: "user" });
  }
}

/**
 * Every event type, in an order the materialiser can apply: a room exists before
 * a message in it, a message exists before its edit, and a delete comes after the
 * record it removes.
 *
 * The last event per record decides the projection's end state, so this list is
 * also what the per-op assertions are about — `federation.remove` is last
 * because it removes the relationship and its grants, and `revokeInvite` comes
 * after `createInvite` for the same reason.
 *
 * The two event types this leaves out are the ones whose materialisers do not
 * run against the real schema, so a projection built from a log containing them
 * would be missing rows for reasons that have nothing to do with the adapter:
 *
 *  - `page.editPage` inserts into `comp_page_edits` a column named `event`, which
 *    the table does not have (`schema-space.sql` names it `data`), so the whole
 *    event fails to apply. Retired and unmapped either way.
 *  - `state.markRead` is rejected at the write path and its materialiser returns
 *    no statements, so it is a no-record type with nothing to project.
 *
 * Both are still covered by the exhaustiveness tests above, which is where "it
 * produces no record" is asserted.
 */
/** The event types `FIXTURE_ORDER` leaves out, with the reason stated there. */
export const FIXTURE_EXCLUDED: ReadonlySet<EventType> = new Set<EventType>([
  "space.roomy.page.editPage.v0",
  "space.roomy.state.markRead.v0",
]);

export const FIXTURE_ORDER: EventType[] = [
  "space.roomy.space.updateSpaceInfo.v0",
  "space.roomy.room.createRoom.v0",
  "space.roomy.space.joinSpace.v0",
  "space.roomy.space.addAdmin.v0",
  "space.roomy.space.removeAdmin.v0",
  "space.roomy.space.leaveSpace.v0",
  "space.roomy.space.setHandleProvider.v0",
  "space.roomy.space.updateSidebar.v0",
  "space.roomy.space.updateSidebar.v1",
  "space.roomy.link.createRoomLink.v0",
  "space.roomy.message.createMessage.v0",
  "space.roomy.message.editMessage.v0",
  "space.roomy.message.deleteMessage.v0",
  "space.roomy.message.forwardMessages.v0",
  "space.roomy.message.moveMessages.v0",
  "space.roomy.message.reorderMessage.v0",
  "space.roomy.reaction.addReaction.v0",
  "space.roomy.reaction.removeReaction.v0",
  "space.roomy.reaction.addBridgedReaction.v0",
  "space.roomy.reaction.removeBridgedReaction.v0",
  "space.roomy.space.banAccount.v0",
  "space.roomy.space.createInvite.v0",
  "space.roomy.role.createRole.v0",
  "space.roomy.role.updateRole.v0",
  "space.roomy.role.addMemberRole.v0",
  "space.roomy.role.setRoleRoomPermission.v0",
  "space.roomy.user.updateProfile.v0",
  "space.roomy.openmeet.configure.v0",
  "space.roomy.federation.request.v0",
  "space.roomy.federation.respond.v0",
  "space.roomy.federation.setRoomPermission.v0",
  "space.roomy.federation.setReceiverPermission.v0",
  "space.roomy.voice.callStarted.v0",
  "space.roomy.voice.callJoined.v0",
  "space.roomy.voice.callLeft.v0",
  "space.roomy.voice.callEnded.v0",
  "space.roomy.room.updateRoom.v0",
  "space.roomy.room.deleteRoom.v0",
  "space.roomy.room.restoreRoom.v0",
  "space.roomy.space.revokeInvite.v0",
  "space.roomy.space.unbanAccount.v0",
  "space.roomy.role.removeMemberRole.v0",
  "space.roomy.link.removeRoomLink.v0",
  "space.roomy.federation.remove.v0",
  "space.roomy.role.deleteRole.v0",
];
function fixtureLog(opts: CorpusOpts): { entries: LoggedEvent[]; fx: Fixture } {
  const minted = opts.ids ?? (() => newUlid());
  const fx = emptyFixture(minted);
  let idx = 0;
  const entries: LoggedEvent[] = [];
  const push = ($type: EventType, overrides: Record<string, unknown> = {}) => {
    entries.push(
      logged(sample($type, fx, minted, overrides), ++idx, opts.receivedAt),
    );
  };

  for (const $type of FIXTURE_ORDER) {
    if (opts.recordProducingOnly && RECORD_KINDS_FOR_EVENT[$type].length === 0) {
      continue;
    }
    // The events that name a room or a message by id get the fixture's ids; the
    // rest get fresh ones. Without this the log would reference rows it never
    // creates.
    switch ($type) {
      case "space.roomy.room.createRoom.v0":
        push($type, { id: fx.channel });
        push($type, { id: fx.thread, kind: "space.roomy.thread", name: "thread" });
        push($type, {
          id: fx.spareThread,
          kind: "space.roomy.thread",
          name: "spare thread",
        });
        continue;
      case "space.roomy.link.createRoomLink.v0":
        push($type, { room: fx.channel, linkToRoom: fx.thread });
        push($type, { room: fx.channel, linkToRoom: fx.spareThread });
        continue;
      case "space.roomy.message.createMessage.v0":
        push($type, { id: fx.kept, room: fx.channel });
        push($type, { id: fx.edited, room: fx.channel });
        push($type, { id: fx.deleted, room: fx.channel });
        continue;
      case "space.roomy.reaction.addReaction.v0":
        // The remove events name the add event's id.
        push($type, { id: fx.reaction });
        continue;
      case "space.roomy.role.createRole.v0":
        // updateRole/deleteRole/addMemberRole name the role by id.
        push($type, { id: fx.role });
        continue;
      default:
        push($type);
    }
  }

  return { entries, fx };
}

/** One log entry, with the receipt the append path would have stamped. */
export function logged(
  event: Event,
  idx: number,
  receivedAt = CORPUS_RECEIVED_AT,
): LoggedEvent {
  return {
    event,
    idx: idx as StreamIndex,
    user: USER as UserDid,
    receivedAt,
    createdAt: receivedAt,
  };
}

/**
 * The corpus: every record-producing event type once, in an applicable order,
 * with the fixture's ids it refers to.
 */
export function buildCorpus(opts: CorpusOpts = {}): {
  entries: LoggedEvent[];
  fx: Fixture;
} {
  return fixtureLog(opts);
}
