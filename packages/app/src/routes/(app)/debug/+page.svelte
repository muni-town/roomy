<script lang="ts">
  import { backend, sqliteStatus, backendStatus } from "$lib/workers";
  import { onMount } from "svelte";

  let diagnostics = $state({
    crossOriginIsolated: false,
    sharedArrayBufferAvailable: false,
    opfsAvailable: false,
    sqliteWorkerStatus: "unknown" as "unknown" | "active" | "inactive",
    vfsType: "unknown",
    workerId: "unknown",
    browserInfo: "",
    testResult: null as any,
    testError: null as string | null,
  });

  let isLoading = $state(false);

  onMount(() => {
    // Check basic browser capabilities
    diagnostics.crossOriginIsolated =
      typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
    diagnostics.sharedArrayBufferAvailable =
      typeof SharedArrayBuffer !== "undefined";
    diagnostics.opfsAvailable =
      typeof navigator.storage?.getDirectory === "function";
    diagnostics.browserInfo = navigator.userAgent;

    // Monitor worker status
    $effect(() => {
      diagnostics.sqliteWorkerStatus = sqliteStatus.isActiveWorker
        ? "active"
        : "inactive";
      diagnostics.vfsType = sqliteStatus.vfsType || "unknown";
      diagnostics.workerId = sqliteStatus.workerId || "unknown";
    });
  });

  async function runDatabaseTest() {
    isLoading = true;
    diagnostics.testError = null;
    diagnostics.testResult = null;

    try {
      const result = await backend.runQuery({ sql: "SELECT 1 as test" });
      diagnostics.testResult = result;
    } catch (error) {
      diagnostics.testError =
        error instanceof Error ? error.message : String(error);
    } finally {
      isLoading = false;
    }
  }

  async function pingBackend() {
    isLoading = true;
    diagnostics.testError = null;
    diagnostics.testResult = null;

    try {
      const result = await backend.ping();
      diagnostics.testResult = result;
    } catch (error) {
      diagnostics.testError =
        error instanceof Error ? error.message : String(error);
    } finally {
      isLoading = false;
    }
  }

  function getStatusIcon(value: boolean): string {
    return value ? "✅" : "❌";
  }

  function getVfsRecommendation(vfsType: string): string {
    switch (vfsType) {
      case "opfs-sahpool":
        return "Using best-performance VFS (OpfsSAHPoolVfs)";
      case "opfs":
        return "Using fallback VFS (regular OPFS) - slightly slower but more compatible";
      case "unknown":
        return "VFS not yet initialized - check console for errors";
      default:
        return "Unknown VFS type";
    }
  }
</script>

<div class="container mx-auto p-6 max-w-4xl">
  <h1 class="text-3xl font-bold mb-6">SQLite VFS Diagnostics</h1>

  <div class="space-y-6">
    <!-- Cross-Origin Isolation Status -->
    <section class="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
      <h2 class="text-xl font-semibold mb-4">Cross-Origin Isolation</h2>
      <div class="space-y-2">
        <div class="flex items-center gap-2">
          <span class="text-2xl"
            >{getStatusIcon(diagnostics.crossOriginIsolated)}</span
          >
          <span class="font-medium">Cross-Origin Isolated:</span>
          <code class="bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded"
            >{diagnostics.crossOriginIsolated}</code
          >
        </div>
        <div class="flex items-center gap-2">
          <span class="text-2xl"
            >{getStatusIcon(diagnostics.sharedArrayBufferAvailable)}</span
          >
          <span class="font-medium">SharedArrayBuffer Available:</span>
          <code class="bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded"
            >{diagnostics.sharedArrayBufferAvailable}</code
          >
        </div>
        <div class="flex items-center gap-2">
          <span class="text-2xl"
            >{getStatusIcon(diagnostics.opfsAvailable)}</span
          >
          <span class="font-medium">OPFS API Available:</span>
          <code class="bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded"
            >{diagnostics.opfsAvailable}</code
          >
        </div>
      </div>

      {#if !diagnostics.crossOriginIsolated}
        <div
          class="mt-4 p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded"
        >
          <p class="text-sm text-yellow-800 dark:text-yellow-200">
            ⚠️ Cross-origin isolation is not active. The regular OPFS VFS will
            not be available as a fallback. Only OpfsSAHPoolVfs can be used.
          </p>
        </div>
      {/if}
    </section>

    <!-- VFS Status -->
    <section class="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
      <h2 class="text-xl font-semibold mb-4">VFS Status</h2>
      <div class="space-y-2">
        <div class="flex items-center gap-2">
          <span class="text-2xl"
            >{getStatusIcon(diagnostics.sqliteWorkerStatus === "active")}</span
          >
          <span class="font-medium">SQLite Worker Status:</span>
          <code
            class="px-2 py-1 rounded"
            class:bg-green-100={diagnostics.sqliteWorkerStatus === "active"}
            class:dark:bg-green-900={diagnostics.sqliteWorkerStatus ===
              "active"}
            class:bg-red-100={diagnostics.sqliteWorkerStatus === "inactive"}
            class:dark:bg-red-900={diagnostics.sqliteWorkerStatus ===
              "inactive"}
            class:bg-gray-100={diagnostics.sqliteWorkerStatus === "unknown"}
            class:dark:bg-gray-700={diagnostics.sqliteWorkerStatus ===
              "unknown"}
          >
            {diagnostics.sqliteWorkerStatus}
          </code>
        </div>
        <div class="flex items-center gap-2">
          <span class="font-medium">VFS Type:</span>
          <code
            class="px-2 py-1 rounded"
            class:bg-blue-100={diagnostics.vfsType === "opfs-sahpool"}
            class:dark:bg-blue-900={diagnostics.vfsType === "opfs-sahpool"}
            class:bg-purple-100={diagnostics.vfsType === "opfs"}
            class:dark:bg-purple-900={diagnostics.vfsType === "opfs"}
            class:bg-gray-100={diagnostics.vfsType === "unknown"}
            class:dark:bg-gray-700={diagnostics.vfsType === "unknown"}
          >
            {diagnostics.vfsType}
          </code>
        </div>
        <div class="flex items-center gap-2">
          <span class="font-medium">Worker ID:</span>
          <code class="bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded text-xs">
            {diagnostics.workerId}
          </code>
        </div>
      </div>

      <div
        class="mt-4 p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded"
      >
        <p class="text-sm text-blue-800 dark:text-blue-200">
          ℹ️ {getVfsRecommendation(diagnostics.vfsType)}
        </p>
      </div>
    </section>

    <!-- Backend Status -->
    <section class="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
      <h2 class="text-xl font-semibold mb-4">Backend Worker Status</h2>
      <div class="space-y-2">
        <div class="flex items-center gap-2">
          <span class="text-2xl"
            >{getStatusIcon(!!backendStatus.workerRunning)}</span
          >
          <span class="font-medium">Worker Running:</span>
          <code class="bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded"
            >{backendStatus.workerRunning ?? "unknown"}</code
          >
        </div>
        <div class="flex items-center gap-2">
          <span class="text-2xl"
            >{getStatusIcon(!!backendStatus.authLoaded)}</span
          >
          <span class="font-medium">Auth Loaded:</span>
          <code class="bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded"
            >{backendStatus.authLoaded ?? "unknown"}</code
          >
        </div>
        <div class="flex items-center gap-2">
          <span class="text-2xl"
            >{getStatusIcon(!!backendStatus.leafConnected)}</span
          >
          <span class="font-medium">Leaf Connected:</span>
          <code class="bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded"
            >{backendStatus.leafConnected ?? "unknown"}</code
          >
        </div>
      </div>
    </section>

    <!-- Database Tests -->
    <section class="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
      <h2 class="text-xl font-semibold mb-4">Database Tests</h2>

      <div class="flex gap-4 mb-4">
        <button
          onclick={runDatabaseTest}
          disabled={isLoading}
          class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
        >
          {isLoading ? "Running..." : "Test Database Query"}
        </button>

        <button
          onclick={pingBackend}
          disabled={isLoading}
          class="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
        >
          {isLoading ? "Running..." : "Ping Backend"}
        </button>
      </div>

      {#if diagnostics.testResult}
        <div
          class="p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded"
        >
          <p class="font-medium text-green-800 dark:text-green-200 mb-2">
            ✓ Test Successful
          </p>
          <pre
            class="text-xs bg-gray-100 dark:bg-gray-700 p-2 rounded overflow-x-auto">{JSON.stringify(
              diagnostics.testResult,
              null,
              2,
            )}</pre>
        </div>
      {/if}

      {#if diagnostics.testError}
        <div
          class="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded"
        >
          <p class="font-medium text-red-800 dark:text-red-200 mb-2">
            ✗ Test Failed
          </p>
          <pre
            class="text-xs bg-gray-100 dark:bg-gray-700 p-2 rounded overflow-x-auto">{diagnostics.testError}</pre>
        </div>
      {/if}
    </section>

    <!-- Browser Info -->
    <section class="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
      <h2 class="text-xl font-semibold mb-4">Browser Information</h2>
      <pre
        class="text-xs bg-gray-100 dark:bg-gray-700 p-4 rounded overflow-x-auto">{diagnostics.browserInfo}</pre>
    </section>

    <!-- Documentation Links -->
    <section class="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
      <h2 class="text-xl font-semibold mb-4">Documentation</h2>
      <ul class="space-y-2 text-sm">
        <li>
          <a
            href="https://sqlite.org/wasm/doc/trunk/persistence.md"
            target="_blank"
            rel="noopener noreferrer"
            class="text-blue-600 dark:text-blue-400 hover:underline"
          >
            SQLite WASM Persistence Documentation
          </a>
        </li>
        <li>
          <a
            href="https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system"
            target="_blank"
            rel="noopener noreferrer"
            class="text-blue-600 dark:text-blue-400 hover:underline"
          >
            MDN: Origin Private File System (OPFS)
          </a>
        </li>
        <li>
          <a
            href="https://developer.mozilla.org/en-US/docs/Web/API/crossOriginIsolated"
            target="_blank"
            rel="noopener noreferrer"
            class="text-blue-600 dark:text-blue-400 hover:underline"
          >
            MDN: Cross-Origin Isolation
          </a>
        </li>
      </ul>
    </section>
  </div>
</div>
