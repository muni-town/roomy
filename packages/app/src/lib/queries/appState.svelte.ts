import { createContext } from "svelte";
import { page } from "$app/state";
import { Handle, type StreamDid, Ulid, type UserDid } from "@roomy/sdk";
import { LiveQuery } from "$lib/utils/liveQuery.svelte";
import { sql } from "$lib/utils/sqlTemplate";
import { peer, peerStatus, getPersonalSpaceId } from "$lib/workers";
import type { SpaceIdOrHandle } from "$lib/workers/types";
import type { SpaceMeta, SidebarCategory } from "./types";
import { SvelteMap } from "svelte/reactivity";
import { SpaceState } from "./spaceState.svelte";

// ─── Types ───────────────────────────────────────────────────────────────────

type SpaceStatus =
  | { status: "no-current-space" }
  | { status: "loading"; spaceId?: SpaceIdOrHandle }
  | { status: "invited"; spaceId: StreamDid }
  | { status: "joined"; space: SpaceMeta; isSpaceAdmin: boolean }
  | { status: "error"; message: string };

const APP_LOG = "[AppState]";

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

    // Fast path: if the URL segment matches a joined space by ID or handle,
    // resolve synchronously without async lookups.
    const directMatch = this.spaces.find(
      (s) => s.id === spaceUrlSegment || s.handle === spaceUrlSegment,
    );
    if (directMatch) {
      console.log(APP_LOG, "#currentSpace fast-path:", {
        urlSegment: spaceUrlSegment,
        spaceId: directMatch.id.slice(0, 12) + "…",
        matchedBy: directMatch.id === spaceUrlSegment ? "id" : "handle",
        hasName: !!directMatch.name,
        backfill: directMatch.backfill_status,
      });
      return { matchingSpace: directMatch, spaceId: directMatch.id };
    }

    // Slow path: async resolution for spaces we haven't joined
    console.log(APP_LOG, "#currentSpace slow-path:", {
      urlSegment: spaceUrlSegment,
      hasResolved: this.#resolvedSpaceIds.has(spaceUrlSegment),
    });
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
    console.log(APP_LOG, "#currentSpace slow-path resolved:", {
      spaceId: resp.spaceId.slice(0, 12) + "…",
      isJoined: !!matchingSpace,
      matchingSpaceName: matchingSpace?.name,
      spacesCount: this.spaces.length,
    });
    return { matchingSpace, spaceId: resp.spaceId };
  });

  // ═══════════ Private: Per-space state (plain Map — no reactive cross-talk) ═══════════
  #spaceStates = new Map<StreamDid, SpaceState>();

  // ═══════════ Current SpaceState ═══════════
  #currentSpaceState = $state<SpaceState | undefined>(undefined);

  get currentSpaceState(): SpaceState | undefined {
    return this.#currentSpaceState;
  }

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
      
      const nextSpaceId = this.#currentSpace.spaceId

      const spaceState = this.#getOrCreateSpaceState(
        nextSpaceId,
      );

      console.log("spaceState", {
        spaceState,
        nextSpaceId,
        spaces: $state.snapshot(this.spaces),
      });

      if (this.#currentSpace.matchingSpace) {
        // Push external reactive values into SpaceState
        spaceState.did = this.did;
        spaceState.backfillStatus =
          this.#currentSpace.matchingSpace.backfill_status;
        spaceState.handle = this.#currentSpace.matchingSpace.handle;
        spaceState.permissions = this.#currentSpace.matchingSpace.permissions;

        this.#currentSpaceState = spaceState;
        const meta = spaceState.meta;
        console.log(APP_LOG, "current space → joined:", {
          spaceId: this.#currentSpace.spaceId.slice(0, 12) + "…",
          handle: this.#currentSpace.matchingSpace.handle?.toString(),
          backfill: this.#currentSpace.matchingSpace.backfill_status,
          metaName: meta.name,
          hasCategories: !!spaceState.categories,
          categoriesCount: spaceState.categories?.length,
        });
        this.space = {
          status: "joined",
          space: meta,
          isSpaceAdmin: spaceState.isSpaceAdmin,
        };
      } else {
        console.log(APP_LOG, "current space → invited:", {
          spaceId: this.#currentSpace.spaceId.slice(0, 12) + "…",
        });
        this.#currentSpaceState = undefined;
        this.space = {
          status: "invited",
          spaceId: this.#currentSpace.spaceId,
        };
      }

      return () => {
        this.space = { status: "no-current-space" };
        this.#currentSpaceState = undefined;
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

    // ─── Sync public state from current SpaceState ─────────────────────────
    // These keep the $state fields reactive for consumers that read
    // app.joinedSpace, app.categories, app.isSpaceAdmin.
    $effect(() => {
      this.joinedSpace = this.#currentSpaceState?.meta;
    });
    $effect(() => {
      this.categories = this.#currentSpaceState?.categories;
    });
    $effect(() => {
      this.isSpaceAdmin = this.#currentSpaceState?.isSpaceAdmin ?? false;
    });

    // ─── Prewarm SpaceStates for all joined spaces ─────────────────────────
    // $effect(() => {
    //   for (const space of this.spaces) {
    //     const ss = this.#getOrCreateSpaceState(space.id as StreamDid);
    //     ss.did = this.did;
    //     ss.backfillStatus = space.backfill_status;
    //     ss.handle = space.handle;
    //     ss.permissions = space.permissions;
    //   }
    // });

    // ─── Cleanup stale SpaceStates ─────────────────────────────────────────
    $effect(() => {
      const currentIds = new Set(this.spaces.map((s) => s.id));
      for (const [id, ss] of this.#spaceStates) {
        if (!currentIds.has(id)) {
          ss.destroy();
          this.#spaceStates.delete(id);
        }
      }
    });
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  #getOrCreateSpaceState(spaceId: StreamDid): SpaceState {
    let ss = this.#spaceStates.get(spaceId);
    if (!ss) {
      // Wrap in $effect.root so the SpaceState's LiveQuery effects aren't
      // owned by whichever $effect triggered creation. Without this, the
      // calling effect re-running tears down the LiveQuery subscriptions
      // while the cached SpaceState lives on with dead queries.
      console.log("creating new space state with", spaceId);
      const rootCleanup = $effect.root(() => {
        ss = new SpaceState(spaceId);
      });
      ss!._rootCleanup = rootCleanup;
      this.#spaceStates.set(spaceId, ss!);
    }
    return ss!;
  }
}

export const [getAppState, setAppState] = createContext<AppState>();

export type { SpaceStatus };
