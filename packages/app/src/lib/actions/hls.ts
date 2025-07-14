// hls.ts
import Hls from "hls.js";
import type { Fragment } from "hls.js";
import { writable, get } from "svelte/store";
import { BandwidthEstimate } from "../utils/bandwidthEstimate";

export class HLSUnsupportedError extends Error {
  constructor() {
    super("HLS is not supported in this browser");
    this.name = "HLSUnsupportedError";
  }
}

export class VideoNotFoundError extends Error {
  constructor() {
    super("Video playlist not found (404)");
    this.name = "VideoNotFoundError";
  }
}

export const hlsRef = writable<Hls | undefined>(undefined);
export const lowQualityFragments = writable<Fragment[]>([]);

interface Params {
  playlist: string;
  onHasSubtitleTrack?: (v: boolean) => void;
  onError?: (e: Error | null) => void;
  onLoading?: (v: boolean) => void;
}

export function hls(node: HTMLVideoElement, params?: Params) {
  if (!params) return;

  let hls: Hls;

  function flushOnLoop() {
    const frags = get(lowQualityFragments);
    if (hls.nextAutoLevel > 0 && frags.length === 1 && frags[0]?.start === 0) {
      const f = frags[0];
      hls.trigger(Hls.Events.BUFFER_FLUSHING, {
        startOffset: f.start,
        endOffset: f.end,
        type: "video",
      });
      lowQualityFragments.set([]);
    }
  }

  function setup() {
    if (!params) return;
    if (!Hls.isSupported()) {
      params.onError?.(new HLSUnsupportedError());
      return;
    }

    params.onLoading?.(true);

    hls = new Hls({
      maxMaxBufferLength: 10,
    });
    hlsRef.set(hls);

    const estimate = BandwidthEstimate.get();
    if (estimate !== undefined) hls.bandwidthEstimate = estimate;

    hls.attachMedia(node);
    hls.loadSource(params.playlist);

    const onEnded = () => {
      flushOnLoop();
      node.currentTime = 0;
      node.play();
    };
    node.addEventListener("ended", onEnded);

    hls.on(Hls.Events.FRAG_LOADED, () => {
      BandwidthEstimate.set(hls.bandwidthEstimate);
    });

    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (_e, data) => {
      if (!params) return;
      if (data.subtitleTracks.length > 0) {
        params.onHasSubtitleTrack?.(true);
      }
    });

    hls.on(Hls.Events.FRAG_BUFFERED, (_e, { frag }) => {
      if (frag.level === 0) {
        lowQualityFragments.update((p) => [...p, frag]);
      }
    });

    hls.on(Hls.Events.FRAG_CHANGED, (_e, { frag }) => {
      if (hls.nextAutoLevel > 0) {
        lowQualityFragments.update((prev) => {
          const flushed: Fragment[] = [];
          for (const low of prev) {
            if (Math.abs(frag.start - low.start) < 0.1) continue;
            hls.trigger(Hls.Events.BUFFER_FLUSHING, {
              startOffset: low.start,
              endOffset: low.end,
              type: "video",
            });
            flushed.push(low);
          }
          return prev.filter((f) => !flushed.includes(f));
        });
      }
    });

    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!params) return;
      if (data.fatal) {
        if (
          data.details === "manifestLoadError" &&
          data.response?.code === 404
        ) {
          params.onError?.(new VideoNotFoundError());
        } else {
          params.onError?.(data.error);
        }
      } else {
        console.error(data.error);
      }
    });

    params.onLoading?.(false);
  }

  setup();

  return {
    update(newParams: Params) {
      params = newParams;
      // TODO: could re-init if playlist changes
    },
    destroy() {
      hlsRef.set(undefined);
      node.removeEventListener("ended", flushOnLoop);
      hls?.destroy();
    },
  };
}
