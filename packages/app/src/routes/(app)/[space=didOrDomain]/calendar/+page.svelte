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
  import { fetchGroupEvents } from "$lib/services/openmeet";

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

  function formatDate(iso: string): string {
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      return iso;
    }
  }
</script>

<div class="p-4 max-w-3xl mx-auto">
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
  {:else if syncState === "idle" || syncState === "syncing"}
    <div class="py-12 text-center">
      <p class="text-sm text-base-600 dark:text-base-400">
        Loading events...
      </p>
    </div>
  {:else if syncState === "done"}
    <h2
      class="text-lg font-semibold text-base-900 dark:text-base-100 mb-4"
    >
      Events
    </h2>

    {#if events.length === 0}
      <p class="text-sm text-base-600 dark:text-base-400">
        No events scheduled yet.
      </p>
    {:else}
      <div class="space-y-2">
        {#each events as event (event.entity)}
          <a
            href={`${link.apiUrl.replace("api.", "platform.").replace("/api", "")}/events/${event.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            class="block p-3 rounded-lg border border-base-200 dark:border-base-800 hover:bg-base-50 dark:hover:bg-base-900 transition-colors"
          >
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <h3
                  class="font-medium text-base-900 dark:text-base-100 truncate"
                >
                  {event.name}
                </h3>
                <p
                  class="text-sm text-base-600 dark:text-base-400 mt-0.5"
                >
                  {formatDate(event.startDate)}
                </p>
                {#if event.location}
                  <p
                    class="text-xs text-base-500 dark:text-base-500 mt-0.5"
                  >
                    {event.location}
                  </p>
                {/if}
              </div>
              {#if event.status === "Cancelled"}
                <span class="text-xs text-red-500 font-medium shrink-0"
                  >Cancelled</span
                >
              {/if}
            </div>
          </a>
        {/each}
      </div>
    {/if}
  {:else if syncState === "error"}
    <div class="text-center py-12">
      <p class="text-sm text-red-500 mb-4">{errorMessage}</p>
      <Button onclick={syncEvents}>Retry</Button>
    </div>
  {/if}
</div>
