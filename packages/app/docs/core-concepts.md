# Core Concepts

*Note: This documentation page is LLM-generated and needs to be reviewed and edited.*

This document explains the fundamental concepts and terminology used throughout the Roomy application.

## Spaces

A **Space** is the top-level organizational unit in Roomy. Think of it as a community or workspace where people can collaborate.

### Space Characteristics
- **Name**: Human-readable identifier for the space
- **Description**: Optional description of the space's purpose
- **Image**: Optional banner or avatar image
- **Members**: List of users who have access to the space
- **Admin Group**: Special group with administrative privileges
- **Creator**: The user who originally created the space

### Space Management
- Spaces can be public or private
- Members can be invited by space admins
- Spaces support categories and channels for organization
- Each space has its own set of threads and pages

## Channels

A **Channel** is a subdivision within a space that organizes conversations and content around specific topics or purposes.

### Channel Structure
- **Name**: Descriptive name for the channel
- **Main Thread**: The primary conversation thread for the channel
- **Sub Threads**: Additional conversation threads within the channel
- **Pages**: Document-style content associated with the channel

### Channel Types
- **General**: Default channel for general discussion
- **Announcements**: For important updates and announcements
- **Help**: For questions and support
- **Custom**: User-defined channels for specific topics

## Threads

A **Thread** is a conversation or discussion within a channel. Threads help organize related messages and responses.

### Thread Features
- **Name**: Title or topic of the thread
- **Timeline**: Chronological list of messages in the thread
- **Channel Association**: Which channel the thread belongs to
- **Reply Structure**: Messages can reply to other messages

### Thread Types
- **Main Thread**: The primary conversation in a channel
- **Sub Threads**: Additional conversations within a channel
- **Reply Threads**: Conversations that branch from specific messages

## Messages

A **Message** is the fundamental unit of communication in Roomy. Messages can contain text, images, and other content.

### Message Structure
```typescript
interface Message {
  content: string;           // Text content of the message
  createdAt: Date;          // When the message was created
  updatedAt: Date;          // When the message was last updated
  author: string;           // ID of the message author
  threadId?: string;        // Which thread the message belongs to
  replyTo?: string;         // ID of the message being replied to
  reactions: Reaction[];    // User reactions to the message
  embeds: Embed[];          // Embedded content (images, links)
  hiddenIn: string[];       // Threads where this message is hidden
  softDeleted?: boolean;    // Soft deletion flag
}
```

### Message Features
- **Rich Text**: Support for markdown formatting
- **Reactions**: Emoji reactions from users
- **Replies**: Messages can reply to other messages
- **Embeds**: Automatic link previews and image embeds
- **Mentions**: @username mentions to notify users
- **Threading**: Messages can be organized into threads

## Pages

A **Page** is a document-style content piece within a space or channel. Pages are ideal for longer-form content, documentation, or collaborative editing.

### Page Features
- **Rich Text Editor**: BlockNote-based editor for rich content
- **Markdown Support**: Import/export markdown content
- **Collaborative Editing**: Real-time collaborative editing
- **Version History**: Track changes and revisions
- **Organization**: Pages can be organized within channels

### Page Use Cases
- **Documentation**: Space rules, guidelines, and documentation
- **Meeting Notes**: Collaborative note-taking
- **Project Planning**: Task lists, roadmaps, and planning
- **Knowledge Base**: FAQ, tutorials, and reference materials

## Users and Profiles

A **User** represents an individual who can interact with Roomy spaces and content.

### User Profile
```typescript
interface RoomyProfile {
  name: string;                    // Display name
  imageUrl?: string;              // Profile picture
  blueskyHandle?: string;         // AT Protocol handle
  bannerUrl?: string;             // Profile banner
  description?: string;           // Bio or description
  joinedSpaces: Space[];          // Spaces the user has joined
  roomyInbox: InboxItem[];        // Notifications and mentions
}
```

### User Features
- **AT Protocol Integration**: Federated identity via Bluesky
- **Profile Customization**: Customizable profile information
- **Space Membership**: Join and participate in multiple spaces
- **Notification System**: Inbox for mentions and replies
- **Permission Levels**: Different access levels within spaces

## Real-time Collaboration

Roomy uses **Conflict-free Replicated Data Types (CRDTs)** to enable real-time collaboration without conflicts.

### CRDT Principles
- **Eventual Consistency**: All replicas eventually converge to the same state
- **Conflict Resolution**: Automatic resolution of concurrent changes
- **Offline Support**: Changes made offline sync when connection is restored
- **Real-time Updates**: Live updates across all connected clients

### Collaboration Features
- **Live Typing**: See when others are typing
- **Real-time Messages**: Instant message delivery
- **Collaborative Editing**: Multiple users can edit pages simultaneously
- **Presence Indicators**: See who is currently online
- **Conflict-free Merging**: Automatic merging of concurrent changes

## Authentication and Authorization

Roomy uses the **AT Protocol** for decentralized identity and authentication.

### Authentication Flow
1. **OAuth Login**: User authenticates via AT Protocol (Bluesky)
2. **Account Creation**: Jazz account is created with user credentials
3. **Profile Sync**: User profile is synchronized from AT Protocol
4. **Session Management**: Secure session handling with passphrase

### Authorization Model
- **Space Creator**: Full administrative control over a space
- **Space Admin**: Administrative privileges within a space
- **Space Member**: Can participate in conversations and content
- **Guest**: Read-only access (if space allows)

## Data Model

Roomy uses a hierarchical data model with the following structure:

```
RoomyAccount
├── Profile (RoomyProfile)
│   ├── Personal Information
│   ├── Joined Spaces
│   └── Inbox
└── Root (RoomyRoot)
    └── Last Read Timestamps

Space
├── Basic Information
├── Members
├── Categories
│   └── Channels
│       ├── Main Thread
│       ├── Sub Threads
│       └── Pages
└── Global Threads & Pages
```

### Data Relationships
- **One-to-Many**: Space has many channels, users, threads
- **Many-to-Many**: Users can join multiple spaces
- **Hierarchical**: Categories contain channels, channels contain threads
- **Referential**: Messages reference threads, threads reference channels

## Search and Discovery

Roomy provides comprehensive search capabilities across all content.

### Search Features
- **Full-text Search**: Search through messages, pages, and content
- **Fuzzy Matching**: Find content even with typos or partial matches
- **Real-time Results**: Search results update as you type
- **Filtering**: Filter by space, channel, thread, or content type
- **Highlighting**: Search terms are highlighted in results

### Search Scope
- **Messages**: Search through all message content
- **Pages**: Search through page titles and content
- **Users**: Search for users by name or handle
- **Spaces**: Search for spaces by name or description

## Privacy and Security

Roomy is designed with privacy and security as core principles.

### Privacy Features
- **Local Storage**: All data is stored locally on user devices
- **User Control**: Users control their own data and sharing
- **Minimal Collection**: Only necessary data is collected
- **Federated Identity**: Identity is managed by AT Protocol, not Roomy

### Security Features
- **End-to-End Encryption**: Planned feature for message encryption
- **Secure Authentication**: OAuth 2.0 with AT Protocol
- **Input Validation**: All user input is validated and sanitized
- **XSS Protection**: Cross-site scripting protection
- **CSRF Protection**: Cross-site request forgery protection

## Federation

Roomy integrates with the **AT Protocol** for federated social features.

### Federation Benefits
- **Interoperability**: Works with other AT Protocol applications
- **Decentralized Identity**: Identity not controlled by Roomy
- **Cross-platform**: Access from multiple applications
- **User Portability**: Users can move between applications

### AT Protocol Integration
- **Authentication**: OAuth-based login via Bluesky
- **Identity**: User profiles and handles from AT Protocol
- **Social Features**: Follow relationships and social graph
- **Content Sharing**: Share content across the federated network

## Performance and Scalability

Roomy is designed for performance and scalability from the ground up.

### Performance Features
- **Virtual Scrolling**: Efficient rendering of large message lists
- **Lazy Loading**: Load content only when needed
- **Optimistic Updates**: Immediate UI feedback for better UX
- **Efficient State Management**: Minimal re-renders with Svelte 5

### Scalability Considerations
- **Offline-First**: Reduces server load and improves reliability
- **P2P Communication**: Direct communication reduces server dependency
- **Local Processing**: Most operations happen locally
- **Efficient Sync**: Only changes are synchronized

---

*These core concepts form the foundation of the Roomy application. Understanding these concepts is essential for developing and extending the application.* 