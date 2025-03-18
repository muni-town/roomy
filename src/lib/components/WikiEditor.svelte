<script lang="ts">
  import { codeToHtml } from 'shiki';
  import { BlockNoteEditor } from "@blocknote/core";
  import "@blocknote/core/style.css";
  import { onMount } from "svelte";
  import { toast } from "svelte-french-toast";
  import { Button } from "bits-ui";
  import Icon from "@iconify/svelte";
  import { page } from "$app/state";
  import type { Autodoc } from "$lib/autodoc/peer";
  import type { Space, Channel } from "$lib/schemas/types";
  import type { Highlighter } from 'shiki';
  import { getContext, setContext } from "svelte";
  import type { Item } from '$lib/tiptap/editor';
  import Link from '@tiptap/extension-link';

  const { space, channel, isAdmin } = $props<{
    space: Autodoc<Space>;
    channel: Channel;
    isAdmin: boolean;
  }>();

  let wikiContent = $state(channel?.wiki?.content || null);
  let wikiRenderedHtml = $state(channel?.wiki?.html || "");
  let processedHtml = $state("");
  let isEditingWiki = $state(false);
  let editorElement: HTMLElement;
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

  let mentionMenuVisible = $state(false);
  let mentionMenuPosition = $state({ x: 0, y: 0 });
  let filteredUsers = $state<any[]>([]);
  let mentionQuery = $state("");

  let hashMenuVisible = $state(false);
  let hashMenuPosition = $state({ x: 0, y: 0 });
  let filteredItems = $state<{id: string, name: string, type: 'thread' | 'channel'}[]>([]);
  let hashQuery = $state("");

  let selectionTooltipVisible = $state(false);
  let selectionTooltipPosition = $state({ x: 0, y: 0 });
  let formatCommands = $state([
    { name: "Bold", icon: "tabler:bold", action: () => editor?.toggleStyles({bold: true}) },
    { name: "Italic", icon: "tabler:italic", action: () => editor?.toggleStyles({italic: true}) },
    { name: "Underline", icon: "tabler:underline", action: () => editor?.toggleStyles({underline: true}) },
    { name: "Strike", icon: "tabler:strikethrough", action: () => editor?.toggleStyles({strike: true}) },
    { name: "Link", icon: "tabler:link", action: () => addLinkToSelection() }
  ]);

  let urlPromptVisible = $state(false);
  let urlInputValue = $state("https://");
  let urlPromptCallback: ((url: string) => void) | null = $state(null);

  let wikiRelatedThreads = $derived(() => {
    if (!space || !channel?.wiki?.relatedThreads) return {};

    const threads: { [key: string]: any } = {};
    for (const threadId of channel.wiki.relatedThreads) {
      if (space.view.threads[threadId]) {
        threads[threadId] = space.view.threads[threadId];
      }
    }
    return threads;
  });

  function setEditingWiki(value: boolean) {
    if (value && !isAdmin) {
      toast.error("Only admins can edit the wiki", { position: "bottom-end" });
      return;
    }

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
          const wouldOverflow = top + 20 + menuHeight > viewportHeight + scrollY;
          const yPosition = wouldOverflow
            ? Math.max(scrollY, top - menuHeight - 10)
            : top + 20;
          slashMenuPosition = { x: left, y: yPosition };
          mentionMenuVisible = false;
          hashMenuVisible = false;
        } 
        // Handle mentions
        else if (content.text.endsWith('@')) {
          mentionMenuVisible = true;
          mentionQuery = "";
          const { top, left } = editor.getSelectionBoundingBox()?.toJSON();
          const menuHeight = 300;
          const viewportHeight = window.innerHeight;
          const scrollY = window.scrollY;
          const wouldOverflow = top + 20 + menuHeight > viewportHeight + scrollY;
          const yPosition = wouldOverflow
            ? Math.max(scrollY, top - menuHeight - 10)
            : top + 20;
          mentionMenuPosition = { x: left, y: yPosition };
          updateFilteredUsers();
          slashMenuVisible = false;
          hashMenuVisible = false;
        }
        // Handle hashtags
        else if (content.text.endsWith('#')) {
          hashMenuVisible = true;
          hashQuery = "";
          const { top, left } = editor.getSelectionBoundingBox()?.toJSON();
          const menuHeight = 300;
          const viewportHeight = window.innerHeight;
          const scrollY = window.scrollY;
          const wouldOverflow = top + 20 + menuHeight > viewportHeight + scrollY;
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
          const atIndex = text.lastIndexOf('@');
          
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
          const hashIndex = text.lastIndexOf('#');
          
          if (hashIndex !== -1) {
            hashQuery = text.substring(hashIndex + 1);
            updateFilteredItems();
          } else {
            hashMenuVisible = false;
          }
        }
        else {
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
            x: rect.left + (rect.width / 2),
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

  function executeSlashCommand(command: { name?: string; icon?: string; action: any; }) {
    if (!editor) return;
    const pos = editor.getTextCursorPosition();
    command.action();
    editor.updateBlock(pos.block.id, { content: [] });
    editor.setTextCursorPosition(pos.block.id, "start");
    slashMenuVisible = false;
  }

  function executeFormatCommand(command: { name?: string; icon?: string; action: any; }) {
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
      .filter(user => user.label?.toLowerCase().includes(query))
      .slice(0, 10); // Limit to 10 results
  }

  // Filter channels and threads based on hash query
  function updateFilteredItems() {
    if (!space) {
      filteredItems = [];
      return;
    }
    
    const query = hashQuery.toLowerCase();
    const items: {id: string, name: string, type: 'thread' | 'channel'}[] = [];
    
    // Add channels
    if (space.view.channels) {
      Object.entries(space.view.channels).forEach(([id, channel]) => {
        if (channel.name && channel.name.toLowerCase().includes(query)) {
          items.push({
            id,
            name: channel.name,
            type: 'channel'
          });
        }
      });
    }
    
    if (space.view?.threads) {
      Object.entries(space.view.threads).forEach(([id, thread]) => {
        const name = thread.title || thread.firstMsg?.text?.substring(0, 30) || id;
        if (name.toLowerCase().includes(query)) {
          items.push({
            id,
            name: name + (thread.title ? '' : '...'),
            type: 'thread'
          });
        }
      });
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
        const atIndex = text.lastIndexOf('@');
        
        if (atIndex !== -1) {
          const newText = text.substring(0, atIndex) + `@${user.label}`;
          
          editor.updateBlock(block.id, { 
            content: [{ 
              type: "text", 
              text: newText,
              styles: {
                backgroundColor: "#8b5cf6",
              } 
            }]
          });
          editor.insertBlocks([{type: "paragraph", content: ""}], block.id, "after");
          editor.setSelection(block.id,editor.getNextBlock(block.id)?.id ?? block.id);
          editor.createLink(user.label.startsWith('https://') ? user.label : `https://${user.label}`);
          

          editor.setTextCursorPosition(block.id, "end");
        }
      }
      
      mentionMenuVisible = false;
    } catch (e) {
      console.error("Error inserting mention:", e);
      mentionMenuVisible = false;
    }
  }

  function insertHashLink(item: {id: string, name: string, type: 'thread' | 'channel'}) {
    if (!editor) return;
    
    try {
      const cursorPosition = editor.getTextCursorPosition();
      if (!cursorPosition) return;
      
      const block = cursorPosition.block;
      const content = Array.isArray(block.content) ? block.content[0] : null;
      
      if (content && content.type === "text") {
        const text = content.text;
        const hashIndex = text.lastIndexOf('#');
        
        if (hashIndex !== -1) {
          const newText = text.substring(0, hashIndex) + `#${item.name}`;
          
          editor.updateBlock(block.id, { 
            content: [{ 
              type: "text", 
              text: newText,
              styles: {
                backgroundColor: "#8b5cf6",
                textColor: "white"
              } 
            }]
          });
          
          editor.insertBlocks([{type: "paragraph", content: ""}], block.id, "after");
          
          editor.setSelection(block.id, editor.getNextBlock(block.id)?.id ?? block.id);
          
          
          const linkId =
            item.type === "channel"
              ? `/space/${page.params.space}/${item.id}`
              : `/space/${page.params.space}/thread/${item.id}`;
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
          editor = BlockNoteEditor.create({_extensions: {link: Link.configure({
        HTMLAttributes: {
          target: null,
        },
      })}});

      editor.mount(editorElement);
      editor.onChange(EditorHandler);
      editor.onSelectionChange(SelectionHandler);
      let targetBlockId = null;
      editorElement.addEventListener('click', (e) => {
        const blockElement = (e.target as Element)?.closest('.bn-block');
        if (blockElement) {
          const blockRect = blockElement.getBoundingClientRect();
          if (e.clientX < blockRect.left + 24) {
            e.preventDefault();
            e.stopPropagation();
            const blockId = blockElement.getAttribute('data-id');
            if (!blockId) return;
            slashMenuPosition = { x: blockRect.left + 30, y: e.clientY };
            slashMenuVisible = true;
            targetBlockId = blockId;
          }
        }
      });
      if (wikiContent) {
        try {
          const parsedContent = JSON.parse(wikiContent);
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
      const doc = parser.parseFromString(wikiRenderedHtml, 'text/html');
      
      // Find all code blocks with language class
      const codeBlocks = doc.querySelectorAll('pre code');
      
      for (const codeBlock of codeBlocks) {
        const languageMatch = codeBlock.className.match(/language-(\w+)/);
        if (!languageMatch) continue;
        
        const language = languageMatch[1];
        const code = codeBlock.textContent || '';
        
        try {
          const highlightedCode = await codeToHtml(code, {
            lang: language,
            theme: 'vitesse-dark'
          });
          
          // Replace the code block with highlighted version
          const preElement = codeBlock.parentElement;
          if (preElement) {
            const tempContainer = document.createElement('div');
            tempContainer.innerHTML = highlightedCode;
            
            const labelDiv = document.createElement('div');
            labelDiv.className = 'code-language-label';
            labelDiv.textContent = formatLanguageName(language);
            
            const shikiElement = tempContainer.firstElementChild;
            if (shikiElement) {
              const wrapper = document.createElement('div');
              wrapper.className = 'code-block-wrapper';
              wrapper.appendChild(labelDiv);
              wrapper.appendChild(shikiElement);
              
              preElement.replaceWith(wrapper);
            } else {
              preElement.replaceWith(tempContainer.firstElementChild);
            }
          }
        } catch (e) {
          console.error(`Failed to highlight code for language ${language}:`, e);
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
      svelte: "Svelte"
    };
    
    return languageMap[lang] || lang.charAt(0).toUpperCase() + lang.slice(1);
  }

  $effect(() => {
    if (wikiRenderedHtml) {
      processCodeBlocks();
    }
  });

  async function saveWikiContent() {
    if (!editor || !space) return;
    try {
      const content = JSON.stringify(editor.document);
      const html = await editor.blocksToFullHTML(editor.document);
      
      const channelId = page?.params?.channel;
      
      space.change((doc: { channels: { [x: string]: { wiki: { content: string; html: string; lastUpdated: number; relatedThreads: string[]; }; }; }; }) => {
        if (!channelId) return;
        
        if (!doc.channels[channelId].wiki) {
          doc.channels[channelId].wiki = {
            content,
            html,
            relatedThreads: [],
            lastUpdated: Date.now(),
          };
        } else {
          doc.channels[channelId].wiki.content = content;
          doc.channels[channelId].wiki.html = html;
          doc.channels[channelId].wiki.lastUpdated = Date.now();
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

  $effect(() => {
    if (channel?.wiki) {
      wikiContent = channel.wiki.content;
      wikiRenderedHtml = channel.wiki.html || "";
    }
  });

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
          <div class="permanent-formatting-toolbar bg-violet-900 border border-violet-700 rounded-lg shadow-lg p-1 mb-4 flex items-center">
            {#each formatCommands as command}
              <button
                class="p-2 hover:bg-violet-800 text-white rounded-md"
                title={command.name}
                onclick={() => executeFormatCommand(command)}
              >
                <Icon icon={command.icon} class="text-xl" />
              </button>
            {/each}
            <div class="ml-2 border-l border-violet-600 h-6"></div>
            {#each slashCommands as command, i}
              {#if i < 3}
                <button
                  class="p-2 hover:bg-violet-800 text-white rounded-md"
                  title={command.name}
                  onclick={() => executeSlashCommand(command)}
                >
                  <Icon icon={command.icon} class="text-xl" />
                </button>
              {/if}
            {/each}
          </div>
          
          <div bind:this={editorElement} class="min-h-[400px]"></div>

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

          {#if mentionMenuVisible && isAdmin}
            <div
              class="mention-menu bg-violet-900 border border-violet-700 rounded shadow-lg absolute z-50"
              style="left: {mentionMenuPosition.x}px; top: {mentionMenuPosition.y}px;"
            >
              <div class="py-1 max-h-[300px] overflow-y-auto min-w-[200px]">
                {#if filteredUsers.length > 0}
                  <ul>
                    {#each filteredUsers as user}
                      <li>
                        <button
                          class="flex items-center gap-2 w-full text-left px-4 py-2 hover:bg-violet-800 text-white"
                          onclick={() => insertUserMention(user)}
                        >
                          <div class="w-6 h-6 rounded-full bg-violet-600 flex items-center justify-center overflow-hidden">
                            <span class="text-xs font-bold">{user.label[0]?.toUpperCase() || '?'}</span>
                          </div>
                          <span>{user.label}</span>
                        </button>
                      </li>
                    {/each}
                  </ul>
                {:else}
                  <div class="px-4 py-2 text-gray-300">No users found</div>
                {/if}
              </div>
            </div>
          {/if}

          {#if hashMenuVisible && isAdmin}
            <div
              class="hash-menu bg-violet-900 border border-violet-700 rounded shadow-lg absolute z-50"
              style="left: {hashMenuPosition.x}px; top: {hashMenuPosition.y}px;"
            >
              <div class="py-1 max-h-[300px] overflow-y-auto min-w-[250px]">
                {#if filteredItems.length > 0}
                  <ul>
                    {#each filteredItems as item}
                      <li>
                        <button
                          class="flex items-center gap-2 w-full text-left px-4 py-2 hover:bg-violet-800 text-white"
                          onclick={() => insertHashLink(item)}
                        >
                          <div class="w-6 h-6 rounded flex items-center justify-center overflow-hidden">
                            <Icon 
                              icon={item.type === 'channel' ? 'tabler:hash' : 'tabler:message-circle'} 
                              class="text-violet-300 text-lg" 
                            />
                          </div>
                          <span>{item.name}</span>
                          <span class="text-xs text-violet-300 ml-auto">{item.type}</span>
                        </button>
                      </li>
                    {/each}
                  </ul>
                {:else}
                  <div class="px-4 py-2 text-gray-300">No channels or threads found</div>
                {/if}
              </div>
            </div>
          {/if}

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
          {@html processedHtml}
        </div>
      </div>
    </section>
  {/if}
</div>

{#if urlPromptVisible}
  <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-[100]">
    <div class="bg-violet-900 border border-violet-700 rounded-lg shadow-lg p-6 max-w-md w-full">
      <h3 class="text-lg font-bold text-white mb-4">Add Link</h3>
      <form onsubmit={submitUrlPrompt} class="flex flex-col gap-4">
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
  
  :global(.wiki-editor-container .admin-mode .bn-block::before){
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
  
  :global(.wiki-editor-container .admin-mode .bn-block:hover::before){
    opacity: 1;
  }
  
  :global(.wiki-editor-container .admin-mode .bn-block::before:hover ){
    background-color: rgba(139, 92, 246, 0.2);
  }
  
  :global(.wiki-editor){
    color: #fff;
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

  :global([type="checkbox"]){
    pointer-events: auto; 
    cursor: pointer;
  }

  :global(.bn-inline-content a){
    color: #8b5cf6;
    text-decoration: underline;
    cursor: pointer;
  }
  
  :global(input[type="checkbox"]){
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
  
  .selection-tooltip {
    animation: tooltipFadeIn 0.2s ease;
  }
  
  @keyframes tooltipFadeIn {
    from { opacity: 0; transform: translateY(5px) translateX(-50%); }
    to { opacity: 1; transform: translateY(0) translateX(-50%); }
  }

  .permanent-formatting-toolbar {
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
  }
  
  .permanent-formatting-toolbar button {
    transition: background-color 0.15s ease;
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  :global(.shiki) {
    margin: 0;
    padding: 1em;
    border-radius: 0.5em;
    overflow-x: auto;
    font-family: 'Fira Code', monospace;
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
    background-color: #292d3e; 
  }

  :global(.wiki-rendered code:not([class])) {
    padding: 0.2em 0.4em;
    margin: 0;
    background-color: rgba(139, 92, 246, 0.2);
    border-radius: 3px;
    font-family: 'Fira Code', monospace;
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
    background-color: rgba(139, 92, 246, 0.7);
    color: white;
    padding: 2px 8px;
    font-size: 0.75rem;
    border-bottom-left-radius: 4px;
    font-family: 'Fira Code', monospace;
    z-index: 10;
    user-select: none;
  }

  .mention-menu {
    min-width: 200px;
    max-width: 300px;
    max-height: 300px;
    overflow-y: auto;
    z-index: 100;
  }
  
  :global(.bn-inline-content [data-mention]) {
    color: #a78bfa;
    background-color: rgba(167, 139, 250, 0.1);
    padding: 0 2px;
    border-radius: 2px;
    font-weight: 500;
  }

  .hash-menu {
    min-width: 250px;
    max-width: 350px;
    max-height: 300px;
    overflow-y: auto;
    z-index: 100;
  }
  
  :global(.bn-inline-content a[href^="channel-"], 
          .bn-inline-content a[href^="thread/"], 
          .bn-inline-content a[href^="thread-"]) {
    color: #8b5cf6 !important;
    font-weight: 500;
    text-decoration: none !important;
    padding: 0 2px;
    background-color: rgba(139, 92, 246, 0.1);
    border-radius: 3px;
  }

  :global(.bn-inline-content a[href^="channel-"]:hover, 
          .bn-inline-content a[href^="thread/"]:hover, 
          .bn-inline-content a[href^="thread-"]:hover) {
    background-color: rgba(139, 92, 246, 0.2);
  }
</style>