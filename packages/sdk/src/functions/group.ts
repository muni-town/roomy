import { Group } from "jazz-tools";
import { addInviteServiceAsGroupAdmin } from "../utils/invites.ts";

export function publicInvitableWriteGroup(opts?: {
  everyoneCanRead?: boolean;
}): Group {
  const group = Group.create();
  if (opts?.everyoneCanRead) {
    group.addMember("everyone", "reader");
  }
  addInviteServiceAsGroupAdmin(group);
  return group;
}

export function publicGroup(readWrite: "reader" | "writer" = "reader") {
  const group = Group.create();
  group.addMember("everyone", readWrite);

  return group;
}
