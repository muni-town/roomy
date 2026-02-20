<script lang="ts">
  import { page } from "$app/state";
  import { Button } from "@fuxui/base";
  import {
    calendarLinkQuery,
    calendarEventsQuery,
  } from "$lib/queries/calendar.svelte";
  import { current } from "$lib/queries";
  import { peer } from "$lib/workers";
  import { sql } from "$lib/utils/sqlTemplate";
  import {
    fetchGroupEvents,
    isAuthenticated,
    buildAuthorizeUrl,
    setReturnUrl,
    getStoredProfile,
    clearTokens,
  } from "$lib/services/openmeet";

  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import SidebarMain from "$lib/components/sidebars/SpaceSidebar.svelte";
  import { Calendar, DayGrid, TimeGrid, List, Interaction } from "@event-calendar/core";

  let spaceId = $derived(current.joinedSpace?.id);
  let linkQuery = $derived(spaceId ? calendarLinkQuery(spaceId) : undefined);
  let link = $derived(
    linkQuery?.current.status === "success"
      ? linkQuery.current.data[0]
      : undefined,
  );
  let eventsQuery = $derived(spaceId ? calendarEventsQuery(spaceId) : undefined);
  let events = $derived(
    eventsQuery?.current.status === "success" ? eventsQuery.current.data : [],
  );

  // Map SQLite events to @event-calendar format
  let calendarEvents = $derived(
    events.map((e) => ({
      id: e.slug,
      title: e.name,
      start: new Date(e.startDate),
      end: new Date(e.endDate || e.startDate),
      extendedProps: {
        slug: e.slug,
        location: e.location,
        locationOnline: e.locationOnline,
        status: e.status,
      },
    })),
  );

  let selectedDate = $state(new Date());

  let calRef: { getOption: (key: string) => unknown; setOption: (key: string, value: unknown) => void } | undefined = $state();

  let calendarOptions = $derived({
    view: "dayGridMonth",
    date: selectedDate,
    height: "100%",
    editable: false,
    eventStartEditable: false,
    eventDurationEditable: false,
    selectable: true,
    events: calendarEvents,
    headerToolbar: {
      start: "prev,next today",
      center: "title",
      end: "dayGridMonth,timeGridDay,listMonth",
    },
    dateClick: (info: { date: Date; view: { type: string } }) => {
      selectedDate = info.date;
      if (info.view.type === "dayGridMonth") {
        calRef?.setOption("view", "timeGridDay");
      }
    },
    eventClick: (info: { event: { extendedProps: { slug: string } } }) => {
      if (!link) return;
      const platformUrl = link.apiUrl.replace("//api", "//platform");
      window.open(`${platformUrl}/events/${info.event.extendedProps.slug}`, "_blank");
    },
  });

  let connected = $state(isAuthenticated());
  let profile = $state(getStoredProfile());

  type SyncState = "idle" | "syncing" | "done" | "error";
  let syncState = $state<SyncState>("idle");
  let errorMessage = $state("");

  $effect(() => {
    if (link && spaceId) {
      syncEvents();
    }
  });

  async function syncEvents() {
    if (!link || !spaceId) return;
    syncState = "syncing";
    try {
      const apiEvents = await fetchGroupEvents(link);

      for (const e of apiEvents) {
        await peer.runQuery(sql`
          insert or replace into comp_calendar_event
            (entity, slug, name, start_date, end_date, location, location_online, status, synced_at)
          values (
            ${spaceId + ":" + (e.slug as string)},
            ${e.slug as string},
            ${e.name as string},
            ${e.startDate as string},
            ${(e.endDate as string) ?? null},
            ${(e.location as string) ?? null},
            ${(e.locationOnline as string) ?? null},
            ${(e.status as string) ?? "Published"},
            ${Date.now()}
          )
        `);
      }

      syncState = "done";
    } catch (e) {
      syncState = "error";
      errorMessage = (e as Error).message;
    }
  }

  let connecting = $state(false);

  async function connectToOpenMeet() {
    if (!link || !current.did) return;
    connecting = true;
    try {
      const userProfile = await peer.getProfile(current.did);
      const handle = userProfile?.handle || current.did;
      setReturnUrl(window.location.pathname);
      const authorizeApiUrl = buildAuthorizeUrl(link, handle);
      const res = await fetch(authorizeApiUrl);
      if (!res.ok) throw new Error(`OpenMeet returned ${res.status}`);
      const oauthUrl = await res.text();
      window.location.href = oauthUrl;
    } catch (e) {
      connecting = false;
      errorMessage = (e as Error).message;
      syncState = "error";
    }
  }

  function disconnect() {
    clearTokens();
    connected = false;
    profile = null;
  }


</script>

{#snippet sidebar()}
  <SidebarMain />
{/snippet}

{#snippet navbar()}
  <div class="relative w-full">
    <div class="flex flex-col items-center justify-between w-full px-2">
      <h2
        class="w-full py-4 text-base-900 dark:text-base-100 flex items-center gap-2"
      >
        <div class="ml-2 font-bold grow text-center text-lg">
          Events
        </div>
      </h2>
    </div>
  </div>
{/snippet}

<MainLayout {sidebar} {navbar}>
  <div class="p-4 h-full flex flex-col">
    {#if !link}
      <div class="text-center py-12">
        <h2
          class="text-lg font-semibold text-base-900 dark:text-base-100 mb-2"
        >
          No calendar connected
        </h2>
        <p class="text-sm text-base-600 dark:text-base-400 mb-4">
          A space admin can connect an OpenMeet group in settings.
        </p>
        {#if current.isSpaceAdmin}
          <Button href={`/${page.params.space}/settings/calendar`}>
            Configure Calendar
          </Button>
        {/if}
      </div>
    {:else}
      <!-- Auth banner -->
      {#if !connected}
        <div
          class="mb-4 p-3 rounded-lg border border-accent-200 dark:border-accent-800 bg-accent-50 dark:bg-accent-950 flex items-center justify-between gap-3"
        >
          <p class="text-sm text-base-700 dark:text-base-300">
            Connect to OpenMeet to see private events and RSVP
          </p>
          <Button variant="ghost" onclick={connectToOpenMeet} disabled={connecting}>
            {connecting ? "Connecting..." : "Connect"}
          </Button>
        </div>
      {:else if profile}
        <div
          class="mb-4 p-2 rounded-lg flex items-center justify-between gap-3"
        >
          <div class="flex items-center gap-2 text-sm text-base-500 dark:text-base-400">
            {#if profile.avatar}
              <img
                src={profile.avatar}
                alt=""
                class="w-5 h-5 rounded-full"
              />
            {/if}
            <span>Connected as {profile.displayName || profile.handle}</span>
          </div>
          <button
            class="text-xs text-base-400 hover:text-base-600 dark:hover:text-base-300 transition-colors"
            onclick={disconnect}
          >
            Disconnect
          </button>
        </div>
      {/if}

      {#if syncState === "idle" || syncState === "syncing"}
        <div class="py-12 text-center">
          <p class="text-sm text-base-600 dark:text-base-400">
            Loading events...
          </p>
        </div>
      {:else if syncState === "done"}
        <div class="ec-wrapper flex-1 min-h-0 h-full">
          <Calendar bind:this={calRef} plugins={[DayGrid, TimeGrid, List, Interaction]} options={calendarOptions} />
        </div>
      {:else if syncState === "error"}
        <div class="text-center py-12">
          <p class="text-sm text-red-500 mb-4">{errorMessage}</p>
          <Button onclick={syncEvents}>Retry</Button>
        </div>
      {/if}
    {/if}
  </div>
</MainLayout>

<style>
  .ec-wrapper {
    height: 100%;
  }

  /* Override @event-calendar styles to match Roomy's dark/light theme */
  .ec-wrapper :global(.ec) {
    --ec-bg-color: transparent;
    --ec-border-color: var(--color-base-200);
    --ec-text-color: var(--color-base-900);
    --ec-event-bg-color: var(--color-accent-500);
    --ec-event-text-color: white;
    --ec-today-bg-color: var(--color-accent-50);
    --ec-button-bg-color: transparent;
    --ec-button-border-color: var(--color-base-300);
    --ec-button-text-color: var(--color-base-700);
    --ec-button-active-bg-color: var(--color-accent-100);
    --ec-button-active-border-color: var(--color-accent-300);
    --ec-button-active-text-color: var(--color-accent-700);
  }

  :global(.dark) .ec-wrapper :global(.ec) {
    --ec-border-color: var(--color-base-800);
    --ec-text-color: var(--color-base-100);
    --ec-today-bg-color: var(--color-accent-950);
    --ec-button-border-color: var(--color-base-700);
    --ec-button-text-color: var(--color-base-300);
    --ec-button-active-bg-color: var(--color-accent-900);
    --ec-button-active-border-color: var(--color-accent-700);
    --ec-button-active-text-color: var(--color-accent-300);
  }
</style>
