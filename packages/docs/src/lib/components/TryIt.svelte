<script lang="ts">
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import Input from "@roomy/design/components/ui/input/Input.svelte";
  import { auth } from "$lib/auth.svelte";
  import { callEndpoint } from "$lib/xrpc";
  import type { Endpoint } from "$lib/endpoints/registry";

  let { endpoint }: { endpoint: Endpoint } = $props();

  // ── Form state ──────────────────────────────────────────────────────────
  // Params are string inputs (query string). Input schema fields are edited
  // as a JSON body (procedures) — one textarea per field, assembled on run.

  let paramValues = $state<Record<string, string>>({});
  let bodyValues = $state<Record<string, string>>({});
  let running = $state(false);
  let result = $state<string | null>(null);
  let resultError = $state(false);
  let status = $state<number | null>(null);
  let durationMs = $state<number | null>(null);

  const hasParams = $derived((endpoint.params?.length ?? 0) > 0);
  const hasBody = $derived(
    (endpoint.inputSchema?.properties
      ? Object.keys(endpoint.inputSchema.properties).length > 0
      : false) && endpoint.kind === "procedure",
  );

  function defaultBodyValue(name: string): string {
    const prop = endpoint.inputSchema?.properties[name];
    if (!prop) return "";
    if (prop.type === "boolean") return "false";
    if (prop.type === "number" || prop.type === "int") return "0";
    if (prop.type === "string[]") return "[]";
    if (prop.type === "object") return "{}";
    return "";
  }

  function buildBody(): Record<string, unknown> | undefined {
    if (!hasBody) return undefined;
    const body: Record<string, unknown> = {};
    const props = endpoint.inputSchema?.properties ?? {};
    for (const name of Object.keys(props)) {
      const raw = bodyValues[name]?.trim();
      if (!raw) continue;
      const prop = props[name];
      if (!prop) continue;
      try {
        if (prop.type === "boolean") body[name] = raw === "true";
        else if (prop.type === "number" || prop.type === "int") body[name] = Number(raw);
        else if (prop.type === "string[]" || prop.type === "object") body[name] = JSON.parse(raw);
        else body[name] = raw;
      } catch {
        body[name] = raw;
      }
    }
    return body;
  }

  async function run() {
    if (!auth.agent) return;
    running = true;
    result = null;
    resultError = false;
    status = null;
    durationMs = null;
    try {
      const res = await callEndpoint(auth.agent, endpoint.nsid, paramValues, buildBody());
      status = res.status;
      durationMs = res.durationMs;
      result = JSON.stringify(res.data, null, 2);
    } catch (err: unknown) {
      resultError = true;
      const e = err as Error & { _status?: number; _durationMs?: number };
      status = e._status ?? null;
      durationMs = e._durationMs ?? null;
      result = e.message ?? String(err);
    } finally {
      running = false;
    }
  }

  function curlSnippet(): string {
    const base = "https://api.roomy.space";
    const method = endpoint.kind === "procedure" ? "POST" : "GET";
    const qs = Object.entries(paramValues)
      .filter(([, v]) => v !== "")
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    const url = `${base}/xrpc/${endpoint.nsid}${qs ? `?${qs}` : ""}`;
    const body = buildBody();
    if (method === "POST" && body) {
      return `curl -X POST '${url}' \\
  -H 'Authorization: Bearer <service-auth-jwt>' \\
  -H 'Content-Type: application/json' \\
  -d '${JSON.stringify(body)}'`;
    }
    return `curl '${url}' \\
  -H 'Authorization: Bearer <service-auth-jwt>'`;
  }
</script>

<section class="mt-10 rounded-2xl border border-base-200 dark:border-base-800 bg-white dark:bg-base-900/50 p-6">
  <div class="flex items-center justify-between mb-4">
    <h2 class="text-lg font-semibold">Try it</h2>
    {#if endpoint.adminOnly}
      <span
        class="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"
        title="Requires a DID on the appserver's admin allowlist"
      >
        Admin only
      </span>
    {/if}
  </div>

  {#if !auth.authenticated}
    <p class="text-sm text-base-500 mb-4">
      Sign in with your ATProto handle to call this endpoint.
      <a href="/playground" class="text-accent-600 dark:text-accent-400 hover:underline">Go to the playground to sign in</a>.
    </p>
  {:else}
    {#if endpoint.adminOnly && !auth.isAdmin}
      <div class="mb-4 rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm text-amber-700 dark:text-amber-300">
        This endpoint is admin-only. Unless your DID is on the appserver's admin
        allowlist, the call will fail with a 403 — that's expected.
      </div>
    {/if}

    {#if hasParams}
      <div class="mb-4">
        <h3 class="text-sm font-medium text-base-500 mb-2">Query parameters</h3>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {#each endpoint.params ?? [] as param}
            {@const value = paramValues[param.name] ?? ""}
            <div>
              <label for="try-{param.name}" class="block text-xs mb-1">
                <code>{param.name}</code>
                {param.required ? '' : '(optional)'}
              </label>
              <Input
                id="try-{param.name}"
                value={value}
                oninput={(e) => { paramValues[param.name] = (e.target as HTMLInputElement).value; }}
                placeholder={param.default ?? (param.type === "int" ? "0" : "")}
              />
            </div>
          {/each}
        </div>
      </div>
    {/if}

    {#if hasBody}
      <div class="mb-4">
        <h3 class="text-sm font-medium text-base-500 mb-2">JSON body</h3>
        <div class="space-y-3">
          {#each Object.entries(endpoint.inputSchema?.properties ?? {}) as [name, prop]}
            <div>
              <label for="try-body-{name}" class="block text-xs mb-1">
                <code>{name}</code>
                <span class="text-base-400">({prop.type})</span>
                {prop.optional ? ' — optional' : ''}
              </label>
              <textarea
                id="try-body-{name}"
                rows="2"
                class="w-full text-sm p-2 border border-base-200 dark:border-base-800 rounded-xl bg-base-50 dark:bg-base-900/50 text-base-800 dark:text-base-200 font-mono"
                placeholder={defaultBodyValue(name)}
                value={bodyValues[name] ?? defaultBodyValue(name)}
                oninput={(e) => { bodyValues[name] = (e.target as HTMLTextAreaElement).value; }}
              ></textarea>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <div class="flex items-center gap-3 mb-4">
      <Button onclick={run} disabled={running}>
        {running ? "Calling…" : "Run"}
      </Button>
      {#if status !== null}
        <span
          class="text-xs font-medium"
          class:text-green-600={status >= 200 && status < 300}
          class:text-red-500={status >= 400}
        >
          HTTP {status}
        </span>
      {/if}
      {#if durationMs !== null}
        <span class="text-xs text-base-400">{durationMs.toFixed(0)} ms</span>
      {/if}
    </div>

    {#if result !== null}
      <div>
        <h3 class="text-sm font-medium text-base-500 mb-2">Response</h3>
        <pre
          class="p-3 rounded-xl text-sm whitespace-pre-wrap overflow-x-auto max-h-96 overflow-y-auto font-mono {resultError
            ? 'bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300'
            : 'bg-base-100 dark:bg-base-900/50 text-base-600 dark:text-base-400'}"
        >{result}</pre>
      </div>
    {/if}

    <details class="mt-4">
      <summary class="text-xs text-base-400 cursor-pointer hover:text-base-600 dark:hover:text-base-300">
        Copy as curl
      </summary>
      <pre class="mt-2 p-3 rounded-xl bg-base-100 dark:bg-base-900/50 text-xs font-mono overflow-x-auto">{curlSnippet()}</pre>
    </details>
  {/if}
</section>
