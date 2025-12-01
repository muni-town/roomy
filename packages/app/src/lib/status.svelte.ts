import { backendStatus } from "./workers";

let currentAuthenticated = $derived(
  backendStatus.authState?.state === "authenticated",
);

let currentDid = $derived(
  backendStatus.authState?.state === "authenticated"
    ? backendStatus.authState.did
    : undefined,
);

let currentPersonalStreamId = $derived(
  backendStatus.authState?.state === "authenticated"
    ? backendStatus.authState.personalStream
    : undefined,
);

export const authenticated = () => currentAuthenticated;
export const did = () => currentDid;
export const personalStreamId = () => currentPersonalStreamId;
