<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { IconBell, IconX } from "@roomy/design/icons";
  import { getPushSubscriptionEndpoint } from "$lib/push.svelte";

  const DISMISS_KEY = "roomy.push.bannerDismissed";

  let pushEnabled: boolean | null = $state(null);
  let dismissed = $state(false);

  onMount(() => {
    dismissed = localStorage.getItem(DISMISS_KEY) === "1";
    getPushSubscriptionEndpoint().then((endpoint) => {
      pushEnabled = endpoint !== null;
    });
  });

  let visible = $derived(
    pushEnabled === false &&
      !dismissed &&
      !page.url.pathname.startsWith("/user/settings/notifications"),
  );

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, "1");
    dismissed = true;
  }

  function navigate() {
    goto("/user/settings/notifications");
  }
</script>

{#if visible}
  <div
    class="flex items-center gap-2 pl-4 pr-2 py-0.5 text-xs bg-base-100 dark:bg-base-900 cursor-pointer select-none hover:bg-base-200/50 dark:hover:bg-base-800/40 transition-colors"
    role="banner"
    onclick={navigate}
    onkeydown={(e) => e.key === "Enter" && navigate()}
    tabindex="0"
  >
    <IconBell class="size-4 shrink-0 text-base-500" />
    <span class="text-base-700 dark:text-base-300">Get notified when someone messages you.</span>
    <span class="font-semibold text-accent-600 dark:text-accent-400">Enable notifications</span>
    <button
      type="button"
      class="p-1 -mr-1 ml-auto text-base-400 hover:text-base-600 dark:hover:text-base-300 transition-colors"
      aria-label="Dismiss"
      onclick={(e) => {
        e.stopPropagation();
        dismiss();
      }}
    >
      <IconX class="size-4" />
    </button>
  </div>
{/if}