<script lang="ts">
  import { page } from "$app/state";
  import { setNavbar } from "$lib/components/layout/navbar.svelte";

  let { children } = $props();
  const spaceId = $derived(page.params.space!);

  $effect(() => {
    setNavbar(settingsNavbar);
    return () => setNavbar(undefined);
  });

  const tabs = [
    { href: "", label: "General" },
    { href: "/roles", label: "Roles" },
    { href: "/members", label: "Members" },
    { href: "/invites", label: "Invites" },
  ];

  function isActive(href: string) {
    const base = `/${spaceId}/settings`;
    const target = `${base}${href}`;
    return href === "" ? page.url.pathname === base : page.url.pathname === target;
  }
</script>

{#snippet settingsNavbar()}
  <div class="flex-1 text-center font-bold text-lg text-base-900 dark:text-base-100">
    Space settings
  </div>
{/snippet}

<div class="h-full flex flex-col">
  <header class="px-4 py-3 border-b border-base-200 dark:border-base-800 bg-white dark:bg-base-900">
    <nav class="flex gap-1 text-sm">
      {#each tabs as tab (tab.href)}
        <a
          href={`/${spaceId}/settings${tab.href}`}
          class="px-3 py-1 rounded-full {isActive(tab.href)
            ? 'bg-accent-500 text-white'
            : 'hover:bg-base-100 dark:hover:bg-base-800 text-base-600 dark:text-base-400'}"
        >
          {tab.label}
        </a>
      {/each}
    </nav>
  </header>
  <div class="flex-1 overflow-y-auto p-6">
    {@render children()}
  </div>
</div>
