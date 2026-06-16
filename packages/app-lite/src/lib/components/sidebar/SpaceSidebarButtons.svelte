<script lang="ts">
  import { page } from "$app/state";
  import { toast } from "@foxui/core";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import { IconBell, IconSettings, IconUserPlus } from "@roomy/design/icons";
  import Tooltip from "@roomy/design/components/helper/Tooltip.svelte";

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
  class="shrink-0 flex items-stretch gap-1 px-2 py-2 justify-center"
>
  <!-- Notifications -->
  <Tooltip tip="notifications — coming soon" side="right" sideOffset={8}>
    {#snippet trigger({ props })}
      <span {...props} class="flex-1">
        <Button
          variant="ghost"
          size="default"
          class="w-full justify-center"
          aria-label="Notifications"
          disabled
        >
          <IconBell />
        </Button>
      </span>
    {/snippet}
  </Tooltip>

  <!-- Invite -->
  <Button
    variant="ghost"
    size="default"
    class="flex-1 justify-center"
    aria-label="Invite"
    title="Invite"
    onclick={handleInvite}
  >
    <IconUserPlus />
  </Button>

  <!-- Settings -->
  <Button
    variant="ghost"
    size="default"
    class="flex-1 justify-center"
    aria-label="Settings"
    title="Settings"
    href={currentSpaceId ? `/${currentSpaceId}/settings` : undefined}
  >
    <IconSettings />
  </Button>
</div>