import { Deferred } from "./Deferred";

export type TrackableState<State, Status> = {
  init: State;
  mapper: (state: State) => Status;
};
export const trackableState = <State, Status>(
  init: State,
  mapper: (state: State) => Status,
): TrackableState<State, Status> => ({
  init,
  mapper,
});

/** A state machien that allows subscribing to state transitions. */
export type StateMachine<State extends { state: string }> = {
  /** Get the current state. */
  get current(): Readonly<State>;

  /** Set the current state. This will automatically update subscribers. */
  set current(state: State);

  /** Returns a promise that will resolve when the given state is transitioned to. */
  transitionedTo<S extends State["state"]>(
    state: S,
  ): Promise<Extract<Readonly<State>, { state: S }>>;

  /** Add a handler that will be run when the state changes. */
  subscribe(
    handler: (oldState: Readonly<State>, newState: Readonly<State>) => void,
  ): void;
};

/** An extended {@link StateMachine} that also tracks a status derived from the state. */
export type StatusMachine<
  State extends { state: string },
  Status,
> = StateMachine<State> & {
  /** Get the current status */
  get status(): Status;

  /** Register a callback to be caled with the status whenever the state changes. */
  subscribeStatus: (handler: (status: Status) => void) => void;
};

/** Create a {@link StateMachine} with the provided initial state. */
export function stateMachine<State extends { state: string }>(
  initState: State,
): StateMachine<State> {
  let state = initState;

  let subscribers: ((
    oldState: Readonly<State>,
    newState: Readonly<State>,
  ) => void)[] = [];

  // Map of deferred promises created when `transitionTo` is used to wait for a transition to a
  // specific state.
  let stateDeferreds: Map<
    State["state"],
    Deferred<Readonly<State>>
  > = new Map();

  return {
    get current() {
      return state;
    },
    set current(value) {
      const previousState = state;
      // Update the internal state
      state = value;

      // Check for a promise that might be waiting on this state transition.
      const deferred = stateDeferreds.get(state.state);
      if (deferred) {
        // Resolve the promise so that any task waiting on it is unpaused.
        deferred.resolve(state);

        // Remove it from our list of waiting promises
        stateDeferreds.delete(state.state);
      }

      // Notify all the subscribers of the state change
      for (const handler of subscribers) {
        handler(previousState, state);
      }
    },
    subscribe(handler) {
      subscribers.push(handler);
    },
    transitionedTo(desiredState) {
      type ReturnType = Promise<
        Extract<Readonly<State>, { state: typeof desiredState }>
      >;

      // If we are alredy in the desired state, resolve immediately
      if (state.state == desiredState) {
        return Promise.resolve(state) as ReturnType;
      }

      // If we already have a promise waiting on this state transition, then just return it.
      const existing = stateDeferreds.get(desiredState);
      if (existing) return existing.promise as ReturnType;

      // If we don't have a promise waiting on this state yet, create a new one.
      const deferred = new Deferred<Readonly<State>>();

      // Register it for future use
      stateDeferreds.set(desiredState, deferred);

      // And return the new promise
      const ret = deferred.promise as ReturnType;

      return ret;
    },
  };
}

/** Helper class that will track changes to the state and update a reactive status, mapping the
 * state to the status value. */
export function statusMachine<State extends { state: string }, Status>(
  trackable: TrackableState<State, Status>,
): StatusMachine<State, Status> {
  let mapper = trackable.mapper;
  let machine = stateMachine(trackable.init);

  let statusSubscribers: ((status: Status) => void)[] = [];

  // Notify any status subscribers whenever the state changes.
  machine.subscribe((_oldState, newState) => {
    const newStatus = mapper(newState);
    for (const handler of statusSubscribers) {
      handler(newStatus);
    }
  });

  return {
    get current() {
      return machine.current;
    },
    set current(value) {
      machine.current = value;
    },
    subscribe: machine.subscribe,
    transitionedTo: machine.transitionedTo,
    get status() {
      return mapper(machine.current);
    },
    subscribeStatus(handler: (status: Status) => void) {
      statusSubscribers.push(handler);
    },
  };
}
