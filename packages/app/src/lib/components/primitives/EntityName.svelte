<script lang="ts">
  import { page } from "$app/state";
  import type { Ulid } from "$lib/schema";
  import { LiveQuery } from "$lib/utils/liveQuery.svelte";
  import { sql } from "$lib/utils/sqlTemplate";

  let {
    id = $bindable(),
  }: {
    id: Ulid;
  } = $props();

  $effect(() => {
    console.log("Name", {
      id,
      name,
      spaceId: page.params.space,
    });
  });

  let query = new LiveQuery<{ name: string }>(
    () => sql`
      select
        ci.name
      from comp_info ci
        where ci.entity = ${id}
        limit 1
    `,
  );

  let name = $derived.by(() => {
    if (!query.result) return null;
    return query.result[0]?.name;
  });
</script>

{name}
