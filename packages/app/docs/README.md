# Roomy App Architecture Documentation

*Note: This documentation page is LLM-generated and needs to be reviewed and edited.*

Welcome to the comprehensive documentation for the Roomy app architecture. Roomy is a peer-to-peer community platform built on the AT Protocol, designed for digital gardening and collaborative spaces.

## 📚 Documentation Index

### Core Architecture
- **[Architecture Overview](./architecture-overview.md)** - High-level system architecture and design principles
- **[Technology Stack](./technology-stack.md)** - Complete list of technologies, frameworks, and libraries used
- **[Core Concepts](./core-concepts.md)** - Fundamental concepts and terminology used throughout the app

### Data & State Management
- **[Data Models](./data-models.md)** - Detailed data model definitions and relationships
- **[State Management](./state-management.md)** - How state is managed using Svelte 5 runes and Jazz framework
- **[Real-time Communication](./real-time-communication.md)** - Real-time collaboration and synchronization

### Components & UI
- **[Component Architecture](./component-architecture.md)** - Component hierarchy and core UI components
- **[Authentication](./authentication.md)** - Authentication and authorization system

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ 
- pnpm (recommended package manager)
- Modern browser with WebAssembly support

### Development Setup
```bash
# Clone the repository
git clone https://github.com/muni-town/roomy.git
cd roomy

# Install dependencies
pnpm install

# Start development server
cd packages/app
pnpm dev
```

### Key Features
- **Real-time Collaboration** - Live editing and messaging using CRDTs
- **Federated Identity** - AT Protocol integration for decentralized identity
- **Offline-First** - Works offline with local data persistence
- **Rich Content** - Support for markdown, images, and embedded content
- **Multi-platform** - Web app with desktop app support via Tauri

## 🏗️ Architecture Highlights

### Core Technologies
- **Frontend**: SvelteKit with Svelte 5 runes
- **State Management**: Jazz framework for CRDT-based collaboration
- **Authentication**: AT Protocol (Bluesky) integration
- **Styling**: Tailwind CSS with DaisyUI components
- **Real-time**: WebSocket-based synchronization

### Key Design Principles
1. **Offline-First** - All data is stored locally and syncs when online
2. **Peer-to-Peer** - Direct communication between users when possible
3. **Federated** - Integration with AT Protocol for decentralized identity
4. **Real-time** - Live collaboration with conflict resolution
5. **Accessible** - WCAG compliant UI components

## 📁 Project Structure

```
src/
├── lib/
│   ├── components/     # Reusable UI components
│   ├── jazz/          # Jazz framework integration
│   ├── types/         # TypeScript type definitions
│   ├── utils/         # Utility functions
│   └── actions/       # Server actions
├── routes/            # SvelteKit routes
├── params/           # Route parameters
└── app.*             # App configuration files
```

## 🤝 Contributing

When contributing to Roomy, please:

1. Read the relevant architecture documentation
2. Follow the established patterns and conventions
3. Test your changes thoroughly
4. Update documentation as needed

## 📖 Additional Resources

- [Jazz Framework Documentation](https://jazz.tools/)
- [AT Protocol Specification](https://atproto.com/)
- [SvelteKit Documentation](https://kit.svelte.dev/)
- [Tailwind CSS Documentation](https://tailwindcss.com/)

---

*This documentation is maintained by the Roomy development team. For questions or contributions, please open an issue on GitHub.* 