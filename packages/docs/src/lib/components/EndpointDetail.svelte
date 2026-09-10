<script lang="ts">
  import type { Endpoint } from "$lib/endpoints/registry";
  import TryIt from "./TryIt.svelte";

  let { endpoint }: { endpoint: Endpoint } = $props();
</script>

<div class="prose dark:prose-invert">
  <p class="text-sm text-base-500 mb-2">
    <a href="/endpoints" class="no-underline hover:underline">&larr; All endpoints</a>
  </p>

  <div class="flex items-center gap-3 mb-2">
    <h1 class="mb-0 font-mono text-xl">{endpoint.nsid}</h1>
    <span
      class="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium
        {endpoint.kind === 'query'
          ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
          : endpoint.kind === 'procedure'
            ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
            : 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300'}"
    >
      {endpoint.kind}
    </span>
  </div>

  <p class="lead text-base-600 dark:text-base-400">{endpoint.description}</p>

  <hr />

  <h2>Details</h2>

  <table>
    <tbody>
      <tr>
        <th class="w-40">Group</th>
        <td>{endpoint.group}</td>
      </tr>
      <tr>
        <th>Authorization</th>
        <td>{endpoint.auth}</td>
      </tr>
    </tbody>
  </table>

  {#if endpoint.params && endpoint.params.length > 0}
    <h2>Parameters</h2>
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Type</th>
          <th>Required</th>
          <th>Default</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {#each endpoint.params as param}
          <tr>
            <td><code>{param.name}</code></td>
            <td><code>{param.type}</code></td>
            <td>{param.required ? 'Yes' : 'No'}</td>
            <td>{param.default ?? '-'}</td>
            <td>{param.description}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  {#if endpoint.inputSchema}
    <h2>Input Schema</h2>
    <p>JSON body for <code>{endpoint.kind === 'procedure' ? 'POST' : 'GET'}</code> requests.</p>
    <table>
      <thead>
        <tr>
          <th>Field</th>
          <th>Type</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {#each Object.entries(endpoint.inputSchema.properties) as [name, prop]}
          <tr>
            <td><code>{name}</code></td>
            <td><code>{prop.type}</code></td>
            <td>{prop.description}{prop.optional ? ' (optional)' : ''}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  {#if endpoint.outputSchema}
    <h2>Response Schema</h2>
    <table>
      <thead>
        <tr>
          <th>Field</th>
          <th>Type</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {#each Object.entries(endpoint.outputSchema.properties) as [name, prop]}
          <tr>
            <td><code>{name}</code></td>
            <td><code>{prop.type}</code></td>
            <td>{prop.description}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  {#if endpoint.notes && endpoint.notes.length > 0}
    <h2>Notes</h2>
    <ul>
      {#each endpoint.notes as note}
        <li>{@html note}</li>
      {/each}
    </ul>
  {/if}

  {#if endpoint.invalidation && endpoint.invalidation.length > 0}
    <h2>Invalidation Signals</h2>
    <p>This endpoint's cached data is invalidated when:</p>
    <ul>
      {#each endpoint.invalidation as signal}
        <li>{signal}</li>
      {/each}
    </ul>
  {/if}
</div>

<TryIt {endpoint} />
