<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import ToggleGroup from "@roomy/design/components/ui/toggle-group/ToggleGroup.svelte";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import ScrollArea from "@roomy/design/components/layout/ScrollArea.svelte";
  import ErrorMessage from "@roomy/design/components/helper/ErrorMessage.svelte";
  import { IconArrowLeft, IconBell } from "@roomy/design/icons";
  import { setNavbar } from "$lib/components/layout/navbar.svelte";
  import { setSidebar } from "$lib/components/layout/sidebar.svelte";
  import { createSpacesQuery } from "$lib/queries/spaces";
  import { createPushPreferencesQuery } from "$lib/queries/push-preferences";
  import { setDefaultPushLevel, setSpacePushLevel, type PushLevel } from "$lib/mutations/push-preferences";
  import { ensurePushSubscription, clearPushSubscription, pushOutcomeMessage } from "$lib/push.svelte";
  import { toast } from "@foxui/core";
  import { queryClient } from "$lib/client";
  import { cache } from "@roomy-space/sdk";
  import { resolveBlobUrl } from "$lib/utils";

  const spacesQuery = createSpacesQuery({ includeLeft: false });
  const prefsQuery = createPushPreferencesQuery();

  /** Level options shown in the selectors. */
  const LEVEL_OPTIONS: { label: string; value: PushLevel }[] = [
    { label: "Silent", value: "silent" },
    { label: "Quiet", value: "quiet" },
    { label: "Engaged", value: "engaged" },
    { label: "Busy", value: "busy" },
  ];

  /** One-line explanation per level (shown under the default selector). */
  const LEVEL_DESC: Record<PushLevel, string> = {
    silent: "No notifications — never bug me.",
    quiet: "Only when mentioned. (Coming in Phase 3.)",
    engaged: "A periodic digest of missed activity. (Coming in Phase 2.)",
    busy: "Real-time notification for every message — active now.",
  };

  // ── Push capability + permission state (browser-side, not on the server) ──
  let pushSupported = $state(false);
  let permission = $state<NotificationPermission>("default");
  let endpoint = $state<string | null>(null); // registered PushSubscription endpoint
  let enabling = $state(false);
  let disabling = $state(false);
  let enableError = $state<string | null>(null);

  async function refreshStatus(): Promise<void> {
    pushSupported =
      typeof navigator !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      typeof Notification !== "undefined";
    if (typeof Notification !== "undefined") {
      permission = Notification.permission;
    }
    if (pushSupported) {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        endpoint = sub?.endpoint ?? null;
      } catch {
        endpoint = null;
      }
    }
  }

  /**
   * Enable notifications from this explicit click (a user gesture — required
   * by Safari, which blocks `Notification.requestPermission()` outside a
   * gesture). Idempotent: re-running with permission already granted just
   * re-registers the subscription. Toasts the outcome so unsupported browsers
   * (e.g. vanilla Chromium without Google FCM keys) get visible feedback
   * instead of a silent console error.
   */
  async function enableNotifications(): Promise<void> {
    enabling = true;
    enableError = null;
    try {
      const outcome = await ensurePushSubscription();
      if (outcome.status === "ok") {
        toast.success("Notifications enabled");
      } else {
        const msg = pushOutcomeMessage(outcome);
        enableError = msg;
        toast.error(msg);
      }
      await refreshStatus();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      enableError = msg;
      toast.error(`Couldn't enable notifications: ${msg}`);
    } finally {
      enabling = false;
    }
  }

  /** Disable notifications for this device: unregister + unsubscribe. */
  async function disableNotifications(): Promise<void> {
    disabling = true;
    try {
      const outcome = await clearPushSubscription();
      if (outcome.status === "ok") {
        toast.success("Notifications disabled on this device");
      } else if (outcome.status !== "unsupported") {
        toast.error(pushOutcomeMessage(outcome));
      }
      await refreshStatus();
    } catch (e) {
      enableError = e instanceof Error ? e.message : String(e);
    } finally {
      disabling = false;
    }
  }

  async function onChangeDefault(level: PushLevel): Promise<void> {
    await setDefaultPushLevel(level);
    await queryClient.invalidateQueries({
      queryKey: cache.queryKey("space.roomy.push.getPushPreferences"),
    });
  }

  async function onChangeSpace(spaceId: string, level: PushLevel): Promise<void> {
    await setSpacePushLevel(spaceId, level);
    await queryClient.invalidateQueries({
      queryKey: cache.queryKey("space.roomy.push.getPushPreferences"),
    });
  }

  /** Resolve the effective level for a space (override → default). */
  function effectiveLevel(spaceId: string, fallback: PushLevel): PushLevel {
    const overrides = prefsQuery.data?.perSpace ?? [];
    const ov = overrides.find((o: { spaceId: string }) => o.spaceId === spaceId);
    return (ov?.level as PushLevel | undefined) ?? fallback;
  }

  onMount(() => {
    setNavbar(settingsNavbar);
    setSidebar(settingsSidebar);
    refreshStatus();
    return () => {
      setNavbar(undefined);
      setSidebar(undefined);
    };
  });
</script>

{#snippet settingsNavbar()}
  <div class="flex-1 text-center font-bold text-lg text-base-900 dark:text-base-100">
    Notifications
  </div>
{/snippet}

{#snippet settingsSidebar()}
  <div class="flex flex-col h-full">
    <div class="p-3">
      <Button class="w-full justify-start" href="/" variant="ghost">
        <IconArrowLeft class="size-4" />
        Back to home
      </Button>
    </div>
    <div class="flex flex-col gap-1 px-3">
      <span class="text-[11px] font-semibold uppercase tracking-wider text-base-400 dark:text-base-500 px-2">
        Settings
      </span>
      <Button
        variant="ghost"
        class="w-full justify-start"
        href="/user/settings"
        data-current={page.url.pathname === "/user/settings"}
      >
        General
      </Button>
      <Button
        variant="ghost"
        class="w-full justify-start"
        href="/user/settings/notifications"
        data-current={page.url.pathname === "/user/settings/notifications"}
      >
        Notifications
      </Button>
    </div>
  </div>
{/snippet}

<ScrollArea class="h-full">
  <div class="max-w-3xl mx-auto w-full p-4 flex flex-col gap-10">
    <!-- Enable / status section -->
    <section>
      <h2 class="text-base font-semibold mb-4 text-base-900 dark:text-base-100 flex items-center gap-2">
        <IconBell class="size-4" />
        Notifications
      </h2>

      {#if !pushSupported}
        <p class="text-sm text-base-400">
          Web push isn't supported in this browser. Use a supported browser
          (Firefox, Chrome, Edge, Brave, or Safari 16.1+) to receive
          notifications.
        </p>
      {:else}
        <div class="flex flex-col gap-3">
          {#if permission === "denied"}
            <p class="text-sm text-base-400">
              Notifications are blocked in your browser settings. Re-enable them
              in the site permissions, then click Enable again.
            </p>
          {:else if endpoint}
            <div class="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                onclick={disableNotifications}
                disabled={disabling}
              >
                {disabling ? "Disabling…" : "Disable on this device"}
              </Button>
            </div>
          {:else}
            <Button
              size="sm"
              variant="secondary"
              onclick={enableNotifications}
              disabled={enabling}
            >
              {enabling ? "Enabling…" : "Enable notifications"}
            </Button>
          {/if}

          {#if enableError}
            <ErrorMessage message={enableError} class="py-2" />
          {/if}
        </div>
      {/if}
    </section>

    {#if pushSupported && endpoint}
      <!-- Default level -->
      <section>
        <h2 class="text-base font-semibold mb-1 text-base-900 dark:text-base-100">
          Default notification level
        </h2>
        <p class="text-sm text-base-400 mb-4">
          Applies to every space you're a member of unless overridden below.
        </p>

        {#if prefsQuery.isPending}
          <p class="text-sm text-base-400">Loading preferences…</p>
        {:else if prefsQuery.isError}
          <ErrorMessage message="Error: {prefsQuery.error.message}" class="py-4" />
        {:else if prefsQuery.data}
          {@const current = prefsQuery.data.default as PushLevel}
          <div class="flex flex-col gap-2">
            <ToggleGroup
              name="defaultLevel"
              value={current}
              options={LEVEL_OPTIONS}
              onchange={(v: string) => onChangeDefault(v as PushLevel)}
            />
            <p class="text-sm text-base-400">{LEVEL_DESC[current]}</p>
          </div>
          <p class="text-xs text-base-400 mt-3">
            Only <strong>Busy</strong> delivers real-time notifications today;
            the other levels are under active development.
          </p>
        {/if}
      </section>

      <!-- Per-space overrides -->
      <section>
        <h2 class="text-base font-semibold mb-1 text-base-900 dark:text-base-100">
          Per-space overrides
        </h2>
        <p class="text-sm text-base-400 mb-4">
          Pick a level for an individual space. Setting one creates an override
          (you can change it, but removing it comes later).
        </p>

        {#if spacesQuery.isPending}
          <p class="text-sm text-base-400">Loading spaces…</p>
        {:else if spacesQuery.isError}
          <ErrorMessage message="Error: {spacesQuery.error.message}" class="py-4" />
        {:else if spacesQuery.data}
          {@const members = spacesQuery.data.spaces.filter((s: { isMember: boolean }) => s.isMember)}

          {#if members.length === 0}
            <p class="text-sm text-base-400">You're not a member of any spaces.</p>
          {:else if prefsQuery.data}
            {@const fallback = (prefsQuery.data.default as PushLevel) ?? "engaged"}
            <div class="flex flex-col gap-4">
              {#each members as space (space.id)}
                <div class="flex items-center justify-between gap-4">
                  <div class="flex items-center gap-3 min-w-0">
                    <SpaceAvatar
                      src={resolveBlobUrl(space.avatar)}
                      id={space.id}
                      name={space.name ?? undefined}
                      size={36}
                    />
                    <span class="text-sm font-medium truncate text-base-700 dark:text-base-300">
                      {space.name || "Unnamed Space"}
                    </span>
                  </div>
                  <ToggleGroup
                    name={"level-" + space.id}
                    value={effectiveLevel(space.id, fallback)}
                    options={LEVEL_OPTIONS}
                    onchange={(v: string) => onChangeSpace(space.id, v as PushLevel)}
                  />
                </div>
              {/each}
            </div>
          {/if}
        {/if}
      </section>
    {/if}
  </div>
</ScrollArea>