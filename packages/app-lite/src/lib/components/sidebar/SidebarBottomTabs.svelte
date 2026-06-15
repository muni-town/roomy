<script lang="ts">
  import { page } from "$app/state";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import { IconBell, IconSettings, IconUserPlus } from "@roomy/design/icons";
  import Tooltip from "@roomy/design/components/helper/Tooltip.svelte";

  const currentSpaceId = $derived(page.params.space);
</script>

<div
  class="shrink-0 flex items-stretch gap-1 px-2 py-2 justify-center"
>
  <!-- Notifications -->
  <Tooltip tip="notifications — coming soon" side="right" sideOffset={8}>
    {#snippet trigger({ props })}
      <span {...props} class="flex-1">
        <Button
          variant="secondary"
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
    variant="secondary"
    size="default"
    class="flex-1 justify-center"
    aria-label="Invite"
    title="Invite"
  >
    <IconUserPlus />
  </Button>

  <!-- Settings -->
  <Button
    variant="secondary"
    size="default"
    class="flex-1 justify-center"
    aria-label="Settings"
    title="Settings"
    href={currentSpaceId ? `/${currentSpaceId}/settings` : undefined}
  >
    <IconSettings />
  </Button>
</div>