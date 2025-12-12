# Roomy App Testing Documentation

This directory contains end-to-end tests for the Roomy app using Playwright, with a focus on cross-browser compatibility and worker system functionality.

## Overview

The testing suite is designed to verify that Roomy's complex worker-based architecture functions correctly across different browsers and device configurations. The app uses SharedWorkers (with Worker fallback), SQLite via WebAssembly, and lock management for multi-tab coordination.

## Prerequisites

### Browser Requirements

The app requires specific browser APIs to function:

**Critical (Required):**

- Web Workers ✅
- MessageChannel API ✅
- IndexedDB ✅
- WebAssembly ✅
- Web Locks API ✅
- Crypto API (with randomUUID) ✅
- Fetch API ✅

**Optimal (Preferred):**

- SharedWorker API ✅ (Chrome/Firefox)
- BroadcastChannel API ✅
- SharedArrayBuffer support ✅ (with proper headers)

### Browser-Specific Notes

- **Chrome/Chromium**: Full support with optimal performance
- **Firefox**: Full support with custom preferences for SharedArrayBuffer
- **Safari**: Basic functionality works, but may have timeouts with complex SQLite operations
- **Mobile**: Core functionality tested and working

## Installation

1. Install Playwright and browsers:

```bash
cd packages/app
pnpm install 
pnpm exec playwright install
```

2. Optional - Install Edge browser for additional testing:

```bash
pnpm exec playwright install msedge
```

## Running Tests

### Basic Usage

```bash
# Run smoke tests (recommended for quick verification)
pnpm exec playwright test smoke.spec.ts

# Run all tests headlessly
pnpm test:e2e

# Run with interactive UI (great for development and debugging)
pnpm test:e2e:ui

# Run with browser visible
pnpm test:e2e:headed

# Debug step by step
pnpm test:e2e:debug
```
