import { LiveQuery } from "$lib/utils/liveQuery.svelte";
import { sql } from "$lib/utils/sqlTemplate";

export interface CalendarLink {
  [key: string]: unknown;
  groupSlug: string;
  tenantId: string;
  apiUrl: string;
}

export function calendarLinkQuery(streamId: string | undefined) {
  return new LiveQuery<CalendarLink>(
    () => sql`
      select
        group_slug as groupSlug,
        tenant_id as tenantId,
        api_url as apiUrl
      from comp_calendar_link
      where entity = ${streamId}
    `,
  );
}

export interface CalendarEvent {
  [key: string]: unknown;
  entity: string;
  slug: string;
  name: string;
  startDate: string;
  endDate: string | null;
  location: string | null;
  locationOnline: string | null;
  status: string;
  syncedAt: number;
}

export function calendarEventsQuery(streamId: string | undefined) {
  return new LiveQuery<CalendarEvent>(
    () => sql`
      select
        entity,
        slug,
        name,
        start_date as startDate,
        end_date as endDate,
        location,
        location_online as locationOnline,
        status,
        synced_at as syncedAt
      from comp_calendar_event
      where entity like ${streamId + ":%"}
      order by start_date asc
    `,
  );
}
