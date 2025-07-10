import { Group } from "jazz-tools";
import { addInviteServiceAsGroupAdmin } from "../utils/invites.ts";

export function publicGroup(
  readWrite: "reader" | "writer" = "reader",
  inviteServiceUrl?: string,
) {
  const group = Group.create();
  console.warn("inviter", inviteServiceUrl);
  if (inviteServiceUrl && readWrite == "writer") {
    group.addMember("everyone", "reader");
    addInviteServiceAsGroupAdmin(inviteServiceUrl, group).then(() => {
      console.log("done adding group admin");
    });
  } else {
    group.addMember("everyone", readWrite);
  }

  return group;
}
