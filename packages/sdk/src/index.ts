export * from "./schema";
export { modules, type ModuleWithCid } from "./modules";
export * from "./connection";
export * from "./atproto";
export * from "./leaf";
export * from "./client";
export * from "./utils";

// Operations
export * from "./operations/space";
export * from "./operations/message";
export * from "./operations/reaction";
export * from "./operations/room";

// Appserver sync (Slice 4)
export * as sync from "./sync";

// Cache adapter contract + canonical query-key helper (Slice 5).
// Concrete adapter implementations live under subpath exports
// (e.g. `@roomy-space/sdk/browser`) so library-specific deps stay
// out of non-consuming bundles.
export * as cache from "./cache";
