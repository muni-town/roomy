import { user } from "./user.svelte";

let cache: {
  [did: string]: {
    handle: string;
    avatarUrl: string;
    new: boolean;
  };
} = $state({});

export function getProfile(did: string): { handle: string; avatarUrl: string } {
  if (!cache[did]) {
    cache[did] = { handle: "", avatarUrl: "", new: true };
  }
  const entry = cache[did];

  queueMicrotask(() => {
    if (entry.new == true) {
      entry.new = false;
      if (user.agent) {
        user.agent.getProfile({ actor: did }).then(async (resp) => {
          if (!resp.success) return;
          entry.handle = resp.data.handle;
          entry.avatarUrl = resp.data.avatar || "";
        });
      }
    }
  });

  return entry;
}
