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
 * Wrap a message port to allow calling remote functions and providing functions to a remote worker.
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
