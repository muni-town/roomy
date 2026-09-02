<script lang="ts">
  import UserAvatar from "@roomy/design/components/user/UserAvatar.svelte";
  import { IconForward } from "@roomy/design/icons";
  import { formatMessageTimestamp } from "@roomy/design/utils";
  import { resolveBlobUrl } from "$lib/utils";

  let {
    name,
    did,
    avatar,
    timestamp,
    spaceId,
    roomId,
    messageId,
  }: {
    /** The forwarding user's display name. */
    name?: string;
    /** The forwarding user's DID (used for the profile link). */
    did?: string;
    /** The forwarding user's avatar URL (blob or resolved). */
    avatar?: string;
    /** When the message was forwarded. */
    timestamp: Date;
    /** Space the original message lives in (for the back-link). */
    spaceId?: string;
    /** Room the original message lives in (for the back-link). */
    roomId?: string;
    /** The original message's id (for the back-link). */
    messageId?: string;
  } = $props();

  // Bridged (Discord) forwards have no navigable profile; render name as text.
  const isBridged = $derived(did?.startsWith("did:discord:") ?? false);
  // The context line links back to the original message. The room page does
  // not handle `?message=` yet, but the param is the agreed contract for
  // deep-linking to a specific message.
  const originalHref = $derived(
    spaceId && roomId && messageId
      ? `/${spaceId}/${roomId}?message=${messageId}`
      : undefined,
  );
</script>

<div class="flex items-center gap-1.5 text-sm text-base-500 dark:text-base-400 pl-0.5">
  <IconForward class="size-3.5 shrink-0 text-base-400 dark:text-base-500" />
  {#if did || avatar}
    <span class="w-4 h-4 rounded-full shrink-0">
      <UserAvatar
        src={resolveBlobUrl(avatar)}
        name={did || name || "unknown"}
        size={16}
        class="w-4 h-4"
      />
    </span>
  {/if}
  {#if did && !isBridged}
    <a
      href={`/user/${did}`}
      class="font-medium text-accent-700 dark:text-accent-400 hover:underline truncate"
    >
      {name || did.slice(0, 12)}
    </a>
  {:else}
    <span class="font-medium text-accent-700 dark:text-accent-400 truncate">
      {name || did?.slice(0, 12)}
    </span>
  {/if}
  {#if originalHref}
    <a
      href={originalHref}
      class="shrink-0 hover:underline"
      title="View original message"
    >
      forwarded
    </a>
  {:else}
    <span class="shrink-0">forwarded</span>
  {/if}
  <time class="shrink-0 text-[13px] opacity-70">{formatMessageTimestamp(timestamp)}</time>
</div>
