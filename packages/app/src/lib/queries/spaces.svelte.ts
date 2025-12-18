import { did } from "$lib/schema";
import { LiveQuery } from "$lib/utils/liveQuery.svelte";
import { sql } from "$lib/utils/sqlTemplate";
import { backend, backendStatus, getPersonalStreamId } from "$lib/workers";
import type { SpaceMeta } from "./types";

/** The space list. */
let spacesQuery: LiveQuery<SpaceMeta>;

// For Svelte reactivity we need to export a const object:
// mutate properties, never reassign the object itself
export const joinedSpaces = $state<{
  list: SpaceMeta[];
  loading: boolean;
  error: string;
}>({ list: [], loading: true, error: "" });

$effect.root(() => {
  spacesQuery = new LiveQuery(
    () => sql`-- spaces
      select json_object(
          'id', id(cs.entity),
          'name', ci.name,
          'avatar', ci.avatar,
          'description', ci.description,
          'handle_account', cs.handle_account,
          'permissions', (
            select json_group_array(
              json_array(id(cu.did), json_extract(e.payload, '$.can')))
            from edges e 
            join comp_user cu on cu.did = e.tail
            where e.head = cs.entity and e.label = 'member'
        )) as json
      from comp_space cs
      join entities e on e.id = cs.entity
      left join comp_info ci on cs.entity = ci.entity
      where e.stream_id = ${getPersonalStreamId()} 
        and hidden = 0
    `,
    (row) => JSON.parse(row.json),
  );

  // Update spaces list, loading the space handle if it has one.
  $effect(() => {
    joinedSpaces.loading = true;
    joinedSpaces.error = "";
    joinedSpaces.list = [];
    Promise.all(
      spacesQuery.result?.map(async (spaceRow) => ({
        ...spaceRow,
        handle: spaceRow.handle_account
          ? await backend.resolveHandleForSpace(
              spaceRow.id,
              did.assert(spaceRow.handle_account),
            )
          : undefined,
        backfill_status: backendStatus.spaces?.[spaceRow.id] || "error",
      })) || [],
    )
      .then((s) => {
        joinedSpaces.list = s;
        joinedSpaces.loading = false;
      })
      .catch((e) => {
        joinedSpaces.loading = false;
        joinedSpaces.error = `Failed to load spaces: ${e}`;
      });
  });
});
