/**
 * The app's one call session, wired to the real network and sync layers.
 *
 * A client is in at most one call at a time (calls are room-scoped, and the
 * media path holds one `Room`), so the session is a module singleton rather
 * than component state: the sidebar, the room panel, and the leave path all
 * have to act on the same one.
 *
 * The dependency object is where the class meets the app — XRPC for the token
 * and the call facts, the sync socket for ephemeral mute/deafen, and toasts
 * for anything the user has to act on. `VoiceCallState` itself stays free of
 * all three, which is what makes it testable without a browser or an SFU.
 */

import { toast } from "@foxui/core";
import { sync_ } from "$lib/sync.svelte";
import { getVoiceToken, joinCall, leaveCall } from "$lib/mutations/voice";
import { VoiceCallState } from "./VoiceCallState.svelte";
import type { VoiceErrorMessage } from "./voice-errors";

let session: VoiceCallState | null = null;

/**
 * The call session, created on first use.
 *
 * The ephemeral state frames are sent over the existing sync socket and are a
 * no-op while it is closed — the SDK drops them rather than erroring, and the
 * state is re-sent when the call reconnects, so there is nothing to queue.
 */
export function voiceCall(): VoiceCallState {
  if (session) return session;
  session = new VoiceCallState({
    getToken: (roomId) => getVoiceToken(roomId),
    joinCall,
    leaveCall,
    sendVoiceState: (roomId, muted, deafened) =>
      sync_.ctx?.sendVoiceState(roomId, muted, deafened),
    reportError: (message: VoiceErrorMessage) => {
      toast.error(message.title, { description: message.description });
    },
  });
  return session;
}

