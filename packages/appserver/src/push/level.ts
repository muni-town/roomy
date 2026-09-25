/**
 * The four notification "update rhythms" shared across the push lexicons,
 * the preference store, and the evaluator.
 *
 *   silent — no notifications
 *   quiet  — silent except mentions and replies to your own messages, which
 *            get an immediate push
 *   engaged — mentions and replies get an immediate push; other messages are
 *             batched into occasional digest prompts for missed conversations
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