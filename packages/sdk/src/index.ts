export * from "./schema";
export type { DecodedStreamEvent, EventCallback, EventCallbackMeta, EncodedStreamEvent } from "./connection"
export * from "./atproto";
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

// Arktype schemas (Slice 1) and validated XRPC transport (Slice 3).
export * as schemas from "./schemas/index";
export * as transport from "./transport/index";
export { type RateLimitRetryOptions } from "./transport/index";
