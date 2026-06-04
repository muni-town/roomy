/**
 * `useConnectionStatus()` — Svelte rune that mirrors the SDK connection
 * state machine's status into `$state` for templates to bind to.
 *
 * Accepts a getter function so it can track reactive connection changes
 * (e.g. when the connection is created inside an `$effect` and stored in
 * a `$state` variable). When the connection changes, the old subscription
 * is cleaned up and a new one is established automatically.
 *
 * Uses a structural interface (`SyncConnectionLike`) rather than the
 * concrete `SyncConnection` class so that consumers importing from
 * different resolution paths (dist vs source) don't hit nominal-type
 * mismatches from private fields.
 *
 * @module @roomy-space/sdk/svelte
 */

import type { ConnectionStatus } from "../sync/connection";

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

/**
 * Structural interface for the SDK's `SyncConnection`.
 *
 * Only exposes the surface that the Svelte adapter needs. Consumers
 * typically pass a real `SyncConnection` instance; this interface
 * keeps the adapter decoupled from private fields that would cause
 * nominal-type mismatches across dist / source resolution boundaries.
 */
export interface SyncConnectionLike {
  readonly status: ConnectionStatus;
  onStatusChange(handler: (status: ConnectionStatus) => void): () => void;
}

/**
 * Map the SDK's granular {@link ConnectionStatus} to the simplified
 * {@link ConnectionState} exposed to templates.
 */
function mapConnectionStatus(status: ConnectionStatus): ConnectionState {
  switch (status.state) {
    case "connecting":
      return "connecting";
    case "reconnecting":
      return "reconnecting";
    case "open":
      return "connected";
    case "closing":
    case "idle":
    case "closed":
      return "disconnected";
  }
}

/**
 * Mirror the SDK connection's status into a reactive `$state` variable.
 *
 * Call at the component top level (not inside an `$effect` or conditional).
 *
 * ```svelte
 * <script>
 *   import { useConnectionStatus } from "@roomy-space/sdk/svelte";
 *   const status = useConnectionStatus(() => syncCtx?.connection ?? null);
 * </script>
 *
 * <span>{status.state}</span> <!-- reactive -->
 * ```
 *
 * @param getConnection — function returning the current connection
 *   (or `null` if not yet created). Reactive reads inside the getter are
 *   tracked so the status updates when the connection changes.
 */
export function useConnectionStatus(
  getConnection: () => SyncConnectionLike | null,
): { readonly state: ConnectionState; readonly reconnectAttempt: number; readonly reconnectDelayMs: number } {
  let state = $state<ConnectionState>("disconnected");
  let reconnectAttempt = $state(0);
  let reconnectDelayMs = $state(0);

  $effect(() => {
    const conn = getConnection();
    if (!conn) {
      state = "disconnected";
      reconnectAttempt = 0;
      reconnectDelayMs = 0;
      return;
    }

    // Seed from current status immediately.
    const current = conn.status;
    state = mapConnectionStatus(current);
    if (current.state === "reconnecting") {
      reconnectAttempt = current.attempt;
      reconnectDelayMs = current.delayMs;
    } else {
      reconnectAttempt = 0;
      reconnectDelayMs = 0;
    }

    // Subscribe to future changes.
    const unsubscribe = conn.onStatusChange((s: ConnectionStatus) => {
      state = mapConnectionStatus(s);
      if (s.state === "reconnecting") {
        reconnectAttempt = s.attempt;
        reconnectDelayMs = s.delayMs;
      } else {
        reconnectAttempt = 0;
        reconnectDelayMs = 0;
      }
    });

    return unsubscribe;
  });

  return {
    get state() {
      return state;
    },
    get reconnectAttempt() {
      return reconnectAttempt;
    },
    get reconnectDelayMs() {
      return reconnectDelayMs;
    },
  };
}
