/**
 * Cached appserver HTTP origin.
 *
 * Populated during auth init from the appserver's DID document and read
 * synchronously by blob-URL resolution (media elements like `<video>` need
 * a synchronous `src`). The origin is stable for a given deployment.
 */

let cachedOrigin: string | null = null;

export function setAppserverOrigin(origin: string): void {
  cachedOrigin = origin.replace(/\/+$/, "");
}

export function getAppserverOrigin(): string | null {
  return cachedOrigin;
}
