import { co, z } from "jazz-tools";
import { RoomyEntity } from "./roomyentity.js";

export const MemberEntry = co.map({
  account: co.account(),
  softDeleted: z.boolean().optional(),
});

export const SpacePermissions = co.record(z.string(), z.string());

export const SpacePermissionsComponent = {
  schema: co.record(z.string(), z.string()),
  id: "space.roomy.permissions.v0",
};

export const AllThreadsComponent = {
  schema: co.feed(RoomyEntity),
  id: "space.roomy.threads.v0",
};

export const AllFoldersComponent = {
  schema: co.list(RoomyEntity),
  id: "space.roomy.folders.v0",
};

export const AllMembersComponent = {
  schema: co.feed(MemberEntry),
  id: "space.roomy.members.v0",
};

export const AllEntitiesComponent = {
  schema: co.feed(RoomyEntity),
  id: "space.roomy.entities.v0",
};

export const AllPagesComponent = {
  schema: co.list(RoomyEntity),
  id: "space.roomy.pages.v0",
};

export const BansComponent = {
  schema: co.list(z.string()),
  id: "space.roomy.bans.v0",
};

export const SpaceRolesComponent = {
  schema: co.record(z.string(), z.string()),
  id: "space.roomy.roles.v0",
};
