import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invoke, IN_TAURI } from './tauri';

describe('tauri', () => {
  // Save original window object
  const originalWindow = global.window;

  beforeEach(() => {
    // Reset window to original state before each test
    global.window = originalWindow;
  });

  afterEach(() => {
    // Restore window after each test
    global.window = originalWindow;
    vi.restoreAllMocks();
  });

  describe('IN_TAURI', () => {
    it('is false when __TAURI__ is not in window', () => {
      // We can't easily test this constant since it's evaluated at import time
      // Just verify the current value based on the test environment
      expect(IN_TAURI).toBe(false);
    });
  });

  describe('invoke', () => {
    it('throws error when __TAURI__ is not in window', async () => {
      // Mock window without __TAURI__
      global.window = {} as any;

      await expect(invoke('test')).rejects.toThrow('This function can only run in tauri');
    });

    it('calls tauri invoke function with correct arguments', async () => {
      // Mock tauri invoke function
      const mockInvoke = vi.fn().mockResolvedValue('result');

      // Mock window with __TAURI__
      global.window = {
        __TAURI__: {
          core: {
            invoke: mockInvoke
          }
        }
      } as any;

      const result = await invoke('test-command', { arg1: 'value1' }, { headers: { 'Content-Type': 'application/json' } });

      expect(mockInvoke).toHaveBeenCalledWith('test-command', { arg1: 'value1' }, { headers: { 'Content-Type': 'application/json' } });
      expect(result).toBe('result');
    });

    it('works with minimal arguments', async () => {
      // Mock tauri invoke function
      const mockInvoke = vi.fn().mockResolvedValue('result');

      // Mock window with __TAURI__
      global.window = {
        __TAURI__: {
          core: {
            invoke: mockInvoke
          }
        }
      } as any;

      const result = await invoke('test-command');

      expect(mockInvoke).toHaveBeenCalledWith('test-command', undefined, undefined);
      expect(result).toBe('result');
    });
  });
});
