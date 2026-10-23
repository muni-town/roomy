/**
 * Projection rules for the record kinds, and the context a rule needs.
 *
 * A rule is a pure function from one {@link RecordChange} plus the state the
 * planner read (never from the log entry) to the statements that apply it. The
 * statements carry their target DB, because the worker no longer decides that
 * by matching SQL text for a routed entry: the federation and membership rules
 * write the global DB by construction, and every other rule writes the space's
 * own.
 */

import type { Did, SqlStatement, StreamDid } from "@roomy-space/sdk";

import type { LoggedEvent } from "../types.ts";
import type { RecordChange } from "./recordChange.ts";
import { messageStatements } from "./messageRules.ts";
import { reactionStatements } from "./reactionRules.ts";
import { roomStatements } from "./roomRules.ts";
import {
  banStatements,
  inviteStatements,
  membershipStatements,
} from "./membershipRules.ts";
import {
  roleGrantStatements,
  roleStatements,
  roomPermissionStatements,
} from "./permissionRules.ts";
import { spaceInfoStatements, spaceSidebarStatements } from "./spaceConfigRules.ts";

/** Which database a rule statement targets. */
export type StatementTarget = "space" | "global";

/** A statement that names its target rather than leaving it to be inferred. */
export interface RuleStatement extends SqlStatement {
  readonly derived: StatementTarget;
}

/**
 * What a rule needs that the record body does not carry.
 *
 * `priorRoom` is the room a message or call was in before the change, and
 * `priorParent` the room a link's `parent` pointed at. Both are read from the
 * rows once per chunk by {@link planBatch}. `actor` and `eventId` come from the
 * entry the change was derived from, for the rows the record model does not
 * identify: membership's system message is keyed by the join event's id, and
 * `comp_invite.event_ulid` by the invite event's.
 */
export interface RuleContext {
  readonly streamId: StreamDid;
  /** The user who sent the entry the change was derived from. */
  readonly actor: Did;
  /** The entry's id, for the rows the record model does not identify. */
  readonly eventId: string;
  readonly priorRoom?: string;
  readonly priorParent?: string;
}

/** Wrap a space-DB statement with its target. */
export function space(statement: SqlStatement): RuleStatement {
  return { ...statement, derived: "space" };
}

/** Wrap a global-DB statement with its target. */
export function global(statement: SqlStatement): RuleStatement {
  return { ...statement, derived: "global" };
}

/**
 * The statements that apply one change, in the order the event path wrote them.
 *
 * A kind without a case here has no rule yet and cannot be routed: the
 * converter only emits kinds in `CONVERTED_KINDS`, and this switch covers
 * exactly those.
 */
export function changeStatements(
  change: RecordChange,
  ctx: RuleContext,
): RuleStatement[] {
  const kind: string = change.kind;
  switch (change.kind) {
    case "message":
      return messageStatements(change, ctx).map(space);
    case "reaction":
      return reactionStatements(change, ctx);
    case "room":
      return roomStatements(change, ctx);
    case "spaceInfo":
      return spaceInfoStatements(change, ctx);
    case "spaceSidebar":
      return spaceSidebarStatements(change, ctx);
    case "membership":
      return membershipStatements(change, ctx);
    case "ban":
      return banStatements(change, ctx);
    case "invite":
      return inviteStatements(change, ctx);
    case "role":
      return roleStatements(change, ctx);
    case "roleGrant":
      return roleGrantStatements(change, ctx);
    case "roomPermission":
      return roomPermissionStatements(change, ctx);
    default:
      throw new Error(`No projection rule for record kind: ${kind}`);
  }
}

/**
 * The context for one routed entry: the entry's own identity plus the prior
 * state the planner read for the change it is applied to.
 */
export function entryContext(
  entry: LoggedEvent,
  streamId: StreamDid,
  prior: { priorRoom?: string; priorParent?: string },
): RuleContext {
  return {
    streamId,
    actor: entry.user as Did,
    eventId: entry.event.id,
    ...prior,
  };
}
