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
    messagePort,
    handlers,
    timeout = {
      ms: 5000,
      onTimeout: (method, reqId) => {
        if (method !== "log")
          console.warn("Backend RPC Timeout", { method, reqId });
      },
    },
    onError = (error, method, args) => {
      console.error(
        `RPC error in "${method}":`,
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

type ReactiveWorkerStateMessage = ["need", string] | ["update", string, any];

export type ReactiveWorkerState<T> = Partial<T> & {
  current: { [key: string]: any | undefined };
};

/**
 * Create an object with reactive properties ( shallow reactivity, not deep ), that will reactively
 * update svelte even when updated from a worker.
 * */
export function reactiveWorkerState<T extends { [key: string]: any }>(
  channel: MessagePortApi,
  provider: boolean,
): ReactiveWorkerState<T> {
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

      if (prop === "current") {
        return { ...state.props };
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
  }) as unknown as ReactiveWorkerState<T>;
}
