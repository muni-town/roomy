/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />

// Import service worker components from SvelteKit
import { build, files, version } from '$service-worker';

declare const self: ServiceWorkerGlobalScope;

// Create a unique cache name for this deployment
const CACHE = `cache-${version}`;

const ASSETS = [
    ...build, // the app itself
    ...files  // everything in `static`
];

self.addEventListener('install', (event) => {
    console.log('[ServiceWorker] Install');
    // Create a new cache and add all files to it
    async function addFilesToCache() {
        try {
            const cache = await caches.open(CACHE);
            await cache.addAll(ASSETS);
            console.log('[ServiceWorker] Cache populated successfully');
        } catch (error) {
            console.error('[ServiceWorker] Cache population failed:', error);
        }
    }

    event.waitUntil(addFilesToCache());
});

self.addEventListener('activate', (event) => {
    console.log('[ServiceWorker] Activate');
    // Remove previous cached data from disk
    async function deleteOldCaches() {
        try {
            const cacheKeys = await caches.keys();
            for (const key of cacheKeys) {
                if (key !== CACHE) {
                    console.log(`[ServiceWorker] Deleting old cache: ${key}`);
                    await caches.delete(key);
                }
            }
            console.log('[ServiceWorker] Old caches deleted successfully');
        } catch (error) {
            console.error('[ServiceWorker] Error deleting old caches:', error);
        }
    }

    event.waitUntil(deleteOldCaches());
});

self.addEventListener('fetch', (event) => {
    // ignore POST requests etc
    if (event.request.method !== 'GET') return;

    async function respond() {
        try {
            const url = new URL(event.request.url);
            const cache = await caches.open(CACHE);

            // `build`/`files` can always be served from the cache
            if (ASSETS.includes(url.pathname)) {
                const cachedResponse = await cache.match(url.pathname);
                if (cachedResponse) {
                    return cachedResponse;
                }
            }

            // for everything else, try the network first, but
            // fall back to the cache if we're offline
            try {
                const response = await fetch(event.request);

                if (response.status === 200) {
                    await cache.put(event.request, response.clone());
                }

                return response;
            } catch (networkError) {
                console.log('[ServiceWorker] Network request failed, falling back to cache', networkError);
                const cachedResponse = await cache.match(event.request);
                if (cachedResponse) {
                    return cachedResponse;
                }
                throw networkError;
            }
        } catch (error) {
            console.error('[ServiceWorker] Error in fetch handler:', error);
            throw error;
        }
    }

    event.respondWith(respond());
});
