# AGENTS.md

Guidance for AI coding agents working with this monorepo.

**Updated:** 2026-07-03

## Architecture

Roomy uses a **thin-client / appserver model**:

- **`packages/app-lite`** — SvelteKit thin client (Svelte 5, Tanstack Query). No SQLite WASM, no workers, no client-side materialisation.
- **`packages/appserver`** — Bun/TypeScript service exposing an XRPC interface (HTTP queries + WebSocket subscriptions). Wraps the Leaf event-stream backend; intentionally temporary, will be replaced by a Rust service.
- Client communicates with the appserver via XRPC — Tanstack Query for HTTP queries, WebSocket for subscriptions.

See `packages/appserver/docs/plans/appserver-architecture.md` for full design.

## Monorepo Structure

```
roomy/
├── packages/
│   ├── app-lite/         # SvelteKit thin client — PRIMARY (Svelte 5, Tanstack Query, XRPC)
│   ├── appserver/        # XRPC appserver (Bun + TypeScript)
│   ├── design/           # @roomy/design — Shared design system, components, and icons
│   ├── sdk/              # @roomy-space/sdk - Core SDK for Roomy clients
│   ├── discord-bridge/   # Discord↔Roomy bridge service
│   ├── discord-bridge-legacy/  # Legacy Discord bridge (archived)
│   ├── playground/       # Experimental playground
│   ├── roomy-cli/        # CLI tool (placeholder)
│   └── tsconfig/         # Shared TypeScript configuration
├── compose.yaml          # Development services (Leaf, Grafana stack)
├── turbo.json            # Build orchestration
└── pnpm-workspace.yaml   # Workspace configuration
```

## Commands

### Development

```bash
pnpm dev                    # Start app-lite on 127.0.0.1:5180
pnpm dev:local              # Start full local stack (leaf + appserver + app-lite)
pnpm dev:bridge             # Start Discord bridge service
pnpm dev:all                # Start all services + monitoring
```

### Building

```bash
pnpm build                  # Build all packages via turbo
pnpm publish-packages       # Version & publish SDK to npm
```

### Type Checking & Tests

pnpm --filter app-lite check              # TypeScript check (svelte-check) for app-lite
pnpm --filter @roomy/appserver typecheck  # TypeScript check (tsc --noEmit) for appserver
bun test --cwd packages/appserver          # Unit tests (Bun test) for the appserver
pnpm --filter @roomy-space/sdk test       # Unit tests (Vitest) for the SDK
pnpm --filter @roomy/design test          # Unit tests (Vitest) for the design system
```

> Note: app-lite does not yet have its own test suite. The legacy `packages/app` test infrastructure (Vitest, Playwright, Robot Framework) was removed with the package — see the "Removed with app" section below.

## Package: app-lite (Primary Client — SvelteKit Thin Client)

The SvelteKit client application. A thin client that communicates with `packages/appserver` via XRPC — Tanstack Query for HTTP queries, WebSocket for subscriptions. No SQLite WASM, no workers, no client-side materialisation.

**Architecture:**
```
UI Thread (Svelte 5 Components)
    Tanstack Query (in-memory cache, reactive)
        ↓ XRPC fetch (HTTP) / WebSocket (subscriptions)
    Appserver (packages/appserver)
```

Server pushes row-level diffs → Tanstack Query cache updates → Svelte 5 runes observe query results.

### Key Directories

- `src/lib/components/` - UI components (chat, layout, sidebar, thread, auth)
- `src/lib/queries/` - Tanstack Query wrappers for XRPC calls
- `src/lib/mutations/` - XRPC mutation wrappers
- `src/lib/sync.svelte.ts` - WebSocket sync connection
- `src/lib/client.ts` - Tanstack Query client configuration
- `src/lib/config.ts` - App configuration (appserver DID, OAuth scope, feature flags)
- `src/routes/` - SvelteKit routes
- `scripts/build-prod.sh` - Production build with OAuth client metadata generation

### Production Build

The production build (`scripts/build-prod.sh`) runs `vite build` then generates `build/oauth-client-metadata.json` with the OAuth scope string, verifying at build time that every scope in `src/lib/config.ts` (`APPSERVER_RPCS` + `OAUTH_SCOPE`) is present in the generated metadata.

## Package: design (@roomy/design)

Shared design system used by app-lite. Contains reusable Svelte 5 components, icons, and utility functions.

**Key Exports:**

- `@roomy/design` — Main entry point (component index)
- `@roomy/design/icons` — Icon index
- `@roomy/design/utils` — Utility functions (cn, markdown)
- `@roomy/design/components/*` — Individual component imports

**Component Categories:**

- `content/thread/` — Thread content components
- `helper/` — Utility components (Drawer, LoadingSpinner, Tooltip, etc.)
- `layout/` — Layout components (Navbar, Sidebar, ScrollArea)
- `modals/` — Modal dialogs (CreateRoom, InviteManager, RoleEdit, etc.)
- `richtext/` — Rich text editor (TipTap-based)
- `sidebars/` — Sidebar layout components
- `spaces/` — Space avatar and card components
- `ui/` — Low-level UI primitives (buttons, inputs, popovers, context menus)
- `user/` — User-facing components (LoginScreen, UserMenu, ThemeSettings)

## Package: sdk (@roomy-space/sdk)

Core SDK for building Roomy clients. Published to npm.

**Key Exports:**

- `RoomyClient` - Main client for connecting to spaces
- `ConnectedSpace` - Individual space connection management
- `AsyncChannel` - Event streaming
- AT Protocol utilities and schema definitions

**Source Structure:**

- `src/schema/` - Lexicon definitions
- `src/client/` - RoomyClient implementation
- `src/connection/` - Stream connection logic
- `src/leaf/` - Leaf server integration

## Package: appserver

Bun/TypeScript service providing the XRPC interface between the thin client and the Leaf event-stream backend.

**Structure:**
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

**UI (app-lite):**

- Svelte 5 with runes API
- SvelteKit 2.x
- Tailwind CSS 4.x (via `@tailwindcss/vite`)
- `@tanstack/svelte-query` — Server state management (HTTP queries + cache)
- `@foxui/core` + `@foxui/social` — UI framework
- `bits-ui` — Headless UI primitives
- `virtua` — Virtual scrolling
- TipTap rich text editor (`@tiptap/core`, `@tiptap/pm`, `tiptap-markdown`)
- `@roomy/design` — Shared design system (workspace dependency)

**AT Protocol:**

- `@atproto/api` - AT Protocol client
- `@atproto/oauth-client` - OAuth
- `@muni-town/leaf-client` - Leaf server client

## Development Practices

### TypeScript

Strict settings across all packages:

- `strict: true`
- `noUnusedLocals: true`
- `noUnusedParameters: true`
- `noImplicitAny: true`
- `noUncheckedIndexedAccess: true`

### Authentication Modes

app-lite supports two authentication paths, both producing an `Agent` that backs the `DirectXrpcClient`:

1. **OAuth (Production):** Standard AT Protocol OAuth via `@atproto/oauth-client-browser`. Requires a publicly-reachable redirect URI (loopback in dev, deployed origin in prod). The `init()` function in `src/lib/auth.svelte.ts` calls `initSession()` → `BrowserOAuthClient.init()` to restore/create the session.

2. **App Password (Testing / E2E):** When `PUBLIC_TEST_IDENTIFIER` + `PUBLIC_TEST_APP_PASSWORD` are set in `packages/app-lite/.env`, `init()` auto-logs in via `AtpAgent.login()` instead of attempting OAuth. This bypasses the OAuth round-trip entirely, enabling headless browser-based E2E testing against a local appserver with no public exposure.

```env
# packages/app-lite/.env
PUBLIC_TEST_IDENTIFIER=did:plc:your-test-did
PUBLIC_TEST_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

> **Env var prefix matters:** `PUBLIC_*` vars are read via SvelteKit's `$env/dynamic/public` module, not `import.meta.env` (which only inlines `VITE_*` vars). See `src/lib/config.ts` — `testIdentifier`/`testAppPassword` use `dynamicEnv.PUBLIC_TEST_*`.

Both paths set `auth.authenticated = true` and populate `auth.agent`. Use `auth.userDid` (not `auth.session?.did`) to get the current user's DID — it works for both auth modes (OAuth exposes `session.did`; app-password only has `agent.did`).

## Testing & E2E Verification

### Local Dev Stack (`pnpm dev:local`)

`scripts/dev-local` starts the full local stack — no tunnel or production services needed:

```bash
pnpm dev:local                          # leaf + appserver + app-lite (defaults: 8080, 5180)
./scripts/dev-local --port 8090         # custom appserver port
./scripts/dev-local --app-port 5200     # custom app-lite port
./scripts/dev-local --no-leaf           # skip docker, use LEAF_URL from appserver/.env
./scripts/dev-local --reset-leaf        # wipe leaf-data volume before starting
```

**What it starts (all on localhost):**

| Layer | Process | Port | Connects to |
|-------|---------|------|-------------|
| Leaf + PLC + PLC DB | docker compose | 5530, 3001 | — |
| Appserver | host Bun (`bun run --watch`) | 8080 | local leaf (5530), **real** PLC (`https://plc.directory`) |
| app-lite | host Vite | 5180 | local appserver via `VITE_APPSERVER_WS_ORIGIN` |

The script auto-creates the `roomy-dev` docker network if missing, waits for each layer's health check before starting the next, and cleans up all processes on Ctrl-C.

**Key wiring details:**

- A single env var, `VITE_APPSERVER_WS_ORIGIN=ws://127.0.0.1:8080`, points both the sync WebSocket **and** the XRPC HTTP client at the local appserver. `config.ts` derives `appserverHttpOrigin` from the WS origin (ws→http transform). When unset, both fall back to DID resolution (production). See commit `47d283e4`.
- The appserver uses the **real** PLC directory (`https://plc.directory`) for JWT verification, not the local one — the local PLC only has test DIDs, but resolving the PDS's signing key (e.g. `bsky.social`'s DID) requires the real PLC.
- No public exposure needed: app-lite calls the local appserver directly, the appserver calls local leaf directly, and auth tokens come from the real PDS (`bsky.social`).

### E2E Browser Testing

With `PUBLIC_TEST_IDENTIFIER` + `PUBLIC_TEST_APP_PASSWORD` set in `packages/app-lite/.env`, the app auto-authenticates on page load (app-password login, no OAuth round-trip). This enables full browser-based E2E testing of the XRPC + sync stack.

**Verified E2E chain:**

```
Browser (headless Chromium)
  → app-lite (Vite, :5180)
    → POST bsky.social/com.atproto.server.createSession   [app-password login]
    → GET  127.0.0.1:8080/xrpc/space.roomy.space.getSpaces [200]
    → POST 127.0.0.1:8080/xrpc/space.roomy.auth.getConnectionTicket [200]
    → WS   127.0.0.1:8080/xrpc/space.roomy.sync.subscribe   [connected]
      → local appserver (Bun, :8080)
        → local leaf (Docker, :5530)
```

All XRPC queries, procedures, and the WebSocket sync connection go to the local appserver. The app UI loads fully (spaces, navigation, user menu) without any production dependency.

### Pre-existing Type Errors

Both `svelte-check` (app-lite) and `tsc --noEmit` (appserver) report pre-existing errors on `main` that are **not** introduced by your changes. When verifying, diff the error count against a clean checkout rather than treating any error as new. Current baseline: app-lite has 3 errors (SDK `RateLimitRetryOptions` export, tiptap `LinkOptions`, `Storage.markdown`); appserver has 36 errors (test files with brand types).

### Appserver Unit Tests

The appserver has 25 test files (~240 tests) runnable via `bun test`. Tests use mocked DBs and mocked Leaf connections — they exercise materialization, auth, invalidation, and XRPC handler logic at the unit level. There are no integration tests that boot the HTTP server and exercise XRPC endpoints end-to-end yet.

### Deployment Targets

**app-lite:**
1. **Static** - `@sveltejs/adapter-static` (see `Dockerfile.app-lite` + `Caddyfile`)

## Removed with app

The legacy `packages/app` (SQLite WASM + worker architecture + LiveQuery) has been deleted. The following were removed alongside it and have **not** been replaced:

- **Root Dockerfile** — built the legacy app via `turbo build-web-app-prod`; use `Dockerfile.app-lite` instead.
- **`scripts/netlify_build.sh`** — Netlify deploy script for the legacy app.
- **`scripts/setup-tauri.sh`** — Tauri setup for the legacy app's desktop builds.
- **`tsconfig.tests.json`** — root test tsconfig targeting the app's `tests/` and `scripts/`.
- **`.github/workflows/playwright.yml.skip`** — Playwright E2E for the legacy app (was already `.skip`).
- **`.github/workflows/release-tauri.yml`** — Tauri desktop/Android release pipeline for the legacy app.
- **`pnpm build-web-app`, `pnpm build-web-app-prod`, `pnpm build:t`** — legacy build scripts (removed from root `package.json` and `turbo.json`).
- **`pnpm test`, `pnpm test:e2e`, `pnpm test:robot`, `pnpm check`** — legacy test/check scripts that targeted `packages/app`.

Historical plan documents under `docs/plans/` still reference `packages/app` as a port source; those are historical records and not actionable.

## Reference Files

When creating reference files:

1. Prefix with `.llm.` (e.g., `.llm.workers.md`)
2. Include date and commit hash at top