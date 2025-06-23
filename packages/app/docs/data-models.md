# Data Models

*Note: This documentation page is LLM-generated and needs to be reviewed and edited.*

This document provides detailed information about the data models used in the Roomy application, including their structure, relationships, and operations.

## Overview

Roomy uses the Jazz framework with CRDTs (Conflict-free Replicated Data Types) for data modeling. All data models are defined using TypeScript interfaces and the Jazz schema system.

## Core Data Models

### Space

A Space is the top-level organizational unit containing channels, threads, and pages.

```typescript
interface Space {
  name: string;                    // Human-readable name
  imageUrl?: string;              // Banner or avatar image
  channels: Channel[];            // List of channels in the space
  categories: Category[];         // Organizational categories
  description?: string;           // Space description
  members: Account[];             // Space members
  version?: number;               // Schema version for migrations
  creatorId: string;              // ID of the space creator
  adminGroupId: string;           // Admin group for permissions
  threads: Thread[];              // Global threads
  pages: Page[];                  // Global pages
  bans: string[];                 // Banned user IDs
}
```

### Channel

A Channel organizes conversations and content within a space.

```typescript
interface Channel {
  name: string;                   // Channel name
  mainThread: Thread;            // Primary conversation thread
  subThreads: Thread[];          // Additional conversation threads
  pages?: Page[];                // Channel-specific pages
  softDeleted?: boolean;         // Soft deletion flag
}
```

### Thread

A Thread represents a conversation or discussion within a channel.

```typescript
interface Thread {
  name: string;                   // Thread name/title
  timeline: Timeline;            // Chronological message feed
  softDeleted?: boolean;         // Soft deletion flag
  channelId: string;             // Parent channel ID
}
```

### Message

A Message is the fundamental unit of communication.

```typescript
interface Message {
  content: string;                // Text content
  createdAt: Date;               // Creation timestamp
  updatedAt: Date;               // Last update timestamp
  hiddenIn: string[];            // Threads where message is hidden
  replyTo?: string;              // Parent message ID for replies
  reactions: Reaction[];         // User reactions
  softDeleted?: boolean;         // Soft deletion flag
  embeds?: Embed[];              // Embedded content
  author?: string;               // Author user ID
  threadId?: string;             // Parent thread ID
}
```

### Page

A Page represents document-style content within a space or channel.

```typescript
interface Page {
  name: string;                   // Page title
  softDeleted?: boolean;         // Soft deletion flag
  body: string;                  // Page content (markdown/HTML)
}
```

### User/Account

User information and account data.

```typescript
interface RoomyProfile {
  name: string;                   // Display name
  imageUrl?: string;             // Profile picture
  blueskyHandle?: string;        // AT Protocol handle
  joinedSpaces: Space[];         // Spaces the user has joined
  roomyInbox: InboxItem[];       // Notifications and mentions
  bannerUrl?: string;            // Profile banner
  description?: string;          // User bio
}

interface RoomyRoot {
  lastRead: Record<string, Date>; // Last read timestamps
}

interface RoomyAccount {
  profile: RoomyProfile;         // User profile
  root: RoomyRoot;              // Account root data
}
```

### Supporting Models

#### Category
```typescript
interface Category {
  name: string;                   // Category name
  channels?: Channel[];          // Channels in this category
  softDeleted?: boolean;         // Soft deletion flag
}
```

#### Reaction
```typescript
interface Reaction {
  emoji: string;                  // Emoji reaction
}
```

#### Embed
```typescript
interface ImageUrlEmbed {
  url: string;                    // Image URL
}

interface Embed {
  type: "imageUrl";              // Embed type
  embedId: string;               // Unique embed identifier
}
```

#### Timeline
```typescript
interface Timeline {
  perAccount: Record<string, AccountFeed>; // Messages per account
}
```

#### InboxItem
```typescript
interface InboxItem {
  spaceId: string;               // Related space ID
  channelId?: string;            // Related channel ID
  threadId?: string;             // Related thread ID
  messageId: string;             // Related message ID
  read?: boolean;                // Read status
  type: "reply" | "mention";     // Notification type
}
```

## Data Relationships

### Hierarchical Structure
```
RoomyAccount
├── Profile
│   ├── Personal Info (name, image, etc.)
│   ├── Joined Spaces (many-to-many)
│   └── Inbox (notifications)
└── Root
    └── Last Read (key-value pairs)

Space
├── Basic Info (name, description, etc.)
├── Members (many-to-many)
├── Categories
│   └── Channels
│       ├── Main Thread
│       ├── Sub Threads
│       └── Pages
├── Global Threads
└── Global Pages
```

### Relationship Types

#### One-to-Many
- Space → Channels
- Space → Threads
- Space → Pages
- Channel → Threads
- Channel → Pages
- Thread → Messages

#### Many-to-Many
- Users ↔ Spaces (membership)
- Users ↔ Messages (reactions)

#### Referential
- Message → Thread (via threadId)
- Message → Message (via replyTo)
- Thread → Channel (via channelId)

## Data Operations

### Creation Operations

#### Creating a Space
```typescript
const space = Space.create({
  name: "My Space",
  description: "A collaborative workspace",
  creatorId: userAccount.id,
  adminGroupId: adminGroup.id,
  channels: [],
  categories: [],
  members: [userAccount],
  threads: [],
  pages: [],
  bans: []
});
```

#### Creating a Message
```typescript
const message = Message.create({
  content: "Hello, world!",
  createdAt: new Date(),
  updatedAt: new Date(),
  author: userAccount.id,
  threadId: thread.id,
  reactions: [],
  hiddenIn: [],
  embeds: []
});
```

### Update Operations

#### Updating Message Content
```typescript
message.content = "Updated content";
message.updatedAt = new Date();
```

#### Adding Reactions
```typescript
message.reactions.push(Reaction.create({
  emoji: "👍"
}));
```

### Query Operations

#### Finding Messages in Thread
```typescript
const threadMessages = timeline
  .filter(msg => msg.threadId === threadId)
  .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
```

#### Finding User's Spaces
```typescript
const userSpaces = userProfile.joinedSpaces;
```

### Deletion Operations

#### Soft Delete
```typescript
message.softDeleted = true;
```

#### Hard Delete (CRDT-based)
```typescript
// Messages are removed from timeline automatically
// when softDeleted is true
```

## Data Validation

### Schema Validation
All data models use Zod schemas for validation:

```typescript
export const Message = co.map({
  content: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  hiddenIn: co.list(z.string()),
  replyTo: z.string().optional(),
  reactions: ReactionList,
  softDeleted: z.boolean().optional(),
  embeds: z.optional(co.list(Embed)),
  author: z.string().optional(),
  threadId: z.string().optional(),
});
```

### Business Logic Validation
- Message content length limits
- User permission checks
- Rate limiting for message creation
- Valid emoji reactions

## Data Synchronization

### CRDT Operations
- **Merge**: Automatic merging of concurrent changes
- **Conflict Resolution**: Built-in conflict resolution
- **Causality**: Preserves causal relationships
- **Commutativity**: Operations are order-independent

### Sync Strategy
1. **Local First**: All operations happen locally first
2. **Optimistic Updates**: UI updates immediately
3. **Background Sync**: Sync happens in background
4. **Conflict Resolution**: Automatic resolution of conflicts

### Offline Support
- All data stored locally in IndexedDB
- Operations queued when offline
- Automatic sync when connection restored
- No data loss during offline periods

## Performance Considerations

### Data Loading
- **Lazy Loading**: Load data only when needed
- **Pagination**: Load messages in chunks
- **Virtual Scrolling**: Efficient rendering of large lists
- **Caching**: Cache frequently accessed data

### Memory Management
- **Garbage Collection**: Automatic cleanup of unused data
- **Memory Limits**: Monitor memory usage
- **Data Archiving**: Archive old data to reduce memory usage

### Query Optimization
- **Indexing**: Index frequently queried fields
- **Filtering**: Filter data at the source
- **Projection**: Only load needed fields
- **Caching**: Cache query results

## Migration and Versioning

### Schema Evolution
```typescript
export const RoomyAccount = co
  .account({
    profile: RoomyProfile,
    root: RoomyRoot,
  })
  .withMigration((account, creationProps?: { name: string }) => {
    // Migration logic for schema changes
    if (account.root === undefined) {
      account.root = RoomyRoot.create({
        lastRead: LastReadList.create({}),
      });
    }
    
    if (account.profile === undefined) {
      account.profile = RoomyProfile.create(
        {
          name: creationProps?.name ?? getRandomUsername(),
          joinedSpaces: createSpaceList(),
          roomyInbox: createInbox(),
        },
        publicGroup("reader"),
      );
    }
  });
```

### Version Management
- **Schema Versioning**: Track schema versions
- **Backward Compatibility**: Support old data formats
- **Migration Scripts**: Automated data migration
- **Rollback Support**: Ability to revert changes

## Security and Privacy

### Data Protection
- **Local Storage**: All data stored locally
- **Encryption**: Planned end-to-end encryption
- **Access Control**: Permission-based access
- **Audit Trail**: Track data access and changes

### Privacy Features
- **User Control**: Users control their data
- **Minimal Collection**: Only necessary data collected
- **Anonymization**: Support for anonymous usage
- **Data Export**: User data export capabilities

---

*This data model documentation provides a comprehensive overview of how data is structured and managed in the Roomy application. For implementation details, refer to the source code in the `src/lib/jazz/` directory.* 