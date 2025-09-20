import { page } from "$app/state";
import { LiveQuery } from "./liveQuery.svelte";
import { backendStatus } from "./workers";
import { Hash } from "./workers/encoding";

export type SpaceMeta = {
  id: string;
  name?: string;
  avatar?: string;
  description?: string;
  admins: string[];
};

export let spaces: LiveQuery<SpaceMeta>;

export let current = $state({
  space: undefined as SpaceMeta | undefined,
  isSpaceAdmin: false,
});

// All of our queries have to be made in the scope of an effect root but we can't export them from
// within the scope.
$effect.root(() => {
  spaces = new LiveQuery(
    `select json_object(
      'id', format_hash(id),
      'name', name,
      'avatar', avatar,
      'description', description,
      'admins', (select json_group_array(admin_id) from space_admins where space_id = id)
    ) as json
    from spaces
    where stream = ? and hidden = 0`,
    () => [
      backendStatus.personalStreamId &&
        Hash.enc(backendStatus.personalStreamId),
    ],
    (row) => JSON.parse(row.json),
  );
  (globalThis as any).spaces = spaces;

  // Update current values
  $effect(() => {
    current.space = page.params.space
      ? spaces.result?.find((x) => x.id == page.params.space)
      : undefined;
  });
  $effect(() => {
    if (backendStatus.did)
      current.isSpaceAdmin =
        current.space?.admins.includes(backendStatus.did) || false;
  });
});
