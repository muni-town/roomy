import { Ulid } from "../primitives";
import type { EventType, EventVariant, Event } from "../envelope";

const dependencies: Map<
  string,
  { events?: (t: any) => Ulid[]; dependsOnAfter?: boolean }
> = new Map();

export function setDependsOn<T extends EventType>(
  t: T,
  deps: {
    events?: (x: EventVariant<T>) => Ulid[];
    dependsOnAfter?: boolean;
  },
) {
  dependencies.set(t, deps);
}

export function getDependsOn(ev: Event): Ulid[] {
  const config = dependencies.get(ev.variant.$type);
  if (!config) return [];
  const events = config.events?.(ev.variant) || [];
  return [...events, ...(config?.dependsOnAfter && ev.after ? [ev.after] : [])];
}
