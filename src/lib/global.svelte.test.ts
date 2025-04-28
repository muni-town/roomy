import { describe, it, expect, vi, beforeEach } from 'vitest';
import { g } from './global.svelte';

// Mock dependencies
vi.mock('$app/state', () => ({
  page: {
    params: {},
    url: new URL('http://localhost')
  }
}));

vi.mock('./utils.svelte', () => ({
  navigate: vi.fn(),
  resolveLeafId: vi.fn().mockResolvedValue('leaf:abc123')
}));

vi.mock('./user.svelte', () => ({
  user: {
    agent: null
  }
}));

vi.mock('@muni-town/leaf-svelte', () => ({
  SveltePeer: vi.fn().mockImplementation(() => ({}))
}));

vi.mock('@muni-town/leaf-storage-indexeddb', () => ({
  indexedDBStorageAdapter: vi.fn().mockReturnValue({})
}));

vi.mock('@muni-town/leaf-sync-ws', () => ({
  webSocketSyncer: vi.fn().mockResolvedValue({})
}));

vi.mock('@roomy-chat/sdk', () => ({
  Roomy: {
    init: vi.fn().mockResolvedValue({})
  },
  Channel: vi.fn(),
  EntityId: vi.fn(),
  Space: vi.fn(),
  Thread: vi.fn(),
  StorageManager: vi.fn()
}));

// Mock WebSocket
global.WebSocket = vi.fn().mockImplementation(() => ({
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  close: vi.fn()
}));

describe('global state', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('exports g object with expected properties', () => {
    expect(g).toBeDefined();
    expect(typeof g).toBe('object');

    // Check for expected properties
    expect(g).toHaveProperty('roomy');
    expect(g).toHaveProperty('loadedSpace');
    expect(g).toHaveProperty('space');
    expect(g).toHaveProperty('channel');
    expect(g).toHaveProperty('isAdmin');
    expect(g).toHaveProperty('isBanned');
    expect(g).toHaveProperty('currentCatalog');

    // Check boolean properties
    expect(typeof g.isAdmin).toBe('boolean');
    expect(typeof g.isBanned).toBe('boolean');

    // Check currentCatalog
    expect(g.currentCatalog).toBe('home');
  });

  // Note: Testing reactive effects and Svelte runes is challenging in a unit test environment
  // Most of the functionality in global.svelte.ts relies on Svelte's reactivity system
  // We're focusing on testing the initial state and exported values

  // Additional tests could be added if the file is refactored to expose more testable functions
});
