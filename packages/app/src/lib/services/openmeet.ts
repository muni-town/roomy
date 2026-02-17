import type { CalendarLink } from "$lib/queries/calendar.svelte";

async function openmeetFetch(
  link: CalendarLink,
  path: string,
): Promise<unknown> {
  const res = await fetch(`${link.apiUrl}${path}`, {
    headers: { "x-tenant-id": link.tenantId },
  });

  if (!res.ok) throw new Error(`OpenMeet API error: ${res.status}`);
  return res.json();
}

export async function fetchGroupEvents(
  link: CalendarLink,
): Promise<Record<string, unknown>[]> {
  const response = (await openmeetFetch(
    link,
    `/api/groups/${link.groupSlug}/events`,
  )) as Record<string, unknown> | Record<string, unknown>[];
  return Array.isArray(response)
    ? response
    : ((response as Record<string, unknown>).data as
        Record<string, unknown>[]) || [];
}
