/**
 * The address a Web Tile answers to, and whether a string is one.
 *
 * A tile is an `ing.dasl.masl` record on a PDS, so the only address it has is
 * that record's AT-URI: `at://<repo>/ing.dasl.masl/<rkey>`. `ATTileLoader`
 * (`@dasl/tile-loader/at`) reads the manifest from that record and every
 * resource from the same PDS. For any other shape it declines to load, so a
 * caller that recognises a tile address can name the reason a string did not
 * load instead of passing the loader's blanket failure on to the user.
 *
 * Only `did:plc:` repositories are accepted: the loader's DID→PDS step is a
 * `plc.directory` lookup with no arm for `did:web`.
 *
 * Pure — no DOM, no build env, no imports — so it runs under the package's
 * `node --test` runner.
 */

/** A parsed tile address. */
export interface TileAddress {
  /** The repo holding the manifest record. */
  did: string;
  /** The manifest record's key within `ing.dasl.masl`. */
  rkey: string;
}

/** The collection a tile manifest is published under. */
export const TILE_COLLECTION = "ing.dasl.masl";

/** `did:plc:` followed by the base32 body the method uses. */
const PLC_DID = /^did:plc:[a-z2-7]+$/;

/**
 * ATProto record key, which is one or more of `[A-Za-z0-9._:~-]`. The rkeys a
 * loader sees in practice are TIDs.
 */
const RKEY = /^[A-Za-z0-9._~:-]+$/;

/**
 * Parse a tile AT-URI, or `null` if the string is not one.
 *
 * The shape is exact — scheme, a `did:plc:` authority, three path segments with
 * `ing.dasl.masl` as the collection — and a query or fragment makes it not a
 * record address, so it is rejected rather than stripped.
 */
export function parseTileAddress(uri: string): TileAddress | null {
  if (!uri.startsWith("at://")) return null;
  const rest = uri.slice("at://".length);
  if (rest.includes("?") || rest.includes("#")) return null;

  const segments = rest.split("/");
  if (segments.length !== 3) return null;
  const [did, collection, rkey] = segments;
  if (did === undefined || !PLC_DID.test(did)) return null;
  if (collection !== TILE_COLLECTION) return null;
  if (rkey === undefined || !RKEY.test(rkey)) return null;

  return { did, rkey };
}

/**
 * A run of characters a record address can be spelled with: the scheme, then
 * the `[A-Za-z0-9._~:/-]` alphabet of a DID authority, a collection and a
 * record key.
 *
 * Deliberately narrower than "everything up to whitespace", which makes the
 * run end where the address does. Prose attaches brackets, commas and quotes
 * to a bare address and every one of them is outside the alphabet, so nothing
 * has to be stripped back off; and `?` and `#` are outside it too, so a body
 * that spells the address with a query or a fragment still yields the record
 * address rather than nothing. A run spanning two addresses (`…/3abc,at://…`)
 * cannot occur for the same reason.
 */
const ADDRESS_RUN = /at:\/\/[A-Za-z0-9._~:/-]+/g;

/**
 * Every tile address spelled anywhere in the given text, in order, without
 * duplicates.
 *
 * `parseTileAddress` is the only thing that decides what counts as a tile, so
 * a run that is an address for some other collection, or a path that is not a
 * record address at all, is dropped here rather than reaching a loader that
 * would decline it without saying why. A run that continues past a record
 * address (`…/3abc/extra`) is not this address and is dropped too.
 *
 * Variadic because a message carries its text in more than one place: the
 * plain text of its blocks, and any URI a link facet points at
 * (`[label](at://…)` leaves no trace in the text). The caller passes what it
 * has and gets one answer.
 *
 * Pure — no DOM, no build env, no imports — so it runs under the package's
 * `node --test` runner.
 */
export function findTileAddresses(...texts: string[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const run of text.match(ADDRESS_RUN) ?? []) {
      // A full stop is inside the record-key alphabet, so the run absorbs the
      // one that ends the sentence it sits in (`…/3abc.`) and the key would
      // parse as `3abc.`. It is the only prose mark the alphabet admits, so it
      // is the only one to take back off.
      const uri = run.replace(/\.+$/, "");
      if (parseTileAddress(uri) !== null) found.add(uri);
    }
  }
  return [...found];
}
