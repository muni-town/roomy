import { page } from "$app/state";
import { LiveQuery } from "./liveQuery.svelte";
import { backendStatus } from "./workers";
import { Hash } from "./workers/encoding";

export type SpaceMeta = {
  id: string;
  name?: string;
  avatar?: string;
  description?: string;
};

export let spaces: LiveQuery<SpaceMeta>;

export let current = $state({
  spaceMeta: undefined as SpaceMeta | undefined,
});

$effect.root(() => {
  spaces = new LiveQuery(
    "select id, name, avatar, description from spaces where stream = ? and hidden = 0",
    () => [
      backendStatus.personalStreamId &&
        Hash.enc(backendStatus.personalStreamId),
    ],
    (row: {
      id: Uint8Array;
      name?: string;
      avatar?: string;
      description?: string;
    }) => ({
      ...row,
      id: Hash.dec(row.id),
    }),
  );

  // Update current values
  $effect(() => {
    current.spaceMeta = page.params.space
      ? spaces.result?.find((x) => x.id == page.params.space)
      : undefined;
  });
});
