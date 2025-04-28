import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { focusOnRender } from './useFocusOnRender.svelte';

// Mock Svelte's tick function
vi.mock('svelte', () => ({
  tick: vi.fn().mockResolvedValue(undefined)
}));

import { tick } from 'svelte';

describe('focusOnRender', () => {
  let element: HTMLElement;

  beforeEach(() => {
    // Reset mocks
    vi.resetAllMocks();

    // Create a mock element
    element = {
      focus: vi.fn()
    } as unknown as HTMLElement;

    // Setup tick to resolve immediately
    (tick as any).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls focus on the element after two ticks', async () => {
    // Create a promise that resolves on the second tick call
    let secondTickResolve: () => void;
    const secondTickPromise = new Promise<void>(resolve => {
      secondTickResolve = resolve;
    });

    // First tick call returns a resolved promise
    (tick as any).mockResolvedValueOnce(undefined);

    // Second tick call returns a promise we control
    (tick as any).mockReturnValueOnce({
      then: (callback: () => void) => {
        // When the second tick resolves, call the callback and resolve our promise
        secondTickPromise.then(() => callback());
        return { catch: vi.fn() };
      }
    });

    // Call the action
    focusOnRender(element);

    // Verify tick was called once initially
    expect(tick).toHaveBeenCalledTimes(1);

    // Wait for the first tick to complete
    await Promise.resolve();

    // Verify tick was called a second time
    expect(tick).toHaveBeenCalledTimes(2);

    // Element should not be focused yet
    expect(element.focus).not.toHaveBeenCalled();

    // Resolve the second tick
    secondTickResolve();
    await Promise.resolve();

    // Now the element should be focused
    expect(element.focus).toHaveBeenCalledTimes(1);
  });

  it('does nothing if element is null', async () => {
    focusOnRender(null);

    // Tick should still be called
    expect(tick).toHaveBeenCalledTimes(1);

    // Wait for all promises to resolve
    await Promise.resolve();

    // Second tick should not be called
    expect(tick).toHaveBeenCalledTimes(1);
  });
});
