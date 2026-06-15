/**
 * DID → service endpoint resolution.
 *
 * Resolves a DID document and extracts the `#space_roomy_appserver`
 * service endpoint, converting it to a WebSocket or HTTP origin.
 *
 * Currently supports `did:web` only. `did:plc` can be added later
 * by extending `resolveDidDocument`.
 */

/**
 * Resolve the WebSocket origin from an appserver DID by fetching
 * its DID document and reading the `#space_roomy_appserver` service endpoint.
 *
 * Converts `https://` → `wss://` and `http://` → `ws://`.
 */
export async function resolveAppserverWsOrigin(
	appserverDid: string,
): Promise<string> {
	const endpoint = await resolveAppserverEndpoint(appserverDid);
	return endpoint.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}

/**
 * Resolve the HTTP origin from an appserver DID by fetching
 * its DID document and reading the `#space_roomy_appserver` service endpoint.
 *
 * Returns the endpoint as-is (e.g. `https://appserver.roomy.chat`).
 */
export async function resolveAppserverHttpOrigin(
	appserverDid: string,
): Promise<string> {
	return resolveAppserverEndpoint(appserverDid);
}

/**
 * Resolve the `#space_roomy_appserver` service endpoint from a DID document.
 */
async function resolveAppserverEndpoint(appserverDid: string): Promise<string> {
	const didDoc = await resolveDidDocument(appserverDid);

	const service = didDoc.service?.find(
		(s: any) =>
			s.id === "#space_roomy_appserver" ||
			s.id === `${appserverDid}#space_roomy_appserver`,
	);

	if (!service?.serviceEndpoint) {
		throw new Error(
			`No #space_roomy_appserver service found in DID document for ${appserverDid}`,
		);
	}

	const endpoint: string = service.serviceEndpoint;
	// Strip trailing slash so callers can safely append paths like /xrpc/...
	return endpoint.replace(/\/+$/, "");
}

async function resolveDidDocument(did: string): Promise<any> {
	if (did.startsWith("did:web:")) {
		const domain = did.slice("did:web:".length);
		const url = `${did.startsWith("did:web:localhost") ? "http" : "https"}://${decodeURIComponent(domain)}/.well-known/did.json`;
		const res = await fetch(url);
		if (!res.ok) throw new Error(`Failed to resolve ${did}: ${res.status}`);
		return res.json();
	}
	throw new Error(`Unsupported DID method: ${did}`);
}
