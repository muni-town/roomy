<script lang="ts">
  /**
   * One participant row in a call.
   *
   * Owns its own profile lookup: a hook cannot be called in a loop, so the
   * row (one per participant) is the component that runs the query. The DID
   * is what the call facts and the SFU both identify a participant by, so it
   * is the fallback whenever the profile does not resolve — the row never
   * renders empty.
   */
  import { createProfileQuery } from "$lib/queries/profile";
  import UserAvatar from "@roomy/design/components/user/UserAvatar.svelte";
  import { IconMicrophoneSlash } from "@roomy/design/icons";
  import { resolveBlobUrl } from "$lib/utils";

  let {
    did,
    muted = false,
    speaking = false,
    audioLevel = 0,
    isSelf = false,
  }: {
    did: string;
    muted?: boolean;
    speaking?: boolean;
    /** 0–1, from the SFU; drives how strongly the speaking ring reads. */
    audioLevel?: number;
    isSelf?: boolean;
  } = $props();

  const profileQuery = createProfileQuery(() => did);
  const name = $derived(
    isSelf
      ? "You"
      : (profileQuery.data?.displayName ??
        profileQuery.data?.handle ??
        `${did.slice(0, 12)}…`),
  );
  const avatar = $derived(resolveBlobUrl(profileQuery.data?.avatar));
</script>

<li class="flex items-center gap-2.5 px-2 py-1.5 rounded-lg">
  <span
    class="shrink-0 rounded-full transition-[box-shadow] duration-75"
    style={speaking
      ? `box-shadow: 0 0 0 2px color-mix(in oklab, var(--color-accent-500) ${Math.round(
          35 + audioLevel * 65,
        )}%, transparent)`
      : "box-shadow: 0 0 0 2px transparent"}
  >
    <UserAvatar src={avatar} name={did} size={28} class="size-7" />
  </span>
  <span class="truncate text-sm text-base-700 dark:text-base-200">{name}</span>
  {#if muted}
    <IconMicrophoneSlash
      class="size-4 shrink-0 text-base-400 dark:text-base-500"
      aria-label="Muted"
    />
  {/if}
</li>
