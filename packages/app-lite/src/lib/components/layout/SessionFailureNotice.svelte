<!--
  The session-failure notice.

  Rendered when `error-recovery.ts` decides a session failure earns one: the
  device clock the server rejects, or a session that is dead where it is held.
  Neither is repaired by the auto-reload path, and before this the user saw only
  a reload and then a sign-out. The notice names the cause in the user's terms
  and offers the one action that helps — reload after fixing the clock, or sign
  in again (`$lib/session-failure.svelte.ts` holds the copy and the state).

  It sits above the app rather than inside a view because the failure hits every
  view at once: with the session dead, no route renders anything worth keeping.
-->
<script lang="ts">
  import { resetReloadBudget } from "$lib/error-recovery";
  import {
    dismissSessionFailureNotice,
    sessionFailure,
  } from "$lib/session-failure.svelte";

  let { onSignIn }: { onSignIn: () => void } = $props();

  let notice = $derived(sessionFailure.notice);

  function reload(): void {
    // The clock was the problem and the user has corrected it; the reloads
    // before this one are not evidence of a loop, so they come back.
    resetReloadBudget();
    location.reload();
  }
</script>

{#if notice}
  <div
    class="fixed inset-x-0 bottom-0 z-50 flex justify-center p-4 pointer-events-none"
  >
    <div
      class="pointer-events-auto w-full max-w-md rounded-2xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/90 px-4 py-3 text-sm text-red-900 dark:text-red-200 shadow-lg flex flex-col gap-2"
      role="alert"
    >
      <div class="font-semibold">{notice.title}</div>
      <p class="leading-snug">{notice.detail}</p>
      <div class="flex items-center gap-2 pt-1">
        {#if notice.action === "sign-in"}
          <button
            type="button"
            class="rounded-lg px-3 py-1.5 text-sm font-medium bg-red-600 text-white hover:bg-red-700 active:bg-red-800 transition-colors"
            onclick={() => {
              dismissSessionFailureNotice();
              onSignIn();
            }}
          >
            Sign in again
          </button>
        {:else}
          <button
            type="button"
            class="rounded-lg px-3 py-1.5 text-sm font-medium bg-red-600 text-white hover:bg-red-700 active:bg-red-800 transition-colors"
            onclick={reload}
          >
            Reload
          </button>
        {/if}
        <button
          type="button"
          class="rounded-lg px-3 py-1.5 text-sm font-medium text-red-800 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors"
          onclick={dismissSessionFailureNotice}
        >
          Dismiss
        </button>
        <span class="ml-auto text-[11px] opacity-70" title="Reported with the cause in telemetry">
          {notice.cause}
        </span>
      </div>
    </div>
  </div>
{/if}
