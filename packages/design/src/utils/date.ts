/**
 * Localized date formatting utilities.
 *
 * Uses `Intl.DateTimeFormat` and `Intl.RelativeTimeFormat` — built into all
 * modern browsers — so there are zero additional dependencies and the user's
 * browser locale is used automatically.
 *
 * Falls back to `"en-US"` when `navigator` is unavailable (SSR).
 */

function getLocale(): string {
  if (typeof navigator !== "undefined" && navigator.language) {
    return navigator.language;
  }
  return "en-US";
}

/**
 * Format a date as a localized relative time string.
 *
 * Examples: "just now", "2 minutes ago", "3 hours ago", "yesterday",
 * "last week", or a localized date for older dates.
 */
export function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);

  const rtf = new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto" });

  if (diffSec < 5) return rtf.format(0, "second");

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return rtf.format(-diffMin, "minute");

  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return rtf.format(-diffHour, "hour");

  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return rtf.format(-diffDay, "day");

  const diffWeek = Math.floor(diffDay / 7);
  if (diffWeek < 4) return rtf.format(-diffWeek, "week");

  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth < 12) return rtf.format(-diffMonth, "month");

  const diffYear = Math.floor(diffDay / 365);
  return rtf.format(-diffYear, "year");
}

/**
 * Format a date as a localized date string.
 *
 * Examples: "Jan 15, 2024" (en-US), "15. Jan 2024" (de-DE),
 * "2024年1月15日" (ja-JP).
 */
export function formatDate(date: Date): string {
  return date.toLocaleDateString(getLocale(), {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Format a date as a localized time string.
 *
 * Examples: "3:45 PM" (en-US), "15:45" (de-DE), "15:45" (ja-JP).
 */
export function formatTime(date: Date): string {
  return date.toLocaleTimeString(getLocale(), {
    hour: "numeric",
    minute: "numeric",
  });
}

/**
 * Format a date as a localized date + time string.
 *
 * Examples: "Jan 15, 2024, 3:45 PM" (en-US),
 * "15. Jan 2024, 15:45" (de-DE).
 */
export function formatDateTime(date: Date): string {
  return date.toLocaleString(getLocale(), {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  });
}

/**
 * Get a human-readable day label for a date relative to today.
 *
 * Returns a localized "today", "yesterday", "tomorrow", or a localized
 * date string. The first letter is capitalized for use as a UI label.
 */
export function formatDayLabel(date: Date): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );
  const diffDays = Math.round(
    (target.getTime() - today.getTime()) / 86_400_000,
  );

  const rtf = new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto" });
  let label: string;

  if (diffDays === 0) {
    label = rtf.format(0, "day");
  } else if (diffDays === -1) {
    label = rtf.format(-1, "day");
  } else if (diffDays === 1) {
    label = rtf.format(1, "day");
  } else {
    return formatDate(date);
  }

  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Format a timestamp for a message bubble — a day-relative label followed by
 * the localized time, separated by a single space and no preposition.
 *
 * Examples: "Today 3:45 PM", "Yesterday 15:45",
 * "Jan 15, 2024 3:45 PM".
 */
export function formatMessageTimestamp(date: Date): string {
  return `${formatDayLabel(date)} ${formatTime(date)}`;
}
