import { co, z } from "jazz-tools";

export const SpaceMigrationReference = co.record(z.string(), z.string());
export const IDList = co.list(z.string());

export * from "./entity.ts";
export * from "./components.js";
export * from "./user.ts";
