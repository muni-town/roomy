// Network status monitoring utility

// Create a reactive state to track network status
export const networkStatus = $state({
  isOnline: navigator.onLine,
  lastSyncAttempt: null as Date | null,
  syncServerReachable: true,
  reconnectAttempts: 0,
});

// Listen for online/offline events
window.addEventListener('online', () => {
  console.log('Device is now online');
  networkStatus.isOnline = true;
  checkSyncServerConnection();
});

window.addEventListener('offline', () => {
  console.log('Device is now offline');
  networkStatus.isOnline = false;
  networkStatus.syncServerReachable = false;
});

// Function to check if the sync server is reachable
export async function checkSyncServerConnection() {
  if (!networkStatus.isOnline) {
    networkStatus.syncServerReachable = false;
    return false;
  }

  try {
    networkStatus.lastSyncAttempt = new Date();

    // Try to reach the sync server (just checking if the domain is reachable)
    // Note: The sync server doesn't have a health endpoint, so we'll just check if we get any response
    await fetch('https://syncserver.roomy.chat/', {
      method: 'HEAD',
      // Short timeout to avoid hanging
      signal: AbortSignal.timeout(5000)
    });

    // Consider any response (even 404) as a sign that the server is up
    // The important thing is that we got a response, not what the response is
    const isReachable = true; // If we got here, we received a response
    networkStatus.syncServerReachable = isReachable;

    if (isReachable) {
      networkStatus.reconnectAttempts = 0;
      console.log('Sync server is reachable (received response)');
    } else {
      networkStatus.reconnectAttempts++;
      console.error('Sync server returned an error status');
    }

    return isReachable;
  } catch (error) {
    networkStatus.syncServerReachable = false;
    networkStatus.reconnectAttempts++;
    console.error('Failed to reach sync server:', error);
    return false;
  }
}

// Check connection status initially
checkSyncServerConnection();

// Export a function to manually trigger reconnection
export function attemptReconnect() {
  if (networkStatus.isOnline) {
    console.log('Attempting to reconnect to sync server...');
    return checkSyncServerConnection();
  }
  return Promise.resolve(false);
}
