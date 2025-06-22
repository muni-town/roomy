# State Management

*Note: This documentation page is LLM-generated and needs to be reviewed and edited.*

This document describes how state is managed in the Roomy application using Svelte 5 runes and the Jazz framework for collaborative state management.

## Overview

Roomy uses a hybrid state management approach combining Svelte 5's reactive runes for local component state and the Jazz framework for collaborative, CRDT-based state management across users.

## Svelte 5 Runes

### Core Runes

#### `$state()`
Creates reactive state that triggers component updates when changed.

```typescript
// Local component state
let messageInput = $state("");
let isTyping = $state(false);
let selectedMessages = $state<string[]>([]);

// Object state
let userPreferences = $state({
  theme: "dark",
  notifications: true,
  autoSave: false
});
```

#### `$derived()`
Creates computed values that automatically update when dependencies change.

```typescript
// Simple derived state
let messageCount = $derived(messages.length);
let unreadCount = $derived(messages.filter(m => !m.read).length);

// Complex derived state
let filteredMessages = $derived(
  messages
    .filter(msg => !msg.softDeleted)
    .filter(msg => searchQuery ? msg.content.includes(searchQuery) : true)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
);
```

#### `$effect()`
Runs side effects when reactive dependencies change.

```typescript
// Side effects
$effect(() => {
  if (messageInput.length > 0) {
    isTyping = true;
    const timeout = setTimeout(() => {
      isTyping = false;
    }, 1000);
    
    return () => clearTimeout(timeout);
  }
});

// DOM effects
$effect(() => {
  if (isModalOpen) {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }
});
```

#### `$props()`
Defines component props with TypeScript support.

```typescript
let {
  message,
  showAuthor = true,
  showTimestamp = true,
  onReply,
  onEdit
}: {
  message: Message;
  showAuthor?: boolean;
  showTimestamp?: boolean;
  onReply?: (messageId: string) => void;
  onEdit?: (messageId: string) => void;
} = $props();
```

### Advanced Runes

#### `$derived.by()`
Creates derived state with custom equality checking.

```typescript
// Custom equality for expensive computations
let expensiveValue = $derived.by(() => {
  return heavyComputation(data);
}, (prev, next) => {
  // Custom equality function
  return JSON.stringify(prev) === JSON.stringify(next);
});
```

#### `$effect.pre()`
Runs effects before DOM updates.

```typescript
// Pre-effect for DOM measurements
$effect.pre(() => {
  if (element) {
    const rect = element.getBoundingClientRect();
    elementWidth = rect.width;
  }
});
```

## Jazz Framework Integration

### Core Concepts

#### `CoState`
Reactive wrapper for Jazz objects that automatically updates when data changes.

```typescript
// Create a reactive state for a Space
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

// Access current value
let currentSpace = space.current;
```

#### `AccountCoState`
Specialized CoState for user accounts with authentication.

```typescript
const me = new AccountCoState(RoomyAccount, {
  resolve: {
    profile: {
      joinedSpaces: true,
    },
    root: true,
  },
});

// Access current user
let currentUser = me.current;
```

### State Patterns

#### Local State
Component-specific state that doesn't need to be shared.

```typescript
// Form state
let formData = $state({
  title: "",
  description: "",
  category: ""
});

// UI state
let uiState = $state({
  isModalOpen: false,
  selectedTab: "general",
  isLoading: false
});
```

#### Shared State
State that needs to be accessed by multiple components.

```typescript
// Using Svelte context
setContext('theme', themeState);
setContext('user', userState);

// In child components
const theme = getContext('theme');
const user = getContext('user');
```

#### Composition
Combining multiple state sources.

```typescript
// Combine local and shared state
let combinedState = $derived({
  ...localState,
  user: userState.current,
  theme: themeState.current,
  isOnline: networkState.current
});
```

## State Synchronization

### Real-time Updates

#### Automatic Sync
Jazz framework automatically synchronizes state changes across connected clients.

```typescript
// Changes are automatically synced
space.current.name = "Updated Space Name";
space.current.description = "New description";

// These changes will appear on other clients automatically
```

#### Optimistic Updates
Update UI immediately while syncing in background.

```typescript
// Optimistic message sending
async function sendMessage(content: string) {
  // Create message locally first
  const message = Message.create({
    content,
    createdAt: new Date(),
    author: me.current.id,
    threadId: currentThread.id
  });
  
  // Add to timeline immediately
  currentThread.timeline.push(message.id);
  
  // Sync will happen automatically in background
}
```

### Conflict Resolution

#### CRDT-based Resolution
Jazz framework handles conflicts automatically using CRDT algorithms.

```typescript
// Concurrent edits are automatically merged
// User A edits message content
message.content = "Updated by User A";

// User B edits same message simultaneously
message.content = "Updated by User B";

// Result: Both changes are preserved and merged
// Final content: "Updated by User A and User B"
```

#### Custom Conflict Resolution
Define custom merge strategies for specific fields.

```typescript
// Custom merge for user preferences
const UserPreferences = co.map({
  theme: z.enum(["light", "dark", "auto"]),
  notifications: z.boolean(),
  lastSeen: z.date()
}).withMerge((local, remote) => {
  // Custom merge logic
  return {
    theme: remote.theme, // Remote wins for theme
    notifications: local.notifications, // Local wins for notifications
    lastSeen: new Date(Math.max(local.lastSeen.getTime(), remote.lastSeen.getTime()))
  };
});
```

## Persistence

### Local Storage

#### IndexedDB
All data is persisted locally using IndexedDB through Jazz framework.

```typescript
// Data is automatically persisted
// No manual persistence code needed
```

#### Session Storage
Temporary state that persists during browser session.

```typescript
// Session-specific state
let sessionState = $state({
  lastVisitedSpace: sessionStorage.getItem('lastSpace') || null,
  draftMessages: JSON.parse(sessionStorage.getItem('drafts') || '{}')
});

// Persist to session storage
$effect(() => {
  sessionStorage.setItem('lastSpace', sessionState.lastVisitedSpace);
  sessionStorage.setItem('drafts', JSON.stringify(sessionState.draftMessages));
});
```

### State Validation

#### Schema Validation
Jazz framework validates data against defined schemas.

```typescript
const Message = co.map({
  content: z.string().min(1).max(1000),
  createdAt: z.date(),
  author: z.string(),
  threadId: z.string().optional()
});

// Invalid data will be rejected
try {
  const message = Message.create({
    content: "", // Will fail validation
    createdAt: new Date(),
    author: "user123"
  });
} catch (error) {
  console.error("Validation failed:", error);
}
```

#### Business Logic Validation
Custom validation for business rules.

```typescript
function validateMessage(message: Message): boolean {
  // Check content length
  if (message.content.length === 0) return false;
  if (message.content.length > 1000) return false;
  
  // Check for spam
  if (isSpam(message.content)) return false;
  
  // Check user permissions
  if (!canPostInThread(message.threadId)) return false;
  
  return true;
}
```

## Performance Optimization

### Memoization

#### Expensive Computations
Cache expensive derived values.

```typescript
// Memoize expensive search
let searchResults = $derived.by(() => {
  return performExpensiveSearch(messages, searchQuery);
}, (prev, next) => {
  return prev.query === next.query && prev.messages.length === next.messages.length;
});
```

#### Selective Updates
Only update when necessary.

```typescript
// Only update when specific fields change
let userDisplayName = $derived.by(() => {
  return user.current?.profile?.name || "Anonymous";
}, (prev, next) => prev === next);
```

### Lazy Loading

#### Component State
Load state only when needed.

```typescript
// Lazy load user details
let userDetails = $derived(() => {
  if (shouldLoadUserDetails) {
    return new CoState(User, userId);
  }
  return null;
});
```

#### Data Loading
Load data in chunks.

```typescript
// Paginated message loading
let visibleMessages = $derived(() => {
  return messages.slice(0, pageSize * currentPage);
});

function loadMoreMessages() {
  currentPage++;
  // More messages will be loaded automatically
}
```

## Debugging

### State Inspection

#### Jazz Inspector
Built-in inspector for Jazz state.

```typescript
// Enable Jazz inspector in development
import "jazz-inspector-element";

// Add to component
<jazz-inspector></jazz-inspector>
```

#### Custom Debugging
Add debugging to state changes.

```typescript
// Debug state changes
$effect(() => {
  console.log("Message input changed:", messageInput);
  console.log("Is typing:", isTyping);
});

// Debug derived state
let debugFilteredMessages = $derived(() => {
  const filtered = messages.filter(m => !m.softDeleted);
  console.log("Filtered messages:", filtered);
  return filtered;
});
```

### Error Handling

#### State Errors
Handle state-related errors gracefully.

```typescript
// Error boundary for state
try {
  let space = new CoState(Space, spaceId);
} catch (error) {
  console.error("Failed to load space:", error);
  // Show fallback UI
}
```

#### Network Errors
Handle synchronization errors.

```typescript
// Handle sync errors
$effect(() => {
  if (syncError) {
    showNotification("Sync failed. Changes saved locally.", "warning");
  }
});
```

## Testing

### State Testing

#### Unit Tests
Test individual state logic.

```typescript
import { describe, it, expect } from 'vitest';

describe('Message State', () => {
  it('should filter deleted messages', () => {
    const messages = [
      { id: '1', content: 'Hello', softDeleted: false },
      { id: '2', content: 'World', softDeleted: true }
    ];
    
    const filtered = messages.filter(m => !m.softDeleted);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('1');
  });
});
```

#### Integration Tests
Test state interactions.

```typescript
describe('Message Creation', () => {
  it('should add message to timeline', async () => {
    const message = await createMessage("Test message");
    expect(timeline.current).toContain(message.id);
  });
});
```

## Common Patterns

### Loading States

```typescript
// Loading state pattern
let isLoading = $state(false);
let error = $state<string | null>(null);
let data = $state<Data | null>(null);

async function loadData() {
  isLoading = true;
  error = null;
  
  try {
    data = await fetchData();
  } catch (err) {
    error = err.message;
  } finally {
    isLoading = false;
  }
}
```

### Form State

```typescript
// Form state pattern
let formState = $state({
  values: { title: "", description: "" },
  errors: {},
  isSubmitting: false,
  isDirty: false
});

let isValid = $derived(
  formState.values.title.length > 0 && 
  formState.values.description.length > 0
);

function updateField(field: string, value: string) {
  formState.values[field] = value;
  formState.isDirty = true;
  formState.errors[field] = validateField(field, value);
}
```

### Pagination State

```typescript
// Pagination state pattern
let paginationState = $state({
  currentPage: 1,
  pageSize: 20,
  totalItems: 0,
  hasMore: true
});

let visibleItems = $derived(() => {
  const start = (paginationState.currentPage - 1) * paginationState.pageSize;
  const end = start + paginationState.pageSize;
  return allItems.slice(start, end);
});

function loadMore() {
  if (paginationState.hasMore) {
    paginationState.currentPage++;
  }
}
```

---

*This state management documentation provides a comprehensive overview of how state is managed in the Roomy application. For implementation details, refer to the source code and the Jazz framework documentation.* 