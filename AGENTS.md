# AGENTS.md

Guidance for AI coding agents working with this monorepo.

**Updated:** 2026-07-02

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
pnpm dev:bridge             # Start Discord bridge service
pnpm dev:all                # Start all services + monitoring
```

### Building

```bash
pnpm build                  # Build all packages via turbo
pnpm publish-packages       # Version & publish SDK to npm
```

### Type Checking & Tests

```bash
pnpm --filter app-lite check              # TypeScript check (svelte-check) for app-lite
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

app-lite uses the AT Protocol OAuth flow:

1. **OAuth (Production):** Standard AT Protocol OAuth
2. **App Password (Testing):** Via environment variables

```env
PUBLIC_TEST_IDENTIFIER=your-handle.bsky.social
PUBLIC_TEST_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

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