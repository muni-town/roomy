/**
 * Wires the internal-link renderer to this client.
 *
 * The renderer itself — the `use:` action over a rendered body and the facet
 * walk — lives in `@roomy/design`; what it cannot know is this deployment's own
 * origins, how a space/room summary is fetched, and which space the reader is
 * in. Those are declared here, once, at module load, so the configuration is in
 * place before the first message renders: importing this module is the wiring.
 *
 * The design surface is re-exported so a caller reaches the renderer through
 * the module that configures it, not around it.
 */

import { configureInternalLinks } from "@roomy/design/components/content/thread/message/enrich-internal-links.js";
import { internalLinkOrigins } from "@roomy/design/utils";
import { CONFIG } from "$lib/config";
import { internalOriginsFor } from "$lib/internal-link-origins";
import {
  resolveRoomSummary,
  resolveSpaceSummary,
} from "$lib/queries/badge-summaries";
import { currentSpaceState } from "$lib/components/layout/current-space.svelte";

export { internalLinkOrigins };
export {
  enrichInternalLinks,
  enrichInternalLinksFromBlocks,
} from "@roomy/design/components/content/thread/message/enrich-internal-links.js";
export type { InternalLinkTarget } from "@roomy/design/components/content/thread/message/enrich-internal-links.js";

configureInternalLinks({
  // The origin this document is served from, plus the web origin of the
  // appserver it talks to. See `internal-link-origins.ts`.
  origins: internalOriginsFor(
    CONFIG.appserverDid,
    typeof location !== "undefined" ? location.origin : "",
  ),
  resolveSpace: resolveSpaceSummary,
  resolveRoom: resolveRoomSummary,
  // Read through on every render rather than captured: navigating between
  // spaces reuses a mounted badge, and the suppression of the current space's
  // own name must follow.
  isCurrentSpace: (spaceId) => currentSpaceState.value?.id === spaceId,
});
