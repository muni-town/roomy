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
  import { getContentHtml, type Item } from "$lib/tiptap/editor";
  import { Announcement, Message } from "@roomy-chat/sdk";
  import { g } from "$lib/global.svelte";
  import { derivePromise } from "$lib/utils.svelte";
  import type { JSONContent } from "@tiptap/core";
  import ChatInput from "./ChatInput.svelte";
  import toast from "svelte-french-toast";

  type Props = {
    message: Message;
  };

  let { message }: Props = $props();

  let relatedThreads = derivePromise([], async () => {
    if (message instanceof Announcement) {
      return await message.relatedThreads.items();
    }
    return [];
  });

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

  function isMessageEdited(msg: Message): boolean {
    // @ts-ignore - Check for custom property
    return !!msg.updatedDate;
  }

  function getEditedTime(msg: Message): string {
    // @ts-ignore - Access custom property
    if (msg.updatedDate) {
      // @ts-ignore - Access custom property
      return format(msg.updatedDate, "PPpp");
    }
    return "";
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

  function getAnnouncementHtml(announcement: Announcement) {
    if (!g.space) return "";
    const schema = {
      type: "doc",
      content: [] as Record<string, unknown>[],
    } satisfies JSONContent;

    switch (announcement.kind) {
      case "threadCreated": {
        schema.content.push({
          type: "paragraph",
          content: [
            { type: "text", text: "A new thread has been created: " },
            {
              type: "channelThreadMention",
              attrs: {
                id: JSON.stringify({
                  id: relatedThreads.value[0]?.id,
                  space: g.space.id,
                  type: "thread",
                }),
                label: relatedThreads.value[0]?.name || "loading...",
              },
            },
          ],
        });
        break;
      }
      case "messageMoved": {
        schema.content.push({
          type: "paragraph",
          content: [
            { type: "text", text: "Moved to: " },
            {
              type: "channelThreadMention",
              attrs: {
                id: JSON.stringify({
                  id: relatedThreads.value[0]?.id,
                  space: g.space.id,
                  type: "thread",
                }),
                label: relatedThreads.value[0]?.name || "loading...",
              },
            },
          ],
        });
        break;
      }
      case "messageDeleted": {
        schema.content.push({
          type: "paragraph",
          content: [{ type: "text", text: "This message has been deleted" }],
        });
        break;
      }
    }

    return getContentHtml(schema);
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
</script>

<svelte:window onkeydown={onKeydown} onkeyup={onKeyup} />

<div id={message.id} class={`flex flex-col ${isMobile && "max-w-screen"}`}>
  <div
    class={`relative group w-full h-fit flex flex-col gap-2 px-2 py-2 hover:bg-white/5`}
  >
    {@render messageView(message)}

    {#if Object.keys(message.reactions.all()).length > 0}
      <div class="flex gap-2 flex-wrap pl-14">
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

{#snippet messageView(msg: Message)}
  <!-- doesn't change after render, so $derived is not necessary -->
  {@const authorProfile = getProfile(msg.authors((x) => x.get(0)))}

  {#await authorProfile then authorProfile}
    {@render toolbar(authorProfile)}

    <div class="flex gap-4 group">
      <a
        href={`https://bsky.app/profile/${authorProfile.handle}`}
        title={authorProfile.handle}
        target="_blank"
      >
        <AvatarImage
          handle={authorProfile.handle}
          avatarUrl={authorProfile.avatarUrl}
        />
      </a>

      {#if isEditing && message === msg}
        <div class="flex flex-col w-full gap-2">
          <section class="flex items-center gap-2 flex-wrap w-fit">
            <a
              href={`https://bsky.app/profile/${authorProfile.handle}`}
              target="_blank"
              class="text-primary hover:underline"
            >
              <h5 class="font-bold" title={authorProfile.handle}>
                {authorProfile.displayName || authorProfile.handle}
              </h5>
            </a>
            {@render timestamp(message.createdDate || new Date())}
          </section>

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
          <section class="flex items-center gap-2 flex-wrap w-fit">
            <a
              href={`https://bsky.app/profile/${authorProfile.handle}`}
              target="_blank"
              class="text-primary hover:underline"
            >
              <h5 class="font-bold" title={authorProfile.handle}>
                {authorProfile.displayName || authorProfile.handle}
              </h5>
            </a>
            {@render timestamp(message.createdDate || new Date())}
          </section>

          <div class="flex flex-col gap-1">
            <!-- Using a fancy Tailwind trick to target all href elements inside of this parent -->
            <span
              class="dz-prose select-text [&_a]:text-primary [&_a]:hover:underline"
            >
              {@html getContentHtml(JSON.parse(msg.bodyJson))}
            </span>

            {#if isMessageEdited(msg)}
              <div class="relative group/edit">
                <span
                  class="text-xs text-gray-400 italic flex items-center gap-1 hover:text-gray-300 cursor-default"
                >
                  <Icon icon="mdi:pencil" width="12px" height="12px" />
                  <span>edited</span>
                </span>

                <!-- Tooltip that appears on hover -->
                <div
                  class="absolute bottom-full left-0 mb-2 opacity-0 group-hover/edit:opacity-100 transition-opacity duration-200 bg-base-300 p-3 rounded shadow-lg text-xs z-10 min-w-[200px]"
                >
                  <div class="flex flex-col gap-1">
                    <p class="font-semibold">Message edited</p>
                    <p>
                      Original: {format(msg.createdDate || new Date(), "PPpp")}
                    </p>
                    <p>Edited: {getEditedTime(msg)}</p>
                  </div>

                  <!-- Arrow pointing down -->
                  <div
                    class="absolute -bottom-1 left-3 w-2 h-2 bg-base-300 rotate-45"
                  ></div>
                </div>
              </div>
            {/if}
          </div>
        </Button.Root>
      {/if}
    </div>
  {/await}
{/snippet}

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

{#snippet timestamp(date: Date)}
  {@const formattedDate = isToday(date) ? "Today" : format(date, "P")}
  <time class="text-xs">
    {formattedDate}, {format(date, "pp")}
  </time>
{/snippet}
