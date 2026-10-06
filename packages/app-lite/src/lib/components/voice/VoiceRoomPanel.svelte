<script lang="ts">
  /**
   * A voice room's call surface.
   *
   * It renders one of two things depending on whether the viewer is in the
   * call, and it decides that from the session rather than from a prop, so the
   * panel and the sidebar can never disagree about who is connected:
   *
   *   - **Participant view** (the viewer is in this room's call): the
   *     participants with speaking indicators, and the mute/deafen/leave
   *     controls.
   *   - **Observer view** (someone else's call, or one the viewer has not
   *     joined): who is in it, from the `getParticipants` projection, plus a
   *     Join button.
   *
   * When the appserver has no LiveKit configured, `getToken` reports it and
   * the session records that — the Join affordance is replaced by an
   * explanation rather than a button that does nothing.
   */
  import { createVoiceParticipantsQuery } from "$lib/queries/voice";
  import { voiceCall } from "$lib/voice/session.svelte";
  import { voicePresence } from "$lib/voice/presence.svelte";
  import { auth } from "$lib/auth.svelte";
  import VoiceParticipantRow from "./VoiceParticipantRow.svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import LoadingSpinner from "@roomy/design/components/helper/LoadingSpinner.svelte";
  import {
    IconMicrophone,
    IconMicrophoneSlash,
    IconPhoneDisconnect,
    IconSpeakerHigh,
    IconSpeakerSlash,
  } from "@roomy/design/icons";

  let { roomId }: { roomId: string } = $props();

  const session = voiceCall();
  const participantsQuery = createVoiceParticipantsQuery(() => roomId);

  const inThisCall = $derived(session.connected && session.roomId === roomId);
  /**
   * While connected the SFU's list is authoritative and richer — it carries
   * speaking state the projection does not.
   */
  const liveParticipants = $derived(inThisCall ? session.participants() : []);

  /**
   * Seed the presence store from the projection.
   *
   * The projection is the source of truth for who is in a call; the store is
   * what frames patch between reads. Writing each successful response into the
   * store is what makes the two a single view — a `#voicePresenceDiff` that
   * lands while this query is in flight is not then overwritten by the older
   * snapshot, because the snapshot arrived first and the frame patched on top
   * of it.
   */
  $effect(() => {
    const data = participantsQuery.data;
    if (!data) return;
    voicePresence.applySnapshot(roomId, data.callId, data.participants);
  });

  /** The room's call, as the store holds it — frames and snapshots together. */
  const observerParticipants = $derived(voicePresence.participants(roomId));
  const roomHasCall = $derived(
    inThisCall || voicePresence.hasActiveCall(roomId),
  );
  const participantCount = $derived(
    inThisCall ? liveParticipants.length : observerParticipants.length,
  );
  const currentUserDid = $derived(auth.userDid);

  /**
   * Join the call.
   *
   * Nothing is asked about scope here. The voice RPCs sit outside `base`
   * (`scopes.ts`) and their scopes are not registered on the HappyView API
   * client, so no login may request them and no consent round-trip could grant
   * them — offering one would turn a recoverable failure into a sign-in outage,
   * the same reason `blocks` is ceiling-only. A session without the scope
   * learns that from the join failing, and `connectionErrorMessage` names the
   * permission rather than the transport. When the scopes are registered, this
   * is where the consent dialogue returns.
   */
  async function join() {
    await session.join(roomId);
  }

  // Leaving the room ends the viewer's call: the microphone must not keep
  // capturing for a room that is no longer on screen, and a call whose panel
  // unmounted without a leave would leave the viewer in the participant list.
  // Navigating to another voice room remounts the panel keyed on `roomId`, so
  // this fires on the way out and the next room starts fresh.
  $effect(() => {
    return () => {
      if (session.roomId === roomId) void session.leave();
    };
  });
</script>

<div class="flex flex-col h-full min-h-0 gap-4 p-4">
  <div class="flex items-center justify-between gap-2">
    <h2 class="text-sm font-semibold text-base-700 dark:text-base-200">
      {#if roomHasCall}
        In this call · {participantCount}
      {:else}
        Voice room
      {/if}
    </h2>
    {#if participantsQuery.isFetching && !roomHasCall}
      <LoadingSpinner size={16} />
    {/if}
  </div>

  {#if session.unavailable && !roomHasCall}
    <p class="text-sm text-base-500 dark:text-base-400">
      Voice is not available on this server.
    </p>
  {:else if !roomHasCall}
    <div class="flex flex-col items-center justify-center flex-1 gap-3 text-center">
      <p class="text-sm text-base-500 dark:text-base-400">
        No one is in the call right now.
      </p>
      <Button variant="primary" onclick={join} disabled={session.connecting}>
        {session.connecting ? "Joining…" : "Join call"}
      </Button>
    </div>
  {:else if inThisCall}
    <ul class="flex flex-col gap-1 overflow-y-auto min-h-0 flex-1">
      {#each liveParticipants as participant (participant.did)}
        <VoiceParticipantRow
          did={participant.did}
          muted={participant.muted}
          speaking={participant.speaking}
          audioLevel={participant.audioLevel}
          isSelf={participant.local}
        />
      {/each}
    </ul>

    <div class="flex items-center justify-center gap-2">
      <Button
        variant={session.muted ? "secondary" : "ghost"}
        size="icon"
        aria-label={session.muted ? "Unmute" : "Mute"}
        aria-pressed={session.muted}
        onclick={() => session.setMuted(!session.muted)}
      >
        {#if session.muted}
          <IconMicrophoneSlash />
        {:else}
          <IconMicrophone />
        {/if}
      </Button>
      <Button
        variant={session.deafened ? "secondary" : "ghost"}
        size="icon"
        aria-label={session.deafened ? "Undeafen" : "Deafen"}
        aria-pressed={session.deafened}
        onclick={() => session.setDeafened(!session.deafened)}
      >
        {#if session.deafened}
          <IconSpeakerSlash />
        {:else}
          <IconSpeakerHigh />
        {/if}
      </Button>
      <Button variant="red" size="sm" onclick={() => session.leave()}>
        <IconPhoneDisconnect />
        Leave
      </Button>
    </div>
  {:else}
    <ul class="flex flex-col gap-1 overflow-y-auto min-h-0 flex-1">
      {#each observerParticipants as participant (participant.did)}
        <VoiceParticipantRow
          did={participant.did}
          muted={participant.muted}
          isSelf={participant.did === currentUserDid}
        />
      {/each}
    </ul>

    <div class="flex justify-center">
      <Button variant="primary" onclick={join} disabled={session.connecting}>
        {session.connecting ? "Joining…" : "Join call"}
      </Button>
    </div>
  {/if}
</div>
