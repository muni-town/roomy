<script lang="ts">
  import ErrorMessage from "@roomy/design/components/helper/ErrorMessage.svelte";
  import Switch from "@roomy/design/components/ui/toggle/Toggle.svelte";
  import { IconChevronRight } from "@roomy/design/icons";
  import { toast } from "@foxui/core";
  import { auth, requestScopeExpansion, revokeCapability } from "$lib/auth.svelte";
  import { createScopeSettingsQuery } from "$lib/queries/scope-settings";
  import { createFeatureFlagsQuery } from "$lib/queries/feature-flags";
  import { hasScopeSet, type RequestableScopeSetName } from "$lib/scopes";
  import { queryClient } from "$lib/client";

  // The Access settings page is gated behind the access-settings flag while
  // progressive scope expansion is being iterated on. Direct navigation still
  // lands here (the sidebar entry is hidden), so gate the body too. All flags
  // default false.
  const flagsQuery = createFeatureFlagsQuery();
  const accessSettingsEnabled = $derived(
    flagsQuery.data?.flags.includes("access-settings") ?? false,
  );

  const settingsQuery = createScopeSettingsQuery(() => accessSettingsEnabled);
  const queryKey = ["space.roomy.auth.getScopeSettings"];

  /**
   * The optional capabilities, in the order they are shown.
   *
   * The `base` tier is deliberately absent: every session carries it and the
   * app cannot work without it, so it is not a choice this page offers. Each
   * row here adds its own scopes on top of `base`; the switches are
   * independent, and what is saved is the union of every one that is on.
   */
  const CAPABILITIES: readonly {
    tier: RequestableScopeSetName;
    name: string;
    description: string;
  }[] = [
    {
      tier: "semble",
      name: "Semble collections",
      description:
        "Save links from messages into a Semble collection in your own account.",
    },
    {
      tier: "withDms",
      name: "Bluesky direct messages",
      description:
        "Read and send Bluesky chats as you. No Roomy feature uses this yet.",
    },
  ];

  /**
   * What the server holds as the saved grant — the scope the next sign-in will
   * ask for. The switches mirror this rather than the live token: removing a
   * capability narrows what is saved and leaves the running session untouched
   * (see `revokeCapability`), so a switch wired to the live token would
   * spring back on the moment it was turned off.
   */
  const savedScope = $derived(settingsQuery.data?.scope ?? null);

  function saved(tier: RequestableScopeSetName): boolean {
    return savedScope !== null && hasScopeSet(savedScope, tier);
  }

  /** Requested at the provider, but not confirmed yet, so not saved. */
  function awaitingConfirmation(tier: RequestableScopeSetName): boolean {
    const requested = settingsQuery.data?.requestedScope;
    return !!requested && hasScopeSet(requested, tier) && !saved(tier);
  }

  let busy = $state<RequestableScopeSetName | null>(null);
  /**
   * Bumped whenever an attempt settles. The switches are controlled by `saved`,
   * so a settled attempt that did not change it (a refused or failed provider
   * round-trip) leaves the switch's own state flipped; re-keying on this puts
   * every switch back in step with the saved grant.
   */
  let attempt = $state(0);

  async function refresh(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey });
  }

  /**
   * Ask for a capability, or stop asking for one.
   *
   * Enabling is not a local toggle: it records the request and drives a sign-in
   * with the provider, so the browser leaves this page and comes back. Removing
   * only narrows the saved grant; the session in hand keeps its access until the
   * next sign-in, and the copy beside the switches says so.
   */
  async function toggle(tier: RequestableScopeSetName, enabled: boolean): Promise<void> {
    busy = tier;
    try {
      if (enabled) {
        await requestScopeExpansion(tier);
        return; // browser navigates to the provider's consent screen
      }
      await revokeCapability(tier);
      await refresh();
      toast.success(
        "Saved. This takes effect the next time you sign in — the session " +
          "you're using now keeps its access until then.",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      busy = null;
      attempt += 1;
    }
  }
</script>

{#if accessSettingsEnabled}
<div class="flex flex-col gap-8">
  <section>
    <h2 class="text-base font-semibold mb-1 text-base-900 dark:text-base-100">
      What Roomy can do
    </h2>
    <p class="text-sm text-base-600 dark:text-base-400 max-w-prose">
      Your account is yours. Roomy asks for the access it needs to work, and
      you decide what else it may do.
    </p>
  </section>

  {#if settingsQuery.isPending}
    <div
      class="rounded-2xl ring-1 ring-base-200 dark:ring-base-800 divide-y divide-base-200 dark:divide-base-800"
      aria-hidden="true"
    >
      {#each [0, 1, 2] as row (row)}
        <div class="flex items-start justify-between gap-6 px-4 py-4 sm:px-5">
          <div class="flex grow flex-col gap-2">
            <div
              class="h-4 w-40 rounded-full bg-base-200 dark:bg-base-800 motion-safe:animate-pulse"
            ></div>
            <div
              class="h-3 w-64 max-w-full rounded-full bg-base-100 dark:bg-base-900 motion-safe:animate-pulse"
            ></div>
          </div>
          <div
            class="h-6 w-10.5 shrink-0 rounded-full bg-base-100 dark:bg-base-900 motion-safe:animate-pulse"
          ></div>
        </div>
      {/each}
    </div>
    <span class="sr-only">Loading access settings…</span>
  {:else if settingsQuery.isLoadingError}
    <ErrorMessage message="Error: {settingsQuery.error.message}" class="py-4" />
  {:else if settingsQuery.data}
    <ul
      class="rounded-2xl ring-1 ring-base-200 dark:ring-base-800 divide-y divide-base-200 dark:divide-base-800"
    >
      <!-- The foundation every session carries. Not a choice, so not a switch. -->
      <li class="flex items-start justify-between gap-6 px-4 py-4 sm:px-5">
        <div class="min-w-0">
          <p class="text-sm font-medium text-base-900 dark:text-base-100">
            Using Roomy
          </p>
          <p class="mt-1 text-sm text-base-600 dark:text-base-400 max-w-prose">
            Your spaces, messages and profile — everything the app needs to
            work at all.
          </p>
        </div>
        <p
          class="shrink-0 pt-0.5 text-xs whitespace-nowrap text-base-500 dark:text-base-400"
        >
          Always on
        </p>
      </li>

      {#each CAPABILITIES as { tier, name, description } (tier)}
        {@const isSaved = saved(tier)}
        {@const waiting = awaitingConfirmation(tier)}
        <li class="flex items-start justify-between gap-6 px-4 py-4 sm:px-5">
          <div class="min-w-0">
            <p
              id="access-{tier}-name"
              class="text-sm font-medium text-base-900 dark:text-base-100"
            >
              {name}
            </p>
            <p
              id="access-{tier}-description"
              class="mt-1 text-sm text-base-600 dark:text-base-400 max-w-prose"
            >
              {description}
            </p>
            {#if waiting}
              <p class="mt-2 text-xs text-base-500 dark:text-base-400">
                Waiting for confirmation — this arrives the next time you sign
                in.
              </p>
            {/if}
          </div>
          <div class="shrink-0 pt-0.5">
            {#key `${tier}-${attempt}`}
              <Switch
                checked={isSaved}
                disabled={busy !== null}
                aria-labelledby="access-{tier}-name"
                aria-describedby="access-{tier}-description"
                onCheckedChange={(checked: boolean) => toggle(tier, checked)}
              />
            {/key}
          </div>
        </li>
      {/each}
    </ul>

    <p class="text-xs text-base-500 dark:text-base-400 max-w-prose">
      Turning something on takes you to your provider to confirm it right away.
      Turning it off saves the change now and applies the next time you sign in
      — the session you&rsquo;re using keeps its access until then.
    </p>

    <details class="group text-xs">
      <summary
        class="inline-flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-2xl text-base-500 dark:text-base-400 hover:text-base-700 dark:hover:text-base-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-base-900 dark:focus-visible:outline-base-50 [&::-webkit-details-marker]:hidden"
      >
        <IconChevronRight
          class="size-3.5 motion-safe:transition-transform group-open:rotate-90"
        />
        Technical details
      </summary>
      <dl
        class="mt-3 flex flex-col gap-3 rounded-2xl bg-base-100 p-4 text-base-600 dark:bg-base-900 dark:text-base-400"
      >
        <div>
          <dt>The access this session is using</dt>
          <dd class="mt-1">
            <code
              class="block break-all text-xs leading-relaxed text-base-600 dark:text-base-300">{auth.grantedScope ?? "None recorded."}</code
            >
          </dd>
        </div>
        <div>
          <dt>What your next sign-in will ask for</dt>
          <dd class="mt-1">
            <code
              class="block break-all text-xs leading-relaxed text-base-600 dark:text-base-300">{settingsQuery.data.scope ?? "None recorded."}</code
            >
          </dd>
        </div>
        {#if settingsQuery.data.requestedScope}
          <div>
            <dt>Requested, not yet confirmed</dt>
            <dd class="mt-1">
              <code
                class="block break-all text-xs leading-relaxed text-base-600 dark:text-base-300">{settingsQuery.data.requestedScope}</code
              >
            </dd>
          </div>
        {/if}
      </dl>
    </details>
  {/if}
</div>
{:else}
  <div class="flex flex-col items-center gap-4 py-12">
    <p class="text-sm text-base-500 dark:text-base-400">
      Access settings are not enabled for your account yet.
    </p>
  </div>
{/if}
