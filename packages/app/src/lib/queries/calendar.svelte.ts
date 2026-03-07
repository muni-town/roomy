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
