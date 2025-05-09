import { user } from "./user.svelte";

// Reload window on hot reload to avoid duplicating cache
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    window.location.reload();
  });
}

export type ProfileMeta = {
  did: string;
  handle: string;
  displayName?: string;
  avatarUrl: string;
};

let cache: Map<string, Promise<ProfileMeta>> = new Map();
export function getProfile(did: string): Promise<ProfileMeta> {
  const cached = cache.get(did);
  if (cached !== undefined) return cached;
  if (!user.agent) throw new Error("Must have user agent to getProfile()");

  const promise: Promise<ProfileMeta> = new Promise((resolve) => {
    if (did.startsWith("discord:")) {
      const [_discord, nick, avatar] = did.split(":");
      resolve({
        did,
        handle: nick!,
        displayName: nick!,
        avatarUrl: decodeURIComponent(avatar!),
      });
      return;
    }

    user.agent!.getProfile({ actor: did }).then((resp) => {
      if (!resp.success) return;
      resolve({
        did,
        handle: resp.data.handle,
        displayName: resp.data.displayName,
        avatarUrl: resp.data.avatar || "",
      });
    });
  });
  cache.set(did, promise);

  return promise;
}
