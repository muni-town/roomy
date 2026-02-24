/**
 * Conditional Web Locks utility.
 *
 * Web Locks are only needed when using SharedWorker to coordinate access to shared
 * resources (like OPFS-backed SQLite) across multiple tabs. When SharedWorker is
 * disabled, each tab has its own isolated worker and database, so locks are unnecessary
 * and can actually cause issues (tabs fighting over locks they don't need).
 *
 * This module exports lock functions that become no-ops when SharedWorker is disabled.
 */

import { flags } from "$lib/config";

type LockMode = "exclusive" | "shared";

interface LockOptions {
  mode?: LockMode;
  ifAvailable?: boolean;
  signal?: AbortSignal;
}

/**
 * Request a Web Lock, but only if SharedWorker is enabled.
 * When SharedWorker is disabled, immediately executes the callback without any locking.
 */
export async function requestLock<T>(
  name: string,
  callback: (lock: Lock | null) => T | Promise<T>,
): Promise<T>;
export async function requestLock<T>(
  name: string,
  options: LockOptions,
  callback: (lock: Lock | null) => T | Promise<T>,
): Promise<T>;
export async function requestLock<T>(
  name: string,
  optionsOrCallback: LockOptions | ((lock: Lock | null) => T | Promise<T>),
  maybeCallback?: (lock: Lock | null) => T | Promise<T>,
): Promise<T> {
  const callback =
    typeof optionsOrCallback === "function"
      ? optionsOrCallback
      : maybeCallback!;

  return navigator.locks.request(name, callback) as Promise<T>;
}

/**
 * Query the current state of Web Locks.
 * Returns empty state when SharedWorker is disabled.
 */
export async function queryLocks(): Promise<LockManagerSnapshot> {
  if (!flags.sharedWorker) {
    return { held: [], pending: [] };
  }
  return navigator.locks.query();
}

/**
 * Check if locks are enabled (SharedWorker is enabled).
 */
export function locksEnabled(): boolean {
  return flags.sharedWorker;
}
