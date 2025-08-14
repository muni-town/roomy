# Component Architecture

*Note: This documentation page is LLM-generated and needs to be reviewed and edited.*

This document describes the component hierarchy and architecture of the Roomy application's user interface.

## Overview

Roomy uses Svelte 5 components with a modular, reusable architecture. Components are organized by functionality and follow consistent patterns for state management, event handling, and styling.

## Component Hierarchy

### Main Application Structure
```
App (+layout.svelte)
├── JazzProvider (Authentication & State)
├── App Layout (+layout.svelte)
│   ├── ServerBar (Space Navigation)
│   ├── SidebarMain (Channel Navigation)
│   └── Main Content Area
│       ├── TimelineView (Message Display)
│       ├── PageEditor (Document Editing)
│       └── Other Route Components
└── Global Components
    ├── Toaster (Notifications)
    ├── Dialogs (Modals)
    └── Context Menus
```

## Core Components

### Layout Components

#### ServerBar
**File**: `src/lib/components/ServerBar.svelte`
**Purpose**: Space navigation and user profile management

```typescript
interface ServerBarProps {
  spaces: Space[];
  visible: boolean;
  me: RoomyAccount;
}
```

**Features**:
- Space list with avatars and names
- User profile display
- Space creation and management
- Theme switching
- User settings

#### SidebarMain
**File**: `src/lib/components/SidebarMain.svelte`
**Purpose**: Channel and thread navigation within a space

```typescript
interface SidebarMainProps {
  space: Space;
  currentChannel?: Channel;
  currentThread?: Thread;
}
```

**Features**:
- Channel list with categories
- Thread navigation
- Search functionality
- Channel creation and management
- Unread message indicators

### Chat Components

#### TimelineView
**File**: `src/lib/components/TimelineView.svelte`
**Purpose**: Main message display and interaction area

```typescript
interface TimelineViewProps {
  space: Space;
  channel?: Channel;
  thread?: Thread;
}
```

**Features**:
- Message timeline with virtual scrolling
- Message composition and sending
- Thread creation and management
- Message reactions and replies
- File uploads and embeds
- Search within timeline

#### ChatArea
**File**: `src/lib/components/ChatArea.svelte`
**Purpose**: Message display area with virtual scrolling

```typescript
interface ChatAreaProps {
  messages: Message[];
  loading?: boolean;
  onLoadMore?: () => void;
}
```

**Features**:
- Virtual scrolling for performance
- Message rendering and formatting
- Loading states and pagination
- Scroll position management

#### ChatMessage
**File**: `src/lib/components/ChatMessage.svelte`
**Purpose**: Individual message display and interaction

```typescript
interface ChatMessageProps {
  message: Message;
  showAuthor?: boolean;
  showTimestamp?: boolean;
  isReply?: boolean;
}
```

**Features**:
- Message content rendering (text, markdown, embeds)
- User avatar and name display
- Timestamp formatting
- Reaction display and interaction
- Reply threading
- Message actions (edit, delete, reply)

#### ChatInput
**File**: `src/lib/components/ChatInput.svelte`
**Purpose**: Message composition and sending

```typescript
interface ChatInputProps {
  placeholder?: string;
  onSubmit?: (content: string, files?: File[]) => void;
  disabled?: boolean;
}
```

**Features**:
- Rich text editing with TipTap
- File upload support
- Emoji picker integration
- Mention suggestions
- Message formatting
- Send button and keyboard shortcuts

### Navigation Components

#### SidebarChannelList
**File**: `src/lib/components/SidebarChannelList.svelte`
**Purpose**: Channel list display and navigation

```typescript
interface SidebarChannelListProps {
  channels: Channel[];
  categories: Category[];
  currentChannelId?: string;
}
```

**Features**:
- Channel list with categories
- Unread message indicators
- Channel status (active, muted, etc.)
- Channel management actions

#### SidebarChannelButton
**File**: `src/lib/components/SidebarChannelButton.svelte`
**Purpose**: Individual channel button with status

```typescript
interface SidebarChannelButtonProps {
  channel: Channel;
  isActive: boolean;
  unreadCount?: number;
}
```

**Features**:
- Channel name and icon display
- Active state styling
- Unread message count
- Click handling for navigation

#### AccordionTree
**File**: `src/lib/components/AccordionTree.svelte`
**Purpose**: Collapsible tree structure for navigation

```typescript
interface AccordionTreeProps {
  items: TreeItem[];
  expanded?: string[];
}
```

**Features**:
- Expandable/collapsible sections
- Nested item support
- Keyboard navigation
- Accessibility features

### Document Components

#### PageEditor
**File**: `src/lib/components/PageEditor.svelte`
**Purpose**: Rich text document editing

```typescript
interface PageEditorProps {
  page: Page;
  onSave?: (content: string) => void;
  readOnly?: boolean;
}
```

**Features**:
- BlockNote rich text editor
- Collaborative editing
- Markdown import/export
- Auto-save functionality
- Version history

#### BoardList
**File**: `src/lib/components/BoardList.svelte`
**Purpose**: Page/document list display

```typescript
interface BoardListProps {
  pages: Page[];
  onSelect?: (page: Page) => void;
}
```

**Features**:
- Page list with previews
- Search and filtering
- Page creation
- Page management actions

### UI Components

#### Dialog
**File**: `src/lib/components/Dialog.svelte`
**Purpose**: Modal dialog component

```typescript
interface DialogProps {
  open: boolean;
  title?: string;
  onClose?: () => void;
}
```

**Features**:
- Modal overlay
- Focus management
- Keyboard navigation (Esc to close)
- Accessibility support

#### Drawer
**File**: `src/lib/components/Drawer.svelte`
**Purpose**: Slide-out drawer component

```typescript
interface DrawerProps {
  open: boolean;
  side?: 'left' | 'right';
  onClose?: () => void;
}
```

**Features**:
- Slide animation
- Backdrop overlay
- Touch gesture support
- Responsive behavior

#### AvatarImage
**File**: `src/lib/components/AvatarImage.svelte`
**Purpose**: User avatar display

```typescript
interface AvatarImageProps {
  src?: string;
  alt: string;
  size?: 'sm' | 'md' | 'lg';
  fallback?: string;
}
```

**Features**:
- Image loading with fallback
- Multiple size variants
- Lazy loading
- Error handling

### Message Components

#### MessageToolbar
**File**: `src/lib/components/Message/MessageToolbar.svelte`
**Purpose**: Message action toolbar

```typescript
interface MessageToolbarProps {
  message: Message;
  onReply?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}
```

**Features**:
- Reply, edit, delete actions
- Reaction picker
- Share functionality
- Context menu integration

#### MessageReactions
**File**: `src/lib/components/Message/MessageReactions.svelte`
**Purpose**: Message reaction display and interaction

```typescript
interface MessageReactionsProps {
  reactions: Reaction[];
  onReact?: (emoji: string) => void;
}
```

**Features**:
- Reaction display with counts
- Add/remove reactions
- Reaction picker
- User list on hover

#### MessageRepliedTo
**File**: `src/lib/components/Message/MessageRepliedTo.svelte`
**Purpose**: Reply reference display

```typescript
interface MessageRepliedToProps {
  replyTo: Message;
  onNavigate?: () => void;
}
```

**Features**:
- Reply preview
- Author and timestamp
- Navigation to original message
- Truncated content display

### Utility Components

#### ContextMenu
**File**: `src/lib/components/ContextMenu.svelte`
**Purpose**: Right-click context menu

```typescript
interface ContextMenuProps {
  items: MenuItem[];
  x: number;
  y: number;
  onClose?: () => void;
}
```

**Features**:
- Positioned context menu
- Keyboard navigation
- Click outside to close
- Accessibility support

#### SuggestionSelect
**File**: `src/lib/components/SuggestionSelect.svelte`
**Purpose**: Autocomplete suggestion list

```typescript
interface SuggestionSelectProps {
  suggestions: Suggestion[];
  onSelect?: (suggestion: Suggestion) => void;
  visible: boolean;
}
```

**Features**:
- Filtered suggestions
- Keyboard navigation
- Mouse interaction
- Custom rendering

## Component Patterns

### State Management

#### Local State
```typescript
// Component-local state using Svelte 5 runes
let messageInput = $state("");
let isTyping = $state(false);
let selectedMessages = $state<string[]>([]);
```

#### Derived State
```typescript
// Computed values
let filteredMessages = $derived(
  messages.filter(msg => !msg.softDeleted)
);

let unreadCount = $derived(
  messages.filter(msg => !isRead(msg)).length
);
```

#### Effects
```typescript
// Side effects
$effect(() => {
  if (messageInput.length > 0) {
    isTyping = true;
    typingTimeout = setTimeout(() => {
      isTyping = false;
    }, 1000);
  }
});
```

### Event Handling

#### Component Events
```typescript
// Emit events to parent components
const dispatch = createEventDispatcher<{
  message: { content: string; files?: File[] };
  reaction: { emoji: string };
  reply: { messageId: string };
}>();

function handleSubmit() {
  dispatch('message', { content: messageInput, files });
}
```

#### Event Forwarding
```typescript
<!-- Forward events from child components -->
<ChatInput 
  on:message={handleMessage}
  on:typing={handleTyping}
/>
```

### Props and Slots

#### Props Interface
```typescript
interface ComponentProps {
  // Required props
  data: DataType;
  
  // Optional props with defaults
  variant?: 'primary' | 'secondary';
  size?: 'sm' | 'md' | 'lg';
  
  // Callback props
  onAction?: (data: ActionData) => void;
}
```

#### Slot Usage
```typescript
<!-- Component with slots -->
<div class="card">
  <header class="card-header">
    <slot name="header" />
  </header>
  <div class="card-body">
    <slot />
  </div>
  <footer class="card-footer">
    <slot name="footer" />
  </footer>
</div>
```

## Component Communication

### Parent-Child Communication
- **Props Down**: Data and callbacks passed from parent to child
- **Events Up**: Child components emit events to parent
- **Context**: Shared state accessible to component tree

### Cross-Component Communication
- **Stores**: Global state management with Svelte stores
- **Context**: React-like context for dependency injection
- **Events**: Custom event system for loose coupling

### State Synchronization
- **Jazz Framework**: CRDT-based state synchronization
- **Reactive Updates**: Automatic UI updates when data changes
- **Optimistic Updates**: Immediate UI feedback with background sync

## Performance Optimization

### Virtual Scrolling
```typescript
// Efficient rendering of large lists
import { VirtualList } from 'virtua';

<VirtualList
  items={messages}
  itemHeight={80}
  overscan={5}
>
  {(message) => <ChatMessage {message} />}
</VirtualList>
```

### Lazy Loading
```typescript
// Load components only when needed
import { lazy } from 'svelte';

const HeavyComponent = lazy(() => import('./HeavyComponent.svelte'));
```

### Memoization
```typescript
// Cache expensive computations
let expensiveValue = $derived.by(() => {
  return heavyComputation(data);
});
```

## Accessibility

### ARIA Attributes
```typescript
// Proper accessibility markup
<button
  aria-label="Send message"
  aria-pressed={isPressed}
  on:click={handleClick}
>
  Send
</button>
```

### Keyboard Navigation
```typescript
// Keyboard event handling
function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    handleSubmit();
  }
}
```

### Focus Management
```typescript
// Manage focus for modals and dialogs
let dialogElement: HTMLDivElement;

$effect(() => {
  if (isOpen) {
    dialogElement?.focus();
  }
});
```

## Testing

### Component Testing
```typescript
// Unit tests for components
import { render, fireEvent } from '@testing-library/svelte';
import ChatInput from './ChatInput.svelte';

test('sends message on submit', async () => {
  const { getByRole, getByPlaceholderText } = render(ChatInput);
  
  const input = getByPlaceholderText('Type a message...');
  const button = getByRole('button');
  
  await fireEvent.input(input, { target: { value: 'Hello' } });
  await fireEvent.click(button);
  
  // Assert message was sent
});
```

### Integration Testing
```typescript
// Test component interactions
test('message appears in timeline after sending', async () => {
  const { getByText } = render(TimelineView);
  
  // Send a message
  await sendMessage('Test message');
  
  // Verify it appears
  expect(getByText('Test message')).toBeInTheDocument();
});
```

## Guidelines

### Component Design Principles
1. **Single Responsibility**: Each component has one clear purpose
2. **Composition**: Build complex components from simple ones
3. **Reusability**: Design components to be reusable across the app
4. **Accessibility**: Ensure components are accessible by default
5. **Performance**: Optimize for performance from the start

### Naming Conventions
- **Components**: PascalCase (e.g., `ChatMessage.svelte`)
- **Files**: Match component name
- **Props**: camelCase (e.g., `messageContent`)
- **Events**: camelCase prefixed with `on` (e.g., `onMessage`)

### File Organization
```
src/lib/components/
├── Layout/           # Layout components
├── Chat/            # Chat-related components
├── Navigation/      # Navigation components
├── UI/              # Generic UI components
├── Message/         # Message-specific components
└── helper/          # Helper components
```

---

*This component architecture documentation provides a comprehensive overview of how UI components are structured and interact in the Roomy application. For implementation details, refer to the individual component files in the `src/lib/components/` directory.* 