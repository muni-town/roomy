import { co, z } from "jazz-tools";
import { RoomyEntity } from "./roomyobject.js";

export const SpaceMigrationReference = co.record(z.string(), z.string());
export const IDList = co.list(z.string());

export const IDFeed = co.feed(z.string());
export const RoomyEntityFeed = co.feed(RoomyEntity);
export const RoomyEntityList = co.list(RoomyEntity);

export * from "./page.js";
export * from "./roomyobject.js";
export * from "./space.js";
export * from "./threads.js";
export * from "./user.js";
export * from "./discord.js";
export * from "./folder.js";