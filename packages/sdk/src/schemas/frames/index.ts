/**
 * Namespaced re-exports of every WS frame schema.
 *
 * Server → client frames (CBOR body, paired with a header `{op, t}`):
 *   - messageDiff (#messageDiff)
 *   - mention (#mention)
 *   - roomMetadataDiff (#roomMetadataDiff)
 *   - roomActivityDiff (#roomActivityDiff)
 *   - invalidate (#invalidate)
 *   - voicePresenceDiff (#voicePresenceDiff)
 *   - voiceStateDiff (#voiceStateDiff)
 *   - error (#error)
 *
 * Client → server messages (JSON text frames):
 *   - clientMessage (sub / unsub / cursor / voice_state)
 */
export * as messageDiff from "./messageDiff";
export * as mention from "./mention";
export * as roomMetadataDiff from "./roomMetadataDiff";
export * as roomActivityDiff from "./roomActivityDiff";
export * as invalidate from "./invalidate";
export * as errorFrame from "./error";
export * as voicePresenceDiff from "./voicePresenceDiff";
export * as voiceStateDiff from "./voiceStateDiff";
export * as clientMessage from "./clientMessage";
