import { describe, expect, test } from "vitest";
import { marked } from "marked";
// Importing this module registers the `marked` link renderer that decides
// which links are marked as internal space/room references. We then call
// `marked.parse` directly (no DOMPurify → no DOM requirement) and assert on
// the raw HTML.
import "./markdown";
import { setInternalLinkOrigins } from "./markdown";

/** Whether rendered HTML marks the single link as internal (badge-mountable). */
function isInternal(markdown: string): boolean {
	const html = marked.parse(markdown, { async: false, breaks: true }) as string;
	return html.includes('data-roomy-internal-link="true"');
}

/** Origins a production deployment considers its own. */
const PRODUCTION = ["https://roomy.space"];
/** Origins a staging deployment considers its own. */
const STAGING = ["https://next.roomy.space"];
/** A self-hosted deployment is only its own origin. */
const SELF_HOSTED = ["https://chat.example.com"];

describe("internal-link marking in the marked renderer", () => {
	// Only a real (DID, ULID?) pair on the path of a relative link or a link
	// rooted at an origin this deployment owns is an internal space/room link.
	// App routes (/watch, /profile, …), non-DID segments
	// (roomy.space/muni-town), and other sites' paths must NOT be marked —
	// otherwise the badge prefetch fires 404 getSpaceSummary queries.

	test("marks valid relative space/room links", () => {
		setInternalLinkOrigins(PRODUCTION);
		expect(isInternal("[room](/did:plc:abc/01KZBRQMEP2FTE079YRVDFKGTA)")).toBe(true);
		expect(isInternal("[space](/did:plc:abc)")).toBe(true);
	});

	test("does not mark relative app routes", () => {
		setInternalLinkOrigins(PRODUCTION);
		expect(isInternal("[watch](/watch)")).toBe(false);
		expect(isInternal("[profile](/profile)")).toBe(false);
		expect(isInternal("[blog](/blog/essays)")).toBe(false);
	});

	test("marks a bare link to the deployment's own web origin", () => {
		setInternalLinkOrigins(PRODUCTION);
		expect(isInternal("https://roomy.space/did:plc:abc/01KZBRQMEP2FTE079YRVDFKGTA)")).toBe(true);
		expect(isInternal("https://roomy.space/did:plc:abc")).toBe(true);
	});

	test("marks the hosting of the appserver the deployment talks to", () => {
		// A staging deployment is served from next.roomy.space and serves the
		// staging appserver; a link to next.roomy.space is internal there.
		setInternalLinkOrigins(STAGING);
		expect(isInternal("https://next.roomy.space/did:plc:abc")).toBe(true);
		// Production's web origin is not this deployment's — it names a space
		// in a different appserver's world.
		expect(isInternal("https://roomy.space/did:plc:abc")).toBe(false);
	});

	test("does not mark links to Roomy hosts this deployment does not serve", () => {
		// a.roomy.space serves the marketing story, roomy.chat serves a landing
		// page; neither is the app, so a DID path there is that site's page.
		setInternalLinkOrigins(PRODUCTION);
		expect(isInternal("https://a.roomy.space/did:plc:abc")).toBe(false);
		expect(isInternal("https://roomy.chat/did:plc:abc")).toBe(false);
	});

	test("marks a self-hosted deployment's own origin", () => {
		setInternalLinkOrigins(SELF_HOSTED);
		expect(isInternal("https://chat.example.com/did:plc:abc")).toBe(true);
		expect(isInternal("https://roomy.space/did:plc:abc")).toBe(false);
	});

	test("does not mark bare links to non-DID segments", () => {
		setInternalLinkOrigins(PRODUCTION);
		expect(isInternal("https://roomy.space/muni-town")).toBe(false);
		expect(isInternal("https://roomy.space/profile")).toBe(false);
		expect(isInternal("https://roomy.space/watch")).toBe(false);
	});

	test("does not mark bare links with an invalid room id", () => {
		setInternalLinkOrigins(PRODUCTION);
		expect(isInternal("https://roomy.space/did:plc:abc/not-a-ulid")).toBe(false);
	});

	test("does not mark a DID path on a host that is not internal", () => {
		// Someone else's site may serve a `/did:plc:…` page (twinkl.social
		// does, for profile pages). Marking it internal makes the badge
		// prefetch ask this appserver to summarise a DID that only means
		// something to that site — a permanent 404, on every read.
		setInternalLinkOrigins(PRODUCTION);
		expect(isInternal("https://twinkl.social/did:plc:rqbqpaaluty5v47jwciowpik")).toBe(false);
		expect(isInternal("https://example.com/did:plc:abc/01KZBRQMEP2FTE079YRVDFKGTA")).toBe(false);
		expect(isInternal("https://roomy.space/did:plc:abc")).toBe(true);
	});

	test("a later origin change is reflected in newly rendered HTML", () => {
		// The render cache must not keep an answer computed under the previous
		// origins: the same markdown rendered by two deployments has to agree
		// with the deployment rendering it.
		setInternalLinkOrigins(SELF_HOSTED);
		expect(isInternal("https://roomy.space/did:plc:abc")).toBe(false);
		setInternalLinkOrigins(PRODUCTION);
		expect(isInternal("https://roomy.space/did:plc:abc")).toBe(true);
	});
});
