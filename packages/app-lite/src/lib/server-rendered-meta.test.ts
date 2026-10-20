/**
 * The server-rendered head is only as good as the route that carries it.
 *
 * A crawler fetches `/<space-did>` or `/<space-did>/<room-ulid>` and runs no
 * bundle, so the tags have to come from a server load, be fed into the route's
 * `SeoMeta` (which otherwise renders from a client query that has not answered
 * yet), and be fetched anonymously — a crawler holds no session, and a tag set
 * that depends on one is invisible to exactly the caller it exists for.
 *
 * This is a structural test, in the same spirit as `og-tags.test.ts`: it reads
 * the tree, not a build. The artifact-level assertion that the rendered document
 * actually carries the tags lives in `e2e/server-rendered-meta.spec.ts` — a
 * component can hold the right tag and still not reach `</head>`, which is how
 * the room-title regression happened.
 *
 * Written against `node:test` + `node:assert` so it runs under both `bun test`
 * and `node --test --experimental-strip-types` (app-lite ships no test runner
 * of its own).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const routes = new URL("../routes/", import.meta.url);

/** `source` with its comments removed — the code, not the prose about it. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** Every file under `src/routes/<dir>`, as paths relative to `src/routes`. */
function routeFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(new URL(dir + "/", routes))) {
    const child = `${dir}/${entry}`;
    if (statSync(new URL(child, routes)).isDirectory()) {
      found.push(...routeFiles(child));
    } else {
      found.push(child);
    }
  }
  return found;
}

describe("the space subtree renders on the server", () => {
  test("no route under [space] opts out of SSR", () => {
    // `ssr = false` on any node of the subtree takes the whole document back to
    // the static shell, and the per-space tags with it.
    const offenders = routeFiles("[space]").filter((file) =>
      /\bexport const ssr\s*=\s*false/.test(read(`../routes/${file}`)),
    );
    assert.deepEqual(offenders, []);
  });

  test("[space] reads its metadata anonymously on the server", () => {
    // The layout, not the space index page: the layout's SeoMeta is what names a
    // space, it covers a room too, and a nested page's `parent()` and merged
    // `data` reach layouts — a sibling page's load is nobody's ancestor.
    const load = read("../routes/[space]/+layout.server.ts");
    assert.match(load, /space\.roomy\.space\.getMetadata/);
    assert.match(load, /publicXrpc/);
  });

  test("[space]/[room] adds the room's own name to the space's context", () => {
    const load = read("../routes/[space]/[room]/+page.server.ts");
    assert.match(load, /space\.roomy\.room\.getMetadata/);
    assert.match(load, /await parent\(\)/);
  });
});

describe("M1b: profile and invite links unfurl too", () => {
  test("user/[user] reads the profile on the server", () => {
    const load = read("../routes/user/[user]/+page.server.ts");
    assert.match(load, /space\.roomy\.user\.getProfile/);
  });

  test("join/[[spaceRef]] resolves the ref and reads the space on the server", () => {
    // The route where the read matters most: an invite link's unfurl is the
    // invitation's first impression, and the space it names may be invite-only.
    const load = read("../routes/join/[[spaceRef]]/+page.server.ts");
    assert.match(load, /resolveSpaceRef/);
    assert.match(load, /space\.roomy\.space\.getMetadata/);
  });
});

describe("the server read path is anonymous and total", () => {

  const mod = code(read("./server/public-space.ts"));

  test("never sends the caller's credentials", () => {
    // The response is served to whoever asked for the document, so the request
    // behind it must carry nothing of theirs: no `Authorization`, no cookies,
    // and not the load's `event.fetch` (which would inherit the request's).
    assert.doesNotMatch(mod, /authorization/i);
    assert.doesNotMatch(mod, /cookie/i);
    assert.doesNotMatch(mod, /event\.fetch/);
  });

  test("degrades to null instead of throwing", () => {
    // Nonexistent space, invite-only space, rate limit, network failure: one
    // outcome. The document has to be served in every case.
    assert.match(mod, /return null/);
    assert.match(mod, /catch\s*\{/);
  });

  test("resolves the appserver origin for the server, not from the client cache", () => {
    assert.match(mod, /APP_SERVER_HTTP_ORIGIN/);
    assert.match(mod, /resolveAppserverHttpOrigin/);
  });

  test("a rendered document does not cost one XRPC request", () => {
    // The appserver limits per client IP before its response cache, and the
    // server is one IP for every visitor: an uncached read here is a budget
    // the site spends once per rendered document. See `server/read-cache.ts`.
    assert.match(mod, /readThrough\(/);
    assert.match(mod, /createReadCache/);
  });
});

describe("the server's own read reaches the head", () => {
  test("the space layout feeds SeoMeta from the server load", () => {
    // Without this the first pass renders the runtime default and the per-space
    // tags exist only once the bundle runs — the bug this slice is about.
    assert.match(read("../routes/[space]/+layout.svelte"), /data\.spaceMeta/);
  });

  test("the room page feeds SeoMeta from the server load", () => {
    const page = read("../routes/[space]/[room]/+page.svelte");
    assert.match(page, /data\.roomMeta/);
    assert.match(page, /data\.spaceMeta/);
  });

  test("profile and join pages feed SeoMeta from the server load", () => {
    assert.match(read("../routes/user/[user]/+page.svelte"), /data\.profileMeta/);
    assert.match(read("../routes/join/[[spaceRef]]/+page.svelte"), /data\.spaceMeta/);
  });
});
