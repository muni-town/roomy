/**
 * Service worker registration utility
 * This file handles the registration and updates of the service worker
 */

/**
 * Register the service worker
 */
export function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('/service-worker.js')
        .then((registration) => {
          console.log('ServiceWorker registration successful with scope:', registration.scope);
          
          // Check for updates
          registration.addEventListener('updatefound', () => {
            const newWorker = registration.installing;
            if (newWorker) {
              newWorker.addEventListener('statechange', () => {
                console.log('ServiceWorker state changed:', newWorker.state);
              });
            }
          });
        })
        .catch((error) => {
          console.error('ServiceWorker registration failed:', error);
        });
    });
  } else {
    console.log('Service workers are not supported in this browser');
  }
}

/**
 * Unregister all service workers
 */
export async function unregisterServiceWorkers() {
  if ('serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const registration of registrations) {
      await registration.unregister();
      console.log('ServiceWorker unregistered');
    }
  }
}
