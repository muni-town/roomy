import { webOriginForAppserver } from "@roomy-space/sdk";

/**
 * The origins an absolute link may be rooted at to name a space/room this
 * client can look up: the origin this document is served from, and the web
 * origin of the appserver it talks to.
 *
 * A space reference is only meaningful on the appserver that materialises it,
 * so a deployment served at `roomy.space` talking to `api.roomy.space` treats
 * both `roomy.space` and its own origin as internal — while the same
 * deployment talking to a self-hosted appserver, or a staging deployment
 * (`api-staging.roomy.space` → `next.roomy.space`), treats only its own.
 *
 * Pure so the rule is testable without a document or a build env; the live
 * wiring is in `components/chat/enrich-internal-links.ts`.
 */
export function internalOriginsFor(
  appserver: string,
  documentOrigin: string,
): readonly string[] {
  const appserverOrigin = webOriginForAppserver(appserver) ?? "";
  if (!documentOrigin) return appserverOrigin ? [appserverOrigin] : [];
  if (!appserverOrigin || appserverOrigin === documentOrigin) {
    return [documentOrigin];
  }
  return [documentOrigin, appserverOrigin];
}
