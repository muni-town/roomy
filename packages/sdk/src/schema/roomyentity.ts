import { co, z } from "jazz-tools";

export const RoomyEntity = co.map({
  name: z.string().optional(),
  description: z.string().optional(),

  components: co.record(z.string(), z.string()),

  softDeleted: z.boolean().optional(),

  version: z.number().optional(),

  imageUrl: z.string().optional(),
});

export type LoadType<Loaded> = {
  load: (id: string, opts?: any) => Promise<Loaded>;
};
export type CreateType<Init, Opts, Loaded> = {
  create(init: Init, opts?: Opts): Loaded;
};
export type ComponentDef<T> = T & { id: string };
export type ComponentLoaded<Def> =
  Def extends ComponentDef<LoadType<infer Loaded>>
    ? Loaded
    : Def extends ComponentDef<CreateType<any, any, infer Loaded>>
      ? Loaded
      : never;
export type ComponentInit<Def> =
  Def extends ComponentDef<CreateType<infer Init, any, any>> ? Init : never;
export type ComponentInitOpts<Def> =
  Def extends ComponentDef<CreateType<any, infer Opts, any>> ? Opts : never;

export function defComponent<T extends LoadType<any>>(
  id: string,
  schema: T,
): ComponentDef<T> {
  return Object.assign(schema, { id });
}

export async function getComponent<D extends ComponentDef<LoadType<any>>>(
  entity: co.loaded<typeof RoomyEntity>,
  def: D,
  opts?: Parameters<D["load"]>[1],
): Promise<ComponentLoaded<D> | undefined> {
  const id = entity.components?.[def.id];
  if (!id) return;
  return await def.load(id, opts);
}

export function addComponent<D extends ComponentDef<CreateType<any, any, any>>>(
  entity: co.loaded<typeof RoomyEntity>,
  def: D,
  init: ComponentInit<D>,
  opts?: ComponentInitOpts<D>,
): Promise<
  D extends ComponentDef<CreateType<any, any, infer Loaded>> ? Loaded : never
> {
  const comp = def.create(init, opts);
  if (!entity.components) {
    entity.components = co.record(z.string(), z.string()).create({});
  }
  entity.components[def.id] = comp.id;
  return comp;
}
