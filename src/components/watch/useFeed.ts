"use client";

import { useEffect, useRef, useState } from "react";

import type { FeedSnapshot } from "@/lib/watch/types";

/** How often the browser asks for a new snapshot. */
const POLL_MS = 15_000;
/** Frames kept for the selection trail. At one a minute this is ~40 minutes. */
const MAX_FRAMES = 40;
/** Don't record two frames closer together than this. */
const FRAME_SPACING_MS = 55_000;

/**
 * A recorded past position set, stored as parallel typed arrays.
 *
 * A full snapshot is 10-15k track objects; keeping 40 of those would be tens of
 * megabytes for nothing. The trail behind a selection only needs where each
 * track was — in three dimensions, since it is drawn at altitude beside the
 * aircraft — so a frame holds ids (strings shared with the live snapshot, so
 * effectively free) plus three typed arrays.
 */
export type HistoryFrame = {
  ts: number;
  ids: string[];
  lon: Float32Array;
  lat: Float32Array;
  /** Feet. Zero for surface tracks and anything not reporting an altitude. */
  alt: Float32Array;
};

function toFrame(snapshot: FeedSnapshot): HistoryFrame {
  const n = snapshot.tracks.length;
  const frame: HistoryFrame = {
    ts: snapshot.ts,
    ids: new Array<string>(n),
    lon: new Float32Array(n),
    lat: new Float32Array(n),
    alt: new Float32Array(n),
  };
  for (let i = 0; i < n; i++) {
    const t = snapshot.tracks[i];
    frame.ids[i] = t.id;
    frame.lon[i] = t.lon;
    frame.lat[i] = t.lat;
    frame.alt[i] = t.kind === "air" && !t.onGround && t.alt != null ? t.alt : 0;
  }
  return frame;
}

export type FeedState = {
  snapshot: FeedSnapshot | null;
  /** Oldest first. Empty until the console has been open a minute. */
  history: HistoryFrame[];
  error: string | null;
};

export function useFeed(): FeedState {
  const [snapshot, setSnapshot] = useState<FeedSnapshot | null>(null);
  const [history, setHistory] = useState<HistoryFrame[]>([]);
  const [error, setError] = useState<string | null>(null);
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

  return { snapshot, history, error };
}
