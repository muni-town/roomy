interface LoadingState {
  status: "loading";
}

interface ErrorState {
  status: "error";
  message: string;
}

interface SuccessState<T> {
  status: "success";
  data: T;
  stale?: boolean;
}

interface IdleState {
  status: "idle";
}

export type AsyncState<T> = LoadingState | ErrorState | SuccessState<T>;
export type AsyncStateWithIdle<T> = AsyncState<T> | IdleState;

export function mapAsyncState<T, U>(
  state: AsyncState<T>,
  fn: (data: T) => U,
): AsyncState<U> {
  if (state.status === "success") {
    return { status: "success", data: fn(state.data), stale: state.stale };
  }
  return state;
}

// With idle support
export function mapAsyncStateWithIdle<T, U>(
  state: AsyncStateWithIdle<T>,
  fn: (data: T) => U,
): AsyncStateWithIdle<U> {
  if (state.status === "success") {
    return { status: "success", data: fn(state.data), stale: state.stale };
  }
  return state;
}

// Combine multiple async states - all must succeed
export function combineAsyncState<
  T extends Record<string, AsyncState<unknown>>,
>(
  states: T,
): AsyncState<{
  [K in keyof T]: T[K] extends AsyncState<infer U> ? U : never;
}> {
  const entries = Object.entries(states);

  // First error wins
  const error = entries.find(([_, s]) => s.status === "error");
  if (error) return error[1] as ErrorState;

  // Any loading means loading
  if (entries.some(([_, s]) => s.status === "loading")) {
    return { status: "loading" };
  }

  // All success
  const data = Object.fromEntries(
    entries.map(([k, s]) => [k, (s as SuccessState<unknown>).data]),
  );
  const stale = entries.some(
    ([_, s]) => (s as SuccessState<unknown>).stale,
  );
  return { status: "success", data, stale: stale || undefined } as any;
}

// FlatMap for chained async operations
export function flatMapAsyncState<T, U>(
  state: AsyncState<T>,
  fn: (data: T) => AsyncState<U>,
): AsyncState<U> {
  if (state.status === "success") {
    return fn(state.data);
  }
  return state;
}

// Extract data or return undefined (useful for optional chaining)
export function asyncData<T>(state: AsyncState<T>): T | undefined {
  return state.status === "success" ? state.data : undefined;
}
