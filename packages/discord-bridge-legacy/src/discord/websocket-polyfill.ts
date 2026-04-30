// Polyfill WebSocket for Node.js environment (required by Discordeno)
import { WebSocket as WebSocketPolyfill } from 'ws';

// Extend globalThis with WebSocket polyfill
if (!globalThis.WebSocket) {
  Object.defineProperty(globalThis, 'WebSocket', {
    value: WebSocketPolyfill,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

export {};
