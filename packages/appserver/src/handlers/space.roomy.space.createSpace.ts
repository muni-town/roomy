/**
 * XRPC: space.roomy.space.createSpace (procedure).
 *
 * Provisions a new Leaf stream, seeds it with the initial event set
 * (space metadata, lobby channel, sidebar, creator as admin + member),
 * writes a personal.joinSpace event to the creator's personal stream, and
 * starts materialisation so the space appears in getSpaces immediately.
 *
 * @see packages/appserver/docs/plans/procedure-backlog.md
 */

import {
  modules,
  newUlid,
  createDefaultSpaceEvents,
  UserDid,
  type,
} from "@roomy-space/sdk";
import { openDb } from "../db/db.ts";
import { getServiceClient, getConnectedSpace } from "../serviceClient.ts";
import { getOrCreateMaterializer } from "../materialization/registry.ts";
import { resolvePersonalStreamDid } from "../hydration/resolvePersonalStream.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

interface CreateSpaceBody {
  name?: unknown;
  description?: unknown;
  avatar?: unknown;
}

export const createSpaceHandler: ProcedureHandler<
  CreateSpaceBody,
  { spaceId: string }
> = async (_params: QueryParams, auth: AuthCtx, body: CreateSpaceBody) => {
  // ── Validate input ───────────────────────────────────────────────────
  if (typeof body.name !== "string" || body.name.trim() === "") {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Missing or empty required field: name",
    );
  }
  if (body.description !== undefined && typeof body.description !== "string") {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Field 'description' must be a string if provided",
    );
  }
  if (body.avatar !== undefined && typeof body.avatar !== "string") {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Field 'avatar' must be a string if provided",
    );
  }

  const callerDid = UserDid(auth.did);
  if (callerDid instanceof type.errors) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      `Caller DID is not a valid UserDid: ${callerDid.summary}`,
    );
  }

  // ── 1. Create Leaf stream + add admin ────────────────────────────────
  const client = await getServiceClient();
  const space = await client.createSpace(modules.space, callerDid);
  const spaceId = space.streamDid;

  // ── 2. Seed initial events (updateSpaceInfo, createRoom, updateSidebar)
  const seedEvents = createDefaultSpaceEvents({
    name: body.name,
    description:
      body.description !== undefined ? body.description : undefined,
    avatar: body.avatar !== undefined ? body.avatar : undefined,
  });
  await space.sendEvents(seedEvents);

  // ── 3. Join as member (addAdmin already added admin edge, but not member)
  await space.sendEvent(
    {
      id: newUlid(),
      $type: "space.roomy.space.joinSpace.v0",
    },
    callerDid,
  );

  // ── 4. Write personal.joinSpace to creator's personal stream ─────────
  const db = openDb();
  const personalStreamDid = await resolvePersonalStreamDid(db, callerDid);
  const personalSpace = await getConnectedSpace(personalStreamDid);
  await personalSpace.sendEvent(
    {
      id: newUlid(),
      $type: "space.roomy.space.personal.joinSpace.v0",
      spaceDid: spaceId,
    },
    callerDid,
  );

  // ── 5. Start materialiser for the new space ──────────────────────────
  const mat = await getOrCreateMaterializer(spaceId);
  await mat.backfillDone;
  await mat.drain();

  return { spaceId };
};
