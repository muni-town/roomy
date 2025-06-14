import { user } from "./user.svelte";

type Message = {
  id: string;
  text: string;
  sender: {
    did: string;
    handle: string;
    displayName?: string;
  };
  sentAt: string;
};

type Conversation = {
  id: string;
  participants: Array<{
    did: string;
    handle: string;
    displayName?: string;
  }>;
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
   * @returns {Promise<boolean>} True if initialization was successful, false if user is not authenticated
   */
  async init(): Promise<boolean> {
    if (this.initialized) {
      console.log('DM client already initialized');
      return true;
    }
    
    try {
      console.log('Initializing DM client...');
      
      // Check if user is authenticated
      if (!user.agent || !user.session) {
        console.warn('User not authenticated - cannot initialize DM client');
        return false;
      }
      
      console.log('Using existing user agent for DM functionality');
      this.initialized = true;
      return true;
      
    } catch (error) {
      console.error('Failed to initialize DM client:', error);
      this.initialized = false;
      // Don't logout - just return false to indicate initialization failed
      return false;
    }
  }

  /**
   * Get list of conversations
   */
  async getConversations(): Promise<Conversation[]> {
    if (!user.agent) throw new Error('User not authenticated');
    
    try {
      // Use the official Bluesky chat API with service proxy header
      const response = await user.agent.api.chat.bsky.convo.listConvos({}, {
        headers: {
          'atproto-proxy': 'did:web:api.bsky.chat#bsky_chat'
        }
      });
      return response.data.convos.map((conv: any) => ({
        id: conv.id,
        participants: conv.members,
        lastMessage: conv.lastMessage && {
          text: conv.lastMessage.text,
          sentAt: conv.lastMessage.sentAt,
        },
        unreadCount: conv.unreadCount || 0,
      }));
    } catch (error) {
      console.error('Failed to fetch conversations:', error);
      throw error;
    }
  }

  /**
   * Get messages for a specific conversation
   */
  async getMessages(conversationId: string): Promise<Message[]> {
    if (!user.agent) throw new Error('User not authenticated');
    
    try {
      const response = await user.agent.api.chat.bsky.convo.getMessages({
        convoId: conversationId,
      }, {
        headers: {
          'atproto-proxy': 'did:web:api.bsky.chat#bsky_chat'
        }
      });
      
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
    } catch (error) {
      console.error('Failed to fetch messages:', error);
      throw error;
    }
  }

  /**
   * Send a message to a conversation
   */
  async sendMessage(conversationId: string, text: string): Promise<void> {
    if (!user.agent) throw new Error('User not authenticated');
    
    try {
      await user.agent.api.chat.bsky.convo.sendMessage({
        convoId: conversationId,
        message: {
          text,
        },
      }, {
        headers: {
          'atproto-proxy': 'did:web:api.bsky.chat#bsky_chat'
        }
      });
    } catch (error) {
      console.error('Failed to send message:', error);
      throw error;
    }
  }

  /**
   * Find existing conversation with a user or create a new one
   */
  async findOrCreateConversation(userHandle: string): Promise<string> {
    if (!user.agent) throw new Error('User not authenticated');
    
    try {
      // Resolve handle to DID
      let userDid: string;
      if (userHandle.startsWith('did:')) {
        userDid = userHandle;
      } else {
        const resolveResponse = await user.agent.api.com.atproto.identity.resolveHandle({
          handle: userHandle
        });
        userDid = resolveResponse.data.did;
      }
      
      console.log('Looking for conversation with DID:', userDid);
      
      // Get or create conversation with the user
      const response = await user.agent.api.chat.bsky.convo.getConvoForMembers({
        members: [userDid]
      }, {
        headers: {
          'atproto-proxy': 'did:web:api.bsky.chat#bsky_chat'
        }
      });
      
      console.log('Conversation response:', response.data);
      
      return response.data.convo.id;
    } catch (error) {
      console.error('Failed to find or create conversation:', error);
      throw error;
    }
  }

  /**
   * Start a new conversation with a user and optionally send a message
   */
  async startConversation(userHandle: string, message: string): Promise<string> {
    if (!user.agent) throw new Error('User not authenticated');
    
    try {
      const convoId = await this.findOrCreateConversation(userHandle);
      
      // Send initial message if provided
      if (message) {
        await user.agent.api.chat.bsky.convo.sendMessage({
          convoId,
          message: { text: message }
        }, {
          headers: {
            'atproto-proxy': 'did:web:api.bsky.chat#bsky_chat'
          }
        });
      }
      
      return convoId;
    } catch (error) {
      console.error('Failed to start conversation:', error);
      throw error;
    }
  }

  /**
   * Mark a conversation as read
   */
  async markAsRead(conversationId: string, messageId?: string): Promise<void> {
    if (!user.agent) throw new Error('User not authenticated');
    
    try {
      await user.agent.api.chat.bsky.convo.updateRead({
        convoId: conversationId,
        messageId: messageId,
      }, {
        headers: {
          'atproto-proxy': 'did:web:api.bsky.chat#bsky_chat'
        }
      });
    } catch (error) {
      console.error('Failed to mark conversation as read:', error);
      throw error;
    }
  }

  /**
   * Get the DID of the currently authenticated user
   */
  getCurrentUserDid(): string {
    if (!user.session?.did) {
      throw new Error('No authenticated user. Please log in first.');
    }
    return user.session.did;
  }

  /**
   * Get conversation details including status
   */
  async getConversationDetails(conversationId: string) {
    if (!user.agent) throw new Error('User not authenticated');
    
    try {
      const response = await user.agent.api.chat.bsky.convo.getConvo({
        convoId: conversationId
      }, {
        headers: {
          'atproto-proxy': 'did:web:api.bsky.chat#bsky_chat'
        }
      });
      
      return response.data.convo;
    } catch (error) {
      console.error('Failed to get conversation details:', error);
      throw error;
    }
  }

  /**
   * Get user profile information by DID
   */
  async getUserProfile(did: string): Promise<{ handle: string; displayName?: string; did: string; avatar?: string }> {
    if (!user.agent) throw new Error('User not authenticated');
    
    try {
      const response = await user.agent.api.app.bsky.actor.getProfile({
        actor: did
      });
      
      return {
        did: response.data.did,
        handle: response.data.handle,
        displayName: response.data.displayName,
        avatar: response.data.avatar
      };
    } catch (error) {
      console.error('Failed to get user profile:', error);
      // Return a fallback profile
      return {
        did,
        handle: did.split(':').pop()?.substring(0, 8) + '...' || 'unknown',
        displayName: undefined,
        avatar: undefined
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
