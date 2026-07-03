# Appserver E2E Testing & Per-Endpoint Performance — Remaining Plan

## Context

**A (test-mode auth bypass)** and **B (server factory)** are implemented:

- `src/xrpc/auth.ts` — `testAuthVerifier` reads `X-Test-Did` header, bypasses JWT/PLC. `selectAuthVerifier()` picks it when `APPSERVER_TEST_MODE=true`. `X-Test-Did` is in CORS allowed headers.
- `src/appserver.ts` — `createAppserver(opts)` factory with `AppserverOptions` (authVerifier, port, ownDid, dbPath, readStateDbPath, backfillMode, quiet, corsOrigin). Returns `AppserverHandle` with `close()`. `backfillMode: "disabled"` skips all Leaf contact. `:memory:` SQLite supported.
- `src/appserver.test.ts` — 5 smoke tests: health, did.json, backfill status, getConnectionTicket (test auth), getSpaces anonymous, CORS, 404. Each test spins a fresh ephemeral-port appserver with `:memory:` DB and `disabled` backfill.
- `src/index.ts` refactored to use `createAppserver`, boot path only.

The remaining work: **C** (full HTTP e2e coverage of every endpoint), **D** (per-endpoint performance harness), **E** (hermeticity), **F** (docs).

---

## Phase C: HTTP-Level E2E Test Suite

**Goal:** Cover every registered XRPC endpoint through the real HTTP transport (not just router.fetch), exercising auth, validation, and DB state — all without Leaf or network.

### C.1 Test fixture: `src/e2e/helpers.ts`

A reusable fixture that every e2e test imports. Provides:

- `startAppserver(opts?)` → `{ handle, baseUrl, authedFetch(did?), anonFetch }`
  - Calls `createAppserver` with `testAuthVerifier`, `:memory:` DBs, `backfillMode: "disabled"`, `quiet: true`, ephemeral port.
  - `authedFetch(did)` returns a `fetch` wrapper that injects `X-Test-Did: <did>`.
  - `anonFetch` is plain `fetch` (no header).
  - Registers a teardown to `handle.close()` + reset singletons.
- `seedSpace(handle, did)` — directly inserts a space row + membership into the materialisation DB via the existing `openDb()` singleton so read endpoints have data. Uses the schema from `src/db/schema.sql` and the insert patterns already used in `updateSeen.test.ts`.

### C.2 Per-endpoint smoke tests: `src/e2e/endpoints.test.ts`

One `describe` block per endpoint, each with at least:

| Endpoint | Test cases |
|---|---|
| `space.roomy.auth.getConnectionTicket` | (already in `appserver.test.ts` — keep or move here) |
| `space.roomy.space.getSpaces` | anonymous → 200 empty; authenticated with seeded space → 200 with array; authenticated no spaces → empty |
| `space.roomy.space.getMetadata` | seeded space → 200 with metadata; unknown space → 404; anonymous → 401/403 per auth guard |
| `space.roomy.space.getMembers` | seeded space → 200 with member list; unauthenticated → per guard |
| `space.roomy.space.getThreads` | seeded space → 200; empty space → empty array |
| `space.roomy.space.getRoles` | seeded space with roles → 200; no roles → empty |
| `space.roomy.space.getInvites` | seeded space → 200; anonymous → guard |
| `space.roomy.space.getActivityFeed` | seeded space → 200; empty → empty |
| `space.roomy.room.getMetadata` | seeded room → 200; unknown room → 404 |
| `space.roomy.room.getThreads` | seeded room → 200; empty → empty |
| `space.roomy.room.getMessages` | seeded room with messages → 200; empty room → empty |
| `space.roomy.message.getMessage` | seeded message → 200; unknown → 404 |
| `space.roomy.message.getReactions` | seeded message → 200; no reactions → empty |
| `space.roomy.room.updateSeen` | authenticated → 200; anonymous → 401; invalid roomId → 400 (schema) |
| `space.roomy.space.createSpace` | authenticated → 200 + space created; anonymous → 401; missing field → 400 |
| `space.roomy.space.joinSpace` | seeded invite token → 200; expired token → error; anonymous → 401 |
| `space.roomy.space.leaveSpace` | member → 200 + removed; non-member → idempotent or error |
| `space.roomy.space.setHandle` | authenticated → 200; invalid handle → 400 |
| `space.roomy.space.sendEvents` | authenticated → 200; anonymous → 401; invalid event → 400 |
| `space.roomy.sync.subscribe` (WS) | getConnectionTicket → WS upgrade with ticket → connected + initial frame; bad ticket → close |
| `space.roomy.admin.connectSpace` | admin → 200; anonymous → guard |
| `space.roomy.admin.materializeSpace` | admin → 200; anonymous → guard |

Each test uses `seedSpace` to set up the minimal DB state the handler needs. For write endpoints (`createSpace`, `joinSpace`, `sendEvents`, `updateSeen`), assert the DB state changed after the call (query the materialisation DB directly via `openDb()`).

### C.3 WebSocket sync test: `src/e2e/sync.test.ts`

Dedicated file for the sync subscription path since it's a different transport:

1. `getConnectionTicket` with `X-Test-Did` → ticket string.
2. Open WS to `ws://localhost:<port>/xrpc/space.roomy.sync.subscribe?ticket=<ticket>`.
3. Assert connection opens, receives an initial frame.
4. Insert a row into the materialisation DB → assert a diff frame is pushed.
5. Close WS → assert server-side cleanup (no leak).
6. Bad/expired ticket → WS closes with auth error.

Use Bun's `WebSocket` client (built-in).

### C.4 Transport-level tests: `src/e2e/transport.test.ts`

Cover paths the unit tests (which call `router.fetch` directly) skip:

- `GET /blob/<did>/<cid>` → proxied or 404 (no Leaf in disabled mode, so expect a graceful error, not a crash).
- `OPTIONS` preflight on every path → 204 + CORS headers.
- `GET /health/embed` → 200 with stats.
- Non-existent path → 404 (not a 500 crash).
- Malformed query params → 400 (schema rejection), not 500.

---

## Phase D: Per-Endpoint Performance Harness

**Goal:** Measure latency per XRPC endpoint and output a structured report.

### D.1 Harness: `perf/measure.ts` (run via `bun run`)

```
Input:  endpoint list (auto-discovered from buildRouter), iterations N (default 100), warmup W (default 10)
Output: JSON file + console table
```

Flow:
1. Start `createAppserver` with test auth + `:memory:` DB + `disabled` backfill.
2. Seed a space with N messages, M threads, K members (realistic fixture).
3. For each endpoint:
   - Warmup W requests (discard timings).
   - Fire N sequential requests, record `performance.now()` delta per request.
   - For write endpoints, reset the affected row(s) between iterations or use unique keys so there's no cache/idempotency masking.
4. Compute per-endpoint: `count, min_ms, p50_ms, p95_ms, p99_ms, max_ms, mean_ms, errors`.
5. Write `perf/results-<timestamp>.json` and print a sorted table (by p95 descending).

### D.2 Endpoint registry auto-discovery

Extract the registered NSID list from `buildRouter` (add an export `getRegisteredNsids(): { nsid, type }[]` to `appserver.ts`). The perf harness iterates this list instead of a hardcoded array, so new endpoints are measured automatically.

### D.3 Concurrency variant (optional)

A second mode that fires requests with concurrency C (default 10) to measure throughput (req/s) and tail latency under contention. Use `Promise.all` batches. Output adds `throughput_rps` and `concurrency` fields.

### D.4 Invocation

```bash
# Run perf harness
bun run packages/appserver/perf/measure.ts

# With options
bun run packages/appserver/perf/measure.ts --iterations 500 --warmup 20 --concurrency 10
```

Add a package.json script: `"perf": "bun run perf/measure.ts"`.

---

## Phase E: Hermeticity Hardening

Ensure tests never touch the network, filesystem, or shared state.

### E.1 Verify disabled-mode isolation

`APPSERVER_BACKFILL_MODE=disabled` already works — audit that no code path touches Leaf in this mode. Check `hydrateUserMembership`, `resolvePersonalStream`, `getOrCreateMaterializer`, admin handlers — these should short-circuit or throw gracefully when backfill is disabled and no Leaf client exists. Add a guard: if `backfillMode === "disabled"`, the service client should be `null` and any handler that calls it should return a clear error (not a crash).

### E.2 DB isolation

- Confirm `:memory:` SQLite works for both main DB and read-state (the `attachInMemoryReadState` path in `createAppserver`).
- Ensure `handle.close()` fully closes both DBs and the timer — verify no open handles after test suite exits (Bun should report if process hangs).
- Rate limiter: tests already set `RATE_LIMIT_DISABLED=true` — ensure the e2e harness sets this too.

### E.3 Singleton reset

The `beforeEach` in `appserver.test.ts` resets `closeDb`, `closeReadStateDb`, `_resetMaterializerRegistry`, `_resetHydrationInflight`, `_resetEmbedSweeper`. The e2e helper must do the same. Audit whether any other process-wide singletons exist (e.g., the ticket store in `auth.ts`, the invalidation router — `InvalidationRouter.setInstance`).

### E.4 Env guard

Add a runtime assertion in the test harness entrypoint: if `APPSERVER_TEST_MODE` is not `"true"`, refuse to run. Prevents accidental real-auth e2e against a production-like config.

---

## Phase F: Documentation

Update `AGENTS.md` § Testing & E2E Verification after the harness is built and smoke-tested.

### F.1 Add appserver e2e section

```markdown
### Appserver E2E Tests

\`\`\`bash
bun test --cwd packages/appserver src/appserver.test.ts        # Factory smoke tests
bun test --cwd packages/appserver src/e2e/                     # Full HTTP e2e suite
bun run --cwd packages/appserver perf/measure.ts               # Per-endpoint perf
\`\`\`

All appserver e2e tests use \`APPSERVER_TEST_MODE=true\` + \`testAuthVerifier\`
(\`X-Test-Did\` header), \`:memory:\` SQLite, and \`backfillMode: "disabled"\` —
no Leaf, no PLC, no network. The \`createAppserver\` factory spins a clean
instance per test on an ephemeral port.
```

### F.2 Document the perf harness output format and where results land.

### F.3 Update the appserver package structure listing to include `src/e2e/` and `perf/`.

---

## Execution Order

1. **E.1 + E.4** — verify disabled-mode isolation, add env guard. (Fast, de-risks everything else.)
2. **C.1** — fixture + seedSpace. (Foundation for C.2, C.3, D.)
3. **C.2** — per-endpoint smoke tests. (The core coverage.)
4. **C.3** — WebSocket sync test.
5. **C.4** — transport edge cases.
6. **D.1 + D.2** — perf harness + auto-discovery.
7. **D.3** — concurrency variant (optional).
8. **F** — docs.

## Acceptance Criteria

- [ ] Every registered XRPC NSID has at least one HTTP-level smoke test passing.
- [ ] WebSocket sync subscription tested end-to-end (ticket → connect → frame).
- [ ] Perf harness runs, outputs per-endpoint p50/p95/p99, auto-discovers all endpoints.
- [ ] Full e2e suite runs in <5s with no network access (offline, no Leaf, no PLC).
- [ ] No leaked processes/handles after suite exit.
- [ ] `AGENTS.md` documents how to run e2e + perf.