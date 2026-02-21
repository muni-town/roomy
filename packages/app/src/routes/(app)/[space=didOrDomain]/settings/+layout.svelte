<script lang="ts">
  import { page } from "$app/state";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import MainSidebarSpace from "$lib/components/sidebars/SpaceSidebarHeader.svelte";
  import { flags } from "$lib/config";
  import { Button, ScrollArea } from "@fuxui/base";

  import { IconArrowLeft } from "@roomy/design/icons";

  let sidebarLinks = [
    {
      label: "General",
      slug: "general",
    },
    {
      label: "Members",
      slug: "members",
    },
    {
      label: "Handle",
      slug: "handle",
    },
  ];
  if (flags.discordImport) {
    sidebarLinks.push({
      label: "Discord Import",
      slug: "discord-import",
    });
  }
  if (flags.discordBridge) {
    sidebarLinks.push({
      label: "Discord Bridge",
      slug: "discord-bridge",
    });
  }

  let { children } = $props();
</script>

<MainLayout>
  {#snippet sidebar()}
    <MainSidebarSpace />

    <div class="px-2 flex flex-col gap-2">
      <Button href={`/${page.params.space}`} class="w-full justify-start mb-4">
        <IconArrowLeft class="size-4" />
        Back to space
      </Button>

      {#each sidebarLinks as link}
        <Button
          variant="ghost"
          class="w-full justify-start"
          href={`/${page.params.space}/settings/${link.slug}`}
          data-current={page.url.pathname.endsWith(link.slug)}
        >
          {link.label}
        </Button>
      {/each}

      <!-- <Button
        variant="ghost"
        class="w-full justify-start"
        href={`/${page.params.space}/settings/discord-import`}
        data-current={page.url.pathname.endsWith("discord-import")}
      >
        Discord Import
      </Button> -->
      <!-- <Button
        variant="ghost"
        class="w-full justify-start"
        href={`/${page.params.space}/settings/members`}
        data-current={page.url.pathname.includes("members")}>Members</Button
      >
      <Button
        variant="ghost"
        class="w-full justify-start"
        href={`/${page.params.space}/settings/twitter-import`}
        data-current={page.url.pathname.includes("twitter-import")}
        >Twitter Import</Button
      >
      <Button
        variant="ghost"
        class="w-full justify-start"
        data-current={page.url.pathname.includes("discord-bridge")}
        href={`/${page.params.space}/settings/discord-bridge`}
       >Discord Bridge
      </Button> -->
    </div>
  {/snippet}

  <ScrollArea>
    <div class="max-w-3xl mx-auto w-full p-4">
      {@render children?.()}
    </div>
  </ScrollArea>
</MainLayout>
