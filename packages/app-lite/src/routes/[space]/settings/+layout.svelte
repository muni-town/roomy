<script lang="ts">
  import { page } from "$app/state";

  let { children } = $props();
  const spaceId = $derived(page.params.space!);

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

<div class="h-full flex flex-col">
  <header class="px-4 py-3 border-b border-base-200 dark:border-base-800 bg-white dark:bg-base-900">
    <h1 class="text-lg font-semibold">Space settings</h1>
    <nav class="mt-2 flex gap-1 text-sm">
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
