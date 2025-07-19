import { co, z } from "jazz-tools";
import { RoomyEntity } from "./roomyobject.js";

export const Space = co.map({
  name: z.string(),

  imageUrl: z.string().optional(),

  description: z.string().optional(),

  // Uncommenting this causes the error
  members: co.list(co.account()),

  version: z.number().optional(),
  creatorId: z.string(),

  adminGroupId: z.string(),

  rootFolder: RoomyEntity,

  threads: co.feed(RoomyEntity),
  pages: co.list(RoomyEntity),
  folders: co.list(RoomyEntity),

  bans: co.list(z.string()),
});

export const MemberEntry = co.map({
  account: co.account(),
  softDeleted: z.boolean().optional(),
});

export const SpacePermissions = co.record(z.string(), z.string());

export const SpacePermissionsComponent = {
  schema: co.record(z.string(), z.string()),
  id: "space.roomy.permissions.v0",
}

export const AllThreadsComponent = {
  schema: co.feed(RoomyEntity),
  id: "space.roomy.threads.v0",
}

export const AllFoldersComponent = {
  schema: co.list(RoomyEntity),
  id: "space.roomy.folders.v0",
}

export const AllMembersComponent = {
  schema: co.list(MemberEntry),
  id: "space.roomy.members.v0",
}

export const AllEntitiesComponent = {
  schema: co.feed(RoomyEntity),
  id: "space.roomy.entities.v0",
}

export const AllPagesComponent = {
  schema: co.list(RoomyEntity),
  id: "space.roomy.pages.v0",
}

export const BansComponent = {
  schema: co.list(z.string()),
  id: "space.roomy.bans.v0",
}

export const AllPermissions = {
  publicRead: "publicRead",

  viewMessages: "viewMessages",
  sendMessages: "sendMessages",
  deleteMessages: "deleteMessages",
  editMessages: "editMessages",
  reactToMessages: "reactToMessages",
  addEmbeds: "addEmbeds",
  manageEmbeds: "manageEmbeds",
  hideMessagesInThreads: "hideMessagesInThreads",

  viewChildren: "viewChildren",
  manageChildren: "manageChildren",
  editEntities: "editEntities",

  createThreads: "createThreads",
  manageThreads: "manageThreads",

  editPages: "editPages",

  editSpace: "editSpace",

  seeMembers: "seeMembers",
  manageMembers: "manageMembers",
}
