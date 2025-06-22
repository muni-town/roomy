# Technology Stack

*Note: This documentation page is LLM-generated and needs to be reviewed and edited.*

This document provides a comprehensive overview of all technologies, frameworks, libraries, and tools used in the Roomy application.

## Frontend Framework

### SvelteKit & Svelte 5
- **Version**: SvelteKit 2.20.7, Svelte 5.23.1
- **Purpose**: Full-stack web framework with file-based routing
- **Key Features**:
  - Server-side rendering (SSR)
  - File-based routing
  - Built-in TypeScript support
  - Optimized build output
- **Usage**: Main application framework, routing, and component system

### Svelte 5 Runes
- **Purpose**: New reactivity system for Svelte 5
- **Key Runes**:
  - `$state()` - Reactive state management
  - `$derived()` - Computed values
  - `$effect()` - Side effects
  - `$props()` - Component props
- **Usage**: State management throughout the application

## UI & Styling

### Tailwind CSS
- **Version**: 4.0.0
- **Purpose**: Utility-first CSS framework
- **Features**:
  - Responsive design utilities
  - Dark mode support
  - Custom theme configuration
  - JIT compilation
- **Usage**: Primary styling system

### DaisyUI
- **Version**: 5.0.6
- **Purpose**: Component library built on Tailwind CSS
- **Components**: Buttons, modals, forms, navigation, etc.
- **Usage**: Pre-built UI components for consistent design

### Iconify
- **Version**: 4.2.0
- **Purpose**: Icon library with unified API
- **Features**: 100,000+ icons from various icon sets
- **Usage**: Icons throughout the application

## State Management

### Jazz Framework
- **Version**: 0.14.21
- **Purpose**: CRDT-based collaborative state management
- **Key Features**:
  - Conflict-free replicated data types (CRDTs)
  - Real-time synchronization
  - Offline-first architecture
  - Automatic conflict resolution
- **Usage**: Core state management and data synchronization

### Jazz Tools
- **Version**: 0.14.21
- **Purpose**: Utilities and helpers for Jazz framework
- **Features**: Schema definitions, migration tools, utilities
- **Usage**: Data modeling and schema management

### Jazz Svelte
- **Version**: 0.14.21
- **Purpose**: Svelte integration for Jazz framework
- **Features**: Svelte stores, components, and utilities
- **Usage**: Svelte-specific Jazz integration

## Authentication & Identity

### AT Protocol (Bluesky)
- **Version**: 0.14.9
- **Purpose**: Federated social protocol for identity and authentication
- **Features**:
  - OAuth authentication
  - Decentralized identity
  - Social features
  - Federation
- **Usage**: User authentication and identity management

### OAuth Client Browser
- **Version**: 0.3.7
- **Purpose**: Browser-based OAuth client for AT Protocol
- **Usage**: OAuth flow implementation

## Real-time Communication

### WebSocket
- **Purpose**: Real-time bidirectional communication
- **Implementation**: Custom WebSocket client
- **Usage**: Live updates and synchronization

### Jazz Sync WebSocket
- **Version**: 0.1.0-preview.7
- **Purpose**: WebSocket synchronization for Jazz framework
- **Usage**: Real-time data synchronization

## Rich Text Editing

### TipTap
- **Version**: 2.11.5
- **Purpose**: Rich text editor framework
- **Extensions**:
  - `@tiptap/starter-kit` - Basic editor features
  - `@tiptap/extension-image` - Image support
  - `@tiptap/extension-link` - Link support
  - `@tiptap/extension-mention` - User mentions
  - `@tiptap/extension-placeholder` - Placeholder text
- **Usage**: Message composition and rich text editing

### BlockNote
- **Version**: 0.25.0
- **Purpose**: Block-based rich text editor
- **Features**: Block-based editing, collaborative editing
- **Usage**: Alternative rich text editor for documents

## Data Storage

### IndexedDB
- **Purpose**: Client-side database storage
- **Features**: Large storage capacity, structured data
- **Usage**: Local data persistence

### Automerge Storage IndexedDB
- **Version**: 2.0.0-collectionsync-alpha.1
- **Purpose**: IndexedDB storage for Automerge CRDTs
- **Usage**: CRDT data persistence

## Desktop Application

### Tauri
- **Version**: 2.5.0
- **Purpose**: Cross-platform desktop application framework
- **Features**: Native performance, security, small bundle size
- **Usage**: Desktop app wrapper

### Tauri Plugins
- **Deep Link**: 2.2.1 - URL scheme handling
- **Log**: 2.4.0 - Logging system
- **Opener**: 2.2.6 - External link handling
- **OS**: 2.2.1 - Operating system information

## Build Tools

### Vite
- **Version**: 6.2.2
- **Purpose**: Fast build tool and development server
- **Features**: Hot module replacement, optimized builds
- **Usage**: Development server and build system

### TypeScript
- **Version**: 5.0.0
- **Purpose**: Type-safe JavaScript development
- **Usage**: Type checking and development experience

### Vite Plugins
- **ArrayBuffer**: 0.1.0 - ArrayBuffer support
- **Top-level Await**: 1.4.4 - Top-level await support
- **WASM**: 3.4.1 - WebAssembly support

## UI Components

### Bits UI
- **Version**: 1.3.19
- **Purpose**: Headless UI components for Svelte
- **Features**: Accessible, unstyled components
- **Usage**: Base components for custom styling

### Virtua
- **Version**: 0.41.0
- **Purpose**: Virtual scrolling for large lists
- **Usage**: Performance optimization for message lists

### Toast Notifications
- **Svelte French Toast**: 2.0.0-alpha.0
- **Purpose**: Toast notification system
- **Usage**: User feedback and notifications

## Search & Discovery

### FlexSearch
- **Version**: 0.8.164
- **Purpose**: Full-text search library
- **Features**: Fast search, fuzzy matching
- **Usage**: Message and content search

## File Handling

### JSZip
- **Version**: 3.10.1
- **Purpose**: JavaScript library for creating and reading ZIP files
- **Usage**: File compression and decompression

### File Saver
- **Version**: 2.0.5
- **Purpose**: Client-side file saving
- **Usage**: Download functionality

### Zip.js
- **Version**: 2.7.59
- **Purpose**: Modern ZIP file handling
- **Usage**: Alternative ZIP processing

## Utilities

### Date-fns
- **Version**: 4.1.0
- **Purpose**: Date utility library
- **Usage**: Date formatting and manipulation

### Marked
- **Version**: 15.0.6
- **Purpose**: Markdown parser
- **Usage**: Markdown rendering

### Shiki
- **Version**: 3.2.1
- **Purpose**: Syntax highlighting
- **Usage**: Code block highlighting

### Turndown
- **Version**: 7.2.0
- **Purpose**: HTML to Markdown converter
- **Usage**: Content conversion

## Performance & Optimization

### Svelte Render Scan
- **Version**: 1.0.4
- **Purpose**: Rendering performance analysis
- **Usage**: Development debugging

### Virtual Scrolling
- **Implementation**: Custom virtual scrolling with Virtua
- **Purpose**: Performance optimization for large lists
- **Usage**: Message timeline rendering

## Security

### TweetNaCl
- **Version**: 1.0.3
- **Purpose**: High-security cryptographic library
- **Usage**: Cryptographic operations

### Noble Curves
- **Version**: 1.8.1
- **Purpose**: Elliptic curve cryptography
- **Usage**: Cryptographic operations

## Monitoring & Analytics

### PostHog
- **Version**: 1.236.1
- **Purpose**: Product analytics and user behavior tracking
- **Usage**: User analytics and feature usage tracking

## Development Environment

### Development Tools
- **Prettier**: 3.5.3 - Code formatting
- **Svelte Check**: 4.0.0 - Type checking
- **Vitest**: 3.0.9 - Unit testing
- **Lint Staged**: 15.5.0 - Pre-commit hooks

### Type Definitions
- **File Saver**: 2.0.7
- **Linkify It**: 5.0.0
- **Sanitize HTML**: 2.13.0
- **Underscore**: 1.13.0

## Deployment

### Static Site Generation
- **Adapter**: @sveltejs/adapter-static
- **Version**: 3.0.8
- **Purpose**: Static site generation for deployment
- **Usage**: Production builds

## Future Technology Considerations

### Planned Technologies
1. **End-to-End Encryption**: WebCrypto API for message encryption
2. **P2P Communication**: WebRTC for direct peer-to-peer messaging
3. **Advanced Search**: Elasticsearch or similar for full-text search
4. **Mobile App**: React Native or Flutter for mobile applications
5. **Plugin System**: Extensible architecture for third-party integrations

### Technology Evaluation Criteria
- **Performance**: Impact on application performance
- **Bundle Size**: Effect on application size
- **Maintenance**: Long-term maintainability
- **Community**: Community support and ecosystem
- **Security**: Security implications and considerations

---

*This technology stack represents the current state of the Roomy application. Technologies may be added, removed, or updated as the application evolves.* 