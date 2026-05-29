/***
 * From Fox UI by Flo-bit
 * https://github.com/flo-bit/ui-kit/tree/main/packages/text/src/lib/components/rich-text-editor
 */

import { Node, mergeAttributes } from "@tiptap/core";
import { SvelteNodeViewRenderer } from "svelte-tiptap";

import ImageUploadComponent from "./ImageUploadComponent.svelte";

export type UploadFunction = (
  file: File,
  onProgress?: (event: { progress: number }) => void,
  abortSignal?: AbortSignal,
) => Promise<string>;

export interface ImageUploadNodeOptions {
  /**
   * Acceptable file types for upload.
   * @default 'image/*'
   */
  accept?: string;
  /**
   * Maximum number of files that can be uploaded.
   * @default 1
   */
  limit?: number;
  /**
   * Maximum file size in bytes (0 for unlimited).
   * @default 0
   */
  maxSize?: number;

  /**
   * Preview image URL.
   */
  preview?: string;
  /**
   * Function to handle the upload process.
   */
  upload?: UploadFunction;
  /**
   * Callback for upload errors.
   */
  onError?: (error: Error) => void;
  /**
   * Callback for successful uploads.
   */
  onSuccess?: (url: string) => void;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    imageUpload: {
      setImageUploadNode: (options?: ImageUploadNodeOptions) => ReturnType;
    };
  }
}

export const ImageUploadNode = Node.create<ImageUploadNodeOptions>({
  name: "imageUpload",
  group: "block",
  atom: true,
  draggable: true,
  selectable: false,
  inline: false,

  addAttributes() {
    return {
      accept: {
        default: this.options.accept,
      },
      limit: {
        default: this.options.limit,
      },
      maxSize: {
        default: this.options.maxSize,
      },
      preview: {
        default: this.options.preview,
      },
    };
  },

  addOptions() {
    return {
      accept: "image/*",
      limit: 1,
      maxSize: 0,
      upload: undefined,
      onError: undefined,
      onSuccess: undefined,
    };
  },

  addCommands() {
    return {
      setImageUploadNode:
        (options = {}) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: options,
          });
        },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="image-upload"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes({ "data-type": "image-upload" }, HTMLAttributes),
    ];
  },

  addNodeView() {
    return SvelteNodeViewRenderer(ImageUploadComponent);
  },
});
