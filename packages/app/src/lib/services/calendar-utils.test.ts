import { describe, test, expect } from "vitest";
import {
  statusClass,
  mapToCalEvent,
  isRangeFresh,
  pruneExpiredRanges,
  type FetchedRange,
} from "./calendar-utils";

describe("statusClass", () => {
  test("defaults to ec-status-scheduled for undefined", () => {
    expect(statusClass(undefined)).toBe("ec-status-scheduled");
  });

  test("normalizes lexicon token with hash", () => {
    expect(statusClass("community.lexicon.calendar.event#cancelled")).toBe(
      "ec-status-cancelled",
    );
  });

  test("lowercases plain status", () => {
    expect(statusClass("Published")).toBe("ec-status-published");
  });
});

describe("mapToCalEvent", () => {
  test("maps API response (camelCase fields)", () => {
    const event = mapToCalEvent({
      slug: "my-event",
      name: "My Event",
      startDate: "2026-03-15T10:00:00.000Z",
      endDate: "2026-03-15T11:00:00.000Z",
      location: "Room A",
      locationOnline: "https://meet.example.com",
      status: "Published",
    });

    expect(event.id).toBe("my-event");
    expect(event.title).toBe("My Event");
    expect(event.start).toEqual(new Date("2026-03-15T10:00:00.000Z"));
    expect(event.end).toEqual(new Date("2026-03-15T11:00:00.000Z"));
    expect(event.className).toBe("ec-status-published");
    expect(event.extendedProps.location).toBe("Room A");
    expect(event.extendedProps.locationOnline).toBe("https://meet.example.com");
  });

  test("maps SQLite row (snake_case fields)", () => {
    const event = mapToCalEvent({
      slug: "db-event",
      name: "DB Event",
      start_date: "2026-03-15T10:00:00.000Z",
      end_date: "2026-03-15T11:00:00.000Z",
      location: null,
      location_online: "https://zoom.us/123",
      status: "Published",
    });

    expect(event.id).toBe("db-event");
    expect(event.start).toEqual(new Date("2026-03-15T10:00:00.000Z"));
    expect(event.extendedProps.location).toBeNull();
    expect(event.extendedProps.locationOnline).toBe("https://zoom.us/123");
  });

  test("prefixes cancelled events with (Cancelled)", () => {
    const event = mapToCalEvent({
      slug: "cancelled-event",
      name: "Old Meetup",
      startDate: "2026-03-15T10:00:00.000Z",
      status: "Cancelled",
    });

    expect(event.title).toBe("(Cancelled) Old Meetup");
    expect(event.className).toBe("ec-status-cancelled");
  });

  test("uses startDate as endDate fallback", () => {
    const event = mapToCalEvent({
      slug: "no-end",
      name: "Quick Event",
      startDate: "2026-03-15T10:00:00.000Z",
    });

    expect(event.end).toEqual(event.start);
  });

  test("defaults status to Published when missing", () => {
    const event = mapToCalEvent({
      slug: "no-status",
      name: "Event",
      startDate: "2026-03-15T10:00:00.000Z",
    });

    expect(event.extendedProps.status).toBe("Published");
    expect(event.className).toBe("ec-status-published");
  });
});

describe("isRangeFresh", () => {
  const STALE_TTL = 5 * 60 * 1000;

  test("returns true when range is covered and within TTL", () => {
    const ranges: FetchedRange[] = [
      { start: 100, end: 200, fetchedAt: Date.now() },
    ];
    expect(isRangeFresh(ranges, 100, 200, STALE_TTL)).toBe(true);
  });

  test("returns true when range is a subset of a fetched range", () => {
    const ranges: FetchedRange[] = [
      { start: 0, end: 300, fetchedAt: Date.now() },
    ];
    expect(isRangeFresh(ranges, 100, 200, STALE_TTL)).toBe(true);
  });

  test("returns false when range is stale", () => {
    const ranges: FetchedRange[] = [
      { start: 100, end: 200, fetchedAt: Date.now() - STALE_TTL - 1 },
    ];
    expect(isRangeFresh(ranges, 100, 200, STALE_TTL)).toBe(false);
  });

  test("returns false when range is not fully covered", () => {
    const ranges: FetchedRange[] = [
      { start: 100, end: 150, fetchedAt: Date.now() },
    ];
    expect(isRangeFresh(ranges, 100, 200, STALE_TTL)).toBe(false);
  });

  test("returns false when no ranges exist", () => {
    expect(isRangeFresh([], 100, 200, STALE_TTL)).toBe(false);
  });
});

describe("pruneExpiredRanges", () => {
  const STALE_TTL = 5 * 60 * 1000;

  test("removes expired ranges", () => {
    const ranges: FetchedRange[] = [
      { start: 0, end: 100, fetchedAt: Date.now() - STALE_TTL - 1 },
      { start: 100, end: 200, fetchedAt: Date.now() },
    ];
    const result = pruneExpiredRanges(ranges, STALE_TTL);
    expect(result).toHaveLength(1);
    expect(result[0]!.start).toBe(100);
  });

  test("keeps all fresh ranges", () => {
    const ranges: FetchedRange[] = [
      { start: 0, end: 100, fetchedAt: Date.now() },
      { start: 100, end: 200, fetchedAt: Date.now() },
    ];
    expect(pruneExpiredRanges(ranges, STALE_TTL)).toHaveLength(2);
  });

  test("returns empty array when all expired", () => {
    const ranges: FetchedRange[] = [
      { start: 0, end: 100, fetchedAt: Date.now() - STALE_TTL - 1 },
    ];
    expect(pruneExpiredRanges(ranges, STALE_TTL)).toHaveLength(0);
  });
});
