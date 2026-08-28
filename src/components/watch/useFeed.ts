"use client";

import { useEffect, useRef, useState } from "react";

import type { Alert, FeedSnapshot } from "@/lib/watch/types";

/** How often the browser asks for a new snapshot. */
const POLL_MS = 15_000;
/** Frames kept for the replay scrubber. At one a minute this is ~40 minutes. */
const MAX_FRAMES = 40;
/** Don't record two frames closer together than this. */
const FRAME_SPACING_MS = 55_000;

/**
 * A recorded past position set, stored as parallel typed arrays.
 *
 * A full snapshot is 10-15k track objects; keeping 40 of those would be tens of
 * megabytes for nothing. Replay only needs where each track was, so a frame
 * holds ids (strings shared with the live snapshot, so effectively free) plus
 * three typed arrays.
 */
export type HistoryFrame = {
  ts: number;
  ids: string[];
  /** 0 = air, 1 = sea. */
  kind: Uint8Array;
  lon: Float32Array;
  lat: Float32Array;
  alerts: Alert[];
};

function toFrame(snapshot: FeedSnapshot): HistoryFrame {
  const n = snapshot.tracks.length;
  const frame: HistoryFrame = {
    ts: snapshot.ts,
    ids: new Array<string>(n),
    kind: new Uint8Array(n),
    lon: new Float32Array(n),
    lat: new Float32Array(n),
    alerts: snapshot.alerts,
  };
  for (let i = 0; i < n; i++) {
    const t = snapshot.tracks[i];
    frame.ids[i] = t.id;
    frame.kind[i] = t.kind === "sea" ? 1 : 0;
    frame.lon[i] = t.lon;
    frame.lat[i] = t.lat;
  }
  return frame;
}

export type FeedState = {
  snapshot: FeedSnapshot | null;
  /** Oldest first. Empty until the console has been open a minute. */
  history: HistoryFrame[];
  /** Wall-clock ms at which the console started recording. */
  since: number;
  error: string | null;
};

export function useFeed(): FeedState {
  const [snapshot, setSnapshot] = useState<FeedSnapshot | null>(null);
  const [history, setHistory] = useState<HistoryFrame[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Lazy initialiser rather than a ref: this is a render-visible value, and
  // it must be computed exactly once per mount.
  const [since] = useState(() => Date.now());
  const lastFrameAt = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;

    const tick = async () => {
      try {
        const res = await fetch("/api/watch/feed", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`feed ${res.status}`);
        const next = (await res.json()) as FeedSnapshot;
        if (stopped) return;

        setSnapshot(next);
        setError(null);

        if (next.ts - lastFrameAt.current >= FRAME_SPACING_MS) {
          lastFrameAt.current = next.ts;
          setHistory((prev) => [...prev, toFrame(next)].slice(-MAX_FRAMES));
        }
      } catch (e) {
        if (controller.signal.aborted || stopped) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!stopped) timer = setTimeout(tick, POLL_MS);
      }
    };

    void tick();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, []);

  return { snapshot, history, since, error };
}
