import { newUlid } from "@roomy-space/sdk";
import { auth, px } from "$lib/auth.svelte";
import { CONFIG } from "$lib/config";
import { sendEvents } from "./send-events";

/**
 * If the appserver tells us a personal stream was created but the PDS record
 * hasn't been saved yet, persist it now.
 */
async function maybeSavePersonalStreamRecord(
  result: { personalStreamDid?: string; needsPersonalStreamRecord?: boolean },
): Promise<void> {
  if (result.needsPersonalStreamRecord && result.personalStreamDid) {
    const agent = auth.agent;
    if (!agent) {
      console.warn(
        "[space] appserver created personal stream but no agent available to save PDS record",
      );
      return;
    }
    try {
      await agent.com.atproto.repo.putRecord({
        collection: CONFIG.personalStreamNsid,
        repo: agent.assertDid,
        rkey: CONFIG.personalStreamSchemaVersion,
        record: {
          $type: CONFIG.personalStreamNsid,
          id: result.personalStreamDid,
        },
      });
      console.log("[space] Saved personal stream PDS record");
    } catch (err) {
      console.error("[space] Failed to save personal stream PDS record:", err);
    }
  }
}

export async function joinSpace(
  spaceId: string,
  inviteToken?: string,
): Promise<void> {
  // Invalidation is handled by the appserver's sync signal
  // (personal.joinSpace → getSpaces invalidation via WebSocket).
  const result = await px().procedure("space.roomy.space.joinSpace", {
    spaceId,
    ...(inviteToken ? { inviteToken } : {}),
  });

  await maybeSavePersonalStreamRecord(result);
}

export async function leaveSpace(spaceId: string): Promise<void> {
  // Invalidation is handled by the appserver's sync signal
  // (personal.leaveSpace → getSpaces invalidation via WebSocket).
  await px().procedure("space.roomy.space.leaveSpace", {
    spaceId,
  });
}

export async function createSpace(opts: {
  name: string;
  description?: string;
  avatar?: string;
  allowPublicJoin?: boolean;
  allowMemberInvites?: boolean;
}): Promise<{ spaceId: string }> {
  // Invalidation is handled by the appserver's sync signal
  // (personal.joinSpace → getSpaces invalidation via WebSocket).
  const result = await px().procedure("space.roomy.space.createSpace", {
    name: opts.name,
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.avatar ? { avatar: opts.avatar } : {}),
    ...(opts.allowPublicJoin !== undefined
      ? { allowPublicJoin: opts.allowPublicJoin }
      : {}),
    ...(opts.allowMemberInvites !== undefined
      ? { allowMemberInvites: opts.allowMemberInvites }
      : {}),
  });

  await maybeSavePersonalStreamRecord(result);
  return result;
}

export async function updateSpaceInfo(
  spaceId: string,
  opts: {
    name?: string;
    description?: string;
    avatar?: string;
    allowPublicJoin?: boolean;
    allowMemberInvites?: boolean;
  },
): Promise<void> {
  await sendEvents(spaceId, [
    {
      id: newUlid(),
      $type: "space.roomy.space.updateSpaceInfo.v0",
      ...(opts.name !== undefined && { name: opts.name }),
      ...(opts.description !== undefined && { description: opts.description }),
      ...(opts.avatar !== undefined && { avatar: opts.avatar }),
      ...(opts.allowPublicJoin !== undefined && {
        allowPublicJoin: opts.allowPublicJoin,
      }),
      ...(opts.allowMemberInvites !== undefined && {
        allowMemberInvites: opts.allowMemberInvites,
      }),
    },
  ]);
}
