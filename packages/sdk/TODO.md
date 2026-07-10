# SDK TODO

Post-merge improvements and known issues for `packages/sdk/`.

## Dead Code

- **Orphaned RoomyServiceClient.ts (L6):** `src/client/RoomyServiceClient.ts` — no longer exported from `client/index.ts`, not imported anywhere. Delete or re-export.
- **Orphaned BackfillStatus (L7):** `src/connection/types.ts:42-46` — `BackfillStatus` defined but no longer re-exported. Only consumer was deleted `ConnectedSpace`. Delete or re-export.
- **Unused RoomyClientEvents (L8):** `src/client/RoomyClient.ts:32` — empty interface exported but unused (was for deleted EventEmitter pattern). Remove.
- **Unused plcDirectory field (L9):** `src/client/RoomyClient.ts:29` — `plcDirectory` config field stored but never read (logic was in deleted `RoomyClientBase`). Remove or wire up.

## Type Errors

- **reaction.test.ts latent TS errors (M8):** `tests/operations/reaction.test.ts:17-18,37-38,47-48,60-61` — dropped `as any` casts on branded Ulid fields (`roomId`/`messageId`/`reactionId`). TS error under strict check; vitest passes via esbuild type stripping. Restore casts.

## Workspace

- **discord-bridge-legacy broken (M9):** `packages/discord-bridge-legacy` imports deleted SDK symbols (`ConnectedSpace`, `modules`). Archived and not in CI, but workspace member is left broken. Delete or exclude from typecheck.

## Cleanup

- **No-op change in user.ts (N1):** `src/schema/events/user.ts:72` — byte-identical line change. Revert.
