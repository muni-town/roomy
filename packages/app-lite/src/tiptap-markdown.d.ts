import "tiptap-markdown";

declare module "@tiptap/core" {
  interface Storage {
    markdown: import("tiptap-markdown").MarkdownStorage;
  }
}
