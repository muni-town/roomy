<script lang="ts">
  import _ from "underscore";
  import { ulid } from "ulidx";
  import { page } from "$app/state";
  import { setContext } from "svelte";
  import { g } from "$lib/global.svelte";
  import { goto } from "$app/navigation";
  import toast from "svelte-french-toast";
  import { fly } from "svelte/transition";
  import { user } from "$lib/user.svelte";
  import { getContentHtml, type Item } from "$lib/tiptap/editor";
  import { outerWidth } from "svelte/reactivity/window";

  import Icon from "@iconify/svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import ChatArea from "$lib/components/ChatArea.svelte";
  import ThreadRow from "$lib/components/ThreadRow.svelte";
  import ChatInput from "$lib/components/ChatInput.svelte";
  import ChatMessage from "$lib/components/ChatMessage.svelte";
  import AvatarImage from "$lib/components/AvatarImage.svelte";
  import { Button, Popover, ScrollArea, Tabs, Toggle } from "bits-ui";

  import type {
    Did,
    Space,
    SpaceChannel,
    Thread,
    Ulid,
  } from "$lib/schemas/types";
  import type { Autodoc } from "$lib/autodoc/peer";
  import { getProfile } from "$lib/profile.svelte";

  import { onMount, onDestroy } from "svelte";
  import {
    BlockNoteEditor,
    type BlockNoteEditorOptions,
  } from "@blocknote/core";
  import "@blocknote/core/style.css";

  let isMobile = $derived((outerWidth.current ?? 0) < 640);

  let tab = $state("chat");
  let space: Autodoc<Space> | undefined = $derived(g.spaces[page.params.space]);
  let channel = $derived(space.view.channels[page.params.channel]) as
    | SpaceChannel
    | undefined;

  // TODO: track users via the space data
  let users = $state(() => {
    if (!space) {
      return [];
    }
    const result = new Set();
    for (const message of Object.entries(space.view.messages)) {
      result.add(message[1].author);
    }
    return result
      .values()
      .toArray()
      .map((author) => {
        const profile = getProfile(author as string);
        return { value: author, label: profile.handle, category: "user" };
      }) as Item[];
  });

  let contextItems: Item[] = $derived.by(() => {
    if (!space) {
      return [];
    }
    const items = [];

    // add threads to list
    items.push(
      ...Object.entries(space.view.threads).map(([ulid, thread]) => {
        return {
          value: JSON.stringify({
            ulid,
            space: page.params.space,
            type: "thread",
          }),
          label: thread.title,
          category: "thread",
        };
      }),
    );

    // add channels to list
    items.push(
      ...Object.entries(space.view.channels).map(([ulid, channel]) => {
        return {
          value: JSON.stringify({
            ulid,
            space: page.params.space,
            type: "channel",
          }),
          label: channel.name,
          category: "channel",
        };
      }),
    );

    return items as Item[];
  });

  $inspect({ users: users(), contextItems });

  let messageInput = $state({});
  let currentThread = $derived.by(() => {
    if (page.url.searchParams.has("thread")) {
      return space.view.threads[page.url.searchParams.get("thread")!] as Thread;
    } else {
      return null;
    }
  });

  let imageFiles: FileList | null = $state(null);

  $effect(() => {
    if (currentThread) {
      tab = "threads";
    }
  });

  // thread maker
  let isThreading = $state({ value: false });
  let threadTitleInput = $state("");
  let selectedMessages: Ulid[] = $state([]);
  setContext("isThreading", isThreading);
  setContext("selectMessage", (message: Ulid) => {
    selectedMessages.push(message);
  });
  setContext("removeSelectedMessage", (message: Ulid) => {
    selectedMessages = selectedMessages.filter((m) => m != message);
  });
  setContext("deleteMessage", (message: Ulid) => {
    space.change((doc) => {
      // TODO: don't remove from timeline, just delete ID? We need to eventually add a marker
      // showing the messages is deleted in the timeline.
      Object.values(doc.channels).forEach((x) => {
        const idx = x.timeline.indexOf(message);
        if (idx !== -1) x.timeline.splice(idx, 1);
      });
      Object.values(doc.threads).forEach((x) => {
        const idx = x.timeline.indexOf(message);
        if (idx !== -1) x.timeline.splice(idx, 1);
      });
      delete doc.messages[message];
    });
  });

  $effect(() => {
    if (!isThreading.value && selectedMessages.length > 0) {
      selectedMessages = [];
    }
  });

  // Reply Utils
  let replyingTo = $state<{
    id: Ulid;
    authorProfile: { handle: string; avatarUrl: string };
    content: string;
  } | null>();

  setContext(
    "setReplyTo",
    (value: {
      id: Ulid;
      authorProfile: { handle: string; avatarUrl: string };
      content: string;
    }) => {
      replyingTo = value;
    },
  );

  setContext("toggleReaction", (id: Ulid, reaction: string) => {
    if (!space) return;

    space.change((doc) => {
      const did = user.profile.data?.did;
      if (!did) return;

      let reactions = doc.messages[id].reactions[reaction] ?? [];

      if (reactions.includes(did)) {
        if (doc.messages[id].reactions[reaction].length - 1 === 0) {
          delete doc.messages[id].reactions[reaction];
        } else {
          doc.messages[id].reactions[reaction] = reactions.filter(
            (actor: Did) => actor !== did,
          );
        }
      } else {
        if (!doc.messages[id].reactions) {
          // init reactions object
          doc.messages[id].reactions = {};
        }
        doc.messages[id].reactions[reaction] = [...reactions, did];
      }
    });
  });

  function createThread(e: SubmitEvent) {
    e.preventDefault();
    if (!space) return;

    space.change((doc) => {
      const id = ulid();
      const timeline = [];
      for (const id of selectedMessages) {
        timeline.push(`${id}`);
      }
      doc.threads[id] = {
        title: threadTitleInput,
        timeline,
      };
    });

    threadTitleInput = "";
    isThreading.value = false;
    toast.success("Thread created", { position: "bottom-end" });
  }

  async function sendMessage() {
    if (!space) return;

    /* TODO: rework with tiptap?
    const images = imageFiles
      ? await Promise.all(
          Array.from(imageFiles).map(async (file) => {
            try {
              const resp = await user.uploadBlob(file);
              return {
                source: resp.url, // Use the blob reference from ATP
                alt: file.name,
              };
            } catch (error) {
              console.error("Failed to upload image:", error);
              toast.error("Failed to upload image", { position: "bottom-end" });
              return null;
            }
          }),
        ).then((results) =>
          results.filter(
            (result): result is NonNullable<typeof result> => result !== null,
          ),
        )
      : undefined;
    */

    space.change((doc) => {
      if (!user.agent) return;

      const id = ulid();
      doc.messages[id] = {
        author: user.agent.assertDid,
        reactions: {},
        content: JSON.stringify(messageInput),
        ...(replyingTo && { replyTo: replyingTo.id }),

        // TODO: rework images with tiptap
        // ...(images && { images }),
      };
      doc.channels[page.params.channel].timeline.push(id);
    });

    messageInput = {};
    replyingTo = null;
    imageFiles = null;
  }

  function deleteThread(id: Ulid) {
    if (!space) return;

    space.change((doc) => {
      delete doc.threads[id];
    });

    toast.success("Thread deleted", { position: "bottom-end" });
    goto(page.url.pathname);
  }

  //
  // Settings Dialog
  //

  let isAdmin = $derived(
    user.agent && space && space.view.admins.includes(user.agent.assertDid),
  );
  let mayUploadImages = $derived.by(() => {
    if (isAdmin) return true;

    let messagesByUser = Object.values(space.view.messages).filter(
      (x) => user.agent && x.author == user.agent.assertDid,
    );
    if (messagesByUser.length > 5) return true;
    return !!messagesByUser.find(
      (message) =>
        !!Object.values(message.reactions).find(
          (reactedUsers) =>
            !!reactedUsers.find((user) => !!space.view.admins.includes(user)),
        ),
    );
  });
  let showSettingsDialog = $state(false);
  let channelNameInput = $state("");
  let channelCategoryInput = $state(undefined) as undefined | string;
  $effect(() => {
    channelNameInput = channel?.name || "";
    channelCategoryInput = Object.entries(space.view.categories).find(
      ([_id, category]) => category.channels.includes(page.params.channel),
    )?.[0];
  });

  function saveSettings() {
    space?.change((space) => {
      if (channelNameInput) {
        space.channels[page.params.channel].name = channelNameInput;
      }
      Object.entries(space.categories).forEach(([catId, category]) => {
        if (channelCategoryInput !== catId) {
          const idx = category.channels.indexOf(page.params.channel);
          if (idx !== -1) {
            category.channels.splice(idx, 1);
          }
        }
        if (channelCategoryInput) {
          const category = space.categories[channelCategoryInput];
          if (!category.channels.includes(page.params.channel)) {
            category.channels.push(page.params.channel);
          }
          const idx = space.sidebarItems.findIndex(
            (x) => x.type == "channel" && x.id == page.params.channel,
          );
          if (idx !== -1) {
            space.sidebarItems.splice(idx, 1);
          }
        } else if (
          !space.sidebarItems.find(
            (x) => x.type == "channel" && x.id == page.params.channel,
          )
        ) {
          space.sidebarItems.push({ type: "channel", id: page.params.channel });
        }
      });
    });
    showSettingsDialog = false;
  }

  // TODO: rework with tiptap
  async function handleImageSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    imageFiles = input.files;
  }

  async function handlePaste(event: ClipboardEvent) {
    if (!mayUploadImages) return;

    const items = event.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          imageFiles = new DataTransfer().files;
          const dataTransfer = new DataTransfer();
          dataTransfer.items.add(file);
          imageFiles = dataTransfer.files;
        }
      }
    }
  }

  let wikiContent = $state(channel?.wiki?.content || null);
  let wikiRenderedHtml = $state(channel?.wiki?.html || "");
  let isEditingWiki = $state(false);
  let editorElement: HTMLElement;
  let editor: BlockNoteEditor | null;

  let wikiRelatedThreads = $derived(() => {
    if (!space || !channel?.wiki?.relatedThreads) return {};

    const threads = {};
    for (const threadId of channel.wiki.relatedThreads) {
      if (space.view.threads[threadId]) {
        threads[threadId] = space.view.threads[threadId];
      }
    }
    return threads;
  });

  function setEditingWiki(value: boolean) {
    // Only allow admins to edit the wiki
    if (value && !isAdmin) {
      toast.error("Only admins can edit the wiki", { position: "bottom-end" });
      return;
    }

    isEditingWiki = value;

    if (value) {
      if (editor) {
        editor = null;
      }

      // Use a longer timeout to ensure DOM is ready
      setTimeout(initBlockNoteEditor, 100);
    } else if (editor) {
      editor = null;
    }
  }

  const EditorHandler = (editor: BlockNoteEditor) => {
    try {
      const cursorPosition = editor.getTextCursorPosition();
      if (!cursorPosition) return;

      const block = cursorPosition.block;
      const content = block.content?.[0];

      if (content && content.type === "text" && content.text === "/") {
        // Show the slash command menu
        slashMenuVisible = true;

        const { top, left } = editor.getSelectionBoundingBox()?.toJSON();

        // TODO: Calculate the menu height and position it correctly
        const menuHeight = 300; // Approximate max height of the menu
        const viewportHeight = window.innerHeight;
        const scrollY = window.scrollY;

        const wouldOverflow = top + 20 + menuHeight > viewportHeight + scrollY;

        // Position menu above cursor if it would overflow, otherwise below
        const yPosition = wouldOverflow
          ? Math.max(scrollY, top - menuHeight - 10) // Above cursor, but not above viewport
          : top + 20; // Below cursor with padding

        slashMenuPosition = {
          x: left,
          y: yPosition,
        };
      } else {
        slashMenuVisible = false;
      }
    } catch (e) {
      console.error("Error in EditorHandler:", e);
      slashMenuVisible = false;
    }
  };

  const SelectionHandler = (editor: BlockNoteEditor) => {
    try {
      const selection = editor.getSelection();
      
      if (selection) {
        const rect = editor.getSelectionBoundingBox()?.toJSON();
        if (rect) {
          selectionTooltipPosition = {
            x: rect.left + (rect.width / 2) , 
            y: rect.top - 50 
          };
          
          selectionTooltipVisible = true;
        }
      } else {
        selectionTooltipVisible = false;
      }
    } catch (e) {
      console.error("Error in SelectionHandler:", e);
      selectionTooltipVisible = false;
    }
  };

  // Function to execute a slash command
  function executeSlashCommand(command) {
    if (!editor) return;

    // Remove the slash character
    const pos = editor.getTextCursorPosition();
    

    // Execute the command
    command.action();
    editor.updateBlock(pos.block.id, {
      content: [],
    });
    editor.setTextCursorPosition(pos.block.id, "start");
    // Hide the menu
    slashMenuVisible = false;
  }

  async function initBlockNoteEditor() {
    if (!editorElement) return;

    try {
      editorElement.innerHTML = "";

      // Create the editor
      editor = BlockNoteEditor.create();
      editor.mount(editorElement);
      editor.onChange(EditorHandler);
      editor.onSelectionChange(SelectionHandler);
      let targetBlockId = null;
      
      // Add click event listener for the "+" button pseudo-elements
      editorElement.addEventListener('click', (e) => {
        // Calculate if click was in the "+" button area
        const blockElement = e.target.closest('.bn-block');
        if (blockElement) {
          const blockRect = blockElement.getBoundingClientRect();
          
          if (e.clientX < blockRect.left + 24) {
            e.preventDefault();
            e.stopPropagation();
            
            const blockId = blockElement.getAttribute('data-id');
            if (!blockId) return;
            
            slashMenuPosition = {
              x: blockRect.left + 30, 
              y: e.clientY
            };
            
            slashMenuVisible = true;
            
            targetBlockId = blockId;
          }
        }
      });
      

      // Load existing content if available
      if (wikiContent) {
        try {
          // Parse the content and set it to the editor
          const parsedContent = JSON.parse(wikiContent);
          console.log("Parsed content:", parsedContent);

          // Wait a bit for the editor to fully initialize
          setTimeout(() => {
            if (editor && editor.document) {
              // Replace the editor's document with the saved content
              editor.replaceBlocks(editor.document, parsedContent);
              console.log("Content loaded into editor");
            }
          }, 200);
        } catch (e) {
          console.error("Failed to parse wiki content", e);
        }
      }
    } catch (e) {
      console.error("Failed to initialize BlockNote editor", e);
    }
  }

  async function saveWikiContent() {
    if (!editor || !space) return;

    try {
      const content = JSON.stringify(editor.document);

      const html = await editor.blocksToFullHTML(editor.document);
      console.log(html);

      space.change((doc) => {
        if (!doc.channels[page.params.channel].wiki) {
          doc.channels[page.params.channel].wiki = {
            content,
            html,
            relatedThreads: [],
            lastUpdated: Date.now(),
          };
        } else {
          if (!doc.channels[page.params.channel].wiki) {
            doc.channels[page.params.channel].wiki = {
              content: "",
              html: "",
              relatedThreads: [],
              lastUpdated: Date.now(),
            };
          }
          doc.channels[page.params.channel].wiki.content = content;
          doc.channels[page.params.channel].wiki.html = html;
          doc.channels[page.params.channel].wiki.lastUpdated = Date.now();
        }
      });

      wikiContent = content;
      wikiRenderedHtml = html;
      setEditingWiki(false);
      toast.success("Wiki saved successfully", { position: "bottom-end" });
    } catch (e) {
      console.error("Failed to save wiki content", e);
      toast.error("Failed to save wiki content", { position: "bottom-end" });
    }
  }

  $effect(() => {
    if (channel?.wiki) {
      wikiContent = channel.wiki.content;
      wikiRenderedHtml = channel.wiki.html || "";
    }
  });

  // Clean up the editor when component unmounts or tab changes
  $effect(() => {
    if (tab !== "wiki" && editor) {
      editor = null;
    }
  });

  onMount(() => {
    // Force reload CSS to ensure styles are applied
    const existingLink = document.querySelector(
      'link[href*="@blocknote/core/style.css"]',
    );
    if (!existingLink) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://unpkg.com/@blocknote/core@latest/style.css";
      document.head.appendChild(link);
    }
  });

  // Add these state variables for slash commands
  let slashMenuVisible = $state(false);
  let slashMenuPosition = $state({ x: 0, y: 0 });
  let slashCommands = $state([
    {
      name: "Heading 1",
      icon: "tabler:h-1",
      action: () => editor?.updateBlock(editor?.getTextCursorPosition()?.block.id, { type: "heading", props: {level: 1} }),
    },
    {
      name: "Heading 2",
      icon: "tabler:h-2",
      action: () => editor?.updateBlock(editor?.getTextCursorPosition()?.block.id, { type: "heading", props: {level: 2} }),
    },
    {
      name: "Heading 3",
      icon: "tabler:h-3",
      action: () => editor?.updateBlock(editor?.getTextCursorPosition()?.block.id, { type: "heading", props: {level: 3} }),
    },
    {
      name: "Bulleted List",
      icon: "tabler:list",
      action: () => editor?.updateBlock(editor?.getTextCursorPosition()?.block.id, { type: "bulletListItem" }),
    },
    {
      name: "Numbered List",
      icon: "tabler:list-numbers",
      action: () => editor?.updateBlock(editor?.getTextCursorPosition()?.block.id, { type: "numberedListItem" }),
    },
    {
      name: "Checklist",
      icon: "tabler:checkbox",
      action: () => editor?.updateBlock(editor?.getTextCursorPosition()?.block.id, { type: "checkListItem" }),
    },
    {
      name: "Code Block",
      icon: "tabler:code",
      action: () => editor?.updateBlock(editor?.getTextCursorPosition()?.block.id, { type: "codeBlock" }),
    }
  ]);
  function addLinkToSelection() {
    if (!editor) return;
    
    const selection = editor.getSelection();
    if (!selection) {
      toast.error("Please select text to create a link", { position: "bottom-end" });
      return;
    }
    
    urlInputValue = "https://";
    urlPromptVisible = true;
    urlPromptCallback = (url) => {
      if (url) {
        try {
          if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "https://" + url;
          }
          
          editor?.createLink(url);
          
          selectionTooltipVisible = false;
        } catch (e) {
          toast.error("Failed to add link", { position: "bottom-end" });
        }
      }
    };
  }
  
  function submitUrlPrompt() {
    if (urlPromptCallback) {
      urlPromptCallback(urlInputValue);
      urlPromptCallback = null;
    }
    urlPromptVisible = false;
  }
  
  function cancelUrlPrompt() {
    urlPromptCallback = null;
    urlPromptVisible = false;
  }

  let selectionTooltipVisible = $state(false);
  let selectionTooltipPosition = $state({ x: 0, y: 0 });
  let formatCommands = $state([
    { name: "Bold", icon: "tabler:bold", action: () => editor?.toggleStyles({bold: true}) },
    { name: "Italic", icon: "tabler:italic", action: () => editor?.toggleStyles({italic: true}) },
    { name: "Underline", icon: "tabler:underline", action: () => editor?.toggleStyles({underline: true}) },
    { name: "Strike", icon: "tabler:strikethrough", action: () => editor?.toggleStyles({strike: true}) },
    {name: "Link", icon: "tabler:link", action: () => addLinkToSelection() }
    
  ]);
  let urlPromptVisible = $state(false);
  let urlInputValue = $state("https://");
  let urlPromptCallback = $state(null);
</script>

<header class="flex flex-none items-center justify-between border-b-1 pb-4">
  <div class="flex gap-4 items-center">
    {#if isMobile}
      <Button.Root onclick={() => goto(`/space/${page.params.space}`)}>
        <Icon icon="uil:left" color="white" />
      </Button.Root>
    {:else}
      <AvatarImage avatarUrl={channel?.avatar} handle={channel?.name ?? ""} />
    {/if}

    <span class="flex gap-2 items-center">
      {#if !isMobile || (isMobile && !currentThread)}
        <h4
          class={`${isMobile && "line-clamp-1 overflow-hidden text-ellipsis"} text-white text-lg font-bold`}
        >
          {channel?.name}
        </h4>
      {/if}

      {#if currentThread}
        {#if !isMobile}
          <Icon icon="mingcute:right-line" color="white" />
        {/if}
        <Icon icon="lucide-lab:reel-thread" color="white" />
        <h5 class="text-white text-lg font-bold line-clamp-1 text-ellipsis">
          {currentThread.title}
        </h5>
      {/if}
    </span>
  </div>

  <Tabs.Root bind:value={tab}>
    <Tabs.List class="grid grid-cols-3 gap-4 border text-white p-1 rounded">
      <Tabs.Trigger
        value="chat"
        onclick={() => goto(page.url.pathname)}
        class="flex gap-2 w-full justify-center transition-all duration-150 items-center px-4 py-1 data-[state=active]:bg-violet-800 rounded"
      >
        <Icon icon="tabler:message" color="white" class="text-2xl" />
        {#if !isMobile}
          <p>Chat</p>
        {/if}
      </Tabs.Trigger>
      <Tabs.Trigger
        value="threads"
        class="flex gap-2 w-full justify-center transition-all duration-150 items-center px-4 py-1 data-[state=active]:bg-violet-800 rounded"
      >
        <Icon
          icon="material-symbols:thread-unread-rounded"
          color="white"
          class="text-2xl"
        />
        {#if !isMobile}
          <p>Threads</p>
        {/if}
      </Tabs.Trigger>
      <Tabs.Trigger
        value="wiki"
        class="flex gap-2 w-full justify-center transition-all duration-150 items-center px-4 py-1 data-[state=active]:bg-violet-800 rounded"
      >
        <Icon icon="tabler:notebook" color="white" class="text-2xl" />
        {#if !isMobile}
          <p>Wiki</p>
        {/if}
      </Tabs.Trigger>
    </Tabs.List>
  </Tabs.Root>

  {#if !isMobile}
    <div class="flex">
      {@render toolbar({ growButton: false })}
    </div>
  {/if}
</header>

{#if tab === "chat"}
  {@render chatTab()}
{:else if tab === "threads"}
  {@render threadsTab()}
{:else if tab === "wiki"}
  {@render wikiTab()}
{/if}

{#snippet chatTab()}
  {#if space}
    <ChatArea
      source={{ type: "space", space, channelId: page.params.channel }}
    />
    <div class="flex float-end">
      {#if !isMobile || !isThreading.value}
        <section class="grow flex flex-col">
          {#if replyingTo}
            <div
              class="flex justify-between bg-violet-800 text-white rounded-t-lg px-4 py-2"
            >
              <div class="flex flex-col gap-1">
                <h5 class="flex gap-2 items-center">
                  Replying to
                  <AvatarImage
                    handle={replyingTo.authorProfile.handle}
                    avatarUrl={replyingTo.authorProfile.avatarUrl}
                    className="!w-4"
                  />
                  <strong>{replyingTo.authorProfile.handle}</strong>
                </h5>
                <p class="text-gray-300 text-ellipsis italic">
                  {@html getContentHtml(replyingTo.content)}
                </p>
              </div>
              <Button.Root
                type="button"
                onclick={() => (replyingTo = null)}
                class="cursor-pointer hover:scale-105 active:scale-95 transition-all duration-150"
              >
                <Icon icon="zondicons:close-solid" />
              </Button.Root>
            </div>
          {/if}
          <div class="relative">
            <!-- TODO: get all users that has joined the server -->
            <ChatInput
              bind:content={messageInput}
              users={users()}
              context={contextItems}
              onEnter={sendMessage}
            />

            <!--
            {#if mayUploadImages}
              <label
                class="cursor-pointer text-white hover:text-gray-300 absolute right-3 top-1/2 -translate-y-1/2"
              >
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  class="hidden"
                  onchange={handleImageSelect}
                />
                <Icon
                  icon="material-symbols:add-photo-alternate"
                  class="text-2xl"
                />
              </label>
            {/if}
            -->
          </div>

          <!-- Image preview 
          {#if imageFiles?.length}
            <div class="flex gap-2 flex-wrap">
              {#each Array.from(imageFiles) as file}
                <div class="relative mt-5">
                  <img
                    src={URL.createObjectURL(file)}
                    alt={file.name}
                    class="w-20 h-20 object-cover rounded"
                  />
                  <button
                    type="button"
                    class="absolute -top-2 -right-2 bg-red-500 rounded-full p-1"
                    onclick={() => (imageFiles = null)}
                  >
                    <Icon icon="zondicons:close-solid" color="white" />
                  </button>
                </div>
              {/each}
            </div>
          {/if}
          -->
        </section>
      {/if}

      {#if isMobile}
        {@render toolbar({ growButton: true })}
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet threadsTab()}
  {#if space}
    {#if currentThread}
      <section class="flex flex-col gap-4 items-start h-full">
        <menu class="px-4 py-2 flex w-full justify-between">
          <Button.Root
            onclick={() => goto(page.url.pathname)}
            class="flex gap-2 items-center text-white cursor-pointer hover:scale-105 transitiona-all duration-150"
          >
            <Icon icon="uil:left" />
            Back
          </Button.Root>
          <Dialog title="Delete Thread" bind:isDialogOpen={showSettingsDialog}>
            {#snippet dialogTrigger()}
              <Icon icon="tabler:trash" color="red" class="text-2xl" />
            {/snippet}
            <div class="flex flex-col items-center gap-4">
              <p>The thread will be unrecoverable once deleted.</p>
              <Button.Root
                onclick={() =>
                  deleteThread(page.url.searchParams.get("thread")!)}
                class="flex items-center gap-3 px-4 py-2 max-w-[20em] bg-red-600 text-white rounded-lg hover:scale-[102%] active:scale-95 transition-all duration-150"
              >
                Confirm Delete
              </Button.Root>
            </div>
          </Dialog>
        </menu>

        <ScrollArea.Root>
          <ScrollArea.Viewport class="max-w-screen h-full max-h-[90%]">
            <ol class="flex flex-col gap-4">
              {#each currentThread.timeline as id}
                {@const message = space.view.messages[id]}
                <ChatMessage
                  {id}
                  {message}
                  messageRepliedTo={message.replyTo
                    ? space.view.messages[message.replyTo]
                    : undefined}
                />
              {/each}
            </ol>
          </ScrollArea.Viewport>
          <ScrollArea.Scrollbar
            orientation="vertical"
            class="flex h-full w-2.5 touch-none select-none rounded-full border-l border-l-transparent p-px transition-all hover:w-3 hover:bg-dark-10"
          >
            <ScrollArea.Thumb
              class="relative flex-1 rounded-full bg-muted-foreground opacity-40 transition-opacity hover:opacity-100"
            />
          </ScrollArea.Scrollbar>
          <ScrollArea.Corner />
        </ScrollArea.Root>
      </section>
    {:else}
      <ul class="overflow-y-auto px-2 gap-3 flex flex-col">
        {#each Object.entries(space.view.threads) as [id, thread] (id)}
          <ThreadRow
            {id}
            {thread}
            onclick={() => goto(`?thread=${id}`)}
            onclickDelete={() => deleteThread(id)}
          />
        {/each}
      </ul>
    {/if}
  {/if}
{/snippet}

{#snippet toolbar({ growButton = false }: { growButton: boolean })}
  {#if isThreading.value}
    <div in:fly class={`${growButton && "grow w-full pr-2"}`}>
      <Popover.Root>
        <Popover.Trigger
          class={`cursor-pointer ${growButton ? "w-full" : "w-fit"} px-4 py-2 rounded bg-violet-800 text-white`}
        >
          Create Thread
        </Popover.Trigger>

        <Popover.Content
          sideOffset={8}
          forceMount
          class="bg-violet-800 p-4 rounded"
        >
          <form onsubmit={createThread} class="text-white flex flex-col gap-4">
            <label class="flex flex-col gap-1">
              Thread Title
              <input
                bind:value={threadTitleInput}
                type="text"
                placeholder="Notes"
                class="border px-4 py-2 rounded"
              />
            </label>
            <Popover.Close>
              <button
                type="submit"
                class="text-black px-4 py-2 bg-white rounded w-full text-center"
              >
                Confirm
              </button>
            </Popover.Close>
          </form>
        </Popover.Content>
      </Popover.Root>
    </div>
  {/if}
  <menu class="relative flex items-center gap-3 px-2 w-fit self-end">
    <Toggle.Root
      bind:pressed={isThreading.value}
      disabled={tab !== "chat"}
      class={`p-2 ${isThreading.value && "bg-white/10"} cursor-pointer hover:scale-105 active:scale-95 transition-all duration-150 rounded`}
    >
      <Icon
        icon="tabler:needle-thread"
        color={tab !== "chat" ? "gray" : "white"}
        class="text-2xl"
      />
    </Toggle.Root>
    <Button.Root
      title="Copy invite link"
      class="cursor-pointer hover:scale-105 active:scale-95 transition-all duration-150"
      onclick={() => {
        navigator.clipboard.writeText(`${page.url.href}`);
      }}
    >
      <Icon icon="icon-park-outline:copy-link" color="white" class="text-2xl" />
    </Button.Root>

    {#if isAdmin}
      <Dialog title="Channel Settings" bind:isDialogOpen={showSettingsDialog}>
        {#snippet dialogTrigger()}
          <Button.Root
            title="Channel Settings"
            class="cursor-pointer hover:scale-105 active:scale-95 transition-all duration-150 m-auto flex"
          >
            <Icon icon="lucide:settings" color="white" class="text-2xl" />
          </Button.Root>
        {/snippet}

        <form class="flex flex-col gap-4 w-full" onsubmit={saveSettings}>
          <label>
            Name
            <input
              bind:value={channelNameInput}
              placeholder="channel-name"
              class="w-full outline-hidden border border-white px-4 py-2 rounded-sm bg-transparent"
            />
          </label>
          {#if space}
            <select bind:value={channelCategoryInput}>
              <option class="bg-violet-900 text-white" value={undefined}
                >Category: None</option
              >
              {#each Object.keys(space.view.categories) as categoryId}
                {@const category = space.view.categories[categoryId]}
                <option class="bg-violet-900 text-white" value={categoryId}
                  >Category: {category.name}</option
                >
              {/each}
            </select>
          {/if}
          <Button.Root
            class={`px-4 py-2 bg-white text-black rounded-lg disabled:bg-white/50 active:scale-95 transition-all duration-150 flex items-center justify-center gap-2 hover:scale-[102%]`}
          >
            Save Settings
          </Button.Root>
        </form>
      </Dialog>
    {/if}
  </menu>
{/snippet}

{#snippet wikiTab()}
  {#if space}
    <div class="flex flex-col gap-4 h-full overflow-y-auto p-2">
      {#if !wikiContent || isEditingWiki}
        <section class="wiki-editor-container">
          {#if isEditingWiki}
            <div class="mb-4 flex justify-between items-center">
              <h3 class="text-xl font-bold text-white">{channel?.name} Wiki</h3>
              <div class="flex gap-2">
                <Button.Root
                  onclick={() => setEditingWiki(false)}
                  class="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-500 transition-colors"
                >
                  Cancel
                </Button.Root>
                <Button.Root
                  onclick={saveWikiContent}
                  class="px-4 py-2 bg-violet-700 text-white rounded hover:bg-violet-600 transition-colors"
                >
                  Save
                </Button.Root>
              </div>
            </div>
            <div
              class="wiki-editor bg-violet-900/20 rounded-lg border border-violet-500/30 p-4 h-auto {isAdmin ? 'admin-mode' : ''}"
            >
              <div bind:this={editorElement} class="min-h-[400px]"></div>

              <!-- Slash Command Menu -->
              {#if slashMenuVisible && isAdmin}
                <div
                  class="slash-menu bg-violet-900 border border-violet-700 rounded shadow-lg absolute z-50"
                  style="left: {slashMenuPosition.x}px; top: {slashMenuPosition.y}px;"
                >
                  <ul class="py-1">
                    {#each slashCommands as command}
                      <li>
                        <button
                          class="flex items-center gap-2 w-full text-left px-4 py-2 hover:bg-violet-800 text-white"
                          onclick={() => executeSlashCommand(command)}
                        >
                          <Icon icon={command.icon} class="text-xl" />
                          <span>{command.name}</span>
                        </button>
                      </li>
                    {/each}
                  </ul>
                </div>
              {/if}

              <!-- Selection Formatting Tooltip -->
              {#if selectionTooltipVisible && isAdmin}
                <div
                  class="selection-tooltip bg-violet-900 border border-violet-700 rounded shadow-lg absolute z-50 flex"
                  style="left: {selectionTooltipPosition.x}px; top: {selectionTooltipPosition.y}px;"
                >
                  {#each formatCommands as command}
                    <button
                      class="p-2 hover:bg-violet-800 text-white"
                      title={command.name}
                      onclick={() => {
                        command.action();
                        selectionTooltipVisible = false;
                      }}
                    >
                      <Icon icon={command.icon} class="text-xl" />
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          {:else}
            <div
              class="flex justify-center items-center p-8 border border-dashed border-violet-500 rounded-lg"
            >
              <!-- Only show Create Wiki button to admins -->
              {#if isAdmin}
                <Button.Root
                  onclick={() => setEditingWiki(true)}
                  class="flex items-center gap-2 px-4 py-2 bg-violet-700 text-white rounded-lg hover:bg-violet-600 transition-colors"
                >
                  <Icon icon="tabler:edit" />
                  Create Wiki Page
                </Button.Root>
              {:else}
                <p class="text-gray-300">
                  No wiki page exists yet. Only channel admins can create one.
                </p>
              {/if}
            </div>
          {/if}
        </section>
      {:else}
        <section class="wiki-content">
          <div class="flex justify-between items-center mb-4">
            <h3 class="text-xl font-bold text-white">{channel?.name} Wiki</h3>
            <!-- Only show Edit Wiki button to admins -->
            {#if isAdmin}
              <Button.Root
                onclick={() => setEditingWiki(true)}
                class="px-4 py-2 bg-violet-700 text-white rounded hover:bg-violet-600 transition-colors"
              >
                <Icon icon="tabler:edit" />
                Edit Wiki
              </Button.Root>
            {/if}
          </div>

          <div class="wiki-rendered p-4 bg-violet-900/30 rounded-lg">
            <div class="wiki-html text-white">
              {@html wikiRenderedHtml}
            </div>
          </div>

          
        </section>
      {/if}
    </div>
  {/if}
{/snippet}

{#if urlPromptVisible}
  <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-[100]">
    <div class="bg-violet-900 border border-violet-700 rounded-lg shadow-lg p-6 max-w-md w-full">
      <h3 class="text-lg font-bold text-white mb-4">Add Link</h3>
      
      <form 
        onsubmit={submitUrlPrompt}
        class="flex flex-col gap-4"
      >
        <input
          type="text"
          bind:value={urlInputValue}
          placeholder="https://example.com"
          class="w-full px-4 py-2 bg-violet-800 border border-violet-600 rounded text-white focus:outline-none focus:border-violet-500"
          autofocus
        />
        
        <div class="flex justify-end gap-3 mt-2">
          <button
            type="button"
            class="px-4 py-2 bg-transparent border border-violet-500 text-white rounded hover:bg-violet-800 transition-colors"
            onclick={cancelUrlPrompt}
          >
            Cancel
          </button>
          <button
            type="submit"
            class="px-4 py-2 bg-violet-700 text-white rounded hover:bg-violet-600 transition-colors"
          >
            Add Link
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
  :global(.bn-block) {
    position: relative;
    transition: padding-left 0.15s ease;
    padding-left: 24px; 
  }
  
  /* Only show the "+" button in the editor for admins */
  :global(.wiki-editor-container .admin-mode .bn-block::before) {
    content: '+';
    position: absolute;
    left: 6px;
    top: 50%;
    transform: translateY(-50%);
    color: #a78bfa;
    font-size: 16px;
    font-weight: bold;
    width: 18px;
    height: 18px;
    border-radius: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: opacity 0.15s ease, background-color 0.15s ease;
    cursor: pointer;
    z-index: 10;
    background-color: transparent;
  }
  
  :global(.wiki-editor-container .admin-mode .bn-block:hover::before) {
    opacity: 1;
  }
  
  :global(.wiki-editor-container .admin-mode .bn-block::before:hover) {
    background-color: rgba(139, 92, 246, 0.2);
  }
  
  
  .bn-default-styles {
    color: #fff;
    padding-inline: 20px;
  }

  .slash-menu {
    min-width: 200px;
    max-width: 300px;
    max-height: 300px;
    overflow-y: auto;
  }

  .slash-menu ul {
    max-height: 300px;
    overflow-y: auto;
  }

  .wiki-editor {
    overflow: visible;
  }

  :global(.wiki-rendered input[type="checkbox"]){
    pointer-events: none;
  }

  :global(input[type="checkbox"]) {
    pointer-events: auto; 
    cursor: pointer;
  }

  :global(.bn-inline-content a){
    color: #8b5cf6;
    text-decoration: underline;
    cursor: pointer;
  }
  
  
  :global(input[type="checkbox"]) {
    accent-color: #8b5cf6;
    width: 16px;
    height: 16px;
    margin-right: 8px;
  }

  .selection-tooltip {
    padding: 4px;
    border-radius: 6px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
    display: flex;
    align-items: center;
    justify-content: center;
    transform: translateX(-50%);
  }
  
  .selection-tooltip button {
    border-radius: 4px;
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background-color 0.15s ease;
  }
  
  /* Add a subtle animation for the tooltip */
  .selection-tooltip {
    animation: tooltipFadeIn 0.2s ease;
  }
  
  @keyframes tooltipFadeIn {
    from { opacity: 0; transform: translateY(5px) translateX(-50%); }
    to { opacity: 1; transform: translateY(0) translateX(-50%); }
  }
</style>
