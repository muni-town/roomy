<script lang="ts">
  import { Modal, toast } from "@foxui/core";
  import Button from "@roomy/design/components/ui/button/Button.svelte";

  let {
    open = $bindable(false),
    did,
  }: {
    open: boolean;
    /** The space's account DID — what the DNS record must point at. */
    did: string;
  } = $props();

  const recordValue = $derived(`did=${did}`);

  async function copyRecordValue() {
    try {
      await navigator.clipboard.writeText(recordValue);
      toast.success("Copied to clipboard", { position: "bottom-right" });
    } catch {
      // Clipboard may not be available in all contexts.
    }
  }
</script>

<Modal bind:open class="gap-5">
  <div class="flex flex-col gap-3">
    <h1
      id="dialog-title"
      class="text-base font-bold text-xl text-base-900 dark:text-base-100"
    >
      Setting Up a Custom Handle
    </h1>
    <p class="text-sm text-base-800 dark:text-base-300">
      You can use your own web domain as a handle for your Roomy space by adding
      a new record to your domain's DNS configuration. You need to go to your
      DNS provider and create a new DNS record with the following settings, then
      come back and set the handle in Roomy. Replace
      <code>name.example.com</code> with your domain:</p>

    <div
      class="flex flex-col gap-1.5 rounded-xl bg-base-100 dark:bg-base-900 p-3 text-xs font-mono text-base-900 dark:text-base-100"
    >
      <div class="flex gap-3">
        <span class="w-10 shrink-0 text-base-500 dark:text-base-400">Type</span>
        <span>TXT</span>
      </div>
      <div class="flex gap-3">
        <span class="w-10 shrink-0 text-base-500 dark:text-base-400">Name</span>
        <span class="break-all">_atproto.name.example.com</span>
      </div>
      <div class="flex items-start gap-3">
        <span class="w-10 shrink-0 text-base-500 dark:text-base-400"
          >Value</span
        >
        <span class="break-all">{recordValue}</span>
        <Button
          variant="secondary"
          size="sm"
          class="ml-auto shrink-0"
          onclick={copyRecordValue}
        >
          Copy
        </Button>
      </div>
    </div>

    <p class="text-sm text-base-500 dark:text-base-400">
      <b>Note:</b> if saving the handle doesn't work right away, the record may
      not have finished propagating yet — DNS changes can take a few minutes to
      a few hours to become visible. Wait a little while, then try again.
    </p>
  </div>
  <div class="flex w-full justify-end">
    <Button variant="primary" onclick={() => (open = false)}>Got it</Button>
  </div>
</Modal>