export * from "./schema";
// Rich text (blocks + facets) types and converters.
export * from "./schema/richtext";
export * from "./richtext/convert";
// Roomy → Bluesky post export (pure).
export * from "./bluesky/post";
export type {
  DecodedStreamEvent,
  EventCallback,
  EventCallbackMeta,
  EncodedStreamEvent,
} from "./connection";
export * from "./atproto";
export * from "./client";
export * from "./utils";

// Operations
export * from "./operations/space";
export * from "./operations/message";
export * from "./operations/reaction";
export * from "./operations/room";

// Appserver sync
export * as sync from "./sync";

// Cache adapter contract + canonical query-key helper.
// Concrete adapter implementations live under subpath exports
// (e.g. `@roomy-space/sdk/browser`) so library-specific deps stay
// out of non-consuming bundles.
export * as cache from "./cache";
// The seam's types, named at the root: `export * as cache` yields a value
// namespace, so a consumer that implements `CachePersister` (the Node CLI's
// filesystem store) has no way to name the contract it implements. The
// browser subpath re-exports the same set for browser adaptors.
export type {
  CachePersister,
  Diagnostic,
  PersistedEntry,
  PersistedSnapshot,
  SnapshotPolicy,
} from "./cache";

// Arktype schemas and validated XRPC transport.
export * as schemas from "./schemas/index";
export * as transport from "./transport/index";
export { type RateLimitRetryOptions } from "./transport/index";
export { type DirectXrpcClientOptions } from "./transport/index";
export { type ServiceAuthClientOptions } from "./transport/index";
