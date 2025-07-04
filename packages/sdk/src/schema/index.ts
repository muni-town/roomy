import { co, z } from "jazz-tools";

export const SpaceMigrationReference = co.record(z.string(), z.string());
export const IDList = co.list(z.string());

export * from "./page.ts";
export * from "./roomyobject.ts";
export * from "./space.ts";
export * from "./threads.js";
export * from "./user.ts";