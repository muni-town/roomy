import { co, z } from "jazz-tools";
import { defComponent, RoomyEntity } from "./roomyentity.js";

export const MemberEntry = co.map({
  account: co.account(),
  softDeleted: z.boolean().optional(),
});

export const SpacePermissions = co.record(z.string(), z.string());

export const SpacePermissionsComponent = defComponent(
  "space.roomy.permissions.v0",
  co.record(z.string(), z.string()),
);

export const AllThreadsComponent = defComponent(
  "space.roomy.threads.v0",
  co.feed(RoomyEntity),
);

export const AllFoldersComponent = defComponent(
  "space.roomy.folders.v0",
  co.list(RoomyEntity),
);

export const AllMembersComponent = defComponent(
  "space.roomy.members.v0",
  co.feed(MemberEntry),
);

export const AllEntitiesComponent = defComponent(
  "space.roomy.entities.v0",
  co.feed(RoomyEntity),
);

export const AllPagesComponent = defComponent(
  "space.roomy.pages.v0",
  co.list(RoomyEntity),
);

export const BansComponent = defComponent(
  "space.roomy.bans.v0",
  co.list(z.string()),
);

export const SpaceRolesComponent = defComponent(
  "space.roomy.roles.v0",
  co.record(z.string(), z.string()),
);
