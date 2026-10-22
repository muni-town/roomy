<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import UserProfile from "./UserProfile.svelte";

  const { Story } = defineMeta({
    title: "User/UserProfile",
    component: UserProfile,
    render: template,
  });

  type Profile = {
    did: string;
    handle: string;
    displayName: string;
    description: string;
    pronouns?: string;
    website?: string;
    avatar?: string;
  };

  const baseProfile: Profile = {
    did: "did:plc:test",
    handle: "ada",
    displayName: "Ada Lovelace",
    description:
      "Mathematician & first programmer.\n\nhttps://en.wikipedia.org/wiki/Ada_Lovelace",
    avatar: undefined,
  };
</script>

{#snippet template(args: { profile: Profile })}
  <div class="p-4 w-full">
    <UserProfile profile={args.profile}>
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

<Story name="Default" args={{ profile: baseProfile }} {template} />

<Story
  name="With pronouns and website"
  args={{
    profile: {
      ...baseProfile,
      pronouns: "she/her",
      website: "https://ada.example.com/notes",
    },
  }}
  {template}
/>

<Story
  name="Website without scheme"
  args={{
    profile: { ...baseProfile, pronouns: "they/them", website: "ada.example.com" },
  }}
  {template}
/>
