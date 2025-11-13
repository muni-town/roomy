<script lang="ts">
  import { LiveQuery } from "$lib/liveQuery.svelte";
  import { current } from "$lib/queries.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import { id } from "$lib/workers/encoding";
  import { Avatar } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";

  const users = new LiveQuery<{
    id: string;
    name: string | null;
    avatar: string | null;
    info: { can: "admin" | "post" };
  }>(
    () => sql`
    select
      id(tail) as id,
      payload as info,
      i.name as name,
      i.avatar as avatar
    from edges
      left join comp_info i on i.entity = tail
    where
      label = 'member'
        and
      head = ${current.space?.id && id(current.space.id)}
  `,
    (row) => ({
      ...row,
      info: JSON.parse(row.info),
    }),
  );
</script>

<div class="space-y-12 pt-4 overflow-y-auto">
  <div class="space-y-6">
    <h2 class="text-base/7 font-semibold text-base-900 dark:text-base-100">
      Members
    </h2>

    <ul class="flex flex-col gap-2">
      {#each users.result || [] as member}
        <li>
          <a class="flex row gap-3 items-center" href={`/user/${member.id}`}>
            <Avatar.Root class="size-8 sm:size-10">
              <Avatar.Image src={member.avatar} class="rounded-full" />
              <Avatar.Fallback>
                <AvatarBeam name={member.id} />
              </Avatar.Fallback>
            </Avatar.Root>
            {member.name}</a
          >
        </li>
      {/each}
    </ul>
  </div>
</div>
