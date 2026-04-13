# Appserver Authentication

## Overview

The appserver authenticates callers using **ATProto inter-service JWTs** proxied through the user's PDS. The browser never authenticates directly with the appserver — the PDS validates the user's OAuth session, mints a short-lived JWT, and forwards the request.

**WebSocket connections** use a separate ticket exchange because PDSes cannot proxy long-lived connections.

## HTTP Request Flow

```
Browser → PDS (atproto-proxy header) → Appserver (JWT validation)
```

1. Browser sends a request to its PDS with header:
   `atproto-proxy: did:web:appserver.roomy.chat#space_roomy_appserver`
2. PDS validates the user's OAuth session, creates an inter-service JWT:
   - `iss` = user DID
   - `aud` = appserver DID (`did:web:appserver.roomy.chat`)
   - `exp` = expiry timestamp
   - Signed with the user's DID signing key
3. PDS forwards the request to the appserver with `Authorization: Bearer <jwt>`
4. Appserver validates the JWT (see `prodAuthVerifier` below)

## WebSocket Auth Flow

```
Browser → PDS proxy → Appserver (ticket exchange)
Browser → Appserver direct (WebSocket with ?ticket=)
```

1. Browser calls `POST /xrpc/space.roomy.auth.getConnectionTicket` via PDS proxy (full JWT auth)
2. Appserver returns a 64-char hex ticket (single-use, 60-second TTL)
3. Browser opens a WebSocket directly to the appserver:
   `wss://appserver.roomy.chat/xrpc/{nsid}?ticket=<ticket>&{params}`

## Implementation

### File structure

```
src/
├── index.ts                          # Bun.serve entry, DID document, CORS
├── xrpc/
│   ├── auth.ts                       # JWT validation, DID resolution, ticket store
│   ├── router.ts                     # XRPC routing, WebSocket upgrade with ticket auth
│   ├── types.ts                      # AuthCtx, QueryHandler, SubscriptionHandler, etc.
│   ├── errors.ts                     # XrpcError class
│   ├── frame.ts                      # CBOR frame encoding for subscriptions
│   └── index.ts                      # Barrel re-export
├── handlers/
│   └── space.roomy.auth.getConnectionTicket.ts
└── lexicons/
    └── space/roomy/auth/getConnectionTicket.json
```

### `prodAuthVerifier` (`src/xrpc/auth.ts`)

Validates every HTTP request. Steps:

1. Extract `Bearer <jwt>` from `Authorization` header
2. Decode JWT payload (base64url, no crypto) to read `iss`, `aud`, `exp`
3. Verify `aud` matches `APPSERVER_DID` env var (default: `did:web:appserver.roomy.chat`)
4. Verify `exp` is in the future
5. Resolve `iss` DID document (did:plc via PLC directory, did:web via HTTPS, 30-minute cache)
6. Extract signing key using `getAtprotoVerificationMaterial` from `@atcute/identity`
7. Decode multibase key, detect algorithm via multicodec prefix (secp256k1 or P-256)
8. Verify JWT signature using `@noble/curves` (ES256K or ES256)

Returns `AuthCtx: { did: string }` on success, throws `XrpcError(401)` on any failure.

### Ticket store (`src/xrpc/auth.ts`)

- `issueTicket(did)` — generates a 32-byte random hex token, stores with DID and 60s TTL
- `consumeTicket(ticket)` — single-use lookup, deletes immediately, throws 401 if missing/expired
- Periodic cleanup every 5 minutes removes expired entries

### Router (`src/xrpc/router.ts`)

Route registration via `.query()`, `.procedure()`, `.subscription()`. The fetch handler:

- **HTTP queries/procedures**: run through `prodAuthVerifier`, then call handler
- **Subscriptions**: extract `?ticket=` param, call `consumeTicket()`, upgrade to WebSocket

### DID Document (`src/index.ts`)

Served at `/.well-known/did.json` with service entry `#space_roomy_appserver`. Configurable via `APPSERVER_DID` and `APPSERVER_ORIGIN` env vars.

## Configuration

| Env Var | Default | Purpose |
|---------|---------|---------|
| `APPSERVER_DID` | `did:web:appserver.roomy.chat` | Expected JWT audience, DID document `id` |
| `APPSERVER_ORIGIN` | `https://appserver.roomy.chat` | DID document `serviceEndpoint` |
| `PLC_DIRECTORY_URL` | `https://plc.directory` | DID resolver for `did:plc` lookups |
| `PORT` | `8080` | Listen port |
| `CORS_ORIGIN` | `*` | Access-Control-Allow-Origin |

## Dependencies

- `@atcute/identity` — DID document parsing, key extraction (`getAtprotoVerificationMaterial`)
- `@atcute/multibase` — Base58BTC multibase decoding for public keys
- `@noble/curves` — ES256K (secp256k1) and ES256 (P-256) signature verification
- `@noble/hashes` — SHA-256 for JWT signing input hashing
- `@atcute/cbor` — CBOR encoding for subscription wire frames

## Local Development

Public PDSes (bsky.social etc.) cannot reach `localhost`. Options:

- Local ATProto PDS in the monorepo (`packages/pds/`) that can route to the appserver
- Tunnel (ngrok, cloudflare) exposing the appserver with a real hostname

The DID document must be resolvable at the configured `APPSERVER_ORIGIN` for PDS proxy to work.
