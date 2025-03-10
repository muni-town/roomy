export const IN_TAURI = '__TAURI__' in window

/**
 * Command arguments.
 *
 * @since 1.0.0
 */
type InvokeArgs = Record<string, unknown> | number[] | ArrayBuffer | Uint8Array;
/**
 * @since 2.0.0
 */
interface InvokeOptions {
  headers: Headers | Record<string, string>;
}
/**
 * Sends a message to the backend.
 * @example
 * ```typescript
 * import { invoke } from '@tauri-apps/api/core';
 * await invoke('login', { user: 'tauri', password: 'poiwe3h4r5ip3yrhtew9ty' });
 * ```
 *
 * @param cmd The command name.
 * @param args The optional arguments to pass to the command.
 * @param options The request options.
 * @return A promise resolving or rejecting to the backend response.
 *
 * @since 1.0.0
 */
export async function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T | null> {
  if (!('__TAURI__' in window)) throw Error('This function can only run in tauri')

  return await (window.__TAURI__ as any).core.invoke(cmd, args, options)
}
