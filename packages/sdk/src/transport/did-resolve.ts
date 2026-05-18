/**
 * DID → service endpoint resolution.
 *
 * Resolves a DID document and extracts the `#space_roomy_appserver`
 * service endpoint, converting it to a WebSocket origin.
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
export async function resolveAppserverWsOrigin(appserverDid: string): Promise<string> {
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
	return endpoint.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}

async function resolveDidDocument(did: string): Promise<any> {
	if (did.startsWith("did:web:")) {
		const domain = did.slice("did:web:".length);
		const url = `https://${domain}/.well-known/did.json`;
		const res = await fetch(url);
		if (!res.ok) throw new Error(`Failed to resolve ${did}: ${res.status}`);
		return res.json();
	}
	throw new Error(`Unsupported DID method: ${did}`);
}
