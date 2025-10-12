# Real-time Communication

*Note: This documentation page is LLM-generated and needs to be reviewed and edited.*

This document describes the real-time communication system in Roomy, which enables live collaboration and synchronization across multiple users using the Jazz framework and CRDTs.

## Overview

Roomy's real-time communication system is built on the Jazz framework, which provides conflict-free replicated data types (CRDTs) for seamless collaboration. The system enables instant message delivery, live editing, and automatic conflict resolution across all connected clients.

## Jazz Framework Integration

### Core Concepts

#### `CoState`
Reactive wrapper for Jazz objects that automatically updates when data changes.

```typescript
// Create reactive state for collaborative data
let space = $derived(
  new CoState(Space, spaceId, {
    resolve: {
      channels: {
        $each: true,
        $onError: null,
      },
      members: {
        $each: true,
        $onError: null,
      },
    },
  })
);

// Access current value with automatic updates
let currentSpace = space.current;
```

#### `AccountCoState`
Specialized CoState for user accounts with authentication and synchronization.

```typescript
const me = new AccountCoState(RoomyAccount, {
  resolve: {
    profile: {
      joinedSpaces: true,
    },
    root: true,
  },
});

// Current user with automatic sync
let currentUser = me.current;
```

### Data Synchronization Flow

#### 1. Local Changes
```typescript
// User creates a message locally
async function createMessage(content: string) {
  const message = Message.create({
    content,
    createdAt: new Date(),
    author: me.current.id,
    threadId: currentThread.id,
    reactions: [],
    hiddenIn: []
  });
  
  // Add to timeline immediately (optimistic update)
  currentThread.timeline.push(message.id);
  
  // Changes are automatically synced via Jazz
}
```

#### 2. CRDT Operations
```typescript
// CRDT automatically handles concurrent changes
// User A and User B edit the same message simultaneously

// User A's change
message.content = "Updated by User A";

// User B's change (happens concurrently)
message.content = "Updated by User B";

// Result: CRDT merges both changes automatically
// Final content: "Updated by User A and User B"
```

#### 3. Real-time Updates
```typescript
// React to changes in real-time
$effect(() => {
  const messageCount = timeline.length;
  
  if (messageCount > previousMessageCount) {
    // New message received
    playNotificationSound();
    scrollToBottom();
    updateUnreadCount();
  }
  
  previousMessageCount = messageCount;
});
```

## Message Timeline Structure

### Timeline Organization
```typescript
// Timeline structure for threads
interface Timeline {
  perAccount: Record<string, AccountFeed>; // Messages organized by account
}

interface AccountFeed {
  all: TimelineItem[]; // All messages from this account
}

interface TimelineItem {
  value: string;    // Message ID
  madeAt: Date;     // Creation timestamp
}
```

### Timeline Operations

#### Message Creation
```typescript
// Add message to timeline
function addMessageToTimeline(message: Message, threadId: string) {
  const timeline = getThreadTimeline(threadId);
  const accountId = message.author;
  
  if (!timeline.perAccount[accountId]) {
    timeline.perAccount[accountId] = { all: [] };
  }
  
  timeline.perAccount[accountId].all.push({
    value: message.id,
    madeAt: message.createdAt
  });
}
```

#### Message Retrieval
```typescript
// Get sorted messages from timeline
let timeline = $derived.by(() => {
  const currentTimeline = thread.current?.timeline ?? channel.current?.mainThread?.timeline;
  
  return Object.values(currentTimeline?.perAccount ?? {})
    .map((accountFeed) => new Array(...accountFeed.all))
    .flat()
    .sort((a, b) => a.madeAt.getTime() - b.madeAt.getTime())
    .map((a) => a.value);
});
```

## Reactive Components

### Live Updates
```typescript
// Component automatically updates when data changes
<script lang="ts">
  let messages = $derived(() => {
    return timeline.map(messageId => new CoState(Message, messageId));
  });
  
  let messageCount = $derived(messages.length);
  let unreadCount = $derived(
    messages.filter(msg => !isRead(msg.id)).length
  );
</script>

<!-- UI automatically updates when messages change -->
<div class="message-list">
  {#each messages as message}
    <ChatMessage message={message.current} />
  {/each}
</div>

<div class="status">
  {messageCount} messages, {unreadCount} unread
</div>
```

### Optimistic Updates
```typescript
// Immediate UI feedback
async function sendMessage(content: string) {
  // Create optimistic message
  const optimisticMessage = {
    id: generateTempId(),
    content,
    author: me.current.id,
    createdAt: new Date(),
    isOptimistic: true
  };
  
  // Add to UI immediately
  messages = [...messages, optimisticMessage];
  
  try {
    // Create real message via Jazz
    const realMessage = await createMessage(content);
    
    // Replace optimistic message with real one
    messages = messages.map(msg => 
      msg.id === optimisticMessage.id ? realMessage : msg
    );
  } catch (error) {
    // Remove optimistic message on error
    messages = messages.filter(msg => msg.id !== optimisticMessage.id);
    showError('Failed to send message');
  }
}
```

## WebSocket Integration

### Connection Management
```typescript
// WebSocket connection setup
class WebSocketManager {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  
  connect(url: string) {
    this.ws = new WebSocket(url);
    
    this.ws.onopen = () => {
      console.log('WebSocket connected');
      this.reconnectAttempts = 0;
    };
    
    this.ws.onclose = () => {
      console.log('WebSocket disconnected');
      this.handleReconnect();
    };
    
    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
    
    this.ws.onmessage = (event) => {
      this.handleMessage(JSON.parse(event.data));
    };
  }
  
  private handleReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
      
      setTimeout(() => {
        this.connect(this.ws?.url || '');
      }, delay);
    }
  }
}
```

### Message Broadcasting
```typescript
// Broadcast messages to all connected clients
function broadcastMessage(message: Message) {
  const broadcastData = {
    type: 'message',
    data: {
      id: message.id,
      content: message.content,
      author: message.author,
      threadId: message.threadId,
      createdAt: message.createdAt
    }
  };
  
  // Send via WebSocket
  if (wsManager.ws?.readyState === WebSocket.OPEN) {
    wsManager.ws.send(JSON.stringify(broadcastData));
  }
}

// Handle incoming broadcast messages
function handleBroadcastMessage(data: any) {
  switch (data.type) {
    case 'message':
      // Message is already in CRDT, just trigger UI update
      break;
    case 'typing':
      updateTypingIndicator(data.userId, data.isTyping);
      break;
    case 'presence':
      updateUserPresence(data.userId, data.status);
      break;
  }
}
```

## Offline Support

### Offline-First Architecture
```typescript
// All operations work offline
async function sendMessageOffline(content: string) {
  // Create message locally
  const message = Message.create({
    content,
    createdAt: new Date(),
    author: me.current.id,
    threadId: currentThread.id
  });
  
  // Add to timeline
  currentThread.timeline.push(message.id);
  
  // Queue for sync when online
  syncQueue.push({
    type: 'message',
    data: message,
    timestamp: Date.now()
  });
  
  // Persist to local storage
  persistToLocalStorage();
}
```

### Sync Queue Management
```typescript
// Manage offline operations
class SyncQueue {
  private queue: SyncItem[] = [];
  
  add(item: SyncItem) {
    this.queue.push(item);
    this.persist();
  }
  
  async process() {
    if (!navigator.onLine) return;
    
    const items = [...this.queue];
    this.queue = [];
    
    for (const item of items) {
      try {
        await this.processItem(item);
      } catch (error) {
        // Re-queue failed items
        this.queue.push(item);
        console.error('Sync failed for item:', item, error);
      }
    }
    
    this.persist();
  }
  
  private async processItem(item: SyncItem) {
    switch (item.type) {
      case 'message':
        await broadcastMessage(item.data);
        break;
      case 'reaction':
        await updateReaction(item.data);
        break;
      case 'edit':
        await updateMessage(item.data);
        break;
    }
  }
}
```

## Performance Optimization

### Virtual Scrolling
```typescript
// Efficient rendering of large message lists
import { VirtualList } from 'virtua';

<VirtualList
  items={messages}
  itemHeight={80}
  overscan={5}
  onRangeChange={({ startIndex, endIndex }) => {
    // Load messages in viewport
    loadMessagesInRange(startIndex, endIndex);
  }}
>
  {(message) => <ChatMessage message={message} />}
</VirtualList>
```

### Message Batching
```typescript
// Batch multiple messages for efficient rendering
class MessageBatcher {
  private batch: Message[] = [];
  private batchTimeout: number | null = null;
  
  addMessage(message: Message) {
    this.batch.push(message);
    
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
    }
    
    this.batchTimeout = setTimeout(() => {
      this.flushBatch();
    }, 100); // 100ms batching window
  }
  
  private flushBatch() {
    if (this.batch.length > 0) {
      // Render batch of messages
      renderMessageBatch(this.batch);
      this.batch = [];
    }
  }
}
```

### Memory Management
```typescript
// Efficient memory usage for large datasets
class MessageCache {
  private cache = new Map<string, Message>();
  private maxSize = 1000;
  
  get(messageId: string): Message | undefined {
    return this.cache.get(messageId);
  }
  
  set(messageId: string, message: Message) {
    if (this.cache.size >= this.maxSize) {
      // Remove oldest entries
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    
    this.cache.set(messageId, message);
  }
  
  clear() {
    this.cache.clear();
  }
}
```

## Error Handling

### Connection Errors
```typescript
// Handle WebSocket connection errors
class ConnectionErrorHandler {
  static handleConnectionError(error: Error) {
    console.error('Connection error:', error);
    
    // Show user-friendly message
    showNotification('Connection lost. Trying to reconnect...', 'warning');
    
    // Attempt reconnection
    setTimeout(() => {
      wsManager.connect(wsManager.url);
    }, 5000);
  }
  
  static handleSyncError(error: Error) {
    console.error('Sync error:', error);
    
    // Show error to user
    showNotification('Failed to sync changes. Your changes are saved locally.', 'error');
    
    // Queue for retry
    syncQueue.add({
      type: 'retry',
      data: error,
      timestamp: Date.now()
    });
  }
}
```

### Conflict Resolution
```typescript
// Handle CRDT conflicts
class ConflictResolver {
  static resolveMessageConflict(local: Message, remote: Message): Message {
    // CRDT automatically resolves most conflicts
    // Custom resolution for specific cases
    
    if (local.softDeleted && !remote.softDeleted) {
      // Local deletion takes precedence
      return local;
    }
    
    if (remote.softDeleted && !local.softDeleted) {
      // Remote deletion takes precedence
      return remote;
    }
    
    // Use CRDT merge for content conflicts
    return this.mergeMessages(local, remote);
  }
  
  private static mergeMessages(local: Message, remote: Message): Message {
    // Custom merge logic for message content
    const mergedContent = this.mergeContent(local.content, remote.content);
    
    return {
      ...local,
      content: mergedContent,
      updatedAt: new Date(Math.max(local.updatedAt.getTime(), remote.updatedAt.getTime()))
    };
  }
}
```

## Testing Real-time Features

### Unit Testing
```typescript
// Test real-time functionality
describe('Real-time Communication', () => {
  it('should sync messages across clients', async () => {
    // Create test clients
    const client1 = new TestClient();
    const client2 = new TestClient();
    
    // Connect clients
    await client1.connect();
    await client2.connect();
    
    // Send message from client1
    await client1.sendMessage('Hello from client1');
    
    // Wait for sync
    await waitFor(() => {
      expect(client2.messages).toHaveLength(1);
      expect(client2.messages[0].content).toBe('Hello from client1');
    });
  });
  
  it('should handle offline operations', async () => {
    const client = new TestClient();
    
    // Go offline
    client.setOffline(true);
    
    // Send message (should work offline)
    await client.sendMessage('Offline message');
    
    // Go online
    client.setOffline(false);
    
    // Message should sync
    await waitFor(() => {
      expect(client.syncQueue).toHaveLength(0);
    });
  });
});
```

### Integration Testing
```typescript
// Test real-time collaboration
describe('Collaboration', () => {
  it('should handle concurrent edits', async () => {
    const client1 = new TestClient();
    const client2 = new TestClient();
    
    await client1.connect();
    await client2.connect();
    
    // Both clients edit same message simultaneously
    const messageId = await client1.createMessage('Original content');
    
    client1.editMessage(messageId, 'Edited by client1');
    client2.editMessage(messageId, 'Edited by client2');
    
    // Wait for conflict resolution
    await waitFor(() => {
      const finalContent = client1.getMessage(messageId).content;
      expect(finalContent).toContain('Edited by client1');
      expect(finalContent).toContain('Edited by client2');
    });
  });
});
```

## Monitoring and Analytics

### Performance Monitoring
```typescript
// Monitor real-time performance
class PerformanceMonitor {
  private metrics = {
    messageLatency: [] as number[],
    syncQueueSize: [] as number[],
    connectionUptime: 0,
    errorCount: 0
  };
  
  recordMessageLatency(latency: number) {
    this.metrics.messageLatency.push(latency);
    
    // Keep only last 100 measurements
    if (this.metrics.messageLatency.length > 100) {
      this.metrics.messageLatency.shift();
    }
  }
  
  getAverageLatency(): number {
    if (this.metrics.messageLatency.length === 0) return 0;
    
    const sum = this.metrics.messageLatency.reduce((a, b) => a + b, 0);
    return sum / this.metrics.messageLatency.length;
  }
  
  reportMetrics() {
    // Send metrics to analytics service
    analytics.track('real_time_metrics', {
      averageLatency: this.getAverageLatency(),
      syncQueueSize: this.metrics.syncQueueSize.length,
      connectionUptime: this.metrics.connectionUptime,
      errorCount: this.metrics.errorCount
    });
  }
}
```

### User Experience Metrics
```typescript
// Track user experience metrics
class UXMetrics {
  trackMessageDelivery(messageId: string, timestamp: number) {
    const deliveryTime = Date.now() - timestamp;
    
    analytics.track('message_delivery', {
      messageId,
      deliveryTime,
      success: true
    });
  }
  
  trackTypingIndicator(userId: string, isTyping: boolean) {
    analytics.track('typing_indicator', {
      userId,
      isTyping,
      timestamp: Date.now()
    });
  }
  
  trackPresenceChange(userId: string, status: 'online' | 'offline' | 'away') {
    analytics.track('presence_change', {
      userId,
      status,
      timestamp: Date.now()
    });
  }
}
```

---

*This real-time communication documentation provides a comprehensive overview of how real-time collaboration works in Roomy. For implementation details, refer to the source code and the Jazz framework documentation.* 