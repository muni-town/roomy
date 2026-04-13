# Appserver Auth Design

**Date:** 2026-04-13
**Status:** Implemented
**Parent doc:** `appserver-architecture.md`

## Context

The Roomy appserver is a new Bun/TypeScript XRPC service that sits between the SvelteKit
frontend and the Leaf event-stream backend. Auth must validate real ATProto identities from
day one. The browser remains a public OAuth client (unchanged — no BFF/TMB in scope).

## Auth Mechanism: PDS Proxy + Inter-Service JWTs

The ATProto-native mechanism for authenticating to a third-party service without changing
the browser's OAuth flow is **PDS proxy with inter-service JWTs**:

1. Browser sends an HTTP request to its PDS with header:
   `atproto-proxy: did:web:appserver.roomy.chat#space_roomy_appserver`
2. PDS validates the user's OAuth session, resolves the target DID, creates a short-lived
   inter-service JWT: `iss = user DID`, `aud = appserver DID`, `lxm = NSID`, signed with
   the user's signing key from their DID document.
3. PDS forwards the request to the appserver's HTTPS endpoint.
4. Appserver validates: decode → check `aud` → check `exp` → resolve `iss` DID doc →
   verify signature → optionally check `lxm` matches called method → return `AuthCtx`.

This is stateless on the appserver side, reuses the user's existing OAuth session, and
requires no new browser OAuth logic.

### JWT Validation Detail

Inter-service JWTs use `alg: ES256K` (secp256k1) or `alg: ES256` (P-256) depending on
the user's signing key. The appserver:

1. Extracts `Bearer <jwt>` from `Authorization` header
2. Decodes the JWT payload (base64url decode, no crypto yet) to read `iss`, `aud`, `exp`
3. Validates `aud === OWN_DID` and `exp > now`
4. Resolves the `iss` DID document (with 30-minute cache):
   - `did:plc:*` → `GET ${PLC_DIRECTORY_URL}/{did}`
   - `did:web:*` → `GET {webDidToDocumentUrl(did)}`
5. Calls `getAtprotoVerificationMaterial(didDoc)` to find the `#atproto` verification method
6. Decodes `publicKeyMultibase` using base58btc decoding + multicodec prefix detection:
   - `[0xe7, 0x01]` prefix → secp256k1 (ES256K)
   - `[0x80, 0x24]` prefix → P-256 (ES256)
   - No prefix for `EcdsaSecp256k1VerificationKey2019` / `EcdsaSecp256r1VerificationKey2019`
7. Verifies the JWT signature using `@noble/curves` (secp256k1 or p256)
8. Returns `{ did: iss }`

Libraries used: `@atcute/identity`, `@atcute/multibase`, `@noble/curves`, `@noble/hashes`

## WebSocket Auth: Pre-Auth Tickets

PDS cannot proxy long-lived WebSocket connections. Solution: a ticket exchange.

1. Browser calls `POST /xrpc/space.roomy.auth.getConnectionTicket` via PDS proxy (full
   inter-service JWT auth).
2. Appserver validates JWT, issues a 32-byte hex ticket stored in memory with a 60-second
   TTL. Ticket is single-use.
3. Browser opens WebSocket directly: `wss://appserver.roomy.chat/xrpc/{nsid}?ticket=<t>&{params}`
4. In Bun's HTTP upgrade handler (before `server.upgrade()`): look up ticket → get DID →
   delete ticket → pass `auth: { did }` in `ws.data`. Return 401 if missing/expired.

## Infrastructure Requirement: Appserver DID Document

For PDS proxy to work, the appserver must be discoverable as an ATProto service. Serve
this static JSON document at `https://appserver.roomy.chat/.well-known/did.json`:

```json
{
  "@context": ["https://www.w3.org/ns/did/v1"],
  "id": "did:web:appserver.roomy.chat",
  "service": [
    {
      "id": "#space_roomy_appserver",
      "type": "RoomyAppserver",
      "serviceEndpoint": "https://appserver.roomy.chat"
    }
  ]
}
```

This is served by the Bun server itself at the `/.well-known/did.json` path.

## Local Development

Public PDSes (bsky.social etc.) cannot reach localhost. Developers need one of:
- A local ATProto PDS (`packages/pds/` exists in monorepo with `@atproto/pds`) routing
  to `localhost:2584`
- A tunnel (ngrok, cloudflare) exposing the local appserver

## Browser Client Changes

HTTP requests to the appserver route through the user's PDS:
- Request goes to: `https://{user-pds}/xrpc/{nsid}?{params}`
- With header: `atproto-proxy: did:web:appserver.roomy.chat#space_roomy_appserver`

The user's PDS endpoint is available from the existing OAuth session on the peer worker.
Browser XRPC client changes are part of the broader client migration, not this doc.

## Files Implemented

| File | Purpose |
|------|---------|
| `src/xrpc/auth.ts` | Inter-service JWT validator + ticket store |
| `src/xrpc/errors.ts` | XrpcError class |
| `src/xrpc/types.ts` | Shared TypeScript types |
| `src/xrpc/frame.ts` | ATProto frame encoding (CBOR) |
| `src/xrpc/router.ts` | XrpcRouter: HTTP + WebSocket routing |
| `src/handlers/space.roomy.auth.getConnectionTicket.ts` | Ticket issuance handler |
| `src/index.ts` | Bun server entry point; DID doc endpoint |
| `lexicons/space/roomy/auth/getConnectionTicket.json` | Lexicon |

## Related Documents

- `appserver-architecture.md` — overall architecture
- `xrpc-layer-plan.md` — XRPC routing layer implementation plan
- `livequery-inventory.md` — all 16 LiveQuery instances mapped to XRPC procedures
