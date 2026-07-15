<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { toast } from "@foxui/core";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import { IconBell, IconSettings, IconUserPlus, IconX } from "@roomy/design/icons";
  import Tooltip from "@roomy/design/components/helper/Tooltip.svelte";
  import { settingsBar } from "$lib/components/layout/settings-bar.svelte";
  import { spaceNavigation } from "$lib/components/layout/last-room.svelte";

  let {
    spaceId = $bindable(),
    allowPublicJoin = false,
    onInvite,
  }: {
    spaceId?: string;
    allowPublicJoin?: boolean;
    onInvite?: () => void;
  } = $props();

  const currentSpaceId = $derived(spaceId ?? page.params.space);

  // The cogs only swap to an X while hovered when the panel is open, so the
  // button reads as “settings” at rest and “close” on intent.
  let settingsHovered = $state(false);

  // Opening the settings panel just slides it in (no navigation) — the user
  // navigates by selecting a page from it. Closing it navigates back to the
  // space's most recently accessed channel, the same way the space selector
  // lands on a space, so dismissing settings returns you to where you were.
  function toggleSettings() {
    if (!settingsBar.expanded) {
      settingsBar.expanded = true;
      return;
    }
    settingsBar.expanded = false;
    const sid = currentSpaceId;
    if (!sid) return;
    const destination = spaceNavigation.get(sid)?.destination;
    const target =
      destination?.kind === "room"
        ? `/${sid}/${destination.id}`
        : `/${sid}`;
    if (page.url.pathname !== target) {
      goto(target);
    }
  }

  function handleInvite() {
    if (onInvite) {
      onInvite();
    } else if (allowPublicJoin && currentSpaceId) {
      const url = new URL(page.url.href);
      url.pathname = `/${currentSpaceId}`;
      navigator.clipboard.writeText(url.href).then(() => {
        toast.success("Invite link copied to clipboard");
      }).catch(() => {});
    }
  }
</script>

<div
  class="shrink-0 grid grid-cols-3 gap-1 px-2 py-2"
>
  <!-- Notifications -->
  <Button
    variant="ghost"
    size="default"
    class="w-full justify-center"
    aria-label="Notifications"
    title="Notifications"
    onclick={() => goto(`/${currentSpaceId}/settings/notifications`)}
  >
    <IconBell />
  </Button>

  <!-- Invite -->
  <Button
    variant="ghost"
    size="default"
    class="w-full justify-center"
    aria-label="Invite"
    title="Invite"
    onclick={handleInvite}
  >
    <IconUserPlus />
  </Button>

  <!-- Settings: opens the settings panel (slides in from the right) without
       navigating; the user navigates by selecting a page from the panel.
       Closing it navigates back to the space's most recently accessed channel,
       like the space selector. The cogs swap to an X only while hovered when
       the panel is open, signalling “close”. -->
  <Button
    variant="ghost"
    size="default"
    class="w-full justify-center"
    aria-label={settingsBar.expanded ? "Close settings" : "Settings"}
    title={settingsBar.expanded ? "Close settings" : "Settings"}
    aria-expanded={settingsBar.expanded}
    data-current={settingsBar.expanded}
    onclick={toggleSettings}
    onmouseenter={() => (settingsHovered = true)}
    onmouseleave={() => (settingsHovered = false)}
  >
    {#if settingsBar.expanded && settingsHovered}
      <IconX />
    {:else}
      <IconSettings />
    {/if}
  </Button>
</div>