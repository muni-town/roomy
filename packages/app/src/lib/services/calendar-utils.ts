export type CalEvent = {
  id: string;
  title: string;
  start: Date;
  end: Date;
  className?: string;
  extendedProps: Record<string, unknown>;
};

export type FetchedRange = {
  start: number;
  end: number;
  fetchedAt: number;
};

export function statusClass(status: string | undefined): string {
  if (!status) return "ec-status-scheduled";
  const normalized = status.includes("#") ? status.split("#").pop()! : status;
  return `ec-status-${normalized.toLowerCase()}`;
}

export function mapToCalEvent(e: Record<string, unknown>): CalEvent {
  const status = (e.status as string) ?? "Published";
  const cancelled = status.toLowerCase() === "cancelled";
  const name = e.name as string;
  return {
    id: e.slug as string,
    title: cancelled ? `(Cancelled) ${name}` : name,
    start: new Date((e.startDate ?? e.start_date) as string),
    end: new Date(
      ((e.endDate ?? e.end_date) as string) ||
        ((e.startDate ?? e.start_date) as string),
    ),
    className: statusClass(status),
    extendedProps: {
      slug: e.slug,
      location: e.location ?? null,
      locationOnline: e.locationOnline ?? e.location_online,
      status,
    },
  };
}

export function isRangeFresh(
  ranges: FetchedRange[],
  startMs: number,
  endMs: number,
  staleTtl: number,
): boolean {
  const now = Date.now();
  return ranges.some(
    (r) => r.start <= startMs && r.end >= endMs && now - r.fetchedAt < staleTtl,
  );
}

export function pruneExpiredRanges(
  ranges: FetchedRange[],
  staleTtl: number,
): FetchedRange[] {
  const now = Date.now();
  return ranges.filter((r) => now - r.fetchedAt < staleTtl);
}
