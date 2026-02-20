import { createContext } from "svelte";
import { page } from "$app/state";
import {
  Handle,
  type StreamDid,
  Ulid,
  type UserDid,
  newUlid,
} from "@roomy/sdk";
import { LiveQuery } from "$lib/utils/liveQuery.svelte";
import { sql } from "$lib/utils/sqlTemplate";
import { peer, peerStatus, getPersonalSpaceId } from "$lib/workers";
import type { AuthStatus } from "$lib/workers/peer/types";
import type { SpaceIdOrHandle } from "$lib/workers/types";
import type { SpaceMeta, SidebarCategory } from "./types";
import { SvelteMap } from "svelte/reactivity";

// ─── Types ───────────────────────────────────────────────────────────────────

type SpaceStatus =
  | { status: "no-current-space" }
  | { status: "loading"; spaceId?: SpaceIdOrHandle }
  | { status: "invited"; spaceId: StreamDid }
  | { status: "joined"; space: SpaceMeta; isSpaceAdmin: boolean }
  | { status: "error"; message: string };

// ─── Sidebar query row types ─────────────────────────────────────────────────

type SidebarQueryRow = {
  id: string | null;
  name: string;
  children: { id: Ulid; name: string }[];
};

type ChannelQueryRow = { id: Ulid; name: string };

// ─── AppState ────────────────────────────────────────────────────────────────

export class AppState {
  // ═══════════ Spaces ═══════════
  spaces = $state<SpaceMeta[]>([]);
  spacesLoading = $state(true);

  // ═══════════ Current Navigation ═══════════
  space = $state<SpaceStatus>({ status: "loading" });
  roomId = $state<Ulid | undefined>(undefined);
  did = $state<UserDid | undefined>(undefined);
  joinedSpace = $state<SpaceMeta | undefined>(undefined);
  isSpaceAdmin = $state(false);

  // ═══════════ Sidebar ═══════════
  categories = $state<SidebarCategory[] | undefined>(undefined);

  // ═══════════ Private: Spaces ═══════════
  #spacesQuery: LiveQuery<SpaceMeta>;
  #handlesForSpace = new SvelteMap<StreamDid, Handle | undefined>();

  // ═══════════ Private: Current space resolution ═══════════
  #resolvedSpaceIds = new SvelteMap<
    string,
    { spaceId: StreamDid; handle?: Handle } | { error: string }
  >();
  #resolvedSpaceExists = new SvelteMap<StreamDid, boolean>();

  // Derived: resolves page.params.space → space info (fires async lookups)
  #currentSpace = $derived.by(() => {
    const spaceUrlSegment = page.params.space;
    if (!spaceUrlSegment) return undefined;

    // Resolve handle/DID → spaceId
    if (!this.#resolvedSpaceIds.has(spaceUrlSegment)) {
      peer
        .resolveSpaceId(spaceUrlSegment as SpaceIdOrHandle)
        .then((resp) => this.#resolvedSpaceIds.set(spaceUrlSegment, resp));
      return undefined;
    }
    const resp = this.#resolvedSpaceIds.get(spaceUrlSegment);
    if (!resp || !("spaceId" in resp)) return undefined;

    // Check space exists
    if (!this.#resolvedSpaceExists.has(resp.spaceId)) {
      peer
        .checkSpaceExists(resp.spaceId)
        .then((exists) => this.#resolvedSpaceExists.set(resp.spaceId, exists));
      return undefined;
    }
    const exists = this.#resolvedSpaceExists.get(resp.spaceId);
    if (!exists) {
      throw "This space doesn't exist or has been deleted.";
    }

    // Find matching space in joined list
    const matchingSpace = this.spaces.find((x) => x.id == resp.spaceId);
    if (!matchingSpace) {
      return { matchingSpace, spaceId: resp.spaceId, isSpaceAdmin: false };
    }

    const isSpaceAdmin =
      matchingSpace.permissions?.some(
        (permission) =>
          permission[0] ===
            (
              peerStatus.authState as Extract<
                AuthStatus,
                { state: "authenticated" }
              >
            ).did && permission[1] === "admin",
      ) || false;
    return { matchingSpace, spaceId: resp.spaceId, isSpaceAdmin };
  });

  // ═══════════ Private: Per-space sidebar cache ═══════════
  #sidebarQueries = new SvelteMap<StreamDid, LiveQuery<SidebarQueryRow>>();
  #allChannelsQueries = new SvelteMap<StreamDid, LiveQuery<ChannelQueryRow>>();

  constructor() {
    // ─── Spaces query ──────────────────────────────────────────────────────
    this.#spacesQuery = new LiveQuery(
      () => sql`-- spaces
        select json_object(
            'id', cs.entity,
            'name', ci.name,
            'avatar', ci.avatar,
            'description', ci.description,
            'permissions', (
              select json_group_array(
                json_array(cu.did, json_extract(e.payload, '$.can')))
              from edges e
              join comp_user cu on cu.did = e.tail
              where e.head = cs.entity and e.label = 'member'
          )) as json
        from comp_space cs
        join entities e on e.id = cs.entity
        left join comp_info ci on cs.entity = ci.entity
        where e.stream_id = ${getPersonalSpaceId()}
          and hidden = 0
      `,
      (row) => JSON.parse(row.json),
    );

    // ─── Handle resolution ─────────────────────────────────────────────────
    $effect(() => {
      if (
        peerStatus.authState?.state !== "authenticated" ||
        peerStatus.roomyState?.state !== "connected" ||
        this.#spacesQuery.result === undefined
      )
        return;

      Promise.all(
        this.#spacesQuery.result
          .filter((space) => !this.#handlesForSpace.has(space.id))
          .map(async (space) => {
            const handle = await peer.resolveHandleForSpace(space.id);
            return { id: space.id, handle };
          }),
      ).then((resolved) => {
        resolved
          .filter((s) => !!s.handle)
          .forEach((s) => this.#handlesForSpace.set(s.id, s.handle));
      });
    });

    // ─── Hydrate spaces list ───────────────────────────────────────────────
    $effect(() => {
      if (
        peerStatus.authState?.state !== "authenticated" ||
        peerStatus.roomyState?.state !== "connected" ||
        this.#spacesQuery.result === undefined
      )
        return;

      let list = this.#spacesQuery.result.map((spaceRow) => ({
        ...spaceRow,
        handle: this.#handlesForSpace.get(spaceRow.id),
        backfill_status: peerStatus.spaces?.[spaceRow.id] || "error",
      }));

      this.spaces = list;
      this.spacesLoading = false;
    });

    // ─── Current space (from page.params.space) ────────────────────────────
    $effect(() => {
      if (this.spacesLoading || !page.params.space) return;
      if (
        peerStatus.authState?.state !== "authenticated" ||
        peerStatus.roomyState?.state !== "connected" ||
        !this.#currentSpace
      )
        return;

      this.space = this.#currentSpace.matchingSpace
        ? {
            status: "joined",
            space: this.#currentSpace.matchingSpace,
            isSpaceAdmin: this.#currentSpace.isSpaceAdmin,
          }
        : {
            status: "invited",
            spaceId: this.#currentSpace.spaceId,
          };
      this.joinedSpace = this.#currentSpace.matchingSpace;
      this.isSpaceAdmin = this.#currentSpace.isSpaceAdmin;

      return () => {
        this.space = { status: "no-current-space" };
        this.joinedSpace = undefined;
        this.isSpaceAdmin = false;
      };
    });

    // ─── Current room (from page.params.object) ────────────────────────────
    $effect(() => {
      page.params.object;
      if (!page.params.object || !Ulid.allows(page.params.object)) return;
      this.roomId = Ulid.assert(page.params.object);

      return () => {
        this.roomId = undefined;
      };
    });

    // ─── Current DID ───────────────────────────────────────────────────────
    $effect(() => {
      this.did =
        peerStatus.authState?.state === "authenticated"
          ? peerStatus.authState.did
          : undefined;
    });

    // ─── Sidebar query creation ────────────────────────────────────────────
    // Ensure current space has a sidebar query immediately.
    $effect(() => {
      const spaceId = this.joinedSpace?.id;
      if (spaceId) this.#ensureSidebarQuery(spaceId);
    });

    // Prewarm sidebar queries for all other joined spaces once the current
    // space's sidebar is ready, so we don't compete with it on the worker.
    $effect(() => {
      const currentId = this.joinedSpace?.id;
      if (!currentId || !this.categories) return;
      for (const space of this.spaces) {
        if (space.id !== currentId) {
          this.#ensureSidebarQuery(space.id);
        }
      }
    });

    // ─── Sidebar processing ────────────────────────────────────────────────
    // Reads from the current space's cached query, processes into categories.
    // Instant on space switch if query already has results.
    $effect(() => {
      const spaceId = this.joinedSpace?.id;
      if (!spaceId) {
        this.categories = undefined;
        return;
      }

      const sidebarQuery = this.#sidebarQueries.get(spaceId);
      const channelsQuery = this.#allChannelsQueries.get(spaceId);
      if (
        !sidebarQuery ||
        sidebarQuery.current.status === "loading" ||
        !channelsQuery
      )
        return;

      if (!sidebarQuery.result) {
        this.categories = undefined;
        return;
      }

      // Use local variables to avoid read-write cycle on this.categories
      let allChannelIds = new Set(channelsQuery.result?.map((x) => x.id) || []);
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

      // Single write
      this.categories = cats;
    });
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /** Create sidebar + channels queries for a space. Uses $effect.root so queries
   *  persist across navigation — switching back to a visited space is instant. */
  #ensureSidebarQuery(spaceId: StreamDid) {
    if (this.#sidebarQueries.has(spaceId)) return;

    $effect.root(() => {
      this.#sidebarQueries.set(
        spaceId,
        new LiveQuery(
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
        ),
      );

      this.#allChannelsQueries.set(
        spaceId,
        new LiveQuery(
          () => sql`
            select id, name from entities e
            join comp_room r on e.id = r.entity
            join comp_info i on e.id = i.entity
            where
              label = 'space.roomy.channel'
                and
              e.stream_id = ${spaceId}
          `,
        ),
      );
    });
  }
}

export const [getAppState, setAppState] = createContext<AppState>();

export type { SpaceStatus };
