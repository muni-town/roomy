/**
 * Resolve the WebSocket origin from an appserver DID by fetching
 * its DID document and reading the #space_roomy_appserver service endpoint.
 */
export async function resolveAppserverWsOrigin(appserverDid: string): Promise<string> {
	// Resolve DID document
	const didDoc = await resolveDidDocument(appserverDid);

	// Find the #space_roomy_appserver service
	const service = didDoc.service?.find(
		(s: any) => s.id === "#space_roomy_appserver" || s.id === `${appserverDid}#space_roomy_appserver`,
	);

	if (!service?.serviceEndpoint) {
		throw new Error(`No #space_roomy_appserver service found in DID document for ${appserverDid}`);
	}

	// Convert https:// → wss://, http:// → ws://
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
