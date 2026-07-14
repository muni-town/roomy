/**
 * The four notification "update rhythms" shared across the push lexicons,
 * the preference store, and the evaluator.
 *
 *   silent — no notifications
 *   quiet  — silent except mentions (mentions land in Phase 3; until then
 *            quiet behaves like silent)
 *   engaged — mentions + occasional digest prompts for missed conversations
 *             (digest lands in Phase 2; until then engaged runs digest-only
 *             and is effectively silent for immediate pushes)
 *   busy   — push on every new message in readable rooms you're in
 */
export type Level = "silent" | "quiet" | "engaged" | "busy";

export const LEVELS: readonly Level[] = ["silent", "quiet", "engaged", "busy"];

export function isLevel(value: unknown): value is Level {
  return (
    typeof value === "string" &&
    (value === "silent" ||
      value === "quiet" ||
      value === "engaged" ||
      value === "busy")
  );
}

/** Appserver default when a user has no preference row at all. */
export const DEFAULT_LEVEL: Level = "engaged";