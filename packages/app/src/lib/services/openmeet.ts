import type { CalendarLink } from "$lib/queries/calendar.svelte";

// localStorage keys for OpenMeet auth tokens
const KEYS = {
  accessToken: "openmeet:accessToken",
  refreshToken: "openmeet:refreshToken",
  tokenExpires: "openmeet:tokenExpires",
  profile: "openmeet:profile",
  returnUrl: "openmeet:returnUrl",
} as const;

export interface OpenMeetProfile {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
}

export function getStoredTokens() {
  const accessToken = localStorage.getItem(KEYS.accessToken);
  const refreshToken = localStorage.getItem(KEYS.refreshToken);
  const tokenExpires = localStorage.getItem(KEYS.tokenExpires);
  if (!accessToken || !refreshToken || !tokenExpires) return null;
  return { accessToken, refreshToken, tokenExpires: Number(tokenExpires) };
}

export function getStoredProfile(): OpenMeetProfile | null {
  const raw = localStorage.getItem(KEYS.profile);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function storeTokens(params: {
  token: string;
  refreshToken: string;
  tokenExpires: string;
  profile?: string;
}) {
  localStorage.setItem(KEYS.accessToken, params.token);
  localStorage.setItem(KEYS.refreshToken, params.refreshToken);
  localStorage.setItem(KEYS.tokenExpires, params.tokenExpires);
  if (params.profile) {
    try {
      const decoded = atob(params.profile);
      // Validate it's JSON before storing
      JSON.parse(decoded);
      localStorage.setItem(KEYS.profile, decoded);
    } catch {
      // Ignore invalid profile data
    }
  }
}

export function clearTokens() {
  localStorage.removeItem(KEYS.accessToken);
  localStorage.removeItem(KEYS.refreshToken);
  localStorage.removeItem(KEYS.tokenExpires);
  localStorage.removeItem(KEYS.profile);
}

export function isAuthenticated(): boolean {
  return getStoredTokens() !== null;
}

export function setReturnUrl(url: string) {
  localStorage.setItem(KEYS.returnUrl, url);
}

export function getAndClearReturnUrl(): string | null {
  const url = localStorage.getItem(KEYS.returnUrl);
  localStorage.removeItem(KEYS.returnUrl);
  return url;
}

export function buildAuthorizeUrl(
  link: CalendarLink,
  userDid: string,
): string {
  // Normalize 127.0.0.1 → localhost so it matches ALLOWED_REDIRECT_DOMAINS
  const origin = window.location.origin.replace("://127.0.0.1", "://localhost");
  const params = new URLSearchParams({
    handle: userDid,
    tenantId: link.tenantId,
    redirect_uri: `${origin}/openmeet/callback`,
  });
  return `${link.apiUrl}/api/v1/auth/bluesky/authorize?${params.toString()}`;
}

async function refreshAccessToken(apiUrl: string, tenantId: string): Promise<boolean> {
  const tokens = getStoredTokens();
  if (!tokens) return false;

  try {
    const res = await fetch(`${apiUrl}/api/v1/auth/refresh`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${tokens.refreshToken}`,
        "x-tenant-id": tenantId,
      },
    });

    if (!res.ok) {
      clearTokens();
      return false;
    }

    const data = await res.json() as {
      token: string;
      refreshToken: string;
      tokenExpires: number;
    };

    localStorage.setItem(KEYS.accessToken, data.token);
    localStorage.setItem(KEYS.refreshToken, data.refreshToken);
    localStorage.setItem(KEYS.tokenExpires, String(data.tokenExpires));
    return true;
  } catch {
    clearTokens();
    return false;
  }
}

async function getValidToken(apiUrl: string, tenantId: string): Promise<string | null> {
  const tokens = getStoredTokens();
  if (!tokens) return null;

  // Refresh if within 30s of expiry
  if (Date.now() > tokens.tokenExpires - 30_000) {
    const refreshed = await refreshAccessToken(apiUrl, tenantId);
    if (!refreshed) return null;
    return getStoredTokens()?.accessToken ?? null;
  }

  return tokens.accessToken;
}

async function openmeetFetch(
  link: CalendarLink,
  path: string,
): Promise<unknown> {
  const token = await getValidToken(link.apiUrl, link.tenantId);
  const headers: Record<string, string> = { "x-tenant-id": link.tenantId };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${link.apiUrl}${path}`, { headers });

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
