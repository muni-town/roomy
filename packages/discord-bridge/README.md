# @roomy/discord-bridge

Unidirectional Discord → Roomy bridge running on the Bun runtime.

> **Status:** scaffolding. Real ingestion logic lands in chainlink issues #110+.
> Documentation will be filled in by #120.

## Quickstart

```bash
cp .env.example .env
# fill in DISCORD_TOKEN, ATPROTO_BRIDGE_DID, ATPROTO_BRIDGE_APP_PASSWORD
bun install
bun run dev
```

See `docs/plans/.llm.2026-04-30-discord-bridge-rebuild.md` for the rebuild plan.
