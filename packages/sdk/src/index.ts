export * from "./schema";
// Rich text (blocks + facets) types and converters.
export * from "./schema/richtext";
export * from "./richtext/convert";
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

// Arktype schemas and validated XRPC transport.
export * as schemas from "./schemas/index";
export * as transport from "./transport/index";
export { type RateLimitRetryOptions } from "./transport/index";
export { type DirectXrpcClientOptions } from "./transport/index";
export { type ServiceAuthClientOptions } from "./transport/index";
