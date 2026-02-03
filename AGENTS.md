# AGENTS.md

Guidance for AI coding agents working with this monorepo.

**Updated:** 2026-01-27

## Monorepo Structure

```
roomy/
├── packages/
│   ├── app/              # SvelteKit web application
│   ├── sdk/              # @roomy/sdk - Core SDK for Roomy clients
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

The main SvelteKit application. Uses a three-tier worker architecture:

```
UI Thread (Svelte Components)
    ↓
Shared Worker (Peer Worker)
    - Authentication & OAuth
    - Stream subscriptions
    - Multi-tab coordination
    ↓
Dedicated Worker (SQLite Worker)
    - SQLite WASM database
    - Event materialization
    - Live queries
```

### Key Directories
- `src/lib/workers/` - Worker architecture (backend, sqlite)
- `src/lib/components/` - UI components
- `src/lib/queries/` - Live query system
- `src/lib/mutations/` - State mutations
- `src/routes/` - SvelteKit routes

### SQLite Storage

The SQLite worker uses a fallback strategy:

1. **Primary:** OPFS (Origin Private File System) with SAH Pool VFS
   - Persistent storage, best performance
   - Requires COOP/COEP headers

2. **Fallback:** In-memory database (`:memory:`)
   - Activates when OPFS fails (missing headers, unsupported browser)
   - Data lost on page refresh

Check storage type via `getVfsType()` → `"opfs-sahpool"` | `"memory"` | `null`

**Schema:** `src/lib/workers/sqlite/schema.sql` (ECS pattern: entities, events, edges, comp_* tables)

### Data Flow

1. User authenticates → `Client` created in Peer Worker
2. `Client` connects to AT Protocol PDS and Leaf server
3. Events stream through `ConnectedStream` instances
4. SQLite worker materializes events into relational tables
5. Live queries auto-invalidate on changes → reactive UI updates

### Feature Flags

Configured in `src/lib/config.ts`:
- `sharedWorker` - Enable shared worker architecture
- `discordBridge` - Discord integration features
- `discordImport` - Discord import functionality
- `threadsList` - Threads list view

### Debug Helpers

Available in browser console:
```javascript
window.debugWorkers.enableLogForwarding()
window.debugWorkers.pingPeer()
window.debugWorkers.testSqliteConnection()
window.debugWorkers.logWorkerStatus()
window.debugWorkers.diagnoseRoom(roomId)
```

## Package: sdk (@roomy/sdk)

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

**Dependencies:** `@discordeno/bot`, `@roomy/sdk`, `classic-level`, OpenTelemetry

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
