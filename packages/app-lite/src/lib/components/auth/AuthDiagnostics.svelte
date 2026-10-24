<!--
  What the last launch found, for the sign-in and error screens.

  A shell has no log a tester can read: the logging plugin is debug-only and
  Faro needs a build-time collector URL the iOS build does not set. So the SDK
  keeps these facts in the shell's own store, and this renders them next to the
  screen the tester is already looking at. Copy puts the whole record and the
  user agent on the clipboard to paste into a report.

  Nothing here identifies the account: the record is the three facts and their
  timestamp, by construction (`NativeAuthDiagnostic`).
-->
<script lang="ts">
  import { onMount } from "svelte";
  import {
    readAuthDiagnostic,
    type NativeAuthDiagnostic,
  } from "@roomy-space/sdk/browser";
  import { openNativeSessionStore } from "$lib/cache-store";

  let diagnostic = $state<NativeAuthDiagnostic | null>(null);
  let copied = $state<"idle" | "copied" | "failed">("idle");

  onMount(async () => {
    diagnostic = await readAuthDiagnostic(await openNativeSessionStore());
  });

  function line(record: NativeAuthDiagnostic): string {
    const error = record.initError ? `error ${record.initError}` : "no error";
    return `Last launch ${record.at}: session ${record.session ? "restored" : "not restored"} · native copy ${record.nativeSnapshot ? "present" : "absent"} · ${error}`;
  }

  function detail(record: NativeAuthDiagnostic): string {
    return [
      "Roomy startup diagnostics",
      `time: ${record.at}`,
      `session restored: ${record.session ? "yes" : "no"}`,
      `native session copy: ${record.nativeSnapshot ? "present" : "absent"}`,
      `init error: ${record.initError ?? "none"}`,
      `user agent: ${navigator.userAgent}`,
    ].join("\n");
  }

  /** `navigator.clipboard` is unavailable in some webviews; the textarea is the fallback. */
  function legacyCopy(text: string): boolean {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }

  async function copy() {
    if (!diagnostic) return;
    const text = detail(diagnostic);
    try {
      await navigator.clipboard.writeText(text);
      copied = "copied";
    } catch {
      copied = legacyCopy(text) ? "copied" : "failed";
    }
  }
</script>

{#if diagnostic}
  <div
    class="mt-3 flex items-start gap-2 border-t border-base-200 dark:border-base-800 pt-2 text-[11px] leading-snug text-base-500 dark:text-base-400"
  >
    <span class="min-w-0 break-words">{line(diagnostic)}</span>
    <button
      type="button"
      class="shrink-0 underline underline-offset-2 hover:text-black hover:dark:text-white"
      onclick={copy}
    >
      {copied === "copied" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy"}
    </button>
  </div>
{/if}
