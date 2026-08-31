<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import UserProfile from "./UserProfile.svelte";

  const { Story } = defineMeta({
    title: "User/UserProfile",
    component: UserProfile,
  });

  const profile = {
    did: "did:plc:test",
    handle: "ada",
    displayName: "Ada Lovelace",
    description:
      "Mathematician & first programmer.\n\nhttps://en.wikipedia.org/wiki/Ada_Lovelace",
    avatar: undefined,
  };
</script>

{#snippet template(_args)}
  <div class="p-4 w-full">
    <UserProfile profile={profile}>
      {#snippet actions()}
        <button
          class="px-4 py-2 rounded-lg bg-accent-500 text-white text-sm font-medium"
        >
          Follow
        </button>
      {/snippet}
    </UserProfile>
  </div>
{/snippet}

<Story name="Default" {template} />
