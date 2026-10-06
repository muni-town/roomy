import { px } from "$lib/auth.svelte";

/**
 * Record the caller's join intent.
 *
 * Sent before connecting to the SFU so the participant list is optimistic: a
 * user whose media is still coming up is already visible to the room, and a
 * join that never reaches the SFU is retracted by the matching `leaveCall`.
 */
export async function joinCall(roomId: string): Promise<void> {
  await px().procedure("space.roomy.voice.join", { roomId });
}

/**
 * Record the caller's leave intent. When they were the last participant the
 * appserver ends the call, which the room learns as a `#voicePresenceDiff`.
 */
export async function leaveCall(roomId: string): Promise<void> {
  await px().procedure("space.roomy.voice.leave", { roomId });
}

/**
 * Mint the caller's LiveKit token, the per-call E2EE key, and the SFU URL.
 *
 * Every field is null when the deployment has no LiveKit configured — that is
 * the signal the client gates all call UI on, so it is returned rather than
 * thrown.
 */
export async function getVoiceToken(roomId: string) {
  return px().query("space.roomy.voice.getToken", { roomId });
}
