<script lang="ts">
  import { page } from "$app/state";
  // import { user } from "$lib/user.svelte";
  import { Button } from "@fuxui/base";
  import { Space } from "@roomy-chat/sdk";
  import { CoState } from "jazz-tools/svelte";
  import toast from "svelte-french-toast";

  let space = $derived(new CoState(Space, page.params.space));
  let spaceName = $derived(space.current?.name ?? "");
  let spaceDescription = $derived(space.current?.description ?? "");

  let fileList = $state<File[]>([]);
  let tweetsJs = $derived(
    fileList.find((file) => file.webkitRelativePath.includes("tweets.js")),
  );
  let tweetsPart1js = $derived(
    fileList.find((file) =>
      file.webkitRelativePath.includes("tweets-part1.js"),
    ),
  );

  let mediaFiles = $derived(
    fileList.filter((file) =>
      file.webkitRelativePath.includes("/tweets_media/"),
    ),
  );
  let fileInput = $state<HTMLInputElement | null>(null);
  let logs = $state<string[]>([]);
  let pending: string[] = [];
  let scheduled = false;

  export function pushLog(log: string) {
    pending.push(log);

    if (!scheduled) {
      scheduled = true;

      queueMicrotask(() => {
        logs = [...logs, ...pending];
        pending = [];
        scheduled = false;
      });
    }
  }

  // let avatarFile = $state<File | null>(null);

  let isSaving = $state(false);

  let hasChanged = $derived(
    spaceName != space.current?.name ||
      spaceDescription != space.current?.description,
  );

  function resetData() {
    spaceName = space.current?.name ?? "";
    // avatarFile = null;
  }

  async function save() {
    if (!space.current) return;
    isSaving = true;

    let currentSpaceName = spaceName;
    let currentSpaceDescription = spaceDescription;

    // if (avatarFile) {
    //   await uploadAvatar();
    // }

    space.current.name = currentSpaceName;
    space.current.description = currentSpaceDescription;
    isSaving = false;

    toast.success("Space updated successfully", {
      position: "bottom-right",
    });
  }

  async function handleFolderSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      console.log(input.files);
      fileList = Array.from(input.files ?? []);
    }
  }

  $effect(() => {
    if (tweetsJs) {
      tweetsJs.text().then((text) => {
        const newText = text.replace("window.YTD.tweets.part0 = ", "");
        const tweets = JSON.parse(newText);
        console.log(tweets);
        pushLog("tweets.js parsed, found " + tweets.length + " tweets");
      });
    }

    if (tweetsPart1js) {
      tweetsPart1js.text().then((text) => {
        const newText = text.replace("window.YTD.tweets.part1 = ", "");
        const tweets = JSON.parse(newText);
        console.log(tweets);
        pushLog("tweets-part1.js parsed, found " + tweets.length + " tweets");
      });
    }
  });

  $effect(() => {
    if (mediaFiles.length > 0) {
      pushLog("Media files found, " + mediaFiles.length + " files");
    }
  });

  // async function uploadAvatar() {
  //   if (!avatarFile || !user.agent || !space.current) return;

  //   try {
  //     // Upload the image using the user's agent
  //     const uploadResult = await user.uploadBlob(avatarFile);

  //     space.current.imageUrl = uploadResult.url;
  //   } catch (error) {
  //     console.error("Error uploading avatar:", error);
  //     toast.error("Failed to upload avatar", {
  //       position: "bottom-right",
  //     });
  //   } finally {
  //     avatarFile = null;
  //   }
  // }
</script>

<form class="pt-4 h-full">
  <div class="space-y-12">
    <h2 class="text-base/7 font-semibold text-base-900 dark:text-base-100">
      Twitter Import
    </h2>

    <p>
      To import your Twitter data, please download your data from X/Twitter and
      select the uncompressed folder containing the data.
    </p>

    <div class="mt-10 grid grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-6">
      <div class="col-span-full">
        <label
          for="photo"
          class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
          >Select Twitter Export Folder</label
        >
        <div class="mt-2 flex items-center gap-x-3">
          <input
            type="file"
            webkitdirectory
            multiple
            class="hidden"
            onchange={handleFolderSelect}
            bind:this={fileInput}
          />
          <Button variant="secondary" onclick={() => fileInput?.click()}
            >Select Folder</Button
          >
        </div>

        <div class="mt-2">
          {#each logs as log}
            <div>{log}</div>
          {/each}
        </div>
      </div>
    </div>

    <div class="mt-6 flex items-center justify-end gap-x-6">
      <div>
        <Button
          type="button"
          variant="ghost"
          disabled={!hasChanged}
          onclick={resetData}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={!hasChanged || isSaving} onclick={save}>
          {#if isSaving}
            Saving...
          {:else}
            Save
          {/if}
        </Button>
      </div>
    </div>
  </div>
</form>
