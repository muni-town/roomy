<script lang="ts">
  import { page } from "$app/state";
  import Button from "$lib/components/ui/button/Button.svelte";
  import { calendarLinkQuery } from "$lib/queries/calendar.svelte";
  import { getAppState } from "$lib/queries";
  const app = getAppState();
  import { peer } from "$lib/workers";
  import { sql } from "$lib/utils/sqlTemplate";
  import {
    fetchGroupEvents,
    isAuthenticated,
    connectViaServiceAuth,
    openOnOpenMeet,
    getStoredProfile,
    clearTokens,
  } from "$lib/services/openmeet";
  import {
    mapToCalEvent,
    isRangeFresh as checkRangeFresh,
    pruneExpiredRanges as pruneRanges,
    type CalEvent,
    type FetchedRange,
  } from "$lib/services/calendar-utils";

  import LoadingLine from "$lib/components/helper/LoadingLine.svelte";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import SidebarMain from "$lib/components/sidebars/SpaceSidebar.svelte";
  import {
    Calendar,
    DayGrid,
    TimeGrid,
    List,
    Interaction,
  } from "@event-calendar/core";

  let spaceId = $derived(app.joinedSpace?.id);
  let linkQuery = $derived(spaceId ? calendarLinkQuery(spaceId) : undefined);
  let link = $derived(
    linkQuery?.current.status === "success"
      ? linkQuery.current.data[0]
      : undefined,
  );
  let linkResolved = $derived(
    linkQuery ? linkQuery.current.status !== "loading" : !spaceId,
  );
  let noLink = $derived(linkResolved && !link);

  let selectedDate = $state(new Date());

  let calRef:
    | {
        getOption: (key: string) => unknown;
        setOption: (key: string, value: unknown) => void;
      }
    | undefined = $state();

  let connected = $state(isAuthenticated());
  let profile = $state(getStoredProfile());
  let openmeetOptOut = $state(
    localStorage.getItem("openmeet:optOut") === "true",
  );

  type SyncState = "idle" | "syncing" | "done" | "error";
  let syncState = $state<SyncState>("idle");
  let errorMessage = $state("");

  // --- Data layer: SQLite (durable cache) + in-memory (session freshness) ---

  let eventsMap = new Map<string, CalEvent>();
  let calendarEvents = $state<CalEvent[]>([]);

  // Track fetched ranges with timestamps for cache-first refresh (5 min TTL)
  const STALE_TTL = 5 * 60 * 1000;
  let fetchedRanges: FetchedRange[] = [];

  // Generation counter to discard stale API responses on rapid navigation
  let fetchGeneration = 0;

  function flushEvents() {
    calendarEvents = [...eventsMap.values()];
  }

  // Read cached events from SQLite for instant paint
  async function loadFromSQLite(
    startStr: string,
    endStr: string,
  ): Promise<void> {
    if (!spaceId) return;
    try {
      const rows = (await peer.runQuery(sql`
        select slug, name, start_date, end_date, location, location_online, status
        from comp_calendar_event
        where entity like ${spaceId + ":%"}
          and start_date >= ${startStr}
          and start_date < ${endStr}
        order by start_date asc
      `)) as unknown as Record<string, unknown>[];

      if (rows.length > 0) {
        for (const row of rows) {
          eventsMap.set(row.slug as string, mapToCalEvent(row));
        }
        flushEvents();
      }
    } catch {
      // SQLite read failed — not critical, API fetch will follow
    }
  }

  // Replace SQLite events for a date range with fresh API data.
  // Clears the range first so deleted events don't persist as ghosts.
  async function writeToSQLite(
    apiEvents: Record<string, unknown>[],
    startStr: string,
    endStr: string,
  ): Promise<void> {
    if (!spaceId) return;

    await peer.runQuery(sql`BEGIN`);
    try {
      // Remove old events in this range
      await peer.runQuery(sql`
        delete from comp_calendar_event
        where entity like ${spaceId + ":%"}
          and start_date >= ${startStr}
          and start_date < ${endStr}
      `);

      // Insert fresh data
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
      await peer.runQuery(sql`COMMIT`);
    } catch (e) {
      await peer.runQuery(sql`ROLLBACK`).catch(() => {});
      throw e;
    }
  }

  // Stale-while-revalidate: read SQLite first (instant), then fetch API if stale
  async function loadEventsForRange(
    startStr: string,
    endStr: string,
  ): Promise<void> {
    if (!link || !spaceId) return;
    const startDate = new Date(startStr);
    const endDate = new Date(endStr);
    const startMs = startDate.getTime();
    const endMs = endDate.getTime();

    // 1. Instant paint from SQLite (even if stale)
    await loadFromSQLite(startStr, endStr);

    // 2. Skip API if range is fresh
    if (checkRangeFresh(fetchedRanges, startMs, endMs, STALE_TTL)) return;

    // 3. Fetch from API in background
    const gen = ++fetchGeneration;
    syncState = "syncing";
    try {
      const apiEvents = await fetchGroupEvents(link, startStr, endStr);

      // Discard stale response if user navigated away during fetch
      if (gen !== fetchGeneration) {
        syncState = "idle";
        return;
      }

      syncState = "done";

      // Replace in-memory events for this range with fresh API data
      const freshSlugs = new Set(apiEvents.map((e) => e.slug as string));
      for (const [slug, evt] of eventsMap) {
        if (
          evt.start >= startDate &&
          evt.start < endDate &&
          !freshSlugs.has(slug)
        ) {
          eventsMap.delete(slug);
        }
      }
      for (const e of apiEvents) {
        eventsMap.set(e.slug as string, mapToCalEvent(e));
      }
      fetchedRanges = pruneRanges(fetchedRanges, STALE_TTL);
      fetchedRanges.push({ start: startMs, end: endMs, fetchedAt: Date.now() });
      flushEvents();

      // Persist to SQLite (fire and forget, log errors)
      writeToSQLite(apiEvents, startStr, endStr).catch((e) => {
        console.warn("Calendar SQLite cache write failed:", e);
      });
    } catch (e) {
      if (gen !== fetchGeneration) {
        syncState = "idle";
        return;
      }
      syncState = "error";
      errorMessage = (e as Error).message;
    }
  }

  // Invalidate all caches and reload via the calendar's current range
  let lastLinkSlug: string | undefined;
  let lastDatesSetRange: { start: string; end: string } | undefined;

  function invalidateAndRefetch() {
    fetchedRanges = [];
    eventsMap = new Map();
    flushEvents();
    if (link && spaceId && lastDatesSetRange) {
      loadEventsForRange(lastDatesSetRange.start, lastDatesSetRange.end);
    }
  }

  // When link resolves (or changes), invalidate and reload.
  // Subsequent view changes are handled solely by datesSet.
  $effect(() => {
    const slug = link?.groupSlug;
    if (slug && slug !== lastLinkSlug) {
      lastLinkSlug = slug;
      invalidateAndRefetch();
    }
  });

  // Auto-connect when link is available and user is not yet connected
  $effect(() => {
    if (link && spaceId && !connected && app.did && !openmeetOptOut) {
      connectToOpenMeet();
    }
  });

  let calendarOptions = $derived({
    view: "dayGridMonth",
    date: selectedDate,
    height: "100%",
    editable: false,
    eventStartEditable: false,
    eventDurationEditable: false,
    selectable: true,
    events: calendarEvents,
    datesSet: (info: { startStr: string; endStr: string }) => {
      lastDatesSetRange = { start: info.startStr, end: info.endStr };
      if (link && spaceId && lastLinkSlug !== undefined) {
        loadEventsForRange(info.startStr, info.endStr);
      }
    },
    headerToolbar: {
      start: "prev,next today",
      center: "title",
      end: "dayGridMonth,timeGridDay,listMonth",
    },
    dateClick: (info: { date: Date; view: { type: string } }) => {
      if (info.view.type === "dayGridMonth") {
        selectedDate = info.date;
        calRef?.setOption("view", "timeGridDay");
      }
    },
    eventClick: (info: { event: { extendedProps: { slug: string } } }) => {
      if (!link) return;
      openOnOpenMeet(
        link,
        `/events/${info.event.extendedProps.slug}`,
        connected,
      );
    },
  });

  async function connectToOpenMeet() {
    if (!link) return;
    try {
      await connectViaServiceAuth(link, peer);
      connected = true;
      openmeetOptOut = false;
      localStorage.removeItem("openmeet:optOut");
      profile = getStoredProfile();

      // Fall back to Bluesky avatar if OpenMeet profile has none
      if (profile && !profile.avatar && app.did) {
        const bskyProfile = await peer.getProfile(app.did);
        if (bskyProfile?.avatar) {
          profile = { ...profile, avatar: bskyProfile.avatar };
          localStorage.setItem("openmeet:profile", JSON.stringify(profile));
        }
      }

      // Re-fetch events now that we're authenticated (may see private events)
      invalidateAndRefetch();
    } catch (e) {
      errorMessage = (e as Error).message;
      syncState = "error";
    }
  }

  function disconnect() {
    clearTokens();
    connected = false;
    profile = null;
    openmeetOptOut = true;
    localStorage.setItem("openmeet:optOut", "true");
    // Re-fetch to remove private events from view
    invalidateAndRefetch();
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
        <div class="ml-2 font-bold grow text-center text-lg">Events</div>
      </h2>
    </div>
  </div>
{/snippet}

<MainLayout {sidebar} {navbar}>
  <div class="p-4 h-full flex flex-col">
    {#if noLink}
      <div class="text-center py-12">
        <h2 class="text-lg font-semibold text-base-900 dark:text-base-100 mb-2">
          No calendar connected
        </h2>
        <p class="text-sm text-base-600 dark:text-base-400 mb-4">
          A space admin can connect an OpenMeet group in settings.
        </p>
        {#if app.isSpaceAdmin}
          <Button href={`/${page.params.space}/settings/calendar`}>
            Configure Calendar
          </Button>
        {/if}
      </div>
    {:else}
      {#if syncState === "error"}
        <div
          class="flex items-center gap-2 p-2 mb-2 rounded-lg bg-red-50 dark:bg-red-950 text-red-600 dark:text-red-400 text-sm"
        >
          <span class="flex-1">{errorMessage}</span>
          <Button onclick={invalidateAndRefetch}>Retry</Button>
        </div>
      {/if}
      <div class="ec-wrapper flex-1 min-h-0 h-full relative">
        {#if syncState === "syncing"}
          <div class="absolute top-0 left-0 right-0 z-10">
            <LoadingLine />
          </div>
        {/if}
        <Calendar
          bind:this={calRef}
          plugins={[DayGrid, TimeGrid, List, Interaction]}
          options={calendarOptions}
        />
      </div>

      <!-- Footer: OpenMeet link + auth status -->
      {#if link}
        <div
          class="mt-2 p-2 rounded-lg flex items-center justify-between text-sm text-base-400 dark:text-base-500"
        >
          <button
            class="ec-footer-link"
            onclick={() =>
              link &&
              openOnOpenMeet(link, `/groups/${link.groupSlug}`, connected)}
          >
            Manage events on OpenMeet ↗
          </button>

          {#if !connected}
            <span>
              <button class="ec-footer-link" onclick={connectToOpenMeet}
                >Connect</button
              > to see private events
            </span>
          {:else if profile}
            <span class="flex items-center gap-1">
              {#if profile.avatar}
                <img src={profile.avatar} alt="" class="w-5 h-5 rounded-full" />
              {/if}
              {profile.displayName || profile.handle} ·
              <button class="ec-footer-link" onclick={disconnect}
                >Disconnect</button
              >
            </span>
          {/if}
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

  /* Pointer cursor on events (clickable in all views) */
  .ec-wrapper :global(.ec-event) {
    cursor: pointer;
  }

  /* Pointer cursor on day cells only in month view (drill into day) */
  .ec-wrapper :global(.ec-day-grid .ec-day) {
    cursor: pointer;
  }

  /* Show event title next to time in day view (default is column, which hides title on short events) */
  .ec-wrapper :global(.ec-time-grid .ec-event-body) {
    flex-direction: row;
  }

  .ec-wrapper :global(.ec-time-grid .ec-event-time) {
    margin: 0 3px 0 0;
  }

  /* Footer action links — visible as interactive elements */
  .ec-footer-link {
    color: var(--color-accent-600);
    text-decoration: underline;
    cursor: pointer;
    transition: color 0.15s;
  }
  .ec-footer-link:hover {
    color: var(--color-accent-800);
  }
  :global(.dark) .ec-footer-link {
    color: var(--color-accent-400);
  }
  :global(.dark) .ec-footer-link:hover {
    color: var(--color-accent-200);
  }

  /* Event status styles — class names from community.lexicon.calendar.event */
  .ec-wrapper :global(.ec-status-scheduled),
  .ec-wrapper :global(.ec-status-published) {
    background-color: var(--color-accent-500) !important;
    color: white !important;
  }
  .ec-wrapper :global(.ec-status-cancelled) {
    opacity: 0.6;
    text-decoration: line-through;
    background-color: var(--color-base-400) !important;
  }
  .ec-wrapper :global(.ec-status-postponed) {
    opacity: 0.7;
    border-left: 3px solid var(--color-warning-500, #f59e0b) !important;
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
