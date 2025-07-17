import { co, z } from "jazz-tools";

export const SpaceMigrationReference = co.record(z.string(), z.string());
export const IDList = co.list(z.string());

export * from "./page.js";
export * from "./roomyobject.js";
export * from "./space.js";
export * from "./threads.js";
export * from "./user.js";
export * from "./discord.js";