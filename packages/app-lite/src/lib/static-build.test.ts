/**
 * The app is built with `adapter-static`: it ships as an SPA, and the served
 * document is a shell that boots the client bundle.
 *
 * A `+page.server.ts` / `+layout.server.ts` in the route tree contradicts that.
 * SvelteKit answers a server load by having the client fetch
 * `<route>/__data.json` on every navigation; a static host has no such file and
 * answers the path with the SPA fallback, so the client parses HTML as a data
 * stream, the load rejects, and the navigation never completes — the URL does
 * not change and a click on a space, room, profile or invite link does nothing.
 *
 * Nothing in a type check, a unit test or the Playwright suite catches that:
 * the e2e stack runs `vite dev`, which does have a server. This guard reads the
 * tree instead, and fails at the point the mistake is introduced.
 *
 * The guard belongs to the static artifact. A server build answers `__data.json`
 * itself, and will move this assertion rather than delete it.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";

const routes = new URL("../routes/", import.meta.url);

/** Every file under `src/routes`, as paths relative to it. */
function routeFiles(dir = ""): string[] {
  const found: string[] = [];
  // A relative `""` resolves to a bare "/", so the top level keeps the
  // routes URL itself rather than building one from the empty segment.
  const base = dir ? new URL(dir + "/", routes) : routes;
  for (const entry of readdirSync(base)) {
    const path = dir ? `${dir}/${entry}` : entry;
    if (statSync(new URL(path, routes)).isDirectory()) {
      found.push(...routeFiles(path));
    } else {
      found.push(path);
    }
  }
  return found;
}

describe("the static build ships no server loads", () => {
  test("no route declares +page.server.ts or +layout.server.ts", () => {
    // `+server.ts` is an endpoint, and the one in this tree is prerendered, so
    // it is a file in the build rather than a request at runtime.
    const offenders = routeFiles().filter((file) =>
      /\+(page|layout)\.server\.ts$/.test(file),
    );
    assert.deepEqual(
      offenders,
      [],
      "these routes make the client fetch __data.json, which a static host cannot answer: " +
        offenders.join(", "),
    );
  });
});
