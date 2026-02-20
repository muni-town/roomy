import {
  type StreamDid,
  type UserDid,
  type Handle,
  Ulid,
  newUlid,
} from "@roomy/sdk";
import { LiveQuery } from "$lib/utils/liveQuery.svelte";
import { sql } from "$lib/utils/sqlTemplate";
import type { SpaceMeta, SidebarCategory } from "./types";

// ─── Query row types ──────────────────────────────────────────────────────────

type MetadataRow = {
  name: string | null;
  avatar: string | null;
  description: string | null;
};

type SidebarQueryRow = {
  id: string | null;
  name: string;
  children: { id: Ulid; name: string }[];
};

type ChannelQueryRow = { id: Ulid; name: string };

// ─── Logging ──────────────────────────────────────────────────────────────────

const LOG_PREFIX = "[SpaceState]";
function log(spaceId: string, ...args: unknown[]) {
  console.log(LOG_PREFIX, spaceId.slice(0, 12) + "…", ...args);
}

// ─── SpaceState ───────────────────────────────────────────────────────────────

export class SpaceState {
  // === Inputs (set by AppState) ===
  did = $state<UserDid | undefined>(undefined);
  backfillStatus = $state<"loading" | "idle" | "error">("loading");
  handle = $state<Handle | undefined>(undefined);
  permissions = $state<[string, "read" | "post" | "admin"][]>([]);

  // === Own queries ===
  #metadataQuery: LiveQuery<MetadataRow>;
  #sidebarQuery: LiveQuery<SidebarQueryRow>;
  #allChannelsQuery: LiveQuery<ChannelQueryRow>;

  // === Derived public state ===
  get name() {
    return this.#metadataQuery.result?.[0]?.name ?? undefined;
  }
  get avatar() {
    return this.#metadataQuery.result?.[0]?.avatar ?? undefined;
  }
  get description() {
    return this.#metadataQuery.result?.[0]?.description ?? undefined;
  }

  get isSpaceAdmin() {
    const did = this.did;
    if (!did) return false;
    return this.permissions.some((p) => p[0] === did && p[1] === "admin");
  }

  categories = $state<SidebarCategory[] | undefined>(undefined);

  /** Cleanup for the outer $effect.root that owns the LiveQuery effects.
   *  Set by AppState's #getOrCreateSpaceState. */
  _rootCleanup: (() => void) | undefined;

  #cleanup: () => void;

  constructor(public readonly spaceId: StreamDid) {
    // log(spaceId, "created");

    // Metadata query
    this.#metadataQuery = new LiveQuery(
      () => sql`-- space-metadata
        SELECT name, avatar, description FROM comp_info WHERE entity = ${spaceId}
      `,
    );

    // Sidebar query
    this.#sidebarQuery = new LiveQuery(
      () => sql`
        select json_object(
          'id', categories.value -> 'id',
          'name', categories.value -> 'name',
          'children', case when count(children.value) > 0
            then json_group_array(
              json_object(
                'name', child_info.name,
                'id', child_info.entity
              )
              ORDER BY children.key
            )
            else json('[]')
            end
        ) as json
        from
          comp_space space,
          json_each(space.sidebar_config -> 'categories') as categories
        left join json_each(categories.value -> 'children') as children
        left join comp_info child_info on child_info.entity = children.value
        left join comp_room child_room on child_room.entity = children.value
        where space.entity = ${spaceId}
          and (child_room.entity is null or child_room.deleted != 1)
        group by categories.key, categories.value -> 'name'
        order by categories.key
      `,
      (row) => JSON.parse(row.json),
    );

    // All channels query
    this.#allChannelsQuery = new LiveQuery(
      () => sql`
        select id, name from entities e
        join comp_room r on e.id = r.entity
        join comp_info i on e.id = i.entity
        where
          label = 'space.roomy.channel'
            and
          e.stream_id = ${spaceId}
      `,
    );

    // Processing effects in $effect.root so they survive independent of caller
    this.#cleanup = $effect.root(() => {
      // Log query status transitions
      // $effect(() => {
      //   const metaStatus = this.#metadataQuery.current.status;
      //   const metaResult = this.#metadataQuery.result;
      //   log(spaceId, "metadata query:", metaStatus,
      //     metaStatus === "success" ? { rows: metaResult?.length, name: metaResult?.[0]?.name } : "");
      // });
      // $effect(() => {
      //   const sidebarStatus = this.#sidebarQuery.current.status;
      //   const sidebarResult = this.#sidebarQuery.result;
      //   log(spaceId, "sidebar query:", sidebarStatus,
      //     sidebarStatus === "success" ? { rows: sidebarResult?.length } : "",
      //     sidebarStatus === "error" ? this.#sidebarQuery.error : "");
      // });
      // $effect(() => {
      //   const channelsStatus = this.#allChannelsQuery.current.status;
      //   const channelsResult = this.#allChannelsQuery.result;
      //   log(spaceId, "channels query:", channelsStatus,
      //     channelsStatus === "success" ? { rows: channelsResult?.length } : "",
      //     channelsStatus === "error" ? this.#allChannelsQuery.error : "");
      // });

      // Log input changes
      // $effect(() => {
      //   log(spaceId, "inputs updated:", {
      //     did: this.did?.slice(0, 20),
      //     backfillStatus: this.backfillStatus,
      //     handle: this.handle?.toString(),
      //     permissionsCount: this.permissions.length,
      //   });
      // });

      $effect(() => {
        const sidebarQuery = this.#sidebarQuery;
        const channelsQuery = this.#allChannelsQuery;
        if (sidebarQuery.current.status === "loading" || !channelsQuery) {
          // log(
          //   spaceId,
          //   "sidebar processing: waiting (sidebar:",
          //   sidebarQuery.current.status,
          //   ")",
          // );
          return;
        }

        if (!sidebarQuery.result) {
          // log(spaceId, "sidebar processing: no result, clearing categories");
          this.categories = undefined;
          return;
        }

        let allChannelIds = new Set(
          channelsQuery.result?.map((x) => x.id) || [],
        );
        let pinnedChannelIds = new Set<string>();

        let cats = sidebarQuery.result.map((x) => {
          const seen = new Set<string>();
          const uniqueChildren = x.children.filter((c) => {
            pinnedChannelIds.add(c.id);
            if (seen.has(c.id)) return false;
            seen.add(c.id);
            return true;
          });

          return {
            type: "space.roomy.category",
            id: (x.id as Ulid) ?? newUlid(),
            name: x.name,
            lastRead: 0,
            latestEntity: 0,
            sortIdx: "",
            unreadCount: 0,
            children: uniqueChildren.map((c) => ({
              type: "space.roomy.channel",
              id: c.id,
              name: c.name,
              lastRead: 0,
              latestEntity: 0,
              sortIdx: "",
              unreadCount: 0,
            })),
          } satisfies SidebarCategory;
        });

        let orphanChannels = allChannelIds.difference(pinnedChannelIds);

        if (!cats.length) {
          cats = [
            {
              id: newUlid(),
              type: "space.roomy.category",
              name: "general",
              lastRead: 0,
              latestEntity: 0,
              sortIdx: "",
              unreadCount: 0,
              children: [],
            },
          ];
        }

        const orphans = [...orphanChannels]
          .map((id) => channelsQuery.result?.find((x) => x.id == id))
          .filter((x) => !!x)
          .map(({ id, name }) => ({
            id,
            name,
            type: "space.roomy.channel" as const,
            lastRead: 0,
            latestEntity: 0,
            sortIdx: "",
            unreadCount: 0,
          }));

        if (orphans.length > 0) {
          cats = cats.map((category, i) => ({
            ...category,
            children:
              i == 0 ? [...category.children, ...orphans] : category.children,
          }));
        }

        // log(spaceId, "sidebar processing: done", {
        //   categories: cats.length,
        //   totalChannels: cats.reduce((n, c) => n + c.children.length, 0),
        //   orphans: orphans.length,
        // });
        this.categories = cats;
      });
    });
  }

  get meta(): SpaceMeta {
    return {
      id: this.spaceId,
      name: this.name,
      avatar: this.avatar,
      handle: this.handle,
      description: this.description,
      backfill_status: this.backfillStatus,
      permissions: this.permissions,
    };
  }

  destroy() {
    log(this.spaceId, "destroyed");
    this.#cleanup();
    this._rootCleanup?.();
  }
}
