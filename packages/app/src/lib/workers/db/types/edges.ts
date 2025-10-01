// Child Parent Subscribe Member Ban Hide Pin LastRead Embed Reply BranchThread Author Reorder Source Avatar

import type { EntityId } from "./entities";

export type EdgeLabel =
  | "child"
  | "parent"
  | "subscribe"
  | "member"
  | "ban"
  | "hide"
  | "pin"
  | "last_read"
  | "embed"
  | "reply"
  | "link"
  | "author"
  | "reorder"
  | "source"
  | "avatar"
  | "reaction";

export interface EdgeReaction {
  reaction: string;
}

export interface EdgeBan {
  reason: string;
  banned_by: EntityId;
}

export interface EdgeMember {
  // delegation?: string;
  can: "read" | "post" | "admin"
}

export type EdgesMap = {
  [K in Exclude<EdgeLabel, "reaction" | "member" | "ban">]: null;
} & {
  reaction: EdgeReaction;
  ban: EdgeBan;
  member: EdgeMember;
};

/** Given a tuple of edge names, produces a record whose keys are exactly
 * those edge names and whose values are arrays of the corresponding edge types.
 */
export type EdgesRecord<TRequired extends readonly EdgeLabel[]> = {
  [K in TRequired[number]]: [EdgesMap[K], EntityId];
};
