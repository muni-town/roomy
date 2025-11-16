<script lang="ts">
  import { LiveQuery } from "$lib/liveQuery.svelte";
  import { current } from "$lib/queries.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import { backend, backendStatus } from "$lib/workers";
  import { id } from "$lib/workers/encoding";
  import { Button } from "@fuxui/base";
  import { Avatar } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";
  import { ulid } from "ulidx";

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

  async function addAdmin(userId: string) {
    if (!current.space?.id) return;

    await backend.sendEvent(current.space?.id, {
      ulid: ulid(),
      parent: undefined,
      variant: {
        kind: "space.roomy.admin.add.0",
        data: {
          adminId: userId,
        },
      },
    });
  }

  async function removeAdmin(userId: string) {
    if (!current.space?.id) return;

    await backend.sendEvent(current.space?.id, {
      ulid: ulid(),
      parent: undefined,
      variant: {
        kind: "space.roomy.admin.remove.0",
        data: {
          adminId: userId,
        },
      },
    });
  }
</script>

<div class="space-y-12 pt-4 overflow-y-auto">
  <div class="space-y-6">
    <h2 class="text-base/7 font-semibold text-base-900 dark:text-base-100">
      Members
    </h2>

    <ul class="flex flex-col gap-2">
      {#each users.result || [] as member}
        <li class="flex items-center gap-4">
          <a class="flex row gap-3 items-center" href={`/user/${member.id}`}>
            <Avatar.Root class="size-8 sm:size-10">
              <Avatar.Image src={member.avatar} class="rounded-full" />
              <Avatar.Fallback>
                <AvatarBeam name={member.id} />
              </Avatar.Fallback>
            </Avatar.Root>
            {member.name}</a
          >
          {#if current.space?.permissions.find(([user, perm]) => user == member.id && perm != "admin")}
            <Button onclick={() => addAdmin(member.id)}>Make Admin</Button>
          {:else if member.id != backendStatus.did}
            <Button onclick={() => removeAdmin(member.id)}>Demote Admin</Button>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
</div>
