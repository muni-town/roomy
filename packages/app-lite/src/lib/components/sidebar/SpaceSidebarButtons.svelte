<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { toast } from "@foxui/core";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import { IconBell, IconSettings, IconUserPlus, IconX } from "@roomy/design/icons";
  import { settingsBar } from "$lib/components/layout/settings-bar.svelte";
  import { spaceNavigation } from "$lib/components/layout/last-room.svelte";
  import { createFeatureFlagsQuery } from "$lib/queries/feature-flags";
  import { createFederationRequestsQuery } from "$lib/queries/federation";

  let {
    spaceId = $bindable(),
    allowPublicJoin = false,
    isAdmin = false,
    onInvite,
  }: {
    spaceId?: string;
    allowPublicJoin?: boolean;
    isAdmin?: boolean;
    onInvite?: () => void;
  } = $props();

  const currentSpaceId = $derived(spaceId ?? page.params.space);

  // Channel-federation flag gate + pending-request badge (admins only).
  const flagsQuery = createFeatureFlagsQuery();
  const federationEnabled = $derived(
    flagsQuery.data?.flags.includes("channel-federation") ?? false,
  );
  const requestsQuery = createFederationRequestsQuery(
    () => currentSpaceId ?? "",
    { enabled: () => federationEnabled && isAdmin && !!currentSpaceId },
  );
  const pendingRequestCount = $derived(
    requestsQuery.data?.requests?.length ?? 0,
  );

  // When the settings panel is open, the button shows an X (close) icon.
  // When closed, it shows the settings cog.

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
    const destination = spaceNavigation.get(sid);
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
       like the space selector. The button shows an X when the panel is open. -->
  <div class="relative">
    <Button
      variant="ghost"
      size="default"
      class="w-full justify-center"
      aria-label={settingsBar.expanded ? "Close settings" : "Settings"}
      title={settingsBar.expanded ? "Close settings" : "Settings"}
      aria-expanded={settingsBar.expanded}
      data-current={settingsBar.expanded}
      onclick={toggleSettings}
    >
      <span class="relative inline-flex">
        {#if settingsBar.expanded}
          <IconX />
        {:else}
          <IconSettings />
        {/if}
        {#if !settingsBar.expanded && pendingRequestCount > 0}
          <span
            class="absolute -top-1.5 -right-1.5 min-w-4 h-4 px-1 rounded-full bg-accent-500 text-white text-[10px] font-bold flex items-center justify-center pointer-events-none"
            title={`${pendingRequestCount} pending federation ${pendingRequestCount === 1 ? "request" : "requests"}`}
          >
            {pendingRequestCount}
          </span>
        {/if}
      </span>
    </Button>
  </div>
</div>