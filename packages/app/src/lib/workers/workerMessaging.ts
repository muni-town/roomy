/* eslint-disable @typescript-eslint/no-explicit-any */

import { createSubscriber } from "svelte/reactivity";

export type MessagePortApi = {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage: {
    (message: any): void;
    (message: any, transfer: Transferable[]): void;
  };
};

type HalfInterface = {
  [key: string]: (...args: any[]) => Promise<unknown>;
};
type IncomingMessage<In extends HalfInterface, Out extends HalfInterface> =
  | {
    [K in keyof In]: ["call", K, string, ...Parameters<In[K]>];
  }[keyof In]
  | {
    [K in keyof Out]: [
      "response",
      string,
      "resolve" | "reject",
      ReturnType<Out[K]>,
    ];
  }[keyof Out];

/**
 * Establish a a typed bidirectional RPC (remote procedure call) layer on a message port. 
 * The `Local` type parameter defines the functions that can be called by the remote side,
 * while the `Remote` type parameter defines the functions that can be called on the returned
 * proxy object to invoke functions on the remote side.
 * 
 * Sets up a message port to listen for events representing incoming function calls, and 
 * route them to the provided local handlers. Returns a Proxy object for calling remote 
 * functions as if they were local async functions. 
 * */
export function messagePortInterface<
  Local extends HalfInterface,
  Remote extends HalfInterface,
>(messagePort: MessagePortApi, handlers: Local): Remote {
  const pendingResponseResolvers: {
    [key: string]: {
      resolve: (resp: ReturnType<Remote[keyof Remote]>) => void;
      reject: (error: any) => void;
    };
  } = {};

  messagePort.onmessage = async (
    ev: MessageEvent<IncomingMessage<Local, Remote> | ConsoleForwardMessage>,
  ) => {
    // Handle console forwarding messages
    if (Array.isArray(ev.data) && ev.data.length === 3 && ev.data[0] === 'console') {
      const [, level, args]: ConsoleForwardMessage = ev.data;
      const prefixedArgs = ['[SharedWorker]', ...args];

      switch (level) {
        case 'log':
          console.log(...prefixedArgs);
          break;
        case 'warn':
          console.warn(...prefixedArgs);
          break;
        case 'error':
          console.error(...prefixedArgs);
          break;
        case 'info':
          console.info(...prefixedArgs);
          break;
        case 'debug':
          console.debug(...prefixedArgs);
          break;
      }
      return;
    }

    const type = ev.data[0];

    if (type == "call") {
      const [, name, requestId, ...parameters] = ev.data;
      for (const [event, handler] of Object.entries(handlers)) {
        if (event == name) {
          try {
            const resp = await handler(...parameters);
            messagePort.postMessage(["response", requestId, "resolve", resp]);
          } catch (e) {
            console.error(e);
            messagePort.postMessage(["response", requestId, "reject", e]);
          }
        }
      }
    } else if (type == "response") {
      const [, requestId, action, data] = ev.data;
      pendingResponseResolvers[requestId]?.[action](data);
      delete pendingResponseResolvers[requestId];
    }
  };

  return new Proxy(
    {
      messagePort,
    },
    {
      get({ messagePort }, name) {
        const n = name as keyof Remote;
        return (
          ...args: Parameters<Remote[typeof n]>
        ): ReturnType<Remote[typeof n]> => {
          const reqId = crypto.randomUUID();
          const respPromise = new Promise(
            (resolve, reject) =>
              (pendingResponseResolvers[reqId] = { resolve, reject }),
          );
          const transferList = [];
          for (const arg of args) {
            if (arg instanceof MessagePort) {
              transferList.push(arg);
            }
          }
          messagePort.postMessage(["call", n, reqId, ...args], transferList);
          return respPromise as any;
        };
      },
    },
  ) as unknown as Remote;
}

type ReactiveWorkerStateMessage = ["need", string] | ["update", string, any];

/**
 * Create an object with reactive properties ( shallow reactivity, not deep ), that will reactively
 * update svelte even when updated from a worker.
 * */
export function reactiveWorkerState<
  T extends { [key: string]: any | undefined },
>(channel: MessagePortApi, provider: boolean): T {
  const state = {
    channel,
    props: {} as {
      [prop: string]: any | undefined;
    },
    propSubscribe: {} as {
      [prop: string]: () => void;
    },
    propUpdateSubscribers: {} as {
      [prop: string]: () => void;
    },
  };

  state.channel.onmessage = (ev) => {
    const data: ReactiveWorkerStateMessage = ev.data;
    if (data[0] == "update") {
      const [, prop, value] = data;
      state.props[prop] = value;
      state.propUpdateSubscribers[prop]?.();
    } else if (data[0] == "need" && provider == true) {
      const [, prop] = ev.data;
      state.channel.postMessage(["update", prop, state.props[prop]]);
    }
  };

  return new Proxy(state, {
    get(state, prop) {
      if (typeof prop == "symbol") throw "Symbols not supported";
      let subscribe = state.propSubscribe[prop];
      if (!subscribe) {
        subscribe = createSubscriber(
          (update) => (state.propUpdateSubscribers[prop] = update),
        );
        state.propSubscribe[prop] = subscribe;
        state.channel.postMessage([
          "need",
          prop,
        ] satisfies ReactiveWorkerStateMessage);
      }
      subscribe();
      return state.props[prop];
    },
    set(state, prop, value) {
      if (typeof prop == "symbol") throw "Symbols not supported";
      state.props[prop] = value;

      let update = state.propUpdateSubscribers[prop];
      if (!update) {
        const subscribe = createSubscriber((up) => {
          update = up;
        });
        state.propSubscribe[prop] = subscribe;
        if (update) state.propUpdateSubscribers[prop] = update;
      }
      state.channel.postMessage([
        "update",
        prop,
        value,
      ] satisfies ReactiveWorkerStateMessage);

      return true;
    },
  }) as unknown as T;
}

/**
 * Console Forwarding for SharedWorkers
 * 
 * Safari doesn't show console output from SharedWorkers in the developer tools,
 * making debugging difficult. This utility forwards console messages from 
 * SharedWorkers to the main thread where they can be seen.
 * 
 * Usage in SharedWorker:
 * ```typescript
 * function connectMessagePort(port: MessagePortApi) {
 *   // Basic usage - forwards all console messages
 *   setupConsoleForwarding(port);
 *   
 *   // Optional: disable forwarding
 *   setupConsoleForwarding(port, false);
 *   
 *   // Optional: get cleanup function to restore original console
 *   const cleanup = setupConsoleForwarding(port);
 *   // Later: cleanup(); // restores original console methods
 *   
 *   console.log("This will appear in main thread console with [SharedWorker] prefix");
 * }
 * ```
 * 
 * The main thread automatically receives and displays these messages when using
 * messagePortInterface() - no additional setup required on the main thread.
 * 
 * All console methods are supported: log, warn, error, info, debug
 * Messages appear in both the worker context (if available) and the main thread.
 */

/**
 * Console forwarding message types
 */
type ConsoleLevel = 'log' | 'warn' | 'error' | 'info' | 'debug';
type ConsoleForwardMessage = ['console', ConsoleLevel, any[]];

/**
 * Sets up console forwarding from a worker to the main thread via a message port.
 * Call this in the worker to forward all console messages to the main thread.
 * 
 * @param messagePort - The message port to send console messages through
 * @param enabled - Whether to enable console forwarding (default: true)
 * @returns A cleanup function to restore original console methods
 */
export function setupConsoleForwarding(messagePort: MessagePortApi, enabled: boolean = true): () => void {
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug,
  };

  const forwardConsoleMessage = (level: ConsoleLevel, args: any[]) => {
    // Send to main thread if enabled
    if (enabled) {
      try {
        messagePort.postMessage(['console', level, args] satisfies ConsoleForwardMessage);
      } catch (e) {
        // Fallback to original console if forwarding fails
        originalConsole[level](...args);
        return;
      }
    }

    // Also call original console method so logs still appear in worker context if available
    originalConsole[level](...args);
  };

  // Override console methods only if enabled
  if (enabled) {
    console.log = (...args: any[]) => forwardConsoleMessage('log', args);
    console.warn = (...args: any[]) => forwardConsoleMessage('warn', args);
    console.error = (...args: any[]) => forwardConsoleMessage('error', args);
    console.info = (...args: any[]) => forwardConsoleMessage('info', args);
    console.debug = (...args: any[]) => forwardConsoleMessage('debug', args);
  }

  // Return cleanup function to restore original console methods
  return () => {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    console.info = originalConsole.info;
    console.debug = originalConsole.debug;
  };
}
