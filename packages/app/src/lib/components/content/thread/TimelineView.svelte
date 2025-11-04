<script lang="ts" module>
  export type Normal = {
    kind: "normal";
    input: string;
    files: File[];
  };

  export type Replying = {
    kind: "replying";
    input: string;
    replyTo: Message | { id: string };
    files: File[];
  };

  export type Threading = {
    kind: "threading";
    name: string;
    selectedMessages: Message[];
  };

  export type Comment = {
    snippet: string; // limit length
    docVersion: string; // ULID of the edit version
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

  let messagingState: MessagingState = $state({
    kind: "normal",
    input: "",
    files: [],
  });

  export function setReplyTo(message: Message) {
    messagingState = {
      ...messagingState,
      kind: "replying",
      replyTo: message,
      files: "files" in messagingState ? messagingState.files : [],
      input: "input" in messagingState ? messagingState.input : "",
    };
    setInputFocus();
  }

  export function setCommenting(comment: Comment) {
    messagingState = {
      ...messagingState,
      kind: "commenting",
      comment,
      files: [],
      input: "input" in messagingState ? messagingState.input : "",
    };
    console.log("Commenting", comment);
    setInputFocus();
  }

  export function setNormal() {
    messagingState = {
      kind: "normal",
      input: "input" in messagingState ? messagingState.input : "",
      files: "files" in messagingState ? messagingState.files : [],
    };
    setInputFocus();
  }
</script>

<script lang="ts">
  import ChatArea, { type Message } from "./ChatArea.svelte";
  import ChatInputArea from "./ChatInputArea.svelte";
  import { setInputFocus } from "./ChatInput.svelte";

  function startThreading(message?: Message) {
    messagingState = {
      ...messagingState,
      kind: "threading",
      name: message ? `Thread: ${message.authorName}` : "Thread",
      selectedMessages: message ? [message] : [],
    };
    message && messagingState.selectedMessages.push(message);
    setInputFocus();
  }

  function toggleSelect(message: Message) {
    if (messagingState.kind !== "threading") return;
    let messageIdx = messagingState.selectedMessages.findIndex(
      (x) => x.id == message.id,
    );
    if (messageIdx != -1) {
      messagingState.selectedMessages.splice(messageIdx, 1);
    } else {
      messagingState.selectedMessages.push(message);
    }
  }
</script>

<div class="flex flex-col flex-1 h-full min-h-0 justify-stretch">
  <ChatArea {messagingState} {startThreading} {toggleSelect} />

  <div class="shrink-0 mt-auto">
    <ChatInputArea bind:messagingState />
  </div>
</div>
