<script lang="ts">
  import { endpoints } from "$lib/endpoints/registry";
</script>

<svelte:head>
  <title>All Endpoints — Roomy Appserver API Docs</title>
</svelte:head>

<div class="prose dark:prose-invert">
  <h1>All Endpoints</h1>

  <p class="lead text-lg text-base-600 dark:text-base-400">
    Complete reference of all XRPC methods exposed by the Roomy Appserver.
  </p>

  <hr />

  {#each endpoints as group}
    <h2>{group.name}</h2>

    <table>
      <thead>
        <tr>
          <th>NSID</th>
          <th>Kind</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {#each group.items as ep}
          <tr>
            <td>
              <a href="/endpoints/{ep.nsid.replace(/\./g, '/')}" class="font-mono text-sm">{ep.nsid}</a>
              {#if ep.adminOnly}
                <span
                  class="ml-1 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"
                  title="Requires a DID on the appserver's admin allowlist"
                >admin</span>
              {/if}
            </td>
            <td><span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium {ep.kind === 'query' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : ep.kind === 'procedure' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' : 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300'}">{ep.kind}</span></td>
            <td class="text-sm">{ep.description}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/each}
</div>
