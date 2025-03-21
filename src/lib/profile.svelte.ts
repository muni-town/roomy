import { user } from "./user.svelte";

let cache: {
  [did: string]: {
    handle: string;
    avatarUrl: string;
  };
} = $state({});

export function getProfile(
  did: string,
): { handle: string; avatarUrl: string } | undefined {
  const entry = cache[did];

  queueMicrotask(() => {
    if (!cache[did]) {
      if (user.agent) {
        user.agent.getProfile({ actor: did }).then(async (resp) => {
          if (!resp.success) return;
          cache[did] = {
            handle: resp.data.handle,
            avatarUrl: resp.data.avatar || "",
          };
        });
      }
    }
  });

  return entry;
}
