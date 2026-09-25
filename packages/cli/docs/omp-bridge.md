# Roomy as a web client for omp — research & ideation

**Status:** research + working MVP prototype

## The idea

[omp](https://github.com/can1357/oh-my-pi) is a coding agent. Today it ships a
terminal TUI and a companion web UI, **omp-web**, that drives the installed
`omp` binary over an RPC protocol. This doc explores an alternative: use
**Roomy** (the ATProto chat app) as the web client for omp — i.e. talk to the
agent from a Roomy room instead of a bespoke web app.

The MVP is deliberately narrow: **no text streaming, no tool UI, no session
browsing.** Just "mention the agent in a room, get an answer back." Everything
else is future work.

## Reference: how omp-web works

omp-web is a Node-hosted Next.js app. It does **not** embed the agent — it
spawns `omp --mode rpc-ui` (NDJSON over stdio), one child process per active
session, and proxies a browser chat UI to it:

```
Browser ──▶ Next.js server ──▶ omp --mode rpc-ui (NDJSON stdio)
   │              │                    │
   └─ SSE ◀───────┴── onFrame() ◀─────┘  (agent_start/agent_end, text deltas)
```

Key facts we can reuse:

- **`omp -p "message"`** runs a single prompt non-interactively and prints the
  reply to stdout. This is the simplest possible integration point.
- **`omp --mode rpc-ui --cwd <dir>`** gives a persistent, streaming, tool-aware
  session over NDJSON. Commands like `{type:"prompt", message}` are sent on
  stdin; events stream back on stdout. This is what a non-MVP version would use.
- omp is configured via `~/.omp/agent/models.yml` (providers, models, API keys)
  and stores sessions as `.jsonl` files under `~/.omp/agent/sessions/`.

## The bridge: Roomy CLI `listen` command

The Roomy CLI already does auth, `send`, and `read`. The missing piece was a
**live feed** — a way to hear new messages as they arrive and route them to the
agent. That's exactly what the appserver WebSocket provides.

### WebSocket protocol (verified against production)

- Endpoint: `wss://<appserver>/xrpc/space.roomy.sync.subscribe`
- Auth: fetch a short-lived ticket via `space.roomy.auth.getConnectionTicket`,
  append as `?ticket=…`.
- **Subscribe to the `room:<id>` topic** to receive `#messageDiff` frames.
  (Subscribing to `space:<id>` only yields invalidation signals, **not**
  message diffs — this was the key discovery.)
- `#messageDiff` body: `{ roomId, seq, ops: [{ op: "add"|"update"|"remove",
  key, message }] }`. The `message` carries `id, content, mimeType, authorDid,
  authorName, timestamp, reactions, media, linkEmbeds`.
- Non-text content blobs (richtext JSON) are **base64-encoded** in `content`;
  plain `text/markdown` is raw UTF-8.

The SDK's `SyncConnection` (framework-agnostic, Node ≥ 22) handles ticket
fetch, reconnect-with-backoff, and CBOR frame decoding — the CLI just wires it
up.

### Mention detection

The agent should only act when it's actually addressed. **The DID is the
authoritative, stable ID** — it's what `#didMention` facets carry, and it never
changes (handles and display names do). Two paths:

1. **Rich text** (`application/vnd.roomy.richtext+json`): parse the blocks and
   look for a `#didMention` facet whose `did` equals the agent's DID. This is
   the primary, unambiguous signal — the app UI renders a real mention chip.
2. **Plain text / markdown** (best-effort fallback for messages authored
   without a rich mention): substring match on the full handle and the agent's
   **display name** (e.g. `Redcurrant`), resolved from their Roomy profile via
   `space.roomy.user.getProfile`. This path is inherently less reliable than
   the DID facet.

The SDK already exports `deserializeBody`, `blocksToPlaintext`, and
`extractMentionDids` — the bridge reuses them.

### The loop

```
Roomy room ──WS──▶ appserver (mention detection) ──#mention──▶ CLI listen ──▶ omp -p ──▶ reply
     ▲                                                                                    │
     └────────────────────────────── sendMessage(reply) ◀────────────────────────────────┘
```

- The bridge subscribes to the appserver's **server-side mentions subscription**
  (`mentions:<agentDid>`), so it receives every message that mentions the agent
  across all spaces it has joined — one subscription, no per-room bookkeeping.
- The appserver detects mentions at materialization time (from `#didMention`
  facets / the mentions extension) and emits a `#mention` frame per mentioned
  DID. The DID is the stable ID — never the handle or display name.
- The bridge ignores the agent's own messages (prevents self-trigger loops).
- Replies are posted back to the same room the mention came from.
- **Thinking traces:** the bridge runs `omp -p --mode=json --print-thoughts` and
  posts the model's thinking trace (as a blockquote) above the final answer in a
  single rich message. `--no-thinking` suppresses the trace.
- `--no-mention-only` responds to every message (falls back to per-room
  subscriptions; useful for a dedicated agent-only room).
- **Scope:** with `--space`/`--room`, the bridge filters incoming mentions to
  those rooms. Without them, every mention in every joined space is in scope.

### Verified end-to-end

A live test against production (`api.roomy.space`):

```
> @roomy-test-2 what is 2+2? reply with just the number
< 4
```

The bridge detected the mention, ran `omp -p`, and posted `4` back to the room.
Mention detection was also unit-verified for all four cases (plain @handle,
plain no-mention, richtext agent-DID, richtext other-DID).

A second live test used a **Roomy-native rich mention** — a `#didMention`
facet (not plain `@handle` text). The CLI's `send` command now supports this
via `--mention <did> --mention-label <handle>`, which builds a richtext block
with a `#didMention` facet over the `@label` byte range (matching how the app
UI serializes mentions). The bridge detected the facet and replied correctly.

## What the MVP does NOT do (and why)

| omp-web feature | MVP status | Notes |
|---|---|---|
| Text streaming | out | `omp -p` is single-shot; streaming needs `--mode rpc-ui` |
| Tool call UI / approval | out | omp-web surfaces tool calls; Roomy has no such UI |
| Session browsing / resume | out | would need session-file access + a Roomy UI |
| Model / skill / plugin management | out | omp-web's panels; not chat-shaped |
| File preview / worktrees | out | not chat-shaped |

The MVP is a **conversational front door** to the agent, not a full IDE.

## Future directions (non-MVP)

1. **Streaming via `--mode rpc-ui`.** Spawn one persistent omp process per
   Roomy room (or per space), send `{type:"prompt"}` on mention, and forward
   `agent_start`/text-delta/`agent_end` frames back as Roomy messages. Roomy
   has no streaming message type yet, so this would be "post a message, then
   edit it in place" (the appserver supports message edits) — a reasonable
   approximation.
2. **Per-room agent personas.** Map a room to a cwd + model + system prompt so
   `#dev` runs against the repo and `#research` uses a different model.
3. **Tool approval via reactions.** A pending tool call could be surfaced as a
   message; a ✅/❌ reaction on it could approve/deny. This is a natural fit for
   Roomy's reaction model and a genuinely novel interaction.
4. **Session continuity.** Persist a mapping from Roomy room → omp session file
   so the agent "remembers" context across mentions (resume with `--resume`).
5. **Agent status.** Post a presence message ("working…") or use a room
   metadata field so humans know the agent is busy.

## Open questions / risks

- **Identity & access.** The bridge authenticates as one ATProto account. Who
  is allowed to mention the agent? Currently anyone in the room. A private
  agent-only room is the simplest gate.
- **Cost / abuse.** `omp -p` invokes a model per mention. No rate limiting or
  budget tracking yet.
- **Concurrency.** Multiple mentions in quick succession queue up; `omp -p`
  runs them serially today. A per-room RPC process would serialize naturally.
- **Message edits.** If the agent's reply is edited in place for streaming,
  the bridge must handle the `update` op in `#messageDiff` (currently only
  `add` is handled).
- **Self-trigger loops.** The self-DID filter is the first line of defense;
  a future streaming version must also ignore its own `update` ops.

## Files

- `src/listen.ts` — the bridge (WS listener, mention filter, omp invocation,
  reply posting)
- `src/cli.ts` — `roomy-cli listen` command
- `src/messages.ts`, `src/auth.ts` — reused unchanged (plus `AuthState.agent`
  retyped to `AtpAgent` so the handle is reachable)
