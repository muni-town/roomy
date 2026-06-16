# AGENTS.md

Guidance for AI coding agents working with this monorepo.

**Updated:** 2026-06-16

## Architecture Direction

Roomy is migrating from a local-first architecture to a **thin-client / appserver model**:

- **Removing** SQLite WASM in the browser, the three-tier worker architecture, and client-side materialisation
- **Adding** `packages/appserver` — a Bun/TypeScript service exposing an XRPC interface (HTTP queries + WebSocket subscriptions)
- **Replacing** `LiveQuery` calls in the client with WebSocket XRPC subscriptions
- **Adapter pattern** — the appserver wraps the existing Leaf event-stream backend; it is intentionally temporary and will be replaced by a Rust service

See `packages/appserver/docs/plans/appserver-architecture.md` for full design, migration phases, and research requirements.

**Current phase:** Phase 0 — scaffolding, lexicon design, research.

## Primary Focus: app-lite

**`packages/app-lite` is now the primary client application.** It is a thin SvelteKit client that communicates with the appserver via XRPC (Tanstack Query for HTTP queries, WebSocket for subscriptions). It has no SQLite WASM, no worker architecture, and no client-side materialisation — all state is managed server-side.

`packages/app` (the legacy SvelteKit application) is **maintained but superseded** by app-lite. Cosmetic/design changes may still be applied to app, but all new feature development, architecture work, and refactoring should target app-lite. The app package will be deprecated and removed once app-lite reaches feature parity.

## Monorepo Structure

```
roomy/
├── packages/
│   ├── app/              # SvelteKit web application — SUPERSEDED (maintained, no new features)
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
pnpm dev                    # Start legacy web app on 127.0.0.1:5173
pnpm dev:lite               # Start app-lite on 127.0.0.1:5180
pnpm dev:bridge             # Start Discord bridge service
pnpm dev:all                # Start all services + monitoring
```

### Building

```bash
pnpm build                  # Build all packages via turbo
pnpm build-web-app          # Build legacy web app via Vite
pnpm build-web-app-prod     # Production build with OAuth manifest
pnpm build:lite             # Build app-lite via Vite
pnpm build:t                # Build Tauri desktop app
pnpm publish-packages       # Version & publish SDK to npm
```

### Testing

```bash
pnpm test                   # Unit tests (Vitest) — currently targets packages/app
pnpm test:e2e               # E2E tests (Playwright) — currently targets packages/app
pnpm test:robot             # Integration tests (Robot Framework) — currently targets packages/app
pnpm check                  # TypeScript type checking (svelte-check) — targets packages/app
pnpm check:lite             # TypeScript type checking for app-lite
```

### Running a Single Test

```bash
uv run robot --outputdir tests/robot/results tests/robot/smoke.robot
pnpm test:e2e tests/e2e/app.spec.ts
pnpm test src/lib/workers/encoding.test.ts
```

## Package: app-lite (Primary Client — SvelteKit Thin Client)

The primary SvelteKit application. A thin client that communicates with `packages/appserver` via XRPC — Tanstack Query for HTTP queries, WebSocket for subscriptions. No SQLite WASM, no workers, no client-side materialisation.

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

### Key Differences from app

| Aspect | app (legacy) | app-lite (primary) |
|--------|-------------|-------------------|
| State management | SQLite WASM + workers | Tanstack Query (server-driven) |
| Data fetching | LiveQuery (client-side materialisation) | XRPC via appserver |
| Real-time | WebSocket via Leaf | WebSocket via appserver |
| Port | 5173 | 5180 |
| Adapter | Netlify + Static + Tauri | Static (adapter-static) |
| CSS | Tailwind CSS 4.x | Tailwind CSS 4.x via Vite plugin |
| Design system | Inline components | `@roomy/design` package |

## Package: app (Legacy — Superseded)

The original SvelteKit application. **Maintained for now but superseded by app-lite.** Cosmetic/design changes are acceptable, but no new feature development or architecture work should target this package.

**Architecture (legacy):**
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

## Package: design (@roomy/design)

Shared design system used by both `app` and `app-lite`. Contains reusable Svelte 5 components, icons, and utility functions.

**Key Exports:**

- `@roomy/design` — Main entry point (component index)
- `@roomy/design/icons` — Icon index
- `@roomy/design/utils` — Utility functions (cn, markdown)
- `@roomy/design/components/*` — Individual component imports

**Component Categories:**

- `content/thread/` — Thread content components (shared between app and app-lite)
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

**UI (app-lite — primary):**

- Svelte 5 with runes API
- SvelteKit 2.x
- Tailwind CSS 4.x (via `@tailwindcss/vite`)
- `@tanstack/svelte-query` — Server state management (HTTP queries + cache)
- `@foxui/core` + `@foxui/social` — UI framework
- `bits-ui` — Headless UI primitives
- `virtua` — Virtual scrolling
- TipTap rich text editor (`@tiptap/core`, `@tiptap/pm`, `tiptap-markdown`)
- `@roomy/design` — Shared design system (workspace dependency)

**UI (app — legacy):**

- Svelte 5 with runes API
- SvelteKit 2.x
- Tailwind CSS 4.x
- TipTap rich text editor

**AT Protocol:**

- `@atproto/api` - AT Protocol client
- `@atproto/oauth-client` - OAuth
- `@muni-town/leaf-client` - Leaf server client

**Database:**

- `@sqlite.org/sqlite-wasm` - SQLite in WebAssembly (app legacy only)

## Development Practices

### TypeScript

Strict settings across all packages:

- `strict: true`
- `noUnusedLocals: true`
- `noUnusedParameters: true`
- `noImplicitAny: true`
- `noUncheckedIndexedAccess: true`

### Authentication Modes

Both app and app-lite use the same AT Protocol OAuth flow:

1. **OAuth (Production):** Standard AT Protocol OAuth
2. **App Password (Testing):** Via environment variables

```env
PUBLIC_TEST_IDENTIFIER=your-handle.bsky.social
PUBLIC_TEST_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

### Required HTTP Headers (app — legacy only)

For SharedArrayBuffer/OPFS support:

```
Cross-Origin-Embedder-Policy: credentialless
Cross-Origin-Opener-Policy: same-origin
```

### Deployment Targets

**app-lite (primary):**
1. **Static** - `@sveltejs/adapter-static`

**app (legacy):**
1. **Netlify** - `@sveltejs/adapter-netlify`
2. **Static** - `@sveltejs/adapter-static`
3. **Tauri** - Desktop builds

## Reference Files

When creating reference files:

1. Prefix with `.llm.` (e.g., `.llm.workers.md`)
2. Include date and commit hash at top
