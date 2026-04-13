# AGENTS.md

Guidance for AI coding agents working with this monorepo.

**Updated:** 2026-04-13

## Architecture Direction

Roomy is migrating from a local-first architecture to a **thin-client / appserver model**:

- **Removing** SQLite WASM in the browser, the three-tier worker architecture, and client-side materialisation
- **Adding** `packages/appserver` — a Bun/TypeScript service exposing an XRPC interface (HTTP queries + WebSocket subscriptions)
- **Replacing** `LiveQuery` calls in the client with WebSocket XRPC subscriptions
- **Adapter pattern** — the appserver wraps the existing Leaf event-stream backend; it is intentionally temporary and will be replaced by a Rust service

See `packages/appserver/docs/plans/appserver-architecture.md` for full design, migration phases, and research requirements.

**Current phase:** Phase 0 — scaffolding, lexicon design, research.

## Monorepo Structure

```
roomy/
├── packages/
│   ├── app/              # SvelteKit web application (being simplified)
│   ├── appserver/        # XRPC appserver — NEW (Bun + TypeScript)
│   ├── sdk/              # @roomy-space/sdk - Core SDK for Roomy clients
│   ├── discord-bridge/   # Discord↔Roomy bridge service
│   └── tsconfig/         # Shared TypeScript configuration
├── compose.yaml          # Development services (Leaf, Grafana stack)
├── turbo.json            # Build orchestration
└── pnpm-workspace.yaml   # Workspace configuration
```

## Commands

### Development

```bash
pnpm dev                    # Start web app on 127.0.0.1:5173
pnpm dev:bridge             # Start Discord bridge service
pnpm dev:all                # Start all services + monitoring
```

### Building

```bash
pnpm build                  # Build all packages via turbo
pnpm build-web-app          # Build web app via Vite
pnpm build-web-app-prod     # Production build with OAuth manifest
pnpm build:t                # Build Tauri desktop app
pnpm publish-packages       # Version & publish SDK to npm
```

### Testing (packages/app)

```bash
pnpm test                   # Unit tests (Vitest)
pnpm test:e2e               # E2E tests (Playwright)
pnpm test:robot             # Integration tests (Robot Framework)
pnpm check                  # TypeScript type checking (svelte-check)
```

### Running a Single Test

```bash
uv run robot --outputdir tests/robot/results tests/robot/smoke.robot
pnpm test:e2e tests/e2e/app.spec.ts
pnpm test src/lib/workers/encoding.test.ts
```

## Package: app (Web Application)

The main SvelteKit application. **Under active refactor** — the three-tier worker architecture is being replaced by a thin client that delegates to `packages/appserver` via XRPC.

**Current (legacy) architecture:**
```
UI Thread (Svelte Components)
    ↓
Shared Worker (Peer Worker)        ← being removed
    - Authentication & OAuth
    - Stream subscriptions
    ↓
Dedicated Worker (SQLite Worker)   ← being removed
    - SQLite WASM database
    - Event materialization
    - Live queries
```

**Target architecture:**
```
UI Thread (Svelte Components)
    Tanstack DB (in-memory IVM, reactive)
        ↓ XRPC fetch / WebSocket
    Appserver (packages/appserver)
```

Server pushes row-level diffs → Tanstack DB mutates in-memory tables → Svelte 5 runes observe query results.

### Key Directories

- `src/lib/workers/` - Worker architecture (being removed)
- `src/lib/components/` - UI components
- `src/lib/queries/` - Live query system (being replaced by XRPC client wrappers)
- `src/lib/mutations/` - State mutations
- `src/routes/` - SvelteKit routes

### Feature Flags

Configured in `src/lib/config.ts`:

- `sharedWorker` - Enable shared worker architecture
- `discordBridge` - Discord integration features
- `discordImport` - Discord import functionality
- `threadsList` - Threads list view

### Debug Helpers

Available in browser console:

```javascript
window.debugWorkers.enableLogForwarding();
window.debugWorkers.pingPeer();
window.debugWorkers.testSqliteConnection();
window.debugWorkers.logWorkerStatus();
window.debugWorkers.diagnoseRoom(roomId);
```

## Package: sdk (@roomy-space/sdk)

Core SDK for building Roomy clients. Published to npm.

**Key Exports:**

- `RoomyClient` - Main client for connecting to spaces
- `ConnectedSpace` - Individual space connection management
- `AsyncChannel` - Event streaming between workers
- AT Protocol utilities and schema definitions

**Source Structure:**

- `src/schema/` - Lexicon definitions
- `src/client/` - RoomyClient implementation
- `src/connection/` - Stream connection logic
- `src/leaf/` - Leaf server integration

## Package: appserver (NEW — Phase 0)

Bun/TypeScript service providing the XRPC interface between the thin client and the Leaf event-stream backend. **No running code yet — scaffolding and research phase.**

**Planned structure:**
- `src/index.ts` - Bun server entry point
- `src/auth.ts` - ATProto JWT validation middleware
- `src/routes/` - XRPC handler registry
- `src/materializers/` - Event materialisation (ported from `packages/sdk/src/schema/events/`)
- `src/db/` - SQLite/LibSQL schema + query helpers (server-side persistence)
- `lexicons/` - ATProto JSON lexicon definitions

**Key design constraints:**
- Server-side persistence: SQLite (`bun:sqlite`) or LibSQL — materialised views survive restarts
- Client-side IVM: Tanstack DB in the browser (reactive in-memory, no persistence needed)
- Auth required: ATProto session JWT validation, per-space access control
- Dockerised for deployment
- Interface is the contract: lexicons defined here become the real on-protocol interface

See `packages/appserver/docs/plans/appserver-architecture.md` for full spec, research requirements, and migration phases.

## Package: discord-bridge

Node.js service bridging Discord servers to Roomy spaces.

**Key Components:**

- `src/discord/bot.ts` - Discord bot and event handlers
- `src/discord/slashCommands.ts` - Slash command definitions
- `src/roomy/client.ts` - Roomy client initialization
- `src/roomy/to.ts` - Roomy→Discord message routing
- `src/roomy/from.ts` - Discord→Roomy message routing
- `src/db.ts` - LevelDB storage for bridge mappings
- `src/api.ts` - REST endpoints

**Dependencies:** `@discordeno/bot`, `@roomy-space/sdk`, `classic-level`, OpenTelemetry

## Development Services (compose.yaml)

```bash
docker compose up -d        # Start all services
```

**Core Services:**

- `leaf-server` (5530) - Event stream backend
- `plc-directory` (3001) - DID resolution
- `plc-db` - PostgreSQL for PLC

**Observability Stack:**

- `grafana` (3000) - Dashboards
- `tempo` (3200) - Traces
- `loki` (3100) - Logs
- `mimir` (9009) - Metrics
- `pyroscope` (4040) - Profiling
- `alloy` (5005) - Telemetry collection

## Key Libraries

**UI (app):**

- Svelte 5 with runes API
- SvelteKit 2.x
- Tailwind CSS 4.x
- TipTap rich text editor

**AT Protocol:**

- `@atproto/api` - AT Protocol client
- `@atproto/oauth-client` - OAuth
- `@muni-town/leaf-client` - Leaf server client

**Database:**

- `@sqlite.org/sqlite-wasm` - SQLite in WebAssembly

## Development Practices

### TypeScript

Strict settings across all packages:

- `strict: true`
- `noUnusedLocals: true`
- `noUnusedParameters: true`
- `noImplicitAny: true`
- `noUncheckedIndexedAccess: true`

### Authentication Modes (app)

1. **OAuth (Production):** Standard AT Protocol OAuth
2. **App Password (Testing):** Via environment variables

```env
PUBLIC_TEST_IDENTIFIER=your-handle.bsky.social
PUBLIC_TEST_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

### Required HTTP Headers (app)

For SharedArrayBuffer/OPFS support:

```
Cross-Origin-Embedder-Policy: credentialless
Cross-Origin-Opener-Policy: same-origin
```

### Deployment Targets (app)

1. **Netlify** - `@sveltejs/adapter-netlify`
2. **Static** - `@sveltejs/adapter-static`
3. **Tauri** - Desktop builds

## Reference Files

When creating reference files:

1. Prefix with `.llm.` (e.g., `.llm.workers.md`)
2. Include date and commit hash at top
