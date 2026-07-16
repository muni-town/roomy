<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import UpdateRhythmChooser from "@roomy/design/components/user/UpdateRhythmChooser.svelte";
  import ScrollArea from "@roomy/design/components/layout/ScrollArea.svelte";
  import ErrorMessage from "@roomy/design/components/helper/ErrorMessage.svelte";
  import { IconArrowLeft, IconBell } from "@roomy/design/icons";
  import { setNavbar } from "$lib/components/layout/navbar.svelte";
  import { setSidebar } from "$lib/components/layout/sidebar.svelte";
  import { createPushPreferencesQuery } from "$lib/queries/push-preferences";
  import { setDefaultPushLevel, type PushLevel } from "$lib/mutations/push-preferences";
  import { ensurePushSubscription, clearPushSubscription, pushOutcomeMessage, isPushFeatureEnabled } from "$lib/push.svelte";
  import { toast } from "@foxui/core";

  const prefsQuery = createPushPreferencesQuery();

  // Local state for the chooser — not re-derived from query data on every
  // render, so the $bindable in UpdateRhythmChooser isn't overwritten.
  let defaultLevel = $state<PushLevel>("engaged");

  $effect(() => {
    if (prefsQuery.data) {
      defaultLevel = (prefsQuery.data.default ?? "engaged") as PushLevel;
    }
  });

  // ── Feature flag gate ──
  let featureEnabled = $state<boolean | null>(null);

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
    defaultLevel = level;
    await setDefaultPushLevel(level);
  }

  onMount(() => {
    setNavbar(settingsNavbar);
    setSidebar(settingsSidebar);
    isPushFeatureEnabled().then((enabled) => {
      featureEnabled = enabled;
    });
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
    {#if featureEnabled === null}
      <p class="text-sm text-base-400">Loading…</p>
    {:else if !featureEnabled}
      <section>
        <h2 class="text-base font-semibold mb-4 text-base-900 dark:text-base-100 flex items-center gap-2">
          <IconBell class="size-4" />
          Notifications
        </h2>
        <p class="text-sm text-base-400">
          Push notifications are not yet available for your account.
        </p>
      </section>
    {:else}
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
            Applies to every space you're a member of unless overridden in each
            space's settings.
          </p>

          {#if prefsQuery.isPending}
            <p class="text-sm text-base-400">Loading preferences…</p>
          {:else if prefsQuery.isError}
            <ErrorMessage message="Error: {prefsQuery.error.message}" class="py-4" />
          {:else if prefsQuery.data}
            <UpdateRhythmChooser
              value={defaultLevel}
              horizontal={true}
              name="defaultLevel"
              onchange={(v) => onChangeDefault(v)}
            />
          {/if}
        </section>
      {/if}
    {/if}
  </div>
</ScrollArea>
