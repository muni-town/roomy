<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import UserMenu from "./UserMenu.svelte";

  const { Story } = defineMeta({
    title: "User/UserMenu",
    component: UserMenu,
  });
</script>

{#snippet template(args: { connected: boolean })}
  <div class="p-4 w-full min-h-screen flex items-center justify-center bg-base-50 dark:bg-base-950">
    <UserMenu
      connected={(args as any).connected}
      displayName="Ada Lovelace"
      handle="ada@example.com"
      profileHref="#/u/ada"
      versionLabel="v0.1.0"
      onLogout={() => {}}
    />
  </div>
{/snippet}

<Story
  name="Connected"
  args={{ connected: true }}
  {template}
  parameters={{ layout: "fullscreen" }}
/>

<Story
  name="Disconnected"
  args={{ connected: false }}
  {template}
  parameters={{ layout: "fullscreen" }}
/>
