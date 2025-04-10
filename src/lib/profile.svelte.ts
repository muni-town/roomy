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
  // Check for invalid DIDs
  if (!did || typeof did !== 'string') {
    console.error('Invalid DID provided to getProfile:', did);
    return Promise.resolve({
      did: 'unknown',
      handle: 'unknown',
      displayName: 'Unknown User (Invalid DID)',
      avatarUrl: '',
    });
  }

  const cached = cache.get(did);
  if (cached !== undefined) return cached;

  if (!user.agent) {
    console.error('No user agent available for getProfile()');
    return Promise.resolve({
      did: did,
      handle: 'unknown',
      displayName: 'Unknown User (No Agent)',
      avatarUrl: '',
    });
  }

  const promise: Promise<ProfileMeta> = new Promise((resolve) => {
    user.agent!.getProfile({ actor: did })
      .then((resp) => {
        if (!resp.success) {
          console.warn('Profile fetch unsuccessful for DID:', did);
          resolve({
            did: did,
            handle: 'unknown',
            displayName: 'Unknown User (Fetch Failed)',
            avatarUrl: '',
          });
          return;
        }
        resolve({
          did,
          handle: resp.data.handle,
          displayName: resp.data.displayName,
          avatarUrl: resp.data.avatar || '',
        });
      })
      .catch((error) => {
        console.error('Error fetching profile for DID:', did, error);
        resolve({
          did: did,
          handle: 'unknown',
          displayName: 'Unknown User (Error)',
          avatarUrl: '',
        });
      });
  });

  cache.set(did, promise);
  return promise;
}
