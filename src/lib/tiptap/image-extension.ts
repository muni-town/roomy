import { Extension } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { user } from '$lib/user.svelte';
import toast from 'svelte-french-toast';
import type { EditorView } from '@tiptap/pm/view';

// Helper function to handle image upload outside of the extension
function uploadImage(file: File, view: EditorView) {
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      // Show loading indicator or placeholder
      const { schema } = view.state;
      if (schema.nodes.image) {
        const node = schema.nodes.image.create({
          src: e.target?.result as string,
          alt: 'Uploading...',
          title: 'Uploading...',
        });
        const transaction = view.state.tr.replaceSelectionWith(node);
        view.dispatch(transaction);

        // Upload the image
        const response = await user.uploadBlob(file);

        // Replace the placeholder with the actual image
        const { doc } = view.state;
        const updatedTransaction = view.state.tr;

        doc.descendants((node, pos) => {
          if (node.type.name === 'image' && node.attrs.title === 'Uploading...') {
            if (schema.nodes.image) {
              const newNode = schema.nodes.image.create({
                src: response.url,
                alt: file.name,
                title: file.name,
              });
              updatedTransaction.replaceWith(pos, pos + node.nodeSize, newNode);
            }
            return false;
          }
          return true;
        });

        view.dispatch(updatedTransaction);
      }
    } catch (error) {
      console.error('Failed to upload image:', error);
      toast.error('Failed to upload image', { position: 'bottom-end' });
    }
  };
  reader.readAsDataURL(file);
}

export const ImageUploadPlugin = Extension.create({
  name: 'imageUpload',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('imageUpload'),
        props: {
          handlePaste: (view, event) => {
            const items = event.clipboardData?.items;
            if (!items) return false;

            for (const item of items) {
              if (item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (file) {
                  uploadImage(file, view);
                  return true;
                }
              }
            }
            return false;
          },
          handleDrop: (view, event) => {
            const hasFiles = event.dataTransfer?.files?.length;
            if (!hasFiles) return false;

            const images = Array.from(event.dataTransfer.files).filter(file =>
              file.type.startsWith('image/')
            );

            if (images.length === 0) return false;

            event.preventDefault();

            for (const image of images) {
              uploadImage(image, view);
            }

            return true;
          },
        },
      }),
    ];
  },
});

export const CustomImage = Image.configure({
  inline: true,
  allowBase64: true,
});
