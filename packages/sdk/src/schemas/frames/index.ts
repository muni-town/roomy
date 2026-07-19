/**
 * Namespaced re-exports of every WS frame schema.
 *
 * Server → client frames (CBOR body, paired with a header `{op, t}`):
 *   - messageDiff (#messageDiff)
 *   - roomMetadataDiff (#roomMetadataDiff)
 *   - invalidate (#invalidate)
 *   - error (#error)
 *
 * Client → server messages (JSON text frames):
 *   - clientMessage (sub / unsub / cursor)
 */
export * as messageDiff from "./messageDiff";
export * as roomMetadataDiff from "./roomMetadataDiff";
export * as invalidate from "./invalidate";
export * as errorFrame from "./error";
export * as clientMessage from "./clientMessage";
