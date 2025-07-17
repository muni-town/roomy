import { co, type CoMapSchema, z, InstanceOfSchema } from "jazz-tools";

/** Base type that must be implemented by all components. */
export type ComponentBase = {
  /** Load the component CoValue using it's ID. */
  load(id: string, opts?: any): any;
  /** Create an instance of the component. */
  create(init: any, opts?: any): any;
};

/** A component, with a unique component ID and it's base type. */
export type Component<Id extends string, S extends ComponentBase> = S & {
  componentId: Id;
};

/** The initialization type of a component. */
export type ComponentCreateInit<C extends Component<any, any>> =
  C extends Component<any, infer S> ? Parameters<S["create"]>[0] : never;

/** The options to the component's creation function. */
export type ComponentCreateOpts<C extends Component<any, any>> =
  C extends Component<any, infer S> ? Parameters<S["create"]>[1] : never;

/** The return value of a component's create function.  */
export type ComponentCreateReturn<C extends Component<any, any>> =
  C extends Component<any, infer S> ? ReturnType<S["create"]> : never;

/** The load function of a component. */
export type ComponentLoader<C extends Component<any, any>> =
  C extends Component<any, infer S> ? S["load"] : never;

/** The options to the component's load function. */
export type ComponentLoadOpts<C extends Component<any, any>> = Parameters<
  ComponentLoader<C>
>[1];

/** The return type of the component's load function. */
export type ComponentLoadReturn<C extends Component<any, any>> = ReturnType<
  ComponentLoader<C>
>;

/**
 * Define a component type. You must provide a unique component ID as well as it's Jazz schema type.
 * */
export function defComponent<Id extends string, S extends ComponentBase>(
  componentId: Id,
  schema: S,
): Component<Id, S> {
  return Object.assign(schema, {
    componentId,
  });
}

/** The shape of the Jazz schema for an Entity */
const entityMapShape = {
  name: z.string().optional(),
  description: z.string().optional(),

  components: co.record(z.string(), z.string()),

  softDeleted: z.boolean().optional(),

  creatorId: z.string().optional(),

  version: z.number().optional(),
};
/** Initialization argument type for entities. */
type EntityCreateInit = Parameters<
  ReturnType<typeof co.map<typeof entityMapShape>>["create"]
>[0];
type EntityCreateOpts = Parameters<
  ReturnType<typeof co.map<typeof entityMapShape>>["create"]
>[1];

/** The Jazz schema for entities. */
type EntityBase = CoMapSchema<typeof entityMapShape>;
/** The type of the Jazz default load() function for the entity schema. */
type NormalLoad = EntityBase["load"];

/** The overrides for the load and create functions on the entity schema.  */
type EntityOverrides<
  Components extends { [key: string]: Component<any, any> },
> = {
  load: LoadWithHelpers<HelpersForComponents<Components>>;
  create: CreateForComponents<Components>;
};

/** The complete type of our entity schema. */
type EntitySchema<Components extends { [key: string]: Component<any, any> }> =
  Omit<Omit<EntityBase, "load">, "create"> & EntityOverrides<Components>;

/** The type of our extended load function for entities.  */
type LoadWithHelpers<Helpers> = (
  ...loadParams: Parameters<NormalLoad>
) => Promise<(InstanceOfSchema<EntityBase> & Helpers) | undefined>;

/** The type of the create function, including the type for the provided components. */
type CreateForComponents<C extends { [key: string]: Component<any, any> }> = (
  init: Omit<EntityCreateInit, "components"> &
    (keyof C extends never
      ? {}
      : {
          components: {
            [K in keyof C]:
              | string
              | {
                  init: ComponentCreateInit<C[K]>;
                  opts?: ComponentCreateOpts<C[K]>;
                };
          };
        }),
  opts?: EntityCreateOpts,
) => InstanceOfSchema<EntitySchema<C>> & HelpersForComponents<C>;

/** The loaded type of a component schema. */
export type LoadedComponent<C extends Component<any, any>> = NonNullable<
  Awaited<LoadComponentReturn<C>>
>;
/** The loaded type of an entity. */
export type LoadedEntity<E extends EntitySchema<any>> = NonNullable<
  Awaited<ReturnType<E["load"]>>
>;

/** The return value of loadComponent(). */
type LoadComponentReturn<C extends Component<any, any>> = Promise<
  NonNullable<Awaited<ReturnType<ComponentLoader<C>>>> | undefined
>;

/** The helper extension for loading components. */
type LoadComponentHelper = {
  loadComponent: <
    Id extends string,
    Base extends ComponentBase,
    C extends Component<Id, Base>,
  >(
    component: C,
    opts?: Parameters<ComponentLoader<C>>[1],
  ) => LoadComponentReturn<C>;
};
/** The helper extension for adding components. */
type AddComponentHelper = {
  addComponent: <
    Id extends string,
    Base extends ComponentBase,
    C extends Component<Id, Base>,
  >(
    component: C,
    init: ComponentCreateInit<C>,
    opts?: ComponentCreateOpts<C>,
  ) => ComponentCreateReturn<C>;
};

type HelpersForSpecificComponents<
  C extends { [key: string]: Component<any, any> },
> = {
  // Add a helper function for loading each of the components expected to be
  // on the entity.
  [K in keyof C]: (
    opts?: Parameters<ComponentLoader<C[K]>>,
  ) => Promise<NonNullable<Awaited<LoadComponentReturn<C[K]>>>>;
};

/** The extra helpers added to an entity instance for the given list of components. */
type HelpersForComponents<C extends { [key: string]: Component<any, any> }> =
  // Add the universal helpers for adding and loading components
  LoadComponentHelper & AddComponentHelper & HelpersForSpecificComponents<C>;

function createEntityHelperProxy<
  Components extends { [key: string]: Component<any, any> },
>(ent: co.loaded<CoMapSchema<typeof entityMapShape>>, components: Components) {
  const helpers: LoadComponentHelper & AddComponentHelper = {
    loadComponent(component, opts) {
      const componentInstanceId = ent.components?.[component.componentId];
      if (!componentInstanceId) return;
      return component.load(componentInstanceId, opts);
    },
    addComponent(component, init, opts) {
      const data = component.create(init, opts);
      if (ent.components) {
        ent.components[component.componentId] = data;
      } else {
        const components = co.record(z.string(), z.string()).create({});
        components[component.componentId] = data;
        ent.components = components;
      }
      return data;
    },
  };

  const specificComponentHelpers = Object.fromEntries(
    Object.entries(components || {}).map(
      ([key, component]: [string, Component<any, any>]) => {
        return [
          key,
          (opts) => {
            const componentInstanceId = ent.components?.[component.componentId];
            if (!componentInstanceId)
              throw (
                "Entity missing expected component: " + component.componentId
              );
            return component.load(componentInstanceId, opts);
          },
        ];
      },
    ),
  ) as HelpersForSpecificComponents<Components>;

  return createHelperProxy(ent, { ...helpers, ...specificComponentHelpers });
}

export const helperProxyTarget = Symbol("helperProxyTarget");
function createHelperProxy(object: any, helpers: { [key: string]: any }): any {
  return new Proxy(object, {
    get(target, key, receiver) {
      if (key in helpers) {
        return helpers[key as any];
      }
      return Reflect.get(target, key, receiver);
    },
  });
}

/** Create a new entity schema that contains the given list of components. */
export function bundle<
  Components extends { [key: string]: Component<any, any> },
>(components: Components): EntitySchema<Components> {
  const schema = co.map(entityMapShape);

  const overrides: EntityOverrides<Components> = {
    load: async (id, opts) => {
      const ent = await schema.load(id, opts);
      if (!ent) return;

      createEntityHelperProxy(ent, components);

      return ent as any;
    },
    create(init, opts) {
      const componentsInit = (init as any).components as {
        [key: string]: string | { init: any; opts?: any };
      };
      const componentsInitMap = co.record(z.string(), z.string()).create({});

      for (const [key, value] of Object.entries(componentsInit || {})) {
        if (typeof value == "string") {
          componentsInitMap[key] = value;
        } else {
          const componentSchema: undefined | Component<any, any> =
            components[key];
          if (!componentSchema) throw "Type error: missing component: " + key;
          const data = componentSchema.create(value.init, value.opts);
          componentsInit[key] = data.id;
        }
      }

      const newInit: Parameters<(typeof schema)["create"]>[0] = {
        ...init,
        components: componentsInitMap,
      };
      const ent = schema.create(newInit, opts);

      const proxy = createEntityHelperProxy(ent, components);

      return proxy as any;
    },
  };

  return createHelperProxy(schema, overrides);
}

/** The blank entity type. */
export const Entity = bundle({});

// export const SpaceEntity = bundle({ meta: SpaceMeta, folder: Folder });

// const se = SpaceEntity.create({
//   name: "testing",
//   components: {
//     folder: {
//       init: {
//         children: CoList.create<CoList<string>>([]),
//       },
//     },
//     meta: {
//       init: {
//         adminGroupId: "",
//         bans: co.list(z.string()).create([]),
//         folders: CoList.create<CoList<any>>([]),
//         members: CoList.create<CoList<any>>([]),
//         threads: CoFeed.create<CoFeed<any>>([]),
//         pages: CoList.create<CoList<any>>([]),
//       },
//       opts: { owner: Group.create() },
//     },
//   },
// });

// const timeline = se.addComponent(Timeline, []);

// const EntityFeedSchema = co.feed(Entity);

// const HelloSchema = co.map({ hello: z.string() });
// const HelloFeedSchema = co.feed(HelloSchema);

// type Test = InstanceOfSchema<typeof HelloSchema>;
// type Test2 = InstanceOfSchema<typeof Entity>;

// const hello = HelloSchema.create({ hello: "world" });
// const helloFeed = HelloFeedSchema.create([]);
// helloFeed.push(hello);

// const entity = Entity.create({ name: "ent" });
// const entityFeed = EntityFeedSchema.create([]);
// entityFeed.push(entity);

// timeline.push(se);

// const TestFolder = co.map({
//   children: co.list(z.string()),
// });

// const spaceEnt = (await SpaceEntity.load("hi"))!;
// const folder = (await spaceEnt.folder())!;

// console.log(folder?.children?.toJSON());

// const test = bundle({ space: SpaceMeta, message: MessageMeta });

// // const a = await test.space();
