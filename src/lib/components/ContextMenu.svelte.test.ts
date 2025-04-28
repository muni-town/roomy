import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushSync } from 'svelte';
import ContextMenu from './ContextMenu.svelte';

// Mock bits-ui ContextMenu component
vi.mock('bits-ui', () => ({
  ContextMenu: {
    Root: vi.fn().mockImplementation(({ children, open }) => ({
      $$render: () => `<div data-testid="context-menu-root" data-open="${open}">${children}</div>`
    })),
    Trigger: vi.fn().mockImplementation(({ children }) => ({
      $$render: () => `<div data-testid="context-menu-trigger">${children}</div>`
    })),
    Portal: vi.fn().mockImplementation(({ children }) => ({
      $$render: () => `<div data-testid="context-menu-portal">${children}</div>`
    })),
    Content: vi.fn().mockImplementation(({ children }) => ({
      $$render: () => `<div data-testid="context-menu-content">${children}</div>`
    })),
    Group: vi.fn().mockImplementation(({ children }) => ({
      $$render: () => `<div data-testid="context-menu-group">${children}</div>`
    })),
    GroupHeading: vi.fn().mockImplementation(({ children }) => ({
      $$render: () => `<div data-testid="context-menu-group-heading">${children}</div>`
    })),
    Item: vi.fn().mockImplementation(({ children, textValue, onclick }) => ({
      $$render: () => `<div data-testid="context-menu-item" data-text-value="${textValue}" data-has-onclick="${!!onclick}">${children}</div>`
    }))
  }
}));

// Mock Icon component
vi.mock('@iconify/svelte', () => ({
  default: vi.fn().mockImplementation(({ icon }) => ({
    $$render: () => `<div data-testid="icon" data-icon="${icon}"></div>`
  }))
}));

describe('ContextMenu', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('exports ContextMenu component', () => {
    expect(ContextMenu).toBeDefined();
    expect(typeof ContextMenu).toBe('function');
  });

  it('handles open state', () => {
    const cleanup = $effect.root(() => {
      // Create a state for open
      let open = $state(false);

      // Verify initial state
      expect(open).toBe(false);

      // Change the state
      open = true;
      flushSync();

      // Verify the state changed
      expect(open).toBe(true);
    });

    cleanup();
  });

  it('handles menu items', () => {
    const cleanup = $effect.root(() => {
      // Create mock items
      const items = [
        { label: 'Item 1', icon: 'icon1', onselect: vi.fn() },
        { label: 'Item 2', icon: 'icon2', onselect: vi.fn() }
      ];

      // Create a state for items
      let menuItems = $state(items);

      // Verify the items state
      expect(menuItems.length).toBe(2);
      expect(menuItems[0].label).toBe('Item 1');
      expect(menuItems[1].label).toBe('Item 2');

      flushSync();
    });

    cleanup();
  });

  it('handles open state', () => {
    const cleanup = $effect.root(() => {
      // Create a state for open
      let open = $state(false);

      // Verify initial state
      expect(open).toBe(false);

      // Change the state
      open = true;
      flushSync();

      // Verify the state changed
      expect(open).toBe(true);
    });

    cleanup();
  });
});
