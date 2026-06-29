import { describe, it, expect, vi } from "vitest";
import {
  formatDate,
  formatDateTime,
  formatDayLabel,
  formatMessageTimestamp,
  formatRelativeTime,
  formatTime,
} from "./date.js";

function withLocale(locale: string, fn: () => void) {
  const original = globalThis.navigator;
  vi.stubGlobal("navigator", { language: locale });
  fn();
  vi.stubGlobal("navigator", original);
}

describe("date utilities", () => {
  it("formats relative time across intervals", () => {
    withLocale("en-US", () => {
      const now = new Date();

      expect(formatRelativeTime(now)).toMatch(/now|just/);
      expect(
        formatRelativeTime(new Date(now.getTime() - 60_000)),
      ).toBe("1 minute ago");
      expect(
        formatRelativeTime(new Date(now.getTime() - 2 * 60 * 60_000)),
      ).toBe("2 hours ago");
      expect(
        formatRelativeTime(new Date(now.getTime() - 3 * 24 * 60 * 60_000)),
      ).toBe("3 days ago");
      expect(
        formatRelativeTime(new Date(now.getTime() - 14 * 24 * 60 * 60_000)),
      ).toBe("2 weeks ago");
      expect(
        formatRelativeTime(new Date(now.getTime() - 60 * 24 * 60 * 60_000)),
      ).toBe("2 months ago");
      expect(
        formatRelativeTime(new Date(now.getTime() - 400 * 24 * 60 * 60_000)),
      ).toBe("last year");
    });
  });

  it("localizes relative time to the browser locale", () => {
    withLocale("de-DE", () => {
      const now = new Date();
      expect(formatRelativeTime(new Date(now.getTime() - 2 * 60 * 60_000))).toBe(
        "vor 2 Stunden",
      );
    });

    withLocale("ja-JP", () => {
      const now = new Date();
      expect(formatRelativeTime(new Date(now.getTime() - 3 * 24 * 60 * 60_000))).toBe(
        "3 日前",
      );
    });
  });

  it("formats absolute dates and times", () => {
    withLocale("en-US", () => {
      const date = new Date(Date.UTC(2024, 0, 15, 15, 45, 0));

      expect(formatDate(date)).toBe("Jan 15, 2024");

      const expectedTime = date.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "numeric",
      });
      expect(formatTime(date)).toBe(expectedTime);

      const expectedDateTime = date.toLocaleString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
      });
      expect(formatDateTime(date)).toBe(expectedDateTime);
    });
  });

  it("produces day-relative labels", () => {
    withLocale("en-US", () => {
      const now = new Date();

      expect(formatDayLabel(now)).toBe("Today");
      expect(
        formatDayLabel(new Date(now.getTime() - 86_400_000)),
      ).toBe("Yesterday");
      expect(
        formatDayLabel(new Date(now.getTime() + 86_400_000)),
      ).toBe("Tomorrow");
    });

    withLocale("de-DE", () => {
      const now = new Date();
      expect(formatDayLabel(now)).toBe("Heute");
      expect(
        formatDayLabel(new Date(now.getTime() - 86_400_000)),
      ).toBe("Gestern");
    });
  });

  it("formats message timestamps without a preposition", () => {
    withLocale("en-US", () => {
      const now = new Date();

      expect(formatMessageTimestamp(now)).toMatch(/^Today /);
      expect(
        formatMessageTimestamp(new Date(now.getTime() - 86_400_000)),
      ).toMatch(/^Yesterday /);

      const older = new Date(Date.UTC(2024, 0, 15, 15, 45, 0));
      expect(formatMessageTimestamp(older)).toMatch(/^Jan 15, 2024 /);
    });
  });

  it("falls back to en-US when navigator is unavailable", () => {
    const original = globalThis.navigator;
    vi.stubGlobal("navigator", undefined);

    const date = new Date(Date.UTC(2024, 0, 15, 12, 0, 0));
    expect(formatDate(date)).toBe("Jan 15, 2024");

    vi.stubGlobal("navigator", original);
  });
});
