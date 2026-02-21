import type { CalendarLink } from "$lib/queries/calendar.svelte";
import type { PeerInterface } from "$lib/workers/peer/types";
import { CONFIG } from "$lib/config";

// localStorage keys for OpenMeet auth tokens
const KEYS = {
  accessToken: "openmeet:accessToken",
  refreshToken: "openmeet:refreshToken",
  tokenExpires: "openmeet:tokenExpires",
  profile: "openmeet:profile",
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

/** Exchange a PDS service auth token for OpenMeet access/refresh tokens. */
export async function connectViaServiceAuth(
  link: CalendarLink,
  peer: PeerInterface,
): Promise<void> {
  const token = await peer.getServiceAuthToken(
    CONFIG.openmeetServiceDid,
    "net.openmeet.auth",
  );

  const res = await fetch(`${link.apiUrl}/api/v1/auth/atproto/service-auth`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-tenant-id": link.tenantId,
    },
    body: JSON.stringify({ token }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenMeet service auth failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    token: string;
    refreshToken: string;
    tokenExpires: number;
    user?: {
      socialId?: string;
      firstName?: string;
      lastName?: string;
      photo?: { path?: string } | null;
    };
  };

  localStorage.setItem(KEYS.accessToken, data.token);
  localStorage.setItem(KEYS.refreshToken, data.refreshToken);
  localStorage.setItem(KEYS.tokenExpires, String(data.tokenExpires));

  if (data.user) {
    const profile: OpenMeetProfile = {
      did: data.user.socialId || "",
      handle: data.user.socialId || "",
      displayName: [data.user.firstName, data.user.lastName]
        .filter(Boolean)
        .join(" ") || undefined,
      avatar: data.user.photo?.path || undefined,
    };
    localStorage.setItem(KEYS.profile, JSON.stringify(profile));
  }
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
