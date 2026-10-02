/**
 * The restore validator: the trust check a persisted entry must pass before
 * it may be hydrated into the live cache.
 *
 * `hydrate` is not a validator (measured: it accepts a wrong-typed `data`, an
 * entry with no `queryKey`, and a non-numeric `dataUpdatedAt`), so a snapshot
 * that leans on it can put a row into the timeline that the server's page
 * never puts there — and, because a hydrated entry is not stale under
 * `staleTime: Infinity`, nothing repairs it.
 *
 * The check is scoped to the timeline (`space.roomy.room.getMessages`), whose
 * ordering key is server-owned (`coalesce(sort_idx, id)`, id tie-break — see
 * `sync/diff.ts`). Every other query is passed through: its shape is covered
 * by the persisted-shape version (`readSnapshot`), and this module validates
 * the one invariant the version cannot — the order of a restored list.
 *
 * The rule, per element and per entry:
 *
 *   - an element that does not parse as a `Message` is dropped;
 *   - an element that is not a system message and carries no `sort_idx` is
 *     dropped — it cannot be placed by the server's key. This is a snapshot
 *     written before the ordering key existed, a shape that lost the field,
 *     or an optimistic placeholder (which is deliberately never persisted,
 *     see `mutations/pending-sends.svelte.ts`);
 *   - the survivors are re-sorted with the comparator the diff applicator and
 *     the read path use, so a list restored in the wrong order is repaired
 *     rather than rendered;
 *   - an entry whose data is not an array, or a non-empty array from which
 *     nothing survived, is dropped whole.
 */
import { type } from "arktype";
import { Message as MessageSchema } from "../schemas/queries/_message";
import { compareTimelineOrder, type Message } from "../sync/diff";
import type { Diagnostic, PersistedEntry } from "./persister";

const GET_MESSAGES_NSID = "space.roomy.room.getMessages" as const;

function defaultDiagnostic(message: string, detail?: unknown): void {
  if (detail === undefined) console.warn(message);
  else console.warn(message, detail);
}

/**
 * Apply the restore trust rules to loaded entries.
 *
 * Returns a new array; a timeline entry whose order changed is a new object,
 * so the caller's snapshot is never mutated.
 */
export function validateRestoredEntries(
  entries: readonly PersistedEntry[],
  onDiagnostic?: Diagnostic,
): PersistedEntry[] {
  const diag = onDiagnostic ?? defaultDiagnostic;
  const out: PersistedEntry[] = [];
  for (const entry of entries) {
    if (entry.key[0] !== GET_MESSAGES_NSID) {
      out.push(entry);
      continue;
    }
    const validated = validateMessageList(entry, diag);
    if (validated) out.push(validated);
  }
  return out;
}

function validateMessageList(
  entry: PersistedEntry,
  diag: Diagnostic,
): PersistedEntry | undefined {
  const data = entry.state;
  if (!Array.isArray(data)) {
    diag("cache: dropping a timeline entry whose data is not a list");
    return undefined;
  }

  const messages: Message[] = [];
  for (const candidate of data) {
    const parsed = MessageSchema(candidate);
    if (parsed instanceof type.errors) {
      diag("cache: dropping a row that is not a Message");
      continue;
    }
    if (parsed.system !== true && typeof parsed.sort_idx !== "string") {
      // A row with no ordering key cannot be placed by the key the server
      // pages by; the id fallback is a *different* key exactly where the two
      // disagree (bridged backfill, moves, an optimistic placeholder).
      diag("cache: dropping a message with no ordering key");
      continue;
    }
    messages.push(parsed);
  }

  if (messages.length === 0 && data.length > 0) {
    diag("cache: dropping a timeline entry with no restorable rows");
    return undefined;
  }

  messages.sort(compareTimelineOrder);
  return { ...entry, state: messages };
}
