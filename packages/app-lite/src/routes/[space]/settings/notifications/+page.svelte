<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import UpdateRhythmChooser from "@roomy/design/components/user/UpdateRhythmChooser.svelte";
  import ErrorMessage from "@roomy/design/components/helper/ErrorMessage.svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import { IconBell } from "@roomy/design/icons";
  import { createPushPreferencesQuery } from "$lib/queries/push-preferences";
  import { setSpacePushLevel, type PushLevel } from "$lib/mutations/push-preferences";
  import { getPushSubscriptionEndpoint } from "$lib/push.svelte";

  const spaceId = $derived(page.params.space!);
  const prefsQuery = createPushPreferencesQuery();

  // Local state for the chooser — initialized from query data but not
  // re-derived on every render, so the $bindable in UpdateRhythmChooser
  // isn't overwritten by stale cache data during a re-render cycle.
  let current = $state<PushLevel>("engaged");

  $effect(() => {
    if (prefsQuery.data) {
      current =
        (prefsQuery.data.perSpace?.find(
          (o: { spaceId: string }) => o.spaceId === spaceId,
        )?.level ?? prefsQuery.data.default ?? "engaged") as PushLevel;
    }
  });

  async function onChange(level: PushLevel): Promise<void> {
    current = level;
    await setSpacePushLevel(spaceId, level);
  }

  // ── Push capability on this device ──
  let pushEnabled = $state(false);
  let pushChecked = $state(false);

  onMount(() => {
    getPushSubscriptionEndpoint().then((endpoint) => {
      pushEnabled = endpoint !== null;
      pushChecked = true;
    });
  });
</script>

<div class="max-w-2xl">
  <p class="text-sm text-base-700 dark:text-base-300 mb-6">
    Choose how often you receive push notifications from this space.
    This overrides your default notification level.
  </p>

  {#if !pushChecked}
    <p class="text-sm text-base-400">Loading…</p>
  {:else if !pushEnabled}
    <div class="flex flex-col gap-3">
      <p class="text-sm text-base-400 flex items-center gap-2">
        <IconBell class="size-4 shrink-0" />
        Notifications aren't enabled on this device yet. Enable them in your
        notification settings to choose how this space updates you.
      </p>
      <div>
        <Button size="sm" variant="secondary" href="/user/settings/notifications">
          Go to notification settings
        </Button>
      </div>
    </div>
  {:else if prefsQuery.isPending}
    <p class="text-sm text-base-400">Loading preferences…</p>
  {:else if prefsQuery.isError}
    <ErrorMessage message="Error: {prefsQuery.error.message}" class="py-4" />
  {:else}
    <UpdateRhythmChooser
      value={current}
      horizontal={true}
      name="spaceLevel"
      onchange={(v) => onChange(v)}
    />
    <p class="text-xs text-base-400 mt-3">
      Only <strong>Busy</strong> delivers real-time notifications today;
      the other levels are under active development.
    </p>
  {/if}
</div>