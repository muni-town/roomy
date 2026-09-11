import type { Ulid } from "@roomy-space/sdk";
import type { Block } from "@roomy-space/sdk";
import type { Message } from "$lib/queries/messages";
import { setInputFocus } from "./ChatInput.svelte";
import { messageContentToPlaintext } from "./messagePreview";

export type Normal = {
  kind: "normal";
  input: string;
  files: File[];
  /** Rich-text blocks of the composer content (mention facets included), so a
   *  stashed draft restores mentions as chips, not plain text. */
  blocks: Block[];
  /** DIDs mentioned in the composer, mirrored from the editor on every update. */
  mentions: string[];
  /** Object URLs for attached-file previews, kept in sync with `files`. */
  previewImages: string[];
};

export type Replying = {
  kind: "replying";
  input: string;
  replyTo: Message | { id: Ulid };
  files: File[];
  blocks: Block[];
  mentions: string[];
  previewImages: string[];
};

export type Threading = {
  kind: "threading";
  name: string;
  selectedMessages: Message[];
};

export type Selecting = {
  kind: "selecting";
  selectedMessages: Message[];
};

export type MessagingState = Normal | Replying | Threading | Selecting;

function emptyDraft(): Normal {
  return { kind: "normal", input: "", files: [], blocks: [], mentions: [], previewImages: [] };
}

class MessagingStateManager {
  /** Per-room composer drafts, keyed by room id. A draft survives navigation
   *  away and is recalled on return. */
  private drafts = $state<Record<string, MessagingState>>({});
  private activeRoomId: string | null = $state(null);
  /** Fallback while no room is active (before the room page effect runs). */
  private fallback: MessagingState = $state(emptyDraft());

  /** The active room's draft. */
  private get state(): MessagingState {
    if (this.activeRoomId) {
      const draft = this.drafts[this.activeRoomId];
      if (draft) return draft;
    }
    return this.fallback;
  }

  private setState(newState: MessagingState) {
    if (this.activeRoomId) {
      this.drafts[this.activeRoomId] = newState;
    } else {
      this.fallback = newState;
    }
  }

  get current(): MessagingState {
    return this.state;
  }

  /** Switch the active composer draft to `roomId`, creating a fresh one on
   *  first visit. The previous room's draft stays in the map and is recalled
   *  on return. */
  setActiveRoom(roomId: string) {
    this.activeRoomId = roomId;
    if (!this.drafts[roomId]) {
      this.drafts[roomId] = emptyDraft();
    }
  }

  set(newState: MessagingState) {
    this.setState(newState);
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

  get blocks(): Block[] {
    return "blocks" in this.state ? this.state.blocks : [];
  }

  set blocks(value: Block[]) {
    if ("blocks" in this.state) {
      this.state.blocks = value;
    }
  }

  get mentions(): string[] {
    return "mentions" in this.state ? this.state.mentions : [];
  }

  set mentions(value: string[]) {
    if ("mentions" in this.state) {
      this.state.mentions = value;
    }
  }

  get previewImages(): string[] {
    return "previewImages" in this.state ? this.state.previewImages : [];
  }

  set previewImages(value: string[]) {
    if ("previewImages" in this.state) {
      this.state.previewImages = value;
    }
  }

  /** Push a preview URL onto a specific room's draft. Room-scoped so an async
   *  thumbnail resolving after the user switched rooms lands on the right
   *  draft, not the currently active one. */
  addPreviewImage(roomId: string, url: string) {
    const draft = this.drafts[roomId];
    if (draft && "previewImages" in draft) {
      draft.previewImages.push(url);
    }
  }

  setReplyTo(message: Message) {
    this.setState({
      ...this.state,
      kind: "replying",
      replyTo: message,
      files: "files" in this.state ? this.state.files : [],
      input: "input" in this.state ? this.state.input : "",
      blocks: "blocks" in this.state ? this.state.blocks : [],
      mentions: "mentions" in this.state ? this.state.mentions : [],
      previewImages: "previewImages" in this.state ? this.state.previewImages : [],
    });
    setInputFocus();
  }

  setNormal() {
    this.setState({
      kind: "normal",
      input: "input" in this.state ? this.state.input : "",
      files: "files" in this.state ? this.state.files : [],
      blocks: "blocks" in this.state ? this.state.blocks : [],
      mentions: "mentions" in this.state ? this.state.mentions : [],
      previewImages: "previewImages" in this.state ? this.state.previewImages : [],
    });
    setInputFocus();
  }

  toggleMessageSelection(message: Message) {
    if (
      this.state.kind !== "threading" &&
      this.state.kind !== "selecting"
    )
      return;
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
    const name = message
      ? messageContentToPlaintext(message.content, message.mimeType)
      : "Thread";
    this.setState({
      ...currentState,
      kind: "threading",
      name,
      selectedMessages: message ? [message] : [],
    });
    setInputFocus();
  }

  /** Enter select mode (Signal/WhatsApp-style multi-select). An optional
   *  first message is pre-selected (long-press / toolbar › Select). The
   *  composer draft (input/files/blocks) is preserved so canceling
   *  selection restores it. */
  startSelectMode(message?: Message) {
    console.debug("Start select mode", message);
    const currentState = this.state;
    this.setState({
      ...currentState,
      kind: "selecting",
      selectedMessages: message ? [message] : [],
    });
    closeToolbar();
  }

  setThreadingFromMessages(messages: Message[], name?: string) {
    console.debug("Start threading from messages", messages);
    const currentState = this.state;
    this.setState({
      ...currentState,
      kind: "threading",
      name: name ?? "Thread",
      selectedMessages: messages,
    });
    setInputFocus();
  }
}

export const messagingState = new MessagingStateManager();

// ── Mobile inline message toolbar ────────────────────────────────────────
// On touch devices there is no hover, so tapping a message toggles its inline
// toolbar. Only one message's toolbar can be open at a time: tapping another
// message moves it, tapping the same message closes it. Keyed by message id so
// a stale id from a previous room simply matches nothing.
let toolbarOpenMessageId = $state<string | null>(null);

export function toggleToolbar(messageId: string) {
  toolbarOpenMessageId = toolbarOpenMessageId === messageId ? null : messageId;
}

export function closeToolbar() {
  toolbarOpenMessageId = null;
}

export const toolbarOpenState = {
  get id(): string | null {
    return toolbarOpenMessageId;
  },
};
