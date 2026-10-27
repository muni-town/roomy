/**
 * Tests for the tile telemetry seam: what names a tile, what each announced
 * phase turns into, and when a view or an expansion is reported.
 *
 * The identity rule is the one with a privacy cost if it slips: a tile's event
 * attribute must be a digest of its AT-URI, because the URI embeds the tile
 * author's DID and the DID must never reach a telemetry property. The digest
 * must also be stable, or "how many times was this tile opened" is not a
 * question the data can answer.
 *
 * The dedupe store is injected rather than taken from the global, so the
 * session rules are tested without a browser and without touching
 * `sessionStorage`.
 *
 * Written against `node:test` + `node:assert` so the file runs under the
 * package's `node --test` runner.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// `@roomy/design` ships source, and its subpath exports name `.js` files that
// exist as `.ts`. The bundler maps them; node needs the mapping spelled out.
const DESIGN_ACTIVITY =
  "@roomy/design/components/content/thread/message/tiles/tile-activity.js";
const FARO = "test-stub:faro";
const DESIGN_ACTIVITY_SOURCE = new URL(
  "../../../../design/src/components/content/thread/message/tiles/tile-activity.ts",
  import.meta.url,
).href;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === DESIGN_ACTIVITY) {
      return { url: DESIGN_ACTIVITY_SOURCE, shortCircuit: true };
    }
    // The transport is the browser SDK over `$app/environment` and
    // `$lib/config`; the seam's own logic is what these tests cover.
    if (specifier === "./faro") {
      return { url: FARO, shortCircuit: true, format: "module" };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === FARO) {
      return {
        format: "module",
        shortCircuit: true,
        source: "export function trackEvent() {}",
      };
    }
    return next(url, context);
  },
});

// Dynamic because the hook above must be in place before the module graph
// loads; every other dependency of the seam is a static import.
const {
  claimTileReport,
  hashTileUri,
  tileActivityAttributes,
  tileDedupeKey,
  TILE_EVENT_BY_PHASE,
  tilePostAttributes,
} = await import("./tile-events.ts");

const TILE = "at://did:plc:izttpdp3l6vss5crelt5kcux/ing.dasl.masl/3mcjwwoqjqs2v";
const OTHER_TILE = "at://did:plc:izttpdp3l6vss5crelt5kcux/ing.dasl.masl/3meggnybzqs2n";

describe("hashTileUri", () => {
  test("is 16 lower-case hex characters", async () => {
    assert.match(await hashTileUri(TILE), /^[0-9a-f]{16}$/);
  });

  test("is stable for the same address and different for another", async () => {
    assert.equal(await hashTileUri(TILE), await hashTileUri(TILE));
    assert.notEqual(await hashTileUri(TILE), await hashTileUri(OTHER_TILE));
  });

  test("does not carry the DID the address embeds", async () => {
    assert.ok(!(await hashTileUri(TILE)).includes("did:plc"));
  });
});

describe("TILE_EVENT_BY_PHASE", () => {
  test("maps each phase to its event name", () => {
    assert.deepEqual(TILE_EVENT_BY_PHASE, {
      view: "tile_view",
      expand: "tile_expand",
      error: "tile_error",
    });
  });
});

describe("tileActivityAttributes", () => {
  const tile = "0123456789abcdef";

  test("a view names the tile and the surface", () => {
    assert.deepEqual(
      tileActivityAttributes({ phase: "view", uri: TILE, surface: "chat" }, tile),
      { tile, surface: "chat" },
    );
  });

  test("an expansion names the tile and the surface", () => {
    assert.deepEqual(
      tileActivityAttributes({ phase: "expand", uri: TILE, surface: "search" }, tile),
      { tile, surface: "search" },
    );
  });

  test("an error adds its classified reason", () => {
    assert.deepEqual(
      tileActivityAttributes(
        { phase: "error", uri: TILE, surface: "feed", reason: "manifest" },
        tile,
      ),
      { tile, surface: "feed", reason: "manifest" },
    );
  });

  test("carries no raw address", () => {
    const attributes = tileActivityAttributes(
      { phase: "view", uri: TILE, surface: "page" },
      tile,
    );
    for (const value of Object.values(attributes)) {
      assert.ok(!value.includes("at://"));
      assert.ok(!value.includes("did:plc"));
    }
  });
});

describe("tilePostAttributes", () => {
  test("reports the count as an integer string and its source", () => {
    assert.deepEqual(tilePostAttributes(3, "attachment"), {
      count: "3",
      source: "attachment",
    });
    assert.deepEqual(tilePostAttributes(1, "inline"), {
      count: "1",
      source: "inline",
    });
  });
});

describe("tileDedupeKey", () => {
  test("is the documented sessionStorage key", () => {
    assert.equal(tileDedupeKey("view", "abc"), "tile-view:abc");
    assert.equal(tileDedupeKey("expand", "abc"), "tile-expand:abc");
  });
});

/** A `sessionStorage` stand-in: a map, unless `failOn` makes an operation throw. */
function stubStore(failOn?: "getItem" | "setItem") {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem(key: string) {
      if (failOn === "getItem") throw new Error("blocked");
      return entries.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (failOn === "setItem") throw new Error("quota");
      entries.set(key, value);
    },
  };
}

describe("claimTileReport", () => {
  test("the first report of a key is claimed and later ones are not", () => {
    const store = stubStore();
    assert.equal(claimTileReport(store, "tile-view:abc"), true);
    assert.equal(claimTileReport(store, "tile-view:abc"), false);
  });

  test("each key is claimed independently", () => {
    const store = stubStore();
    assert.equal(claimTileReport(store, "tile-view:abc"), true);
    assert.equal(claimTileReport(store, "tile-expand:abc"), true);
    assert.equal(claimTileReport(store, "tile-view:def"), true);
  });

  test("an unreadable store still lets the report through", () => {
    assert.equal(claimTileReport(stubStore("getItem"), "tile-view:abc"), true);
  });

  test("an unwritable store still lets the report through without throwing", () => {
    assert.equal(claimTileReport(stubStore("setItem"), "tile-view:abc"), true);
  });

  test("no store at all still lets the report through", () => {
    assert.equal(claimTileReport(undefined, "tile-view:abc"), true);
  });
});
