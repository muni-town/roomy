import { createQuery } from "@tanstack/svelte-query";
import { cache, schemas } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

export type Profile = typeof schemas.queries.getProfile.Profile.infer;

export function createProfileQuery(actor: () => string) {
  return createQuery(() => ({
    queryKey: queryKey("space.roomy.user.getProfile", { actor: actor() }),
    queryFn: () =>
      px().query("space.roomy.user.getProfile", { actor: actor() }),
  }));
}