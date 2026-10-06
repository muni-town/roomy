<script lang="ts">
  import { schemas } from "@roomy-space/sdk";
  import { IconGlobe, IconHashtag, IconPhone } from "@roomy/design/icons";

  type SidebarChannel =
    typeof schemas.queries.getSpaceMetadata.SidebarChannel.infer;

  let {
    channel,
    /**
     * The room's kind. A voice room lives in `getMetadata.voiceRooms` rather
     * than the channel tree, so the caller knows which list it came from and
     * this component does not have to re-derive it from the id.
     */
    kind = "channel",
    /**
     * Whether the room's call is live right now. Derived by the caller from
     * the active-call query: the channel entry is a list row and carries no
     * call state.
     */
    callActive = false,
  }: {
    channel: SidebarChannel;
    kind?: "channel" | "voice";
    callActive?: boolean;
  } = $props();
</script>

{#if channel.federated !== undefined}
  <IconGlobe
    class="shrink-0 size-3.5 text-base-500"
    aria-label="Federated from another space"
  />
{:else if kind === "voice"}
  <!-- The dot is the whole affordance: a voice room with a live call reads the
       same at a glance regardless of the row's unread styling. -->
  <span
    class="relative shrink-0"
    aria-label={callActive ? "Call in progress" : "Voice room"}
  >
    <IconPhone class="shrink-0 text-base-500" />
    {#if callActive}
      <span
        class="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-accent-500 motion-safe:animate-pulse"
      ></span>
    {/if}
  </span>
{:else}
  <IconHashtag class="shrink-0 text-base-500" />
{/if}
