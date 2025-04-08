<script lang="ts">
  import { onMount, onDestroy, untrack } from "svelte";
  import { Editor } from "@tiptap/core";
  import StarterKit from "@tiptap/starter-kit";
  import Placeholder from "@tiptap/extension-placeholder";
  import {
    type Item,
    initKeyboardShortcutHandler,
    initUserMention,
    initSpaceContextMention,
  } from "$lib/tiptap/editor";
  import { g } from "$lib/global.svelte";
  import { CustomImage, ImageUploadPlugin } from "$lib/tiptap/image-extension";
  import Icon from "@iconify/svelte";
  import { user } from "$lib/user.svelte";
  import toast from "svelte-french-toast";

  type Props = {
    content: Record<string, unknown>;
    users: Item[];
    context: Item[];
    onEnter: () => void;
  };

  let { content = $bindable({}), users, context, onEnter }: Props = $props();
  // These variables are used in the template via bind:this
  let element: HTMLDivElement | undefined = $state();
  let fileInput: HTMLInputElement | undefined = $state();
  const extensions = [
    StarterKit.configure({ heading: false }),
    Placeholder.configure({ placeholder: "Write something ..." }),
    initKeyboardShortcutHandler({ onEnter }),
    initUserMention({ users }),
    initSpaceContextMention({ context }),
    CustomImage,
    ImageUploadPlugin
  ];

  let tiptap: Editor | undefined = $state();

  function handleImageUpload(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files || !input.files.length) return;

    const file = input.files[0];
    if (file && !file.type.startsWith('image/')) {
      toast.error('Only image files are supported', { position: 'bottom-end' });
      return;
    }

    if (file && tiptap) {
      // Manually handle file input since ImageUploadPlugin only handles paste and drop
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          // Insert temporary image
          if (tiptap) {
            tiptap.commands.setImage({
              src: e.target?.result as string,
              alt: 'Uploading...',
              title: 'Uploading...'
            });

            // Upload the actual image
            const response = await user.uploadBlob(file);

            // Find and replace the placeholder with the uploaded image
            const state = tiptap.state;
            const { doc } = state;
            const tr = state.tr;

            doc.descendants((node: any, pos: number) => {
              if (node.type.name === 'image' && node.attrs.title === 'Uploading...') {
                const newNode = state.schema.nodes.image.create({
                  src: response.url,
                  alt: file.name || 'Image',
                  title: file.name || 'Image'
                });
                tr.replaceWith(pos, pos + node.nodeSize, newNode);
                return false;
              }
              return true;
            });

            tiptap.view.dispatch(tr);
          }
        } catch (error) {
          console.error('Failed to upload image:', error);
          toast.error('Failed to upload image', { position: 'bottom-end' });
        }
      };
      reader.readAsDataURL(file);
    }

    // Clear the input so the same file can be selected again
    input.value = '';
  }

  // We don't need a custom paste handler as ImageUploadPlugin handles this
  // The default paste behavior will be used, which triggers the plugin

  onMount(() => {
    tiptap = new Editor({
      element,
      extensions,
      content: content.type ? content : { type: "doc", children: [] },
      editorProps: {
        attributes: {
          class:
            "w-full pl-12 pr-3 py-2 rounded bg-base-300 text-base-content outline-none",
        },
      },
      onUpdate: (ctx) => {
        content = ctx.editor.getJSON();
      },
    });
  });

  $effect(() => {
    untrack(() => tiptap?.destroy());
    tiptap = new Editor({
      element,
      extensions,
      content: untrack(() =>
        content.type ? content : { type: "doc", children: [] },
      ),
      editorProps: {
        attributes: {
          class:
            "w-full pl-12 pr-3 py-2 rounded bg-base-300 text-base-content outline-none",
        },
      },
      onUpdate: (ctx) => {
        content = ctx.editor.getJSON();
      },
    });
  });

  onDestroy(() => {
    tiptap?.destroy();
  });
</script>

{#if !g.isBanned}
  <div class="relative">
    <div bind:this={element}></div>
    <div class="absolute left-3 top-1/2 -translate-y-1/2 flex items-center z-10">
      <label class="cursor-pointer p-1.5 rounded-full hover:bg-base-200 transition-colors">
        <input
          bind:this={fileInput}
          type="file"
          accept="image/*"
          class="hidden"
          onchange={handleImageUpload}
        />
        <Icon
          icon="material-symbols:add"
          class="text-lg text-base-content/70"
        />
      </label>
    </div>
  </div>
{:else}
  <div
    class="w-full pl-12 pr-3 py-2 rounded bg-base-300 text-base-content outline-none cursor-not-allowed"
  >
    Your account has been banned in this space.
  </div>
{/if}
