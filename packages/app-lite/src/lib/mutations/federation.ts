import { newUlid } from "@roomy-space/sdk";
import { sendEvents } from "./send-events";

export type PermissionLevel = "read" | "readwrite" | null;

/**
 * A member of the origin space who is also an admin of the requesting space
 * (B) asks A to federate B in. Sent on A's stream.
 */
export async function requestFederation(
  spaceId: string, // A (origin / receiving the request)
  opts: { federatingSpaceDid: string; message?: string },
): Promise<void> {
  await sendEvents(spaceId, [
    {
      id: newUlid(),
      $type: "space.roomy.federation.request.v0",
      federatingSpaceDid: opts.federatingSpaceDid,
      ...(opts.message !== undefined && { message: opts.message }),
    },
  ]);
}

/** An admin of A approves (approve=true) or rejects a pending request from B. */
export async function respondFederation(
  spaceId: string, // A
  opts: { federatingSpaceDid: string; approve: boolean; message?: string },
): Promise<void> {
  await sendEvents(spaceId, [
    {
      id: newUlid(),
      $type: "space.roomy.federation.respond.v0",
      federatingSpaceDid: opts.federatingSpaceDid,
      approve: opts.approve,
      ...(opts.message !== undefined && { message: opts.message }),
    },
  ]);
}

/** An admin of A removes the federation with B. */
export async function removeFederation(
  spaceId: string, // A
  federatingSpaceDid: string, // B
): Promise<void> {
  await sendEvents(spaceId, [
    {
      id: newUlid(),
      $type: "space.roomy.federation.remove.v0",
      federatingSpaceDid,
    },
  ]);
}

/**
 * Set/clear the origin grant: what access B has to a channel of A.
 * Sent on A's stream by an admin of A.
 */
export async function setRoomPermission(
  spaceId: string, // A (owner)
  opts: { federatingSpaceDid: string; roomId: string; permission: PermissionLevel },
): Promise<void> {
  await sendEvents(spaceId, [
    {
      id: newUlid(),
      $type: "space.roomy.federation.setRoomPermission.v0",
      federatingSpaceDid: opts.federatingSpaceDid,
      roomId: opts.roomId,
      permission: opts.permission,
    },
  ]);
}

/**
 * Set/clear a receiver grant: what access a B member, role, or all B members
 * have to a federated channel (capped by the origin grant). Sent on B's
 * stream by an admin of B. `kind='members'` grants every B member
 * (`grantee` = B's space DID) — the federated equivalent of a channel's
 * defaultAccess.
 */
export async function setReceiverPermission(
  spaceId: string, // B (receiving)
  opts: {
    originSpaceId: string; // A
    roomId: string;
    grantee: string; // B space DID (members) / B user DID / B role id
    kind: "members" | "user" | "role";
    permission: PermissionLevel;
  },
): Promise<void> {
  await sendEvents(spaceId, [
    {
      id: newUlid(),
      $type: "space.roomy.federation.setReceiverPermission.v0",
      originSpaceId: opts.originSpaceId,
      roomId: opts.roomId,
      grantee: opts.grantee,
      kind: opts.kind,
      permission: opts.permission,
    },
  ]);
}
