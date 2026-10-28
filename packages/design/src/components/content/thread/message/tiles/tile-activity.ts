/**
 * What a tile reports about its own use, and the event name it reports under.
 *
 * `TileEmbed` knows two things worth counting — a tile was seen, a tile failed
 * — and nothing about telemetry. `@roomy/design` is a component library with
 * no application dependencies and does not acquire one here: the component
 * announces each of those as a bubbling `CustomEvent` on the DOM, and a host
 * that wants them listens. With no listener the event is inert, which is what
 * a standalone mount (Storybook) and any surface that has not opted in get.
 *
 * There is no "opened" phase: a tile's frame is mounted as soon as its
 * manifest is read, with no card and no click in between, so the moment a card
 * was expanded does not exist.
 *
 * `surface` travels with the announcement because only the render site knows
 * which one it is. The component cannot infer it from its own tree.
 *
 * The failure reason is classified here rather than by the listener: the text
 * of a failure exists only at the component that caught it.
 */

/** The DOM event name a tile announces each phase under. */
export const TILE_ACTIVITY_EVENT = "roomy:tile-activity";

/** Where a tile is being rendered, named by the surface that renders it. */
export type TileSurface = "chat" | "search" | "feed" | "page";

/** Why a tile could not be shown. */
export type TileErrorReason = "manifest" | "assets" | "frame" | "other";

/** One announcement. `uri` is the bare tile AT-URI, never sent onward as is. */
export type TileActivityDetail =
  | { phase: "view"; uri: string; surface: TileSurface }
  | {
      phase: "error";
      uri: string;
      surface: TileSurface;
      reason: TileErrorReason;
    };

/**
 * The reason a thrown tile error carries, read from its message.
 *
 * The loader reports failures as plain `Error`s with prose messages, so the
 * message is the only classification signal. A manifest that will not load is
 * the common case and the default for anything unrecognised that still names
 * the loader; an asset or frame failure is only reported when the text says
 * so. The `frame` arm exists for completeness — an iframe has no error
 * callback, so a failure inside the tile's own content never reaches this
 * component and is not reported at all rather than guessed at.
 */
export function classifyTileError(error: unknown): TileErrorReason {
  const text = error instanceof Error ? error.message : String(error);
  if (/iframe|frame/i.test(text)) return "frame";
  if (/blob|asset|resolvePath/i.test(text)) return "assets";
  if (/manifest|loader|PDS|record/i.test(text)) return "manifest";
  return "other";
}
