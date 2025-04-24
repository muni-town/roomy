<script lang="ts">
  import { onMount, getContext, tick } from "svelte";
  import { codeToHtml } from "shiki";
  import { toast } from "svelte-french-toast";
  import { Button } from "bits-ui";
  import Icon from "@iconify/svelte";
  import Link from "@tiptap/extension-link";
  import { BlockNoteEditor } from "@blocknote/core";
  import "@blocknote/core/style.css";

  import { WikiPage } from "@roomy-chat/sdk";

  import { page } from "$app/state";
  import { g } from "$lib/global.svelte";
  import { focusOnRender } from "$lib/actions/useFocusOnRender.svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import { outerWidth } from "svelte/reactivity/window";
  let isMobile = $derived((outerWidth.current ?? 0) < 640);

  let { wiki }: { wiki: WikiPage } = $props();
  let isEditingWiki = $state(false);

  let wikiRenderedHtml = $state("");
  let processedHtml = $state("");
  let editorElement: HTMLElement | null = $state(null);
  let editor: BlockNoteEditor | null;

  interface UserItem {
    value: string;
    label: string;
    category: string;
  }

  let users = getContext<{ value: UserItem[] }>("users");

  let slashMenuVisible = $state(false);
  let slashMenuPosition = $state({ x: 0, y: 0 });
  let slashCommands = $state([
    {
      name: "Heading 1",
      icon: "tabler:h-1",
      action: () =>
        editor?.updateBlock(editor?.getTextCursorPosition()?.block.id, {
          type: "heading",
          props: { level: 1 },
        }),
    },
    {
      name: "Heading 2",
      icon: "tabler:h-2",
      action: () =>
        editor?.updateBlock(editor?.getTextCursorPosition()?.block.id, {
          type: "heading",
          props: { level: 2 },
        }),
    },
    {
      name: "Heading 3",
      icon: "tabler:h-3",
      action: () =>
        editor?.updateBlock(editor?.getTextCursorPosition()?.block.id, {
          type: "heading",
          props: { level: 3 },
        }),
    },
    {
      name: "Bulleted List",
      icon: "tabler:list",
      action: () =>
        editor?.updateBlock(editor?.getTextCursorPosition()?.block.id, {
          type: "bulletListItem",
        }),
    },
    {
      name: "Numbered List",
      icon: "tabler:list-numbers",
      action: () =>
        editor?.updateBlock(editor?.getTextCursorPosition()?.block.id, {
          type: "numberedListItem",
        }),
    },
    {
      name: "Checklist",
      icon: "tabler:checkbox",
      action: () =>
        editor?.updateBlock(editor?.getTextCursorPosition()?.block.id, {
          type: "checkListItem",
        }),
    },
    {
      name: "Code Block",
      icon: "tabler:code",
      action: () =>
        editor?.updateBlock(editor?.getTextCursorPosition()?.block.id, {
          type: "codeBlock",
        }),
    },
  ]);

  let mentionMenuVisible = $state(false);
  let mentionMenuPosition = $state({ x: 0, y: 0 });
  let filteredUsers = $state<any[]>([]);
  let mentionQuery = $state("");

  let hashMenuVisible = $state(false);
  let hashMenuPosition = $state({ x: 0, y: 0 });
  let filteredItems = $state<
    { id: string; name: string; type: "thread" | "channel" }[]
  >([]);
  let hashQuery = $state("");

  let selectionTooltipVisible = $state(false);
  let selectionTooltipPosition = $state({ x: 0, y: 0 });
  let formatCommands = $state([
    {
      name: "Bold",
      icon: "tabler:bold",
      action: () => editor?.toggleStyles({ bold: true }),
    },
    {
      name: "Italic",
      icon: "tabler:italic",
      action: () => editor?.toggleStyles({ italic: true }),
    },
    {
      name: "Underline",
      icon: "tabler:underline",
      action: () => editor?.toggleStyles({ underline: true }),
    },
    {
      name: "Strike",
      icon: "tabler:strikethrough",
      action: () => editor?.toggleStyles({ strike: true }),
    },
    { name: "Link", icon: "tabler:link", action: () => addLinkToSelection() },
  ]);

  let isUrlPromptDialogOpen = $state(false);
  let urlInputElement: HTMLInputElement | null = $state(null);
  let urlPromptCallback: ((url: string) => void) | null = $state(null);

  let isDeleteDialogOpen = $state(false);

  function setEditingWiki(value: boolean) {
    isEditingWiki = value;

    if (value) {
      if (editor) {
        editor = null;
      }
      setTimeout(initBlockNoteEditor, 100);
    } else if (editor) {
      editor = null;
    }
  }

  function showDeleteDialog(event: Event) {
    event.stopPropagation();
    isDeleteDialogOpen = true;
  }

  function confirmDeleteWiki() {
    wiki.softDeleted = true;
    wiki.commit();

    isEditingWiki = false; // Close the editor to remove cached wiki
    isDeleteDialogOpen = false;
  }

  const EditorHandler = (editor: BlockNoteEditor) => {
    try {
      const cursorPosition = editor.getTextCursorPosition();
      if (!cursorPosition) return;

      const block = cursorPosition.block;
      const content = Array.isArray(block.content) ? block.content[0] : null;

      if (content && content.type === "text") {
        // Handle slash commands
        if (content.text === "/") {
          slashMenuVisible = true;
          const { top, left } = editor.getSelectionBoundingBox()?.toJSON();
          const menuHeight = 300;
          const viewportHeight = window.innerHeight;
          const scrollY = window.scrollY;
          const wouldOverflow =
            top + 20 + menuHeight > viewportHeight + scrollY;
          const yPosition = wouldOverflow
            ? Math.max(scrollY, top - menuHeight - 10)
            : top + 20;
          slashMenuPosition = { x: left, y: yPosition };
          mentionMenuVisible = false;
          hashMenuVisible = false;
        }
        // Handle mentions
        else if (content.text.endsWith("@")) {
          mentionMenuVisible = true;
          mentionQuery = "";
          const { top, left } = editor.getSelectionBoundingBox()?.toJSON();
          const menuHeight = 300;
          const viewportHeight = window.innerHeight;
          const scrollY = window.scrollY;
          const wouldOverflow =
            top + 20 + menuHeight > viewportHeight + scrollY;
          const yPosition = wouldOverflow
            ? Math.max(scrollY, top - menuHeight - 10)
            : top + 20;
          mentionMenuPosition = { x: left, y: yPosition };
          updateFilteredUsers();
          slashMenuVisible = false;
          hashMenuVisible = false;
        }
        // Handle hashtags
        else if (content.text.endsWith("#")) {
          hashMenuVisible = true;
          hashQuery = "";
          const { top, left } = editor.getSelectionBoundingBox()?.toJSON();
          const menuHeight = 300;
          const viewportHeight = window.innerHeight;
          const scrollY = window.scrollY;
          const wouldOverflow =
            top + 20 + menuHeight > viewportHeight + scrollY;
          const yPosition = wouldOverflow
            ? Math.max(scrollY, top - menuHeight - 10)
            : top + 20;
          hashMenuPosition = { x: left, y: yPosition };
          updateFilteredItems();
          slashMenuVisible = false;
          mentionMenuVisible = false;
        }
        // Check if typing in an active mention
        else if (mentionMenuVisible) {
          const text = content.text;
          const atIndex = text.lastIndexOf("@");

          if (atIndex !== -1) {
            mentionQuery = text.substring(atIndex + 1);
            updateFilteredUsers();
          } else {
            mentionMenuVisible = false;
          }
        }
        // Check if typing in an active hashtag
        else if (hashMenuVisible) {
          const text = content.text;
          const hashIndex = text.lastIndexOf("#");

          if (hashIndex !== -1) {
            hashQuery = text.substring(hashIndex + 1);
            updateFilteredItems();
          } else {
            hashMenuVisible = false;
          }
        } else {
          slashMenuVisible = false;
          mentionMenuVisible = false;
          hashMenuVisible = false;
        }
      } else {
        slashMenuVisible = false;
        mentionMenuVisible = false;
        hashMenuVisible = false;
      }
    } catch (e) {
      console.error("Error in EditorHandler:", e);
      slashMenuVisible = false;
      mentionMenuVisible = false;
      hashMenuVisible = false;
    }
  };

  const SelectionHandler = (editor: BlockNoteEditor) => {
    try {
      const selection = editor.getSelection();
      if (selection) {
        const rect = editor.getSelectionBoundingBox()?.toJSON();
        if (rect) {
          selectionTooltipPosition = {
            x: rect.left + rect.width / 2,
            y: rect.top - 50,
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

  function executeSlashCommand(command: {
    name?: string;
    icon?: string;
    action: any;
  }) {
    if (!editor) return;
    const pos = editor.getTextCursorPosition();
    command.action();
    editor.updateBlock(pos.block.id, { content: [] });
    editor.setTextCursorPosition(pos.block.id, "start");
    slashMenuVisible = false;
  }

  function executeFormatCommand(command: {
    name?: string;
    icon?: string;
    action: any;
  }) {
    if (!editor) return;
    command.action();
  }

  // Filter users based on mention query
  function updateFilteredUsers() {
    if (!users?.value?.length) {
      filteredUsers = [];
      return;
    }

    const query = mentionQuery.toLowerCase();
    filteredUsers = users.value
      .filter((user) => user.label?.toLowerCase().includes(query))
      .slice(0, 10); // Limit to 10 results
  }

  // Filter channels and threads based on hash query
  async function updateFilteredItems() {
    if (!g.space) {
      filteredItems = [];
      return;
    }

    const query = hashQuery.toLowerCase();
    const items: { id: string; name: string; type: "thread" | "channel" }[] =
      [];

    // Add channels

    for (const channel of await g.space.channels.items()) {
      if (channel.name && channel.name.toLowerCase().includes(query)) {
        items.push({
          id: channel.id,
          name: channel.name,
          type: "channel",
        });
      }
    }

    for (const thread of await g.space.threads.items()) {
      if (thread.name.toLowerCase().includes(query)) {
        items.push({
          id: thread.id,
          name: thread.name,
          type: "thread",
        });
      }
    }

    // Limit to 10 results
    filteredItems = items.slice(0, 10);
  }

  // Insert user mention
  function insertUserMention(user: UserItem) {
    if (!editor) return;

    try {
      const cursorPosition = editor.getTextCursorPosition();
      if (!cursorPosition) return;

      const block = cursorPosition.block;
      const content = Array.isArray(block.content) ? block.content[0] : null;

      if (content && content.type === "text") {
        const text = content.text;
        const atIndex = text.lastIndexOf("@");

        if (atIndex !== -1) {
          const newText = text.substring(0, atIndex) + `@${user.label}`;

          editor.updateBlock(block.id, {
            content: [
              {
                type: "text",
                text: newText,
                styles: {
                  backgroundColor: "#8b5cf6",
                },
              },
            ],
          });
          editor.insertBlocks(
            [{ type: "paragraph", content: "" }],
            block.id,
            "after",
          );
          editor.setSelection(
            block.id,
            editor.getNextBlock(block.id)?.id ?? block.id,
          );
          editor.createLink(
            user.label.startsWith("https://")
              ? user.label
              : `https://${user.label}`,
          );

          editor.setTextCursorPosition(block.id, "end");
        }
      }

      mentionMenuVisible = false;
    } catch (e) {
      console.error("Error inserting mention:", e);
      mentionMenuVisible = false;
    }
  }

  function insertHashLink(item: {
    id: string;
    name: string;
    type: "thread" | "channel";
  }) {
    if (!editor) return;

    try {
      const cursorPosition = editor.getTextCursorPosition();
      if (!cursorPosition) return;

      const block = cursorPosition.block;
      const content = Array.isArray(block.content) ? block.content[0] : null;

      if (content && content.type === "text") {
        const text = content.text;
        const hashIndex = text.lastIndexOf("#");

        if (hashIndex !== -1) {
          const newText = text.substring(0, hashIndex) + `#${item.name}`;

          editor.updateBlock(block.id, {
            content: [
              {
                type: "text",
                text: newText,
                styles: {
                  backgroundColor: "#8b5cf6",
                  textColor: "white",
                },
              },
            ],
          });

          editor.insertBlocks(
            [{ type: "paragraph", content: "" }],
            block.id,
            "after",
          );

          editor.setSelection(
            block.id,
            editor.getNextBlock(block.id)?.id ?? block.id,
          );

          const linkId =
            item.type === "channel"
              ? `/${page.params.space}/${item.id}`
              : `/${page.params.space}/thread/${item.id}`;
          editor.createLink(linkId);

          editor.setTextCursorPosition(block.id, "end");
        }
      }

      hashMenuVisible = false;
    } catch (e) {
      console.error("Error inserting hash link:", e);
      hashMenuVisible = false;
    }
  }

  async function initBlockNoteEditor() {
    if (!editorElement) return;
    try {
      editorElement.innerHTML = "";
      editor = BlockNoteEditor.create({
        _extensions: {
          link: Link.configure({
            HTMLAttributes: {
              target: null,
            },
          }),
        },
      });

      editor.mount(editorElement);
      editor.onChange(EditorHandler);
      editor.onSelectionChange(SelectionHandler);
      let targetBlockId = null;
      editorElement.addEventListener("click", (e) => {
        const blockElement = (e.target as Element)?.closest(".bn-block");
        if (blockElement) {
          const blockRect = blockElement.getBoundingClientRect();
          if (e.clientX < blockRect.left + 24) {
            e.preventDefault();
            e.stopPropagation();
            const blockId = blockElement.getAttribute("data-id");
            if (!blockId) return;
            slashMenuPosition = { x: blockRect.left + 30, y: e.clientY };
            slashMenuVisible = true;
            targetBlockId = blockId;
          }
        }
      });
      if (wiki) {
        try {
          const parsedContent = JSON.parse(wiki.bodyJson);
          setTimeout(() => {
            if (editor && editor.document) {
              editor.replaceBlocks(editor.document, parsedContent);
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

  async function processCodeBlocks() {
    if (!wikiRenderedHtml) {
      processedHtml = wikiRenderedHtml;
      return;
    }

    try {
      // Process the HTML to find code blocks and apply syntax highlighting
      const parser = new DOMParser();
      const doc = parser.parseFromString(wikiRenderedHtml, "text/html");

      // Find all code blocks with language class
      const codeBlocks = doc.querySelectorAll("pre code");

      for (const codeBlock of codeBlocks) {
        const languageMatch = codeBlock.className.match(/language-(\w+)/);
        if (!languageMatch) continue;

        const language = languageMatch[1] || "txt";
        const code = codeBlock.textContent || "";

        try {
          const highlightedCode = await codeToHtml(code, {
            lang: language,
            theme: "vitesse-dark",
          });

          // Replace the code block with highlighted version
          const preElement = codeBlock.parentElement;
          if (preElement) {
            const tempContainer = document.createElement("div");
            tempContainer.innerHTML = highlightedCode;

            const labelDiv = document.createElement("div");
            labelDiv.className = "code-language-label";
            labelDiv.textContent = formatLanguageName(language);

            const shikiElement = tempContainer.firstElementChild;
            if (shikiElement) {
              const wrapper = document.createElement("div");
              wrapper.className = "code-block-wrapper";
              wrapper.appendChild(labelDiv);
              wrapper.appendChild(shikiElement);

              preElement.replaceWith(wrapper);
            } else {
              preElement.replaceWith(tempContainer.firstElementChild!);
            }
          }
        } catch (e) {
          console.error(
            `Failed to highlight code for language ${language}:`,
            e,
          );
        }
      }

      processedHtml = doc.body.innerHTML;
    } catch (e) {
      console.error("Failed to process code blocks:", e);
      processedHtml = wikiRenderedHtml;
    }
  }

  // Function to format language name for display
  function formatLanguageName(lang: string): string {
    const languageMap: Record<string, string> = {
      js: "JavaScript",
      ts: "TypeScript",
      jsx: "React JSX",
      tsx: "React TSX",
      html: "HTML",
      css: "CSS",
      scss: "SCSS",
      sass: "Sass",
      py: "Python",
      rb: "Ruby",
      rs: "Rust",
      go: "Go",
      java: "Java",
      kt: "Kotlin",
      cs: "C#",
      cpp: "C++",
      c: "C",
      php: "PHP",
      sh: "Shell",
      bash: "Bash",
      zsh: "Zsh",
      sql: "SQL",
      json: "JSON",
      yml: "YAML",
      yaml: "YAML",
      md: "Markdown",
      svelte: "Svelte",
    };

    return languageMap[lang] || lang.charAt(0).toUpperCase() + lang.slice(1);
  }

  $effect(() => {
    wikiRenderedHtml;
    processCodeBlocks();
  });

  $effect(() => {
    if (wiki.bodyJson == "{}") {
      wikiRenderedHtml = "";
      processedHtml = "";
      return;
    }
    const json = JSON.parse(wiki.bodyJson);
    try {
      const rendererEditor = BlockNoteEditor.create();
      rendererEditor
        .blocksToFullHTML(json)
        .then((html) => {
          wikiRenderedHtml = html;
        })
        .catch(() => {
          wikiRenderedHtml = "";
        });
    } catch (_e) {
      wikiRenderedHtml = "";
    }
  });

  async function saveWikiContent() {
    if (!editor || !g.space || !wiki) return;
    try {
      const res = JSON.stringify(editor.document);
      wiki.bodyJson = res;
      wiki.commit();

      setEditingWiki(false);
      toast.success("Wiki saved successfully", { position: "bottom-end" });
    } catch (e) {
      console.error("Failed to save wiki content", e);
      toast.error("Failed to save wiki content", { position: "bottom-end" });
    }
  }

  function addLinkToSelection() {
    if (!editor) return;
    const selection = editor.getSelection();
    if (!selection) {
      toast.error("Please select text to create a link", {
        position: "bottom-end",
      });
      return;
    }

    if (urlInputElement) {
      urlInputElement.value = "https://";
    }
    isUrlPromptDialogOpen = true;

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
    if (urlPromptCallback && urlInputElement) {
      urlPromptCallback(urlInputElement.value);
      tick().then(() => {
        if (urlInputElement) {
          urlInputElement.value = ""; // Reset the input value after submission
        }
        urlPromptCallback = null;
        isUrlPromptDialogOpen = false;
      });
    }
  }

  $effect(() => {
    if (editor) {
      editor = null;
    }
  });

  onMount(async () => {
    const existingLink = document.querySelector(
      'link[href*="@blocknote/core/style.css"]',
    );
    if (!existingLink) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://unpkg.com/@blocknote/core@latest/style.css";
      document.head.appendChild(link);
    }

    if (wikiRenderedHtml) {
      await processCodeBlocks();
    }
  });
</script>

<header class="navbar">
  <div class="navbar-start flex w-full justify-between gap-4">
    <label
      for="sidebar-left"
      class="btn btn-ghost p-1 shrink-0 drawer-button sm:hidden"
      title="Open sidebar"
    >
      <Icon
        icon="material-symbols:book-outline"
        font-size="1.75rem"
        class="shrink-0"
      />
    </label>

    <div class="flex gap-2 items-center" class:input={isEditingWiki}>
      <Icon icon={"material-symbols:thread-unread-rounded"} />
      {#if !isEditingWiki}
        <h4
          class={`${isMobile && "line-clamp-1 overflow-hidden text-ellipsis"} text-base-content text-lg font-bold flex gap-2 items-center`}
        >
          {wiki.name}
        </h4>
      {:else}
        <input
          type="text"
          bind:value={wiki.name}
          class="text-base-content text-lg font-bold p-0 flex-1 mr-2"
          placeholder="Wiki title"
          required
        />
      {/if}
    </div>
  </div>
  <div class="flex gap-2">
    {#if !isEditingWiki}
      <Button.Root
        onclick={() => setEditingWiki(true)}
        class="btn max-w-fit btn-primary"
      >
        <Icon icon="tabler:edit" />
        Edit
      </Button.Root>
    {:else}
      <div class="flex gap-2">
        <Button.Root
          onclick={() => setEditingWiki(false)}
          class="btn btn-ghost"
        >
          Cancel
        </Button.Root>
        <Button.Root onclick={saveWikiContent} class="btn btn-primary">
          Save
        </Button.Root>
      </div>
    {/if}

    {#if g.isAdmin}
      <button
        class="btn btn-error delete-btn group-hover:block"
        onclick={showDeleteDialog}
      >
        <Icon icon="tabler:trash" />
      </button>
    {/if}
  </div>
</header>
<!-- If no wiki selected, show guidance -->
<div class="divider my-0"></div>

{#if !isEditingWiki}
  <section class="wiki-content">
    <div class="wiki-rendered p-4">
      <div class="wiki-html text-base-content">
        {#if wiki && !wiki.softDeleted}
          {@html processedHtml}
        {:else}
          <p class="text-base-content/70">No content available.</p>
        {/if}
      </div>
    </div>
  </section>
{:else}
  <section class="wiki-editor-container p-4">
    <div
      class="wiki-editor bg-base-300/20 rounded-lg border border-base-content/30 p-4 h-auto {isEditingWiki
        ? 'edit-mode'
        : ''}"
    >
      <div
        class="permanent-formatting-toolbar bg-base-300 border border-base-content/20 rounded-lg shadow-lg p-1 mb-4 flex items-center"
      >
        {#each formatCommands as command}
          <button
            class="btn btn-ghost btn-square btn-sm"
            title={command.name}
            onclick={() => executeFormatCommand(command)}
          >
            <Icon icon={command.icon} class="text-xl" />
          </button>
        {/each}
        <div class="ml-2 border-l border-base-content/20 h-6"></div>
        {#each slashCommands as command, i}
          {#if i < 3}
            <button
              class="btn btn-ghost btn-square btn-sm"
              title={command.name}
              onclick={() => executeSlashCommand(command)}
            >
              <Icon icon={command.icon} class="text-xl" />
            </button>
          {/if}
        {/each}
      </div>

      <div bind:this={editorElement} class="min-h-[400px]"></div>

      {#if slashMenuVisible && isEditingWiki}
        <div
          class="slash-menu bg-base-300 border border-base-content/20 rounded shadow-lg absolute z-50"
          style="left: {slashMenuPosition.x}px; top: {slashMenuPosition.y}px;"
        >
          <ul class="py-1">
            {#each slashCommands as command}
              <li>
                <button
                  class="flex items-center gap-2 w-full text-left px-4 py-2 hover:bg-base-200 text-base-content"
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

      {#if mentionMenuVisible && isEditingWiki}
        <div
          class="mention-menu bg-base-300 border border-base-content/20 rounded shadow-lg absolute z-50"
          style="left: {mentionMenuPosition.x}px; top: {mentionMenuPosition.y}px;"
        >
          <div class="py-1 max-h-[300px] overflow-y-auto min-w-[200px]">
            {#if filteredUsers.length > 0}
              <ul>
                {#each filteredUsers as user}
                  <li>
                    <button
                      class="flex items-center gap-2 w-full text-left px-4 py-2 hover:bg-base-200 text-base-content"
                      onclick={() => insertUserMention(user)}
                    >
                      <div
                        class="w-6 h-6 rounded-full bg-primary flex items-center justify-center overflow-hidden"
                      >
                        <span class="text-xs font-bold text-primary-content"
                          >{user.label[0]?.toUpperCase() || "?"}</span
                        >
                      </div>
                      <span>{user.label}</span>
                    </button>
                  </li>
                {/each}
              </ul>
            {:else}
              <div class="px-4 py-2 text-base-content/70">No users found</div>
            {/if}
          </div>
        </div>
      {/if}

      {#if hashMenuVisible && isEditingWiki}
        <div
          class="hash-menu bg-base-300 border border-base-content/20 rounded shadow-lg absolute z-50"
          style="left: {hashMenuPosition.x}px; top: {hashMenuPosition.y}px;"
        >
          <div class="py-1 max-h-[300px] overflow-y-auto min-w-[250px]">
            {#if filteredItems.length > 0}
              <ul>
                {#each filteredItems as item}
                  <li>
                    <button
                      class="flex items-center gap-2 w-full text-left px-4 py-2 hover:bg-base-200 text-base-content"
                      onclick={() => insertHashLink(item)}
                    >
                      <div
                        class="w-6 h-6 rounded flex items-center justify-center overflow-hidden"
                      >
                        <Icon
                          icon={item.type === "channel"
                            ? "tabler:hash"
                            : "tabler:message-circle"}
                          class="text-lg text-primary"
                        />
                      </div>
                      <span>{item.name}</span>
                      <span class="text-xs text-base-content/70 ml-auto"
                        >{item.type}</span
                      >
                    </button>
                  </li>
                {/each}
              </ul>
            {:else}
              <div class="px-4 py-2 text-base-content/70">
                No channels or threads found
              </div>
            {/if}
          </div>
        </div>
      {/if}

      {#if selectionTooltipVisible && isEditingWiki}
        <div
          class="tooltip-animate bg-base-300 border border-base-content/20 rounded shadow-lg absolute z-50 flex items-center justify-center p-1"
          style="left: {selectionTooltipPosition.x}px; top: {selectionTooltipPosition.y}px; transform: translateX(-50%);"
        >
          {#each formatCommands as command}
            <button
              class="btn btn-ghost btn-square btn-sm"
              title={command.name}
              onclick={() => {
                command.action();
                selectionTooltipVisible = false;
              }}
            >
              <Icon icon={command.icon} />
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </section>
{/if}

<Dialog
  title="Add Link"
  description="Embed link into text"
  bind:isDialogOpen={isUrlPromptDialogOpen}
>
  <form onsubmit={submitUrlPrompt} class="flex flex-col gap-4">
    <input
      type="text"
      bind:this={urlInputElement}
      use:focusOnRender
      placeholder="https://example.com"
      class="input input-bordered w-full"
      required
    />
    <div class="flex justify-end gap-3 mt-2">
      <button type="submit" class="btn btn-primary">Add Link</button>
    </div>
  </form>
</Dialog>

<Dialog
  title="Confirm Wiki Deletion"
  description="Are you sure you want to delete <b>{wiki?.name}</b>?</br></br><b>Note:</b> Deletes are not permanent and only hide the data from view. The data is still publicly accessible."
  bind:isDialogOpen={isDeleteDialogOpen}
>
  <div class="flex justify-end gap-3">
    <button class="btn btn-error" onclick={confirmDeleteWiki}>Delete</button>
  </div>
</Dialog>

<style>
  :global(.bn-block) {
    position: relative;
    transition: padding-left 0.15s ease;
    padding-left: 24px;
  }

  :global(.wiki-editor-container .edit-mode .bn-block::before) {
    content: "+";
    position: absolute;
    left: 6px;
    top: 50%;
    transform: translateY(-50%);
    color: hsl(var(--p));
    font-size: 16px;
    font-weight: bold;
    width: 18px;
    height: 18px;
    border-radius: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition:
      opacity 0.15s ease,
      background-color 0.15s ease;
    cursor: pointer;
    z-index: 10;
    background-color: transparent;
  }

  :global(.wiki-editor-container .edit-mode .bn-block:hover::before) {
    opacity: 1;
  }

  :global(.wiki-editor-container .edit-mode .bn-block::before:hover) {
    background-color: hsl(var(--p) / 0.2);
  }

  :global(.wiki-editor) {
    color: hsl(var(--bc));
  }

  .slash-menu,
  .hash-menu,
  .mention-menu {
    min-width: 200px;
    max-width: 350px;
    max-height: 300px;
    overflow-y: auto;
    z-index: 100;
  }

  .wiki-editor {
    overflow: visible;
  }

  :global(.wiki-rendered input[type="checkbox"]) {
    pointer-events: none;
  }

  :global([type="checkbox"]) {
    pointer-events: auto;
    cursor: pointer;
  }

  :global(.bn-inline-content a) {
    color: hsl(var(--p));
    text-decoration: underline;
    cursor: pointer;
  }

  :global(input[type="checkbox"]) {
    accent-color: hsl(var(--p));
    width: 16px;
    height: 16px;
    margin-right: 8px;
  }

  .tooltip-animate {
    animation: tooltipFadeIn 0.2s ease;
  }

  @keyframes tooltipFadeIn {
    from {
      opacity: 0;
      transform: translateY(5px) translateX(-50%);
    }
    to {
      opacity: 1;
      transform: translateY(0) translateX(-50%);
    }
  }

  .permanent-formatting-toolbar {
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
  }

  :global(.shiki) {
    margin: 0;
    padding: 1em;
    border-radius: 0.5em;
    overflow-x: auto;
    font-family: "Fira Code", monospace;
    font-size: 0.9em;
    line-height: 1.6;
    tab-size: 2;
  }

  :global(.shiki code) {
    display: block;
    padding: 0.5em;
    background: transparent;
  }

  :global(.wiki-rendered pre) {
    margin: 1em 0;
    border-radius: 0.5em;
    overflow: hidden;
    background-color: hsl(var(--n));
  }

  :global(.wiki-rendered code:not([class])) {
    padding: 0.2em 0.4em;
    margin: 0;
    background-color: hsl(var(--p) / 0.2);
    border-radius: 3px;
    font-family: "Fira Code", monospace;
    font-size: 0.85em;
  }

  :global(.code-block-wrapper) {
    position: relative;
    margin-top: 0.5em;
    width: inherit;
  }

  :global(.code-language-label) {
    position: absolute;
    top: 0;
    right: 0;
    background-color: hsl(var(--p) / 0.7);
    color: hsl(var(--pc));
    padding: 2px 8px;
    font-size: 0.75rem;
    border-bottom-left-radius: 4px;
    font-family: "Fira Code", monospace;
    z-index: 10;
    user-select: none;
  }

  :global(.bn-inline-content [data-mention]) {
    color: hsl(var(--p));
    background-color: hsl(var(--p) / 0.1);
    padding: 0 2px;
    border-radius: 2px;
    font-weight: 500;
  }

  :global(
    .bn-inline-content a[href^="channel-"],
    .bn-inline-content a[href^="thread/"],
    .bn-inline-content a[href^="thread-"]
  ) {
    color: hsl(var(--p)) !important;
    font-weight: 500;
    text-decoration: none !important;
    padding: 0 2px;
    background-color: hsl(var(--p) / 0.1);
    border-radius: 3px;
  }

  :global(
    .bn-inline-content a[href^="channel-"]:hover,
    .bn-inline-content a[href^="thread/"]:hover,
    .bn-inline-content a[href^="thread-"]:hover
  ) {
    background-color: hsl(var(--p) / 0.2);
  }
</style>
