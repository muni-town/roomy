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
}

interface IdleState {
  status: "idle";
}

export type AsyncState<T> = LoadingState | ErrorState | SuccessState<T>;
export type AsyncStateWithIdle<T> =
  | LoadingState
  | ErrorState
  | SuccessState<T>
  | IdleState;
