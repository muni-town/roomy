<script lang="ts">
  import { endpoints } from "$lib/endpoints/registry";
  import { page } from "$app/stores";
  import { auth, login as authLogin, logout as authLogout } from "$lib/auth.svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";

  let handle = $state("");

  async function handleLogin() {
    if (!handle.trim()) return;
    await authLogin(handle.trim());
  }

  async function handleLogout() {
    await authLogout();
  }

  const concepts = [
    { href: "/concepts/spaces", label: "Spaces" },
    { href: "/concepts/rooms", label: "Rooms" },
    { href: "/concepts/messages", label: "Messages" },
    { href: "/concepts/real-time", label: "Real-time" },
    { href: "/concepts/auth", label: "Auth" },
    { href: "/concepts/data-model", label: "Data model" },
  ];

  // ── Endpoint search ─────────────────────────────────────────────────────
  let search = $state("");

  const filteredGroups = $derived.by(() => {
    const q = search.trim().toLowerCase();
    if (!q) return endpoints;
    return endpoints
      .map((g) => ({
        name: g.name,
        items: g.items.filter(
          (ep) =>
            ep.nsid.toLowerCase().includes(q) ||
            ep.description.toLowerCase().includes(q) ||
            g.name.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.items.length > 0);
  });

  function isActive(href: string): boolean {
    if (href === "/") return $page.url.pathname === "/";
    return $page.url.pathname.startsWith(href);
  }
</script>

<aside class="w-72 shrink-0 border-r border-base-200 dark:border-base-800 bg-base-50 dark:bg-base-950 overflow-y-auto flex flex-col">
  <div class="p-4 flex-1">
    <a href="/" class="flex items-center gap-2 mb-6 no-underline">
      <span class="text-xl font-display font-bold text-accent-600 dark:text-accent-400">Roomy</span>
      <span class="text-sm text-base-500">API Docs</span>
    </a>

    <nav class="space-y-1">
      <a
        href="/"
        class="block px-3 py-2 rounded-lg text-sm font-medium transition-colors
          {isActive('/') ? 'bg-accent-100 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300' : 'text-base-600 dark:text-base-400 hover:bg-base-100 dark:hover:bg-base-900'}"
      >
        Home
      </a>
      <a
        href="/quickstart"
        class="block px-3 py-2 rounded-lg text-sm font-medium transition-colors
          {isActive('/quickstart') ? 'bg-accent-100 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300' : 'text-base-600 dark:text-base-400 hover:bg-base-100 dark:hover:bg-base-900'}"
      >
        Quickstart
      </a>

      <div class="mt-6 mb-2">
        <h3 class="px-3 text-xs font-semibold uppercase tracking-wider text-base-400 dark:text-base-500">Concepts</h3>
      </div>
      {#each concepts as c}
        <a
          href={c.href}
          class="block px-3 py-2 rounded-lg text-sm font-medium transition-colors
            {isActive(c.href) ? 'bg-accent-100 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300' : 'text-base-600 dark:text-base-400 hover:bg-base-100 dark:hover:bg-base-900'}"
        >
          {c.label}
        </a>
      {/each}

      <div class="mt-6 mb-2">
        <h3 class="px-3 text-xs font-semibold uppercase tracking-wider text-base-400 dark:text-base-500">Endpoints</h3>
      </div>

      <div class="px-3 mb-2">
        <input
          type="text"
          placeholder="Search endpoints…"
          bind:value={search}
          class="w-full px-2.5 py-1.5 rounded-lg border border-base-200 dark:border-base-800 bg-white dark:bg-base-900 text-sm text-base-800 dark:text-base-200 placeholder:text-base-400 focus:outline-none focus:ring-2 focus:ring-accent-400/50"
        />
      </div>

      {#if filteredGroups.length === 0}
        <p class="px-3 text-xs text-base-400">No endpoints match "{search}".</p>
      {/if}

      {#each filteredGroups as group (group.name)}
        <div class="mb-1">
          <h4 class="px-3 text-xs font-medium text-base-400 dark:text-base-500 uppercase tracking-wider mt-3 mb-1">{group.name}</h4>
          {#each group.items as ep}
            <a
              href="/endpoints/{ep.nsid.replace(/\./g, '/')}"
              class="block px-3 py-1.5 rounded-lg text-sm transition-colors
                {$page.url.pathname === '/endpoints/' + ep.nsid.replace(/\./g, '/') ? 'bg-accent-100 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300' : 'text-base-600 dark:text-base-400 hover:bg-base-100 dark:hover:bg-base-900'}"
            >
              <span class="font-mono text-xs">{ep.nsid}</span>
            </a>
          {/each}
        </div>
      {/each}

      <div class="mt-6 mb-2">
        <h3 class="px-3 text-xs font-semibold uppercase tracking-wider text-base-400 dark:text-base-500">Tools</h3>
      </div>
      <a
        href="/playground"
        class="block px-3 py-2 rounded-lg text-sm font-medium transition-colors
          {isActive('/playground') ? 'bg-accent-100 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300' : 'text-base-600 dark:text-base-400 hover:bg-base-100 dark:hover:bg-base-900'}"
      >
        Playground
      </a>
      {#if auth.isAdmin}
        <a
          href="/dashboard"
          class="block px-3 py-2 rounded-lg text-sm font-medium transition-colors
            {isActive('/dashboard') ? 'bg-accent-100 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300' : 'text-base-600 dark:text-base-400 hover:bg-base-100 dark:hover:bg-base-900'}"
        >
          Dashboard
        </a>
      {/if}
      <a
        href="/contributing"
        class="block px-3 py-2 rounded-lg text-sm font-medium transition-colors
          {isActive('/contributing') ? 'bg-accent-100 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300' : 'text-base-600 dark:text-base-400 hover:bg-base-100 dark:hover:bg-base-900'}"
      >
        Contributing
      </a>
    </nav>
  </div>

  <!-- ── Auth footer ─────────────────────────────────────────────────────── -->
  <div class="p-4 border-t border-base-200 dark:border-base-800">
    {#if auth.authenticated}
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs text-base-400 font-mono truncate" title={auth.session?.did}>
          {auth.session?.did}
        </span>
        <Button variant="ghost" size="sm" onclick={handleLogout}>Sign out</Button>
      </div>
    {:else}
      <div>
        <label for="sidebar-handle" class="block text-xs text-base-400 mb-1">Sign in to try endpoints</label>
        <div class="flex gap-2">
          <input
            id="sidebar-handle"
            type="text"
            placeholder="user.bsky.social"
            bind:value={handle}
            class="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg border border-base-200 dark:border-base-800 bg-white dark:bg-base-900 text-sm text-base-800 dark:text-base-200 placeholder:text-base-400 focus:outline-none focus:ring-2 focus:ring-accent-400/50"
            onkeydown={(e) => e.key === "Enter" && handleLogin()}
          />
          <Button size="sm" onclick={handleLogin} disabled={!handle.trim()}>Sign in</Button>
        </div>
      </div>
    {/if}
  </div>
</aside>
