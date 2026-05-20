import { newUlid } from "@roomy-space/sdk";
import { sendEvents } from "./send-events";

export async function createRole(
  spaceId: string,
  opts: { name?: string; description?: string; avatar?: string },
): Promise<string> {
  const id = newUlid();
  await sendEvents(spaceId, [
    {
      id,
      $type: "space.roomy.role.createRole.v0",
      ...(opts.name !== undefined && { name: opts.name }),
      ...(opts.description !== undefined && { description: opts.description }),
      ...(opts.avatar !== undefined && { avatar: opts.avatar }),
    },
  ]);
  return id;
}

export async function updateRole(
  spaceId: string,
  opts: { roleId: string; name?: string; description?: string; avatar?: string },
): Promise<void> {
  await sendEvents(spaceId, [
    {
      id: newUlid(),
      $type: "space.roomy.role.updateRole.v0",
      roleId: opts.roleId,
      ...(opts.name !== undefined && { name: opts.name }),
      ...(opts.description !== undefined && { description: opts.description }),
      ...(opts.avatar !== undefined && { avatar: opts.avatar }),
    },
  ]);
}

export async function deleteRole(spaceId: string, roleId: string): Promise<void> {
  await sendEvents(spaceId, [
    {
      id: newUlid(),
      $type: "space.roomy.role.deleteRole.v0",
      roleId,
    },
  ]);
}
