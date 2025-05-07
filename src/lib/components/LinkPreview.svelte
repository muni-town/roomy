<script lang="ts">
  import { Button, Popover, Toolbar } from "bits-ui";
  import { format, isToday } from "date-fns";
  import { getContext } from "svelte";
  import { getProfile } from "$lib/profile.svelte";
  import Icon from "@iconify/svelte";
  import { user } from "$lib/user.svelte";
  import "emoji-picker-element";
  import { outerWidth } from "svelte/reactivity/window";
  import Drawer from "./Drawer.svelte";
  import AvatarImage from "./AvatarImage.svelte";
  import { type Item } from "$lib/tiptap/editor";
  import { Message } from "@roomy-chat/sdk";
  import { g } from "$lib/global.svelte";
  import type { JSONContent } from "@tiptap/core";
  import ChatInput from "./ChatInput.svelte";
  import toast from "svelte-french-toast";
  import LinkCard from "./LinkCard.svelte";
  import { collectLinks, tiptapJsontoString } from "$lib/utils/collectLinks";

  type Props = {
    message: Message;
  };

  let { message }: Props = $props();

  const getLinkData = async (url: string) => {
    try {
      const res = await fetch(`/api/link-preview?url=${url}`);
      if (res.ok) {
        const data = await res.json();
        return data;
      }
    } catch (e) {
      console.warn(e);
    }
  };
  const links = $derived(
    (collectLinks(tiptapJsontoString(message.bodyJson)) || []).map((url) => {
      const value = $state({
        url: url.replace("http:", "https:"),
        data: undefined,
      });
      getLinkData(url).then((data) => {
        value.data = data;
      });
      return value;
    }),
  );

  let isMobile = $derived((outerWidth.current ?? 0) < 640);
  let isDrawerOpen = $state(false);

  let users: { value: Item[] } = getContext("users");
  let contextItems: { value: Item[] } = getContext("contextItems");

  let emojiDrawerPicker: (HTMLElement & any) | undefined = $state();
  let emojiToolbarPicker: (HTMLElement & any) | undefined = $state();
  let emojiRowPicker: (HTMLElement & any) | undefined = $state();
  let isEmojiDrawerPickerOpen = $state(false);
  let isEmojiToolbarPickerOpen = $state(false);
  let isEmojiRowPickerOpen = $state(false);

  // Editing state
  let isEditing = $state(false);
  let editMessageContent: JSONContent = $state({});

  let mayDelete = $derived(
    message.matches(Message) &&
      (g.isAdmin ||
        (user.agent &&
          message
            .forceCast(Message)
            .authors((x) => x.toArray().includes(user.agent!.assertDid)))),
  );

  let mayEdit = $derived(
    message.matches(Message) &&
      user.agent &&
      message
        .forceCast(Message)
        .authors((x) => x.toArray())
        .includes(user.agent?.assertDid),
  );

  function deleteMessage() {
    message.softDeleted = true;
    message.commit();
  }

  function startEditing() {
    if (message instanceof Message) {
      isEmojiToolbarPickerOpen = false;

      try {
        // Parse the message body JSON to get a plain object
        const parsedContent = JSON.parse(message.bodyJson) as JSONContent;

        // Create a deep copy to ensure we're not working with a Proxy object
        // This keeps all content including images intact
        editMessageContent = JSON.parse(
          JSON.stringify(parsedContent),
        ) as JSONContent;

        isEditing = true;
      } catch (error) {
        console.error("Error starting message edit:", error);
        toast.error("Failed to edit message", { position: "bottom-end" });
      }
    }
  }

  function saveEditedMessage() {
    if (
      message instanceof Message &&
      Object.keys(editMessageContent).length > 0
    ) {
      try {
        // Ensure we're working with a plain object, not a Proxy
        const plainContent = JSON.parse(
          JSON.stringify(editMessageContent),
        ) as JSONContent;

        // Update the message
        message.bodyJson = JSON.stringify(plainContent);

        let messageJSON = JSON.parse(message.bodyJson) as JSONContent;

        messageJSON.content = (messageJSON.content ?? []).map((block) => {
          if (block.type === "paragraph" && Array.isArray(block.content)) {
            let foundText = false;
            block.content = block.content.filter((inline) => {
              if (inline.type === "hardBreak" && !foundText) {
                return false; // remove leading hardBreaks
              }

              if (inline.type === "text") {
                inline.text = (inline?.text ?? "").replace(/^\s+/, ""); // remove leading spaces
                if (inline.text.trim() === "") {
                  return false; // remove text node if it's empty or all spaces
                }
                foundText = true;
              }

              return true;
            });
          }
          return block;
        });

        // If message is empty, don't save it
        if (
          messageJSON.content[0]?.content?.length === 0 ||
          !messageJSON.content[0]?.content
        ) {
          return;
        }
        message.bodyJson = JSON.stringify(messageJSON);

        // Add an updatedDate field to track edits
        // @ts-ignore - Adding custom property for edit tracking
        message.updatedDate = new Date();

        message.commit();
        isEditing = false;
        toast.success("Message updated", { position: "bottom-end" });
      } catch (error) {
        console.error("Error saving edited message:", error);
        toast.error("Failed to save message", { position: "bottom-end" });
      }
    }
  }

  function cancelEditing() {
    isEditing = false;
    editMessageContent = {};
  }

  function onEmojiPick(event: Event & { detail: { unicode: string } }) {
    if (!user.agent) return;
    message.reactions.toggle(event.detail.unicode, user.agent.assertDid);
    message.commit();
    isEmojiToolbarPickerOpen = false;
    isEmojiRowPickerOpen = false;
  }

  function toggleReaction(reaction: string) {
    if (!user.agent) return;
    message.reactions.toggle(reaction, user.agent.assertDid);
    message.commit();
  }

  $effect(() => {
    if (emojiToolbarPicker) {
      emojiToolbarPicker.addEventListener("emoji-click", onEmojiPick);
    }
    if (emojiDrawerPicker) {
      emojiDrawerPicker.addEventListener(
        "emoji-click",
        (e: Event & { detail: { unicode: string } }) => {
          onEmojiPick(e);
          isEmojiDrawerPickerOpen = false;
          isDrawerOpen = false;
        },
      );
    }
    if (emojiRowPicker) {
      emojiRowPicker.addEventListener("emoji-click", onEmojiPick);
    }
  });

  let shiftDown = $state(false);
  function onKeydown({ shiftKey }: KeyboardEvent) {
    shiftDown = shiftKey;
  }
  function onKeyup({ shiftKey }: KeyboardEvent) {
    shiftDown = shiftKey;
  }

  function getPlainTextContent(content: JSONContent): string {
    try {
      if (!content) return "Edit message...";

      // Extract text from content
      let text = "";

      // Handle direct text content
      if (content.text) {
        text += content.text;
      }

      // Recursively extract text from content array
      if (content.content && Array.isArray(content.content)) {
        for (const node of content.content) {
          if (node.text) {
            text += `${node.text} `;
          } else if (node.content) {
            text += `${getPlainTextContent(node)} `;
          }
        }
      }

      return text.trim() || "Edit message...";
    } catch (error) {
      console.error("Error extracting plain text:", error);
      return "Edit message...";
    }
  }
  // doesn't change after render, so $derived is not necessary
  const authorProfile = getProfile(message.authors((x) => x.get(0)));
  const date = message.createdDate || new Date();
  const formattedDate = isToday(date) ? "Today" : format(date, "P");
</script>

<svelte:window onkeydown={onKeydown} onkeyup={onKeyup} />

<div id={message.id} class={`flex flex-col ${isMobile && "max-w-screen"}`}>
  <div
    class={`relative group w-full h-fit flex flex-col gap-2 px-2 py-2 hover:bg-white/5`}
  >
    {#await authorProfile then authorProfile}
      {@render toolbar(authorProfile)}
    {/await}
    <div class="flex gap-4 group">
      <div class="flex flex-col w-full gap-2">
        <section class="flex items-center gap-2 flex-wrap w-fit">
          {#await authorProfile}
            l
          {:then authorProfile}
            <a
              href={`https://bsky.app/profile/${authorProfile.handle}`}
              title={authorProfile.handle}
              target="_blank"
              class="text-primary hover:underline flex gap-2 items-center"
            >
              <AvatarImage
                handle={authorProfile.handle}
                avatarUrl={authorProfile.avatarUrl}
                className="max-w-5"
              />
              <span class="font-bold" title={authorProfile.handle}>
                {authorProfile.displayName || authorProfile.handle}
              </span>
            </a>
          {/await}
          <time class="text-xs">
            {formattedDate}, {format(date, "pp")}
          </time>
        </section>

        {#if isEditing}
          <div class="w-full">
            <ChatInput
              bind:content={editMessageContent}
              users={users.value || []}
              context={contextItems.value || []}
              onEnter={saveEditedMessage}
              placeholder={message instanceof Message
                ? getPlainTextContent(JSON.parse(message.bodyJson))
                : "Edit message..."}
              editMode={true}
            />
          </div>

          <div class="flex justify-end gap-2 mt-2">
            <Button.Root onclick={cancelEditing} class="btn btn-sm btn-ghost">
              Cancel
            </Button.Root>
            <Button.Root
              onclick={saveEditedMessage}
              class="btn btn-sm btn-primary"
            >
              Save
            </Button.Root>
          </div>
        {:else}
          <Button.Root
            onclick={() => {
              if (isMobile) {
                isDrawerOpen = true;
              }
            }}
            class="flex flex-col text-start gap-2 w-full min-w-0"
          >
            <div
              class="flex flex-col gap-1 dz-prose select-text [&_a]:text-primary [&_a]:hover:underline"
            >
              {#each links as { url, data } (url)}
                {#if data}
                  <LinkCard {data} {url} />
                {:else}
                  <a href={url}>{url}</a>
                {/if}
              {/each}
            </div>
          </Button.Root>
        {/if}
      </div>
    </div>

    {#if Object.keys(message.reactions.all()).length > 0}
      <div class="flex gap-2 flex-wrap">
        {#each Object.keys(message.reactions.all()) as reaction}
          {@const reactions = message.reactions.all()[reaction]}
          {#if reactions}
            {#await Promise.all([...reactions.values()].map( (x) => getProfile(x), )) then profilesThatReacted}
              <Button.Root
                onclick={() => toggleReaction(reaction)}
                class={`
              dz-btn
              ${user.agent && reactions.has(user.agent.assertDid) ? "bg-secondary text-secondary-content" : "bg-secondary/30 hover:bg-secondary/50 text-base-content"}
            `}
                title={profilesThatReacted
                  .map((x) => x.displayName || x.handle)
                  .join(", ")}
              >
                {reaction}
                {message.reactions.all()[reaction]?.size}
              </Button.Root>
            {/await}
          {/if}
        {/each}
        <Popover.Root bind:open={isEmojiRowPickerOpen}>
          <Popover.Trigger class="p-2 hover:bg-white/5 rounded cursor-pointer">
            <Icon icon="lucide:smile-plus" class="text-primary" />
          </Popover.Trigger>
          <Popover.Content class="z-10">
            <emoji-picker bind:this={emojiRowPicker}></emoji-picker>
          </Popover.Content>
        </Popover.Root>
      </div>
    {/if}
  </div>
</div>

{#snippet toolbar(authorProfile?: { handle: string; avatarUrl: string })}
  {#if !g.isBanned}
    {#if isMobile}
      <Drawer bind:isDrawerOpen>
        <div class="flex gap-4 justify-center mb-4">
          <Button.Root
            onclick={() => {
              toggleReaction("👍");
              isDrawerOpen = false;
            }}
            class="dz-btn dz-btn-circle"
          >
            👍
          </Button.Root>
          <Button.Root
            onclick={() => {
              toggleReaction("😂");
              isDrawerOpen = false;
            }}
            class="dz-btn dz-btn-circle"
          >
            😂
          </Button.Root>
          <Popover.Root bind:open={isEmojiDrawerPickerOpen}>
            <Popover.Trigger class="dz-btn dz-btn-circle">
              <Icon icon="lucide:smile-plus" />
            </Popover.Trigger>
            <Popover.Content class="z-10">
              <emoji-picker bind:this={emojiDrawerPicker}></emoji-picker>
            </Popover.Content>
          </Popover.Root>
        </div>

        {#if authorProfile}
          <div class="dz-join dz-join-vertical w-full">
            {#if mayEdit}
              <Button.Root
                onclick={() => {
                  startEditing();
                  isDrawerOpen = false;
                }}
                class="dz-join-item dz-btn w-full"
              >
                <Icon icon="tabler:edit" />
                Edit
              </Button.Root>
            {/if}
            {#if mayDelete}
              <Button.Root
                onclick={() => deleteMessage()}
                class="dz-join-item dz-btn dz-btn-error w-full"
              >
                <Icon icon="tabler:trash" />
                Delete
              </Button.Root>
            {/if}
          </div>
        {/if}
      </Drawer>
    {:else if !isEditing}
      <Toolbar.Root
        class={`${!isEmojiToolbarPickerOpen && "hidden"} group-hover:flex absolute -top-2 right-0 bg-base-300 p-1 rounded items-center`}
      >
        <Toolbar.Button
          onclick={() => toggleReaction("👍")}
          class="dz-btn dz-btn-ghost dz-btn-square"
        >
          👍
        </Toolbar.Button>
        <Toolbar.Button
          onclick={() => toggleReaction("😂")}
          class="dz-btn dz-btn-ghost dz-btn-square"
        >
          😂
        </Toolbar.Button>
        <Popover.Root bind:open={isEmojiToolbarPickerOpen}>
          <Popover.Trigger class="dz-btn dz-btn-ghost dz-btn-square">
            <Icon icon="lucide:smile-plus" />
          </Popover.Trigger>
          <Popover.Content class="z-10">
            <emoji-picker bind:this={emojiToolbarPicker}></emoji-picker>
          </Popover.Content>
        </Popover.Root>
        {#if mayEdit}
          <Toolbar.Button
            onclick={() => startEditing()}
            class="dz-btn dz-btn-ghost dz-btn-square"
          >
            <Icon icon="tabler:edit" />
          </Toolbar.Button>
        {/if}

        {#if shiftDown && mayDelete}
          <Toolbar.Button
            onclick={() => deleteMessage()}
            class="dz-btn dz-btn-ghost dz-btn-square"
          >
            <Icon icon="tabler:trash" color="red" />
          </Toolbar.Button>
        {/if}
      </Toolbar.Root>
    {/if}
  {/if}
{/snippet}
