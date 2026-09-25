/**
 * Sparse BM25 term weighting for Qdrant message search.
 *
 * Qdrant's sparse vectors support BM25 via the `idf` modifier on the
 * collection's sparse-vector config: the modifier applies IDF (inverse
 * document frequency, computed from collection statistics) to sparse
 * vectors AT QUERY TIME. So this encoder computes the document side of
 * the BM25 formula — term-frequency saturation — and Qdrant supplies the
 * query-time IDF half:
 *
 *   w(t, d) = tf(t, d) / (tf(t, d) + k1)
 *
 * with k1 = 1.2 (the standard BM25 saturation constant). Combined with
 * Qdrant's `idf` query modifier the effective score is BM25:
 *
 *   score = idf(t) * tf(t, d) / (tf(t, d) + k1)
 *
 * The collection must be created with
 * `sparse_vectors: { bm25: { modifier: "idf" } }` (see
 * `ensureMessagesCollection` in `src/search/qdrantSearch.ts`).
 *
 * No external tokenizer/embedding dependency — lowercase + split on
 * non-alphanumerics, matching the FTS5 `unicode61` tokenizer behaviour.
 * Output is a Qdrant sparse vector: sorted ascending
 * indices, one value per term. Values are strictly positive; repeated terms
 * weigh more than single occurrences (the tf saturation curve).
 */

/** BM25 k1 term-frequency saturation constant. */
export const BM25_K1 = 1.2;

export interface SparseVector {
  /** Term indices (in a stable hash-order), ascending. */
  indices: number[];
  /** One weight per index, aligned with `indices`. */
  values: number[];
}

/**
 * Stable FNV-1a 32-bit hash of a term → its vector index. Deterministic
 * across processes so re-indexed messages produce identical vectors.
 */
export function hashTerm(term: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < term.length; i++) {
    hash ^= term.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Map into the non-negative uint32 space (Qdrant indices are uint32).
  return hash >>> 0;
}

/**
 * Tokenize query or document text: lowercase, split on non-alphanumeric
 * runs. Non-ASCII letters are kept (they are alphanumeric per Unicode) so
 * accented/emoji-adjacent text still indexes; pure punctuation/whitespace
 * yields no tokens.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u00c0-\u024f\u1e00-\u1eff]+/u)
    .filter((t) => t.length > 0);
}

/**
 * Encode text as a BM25-tf sparse vector. Repeated terms weigh more (tf
 * saturation); empty text yields an empty vector.
 */
export function encodeSparse(text: string): SparseVector {
  const tf = new Map<string, number>();
  for (const term of tokenize(text)) {
    tf.set(term, (tf.get(term) ?? 0) + 1);
  }

  const entries = [...tf.entries()]
    .map(([term, count]) => ({
      index: hashTerm(term),
      value: count / (count + BM25_K1),
    }))
    .sort((a, b) => a.index - b.index);

  return {
    indices: entries.map((e) => e.index),
    values: entries.map((e) => e.value),
  };
}
