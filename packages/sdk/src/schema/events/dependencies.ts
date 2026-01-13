import { Ulid } from "../primitives";
import type { EventType, Event } from "../envelope";

const dependencies: Map<EventType, { events?: (x: Event) => Ulid[] }> =
  new Map();

/** Register an event as requiring a certain field */
export function setDependsOn<T extends EventType>(
  t: T,
  deps: {
    events?: (x: Event<T>) => Ulid[];
  },
) {
  dependencies.set(
    t,
    deps as typeof dependencies extends Map<any, infer V> ? V : never,
  );
}

export function getDependsOn(ev: Event): Ulid[] {
  const config = dependencies.get(ev.$type);
  if (!config) return [];
  return config.events?.(ev) || [];
}
