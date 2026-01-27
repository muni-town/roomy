<script lang="ts" module>
  import { setInputFocus } from "./ChatInput.svelte";
  import { renderMarkdownPlaintext } from "$lib/utils/markdown";
  import type { Message } from "./types";

  export type Normal = {
    kind: "normal";
    input: string;
    files: File[];
  };

  export type Replying = {
    kind: "replying";
    input: string;
    replyTo: Message | { id: Ulid };
    files: File[];
  };

  export type Threading = {
    kind: "threading";
    name: string;
    selectedMessages: Message[];
  };

  export type Comment = {
    snippet?: string; // limit length
    docVersion: Ulid; // ULID of the edit version
    from: number;
    to: number;
  };

  export type Commenting = {
    kind: "commenting";
    input: string;
    comment: Comment;
    files: File[];
  };

  export type MessagingState = Normal | Replying | Threading | Commenting;

  class MessagingStateManager {
    private state: MessagingState = $state({
      kind: "normal",
      input: "",
      files: [],
    });

    get current(): MessagingState {
      return this.state;
    }

    set(newState: MessagingState) {
      this.state = newState;
    }

    get input(): string {
      return "input" in this.state ? this.state.input : "";
    }

    set input(value: string) {
      if ("input" in this.state) {
        this.state.input = value;
      }
    }

    get name(): string {
      return this.state.kind === "threading" ? this.state.name : "";
    }

    set name(value: string) {
      if (this.state.kind === "threading") {
        this.state.name = value;
      }
    }

    get files(): File[] {
      return "files" in this.state ? this.state.files : [];
    }

    addFile(file: File) {
      if ("files" in this.state) {
        this.state.files.push(file);
      }
    }

    removeFile(index: number) {
      if ("files" in this.state) {
        this.state.files = this.state.files.filter((_, i) => i !== index);
      }
    }

    setReplyTo(message: Message) {
      this.state = {
        ...this.state,
        kind: "replying",
        replyTo: message,
        files: "files" in this.state ? this.state.files : [],
        input: "input" in this.state ? this.state.input : "",
      };
      setInputFocus();
    }

    setCommenting(comment: Comment) {
      this.state = {
        ...this.state,
        kind: "commenting",
        comment,
        files: [],
        input: "input" in this.state ? this.state.input : "",
      };
      console.log("Commenting", comment);
      setInputFocus();
    }

    setNormal() {
      this.state = {
        kind: "normal",
        input: "input" in this.state ? this.state.input : "",
        files: "files" in this.state ? this.state.files : [],
      };
      setInputFocus();
    }

    toggleMessageSelection(message: Message) {
      if (this.state.kind !== "threading") return;
      const messages = new Map(
        this.state.selectedMessages.map((m) => [m.id, m]),
      );

      if (messages.has(message.id)) {
        messages.delete(message.id);
      } else {
        messages.set(message.id, message);
      }
      this.state.selectedMessages = Array.from(messages.values());
    }

    startThreading(message?: Message) {
      console.debug("Start threading", message);
      const currentState = this.state;
      const name = message ? renderMarkdownPlaintext(message.content) : "Thread";
      this.state = {
        ...currentState,
        kind: "threading",
        name,
        selectedMessages: message ? [message] : [],
      };
      setInputFocus();
    }

    setThreadingFromMessages(messages: Message[], name?: string) {
      console.debug("Start threading from messages", messages);
      const currentState = this.state;
      this.state = {
        ...currentState,
        kind: "threading",
        name: name ?? "Thread",
        selectedMessages: messages,
      };
      setInputFocus();
    }
  }

  export const messagingState = new MessagingStateManager();
</script>

<script lang="ts">
  import ChatArea from "./ChatArea.svelte";
  import ChatInputArea from "./ChatInputArea.svelte";
  import type { Ulid } from "@roomy/sdk";
</script>

<div class="flex flex-col flex-1 h-full min-h-0 justify-stretch">
  <ChatArea messagingState={messagingState.current} />

  <div class="shrink-0 mt-auto">
    <ChatInputArea />
  </div>
</div>
