import { Handle, StreamDid, UserDid } from "@roomy/sdk";
import { LiveQuery } from "$lib/utils/liveQuery.svelte";
import { sql } from "$lib/utils/sqlTemplate";
import { backend, backendStatus, getPersonalSpaceId } from "$lib/workers";
import type { SpaceMeta } from "./types";
import { SvelteMap } from "svelte/reactivity";

/** The space list. */
let spacesQuery: LiveQuery<SpaceMeta>;
let handlesForSpace = new SvelteMap<StreamDid, Handle | undefined>();

// For Svelte reactivity we need to export a const object:
// mutate properties, never reassign the object itself
export const joinedSpaces = $state<{
  list: SpaceMeta[];
  loading: boolean;
  error: string;
}>({ list: [], loading: true, error: "" });
(globalThis as any).joinedSpaces = joinedSpaces;

$effect.root(() => {
  spacesQuery = new LiveQuery(
    () => sql`-- spaces
      select json_object(
          'id', cs.entity,
          'name', ci.name,
          'avatar', ci.avatar,
          'description', ci.description,
          'handle_account', cs.handle_account,
          'permissions', (
            select json_group_array(
              json_array(cu.did, json_extract(e.payload, '$.can')))
            from edges e 
            join comp_user cu on cu.did = e.tail
            where e.head = cs.entity and e.label = 'member'
        )) as json
      from comp_space cs
      join entities e on e.id = cs.entity
      left join comp_info ci on cs.entity = ci.entity
      where e.stream_id = ${getPersonalSpaceId()} 
        and hidden = 0
    `,
    (row) => JSON.parse(row.json),
  );

  /** Asynchronously resolve handle for each space and store in reactive map */
  $effect(() => {
    if (
      backendStatus.authState?.state !== "authenticated" ||
      backendStatus.roomyState?.state !== "connected" ||
      !spacesQuery.result?.length
    )
      return;

    Promise.all(
      spacesQuery.result
        .filter(
          (space) => space.handle_account && !handlesForSpace.has(space.id),
        )
        .map(async (space) => {
          return {
            id: space.id,
            handle: await backend.resolveHandleForSpace(
              space.id,
              UserDid.assert(space.handle_account),
            ),
          };
        }),
    ).then((spaces) => {
      spaces
        .filter((s) => !!s.handle)
        .forEach((space) => handlesForSpace.set(space.id, space.handle));
    });
  });

  // Update spaces list, loading the space handle if it has one.
  $effect(() => {
    if (
      backendStatus.authState?.state !== "authenticated" ||
      backendStatus.roomyState?.state !== "connected" ||
      !spacesQuery.result?.length
    )
      return;

    const spacesWithMeta = spacesQuery.result.map((spaceRow) => ({
      ...spaceRow,
      handle: handlesForSpace.get(spaceRow.id),
      backfill_status: backendStatus.spaces?.[spaceRow.id] || "error",
    }));

    joinedSpaces.list = spacesWithMeta;
    joinedSpaces.loading = false;

    // console.info("Joined Spaces", {
    //   joinedSpaces: $state.snapshot(joinedSpaces),
    //   spacesQuery: $state.snapshot(spacesQuery.result),
    // });
  });
});
