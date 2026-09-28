<script lang="ts">
  import { onMount } from "svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import UpdateRhythmChooser from "@roomy/design/components/user/UpdateRhythmChooser.svelte";
  import ErrorMessage from "@roomy/design/components/helper/ErrorMessage.svelte";
  import { createPushPreferencesQuery } from "$lib/queries/push-preferences";
  import {
    setDefaultPushLevel,
    type PushLevel,
  } from "$lib/mutations/push-preferences";
  import {
    ensurePushSubscription,
    clearPushSubscription,
    pushOutcomeMessage,
  } from "$lib/push.svelte";
  import { queryClient } from "$lib/client";
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

  type OsType = "linux" | "windows" | "macos" | "ios" | "android";
  const PLATFORM = !("__TAURI__" in window)
    ? "web"
    : ["linux", "windows", "macos"].includes(
          (
            window.__TAURI__ as unknown as { os: { platform: () => OsType } }
          ).os.platform(),
        )
      ? "desktop"
      : "mobile";

  // ── Push capability + permission state (browser-side, not on the server) ──
  let pushSupported = $state(false);
  let permission = $state<NotificationPermission>("default");
  let endpoint = $state<string | null>(null); // registered PushSubscription endpoint
  let enabling = $state(false);
  let disabling = $state(false);
  let enableError = $state<string | null>(null);

  async function refreshStatus(): Promise<void> {
    pushSupported =
      PLATFORM !== "web" ||
      (typeof navigator !== "undefined" &&
        "serviceWorker" in navigator &&
        "PushManager" in window &&
        typeof Notification !== "undefined");

    switch (PLATFORM) {
      case "web":
        {
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
        break;
      case "desktop":
        {
          const { isPermissionGranted } =
            await import("@tauri-apps/plugin-notification");

          let permissionGranted = await isPermissionGranted();
          permission = permissionGranted ? "granted" : "denied";
          endpoint = " ";
        }
        break;
      case "mobile":
        {
          permission = "denied";
        }
        break;
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
  const platformRequestPermission = {
    web: async () => {
      const outcome = await ensurePushSubscription();
      return outcome;
    },
    desktop: async () => {
      const { requestPermission } =
        await import("@tauri-apps/plugin-notification");
      const granted = await requestPermission();
      if (granted === "default") {
        console.log("API CURSED. try something else");
      }
      endpoint = " ";
      return { status: granted === "granted" ? "ok" : "denied" } as const;
    },
    mobile: async () => {
      const { requestPermission, getToken } =
        await import("tauri-plugin-mobile-push-api");
      const { granted } = await requestPermission();

      if (granted)
        getToken().then(async (token) => {
          endpoint = " ";
      // TODO: https://github.com/yanqianglu/tauri-plugin-mobile-push#complete-registration-flow
          /*
        await fetch("https://roomy.space", {
                    method: "POST",
                    body: JSON.stringify({
                      token,
                      platform: (
                        window.__TAURI__ as unknown as {
                          os: { platform: () => OsType };
                        }
                      ).os.platform(),
                    }),
                  });
        */
        });

      return { status: granted ? "ok" : "denied" } as const;
    },
  };

  async function enableNotifications(): Promise<void> {
    enabling = true;
    try {
      const outcome = await platformRequestPermission[PLATFORM]();
      if (outcome.status === "ok") {
        toast.success("Notifications enabled");
        // Suppress the enable-notifications banner on other pages
        localStorage.setItem("roomy.push.bannerDismissed", "1");
      } else {
        const msg = pushOutcomeMessage(outcome);
        enableError = msg;
        toast.error(msg);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      enableError = msg;
      toast.error(`Couldn't enable notifications: ${msg}`);
    } finally {
      enabling = false;
    }
  }

  /** Disable notifications for this device: unregister + unsubscribe. */
  const disableNotifications: Record<typeof PLATFORM, () => Promise<void>> = {
    web: async (): Promise<void> => {
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
    },
    desktop: async () => {
      disabling = true;
      try {
      } finally {
        disabling = false;
      }
    },
    mobile: async () => {},
  };

  async function onChangeDefault(level: PushLevel): Promise<void> {
    defaultLevel = level;
    await setDefaultPushLevel(level);
    await queryClient.invalidateQueries({
      queryKey: ["space.roomy.push.getPreferences"],
    });
  }

  onMount(() => {
    refreshStatus();
  });
</script>

<div class="flex flex-col gap-10">
  <!-- Enable / status section -->
  <section>
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
              onclick={() => disableNotifications[PLATFORM]}
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
        <ErrorMessage
          message="Error: {prefsQuery.error.message}"
          class="py-4"
        />
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
</div>
