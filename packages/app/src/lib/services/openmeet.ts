import type { CalendarLink } from "$lib/queries/calendar.svelte";

export class OpenMeetAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenMeetAuthError";
  }
}

const TOKEN_KEY = "openmeet_token";
const REFRESH_TOKEN_KEY = "openmeet_refresh_token";

export function getOpenMeetToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setOpenMeetToken(token: string, refreshToken: string) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
}

export function clearOpenMeetToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

export function handleOAuthCallback(): boolean {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  const refreshToken = params.get("refreshToken");

  if (token && refreshToken) {
    setOpenMeetToken(token, refreshToken);
    const url = new URL(window.location.href);
    url.searchParams.delete("token");
    url.searchParams.delete("refreshToken");
    url.searchParams.delete("tokenExpires");
    url.searchParams.delete("profile");
    window.history.replaceState({}, "", url.toString());
    return true;
  }
  return false;
}

async function openmeetFetch(
  link: CalendarLink,
  path: string,
  options?: RequestInit,
): Promise<unknown> {
  const token = getOpenMeetToken();
  const headers: Record<string, string> = {
    "x-tenant-id": link.tenantId,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...((options?.headers as Record<string, string>) || {}),
  };

  const res = await fetch(`${link.apiUrl}${path}`, { ...options, headers });

  if (res.status === 401) {
    clearOpenMeetToken();
    throw new OpenMeetAuthError("Session expired");
  }

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
    : ((response as Record<string, unknown>).data as Record<string, unknown>[]) || [];
}

export function initiateOpenMeetAuth(link: CalendarLink) {
  const callbackUrl = window.location.href;
  const params = new URLSearchParams({
    redirect_uri: callbackUrl,
  });
  window.location.href = `${link.apiUrl}/api/auth/bluesky/login?${params.toString()}`;
}
