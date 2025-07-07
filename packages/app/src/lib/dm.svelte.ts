import { user } from "./user.svelte";

export type Message = {
  id: string;
  text: string;
  sender: {
    did: string;
    handle: string;
    displayName?: string;
  };
  sentAt: string;
};

export type Participant = {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
};

export type Conversation = {
  id: string;
  participants: Participant[];
  lastMessage?: {
    text: string;
    sentAt: string;
  };
  unreadCount: number;
};

class DMClient {
  private initialized = false;

  /**
   * Initialize the DM client using the existing user agent
   * @returns {<boolean>} True if initialization was successful, false if user is not authenticated
   */
  init(): boolean {
    if (this.initialized) {
      return true;
    }
    // Check if user is authenticated
    if (!user?.agent || !user?.session) {
      console.warn("User not authenticated - cannot initialize DM client");
      return false;
    }

    this.initialized = true;
    return true;
  }

  async getConversations(): Promise<Conversation[]> {
    if (!user.agent) throw new Error("User not authenticated");

    // Use the official Bluesky chat API with service proxy header
    const response = await user.agent.chat.bsky.convo.listConvos(
      {},
      {
        headers: {
          "atproto-proxy": "did:web:api.bsky.chat#bsky_chat",
        },
      },
    );
    return response.data.convos.map((conv: any) => ({
      id: conv.id,
      participants: conv.members,
      lastMessage: conv.lastMessage && {
        text: conv.lastMessage.text,
        sentAt: conv.lastMessage.sentAt,
      },
      unreadCount: conv.unreadCount || 0,
    }));
  }

  async getMessages(conversationId: string): Promise<Message[]> {
    if (!user.agent) throw new Error("User not authenticated");

    const response = await user.agent.chat.bsky.convo.getMessages(
      {
        convoId: conversationId,
      },
      {
        headers: {
          "atproto-proxy": "did:web:api.bsky.chat#bsky_chat",
        },
      },
    );

    return response.data.messages.map((msg: any) => ({
      id: msg.id,
      text: msg.text,
      sender: {
        did: msg.sender.did,
        handle: msg.sender.handle,
        displayName: msg.sender.displayName,
      },
      sentAt: msg.sentAt,
    }));
  }

  async sendMessage(conversationId: string, text: string): Promise<void> {
    if (!user.agent) throw new Error("User not authenticated");

    await user.agent.chat.bsky.convo.sendMessage(
      {
        convoId: conversationId,
        message: {
          text,
        },
      },
      {
        headers: {
          "atproto-proxy": "did:web:api.bsky.chat#bsky_chat",
        },
      },
    );
  }

  async findOrCreateConversation(userHandleOrDid: string): Promise<string> {
    if (!user.agent) throw new Error("User not authenticated");

    // Resolve handle to DID
    let userDid: string;
    if (userHandleOrDid.startsWith("did:")) {
      userDid = userHandleOrDid;
    } else {
      const resolveResponse =
        await user.agent.com.atproto.identity.resolveHandle({
          handle: userHandleOrDid,
        });
      userDid = resolveResponse.data.did;
    }

    // Get or create conversation with the user
    const response = await user.agent.chat.bsky.convo.getConvoForMembers(
      {
        members: [userDid],
      },
      {
        headers: {
          "atproto-proxy": "did:web:api.bsky.chat#bsky_chat",
        },
      },
    );

    return response.data.convo.id;
  }

  async startConversation(
    userHandle: string,
    message?: string,
  ): Promise<string> {
    if (!user.agent) throw new Error("User not authenticated");

    const convoId = await this.findOrCreateConversation(userHandle);

    if (!message) return convoId;

    // Send initial message if provided
    await user.agent.chat.bsky.convo.sendMessage(
      {
        convoId,
        message: { text: message },
      },
      {
        headers: {
          "atproto-proxy": "did:web:api.bsky.chat#bsky_chat",
        },
      },
    );

    return convoId;
  }

  async markAsRead(conversationId: string, messageId?: string): Promise<void> {
    if (!user.agent) throw new Error("User not authenticated");

    await user.agent.chat.bsky.convo.updateRead(
      {
        convoId: conversationId,
        messageId: messageId,
      },
      {
        headers: {
          "atproto-proxy": "did:web:api.bsky.chat#bsky_chat",
        },
      },
    );
  }

  getCurrentUserDid(): string {
    if (!user.session?.did) {
      throw new Error("No authenticated user. Please log in first.");
    }
    return user.session.did;
  }

  /**
   * Get conversation details including status
   */
  async getConversationDetails(conversationId: string) {
    if (!user.agent) throw new Error("User not authenticated");

    const response = await user.agent.chat.bsky.convo.getConvo(
      {
        convoId: conversationId,
      },
      {
        headers: {
          "atproto-proxy": "did:web:api.bsky.chat#bsky_chat",
        },
      },
    );

    return response.data.convo;
  }

  async getUserProfile(did: string): Promise<{
    handle: string;
    displayName?: string;
    did: string;
    avatar?: string;
  }> {
    if (!user.agent) throw new Error("User not authenticated");

    try {
      const response = await user.agent.app.bsky.actor.getProfile({
        actor: did,
      });

      return {
        did: response.data.did,
        handle: response.data.handle,
        displayName: response.data.displayName,
        avatar: response.data.avatar,
      };
    } catch (error) {
      console.error("Failed to get user profile:", error);
      // Return a fallback profile
      return {
        did,
        handle: did.split(":").pop()?.substring(0, 8) + "..." || "unknown",
        displayName: undefined,
        avatar: undefined,
      };
    }
  }

  /**
   * Get the current session if available
   */
  getSession() {
    return user.session;
  }
}

// Create a singleton instance
export const dmClient = new DMClient();
