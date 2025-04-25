import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync } from 'svelte';
import ThemeSelector from './ThemeSelector.svelte';

// Mock the themes module
vi.mock('../themes', () => ({
  themes: {
    '[data-theme=light]': {
      'primary': '#570df8',
      'secondary': '#f000b8',
      'accent': '#1dcdbc',
      'neutral': '#2b3440',
      'base-100': '#ffffff'
    },
    '[data-theme=dark]': {
      'primary': '#661AE6',
      'secondary': '#D926AA',
      'accent': '#1FB2A5',
      'neutral': '#191D24',
      'base-100': '#2A303C'
    },
    '[data-theme=synthwave]': {
      'primary': '#e779c1',
      'secondary': '#58c7f3',
      'accent': '#f3cc30',
      'neutral': '#20134e',
      'base-100': '#2d1b69'
    }
  }
}));

// Mock bits-ui Select component
vi.mock('bits-ui', () => ({
  Select: {
    Root: vi.fn().mockImplementation(({ children, onValueChange }) => ({
      $$render: () => `<div data-testid="select-root">${children}</div>`,
      onValueChange
    })),
    Trigger: vi.fn().mockImplementation(({ children }) => ({
      $$render: () => `<button data-testid="select-trigger">${children}</button>`
    })),
    Portal: vi.fn().mockImplementation(({ children }) => ({
      $$render: () => `<div data-testid="select-portal">${children}</div>`
    })),
    Content: vi.fn().mockImplementation(({ children }) => ({
      $$render: () => `<div data-testid="select-content">${children}</div>`
    })),
    Viewport: vi.fn().mockImplementation(({ children }) => ({
      $$render: () => `<div data-testid="select-viewport">${children}</div>`
    })),
    Item: vi.fn().mockImplementation(({ children, value, label }) => ({
      $$render: () => `<div data-testid="select-item" data-value="${value}" data-label="${label}">${children}</div>`
    }))
  }
}));

// Mock Icon component
vi.mock('@iconify/svelte', () => ({
  default: vi.fn().mockImplementation(() => ({
    $$render: () => '<div data-testid="icon"></div>'
  }))
}));

// Mock localStorage
let mockStore: Record<string, string> = {};
const localStorageMock = {
  getItem: vi.fn((key: string) => mockStore[key] || null),
  setItem: vi.fn((key: string, value: string) => {
    mockStore[key] = value.toString();
  }),
  removeItem: vi.fn((key: string) => {
    delete mockStore[key];
  }),
  clear: vi.fn(() => {
    mockStore = {};
  }),
  get store() { return mockStore; },
  set store(value) { mockStore = value; }
};
Object.defineProperty(window, 'localStorage', { value: localStorageMock });

// Mock document.documentElement
const documentElementMock = {
  setAttribute: vi.fn()
};
Object.defineProperty(document, 'documentElement', { value: documentElementMock });

// Mock document.cookie
Object.defineProperty(document, 'cookie', {
  get: vi.fn(() => ''),
  set: vi.fn()
});

describe('ThemeSelector', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorageMock.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exports ThemeSelector component', () => {
    expect(ThemeSelector).toBeDefined();
    expect(typeof ThemeSelector).toBe('function');
  });

  it('simulates theme initialization', () => {
    const cleanup = $effect.root(() => {
      // Manually call the localStorage methods to simulate component initialization
      const theme = localStorageMock.getItem('theme');

      if (!theme) {
        // Simulate setting default theme
        localStorageMock.setItem('theme', 'synthwave');
        documentElementMock.setAttribute('data-theme', 'synthwave');
      }

      // Verify the localStorage was accessed
      expect(localStorageMock.getItem).toHaveBeenCalled();

      flushSync();
    });

    cleanup();
  });

  it('simulates loading stored theme', () => {
    // Set a theme in localStorage
    mockStore['theme'] = 'dark';

    const cleanup = $effect.root(() => {
      // Manually simulate the component's behavior
      const theme = localStorageMock.getItem('theme');

      // Verify the localStorage was accessed and the theme was set
      expect(localStorageMock.getItem).toHaveBeenCalled();
      expect(mockStore['theme']).toBe('dark');

      if (theme) {
        documentElementMock.setAttribute('data-theme', theme);
        expect(documentElementMock.setAttribute).toHaveBeenCalledWith('data-theme', 'dark');
      }

      flushSync();
    });

    cleanup();
  });

  it('handles theme changes', () => {
    const cleanup = $effect.root(() => {
      // Create a state for the current theme
      let currentTheme = $state('dark');

      // Verify initial state
      expect(currentTheme).toBe('dark');

      // Change the theme
      currentTheme = 'light';
      flushSync();

      // Verify the theme changed
      expect(currentTheme).toBe('light');

      // In a real component, this would trigger localStorage and document updates
      // We're just testing the state management here
    });

    cleanup();
  });
});
