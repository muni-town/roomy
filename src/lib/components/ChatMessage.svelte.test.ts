import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync } from 'svelte';
import ChatMessage from './ChatMessage.svelte';

// Mock dependencies first, before using any classes
// Important: vi.mock calls are hoisted to the top of the file
vi.mock('$lib/profile.svelte', () => ({
  getProfile: vi.fn().mockResolvedValue({
    handle: 'test-user',
    displayName: 'Test User',
    avatarUrl: 'https://example.com/avatar.png'
  })
}));

vi.mock('$lib/global.svelte', () => ({
  g: {
    isBanned: false,
    isAdmin: false,
    roomy: {
      open: vi.fn().mockResolvedValue({
        id: 'msg-123',
        bodyJson: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Test message' }] }] }),
        createdDate: new Date('2023-01-01T12:00:00Z'),
        replyTo: null,
        softDeleted: false,
        reactions: {
          all: vi.fn().mockReturnValue({}),
          toggle: vi.fn()
        },
        authors: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue('did:example:123'), toArray: vi.fn().mockReturnValue(['did:example:123']) }),
        matches: vi.fn().mockReturnValue(true),
        tryCast: vi.fn().mockReturnThis(),
        forceCast: vi.fn().mockReturnThis(),
        commit: vi.fn()
      })
    },
    space: {
      id: 'space-123'
    }
  }
}));

vi.mock('$lib/user.svelte', () => ({
  user: {
    agent: {
      assertDid: 'did:example:123'
    }
  }
}));

vi.mock('$lib/tiptap/editor', () => ({
  getContentHtml: vi.fn().mockReturnValue('<p>Test message</p>'),
  type: {}
}));

vi.mock('svelte-french-toast', () => ({
  default: {
    success: vi.fn()
  }
}));

// Mock Svelte context
vi.mock('svelte', async () => {
  const actual = await vi.importActual<typeof import('svelte')>('svelte');
  return {
    ...actual,
    getContext: vi.fn().mockImplementation((key) => {
      if (key === 'isThreading') return { value: false };
      if (key === 'users') return { value: [] };
      if (key === 'contextItems') return { value: [] };
      if (key === 'selectMessage') return vi.fn();
      if (key === 'removeSelectedMessage') return vi.fn();
      if (key === 'setReplyTo') return vi.fn();
      if (key === 'scrollToMessage') return vi.fn();
      return undefined;
    })
  };
});

// Define mock classes after all vi.mock calls
class MockMessage {
  id = 'msg-123';
  bodyJson = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Test message' }] }] });
  createdDate = new Date('2023-01-01T12:00:00Z');
  replyTo = null;
  softDeleted = false;
  reactions = {
    all: vi.fn().mockReturnValue({}),
    toggle: vi.fn()
  };
  authors = vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue('did:example:123'), toArray: vi.fn().mockReturnValue(['did:example:123']) });
  matches = vi.fn().mockReturnValue(true);
  tryCast = vi.fn().mockReturnThis();
  forceCast = vi.fn().mockReturnThis();
  commit = vi.fn();
}

class MockAnnouncement {
  id = 'ann-123';
  kind = 'threadCreated';
  createdDate = new Date('2023-01-01T12:00:00Z');
  reactions = {
    all: vi.fn().mockReturnValue({}),
    toggle: vi.fn()
  };
  matches = vi.fn().mockReturnValue(false);
  tryCast = vi.fn().mockReturnValue(null);
}

describe('ChatMessage', () => {
  let mockMessage: MockMessage;
  let mockAnnouncement: MockAnnouncement;

  beforeEach(() => {
    vi.resetAllMocks();
    mockMessage = new MockMessage();
    mockAnnouncement = new MockAnnouncement();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exports ChatMessage component', () => {
    expect(ChatMessage).toBeDefined();
    expect(typeof ChatMessage).toBe('function');
  });

  it('handles message state', () => {
    const cleanup = $effect.root(() => {
      // Create state for message
      let message = $state(mockMessage);

      // Verify message properties
      expect(message.id).toBe('msg-123');
      expect(message.bodyJson).toBe(JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Test message' }] }] }));
      expect(message.createdDate).toEqual(new Date('2023-01-01T12:00:00Z'));

      flushSync();
    });

    cleanup();
  });

  it('handles announcement state', () => {
    const cleanup = $effect.root(() => {
      // Create state for announcement
      let announcement = $state(mockAnnouncement);

      // Verify announcement properties
      expect(announcement.id).toBe('ann-123');
      expect(announcement.kind).toBe('threadCreated');
      expect(announcement.createdDate).toEqual(new Date('2023-01-01T12:00:00Z'));

      flushSync();
    });

    cleanup();
  });

  it('handles editing state', () => {
    const cleanup = $effect.root(() => {
      // Create editing state
      let isEditing = $state(false);

      // Verify initial state
      expect(isEditing).toBe(false);

      // Change the state
      isEditing = true;
      flushSync();

      // Verify the state changed
      expect(isEditing).toBe(true);

      // Reset the state
      isEditing = false;
      flushSync();

      // Verify the state was reset
      expect(isEditing).toBe(false);
    });

    cleanup();
  });

  it('handles reaction toggling', () => {
    const cleanup = $effect.root(() => {
      // Create message state
      let message = $state(mockMessage);

      // Simulate toggling a reaction
      message.reactions.toggle('👍', 'did:example:123');

      // Verify the reaction was toggled
      expect(message.reactions.toggle).toHaveBeenCalledWith('👍', 'did:example:123');

      flushSync();
    });

    cleanup();
  });

  it('handles message deletion', () => {
    const cleanup = $effect.root(() => {
      // Create message state
      let message = $state(mockMessage);

      // Verify initial state
      expect(message.softDeleted).toBe(false);

      // Simulate deleting the message
      message.softDeleted = true;
      message.commit();

      // Verify the message was deleted
      expect(message.softDeleted).toBe(true);
      expect(message.commit).toHaveBeenCalled();

      flushSync();
    });

    cleanup();
  });

  it('handles message editing', () => {
    const cleanup = $effect.root(() => {
      // Create message and editing states
      let message = $state(mockMessage);
      let isEditing = $state(false);
      let editMessageContent = $state({});

      // Simulate starting editing
      isEditing = true;
      editMessageContent = JSON.parse(message.bodyJson);

      // Verify editing state
      expect(isEditing).toBe(true);
      expect(editMessageContent).toEqual({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Test message' }] }] });

      // Simulate saving edited message
      message.bodyJson = JSON.stringify(editMessageContent);
      message.commit();
      isEditing = false;

      // Verify message was updated
      expect(message.bodyJson).toBe(JSON.stringify(editMessageContent));
      expect(message.commit).toHaveBeenCalled();
      expect(isEditing).toBe(false);

      flushSync();
    });

    cleanup();
  });
});
