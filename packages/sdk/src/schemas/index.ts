/**
 * `@roomy-space/sdk/schemas` — arktype schemas for every XRPC method and WS
 * frame used by the appserver / playground.
 *
 * Split:
 *   - `queries`   — GET-style read methods (params + response)
 *   - `procedures` — POST-style mutating methods (input + output)
 *   - `frames`    — WS push payloads + client→server messages
 *
 * Records (durable Leaf-stored entities) live under `src/schema/events/`
 * and are a different layer — not re-exported here.
 */
export * as queries from "./queries/index";
export * as procedures from "./procedures/index";
export * as frames from "./frames/index";
