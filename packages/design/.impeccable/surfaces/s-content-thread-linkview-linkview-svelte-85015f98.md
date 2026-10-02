---
version: 1
slug: "s-content-thread-linkview-linkview-svelte-85015f98"
primary_target: "packages/design/src/components/content/thread/linkView/LinkView.svelte"
related_targets: []
---

# Links view — surface brief

**Scope:** The `Links` tab of a channel (`packages/app-lite/src/lib/components/thread/LinksView.svelte` → `@roomy/design/.../linkView/*`). One surface, room- and space-scoped (the same `LinkView` shell serves both; only the query differs).

**Mode:** Operate. The visitor is scanning what a community has shared and deciding whether to open a link.

## Direction contract

**THESIS.** The links index is a *shelf of things the community brought in*, not a log of messages that happened to contain URLs. It refuses the category default — a text-only list of blue links — and equally refuses the current implementation's second-hand borrow: a row-list cloned from the Threads tab, where a link is only ever a title and a greyed sub-line. A shared link is an *object with a face*: a preview image, a title, a source, and when it entered the room. The grid is the shelf; each card is a thing on it.

**OWN-WORLD.** Roomy's established world, inherited whole: warm stone neutrals (`base-*`), the single swappable `accent-*` for interaction only, `rounded-2xl` surfaces, the three-speed motion budget (800ms deliberate / 300ms hover / 100ms active), frosted-glass reserved for *interactive* elements only. No new tokens. The card is a **flat, warm surface with a hairline stone border** — passive content, so no backdrop-blur (DESIGN.md's Frosted-Not-Glass rule). Interaction lives in the border warming to accent and a 2px lift, per the Scale-Not-Lift rule's sibling for cards.

**STORY.** The visitor arrives at Links, understands in under two seconds that this is everything the room has shared, sees which item they want, and opens it. They also finally learn *when* things were shared — the index is newest-first and now says so out loud.

**FIRST VIEWPORT.** Full-bleed responsive grid inside the existing `ScrollArea`, `pb-4`, container-query driven: 1 column under 30rem, 2 by 34rem, 3 by 52rem, 4 by 74rem. Each card: a 16:9 media band on top (preview image, or a `<video>` poster for a video link, or an accent-tinted fallback glyph plate for links with no preview), then a text well — source line (provider/hostname, caption size, muted), title (2 lines, clamped, primary ink), description (2 lines, clamped, muted), then a footer rule with the relative timestamp on the left and the open-in-new glyph on the right, which is *always visible* (it is the card's affordance) and warms to accent on hover/focus. Loading more is a shimmering skeleton grid of six cards; empty is a drawn mark with a sentence that teaches what the tab is for.

**FORM.** Card grid. Position on the order: the incumbent row-list (evidence, anti-reference) → the category default text list (rut, refused) → **card grid** (chosen: the visuals the content already carries — `imgs`, `thumb`, `vid` — are wasted in a row) → masonry (rejected: ragged heights fight calm density, and the media is uniformly 16:9).

**SIGNATURE MOMENT.** The media band: a real preview image, and for video links a poster with a small play glyph — the one place the view proves a link is a *thing*, not a string. Cards with no preview must not look broken; they get a quiet plate with the link glyph on an accent wash, so an empty card reads as *intentional absence*, not a failed load.

## Constraints

- **No contract lies.** The only added wire field is `timestamp?: string` (ISO), for both `room.getLinks` and `space.getLinks`. It is sourced from the row's **canonical ordering key** (`coalesce(msg.sort_idx, msg.id)`), because `sort_idx` is the arrival-aware, bridge-override-correct timeline key the server already orders by — matching `threadActivity`'s ISO-string convention. It is *not* `comp_content.timestamp` (ULID-derived). Field is optional in the schema so older servers degrade to no date, never a broken card.
- `roomId`/`messageId` still not surfaced in the type (rows open the link, not the message). Unchanged.
- The `ScrollArea` + IntersectionObserver pagination contract and the `links`/`emptyMessage`/`loadMore`/`hasMore` props stay exactly as they are, so `LinksView.svelte` and the app route need only the timestamp addition.
- Both themes, reduced-motion safe, keyboard focus visible on every card.

## Unresolved

- Whether the space-scoped index should later show the *room* a link came from (the wire already carries `roomId`). Out of scope here.
