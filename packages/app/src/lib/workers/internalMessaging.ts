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

export type MessagePortInterfaceConfig<Local extends HalfInterface> = {
  localName?: string;
  remoteName?: string;
  messagePort: MessagePortApi;
  handlers: Local;
  timeout?: {
    ms: number;
    onTimeout: (method: string, requestId: string) => void;
  };
  onError?: (error: unknown, method: string, args: unknown[]) => void;
};

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
>(config: MessagePortInterfaceConfig<Local>): Remote {
  const {
    localName,
    remoteName,
    messagePort,
    handlers,
    timeout = {
      ms: 5000,
      onTimeout: (method, reqId) => {
        if (method !== "log")
          console.warn(
            `RPC Timeout [${remoteName}${localName ? " <- " + localName : ""}]`,
            {
              method,
              reqId,
            },
          );
      },
    },
    onError = (error, method, args) => {
      console.error(
        `RPC error in "${method} [${remoteName}${localName ? " from " + localName : ""}]":`,
        error,
        ...(args.length ? ["Args:", args] : []),
      );
    },
  } = config;

  const pendingResponseResolvers: {
    [key: string]: {
      resolve: (resp: ReturnType<Remote[keyof Remote]>) => void;
      reject: (error: any) => void;
      timerId?: ReturnType<typeof setTimeout>;
      method: string;
    };
  } = {};

  messagePort.onmessage = async (
    ev: MessageEvent<IncomingMessage<Local, Remote>>,
  ) => {
    const type = ev.data[0];
    if (type == "call") {
      const [, name, requestId, ...parameters] = ev.data;
      for (const [event, handler] of Object.entries(handlers)) {
        if (event == name) {
          try {
            const resp = await handler(...parameters);
            messagePort.postMessage(["response", requestId, "resolve", resp]);
          } catch (e) {
            onError?.(e, String(name), parameters);
            messagePort.postMessage(["response", requestId, "reject", e]);
          }
        }
      }
    } else if (type == "response") {
      const [, requestId, action, data] = ev.data;
      const pending = pendingResponseResolvers[requestId];
      if (pending) {
        if (pending.timerId !== undefined) {
          clearTimeout(pending.timerId);
        }
        if (action === "reject") {
          onError?.(data, pending.method, []);
        }
        pending[action](data);
        delete pendingResponseResolvers[requestId];
      }
    }
  };

  return new Proxy(
    { messagePort },
    {
      get({ messagePort }, name) {
        const n = name as keyof Remote;
        return (
          ...args: Parameters<Remote[typeof n]>
        ): ReturnType<Remote[typeof n]> => {
          const reqId = crypto.randomUUID();
          const method = String(n);

          const respPromise = new Promise((resolve, reject) => {
            const pending: (typeof pendingResponseResolvers)[string] = {
              resolve,
              reject,
              method,
            };

            if (timeout) {
              pending.timerId = setTimeout(() => {
                if (pendingResponseResolvers[reqId]) {
                  timeout.onTimeout(method, reqId);
                  delete pendingResponseResolvers[reqId];
                }
              }, timeout.ms);
            }

            pendingResponseResolvers[reqId] = pending;
          });

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

type ReactiveChannelStateMessage = ["need", string] | ["update", string, any];

/** The wrapper for the reactive state object returned by `reactiveChannelState()`. */
export type ReactiveChannelState<T> = { [K in keyof T]?: Readonly<T[K]> } & {
  current: { [key: string]: Readonly<any> | undefined };
  updateChannel: (channel: MessagePortApi) => void;
};

/**
 * Create an object with svelte reactive properties ( shallow reactivity, not deep ), that will
 * reactively update by sending messages over a message port.
 *
 * When using a broadcast channel for the message port, you can sync reactive state from a worker to
 * several other observers.
 *
 * When a new reactive state is created, if it is not a `provider` it will send a `need` message
 * over the message port to notify the `provider` that it wants to access a certain value. The
 * provider, if it has data for that key, will then send an `update` message to provide the value to
 * the observer.
 *
 * Note that there is generally only one provider, and the rest are observers.
 *
 * The messages are sent transparently and, for the most part, the data is automatically reactive.
 *
 * Also note that values only have shallow reactivity, so if you have an object as a key, you need
 * to re-assign the entire object when making changes for the observers to see the change.
 *
 * @param channel can be anything that implements the `MessagePortApi` and is often a
 * `BroadcastChannel` which can be used to sync a reactive state even across different workers.
 * @param provider sets whether or not this is instance will be the provider.
 * */
export function reactiveChannelState<T extends { [key: string]: any }>(
  channel: MessagePortApi,
  provider: boolean,
): ReactiveChannelState<T> {
  /** Internal state for reactive syncing. */
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

  /** Helper to setup the message handler for the channel. */
  const setupChannel = () => {
    state.channel.onmessage = (ev) => {
      const data: ReactiveChannelStateMessage = ev.data;
      if (data[0] == "update") {
        const [, prop, value] = data;
        state.props[prop] = value;
        state.propUpdateSubscribers[prop]?.();
      } else if (data[0] == "need" && provider == true) {
        const [, prop] = ev.data;
        state.channel.postMessage(["update", prop, state.props[prop]]);
      }
    };
  };

  // Call it immediately to setup the channel
  setupChannel();

  return new Proxy(state, {
    get(state, prop) {
      if (typeof prop == "symbol") throw "Symbols not supported";

      if (prop === "current") {
        return { ...state.props };
      } else if (prop === "updateChannel") {
        return (channel: MessagePortApi) => {
          // Update the channel
          state.channel = channel;
          // And make sure it gets setup
          setupChannel();
        };
      }

      let subscribe = state.propSubscribe[prop];
      if (!subscribe) {
        subscribe = createSubscriber(
          (update) => (state.propUpdateSubscribers[prop] = update),
        );
        state.propSubscribe[prop] = subscribe;
        state.channel.postMessage([
          "need",
          prop,
        ] satisfies ReactiveChannelStateMessage);
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
      ] satisfies ReactiveChannelStateMessage);

      return true;
    },
  }) as unknown as ReactiveChannelState<T>;
}
