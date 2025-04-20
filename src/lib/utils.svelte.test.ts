import { describe, it, expect, vi, beforeEach } from 'vitest';
import { goto } from '$app/navigation';
import * as utils from './utils.svelte';
import { browser } from '$app/environment';

// Mock dependencies
vi.mock('./base32', () => ({
  decodeBase32: vi.fn(() => new Uint8Array([1,2,3]))
}));

// Mock browser environment
vi.mock('$app/environment', () => ({
  browser: false // Mock browser as false by default
}));

// Mock navigation
vi.mock('$app/navigation', () => ({
  goto: vi.fn()
}));

// Mock fetch for API calls
const mockFetch = vi.fn();
global.fetch = mockFetch;

beforeEach(() => {
  vi.resetAllMocks();
  // Default mock implementation for fetch
  mockFetch.mockImplementation(async (url) => ({
    json: async () => {
      if (url.toString().includes('plc.directory')) {
        return { id: 'did:example:123', publicKey: 'MFRGGZDFMY' };
      }
      if (url.toString().includes('key.public')) {
        return { publicKey: 'MFRGGZDFMY' };
      }
      if (url.toString().includes('resolve-leaf-id')) {
        return { id: 'leaf:abc123' };
      }
      return {};
    }
  }));
});

describe('cleanHandle', () => {
  it('removes invalid characters', () => {
    expect(utils.cleanHandle('foo@bar!baz.com')).toBe('foobarbaz.com');
    expect(utils.cleanHandle('A-Z_123')).toBe('A-Z_123'.replace(/[^a-z0-9-\.]/gi, ''));
  });
});

describe('navigate', () => {
  it('navigates to home', () => {
    const url = utils.navigate('home');
    expect(url).toBe('/home');
    expect(goto).not.toHaveBeenCalled();
  });

  it('navigates to space/channel/thread', () => {
    let url = utils.navigate({ space: 'abc', channel: 'chan' });
    expect(url).toBe('/abc/chan');
    expect(goto).not.toHaveBeenCalled();

    url = utils.navigate({ space: 'abc', thread: 't' });
    expect(url).toBe('/abc/thread/t');

    url = utils.navigate({ space: 'a.b', channel: 'chan' });
    expect(url).toBe('/-/a.b/chan');
  });

  // We're not testing browser=true case as it's difficult to mock properly

  it('returns empty string for invalid input', () => {
    // @ts-expect-error - Testing invalid input
    const result = utils.navigate({});
    expect(result).toBe('');
  });
});

describe('resolveDid', () => {
  it('fetches and returns DidDocument', async () => {
    const doc = await utils.resolveDid('did:example:123');
    expect(doc).toEqual({ id: 'did:example:123', publicKey: 'MFRGGZDFMY' });
    expect(fetch).toHaveBeenCalledWith('https://plc.directory/did:example:123');
  });

  // We're not testing cache functionality as it's difficult to reset between tests

  it('handles fetch errors gracefully', async () => {
    mockFetch.mockImplementationOnce(() => {
      throw new Error('Network error');
    });

    const result = await utils.resolveDid('did:error');
    expect(result).toBeUndefined();
  });
});

describe('resolvePublicKey', () => {
  it('fetches and decodes public key', async () => {
    const key = await utils.resolvePublicKey('did:example:123');
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key[0]).toBe(1);
    expect(fetch).toHaveBeenCalledWith(
      'https://keyserver.roomy.chat/xrpc/chat.roomy.v0.key.public?did=did%3Aexample%3A123'
    );
  });

  // We're not testing cache functionality as it's difficult to reset between tests
});

describe('resolveLeafId', () => {
  it('fetches and returns leaf ID', async () => {
    const id = await utils.resolveLeafId('example.com');
    expect(id).toBe('leaf:abc123');
    expect(fetch).toHaveBeenCalledWith(
      'https://leaf-resolver.roomy.chat/xrpc/town.muni.01JQ1SV7YGYKTZ9JFG5ZZEFDNK.resolve-leaf-id?domain=example.com',
      { headers: [['accept', 'application/json']] }
    );
  });
});

// We're not testing derivePromise as it uses Svelte runes that can only be tested in .svelte files
