import { createQuery } from "@tanstack/svelte-query";
import { cache, schemas } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

export type VoiceParticipant = typeof schemas.queries.getVoiceParticipants.Participant.infer;
export type VoiceActiveCall = typeof schemas.queries.getVoiceActiveCalls.ActiveCall.infer;

/**
 * Who is in a room's call, from the server's projection.
 *
 * The projection is authoritative over anything the client accumulated from
 * `#voicePresenceDiff` frames — a client that was disconnected during a
 * transition finds out here. The sync layer invalidates this key on every
 * call fact, so a mounted observer panel re-reads it without polling.
 *
 * `callId` answers a different question than the participant list: null means
 * the room has no call right now, which is what turns the observer panel back
 * into a Join button.
 */
export function createVoiceParticipantsQuery(roomId: () => string) {
  return createQuery(() => ({
    queryKey: queryKey("space.roomy.voice.getParticipants", { roomId: roomId() }),
    queryFn: () =>
      px().query("space.roomy.voice.getParticipants", { roomId: roomId() }),
    enabled: !!roomId(),
    // A missing room 404s deterministically; the voice handler's access check
    // (403) is equally final. Neither changes by asking again — transport
    // retries for rate limits live in DirectXrpcClient.
    retry: false,
  }));
}

/**
 * Which rooms in a space have a live call, for the sidebar's call marker.
 *
 * Space-scoped because the appserver resolves access per space. Invalidated
 * by every call fact in that space, so the marker appears and disappears
 * without the sidebar refetching on a timer.
 *
 * `opts.enabled` is the caller's gate, and it is an accessor for the same
 * reason the room id is: the sidebar stays mounted across spaces, so a plain
 * boolean would freeze at whatever the flag said on first render.
 */
export function createVoiceActiveCallsQuery(
  spaceId: () => string,
  opts?: { enabled?: boolean | (() => boolean) },
) {
  return createQuery(() => ({
    queryKey: queryKey("space.roomy.voice.getActiveCalls", { spaceId: spaceId() }),
    queryFn: () =>
      px().query("space.roomy.voice.getActiveCalls", { spaceId: spaceId() }),
    enabled:
      !!spaceId() &&
      (typeof opts?.enabled === "function" ? opts.enabled() : opts?.enabled !== false),
    retry: false,
  }));
}
