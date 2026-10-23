import { createQuery } from "@tanstack/svelte-query";
import { CONFIG, MATRIX_BRIDGE_CONFIGURED } from "$lib/config";
import { serviceAuthToken } from "$lib/auth.svelte";

/**
 * The bridge's admin routes are bound to an `lxm` in the service-auth token:
 * the bridge rejects a token whose `lxm` names a different route. These
 * strings are part of the wire contract, kept in one place so the queries and
 * the mutations cannot drift apart.
 */
export const MATRIX_ADMIN_METHODS = {
  list: "_roomy.admin.bridges.list",
  create: "_roomy.admin.bridges.create",
  patch: "_roomy.admin.bridges.patch",
  delete: "_roomy.admin.bridges.delete",
} as const;

export type MatrixBridgeKind = "room" | "space";
export type MatrixBridgeMode = "full" | "subset";
export type MatrixPortalState =
  | "syncing"
  | "backfilling"
  | "paused"
  | "blocked";

/** One Matrix room the bridge relays into a Roomy room. */
export interface MatrixPortal {
  matrixRoomId: string;
  roomyRoomId: string;
  depth: number;
  state: MatrixPortalState;
  /** Why a paused or blocked portal stopped; null otherwise. */
  reason: string | null;
  encrypted: boolean;
}

export interface MatrixBridge {
  id: string;
  spaceId: string;
  matrixId: string;
  kind: MatrixBridgeKind;
  mode: MatrixBridgeMode;
  autoBridge: boolean;
  targetRoomId: string | null;
  name: string | null;
  portals: MatrixPortal[];
}

/** `GET /_roomy/admin/v1/health` — the bridge's own report of itself. */
export interface MatrixBridgeHealth {
  ok: boolean;
  portalCount: number;
  e2ee: boolean;
  homeserver: string;
}

/**
 * A failed admin call, carrying the HTTP status when one was seen. `null`
 * means the request never completed: unconfigured build, no session, or a
 * network failure.
 */
export class MatrixAdminError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "MatrixAdminError";
    this.status = status;
  }
}

/**
 * The user-facing copy for a failed admin call. Every message this module
 * raises is already written for a person, so callers show this string rather
 * than the error's name or stack.
 */
export function matrixAdminErrorCopy(err: unknown): string {
  if (err instanceof MatrixAdminError) return err.message;
  return "Something went wrong talking to the Matrix bridge.";
}

/**
 * Call the bridge's admin API as the current user: a service-auth token whose
 * audience is the bridge DID and whose `lxm` is the method being called, sent
 * as a bearer token. Failures are mapped onto copy a person can act on.
 */
export async function matrixAdminFetch<T>(
  lxm: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  // The bridge whose admin URL this is: the first configured DID. Both halves
  // come from the same build config, so either both are set or neither is.
  const base = CONFIG.matrixBridgeUrl;
  const did = CONFIG.matrixBridgeDids[0];
  if (base === undefined || did === undefined) {
    throw new MatrixAdminError(
      "The Matrix bridge is not configured for this build.",
      null,
    );
  }

  let token: string;
  try {
    token = await serviceAuthToken(did, lxm);
  } catch {
    throw new MatrixAdminError(
      "Couldn't get a service token for the Matrix bridge. Sign in again.",
      401,
    );
  }

  let resp: Response;
  try {
    resp = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...init?.headers,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    });
  } catch {
    throw new MatrixAdminError("Couldn't reach the Matrix bridge.", null);
  }

  if (resp.status === 401) {
    throw new MatrixAdminError(
      "The bridge rejected this session. Sign in again.",
      401,
    );
  }
  if (resp.status === 403) {
    throw new MatrixAdminError(
      "Only space admins can manage this space's Matrix bridges.",
      403,
    );
  }
  if (!resp.ok) {
    throw new MatrixAdminError(
      `The bridge answered with an error (${resp.status}).`,
      resp.status,
    );
  }
  return (await resp.json()) as T;
}

/**
 * Prefix every bridge-list entry shares. Mutations invalidate this prefix, so
 * a change made from one space's section refreshes whichever list is open.
 */
export const MATRIX_BRIDGES_QUERY_ROOT = ["matrixBridge", "bridges"] as const;

/**
 * The bridges configured for this space, each with the state of its portals.
 * The bridge exposes this to admins only, so the query is disabled until the
 * caller is known to be one and the build knows where the bridge lives.
 *
 * Portal state moves on its own (a backfill finishes, a room is paused), so
 * the entry is refetched while the section is open rather than left to the
 * cache.
 */
export function createMatrixBridgesQuery(
  spaceId: () => string,
  opts?: { enabled?: () => boolean },
) {
  return createQuery(() => {
    const id = spaceId();
    return {
      queryKey: [...MATRIX_BRIDGES_QUERY_ROOT, id],
      queryFn: () =>
        matrixAdminFetch<{ bridges: MatrixBridge[] }>(
          MATRIX_ADMIN_METHODS.list,
          `/_roomy/admin/v1/bridges?spaceId=${encodeURIComponent(id)}`,
        ),
      enabled: MATRIX_BRIDGE_CONFIGURED && id !== "" && (opts?.enabled?.() ?? true),
      staleTime: 0,
      refetchInterval: 10_000,
      // A rejected token or a non-admin caller fails identically on retry.
      retry: false,
    };
  });
}

/**
 * The bridge's health report. Unauthenticated, so it answers whether the
 * bridge is reachable before anyone signs a token for it.
 */
export function createMatrixBridgeHealthQuery(opts?: {
  enabled?: () => boolean;
}) {
  return createQuery(() => {
    const base = CONFIG.matrixBridgeUrl;
    return {
      queryKey: ["matrixBridge", "health", base],
      queryFn: async (): Promise<MatrixBridgeHealth> => {
        let resp: Response;
        try {
          resp = await fetch(`${base}/_roomy/admin/v1/health`);
        } catch {
          throw new MatrixAdminError("Couldn't reach the Matrix bridge.", null);
        }
        if (!resp.ok) {
          throw new MatrixAdminError(
            `The Matrix bridge isn't answering (${resp.status}).`,
            resp.status,
          );
        }
        return (await resp.json()) as MatrixBridgeHealth;
      },
      enabled: base !== null && (opts?.enabled?.() ?? true),
      staleTime: 0,
      refetchInterval: 30_000,
      retry: false,
    };
  });
}
