import { queryClient } from "$lib/client";
import {
  MATRIX_ADMIN_METHODS,
  MATRIX_BRIDGES_QUERY_ROOT,
  matrixAdminFetch,
  type MatrixBridge,
  type MatrixBridgeKind,
  type MatrixBridgeMode,
} from "$lib/queries/matrix-bridge";

/** Connect a Matrix room or space to this Roomy space. */
export async function createMatrixBridge(input: {
  spaceId: string;
  matrixId: string;
  kind: MatrixBridgeKind;
  mode: MatrixBridgeMode;
  targetRoomId?: string;
  autoBridge?: boolean;
}): Promise<MatrixBridge> {
  const bridge = await matrixAdminFetch<MatrixBridge>(
    MATRIX_ADMIN_METHODS.create,
    "/_roomy/admin/v1/bridges",
    {
      method: "POST",
      body: JSON.stringify({
        spaceId: input.spaceId,
        matrixId: input.matrixId,
        kind: input.kind,
        mode: input.mode,
        ...(input.targetRoomId !== undefined
          ? { targetRoomId: input.targetRoomId }
          : {}),
        ...(input.autoBridge !== undefined
          ? { autoBridge: input.autoBridge }
          : {}),
      }),
    },
  );
  // The new bridge adds portals, so every space's list may be stale.
  await queryClient.invalidateQueries({ queryKey: MATRIX_BRIDGES_QUERY_ROOT });
  return bridge;
}

/**
 * Change a bridge's mode, whether it adopts rooms created later, or its
 * per-room allowlist.
 */
export async function updateMatrixBridge(
  id: string,
  body: {
    mode?: MatrixBridgeMode;
    autoBridge?: boolean;
    allowlist?: string[];
  },
): Promise<MatrixBridge> {
  const bridge = await matrixAdminFetch<MatrixBridge>(
    MATRIX_ADMIN_METHODS.patch,
    `/_roomy/admin/v1/bridges/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
  await queryClient.invalidateQueries({ queryKey: MATRIX_BRIDGES_QUERY_ROOT });
  return bridge;
}

/** Stop bridging: the bridge and the portals it created are removed. */
export async function deleteMatrixBridge(id: string): Promise<void> {
  await matrixAdminFetch<{ ok: true }>(
    MATRIX_ADMIN_METHODS.delete,
    `/_roomy/admin/v1/bridges/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  await queryClient.invalidateQueries({ queryKey: MATRIX_BRIDGES_QUERY_ROOT });
}
